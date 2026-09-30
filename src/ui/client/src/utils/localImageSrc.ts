// Copyright 2026 xz333221
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// 正文内嵌图片：把模型写在 Markdown 里的**本机图片路径**重写成后端图片端点。
//
// ── 为什么需要这一层 ──────────────────────────────────────────────────────
//
// 执行器（claude / opencode / codex）在本机干活，"展示一张图"对它来说最自然的写法
// 就是把刚截的图 / 刚读的 png 的路径贴进正文。而对话流是 markdown 渲染：
// `<img src="c:\ws\repo\docs\a.png">` 在浏览器里**永远是裂图** —— 那个地址不在页面
// 够得到的范围内。用户实测（2026-09-30）：让 Agent"展示一张图片"，它把截图 Read 进
// 上下文、描述得挺准，屏幕上却只有一行字。
//
// 服务端为此开了 `GET /api/workbench/jobs/:id/image?path=…`（权限 = 该 job 所属
// 仓库内的图片文件，判定见 workbench/jobImage.js）。这里负责把路径翻译成那个 URL。
//
// 两个视图（WorkbenchView 的任务对话流、JobLogDetails 执行日志详情）共用这一份 ——
// 与 jobToolCalls.ts / jobUserPrompt.ts 同一个理由：同一份映射写两遍，迟早变成
// "一处能看图、另一处还是裂图"。
//
// ── 边界（都是有意的）────────────────────────────────────────────────────
//
//   · **只认 markdown 图片语法**。裸路径不转 —— 让 Agent 主动声明"这里要放图"，
//     比我们猜哪一行是图更可控；提示词里已经把写法告诉它了（workbench/envContext.js）。
//   · **代码围栏里的不转**。模型常用围栏贴"路径长这样"的示例 / 日志，把示例里的
//     `![](c:\a.png)` 改写成 API URL，会让它自己的说明文字对不上。
//   · http(s) / data: / blob: / 站内绝对路径（`/assets/…`）一个都不动 —— 那些本来
//     就够得到，改了就坏。

/** 与服务端 attachmentUtils.IMAGE_EXTS 保持一致：这里放行的后缀，服务端才会认 */
export const LOCAL_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];

/**
 * markdown 图片语法。三种写法都要认（否则同一条路径有时能渲染、有时不能）：
 *   `![alt](path)`、`![alt](<path with space>)`、`![alt](path "title")`
 * 分组：1=alt，2=尖括号包裹的地址，3=裸地址，4=可选的 title（连同前导空格，原样保留）。
 */
const MD_IMAGE_RE = /!\[([^\]]*)\]\(\s*(?:<([^<>\n]+)>|([^()\s]+))(\s+["'][^"']*["'])?\s*\)/g;

/** 围栏起始/结束行（``` 或 ~~~，允许缩进） */
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

const EXT_RE = /\.([a-z0-9]+)$/;

function hasLocalImageExt(src: string): boolean {
  const m = src.trim().toLowerCase().match(EXT_RE);
  return !!m && LOCAL_IMAGE_EXTS.includes(m[1]);
}

/**
 * 这个地址是不是"本机路径"（需要走服务端中转）。
 *
 * 判据顺序即优先级：带协议的（除 file:）先出局，再排除协议相对与站内绝对路径，
 * 最后要求后缀在白名单里 —— 白名单这一步同时挡住了把 `/api/foo/bar` 这类没后缀的
 * 站内地址误判成本机路径。
 */
export function isLocalImageSrc(src: string): boolean {
  const s = String(src || '').trim();
  if (!s) return false;
  // 盘符要先判：`c:\ws\a.png` 在下面的"协议"正则眼里长得就像 `c:` 协议，
  // 不先认出来会被当成 http 那种外部地址而放过去（探针实测踩过）。
  if (/^[a-zA-Z]:[\\/]/.test(s)) return hasLocalImageExt(s);
  // http:// / https:// / data: / blob: 一律不动；file: 是本机路径的另一种写法，放行。
  // 注意协议名**至少两个字符**（RFC 3986）—— 单个字母的一律不是协议，是盘符。
  const scheme = s.match(/^([a-z][a-z0-9+.-]+):/i);
  if (scheme && scheme[1].toLowerCase() !== 'file') return false;
  // 协议相对（//host/a.png）与站内绝对路径（/assets/a.png）：都是浏览器够得到的地址
  if (s.startsWith('//') || s.startsWith('/')) return false;
  return hasLocalImageExt(s);
}

/**
 * 拼出正文图片端点。路径整段 encodeURIComponent 之后塞进查询串 ——
 * 顺带解决了 Windows 路径里的反斜杠、以及路径带空格时的转义问题。
 */
export function jobImageUrl(jobId: string, path: string): string {
  return `/api/workbench/jobs/${encodeURIComponent(jobId)}/image?path=${encodeURIComponent(path)}`;
}

/** 单行内的重写（围栏外的行才会走到这里） */
function rewriteLine(line: string, jobId: string): string {
  if (!line.includes('![')) return line; // 快路径：绝大多数行没有图片语法
  return line.replace(MD_IMAGE_RE, (whole, alt: string, angled?: string, bare?: string, title?: string) => {
    const src = (angled ?? bare ?? '').trim();
    if (!isLocalImageSrc(src)) return whole;
    // title（`![a](x.png "说明")`）原样留着：它跟图片本身一样是模型写的内容
    return `![${alt}](${jobImageUrl(jobId, src)}${title || ''})`;
  });
}

/**
 * 把正文里指向本机图片的 markdown 图片改写成后端端点 URL。
 *
 * 逐行处理（顺带跳过代码围栏）：流式输出时正文每天都在变，这个函数会被高频调用，
 * 先按行切一次再对含 `![` 的行做正则，代价可以忽略。
 *
 * @param text  正文（Markdown 原文）
 * @param jobId 所属执行记录 id；缺了就不改 —— 拼不出端点的图只会变成 404 链接
 */
export function resolveLocalImages(text: string, jobId?: string | null): string {
  const src = typeof text === 'string' ? text : '';
  if (!src || !jobId) return src;
  if (!src.includes('![')) return src;

  const lines = src.split('\n');
  let fence: string | null = null;
  const out: string[] = [];
  for (const line of lines) {
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      // 只认同一种字符的围栏：``` 里的 ~~~ 是普通内容
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      out.push(line);
      continue;
    }
    out.push(fence === null ? rewriteLine(line, jobId) : line);
  }
  return out.join('\n');
}

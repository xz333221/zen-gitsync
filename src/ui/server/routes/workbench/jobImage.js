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
// 正文内嵌图片的路径判定（模型在回答里写 `![说明](图片路径)`）。
//
// ── 为什么需要服务端做中转 ────────────────────────────────────────────────
//
// 执行器（claude / opencode / codex）是在本机干活的，"展示一张图"对它来说最自然的
// 写法就是把刚截的图 / 刚读的 png 的**本机路径**贴出来。而对话流是 markdown 渲染：
// `<img src="c:\ws\repo\docs\a.png">` 在浏览器里永远是裂图 —— 那个地址不在页面能
// 够到的世界里。用户实测（2026-09-30）：让 Agent"展示一张图片"，它把截图读进上下文、
// 描述得挺准，但屏幕上只有一行字和一条路径。
//
// 于是：前端把这类本地路径重写成 `/api/workbench/jobs/:id/image?path=…`
// （utils/localImageSrc.ts），服务端按「这个 job 所属仓库」去取文件 —— 本文件是
// 那个端点的**路径判定**部分，读盘在 index.js 的路由里。
//
// ── 权限边界刻意收在"仓库内的图片" ────────────────────────────────────────
//
//   · 后缀必须过 IMAGE_EXTS 白名单（附件用的同一份，别再另起一份 —— 两份白名单
//     分叉时不会报错，只会让某一类图在正文里裂、在附件里正常）；
//   · 解析后的绝对路径必须落在仓库根内（`..` 穿越在这里被挡掉）。
//
// 判定写成**纯函数**（不碰 fs）：跨平台路径比较（盘符大小写、`..`、UNC、混用斜杠）
// 是最容易写错又最难在集成测试里覆盖的一块，单独可测。真正的读盘那一步还会按
// realpath 再校验一次（挡仓库里指向外部的符号链接），见 index.js。

import path from 'path';
import { IMAGE_EXTS, mimeForExt } from './attachmentUtils.js';

/**
 * 失败原因 → HTTP 状态码。
 * 放在这里而不是路由里 switch：端点只负责把 reason 映射出去，
 * 免得"哪些原因算 4xx 的哪一种"在两处各写一遍。
 */
export const IMAGE_PATH_STATUS = {
  'no-root': 400,
  'empty': 400,
  'bad-ext': 415,
  'outside-root': 403,
};

/** 失败原因 → 给前端/用户的文案 */
export const IMAGE_PATH_ERRORS = {
  'no-root': '无法确定任务所属仓库路径',
  'empty': 'path 不能为空',
  'bad-ext': '只支持图片文件（png / jpg / jpeg / gif / webp / bmp / svg）',
  'outside-root': '图片必须位于任务所属仓库内',
};

/**
 * 规整模型给出来的路径写法。
 *
 * 模型写路径的几种常见包裹方式都要认（否则同一条路径有时能渲染、有时不能）：
 *   `<c:\ws\a.png>`（markdown 允许尖括号包住含空格的目标）、`` `c:\ws\a.png` ``、
 *   `"c:\ws\a.png"`、`file:///c:/ws/a.png`。
 * 返回空串表示"这个值不值得再往下解析"（空 / 含 NUL）。
 *
 * @param {unknown} requested
 * @returns {string} 规整后的路径；不可用时为空串
 */
export function normalizeImagePath(requested) {
  let p = typeof requested === 'string' ? requested.trim() : '';
  if (!p) return '';
  // NUL 字节是路径里的经典绕过手法（`a.png\0.txt`），直接判死
  if (p.includes('\0')) return '';
  for (const [open, close] of [['<', '>'], ['`', '`'], ['"', '"'], ["'", "'"]]) {
    if (p.length > open.length + close.length && p.startsWith(open) && p.endsWith(close)) {
      p = p.slice(open.length, p.length - close.length).trim();
      break;
    }
  }
  if (/^file:\/\//i.test(p)) {
    p = p.replace(/^file:\/\//i, '');
    // file:///C:/a.png → /C:/a.png，那个多余的斜杠会让 win32 把盘符当相对目录
    if (/^\/[a-zA-Z]:[\\/]/.test(p)) p = p.slice(1);
  }
  return p.trim();
}

/** 路径后缀（小写，不含点）；没有后缀返回空串 */
export function imageExtOf(p) {
  const m = String(p || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

/**
 * `abs` 是否真的落在 `root` 目录**内部**（不含 root 自己）。
 *
 * 用 `path.relative` 而不是 `startsWith(root)`：字符串前缀会把 `D:\ws\repo-old`
 * 当成 `D:\ws\repo` 里的路径。win32 上 relative 还会把盘符大小写归一，
 * 所以 `d:\ws\repo` 与 `D:\WS\REPO\x.png` 能正确判成父子关系。
 */
export function isInsideRoot(root, abs) {
  const r = path.resolve(String(root || ''));
  const a = path.resolve(String(abs || ''));
  if (!r || !a) return false;
  const rel = path.relative(r, a);
  if (!rel) return false; // 等于根目录本身 —— 那是目录不是文件
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 把请求里的 path 解析成「仓库内的一张图片」。
 *
 * 相对路径按仓库根解析（模型常常写 `docs/screenshots/a.png` —— 它的 cwd 就是仓库根，
 * 对它来说这就是一个够用的地址；到我们这边得补上根）。
 *
 * @param {object} input
 * @param {string} input.root       任务所属仓库绝对路径
 * @param {unknown} input.requested 请求里的原始 path（查询串已由 express 解码）
 * @returns {{ok: true, absPath: string, ext: string, mime: string}
 *          | {ok: false, reason: keyof typeof IMAGE_PATH_ERRORS}}
 */
export function resolveJobImagePath({ root = '', requested = '' } = {}) {
  const base = typeof root === 'string' ? root.trim() : '';
  if (!base) return { ok: false, reason: 'no-root' };

  const rel = normalizeImagePath(requested);
  if (!rel) return { ok: false, reason: 'empty' };

  const ext = imageExtOf(rel);
  if (!ext || !IMAGE_EXTS.has(ext)) return { ok: false, reason: 'bad-ext' };

  // 绝对路径原样用，相对路径挂到仓库根下
  const absPath = path.resolve(base, rel);
  if (!isInsideRoot(base, absPath)) return { ok: false, reason: 'outside-root' };

  return { ok: true, absPath, ext, mime: mimeForExt(ext) };
}

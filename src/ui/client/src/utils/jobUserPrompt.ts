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
// 执行记录（job）→ 用户气泡里该显示的文字。
//
// `job.prompt` 是**真正发给 CLI 的那一整段**，按 taskRunner 的拼装顺序是：
//
//     [环境块] ── [记忆块] ── 用户真正说的话 + `续接 #N` + [附件清单]
//
// 把它原样当用户气泡渲染，有两个后果（2026-09-30 实测）：
//   1. 对话流里每续一轮就多一份一模一样的项目清单 / 记忆库说明，打开一条跑过多轮的任务，
//      第一屏全是它 —— 服务端把环境块改成「续聊轮精简版」就是为了压这个，但没压到气泡；
//   2. 用户从对话框里复制整段对话、再粘回续聊输入框时，这些注入块**跟着一起回去了**：
//      实测那条续聊轮 prompt 有 47,116 字符，里面 6 份环境块 + 6 份记忆块 + 6 份附件清单，
//      全是复制粘贴搬出来的（服务端自己只注入了一份）。
//
// 所以气泡只显示"用户真正说过的那部分"；注入块仍完整保留在 `job.prompt` 里，
// 执行日志详情的「复制日志」按原文导出，不受这里影响。
//
// 两个视图（WorkbenchView 的任务对话流、JobLogDetails 执行日志详情）共享这一份，
// 免得同一个 job 在两处显示得不一样（与 jobToolCalls.ts 同一个理由）。

/** 注入块之间的分隔符。必须与 taskRunner 拼 prompt 用的完全一致 */
const BLOCK_SEP = '\n\n---\n\n'
/** 环境块首行前缀（服务端的锚点，见 workbench/envContext.js） */
const ENV_PREFIX = '[运行环境 ·'
/** 记忆块首行（服务端的锚点，见 workbench/memoryContext.js） */
const MEM_HEADING = '## 跨会话记忆库'
/** 附件清单块：拼在 prompt 最末尾，前后各有一条 `---` */
const ATTACH_TAIL_RE = /\n\n---\n本任务包含 \d+ 个附件（请按文件路径读取[\s\S]*$/
/** 续聊轮标记：拼在用户那句话之后（附件块之前） */
const ROUND_TAIL_RE = /\n\n续接 #\d+\s*$/

/** 前导注入块的长度（含分隔符）。找不到分隔符时返回 0 = 不切，宁可多显示也别显示成空 */
function headBlockEnd(text: string): number {
  const at = text.indexOf(BLOCK_SEP)
  return at === -1 ? 0 : at + BLOCK_SEP.length
}

/**
 * 取出 `job.prompt` 里"用户真正说过的部分"，用于对话气泡。
 *
 * 纯展示层函数：不改写任何落盘数据，老 job（没有 userPrompt 字段）同样适用。
 * 只裁**首尾**的注入块 —— 用户自己粘进正文里的内容一个字符都不动。
 */
export function userFacingPrompt(prompt?: string): string {
  let text = typeof prompt === 'string' ? prompt : ''
  if (!text) return ''
  // 前导块：两块各自以 `\n\n---\n\n` 与正文分隔。单个判一次是因为
  // task.envContext / task.memoryContext 可以单独关掉，缺哪块就少切一刀。
  if (text.startsWith(ENV_PREFIX)) text = text.slice(headBlockEnd(text))
  if (text.startsWith(MEM_HEADING)) text = text.slice(headBlockEnd(text))
  // 尾部块：先附件清单（它才是最后一块），再 `续接 #N`
  text = text.replace(ATTACH_TAIL_RE, '').replace(ROUND_TAIL_RE, '')
  return text.trim()
}

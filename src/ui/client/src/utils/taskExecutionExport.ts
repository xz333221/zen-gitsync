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
// 任务执行内容 → 可粘贴的纯文本（「复制执行内容」按钮的数据源）。
//
// 一条任务下面可能挂着多轮 job（首次执行 + N 次续聊），这里按轮次把它们拼成一份 Markdown：
//
//     # <任务标题>
//     ## 第 1 轮   用户提示词 / Claude 思考 / 工具调用 / 模型返回
//     ## 第 2 轮   …
//
// 三处口径**有意跟对话流对齐**，不是重新发明一套：
//   1. 用户侧文案走 `userFacingPrompt()`。`job.prompt` 里还挂着环境块 / 记忆块 / 附件清单，
//      整段导出会把注入块一起带出去 —— 实测一条续聊轮 prompt 有 47k 字符，其中 6 份环境块
//      + 6 份记忆块全是用户复制粘贴搬出来的，而"复制"正是这条链路的**上游**，绝不能自己再灌一遍。
//   2. 工具调用走 `buildJobToolCalls()`。模型可能一句正文都不说就直接开干，
//      只看 output / thinking 会导出一片空白（同一个理由见该文件注释）。
//   3. 状态文案走 `statusLabel()`，与执行日志、看板共用同一份。
//
// 输出成 Markdown 而不是纯流水账：复制出去多半是贴进另一个 AI 或文档，
// `### 用户提示词` 这类行在**纯文本**下仍然一眼能读，渲染出来又是正常的小标题。
//
// 两种范围（`scope`）：
//   - `full`：提示词 / 思考 / 工具调用 / 模型返回 / 出错，全都要。
//   - `brief`：只留提示词 + 模型返回（+ 出错）。思考与工具结果是体积大头，粘给另一个 AI
//     时基本都是噪音；出错刻意保留，否则"只失败没正文"的那一轮会整轮消失。
//
// 与执行日志详情里的「复制全部」的区别：那里导出的是**单条 job 的原文**
// （`job.prompt` 原样，含注入块）；这里导出的是**整条任务的对话流**。

import type { Job } from '@/types/workbench'
import type { ToolCall } from 'zen-ai-chat-ui'
import { buildJobToolCalls } from '@/utils/jobToolCalls'
import { userFacingPrompt } from '@/utils/jobUserPrompt'
import { statusLabel } from '@/utils/jobStatus'
import { taskExecutorName } from '@/utils/taskExecutor'
import { $t } from '@/lang/static'

/** `YYYY-MM-DD HH:mm`（本地时区）。纯数字格式，跟语言无关，粘到哪都是同一串 */
export function localStamp(iso?: string | null): string {
  const d = iso ? new Date(iso) : new Date()
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export interface TaskExecutionExportMeta {
  /** 任务标题；空串时回落「未命名任务」 */
  title?: string
  /** 任务实际执行所在目录名（跨项目任务用的是 task.projectPath，不是编辑器当前项目）。空则不写这一行 */
  projectName?: string
  /** 导出时刻。测试注入用，默认取当前时间 */
  now?: Date
}

/** 导出范围：`full` 含思考 / 工具调用；`brief` 只留提示词 + 模型回复（+ 出错） */
export type TaskExecutionScope = 'brief' | 'full'

export interface TaskExecutionExportOptions {
  /** 默认 `full`（与旧行为一致） */
  scope?: TaskExecutionScope
}

/** 压成单行并限长：工具调用摘要进的是 `` ` `` 包里，换行会把行内代码块截断 */
function oneLine(text: string, max = 120): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/**
 * 用足够长的围栏包住内容。
 * 结果里本来就含 ``` 时必须加长围栏，否则粘出去代码块会被从中间截断 ——
 * 执行结果里带 Markdown 代码块是常态（模型贴的 diff / 示例代码）。
 */
function fence(text: string): string {
  const longest = (text.match(/`+/g) || []).reduce((m, s) => Math.max(m, s.length), 0)
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return `${ticks}\n${text}\n${ticks}`
}

function section(heading: string, body: string): string {
  return `### ${heading}\n\n${body.trim()}`
}

/** 工具调用流水 → 编号列表；结果放围栏里（可能是 diff / 文件内容，不能当正文揉进段落） */
function toolCallLines(calls: ToolCall[]): string {
  const lines: string[] = []
  calls.forEach((c, i) => {
    const name = c.name || $t('@WORKBENCH:工具')
    const summary = oneLine(c.argsPreview || '')
    lines.push(`${i + 1}. **${name}**${summary ? ` — \`${summary}\`` : ''}`)
    // 出错的调用优先给 error：这时 result 往往是空的，也可能是一段无意义的 stderr
    const detail = (c.status === 'error' ? c.error : c.result) || c.result || c.error || ''
    if (detail.trim()) lines.push('', fence(detail.trim()))
  })
  return lines.join('\n')
}

/**
 * 把一条任务的所有轮次拼成一份可粘贴的 Markdown。
 *
 * @param options.scope `full`（默认）含思考 / 工具调用；`brief` 只留提示词 + 模型回复（+ 出错）。
 * @returns 纯文本；**一条有内容的轮次都没有时返回空串**（调用方据此提示"暂无执行内容"）。
 */
export function buildTaskExecutionText(
  jobs: Job[],
  meta: TaskExecutionExportMeta = {},
  options: TaskExecutionExportOptions = {}
): string {
  const list = Array.isArray(jobs) ? jobs.filter(Boolean) : []
  const brief = options.scope === 'brief'
  const rounds: string[] = []

  list.forEach((j, i) => {
    const parts: string[] = []

    const prompt = userFacingPrompt(j.prompt)
    if (prompt) parts.push(section($t('@WORKBENCH:用户提示词'), prompt))

    // brief：思考与工具调用整段不带（它们是体积大头，粘给另一个 AI 时基本是噪音）
    if (!brief) {
      const thinking = (j.thinking || '').trim()
      if (thinking) parts.push(section($t('@WORKBENCH:Claude 思考'), thinking))

      const calls = toolCallLines(buildJobToolCalls(j))
      if (calls) parts.push(section($t('@WORKBENCH:工具调用'), calls))
    }

    const output = (j.output || '').trim()
    if (output) parts.push(section($t('@WORKBENCH:模型返回'), output))

    // 出错信息单列一节：进程退出码为 0 但协议层 failed 的情况（codex / opencode 常见）
    // 只有 agentError 能说明问题，藏在正文里会被当成模型的普通输出。
    // brief 下也保留：一轮只失败没正文时若不写，这一轮会**整轮消失**，复制出来像是没跑过。
    const err = (j.error || j.agentError || '').trim()
    if (err) parts.push(section($t('@WORKBENCH:出错'), err))

    // 这一轮什么都没有（例如刚排队就取消）→ 不留一个空标题
    if (parts.length === 0) return

    // 轮次号用**原始下标**：中间跳过空轮次时，后面的轮次号不能跟着往前挤，
    // 否则"第 2 轮"指的可能其实是对话里的第 3 轮，对着看板核对时对不上
    const metaLine = [
      taskExecutorName(j.agent),
      statusLabel(j.status),
      localStamp(j.startedAt)
    ].filter(Boolean)
    rounds.push(`## ${$t('@WORKBENCH:第 {n} 轮', { n: i + 1 })}\n\n*${metaLine.join(' · ')}*\n\n${parts.join('\n\n')}`)
  })

  if (rounds.length === 0) return ''

  const head: string[] = [`# ${(meta.title || '').trim() || $t('@WORKBENCH:未命名任务')}`]
  const project = (meta.projectName || '').trim()
  if (project) head.push('', `- ${$t('@WORKBENCH:项目：{name}', { name: project })}`)
  head.push(`- ${$t('@WORKBENCH:导出时间：{time}', { time: localStamp((meta.now || new Date()).toISOString()) })}`)

  return `${head.join('\n')}\n\n---\n\n${rounds.join('\n\n---\n\n')}\n`
}

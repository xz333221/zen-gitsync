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
// g ai 会话 → 可粘贴的纯文本（「复制会话」按钮的数据源）。
//
//     # <会话标题>
//     - 导出时间：2026-10-08 21:30 · 引擎：g ai · 共 12 条消息
//
//     ---
//
//     ## 我
//
//     供应商里添加 commandcode，给你个测试 token …
//
//     ---
//
//     ## g ai
//
//     ### 思考          ← 只有全量范围才有
//     ### 工具调用      ← 只有全量范围才有
//     正文
//
// **是纯函数**：只吃 messages 数组，不读 DOM、不碰 window.getSelection()。
// 理由与「复制执行内容」（utils/taskExecutionExport.ts）完全一样 —— 对话区是 v-for 渲染的，
// 用户在中间划一段再点复制的话，"复制了半截"比"复制了全部"更难发现。
//
// 两种范围（`scope`），口径直接沿用那个已落地的功能，别在这里另发明一套：
//   - `brief`（默认）：只留对话正文 —— 常用形态。
//   - `full`：追加思考与工具调用。它们是体积大头（一条会话动辄上百次工具调用、
//     思考块几百 KB），粘给另一个 AI 时基本都是噪音，所以不做默认。
//
// 抬头的「导出时间」刻意复用 taskExecutionExport 的 `localStamp`：两处复制出去的东西
// 必须是同一副面孔（`YYYY-MM-DD HH:mm`，纯数字、跟界面语言无关），各写一份迟早会分叉。

import type { ChatMessage, MessageRole, ToolCall } from 'zen-ai-chat-ui'
import { localStamp } from '@/utils/taskExecutionExport'
import { $t } from '@/lang/static'

/** 导出范围：`brief` 只留对话正文；`full` 追加思考 / 工具调用 */
export type AgentSessionScope = 'brief' | 'full'

export interface AgentSessionExportMeta {
  /** 会话标题；空则回落「无标题」 */
  title?: string
  /** 这条会话跑在哪个引擎上（内置 g ai / claude / codex …）。空则不写这一段 */
  engine?: string
  /** 助手显示名，与界面上气泡的署名一致。默认 `g ai` */
  assistantName?: string
  /** 导出时刻。测试注入用，默认取当前时间 */
  now?: Date
}

export interface AgentSessionExportOptions {
  /** 默认 `brief`（只留对话正文）；`full` 才带思考与工具调用 */
  scope?: AgentSessionScope
}

/** 压成单行并限长：工具调用摘要进的是 `` ` `` 包里，换行会把行内代码块截断 */
function oneLine(text: string, max = 120): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/**
 * 用足够长的围栏包住内容。
 * 结果里本来就含 ``` 时必须加长围栏，否则粘出去代码块会被从中间截断 ——
 * 工具返回里带 Markdown 代码块是常态（模型贴的 diff / 文件内容）。
 */
function fence(text: string): string {
  const longest = (text.match(/`+/g) || []).reduce((m, s) => Math.max(m, s.length), 0)
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return `${ticks}\n${text}\n${ticks}`
}

function section(heading: string, body: string): string {
  return `### ${heading}\n\n${body.trim()}`
}

/** 正文标题：用户走 i18n，助手直接用界面上的署名（g ai），与气泡保持一致 */
function roleHeading(role: MessageRole, assistantName: string): string {
  return role === 'user' ? $t('@AGENT:我') : assistantName
}

/** 工具调用流水 → 编号列表；结果放围栏里（可能是 diff / 文件内容，不能当正文揉进段落） */
function toolCallLines(calls: ToolCall[] | undefined): string {
  if (!Array.isArray(calls) || !calls.length) return ''
  const lines: string[] = []
  calls.forEach((c, i) => {
    const name = c.name || $t('@AGENT:工具')
    const summary = oneLine(c.argsPreview || '')
    lines.push(`${i + 1}. **${name}**${summary ? ` — \`${summary}\`` : ''}`)
    // 出错的调用优先给 error：这时 result 往往是空的，也可能是一段无意义的 stderr
    const detail = (c.status === 'error' ? c.error : c.result) || c.result || c.error || ''
    if (detail.trim()) lines.push('', fence(detail.trim()))
  })
  return lines.join('\n')
}

/** 一条消息 → 一个 `## <角色>` 段落；没有任何可导出内容的消息返回空串 */
function messageBlock(m: ChatMessage, full: boolean, assistantName: string): string {
  // system 整条丢掉：界面上本来就不展示它（见 useAgentChat 的 convertSessionToMessages），
  // 而且它里面挂着系统提示词与按轮注入的上下文块（工作区快照 / 常用目录状态 / 当前文档 /
  // 附件路径 —— 见服务端 injectRequestContext）。复制会话 = 复制**你看到的这段对话**，
  // 把几十 KB 注入块一起搬出去，粘到哪儿都是噪音（与「复制执行内容」走 userFacingPrompt
  // 裁剪注入块是同一条理由）。
  if (m.role === 'system') return ''

  const parts: string[] = []

  if (full) {
    const thinking = (m.reasoning || '').trim()
    if (thinking) parts.push(section($t('@AGENT:思考'), thinking))

    const calls = toolCallLines(m.toolCalls)
    if (calls) parts.push(section($t('@AGENT:工具调用'), calls))
  }

  const content = (m.content || '').trim()
  if (content) parts.push(content)

  // 附件只留文件名：data URL / blob 地址粘出去是一串读不懂的乱码
  const files = (m.attachments || []).map(a => a.name).filter(Boolean)
  if (files.length) parts.push(`${$t('@AGENT:附件')}：${files.join('、')}`)

  const err = (m.error || '').trim()
  if (err) parts.push(`> ⚠️ ${err}`)

  // 光标就停在这儿的那种：模型一句话没说直接调工具（精简范围下思考与工具调用都被裁掉了），
  // 或者这一轮还没产出正文就被停掉。不补一行的话这里只剩一个光秃秃的 `## g ai`，
  // 看着像"这一轮根本没发生过"。
  if (parts.length === 0) {
    if (m.role !== 'assistant') return ''
    parts.push(`*${$t('@AGENT:本轮未输出正文')}*`)
  }

  return `## ${roleHeading(m.role, assistantName)}\n\n${parts.join('\n\n')}`
}

/**
 * 把一条会话的全部消息拼成一份可粘贴的 Markdown。
 *
 * @param options.scope `brief`（默认）只留对话正文；`full` 追加思考 / 工具调用。
 * @returns 纯文本；**一条有内容的消息都没有时返回空串**（调用方据此提示"暂无可复制内容"，
 *          别把一个空串写进剪贴板 —— 那样用户粘出来是空白，还以为复制成功了）。
 */
export function buildAgentSessionText(
  messages: ChatMessage[],
  meta: AgentSessionExportMeta = {},
  options: AgentSessionExportOptions = {}
): string {
  const list = Array.isArray(messages) ? messages.filter(Boolean) : []
  const full = options.scope === 'full'
  const assistantName = (meta.assistantName || '').trim() || 'g ai'

  const blocks: string[] = []
  for (const m of list) {
    const block = messageBlock(m, full, assistantName)
    if (block) blocks.push(block)
  }
  if (blocks.length === 0) return ''

  const facts = [`${$t('@AGENT:导出时间')}：${localStamp((meta.now || new Date()).toISOString())}`]
  const engine = (meta.engine || '').trim()
  if (engine) facts.push(`${$t('@AGENT:引擎')}：${engine}`)
  facts.push($t('@AGENT:共 {n} 条消息', { n: blocks.length }))

  const head = `# ${(meta.title || '').trim() || $t('@AGENT:无标题')}\n\n- ${facts.join(' · ')}`
  return `${head}\n\n---\n\n${blocks.join('\n\n---\n\n')}\n`
}

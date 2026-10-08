// 「复制会话」导出文本的单测。
//
// 与 taskExecutionExport.test.ts 同一套口径：只测**拼装**，不测剪贴板（那是
// CopySessionButton 的 copyToClipboard，由浏览器探针覆盖）。导出文本是用户会直接粘到
// 别处去的东西，错的不是崩溃而是"悄悄多了一段 / 少了一段"。

import { describe, expect, test, vi } from 'vitest'

vi.mock('@/lang/static', () => ({
  // 最简 i18n：剥掉命名空间前缀 + 具名插值（zh 表里这些 key 的值就是去掉前缀的 key 本身）
  $t: (key: string, params?: Record<string, string | number>) => {
    const text = key.replace(/^@[A-Z0-9]+:/, '')
    return params
      ? Object.entries(params).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), text)
      : text
  },
}))

import { buildAgentSessionText } from './agentSessionExport'
import type { ChatMessage, ToolCall } from 'zen-ai-chat-ui'

const NOW = new Date(2026, 9, 8, 21, 30)

function msg(partial: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'm1', role: 'user', content: '', ...partial }
}

function call(partial: Partial<ToolCall> = {}): ToolCall {
  return { id: 'c1', name: 'read_file', ...partial }
}

describe('buildAgentSessionText', () => {
  test('精简（默认）：只留对话正文，思考与工具调用都不出现', () => {
    const text = buildAgentSessionText([
      msg({ role: 'user', content: '把 README 补一下' }),
      msg({
        id: 'm2',
        role: 'assistant',
        content: '已补好',
        reasoning: '先看看现有内容',
        toolCalls: [call({ argsPreview: 'README.md', result: '文件内容' })],
      }),
    ], { title: '补文档', engine: 'g ai', now: NOW })

    expect(text).toContain('## 我\n\n把 README 补一下')
    expect(text).toContain('## g ai\n\n已补好')
    expect(text).not.toContain('先看看现有内容')
    expect(text).not.toContain('read_file')
  })

  test('抬头：标题 / 导出时间 / 引擎 / 条数', () => {
    const text = buildAgentSessionText([
      msg({ content: '你好' }),
      msg({ id: 'm2', role: 'assistant', content: '在的' }),
    ], { title: '补文档', engine: 'claude', now: NOW })

    expect(text.startsWith('# 补文档\n\n- 导出时间：2026-10-08 21:30 · 引擎：claude · 共 2 条消息\n\n---\n\n')).toBe(true)
  })

  test('标题为空 → 无标题；引擎为空 → 抬头不写这一段', () => {
    const text = buildAgentSessionText([msg({ content: '你好' })], { title: '   ', now: NOW })
    expect(text.startsWith('# 无标题\n\n- 导出时间：2026-10-08 21:30 · 共 1 条消息')).toBe(true)
    expect(text).not.toContain('引擎')
  })

  test('全量：思考与工具调用各占一节，工具结果进围栏', () => {
    const text = buildAgentSessionText([
      msg({
        role: 'assistant',
        content: '改完了',
        reasoning: '先读文件',
        toolCalls: [call({ argsPreview: '  src/a.ts  ', result: 'const a = 1' })],
      }),
    ], { title: 'T', now: NOW }, { scope: 'full' })

    expect(text).toContain('### 思考\n\n先读文件')
    expect(text).toContain('### 工具调用\n\n1. **read_file** — `src/a.ts`\n\n```\nconst a = 1\n```')
    // 正文跟在两个小节后面
    expect(text.indexOf('### 工具调用')).toBeLessThan(text.indexOf('改完了'))
  })

  test('工具结果本身含 ``` 时围栏要加长（否则粘出去代码块被截断）', () => {
    const text = buildAgentSessionText([
      msg({
        role: 'assistant',
        content: 'ok',
        toolCalls: [call({ result: '```js\nconst a = 1\n```' })],
      }),
    ], { title: 'T', now: NOW }, { scope: 'full' })

    expect(text).toContain('````\n```js\nconst a = 1\n```\n````')
  })

  test('出错的工具调用优先给 error（这时 result 往往是空的）', () => {
    const text = buildAgentSessionText([
      msg({
        role: 'assistant',
        content: 'ok',
        toolCalls: [call({ status: 'error', error: 'ENOENT: no such file' })],
      }),
    ], { title: 'T', now: NOW }, { scope: 'full' })

    expect(text).toContain('ENOENT: no such file')
  })

  test('system 消息整条丢掉（界面上不展示，里面还挂着系统提示词与注入的上下文块）', () => {
    const text = buildAgentSessionText([
      msg({ role: 'system', content: '你是 "g ai" —— zen-gitsync 内置的编码智能体' }),
      msg({ content: '你好' }),
    ], { title: 'T', now: NOW })

    expect(text).not.toContain('内置的编码智能体')
    expect(text).not.toContain('## 系统')
    expect(text).toContain('## 我\n\n你好')
    expect(text).toContain('共 1 条消息')
  })

  test('附件只留文件名', () => {
    const text = buildAgentSessionText([
      msg({
        content: '看这两张图',
        attachments: [
          { id: 'a1', name: 'a.png', size: 12, type: 'image/png', preview: 'data:image/png;base64,AAAA' },
          { id: 'a2', name: 'b.txt', size: 3, type: 'text/plain' },
        ],
      }),
    ], { title: 'T', now: NOW })

    expect(text).toContain('附件：a.png、b.txt')
    expect(text).not.toContain('base64')
  })

  test('出错信息单列一行（藏在正文里会被当成模型的普通输出）', () => {
    const text = buildAgentSessionText([
      msg({ role: 'assistant', content: '写到一半', error: '连接中断' }),
    ], { title: 'T', now: NOW })
    expect(text).toContain('写到一半\n\n> ⚠️ 连接中断')
  })

  test('只有工具调用、没有正文的助手消息：精简下留一行占位，不当成"这一轮不存在"', () => {
    const text = buildAgentSessionText([
      msg({ role: 'assistant', toolCalls: [call({ result: 'x' })] }),
    ], { title: 'T', now: NOW })

    expect(text).toContain('## g ai\n\n*本轮未输出正文*')
    expect(text).not.toContain('工具调用')
  })

  test('全量下同一条消息有工具调用就不需要占位行', () => {
    const text = buildAgentSessionText([
      msg({ role: 'assistant', toolCalls: [call({ result: 'x' })] }),
    ], { title: 'T', now: NOW }, { scope: 'full' })

    expect(text).toContain('### 工具调用')
    expect(text).not.toContain('本轮未输出正文')
  })

  test('空会话 / 全空消息 → 空串（调用方据此提示，不把空串写进剪贴板）', () => {
    expect(buildAgentSessionText([], { title: 'T', now: NOW })).toBe('')
    expect(buildAgentSessionText([msg({ content: '' })], { title: 'T', now: NOW })).toBe('')
    expect(buildAgentSessionText([msg({ content: '   ' })], { title: 'T', now: NOW })).toBe('')
  })

  test('空内容的用户消息不占一个空标题', () => {
    const text = buildAgentSessionText([
      msg({ content: '' }),
      msg({ id: 'm2', role: 'assistant', content: '在的' }),
    ], { title: 'T', now: NOW })

    expect(text).toContain('## g ai\n\n在的')
    expect(text).not.toContain('## 我')
    expect(text).toContain('共 1 条消息')
  })

  test('多条消息之间用 --- 分隔，正文里原有的空行不被压掉', () => {
    const text = buildAgentSessionText([
      msg({ content: '第一段\n\n\n第二段' }),
      msg({ id: 'm2', role: 'assistant', content: '收到' }),
    ], { title: 'T', now: NOW })

    expect(text).toContain('第一段\n\n\n第二段')
    expect(text).toContain('\n\n---\n\n## g ai')
  })
})

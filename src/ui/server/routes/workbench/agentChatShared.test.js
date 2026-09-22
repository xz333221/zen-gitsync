// Web 智能体面板（agentChat.js）必须与 CLI 的 `g ai` 共用同一条**上下文**和**传输**口径。
//
// 这两处曾经各有一份自己的实现：
//   上下文：只按条数硬切 40 条 + 纯 splice 丢弃，且**原地**改 session.messages
//          （聊久了模型失忆，磁盘上的会话记录还被永久削掉一截）
//   传输  ：自带的 streamChatOnce 不拦"流被截断但 tool_calls 已部分到达" ——
//          半截的参数有可能被拿去执行
// 现在两者都收敛到 src/cli/ai/ 下的共享模块。这个文件跑真实的 runAgentTurn，
// 把发出去的请求体与产生的事件抓下来，逐条钉住收敛后的口径。
//
// 注意:必须在 import agentChat.js **之前**把 USERPROFILE/HOME 指到沙箱,否则
// configManager / agentSessionStore 会去读真实的 ~/.zen-gitsync。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'zen-agent-shared-'))
process.env.USERPROFILE = SANDBOX
process.env.HOME = SANDBOX
delete process.env.HOMEDRIVE
delete process.env.HOMEPATH

const event = data => `data: ${JSON.stringify(data)}\n\n`
const sse = chunks => new Response(new ReadableStream({
  start(controller) {
    const bytes = new TextEncoder()
    chunks.forEach(chunk => controller.enqueue(bytes.encode(chunk)))
    controller.close()
  },
}), { status: 200, headers: { 'content-type': 'text/event-stream' } })

const model = { model: 'test', name: 'test', baseURL: 'https://example.invalid/v1', apiKey: 'test' }
const call = n => ({ id: `call${n}`, type: 'function', function: { name: 'read_file', arguments: '{}' } })
const okStream = () => sse([event({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }), 'data: [DONE]\n\n'])
const withSystem = () => [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }]
const longSession = () => {
  const messages = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'original goal' }]
  for (let i = 0; i < 60; i++) {
    messages.push({ role: 'assistant', tool_calls: [call(i)] })
    messages.push({ role: 'tool', tool_call_id: `call${i}`, content: 'data'.repeat(4000) })
  }
  return messages
}

// 跑一轮真实的 runAgentTurn,桩掉 globalThis.fetch —— 抓住发出去的请求体与产生的事件
async function runWeb({ session, userMessage, respond, locale = 'zh-CN' }) {
  const { runAgentTurn } = await import('./agentChat.js')
  const events = []
  let sent
  const original = globalThis.fetch
  globalThis.fetch = async (_url, init) => { sent = JSON.parse(init.body); return respond() }
  try {
    const result = await runAgentTurn({
      session, model, userMessage, locale, cwd: process.cwd(),
      signal: new AbortController().signal, send: e => events.push(e),
    })
    return { sent, events, result }
  } finally {
    globalThis.fetch = original
  }
}

const newSession = (sessionId, messages) => ({ sessionId, messages, cwd: process.cwd() })

// ── 上下文口径 ────────────────────────────────────────────

test('请求体与 context.js 的输出逐字段相同（有界 + 摘录）', async () => {
  const { prepareRequestMessages } = await import('../../../../cli/ai/context.js')
  const messages = longSession()
  // 传副本进去:runAgentTurn 会往 session.messages 追加消息,原数组要留作期望值的输入
  const session = newSession('ag-sandbox-test', structuredClone(messages))

  const { sent } = await runWeb({ session, userMessage: 'next', respond: okStream })

  assert.ok(sent, '必须发出过一次请求')
  assert.ok(sent.messages.length <= 40, `请求副本未收窄: ${sent.messages.length} 条`)
  assert.equal(sent.messages[0].role, 'system')
  assert.match(sent.messages[1].content, /^\[Earlier conversation excerpts/)
  assert.ok(sent.messages.some(m => m.content === 'original goal'), '原始目标必须保留')
  // 逐字段相同 = 这条链路确实走的是同一个函数,而不是"看起来差不多"的第二份实现
  assert.deepEqual(
    sent.messages,
    prepareRequestMessages([...messages, { role: 'user', content: 'next' }], { locale: 'zh-CN' }),
  )
})

test('会话记录不再被原地裁剪（磁盘口径与 CLI 一致）', async () => {
  const session = newSession('ag-sandbox-keep', longSession())

  await runWeb({ session, userMessage: 'next', respond: okStream })

  assert.equal(session.messages.filter(m => m.role === 'tool').length, 60,
    '旧消息必须留在会话记录里(裁剪只作用于请求副本)')
  assert.equal(session.messages[1].content, 'original goal')
  assert.equal(session.messages[2].tool_calls[0].id, 'call0')
})

test('短会话不做任何额外处理,也不塞摘录消息', async () => {
  const session = newSession('ag-sandbox-short', withSystem())

  const { sent } = await runWeb({ session, userMessage: 'hello', respond: okStream })

  assert.deepEqual(sent.messages.map(m => m.content), ['rules', 'hi', 'hello'])
})

// ── 传输口径 ──────────────────────────────────────────────

test('请求体带上 stream_options,与 CLI 一致地统计 usage', async () => {
  const session = newSession('ag-sandbox-usage', withSystem())

  const { sent } = await runWeb({ session, userMessage: 'hello', respond: okStream })

  assert.deepEqual(sent.stream_options, { include_usage: true })
  assert.equal(sent.stream, true)
  assert.equal(sent.temperature, 0.3)
  assert.ok(Array.isArray(sent.tools) && sent.tools.length > 0, '内置工具表必须随请求下发')
})

test('流被截断（没有 finish_reason 也没有 [DONE]）时不执行半截的工具调用', async () => {
  const session = newSession('ag-sandbox-truncated', withSystem())
  // 工具调用参数是完整的、JSON 合法 —— 换在没有这道闸的旧实现里就会被真的执行
  const truncated = sse([event({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', function: { name: 'read_file', arguments: '{"path":"nope.txt"}' } }] } }],
  })])

  const { events } = await runWeb({ session, userMessage: '读个文件', respond: () => truncated })

  const error = events.find(e => e.type === 'error')
  assert.ok(error, '截断的流必须报错,不能静默当成正常结束')
  assert.match(error.error, /中断/)
  assert.equal(events.some(e => e.type === 'tool_call_start'), false, '被截断的调用不得开始执行')
  assert.equal(session.messages.some(m => m.role === 'tool'), false, '被截断的调用不得留下工具结果')
})

test('400 且正文提到 tool/function 时提示换模型,而不是甩网关 JSON', async () => {
  const session = newSession('ag-sandbox-nofc', withSystem())
  const noFunctionCalling = () => new Response(
    JSON.stringify({ error: { message: 'tools is not supported by this model' } }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  )

  const { sent, events } = await runWeb({ session, userMessage: 'hello', respond: noFunctionCalling })

  assert.equal(sent.messages.length, 3, '不该把 stream_options 的降级重试和这条错误混在一起')
  const error = events.find(e => e.type === 'error')
  assert.ok(error)
  assert.match(error.error, /不支持 function calling/)
  assert.match(error.error, /换用支持工具调用的模型/)
})

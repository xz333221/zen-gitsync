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
// 工具调用长会话。**组数按当前默认预算反算**，不写死——
// 默认预算 2026-10-07 一天内改了三次（80k 字符 → 400k 字符 → 1M token），
// 每次写死的组数都会在某次改完后变成"不够触发裁剪"，让下面那些
// 「请求副本未收窄 / 会报出 droppedMessages」的断言**假绿**。
//
// 实测：`'data'.repeat(4000)` = 4,000 纯 ascii ≈ 1,143 token（clip 的 6,000
// 上限用不上）；assistant 那条 tool_calls 极短；两条一组 ≈ 1,200 token。
// 1M 预算需 ≈850 组才填满 → 给 1,500 组留足余量。
//
// ⚠️ 判据：**条数上限 × 单组token 必须明显大于 token 预算**。
const LONG_SESSION_GROUPS = 1500
const longSession = () => {
  const messages = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'original goal' }]
  for (let i = 0; i < LONG_SESSION_GROUPS; i++) {
    messages.push({ role: 'assistant', tool_calls: [call(i)] })
    messages.push({ role: 'tool', tool_call_id: `call${i}`, content: 'data'.repeat(4000) })
  }
  return messages
}

// 跑一轮真实的 runAgentTurn,桩掉 globalThis.fetch —— 抓住发出去的请求体与产生的事件
// (respond 收到 fetch 的 init,方便测试按 signal 模拟"读到一半被中止")
//
// streamFn：传输层现在默认会自动重试（最多 10 次、指数退避，见 cli/ai/transport.js）。
// 这一组用例关心的是"失败时怎么收场"，不是"重试几次" —— 真等退避会让一个用例跑到分钟级。
// 所以统一注入 maxRetries: 0 的那一份；重试自身的口径在 cli/ai/runtime.test.js 里逐条钉。
async function runWeb({ session, userMessage, respond, locale = 'zh-CN', signal, onEvent, resume = false, streamFn }) {
  const { runAgentTurn } = await import('./agentChat.js')
  const { streamChatOnce } = await import('../../../../cli/ai/transport.js')
  const events = []
  let sent
  const original = globalThis.fetch
  globalThis.fetch = async (_url, init) => { sent = JSON.parse(init.body); return respond(init) }
  try {
    const result = await runAgentTurn({
      session, model, userMessage, locale, cwd: process.cwd(),
      signal: signal ?? new AbortController().signal,
      send: e => { events.push(e); onEvent?.(e) },
      resume,
      streamFn: streamFn ?? (opts => streamChatOnce({ ...opts, maxRetries: 0 })),
    })
    return { sent, events, result }
  } finally {
    globalThis.fetch = original
  }
}

const newSession = (sessionId, messages) => ({ sessionId, messages, cwd: process.cwd() })

// ── 上下文口径 ────────────────────────────────────────────

test('请求体与 context.js 的输出逐字段相同（有界 + 摘录）', async () => {
  const { prepareRequestMessages, resolveRequestBudget } = await import('../../../../cli/ai/context.js')
  const messages = longSession()
  // 传副本进去:runAgentTurn 会往 session.messages 追加消息,原数组要留作期望值的输入
  const session = newSession('ag-sandbox-test', structuredClone(messages))

  const { sent } = await runWeb({ session, userMessage: 'next', respond: okStream })

  assert.ok(sent, '必须发出过一次请求')
  // 上限写死成 40 就会在默认值变更那天变成假绿 —— 直接引用解析结果
  assert.ok(sent.messages.length <= resolveRequestBudget(undefined).maxMessages,
    `请求副本未收窄: ${sent.messages.length} 条`)
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
  const toolCountBefore = session.messages.filter(m => m.role === 'tool').length

  await runWeb({ session, userMessage: 'next', respond: okStream })

  // 比"运行前后"而不是写死组数 —— longSession 的组数一改这条就假绿
  assert.equal(session.messages.filter(m => m.role === 'tool').length, toolCountBefore,
    '旧消息必须留在会话记录里(裁剪只作用于请求副本)')
  assert.equal(session.messages[1].content, 'original goal')
  assert.equal(session.messages[2].tool_calls[0].id, 'call0')
})

test('短会话不做任何额外处理,也不塞摘录消息', async () => {
  const session = newSession('ag-sandbox-short', withSystem())

  const { sent } = await runWeb({ session, userMessage: 'hello', respond: okStream })

  assert.deepEqual(sent.messages.map(m => m.content), ['rules', 'hi', 'hello'])
})

// ── 上下文占用下发（2026-10-07）────────────────────────────────
// UI 的占用条全靠这个事件。断它 = 进度条永远停在 0%，而界面不会报任何错。

test('每次请求前发一条 context 事件,用量与请求副本一致', async () => {
  const { resolveRequestBudget } = await import('../../../../cli/ai/context.js')
  const session = newSession('ag-sandbox-ctx', withSystem())

  const { events, sent } = await runWeb({ session, userMessage: 'hello', respond: okStream })

  const ctx = events.filter(e => e.type === 'context')
  assert.ok(ctx.length >= 1, '必须至少发一条 context 事件')
  const usage = ctx[0].usage
  const budget = resolveRequestBudget(undefined)
  // 分母必须跟实际裁剪用的是同一份，否则进度条会说谎
  // 主口径是 **token**（maxChars 只是给按字符切的地方用的保守换算值，不是闸门）
  assert.equal(usage.maxTokens, budget.maxTokens)
  assert.equal(usage.maxChars, budget.maxChars)
  assert.equal(usage.maxMessages, budget.maxMessages)
  assert.equal(usage.messages, sent.messages.length, 'usage 里的条数要与真实发出去的请求一致')
  assert.ok(usage.chars > 0 && usage.estTokens > 0)
  assert.ok(usage.tokenRatio > 0 && usage.tokenRatio <= 1)
  assert.equal(usage.droppedMessages, 0, '短会话不该有裁剪')
})

test('provider 返回 usage 时补一条带真实输入 token 的 context', async () => {
  const session = newSession('ag-sandbox-ctx-usage', withSystem())
  const withUsage = () => sse([
    event({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }),
    event({ usage: { prompt_tokens: 4321, completion_tokens: 10, total_tokens: 4331 } }),
    'data: [DONE]\n\n',
  ])

  const { events } = await runWeb({ session, userMessage: 'hello', respond: withUsage })

  const withActual = events.filter(e => e.type === 'context' && typeof e.usage.actualInputTokens === 'number')
  assert.ok(withActual.length >= 1, '必须有一条带上真实 input token')
  assert.equal(withActual[0].usage.actualInputTokens, 4321)
})

test('被裁剪的长会话会报出 droppedMessages（UI 靠它解释"为什么模型忘了"）', async () => {
  const { resolveRequestBudget } = await import('../../../../cli/ai/context.js')
  const session = newSession('ag-sandbox-ctx-drop', longSession())
  const toolCount = session.messages.filter(m => m.role === 'tool').length

  const { events } = await runWeb({ session, userMessage: 'next', respond: okStream })

  const usage = events.find(e => e.type === 'context').usage
  assert.ok(usage.droppedMessages > 0, '长会话必须报出被裁掉的条数')
  // longSession = system + 首 user + N×(assistant + tool)，再加 runAgentTurn 追加的本轮 user
  assert.equal(usage.transcriptMessages, toolCount * 2 + 3,
    'transcriptMessages 是磁盘上的完整条数（含本轮 user）')
  assert.ok(usage.messages < usage.transcriptMessages, '带入的必须少于磁盘上的，否则说明没裁')
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

// 回归：用户点"停止"（中止正在跑的这一轮）时，已经流出来的正文必须留在会话记录里。
// 之前中止分支只把当时的状态写盘、不回填正文，重新打开这条会话时刚才生成的内容整段消失。
test('中止时已流出的正文要留在会话记录里', async () => {
  const session = newSession('ag-sandbox-aborted', withSystem())
  const controller = new AbortController()

  // 吐一段正文后挂住（模拟"停在生成中"）；真 fetch 在 signal abort 时会打断 body 读取，
  // 桩里照做才能真的走到中止分支
  const hanging = init => new Response(new ReadableStream({
    start(stream) {
      const bytes = new TextEncoder()
      stream.enqueue(bytes.encode(event({ choices: [{ delta: { content: '已经写了一半' } }] })))
      init?.signal?.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')))
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })

  const { result } = await runWeb({
    session, userMessage: '写一半就停', respond: hanging, signal: controller.signal,
    // 正文事件到达 = 这段已经被读进来，此刻中止最贴近用户点"停止"的时机
    onEvent: e => { if (e.type === 'content') controller.abort() },
  })

  assert.equal(result.aborted, true)
  const last = session.messages[session.messages.length - 1]
  assert.equal(last.role, 'assistant')
  assert.equal(last.content, '已经写了一半')
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

// ── 工具参数的透传契约 ──────────────────────────────────────
// 两个字段分工不同，两边都不能少：
//   · arguments —— 展开后「参数」框里的原文，**每种工具都发全文**。前端历史回放
//     (useAgentChat 读 session.messages)拿到的本来就是全文，只在流式这一路发摘要，
//     就会让"正在跑"和"刷新后"看到两份不同的参数。
//   · argsPreview —— 收起态那一行副标题，故意截到 200 字。
// 计划类工具的 steps 也在 arguments 里（不再单独开一条透传路径）。
test('tool_call_start 每种工具都带完整 arguments,argsPreview 仍是截断摘要', async () => {
  const planArgs = JSON.stringify({
    steps: [
      { content: '读代码', status: 'completed' },
      { content: '改代码', status: 'in_progress' }
    ],
    explanation: '先改库再改宿主'
  })
  const round = [
    sse([event({
      choices: [{ delta: { tool_calls: [
        { index: 0, id: 'p1', function: { name: 'update_plan', arguments: planArgs } },
        { index: 1, id: 'p2', function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.js', content: 'x'.repeat(50) }) } }
      ] } }, { finish_reason: 'tool_calls' }],
    }), 'data: [DONE]\n\n']),
    okStream(),
  ]
  let turn = 0
  const session = newSession('ag-sandbox-plan', withSystem())

  const { events } = await runWeb({
    session,
    userMessage: '把这个功能做出来',
    respond: () => round[turn++] || okStream(),
  })

  const starts = events.filter(e => e.type === 'tool_call_start')
  assert.equal(starts.length, 2)
  const planStart = starts.find(e => e.name === 'update_plan')
  const writeStart = starts.find(e => e.name === 'write_file')

  // 计划：全文必须一字不差地带到前端（前端靠它渲染清单）
  assert.equal(planStart.arguments, planArgs)
  assert.match(planStart.argsPreview, /1\/2|1 完成/)
  // 其他工具：展开态同样要看到原文，不再只给摘要
  assert.equal(writeStart.arguments, JSON.stringify({ path: 'a.js', content: 'x'.repeat(50) }))
  assert.ok(writeStart.argsPreview.length < writeStart.arguments.length, '摘要仍应是截断过的')

  const planResult = events.find(e => e.type === 'tool_result' && e.name === 'update_plan')
  assert.match(planResult.result, /计划已更新/)
  // 计划也要进会话记录 —— 重新打开会话时前端靠历史里的 arguments 复原清单
  const assistantWithPlan = session.messages.find(m => m.role === 'assistant' && m.tool_calls?.some(t => t.function.name === 'update_plan'))
  assert.equal(assistantWithPlan.tool_calls[0].function.arguments, planArgs)
})

// ── 重试与续跑（2026-10-09）────────────────────────────────────
// 「重试」要能真的把上一轮跑下去，靠的是服务端两条口径：
//   1. 失败时**不撤**那条 user 消息 —— 撤了的话 resume 会退化成"重跑上一轮"
//   2. resume 时**不再压** user 消息 —— 压了就变成"同一条请求出现两次"
// 两条各自都有明确的失效症状，所以各钉一条。

test('失败时不再撤掉本轮压入的 user 消息（否则重试会退化成重跑上一轮）', async () => {
  const session = newSession('ag-sandbox-keep-user', withSystem())
  const boom = () => new Response(JSON.stringify({ error: { message: 'bad request: model not found' } }),
    { status: 404, headers: { 'content-type': 'application/json' } })

  const { events } = await runWeb({ session, userMessage: '这条不能消失', respond: boom })

  assert.ok(events.some(e => e.type === 'error'))
  const last = session.messages[session.messages.length - 1]
  assert.equal(last.role, 'user')
  assert.equal(last.content, '这条不能消失')
})

test('resume 不再压 user 消息，接着会话现有的尾巴跑', async () => {
  const session = newSession('ag-sandbox-resume', withSystem())
  const usersBefore = session.messages.filter(m => m.role === 'user').length

  const { sent } = await runWeb({ session, userMessage: '', resume: true, respond: okStream })

  assert.equal(sent.messages.length, 2, 'resume 不该往请求里加消息')
  assert.deepEqual(sent.messages.map(m => m.content), ['rules', 'hi'])
  // 会话记录里也不能多出一条 user（多出来的那条只会是本轮 assistant 的回答）
  assert.equal(session.messages.filter(m => m.role === 'user').length, usersBefore)
  assert.equal(session.messages[session.messages.length - 1].role, 'assistant')
})

test('每次 LLM 请求前发一条 attempt（前端靠它记重试断点），自动重试时发 retry', async () => {
  const { streamChatOnce } = await import('../../../../cli/ai/transport.js')
  let calls = 0
  // 第一次吐半截就断流（可重试），第二次正常返回 —— 真链路走 streamChatOnce，
  // 只把"真等退避"换掉，好让这条用例秒级跑完
  const flaky = opts => streamChatOnce({
    ...opts,
    sleepFn: async () => {},
    fetchFn: async () => {
      calls++
      if (calls === 1) return sse([event({ choices: [{ delta: { content: '半截' } }] })])
      return okStream()
    },
  })
  const session = newSession('ag-sandbox-retry', withSystem())

  const { events } = await runWeb({ session, userMessage: '开始', streamFn: flaky })

  assert.equal(calls, 2, '第一次断流后必须再试一次')
  // attempt 是**每次工具循环的请求开始前**发的一条（不是每次尝试）：
  // 自动重试沿用的还是同一个断点 —— 它要丢的正是这一轮请求吐的全部内容。
  assert.equal(events.filter(e => e.type === 'attempt').length, 1)
  const retry = events.find(e => e.type === 'retry')
  assert.ok(retry, '自动重试必须通知前端，否则界面上会留下上一截的字')
  assert.equal(retry.attempt, 1)
  assert.equal(retry.maxRetries, 10)
  assert.match(retry.reason, /中断/)
  // 断点必须排在正文之前：前端是按"收到 attempt 时气泡里已有的长度"回退的
  const order = events.map(e => e.type)
  assert.ok(order.indexOf('attempt') < order.indexOf('content'), 'attempt 要在正文之前')
  assert.ok(order.indexOf('content') < order.indexOf('retry'), 'retry 落在被丢弃的那段正文之后')
})

test('对跑完的一轮点「重新生成」：把尾巴那条 assistant 摘掉再问一次', async () => {
  // 会话尾巴是一条没有工具调用的 assistant = 上一轮已经答完了。
  // 留着它的话模型会顺着自己的答案往下说，重开会话还会看到两条连着的 assistant。
  const session = newSession('ag-sandbox-regen', [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '旧答案' },
  ])

  const { sent } = await runWeb({ session, userMessage: '', resume: true, respond: okStream })

  assert.deepEqual(sent.messages.map(m => m.content), ['rules', 'hi'], '旧答案必须从请求里消失')
  assert.equal(session.messages.filter(m => m.role === 'assistant').length, 1, '只剩这一次新生成的')
  assert.equal(session.messages[session.messages.length - 1].content, 'ok')
})

test('对中途失败的一轮点「重试」：工具结果留在尾巴上，一条都不摘', async () => {
  // 失败发生在工具循环中途时，尾巴是 assistant(tool_calls) + 一批 tool 结果 ——
  // 这些是这一轮真干过的事，摘掉就等于让模型把工具再跑一遍。
  const session = newSession('ag-sandbox-resume-tools', [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [call(0)] },
    { role: 'tool', tool_call_id: 'call0', content: 'file contents' },
  ])

  const { sent } = await runWeb({ session, userMessage: '', resume: true, respond: okStream })

  assert.deepEqual(sent.messages.map(m => m.role), ['system', 'user', 'assistant', 'tool'])
  assert.equal(sent.messages[3].content, 'file contents', '已经跑完的工具结果必须原样带上')
})

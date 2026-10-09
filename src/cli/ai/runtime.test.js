import { test } from 'node:test'
import assert from 'node:assert/strict'
import { streamChatOnce } from './transport.js'
import { normalizeUsage, addUsage } from './telemetry.js'
import { runAgentTurn } from './turn.js'
import { buildRequestMessages, repairToolHistory, resolveRequestBudget } from './context.js'
import { createAssistantWriter, stripAnsi } from './termui.js'

const model = { model: 'test', baseURL: 'https://example.invalid/v1', apiKey: 'test' }
const event = data => `data: ${JSON.stringify(data)}\n\n`
const response = chunks => new Response(new ReadableStream({ start(controller) {
  const bytes = new TextEncoder()
  chunks.forEach(chunk => controller.enqueue(bytes.encode(chunk)))
  controller.close()
} }))

test('usage includes cache/reasoning subsets without double counting', () => {
  const usage = normalizeUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 10 } })
  assert.deepEqual(usage, { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedTokens: 80, reasoningTokens: 10 })
  assert.equal(addUsage(usage, usage).totalTokens, 240)
  assert.equal(normalizeUsage({}), null)
  assert.equal(normalizeUsage({ input_tokens: 2, output_tokens: 3 }).totalTokens, 5)
})

test('SSE supports split events, final usage-only events and an unterminated final line', async () => {
  let sent
  const content = event({ choices: [{ delta: { content: '你好' } }] })
  const result = await streamChatOnce({ model, messages: [], fetchFn: async (_url, init) => {
    sent = JSON.parse(init.body)
    return response([content.slice(0, 12), content.slice(12),
      event({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      event({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }),
      'data: [DONE]'])
  } })
  assert.deepEqual(sent.stream_options, { include_usage: true })
  assert.equal(result.content, '你好')
  assert.equal(result.usage.totalTokens, 13)
})

test('cumulative usage events replace snapshots instead of adding them', async () => {
  const result = await streamChatOnce({ model, messages: [], fetchFn: async () => response([
    event({ usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }),
    event({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }),
  ]) })
  assert.equal(result.usage.totalTokens, 12)
})

test('unsupported stream_options retries once without requesting usage', async () => {
  const bodies = []
  const result = await streamChatOnce({ model: { ...model, model: 'legacy' }, messages: [], fetchFn: async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return bodies.length === 1
      ? new Response(JSON.stringify({ error: { message: 'unknown parameter stream_options' } }), { status: 400 })
      : response([event({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
  } })
  assert.equal(bodies.length, 2)
  assert.equal(bodies[1].stream_options, undefined)
  assert.equal(result.usage, null)
})

// 这两条关心的都是"失败时怎么收场"，不是"重试几次" —— 一律 maxRetries: 0，
// 否则要真等退避（最多 10 次、单次封顶 30s），一个用例就跑到分钟级。
// 重试本身的行为在文件末尾那组用例里单独验（那里注入 sleepFn，不真等）。
test('truncated streams do not yield executable tool calls', async () => {
  await assert.rejects(streamChatOnce({ model, messages: [], maxRetries: 0, fetchFn: async () => response([
    event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'write_file', arguments: '{}' } }] } }] }),
  ]) }), /中断/)
})

test('timeout and explicit cancellation have different outcomes', async () => {
  const hanging = async (_url, { signal }) => new Promise((_, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
  await assert.rejects(streamChatOnce({ model, messages: [], fetchFn: hanging, idleTimeoutMs: 10, maxRetries: 0 }), /超时/)
  const result = await streamChatOnce({ model, messages: [], fetchFn: hanging, signal: AbortSignal.abort() })
  assert.equal(result.aborted, true)
  assert.deepEqual(result.toolCalls, [])
})

// ── 空闲超时 + 自动重试（2026-10-09）─────────────────────────────────
//
// 这一组钉的是两件事：
//   1. 超时的判据是**空闲**（多久没数据）而不是整条流的时长 —— 慢回答不该被掐
//   2. 失败会自己重试，而"重试也没用"的错误（4xx / 非法 index）不会白试十次

test('空闲超时只在"真的没有数据"时触发，慢回答活得下来', async () => {
  // 整条流故意拖过 idleTimeoutMs，但每 10ms 吐一段 —— 旧口径（总时长上限）在这里必红
  const slowButAlive = async (_url, init) => new Response(new ReadableStream({
    async start(controller) {
      const bytes = new TextEncoder()
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 12))
        controller.enqueue(bytes.encode(event({ choices: [{ delta: { content: `c${i}` } }] })))
      }
      controller.enqueue(bytes.encode(event({ choices: [{ delta: {}, finish_reason: 'stop' }] })))
      controller.enqueue(bytes.encode('data: [DONE]\n\n'))
      controller.close()
    },
  }))
  const result = await streamChatOnce({ model, messages: [], fetchFn: slowButAlive, idleTimeoutMs: 40, maxRetries: 0 })
  assert.equal(result.content, 'c0c1c2c3c4c5')
})

test('可重试的失败会自己重试到成功，并把半截产物交给 onRetry', async () => {
  let calls = 0
  const retries = []
  const flaky = async () => {
    calls++
    // 第一次：吐一段正文后流断掉（没有 finish_reason）—— 正是"重试能救"的那类
    if (calls === 1) return response([event({ choices: [{ delta: { content: '半截' } }] })])
    return response([event({ choices: [{ delta: { content: '好了' }, finish_reason: 'stop' }] }), 'data: [DONE]\n\n'])
  }
  const result = await streamChatOnce({
    model, messages: [], fetchFn: flaky,
    sleepFn: async () => {},          // 不真等退避
    onRetry: info => retries.push(info),
  })
  assert.equal(calls, 2)
  assert.equal(result.content, '好了')
  assert.equal(retries.length, 1)
  assert.equal(retries[0].attempt, 1)
  assert.equal(retries[0].maxRetries, 10, '默认重试上限与 Claude Code 对齐（10）')
  // 半截内容必须交出来 —— 调用方要靠它把界面上那半句丢掉，否则会看到两段拼在一起
  assert.equal(retries[0].partial.content, '半截')
})

test('重试次数用尽后抛出最后一次的错误', async () => {
  let calls = 0
  await assert.rejects(streamChatOnce({
    model, messages: [], maxRetries: 3, sleepFn: async () => {},
    fetchFn: async () => { calls++; return response([event({ choices: [{ delta: { content: 'x' } }] })]) },
  }), /中断/)
  assert.equal(calls, 4, '首次 + 3 次重试')
})

test('4xx（重试也没用）不重试，网关原话照传', async () => {
  let calls = 0
  await assert.rejects(streamChatOnce({
    model, messages: [], sleepFn: async () => {},
    fetchFn: async () => { calls++; return new Response('{"error":{"message":"invalid api key"}}', { status: 401 }) },
  }), /HTTP 401/)
  assert.equal(calls, 1, '401 重试十次还是 401，不该白烧十次请求')
})

test('用户点了停止就不再重试', async () => {
  const controller = new AbortController()
  let attempts = 0
  const hanging = async (_url, { signal }) => {
    attempts++
    return new Promise((_, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
  }
  // 超时→正要重试的那一刻用户按了停止（onRetry 里 abort，最贴近真实时序）
  const result = await streamChatOnce({
    model, messages: [], fetchFn: hanging, signal: controller.signal,
    idleTimeoutMs: 10, sleepFn: async () => { controller.abort() },
    onRetry: () => { controller.abort() },
  })
  assert.equal(result.aborted, true)
  assert.equal(attempts, 1, '中止后不该再发第二次请求')
})

const call = n => ({ id: `call${n}`, type: 'function', function: { name: 'read_file', arguments: '{}' } })
const askCall = (id = 'ask1') => ({ id, type: 'function', function: {
  name: 'ask_user',
  arguments: JSON.stringify({ question: 'Which option?', options: ['A', 'B'], allow_free_text: false }),
} })
const strings = { waiting: '', toolRunning: x => x, toolIterLimit: n => String(n), llmError: x => x, emptyResponse: 'empty' }
const noop = () => {}
const quiet = { startSpinner: () => ({ stop: noop }), createAssistantWriter: () => ({ writeContent: noop, writeThinking: noop, finish: noop }),
  printToolHeader: noop, printToolResult: noop, printWarn: noop, printError: noop, printTurnSummary: noop }
const state = () => ({ messages: [{ role: 'system', content: 'rules' }], ctx: { cwd: '.' }, abortController: new AbortController(), maxToolIterations: 4 })

test('turn shows 12 nonblank preview rows, supports full/off, and keeps all reasoning in history', async () => {
  const reasoning = Array.from({ length: 15 }, (_, i) => `Inspection step ${i + 1}.`).join('\n\n')
  for (const mode of ['compact', 'full', 'off']) {
    const s = { ...state(), thinkingMode: mode, showThinking: mode !== 'off' }
    let output = ''
    const stats = await runAgentTurn(s, 'task', strings, [], {
      ui: { ...quiet, createAssistantWriter: options => createAssistantWriter({ ...options, write: text => { output += text } }) },
      chat: async ({ onToken }) => {
        for (const chunk of reasoning) onToken({ thinking: chunk })
        onToken({ content: 'Final answer.' })
        return { content: 'Final answer.', reasoning, toolCalls: [] }
      },
    })
    assert.equal(stats.status, 'completed')
    assert.equal(s.messages.at(-1).reasoning_content, reasoning)
    const text = stripAnsi(output)
    assert.match(text, /Final answer/)
    if (mode === 'compact') {
      assert.match(text, /Inspection step 12\./)
      assert.doesNotMatch(text, /Inspection step 13\./)
      assert.match(text, /\/think full/)
    } else if (mode === 'full') {
      assert.match(text, /Inspection step 15\./)
      assert.doesNotMatch(text, /\/think full/)
    } else assert.doesNotMatch(text, /Inspection step/)
  }
})

test('turn aggregates all model calls, persists progress and records response timings', async () => {
  const s = state()
  let requests = 0, saves = 0
  s.persistSession = async () => { saves++ }
  const stats = await runAgentTurn(s, 'task', strings, [], { ui: quiet, execute: async () => 'file contents', chat: async ({ onToken }) => {
    requests++
    onToken({ content: requests === 1 ? 'checking\n' : 'answer\n' })
    return { content: requests === 1 ? 'checking' : 'answer', toolCalls: requests === 1 ? [call(1)] : [], usage: normalizeUsage({ prompt_tokens: 10, completion_tokens: 2 }) }
  } })
  assert.equal(stats.status, 'completed')
  assert.equal(stats.requests, 2)
  assert.equal(stats.toolCalls, 1)
  assert.equal(stats.usage.totalTokens, 24)
  assert.equal(stats.usageRequests, 2)
  assert.ok(stats.firstTokenMs >= 0)
  assert.ok(stats.firstAnswerMs >= stats.firstTokenMs)
  assert.ok(stats.totalMs >= stats.llmMs + stats.toolsMs)
  assert.ok(saves >= 4)
  assert.equal(s.sessionStats.usage.totalTokens, 24)
})

test('ask_user pauses a turn until the answer arrives, then continues the model loop', async () => {
  const s = state()
  let resolveAnswer
  let asked
  s.ctx.askUser = args => {
    asked = args
    return new Promise(resolve => { resolveAnswer = resolve })
  }
  let round = 0
  const turnPromise = runAgentTurn(s, 'task', strings, [], {
    ui: quiet,
    chat: async () => (++round === 1
      ? { content: '', toolCalls: [askCall()] }
      : { content: 'finished', toolCalls: [] }),
  })

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(asked, { question: 'Which option?', options: ['A', 'B'], allowFreeText: false, multiple: false })
  assert.equal(round, 1)
  resolveAnswer('B')

  const stats = await turnPromise
  assert.equal(stats.status, 'completed')
  assert.equal(round, 2)
  assert.equal(s.messages.at(-1).content, 'finished')
  assert.equal(s.messages.find(message => message.role === 'tool').content, 'B')
})

test('cancellation during a tool skips the remaining batch and keeps valid tool history', async () => {
  const s = state(), executed = []
  const stats = await runAgentTurn(s, 'task', strings, [], { ui: quiet,
    chat: async () => ({ content: '', toolCalls: [call(1), call(2)] }),
    execute: async name => { executed.push(name); s.abortController.abort(); return 'first result' },
  })
  assert.equal(stats.status, 'cancelled')
  assert.equal(executed.length, 1)
  assert.equal(s.messages.filter(m => m.role === 'tool').length, 2)
  assert.match(s.messages.at(-1).content, /not executed/)
})

test('failed turns retain the user request and report partial usage honestly', async () => {
  const s = state()
  let requests = 0
  const stats = await runAgentTurn(s, 'keep my task', strings, [], { ui: quiet, execute: async () => 'ok', chat: async () => {
    if (++requests === 2) throw new Error('offline')
    return { content: '', toolCalls: [call(1)], usage: normalizeUsage({ prompt_tokens: 1, completion_tokens: 1 }) }
  } })
  assert.equal(stats.status, 'failed')
  assert.equal(stats.requests, 2)
  assert.equal(stats.usageRequests, 1)
  assert.ok(s.messages.some(m => m.content === 'keep my task'))
})

test('long tool turns have bounded request history without losing original goals or mutating the transcript', () => {
  // 200 组 × 6000 字符（clip 后）≈ 240 万字符，远超默认预算 —— 数据量必须跟着
  // 默认预算走：60 组在 400k 预算下压根不触发裁剪，断言会假绿（见 context.test.js 同名注释）。
  const messages = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'original goal' }]
  for (let i = 0; i < 200; i++) messages.push({ role: 'assistant', tool_calls: [call(i)] }, { role: 'tool', tool_call_id: `call${i}`, content: 'data'.repeat(4000) })
  const before = structuredClone(messages)
  const budget = resolveRequestBudget(undefined)
  const compact = buildRequestMessages(messages)
  assert.ok(compact.length <= budget.maxMessages, `期望 <= ${budget.maxMessages} 条,实际 ${compact.length}`)
  assert.ok(JSON.stringify(compact).length < budget.maxChars * 1.1)
  assert.ok(compact.some(m => m.content === 'original goal'))
  assert.deepEqual(messages, before)
  for (let i = 0; i < compact.length; i++) {
    if (compact[i].tool_calls) assert.equal(compact[i + 1].tool_call_id, compact[i].tool_calls[0].id)
  }
})

test('resume marks missing tool results without replaying actions', () => {
  const repaired = repairToolHistory([{ role: 'user', content: 'task' }, { role: 'assistant', tool_calls: [call(1), call(2)] },
    { role: 'tool', tool_call_id: 'call1', content: 'saved' }])
  assert.equal(repaired[2].content, 'saved')
  assert.equal(repaired[3].tool_call_id, 'call2')
  assert.match(repaired[3].content, /status is unknown/)
})

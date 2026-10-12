// Web 端扩展层（Skill + MCP）接入 runAgentTurn 的回归测试。
//
// 钉住的行为（2026-10-12 修的问题）：MCP 广场显示"已安装"，但 Web 智能体
// 对话/定时任务的工具列表里就是没有那些工具 —— AgentExtensions.load 原先
// 只有 CLI 的 g ai 调。现在 Web 侧也加载，这里跑真实的 runAgentTurn，
// 把请求体与事件抓下来逐条钉住：
//   1) MCP 工具定义随请求下发（mcp__ 前缀），系统提示词出现 MCP 一节；
//   2) mcp__ 调用分流到 MCP server，内置工具照常走 executeTool；
//   3) 连接失败只降级（该 server 没工具），轮次照常完成；
//   4) 同一 cwd 只握手一次（进程内缓存），invalidate 后按新配置重载；
//   5) 广场安装路由走完，下一轮对话就吃得到（不等 g gui 重启）；
//   6) 扩展摘要只进请求副本，不腌进 session.messages（老会话也吃得到）。
//
// 注意:必须在 import agentChat.js **之前**把 USERPROFILE/HOME 指到沙箱,否则
// paths.js 在模块加载时用 os.homedir() 求值,会去读真实的 ~/.zen-gitsync。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'zen-agent-ext-'))
process.env.USERPROFILE = SANDBOX
process.env.HOME = SANDBOX
delete process.env.HOMEDRIVE
delete process.HOMEPATH

const DATA_DIR = path.join(SANDBOX, '.zen-gitsync')
const MCP_FILE = path.join(DATA_DIR, 'ai', 'mcp.json')

// ── 脚手架 ────────────────────────────────────────────────────

const event = data => `data: ${JSON.stringify(data)}\n\n`
const sse = chunks => new Response(new ReadableStream({
  start(controller) {
    const bytes = new TextEncoder()
    chunks.forEach(chunk => controller.enqueue(bytes.encode(chunk)))
    controller.close()
  },
}), { status: 200, headers: { 'content-type': 'text/event-stream' } })

const model = { model: 'test', name: 'test', baseURL: 'https://example.invalid/v1', apiKey: 'test' }
const okStream = () => sse([event({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }), 'data: [DONE]\n\n'])
const withSystem = () => [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }]
const newSession = (sessionId, messages) => ({ sessionId, messages, cwd: process.cwd() })

// 跑一轮真实的 runAgentTurn,桩掉 globalThis.fetch —— 抓住发出去的请求体与事件。
// ⚠️ MCP 的连接也走 globalThis.fetch（HttpConnection），所以这个桩按 URL 分流：
// 打 127.0.0.1 的（桩 server）放真 fetch 过去，其余（LLM）抓请求体 + 回灌 SSE。
async function runWeb({ session, userMessage, respond }) {
  const { runAgentTurn } = await import('./agentChat.js')
  const { streamChatOnce } = await import('../../../../cli/ai/transport.js')
  const events = []
  let sent
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, init)
    sent = JSON.parse(init.body)
    return respond(init)
  }
  try {
    await runAgentTurn({
      session, model, userMessage, locale: 'zh-CN', cwd: process.cwd(),
      signal: new AbortController().signal,
      send: e => events.push(e),
      streamFn: opts => streamChatOnce({ ...opts, maxRetries: 0 }),
    })
    return { sent, events }
  } finally {
    globalThis.fetch = realFetch
  }
}

// 最小 Streamable HTTP MCP server 桩：initialize / tools/list / tools/call。
// 每个响应都带 Mcp-Session-Id，顺带覆盖 HttpConnection 的会话关闭（DELETE）路径。
function startStubMcp({ onHandshake, onCall, onClose } = {}) {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      if (req.method === 'DELETE') {
        onClose?.()
        res.writeHead(204)
        res.end()
        return
      }
      let msg = {}
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* 通知类可能没体 */ }
      const reply = result => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'mcp-session-id': `sess-${Math.random().toString(36).slice(2, 8)}`,
        })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result }))
      }
      if (msg.method === 'initialize') {
        onHandshake?.()
        reply({ protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'stub', version: '0' } })
      } else if (msg.method === 'tools/list') {
        reply({ tools: [{ name: 'echo', description: '回声工具', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] })
      } else if (msg.method === 'tools/call') {
        onCall?.(msg.params)
        reply({ content: [{ type: 'text', text: `stub 收到: ${msg.params?.arguments?.text ?? ''}` }] })
      } else {
        reply({}) // notifications/initialized 等
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/api/mcp`,
      close: () => new Promise(r => server.close(r)),
    }))
  })
}

function writeMcpFile(url) {
  mkdirSync(path.dirname(MCP_FILE), { recursive: true })
  writeFileSync(MCP_FILE, JSON.stringify({ mcpServers: { stub: { name: 'Stub', type: 'http', url } } }, null, 2))
}

const hasMcpTools = sent => sent.tools.some(t => String(t.function?.name || '').startsWith('mcp__'))

// 每个用例开工前清一遍：上一条用例的 finally 也该清，双保险 ——
// 缓存是模块级的，残留一份配置会让下一条用例莫名其妙吃到 MCP。
async function resetExtensions() {
  rmSync(MCP_FILE, { force: true })
  const { invalidateWebExtensions } = await import('./agentExtensions.js')
  await invalidateWebExtensions()
}

// ── 挂载与分发 ────────────────────────────────────────────────

test('MCP 工具挂进请求、按 mcp__ 名字分发到 server，内置工具不受影响', async () => {
  let handshakes = 0
  const stub = await startStubMcp({ onHandshake: () => handshakes++ })
  try {
    await resetExtensions()
    writeMcpFile(stub.url)

    // 第一轮：模型同时调一个 MCP 工具和一个内置工具 —— 分流是否正确一轮就看出来
    const round1 = sse([event({
      choices: [{
        delta: { tool_calls: [
          { index: 0, id: 'm1', function: { name: 'mcp__stub__echo', arguments: JSON.stringify({ text: '你好' }) } },
          { index: 1, id: 'p1', function: { name: 'update_plan', arguments: JSON.stringify({ steps: [{ content: '一步', status: 'completed' }] }) } },
        ] },
        finish_reason: 'tool_calls',
      }],
    }), 'data: [DONE]\n\n'])
    let turn = 0
    const session = newSession('ag-ext-dispatch', withSystem())

    const { sent, events } = await runWeb({
      session, userMessage: '调用 mcp', respond: () => (turn++ === 0 ? round1 : okStream()),
    })

    // ① 请求里带着 MCP 工具定义（transport 把 extraTools 并进 tools）
    const mcpTool = sent.tools.find(t => t.function?.name === 'mcp__stub__echo')
    assert.ok(mcpTool, 'MCP 工具必须随请求下发')
    assert.match(mcpTool.function.description, /回声/)
    assert.equal(mcpTool.type, 'function')
    // 内置工具一个没少
    assert.ok(sent.tools.some(t => t.function?.name === 'update_plan'), '内置工具表必须还在')
    // ② 系统提示词里出现 MCP 一节，且点名 mcp__ 前缀
    assert.match(sent.messages[0].content, /已接入的 MCP 服务/)
    assert.match(sent.messages[0].content, /mcp__/)
    // ③ MCP 调用真的走到了 stub server
    assert.equal(handshakes, 1)
    const mcpResult = events.find(e => e.type === 'tool_result' && e.name === 'mcp__stub__echo')
    assert.ok(mcpResult, 'MCP 调用必须产出 tool_result')
    assert.match(mcpResult.result, /stub 收到: 你好/)
    // ④ 同一轮里的内置工具照常执行（分流没有把内置的也吞掉）
    const planResult = events.find(e => e.type === 'tool_result' && e.name === 'update_plan')
    assert.match(planResult.result, /计划已更新/)
    // ⑤ 两个结果都进了会话历史（重开会话能回放）
    const toolNames = session.messages.filter(m => m.role === 'tool').map(m => m.name)
    assert.deepEqual(toolNames, ['mcp__stub__echo', 'update_plan'])
    // ⑥ 摘要只进请求副本，不写回 session.messages
    assert.equal(session.messages[0].content, 'rules', '扩展摘要不该腌进磁盘历史')
  } finally {
    await resetExtensions()
    await stub.close()
  }
})

// ── 降级 ──────────────────────────────────────────────────────

test('MCP 连接失败只降级：轮次照常完成，请求里不带 MCP 工具', async () => {
  // 占一个端口再松开，拿一个一定没人听的地址
  const stub = await startStubMcp()
  const deadUrl = stub.url
  await stub.close()
  try {
    await resetExtensions()
    writeMcpFile(deadUrl)
    const session = newSession('ag-ext-dead', withSystem())

    const { sent, events } = await runWeb({ session, userMessage: 'hello', respond: okStream })

    assert.ok(!events.some(e => e.type === 'error'), '连接失败不该把轮次打挂')
    assert.equal(hasMcpTools(sent), false, '连不上的 server 不该贡献工具定义')
    assert.doesNotMatch(sent.messages[0].content, /已接入的 MCP 服务/)
    assert.equal(session.messages[session.messages.length - 1].content, 'ok', '轮次要正常收尾')
  } finally {
    await resetExtensions()
  }
})

// ── 缓存与失效 ────────────────────────────────────────────────

test('同 cwd 只握手一次（进程内缓存），invalidate 后按新配置重新加载', async () => {
  let handshakes = 0
  let deletes = 0
  const stub = await startStubMcp({ onHandshake: () => handshakes++, onClose: () => deletes++ })
  try {
    await resetExtensions()
    // 没配 MCP：第一轮不该有 mcp 工具，也不该发生握手
    const s1 = newSession('ag-ext-cache-1', withSystem())
    const r1 = await runWeb({ session: s1, userMessage: 'hello', respond: okStream })
    assert.equal(handshakes, 0)
    assert.equal(hasMcpTools(r1.sent), false)

    // 模拟"广场装完"：写配置 + 失效（这一路正是 agentMarketplace.js 调的）
    writeMcpFile(stub.url)
    const { invalidateWebExtensions } = await import('./agentExtensions.js')
    await invalidateWebExtensions()

    // 第二轮：立刻吃得到，不等重启
    const s2 = newSession('ag-ext-cache-2', withSystem())
    const r2 = await runWeb({ session: s2, userMessage: 'hello', respond: okStream })
    assert.equal(handshakes, 1, '失效后必须重新加载')
    assert.equal(hasMcpTools(r2.sent), true)
    assert.match(r2.sent.messages[0].content, /已接入的 MCP 服务/)

    // 第三轮：同一 cwd 走缓存，不再握手
    const s3 = newSession('ag-ext-cache-3', withSystem())
    const r3 = await runWeb({ session: s3, userMessage: 'hello', respond: okStream })
    assert.equal(handshakes, 1, '缓存生效时不能反复握手')
    assert.equal(hasMcpTools(r3.sent), true)

    // 失效时旧连接要真的关掉（HTTP 侧表现为 DELETE 到过 server）
    await invalidateWebExtensions()
    assert.ok(deletes >= 1, 'invalidate 必须关闭旧连接（DELETE 结束会话）')
  } finally {
    await resetExtensions()
    await stub.close()
  }
})

// ── 广场安装路由 → 对话生效（端到端） ───────────────────────────

test('广场安装路由走完后，下一轮对话就挂上该 MCP（不等 g gui 重启）', async () => {
  let handshakes = 0
  const stub = await startStubMcp({ onHandshake: () => handshakes++ })
  try {
    await resetExtensions()
    const s1 = newSession('ag-ext-mp-1', withSystem())
    const r1 = await runWeb({ session: s1, userMessage: 'hello', respond: okStream })
    assert.equal(hasMcpTools(r1.sent), false)

    // 走真实的注册路由（harness 抄自 agentMarketplace.test.js 的打法）：
    // 远程端点型 MCP 只写配置文件，不联网
    const { registerAgentMarketplaceRoutes } = await import('./agentMarketplace.js')
    const handlers = new Map()
    const app = {
      get: (r, h) => handlers.set(`GET ${r}`, h),
      post: (r, h) => handlers.set(`POST ${r}`, h),
      delete: (r, h) => handlers.set(`DELETE ${r}`, h),
    }
    registerAgentMarketplaceRoutes({ app, getCurrentProjectPath: () => process.cwd() })
    let payload = null
    const res = { status() { return this }, json(data) { payload = data; return this } }
    await handlers.get('POST /api/agent/marketplace/install')({
      body: { type: 'mcp', target: 'global', cwd: process.cwd(), item: { id: 'stub', name: 'Stub', remoteUrl: stub.url } },
    }, res)
    assert.equal(payload?.success, true, '安装路由要报成功')
    assert.ok(payload?.item?.file, '安装结果要带回落盘路径')

    // 下一轮对话：工具表里必须有它，且握手真的发生过
    const s2 = newSession('ag-ext-mp-2', withSystem())
    const r2 = await runWeb({ session: s2, userMessage: 'hello', respond: okStream })
    assert.equal(handshakes, 1)
    assert.equal(hasMcpTools(r2.sent), true, '广场装完必须立刻在对话里生效')
  } finally {
    await resetExtensions()
    await stub.close()
  }
})

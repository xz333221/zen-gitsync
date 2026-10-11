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
// MCP 协议内核（src/mcp/server.js）与通用工具（src/mcp/util.js）的单元测试。
//
// 范围刻意收窄在**纯函数层**：
//   · server.js 只依赖 node:module，没有文件系统副作用 —— 可以直接 import 真跑；
//   · util.js 同理。
// 数据读取（各板块工具）与两条传输的端到端验证在 scripts/verify-mcp-server.cjs，
// 因为那些要造一个沙箱 HOME —— 而 src/paths.js 在**模块加载时**求值 os.homedir()，
// 环境变量必须早于 import 生效，那是脚本能做的事、单元测试做不到（import 会被提升）。
//   → 完整验证：npm run verify:mcp
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createMcpServer, SERVER_NAME } from './server.js'
import {
  asBool,
  asInt,
  asString,
  canonicalProjectPath,
  formatSize,
  isPidAlive,
  projectNameOf,
  truncate,
} from './util.js'

// ── 测试替身 ──────────────────────────────────────────────────
const echoTool = {
  name: 'echo',
  description: '把传入的值原样返回',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  handler: args => ({ value: args?.value ?? null }),
}
const stringTool = {
  name: 'plain_text',
  description: '返回一段纯文本',
  inputSchema: { type: 'object', properties: {} },
  handler: () => '纯文本结果',
}
const boomTool = {
  name: 'boom',
  description: '总是抛异常',
  inputSchema: { type: 'object', properties: {} },
  handler: () => { throw new Error('BOOM') },
}

function makeServer(tools = [echoTool, stringTool, boomTool]) {
  return createMcpServer({ tools, ctx: { cwd: 'C:\\proj' } })
}

const init = (server, params = { protocolVersion: '2025-03-26' }) => server.handleMessage({
  jsonrpc: '2.0', id: 1, method: 'initialize', params,
})
const list = server => server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
const call = (server, name, args) => server.handleMessage({
  jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args },
})

// ── 握手 ──────────────────────────────────────────────────────
test('initialize: 回客户端报的协议版本 + tools 能力 + serverInfo', async () => {
  const res = await init(makeServer(), { protocolVersion: '2024-11-05', clientInfo: { name: 'probe' } })
  assert.equal(res.jsonrpc, '2.0')
  assert.equal(res.id, 1)
  assert.equal(res.result.protocolVersion, '2024-11-05')
  assert.deepEqual(res.result.capabilities.tools, { listChanged: false })
  assert.equal(res.result.serverInfo.name, SERVER_NAME)
  assert.match(res.result.serverInfo.version, /^\d+\.\d+\.\d+/)
  assert.ok(res.result.instructions.includes('workspace_overview'), 'instructions 里该点名入口工具')
})

test('initialize: 未知协议版本回落到我们支持的版本，不原样回一个假版本', async () => {
  const res = await init(makeServer(), { protocolVersion: '1999-01-01' })
  assert.notEqual(res.result.protocolVersion, '1999-01-01')
  assert.match(res.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/)
})

test('initialize: 缺 protocolVersion 时也有一个合法版本', async () => {
  const res = await init(makeServer(), {})
  assert.match(res.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/)
})

// ── 通知 ─────────────────────────────────────────────────────
test('通知（无 id）绝不产生响应 —— 回了会被客户端当成孤儿响应', async () => {
  const server = makeServer()
  for (const method of ['notifications/initialized', 'notifications/cancelled']) {
    assert.equal(await server.handleMessage({ jsonrpc: '2.0', method }), null, `${method} 不该有响应`)
  }
  // id 为 null 也按通知处理（JSON-RPC 2.0 的约定）
  assert.equal(await server.handleMessage({ jsonrpc: '2.0', id: null, method: 'ping' }), null)
})

// ── tools/list ────────────────────────────────────────────────
test('tools/list: 每个工具都带 name/description/inputSchema', async () => {
  const res = await list(makeServer())
  assert.equal(res.result.tools.length, 3)
  const echo = res.result.tools.find(t => t.name === 'echo')
  assert.equal(echo.description, echoTool.description)
  assert.equal(echo.inputSchema.type, 'object')
})

test('tools/list: 形状不合法的条目被丢掉，而不是让整个列表崩掉', async () => {
  const res = await list(makeServer([
    echoTool,
    { name: 'no_handler' },                       // 缺 handler
    { description: '没有名字', handler: () => 1 }, // 缺 name
    null,
  ]))
  assert.deepEqual(res.result.tools.map(t => t.name), ['echo'])
})

test('tools/list: 工具没给 inputSchema 时补一个空 object schema', async () => {
  const res = await list(makeServer([{ name: 'bare', description: '无 schema', handler: () => 1 }]))
  assert.deepEqual(res.result.tools[0].inputSchema, { type: 'object', properties: {} })
})

// ── tools/call ────────────────────────────────────────────────
test('tools/call: 对象结果被序列化成 text content', async () => {
  const res = await call(makeServer(), 'echo', { value: 'hi' })
  assert.equal(res.result.isError, undefined)
  assert.equal(res.result.content.length, 1)
  assert.equal(res.result.content[0].type, 'text')
  assert.deepEqual(JSON.parse(res.result.content[0].text), { value: 'hi' })
})

test('tools/call: 字符串结果原样进 text content，不再套一层 JSON', async () => {
  const res = await call(makeServer(), 'plain_text')
  assert.equal(res.result.content[0].text, '纯文本结果')
})

test('tools/call: 缺 params.name → -32602（这是客户端用错了协议）', async () => {
  const res = await makeServer().handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: {} })
  assert.equal(res.error.code, -32602)
})

test('tools/call: 调不存在的工具 → isError + 可用工具清单（让模型能自我纠正）', async () => {
  const res = await call(makeServer(), 'nope')
  assert.equal(res.error, undefined, '不该是 JSON-RPC error')
  assert.equal(res.result.isError, true)
  assert.match(res.result.content[0].text, /echo/)
})

test('tools/call: handler 抛异常 → 转成 isError 并带上原因，不中断协议', async () => {
  const res = await call(makeServer(), 'boom')
  assert.equal(res.error, undefined)
  assert.equal(res.result.isError, true)
  assert.match(res.result.content[0].text, /BOOM/)
})

test('tools/call: 异步 handler 也被 await（结果不是 Promise 的字符串化）', async () => {
  const server = makeServer([{
    name: 'slow', description: '异步', inputSchema: { type: 'object', properties: {} },
    handler: async () => { await new Promise(r => setTimeout(r, 5)); return { done: true } },
  }])
  const res = await call(server, 'slow')
  assert.deepEqual(JSON.parse(res.result.content[0].text), { done: true })
})

test('tools/call: handler 返回 undefined → 给一句占位，而不是空 content（空 content 会被判非法）', async () => {
  const server = makeServer([{ name: 'nothing', description: '无返回', inputSchema: { type: 'object', properties: {} }, handler: () => undefined }])
  const res = await call(server, 'nothing')
  assert.ok(res.result.content[0].text.length > 0)
})

// ── 其它方法 ─────────────────────────────────────────────────
test('ping → 空对象（规范要求的方法，别回 -32601）', async () => {
  const res = await makeServer().handleMessage({ jsonrpc: '2.0', id: 7, method: 'ping' })
  assert.deepEqual(res.result, {})
})

test('resources/prompts 三个 list 方法回空数组而不是错误 —— 声明了不支持会让某些客户端一直等', async () => {
  const server = makeServer()
  for (const method of ['resources/list', 'resources/templates/list', 'prompts/list']) {
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 8, method })
    assert.equal(res.error, undefined, `${method} 不该报错`)
    const values = Object.values(res.result)
    assert.equal(values.length, 1)
    assert.deepEqual(values[0], [])
  }
})

test('未知方法 → -32601', async () => {
  const res = await makeServer().handleMessage({ jsonrpc: '2.0', id: 8, method: 'no/such' })
  assert.equal(res.error.code, -32601)
})

test('非法消息（null / 数组 / 字符串）→ -32600 且 id 为 null', async () => {
  const server = makeServer()
  for (const bad of [null, 'x', 42, []]) {
    const res = await server.handleMessage(bad)
    assert.equal(res.error.code, -32600, `${JSON.stringify(bad)} 应回 -32600`)
    assert.equal(res.id, null)
  }
})

test('暴露 toolNames / listTools 给诊断用', async () => {
  const server = makeServer()
  assert.deepEqual(server.toolNames, ['echo', 'plain_text', 'boom'])
  assert.deepEqual(server.listTools().map(t => t.name), server.toolNames)
  assert.equal(server.serverInfo.name, SERVER_NAME)
})

// ── util ─────────────────────────────────────────────────────
test('canonicalProjectPath: Windows 形式转小写 + 反斜杠归一，POSIX 原样', async () => {
  // 与 workbench/projectRegistry.js 的 canonicalProjectPath 同口径
  assert.equal(canonicalProjectPath('D:/ws/Proj'), 'd:\\ws\\proj')
  assert.equal(canonicalProjectPath('D:\\ws\\Proj'), 'd:\\ws\\proj')
  assert.equal(canonicalProjectPath('c:/Users/xuze3'), 'c:\\users\\xuze3')
  assert.equal(canonicalProjectPath('/home/me/Proj'), '/home/me/Proj')
  assert.equal(canonicalProjectPath(''), '')
  // 两种写法必须归到同一个 key —— 否则同一目录会在看板里裂成两条
  assert.equal(canonicalProjectPath('D:/ws/proj'), canonicalProjectPath('D:\\WS\\Proj'))
})

test('projectNameOf: 取末段；盘符根目录保留盘符；去尾斜杠', async () => {
  assert.equal(projectNameOf('D:\\ws\\proj'), 'proj')
  assert.equal(projectNameOf('D:\\ws\\proj\\'), 'proj')
  assert.equal(projectNameOf('/home/me/proj/'), 'proj')
  assert.equal(projectNameOf('D:\\'), 'D:')
  assert.equal(projectNameOf(''), '')
})

test('asInt: 认不出来的回落，认出来但越界的夹取', async () => {
  assert.equal(asInt(undefined, 10), 10)
  assert.equal(asInt('abc', 10), 10)
  assert.equal(asInt(NaN, 10), 10)
  assert.equal(asInt(Infinity, 10), 10)
  assert.equal(asInt('7', 10), 7)
  assert.equal(asInt(7.9, 10), 7, '取整而不是四舍五入')
  // 越界夹取 —— 挡住 limit: 1e9 这种会把上下文撑爆的值
  assert.equal(asInt(9999, 10, { max: 100 }), 100)
  assert.equal(asInt(0, 10, { min: 1 }), 1)
  assert.equal(asInt(-5, 10, { min: 1, max: 100 }), 1)
  // min 为 0 是合法用法（如 output_chars_per_job: 0 = 不带输出），不能被当成非法
  assert.equal(asInt(0, 1500, { min: 0, max: 8000 }), 0)
  // fallback 自己也过一遍夹取，免得调用方写的默认值越界后偷偷生效
  assert.equal(asInt('abc', 99999, { max: 100 }), 100)
})

test('asBool: 只有显式 false 才算 false（与 tools.js 的 auto_run 口径一致）', async () => {
  assert.equal(asBool(undefined, true), true, '省略 = 跟随默认')
  assert.equal(asBool(null, true), true)
  assert.equal(asBool(false, true), false)
  assert.equal(asBool('false', true), false)
  assert.equal(asBool('no', true), false)
  assert.equal(asBool('0', true), false)
  assert.equal(asBool(true, false), true)
  assert.equal(asBool('yes', false), true)
  assert.equal(asBool('随便别的字', true), true, '认不出来就回落')
})

test('asString: trim 后为空则用 fallback', async () => {
  assert.equal(asString('  x  '), 'x')
  assert.equal(asString('   ', 'fb'), 'fb')
  assert.equal(asString(null, 'fb'), 'fb')
  assert.equal(asString(0), '0', '0 是有效值，不该被当成空')
})

test('truncate: 短的原文返回，长的截断并报出截了多少', async () => {
  assert.equal(truncate('abc', 10), 'abc')
  const long = 'x'.repeat(100)
  const out = truncate(long, 50, 30)
  assert.ok(out.startsWith('x'.repeat(30)))
  assert.match(out, /已截断 70 字符/)
})

test('isPidAlive: 自己的 pid 活着，明显不存在的 pid 为假', async () => {
  assert.equal(isPidAlive(process.pid), true)
  assert.equal(isPidAlive(-1), false)
  assert.equal(isPidAlive(0), false)
  assert.equal(isPidAlive('abc'), false)
  assert.equal(isPidAlive(undefined), false)
})

test('formatSize: 按量级换单位', async () => {
  assert.equal(formatSize(512), '512 B')
  assert.equal(formatSize(2048), '2.0 KB')
  assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB')
  assert.equal(formatSize(-1), '')
  assert.equal(formatSize('abc'), '')
})

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

// TEST-4 回归测试:Socket.IO 关键事件通路
//
// 策略:用 EventEmitter mock io + 注入依赖(不真起 Socket.IO 服务器),
// 验证 registerUiSocketHandlers 的核心契约:
//   1. connection → join project room + emit initial_command_history
//   2. request_full_history → emit full_command_history(回退路径,前端可重拉)
//   3. clear_command_history → 调用注入的 clearCommandHistory + emit command_history_cleared
//   4. exec_interactive 空 command 校验:不调 spawn,直接 emit interactive_error
//   5. exec_interactive 正常 command:spawn 子进程,stdout 流到 socket,
//      close 时 emit interactive_exit + 写入命令历史
//
// 注意:本测试不覆盖 SEC-INJ-1(shell:true 注入),那是独立 PR 的内容;
// 本测试只保证现有契约不被回归。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

const handlerMod = await import(pathToFileURL(path.join(projectRoot, 'src/ui/server/socket/registerUiSocketHandlers.js')).href)
const { registerUiSocketHandlers } = handlerMod

// ========== Mock 工厂 ==========

/** 构造一个 mock socket:EventEmitter + emits 记录数组 + 简易 join */
function makeMockSocket(id) {
  const emitted = []
  const socket = new EventEmitter()
  socket.id = id
  socket.rooms = new Set()
  // 转发给 EventEmitter(让 listeners 触发)+ 同步记录到 emitted 数组
  socket.emit = (event, payload) => {
    emitted.push({ event, payload })
    return EventEmitter.prototype.emit.call(socket, event, payload)
  }
  socket.join = (room) => {
    socket.rooms.add(room)
    return Promise.resolve()
  }
  return { socket, emitted }
}

/** 构造一个 mock io:on('connection', cb) 触发注册的 socket,返回连接触发函数 */
function makeMockIo() {
  let connectionHandler = null
  const io = new EventEmitter()
  io.on = (event, cb) => {
    if (event === 'connection') connectionHandler = cb
    return io
  }
  return {
    io,
    /** 模拟一个新客户端连接 */
    triggerConnection(socket) {
      assert.ok(connectionHandler, 'registerUiSocketHandlers 必须 io.on("connection", ...) 注册')
      connectionHandler(socket)
      return socket
    }
  }
}

/** 构造一个 fake spawn,返回一个 EventEmitter 模拟 child_process */
function makeFakeSpawn() {
  const spawnMock = () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = { destroyed: false, write: () => true }
    child.killed = false
    child.kill = (sig) => { child.killed = true; child.emit('close', null, sig || 'SIGTERM') }
    child.pid = 12345 + Math.floor(Math.random() * 1000)
    return child
  }
  return spawnMock
}

/** 简单的 iconv mock:任何编码都返回字符串(不真正转码) */
function makeMockIconv() {
  return {
    decode: (buf, enc) => {
      if (Buffer.isBuffer(buf)) return buf.toString('utf8')
      if (typeof buf === 'string') return buf
      return String(buf)
    }
  }
}

// ========== Test: connection lifecycle ==========

test('registerUiSocketHandlers: connection 时 join project room + emit initial_command_history', () => {
  const { io, triggerConnection } = makeMockIo()
  const { socket, emitted } = makeMockSocket('client-1')
  const getProjectRoomId = () => 'project-room-abc'
  const getCurrentProjectPath = () => '/fake/repo'
  let statusCalled = false
  const getAndBroadcastStatus = () => { statusCalled = true }
  const historyData = [{ command: 'git status', stdout: 'clean', success: true }]
  const getCommandHistory = () => historyData
  const clearCommandHistory = () => true
  const addCommandToHistory = () => {}
  const runningProcesses = new Map()
  let pidCounter = 0
  const nextProcessId = () => ++pidCounter

  registerUiSocketHandlers({
    io,
    getProjectRoomId,
    getCurrentProjectPath,
    getAndBroadcastStatus,
    getCommandHistory,
    clearCommandHistory,
    addCommandToHistory,
    runningProcesses,
    nextProcessId,
    spawn: makeFakeSpawn(),
    exec: () => {},
    path: path,
    iconv: makeMockIconv()
  })

  triggerConnection(socket)

  // 断言
  assert.ok(socket.rooms.has('project-room-abc'), 'socket 应加入 project room')
  assert.equal(statusCalled, true, '应调用 getAndBroadcastStatus 推送状态')
  const initialEvent = emitted.find(e => e.event === 'initial_command_history')
  assert.ok(initialEvent, '应 emit initial_command_history')
  assert.deepEqual(initialEvent.payload.history, historyData)
})

// ========== Test: request_full_history ==========

test('registerUiSocketHandlers: request_full_history 回退路径', () => {
  const { io, triggerConnection } = makeMockIo()
  const { socket, emitted } = makeMockSocket('client-2')
  const historyRef = [{ command: 'git log', stdout: 'a\nb\n', success: true }]
  let called = 0
  const getCommandHistory = () => { called++; return historyRef }

  registerUiSocketHandlers({
    io,
    getProjectRoomId: () => 'r',
    getCurrentProjectPath: () => '/',
    getAndBroadcastStatus: () => {},
    getCommandHistory,
    clearCommandHistory: () => true,
    addCommandToHistory: () => {},
    runningProcesses: new Map(),
    nextProcessId: () => ++called,
    spawn: makeFakeSpawn(),
    exec: () => {},
    path,
    iconv: makeMockIconv()
  })

  triggerConnection(socket)
  emitted.length = 0 // 清掉 initial_command_history,只看后续

  socket.emit('request_full_history')

  const fullEvent = emitted.find(e => e.event === 'full_command_history')
  assert.ok(fullEvent, '应 emit full_command_history')
  assert.deepEqual(fullEvent.payload.history, historyRef)
})

// ========== Test: clear_command_history ==========

test('registerUiSocketHandlers: clear_command_history 调用注入 clearCommandHistory + emit cleared', () => {
  const { io, triggerConnection } = makeMockIo()
  const { socket, emitted } = makeMockSocket('client-3')
  let clearedCalled = 0
  const clearCommandHistory = () => { clearedCalled++; return true }

  registerUiSocketHandlers({
    io,
    getProjectRoomId: () => 'r',
    getCurrentProjectPath: () => '/',
    getAndBroadcastStatus: () => {},
    getCommandHistory: () => [],
    clearCommandHistory,
    addCommandToHistory: () => {},
    runningProcesses: new Map(),
    nextProcessId: () => 1,
    spawn: makeFakeSpawn(),
    exec: () => {},
    path,
    iconv: makeMockIconv()
  })

  triggerConnection(socket)
  emitted.length = 0

  socket.emit('clear_command_history')

  assert.equal(clearedCalled, 1, 'clearCommandHistory 应被调 1 次')
  const clearedEvent = emitted.find(e => e.event === 'command_history_cleared')
  assert.ok(clearedEvent, '应 emit command_history_cleared')
  assert.deepEqual(clearedEvent.payload, { success: true })
})

// ========== Test: exec_interactive 校验失败路径 ==========

test('registerUiSocketHandlers: exec_interactive 空 command → emit interactive_error, 不调 spawn', () => {
  const { io, triggerConnection } = makeMockIo()
  const { socket, emitted } = makeMockSocket('client-4')
  let spawnCalls = 0
  const spawnMock = () => { spawnCalls++; return makeFakeSpawn()() }

  registerUiSocketHandlers({
    io,
    getProjectRoomId: () => 'r',
    getCurrentProjectPath: () => '/fake',
    getAndBroadcastStatus: () => {},
    getCommandHistory: () => [],
    clearCommandHistory: () => true,
    addCommandToHistory: () => {},
    runningProcesses: new Map(),
    nextProcessId: () => 1,
    spawn: spawnMock,
    exec: () => {},
    path,
    iconv: makeMockIconv()
  })

  triggerConnection(socket)
  emitted.length = 0

  // 模拟前端 emit exec_interactive,空字符串
  socket.emit('exec_interactive', { command: '', sessionId: 'sess-empty' })

  assert.equal(spawnCalls, 0, '空 command 不应 spawn 子进程')
  const errEvent = emitted.find(e => e.event === 'interactive_error')
  assert.ok(errEvent, '应 emit interactive_error')
  assert.equal(errEvent.payload.sessionId, 'sess-empty')
  assert.match(errEvent.payload.error, /command 不能为空/, '错误信息应说明 command 不能为空')
})

test('registerUiSocketHandlers: exec_interactive 非字符串 command → emit interactive_error', () => {
  const { io, triggerConnection } = makeMockIo()
  const { socket, emitted } = makeMockSocket('client-5')
  let spawnCalls = 0
  const spawnMock = () => { spawnCalls++; return makeFakeSpawn()() }

  registerUiSocketHandlers({
    io,
    getProjectRoomId: () => 'r',
    getCurrentProjectPath: () => '/fake',
    getAndBroadcastStatus: () => {},
    getCommandHistory: () => [],
    clearCommandHistory: () => true,
    addCommandToHistory: () => {},
    runningProcesses: new Map(),
    nextProcessId: () => 1,
    spawn: spawnMock,
    exec: () => {},
    path,
    iconv: makeMockIconv()
  })

  triggerConnection(socket)
  emitted.length = 0

  socket.emit('exec_interactive', { command: 123, sessionId: 'sess-int' })

  assert.equal(spawnCalls, 0, '非字符串 command 不应 spawn')
  const errEvent = emitted.find(e => e.event === 'interactive_error')
  assert.ok(errEvent)
  assert.equal(errEvent.payload.sessionId, 'sess-int')
})

// ========== Test: exec_interactive 正常路径(stdout → socket, close → history) ==========

test('registerUiSocketHandlers: exec_interactive 正常 → spawn → stdout 流到 socket → close 写入历史', () => {
  const { io, triggerConnection } = makeMockIo()
  const { socket, emitted } = makeMockSocket('client-6')
  const fakeChildren = []
  const spawnMock = (cmd, args, opts) => {
    const child = makeFakeSpawn()()
    fakeChildren.push({ child, cmd, args, opts })
    return child
  }

  let pidCounter = 0
  const nextProcessId = () => ++pidCounter

  let addedToHistory = null
  const addCommandToHistory = (cmd, stdout, stderr, err, execTime) => {
    addedToHistory = { cmd, stdout, stderr, err, execTime }
  }

  registerUiSocketHandlers({
    io,
    getProjectRoomId: () => 'r',
    getCurrentProjectPath: () => '/fake',
    getAndBroadcastStatus: () => {},
    getCommandHistory: () => [],
    clearCommandHistory: () => true,
    addCommandToHistory,
    runningProcesses: new Map(),
    nextProcessId,
    spawn: spawnMock,
    exec: () => {},
    path,
    iconv: makeMockIconv()
  })

  triggerConnection(socket)
  emitted.length = 0

  socket.emit('exec_interactive', {
    command: 'echo hello',
    directory: '',
    sessionId: 'sess-ok'
  })

  assert.equal(fakeChildren.length, 1, '应 spawn 1 个子进程')
  const { child } = fakeChildren[0]
  // 应发 processId
  const pidEvent = emitted.find(e => e.event === 'interactive_process_id')
  assert.ok(pidEvent, '应 emit interactive_process_id')
  assert.equal(pidEvent.payload.sessionId, 'sess-ok')
  assert.equal(typeof pidEvent.payload.processId, 'number')

  // 模拟子进程 stdout 输出
  child.stdout.emit('data', Buffer.from('hello\n'))
  const stdoutEvent = emitted.find(e => e.event === 'interactive_stdout')
  assert.ok(stdoutEvent, '应 emit interactive_stdout')
  assert.equal(stdoutEvent.payload.sessionId, 'sess-ok')
  assert.match(stdoutEvent.payload.data, /hello/)

  // 模拟子进程正常结束
  child.emit('close', 0, null)

  const exitEvent = emitted.find(e => e.event === 'interactive_exit')
  assert.ok(exitEvent, '应 emit interactive_exit')
  assert.equal(exitEvent.payload.code, 0)
  assert.equal(exitEvent.payload.success, true)

  // 写入历史
  assert.ok(addedToHistory, '应调 addCommandToHistory')
  // SEC-INJ-1 修复后:Windows 上 echo 是 cmd 内置命令,
  // 走 'cmd.exe /c echo hello' argv 模式,history.command 记录 join 后的字符串
  const expectedCmd = process.platform === 'win32' ? 'cmd.exe /c echo hello' : 'echo hello'
  assert.equal(addedToHistory.cmd, expectedCmd)
  assert.match(addedToHistory.stdout, /hello/)
})

// ========== Test: exec_interactive 非 0 退出码 → success=false ==========

test('registerUiSocketHandlers: exec_interactive 非 0 退出码 → interactive_exit.success=false', () => {
  const { io, triggerConnection } = makeMockIo()
  const { socket, emitted } = makeMockSocket('client-7')
  const fakeChildren = []
  const spawnMock = () => {
    const c = makeFakeSpawn()()
    fakeChildren.push({ child: c })
    return c
  }
  let pidCounter = 0
  const nextProcessId = () => ++pidCounter

  registerUiSocketHandlers({
    io,
    getProjectRoomId: () => 'r',
    getCurrentProjectPath: () => '/fake',
    getAndBroadcastStatus: () => {},
    getCommandHistory: () => [],
    clearCommandHistory: () => true,
    addCommandToHistory: () => {},
    runningProcesses: new Map(),
    nextProcessId,
    spawn: spawnMock,
    exec: () => {},
    path,
    iconv: makeMockIconv()
  })

  triggerConnection(socket)
  emitted.length = 0

  socket.emit('exec_interactive', { command: 'false', sessionId: 'sess-fail' })

  const { child } = fakeChildren[0]
  child.emit('close', 1, null) // 退出码 1

  const exitEvent = emitted.find(e => e.event === 'interactive_exit')
  assert.ok(exitEvent)
  assert.equal(exitEvent.payload.code, 1)
  assert.equal(exitEvent.payload.success, false)
})
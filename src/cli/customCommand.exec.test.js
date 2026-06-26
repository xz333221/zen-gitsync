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
// src/cli/customCommand.js#runCustomCommand 单元测试(行为契约)。
//
// ESM 模块的命名导出是只读的,无法直接 monkey-patch `node:child_process.exec`,
// 所以本测试不走 stub 路径,而是用**真实**但轻量级的 shell 命令
// (`node -e "..."` 跨平台) 触发 runCustomCommand 内部 callback,
// 验证 stdout/stderr/error 三条打印分支都生效。
//
// 测试间用 `setTimeout(200)` 等真实子进程跑完(避免 microtask 顺序问题)。
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { runCustomCommand } from './customCommand.js'
import { getTrackedChildCount, _resetForTests } from './cleanup.js'

// 收集 console.log / console.error 输出
let logs = []
let errs = []
const origLog = console.log
const origErr = console.error
function captureConsole() {
  logs = []
  errs = []
  console.log = (m) => logs.push(typeof m === 'string' ? m : String(m))
  console.error = (m) => errs.push(typeof m === 'string' ? m : String(m))
}
function restoreConsole() {
  console.log = origLog
  console.error = origErr
}

afterEach(() => {
  restoreConsole()
  _resetForTests()
})

/** 等异步 exec 回调跑完的辅助函数 — 200ms 足够本地 node -e 完成 */
function settle() {
  return new Promise((r) => setTimeout(r, 200))
}

// ========== 行为契约 ==========

test('runCustomCommand: silent=true 不打印 [自定义命令执行] 头标', async () => {
  captureConsole()
  runCustomCommand('node -e "console.log(1)"', { silent: true })
  await settle()
  assert.equal(
    logs.some((m) => /\[自定义命令执行\]/.test(m)),
    false,
    'silent 模式不应打印 [自定义命令执行] 头标'
  )
})

test('runCustomCommand: 非 silent 打印 [自定义命令执行] 头标 + 命令', async () => {
  captureConsole()
  runCustomCommand('node -e "console.log(1)"')
  await settle()
  assert.ok(
    logs.some((m) => /\[自定义命令执行\]/.test(m)),
    '非 silent 应打印 [自定义命令执行] 头标'
  )
  assert.ok(
    logs.some((m) => /node -e/.test(m)),
    '头标应包含命令字符串'
  )
})

test('runCustomCommand: stdout 有内容时打印 [自定义命令输出] + 内容', async () => {
  captureConsole()
  runCustomCommand('node -e "console.log(\'hello-from-stdout\')"', { silent: true })
  await settle()
  assert.ok(
    logs.some((m) => /\[自定义命令输出\]/.test(m)),
    '应打印 [自定义命令输出] 头标'
  )
  assert.ok(
    logs.some((m) => /hello-from-stdout/.test(m)),
    '输出应包含 stdout 内容'
  )
})

test('runCustomCommand: stderr 有内容时打印 [自定义命令错误输出] + 内容', async () => {
  captureConsole()
  runCustomCommand(
    'node -e "console.error(\'warning-msg\')"',
    { silent: true }
  )
  await settle()
  assert.ok(
    errs.some((m) => /\[自定义命令错误输出\]/.test(m)),
    '应打印 [自定义命令错误输出] 头标'
  )
  assert.ok(
    errs.some((m) => /warning-msg/.test(m)),
    '错误输出应包含 stderr 内容'
  )
})

test('runCustomCommand: 进程非 0 退出时打印 [自定义命令错误]', async () => {
  captureConsole()
  runCustomCommand('node -e "process.exit(1)"', { silent: true })
  await settle()
  assert.ok(
    errs.some((m) => /\[自定义命令错误\]/.test(m)),
    '非 0 退出应打印 [自定义命令错误] 头标'
  )
  assert.ok(errs.length >= 1, '至少应有一行错误输出')
})

test('runCustomCommand: 成功 + 无输出时不打印 [自定义命令输出/错误]', async () => {
  captureConsole()
  runCustomCommand('node -e ""', { silent: true })
  await settle()
  assert.equal(logs.some((m) => /\[自定义命令输出\]/.test(m)), false)
  assert.equal(errs.some((m) => /\[自定义命令错误\]/.test(m)), false)
  assert.equal(errs.some((m) => /\[自定义命令错误输出\]/.test(m)), false)
})

test('runCustomCommand: 同时有 stdout 和 stderr 时两条都打印', async () => {
  captureConsole()
  runCustomCommand(
    'node -e "console.log(\'OUT-MARKER-XYZ\'); console.error(\'ERR-MARKER-XYZ\')"',
    { silent: true }
  )
  await settle()
  assert.ok(logs.some((m) => /OUT-MARKER-XYZ/.test(m)), 'stdout 应被打印到 console.log')
  assert.ok(errs.some((m) => /ERR-MARKER-XYZ/.test(m)), 'stderr 应被打印到 console.error')
})

test('runCustomCommand: 跟踪 child 到 activeChildren(SIGINT 兜底)', async () => {
  captureConsole()
  // exec 异步返回前 child 应被加进跟踪集合
  runCustomCommand('node -e "setTimeout(() => {}, 50)"', { silent: true })
  // 不 await settle,立刻检查
  assert.ok(
    getTrackedChildCount() >= 1,
    `child 应被 track,实际跟踪数: ${getTrackedChildCount()}`
  )
  // 等命令跑完,不再断言集合大小(exit 事件在 Windows 时序不稳定,
  // 且 SIGINT 路径下用户主动 kill 才走 killAllTrackedChildren,
  // 主动 exit 的 child 由 trackChild 的 once('exit') 自动从集合移除,
  // 已在 cleanup.test.js#trackChild 单独覆盖)
  await settle()
})

test('runCustomCommand: 非 silent + stdout 都打印,顺序头标在前', async () => {
  captureConsole()
  runCustomCommand('node -e "console.log(\'payload\')"')
  await settle()
  const execIdx = logs.findIndex((m) => /\[自定义命令执行\]/.test(m))
  const outIdx = logs.findIndex((m) => /\[自定义命令输出\]/.test(m))
  assert.ok(execIdx >= 0, '应有 [自定义命令执行] 头标')
  assert.ok(outIdx >= 0, '应有 [自定义命令输出] 头标')
  assert.ok(execIdx < outIdx, '[自定义命令执行] 应在 [自定义命令输出] 之前')
})

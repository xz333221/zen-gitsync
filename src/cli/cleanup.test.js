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
// src/cli/cleanup.js 单元测试(node:test 内置)。
// 覆盖 registerCleanup / trackChild / runCleanupTasks / killAllTrackedChildren
// 的核心契约:幂等、错误隔离、覆盖语义、SIGINT 触发清理。
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  registerCleanup, unregisterCleanup, clearAllCleanup,
  trackChild, killAllTrackedChildren, runCleanupTasks,
  getTrackedChildCount, setupSigintHandler, _resetForTests,
} from './cleanup.js'

// 每个 case 跑完清理一次,避免 SIGINT 注册 / 子进程跟踪跨用例污染。
// 保存当前 case 注册的 dispose,在 afterEach 调用,确保 process 的 SIGINT
// listener 列表不会越积越多,跨 test 的 handler 不会误触发。
const disposers = []
afterEach(() => {
  while (disposers.length) {
    try { disposers.pop()() } catch (_) {}
  }
  _resetForTests()
})
function trackDispose(dispose) { disposers.push(dispose); return dispose }

// ========== registerCleanup ==========

test('registerCleanup: 注册同步 fn 并触发 runCleanupTasks', async () => {
  let called = 0
  registerCleanup('sync', () => { called++ })
  await runCleanupTasks()
  assert.equal(called, 1)
})

test('registerCleanup: 注册异步 fn 并 await 完成', async () => {
  let resolved = false
  registerCleanup('async', async () => {
    await new Promise((r) => setTimeout(r, 10))
    resolved = true
  })
  await runCleanupTasks()
  assert.equal(resolved, true)
})

test('registerCleanup: 同名注册覆盖前一次', async () => {
  let first = 0
  let second = 0
  registerCleanup('overlap', () => { first++ })
  registerCleanup('overlap', () => { second++ })
  await runCleanupTasks()
  assert.equal(first, 0, '首次注册应被覆盖')
  assert.equal(second, 1)
})

test('registerCleanup: 多个任务按注册顺序串行执行', async () => {
  const order = []
  registerCleanup('a', async () => {
    await new Promise((r) => setTimeout(r, 5))
    order.push('a')
  })
  registerCleanup('b', () => { order.push('b') })
  registerCleanup('c', () => { order.push('c') })
  await runCleanupTasks()
  assert.deepEqual(order, ['a', 'b', 'c'])
})

test('registerCleanup: 单个 fn 抛错不影响后续', async () => {
  let afterError = false
  registerCleanup('bad', () => { throw new Error('boom') })
  registerCleanup('good', () => { afterError = true })
  await runCleanupTasks()
  assert.equal(afterError, true)
})

test('registerCleanup: 入参校验', () => {
  assert.throws(() => registerCleanup('', () => {}), /name/)
  assert.throws(() => registerCleanup(null, () => {}), /name/)
  assert.throws(() => registerCleanup('x', null), /fn/)
  assert.throws(() => registerCleanup('x', 'not fn'), /fn/)
})

test('registerCleanup: runCleanupTasks 后任务被清空(单次执行语义)', async () => {
  let called = 0
  registerCleanup('once', () => { called++ })
  await runCleanupTasks()
  await runCleanupTasks()
  assert.equal(called, 1, '第二次 run 不应再触发已清理任务')
})

test('unregisterCleanup: 注销后任务不再触发', async () => {
  let called = 0
  registerCleanup('temp', () => { called++ })
  unregisterCleanup('temp')
  await runCleanupTasks()
  assert.equal(called, 0)
})

// ========== trackChild ==========

test('trackChild: 自动跟踪 child 并在 exit 时移除', () => {
  const fake = new EventEmitter()
  fake.kill = () => true
  trackChild(fake)
  assert.equal(getTrackedChildCount(), 1)
  fake.emit('exit', 0, null)
  assert.equal(getTrackedChildCount(), 0, 'exit 后应自动移除')
})

test('trackChild: null / 非 child 入参安全 passthrough', () => {
  // 防御:exec() 在某些平台可能返回 undefined
  assert.equal(trackChild(null), null)
  assert.equal(trackChild(undefined), undefined)
  assert.equal(getTrackedChildCount(), 0)
})

test('trackChild: 链式调用保留原 child 引用', () => {
  const fake = new EventEmitter()
  fake.kill = () => true
  const result = trackChild(fake)
  assert.equal(result, fake)
})

// ========== killAllTrackedChildren ==========

test('killAllTrackedChildren: 空集合快速返回', async () => {
  const result = await killAllTrackedChildren(10)
  assert.deepEqual(result, { terminated: 0 })
})

test('killAllTrackedChildren: 调用所有 child 的 kill', async () => {
  const kills = []
  const fake1 = new EventEmitter(); fake1.kill = (sig) => { kills.push(sig); fake1.emit('exit') }
  const fake2 = new EventEmitter(); fake2.kill = (sig) => { kills.push(sig); fake2.emit('exit') }
  trackChild(fake1); trackChild(fake2)
  const result = await killAllTrackedChildren(10) // 短 graceMs 让测试快
  assert.equal(result.terminated, 2)
  // 每个 child 应被 SIGTERM,exit 后 SIGKILL 不再调用(已从集合移除)
  assert.equal(kills.filter(s => s === 'SIGTERM').length, 2)
})

test('killAllTrackedChildren: child.kill 抛错不阻断其它', async () => {
  const bad = new EventEmitter(); bad.kill = () => { throw new Error('EPERM') }
  const good = new EventEmitter(); good.kill = () => good.emit('exit')
  trackChild(bad); trackChild(good)
  // 不应抛 — 错误隔离
  const result = await killAllTrackedChildren(10)
  assert.equal(result.terminated, 2)
})

// ========== runCleanupTasks 与 child 协同 ==========

test('runCleanupTasks 顺序:先 cleanup 再 kill children(cleanup 可主动撤销子进程)', async () => {
  const fake = new EventEmitter()
  let killCount = 0
  fake.kill = () => { killCount++; fake.emit('exit') }
  trackChild(fake)
  let cleanupRanFirst = null
  registerCleanup('kill-it', () => {
    if (killCount === 0) cleanupRanFirst = true
    fake.kill('SIGTERM')
  })
  // 注:这里手动模拟顺序 — 实际 setupSigintHandler 中 runCleanupTasks 在 kill 之前
  await runCleanupTasks()
  assert.equal(cleanupRanFirst, true, 'cleanup 应在 kill 之前跑')
  // killAllTrackedChildren 之后:
  await killAllTrackedChildren(10)
  // 此时 fake 已 exit,集合为空,不会再被 kill
})

// ========== setupSigintHandler 行为契约(不真触发 SIGINT) ==========

test('setupSigintHandler: 多次调用幂等(只注册一次)', () => {
  // 通过 listenerCount 验证
  const before = process.listenerCount('SIGINT')
  trackDispose(setupSigintHandler())
  trackDispose(setupSigintHandler())
  trackDispose(setupSigintHandler())
  const after = process.listenerCount('SIGINT')
  assert.equal(after - before, 1, '多次 setupSigintHandler 只应增加 1 个 listener')
})

// 辅助:触发 SIGINT 后等待 async handler 跑完。
// 直接 await emit 不行,因为 process.emit 对 async listener 不等待。
// 关键是:把 process.exit stub 成"只记录、不退出",这样 handler 跑完后
// promise 正常 resolve,不会变成 unhandled rejection。
async function fireSigintAndAwait() {
  process.emit('SIGINT')
  // 给 async handler 几个 microtask + macrotask 跑完
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
}

test('setupSigintHandler: SIGINT 触发 cleanup → exit(集成测试)', async () => {
  let cleaned = false
  registerCleanup('sigint-test', () => { cleaned = true })
  trackDispose(setupSigintHandler({ onBeforeCleanup: () => {}, onAfterCleanup: () => {} }))
  const originalExit = process.exit
  let exitCode = null
  process.exit = (code) => { exitCode = code /* 不真退出,让 handler 继续跑 */ }
  try {
    await fireSigintAndAwait()
    assert.equal(cleaned, true, 'SIGINT 应触发 cleanup')
    assert.equal(exitCode, 130, 'SIGINT 应以 exit code 130 退出(128 + 2)')
  } finally {
    process.exit = originalExit
  }
})

test('setupSigintHandler: SIGINT 二次触发幂等', async () => {
  let cleaned = 0
  registerCleanup('idempotent', () => { cleaned++ })
  trackDispose(setupSigintHandler())
  const originalExit = process.exit
  process.exit = () => { /* 不真退出 */ }
  try {
    await fireSigintAndAwait()
    await fireSigintAndAwait()
    await fireSigintAndAwait()
    assert.equal(cleaned, 1, 'cleanup 应只跑一次')
  } finally {
    process.exit = originalExit
  }
})

test('setupSigintHandler: cleanup 抛错不阻断 exit', async () => {
  registerCleanup('bad', () => { throw new Error('boom') })
  trackDispose(setupSigintHandler())
  const originalExit = process.exit
  let exited = false
  process.exit = () => { exited = true }
  try {
    await fireSigintAndAwait()
    assert.equal(exited, true, '即使 cleanup 抛错也应调用 exit')
  } finally {
    process.exit = originalExit
  }
})

test('setupSigintHandler: onBeforeCleanup / onAfterCleanup 钩子被调用', async () => {
  let before = false
  let after = false
  trackDispose(setupSigintHandler({
    onBeforeCleanup: () => { before = true },
    onAfterCleanup: () => { after = true },
  }))
  const originalExit = process.exit
  process.exit = () => { /* 不真退出 */ }
  try {
    await fireSigintAndAwait()
    assert.equal(before, true)
    assert.equal(after, true)
  } finally {
    process.exit = originalExit
  }
})
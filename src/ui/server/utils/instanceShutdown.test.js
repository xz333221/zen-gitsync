import { test } from 'node:test'
import assert from 'node:assert/strict'
import { notifyShutdown } from './instanceShutdown.js'

test('notifyShutdown: 向所有客户端广播 server_shutdown(pid/signal)', () => {
  const calls = []
  const io = { emit(event, payload) { calls.push([event, payload]) } }

  notifyShutdown(io, { pid: 1234, signal: 'SIGTERM' })

  assert.deepEqual(calls, [['server_shutdown', { pid: 1234, signal: 'SIGTERM' }]])
})

test('notifyShutdown: io 缺失或 emit 抛错时不抛出(shutdown 主流程不能被通知拖垮)', () => {
  assert.doesNotThrow(() => notifyShutdown(null, { pid: 1, signal: 'SIGINT' }))
  assert.doesNotThrow(() => notifyShutdown(undefined, { pid: 1, signal: 'SIGINT' }))

  const broken = { emit() { throw new Error('boom') } }
  assert.doesNotThrow(() => notifyShutdown(broken, { pid: 1, signal: 'SIGTERM' }))
})
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerInstancesRoutes } from './instances.js'

function setup({ instances = [], currentPid = 100 } = {}) {
  const routes = new Map()
  const killed = []
  const unregistered = []
  const app = {
    get(path, handler) { routes.set(`GET ${path}`, handler) },
    post(path, handler) { routes.set(`POST ${path}`, handler) },
  }
  const registry = {
    async list() { return instances },
    async unregister(pid) { unregistered.push(pid) },
  }
  registerInstancesRoutes({
    app,
    registry,
    getCurrentInstanceId: () => currentPid,
    killProcess(pid, signal) { killed.push([pid, signal]) },
  })
  return { routes, killed, unregistered }
}

async function callClose(handler, pid) {
  let statusCode = 200
  let payload = null
  const req = { method: 'POST', path: `/api/instances/${pid}/close`, params: { pid: String(pid) } }
  const res = {
    headersSent: false,
    status(code) { statusCode = code; return this },
    json(value) { payload = value; return this },
  }
  await handler(req, res, () => {})
  return { statusCode, payload }
}

test('instances close: 关闭已注册的其他实例并反注册', async () => {
  const target = { pid: 200, port: 5801, projectName: 'other-project' }
  const { routes, killed, unregistered } = setup({ instances: [target] })
  const result = await callClose(routes.get('POST /api/instances/:pid/close'), 200)

  assert.equal(result.statusCode, 200)
  assert.equal(result.payload.success, true)
  assert.deepEqual(killed, [[200, 'SIGTERM']])
  assert.deepEqual(unregistered, [200])
})

test('instances close: 允许关闭当前实例(selfClose=true),并 emit SIGTERM 触发自身 graceful shutdown', async () => {
  // 当前实例的关闭走自身 SIGTERM handler(server/index.js),由 instances.js 在
  // res.json 之后 setImmediate(() => process.emit('SIGTERM')) 触发。本测试用一个
  // 临时 listener 验证 emit 真的发生了一次。
  //
  // 关键前提:当前实例**不能**走 killProcess —— Windows 上 kill(自身 pid) 是
  // TerminateProcess,会当场终止本进程,res.json 都发不出去。所以 killed 必须为空。
  const target = { pid: 100, port: 5800, projectName: 'self' }
  let sigtermCount = 0
  const onSigterm = () => { sigtermCount++ }
  process.on('SIGTERM', onSigterm)
  try {
    const { routes, killed, unregistered } = setup({
      currentPid: 100,
      instances: [target],
    })
    const result = await callClose(routes.get('POST /api/instances/:pid/close'), 100)

    // 等 setImmediate 队列跑完,让 emit SIGTERM 触发 listener
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(result.statusCode, 200)
    assert.equal(result.payload.success, true)
    assert.equal(result.payload.selfClose, true, 'should mark current instance as self-close')
    assert.deepEqual(killed, [], '当前实例不能走 killProcess(Windows 上等于当场自杀)')
    assert.deepEqual(unregistered, [100])
    assert.equal(sigtermCount, 1, 'self-close 后应 emit 一次 SIGTERM 触发自身 shutdown handler')
  } finally {
    process.off('SIGTERM', onSigterm)
  }
})

test('instances close: 关闭其他实例时 selfClose=false,不 emit SIGTERM', async () => {
  const target = { pid: 200, port: 5801, projectName: 'other' }
  let sigtermCount = 0
  const onSigterm = () => { sigtermCount++ }
  process.on('SIGTERM', onSigterm)
  try {
    const { routes, killed, unregistered } = setup({
      currentPid: 100,
      instances: [target],
    })
    const result = await callClose(routes.get('POST /api/instances/:pid/close'), 200)

    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(result.statusCode, 200)
    assert.equal(result.payload.success, true)
    assert.equal(result.payload.selfClose, false, 'other instance must not be marked self-close')
    assert.deepEqual(killed, [[200, 'SIGTERM']])
    assert.deepEqual(unregistered, [200])
    assert.equal(sigtermCount, 0, '关闭其他实例不应触发自身 SIGTERM')
  } finally {
    process.off('SIGTERM', onSigterm)
  }
})

test('instances close: 不允许关闭注册表外的 PID', async () => {
  const { routes, killed } = setup({ instances: [] })
  const result = await callClose(routes.get('POST /api/instances/:pid/close'), 99999)

  assert.equal(result.statusCode, 404)
  assert.deepEqual(killed, [])
})

test('instances close: 拒绝非数字 PID', async () => {
  const { routes, killed } = setup()
  const result = await callClose(routes.get('POST /api/instances/:pid/close'), '1;shutdown')

  assert.equal(result.statusCode, 400)
  assert.deepEqual(killed, [])
})

async function callCloseAll(handler) {
  let statusCode = 200
  let payload = null
  const req = { method: 'POST', path: '/api/instances/close-all' }
  const res = {
    headersSent: false,
    status(code) { statusCode = code; return this },
    json(value) { payload = value; return this },
  }
  await handler(req, res, () => {})
  return { statusCode, payload }
}

test('instances close-all: 关闭所有实例 —— 其他实例 kill + 反注册,当前实例走自身 SIGTERM', async () => {
  const current = { pid: 100, port: 5800, projectName: 'self' }
  const otherA = { pid: 200, port: 5801, projectName: 'other-a' }
  const otherB = { pid: 300, port: 5802, projectName: 'other-b' }
  let sigtermCount = 0
  const onSigterm = () => { sigtermCount++ }
  process.on('SIGTERM', onSigterm)
  try {
    const { routes, killed, unregistered } = setup({
      currentPid: 100,
      instances: [current, otherA, otherB],
    })

    const result = await callCloseAll(routes.get('POST /api/instances/close-all'))
    // 等 setImmediate 队列跑完,让 emit SIGTERM 触发 listener
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(result.statusCode, 200)
    assert.equal(result.payload.success, true)
    assert.equal(result.payload.closed, 3, '当前实例也算在关闭计数里')
    assert.equal(result.payload.failed, 0)
    assert.equal(result.payload.total, 3)
    assert.equal(result.payload.selfClose, true, 'close-all 现在包含当前实例,必须告诉前端')
    assert.deepEqual(
      killed.map(([pid]) => pid).sort(),
      [200, 300],
      '当前实例不能走 killProcess(Windows 上等于当场自杀,响应发不出去)',
    )
    // 当前实例的注册表条目由自身 shutdown 流程摘除,这里只摘别人
    assert.deepEqual(unregistered.sort(), [200, 300])
    assert.equal(sigtermCount, 1, '含当前实例时必须 emit 一次 SIGTERM 触发自身 shutdown')
  } finally {
    process.off('SIGTERM', onSigterm)
  }
})

test('instances close-all: 只有当前实例时也要把它关掉', async () => {
  const current = { pid: 100, port: 5800, projectName: 'self' }
  let sigtermCount = 0
  const onSigterm = () => { sigtermCount++ }
  process.on('SIGTERM', onSigterm)
  try {
    const { routes, killed, unregistered } = setup({ currentPid: 100, instances: [current] })

    const result = await callCloseAll(routes.get('POST /api/instances/close-all'))
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(result.statusCode, 200)
    assert.equal(result.payload.success, true)
    assert.equal(result.payload.closed, 1)
    assert.equal(result.payload.total, 1)
    assert.equal(result.payload.selfClose, true)
    assert.deepEqual(killed, [])
    assert.deepEqual(unregistered, [])
    assert.equal(sigtermCount, 1)
  } finally {
    process.off('SIGTERM', onSigterm)
  }
})

test('instances close-all: 部分 kill 失败不影响其他项', async () => {
  const otherA = { pid: 200, port: 5801, projectName: 'other-a' }
  const otherB = { pid: 300, port: 5802, projectName: 'other-b' }

  const routes = new Map()
  const unregistered = []
  const app = {
    get(path, handler) { routes.set(`GET ${path}`, handler) },
    post(path, handler) { routes.set(`POST ${path}`, handler) },
  }
  const registry = {
    async list() { return [otherA, otherB] },
    async unregister(pid) { unregistered.push(pid) },
  }
  registerInstancesRoutes({
    app,
    registry,
    getCurrentInstanceId: () => 100,
    killProcess(pid) {
      if (pid === 200) {
        const err = new Error('no such process')
        err.code = 'ESRCH'
        throw err
      }
    },
  })

  const result = await callCloseAll(routes.get('POST /api/instances/close-all'))

  assert.equal(result.statusCode, 200)
  assert.equal(result.payload.success, false)
  assert.equal(result.payload.closed, 1)
  assert.equal(result.payload.failed, 1)
  const failedEntry = result.payload.results.find((r) => r.pid === 200)
  assert.equal(failedEntry.success, false)
  assert.match(failedEntry.error, /已经关闭/)
  assert.deepEqual(unregistered.sort(), [200, 300])
})

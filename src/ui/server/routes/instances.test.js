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

test('instances close: 禁止关闭当前实例', async () => {
  const { routes, killed } = setup({ currentPid: 100, instances: [{ pid: 100, port: 5800 }] })
  const result = await callClose(routes.get('POST /api/instances/:pid/close'), 100)

  assert.equal(result.statusCode, 400)
  assert.match(result.payload.error, /不能.*当前实例/)
  assert.deepEqual(killed, [])
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

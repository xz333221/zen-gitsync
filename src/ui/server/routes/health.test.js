import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHealthRoutes } from './health.js'

function setup({ pid = 1234, uptime = 12.345 } = {}) {
  const routes = new Map()
  const app = {
    get(path, handler) { routes.set(`GET ${path}`, handler) },
  }
  registerHealthRoutes({ app, getPid: () => pid, getUptime: () => uptime })
  return { routes }
}

async function callHealth(handler) {
  let statusCode = 200
  let payload = null
  const req = { method: 'GET', path: '/api/instance-health' }
  const res = {
    status(code) { statusCode = code; return this },
    json(value) { payload = value; return this },
  }
  await handler(req, res, () => {})
  return { statusCode, payload }
}

test('health: 返回 success/pid/uptime(毫秒)', async () => {
  const { routes } = setup({ pid: 4321, uptime: 12.345 })
  const result = await callHealth(routes.get('GET /api/instance-health'))

  assert.equal(result.statusCode, 200)
  assert.equal(result.payload.success, true)
  assert.equal(result.payload.pid, 4321)
  assert.equal(result.payload.uptime, 12345)
})

test('health: 未注入 getPid/getUptime 时返回当前进程信息', async () => {
  const routes = new Map()
  const app = { get(path, handler) { routes.set(`GET ${path}`, handler) } }
  registerHealthRoutes({ app })

  const result = await callHealth(routes.get('GET /api/instance-health'))

  assert.equal(result.statusCode, 200)
  assert.equal(result.payload.pid, process.pid)
  assert.equal(typeof result.payload.uptime, 'number')
})
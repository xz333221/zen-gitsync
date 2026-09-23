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
// src/ui/server/routes/localRepos.js 单元测试。
//
// 两条路由都只是"转发",所以断言也集中在**它们自己的取舍**上,而不是扫描逻辑
// (那部分在 utils/localRepoScan.test.js):
//   1. GET 必须把快照原样摊平到顶层 —— 前端就靠 `data.scanning` 决定要不要轮询
//   2. POST 必须**不 await** 扫描:一 await 就会挂十几秒,前端拿不到 started
//   3. POST 那条 promise 是有意"发射后不管"的 —— 它 reject 时不能变成进程级
//      unhandledRejection(Node 15+ 默认直接崩服务)
//
// 不真起 Express:沿用 remoteRepos.test.js 的 mock app + mock req/res 做法。
// 默认实现会真去遍历磁盘,所以两个注入口在所有用例里都换成假实现。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { registerLocalReposRoutes } from './localRepos.js'

/** 最小 express app mock:只实现 get + post 与 handler 调用 */
function makeApp() {
  const handlers = new Map()
  return {
    get(path, handler) { handlers.set(`GET ${path}`, handler) },
    post(path, handler) { handlers.set(`POST ${path}`, handler) },
    invoke(method, path) {
      const key = `${method} ${path}`
      const handler = handlers.get(key)
      assert.ok(handler, `no handler for ${key}`)
      const res = makeRes()
      return handler({ body: {}, query: {}, method, path }, res, () => {}).then(() => res)
    },
  }
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
  }
}

const SNAPSHOT = {
  scanning: false,
  scannedAt: 1758000000000,
  scannedDirs: 8613,
  roots: ['C:/', 'D:/'],
  repos: { 'D:/w/zen-gitsync': 'git@github.com:xz333221/zen-gitsync.git' },
  error: null,
}

function setup({ snapshot, refresh } = {}) {
  const app = makeApp()
  const calls = { get: 0, refresh: 0 }
  registerLocalReposRoutes({
    app,
    getLocalReposImpl: async () => {
      calls.get += 1
      return snapshot === undefined ? SNAPSHOT : snapshot
    },
    refreshReposImpl: () => {
      calls.refresh += 1
      return refresh === undefined ? Promise.resolve(SNAPSHOT) : refresh()
    },
  })
  return { app, calls }
}

// ── GET /api/local-repos ────────────────────────────────────────────────

test('GET /api/local-repos: 快照摊平进响应顶层(前端靠 data.scanning 决定要不要轮询)', async () => {
  const { app, calls } = setup()
  const res = await app.invoke('GET', '/api/local-repos')

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { success: true, ...SNAPSHOT })
  // 关键字段必须在顶层,而不是嵌在 data / snapshot 里
  assert.equal(res.body.scanning, false)
  assert.equal(res.body.repos['D:/w/zen-gitsync'], 'git@github.com:xz333221/zen-gitsync.git')
  assert.equal(calls.get, 1)
  // GET 不该顺手触发重扫 —— 重扫是 POST 的职责
  assert.equal(calls.refresh, 0)
})

test('GET /api/local-repos: 首次运行(还在扫)也回 200,只把 scanning 置真', async () => {
  const { app } = setup({ snapshot: { ...SNAPSHOT, scanning: true, scannedAt: null, repos: {} } })
  const res = await app.invoke('GET', '/api/local-repos')

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.success, true)
  assert.equal(res.body.scanning, true)
  assert.deepEqual(res.body.repos, {})
})

// ── POST /api/local-repos/scan ──────────────────────────────────────────

test('POST /api/local-repos/scan: 不 await 扫描 —— 扫描没结束就先回 started', async () => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const { app, calls } = setup({ refresh: () => pending })

  // 若路由 await 了扫描,这一行会一直挂着(扫描默认要十几秒)
  const res = await app.invoke('POST', '/api/local-repos/scan')

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { success: true, started: true })
  assert.equal(calls.refresh, 1, '应该确实把重扫踢起来了')

  release(SNAPSHOT)
  await pending
})

test('POST /api/local-repos/scan: 重扫失败不会变成进程级 unhandledRejection', async () => {
  const rejections = []
  const onRejection = (reason) => { rejections.push(reason) }
  process.on('unhandledRejection', onRejection)
  try {
    const { app } = setup({ refresh: () => Promise.reject(new Error('盘拔了')) })
    const res = await app.invoke('POST', '/api/local-repos/scan')

    assert.equal(res.body.started, true, '后台失败不该影响这次响应')

    // 让被吞掉的那个 rejection 有机会冒出来
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(rejections, [], 'rejection 必须被路由自己 catch 掉')
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})

test('POST /api/local-repos/scan: 重复点刷新都转成一次重扫(并发语义由 localRepoScan 保证)', async () => {
  const { app, calls } = setup()
  await app.invoke('POST', '/api/local-repos/scan')
  await app.invoke('POST', '/api/local-repos/scan')

  // 路由层不去重 —— 它对调用方是"转达意图",真正的单飞在 refreshLocalRepos 里
  assert.equal(calls.refresh, 2)
})

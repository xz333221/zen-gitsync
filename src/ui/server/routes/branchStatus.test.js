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
// src/ui/server/routes/branchStatus.js 单元测试。
// 验证 GET /api/branch-status 的缓存与"push 后10秒同步状态"策略。
//
// 测试不真起 Express,直接调 registerBranchStatusRoutes 注入一个
// mock app,再用 supertest 风格的 mock req/res 触发 handler。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerBranchStatusRoutes } from './branchStatus.js'

/** 最小 express app mock:只实现 get/post + handler 调用 */
function makeApp() {
  const handlers = new Map()  // key = "METHOD path" → handler
  return {
    get(path, handler) { handlers.set(`GET ${path}`, handler) },
    post(path, handler) { handlers.set(`POST ${path}`, handler) },
    invoke(method, path, req = { query: {} }, res = makeRes()) {
      const key = `${method} ${path}`
      const handler = handlers.get(key)
      assert.ok(handler, `no handler for ${key}`)
      return handler(req, res, () => {})
    }
  }
}
function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    status(c) { this.statusCode = c; return this },
    json(p) { this.payload = p; return this }
  }
}

// ========== /api/branch-status 缓存与同步状态 ==========

test('branchStatus: 非 git 仓库 → hasUpstream:false + ahead/behind 0', async () => {
  const app = makeApp()
  const execGitCommandCalls = []
  registerBranchStatusRoutes({
    app,
    execGitCommand: async (args) => { execGitCommandCalls.push(args); return { stdout: '' } },
    getIsGitRepo: () => false,
    getBranchStatusCache: () => ({ currentBranch: null, upstreamBranch: null, lastUpdate: 0, cacheTimeout: 5000 }),
    setBranchStatusCache: () => {},
    getRecentPushStatus: () => ({ justPushed: false, pushTime: 0, validDuration: 10000 }),
    setRecentPushStatus: () => {}
  })
  const res = makeRes()
  await app.invoke('GET', '/api/branch-status', { query: {} }, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.payload, { hasUpstream: false, ahead: 0, behind: 0 })
  assert.equal(execGitCommandCalls.length, 0, '非 git 仓库应直接返回,不打 git 子命令')
})

test('branchStatus: push 后 10 秒内 → 直接返回 ahead/behind 0', async () => {
  const app = makeApp()
  let execGitCommandCalls = 0
  const recentPushStatus = {
    justPushed: true,
    pushTime: Date.now() - 3000,  // 3 秒前 push
    validDuration: 10000  // 10 秒有效
  }
  registerBranchStatusRoutes({
    app,
    execGitCommand: async () => { execGitCommandCalls++; return { stdout: 'main' } },
    getIsGitRepo: () => true,
    getBranchStatusCache: () => ({
      currentBranch: 'feature-x',
      upstreamBranch: 'origin/feature-x',
      lastUpdate: Date.now(),
      cacheTimeout: 5000
    }),
    setBranchStatusCache: () => {},
    getRecentPushStatus: () => recentPushStatus,
    setRecentPushStatus: () => {}
  })
  const res = makeRes()
  await app.invoke('GET', '/api/branch-status', { query: {} }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.payload.hasUpstream, true)
  assert.equal(res.payload.ahead, 0)
  assert.equal(res.payload.behind, 0)
  assert.equal(execGitCommandCalls, 0, 'push 同步窗口内不应打 git 子命令')
})

test('branchStatus: push 后 11 秒 → 失效,走 git 子命令', async () => {
  const app = makeApp()
  let execGitCommandCalls = 0
  const recentPushStatus = {
    justPushed: true,
    pushTime: Date.now() - 11000,  // 11 秒前,刚过窗口
    validDuration: 10000
  }
  registerBranchStatusRoutes({
    app,
    execGitCommand: async (args) => {
      execGitCommandCalls++
      if (args[0] === 'symbolic-ref') return { stdout: 'main\n' }
      // rev-list 必须在 rev-parse 之前匹配(都是 rev- 前缀)
      if (args[0] === 'rev-list') return { stdout: '2\t3\n' }
      if (args[0] === 'rev-parse') return { stdout: 'origin/main\n' }
      return { stdout: '' }
    },
    getIsGitRepo: () => true,
    getBranchStatusCache: () => ({ currentBranch: null, upstreamBranch: null, lastUpdate: 0, cacheTimeout: 5000 }),
    setBranchStatusCache: () => {},
    getRecentPushStatus: () => recentPushStatus,
    setRecentPushStatus: () => {}
  })
  const res = makeRes()
  await app.invoke('GET', '/api/branch-status', { query: {} }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.payload.hasUpstream, true)
  assert.equal(res.payload.ahead, 2)
  assert.equal(res.payload.behind, 3)
  assert.ok(execGitCommandCalls >= 1, '过期后应执行 git 子命令')
})

test('branchStatus: 5 秒缓存命中 → 不打 symbolic-ref / rev-parse', async () => {
  const app = makeApp()
  let execGitCommandCalls = 0
  const branchStatusCache = {
    currentBranch: 'cached-branch',
    upstreamBranch: 'origin/cached-branch',
    lastUpdate: Date.now() - 2000,  // 2 秒前,缓存有效
    cacheTimeout: 5000
  }
  registerBranchStatusRoutes({
    app,
    execGitCommand: async (args) => {
      execGitCommandCalls++
      if (args[0] === 'rev-list') return { stdout: '0\t0\n' }
      return { stdout: '' }
    },
    getIsGitRepo: () => true,
    getBranchStatusCache: () => branchStatusCache,
    setBranchStatusCache: () => {},
    getRecentPushStatus: () => ({ justPushed: false, pushTime: 0, validDuration: 10000 }),
    setRecentPushStatus: () => {}
  })
  const res = makeRes()
  await app.invoke('GET', '/api/branch-status', { query: {} }, res)
  assert.equal(res.statusCode, 200)
  // 缓存命中时 upstreamBranch 从 cache 读出,不会重新打 rev-parse
  assert.equal(res.payload.upstreamBranch, 'origin/cached-branch')
  // symbolic-ref / rev-parse '@{u}' 应被缓存跳过,只剩 rev-list
  assert.equal(execGitCommandCalls, 1, '缓存命中应只打 1 次 rev-list')
})

test('branchStatus: force=true 强制刷新,绕过 5 秒缓存', async () => {
  const app = makeApp()
  let execGitCommandCalls = 0
  const branchStatusCache = {
    currentBranch: 'stale-branch',
    upstreamBranch: 'origin/stale-branch',
    lastUpdate: Date.now() - 1000,  // 1 秒前,缓存有效
    cacheTimeout: 5000
  }
  registerBranchStatusRoutes({
    app,
    execGitCommand: async (args) => {
      execGitCommandCalls++
      if (args[0] === 'symbolic-ref') return { stdout: 'fresh-branch\n' }
      // rev-list 必须在 rev-parse 之前匹配
      if (args[0] === 'rev-list') return { stdout: '1\t1\n' }
      if (args[0] === 'rev-parse') return { stdout: 'origin/fresh-branch\n' }
      return { stdout: '' }
    },
    getIsGitRepo: () => true,
    getBranchStatusCache: () => branchStatusCache,
    setBranchStatusCache: () => {},
    getRecentPushStatus: () => ({ justPushed: false, pushTime: 0, validDuration: 10000 }),
    setRecentPushStatus: () => {}
  })
  const res = makeRes()
  await app.invoke('GET', '/api/branch-status', { query: { force: 'true' } }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.payload.upstreamBranch, 'origin/fresh-branch', 'force 应绕过缓存读到新值')
  assert.ok(execGitCommandCalls >= 3, 'force 应触发 3 次 git 子命令(symbolic-ref + rev-parse + rev-list)')
})

test('branchStatus: 无 upstream 时 → hasUpstream:false', async () => {
  const app = makeApp()
  let cacheSet = null
  registerBranchStatusRoutes({
    app,
    execGitCommand: async (args) => {
      if (args[0] === 'symbolic-ref') return { stdout: 'main\n' }
      if (args[0] === 'rev-parse') return { stdout: '\n' }  // 空 → 无 upstream
      return { stdout: '' }
    },
    getIsGitRepo: () => true,
    getBranchStatusCache: () => ({ currentBranch: null, upstreamBranch: null, lastUpdate: 0, cacheTimeout: 5000 }),
    setBranchStatusCache: (v) => { cacheSet = v },
    getRecentPushStatus: () => ({ justPushed: false, pushTime: 0, validDuration: 10000 }),
    setRecentPushStatus: () => {}
  })
  const res = makeRes()
  await app.invoke('GET', '/api/branch-status', { query: {} }, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.payload, { hasUpstream: false, ahead: 0, behind: 0 })
  assert.ok(cacheSet, '无 upstream 时应清空缓存')
  assert.equal(cacheSet.currentBranch, null)
})

// ========== /api/branch ==========

test('branchStatus: /api/branch 返回 trim 后的分支名', async () => {
  const app = makeApp()
  registerBranchStatusRoutes({
    app,
    execGitCommand: async (args) => {
      if (args[0] === 'symbolic-ref') return { stdout: '  develop  \n' }
      return { stdout: '' }
    },
    getIsGitRepo: () => true,
    getBranchStatusCache: () => ({}),
    setBranchStatusCache: () => {},
    getRecentPushStatus: () => ({}),
    setRecentPushStatus: () => {}
  })
  const res = makeRes()
  await app.invoke('GET', '/api/branch', { query: {} }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.payload.branch, 'develop', '应 trim 前后空白')
})

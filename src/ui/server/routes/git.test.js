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
// src/ui/server/routes/git.js 单元测试。
// 验证 POST /api/checkout 对远程分支的处理:
// 选中 origin/xxx 时应切到同名本地分支,不存在则 --track 自动创建,
// 而不是直接 checkout 远程引用进入 detached HEAD。
//
// 测试不真起 Express,直接调 registerGitRoutes 注入 mock app。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerGitRoutes } from './git.js'

/** 最小 express app mock:只实现 get/post + handler 调用 */
function makeApp() {
  const handlers = new Map()  // key = "METHOD path" → handler
  return {
    get(path, handler) { handlers.set(`GET ${path}`, handler) },
    post(...args) {
      // create-branch 等路由带 express.json() 中间件,handler 永远是最后一个参数
      const path = args[0]
      const handler = args[args.length - 1]
      handlers.set(`POST ${path}`, handler)
    },
    invoke(method, path, req = { query: {}, body: {} }, res = makeRes()) {
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

/** 构造注入依赖,calls 记录所有 git 子命令 */
function makeDeps(app, execGitCommand) {
  const calls = []
  registerGitRoutes({
    app,
    execGitCommand: async (args, opts) => { calls.push(args); return execGitCommand(args, opts) },
    clearBranchCache: () => {}
  })
  return calls
}

// ========== /api/checkout 远程分支处理 ==========

test('checkout: 本地分支 → 直接 checkout,不做远程探测', async () => {
  const app = makeApp()
  const calls = makeDeps(app, async () => ({ stdout: '' }))
  const res = makeRes()
  await app.invoke('POST', '/api/checkout', { query: {}, body: { branch: 'develop' } }, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.payload, { success: true, branch: 'develop' })
  assert.deepEqual(calls, [['checkout', 'develop']])
})

test('checkout: 远程分支 + 本地已存在同名分支 → 切到本地分支', async () => {
  const app = makeApp()
  const calls = makeDeps(app, async (args) => {
    if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/release-v1')) return { stdout: 'abc123\n' }
    if (args[0] === 'rev-parse' && args.includes('refs/heads/release-v1')) return { stdout: 'def456\n' }
    return { stdout: '' }
  })
  const res = makeRes()
  await app.invoke('POST', '/api/checkout', { query: {}, body: { branch: 'origin/release-v1' } }, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.payload, { success: true, branch: 'release-v1' })
  // 最后一步必须是 checkout 本地分支名,而不是 checkout origin/release-v1(detached HEAD)
  assert.deepEqual(calls[calls.length - 1], ['checkout', 'release-v1'])
})

test('checkout: 远程分支 + 本地无同名分支 → checkout --track 自动创建', async () => {
  const app = makeApp()
  const calls = makeDeps(app, async (args) => {
    if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/release-v1')) return { stdout: 'abc123\n' }
    if (args[0] === 'rev-parse' && args.includes('refs/heads/release-v1')) return { stdout: '' }  // 本地不存在
    return { stdout: '' }
  })
  const res = makeRes()
  await app.invoke('POST', '/api/checkout', { query: {}, body: { branch: 'origin/release-v1' } }, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.payload, { success: true, branch: 'release-v1', created: true })
  assert.deepEqual(calls[calls.length - 1], ['checkout', '--track', 'origin/release-v1'])
})

test('checkout: 多级远程分支(origin/feature/x)→ 本地名取第一个斜杠之后部分', async () => {
  const app = makeApp()
  const calls = makeDeps(app, async (args) => {
    if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/feature/x')) return { stdout: 'abc123\n' }
    if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/x')) return { stdout: '' }
    return { stdout: '' }
  })
  const res = makeRes()
  await app.invoke('POST', '/api/checkout', { query: {}, body: { branch: 'origin/feature/x' } }, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.payload, { success: true, branch: 'feature/x', created: true })
  assert.deepEqual(calls[calls.length - 1], ['checkout', '--track', 'origin/feature/x'])
})

test('checkout: 带斜杠但远程引用不存在(如本地 feature/x)→ 按原名直接 checkout', async () => {
  const app = makeApp()
  const calls = makeDeps(app, async (args) => {
    if (args[0] === 'rev-parse') return { stdout: '' }  // refs/remotes/feature/x 不存在
    return { stdout: '' }
  })
  const res = makeRes()
  await app.invoke('POST', '/api/checkout', { query: {}, body: { branch: 'feature/x' } }, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.payload, { success: true, branch: 'feature/x' })
  assert.deepEqual(calls[calls.length - 1], ['checkout', 'feature/x'])
})

test('checkout: rev-parse 探测抛错 → ignoreError 吞下,按原名 checkout(非 500)', async () => {
  const app = makeApp()
  const calls = makeDeps(app, async (args, opts) => {
    if (args[0] === 'rev-parse') {
      const err = new Error('Command failed: git rev-parse --verify --quiet refs/remotes/origin/gone')
      err.code = 128
      if (opts && opts.ignoreError) return { stdout: '' }
      throw err
    }
    return { stdout: '' }
  })
  const res = makeRes()
  await app.invoke('POST', '/api/checkout', { query: {}, body: { branch: 'origin/gone' } }, res)
  assert.equal(res.statusCode, 200, '探测失败应降级为普通 checkout,不应 500')
  assert.deepEqual(calls[calls.length - 1], ['checkout', 'origin/gone'])
})

// ========== /api/user-info Git 用户信息读取层级 ==========

test('user-info: 按 Git 默认层级读取生效配置,不强制 --global', async () => {
  const app = makeApp()
  const calls = makeDeps(app, async (args) => {
    if (args[0] === 'config' && args[1] === 'user.name') return { stdout: 'Local User\n' }
    if (args[0] === 'config' && args[1] === 'user.email') return { stdout: 'local@example.com\n' }
    return { stdout: '' }
  })
  const res = makeRes()
  await app.invoke('GET', '/api/user-info', {}, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.payload, { name: 'Local User', email: 'local@example.com' })
  assert.ok(
    calls.some(c => c[0] === 'config' && c[1] === 'user.name' && !c.includes('--global')),
    'user.name 应读取生效配置而非仅 global'
  )
  assert.ok(
    calls.some(c => c[0] === 'config' && c[1] === 'user.email' && !c.includes('--global')),
    'user.email 应读取生效配置而非仅 global'
  )
})

test('user-info: 配置未设置时返回空字符串,不应 500', async () => {
  const app = makeApp()
  makeDeps(app, async (args, opts) => {
    if (args[0] === 'config') {
      const err = new Error(`Command failed: git config ${args[1]}`)
      err.code = 1
      if (opts && opts.ignoreError) return { stdout: '', stderr: `error: ${args[1]} 未配置`, error: err }
      throw err
    }
    return { stdout: '' }
  })
  const res = makeRes()
  await app.invoke('GET', '/api/user-info', {}, res)
  assert.equal(res.statusCode, 200, '未配置时应返回 200 并降级为空字符串')
  assert.deepEqual(res.payload, { name: '', email: '' })
})

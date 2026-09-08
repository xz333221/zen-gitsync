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
// src/ui/server/routes/gitOps.js isGitRepo 标志同步回归测试。
//
// 背景 bug:服务端 isGitRepo 是启动时一次性检测的变量。用户在非仓库目录
// 点"初始化Git仓库"(或"初始化并添加远程")后,/api/git-init 真实创建了 .git,
// 但标志没有同步,/api/add-remote 用 stale 的 getIsGitRepo() 做门禁,
// 必然报"当前目录不是Git仓库"。
//
// 修复:git-init 成功后 setIsGitRepo(true)。
// 本文件验证:
//   1. git-init 成功 → setIsGitRepo(true) 被调用
//   2. 同一实例内 init 后 add-remote 不再被误拦(完整回归场景)
//   3. 未 init 的目录 add-remote 仍被正确拦截(门禁本身不回退)
//   4. add-remote 成功路径正确执行 git remote add
//
// 测试不真起 Express,直接调 registerGitOpsRoutes 注入 mock app,
// 触发最后一个注册的 handler(跳过 express.json() 等中间件)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerGitOpsRoutes } from './gitOps.js'

/** 最小 express app mock:post(path, ...fns) 只保留最后一个 handler */
function makeApp() {
  const handlers = new Map()  // key = "METHOD path" → handler
  return {
    get(p, ...fns) { handlers.set(`GET ${p}`, fns[fns.length - 1]) },
    post(p, ...fns) { handlers.set(`POST ${p}`, fns[fns.length - 1]) },
    invoke(method, p, req = { body: {} }, res = makeRes()) {
      const key = `${method} ${p}`
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

/** 组装依赖:isGitRepo 是可变闭包变量,模拟服务端标志 */
function setup({ initialRepo = false } = {}) {
  const app = makeApp()
  let isGitRepo = initialRepo
  const gitCalls = []
  registerGitOpsRoutes({
    app,
    execGitCommand: async (args) => {
      gitCalls.push(args)
      if (args[0] === 'init') isGitRepo = true  // git init 真实生效
      return { stdout: '' }
    },
    configManager: { getLockedFiles: async () => [] },
    execGitAddWithLockFilter: async () => ({}),
    addCommandToHistory: () => {},
    clearCommandHistory: () => {},
    checkAndClearGitLock: async () => true,
    getIsGitRepo: () => isGitRepo,
    setIsGitRepo: (v) => { isGitRepo = v },
    setRecentPushStatus: () => {}
  })
  return { app, gitCalls, getFlag: () => isGitRepo }
}

// ========== 回归:初始化后立即添加远程 ==========

test('gitRepoFlagSync: git-init 成功后同步 setIsGitRepo(true)', async () => {
  const { app, getFlag } = setup({ initialRepo: false })
  const res = makeRes()
  await app.invoke('POST', '/api/git-init', { body: {} }, res)
  assert.equal(res.payload.success, true)
  assert.equal(getFlag(), true, 'git-init 成功后服务端标志应立即翻为 true')
})

test('gitRepoFlagSync: 初始化后立即添加远程不再报"当前目录不是Git仓库"', async () => {
  const { app, gitCalls } = setup({ initialRepo: false })
  // 第一步:初始化(模拟"初始化并添加远程"按钮的第一步)
  const initRes = makeRes()
  await app.invoke('POST', '/api/git-init', { body: {} }, initRes)
  assert.equal(initRes.payload.success, true)
  // 第二步:添加远程(修复前此处被 stale 标志拦下)
  const addRes = makeRes()
  await app.invoke('POST', '/api/add-remote', {
    body: { name: 'origin', url: 'git@gitee.com:flowdash/home2026.git' }
  }, addRes)
  assert.equal(addRes.payload.success, true,
    `add-remote 应成功,实际: ${JSON.stringify(addRes.payload)}`)
  assert.deepEqual(gitCalls[gitCalls.length - 1],
    ['remote', 'add', 'origin', 'git@gitee.com:flowdash/home2026.git'])
})

test('gitRepoFlagSync: 未初始化时 add-remote 仍被门禁拦截', async () => {
  const { app, gitCalls } = setup({ initialRepo: false })
  const res = makeRes()
  await app.invoke('POST', '/api/add-remote', {
    body: { name: 'origin', url: 'git@gitee.com:flowdash/home2026.git' }
  }, res)
  assert.equal(res.payload.success, false)
  assert.equal(res.payload.error, '当前目录不是Git仓库')
  assert.equal(gitCalls.length, 0, '非 git 仓库不应执行任何 git 子命令')
})

test('gitRepoFlagSync: add-remote 正常路径执行 git remote add', async () => {
  const { app, gitCalls } = setup({ initialRepo: true })
  const res = makeRes()
  await app.invoke('POST', '/api/add-remote', {
    body: { name: 'origin', url: 'https://gitee.com/x/y.git' }
  }, res)
  assert.equal(res.payload.success, true)
  assert.deepEqual(gitCalls[gitCalls.length - 1],
    ['remote', 'add', 'origin', 'https://gitee.com/x/y.git'])
})

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
// 回归测试:Git 用户信息(user.name / user.email)的读取与回填。
//
// 背景:user.name / user.email 是用户级/全局属性,与"当前目录是否为 Git
// 仓库"无关。但调用方曾把它锁在 isGitRepo 分支里,导致打开非 Git 仓库
// 目录时 userName 停留在初始空串,右上角误报"未配置"。
// 本文件锁定两件事:
//   1. getUserInfo() 自身不依赖 isGitRepo,且缺项时如实回填已有那一项;
//   2. $reset() 确实会清空用户信息 —— 这正是切目录后必须重拉的缘由。
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useGitStore, DEFAULT_INITIAL_COMMIT_MESSAGE } from './gitStore'

function stubUserInfo(payload: unknown, { fail = false }: { fail?: boolean } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/user-info') {
      if (fail) throw new Error('network down')
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  }))
}

describe('gitStore.getUserInfo', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('name 与 email 齐全时都回填', async () => {
    stubUserInfo({ name: 'xuze', email: '569552263@qq.com' })
    const store = useGitStore()

    await store.getUserInfo()

    expect(store.userName).toBe('xuze')
    expect(store.userEmail).toBe('569552263@qq.com')
  })

  test('回归:只配了 name 没配 email 时,name 仍应显示', async () => {
    // 旧实现是 `if (data.name && data.email)` —— 任一项缺失就整体不赋值,
    // 已配好的 name 被一起吞掉,UI 反而误报"未配置"。只配 name 是很常见的
    // 状态,必须能正常显示,由 UI 侧 (!userName || !userEmail) 决定提示。
    stubUserInfo({ name: 'xuze', email: '' })
    const store = useGitStore()

    await store.getUserInfo()

    expect(store.userName).toBe('xuze')
    expect(store.userEmail).toBe('')
  })

  test('回归:只配了 email 没配 name 时,email 仍应回填', async () => {
    stubUserInfo({ name: '', email: '569552263@qq.com' })
    const store = useGitStore()

    await store.getUserInfo()

    expect(store.userEmail).toBe('569552263@qq.com')
    expect(store.userName).toBe('')
  })

  test('用户信息不依赖 isGitRepo,非 Git 仓库目录同样能拿到', async () => {
    // 后端走 `git config user.name`(不带 --global),按 local > global >
    // system 层级读取,在非仓库目录也会 fallback 到全局值。
    stubUserInfo({ name: 'xuze', email: '569552263@qq.com' })
    const store = useGitStore()
    store.isGitRepo = false

    await store.getUserInfo()

    expect(store.isGitRepo).toBe(false)
    expect(store.userName).toBe('xuze')
    expect(store.userEmail).toBe('569552263@qq.com')
  })

  test('请求失败时静默降级,不抛出且保留原值', async () => {
    stubUserInfo(null, { fail: true })
    const store = useGitStore()
    store.userName = 'cached'

    await expect(store.getUserInfo()).resolves.toBeUndefined()

    expect(store.userName).toBe('cached')
  })

  test('$reset() 会清空用户信息 —— 故切目录后必须重拉', async () => {
    // 这条锁定 DirectorySelector 里 `$reset(); getUserInfo()` 的必要性:
    // 少了后面那句,切到非 Git 仓库目录后右上角就会误报"未配置"。
    stubUserInfo({ name: 'xuze', email: '569552263@qq.com' })
    const store = useGitStore()
    await store.getUserInfo()
    expect(store.userName).toBe('xuze')

    store.$reset()
    expect(store.userName).toBe('')
    expect(store.userEmail).toBe('')

    await store.getUserInfo()
    expect(store.userName).toBe('xuze')
  })
})

// ---------------------------------------------------------------------------
// createInitialCommit:空态面板"初始化并提交"一键流程的回归测试。
//
// 背景:此前"初始化 Git 仓库"按钮只做 git init(+ 可选 add remote),
// 用户还得回提交框手敲一句提交信息才能产生首个 commit。现在把
// addAllToStage + commitChanges 串进同一个点击里,commitChanges 内部已含
// "首次提交后自动 push -u 建上游",所以一次点击可以从 init 走到 push。
//
// 本组锁定 4 件事:
//   1. 有可提交文件 → 暂存 + 提交,提交信息用默认值;
//   2. 空目录(暂存区为空)→ 返回 skipped-no-files 且绝不调用 commit,
//      否则 git 会抛原始的 "nothing to commit" 给用户看;
//   3. 仓库已有提交 → 返回 skipped-has-commits 且不做任何 git 操作
//      (防御目录被外部 git init 的并发场景,避免在既有历史上多压提交);
//   4. 提交失败 → 如实返回 failed,不谎报成功。
// ---------------------------------------------------------------------------
describe('gitStore.createInitialCommit', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // 桩掉一键流程会碰到的所有后端接口,并记录调用顺序与请求体便于断言
  function stubRepoApi(options: {
    porcelain?: string
    commitOk?: boolean
    addAllOk?: boolean
  } = {}) {
    const calls: string[] = []
    const commitBodies: any[] = []

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      const target = String(url)
      calls.push(target)
      const json = (payload: unknown) => new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })

      if (target.startsWith('/api/add-all')) {
        return json({ success: options.addAllOk !== false })
      }
      if (target.startsWith('/api/status_porcelain')) {
        // 代表 add-all 之后的暂存区状态:index 侧有变更 → parseStatusPorcelain 归为 'added'
        return json({ status: options.porcelain ?? '' })
      }
      if (target.startsWith('/api/commit')) {
        commitBodies.push(JSON.parse(init?.body || '{}'))
        return json({ success: options.commitOk !== false })
      }
      if (target.startsWith('/api/log')) {
        // fetchLog 在 commitChanges 的 autoRefresh 里被 await,必须返回合法形状
        return json({ data: [] })
      }
      return json({})
    }))

    return { calls, commitBodies }
  }

  test('有可提交文件时:暂存并提交,提交信息用默认值', async () => {
    const { calls, commitBodies } = stubRepoApi({ porcelain: 'A  index.html\nA  README.md' })
    const store = useGitStore()
    store.isGitRepo = true

    const result = await store.createInitialCommit()

    expect(result).toBe('committed')
    expect(calls.some(u => u.startsWith('/api/add-all'))).toBe(true)
    expect(calls.some(u => u.startsWith('/api/commit'))).toBe(true)
    expect(commitBodies[0].message).toBe(DEFAULT_INITIAL_COMMIT_MESSAGE)
  })

  test('回归:空目录时跳过提交,不把 "nothing to commit" 抛给用户', async () => {
    // 目录里没有任何可提交文件(空目录 / 文件全被 .gitignore 忽略)时,
    // 直接 git commit 会失败并弹出 git 原始报错。必须提前拦掉。
    const { calls } = stubRepoApi({ porcelain: '' })
    const store = useGitStore()
    store.isGitRepo = true

    const result = await store.createInitialCommit()

    expect(result).toBe('skipped-no-files')
    expect(calls.some(u => u.startsWith('/api/add-all'))).toBe(true)
    expect(calls.some(u => u.startsWith('/api/commit'))).toBe(false)
  })

  test('回归:仓库已有提交时不补首次提交,且不执行任何 git 操作', async () => {
    const { calls } = stubRepoApi({ porcelain: 'A  index.html' })
    const store = useGitStore()
    store.isGitRepo = true
    // log 非空 == 已经有提交(刚 init 的仓库处于 unborn HEAD,log 为空)
    store.log = [{ hash: 'deadbeef', message: 'existing' } as any]

    const result = await store.createInitialCommit()

    expect(result).toBe('skipped-has-commits')
    expect(calls.length).toBe(0)
  })

  test('提交失败时如实返回 failed', async () => {
    stubRepoApi({ porcelain: 'A  index.html', commitOk: false })
    const store = useGitStore()
    store.isGitRepo = true

    const result = await store.createInitialCommit()

    expect(result).toBe('failed')
  })

  test('传入空白消息时回退到默认提交信息', async () => {
    const { commitBodies } = stubRepoApi({ porcelain: 'A  index.html' })
    const store = useGitStore()
    store.isGitRepo = true

    await store.createInitialCommit('   ')

    expect(commitBodies[0].message).toBe(DEFAULT_INITIAL_COMMIT_MESSAGE)
  })

  test('非 Git 仓库时暂存失败,返回 failed 而不是提交', async () => {
    const { calls } = stubRepoApi({ porcelain: 'A  index.html' })
    const store = useGitStore()
    store.isGitRepo = false

    const result = await store.createInitialCommit()

    expect(result).toBe('failed')
    expect(calls.length).toBe(0)
  })
})

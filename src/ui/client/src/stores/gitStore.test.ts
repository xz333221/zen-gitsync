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
import { useGitStore, DEFAULT_INITIAL_COMMIT_MESSAGE, findGeneratedDirPrefix, buildInitialCommitGitignoreRules } from './gitStore'

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

  // ── 规模预检:疑似漏了 .gitignore ──────────────────────────────────────
  //
  // 背景:一键初始化会对整个目录执行 `git add .`。目录缺 .gitignore 时
  // node_modules / dist 会被整体写进首个提交 —— 实测一个只有 20 多个源文件的
  // Vue 项目因此提了 4298 个文件(node_modules 占 4272 / 114MB),推到远端后
  // 仓库 20MB,最后只能重写历史才清得掉。
  //
  // 本组锁定:可疑规模必须在**暂存之前**就拦下并交回调用方,而不是先提交再提示
  // (那时文件已经进 Git 历史了)。同时要保证正常项目不被误拦。
  test('文件数超过阈值时返回 confirm-required,且不暂存不提交', async () => {
    const { calls } = stubRepoApi({ porcelain: 'A  index.html' })
    const store = useGitStore()
    store.isGitRepo = true
    // 1100 个普通源文件:不命中生成目录,只能靠总数阈值触发
    store.fileList = Array.from({ length: 1100 }, (_, i) => ({ path: `src/f${i}.ts`, type: 'untracked' }))

    const result = await store.createInitialCommit()

    expect(result).toBe('confirm-required')
    expect(calls.some(u => u.startsWith('/api/add-all'))).toBe(false)
    expect(calls.some(u => u.startsWith('/api/commit'))).toBe(false)
    expect(store.initialCommitScope?.total).toBe(1100)
    expect(store.initialCommitScope?.suspicious).toBe(true)
  })

  test('命中生成目录时即使文件很少也拦截,并识别多级路径', async () => {
    const { calls } = stubRepoApi({ porcelain: 'A  index.html' })
    const store = useGitStore()
    store.isGitRepo = true
    // node_modules 不在仓库根(在 frontend 下),所以不能只看顶层目录名
    store.fileList = [
      { path: 'README.md', type: 'untracked' },
      { path: 'frontend/node_modules/vue/index.js', type: 'untracked' },
      { path: 'frontend/node_modules/vue/package.json', type: 'untracked' }
    ]

    const result = await store.createInitialCommit()

    expect(result).toBe('confirm-required')
    expect(calls.some(u => u.startsWith('/api/add-all'))).toBe(false)
    expect(store.initialCommitScope?.total).toBe(3)
    // 明细里要给出"到底是哪个目录",否则确认框无从判断
    expect(store.initialCommitScope?.generated).toEqual([
      { path: 'frontend/node_modules', count: 2 }
    ])
  })

  test('规模正常的项目不被误拦,直接走到提交', async () => {
    const { calls, commitBodies } = stubRepoApi({ porcelain: 'A  index.html' })
    const store = useGitStore()
    store.isGitRepo = true
    store.fileList = [
      { path: 'README.md', type: 'untracked' },
      { path: 'src/index.ts', type: 'untracked' },
      // 文件名里含 dist,但它不是"目录段",不该被当成生成目录
      { path: 'docs/dist.md', type: 'untracked' }
    ]

    const result = await store.createInitialCommit()

    expect(result).toBe('committed')
    expect(calls.some(u => u.startsWith('/api/add-all'))).toBe(true)
    expect(commitBodies[0].message).toBe(DEFAULT_INITIAL_COMMIT_MESSAGE)
  })

  test('force=true 时跳过预检(用户已看过明细并选择继续)', async () => {
    const { calls, commitBodies } = stubRepoApi({ porcelain: 'A  index.html' })
    const store = useGitStore()
    store.isGitRepo = true
    store.fileList = Array.from({ length: 1100 }, (_, i) => ({ path: `node_modules/p${i}/index.js`, type: 'untracked' }))

    const result = await store.createInitialCommit(DEFAULT_INITIAL_COMMIT_MESSAGE, { force: true })

    expect(result).toBe('committed')
    expect(calls.some(u => u.startsWith('/api/add-all'))).toBe(true)
    expect(commitBodies[0].message).toBe(DEFAULT_INITIAL_COMMIT_MESSAGE)
  })

  test('预检不做任何网络请求(只读已有状态)', async () => {
    const { calls } = stubRepoApi({ porcelain: 'A  index.html' })
    const store = useGitStore()
    store.isGitRepo = true
    store.fileList = [{ path: 'node_modules/vue/index.js', type: 'untracked' }]

    await store.createInitialCommit()

    // 拦住之后必须一个请求都没发出去 —— 否则"拦截"就没意义了
    expect(calls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ensureGitignore:补 .gitignore 的安全边界。
//
// 这是"拦截 → 一键补忽略规则"里的写盘环节,风险在于改动用户自己维护的
// .gitignore。锁定三点:已有内容原样保留、重复规则不重复追加、
// 无可加规则时不写文件(避免无谓地改动文件 mtime)。
// ---------------------------------------------------------------------------
describe('gitStore.ensureGitignore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // GET 走 /api/editor/file?path=...,没有 init;写入走同一路径的 PUT
  function stubEditorFile(
    options: { existing?: string | null; writeOk?: boolean; writeError?: string } = {}
  ) {
    const putBodies: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: any) => {
      const json = (payload: unknown) => new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
      if (init?.method === 'PUT') {
        putBodies.push(JSON.parse(init.body || '{}'))
        return json(options.writeOk === false
          ? { success: false, error: options.writeError ?? 'boom' }
          : { success: true })
      }
      // existing === null 表示文件不存在(后端返回 success:false)
      return options.existing === null
        ? json({ success: false, error: 'ENOENT' })
        : json({ success: true, content: options.existing ?? '' })
    }))
    return { putBodies }
  }

  test('保留原有内容,只追加缺失规则', async () => {
    const { putBodies } = stubEditorFile({ existing: '# 我的规则\nnode_modules\n*.log\n' })
    const store = useGitStore()

    const result = await store.ensureGitignore(['node_modules/', 'dist/'])

    expect(result.ok).toBe(true)
    // node_modules 已在(.gitignore 里带不带斜杠都算同一条),只该补 dist/
    expect(result.added).toEqual(['dist/'])
    expect(putBodies.length).toBe(1)
    expect(putBodies[0].path).toBe('.gitignore')
    expect(putBodies[0].content).toBe('# 我的规则\nnode_modules\n*.log\ndist/\n')
  })

  test('.gitignore 不存在时创建并写入规则', async () => {
    const { putBodies } = stubEditorFile({ existing: null })
    const store = useGitStore()

    const result = await store.ensureGitignore(['frontend/node_modules/'])

    expect(result.ok).toBe(true)
    expect(result.added).toEqual(['frontend/node_modules/'])
    expect(putBodies[0].content).toBe('frontend/node_modules/\n')
  })

  test('规则都已存在时不写文件', async () => {
    const { putBodies } = stubEditorFile({ existing: 'node_modules/\ndist/\n' })
    const store = useGitStore()

    const result = await store.ensureGitignore(['node_modules/', 'dist/'])

    expect(result.ok).toBe(true)
    expect(result.added).toEqual([])
    expect(putBodies.length).toBe(0)
  })

  test('写入失败时如实返回 ok=false 与原因,不谎报成功', async () => {
    const { putBodies } = stubEditorFile({ existing: null, writeOk: false, writeError: '磁盘只读' })
    const store = useGitStore()

    const result = await store.ensureGitignore(['node_modules/'])

    expect(putBodies.length).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('磁盘只读')
  })
})

// ---------------------------------------------------------------------------
// findGeneratedDirPrefix / buildInitialCommitGitignoreRules
//
// 前者决定"哪些文件算生成产物",后者决定"往用户 .gitignore 里写什么"。
// 两者串起来就是"拦截 → 一键补规则"的判定核心:
//   - 判错 → 要么漏拦(node_modules 进了首个提交),要么误拦(正常源码项目被卡)
//   - 规则拼错 → 直接写坏用户的 .gitignore
// 所以单独锁死边界。
// ---------------------------------------------------------------------------
describe('findGeneratedDirPrefix', () => {
  test('命中根级生成目录', () => {
    expect(findGeneratedDirPrefix('node_modules/vue/index.js')).toBe('node_modules')
    expect(findGeneratedDirPrefix('dist/bundle.js')).toBe('dist')
  })

  test('命中多级路径,返回截止生成目录的前缀', () => {
    expect(findGeneratedDirPrefix('frontend/node_modules/vue/index.js')).toBe('frontend/node_modules')
    expect(findGeneratedDirPrefix('packages/a/.next/server/x.js')).toBe('packages/a/.next')
  })

  test('大小写不敏感(node_modules / NODE_MODULES 都算)', () => {
    expect(findGeneratedDirPrefix('NODE_MODULES/vue/index.js')).toBe('NODE_MODULES')
  })

  test('只看目录段:恰好叫 dist 的文件不算生成产物', () => {
    // 这是最容易写错的地方 —— 若改成对整条路径 includes(),
    // docs/dist.md 会被误判成生成产物,导致正常项目被拦。
    expect(findGeneratedDirPrefix('docs/dist.md')).toBeNull()
    expect(findGeneratedDirPrefix('src/build.ts')).toBeNull()
  })

  test('普通源文件与空路径返回 null', () => {
    expect(findGeneratedDirPrefix('src/index.ts')).toBeNull()
    expect(findGeneratedDirPrefix('README.md')).toBeNull()
    expect(findGeneratedDirPrefix('')).toBeNull()
  })

  test('生成目录本身作为最后一段时不算(由上层保证只传文件路径)', () => {
    // 传入 'node_modules' 这种纯目录名时,最后一段被当作文件名,不命中
    expect(findGeneratedDirPrefix('node_modules')).toBeNull()
  })
})

describe('buildInitialCommitGitignoreRules', () => {
  test('生成目录带 / 后缀,并补上工具运行产物 .port', () => {
    const rules = buildInitialCommitGitignoreRules({
      total: 10,
      generated: [
        { path: 'node_modules', count: 8 },
        { path: 'frontend/dist', count: 2 }
      ],
      topDirs: [],
      suspicious: true
    })

    expect(rules).toEqual(['node_modules/', 'frontend/dist/', '.port'])
  })

  test('即使没有命中生成目录,也要带上 .port', () => {
    // `g ui` 会把监听端口写进 cwd/.port。若这里不带上,用户点完"补充 .gitignore"
    // 首个提交仍会带上 .port —— 正是本功能想避免的那类噪音。
    const rules = buildInitialCommitGitignoreRules({
      total: 1200,
      generated: [],
      topDirs: [{ path: 'src', count: 1200 }],
      suspicious: true
    })

    expect(rules).toEqual(['.port'])
  })

  test('scope 为 null 时仍返回 .port,不抛异常', () => {
    // 确认框渲染依赖 store.initialCommitScope,理论上不会为 null;
    // 但模板侧已按可选链取值,这里保证不会因为 null 崩掉。
    expect(buildInitialCommitGitignoreRules(null)).toEqual(['.port'])
  })

  test('幂等:同一 scope 反复调用结果一致', () => {
    const scope = {
      total: 3,
      generated: [{ path: 'node_modules', count: 3 }],
      topDirs: [],
      suspicious: true
    }

    expect(buildInitialCommitGitignoreRules(scope)).toEqual(buildInitialCommitGitignoreRules(scope))
  })
})

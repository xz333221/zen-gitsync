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
// RemoteReposList.vue 回归测试。
//
// 覆盖四种状态各自的渲染(未安装 / 未登录 / 列表 / 拉取失败),外加这个组件
// 唯一的行为承诺:**一键安装之后自动轮询,装好就把仓库列表刷出来** ——
// 那条链路(点击 → POST /api/install-tool → 定时重拉 → 状态翻成已安装)是需求里
// 明确点名的,必须有用例钉住,否则以后改轮询很容易悄悄失效。
//
// $t 用最小插值实现(而不是 vitest.setup 的 identity):要断言的正是
// 「未检测到 gh」这种**带参数**的文案,identity 会把参数丢掉。
// 不带参数时剥掉 `@NS:` 前缀,还原成中文原文 —— 这正是真实 $t 在 zh 下的行为,
// 这样断言可以直接写中文,读起来和界面一致。
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

const { $tInterp } = vi.hoisted(() => ({
  $tInterp: (key: string, params?: Record<string, unknown>) => {
    const text = String(key).replace(/^@[A-Z0-9_]+:/, '')
    return params
      ? text.replace(/\{(\w+)\}/g, (_m, k) => String((params as Record<string, unknown>)[k] ?? `{${k}}`))
      : text
  },
}))

vi.mock('@/lang/static', () => ({ $t: $tInterp }))

// 目录选择器是模态,单测里不让它真渲染(它自带一堆 DOM 与副作用),
// 但 props 要留着 —— 「克隆到文件夹」的用例要断言它被打开、且 mode=directory
vi.mock('local-file-picker/client', () => ({
  FilePickerModal: {
    name: 'FilePickerModal',
    props: ['visible', 'mode', 'theme', 'locale'],
    emits: ['confirm', 'close'],
    template: '<div class="fake-file-picker" />',
  },
}))

import RemoteReposList from './RemoteReposList.vue'
import { ElMessage } from 'element-plus'
import { mountWithSetup } from '@/test-utils/mount'
import { resetLocalClones } from '@/utils/localClones'
import { resetRemoteReposCache } from '@/utils/remoteReposCache'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const flushAll = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await flush()
}

/** 服务端 /api/remote-repos 的响应骨架(字段与 remoteRepos.js 的契约一致) */
function payload(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    provider: 'github',
    cli: 'gh',
    label: 'GitHub',
    platform: 'win32',
    docsUrl: 'https://cli.github.com/',
    loginCommand: 'gh auth login',
    installer: {
      supported: true,
      command: 'winget install --id GitHub.cli -e --accept-package-agreements --accept-source-agreements',
      packageManager: 'winget',
      docsUrl: 'https://cli.github.com/',
      note: '将在新终端中通过 winget 安装 GitHub CLI。',
    },
    installed: true,
    version: '2.101.0',
    authenticated: true,
    user: 'xz333221',
    repos: [],
    truncated: false,
    error: null,
    ...overrides,
  }
}

function repo(overrides: Record<string, unknown> = {}) {
  return {
    name: 'zen-gitsync',
    fullName: 'xz333221/zen-gitsync',
    description: 'Auto commit and visual GUI for Git',
    isPrivate: false,
    isFork: false,
    language: 'JavaScript',
    stars: 1,
    forks: 0,
    license: null,
    defaultBranch: 'main',
    updatedAt: '2026-09-22T12:00:00Z',
    pushedAt: '2026-09-22T12:00:00Z',
    createdAt: '2025-01-01T12:00:00Z',
    url: 'https://github.com/xz333221/zen-gitsync',
    ...overrides,
  }
}

/** 卡片显示顺序(仓库名) —— 排序断言只看这个,不去比整段 DOM */
const cardNames = (w: { findAll: (s: string) => Array<{ text: () => string }> }) =>
  w.findAll('.repo-card__name-base').map((el) => el.text())

/** 按 URL 分派的 fetch mock;/api/remote-repos 的响应取自 remoteQueue(耗尽后复用最后一个)。
 *  localRepos 是 /api/local-repos 的响应(键=本地目录,值=origin),
 *  传 null 模拟"服务端还没有这个接口"。 */
function stubFetch(
  remoteQueue: Array<Record<string, unknown>>,
  cloneResponse: Record<string, unknown> = { success: true, path: 'C:/tmp/zen-gitsync' },
  localRepos: Record<string, string> | null = {}
) {
  let index = 0
  const calls: string[] = []
  const bodies: Array<Record<string, unknown>> = []
  const loginBodies: Array<Record<string, unknown>> = []
  const cloneBodies: Array<Record<string, unknown>> = []
  const openBodies: Array<Record<string, unknown>> = []
  const guiBodies: Array<Record<string, unknown>> = []
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push(url)
    if (url.includes('/api/install-tool')) {
      bodies.push(JSON.parse(init?.body || '{}'))
      return json({ success: true, message: '安装命令已在新终端中启动' })
    }
    if (url.includes('/api/open-new-tab-gui')) {
      guiBodies.push(JSON.parse(init?.body || '{}'))
      return json({ success: true })
    }
    if (url.includes('/api/clone')) {
      cloneBodies.push(JSON.parse(init?.body || '{}'))
      return json(cloneResponse)
    }
    // 必须排在 /api/remote-repos 之前:登录接口是它的子路径,顺序写反了
    // 登录请求会被当成列表请求,把轮询队列白吃掉一格。
    if (url.includes('/api/remote-repos/login')) {
      loginBodies.push(JSON.parse(init?.body || '{}'))
      return json({ success: true })
    }
    if (url.includes('/api/remote-repos')) {
      const body = remoteQueue[Math.min(index, remoteQueue.length - 1)]
      index += 1
      return json(body)
    }
    if (url.includes('/api/local-repos')) {
      // null = 模拟"服务端还是旧进程、没有这个接口":SPA 兜底会回一份 HTML,
      // 前端 JSON.parse 失败 —— 徽标必须安静地缺席,不能把列表带崩
      if (localRepos === null) {
        return new Response('<!DOCTYPE html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      }
      return json({ success: true, scanning: false, scannedAt: 1, repos: localRepos || {} })
    }
    if (url.includes('/api/open_directory')) {
      openBodies.push(JSON.parse(init?.body || '{}'))
      return json({ success: true, message: '已在文件管理器中打开目录' })
    }
    return json({})
  })
  return { spy, calls, bodies, loginBodies, cloneBodies, openBodies, guiBodies }
}

function mount(provider: 'github' | 'gitee' = 'github') {
  return mountWithSetup(RemoteReposList as any, {
    props: { provider },
    global: { mocks: { $t: $tInterp } },
  })
}

beforeEach(() => {
  // 缓存是模块级的(刻意如此 —— 见 utils/remoteReposCache.ts),不重置的话
  // 前一个用例拉到的 payload 会被后一个用例当成"切回 Tab 的缓存"直接用掉,
  // 断言里那个"应该发出的请求"就永远等不到了。
  resetRemoteReposCache()
  // 「本地已克隆」的映射同样是模块级缓存(utils/localClones.ts),同一个理由
  resetLocalClones()
  vi.spyOn(window, 'open').mockImplementation(() => null as any)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('RemoteReposList.vue', () => {
  test('未安装 CLI:给出安装命令和「一键安装」,不渲染列表', async () => {
    stubFetch([payload({ installed: false, version: null, authenticated: false, user: null, repos: [] })])
    const w = mount()
    await flushAll()

    const text = w.text()
    expect(text).toContain('未检测到 gh')
    // 需求里点名的"提供一键安装的命令"—— 命令本身要能看到
    expect(w.find('.repo-list__cmd code').text()).toContain('winget install --id GitHub.cli')
    expect(text).toContain('一键安装')
    expect(w.findAll('.repo-card')).toHaveLength(0)
  })

  test('一键安装:提交 tool id 之后自动轮询,装好就把仓库刷出来', async () => {
    vi.useFakeTimers()
    const { bodies, calls } = stubFetch([
      // 第 1 次(挂载时):未安装
      payload({ installed: false, version: null, authenticated: false, user: null, repos: [] }),
      // 轮询第 1 次:还没好
      payload({ installed: false, version: null, authenticated: false, user: null, repos: [] }),
      // 轮询第 2 次:装好了 → 应自动带出仓库
      payload({ installed: true, repos: [repo()] }),
    ])
    const w = mount()
    await vi.advanceTimersByTimeAsync(0)

    const installBtn = w.findAll('button').find((b) => b.text().includes('一键安装'))
    expect(installBtn).toBeTruthy()
    await installBtn!.trigger('click')
    await vi.advanceTimersByTimeAsync(0)

    // 提交的是 tool id(github → gh),命令由服务端决定,前端不拼命令
    expect(bodies).toEqual([{ tool: 'gh' }])

    // 轮询第 1 次:仍然未安装
    await vi.advanceTimersByTimeAsync(5000)
    expect(w.findAll('.repo-card')).toHaveLength(0)

    // 轮询第 2 次:检测到已安装 → 列表自动出现(querySelector 已包含新响应)
    await vi.advanceTimersByTimeAsync(5000)
    expect(w.findAll('.repo-card')).toHaveLength(1)
    expect(w.text()).toContain('zen-gitsync')
    expect(w.text()).not.toContain('未检测到 gh')

    // 装完之后不该继续轮询:再推进时间不应该再发 remote-repos 请求
    const remoteCalls = calls.filter((u) => u.includes('/api/remote-repos')).length
    await vi.advanceTimersByTimeAsync(20000)
    expect(calls.filter((u) => u.includes('/api/remote-repos')).length).toBe(remoteCalls)
  })

  test('已安装但未登录:展示登录引导与登录命令,不拉仓库', async () => {
    const { calls } = stubFetch([
      payload({ installed: true, authenticated: false, user: null, repos: [] }),
    ])
    const w = mount()
    await flushAll()

    const text = w.text()
    expect(text).toContain('gh 尚未登录')
    expect(w.find('.repo-list__cmd code').text()).toBe('gh auth login')
    expect(text).toContain('我已登录，重新检测')
    // 未登录时只有一次探测请求,不应该再去 repo list
    expect(calls.filter((u) => u.includes('/api/remote-repos'))).toHaveLength(1)
  })

  test('已登录:渲染仓库卡片 + 账号名 + 数量', async () => {
    stubFetch([payload({ repos: [repo(), repo({ name: 'file-guard', fullName: 'xz333221/file-guard', stars: 0, isPrivate: true })] })])
    const w = mount()
    await flushAll()

    expect(w.findAll('.repo-card')).toHaveLength(2)
    expect(w.text()).toContain('已登录 xz333221')
    expect(w.text()).toContain('共 2 个仓库')
    // 私有徽标只出现在私有仓库那张卡上(按内容找卡片,不按下标 —— 默认排序
    // 按推送时间,先后来回变,写死下标会随排序规则一起碎)
    const cards = w.findAll('.repo-card')
    const privateCard = cards.find((c) => c.text().includes('file-guard'))!
    const publicCard = cards.find((c) => c.text().includes('zen-gitsync'))!
    expect(privateCard.findAll('.repo-card__tag').some((t) => t.text() === '私有')).toBe(true)
    expect(publicCard.findAll('.repo-card__tag').some((t) => t.text() === '私有')).toBe(false)
  })

  test('已登录:搜索按仓库名/描述过滤,清空后恢复', async () => {
    stubFetch([
      payload({
        repos: [
          repo(),
          repo({ name: 'file-guard', fullName: 'xz333221/file-guard', description: '文件守卫' }),
        ],
      }),
    ])
    const w = mount()
    await flushAll()
    expect(w.findAll('.repo-card')).toHaveLength(2)

    const input = w.find('.repo-list__search-input')
    await input.setValue('guard')
    expect(w.findAll('.repo-card')).toHaveLength(1)
    expect(w.text()).toContain('file-guard')

    await input.setValue('不存在的仓库')
    expect(w.findAll('.repo-card')).toHaveLength(0)
    expect(w.text()).toContain('没有匹配')

    await w.find('.repo-list__search-clear').trigger('click')
    expect(w.findAll('.repo-card')).toHaveLength(2)
  })

  // ── 排序:两个平台的 CLI 原始顺序并不一致(gh 按推送倒序 / gitee 按 full_name
  //    字母序),面板里统一在前端排,不然切个 Tab 就换一种排法 ──────────────────
  test('默认按最近推送倒序:', async () => {
    stubFetch([
      payload({
        repos: [
          repo({ name: 'old', fullName: 'xz333221/old', pushedAt: '2026-01-01T12:00:00Z' }),
          repo({ name: 'newest', fullName: 'xz333221/newest', pushedAt: '2026-09-01T12:00:00Z' }),
          repo({ name: 'middle', fullName: 'xz333221/middle', pushedAt: '2026-05-01T12:00:00Z' }),
        ],
      }),
    ])
    const w = mount()
    await flushAll()

    expect(cardNames(w)).toEqual(['newest', 'middle', 'old'])
  })

  test('切换排序:仓库名 / 星标最多 / 最近创建,切回去还能回到原顺序', async () => {
    stubFetch([
      payload({
        repos: [
          repo({ name: 'beta', fullName: 'xz333221/beta', pushedAt: '2026-09-01T12:00:00Z', stars: 1, createdAt: '2026-06-01T12:00:00Z' }),
          repo({ name: 'Alpha', fullName: 'xz333221/Alpha', pushedAt: '2026-08-01T12:00:00Z', stars: 9, createdAt: '2026-01-01T12:00:00Z' }),
          repo({ name: 'gamma', fullName: 'xz333221/gamma', pushedAt: '2026-07-01T12:00:00Z', stars: 5, createdAt: '2026-03-01T12:00:00Z' }),
        ],
      }),
    ])
    const w = mount()
    await flushAll()
    expect(cardNames(w)).toEqual(['beta', 'Alpha', 'gamma'])

    const select = w.find('.repo-list__sort-select')
    // 名称:大小写不敏感(与 gitee CLI 的字母序口径一致,大写开头不会乱插队)
    await select.setValue('name')
    expect(cardNames(w)).toEqual(['Alpha', 'beta', 'gamma'])

    await select.setValue('stars')
    expect(cardNames(w)).toEqual(['Alpha', 'gamma', 'beta'])

    await select.setValue('created')
    expect(cardNames(w)).toEqual(['beta', 'gamma', 'Alpha'])

    // 排序是"排副本"——回来还应该是服务端给的原始相对顺序,而不是被上一次排序改过
    await select.setValue('pushed')
    expect(cardNames(w)).toEqual(['beta', 'Alpha', 'gamma'])
  })

  // ── 分组:同一工作空间(owner)下的仓库收拢在一起 ───────────────────────
  //   用户实测反馈:纯按时间平铺时,同一个空间下的仓库被打散在整屏里 ——
  //   空间下只有三五个仓库,想回答"我这个空间下都有哪些项目"只能靠肉眼在几十张卡里捞。

  /** 两个空间各两个仓库:pushed 序与名称序的组间先后正好相反,
   *  这样"组间顺序也跟随排序规则"才验得出来(同序的话切换前后一样,断言等于没断)。
   *  描述留空 —— 这样"第二行该显示什么"的断言不会被描述挡在前面。 */
  const twoWorkspaces = () => [
    repo({ name: 'zzz-old', fullName: 'zzz/zzz-old', description: '', pushedAt: '2026-09-10T12:00:00Z' }),
    repo({ name: 'zzz-new', fullName: 'zzz/zzz-new', description: '', pushedAt: '2026-09-20T12:00:00Z' }),
    repo({ name: 'aaa-new', fullName: 'aaa/aaa-new', description: '', pushedAt: '2026-09-15T12:00:00Z' }),
    repo({ name: 'aaa-old', fullName: 'aaa/aaa-old', description: '', pushedAt: '2026-09-01T12:00:00Z' }),
  ]

  const groupOwners = (w: { findAll: (s: string) => Array<{ text: () => string }> }) =>
    w.findAll('.repo-group__owner').map((el) => el.text())

  test('默认按工作空间分组:同一 owner 的仓库连在一起,组头写明空间名与数量', async () => {
    stubFetch([payload({ repos: twoWorkspaces() })])
    const w = mount()
    await flushAll()

    // 组间顺序 = 组内排最前的那个仓库的位次:zzz 组有 09-20 的推送 → 整组排前面
    expect(cardNames(w)).toEqual(['zzz-new', 'zzz-old', 'aaa-new', 'aaa-old'])
    expect(groupOwners(w)).toEqual(['zzz', 'aaa'])
    expect(w.findAll('.repo-group__count').map((el) => el.text())).toEqual(['2', '2'])
    // 顺序对还不够 —— 那也可能是"恰好排成这样"。同一个空间必须落在同一个容器里,
    // 分组容器本身才是承诺(改回平铺而顺序碰巧一致时,这条会碎)
    expect(w.findAll('.repo-group__grid')).toHaveLength(2)
  })

  test('切换排序:组间顺序也跟随排序规则,不只是组内重排', async () => {
    stubFetch([payload({ repos: twoWorkspaces() })])
    const w = mount()
    await flushAll()

    await w.find('.repo-list__sort-select').setValue('name')
    // 名称序下 aaa/... 排在 zzz/... 前面 → 连组带卡整体翻过来
    expect(cardNames(w)).toEqual(['aaa-new', 'aaa-old', 'zzz-new', 'zzz-old'])
    expect(groupOwners(w)).toEqual(['aaa', 'zzz'])
  })

  test('切「不分组」:回到全局排序,组头消失,卡片第二行退回 fullName', async () => {
    stubFetch([payload({ repos: twoWorkspaces() })])
    const w = mount()
    await flushAll()

    await w.find('.repo-list__group-select').setValue('none')
    // 跨空间按推送时间平铺:zzz-new(09-20) → aaa-new(09-15) → zzz-old(09-10) → aaa-old(09-01)
    expect(cardNames(w)).toEqual(['zzz-new', 'aaa-new', 'zzz-old', 'aaa-old'])
    expect(w.findAll('.repo-group__head')).toHaveLength(0)
    // 没有组头就等于没有"这是哪个空间"的线索,第二行必须把 fullName 还回来
    expect(w.findAll('.repo-card__name-path').map((el) => el.text()))
      .toEqual(['zzz/zzz-new', 'aaa/aaa-new', 'zzz/zzz-old', 'aaa/aaa-old'])
  })

  test('只有一个工作空间时不渲染组头(那时它只是把每张卡片的前缀重复一遍)', async () => {
    stubFetch([payload({ repos: [repo()] })])
    const w = mount()
    await flushAll()

    expect(w.findAll('.repo-card')).toHaveLength(1)
    expect(w.findAll('.repo-group__head')).toHaveLength(0)
  })

  test('分组态下的卡片第二行:有描述才渲染,没描述整行不出现', async () => {
    stubFetch([
      payload({
        repos: [
          repo({ name: 'documented', fullName: 'zzz/documented', description: '有描述的仓库' }),
          repo({ name: 'bare', fullName: 'aaa/bare', description: '' }),
        ],
      }),
    ])
    const w = mount()
    await flushAll()

    const cards = w.findAll('.repo-card')
    const documented = cards.find((c) => c.find('.repo-card__name-base').text() === 'documented')!
    const bare = cards.find((c) => c.find('.repo-card__name-base').text() === 'bare')!
    // 空间名已经在组头上,卡片里不再重复 fullName,只留描述
    expect(documented.find('.repo-card__name-path').text()).toBe('有描述的仓库')
    expect(bare.find('.repo-card__name-path').exists()).toBe(false)
  })

  test('搜索命中的仓库照样按空间分组', async () => {
    stubFetch([
      payload({
        repos: [
          repo({ name: 'book-a', fullName: 'zzz/book-a' }),
          repo({ name: 'note', fullName: 'aaa/note' }),
          repo({ name: 'book-b', fullName: 'aaa/book-b' }),
        ],
      }),
    ])
    const w = mount()
    await flushAll()

    await w.find('.repo-list__search-input').setValue('book')
    // 三条仓库的推送时间相同 → 排序退化成名称序,aaa/book-b 在 zzz/book-a 之前
    expect(cardNames(w)).toEqual(['book-b', 'book-a'])
    // 命中两个空间各一条,组头仍要写清楚谁是谁
    expect(groupOwners(w)).toEqual(['aaa', 'zzz'])
  })

  test('卡片第三行:最近推送 / Fork 数 / 非默认分支 / 许可证,没有的项不留占位', async () => {
    stubFetch([
      payload({
        repos: [
          repo({
            name: 'rich',
            fullName: 'xz333221/rich',
            pushedAt: '2026-09-20T12:00:00Z',
            forks: 3,
            defaultBranch: 'develop',
            license: 'MIT',
          }),
          repo({
            name: 'bare',
            fullName: 'xz333221/bare',
            pushedAt: '2026-09-19T12:00:00Z',
            forks: 0,
            defaultBranch: 'main',
            license: null,
          }),
        ],
      }),
    ])
    const w = mount()
    await flushAll()

    const [rich, bare] = w.findAll('.repo-card')
    expect(rich.find('.repo-card__meta').text()).toBe('更新于 2026-09-20 · 3 个 Fork · 分支 develop · MIT')
    // main 分支 / 0 个 Fork / 无许可证都省略 —— 满屏 "main" 和 "0 Fork" 是纯噪音
    expect(bare.find('.repo-card__meta').text()).toBe('更新于 2026-09-19')
  })

  test('搜到几条先说几条:总数提示变成「匹配 M / 共 N」', async () => {
    stubFetch([
      payload({ repos: [repo(), repo({ name: 'file-guard', fullName: 'xz333221/file-guard' })] }),
    ])
    const w = mount()
    await flushAll()
    expect(w.text()).toContain('共 2 个仓库')

    await w.find('.repo-list__search-input').setValue('guard')
    expect(w.text()).toContain('匹配 1 / 共 2 个仓库')
  })

  test('已登录:点卡片在浏览器打开仓库主页', async () => {
    stubFetch([payload({ repos: [repo()] })])
    const w = mount()
    await flushAll()

    await w.find('.repo-card__btn').trigger('click')
    expect(window.open).toHaveBeenCalledWith(
      'https://github.com/xz333221/zen-gitsync',
      '_blank',
      'noopener,noreferrer'
    )
  })

  test('拉取失败:就地展示原因并提供重试,而不是空白列表', async () => {
    stubFetch([
      payload({ repos: [], error: 'gh repo list 超时(25 秒),请检查网络或代理设置' }),
    ])
    const w = mount()
    await flushAll()

    expect(w.text()).toContain('超时')
    expect(w.findAll('.repo-card')).toHaveLength(0)
    expect(w.text()).toContain('重试')
  })

  test('服务未重启(接口落到 SPA 兜底返回 HTML):给出「需重启」的提示,而不是 Unexpected token <', async () => {
    // 后端还是旧进程、没有 /api/remote-repos 时,Express 会返回 index.html ——
    // 直接 res.json() 抛的是 "Unexpected token '<', "<!DOCTYPE "... is not valid JSON",
    // 用户完全无从下手(实测撞到过)。必须翻译成一句能指导动作的话。
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('<!DOCTYPE html><html><body>app</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    )
    const w = mount()
    await flushAll()

    const text = w.text()
    expect(text).toContain('服务未重启')
    expect(text).not.toContain('Unexpected token')
    expect(text).toContain('重试')
  })

  test('有旧数据时拉取失败:保留列表,只在顶部补一条提示', async () => {
    stubFetch([
      payload({ repos: [repo()], error: 'gh repo list 超时(25 秒),请检查网络或代理设置' }),
    ])
    const w = mount()
    await flushAll()

    expect(w.findAll('.repo-card')).toHaveLength(1)
    expect(w.find('.repo-list__banner').text()).toContain('超时')
  })

  test('gitee provider:文案与安装命令走 Gitee 那一套', async () => {
    stubFetch([
      payload({
        provider: 'gitee',
        cli: 'gitee',
        label: 'Gitee',
        loginCommand: 'gitee auth login',
        installed: false,
        version: null,
        authenticated: false,
        user: null,
        installer: {
          supported: true,
          command: 'npm install -g @gitee/gitee-cli',
          packageManager: 'npm',
          docsUrl: 'https://gitee.com/oschina/gitee-cli',
          note: '',
        },
      }),
    ])
    const w = mount('gitee')
    await flushAll()

    expect(w.text()).toContain('未检测到 gitee')
    expect(w.find('.repo-list__cmd code').text()).toBe('npm install -g @gitee/gitee-cli')
  })

  test('gitee 一键安装:提交的 tool id 是 gitee(不是 provider 名)', async () => {
    vi.useFakeTimers()
    const { bodies } = stubFetch([
      payload({
        provider: 'gitee',
        cli: 'gitee',
        installed: false,
        version: null,
        authenticated: false,
        user: null,
      }),
    ])
    const w = mount('gitee')
    await vi.advanceTimersByTimeAsync(0)

    const installBtn = w.findAll('button').find((b) => b.text().includes('一键安装'))
    await installBtn!.trigger('click')
    await vi.advanceTimersByTimeAsync(0)

    expect(bodies).toEqual([{ tool: 'gitee' }])
  })

  // ── UAC 提醒(2026-09-22 用户实测:漏点提权弹窗 → MSI 退出码 1602)──────────
  test('Windows + winget:安装引导里要写明会弹 UAC,并且点出失败错误码 1602', async () => {
    stubFetch([payload({ installed: false, version: null, authenticated: false, user: null, repos: [] })])
    const w = mount()
    await flushAll()

    const warn = w.find('.repo-list__guide-note--warn')
    expect(warn.exists()).toBe(true)
    // 不点「是」= 1602。不写这句的话,用户只会看到一个光秃秃的错误码,
    // 会去怀疑网络/winget/权限 —— 全是错的方向(实测就是这么绕了一圈)。
    expect(warn.text()).toContain('UAC')
    expect(warn.text()).toContain('1602')
  })

  test('npm 装 gitee(全局前缀在用户目录,不提权):不显示 UAC 提醒', async () => {
    stubFetch([
      payload({
        provider: 'gitee',
        cli: 'gitee',
        label: 'Gitee',
        loginCommand: 'gitee auth login',
        installed: false,
        version: null,
        authenticated: false,
        user: null,
        installer: {
          supported: true,
          command: 'npm install -g @gitee/gitee-cli',
          packageManager: 'npm',
          docsUrl: 'https://gitee.com/oschina/gitee-cli',
          note: '',
        },
      }),
    ])
    const w = mount('gitee')
    await flushAll()

    expect(w.find('.repo-list__guide-note--warn').exists()).toBe(false)
  })

  test('macOS + Homebrew:同样不显示 UAC 提醒(那是 Windows 特有的)', async () => {
    stubFetch([
      payload({
        platform: 'darwin',
        installed: false,
        version: null,
        authenticated: false,
        user: null,
        installer: {
          supported: true,
          command: 'brew install gh',
          packageManager: 'Homebrew',
          docsUrl: 'https://cli.github.com/',
          note: '将在新终端中通过 Homebrew 安装 GitHub CLI。',
        },
      }),
    ])
    const w = mount()
    await flushAll()

    expect(w.find('.repo-list__guide-note--warn').exists()).toBe(false)
  })

  // ── 一键登录:登录是交互式的,界面只负责"开终端 + 等结果" ──────────────────
  test('未登录屏:提供「一键登录」按钮,同时保留可复制的登录命令', async () => {
    stubFetch([payload({ authenticated: false, user: null, repos: [] })])
    const w = mount()
    await flushAll()

    expect(w.text()).toContain('gh 尚未登录')
    expect(w.findAll('button').some((b) => b.text().includes('一键登录'))).toBe(true)
    // 一键只是捷径:命令本身还得看得见、复制得了(用户可以自己在终端里跑)
    expect(w.find('.repo-list__cmd code').text()).toBe('gh auth login')
  })

  test('一键登录:提交 provider 后轮询,登录成功就自动把仓库刷出来', async () => {
    vi.useFakeTimers()
    const { loginBodies } = stubFetch([
      // 挂载:已装未登录
      payload({ authenticated: false, user: null, repos: [] }),
      // 轮询第 1 次:用户还在终端里走问答
      payload({ authenticated: false, user: null, repos: [] }),
      // 轮询第 2 次:登录成功 → 自动带出仓库
      payload({ authenticated: true, user: 'xz333221', repos: [repo()] }),
    ])
    const w = mount()
    await vi.advanceTimersByTimeAsync(0)

    const loginBtn = w.findAll('button').find((b) => b.text().includes('一键登录'))
    expect(loginBtn).toBeTruthy()
    await loginBtn!.trigger('click')
    await vi.advanceTimersByTimeAsync(0)

    // 前端不拼命令,只提交 provider(与一键安装提交 tool id 同一条原则)
    expect(loginBodies).toEqual([{ provider: 'github' }])
    expect(w.text()).toContain('登录中...')
    expect(w.text()).toContain('请在终端中完成登录')

    await vi.advanceTimersByTimeAsync(5000)
    expect(w.text()).toContain('登录中...')

    await vi.advanceTimersByTimeAsync(5000)
    // 登录成功后:等待提示收掉,列表自动出来,不用回来点「重新检测」
    expect(w.text()).toContain('已登录 xz333221')
    expect(w.findAll('.repo-card').length).toBeGreaterThan(0)
    expect(w.text()).not.toContain('登录中...')
  })

  // ── 缓存:切 Tab 不该重新跑一遍 CLI ───────────────────────────────────────
  //   App.vue 里两个仓库面板是 v-if(切走即卸载),所以"切回 Tab"在测试里就是
  //   unmount 之后再 mount 一次。缓存实体在 utils/remoteReposCache.ts。
  //   用户实测反馈的正是"每点一次 Tab 都重新加载"(每条都是一次 `gh repo list`)。

  test('切走再切回:直接拿缓存渲染,一个请求都不发', async () => {
    const { calls } = stubFetch([payload({ repos: [repo()] })])
    const w = mount()
    await flushAll()
    expect(cardNames(w)).toEqual(['zen-gitsync'])
    w.unmount()

    const w2 = mount()
    // 挂载即出列表 —— 不该有"加载中"那一帧(出现了说明缓存没被用上)
    expect(w2.text()).not.toContain('加载中')
    expect(cardNames(w2)).toEqual(['zen-gitsync'])

    await flushAll()
    expect(calls.filter((u) => u.includes('/api/remote-repos'))).toHaveLength(1)
  })

  test('缓存过期:先把旧快照画出来,再在后台静默重拉替换', async () => {
    vi.useFakeTimers()
    const { calls } = stubFetch([
      payload({ repos: [repo({ name: 'snapshot', fullName: 'xz333221/snapshot' })] }),
      payload({ repos: [repo({ name: 'fresh', fullName: 'xz333221/fresh' })] }),
    ])
    const w = mount()
    await vi.advanceTimersByTimeAsync(0)
    expect(cardNames(w)).toEqual(['snapshot'])
    w.unmount()

    // 跨过 TTL:缓存还在,只是不再新鲜
    await vi.advanceTimersByTimeAsync(61_000)

    const w2 = mount()
    // 首帧就是旧快照:不转圈、不空屏(过期不等于作废)
    expect(w2.text()).not.toContain('加载中')
    expect(cardNames(w2)).toEqual(['snapshot'])
    // 后台那一次拉回来之后换成新的,用户全程没被打断
    await vi.advanceTimersByTimeAsync(0)
    expect(cardNames(w2)).toEqual(['fresh'])
    expect(calls.filter((u) => u.includes('/api/remote-repos'))).toHaveLength(2)
  })

  test('后台重拉失败:不动已经画好的列表(一次网络抖动不该把屏换成错误页)', async () => {
    vi.useFakeTimers()
    let round = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url
      // 「已克隆」那次探测与列表无关,单独给个空结果:它不能占下面的轮次计数
      // (这个 mock 按"第几次调用"决定成功还是失败,混进一次别的请求就串位了)
      if (url.includes('/api/local-repos')) {
        return json({ success: true, scanning: false, repos: {} })
      }
      round += 1
      return round === 1
        ? json(payload({ repos: [repo()] }))
        : json({ success: false, error: 'gh repo list 超时(25 秒),请检查网络或代理设置' }, 500)
    })
    const w = mount()
    await vi.advanceTimersByTimeAsync(0)
    expect(cardNames(w)).toEqual(['zen-gitsync'])
    w.unmount()

    await vi.advanceTimersByTimeAsync(61_000)
    const w2 = mount()
    await vi.advanceTimersByTimeAsync(0)

    // 列表还在、数量提示还在,没有变成那屏"仓库列表加载失败"
    expect(cardNames(w2)).toEqual(['zen-gitsync'])
    expect(w2.text()).toContain('共 1 个仓库')
  })

  test('点「刷新」无视缓存新鲜度,真的重新拉一次', async () => {
    const { calls } = stubFetch([
      payload({ repos: [repo({ name: 'before', fullName: 'xz333221/before' })] }),
      payload({ repos: [repo({ name: 'after', fullName: 'xz333221/after' })] }),
    ])
    const w = mount()
    await flushAll()
    expect(cardNames(w)).toEqual(['before'])

    await w.find('.repo-list__action').trigger('click')
    await flushAll()

    // 缓存还新鲜,但用户点了刷新 —— 就该真的去拉,拿新的盖掉旧的
    expect(cardNames(w)).toEqual(['after'])
    expect(calls.filter((u) => u.includes('/api/remote-repos'))).toHaveLength(2)
  })

  test('点「刷新」顺带让服务端重扫本机仓库 —— 在终端里 clone 完回来刷新,徽标才是准的', async () => {
    // 服务端那份"本机仓库清单"是落盘缓存(TTL 10 分钟),不主动重扫的话,
    // 用户在外面 clone 完再回来点刷新,卡片上还是缺徽标 —— 看着就像刷新没生效
    const { calls } = stubFetch([payload({ repos: [repo()] })])
    const w = mount()
    await flushAll()
    calls.length = 0

    await w.find('.repo-list__action').trigger('click')
    await flushAll()

    expect(calls.filter((u) => u.includes('/api/local-repos/scan'))).toHaveLength(1)
  })

  test('两个平台各存一份:切到 Gitee 再切回来,GitHub 那份还在且不串台', async () => {
    const { calls } = stubFetch([
      payload({ repos: [repo({ name: 'gh-only', fullName: 'xz333221/gh-only' })] }),
      payload({
        provider: 'gitee',
        cli: 'gitee',
        label: 'Gitee',
        loginCommand: 'gitee auth login',
        repos: [repo({ name: 'gitee-only', fullName: 'xz333221/gitee-only' })],
      }),
    ])
    const gh = mount('github')
    await flushAll()
    expect(cardNames(gh)).toEqual(['gh-only'])
    gh.unmount()

    // 切到 Gitee Tab:这份缓存还没有,它自己拉一次
    const gt = mount('gitee')
    await flushAll()
    expect(cardNames(gt)).toEqual(['gitee-only'])
    gt.unmount()

    // 切回 GitHub:命中的是 GitHub 那份,既不串台也不再多发一次请求
    const back = mount('github')
    expect(cardNames(back)).toEqual(['gh-only'])
    await flushAll()
    expect(calls.filter((u) => u.includes('/api/remote-repos'))).toHaveLength(2)
  })

  // ── 复制地址 ──────────────────────────────────────────────────────────
  // 操作区里两个复制按钮:HTTPS 复制仓库页地址,SSH 复制 git@ 克隆地址。
  // SSH 那一份是前端按固定规则拼的(组件里的 toSshUrl),所以这几条用例要同时
  // 钉住"按钮在不在"和"拼出来的串对不对" —— 只断言按钮存在挡不住拼错。

  /** jsdom 默认没有 navigator.clipboard,装一个可断言的进去 */
  function stubClipboard() {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })
    return writeText
  }

  test('复制 SSH 地址:GitHub 的网页地址拼成 git@ 形式', async () => {
    const writeText = stubClipboard()
    stubFetch([payload({ repos: [repo()] })])
    const w = mount()
    await flushAll()

    // 克隆到文件夹 / 复制 HTTPS / 复制 SSH / 在浏览器中打开
    const actions = w.findAll('.repo-card__action')
    expect(actions).toHaveLength(4)

    const ssh = actions.find((b) => b.attributes('title') === '复制 SSH 地址')
    expect(ssh).toBeTruthy()
    await ssh!.trigger('click')
    await flushAll()

    expect(writeText).toHaveBeenCalledWith('git@github.com:xz333221/zen-gitsync.git')
  })

  test('复制 HTTPS 地址:仍然复制仓库页地址', async () => {
    const writeText = stubClipboard()
    stubFetch([payload({ repos: [repo()] })])
    const w = mount()
    await flushAll()

    const https = w
      .findAll('.repo-card__action')
      .find((b) => b.attributes('title') === '复制 HTTPS 地址')
    expect(https).toBeTruthy()
    await https!.trigger('click')
    await flushAll()

    expect(writeText).toHaveBeenCalledWith('https://github.com/xz333221/zen-gitsync')
  })

  test('Gitee 的地址同样能拼出 SSH(host 跟着地址走,不写死 github.com)', async () => {
    const writeText = stubClipboard()
    stubFetch([
      payload({
        provider: 'gitee',
        cli: 'gitee',
        label: 'Gitee',
        loginCommand: 'gitee auth login',
        repos: [
          repo({
            name: 'xiangyu-sites',
            fullName: 'xz_web/xiangyu-sites',
            url: 'https://gitee.com/xz_web/xiangyu-sites',
          }),
        ],
      }),
    ])
    const w = mount('gitee')
    await flushAll()

    const ssh = w
      .findAll('.repo-card__action')
      .find((b) => b.attributes('title') === '复制 SSH 地址')
    expect(ssh).toBeTruthy()
    await ssh!.trigger('click')
    await flushAll()

    expect(writeText).toHaveBeenCalledWith('git@gitee.com:xz_web/xiangyu-sites.git')
  })

  test('地址不是标准网页形态时不渲染 SSH 按钮 —— 宁可少给一个,也不给一个错的', async () => {
    stubClipboard()
    stubFetch([payload({ repos: [repo({ url: '' })] })])
    const w = mount()
    await flushAll()

    const titles = w.findAll('.repo-card__action').map((b) => b.attributes('title'))
    expect(titles).toContain('复制 HTTPS 地址')
    expect(titles).not.toContain('复制 SSH 地址')
  })

  // ── 克隆到文件夹 ──────────────────────────────────────────────────────
  // 三步链路:点按钮开选择器 → 选中父目录 → POST /api/clone。
  // 重点断言"发出去的 body":地址必须是 SSH、parentDir 必须是用户选的那个目录
  // —— 这两点错了界面不会有任何异常,只会在几分钟后以超时或"克隆到别处"的形式暴露。

  /** 按 title 找卡片操作按钮 —— 按钮顺序会变,不写死下标 */
  const actionButton = (w: ReturnType<typeof mount>, title: string) =>
    w.findAll('.repo-card__action').find((b) => b.attributes('title') === title)

  const pickerOf = (w: ReturnType<typeof mount>) =>
    w.findComponent({ name: 'FilePickerModal' })

  test('点「克隆到文件夹」打开目录选择器,且是 directory 模式', async () => {
    stubFetch([payload({ repos: [repo()] })])
    const w = mount()
    await flushAll()

    expect(pickerOf(w).props('visible')).toBe(false)
    expect(pickerOf(w).props('mode')).toBe('directory')

    const cloneBtn = actionButton(w, '克隆到文件夹')
    expect(cloneBtn).toBeTruthy()
    await cloneBtn!.trigger('click')

    expect(pickerOf(w).props('visible')).toBe(true)
  })

  test('选中父目录 → POST /api/clone 带上 SSH 地址与那个目录', async () => {
    const { calls, cloneBodies, openBodies } = stubFetch([payload({ repos: [repo()] })])
    const w = mount()
    await flushAll()

    await actionButton(w, '克隆到文件夹')!.trigger('click')
    pickerOf(w).vm.$emit('confirm', ['C:/projects'])
    await flushAll()

    expect(calls).toContain('/api/clone')
    expect(cloneBodies).toEqual([
      { url: 'git@github.com:xz333221/zen-gitsync.git', parentDir: 'C:/projects' },
    ])
    // 克隆完顺手打开落点文件夹(默认响应里 path=C:/tmp/zen-gitsync)
    expect(openBodies).toEqual([{ path: 'C:/tmp/zen-gitsync' }])
    // 选完就关,不留一个悬空的模态
    expect(pickerOf(w).props('visible')).toBe(false)
  })

  test('克隆完成后:服务端已登记的新仓库立刻反映到徽标上(不等重扫)', async () => {
    // 第一次拉快照:本地还没有这个仓库 → 卡片上不该有徽标;
    // 克隆成功后服务端会就地登记它,前端那趟 force 拉回来 → 徽标当场就亮。
    // 这条钉的是"克隆完要立刻看到已克隆"这个需求,以及它**不能**靠等下一次
    // 全盘扫描(十几秒)或 TTL 过期来实现。
    let localCalls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/local-repos')) {
        localCalls += 1
        return json({
          success: true,
          scanning: false,
          repos: localCalls === 1
            ? {}
            : { 'C:/projects/zen-gitsync': 'git@github.com:xz333221/zen-gitsync.git' },
        })
      }
      if (url.includes('/api/clone')) return json({ success: true, path: 'C:/projects/zen-gitsync' })
      if (url.includes('/api/open_directory')) return json({ success: true })
      return json(payload({ repos: [repo()] }))
    })

    const w = mount()
    await flushAll()
    expect(w.findAll('.repo-card__tag').some((t) => t.text() === '已克隆')).toBe(false)

    await actionButton(w, '克隆到文件夹')!.trigger('click')
    pickerOf(w).vm.$emit('confirm', ['C:/projects'])
    await flushAll()

    expect(w.findAll('.repo-card__tag').some((t) => t.text() === '已克隆')).toBe(true)
  })

  test('克隆失败:请求确实发出去了,按钮不卡在转圈状态', async () => {
    const { cloneBodies } = stubFetch([payload({ repos: [repo()] })], {
      success: false,
      error: '目标文件夹已存在：C:/projects/zen-gitsync',
    })
    const w = mount()
    await flushAll()

    await actionButton(w, '克隆到文件夹')!.trigger('click')
    pickerOf(w).vm.$emit('confirm', ['C:/projects'])
    await flushAll()

    expect(cloneBodies).toHaveLength(1)
    expect(actionButton(w, '克隆到文件夹')!.attributes('disabled')).toBeUndefined()
  })

  test('取消选择(confirm 没带路径)不发起任何请求', async () => {
    const { cloneBodies } = stubFetch([payload({ repos: [repo()] })])
    const w = mount()
    await flushAll()

    await actionButton(w, '克隆到文件夹')!.trigger('click')
    pickerOf(w).vm.$emit('confirm', [])
    await flushAll()

    expect(cloneBodies).toHaveLength(0)
    expect(pickerOf(w).props('visible')).toBe(false)
  })

  test('推导不出 SSH 地址的仓库,克隆按钮同样不渲染', async () => {
    stubFetch([payload({ repos: [repo({ url: '' })] })])
    const w = mount()
    await flushAll()

    expect(actionButton(w, '克隆到文件夹')).toBeUndefined()
  })

  // ── 「已克隆」徽标 ──────────────────────────────────────────────────────
  // 判据是**地址对上**,不是目录名相同:本地 origin 一般写成 SSH,而列表里给的
  // 是仓库页地址 —— 两种写法必须能落到同一张卡上(归一化规则见远程仓库的
  // utils/remoteUrl.ts)。
  test('本地已有克隆的仓库标出「已克隆」,其余不标', async () => {
    const { calls } = stubFetch(
      [
        payload({
          repos: [
            repo(),
            repo({
              name: 'file-guard',
              fullName: 'xz333221/file-guard',
              description: '文件守卫',
              url: 'https://github.com/xz333221/file-guard',
            }),
          ],
        }),
      ],
      undefined,
      // 键是本地目录,值是它的 origin —— 这里故意用 SSH 写法
      { 'D:/workspace/github_workspace/zen-gitsync': 'git@github.com:xz333221/zen-gitsync.git' },
    )
    const w = mount()
    await flushAll()

    expect(calls).toContain('/api/local-repos')

    const cards = w.findAll('.repo-card')
    const cloned = cards.find((c) => c.text().includes('zen-gitsync'))!
    const notCloned = cards.find((c) => c.text().includes('file-guard'))!
    expect(cloned.findAll('.repo-card__tag').some((t) => t.text() === '已克隆')).toBe(true)
    expect(notCloned.findAll('.repo-card__tag').some((t) => t.text() === '已克隆')).toBe(false)
    // 克隆到哪写在悬浮提示里:卡片上放不下,但点克隆按钮之前正要看这个
    expect(cloned.attributes('title')).toContain(
      '本地已克隆：D:/workspace/github_workspace/zen-gitsync',
    )
    // 快捷键说明只能挂在这里 —— 徽标 hover 时会淡出给操作按钮让位,挂上去就看不见了
    expect(cloned.attributes('title')).toContain('按住 Ctrl 点击用 g ui 打开')
    expect(notCloned.attributes('title')).not.toContain('按住 Ctrl')
  })

  test('拿不到本地克隆信息(旧服务端回 HTML)时:列表照常渲染,只是没有徽标', async () => {
    stubFetch([payload({ repos: [repo()] })], undefined, null)
    const w = mount()
    await flushAll()

    expect(w.findAll('.repo-card')).toHaveLength(1)
    expect(w.findAll('.repo-card__tag').some((t) => t.text() === '已克隆')).toBe(false)
    // 徽标是补充信息,拿不到不是用户的错,不该冒提示
    expect(w.text()).not.toContain('失败')
  })

  test('Ctrl+点卡片 → 在本地那个目录里新开标签页跑 g ui,且不走"浏览器打开主页"', async () => {
    const localDir = 'D:/workspace/github_workspace/zen-gitsync'
    const { guiBodies } = stubFetch(
      [payload({ repos: [repo()] })],
      undefined,
      { [localDir]: 'git@github.com:xz333221/zen-gitsync.git' },
    )
    const w = mount()
    await flushAll()

    await w.find('.repo-card__btn').trigger('click', { ctrlKey: true })
    await flushAll()

    // 路径必须是本地那个真实落点(不是仓库名、也不是当前工作目录)
    expect(guiBodies).toEqual([{ path: localDir }])
    expect(window.open).not.toHaveBeenCalled()
  })

  test('Cmd+点卡片同理(macOS 上 Cmd 才是"新开一个"的惯用键)', async () => {
    const localDir = 'D:/w/zen-gitsync'
    const { guiBodies } = stubFetch(
      [payload({ repos: [repo()] })],
      undefined,
      { [localDir]: 'git@github.com:xz333221/zen-gitsync.git' },
    )
    const w = mount()
    await flushAll()

    await w.find('.repo-card__btn').trigger('click', { metaKey: true })
    await flushAll()

    expect(guiBodies).toEqual([{ path: localDir }])
  })

  test('普通点卡片不跑 g ui —— 仍旧是在浏览器打开仓库主页', async () => {
    const { guiBodies } = stubFetch(
      [payload({ repos: [repo()] })],
      undefined,
      { 'D:/workspace/github_workspace/zen-gitsync': 'git@github.com:xz333221/zen-gitsync.git' },
    )
    const w = mount()
    await flushAll()

    await w.find('.repo-card__btn').trigger('click')
    await flushAll()

    expect(guiBodies).toEqual([])
    expect(window.open).toHaveBeenCalledWith(
      'https://github.com/xz333221/zen-gitsync',
      '_blank',
      'noopener,noreferrer',
    )
  })

  test('本地没有克隆时 Ctrl+点卡片退回原行为:没有目录可去,不该只是"点了没反应"', async () => {
    const { guiBodies } = stubFetch(
      [payload({ repos: [repo()] })],
      undefined,
      // 本地只有别的仓库,和这张卡对不上
      { 'D:/w/other': 'git@gitee.com:xz_web/xiangqi.git' },
    )
    const w = mount()
    await flushAll()

    await w.find('.repo-card__btn').trigger('click', { ctrlKey: true })
    await flushAll()

    expect(guiBodies).toEqual([])
    expect(window.open).toHaveBeenCalledWith(
      'https://github.com/xz333221/zen-gitsync',
      '_blank',
      'noopener,noreferrer',
    )
  })

  test('启动 g ui 失败时给出提示,不静默', async () => {
    stubFetch(
      [payload({ repos: [repo()] })],
      undefined,
      { 'D:/w/zen-gitsync': 'git@github.com:xz333221/zen-gitsync.git' },
    )
    // 让 /api/open-new-tab-gui 明确失败(服务端会说清是目录没了还是终端拉不起来)
    const spy = vi.mocked(globalThis.fetch)
    const original = spy.getMockImplementation()!
    spy.mockImplementation(async (input: any, init: any) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/open-new-tab-gui')) {
        return json({ success: false, error: '目标目录已不存在' })
      }
      return original(input, init)
    })
    vi.mocked(ElMessage.error).mockClear()

    const w = mount()
    await flushAll()
    await w.find('.repo-card__btn').trigger('click', { ctrlKey: true })
    await flushAll()

    // 服务端给的原因优先于笼统的兜底文案
    expect(ElMessage.error).toHaveBeenCalledWith('目标目录已不存在')
  })
})

// jsdom 既不做 CSS 布局计算、也不加载 <style>(vitest 配置里 css:false),
// 所以「操作按钮什么时候才该显示」这条约束只能从样式源码层面守住 ——
// 而它一旦退回 :focus-within,点完卡片右侧按钮会永久挂在屏幕上、鼠标移出也不消失
// (用户实测报过;「最近项目」面板早先踩过同一个坑并改成 :has)。
describe('RemoteReposList.vue CSS 守卫', () => {
  // 用 vite 的 ?raw 取 SFC 源码文本(import.meta.url 在 vitest 下不是 file: scheme,
  // 喂给 readFileSync 会报 "must be of scheme file")。
  const rawModules = import.meta.glob('./RemoteReposList.vue', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>
  const src = Object.values(rawModules)[0] ?? ''
  // 去掉注释再断言:解释这段取舍的注释里正好会提到那个"不要用的选择器",
  // 不剥掉就会把自己绊倒(注释里写的是反面例子,不是真的规则)
  const rules = src.slice(src.indexOf('<style')).replace(/\/\*[\s\S]*?\*\//g, '')

  test('操作按钮的显隐靠 :has(操作按钮:focus-visible),不能退回 :focus-within', () => {
    // 键盘 Tab 落到操作按钮上时仍要让位(可访问性不能丢)
    expect(rules).toContain(':has(.repo-card__action:focus-visible)')
    // 而点击卡片主体按钮留下的焦点不该让它们常驻
    expect(rules).not.toMatch(/\.repo-card:focus-within/)
  })

  test('操作按钮隐藏时 pointer-events:none —— 否则会在徽标位置吞掉本该落到卡片的点击', () => {
    const actions = rules.slice(rules.indexOf('.repo-card__actions'))
    const body = actions.slice(actions.indexOf('{') + 1, actions.indexOf('}'))
    expect(body).toContain('pointer-events: none')
  })
})

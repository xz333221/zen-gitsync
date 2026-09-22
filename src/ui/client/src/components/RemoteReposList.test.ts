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

import RemoteReposList from './RemoteReposList.vue'
import { mountWithSetup } from '@/test-utils/mount'

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

/** 按 URL 分派的 fetch mock;/api/remote-repos 的响应取自 remoteQueue(耗尽后复用最后一个) */
function stubFetch(remoteQueue: Array<Record<string, unknown>>) {
  let index = 0
  const calls: string[] = []
  const bodies: Array<Record<string, unknown>> = []
  const loginBodies: Array<Record<string, unknown>> = []
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push(url)
    if (url.includes('/api/install-tool')) {
      bodies.push(JSON.parse(init?.body || '{}'))
      return json({ success: true, message: '安装命令已在新终端中启动' })
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
    return json({})
  })
  return { spy, calls, bodies, loginBodies }
}

function mount(provider: 'github' | 'gitee' = 'github') {
  return mountWithSetup(RemoteReposList as any, {
    props: { provider },
    global: { mocks: { $t: $tInterp } },
  })
}

beforeEach(() => {
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
})

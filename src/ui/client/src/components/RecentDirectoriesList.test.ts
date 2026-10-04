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
// RecentDirectoriesList.vue 「刷新全部」回归测试。
//
// 覆盖:按钮的可用态与文案(空闲/刷新中带进度)、逐目录发请求且跳过失效目录、
//       fetch 带回的新状态就地覆盖那张卡片的徽标、三态汇总 toast、
//       失败原因落在卡片 tooltip、以及并发上限(不能把十几个仓库全放出去)。
//
// 为什么必须自己造一个会插值的 $t:
//   vitest.setup.ts 把 @/lang/static 与全局 $t 都 mock 成 identity(返回 key),
//   那样只能断言 key 本身 —— 而这里要断言的恰恰是「刷新中 1/3」「落后 3」这类
//   **带参数的文案**,identity 会让参数消失。所以本文件用 vi.hoisted 提供一份
//   最小插值实现,script 侧(vi.mock)与模板侧(global.mocks)共用同一份。
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { ElMessage } from 'element-plus'

const { $tInterp } = vi.hoisted(() => ({
  $tInterp: (key: string, params?: Record<string, unknown>) =>
    params
      ? key.replace(/\{(\w+)\}/g, (_m, k) => String((params as Record<string, unknown>)[k] ?? `{${k}}`))
      : key,
}))

vi.mock('@/lang/static', () => ({ $t: $tInterp }))

import RecentDirectoriesList from './RecentDirectoriesList.vue'
import RecentDirectoriesSummary from './RecentDirectoriesSummary.vue'
import { resetOncePerLoad } from '@/utils/oncePerLoad'
import { mountWithSetup } from '@/test-utils/mount'

interface DirEntry {
  path: string
  exists: boolean
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
// 挂载 → 取目录 → 取 Git 状态 → 刷新，串了好几层 await，多跨几轮宏任务
const flushAll = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await flush()
}

function gitState(overrides: Record<string, unknown> = {}) {
  return {
    exists: true,
    isGitRepo: true,
    changed: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    branch: 'main',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    // 默认"配了远程仓库":与真实探测一致(有上游 ⇒ 必然有 remote),
    // 没配的那几条用例显式覆盖成 false
    hasRemote: true,
    ...overrides,
  }
}

type FetchResultBody = Record<string, unknown>

function setupFetch(opts: {
  dirs: DirEntry[]
  gitStates?: Record<string, FetchResultBody>
  /** 每个目录的 fetch 结果;返回 Promise 可用来控制时序 */
  onFetch?: (path: string) => FetchResultBody | Promise<FetchResultBody>
}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    // 顺序要紧:'/api/recent_directories' 是前两者的前缀
    if (url.includes('/api/recent_directories/git-state')) {
      return json({ success: true, results: opts.gitStates ?? {} })
    }
    if (url.includes('/api/recent_directories/fetch')) {
      const path = JSON.parse(init?.body ?? '{}').path
      const body = opts.onFetch ? await opts.onFetch(path) : { status: 'ok' }
      return json({ success: true, path, ...body })
    }
    if (url.includes('/api/recent_directories')) {
      return json({ success: true, directories: opts.dirs })
    }
    return json({})
  })
}

function fetchCalls(spy: any) {
  return spy.mock.calls
    .map((c: any[]) => (typeof c[0] === 'string' ? c[0] : c[0].url))
    .filter((u: string) => u.includes('/api/recent_directories/fetch'))
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

let wrapper: any = null

function mountList(props: Record<string, unknown> = {}) {
  wrapper = mountWithSetup(RecentDirectoriesList, {
    props: { variant: 'panel', ...props },
    global: { mocks: { $t: $tInterp } },
  })
  return wrapper
}

beforeEach(() => {
  vi.mocked(ElMessage).mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
  if (wrapper) {
    try {
      wrapper.unmount()
    } catch {}
    wrapper = null
  }
})

describe('RecentDirectoriesList.vue 「刷新全部」', () => {
  test('RCL-01: panel 头部渲染刷新按钮;没有目录时禁用', async () => {
    setupFetch({ dirs: [] })
    const w = mountList()
    await flushAll()

    const btn = w.find('button.dir-list__refresh')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('刷新全部')
    expect((btn.element as HTMLButtonElement).disabled).toBe(true)
    wrapper.unmount()
    wrapper = null

    // 有目录时按钮可用
    setupFetch({ dirs: [{ path: 'D:\\a', exists: true }] })
    const w2 = mountList()
    await flushAll()
    const btn2 = w2.find('button.dir-list__refresh')
    expect((btn2.element as HTMLButtonElement).disabled).toBe(false)
  })

  test('RCL-02: 点击后逐个对存在的目录发请求,失效目录不发', async () => {
    const dirs: DirEntry[] = [
      { path: 'D:\\a', exists: true },
      { path: 'D:\\b', exists: true },
      { path: 'D:\\gone', exists: false },
    ]
    const spy = setupFetch({ dirs })
    const w = mountList()
    await flushAll()

    await w.find('button.dir-list__refresh').trigger('click')
    await flushAll()

    expect(fetchCalls(spy)).toHaveLength(2)
    const sent = spy.mock.calls
      .filter((c: any[]) => String(typeof c[0] === 'string' ? c[0] : c[0].url).includes('/fetch'))
      .map((c: any[]) => JSON.parse(c[1].body).path)
    expect(sent.sort()).toEqual(['D:\\a', 'D:\\b'])
  })

  test('RCL-03: fetch 带回的最新状态就地覆盖那张卡片的徽标与 tooltip', async () => {
    const spy = setupFetch({
      dirs: [{ path: 'D:\\a', exists: true }],
      // 刷新前:本地引用显示"已同步"(behind 0)
      gitStates: { 'D:\\a': gitState({ behind: 0 }) },
      // 刷新后:远端有 3 个提交没拉
      onFetch: () => ({ status: 'ok', state: gitState({ behind: 3 }) }),
    })
    const w = mountList()
    await flushAll()

    expect(w.find('.dir-card__tag--behind').exists()).toBe(false)

    await w.find('button.dir-list__refresh').trigger('click')
    await flushAll()

    expect(fetchCalls(spy)).toHaveLength(1)
    const behindTag = w.find('.dir-card__tag--behind')
    expect(behindTag.exists()).toBe(true)
    expect(behindTag.text()).toContain('落后 3')
    // tooltip 也要跟着说出具体上游
    expect(w.find('.dir-card').attributes('title')).toContain('落后 origin/main 3 个提交')
  })

  test('RCL-04: 结束时用一条 toast 汇总「成功/跳过/失败」', async () => {
    setupFetch({
      dirs: [
        { path: 'D:\\ok1', exists: true },
        { path: 'D:\\ok2', exists: true },
        { path: 'D:\\skip', exists: true },
        { path: 'D:\\bad', exists: true },
      ],
      onFetch: (path) => {
        if (path === 'D:\\skip') return { status: 'skipped', reason: 'not-a-repo' }
        if (path === 'D:\\bad') return { status: 'failed', error: 'fatal: unable to access' }
        return { status: 'ok', state: gitState() }
      },
    })
    const w = mountList()
    await flushAll()

    await w.find('button.dir-list__refresh').trigger('click')
    await flushAll()

    expect(ElMessage).toHaveBeenCalledTimes(1)
    // $t 是 mock:返回的是「带命名空间的 key + 已插值的参数」,
    // 与仓里其它组件测试断言 key 的口径一致(能同时锁住 key 写错和参数传错)
    expect(ElMessage).toHaveBeenCalledWith({
      message: '@13D1C:刷新完成：成功 2 · 跳过 1 · 失败 1',
      type: 'warning',
    })
  })

  test('RCL-05: 失败原因进卡片 tooltip(不弹窗);超时用本地化文案', async () => {
    setupFetch({
      dirs: [
        { path: 'D:\\bad', exists: true },
        { path: 'D:\\slow', exists: true },
      ],
      onFetch: (path) =>
        path === 'D:\\bad'
          ? { status: 'failed', error: 'fatal: unable to access' }
          : { status: 'failed', error: 'git fetch timed out after 30s', timeout: true, timeoutSeconds: 30 },
    })
    const w = mountList()
    await flushAll()

    await w.find('button.dir-list__refresh').trigger('click')
    await flushAll()

    const cards = w.findAll('.dir-card')
    expect(cards[0].attributes('title')).toContain('刷新失败：fatal: unable to access')
    expect(cards[1].attributes('title')).toContain('刷新超时（超过 30 秒）')
  })

  test('RCL-06: 刷新中按钮禁用并显示进度,结束后恢复', async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>()
    setupFetch({
      dirs: [
        { path: 'D:\\a', exists: true },
        { path: 'D:\\b', exists: true },
      ],
      onFetch: (path) => {
        const gate = deferred()
        gates.set(path, gate)
        return gate.promise as Promise<FetchResultBody>
      },
    })
    const w = mountList()
    await flushAll()

    await w.find('button.dir-list__refresh').trigger('click')
    await flushAll()

    const btn = w.find('button.dir-list__refresh')
    expect((btn.element as HTMLButtonElement).disabled).toBe(true)
    expect(btn.text()).toContain('刷新中 0/2')

    // 放行第一个 → 进度前进到 1/2
    gates.get('D:\\a')?.resolve({ status: 'ok', state: gitState() })
    await flushAll()
    expect(w.find('button.dir-list__refresh').text()).toContain('刷新中 1/2')

    gates.get('D:\\b')?.resolve({ status: 'ok', state: gitState() })
    await flushAll()
    const done = w.find('button.dir-list__refresh')
    expect((done.element as HTMLButtonElement).disabled).toBe(false)
    expect(done.text()).toContain('刷新全部')
  })

  test('RCL-07: 并发上限 6 —— 不能把十几个仓库一次性全放出去', async () => {
    let active = 0
    let peak = 0
    const gates = new Map<string, ReturnType<typeof deferred>>()
    setupFetch({
      dirs: Array.from({ length: 12 }, (_, i) => ({ path: `D:\\p${i}`, exists: true })),
      onFetch: (path) => {
        active += 1
        peak = Math.max(peak, active)
        const gate = deferred()
        gates.set(path, gate)
        return gate.promise.then((v) => {
          active -= 1
          return v as FetchResultBody
        })
      },
    })
    const w = mountList()
    await flushAll()

    await w.find('button.dir-list__refresh').trigger('click')
    await flushAll()

    expect(peak).toBe(6)
    expect(gates.size).toBe(6)

    // 放完剩下的（每放行一个就补一个，所以边放边收集）
    for (let i = 0; i < 40 && gates.size > 0; i += 1) {
      const [path, gate] = [...gates.entries()][0]
      gates.delete(path)
      gate.resolve({ status: 'ok', state: gitState() })
      await flushAll(3)
    }
    await flushAll()

    expect(peak).toBe(6)
    expect(ElMessage).toHaveBeenCalledWith({
      message: '@13D1C:刷新完成：成功 12 · 跳过 0 · 失败 0',
      type: 'success',
    })
  })
})

// ── 「未配远程」徽标 ──────────────────────────────────────────────────────
// 后端 hasRemote 三态:true=配了 / false=一个都没配 / null=没探到。
// 卡片只在**明确 false** 时挂徽标 —— null(超时没探到)挂上去就是把未知
// 谎报成"没配远程",用户会去白配一个其实已经配好的仓库。
describe('RecentDirectoriesList.vue 未配远程徽标', () => {
  test('RCL-20: 没配远程 → 挂徽标 + tooltip 说明,并且顶掉中性的 Git 标签', async () => {
    setupFetch({
      dirs: [{ path: 'D:\\solo', exists: true }],
      gitStates: {
        'D:\\solo': gitState({ hasRemote: false, upstream: null, branch: 'main' }),
      },
    })
    const w = mountList()
    await flushAll()

    const tag = w.find('.dir-card__tag--noremote')
    expect(tag.exists()).toBe(true)
    expect(tag.text()).toContain('未配远程')
    // 「未配远程」本身已经说明了这是仓库,不该再挂一个中性的 Git 标签占宽度
    expect(w.find('.dir-card__tag--git').exists()).toBe(false)
    expect(w.find('.dir-card').attributes('title')).toContain('未配置远程仓库，推送与拉取都不可用')
  })

  test('RCL-21: 配了远程 → 不挂;hasRemote 为 null(没探到)→ 也不挂', async () => {
    setupFetch({
      dirs: [
        { path: 'D:\\ok', exists: true },
        { path: 'D:\\unknown', exists: true },
      ],
      gitStates: {
        'D:\\ok': gitState({ hasRemote: true }),
        // 没探到远程:后端给 null,前端必须当作"不知道"
        'D:\\unknown': gitState({ hasRemote: null, upstream: null }),
      },
    })
    const w = mountList()
    await flushAll()

    expect(w.findAll('.dir-card__tag--noremote').length).toBe(0)
    // 两条都是干净仓库 → 各挂一个中性的 Git 标签(证明只是没挂"未配远程")
    expect(w.findAll('.dir-card__tag--git').length).toBe(2)
  })

  test('RCL-22: 没配远程但有未提交改动 → 两个徽标同时在,互不顶掉', async () => {
    setupFetch({
      dirs: [{ path: 'D:\\solo', exists: true }],
      gitStates: {
        'D:\\solo': gitState({ hasRemote: false, upstream: null, changed: 2, unstaged: 2 }),
      },
    })
    const w = mountList()
    await flushAll()

    expect(w.find('.dir-card__tag--noremote').text()).toContain('未配远程')
    expect(w.find('.dir-card__tag--dirty').text()).toContain('未提交 2 项')
    expect(w.find('.dir-card').attributes('title')).toContain('已暂存 0 · 未暂存 2 · 未跟踪 0')
  })
})

// ── 启动时自动刷一遍（refresh-on-mount）─────────────────────────────────────
// 只在 g ui 首屏那块常驻面板上开(App.vue 传 refresh-on-mount)。
// 每个用例前重置"这一页"的门闸(utils/oncePerLoad):它是模块级状态,同一个测试文件里
// 模块只加载一次,不重置的话第一个用例就会把后面的用例挡掉。
describe('RecentDirectoriesList.vue 启动时自动刷新', () => {
  beforeEach(() => resetOncePerLoad())

  test('RCL-10: 默认关闭 —— 挂载只取数据,不发 fetch', async () => {
    const spy = setupFetch({ dirs: [{ path: 'D:\\a', exists: true }] })
    const w = mountList()
    await flushAll()

    expect(fetchCalls(spy)).toHaveLength(0)
    // 列表本身照常拉回来(自动刷新关掉不代表面板不加载)
    expect(w.findAll('.dir-card').length).toBe(1)
  })

  test('RCL-11: refresh-on-mount 挂载即自动刷,且整页只刷一次', async () => {
    const dirs: DirEntry[] = [
      { path: 'D:\\a', exists: true },
      { path: 'D:\\gone', exists: false },
    ]
    const spy = setupFetch({
      dirs,
      onFetch: () => ({ status: 'ok', state: gitState({ behind: 2 }) }),
    })

    // 不用点按钮:挂载 + 列表回来之后自己就刷了
    const w = mountList({ refreshOnMount: true })
    await flushAll()
    await flushAll()

    expect(fetchCalls(spy)).toHaveLength(1)
    const sent = spy.mock.calls
      .filter((c: any[]) => String(typeof c[0] === 'string' ? c[0] : c[0].url).includes('/fetch'))
      .map((c: any[]) => JSON.parse(c[1].body).path)
    // 失效目录不发(与点按钮时同一套过滤)
    expect(sent).toEqual(['D:\\a'])
    // 刷完的徽标直接落在那张卡片上
    expect(w.find('.dir-card__tag--behind').text()).toContain('落后 2')

    // 切目录会让面板卸载重建:第二次挂载不该再联网刷一轮
    wrapper.unmount()
    wrapper = null
    const w2 = mountList({ refreshOnMount: true })
    await flushAll()
    await flushAll()
    expect(fetchCalls(spy)).toHaveLength(1)
    expect(w2.findAll('.dir-card').length).toBe(2)
  })
})

// ── 搜索过滤 ─────────────────────────────────────────────────────────────
// 弹窗(切换工作目录)里那一列三十来个目录、名字都差不多,搜索是唯一的筛选入口;
// 它和首屏 panel 形态共用同一份过滤逻辑(组件内 allItems = 全部 / items = 过滤后)。
// 关键的一条是「AI 解读不吃过滤」:说明描述的是"这批目录现在什么状态",
// 不该因为敲了几个字就换一段解读(那还会白烧一次模型调用)。
describe('RecentDirectoriesList.vue 搜索过滤', () => {
  const dirs: DirEntry[] = [
    { path: 'D:\\work\\zen-gitsync', exists: true },
    { path: 'D:\\work\\home2026', exists: true },
    { path: 'D:\\other\\zen-ai-chat-ui', exists: true },
  ]

  test('RCL-30: bare 形态(弹窗)也渲染搜索框,占位文案由调用方给', async () => {
    setupFetch({ dirs })
    const w = mountList({
      variant: 'bare',
      layout: 'split',
      searchPlaceholder: '搜索常用目录...',
    })
    await flushAll()

    const input = w.find('input.dir-list__search-input')
    expect(input.exists()).toBe(true)
    expect(input.attributes('placeholder')).toBe('搜索常用目录...')
    // 「搜索」这个动作在弹窗里只有列表自己能提供,但它不该顺手把 panel 的标题行也带出来
    expect(w.find('.dir-list__head').exists()).toBe(false)
    expect(w.findAll('.dir-card').length).toBe(3)
  })

  test('RCL-31: panel 形态不传 prop 时仍是「最近项目」文案', async () => {
    setupFetch({ dirs })
    const w = mountList()
    await flushAll()

    const input = w.find('input.dir-list__search-input')
    expect(input.attributes('placeholder')).toBe('@13D1C:搜索最近项目...')
    expect(input.attributes('aria-label')).toBe('@13D1C:搜索最近项目...')
  })

  test('RCL-32: 关键词只筛卡片,清空后恢复,AI 解读栏始终拿全量', async () => {
    setupFetch({ dirs })
    const w = mountList({ variant: 'bare', layout: 'split' })
    await flushAll()

    const input = w.find('input.dir-list__search-input')
    await input.setValue('zen')
    expect(w.findAll('.dir-card').length).toBe(2)
    // 说明块读的是 allItems:过滤只影响"看得见几张卡",不改变被解读的那批目录
    expect(w.findComponent(RecentDirectoriesSummary).props('items')).toHaveLength(3)

    await input.setValue('home')
    expect(w.findAll('.dir-card').length).toBe(1)

    // 一个都不匹配:给的是"没有匹配"空态,而不是把列表画成空的
    await input.setValue('绝无此目录')
    expect(w.findAll('.dir-card').length).toBe(0)
    expect(w.find('.dir-list__empty').text()).toContain('没有匹配')

    // 清空按钮撤回过滤(弹窗每次打开都重建组件,不需要持久化搜索词)
    await input.setValue('zen')
    await w.find('button.dir-list__search-clear').trigger('click')
    expect(w.findAll('.dir-card').length).toBe(3)
    expect(w.find('button.dir-list__search-clear').exists()).toBe(false)
  })
})

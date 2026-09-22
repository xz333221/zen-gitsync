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
// RecentDirectoriesSummary.vue 回归测试。
//
// 守三条契约:
//   1. 没配模型 → 只显示静态说明,一个请求都不发(不能因为没配模型还去问后端)
//   2. ready=false → 不解读(「刷新全部」跑到一半的状态不值得花一次模型调用)
//      ready 翻成 true 之后才发,而且只发一次
//   3. 同一份状态第二次挂载命中模块级缓存(弹窗重开 / 面板重建不重复烧 token)
//
// 为什么自己造一份会插值的 $t:要断言的正是「共 3 个目录」这种**带参数**的文案,
// identity 会把参数吃掉(同 RecentDirectoriesList.test.ts / AiDiffSummary.test.ts)。
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const { $tInterp } = vi.hoisted(() => ({
  $tInterp: (key: string, params?: Record<string, unknown>) =>
    params
      ? key.replace(/\{(\w+)\}/g, (_m, k) => String((params as Record<string, unknown>)[k] ?? `{${k}}`))
      : key,
}))

vi.mock('@/lang/static', () => ({ $t: $tInterp }))

// 模型配置:每个用例自己改这个对象(组件读的是 configStore)
const configStore = vi.hoisted(() => ({ models: [] as any[], locale: 'zh-CN' }))
vi.mock('@stores/configStore', () => ({ useConfigStore: () => configStore }))

import RecentDirectoriesSummary from './RecentDirectoriesSummary.vue'
import { resetDirectorySummaryCache } from '@/utils/directorySummaryCache'

const MODEL = { id: 'model-1', model: 'fixture', baseURL: 'http://127.0.0.1:9', isDefault: true }

function gitState(overrides: Record<string, unknown> = {}) {
  return {
    isGitRepo: true,
    branch: 'main',
    upstream: 'origin/main',
    changed: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
    ...overrides,
  }
}

const item = (path: string, git: Record<string, unknown> | null = gitState()) => ({
  path,
  exists: true,
  git: git as any,
})

function sseResponse(content: string) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', content })}\n\n`))
      controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

function errorResponse(payload: Record<string, unknown>) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', ...payload })}\n\n`))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

// 注意:本文件全程开着 fake timers,`setTimeout(resolve, 0)` 这种"等一个宏任务"
// 的写法会永远等下去 —— 推进时间必须用 advanceTimersByTimeAsync(它顺带把
// 微任务队列也冲干净),流式读取才走得动。
const flushAll = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await vi.advanceTimersByTimeAsync(0)
}

describe('RecentDirectoriesSummary.vue', () => {
  let calls: Array<{ url: string; body: any }> = []
  let respond: (body: any) => Response = () => sseResponse('ok')

  beforeEach(() => {
    vi.useFakeTimers()
    calls = []
    respond = () => sseResponse('ok')
    configStore.models = []
    configStore.locale = 'zh-CN'
    // 解读缓存是整页一份(模块作用域),用例之间必须互不影响
    resetDirectorySummaryCache()
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) })
      return respond(calls[calls.length - 1].body)
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function mountSummary(props: Record<string, unknown>) {
    return mount(RecentDirectoriesSummary, {
      props: props as any,
      global: { stubs: { ElIcon: { template: '<i><slot /></i>' } } },
    })
  }

  test('RDS-01: 没配模型时只显示静态说明,不发请求', async () => {
    const wrapper = mountSummary({
      items: [item('D:\\nomodel\\a'), item('D:\\nomodel\\b', { isGitRepo: false })],
      ready: true,
    })
    await vi.advanceTimersByTimeAsync(500)

    expect(calls).toHaveLength(0)
    expect(wrapper.find('.dir-summary__head').exists()).toBe(false)
    expect(wrapper.text()).toContain('@13D1C:共 2 个目录')
    wrapper.unmount()
  })

  test('RDS-02: ready=false 不解读,翻成 true 后才发且只发一次', async () => {
    configStore.models = [MODEL]
    const items = [item('D:\\notready\\a', gitState({ behind: 3 }))]
    const wrapper = mountSummary({ items, ready: false })

    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toHaveLength(0)                     // 刷新中/未定稿:一个字都不问模型
    expect(wrapper.text()).toContain('@13D1C:共 1 个目录')

    await wrapper.setProps({ ready: true })
    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/recent_directories/summary')
    expect(calls[0].body.locale).toBe('zh')
    expect(calls[0].body.items).toEqual([
      {
        path: 'D:\\notready\\a',
        exists: true,
        git: {
          isGitRepo: true, branch: 'main', upstream: 'origin/main',
          changed: 0, staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 3,
        },
      },
    ])
    wrapper.unmount()
  })

  test('RDS-03: 流式正文渲染成纯文本(抹掉 Markdown 标记)', async () => {
    configStore.models = [MODEL]
    respond = () => sseResponse('**zen-gitsync** 落后 origin/main 3 个提交，`需要 pull`。')
    const wrapper = mountSummary({
      items: [item('D:\\stream\\a', gitState({ behind: 3 }))],
      ready: true,
    })

    await vi.advanceTimersByTimeAsync(500)
    await flushAll()

    const text = wrapper.find('.dir-summary__text').text()
    expect(text).toContain('zen-gitsync 落后 origin/main 3 个提交')
    expect(text).not.toContain('**')
    expect(text).not.toContain('`')
    expect(wrapper.find('.dir-summary__head').exists()).toBe(true)
    wrapper.unmount()
  })

  test('RDS-04: 同一份状态第二次挂载命中模块级缓存,不再请求', async () => {
    configStore.models = [MODEL]
    const items = [item('D:\\cache\\a', gitState({ changed: 2 }))]

    const first = mountSummary({ items, ready: true })
    await vi.advanceTimersByTimeAsync(500)
    await flushAll()
    expect(calls).toHaveLength(1)
    const text = first.find('.dir-summary__text').text()
    first.unmount()

    // 模拟弹窗重开:同一份状态、同一个模型
    const second = mountSummary({ items: [item('D:\\cache\\a', gitState({ changed: 2 }))], ready: true })
    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toHaveLength(1)                     // 没有第二次调用
    expect(second.find('.dir-summary__text').text()).toBe(text)
    second.unmount()
  })

  test('RDS-06: 同一份状态正在生成时,第二个实例跟着等,不重复调用模型', async () => {
    configStore.models = [MODEL]
    // 手动控制流:让第一个请求停在"生成中",才有机会让第二个实例挂上去
    const streams: Array<{ push: (s: string) => void; close: () => void }> = []
    respond = () => {
      const encoder = new TextEncoder()
      let ctrl: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c } })
      streams.push({
        push: s => ctrl.enqueue(encoder.encode(s)),
        close: () => ctrl.close(),
      })
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }

    const items = [item('D:\\dedupe\\a', gitState({ behind: 2 }))]
    const first = mountSummary({ items, ready: true })
    await vi.advanceTimersByTimeAsync(500)          // 第一个实例已发出请求、流还没结束
    expect(calls).toHaveLength(1)
    expect(first.find('.dir-summary__text--pending').exists()).toBe(true)

    // 弹窗在生成期间打开(自己的实例、同一份状态)
    const second = mountSummary({ items: [item('D:\\dedupe\\a', gitState({ behind: 2 }))], ready: true })
    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toHaveLength(1)                   // 没有第二次调用

    streams[0].push(`data: ${JSON.stringify({ type: 'delta', content: 'zen-gitsync 落后 2 个提交' })}\n\n`)
    streams[0].push('data: {"type":"done"}\n\n')
    streams[0].close()
    await flushAll()

    expect(first.find('.dir-summary__text').text()).toContain('zen-gitsync 落后 2 个提交')
    expect(second.find('.dir-summary__text').text()).toContain('zen-gitsync 落后 2 个提交')
    first.unmount()
    second.unmount()
  })

  test('RDS-05: 失败时保留静态说明 + 展示原因,重试会再发一次', async () => {
    configStore.models = [MODEL]
    respond = () => errorResponse({ code: 'LLM_ERR', error: 'HTTP 401 Unauthorized' })
    const wrapper = mountSummary({
      items: [item('D:\\fail\\a', gitState({ ahead: 1 }))],
      ready: true,
    })

    await vi.advanceTimersByTimeAsync(500)
    await flushAll()

    expect(wrapper.find('.dir-summary__error').exists()).toBe(true)
    expect(wrapper.text()).toContain('HTTP 401 Unauthorized')
    expect(wrapper.text()).toContain('@13D1C:共 1 个目录')   // 静态说明仍在垫底

    respond = () => sseResponse('一切正常')
    await wrapper.find('.dir-summary__retry').trigger('click')
    await flushAll()
    expect(calls).toHaveLength(2)
    expect(wrapper.find('.dir-summary__error').exists()).toBe(false)
    expect(wrapper.find('.dir-summary__text').text()).toContain('一切正常')
    wrapper.unmount()
  })
})

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConfigStore } from './configStore'

describe('configStore AI diff summary project setting', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/config/getConfig') {
        return new Response(JSON.stringify({
          currentDirectory: 'C:\\repo-a',
          ui: {
            aiDiffSummaryByProject: {
              'C:\\repo-a': false,
              'C:\\repo-b': true,
              invalid: 'false',
            },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }))
  })

  test('defaults to enabled and keeps explicit values isolated by project', async () => {
    const store = useConfigStore()
    await store.loadConfig()

    expect(store.aiDiffSummaryEnabled).toBe(false)
    store.setCurrentDirectory('C:\\repo-b')
    expect(store.aiDiffSummaryEnabled).toBe(true)
    store.setCurrentDirectory('C:\\new-repo')
    expect(store.aiDiffSummaryEnabled).toBe(true)
  })

  test('updates and persists only the current project entry', async () => {
    const store = useConfigStore()
    await store.loadConfig()
    store.setCurrentDirectory('C:\\repo-b')

    await store.setAiDiffSummaryEnabled(false)

    expect(store.aiDiffSummaryEnabled).toBe(false)
    expect(store.ui.aiDiffSummaryByProject['C:\\repo-b']).toBe(false)
    const fetchCalls = vi.mocked(fetch).mock.calls
    const [url, init] = fetchCalls[fetchCalls.length - 1]
    expect(url).toBe('/api/config/save-ui-settings')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      aiDiffSummaryByProject: { 'C:\\repo-b': false },
    })
  })
})

// 「上次用过哪个执行器」必须活过一次应用重启才算数，而 GUI 每次启动都换一个随机端口
// ——localStorage 按 origin 隔离，所以它曾经永远记不住（2026-09-30 迁到 config.json 的
// ui.lastTaskExecutor）。这里钉住的是**取值链**与**落盘 body**，别让它再退回浏览器侧。
describe('configStore 任务执行器「上次用过」', () => {
  function stubConfig(configData: Record<string, unknown>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/config/getConfig') {
        return new Response(JSON.stringify({ currentDirectory: 'C:\\repo-a', ...configData }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }))
  }

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('没选过时回落设置里的默认值 taskExecutor', async () => {
    stubConfig({ taskExecutor: 'codex' })
    const store = useConfigStore()
    await store.loadConfig()

    expect(store.ui.lastTaskExecutor).toBeNull()
    expect(store.resolvedTaskExecutor).toBe('codex')
  })

  test('选过一次之后，上次用的压过设置里的默认值', async () => {
    stubConfig({ taskExecutor: 'codex', ui: { lastTaskExecutor: 'opencode' } })
    const store = useConfigStore()
    await store.loadConfig()

    expect(store.resolvedTaskExecutor).toBe('opencode')
  })

  test('脏值当没选过（白名单校验，不让手改配置把入口指到不存在的执行器）', async () => {
    stubConfig({ taskExecutor: 'codex', ui: { lastTaskExecutor: 'nope' } })
    const store = useConfigStore()
    await store.loadConfig()

    expect(store.ui.lastTaskExecutor).toBeNull()
    expect(store.resolvedTaskExecutor).toBe('codex')
  })

  test('setLastTaskExecutor 落 ui 字段，且不碰顶层 taskExecutor（默认值不被污染）', async () => {
    stubConfig({ taskExecutor: 'codex' })
    const store = useConfigStore()
    await store.loadConfig()

    await store.setLastTaskExecutor('opencode')

    expect(store.taskExecutor).toBe('codex')
    expect(store.resolvedTaskExecutor).toBe('opencode')
    const fetchCalls = vi.mocked(fetch).mock.calls
    const [url, init] = fetchCalls[fetchCalls.length - 1]
    expect(url).toBe('/api/config/save-ui-settings')
    expect(JSON.parse(String(init?.body))).toEqual({ lastTaskExecutor: 'opencode' })
  })
})

// 预设提示词（智能体视图欢迎页快捷卡片）：配置读写链路。
// 两条容易踩的语义边界在这里钉住：
//   1. 空数组是**合法值**（= 用内置默认），读取时保持空数组，不在这里注入内置文案
//      —— 内置文案跟着界面语言走，注入到 store 就等于把语言腌进了数据；
//   2. 保存空数组也要真的发出去（恢复内置默认全靠它），不能被"空即省略"的逻辑吃掉。
describe('configStore 预设提示词（agentPresetPrompts）', () => {
  function stubFetch(configData: Record<string, unknown>, saveReply: Record<string, unknown> = { success: true }) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/config/getConfig') {
        return new Response(JSON.stringify({ currentDirectory: 'C:\repo-a', ...configData }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify(saveReply), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))
  }

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('load 读取预设；缺 label/prompt 的脏条目被防御性过滤', async () => {
    stubFetch({
      agentPresetPrompts: [
        { id: 'u1', label: '我的', prompt: '跑测试' },
        { id: 'u2', label: '缺内容就被丢' },
        'oops',
      ],
    })
    const store = useConfigStore()
    await store.loadConfig()

    expect(store.agentPresetPrompts).toEqual([{ id: 'u1', label: '我的', prompt: '跑测试' }])
  })

  test('未配置时保持空数组（= 用内置默认，不把内置文案腌进 store）', async () => {
    stubFetch({})
    const store = useConfigStore()
    await store.loadConfig()

    expect(store.agentPresetPrompts).toEqual([])
  })

  test('保存空数组：body 要真的带上 agentPresetPrompts: []（恢复内置默认）', async () => {
    stubFetch({}, { success: true, agentPresetPrompts: [] })
    const store = useConfigStore()
    await store.loadConfig()

    const ok = await store.saveAiSettings({ agentPresetPrompts: [] })

    expect(ok).toBe(true)
    const saveCall = vi.mocked(fetch).mock.calls.find(c => c[0] === '/api/config/save-ai-settings')
    expect(saveCall).toBeTruthy()
    expect(JSON.parse(String(saveCall![1]?.body))).toEqual({ agentPresetPrompts: [] })
    expect(store.agentPresetPrompts).toEqual([])
  })

  test('保存：以回执里的归一化结果回写 store（补 id 等以服务端为准）', async () => {
    stubFetch({}, { success: true, agentPresetPrompts: [{ id: 'preset-1', label: 'a', prompt: 'b' }] })
    const store = useConfigStore()
    await store.loadConfig()

    await store.saveAiSettings({ agentPresetPrompts: [{ id: '', label: 'a', prompt: 'b' }] })

    expect(store.agentPresetPrompts).toEqual([{ id: 'preset-1', label: 'a', prompt: 'b' }])
  })
})

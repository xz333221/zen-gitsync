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

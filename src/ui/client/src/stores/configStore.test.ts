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
    expect(store.ui.aiDiffSummaryByProject['C:\\repo-a']).toBe(false)
    const fetchCalls = vi.mocked(fetch).mock.calls
    const [url, init] = fetchCalls[fetchCalls.length - 1]
    expect(url).toBe('/api/config/save-ui-settings')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      aiDiffSummaryByProject: { 'C:\\repo-b': false },
    })
  })
})

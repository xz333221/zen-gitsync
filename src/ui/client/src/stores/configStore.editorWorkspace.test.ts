// 文件空间工作区快照（ui.editorWorkspaceByProject）在 configStore 侧的读写与净化规则。
// 恢复流程本身（树/标签怎么重开）在 scripts/verify-editor-workspace-restore.cjs 里按浏览器行为验证，
// 这里只盯 store：脏配置的净化、按项目隔离、上限截断、activeTab 必须落在 tabs 内。
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConfigStore } from './configStore'

const CWD = 'C:\\repo-a'

function configWith(workspace: unknown) {
  return {
    currentDirectory: CWD,
    ui: { editorWorkspaceByProject: workspace },
  }
}

function stubFetch(config: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/config/getConfig') {
      return new Response(JSON.stringify(config), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  }))
}

describe('configStore 文件空间工作区快照', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('读盘时净化脏数据：非字符串剔除、activeTab 必须真在 tabs 里', async () => {
    stubFetch(configWith({
      [CWD]: {
        expandedDirs: ['C:\\repo-a\\src', 42, '', null],
        tabs: ['C:\\repo-a\\a.md', 'C:\\repo-a\\b.md'],
        activeTab: 'C:\\repo-a\\不存在.md',
      },
      'C:\\repo-b': 'not-an-object',
    }))
    const store = useConfigStore()
    await store.loadConfig()

    const entry = store.getEditorWorkspace()
    expect(entry?.expandedDirs).toEqual(['C:\\repo-a\\src'])
    expect(entry?.tabs).toEqual(['C:\\repo-a\\a.md', 'C:\\repo-a\\b.md'])
    expect(entry?.activeTab).toBe(null)
    expect(Object.keys(store.ui.editorWorkspaceByProject)).toEqual([CWD])
  })

  test('读盘时截断超长快照（tabs ≤ 40 / expandedDirs ≤ 200）', async () => {
    stubFetch(configWith({
      [CWD]: {
        expandedDirs: Array.from({ length: 260 }, (_, i) => `C:\\repo-a\\d${i}`),
        tabs: Array.from({ length: 60 }, (_, i) => `C:\\repo-a\\f${i}.md`),
        activeTab: 'C:\\repo-a\\f59.md',
      },
    }))
    const store = useConfigStore()
    await store.loadConfig()

    const entry = store.getEditorWorkspace()
    expect(entry?.expandedDirs).toHaveLength(200)
    expect(entry?.tabs).toHaveLength(40)
    // activeTab 指向被截断掉的那个 → 退化成"没有激活标签"，别让恢复指向不存在的标签
    expect(entry?.activeTab).toBe(null)
  })

  test('没记过的项目返回 null（不误用别的项目快照）', async () => {
    stubFetch(configWith({ 'C:\\repo-b': { expandedDirs: [], tabs: ['C:\\repo-b\\x.md'], activeTab: null } }))
    const store = useConfigStore()
    await store.loadConfig()

    expect(store.getEditorWorkspace()).toBe(null)
    expect(store.getEditorWorkspace('C:\\repo-b')?.tabs).toEqual(['C:\\repo-b\\x.md'])
  })

  test('保存只覆盖当前项目那一条，并入队 save-ui-settings', async () => {
    stubFetch(configWith({ 'C:\\repo-b': { expandedDirs: [], tabs: ['C:\\repo-b\\x.md'], activeTab: null } }))
    const store = useConfigStore()
    await store.loadConfig()

    store.saveEditorWorkspace({
      expandedDirs: ['C:\\repo-a\\src'],
      tabs: ['C:\\repo-a\\a.md'],
      activeTab: 'C:\\repo-a\\a.md',
    })

    // 当前项目写进去，别的项目条目原样保留（服务端对这个 key 做深合并）
    expect(store.getEditorWorkspace()?.tabs).toEqual(['C:\\repo-a\\a.md'])
    expect(store.getEditorWorkspace('C:\\repo-b')?.tabs).toEqual(['C:\\repo-b\\x.md'])

    // 防抖 300ms 后落盘
    await new Promise((r) => setTimeout(r, 400))
    const calls = vi.mocked(fetch).mock.calls
    const [url, init] = calls[calls.length - 1]
    expect(url).toBe('/api/config/save-ui-settings')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      editorWorkspaceByProject: { [CWD]: { tabs: ['C:\\repo-a\\a.md'] } },
    })
  })

  test('保存时 activeTab 不在 tabs 内 → 存成 null（关掉最后一个标签的场景）', async () => {
    stubFetch(configWith({}))
    const store = useConfigStore()
    await store.loadConfig()

    store.saveEditorWorkspace({
      expandedDirs: [],
      tabs: ['C:\\repo-a\\a.md'],
      activeTab: 'C:\\repo-a\\已关闭.md',
    })

    expect(store.getEditorWorkspace()?.activeTab).toBe(null)
  })
})

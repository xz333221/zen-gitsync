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
// 思维导图多目录（多根聚合）回归测试：
//   - 目录列表来自 configStore.ui.mindmapDirs（旧单值 mindmapDir 迁移）
//   - 各目录并发加载、独立报错
//   - addDirs 去重、removeDir 只移除列表项
//   - 「新建/导入」目标目录解析

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConfigStore } from './configStore'
import { useMindmapStore, type MindmapFileMeta } from './mindmapStore'

const NOTES = 'D:\\notes'
const KB = 'E:\\kb'
const THIRD = 'F:\\third'

function fileMeta(dir: string, name: string, size: number, mtime: number): MindmapFileMeta {
  return { name: `${name}.mindmap.json`, path: `${dir}\\${name}.mindmap.json`, size, mtime, title: name }
}

const FILES: Record<string, MindmapFileMeta[]> = {
  [NOTES]: [fileMeta(NOTES, 'a', 100, 1700000002000), fileMeta(NOTES, 'b', 200, 1700000001000)],
  [KB]: [fileMeta(KB, 'c', 300, 1700000003000)],
  [THIRD]: [],
}

// 指定目录的 list 请求返回失败（模拟目录被外部删除）
let failDirs = new Set<string>()

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function queryParam(url: string, key: string): string {
  const q = url.split('?')[1] || ''
  return decodeURIComponent(new URLSearchParams(q).get(key) || '')
}

function setupFetch(ui: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input)
    if (url.startsWith('/api/config/getConfig')) {
      return jsonResponse({ currentDirectory: 'C:\\repo-a', ui })
    }
    if (url.startsWith('/api/mindmap/list')) {
      const dir = queryParam(url, 'dir')
      if (failDirs.has(dir)) return jsonResponse({ success: false, error: `目录不存在: ${dir}` }, 404)
      return jsonResponse({ success: true, dir, files: FILES[dir] || [] })
    }
    if (url.startsWith('/api/mindmap/read')) {
      const path = queryParam(url, 'path')
      const title = path.split('\\').pop()?.replace('.mindmap.json', '') || ''
      return jsonResponse({ success: true, path, title, content: '{}', mtime: 1 })
    }
    if (url.startsWith('/api/mindmap/create')) {
      const body = JSON.parse(String(init?.body))
      return jsonResponse({
        success: true,
        path: `${body.dir}\\${body.name}.mindmap.json`,
        title: body.name,
        content: '{}',
        mtime: 1,
      })
    }
    return jsonResponse({ success: true })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function loadStores(ui: Record<string, unknown> = { mindmapDirs: [NOTES, KB] }) {
  setupFetch(ui)
  const configStore = useConfigStore()
  await configStore.loadConfig()
  const store = useMindmapStore()
  return { configStore, store }
}

// configStore 对 ui.mindmapDirs 是 300ms 防抖落盘，等它 flush
const waitForUiSave = () => new Promise((resolve) => setTimeout(resolve, 350))

function uiSaveBodies(): Record<string, unknown>[] {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([url]) => String(url) === '/api/config/save-ui-settings')
    .map(([, init]) => JSON.parse(String(init?.body)))
}

describe('mindmapStore 多目录（多根聚合）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    failDirs = new Set()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('init 从配置登记多个目录，按目录分组加载本级文件', async () => {
    const { store } = await loadStores()
    await store.init()

    expect(store.dirs).toEqual([NOTES, KB])
    expect(store.groups.map((g) => g.dir)).toEqual([NOTES, KB])
    expect(store.groups[0].files.map((f) => f.title)).toEqual(['a', 'b'])
    expect(store.groups[1].files.map((f) => f.title)).toEqual(['c'])
    expect(store.filesCount).toBe(3)
  })

  test('旧单值 mindmapDir 迁移为单目录列表', async () => {
    const { store } = await loadStores({ mindmapDir: NOTES })
    await store.init()

    expect(store.dirs).toEqual([NOTES])
    expect(store.groups).toHaveLength(1)
  })

  test('addDirs 去重：重复目录 / 大小写变体 / 尾部分隔符', async () => {
    const { store } = await loadStores()
    await store.init()

    const added = await store.addDirs([NOTES, 'd:\\NOTES\\', 'E:/KB', THIRD])

    expect(added).toBe(1)
    expect(store.dirs).toEqual([NOTES, KB, THIRD])
    expect(store.groups.map((g) => g.dir)).toEqual([NOTES, KB, THIRD])
  })

  test('目录列表写回配置，并以 mindmapDirs partial 落盘', async () => {
    const { configStore, store } = await loadStores()
    await store.init()

    await store.addDirs([THIRD])
    expect(configStore.ui.mindmapDirs).toEqual([NOTES, KB, THIRD])

    await waitForUiSave()
    const bodies = uiSaveBodies()
    expect(bodies.length).toBeGreaterThan(0)
    // saveUiSettings 会把同一防抖窗口内的多个 ui 片段合并成一次请求，
    // 这里只断言目录列表本身被正确落盘
    expect(bodies[bodies.length - 1].mindmapDirs).toEqual([NOTES, KB, THIRD])
  })

  test('removeDir 只移除列表项：不删磁盘文件、不关闭当前文件', async () => {
    const { store } = await loadStores()
    await store.init()
    await store.openFile(`${NOTES}\\a.mindmap.json`, true)
    expect(store.activeDir).toBe(NOTES)

    store.removeDir(NOTES)

    expect(store.dirs).toEqual([KB])
    expect(store.groups.map((g) => g.dir)).toEqual([KB])
    // 当前打开的文件保持打开，仍可继续编辑保存
    expect(store.current?.path).toBe(`${NOTES}\\a.mindmap.json`)
    // 没有发出任何删除文件请求
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0)
  })

  test('resolveTargetDir：有歧义 / activeDir 命中 / 当前文件归属 / 唯一目录', async () => {
    const { store } = await loadStores()
    await store.init()

    // 多个目录、无当前文件、未指定目标 → 由调用方提示先选目标
    expect(store.resolveTargetDir()).toEqual({ dir: null, ambiguous: true })

    // 点击分组头设为目标目录 → 命中
    store.activeDir = KB
    expect(store.resolveTargetDir()).toEqual({ dir: KB, ambiguous: false })

    // 目标目录失效时回落到当前打开文件所属目录
    await store.openFile(`${NOTES}\\b.mindmap.json`, true)
    store.activeDir = 'F:\\unknown'
    expect(store.resolveTargetDir()).toEqual({ dir: NOTES, ambiguous: false })

    // 只剩一个目录 → 直接用唯一目录
    store.removeDir(NOTES)
    expect(store.resolveTargetDir()).toEqual({ dir: KB, ambiguous: false })

    // 没有任何目录 → 提示先添加目录
    store.removeDir(KB)
    expect(store.resolveTargetDir()).toEqual({ dir: null, ambiguous: false })
  })

  test('单个目录读取失败不影响其它分组', async () => {
    failDirs.add(KB)
    const { store } = await loadStores()
    await store.init()

    expect(store.groups[0].error).toBeNull()
    expect(store.groups[0].files).toHaveLength(2)
    expect(store.groups[1].error).toBeTruthy()
    expect(store.groups[1].files).toHaveLength(0)
  })
})
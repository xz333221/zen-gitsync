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
// 思维导图 store：管理目录列表（多根聚合）、各目录下的文件列表、当前编辑文件、dirty 状态。
// 持久化策略：
//   - 目录列表写回 configStore.ui.mindmapDirs（~/.zen-gitsync/config.json），
//     由 configStore 的 watch 统一落盘；旧单值 ui.mindmapDir 仅作迁移输入（见 configStore.loadConfig）
//   - 文件保存是手动的（Ctrl+S / 工具栏按钮 / 切换文件前提示）
//     加自动保存：编辑停止 1500ms 后在 MindmapView 内静默调用本 store 的 saveCurrent
//   - @change 事件只标记 dirty=true 并调度自动保存 timer，避免频繁 IO
//
// 多目录规则：每个目录只列本级 *.mindmap.json（不递归）；
// 列表接口仍按单目录调用，前端 Promise.all 并发，一个目录失败不影响其它目录。
//
// 文件格式：flow-mindmap 组件 exportData() 返回的 JSON 字符串，
// 直接以 utf-8 落盘。读回时用 importData() 还原，保留所有节点
// 样式 / 图片 / 色板 / 折叠状态。

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useConfigStore } from './configStore'

export interface MindmapFileMeta {
  name: string
  path: string
  size: number
  mtime: number
  title: string
}

export interface CurrentMindmap {
  path: string
  title: string
  content: string
  mtime: number
}

/** 一个目录及其本级文件列表 */
export interface MindmapDirGroup {
  dir: string
  files: MindmapFileMeta[]
  error: string | null
  loading: boolean
}

/** 目录路径归一化：trim + 去掉尾部分隔符（保留 C:\ 这类盘符根） */
export function normalizeMindmapDir(input: string): string {
  const trimmed = (input || '').trim()
  if (!trimmed) return ''
  const stripped = trimmed.replace(/[\\/]+$/, '')
  if (!stripped) return trimmed
  if (/^[a-z]:$/i.test(stripped)) return `${stripped}\\`
  return stripped
}

/** 路径比较 key：统一分隔符 + 小写（Windows 不区分大小写） */
function pathKey(input: string): string {
  return normalizeMindmapDir(input)
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase()
}

/** filePath 是否位于 dir 之下（含 dir 自身） */
export function isUnderDir(filePath: string, dir: string): boolean {
  const f = pathKey(filePath)
  const d = pathKey(dir)
  if (!f || !d) return false
  if (f === d) return true
  return f.startsWith(d.endsWith('\\') ? d : `${d}\\`)
}

/** 取文件所在目录（用于反查归属分组） */
function dirnameOf(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
  return idx > 0 ? filePath.slice(0, idx) : filePath
}

export const useMindmapStore = defineStore('mindmap', () => {
  const configStore = useConfigStore()

  // 已添加的目录（多根聚合），初值懒加载：由 init() 从 configStore.ui.mindmapDirs 对齐
  const dirs = ref<string[]>([])
  const groups = ref<MindmapDirGroup[]>([])
  const current = ref<CurrentMindmap | null>(null)
  const dirty = ref(false)
  // 当前文件的读/写请求是否进行中（打开、新建、保存）
  const loading = ref(false)
  const error = ref<string | null>(null)
  // 「新建 / 从 MD 导入」的目标目录：打开文件时跟随该文件所在目录，也可由分组头显式指定
  const activeDir = ref('')
  // 最近一次从磁盘读到的 content 快照，用于判断「保存后是否又被外部改动」
  const lastSavedContent = ref<string>('')

  const hasCurrent = computed(() => current.value !== null)
  const filesCount = computed(() => groups.value.reduce((n, g) => n + g.files.length, 0))
  // 任意分组正在刷新
  const refreshing = computed(() => groups.value.some((g) => g.loading))

  // 目录列表写回 configStore（统一由 configStore 的 watch 落盘），
  // 保持内存单一来源，避免视图重新挂载时把已移除的目录再登记回来。
  function persistDirs() {
    configStore.ui.mindmapDirs = [...dirs.value]
  }

  function findGroup(dir: string): MindmapDirGroup | undefined {
    return groups.value.find((g) => pathKey(g.dir) === pathKey(dir))
  }

  function ensureGroup(dir: string): MindmapDirGroup {
    const existing = findGroup(dir)
    if (existing) return existing
    const group: MindmapDirGroup = { dir, files: [], error: null, loading: false }
    groups.value.push(group)
    return group
  }

  // 登记一个目录（归一化 + 去重，不落盘），返回是否新增
  function registerDir(rawDir: string): boolean {
    const dir = normalizeMindmapDir(rawDir)
    if (!dir) return false
    if (dirs.value.some((d) => pathKey(d) === pathKey(dir))) return false
    dirs.value.push(dir)
    ensureGroup(dir)
    return true
  }

  // 每个目录的请求序号：并发刷新时丢弃过期响应，避免慢响应覆盖新结果
  const groupSeq = new Map<string, number>()

  // ── 刷新单个目录 ────────────────────────────────────────────────
  async function refreshDir(dir: string) {
    const group = findGroup(dir)
    if (!group) return
    const key = pathKey(group.dir)
    const seq = (groupSeq.get(key) || 0) + 1
    groupSeq.set(key, seq)

    group.loading = true
    group.error = null
    try {
      const res = await fetch(`/api/mindmap/list?dir=${encodeURIComponent(group.dir)}`)
      const json = await res.json()
      if (groupSeq.get(key) !== seq) return
      if (json.success) {
        // 服务端回传的是 path.resolve 后的权威路径，与本地形式不同时同步（去重/持久化用同一形式）
        const resolvedDir: string = typeof json.dir === 'string' && json.dir ? json.dir : group.dir
        if (resolvedDir !== group.dir) {
          const idx = dirs.value.findIndex((d) => pathKey(d) === pathKey(group.dir))
          if (idx >= 0) dirs.value[idx] = resolvedDir
          group.dir = resolvedDir
          persistDirs()
        }
        group.files = json.files || []
      } else {
        group.error = json.error || '读取目录失败'
        group.files = []
      }
    } catch (e: any) {
      if (groupSeq.get(key) !== seq) return
      group.error = e?.message || String(e)
      group.files = []
    } finally {
      if (groupSeq.get(key) === seq) group.loading = false
    }
  }

  // ── 刷新全部目录 ────────────────────────────────────────────────
  async function refresh() {
    await Promise.all(dirs.value.map((d) => refreshDir(d)))
  }

  // ── 初始化：与配置对齐后刷新全部目录 ─────────────────────────────
  async function init() {
    const stored = Array.isArray(configStore.ui.mindmapDirs) ? configStore.ui.mindmapDirs : []
    for (const d of stored) registerDir(d)
    if (activeDir.value && !dirs.value.some((d) => pathKey(d) === pathKey(activeDir.value))) {
      activeDir.value = ''
    }
    await refresh()
  }

  // ── 添加目录（picker 多选） ─────────────────────────────────────
  // 返回实际新增数量（重复/非法路径被忽略）
  async function addDirs(paths: string[]): Promise<number> {
    const added: string[] = []
    for (const p of paths || []) {
      const dir = normalizeMindmapDir(p)
      if (!dir) continue
      if (registerDir(dir)) added.push(dir)
    }
    if (added.length === 0) return 0
    persistDirs()
    // 目标目录未设置时，用第一个新增目录作为「新建/导入」的默认落点
    if (!activeDir.value) activeDir.value = added[0]
    await Promise.all(added.map((d) => refreshDir(d)))
    return added.length
  }

  // ── 移除目录：只从列表移除，不删除磁盘文件，当前打开文件保持打开 ──
  function removeDir(dir: string) {
    const key = pathKey(dir)
    dirs.value = dirs.value.filter((d) => pathKey(d) !== key)
    groups.value = groups.value.filter((g) => pathKey(g.dir) !== key)
    groupSeq.delete(key)
    if (activeDir.value && pathKey(activeDir.value) === key) activeDir.value = ''
    persistDirs()
  }

  // ── 解析「新建 / 导入」的目标目录 ───────────────────────────────
  // activeDir 命中 → 当前打开文件所属目录 → 唯一目录 → 有歧义（由调用方提示）
  function resolveTargetDir(): { dir: string | null; ambiguous: boolean } {
    if (dirs.value.length === 0) return { dir: null, ambiguous: false }
    const active = dirs.value.find((d) => pathKey(d) === pathKey(activeDir.value))
    if (active) return { dir: active, ambiguous: false }
    const currentPath = current.value?.path
    if (currentPath) {
      const owner = dirs.value.find((d) => isUnderDir(currentPath, d))
      if (owner) return { dir: owner, ambiguous: false }
    }
    if (dirs.value.length === 1) return { dir: dirs.value[0], ambiguous: false }
    return { dir: null, ambiguous: true }
  }

  // ── 打开文件 ────────────────────────────────────────────────────
  // force: 跳过 dirty 检查（用于「丢弃改动」之后）
  async function openFile(filePath: string, force = false) {
    if (!force && dirty.value && current.value) {
      // 调用方应在外层先弹确认框，这里只是兜底拒绝
      throw new Error('UNSAVED_CHANGES')
    }
    loading.value = true
    error.value = null
    try {
      const res = await fetch(
        `/api/mindmap/read?path=${encodeURIComponent(filePath)}`
      )
      const json = await res.json()
      if (json.success) {
        current.value = {
          path: json.path,
          title: json.title,
          content: json.content,
          mtime: json.mtime
        }
        lastSavedContent.value = json.content
        dirty.value = false
        // 目标目录跟随当前文件：下次「新建/导入」默认落在同一目录
        const owner = dirs.value.find((d) => isUnderDir(json.path, d))
        activeDir.value = owner || dirnameOf(json.path)
      } else {
        error.value = json.error || '读取文件失败'
      }
    } catch (e: any) {
      error.value = e?.message || String(e)
    } finally {
      loading.value = false
    }
  }

  // ── 新建文件 ────────────────────────────────────────────────────
  // dir: 目标目录（缺省由 resolveTargetDir 解析，解析不出时抛错）
  async function createFile(name: string, force = false, dir?: string) {
    const target = dir ? normalizeMindmapDir(dir) : resolveTargetDir().dir
    if (!target) throw new Error('未选择目录')
    if (!force && dirty.value && current.value) {
      throw new Error('UNSAVED_CHANGES')
    }
    loading.value = true
    error.value = null
    try {
      const res = await fetch('/api/mindmap/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: target, name })
      })
      const json = await res.json()
      if (json.success) {
        current.value = {
          path: json.path,
          title: json.title,
          content: json.content,
          mtime: json.mtime
        }
        lastSavedContent.value = json.content
        dirty.value = false
        activeDir.value = target
        // 只刷新目标目录，让新文件出现在对应分组里
        await refreshDir(target)
      } else {
        error.value = json.error || '新建失败'
        throw new Error(json.error || '新建失败')
      }
    } catch (e: any) {
      if (e.message === 'UNSAVED_CHANGES') throw e
      error.value = e?.message || String(e)
      throw e
    } finally {
      loading.value = false
    }
  }

  // ── 保存当前文件 ────────────────────────────────────────────────
  // content 由调用方从 MindMap 组件 ref.exportData() 取得后传入
  async function saveCurrent(content: string) {
    if (!current.value) throw new Error('没有打开的文件')
    loading.value = true
    error.value = null
    try {
      const res = await fetch('/api/mindmap/save', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: current.value.path,
          content
        })
      })
      const json = await res.json()
      if (json.success) {
        // 同步更新 content 与 mtime：content 必须更新，否则模板里
        // JSON.parse(store.current.content) 在父组件重渲染时会拿到旧值，
        // 触发 flow-mindmap 的浅 data watcher 用旧内容覆盖内部状态，
        // 表现为「保存后导图回退到保存前的样式」。
        const savedPath = current.value.path
        if (current.value) {
          current.value.content = content
          current.value.mtime = json.mtime
        }
        lastSavedContent.value = content
        dirty.value = false
        // 只刷新该文件所属分组（mtime 变了，排序可能变）
        await refreshOwnerOf(savedPath)
        return json
      } else {
        error.value = json.error || '保存失败'
        throw new Error(json.error || '保存失败')
      }
    } catch (e: any) {
      error.value = e?.message || String(e)
      throw e
    } finally {
      loading.value = false
    }
  }

  // 刷新某个文件所属的分组（目录已被移除时找不到分组则跳过）
  async function refreshOwnerOf(filePath: string) {
    const owner = groups.value.find((g) => isUnderDir(filePath, g.dir))
    if (owner) await refreshDir(owner.dir)
  }

  // ── 删除文件 ────────────────────────────────────────────────────
  async function deleteFile(filePath: string) {
    const res = await fetch('/api/mindmap/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath })
    })
    const json = await res.json()
    if (!json.success) throw new Error(json.error || '删除失败')
    // 如果删的是当前打开的文件，清空 current
    if (current.value && current.value.path === filePath) {
      current.value = null
      dirty.value = false
      lastSavedContent.value = ''
    }
    await refreshOwnerOf(filePath)
    return json
  }

  // ── 重命名 ──────────────────────────────────────────────────────
  async function renameFile(filePath: string, newName: string) {
    const res = await fetch('/api/mindmap/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, newName })
    })
    const json = await res.json()
    if (!json.success) throw new Error(json.error || '重命名失败')
    // 如果重命名的是当前文件，同步更新 current.path
    if (current.value && filePath === current.value.path) {
      current.value = {
        ...current.value,
        path: json.path,
        title: newName
      }
    }
    await refreshOwnerOf(json.path || filePath)
    return json
  }

  // ── 标记 dirty（由 MindMap @change 触发） ───────────────────────
  function markDirty() {
    if (!current.value) return
    dirty.value = true
  }

  // ── 关闭当前文件（不保存，调用方应先确认） ───────────────────────
  function closeCurrent() {
    current.value = null
    dirty.value = false
    lastSavedContent.value = ''
  }

  return {
    dirs,
    groups,
    current,
    dirty,
    loading,
    refreshing,
    error,
    activeDir,
    hasCurrent,
    filesCount,
    init,
    addDirs,
    removeDir,
    refresh,
    refreshDir,
    resolveTargetDir,
    openFile,
    createFile,
    saveCurrent,
    deleteFile,
    renameFile,
    markDirty,
    closeCurrent
  }
})
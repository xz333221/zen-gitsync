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
// 思维导图 store：管理当前目录、文件列表、当前编辑文件、dirty 状态。
// 持久化策略：
//   - currentDir 持久化到 ~/.git-commit-tool.json ui.mindmapDir（避免因随机端口导致 localStorage 失效）
//   - 文件保存是手动的（Ctrl+S / 工具栏按钮 / 切换文件前提示）
//   - @change 事件只标记 dirty=true，不自动写盘，避免频繁 IO
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

export const useMindmapStore = defineStore('mindmap', () => {
  const configStore = useConfigStore()
  // 当前目录（持久化到 ~/.git-commit-tool.json ui.mindmapDir，避免因随机端口导致 localStorage 失效）
  const currentDir = ref<string>((configStore.ui as any).mindmapDir || '')
  const files = ref<MindmapFileMeta[]>([])
  const current = ref<CurrentMindmap | null>(null)
  const dirty = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)

  // 最近一次从磁盘读到的 content 快照，用于判断「保存后是否又被外部改动」
  const lastSavedContent = ref<string>('')

  const hasCurrent = computed(() => current.value !== null)
  const filesCount = computed(() => files.value.length)

  function persistDir(dir: string) {
    configStore.saveUiSettings({ mindmapDir: dir })
  }

  // ── 列目录 ──────────────────────────────────────────────────────
  async function listFiles(dir?: string) {
    const target = dir ?? currentDir.value
    if (!target) {
      error.value = null
      files.value = []
      return
    }
    loading.value = true
    error.value = null
    try {
      const res = await fetch(
        `/api/mindmap/list?dir=${encodeURIComponent(target)}`
      )
      const json = await res.json()
      if (json.success) {
        currentDir.value = json.dir
        files.value = json.files || []
        persistDir(json.dir)
      } else {
        error.value = json.error || '读取目录失败'
        files.value = []
      }
    } catch (e: any) {
      error.value = e?.message || String(e)
      files.value = []
    } finally {
      loading.value = false
    }
  }

  // ── 切换目录 ────────────────────────────────────────────────────
  async function setDir(dir: string) {
    await listFiles(dir)
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
  async function createFile(name: string, force = false) {
    if (!currentDir.value) throw new Error('未选择目录')
    if (!force && dirty.value && current.value) {
      throw new Error('UNSAVED_CHANGES')
    }
    loading.value = true
    error.value = null
    try {
      const res = await fetch('/api/mindmap/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: currentDir.value, name })
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
        // 刷新列表，让新文件出现在列表里
        await listFiles()
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
        // 原地更新 mtime，避免创建新对象引用导致 Vue 重新计算 :data prop
        // （flow-mindmap 组件对 data 深层引用替换处理不佳，会导致分支渲染丢失）
        if (current.value) current.value.mtime = json.mtime
        lastSavedContent.value = content
        dirty.value = false
        // 刷新列表（mtime 变了，排序可能变）
        await listFiles()
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
    await listFiles()
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
    await listFiles()
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
    currentDir,
    files,
    current,
    dirty,
    loading,
    error,
    hasCurrent,
    filesCount,
    listFiles,
    setDir,
    openFile,
    createFile,
    saveCurrent,
    deleteFile,
    renameFile,
    markDirty,
    closeCurrent
  }
})

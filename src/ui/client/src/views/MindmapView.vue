<!--
  ~ Copyright 2026 xz333221
  ~
  ~ Licensed under the Apache License, Version 2.0 (the "License");
  ~ you may not use this file except in compliance with the License.
  ~ You may obtain a copy of the License at
  ~
  ~     http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing, software
  ~ distributed under the License is distributed on an "AS IS" BASIS,
  ~ WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  ~ See the License for the specific language governing permissions and
  ~ limitations under the License.
  -->
<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { $t } from '@/lang/static'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  FolderOpened,
  Plus,
  FolderChecked,
  Delete,
  Edit,
  Refresh,
  Document
} from '@element-plus/icons-vue'
import { FilePickerModal as FilePicker } from 'local-file-picker/client'
import { MindMap, markdownToMindMap, type MindMapNode } from 'flow-mindmap'
import 'flow-mindmap/style.css'
import { useMindmapStore } from '@/stores/mindmapStore'
import { useConfigStore } from '@/stores/configStore'
import { useLocaleStore } from '@/stores/localeStore'
import { storeToRefs } from 'pinia'

const store = useMindmapStore()
const configStore = useConfigStore()
const { currentLocale } = storeToRefs(useLocaleStore())

// local-file-picker 主题跟随系统配置
const isDark = computed(() => {
  const t = configStore.theme
  if (t === 'dark') return true
  if (t === 'light') return false
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
})

// ── MindMap 组件 ref ──────────────────────────────────────────────
// 用 ref 拿到组件 expose 的方法：exportData / importData / getMarkdown 等
const mmRef = ref<InstanceType<typeof MindMap> | null>(null)

// ── 目录选择（local-file-picker） ─────────────────────────────────
const filePickerVisible = ref(false)

function openDirPicker() {
  filePickerVisible.value = true
}

function onPickerConfirm(paths: string[]) {
  filePickerVisible.value = false
  if (paths && paths.length > 0) {
    store.setDir(paths[0])
  }
}

// ── 新建文件 ──────────────────────────────────────────────────────
async function handleNewFile() {
  if (!store.currentDir) {
    ElMessage.warning($t('@MINDMAP:请先选择目录'))
    return
  }
  // dirty 确认
  if (!(await confirmDiscardIfDirty())) return
  let name = ''
  try {
    const res = await ElMessageBox.prompt(
      $t('@MINDMAP:输入文件名提示'),
      $t('@MINDMAP:新建思维导图'),
      {
        confirmButtonText: $t('@MINDMAP:新建'),
        cancelButtonText: $t('@MINDMAP:取消'),
        inputPlaceholder: $t('@MINDMAP:文件名占位'),
        inputValidator: (v: string) => {
          if (!v || !v.trim()) return $t('@MINDMAP:名称不能为空')
          if (/[\\/:*?"<>|]/.test(v)) return $t('@MINDMAP:名称含非法字符')
          return true
        }
      }
    )
    name = res.value.trim()
  } catch {
    return
  }
  try {
    await store.createFile(name, true)
    ElMessage.success($t('@MINDMAP:已新建并打开'))
  } catch (e: any) {
    ElMessage.error(e?.message || $t('@MINDMAP:新建失败'))
  }
}

// ── 保存 ──────────────────────────────────────────────────────────
async function handleSave() {
  if (!store.current) return
  try {
    const content = mmRef.value?.exportData()
    if (!content) {
      ElMessage.warning($t('@MINDMAP:无法获取数据'))
      return
    }
    await store.saveCurrent(content)
    // 不强制重挂载 MindMap：组件内部已持有用户最新编辑状态，
    // 重新挂载会用 store.current.content（未更新为最新保存值）初始化导致回退。
    // saveCurrent 内部原地更新 mtime（不创建新对象引用），避免触发 :data 重算。
    ElMessage.success($t('@MINDMAP:已保存'))
  } catch (e: any) {
    ElMessage.error(e?.message || $t('@MINDMAP:保存失败'))
  }
}

// ── 切换文件（带 dirty 确认） ─────────────────────────────────────
async function confirmDiscardIfDirty(): Promise<boolean> {
  if (!store.dirty || !store.current) return true
  try {
    await ElMessageBox.confirm(
      $t('@MINDMAP:未保存提示').replace('{title}', store.current.title),
      $t('@MINDMAP:未保存的改动'),
      {
        confirmButtonText: $t('@MINDMAP:保存'),
        cancelButtonText: $t('@MINDMAP:丢弃'),
        distinguishCancelAndClose: true,
        type: 'warning'
      }
    )
    // 用户点「保存」
    const content = mmRef.value?.exportData()
    if (content) {
      await store.saveCurrent(content)
      ElMessage.success($t('@MINDMAP:已保存'))
    }
    return true
  } catch (action) {
    // action === 'cancel' → 丢弃；action === 'close' → 取消整个操作
    if (action === 'cancel') return true
    return false
  }
}

async function handleOpenFile(filePath: string) {
  if (store.current && store.current.path === filePath) return
  if (!(await confirmDiscardIfDirty())) return
  try {
    await store.openFile(filePath, true)
  } catch (e: any) {
    ElMessage.error(e?.message || $t('@MINDMAP:打开失败'))
  }
}

// ── 删除 / 重命名 ─────────────────────────────────────────────────
async function handleDelete(file: { path: string; title: string }) {
  try {
    await ElMessageBox.confirm(
      $t('@MINDMAP:确认删除提示').replace('{title}', file.title),
      $t('@MINDMAP:删除'),
      {
        confirmButtonText: $t('@MINDMAP:删除'),
        cancelButtonText: $t('@MINDMAP:取消'),
        type: 'warning'
      }
    )
  } catch {
    return
  }
  try {
    await store.deleteFile(file.path)
    ElMessage.success($t('@MINDMAP:已删除'))
  } catch (e: any) {
    ElMessage.error(e?.message || $t('@MINDMAP:删除失败'))
  }
}

async function handleRename(file: { path: string; title: string }) {
  let newName = ''
  try {
    const res = await ElMessageBox.prompt(
      $t('@MINDMAP:输入新名称提示'),
      $t('@MINDMAP:重命名'),
      {
        confirmButtonText: $t('@MINDMAP:确定'),
        cancelButtonText: $t('@MINDMAP:取消'),
        inputValue: file.title,
        inputValidator: (v: string) => {
          if (!v || !v.trim()) return $t('@MINDMAP:名称不能为空')
          if (/[\\/:*?"<>|]/.test(v)) return $t('@MINDMAP:名称含非法字符')
          return true
        }
      }
    )
    newName = res.value.trim()
  } catch {
    return
  }
  try {
    await store.renameFile(file.path, newName)
    ElMessage.success($t('@MINDMAP:已重命名'))
  } catch (e: any) {
    ElMessage.error(e?.message || $t('@MINDMAP:重命名失败'))
  }
}

// ── MindMap 事件 ──────────────────────────────────────────────────
function onMindMapChange(_node: MindMapNode) {
  store.markDirty()
}

// ── 从 markdown 导入（创建一个新思维导图，内容来自 md） ──────────
async function handleImportMarkdown() {
  if (!store.currentDir) {
    ElMessage.warning($t('@MINDMAP:请先选择目录'))
    return
  }
  let md = ''
  let name = ''
  try {
    const res = await ElMessageBox.prompt(
      $t('@MINDMAP:粘贴Markdown提示'),
      $t('@MINDMAP:从Markdown导入'),
      {
        confirmButtonText: $t('@MINDMAP:导入'),
        cancelButtonText: $t('@MINDMAP:取消'),
        inputType: 'textarea',
        inputPlaceholder: $t('@MINDMAP:Markdown占位'),
        inputValidator: (v: string) => {
          if (!v || !v.trim()) return $t('@MINDMAP:内容不能为空')
          return true
        }
      }
    )
    md = res.value
  } catch {
    return
  }
  // 第二步：问名字
  try {
    const res = await ElMessageBox.prompt(
      $t('@MINDMAP:输入文件名提示'),
      $t('@MINDMAP:文件名'),
      {
        confirmButtonText: $t('@MINDMAP:新建'),
        cancelButtonText: $t('@MINDMAP:取消'),
        inputValidator: (v: string) => {
          if (!v || !v.trim()) return $t('@MINDMAP:名称不能为空')
          if (/[\\/:*?"<>|]/.test(v)) return $t('@MINDMAP:名称含非法字符')
          return true
        }
      }
    )
    name = res.value.trim()
  } catch {
    return
  }
  // 先创建空文件，再用 md 内容覆盖保存
  try {
    await store.createFile(name, true)
    // 用 markdownToMindMap 转成数据，再让组件 importData
    const data = markdownToMindMap(md, name)
    const json = JSON.stringify(data, null, 2)
    await store.saveCurrent(json)
    ElMessage.success($t('@MINDMAP:已导入'))
  } catch (e: any) {
    ElMessage.error(e?.message || $t('@MINDMAP:导入失败'))
  }
}

// ── 导出 markdown（复制到剪贴板） ────────────────────────────────
async function handleExportMarkdown() {
  if (!mmRef.value) return
  try {
    const md = mmRef.value.getMarkdown()
    await navigator.clipboard.writeText(md)
    ElMessage.success($t('@MINDMAP:已复制Markdown'))
  } catch (e: any) {
    ElMessage.error(e?.message || $t('@MINDMAP:复制失败'))
  }
}

// ── 快捷键 Ctrl+S 保存 ────────────────────────────────────────────
function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault()
    if (store.current && store.dirty) handleSave()
  }
}

// ── 当前 content 变化时，用 importData 把数据灌进组件 ─────────────
// 用 watch + key 强制 MindMap 重新挂载，避免 importData 时序问题
const mmKey = ref(0)
watch(
  () => store.current?.path,
  () => {
    mmKey.value++
  }
)

// 把 store.current.content 解析成 MindMap 的 data prop。
// 用 computed 缓存：同字符串 → 同引用，避免每次父组件重渲染都产生新对象，
// 触发 flow-mindmap 内部浅 data watcher 覆盖组件内部状态（保存后视觉回退的根因）。
const mmData = computed(() => {
  const c = store.current?.content
  if (!c) return null
  try {
    return JSON.parse(c)
  } catch {
    return null
  }
})

// ── 生命周期 ──────────────────────────────────────────────────────
onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  // 有已保存的目录则自动加载文件列表；不弹窗，等用户主动点「选择目录」
  if (store.currentDir) {
    await store.listFiles()
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})

// ── 格式化 ────────────────────────────────────────────────────────
function formatTime(ms: number): string {
  if (!ms) return '-'
  const d = new Date(ms)
  const now = Date.now()
  const diff = now - ms
  if (diff < 60_000) return $t('@MINDMAP:刚刚')
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}${$t('@MINDMAP:分钟前')}`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}${$t('@MINDMAP:小时前')}`
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatSize(bytes: number): string {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <div class="mindmap-view">
    <!-- 顶部工具栏 -->
    <div class="mm-toolbar">
      <div class="mm-toolbar-left">
        <el-button size="small" :icon="FolderOpened" @click="openDirPicker">
          {{ $t('@MINDMAP:选择目录') }}
        </el-button>
        <span class="mm-dir-path" v-if="store.currentDir" :title="store.currentDir">
          {{ store.currentDir }}
        </span>
        <span class="mm-dir-empty" v-else>{{ $t('@MINDMAP:未选择目录') }}</span>
      </div>
      <div class="mm-toolbar-right">
        <el-button
          size="small"
          :icon="Plus"
          :disabled="!store.currentDir"
          @click="handleNewFile"
        >{{ $t('@MINDMAP:新建') }}</el-button>
        <el-button
          size="small"
          :icon="Document"
          :disabled="!store.currentDir"
          @click="handleImportMarkdown"
        >{{ $t('@MINDMAP:从MD导入') }}</el-button>
        <el-button
          size="small"
          :icon="Edit"
          :disabled="!store.current"
          @click="handleExportMarkdown"
        >{{ $t('@MINDMAP:复制MD') }}</el-button>
        <el-button
          size="small"
          type="primary"
          :icon="FolderChecked"
          :disabled="!store.current || !store.dirty"
          :loading="store.loading"
          @click="handleSave"
        >{{ $t('@MINDMAP:保存') }}</el-button>
        <span v-if="store.current" class="mm-status">
          <span class="mm-status-title" :title="store.current.title">{{ store.current.title }}</span>
          <span v-if="store.dirty" class="mm-status-dirty">●</span>
        </span>
      </div>
    </div>

    <div class="mm-body">
      <!-- 左侧文件列表 -->
      <div class="mm-sidebar">
        <div class="mm-sidebar-header">
          <span class="mm-sidebar-title">{{ $t('@MINDMAP:文件列表') }}</span>
          <el-button
            size="small"
            text
            :icon="Refresh"
            :loading="store.loading"
            @click="store.listFiles()"
            :disabled="!store.currentDir"
          />
        </div>

        <div class="mm-sidebar-list" v-loading="store.loading">
          <div v-if="store.error && !store.loading" class="mm-sidebar-error">
            {{ store.error }}
          </div>
          <div v-else-if="!store.currentDir" class="mm-sidebar-empty">
            {{ $t('@MINDMAP:请先选择目录') }}
          </div>
          <div v-else-if="store.files.length === 0" class="mm-sidebar-empty">
            {{ $t('@MINDMAP:暂无思维导图') }}
          </div>
          <div
            v-else
            v-for="f in store.files"
            :key="f.path"
            class="mm-file-item"
            :class="{ active: store.current?.path === f.path }"
            @click="handleOpenFile(f.path)"
          >
            <div class="mm-file-icon">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="2" />
                <circle cx="5" cy="5" r="2" />
                <circle cx="19" cy="5" r="2" />
                <circle cx="5" cy="19" r="2" />
                <circle cx="19" cy="19" r="2" />
                <line x1="10.5" y1="10.5" x2="6.5" y2="6.5" />
                <line x1="13.5" y1="10.5" x2="17.5" y2="6.5" />
                <line x1="10.5" y1="13.5" x2="6.5" y2="17.5" />
                <line x1="13.5" y1="13.5" x2="17.5" y2="17.5" />
              </svg>
            </div>
            <div class="mm-file-info">
              <div class="mm-file-title" :title="f.title">{{ f.title }}</div>
              <div class="mm-file-meta">
                {{ formatTime(f.mtime) }} · {{ formatSize(f.size) }}
              </div>
            </div>
            <div class="mm-file-actions" @click.stop>
              <el-button
                size="small"
                text
                :icon="Edit"
                @click="handleRename(f)"
                :title="$t('@MINDMAP:重命名')"
              />
              <el-button
                size="small"
                text
                type="danger"
                :icon="Delete"
                @click="handleDelete(f)"
                :title="$t('@MINDMAP:删除')"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- 右侧编辑区 -->
      <div class="mm-editor">
        <div v-if="!store.current" class="mm-editor-empty">
          <svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="2" />
            <circle cx="5" cy="5" r="2" />
            <circle cx="19" cy="5" r="2" />
            <circle cx="5" cy="19" r="2" />
            <circle cx="19" cy="19" r="2" />
            <line x1="10.5" y1="10.5" x2="6.5" y2="6.5" />
            <line x1="13.5" y1="10.5" x2="17.5" y2="6.5" />
            <line x1="10.5" y1="13.5" x2="6.5" y2="17.5" />
            <line x1="13.5" y1="13.5" x2="17.5" y2="17.5" />
          </svg>
          <p class="mm-editor-empty-title">{{ $t('@MINDMAP:思维导图编辑器') }}</p>
          <p class="mm-editor-empty-hint">
            {{ store.currentDir ? $t('@MINDMAP:从左侧选择或新建') : $t('@MINDMAP:先选择目录提示') }}
          </p>
        </div>
        <MindMap
          v-else
          :key="mmKey"
          ref="mmRef"
          :data="mmData"
          @change="onMindMapChange"
        />
      </div>
    </div>

    <!-- 目录选择（local-file-picker） -->
    <FilePicker
      :visible="filePickerVisible"
      mode="directory"
      :theme="isDark ? 'dark' : 'light'"
      :locale="currentLocale"
      @close="filePickerVisible = false"
      @confirm="onPickerConfirm"
    />
  </div>
</template>

<style scoped>
.mindmap-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-page);
  overflow: hidden;
}

/* ── 工具栏 ───────────────────────────────────────────────────── */
.mm-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  background: var(--bg-container);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  gap: 12px;
}

.mm-toolbar-left,
.mm-toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.mm-toolbar-right {
  flex-shrink: 0;
}

.mm-dir-path {
  font-size: 12px;
  color: var(--text-secondary);
  font-family: var(--font-mono, monospace);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 320px;
  padding: 2px 8px;
  background: var(--bg-subtle);
  border-radius: var(--radius-sm);
}

.mm-dir-empty {
  font-size: 12px;
  color: var(--text-tertiary);
  font-style: italic;
}

.mm-status {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}

.mm-status-title {
  max-width: 160px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}

.mm-status-dirty {
  color: var(--color-warning);
  font-size: 14px;
  line-height: 1;
}

/* ── 主体 ─────────────────────────────────────────────────────── */
.mm-body {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

/* ── 左侧文件列表 ─────────────────────────────────────────────── */
.mm-sidebar {
  width: 240px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-container);
  border-right: 1px solid var(--border-color);
}

.mm-sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-panel);
}

.mm-sidebar-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.mm-sidebar-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px;
}

.mm-sidebar-empty,
.mm-sidebar-error {
  padding: 24px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--text-tertiary);
}

.mm-sidebar-error {
  color: var(--color-danger);
}

.mm-file-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background 0.15s ease;
  position: relative;
}

.mm-file-item:hover {
  background: var(--bg-hover);
}

.mm-file-item.active {
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
}

.mm-file-item.active .mm-file-title {
  color: var(--color-primary);
  font-weight: 600;
}

.mm-file-icon {
  color: var(--text-tertiary);
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.mm-file-item.active .mm-file-icon {
  color: var(--color-primary);
}

.mm-file-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.mm-file-title {
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mm-file-meta {
  font-size: 10.5px;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mm-file-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.mm-file-item:hover .mm-file-actions {
  opacity: 1;
}

/* ── 右侧编辑区 ───────────────────────────────────────────────── */
.mm-editor {
  flex: 1;
  min-width: 0;
  min-height: 0;
  position: relative;
  background: var(--bg-container);
}

.mm-editor :deep(.zm-mindmap),
.mm-editor > * {
  width: 100%;
  height: 100%;
}

.mm-editor-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-tertiary);
}

.mm-editor-empty svg {
  opacity: 0.4;
}

.mm-editor-empty-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 8px 0 0;
}

.mm-editor-empty-hint {
  font-size: 13px;
  color: var(--text-tertiary);
  margin: 0;
}

/* ── 响应式 ───────────────────────────────────────────────────── */
@media (max-width: 900px) {
  .mm-sidebar {
    width: 180px;
  }
  .mm-dir-path {
    max-width: 160px;
  }
}
</style>

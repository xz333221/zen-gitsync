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
  Document,
  ArrowDown
} from '@element-plus/icons-vue'
import { FilePickerModal as FilePicker } from 'local-file-picker/client'
import { MindMap, markdownToMindMap, type MindMapNode } from 'flow-mindmap'
import 'flow-mindmap/style.css'
import { useMindmapStore, isUnderDir } from '@/stores/mindmapStore'
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

// MindMap 组件 ref — 用 expose 方法做 exportData / getMarkdown 等
const mmRef = ref<InstanceType<typeof MindMap> | null>(null)

// 目录选择（local-file-picker）：一次可多选目录
const filePickerVisible = ref(false)

function openDirPicker() {
  filePickerVisible.value = true
}

async function onPickerConfirm(paths: string[]) {
  filePickerVisible.value = false
  const list = (paths || []).filter(Boolean)
  if (list.length === 0) return
  try {
    const added = await store.addDirs(list)
    if (added > 0) {
      ElMessage.success($t('@MINDMAP:已添加目录', { n: added }))
    } else {
      ElMessage.info($t('@MINDMAP:重复目录已忽略'))
    }
  } catch (e: any) {
    ElMessage.error(e?.message || $t('@MINDMAP:读取目录失败'))
  }
}

// 分组折叠状态（key = 目录路径，不持久化）
const collapsedGroups = ref<Record<string, boolean>>({})

function toggleGroup(dir: string) {
  collapsedGroups.value = { ...collapsedGroups.value, [dir]: !collapsedGroups.value[dir] }
  // 点击分组头即把它设为「新建 / 从 MD 导入」的目标目录
  store.activeDir = dir
}

function baseName(dir: string): string {
  const parts = dir.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || dir
}

function isActiveDir(dir: string): boolean {
  return !!store.activeDir && store.activeDir.toLowerCase() === dir.toLowerCase()
}

// 解析「新建 / 导入」的目标目录；解析不出时给出提示
function pickTargetDir(): string | null {
  const { dir, ambiguous } = store.resolveTargetDir()
  if (dir) return dir
  ElMessage.warning(
    ambiguous
      ? $t('@MINDMAP:请选择目标目录')
      : $t('@MINDMAP:请先添加目录')
  )
  return null
}

// 新建文件（explicitDir 来自分组头的「在此新建」）
async function handleNewFile(explicitDir?: string) {
  const targetDir = explicitDir || pickTargetDir()
  if (!targetDir) return
  if (explicitDir) store.activeDir = explicitDir
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
    await store.createFile(name, true, targetDir)
    ElMessage.success($t('@MINDMAP:已新建并打开'))
  } catch (e: any) {
    ElMessage.error(e?.message || $t('@MINDMAP:新建失败'))
  }
}

// 保存
async function handleSave(silent = false) {
  if (!store.current) return
  try {
    const content = mmRef.value?.exportData()
    if (!content) {
      if (!silent) ElMessage.warning($t('@MINDMAP:无法获取数据'))
      return
    }
    await store.saveCurrent(content)
    if (!silent) ElMessage.success($t('@MINDMAP:已保存'))
  } catch (e: any) {
    ElMessage.error(e?.message || $t('@MINDMAP:保存失败'))
  }
}

// Debounce 自动保存 — 编辑停止 1500ms 后静默写盘
const AUTOSAVE_DELAY = 1500
let autosaveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleAutosave() {
  if (!store.current || !store.dirty) return
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null
    if (store.current && store.dirty) {
      handleSave(true)
    }
  }, AUTOSAVE_DELAY)
}

function cancelAutosave() {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer)
    autosaveTimer = null
  }
}

// 切换文件（带 dirty 确认）
async function confirmDiscardIfDirty(): Promise<boolean> {
  if (!store.dirty || !store.current) return true
  try {
    await ElMessageBox.confirm(
      $t('@MINDMAP:未保存提示', { title: store.current.title }),
      $t('@MINDMAP:未保存的改动'),
      {
        confirmButtonText: $t('@MINDMAP:保存'),
        cancelButtonText: $t('@MINDMAP:丢弃'),
        distinguishCancelAndClose: true,
        type: 'warning'
      }
    )
    cancelAutosave()
    const content = mmRef.value?.exportData()
    if (content) {
      await store.saveCurrent(content)
      ElMessage.success($t('@MINDMAP:已保存'))
    }
    return true
  } catch (action) {
    if (action === 'cancel') {
      cancelAutosave()
      return true
    }
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

// 移除目录（只从列表移除，不删除磁盘文件）
async function handleRemoveDir(dir: string) {
  const holdsCurrent = !!store.current && isUnderDir(store.current.path, dir)
  let message = $t('@MINDMAP:确认移除目录提示', { dir })
  if (holdsCurrent) message = `${message} ${$t('@MINDMAP:当前文件将保持打开')}`
  try {
    await ElMessageBox.confirm(message, $t('@MINDMAP:移除目录'), {
      confirmButtonText: $t('@MINDMAP:移除目录'),
      cancelButtonText: $t('@MINDMAP:取消'),
      type: 'warning'
    })
  } catch {
    return
  }
  store.removeDir(dir)
  ElMessage.success($t('@MINDMAP:已移除目录'))
}

// 删除 / 重命名
async function handleDelete(file: { path: string; title: string }) {
  try {
    await ElMessageBox.confirm(
      $t('@MINDMAP:确认删除提示', { title: file.title }),
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

// MindMap 事件
function onMindMapChange(_node: MindMapNode) {
  store.markDirty()
  scheduleAutosave()
}
function onMindMapSelect(_nodes: MindMapNode[] | null) {
  // flow-mindmap 0.5.0 builtInDrawers 模式下,选择高亮由组件内部处理。
}

// 从 markdown 导入（explicitDir 来自分组头的「在此新建」入口）
async function handleImportMarkdown(explicitDir?: string) {
  const targetDir = explicitDir || pickTargetDir()
  if (!targetDir) return
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
  try {
    await store.createFile(name, true, targetDir)
    const data = markdownToMindMap(md, name)
    const json = JSON.stringify(data, null, 2)
    await store.saveCurrent(json)
    ElMessage.success($t('@MINDMAP:已导入'))
  } catch (e: any) {
    ElMessage.error(e?.message || $t('@MINDMAP:导入失败'))
  }
}

// 导出 markdown（复制到剪贴板）
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

// 快捷键 Ctrl+S 保存
function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault()
    if (store.current && store.dirty) {
      cancelAutosave()
      handleSave()
    }
  }
}

// 当前 content 变化时，用 key 强制 MindMap 重新挂载
const mmKey = ref(0)
watch(
  () => store.current?.path,
  () => {
    mmKey.value++
  }
)

// flow-mindmap 0.5.0 builtInDrawers 模式:
// MindMap 默认 builtInDrawers=true,组件内部自渲染 Drawer + Panel
// (settings/data/markdown/note/outline)。canvas-toggle-preview 仍 emit
// 给宿主控制 previewMode。
const previewMode = ref(false)

function onCanvasTogglePreview() {
  previewMode.value = !previewMode.value
}

// 把 store.current.content 解析成 MindMap 的 data prop
const mmData = computed(() => {
  const c = store.current?.content
  if (!c) return null
  try {
    return JSON.parse(c)
  } catch {
    return null
  }
})

// 生命周期
onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  await store.init()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  cancelAutosave()
})

// 格式化
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
          {{ $t('@MINDMAP:添加目录') }}
        </el-button>
        <el-tooltip v-if="store.dirs.length > 0" placement="bottom-start" :show-after="200">
          <template #content>
            <div class="mm-dir-tooltip">
              <div v-for="d in store.dirs" :key="d">{{ d }}</div>
            </div>
          </template>
          <el-tag size="small" type="info" class="mm-dir-tag">
            {{ $t('@MINDMAP:个目录', { n: store.dirs.length }) }}
          </el-tag>
        </el-tooltip>
        <span class="mm-dir-empty" v-else>{{ $t('@MINDMAP:请先添加目录') }}</span>
      </div>
      <div class="mm-toolbar-right">
        <el-button
          size="small"
          :icon="Plus"
          :disabled="store.dirs.length === 0"
          @click="handleNewFile()"
        >{{ $t('@MINDMAP:新建') }}</el-button>
        <el-button
          size="small"
          :icon="Document"
          :disabled="store.dirs.length === 0"
          @click="handleImportMarkdown()"
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
          @click="() => { cancelAutosave(); handleSave() }"
        >{{ $t('@MINDMAP:保存') }}</el-button>
        <span v-if="store.current" class="mm-status">
          <span class="mm-status-title" :title="store.current.title">{{ store.current.title }}</span>
          <span v-if="store.dirty" class="mm-status-dirty">●</span>
        </span>
      </div>
    </div>

    <div class="mm-body">
      <!-- 左侧：按目录分组的文件列表 -->
      <div class="mm-sidebar">
        <div class="mm-sidebar-header">
          <span class="mm-sidebar-title">{{ $t('@MINDMAP:文件列表') }}</span>
          <el-button
            size="small"
            text
            :icon="Refresh"
            :loading="store.refreshing"
            @click="store.refresh()"
            :disabled="store.dirs.length === 0"
          />
        </div>

        <div class="mm-sidebar-list" v-loading="store.refreshing">
          <div v-if="store.error" class="mm-sidebar-error">{{ store.error }}</div>
          <div v-if="store.dirs.length === 0" class="mm-sidebar-empty">
            {{ $t('@MINDMAP:请先添加目录') }}
          </div>
          <template v-else>
            <div v-for="group in store.groups" :key="group.dir" class="mm-group">
              <div
                class="mm-group-header"
                :class="{ active: isActiveDir(group.dir) }"
                :title="group.dir"
                @click="toggleGroup(group.dir)"
              >
                <el-icon class="mm-group-caret" :class="{ collapsed: collapsedGroups[group.dir] }">
                  <ArrowDown />
                </el-icon>
                <div class="mm-group-info">
                  <div class="mm-group-name">
                    <span class="mm-group-title">{{ baseName(group.dir) }}</span>
                    <span class="mm-group-count">{{ group.files.length }}</span>
                  </div>
                  <div class="mm-group-path">{{ group.dir }}</div>
                </div>
                <div class="mm-group-actions" @click.stop>
                  <el-button
                    size="small"
                    text
                    :icon="Plus"
                    :title="$t('@MINDMAP:在此新建')"
                    @click="handleNewFile(group.dir)"
                  />
                  <el-button
                    size="small"
                    text
                    type="danger"
                    :icon="Delete"
                    :title="$t('@MINDMAP:移除目录')"
                    @click="handleRemoveDir(group.dir)"
                  />
                </div>
              </div>

              <div v-show="!collapsedGroups[group.dir]" class="mm-group-body">
                <div v-if="group.error" class="mm-group-error" :title="group.error">
                  <span>{{ $t('@MINDMAP:目录不存在或已删除') }}</span>
                  <el-button
                    size="small"
                    text
                    type="danger"
                    @click="handleRemoveDir(group.dir)"
                  >{{ $t('@MINDMAP:移除目录') }}</el-button>
                </div>
                <div v-else-if="group.files.length === 0" class="mm-sidebar-empty">
                  {{ $t('@MINDMAP:该目录暂无思维导图') }}
                </div>
                <template v-else>
                  <div
                    v-for="f in group.files"
                    :key="f.path"
                    class="mm-file-item"
                    :class="{ active: store.current?.path === f.path }"
                    @click="handleOpenFile(f.path)"
                  >
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
                </template>
              </div>
            </div>
          </template>
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
            {{ store.dirs.length > 0 ? $t('@MINDMAP:从左侧选择或新建') : $t('@MINDMAP:先选择目录提示') }}
          </p>
        </div>
        <MindMap
          v-else
          :key="mmKey"
          ref="mmRef"
          :data="mmData"
          :preview-mode="previewMode"
          @change="onMindMapChange"
          @select="onMindMapSelect"
          @canvas-toggle-preview="onCanvasTogglePreview"
        />
      </div>
    </div>

    <!-- 目录选择（local-file-picker，支持多选目录） -->
    <!-- 传入当前目标目录作为 defaultPath：用户添加目录时不用每次都从根目录找,
         已选过的话直接定位到上次的位置;无效时 picker 自动回落到用户目录 -->
    <FilePicker
      :visible="filePickerVisible"
      mode="directory"
      :multiple="true"
      :theme="isDark ? 'dark' : 'light'"
      :locale="currentLocale"
      :default-path="store.activeDir || store.dirs[0] || ''"
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

/* 左侧占满剩余空间,让目录标签有地方展开; */
/* 右侧保持原大小不被压缩,确保所有按钮始终可见。 */
.mm-toolbar-left {
  flex: 1;
}

.mm-toolbar-right {
  flex-shrink: 0;
}

/* 已添加目录数的标签（hover 通过 tooltip 看完整路径列表） */
.mm-dir-tag {
  flex-shrink: 0;
}

.mm-dir-tooltip {
  max-width: 520px;
  word-break: break-all;
  line-height: 1.6;
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

/* ── 左侧目录分组 ─────────────────────────────────────────────── */
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

/* ── 目录分组 ─────────────────────────────────────────────────── */
.mm-group {
  margin-bottom: 2px;
}

.mm-group-header {
  position: relative; /* hover 才出现的操作按钮绝对定位在这一行的右端 */
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background 0.15s ease;
}

.mm-group-header:hover {
  background: var(--bg-container-hover);
}

/* 当前「新建 / 导入」的目标目录：背景高亮（与文件条目的选中样式一致，
   不再用左侧竖条 —— 竖条配圆角在列表行里显得突兀）。
   底色必须**不透明**：半透明的话，浮层按钮的遮罩（background: inherit）继承过来
   挡不住下面的文字，图标会和标题糊在一起 —— 这里用面板色做基底混出实色。 */
.mm-group-header.active {
  background: color-mix(in srgb, var(--color-primary) 12%, var(--bg-container));
}

.mm-group-caret {
  font-size: 12px;
  color: var(--text-tertiary);
  flex-shrink: 0;
  transition: transform 0.15s ease;
}

.mm-group-caret.collapsed {
  transform: rotate(-90deg);
}

.mm-group-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.mm-group-name {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
}

.mm-group-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mm-group-header.active .mm-group-title {
  color: var(--color-primary);
}

.mm-group-count {
  font-size: 10.5px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}

/* 完整路径小字：同名目录也能分辨（hover 有 title 看全文） */
.mm-group-path {
  font-size: 10.5px;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* hover 才出现的操作按钮：不占布局（否则隐藏时也占着右侧一条宽度），
   绝对定位浮在行右端；不可见时连点击也一起禁掉，避免点到"看不见的按钮"。
   background: inherit = 拿行自身的底色当遮罩，被按钮盖住的文字是干净地切掉，
   而不是和图标糊在一起；top/bottom 0 让遮罩撑满整行高度（只盖住按钮那点高度的话，
   两行文字会从上下露出来）；transition 同步，避免遮罩比行的 hover 底色先到位。 */
.mm-group-actions {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 6px;
  display: flex;
  align-items: center;
  gap: 2px;
  background: inherit;
  padding-left: 8px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease, background 0.15s ease;
}

.mm-group-header:hover .mm-group-actions {
  opacity: 1;
  pointer-events: auto;
}

.mm-group-body {
  padding-left: 8px;
}

.mm-group-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 8px 8px 8px 12px;
  font-size: 11.5px;
  color: var(--color-danger);
}

/* ── 文件条目 ─────────────────────────────────────────────────── */
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
  background: var(--bg-container-hover);
}

/* 同上：选中底色不透明，浮层遮罩才挡得住文字 */
.mm-file-item.active {
  background: color-mix(in srgb, var(--color-primary) 12%, var(--bg-container));
}

.mm-file-item.active .mm-file-title {
  color: var(--color-primary);
  font-weight: 600;
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

/* 同 .mm-group-actions：不占位，hover 时浮在行右端，用行底色遮住被盖住的文字 */
.mm-file-actions {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 8px;
  display: flex;
  align-items: center;
  gap: 2px;
  background: inherit;
  padding-left: 8px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease, background 0.15s ease;
}

.mm-file-item:hover .mm-file-actions {
  opacity: 1;
  pointer-events: auto;
}

/* 遮罩上的 danger 图标压深一档：Element 的 #f56c6c 在浅色遮罩上只有 ~2.5:1，
   小图标会看不清是"删除"；#dc2626 ≈ 4.2:1。深色主题下浅红反而更清楚，所以只改浅色主题。 */
html:not(.dark) .mm-group-actions :deep(.el-button--danger),
html:not(.dark) .mm-file-actions :deep(.el-button--danger) {
  color: #dc2626;
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
}
</style>
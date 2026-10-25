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
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { $t } from '@/lang/static'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Delete,
  Edit
} from '@element-plus/icons-vue'
import { FilePickerModal as FilePicker } from 'local-file-picker/client'
import { MindMap, markdownToMindMap, type MindMapNode } from 'flow-mindmap'
import 'flow-mindmap/style.css'
import { useMindmapStore, isUnderDir } from '@/stores/mindmapStore'
import { buildMindmapAiNote } from '@/utils/mindmapAiNote'
import { useConfigStore } from '@/stores/configStore'
import { useLocaleStore } from '@/stores/localeStore'
import { openPathInFileManager } from '@/composables/useDirectoryOpenActions'
import { storeToRefs } from 'pinia'
import EmptyState from '@/components/EmptyState.vue'
import EditorAgentPanel from '@/components/EditorAgentPanel.vue'

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

// ── 目录右键菜单 ────────────────────────────────────────────────
// 目录上的操作（打开目录 / 在此新建 / 移除目录）统一收进右键菜单：
// 行内 hover 按钮会随鼠标出现/消失, 容易误点, 且每个分组头都要为它留出遮罩位置。
interface DirCtxMenu {
  x: number
  y: number
  dir: string
}
const ctxMenu = ref<DirCtxMenu | null>(null)

function openDirContextMenu(e: MouseEvent, dir: string) {
  e.preventDefault()
  ctxMenu.value = { x: e.clientX, y: e.clientY, dir }
}

function closeCtxMenu() {
  ctxMenu.value = null
}

// 在系统文件管理器 / 访达里打开目录
async function ctxOpenDir() {
  const dir = ctxMenu.value?.dir
  closeCtxMenu()
  if (!dir) return
  const r = await openPathInFileManager(dir)
  if (r.success) ElMessage.success(r.message || $t('@MINDMAP:已在文件管理器中打开'))
  else ElMessage.error(r.error || $t('@MINDMAP:打开目录失败'))
}

// 在该目录下新建思维导图（等价原分组头的「在此新建」）
function ctxNewFile() {
  const dir = ctxMenu.value?.dir
  closeCtxMenu()
  if (dir) handleNewFile(dir)
}

function ctxRemoveDir() {
  const dir = ctxMenu.value?.dir
  closeCtxMenu()
  if (dir) handleRemoveDir(dir)
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
  // 全屏对话盖住了画布，得留一条键盘退路（与文件空间同一条约定）
  if (e.key === 'Escape' && aiFullscreen.value) {
    aiFullscreen.value = false
    return
  }
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
    // 换了一张导图 → 上一张的 AI 草稿作废（否则一键应用会盖上另一张图）
    draft.value = null
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

// ── 右侧 g ai 面板 ──────────────────────────────────────────────
// 与文件空间（EditorView）同一套形态：右侧一列、分隔条在面板左边缘、可全屏、
// 关闭后 v-show 保状态（进行中的流不因为切了一下就断）。复用 EditorAgentPanel，
// 不另写一份对话面板 —— 会话列表 / 输入框 / 排队 / 引擎切换都在那个组件里。
const showAi = ref(false)
// 首次打开后常驻：v-show 保状态
const aiOpened = ref(false)
const aiFullscreen = ref(false)
// 0 = 还没拖过，与画布平分；拖过就是面板的**实际像素宽**
const aiWidth = ref(0)

const aiStyle = computed(() => {
  if (aiWidth.value <= 0) return {}
  // 全屏时不能再带 max-width：内联的 calc(100% - 320px) 会把 inset:0 的面板砍窄一截
  if (aiFullscreen.value) return { flex: `0 0 ${aiWidth.value}px` }
  return { flex: `0 0 ${aiWidth.value}px`, maxWidth: 'calc(100% - 320px)' }
})

function toggleAi() {
  showAi.value = !showAi.value
  aiOpened.value = true
}

function closeAi() {
  showAi.value = false
}

/**
 * 画布宽度变了（开 / 关 g ai 面板、拖分隔条、进出全屏）之后，让导图重新居中。
 *
 * 不这么做的后果是"导图被推出可视区"：flow-mindmap 的视口是在自己的 canvas 坐标里
 * 钉住的，面板一开画布少了一半宽，根节点还停在原坐标上 —— 实测 1600 视口下画布
 * 1312→652、根节点右缘 1020 > 画布右缘 940，用户看到的就是半张图截在边上。
 * `resetView()` 用的正是**当前**容器宽高重新摆位，所以宽度变化后调它就行。
 * 放 rAF 里：等这一帧的 flex 布局落定再量，不然量到的还是旧宽度。
 */
let recenterRaf = 0
function recenterMindmap() {
  if (recenterRaf) cancelAnimationFrame(recenterRaf)
  recenterRaf = requestAnimationFrame(() => {
    recenterRaf = 0
    mmRef.value?.resetView()
  })
}

// 面板开关 / 进出全屏都会改画布宽度
watch([showAi, aiFullscreen], () => nextTick(recenterMindmap))

// 面板一关就退出全屏 —— 否则下次打开对话会莫名其妙地整屏铺开（与 EditorView 同一处置）
watch(showAi, (open) => {
  if (!open) aiFullscreen.value = false
})

/** 当前导图文件名（输入框里那张「当前文档」卡片用） */
const currentFileName = computed(() => {
  const p = store.current?.path || ''
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || ''
})

/**
 * 上下文说明（视图 + 当前文件 + mindmap 输出约定）抽到 utils/mindmapAiNote，
 * 右下角 dock 在同一视图里也用它（不带输出约定，见那个文件头）。
 */
const aiContextNote = computed(() =>
  buildMindmapAiNote(store.current?.path, currentLocale.value, { withConvention: true }),
)

// ── 分隔条拖拽（面板在分隔条右侧，向左拖 = 变宽）─────────────────
const AI_MIN_WIDTH = 300
const CANVAS_MIN_WIDTH = 320
let isAiResizing = false
let aiResizeStartX = 0
let aiResizeStartW = 0
let aiResizeMaxW = 0

function startAiResize(e: MouseEvent) {
  const handle = e.currentTarget as HTMLElement
  const body = handle.parentElement
  if (!body) return
  const bodyRect = body.getBoundingClientRect()
  const handleRect = handle.getBoundingClientRect()
  isAiResizing = true
  aiResizeStartX = e.clientX
  aiResizeStartW = bodyRect.right - handleRect.right
  aiResizeMaxW = Math.max(AI_MIN_WIDTH, bodyRect.width - CANVAS_MIN_WIDTH)
  document.addEventListener('mousemove', onAiResize)
  document.addEventListener('mouseup', stopAiResize)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  e.preventDefault()
}

function onAiResize(e: MouseEvent) {
  if (!isAiResizing) return
  const delta = aiResizeStartX - e.clientX
  aiWidth.value = Math.round(
    Math.max(AI_MIN_WIDTH, Math.min(aiResizeMaxW, aiResizeStartW + delta))
  )
}

function stopAiResize() {
  const wasResizing = isAiResizing
  isAiResizing = false
  document.removeEventListener('mousemove', onAiResize)
  document.removeEventListener('mouseup', stopAiResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  // 拖完才重新居中：拖的过程中每帧都 resetView 会把导图来回甩
  if (wasResizing) recenterMindmap()
}

// ── AI 导图草稿：从回答里抠 ```mindmap 块 ────────────────────────
// 面板只在"一轮跑完"时把最后一条回答交过来（见 EditorAgentPanel 的 assistant-done），
// 这里只认格式，不关心它是怎么生成的。
interface MindmapDraft {
  md: string
  title: string
  nodes: number
}

const draft = ref<MindmapDraft | null>(null)

function extractMindmapDraft(text: string): MindmapDraft | null {
  // 取**最后一个**块：改了几轮的话，最后那份才是定稿
  const re = /```[ \t]*(?:mindmap|mm)[ \t]*\r?\n([\s\S]*?)```/gi
  let body: string | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(String(text || ''))) !== null) body = m[1]
  const md = (body || '').trim()
  if (!md) return null
  const heads = md.match(/^#{1,6}[ \t]+\S.*$/gm) || []
  if (heads.length === 0) return null
  const title = (heads[0] || '').replace(/^#{1,6}[ \t]+/, '').trim()
  return { md, title, nodes: heads.length }
}

function onAssistantDone({ text }: { text: string }) {
  const found = extractMindmapDraft(text)
  if (found) draft.value = found
}

function dismissDraft() {
  draft.value = null
}

/** 草稿 → 导图 JSON（id 由 markdownToMindMap 生成，模型不碰结构） */
function draftToContent(d: MindmapDraft, title: string): string {
  return JSON.stringify(markdownToMindMap(d.md, title), null, 2)
}

// 应用前先把待落盘的数据算出来：这一步纯计算，坏了也不会把当前导图弄丢
async function applyDraftToCurrent() {
  const d = draft.value
  if (!d || !store.current) return
  try {
    await ElMessageBox.confirm(
      $t('@MINDMAP:覆盖当前导图确认', { title: store.current.title }),
      $t('@MINDMAP:应用导图草稿'),
      {
        confirmButtonText: $t('@MINDMAP:覆盖'),
        cancelButtonText: $t('@MINDMAP:取消'),
        type: 'warning'
      }
    )
  } catch {
    return
  }
  try {
    cancelAutosave()
    await store.saveCurrent(draftToContent(d, d.title))
    // 落盘的是草稿的根，文件标题（工具栏那个）也跟着换 —— 它读的是 current.title，
    // 不改的话保存后还挂着旧根节点的文字，看着像没生效
    if (store.current) store.current.title = d.title
    // 诱导图重挂载：flow-mindmap 的 data 是浅 watcher，换了内容不换实例会留着旧树
    mmKey.value++
    draft.value = null
    ElMessage.success($t('@MINDMAP:已应用到当前导图'))
  } catch (e: any) {
    ElMessage.error(e?.message || $t('@MINDMAP:应用草稿失败'))
  }
}

async function applyDraftAsNew() {
  const d = draft.value
  if (!d) return
  const targetDir = pickTargetDir()
  if (!targetDir) return
  let name = ''
  try {
    const res = await ElMessageBox.prompt(
      $t('@MINDMAP:输入文件名提示'),
      $t('@MINDMAP:新建思维导图'),
      {
        confirmButtonText: $t('@MINDMAP:新建'),
        cancelButtonText: $t('@MINDMAP:取消'),
        inputValue: d.title,
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
    await store.saveCurrent(draftToContent(d, name))
    mmKey.value++
    draft.value = null
    ElMessage.success($t('@MINDMAP:已新建导图'))
  } catch (e: any) {
    ElMessage.error(e?.message || $t('@MINDMAP:应用草稿失败'))
  }
}

// 生命周期
onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  // 点击任意位置（含左键点击分组头展开/折叠）都关掉右键菜单
  document.addEventListener('click', closeCtxMenu)
  await store.init()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  document.removeEventListener('click', closeCtxMenu)
  cancelAutosave()
  stopAiResize()
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
        <el-button size="small" @click="openDirPicker">
          <!-- folder-plus.svg（Tabler icons，MIT） -->
          <template #icon>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 19h-7a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v3.5" />
              <path d="M16 19h6" />
              <path d="M19 16v6" />
            </svg>
          </template>
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
          :disabled="store.dirs.length === 0"
          @click="handleNewFile()"
        >
          <!-- plus.svg（Tabler icons，MIT） -->
          <template #icon>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 5l0 14" />
              <path d="M5 12l14 0" />
            </svg>
          </template>
          {{ $t('@MINDMAP:新建') }}
        </el-button>
        <el-button
          size="small"
          :disabled="store.dirs.length === 0"
          @click="handleImportMarkdown()"
        >
          <!-- file-import.svg（Tabler icons，MIT） -->
          <template #icon>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
              <path d="M14 3v4a1 1 0 0 0 1 1h4" />
              <path d="M5 13v-8a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2h-5.5m-9.5-2h7m-3-3l3 3l-3 3" />
            </svg>
          </template>
          {{ $t('@MINDMAP:从MD导入') }}
        </el-button>
        <el-button
          size="small"
          :disabled="!store.current"
          @click="handleExportMarkdown"
        >
          <!-- file-pencil.svg（Tabler icons，MIT） -->
          <template #icon>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
              <path d="M14 3v4a1 1 0 0 0 1 1h4" />
              <path d="M17 21h-10a2 2 0 0 1-2-2v-14a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2" />
              <path d="M10 18l5-5a1.414 1.414 0 0 0-2-2l-5 5v2h2" />
            </svg>
          </template>
          {{ $t('@MINDMAP:复制MD') }}
        </el-button>
        <el-button
          size="small"
          class="mm-ai-btn"
          :class="{ 'is-on': showAi }"
          :title="showAi ? $t('@MINDMAP:关闭 g ai 对话') : $t('@MINDMAP:打开 g ai 对话')"
          @click="toggleAi"
        >
          <!-- message-chatbot.svg（Tabler icons，MIT）：与文件空间那颗开关同款图标 -->
          <template #icon>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
              <path d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-5l-5 3v-3h-2a3 3 0 0 1-3-3v-8a3 3 0 0 1 3-3h12" />
              <path d="M9.5 9h.01" />
              <path d="M14.5 9h.01" />
              <path d="M9.5 13a3.5 3.5 0 0 0 5 0" />
            </svg>
          </template>
          {{ $t('@MINDMAP:g ai 对话') }}
        </el-button>
        <el-button
          size="small"
          type="primary"
          :disabled="!store.current || !store.dirty"
          :loading="store.loading"
          @click="() => { cancelAutosave(); handleSave() }"
        >
          <!-- device-floppy.svg（Tabler icons，MIT）：保存 -->
          <template #icon>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
              <path d="M6 4h10l4 4v10a2 2 0 0 1-2 2h-12a2 2 0 0 1-2-2v-12a2 2 0 0 1 2-2" />
              <path d="M10 14a2 2 0 1 0 4 0a2 2 0 1 0-4 0" />
              <path d="M14 4l0 4l-6 0l0-4" />
            </svg>
          </template>
          {{ $t('@MINDMAP:保存') }}
        </el-button>
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
            :loading="store.refreshing"
            @click="store.refresh()"
            :disabled="store.dirs.length === 0"
          >
            <!-- refresh.svg（Tabler icons，MIT） -->
            <template #icon>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
                <path d="M20 11a8.1 8.1 0 0 0-15.5-2m-.5-4v4h4" />
                <path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />
              </svg>
            </template>
          </el-button>
        </div>

        <div class="mm-sidebar-list" v-loading="store.refreshing">
          <div v-if="store.error" class="mm-sidebar-error">{{ store.error }}</div>
          <EmptyState
            v-if="store.dirs.length === 0"
            class="mm-sidebar-empty"
            size="inline"
            :title="$t('@MINDMAP:请先添加目录')"
          />
          <template v-else>
            <div v-for="group in store.groups" :key="group.dir" class="mm-group">
              <div
                class="mm-group-header"
                :class="{ active: isActiveDir(group.dir) }"
                :title="group.dir"
                @click="toggleGroup(group.dir)"
                @contextmenu="openDirContextMenu($event, group.dir)"
              >
                <el-icon class="mm-group-caret" :class="{ collapsed: collapsedGroups[group.dir] }">
                  <!-- chevron-down.svg（Tabler icons，MIT）：收起态由 CSS 旋转 -90° -->
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
                    <path d="M6 9l6 6l6-6" />
                  </svg>
                </el-icon>
                <div class="mm-group-info">
                  <div class="mm-group-name">
                    <span class="mm-group-title">{{ baseName(group.dir) }}</span>
                    <span class="mm-group-count">{{ group.files.length }}</span>
                  </div>
                  <div class="mm-group-path">{{ group.dir }}</div>
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
                <EmptyState
                  v-else-if="group.files.length === 0"
                  class="mm-sidebar-empty"
                  size="inline"
                  :title="$t('@MINDMAP:该目录暂无思维导图')"
                />
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

      <!-- 右侧：画布 + g ai 面板（与文件空间同一套：分隔条贴在面板左边缘，向左拖变宽） -->
      <div class="mm-editor">
        <div class="mm-stage">
          <!-- AI 导图草稿条：模型在回答里给了 ```mindmap 大纲才有。
               平铺一条通栏，不用「圆角 + 单边框」的卡片 —— 它是画布上的一条横幅，不是浮块。 -->
          <div v-if="draft" class="mm-draft">
            <span class="mm-draft-tag">{{ $t('@MINDMAP:AI 导图草稿') }}</span>
            <span class="mm-draft-title" :title="draft.title">{{ draft.title }}</span>
            <span class="mm-draft-meta">{{ $t('@MINDMAP:个节点', { n: draft.nodes }) }}</span>
            <span class="mm-draft-spacer" />
            <button
              v-if="store.current"
              class="mm-draft-btn mm-draft-btn--primary"
              @click="applyDraftToCurrent"
            >{{ $t('@MINDMAP:应用到当前导图') }}</button>
            <button
              class="mm-draft-btn"
              :disabled="store.dirs.length === 0"
              @click="applyDraftAsNew"
            >{{ $t('@MINDMAP:另存为新导图') }}</button>
            <button
              class="mm-draft-close"
              :title="$t('@MINDMAP:关闭草稿')"
              :aria-label="$t('@MINDMAP:关闭草稿')"
              @click="dismissDraft"
            >
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          <div class="mm-canvas">
            <EmptyState
              v-if="!store.current"
              class="mm-editor-empty"
              :title="$t('@MINDMAP:思维导图编辑器')"
              :hint="store.dirs.length > 0 ? $t('@MINDMAP:从左侧选择或新建') : $t('@MINDMAP:先选择目录提示')"
            >
              <template #icon>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
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
              </template>
            </EmptyState>
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

        <!-- 分隔条：全屏时这一列整个让给面板 -->
        <div
          v-if="showAi && !aiFullscreen"
          class="mm-resizer"
          @mousedown="startAiResize"
        />

        <!-- g ai 对话：v-if 懒挂载 + v-show 保状态（切走再切回来，进行中的流还在） -->
        <EditorAgentPanel
          v-if="aiOpened"
          v-show="showAi"
          class="mm-ai-panel"
          :active="showAi"
          :active-file-path="store.current?.path || ''"
          :active-file-name="currentFileName"
          :context-note="aiContextNote"
          :fullscreen="aiFullscreen && showAi"
          :style="aiStyle"
          @close="closeAi"
          @toggle-fullscreen="aiFullscreen = !aiFullscreen"
          @assistant-done="onAssistantDone"
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

    <!-- 目录右键菜单：打开目录 / 在此新建 / 移除目录 -->
    <teleport to="body">
      <div
        v-if="ctxMenu"
        class="ctx-menu"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        @click.stop
      >
        <button class="ctx-menu-item" @click="ctxOpenDir">
          <!-- folder icon -->
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
            <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2"/>
          </svg>
          {{ $t('@MINDMAP:打开目录') }}
        </button>
        <button class="ctx-menu-item" @click="ctxNewFile">
          <!-- new-file icon -->
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="12" y1="13" x2="12" y2="19"/><line x1="9" y1="16" x2="15" y2="16"/>
          </svg>
          {{ $t('@MINDMAP:在此新建') }}
        </button>
        <div class="ctx-menu-sep" />
        <button class="ctx-menu-item ctx-menu-item--danger" @click="ctxRemoveDir">
          <!-- trash icon -->
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6"/><path d="M14 11v6"/>
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
          </svg>
          {{ $t('@MINDMAP:移除目录') }}
        </button>
      </div>
    </teleport>
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

/* 保存按钮不可用时仍是「主色淡底 + 白字」，看着像一颗能点的主按钮。
   置灰成和旁边 ghost 按钮同一档（中性底 + meta 字），禁用态才读得出"现在没得存"。 */
.mm-toolbar-right :deep(.el-button--primary.is-disabled) {
  background: var(--bg-hover);
  border-color: var(--border-color);
  color: var(--text-meta);
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
  font-size: var(--font-size-sm);
  color: var(--text-meta);
  font-style: italic;
}

.mm-status {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: 4px;
  font-size: var(--font-size-sm);
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
  color: var(--color-warning-dark);
  font-size: var(--font-size-base);
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
  font-size: var(--font-size-sm);
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

/* 空态排版交给 EmptyState（inline 档），这里只留"在侧栏里占多大地方" */
.mm-sidebar-empty {
  padding: 24px 12px;
}

.mm-sidebar-error {
  padding: 24px 12px;
  text-align: center;
  font-size: var(--font-size-sm);
  color: var(--color-danger-dark);
}

/* ── 目录分组 ─────────────────────────────────────────────────── */
.mm-group {
  margin-bottom: 2px;
}

.mm-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--transition-fast) ease;
}

.mm-group-header:hover {
  background: var(--bg-container-hover);
}

/* 当前「新建 / 导入」的目标目录：背景高亮（与文件条目的选中样式一致） */
.mm-group-header.active {
  background: color-mix(in srgb, var(--color-primary) 12%, var(--bg-container));
}

.mm-group-caret {
  font-size: var(--font-size-sm);
  color: var(--text-meta);
  flex-shrink: 0;
  transition: transform var(--transition-fast) ease;
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
  font-size: var(--font-size-mid);
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
  font-size: var(--font-size-xs);
  color: var(--text-meta);
  flex-shrink: 0;
}

/* 完整路径小字：同名目录也能分辨（hover 有 title 看全文） */
.mm-group-path {
  font-size: var(--font-size-xs);
  color: var(--text-meta);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
  font-size: var(--font-size-sm);
  color: var(--color-danger-dark);
}

/* ── 文件条目 ─────────────────────────────────────────────────── */
.mm-file-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--transition-fast) ease;
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
  font-size: var(--font-size-mid);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mm-file-meta {
  font-size: var(--font-size-xs);
  color: var(--text-meta);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 文件行的 hover 操作按钮：不占位，hover 时浮在行右端，用行底色遮住被盖住的文字 */
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
  transition: opacity var(--transition-fast) ease, background var(--transition-fast) ease;
}

.mm-file-item:hover .mm-file-actions {
  opacity: 1;
  pointer-events: auto;
}

/* 遮罩上的 danger 图标压深一档：Element 的 var(--color-danger) 在浅色遮罩上只有 ~2.5:1，
   小图标会看不清是"删除"；var(--git-status-locked) ≈ 4.2:1。深色主题下浅红反而更清楚，所以只改浅色主题。 */
html:not(.dark) .mm-file-actions :deep(.el-button--danger) {
  color: var(--git-status-locked);
}

/* ── 右侧编辑区 ───────────────────────────────────────────────── */
.mm-editor {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  position: relative;
  background: var(--bg-container);
}

/* 画布那一栏：上面是草稿条（有草稿时），下面铺满导图 */
.mm-stage {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.mm-canvas {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
}

.mm-canvas :deep(.zm-mindmap),
.mm-canvas > * {
  width: 100%;
  height: 100%;
}

.mm-editor-empty {
  position: absolute;
  inset: 0;
}

/* g ai 面板：默认与画布平分（组件自己的 flex-grow:1 / basis:0），拖过之后走内联像素宽 */
.mm-ai-panel {
  flex-shrink: 0;
}

/* 分隔条：贴在面板**左边缘**，向左拖 = 面板变宽。
   宽 7px 好点中，视觉上只有正中间 1px 那条线（与文件空间同一条）。 */
.mm-resizer {
  width: 7px;
  flex-shrink: 0;
  cursor: col-resize;
  position: relative;
  background: transparent;
  z-index: 2;

  &::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 1px;
    transform: translateX(-50%);
    background: var(--border-color);
    transition: background var(--transition-fast), width var(--transition-fast);
  }

  &:hover {
    background: var(--tint-primary-06);

    &::after {
      width: 2px;
      background: var(--color-primary);
    }
  }
}

/* ── AI 导图草稿条 ────────────────────────────────────────────── */
/* 通栏一条、不带圆角与外框：它压着画布上沿，是横幅不是浮卡（用户明确不要
   「圆角 + 单层 border」那种卡）。底色取 AI 语义色，和对话面板一眼同源。 */
.mm-draft {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  min-height: 34px;
  padding: 5px 8px 5px 12px;
  background: var(--role-ai-surface);
  border-bottom: 1px solid var(--role-ai-edge);
  font-size: var(--font-size-sm);
}

.mm-draft-tag {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  background: var(--role-ai-wash);
  color: var(--role-ai-ink);
  font-size: var(--font-size-xs);
  font-weight: 700;
  letter-spacing: 0.04em;
}

.mm-draft-title {
  min-width: 0;
  max-width: 40%;
  color: var(--text-primary);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mm-draft-meta {
  flex-shrink: 0;
  color: var(--text-meta);
  font-size: var(--font-size-xs);
}

.mm-draft-spacer {
  flex: 1;
  min-width: 8px;
}

.mm-draft-btn {
  flex-shrink: 0;
  padding: 3px 10px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  white-space: nowrap;
  transition: var(--transition-ui-fast);

  &:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  &:disabled {
    color: var(--text-meta);
    cursor: not-allowed;
    background: transparent;
  }
}

.mm-draft-btn--primary {
  color: var(--role-ai-ink);
  font-weight: 600;

  &:hover {
    background: var(--role-ai-wash);
    color: var(--role-ai-ink);
  }
}

.mm-draft-close {
  flex-shrink: 0;
  /* 24px：与 g ai 面板头部那排图标按钮同档（verify:ui-consistency 的尺寸棘轮
     就是盯"同屏又冒出一个新尺寸"，别为这一颗小叉单开一个 22px） */
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-meta);
  cursor: pointer;
  transition: var(--transition-ui-fast);

  &:hover {
    background: var(--bg-hover);
    color: var(--text-secondary);
  }
}

/* g ai 开关的按下态：语义色淡底（不用主色实心，免得和「保存」抢注意力） */
.mm-toolbar-right :deep(.mm-ai-btn.is-on) {
  background: var(--role-ai-surface);
  border-color: var(--role-ai-edge);
  color: var(--role-ai-ink);
}

/* ── 目录右键菜单 ─────────────────────────────────────────────── */
/* teleport 到 body：scoped 属性会跟着一起带过去，所以样式仍写在 <style scoped> 里。
   与 EditorView 的右键菜单保持同一套观感。 */
.ctx-menu {
  position: fixed;
  z-index: var(--z-menu-float);
  /* 使用容器背景而非面板背景:深色主题下 --bg-panel 是半透明 rgba,
     会导致右键菜单"通透",文字与底层内容重叠看不清。 */
  background: var(--bg-container);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  padding: 4px;
  min-width: 160px;
  user-select: none;
}

.ctx-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  background: none;
  border: none;
  border-radius: var(--radius-base);
  cursor: pointer;
  font-size: var(--font-size-mid);
  color: var(--text-primary);
  text-align: left;
  transition: background var(--transition-fast);
}

.ctx-menu-item:hover {
  background: var(--bg-hover);
}

.ctx-menu-item--danger {
  color: var(--color-danger-dark);
}

.ctx-menu-item--danger:hover {
  background: rgba(239, 68, 68, 0.1);
}

.ctx-menu-sep {
  height: 1px;
  background: var(--border-color);
  margin: 4px 2px;
}

/* ── 响应式 ───────────────────────────────────────────────────── */
@media (max-width: 900px) {
  .mm-sidebar {
    width: 180px;
  }
}
</style>
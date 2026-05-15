<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref, shallowRef, computed, nextTick, onMounted, onBeforeUnmount, watch } from 'vue'
import { ElMessage, ElTooltip } from 'element-plus'
import * as monaco from 'monaco-editor'
import { marked } from 'marked'
import { useConfigStore } from '@/stores/configStore'
import { getLanguageByExt } from '@/utils/editorLang'
import { getFileIconClass, getFolderIconClass } from '@/utils/fileIcon'

// ── 文件树 ─────────────────────────────────────────────
interface FsItem {
  name: string
  path: string
  type: 'file' | 'directory'
}

interface TreeNode extends FsItem {
  children?: TreeNode[]
  expanded?: boolean
  loading?: boolean
  depth: number
}

const configStore = useConfigStore()
const treeNodes = ref<TreeNode[]>([])
const treeLoading = ref(false)

async function loadDir(dirPath: string, depth = 0): Promise<TreeNode[]> {
  const resp = await fetch(`/api/browse_directory?path=${encodeURIComponent(dirPath)}`)
  const data = await resp.json()
  if (!data.success) return []
  return (data.items as FsItem[]).map(item => ({
    ...item,
    depth,
    expanded: false,
    loading: false,
    children: item.type === 'directory' ? undefined : undefined,
  }))
}

async function initTree() {
  const root = configStore.currentDirectory
  if (!root) return
  treeLoading.value = true
  try {
    treeNodes.value = await loadDir(root, 0)
  } finally {
    treeLoading.value = false
  }
}

async function toggleDir(node: TreeNode) {
  if (node.type !== 'directory') return
  if (!node.expanded) {
    if (!node.children) {
      node.loading = true
      try {
        node.children = await loadDir(node.path, node.depth + 1)
      } finally {
        node.loading = false
      }
    }
    node.expanded = true
  } else {
    node.expanded = false
  }
}

// 把树展开成平铺列表供 v-for 渲染
function flattenTree(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = []
  for (const n of nodes) {
    result.push(n)
    if (n.type === 'directory' && n.expanded && n.children) {
      result.push(...flattenTree(n.children))
    }
  }
  return result
}

// ── 已打开的标签页 ─────────────────────────────────────
interface Tab {
  path: string
  name: string
  content: string
  originalContent: string
  isDirty: boolean
  language: string
}

const tabs = ref<Tab[]>([])
const activeTabPath = ref<string | null>(null)

async function openFile(node: TreeNode) {
  if (node.type !== 'file') {
    toggleDir(node)
    return
  }
  // 已打开则激活
  const existing = tabs.value.find(t => t.path === node.path)
  if (existing) {
    activeTabPath.value = node.path
    return
  }
  try {
    const resp = await fetch(`/api/editor/file?path=${encodeURIComponent(node.path)}`)
    const data = await resp.json()
    if (!data.success) {
      ElMessage.error(`${$t('@EDITOR:打开文件失败: ')}${data.error}`)
      return
    }
    const ext = node.name.split('.').pop() || ''
    const lang = getLanguageByExt(ext)
    const tab: Tab = {
      path: node.path,
      name: node.name,
      content: data.content,
      originalContent: data.content,
      isDirty: false,
      language: lang,
    }
    tabs.value.push(tab)
    activeTabPath.value = node.path
  } catch (e: any) {
    ElMessage.error(`${$t('@EDITOR:打开文件失败: ')}${e.message}`)
  }
}

function closeTab(path: string, e: MouseEvent) {
  e.stopPropagation()
  const idx = tabs.value.findIndex(t => t.path === path)
  if (idx === -1) return
  const tab = tabs.value[idx]
  if (tab.isDirty) {
    if (!confirm($t('@EDITOR:文件未保存，确认关闭？'))) return
  }
  tabs.value.splice(idx, 1)
  if (activeTabPath.value === path) {
    activeTabPath.value = tabs.value[Math.min(idx, tabs.value.length - 1)]?.path ?? null
  }
}

const activeTab = () => tabs.value.find(t => t.path === activeTabPath.value) ?? null

// ── Monaco 编辑器 ───────────────────────────────────────
const editorContainerRef = ref<HTMLElement | null>(null)
const editorInstance = shallowRef<monaco.editor.IStandaloneCodeEditor | null>(null)
// model 缓存：文件路径 → ITextModel
const modelCache = new Map<string, monaco.editor.ITextModel>()

function getOrCreateModel(tab: Tab): monaco.editor.ITextModel {
  let model = modelCache.get(tab.path)
  if (!model || model.isDisposed()) {
    model = monaco.editor.createModel(tab.content, tab.language, monaco.Uri.file(tab.path))
    modelCache.set(tab.path, model)
  }
  return model
}

function mountEditor() {
  if (!editorContainerRef.value) return
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
  editorInstance.value = monaco.editor.create(editorContainerRef.value, {
    theme: isDark ? 'vs-dark' : 'vs',
    fontSize: 13,
    lineHeight: 20,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    automaticLayout: true,
    tabSize: 2,
    wordWrap: 'off',
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    padding: { top: 8, bottom: 8 },
  })

  // 监听内容变化，标记 dirty
  editorInstance.value.onDidChangeModelContent(() => {
    const tab = activeTab()
    if (!tab) return
    const newVal = editorInstance.value!.getValue()
    tab.content = newVal
    tab.isDirty = newVal !== tab.originalContent
  })

  // 失去焦点时，如果开启自动保存则保存
  editorInstance.value.onDidBlurEditorText(() => {
    if (configStore.editorAutoSave) {
      const tab = activeTab()
      if (tab?.isDirty) saveCurrentFile(false)
    }
  })
}

// 切换 tab 时换 model
watch(activeTabPath, (path) => {
  if (!editorInstance.value || !path) return
  const tab = tabs.value.find(t => t.path === path)
  if (!tab) return
  const model = getOrCreateModel(tab)
  editorInstance.value.setModel(model)
})

// 跟随系统主题
const themeObserver = new MutationObserver(() => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
  monaco.editor.setTheme(isDark ? 'vs-dark' : 'vs')
})

onMounted(async () => {
  mountEditor()
  await initTree()
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
})

onBeforeUnmount(() => {
  themeObserver.disconnect()
  editorInstance.value?.dispose()
  modelCache.forEach(m => m.dispose())
  modelCache.clear()
})

// ── 保存文件 ───────────────────────────────────────────
async function saveCurrentFile(silent = false) {
  const tab = activeTab()
  if (!tab) return
  try {
    const resp = await fetch('/api/editor/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: tab.path, content: tab.content }),
    })
    const data = await resp.json()
    if (!data.success) {
      ElMessage.error(`${$t('@EDITOR:保存失败: ')}${data.error}`)
      return
    }
    tab.originalContent = tab.content
    tab.isDirty = false
    if (!silent) ElMessage.success($t('@EDITOR:已保存'))
  } catch (e: any) {
    ElMessage.error(`${$t('@EDITOR:保存失败: ')}${e.message}`)
  }
}

// Ctrl+S 保存
function handleKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault()
    saveCurrentFile()
  }
}

onMounted(() => window.addEventListener('keydown', handleKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', handleKeydown))

// ── 拖拽调整左侧宽度 ────────────────────────────────────
const containerRef = ref<HTMLElement | null>(null)
const sidebarWidth = ref(220)
let isResizing = false
let resizeStartX = 0
let resizeStartW = 0

function startSidebarResize(e: MouseEvent) {
  isResizing = true
  resizeStartX = e.clientX
  resizeStartW = sidebarWidth.value
  document.addEventListener('mousemove', onSidebarResize)
  document.addEventListener('mouseup', stopSidebarResize)
  e.preventDefault()
}

function onSidebarResize(e: MouseEvent) {
  if (!isResizing) return
  const delta = e.clientX - resizeStartX
  sidebarWidth.value = Math.max(140, Math.min(400, resizeStartW + delta))
}

function stopSidebarResize() {
  isResizing = false
  document.removeEventListener('mousemove', onSidebarResize)
  document.removeEventListener('mouseup', stopSidebarResize)
}

// ── 文件图标（file-icons-js） ──────────────────────────
function getNodeIconClass(node: TreeNode): string {
  if (node.type === 'directory') return getFolderIconClass(node.name)
  return getFileIconClass(node.name)
}

// ── 新建 / 重命名 / 删除 ────────────────────────────────
// inline 输入状态
interface InlineInput {
  // 所在父目录路径（根目录时为 configStore.currentDirectory）
  parentPath: string
  // 在哪个 node 后面插入（用于定位渲染位置），null 表示插在最前
  afterNode: TreeNode | null
  // 'file' | 'directory'
  kind: 'file' | 'directory'
  // 输入框绑定值
  value: string
}

interface RenameInput {
  node: TreeNode
  value: string
}

const inlineInput = ref<InlineInput | null>(null)
const renameInput = ref<RenameInput | null>(null)
const inlineInputRef = ref<HTMLInputElement | null>(null)
const renameInputRef = ref<HTMLInputElement | null>(null)

// 获取当前「焦点目录」：若选中的节点是目录则用它，否则取其父目录（简化处理：取 parentPath）
function getTargetDir(kind: 'file' | 'directory'): { parentPath: string; afterNode: TreeNode | null } {
  const flat = flattenTree(treeNodes.value)
  const active = flat.find(n => n.path === activeTabPath.value)
  if (active) {
    if (active.type === 'directory') {
      return { parentPath: active.path, afterNode: active }
    }
    // 文件：取父目录
    const parent = active.path.includes('/') || active.path.includes('\\')
      ? active.path.replace(/[\\/][^\\/]+$/, '')
      : configStore.currentDirectory ?? ''
    const parentNode = flat.find(n => n.path === parent && n.type === 'directory')
    return { parentPath: parent, afterNode: parentNode ?? active }
  }
  return { parentPath: configStore.currentDirectory ?? '', afterNode: null }
}

async function startNewFile() {
  inlineInput.value = { ...getTargetDir('file'), kind: 'file', value: '' }
  await nextTick()
  inlineInputRef.value?.focus()
}

async function startNewFolder() {
  inlineInput.value = { ...getTargetDir('directory'), kind: 'directory', value: '' }
  await nextTick()
  inlineInputRef.value?.focus()
}

function cancelInlineInput() {
  inlineInput.value = null
}

async function confirmInlineInput() {
  const inp = inlineInput.value
  if (!inp || !inp.value.trim()) {
    inlineInput.value = null
    return
  }
  const name = inp.value.trim()
  const newPath = inp.parentPath.replace(/[/\\]$/, '') + '/' + name
  if (inp.kind === 'file') {
    const resp = await fetch('/api/editor/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: newPath }),
    })
    const data = await resp.json()
    if (!data.success) { ElMessage.error(data.error); return }
    ElMessage.success($t('@EDITOR:创建成功'))
  } else {
    const resp = await fetch('/api/editor/directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: newPath }),
    })
    const data = await resp.json()
    if (!data.success) { ElMessage.error(data.error); return }
    ElMessage.success($t('@EDITOR:创建成功'))
  }
  inlineInput.value = null
  await initTree()
}

function handleInlineKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') { e.preventDefault(); confirmInlineInput() }
  if (e.key === 'Escape') { e.preventDefault(); cancelInlineInput() }
}

// 右键菜单
interface CtxMenu { x: number; y: number; node: TreeNode }
const ctxMenu = ref<CtxMenu | null>(null)
const ctxMenuRef = ref<HTMLElement | null>(null)

function openContextMenu(e: MouseEvent, node: TreeNode) {
  e.preventDefault()
  ctxMenu.value = { x: e.clientX, y: e.clientY, node }
}

function closeContextMenu() {
  ctxMenu.value = null
}

async function ctxNewFile() {
  const node = ctxMenu.value?.node
  closeContextMenu()
  const parentPath = node
    ? (node.type === 'directory' ? node.path : node.path.replace(/[\\/][^\\/]+$/, ''))
    : (configStore.currentDirectory ?? '')
  inlineInput.value = { parentPath, afterNode: node ?? null, kind: 'file', value: '' }
  await nextTick()
  inlineInputRef.value?.focus()
}

async function ctxNewFolder() {
  const node = ctxMenu.value?.node
  closeContextMenu()
  const parentPath = node
    ? (node.type === 'directory' ? node.path : node.path.replace(/[\\/][^\\/]+$/, ''))
    : (configStore.currentDirectory ?? '')
  inlineInput.value = { parentPath, afterNode: node ?? null, kind: 'directory', value: '' }
  await nextTick()
  inlineInputRef.value?.focus()
}

async function ctxRename() {
  const node = ctxMenu.value?.node
  closeContextMenu()
  if (!node) return
  renameInput.value = { node, value: node.name }
  await nextTick()
  renameInputRef.value?.focus()
  renameInputRef.value?.select()
}

async function confirmRename() {
  const r = renameInput.value
  if (!r || !r.value.trim() || r.value.trim() === r.node.name) {
    renameInput.value = null
    return
  }
  const newName = r.value.trim()
  const dir = r.node.path.replace(/[\\/][^\\/]+$/, '')
  const newPath = dir.replace(/[/\\]$/, '') + '/' + newName
  const resp = await fetch('/api/editor/rename', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPath: r.node.path, newPath }),
  })
  const data = await resp.json()
  if (!data.success) { ElMessage.error(data.error); return }
  // 如果重命名的是当前打开的 tab，更新 tab 信息
  const tab = tabs.value.find(t => t.path === r.node.path)
  if (tab) {
    tab.path = newPath
    tab.name = newName
    if (activeTabPath.value === r.node.path) activeTabPath.value = newPath
  }
  renameInput.value = null
  await initTree()
}

function handleRenameKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') { e.preventDefault(); confirmRename() }
  if (e.key === 'Escape') { e.preventDefault(); renameInput.value = null }
}

async function ctxDelete() {
  const node = ctxMenu.value?.node
  closeContextMenu()
  if (!node) return
  const label = node.type === 'directory' ? $t('@EDITOR:文件夹') : $t('@EDITOR:文件')
  if (!confirm(`${$t('@EDITOR:确认删除')} ${label} "${node.name}"？`)) return
  const resp = await fetch(`/api/editor/entry?path=${encodeURIComponent(node.path)}`, { method: 'DELETE' })
  const data = await resp.json()
  if (!data.success) { ElMessage.error(data.error); return }
  // 关掉已打开的 tab
  const idx = tabs.value.findIndex(t => t.path === node.path)
  if (idx !== -1) {
    tabs.value.splice(idx, 1)
    if (activeTabPath.value === node.path) {
      activeTabPath.value = tabs.value[Math.max(0, idx - 1)]?.path ?? null
    }
  }
  ElMessage.success($t('@EDITOR:已删除'))
  await initTree()
}

// 点击全局关闭右键菜单
onMounted(() => document.addEventListener('click', closeContextMenu))
onBeforeUnmount(() => document.removeEventListener('click', closeContextMenu))

// ── 预览面板 ────────────────────────────────────────────
const PREVIEW_TEXT_EXTS = new Set(['md', 'html', 'htm', 'svg'])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp'])

const showPreview = ref(false)
const previewWidth = ref(400)

const activeTabRef = computed(() => tabs.value.find(t => t.path === activeTabPath.value) ?? null)

const activeExt = computed(() => {
  const name = activeTabRef.value?.name ?? ''
  return name.split('.').pop()?.toLowerCase() ?? ''
})

const isPreviewable = computed(() =>
  PREVIEW_TEXT_EXTS.has(activeExt.value) || IMAGE_EXTS.has(activeExt.value)
)

// 切换文件时，若当前文件不可预览则自动关闭预览
watch(activeTabPath, () => {
  if (showPreview.value && !isPreviewable.value) showPreview.value = false
})

function togglePreview() {
  if (!isPreviewable.value) return
  showPreview.value = !showPreview.value
}

// 生成 iframe srcdoc（md / html / htm / svg）
const previewSrcdoc = computed(() => {
  const tab = activeTabRef.value
  if (!tab) return ''
  const ext = activeExt.value

  const isDark = document.documentElement.getAttribute('data-theme') !== 'light'
  const bg = isDark ? '#0d1117' : '#ffffff'
  const fg = isDark ? '#c9d1d9' : '#1f2328'
  const border = isDark ? '#30363d' : '#d0d7de'
  const codeBg = isDark ? '#161b22' : '#f6f8fa'
  const blockquoteFg = isDark ? '#8b949e' : '#656d76'
  const linkColor = isDark ? '#58a6ff' : '#0969da'

  const baseStyle = `
    html, body { margin: 0; padding: 0; background: ${bg}; color: ${fg}; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.6; padding: 20px 24px; }
    * { box-sizing: border-box; }
    h1, h2, h3, h4, h5, h6 { border-bottom: 1px solid ${border}; padding-bottom: .3em; margin-top: 24px; margin-bottom: 16px; }
    h1 { font-size: 2em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; }
    p { margin: 0 0 16px; }
    code { background: ${codeBg}; padding: 2px 5px; border-radius: 4px; font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace; font-size: 87%; }
    pre { background: ${codeBg}; padding: 14px 16px; border-radius: 6px; overflow: auto; margin: 0 0 16px; }
    pre code { background: none; padding: 0; font-size: 100%; }
    a { color: ${linkColor}; }
    blockquote { border-left: 3px solid ${border}; margin: 0 0 16px; padding: 0 16px; color: ${blockquoteFg}; }
    img { max-width: 100%; border-radius: 4px; }
    hr { border: none; border-top: 1px solid ${border}; margin: 24px 0; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
    th, td { border: 1px solid ${border}; padding: 6px 13px; }
    thead tr { background: ${codeBg}; }
    tbody tr:nth-child(even) { background: ${codeBg}; }
    ul, ol { padding-left: 2em; margin-bottom: 16px; }
    li { margin: 4px 0; }
  `

  if (ext === 'md') {
    const html = marked.parse(tab.content) as string
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${baseStyle}</style></head><body>${html}</body></html>`
  }
  if (ext === 'html' || ext === 'htm') {
    // 直接将用户 HTML 作为 srcdoc，沙箱内运行（无 JS）
    return tab.content
  }
  if (ext === 'svg') {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:${bg};display:flex;align-items:center;justify-content:center;min-height:100vh;}svg{max-width:100%;max-height:90vh;}</style></head><body>${tab.content}</body></html>`
  }
  return ''
})

// 预览面板拖拽调整宽度
let isPreviewResizing = false
let previewResizeStartX = 0
let previewResizeStartW = 0

function startPreviewResize(e: MouseEvent) {
  isPreviewResizing = true
  previewResizeStartX = e.clientX
  previewResizeStartW = previewWidth.value
  document.addEventListener('mousemove', onPreviewResize)
  document.addEventListener('mouseup', stopPreviewResize)
  e.preventDefault()
}

function onPreviewResize(e: MouseEvent) {
  if (!isPreviewResizing) return
  const delta = previewResizeStartX - e.clientX
  previewWidth.value = Math.max(200, Math.min(900, previewResizeStartW + delta))
}

function stopPreviewResize() {
  isPreviewResizing = false
  document.removeEventListener('mousemove', onPreviewResize)
  document.removeEventListener('mouseup', stopPreviewResize)
}
</script>

<template>
  <div class="editor-view" ref="containerRef">
    <!-- 左侧文件树 -->
    <div class="editor-sidebar" :style="{ width: sidebarWidth + 'px' }">
      <div class="sidebar-header">
        <span class="sidebar-title">{{ $t('@EDITOR:资源管理器') }}</span>
        <div class="sidebar-actions">
          <el-tooltip :content="$t('@EDITOR:新建文件')" placement="bottom" :show-after="300">
            <button class="sidebar-action-btn" @click="startNewFile">
              <!-- new-file icon -->
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="12" y1="13" x2="12" y2="19"/><line x1="9" y1="16" x2="15" y2="16"/>
              </svg>
            </button>
          </el-tooltip>
          <el-tooltip :content="$t('@EDITOR:新建文件夹')" placement="bottom" :show-after="300">
            <button class="sidebar-action-btn" @click="startNewFolder">
              <!-- new-folder icon -->
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                <line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
              </svg>
            </button>
          </el-tooltip>
          <el-tooltip :content="$t('@EDITOR:刷新')" placement="bottom" :show-after="300">
            <button class="sidebar-action-btn" @click="initTree">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="1 4 1 10 7 10"/><polyline points="23 20 23 14 17 14"/>
                <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
              </svg>
            </button>
          </el-tooltip>
        </div>
      </div>

      <div class="sidebar-tree" v-if="!treeLoading">
        <template v-for="node in flattenTree(treeNodes)" :key="node.path">
          <!-- 重命名时用输入框替换节点 -->
          <div
            v-if="renameInput && renameInput.node.path === node.path"
            class="tree-node tree-inline-input-row"
            :style="{ paddingLeft: (12 + node.depth * 14) + 'px' }"
          >
            <span v-if="node.type === 'directory'" class="tree-arrow" :class="{ expanded: node.expanded }">
              <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </span>
            <span v-else class="tree-arrow-spacer" />
            <span class="tree-icon" :class="['icon', getNodeIconClass(node)]" />
            <input
              ref="renameInputRef"
              class="tree-inline-input"
              v-model="renameInput.value"
              @keydown="handleRenameKeydown"
              @blur="confirmRename"
              @click.stop
            />
          </div>
          <!-- 普通节点 -->
          <div
            v-else
            class="tree-node"
            :class="{
              'tree-node--dir': node.type === 'directory',
              'tree-node--file': node.type === 'file',
              'tree-node--active': activeTabPath === node.path,
            }"
            :style="{ paddingLeft: (12 + node.depth * 14) + 'px' }"
            @click="openFile(node)"
            @contextmenu="openContextMenu($event, node)"
          >
            <!-- 展开箭头 -->
            <span v-if="node.type === 'directory'" class="tree-arrow" :class="{ expanded: node.expanded }">
              <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </span>
            <span v-else class="tree-arrow-spacer" />
            <!-- 图标 -->
            <span
              v-if="node.type === 'directory'"
              class="tree-icon"
              :class="['icon', getNodeIconClass(node)]"
            />
            <span v-else class="tree-icon" :class="['icon', getNodeIconClass(node)]" />
            <!-- 名称 -->
            <span class="tree-name" :title="node.path">{{ node.name }}</span>
            <span v-if="node.loading" class="tree-loading" />
          </div>
        </template>

        <!-- 内联新建输入框（插在列表末尾，简化实现） -->
        <div
          v-if="inlineInput"
          class="tree-node tree-inline-input-row"
          :style="{ paddingLeft: (12) + 'px' }"
        >
          <span class="tree-arrow-spacer" />
          <svg v-if="inlineInput.kind === 'directory'" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;color:var(--color-warning)">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          <svg v-else viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;color:var(--text-tertiary)">
            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/>
          </svg>
          <input
            ref="inlineInputRef"
            class="tree-inline-input"
            v-model="inlineInput.value"
            :placeholder="inlineInput.kind === 'file' ? $t('@EDITOR:输入文件名') : $t('@EDITOR:输入文件夹名')"
            @keydown="handleInlineKeydown"
            @blur="cancelInlineInput"
            @click.stop
          />
        </div>

        <div v-if="treeNodes.length === 0 && !inlineInput" class="tree-empty">
          {{ $t('@EDITOR:暂无文件') }}
        </div>
      </div>
      <div v-else class="sidebar-loading">
        <span class="spin-icon" />
      </div>
    </div>

    <!-- 拖拽分隔条 -->
    <div class="editor-resizer" @mousedown="startSidebarResize" />

    <!-- 右侧编辑区 -->
    <div class="editor-main">
      <!-- 标签栏 -->
      <div class="editor-tabs" v-if="tabs.length > 0">
        <div
          v-for="tab in tabs"
          :key="tab.path"
          class="editor-tab"
          :class="{ active: activeTabPath === tab.path, dirty: tab.isDirty }"
          @click="activeTabPath = tab.path"
          :title="tab.path"
        >
          <span class="tab-name">{{ tab.name }}</span>
          <span v-if="tab.isDirty" class="tab-dirty-dot" />
          <button class="tab-close" @click="closeTab(tab.path, $event)">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="editor-tabs-spacer" />
        <!-- 预览切换按钮 -->
        <button
          v-if="isPreviewable"
          class="preview-toggle-btn"
          :class="{ active: showPreview }"
          :title="showPreview ? $t('@EDITOR:关闭预览') : $t('@EDITOR:打开预览')"
          @click="togglePreview"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
          <span>{{ $t('@EDITOR:预览') }}</span>
        </button>
      </div>

      <!-- 无文件打开时的提示 -->
      <div v-if="tabs.length === 0" class="editor-empty">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" style="opacity:.3">
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <p>{{ $t('@EDITOR:从左侧选择文件打开') }}</p>
        <p class="editor-empty-hint">{{ $t('@EDITOR:Ctrl+S 保存') }}</p>
      </div>

      <!-- Monaco 容器（始终挂载，tab 为空时隐藏） -->
      <div class="editor-body">
        <div
          class="monaco-container"
          :class="{ hidden: tabs.length === 0 }"
          ref="editorContainerRef"
        />
        <!-- 预览分隔条 -->
        <div
          v-if="showPreview && tabs.length > 0"
          class="preview-resizer"
          @mousedown="startPreviewResize"
        />
        <!-- 预览面板 -->
        <div
          v-if="showPreview && tabs.length > 0"
          class="preview-panel"
          :style="{ width: previewWidth + 'px' }"
        >
          <div class="preview-header">
            <span class="preview-title">{{ $t('@EDITOR:预览') }}</span>
            <span class="preview-ext-badge">{{ activeExt.toUpperCase() }}</span>
            <div class="preview-header-spacer" />
            <button class="preview-close-btn" :title="$t('@EDITOR:关闭预览')" @click="showPreview = false">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <div class="preview-body">
            <!-- Markdown / HTML / SVG → sandboxed iframe -->
            <iframe
              v-if="['md', 'html', 'htm', 'svg'].includes(activeExt)"
              class="preview-iframe"
              sandbox="allow-same-origin"
              :srcdoc="previewSrcdoc"
            />
            <!-- 图片预览 -->
            <div v-else-if="IMAGE_EXTS.has(activeExt)" class="preview-image-wrap">
              <img
                :src="`/api/editor/raw?path=${encodeURIComponent(activeTabRef?.path ?? '')}`"
                :alt="activeTabRef?.name"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 右键菜单 -->
  <teleport to="body">
    <div
      v-if="ctxMenu"
      ref="ctxMenuRef"
      class="ctx-menu"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      @click.stop
    >
      <button class="ctx-menu-item" @click="ctxNewFile">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="12" y1="13" x2="12" y2="19"/><line x1="9" y1="16" x2="15" y2="16"/>
        </svg>
        {{ $t('@EDITOR:新建文件') }}
      </button>
      <button class="ctx-menu-item" @click="ctxNewFolder">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          <line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
        </svg>
        {{ $t('@EDITOR:新建文件夹') }}
      </button>
      <div class="ctx-menu-sep" />
      <button class="ctx-menu-item" @click="ctxRename">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
        {{ $t('@EDITOR:重命名') }}
      </button>
      <button class="ctx-menu-item ctx-menu-item--danger" @click="ctxDelete">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
          <path d="M10 11v6"/><path d="M14 11v6"/>
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
        </svg>
        {{ $t('@EDITOR:删除') }}
      </button>
    </div>
  </teleport>
</template>

<style scoped>
.editor-view {
  display: flex;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--bg-container);
  border-radius: 0;
  border: 1px solid var(--border-color);
  box-shadow: var(--shadow-sm);
}

/* ── 侧边文件树 ─────────────────────────────── */
.editor-sidebar {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  overflow: hidden;
  border-right: 1px solid var(--border-color);
  background: var(--bg-panel);
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px 6px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.sidebar-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-secondary);
  user-select: none;
}

.sidebar-action-btn {
  background: none;
  border: none;
  padding: 3px;
  cursor: pointer;
  color: var(--text-tertiary);
  border-radius: var(--radius-base);
  display: flex;
  align-items: center;
}

.sidebar-action-btn:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.sidebar-tree {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px 0;
}

.tree-node {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  cursor: pointer;
  border-radius: 4px;
  padding-right: 8px;
  user-select: none;
  color: var(--text-primary);
  font-size: 13px;
  transition: background 0.1s;
  white-space: nowrap;
  overflow: hidden;
}

.tree-node:hover {
  background: var(--bg-hover);
}

.tree-node--active {
  background: rgba(59, 130, 246, 0.12);
  color: var(--color-primary);
}

.tree-arrow {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  color: var(--text-tertiary);
  transition: transform 0.15s;
  width: 12px;
}

.tree-arrow.expanded {
  transform: rotate(90deg);
}

.tree-arrow-spacer {
  width: 12px;
  flex-shrink: 0;
}

.tree-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  font-size: 14px;
  line-height: 1;
}

.tree-icon--dir {
  color: #e8b84b;
}

.tree-name {
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
  font-size: 13px;
}

.tree-loading {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--color-primary);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}

.tree-empty {
  font-size: 12px;
  color: var(--text-tertiary);
  text-align: center;
  padding: 24px 12px;
}

.sidebar-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
}

.spin-icon {
  display: inline-block;
  width: 20px;
  height: 20px;
  border: 2px solid var(--color-primary);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── 拖拽分隔条 ─────────────────────────────── */
.editor-resizer {
  width: 6px;
  flex-shrink: 0;
  cursor: col-resize;
  position: relative;
  background: transparent;
  transition: background 0.15s;
  z-index: 2;
}

.editor-resizer::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 2px;
  height: 32px;
  background: var(--color-gray-300);
  border-radius: 2px;
  transition: background 0.15s, height 0.15s;
}

.editor-resizer:hover {
  background: rgba(59, 130, 246, 0.06);
}

.editor-resizer:hover::after {
  background: var(--color-primary);
  height: 48px;
  box-shadow: 0 0 8px rgba(59, 130, 246, 0.4);
}

/* ── 编辑区 ─────────────────────────────────── */
.editor-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.editor-tabs {
  display: flex;
  overflow-x: auto;
  overflow-y: hidden;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-panel);
  scrollbar-width: none;
}

.editor-tabs::-webkit-scrollbar {
  display: none;
}

.editor-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  height: 34px;
  border-right: 1px solid var(--border-color);
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text-secondary);
  flex-shrink: 0;
  transition: background 0.1s, color 0.1s;
  max-width: 200px;
  min-width: 80px;
  user-select: none;
}

.editor-tab:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.editor-tab.active {
  background: var(--bg-container);
  color: var(--text-primary);
  border-bottom: 2px solid var(--color-primary);
}

.tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.tab-dirty-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-warning);
  flex-shrink: 0;
}

.tab-close {
  background: none;
  border: none;
  padding: 2px;
  cursor: pointer;
  color: var(--text-tertiary);
  border-radius: 3px;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.1s, background 0.1s;
}

.editor-tab:hover .tab-close,
.editor-tab.active .tab-close {
  opacity: 1;
}

.tab-close:hover {
  background: var(--bg-hover);
  color: var(--color-danger);
}

.editor-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-tertiary);
  font-size: 13px;
  user-select: none;
}

.editor-empty p {
  margin: 0;
}

.editor-empty-hint {
  font-size: 11px;
  opacity: 0.6;
}

.monaco-container {
  flex: 1;
  overflow: hidden;
  min-width: 0;
}

.monaco-container.hidden {
  display: none;
}

/* ── 预览面板 ──────────────────────────────── */
.editor-body {
  flex: 1;
  display: flex;
  overflow: hidden;
  min-height: 0;
}

.preview-resizer {
  width: 6px;
  flex-shrink: 0;
  cursor: col-resize;
  position: relative;
  background: transparent;
  transition: background 0.15s;
  z-index: 2;
}

.preview-resizer::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 2px;
  height: 32px;
  background: var(--color-gray-300);
  border-radius: 2px;
  transition: background 0.15s, height 0.15s;
}

.preview-resizer:hover {
  background: rgba(59, 130, 246, 0.06);
}

.preview-resizer:hover::after {
  background: var(--color-primary);
  height: 48px;
  box-shadow: 0 0 8px rgba(59, 130, 246, 0.4);
}

.preview-panel {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  border-left: 1px solid var(--border-color);
  background: var(--bg-panel);
  overflow: hidden;
  min-width: 200px;
}

.preview-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  height: 34px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  background: var(--bg-panel);
}

.preview-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-secondary);
  user-select: none;
}

.preview-ext-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(59, 130, 246, 0.15);
  color: var(--color-primary);
  letter-spacing: 0.04em;
}

.preview-header-spacer {
  flex: 1;
}

.preview-close-btn {
  background: none;
  border: none;
  padding: 3px;
  cursor: pointer;
  color: var(--text-tertiary);
  border-radius: var(--radius-base);
  display: flex;
  align-items: center;
  transition: color 0.1s, background 0.1s;
}

.preview-close-btn:hover {
  color: var(--color-danger);
  background: var(--bg-hover);
}

.preview-body {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.preview-iframe {
  flex: 1;
  width: 100%;
  height: 100%;
  border: none;
  background: transparent;
}

.preview-image-wrap {
  flex: 1;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: var(--bg-container);
}

.preview-image-wrap img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 4px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.2);
}

/* ── tabs 右侧预览按钮 ─────────────────────── */
.editor-tabs-spacer {
  flex: 1;
}

.preview-toggle-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 34px;
  padding: 0 10px;
  border: none;
  background: none;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
  border-left: 1px solid var(--border-color);
  transition: background 0.1s, color 0.1s;
  flex-shrink: 0;
}

.preview-toggle-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.preview-toggle-btn.active {
  color: var(--color-primary);
  background: rgba(59, 130, 246, 0.08);
}

/* ── sidebar header actions ─────────────────── */
.sidebar-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

/* ── 内联输入框 ─────────────────────────────── */
.tree-inline-input-row {
  cursor: default;
  background: var(--bg-hover);
}

.tree-inline-input {
  flex: 1;
  min-width: 0;
  height: 20px;
  font-size: 12.5px;
  background: var(--bg-container);
  border: 1px solid var(--color-primary);
  border-radius: 3px;
  color: var(--text-primary);
  padding: 0 5px;
  outline: none;
  font-family: inherit;
}

/* ── 右键菜单 ────────────────────────────────── */
.ctx-menu {
  position: fixed;
  z-index: 9999;
  background: var(--bg-panel);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
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
  border-radius: 4px;
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text-primary);
  text-align: left;
  transition: background 0.1s;
}

.ctx-menu-item:hover {
  background: var(--bg-hover);
}

.ctx-menu-item--danger {
  color: var(--color-danger);
}

.ctx-menu-item--danger:hover {
  background: rgba(239, 68, 68, 0.1);
}

.ctx-menu-sep {
  height: 1px;
  background: var(--border-color);
  margin: 4px 2px;
}
</style>

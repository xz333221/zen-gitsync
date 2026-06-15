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
import { $t } from '@/lang/static'
import { ref, shallowRef, computed, nextTick, onMounted, onBeforeUnmount, watch } from 'vue'
import { ElMessage, ElTooltip } from 'element-plus'
import * as monaco from 'monaco-editor'
import { useConfigStore } from '@/stores/configStore'
import { useEditorTabsStore } from '@/stores/editorTabs'
import { getLanguageByExt } from '@/utils/editorLang'
import { getFileIconClass, getFolderIconClass } from '@/utils/fileIcon'
import ImagePreview from '@/components/ImagePreview.vue'
import MarkdownPreview from '@/components/MarkdownPreview.vue'
import MindmapPreview from '@/components/MindmapPreview.vue'

// 配置 Monaco web worker(避免回退到主线程导致 UI 卡顿)
// 使用 Vite 的 ?worker 语法为 Monaco 创建 web worker
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

;(self as any).MonacoEnvironment = {
  getWorker(_: any, label: string) {
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    return new EditorWorker()
  }
}

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
const editorTabsStore = useEditorTabsStore()
const treeNodes = ref<TreeNode[]>([])
const treeLoading = ref(false)
const searchQuery = ref('')
// 实际参与过滤的关键词(防抖后)—— 避免大文件树下逐键重算 visibleTree 导致卡顿
const debouncedSearchQuery = ref('')
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null

function clearSearch() {
  searchQuery.value = ''
  // 立即同步防抖值,避免清空后还要等一帧才恢复原树
  debouncedSearchQuery.value = ''
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = null
  }
}

watch(searchQuery, (val) => {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
  searchDebounceTimer = setTimeout(() => {
    debouncedSearchQuery.value = val
    searchDebounceTimer = null
  }, 180)
})

onBeforeUnmount(() => {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
})

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

// 刷新树时保留已展开的目录
function collectExpandedPaths(nodes: TreeNode[], result = new Set<string>()): Set<string> {
  for (const n of nodes) {
    if (n.type === 'directory' && n.expanded) {
      result.add(n.path)
      if (n.children) collectExpandedPaths(n.children, result)
    }
  }
  return result
}

async function restoreExpanded(nodes: TreeNode[], expandedPaths: Set<string>): Promise<void> {
  for (const n of nodes) {
    if (n.type === 'directory' && expandedPaths.has(n.path)) {
      if (!n.children) {
        n.children = await loadDir(n.path, n.depth + 1)
      }
      n.expanded = true
      await restoreExpanded(n.children!, expandedPaths)
    }
  }
}

async function refreshTree() {
  const root = configStore.currentDirectory
  if (!root) return
  const expandedPaths = collectExpandedPaths(treeNodes.value)
  treeLoading.value = true
  try {
    treeNodes.value = await loadDir(root, 0)
    if (expandedPaths.size > 0) {
      await restoreExpanded(treeNodes.value, expandedPaths)
    }
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

// 搜索关键词(小写),用于过滤树
const searchQueryLower = computed(() => debouncedSearchQuery.value.trim().toLowerCase())

// 递归过滤:不区分大小写匹配 name,命中节点保留所有祖先目录并强制 expanded=true。
// 输入为空 → 返回原树(保持用户已展开/折叠状态)。
// 直接修改原始 reactive 节点的属性,以保留 Vue 响应式链路(toggleDir / openFile 才能触发 UI 更新)。
// 仅在节点本身边界才覆盖 children:未加载的目录(原 children 为 undefined)保持 undefined,
// 这样 toggleDir 仍能通过 `!node.children` 判断触发懒加载。
function filterTree(nodes: TreeNode[], keyword: string): TreeNode[] {
  if (!keyword) return nodes
  const result: TreeNode[] = []
  for (const n of nodes) {
    const children = n.children ? filterTree(n.children, keyword) : []
    const nameMatch = n.name.toLowerCase().includes(keyword)
    if (n.type === 'directory') {
      // 目录:自己命中 或 子树有命中 → 保留并强制展开
      if (nameMatch || children.length > 0) {
        n.expanded = true
        // 已加载的目录才覆盖 children;未加载时保留 undefined,以便后续 toggleDir 懒加载
        if (n.children !== undefined) {
          n.children = children
        }
        result.push(n)
      }
    } else {
      // 文件:仅自身命中
      if (nameMatch) result.push(n)
    }
  }
  return result
}

// 当前用于渲染的树(搜索时为过滤后,否则为原树)
const visibleTree = computed(() => filterTree(treeNodes.value, searchQueryLower.value))

// 是否处于无匹配状态(搜索框非空且过滤结果为空)
const noSearchResults = computed(() =>
  searchQueryLower.value.length > 0 && visibleTree.value.length === 0
)

// 将节点名按当前防抖关键词拆成段,用于在渲染时高亮命中部分。
// 空关键词 → 单段无高亮;大小写不敏感匹配。
function highlightName(name: string): Array<{ text: string; hit: boolean }> {
  const kw = debouncedSearchQuery.value.trim()
  if (!kw) return [{ text: name, hit: false }]
  const lowerName = name.toLowerCase()
  const lowerKw = kw.toLowerCase()
  const parts: Array<{ text: string; hit: boolean }> = []
  let cursor = 0
  let idx = lowerName.indexOf(lowerKw, cursor)
  while (idx !== -1) {
    if (idx > cursor) parts.push({ text: name.slice(cursor, idx), hit: false })
    parts.push({ text: name.slice(idx, idx + lowerKw.length), hit: true })
    cursor = idx + lowerKw.length
    idx = lowerName.indexOf(lowerKw, cursor)
  }
  if (cursor < name.length) parts.push({ text: name.slice(cursor), hit: false })
  return parts
}

// 搜索输入框 ref + 快捷键聚焦 / Esc 清空
const searchInputRef = ref<HTMLInputElement | null>(null)
function focusSearchInput() {
  const el = searchInputRef.value
  if (!el) return
  el.focus()
  el.select()
}
function onSearchEscape() {
  if (searchQuery.value) {
    // 有内容:清空并保留焦点
    clearSearch()
    searchInputRef.value?.focus()
  } else {
    // 已经是空:失焦并把键盘焦点交还给 Monaco 编辑器,
    // 避免用户 Esc 后继续打字却输入到 body(导致空格等键“看似失效”)
    searchInputRef.value?.blur()
    editorInstance.value?.focus()
  }
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

const selectedNode = ref<TreeNode | null>(null)

async function openFile(node: TreeNode) {
  selectedNode.value = node
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
  // 图片：跳过 Monaco，直接建一个只读 tab，content 留空字符串（不渲染 Monaco）
  // 由 preview 自动打开，ImagePreview 通过 /api/editor/raw 读取二进制
  const ext = node.name.split('.').pop() || ''
  if (IMAGE_EXTS.has(ext.toLowerCase())) {
    const tab: Tab = {
      path: node.path,
      name: node.name,
      content: '',
      originalContent: '',
      isDirty: false,
      language: 'plaintext',
    }
    tabs.value.push(tab)
    activeTabPath.value = node.path
    // 图片自动打开预览
    showPreview.value = true
    return
  }
  try {
    const resp = await fetch(`/api/editor/file?path=${encodeURIComponent(node.path)}`)
    const data = await resp.json()
    if (!data.success) {
      ElMessage.error(`${$t('@EDITOR:打开文件失败: ')}${data.error}`)
      return
    }
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
    if (configStore.ui.editorAutoSave) {
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
  // 切换 tab 后把键盘焦点交给 Monaco。
  // 否则焦点会停留在被点击的 tab 按钮或文件树节点上：
  //   - 焦点在 button 上时，空格键会被浏览器当作按钮点击（无法输入）；
  //   - 焦点在 body 上时，空格键会触发页面滚动（无法输入）。
  // 这是用户反馈"编辑器不能输入空格"的根因。
  nextTick(() => focusEditor())
})

// 把键盘焦点交还给 Monaco。
// 同时处理两种渲染模式：
//   1. 经典 textarea 模式（.monaco-editor textarea.inputarea）
//   2. EditContext API 模式（Chrome 121+/Edge，焦点元素是 .native-edit-context DIV）
// 这两种情况下，editor.focus() 都能正确把输入事件路由到 Monaco。
function focusEditor() {
  if (!editorInstance.value) return
  editorInstance.value.focus()
  // EditContext 模式下 editor.focus() 不一定能把 DOM 焦点转移到 .native-edit-context 上，
  // 显式补一次 DOM focus 兜底（EditContext 节点本身就是可聚焦的）。
  const ec = document.querySelector('.monaco-editor .native-edit-context') as HTMLElement | null
  if (ec && document.activeElement !== ec) {
    // 不能在每个 tick 都抢焦点，只在 Monaco 已 focus 但 activeElement 漂移时纠正一次。
    requestAnimationFrame(() => ec.focus?.())
  }
}

// 同步"未保存文件数"到 editorTabs store（供活动栏显示徽标）。
// 只统计真实文件 tab：图片 tab 的 content 始终为空字符串、isDirty 恒为 false，
// 这里统一用 isDirty 过滤即可，无需区分类型。
watch(
  () => tabs.value.filter(t => t.isDirty).length,
  (n) => { editorTabsStore.setDirtyCount(n) },
  { immediate: true },
)
// 组件卸载时清零，避免空 tab 列表后徽标仍显示历史数字
onBeforeUnmount(() => editorTabsStore.setDirtyCount(0))

// 跟随系统主题
const themeObserver = new MutationObserver(() => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
  monaco.editor.setTheme(isDark ? 'vs-dark' : 'vs')
})

// 监听编辑器视图的可见性变化：
// 用户点击活动栏切换视图时，父容器 (.editor-pane) 的 v-show 会切换 display。
// 切回编辑器视图后，焦点往往停留在被点击的活动栏按钮上（button 默认可聚焦），
// 此时 Monaco 收不到键盘输入，空格键反而会触发按钮点击 —— 表现为"不能输入空格"。
// 用 MutationObserver 监听 display，视图变可见且有打开的文件时把焦点交还给 Monaco。
let viewVisibilityObserver: MutationObserver | null = null
function setupViewVisibilityObserver() {
  if (viewVisibilityObserver || !containerRef.value) return
  // 观察自身及祖先链上最近的 display 控制节点（.editor-pane / .view-pane）
  const targets: Element[] = [containerRef.value]
  let p: Element | null = containerRef.value.parentElement
  while (p) {
    if (p.classList.contains('view-pane') || p.classList.contains('editor-pane')) {
      targets.push(p)
      break
    }
    p = p.parentElement
  }
  viewVisibilityObserver = new MutationObserver(() => {
    const visible = containerRef.value && containerRef.value.offsetParent !== null
    if (visible && activeTabPath.value && editorInstance.value) {
      // 延迟一帧，确保 display 切换已应用
      requestAnimationFrame(() => {
        // 仅当当前焦点不在输入框（搜索框/重命名/内联新建）时才抢焦点，
        // 避免打断用户在这些输入框里的操作
        const ae = document.activeElement as HTMLElement | null
        const isInputLike = ae && (
          ae.tagName === 'INPUT'
          || ae.tagName === 'TEXTAREA'
          || ae.isContentEditable
          // Chrome 121+/Edge 在 Monaco 上启用 EditContext API 后，
          // 焦点元素是 <div class="native-edit-context">（不是 contenteditable）。
          // 此时焦点已经在 Monaco 内，不要再抢。
          || ae.classList?.contains('native-edit-context')
          || ae.classList?.contains('monaco-editor')
        )
        if (!isInputLike) focusEditor()
      })
    }
  })
  const observer = viewVisibilityObserver
  targets.forEach(t =>
    observer.observe(t, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] }),
  )
}

onMounted(async () => {
  mountEditor()
  await initTree()
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  setupViewVisibilityObserver()
  // 首次 mount 时若已有打开的文件，主动把焦点交给 Monaco，避免初次进入编辑器视图时空格键失效。
  if (activeTabPath.value) {
    nextTick(() => focusEditor())
  }
})

onBeforeUnmount(() => {
  themeObserver.disconnect()
  viewVisibilityObserver?.disconnect()
  viewVisibilityObserver = null
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
  const mod = e.ctrlKey || e.metaKey
  if (mod && e.key.toLowerCase() === 'f') {
    // Ctrl/Cmd+F:聚焦到资源管理器的搜索框(类似 VS Code)
    e.preventDefault()
    focusSearchInput()
    return
  }
  if (mod && e.key === 's') {
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

// ── 文件图标 ──────────────────────────────────────
// 给 inline SVG 用的 sprite id（已包含 icon- 前缀），EditorView 自己的 inline 树用这个
function getNodeSpriteId(node: TreeNode): string {
  if (node.type === 'directory') return getFolderIconClass(node.name)
  return getFileIconClass(node.name)
}

// ── 新建 / 重命名 / 删除 ────────────────────────────────
// inline 输入状态
interface InlineInput {
  parentPath: string
  afterNode: TreeNode | null   // 在此节点后面插入
  kind: 'file' | 'directory'
  value: string
  depth: number               // 缩进层级
}

interface RenameInput {
  node: TreeNode
  value: string
}

const inlineInput = ref<InlineInput | null>(null)
const renameInput = ref<RenameInput | null>(null)
const inlineInputRef = ref<HTMLInputElement | null>(null)
const renameInputRef = ref<HTMLInputElement | null>(null)

// 根据 selectedNode 计算插入目标
function getTargetDir(): { parentPath: string; afterNode: TreeNode | null; depth: number } {
  const sel = selectedNode.value
  if (sel) {
    if (sel.type === 'directory') {
      // 在选中目录内创建 → afterNode 是该目录，depth+1
      return { parentPath: sel.path, afterNode: sel, depth: sel.depth + 1 }
    } else {
      // 与选中文件同级创建
      const parent = sel.path.includes('/') || sel.path.includes('\\')
        ? sel.path.replace(/[\\/][^\\/]+$/, '')
        : configStore.currentDirectory ?? ''
      return { parentPath: parent, afterNode: sel, depth: sel.depth }
    }
  }
  return { parentPath: configStore.currentDirectory ?? '', afterNode: null, depth: 0 }
}

async function startNewFile() {
  const target = getTargetDir()
  if (selectedNode.value?.type === 'directory' && !selectedNode.value.expanded) {
    await toggleDir(selectedNode.value)
  }
  inlineInput.value = { ...target, kind: 'file', value: '' }
  await nextTick()
  inlineInputRef.value?.focus()
}

async function startNewFolder() {
  const target = getTargetDir()
  if (selectedNode.value?.type === 'directory' && !selectedNode.value.expanded) {
    await toggleDir(selectedNode.value)
  }
  inlineInput.value = { ...target, kind: 'directory', value: '' }
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
  await refreshTree()
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
  if (node) selectedNode.value = node
  if (node?.type === 'directory' && !node.expanded) await toggleDir(node)
  const target = getTargetDir()
  inlineInput.value = { ...target, kind: 'file', value: '' }
  await nextTick()
  inlineInputRef.value?.focus()
}

async function ctxNewFolder() {
  const node = ctxMenu.value?.node
  closeContextMenu()
  if (node) selectedNode.value = node
  if (node?.type === 'directory' && !node.expanded) await toggleDir(node)
  const target = getTargetDir()
  inlineInput.value = { ...target, kind: 'directory', value: '' }
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
  await refreshTree()
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
  await refreshTree()
}

async function ctxRevealInExplorer() {
  const node = ctxMenu.value?.node
  closeContextMenu()
  if (!node) return
  try {
    const resp = await fetch('/api/editor/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: node.path }),
    })
    const data = await resp.json()
    if (!data.success) ElMessage.error(data.error)
  } catch (error: any) {
    ElMessage.error(error?.message || String(error))
  }
}

// 点击全局关闭右键菜单
onMounted(() => document.addEventListener('click', closeContextMenu))
onBeforeUnmount(() => document.removeEventListener('click', closeContextMenu))

// ── 预览面板 ────────────────────────────────────────────
const PREVIEW_TEXT_EXTS = new Set(['md', 'html', 'htm', 'svg'])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp'])

const showPreview = ref(false)
// 思维导图模式:整篇 markdown 渲染为一张大导图。与 showPreview 互斥。
const showMindmap = ref(false)
// 0 = 默认占满右半边（flex: 1 1 0%），用户拖动 resizer 后会写入实际像素值
const previewWidth = ref(0)

const activeTabRef = computed(() => tabs.value.find(t => t.path === activeTabPath.value) ?? null)

/** 当前 tab 是否为图片（content 为空、language 为 'plaintext'，由 openFile 设置） */
const activeTabIsImage = computed(() => activeTabRef.value?.language === 'plaintext' && activeTabRef.value?.content === '')

const activeExt = computed(() => {
  const name = activeTabRef.value?.name ?? ''
  return name.split('.').pop()?.toLowerCase() ?? ''
})

const isPreviewable = computed(() =>
  PREVIEW_TEXT_EXTS.has(activeExt.value) || IMAGE_EXTS.has(activeExt.value)
)
// 思维导图只对 markdown 开放,且需要至少有一个 # 标题才值得预览
const mindmapTitleCount = computed(() => {
  const md = activeTabRef.value?.content ?? ''
  return (md.match(/^#{1,6}\s+/gm) || []).length
})
const isMindmapable = computed(() => activeExt.value === 'md' && mindmapTitleCount.value > 0)

// 切换文件时,若当前文件不可预览则自动关闭预览 / 思维导图
watch(activeTabPath, () => {
  if (showPreview.value && !isPreviewable.value) showPreview.value = false
  if (showMindmap.value && !isMindmapable.value) showMindmap.value = false
})

function togglePreview() {
  if (!isPreviewable.value) return
  // 互斥:打开 HTML 预览时关掉思维导图
  if (!showPreview.value) showMindmap.value = false
  showPreview.value = !showPreview.value
}

function toggleMindmap() {
  if (!isMindmapable.value) return
  if (!showMindmap.value) showPreview.value = false
  showMindmap.value = !showMindmap.value
}

// 生成 iframe srcdoc（md / html / htm / svg）
const previewSrcdoc = computed(() => {
  const tab = activeTabRef.value
  if (!tab) return ''
  const ext = activeExt.value

  const isDark = document.documentElement.getAttribute('data-theme') !== 'light'
  const bg = isDark ? '#0d1117' : '#ffffff'

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
  // resizer 在面板右侧：向右拖动 → 面板变宽
  const delta = e.clientX - previewResizeStartX
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

      <div class="sidebar-search">
        <svg class="sidebar-search-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          ref="searchInputRef"
          v-model="searchQuery"
          type="text"
          class="sidebar-search-input"
          :placeholder="$t('@EDITOR:搜索文件...')"
          :title="$t('@EDITOR:搜索文件...')"
          spellcheck="false"
          autocomplete="off"
          @keydown.escape="onSearchEscape"
        />
        <button
          v-if="searchQuery"
          class="sidebar-search-clear"
          :title="$t('@EDITOR:清除搜索')"
          :aria-label="$t('@EDITOR:清除搜索')"
          @click="clearSearch"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <div class="sidebar-tree" v-if="!treeLoading">
        <template v-for="node in flattenTree(visibleTree)" :key="node.path">
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
            <svg class="tree-icon mit-icon" aria-hidden="true">
              <use :xlink:href="`#${getNodeSpriteId(node)}`" />
            </svg>
            <input
              ref="renameInputRef"
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
              'tree-node--selected': selectedNode?.path === node.path && activeTabPath !== node.path,
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
            <svg
              v-if="node.type === 'directory'"
              class="tree-icon mit-icon"
              aria-hidden="true"
            >
              <use :xlink:href="`#${getNodeSpriteId(node)}`" />
            </svg>
            <svg v-else class="tree-icon mit-icon" aria-hidden="true">
              <use :xlink:href="`#${getNodeSpriteId(node)}`" />
            </svg>
            <!-- 名称(命中关键字高亮) -->
            <span class="tree-name" :title="node.path">
              <template v-for="(part, i) in highlightName(node.name)" :key="i">
                <span v-if="part.hit" class="tree-name-hit">{{ part.text }}</span>
                <template v-else>{{ part.text }}</template>
              </template>
            </span>
            <span v-if="node.loading" class="tree-loading" />
          </div>

          <!-- 内联新建输入框：紧跟在 afterNode 之后 -->
          <div
            v-if="inlineInput && inlineInput.afterNode?.path === node.path"
            class="tree-node tree-inline-input-row"
            :style="{ paddingLeft: (12 + inlineInput.depth * 14) + 'px' }"
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
        </template>

        <!-- 根级输入框（无选中节点时出现在列表末尾） -->
        <div
          v-if="inlineInput && inlineInput.afterNode === null"
          class="tree-node tree-inline-input-row"
          :style="{ paddingLeft: '12px' }"
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

        <div v-if="!inlineInput && (noSearchResults || treeNodes.length === 0)" class="tree-empty">
          {{ noSearchResults ? $t('@EDITOR:未找到匹配文件') : $t('@EDITOR:暂无文件') }}
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
        <!-- 思维导图:整篇 markdown 渲染为一张大导图 -->
        <button
          v-if="isMindmapable"
          class="preview-toggle-btn mindmap-toggle-btn"
          :class="{ active: showMindmap, disabled: !isMindmapable }"
          :disabled="!isMindmapable"
          :title="isMindmapable ? (showMindmap ? $t('@EDITOR:关闭思维导图') : $t('@EDITOR:打开思维导图')) : $t('@EDITOR:需要至少一个 # 标题')"
          @click="toggleMindmap"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="2"/>
            <circle cx="5" cy="6" r="1.6"/>
            <circle cx="19" cy="6" r="1.6"/>
            <circle cx="5" cy="18" r="1.6"/>
            <circle cx="19" cy="18" r="1.6"/>
            <line x1="11" y1="11" x2="6.4" y2="7"/>
            <line x1="13" y1="11" x2="17.6" y2="7"/>
            <line x1="11" y1="13" x2="6.4" y2="17"/>
            <line x1="13" y1="13" x2="17.6" y2="17"/>
          </svg>
          <span>{{ $t('@EDITOR:思维导图') }}</span>
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

      <!-- Monaco 容器（始终挂载，tab 为空或 image tab 时隐藏） -->
      <div class="editor-body">
        <div
          class="monaco-container"
          :class="{ hidden: tabs.length === 0 || activeTabIsImage }"
          ref="editorContainerRef"
        />
        <!-- 图片 tab 时的占位提示（主预览区在右侧 preview-panel） -->
        <div
          v-if="activeTabIsImage && tabs.length > 0 && !showPreview && !showMindmap"
          class="image-tab-placeholder"
        >
          <svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" style="opacity:.35">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <circle cx="9" cy="9" r="2"/>
            <path d="m21 15-5-5L5 21"/>
          </svg>
          <p class="image-tab-placeholder-title">{{ activeTabRef?.name }}</p>
          <p class="image-tab-placeholder-hint">{{ $t('@EDITOR:这是图片文件，已在右侧预览面板中打开') }}</p>
        </div>
        <!-- 预览分隔条（在面板右侧，拉动调整面板宽度） -->
        <div
          v-if="(showPreview || showMindmap) && tabs.length > 0"
          class="preview-resizer"
          @mousedown="startPreviewResize"
        />
        <!-- 预览面板 -->
        <div
          v-if="(showPreview || showMindmap) && tabs.length > 0"
          class="preview-panel"
          :style="{ flexBasis: previewWidth + 'px' }"
        >
          <div class="preview-header">
            <span class="preview-title">{{ showMindmap ? $t('@EDITOR:思维导图') : $t('@EDITOR:预览') }}</span>
            <span class="preview-ext-badge">{{ activeExt.toUpperCase() }}</span>
            <div class="preview-header-spacer" />
            <button
              class="preview-close-btn"
              :title="showMindmap ? $t('@EDITOR:关闭思维导图') : $t('@EDITOR:关闭预览')"
              @click="showMindmap ? (showMindmap = false) : (showPreview = false)"
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <div class="preview-body">
            <!-- 思维导图:整篇 markdown → 一张大导图 -->
            <MindmapPreview
              v-if="showMindmap && activeExt === 'md' && activeTabRef"
              :content="activeTabRef.content"
              class="preview-mindmap"
            />
            <!-- Markdown → in-app 渲染 -->
            <MarkdownPreview
              v-else-if="showPreview && activeExt === 'md' && activeTabRef"
              :content="activeTabRef.content"
              class="preview-markdown"
            />
            <!-- HTML / SVG → sandboxed iframe -->
            <iframe
              v-else-if="showPreview && ['html', 'htm', 'svg'].includes(activeExt)"
              class="preview-iframe"
              sandbox="allow-same-origin"
              :srcdoc="previewSrcdoc"
            />
            <!-- 图片预览（使用增强版 ImagePreview，支持缩放/拖拽） -->
            <ImagePreview
              v-else-if="showPreview && IMAGE_EXTS.has(activeExt) && activeTabRef"
              :file-path="activeTabRef.path"
              :file-name="activeTabRef.name"
            />
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
      <button class="ctx-menu-item" @click="ctxRevealInExplorer">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2"/>
        </svg>
        {{ $t('@EDITOR:在资源管理器中打开') }}
      </button>
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

.sidebar-search {
  position: relative;
  display: flex;
  align-items: center;
  padding: 6px 10px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-color);
}

.sidebar-search-icon {
  position: absolute;
  left: 18px;
  color: var(--text-tertiary);
  pointer-events: none;
}

.sidebar-search-input {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 24px 0 26px;
  font-size: 12px;
  color: var(--text-primary);
  background: var(--bg-input, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
  outline: none;
  transition: border-color 0.12s, background 0.12s;
}

.sidebar-search-input::placeholder {
  color: var(--text-tertiary);
}

.sidebar-search-input:hover {
  border-color: var(--text-tertiary);
}

.sidebar-search-input:focus {
  border-color: var(--accent-color, #3b82f6);
  background: var(--bg-panel);
}

.sidebar-search-clear {
  position: absolute;
  right: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  color: var(--text-tertiary);
  transition: background 0.12s, color 0.12s;
}

.sidebar-search-clear:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* 节点名搜索命中高亮(沿用主题色 + 柔和背景) */
.tree-name-hit {
  color: var(--accent-color, #f59e0b);
  background: rgba(245, 158, 11, 0.15);
  border-radius: 2px;
  padding: 0 1px;
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

.tree-node--selected {
  background: rgba(99, 179, 237, 0.15);
  outline: 1px solid rgba(99, 179, 237, 0.35);
  outline-offset: -1px;
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

.tree-icon.mit-icon {
  width: 14px;
  height: 14px;
  fill: currentColor;
  display: inline-block;
  vertical-align: middle;
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

/* 图片 tab 时的占位（无预览时显示） */
.image-tab-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
  color: var(--text-secondary);
  background: var(--bg-container);
  text-align: center;
  padding: var(--spacing-lg);
}

.image-tab-placeholder-title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin: 0;
  word-break: break-all;
}

.image-tab-placeholder-hint {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  margin: 0;
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
  /* resizer 视觉上位于面板右边缘：让 monaco / 面板保持原 DOM 顺序，
     借助 flex order 把它推到 flex 容器的最右端 */
  order: 99;
  margin-left: auto;
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
  flex-grow: 1;             /* 默认占满右侧剩余空间 */
  flex-shrink: 1;
  flex-basis: 0;            /* 让 flex-grow 均匀分配，避免首屏从 0 起跳 */
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

.preview-markdown {
  flex: 1;
  width: 100%;
  height: 100%;
  overflow: auto;
  background: var(--bg-container, #ffffff);
  color: var(--text-primary, #1f2328);
}

.preview-mindmap {
  flex: 1;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--bg-container, #ffffff);
  display: flex;
  flex-direction: column;
}

.mindmap-toggle-btn.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.mindmap-toggle-btn.active {
  /* Override accent for mindmap so it reads as a separate mode */
  background: linear-gradient(180deg, #6366f1 0%, #4f46e5 100%);
  color: #fff;
  border-color: #4f46e5;
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

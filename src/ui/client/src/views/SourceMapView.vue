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
import { ref, shallowRef, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import * as monaco from 'monaco-editor'
import { $t } from '@/lang/static'
import { useVueFlow, VueFlow, Handle, Position, type Node as FlowNode, type Edge as FlowEdge, MarkerType } from '@vue-flow/core'
import dagre from 'dagre'
import { Background, BackgroundVariant } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import { ElMessage } from 'element-plus'
import { useConfigStore } from '@/stores/configStore'
import { getFileIconClass } from '@/utils/fileIcon'

// ── 类型定义 ─────────────────────────────────────────────────────────────────

interface GraphNode {
  id: string
  label: string
  file: string
  line?: number
  type?: string
  importance?: string
  description?: string
  subsystem?: string
  subsystemIndex?: number
  subsystemColor?: string
}

interface GraphEdge {
  source: string
  target: string
}

interface AnalysisResult {
  language: string
  entryFile: string
  entryFunction: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  techStack: string[]
  summary: string
  allFiles: string[]
  codeFiles: string[]
  subsystems?: Array<{ name: string; displayName: string; rootPath: string; color: string }>
}

interface LogEntry {
  id: number
  message: string
  type: 'info' | 'success' | 'error' | 'thinking'
  timestamp: number
}

interface TreeNode {
  name: string
  path: string
  kind: 'file' | 'dir'
  children: TreeNode[]
}

// ── 状态 ───────────────────────────────────────────────────────────────────

const configStore = useConfigStore()
const projectPath = ref(configStore.currentDirectory || '')

// 分析状态
type Status = 'idle' | 'scanning' | 'analyzing' | 'done' | 'error'
const status = ref<Status>('idle')
const logs = ref<LogEntry[]>([])
let logIdCounter = 0

// 分析结果
const result = ref<AnalysisResult | null>(null)
const selectedNodeId = ref<string | null>(null)
const leftTab = ref<'files' | 'outline'>('files')
const sourceCode = ref('')
const sourceFile = ref('')
const sourceLoading = ref(false)

// 文件树
const fileTreeData = ref<TreeNode[]>([])
const expandedFolders = ref<Set<string>>(new Set())

// 面板可见性
const panelVisible = ref({ files: true, graph: true, source: true })
const isOptimizing = ref(false)

// 面板尺寸（可拖拽调整）
const filesWidth = ref(220)
const sourceWidth = ref(360)
const logHeight = ref(140)

type ResizeTarget = 'files' | 'source' | 'log'
let _resizeTarget: ResizeTarget | null = null
let _resizeStartX = 0
let _resizeStartY = 0
let _resizeStartVal = 0

function startPanelResize(target: ResizeTarget, e: MouseEvent) {
  _resizeTarget = target
  _resizeStartX = e.clientX
  _resizeStartY = e.clientY
  _resizeStartVal = target === 'files' ? filesWidth.value
    : target === 'source' ? sourceWidth.value
    : logHeight.value
  document.addEventListener('mousemove', onPanelResize)
  document.addEventListener('mouseup', stopPanelResize)
  e.preventDefault()
}

function onPanelResize(e: MouseEvent) {
  if (!_resizeTarget) return
  if (_resizeTarget === 'files') {
    filesWidth.value = Math.max(120, Math.min(480, _resizeStartVal + e.clientX - _resizeStartX))
  } else if (_resizeTarget === 'source') {
    sourceWidth.value = Math.max(200, Math.min(700, _resizeStartVal + _resizeStartX - e.clientX))
  } else {
    logHeight.value = Math.max(60, Math.min(500, _resizeStartVal + _resizeStartY - e.clientY))
  }
}

function stopPanelResize() {
  _resizeTarget = null
  document.removeEventListener('mousemove', onPanelResize)
  document.removeEventListener('mouseup', stopPanelResize)
}

// Monaco
const monacoContainerRef = ref<HTMLElement | null>(null)
const monacoInstance = shallowRef<monaco.editor.IStandaloneCodeEditor | null>(null)

// VueFlow
const { fitView, setNodes, setEdges, getNodes, getEdges, updateNodeInternals } = useVueFlow()

// ── 计算属性 ──────────────────────────────────────────────────────────────────

const isAnalyzing = computed(() => status.value === 'scanning' || status.value === 'analyzing')

const selectedNode = computed(() =>
  result.value?.nodes.find(n => n.id === selectedNodeId.value) ?? null
)

const outlineGroups = computed(() => {
  if (!result.value) return []
  const groups = new Map<string, { displayName: string; color: string; nodes: GraphNode[] }>()
  for (const n of result.value.nodes) {
    const key = n.subsystem ?? '__default__'
    if (!groups.has(key)) {
      const sub = result.value.subsystems?.find(s => s.name === key)
      groups.set(key, {
        displayName: sub?.displayName || n.subsystem || $t('@SRCMAP:默认'),
        color: n.subsystemColor || SUBSYSTEM_COLORS[0],
        nodes: [],
      })
    }
    groups.get(key)!.nodes.push(n)
  }
  return [...groups.entries()].map(([, g]) => g)
})

// ── 辅助函数 ─────────────────────────────────────────────────────────────────

function addLog(message: string, type: LogEntry['type'] = 'info') {
  logs.value.push({ id: ++logIdCounter, message, type, timestamp: Date.now() })
  // 最多保留 200 条
  if (logs.value.length > 200) logs.value.splice(0, logs.value.length - 200)
}

function buildFileTree(paths: string[]): TreeNode[] {
  const root: TreeNode & { childMap: Map<string, TreeNode & { childMap: Map<string, any> }> } = {
    name: '', path: '', kind: 'dir', children: [], childMap: new Map()
  }
  for (const rawPath of paths) {
    const parts = rawPath.trim().split('/').filter(Boolean)
    let current: any = root
    let currentPath = ''
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      currentPath = currentPath ? `${currentPath}/${part}` : part
      const isLeaf = i === parts.length - 1
      let next = current.childMap.get(part)
      if (!next) {
        next = { name: part, path: currentPath, kind: isLeaf ? 'file' : 'dir', children: [], childMap: new Map() }
        current.childMap.set(part, next)
        current.children.push(next)
      }
      current = next
    }
  }
  const sortTree = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    nodes.forEach(n => { if (n.kind === 'dir') sortTree(n.children) })
  }
  sortTree(root.children)
  return root.children
}

const SUBSYSTEM_COLORS = ['#f59e0b', '#3b82f6', '#10b981', '#8b5cf6']

function nodeColor(node: GraphNode): string {
  if (node.subsystemColor) return node.subsystemColor
  if (node.subsystemIndex !== undefined) return SUBSYSTEM_COLORS[node.subsystemIndex % SUBSYSTEM_COLORS.length]
  if (node.importance === 'high') return '#f59e0b'
  if (node.importance === 'low') return '#94a3b8'
  return '#3b82f6'
}

function getLanguageFromFile(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  const m: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    vue: 'html', svelte: 'html', html: 'html',
    py: 'python', java: 'java', go: 'go', rs: 'rust',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
    cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin',
    sh: 'shell', bash: 'shell',
    json: 'json', yaml: 'yaml', yml: 'yaml',
    md: 'markdown', css: 'css', scss: 'scss', less: 'less', sql: 'sql',
  }
  return m[ext] || 'plaintext'
}

function mountMonaco() {
  if (!monacoContainerRef.value || monacoInstance.value) return
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
  monacoInstance.value = monaco.editor.create(monacoContainerRef.value, {
    value: '',
    language: 'plaintext',
    theme: isDark ? 'vs-dark' : 'vs',
    readOnly: true,
    fontSize: 12,
    lineHeight: 19,
    fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    wordWrap: 'off',
    padding: { top: 8, bottom: 8 },
    scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
  })
}

function buildFlowGraph(graphNodes: GraphNode[], graphEdges: GraphEdge[]) {
  // 按子系统分组布局：每个子系统独立一列区域，内部按 BFS 深度排列
  const adjMap: Record<string, string[]> = {}
  graphEdges.forEach(e => {
    if (!adjMap[e.source]) adjMap[e.source] = []
    adjMap[e.source].push(e.target)
  })

  // 识别子系统组
  const subsystemGroups = new Map<string, GraphNode[]>()
  graphNodes.forEach(n => {
    const key = n.subsystem ?? '__default'
    if (!subsystemGroups.has(key)) subsystemGroups.set(key, [])
    subsystemGroups.get(key)!.push(n)
  })

  const X_GAP = 220
  const Y_GAP = 110
  const SUBSYSTEM_X_OFFSET = 600  // 子系统间距

  const flowNodes: FlowNode[] = []

  let subsystemIdx = 0
  for (const [, groupNodes] of subsystemGroups) {
    // BFS 层次计算（仅在组内）
    const groupIds = new Set(groupNodes.map(n => n.id))
    const levelMap: Record<string, number> = {}
    const queue: string[] = groupNodes.length ? [groupNodes[0].id] : []
    if (queue[0]) levelMap[queue[0]] = 0
    while (queue.length) {
      const cur = queue.shift()!
      const children = (adjMap[cur] || []).filter(c => groupIds.has(c))
      children.forEach(child => {
        if (levelMap[child] === undefined) {
          levelMap[child] = (levelMap[cur] ?? 0) + 1
          queue.push(child)
        }
      })
    }
    const levelCounts: Record<number, number> = {}
    groupNodes.forEach(n => { const l = levelMap[n.id] ?? 0; levelCounts[l] = (levelCounts[l] || 0) + 1 })
    const levelColIdx: Record<number, number> = {}
    groupNodes.forEach(n => {
      const level = levelMap[n.id] ?? 0
      levelColIdx[level] = (levelColIdx[level] ?? -1) + 1
      const col = levelColIdx[level]
      const total = levelCounts[level] ?? 1
      const x = subsystemIdx * SUBSYSTEM_X_OFFSET + col * X_GAP - ((total - 1) * X_GAP) / 2
      const y = level * Y_GAP
      const color = nodeColor(n)
      flowNodes.push({
        id: n.id,
        type: 'default',
        position: { x, y },
        label: n.label,
        data: { ...n },
        style: {
          background: '#1e293b',
          border: `2px solid ${color}`,
          borderRadius: '8px',
          color: '#e2e8f0',
          fontSize: '12px',
          padding: '8px 12px',
          minWidth: '140px',
          maxWidth: '200px',
          cursor: 'pointer',
        }
      })
    })
    subsystemIdx++
  }

  const flowEdges: FlowEdge[] = graphEdges.map((e, i) => ({
    id: `e_${i}_${e.source}_${e.target}`,
    source: e.source,
    target: e.target,
    type: 'smoothstep',
    animated: false,
    style: { stroke: '#475569', strokeWidth: 1.5 },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#475569' },
  }))

  return { flowNodes, flowEdges }
}

// ── 布局优化（dagre） ─────────────────────────────────────────────────────────

async function optimizeLayout() {
  const flowNodes = getNodes.value
  const flowEdges = getEdges.value
  if (flowNodes.length === 0) return

  isOptimizing.value = true
  try {
    // 等待 VueFlow 完成 DOM 渲染并测量节点尺寸
    await nextTick()
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    updateNodeInternals(flowNodes.map(n => n.id))
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

    // 按子系统分组，各自跑一遍 dagre，然后水平排列
    const subsystemGroups = new Map<string, FlowNode[]>()
    flowNodes.forEach(n => {
      const key = (n.data?.subsystem as string) ?? '__default__'
      if (!subsystemGroups.has(key)) subsystemGroups.set(key, [])
      subsystemGroups.get(key)!.push(n)
    })

    const updatedPositions = new Map<string, { x: number; y: number }>()
    let subsystemOffsetX = 0
    const SUBSYSTEM_GAP = 120

    for (const [, groupNodes] of subsystemGroups) {
      const g = new dagre.graphlib.Graph()
      g.setDefaultEdgeLabel(() => ({}))
      g.setGraph({ rankdir: 'TB', nodesep: 55, ranksep: 75, marginx: 40, marginy: 40 })

      const groupIds = new Set(groupNodes.map(n => n.id))
      groupNodes.forEach(n => {
        let w = 190, h = n.data?.description ? 68 : 48
        const el = document.querySelector(`.vue-flow__node[data-id="${n.id}"]`) as HTMLElement | null
        if (el && el.offsetWidth > 0) { w = el.offsetWidth; h = el.offsetHeight }
        g.setNode(n.id, { width: w, height: h })
      })
      flowEdges.forEach(e => {
        if (groupIds.has(e.source) && groupIds.has(e.target)) g.setEdge(e.source, e.target)
      })

      dagre.layout(g)

      let maxX = 0
      groupNodes.forEach(n => {
        const pos = g.node(n.id)
        if (pos) {
          updatedPositions.set(n.id, { x: subsystemOffsetX + pos.x - pos.width / 2, y: pos.y - pos.height / 2 })
          maxX = Math.max(maxX, pos.x + pos.width / 2)
        }
      })
      subsystemOffsetX += maxX + SUBSYSTEM_GAP
    }

    const newNodes = flowNodes.map(n => ({ ...n, position: updatedPositions.get(n.id) ?? n.position }))
    setNodes(newNodes)
    await nextTick()
    fitView({ padding: 0.18 })
  } finally {
    isOptimizing.value = false
  }
}

// ── 分析核心 ──────────────────────────────────────────────────────────────────

async function startAnalysis() {
  if (!projectPath.value.trim()) {
    ElMessage.warning($t('@SRCMAP:请先输入项目路径'))
    return
  }
  if (isAnalyzing.value) return

  logs.value = []
  result.value = null
  selectedNodeId.value = null
  sourceCode.value = ''
  sourceFile.value = ''
  setNodes([])
  setEdges([])
  status.value = 'scanning'
  addLog($t('@SRCMAP:开始分析项目...'), 'info')

  try {
    // 使用 fetch + SSE 读取
    const response = await fetch('/api/code-analysis/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: projectPath.value }),
    })

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: '请求失败' }))
      throw new Error(err.error || `HTTP ${response.status}`)
    }

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    status.value = 'analyzing'

    let currentEvent = ''
    let dataLines: string[] = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim()
          dataLines = []
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim())
        } else if (line === '') {
          // 空行：处理当前事件
          if (currentEvent && dataLines.length) {
            const dataStr = dataLines.join('')
            try {
              const payload = JSON.parse(dataStr)
              handleSseEvent(currentEvent, payload)
            } catch { /* ignore parse error */ }
          }
          currentEvent = ''
          dataLines = []
        }
      }
    }
  } catch (err: any) {
    addLog(`${$t('@SRCMAP:分析失败')}: ${err.message}`, 'error')
    status.value = 'error'
  }
}

function handleSseEvent(event: string, payload: any) {
  if (event === 'log') {
    addLog(payload.message, payload.type || 'info')
  } else if (event === 'files') {
    const allFiles: string[] = payload.files || []
    fileTreeData.value = buildFileTree(allFiles)
    // 默认展开第一层
    fileTreeData.value.forEach(n => {
      if (n.kind === 'dir') expandedFolders.value.add(n.path)
    })
  } else if (event === 'result') {
    result.value = {
      language: payload.language || '',
      entryFile: payload.entryFile || '',
      entryFunction: payload.entryFunction || '',
      nodes: Array.isArray(payload.nodes) ? payload.nodes : [],
      edges: Array.isArray(payload.edges) ? payload.edges : [],
      techStack: Array.isArray(payload.techStack) ? payload.techStack : [],
      summary: payload.summary || '',
      allFiles: Array.isArray(payload.allFiles) ? payload.allFiles : [],
      codeFiles: Array.isArray(payload.codeFiles) ? payload.codeFiles : [],
      subsystems: Array.isArray(payload.subsystems) ? payload.subsystems : undefined,
    }
    // 渲染图
    const { flowNodes, flowEdges } = buildFlowGraph(result.value.nodes, result.value.edges)
    setNodes(flowNodes)
    setEdges(flowEdges)
    nextTick(() => optimizeLayout())
  } else if (event === 'done') {
    if (payload.error) {
      addLog(`${$t('@SRCMAP:分析失败')}: ${payload.error}`, 'error')
      status.value = 'error'
    } else {
      status.value = 'done'
    }
  }
}

// ── 文件源码加载 ────────────────────────────────────────────────────────────

async function openFile(filePath: string) {
  if (!filePath || sourceLoading.value) return
  if (sourceFile.value === filePath) return
  sourceLoading.value = true
  sourceFile.value = filePath
  sourceCode.value = ''
  try {
    const res = await fetch(
      `/api/code-analysis/file-content?path=${encodeURIComponent(projectPath.value)}&file=${encodeURIComponent(filePath)}`
    )
    const data = await res.json()
    if (data.error) throw new Error(data.error)
    sourceCode.value = data.content || ''
  } catch (err: any) {
    sourceCode.value = `// ${$t('@SRCMAP:加载失败')}: ${err.message}`
  } finally {
    sourceLoading.value = false
  }
}

// ── VueFlow 事件 ─────────────────────────────────────────────────────────────

function onNodeClick(event: { node: FlowNode }) {
  const nodeData = event.node.data as GraphNode
  selectedNodeId.value = nodeData.id
  if (nodeData.file) {
    openFile(nodeData.file)
  }
}

// ── 文件树操作 ──────────────────────────────────────────────────────────────

function toggleFolder(path: string) {
  if (expandedFolders.value.has(path)) {
    expandedFolders.value.delete(path)
  } else {
    expandedFolders.value.add(path)
  }
}

// ── 文件树扁平化 ─────────────────────────────────────────────────────────────

interface FlatNode {
  name: string
  path: string
  kind: 'file' | 'dir'
  depth: number
  expanded: boolean
}

const flatTree = computed<FlatNode[]>(() => {
  const res: FlatNode[] = []
  function walk(nodes: TreeNode[], depth: number) {
    for (const n of nodes) {
      const expanded = expandedFolders.value.has(n.path)
      res.push({ name: n.name, path: n.path, kind: n.kind, depth, expanded })
      if (n.kind === 'dir' && expanded) walk(n.children, depth + 1)
    }
  }
  walk(fileTreeData.value, 0)
  return res
})

// ── 生命周期 ─────────────────────────────────────────────────────────────────

watch(() => configStore.currentDirectory, (dir) => {
  if (dir && !projectPath.value) {
    projectPath.value = dir
  }
})

// 当 sourceCode / sourceFile 变化时更新 Monaco
watch([sourceCode, sourceFile], ([code, file]) => {
  const inst = monacoInstance.value
  if (!inst) return
  const lang = getLanguageFromFile(file || '')
  const old = inst.getModel()
  const newModel = monaco.editor.createModel(code || '', lang)
  inst.setModel(newModel)
  old?.dispose()
  // 滚动到顶部
  inst.setScrollPosition({ scrollTop: 0, scrollLeft: 0 })
})

onMounted(() => {
  mountMonaco()
  if (!projectPath.value && configStore.currentDirectory) {
    projectPath.value = configStore.currentDirectory
  }
})

onBeforeUnmount(() => {
  monacoInstance.value?.getModel()?.dispose()
  monacoInstance.value?.dispose()
  stopPanelResize()
})
</script>

<template>
  <div class="source-map-view">
    <!-- 顶部工具栏 -->
    <div class="sm-toolbar">
      <div class="sm-toolbar-left">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" class="sm-icon-map">
          <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/>
          <line x1="9" y1="3" x2="9" y2="18"/>
          <line x1="15" y1="6" x2="15" y2="21"/>
        </svg>
        <span class="sm-title">{{ $t('@SRCMAP:源码地图') }}</span>
      </div>

      <div class="sm-toolbar-center">
        <input
          v-model="projectPath"
          class="sm-path-input"
          :placeholder="$t('@SRCMAP:输入项目目录路径')"
          :disabled="isAnalyzing"
          @keydown.enter="startAnalysis"
        />
        <button
          class="sm-btn sm-btn-primary"
          :disabled="isAnalyzing"
          @click="startAnalysis"
        >
          <template v-if="isAnalyzing">
            <span class="sm-spinner"></span>
            {{ $t('@SRCMAP:分析中...') }}
          </template>
          <template v-else>
            {{ status === 'done' ? $t('@SRCMAP:重新分析') : $t('@SRCMAP:开始分析') }}
          </template>
        </button>
      </div>

      <div class="sm-toolbar-right">
        <!-- 面板显示切换 -->
        <el-tooltip :content="$t('@SRCMAP:文件列表')" placement="bottom">
          <button
            class="sm-panel-btn"
            :class="{ active: panelVisible.files }"
            @click="panelVisible.files = !panelVisible.files"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </button>
        </el-tooltip>
        <el-tooltip :content="$t('@SRCMAP:调用图')" placement="bottom">
          <button
            class="sm-panel-btn"
            :class="{ active: panelVisible.graph }"
            @click="panelVisible.graph = !panelVisible.graph"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8">
              <circle cx="12" cy="12" r="3"/>
              <circle cx="3" cy="6" r="2"/>
              <circle cx="21" cy="6" r="2"/>
              <circle cx="3" cy="18" r="2"/>
              <circle cx="21" cy="18" r="2"/>
              <line x1="5" y1="6" x2="9" y2="11"/>
              <line x1="19" y1="6" x2="15" y2="11"/>
              <line x1="5" y1="18" x2="9" y2="13"/>
              <line x1="19" y1="18" x2="15" y2="13"/>
            </svg>
          </button>
        </el-tooltip>
        <el-tooltip :content="$t('@SRCMAP:源码面板')" placement="bottom">
          <button
            class="sm-panel-btn"
            :class="{ active: panelVisible.source }"
            @click="panelVisible.source = !panelVisible.source"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8">
              <polyline points="16 18 22 12 16 6"/>
              <polyline points="8 6 2 12 8 18"/>
            </svg>
          </button>
        </el-tooltip>
      </div>
    </div>

    <!-- 主体 3 面板 -->
    <div class="sm-body">

      <!-- 左侧：文件树 -->
      <div v-show="panelVisible.files" class="sm-panel sm-panel-files" :style="{ width: filesWidth + 'px' }">
        <div class="sm-panel-header sm-panel-header--tabs">
          <button
            class="sm-tab-btn"
            :class="{ active: leftTab === 'files' }"
            @click="leftTab = 'files'"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            {{ $t('@SRCMAP:文件列表') }}
            <span v-if="result" class="sm-badge">{{ result.allFiles.length }}</span>
          </button>
          <button
            class="sm-tab-btn"
            :class="{ active: leftTab === 'outline' }"
            @click="leftTab = 'outline'"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8">
              <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
              <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
            </svg>
            {{ $t('@SRCMAP:大纲') }}
          </button>
        </div>
        <!-- 文件树 -->
        <div v-show="leftTab === 'files'" class="sm-panel-body sm-file-tree">
          <template v-if="flatTree.length > 0">
            <div
              v-for="node in flatTree"
              :key="node.path"
              class="sm-tree-node"
              :class="{
                'sm-tree-node--dir': node.kind === 'dir',
                'sm-tree-node--active': node.kind === 'file' && sourceFile === node.path,
              }"
              :style="{ paddingLeft: (10 + node.depth * 14) + 'px' }"
              @click="node.kind === 'dir' ? toggleFolder(node.path) : openFile(node.path)"
            >
              <!-- 展开箭头 -->
              <span v-if="node.kind === 'dir'" class="sm-tree-arrow" :class="{ expanded: node.expanded }">
                <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
              </span>
              <span v-else class="sm-tree-arrow-spacer" />
              <!-- 图标 -->
              <svg
                v-if="node.kind === 'dir'"
                class="sm-tree-icon mit-icon"
                aria-hidden="true"
              >
                <use :xlink:href="`#${getFileIconClass(node.name) || 'icon-folder'}`" />
              </svg>
              <svg
                v-else
                class="sm-tree-icon mit-icon"
                aria-hidden="true"
              >
                <use :xlink:href="`#${getFileIconClass(node.name)}`" />
              </svg>
              <!-- 名称 -->
              <span class="sm-tree-name" :title="node.path">{{ node.name }}</span>
            </div>
          </template>
          <div v-else class="sm-tree-empty">{{ $t('@SRCMAP:暂无文件，请先开始分析') }}</div>
        </div>
        <!-- 大纲视图 -->
        <div v-show="leftTab === 'outline'" class="sm-panel-body sm-outline-body">
          <template v-if="outlineGroups.length > 0">
            <div v-for="group in outlineGroups" :key="group.displayName" class="sm-outline-group">
              <div class="sm-outline-group-header" :style="{ color: group.color }">
                <svg viewBox="0 0 24 24" width="8" height="8" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>
                {{ group.displayName }}
                <span class="sm-badge" style="margin-left:auto">{{ group.nodes.length }}</span>
              </div>
              <div
                v-for="node in group.nodes"
                :key="node.id"
                class="sm-outline-node"
                :class="{ 'sm-outline-node--active': selectedNodeId === node.id }"
                @click="selectedNodeId = node.id; node.file && openFile(node.file)"
              >
                <span class="sm-outline-dot" :style="{ background: group.color }"></span>
                <span class="sm-outline-label" :title="node.file || node.label">{{ node.label }}</span>
                <span v-if="node.description" class="sm-outline-desc">{{ (node.description as string).length > 18 ? (node.description as string).slice(0, 18) + '\u2026' : node.description }}</span>
              </div>
            </div>
          </template>
          <div v-else class="sm-tree-empty">{{ $t('@SRCMAP:暂无分析结果') }}</div>
        </div>
      </div>

      <!-- 左侧 resizer -->
      <div v-show="panelVisible.files && panelVisible.graph" class="sm-resizer sm-resizer-v" @mousedown="startPanelResize('files', $event)" />

      <!-- 中间：调用图 + Agent 日志 -->
      <div v-show="panelVisible.graph" class="sm-panel sm-panel-graph">
        <!-- 项目信息 -->
        <div v-if="result" class="sm-project-info">
          <span class="sm-lang-badge">{{ result.language }}</span>
          <!-- 子系统图例 -->
          <template v-if="result.subsystems && result.subsystems.length > 1">
            <span
              v-for="sub in result.subsystems"
              :key="sub.name"
              class="sm-subsystem-tag"
              :style="{ borderColor: sub.color, color: sub.color }"
            >● {{ sub.displayName || sub.name }}</span>
          </template>
          <template v-else>
            <span v-for="tech in result.techStack.slice(0, 4)" :key="tech" class="sm-tech-tag">{{ tech }}</span>
          </template>
          <span class="sm-summary-text">{{ result.summary }}</span>
        </div>

        <!-- Vue Flow 调用图 -->
        <div class="sm-graph-container">
          <!-- 布局优化按钮 -->
          <div class="sm-layout-btn-wrap">
            <button class="sm-layout-btn" :disabled="isOptimizing || !result" @click="optimizeLayout">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8">
                <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
                <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
              </svg>
              {{ isOptimizing ? $t('@SRCMAP:布局中...') : $t('@SRCMAP:优化布局') }}
            </button>
          </div>
          <VueFlow
            class="sm-vue-flow"
            :default-viewport="{ zoom: 1 }"
            :min-zoom="0.2"
            :max-zoom="4"
            fit-view-on-init
            @node-click="onNodeClick"
          >
            <template #node-default="{ data, label }">
              <Handle type="target" :position="Position.Top" />
              <div class="sm-fn-inner" :title="`${label}${data?.description ? '\n' + data.description : ''}`">
                <div class="sm-fn-label">{{ label }}</div>
                <div v-if="data?.description" class="sm-fn-desc">{{ (data.description as string).length > 22 ? (data.description as string).slice(0, 22) + '\u2026' : data.description }}</div>
              </div>
              <Handle type="source" :position="Position.Bottom" />
            </template>
            <Background :variant="BackgroundVariant.Dots" :gap="20" :size="1" pattern-color="#334155" />
            <Controls />
            <MiniMap node-color="#3b82f6" />
          </VueFlow>

          <!-- 空状态 -->
          <div v-if="!result && !isAnalyzing" class="sm-graph-empty">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1" style="opacity:0.3">
              <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/>
              <line x1="9" y1="3" x2="9" y2="18"/>
              <line x1="15" y1="6" x2="15" y2="21"/>
            </svg>
            <p>{{ $t('@SRCMAP:输入项目路径后点击开始分析') }}</p>
          </div>

          <!-- 分析中遮罩 -->
          <div v-if="isAnalyzing && !result" class="sm-graph-loading">
            <span class="sm-spinner sm-spinner-lg"></span>
            <p>{{ $t('@SRCMAP:AI 正在分析项目结构...') }}</p>
          </div>
        </div>

        <!-- 日志 resizer -->
        <div class="sm-resizer sm-resizer-h" @mousedown="startPanelResize('log', $event)" />
        <!-- Agent 日志 -->
        <div class="sm-log-panel" :style="{ height: logHeight + 'px' }">
          <div class="sm-log-header">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8">
              <polyline points="4 17 10 11 4 5"/>
              <line x1="12" y1="19" x2="20" y2="19"/>
            </svg>
            {{ $t('@SRCMAP:Agent 日志') }}
            <span v-if="isAnalyzing" class="sm-log-indicator"></span>
          </div>
          <div class="sm-log-body" ref="logBodyRef">
            <div
              v-for="entry in logs.slice(-50)"
              :key="entry.id"
              :class="['sm-log-entry', `sm-log-entry--${entry.type}`]"
            >
              {{ entry.message }}
            </div>
            <div v-if="logs.length === 0" class="sm-empty">{{ $t('@SRCMAP:等待开始分析') }}</div>
          </div>
        </div>
      </div>

      <!-- 右侧 resizer -->
      <div v-show="panelVisible.graph && panelVisible.source" class="sm-resizer sm-resizer-v" @mousedown="startPanelResize('source', $event)" />

      <!-- 右侧：源码面板 -->
      <div v-show="panelVisible.source" class="sm-panel sm-panel-source" :style="{ width: sourceWidth + 'px' }">
        <div class="sm-panel-header">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
            <polyline points="16 18 22 12 16 6"/>
            <polyline points="8 6 2 12 8 18"/>
          </svg>
          {{ sourceFile || $t('@SRCMAP:源码面板') }}
          <span v-if="selectedNode" class="sm-badge sm-badge-amber">{{ selectedNode.label }}</span>
        </div>
        <!-- 节点详情 -->
        <div v-if="selectedNode" class="sm-node-detail">
          <div class="sm-node-name">{{ selectedNode.label }}</div>
          <div class="sm-node-file">{{ selectedNode.file }}<span v-if="selectedNode.line"> :{{ selectedNode.line }}</span></div>
          <div v-if="selectedNode.description" class="sm-node-desc">{{ selectedNode.description }}</div>
        </div>
        <div class="sm-panel-body sm-source-body">
          <div v-if="sourceLoading" class="sm-source-overlay">
            <span class="sm-spinner"></span>
          </div>
          <div
            v-if="!sourceLoading && !sourceCode"
            class="sm-source-overlay sm-source-placeholder"
          >
            {{ $t('@SRCMAP:点击调用图中的节点查看源码') }}
          </div>
          <!-- Monaco 容器：始终挂载 -->
          <div ref="monacoContainerRef" class="sm-monaco-container" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ── 布局 ─────────────────────────────────── */
.source-map-view {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--bg-page, #0f172a);
  color: var(--text-primary, #e2e8f0);
  font-size: 13px;
}

/* ── 工具栏 ──────────────────────────────── */
.sm-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  background: var(--bg-container, #1e293b);
  border-bottom: 1px solid var(--border-color, #334155);
  flex-shrink: 0;
}

.sm-toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.sm-toolbar-center {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
}

.sm-toolbar-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.sm-icon-map {
  color: #f59e0b;
}

.sm-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, #e2e8f0);
}

.sm-path-input {
  flex: 1;
  height: 30px;
  padding: 0 10px;
  background: var(--bg-page, #0f172a);
  border: 1px solid var(--border-color, #334155);
  border-radius: 6px;
  color: var(--text-primary, #e2e8f0);
  font-size: 12px;
  outline: none;
  transition: border-color 0.15s;
  font-family: 'Consolas', 'Monaco', monospace;
}

.sm-path-input:focus {
  border-color: #f59e0b;
}

.sm-path-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.sm-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 14px;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.sm-btn-primary {
  background: linear-gradient(135deg, #f59e0b, #d97706);
  color: #fff;
}

.sm-btn-primary:hover:not(:disabled) {
  background: linear-gradient(135deg, #fbbf24, #f59e0b);
}

.sm-btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.sm-panel-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 5px;
  cursor: pointer;
  color: var(--text-tertiary, #64748b);
  transition: all 0.15s;
}

.sm-panel-btn:hover, .sm-panel-btn.active {
  background: var(--bg-hover, #1e293b);
  border-color: var(--border-color, #334155);
  color: var(--text-primary, #e2e8f0);
}

.sm-panel-btn.active {
  color: #f59e0b;
  border-color: #f59e0b40;
}

/* ── 主体 ──────────────────────────────────── */
.sm-body {
  flex: 1;
  display: flex;
  overflow: hidden;
  min-height: 0;
}

.sm-resizer {
  flex-shrink: 0;
  position: relative;
  background: transparent;
  transition: background 0.15s;
  z-index: 2;
}

.sm-resizer-v {
  width: 6px;
  cursor: col-resize;
}

.sm-resizer-h {
  height: 6px;
  cursor: row-resize;
}

.sm-resizer::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  border-radius: 2px;
  background: var(--border-color, #334155);
  transition: background 0.15s;
}

.sm-resizer-v::after {
  width: 2px;
  height: 32px;
}

.sm-resizer-h::after {
  width: 32px;
  height: 2px;
}

.sm-resizer:hover {
  background: rgba(59, 130, 246, 0.06);
}

.sm-resizer:hover::after {
  background: var(--color-primary, #3b82f6);
  box-shadow: 0 0 8px rgba(59, 130, 246, 0.4);
}

.sm-resizer-v:hover::after {
  height: 48px;
}

.sm-resizer-h:hover::after {
  width: 48px;
}

/* ── 面板通用 ────────────────────────────── */
.sm-panel {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.sm-panel-files {
  min-width: 0;
  flex-shrink: 0;
  background: var(--bg-container, #1e293b);
  border-right: 1px solid var(--border-color, #334155);
  overflow: hidden;
}

.sm-panel-graph {
  flex: 1;
  min-width: 300px;
  background: var(--bg-page, #0f172a);
}

.sm-panel-source {
  flex-shrink: 0;
  background: var(--bg-container, #1e293b);
  border-left: 1px solid var(--border-color, #334155);
}

.sm-panel-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary, #94a3b8);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid var(--border-color, #334155);
  background: var(--bg-container, #1e293b);
  flex-shrink: 0;
}

.sm-panel-body {
  flex: 1;
  overflow: auto;
  min-height: 0;
}

/* ── 项目信息条 ───────────────────────────── */
.sm-project-info {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--bg-container, #1e293b);
  border-bottom: 1px solid var(--border-color, #334155);
  flex-shrink: 0;
  overflow: hidden;
}

.sm-lang-badge {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  background: #f59e0b22;
  border: 1px solid #f59e0b44;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  color: #f59e0b;
}

.sm-tech-tag {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  background: #3b82f611;
  border: 1px solid #3b82f630;
  border-radius: 4px;
  font-size: 10px;
  color: #93c5fd;
}

.sm-subsystem-tag {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px;
  background: transparent;
  border: 1px solid currentColor;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  opacity: 0.85;
}

.sm-summary-text {
  font-size: 11px;
  color: var(--text-tertiary, #64748b);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  flex: 1;
}

/* ── 调用图 ──────────────────────────────── */
.sm-graph-container {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.sm-vue-flow {
  width: 100%;
  height: 100%;
}

.sm-graph-empty,
.sm-graph-loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-tertiary, #64748b);
  font-size: 13px;
  pointer-events: none;
}

/* ── Agent 日志 ─────────────────────────── */
.sm-log-panel {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border-color, #334155);
  flex-shrink: 0;
  background: var(--bg-container, #1e293b);
  min-height: 60px;
}

.sm-log-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-tertiary, #64748b);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid var(--border-color, #334155);
  flex-shrink: 0;
}

.sm-log-indicator {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #f59e0b;
  animation: pulse 1s infinite;
  margin-left: auto;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.sm-log-body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 11px;
}

.sm-log-entry {
  padding: 2px 10px;
  line-height: 1.5;
}

.sm-log-entry--info { color: #94a3b8; }
.sm-log-entry--success { color: #4ade80; }
.sm-log-entry--error { color: #f87171; }
.sm-log-entry--thinking { color: #f59e0b; }

/* ── 文件树 ─────────────────────────────── */
.sm-file-tree {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px 0;
}

.sm-tree-node {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  cursor: pointer;
  border-radius: 4px;
  padding-right: 8px;
  user-select: none;
  color: var(--text-primary, #e2e8f0);
  font-size: 13px;
  transition: background 0.1s;
  white-space: nowrap;
  overflow: hidden;
  box-sizing: border-box;
}

.sm-tree-node:hover {
  background: var(--bg-hover);
}

.sm-tree-node--active {
  background: rgba(59, 130, 246, 0.12);
  color: var(--color-primary, #3b82f6);
}

.sm-tree-arrow {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  color: var(--text-tertiary, #64748b);
  transition: transform 0.15s;
  width: 12px;
}

.sm-tree-arrow.expanded {
  transform: rotate(90deg);
}

.sm-tree-arrow-spacer {
  width: 12px;
  flex-shrink: 0;
  display: inline-block;
}

.sm-tree-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  font-size: 14px;
  line-height: 1;
}

.sm-tree-icon.mit-icon {
  width: 14px;
  height: 14px;
  fill: currentColor;
  display: inline-block;
  vertical-align: middle;
}

.sm-tree-name {
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
  font-size: 13px;
}

.sm-tree-empty {
  font-size: 12px;
  color: var(--text-tertiary, #64748b);
  text-align: center;
  padding: 24px 12px;
}

/* ── 源码面板 ──────────────────────────── */
.sm-node-detail {
  padding: 8px 12px;
  background: #f59e0b0c;
  border-bottom: 1px solid #f59e0b22;
  flex-shrink: 0;
}

.sm-node-name {
  font-size: 13px;
  font-weight: 600;
  color: #f59e0b;
  font-family: 'Consolas', monospace;
}

.sm-node-file {
  font-size: 10px;
  color: var(--text-tertiary, #64748b);
  font-family: 'Consolas', monospace;
  margin-top: 2px;
}

.sm-node-desc {
  font-size: 11px;
  color: var(--text-secondary, #94a3b8);
  margin-top: 4px;
  line-height: 1.4;
}

.sm-source-body {
  background: #0d1117;
  position: relative;
  overflow: hidden;
}

.sm-monaco-container {
  width: 100%;
  height: 100%;
}

.sm-source-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0d111799;
  z-index: 10;
  font-size: 12px;
  color: var(--text-tertiary, #64748b);
  pointer-events: none;
}

.sm-source-placeholder {
  background: #0d1117;
  pointer-events: none;
}

/* ── 通用 ─────────────────────────────── */
.sm-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 60px;
  color: var(--text-tertiary, #64748b);
  font-size: 12px;
  text-align: center;
  padding: 12px;
}

.sm-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  background: var(--bg-page, #0f172a);
  border: 1px solid var(--border-color, #334155);
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-secondary, #94a3b8);
  margin-left: 4px;
}

.sm-badge-amber {
  background: #f59e0b15;
  border-color: #f59e0b40;
  color: #f59e0b;
}

/* ── 加载动画 ────────────────────────── */
.sm-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid #ffffff40;
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.sm-spinner-lg {
  width: 32px;
  height: 32px;
  border-width: 3px;
  border-color: #f59e0b20;
  border-top-color: #f59e0b;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── VueFlow 深度覆盖 ─────────────────── */
:deep(.vue-flow__background) {
  background: #0f172a;
}

:deep(.vue-flow__controls) {
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 8px;
  box-shadow: none;
}

:deep(.vue-flow__controls-button) {
  background: transparent;
  border: none;
  color: #94a3b8;
}

:deep(.vue-flow__controls-button:hover) {
  background: #0f172a;
  color: #e2e8f0;
}

:deep(.vue-flow__minimap) {
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 6px;
}

:deep(.vue-flow__node) {
  transition: box-shadow 0.15s;
}

:deep(.vue-flow__node:hover) {
  box-shadow: 0 0 0 2px #f59e0b80;
}

:deep(.vue-flow__node.selected) {
  box-shadow: 0 0 0 2px #f59e0b;
}

/* ── 布局优化按钮 ─────────────────────────── */
.sm-layout-btn-wrap {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 10;
}

.sm-layout-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  background: var(--bg-container, #1e293b);
  border: 1px solid var(--border-color, #334155);
  border-radius: 6px;
  color: var(--text-secondary, #94a3b8);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.sm-layout-btn:hover:not(:disabled) {
  color: #f59e0b;
  border-color: #f59e0b50;
  background: #f59e0b08;
}

.sm-layout-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* ── 自定义节点内容 ──────────────────── */
.sm-fn-inner {
  display: flex;
  flex-direction: column;
  gap: 3px;
  text-align: center;
  overflow: hidden;
  width: 100%;
  min-width: 0;
}

.sm-fn-label {
  font-size: 12px;
  font-weight: 600;
  color: #e2e8f0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.sm-fn-desc {
  font-size: 10px;
  color: #94a3b8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
}

/* ── 面板 Tab 头 ─────────────────────── */
.sm-panel-header--tabs {
  padding: 0;
  gap: 0;
  height: 32px;
  min-height: 32px;
}

.sm-tab-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  height: 100%;
  padding: 0 8px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-tertiary, #64748b);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  transition: all 0.15s;
  white-space: nowrap;
}

.sm-tab-btn:hover {
  color: var(--text-secondary, #94a3b8);
  background: var(--bg-hover);
}

.sm-tab-btn.active {
  color: #f59e0b;
  border-bottom-color: #f59e0b;
}

/* ── 大纲视图 ─────────────────────────── */
.sm-outline-body {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px 0;
}

.sm-outline-group {
  margin-bottom: 2px;
}

.sm-outline-group-header {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px 3px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  position: sticky;
  top: 0;
  background: var(--bg-container, #1e293b);
  z-index: 1;
}

.sm-outline-node {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 8px 0 16px;
  cursor: pointer;
  transition: background 0.1s;
  overflow: hidden;
}

.sm-outline-node:hover {
  background: var(--bg-hover);
}

.sm-outline-node--active {
  background: rgba(59, 130, 246, 0.12);
}

.sm-outline-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.sm-outline-label {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary, #e2e8f0);
  font-family: 'Consolas', monospace;
  white-space: nowrap;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sm-outline-desc {
  flex: 1;
  font-size: 10px;
  color: var(--text-tertiary, #64748b);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>

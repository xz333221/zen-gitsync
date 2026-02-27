<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, provide, inject, defineComponent, h, markRaw } from 'vue'
import type { PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { VueFlow, useVueFlow } from '@vue-flow/core'
import type { EdgeChange, NodeTypesObject } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { Delete, VideoPlay, Plus, Select, Grid, CopyDocument } from '@element-plus/icons-vue'
import dagre from 'dagre'
import { useConfigStore, type OrchestrationStep } from '@stores/configStore'
import CommonDialog from '@components/CommonDialog.vue'
import IconButton from '@components/IconButton.vue'
import BaseNode from './nodes/BaseNode.vue'
import CommandNode from './nodes/CommandNode.vue'
import WaitNode from './nodes/WaitNode.vue'
import VersionNode from './nodes/VersionNode.vue'
import ConfirmNode from './nodes/ConfirmNode.vue'
import CodeNode from './nodes/CodeNode.vue'
import ConditionNode from './nodes/ConditionNode.vue'
import UserInputNode from './nodes/UserInputNode.vue'
import NodeContextMenu from './nodes/NodeContextMenu.vue'
import NodeConfigPanel from './NodeConfigPanel.vue'
import { $t } from '@/lang/static'

// 导入样式
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'

// 定义节点数据类型
export interface FlowNodeData {
  id: string
  type: 'start' | 'command' | 'wait' | 'version' | 'confirm' | 'code' | 'condition' | 'user_input'
  label: string
  config?: OrchestrationStep
  outputs?: Record<string, any>
  enabled?: boolean
  selected?: boolean  // 节点是否选中
}

export interface FlowNode {
  id: string
  type: string
  position: { x: number; y: number }
  data: FlowNodeData
}

export interface FlowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

 export type FlowData = {
   nodes: FlowNode[]
   edges: FlowEdge[]
   viewport?: { x: number; y: number; zoom: number }
 }

type FlowNodeActions = {
  deleteNode: (nodeId: string) => void
  executeFromNode: (nodeId: string) => void
  executeSingleNode: (nodeId: string) => void
}

const FLOW_NODE_ACTIONS_KEY: unique symbol = Symbol('FLOW_NODE_ACTIONS')

function getNodeIcon(nodeType?: string): string {
  switch (nodeType) {
    case 'command':
      return '📋'
    case 'wait':
      return '⏰'
    case 'version':
      return '📦'
    case 'confirm':
      return '✋'
    case 'code':
      return '🧩'
    case 'start':
      return '🚀'
    case 'condition':
      return '🔀'
    case 'user_input':
      return '⌨️'
    default:
      return ''
  }
}

function createWrappedNode(Inner: any) {
  return defineComponent({
    name: 'FlowWrappedNode',
    props: {
      id: { type: String, required: true },
      data: { type: Object as PropType<FlowNodeData>, required: true }
    },
    setup(props) {
      const actions = inject<FlowNodeActions | null>(FLOW_NODE_ACTIONS_KEY, null)

      const conditionHandleIds = computed(() => {
        const cfg: any = props.data?.config
        const branches = Array.isArray(cfg?.conditionBranches) ? cfg.conditionBranches : []
        const sorted = [...branches].sort((a: any, b: any) => {
          const aIsDefault = a?.handleId === 'default' || a?.isDefault
          const bIsDefault = b?.handleId === 'default' || b?.isDefault
          if (aIsDefault && !bIsDefault) return 1
          if (!aIsDefault && bIsDefault) return -1
          return Number(a?.priority ?? 0) - Number(b?.priority ?? 0)
        })
        const ids = sorted.map((b: any) => String(b?.handleId || '').trim()).filter((s: string) => Boolean(s))
        if (!ids.includes('default')) ids.push('default')
        return ids.length ? ids : ['default']
      })

      return () =>
        h(
          NodeContextMenu,
          {
            nodeId: props.id,
            onExecuteFromNode: (nodeId: string) => actions?.executeFromNode(nodeId),
            onExecuteSingleNode: (nodeId: string) => actions?.executeSingleNode(nodeId)
          },
          {
            default: () =>
              h(
                BaseNode,
                {
                  id: props.id,
                  nodeId: props.id,
                  nodeType: props.data?.type,
                  title: props.data?.label,
                  icon: getNodeIcon(props.data?.type),
                  enabled: props.data?.enabled ?? true,
                  selected: props.data?.selected ?? false,
                  sourceHandleIds: props.data?.type === 'condition' ? conditionHandleIds.value : undefined,
                  onDelete: (nodeId: string) => actions?.deleteNode(nodeId)
                },
                {
                  default: () =>
                    h(Inner, {
                      data: props.data,
                      id: props.id
                    })
                }
              )
          }
        )
    }
  })
}

const StartNodeRenderer = defineComponent({
  name: 'FlowStartNodeRenderer',
  props: {
    id: { type: String, required: true },
    data: { type: Object as PropType<FlowNodeData>, required: true }
  },
  setup(props) {
    return () =>
      h(
        BaseNode,
        {
          id: props.id,
          nodeId: props.id,
          nodeType: 'start',
          title: $t('@FLOWNODE:开始'),
          icon: getNodeIcon('start'),
          enabled: props.data?.enabled,
          selected: props.data?.selected,
          deletable: false
        },
        {}
      )
  }
})

const nodeTypes: NodeTypesObject = {
  start: markRaw(StartNodeRenderer),
  command: markRaw(createWrappedNode(CommandNode)),
  wait: markRaw(createWrappedNode(WaitNode)),
  version: markRaw(createWrappedNode(VersionNode)),
  confirm: markRaw(createWrappedNode(ConfirmNode)),
  code: markRaw(createWrappedNode(CodeNode)),
  condition: markRaw(createWrappedNode(ConditionNode)),
  user_input: markRaw(createWrappedNode(UserInputNode))
} as unknown as NodeTypesObject

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'execute-flow', payload: { flowData: FlowData; startNodeId?: string; isSingleExecution?: boolean; orchestrationMeta?: { id?: string; name?: string } }): void
  (e: 'open-command-manager'): void
}>()

const { t } = useI18n()
const configStore = useConfigStore()

// 弹窗控制
const dialogVisible = computed({
  get: () => props.visible,
  set: (value) => emit('update:visible', value)
})

// Vue Flow 实例
const {
  onConnect,
  addEdges,
  getViewport,
  setViewport,
  onNodeDragStart,
  onNodeDragStop,
  getSelectedEdges,
  updateNodeInternals
} = useVueFlow()

// 流程数据
const nodes = ref<FlowNode[]>([])
const edges = ref<FlowEdge[]>([])

// 编排信息
const orchestrationName = ref('')
const orchestrationDescription = ref('')
const editingOrchestrationId = ref<string | null>(null)

// 节点配置面板
const showConfigPanel = ref(false)
const selectedNode = ref<FlowNode | null>(null)

// 自动保存定时器
let autoSaveTimer: number | null = null

// 已保存的编排列表
const orchestrations = computed(() => configStore.orchestrations || [])
const selectedOrchestrationId = ref<string | null>(null)

// 节点 ID 计数器
let nodeIdCounter = 1

// 生成节点ID
function generateNodeId(type: string): string {
  return `${type}-${Date.now()}-${nodeIdCounter++}`
}

function escapeRegExp(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function generateCopyName(originalName: string) {
  const base = String(originalName || '').trim() || t('@ORCH:未命名')
  const existingNames = new Set(
    (Array.isArray(orchestrations.value) ? orchestrations.value : []).map((o: any) => String(o?.name || '').trim())
  )

  const first = `${base}（复制）`
  if (!existingNames.has(first)) return first

  let i = 2
  while (i < 1000) {
    const name = `${base}（复制${i}）`
    if (!existingNames.has(name)) return name
    i += 1
  }
  return `${base}（复制${Date.now()}）`
}

async function duplicateOrchestration(orchestration: any) {
  try {
    const newName = generateCopyName(orchestration?.name)
    const payload = {
      name: newName,
      description: orchestration?.description || '',
      flowData: orchestration?.flowData ? JSON.parse(JSON.stringify(orchestration.flowData)) : null
    }

    const created = await configStore.saveOrchestration(payload)
    if (created && typeof created === 'object' && 'id' in created) {
      selectedOrchestrationId.value = (created as any).id
      editingOrchestrationId.value = (created as any).id
      loadOrchestration(created)
      ElMessage.success(t('@ORCH:已复制'))
    }
  } catch (error: any) {
    ElMessage.error(`${t('@ORCH:错误')}: ${error?.message || error}`)
  }
}

function getExecutableNodes() {
  return nodes.value.filter((n: FlowNode) => n.type !== 'start' && n.data?.config)
}

function estimateNodeSize(type: 'command' | 'wait' | 'version' | 'confirm' | 'code' | 'condition' | 'user_input') {
  if (type === 'version') return { w: 250, h: 120 }
  if (type === 'wait' || type === 'confirm' || type === 'user_input') return { w: 200, h: 120 }
  if (type === 'condition') return { w: 260, h: 160 }
  return { w: 220, h: 120 }
}

function getViewportCenterPosition(type: 'command' | 'wait' | 'version' | 'confirm' | 'code' | 'condition' | 'user_input') {
  const viewport = getViewport()
  const el = document.querySelector('.vue-flow-container') as HTMLElement | null
  const rect = el?.getBoundingClientRect()
  const centerX = rect ? rect.width / 2 : 500
  const centerY = rect ? rect.height / 2 : 300

  const zoom = viewport.zoom || 1
  const flowX = (centerX - viewport.x) / zoom
  const flowY = (centerY - viewport.y) / zoom

  const { w, h } = estimateNodeSize(type)
  return { x: flowX - w / 2, y: flowY - h / 2 }
}

function generateUniqueNodeLabel(type: string, baseLabel: string): string {
  const sameTypeNodes = nodes.value.filter((n) => n.type === type)
  const labels = sameTypeNodes
    .map((n) => String((n as any)?.data?.label || '').trim())
    .filter((s) => Boolean(s))

  const base = String(baseLabel || '').trim()
  if (!base) return base

  // 规则：base、base1、base2...
  const re = new RegExp(`^${escapeRegExp(base)}(\\d+)?$`)
  let max = -1
  for (const l of labels) {
    const m = l.match(re)
    if (!m) continue
    const n = m[1] ? Number(m[1]) : 0
    if (Number.isFinite(n)) max = Math.max(max, n)
  }
  if (max < 0) return base
  return `${base}${max + 1}`
}

function sanitizeNodesForSave(inputNodes: any[]) {
  // 只保存业务需要的字段，避免把 VueFlow 的运行时内部字段（dimensions/handleBounds 等）持久化
  return inputNodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position,
    data: n.data
  }))
}

function sanitizeEdgesForSave(inputEdges: any[]) {
  // addEdges 可能会注入 type/animated/selected 等运行时字段；这里保持最小字段集
  return inputEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle
  }))
}

async function refreshNodeInternals(nodeIds?: string[]) {
  // 选中态/弹窗显示/加载数据后，节点 DOM 尺寸与 handleBounds 可能变化，需主动触发重新测量
  await nextTick()
  const ids = nodeIds && nodeIds.length ? nodeIds : nodes.value.map((n) => n.id)
  // requestAnimationFrame 可避免在布局尚未稳定时测量到异常尺寸
  requestAnimationFrame(() => {
    updateNodeInternals(ids)
  })
}

// 调度自动保存（带简单防抖）
function scheduleAutoSave() {
  // 仅在已有已保存的编排时自动保存，避免新建但还没命名/首存就频繁请求
  if (!editingOrchestrationId.value) return
  if (!orchestrationName.value.trim()) return

  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer)
  }

  autoSaveTimer = window.setTimeout(() => {
    // 这里复用现有保存逻辑，不修改其内部行为
    void saveOrchestration()
  }, 1000)
}

// 初始化流程（添加起始节点）
function initializeFlow() {
  nodes.value = [
    {
      id: 'start-node',
      type: 'start',
      position: { x: 50, y: 200 },
      data: {
        id: 'start-node',
        type: 'start',
        label: t('@FLOWNODE:开始'),
        enabled: true
      }
    }
  ]
  edges.value = []
  nodeIdCounter = 1
}

// 添加节点
function addNode(type: 'command' | 'wait' | 'version' | 'confirm' | 'code' | 'condition' | 'user_input') {
  const id = generateNodeId(type)
  const labelMap = {
    command: t('@FLOWNODE:命令节点'),
    wait: t('@FLOWNODE:等待节点'),
    version: t('@FLOWNODE:版本管理'),
    confirm: t('@FLOWNODE:用户确认'),
    code: t('@FLOWNODE:代码节点'),
    condition: t('@FLOWNODE:条件'),
    user_input: t('@FLOWNODE:用户输入')
  }
  const baseLabel = labelMap[type]
  const uniqueLabel = generateUniqueNodeLabel(type, baseLabel)
  const centerPos = getViewportCenterPosition(type)
  const newNode: FlowNode = {
    id,
    type,
    position: {
      x: centerPos.x,
      y: centerPos.y
    },
    data: {
      id,
      type,
      label: uniqueLabel,
      enabled: true,
      config: type === 'confirm'
        ? { id, type: 'confirm' }
        : type === 'condition'
          ? {
              id,
              type: 'condition',
              conditionBranches: [
                {
                  id: `branch-${Date.now()}`,
                  name: $t('@COND:默认分支'),
                  handleId: 'default',
                  priority: 999,
                  combine: 'all',
                  rules: [],
                  isDefault: true
                }
              ]
            }
          : type === 'user_input'
            ? {
                id,
                type: 'user_input',
                userInputParams: []
              }
          : undefined
    }
  }
  
  nodes.value.push(newNode)
  
  // 新增节点时默认仅选中，不自动打开配置面板（避免打断添加流程）
  nodes.value.forEach(n => {
    if (n.data) n.data.selected = false
  })
  if (newNode.data) newNode.data.selected = true
  selectedNode.value = newNode
  showConfigPanel.value = false
  
  ElMessage.success(`${t('@FLOWNODE:已添加')}${newNode.data.label}`)

  // 节点结构变化后自动保存
  scheduleAutoSave()
}

// 连接节点
onConnect((params) => {
  addEdges([params])
  // 新连接也会影响执行顺序，需自动保存
  scheduleAutoSave()
})

// 节点拖拽开始时设置选中状态
onNodeDragStart((event) => {
  // 清除所有节点的选中状态
  nodes.value.forEach(n => {
    if (n.data) n.data.selected = false
  })
  
  // 设置拖拽的节点为选中
  const node = nodes.value.find(n => n.id === event.node.id)
  if (node && node.data) {
    node.data.selected = true
  }
})

// 节点拖拽结束时也需要自动保存（位置变化会影响保存的 flowData）
onNodeDragStop(() => {
  scheduleAutoSave()
})

// 节点点击事件
function onNodeClick(event: any) {
  // 清除所有节点的选中状态
  nodes.value.forEach(n => {
    if (n.data) n.data.selected = false
  })
  
  const node = nodes.value.find(n => n.id === event.node.id)
  if (node) {
    // 设置当前节点为选中
    node.data.selected = true
    
    if (node.type !== 'start') {
      selectedNode.value = node
      showConfigPanel.value = true
    }
  }

  // 选中态会影响节点样式（部分节点包含 transform），需要刷新 internals 以更新 handle 命中区域
  void refreshNodeInternals([event.node.id])
}

// 画布点击事件（点击空白处清除选中）
function onPaneClick() {
  nodes.value.forEach(n => {
    if (n.data) n.data.selected = false
  })

  // 取消选中也会触发布局样式变化，刷新 internals
  void refreshNodeInternals()
}

// 更新节点配置
function updateNodeConfig(nodeId: string, config: OrchestrationStep) {
  const node = nodes.value.find(n => n.id === nodeId)
  if (node) {
    node.data.config = config
    node.data.label = getNodeLabel(config)
    // 节点配置更新后自动保存
    scheduleAutoSave()
  }
}

// 获取节点显示标签
function getNodeLabel(step: OrchestrationStep): string {
  if (step.displayName && String(step.displayName).trim()) {
    return String(step.displayName).trim()
  }
  if (step.type === 'command') {
    return step.commandName || t('@FLOWNODE:未知命令')
  } else if (step.type === 'wait') {
    return t('@FLOWNODE:等待 {seconds} 秒', { seconds: step.waitSeconds })
  } else if (step.type === 'version') {
    if (step.versionTarget === 'dependency') {
      return t('@FLOWNODE:修改依赖: {name}', { name: step.dependencyName })
    } else {
      return t('@FLOWNODE:版本号 +1 ({bump})', { bump: step.versionBump })
    }
  } else if (step.type === 'confirm') {
    return t('@FLOWNODE:用户确认')
  } else if (step.type === 'user_input') {
    return t('@FLOWNODE:用户输入')
  } else if (step.type === 'code') {
    return t('@FLOWNODE:代码节点')
  }
  return t('@FLOWNODE:未配置')
}

// 处理节点删除（从节点上的删除按钮触发）
function handleNodeDelete(nodeId: string) {
  console.log(`nodeId ==>`, nodeId)
  if (nodeId === 'start-node') {
    ElMessage.warning(t('@FLOWNODE:不能删除起始节点'))
    return
  }
  console.log(`nodes ==>`, nodes)
  // 删除节点
  nodes.value = nodes.value.filter((n: FlowNode) => n.id !== nodeId)
  
  // 删除相关的边
  edges.value = edges.value.filter((e: any) => e.source !== nodeId && e.target !== nodeId)
  
  // 如果删除的是当前选中的节点，清除选中状态
  if (selectedNode.value?.id === nodeId) {
    selectedNode.value = null
    showConfigPanel.value = false
  }
  
  ElMessage.success(t('@FLOWNODE:节点已删除'))

  // 结构变更后自动保存
  scheduleAutoSave()
}

// 处理边的变化（包括删除）
function onEdgesChange(changes: EdgeChange[]) {
  for (const change of changes) {
    if (change.type === 'remove') {
      edges.value = edges.value.filter(e => e.id !== change.id)
    }
  }
  scheduleAutoSave()
}

// 键盘删除选中的边
function handleKeyDown(event: KeyboardEvent) {
  // 按Delete或Backspace键删除选中的边
  if (event.key === 'Delete' || event.key === 'Backspace') {
    const selectedEdges = getSelectedEdges.value
    if (selectedEdges && selectedEdges.length > 0) {
      // 删除所有选中的边
      const edgeIdsToRemove = selectedEdges.map(edge => edge.id)
      edges.value = edges.value.filter(e => !edgeIdsToRemove.includes(e.id))
      scheduleAutoSave()
      event.preventDefault() // 阻止默认行为
    }
  }
}

// 清空流程
function clearFlow() {
  ElMessageBox.confirm('确定要清空整个流程吗？', '确认清空', {
    confirmButtonText: '清空',
    cancelButtonText: '取消',
    type: 'warning'
  }).then(() => {
    initializeFlow()
    ElMessage.success('流程已清空')
    // 清空后也更新已保存编排
    scheduleAutoSave()
  }).catch(() => {})
}

// 优化布局 - 使用 dagre 自动排列节点
async function optimizeLayout() {
  if (nodes.value.length <= 1) {
    ElMessage.info('节点太少，无需优化布局')
    return
  }

  // 先让 VueFlow 完成节点尺寸测量（dimensions/handleBounds），否则只能使用预估宽高
  await refreshNodeInternals()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  
  // 创建 dagre 图
  const dagreGraph = new dagre.graphlib.Graph()
  dagreGraph.setDefaultEdgeLabel(() => ({}))
  
  // 设置图的布局方向和间距
  dagreGraph.setGraph({
    rankdir: 'LR', // 从左到右布局（Left to Right）
    nodesep: 80,   // 同层节点间距
    ranksep: 80,  // 层级间距
    marginx: 50,
    marginy: 50
  })
  
  // 添加节点到 dagre 图（需要指定节点宽高）
  nodes.value.forEach((node: FlowNode) => {
    // 根据节点类型设置不同的尺寸
    let width = 220
    let height = 100
    
    if (node.type === 'start') {
      width = 100
      height = 100
    } else if (node.type === 'wait' || node.type === 'confirm') {
      width = 200
      height = 120
    } else if (node.type === 'version') {
      width = 250
      height = 120
    }

    // 优先使用实际渲染后的 DOM 尺寸（offsetWidth/offsetHeight 不受 zoom transform 影响）
    const nodeEl = document.querySelector(
      `.vue-flow__node[data-id="${node.id}"]`
    ) as HTMLElement | null
    if (nodeEl) {
      const measuredW = nodeEl.offsetWidth
      const measuredH = nodeEl.offsetHeight
      if (measuredW > 0 && measuredH > 0) {
        width = measuredW
        height = measuredH
      }
    }
    
    dagreGraph.setNode(node.id, { width, height })
  })
  
  // 添加边到 dagre 图
  edges.value.forEach((edge: any) => {
    dagreGraph.setEdge(edge.source, edge.target)
  })
  
  // 运行 dagre 布局算法
  dagre.layout(dagreGraph)
  
  // 将计算后的位置应用到节点
  nodes.value.forEach((node: FlowNode) => {
    const nodeWithPosition = dagreGraph.node(node.id)
    if (nodeWithPosition) {
      // dagre 返回的是节点中心点坐标，需要转换为左上角坐标
      node.position = {
        x: nodeWithPosition.x - nodeWithPosition.width / 2,
        y: nodeWithPosition.y - nodeWithPosition.height / 2
      }
    }
  })
  
  ElMessage.success('布局优化完成（dagre）')

  // 只调整布局也会影响保存的 flowData，因此需要自动保存
  scheduleAutoSave()
}

// 保存编排
async function saveOrchestration() {
  if (!orchestrationName.value.trim()) {
    ElMessage.warning('请输入编排名称')
    return
  }
  
  // 检查是否有未配置的节点
  const unconfiguredNodes = nodes.value.filter(
    (n: FlowNode) => n.type !== 'start' && !n.data.config
  )
  if (unconfiguredNodes.length > 0) {
    const nodeLabels = unconfiguredNodes.map((n: FlowNode) => n.data.label).join('、')
    ElMessage.warning(`以下节点还未配置：${nodeLabels}。未配置的节点不会被保存。`)
  }
  
  const executableNodes = getExecutableNodes()
  if (executableNodes.length === 0) {
    ElMessage.warning('请至少添加一个执行步骤')
    return
  }
  
  // 获取当前画布视图状态
  const viewport = getViewport()
  
  const orchestration = {
    name: orchestrationName.value.trim(),
    description: orchestrationDescription.value.trim(),
    // 保存流程图数据以便后续编辑
    flowData: {
      nodes: sanitizeNodesForSave(nodes.value as any),
      edges: sanitizeEdgesForSave(edges.value as any),
      viewport: {
        x: viewport.x,
        y: viewport.y,
        zoom: viewport.zoom
      }
    }
  }
  
  if (editingOrchestrationId.value) {
    await configStore.updateOrchestration(editingOrchestrationId.value, orchestration)
  } else {
    const newOrch = await configStore.saveOrchestration(orchestration) as any
    ElMessage.success('编排已保存')
    if (newOrch && typeof newOrch === 'object' && 'id' in newOrch) {
      selectedOrchestrationId.value = newOrch.id
      editingOrchestrationId.value = newOrch.id
    }
  }
}

// 执行当前流程
function executeCurrentFlow() {
  if (getExecutableNodes().length === 0) {
    ElMessage.warning('请至少添加一个执行步骤')
    return
  }
  
  // 关闭弹窗后执行
  dialogVisible.value = false
  const viewport = getViewport()
  const startNode = nodes.value.find((n) => n.type === 'start')
  emit('execute-flow', {
    flowData: {
      nodes: JSON.parse(JSON.stringify(nodes.value)),
      edges: JSON.parse(JSON.stringify(edges.value)),
      viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
    },
    startNodeId: startNode?.id,
    isSingleExecution: false,
    orchestrationMeta: { id: editingOrchestrationId.value || undefined, name: orchestrationName.value || undefined }
  })
  return
}

// 从某个节点开始执行
function executeFromNode(nodeId: string) {
  const node = nodes.value.find(n => n.id === nodeId)
  if (!node || node.type === 'start' || !node.data.config) {
    ElMessage.warning('该节点无法执行')
    return
  }
  
  // 关闭弹窗后执行
  dialogVisible.value = false
  const viewport = getViewport()
  emit('execute-flow', {
    flowData: {
      nodes: JSON.parse(JSON.stringify(nodes.value)),
      edges: JSON.parse(JSON.stringify(edges.value)),
      viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
    },
    startNodeId: nodeId,
    isSingleExecution: false,
    orchestrationMeta: { id: editingOrchestrationId.value || undefined, name: orchestrationName.value || undefined }
  })
  return
}

// 只执行某个节点
function executeSingleNode(nodeId: string) {
  const node = nodes.value.find(n => n.id === nodeId)
  
  if (!node || node.type === 'start' || !node.data.config) {
    ElMessage.warning('该节点无法执行')
    return
  }
  
  // 关闭弹窗后执行
  dialogVisible.value = false
  const viewport = getViewport()
  emit('execute-flow', {
    flowData: {
      nodes: JSON.parse(JSON.stringify(nodes.value)),
      edges: JSON.parse(JSON.stringify(edges.value)),
      viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
    },
    startNodeId: nodeId,
    isSingleExecution: true,
    orchestrationMeta: { id: editingOrchestrationId.value || undefined, name: orchestrationName.value || undefined }
  })
  return
}

provide<FlowNodeActions>(FLOW_NODE_ACTIONS_KEY, {
  deleteNode: handleNodeDelete,
  executeFromNode,
  executeSingleNode
})

// 加载编排
function loadOrchestration(orchestration: any) {
  selectedOrchestrationId.value = orchestration.id
  editingOrchestrationId.value = orchestration.id
  orchestrationName.value = orchestration.name
  orchestrationDescription.value = orchestration.description || ''
  
  // 如果有保存的流程图数据，直接加载
  if (orchestration.flowData) {
    nodes.value = JSON.parse(JSON.stringify(orchestration.flowData.nodes))
    edges.value = JSON.parse(JSON.stringify(orchestration.flowData.edges))

    // 加载后强制刷新 internals，确保 dimensions/handleBounds 来自当前 DOM 实际尺寸
    void refreshNodeInternals()
    
    // 恢复画布视图状态
    if (orchestration.flowData.viewport) {
      setTimeout(() => {
        setViewport(orchestration.flowData.viewport)
      }, 100)
    }
  } else {
    initializeFlow()
  }
}

// 创建新编排
function createNewOrchestration() {
  selectedOrchestrationId.value = null
  editingOrchestrationId.value = null
  orchestrationName.value = ''
  orchestrationDescription.value = ''
  initializeFlow()
}

// 删除编排
async function deleteOrchestration(orchestration: any) {
  try {
    await ElMessageBox.confirm(
      `确定要删除编排 "${orchestration.name}" 吗？`,
      '确认删除',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    
    await configStore.deleteOrchestration(orchestration.id)
    
    if (editingOrchestrationId.value === orchestration.id) {
      createNewOrchestration()
    }
  } catch (error: any) {
    if (error !== 'cancel') {
      ElMessage.error(`删除编排失败: ${error.message || error}`)
    }
  }
}

// 执行编排
function executeOrchestration(orchestration: any) {
  // 关闭弹窗后执行
  dialogVisible.value = false
  if (orchestration?.flowData) {
    const startNode = Array.isArray(orchestration.flowData.nodes)
      ? orchestration.flowData.nodes.find((n: any) => n?.type === 'start')
      : undefined
    emit('execute-flow', {
      flowData: orchestration.flowData,
      startNodeId: startNode?.id,
      isSingleExecution: false,
      orchestrationMeta: { id: orchestration?.id, name: orchestration?.name }
    })
    return
  }
  ElMessage.warning('该编排缺少流程数据，无法执行')
}

// 初始化
onMounted(() => {
  initializeFlow()
  // 添加键盘事件监听以删除选中的边
  window.addEventListener('keydown', handleKeyDown)

  // 首次渲染后刷新 internals，避免初次测量尺寸不稳定
  void refreshNodeInternals()
})

// 清理事件监听
onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown)
})
</script>

<template>
  <CommonDialog
    v-model="dialogVisible"
    :title="t('@ORCH:可视化编排工作台')"
    :close-on-click-modal="false"
    :append-to-body="true"
    size="fullscreen"
    type="flex"
    heightMode="fixed"
    custom-class="flow-orchestration-dialog"
  >
    <div class="flow-workspace-container">
      <!-- 左侧：编排列表 -->
      <div class="left-sidebar">
        <div class="sidebar-header">
          <h3>{{ t('@ORCH:已保存的编排') }}</h3>
          <IconButton
            :tooltip="t('@ORCH:新建编排')"
            size="small"
            hover-color="var(--color-primary)"
            @click="createNewOrchestration"
          >
            <el-icon><Plus /></el-icon>
          </IconButton>
        </div>
        
        <div class="orchestration-list">
          <el-empty 
            v-if="orchestrations.length === 0" 
            :description="t('@ORCH:暂无编排')" 
            :image-size="80"
          />
          
          <div
            v-for="orchestration in orchestrations"
            :key="orchestration.id"
            class="orchestration-item"
            :class="{ 'active': selectedOrchestrationId === orchestration.id }"
            @click="loadOrchestration(orchestration)"
          >
            <div class="item-content">
              <h4>{{ orchestration.name }}</h4>
              <p v-if="orchestration.description" class="description">
                {{ orchestration.description }}
              </p>
              <div class="item-actions">
                <IconButton
                  :tooltip="t('@ORCH:执行')"
                  size="small"
                  hover-color="var(--color-primary)"
                  @click.stop="executeOrchestration(orchestration)"
                >
                  <el-icon><VideoPlay /></el-icon>
                </IconButton>
                <IconButton
                  :tooltip="t('@ORCH:复制')"
                  size="small"
                  hover-color="var(--color-primary)"
                  @click.stop="duplicateOrchestration(orchestration)"
                >
                  <el-icon><CopyDocument /></el-icon>
                </IconButton>
                <IconButton
                  :tooltip="t('@ORCH:删除')"
                  size="small"
                  hover-color="var(--color-danger)"
                  @click.stop="deleteOrchestration(orchestration)"
                >
                  <el-icon><Delete /></el-icon>
                </IconButton>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- 中间：流程画布 -->
      <div class="flow-canvas">
        <div class="canvas-header">
          <div class="flow-header-info">
            <el-input
              v-model="orchestrationName"
              :placeholder="t('@ORCH:编排名称（必填）')"
              size="large"
              style="width: 300px; margin-right: 10px;"
            />
            <el-input
              v-model="orchestrationDescription"
              :placeholder="t('@ORCH:编排描述（选填）')"
              size="large"
              style="width: 400px;"
            />
          </div>
          <div class="header-actions">
            <IconButton
              :tooltip="t('@ORCH:保存编排')"
              size="large"
              hover-color="var(--color-success)"
              @click="saveOrchestration"
            >
              <el-icon><Select /></el-icon>
            </IconButton>
            <IconButton
              tooltip="执行流程"
              size="large"
              hover-color="var(--color-primary)"
              @click="executeCurrentFlow"
            >
              <el-icon><VideoPlay /></el-icon>
            </IconButton>
            <IconButton
              tooltip="清空流程"
              size="large"
              hover-color="var(--color-danger)"
              @click="clearFlow"
            >
              <el-icon><Delete /></el-icon>
            </IconButton>
          </div>
        </div>
        
        <VueFlow
          v-model:nodes="nodes"
          v-model:edges="edges"
          class="vue-flow-container"
          :default-zoom="1"
          :min-zoom="0.2"
          :max-zoom="4"
          :node-types="nodeTypes"
          @node-click="onNodeClick"
          @pane-click="onPaneClick"
          @edges-change="onEdgesChange"
        >
          <Background pattern-color="#aaa" :gap="16" />
          <Controls :showInteractive="false">
            <button class="vue-flow__controls-button" @click="optimizeLayout" title="优化布局">
              <el-icon><Grid /></el-icon>
            </button>
          </Controls>
        </VueFlow>
      </div>
      
      <!-- 右侧：节点工具栏 -->
      <div class="right-sidebar">
        <div class="sidebar-header">
          <h3>{{ t('@ORCH:节点工具箱') }}</h3>
        </div>
        
        <div class="node-toolbox">
          <div class="tool-item" @click="addNode('command')">
            <div class="tool-icon command">📋</div>
            <div class="tool-label">{{ t('@ORCH:命令节点') }}</div>
            <div class="tool-desc">{{ t('@ORCH:执行自定义命令') }}</div>
          </div>
          
          <div class="tool-item" @click="addNode('wait')">
            <div class="tool-icon wait">⏰</div>
            <div class="tool-label">{{ t('@ORCH:等待节点') }}</div>
            <div class="tool-desc">{{ t('@ORCH:暂停指定时间') }}</div>
          </div>
          
          <div class="tool-item" @click="addNode('version')">
            <div class="tool-icon version">📦</div>
            <div class="tool-label">{{ t('@ORCH:版本管理') }}</div>
            <div class="tool-desc">{{ t('@ORCH:修改版本号或依赖') }}</div>
          </div>

          <div class="tool-item" @click="addNode('condition')">
            <div class="tool-icon condition">🔀</div>
            <div class="tool-label">{{ t('@FLOWNODE:条件') }}</div>
            <div class="tool-desc">{{ t('@ORCH:条件分支') }}</div>
          </div>

          <div class="tool-item" @click="addNode('code')">
            <div class="tool-icon code">🧩</div>
            <div class="tool-label">{{ t('@FLOWNODE:代码节点') }}</div>
            <div class="tool-desc">{{ t('@ORCH:执行自定义代码') }}</div>
          </div>
          
          <div class="tool-item" @click="addNode('confirm')">
            <div class="tool-icon confirm">✋</div>
            <div class="tool-label">{{ t('@ORCH:用户确认') }}</div>
            <div class="tool-desc">{{ t('@ORCH:等待用户确认后继续') }}</div>
          </div>

          <div class="tool-item" @click="addNode('user_input')">
            <div class="tool-icon confirm">⌨️</div>
            <div class="tool-label">{{ t('@FLOWNODE:用户输入') }}</div>
            <div class="tool-desc">{{ t('@UINPUT:执行到该节点暂停并等待输入') }}</div>
          </div>
        </div>
      </div>
    </div>
    
    <!-- 节点配置面板 -->
    <NodeConfigPanel
      v-model="showConfigPanel"
      :node="selectedNode"
      :all-nodes="nodes"
      :edges="edges"
      @update-config="updateNodeConfig"
      @open-command-manager="() => emit('open-command-manager')"
    />
  </CommonDialog>
</template>

<style scoped lang="scss">

// 统一定义所有节点连接点的基础样式
:deep(.flow-node-handle) {
  width: 12px !important;
  height: 12px !important;
  border: 2px solid var(--bg-page) !important;
  border-radius: 50% !important;
  cursor: crosshair !important;
}

.flow-workspace-container {
  display: flex;
  padding: var(--spacing-md);
  gap: var(--spacing-md);
  background: var(--bg-page);
  height: 100%;
}

.left-sidebar,
.right-sidebar {
  background: var(--bg-container);
  border-radius: var(--radius-lg);
  padding: var(--spacing-md);
  box-shadow: var(--shadow-md);
}

.left-sidebar {
  width: 200px;
  display: flex;
  flex-direction: column;
}

.right-sidebar {
  width: 160px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.sidebar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--spacing-md);
  padding-bottom: var(--spacing-sm);
  border-bottom: 2px solid var(--border-component);
  
  h3 {
    margin: 0;
    font-size: var(--font-size-md);
    font-weight: var(--font-weight-semibold);
  }
}

.orchestration-list {
  flex: 1;
  overflow-y: auto;
}

.orchestration-item {
  padding: var(--spacing-sm) var(--spacing-base);
  margin-bottom: var(--spacing-sm);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: var(--transition-all);
  border: 1px solid var(--border-component);
  
  &:hover {
    background: var(--bg-component-hover);
    border-color: var(--color-primary);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }
  
  &.active {
    background: rgba(64, 158, 255, 0.15);
    border-color: var(--color-primary);
    
    h4 {
      color: var(--color-primary);
    }
  }
  
  .item-content {
    h4 {
      margin: 0 0 var(--spacing-sm) 0;
      font-size: var(--font-size-base);
    }
    
    .description {
      margin: 0 0 var(--spacing-base) 0;
      font-size: var(--font-size-sm);
      color: var(--text-tertiary);
    }
    
    .item-actions {
      display: flex;
      gap: var(--spacing-sm);
    }
  }
}

.flow-canvas {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg-container);
  border-radius: var(--radius-lg);
  overflow: hidden;
  box-shadow: var(--shadow-md);
}

.canvas-header {
  padding: var(--spacing-lg);
  background: var(--bg-container);
  border-bottom: 1px solid var(--border-component);
  display: flex;
  justify-content: space-between;
  align-items: center;
  
  .flow-header-info {
    display: flex;
    align-items: center;
  }
  
  .header-actions {
    display: flex;
    gap: var(--spacing-md);
  }
}

.vue-flow-container {
  flex: 1;
  background: var(--bg-panel);
}

.node-toolbox {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  margin-bottom: 12px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.tool-item {
  padding: var(--spacing-sm) var(--spacing-base);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-component);
  cursor: pointer;
  transition: var(--transition-all);
  text-align: center;
  
  &:hover {
    border-color: var(--color-primary);
    background: rgba(64, 158, 255, 0.08);
    box-shadow: var(--shadow-hover);
    
    .tool-label {
      color: var(--color-primary);
    }
  }
  
  .tool-icon {
    font-size: 20px;
    margin-bottom: var(--spacing-sm);
  }
  
  .tool-label {
    font-weight: var(--font-weight-semibold);
    font-size: var(--font-size-base);
    margin-bottom: var(--spacing-sm);
  }
  
  .tool-desc {
    font-size: var(--font-size-sm);
    color: var(--text-tertiary);
  }
}

// 自定义控制按钮样式
:deep(.vue-flow__controls) {
  button.vue-flow__controls-button,
  .vue-flow__controls-button {
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-container) !important;
    border: 1px solid var(--border-component) !important;
    color: var(--text-primary) !important;
    box-shadow: var(--shadow-sm);
    
    svg {
      color: var(--text-primary);
      fill: var(--text-primary);
    }
    
    &:hover {
      background: var(--bg-component-hover) !important;
      border-color: var(--color-primary) !important;
      color: var(--color-primary) !important;
      
      svg {
        color: var(--color-primary);
        fill: var(--color-primary);
      }
    }
    
    .el-icon {
      font-size: 16px;
      color: var(--text-primary);
    }
  }
}

// 节点右键菜单样式
:deep(.flow-node-dropdown) {
  z-index: 9999 !important;
}

// 确保dropdown menu能够正确显示（非scoped样式）
</style>

<style lang="scss">
// 全局样式用于dropdown菜单
// .flow-node-dropdown {
//   z-index: 9999 !important;
  
//   .el-dropdown-menu {
//     background: var(--bg-container) !important;
//     border: 1px solid var(--border-component) !important;
//     box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.3) !important;
//     padding: 4px 0 !important;
//     min-width: 150px !important;
    
//     .el-dropdown-menu__item {
//       color: var(--text-primary) !important;
//       display: flex !important;
//       align-items: center !important;
//       padding: 8px 16px !important;
//       font-size: 14px !important;
      
//       &:hover {
//         background: var(--bg-component-hover) !important;
//         color: var(--color-primary) !important;
//       }
      
//       .el-icon {
//         margin-right: 8px !important;
//         color: currentColor !important;
//         font-size: 16px !important;
//       }
//     }
//   }
// }
</style>

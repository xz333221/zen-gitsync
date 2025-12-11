<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
// import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { VueFlow, useVueFlow } from '@vue-flow/core'
import type { EdgeChange } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { Delete, VideoPlay, Plus, Select, Rank } from '@element-plus/icons-vue'
import { useConfigStore, type OrchestrationStep } from '@stores/configStore'
import CommonDialog from '@components/CommonDialog.vue'
import IconButton from '@components/IconButton.vue'
import CommandNode from './nodes/CommandNode.vue'
import WaitNode from './nodes/WaitNode.vue'
import VersionNode from './nodes/VersionNode.vue'
import StartNode from './nodes/StartNode.vue'
import NodeConfigPanel from './NodeConfigPanel.vue'

// 导入样式
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'

// 定义节点数据类型
export interface FlowNodeData {
  id: string
  type: 'start' | 'command' | 'wait' | 'version'
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

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'execute-orchestration', steps: OrchestrationStep[], startIndex?: number, isSingleExecution?: boolean): void
}>()

// const { t } = useI18n()
const configStore = useConfigStore()

// 弹窗控制
const dialogVisible = computed({
  get: () => props.visible,
  set: (value) => emit('update:visible', value)
})

// Vue Flow 实例
const { onConnect, addEdges, getViewport, setViewport, onNodeDragStart, onNodeDragStop, getSelectedEdges } = useVueFlow()

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
        label: '开始',
        enabled: true
      }
    }
  ]
  edges.value = []
  nodeIdCounter = 1
}

// 添加节点
function addNode(type: 'command' | 'wait' | 'version') {
  const id = generateNodeId(type)
  const newNode: FlowNode = {
    id,
    type,
    position: {
      x: Math.random() * 600 + 250,
      y: Math.random() * 200 + 100
    },
    data: {
      id,
      type,
      label: type === 'command' ? '命令节点' : type === 'wait' ? '等待节点' : '版本管理',
      enabled: true,
      config: undefined
    }
  }
  
  nodes.value.push(newNode)
  
  // 自动打开配置面板
  selectedNode.value = newNode
  showConfigPanel.value = true
  
  ElMessage.success(`已添加${newNode.data.label}`)

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
}

// 画布点击事件（点击空白处清除选中）
function onPaneClick() {
  nodes.value.forEach(n => {
    if (n.data) n.data.selected = false
  })
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
  if (step.type === 'command') {
    return step.commandName || '未知命令'
  } else if (step.type === 'wait') {
    return `等待 ${step.waitSeconds} 秒`
  } else if (step.type === 'version') {
    if (step.versionTarget === 'dependency') {
      return `修改依赖: ${step.dependencyName}`
    } else {
      return `版本号 +1 (${step.versionBump})`
    }
  }
  return '未配置'
}

// 处理节点删除（从节点上的删除按钮触发）
function handleNodeDelete(nodeId: string) {
  if (nodeId === 'start-node') {
    ElMessage.warning('不能删除起始节点')
    return
  }
  
  // 删除节点
  nodes.value = nodes.value.filter((n: FlowNode) => n.id !== nodeId)
  
  // 删除相关的边
  edges.value = edges.value.filter((e: any) => e.source !== nodeId && e.target !== nodeId)
  
  // 如果删除的是当前选中的节点，清除选中状态
  if (selectedNode.value?.id === nodeId) {
    selectedNode.value = null
    showConfigPanel.value = false
  }
  
  ElMessage.success('节点已删除')

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

// 优化布局 - 自动排列节点
function optimizeLayout() {
  if (nodes.value.length <= 1) {
    ElMessage.info('节点太少，无需优化布局')
    return
  }
  
  // 构建邻接表（有向图）
  const adjacencyList = new Map<string, string[]>()
  const inDegree = new Map<string, number>()
  
  // 初始化所有节点
  nodes.value.forEach((node: FlowNode) => {
    adjacencyList.set(node.id, [])
    inDegree.set(node.id, 0)
  })
  
  // 构建图
  edges.value.forEach((edge: any) => {
    adjacencyList.get(edge.source)?.push(edge.target)
    inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1)
  })
  
  // 拓扑排序分层
  const levels: string[][] = []
  const visited = new Set<string>()
  
  // 找到入度为0的节点作为第一层
  let currentLevel = nodes.value
    .filter((node: FlowNode) => inDegree.get(node.id) === 0)
    .map((node: FlowNode) => node.id)
  
  while (currentLevel.length > 0) {
    levels.push([...currentLevel])
    currentLevel.forEach(id => visited.add(id))
    
    // 找下一层节点
    const nextLevel = new Set<string>()
    currentLevel.forEach(nodeId => {
      adjacencyList.get(nodeId)?.forEach(targetId => {
        // 检查该节点的所有前驱是否都已访问
        const allPredecessorsVisited = edges.value
          .filter((e: any) => e.target === targetId)
          .every((e: any) => visited.has(e.source))
        
        if (allPredecessorsVisited && !visited.has(targetId)) {
          nextLevel.add(targetId)
        }
      })
    })
    
    currentLevel = Array.from(nextLevel)
  }
  
  // 如果有节点没被访问到（可能有环或孤立节点），单独处理
  const unvisitedNodes = nodes.value
    .filter((node: FlowNode) => !visited.has(node.id))
    .map((node: FlowNode) => node.id)
  if (unvisitedNodes.length > 0) {
    levels.push(unvisitedNodes)
  }
  
  // 布局参数（适当加大间距，避免节点太挤）
  const levelGap = 220 // 层级间距（水平）
  const nodeGap = 120 // 同层节点间距（垂直）
  const startX = 50
  const startY = 150
  
  // 应用布局
  levels.forEach((level, levelIndex) => {
    const x = startX + levelIndex * levelGap
    const totalHeight = (level.length - 1) * nodeGap
    const startYForLevel = startY + (400 - totalHeight) / 2 // 居中对齐
    
    level.forEach((nodeId, nodeIndex) => {
      const node = nodes.value.find((n: FlowNode) => n.id === nodeId)
      if (node) {
        node.position = {
          x,
          y: Math.max(startY, startYForLevel + nodeIndex * nodeGap)
        }
      }
    })
  })
  
  ElMessage.success('布局优化完成')

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
  
  // 转换流程为步骤列表（通过拓扑排序）
  const steps = convertFlowToSteps()
  
  if (steps.length === 0) {
    ElMessage.warning('请至少添加一个执行步骤')
    return
  }
  
  // 获取当前画布视图状态
  const viewport = getViewport()
  
  const orchestration = {
    name: orchestrationName.value.trim(),
    description: orchestrationDescription.value.trim(),
    steps,
    // 保存流程图数据以便后续编辑
    flowData: {
      nodes: nodes.value,
      edges: edges.value,
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

// 将流程图转换为执行步骤（拓扑排序）
function convertFlowToSteps(): OrchestrationStep[] {
  const steps: OrchestrationStep[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()
  
  // 深度优先搜索进行拓扑排序
  function dfs(nodeId: string) {
    if (visited.has(nodeId)) return
    if (visiting.has(nodeId)) {
      ElMessage.warning('检测到循环依赖，请检查流程图')
      return
    }
    
    visiting.add(nodeId)
    
    const node = nodes.value.find(n => n.id === nodeId)
    if (!node) {
      visiting.delete(nodeId)
      return
    }
    
    // 添加步骤（排除起始节点），并记录nodeId用于定位
    if (node.type !== 'start' && node.data.config) {
      steps.push({
        ...node.data.config,
        nodeId: node.id,
        enabled: node.data.enabled ?? true
      })
    }
    
    visiting.delete(nodeId)
    visited.add(nodeId)
    
    // 递归处理该节点的所有后续节点
    const outgoingEdges = edges.value.filter(e => e.source === nodeId)
    for (const edge of outgoingEdges) {
      dfs(edge.target)
    }
  }
  
  // 从起始节点开始遍历
  const startNode = nodes.value.find(n => n.type === 'start')
  if (startNode) {
    const outgoingEdges = edges.value.filter(e => e.source === startNode.id)
    for (const edge of outgoingEdges) {
      dfs(edge.target)
    }
  }
  
  return steps
}

// 执行当前流程
function executeCurrentFlow() {
  const steps = convertFlowToSteps()
  
  if (steps.length === 0) {
    ElMessage.warning('请至少添加一个执行步骤')
    return
  }
  
  // 关闭弹窗后执行
  dialogVisible.value = false
  emit('execute-orchestration', steps)
}

// 从某个节点开始执行
function executeFromNode(nodeId: string) {
  const steps = convertFlowToSteps()
  
  if (steps.length === 0) {
    ElMessage.warning('请至少添加一个执行步骤')
    return
  }
  
  // 找到该节点在步骤列表中的索引
  const nodeIndex = steps.findIndex(step => step.nodeId === nodeId)
  
  if (nodeIndex === -1) {
    ElMessage.warning('未找到该节点对应的步骤')
    return
  }
  
  // 关闭弹窗后执行
  dialogVisible.value = false
  emit('execute-orchestration', steps, nodeIndex)
}

// 只执行某个节点
function executeSingleNode(nodeId: string) {
  const node = nodes.value.find(n => n.id === nodeId)
  
  if (!node || node.type === 'start' || !node.data.config) {
    ElMessage.warning('该节点无法执行')
    return
  }
  
  const step: OrchestrationStep = {
    ...node.data.config,
    nodeId: node.id,
    enabled: node.data.enabled ?? true
  }
  
  // 关闭弹窗后执行
  dialogVisible.value = false
  emit('execute-orchestration', [step], 0, true)
}

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
    
    // 恢复画布视图状态
    if (orchestration.flowData.viewport) {
      setTimeout(() => {
        setViewport(orchestration.flowData.viewport)
      }, 100)
    }
  } else {
    // 否则从步骤列表转换为流程图（线性布局）
    convertStepsToFlow(orchestration.steps)
  }
}

// 将步骤列表转换为流程图
function convertStepsToFlow(steps: OrchestrationStep[]) {
  initializeFlow()
  
  let yPos = 150
  let prevNodeId = 'start-node'
  
  steps.forEach((step) => {
    const id = generateNodeId(step.type)
    const node: FlowNode = {
      id,
      type: step.type,
      position: { x: 250, y: yPos },
      data: {
        id,
        type: step.type,
        label: getNodeLabel(step),
        config: step,
        enabled: step.enabled ?? true
      }
    }
    
    nodes.value.push(node)
    
    // 添加连接边
    edges.value.push({
      id: `edge-${prevNodeId}-${id}`,
      source: prevNodeId,
      target: id
    })
    
    prevNodeId = id
    yPos += 120
  })
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
    ElMessage.success('编排已删除')
    
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
  emit('execute-orchestration', orchestration.steps, 0)
}

// 初始化
onMounted(() => {
  initializeFlow()
  // 添加键盘事件监听以删除选中的边
  window.addEventListener('keydown', handleKeyDown)
})

// 清理事件监听
onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown)
})
</script>

<template>
  <CommonDialog
    v-model="dialogVisible"
    title="可视化编排工作台"
    :close-on-click-modal="false"
    :append-to-body="true"
    custom-class="flow-orchestration-dialog"
    width="95vw"
  >
    <div class="flow-workspace-container">
      <!-- 左侧：编排列表 -->
      <div class="left-sidebar">
        <div class="sidebar-header">
          <h3>已保存的编排</h3>
          <IconButton
            tooltip="新建编排"
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
            description="暂无编排" 
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
                  tooltip="执行"
                  size="small"
                  hover-color="var(--color-primary)"
                  @click.stop="executeOrchestration(orchestration)"
                >
                  <el-icon><VideoPlay /></el-icon>
                </IconButton>
                <IconButton
                  tooltip="删除"
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
          <div class="header-info">
            <el-input
              v-model="orchestrationName"
              placeholder="编排名称（必填）"
              size="large"
              style="width: 300px; margin-right: 10px;"
            />
            <el-input
              v-model="orchestrationDescription"
              placeholder="编排描述（选填）"
              size="large"
              style="width: 400px;"
            />
          </div>
          <div class="header-actions">
            <IconButton
              tooltip="保存编排"
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
          @node-click="onNodeClick"
          @pane-click="onPaneClick"
          @edges-change="onEdgesChange"
        >
          <Background pattern-color="#aaa" :gap="16" />
          <Controls>
            <button class="vue-flow__controls-button" @click="optimizeLayout" title="优化布局">
              <el-icon><Rank /></el-icon>
            </button>
          </Controls>
          
          <template #node-start="{ data }">
            <StartNode :data="data" />
          </template>
          
          <template #node-command="{ data, id }">
            <CommandNode 
              :data="data" 
              :id="id" 
              @delete="handleNodeDelete"
              @execute-from-node="executeFromNode"
              @execute-single-node="executeSingleNode"
            />
          </template>
          
          <template #node-wait="{ data, id }">
            <WaitNode 
              :data="data" 
              :id="id" 
              @delete="handleNodeDelete"
              @execute-from-node="executeFromNode"
              @execute-single-node="executeSingleNode"
            />
          </template>
          
          <template #node-version="{ data, id }">
            <VersionNode 
              :data="data" 
              :id="id" 
              @delete="handleNodeDelete"
              @execute-from-node="executeFromNode"
              @execute-single-node="executeSingleNode"
            />
          </template>
        </VueFlow>
      </div>
      
      <!-- 右侧：节点工具栏 -->
      <div class="right-sidebar">
        <div class="sidebar-header">
          <h3>节点工具箱</h3>
        </div>
        
        <div class="node-toolbox">
          <div class="tool-item" @click="addNode('command')">
            <div class="tool-icon command">📋</div>
            <div class="tool-label">命令节点</div>
            <div class="tool-desc">执行自定义命令</div>
          </div>
          
          <div class="tool-item" @click="addNode('wait')">
            <div class="tool-icon wait">⏰</div>
            <div class="tool-label">等待节点</div>
            <div class="tool-desc">暂停指定时间</div>
          </div>
          
          <div class="tool-item" @click="addNode('version')">
            <div class="tool-icon version">📦</div>
            <div class="tool-label">版本管理</div>
            <div class="tool-desc">修改版本号或依赖</div>
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
  height: 75vh;
  gap: var(--spacing-md);
  background: var(--bg-page);
}

.left-sidebar,
.right-sidebar {
  background: var(--bg-container);
  border-radius: var(--radius-lg);
  padding: var(--spacing-lg);
  box-shadow: var(--shadow-md);
}

.left-sidebar {
  width: 250px;
  display: flex;
  flex-direction: column;
}

.right-sidebar {
  width: 280px;
  display: flex;
  flex-direction: column;
}

.sidebar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--spacing-lg);
  padding-bottom: var(--spacing-md);
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
  padding: var(--spacing-md);
  margin-bottom: var(--spacing-base);
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
  
  .header-info {
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
  gap: var(--spacing-md);
  margin-bottom: 20px;
}

.tool-item {
  padding: var(--spacing-lg);
  border-radius: var(--radius-lg);
  border: 2px solid var(--border-component);
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
    font-size: 32px;
    margin-bottom: var(--spacing-base);
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

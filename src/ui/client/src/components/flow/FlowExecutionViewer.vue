<script setup lang="ts">
import { computed, defineComponent, h, nextTick, onUnmounted, watch } from 'vue'
import type { PropType } from 'vue'
import { VueFlow, useVueFlow } from '@vue-flow/core'
import type { NodeTypesObject } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'

import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'

import BaseNode from './nodes/BaseNode.vue'
import CommandNode from './nodes/CommandNode.vue'
import WaitNode from './nodes/WaitNode.vue'
import VersionNode from './nodes/VersionNode.vue'
import ConfirmNode from './nodes/ConfirmNode.vue'
import CodeNode from './nodes/CodeNode.vue'
import ConditionNode from './nodes/ConditionNode.vue'

import type { FlowData, FlowNodeData, FlowNode, FlowEdge } from './FlowOrchestrationWorkspace.vue'
import { $t } from '@/lang/static'

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
    default:
      return ''
  }
}

const StartNodeRenderer = defineComponent({
  name: 'FlowExecStartNodeRenderer',
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
          execStatus: (props.data as any)?.execStatus,
          deletable: false
        },
        {}
      )
  }
})

function createWrappedNode(Inner: any) {
  return defineComponent({
    name: 'FlowExecWrappedNode',
    props: {
      id: { type: String, required: true },
      data: { type: Object as PropType<FlowNodeData>, required: true }
    },
    setup(props) {
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
          BaseNode,
          {
            id: props.id,
            nodeId: props.id,
            nodeType: props.data?.type,
            title: props.data?.label,
            icon: getNodeIcon(props.data?.type),
            enabled: props.data?.enabled,
            selected: props.data?.selected,
            execStatus: (props.data as any)?.execStatus,
            sourceHandleIds: props.data?.type === 'condition' ? conditionHandleIds.value : undefined,
            deletable: false
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
  })
}

const nodeTypes: NodeTypesObject = {
  start: StartNodeRenderer,
  command: createWrappedNode(CommandNode),
  wait: createWrappedNode(WaitNode),
  version: createWrappedNode(VersionNode),
  confirm: createWrappedNode(ConfirmNode),
  code: createWrappedNode(CodeNode),
  condition: createWrappedNode(ConditionNode)
} as unknown as NodeTypesObject

const props = defineProps({
  flowData: { type: Object as PropType<FlowData>, required: true },
  currentNodeId: { type: String as PropType<string | undefined>, default: undefined },
  executedNodeIds: { type: Array as PropType<string[]>, default: () => [] },
  failedNodeIds: { type: Array as PropType<string[]>, default: () => [] },
  executedEdgeIds: { type: Array as PropType<string[]>, default: () => [] }
})

const flowId = 'flow-execution-viewer'
const { onPaneReady } = useVueFlow({ id: flowId })

let flowInstance: any = null
let pendingFocusNodeId: string | null = null

async function focusNode(nodeId: string) {
  if (!nodeId) return
  if (!flowInstance) {
    pendingFocusNodeId = nodeId
    return
  }

  // 节点初次渲染时 findNode 可能拿不到，做少量重试
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await nextTick()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    const n = typeof flowInstance?.findNode === 'function' ? flowInstance.findNode(nodeId) : null
    if (!n) {
      await new Promise<void>((resolve) => window.setTimeout(() => resolve(), 60))
      continue
    }

    try {
      await flowInstance.fitView({
        nodes: [nodeId],
        padding: 0.35,
        includeHiddenNodes: true,
        minZoom: 0.35,
        maxZoom: 1.2,
        duration: 200
      } as any)
    } catch {
      // ignore
    }
    break
  }
}

onPaneReady((instance) => {
  flowInstance = instance
  console.log('[FlowExecutionViewer] onPaneReady, flowId=', flowId)
  console.log('[FlowExecutionViewer] instance keys=', Object.keys(instance || {}))

  // 初次进入时先 fitView 一次，后续节点切换用 fitView(nodes) 仅适配当前节点
  try {
    void flowInstance.fitView({ padding: 0.2, includeHiddenNodes: true, duration: 0 } as any)
  } catch {
    // ignore
  }

  const nodeId = (props.currentNodeId || pendingFocusNodeId || '').trim()
  if (nodeId) {
    pendingFocusNodeId = null
    void focusNode(nodeId)
  }
})

let focusTimer: number | null = null

watch(
  () => props.currentNodeId,
  async (nodeId) => {
    if (!nodeId) return

    if (focusTimer) {
      window.clearTimeout(focusTimer)
      focusTimer = null
    }

    focusTimer = window.setTimeout(async () => {
      console.log('[FlowExecutionViewer] focus request, flowId=', flowId, 'nodeId=', nodeId)
      if (!flowInstance) {
        pendingFocusNodeId = nodeId
        console.log('[FlowExecutionViewer] flowInstance not ready, pendingFocusNodeId=', pendingFocusNodeId)
        return
      }

      void focusNode(nodeId)
    }, 150)
  }
)

onUnmounted(() => {
  if (focusTimer) {
    window.clearTimeout(focusTimer)
    focusTimer = null
  }
})

const nodesForRender = computed(() => {
  const nodes = Array.isArray(props.flowData?.nodes) ? props.flowData.nodes : []
  const executed = new Set(props.executedNodeIds)
  const failed = new Set(props.failedNodeIds)
  const current = props.currentNodeId

  return nodes.map((n: FlowNode) => {
    let execStatus: 'running' | 'success' | 'failed' | undefined
    if (current && n.id === current) execStatus = 'running'
    else if (failed.has(n.id)) execStatus = 'failed'
    else if (executed.has(n.id)) execStatus = 'success'

    const cls: string[] = []
    if (executed.has(n.id)) cls.push('exec-node-done')

    return {
      ...n,
      data: {
        ...(n as any).data,
        execStatus
      },
      class: cls.join(' ')
    } as any
  })
})

const edgesForRender = computed(() => {
  const edges = Array.isArray(props.flowData?.edges) ? props.flowData.edges : []
  const executed = new Set(props.executedEdgeIds)

  return edges.map((e: FlowEdge) => {
    const cls: string[] = []
    if (executed.has(e.id)) cls.push('exec-edge-done')

    return {
      ...e,
      class: cls.join(' ')
    } as any
  })
})
</script>

<template>
  <div class="flow-exec-viewer">
    <VueFlow
      :id="flowId"
      :nodes="nodesForRender as any"
      :edges="edgesForRender as any"
      :node-types="nodeTypes"
      :nodes-draggable="false"
      :nodes-connectable="false"
      :elements-selectable="false"
      :zoom-on-scroll="true"
      :zoom-on-double-click="false"
      :pan-on-drag="true"
      :min-zoom="0.2"
      :max-zoom="1.5"
    >
      <Background />
      <Controls />
    </VueFlow>
  </div>
</template>

<style scoped lang="scss">
.flow-exec-viewer {
  height: 240px;
  border: 1px solid var(--border-component);
  overflow: hidden;
  background: var(--bg-code);
}

:deep(.vue-flow__node.exec-node-done) {
  opacity: 0.85;
}

:deep(.vue-flow__edge.exec-edge-done .vue-flow__edge-path) {
  stroke: var(--color-success);
  stroke-width: 2.5px;
}
</style>

<script setup lang="ts">
import { computed } from 'vue'
import type { FlowNodeData } from '../FlowOrchestrationWorkspace.vue'
import { $t } from '@/lang/static'

const props = defineProps<{
  data: FlowNodeData
  id: string
}>()

// 获取版本管理信息
const versionInfo = computed(() => {
  if (!props.data.config) return null
  return {
    target: props.data.config.versionTarget,
    dependency: props.data.config.dependencyName
  }
})

</script>

<template>
  <div class="version-node-content">
    <div v-if="versionInfo?.target === 'dependency'" class="node-badge">
      {{ $t('@FLOWNODE:依赖') }}: {{ versionInfo.dependency }}
    </div>
    <div v-if="!data.config" class="node-warning">{{ $t('@FLOWNODE:未配置') }}</div>
  </div>
</template>

<style scoped lang="scss">
.version-node-content {
  .node-badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    background: rgba(104, 189, 255, 0.15);
    color: var(--color-info);
    margin-top: 6px;
    max-width: 100%;
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
  }
  
  .node-warning {
    color: var(--color-error);
    font-size: 12px;
    margin-top: 4px;
  }
}

</style>

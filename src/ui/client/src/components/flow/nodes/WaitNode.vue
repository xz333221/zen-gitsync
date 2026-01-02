<script setup lang="ts">
import type { FlowNodeData } from '../FlowOrchestrationWorkspace.vue'
import { $t } from '@/lang/static'
defineProps<{
  data: FlowNodeData
  id: string
}>()
</script>

<template>
  <div class="wait-node-content">
    <div v-if="!data.config" class="node-warning">{{ $t('@FLOWNODE:未配置') }}</div>
    <div v-else class="wait-seconds">{{ $t('@FLOWNODE:等待 {seconds} 秒', { seconds: data.config?.waitSeconds ?? 0 }) }}</div>
  </div>
</template>

<style scoped lang="scss">
.wait-node-content {
  .wait-seconds {
    font-size: 12px;
    margin-top: 4px;
    color: var(--text-secondary);
  }

  .node-warning {
    color: var(--color-error);
    font-size: 12px;
    margin-top: 4px;
  }
}

</style>

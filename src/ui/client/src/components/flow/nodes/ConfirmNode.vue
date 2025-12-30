<script setup lang="ts">
import type { FlowNodeData } from '../FlowOrchestrationWorkspace.vue'
import { $t } from '@/lang/static'

defineProps<{
  data: FlowNodeData
  id: string
}>()
</script>

<template>
  <div class="confirm-node-content">
    <div v-if="!data.config" class="node-warning">{{ $t('@FLOWNODE:未配置') }}</div>
  </div>
</template>

<style scoped lang="scss">
.confirm-node-content {
  .node-warning {
    color: var(--color-error);
    font-size: 12px;
    margin-top: 4px;
  }
}

</style>

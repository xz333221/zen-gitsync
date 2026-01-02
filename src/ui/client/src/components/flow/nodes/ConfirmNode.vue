<script setup lang="ts">
import type { FlowNodeData } from '../FlowOrchestrationWorkspace.vue'
import { $t } from '@/lang/static'

defineProps<{
  data: FlowNodeData
  id: string
}>()
</script>

<template>
  <div v-if="!data.config" class="confirm-node-content">
    <div class="node-warning">{{ $t('@FLOWNODE:未配置') }}</div>
  </div>
</template>

<style scoped lang="scss">
.confirm-node-content {
  display: flex;
  align-items: center;
  justify-content: center;

  .node-warning {
    color: var(--color-error);
    font-size: 12px;
    line-height: 1.2;
  }
}

</style>

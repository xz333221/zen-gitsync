<script setup lang="ts">
import type { FlowNodeData } from '../FlowOrchestrationWorkspace.vue'
import { $t } from '@/lang/static'

defineProps<{
  data: FlowNodeData
  id: string
}>()
</script>

<template>
  <div
    class="confirm-node"
    :class="{ 'disabled': !data.enabled, 'selected': data.selected }"
  >
    <div class="node-header">
      <div class="flow-node-icon">✋</div>
      <div class="node-type">{{ $t('@FLOWNODE:用户确认') }}</div>
    </div>
    
    <div class="node-content">
      <div class="node-label">{{ data.label }}</div>
      <div v-if="!data.config" class="node-warning">{{ $t('@FLOWNODE:未配置') }}</div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.confirm-node {
  padding: var(--spacing-md);
  border-radius: var(--radius-lg);
  background: var(--bg-container);
  border: 2px solid #ec4899;
  box-shadow: var(--shadow-md);
  min-width: 200px;
  max-width: 250px;
  position: relative;
  transition: var(--transition-all);
  
  // 选中状态
  &.selected {
    border-color: #db2777;
    box-shadow: 0 0 0 3px rgba(236, 72, 153, 0.22), var(--shadow-lg);
    transform: translateY(-1px);
  }
  
  &.disabled {
    opacity: 0.6;
    border-color: var(--border-component);
  }
}

.node-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  margin-bottom: var(--spacing-base);
  
  .flow-node-icon {
    font-size: 20px;
  }
  
  .node-type {
    font-size: var(--font-size-sm);
    color: var(--text-tertiary);
    font-weight: var(--font-weight-medium);
  }
}

.node-content {
  font-size: var(--font-size-base);
  color: var(--text-primary);
  text-align: center;
  font-weight: var(--font-weight-semibold);
  
  .node-label {
    font-weight: 600;
    font-size: 14px;
    margin-bottom: 4px;
  }
  
  .node-warning {
    color: var(--color-error);
    font-size: 12px;
    margin-top: 4px;
  }
}

</style>

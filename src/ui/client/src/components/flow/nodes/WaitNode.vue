<script setup lang="ts">
import type { FlowNodeData } from '../FlowOrchestrationWorkspace.vue'
defineProps<{
  data: FlowNodeData
  id: string
}>()
</script>

<template>
  <div
    class="wait-node"
    :class="{ 'disabled': !data.enabled, 'selected': data.selected }"
  >
    <div class="node-header">
      <div class="flow-node-icon">⏰</div>
      <div class="node-type">等待节点</div>
    </div>
    
    <div class="node-content">
      <div class="node-label">{{ data.label }}</div>
      <div v-if="!data.config" class="node-warning">未配置</div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.wait-node {
  padding: var(--spacing-md);
  border-radius: var(--radius-lg);
  background: var(--bg-container);
  border: 2px solid var(--color-warning);
  box-shadow: var(--shadow-md);
  min-width: 200px;
  max-width: 250px;
  position: relative;
  transition: var(--transition-all);
  
  // 选中状态
  &.selected {
    border-color: #d48806;
    box-shadow: 0 0 0 3px rgba(250, 173, 20, 0.2), var(--shadow-lg);
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

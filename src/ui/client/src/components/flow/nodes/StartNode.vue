<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'
import type { FlowNodeData } from '../FlowOrchestrationWorkspace.vue'

defineProps<{
  data: FlowNodeData
}>()
</script>

<template>
  <div class="start-node" :class="{ 'selected': data.selected }">
    <div class="flow-node-icon">🚀</div>
    <div class="node-label">开始</div>
    
    <!-- 输出连接点（右侧） -->
    <Handle 
      type="source" 
      :position="Position.Right" 
      class="flow-node-handle handle-right"
    />
  </div>
</template>

<style scoped lang="scss">
.start-node {
  padding: var(--spacing-lg) 25px;
  border-radius: var(--radius-full);
  background: var(--color-primary-gradient);
  color: var(--color-white);
  text-align: center;
  box-shadow: var(--shadow-lg);
  min-width: 120px;
  min-height: 120px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  position: relative;
  transition: var(--transition-all);
  
  &:hover {
    background: var(--color-primary-gradient-hover);
    box-shadow: var(--shadow-xl);
    transform: scale(1.05);
  }
  
  // 选中状态
  &.selected {
    box-shadow: 0 0 0 3px rgba(64, 158, 255, 0.3), var(--shadow-xl);
    transform: scale(1.08);
  }
  
  .flow-node-icon {
    font-size: 32px;
    margin-bottom: var(--spacing-base);
  }
  
  .node-label {
    font-size: var(--font-size-base);
    font-weight: var(--font-weight-semibold);
  }
}

.handle-right {
  right: -6px !important;
  background: var(--color-primary) !important;
}
</style>

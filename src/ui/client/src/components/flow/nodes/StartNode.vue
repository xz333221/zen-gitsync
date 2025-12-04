<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'
import type { FlowNodeData } from '../FlowOrchestrationWorkspace.vue'

defineProps<{
  data: FlowNodeData
}>()
</script>

<template>
  <div class="start-node">
    <div class="flow-node-icon">🚀</div>
    <div class="node-label">开始</div>
    
    <!-- 输出连接点（右侧） -->
    <Handle 
      type="source" 
      :position="Position.Right" 
      class="handle-right"
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
  min-width: 100px;
  &:hover {
    background: var(--color-primary-gradient-hover);
    box-shadow: var(--shadow-xl);
    transform: scale(1.05);
  }
  min-height: 100px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  position: relative;
  
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
  width: 12px !important;
  height: 12px !important;
  background: var(--color-primary) !important;
  border: 2px solid var(--bg-page) !important;
  border-radius: 50% !important;
  cursor: crosshair !important;
  
  &:hover {
    background: var(--color-primary-dark) !important;
    transform: scale(1.2);
  }
}
</style>

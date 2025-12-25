<script setup lang="ts">
import type { FlowNodeData } from '../FlowOrchestrationWorkspace.vue'
import { $t } from '@/lang/static'

defineProps<{
  data: FlowNodeData
}>()
</script>

<template>
  <div class="start-node" :class="{ 'selected': data.selected }">
    <div class="flow-node-icon">🚀</div>
    <div class="node-label">{{ $t('@FLOWNODE:开始') }}</div>
  </div>
</template>

<style scoped lang="scss">
.start-node {
  width: 100px;
  height: 100px;
  padding: var(--spacing-md);
  border-radius: 50%;
  background: var(--color-primary-gradient);
  color: var(--color-white);
  text-align: center;
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  position: relative;
  transition: var(--transition-all);
  
  &:hover {
    background: var(--color-primary-gradient-hover);
    box-shadow: var(--shadow-xl);
  }
  
  // 选中状态
  &.selected {
    box-shadow: 0 0 0 3px rgba(64, 158, 255, 0.3), var(--shadow-xl);
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
</style>

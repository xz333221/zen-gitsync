<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'
import type { FlowNodeData } from '../FlowOrchestrationWorkspace.vue'

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
    <!-- 输入连接点（左侧） -->
    <Handle 
      id="target"
      type="target" 
      :position="Position.Left" 
      class="flow-node-handle handle-left"
    />
    
    <div class="node-header">
      <div class="flow-node-icon">✋</div>
      <div class="node-type">用户确认</div>
    </div>
    
    <div class="node-content">
      <div class="node-label">{{ data.label }}</div>
      <div v-if="!data.config" class="node-warning">未配置</div>
    </div>
    
    <!-- 禁用遮罩 -->
    <div v-if="!data.enabled" class="disabled-overlay">已禁用</div>
    
    <!-- 输出连接点（右侧） -->
    <Handle 
      id="source"
      type="source" 
      :position="Position.Right" 
      class="flow-node-handle handle-right"
    />
  </div>
</template>

<style scoped lang="scss">
.confirm-node {
  padding: var(--spacing-md);
  border-radius: var(--radius-lg);
  background: var(--bg-container);
  border: 2px solid #ff9800;
  box-shadow: var(--shadow-md);
  min-width: 200px;
  max-width: 250px;
  position: relative;
  transition: var(--transition-all);
  
  // 选中状态
  &.selected {
    border-color: #f57c00;
    box-shadow: 0 0 0 3px rgba(255, 152, 0, 0.2), var(--shadow-lg);
    transform: translateY(-1px);
  }
  
  &.disabled {
    opacity: 0.6;
    border-color: var(--border-component);
    
    .disabled-overlay {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.1);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: var(--font-size-sm);
      color: var(--text-tertiary);
      border-radius: var(--radius-md);
      z-index: 5;
    }
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

.handle-left,
.handle-right {
  background: #ff9800 !important;
}

.handle-left {
  left: -6px !important;
}

.handle-right {
  right: -6px !important;
}
</style>

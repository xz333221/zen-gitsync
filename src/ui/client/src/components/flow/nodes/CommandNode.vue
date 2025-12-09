<script setup lang="ts">
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import type { FlowNodeData } from '../FlowOrchestrationWorkspace.vue'

const props = defineProps<{
  data: FlowNodeData
  id: string
}>()

const emit = defineEmits<{
  (e: 'delete', nodeId: string): void
}>()

// 获取命令信息
const commandInfo = computed(() => {
  if (!props.data.config) return null
  return {
    name: props.data.config.commandName || '未配置',
    terminal: props.data.config.useTerminal || false
  }
})
</script>

<template>
  <div 
    class="command-node" 
    :class="{ 'disabled': !data.enabled }"
  >
    <!-- 删除按钮 -->
    <button 
      class="delete-btn" 
      @click.stop="emit('delete', id)" 
      title="删除节点"
    >
      ×
    </button>
    
    <!-- 输入连接点（左侧） -->
    <Handle 
      type="target" 
      :position="Position.Left" 
      class="flow-node-handle handle-left"
    />
    
    <div class="node-header">
      <div class="flow-node-icon">📋</div>
      <div class="node-type">命令节点</div>
    </div>
    
    <div class="node-content">
      <div class="node-label">{{ data.label }}</div>
      <div v-if="commandInfo?.terminal" class="node-badge terminal">终端</div>
      <div v-if="!data.config" class="node-warning">未配置</div>
    </div>
    
    <!-- 禁用遮罩 -->
    <div v-if="!data.enabled" class="disabled-overlay">已禁用</div>
    
    <!-- 输出连接点（右侧） -->
    <Handle 
      type="source" 
      :position="Position.Right" 
      class="flow-node-handle handle-right"
    />
  </div>
</template>

<style scoped lang="scss">
.command-node {
  padding: var(--spacing-md);
  border-radius: var(--radius-lg);
  background: var(--bg-container);
  border: 2px solid var(--color-primary);
  box-shadow: var(--shadow-md);
  min-width: 200px;
  max-width: 250px;
  position: relative;
  transition: var(--transition-all);
  
  .delete-btn {
    position: absolute;
    top: -8px;
    right: -8px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--color-danger);
    color: white;
    border: 2px solid var(--bg-page);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    display: none;
    align-items: center;
    justify-content: center;
    transition: var(--transition-all);
    z-index: 10;
    
    &:hover {
      transform: scale(1.1);
      background: var(--color-danger-dark);
    }
  }
  
  &:hover {
    box-shadow: var(--shadow-lg);
    
    .delete-btn {
      display: flex;
    }
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
  
  .node-icon {
    font-size: 20px;
  }
  
  .node-type {
    font-size: var(--font-size-sm);
    color: var(--text-tertiary);
    font-weight: var(--font-weight-medium);
  }
}

.node-content {
  font-size: 13px;
  color: var(--text-primary);
  
  .node-label {
    font-weight: 600;
    margin-bottom: 4px;
    word-break: break-word;
  }
  
  .node-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 500;
    
    &.terminal {
      background: var(--color-warning);
      color: white;
    }
  }
  
  .node-warning {
    color: var(--color-error);
    font-size: 12px;
    margin-top: 4px;
  }
}

// CommandNode 只覆写颜色，其他尺寸/交互在公共样式中
.handle-left,
.handle-right {
  background: var(--color-primary) !important;
}

.handle-left {
  left: -6px !important;
}

.handle-right {
  right: -6px !important;
}
</style>

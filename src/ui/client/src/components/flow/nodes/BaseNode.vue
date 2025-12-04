<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'

const props = defineProps<{
  id: string
  enabled?: boolean
  borderColor?: string
  showHandles?: boolean
}>()

const emit = defineEmits<{
  (e: 'delete', nodeId: string): void
}>()

// 默认显示连接点
const showHandlesComputed = props.showHandles !== false
</script>

<template>
  <div 
    class="base-node" 
    :class="{ 'disabled': !enabled }"
    :style="{ '--node-border-color': borderColor || 'var(--color-primary)' }"
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
      v-if="showHandlesComputed"
      type="target" 
      :position="Position.Left" 
      class="handle-left"
    />
    
    <!-- 节点内容插槽 -->
    <slot></slot>
    
    <!-- 禁用遮罩 -->
    <div v-if="!enabled" class="disabled-overlay">已禁用</div>
    
    <!-- 输出连接点（右侧） -->
    <Handle 
      v-if="showHandlesComputed"
      type="source" 
      :position="Position.Right" 
      class="handle-right"
    />
  </div>
</template>

<style scoped lang="scss">
.base-node {
  padding: var(--spacing-md);
  border-radius: var(--radius-lg);
  background: var(--bg-container);
  border: 2px solid var(--node-border-color);
  box-shadow: var(--shadow-md);
  min-width: 180px;
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

.handle-left,
.handle-right {
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

.handle-left {
  left: -6px !important;
}

.handle-right {
  right: -6px !important;
}
</style>

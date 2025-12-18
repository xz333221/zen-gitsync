<script setup lang="ts">
import { Close } from '@element-plus/icons-vue'
import { Handle, Position } from '@vue-flow/core'

withDefaults(defineProps<{
  id: string
  nodeType?: 'start' | 'command' | 'wait' | 'version' | 'confirm'
  enabled?: boolean
  selected?: boolean
  deletable?: boolean
  showDeleteOnSelected?: boolean
}>(), {
  enabled: true,
  selected: false,
  deletable: true,
  showDeleteOnSelected: false,
  nodeType: 'command'
})

const emit = defineEmits<{
  (e: 'delete', nodeId: string): void
}>()
</script>

<template>
  <div 
    class="flow-node-wrapper" 
    :class="[
      { 'disabled': !enabled, 'is-selected': selected, 'show-delete-on-selected': showDeleteOnSelected },
      nodeType ? `node-type-${nodeType}` : ''
    ]"
  >
    <!-- 输入连接点（左侧） -->
    <Handle
      v-if="nodeType !== 'start'"
      id="target"
      type="target"
      :position="Position.Left"
      class="flow-node-handle handle-left"
    />

    <button
      v-if="deletable !== false"
      class="flow-node-delete-btn"
      @click.stop="emit('delete', id)"
      title="删除节点"
    >
      <el-icon><Close /></el-icon>
    </button>
    
    <!-- 节点内容插槽 -->
    <slot></slot>
    
    <!-- 禁用遮罩 -->
    <div v-if="!enabled" class="disabled-overlay">已禁用</div>

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
.flow-node-wrapper {
  position: relative;
  display: inline-block;
}

// 连接点（Handle）通用样式：集中处理，避免每个节点重复定义
.flow-node-handle {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--bg-container);
  z-index: 10;
}

.handle-left {
  left: -6px !important;
}

.handle-right {
  right: -6px !important;
}

// 不同节点类型的连接点颜色
.node-type-command {
  .flow-node-handle {
    background: var(--color-primary) !important;
  }
}

.node-type-wait {
  .flow-node-handle {
    background: var(--color-warning) !important;
  }
}

.node-type-version {
  .flow-node-handle {
    background: var(--color-success) !important;
  }
}

.node-type-confirm {
  .flow-node-handle {
    background: #ff9800 !important;
  }
}

.node-type-start {
  .flow-node-handle {
    background: var(--color-primary) !important;
  }

  .handle-right {
    right: -4px !important;
  }
}

.flow-node-delete-btn {
  position: absolute;
    top: -8px;
    right: -8px;
    width: 20px;
    height: 20px;
  border-radius: 50%;
  background: #ff4d4f;
  color: white;
  border: 2px solid var(--bg-page);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: var(--transition-all);
  z-index: 20;
  opacity: 0;
  pointer-events: none;
}

.flow-node-wrapper:hover .flow-node-delete-btn,
.flow-node-wrapper.show-delete-on-selected.is-selected .flow-node-delete-btn {
  opacity: 1;
  pointer-events: auto;
}

.flow-node-wrapper.disabled {
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
</style>

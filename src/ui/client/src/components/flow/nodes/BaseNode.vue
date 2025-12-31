<script setup lang="ts">
import { computed } from 'vue'
import { CircleCloseFilled } from '@element-plus/icons-vue'
import { Handle, Position } from '@vue-flow/core'

const props = withDefaults(defineProps<{
  id: string
  nodeId: string
  nodeType?: 'start' | 'command' | 'wait' | 'version' | 'confirm' | 'code' | 'condition'
  title?: string
  icon?: string
  enabled?: boolean
  selected?: boolean
  deletable?: boolean
  showDeleteOnSelected?: boolean
  sourceHandleIds?: string[]
}>(), {
  enabled: true,
  selected: false,
  deletable: true,
  showDeleteOnSelected: false,
  nodeType: 'command',
  sourceHandleIds: () => ['source']
})

const hasHeader = computed(() => Boolean((props.title && String(props.title).trim()) || (props.icon && String(props.icon).trim())))
const conditionHandleYOffset = computed(() => (hasHeader.value ? 16 : 0))

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

    <el-icon
      v-if="deletable !== false"
      class="flow-node-delete-btn"
      @click.stop="emit('delete', nodeId)"
      title="删除节点"
      role="button"
      tabindex="0"
    >
      <CircleCloseFilled />
    </el-icon>

    <div v-if="title || icon" class="node-header">
      <div class="flow-node-icon">{{ icon }}</div>
      <div class="node-title">{{ title }}</div>
    </div>
    
    <div class="node-body">
      <slot></slot>
    </div>
    
    <!-- 禁用遮罩 -->
    <div v-if="!enabled" class="disabled-overlay">已禁用</div>

    <!-- 输出连接点（右侧） -->
    <template v-if="nodeType === 'condition'">
      <Handle
        v-for="hid in sourceHandleIds"
        :key="hid"
        :id="hid"
        type="source"
        :position="Position.Right"
        class="flow-node-handle handle-right"
        :style="{ top: `calc(50% + ${conditionHandleYOffset}px + ${(sourceHandleIds.indexOf(hid) - (sourceHandleIds.length - 1) / 2) * 18}px)` }"
      />
    </template>
    <Handle
      v-else
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
  padding: var(--spacing-md);
  border-radius: var(--radius-lg);
  background: var(--bg-container);
  box-shadow: var(--shadow-md);
  position: relative;
  transition: var(--transition-all);
  border: 2px solid var(--border-component);

  &.is-selected {
    transform: translateY(-1px);
  }

  &.disabled {
    opacity: 0.6;
  }
}

.node-type-condition {
  min-width: 220px;
  max-width: 320px;
  border-color: #f59e0b;

  &.is-selected {
    border-color: #d97706;
    box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.2), var(--shadow-lg);
  }

  .flow-node-handle {
    background: #f59e0b !important;
  }
}

.node-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  margin-bottom: 0;

  .flow-node-icon {
    font-size: 18px;
    line-height: 1;
  }

  .node-title {
    font-size: var(--font-size-lg);
    color: var(--text-primary);
    font-weight: var(--font-weight-semibold);
    word-break: break-word;
  }
}

.node-body {
  font-size: 13px;
  color: var(--text-primary);
  margin-top: var(--spacing-base);
}

.node-body:empty {
  display: none;
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
  left: -4px !important;
}

.handle-right {
  right: -4px !important;
}

// 不同节点类型的连接点颜色
.node-type-command {
  min-width: 220px;
  max-width: 320px;
  border-color: #06b6d4;

  &.is-selected {
    border-color: #0891b2;
    box-shadow: 0 0 0 3px rgba(6, 182, 212, 0.22), var(--shadow-lg);
  }

  .flow-node-handle {
    background: #06b6d4 !important;
  }
}

.node-type-wait {
  min-width: 200px;
  max-width: 250px;
  border-color: var(--color-warning);

  &.is-selected {
    border-color: #d48806;
    box-shadow: 0 0 0 3px rgba(250, 173, 20, 0.2), var(--shadow-lg);
  }

  .flow-node-handle {
    background: var(--color-warning) !important;
  }
}

.node-type-version {
  min-width: 200px;
  max-width: 250px;
  border-color: var(--color-success);

  &.is-selected {
    border-color: #389e0d;
    box-shadow: 0 0 0 3px rgba(82, 196, 26, 0.2), var(--shadow-lg);
  }

  .flow-node-handle {
    background: var(--color-success) !important;
  }
}

.node-type-confirm {
  min-width: 200px;
  max-width: 250px;
  border-color: #ec4899;

  &.is-selected {
    border-color: #db2777;
    box-shadow: 0 0 0 3px rgba(236, 72, 153, 0.22), var(--shadow-lg);
  }

  .flow-node-handle {
    background: #ec4899 !important;
  }
}

.node-type-code {
  min-width: 220px;
  max-width: 320px;
  border-color: #7c3aed;

  &.is-selected {
    border-color: #6d28d9;
    box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.22), var(--shadow-lg);
  }

  .flow-node-handle {
    background: #7c3aed !important;
  }
}

.node-type-start {
  min-width: 200px;
  max-width: 250px;
  border-color: var(--color-primary);

  &.is-selected {
    border-color: var(--color-primary-dark);
    box-shadow: 0 0 0 3px rgba(64, 158, 255, 0.22), var(--shadow-lg);
  }

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
  color: #ff4d4f;
  cursor: pointer;
  background-color: white;
  border-radius: 50%;
  transition: var(--transition-all);
  z-index: 20;
  opacity: 0;
  pointer-events: none;
  font-size: 18px;
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

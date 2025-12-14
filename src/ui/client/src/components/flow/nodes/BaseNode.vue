<script setup lang="ts">
import { Close } from '@element-plus/icons-vue'

withDefaults(defineProps<{
  id: string
  enabled?: boolean
  selected?: boolean
  deletable?: boolean
  showDeleteOnSelected?: boolean
}>(), {
  enabled: true,
  selected: false,
  deletable: true,
  showDeleteOnSelected: false
})

const emit = defineEmits<{
  (e: 'delete', nodeId: string): void
}>()
</script>

<template>
  <div 
    class="flow-node-wrapper" 
    :class="{ 'disabled': !enabled, 'is-selected': selected, 'show-delete-on-selected': showDeleteOnSelected }"
  >
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
  </div>
</template>

<style scoped lang="scss">
.flow-node-wrapper {
  position: relative;
  display: inline-block;
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

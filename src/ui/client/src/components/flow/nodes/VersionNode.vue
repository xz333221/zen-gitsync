<script setup lang="ts">
import { computed } from 'vue'
import type { FlowNodeData } from '../FlowOrchestrationWorkspace.vue'
import { $t } from '@/lang/static'

const props = defineProps<{
  data: FlowNodeData
  id: string
}>()

// 获取版本管理信息
const versionInfo = computed(() => {
  if (!props.data.config) return null
  return {
    target: props.data.config.versionTarget,
    dependency: props.data.config.dependencyName
  }
})

</script>

<template>
  <div
    class="version-node"
    :class="{ 'disabled': !data.enabled, 'selected': data.selected }"
  >
    <div class="node-header">
      <div class="flow-node-icon">📦</div>
      <div class="node-type">{{ $t('@FLOWNODE:版本管理') }}</div>
    </div>
    
    <div class="node-content">
      <div class="node-label">{{ data.label }}</div>
      <div v-if="versionInfo?.target === 'dependency'" class="node-badge">
        {{ $t('@FLOWNODE:依赖') }}: {{ versionInfo.dependency }}
      </div>
      <div v-if="!data.config" class="node-warning">{{ $t('@FLOWNODE:未配置') }}</div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.version-node {
  padding: var(--spacing-md);
  border-radius: var(--radius-lg);
  background: var(--bg-container);
  border: 2px solid var(--color-success);
  box-shadow: var(--shadow-md);
  min-width: 200px;
  max-width: 250px;
  position: relative;
  transition: var(--transition-all);
  
  // 选中状态
  &.selected {
    border-color: #389e0d;
    box-shadow: 0 0 0 3px rgba(82, 196, 26, 0.2), var(--shadow-lg);
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
  font-size: 13px;
  color: var(--text-primary);
  
  .node-label {
    font-weight: 600;
    margin-bottom: 4px;
    word-break: break-word;
  }
  
  .node-badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    background: rgba(104, 189, 255, 0.15);
    color: var(--color-info);
    margin-top: 6px;
    max-width: 100%;
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
  }
  
  .node-warning {
    color: var(--color-error);
    font-size: 12px;
    margin-top: 4px;
  }
}

</style>

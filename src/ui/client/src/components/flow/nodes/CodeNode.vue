<script setup lang="ts">
import { computed } from 'vue'
import type { FlowNodeData } from '../FlowOrchestrationWorkspace.vue'
import { $t } from '@/lang/static'

const props = defineProps<{
  data: FlowNodeData
  id: string
}>()

const info = computed(() => {
  const cfg: any = props.data.config || {}
  return {
    hasScript: Boolean(cfg.codeScript && String(cfg.codeScript).trim()),
    outputKeys: Array.isArray(cfg.codeOutputKeys) ? cfg.codeOutputKeys : []
  }
})
</script>

<template>
  <div class="code-node" :class="{ 'disabled': !data.enabled, 'selected': data.selected }">
    <div class="node-header">
      <div class="flow-node-icon">🧩</div>
      <div class="node-type">{{ $t('@FLOWNODE:代码节点') }}</div>
    </div>

    <div class="node-content">
      <div class="node-label">{{ data.label }}</div>
      <div v-if="!data.config" class="node-warning">{{ $t('@FLOWNODE:未配置') }}</div>

      <div v-else class="code-details">
        <div class="code-meta">
          <span class="meta-item">{{ $t('@NODECFG:脚本') }}: {{ info.hasScript ? $t('@FLOWNODE:已添加') : $t('@FLOWNODE:未配置') }}</span>
          <span class="meta-item">{{ $t('@NODECFG:输出键列表') }}: {{ info.outputKeys.length ? info.outputKeys.join(', ') : $t('@FLOWNODE:未配置') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.code-node {
  padding: var(--spacing-md);
  border-radius: var(--radius-lg);
  background: var(--bg-container);
  border: 2px solid #7c3aed;
  box-shadow: var(--shadow-md);
  min-width: 220px;
  max-width: 320px;
  position: relative;
  transition: var(--transition-all);

  &.selected {
    border-color: #6d28d9;
    box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.22), var(--shadow-lg);
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

  .node-warning {
    color: var(--color-error);
    font-size: 12px;
    margin-top: 4px;
  }

  .code-details {
    margin-top: 8px;
    font-size: 11px;

    .code-meta {
      display: flex;
      flex-direction: column;
      gap: 2px;
      color: var(--text-tertiary);

      .meta-item {
        word-break: break-all;
      }
    }
  }
}
</style>

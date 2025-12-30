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
  <div class="code-node-content">
    <div v-if="!data.config" class="node-warning">{{ $t('@FLOWNODE:未配置') }}</div>

    <div v-else class="code-details">
      <div class="code-meta">
        <span class="meta-item">{{ $t('@NODECFG:脚本') }}: {{ info.hasScript ? $t('@FLOWNODE:已添加') : $t('@FLOWNODE:未配置') }}</span>
        <span class="meta-item">{{ $t('@NODECFG:输出键列表') }}: {{ info.outputKeys.length ? info.outputKeys.join(', ') : $t('@FLOWNODE:未配置') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.code-node-content {
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

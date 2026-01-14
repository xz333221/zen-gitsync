<script setup lang="ts">
import { computed } from 'vue'
import type { FlowNodeData } from '../FlowOrchestrationWorkspace.vue'
import { $t } from '@/lang/static'

const props = defineProps<{
  data: FlowNodeData
  id: string
}>()

const paramNames = computed(() => {
  const cfg: any = props.data?.config
  const list = Array.isArray(cfg?.userInputParams) ? cfg.userInputParams : []
  return list
    .map((p: any) => String(p?.name || '').trim())
    .filter((s: string) => Boolean(s))
})

const requiredSet = computed(() => {
  const cfg: any = props.data?.config
  const list = Array.isArray(cfg?.userInputParams) ? cfg.userInputParams : []
  const set = new Set<string>()
  for (const p of list) {
    const name = String(p?.name || '').trim()
    if (!name) continue
    if (p?.required) set.add(name)
  }
  return set
})

const displayNames = computed(() => paramNames.value.slice(0, 3))
const hasMore = computed(() => paramNames.value.length > 3)
</script>

<template>
  <div class="user-input-node-content">
    <div v-if="!data.config" class="node-warning">{{ $t('@FLOWNODE:未配置') }}</div>
    <template v-else>
      <div v-if="paramNames.length === 0" class="node-warning">{{ $t('@UINPUT:暂无输入参数') }}</div>
      <div v-else class="param-summary">
        <div class="param-count">{{ $t('@UINPUT:参数名') }} ({{ paramNames.length }})</div>
        <div class="param-list">
          <span v-for="name in displayNames" :key="name" class="param-chip" :class="{ required: requiredSet.has(name) }">
            <span v-if="requiredSet.has(name)" class="star">*</span>
            {{ name }}
          </span>
          <span v-if="hasMore" class="more">+{{ paramNames.length - 3 }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
.user-input-node-content {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;

  .node-warning {
    color: var(--color-error);
    font-size: 12px;
    line-height: 1.2;
  }

  .param-summary {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .param-count {
    font-size: 12px;
    color: var(--text-secondary);
  }

  .param-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .param-chip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    border: 1px solid var(--border-component);
    color: var(--text-secondary);
    font-size: 12px;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .param-chip.required {
    border-color: rgba(230, 162, 60, 0.35);
    background: rgba(230, 162, 60, 0.08);
    color: var(--color-warning);
  }

  .star {
    color: var(--color-danger);
    font-weight: 700;
    line-height: 1;
  }

  .more {
    font-size: 12px;
    color: var(--text-tertiary);
    padding: 2px 2px;
  }
}
</style>

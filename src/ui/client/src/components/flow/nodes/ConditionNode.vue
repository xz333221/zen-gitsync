<script setup lang="ts">
import { computed } from 'vue'
import type { PropType } from 'vue'
import type { FlowNodeData } from '../FlowOrchestrationWorkspace.vue'
import type { ConditionBranch } from '@stores/configStore'

const props = defineProps({
  id: { type: String, required: true },
  data: { type: Object as PropType<FlowNodeData>, required: true }
})

const branches = computed(() => {
  const cfg: any = props.data?.config
  const list: ConditionBranch[] = Array.isArray(cfg?.conditionBranches) ? cfg.conditionBranches : []
  const sorted = [...list].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
  return sorted
})
</script>

<template>
  <div class="condition-node">
    <div v-if="branches.length === 0" class="condition-empty">未配置条件分支</div>
    <div v-else class="condition-branches">
      <div v-for="b in branches" :key="b.id" class="condition-branch">
        <span class="branch-name">{{ b.isDefault ? 'DEFAULT' : b.name }}</span>
        <span class="branch-meta">({{ b.combine.toUpperCase() }} / {{ b.rules.length }})</span>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.condition-node {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-right: 24px;
}

.condition-empty {
  color: var(--text-secondary);
  font-size: 12px;
}

.condition-branches {
  display: flex;
  flex-direction: column;
  gap: 0;
  justify-content: center;
}

.condition-branch {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  height: 18px;
  line-height: 18px;
}

.branch-name {
  font-weight: 600;
}

.branch-meta {
  color: var(--text-secondary);
}
</style>

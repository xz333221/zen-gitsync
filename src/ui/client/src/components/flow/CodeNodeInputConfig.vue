<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CodeNodeInput, NodeOutputRef } from '@stores/configStore'
import type { FlowNode } from './FlowOrchestrationWorkspace.vue'
import ParamListContainer from './ParamListContainer.vue'
import { $t } from '@/lang/static'

const props = defineProps<{
  modelValue: CodeNodeInput[]
  predecessorNodes?: FlowNode[]
  title?: string | undefined
  addable?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: CodeNodeInput[]): void
}>()

const inputs = ref<CodeNodeInput[]>([])

watch(() => props.modelValue, (val) => {
  inputs.value = Array.isArray(val) ? [...val] : []
}, { immediate: true, deep: true })

function getNodeDisplayName(node: FlowNode): string {
  if (node.type === 'command') {
    return (node.data.config as any)?.displayName || node.data.config?.commandName || node.data.label || $t('@FLOWNODE:命令节点')
  }
  if (node.type === 'code') {
    return (node.data.config as any)?.displayName || node.data.label || $t('@FLOWNODE:代码节点')
  }
  return node.data.label || node.id
}

function getNodeOutputOptions(node?: FlowNode) {
  if (!node) return []
  if (node.type === 'command') {
    return [
      { key: 'stdout', label: $t('@NODEINPUT:标准输出(stdout)') },
      { key: 'stderr', label: $t('@NODEINPUT:标准错误(stderr)') },
      { key: 'error', label: $t('@NODEINPUT:错误(error)') }
    ]
  }
  if (node.type === 'code') {
    const cfg: any = (node.data as any)?.config
    const params = Array.isArray(cfg?.codeOutputParams) ? cfg.codeOutputParams : []
    return params
      .map((p: any) => String(p?.key || '').trim())
      .filter((k: string) => Boolean(k))
      .map((k: string) => ({ key: k, label: k }))
  }
  return []
}

const treeSelectOptions = computed(() => {
  if (!props.predecessorNodes || props.predecessorNodes.length === 0) return []

  return props.predecessorNodes.map(node => ({
    value: node.id,
    label: getNodeDisplayName(node),
    children: getNodeOutputOptions(node).map((opt: any) => ({
      value: `${node.id}::${opt.key}`,
      label: opt.label
    }))
  }))
})

function createDefaultRow(): CodeNodeInput {
  return { name: '', source: 'reference', required: false, ref: { nodeId: '', outputKey: 'stdout' } }
}

function addRow() {
  const updated = [...inputs.value, createDefaultRow()]
  inputs.value = updated
  emit('update:modelValue', updated)
}

defineExpose({ addRow })

function updateRow(index: number, patch: Partial<CodeNodeInput>) {
  if (!inputs.value[index]) return

  const updated = [...inputs.value]
  updated[index] = { ...updated[index], ...patch }

  // 切换来源时清理对应字段
  if (patch.source) {
    if (patch.source === 'manual') {
      updated[index].ref = undefined
      if (updated[index].manualValue === undefined) updated[index].manualValue = ''
    } else {
      updated[index].manualValue = undefined
      if (!updated[index].ref) updated[index].ref = { nodeId: '', outputKey: 'stdout' }
    }
  }

  inputs.value = updated
  emit('update:modelValue', updated)
}

function handleReferenceSelect(index: number, value: string) {
  if (!value) return
  const [nodeId, outputKey] = value.split('::')
  const ref: NodeOutputRef = { nodeId, outputKey }
  updateRow(index, { ref })
}

function getCurrentReferenceValue(input: CodeNodeInput): string {
  if (input.ref?.nodeId && input.ref?.outputKey) {
    return `${input.ref.nodeId}::${input.ref.outputKey}`
  }
  return ''
}
</script>

<template>
  <div class="code-node-input-config">
    <ParamListContainer
      :model-value="inputs"
      :title="title"
      :addable="addable !== false"
      :removable="true"
      :min-items="0"
      :create-item="createDefaultRow"
      @update:modelValue="(v: CodeNodeInput[]) => emit('update:modelValue', v)"
    >
      <template #empty>
        {{ $t('@NODECFG:暂无输入参数') }}
      </template>

      <template #row="{ item: row, index: idx }">
        <div class="input-row">
          <div class="input-field name-field">
            <label class="field-label">{{ $t('@NODECFG:参数名') }}</label>
            <el-input
              v-model="row.name"
              :placeholder="$t('@NODECFG:参数名')"
              @update:model-value="(v: string) => updateRow(idx, { name: v })"
            />
          </div>

          <div class="input-field type-field">
            <label class="field-label">{{ $t('@NODECFG:参数值') }}</label>
            <el-select
              v-model="row.source"
              style="width: 110px"
              @update:model-value="(v: 'reference' | 'manual') => updateRow(idx, { source: v })"
            >
              <el-option :label="$t('@NODECFG:引用')" value="reference" :disabled="!predecessorNodes || predecessorNodes.length === 0" />
              <el-option :label="$t('@NODECFG:手动')" value="manual" />
            </el-select>
          </div>

          <div class="input-field value-field">
            <label class="field-label">{{ $t('@NODECFG:值') }}</label>

            <el-input
              v-if="row.source === 'manual'"
              v-model="row.manualValue"
              :placeholder="$t('@NODECFG:请输入')"
              @update:model-value="(v: string) => updateRow(idx, { manualValue: v })"
            />

            <el-tree-select
              v-else
              :model-value="getCurrentReferenceValue(row)"
              :data="treeSelectOptions"
              :placeholder="$t('@NODEINPUT:选择节点输出')"
              clearable
              filterable
              check-strictly
              :render-after-expand="false"
              @update:model-value="(v: string) => handleReferenceSelect(idx, v)"
            />
          </div>

          <div class="input-field action-field">
            <label class="field-label">{{ $t('@NODEINPUT:必填') }}</label>
            <el-switch
              :model-value="Boolean(row.required)"
              @update:model-value="(v: boolean) => updateRow(idx, { required: v })"
            />
          </div>
        </div>
      </template>
    </ParamListContainer>
  </div>
</template>

<style scoped lang="scss">
.code-node-input-config {
  width: 100%;
}

.sub-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--spacing-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.empty-tip {
  color: var(--text-tertiary);
  font-size: var(--font-size-base);
  padding: 12px 0;
}

.input-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.input-row {
  display: grid;
  grid-template-columns: 220px 130px 1fr 90px;
  gap: var(--spacing-md);
  align-items: end;
}

.field-label {
  display: block;
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  margin-bottom: var(--spacing-sm);
}

.value-field :deep(.el-tree-select) {
  width: 100%;
}

.action-field {
  display: flex;
  justify-content: flex-end;
}
</style>

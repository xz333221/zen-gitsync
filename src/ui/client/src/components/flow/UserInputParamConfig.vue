<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Link } from '@element-plus/icons-vue'
import type { UserInputParam } from '@stores/configStore'
import type { FlowNode } from './FlowOrchestrationWorkspace.vue'
import ParamListContainer from './ParamListContainer.vue'
import { $t } from '@/lang/static'

const props = defineProps<{
  modelValue: UserInputParam[]
  predecessorNodes?: FlowNode[]
  title?: string | undefined
  addable?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: UserInputParam[]): void
}>()

const params = ref<UserInputParam[]>([])

watch(
  () => props.modelValue,
  (val) => {
    params.value = Array.isArray(val) ? [...val] : []
  },
  { immediate: true, deep: true }
)

function createDefaultRow(): UserInputParam {
  return {
    name: '',
    source: 'manual',
    defaultValue: '',
    required: false
  }
}

function addRow() {
  const updated = [...params.value, createDefaultRow()]
  params.value = updated
  emit('update:modelValue', updated)
}

defineExpose({ addRow })

function updateRow(index: number, patch: Partial<UserInputParam>) {
  if (!params.value[index]) return

  const updated = [...params.value]
  updated[index] = { ...updated[index], ...patch }

  if (patch.source) {
    if (patch.source === 'manual') {
      updated[index].ref = undefined
      if (updated[index].defaultValue === undefined) updated[index].defaultValue = ''
    } else {
      updated[index].defaultValue = undefined
      if (!updated[index].ref) updated[index].ref = { nodeId: '', outputKey: 'stdout' }
    }
  }

  params.value = updated
  emit('update:modelValue', updated)
}

function getNodeDisplayName(node: FlowNode): string {
  if (node.type === 'command') {
    return (node.data.config as any)?.displayName || node.data.config?.commandName || node.data.label || $t('@FLOWNODE:命令节点')
  }
  if (node.type === 'code') {
    return (node.data.config as any)?.displayName || node.data.label || $t('@FLOWNODE:代码节点')
  }
  if (node.type === 'user_input') {
    return (node.data.config as any)?.displayName || node.data.label || $t('@FLOWNODE:用户输入')
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
  if (node.type === 'user_input') {
    const cfg: any = (node.data as any)?.config
    const list = Array.isArray(cfg?.userInputParams) ? cfg.userInputParams : []
    return list
      .map((p: any) => String(p?.name || '').trim())
      .filter((k: string) => Boolean(k))
      .map((k: string) => ({ key: k, label: k }))
  }
  return []
}

const treeSelectOptions = computed(() => {
  if (!props.predecessorNodes || props.predecessorNodes.length === 0) return []

  return props.predecessorNodes.map((node) => ({
    value: node.id,
    label: getNodeDisplayName(node),
    children: getNodeOutputOptions(node).map((opt: any) => ({
      value: `${node.id}::${opt.key}`,
      label: opt.label
    }))
  }))
})

function handleReferenceSelect(index: number, value: string) {
  if (!value) return
  const [nodeId, outputKey] = value.split('::')
  updateRow(index, { ref: { nodeId, outputKey } })
}

function getCurrentReferenceValue(row: UserInputParam): string {
  if (row.ref?.nodeId && row.ref?.outputKey) {
    return `${row.ref.nodeId}::${row.ref.outputKey}`
  }
  return ''
}
</script>

<template>
  <div class="user-input-param-config">
    <ParamListContainer
      :model-value="params"
      :title="title"
      :addable="addable !== false"
      :removable="true"
      :min-items="0"
      :create-item="createDefaultRow"
      @update:modelValue="(v: UserInputParam[]) => emit('update:modelValue', v)"
    >
      <template #empty>
        {{ $t('@UINPUT:暂无输入参数') }}
      </template>

      <template #row="{ item: row, index: idx }">
        <div class="input-row">
          <div class="input-field name-field">
            <label class="field-label">{{ $t('@UINPUT:参数名') }}</label>
            <el-input
              v-model="row.name"
              :placeholder="$t('@UINPUT:参数名')"
              @update:model-value="(v: string) => updateRow(idx, { name: v })"
            />
          </div>

          <div class="input-field type-field">
            <label class="field-label">{{ $t('@UINPUT:类型') }}</label>
            <el-select
              v-model="row.source"
              style="width: 130px"
              @update:model-value="(v: 'reference' | 'manual') => updateRow(idx, { source: v })"
            >
              <el-option :label="$t('@UINPUT:手动输入')" value="manual" />
              <el-option :label="$t('@UINPUT:引用')" value="reference" :disabled="!props.predecessorNodes || props.predecessorNodes.length === 0" />
            </el-select>
          </div>

          <div class="input-field value-field">
            <label class="field-label">{{ row.source === 'manual' ? $t('@UINPUT:默认值') : $t('@UINPUT:引用输出') }}</label>

            <el-input
              v-if="row.source === 'manual'"
              v-model="row.defaultValue"
              :placeholder="$t('@UINPUT:默认值')"
              clearable
              @update:model-value="(v: string) => updateRow(idx, { defaultValue: v })"
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
            >
              <template #default="{ data }">
                <span class="tree-node-label">
                  <el-icon v-if="!data.children"><Link /></el-icon>
                  {{ data.label }}
                </span>
              </template>
            </el-tree-select>
          </div>

          <div class="input-field action-field">
            <label class="field-label">{{ $t('@NODEINPUT:必填') }}</label>
            <el-switch :model-value="Boolean(row.required)" @update:model-value="(v: boolean) => updateRow(idx, { required: v })" />
          </div>
        </div>
      </template>

      <template #actions>
        <el-button v-if="addable !== false" type="primary" plain size="small" @click="addRow">
          {{ $t('@UINPUT:添加参数') }}
        </el-button>
      </template>
    </ParamListContainer>
  </div>
</template>

<style scoped lang="scss">
.user-input-param-config {
  width: 100%;
}

.input-row {
  display: grid;
  grid-template-columns: 220px 150px 1fr 90px;
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

.tree-node-label {
  display: flex;
  align-items: center;
  gap: 6px;

  .el-icon {
    color: var(--color-primary);
    font-size: 14px;
  }
}
</style>

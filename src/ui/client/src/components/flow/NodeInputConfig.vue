<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { Link } from '@element-plus/icons-vue'
import type { NodeInput } from '@stores/configStore'
import type { FlowNode } from './FlowOrchestrationWorkspace.vue'

const props = defineProps<{
  modelValue: NodeInput[]
  paramNames: string[]  // 参数名列表（从命令变量中提取）
  disableParamNameEdit?: boolean  // 是否禁用参数名编辑
  predecessorNodes?: FlowNode[]  // 前置节点列表（用于引用）
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: NodeInput[]): void
}>()

// 本地输入配置
const inputs = ref<NodeInput[]>([])

// 监听外部值变化
watch(() => props.modelValue, (newVal) => {
  inputs.value = newVal ? [...newVal] : []
}, { immediate: true, deep: true })

// 监听参数名变化，自动同步
watch(() => props.paramNames, (newParams) => {
  if (!newParams || newParams.length === 0) {
    inputs.value = []
    emit('update:modelValue', [])
    return
  }
  
  // 保留已有配置，新增参数
  const existingMap = new Map(inputs.value.map(inp => [inp.paramName, inp]))
  const newInputs: NodeInput[] = []
  
  for (const paramName of newParams) {
    if (existingMap.has(paramName)) {
      newInputs.push(existingMap.get(paramName)!)
    } else {
      newInputs.push({
        paramName,
        inputType: 'manual',
        manualValue: ''
      })
    }
  }
  
  inputs.value = newInputs
  emit('update:modelValue', newInputs)
}, { immediate: true })

// 更新输入配置
function updateInput(index: number, field: keyof NodeInput, value: any) {
  if (!inputs.value[index]) return
  
  const updated = [...inputs.value]
  updated[index] = { ...updated[index], [field]: value }
  
  // 切换输入类型时清空对应的值
  if (field === 'inputType') {
    if (value === 'manual') {
      updated[index].referenceNodeId = undefined
      updated[index].referenceOutputKey = undefined
    } else {
      updated[index].manualValue = undefined
    }
  }
  
  inputs.value = updated
  emit('update:modelValue', updated)
}

// 获取节点显示名称
function getNodeDisplayName(node: FlowNode): string {
  if (node.type === 'command') {
    return node.data.config?.commandName || node.data.label || '命令节点'
  }
  return node.data.label || node.id
}

// 获取节点输出选项
function getNodeOutputOptions(node: FlowNode) {
  if (node.type === 'command') {
    return [
      { key: 'stdout', label: '标准输出 (stdout)' },
      { key: 'stderr', label: '标准错误 (stderr)' }
    ]
  }
  return []
}

// 构建树形选择数据
const treeSelectOptions = computed(() => {
  if (!props.predecessorNodes || props.predecessorNodes.length === 0) {
    return []
  }
  
  return props.predecessorNodes.map(node => ({
    value: node.id,
    label: getNodeDisplayName(node),
    children: getNodeOutputOptions(node).map(opt => ({
      value: `${node.id}::${opt.key}`,
      label: opt.label
    }))
  }))
})

// 选择引用节点
function handleReferenceSelect(index: number, value: string) {
  if (!value) return
  
  // 格式: nodeId::outputKey
  const [nodeId, outputKey] = value.split('::')
  
  const updated = [...inputs.value]
  updated[index] = {
    ...updated[index],
    referenceNodeId: nodeId,
    referenceOutputKey: outputKey
  }
  
  inputs.value = updated
  emit('update:modelValue', updated)
}

// 获取当前引用值（用于显示）
function getCurrentReferenceValue(input: NodeInput): string {
  if (input.referenceNodeId && input.referenceOutputKey) {
    return `${input.referenceNodeId}::${input.referenceOutputKey}`
  }
  return ''
}
</script>

<template>
  <div class="node-input-config">
    <div v-if="inputs.length === 0" class="empty-tip">
      命令中未检测到变量参数
    </div>
    
    <div v-else class="input-list">
      <div v-for="(input, index) in inputs" :key="input.paramName" class="input-item">
        <div class="input-row">
          <!-- 参数名 -->
          <div class="input-field param-name-field">
            <label class="field-label">参数名</label>
            <el-input 
              :model-value="input.paramName"
              :disabled="disableParamNameEdit"
              placeholder="参数名"
              size="default"
              @update:model-value="(val: string) => updateInput(index, 'paramName', val)"
            />
          </div>
          
          <!-- 输入类型选择 -->
          <div class="input-field type-field">
            <label class="field-label">类型</label>
            <el-select 
              :model-value="input.inputType"
              placeholder="选择类型"
              size="default"
              @update:model-value="(val: 'reference' | 'manual') => updateInput(index, 'inputType', val)"
            >
              <el-option value="manual" label="手动输入" />
              <el-option value="reference" label="引用节点" :disabled="!predecessorNodes || predecessorNodes.length === 0" />
            </el-select>
          </div>
          
          <!-- 值配置 -->
          <div class="input-field value-field">
            <label class="field-label">值</label>
            
            <!-- 手动输入 -->
            <el-input 
              v-if="input.inputType === 'manual'"
              :model-value="input.manualValue"
              placeholder="输入参数值"
              size="default"
              clearable
              @update:model-value="(val: string) => updateInput(index, 'manualValue', val)"
            />
            
            <!-- 引用选择 -->
            <el-tree-select
              v-else
              :model-value="getCurrentReferenceValue(input)"
              :data="treeSelectOptions"
              placeholder="选择节点输出"
              size="default"
              clearable
              filterable
              check-strictly
              :render-after-expand="false"
              @update:model-value="(val: string) => handleReferenceSelect(index, val)"
            >
              <template #default="{ data }">
                <span class="tree-node-label">
                  <el-icon v-if="!data.children"><Link /></el-icon>
                  {{ data.label }}
                </span>
              </template>
            </el-tree-select>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.node-input-config {
  .empty-tip {
    color: var(--text-tertiary);
    font-size: var(--font-size-sm);
    padding: var(--spacing-lg);
    text-align: center;
    background: var(--bg-component-area);
    border-radius: var(--radius-md);
  }
  
  .input-list {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-md);
  }
  
  .input-item {
    padding: var(--spacing-md);
    background: var(--bg-component-area);
    border-radius: var(--radius-md);
    border: 1px solid var(--border-component);
    transition: var(--transition-all);
    
    &:hover {
      border-color: var(--color-primary);
      box-shadow: var(--shadow-sm);
    }
  }
  
  .input-row {
    display: grid;
    grid-template-columns: 200px 150px 1fr;
    gap: var(--spacing-md);
    align-items: end;
  }
  
  .input-field {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-sm);
    
    .field-label {
      font-size: var(--font-size-sm);
      color: var(--text-secondary);
      font-weight: var(--font-weight-medium);
    }
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
}
</style>

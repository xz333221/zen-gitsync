<script setup lang="ts">
import { defineProps, defineEmits } from 'vue'

interface Props {
  modelValue: boolean
  title: string
  tooltip?: string
  activeText?: string
  inactiveText?: string
  activeColor?: string
  iconClass?: string
}

defineProps<Props>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

function onChange(val: boolean) {
  emit('update:modelValue', val)
}
</script>

<template>
  <div class="option-card compact">
    <el-tooltip :content="tooltip" placement="top" :hide-after="1000" :show-after="200">
      <div class="option-header">
        <div class="option-icon" :class="iconClass">
          <slot name="icon" />
        </div>
        <div class="option-info">
          <h4 class="option-title">{{ title }}</h4>
        </div>
        <el-switch
          class="option-switch"
          :model-value="modelValue"
          @update:modelValue="onChange"
          :active-text="activeText"
          :inactive-text="inactiveText"
          :active-color="activeColor"
          size="small"
        />
      </div>
    </el-tooltip>
  </div>
</template>

<style scoped>
.option-card {
  background: linear-gradient(135deg, #ffffff 0%, #f8f9fa 100%);
  border: 1px solid #e9ecef;
  border-radius: 8px;
  padding: 8px;
  transition: all 0.3s ease;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.option-card.compact {
  padding: 4px 8px;
}

.option-card:hover {
  border-color: #409eff;
  box-shadow: 0 2px 8px rgba(64, 158, 255, 0.1);
  transform: translateY(-1px);
}

.option-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.option-icon {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #409eff;
  color: white;
  font-size: 10px;
  flex-shrink: 0;
}

.option-icon.warning { background: #f56c6c; }
.option-icon.success { background: #67c23a; }

.option-info { flex: 1; min-width: 0; }

.option-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: #303133;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.option-switch :deep(.el-switch__label) {
  font-size: 11px;
  font-weight: 500;
}

.option-switch :deep(.el-switch__label.is-active) {
  color: #409eff;
}
</style>

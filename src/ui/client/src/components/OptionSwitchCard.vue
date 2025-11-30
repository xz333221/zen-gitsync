<script setup lang="ts">
interface Props {
  modelValue: boolean
  title: string
  tooltip?: string
  activeText?: string
  inactiveText?: string
  activeColor?: string
  iconClass?: string
  compact?: boolean
}

const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

function onChange(val: boolean) {
  emit('update:modelValue', val)
}
</script>

<template>
  <div class="option-card" :class="{ compact: props.compact }">
    <el-tooltip :content="tooltip" placement="top"  :show-after="200">
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
  background: linear-gradient(135deg, var(--bg-container) 0%, #f8f9fa 100%);
  border: 1px solid var(--border-component);
  border-radius: var(--radius-lg);
  padding: var(--spacing-base);
  transition: all 0.3s ease;
  box-shadow: var(--shadow-sm);
}

.option-card.compact {
  padding: var(--spacing-sm) var(--spacing-base);
  min-width: 120px;
}

.option-card:hover {
  border-color: var(--color-primary);
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}

.option-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
}

.option-icon {
  width: 18px;
  height: 18px;
  border-radius: var(--radius-base);
  display: none;
  align-items: center;
  justify-content: center;
  background: var(--color-primary);
  color: white;
  font-size: var(--font-size-xs);
  flex-shrink: 0;
}

.option-icon.warning { background: var(--color-danger); }
.option-icon.success { background: var(--color-success); }

.option-info { flex: 1; min-width: 0; }

.option-title {
  margin: 0;
  font-size: var(--font-size-sm);
  font-weight: 600;
  
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
  color: var(--color-primary);
}
</style>

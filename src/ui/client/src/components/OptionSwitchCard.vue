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
        <div v-if="iconClass || $slots.icon" class="option-icon" :class="iconClass">
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
  background: var(--bg-container);
  border: 1px solid var(--border-component);
  border-radius: var(--dialog-radius-sm);
  padding: var(--spacing-md);
  transition: var(--dialog-transition);
  box-shadow: var(--shadow-sm);
}

.option-card.compact {
  padding: var(--spacing-sm) var(--spacing-md);
  min-width: 120px;
}

.option-card:hover {
  border-color: var(--color-primary);
  box-shadow: var(--shadow-md);
  transform: scale(1.02);
}

.option-card:active {
  transform: scale(0.98);
}

.option-card:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.option-header {
  display: flex;
  align-items: center;
}

.option-icon {
  width: 20px;
  height: 20px;
  border-radius: var(--btn-radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-primary);
  color: white;
  font-size: var(--font-size-xs);
  flex-shrink: 0;
  transition: var(--dialog-transition);
}

.option-icon.warning { background: var(--color-danger); }
.option-icon.success { background: var(--color-success); }
.option-icon.info { background: var(--color-info); }

.option-info { flex: 1; min-width: 0; }

.option-title {
  margin: 0;
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--text-primary);
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.option-switch :deep(.el-switch__label) {
  font-size: 12px;
  font-weight: 500;
}

.option-switch :deep(.el-switch__label.is-active) {
  color: var(--color-primary);
}

/* Switch 样式统一 */
.option-switch :deep(.el-switch) {
  --el-switch-off-color: var(--border-color-medium);
}
</style>

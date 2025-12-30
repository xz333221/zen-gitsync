<script setup lang="ts">
import { computed } from 'vue'
import { Plus, Delete } from '@element-plus/icons-vue'

const props = defineProps<{
  modelValue: any[]
  title?: string
  addable?: boolean
  removable?: boolean
  minItems?: number
  createItem?: () => any
  itemKey?: (item: any, index: number) => string | number
  disableAdd?: boolean
  disableRemove?: (item: any, index: number) => boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: any[]): void
  (e: 'add'): void
  (e: 'remove', index: number): void
}>()

const items = computed(() => (Array.isArray(props.modelValue) ? props.modelValue : []))

function doAdd() {
  if (!props.addable) return
  if (props.disableAdd) return
  const factory = props.createItem
  if (!factory) return
  const next = [...items.value, factory()]
  emit('update:modelValue', next)
  emit('add')
}

function doRemove(index: number) {
  if (!props.removable) return
  const min = typeof props.minItems === 'number' ? props.minItems : 0
  if (items.value.length <= min) return
  const item = items.value[index]
  if (props.disableRemove && props.disableRemove(item, index)) return
  const next = [...items.value]
  next.splice(index, 1)
  emit('update:modelValue', next)
  emit('remove', index)
}

function getKey(item: any, index: number) {
  if (props.itemKey) return props.itemKey(item, index)
  return index
}
</script>

<template>
  <div class="param-list">
    <div v-if="title !== undefined || addable" class="param-list__title">
      <span v-if="title" class="param-list__title-text">{{ title }}</span>
      <div class="param-list__title-actions">
        <slot name="title-actions" />
        <el-button v-if="addable" type="primary" plain :icon="Plus" :disabled="disableAdd || !createItem" @click="doAdd" />
      </div>
    </div>

    <div v-if="items.length === 0" class="param-list__empty">
      <slot name="empty" />
    </div>

    <div v-else class="param-list__body">
      <div
        v-for="(item, index) in items"
        :key="getKey(item, index)"
        class="param-list__row"
        :class="{ 'param-list__row--no-actions': !removable }"
      >
        <div class="param-list__row-content">
          <slot name="row" :item="item" :index="index" />
        </div>
        <div v-if="removable" class="param-list__row-actions">
          <el-button
            type="danger"
            plain
            :icon="Delete"
            :disabled="(typeof minItems === 'number' && items.length <= minItems) || (disableRemove ? disableRemove(item, index) : false)"
            @click="doRemove(index)"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.param-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.param-list__title {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
}

.param-list__title-text {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.param-list__title-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.param-list__empty {
  color: var(--text-tertiary);
  font-size: var(--font-size-sm);
  padding: var(--spacing-lg);
  text-align: center;
  background: var(--bg-component-area);
  border-radius: var(--radius-md);
}

.param-list__body {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.param-list__row {
  display: grid;
  grid-template-columns: 1fr 44px;
  gap: var(--spacing-md);
  align-items: start;
  padding: var(--spacing-md);
  background: var(--bg-component-area);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-component);
  transition: var(--transition-all);
}

.param-list__row.param-list__row--no-actions {
  grid-template-columns: 1fr;
}

.param-list__row:hover {
  border-color: var(--color-primary);
  box-shadow: var(--shadow-sm);
}

.param-list__row-content {
  min-width: 0;
}

.param-list__row-actions {
  display: flex;
  justify-content: flex-end;
}
</style>

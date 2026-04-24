<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Folder } from '@element-plus/icons-vue'
import CommonDialog from '@components/CommonDialog.vue'

interface DirItem {
  name: string
  path: string
}

interface DirData {
  path: string
  parentPath: string | null
  items: DirItem[]
}

interface Props {
  modelValue: boolean
  initialPath?: string
}

const props = withDefaults(defineProps<Props>(), {
  initialPath: ''
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'select': [path: string]
}>()

const currentDirData = ref<DirData | null>(null)
const loading = ref(false)

async function fetchDirectory(path: string) {
  loading.value = true
  try {
    const response = await fetch('/api/browse_directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPath: path })
    })
    const result = await response.json()
    if (result.success) {
      currentDirData.value = result
    } else {
      ElMessage.error(result.error || '加载目录失败')
    }
  } catch (error) {
    ElMessage.error(`浏览目录失败: ${(error as Error).message}`)
  } finally {
    loading.value = false
  }
}

function handleNavigate(path: string) {
  fetchDirectory(path)
}

function handleConfirm() {
  if (currentDirData.value?.path) {
    emit('select', currentDirData.value.path)
  }
  emit('update:modelValue', false)
}

function handleClose() {
  emit('update:modelValue', false)
}

watch(() => props.modelValue, (val) => {
  if (val) {
    fetchDirectory(props.initialPath || '')
  } else {
    currentDirData.value = null
  }
})
</script>

<template>
  <CommonDialog
    :model-value="modelValue"
    title="浏览并选择目录"
    size="small"
    :show-footer="true"
    confirm-text="确定"
    :append-to-body="true"
    :destroy-on-close="true"
    @update:model-value="handleClose"
    @confirm="handleConfirm"
    @cancel="handleClose"
  >
    <div class="dir-browser" v-loading="loading">
      <!-- 当前路径 -->
      <div class="current-path" v-if="currentDirData">
        <span class="path-label">当前路径：</span>
        <span class="path-value" :title="currentDirData.path">{{ currentDirData.path }}</span>
      </div>

      <!-- 目录列表 -->
      <div class="dir-list" v-if="currentDirData">
        <!-- 返回上级 -->
        <div
          v-if="currentDirData.parentPath"
          class="dir-item dir-item--parent"
          @click="handleNavigate(currentDirData.parentPath)"
        >
          <el-icon class="dir-icon dir-icon--parent"><Folder /></el-icon>
          <span class="dir-name">返回上级目录</span>
        </div>

        <!-- 子目录列表 -->
        <div
          v-for="item in currentDirData.items"
          :key="item.path"
          class="dir-item"
          @click="handleNavigate(item.path)"
        >
          <el-icon class="dir-icon"><Folder /></el-icon>
          <span class="dir-name" :title="item.name">{{ item.name }}</span>
        </div>

        <div v-if="!currentDirData.parentPath && currentDirData.items.length === 0" class="dir-empty">
          此目录下没有子目录
        </div>
      </div>
    </div>
  </CommonDialog>
</template>

<style scoped lang="scss">
.dir-browser {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-base);
  min-height: 280px;
}

.current-path {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-base);
  background: var(--bg-panel);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);

  .path-label {
    flex-shrink: 0;
    font-weight: 500;
    color: var(--text-secondary);
    white-space: nowrap;
  }

  .path-value {
    font-family: var(--font-mono);
    color: var(--text-title);
    word-break: break-all;
    line-height: 1.4;
  }
}

.dir-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-card);
  border-radius: var(--radius-md);
  overflow: hidden;
  overflow-y: auto;
  max-height: 320px;
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb) transparent;
}

.dir-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  padding: var(--spacing-base) var(--spacing-md);
  cursor: pointer;
  transition: background 0.15s ease;
  border-bottom: 1px solid var(--border-card);
  font-size: var(--font-size-sm);

  &:last-child {
    border-bottom: none;
  }

  &:hover {
    background: var(--bg-input-hover);
  }

  &--parent {
    background: var(--bg-panel);
    font-weight: 500;

    &:hover {
      background: var(--bg-container-hover);
    }
  }
}

.dir-icon {
  font-size: var(--font-size-lg);
  color: var(--color-primary);
  flex-shrink: 0;

  &--parent {
    color: var(--color-warning);
  }
}

.dir-name {
  color: var(--text-title);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dir-empty {
  padding: var(--spacing-xl) var(--spacing-md);
  text-align: center;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}
</style>

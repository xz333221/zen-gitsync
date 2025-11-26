<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { Folder, Refresh, Loading } from '@element-plus/icons-vue'

export interface PackageFile {
  path: string
  relativePath: string
  name: string
  version: string
  displayName: string
  fullPath: string
}

export interface PackageJsonSelectorEmits {
  (e: 'update:modelValue', value: string): void
  (e: 'change', packageFile: PackageFile | null): void
}

const props = defineProps<{
  modelValue: string
  placeholder?: string
  clearable?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<PackageJsonSelectorEmits>()

// 状态管理
const loading = ref(false)
const packageFiles = ref<PackageFile[]>([])
const selectedValue = ref('')

// 计算属性
const computedValue = computed({
  get: () => props.modelValue,
  set: (value) => {
    selectedValue.value = value
    emit('update:modelValue', value)
    
    // 找到对应的package文件并触发change事件
    const selectedPackage = packageFiles.value.find(pkg => pkg.fullPath === value)
    emit('change', selectedPackage || null)
  }
})

// 选项列表
const options = computed(() => {
  return packageFiles.value.map(pkg => ({
    label: pkg.displayName,
    value: pkg.fullPath,
    relativePath: pkg.relativePath,
    version: pkg.version
  }))
})

// 扫描package.json文件
async function scanPackageFiles() {
  loading.value = true
  try {
    const response = await fetch('/api/scan-package-files')
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    
    const data = await response.json()
    if (data.success) {
      packageFiles.value = data.packages || []
      
      // 如果当前选中的值不在新的列表中，清空选择
      if (computedValue.value && !packageFiles.value.some(pkg => pkg.fullPath === computedValue.value)) {
        computedValue.value = ''
      }
      
    //   ElMessage.success(`扫描完成，找到 ${packageFiles.value.length} 个 package.json 文件`)
    } else {
      throw new Error(data.error || '扫描失败')
    }
  } catch (error: any) {
    console.error('扫描package.json文件失败:', error)
    ElMessage.error(`扫描失败: ${error.message}`)
    packageFiles.value = []
  } finally {
    loading.value = false
  }
}

// 组件挂载时自动扫描
scanPackageFiles()

// 监听modelValue变化，同步到内部状态
watch(() => props.modelValue, (newValue) => {
  selectedValue.value = newValue
}, { immediate: true })
</script>

<template>
  <div class="package-json-selector">
    <div class="selector-container">
      <el-select
        v-model="computedValue"
        :placeholder="placeholder || '选择 package.json 文件'"
        :clearable="clearable"
        :disabled="disabled || loading"
        filterable
        class="package-select"
      >
        <el-option
          v-for="option in options"
          :key="option.value"
          :label="option.label"
          :value="option.value"
        >
          <div class="option-content">
            <div class="option-main">
              <el-icon class="folder-icon"><Folder /></el-icon>
              <span class="package-name">{{ option.label }}</span>
            </div>
            <div class="option-path">{{ option.relativePath }}</div>
          </div>
        </el-option>
      </el-select>
      
      <el-button
        :icon="loading ? Loading : Refresh"
        :loading="loading"
        :disabled="disabled"
        size="default"
        @click="scanPackageFiles"
        class="refresh-btn"
      >
        {{ loading ? '扫描中...' : '刷新' }}
      </el-button>
    </div>
    
    <div v-if="packageFiles.length === 0 && !loading" class="empty-hint">
      <el-text type="info" size="small">
        未找到 package.json 文件，请确保项目包含有效的 package.json
      </el-text>
    </div>
  </div>
</template>

<style scoped lang="scss">
.package-json-selector {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.selector-container {
  display: flex;
  gap: 8px;
  align-items: center;
}

.package-select {
  flex: 1;
  min-width: 0;
}

.refresh-btn {
  flex-shrink: 0;
}

.option-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
}

.option-main {
  display: flex;
  align-items: center;
  gap: 6px;
}

.folder-icon {
  font-size: 14px;
  color: #67c23a;
  flex-shrink: 0;
}

.package-name {
  font-weight: 500;
  color: var(--text-title);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.option-path {
  font-size: 11px;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  margin-left: 20px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty-hint {
  padding: 8px 12px;
  background: var(--bg-panel);
  border: 1px solid var(--border-component);
  border-radius: 4px;
  text-align: center;
}

// 深色主题适配
[data-theme="dark"] {
  .folder-icon {
    color: #95d475;
  }
}
</style>

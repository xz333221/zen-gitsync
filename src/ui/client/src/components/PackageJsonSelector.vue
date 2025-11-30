<script setup lang="ts">
import { ref, watch, computed, h } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Folder, Refresh, Loading, FolderAdd } from '@element-plus/icons-vue'

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
async function scanPackageFiles(directory?: string) {
  loading.value = true
  try {
    // 构建URL，如果提供了目录参数则添加到查询字符串
    const url = directory 
      ? `/api/scan-package-files?directory=${encodeURIComponent(directory)}`
      : '/api/scan-package-files'
    
    const response = await fetch(url)
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
      
      const dirInfo = directory ? `目录 ${directory}` : '当前项目'
      ElMessage.success(`扫描 ${dirInfo} 完成，找到 ${packageFiles.value.length} 个 package.json 文件`)
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

// 打开目录浏览器
async function browseDirectory() {
  try {
    const response = await fetch('/api/browse_directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPath: '' // 空字符串表示使用当前工作目录
      })
    })
    const result = await response.json()
    if (result.success) {
      selectDirectoryDialog(result)
    } else if (result.error) {
      ElMessage.error(result.error)
    }
  } catch (error) {
    ElMessage.error(`浏览目录失败: ${(error as Error).message}`)
  }
}

// 显示目录选择对话框
function selectDirectoryDialog(directoryData: any) {
  if (!directoryData || !directoryData.items) return
  
  ElMessageBox.alert(
    h('div', { class: 'directory-browser' }, [
      h('div', { class: 'current-path' }, [
        h('span', { class: 'path-label' }, '当前路径：'),
        h('span', { class: 'path-value' }, directoryData.path)
      ]),
      h('div', { class: 'directory-list' }, [
        directoryData.parentPath
          ? h(
              'div',
              {
                class: 'directory-item parent-dir',
                onClick: () => selectDirectory(directoryData.parentPath)
              },
              [
                h(
                  'span',
                  { class: 'dir-icon' },
                  h(
                    'svg',
                    {
                      class: 'folder-icon',
                      viewBox: '0 0 24 24',
                      width: '20',
                      height: '20',
                      style: { fill: '#E6A23C' }
                    },
                    [
                      h('path', {
                        d: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z'
                      })
                    ]
                  )
                ),
                h('span', { class: 'dir-name' }, '返回上级目录')
              ]
            )
          : null,
        ...directoryData.items.map((item: any) =>
          h(
            'div',
            {
              class: 'directory-item',
              onClick: () => selectDirectory(item.path)
            },
            [
              h(
                'span',
                { class: 'dir-icon' },
                h(
                  'svg',
                  {
                    class: 'folder-icon',
                    viewBox: '0 0 24 24',
                    width: '20',
                    height: '20',
                    style: { fill: '#409EFF' }
                  },
                  [
                    h('path', {
                      d: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z'
                    })
                  ]
                )
              ),
              h('span', { class: 'dir-name' }, item.name)
            ]
          )
        )
      ])
    ]),
    '浏览并选择目录',
    {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      showCancelButton: true,
      customClass: 'directory-browser-dialog',
      callback: (action: string) => {
        if (action === 'confirm') {
          // 用户确认选择，扫描该目录
          scanPackageFiles(directoryData.path)
        }
      }
    }
  )
}

// 选择目录后刷新对话框
async function selectDirectory(dirPath: string) {
  try {
    ElMessageBox.close()
    setTimeout(async () => {
      try {
        const response = await fetch('/api/browse_directory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPath: dirPath })
        })
        const result = await response.json()
        if (result.success) {
          selectDirectoryDialog(result)
        } else if (result.error) {
          ElMessage.error(result.error)
        }
      } catch (error) {
        ElMessage.error(`浏览目录失败: ${(error as Error).message}`)
      }
    }, 100)
  } catch (error) {
    ElMessage.error(`处理目录选择时出错: ${(error as Error).message}`)
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
        @click="scanPackageFiles()"
        class="refresh-btn"
        title="刷新当前项目"
      >
        {{ loading ? '扫描中...' : '刷新' }}
      </el-button>
      
      <el-button
        :icon="FolderAdd"
        :disabled="disabled || loading"
        size="default"
        @click="browseDirectory"
        class="custom-dir-btn"
        title="浏览并选择其他目录"
      >
        其他目录
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
  gap: var(--spacing-base);
}

.selector-container {
  display: flex;
  gap: var(--spacing-base);
  align-items: center;
}

.package-select {
  flex: 1;
  min-width: 0;
}

.refresh-btn,
.custom-dir-btn {
  flex-shrink: 0;
}

.option-content {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
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
  margin-left: var(--spacing-xl);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty-hint {
  padding: var(--spacing-base) var(--spacing-md);
  background: var(--bg-panel);
  border: 1px solid var(--border-component);
  border-radius: var(--radius-base);
  text-align: center;
}

// 深色主题适配
[data-theme="dark"] {
  .folder-icon {
    color: #95d475;
  }
}
</style>

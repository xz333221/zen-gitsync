<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref, computed } from 'vue'
import { useGitStore } from '@stores/gitStore'
import { useConfigStore } from '@stores/configStore'
import { Setting, Loading, Check } from '@element-plus/icons-vue'
import CommonDialog from '@components/CommonDialog.vue'
import IconButton from '@components/IconButton.vue'
import SvgIcon from '@components/SvgIcon/index.vue'
import { ElMessage } from 'element-plus'

// 定义props
interface Props {
  selectedFiles: string[]
  variant?: 'icon' | 'text'
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'icon'
})

const emit = defineEmits<{
  success: []
}>()

const gitStore = useGitStore()
const configStore = useConfigStore()

// 储藏对话框状态
const isStashDialogVisible = ref(false)
const stashMessage = ref('')
const includeUntracked = ref(true)
const excludeLocked = ref(false)

// 计算是否有选中的文件
const hasSelectedFiles = computed(() => props.selectedFiles.length > 0)

// 计算选中的文件中有多少是锁定的
const lockedFilesInSelection = computed(() => {
  return props.selectedFiles.filter(filePath => {
    const normalizedPath = filePath.replace(/\\/g, '/')
    return configStore.lockedFiles.some((lockedFile: string) => {
      const normalizedLocked = lockedFile.replace(/\\/g, '/')
      return normalizedPath === normalizedLocked
    })
  })
})

// 打开储藏对话框
function openStashDialog() {
  if (!hasSelectedFiles.value) {
    ElMessage.warning($t('@76872:请先选择要储藏的文件'))
    return
  }
  stashMessage.value = ''
  excludeLocked.value = false
  isStashDialogVisible.value = true
}

// 保存储藏
async function saveStash() {
  try {
    let filesToStash = props.selectedFiles
    
    // 如果选择了排除锁定文件，则过滤掉锁定的文件
    if (excludeLocked.value && lockedFilesInSelection.value.length > 0) {
      filesToStash = props.selectedFiles.filter(filePath => {
        const normalizedPath = filePath.replace(/\\/g, '/')
        return !configStore.lockedFiles.some((lockedFile: string) => {
          const normalizedLocked = lockedFile.replace(/\\/g, '/')
          return normalizedPath === normalizedLocked
        })
      })
      
      if (filesToStash.length === 0) {
        ElMessage.warning($t('@76872:所有选中的文件都是锁定文件，无法储藏'))
        return
      }
    }
    
    await gitStore.savePartialStash(filesToStash, stashMessage.value, includeUntracked.value)
    isStashDialogVisible.value = false
    emit('success')
  } catch (error) {
    console.error('储藏选中文件失败:', error)
  }
}

function handleStashMessageKeydown(e: KeyboardEvent) {
  // 避免中文输入法/IME 组合输入时按回车选词误触发
  if ((e as any).isComposing || (e as any).keyCode === 229) return

  // textarea 下保留 Shift+Enter 换行；仅 Enter 触发储藏
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    if (gitStore.isSavingStash) return
    saveStash()
  }
}
</script>

<template>
  <div class="stash-selected-files-button" v-if="hasSelectedFiles">
    <!-- 储藏选中文件按钮 -->
    <IconButton
      v-if="props.variant === 'icon'"
      :tooltip="$t('@76872:储藏选中的文件')"
      size="large"
      :disabled="gitStore.isSavingStash || !hasSelectedFiles"
      hover-color="var(--color-warning)"
      @click="openStashDialog"
    >
      <el-icon v-if="gitStore.isSavingStash" class="is-loading"><Loading /></el-icon>
      <svg-icon v-else icon-class="git-stash" />
    </IconButton>
    <el-button
      v-else
      type="warning"
      class="action-button"
      @click="openStashDialog"
      :loading="gitStore.isSavingStash"
      :disabled="!hasSelectedFiles"
    >
      {{ $t('@76872:储藏选中文件') }} ({{ props.selectedFiles.length }})
    </el-button>

    <!-- Stash弹窗：储藏选中的文件 -->
    <CommonDialog
      v-model="isStashDialogVisible"
      :title="$t('@76872:储藏选中的文件')"
      size="medium"
      :close-on-click-modal="false"
      custom-class="stash-dialog"
    >
      <div class="stash-dialog-content">
        <!-- 功能说明卡片 -->
        <div class="stash-info-card">
          <div class="info-icon">
            <svg-icon icon-class="git-stash" />
          </div>
          <div class="info-content">
            <h4>{{ $t('@76872:储藏选中的文件') }}</h4>
            <p>{{ $t('@76872:将选中的文件更改临时保存，稍后可以重新应用') }}</p>
          </div>
        </div>
        
        <el-form label-position="top" class="stash-form">
          <el-form-item :label="$t('@76872:储藏说明')">
            <el-input 
              v-model="stashMessage" 
              :placeholder="$t('@76872:为这次储藏添加描述信息（可选）')"
              clearable
              @keydown="handleStashMessageKeydown"
              :rows="2"
              type="textarea"
              resize="none"
              maxlength="200"
              show-word-limit
            />
          </el-form-item>
          
          <!-- 选项配置 -->
          <div class="stash-options">
            <h5 class="options-title">
              <el-icon><Setting /></el-icon>
              {{ $t('@76872:储藏选项') }}
            </h5>
            
            <div class="option-item">
              <el-checkbox v-model="includeUntracked" size="large">
                <span class="option-label">{{ $t('@76872:包含未跟踪文件') }}</span>
              </el-checkbox>
              <p class="option-desc">{{ $t('@76872:对于未跟踪的文件，同时储藏 (--include-untracked)') }}</p>
            </div>
            
            <div class="option-item">
              <el-checkbox v-model="excludeLocked" size="large">
                <span class="option-label">{{ $t('@76872:排除锁定文件') }}</span>
              </el-checkbox>
              <p class="option-desc">
                {{ $t('@76872:不储藏被锁定的文件，保持其当前状态') }}
                <span v-if="lockedFilesInSelection.length > 0" class="locked-count">
                  ({{ $t('@76872:选中') }} {{ lockedFilesInSelection.length }} {{ $t('@76872:个锁定文件') }})
                </span>
              </p>
            </div>
          </div>
          
          <!-- 储藏预览信息 -->
          <div class="stash-preview">
            <h5 class="preview-title">
              <svg-icon icon-class="git-stash" style="font-size: 16px;" />
              {{ $t('@76872:将要储藏的文件') }}
            </h5>
            <div class="file-count-info">
              <el-tag type="warning">
                {{ $t('@76872:已选中: ') }}{{ props.selectedFiles.length }} {{ $t('@76872:个文件') }}
              </el-tag>
            </div>
            <div class="file-list-preview">
              <div v-for="file in props.selectedFiles.slice(0, 10)" :key="file" class="file-preview-item">
                {{ file }}
              </div>
              <div v-if="props.selectedFiles.length > 10" class="more-files">
                {{ $t('@76872:...还有') }} {{ props.selectedFiles.length - 10 }} {{ $t('@76872:个文件') }}
              </div>
            </div>
          </div>
        </el-form>
      </div>

      <template #footer>
        <div class="dialog-footer">
          <div class="footer-actions">
            <button type="button" class="dialog-cancel-btn" @click="isStashDialogVisible = false">
              {{ $t('@76872:取消') }}
            </button>
            <button
              type="button"
              class="dialog-confirm-btn"
              @click="saveStash"
              :disabled="gitStore.isSavingStash"
            >
              <el-icon v-if="!gitStore.isSavingStash"><Check /></el-icon>
              <el-icon class="is-loading" v-else><Loading /></el-icon>
              <span>{{ $t('@76872:储藏') }}</span>
            </button>
          </div>
        </div>
      </template>
    </CommonDialog>
  </div>
</template>

<style scoped lang="scss">
.stash-selected-files-button {
  display: inline-block;
}

/* 储藏弹窗样式优化 */
.stash-dialog-content {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-base);
}

.stash-info-card {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-base);
  padding: var(--spacing-base);
  background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
  border: 1px solid #bae6fd;
  border-radius: var(--radius-xl);
  position: relative;
  overflow: hidden;
}

.stash-info-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: linear-gradient(90deg, #0ea5e9 0%, #0284c7 100%);
}

.stash-info-card .info-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%);
  border-radius: 10px;
  color: white;
  font-size: var(--font-size-lg);
  flex-shrink: 0;
  box-shadow: var(--shadow-md);
}

.stash-info-card .info-content {
  flex: 1;
}

.stash-info-card .info-content h4 {
  margin: 0 0 6px 0;
  font-size: var(--font-size-md);
  font-weight: 600;
  color: #0c4a6e;
  line-height: 1.2;
}

.stash-info-card .info-content p {
  margin: 0;
  color: #075985;
  line-height: 1.4;
}

.stash-form {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-base);
}

.stash-form :deep(.el-form-item) {
  margin-bottom: 0;
}

.stash-form :deep(.el-form-item__label) {
  font-weight: 600;
  color: var(--color-text-title);
  margin-bottom: var(--spacing-base);
}

.stash-form :deep(.el-textarea) {
  .el-textarea__inner {
    border-radius: var(--radius-lg);
    border: 2px solid var(--color-gray-200);
    transition: all 0.3s ease;
    line-height: 1.5;
    
    &:hover {
      border-color: var(--color-gray-300);
    }
    
    &:focus {
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
    }
  }
}

.stash-options {
  padding: var(--spacing-base);
  border-radius: var(--radius-xl);
}

.options-title {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  margin: 0 0 var(--spacing-base) 0;
  font-weight: 600;
  color: var(--color-text-title);
}

.options-title :deep(.el-icon) {
  color: var(--color-gray-500);
  font-size: var(--font-size-md);
}

.option-item {
  margin-bottom: var(--spacing-base);
  
  &:last-child {
    margin-bottom: 0;
  }
}

.option-item :deep(.el-checkbox) {
  margin-bottom: var(--spacing-base);
}

.option-label {
  font-weight: 500;
  color: var(--color-text-title);
}

.option-desc {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-gray-500);
  line-height: 1.4;
  padding-left: var(--spacing-2xl);
}

.locked-count {
  color: #f59e0b;
  font-weight: 600;
  margin-left: var(--spacing-xs);
}

.stash-preview {
  padding: var(--spacing-base);
  background: linear-gradient(135deg, #fefce8 0%, #fef3c7 100%);
  border: 1px solid #fbbf24;
  border-radius: var(--radius-xl);
  position: relative;
}

.stash-preview::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: linear-gradient(90deg, var(--git-status-modified) 0%, #d97706 100%);
  border-radius: 12px 12px 0 0;
}

.preview-title {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  font-weight: 600;
  color: #92400e;
  margin-bottom: var(--spacing-base);
}

.preview-title :deep(.el-icon) {
  color: #d97706;
  font-size: var(--font-size-md);
}

.file-count-info {
  display: flex;
  gap: var(--spacing-base);
  flex-wrap: wrap;
  margin-bottom: var(--spacing-base);
}

.file-count-info :deep(.el-tag) {
  border-radius: var(--radius-md);
  padding: var(--spacing-sm) var(--spacing-base);
}

.file-list-preview {
  max-height: 200px;
  overflow-y: auto;
  padding: var(--spacing-sm);
  background: rgba(255, 255, 255, 0.5);
  border-radius: var(--radius-base);
}

.file-preview-item {
  font-size: var(--font-size-sm);
  color: #92400e;
  padding: var(--spacing-xs) 0;
  font-family: monospace;
  word-break: break-all;
}

.more-files {
  font-size: var(--font-size-sm);
  color: #d97706;
  padding-top: var(--spacing-sm);
  font-weight: 500;
  text-align: center;
}

/* 储藏弹窗的CommonDialog样式定制 */
:deep(.stash-dialog) {
  .common-dialog__footer {
    .el-button {
      border-radius: var(--radius-lg);
      font-weight: 500;
      transition: all 0.3s ease;
      
      &:hover {
        transform: translateY(-1px);
      }
    }
  }
}
</style>

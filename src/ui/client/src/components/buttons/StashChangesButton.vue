<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref, computed } from 'vue'
import { useGitStore } from '@stores/gitStore'
import { useConfigStore } from '@stores/configStore'
import { Box, Setting, Document } from '@element-plus/icons-vue'
import CommonDialog from '@components/CommonDialog.vue'

// 定义props
interface Props {
  variant?: 'icon' | 'text'  // icon: 圆形图标按钮, text: 带文字的普通按钮
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'icon'
})

const gitStore = useGitStore()
const configStore = useConfigStore()

// 储藏对话框状态
const isStashDialogVisible = ref(false)
const stashMessage = ref('')
const includeUntracked = ref(true)
const excludeLocked = ref(false)

// 计算是否有变更文件（包括锁定的）
const anyChangesIncludingLocked = computed(() => {
  return gitStore.fileList.some(file => 
    file.type === 'modified' || 
    file.type === 'added' || 
    file.type === 'deleted' || 
    file.type === 'untracked'
  )
})

// 计算是否所有变更都是锁定文件
const allChangesAreLocked = computed(() => {
  if (!anyChangesIncludingLocked.value) return false
  
  const changedFiles = gitStore.fileList.filter(file => 
    file.type === 'modified' || 
    file.type === 'added' || 
    file.type === 'deleted' || 
    file.type === 'untracked'
  )
  
  if (changedFiles.length === 0) return false
  
  return changedFiles.every((file: any) => {
    const normalizedPath = file.path.replace(/\\/g, '/')
    return configStore.lockedFiles.some((lockedFile: string) => {
      const normalizedLocked = lockedFile.replace(/\\/g, '/')
      return normalizedPath === normalizedLocked
    })
  })
})

// 打开储藏对话框
function openStashDialog() {
  stashMessage.value = ''
  if (!allChangesAreLocked.value) {
    excludeLocked.value = false
  }
  isStashDialogVisible.value = true
}

// 保存储藏
async function saveStash() {
  try {
    await gitStore.saveStash(stashMessage.value, includeUntracked.value, excludeLocked.value)
    isStashDialogVisible.value = false
  } catch (error) {
    console.error('储藏失败:', error)
  }
}
</script>

<template>
  <div class="stash-changes-button" v-if="anyChangesIncludingLocked">
    <!-- 储藏更改按钮 -->
    <el-tooltip 
      :content="gitStore.hasConflictedFiles ? $t('@76872:存在冲突文件，请先解决冲突') : $t('@76872:将工作区更改储藏起来')" 
      placement="top"
      :show-after="200"
      :disabled="props.variant === 'text'"
    >
      <el-button 
        type="warning" 
        @click="openStashDialog" 
        :loading="gitStore.isSavingStash"
        :disabled="gitStore.hasConflictedFiles"
        :circle="props.variant === 'icon'"
        :size="props.variant === 'icon' ? 'small' : 'default'"
        :class="props.variant === 'text' ? 'action-button' : ''"
      >
        <el-icon v-if="props.variant === 'icon'"><Box /></el-icon>
        <template v-else>{{ $t('@76872:储藏更改') }}</template>
      </el-button>
    </el-tooltip>

    <!-- Stash弹窗：创建储藏 -->
    <CommonDialog
      v-model="isStashDialogVisible"
      :title="$t('@76872:储藏更改 (Git Stash)')"
      size="medium"
      :close-on-click-modal="false"
      show-footer
      :confirm-text="$t('@76872:储藏')"
      :cancel-text="$t('@76872:取消')"
      :confirm-loading="gitStore.isSavingStash"
      custom-class="stash-dialog"
      @confirm="saveStash"
    >
      <div class="stash-dialog-content">
        <!-- 功能说明卡片 -->
        <div class="stash-info-card">
          <div class="info-icon">
            <el-icon><Box /></el-icon>
          </div>
          <div class="info-content">
            <h4>{{ $t('@76872:储藏工作区更改') }}</h4>
            <p>{{ $t('@76872:将当前工作区的更改临时保存，稍后可以重新应用到任何分支') }}</p>
          </div>
        </div>
        
        <el-form label-position="top" class="stash-form">
          <el-form-item :label="$t('@76872:储藏说明')">
            <el-input 
              v-model="stashMessage" 
              :placeholder="$t('@76872:为这次储藏添加描述信息（可选）')"
              clearable
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
              <p class="option-desc">{{ $t('@76872:同时储藏新建但未添加到Git的文件 (--include-untracked)') }}</p>
            </div>

            <div class="option-item">
              <el-checkbox v-model="excludeLocked" :disabled="allChangesAreLocked" size="large">
                <span class="option-label">{{ $t('@76872:排除锁定文件') }}</span>
              </el-checkbox>
              <p class="option-desc" :class="{ 'disabled': allChangesAreLocked }">
                {{ $t('@76872:不储藏被锁定的文件，保持其当前状态') }}
              </p>
            </div>
          </div>
          
          <!-- 储藏预览信息 -->
          <div class="stash-preview" v-if="gitStore.status.staged.length > 0 || gitStore.status.unstaged.length > 0">
            <h5 class="preview-title">
              <el-icon><Document /></el-icon>
              {{ $t('@76872:将要储藏的文件') }}
            </h5>
            <div class="file-count-info">
              <el-tag type="success" v-if="gitStore.status.staged.length > 0">
                {{ $t('@76872:已暂存: ') }}{{ gitStore.status.staged.length }} {{ $t('@76872:个文件') }}
              </el-tag>
              <el-tag type="warning" v-if="gitStore.status.unstaged.length > 0">
                {{ $t('@76872:未暂存: ') }}{{ gitStore.status.unstaged.length }} {{ $t('@76872:个文件') }}
              </el-tag>
            </div>
          </div>
        </el-form>
      </div>
    </CommonDialog>
  </div>
</template>

<style scoped lang="scss">
.stash-changes-button {
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
  border-radius: 12px;
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
  font-size: 18px;
  flex-shrink: 0;
  box-shadow: 0 4px 12px rgba(14, 165, 233, 0.3);
}

.stash-info-card .info-content {
  flex: 1;
}

.stash-info-card .info-content h4 {
  margin: 0 0 6px 0;
  font-size: 16px;
  font-weight: 600;
  color: #0c4a6e;
  line-height: 1.2;
}

.stash-info-card .info-content p {
  margin: 0;
  font-size: 14px;
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
  font-size: 14px;
  margin-bottom: 8px;
}

.stash-form :deep(.el-textarea) {
  .el-textarea__inner {
    border-radius: 8px;
    border: 2px solid #e5e7eb;
    transition: all 0.3s ease;
    font-size: 14px;
    line-height: 1.5;
    
    &:hover {
      border-color: #d1d5db;
    }
    
    &:focus {
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
    }
  }
}

.stash-options {
  padding: var(--spacing-base);
  border-radius: 12px;
}

.options-title {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  margin: 0 0 var(--spacing-base) 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text-title);
}

.options-title :deep(.el-icon) {
  color: #6b7280;
  font-size: 16px;
}

.option-item {
  margin-bottom: 8px;
  
  &:last-child {
    margin-bottom: 0;
  }
}

.option-item :deep(.el-checkbox) {
  margin-bottom: 8px;
}

.option-label {
  font-weight: 500;
  color: var(--color-text-title);
  font-size: 14px;
}

.option-desc {
  margin: 0;
  font-size: 13px;
  color: #6b7280;
  line-height: 1.4;
  padding-left: 24px;
  
  &.disabled {
    color: #9ca3af;
  }
}

.stash-preview {
  padding: var(--spacing-base);
  background: linear-gradient(135deg, #fefce8 0%, #fef3c7 100%);
  border: 1px solid #fbbf24;
  border-radius: 12px;
  position: relative;
}

.stash-preview::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: linear-gradient(90deg, #f59e0b 0%, #d97706 100%);
  border-radius: 12px 12px 0 0;
}

.preview-title {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  font-size: 14px;
  font-weight: 600;
  color: #92400e;
}

.preview-title :deep(.el-icon) {
  color: #d97706;
  font-size: 16px;
}

.file-count-info {
  display: flex;
  gap: var(--spacing-base);
  flex-wrap: wrap;
}

.file-count-info :deep(.el-tag) {
  border-radius: 6px;
  padding: var(--spacing-sm) var(--spacing-base);
}

/* 储藏弹窗的CommonDialog样式定制 */
:deep(.stash-dialog) {
  .common-dialog__footer {
    .el-button {
      border-radius: 8px;
      font-weight: 500;
      transition: all 0.3s ease;
      
      &:hover {
        transform: translateY(-1px);
      }
    }
  }
}
</style>

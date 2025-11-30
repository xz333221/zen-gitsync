<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref, computed, watch } from 'vue'
import { useGitStore } from '@stores/gitStore'
import { Setting, Loading } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import CommonDialog from '@components/CommonDialog.vue'
import GitCommandPreview from '@components/GitCommandPreview.vue'
import IconButton from '@components/IconButton.vue'
import SvgIcon from '@components/SvgIcon/index.vue'

// 定义props
interface Props {
  variant?: 'icon' | 'text'  // icon: 圆形图标按钮, text: 带文字的普通按钮
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'icon'
})

const gitStore = useGitStore()

// 合并分支相关的状态
const isMergeDialogVisible = ref(false)
const selectedBranch = ref('')
const mergeOptions = ref({
  noCommit: false,
  noFf: false,
  squash: false,
  message: ''
})

// 分支类型过滤器
const branchTypeFilter = ref('all')

// 根据分支类型过滤分支列表
const filteredBranches = computed(() => {
  const branches = gitStore.allBranches.filter(b => b !== gitStore.currentBranch)
  
  if (branchTypeFilter.value === 'local') {
    // 过滤本地分支（不包含 'origin/' 前缀的分支）
    return branches.filter(b => !b.includes('origin/'))
  } else if (branchTypeFilter.value === 'remote') {
    // 过滤远程分支（包含 'origin/' 前缀的分支）
    return branches.filter(b => b.includes('origin/'))
  } else {
    // 返回所有分支
    return branches
  }
})

// 打开合并分支对话框
function openMergeDialog() {
  selectedBranch.value = ''
  mergeOptions.value = {
    noFf: false,
    squash: false,
    noCommit: false,
    message: ''
  }
  branchTypeFilter.value = 'all' // 默认显示所有分支
  isMergeDialogVisible.value = true
  
  // 确保已经加载了分支列表
  if (gitStore.allBranches.length === 0) {
    gitStore.getAllBranches()
  }
  
  // 设置默认选中的分支：优先选择 origin/master，其次 origin/main
  const availableBranches = gitStore.allBranches.filter(b => b !== gitStore.currentBranch)
  if (availableBranches.includes('origin/master')) {
    selectedBranch.value = 'origin/master'
  } else if (availableBranches.includes('origin/main')) {
    selectedBranch.value = 'origin/main'
  }
  // 如果都没有，保持为空字符串
}

// 监听分支类型切换，如果当前选中的分支不在新的过滤列表中，则清空选择
watch(branchTypeFilter, () => {
  // 如果当前有选中的分支，检查它是否在新的过滤列表中
  if (selectedBranch.value && !filteredBranches.value.includes(selectedBranch.value)) {
    selectedBranch.value = ''
  }
})

// 生成git merge命令预览
const mergeCommand = computed(() => {
  if (!selectedBranch.value) {
    return ''
  }
  
  let cmd = `git merge ${selectedBranch.value}`
  
  // 添加选项
  if (mergeOptions.value.noFf) {
    cmd += ' --no-ff'
  }
  if (mergeOptions.value.squash) {
    cmd += ' --squash'
  }
  if (mergeOptions.value.noCommit) {
    cmd += ' --no-commit'
  }
  
  // 添加自定义消息
  if (mergeOptions.value.message && !mergeOptions.value.noCommit) {
    cmd += ` -m "${mergeOptions.value.message}"`
  }
  
  return cmd
})

// 执行合并分支操作
async function handleMergeBranch() {
  if (!selectedBranch.value) {
    ElMessage({
      message: $t('@76872:请选择要合并的分支'),
      type: 'warning'
    })
    return
  }
  
  try {
    const result = await gitStore.mergeBranch(selectedBranch.value, mergeOptions.value)
    if (result) {
      isMergeDialogVisible.value = false
      // 刷新Git状态、提交日志和分支状态
      await Promise.all([
        gitStore.fetchStatus(),
        gitStore.fetchLog(false),
        gitStore.getBranchStatus(true) // 强制刷新分支领先/落后状态
      ])
    }
  } catch (error) {
    console.error('合并分支操作发生错误:', error)
  }
}
</script>

<template>
  <div class="merge-branch-button">
    <!-- 合并分支按钮 -->
    <IconButton
      v-if="props.variant === 'icon'"
      :tooltip="gitStore.hasConflictedFiles ? $t('@76872:存在冲突文件，请先解决冲突') : $t('@76872:合并其他分支到当前分支')"
      size="large"
      :disabled="gitStore.hasConflictedFiles || gitStore.isGitMerging"
      hover-color="var(--color-primary)"
      @click="openMergeDialog"
    >
      <el-icon v-if="gitStore.isGitMerging" class="is-loading"><Loading /></el-icon>
      <svg-icon v-else icon-class="git-merge" />
    </IconButton>
    <el-button
      v-else
      type="primary"
      class="action-button"
      @click="openMergeDialog"
      :loading="gitStore.isGitMerging"
      :disabled="gitStore.hasConflictedFiles"
    >
      {{ $t('@76872:合并分支') }}
    </el-button>

    <!-- 合并分支对话框 -->
    <CommonDialog
      v-model="isMergeDialogVisible"
      :title="$t('@76872:合并分支')"
      size="medium"
      :close-on-click-modal="false"
      show-footer
      :confirm-text="$t('@76872:合并')"
      :cancel-text="$t('@76872:取消')"
      :confirm-loading="gitStore.isGitMerging"
      custom-class="merge-dialog"
      @confirm="handleMergeBranch"
    >
      <div class="merge-dialog-content">
        <!-- 功能说明卡片 -->
        <div class="merge-info-card">
          <div class="info-icon">
            <svg-icon icon-class="git-merge" />
          </div>
          <div class="info-content">
            <h4>{{ $t('@76872:合并分支到当前分支') }}</h4>
            <p>{{ $t('@76872:将选择的分支合并到') }} <code>{{ gitStore.currentBranch }}</code></p>
          </div>
        </div>

        <el-form label-position="top" class="merge-form">
          <!-- 分支类型选择 -->
          <el-form-item :label="$t('@76872:分支类型')">
            <el-radio-group v-model="branchTypeFilter" size="default">
              <el-radio-button value="all">{{ $t('@76872:所有分支') }}</el-radio-button>
              <el-radio-button value="local">{{ $t('@76872:本地分支') }}</el-radio-button>
              <el-radio-button value="remote">{{ $t('@76872:远程分支') }}</el-radio-button>
            </el-radio-group>
          </el-form-item>

          <!-- 分支选择 -->
          <el-form-item :label="$t('@76872:选择分支')">
            <el-select 
              v-model="selectedBranch" 
              :placeholder="$t('@76872:选择要合并的分支')"
              filterable
              clearable
              style="width: 100%"
            >
              <el-option
                v-for="branch in filteredBranches"
                :key="branch"
                :label="branch"
                :value="branch"
              />
            </el-select>
          </el-form-item>

          <!-- 命令预览 -->
          <GitCommandPreview 
            :command="mergeCommand"
            :title="$t('@76872:合并命令预览：')"
            :placeholder="$t('@76872:请先选择要合并的分支')"
          />

          <!-- 合并选项 -->
          <div class="merge-options">
            <h5 class="options-title">
              <el-icon><Setting /></el-icon>
              {{ $t('@76872:合并选项') }}
            </h5>

            <div class="options-horizontal">
              <el-tooltip 
                :content="$t('@76872:始终创建合并提交，即使可以快进 (--no-ff)')" 
                placement="top"
                :show-after="200"
              >
                <el-checkbox v-model="mergeOptions.noFf" size="large">
                  {{ $t('@76872:禁用快进合并') }}
                </el-checkbox>
              </el-tooltip>

              <el-tooltip 
                :content="$t('@76872:将所有提交压缩成一个提交 (--squash)')" 
                placement="top"
                :show-after="200"
              >
                <el-checkbox v-model="mergeOptions.squash" size="large">
                  {{ $t('@76872:压缩合并') }}
                </el-checkbox>
              </el-tooltip>

              <el-tooltip 
                :content="$t('@76872:执行合并但不自动提交，可以手动检查后提交 (--no-commit)')" 
                placement="top"
                :show-after="200"
              >
                <el-checkbox v-model="mergeOptions.noCommit" size="large">
                  {{ $t('@76872:不自动提交') }}
                </el-checkbox>
              </el-tooltip>
            </div>
          </div>

          <!-- 自定义合并消息 -->
          <el-form-item :label="$t('@76872:合并消息（可选）')" v-if="!mergeOptions.noCommit">
            <el-input
              v-model="mergeOptions.message"
              type="textarea"
              :rows="2"
              :placeholder="$t('@76872:自定义合并提交消息')"
              clearable
              resize="none"
              maxlength="200"
              show-word-limit
            />
          </el-form-item>
        </el-form>
      </div>
    </CommonDialog>
  </div>
</template>

<style scoped lang="scss">
.merge-branch-button {
  display: inline-block;
}

/* 合并弹窗样式优化 */
.merge-dialog-content {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-base);
}

.merge-info-card {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-base);
  padding: var(--spacing-base);
  background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%);
  border: 1px solid #93c5fd;
  border-radius: var(--radius-xl);
  position: relative;
  overflow: hidden;
}

.merge-info-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: linear-gradient(90deg, #3b82f6 0%, #2563eb 100%);
}

.merge-info-card .info-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
  border-radius: 10px;
  color: white;
  font-size: var(--font-size-lg);
  flex-shrink: 0;
  box-shadow: var(--shadow-md);
}

.merge-info-card .info-content {
  flex: 1;
}

.merge-info-card .info-content h4 {
  margin: 0 0 6px 0;
  font-size: var(--font-size-md);
  font-weight: 600;
  color: #1e3a8a;
  line-height: 1.2;
}

.merge-info-card .info-content p {
  margin: 0;
  
  color: #1e40af;
  line-height: 1.4;
}

.merge-info-card .info-content code {
  background: rgba(59, 130, 246, 0.1);
  padding: var(--spacing-xs) 6px;
  border-radius: var(--radius-base);
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-weight: 600;
  color: #1e40af;
}

.merge-form {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-base);
}

.merge-form :deep(.el-form-item) {
  margin-bottom: 0;
}

.merge-form :deep(.el-form-item__label) {
  font-weight: 600;
  color: var(--color-text-title);
  
  margin-bottom: var(--spacing-base);
}

.merge-form :deep(.el-select),
.merge-form :deep(.el-input),
.merge-form :deep(.el-textarea) {
  .el-input__wrapper,
  .el-textarea__inner {
    border-radius: var(--radius-lg);
    border: 2px solid var(--color-gray-200);
    transition: all 0.3s ease;
    
    &:hover {
      border-color: var(--color-gray-300);
    }
  }
  
  .el-input__wrapper.is-focus,
  .el-textarea__inner:focus {
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
  }
}

.merge-form :deep(.el-radio-group) {
  display: flex;
  gap: var(--spacing-base);
  
  .el-radio-button {
    flex: 1;
  }
  
  .el-radio-button__inner {
    width: 100%;
    border-radius: var(--radius-lg);
    transition: all 0.3s ease;
  }
}

.merge-options {
  padding: var(--spacing-base);
  border-radius: var(--radius-xl);
}

.options-title {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  margin: 0 0 var(--spacing-md) 0;
  
  font-weight: 600;
  color: var(--color-text-title);
}

.options-title :deep(.el-icon) {
  color: var(--color-gray-500);
  font-size: var(--font-size-md);
}

.options-horizontal {
  display: flex;
  align-items: center;
  gap: var(--spacing-2xl);
  flex-wrap: wrap;
}

.options-horizontal :deep(.el-checkbox) {
  margin: 0;
  white-space: nowrap;
  
  .el-checkbox__label {
    font-weight: 500;
    color: var(--color-text-title);
    
  }
}

/* 合并弹窗的CommonDialog样式定制 */
:deep(.merge-dialog) {
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

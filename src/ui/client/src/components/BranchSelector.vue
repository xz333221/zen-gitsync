<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref } from 'vue'
import { Plus, Menu, Check, Refresh } from '@element-plus/icons-vue'
import InlineCard from '@components/InlineCard.vue'
import CommonDialog from '@components/CommonDialog.vue'
import { useGitStore } from '@stores/gitStore'
import IconButton from '@components/IconButton.vue'

const gitStore = useGitStore()

// 定义 emits
const emit = defineEmits<{
  branchChanged: []
}>()

// 创建分支对话框状态
const createBranchDialogVisible = ref(false)
const newBranchName = ref('')
const selectedBaseBranch = ref('')

// 打开创建分支对话框
function openCreateBranchDialog() {
  selectedBaseBranch.value = gitStore.currentBranch
  createBranchDialogVisible.value = true
}

// 创建新分支
async function createNewBranch() {
  const success = await gitStore.createBranch(newBranchName.value, selectedBaseBranch.value)

  if (success) {
    // 关闭对话框
    createBranchDialogVisible.value = false
    
    // 重置表单
    newBranchName.value = ''
    
    // 通知父组件刷新
    emit('branchChanged')
  }
}

// 切换分支
async function handleBranchChange(branch: string) {
  const success = await gitStore.changeBranch(branch)

  if (success) {
    // 通知父组件刷新
    emit('branchChanged')
    
    // 刷新提交历史
    gitStore.refreshLog()
  }
}

// 刷新当前分支
const isRefreshingBranch = ref(false)
async function refreshCurrentBranch() {
  if (isRefreshingBranch.value) return
  
  isRefreshingBranch.value = true
  try {
    await Promise.all([
      gitStore.getCurrentBranch(true),
      gitStore.getBranchStatus(true),
      gitStore.getAllBranches()
    ])
    emit('branchChanged')
    gitStore.refreshLog()
  } finally {
    isRefreshingBranch.value = false
  }
}
</script>

<template>
  <div class="branch-info" v-if="gitStore.currentBranch">
    <InlineCard class="branch-wrapper" compact>
      <template #content>
        <el-tooltip :content="$t('@F13B4:当前分支')" placement="top" effect="dark" :show-after="200">
          <span class="branch-label" :aria-label="$t('@F13B4:当前分支')" :title="$t('@F13B4:当前分支')">
            <el-icon class="branch-icon">
              <!-- 简洁的分支图标 -->
              <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
                <path fill="currentColor" d="M256 160a96 96 0 1 1 0 192 96 96 0 0 1 0-192zm0 512a96 96 0 1 1 0 192 96 96 0 0 1 0-192zm512-480a96 96 0 1 1 0 192 96 96 0 0 1 0-192zM352 256h288a128 128 0 0 1 128 128v48a144 144 0 0 1-144 144H368a16 16 0 0 0-16 16v64h-96v-64a112 112 0 0 1 112-112h256a80 80 0 0 0 80-80v-16a64 64 0 0 0-64-64H352v-64z"/>
              </svg>
            </el-icon>
          </span>
        </el-tooltip>
        <el-select 
          v-model="gitStore.currentBranch" 
          @change="handleBranchChange"
          :loading="gitStore.isChangingBranch" 
          class="branch-select"
        >
          <el-option v-for="branch in gitStore.allBranches" :key="branch" :label="branch" :value="branch" />
        </el-select>
      </template>
      <template #actions>
        <IconButton
          :tooltip="$t('@F13B4:创建新分支')"
          @click="openCreateBranchDialog"
        >
          <el-icon><Plus /></el-icon>
        </IconButton>
        <IconButton
          :tooltip="$t('@CMDCON:刷新')"
          @click="refreshCurrentBranch"
        >
          <el-icon :class="{ 'is-loading': isRefreshingBranch }"><Refresh /></el-icon>
        </IconButton>
      </template>
    </InlineCard>

    <!-- 创建分支对话框 -->
    <CommonDialog
      v-model="createBranchDialogVisible"
      :title="$t('@F13B4:创建新分支')"
      size="small"
      :destroy-on-close="true"
      :append-to-body="true"
      custom-class="create-branch-dialog"
    >
      <div class="create-branch-content">
        <el-form :model="{ newBranchName, selectedBaseBranch }" label-position="top">
          <el-form-item>
            <template #label>
              <div class="form-label">
                <el-icon class="label-icon"><Plus /></el-icon>
                <span>{{ $t('@F13B4:新分支名称') }}</span>
              </div>
            </template>
            <el-input 
              v-model="newBranchName" 
              :placeholder="$t('@F13B4:请输入新分支名称')" 
              class="modern-input"
              size="large"
              @keyup.enter="createNewBranch"
            />
          </el-form-item>
          <el-form-item>
            <template #label>
              <div class="form-label">
                <el-icon class="label-icon"><Menu /></el-icon>
                <span>{{ $t('@F13B4:基于分支') }}</span>
              </div>
            </template>
            <el-select 
              v-model="selectedBaseBranch" 
              :placeholder="$t('@F13B4:选择基础分支')" 
              class="modern-select"
              size="large"
              style="width: 100%;"
            >
              <el-option v-for="branch in gitStore.allBranches" :key="branch" :label="branch" :value="branch" />
            </el-select>
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <div class="dialog-footer">
          <div class="footer-actions">
            <button type="button" class="dialog-cancel-btn" @click="createBranchDialogVisible = false">
              {{ $t('@F13B4:取消') }}
            </button>
            <button type="button" class="dialog-confirm-btn" @click="createNewBranch" :disabled="gitStore.isCreatingBranch">
              <el-icon v-if="!gitStore.isCreatingBranch"><Check /></el-icon>
              <el-icon class="is-loading" v-else>
                <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
                  <path fill="currentColor" d="M512 64a32 32 0 0 1 32 32v192a32 32 0 0 1-64 0V96a32 32 0 0 1 32-32zm0 640a32 32 0 0 1 32 32v192a32 32 0 1 1-64 0V736a32 32 0 0 1 32-32zm448-192a32 32 0 0 1-32 32H736a32 32 0 1 1 0-64h192a32 32 0 0 1 32 32zm-640 0a32 32 0 0 1-32 32H96a32 32 0 0 1 0-64h192a32 32 0 0 1 32 32z" />
                </svg>
              </el-icon>
              <span>{{ $t('@F13B4:创建') }}</span>
            </button>
          </div>
        </div>
      </template>
    </CommonDialog>
  </div>
</template>

<style scoped lang="scss">
.branch-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
}

.branch-label {
  color: var(--color-text);
  padding-top: 6px;
  margin-right: var(--spacing-sm);
  font-weight: bold;
}

.branch-select {
  width: 200px;
}

/* 创建分支对话框样式 */
.create-branch-content {
  padding: var(--spacing-base) 0;
}

/* dialog-footer 样式已移至 @/styles/common.scss */

/* 加载动画 */
.is-loading {
  animation: rotating 2s linear infinite;
}

@keyframes rotating {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>

<style lang="scss">
/* 选择框样式（需要非 scoped 才能穿透 Element Plus 组件） */
.create-branch-dialog {
  .modern-select .el-select__wrapper {
    border-radius: var(--radius-lg);
    border: 1px solid var(--border-input);
    box-shadow: var(--shadow-sm);
    transition: all 0.2s ease;
    padding: 10px var(--spacing-md);
    background: var(--bg-container);
  }

  .modern-select .el-select__wrapper:hover {
    border-color: var(--color-gray-300);
    box-shadow: var(--shadow-md);
  }

  .modern-select.is-focus .el-select__wrapper {
    border-color: #3498db;
    box-shadow: 0 0 0 2px rgba(52, 152, 219, 0.1), 0 2px 6px rgba(0, 0, 0, 0.08);
  }
}
</style>

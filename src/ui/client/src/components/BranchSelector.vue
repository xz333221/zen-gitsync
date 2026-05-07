<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref, computed } from 'vue'
import { Plus, Menu, Check, Refresh } from '@element-plus/icons-vue'
import CommonDialog from '@components/CommonDialog.vue'
import { useGitStore } from '@stores/gitStore'
import IconButton from '@components/IconButton.vue'
import SvgIcon from '@components/SvgIcon/index.vue'

const gitStore = useGitStore()

// 定义 emits
const emit = defineEmits<{
  branchChanged: []
}>()

// 分支弹出列表状态
const branchPopoverVisible = ref(false)
const branchFilter = ref('')

// 过滤后的分支列表
const filteredBranches = computed(() => {
  const kw = branchFilter.value.trim().toLowerCase()
  if (!kw) return gitStore.allBranches
  return gitStore.allBranches.filter((b: string) => b.toLowerCase().includes(kw))
})

// 打开分支弹出列表
function openBranchPopover() {
  branchFilter.value = ''
  branchPopoverVisible.value = true
}

// 选择/切换分支
async function selectBranch(branch: string) {
  if (branch === gitStore.currentBranch) {
    branchPopoverVisible.value = false
    return
  }
  branchPopoverVisible.value = false
  const success = await gitStore.changeBranch(branch)
  if (success) {
    emit('branchChanged')
    gitStore.refreshLog()
  }
}

// 创建分支对话框状态
const createBranchDialogVisible = ref(false)
const newBranchName = ref('')
const selectedBaseBranch = ref('')

// 打开创建分支对话框
function openCreateBranchDialog() {
  branchPopoverVisible.value = false
  selectedBaseBranch.value = gitStore.currentBranch
  createBranchDialogVisible.value = true
}

// 创建新分支
async function createNewBranch() {
  const success = await gitStore.createBranch(newBranchName.value, selectedBaseBranch.value)

  if (success) {
    createBranchDialogVisible.value = false
    newBranchName.value = ''
    emit('branchChanged')
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
    <div class="branch-wrapper">
      <!-- VSCode 风格分支按钮 + 弹出列表 -->
      <el-popover
        v-model:visible="branchPopoverVisible"
        placement="top-start"
        :width="260"
        trigger="click"
        popper-class="branch-popover"
        :show-arrow="false"
        @show="branchFilter = ''"
      >
        <template #reference>
          <button class="branch-btn">
            <svg-icon icon-class="git-branch" class-name="branch-btn-icon" />
            <span class="branch-btn-name">{{ gitStore.currentBranch }}</span>
            <span class="branch-btn-caret">
              <el-icon><svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M831.872 340.864 512 652.672 192.128 340.864a30.592 30.592 0 0 0-42.752 0 29.12 29.12 0 0 0 0 41.6L489.664 714.24a32 32 0 0 0 44.672 0l340.288-331.776a29.12 29.12 0 0 0 0-41.6 30.592 30.592 0 0 0-42.752 0z"/></svg></el-icon>
            </span>
          </button>
        </template>

        <!-- 弹出内容 -->
        <div class="branch-popover-inner">
          <!-- 搜索框 -->
          <div class="branch-search">
            <el-input
              v-model="branchFilter"
              :placeholder="$t('@F13B4:搜索或签出分支')"
              size="small"
              clearable
              autofocus
            />
          </div>

          <!-- 分支列表 -->
          <div class="branch-list">
            <div
              v-for="branch in filteredBranches"
              :key="branch"
              class="branch-item"
              :class="{ 'is-active': branch === gitStore.currentBranch }"
              @click="selectBranch(branch)"
            >
              <el-icon class="branch-item-check" v-if="branch === gitStore.currentBranch">
                <Check />
              </el-icon>
              <span v-else class="branch-item-check-placeholder"></span>
              <svg-icon icon-class="git-branch" class-name="branch-item-icon" />
              <span class="branch-item-name">{{ branch }}</span>
            </div>
            <div v-if="filteredBranches.length === 0" class="branch-empty">
              {{ $t('@F13B4:没有匹配的分支') }}
            </div>
          </div>

          <!-- 底部：创建新分支 -->
          <div class="branch-popover-footer">
            <button class="branch-create-btn" @click="openCreateBranchDialog">
              <el-icon><Plus /></el-icon>
              <span>{{ $t('@F13B4:创建新分支') }}</span>
            </button>
          </div>
        </div>
      </el-popover>

      <!-- 刷新按钮 -->
      <IconButton
        :tooltip="$t('@CMDCON:刷新')"
        @click="refreshCurrentBranch"
      >
        <el-icon :class="{ 'is-loading': isRefreshingBranch }"><Refresh /></el-icon>
      </IconButton>
    </div>

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
.branch-wrapper {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

/* VSCode 风格分支按钮 */
.branch-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 6px;
  background: transparent;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  color: var(--color-text);
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  white-space: nowrap;
  transition: background 0.15s;

  &:hover {
    background: var(--bg-hover, rgba(255,255,255,0.08));
  }

  &:active {
    background: var(--bg-active, rgba(255,255,255,0.12));
  }
}

:deep(.branch-btn-icon) {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.branch-btn-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.branch-btn-caret {
  display: flex;
  align-items: center;
  opacity: 0.6;
  font-size: 10px;
}

/* 分支弹出列表内容 */
.branch-popover-inner {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.branch-search {
  padding-bottom: 8px;
}

.branch-list {
  max-height: 240px;
  overflow-y: auto;
  margin: 0 -16px;
  padding: 0 4px;

  &::-webkit-scrollbar {
    width: 4px;
  }
  &::-webkit-scrollbar-thumb {
    background: var(--border-color, rgba(128,128,128,0.3));
    border-radius: 2px;
  }
}

.branch-item {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  cursor: pointer;
  border-radius: 3px;
  font-size: 13px;
  color: var(--color-text);
  transition: background 0.1s;

  &:hover {
    background: var(--bg-hover, rgba(255,255,255,0.08));
  }

  &.is-active {
    color: var(--color-primary);
  }
}

.branch-item-check {
  font-size: 12px;
  flex-shrink: 0;
  color: var(--color-primary);
}

.branch-item-check-placeholder {
  display: inline-block;
  width: 12px;
  flex-shrink: 0;
}

:deep(.branch-item-icon) {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  opacity: 0.7;
}

.branch-item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.branch-empty {
  padding: 12px;
  text-align: center;
  color: var(--color-text-secondary, #888);
  font-size: 12px;
}

.branch-popover-footer {
  border-top: 1px solid var(--border-color, rgba(128,128,128,0.2));
  margin-top: 4px;
  padding-top: 6px;
}

.branch-create-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 28px;
  padding: 0 12px;
  background: transparent;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  color: var(--color-text);
  font-size: 13px;
  text-align: left;
  transition: background 0.1s;

  &:hover {
    background: var(--bg-hover, rgba(255,255,255,0.08));
  }
}

/* 创建分支对话框样式 */
.branch-info {
  display: flex;
  align-items: center;
}

.create-branch-content {
  padding: var(--spacing-base) 0;
}

/* 加载动画 */
.is-loading {
  animation: rotating 2s linear infinite;
}

@keyframes rotating {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>

<style lang="scss">
/* branch-popover 全局样式（穿透 Element Plus popper） */
.branch-popover {
  padding: 12px 16px !important;
  border-radius: 4px !important;
  box-shadow: 0 4px 16px rgba(0,0,0,0.18) !important;
}

/* 创建分支对话框穿透样式 */
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


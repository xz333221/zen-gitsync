<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref, computed } from 'vue'
import { useGitStore } from '@stores/gitStore'
import { Menu, RefreshRight, Download, Connection, Edit, Delete } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import IconButton from '@components/IconButton.vue'
import StageButton from '@/components/buttons/StageButton.vue'
import UnstageAllButton from '@/components/buttons/UnstageAllButton.vue'
import CommitButton from '@/components/buttons/CommitButton.vue'
import PushButton from '@/components/buttons/PushButton.vue'
import QuickPushButton from '@/components/buttons/QuickPushButton.vue'
import MergeBranchButton from '@/components/buttons/MergeBranchButton.vue'
import StashChangesButton from '@/components/buttons/StashChangesButton.vue'
import StashListButton from '@/components/buttons/StashListButton.vue'
import CreateTagButton from '@/components/buttons/CreateTagButton.vue'
import TagListButton from '@/components/buttons/TagListButton.vue'

// 定义props
interface Props {
  variant?: 'icon' | 'text'  // icon: 圆形图标按钮, text: 带文字的普通按钮
  hasUserCommitMessage?: boolean
  finalCommitMessage?: string
  skipHooks?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'icon',
  hasUserCommitMessage: false,
  finalCommitMessage: '',
  skipHooks: false
})

const emit = defineEmits<{
  afterCommit: [success: boolean]
  afterPush: [success: boolean]
  beforePush: []
  clearFields: []
}>()

const gitStore = useGitStore()

// Git操作抽屉状态
const gitOperationsDrawerVisible = ref(false)

// 打开Git操作抽屉
function openGitOperationsDrawer() {
  gitOperationsDrawerVisible.value = true
}

// 计算已暂存文件数量
const stagedFilesCount = computed(() => {
  return gitStore.fileList.filter(file => file.type === 'added').length
})

// 计算是否需要拉取
const needsPull = computed(() => {
  return gitStore.branchBehind > 0
})

// 计算是否有未暂存的更改
const hasUnstagedChanges = computed(() => {
  return gitStore.fileList.some(file => 
    ['modified', 'deleted', 'untracked'].includes(file.type)
  )
})

// 处理Git拉取
async function handleGitPull() {
  try {
    await gitStore.gitPull()
    await gitStore.fetchStatus()
    await gitStore.fetchLog(false)
  } catch (error) {
    console.error('拉取失败:', error)
  }
}

// 处理Git获取所有远程分支
async function handleGitFetchAll() {
  try {
    await gitStore.gitFetchAll()
    await gitStore.fetchStatus()
    await gitStore.fetchLog(false)
  } catch (error) {
    console.error('获取远程分支失败:', error)
  }
}

// 暂存并提交
async function addAndCommit() {
  if (!props.hasUserCommitMessage) {
    return
  }

  try {
    await gitStore.addAndCommit(props.finalCommitMessage, props.skipHooks)
    gitStore.fetchStatus()
    gitStore.fetchLog()
    emit('afterCommit', true)
    emit('clearFields')
  } catch (error) {
    console.error('暂存并提交失败:', error)
  }
}

// 重置到远程
async function resetToRemote() {
  try {
    await ElMessageBox.confirm(
      `${$t('@76872:确定要重置当前分支 "')}${gitStore.currentBranch}${$t('@76872:" 到远程状态吗？这将丢失所有未推送的提交和本地更改。')}`,
      $t('@76872:重置到远程分支'),
      {
        confirmButtonText: $t('@76872:确定'),
        cancelButtonText: $t('@76872:取消'),
        type: 'warning'
      }
    )

    const result = await gitStore.resetToRemote(gitStore.currentBranch)
    if (result) {
      gitStore.fetchStatus()
      gitStore.fetchLog()
    }
  } catch (error) {
    // 用户取消操作
    if (error !== 'cancel') {
      console.error('重置到远程失败:', error)
    }
  }
}

// 处理快速推送前的事件
function handleQuickPushBefore() {
  emit('beforePush')
}

// 处理快速推送后的事件
function handleQuickPushAfter(success: boolean) {
  emit('afterPush', success)
}

// 处理清空字段事件
function handleClearFields() {
  emit('clearFields')
}

// 暴露方法给父组件
defineExpose({
  openGitOperationsDrawer
})
</script>

<template>
  <div class="git-operations-button">
    <!-- Git操作按钮 -->
    <IconButton
      v-if="props.variant === 'icon'"
      :tooltip="$t('@F13B4:Git 操作')"
      size="medium"
      custom-class="btn-rotate-on-hover"
      @click="openGitOperationsDrawer"
    >
      <el-icon><Menu /></el-icon>
    </IconButton>
    <el-button
      v-else
      type="primary"
      class="action-button"
      @click="openGitOperationsDrawer"
    >
      {{ $t('@F13B4:Git 操作') }}
    </el-button>

    <!-- Git操作抽屉 -->
    <el-drawer
      v-model="gitOperationsDrawerVisible"
      :title="$t('@76872:Git 操作')"
      direction="rtl"
      size="362px"
      :with-header="true"
      :show-close="true"
      :destroy-on-close="false"
      :append-to-body="true"
      class="git-operations-drawer"
    >
      <div class="actions-section">
        <div class="action-groups">
          <!-- 基础操作 -->
          <div class="action-group">
            <div class="group-title">{{ $t('@76872:基础操作') }}</div>
              <div class="group-buttons">
                <StageButton
                  @click="() => {}"
                  from="drawer"
                />

                <UnstageAllButton
                  @click="() => {}"
                  from="drawer"
                />

                <CommitButton
                  :has-user-commit-message="hasUserCommitMessage"
                  :final-commit-message="finalCommitMessage"
                  :skip-hooks="skipHooks"
                  @before-commit="() => {}"
                  @after-commit="(success) => emit('afterCommit', success)"
                  @click="() => {}"
                  from="drawer"
                />

                <PushButton
                  @before-push="() => {}"
                  @after-push="(success) => emit('afterPush', success)"
                  @click="() => {}"
                  from="drawer"
                />
                
                <el-tooltip :content="gitStore.hasConflictedFiles ? $t('@76872:存在冲突文件，请先解决冲突') : (needsPull ? `${$t('@76872:拉取')}${gitStore.branchBehind}${$t('@76872:个远程提交')}` : 'git pull')" placement="top">
                  <el-button 
                    type="primary"
                    :icon="Download"
                    @click="handleGitPull"
                    :loading="gitStore.isGitPulling"
                    :disabled="!gitStore.hasUpstream || gitStore.hasConflictedFiles"
                    class="action-button"
                    :style="gitStore.hasUpstream && !gitStore.hasConflictedFiles ? {color: 'white', backgroundColor: '#1e90ff', borderColor: '#1e90ff'} : {}"
                  >
                    {{ $t('@76872:拉取') }}
                    <span v-if="needsPull">({{gitStore.branchBehind}})</span>
                  </el-button>
                </el-tooltip>
                
                <el-tooltip content="git fetch --all" placement="top">
                  <el-button 
                    type="info"
                    :icon="Connection"
                    @click="handleGitFetchAll"
                    :loading="gitStore.isGitFetching"
                    class="action-button"
                    style="color: white; background-color: #1e90ff; border-color: #1e90ff;"
                  >
                    {{ $t('@76872:获取所有远程分支') }}
                  </el-button>
                </el-tooltip>
              </div>
            </div>

            <!-- 组合操作 -->
            <div class="action-group">
              <div class="group-title">{{ $t('@76872:组合操作') }}</div>
              <div class="group-buttons">
                <el-tooltip :content="gitStore.hasConflictedFiles ? $t('@76872:存在冲突文件，请先解决冲突') : 'git add + git commit'" placement="top">
                  <el-button 
                    type="primary"
                    :icon="Edit"
                    @click="addAndCommit"
                    :loading="gitStore.isAddingFiles || gitStore.isCommiting"
                    :disabled="!hasUnstagedChanges || !hasUserCommitMessage || gitStore.hasConflictedFiles"
                    class="action-button"
                  >
                    {{ $t('@76872:暂存并提交') }}
                  </el-button>
                </el-tooltip>

                <QuickPushButton 
                  from="drawer"
                  :has-user-commit-message="hasUserCommitMessage"
                  :final-commit-message="finalCommitMessage"
                  :skip-hooks="skipHooks"
                  @before-push="handleQuickPushBefore"
                  @after-push="handleQuickPushAfter"
                  @clear-fields="handleClearFields"
                />
              </div>
            </div>

          <!-- 重置操作 -->
          <div class="action-group">
            <div class="group-title">{{ $t('@76872:重置操作') }}</div>
              <div class="group-buttons">
                <el-tooltip :content="stagedFilesCount > 0 ? `${$t('@76872:撤销')}${stagedFilesCount}${$t('@76872:个已暂存文件')}` : 'git reset HEAD'" placement="top">
                  <el-button 
                    type="warning"
                    :icon="RefreshRight"
                    @click="gitStore.resetHead"
                    :loading="gitStore.isResetting"
                    :disabled="stagedFilesCount === 0 || gitStore.hasConflictedFiles"
                    class="action-button reset-button"
                  >
                    {{ $t('@76872:重置暂存区') }}
                    <span v-if="stagedFilesCount > 0">({{stagedFilesCount}})</span>
                  </el-button>
                </el-tooltip>

                <el-tooltip :content="gitStore.hasConflictedFiles ? $t('@76872:存在冲突文件，请先解决冲突') : 'git reset --hard origin/branch'" placement="top">
                  <el-button 
                    type="danger"
                    :icon="Delete"
                    @click="resetToRemote"
                    :loading="gitStore.isResetting"
                    :disabled="!gitStore.hasUpstream || gitStore.hasConflictedFiles"
                    class="action-button danger-button"
                  >
                    {{ $t('@76872:重置到远程') }}
                  </el-button>
                </el-tooltip>
              </div>
            </div>
          
          <!-- 分支操作 -->
          <div class="action-group">
            <div class="group-title">{{ $t('@76872:分支操作') }}</div>
            <div class="group-buttons">
              <MergeBranchButton variant="text" />
            </div>
          </div>

          <!-- 储藏操作 -->
          <div class="action-group">
            <div class="group-title">{{ $t('@76872:储藏操作') }}</div>
            <div class="group-buttons">
              <StashChangesButton variant="text" />
              <StashListButton variant="text" />
            </div>
          </div>

          <!-- 标签操作 -->
          <div class="action-group">
            <div class="group-title">{{ $t('@TAG01:标签操作') }}</div>
            <div class="group-buttons">
              <CreateTagButton variant="text" />
              <TagListButton variant="text" />
            </div>
          </div>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped lang="scss">
.git-operations-button {
  display: inline-block;
}

.action-groups {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
}

.action-group {
  background: var(--bg-container);
  border-radius: var(--radius-lg);
  padding: var(--spacing-md);
  border: 1px solid var(--border-component);
}

.group-title {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: var(--spacing-base);
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border-card);
}

.group-buttons {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-base);

  // 只确保按钮全宽，其他样式由按钮组件自己的from-drawer样式控制
  :deep(.el-button) {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
}

</style>

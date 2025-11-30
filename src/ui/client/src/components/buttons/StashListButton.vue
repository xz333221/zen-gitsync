<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref, computed } from 'vue'
import { useGitStore } from '@stores/gitStore'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Box, Delete, Edit, Download, Check } from '@element-plus/icons-vue'
import CommonDialog from '@components/CommonDialog.vue'
import FileDiffViewer from '@components/FileDiffViewer.vue'
import IconButton from '@components/IconButton.vue'

// 定义props
interface Props {
  variant?: 'icon' | 'text'  // icon: 圆形图标按钮, text: 带文字的普通按钮
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'icon'
})

const gitStore = useGitStore()

// 储藏列表对话框状态
const isStashListDialogVisible = ref(false)

// stash详情弹窗相关状态
const stashDetailVisible = ref(false)
const selectedStash = ref<{ id: string; description: string } | null>(null)
const stashFiles = ref<string[]>([])
const stashDiff = ref('')
const isLoadingStashDetail = ref(false)
const selectedStashFile = ref('')

// 为stash组件准备文件列表
const stashFilesForViewer = computed(() => {
  return stashFiles.value.map(file => ({
    path: file,
    name: file.split('/').pop() || file
  }))
})

// 打开储藏列表对话框
function openStashListDialog() {
  gitStore.getStashList()
  isStashListDialogVisible.value = true
}

// 应用储藏
async function applyStash(stashId: string, pop = false) {
  try {
    await gitStore.applyStash(stashId, pop)
    if (pop) {
      // 如果是应用并删除，刷新列表
      await gitStore.getStashList()
    }
  } catch (error) {
    console.error('应用储藏失败:', error)
  }
}

// 确认删除储藏
async function confirmDropStash(stashId: string) {
  ElMessageBox.confirm(
    $t('@76872:确定要删除此储藏吗？此操作不可恢复。'),
    $t('@76872:删除储藏'),
    {
      confirmButtonText: $t('@76872:确定'),
      cancelButtonText: $t('@76872:取消'),
      type: 'warning'
    }
  )
  .then(async () => {
    await gitStore.dropStash(stashId)
    await gitStore.getStashList()
  })
  .catch(() => {
    // 用户取消操作
  })
}

// 确认清空所有储藏
async function confirmClearAllStashes() {
  ElMessageBox.confirm(
    $t('@76872:确定要清空所有储藏吗？此操作不可恢复。'),
    $t('@76872:清空所有储藏'),
    {
      confirmButtonText: $t('@76872:确定'),
      cancelButtonText: $t('@76872:取消'),
      type: 'warning'
    }
  )
  .then(async () => {
    await gitStore.clearAllStashes()
    await gitStore.getStashList()
  })
  .catch(() => {
    // 用户取消操作
  })
}

// 查看stash详情
async function viewStashDetail(stash: { id: string; description: string }) {
  if (!stash) return

  selectedStash.value = stash
  stashDetailVisible.value = true
  isLoadingStashDetail.value = true
  stashFiles.value = []
  stashDiff.value = ''
  selectedStashFile.value = ''

  try {
    // 确保 stash ID 有效
    if (!stash.id || stash.id.length < 7) {
      stashDiff.value = $t('@76872:无效的stash ID')
      isLoadingStashDetail.value = false
      return
    }

    // 获取stash的变更文件列表
    const filesResponse = await fetch(`/api/stash-files?stashId=${encodeURIComponent(stash.id)}`)
    const filesData = await filesResponse.json()

    if (filesData.success && Array.isArray(filesData.files)) {
      stashFiles.value = filesData.files

      // 如果有文件，自动加载第一个文件的差异
      if (stashFiles.value.length > 0) {
        await getStashFileDiff(stash.id, stashFiles.value[0])
      } else {
        stashDiff.value = $t('@76872:该stash没有变更文件')
      }
    } else {
      stashDiff.value = `${$t('@76872:获取文件列表失败: ')}${filesData.error || $t('@76872:未知错误')}`
    }
  } catch (error) {
    stashDiff.value = `${$t('@76872:获取stash详情失败: ')}${(error as Error).message}`
  } finally {
    isLoadingStashDetail.value = false
  }
}

// 获取stash中特定文件的差异
async function getStashFileDiff(stashId: string, filePath: string) {
  isLoadingStashDetail.value = true
  selectedStashFile.value = filePath

  try {
    const diffResponse = await fetch(
      `/api/stash-file-diff?stashId=${encodeURIComponent(stashId)}&file=${encodeURIComponent(filePath)}`
    )
    const diffData = await diffResponse.json()

    if (diffData.success) {
      stashDiff.value = diffData.diff || $t('@76872:没有变更内容')
    } else {
      stashDiff.value = `${$t('@76872:获取差异失败: ')}${diffData.error || $t('@76872:未知错误')}`
    }
  } catch (error) {
    stashDiff.value = `${$t('@76872:获取差异失败: ')}${(error as Error).message}`
  } finally {
    isLoadingStashDetail.value = false
  }
}

// 处理stash文件选择
function handleStashFileSelect(filePath: string) {
  if (selectedStash.value) {
    getStashFileDiff(selectedStash.value.id, filePath)
  }
}

// 处理打开文件
async function handleOpenFile(filePath: string, context: string) {
  try {
    const response = await fetch('/api/open-file', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filePath,
        context
      })
    })
    
    const result = await response.json()
    
    if (result.success) {
      ElMessage.success(result.message)
    } else {
      ElMessage.error(result.error || $t('@76872:打开文件失败'))
    }
  } catch (error) {
    ElMessage.error(`${$t('@76872:打开文件失败: ')}${(error as Error).message}`)
  }
}

// 处理用VSCode打开文件
async function handleOpenWithVSCode(filePath: string, context: string) {
  try {
    const response = await fetch('/api/open-with-vscode', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filePath,
        context
      })
    })
    
    const result = await response.json()
    
    if (result.success) {
      ElMessage.success(result.message)
    } else {
      ElMessage.error(result.error || $t('@76872:用VSCode打开文件失败'))
    }
  } catch (error) {
    ElMessage.error(`${$t('@76872:用VSCode打开文件失败: ')}${(error as Error).message}`)
  }
}
</script>

<template>
  <div class="stash-list-button">
    <!-- 储藏列表按钮 -->
    <IconButton
      v-if="props.variant === 'icon'"
      :tooltip="$t('@76872:查看和管理所有储藏记录')"
      size="large"
      hover-color="var(--color-info)"
      @click="openStashListDialog"
    >
      <el-icon><Box /></el-icon>
    </IconButton>
    <el-button
      v-else
      type="info"
      class="action-button"
      @click="openStashListDialog"
    >
      {{ $t('@76872:储藏列表') }}
    </el-button>

    <!-- Stash列表弹窗 -->
    <CommonDialog
      v-model="isStashListDialogVisible"
      :title="$t('@76872:储藏列表 (Git Stash)')"
      size="large"
      :show-footer="false"
      custom-class="stash-list-dialog"
    >
      <div class="stash-list-content">
        <!-- 头部统计信息 -->
        <div class="stash-header" v-if="!gitStore.isLoadingStashes">
          <div class="stash-stats">
            <div class="stat-item">
              <el-icon class="stat-icon"><Box /></el-icon>
              <span class="stat-number">{{ gitStore.stashes.length }}</span>
              <span class="stat-label">{{ $t('@76872:个储藏') }}</span>
            </div>
          </div>
          <div class="stash-actions-header" v-if="gitStore.stashes.length > 0">
            <el-button
              type="danger"
              size="small"
              :icon="Delete"
              @click="confirmClearAllStashes"
              :loading="gitStore.isDroppingStash"
              class="clear-all-btn"
            >
              {{ $t('@76872:清空所有储藏') }}
            </el-button>
          </div>
        </div>

        <!-- 储藏列表 -->
        <div class="stash-list-container" v-loading="gitStore.isLoadingStashes">
          <div v-if="gitStore.stashes.length === 0 && !gitStore.isLoadingStashes" class="empty-state">
            <el-empty
              :description="$t('@76872:暂无储藏记录')"
              :image-size="120"
            >
              <template #image>
                <el-icon class="empty-icon"><Box /></el-icon>
              </template>
              <template #description>
                <p class="empty-text">{{ $t('@76872:还没有任何储藏记录') }}</p>
                <p class="empty-hint">{{ $t('@76872:使用 git stash 可以临时保存工作进度') }}</p>
              </template>
            </el-empty>
          </div>
          
          <div v-else class="stash-cards">
            <div 
              v-for="(stash, index) in gitStore.stashes" 
              :key="stash.id"
              class="stash-card"
              :class="{ 'stash-card-latest': index === 0 }"
            >
              <div class="stash-card-content">
                <div class="stash-info">
                  <div class="stash-main-info">
                    <div class="stash-id-badge">
                      <el-icon class="badge-icon"><Box /></el-icon>
                      <span class="stash-id-text">{{ stash.id }}</span>
                      <el-tag v-if="index === 0" size="small" type="success" class="latest-tag">{{ $t('@76872:最新') }}</el-tag>
                    </div>
                    <div class="stash-description">
                      <span class="description-text">{{ stash.description }}</span>
                    </div>
                  </div>
                </div>
                
                <div class="stash-card-actions">
                  <el-button
                    size="small"
                    type="info"
                    :icon="Edit"
                    @click="viewStashDetail(stash)"
                    :loading="isLoadingStashDetail"
                    class="action-btn view-btn"
                  >
                    {{ $t('@76872:查看') }}
                  </el-button>
                  <el-button
                    size="small"
                    type="success"
                    :icon="Download"
                    @click="applyStash(stash.id, false)"
                    :loading="gitStore.isApplyingStash"
                    class="action-btn apply-btn"
                  >
                    {{ $t('@76872:应用') }}
                  </el-button>
                  <el-button
                    size="small"
                    type="primary"
                    :icon="Check"
                    @click="applyStash(stash.id, true)"
                    :loading="gitStore.isApplyingStash"
                    class="action-btn apply-pop-btn"
                  >
                    {{ $t('@76872:应用并删除') }}
                  </el-button>
                  <el-button
                    size="small"
                    type="danger"
                    :icon="Delete"
                    @click="confirmDropStash(stash.id)"
                    :loading="gitStore.isDroppingStash"
                    class="action-btn delete-btn"
                  >
                    {{ $t('@76872:删除') }}
                  </el-button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </CommonDialog>

    <!-- Stash详情弹窗 -->
    <CommonDialog
      v-model="stashDetailVisible"
      :title="$t('@76872:储藏详情')"
      custom-class="stash-detail-dialog"
      size="extra-large"
      type="flex"
      heightMode="fixed"
      :close-on-click-modal="false"
    >
      <div class="stash-content">
        <!-- 储藏信息横向布局 -->
        <div class="stash-info-row" v-if="selectedStash">
          <div class="stash-id">
            <span class="info-label">Stash ID:</span>
            <code class="stash-id-value">{{ selectedStash.id }}</code>
          </div>
          <div class="stash-description">
            <span class="info-label">{{ $t('@76872:描述:') }}</span>
            <span class="stash-description-value">{{ selectedStash.description }}</span>
          </div>
        </div>

        <!-- 文件差异查看器 -->
        <div class="stash-main-content">
          <FileDiffViewer
            :files="stashFilesForViewer"
            :diffContent="stashDiff"
            :selectedFile="selectedStashFile"
            context="stash-detail"
            :emptyText="$t('@76872:该stash没有变更文件')"
            @file-select="handleStashFileSelect"
            @open-file="handleOpenFile"
            @open-with-vscode="handleOpenWithVSCode"
          />
        </div>
      </div>
    </CommonDialog>
  </div>
</template>

<style scoped lang="scss">
.stash-list-button {
  display: inline-block;
}

.stash-list-content {
  padding: 0;
  min-height: 400px;
}

/* Stash列表弹窗样式 */
:deep(.stash-list-dialog) {
  .common-dialog__header {
    background: var(--color-primary);
    color: white;
    padding: var(--spacing-xl) var(--spacing-2xl);
    border-radius: 8px 8px 0 0;
    margin: 0;
  }
  
  .common-dialog__title {
    font-size: var(--font-size-lg);
    font-weight: 600;
    color: white;
  }
  
  .common-dialog__close {
    color: white;
    font-size: var(--font-size-lg);
    
    &:hover {
      color: var(--border-card);
    }
  }
}

/* 头部统计信息 */
.stash-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--spacing-base);
  padding: var(--spacing-base);
  background: linear-gradient(135deg, var(--color-white) 0%, #f8f9fa 100%);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-component);
  box-shadow: var(--shadow-md);
}

.stash-stats {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
}

.stat-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  padding: var(--spacing-xs) var(--spacing-base);
  background: var(--color-primary);
  border-radius: var(--radius-lg);
  color: white;
}

.stat-icon {
  font-size: var(--font-size-md);
}

.stat-number {
  font-size: var(--font-size-lg);
  font-weight: 600;
}

.stat-label {
  
  opacity: 0.9;
}

.stash-actions-header {
  display: flex;
  gap: var(--spacing-base);
}

.clear-all-btn {
  border-radius: var(--radius-lg);
  padding: var(--spacing-xs) var(--spacing-base);
  font-weight: 500;
  transition: all 0.3s ease;
  
  &:hover {
    transform: translateY(-1px);
  }
}

/* 储藏列表容器 */
.stash-list-container {
  min-height: 300px;
}

/* 空状态样式已移至 @/styles/common.scss */

/* 储藏卡片列表 */
.stash-cards {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-base);
}

.stash-card {
  background: var(--bg-container);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-component);
  box-shadow: var(--shadow-md);
  transition: all 0.3s ease;
  overflow: hidden;
  
  &:hover {
    transform: translateY(-1px);
    border-color: var(--color-primary);
  }
}

.stash-card-latest {
  border: 2px solid var(--color-success);
  box-shadow: var(--shadow-md);
  
  &:hover {
    border-color: var(--color-success);
    box-shadow: var(--shadow-lg);
  }
}

.stash-card-content {
  padding: var(--spacing-base);
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
}

.stash-info {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  flex: 1;
  min-width: 0;
}

.stash-main-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  flex-wrap: wrap;
}

.stash-id-badge {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  flex-shrink: 0;
}

.badge-icon {
  
  color: var(--text-tertiary);
}

.stash-id-text {
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: var(--font-size-sm);
  background: var(--bg-panel);
  color: var(--text-secondary);
  padding: 3px var(--spacing-base);
  border-radius: var(--radius-base);
  font-weight: 500;
  letter-spacing: 0.5px;
  border: 1px solid var(--border-card);
}

.latest-tag {
  margin-left: var(--spacing-sm);
}

.stash-description {
  flex: 1;
  min-width: 0;
}

.description-text {
  margin: 0;
  
  line-height: 1.4;
  word-break: break-word;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 储藏列表右侧按钮：默认隐藏，hover时显示 */
.stash-card-actions {
  display: none;
  gap: 6px;
  flex-shrink: 0;
  align-items: center;
}

.stash-card:hover .stash-card-actions {
  display: flex;
}

.action-btn {
  border-radius: var(--radius-md);
  font-weight: 500;
  transition: all 0.3s ease;
  min-width: 60px;
  padding: 6px var(--spacing-md);
  font-size: var(--font-size-sm);
  
  &:hover {
    transform: translateY(-1px);
  }
}

.view-btn:hover {
  box-shadow: var(--shadow-md);
}

.apply-btn:hover {
  box-shadow: var(--shadow-md);
}

.apply-pop-btn:hover {
  box-shadow: var(--shadow-md);
}

.delete-btn:hover {
  box-shadow: var(--shadow-md);
}

/* 储藏详情弹窗样式 */
.stash-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: var(--spacing-base);
}

.stash-info-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  padding: var(--spacing-base);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-component);
  flex-shrink: 0; /* 不被压缩 */
}

.stash-id,
.stash-description {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
}

.info-label {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--text-secondary);
  white-space: nowrap;
}

.stash-id-value {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Monaco, Inconsolata, "Roboto Mono", "Droid Sans Mono", Consolas, "Courier New", monospace;
  font-size: var(--font-size-sm);
  background-color: var(--border-component);
  color: var(--color-text);
  padding: var(--spacing-xs) 6px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-component);
}

.stash-description {
  flex: 1; /* 占据剩余空间 */
}

.stash-description-value {
  
  font-weight: 400;
  word-break: break-all;
}

.stash-main-content {
  flex: 1;
  min-height: 0; /* 关键：允许flex子元素缩小 */
  display: flex;
  flex-direction: column;
}
</style>

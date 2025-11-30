<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref } from 'vue'
import { useGitStore } from '@stores/gitStore'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Sell, Delete, Upload, InfoFilled, Refresh } from '@element-plus/icons-vue'
import CommonDialog from '@components/CommonDialog.vue'

// 定义props
interface Props {
  variant?: 'icon' | 'text'  // icon: 圆形图标按钮, text: 带文字的普通按钮
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'icon'
})

const gitStore = useGitStore()

// 标签接口
interface GitTag {
  name: string
  commit: string
  date: string
  message?: string
  type: 'lightweight' | 'annotated'
}

// 标签列表对话框状态
const isTagListDialogVisible = ref(false)
const tags = ref<GitTag[]>([])
const isLoadingTags = ref(false)
const isDeletingTag = ref(false)
const isPushingTag = ref(false)

// 标签详情弹窗
const tagDetailVisible = ref(false)
const selectedTag = ref<GitTag | null>(null)

// 打开标签列表对话框
async function openTagListDialog() {
  isTagListDialogVisible.value = true
  await loadTags()
}

// 加载标签列表
async function loadTags() {
  try {
    isLoadingTags.value = true
    const response = await fetch('/api/list-tags')
    const result = await response.json()

    if (result.success) {
      tags.value = result.tags || []
    } else {
      ElMessage.error(result.error || $t('@TAG01:获取标签列表失败'))
    }
  } catch (error) {
    console.error('获取标签列表失败:', error)
    ElMessage.error($t('@TAG01:获取标签列表失败'))
  } finally {
    isLoadingTags.value = false
  }
}

// 查看标签详情
function viewTagDetail(tag: GitTag) {
  selectedTag.value = tag
  tagDetailVisible.value = true
}

// 推送标签到远程
async function pushTag(tagName: string) {
  ElMessageBox.confirm(
    $t('@TAG01:确定要推送此标签到远程仓库吗？'),
    $t('@TAG01:推送标签'),
    {
      confirmButtonText: $t('@TAG01:推送'),
      cancelButtonText: $t('@TAG01:取消'),
      type: 'info'
    }
  )
  .then(async () => {
    try {
      isPushingTag.value = true
      const response = await fetch('/api/push-tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagName })
      })

      const result = await response.json()

      if (result.success) {
        ElMessage.success($t('@TAG01:标签推送成功'))
      } else {
        ElMessage.error(result.error || $t('@TAG01:推送标签失败'))
      }
    } catch (error) {
      console.error('推送标签失败:', error)
      ElMessage.error($t('@TAG01:推送标签失败'))
    } finally {
      isPushingTag.value = false
    }
  })
  .catch(() => {
    // 用户取消操作
  })
}

// 推送所有标签
async function pushAllTags() {
  ElMessageBox.confirm(
    $t('@TAG01:确定要推送所有标签到远程仓库吗？'),
    $t('@TAG01:推送所有标签'),
    {
      confirmButtonText: $t('@TAG01:推送'),
      cancelButtonText: $t('@TAG01:取消'),
      type: 'info'
    }
  )
  .then(async () => {
    try {
      isPushingTag.value = true
      const response = await fetch('/api/push-all-tags', {
        method: 'POST'
      })

      const result = await response.json()

      if (result.success) {
        ElMessage.success($t('@TAG01:所有标签推送成功'))
      } else {
        ElMessage.error(result.error || $t('@TAG01:推送标签失败'))
      }
    } catch (error) {
      console.error('推送标签失败:', error)
      ElMessage.error($t('@TAG01:推送标签失败'))
    } finally {
      isPushingTag.value = false
    }
  })
  .catch(() => {
    // 用户取消操作
  })
}

// 确认删除标签
async function confirmDeleteTag(tagName: string) {
  ElMessageBox.confirm(
    $t('@TAG01:确定要删除此标签吗？此操作不可恢复。'),
    $t('@TAG01:删除标签'),
    {
      confirmButtonText: $t('@TAG01:删除'),
      cancelButtonText: $t('@TAG01:取消'),
      type: 'warning'
    }
  )
  .then(async () => {
    await deleteTag(tagName)
  })
  .catch(() => {
    // 用户取消操作
  })
}

// 删除标签
async function deleteTag(tagName: string) {
  try {
    isDeletingTag.value = true
    const response = await fetch('/api/delete-tag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagName })
    })

    const result = await response.json()

    if (result.success) {
      ElMessage.success($t('@TAG01:标签删除成功'))
      await loadTags()
    } else {
      ElMessage.error(result.error || $t('@TAG01:删除标签失败'))
    }
  } catch (error) {
    console.error('删除标签失败:', error)
    ElMessage.error($t('@TAG01:删除标签失败'))
  } finally {
    isDeletingTag.value = false
  }
}

// 格式化日期
function formatDate(dateString: string): string {
  if (!dateString) return '-'
  try {
    const date = new Date(dateString)
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return dateString
  }
}
</script>

<template>
  <div class="tag-list-button">
    <!-- 标签列表按钮 -->
    <el-tooltip 
      :content="$t('@TAG01:查看和管理所有标签')" 
      placement="top"
      :show-after="200"
      :disabled="props.variant === 'text'"
    >
      <el-button 
        type="info"
        @click="openTagListDialog"
        :disabled="!gitStore.isGitRepo"
        :circle="props.variant === 'icon'"
        :size="props.variant === 'icon' ? 'small' : 'default'"
        :class="props.variant === 'text' ? 'action-button' : ''"
      >
        <el-icon v-if="props.variant === 'icon'"><Sell /></el-icon>
        <template v-else>{{ $t('@TAG01:标签列表') }}</template>
      </el-button>
    </el-tooltip>

    <!-- 标签列表弹窗 -->
    <CommonDialog
      v-model="isTagListDialogVisible"
      :title="$t('@TAG01:Git 标签列表')"
      size="large"
      :show-footer="false"
      custom-class="tag-list-dialog"
    >
      <div class="tag-list-content">
        <!-- 头部统计信息 -->
        <div class="tag-header" v-if="!isLoadingTags">
          <div class="tag-stats">
            <div class="stat-item">
              <el-icon class="stat-icon"><Sell /></el-icon>
              <span class="stat-number">{{ tags.length }}</span>
              <span class="stat-label">{{ $t('@TAG01:个标签') }}</span>
            </div>
          </div>
          <div class="tag-actions-header">
            <el-button
              type="primary"
              size="small"
              :icon="Refresh"
              @click="loadTags"
              :loading="isLoadingTags"
              class="refresh-btn"
            >
              {{ $t('@TAG01:刷新') }}
            </el-button>
            <el-button
              v-if="tags.length > 0"
              type="success"
              size="small"
              :icon="Upload"
              @click="pushAllTags"
              :loading="isPushingTag"
              class="push-all-btn"
            >
              {{ $t('@TAG01:推送所有标签') }}
            </el-button>
          </div>
        </div>

        <!-- 标签列表 -->
        <div class="tag-list-container" v-loading="isLoadingTags">
          <div v-if="tags.length === 0 && !isLoadingTags" class="empty-state">
            <el-empty
              :description="$t('@TAG01:暂无标签')"
              :image-size="120"
            >
              <template #image>
                <el-icon class="empty-icon"><Sell /></el-icon>
              </template>
              <template #description>
                <p class="empty-text">{{ $t('@TAG01:还没有创建任何标签') }}</p>
                <p class="empty-hint">{{ $t('@TAG01:使用创建标签功能为项目添加版本标记') }}</p>
              </template>
            </el-empty>
          </div>
          
          <div v-else class="tag-cards">
            <div 
              v-for="tag in tags" 
              :key="tag.name"
              class="tag-card"
            >
              <div class="tag-card-content">
                <div class="tag-info">
                  <div class="tag-main-info">
                    <div class="tag-name-badge">
                      <el-icon class="badge-icon"><Sell /></el-icon>
                      <span class="tag-name-text">{{ tag.name }}</span>
                      <el-tag 
                        size="small" 
                        :type="tag.type === 'annotated' ? 'warning' : 'info'" 
                        class="type-tag"
                      >
                        {{ tag.type === 'annotated' ? $t('@TAG01:附注') : $t('@TAG01:轻量') }}
                      </el-tag>
                    </div>
                    <div class="tag-meta">
                      <span class="tag-commit">
                        <el-icon><InfoFilled /></el-icon>
                        {{ tag.commit.substring(0, 8) }}
                      </span>
                      <span class="tag-date">{{ formatDate(tag.date) }}</span>
                    </div>
                    <div v-if="tag.message" class="tag-message">
                      {{ tag.message }}
                    </div>
                  </div>
                </div>
                
                <div class="tag-card-actions">
                  <el-button
                    v-if="tag.message"
                    size="small"
                    type="info"
                    @click="viewTagDetail(tag)"
                    class="action-btn view-btn"
                  >
                    {{ $t('@TAG01:查看') }}
                  </el-button>
                  <el-button
                    size="small"
                    type="success"
                    :icon="Upload"
                    @click="pushTag(tag.name)"
                    :loading="isPushingTag"
                    class="action-btn push-btn"
                  >
                    {{ $t('@TAG01:推送') }}
                  </el-button>
                  <el-button
                    size="small"
                    type="danger"
                    :icon="Delete"
                    @click="confirmDeleteTag(tag.name)"
                    :loading="isDeletingTag"
                    class="action-btn delete-btn"
                  >
                    {{ $t('@TAG01:删除') }}
                  </el-button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </CommonDialog>

    <!-- 标签详情弹窗 -->
    <CommonDialog
      v-model="tagDetailVisible"
      :title="$t('@TAG01:标签详情')"
      size="medium"
      :show-footer="false"
      custom-class="tag-detail-dialog"
    >
      <div class="tag-detail-content" v-if="selectedTag">
        <div class="detail-row">
          <span class="detail-label">{{ $t('@TAG01:标签名称:') }}</span>
          <code class="detail-value">{{ selectedTag.name }}</code>
        </div>
        <div class="detail-row">
          <span class="detail-label">{{ $t('@TAG01:提交SHA:') }}</span>
          <code class="detail-value">{{ selectedTag.commit }}</code>
        </div>
        <div class="detail-row">
          <span class="detail-label">{{ $t('@TAG01:创建时间:') }}</span>
          <span class="detail-value">{{ formatDate(selectedTag.date) }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">{{ $t('@TAG01:类型:') }}</span>
          <el-tag 
            :type="selectedTag.type === 'annotated' ? 'warning' : 'info'" 
            size="small"
          >
            {{ selectedTag.type === 'annotated' ? $t('@TAG01:附注标签') : $t('@TAG01:轻量标签') }}
          </el-tag>
        </div>
        <div v-if="selectedTag.message" class="detail-row detail-message">
          <span class="detail-label">{{ $t('@TAG01:标签说明:') }}</span>
          <div class="message-content">{{ selectedTag.message }}</div>
        </div>
      </div>
    </CommonDialog>
  </div>
</template>

<style scoped lang="scss">
.tag-list-button {
  display: inline-block;
}

.tag-list-content {
  padding: 0;
  min-height: 400px;
}

/* 标签列表弹窗样式 */
:deep(.tag-list-dialog) {
  .common-dialog__header {
    background: #22c55e;
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
.tag-header {
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

.tag-stats {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
}

.stat-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  padding: var(--spacing-xs) var(--spacing-base);
  background: #22c55e;
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

.tag-actions-header {
  display: flex;
  gap: var(--spacing-base);
}

.refresh-btn,
.push-all-btn {
  border-radius: var(--radius-lg);
  padding: var(--spacing-xs) var(--spacing-base);
  font-weight: 500;
  transition: all 0.3s ease;
  
  &:hover {
    transform: translateY(-1px);
  }
}

/* 标签列表容器 */
.tag-list-container {
  min-height: 300px;
}

/* 空状态样式已移至 @/styles/common.scss */

/* 标签卡片列表 */
.tag-cards {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-base);
}

.tag-card {
  background: var(--bg-container);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-component);
  box-shadow: var(--shadow-md);
  transition: all 0.3s ease;
  overflow: hidden;
  
  &:hover {
    transform: translateY(-1px);
    border-color: #22c55e;
  }
}

.tag-card-content {
  padding: var(--spacing-base);
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
}

.tag-info {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  flex: 1;
  min-width: 0;
}

.tag-main-info {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tag-name-badge {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  flex-shrink: 0;
}

.badge-icon {
  
  color: #22c55e;
}

.tag-name-text {
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  
  font-weight: 600;
  color: var(--color-text);
}

.type-tag {
  margin-left: var(--spacing-sm);
}

.tag-meta {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.tag-commit {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-family: monospace;
  background: var(--bg-panel);
  padding: var(--spacing-xs) 6px;
  border-radius: var(--radius-base);
}

.tag-date {
  color: var(--text-tertiary);
}

.tag-message {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  line-height: 1.4;
  padding: 6px var(--spacing-base);
  background: var(--bg-panel);
  border-radius: var(--radius-md);
  border-left: 3px solid #22c55e;
}

/* 标签列表右侧按钮：默认隐藏，hover时显示 */
.tag-card-actions {
  display: none;
  gap: 6px;
  flex-shrink: 0;
  align-items: center;
}

.tag-card:hover .tag-card-actions {
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

.push-btn:hover {
  box-shadow: var(--shadow-md);
}

.delete-btn:hover {
  box-shadow: var(--shadow-md);
}

/* 标签详情弹窗样式 */
.tag-detail-content {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.detail-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: 10px;
  background: var(--bg-panel);
  border-radius: var(--radius-lg);
  
  &.detail-message {
    flex-direction: column;
    align-items: flex-start;
  }
}

.detail-label {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
  min-width: 80px;
}

.detail-value {
  
  color: var(--color-text);
  
  &:is(code) {
    font-family: monospace;
    background: var(--border-component);
    padding: var(--spacing-xs) var(--spacing-base);
    border-radius: var(--radius-base);
    border: 1px solid var(--border-component);
  }
}

.message-content {
  width: 100%;
  padding: var(--spacing-base);
  background: white;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-card);
  white-space: pre-wrap;
  word-break: break-word;
  
  line-height: 1.6;
}
</style>

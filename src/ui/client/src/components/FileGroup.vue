<script setup lang="ts">
import { computed } from 'vue'
import { ArrowDown, Lock, Unlock, RefreshRight, Close } from '@element-plus/icons-vue'

interface FileItem {
  path: string
  type: string
}

interface Props {
  files: FileItem[]
  title: string
  groupKey: 'staged' | 'unstaged' | 'untracked'
  collapsedGroups: Record<string, boolean>
  isFileLocked: (filePath: string) => boolean
  getFileName: (filePath: string) => string
  getFileDirectory: (filePath: string) => string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  toggleCollapse: [groupKey: 'staged' | 'unstaged' | 'untracked']
  fileClick: [file: FileItem]
  toggleFileLock: [filePath: string]
  stageFile: [filePath: string]
  unstageFile: [filePath: string]
  revertFileChanges: [filePath: string]
}>()

// 计算是否显示该组
const shouldShow = computed(() => props.files.length > 0)

// 计算是否折叠
const isCollapsed = computed(() => props.collapsedGroups[props.groupKey])

// 处理组折叠切换
function handleToggleCollapse() {
  emit('toggleCollapse', props.groupKey)
}

// 处理文件点击
function handleFileClick(file: FileItem) {
  emit('fileClick', file)
}

// 处理文件锁定切换
function handleToggleFileLock(filePath: string, event: Event) {
  event.stopPropagation()
  emit('toggleFileLock', filePath)
}

// 处理暂存文件
function handleStageFile(filePath: string, event: Event) {
  event.stopPropagation()
  emit('stageFile', filePath)
}

// 处理取消暂存
function handleUnstageFile(filePath: string, event: Event) {
  event.stopPropagation()
  emit('unstageFile', filePath)
}

// 处理撤回修改
function handleRevertFile(filePath: string, event: Event) {
  event.stopPropagation()
  emit('revertFileChanges', filePath)
}

// 根据文件类型获取操作按钮配置
function getActionButtons(fileType: string) {
  switch (fileType) {
    case 'added':
      return [
        {
          type: 'unstage',
          tooltip: '取消暂存',
          buttonType: 'warning',
          icon: '-',
          handler: handleUnstageFile
        }
      ]
    case 'modified':
    case 'deleted':
      return [
        {
          type: 'stage',
          tooltip: '添加到暂存区',
          buttonType: 'success',
          icon: '+',
          handler: handleStageFile
        },
        {
          type: 'revert',
          tooltip: '撤回修改',
          buttonType: 'danger',
          icon: RefreshRight,
          handler: handleRevertFile
        }
      ]
    case 'untracked':
      return [
        {
          type: 'stage',
          tooltip: '添加到暂存区',
          buttonType: 'success',
          icon: '+',
          handler: handleStageFile
        },
        {
          type: 'delete',
          tooltip: '删除文件',
          buttonType: 'danger',
          icon: Close,
          handler: handleRevertFile
        }
      ]
    default:
      return []
  }
}
</script>

<template>
  <div v-if="shouldShow" class="file-group">
    <div class="file-group-header" @click="handleToggleCollapse">
      <el-icon class="collapse-icon" :class="{ 'collapsed': isCollapsed }">
        <ArrowDown />
      </el-icon>
      <span>{{ title }}</span>
    </div>
    <div v-show="!isCollapsed" class="file-list">
      <div
        v-for="file in files"
        :key="file.path"
        class="file-item"
        @click="handleFileClick(file)"
      >
        <div class="file-info">
          <div class="file-status-indicator" :class="[file.type, { 'locked': props.isFileLocked(file.path) }]"></div>
          <div class="file-name-section">
            <el-tooltip
              :content="props.getFileName(file.path)"
              placement="top"
              :disabled="props.getFileName(file.path).length <= 25"
              :hide-after="1000"
              :show-after="200"
            >
              <span class="file-name" :class="{ 'locked-file-name': props.isFileLocked(file.path) }">
                {{ props.getFileName(file.path) }}
                <el-icon v-if="props.isFileLocked(file.path)" class="lock-indicator">
                  <Lock />
                </el-icon>
              </span>
            </el-tooltip>
          </div>
          <div class="file-path-section" :title="props.getFileDirectory(file.path)">
            <el-tooltip
              :content="props.getFileDirectory(file.path)"
              placement="top"
              :disabled="props.getFileDirectory(file.path).length <= 30"
              :hide-after="1000"
              :show-after="200"
            >
              <span class="file-directory">{{ props.getFileDirectory(file.path) }}</span>
            </el-tooltip>
          </div>
        </div>
        <div class="file-actions">
          <!-- 锁定/解锁按钮 -->
          <el-tooltip 
            :content="props.isFileLocked(file.path) ? '解锁文件' : '锁定文件'" 
            placement="top" 
            :hide-after="1000" 
            :show-after="200"
          >
            <el-button
              :type="props.isFileLocked(file.path) ? 'danger' : 'info'"
              size="small"
              text
              @click="handleToggleFileLock(file.path, $event)"
              class="file-action-btn"
            >
              <el-icon size="16">
                <component :is="props.isFileLocked(file.path) ? Lock : Unlock" />
              </el-icon>
            </el-button>
          </el-tooltip>
          
          <!-- 动态操作按钮 -->
          <template v-for="action in getActionButtons(file.type)" :key="action.type">
            <el-tooltip :content="action.tooltip" placement="top" :hide-after="1000" :show-after="200">
              <el-button
                :type="action.buttonType"
                size="small"
                text
                @click="action.handler(file.path, $event)"
                class="file-action-btn"
              >
                <el-icon v-if="typeof action.icon !== 'string'" size="16">
                  <component :is="action.icon" />
                </el-icon>
                <span v-else style="font-size: 16px; font-weight: bold;">{{ action.icon }}</span>
              </el-button>
            </el-tooltip>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 使用全局CSS变量 */

.file-group {
  margin-bottom: var(--spacing-md);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--bg-container);
  box-shadow: var(--shadow-base);
  border: 1px solid var(--border-color);
  transition: var(--transition-all);
}

.file-group:hover {
  box-shadow: var(--shadow-hover);
}

.file-group-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-md) var(--spacing-lg);
  background: #f8f9fa;
  cursor: pointer;
  font-weight: var(--font-weight-semibold);
  font-size: var(--font-size-sm);
  color: #303133;
  transition: var(--transition-all);
  position: relative;
  border-bottom: 1px solid #e4e7ed;
}

.file-group-header:hover {
  background: #f0f2f5;
}

.collapse-icon {
  transition: var(--transition-transform);
  font-size: var(--font-size-sm);
  color: #606266;
}

.collapse-icon.collapsed {
  transform: rotate(-90deg);
}

.file-list {
  display: flex;
  flex-direction: column;
  padding: var(--spacing-sm);
  gap: 1px;
}

.file-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-sm) var(--spacing-base);
  background: var(--bg-container);
  border-radius: var(--radius-base);
  cursor: pointer;
  transition: var(--transition-bg), var(--transition-shadow);
  border: 1px solid var(--border-color-light);
  height: 28px;
  box-sizing: border-box;
  position: relative;
}

.file-item::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  width: 3px;
  height: 100%;
  background: transparent;
  transition: var(--transition-all);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}

.file-item:hover {
  background: var(--bg-container-hover);
  border-color: var(--border-hover);
}

.file-item:hover::before {
  background: #409eff;
}

.file-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  flex: 1;
  min-width: 0;
}

.file-status-indicator {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
  transition: var(--transition-all);
}

.file-status-indicator.added {
  background: var(--git-status-added);
}

.file-status-indicator.modified {
  background: var(--git-status-modified);
}

.file-status-indicator.deleted {
  background: var(--git-status-deleted);
}

.file-status-indicator.untracked {
  background: var(--git-status-untracked);
}

.file-status-indicator.locked {
  border: 2px solid var(--git-status-locked);
  background: #fef2f2;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.4); }
  50% { box-shadow: 0 0 0 2px rgba(220, 38, 38, 0); }
}

.file-name-section {
  min-width: 0;
  flex: 0 1 auto;
}

.file-name {
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-tight);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  transition: var(--transition-color);
}

.file-item:hover .file-name {
  color: var(--text-link);
}

.file-name.locked-file-name {
  color: var(--git-status-locked);
  font-weight: var(--font-weight-semibold);
}

.lock-indicator {
  font-size: var(--font-size-xs);
  color: var(--git-status-locked);
}

.file-path-section {
  flex: 1;
  min-width: 0;
  margin-left: var(--spacing-md);
}

.file-directory {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
  font-weight: var(--font-weight-normal);
  background: var(--color-gray-100);
  padding: 1px var(--spacing-sm);
  border-radius: var(--radius-sm);
  transition: var(--transition-all);
}

.file-item:hover .file-directory {
  background: #e0e7ff;
  color: #6366f1;
}

.file-actions {
  display: none;
  align-items: center;
  gap: var(--spacing-xs);
  flex-shrink: 0;
  padding: 1px;
  border-radius: var(--radius-base);
  background: rgba(255, 255, 255, 0.9);
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--border-color-light);
}

.file-item:hover .file-actions {
  display: flex;
  animation: slideIn var(--transition-base) ease-out;
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateX(var(--spacing-base));
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

.file-action-btn {
  min-width: auto !important;
  width: 20px !important;
  height: 20px !important;
  padding: 0 !important;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: var(--transition-all);
  border-radius: var(--radius-sm);
}

.file-action-btn:hover {
  transform: scale(1.05);
  box-shadow: var(--shadow-sm);
}

.file-action-btn:active {
  transform: scale(1);
  transition: var(--transition-fast);
}
</style>

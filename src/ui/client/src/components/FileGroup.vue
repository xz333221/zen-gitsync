<script setup lang="ts">
import { computed } from 'vue'
import { ArrowDown } from '@element-plus/icons-vue'
import FileActionButtons from './FileActionButtons.vue'
import { getFileIconClass } from '../utils/fileIcon'
import { Lock } from '@element-plus/icons-vue'

interface FileItem {
  path: string
  type: string
}

interface Props {
  files: FileItem[]
  title: string
  groupKey: 'staged' | 'unstaged' | 'untracked' | 'conflicted'
  collapsedGroups: Record<string, boolean>
  isFileLocked: (filePath: string) => boolean
  isLocking: (filePath: string) => boolean
  getFileName: (filePath: string) => string
  getFileDirectory: (filePath: string) => string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  toggleCollapse: [groupKey: 'staged' | 'unstaged' | 'untracked' | 'conflicted']
  fileClick: [file: FileItem]
  toggleFileLock: [filePath: string]
  stageFile: [filePath: string]
  unstageFile: [filePath: string]
  revertFileChanges: [filePath: string]
  manageLockedFiles: []
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
function handleToggleFileLock(filePath: string) {
  emit('toggleFileLock', filePath)
}

// 处理管理锁定文件
function handleManageLockedFiles() {
  emit('manageLockedFiles')
}

// 处理暂存文件
function handleStageFile(filePath: string) {
  emit('stageFile', filePath)
}

// 处理取消暂存
function handleUnstageFile(filePath: string) {
  emit('unstageFile', filePath)
}

// 处理撤回修改
function handleRevertFile(filePath: string) {
  emit('revertFileChanges', filePath)
}

// 将文件类型映射为字母标记
function getStatusLetter(fileType: string): string {
  switch (fileType) {
    case 'added':
      return 'A'
    case 'modified':
      return 'M'
    case 'deleted':
      return 'D'
    case 'conflicted':
      return '!'
    case 'untracked':
      return 'U'
    default:
      return ''
  }
}

// 获取文件图标类名
const getFileIcon = (filePath: string) => {
  const fileName = props.getFileName(filePath)
  return getFileIconClass(fileName)
}
</script>

<template>
  <div v-if="shouldShow" class="file-group">
    <div class="file-group-header" @click="handleToggleCollapse">
      <el-icon class="collapse-icon" :class="{ 'collapsed': isCollapsed }">
        <ArrowDown />
      </el-icon>
      <span>{{ title }}</span>
      <span class="file-count">({{ files.length }})</span>
    </div>
    <div v-show="!isCollapsed" class="file-list">
      <div
        v-for="file in files"
        :key="file.path"
        class="file-item file-group-item"
        :class="{ 
          'is-loading': props.isLocking(file.path), 
          'locked': props.isFileLocked(file.path),
          [`file-type-${file.type}`]: file.type
        }"
        @click="handleFileClick(file)"
      >
        <div class="file-info">
          <span :class="['file-type-icon', getFileIcon(file.path)]"></span>
          <div class="file-name-section">
            <el-tooltip
              :content="props.getFileName(file.path)"
              placement="top"
              :disabled="props.getFileName(file.path).length <= 25"
              
              :show-after="200"
            >
              <div class="file-name" :class="{ 'locked-file-name': props.isFileLocked(file.path), 'deleted-file-name': file.type === 'deleted' }">
                {{ props.getFileName(file.path) }}
                <el-icon v-if="props.isFileLocked(file.path)" class="lock-indicator">
                  <Lock />
                </el-icon>
              </div>
            </el-tooltip>
          </div>
          <div class="file-path-section" :title="props.getFileDirectory(file.path)">
            <el-tooltip
              :content="props.getFileDirectory(file.path)"
              placement="top"
              :disabled="props.getFileDirectory(file.path).length <= 30"
              
              :show-after="200"
            >
              <span class="file-directory">{{ props.getFileDirectory(file.path) }}</span>
            </el-tooltip>
          </div>
          <div class="file-status-indicator" :class="[file.type, { 'locked': props.isFileLocked(file.path) }]">
            {{ getStatusLetter(file.type) }}
          </div>
        </div>
        <!-- 悬浮操作按钮 -->
        <div class="file-actions">
          <FileActionButtons
            :file-path="file.path"
            :file-type="file.type"
            :is-locked="props.isFileLocked(file.path)"
            :is-locking="props.isLocking(file.path)"
            @toggle-lock="handleToggleFileLock"
            @stage="handleStageFile"
            @unstage="handleUnstageFile"
            @revert="handleRevertFile"
            @manage-locked-files="handleManageLockedFiles"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 使用全局CSS变量 */

.file-group {
  margin-bottom: var(--spacing-xs);
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
  padding: var(--spacing-base) var(--spacing-lg);
  cursor: pointer;
  font-weight: var(--font-weight-semibold);
  
  
  transition: var(--transition-all);
  position: relative;
  
  .file-count {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    font-weight: var(--font-weight-medium);
    background: var(--bg-panel);
    padding: var(--spacing-xs) var(--spacing-sm);
    border-radius: var(--radius-full);
    border: 1px solid var(--border-card);
    margin-left: auto;
  }
}

.collapse-icon {
  transition: var(--transition-transform);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
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
  padding: 0 var(--spacing-base);
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

/* 冲突文件样式 - 更明显 */
.file-item.file-type-conflicted {
  background-color: rgba(249, 115, 22, 0.1) !important;
  border-color: rgba(249, 115, 22, 0.3) !important;
  
  .file-type-icon {
    color: var(--git-status-conflicted);
  }
  
  .file-name {
    color: var(--git-status-conflicted);
    font-weight: var(--font-weight-semibold);
  }
  
  &:hover {
    background-color: rgba(249, 115, 22, 0.15) !important;
    border-left-color: var(--git-status-conflicted) !important;
    border-color: rgba(249, 115, 22, 0.4) !important;
    box-shadow: 0 0 0 1px rgba(249, 115, 22, 0.25);
    
    &::before {
      width: 5px !important;
    }
  }
}

.file-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  flex: 1;
  min-width: 0;
}

.file-status-indicator {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  transition: var(--transition-all);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
  color: var(--text-secondary);
  margin-left: var(--spacing-md);
}

.file-status-indicator.added { color: var(--git-status-added); }
.file-status-indicator.modified { color: var(--git-status-modified); }
.file-status-indicator.deleted { color: var(--git-status-deleted); }
.file-status-indicator.untracked { color: var(--git-status-untracked); }
.file-status-indicator.conflicted { color: var(--git-status-conflicted); }

.file-type-icon {
  flex-shrink: 0;
  font-size: 16px;
  line-height: 1;
  margin-right: 4px;
}

/* 锁定状态显示特殊样式 */
.file-item.locked {
  opacity: 0.5;
  
  &:hover {
    opacity: 0.65;
  }
}

.file-status-indicator.locked {
  opacity: 1;
}

.file-name-section {
  min-width: 0;
  flex-shrink: 0;
  max-width: 50%;
}

.file-name {
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  line-height: var(--line-height-tight);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  align-items: center;
  gap: var(--spacing-sm);
  transition: var(--transition-color);
}

.file-item:hover .file-name {
  color: var(--text-link);
}

.file-name.deleted-file-name {
  text-decoration: line-through;
  color: var(--git-status-deleted);
}

/* 悬浮时保持删除态颜色 */
.file-item:hover .file-name.deleted-file-name {
  color: var(--git-status-deleted);
}

.lock-indicator {
  font-size: var(--font-size-xs);
  color: var(--git-status-locked);
}

.file-path-section {
  flex: 0 1 auto;
  min-width: 0;
  margin-right: auto;
}

.file-directory {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
  font-weight: var(--font-weight-normal);
  background: var(--bg-file-path);
  padding: 1px var(--spacing-sm);
  border-radius: var(--radius-sm);
  transition: var(--transition-all);
}

.file-item:hover .file-directory {
  background: var(--bg-file-path-hover);
  color: var(--color-file-path-hover);
}

/* 右侧悬浮操作区 */
.file-actions {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  display: none;
  align-items: center;
  gap: var(--spacing-xs);
  
  border-radius: var(--radius-base);
  background: var(--bg-container);
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--border-color-light);
}

.file-item:hover .file-actions {
  display: flex;
}
</style>

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
              circle
              @click="handleToggleFileLock(file.path, $event)"
              class="file-action-btn"
            >
              <el-icon size="12">
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
                circle
                @click="action.handler(file.path, $event)"
                class="file-action-btn"
                :icon="typeof action.icon === 'string' ? undefined : action.icon"
              >
                <span v-if="typeof action.icon === 'string'">{{ action.icon }}</span>
              </el-button>
            </el-tooltip>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.file-group {
  margin-bottom: 16px;
}

.file-group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background-color: #f8fafc;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 500;
  font-size: 14px;
  color: #374151;
  border: 1px solid #e5e7eb;
  transition: all 0.2s ease;
  margin-bottom: 8px;
}

.file-group-header:hover {
  background-color: #f1f5f9;
  border-color: #d1d5db;
}

.collapse-icon {
  transition: transform 0.2s ease;
  font-size: 16px;
  color: #6b7280;
}

.collapse-icon.collapsed {
  transform: rotate(-90deg);
}

.file-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.file-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background-color: #fff;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
  border: 1px solid #f3f4f6;
  min-height: 48px;
}

.file-item:hover {
  background-color: #f9fafb;
  border-color: #e5e7eb;
  transform: translateY(-1px);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
}

.file-info {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}

.file-status-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.file-status-indicator.added {
  background-color: #22c55e;
}

.file-status-indicator.modified {
  background-color: #f59e0b;
}

.file-status-indicator.deleted {
  background-color: #ef4444;
}

.file-status-indicator.untracked {
  background-color: #8b5cf6;
}

.file-status-indicator.locked {
  border: 2px solid #dc2626;
  background-color: transparent;
}

.file-name-section {
  min-width: 0;
  flex-shrink: 1;
}

.file-name {
  font-weight: 500;
  color: #1f2937;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.file-name.locked-file-name {
  color: #dc2626;
}

.lock-indicator {
  font-size: 12px;
  color: #dc2626;
}

.file-path-section {
  flex: 1;
  min-width: 0;
  margin-left: 8px;
}

.file-directory {
  font-size: 12px;
  color: #6b7280;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
}

.file-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.file-action-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: bold;
}
</style>
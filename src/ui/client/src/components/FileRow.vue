<!--
  ~ Copyright 2026 xz333221
  ~
  ~ Licensed under the Apache License, Version 2.0 (the "License");
  ~ you may not use this file except in compliance with the License.
  ~ You may obtain a copy of the License at
  ~
  ~     http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing, software
  ~ distributed under the License is distributed on an "AS IS" BASIS,
  ~ WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  ~ See the License for the specific language governing permissions and
  ~ limitations under the License.
  -->
<!--
  列表视图的单行文件（原 FileGroup.vue 里 .file-item 的行内容 + 样式整体搬过来）。
  行高在 CSS 里写死 28px，外层 .vfl__row--file 再留 1px 间隙 = 29px，
  必须与 utils/fileListRows.ts 的 FILE_ROW_H 一致，否则虚拟滚动偏移会累加误差。
-->
<script setup lang="ts">
import { Lock } from '@element-plus/icons-vue'
import FileActionButtons from './FileActionButtons.vue'
import { getFileIconClass } from '../utils/fileIcon'

interface FileItem {
  path: string
  type: string
}

interface Props {
  file: FileItem
  isFileLocked: (filePath: string) => boolean
  isLocking: (filePath: string) => boolean
  getFileName: (filePath: string) => string
  getFileDirectory: (filePath: string) => string
  isSelectionMode?: boolean
  isFileSelected?: (filePath: string) => boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  fileClick: [file: FileItem]
  toggleFileLock: [filePath: string]
  stageFile: [filePath: string]
  unstageFile: [filePath: string]
  revertFileChanges: [filePath: string]
  manageLockedFiles: []
  toggleFileSelection: [filePath: string]
}>()

// 处理文件点击
function handleFileClick(event?: MouseEvent) {
  // 如果在选择模式下，点击文件会切换选择状态
  if (props.isSelectionMode) {
    event?.stopPropagation()
    emit('toggleFileSelection', props.file.path)
  } else {
    emit('fileClick', props.file)
  }
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
    case 'intent-to-add':
      return 'I'
    default:
      return ''
  }
}

// 获取文件图标类名
const getFileIcon = (filePath: string) => getFileIconClass(props.getFileName(filePath))
</script>

<template>
  <div
    class="file-item file-group-item"
    :class="{
      'is-loading': isLocking(file.path),
      'locked': isFileLocked(file.path),
      'selected': isSelectionMode && isFileSelected?.(file.path),
      [`file-type-${file.type}`]: file.type
    }"
    @click="handleFileClick($event)"
  >
    <div class="file-info">
      <!-- 选择模式下显示复选框 -->
      <el-checkbox
        v-if="isSelectionMode"
        :model-value="isFileSelected?.(file.path)"
        @change="emit('toggleFileSelection', file.path)"
        @click.stop
        class="file-checkbox"
      />
      <svg class="file-type-icon mit-icon" aria-hidden="true">
        <use :xlink:href="`#${getFileIcon(file.path)}`" />
      </svg>
      <div class="file-name-section">
        <el-tooltip
          :content="getFileName(file.path)"
          placement="top"
          :disabled="getFileName(file.path).length <= 25"
          :show-after="200"
        >
          <div
            class="file-name"
            :class="{ 'locked-file-name': isFileLocked(file.path), 'deleted-file-name': file.type === 'deleted' }"
          >
            {{ getFileName(file.path) }}
            <el-icon v-if="isFileLocked(file.path)" class="lock-indicator">
              <Lock />
            </el-icon>
          </div>
        </el-tooltip>
      </div>
      <div class="file-path-section" :title="getFileDirectory(file.path)">
        <el-tooltip
          :content="getFileDirectory(file.path)"
          placement="top"
          :disabled="getFileDirectory(file.path).length <= 30"
          :show-after="200"
        >
          <span class="file-directory">{{ getFileDirectory(file.path) }}</span>
        </el-tooltip>
      </div>
      <div class="file-status-indicator" :class="[file.type, { 'locked': isFileLocked(file.path) }]">
        {{ getStatusLetter(file.type) }}
      </div>
    </div>
    <!-- 悬浮操作按钮（非选择模式下显示） -->
    <div v-if="!isSelectionMode" class="file-actions">
      <FileActionButtons
        :file-path="file.path"
        :file-type="file.type"
        :is-locked="isFileLocked(file.path)"
        :is-locking="isLocking(file.path)"
        @toggle-lock="(p: string) => emit('toggleFileLock', p)"
        @stage="(p: string) => emit('stageFile', p)"
        @unstage="(p: string) => emit('unstageFile', p)"
        @revert="(p: string) => emit('revertFileChanges', p)"
        @manage-locked-files="emit('manageLockedFiles')"
      />
    </div>
  </div>
</template>

<style scoped>
/* 使用全局CSS变量 */

.file-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--spacing-base);
  background: var(--bg-container);
  border-radius: var(--radius-base);
  cursor: pointer;
  transition: var(--transition-bg), var(--transition-shadow);
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
  border-radius: 0 var(--radius-base) var(--radius-base) 0;
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
  font-size: var(--font-size-sm);
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
  font-size: var(--font-size-md);
  line-height: 1;
  margin-right: var(--spacing-sm);
}

.file-type-icon.mit-icon {
  width: 16px;
  height: 16px;
  fill: currentColor;
  display: inline-block;
  vertical-align: middle;
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
  color: var(--text-meta);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
  font-weight: var(--font-weight-normal);
  background: var(--bg-file-path);
  padding: 1px var(--spacing-sm);
  border-radius: var(--radius-base);
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
}

.file-item:hover .file-actions {
  display: flex;
}

/* 选择模式样式 */
.file-checkbox {
  margin-right: var(--spacing-sm);
}

.file-item.selected {
  background: var(--tint-primary-10);
  border-color: var(--tint-primary-30);
}

.file-item.selected::before {
  width: 3px;
  background: var(--color-primary);
}

.file-item.selected:hover {
  background: var(--tint-primary-16);
  border-color: rgba(64, 158, 255, 0.4);
}
</style>

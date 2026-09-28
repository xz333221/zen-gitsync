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
  列表视图的虚拟滚动（替代原来的 5 个 FileGroup 全量 v-for）。
  行数组由 utils/fileListRows.ts 摊平，窗口计算在 composables/useVirtualWindow.ts，
  这里只负责渲染"分组标题行 + FileRow"。滚动容器是外层 .file-list-container（本组件不滚）。
-->
<script setup lang="ts">
import { ArrowDown } from '@element-plus/icons-vue'
import FileRow from './FileRow.vue'
import { useVirtualWindow } from '@/composables/useVirtualWindow'
import { rowHeight, type FileGroupKey, type ListFileItem, type ListRow } from '@/utils/fileListRows'

interface Props {
  rows: ListRow[]
  isFileLocked: (filePath: string) => boolean
  isLocking: (filePath: string) => boolean
  getFileName: (filePath: string) => string
  getFileDirectory: (filePath: string) => string
  isSelectionMode?: boolean
  isFileSelected?: (filePath: string) => boolean
  /** 视口外上下各多渲染的像素数：越小越省，越大滚动时越不容易露白 */
  overscan?: number
}

const props = withDefaults(defineProps<Props>(), {
  isSelectionMode: false,
  overscan: 400,
})

const emit = defineEmits<{
  toggleCollapse: [groupKey: FileGroupKey]
  fileClick: [file: ListFileItem]
  toggleFileLock: [filePath: string]
  stageFile: [filePath: string]
  unstageFile: [filePath: string]
  revertFileChanges: [filePath: string]
  manageLockedFiles: []
  toggleFileSelection: [filePath: string]
}>()

const { root, visibleRows, totalHeight } = useVirtualWindow<ListRow>(
  () => props.rows,
  rowHeight,
  props.overscan,
)
</script>

<template>
  <div ref="root" class="vfl">
    <div class="vfl__spacer" :style="{ height: `${totalHeight}px` }">
      <div
        v-for="item in visibleRows"
        :key="item.row.key"
        class="vfl__row"
        :class="item.row.kind === 'header' ? 'vfl__row--header' : 'vfl__row--file'"
        :style="{ transform: `translateY(${item.top}px)` }"
      >
        <!-- 分组标题行 -->
        <div
          v-if="item.row.kind === 'header'"
          class="vfl__header"
          role="button"
          :aria-expanded="!item.row.collapsed"
          @click="emit('toggleCollapse', item.row.groupKey)"
        >
          <el-icon class="collapse-icon" :class="{ collapsed: item.row.collapsed }">
            <ArrowDown />
          </el-icon>
          <span class="vfl__header-title">{{ item.row.title }}</span>
          <span class="file-count">({{ item.row.count }})</span>
        </div>

        <!-- 文件行 -->
        <FileRow
          v-else
          :file="item.row.file"
          :is-file-locked="isFileLocked"
          :is-locking="isLocking"
          :get-file-name="getFileName"
          :get-file-directory="getFileDirectory"
          :is-selection-mode="isSelectionMode"
          :is-file-selected="isFileSelected"
          @file-click="(f: ListFileItem) => emit('fileClick', f)"
          @toggle-file-lock="(p: string) => emit('toggleFileLock', p)"
          @stage-file="(p: string) => emit('stageFile', p)"
          @unstage-file="(p: string) => emit('unstageFile', p)"
          @revert-file-changes="(p: string) => emit('revertFileChanges', p)"
          @manage-locked-files="emit('manageLockedFiles')"
          @toggle-file-selection="(p: string) => emit('toggleFileSelection', p)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 行高/偏移全部由固定行高推导，常量见 utils/fileListRows.ts，改一边必须改另一边 */
.vfl {
  width: 100%;
  /* 水平留白（原 FileGroup .file-list 的 padding），纵向不参与行高计算 */
  padding: 0 var(--spacing-sm);
  box-sizing: border-box;
}

.vfl__spacer {
  position: relative;
  width: 100%;
}

.vfl__row {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
}

/* 29px = 28px 行高（FileRow .file-item）+ 1px 行间距 */
.vfl__row--file {
  height: 29px;
  box-sizing: border-box;
  padding-bottom: 1px;
}

/* 42px = 6px 组间距 + 36px 标题条 */
.vfl__row--header {
  height: 42px;
  box-sizing: border-box;
  padding-top: 6px;
}

.vfl__header {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  height: 36px;
  box-sizing: border-box;
  padding: 0 var(--spacing-lg);
  cursor: pointer;
  font-weight: var(--font-weight-semibold);
  background: var(--bg-container);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-base);
  transition: var(--transition-all);
}

.vfl__header:hover {
  box-shadow: var(--shadow-hover);
}

.vfl__header-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vfl__header .file-count {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  font-weight: var(--font-weight-medium);
  background: var(--bg-panel);
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: var(--radius-full);
  margin-left: auto;
}

.collapse-icon {
  transition: var(--transition-transform);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.collapse-icon.collapsed {
  transform: rotate(-90deg);
}
</style>

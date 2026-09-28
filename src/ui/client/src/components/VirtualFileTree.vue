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
  树状视图的虚拟滚动（替代原来的 FileTreeView 递归全量渲染）。
  行数组由 utils/fileTreeRows.ts 摊平（只含可见节点），这里只渲染视口 ± overscan 的行。

  节点行复用 **TreeNodeItem**（样式/图标/操作按钮全不变）：传进去的是剥掉 children 的
  浅拷贝，所以它不会自己递归；展开/折叠改的是行里的 `source`（真节点）。
-->
<script setup lang="ts">
import { ArrowDown } from '@element-plus/icons-vue'
import TreeNodeItem from './TreeNodeItem.vue'
import { useVirtualWindow } from '@/composables/useVirtualWindow'
import type { TreeNode } from '@/utils/fileTree'
import type { FileGroupKey } from '@/utils/fileListRows'
import { treeRowHeight, type TreeFlatNode, type TreeListRow } from '@/utils/fileTreeRows'

interface Props {
  rows: TreeListRow[]
  selectedFile?: string
  isFileLocked: (filePath: string) => boolean
  isLocking: (filePath: string) => boolean
  showActionButtons?: boolean
  overscan?: number
}

const props = withDefaults(defineProps<Props>(), {
  selectedFile: '',
  showActionButtons: true,
  overscan: 400,
})

const emit = defineEmits<{
  toggleCollapse: [groupKey: FileGroupKey]
  toggleNode: [node: TreeNode]
  fileSelect: [file: { path: string; type: string }]
  toggleLock: [filePath: string]
  stage: [filePath: string]
  unstage: [filePath: string]
  revert: [filePath: string]
}>()

const { root, visibleRows, totalHeight } = useVirtualWindow<TreeListRow>(
  () => props.rows,
  treeRowHeight,
  props.overscan,
)

/**
 * TreeNodeItem 的 node-click 带回来的是「浅拷贝」，改它没用 ——
 * 展开/折叠要用行里的 source（真节点，改它会触发 row 重算）。
 */
function handleNodeClick(item: TreeFlatNode) {
  if (item.source.isDirectory) {
    emit('toggleNode', item.source)
  } else {
    emit('fileSelect', { path: item.source.path, type: item.source.type || 'modified' })
  }
}

/** 给上层 handleFileClick 的 type：文件节点用真节点的 type（目录行不会走到这里） */
function fileTypeOf(row: TreeListRow): string {
  return row.kind === 'node' ? row.source.type || 'modified' : 'modified'
}
</script>

<template>
  <div ref="root" class="vft">
    <div class="vft__spacer" :style="{ height: `${totalHeight}px` }">
      <div
        v-for="item in visibleRows"
        :key="item.row.key"
        class="vft__row"
        :class="item.row.kind === 'tree-header' ? 'vft__row--header' : 'vft__row--node'"
        :style="{ transform: `translateY(${item.top}px)` }"
      >
        <!-- 分组标题行 -->
        <div
          v-if="item.row.kind === 'tree-header'"
          class="vft__header"
          role="button"
          :aria-expanded="!item.row.collapsed"
          @click="emit('toggleCollapse', item.row.groupKey)"
        >
          <el-icon class="collapse-icon" :class="{ collapsed: item.row.collapsed }">
            <ArrowDown />
          </el-icon>
          <span class="vft__header-title">{{ item.row.title }}</span>
          <span class="file-count">({{ item.row.count }})</span>
        </div>

        <!-- 节点行（复用 TreeNodeItem） -->
        <TreeNodeItem
          v-else
          :node="item.row.node"
          :level="item.row.level"
          :selected-file="selectedFile"
          :show-action-buttons="showActionButtons"
          :is-file-locked="isFileLocked"
          :is-locking="isLocking"
          @node-click="handleNodeClick(item.row)"
          @file-select="(path: string) => emit('fileSelect', { path, type: fileTypeOf(item.row) })"
          @toggle-lock="(path: string) => emit('toggleLock', path)"
          @stage="(path: string) => emit('stage', path)"
          @unstage="(path: string) => emit('unstage', path)"
          @revert="(path: string) => emit('revert', path)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 行高常量见 utils/fileTreeRows.ts：TREE_NODE_ROW_H=33 / TREE_HEADER_ROW_H=42 */
.vft {
  width: 100%;
  box-sizing: border-box;
}

.vft__spacer {
  position: relative;
  width: 100%;
}

.vft__row {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
}

/* 33px = TreeNodeItem .tree-node 的 min-height 32px + 1px border-bottom */
.vft__row--node {
  height: 33px;
  box-sizing: border-box;
  overflow: hidden;
}

/* 42px = 6px 组间距 + 36px 标题条（与列表视图的标题行统一） */
.vft__row--header {
  height: 42px;
  box-sizing: border-box;
  padding-top: 6px;
}

.vft__header {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  height: 36px;
  box-sizing: border-box;
  padding: 0 var(--spacing-lg);
  margin: 0 var(--spacing-sm);
  cursor: pointer;
  font-weight: var(--font-weight-semibold);
  background: var(--bg-container);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-base);
  transition: var(--transition-all);
}

.vft__header:hover {
  box-shadow: var(--shadow-hover);
}

.vft__header-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vft__header .file-count {
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

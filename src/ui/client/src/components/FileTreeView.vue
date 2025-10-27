<script setup lang="ts">
import { ref } from 'vue';
import type { TreeNode } from '@/utils/fileTree';
import { toggleNodeExpanded } from '@/utils/fileTree';
import TreeNodeItem from './TreeNodeItem.vue';

interface Props {
  treeData: TreeNode[];
  selectedFile?: string;
  showActionButtons?: boolean;
  isFileLocked?: (filePath: string) => boolean;
  isLocking?: (filePath: string) => boolean;
}

withDefaults(defineProps<Props>(), {
  selectedFile: '',
  showActionButtons: false,
  isFileLocked: () => false,
  isLocking: () => false
});

interface Emits {
  (e: 'file-select', filePath: string): void;
  (e: 'toggle-lock', filePath: string): void;
  (e: 'stage', filePath: string): void;
  (e: 'unstage', filePath: string): void;
  (e: 'revert', filePath: string): void;
}

const emit = defineEmits<Emits>();

// 用于强制更新的key
const updateKey = ref(0);

// 处理节点点击
function handleNodeClick(node: TreeNode) {
  if (node.isDirectory) {
    // 切换目录展开状态
    toggleNodeExpanded(node);
    // 强制更新视图
    updateKey.value++;
  } else if (node.file) {
    // 选中文件
    emit('file-select', node.path);
  }
}
</script>

<template>
  <div class="file-tree-view">
    <TreeNodeItem
      v-for="node in treeData"
      :key="node.path + '-' + (node.expanded ? 'open' : 'closed')"
      :node="node"
      :level="0"
      :selected-file="selectedFile"
      :show-action-buttons="showActionButtons"
      :is-file-locked="isFileLocked"
      :is-locking="isLocking"
      @file-select="(path) => emit('file-select', path)"
      @toggle-lock="(path) => emit('toggle-lock', path)"
      @stage="(path) => emit('stage', path)"
      @unstage="(path) => emit('unstage', path)"
      @revert="(path) => emit('revert', path)"
      @node-click="handleNodeClick"
    />
  </div>
</template>

<style scoped lang="scss">
.file-tree-view {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
}
</style>

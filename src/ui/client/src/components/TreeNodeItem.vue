<script setup lang="ts">
import { $t } from '@/lang/static.ts'
import { ElIcon, ElTooltip } from 'element-plus';
import { Lock, Folder } from '@element-plus/icons-vue';
import { getFileIconClass } from '../utils/fileIcon';
import type { TreeNode } from '@/utils/fileTree';
import FileActionButtons from './FileActionButtons.vue';

interface Props {
  node: TreeNode;
  level: number;
  selectedFile?: string;
  showActionButtons?: boolean;
  isFileLocked?: (filePath: string) => boolean;
  isLocking?: (filePath: string) => boolean;
}

const props = withDefaults(defineProps<Props>(), {
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
  (e: 'node-click', node: TreeNode): void;
}

const emit = defineEmits<Emits>();

// 获取节点缩进
function getIndent(level: number): string {
  return `${level * 20 + 10}px`;
}

// 获取图标class
function getIconClass(node: TreeNode): string {
  if (node.isDirectory) {
    // 文件夹统一使用file-icons-js的文件夹图标
    return 'icon-file-directory';
  }
  return getFileIconClass(node.name);
}

// 判断是否选中
function isSelected(node: TreeNode): boolean {
  return !node.isDirectory && node.path === props.selectedFile;
}

// 处理节点点击
function handleClick() {
  emit('node-click', props.node);
}
</script>

<template>
  <div class="tree-node-wrapper">
    <div
      class="tree-node"
      :class="{
        'is-directory': node.isDirectory,
        'is-file': !node.isDirectory,
        'is-selected': isSelected(node),
        'is-locked': node.locked,
        [`file-type-${node.type}`]: node.type
      }"
      :style="{ paddingLeft: getIndent(level) }"
      @click="handleClick"
    >
      <!-- 文件/文件夹图标 -->
      <el-icon v-if="node.isDirectory" class="folder-icon">
        <Folder />
      </el-icon>
      <span v-else :class="['node-icon', 'file-icon', getIconClass(node)]"></span>
      
      <!-- 节点名称 -->
      <el-tooltip
        :content="node.path"
        placement="top"
        :disabled="node.name.length <= 35"
        :show-after="200"
      >
        <span class="node-name">{{ node.name }}</span>
      </el-tooltip>
      
      <!-- 文件类型标签 -->
      <span v-if="!node.isDirectory" class="file-type-tag">
        {{ node.type || 'modified' }}
      </span>
      
      <!-- 锁定图标 -->
      <el-tooltip
        v-if="node.locked"
        :content="$t('@E80AC:该文件已被锁定，提交时会被跳过')"
        placement="top"
        :show-after="200"
      >
        <el-icon class="lock-icon" color="var(--color-warning)">
          <Lock />
        </el-icon>
      </el-tooltip>
      
      <!-- 文件操作按钮 -->
      <div v-if="showActionButtons && !node.isDirectory && node.file" class="file-actions">
        <FileActionButtons
          :file-path="node.path"
          :file-type="node.type || 'modified'"
          :is-locked="isFileLocked(node.path)"
          :is-locking="isLocking(node.path)"
          @toggle-lock="(path: string) => emit('toggle-lock', path)"
          @stage="(path: string) => emit('stage', path)"
          @unstage="(path: string) => emit('unstage', path)"
          @revert="(path: string) => emit('revert', path)"
        />
      </div>
    </div>
    
    <!-- 递归渲染子节点 -->
    <div v-if="node.isDirectory && node.expanded && node.children && node.children.length > 0" class="tree-children">
      <TreeNodeItem
        v-for="childNode in node.children"
        :key="childNode.path + '-' + (childNode.expanded ? 'open' : 'closed')"
        :node="childNode"
        :level="level + 1"
        :selected-file="selectedFile"
        :show-action-buttons="showActionButtons"
        :is-file-locked="isFileLocked"
        :is-locking="isLocking"
        @file-select="(path: string) => emit('file-select', path)"
        @toggle-lock="(path: string) => emit('toggle-lock', path)"
        @stage="(path: string) => emit('stage', path)"
        @unstage="(path: string) => emit('unstage', path)"
        @revert="(path: string) => emit('revert', path)"
        @node-click="(node: TreeNode) => emit('node-click', node)"
      />
    </div>
  </div>
</template>

<style scoped lang="scss">
.tree-node-wrapper {
  width: 100%;
}

.tree-node {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: 6px var(--spacing-md);
  cursor: pointer;
  transition: var(--transition-all);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  position: relative;
  background: transparent;
  min-height: 32px;
  
  &::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    width: 3px;
    height: 100%;
    background: transparent;
    transition: var(--transition-all);
  }
  
  &:hover {
    background: var(--bg-panel);
    
    &::before {
      background: var(--color-primary);
    }
  }
  
  &.is-selected {
    background: #e6f7ff;
    color: #1890ff;
    border-left: 3px solid #1890ff;
    
    &::before {
      background: #1890ff;
      width: 4px;
    }
    
    .node-icon {
      color: #1890ff;
    }
    
    // 深色模式优化
    [data-theme="dark"] & {
      background: rgba(24, 144, 255, 0.15);
      color: var(--color-primary);
      border-left-color: var(--color-primary);
      
      &::before {
        background: var(--color-primary);
      }
      
      .node-icon {
        color: var(--color-primary);
      }
    }
  }
  
  &.is-directory {
    font-weight: var(--font-weight-medium);
    
    &:hover {
      background: var(--bg-icon-hover);
    }
  }
  
  // 文件类型颜色标识
  &.file-type-added {
    &::before {
      background: var(--git-status-added);
    }
    
    &:not(.is-selected):hover {
      background: linear-gradient(90deg, rgba(16, 185, 129, 0.1) 0%, rgba(255, 255, 255, 0.8) 100%);
      
      &::before {
        background: var(--git-status-added);
        width: 4px;
      }
    }
  }
  
  &.file-type-modified {
    &::before {
      background: var(--git-status-modified);
    }
    
    &:not(.is-selected):hover {
      background: linear-gradient(90deg, rgba(245, 158, 11, 0.1) 0%, rgba(255, 255, 255, 0.8) 100%);
      
      &::before {
        background: var(--git-status-modified);
        width: 4px;
      }
    }
  }
  
  &.file-type-deleted {
    &::before {
      background: var(--git-status-deleted);
    }
    
    &:not(.is-selected):hover {
      background: linear-gradient(90deg, rgba(239, 68, 68, 0.1) 0%, rgba(255, 255, 255, 0.8) 100%);
      
      &::before {
        background: var(--git-status-deleted);
        width: 4px;
      }
    }
  }
  
  &.file-type-untracked {
    &::before {
      background: var(--git-status-untracked);
    }
    
    &:not(.is-selected):hover {
      background: linear-gradient(90deg, rgba(139, 92, 246, 0.1) 0%, rgba(255, 255, 255, 0.8) 100%);
      
      &::before {
        background: var(--git-status-untracked);
        width: 4px;
      }
    }
  }
}

.node-icon {
  flex-shrink: 0;
  font-size: 16px;
  line-height: 1;
  margin-right: var(--spacing-xs);
  
  &.folder-icon {
    color: #faad14;
  }
}

.node-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  transition: var(--transition-color);
  min-width: 40px;
  
  .is-selected & {
    color: #1890ff;
    font-weight: var(--font-weight-semibold);
    
    // 深色模式优化
    [data-theme="dark"] & {
      color: var(--color-primary);
    }
  }
  
  .is-directory & {
    font-weight: var(--font-weight-semibold);
  }
}

.file-type-tag {
  font-size: var(--font-size-xs);
  padding: var(--spacing-xs) var(--spacing-base);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.lock-icon {
  margin-left: auto;
  flex-shrink: 0;
  opacity: 0.9;
}

.file-actions {
  position: absolute;
  right: 12px;
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

.tree-node:hover .file-actions {
  display: flex;
}

.tree-children {
  width: 100%;
}
</style>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { ElEmpty, ElScrollbar, ElTooltip, ElIcon } from 'element-plus';
import { Document } from '@element-plus/icons-vue';
import { formatDiff } from '../utils/index.ts';

// 定义props
interface FileItem {
  path: string;
  name?: string; // 用于显示的文件名，如果没有则使用path
  type?: string; // 文件类型，可选
}

interface Props {
  files: FileItem[]; // 文件列表
  emptyText?: string; // 无文件时的提示文本
  diffContent?: string; // 当前差异内容
  selectedFile?: string; // 当前选中的文件路径
  height?: string; // 组件高度
  showFileList?: boolean; // 是否显示文件列表，默认true
}

const props = withDefaults(defineProps<Props>(), {
  emptyText: '没有找到变更文件',
  diffContent: '',
  selectedFile: '',
  height: '100%',
  showFileList: true
});

// 定义事件
interface Emits {
  (e: 'file-select', filePath: string): void; // 选择文件时触发
}

const emit = defineEmits<Emits>();

// 内部状态
const internalSelectedFile = ref<string>('');

// 计算属性
const currentSelectedFile = computed(() => {
  return props.selectedFile || internalSelectedFile.value;
});

const displayFiles = computed(() => {
  return props.files.map(file => ({
    ...file,
    displayName: file.name || file.path.split('/').pop() || file.path
  }));
});

const hasDiffContent = computed(() => {
  return props.diffContent && props.diffContent.trim() !== '';
});

// 方法
function handleFileSelect(filePath: string) {
  internalSelectedFile.value = filePath;
  emit('file-select', filePath);
}

// 监听props.selectedFile变化，同步内部状态
watch(() => props.selectedFile, (newVal) => {
  if (newVal !== undefined) {
    internalSelectedFile.value = newVal;
  }
});

// 当文件列表变化时，如果当前没有选中文件且有文件列表，自动选中第一个
watch(() => props.files, (newFiles) => {
  if (newFiles.length > 0 && !currentSelectedFile.value) {
    const firstFile = newFiles[0];
    handleFileSelect(firstFile.path);
  }
}, { immediate: true });
</script>

<template>
  <div class="file-diff-viewer" :style="{ height }">
    <!-- 文件列表面板 -->
    <div v-if="showFileList" class="files-panel">
      <div class="panel-header">
        <h4>变更文件</h4>
        <span v-if="files.length > 0" class="file-count">({{ files.length }})</span>
      </div>
      
      <div class="files-list">
        <el-scrollbar height="100%">
          <el-empty 
            v-if="files.length === 0"
            :description="emptyText"
            :image-size="60"
          />
          
          <div
            v-for="file in displayFiles"
            :key="file.path"
            class="file-item"
            :class="{ 
              'active': file.path === currentSelectedFile,
              [`file-type-${file.type}`]: file.type 
            }"
            @click="handleFileSelect(file.path)"
          >
            <el-icon class="file-icon">
              <Document />
            </el-icon>
            <el-tooltip
              :content="file.path"
              placement="top"
              :disabled="file.displayName.length <= 35"
              :hide-after="1000"
              :show-after="200"
            >
              <span class="file-name">{{ file.displayName }}</span>
            </el-tooltip>
          </div>
        </el-scrollbar>
      </div>
    </div>

    <!-- 差异显示面板 -->
    <div class="diff-panel" :class="{ 'full-width': !showFileList }">
      <div class="panel-header">
        <h4>文件差异</h4>
        <span v-if="currentSelectedFile" class="selected-file">
          {{ currentSelectedFile.split('/').pop() }}
        </span>
      </div>
      
      <div class="diff-content">
        <el-empty 
          v-if="!hasDiffContent"
          :description="currentSelectedFile ? '该文件没有差异内容' : '请选择文件查看差异'"
          :image-size="80"
        />
        
        <div 
          v-else
          class="diff-text"
          v-html="formatDiff(diffContent)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
/* 导入全局变量 */
@import '../styles/variables.scss';

.file-diff-viewer {
  display: flex;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background-color: var(--bg-container);
  height: 100%; /* 确保填充满父容器 */
  flex: 1; /* 关键：允许在flex父容器中伸缩 */
  min-height: 0; /* 关键：允许flex子元素收缩 */
  box-shadow: var(--shadow-base);
  transition: var(--transition-all);
}

.files-panel {
  width: 300px;
  min-width: 250px;
  background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  box-shadow: inset -1px 0 0 var(--border-color-light);
}

.diff-panel {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-container);
  
  &.full-width {
    width: 100%;
  }
}

.panel-header {
  padding: var(--spacing-md) var(--spacing-lg);
  background: var(--color-primary-gradient);
  color: var(--color-white);
  border-bottom: 1px solid var(--border-color);
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
  
  h4 {
    margin: 0;
    font-size: var(--font-size-md);
    font-weight: var(--font-weight-semibold);
    color: var(--color-white);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  }
}

.file-count {
  font-size: var(--font-size-xs);
  color: rgba(255, 255, 255, 0.8);
  font-weight: var(--font-weight-medium);
  background: rgba(255, 255, 255, 0.15);
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: var(--radius-full);
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.selected-file {
  font-size: var(--font-size-xs);
  color: rgba(255, 255, 255, 0.8);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: rgba(255, 255, 255, 0.1);
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: var(--radius-sm);
}

.files-list {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(10px);
  border-radius: 0 0 var(--radius-base) 0;
}



.file-item {
  display: flex;
  align-items: center;
  padding: var(--spacing-base) var(--spacing-lg);
  cursor: pointer;
  transition: var(--transition-all);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  position: relative;
  background: transparent;
  
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
    background: linear-gradient(90deg, rgba(64, 158, 255, 0.08) 0%, rgba(255, 255, 255, 0.5) 100%);
    transform: translateX(2px);
    
    &::before {
      background: var(--color-primary);
    }
  }
  
  &.active {
    background: var(--color-primary-gradient);
    color: var(--color-white);
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.1);
    
    &::before {
      background: var(--color-white);
      width: 4px;
    }
    
    .file-icon {
      color: var(--color-white);
    }
  }
  
  // 根据文件类型添加不同样式 - 使用统一的Git状态颜色
  &.file-type-added {
    &::before {
      background: var(--git-status-added);
    }
    
    &:not(.active):hover {
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
    
    &:not(.active):hover {
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
    
    &:not(.active):hover {
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
    
    &:not(.active):hover {
      background: linear-gradient(90deg, rgba(139, 92, 246, 0.1) 0%, rgba(255, 255, 255, 0.8) 100%);
      
      &::before {
        background: var(--git-status-untracked);
        width: 4px;
      }
    }
  }
}

.file-icon {
  margin-right: var(--spacing-base);
  color: var(--text-secondary);
  font-size: var(--font-size-lg);
  flex-shrink: 0;
  transition: var(--transition-color);
}

.file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  transition: var(--transition-color);
  
  .active & {
    color: var(--color-white);
    font-weight: var(--font-weight-semibold);
  }
}

.diff-content {
  flex: 1;
  padding: var(--spacing-lg);
  overflow: auto;
  background: var(--bg-container);
  min-height: 0; /* 确保 flex 子元素能正确收缩 */
  
  .diff-text {
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
    white-space: pre-wrap;
    word-break: break-all;
    height: 100%; /* 确保 diff 内容填充满容器 */
    padding: var(--spacing-md);
    background: var(--bg-code);
    border-radius: var(--radius-base);
    border: 1px solid var(--border-color-light);
  }
}

/* 滚动条样式 - 使用全局变量 */
:deep(.el-scrollbar__view) {
  height: 100%;
}

:deep(.el-scrollbar__bar) {
  .el-scrollbar__thumb {
    background-color: var(--scrollbar-thumb);
    
    &:hover {
      background-color: var(--scrollbar-thumb-hover);
    }
  }
}

/* diff样式 - 移除重复样式，使用全局变量 */
.diff-text {
  /* 全局diff样式已在common.scss中定义，这里只需要组件特定的样式 */
  border-radius: var(--radius-base);
  background: var(--bg-code);
  border: 1px solid var(--border-color-light);
  
  /* 确保全局样式正确应用 */
  :deep(.diff-header),
  :deep(.diff-old-file),
  :deep(.diff-new-file),
  :deep(.diff-hunk-header),
  :deep(.diff-added),
  :deep(.diff-removed),
  :deep(.diff-context) {
    /* 样式已在全局variables.scss和common.scss中统一定义 */
  }
}
</style>

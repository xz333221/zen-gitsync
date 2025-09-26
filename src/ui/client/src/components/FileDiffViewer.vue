<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { ElEmpty, ElScrollbar, ElTooltip, ElIcon, ElButton, ElMessage } from 'element-plus';
import { Document, FolderOpened, Lock } from '@element-plus/icons-vue';
import { formatDiff } from '../utils/index.ts';
import vscodeIcon from '@/assets/images/vscode.webp';

// 定义props
interface FileItem {
  path: string;
  name?: string; // 用于显示的文件名，如果没有则使用path
  type?: string; // 文件类型，可选
  locked?: boolean; // 是否被锁定
}

// 定义上下文类型
type ContextType = 'git-status' | 'commit-detail' | 'stash-detail';

interface Props {
  files: FileItem[]; // 文件列表
  emptyText?: string; // 无文件时的提示文本
  diffContent?: string; // 当前差异内容
  selectedFile?: string; // 当前选中的文件路径
  height?: string; // 组件高度
  showFileList?: boolean; // 是否显示文件列表，默认true
  context?: ContextType; // 使用上下文，用于确定打开文件的行为
  showOpenButton?: boolean; // 是否显示打开文件按钮，默认true
}

const props = withDefaults(defineProps<Props>(), {
  emptyText: '没有找到变更文件',
  diffContent: '',
  selectedFile: '',
  height: '100%',
  showFileList: true,
  context: 'git-status',
  showOpenButton: true
});

// 定义事件
interface Emits {
  (e: 'file-select', filePath: string): void; // 选择文件时触发
  (e: 'open-file', filePath: string, context: ContextType): void; // 打开文件时触发
  (e: 'open-with-vscode', filePath: string, context: ContextType): void; // 用VSCode打开文件时触发
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

// 选中文件路径拆分（目录/文件名），用于头部展示
const selectedFileDir = computed(() => {
  if (!currentSelectedFile.value) return '';
  const parts = currentSelectedFile.value.split('/');
  return parts.slice(0, -1).join('/') + (parts.length > 1 ? '/' : '');
});

const selectedFileName = computed(() => {
  if (!currentSelectedFile.value) return '';
  const parts = currentSelectedFile.value.split('/');
  return parts[parts.length - 1] || currentSelectedFile.value;
});

// 方法
function handleFileSelect(filePath: string) {
  internalSelectedFile.value = filePath;
  emit('file-select', filePath);
}

// 打开文件方法
function handleOpenFile() {
  if (!currentSelectedFile.value) {
    ElMessage.warning('请先选择一个文件');
    return;
  }
  
  emit('open-file', currentSelectedFile.value, props.context);
}

// 用VSCode打开文件方法
function handleOpenWithVSCode() {
  if (!currentSelectedFile.value) {
    ElMessage.warning('请先选择一个文件');
    return;
  }
  
  emit('open-with-vscode', currentSelectedFile.value, props.context);
}

// 计算打开按钮的提示文本
const openButtonTooltip = computed(() => {
  switch (props.context) {
    case 'git-status':
      return '在系统默认编辑器中打开文件';
    case 'commit-detail':
      return '打开该提交时的文件版本';
    case 'stash-detail':
      return '打开该stash中的文件版本';
    default:
      return '打开文件';
  }
});

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
              [`file-type-${file.type}`]: file.type,
              'is-locked': file.locked
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
            <el-tooltip
              v-if="file.locked"
              content="该文件已被锁定，提交时会被跳过"
              placement="top"
              :hide-after="1000"
              :show-after="200"
            >
              <el-icon class="lock-icon" color="#E6A23C">
                <Lock />
              </el-icon>
            </el-tooltip>
          </div>
        </el-scrollbar>
      </div>
    </div>

    <!-- 差异显示面板 -->
    <div class="diff-panel" :class="{ 'full-width': !showFileList }">
      <div class="panel-header">
        <h4>文件差异</h4>
        <div class="header-right">
          <el-tooltip
            v-if="currentSelectedFile"
            :content="currentSelectedFile"
            placement="top"
            effect="light"
            :hide-after="1000"
            :show-after="200"
          >
            <span class="selected-file">
              <span class="path-dir">{{ selectedFileDir }}</span><span class="path-name">{{ selectedFileName }}</span>
            </span>
          </el-tooltip>
          <div v-if="showOpenButton && currentSelectedFile" class="action-buttons">
            <el-tooltip
              :content="openButtonTooltip"
              placement="top"
              effect="light"
            >
              <el-button
                type="primary"
                size="small"
                :icon="FolderOpened"
                @click="handleOpenFile"
                class="open-file-btn"
              >
              </el-button>
            </el-tooltip>
            <el-tooltip
              content="用VSCode打开文件"
              placement="top"
              effect="light"
            >
              <el-button
                type="success"
                size="small"
                @click="handleOpenWithVSCode"
                class="vscode-btn"
              >
                <img :src="vscodeIcon" alt="VSCode" class="vscode-icon" />
              </el-button>
            </el-tooltip>
          </div>
        </div>
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
  background: #fafbfc;
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

  &.is-locked {
    .lock-icon {
      opacity: 1;
    }
  }
}

.panel-header {
  padding: var(--spacing-md) var(--spacing-lg);
  background: #ffffff;
  color: #303133;
  border-bottom: 1px solid #e4e7ed;
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  
  h4 {
    margin: 0;
    font-size: var(--font-size-md);
    font-weight: var(--font-weight-semibold);
    color: #303133;
  }
}

.header-right {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.action-buttons {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
}

.open-file-btn {
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  padding: var(--spacing-xs) var(--spacing-sm);
  transition: all 0.3s ease;
  
  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 2px 8px rgba(64, 158, 255, 0.3);
  }
}

.vscode-btn {
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  padding: var(--spacing-xs) var(--spacing-sm);
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  gap: 4px;
  
  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 2px 8px rgba(103, 194, 58, 0.3);
  }
}

.vscode-icon {
  width: 16px;
  height: 16px;
  object-fit: contain;
}

.file-count {
  font-size: var(--font-size-xs);
  color: #606266;
  font-weight: var(--font-weight-medium);
  background: #f5f7fa;
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: var(--radius-full);
  border: 1px solid #e4e7ed;
}

.selected-file {
  font-size: var(--font-size-sm);
  color: #606266;
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: #f0f2f5;
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: var(--radius-sm);
  border: 1px solid #d9d9d9;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-family: var(--font-mono);
}

.path-dir {
  color: #909399;
}

.path-name {
  color: #303133;
  font-weight: var(--font-weight-semibold);
}

.files-list {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: #ffffff;
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
    background: #f5f7fa;
    transform: translateX(2px);
    
    &::before {
      background: #409eff;
    }
  }
  
  &.active {
    background: #e6f7ff;
    color: #1890ff;
    border-left: 3px solid #1890ff;
    
    &::before {
      background: #1890ff;
      width: 4px;
    }
    
    .file-icon {
      color: #1890ff;
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
    color: #1890ff;
    font-weight: var(--font-weight-semibold);
  }
}

.lock-icon {
  margin-left: 8px;
  flex-shrink: 0;
  opacity: 0.9;
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
  
  /* 全局diff样式已在common.scss中定义 */
}
</style>

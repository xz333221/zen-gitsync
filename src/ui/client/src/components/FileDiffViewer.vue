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
  height: '400px',
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
.file-diff-viewer {
  display: flex;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  overflow: hidden;
  background-color: #fff;
  height: 100%; // 确保填充满父容器
}

.files-panel {
  width: 300px;
  min-width: 250px;
  background-color: #fafafa;
  border-right: 1px solid #e4e7ed;
  display: flex;
  flex-direction: column;
}

.diff-panel {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  
  &.full-width {
    width: 100%;
  }
}

.panel-header {
  padding: 12px 16px;
  background-color: #f5f7fa;
  border-bottom: 1px solid #e4e7ed;
  display: flex;
  justify-content: space-between;
  align-items: center;
  
  h4 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: #303133;
  }
}

.file-count {
  font-size: 12px;
  color: #909399;
  font-weight: normal;
}

.selected-file {
  font-size: 12px;
  color: #909399;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.files-list {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}



.file-item {
  display: flex;
  align-items: center;
  padding: 8px 16px;
  cursor: pointer;
  transition: all 0.2s ease;
  border-bottom: 1px solid #f0f0f0;
  
  &:hover {
    background-color: #e6f7ff;
  }
  
  &.active {
    background-color: #409eff;
    color: white;
    
    .file-icon {
      color: white;
    }
  }
  
  // 根据文件类型添加不同样式
  &.file-type-added {
    border-left: 3px solid #67c23a;
  }
  
  &.file-type-modified {
    border-left: 3px solid #e6a23c;
  }
  
  &.file-type-deleted {
    border-left: 3px solid #f56c6c;
  }
  
  &.file-type-untracked {
    border-left: 3px solid #909399;
  }
}

.file-icon {
  margin-right: 8px;
  color: #606266;
  font-size: 16px;
  flex-shrink: 0;
}

.file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.diff-content {
  flex: 1;
  padding: 16px;
  overflow: auto;
  background-color: #fff;
  min-height: 0; // 确保flex子元素能正确收缩
  
  .diff-text {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Monaco, Inconsolata, "Roboto Mono", "Droid Sans Mono", Consolas, "Courier New", monospace;
    font-size: 12px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-all;
    height: 100%; // 确保diff内容填充满容器
  }
  

}

// 滚动条样式
:deep(.el-scrollbar__view) {
  height: 100%;
}

// diff样式继承自全局样式
.diff-text {
  // 确保全局diff样式优先级高于组件局部样式
  :deep(.diff-header) {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Monaco, Inconsolata, "Roboto Mono", "Droid Sans Mono", Consolas, "Courier New", monospace !important;
    font-size: 12px !important;
    line-height: 1.45 !important;
    background-color: #f1f8ff !important;
    color: #0366d6 !important;
    border: 1px solid #c8e1ff !important;
    border-left: 4px solid #0366d6 !important;
    font-weight: 600 !important;
    padding: 8px 12px !important;
    margin: 8px 0 !important;
    border-radius: 6px !important;
    box-shadow: 0 1px 3px rgba(3, 102, 214, 0.1) !important;
  }
  
  :deep(.diff-old-file),
  :deep(.diff-new-file) {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Monaco, Inconsolata, "Roboto Mono", "Droid Sans Mono", Consolas, "Courier New", monospace !important;
    font-size: 12px !important;
    line-height: 1.45 !important;
    padding: 5px 8px !important;
    margin: 1px 0 !important;
    border-radius: 3px !important;
    display: block !important;
    font-weight: 600 !important;
  }
  
  :deep(.diff-old-file) {
    color: #cb2431 !important;
    background-color: #ffeef0 !important;
    border-left: 4px solid #cb2431 !important;
  }
  
  :deep(.diff-new-file) {
    color: #22863a !important;
    background-color: #e6ffed !important;
    border-left: 4px solid #22863a !important;
  }
  
  :deep(.diff-hunk-header),
  :deep(.diff-added),
  :deep(.diff-removed),
  :deep(.diff-context) {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Monaco, Inconsolata, "Roboto Mono", "Droid Sans Mono", Consolas, "Courier New", monospace !important;
    font-size: 12px !important;
    line-height: 1.45 !important;
  }
}
</style>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { ElEmpty, ElScrollbar, ElTooltip, ElIcon, ElMessage, ElSplitter, ElInput } from 'element-plus';
import { FolderOpened, Lock, DocumentCopy, Search } from '@element-plus/icons-vue';
import { formatDiff } from '../utils/index.ts';
import vscodeIcon from '@/assets/images/vscode.webp';
import FileActionButtons from './FileActionButtons.vue';
import { getFileIconClass } from '../utils/fileIcon';

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
  showActionButtons?: boolean; // 是否显示操作按钮（锁定/暂存/撤回），默认false
  isFileLocked?: (filePath: string) => boolean; // 判断文件是否锁定
  isLocking?: (filePath: string) => boolean; // 判断文件是否正在锁定中
}

const props = withDefaults(defineProps<Props>(), {
  emptyText: '没有找到变更文件',
  diffContent: '',
  selectedFile: '',
  height: '100%',
  showFileList: true,
  context: 'git-status',
  showOpenButton: true,
  showActionButtons: false,
  isFileLocked: () => false,
  isLocking: () => false
});

// 定义事件
interface Emits {
  (e: 'file-select', filePath: string): void; // 选择文件时触发
  (e: 'open-file', filePath: string, context: ContextType): void; // 打开文件时触发
  (e: 'open-with-vscode', filePath: string, context: ContextType): void; // 用VSCode打开文件时触发
  (e: 'toggle-lock', filePath: string): void; // 切换文件锁定状态
  (e: 'stage', filePath: string): void; // 暂存文件
  (e: 'unstage', filePath: string): void; // 取消暂存
  (e: 'revert', filePath: string): void; // 撤回修改
}

const emit = defineEmits<Emits>();

// 内部状态
const internalSelectedFile = ref<string>('');
const searchQuery = ref<string>(''); // 搜索关键词
// 分割比例（百分比），持久化到 localStorage
// 采用与项目一致的命名风格，便于在应用存储中查看
const LEGACY_SPLIT_KEY = 'fileDiff.splitPercent';
const SPLIT_KEY = 'zen-gitsync-filediff-ratio';
const savedSplit = localStorage.getItem(SPLIT_KEY) ?? localStorage.getItem(LEGACY_SPLIT_KEY);
const initialSplit = (() => {
  const v = savedSplit ? parseFloat(savedSplit) : 35;
  return isNaN(v) ? 35 : Math.min(85, Math.max(15, v));
})();
const splitPercent = ref<number>(initialSplit);

// 计算属性
const currentSelectedFile = computed(() => {
  return props.selectedFile || internalSelectedFile.value;
});

const displayFiles = computed(() => {
  return props.files.map(file => {
    const displayName = file.name || file.path.split('/').pop() || file.path;
    return {
      ...file,
      displayName,
      // 目录路径徽标显示，仿 Git 状态列表
      dirPath: (() => {
        const parts = (file.path || '').split('/');
        return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
      })(),
      // 文件图标类名
      iconClass: getFileIconClass(displayName)
    };
  });
});

const filteredFiles = computed(() => {
  if (!searchQuery.value.trim()) {
    return displayFiles.value;
  }
  
  const query = searchQuery.value.toLowerCase().trim();
  return displayFiles.value.filter(file => {
    // 搜索文件名或完整路径
    return file.displayName.toLowerCase().includes(query) || 
           file.path.toLowerCase().includes(query);
  });
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

// 复制文件路径方法
function handleCopyPath() {
  if (!currentSelectedFile.value) {
    ElMessage.warning('请先选择一个文件');
    return;
  }
  
  // 复制到剪贴板
  navigator.clipboard.writeText(currentSelectedFile.value)
    .then(() => {
      ElMessage.success('文件路径已复制到剪贴板');
    })
    .catch(() => {
      ElMessage.error('复制失败');
    });
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

// 工具：范围约束 & 持久化
const clampPercent = (v: number) => Math.min(85, Math.max(15, v));
const persistSplit = (v: number) => {
  try {
    const val = String(clampPercent(v));
    localStorage.setItem(SPLIT_KEY, val);
    // 兼容写入旧键，确保历史逻辑可读取
    localStorage.setItem(LEGACY_SPLIT_KEY, val);
  } catch {}
};

// 持久化分割比例（响应 v-model 变化）
watch(splitPercent, (v) => {
  persistSplit(v);
});

// 确保每次挂载时都应用已保存的比例（对话框 destroy-on-close 时尤为重要）
onMounted(() => {
  try {
    const saved = localStorage.getItem(SPLIT_KEY) ?? localStorage.getItem(LEGACY_SPLIT_KEY);
    if (saved != null) {
      const v = parseFloat(saved);
      if (!isNaN(v)) {
        splitPercent.value = clampPercent(v);
      }
    }
  } catch {}
});
  
  // Splitter 根元素引用，用于将 px 尺寸转换为百分比
  const splitterRef = ref<any>(null);
  const getSplitterWidth = () => {
    const el = splitterRef.value?.$el ?? splitterRef.value;
    if (el && el.clientWidth) return el.clientWidth as number;
    try {
      return el?.getBoundingClientRect?.().width ?? 0;
    } catch {
      return 0;
    }
  };

  // 从实际DOM计算左面板百分比（用于某些版本返回px或未触发v-model的情况）
  const updateSplitFromDom = () => {
    const root = splitterRef.value?.$el ?? splitterRef.value;
    if (!root) return;
    const panels = root.querySelectorAll?.('.el-splitter__panel');
    const width = getSplitterWidth();
    if (!panels || panels.length < 1 || width <= 0) return;
    const leftPx = (panels[0] as HTMLElement)?.getBoundingClientRect?.().width ?? 0;
    if (leftPx > 0) {
      const percent = clampPercent((leftPx / width) * 100);
      if (percent !== splitPercent.value) {
        splitPercent.value = percent;
        persistSplit(percent);
      }
    }
  };
  // 面板尺寸（百分比字符串）用于与 SplitterPanel 的 v-model:size 对接
  const panelSize = computed<string>({
    get() {
      return `${clampPercent(splitPercent.value)}%`;
    },
    set(val: string | number) {
      // 兼容百分比、像素与数值："35%" / "420px" / 420
      let percent = NaN;
      if (typeof val === 'number') {
        const px = val;
        const width = getSplitterWidth();
        if (width > 0 && !isNaN(px)) {
          percent = (px / width) * 100;
        }
      } else if (typeof val === 'string') {
        if (val.endsWith('%')) {
          percent = parseFloat(val);
        } else if (val.endsWith('px')) {
          const px = parseFloat(val);
          const width = getSplitterWidth();
          if (width > 0 && !isNaN(px)) {
            percent = (px / width) * 100;
          }
        }
      }
      if (!isNaN(percent)) {
        splitPercent.value = clampPercent(percent);
        persistSplit(splitPercent.value);
      }
    }
  });
</script>

<template>
  <div class="file-diff-viewer" :style="{ height }">
    <!-- 使用 Splitter 控制左右面板比例 -->
    <el-splitter
      v-if="showFileList"
      ref="splitterRef"
      layout="horizontal"
      style="height: 100%"
      @resize="updateSplitFromDom"
      @resize-end="updateSplitFromDom"
    >
      <el-splitter-panel v-model:size="panelSize" :min="'15%'" :max="'85%'">
        <!-- 左侧：文件列表面板 -->
        <div class="files-panel">
          <div class="panel-header">
            <h4>变更文件</h4>
            <span v-if="files.length > 0" class="file-count">({{ files.length }})</span>
          </div>
          <!-- 搜索框 -->
          <div class="search-box">
            <el-input
              v-model="searchQuery"
              placeholder="搜索文件名或路径..."
              :prefix-icon="Search"
              clearable
              size="small"
            />
          </div>
          <div class="files-list">
            <el-scrollbar height="100%">
              <el-empty 
                v-if="files.length === 0"
                :description="emptyText"
                :image-size="60"
              />
              <el-empty 
                v-else-if="filteredFiles.length === 0"
                description="没有找到匹配的文件"
                :image-size="60"
              />
              <div
                v-for="file in filteredFiles"
                :key="file.path"
                class="file-item"
                :class="{ 
                  'active': file.path === currentSelectedFile,
                  [`file-type-${file.type}`]: file.type,
                  'is-locked': file.locked
                }"
                @click="handleFileSelect(file.path)"
              >
                <span :class="['file-icon', file.iconClass]"></span>
                <el-tooltip
                  :content="file.path"
                  placement="top"
                  :disabled="file.displayName.length <= 35"
                  
                  :show-after="200"
                >
                  <span class="file-name">{{ file.displayName }}</span>
                </el-tooltip>
                <div v-if="file.dirPath" class="file-path-section" :title="file.dirPath">
                  <el-tooltip
                    :content="file.dirPath"
                    placement="top"
                    :disabled="file.dirPath.length <= 30"
                    
                    :show-after="200"
                  >
                    <span class="file-directory path-badge">{{ file.dirPath }}</span>
                  </el-tooltip>
                </div>
                <el-tooltip
                  v-if="file.locked"
                  content="该文件已被锁定，提交时会被跳过"
                  placement="top"
                  
                  :show-after="200"
                >
                  <el-icon class="lock-icon" color="#E6A23C">
                    <Lock />
                  </el-icon>
                </el-tooltip>
                <!-- 文件操作按钮（悬浮在右侧，不占布局空间） -->
                <div v-if="showActionButtons" class="file-actions">
                  <FileActionButtons
                    :file-path="file.path"
                    :file-type="file.type || 'modified'"
                    :is-locked="isFileLocked(file.path)"
                    :is-locking="isLocking(file.path)"
                    @toggle-lock="(path) => emit('toggle-lock', path)"
                    @stage="(path) => emit('stage', path)"
                    @unstage="(path) => emit('unstage', path)"
                    @revert="(path) => emit('revert', path)"
                  />
                </div>
              </div>
            </el-scrollbar>
          </div>
        </div>
      </el-splitter-panel>
      <el-splitter-panel :min="'15%'" :max="'85%'">
        <!-- 右侧：差异显示面板 -->
        <div class="diff-panel">
          <div class="panel-header">
            <h4>文件差异</h4>
            <div class="header-right">
              <el-tooltip
                v-if="currentSelectedFile"
                :content="currentSelectedFile"
                placement="top"
                effect="light"
                
                :show-after="200"
              >
                <span class="selected-file">
                  <span class="path-dir">{{ selectedFileDir }}</span><span class="path-name">{{ selectedFileName }}</span>
                </span>
              </el-tooltip>
              <div v-if="showOpenButton && currentSelectedFile" class="action-buttons">
                <el-tooltip content="复制文件路径" placement="top" effect="light">
                  <button class="modern-btn btn-icon-24" @click="handleCopyPath">
                    <el-icon class="btn-icon"><DocumentCopy /></el-icon>
                  </button>
                </el-tooltip>
                <el-tooltip :content="openButtonTooltip" placement="top" effect="light">
                  <button class="modern-btn btn-icon-24" @click="handleOpenFile">
                    <el-icon class="btn-icon"><FolderOpened /></el-icon>
                  </button>
                </el-tooltip>
                <el-tooltip content="用VSCode打开文件" placement="top" effect="light">
                  <button class="modern-btn btn-icon-24" @click="handleOpenWithVSCode">
                    <img :src="vscodeIcon" alt="VSCode" class="btn-icon vscode-icon" />
                  </button>
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
            <div v-else class="diff-text" v-html="formatDiff(diffContent)" />
          </div>
        </div>
      </el-splitter-panel>
    </el-splitter>

    <!-- 当隐藏文件列表时，仅显示右侧面板 -->
    <div v-else class="diff-panel full-width">
      <div class="panel-header">
        <h4>文件差异</h4>
        <div class="header-right">
          <el-tooltip
            v-if="currentSelectedFile"
            :content="currentSelectedFile"
            placement="top"
            effect="light"
            
            :show-after="200"
          >
            <span class="selected-file">
              <span class="path-dir">{{ selectedFileDir }}</span><span class="path-name">{{ selectedFileName }}</span>
            </span>
          </el-tooltip>
          <div v-if="showOpenButton && currentSelectedFile" class="action-buttons">
            <el-tooltip
              content="复制文件路径"
              placement="top"
              effect="light"
            >
              <button 
                class="modern-btn btn-icon-24"
                @click="handleCopyPath"
              >
                <el-icon class="btn-icon"><DocumentCopy /></el-icon>
              </button>
            </el-tooltip>
            
            <el-tooltip
              :content="openButtonTooltip"
              placement="top"
              effect="light"
            >
              <button
                class="modern-btn btn-icon-24 btn-primary"
                @click="handleOpenFile"
              >
                <el-icon class="btn-icon"><FolderOpened /></el-icon>
              </button>
            </el-tooltip>
            <el-tooltip
              content="用VSCode打开文件"
              placement="top"
              effect="light"
            >
              <button
                class="modern-btn btn-icon-24 btn-success"
                @click="handleOpenWithVSCode"
              >
                <img :src="vscodeIcon" alt="VSCode" class="btn-icon vscode-icon" />
              </button>
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

/* Splitter 容器与面板的基础约束，避免面板被内容强行撑开导致拖拽异常 */
:deep(.el-splitter) {
  width: 100%;
  height: 100%;
}

:deep(.el-splitter__panel) {
  flex: 0 0 auto; /* 面板尺寸由 splitter 控制 */
  overflow: hidden;
}

/* 左侧面板最小宽度，右侧面板最小宽度，防止拖动瞬间跳边 */
:deep(.el-splitter__panel:first-child) {
  min-width: 250px;
}

:deep(.el-splitter__panel:last-child) {
  min-width: 360px;
}

.files-panel {
  width: 100%; /* 让宽度由 el-splitter 控制 */
  min-width: 250px;
  background: var(--bg-icon);
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
  background: var(--bg-container);
  
  border-bottom: 1px solid var(--border-card);
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  
  h4 {
    margin: 0;
    font-size: var(--font-size-md);
    font-weight: var(--font-weight-semibold);
    
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
  
  .vscode-icon {
    width: 16px;
    height: 16px;
    object-fit: contain;
  }
}

.file-count {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  font-weight: var(--font-weight-medium);
  background: var(--bg-panel);
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: var(--radius-full);
  border: 1px solid var(--border-card);
}

.search-box {
  padding: var(--spacing-sm) 0;
  background: var(--bg-container);
  border-bottom: 1px solid var(--border-color-light);
  
  :deep(.el-input) {
    .el-input__wrapper {
      background: var(--bg-input);
      border: 1px solid var(--border-input);
      border-radius: var(--radius-sm);
      transition: var(--transition-all);
      
      &:hover {
        background: var(--bg-input-hover);
        border-color: #409eff;
      }
      
      &.is-focus {
        background: var(--bg-input);
        border-color: #409eff;
        box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.1);
      }
    }
    
    .el-input__inner {
      color: var(--text-primary);
      
      &::placeholder {
        color: var(--text-tertiary);
      }
    }
    
    .el-input__prefix {
      color: var(--text-secondary);
    }
    
    .el-input__suffix {
      .el-input__clear {
        color: var(--text-secondary);
        
        &:hover {
          color: #409eff;
        }
      }
    }
  }
}

.selected-file {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: var(--bg-icon);
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
  
  font-weight: var(--font-weight-semibold);
}

.files-list {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-container);
}



.file-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
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
    background: var(--bg-panel);
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
  flex-shrink: 0;
  font-size: 16px;
  line-height: 1;
  display: inline-block;
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
  min-width: 40px;
  
  .active & {
    color: #1890ff;
    font-weight: var(--font-weight-semibold);
  }
}

.path-badge {
  display: inline-block;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  background: var(--bg-file-path);
  padding: 1px var(--spacing-sm);
  border-radius: var(--radius-sm);
  margin-left: var(--spacing-sm);
}

.file-item:hover .path-badge {
  background: var(--bg-file-path-hover);
  color: var(--color-file-path-hover);
}

.lock-icon {
  margin-left: 8px;
  flex-shrink: 0;
  opacity: 0.9;
}

/* 右侧悬浮操作区（与 Git 状态列表一致的交互） */
.file-actions {
  position: absolute;
  right: 12px; /* 预留分隔条拖拽区域，避免遮挡 */
  top: 50%;
  transform: translateY(-50%);
  display: none;
  align-items: center;
  gap: var(--spacing-xs);
  padding: 1px;
  border-radius: var(--radius-base);
  background: var(--bg-container);
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--border-color-light);
}

.file-item:hover .file-actions {
  display: flex;
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

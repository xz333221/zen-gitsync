<script setup lang="ts">
import { $t } from '@/lang/static.ts'
import { ref, computed, watch, onMounted } from 'vue';
import { ElEmpty, ElScrollbar, ElTooltip, ElIcon, ElMessage, ElSplitter, ElInput, ElButton } from 'element-plus';
import { FolderOpened, DocumentCopy, Search, Warning, CircleCheck } from '@element-plus/icons-vue';
import TreeIcon from '@/components/icons/TreeIcon.vue';
import ListIcon from '@/components/icons/ListIcon.vue';
import IconButton from '@/components/IconButton.vue';
import SvgIcon from '@/components/SvgIcon/index.vue';
import { formatDiff } from '../utils/index.ts';
import FileActionButtons from './FileActionButtons.vue';
import FileTreeView from './FileTreeView.vue';
import { getFileIconClass } from '../utils/fileIcon';
import { buildFileTree, mergeTreeExpandState, type TreeNode } from '@/utils/fileTree';
import ConflictBlockViewer, { type ConflictBlock } from './ConflictBlockViewer.vue';
import MonacoDiffViewer from '@/components/MonacoDiffViewer.vue'

// 定义props
interface FileItem {
  path: string;
  name?: string; // 用于显示的文件名，如果没有则使用path
  type?: string; // 文件类型，可选
  locked?: boolean; // 是否被锁定
}

// 定义上下文类型
type ContextType = 'git-status' | 'commit-detail' | 'stash-detail';

interface DiffStats {
  added: number;
  deleted: number;
}

interface Props {
  files: FileItem[]; // 文件列表
  emptyText?: string; // 无文件时的提示文本
  diffContent?: string; // 当前差异内容
  diffStats?: DiffStats | null; // diff统计信息
  selectedFile?: string; // 当前选中的文件路径
  isLoading?: boolean; // 是否正在加载diff
  plainText?: boolean;
  compareMode?: boolean;
  compareOriginal?: string;
  compareModified?: string;
  height?: string; // 组件高度
  showFileList?: boolean; // 是否显示文件列表，默认true
  context?: ContextType; // 使用上下文，用于确定打开文件的行为
  showOpenButton?: boolean; // 是否显示打开文件按钮，默认true
  showActionButtons?: boolean; // 是否显示操作按钮（锁定/暂存/撤回），默认false
  isFileLocked?: (filePath: string) => boolean; // 判断文件是否锁定
  isLocking?: (filePath: string) => boolean; // 判断文件是否正在锁定中
}

const props = withDefaults(defineProps<Props>(), {
  emptyText: $t('@E80AC:没有找到变更文件'),
  diffContent: '',
  diffStats: null,
  selectedFile: '',
  isLoading: false,
  plainText: false,
  compareMode: false,
  compareOriginal: '',
  compareModified: '',
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
// 视图模式：列表或树状（从 localStorage 读取，与 GitStatus 同步）
const FILE_LIST_VIEW_MODE_KEY = 'zen-gitsync-file-list-view-mode';
const savedViewMode = localStorage.getItem(FILE_LIST_VIEW_MODE_KEY) as 'list' | 'tree' | null;
const viewMode = ref<'list' | 'tree'>(savedViewMode || 'list');
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

// 检测当前文件是否为冲突文件
const isConflictedFile = computed(() => {
  if (!currentSelectedFile.value) return false;
  const currentFile = props.files.find(f => f.path === currentSelectedFile.value);
  // 只根据文件类型判断，不检查 diff 内容
  // 因为 diff 内容中可能包含对冲突标记的修改（如修改 index.ts 中的冲突解析代码）
  return currentFile?.type === 'conflicted';
});

// 检测文件内容是否真的包含冲突标记（用于判断用户是否已手动解决）
const hasActualConflictMarkers = computed(() => {
  // 如果没有解析到冲突块，说明文件内容中已经没有冲突标记了
  return conflictBlocks.value.length > 0;
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

// 树状数据（使用ref保持展开状态）
const treeData = ref<TreeNode[]>([]);

// 更新树状视图数据
function updateTreeData() {
  const newTree = buildFileTree(filteredFiles.value);
  if (treeData.value.length > 0) {
    mergeTreeExpandState(newTree, treeData.value);
  }
  treeData.value = newTree;
}

// 监听过滤后的文件列表变化，更新树数据
watch(filteredFiles, () => {
  if (viewMode.value === 'tree') {
    updateTreeData();
  }
}, { deep: true });

// 监听视图模式变化，切换到树视图时初始化数据，并保存到 localStorage
watch(viewMode, (newMode) => {
  if (newMode === 'tree') {
    updateTreeData();
  }
  // 保存到 localStorage，与 GitStatus 同步
  localStorage.setItem(FILE_LIST_VIEW_MODE_KEY, newMode);
  
  // 触发自定义事件，通知其他组件视图模式已变化
  window.dispatchEvent(new CustomEvent('file-list-view-mode-change', { 
    detail: { mode: newMode } 
  }));
});

const hasDiffContent = computed(() => {
  if (props.compareMode) {
    return true
  }
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
    ElMessage.warning($t('@E80AC:请先选择一个文件'));
    return;
  }
  
  emit('open-file', currentSelectedFile.value, props.context);
}

// 复制文件路径方法
function handleCopyPath() {
  if (!currentSelectedFile.value) {
    ElMessage.warning($t('@E80AC:请先选择一个文件'));
    return;
  }
  
  // 复制到剪贴板
  navigator.clipboard.writeText(currentSelectedFile.value)
    .then(() => {
      ElMessage.success($t('@E80AC:文件路径已复制到剪贴板'));
    })
    .catch(() => {
      ElMessage.error($t('@E80AC:复制失败'));
    });
}

// 用VSCode打开文件方法
function handleOpenWithVSCode() {
  if (!currentSelectedFile.value) {
    ElMessage.warning($t('@E80AC:请先选择一个文件'));
    return;
  }
  
  emit('open-with-vscode', currentSelectedFile.value, props.context);
}

// 冲突块相关状态
const conflictBlocks = ref<ConflictBlock[]>([]);
const blockResolutions = ref<Map<number, string>>(new Map()); // blockId -> resolved content
const useBlockMode = ref<boolean>(true); // 是否使用逐块模式

// 解析冲突内容为冲突块
function parseConflictBlocks(content: string): ConflictBlock[] {
  const blocks: ConflictBlock[] = [];
  const lines = content.split('\n');
  let blockId = 0;
  let i = 0;
  
  while (i < lines.length) {
    const line = lines[i];
    
    // 检测冲突开始标记
    if (line.includes('<<<<<<<')) {
      blockId++;
      const currentLabel = line.replace(/^<<<<<<< /, '').trim() || 'HEAD';
      const beforeLines: string[] = [];
      const currentLines: string[] = [];
      const incomingLines: string[] = [];
      const afterLines: string[] = [];
      
      // 收集冲突前的上下文（最多3行）
      const contextStart = Math.max(0, i - 3);
      for (let j = contextStart; j < i; j++) {
        beforeLines.push(lines[j]);
      }
      
      const startLine = i + 1;
      i++; // 跳过 <<<<<<< 行
      
      // 收集当前版本的内容
      while (i < lines.length && !lines[i].includes('=======')) {
        currentLines.push(lines[i]);
        i++;
      }
      
      i++; // 跳过 ======= 行
      
      // 收集传入版本的内容
      let incomingLabel = '';
      while (i < lines.length && !lines[i].includes('>>>>>>>')) {
        incomingLines.push(lines[i]);
        i++;
      }
      
      // 提取传入版本标签
      if (i < lines.length && lines[i].includes('>>>>>>>')) {
        incomingLabel = lines[i].replace(/^>>>>>>> /, '').trim() || 'incoming';
        i++; // 跳过 >>>>>>> 行
      }
      
      // 收集冲突后的上下文（最多3行）
      const contextEnd = Math.min(lines.length, i + 3);
      for (let j = i; j < contextEnd && j < lines.length; j++) {
        afterLines.push(lines[j]);
      }
      
      blocks.push({
        id: blockId,
        startLine,
        currentLines,
        incomingLines,
        beforeLines,
        afterLines,
        currentLabel,
        incomingLabel
      });
    } else {
      i++;
    }
  }
  
  return blocks;
}

// 解析冲突内容，提取当前版本和传入版本（保留用于全局解决）
function parseConflict(content: string): Array<{
  type: 'common' | 'current' | 'incoming' | 'separator';
  lines: string[];
}> {
  const result: Array<{ type: 'common' | 'current' | 'incoming' | 'separator'; lines: string[] }> = [];
  const lines = content.split('\n');
  let currentSection: 'common' | 'current' | 'incoming' = 'common';
  let currentLines: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.includes('<<<<<<<')) {
      // 保存之前的公共部分
      if (currentLines.length > 0) {
        result.push({ type: 'common', lines: [...currentLines] });
        currentLines = [];
      }
      currentSection = 'current';
    } else if (line.includes('=======')) {
      // 保存当前版本
      if (currentLines.length > 0) {
        result.push({ type: 'current', lines: [...currentLines] });
        currentLines = [];
      }
      result.push({ type: 'separator', lines: [line] });
      currentSection = 'incoming';
    } else if (line.includes('>>>>>>>')) {
      // 保存传入版本
      if (currentLines.length > 0) {
        result.push({ type: 'incoming', lines: [...currentLines] });
        currentLines = [];
      }
      currentSection = 'common';
    } else {
      currentLines.push(line);
    }
  }
  
  // 保存最后的部分
  if (currentLines.length > 0) {
    result.push({ type: currentSection, lines: [...currentLines] });
  }
  
  return result;
}

// 解决冲突：接受当前版本
async function resolveConflictAcceptCurrent() {
  if (!currentSelectedFile.value) return;
  
  try {
    // 获取文件内容
    const response = await fetch(`/api/file-content?file=${encodeURIComponent(currentSelectedFile.value)}`);
    const data = await response.json();
    
    if (!data.success || !data.content) {
      ElMessage.error($t('@E80AC:无法读取文件内容'));
      return;
    }
    
    const content = data.content;
    const sections = parseConflict(content);
    let resolvedContent = '';
    
    for (const section of sections) {
      if (section.type === 'current' || section.type === 'common') {
        resolvedContent += section.lines.join('\n') + '\n';
      } else if (section.type === 'separator' || section.type === 'incoming') {
        // 跳过传入版本和分隔符
        continue;
      }
    }
    
    // 保存解决后的内容
    await saveResolvedContent(resolvedContent.trim());
  } catch (error) {
    ElMessage.error(`${$t('@E80AC:解决冲突失败: ')}${(error as Error).message}`);
  }
}

// 解决冲突：接受传入版本
async function resolveConflictAcceptIncoming() {
  if (!currentSelectedFile.value) return;
  
  try {
    const response = await fetch(`/api/file-content?file=${encodeURIComponent(currentSelectedFile.value)}`);
    const data = await response.json();
    
    if (!data.success || !data.content) {
      ElMessage.error($t('@E80AC:无法读取文件内容'));
      return;
    }
    
    const content = data.content;
    const sections = parseConflict(content);
    let resolvedContent = '';
    
    for (const section of sections) {
      if (section.type === 'incoming' || section.type === 'common') {
        resolvedContent += section.lines.join('\n') + '\n';
      } else if (section.type === 'separator' || section.type === 'current') {
        // 跳过当前版本和分隔符
        continue;
      }
    }
    
    await saveResolvedContent(resolvedContent.trim());
  } catch (error) {
    ElMessage.error(`${$t('@E80AC:解决冲突失败: ')}${(error as Error).message}`);
  }
}

// 解决冲突：接受两者
async function resolveConflictAcceptBoth() {
  if (!currentSelectedFile.value) return;
  
  try {
    const response = await fetch(`/api/file-content?file=${encodeURIComponent(currentSelectedFile.value)}`);
    const data = await response.json();
    
    if (!data.success || !data.content) {
      ElMessage.error($t('@E80AC:无法读取文件内容'));
      return;
    }
    
    const content = data.content;
    const sections = parseConflict(content);
    let resolvedContent = '';
    
    for (const section of sections) {
      if (section.type === 'common') {
        resolvedContent += section.lines.join('\n') + '\n';
      } else if (section.type === 'current') {
        resolvedContent += section.lines.join('\n') + '\n';
      } else if (section.type === 'incoming') {
        resolvedContent += section.lines.join('\n') + '\n';
      }
      // 跳过分隔符
    }
    
    await saveResolvedContent(resolvedContent.trim());
  } catch (error) {
    ElMessage.error(`${$t('@E80AC:解决冲突失败: ')}${(error as Error).message}`);
  }
}

// 保存解决后的内容
async function saveResolvedContent(content: string) {
  if (!currentSelectedFile.value) return;
  
  try {
    const response = await fetch('/api/resolve-conflict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filePath: currentSelectedFile.value,
        content: content
      })
    });
    
    const result = await response.json();
    
    if (result.success) {
      ElMessage.success($t('@E80AC:冲突已解决，文件已更新'));
      // 触发刷新 - 通过 window 事件通知其他组件刷新 Git 状态
      window.dispatchEvent(new CustomEvent('git-status-refresh'));
      // 延迟一下，等待 Git 状态更新后再重新获取差异
      setTimeout(() => {
        emit('file-select', currentSelectedFile.value);
      }, 500);
    } else {
      ElMessage.error(result.error || $t('@E80AC:保存失败'));
    }
  } catch (error) {
    ElMessage.error(`${$t('@E80AC:保存失败: ')}${(error as Error).message}`);
  }
}

// 计算打开按钮的提示文本
const openButtonTooltip = computed(() => {
  switch (props.context) {
    case 'git-status':
      return $t('@E80AC:在系统默认编辑器中打开文件');
    case 'commit-detail':
      return $t('@E80AC:打开该提交时的文件版本');
    case 'stash-detail':
      return $t('@E80AC:打开该stash中的文件版本');
    default:
      return $t('@E80AC:打开文件');
  }
});

// 处理逐块冲突解决
async function handleBlockResolve(blockId: number, resolution: 'current' | 'incoming' | 'both') {
  if (!currentSelectedFile.value) return;
  
  try {
    // 获取文件内容
    const response = await fetch(`/api/file-content?file=${encodeURIComponent(currentSelectedFile.value)}`);
    const data = await response.json();
    
    if (!data.success || !data.content) {
      ElMessage.error($t('@E80AC:无法读取文件内容'));
      return;
    }
    
    const block = conflictBlocks.value.find(b => b.id === blockId);
    if (!block) return;
    
    // 根据解决方式生成该块的内容
    let resolvedBlockContent = '';
    if (resolution === 'current') {
      resolvedBlockContent = block.currentLines.join('\n');
    } else if (resolution === 'incoming') {
      resolvedBlockContent = block.incomingLines.join('\n');
    } else if (resolution === 'both') {
      resolvedBlockContent = [...block.currentLines, ...block.incomingLines].join('\n');
    }
    
    // 保存该块的解决方案
    blockResolutions.value.set(blockId, resolvedBlockContent);
  } catch (error) {
    ElMessage.error(`${$t('@E80AC:操作失败: ')}${(error as Error).message}`);
  }
}

// 保存所有块的解决方案
async function saveAllBlockResolutions() {
  if (!currentSelectedFile.value) return;
  
  // 检查是否所有块都已解决
  const allResolved = conflictBlocks.value.every(block => blockResolutions.value.has(block.id));
  if (!allResolved) {
    ElMessage.warning($t('@E80AC:请先解决所有冲突块'));
    return;
  }
  
  try {
    // 获取原始文件内容
    const response = await fetch(`/api/file-content?file=${encodeURIComponent(currentSelectedFile.value)}`);
    const data = await response.json();
    
    if (!data.success || !data.content) {
      ElMessage.error($t('@E80AC:无法读取文件内容'));
      return;
    }
    
    const originalContent = data.content;
    const lines = originalContent.split('\n');
    let result: string[] = [];
    let i = 0;
    let processedBlockId = 0;
    
    while (i < lines.length) {
      const line = lines[i];
      
      if (line.includes('<<<<<<<')) {
        processedBlockId++;
        const resolvedContent = blockResolutions.value.get(processedBlockId);
        
        if (resolvedContent !== undefined) {
          // 添加解决后的内容
          result.push(resolvedContent);
          
          // 跳过整个冲突块
          i++;
          while (i < lines.length && !lines[i].includes('>>>>>>>')) {
            i++;
          }
          i++; // 跳过 >>>>>>> 行
        }
      } else {
        result.push(line);
        i++;
      }
    }
    
    const resolvedContent = result.join('\n');
    
    // 保存解决后的内容
    await saveResolvedContent(resolvedContent);
    
    // 清空块解决方案
    blockResolutions.value.clear();
  } catch (error) {
    ElMessage.error(`${$t('@E80AC:保存失败: ')}${(error as Error).message}`);
  }
}

// 监听props.selectedFile变化，同步内部状态
watch(() => props.selectedFile, (newVal) => {
  if (newVal !== undefined) {
    internalSelectedFile.value = newVal;
  }
});

// 监听文件选择和内容变化，解析冲突块
watch([() => props.diffContent, currentSelectedFile, isConflictedFile], async ([_, selectedFile, isConflicted]) => {
  // 清空之前的状态
  conflictBlocks.value = [];
  blockResolutions.value.clear();
  
  // 只有当文件确实是冲突文件时才解析
  if (isConflicted && selectedFile) {
    try {
      console.log('[ConflictParse] Fetching content for conflicted file:', selectedFile);
      // 获取完整文件内容来解析冲突块
      const response = await fetch(`/api/file-content?file=${encodeURIComponent(selectedFile)}`);
      const data = await response.json();
      
      if (data.success && data.content) {
        console.log('[ConflictParse] File content loaded, parsing blocks...');
        const blocks = parseConflictBlocks(data.content);
        console.log('[ConflictParse] Parsed blocks:', blocks.length);
        conflictBlocks.value = blocks;
      } else {
        console.error('[ConflictParse] Failed to load file content:', data.error);
      }
    } catch (error) {
      console.error('[ConflictParse] Error fetching file content:', error);
    }
  } else {
    console.log('[ConflictParse] File is not conflicted or no file selected');
  }
}, { immediate: true });

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
  
  // 如果初始视图模式是树状，初始化树状数据
  if (viewMode.value === 'tree') {
    updateTreeData();
  }
  
  // 监听其他组件的视图模式变化事件，实现同步
  const handleViewModeChange = (e: Event) => {
    const customEvent = e as CustomEvent<{ mode: 'list' | 'tree' }>;
    const newMode = customEvent.detail.mode;
    if (viewMode.value !== newMode) {
      viewMode.value = newMode;
    }
  };
  
  window.addEventListener('file-list-view-mode-change', handleViewModeChange);
  
  // 组件卸载时移除监听
  return () => {
    window.removeEventListener('file-list-view-mode-change', handleViewModeChange);
  };
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
            <div class="header-left">
              <h4>{{ $t('@E80AC:变更文件') }}</h4>
              <span v-if="files.length > 0" class="file-count">({{ files.length }})</span>
            </div>
            <div class="view-mode-toggle">
              <IconButton
                :tooltip="$t('@E80AC:列表视图')"
                size="small"
                :active="viewMode === 'list'"
                @click="viewMode = 'list'"
              >
                <ListIcon style="width: 1em; height: 1em;" />
              </IconButton>
              <IconButton
                :tooltip="$t('@E80AC:树状视图')"
                size="small"
                :active="viewMode === 'tree'"
                @click="viewMode = 'tree'"
              >
                <TreeIcon style="width: 1em; height: 1em;" />
              </IconButton>
            </div>
          </div>
          <!-- 搜索框 -->
          <div class="search-box">
            <el-input
              v-model="searchQuery"
              :placeholder="$t('@E80AC:搜索文件名或路径...')"
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
                :description="$t('@E80AC:没有找到匹配的文件')"
                :image-size="60"
              />
              <!-- 列表视图 -->
              <template v-else-if="viewMode === 'list'">
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
                  <!-- 冲突文件标记 -->
                  <span v-if="file.type === 'conflicted'" class="conflict-marker" title="冲突文件">⚠</span>
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
                      <div class="file-directory path-badge">{{ file.dirPath }}</div>
                    </el-tooltip>
                  </div>
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
              </template>
              <!-- 树状视图 -->
              <FileTreeView
                v-else
                :tree-data="treeData"
                :selected-file="currentSelectedFile"
                :show-action-buttons="showActionButtons"
                :is-file-locked="isFileLocked"
                :is-locking="isLocking"
                @file-select="handleFileSelect"
                @toggle-lock="(path: string) => emit('toggle-lock', path)"
                @stage="(path: string) => emit('stage', path)"
                @unstage="(path: string) => emit('unstage', path)"
                @revert="(path: string) => emit('revert', path)"
              />
            </el-scrollbar>
          </div>
        </div>
      </el-splitter-panel>
      <el-splitter-panel :min="'15%'" :max="'85%'">
        <!-- 右侧：差异显示面板 -->
        <div class="diff-panel">
          <div class="panel-header">
            <h4>{{ $t('@E80AC:文件差异') }}</h4>
            <div class="header-right">
              <slot name="header-extra" />
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
              <!-- Diff统计信息 -->
              <div v-if="diffStats" class="diff-stats-badge">
                <span class="stats-added">+{{ diffStats.added }}</span>
                <span class="stats-deleted">-{{ diffStats.deleted }}</span>
              </div>
              <div v-if="showOpenButton && currentSelectedFile" class="action-buttons">
                <el-tooltip :content="$t('@E80AC:复制文件路径')" placement="top" effect="light">
                  <button class="modern-btn btn-icon-24" @click="handleCopyPath">
                    <el-icon class="btn-icon"><DocumentCopy /></el-icon>
                  </button>
                </el-tooltip>
                <el-tooltip :content="openButtonTooltip" placement="top" effect="light">
                  <button class="modern-btn btn-icon-24" @click="handleOpenFile">
                    <el-icon class="btn-icon"><FolderOpened /></el-icon>
                  </button>
                </el-tooltip>
                <el-tooltip :content="$t('@E80AC:用VSCode打开文件')" placement="top" effect="light">
                  <button class="modern-btn btn-icon-24" @click="handleOpenWithVSCode">
                    <svg-icon icon-class="vscode" class="btn-icon" />
                  </button>
                </el-tooltip>
              </div>
            </div>
          </div>
          <!-- 冲突解决区域 -->
          <div v-if="isConflictedFile && hasActualConflictMarkers" class="conflict-resolution-container">
            <!-- 模式切换按钮 -->
            <div v-if="conflictBlocks.length > 0" class="resolution-mode-switch">
              <el-button
                :type="useBlockMode ? 'primary' : 'default'"
                size="small"
                @click="useBlockMode = true"
              >
                {{ $t('@E80AC:逐块解决') }}
              </el-button>
              <el-button
                :type="!useBlockMode ? 'primary' : 'default'"
                size="small"
                @click="useBlockMode = false"
              >
                {{ $t('@E80AC:全局解决') }}
              </el-button>
            </div>
            <!-- 逐块冲突解决 -->
            <div v-if="conflictBlocks.length > 0 && useBlockMode" class="block-conflict-resolution">
              <ConflictBlockViewer
                :file-path="currentSelectedFile"
                :blocks="conflictBlocks"
                @resolve="handleBlockResolve"
              />
              <div class="save-resolution-bar">
                <el-button type="primary" size="large" @click="saveAllBlockResolutions">
                  {{ $t('@E80AC:保存所有解决方案') }}
                </el-button>
              </div>
            </div>
            <!-- 全局冲突解决 -->
            <div v-if="!useBlockMode || conflictBlocks.length === 0" class="global-conflict-wrapper">
              <div class="global-conflict-resolution">
                <div class="conflict-warning">
                  <el-icon class="warning-icon"><Warning /></el-icon>
                  <span>{{ $t('@E80AC:检测到冲突，请选择解决方式') }}</span>
                </div>
                <div class="conflict-buttons">
                  <el-button type="primary" size="small" @click="resolveConflictAcceptCurrent">
                    {{ $t('@E80AC:接受当前版本') }}
                  </el-button>
                  <el-button type="success" size="small" @click="resolveConflictAcceptIncoming">
                    {{ $t('@E80AC:接受传入版本') }}
                  </el-button>
                  <el-button type="warning" size="small" @click="resolveConflictAcceptBoth">
                    {{ $t('@E80AC:接受两者') }}
                  </el-button>
                </div>
              </div>
              <div class="diff-content" v-loading="isLoading">
                <el-empty 
                  v-if="!hasDiffContent && !isLoading"
                  :description="$t('@E80AC:该文件没有差异内容')"
                  :image-size="80"
                />
                <pre v-else-if="hasDiffContent && plainText" class="diff-text plain-text" v-text="diffContent" />
                <div v-else-if="hasDiffContent" class="diff-text" v-html="formatDiff(diffContent)" />
              </div>
            </div>
          </div>
          <!-- 冲突已手动解决 -->
          <div v-else-if="isConflictedFile && !hasActualConflictMarkers" class="conflict-resolved-container">
            <div class="resolved-notice">
              <el-icon class="success-icon" style="color: var(--color-success); font-size: var(--font-size-xl);">
                <CircleCheck />
              </el-icon>
              <span class="notice-text">{{ $t('@E80AC:冲突已解决，可以添加到暂存区') }}</span>
              <el-button type="success" size="default" @click="emit('stage', currentSelectedFile)">
                {{ $t('@E80AC:添加到暂存区') }}
              </el-button>
            </div>
            <div class="diff-content" v-loading="isLoading">
              <el-empty 
                v-if="!hasDiffContent && !isLoading"
                :description="$t('@E80AC:该文件没有差异内容')"
                :image-size="80"
              />
              <pre v-else-if="hasDiffContent && plainText" class="diff-text plain-text" v-text="diffContent" />
              <div v-else-if="hasDiffContent" class="diff-text" v-html="formatDiff(diffContent)" />
            </div>
          </div>
          <div v-else-if="!isConflictedFile" class="diff-content" v-loading="isLoading">
            <el-empty 
              v-if="!hasDiffContent && !isLoading"
              :description="currentSelectedFile ? $t('@E80AC:该文件没有差异内容') : $t('@E80AC:请选择文件查看差异')"
              :image-size="80"
            />
            <div v-else-if="compareMode" class="compare-view">
              <MonacoDiffViewer
                :original="compareOriginal"
                :modified="compareModified"
                language="auto"
                :file-path="currentSelectedFile"
                theme="auto"
                :read-only="true"
              />
            </div>
            <pre v-else-if="hasDiffContent && plainText" class="diff-text plain-text" v-text="diffContent" />
            <div v-else-if="hasDiffContent" class="diff-text" v-html="formatDiff(diffContent)" />
          </div>
        </div>
      </el-splitter-panel>
    </el-splitter>

    <!-- 当隐藏文件列表时，仅显示右侧面板 -->
    <div v-else class="diff-panel full-width">
      <div class="panel-header">
        <h4>{{ $t('@E80AC:文件差异') }}</h4>
        <div class="header-right">
          <slot name="header-extra" />
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
              :content="$t('@E80AC:复制文件路径')"
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
              :content="$t('@E80AC:用VSCode打开文件')"
              placement="top"
              effect="light"
            >
              <button
                class="modern-btn btn-icon-24 btn-success"
                @click="handleOpenWithVSCode"
              >
                <svg-icon icon-class="vscode" class="btn-icon" />
              </button>
            </el-tooltip>
          </div>
        </div>
      </div>
      
      <!-- 冲突解决区域 -->
      <div v-if="isConflictedFile" class="conflict-resolution-container">
        <!-- 模式切换按钮 -->
        <div v-if="conflictBlocks.length > 0" class="resolution-mode-switch">
          <el-button
            :type="useBlockMode ? 'primary' : 'default'"
            size="small"
            @click="useBlockMode = true"
          >
            {{ $t('@E80AC:逐块解决') }}
          </el-button>
          <el-button
            :type="!useBlockMode ? 'primary' : 'default'"
            size="small"
            @click="useBlockMode = false"
          >
            {{ $t('@E80AC:全局解决') }}
          </el-button>
        </div>
        <!-- 逐块冲突解决 -->
        <div v-if="conflictBlocks.length > 0 && useBlockMode" class="block-conflict-resolution">
          <ConflictBlockViewer
            :file-path="currentSelectedFile"
            :blocks="conflictBlocks"
            @resolve="handleBlockResolve"
          />
          <div class="save-resolution-bar">
            <el-button type="primary" size="large" @click="saveAllBlockResolutions">
              {{ $t('@E80AC:保存所有解决方案') }}
            </el-button>
          </div>
        </div>
        <!-- 全局冲突解决 -->
        <div v-if="!useBlockMode || conflictBlocks.length === 0" class="global-conflict-wrapper">
          <div class="global-conflict-resolution">
            <div class="conflict-warning">
              <el-icon class="warning-icon"><Warning /></el-icon>
              <span>{{ $t('@E80AC:检测到冲突，请选择解决方式') }}</span>
            </div>
            <div class="conflict-buttons">
              <el-button type="primary" size="small" @click="resolveConflictAcceptCurrent">
                {{ $t('@E80AC:接受当前版本') }}
              </el-button>
              <el-button type="success" size="small" @click="resolveConflictAcceptIncoming">
                {{ $t('@E80AC:接受传入版本') }}
              </el-button>
              <el-button type="warning" size="small" @click="resolveConflictAcceptBoth">
                {{ $t('@E80AC:接受两者') }}
              </el-button>
            </div>
          </div>
          <div class="diff-content" v-loading="isLoading">
            <el-empty 
              v-if="!hasDiffContent && !isLoading"
              :description="$t('@E80AC:该文件没有差异内容')"
              :image-size="80"
            />
            <pre v-else-if="hasDiffContent && plainText" class="diff-text plain-text" v-text="diffContent" />
            <div v-else-if="hasDiffContent" class="diff-text" v-html="formatDiff(diffContent)" />
          </div>
        </div>
      </div>
      
      <div v-else-if="!isConflictedFile" class="diff-content" v-loading="isLoading">
        <el-empty 
          v-if="!hasDiffContent && !isLoading"
          :description="currentSelectedFile ? $t('@E80AC:该文件没有差异内容') : $t('@E80AC:请选择文件查看差异')"
          :image-size="80"
        />
        <div v-else-if="compareMode" class="compare-view">
          <MonacoDiffViewer
            :original="compareOriginal"
            :modified="compareModified"
            language="auto"
            :file-path="currentSelectedFile"
            theme="auto"
            :read-only="true"
          />
        </div>
        <pre v-else-if="hasDiffContent && plainText" class="diff-text plain-text" v-text="diffContent" />
        <div v-else-if="hasDiffContent" class="diff-text" v-html="formatDiff(diffContent)" />
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

.plain-text {
  white-space: pre;
  word-break: break-word;
}

.compare-view {
  flex: 1;
  min-height: 0;
  height: 100%;
  min-height: 320px;
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
  height: 100%;
  
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
  box-shadow: var(--shadow-sm);
  
  h4 {
    margin: 0;
    font-size: var(--font-size-md);
    font-weight: var(--font-weight-semibold);
    
  }
}

.header-left {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.view-mode-toggle {
  display: flex;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs);
  background: var(--bg-panel);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-card);
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
        border-color: var(--color-primary);
      }
      
      &.is-focus {
        background: var(--bg-input);
        border-color: var(--color-primary);
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
          color: var(--color-primary);
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
  gap: var(--spacing-xs);
  font-family: var(--font-mono);
}

.path-dir {
  color: var(--text-tertiary);
}

.path-name {
  
  font-weight: var(--font-weight-semibold);
}

.diff-stats-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs) var(--spacing-base);
  border-radius: var(--radius-sm);
  background: var(--bg-container);
  border: 1px solid var(--border-color);
  font-size: var(--font-size-sm);
  font-family: var(--font-mono);
  font-weight: 500;
}

.stats-added {
  color: #52c41a;
}

.stats-deleted {
  color: #ff4d4f;
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
  padding: var(--spacing-base) var(--spacing-md);
  cursor: pointer;
  transition: var(--transition-all);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  position: relative;
  background: transparent;
  
  .conflict-marker {
    color: var(--git-status-conflicted);
    font-size: var(--font-size-md);
    margin-left: -4px;
    margin-right: var(--spacing-xs);
    animation: pulse 2s ease-in-out infinite;
  }
  
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
  
  // &.active {
  //   background: #e6f7ff;
  //   color: #1890ff;
    
  //   .file-icon {
  //     color: #1890ff;
  //   }
  // }
  
  // 根据文件类型添加不同样式 - 使用统一的Git状态颜色
  &.file-type-added {
    &::before {
      background: var(--git-status-added);
    }
    
    &:not(.active):hover,&.active {
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
    
    &:not(.active):hover,&.active {
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
    
    &:not(.active):hover,&.active {
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
    
    &:not(.active):hover,&.active {
      background: linear-gradient(90deg, rgba(139, 92, 246, 0.1) 0%, rgba(255, 255, 255, 0.8) 100%);
      
      &::before {
        background: var(--git-status-untracked);
        width: 4px;
      }
    }
  }
  
  &.file-type-conflicted {
    // 默认状态就有明显的背景色和更宽的左边条
    background-color: rgba(249, 115, 22, 0.08) !important;
    
    // 文件名使用冲突颜色
    .file-icon {
      color: var(--git-status-conflicted);
    }
    
    &:not(.active):hover,&.active {
      background: linear-gradient(90deg, rgba(249, 115, 22, 0.15) 0%, rgba(249, 115, 22, 0.08) 100%) !important;
      border-left-color: var(--git-status-conflicted);
      box-shadow: 0 0 0 1px rgba(249, 115, 22, 0.2);
      
      &::before {
        background: var(--git-status-conflicted);
      }
    }
  }
  
  // 锁定文件样式
  &.is-locked {
    opacity: 0.5;
    
    &:hover {
      opacity: 0.65;
    }
  }
}

.file-icon {
  margin-right: var(--spacing-base);
  flex-shrink: 0;
  font-size: var(--font-size-md);
  line-height: 1;
  display: inline-block;
}

.file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.file-path-section{
  // flex: 1;
  min-width: 0;
  overflow: hidden;
  
  :deep(.el-tooltip__trigger) {
    display: block;
    width: 100%;
    overflow: hidden;
  }
}

.path-badge {
  // display: inline-block;
  // max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  background: var(--bg-file-path);
  padding: 1px var(--spacing-sm);
  border-radius: var(--radius-sm);
  margin-left: var(--spacing-sm);
  box-sizing: border-box;
}

.file-item:hover .path-badge {
  background: var(--bg-file-path-hover);
  color: var(--color-file-path-hover);
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
  
  border-radius: var(--radius-base);
  background: var(--bg-container);
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--border-color-light);
}

.file-item:hover .file-actions {
  display: flex;
}

/* 冲突解决容器 */
.conflict-resolution-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-container);
}

/* 冲突已解决容器 */
.conflict-resolved-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-container);
  
  .resolved-notice {
    padding: var(--spacing-lg) var(--spacing-xl);
    background: linear-gradient(135deg, rgba(103, 194, 58, 0.1) 0%, rgba(103, 194, 58, 0.05) 100%);
    border-bottom: 2px solid var(--color-success);
    display: flex;
    align-items: center;
    gap: var(--spacing-md);
    
    .success-icon {
      flex-shrink: 0;
    }
    
    .notice-text {
      flex: 1;
      
      font-weight: 500;
      color: var(--text-primary);
    }
    
    .el-button {
      flex-shrink: 0;
    }
  }
  
  .diff-content {
    flex: 1;
    overflow-y: auto;
  }
}

/* 模式切换按钮 */
.resolution-mode-switch {
  padding: var(--spacing-md) var(--spacing-lg);
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border-color);
  display: flex;
  gap: var(--spacing-base);
  justify-content: center;
  
  .el-button {
    min-width: 120px;
  }
}

/* 逐块冲突解决区域 */
.block-conflict-resolution {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  
  :deep(.conflict-block-viewer) {
    flex: 1;
    overflow-y: auto;
  }
}

/* 保存解决方案按钮栏 */
.save-resolution-bar {
  padding: var(--spacing-lg);
  background: var(--bg-elevated);
  border-top: 1px solid var(--border-color);
  display: flex;
  justify-content: center;
  box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.05);
  
  .el-button {
    min-width: 200px;
  }
}

/* 全局冲突解决包装器 */
.global-conflict-wrapper {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 全局冲突解决按钮区域 */
.global-conflict-resolution {
  padding: var(--spacing-md) var(--spacing-lg);
  background: rgba(249, 115, 22, 0.1);
  border-left: 4px solid var(--git-status-conflicted);
  border-bottom: 1px solid rgba(249, 115, 22, 0.2);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-lg);
  flex-wrap: wrap;
  flex-shrink: 0;
}

.conflict-warning {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  color: var(--git-status-conflicted);
  font-weight: var(--font-weight-medium);
  flex: 1;
  min-width: 200px;
}

.warning-icon {
  font-size: var(--font-size-lg);
  color: var(--git-status-conflicted);
}

.conflict-buttons {
  display: flex;
  gap: var(--spacing-base);
  flex-wrap: wrap;
}

.diff-content {
  flex: 1;
  padding: var(--spacing-lg);
  overflow: auto;
  background: var(--bg-container);
  min-height: 0; /* 确保 flex 子元素能正确收缩 */
  position: relative; /* 使loading遮罩能够覆盖整个区域 */
  // display: flex;
  // flex-direction: column;
  
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

/* 冲突标记脉冲动画 */
@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
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

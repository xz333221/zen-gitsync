<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref, onMounted, computed, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Document, ArrowUp, ArrowDown, Download, Connection, Lock, Unlock, InfoFilled, Loading } from '@element-plus/icons-vue'
import TreeIcon from '@/components/icons/TreeIcon.vue'
import IconButton from '@/components/IconButton.vue'
import ListIcon from '@/components/icons/ListIcon.vue'
import { useGitStore } from '@stores/gitStore'
import { useConfigStore } from '@stores/configStore'
import FileDiffViewer from '@components/FileDiffViewer.vue'
import CommonDialog from '@components/CommonDialog.vue'
import FileGroup from '@/components/FileGroup.vue'
import FileTreeView from '@/components/FileTreeView.vue'
import DirectorySelector from '@components/DirectorySelector.vue'
import NpmScriptsPanel from '@components/NpmScriptsPanel.vue'
import StashChangesButton from '@/components/buttons/StashChangesButton.vue'
import StashListButton from '@/components/buttons/StashListButton.vue'
import MergeBranchButton from '@/components/buttons/MergeBranchButton.vue'
import UnstageAllButton from '@/components/buttons/UnstageAllButton.vue'
import { buildFileTree, mergeTreeExpandState, type TreeNode } from '@/utils/fileTree'
import GitOperationsButton from '@components/buttons/GitOperationsButton.vue'
import CommandHistory from '@views/components/CommandHistory.vue'

// 定义props
const props = defineProps({
  initialDirectory: {
    type: String,
    default: ''
  }
})

// const gitLogStore = useGitLogStore()
const gitStore = useGitStore()
const configStore = useConfigStore()
// 移除本地status定义，直接使用store中的statusText
// const status = ref($t('@13D1C:加载中...'))
// const socket = io()
const isRefreshing = computed(() => gitStore.isLoadingStatus)
// 移除本地fileList定义，改用store中的fileList
const selectedFile = ref('')
const diffContent = ref('')
const diffStats = ref<{added: number, deleted: number} | null>(null)
const diffDialogVisible = ref(false)
const isLoadingDiff = ref(false)
// 添加当前文件索引
const currentFileIndex = ref(-1)

// 每个文件的锁定/解锁加载状态
const lockingFiles = ref<Record<string, boolean>>({})
function isLocking(filePath: string) {
  return !!lockingFiles.value[filePath]
}

// npm脚本面板状态
const showNpmPanel = ref(true) // 默认打开NPM面板
function toggleNpmPanel() {
  showNpmPanel.value = !showNpmPanel.value
}

// 为FileDiffViewer组件准备数据
const gitFilesForViewer = computed(() => {
  return gitStore.fileList.map(file => ({
    path: file.path,
    name: file.path.split('/').pop() || file.path,
    type: file.type,
    locked: isFileLocked(file.path)
  }))
})

// 处理FileDiffViewer组件的文件选择
async function handleGitFileSelect(filePath: string) {
  await getFileDiff(filePath)
}

// 处理打开文件
async function handleOpenFile(filePath: string, context: string) {
  try {
    const response = await fetch('/api/open-file', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filePath,
        context
      })
    });
    
    const result = await response.json();
    
    if (result.success) {
      ElMessage.success(result.message);
    } else {
      ElMessage.error(result.error || $t('@13D1C:打开文件失败'));
    }
  } catch (error) {
    ElMessage.error(`${$t('@13D1C:打开文件失败: ')}${(error as Error).message}`);
  }
}

// 处理用VSCode打开文件
async function handleOpenWithVSCode(filePath: string, context: string) {
  try {
    const response = await fetch('/api/open-with-vscode', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filePath,
        context
      })
    });
    
    const result = await response.json();
    
    if (result.success) {
      ElMessage.success(result.message);
    } else {
      ElMessage.error(result.error || $t('@13D1C:用VSCode打开文件失败'));
    }
  } catch (error) {
    ElMessage.error(`${$t('@13D1C:用VSCode打开文件失败: ')}${(error as Error).message}`);
  }
}
// 锁定文件对话框状态
const showLockedFilesDialog = ref(false)
// 添加文件组折叠状态
const collapsedGroups = ref({
  staged: false,    // 已暂存的更改
  unstaged: false,  // 未暂存的更改
  untracked: false, // 未跟踪的文件
  conflicted: false // 冲突文件
})
// 视图模式：列表或树状（从 localStorage 读取）
const FILE_LIST_VIEW_MODE_KEY = 'zen-gitsync-file-list-view-mode';
const savedViewMode = localStorage.getItem(FILE_LIST_VIEW_MODE_KEY) as 'list' | 'tree' | null;
const viewMode = ref<'list' | 'tree'>(savedViewMode || 'list');
// 添加切换目录相关的状态
// const isDirectoryDialogVisible = ref(false)
// const newDirectoryPath = ref('')
// const isChangingDirectory = ref(false)
// 添加目录浏览相关的状态
// const isDirectoryBrowserVisible = ref(false)
// const currentBrowsePath = ref('')
// const directoryItems = ref<{name: string, path: string, type: string}[]>([])
// const isBrowsing = ref(false)
// const browseErrorMessage = ref('')

// 添加git操作相关状态
// 不再需要本地状态变量，使用gitStore中的isGitPulling和isGitFetching
// const isGitPulling = ref(false)
// const isGitFetching = ref(false)

const currentDirectory = ref(props.initialDirectory || '');
async function loadStatus() {
  try {
    // 如果没有初始目录，才需要请求当前目录
    if (!currentDirectory.value) {
      const responseDir = await fetch('/api/current_directory')
      const dirData = await responseDir.json()
      currentDirectory.value = dirData.directory || $t('@13D1C:未知目录')
    }
    // 如果不是Git仓库，直接显示提示并返回
    if (!gitStore.isGitRepo) {
      return
    }

    // 使用gitStore获取Git状态（只获取文件状态）
    await gitStore.fetchStatus()

    // 总是刷新分支状态以获取上游分支信息
    await gitStore.getBranchStatus()

    ElMessage({
      message: $t('@13D1C:Git 状态已刷新'),
      type: 'success',
    })
  } catch (error) {
    ElMessage({
      message: '刷新失败: ' + (error as Error).message,
      type: 'error',
    })
  }
}

// 解锁单个文件（带确认）
async function confirmUnlockFile(filePath: string) {
  try {
    await ElMessageBox.confirm(
      `确认解锁该文件？\n${filePath}`,
      $t('@13D1C:确认解锁'),
      {
        type: 'warning',
        confirmButtonText: $t('@13D1C:解锁'),
        cancelButtonText: $t('@13D1C:取消'),
      }
    )
    await configStore.unlockFile(filePath)
  } catch (e) {
    // 用户取消
  }
}

// 解锁全部锁定文件（带确认）
async function confirmUnlockAll() {
  if (!configStore.lockedFiles.length) return
  try {
    await ElMessageBox.confirm(
      `${$t('@13D1C:确认解锁所有已锁定文件？共 ')}${configStore.lockedFiles.length}${$t('@13D1C: 个。')}`,
      $t('@13D1C:清空全部锁定'),
      {
        type: 'warning',
        confirmButtonText: $t('@13D1C:全部解锁'),
        cancelButtonText: $t('@13D1C:取消'),
      }
    )
    // 复制数组，防止过程中列表变化
    const files = [...configStore.lockedFiles]
    await Promise.all(files.map(f => configStore.unlockFile(f)))
    await configStore.loadLockedFiles()
    ElMessage.success($t('@13D1C:已清空所有文件锁定'))
  } catch (e) {
    // 用户取消
  }
}



// 获取文件差异
async function getFileDiff(filePath: string) {
  try {
    isLoadingDiff.value = true
    // 先清空之前的内容
    diffContent.value = ''
    diffStats.value = null
    selectedFile.value = filePath
    // 设置当前文件索引
    currentFileIndex.value = gitStore.fileList.findIndex(file => file.path === filePath)
    
    // 获取当前文件的状态类型
    const currentFile = gitStore.fileList[currentFileIndex.value]
    
    // 对未跟踪文件特殊处理
    if (currentFile && currentFile.type === 'untracked') {
      try {
        // 获取未跟踪文件的内容
        const response = await fetch(`/api/file-content?file=${encodeURIComponent(filePath)}`)
        const data = await response.json()
        
        if (data.success && data.content) {
          // 构建一个类似diff的格式来显示新文件内容
          diffContent.value = `diff --git a/${filePath} b/${filePath}\n` +
            `${$t('@13D1C:新文件: ')}${filePath}\n` +
            `--- /dev/null\n` +
            `+++ b/${filePath}\n` +
            `@@ -0,0 +1,${data.content.split('\n').length} @@\n` +
            data.content.split('\n').map((line: string) => `+${line}`).join('\n')
        } else {
          diffContent.value = '这是一个新文件，尚未被Git跟踪。\n添加到暂存区后可以提交该文件。'
        }
      } catch (error) {
        console.error('获取未跟踪文件内容失败:', error)
        diffContent.value = '这是一个新文件，尚未被Git跟踪。\n添加到暂存区后可以提交该文件。'
      }
    } else if (currentFile && currentFile.type === 'added') {
      // 对于已暂存的文件，使用 diff --cached 获取差异
      const response = await fetch(`/api/diff-cached?file=${encodeURIComponent(filePath)}`)
      const data = await response.json()
      diffContent.value = data.diff || $t('@13D1C:没有变更')
      diffStats.value = data.stats || null
    } else {
      // 对于未暂存的文件，获取常规差异
      const response = await fetch(`/api/diff?file=${encodeURIComponent(filePath)}`)
      const data = await response.json()
      diffContent.value = data.diff || $t('@13D1C:没有变更')
      diffStats.value = data.stats || null
    }
  } catch (error) {
    ElMessage({
      message: '获取文件差异失败: ' + (error as Error).message,
      type: 'error',
    })
    diffContent.value = '获取差异失败: ' + (error as Error).message
  } finally {
    isLoadingDiff.value = false
  }
}




// 处理文件点击
function handleFileClick(file: {path: string, type: string}) {
  // 打开差异对话框，然后获取首个文件的差异
  diffDialogVisible.value = true
  // 如果有文件列表，默认选中点击的文件，否则选中第一个
  if (gitStore.fileList.length > 0) {
    const targetFile = gitStore.fileList.find(f => f.path === file.path) || gitStore.fileList[0]
    getFileDiff(targetFile.path)
  }
}

// 暂存单个文件
async function stageFile(filePath: string) {
  await gitStore.addFileToStage(filePath)
}

// 取消暂存单个文件
async function unstageFile(filePath: string) {
  await gitStore.unstageFile(filePath)
}

// 刷新Git状态的方法（包含分支领先/落后信息，强制刷新绕过缓存）
async function refreshStatus() {
  try {
    if (!gitStore.isGitRepo) return
    // 刷新文件状态
    await gitStore.fetchStatus()
    // 强制刷新分支状态（绕过30秒缓存），确保 branchAhead/branchBehind 立即更新
    await gitStore.getBranchStatus(true)
    ElMessage.success($t('@13D1C:Git 状态已刷新'))
  } catch (error) {
    ElMessage.error('刷新失败: ' + (error as Error).message)
  }
}

// 添加git pull操作方法
async function handleGitPull() {
  try {
    // 使用store中的状态变量，而不是本地变量
    await gitStore.gitPull()
    // 刷新Git状态
    await loadStatus()
  } catch (error) {
    // 错误处理已经在store中完成
    console.error('拉取操作发生错误:', error)
  }
}

// 添加git fetch --all操作方法
async function handleGitFetchAll() {
  try {
    // 使用store中的状态变量，而不是本地变量
    await gitStore.gitFetchAll()
    // 刷新Git状态
    await loadStatus()
  } catch (error) {
    // 错误处理已经在store中完成
    console.error('获取远程分支信息操作发生错误:', error)
  }
}

// 一键设置上游并推送
const isSettingUpstream = ref(false)
async function setUpstreamAndPush() {
  if (!gitStore.currentBranch) {
    ElMessage.warning($t('@13D1C:未知当前分支'))
    return
  }
  try {
    isSettingUpstream.value = true
    const command = `git push -u origin ${gitStore.currentBranch}`
    const res = await fetch('/api/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command })
    })
    const data = await res.json()
    if (data.success) {
      ElMessage.success($t('@13D1C:已推送并设置上游分支'))
      // 刷新分支列表与当前分支，确保 footer 下拉实时更新
      await gitStore.getAllBranches()
      await gitStore.getCurrentBranch(true)
      await gitStore.getBranchStatus(true)
    } else {
      ElMessage.error(data.error || $t('@13D1C:设置上游失败'))
    }
  } catch (e) {
    ElMessage.error(`${$t('@13D1C:设置上游失败: ')}${(e as Error).message}`)
  } finally {
    isSettingUpstream.value = false
  }
}

// 添加撤回文件修改的方法
async function revertFileChanges(filePath: string) {
  try {
    // 请求用户确认
    await ElMessageBox.confirm(
      `${$t('@13D1C:确定要撤回文件 "')}${filePath}${$t('@13D1C:" 的所有修改吗？此操作无法撤销。')}`,
      $t('@13D1C:撤回修改'),
      {
        confirmButtonText: $t('@13D1C:确定'),
        cancelButtonText: $t('@13D1C:取消'),
        type: 'warning'
      }
    )
    
    // 发送请求到后端API
    const response = await fetch('/api/revert_file', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ filePath })
    })
    
    const result = await response.json()
    
    if (result.success) {
      ElMessage.success($t('@13D1C:已撤回文件修改'))
      // 刷新Git状态
      await loadStatus()
    } else {
      // 使用自定义错误信息，避免显示undefined
      ElMessage.error(result.error ? `${$t('@13D1C:撤回失败: ')}${result.error}` : $t('@13D1C:撤回文件修改失败，请重试'))
    }
  } catch (error) {
    // 用户取消操作不显示错误
    if ((error as any) === 'cancel' || (error as Error).message === 'cancel') {
      // 用户取消操作，不做任何处理，也不显示错误
      return
    }
    
    // 其他错误情况才显示错误消息
    // 避免显示undefined错误信息
    const errorMessage = (error as Error).message || $t('@13D1C:未知错误');
    if (errorMessage !== 'undefined') {
      ElMessage.error(`${$t('@13D1C:撤回文件修改失败: ')}${errorMessage}`)
    } else {
      ElMessage.error($t('@13D1C:撤回文件修改失败，请重试'))
    }
  }
}

// 提取文件名和目录
function getFileName(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1]
}

function getFileDirectory(path: string): string {
  const parts = path.split('/')
  if (parts.length <= 1) return ''

  // 保留所有除最后一个部分的路径
  return parts.slice(0, -1).join('/')
}

// 检查文件是否被锁定
function isFileLocked(filePath: string): boolean {
  // 标准化路径分隔符，统一使用正斜杠
  const normalizedPath = filePath.replace(/\\/g, '/')
  const isLocked = configStore.lockedFiles.some(lockedFile => {
    const normalizedLocked = lockedFile.replace(/\\/g, '/')
    return normalizedPath === normalizedLocked
  })

  return isLocked
}

// 切换文件锁定状态
async function toggleFileLock(filePath: string) {
  if (lockingFiles.value[filePath]) return
  lockingFiles.value[filePath] = true
  try {
    const isLocked = isFileLocked(filePath)
    if (isLocked) {
      await configStore.unlockFile(filePath)
    } else {
      await configStore.lockFile(filePath)
    }
  } finally {
    // 使用 nextTick 也可，但这里直接清理状态
    delete lockingFiles.value[filePath]
  }
}

// 切换文件组的折叠状态
function toggleGroupCollapse(groupType: 'staged' | 'unstaged' | 'untracked' | 'conflicted') {
  collapsedGroups.value[groupType] = !collapsedGroups.value[groupType]
}

// 树状视图数据（使用ref保持展开状态）
const conflictedTreeData = ref<TreeNode[]>([]);
const stagedTreeData = ref<TreeNode[]>([]);
const unstagedTreeData = ref<TreeNode[]>([]);
const untrackedTreeData = ref<TreeNode[]>([]);

// 更新树状视图数据
function updateTreeData() {
  // 冲突文件（优先级最高）
  const conflictedFiles = gitStore.fileList.filter(f => f.type === 'conflicted').map(file => ({
    path: file.path,
    type: file.type,
    locked: isFileLocked(file.path)
  }));
  const newConflictedTree = buildFileTree(conflictedFiles);
  if (conflictedTreeData.value.length > 0) {
    mergeTreeExpandState(newConflictedTree, conflictedTreeData.value);
  }
  conflictedTreeData.value = newConflictedTree;
  
  // 已暂存
  const stagedFiles = gitStore.fileList.filter(f => f.type === 'added').map(file => ({
    path: file.path,
    type: file.type,
    locked: isFileLocked(file.path)
  }));
  const newStagedTree = buildFileTree(stagedFiles);
  if (stagedTreeData.value.length > 0) {
    mergeTreeExpandState(newStagedTree, stagedTreeData.value);
  }
  stagedTreeData.value = newStagedTree;
  
  // 未暂存
  const unstagedFiles = gitStore.fileList.filter(f => f.type === 'modified' || f.type === 'deleted').map(file => ({
    path: file.path,
    type: file.type,
    locked: isFileLocked(file.path)
  }));
  const newUnstagedTree = buildFileTree(unstagedFiles);
  if (unstagedTreeData.value.length > 0) {
    mergeTreeExpandState(newUnstagedTree, unstagedTreeData.value);
  }
  unstagedTreeData.value = newUnstagedTree;
  
  // 未跟踪
  const untrackedFiles = gitStore.fileList.filter(f => f.type === 'untracked').map(file => ({
    path: file.path,
    type: file.type,
    locked: isFileLocked(file.path)
  }));
  const newUntrackedTree = buildFileTree(untrackedFiles);
  if (untrackedTreeData.value.length > 0) {
    mergeTreeExpandState(newUntrackedTree, untrackedTreeData.value);
  }
  untrackedTreeData.value = newUntrackedTree;
}

// 监听文件列表变化，更新树数据
watch(() => gitStore.fileList, () => {
  if (viewMode.value === 'tree') {
    updateTreeData();
  }
}, { deep: true });

// 监听视图模式变化，切换到树视图时初始化数据，并保存到 localStorage
watch(viewMode, (newMode) => {
  if (newMode === 'tree') {
    updateTreeData();
  }
  // 保存到 localStorage
  localStorage.setItem(FILE_LIST_VIEW_MODE_KEY, newMode);
  
  // 触发自定义事件，通知其他组件视图模式已变化
  window.dispatchEvent(new CustomEvent('file-list-view-mode-change', { 
    detail: { mode: newMode } 
  }));
});

onMounted(() => {
  // App.vue已经加载了Git相关数据，此时只需加载状态
  loadStatus()
  // 加载配置和锁定文件列表
  configStore.loadConfig()
  configStore.loadLockedFiles()
  
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
  
  // 监听 Git 状态刷新事件（例如解决冲突后）
  const handleGitStatusRefresh = () => {
    loadStatus();
    // 如果当前有选中的文件，重新获取差异
    if (selectedFile.value) {
      getFileDiff(selectedFile.value);
    }
  };
  
  window.addEventListener('file-list-view-mode-change', handleViewModeChange);
  window.addEventListener('git-status-refresh', handleGitStatusRefresh);
  
  // 监听页面可见性变化，类似VSCode的做法：标签页激活时自动刷新git状态
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible' && gitStore.isGitRepo) {
      console.log('[页面可见性] 标签页已激活，刷新Git状态和分支信息');
      // 静默刷新，不显示提示信息，同时刷新文件状态和上下游信息
      Promise.all([
        gitStore.fetchStatus(),      // 刷新文件状态
        gitStore.getBranchStatus()   // 刷新上下游信息
      ]).catch(err => console.error('刷新失败:', err));
    }
  };
  
  // 监听窗口获得焦点事件：从其他应用（如VSCode）切换回浏览器时刷新
  const handleWindowFocus = () => {
    if (gitStore.isGitRepo) {
      console.log('[窗口焦点] 浏览器窗口已激活，刷新Git状态和分支信息');
      // 静默刷新，不显示提示信息，同时刷新文件状态和上下游信息
      Promise.all([
        gitStore.fetchStatus(),      // 刷新文件状态
        gitStore.getBranchStatus()   // 刷新上下游信息
      ]).catch(err => console.error('刷新失败:', err));
    }
  };
  
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('focus', handleWindowFocus);
  
  // 组件卸载时移除监听
  return () => {
    window.removeEventListener('file-list-view-mode-change', handleViewModeChange);
    window.removeEventListener('git-status-refresh', handleGitStatusRefresh);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('focus', handleWindowFocus);
  };
})

// 自动更新开关已隐藏 - 文件监控默认禁用，改为使用手动刷新和标签页激活刷新
// watch(() => gitStore.autoUpdateEnabled, async (newValue, oldValue) => {
//   console.log(`${$t('@13D1C:自动更新状态变更: ')}${oldValue} -> ${newValue}`)
//   
//   // 如果是从关闭到打开，显示确认弹窗
//   if (newValue === true && oldValue === false) {
//     try {
//       await ElMessageBox.confirm(
//         '开启自动更新后，系统将监控文件变化并实时刷新Git状态。\n\n⚠️ 注意：在大型项目（特别是monorepo）中可能会导致：\n• 高CPU占用\n• 初始化耗时较长（可能几分钟）\n• 风扇噪音增大\n\n建议：\n✅ 小型项目可以开启\n❌ 大型项目建议使用手动刷新或标签页激活刷新\n\n确定要开启自动更新吗？',
//         '性能提示',
//         {
//           confirmButtonText: '确定开启',
//           cancelButtonText: '取消',
//           type: 'warning',
//           customClass: 'auto-update-confirm-dialog',
//           dangerouslyUseHTMLString: false
//         }
//       );
//       
//       // 用户确认后，调用store中的方法来实现服务器通信功能
//       gitStore.toggleAutoUpdate()
//     } catch (error) {
//       // 用户取消，恢复开关状态
//       console.log('用户取消开启自动更新');
//       gitStore.autoUpdateEnabled = false;
//     }
//   } else {
//     // 关闭开关，直接执行
//     gitStore.toggleAutoUpdate()
//   }
// }, { immediate: false })

// onUnmounted(() => {
//   socket.disconnect()
// })
// 暴露刷新方法给父组件
defineExpose({
  refreshStatus
})
</script>

<template>
  <div class="card git-status-card flex flex-col">
    <div class="status-header">
      <!-- 目录选择卡片 -->
      <DirectorySelector @toggle-npm-panel="toggleNpmPanel" />
      
      <div class="title-row">
        <div class="header-actions">
          <!-- 添加Git Pull按钮 -->
          <IconButton
            :tooltip="$t('@13D1C:Git Pull (拉取远程更新)')"
            size="small"
            hover-color="var(--color-primary)"
            :disabled="!gitStore.hasUpstream || gitStore.isGitPulling"
            @click="handleGitPull"
          >
            <el-icon v-if="gitStore.isGitPulling" class="is-loading"><Loading /></el-icon>
            <el-icon v-else><Download /></el-icon>
          </IconButton>
          
          <!-- 添加Git Fetch All按钮 -->
          <IconButton
            v-show="false"
            :tooltip="$t('@13D1C:Git Fetch All (获取所有远程分支)')"
            size="small"
            hover-color="var(--color-primary)"
            :disabled="gitStore.isGitFetching"
            @click="handleGitFetchAll"
          >
            <el-icon v-if="gitStore.isGitFetching" class="is-loading"><Loading /></el-icon>
            <el-icon v-else><Connection /></el-icon>
          </IconButton>

          <!-- 合并分支按钮 -->
          <MergeBranchButton />

          <!-- 取消暂存所有按钮 -->
          <UnstageAllButton from="status" />

          <!-- 储藏更改按钮 -->
          <StashChangesButton />
          
          <!-- 储藏列表按钮 -->
          <StashListButton />
        </div>
        <div class="flex items-center">
          <GitOperationsButton variant="icon" />
          <CommandHistory />
          <IconButton
            :tooltip="$t('@13D1C:刷新状态')"
            size="large"
            :disabled="isRefreshing"
            @click="refreshStatus"
          >
            <el-icon v-if="isRefreshing" class="is-loading"><Loading /></el-icon>
            <el-icon v-else><Refresh /></el-icon>
          </IconButton>
        </div>
      </div>
    </div>
    
    <div class="card-content" 
      v-loading="gitStore.isGitPulling || gitStore.isGitFetching" 
      :element-loading-text="gitStore.isGitPulling ? $t('@13D1C:正在拉取代码...') : $t('@13D1C:正在获取远程分支信息...')"
    >
      <div v-if="!gitStore.isGitRepo" class="status-box">
        <div class="empty-status">
          <p>{{ $t('@13D1C:当前目录不是Git仓库') }}</p>
        </div>
      </div>
      
      <div class="status-box-wrap" v-else>
        <!-- 无上游分支提示 -->
        <div v-if="!gitStore.hasUpstream" class="upstream-tip">
          <div class="tip-header">
            <el-icon class="tip-icon"><InfoFilled /></el-icon>
            <span class="tip-title">{{ $t('@13D1C:当前分支未设置上游分支') }}</span>
          </div>
          <div class="tip-body">
            <div class="tip-text">{{ $t('@13D1C:首次推送后即可建立与远程的跟踪关系，后续可直接 pull/push。') }}</div>
            <div class="tip-actions">
              <el-button 
                size="small" 
                type="primary" 
                plain 
                :loading="isSettingUpstream"
                :disabled="isSettingUpstream"
                @click="setUpstreamAndPush"
              >
                {{ $t('@13D1C:设置上游并推送') }}
              </el-button>
            </div>
          </div>
        </div>
        <!-- 分支信息仅在有领先/落后状态时才显示 -->
        <div v-if="gitStore.hasUpstream && (gitStore.branchAhead > 0 || gitStore.branchBehind > 0)" class="branch-status-info">
          <!-- 分支同步状态信息 -->
          <div class="branch-sync-status">
            <div class="sync-status-content">
              <el-tooltip :content="$t('@13D1C:本地分支与远程分支的状态对比')" placement="top" :show-after="200">
                <div class="status-badges">
                  <el-tag v-if="gitStore.branchAhead > 0" size="small" type="warning" class="status-badge">
                    <template #default>
                      <span class="badge-content">
                        <el-icon><ArrowUp /></el-icon> 你的分支领先 'origin/{{ gitStore.currentBranch }}' {{ gitStore.branchAhead }} {{ $t('@13D1C:个提交') }}
                      </span>
                    </template>
                  </el-tag>
                  <el-tag v-if="gitStore.branchBehind > 0" size="small" type="info" class="status-badge">
                    <template #default>
                      <span class="badge-content">
                        <el-icon><ArrowDown /></el-icon> 你的分支落后 'origin/{{ gitStore.currentBranch }}' {{ gitStore.branchBehind }} {{ $t('@13D1C:个提交') }}
                      </span>
                    </template>
                  </el-tag>
                </div>
              </el-tooltip>
            </div>
          </div>
        </div>
        
        <!-- 现代化、简洁的文件列表 -->
        <div v-if="gitStore.fileList.length" class="file-list-wrapper">
          <div class="file-list-header">
            <div class="header-left">
              <h4>{{ $t('@13D1C:文件列表') }}</h4>
              <span v-if="gitStore.fileList.length > 0" class="file-count">({{ gitStore.fileList.length }})</span>
            </div>
            <div class="view-mode-toggle">
              <el-tooltip :content="$t('@E80AC:列表视图')" placement="top" :show-after="200">
                <button 
                  class="mode-btn" 
                  :class="{ active: viewMode === 'list' }"
                  @click="viewMode = 'list'"
                >
                  <ListIcon style="width: 1em; height: 1em;" />
                </button>
              </el-tooltip>
              <el-tooltip :content="$t('@E80AC:树状视图')" placement="top" :show-after="200">
                <button 
                  class="mode-btn" 
                  :class="{ active: viewMode === 'tree' }"
                  @click="viewMode = 'tree'"
                >
                  <TreeIcon style="width: 1em; height: 1em;" />
                </button>
              </el-tooltip>
            </div>
          </div>
          <div class="file-list-container">
            <!-- 列表视图 -->
            <template v-if="viewMode === 'list'">
              <!-- 冲突文件（优先级最高，显示在最前面） -->
              <FileGroup
                :files="gitStore.fileList.filter(f => f.type === 'conflicted')"
                :title="$t('@13D1C:冲突文件')"
                group-key="conflicted"
                :collapsed-groups="collapsedGroups"
                :is-file-locked="isFileLocked"
                :is-locking="isLocking"
                :get-file-name="getFileName"
                :get-file-directory="getFileDirectory"
                @toggle-collapse="toggleGroupCollapse"
                @file-click="handleFileClick"
                @toggle-file-lock="toggleFileLock"
                @stage-file="stageFile"
                @revert-file-changes="revertFileChanges"
              />
              
              <!-- 已暂存的更改 -->
              <FileGroup
                :files="gitStore.fileList.filter(f => f.type === 'added')"
                :title="$t('@13D1C:已暂存的更改')"
                group-key="staged"
                :collapsed-groups="collapsedGroups"
                :is-file-locked="isFileLocked"
                :is-locking="isLocking"
                :get-file-name="getFileName"
                :get-file-directory="getFileDirectory"
                @toggle-collapse="toggleGroupCollapse"
                @file-click="handleFileClick"
                @toggle-file-lock="toggleFileLock"
                @unstage-file="unstageFile"
              />
              
              <!-- 未暂存的更改 -->
              <FileGroup
                :files="gitStore.fileList.filter(f => f.type === 'modified' || f.type === 'deleted')"
                :title="$t('@13D1C:未暂存的更改')"
                group-key="unstaged"
                :collapsed-groups="collapsedGroups"
                :is-file-locked="isFileLocked"
                :is-locking="isLocking"
                :get-file-name="getFileName"
                :get-file-directory="getFileDirectory"
                @toggle-collapse="toggleGroupCollapse"
                @file-click="handleFileClick"
                @toggle-file-lock="toggleFileLock"
                @stage-file="stageFile"
                @revert-file-changes="revertFileChanges"
                @manage-locked-files="showLockedFilesDialog = true"
              />
              
              <!-- 未跟踪的文件 -->
              <FileGroup
                :files="gitStore.fileList.filter(f => f.type === 'untracked')"
                :title="$t('@13D1C:未跟踪的文件')"
                group-key="untracked"
                :collapsed-groups="collapsedGroups"
                :is-file-locked="isFileLocked"
                :is-locking="isLocking"
                :get-file-name="getFileName"
                :get-file-directory="getFileDirectory"
                @toggle-collapse="toggleGroupCollapse"
                @file-click="handleFileClick"
                @toggle-file-lock="toggleFileLock"
                @stage-file="stageFile"
                @revert-file-changes="revertFileChanges"
                @manage-locked-files="showLockedFilesDialog = true"
              />
            </template>
            
            <!-- 树状视图 -->
            <template v-else>
              <!-- 冲突文件（优先级最高，显示在最前面） -->
              <div v-if="gitStore.fileList.filter(f => f.type === 'conflicted').length" class="tree-group">
                <div class="tree-group-header" @click="toggleGroupCollapse('conflicted')">
                  <el-icon class="collapse-icon" :class="{ 'collapsed': collapsedGroups.conflicted }">
                    <ArrowDown />
                  </el-icon>
                  <h5>{{ $t('@13D1C:冲突文件') }}</h5>
                  <span class="file-count">{{ gitStore.fileList.filter(f => f.type === 'conflicted').length }}</span>
                </div>
                <FileTreeView
                  v-if="!collapsedGroups.conflicted"
                  :tree-data="conflictedTreeData"
                  :selected-file="''"
                  :show-action-buttons="true"
                  :is-file-locked="isFileLocked"
                  :is-locking="isLocking"
                  @file-select="(path: string) => handleFileClick({ path, type: 'conflicted' })"
                  @toggle-lock="toggleFileLock"
                  @stage="stageFile"
                  @revert="revertFileChanges"
                />
              </div>
              
              <!-- 已暂存的更改 -->
              <div v-if="gitStore.fileList.filter(f => f.type === 'added').length" class="tree-group">
                <div class="tree-group-header" @click="toggleGroupCollapse('staged')">
                  <el-icon class="collapse-icon" :class="{ 'collapsed': collapsedGroups.staged }">
                    <ArrowDown />
                  </el-icon>
                  <h5>{{ $t('@13D1C:已暂存的更改') }}</h5>
                  <span class="file-count">{{ gitStore.fileList.filter(f => f.type === 'added').length }}</span>
                </div>
                <FileTreeView
                  v-if="!collapsedGroups.staged"
                  :tree-data="stagedTreeData"
                  :selected-file="''"
                  :show-action-buttons="true"
                  :is-file-locked="isFileLocked"
                  :is-locking="isLocking"
                  @file-select="(path: string) => handleFileClick({ path, type: 'added' })"
                  @toggle-lock="toggleFileLock"
                  @unstage="unstageFile"
                />
              </div>
              
              <!-- 未暂存的更改 -->
              <div v-if="gitStore.fileList.filter(f => f.type === 'modified' || f.type === 'deleted').length" class="tree-group">
                <div class="tree-group-header" @click="toggleGroupCollapse('unstaged')">
                  <el-icon class="collapse-icon" :class="{ 'collapsed': collapsedGroups.unstaged }">
                    <ArrowDown />
                  </el-icon>
                  <h5>{{ $t('@13D1C:未暂存的更改') }}</h5>
                  <span class="file-count">{{ gitStore.fileList.filter(f => f.type === 'modified' || f.type === 'deleted').length }}</span>
                </div>
                <FileTreeView
                  v-if="!collapsedGroups.unstaged"
                  :tree-data="unstagedTreeData"
                  :selected-file="''"
                  :show-action-buttons="true"
                  :is-file-locked="isFileLocked"
                  :is-locking="isLocking"
                  @file-select="(path: string) => handleFileClick({ path, type: 'modified' })"
                  @toggle-lock="toggleFileLock"
                  @stage="stageFile"
                  @revert="revertFileChanges"
                />
              </div>
              
              <!-- 未跟踪的文件 -->
              <div v-if="gitStore.fileList.filter(f => f.type === 'untracked').length" class="tree-group">
                <div class="tree-group-header" @click="toggleGroupCollapse('untracked')">
                  <el-icon class="collapse-icon" :class="{ 'collapsed': collapsedGroups.untracked }">
                    <ArrowDown />
                  </el-icon>
                  <h5>{{ $t('@13D1C:未跟踪的文件') }}</h5>
                  <span class="file-count">{{ gitStore.fileList.filter(f => f.type === 'untracked').length }}</span>
                </div>
                <FileTreeView
                  v-if="!collapsedGroups.untracked"
                  :tree-data="untrackedTreeData"
                  :selected-file="''"
                  :show-action-buttons="true"
                  :is-file-locked="isFileLocked"
                  :is-locking="isLocking"
                  @file-select="(path: string) => handleFileClick({ path, type: 'untracked' })"
                  @toggle-lock="toggleFileLock"
                  @stage="stageFile"
                  @revert="revertFileChanges"
                />
              </div>
            </template>
          </div>
        </div>
        <div v-else-if="gitStore.isGitRepo" class="empty-status">
          <div class="empty-icon">
            <el-icon><Document /></el-icon>
          </div>
          <div class="empty-text">{{ $t('@13D1C:没有检测到任何更改') }}</div>
          <div class="empty-subtext">{{ $t('@13D1C:工作区是干净的') }}</div>
        </div>
      </div>
    </div>
    
    <!-- NPM脚本面板 -->
    <NpmScriptsPanel :visible="showNpmPanel" @close="showNpmPanel = false" />
  </div>
  
  <!-- 文件差异对话框 -->
  <CommonDialog
    v-model="diffDialogVisible"
    :title="$t('@13D1C:文件差异')"
    custom-class="file-diff-dialog"
    size="extra-large"
    type="flex"
    destroy-on-close
    heightMode="fixed"
    >
    <FileDiffViewer
      :files="gitFilesForViewer"
      :diffContent="diffContent"
      :diffStats="diffStats"
      :selectedFile="selectedFile"
      :isLoading="isLoadingDiff"
      :showActionButtons="true"
      :isFileLocked="isFileLocked"
      :isLocking="isLocking"
      context="git-status"
      :emptyText="$t('@13D1C:选择文件查看差异')"
      @file-select="handleGitFileSelect"
      @open-file="handleOpenFile"
      @open-with-vscode="handleOpenWithVSCode"
      @toggle-lock="toggleFileLock"
      @stage="stageFile"
      @unstage="unstageFile"
      @revert="revertFileChanges"
    />
  </CommonDialog>

  <!-- 锁定文件管理对话框 -->
  <CommonDialog
    v-model="showLockedFilesDialog"
    :title="$t('@13D1C:锁定文件管理')"
    size="large"
    destroy-on-close
  >
    <!-- 功能说明 -->
    <div class="lock-feature-description">
      <div class="description-header">
        <el-icon class="description-icon"><InfoFilled /></el-icon>
        <span class="description-title">{{ $t('@13D1C:文件锁定功能说明') }}</span>
      </div>
      <div class="description-content">
        <ul>
          <li>{{ $t('@13D1C:锁定的文件在执行 Git 提交时会被自动跳过，不会被添加到暂存区') }}</li>
        </ul>
      </div>
    </div>


    <div v-if="configStore.lockedFiles.length === 0" class="empty-locked-files">
      <div class="empty-icon">
        <el-icon><Lock /></el-icon>
      </div>
      <p>{{ $t('@13D1C:当前没有锁定的文件') }}</p>
      <p class="empty-tip">{{ $t('@13D1C:您可以在文件列表中点击锁定按钮来锁定文件') }}</p>
    </div>

    <div v-else class="locked-files-list">
      <div class="locked-files-header">
        <span>🔒 已锁定 {{ configStore.lockedFiles.length }} {{ $t('@13D1C:个文件') }}</span>
        <el-tooltip :content="$t('@13D1C:这些文件在提交时会被自动跳过')" placement="top">
          <el-icon class="info-icon"><InfoFilled /></el-icon>
        </el-tooltip>
        <div style="flex:1"></div>
        <el-button
          type="danger"
          size="small"
          plain
          :disabled="!configStore.lockedFiles.length"
          @click="confirmUnlockAll"
        >
          {{ $t('@13D1C:清空全部锁定') }}
        </el-button>
      </div>

      <div class="locked-file-items">
        <div
          v-for="filePath in configStore.lockedFiles"
          :key="filePath"
          class="locked-file-item"
        >
          <div class="file-info">
            <div class="file-status-indicator locked"></div>
            <div class="file-path-container">
              <span class="file-name">{{ getFileName(filePath) }}</span>
              <span class="file-directory">{{ getFileDirectory(filePath) }}</span>
            </div>
          </div>
          <div class="file-actions">
            <IconButton
              :tooltip="$t('@13D1C:解锁文件')"
              size="small"
              hover-color="var(--color-danger)"
              custom-class="file-action-btn"
              @click="confirmUnlockFile(filePath)"
            >
              <el-icon><Unlock /></el-icon>
            </IconButton>
          </div>
        </div>
      </div>
    </div>
  </CommonDialog>
</template>

<style scoped>

.status-header {
  display: flex;
  flex-direction: column;
}

.title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.status-header h2 {
  margin: 0;
  flex-shrink: 0;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
}

.card-content {
  padding: var(--spacing-sm);
  overflow-y: auto;
  overflow-x: hidden;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.status-box {
  white-space: pre-wrap;
  font-family: monospace;
  padding: var(--spacing-base);
  border-radius: var(--radius-lg);
  margin-bottom: var(--spacing-base);
  max-height: 200px;
  overflow-y: auto;
  overflow-x: hidden;
  border: 1px solid var(--border-card);
  
  line-height: 1.5;
  width: 100%;
  box-sizing: border-box;
}



/* 文件列表包装器 */
.file-list-wrapper {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

.file-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-sm) 0;
  background: var(--bg-container);
  border-bottom: 1px solid var(--border-card);
  
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
  
  .file-count {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    font-weight: var(--font-weight-medium);
    background: var(--bg-panel);
    padding: var(--spacing-xs) var(--spacing-sm);
    border-radius: var(--radius-full);
    border: 1px solid var(--border-card);
  }
}

.view-mode-toggle {
  display: flex;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs);
  background: var(--bg-panel);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-card);
  
  .mode-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    border-radius: var(--radius-sm);
    transition: var(--transition-all);
    
    &:hover {
      background: var(--bg-container);
      color: var(--text-primary);
    }
    
    &.active {
      background: var(--color-primary);
      color: white;
      box-shadow: var(--shadow-sm);
    }
    
    .el-icon {
      font-size: var(--font-size-md);
    }
  }
}

/* 文件列表容器 */
.file-list-container {
  overflow-y: auto;
  flex: 1;
  width: 100%;
  box-sizing: border-box;
  scrollbar-width: thin;
  scrollbar-color: rgba(144, 147, 153, 0.3) transparent;
}

/* Webkit浏览器的滚动条样式 */
.file-list-container::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.file-list-container::-webkit-scrollbar-thumb {
  background-color: rgba(144, 147, 153, 0.3);
  border-radius: var(--radius-base);
}

.file-list-container::-webkit-scrollbar-thumb:hover {
  background-color: rgba(144, 147, 153, 0.5);
}

.file-list-container::-webkit-scrollbar-track {
  background-color: transparent;
}



.empty-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  background-color: var(--bg-component-area);
  border-radius: var(--radius-lg);
  flex-grow: 1;
}

.empty-icon {
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--bg-icon);
  border-radius: 50%;
  margin-bottom: var(--spacing-base);
  font-size: 28px;
  color: var(--text-tertiary);
  animation: pulse 2s infinite ease-in-out;
}

@keyframes pulse {
  0% { transform: scale(1); opacity: 0.7; }
  50% { transform: scale(1.05); opacity: 1; }
  100% { transform: scale(1); opacity: 0.7; }
}

.empty-text {
  font-size: var(--font-size-lg);
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: var(--spacing-base);
}

.empty-subtext {
  
  color: var(--text-tertiary);
  margin-bottom: var(--spacing-base);
}

.status-box-wrap {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
}

/* 分支信息样式 */
.branch-status-info {
  margin-bottom: 0;
  background-color: var(--bg-container);
  border-radius: var(--radius-lg);
  overflow: hidden;
  border: 1px solid var(--border-card);
  transition: all 0.3s ease;
}

.branch-status-info:hover {
  box-shadow: var(--shadow-md);
}

.branch-sync-status {
  display: flex;
  align-items: center;
  padding: var(--spacing-base);
  margin-bottom: 0;
}

.sync-status-content {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  width: 100%;
}

.status-badges {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-base);
  width: 100%;
}

.status-badge {
  display: flex;
  align-items: center;
  width: 100%;
  border-radius: var(--radius-base);
  padding: var(--spacing-base);
  transition: all 0.3s ease;
}

.status-badge.el-tag--warning {
  border-color: #ffd591;
  color: #d46b08;
}

.status-badge.el-tag--info {
  background-color: #e6f7ff;
  border-color: #91d5ff;
  color: #1890ff;
}

.status-badge:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}

.badge-content {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  font-size: var(--font-size-sm);
}

/* 按钮悬停效果 */
.el-button {
  transition: all 0.3s ease;
}

.el-button:not(:disabled):hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}

/* 自定义Git操作加载样式 */
.card-content :deep(.el-loading-mask) {
  background-color: rgba(255, 255, 255, 0.8);
  backdrop-filter: blur(3px);
  z-index: 10;
}

.card-content :deep(.el-loading-spinner) {
  transform: scale(1.2);
}

.card-content :deep(.el-loading-text) {
  font-size: var(--font-size-md);
  color: var(--color-primary);
  font-weight: bold;
  margin-top: var(--spacing-base);
}



/* 锁定文件对话框样式 */
.empty-locked-files {
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  padding: var(--spacing-base);
  color: #666;
}

.empty-locked-files .empty-icon {
  font-size: 48px;
  color: #d9d9d9;
  margin-bottom: var(--spacing-base);
}

.empty-locked-files p {
  margin: var(--spacing-base) 0;
}

.empty-tip {
  font-size: var(--font-size-sm);
  color: #999;
}

.locked-files-list {
  max-height: 400px;
  overflow-y: auto;
}

.locked-files-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  padding: var(--spacing-base);
  border: 1px solid #ffd591;
  border-radius: var(--radius-md);
  margin-bottom: var(--spacing-base);
  color: #d46b08;
  font-weight: 500;
}

.locked-files-header .info-icon {
  color: #d46b08;
  cursor: help;
}

/* 功能说明样式 */
.lock-feature-description {
  background-color: var(--bg-code);
  border: 1px solid #e1e4e8;
  border-radius: var(--radius-lg);
  padding: var(--spacing-base);
}

.description-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  margin-bottom: var(--spacing-base);
}

.description-icon {
  color: #1890ff;
  font-size: var(--font-size-md);
}

.description-title {
  font-weight: 600;
  color: var(--color-text-title);
  
}

.description-content {
  font-size: var(--font-size-sm);
  line-height: 1.6;
  color: var(--el-text-color-regular);
}

.description-content p {
  margin: var(--spacing-base) 0;
}

.description-content ul {
  margin: var(--spacing-sm) 0 var(--spacing-base) 0;
  padding-left: var(--spacing-base);
}

.description-content li {
  margin: var(--spacing-sm) 0;
}

.locked-file-items {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-base);
}
.locked-file-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-base);
  border: 1px solid #ffd591;
  border-radius: var(--radius-md);
  transition: all 0.2s ease;
}

/* 无上游分支提示样式 */
.upstream-tip {
  background: linear-gradient(135deg, rgba(64, 158, 255, 0.05) 0%, rgba(64, 158, 255, 0.02) 100%);
  border: 1px solid rgba(64, 158, 255, 0.2);
  border-radius: var(--radius-xl);
  padding: var(--spacing-xl);
  margin-bottom: var(--spacing-lg);
  transition: all 0.3s ease;
}

.upstream-tip:hover {
  border-color: rgba(64, 158, 255, 0.3);
  box-shadow: var(--shadow-md);
}

.upstream-tip .tip-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: var(--spacing-md);
}

.upstream-tip .tip-icon {
  font-size: var(--font-size-xl);
  color: var(--color-primary);
  flex-shrink: 0;
}

.upstream-tip .tip-title {
  
  font-weight: 600;
  color: var(--color-text-title);
  letter-spacing: 0.3px;
}

.upstream-tip .tip-body {
  padding-left: 30px;
}

.upstream-tip .tip-text {
  font-size: var(--font-size-sm);
  line-height: 1.6;
  color: var(--el-text-color-regular);
  margin-bottom: 14px;
}

.upstream-tip .tip-actions {
  display: flex;
  gap: 10px;
  align-items: center;
}

/* 深色主题适配 */
html.dark .upstream-tip {
  background: linear-gradient(135deg, rgba(64, 158, 255, 0.08) 0%, rgba(64, 158, 255, 0.03) 100%);
  border-color: rgba(64, 158, 255, 0.25);
}

html.dark .upstream-tip:hover {
  border-color: rgba(64, 158, 255, 0.35);
  box-shadow: var(--shadow-md);
}

/* 树状视图分组样式 */
.tree-group {
  margin-bottom: var(--spacing-md);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-base);
  overflow: hidden;
  background: var(--bg-container);
}

.tree-group-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-base) var(--spacing-lg);
  font-weight: var(--font-weight-semibold);
  
  cursor: pointer;
  transition: var(--transition-all);
  
  &:hover {
    background: var(--bg-hover);
  }
  
  .collapse-icon {
    transition: var(--transition-transform);
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    
    &.collapsed {
      transform: rotate(-90deg);
    }
  }
  
  h5 {
    margin: 0;
    
    font-weight: var(--font-weight-semibold);
    color: var(--text-primary);
  }
  
  .file-count {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    background: var(--bg-container);
    padding: var(--spacing-xs) var(--spacing-sm);
    border-radius: var(--radius-full);
    border: 1px solid var(--border-card);
    font-weight: var(--font-weight-medium);
  }
}

</style>

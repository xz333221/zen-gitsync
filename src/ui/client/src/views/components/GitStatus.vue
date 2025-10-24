<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref, onMounted, computed, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
// import { io } from 'socket.io-client'
import { Refresh, Document, ArrowUp, ArrowDown, Check, Close, Download, Connection, Lock, Unlock, InfoFilled } from '@element-plus/icons-vue'
// import { useGitLogStore } from '../stores/gitLogStore'
import { useGitStore } from '@stores/gitStore'
import { useConfigStore } from '@stores/configStore'
import FileDiffViewer from '@components/FileDiffViewer.vue'
import CommonDialog from '@components/CommonDialog.vue'
import FileGroup from '@/components/FileGroup.vue'
import DirectorySelector from '@components/DirectorySelector.vue'

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
const diffDialogVisible = ref(false)
const isLoadingDiff = ref(false)
// 添加当前文件索引
const currentFileIndex = ref(-1)

// 每个文件的锁定/解锁加载状态
const lockingFiles = ref<Record<string, boolean>>({})
function isLocking(filePath: string) {
  return !!lockingFiles.value[filePath]
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
  untracked: false  // 未跟踪的文件
})
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
    } else {
      // 对于未暂存的文件，获取常规差异
      const response = await fetch(`/api/diff?file=${encodeURIComponent(filePath)}`)
      const data = await response.json()
      diffContent.value = data.diff || $t('@13D1C:没有变更')
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



// 打开切换目录对话框
// function openDirectoryDialog() {
//   newDirectoryPath.value = currentDirectory.value
//   isDirectoryDialogVisible.value = true
// }

// 打开目录浏览器
// function openDirectoryBrowser() {
//   browseErrorMessage.value = ''
//   currentBrowsePath.value = newDirectoryPath.value || currentDirectory.value
//   isDirectoryBrowserVisible.value = true
//   browseDirectory(currentBrowsePath.value)
// }

// 浏览目录
// async function browseDirectory(directoryPath: string) {
//   try {
//     isBrowsing.value = true
//     browseErrorMessage.value = ''
    
//     // 确保Windows盘符路径格式正确
//     let normalizedPath = directoryPath
//     if (/^[A-Za-z]:$/.test(normalizedPath)) {
//       normalizedPath += '/'
//     }
    
//     const response = await fetch(`/api/browse_directory?path=${encodeURIComponent(normalizedPath)}`)
    
//     if (response.status === 403) {
//       const data = await response.json()
//       browseErrorMessage.value = data.error || $t('@13D1C:目录浏览功能未启用')
//       return
//     }
    
//     if (!response.ok) {
//       const data = await response.json()
//       browseErrorMessage.value = data.error || $t('@13D1C:获取目录内容失败')
//       return
//     }
    
//     const data = await response.json()
    
//     if (data.success) {
//       directoryItems.value = data.items
//       currentBrowsePath.value = data.currentPath
//     } else {
//       browseErrorMessage.value = data.error || $t('@13D1C:获取目录内容失败')
//     }
//   } catch (error) {
//     browseErrorMessage.value = `${$t('@13D1C:获取目录内容失败: ')}${(error as Error).message}`
//   } finally {
//     isBrowsing.value = false
//   }
// }

// 导航到父目录
// function navigateToParent() {
//   // 检查是否已经是根目录
//   // Windows盘符根目录情况 (如 "E:")
//   if (/^[A-Za-z]:$/.test(currentBrowsePath.value) || 
//       /^[A-Za-z]:[\\/]$/.test(currentBrowsePath.value) || 
//       currentBrowsePath.value === '/') {
//     // 已经是根目录，不做任何操作
//     return
//   }
  
//   // 获取当前路径的父目录
//   let pathParts = currentBrowsePath.value.split(/[/\\]/)
  
//   // 移除最后一个目录部分
//   pathParts.pop()
  
//   // 处理Windows盘符特殊情况
//   let parentPath = pathParts.join('/')
//   if (pathParts.length === 1 && /^[A-Za-z]:$/.test(pathParts[0])) {
//     // 如果只剩下盘符，确保添加斜杠 (例如 "E:/")
//     parentPath = pathParts[0] + '/'
//   }
  
//   if (parentPath) {
//     browseDirectory(parentPath)
//   }
// }

// // 选择目录项
// function selectDirectoryItem(item: {name: string, path: string, type: string}) {
//   if (item.type === 'directory') {
//     browseDirectory(item.path)
//   }
// }

// // 选择当前目录
// function selectCurrentDirectory() {
//   newDirectoryPath.value = currentBrowsePath.value
//   isDirectoryBrowserVisible.value = false
// }

// // 切换工作目录
// async function changeDirectory() {
//   if (!newDirectoryPath.value) {
//     ElMessage.warning($t('@13D1C:目录路径不能为空'))
//     return
//   }
  
//   try {
//     isChangingDirectory.value = true
//     const response = await fetch('/api/change_directory', {
//       method: 'POST',
//       headers: {
//         'Content-Type': 'application/json'
//       },
//       body: JSON.stringify({ path: newDirectoryPath.value })
//     })
    
//     const result = await response.json()
    
//     if (result.success) {
//       ElMessage.success($t('@13D1C:已切换工作目录'))
//       currentDirectory.value = result.directory
//       isDirectoryDialogVisible.value = false
      
//       // 直接使用API返回的Git仓库状态
//       gitStore.isGitRepo = result.isGitRepo
      
//       // 如果是Git仓库，加载Git相关数据
//       if (result.isGitRepo) {
//         // 加载Git分支和用户信息
//         await Promise.all([
//           gitStore.getCurrentBranch(),
//           gitStore.getAllBranches(),
//           gitStore.getUserInfo()
//         ])
        
//         // 刷新Git状态
//         await loadStatus()
        
//         // 刷新提交历史
//         await gitStore.fetchLog(false)
//       } else {
//         ElMessage.warning($t('@13D1C:当前目录不是一个Git仓库'))
//         // 清空Git相关状态
//         gitStore.$reset() // 使用pinia的reset方法重置状态
//       }
//     } else {
//       ElMessage.error(result.error || $t('@13D1C:切换目录失败'))
//     }
//   } catch (error) {
//     ElMessage.error(`${$t('@13D1C:切换目录失败: ')}${(error as Error).message}`)
//   } finally {
//     isChangingDirectory.value = false
//   }
// }

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
function toggleGroupCollapse(groupType: 'staged' | 'unstaged' | 'untracked') {
  collapsedGroups.value[groupType] = !collapsedGroups.value[groupType]
}

onMounted(() => {
  // App.vue已经加载了Git相关数据，此时只需加载状态
  loadStatus()
  // 加载配置和锁定文件列表
  configStore.loadConfig()
  configStore.loadLockedFiles()
})

// 监听autoUpdateEnabled的变化，手动调用toggleAutoUpdate
watch(() => gitStore.autoUpdateEnabled, (newValue, oldValue) => {
  console.log(`${$t('@13D1C:自动更新状态变更: ')}${oldValue} -> ${newValue}`)
  // 调用store中的方法来实现服务器通信功能
  gitStore.toggleAutoUpdate()
}, { immediate: false })

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
      <DirectorySelector />
      
      <div class="title-row">
        <h2>Git {{ $t('@13D1C:状态') }}</h2>
        <div class="header-actions">
          <el-tooltip 
            :content="gitStore.autoUpdateEnabled ? $t('@13D1C:自动更新文件状态') : $t('@13D1C:自动更新文件状态')" 
            placement="top" 
            
            :show-after="200"
          >
            <el-switch 
              v-model="gitStore.autoUpdateEnabled" 
              style="--el-switch-on-color: #67C23A; --el-switch-off-color: #909399; margin-right: 4px;"
              inline-prompt
              :active-icon="Check"
              :inactive-icon="Close"
              class="auto-update-switch"
            />
          </el-tooltip>
        
        <!-- 添加Git Pull按钮 -->
        <el-tooltip :content="$t('@13D1C:Git Pull (拉取远程更新)')" placement="top"  :show-after="200">
          <el-button 
            type="primary" 
            :icon="Download" 
            circle 
            size="small" 
            @click="handleGitPull" 
            :loading="gitStore.isGitPulling"
            :disabled="!gitStore.hasUpstream"
          />
        </el-tooltip>
        
        <!-- 添加Git Fetch All按钮 -->
        <el-tooltip :content="$t('@13D1C:Git Fetch All (获取所有远程分支)')" placement="top"  :show-after="200">
          <el-button 
            v-show="false"
            type="primary" 
            :icon="Connection" 
            circle 
            size="small" 
            @click="handleGitFetchAll" 
            :loading="gitStore.isGitFetching"
          />
        </el-tooltip>

        <!-- 锁定文件管理按钮 -->
        <el-tooltip
          v-if="configStore.lockedFiles.length > 0"
          :content="$t('@13D1C:管理锁定文件')"
          placement="top"
          
          :show-after="200"
        >
          <el-button
            type="warning"
            circle
            size="small"
            @click="showLockedFilesDialog = true"
          >
            <el-icon><Lock /></el-icon>
          </el-button>
        </el-tooltip>

        <el-tooltip :content="$t('@13D1C:刷新状态')" placement="top"  :show-after="200">
          <el-button
            type="primary"
            :icon="Refresh"
            circle
            size="small"
            @click="refreshStatus"
            :loading="isRefreshing"
          />
        </el-tooltip>
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
        <div v-if="gitStore.fileList.length" class="file-list-container">
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
          />
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
      :selectedFile="selectedFile"
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
            <el-tooltip :content="$t('@13D1C:解锁文件')" placement="top" >
              <el-button
                type="danger"
                size="small"
                circle
                class="file-action-btn"
                :icon="Unlock"
                :aria-label="$t('@13D1C:解锁')"
                @click="confirmUnlockFile(filePath)"
              />
            </el-tooltip>
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
  gap: 8px;
  margin-left: auto;
}

.card-content {
  padding: 8px;
  overflow-y: auto;
  overflow-x: hidden;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.status-box {
  white-space: pre-wrap;
  font-family: monospace;
  padding: 8px;
  border-radius: 8px;
  margin-bottom: 8px;
  max-height: 200px;
  overflow-y: auto;
  overflow-x: hidden;
  border: 1px solid var(--border-card);
  font-size: 14px;
  line-height: 1.5;
  width: 100%;
  box-sizing: border-box;
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
  border-radius: 4px;
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
  border-radius: 8px;
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
  margin-bottom: 8px;
  font-size: 28px;
  color: #909399;
  animation: pulse 2s infinite ease-in-out;
}

@keyframes pulse {
  0% { transform: scale(1); opacity: 0.7; }
  50% { transform: scale(1.05); opacity: 1; }
  100% { transform: scale(1); opacity: 0.7; }
}

.empty-text {
  font-size: 18px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.empty-subtext {
  font-size: 14px;
  color: #909399;
  margin-bottom: 8px;
}

.status-box-wrap {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 分支信息样式 */
.branch-status-info {
  margin-bottom: 0;
  background-color: var(--bg-container);
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border-card);
  transition: all 0.3s ease;
}

.branch-status-info:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
}

.branch-sync-status {
  display: flex;
  align-items: center;
  padding: 8px;
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
  gap: 8px;
  width: 100%;
}

.status-badge {
  display: flex;
  align-items: center;
  width: 100%;
  border-radius: 4px;
  padding: 8px;
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
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
}

.badge-content {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

/* 差异对话框样式 */
.diff-dialog {
  height: calc(100vh - 150px);
}

.use-flex-body .el-dialog__body {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 8px;
}

/* 增加自动更新开关的样式 */
.auto-update-switch :deep(.el-switch__core) {
  transition: all 0.3s ease-in-out;
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);
}

.auto-update-switch :deep(.el-switch__core:hover) {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.auto-update-switch.is-checked :deep(.el-switch__core) {
  box-shadow: 0 2px 5px rgba(103, 194, 58, 0.3);
}

.auto-update-switch.is-checked :deep(.el-switch__core:hover) {
  box-shadow: 0 2px 8px rgba(103, 194, 58, 0.5);
}

/* 按钮悬停效果 */
.el-button {
  transition: all 0.3s ease;
}

.el-button:not(:disabled):hover {
  transform: translateY(-2px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
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
  font-size: 16px;
  color: #409EFF;
  font-weight: bold;
  margin-top: 8px;
}



/* 锁定文件对话框样式 */
.empty-locked-files {
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  padding: 8px;
  color: #666;
}

.empty-locked-files .empty-icon {
  font-size: 48px;
  color: #d9d9d9;
  margin-bottom: 8px;
}

.empty-locked-files p {
  margin: 8px 0;
}

.empty-tip {
  font-size: 12px;
  color: #999;
}

.locked-files-list {
  max-height: 400px;
  overflow-y: auto;
}

.locked-files-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border: 1px solid #ffd591;
  border-radius: 6px;
  margin-bottom: 8px;
  color: #d46b08;
  font-weight: 500;
}

.locked-files-header .info-icon {
  color: #d46b08;
  cursor: help;
}

/* 功能说明样式 */
.lock-feature-description {
  background-color: #f6f8fa;
  border: 1px solid #e1e4e8;
  border-radius: 8px;
  padding: 8px;
}

.description-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.description-icon {
  color: #1890ff;
  font-size: 16px;
}

.description-title {
  font-weight: 600;
  color: var(--color-text-title);
  font-size: 14px;
}

.description-content {
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
}

.description-content p {
  margin: 8px 0;
}

.description-content ul {
  margin: 4px 0 8px 0;
  padding-left: 8px;
}

.description-content li {
  margin: 4px 0;
}

.locked-file-items {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.locked-file-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px;
  border: 1px solid #ffd591;
  border-radius: 6px;
  transition: all 0.2s ease;
}

/* 无上游分支提示样式 */
.upstream-tip {
  background: linear-gradient(135deg, rgba(64, 158, 255, 0.05) 0%, rgba(64, 158, 255, 0.02) 100%);
  border: 1px solid rgba(64, 158, 255, 0.2);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 16px;
  transition: all 0.3s ease;
}

.upstream-tip:hover {
  border-color: rgba(64, 158, 255, 0.3);
  box-shadow: 0 2px 12px rgba(64, 158, 255, 0.1);
}

.upstream-tip .tip-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.upstream-tip .tip-icon {
  font-size: 20px;
  color: #409eff;
  flex-shrink: 0;
}

.upstream-tip .tip-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text-title);
  letter-spacing: 0.3px;
}

.upstream-tip .tip-body {
  padding-left: 30px;
}

.upstream-tip .tip-text {
  font-size: 13px;
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
  box-shadow: 0 2px 12px rgba(64, 158, 255, 0.15);
}

</style>

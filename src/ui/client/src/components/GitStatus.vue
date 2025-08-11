<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
// import { io } from 'socket.io-client'
import { Refresh, ArrowLeft, ArrowRight, Document, ArrowUp, ArrowDown, RefreshRight, Check, Close, Download, Connection, Lock, Unlock, InfoFilled } from '@element-plus/icons-vue'
// import { useGitLogStore } from '../stores/gitLogStore'
import { useGitStore } from '../stores/gitStore'
import { useConfigStore } from '../stores/configStore'

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
// const status = ref('加载中...')
// const socket = io()
const isRefreshing = computed(() => gitStore.isLoadingStatus)
// 移除本地fileList定义，改用store中的fileList
const selectedFile = ref('')
const diffContent = ref('')
const diffDialogVisible = ref(false)
const isLoadingDiff = ref(false)
// 添加当前文件索引
const currentFileIndex = ref(-1)
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
      currentDirectory.value = dirData.directory || '未知目录'
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
      message: 'Git 状态已刷新',
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
      '确认解锁',
      {
        type: 'warning',
        confirmButtonText: '解锁',
        cancelButtonText: '取消',
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
      `确认解锁所有已锁定文件？共 ${configStore.lockedFiles.length} 个。`,
      '清空全部锁定',
      {
        type: 'warning',
        confirmButtonText: '全部解锁',
        cancelButtonText: '取消',
      }
    )
    // 复制数组，防止过程中列表变化
    const files = [...configStore.lockedFiles]
    await Promise.all(files.map(f => configStore.unlockFile(f)))
    await configStore.loadLockedFiles()
    ElMessage.success('已清空所有文件锁定')
  } catch (e) {
    // 用户取消
  }
}

// 格式化差异内容，添加颜色
function formatDiff(diffText: string) {
  if (!diffText) return '';
  
  // 将差异内容按行分割
  const lines = diffText.split('\n');
  
  // 转义 HTML 标签的函数
  function escapeHtml(text: string) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
  
  // 为每行添加适当的 CSS 类
  return lines.map(line => {
    // 先转义 HTML 标签，再添加样式
    const escapedLine = escapeHtml(line);
    
    if (line.startsWith('diff --git')) {
      return `<div class="diff-header">${escapedLine}</div>`;
    } else if (line.startsWith('---')) {
      return `<div class="diff-old-file">${escapedLine}</div>`;
    } else if (line.startsWith('+++')) {
      return `<div class="diff-new-file">${escapedLine}</div>`;
    } else if (line.startsWith('@@')) {
      return `<div class="diff-hunk-header">${escapedLine}</div>`;
    } else if (line.startsWith('+')) {
      return `<div class="diff-added">${escapedLine}</div>`;
    } else if (line.startsWith('-')) {
      return `<div class="diff-removed">${escapedLine}</div>`;
    } else {
      return `<div class="diff-context">${escapedLine}</div>`;
    }
  }).join('');
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
            `新文件: ${filePath}\n` +
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
      
      diffDialogVisible.value = true
    } else if (currentFile && currentFile.type === 'added') {
      // 对于已暂存的文件，使用 diff --cached 获取差异
      const response = await fetch(`/api/diff-cached?file=${encodeURIComponent(filePath)}`)
      const data = await response.json()
      diffContent.value = data.diff || '没有变更'
      diffDialogVisible.value = true
    } else {
      // 对于未暂存的文件，获取常规差异
      const response = await fetch(`/api/diff?file=${encodeURIComponent(filePath)}`)
      const data = await response.json()
      diffContent.value = data.diff || '没有变更'
      diffDialogVisible.value = true
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

// 添加切换到上一个文件的方法
async function goToPreviousFile() {
  if (gitStore.fileList.length === 0 || currentFileIndex.value <= 0) return
  
  const newIndex = currentFileIndex.value - 1
  const prevFile = gitStore.fileList[newIndex]
  await getFileDiff(prevFile.path)
}

// 添加切换到下一个文件的方法
async function goToNextFile() {
  if (gitStore.fileList.length === 0 || currentFileIndex.value >= gitStore.fileList.length - 1) return
  
  const newIndex = currentFileIndex.value + 1
  const nextFile = gitStore.fileList[newIndex]
  await getFileDiff(nextFile.path)
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
//       browseErrorMessage.value = data.error || '目录浏览功能未启用'
//       return
//     }
    
//     if (!response.ok) {
//       const data = await response.json()
//       browseErrorMessage.value = data.error || '获取目录内容失败'
//       return
//     }
    
//     const data = await response.json()
    
//     if (data.success) {
//       directoryItems.value = data.items
//       currentBrowsePath.value = data.currentPath
//     } else {
//       browseErrorMessage.value = data.error || '获取目录内容失败'
//     }
//   } catch (error) {
//     browseErrorMessage.value = `获取目录内容失败: ${(error as Error).message}`
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
//     ElMessage.warning('目录路径不能为空')
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
//       ElMessage.success('已切换工作目录')
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
//         ElMessage.warning('当前目录不是一个Git仓库')
//         // 清空Git相关状态
//         gitStore.$reset() // 使用pinia的reset方法重置状态
//       }
//     } else {
//       ElMessage.error(result.error || '切换目录失败')
//     }
//   } catch (error) {
//     ElMessage.error(`切换目录失败: ${(error as Error).message}`)
//   } finally {
//     isChangingDirectory.value = false
//   }
// }

// 处理文件点击
function handleFileClick(file: {path: string, type: string}) {
  getFileDiff(file.path)
}

// 暂存单个文件
async function stageFile(filePath: string) {
  await gitStore.addFileToStage(filePath)
}

// 取消暂存单个文件
async function unstageFile(filePath: string) {
  await gitStore.unstageFile(filePath)
}

// 刷新Git状态的方法（优化版本）
async function refreshStatus() {
  await loadStatusOptimized()
}

// 优化的状态加载方法 - 只刷新文件状态，不刷新分支状态
async function loadStatusOptimized() {
  try {
    // 如果不是Git仓库，直接显示提示并返回
    if (!gitStore.isGitRepo) {
      return
    }

    // 只获取文件状态，不获取分支状态（分支状态变化频率低）
    await gitStore.fetchStatus()

    ElMessage({
      message: 'Git 文件状态已刷新',
      type: 'success',
    })
  } catch (error) {
    ElMessage({
      message: '刷新失败: ' + (error as Error).message,
      type: 'error',
    })
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

// 添加撤回文件修改的方法
async function revertFileChanges(filePath: string) {
  try {
    // 请求用户确认
    await ElMessageBox.confirm(
      `确定要撤回文件 "${filePath}" 的所有修改吗？此操作无法撤销。`,
      '撤回修改',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
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
      ElMessage.success('已撤回文件修改')
      // 刷新Git状态
      await loadStatus()
    } else {
      // 使用自定义错误信息，避免显示undefined
      ElMessage.error(result.error ? `撤回失败: ${result.error}` : '撤回文件修改失败，请重试')
    }
  } catch (error) {
    // 用户取消操作不显示错误
    if ((error as any) === 'cancel' || (error as Error).message === 'cancel') {
      // 用户取消操作，不做任何处理，也不显示错误
      return
    }
    
    // 其他错误情况才显示错误消息
    // 避免显示undefined错误信息
    const errorMessage = (error as Error).message || '未知错误';
    if (errorMessage !== 'undefined') {
      ElMessage.error(`撤回文件修改失败: ${errorMessage}`)
    } else {
      ElMessage.error('撤回文件修改失败，请重试')
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

  // 添加调试信息
  if (filePath === 'test/2.txt' || filePath === '2.txt') {
    console.log('检查文件锁定状态:', {
      filePath,
      normalizedPath,
      lockedFiles: configStore.lockedFiles,
      normalizedLockedFiles: configStore.lockedFiles.map(f => f.replace(/\\/g, '/')),
      isLocked
    })
  }
  return isLocked
}

// 切换文件锁定状态
function toggleFileLock(filePath: string) {
  const isLocked = isFileLocked(filePath)
  if (isLocked) {
    configStore.unlockFile(filePath)
  } else {
    configStore.lockFile(filePath)
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
  console.log(`自动更新状态变更: ${oldValue} -> ${newValue}`)
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
  <div class="card">
    <div class="status-header">
      <h2>Git 状态</h2>
      <div class="header-actions">
        <el-tooltip 
          :content="gitStore.autoUpdateEnabled ? '禁用自动更新文件状态' : '启用自动更新文件状态'" 
          placement="top" 
          :hide-after="1000"
        >
          <el-switch 
            v-model="gitStore.autoUpdateEnabled" 
            style="--el-switch-on-color: #67C23A; --el-switch-off-color: #909399; margin-right: 10px;"
            inline-prompt
            :active-icon="Check"
            :inactive-icon="Close"
            class="auto-update-switch"
          />
        </el-tooltip>
        
        <!-- 添加Git Pull按钮 -->
        <el-tooltip content="Git Pull (拉取远程更新)" placement="top" :hide-after="1000">
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
        <el-tooltip content="Git Fetch All (获取所有远程分支)" placement="top" :hide-after="1000">
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
          content="管理锁定文件"
          placement="top"
          :hide-after="1000"
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

        <el-tooltip content="刷新状态" placement="top" :hide-after="1000">
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
    
    <div class="card-content" 
      v-loading="gitStore.isGitPulling || gitStore.isGitFetching" 
      :element-loading-text="gitStore.isGitPulling ? '正在拉取代码...' : '正在获取远程分支信息...'"
    >
      <div v-if="!gitStore.isGitRepo" class="status-box">
        <div class="empty-status">
          <p>当前目录不是Git仓库</p>
        </div>
      </div>
      
      <div class="status-box-wrap" v-else>
        <!-- 分支信息仅在有领先/落后状态时才显示 -->
        <div v-if="gitStore.hasUpstream && (gitStore.branchAhead > 0 || gitStore.branchBehind > 0)" class="branch-status-info">
          <!-- 分支同步状态信息 -->
          <div class="branch-sync-status">
            <div class="sync-status-content">
              <el-tooltip content="本地分支与远程分支的状态对比" placement="top">
                <div class="status-badges">
                  <el-tag v-if="gitStore.branchAhead > 0" size="small" type="warning" class="status-badge">
                    <template #default>
                      <span class="badge-content">
                        <el-icon><ArrowUp /></el-icon> 你的分支领先 'origin/{{ gitStore.currentBranch }}' {{ gitStore.branchAhead }} 个提交
                      </span>
                    </template>
                  </el-tag>
                  <el-tag v-if="gitStore.branchBehind > 0" size="small" type="info" class="status-badge">
                    <template #default>
                      <span class="badge-content">
                        <el-icon><ArrowDown /></el-icon> 你的分支落后 'origin/{{ gitStore.currentBranch }}' {{ gitStore.branchBehind }} 个提交
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
          <!-- 分组显示文件 -->
          <div v-if="gitStore.fileList.some(f => f.type === 'added')" class="file-group">
            <div class="file-group-header" @click="toggleGroupCollapse('staged')">
              <el-icon class="collapse-icon" :class="{ 'collapsed': collapsedGroups.staged }">
                <ArrowDown />
              </el-icon>
              <span>已暂存的更改</span>
            </div>
            <div v-show="!collapsedGroups.staged" class="file-list">
              <div
                v-for="file in gitStore.fileList.filter(f => f.type === 'added')"
                :key="file.path"
                class="file-item"
                @click="handleFileClick(file)"
              >
                <div class="file-info">
                  <div class="file-status-indicator" :class="['added', { 'locked': isFileLocked(file.path) }]"></div>
                  <div class="file-name-section">
                    <span class="file-name" :class="{ 'locked-file-name': isFileLocked(file.path) }">
                      {{ getFileName(file.path) }}
                      <el-icon v-if="isFileLocked(file.path)" class="lock-indicator">
                        <Lock />
                      </el-icon>
                    </span>
                  </div>
                  <div class="file-path-section" :title="getFileDirectory(file.path)">
                    <span class="file-directory">{{ getFileDirectory(file.path) }}</span>
                  </div>
                </div>
                <div class="file-actions">
                  <el-tooltip :content="isFileLocked(file.path) ? '解锁文件' : '锁定文件'" placement="top" :hide-after="1000">
                    <el-button
                      :type="isFileLocked(file.path) ? 'danger' : 'info'"
                      size="small"
                      circle
                      @click.stop="toggleFileLock(file.path)"
                      class="file-action-btn"
                    >
                      <el-icon size="12">
                        <component :is="isFileLocked(file.path) ? Lock : Unlock" />
                      </el-icon>
                    </el-button>
                  </el-tooltip>
                  <el-tooltip content="取消暂存" placement="top" :hide-after="1000">
                    <el-button
                      type="warning"
                      size="small"
                      circle
                      @click.stop="unstageFile(file.path)"
                      class="file-action-btn"
                    >-</el-button>
                  </el-tooltip>
                </div>
              </div>
            </div>
          </div>
          
          <div v-if="gitStore.fileList.some(f => f.type === 'modified' || f.type === 'deleted')" class="file-group">
            <div class="file-group-header" @click="toggleGroupCollapse('unstaged')">
              <el-icon class="collapse-icon" :class="{ 'collapsed': collapsedGroups.unstaged }">
                <ArrowDown />
              </el-icon>
              <span>未暂存的更改</span>
            </div>
            <div v-show="!collapsedGroups.unstaged" class="file-list">
              <div
                v-for="file in gitStore.fileList.filter(f => f.type === 'modified' || f.type === 'deleted')"
                :key="file.path"
                class="file-item"
                @click="handleFileClick(file)"
              >
                <div class="file-info">
                  <div class="file-status-indicator" :class="[file.type, { 'locked': isFileLocked(file.path) }]"></div>
                  <div class="file-name-section">
                    <span class="file-name" :class="{ 'locked-file-name': isFileLocked(file.path) }">
                      {{ getFileName(file.path) }}
                      <el-icon v-if="isFileLocked(file.path)" class="lock-indicator">
                        <Lock />
                      </el-icon>
                    </span>
                  </div>
                  <div class="file-path-section" :title="getFileDirectory(file.path)">
                    <span class="file-directory">{{ getFileDirectory(file.path) }}</span>
                  </div>
                </div>
                <div class="file-actions">
                  <el-tooltip :content="isFileLocked(file.path) ? '解锁文件' : '锁定文件'" placement="top" :hide-after="1000">
                    <el-button
                      :type="isFileLocked(file.path) ? 'danger' : 'info'"
                      size="small"
                      circle
                      @click.stop="toggleFileLock(file.path)"
                      class="file-action-btn"
                    >
                      <el-icon size="12">
                        <component :is="isFileLocked(file.path) ? Lock : Unlock" />
                      </el-icon>
                    </el-button>
                  </el-tooltip>
                  <el-tooltip content="添加到暂存区" placement="top" :hide-after="1000">
                    <el-button
                      type="success"
                      size="small"
                      circle
                      @click.stop="stageFile(file.path)"
                      class="file-action-btn"
                    >+</el-button>
                  </el-tooltip>
                  <el-tooltip content="撤回修改" placement="top" :hide-after="1000">
                    <el-button
                      type="danger"
                      size="small"
                      :icon="RefreshRight"
                      circle
                      @click.stop="revertFileChanges(file.path)"
                      class="file-action-btn"
                    />
                  </el-tooltip>
                </div>
              </div>
            </div>
          </div>
          
          <div v-if="gitStore.fileList.some(f => f.type === 'untracked')" class="file-group">
            <div class="file-group-header" @click="toggleGroupCollapse('untracked')">
              <el-icon class="collapse-icon" :class="{ 'collapsed': collapsedGroups.untracked }">
                <ArrowDown />
              </el-icon>
              <span>未跟踪的文件</span>
            </div>
            <div v-show="!collapsedGroups.untracked" class="file-list">
              <div
                v-for="file in gitStore.fileList.filter(f => f.type === 'untracked')"
                :key="file.path"
                class="file-item"
                @click="handleFileClick(file)"
              >
                <div class="file-info">
                  <div class="file-status-indicator" :class="['untracked', { 'locked': isFileLocked(file.path) }]"></div>
                  <div class="file-name-section">
                    <span class="file-name" :class="{ 'locked-file-name': isFileLocked(file.path) }">
                      {{ getFileName(file.path) }}
                      <el-icon v-if="isFileLocked(file.path)" class="lock-indicator">
                        <Lock />
                      </el-icon>
                    </span>
                  </div>
                  <div class="file-path-section" :title="getFileDirectory(file.path)">
                    <span class="file-directory">{{ getFileDirectory(file.path) }}</span>
                  </div>
                </div>
                <div class="file-actions">
                  <el-tooltip :content="isFileLocked(file.path) ? '解锁文件' : '锁定文件'" placement="top" :hide-after="1000">
                    <el-button
                      :type="isFileLocked(file.path) ? 'danger' : 'info'"
                      size="small"
                      circle
                      @click.stop="toggleFileLock(file.path)"
                      class="file-action-btn"
                    >
                      <el-icon size="12">
                        <component :is="isFileLocked(file.path) ? Lock : Unlock" />
                      </el-icon>
                    </el-button>
                  </el-tooltip>
                  <el-tooltip content="添加到暂存区" placement="top" :hide-after="1000">
                    <el-button
                      type="success"
                      size="small"
                      circle
                      @click.stop="stageFile(file.path)"
                      class="file-action-btn"
                    >+</el-button>
                  </el-tooltip>
                  <el-tooltip content="删除文件" placement="top" :hide-after="1000">
                    <el-button
                      type="danger"
                      size="small"
                      :icon="Close"
                      circle
                      @click.stop="revertFileChanges(file.path)"
                      class="file-action-btn"
                    />
                  </el-tooltip>
                </div>
              </div>
            </div>
          </div>
        </div>



        <div v-else-if="gitStore.isGitRepo" class="empty-status">
          <div class="empty-icon">
            <el-icon><Document /></el-icon>
          </div>
          <div class="empty-text">没有检测到任何更改</div>
          <div class="empty-subtext">工作区是干净的</div>
        </div>
      </div>
    </div>
  </div>
  
  <!-- 文件差异对话框 -->
  <el-dialog
    v-model="diffDialogVisible"
    :title="`文件差异: ${selectedFile}`"
    width="80%"
    destroy-on-close
    class="diff-dialog"
  >
    <div v-loading="isLoadingDiff" class="diff-content">
      <div v-if="diffContent" v-html="formatDiff(diffContent)" class="diff-formatted"></div>
      <div v-else class="no-diff">该文件没有差异或是新文件</div>
    </div>
    
    <template #footer>
      <div class="file-navigation">
        <el-button 
          type="primary"
          :icon="ArrowLeft" 
          @click="goToPreviousFile" 
          :disabled="currentFileIndex <= 0 || gitStore.fileList.length === 0"
          plain
          class="nav-button"
        >
          上一个文件
        </el-button>
        
        <div class="file-counter">
          <el-tag type="info" effect="plain" class="counter-tag">
            {{ currentFileIndex + 1 }} / {{ gitStore.fileList.length }}
          </el-tag>
        </div>
        
        <el-button 
          type="primary"
          :icon="ArrowRight" 
          @click="goToNextFile" 
          :disabled="currentFileIndex >= gitStore.fileList.length - 1 || gitStore.fileList.length === 0"
          plain
          class="nav-button"
        >
          下一个文件
          <template #icon>
            <el-icon class="el-icon--right"><ArrowRight /></el-icon>
          </template>
        </el-button>
      </div>
    </template>
  </el-dialog>

  <!-- 锁定文件管理对话框 -->
  <el-dialog
    v-model="showLockedFilesDialog"
    title="锁定文件管理"
    width="700px"
    destroy-on-close
  >
    <!-- 功能说明 -->
    <div class="lock-feature-description">
      <div class="description-header">
        <el-icon class="description-icon"><InfoFilled /></el-icon>
        <span class="description-title">文件锁定功能说明</span>
      </div>
      <div class="description-content">
        <p><strong>🔒 锁定文件的作用：</strong></p>
        <ul>
          <li>锁定的文件在执行 Git 提交时会被自动跳过，不会被添加到暂存区</li>
          <li>适用于临时文件、配置文件、或不想提交的开发中文件</li>
          <li>锁定状态会持久保存，直到手动解锁</li>
        </ul>
        <p><strong>💡 使用场景：</strong></p>
        <ul>
          <li>开发过程中的临时测试文件</li>
          <li>本地配置文件（如数据库连接、API密钥等）</li>
          <li>正在开发但还不想提交的功能文件</li>
        </ul>
      </div>
    </div>

    <el-divider />

    <div v-if="configStore.lockedFiles.length === 0" class="empty-locked-files">
      <div class="empty-icon">
        <el-icon><Lock /></el-icon>
      </div>
      <p>当前没有锁定的文件</p>
      <p class="empty-tip">您可以在文件列表中点击锁定按钮来锁定文件</p>
    </div>

    <div v-else class="locked-files-list">
      <div class="locked-files-header">
        <span>🔒 已锁定 {{ configStore.lockedFiles.length }} 个文件</span>
        <el-tooltip content="这些文件在提交时会被自动跳过" placement="top">
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
          清空全部锁定
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
            <el-tooltip content="解锁文件" placement="top" :hide-after="1000">
              <el-button
                type="danger"
                size="small"
                circle
                class="file-action-btn"
                :icon="Unlock"
                aria-label="解锁"
                @click="confirmUnlockFile(filePath)"
              />
            </el-tooltip>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <span class="dialog-footer">
        <el-button @click="showLockedFilesDialog = false">关闭</el-button>
      </span>
    </template>
  </el-dialog>
</template>

<style scoped>
.card {
  background-color: #fff;
  border-radius: 12px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.04);
  border: 1px solid rgba(0, 0, 0, 0.03);
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: all 0.3s ease;
  position: relative;
}

.status-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #f0f0f0;
}

.status-header h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 500;
  color: #303133;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
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
  background-color: #f8f9fa;
  padding: 16px;
  border-radius: 8px;
  margin-bottom: 20px;
  max-height: 200px;
  overflow-y: auto;
  overflow-x: hidden;
  border: 1px solid #f0f0f0;
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

.file-group {
  background-color: #f8f9fa;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #ebeef5;
  margin-bottom: 4px;
  display: flex;
  flex-direction: column;
  transition: box-shadow 0.3s ease;
}

.file-group:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
}

/* 最后一个分组可以吸收剩余空间 */
.file-group:last-child {
  margin-bottom: 0;
  flex: 1 1 auto;
}

.file-group-header {
  font-size: 12px;
  font-weight: 600;
  padding: 6px 12px;
  background-color: #f0f2f5;
  color: #606266;
  border-bottom: 1px solid #ebeef5;
  flex-shrink: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: background-color 0.2s ease;
  user-select: none;
  min-height: 28px;
}

.file-group-header:hover {
  background-color: #e9ecef;
}

.collapse-icon {
  transition: transform 0.2s ease;
  font-size: 14px;
  color: #6c757d;
}

.collapse-icon.collapsed {
  transform: rotate(-90deg);
}

.file-list {
  overflow-y: visible;
  min-height: 30px;
  max-height: none;
  flex-grow: 1;
  padding: 0;
  margin: 0;
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

.file-list:empty {
  display: none;
}

.empty-file-container {
  overflow-y: hidden !important;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  flex: 1;
}

.empty-file-group {
  padding: 16px;
  text-align: center;
  color: #909399;
  font-size: 13px;
  font-style: italic;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 50px;
  background-color: #f8f9fa;
  border-radius: 4px;
  margin: 8px;
}

.file-item {
  padding: 6px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #ebeef5;
  cursor: pointer;
  transition: all 0.2s ease;
  min-height: 32px;
}

.file-item:last-child {
  border-bottom: none;
}

.file-item:hover {
  background-color: #ecf5ff;
}

.file-info {
  display: flex;
  align-items: center;
  flex-grow: 1;
  overflow: hidden;
  gap: 8px;
}

.file-status-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: #409eff;
  flex-shrink: 0;
}

.file-status-indicator.added {
  background-color: #67c23a;
}

.file-status-indicator.modified {
  background-color: #409eff;
}

.file-status-indicator.deleted {
  background-color: #f56c6c;
}

.file-status-indicator.untracked {
  background-color: #e6a23c;
}

.file-name-section {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 8px;
}

.file-path-section {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  max-width: 200px;
}

.file-name {
  font-weight: 500;
  color: #303133;
  flex-shrink: 0;
  line-height: 1.3;
  font-size: 13px;
}

.file-directory {
  font-size: 11px;
  color: #909399;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.file-actions {
  display: flex;
  opacity: 0;
  transition: opacity 0.2s ease;
  gap: 8px;
}

.file-item:hover .file-actions {
  opacity: 1;
}

.file-action-btn {
  width: 26px !important;
  height: 26px !important;
  min-width: 26px !important;
  padding: 0 !important;
  font-size: 16px !important; /* controls icon size */
  display: inline-flex !important;
  align-items: center;
  justify-content: center;
}

.empty-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  text-align: center;
  background-color: #f9f9f9;
  border-radius: 8px;
  flex-grow: 1;
}

.empty-icon {
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: #f0f2f5;
  border-radius: 50%;
  margin-bottom: 16px;
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
  color: #606266;
  margin-bottom: 8px;
}

.empty-subtext {
  font-size: 14px;
  color: #909399;
  margin-bottom: 20px;
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
  background-color: #f8f9fa;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #ebeef5;
  transition: all 0.3s ease;
}

.branch-status-info:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
}

.branch-sync-status {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  border-left: 3px solid #e6a23c;
  margin-bottom: 0;
  background-color: #fdf6ec;
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
  padding: 8px 12px;
  transition: all 0.3s ease;
}

.status-badge.el-tag--warning {
  background-color: #fdf6ec;
  border-color: #faecd8;
}

.status-badge.el-tag--info {
  background-color: #f4f4f5;
  border-color: #e9e9eb;
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

:deep(.el-dialog__body) {
  height: calc(100vh - 320px);
  overflow: auto;
  padding: 0;
}

.diff-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  background-color: #fafafa;
  height: 100%;
}

.diff-formatted {
  font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', 'Courier New', monospace;
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  padding-bottom: 20px;
}

.no-diff {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #909399;
  font-size: 14px;
}

.file-navigation {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 20px;
  border-top: 1px solid #ebeef5;
  background-color: #f9f9fb;
}

.counter-tag {
  font-family: monospace;
  font-size: 14px;
  padding: 6px 12px;
  min-width: 80px;
  text-align: center;
}

.nav-button {
  min-width: 120px;
  transition: all 0.3s ease;
}

.nav-button:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

/* 确保文件差异对话框里的内容滚动条样式一致 */
.diff-formatted::-webkit-scrollbar,
.diff-content::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.diff-formatted::-webkit-scrollbar-thumb,
.diff-content::-webkit-scrollbar-thumb {
  background-color: rgba(144, 147, 153, 0.3);
  border-radius: 4px;
}

.diff-formatted::-webkit-scrollbar-thumb:hover,
.diff-content::-webkit-scrollbar-thumb:hover {
  background-color: rgba(144, 147, 153, 0.5);
}

.diff-formatted::-webkit-scrollbar-track,
.diff-content::-webkit-scrollbar-track {
  background-color: transparent;
}

/* 兼容Firefox滚动条样式 */
.diff-formatted,
.diff-content {
  scrollbar-width: thin;
  scrollbar-color: rgba(144, 147, 153, 0.3) transparent;
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
  margin-top: 10px;
}
</style>

<!-- 非scoped样式，使diff格式化样式对动态内容生效 -->
<style>
.diff-header {
  font-weight: bold;
  background-color: #e6f1fc;
  padding: 8px 12px;
  margin: 10px 0;
  border-radius: 6px;
  color: #0366d6;
  border-bottom: 1px solid #c8e1ff;
}

.diff-old-file, .diff-new-file {
  color: #586069;
  padding: 4px 8px;
  font-family: monospace;
}

.diff-old-file {
  color: #cb2431;
}

.diff-new-file {
  color: #22863a;
}

.diff-hunk-header {
  color: #6f42c1;
  background-color: #f1f8ff;
  padding: 4px 8px;
  margin: 8px 0;
  border-radius: 4px;
  font-family: monospace;
}

.diff-added {
  background-color: #e6ffed;
  color: #22863a;
  padding: 2px 8px;
  border-left: 4px solid #22863a;
  font-family: monospace;
  display: block;
  margin: 2px 0;
}

.diff-removed {
  background-color: #ffeef0;
  color: #cb2431;
  padding: 2px 8px;
  border-left: 4px solid #cb2431;
  font-family: monospace;
  display: block;
  margin: 2px 0;
}

.diff-context {
  color: #444;
  padding: 2px 8px;
  font-family: monospace;
  display: block;
  margin: 2px 0;
  background-color: #fafbfc;
}

/* 锁定文件样式 */
.locked-files-group {
  background-color: #fff7e6;
  border: 1px solid #ffd591;
}

.locked-files-group .file-group-header {
  background-color: #fff2e8;
  color: #d46b08;
  display: flex;
  align-items: center;
  gap: 8px;
}

.locked-files-group .info-icon {
  color: #d46b08;
  cursor: help;
}

.locked-file-item {
  background-color: #fffbf0;
  border-left: 3px solid #ffa940;
}

.locked-file-item:hover {
  background-color: #fff7e6;
}

.file-status-indicator.locked {
  background-color: #ffa940;
  border-radius: 50%;
  position: relative;
}

.file-status-indicator.locked::before {
  content: '🔒';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 8px;
}

/* 锁定文件名样式 */
.locked-file-name {
  color: #d46b08 !important;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 4px;
}

.lock-indicator {
  color: #d46b08;
  font-size: 12px;
  opacity: 0.8;
}

/* 为锁定的文件状态指示器添加特殊样式 */
.file-status-indicator.modified.locked {
  background: linear-gradient(45deg, #1890ff 50%, #ffa940 50%);
}

.file-status-indicator.untracked.locked {
  background: linear-gradient(45deg, #52c41a 50%, #ffa940 50%);
}

.file-status-indicator.added.locked {
  background: linear-gradient(45deg, #52c41a 50%, #ffa940 50%);
}

.file-status-indicator.deleted.locked {
  background: linear-gradient(45deg, #ff4d4f 50%, #ffa940 50%);
}

/* 锁定文件对话框样式 */
.empty-locked-files {
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  padding: 40px 20px;
  color: #666;
}

.empty-locked-files .empty-icon {
  font-size: 48px;
  color: #d9d9d9;
  margin-bottom: 16px;
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
  padding: 12px 16px;
  background-color: #fff7e6;
  border: 1px solid #ffd591;
  border-radius: 6px;
  margin-bottom: 16px;
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
  padding: 16px;
  margin-bottom: 16px;
}

.description-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.description-icon {
  color: #1890ff;
  font-size: 16px;
}

.description-title {
  font-weight: 600;
  color: #262626;
  font-size: 14px;
}

.description-content {
  font-size: 13px;
  line-height: 1.6;
  color: #595959;
}

.description-content p {
  margin: 8px 0;
}

.description-content ul {
  margin: 4px 0 12px 0;
  padding-left: 20px;
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
  padding: 12px 16px;
  background-color: #fffbf0;
  border: 1px solid #ffd591;
  border-radius: 6px;
  transition: all 0.2s ease;
}

.locked-file-item:hover {
  background-color: #fff7e6;
  border-color: #ffa940;
}

/* 确保锁定文件列表中的操作按钮可见 */
.locked-file-item .file-actions {
  opacity: 1;
}
</style>

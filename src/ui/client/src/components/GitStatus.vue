<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
// import { io } from 'socket.io-client'
import { Refresh, ArrowLeft, ArrowRight, Folder, Document, ArrowUp, ArrowDown, RefreshRight, Check, Close, Download, Connection } from '@element-plus/icons-vue'
// import { useGitLogStore } from '../stores/gitLogStore'
import { useGitStore } from '../stores/gitStore'

// 定义props
const props = defineProps({
  initialDirectory: {
    type: String,
    default: ''
  }
})

// const gitLogStore = useGitLogStore()
const gitStore = useGitStore()
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
// 添加切换目录相关的状态
const isDirectoryDialogVisible = ref(false)
const newDirectoryPath = ref('')
const isChangingDirectory = ref(false)
// 添加目录浏览相关的状态
const isDirectoryBrowserVisible = ref(false)
const currentBrowsePath = ref('')
const directoryItems = ref<{name: string, path: string, type: string}[]>([])
const isBrowsing = ref(false)
const browseErrorMessage = ref('')

// 添加git操作相关状态
const isGitPulling = ref(false)
const isGitFetching = ref(false)

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
    
    // 使用gitStore获取Git状态
    await gitStore.fetchStatus()
    
    // 同时刷新分支状态信息，确保显示最新的领先/落后提交数
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
    } else {
      // 对于已跟踪的文件，获取常规差异
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
function openDirectoryDialog() {
  newDirectoryPath.value = currentDirectory.value
  isDirectoryDialogVisible.value = true
}

// 打开目录浏览器
function openDirectoryBrowser() {
  browseErrorMessage.value = ''
  currentBrowsePath.value = newDirectoryPath.value || currentDirectory.value
  isDirectoryBrowserVisible.value = true
  browseDirectory(currentBrowsePath.value)
}

// 浏览目录
async function browseDirectory(directoryPath: string) {
  try {
    isBrowsing.value = true
    browseErrorMessage.value = ''
    
    // 确保Windows盘符路径格式正确
    let normalizedPath = directoryPath
    if (/^[A-Za-z]:$/.test(normalizedPath)) {
      normalizedPath += '/'
    }
    
    const response = await fetch(`/api/browse_directory?path=${encodeURIComponent(normalizedPath)}`)
    
    if (response.status === 403) {
      const data = await response.json()
      browseErrorMessage.value = data.error || '目录浏览功能未启用'
      return
    }
    
    if (!response.ok) {
      const data = await response.json()
      browseErrorMessage.value = data.error || '获取目录内容失败'
      return
    }
    
    const data = await response.json()
    
    if (data.success) {
      directoryItems.value = data.items
      currentBrowsePath.value = data.currentPath
    } else {
      browseErrorMessage.value = data.error || '获取目录内容失败'
    }
  } catch (error) {
    browseErrorMessage.value = `获取目录内容失败: ${(error as Error).message}`
  } finally {
    isBrowsing.value = false
  }
}

// 导航到父目录
function navigateToParent() {
  // 检查是否已经是根目录
  // Windows盘符根目录情况 (如 "E:")
  if (/^[A-Za-z]:$/.test(currentBrowsePath.value) || 
      /^[A-Za-z]:[\\/]$/.test(currentBrowsePath.value) || 
      currentBrowsePath.value === '/') {
    // 已经是根目录，不做任何操作
    return
  }
  
  // 获取当前路径的父目录
  let pathParts = currentBrowsePath.value.split(/[/\\]/)
  
  // 移除最后一个目录部分
  pathParts.pop()
  
  // 处理Windows盘符特殊情况
  let parentPath = pathParts.join('/')
  if (pathParts.length === 1 && /^[A-Za-z]:$/.test(pathParts[0])) {
    // 如果只剩下盘符，确保添加斜杠 (例如 "E:/")
    parentPath = pathParts[0] + '/'
  }
  
  if (parentPath) {
    browseDirectory(parentPath)
  }
}

// 选择目录项
function selectDirectoryItem(item: {name: string, path: string, type: string}) {
  if (item.type === 'directory') {
    browseDirectory(item.path)
  }
}

// 选择当前目录
function selectCurrentDirectory() {
  newDirectoryPath.value = currentBrowsePath.value
  isDirectoryBrowserVisible.value = false
}

// 切换工作目录
async function changeDirectory() {
  if (!newDirectoryPath.value) {
    ElMessage.warning('目录路径不能为空')
    return
  }
  
  try {
    isChangingDirectory.value = true
    const response = await fetch('/api/change_directory', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ path: newDirectoryPath.value })
    })
    
    const result = await response.json()
    
    if (result.success) {
      ElMessage.success('已切换工作目录')
      currentDirectory.value = result.directory
      isDirectoryDialogVisible.value = false
      
      // 直接使用API返回的Git仓库状态
      gitStore.isGitRepo = result.isGitRepo
      
      // 如果是Git仓库，加载Git相关数据
      if (result.isGitRepo) {
        // 加载Git分支和用户信息
        await Promise.all([
          gitStore.getCurrentBranch(),
          gitStore.getAllBranches(),
          gitStore.getUserInfo()
        ])
        
        // 刷新Git状态
        await loadStatus()
        
        // 刷新提交历史
        await gitStore.fetchLog(false)
      } else {
        ElMessage.warning('当前目录不是一个Git仓库')
        // 清空Git相关状态
        gitStore.$reset() // 使用pinia的reset方法重置状态
      }
    } else {
      ElMessage.error(result.error || '切换目录失败')
    }
  } catch (error) {
    ElMessage.error(`切换目录失败: ${(error as Error).message}`)
  } finally {
    isChangingDirectory.value = false
  }
}

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

// 刷新Git状态的方法
async function refreshStatus() {
  await loadStatus()
}

// 添加git pull操作方法
async function handleGitPull() {
  isGitPulling.value = true
  try {
    await gitStore.gitPull()
    // 刷新Git状态
    await loadStatus()
  } finally {
    isGitPulling.value = false
  }
}

// 添加git fetch --all操作方法
async function handleGitFetchAll() {
  isGitFetching.value = true
  try {
    await gitStore.gitFetchAll()
    // 刷新Git状态
    await loadStatus()
  } finally {
    isGitFetching.value = false
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

onMounted(() => {
  // App.vue已经加载了Git相关数据，此时只需加载状态
  loadStatus()
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
            :loading="isGitPulling"
            :disabled="!gitStore.hasUpstream"
          />
        </el-tooltip>
        
        <!-- 添加Git Fetch All按钮 -->
        <el-tooltip content="Git Fetch All (获取所有远程分支)" placement="top" :hide-after="1000">
          <el-button 
            type="info" 
            :icon="Connection" 
            circle 
            size="small" 
            @click="handleGitFetchAll" 
            :loading="isGitFetching"
          />
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
    
    <div class="card-content">
      <div class="current-directory">
        <el-icon><Folder /></el-icon>
        <span>{{ currentDirectory }}</span>
        <el-button type="primary" size="small" @click="openDirectoryDialog" plain>
          切换目录
        </el-button>
      </div>
      
      <div v-if="!gitStore.isGitRepo" class="status-box">
        <div class="empty-status">
          <p>当前目录不是Git仓库</p>
          <el-button type="primary" size="small" @click="openDirectoryDialog">
            切换目录
          </el-button>
        </div>
      </div>
      
      <div v-else>
        <!-- 分支同步状态信息 -->
        <div v-if="gitStore.hasUpstream && (gitStore.branchAhead > 0 || gitStore.branchBehind > 0)" class="branch-sync-status">
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
        
        <!-- 默认状态信息 -->
        <div v-if="!gitStore.hasUpstream || (gitStore.branchAhead === 0 && gitStore.branchBehind === 0)" class="git-status-message">
          <p>当前工作在 <el-tag size="small" type="success">{{ gitStore.currentBranch }}</el-tag> 分支</p>
        </div>
        
        <!-- 现代化、简洁的文件列表 -->
        <div v-if="gitStore.fileList.length" class="file-list-container">
          <!-- 分组显示文件 -->
          <div v-if="gitStore.fileList.some(f => f.type === 'added')" class="file-group">
            <div class="file-group-header">已暂存的更改</div>
            <div class="file-list">
              <div
                v-for="file in gitStore.fileList.filter(f => f.type === 'added')"
                :key="file.path"
                class="file-item"
                @click="handleFileClick(file)"
              >
                <div class="file-info">
                  <div class="file-path-container">
                    <span class="file-name">{{ getFileName(file.path) }}</span>
                    <span class="file-directory">{{ getFileDirectory(file.path) }}</span>
                  </div>
                </div>
                <div class="file-actions">
                  <el-tooltip content="取消暂存" placement="top" :hide-after="1000">
                    <el-button
                      type="warning"
                      size="small"
                      circle
                      @click.stop="unstageFile(file.path)"
                    >-</el-button>
                  </el-tooltip>
                </div>
              </div>
            </div>
          </div>
          
          <div v-if="gitStore.fileList.some(f => f.type === 'modified' || f.type === 'deleted')" class="file-group">
            <div class="file-group-header">未暂存的更改</div>
            <div class="file-list">
              <div
                v-for="file in gitStore.fileList.filter(f => f.type === 'modified' || f.type === 'deleted')"
                :key="file.path"
                class="file-item"
                @click="handleFileClick(file)"
              >
                <div class="file-info">
                  <div class="file-status-indicator" :class="file.type"></div>
                  <div class="file-path-container">
                    <span class="file-name">{{ getFileName(file.path) }}</span>
                    <span class="file-directory">{{ getFileDirectory(file.path) }}</span>
                  </div>
                </div>
                <div class="file-actions">
                  <el-tooltip content="添加到暂存区" placement="top" :hide-after="1000">
                    <el-button
                      type="success"
                      size="small"
                      circle
                      @click.stop="stageFile(file.path)"
                    >+</el-button>
                  </el-tooltip>
                  <el-tooltip content="撤回修改" placement="top" :hide-after="1000">
                    <el-button
                      type="danger"
                      size="small"
                      :icon="RefreshRight"
                      circle
                      @click.stop="revertFileChanges(file.path)"
                    />
                  </el-tooltip>
                </div>
              </div>
            </div>
          </div>
          
          <div v-if="gitStore.fileList.some(f => f.type === 'untracked')" class="file-group">
            <div class="file-group-header">未跟踪的文件</div>
            <div class="file-list">
              <div
                v-for="file in gitStore.fileList.filter(f => f.type === 'untracked')"
                :key="file.path"
                class="file-item"
                @click="handleFileClick(file)"
              >
                <div class="file-info">
                  <div class="file-status-indicator untracked"></div>
                  <div class="file-path-container">
                    <span class="file-name">{{ getFileName(file.path) }}</span>
                    <span class="file-directory">{{ getFileDirectory(file.path) }}</span>
                  </div>
                </div>
                <div class="file-actions">
                  <el-tooltip content="添加到暂存区" placement="top" :hide-after="1000">
                    <el-button
                      type="success"
                      size="small"
                      circle
                      @click.stop="stageFile(file.path)"
                    >+</el-button>
                  </el-tooltip>
                  <el-tooltip content="删除文件" placement="top" :hide-after="1000">
                    <el-button
                      type="danger"
                      size="small"
                      :icon="Close"
                      circle
                      @click.stop="revertFileChanges(file.path)"
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
          
          <!-- 添加分支信息 -->
          <div class="branch-info">
            <p>当前工作在 <el-tag size="small" type="success">{{ gitStore.currentBranch }}</el-tag> 分支</p>
            
            <!-- 显示分支同步状态 -->
            <div v-if="gitStore.hasUpstream">
              <span v-if="gitStore.branchAhead > 0" class="branch-sync-info warning">
                <el-icon><ArrowUp /></el-icon> 你的分支领先 'origin/{{ gitStore.currentBranch }}' {{ gitStore.branchAhead }} 个提交
              </span>
              <span v-else-if="gitStore.branchBehind > 0" class="branch-sync-info info">
                <el-icon><ArrowDown /></el-icon> 你的分支落后 'origin/{{ gitStore.currentBranch }}' {{ gitStore.branchBehind }} 个提交
              </span>
              <span v-else class="branch-sync-info success">
                <el-icon><Check /></el-icon> 你的分支与 'origin/{{ gitStore.currentBranch }}' 同步
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
    
    <!-- 切换目录对话框 -->
    <el-dialog
      v-model="isDirectoryDialogVisible"
      title="切换工作目录"
      width="80vw"
      top="10vh"
      style="height: 200px;"
    >
      <el-form>
        <el-form-item label="目录路径">
          <el-input v-model="newDirectoryPath" placeholder="请输入目录路径" clearable />
          <div class="directory-buttons">
            <el-button @click="openDirectoryBrowser" type="primary" plain class="no-padding-left">
              <el-icon><Folder /></el-icon>
              浏览
            </el-button>
            <el-button @click="changeDirectory" :loading="isChangingDirectory" type="primary">
              切换
            </el-button>
          </div>
        </el-form-item>
      </el-form>
    </el-dialog>
    
    <!-- 目录浏览对话框 -->
    <el-dialog
      v-model="isDirectoryBrowserVisible"
      title="浏览目录"
      width="80vw"
      top="70px"
    >
      <div class="browser-current-path">
        <span>当前路径: {{ currentBrowsePath }}</span>
      </div>
      
      <div v-if="browseErrorMessage" class="browser-error">
        {{ browseErrorMessage }}
      </div>
      
      <div v-loading="isBrowsing" class="directory-browser">
        <!-- 导航栏 -->
        <div class="browser-nav">
          <el-button 
            @click="navigateToParent" 
            :disabled="!currentBrowsePath || isBrowsing"
            size="small"
            class="no-padding-left"
          >
            <el-icon><ArrowUp /></el-icon>
            上级目录
          </el-button>
          <el-button 
            @click="selectCurrentDirectory" 
            type="primary" 
            size="small"
            class="no-padding-left"
          >
            选择当前目录
          </el-button>
        </div>
        
        <!-- 目录内容列表 -->
        <div class="directory-items-container">
          <ul class="directory-items">
            <li 
              v-for="item in directoryItems" 
              :key="item.path"
              :class="['directory-item', item.type]"
              @click="selectDirectoryItem(item)"
            >
              <el-icon v-if="item.type === 'directory'"><Folder /></el-icon>
              <el-icon v-else><Document /></el-icon>
              <span>{{ item.name }}</span>
            </li>
          </ul>
        </div>
      </div>
    </el-dialog>
    
    <!-- 文件差异对话框 -->
    <el-dialog
      v-model="diffDialogVisible"
      width="80vw"
      top="70px"
      destroy-on-close
      class="diff-dialog"
      :show-close="false"
      style="height: calc(100vh - 140px);"
      :modal-append-to-body="false"
      :close-on-click-modal="false"
    >
      <template #header>
        <div class="diff-dialog-header">
          <div class="file-title">
            <el-icon class="file-icon"><Document /></el-icon>
            <span class="file-path">{{ selectedFile }}</span>
          </div>
          <div class="header-actions">
            <el-button 
              @click="diffDialogVisible = false" 
              circle 
              size="small" 
              :icon="Close" 
              class="close-button"
            />
          </div>
        </div>
      </template>
      
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
  </div>
</template>

<style scoped>
.card {
  background-color: #fff;
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.03);
  border: 1px solid rgba(0, 0, 0, 0.03);
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.status-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  border-bottom: 1px solid #f0f0f0;
  height: 36px;
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
}

.card-content {
  padding: 15px;
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 300px; /* 确保内容区有最小高度 */
}

.current-directory {
  display: flex;
  align-items: center;
  margin-bottom: 16px;
  padding: 10px;
  background-color: #f8f9fa;
  border-radius: 6px;
  font-family: monospace;
  border: 1px solid #f0f0f0;
}

.current-directory .el-icon {
  margin-right: 8px;
  color: #409eff;
}

.current-directory span {
  flex-grow: 1;
  word-break: break-all;
  margin-right: 10px;
}

.status-box {
  white-space: pre-wrap;
  font-family: monospace;
  background-color: #f8f9fa;
  padding: 16px;
  border-radius: 6px;
  margin-bottom: 20px;
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid #f0f0f0;
  font-size: 14px;
  line-height: 1.5;
}

/* 现代化的文件列表容器 */
.file-list-container {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  margin-bottom: 0;
  gap: 12px;
  height: auto; /* 改为自适应高度，不固定高度 */
  min-height: 100px; /* 设置最小高度 */
}

.file-group {
  background-color: #f8f9fa;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid #ebeef5;
  margin-bottom: 12px;
  display: flex;
  flex-direction: column;
}

/* 让每个文件组根据内容自动增长 */
.file-group {
  flex: 0 1 auto; /* 不主动增长，但允许缩小，基于内容大小 */
}

/* 最后一个分组可以吸收剩余空间 */
.file-group:last-child {
  margin-bottom: 0;
  flex: 1 1 auto; /* 可以增长占用剩余空间 */
}

.file-group-header {
  font-size: 14px;
  font-weight: bold;
  padding: 8px 12px;
  background-color: #f0f2f5;
  color: #606266;
  border-bottom: 1px solid #ebeef5;
  flex-shrink: 0; /* 防止header被压缩 */
}

.file-list {
  overflow-y: auto;
  min-height: 40px; /* 最小高度 */
  max-height: 200px; /* 最大高度限制，避免过长列表 */
  flex-grow: 1; /* 允许文件列表在文件组内扩展 */
  padding: 0;
  margin: 0;
  scrollbar-width: thin; /* Firefox */
  scrollbar-color: rgba(144, 147, 153, 0.3) transparent; /* Firefox */
}

/* Webkit浏览器的滚动条样式 */
.file-list::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.file-list::-webkit-scrollbar-thumb {
  background-color: rgba(144, 147, 153, 0.3);
  border-radius: 4px;
}

.file-list::-webkit-scrollbar-thumb:hover {
  background-color: rgba(144, 147, 153, 0.5);
}

.file-list::-webkit-scrollbar-track {
  background-color: transparent;
}

/* 让每个文件列表自适应高度，使其在容器中更好地分配空间 */
.file-list:empty {
  display: none; /* 如果列表为空，不显示 */
}

/* 当没有足够的项目填充列表时，禁用滚动 */
.file-list:has(.empty-file-group) {
  overflow-y: hidden;
}

/* 替换为更兼容的选择器 */
/* 改用直接为empty-file-group父容器添加样式 */
.empty-file-container {
  overflow-y: hidden !important; /* 强制禁用滚动 */
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
  min-height: 50px; /* 增加最小高度 */
  background-color: #f8f9fa;
  border-radius: 4px;
  margin: 8px;
}

/* 自定义每个分组的展开逻辑 */
/* 已暂存文件分组 - 保持小巧 */
.file-group:nth-child(1) {
  flex: 0 1 auto;
}

/* 未暂存更改分组 - 稍微大一些 */
.file-group:nth-child(2) {
  flex: 0 1 auto;
}

/* 未跟踪文件分组 - 可以占据剩余空间 */
.file-group:nth-child(3) {
  flex: 1 1 auto;
}

.file-item {
  padding: 8px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #ebeef5;
  cursor: pointer;
  transition: background-color 0.2s;
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
  white-space: nowrap;
  gap: 8px;
}

.file-status-indicator {
  width: 6px;
  height: 6px;
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

.file-path-container {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.file-name {
  font-weight: 500;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.2;
}

.file-directory {
  font-size: 12px;
  color: #909399;
  max-width: 200px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.file-actions {
  display: flex;
  gap: 5px;
  opacity: 0;
  transition: opacity 0.2s;
}

.file-item:hover .file-actions {
  opacity: 1;
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
  margin-top: 10px;
}

.empty-icon {
  width: 60px;
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: #ebeef5;
  border-radius: 50%;
  margin-bottom: 15px;
  font-size: 24px;
  color: #909399;
  animation: pulse 2s infinite ease-in-out;
}

@keyframes pulse {
  0% { transform: scale(1); opacity: 0.7; }
  50% { transform: scale(1.05); opacity: 1; }
  100% { transform: scale(1); opacity: 0.7; }
}

.empty-text {
  font-size: 16px;
  font-weight: 500;
  color: #606266;
  margin-bottom: 5px;
}

.empty-subtext {
  font-size: 14px;
  color: #909399;
  margin-bottom: 20px;
}

/* 分支信息样式 */
.branch-info {
  margin-top: 15px;
  padding: 10px 15px;
  background-color: #ebeef5;
  border-radius: 6px;
  text-align: left;
  width: 100%;
  max-width: 400px;
}

.branch-info p {
  margin: 5px 0;
  font-size: 14px;
  color: #606266;
}

.branch-sync-info {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  margin-top: 5px;
  padding: 5px 8px;
  border-radius: 4px;
  background-color: #f5f7fa;
}

.branch-sync-info.warning {
  color: #e6a23c;
  background-color: #fdf6ec;
}

.branch-sync-info.info {
  color: #909399;
  background-color: #f4f4f5;
}

.branch-sync-info.success {
  color: #67c23a;
  background-color: #f0f9eb;
}

/* 添加针对空内容区域的样式 */
.card-content:empty {
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: #f8f9fa;
  border-radius: 6px;
  border: 1px dashed #dcdfe6;
  color: #909399;
  height: 100%;
}

.card-content:empty::after {
  content: '没有Git状态信息可显示';
  font-size: 14px;
}

/* 添加目录浏览相关样式 */
.browser-current-path {
  font-family: monospace;
  margin-bottom: 15px;
  padding: 10px;
  background-color: #f5f7fa;
  border-radius: 6px;
  overflow-x: auto;
  white-space: nowrap;
  border: 1px solid #ebeef5;
}

.browser-error {
  color: #f56c6c;
  margin: 10px 0;
  padding: 10px;
  background-color: #fef0f0;
  border-radius: 4px;
  border-left: 3px solid #f56c6c;
}

.browser-nav {
  display: flex;
  gap: 10px;
  margin-bottom: 10px;
}

.no-padding-left {
  padding-left: 12px;
}

.directory-browser {
  height: 400px;
  border: 1px solid #ebeef5;
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.directory-items-container {
  flex: 1;
  overflow-y: auto;
  background-color: #f8f9fa;
  padding: 10px;
}

.directory-items {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
}

.directory-item {
  display: flex;
  align-items: center;
  padding: 8px;
  cursor: pointer;
  border-radius: 4px;
  background-color: white;
  border: 1px solid #ebeef5;
  transition: all 0.2s;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  gap: 5px;
}

.directory-item:hover {
  background-color: #ecf5ff;
  border-color: #c6e2ff;
}

.directory-item.directory {
  background-color: #f0f7ff;
  color: #409eff;
}

.directory-item .el-icon {
  margin-right: 5px;
  flex-shrink: 0;
}

.directory-item.directory .el-icon {
  color: #409eff;
}

.directory-item.file .el-icon {
  color: #909399;
}

.directory-buttons {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

/* 添加分支状态样式 */
.branch-sync-status {
  display: flex;
  align-items: center;
  padding: 12px 15px;
  background-color: #f8f9fa;
  border-radius: 4px;
  margin-bottom: 15px;
  border-left: 3px solid #e6a23c;
}

/* 添加默认分支状态信息样式 */
.git-status-message {
  padding: 12px 15px;
  background-color: #f8f9fa;
  border-radius: 4px;
  margin-bottom: 15px;
  border-left: 3px solid #67c23a;
}

.git-status-message p {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: #606266;
}

.sync-status-content {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
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
}

.status-badge.el-tag--warning {
  background-color: #fdf6ec;
  border-color: #faecd8;
}

.status-badge.el-tag--info {
  background-color: #f4f4f5;
  border-color: #e9e9eb;
}

.badge-content {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.diff-dialog {
  height: calc(100vh - 150px);
}

.diff-dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid #ebeef5;
  background-color: #f9f9fb;
}

.file-title {
  display: flex;
  align-items: center;
  font-size: 16px;
  font-weight: 500;
  color: #303133;
  gap: 10px;
  overflow: hidden;
}

.file-icon {
  color: #409eff;
  font-size: 20px;
}

.file-path {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: monospace;
}

.diff-content {
  flex: 1;
  overflow-y: auto;
  padding: 10px 20px;
  background-color: #fafafa;
  /* height: 100%;
  overflow: auto; */
}
:deep(.el-dialog__body) {
  height: calc(100vh - 320px);
  overflow: auto;
}
.diff-formatted {
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 14px;
  line-height: 1.5;
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
  padding: 10px 20px;
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
</style>

<!-- 非scoped样式，使diff格式化样式对动态内容生效 -->
<style>
.diff-header {
  font-weight: bold;
  background-color: #e6f1fc;
  padding: 5px;
  margin: 8px 0;
  border-radius: 4px;
  color: #0366d6;
  border-bottom: 1px solid #c8e1ff;
}

.diff-old-file, .diff-new-file {
  color: #586069;
  padding: 2px 5px;
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
  padding: 2px 5px;
  margin: 5px 0;
  border-radius: 3px;
  font-family: monospace;
}

.diff-added {
  background-color: #e6ffed;
  color: #22863a;
  padding: 0 5px;
  border-left: 4px solid #22863a;
  font-family: monospace;
  display: block;
  margin: 2px 0;
}

.diff-removed {
  background-color: #ffeef0;
  color: #cb2431;
  padding: 0 5px;
  border-left: 4px solid #cb2431;
  font-family: monospace;
  display: block;
  margin: 2px 0;
}

.diff-context {
  color: #444;
  padding: 0 5px;
  font-family: monospace;
  display: block;
  margin: 2px 0;
  background-color: #fafbfc;
}

/* 增加自动更新开关的样式 */
.auto-update-switch .el-switch__core {
  transition: all 0.3s ease-in-out;
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);
}

.auto-update-switch .el-switch__core:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.auto-update-switch.is-checked .el-switch__core {
  box-shadow: 0 2px 5px rgba(103, 194, 58, 0.3);
}

.auto-update-switch.is-checked .el-switch__core:hover {
  box-shadow: 0 2px 8px rgba(103, 194, 58, 0.5);
}
</style>
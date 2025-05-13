<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
// import { io } from 'socket.io-client'
import { Refresh, ArrowLeft, ArrowRight, Folder, Document, ArrowUp, RefreshRight } from '@element-plus/icons-vue'
import { useGitLogStore } from '../stores/gitLogStore'

const gitLogStore = useGitLogStore()
const status = ref('加载中...')
// const socket = io()
const isRefreshing = computed(() => gitLogStore.isLoadingStatus)
const fileList = ref<{path: string, type: string}[]>([])
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

// 解析 git status 输出，提取文件及类型
function parseStatus(statusText: string) {
  if (statusText === undefined) return
  const lines = statusText.split('\n')
  const files: {path: string, type: string}[] = []
  for (const line of lines) {
    // 匹配常见的 git status --porcelain 格式
    // M: 修改, A: 新增, D: 删除, ??: 未跟踪
    const match = line.match(/^([ MADRCU\?]{2})\s+(.+)$/)
    if (match) {
      let type = ''
      const code = match[1].trim()
      if (code === 'M' || code === 'MM' || code === 'AM' || code === 'RM') type = 'modified'
      else if (code === 'A' || code === 'AA') type = 'added'
      else if (code === 'D' || code === 'AD' || code === 'DA') type = 'deleted'
      else if (code === '??') type = 'untracked'
      else type = 'other'
      files.push({ path: match[2], type })
    }
  }
  fileList.value = files
}

const currentDirectory = ref('')
async function loadStatus() {
  try {
    // 获取当前工作目录
    const responseDir = await fetch('/api/current_directory')
    const dirData = await responseDir.json()
    currentDirectory.value = dirData.directory || '未知目录'
    
    // 如果不是Git仓库，显示提示并返回
    if (dirData.isGitRepo === false) {
      status.value = '当前目录不是一个Git仓库'
      fileList.value = []
      ElMessage.warning('当前目录不是一个Git仓库')
      return
    }
    
    // 使用store获取Git状态
    await gitLogStore.fetchStatus()
    
    const response = await fetch('/api/status')
    const data = await response.json()
    status.value = data.status

    const response_porcelain = await fetch('/api/status_porcelain')
    const data_porcelain = await response_porcelain.json()
    parseStatus(data_porcelain.status)
    ElMessage({
      message: 'Git 状态已刷新',
      type: 'success',
    })
  } catch (error) {
    status.value = '加载状态失败: ' + (error as Error).message
    fileList.value = []
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
    currentFileIndex.value = fileList.value.findIndex(file => file.path === filePath)
    const response = await fetch(`/api/diff?file=${encodeURIComponent(filePath)}`)
    const data = await response.json()
    diffContent.value = data.diff || '没有变更'
    diffDialogVisible.value = true
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
  if (fileList.value.length === 0 || currentFileIndex.value <= 0) return
  
  const newIndex = currentFileIndex.value - 1
  const prevFile = fileList.value[newIndex]
  await getFileDiff(prevFile.path)
}

// 添加切换到下一个文件的方法
async function goToNextFile() {
  if (fileList.value.length === 0 || currentFileIndex.value >= fileList.value.length - 1) return
  
  const newIndex = currentFileIndex.value + 1
  const nextFile = fileList.value[newIndex]
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
      
      // 如果新目录不是Git仓库，显示警告
      if (!result.isGitRepo) {
        ElMessage.warning('当前目录不是一个Git仓库')
      }
      
      // 刷新状态
      loadStatus()
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

// 文件类型标签显示
function fileTypeLabel(type: string) {
  switch (type) {
    case 'added': return '新增';
    case 'modified': return '修改';
    case 'deleted': return '删除';
    case 'untracked': return '未跟踪';
    default: return '其他';
  }
}

// 刷新Git状态的方法
async function refreshStatus() {
  await loadStatus()
  await gitLogStore.fetchStatus()
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
      ElMessage.error(result.error || '撤回文件修改失败')
    }
  } catch (error) {
    // 用户取消或发生错误
    if ((error as Error).message !== 'cancel') {
      ElMessage.error(`撤回文件修改失败: ${(error as Error).message}`)
    }
  }
}

onMounted(() => {
  loadStatus()
  
  // Socket.io 事件
  // socket.on('status_update', (data: { status: string }) => {
  //   status.value = data.status
  //   parseStatus(data.status)
  // })
})

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
    <div class="current-directory">
      <el-icon><Folder /></el-icon>
      <span>{{ currentDirectory }}</span>
      <el-button type="primary" size="small" @click="openDirectoryDialog" plain>
        切换目录
      </el-button>
    </div>
    <div class="status-header">
      <h2>Git 状态(git status)</h2>
      <el-button 
        type="primary" 
        :icon="Refresh" 
        circle 
        size="small" 
        @click="refreshStatus" 
        :loading="isRefreshing"
      />
    </div>
    <div class="status-box">{{ status }}</div>
    <!-- 颜色区分不同类型文件 -->
    <div v-if="fileList.length" class="file-list">
      <div 
        v-for="file in fileList" 
        :key="file.path" 
        :class="['file-item', file.type]"
      >
        <div class="file-info" @click="handleFileClick(file)">
          <span class="file-type">{{ fileTypeLabel(file.type) }}</span>
          <span class="file-path">{{ file.path }}</span>
        </div>
        <div class="file-actions">
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
    
    <!-- 切换目录对话框 -->
    <el-dialog
      v-model="isDirectoryDialogVisible"
      title="切换工作目录"
      width="500px"
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
      width="600px"
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
    </el-dialog>
    
    <!-- 文件差异对话框 -->
    <el-dialog
      v-model="diffDialogVisible"
      :title="`文件差异: ${selectedFile}`"
      width="80%"
      destroy-on-close
    >
      <div v-loading="isLoadingDiff" class="diff-content">
        <div v-if="diffContent" v-html="formatDiff(diffContent)" class="diff-formatted"></div>
        <div v-else class="no-diff">该文件没有差异或是新文件</div>
      </div>
      
      <!-- 添加文件导航按钮 -->
      <div class="file-navigation">
        <el-button 
          :icon="ArrowLeft" 
          @click="goToPreviousFile" 
          :disabled="currentFileIndex <= 0 || fileList.length === 0"
          circle
        />
        <span class="file-counter">{{ currentFileIndex + 1 }} / {{ fileList.length }}</span>
        <el-button 
          :icon="ArrowRight" 
          @click="goToNextFile" 
          :disabled="currentFileIndex >= fileList.length - 1 || fileList.length === 0"
          circle
        />
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.card {
  background-color: #fff;
  border-radius: 8px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
  padding: 20px;
  margin-bottom: 20px;
}

.status-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.status-header h2 {
  margin: 0;
}

.status-box {
  white-space: pre-wrap;
  font-family: monospace;
  background-color: #f5f7fa;
  padding: 15px;
  border-radius: 4px;
  margin-bottom: 15px;
  max-height: 300px;
  overflow-y: auto;
}

.file-list {
  max-height: 300px;
  overflow-y: auto;
}

.file-item {
  padding: 8px 12px;
  margin-bottom: 5px;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.file-item:hover {
  background-color: #f5f7fa;
}

.file-info {
  display: flex;
  align-items: center;
  flex-grow: 1;
}

.file-actions {
  margin-left: 10px;
  opacity: 0.5;
  transition: opacity 0.2s;
}

.file-item:hover .file-actions {
  opacity: 1;
}

.file-type {
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 10px;
  margin-right: 10px;
  flex-shrink: 0;
}

.added .file-type {
  background-color: #e1f3d8;
  color: #67c23a;
}

.modified .file-type {
  background-color: #e6f1fc;
  color: #409eff;
}

.deleted .file-type {
  background-color: #fef0f0;
  color: #f56c6c;
}

.untracked .file-type {
  background-color: #fdf6ec;
  color: #e6a23c;
}

.file-path {
  font-family: monospace;
  word-break: break-all;
}

.diff-content {
  font-family: monospace;
  white-space: pre-wrap;
  max-height: 60vh;
  overflow-y: auto;
  padding: 10px;
  background-color: #f5f7fa;
  border-radius: 4px;
}

.diff-formatted {
  font-size: 14px;
  line-height: 1.5;
}

.file-navigation {
  display: flex;
  justify-content: center;
  align-items: center;
  margin-top: 15px;
}

.file-counter {
  margin: 0 15px;
  font-size: 14px;
  color: #606266;
}

.current-directory {
  display: flex;
  align-items: center;
  margin-bottom: 15px;
  padding: 8px 12px;
  background-color: #f5f7fa;
  border-radius: 4px;
  font-family: monospace;
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

.browser-current-path {
  margin-bottom: 10px;
  font-size: 14px;
  color: #606266;
  background-color: #f5f7fa;
  padding: 8px 12px;
  border-radius: 4px;
  font-family: monospace;
  word-break: break-all;
}

.browser-error {
  margin-bottom: 10px;
  color: #f56c6c;
  padding: 8px 12px;
  background-color: #fef0f0;
  border-radius: 4px;
}

.directory-browser {
  padding: 10px;
  max-height: 400px;
  overflow-y: auto;
}

.browser-nav {
  margin-bottom: 10px;
  display: flex;
  justify-content: space-between;
}

.directory-items {
  list-style: none;
  padding: 0;
  margin: 0;
}

.directory-item {
  padding: 8px 12px;
  margin-bottom: 5px;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
}

.directory-item:hover {
  background-color: #f5f7fa;
}

.directory-item.directory {
  color: #409eff;
}

.directory-item.file {
  color: #606266;
}

.directory-item .el-icon {
  margin-right: 10px;
}

.directory-item span {
  font-family: monospace;
  word-break: break-all;
}

.directory-buttons {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

/* 移除按钮左侧的内边距 */
.no-padding-left {
  padding-left: 8px !important;
}
</style>

<!-- 添加非scoped样式，使diff格式化样式对动态内容生效 -->
<style>
.diff-header {
  font-weight: bold;
  background-color: #e6f1fc;
  padding: 3px;
  margin: 5px 0;
}

.diff-old-file, .diff-new-file {
  color: #888;
}

.diff-hunk-header {
  color: #6f42c1;
}

.diff-added {
  background-color: #e6ffed;
  color: #28a745;
}

.diff-removed {
  background-color: #ffeef0;
  color: #d73a49;
}

.diff-context {
  color: #444;
}
</style>
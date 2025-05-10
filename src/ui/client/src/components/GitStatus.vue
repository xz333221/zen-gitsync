<script setup lang="ts">
import { ref, onMounted, onUnmounted, defineExpose } from 'vue'
import { io } from 'socket.io-client'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'

const status = ref('加载中...')
const socket = io()
const isRefreshing = ref(false)
const fileList = ref<{path: string, type: string}[]>([])
const selectedFile = ref('')
const diffContent = ref('')
const diffDialogVisible = ref(false)
const isLoadingDiff = ref(false)

// 解析 git status 输出，提取文件及类型
function parseStatus(statusText: string) {
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

async function loadStatus() {
  try {
    isRefreshing.value = true
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
  } finally {
    isRefreshing.value = false
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

// 处理文件点击
function handleFileClick(file: {path: string, type: string}) {
  getFileDiff(file.path)
}

// 刷新Git状态的方法
async function refreshStatus() {
  await loadStatus()
}

onMounted(() => {
  loadStatus()
  
  // Socket.io 事件
  socket.on('status_update', (data: { status: string }) => {
    status.value = data.status
    parseStatus(data.status)
  })
})

onUnmounted(() => {
  socket.disconnect()
})

// 暴露刷新方法给父组件
defineExpose({
  refreshStatus
})
</script>

<template>
  <div class="card">
    <div class="status-header">
      <h2>Git 状态</h2>
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
        @click="handleFileClick(file)"
      >
        <span class="file-type">{{ fileTypeLabel(file.type) }}</span>
        <span class="file-path">{{ file.path }}</span>
      </div>
    </div>
    
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
    </el-dialog>
  </div>
</template>

<script lang="ts">
// 辅助函数：类型标签
function fileTypeLabel(type: string) {
  if (type === 'added') return '新增'
  if (type === 'modified') return '修改'
  if (type === 'deleted') return '删除'
  if (type === 'untracked') return '未跟踪'
  return '其它'
}
</script>

<style scoped>
.status-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.status-header h2 {
  margin: 0;
}

.file-list {
  margin-top: 10px;
}

.file-item {
  display: flex;
  align-items: center;
  margin-bottom: 4px;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 14px;
  cursor: pointer;
  transition: opacity 0.2s;
}
.file-item:hover {
  opacity: 0.8;
}
.file-item.added {
  background: #e6ffed;
  color: #22863a;
}
.file-item.modified {
  background: #fff5b1;
  color: #b08800;
}
.file-item.deleted {
  background: #ffeef0;
  color: #cb2431;
}
.file-item.untracked {
  background: #f1f8ff;
  color: #0366d6;
}
.file-type {
  font-weight: bold;
  margin-right: 8px;
}
.file-path {
  font-family: monospace;
}

.diff-content {
  max-height: 70vh;
  overflow-y: auto;
  background-color: #f6f8fa;
  border: 1px solid #e1e4e8;
  border-radius: 3px;
  padding: 15px;
  font-family: monospace;
  white-space: pre-wrap;
}

.diff-formatted {
  margin: 0;
}

/* 差异内容的颜色样式 - 使用深度选择器 */
:deep(.diff-header) {
  color: #24292e;
  font-weight: bold;
}

:deep(.diff-old-file) {
  color: #cb2431;
  background-color: #ffeef0;
}

:deep(.diff-new-file) {
  color: #22863a;
  background-color: #e6ffed;
}

:deep(.diff-hunk-header) {
  color: #6f42c1;
  background-color: #f1f8ff;
}

:deep(.diff-added) {
  color: #22863a;
  background-color: #e6ffed;
}

:deep(.diff-removed) {
  color: #cb2431;
  background-color: #ffeef0;
}

:deep(.diff-context) {
  color: #24292e;
}

.no-diff {
  text-align: center;
  padding: 20px;
  color: #666;
}
</style>
<script setup lang="ts">
import { ref, onMounted, onUnmounted, defineExpose } from 'vue'
import { io } from 'socket.io-client'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'

const status = ref('加载中...')
const socket = io()
const isRefreshing = ref(false)
const fileList = ref<{path: string, type: string}[]>([])

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
      >
        <span class="file-type">{{ fileTypeLabel(file.type) }}</span>
        <span class="file-path">{{ file.path }}</span>
      </div>
    </div>
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
</style>
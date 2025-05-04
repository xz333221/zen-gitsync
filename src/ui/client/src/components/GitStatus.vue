<script setup lang="ts">
import { ref, onMounted, onUnmounted, defineExpose } from 'vue'
import { io } from 'socket.io-client'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'

const status = ref('加载中...')
const socket = io()
const isRefreshing = ref(false)

// 加载Git状态
async function loadStatus() {
  try {
    isRefreshing.value = true
    const response = await fetch('/api/status')
    const data = await response.json()
    status.value = data.status
    ElMessage({
      message: 'Git 状态已刷新',
      type: 'success',
    })
  } catch (error) {
    status.value = '加载状态失败: ' + (error as Error).message
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
  </div>
</template>

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
</style>
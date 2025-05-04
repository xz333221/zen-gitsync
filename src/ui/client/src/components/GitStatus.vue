<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { io } from 'socket.io-client'

const status = ref('加载中...')
const socket = io()

// 加载Git状态
async function loadStatus() {
  try {
    const response = await fetch('/api/status')
    const data = await response.json()
    status.value = data.status
  } catch (error) {
    status.value = '加载状态失败: ' + (error as Error).message
  }
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
</script>

<template>
  <div class="card">
    <h2>Git 状态</h2>
    <div class="status-box">{{ status }}</div>
  </div>
</template>
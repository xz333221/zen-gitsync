<script setup lang="ts">
import { ref, onMounted, defineExpose } from 'vue'

interface LogItem {
  hash: string
  date: string
  author: string
  message: string
}

const logs = ref<LogItem[]>([])
const errorMessage = ref('')

// 加载提交历史
async function loadLog() {
  try {
    const response = await fetch('/api/log')
    logs.value = await response.json()
    errorMessage.value = ''
  } catch (error) {
    errorMessage.value = '加载提交历史失败: ' + (error as Error).message
  }
}

onMounted(() => {
  loadLog()
})

// 暴露方法给父组件
defineExpose({
  refreshLog: loadLog
})
</script>

<template>
  <div class="card">
    <h2>提交历史</h2>
    <div v-if="errorMessage">{{ errorMessage }}</div>
    <div v-else>
      <div v-for="log in logs" :key="log.hash" class="log-item">
        <span class="log-hash">{{ log.hash }}</span> - 
        <span class="log-date">{{ log.date }}</span> - 
        <span class="log-author">{{ log.author }}</span>
        <div class="log-message">{{ log.message }}</div>
      </div>
    </div>
  </div>
</template>
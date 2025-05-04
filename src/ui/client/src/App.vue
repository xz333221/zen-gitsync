<script setup lang="ts">
import { ref, onMounted } from 'vue'
import GitStatus from './components/GitStatus.vue'
import CommitForm from './components/CommitForm.vue'
import LogList from './components/LogList.vue'

const configInfo = ref('')
const logListRef = ref(null)
const gitStatusRef = ref(null)

// 加载配置
async function loadConfig() {
  try {
    const response = await fetch('/api/config/getConfig')
    const config = await response.json()
    configInfo.value = `默认提交信息: ${config.defaultCommitMessage}`
  } catch (error) {
    console.error('加载配置失败:', error)
  }
}

onMounted(() => {
  loadConfig()
})

// 处理提交成功事件
function handleCommitSuccess() {
  // 刷新提交历史
  if (logListRef.value) {
    logListRef.value.refreshLog()
  }
}

// 处理推送成功事件
function handlePushSuccess() {
  // 刷新提交历史
  if (logListRef.value) {
    logListRef.value.refreshLog()
  }
  
  // 刷新Git状态
  if (gitStatusRef.value) {
    gitStatusRef.value.refreshStatus()
  }
}
</script>

<template>
  <header class="main-header">
    <h1>Zen GitSync UI</h1>
    <div id="config-info">{{ configInfo }}</div>
  </header>
  
  <div class="container">
    <div class="layout-container">
      <!-- 左侧Git状态 -->
      <div class="left-panel">
        <GitStatus ref="gitStatusRef" />
      </div>
      
      <!-- 右侧提交表单和历史 -->
      <div class="right-panel">
        <CommitForm 
          @commit-success="handleCommitSuccess" 
          @push-success="handlePushSuccess" 
        />
        <LogList ref="logListRef" />
      </div>
    </div>
  </div>
</template>

<style>
body {
  font-family: 'Arial', sans-serif;
  margin: 0;
  padding: 0;
  background-color: #f5f5f5;
}
.container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 20px;
}
.main-header {
  background-color: #24292e;
  color: white;
  padding: 15px 20px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
h1 {
  margin: 0;
  font-size: 24px;
}
.card {
  background-color: white;
  border-radius: 5px;
  box-shadow: 0 2px 5px rgba(0,0,0,0.1);
  margin-bottom: 20px;
  padding: 20px;
}
.status-box {
  background-color: #f6f8fa;
  border: 1px solid #e1e4e8;
  border-radius: 3px;
  padding: 15px;
  white-space: pre-wrap;
  font-family: monospace;
  max-height: 300px;
  overflow-y: auto;
}

/* 新增布局样式 */
.layout-container {
  display: flex;
  gap: 20px;
}

.left-panel {
  flex: 0 0 30%;
  max-width: 30%;
}

.right-panel {
  flex: 0 0 70%;
  max-width: 70%;
}

/* 响应式布局 */
@media (max-width: 768px) {
  .layout-container {
    flex-direction: column;
  }
  
  .left-panel, .right-panel {
    flex: 0 0 100%;
    max-width: 100%;
  }
}
.commit-form {
  display: flex;
  margin-bottom: 15px;
}

.log-item {
  padding: 10px 0;
  border-bottom: 1px solid #eee;
}
.log-item:last-child {
  border-bottom: none;
}
.log-hash {
  color: #6f42c1;
  font-family: monospace;
}
.log-author {
  color: #6a737d;
}
.log-date {
  color: #6a737d;
}
.log-message {
  font-weight: bold;
}
.log-branch {
  display: inline-block;
  background-color: #0366d6;
  color: white;
  border-radius: 3px;
  padding: 2px 6px;
  margin-left: 8px;
  font-size: 12px;
}
</style>

<style scoped>
.logo {
  height: 6em;
  padding: 1.5em;
  will-change: filter;
  transition: filter 300ms;
}
.logo:hover {
  filter: drop-shadow(0 0 2em #646cffaa);
}
.logo.vue:hover {
  filter: drop-shadow(0 0 2em #42b883aa);
}
</style>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import GitStatus from './components/GitStatus.vue'
import CommitForm from './components/CommitForm.vue'
import LogList from './components/LogList.vue'

import logo from './assets/logo.svg'

const configInfo = ref('')
const logListRef = ref(null)
const gitStatusRef = ref(null)
const currentBranch = ref('') // 添加当前分支状态变量

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

// 获取当前分支
async function getCurrentBranch() {
  try {
    const response = await fetch('/api/branch')
    const data = await response.json()
    if (data.branch) {
      currentBranch.value = data.branch
    }
  } catch (error) {
    console.error('获取分支信息失败:', error)
  }
}

onMounted(() => {
  loadConfig()
  getCurrentBranch() // 初始加载分支信息
})

// 处理提交成功事件
function handleCommitSuccess() {
  // 刷新提交历史
  if (logListRef.value) {
    logListRef.value.refreshLog()
  }
  
  // 刷新Git状态
  if (gitStatusRef.value) {
    gitStatusRef.value.refreshStatus()
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
  
  // 刷新分支信息
  getCurrentBranch()
}
</script>

<template>
  <header class="main-header">
    <div class="header-left">
      <img :src="logo" alt="Zen GitSync Logo" class="logo" />
      <h1>Zen GitSync UI</h1>
    </div>
    <div class="header-info">
      <div id="branch-info" v-if="currentBranch">
        <span class="branch-label">当前分支:</span>
        <span class="branch-name">{{ currentBranch }}</span>
      </div>
      <!-- <div id="config-info">{{ configInfo }}</div> -->
    </div>
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
  margin: 0 auto;
  padding: 20px 30px;
}
.main-header {
  background-color: #24292e;
  color: white;
  padding: 15px 20px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.logo {
  height: 32px;
  width: auto;
}
h1 {
  margin: 0;
  font-size: 24px;
}
.header-info {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 5px;
}
#branch-info {
  background-color: #2ea44f;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 14px;
  display: inline-flex;
  align-items: center;
}
.branch-label {
  margin-right: 5px;
  font-weight: bold;
}
.branch-name {
  font-family: monospace;
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
  
  .header-left {
    gap: 8px;
  }
  
  .logo {
    height: 24px;
  }
  
  h1 {
    font-size: 20px;
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
  will-change: filter;
  transition: filter 300ms;
}
.logo:hover {
  filter: drop-shadow(0 0 2em #42b883aa);
}
</style>

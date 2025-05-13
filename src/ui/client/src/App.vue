<script setup lang="ts">
import { ref, onMounted } from 'vue'
import GitStatus from './components/GitStatus.vue'
import CommitForm from './components/CommitForm.vue'
import LogList from './components/LogList.vue'
import { ElMessage } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import logo from './assets/logo.svg'
import { useGitStore } from './stores/gitStore'
import { useGitLogStore } from './stores/gitLogStore'

const configInfo = ref('')
// 添加组件实例类型
const logListRef = ref<InstanceType<typeof LogList> | null>(null)
const gitStatusRef = ref<InstanceType<typeof GitStatus> | null>(null)

// 使用Git Store
const gitStore = useGitStore()
const gitLogStore = useGitLogStore()

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
  console.log('---------- 页面初始化开始 ----------')
  loadConfig()
  gitStore.loadInitialData() // 初始加载Git信息
  gitLogStore.fetchStatus() // 加载Git状态
  gitLogStore.fetchLog() // 加载提交历史
  console.log('---------- 页面初始化完成 ----------')
})

// 处理提交成功事件
function handleCommitSuccess() {
  // 直接使用store刷新状态
  gitLogStore.fetchStatus()
  gitLogStore.fetchLog()
}

// 处理推送成功事件
function handlePushSuccess() {
  // 使用store刷新状态
  gitLogStore.fetchLog()
  gitStore.getCurrentBranch()
}

// 处理状态更新事件
function handleStatusUpdate() {
  // 刷新Git状态
  if (gitStatusRef.value) {
    gitStatusRef.value.refreshStatus()
  }
}

const createBranchDialogVisible = ref(false)
const newBranchName = ref('')
const selectedBaseBranch = ref('')

// 创建新分支
async function createNewBranch() {
  const success = await gitStore.createBranch(newBranchName.value, selectedBaseBranch.value)
  
  if (success) {
    // 关闭对话框
    createBranchDialogVisible.value = false
    
    // 重置表单
    newBranchName.value = ''
    
    // 刷新Git状态
    if (gitStatusRef.value) {
      gitStatusRef.value.refreshStatus()
    }
    
    // 刷新提交历史
    if (logListRef.value) {
      logListRef.value.refreshLog()
    }
  }
}

// 打开创建分支对话框
function openCreateBranchDialog() {
  selectedBaseBranch.value = gitStore.currentBranch
  createBranchDialogVisible.value = true
}

// 切换分支
async function handleBranchChange(branch: string) {
  const success = await gitStore.changeBranch(branch)
  
  if (success) {
    // 刷新Git状态
    if (gitStatusRef.value) {
      gitStatusRef.value.refreshStatus()
    }
    
    // 刷新提交历史
    if (logListRef.value) {
      logListRef.value.refreshLog()
    }
  }
}
</script>

<template>
  <header class="main-header">
    <div class="header-left">
      <img :src="logo" alt="Zen GitSync Logo" class="logo" />
      <h1>Zen GitSync UI</h1>
    </div>
    <div class="header-info">
      <div id="user-info" v-if="gitStore.userName && gitStore.userEmail">
        <span class="user-label">用户:</span>
        <span class="user-name">{{ gitStore.userName }}</span>
        <span class="user-email">&lt;{{ gitStore.userEmail }}&gt;</span>
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
          @status-update="handleStatusUpdate"
        />
        <LogList ref="logListRef" />
      </div>

      <!-- 创建分支对话框 -->
      <el-dialog
        v-model="createBranchDialogVisible"
        title="创建新分支"
        width="30%"
        destroy-on-close
      >
        <el-form :model="{ newBranchName, selectedBaseBranch }">
          <el-form-item label="新分支名称">
            <el-input v-model="newBranchName" placeholder="请输入新分支名称" />
          </el-form-item>
          <el-form-item label="基于分支">
            <el-select v-model="selectedBaseBranch" placeholder="选择基础分支" style="width: 100%;">
              <el-option 
                v-for="branch in gitStore.allBranches" 
                :key="branch" 
                :label="branch" 
                :value="branch"
              />
            </el-select>
          </el-form-item>
        </el-form>
        <template #footer>
          <span class="dialog-footer">
            <el-button @click="createBranchDialogVisible = false">取消</el-button>
            <el-button 
              type="primary" 
              @click="createNewBranch" 
              :loading="gitStore.isCreatingBranch"
            >
              创建
            </el-button>
          </span>
        </template>
      </el-dialog>
      
    </div>
  </div>

  <footer class="main-footer">
    <div class="branch-info" v-if="gitStore.currentBranch">
      <span class="branch-label">当前分支:</span>
      <el-select 
        v-model="gitStore.currentBranch" 
        size="small" 
        @change="handleBranchChange"
        :loading="gitStore.isChangingBranch"
        class="branch-select"
      >
        <el-option 
          v-for="branch in gitStore.allBranches" 
          :key="branch" 
          :label="branch" 
          :value="branch"
        />
      </el-select>
      <el-button 
        type="primary" 
        size="small" 
        @click="openCreateBranchDialog"
        style="margin-left: 5px;"
      >
        <el-icon><Plus /></el-icon>
      </el-button>
    </div>
    <div class="footer-right">
      <!-- <span>Zen GitSync © 2024</span> -->
    </div>
  </footer>
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
#branch-info, #user-info {
  background-color: rgba(255, 255, 255, 0.1);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 14px;
}
.branch-label, .user-label {
  font-weight: bold;
  margin-right: 5px;
}
.user-name {
  font-weight: bold;
  margin-right: 5px;
}
.user-email {
  color: #e0e0e0;
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
/* 添加分支选择框样式 */
.branch-select {
  width: 150px;
  margin-left: 5px;
}

/* 调整下拉选择框在深色背景下的样式 */
.branch-select :deep(.el-input__inner) {
  background-color: rgba(255, 255, 255, 0.1);
  color: white;
  border: none;
}

.branch-select :deep(.el-input__suffix) {
  color: white;
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
.main-footer {
  background-color: #24292e;
  color: white;
  padding: 10px 20px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 100;
}

.branch-info {
  display: flex;
  align-items: center;
}

.footer-right {
  color: rgba(255, 255, 255, 0.7);
  font-size: 12px;
}
</style>

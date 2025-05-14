<script setup lang="ts">
import { ref, onMounted } from 'vue'
import GitStatus from './components/GitStatus.vue'
import CommitForm from './components/CommitForm.vue'
import LogList from './components/LogList.vue'
import { ElMessage } from 'element-plus'
import { Plus, Setting } from '@element-plus/icons-vue'
import logo from './assets/logo.svg'
import { useGitStore } from './stores/gitStore'

const configInfo = ref('')
// 添加组件实例类型
const logListRef = ref<InstanceType<typeof LogList> | null>(null)
const gitStatusRef = ref<InstanceType<typeof GitStatus> | null>(null)

// 使用Git Store
const gitStore = useGitStore()

// 添加初始化完成状态
const initCompleted = ref(false)
const currentDirectory = ref('')

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

// 加载当前目录信息
async function loadCurrentDirectory() {
  try {
    const responseDir = await fetch('/api/current_directory')
    const dirData = await responseDir.json()
    currentDirectory.value = dirData.directory || '未知目录'
    return dirData
  } catch (error) {
    console.error('获取当前目录失败:', error)
    return { directory: '未知目录', isGitRepo: false }
  }
}

onMounted(async () => {
  console.log('---------- 页面初始化开始 ----------')
  
  try {
    // 并行加载配置和目录信息
    const [_, dirData] = await Promise.all([
      loadConfig(),
      loadCurrentDirectory()
    ])
    
    // 设置Git仓库状态
    gitStore.isGitRepo = dirData.isGitRepo === true
    gitStore.lastCheckedTime = Date.now()
    
    // 只有是Git仓库的情况下才加载Git相关信息
    if (gitStore.isGitRepo) {
      // 只获取分支和用户信息，不重复获取日志
      await Promise.all([
        gitStore.getCurrentBranch(),
        gitStore.getAllBranches(),
        gitStore.getUserInfo()
      ])
      
      // 日志信息通过LogList组件直接加载即可，避免重复调用
      // 移除 gitLogStore.fetchLog() 调用
    } else {
      ElMessage.warning('当前目录不是Git仓库，部分功能将不可用')
    }
  } catch (error) {
    console.error('初始化失败:', error)
  } finally {
    // 标记初始化完成
    initCompleted.value = true
    console.log('---------- 页面初始化完成 ----------')
  }
})

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

// 添加用户设置相关状态
const userSettingsDialogVisible = ref(false)
const tempUserName = ref('')
const tempUserEmail = ref('')

// 打开用户设置对话框
function openUserSettingsDialog() {
  tempUserName.value = gitStore.userName
  tempUserEmail.value = gitStore.userEmail
  userSettingsDialogVisible.value = true
}

// 保存用户设置
async function saveUserSettings() {
  if (!tempUserName.value || !tempUserEmail.value) {
    ElMessage.warning('用户名和邮箱不能为空')
    return
  }

  const success = await gitStore.restoreUserConfig(tempUserName.value, tempUserEmail.value)
  if (success) {
    userSettingsDialogVisible.value = false
  }
}

// 清除用户配置
async function clearUserSettings() {
  const success = await gitStore.clearUserConfig()
  if (success) {
    tempUserName.value = ''
    tempUserEmail.value = ''
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
        <el-button 
          type="primary" 
          size="small" 
          @click="openUserSettingsDialog"
          class="user-settings-btn"
          circle
        >
          <el-icon><Setting /></el-icon>
        </el-button>
      </div>
      <div id="user-info" v-else>
        <span class="user-label">用户: </span>
        <span class="user-warning">未配置</span>
        <el-button 
          type="primary" 
          size="small" 
          @click="openUserSettingsDialog"
          class="user-settings-btn"
          circle
        >
          <el-icon><Setting /></el-icon>
        </el-button>
      </div>
      <!-- <div id="config-info">{{ configInfo }}</div> -->
    </div>
  </header>
  
  <div class="container">
    <div v-if="!initCompleted" class="loading-container">
      <el-card class="loading-card">
        <div class="loading-spinner">
          <el-icon class="is-loading"><svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M512 64a32 32 0 0 1 32 32v192a32 32 0 0 1-64 0V96a32 32 0 0 1 32-32zm0 640a32 32 0 0 1 32 32v192a32 32 0 1 1-64 0V736a32 32 0 0 1 32-32zm448-192a32 32 0 0 1-32 32H736a32 32 0 1 1 0-64h192a32 32 0 0 1 32 32zm-640 0a32 32 0 0 1-32 32H96a32 32 0 0 1 0-64h192a32 32 0 0 1 32 32zM195.2 195.2a32 32 0 0 1 45.248 0L376.32 331.008a32 32 0 0 1-45.248 45.248L195.2 240.448a32 32 0 0 1 0-45.248zm452.544 452.544a32 32 0 0 1 45.248 0L828.8 783.552a32 32 0 0 1-45.248 45.248L647.744 692.992a32 32 0 0 1 0-45.248zM828.8 195.264a32 32 0 0 1 0 45.184L692.992 376.32a32 32 0 0 1-45.248-45.248l135.808-135.808a32 32 0 0 1 45.248 0zm-452.544 452.48a32 32 0 0 1 0 45.248L240.448 828.8a32 32 0 0 1-45.248-45.248l135.808-135.808a32 32 0 0 1 45.248 0z"></path></svg></el-icon>
        </div>
        <div class="loading-text">加载中...</div>
      </el-card>
    </div>
    
    <div v-else class="layout-container">
      <!-- 左侧Git状态 -->
      <div class="left-panel">
        <GitStatus 
          ref="gitStatusRef" 
          :initial-directory="currentDirectory"
        />
      </div>
      
      <!-- 右侧提交表单和历史 -->
      <div class="right-panel" v-if="gitStore.isGitRepo">
        <CommitForm />
        <LogList ref="logListRef" />
      </div>
      <div class="right-panel" v-else>
        <div class="card">
          <h2>Git仓库初始化</h2>
          <p>当前目录不是Git仓库，请先初始化Git仓库或切换到Git仓库目录。</p>
          <!-- 实用提示 -->
          <div class="tips">
            <h3>可以使用以下命令初始化仓库：</h3>
            <div class="code-block">git init</div>
          </div>
        </div>
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

  <!-- 用户设置对话框 -->
  <el-dialog
    v-model="userSettingsDialogVisible"
    title="Git用户设置"
    width="30%"
    destroy-on-close
  >
    <el-form>
      <el-form-item label="用户名">
        <el-input v-model="tempUserName" placeholder="请输入Git用户名" />
      </el-form-item>
      <el-form-item label="邮箱">
        <el-input v-model="tempUserEmail" placeholder="请输入Git邮箱" />
      </el-form-item>
      <el-form-item>
        <el-alert
          type="info"
          :closable="false"
          show-icon
        >
          这些设置将影响全局Git配置，对所有Git仓库生效。
        </el-alert>
      </el-form-item>
    </el-form>
    <template #footer>
      <span class="dialog-footer">
        <el-button 
          type="danger" 
          @click="clearUserSettings"
        >
          清除配置
        </el-button>
        <el-button @click="userSettingsDialogVisible = false">取消</el-button>
        <el-button 
          type="primary" 
          @click="saveUserSettings"
        >
          保存
        </el-button>
      </span>
    </template>
  </el-dialog>
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

.tips {
  margin-top: 20px;
  padding: 15px;
  background-color: #f5f7fa;
  border-radius: 5px;
  border-left: 4px solid #409eff;
}

.tips h3 {
  margin-top: 0;
  font-size: 16px;
  margin-bottom: 10px;
}

.code-block {
  background-color: #2d2d2d;
  color: #f8f8f2;
  font-family: monospace;
  padding: 10px 15px;
  border-radius: 4px;
  margin-bottom: 10px;
}

/* 添加加载中样式 */
.loading-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 400px;
}

.loading-card {
  width: 300px;
  text-align: center;
  padding: 30px;
}

.loading-spinner {
  font-size: 48px;
  margin-bottom: 20px;
  color: #409eff;
}

.loading-text {
  font-size: 18px;
  color: #606266;
}

.user-settings-btn {
  margin-left: 10px;
}

.user-warning {
  color: #E6A23C;
  font-weight: bold;
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

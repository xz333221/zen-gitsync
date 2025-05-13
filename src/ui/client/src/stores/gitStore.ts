import { defineStore } from 'pinia'
import { ref } from 'vue'
import { ElMessage } from 'element-plus'

export const useGitStore = defineStore('git', () => {
  // 状态
  const currentBranch = ref('')
  const allBranches = ref<string[]>([])
  const userName = ref('')
  const userEmail = ref('')
  const isChangingBranch = ref(false)
  const isCreatingBranch = ref(false)
  const isGitRepo = ref(false) // 当前目录是否是Git仓库
  
  // 检查当前目录是否是Git仓库
  async function checkGitRepo() {
    try {
      const response = await fetch('/api/current_directory')
      const data = await response.json()
      isGitRepo.value = data.isGitRepo === true
      console.log(`当前目录${isGitRepo.value ? '是' : '不是'}Git仓库`)
      return isGitRepo.value
    } catch (error) {
      console.error('检查Git仓库状态失败:', error)
      isGitRepo.value = false
      return false
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

  // 获取所有分支
  async function getAllBranches() {
    try {
      const response = await fetch('/api/branches')
      const data = await response.json()
      if (data.branches && Array.isArray(data.branches)) {
        allBranches.value = data.branches
      }
    } catch (error) {
      console.error('获取所有分支信息失败:', error)
    }
  }

  // 切换分支
  async function changeBranch(branch: string) {
    console.log('切换到分支:', branch)
    
    try {
      isChangingBranch.value = true
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ branch })
      })
      
      const result = await response.json()
      if (result.success) {
        ElMessage({
          message: `已切换到分支: ${branch}`,
          type: 'success'
        })
        
        // 刷新状态
        getCurrentBranch()
        
        return true
      } else {
        ElMessage({
          message: `切换分支失败: ${result.error}`,
          type: 'error'
        })
        return false
      }
    } catch (error) {
      ElMessage({
        message: `切换分支失败: ${(error as Error).message}`,
        type: 'error'
      })
      return false
    } finally {
      isChangingBranch.value = false
    }
  }

  // 获取Git用户信息
  async function getUserInfo() {
    try {
      const response = await fetch('/api/user-info')
      const data = await response.json()
      if (data.name && data.email) {
        userName.value = data.name
        userEmail.value = data.email
      }
    } catch (error) {
      console.error('获取用户信息失败:', error)
    }
  }

  // 创建新分支
  async function createBranch(newBranchName: string, baseBranch: string) {
    if (!newBranchName.trim()) {
      ElMessage({
        message: '分支名称不能为空',
        type: 'warning'
      })
      return false
    }
    
    try {
      isCreatingBranch.value = true
      
      const response = await fetch('/api/create-branch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          newBranchName,
          baseBranch: baseBranch || currentBranch.value
        })
      })
      
      const result = await response.json()
      if (result.success) {
        ElMessage({
          message: `已创建并切换到分支: ${newBranchName}`,
          type: 'success'
        })
        
        // 刷新状态
        getCurrentBranch()
        getAllBranches()
        
        return true
      } else {
        ElMessage({
          message: `创建分支失败: ${result.error}`,
          type: 'error'
        })
        return false
      }
    } catch (error) {
      ElMessage({
        message: `创建分支失败: ${(error as Error).message}`,
        type: 'error'
      })
      return false
    } finally {
      isCreatingBranch.value = false
    }
  }

  // 初始化加载
  async function loadInitialData() {
    // 先检查当前目录是否是Git仓库
    const isRepo = await checkGitRepo()
    
    // 只有是Git仓库的情况下才加载Git相关信息
    if (isRepo) {
      getCurrentBranch()
      getAllBranches()
      getUserInfo()
    } else {
      // 清空所有Git相关状态
      currentBranch.value = ''
      allBranches.value = []
      userName.value = ''
      userEmail.value = ''
    }
  }

  return {
    // 状态
    currentBranch,
    allBranches,
    userName,
    userEmail,
    isChangingBranch,
    isCreatingBranch,
    isGitRepo,
    
    // 方法
    checkGitRepo,
    getCurrentBranch,
    getAllBranches,
    changeBranch,
    getUserInfo,
    createBranch,
    loadInitialData
  }
}) 
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
  function loadInitialData() {
    getCurrentBranch()
    getAllBranches()
    getUserInfo()
  }

  return {
    // 状态
    currentBranch,
    allBranches,
    userName,
    userEmail,
    isChangingBranch,
    isCreatingBranch,
    
    // 方法
    getCurrentBranch,
    getAllBranches,
    changeBranch,
    getUserInfo,
    createBranch,
    loadInitialData
  }
}) 
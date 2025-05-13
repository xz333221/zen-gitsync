import { defineStore } from 'pinia'
import { ref } from 'vue'
import { ElMessage } from 'element-plus'

export const useGitLogStore = defineStore('gitLog', () => {
  // 状态
  const log = ref<any[]>([])
  const status = ref<{ staged: string[], unstaged: string[], untracked: string[] }>({
    staged: [],
    unstaged: [],
    untracked: []
  })
  const isLoadingLog = ref(false)
  const isLoadingStatus = ref(false)
  const isAddingFiles = ref(false)
  const isResetting = ref(false)
  
  // 获取提交日志
  async function fetchLog() {
    try {
      isLoadingLog.value = true
      const response = await fetch('/api/log')
      const data = await response.json()
      if (data.log && Array.isArray(data.log)) {
        log.value = data.log
      }
    } catch (error) {
      console.error('获取提交历史失败:', error)
      ElMessage({
        message: `获取提交历史失败: ${(error as Error).message}`,
        type: 'error'
      })
    } finally {
      isLoadingLog.value = false
    }
  }
  
  // 获取Git状态
  async function fetchStatus() {
    try {
      isLoadingStatus.value = true
      const response = await fetch('/api/status')
      const data = await response.json()
      if (data.status) {
        status.value = {
          staged: data.status.staged || [],
          unstaged: data.status.unstaged || [],
          untracked: data.status.untracked || []
        }
      }
    } catch (error) {
      console.error('获取Git状态失败:', error)
      ElMessage({
        message: `获取Git状态失败: ${(error as Error).message}`,
        type: 'error'
      })
    } finally {
      isLoadingStatus.value = false
    }
  }
  
  // 添加文件到暂存区 (git add .)
  async function addToStage() {
    try {
      isAddingFiles.value = true
      const response = await fetch('/api/add', {
        method: 'POST'
      })
      
      const result = await response.json()
      if (result.success) {
        ElMessage({
          message: '文件已添加到暂存区',
          type: 'success'
        })
        
        // 刷新状态
        fetchStatus()
        
        return true
      } else {
        ElMessage({
          message: `添加文件失败: ${result.error}`,
          type: 'error'
        })
        return false
      }
    } catch (error) {
      ElMessage({
        message: `添加文件失败: ${(error as Error).message}`,
        type: 'error'
      })
      return false
    } finally {
      isAddingFiles.value = false
    }
  }
  
  // 提交更改
  async function commitChanges(message: string, noVerify = false) {
    try {
      const response = await fetch('/api/commit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          message,
          hasNewlines: message.includes('\n'),
          noVerify
        })
      })
      
      const result = await response.json()
      if (result.success) {
        ElMessage({
          message: '提交成功',
          type: 'success'
        })
        
        // 刷新状态和日志
        fetchStatus()
        fetchLog()
        
        return true
      } else {
        ElMessage({
          message: `提交失败: ${result.error}`,
          type: 'error'
        })
        return false
      }
    } catch (error) {
      ElMessage({
        message: `提交失败: ${(error as Error).message}`,
        type: 'error'
      })
      return false
    }
  }
  
  // 推送到远程
  async function pushToRemote() {
    try {
      const response = await fetch('/api/push', {
        method: 'POST'
      })
      
      const result = await response.json()
      if (result.success) {
        ElMessage({
          message: '推送成功',
          type: 'success'
        })
        
        // 刷新日志
        fetchLog()
        
        return true
      } else {
        ElMessage({
          message: `推送失败: ${result.error}`,
          type: 'error'
        })
        return false
      }
    } catch (error) {
      ElMessage({
        message: `推送失败: ${(error as Error).message}`,
        type: 'error'
      })
      return false
    }
  }
  
  // 暂存并提交
  async function addAndCommit(message: string, noVerify = false) {
    try {
      // 先添加到暂存区
      const addResult = await addToStage()
      if (!addResult) {
        return false
      }
      
      // 再提交
      return await commitChanges(message, noVerify)
    } catch (error) {
      ElMessage({
        message: `暂存并提交失败: ${(error as Error).message}`,
        type: 'error'
      })
      return false
    }
  }
  
  // 暂存、提交并推送
  async function addCommitAndPush(message: string, noVerify = false) {
    try {
      // 先添加并提交
      const commitResult = await addAndCommit(message, noVerify)
      if (!commitResult) {
        return false
      }
      
      // 再推送
      return await pushToRemote()
    } catch (error) {
      ElMessage({
        message: `暂存、提交并推送失败: ${(error as Error).message}`,
        type: 'error'
      })
      return false
    }
  }
  
  // 重置暂存区 (git reset HEAD)
  async function resetHead() {
    try {
      isResetting.value = true
      const response = await fetch('/api/reset-head', {
        method: 'POST'
      })
      
      const result = await response.json()
      if (result.success) {
        ElMessage({
          message: '已重置暂存区',
          type: 'success'
        })
        
        // 刷新状态
        fetchStatus()
        
        return true
      } else {
        ElMessage({
          message: `重置暂存区失败: ${result.error}`,
          type: 'error'
        })
        return false
      }
    } catch (error) {
      ElMessage({
        message: `重置暂存区失败: ${(error as Error).message}`,
        type: 'error'
      })
      return false
    } finally {
      isResetting.value = false
    }
  }
  
  // 重置当前分支到远程状态
  async function resetToRemote(branch: string) {
    try {
      isResetting.value = true
      const response = await fetch('/api/reset-to-remote', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ branch })
      })
      
      const result = await response.json()
      if (result.success) {
        ElMessage({
          message: `已重置分支 ${branch} 到远程状态`,
          type: 'success'
        })
        
        // 刷新状态和日志
        fetchStatus()
        fetchLog()
        
        return true
      } else {
        ElMessage({
          message: `重置分支失败: ${result.error}`,
          type: 'error'
        })
        return false
      }
    } catch (error) {
      ElMessage({
        message: `重置分支失败: ${(error as Error).message}`,
        type: 'error'
      })
      return false
    } finally {
      isResetting.value = false
    }
  }
  
  // 暂存文件
  async function stageFiles(files: string[]) {
    try {
      const response = await fetch('/api/stage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ files })
      })
      
      const result = await response.json()
      if (result.success) {
        ElMessage({
          message: '暂存文件成功',
          type: 'success'
        })
        
        // 刷新状态
        fetchStatus()
        
        return true
      } else {
        ElMessage({
          message: `暂存文件失败: ${result.error}`,
          type: 'error'
        })
        return false
      }
    } catch (error) {
      ElMessage({
        message: `暂存文件失败: ${(error as Error).message}`,
        type: 'error'
      })
      return false
    }
  }
  
  // 取消暂存文件
  async function unstageFiles(files: string[]) {
    try {
      const response = await fetch('/api/unstage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ files })
      })
      
      const result = await response.json()
      if (result.success) {
        ElMessage({
          message: '取消暂存成功',
          type: 'success'
        })
        
        // 刷新状态
        fetchStatus()
        
        return true
      } else {
        ElMessage({
          message: `取消暂存失败: ${result.error}`,
          type: 'error'
        })
        return false
      }
    } catch (error) {
      ElMessage({
        message: `取消暂存失败: ${(error as Error).message}`,
        type: 'error'
      })
      return false
    }
  }
  
  return {
    // 状态
    log,
    status,
    isLoadingLog,
    isLoadingStatus,
    isAddingFiles,
    isResetting,
    
    // 方法
    fetchLog,
    fetchStatus,
    addToStage,
    commitChanges,
    pushToRemote,
    addAndCommit,
    addCommitAndPush,
    resetHead,
    resetToRemote,
    stageFiles,
    unstageFiles
  }
}) 
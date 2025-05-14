import { defineStore } from 'pinia'
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useGitStore } from './gitStore'

export const useGitLogStore = defineStore('gitLog', () => {
  // 引用gitStore获取仓库状态
  const gitStore = useGitStore()
  
  // 状态
  const log = ref<any[]>([])
  const status = ref<{ staged: string[], unstaged: string[], untracked: string[] }>({
    staged: [],
    unstaged: [],
    untracked: []
  })
  // 添加fileList状态用于保存porcelain格式的状态
  const fileList = ref<{path: string, type: string}[]>([])
  const isLoadingLog = ref(false)
  const isLoadingStatus = ref(false)
  const isAddingFiles = ref(false)
  const isCommiting = ref(false)
  const isPushing = ref(false)
  const isResetting = ref(false)
  
  // 解析 git status --porcelain 输出，提取文件及类型
  function parseStatusPorcelain(statusText: string) {
    if (statusText === undefined) return
    const lines = statusText.split('\n')
    const files: {path: string, type: string}[] = []
    for (const line of lines) {
      // 匹配常见的 git status --porcelain 格式
      // M: 修改, A: 新增, D: 删除, ??: 未跟踪
      const match = line.match(/^([ MADRCU\?]{2})\s+(.+)$/)
      if (match) {
        let type = ''
        const code = match[1].trim()
        if (code === 'M' || code === 'MM' || code === 'AM' || code === 'RM') type = 'modified'
        else if (code === 'A' || code === 'AA') type = 'added'
        else if (code === 'D' || code === 'AD' || code === 'DA') type = 'deleted'
        else if (code === '??') type = 'untracked'
        else type = 'other'
        files.push({ path: match[2], type })
      }
    }
    fileList.value = files
  }
  
  // 获取提交日志
  async function fetchLog() {
    // 检查是否是Git仓库
    if (!gitStore.isGitRepo) {
      console.log('当前目录不是Git仓库，跳过加载提交历史')
      return
    }
    
    try {
      isLoadingLog.value = true
      console.log('开始加载提交历史...')
      const response = await fetch('/api/log')
      const data = await response.json()
      if (data.log && Array.isArray(data.log)) {
        log.value = data.log
      }
      console.log(`提交历史加载完成，共 ${log.value.length} 条记录`)
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
    // 检查是否是Git仓库
    if (!gitStore.isGitRepo) {
      console.log('当前目录不是Git仓库，跳过加载Git状态')
      return
    }
    
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
      
      // 同时获取porcelain格式的状态
      await fetchStatusPorcelain()
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
  
  // 获取Git状态 (porcelain格式)
  async function fetchStatusPorcelain() {
    // 检查是否是Git仓库
    if (!gitStore.isGitRepo) {
      console.log('当前目录不是Git仓库，跳过加载Git状态')
      return
    }
    
    try {
      const response = await fetch('/api/status_porcelain')
      const data = await response.json()
      if (data.status) {
        parseStatusPorcelain(data.status)
      }
    } catch (error) {
      console.error('获取Git状态(porcelain)失败:', error)
      ElMessage({
        message: `获取Git状态(porcelain)失败: ${(error as Error).message}`,
        type: 'error'
      })
      // 清空文件列表
      fileList.value = []
    }
  }
  
  // 添加文件到暂存区 (git add .)
  async function addToStage() {
    // 检查是否是Git仓库
    if (!gitStore.isGitRepo) {
      ElMessage.warning('当前目录不是Git仓库')
      return false
    }
    
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
    // 检查是否是Git仓库
    if (!gitStore.isGitRepo) {
      ElMessage.warning('当前目录不是Git仓库')
      return false
    }
    
    try {
      isCommiting.value = true
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
    } finally {
      isCommiting.value = false
    }
  }
  
  // 推送到远程
  async function pushToRemote() {
    // 检查是否是Git仓库
    if (!gitStore.isGitRepo) {
      ElMessage.warning('当前目录不是Git仓库')
      return false
    }
    
    try {
      isPushing.value = true
      const response = await fetch('/api/push', {
        method: 'POST'
      })
      
      const result = await response.json()
      if (result.success) {
        ElMessage({
          message: '推送成功',
          type: 'success'
        })
        // 刷新状态
        fetchStatus()
        
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
    } finally {
      isPushing.value = false
    }
  }
  
  // 暂存并提交
  async function addAndCommit(message: string, noVerify = false) {
    await addToStage()
    await commitChanges(message, noVerify)
  }
  
  // 暂存、提交并推送
  async function addCommitAndPush(message: string, noVerify = false) {
    await addToStage()
    await commitChanges(message, noVerify)
    await pushToRemote()
  }
  
  // 重置暂存区 (git reset HEAD)
  async function resetHead() {
    // 检查是否是Git仓库
    if (!gitStore.isGitRepo) {
      ElMessage.warning('当前目录不是Git仓库')
      return false
    }
    
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
    // 检查是否是Git仓库
    if (!gitStore.isGitRepo) {
      ElMessage.warning('当前目录不是Git仓库')
      return false
    }
    
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
    // 检查是否是Git仓库
    if (!gitStore.isGitRepo) {
      ElMessage.warning('当前目录不是Git仓库')
      return false
    }
    
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
    // 检查是否是Git仓库
    if (!gitStore.isGitRepo) {
      ElMessage.warning('当前目录不是Git仓库')
      return false
    }
    
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
    fileList,
    isLoadingLog,
    isLoadingStatus,
    isAddingFiles,
    isResetting,
    isCommiting,
    isPushing,
    
    // 方法
    fetchLog,
    fetchStatus,
    fetchStatusPorcelain,
    parseStatusPorcelain,
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
import { defineStore } from 'pinia'
import { ref, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { useGitStore } from './gitStore'
import { io, Socket } from 'socket.io-client'

// 定义Git操作间隔时间（毫秒）
const GIT_OPERATION_DELAY = 300

export const useGitLogStore = defineStore('gitLog', () => {
  // 引用gitStore获取仓库状态
  const gitStore = useGitStore()
  
  // 定义socket连接
  let socket: Socket | null = null
  // 自动更新状态开关
  const autoUpdateEnabled = ref(true)
  
  // 状态
  const log = ref<any[]>([])
  const status = ref<{ staged: string[], unstaged: string[], untracked: string[] }>({
    staged: [],
    unstaged: [],
    untracked: []
  })
  // 添加Git状态文本
  const statusText = ref('')
  // 添加fileList状态用于保存porcelain格式的状态
  const fileList = ref<{path: string, type: string}[]>([])
  const isLoadingLog = ref(false)
  const isLoadingStatus = ref(false)
  const isAddingFiles = ref(false)
  const isCommiting = ref(false)
  const isPushing = ref(false)
  const isResetting = ref(false)
  
  // Socket.io连接处理
  function initSocketConnection() {
    // 如果已经有socket连接，先断开
    if (socket) {
      socket.disconnect()
    }
    
    // 创建新连接
    try {
      // 修正Socket.IO连接URL，使用固定的后端服务器端口3000
      const backendUrl = window.location.hostname === 'localhost' ? 
        'http://localhost:3000' : window.location.origin
      
      console.log('尝试连接Socket.IO服务器:', backendUrl)
      
      socket = io(backendUrl, {
        reconnectionDelayMax: 10000,
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000, // 初始重连延迟1秒
        timeout: 20000, // 连接超时时间
        autoConnect: true, // 自动连接
        forceNew: true, // 强制创建新连接
        transports: ['websocket', 'polling'] // 优先使用WebSocket
      })
      
      // 检查socket是否成功创建
      if (!socket) {
        console.error('Socket.IO初始化失败: socket为null')
        return
      }
      console.log('Socket.IO初始化成功，socket ID:', socket.id || '未连接')

      // 监听连接事件
      socket.on('connect', () => {
        console.log('成功连接到Socket.IO服务器')
        
        // 如果自动更新开启，向服务器请求开始监控
        if (autoUpdateEnabled.value && socket) {
          socket.emit('start_monitoring')
        }
      })
      
      // 监听断开连接事件
      socket.on('disconnect', (reason) => {
        console.log('与Socket.IO服务器断开连接:', reason)
      })
      
      // 监听Git状态更新事件
      socket.on('git_status_update', (data) => {
        if (!autoUpdateEnabled.value) return
        
        console.log('收到Git状态更新通知:', new Date().toLocaleTimeString())
        
        // 更新状态文本
        if (data.status) {
          statusText.value = data.status
        }
        
        // 更新文件列表
        if (data.porcelain !== undefined) {
          parseStatusPorcelain(data.porcelain)
        }
        
        // 根据文件列表判断是否需要更新日志
        const hasChanges = fileList.value.length > 0
        
        // 如果有变化，更新状态
        if (hasChanges) {
          // 自动刷新日志，但不要显示消息通知
          fetchLog(false)
        }
      })
      
      // 监听监控状态
      socket.on('monitoring_status', (data) => {
        console.log('文件监控状态:', data.active ? '已启动' : '已停止')
      })
      
      // 添加额外的连接问题诊断
      socket.on('connect_error', (error) => {
        console.error('Socket连接错误:', error.message)
      })
      
      socket.on('connect_timeout', () => {
        console.error('Socket连接超时')
      })
      
      socket.on('reconnect', (attemptNumber) => {
        console.log(`Socket重连成功，尝试次数: ${attemptNumber}`)
        
        // 重连后检查自动更新状态
        if (autoUpdateEnabled.value) {
          console.log('重连后重新发送start_monitoring请求')
          socket.emit('start_monitoring')
        }
      })
      
      socket.on('reconnect_attempt', (attemptNumber) => {
        console.log(`Socket尝试重连，第 ${attemptNumber} 次尝试`)
      })
      
      socket.on('reconnect_error', (error) => {
        console.error('Socket重连错误:', error.message)
      })
      
      socket.on('reconnect_failed', () => {
        console.error('Socket重连失败，已达到最大重试次数')
      })
      
      // 手动尝试连接
      if (socket && !socket.connected) {
        console.log('Socket未连接，尝试手动连接...')
        socket.connect()
      }
    } catch (error) {
      console.error('Socket.IO连接初始化失败:', error)
    }
  }
  
  // 切换自动更新状态
  function toggleAutoUpdate() {
    // autoUpdateEnabled.value = !autoUpdateEnabled.value
    console.log('toggleAutoUpdate调用，当前值:', autoUpdateEnabled.value)
    
    if (!socket) {
      console.error('无法切换自动更新状态: socket连接不存在')
      ElMessage.error('无法连接到服务器，自动更新可能不会生效')
      
      // 尝试重新初始化socket连接
      console.log('尝试重新建立socket连接...')
      initSocketConnection()
      
      // 即使socket可能不存在，也保存设置
      localStorage.setItem('zen-gitsync-auto-update', autoUpdateEnabled.value.toString())
      return
    }
    
    try {
      if (autoUpdateEnabled.value) {
        console.log('发送start_monitoring命令...')
        socket.emit('start_monitoring')
        ElMessage.success('自动更新已启用')
      } else {
        console.log('发送stop_monitoring命令...')
        socket.emit('stop_monitoring')
        ElMessage.info('自动更新已禁用')
      }
      
      // 保存设置到localStorage
      localStorage.setItem('zen-gitsync-auto-update', autoUpdateEnabled.value.toString())
      console.log('已保存自动更新设置到本地存储:', autoUpdateEnabled.value)
    } catch (error) {
      console.error('切换自动更新状态时出错:', error)
      ElMessage.error(`切换自动更新失败: ${(error as Error).message}`)
    }
  }
  
  // 解析 git status --porcelain 输出，提取文件及类型
  function parseStatusPorcelain(statusText: string) {
    if (statusText === undefined || statusText === '') {
      // 如果状态为空字符串，清空文件列表
      fileList.value = []
      return
    }
    
    const lines = statusText.split('\n')
    const files: {path: string, type: string}[] = []
    for (const line of lines) {
      // 匹配常见的 git status --porcelain 格式
      // M: 修改, A: 新增, D: 删除, ??: 未跟踪
      const match = line.match(/^([ MADRCU\?]{2})\s+(.+)$/)
      if (match) {
        let type = ''
        const code = match[1]
        const indexStatus = code.charAt(0)
        const workTreeStatus = code.charAt(1)
        
        // 根据暂存区状态和工作区状态确定文件类型
        if (indexStatus === 'A') {
          // 已暂存的新文件
          type = 'added'
        } else if (indexStatus === 'M') {
          // 已暂存的修改文件
          type = 'added'
        } else if (indexStatus === 'D') {
          // 已暂存的删除文件
          type = 'added'
        } else if (indexStatus === 'R') {
          // 已暂存的重命名文件
          type = 'added'
        } else if (indexStatus === ' ' && workTreeStatus === 'M') {
          // 已修改未暂存的文件
          type = 'modified'
        } else if (indexStatus === ' ' && workTreeStatus === 'D') {
          // 已删除未暂存的文件
          type = 'deleted'
        } else if (code === '??') {
          // 未跟踪的文件
          type = 'untracked'
        } else {
          // 其他情况
          type = 'other'
        }
        
        files.push({ path: match[2], type })
      }
    }
    fileList.value = files
  }
  
  // 获取提交日志
  async function fetchLog(showMessage = true) {
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
      if (data && Array.isArray(data)) {
        log.value = data
      }
      console.log(`提交历史加载完成，共 ${log.value.length} 条记录`)
      
      if (showMessage) {
        ElMessage({
          message: '提交历史已更新',
          type: 'success'
        })
      }
    } catch (error) {
      console.error('获取提交历史失败:', error)
      if (showMessage) {
        ElMessage({
          message: `获取提交历史失败: ${(error as Error).message}`,
          type: 'error'
        })
      }
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
        // 更新状态文本
        statusText.value = data.status
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
    console.log('开始获取Git状态(porcelain格式)...')
    // 检查是否是Git仓库
    if (!gitStore.isGitRepo) {
      console.log('当前目录不是Git仓库，跳过加载Git状态')
      return
    }
    
    try {
      const response = await fetch('/api/status_porcelain')
      const data = await response.json()
      if (data.status !== undefined) {
        parseStatusPorcelain(data.status)
      } else {
        // 如果没有收到有效的 status 字段，清空文件列表
        fileList.value = []
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
  
  // 添加单个文件到暂存区
  async function addFileToStage(filePath: string) {
    // 检查是否是Git仓库
    if (!gitStore.isGitRepo) {
      ElMessage.warning('当前目录不是Git仓库')
      return false
    }
    
    try {
      isAddingFiles.value = true
      const response = await fetch('/api/add-file', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ filePath })
      })
      
      const result = await response.json()
      if (result.success) {
        ElMessage({
          message: '文件已暂存',
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
    } finally {
      isAddingFiles.value = false
    }
  }
  
  // 取消暂存单个文件
  async function unstageFile(filePath: string) {
    // 检查是否是Git仓库
    if (!gitStore.isGitRepo) {
      ElMessage.warning('当前目录不是Git仓库')
      return false
    }
    
    try {
      isResetting.value = true
      const response = await fetch('/api/unstage-file', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ filePath })
      })
      
      const result = await response.json()
      if (result.success) {
        ElMessage({
          message: '已取消暂存文件',
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
    } finally {
      isResetting.value = false
    }
  }
  
  // 添加延时函数
  function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
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
    const addResult = await addToStage()
    if (!addResult) return false
    
    // 使用新的延时常量
    await delay(GIT_OPERATION_DELAY)
    
    return await commitChanges(message, noVerify)
  }
  
  // 暂存、提交并推送
  async function addCommitAndPush(message: string, noVerify = false) {
    try {
      const addResult = await addToStage()
      if (!addResult) return false
      
      // 使用新的延时常量
      await delay(GIT_OPERATION_DELAY)
      
      const commitResult = await commitChanges(message, noVerify)
      if (!commitResult) return false
      
      // 使用新的延时常量
      await delay(GIT_OPERATION_DELAY)
      
      return await pushToRemote()
    } catch (error) {
      // 如果发生错误，尝试删除 index.lock 文件
      try {
        const response = await fetch('/api/remove-lock', {
          method: 'POST'
        })
        const result = await response.json()
        if (result.success) {
          ElMessage({
            message: '已清理锁定文件，请重试操作',
            type: 'warning'
          })
        }
      } catch (e) {
        console.error('清理锁定文件失败:', e)
      }
      
      ElMessage({
        message: `操作失败: ${(error as Error).message}`,
        type: 'error'
      })
      return false
    }
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
  
  // 在组件挂载时初始化socket连接
  onMounted(() => {
    // 从localStorage加载自动更新设置
    const savedAutoUpdate = localStorage.getItem('zen-gitsync-auto-update')
    if (savedAutoUpdate !== null) {
      autoUpdateEnabled.value = savedAutoUpdate === 'true'
    }
    
    initSocketConnection()
  })
  
  // 在组件卸载时断开socket连接
  onUnmounted(() => {
    if (socket) {
      socket.disconnect()
      socket = null
    }
  })
  
  return {
    // 状态
    log,
    status,
    statusText,
    fileList,
    isLoadingLog,
    isLoadingStatus,
    isAddingFiles,
    isResetting,
    isCommiting,
    isPushing,
    autoUpdateEnabled,
    
    // 方法
    fetchLog,
    fetchStatus,
    fetchStatusPorcelain,
    parseStatusPorcelain,
    addToStage,
    addFileToStage,
    unstageFile,
    commitChanges,
    pushToRemote,
    addAndCommit,
    addCommitAndPush,
    resetHead,
    resetToRemote,
    toggleAutoUpdate
  }
}) 
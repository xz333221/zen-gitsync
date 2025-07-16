import { defineStore } from 'pinia'
import { ref, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { io, Socket } from 'socket.io-client'

// 定义Git操作间隔时间（毫秒）
const GIT_OPERATION_DELAY = 300

// 获取后端服务器端口
function getBackendPort() {
  // 优先从环境变量中读取端口
  const envPort = import.meta.env.VITE_BACKEND_PORT;
  if (envPort) {
    console.log(`从环境变量读取后端端口: ${envPort}`);
    return parseInt(envPort, 10);
  }

  // 在浏览器环境中，使用当前页面的URL来确定端口
  try {
    const currentPort = window.location.port;
    
    // 开发环境使用后端默认端口3000
    if (currentPort === '5173' || currentPort === '4173') {
      console.log('开发环境，使用后端默认端口: 3000');
      return 3000;
    }
    
    // 生产环境时，前后端通常部署在同一端口
    if (currentPort) {
      console.log(`使用当前页面端口作为后端端口: ${currentPort}`);
      return parseInt(currentPort, 10);
    }
  } catch (error) {
    console.error('获取后端端口失败:', error);
  }
  
  // 默认端口
  console.log('使用默认后端端口: 3000');
  return 3000;
}

// 获取后端端口
const backendPort = getBackendPort()

export const useGitStore = defineStore('git', () => {
  // 状态
  const currentBranch = ref('')
  const allBranches = ref<string[]>([])
  const userName = ref('')
  const userEmail = ref('')
  const isChangingBranch = ref(false)
  const isCreatingBranch = ref(false)
  const isGitRepo = ref(false) // 当前目录是否是Git仓库
  const lastCheckedTime = ref(0) // 上次检查Git仓库状态的时间戳

  // 添加远程仓库地址状态
  const remoteUrl = ref('') // 远程仓库地址
  const isLoadingRemoteUrl = ref(false) // 加载远程仓库地址的状态

  // 新增Git操作状态
  const isPushing = ref(false)         // 推送中状态
  const isGitPulling = ref(false)      // 拉取中状态
  const isGitFetching = ref(false)     // 获取远程分支信息状态
  const isGitMerging = ref(false)      // 合并分支状态
  
  // 添加分支状态相关变量
  const branchAhead = ref(0) // 当前分支领先远程分支的提交数
  const branchBehind = ref(0) // 当前分支落后远程分支的提交数
  const hasUpstream = ref(false) // 当前分支是否有上游分支
  const upstreamBranch = ref('') // 上游分支名称
  // 添加上次获取分支状态的时间戳
  const lastBranchStatusTime = ref(0)
  // 添加上次获取分支列表的时间戳
  const lastBranchesTime = ref(0)

  // 从 gitLogStore 导入的状态
  // 定义socket连接
  let socket: Socket | null = null
  // 自动更新状态开关
  const autoUpdateEnabled = ref(true)
  
  // Socket.io 实例
  const socketRef = ref<Socket | null>(null);
  
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
  const isResetting = ref(false)
  
  // 在状态部分添加stash相关的状态变量
  const stashes = ref<{ id: string; description: string }[]>([])
  const isLoadingStashes = ref(false)
  const isApplyingStash = ref(false)
  const isDroppingStash = ref(false)
  const isSavingStash = ref(false)
  
  // 添加重置方法
  function $reset() {
    currentBranch.value = ''
    allBranches.value = []
    userName.value = ''
    userEmail.value = ''
    isChangingBranch.value = false
    isCreatingBranch.value = false
    isGitRepo.value = false
    lastCheckedTime.value = 0
    branchAhead.value = 0
    branchBehind.value = 0
    hasUpstream.value = false
    upstreamBranch.value = ''
    lastBranchStatusTime.value = 0
    lastBranchesTime.value = 0
    isPushing.value = false
    isGitPulling.value = false
    isGitFetching.value = false
    isGitMerging.value = false
    remoteUrl.value = '' // 重置远程仓库地址
    isLoadingRemoteUrl.value = false
    
    // 重置gitLogStore的状态
    log.value = []
    status.value = {
      staged: [],
      unstaged: [],
      untracked: []
    }
    statusText.value = ''
    fileList.value = []
    isLoadingLog.value = false
    isLoadingStatus.value = false
    isAddingFiles.value = false
    isCommiting.value = false
    isResetting.value = false
    // 不重置autoUpdateEnabled，保留用户设置
  }

  // 获取分支状态（领先/落后远程）
  async function getBranchStatus() {
    if (!isGitRepo.value) return;
    
    // 移除时间戳缓存判断，简化逻辑
    try {
      console.log('获取分支状态...');
      const response = await fetch('/api/branch-status');
      const data = await response.json();
      
      if (data) {
        branchAhead.value = data.ahead || 0;
        branchBehind.value = data.behind || 0;
        hasUpstream.value = data.hasUpstream || false;
        upstreamBranch.value = data.upstreamBranch || '';
        
        // 更新获取时间戳
        lastBranchStatusTime.value = Date.now();
        
        // 添加调试日志
        console.log(`分支状态更新：领先 ${branchAhead.value} 个提交，落后 ${branchBehind.value} 个提交，上游分支：${hasUpstream.value ? upstreamBranch.value : '无'}`);
      }
    } catch (error) {
      console.error('获取分支状态失败:', error);
      // 出错时重置状态
      branchAhead.value = 0;
      branchBehind.value = 0;
      hasUpstream.value = false;
      upstreamBranch.value = '';
    }
  }

  // 检查当前目录是否是Git仓库
  async function checkGitRepo() {
    // 如果距离上次检查不到1秒，直接返回缓存的结果
    const now = Date.now()
    if (now - lastCheckedTime.value < 1000) {
      console.log('使用缓存的Git仓库状态:', isGitRepo.value ? '是' : '不是')
      return isGitRepo.value
    }
    
    try {
      const response = await fetch('/api/current_directory')
      const data = await response.json()
      isGitRepo.value = data.isGitRepo === true
      lastCheckedTime.value = now // 更新检查时间
      console.log(`当前目录${isGitRepo.value ? '是' : '不是'}Git仓库`)
      return isGitRepo.value
    } catch (error) {
      console.error('检查Git仓库状态失败:', error)
      isGitRepo.value = false
      lastCheckedTime.value = now // 即使失败也更新检查时间，避免频繁重试
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
        // 不再在这里调用 getBranchStatus
      }
    } catch (error) {
      console.error('获取分支信息失败:', error)
    }
  }

  // 获取所有分支
  async function getAllBranches() {
    if (!isGitRepo.value) return;
    
    // 移除时间戳缓存判断，简化逻辑
    try {
      console.log('获取所有分支...');
      const response = await fetch('/api/branches')
      const data = await response.json()
      if (data.branches && Array.isArray(data.branches)) {
        allBranches.value = data.branches
        // 更新获取时间戳
        lastBranchesTime.value = Date.now();
        console.log(`获取到${data.branches.length}个分支`);
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
        
        // 分别刷新分支信息和分支状态
        await getCurrentBranch()
        await getBranchStatus()
        
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
        
        // 分别刷新分支信息和状态
        await getCurrentBranch()
        await getBranchStatus()
        await getAllBranches()
        
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

  // 清除Git用户配置
  async function clearUserConfig() {
    try {
      const response = await fetch('/api/clear-user-config', {
        method: 'POST'
      });
      
      const result = await response.json();
      if (result.success) {
        // 清空本地状态
        userName.value = '';
        userEmail.value = '';
        ElMessage({
          message: '已清除Git用户配置',
          type: 'success'
        });
        return true;
      } else {
        ElMessage({
          message: `清除配置失败: ${result.error}`,
          type: 'error'
        });
        return false;
      }
    } catch (error) {
      ElMessage({
        message: `清除配置失败: ${(error as Error).message}`,
        type: 'error'
      });
      return false;
    }
  }

  // 恢复Git用户配置
  async function restoreUserConfig(name: string, email: string) {
    try {
      const response = await fetch('/api/restore-user-config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name, email })
      });
      
      const result = await response.json();
      if (result.success) {
        // 更新本地状态
        userName.value = name;
        userEmail.value = email;
        ElMessage({
          message: '已恢复Git用户配置',
          type: 'success'
        });
        return true;
      } else {
        ElMessage({
          message: `恢复配置失败: ${result.error}`,
          type: 'error'
        });
        return false;
      }
    } catch (error) {
      ElMessage({
        message: `恢复配置失败: ${(error as Error).message}`,
        type: 'error'
      });
      return false;
    }
  }

  // 执行git pull操作
  async function gitPull() {
    if (!isGitRepo.value) {
      ElMessage({
        message: '当前目录不是Git仓库',
        type: 'warning'
      });
      return false;
    }

    try {
      // 显示加载中状态
      isGitPulling.value = true;
      const response = await fetch('/api/pull', {
        method: 'POST'
      });
      
      const result = await response.json();
      if (result.success) {
        ElMessage({
          message: '拉取成功',
          type: 'success'
        });
        
        // 刷新分支状态
        await getBranchStatus();
        return true;
      } else {
        // 改进错误提示
        if (result.needsMerge) {
          ElMessage({
            message: `需要合并更改: ${result.pullOutput || '存在冲突需要手动解决'}`,
            type: 'warning',
            duration: 5000
          });
        } else {
          ElMessage({
            message: `拉取失败: ${result.error}`,
            type: 'error'
          });
        }
        return false;
      }
    } catch (error) {
      ElMessage({
        message: `拉取失败: ${(error as Error).message}`,
        type: 'error'
      });
      return false;
    } finally {
      // 隐藏加载中状态
      isGitPulling.value = false;
    }
  }

  // 执行git fetch --all操作
  async function gitFetchAll() {
    if (!isGitRepo.value) {
      ElMessage({
        message: '当前目录不是Git仓库',
        type: 'warning'
      });
      return false;
    }

    try {
      isGitFetching.value = true;
      const response = await fetch('/api/fetch-all', {
        method: 'POST'
      });
      
      const result = await response.json();
      if (result.success) {
        ElMessage({
          message: '获取所有远程分支信息成功',
          type: 'success'
        });
        
        // 刷新分支状态
        await getBranchStatus();
        return true;
      } else {
        ElMessage({
          message: `获取远程分支信息失败: ${result.error}`,
          type: 'error'
        });
        return false;
      }
    } catch (error) {
      ElMessage({
        message: `获取远程分支信息失败: ${(error as Error).message}`,
        type: 'error'
      });
      return false;
    } finally {
      isGitFetching.value = false;
    }
  }

  // 从 gitLogStore 合并过来的方法
  // Socket.io连接处理
  function initSocketConnection() {
    // 如果已经有socket连接，先断开
    if (socketRef.value) {
      socketRef.value.disconnect()
    }
    
    // 创建新连接
    try {
      // 使用动态端口连接Socket.IO服务器
      const backendUrl = `http://localhost:${backendPort}`
      
      console.log('尝试连接Socket.IO服务器:', backendUrl)
      
      socketRef.value = io(backendUrl, {
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
      if (!socketRef.value) {
        console.error('Socket.IO初始化失败: socket为null')
        return
      }
      console.log('Socket.IO初始化成功，socket ID:', socketRef.value.id || '未连接')

      // 监听连接事件
      socketRef.value.on('connect', () => {
        console.log('成功连接到Socket.IO服务器')
        
        // 如果自动更新开启，向服务器请求开始监控
        if (autoUpdateEnabled.value && socketRef.value) {
          socketRef.value.emit('start_monitoring')
        }
      })
      
      // 监听断开连接事件
      socketRef.value.on('disconnect', (reason) => {
        console.log('与Socket.IO服务器断开连接:', reason)
      })
      
      // 监听Git状态更新事件
      socketRef.value.on('git_status_update', (data) => {
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
      })
      
      // 监听监控状态
      socketRef.value.on('monitoring_status', (data) => {
        console.log('文件监控状态:', data.active ? '已启动' : '已停止')
      })
      
      // 添加额外的连接问题诊断
      socketRef.value.on('connect_error', (error) => {
        console.error('Socket连接错误:', error.message)
      })
      
      socketRef.value.on('connect_timeout', () => {
        console.error('Socket连接超时')
      })
      
      socketRef.value.on('reconnect', (attemptNumber) => {
        console.log(`Socket重连成功，尝试次数: ${attemptNumber}`)
        
        // 重连后检查自动更新状态
        if (autoUpdateEnabled.value) {
          console.log('重连后重新发送start_monitoring请求')
          socketRef.value?.emit('start_monitoring')
        }
      })
      
      socketRef.value.on('reconnect_attempt', (attemptNumber) => {
        console.log(`Socket尝试重连，第 ${attemptNumber} 次尝试`)
      })
      
      socketRef.value.on('reconnect_error', (error) => {
        console.error('Socket重连错误:', error.message)
      })
      
      socketRef.value.on('reconnect_failed', () => {
        console.error('Socket重连失败，已达到最大重试次数')
      })
      
      // 手动尝试连接
      if (socketRef.value && !socketRef.value.connected) {
        console.log('Socket未连接，尝试手动连接...')
        socketRef.value.connect()
      }
    } catch (error) {
      console.error('Socket.IO连接初始化失败:', error)
    }
  }
  
  // 切换自动更新状态
  function toggleAutoUpdate() {
    console.log('toggleAutoUpdate调用，当前值:', autoUpdateEnabled.value)
    
    if (!socketRef.value) {
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
        socketRef.value.emit('start_monitoring')
        ElMessage.success('自动更新已启用')
      } else {
        console.log('发送stop_monitoring命令...')
        socketRef.value.emit('stop_monitoring')
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
    if (!isGitRepo.value) {
      console.log('当前目录不是Git仓库，跳过加载提交历史')
      return
    }
    
    try {
      isLoadingLog.value = true
      console.log('开始加载提交历史...')
      
      // 增加时间戳参数避免缓存，确保获取最新数据
      const timestamp = new Date().getTime()
      const response = await fetch(`/api/log?page=1&_t=${timestamp}`)
      const data = await response.json()
      
      if (data && data.data && Array.isArray(data.data)) {
        // 清空并更新日志数组
        log.value = [...data.data]
        console.log(`提交历史加载完成，共 ${log.value.length} 条记录`)
      } else {
        console.warn('API返回的提交历史格式不正确:', data)
        log.value = [] // 如果数据格式不对，清空日志
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
    if (!isGitRepo.value) {
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
    if (!isGitRepo.value) {
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
    if (!isGitRepo.value) {
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
    if (!isGitRepo.value) {
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
    if (!isGitRepo.value) {
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
  
  // 提交更改 (git commit)
  async function commitChanges(message: string, noVerify = false) {
    // 检查是否是Git仓库
    if (!isGitRepo.value) {
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
        
        // 更新分支状态
        getBranchStatus()
        
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
    if (!isGitRepo.value) {
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
        
        // 更新分支状态
        getBranchStatus()
        
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
  
  // 合并分支
  async function mergeBranch(branch: string, options: { 
    noCommit?: boolean, 
    noFf?: boolean, 
    squash?: boolean, 
    message?: string 
  } = {}) {
    if (!isGitRepo.value) {
      ElMessage({
        message: '当前目录不是Git仓库',
        type: 'warning'
      });
      return false;
    }

    if (!branch) {
      ElMessage({
        message: '请选择要合并的分支',
        type: 'warning'
      });
      return false;
    }

    // 防止自己合并自己
    if (branch === currentBranch.value) {
      ElMessage({
        message: '不能合并当前分支到自身',
        type: 'warning'
      });
      return false;
    }

    try {
      isGitMerging.value = true;
      
      const response = await fetch('/api/merge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          branch,
          ...options
        })
      });
      
      const result = await response.json();
      
      if (response.status === 409) {
        // 合并冲突
        ElMessage({
          message: '合并分支时发生冲突，请手动解决',
          type: 'warning',
          duration: 5000
        });
        return false;
      }
      
      if (result.success) {
        ElMessage({
          message: `成功合并分支 ${branch} 到 ${currentBranch.value}`,
          type: 'success'
        });
        
        // 刷新Git状态
        await fetchStatus();
        await getBranchStatus();
        
        return true;
      } else {
        ElMessage({
          message: `合并分支失败: ${result.error}`,
          type: 'error'
        });
        return false;
      }
    } catch (error) {
      ElMessage({
        message: `合并分支失败: ${(error as Error).message}`,
        type: 'error'
      });
      return false;
    } finally {
      isGitMerging.value = false;
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
      
      // 即使出错也要刷新状态
      fetchStatus()
      fetchLog()
      getBranchStatus()
      
      return false
    }
  }
  
  // 重置暂存区 (git reset HEAD)
  async function resetHead() {
    // 检查是否是Git仓库
    if (!isGitRepo.value) {
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
    if (!isGitRepo.value) {
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
  
  // 获取远程仓库地址
  async function getRemoteUrl() {
    if (!isGitRepo.value) return;
    
    try {
      isLoadingRemoteUrl.value = true;
      console.log('获取远程仓库地址...');
      const response = await fetch('/api/remote-url');
      const data = await response.json();
      
      if (data.success) {
        remoteUrl.value = data.url || '';
        console.log(`获取到远程仓库地址: ${remoteUrl.value}`);
      } else {
        console.warn('获取远程仓库地址失败:', data.error);
        remoteUrl.value = '';
      }
    } catch (error) {
      console.error('获取远程仓库地址失败:', error);
      remoteUrl.value = '';
    } finally {
      isLoadingRemoteUrl.value = false;
    }
  }

  // 复制远程仓库地址到剪贴板
  async function copyRemoteUrl() {
    if (!remoteUrl.value) {
      ElMessage({
        message: '没有可复制的远程仓库地址',
        type: 'warning'
      });
      return false;
    }
    
    try {
      await navigator.clipboard.writeText(remoteUrl.value);
      ElMessage({
        message: '已复制远程仓库地址',
        type: 'success'
      });
      return true;
    } catch (error) {
      console.error('复制远程仓库地址失败:', error);
      ElMessage({
        message: `复制失败: ${(error as Error).message}`,
        type: 'error'
      });
      return false;
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
  function disconnectSocket() {
    if (socketRef.value) {
      socketRef.value.disconnect();
      socketRef.value = null;
    }
  }

  // 在组件卸载时断开socket连接
  onUnmounted(() => {
    disconnectSocket();
  })

  // 获取stash列表
  async function getStashList() {
    if (!isGitRepo.value) {
      ElMessage.warning('当前目录不是Git仓库');
      return [];
    }
    
    try {
      isLoadingStashes.value = true;
      
      const response = await fetch('/api/stash-list');
      const data = await response.json();
      
      if (data.success) {
        stashes.value = data.stashes;
        return data.stashes;
      } else {
        ElMessage.error(`获取stash列表失败: ${data.error}`);
        return [];
      }
    } catch (error) {
      console.error('获取stash列表失败:', error);
      ElMessage.error(`获取stash列表失败: ${(error as Error).message}`);
      return [];
    } finally {
      isLoadingStashes.value = false;
    }
  }

  // 保存stash
  async function saveStash(message?: string, includeUntracked = false) {
    if (!isGitRepo.value) {
      ElMessage.warning('当前目录不是Git仓库');
      return false;
    }
    
    try {
      isSavingStash.value = true;
      
      const response = await fetch('/api/stash-save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          message, 
          includeUntracked 
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        ElMessage.success(result.message);
        // 刷新stash列表和Git状态
        await getStashList();
        await fetchStatus();
        return true;
      } else {
        ElMessage.warning(result.message);
        return false;
      }
    } catch (error) {
      console.error('保存stash失败:', error);
      ElMessage.error(`保存stash失败: ${(error as Error).message}`);
      return false;
    } finally {
      isSavingStash.value = false;
    }
  }

  // 应用stash
  async function applyStash(stashId: string, pop = false) {
    if (!isGitRepo.value) {
      ElMessage.warning('当前目录不是Git仓库');
      return false;
    }
    
    try {
      isApplyingStash.value = true;
      
      const response = await fetch('/api/stash-apply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ stashId, pop })
      });
      
      const result = await response.json();
      
      if (response.status === 409) {
        // 合并冲突
        ElMessage.warning('应用stash时发生冲突，请手动解决');
        return false;
      }
      
      if (result.success) {
        ElMessage.success(result.message);
        // 刷新stash列表和Git状态
        await getStashList();
        await fetchStatus();
        return true;
      } else {
        ElMessage.error(`应用stash失败: ${result.error}`);
        return false;
      }
    } catch (error) {
      console.error('应用stash失败:', error);
      ElMessage.error(`应用stash失败: ${(error as Error).message}`);
      return false;
    } finally {
      isApplyingStash.value = false;
    }
  }

  // 删除stash
  async function dropStash(stashId: string) {
    if (!isGitRepo.value) {
      ElMessage.warning('当前目录不是Git仓库');
      return false;
    }
    
    try {
      isDroppingStash.value = true;
      
      const response = await fetch('/api/stash-drop', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ stashId })
      });
      
      const result = await response.json();
      
      if (result.success) {
        ElMessage.success(result.message);
        // 刷新stash列表
        await getStashList();
        return true;
      } else {
        ElMessage.error(`删除stash失败: ${result.error}`);
        return false;
      }
    } catch (error) {
      console.error('删除stash失败:', error);
      ElMessage.error(`删除stash失败: ${(error as Error).message}`);
      return false;
    } finally {
      isDroppingStash.value = false;
    }
  }

  // 清空所有stash
  async function clearAllStashes() {
    if (!isGitRepo.value) {
      ElMessage.warning('当前目录不是Git仓库');
      return false;
    }
    
    try {
      isDroppingStash.value = true;
      
      const response = await fetch('/api/stash-clear', {
        method: 'POST'
      });
      
      const result = await response.json();
      
      if (result.success) {
        ElMessage.success(result.message);
        // 刷新stash列表
        stashes.value = [];
        return true;
      } else {
        ElMessage.error(`清空stash失败: ${result.error}`);
        return false;
      }
    } catch (error) {
      console.error('清空stash失败:', error);
      ElMessage.error(`清空stash失败: ${(error as Error).message}`);
      return false;
    } finally {
      isDroppingStash.value = false;
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
    lastCheckedTime,
    branchAhead,
    branchBehind,
    hasUpstream,
    upstreamBranch,
    lastBranchStatusTime,
    lastBranchesTime,
    remoteUrl,
    isLoadingRemoteUrl,
    
    // stash相关状态
    stashes,
    isLoadingStashes,
    isApplyingStash,
    isDroppingStash,
    isSavingStash,
    
    // 从 gitLogStore 合并的状态
    log,
    status,
    statusText,
    fileList,
    isLoadingLog,
    isLoadingStatus,
    isAddingFiles,
    isCommiting,
    isResetting,
    autoUpdateEnabled,
    
    // Git操作状态
    isPushing,
    isGitPulling,
    isGitFetching,
    isGitMerging,
    
    // 方法
    $reset,
    checkGitRepo,
    getCurrentBranch,
    getAllBranches,
    changeBranch,
    getUserInfo,
    createBranch,
    clearUserConfig,
    restoreUserConfig,
    getBranchStatus,
    gitPull,
    gitFetchAll,
    initSocketConnection,
    toggleAutoUpdate,
    parseStatusPorcelain,
    fetchLog,
    fetchStatus,
    fetchStatusPorcelain,
    addToStage,
    addFileToStage,
    unstageFile,
    commitChanges,
    pushToRemote,
    addAndCommit,
    addCommitAndPush,
    resetHead,
    resetToRemote,
    getRemoteUrl,
    copyRemoteUrl,
    mergeBranch,
    // stash相关方法
    getStashList,
    saveStash,
    applyStash,
    dropStash,
    clearAllStashes,
    socket: socketRef,
    disconnectSocket
  }
}) 

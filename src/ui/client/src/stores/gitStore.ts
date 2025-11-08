import { $t } from '@/lang/static'
import { defineStore } from 'pinia'
import { ref, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { io, Socket } from 'socket.io-client'
import { useConfigStore } from './configStore'

// 定义Git操作间隔时间（毫秒）
const GIT_OPERATION_DELAY = 800

// 获取后端服务器端口
function getBackendPort() {
  const currentPort = window.location.port || '80';
  
  // 开发环境判断：只在开发环境中从环境变量读取后端端口
  if (currentPort === '5173' || currentPort === '4173' || currentPort === '5544') {
    const envPort = import.meta.env.VITE_BACKEND_PORT;
    if (envPort) {
      console.log(`${$t('@C298B:开发环境：从环境变量读取后端端口 ')}${envPort}`);
      return parseInt(envPort, 10);
    }
    console.log($t('@C298B:开发环境：使用默认后端端口 3000'));
    return 3000;
  }
  
  // 生产环境：直接使用当前页面端口，不读取环境变量
  const port = parseInt(currentPort, 10);
  console.log(`${$t('@C298B:生产环境：使用当前页面端口 ')}${port}`);
  return port;
}

// 获取后端端口
const backendPort = getBackendPort()

export const useGitStore = defineStore('git', () => {
  // 获取configStore实例
  const configStore = useConfigStore()
  
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
  // 自动更新状态开关
  const autoUpdateEnabled = ref(true)
  
  // Socket.io 实例
  const socketRef = ref<Socket | null>(null);
  
  // 当前项目信息
  const currentProjectPath = ref('')
  const currentProjectRoomId = ref('')
  
  // 状态
  const log = ref<any[]>([])
  const status = ref<{ staged: string[], unstaged: string[], untracked: string[] }>({
    staged: [],
    unstaged: [],
    untracked: []
  })
  // 移除不再使用的statusText，只保留解析后的文件列表
  // 添加fileList状态用于保存porcelain格式的状态
  const fileList = ref<{path: string, type: string}[]>([])
  const isLoadingLog = ref(false)
  const isLoadingStatus = ref(false)
  const isAddingFiles = ref(false)
  const isCommiting = ref(false)
  const isResetting = ref(false)
  
  // 提交历史分页状态
  const currentPage = ref(1)
  const hasMoreData = ref(true)
  const totalCommits = ref(0)
  
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
    fileList.value = []
    isLoadingLog.value = false
    isLoadingStatus.value = false
    isAddingFiles.value = false
    isCommiting.value = false
    isResetting.value = false
    
    // 重置提交历史分页状态
    currentPage.value = 1
    hasMoreData.value = true
    totalCommits.value = 0
    // 不重置autoUpdateEnabled，保留用户设置
  }

  // 获取分支状态（领先/落后远程）- 带缓存优化
  async function getBranchStatus(forceRefresh = false, countOnly = false) {
    if (!isGitRepo.value) return;

    // 如果不是强制刷新，且距离上次获取不到30秒，使用缓存
    const now = Date.now();
    if (!forceRefresh && !countOnly && now - lastBranchStatusTime.value < 30000) {
      console.log($t('@C298B:使用缓存的分支状态'));
      return;
    }

    try {
      console.log($t('@C298B:获取分支状态...'));
      // 构建URL参数
      let url = '/api/branch-status';
      const params = [];
      if (forceRefresh) params.push('force=true');
      if (countOnly) params.push('countOnly=true');
      if (params.length > 0) url += '?' + params.join('&');

      const response = await fetch(url);
      const data = await response.json();

      if (data) {
        branchAhead.value = data.ahead || 0;
        branchBehind.value = data.behind || 0;
        hasUpstream.value = data.hasUpstream || false;
        upstreamBranch.value = data.upstreamBranch || '';

        // 更新获取时间戳
        lastBranchStatusTime.value = now;

        // 添加调试日志
        console.log(`${$t('@C298B:分支状态更新：领先 ')}${branchAhead.value}${$t('@C298B: 个提交，落后 ')}${branchBehind.value}${$t('@C298B: 个提交，上游分支：')}${hasUpstream.value ? upstreamBranch.value : $t('@C298B:无')}`);
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
      console.log('使用缓存的Git仓库状态:', isGitRepo.value ? '是' : $t('@C298B:不是'))
      return isGitRepo.value
    }
    
    try {
      const response = await fetch('/api/current_directory')
      const data = await response.json()
      isGitRepo.value = data.isGitRepo === true
      lastCheckedTime.value = now // 更新检查时间
      console.log(`${$t('@C298B:当前目录')}${isGitRepo.value ? $t('@C298B:是') : $t('@C298B:不是')}${$t('@C298B:Git仓库')}`)
      return isGitRepo.value
    } catch (error) {
      console.error('检查Git仓库状态失败:', error)
      isGitRepo.value = false
      lastCheckedTime.value = now // 即使失败也更新检查时间，避免频繁重试
      return false
    }
  }

  // 获取当前分支（优化版本 - 支持强制刷新）
  async function getCurrentBranch(forceRefresh = false) {
    try {
      // 传递force参数到后端API
      const url = forceRefresh ? '/api/branch?force=true' : '/api/branch';
      const response = await fetch(url);
      const data = await response.json();
      if (data.branch) {
        currentBranch.value = data.branch;
        console.log(`${$t('@C298B:当前分支更新为: ')}${data.branch}${forceRefresh ? $t('@C298B: (强制刷新)') : ''}`);
        // 不再在这里调用 getBranchStatus
      }
    } catch (error) {
      console.error('获取分支信息失败:', error);
    }
  }

  // 获取所有分支
  async function getAllBranches() {
    if (!isGitRepo.value) return;
    
    // 移除时间戳缓存判断，简化逻辑
    try {
      console.log($t('@C298B:获取所有分支...'));
      const response = await fetch('/api/branches')
      const data = await response.json()
      if (data.branches && Array.isArray(data.branches)) {
        allBranches.value = data.branches
        // 更新获取时间戳
        lastBranchesTime.value = Date.now();
        console.log(`${$t('@C298B:获取到')}${data.branches.length}${$t('@C298B:个分支')}`);
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
          message: `${$t('@C298B:已切换到分支: ')}${branch}`,
          type: 'success'
        })
        
        // 分别刷新分支信息和分支状态（强制刷新）
        await getCurrentBranch(true) // 强制刷新分支名
        await getBranchStatus(true)  // 强制刷新分支状态
        
        return true
      } else {
        ElMessage({
          message: `${$t('@C298B:切换分支失败: ')}${result.error}`,
          type: 'error'
        })
        return false
      }
    } catch (error) {
      ElMessage({
        message: `${$t('@C298B:切换分支失败: ')}${(error as Error).message}`,
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
        message: $t('@C298B:分支名称不能为空'),
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
          message: `${$t('@C298B:已创建并切换到分支: ')}${newBranchName}`,
          type: 'success'
        })
        
        // 分别刷新分支信息和状态（强制刷新）
        await getCurrentBranch(true) // 强制刷新分支名
        await getBranchStatus(true)  // 强制刷新分支状态
        await getAllBranches()       // 刷新分支列表
        
        return true
      } else {
        ElMessage({
          message: `${$t('@C298B:创建分支失败: ')}${result.error}`,
          type: 'error'
        })
        return false
      }
    } catch (error) {
      ElMessage({
        message: `${$t('@C298B:创建分支失败: ')}${(error as Error).message}`,
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
          message: $t('@C298B:已清除Git用户配置'),
          type: 'success'
        });
        return true;
      } else {
        ElMessage({
          message: `${$t('@C298B:清除配置失败: ')}${result.error}`,
          type: 'error'
        });
        return false;
      }
    } catch (error) {
      ElMessage({
          message: `${$t('@C298B:清除配置失败: ')}${(error as Error).message}`,
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
          message: $t('@C298B:已恢复Git用户配置'),
          type: 'success'
        });
        return true;
      } else {
        ElMessage({
          message: `${$t('@C298B:恢复配置失败: ')}${result.error}`,
          type: 'error'
        });
        return false;
      }
    } catch (error) {
      ElMessage({
          message: `${$t('@C298B:恢复配置失败: ')}${(error as Error).message}`,
          type: 'error'
        });
      return false;
    }
  }

  // 执行git pull操作
  async function gitPull() {
    if (!isGitRepo.value) {
      ElMessage({
        message: $t('@C298B:当前目录不是Git仓库'),
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
          message: $t('@C298B:拉取成功'),
          type: 'success'
        });
        
        // 刷新分支状态
        await getBranchStatus();
        return true;
      } else {
        // 改进错误提示
        if (result.needsMerge) {
          ElMessage({
            message: `${$t('@C298B:需要合并更改: ')}${result.pullOutput || $t('@C298B:存在冲突需要手动解决')}`,
            type: 'warning',
            duration: 5000
          });
        } else {
          ElMessage({
            message: `${$t('@C298B:拉取失败: ')}${result.error}`,
            type: 'error'
          });
        }
        return false;
      }
    } catch (error) {
      ElMessage({
        message: `${$t('@C298B:拉取失败: ')}${(error as Error).message}`,
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
        message: $t('@C298B:当前目录不是Git仓库'),
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
          message: $t('@C298B:获取所有远程分支信息成功'),
          type: 'success'
        });
        
        // 刷新分支状态
        await getBranchStatus();
        return true;
      } else {
        ElMessage({
          message: `${$t('@C298B:获取远程分支信息失败: ')}${result.error}`,
          type: 'error'
        });
        return false;
      }
    } catch (error) {
      ElMessage({
        message: `${$t('@C298B:获取远程分支信息失败: ')}${(error as Error).message}`,
        type: 'error'
      });
      return false;
    } finally {
      isGitFetching.value = false;
    }
  }

  // 从 gitLogStore 合并过来的方法
  // Socket.io连接处理
  async function initSocketConnection() {
    // 如果已经有socket连接，先断开
    if (socketRef.value) {
      socketRef.value.disconnect()
    }
    
    try {
      // 使用后端端口连接Socket.IO服务器
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
      console.log($t('@C298B:Socket.IO客户端已创建，开始注册事件监听器...'))

      // 监听连接事件
      socketRef.value.on('connect', () => {
        console.log('✅ Socket.IO连接成功，事件监听器已生效，Socket ID:', socketRef.value?.id)
        
        // 如果自动更新开启，向服务器请求开始监控
        if (autoUpdateEnabled.value && socketRef.value) {
          socketRef.value.emit('start_monitoring')
        }
      })
      
      // 监听项目信息
      socketRef.value.on('project_info', (data) => {
        currentProjectPath.value = data.projectPath
        currentProjectRoomId.value = data.projectRoomId
        console.log(`${$t('@C298B:当前项目: ')}${data.projectPath}`)
        console.log(`${$t('@C298B:房间ID: ')}${data.projectRoomId}`)
      })
      
      // 监听项目切换事件
      socketRef.value.on('project_changed', (data) => {
        console.log(`${$t('@C298B:项目已切换: ')}${data.oldProjectPath} -> ${data.newProjectPath}`)
        
        // 更新当前项目信息
        currentProjectPath.value = data.newProjectPath
        currentProjectRoomId.value = data.newProjectRoomId
        
        // 重新加入新的项目房间
        if (socketRef.value) {
          socketRef.value.emit('join_room', data.newProjectRoomId)
        }
        
        console.log(`${$t('@C298B:已加入新项目房间: ')}${data.newProjectRoomId}`)
      })
      
      // 监听断开连接事件
      socketRef.value.on('disconnect', (reason) => {
        console.log('与Socket.IO服务器断开连接:', reason)
      })
      
      // 监听Git状态更新事件
      socketRef.value.on('git_status_update', (data) => {
        if (!autoUpdateEnabled.value) return

        console.log('✅ 成功监听到 git_status_update 事件:', new Date().toLocaleTimeString())
        console.log(`git_status_update data ==>`, data)
        console.log(`currentProjectPath.value ==>`, currentProjectPath.value)
        console.log(`data.projectPath ==>`, data.projectPath)

        // 验证消息来源，确保只处理当前项目的更新
        if (data.projectPath && currentProjectPath.value && 
            data.projectPath !== currentProjectPath.value) {
          console.log(`${$t('@C298B:忽略不同项目的状态更新: ')}${data.projectPath}`)
          return
        }
        
        console.log($t('@C298B:正在更新 Git 文件状态...'))
        
        // 更新文件列表
        if (data.porcelain !== undefined) {
          parseStatusPorcelain(data.porcelain)
        }
      })
      
      // 监听监控状态
      socketRef.value.on('monitoring_status', (data) => {
        console.log('文件监控状态:', data.active ? '已启动' : $t('@C298B:已停止'))
      })
      
      // 添加额外的连接问题诊断
      socketRef.value.on('connect_error', (error) => {
        console.error('Socket连接错误:', error.message)
      })
      
      socketRef.value.on('connect_timeout', () => {
        console.error($t('@C298B:Socket连接超时'))
      })
      
      socketRef.value.on('reconnect', (attemptNumber) => {
        console.log(`${$t('@C298B:Socket重连成功，尝试次数: ')}${attemptNumber}`)
        
        // 重连后检查自动更新状态
        if (autoUpdateEnabled.value) {
          console.log($t('@C298B:重连后重新发送start_monitoring请求'))
          socketRef.value?.emit('start_monitoring')
        }
      })
      
      socketRef.value.on('reconnect_attempt', (attemptNumber) => {
        console.log(`${$t('@C298B:Socket尝试重连，第 ')}${attemptNumber}${$t('@C298B: 次尝试')}`)
      })
      
      socketRef.value.on('reconnect_error', (error) => {
        console.error('Socket重连错误:', error.message)
      })
      
      socketRef.value.on('reconnect_failed', () => {
        console.error($t('@C298B:Socket重连失败，已达到最大重试次数'))
      })
      
      // 事件监听器注册完成
      console.log($t('@C298B:Socket.IO事件监听器注册完成：connect, project_info, project_changed, git_status_update, monitoring_status'))
      
      // 手动尝试连接
      if (socketRef.value && !socketRef.value.connected) {
        console.log($t('@C298B:Socket未连接，尝试手动连接...'))
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
      ElMessage.error($t('@C298B:无法连接到服务器，自动更新可能不会生效'))
      
      // 尝试重新初始化socket连接
      console.log($t('@C298B:尝试重新建立socket连接...'))
      initSocketConnection()
      
      // 即使socket可能不存在，也保存设置
      localStorage.setItem('zen-gitsync-auto-update', autoUpdateEnabled.value.toString())
      return
    }
    
    try {
      if (autoUpdateEnabled.value) {
        console.log($t('@C298B:发送start_monitoring命令...'))
        socketRef.value.emit('start_monitoring')
        ElMessage.success($t('@C298B:自动更新已启用'))
      } else {
        console.log($t('@C298B:发送stop_monitoring命令...'))
        socketRef.value.emit('stop_monitoring')
        ElMessage.info($t('@C298B:自动更新已禁用'))
      }
      
      // 保存设置到localStorage
      localStorage.setItem('zen-gitsync-auto-update', autoUpdateEnabled.value.toString())
      console.log('已保存自动更新设置到本地存储:', autoUpdateEnabled.value)
    } catch (error) {
      console.error('切换自动更新状态时出错:', error)
      ElMessage.error(`${$t('@C298B:切换自动更新失败: ')}${(error as Error).message}`)
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
      // U: 冲突 (unmerged), UU: 双方都修改, AA: 双方都添加, DD: 双方都删除
      // AU: 我们添加他们修改, UA: 我们修改他们添加, DU: 我们删除他们修改, UD: 我们修改他们删除
      const match = line.match(/^([ MADRCU\?]{2})\s+(.+)$/)
      if (match) {
        let type = ''
        const code = match[1]
        const indexStatus = code.charAt(0)
        const workTreeStatus = code.charAt(1)
        
        // 首先检查冲突文件状态码（优先级最高）
        if (code === 'UU' || code === 'AA' || code === 'DD' || 
            code === 'AU' || code === 'UA' || code === 'DU' || code === 'UD') {
          // 冲突文件（未合并）
          type = 'conflicted'
        } else if (indexStatus === 'A') {
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
      console.log($t('@C298B:当前目录不是Git仓库，跳过加载提交历史'))
      return
    }
    
    try {
      isLoadingLog.value = true
      console.log($t('@C298B:开始加载提交历史...'))
      
      // 增加时间戳参数避免缓存，确保获取最新数据
      const timestamp = new Date().getTime()
      const response = await fetch(`/api/log?page=1&_t=${timestamp}`)
      const data = await response.json()
      
      if (data && data.data && Array.isArray(data.data)) {
        // 清空并更新日志数组
        log.value = [...data.data]
        console.log(`${$t('@C298B:提交历史加载完成，共 ')}${log.value.length}${$t('@C298B: 条记录')}`)
      } else {
        console.warn('API返回的提交历史格式不正确:', data)
        log.value = [] // 如果数据格式不对，清空日志
      }
    } catch (error) {
      console.error('获取提交历史失败:', error)
      if (showMessage) {
        ElMessage({
          message: `${$t('@C298B:获取提交历史失败: ')}${(error as Error).message}`,
          type: 'error'
        })
      }
    } finally {
      isLoadingLog.value = false
    }
  }
  
  // 刷新提交历史（供其他组件使用）
  async function refreshLog() {
    console.log($t('@C298B:刷新提交历史...'))
    
    // 重置分页状态
    currentPage.value = 1
    hasMoreData.value = false // fetchLog加载的是全量数据，没有更多分页
    
    await fetchLog(true)
    
    // 更新总数
    totalCommits.value = log.value.length
    
    console.log($t('@C298B:提交历史刷新完成'))
  }
  
  // 获取Git状态 (优化版本 - 只获取porcelain格式)
  async function fetchStatus() {
    // 检查是否是Git仓库
    if (!isGitRepo.value) {
      console.log($t('@C298B:当前目录不是Git仓库，跳过加载Git状态'))
      return
    }

    try {
      isLoadingStatus.value = true
      // 直接获取porcelain格式的状态，不再获取完整的git status
      await fetchStatusPorcelain()
    } catch (error) {
      console.error('获取Git状态失败:', error)
      ElMessage({
        message: `${$t('@C298B:获取Git状态失败: ')}${(error as Error).message}`,
        type: 'error'
      })
    } finally {
      isLoadingStatus.value = false
    }
  }
  
  // 获取Git状态 (porcelain格式)
  async function fetchStatusPorcelain() {
    console.log($t('@C298B:开始获取Git状态(porcelain格式)...'))
    // 检查是否是Git仓库
    if (!isGitRepo.value) {
      console.log($t('@C298B:当前目录不是Git仓库，跳过加载Git状态'))
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
        message: `${$t('@C298B:获取Git状态(porcelain)失败: ')}${(error as Error).message}`,
        type: 'error'
      })
      // 清空文件列表
      fileList.value = []
    }
  }
  
  // 添加文件到暂存区 (过滤锁定文件)
  async function addToStage() {
    // 检查是否是Git仓库
    if (!isGitRepo.value) {
      ElMessage.warning($t('@C298B:当前目录不是Git仓库'))
      return false
    }
    
    try {
      isAddingFiles.value = true
      
      // 获取当前文件列表，过滤掉锁定的文件
      const filesToAdd = fileList.value.filter(file => {
        const normalizedPath = file.path.replace(/\\/g, '/')
        const isLocked = configStore.lockedFiles.some(lockedFile => {
          const normalizedLocked = lockedFile.replace(/\\/g, '/')
          return normalizedPath === normalizedLocked
        })
        return !isLocked
      })
      
      if (filesToAdd.length === 0) {
        ElMessage({
          message: $t('@C298B:没有需要暂存的文件（所有文件都被锁定）'),
          type: 'warning'
        })
        return false
      }
      
      // 如果所有文件都没有被锁定，使用 git add . 提高效率
      if (filesToAdd.length === fileList.value.length) {
        const response = await fetch('/api/add', {
          method: 'POST'
        })
        
        const result = await response.json()
        if (result.success) {
          ElMessage({
            message: $t('@C298B:文件已添加到暂存区'),
            type: 'success'
          })
          return true
        } else {
          ElMessage({
            message: `${$t('@C298B:添加文件失败: ')}${result.error}`,
            type: 'error'
          })
          return false
        }
      } else {
        // 有锁定文件，使用后端的过滤逻辑
        const response = await fetch('/api/add-filtered', {
          method: 'POST'
        })
        
        const result = await response.json()
        if (result.success) {
          const lockedCount = fileList.value.length - filesToAdd.length
          let message = `${$t('@C298B:已添加 ')}${filesToAdd.length}${$t('@C298B: 个文件到暂存区')}`
          if (lockedCount > 0) {
            message += `${$t('@C298B:，跳过 ')}${lockedCount}${$t('@C298B: 个锁定文件')}`
          }
          
          ElMessage({
            message,
            type: 'success'
          })
          return true
        } else {
          ElMessage({
            message: `${$t('@C298B:添加文件失败: ')}${result.error}`,
            type: 'error'
          })
          return false
        }
      }
    } catch (error) {
      ElMessage({
        message: `${$t('@C298B:添加文件失败: ')}${(error as Error).message}`,
        type: 'error'
      })
      return false
    } finally {
      isAddingFiles.value = false
    }
  }
  
  // 直接添加所有文件到暂存区 (git add . 不考虑锁定文件)
  async function addAllToStage() {
    // 检查是否是Git仓库
    if (!isGitRepo.value) {
      ElMessage.warning($t('@C298B:当前目录不是Git仓库'))
      return false
    }
    
    try {
      isAddingFiles.value = true
      const response = await fetch('/api/add-all', {
        method: 'POST'
      })
      
      const result = await response.json()
      if (result.success) {
        ElMessage({
          message: $t('@C298B:所有文件已添加到暂存区'),
          type: 'success'
        })

        return true
      } else {
        ElMessage({
          message: `${$t('@C298B:添加文件失败: ')}${result.error}`,
          type: 'error'
        })
        return false
      }
    } catch (error) {
      ElMessage({
        message: `${$t('@C298B:添加文件失败: ')}${(error as Error).message}`,
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
      ElMessage.warning($t('@C298B:当前目录不是Git仓库'))
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
          message: $t('@C298B:文件已暂存'),
          type: 'success'
        })
        
        // 刷新状态
        fetchStatus()
        
        return true
      } else {
        ElMessage({
          message: `${$t('@C298B:暂存文件失败: ')}${result.error}`,
          type: 'error'
        })
        return false
      }
    } catch (error) {
      ElMessage({
        message: `${$t('@C298B:暂存文件失败: ')}${(error as Error).message}`,
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
      ElMessage.warning($t('@C298B:当前目录不是Git仓库'))
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
          message: $t('@C298B:已取消暂存文件'),
          type: 'success'
        })
        
        // 刷新状态
        fetchStatus()
        
        return true
      } else {
        ElMessage({
          message: `${$t('@C298B:取消暂存失败: ')}${result.error}`,
          type: 'error'
        })
        return false
      }
    } catch (error) {
      ElMessage({
        message: `${$t('@C298B:取消暂存失败: ')}${(error as Error).message}`,
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
      ElMessage.warning($t('@C298B:当前目录不是Git仓库'))
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
          message: $t('@C298B:提交成功'),
          type: 'success'
        })

        // 在一键操作中，状态刷新会在最后统一进行，避免重复调用
        // 如果是单独的提交操作，会在CommitForm.vue中单独刷新状态

        return true
      } else {
        ElMessage({
          message: `${$t('@C298B:commitChanges 提交失败: ')}${result.error}`,
          type: "error",
        });
        return false
      }
    } catch (error) {
      ElMessage({
        message: `${$t('@C298B:提交失败: ')}${(error as Error).message}`,
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
      ElMessage.warning($t('@C298B:当前目录不是Git仓库'))
      return false
    }
    
    try {
      isPushing.value = true
      const response = await fetch('/api/push', {
        method: 'POST'
      })
      
      const result = await response.json()
      if (result.success) {
        // 推送成功后，逻辑上本地和远程必定同步，直接设置状态
        branchAhead.value = 0;  // 推送成功后，本地不再领先
        branchBehind.value = 0; // 推送成功后，本地不再落后

        // 只刷新文件状态和提交日志，不需要重新计算分支状态
        await Promise.all([
          fetchStatus(),  // 刷新文件状态
          fetchLog(),     // 刷新提交日志
        ])

        console.log('推送成功，分支状态已设置为同步 (ahead=0, behind=0)');

        return true
      } else {
        ElMessage({
          message: `${$t('@C298B:推送失败: ')}${result.error}`,
          type: 'error'
        })
        return false
      }
    } catch (error) {
      ElMessage({
        message: `${$t('@C298B:推送失败: ')}${(error as Error).message}`,
        type: 'error'
      })
      return false
    } finally {
      isPushing.value = false
    }
  }

  // 带进度的推送到远程
  async function pushToRemoteWithProgress(onProgress?: (data: any) => void) {
    // 检查是否是Git仓库
    if (!isGitRepo.value) {
      ElMessage.warning($t('@C298B:当前目录不是Git仓库'))
      return false
    }
    
    return new Promise<boolean>((resolve) => {
      try {
        isPushing.value = true
        
        // 使用fetch的ReadableStream API接收SSE
        fetch('/api/push-with-progress', {
          method: 'POST'
        }).then(response => {
          const reader = response.body?.getReader()
          const decoder = new TextDecoder()
          
          if (!reader) {
            throw new Error('无法读取响应流')
          }

          const readStream = async () => {
            try {
              while (true) {
                const { done, value } = await reader.read()
                
                if (done) {
                  break
                }
                
                // 解码数据
                const chunk = decoder.decode(value, { stream: true })
                const lines = chunk.split('\n')
                
                for (const line of lines) {
                  if (line.startsWith('data: ')) {
                    try {
                      const data = JSON.parse(line.slice(6))
                      
                      // 调用进度回调
                      if (onProgress) {
                        onProgress(data)
                      }
                      
                      // 处理完成事件
                      if (data.type === 'complete') {
                        isPushing.value = false
                        
                        if (data.success) {
                          // 推送成功
                          branchAhead.value = 0
                          branchBehind.value = 0
                          
                          // 刷新状态
                          Promise.all([
                            fetchStatus(),
                            fetchLog(),
                          ])
                          
                          resolve(true)
                        } else {
                          // 推送失败
                          ElMessage({
                            message: `${$t('@C298B:推送失败: ')}${data.error}`,
                            type: 'error'
                          })
                          resolve(false)
                        }
                      }
                    } catch (e) {
                      console.error('解析SSE数据失败:', e)
                    }
                  }
                }
              }
            } catch (error) {
              console.error('读取流失败:', error)
              isPushing.value = false
              ElMessage({
                message: `${$t('@C298B:推送失败: ')}${(error as Error).message}`,
                type: 'error'
              })
              resolve(false)
            }
          }
          
          readStream()
        }).catch(error => {
          isPushing.value = false
          ElMessage({
            message: `${$t('@C298B:推送失败: ')}${error.message}`,
            type: 'error'
          })
          resolve(false)
        })
        
      } catch (error) {
        isPushing.value = false
        ElMessage({
          message: `${$t('@C298B:推送失败: ')}${(error as Error).message}`,
          type: 'error'
        })
        resolve(false)
      }
    })
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
        message: $t('@C298B:当前目录不是Git仓库'),
        type: 'warning'
      });
      return false;
    }

    if (!branch) {
      ElMessage({
        message: $t('@C298B:请选择要合并的分支'),
        type: 'warning'
      });
      return false;
    }

    // 防止自己合并自己
    if (branch === currentBranch.value) {
      ElMessage({
        message: $t('@C298B:不能合并当前分支到自身'),
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
          message: $t('@C298B:合并分支时发生冲突，请手动解决'),
          type: 'warning',
          duration: 5000
        });
        return false;
      }
      
      if (result.success) {
        ElMessage({
          message: `${$t('@C298B:成功合并分支 ')}${branch}${$t('@C298B: 到 ')}${currentBranch.value}`,
          type: 'success'
        });
        
        // 刷新Git状态
        await fetchStatus();
        await getBranchStatus();
        
        return true;
      } else {
        ElMessage({
          message: `${$t('@C298B:合并分支失败: ')}${result.error}`,
          type: 'error'
        });
        return false;
      }
    } catch (error) {
      ElMessage({
        message: `${$t('@C298B:合并分支失败: ')}${(error as Error).message}`,
        type: 'error'
      });
      return false;
    } finally {
      isGitMerging.value = false;
    }
  }
  
  // 暂存并提交
  async function addAndCommit(message: string, noVerify = false) {
    console.log($t('@C298B:开始暂存并提交操作...'))
    const addResult = await addToStage()
    if (!addResult) return false

    // 等待暂存操作完全完成
    console.log($t('@C298B:暂存完成，等待Git操作完成...'))
    await delay(GIT_OPERATION_DELAY)

    console.log($t('@C298B:开始提交更改...'))
    const commitResult = await commitChanges(message, noVerify)
    console.log($t('@C298B:暂存并提交操作完成'))
    return commitResult
  }
  
  // 暂存、提交并推送（优化版本 - 减少重复的状态查询）
  async function addCommitAndPush(message: string, noVerify = false) {
    try {
      // 第一步：暂存文件
      console.log($t('@C298B:开始暂存文件...'))
      const addResult = await addToStage()
      if (!addResult) return false

      // 等待暂存操作完全完成
      console.log($t('@C298B:暂存完成，等待Git操作完成...'))
      await delay(GIT_OPERATION_DELAY)

      // 第二步：提交更改
      console.log($t('@C298B:开始提交更改...'))
      const commitResult = await commitChanges(message, noVerify)
      if (!commitResult) return false

      // 等待提交操作完全完成
      console.log($t('@C298B:提交完成，等待Git操作完成...'))
      await delay(GIT_OPERATION_DELAY)

      // 第三步：推送到远程（pushToRemote会统一刷新所有状态）
      console.log($t('@C298B:开始推送到远程...'))
      const pushResult = await pushToRemote()

      console.log($t('@C298B:一键推送操作完成，状态已统一刷新'))
      return pushResult
    } catch (error) {
      console.error('一键推送操作失败:', error)

      // 如果发生错误，尝试删除 index.lock 文件
      try {
        const response = await fetch('/api/remove-lock', {
          method: 'POST'
        })
        const result = await response.json()
        if (result.success) {
          ElMessage({
            message: $t('@C298B:检测到Git锁定文件冲突，已自动清理，请重试操作'),
            type: 'warning'
          })
        }
      } catch (e) {
        console.error('清理锁定文件失败:', e)
      }
      
      ElMessage({
        message: `${$t('@C298B:操作失败: ')}${(error as Error).message}`,
        type: 'error'
      })

      // 即使出错也要刷新状态
      try {
        await Promise.all([
          fetchStatus(),
          fetchLog(),
          getBranchStatus()
        ])
      } catch (refreshError) {
        console.error('刷新状态失败:', refreshError)
      }

      return false
    }
  }
  
  // 重置暂存区 (git reset HEAD)
  async function resetHead() {
    // 检查是否是Git仓库
    if (!isGitRepo.value) {
      ElMessage.warning($t('@C298B:当前目录不是Git仓库'))
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
          message: $t('@C298B:已重置暂存区'),
          type: 'success'
        })
        
        // 刷新状态
        fetchStatus()
        
        return true
      } else {
        ElMessage({
          message: `${$t('@C298B:重置暂存区失败: ')}${result.error}`,
          type: 'error'
        })
        return false
      }
    } catch (error) {
      ElMessage({
        message: `${$t('@C298B:重置暂存区失败: ')}${(error as Error).message}`,
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
      ElMessage.warning($t('@C298B:当前目录不是Git仓库'))
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
          message: `${$t('@C298B:已重置分支 ')}${branch}${$t('@C298B: 到远程状态')}`,
          type: 'success'
        })
        
        // 刷新状态和日志
        fetchStatus()
        fetchLog()
        
        return true
      } else {
        ElMessage({
          message: `${$t('@C298B:重置分支失败: ')}${result.error}`,
          type: 'error'
        })
        return false
      }
    } catch (error) {
      ElMessage({
        message: `${$t('@C298B:重置分支失败: ')}${(error as Error).message}`,
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
      console.log($t('@C298B:获取远程仓库地址...'));
      const response = await fetch('/api/remote-url');
      const data = await response.json();
      
      if (data.success) {
        remoteUrl.value = data.url || '';
        console.log(`${$t('@C298B:获取到远程仓库地址: ')}${remoteUrl.value}`);
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
        message: $t('@C298B:没有可复制的远程仓库地址'),
        type: 'warning'
      });
      return false;
    }
    
    try {
      await navigator.clipboard.writeText(remoteUrl.value);
      ElMessage({
        message: $t('@C298B:已复制远程仓库地址'),
        type: 'success'
      });
      return true;
    } catch (error) {
      console.error('复制远程仓库地址失败:', error);
      ElMessage({
        message: `${$t('@C298B:复制失败: ')}${(error as Error).message}`,
        type: 'error'
      });
      return false;
    }
  }

  // 复制克隆命令到剪贴板
  async function copyCloneCommand() {
    if (!remoteUrl.value) {
      ElMessage({
        message: $t('@C298B:没有可复制的远程仓库地址'),
        type: 'warning'
      });
      return false;
    }
    
    try {
      const cloneCommand = `git clone ${remoteUrl.value}`;
      await navigator.clipboard.writeText(cloneCommand);
      ElMessage({
        message: $t('@F13B4:已复制克隆命令'),
        type: 'success'
      });
      return true;
    } catch (error) {
      console.error('复制克隆命令失败:', error);
      ElMessage({
        message: `${$t('@C298B:复制失败: ')}${(error as Error).message}`,
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
    
    // 初始化Socket连接
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
      ElMessage.warning($t('@C298B:当前目录不是Git仓库'));
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
        ElMessage.error(`${$t('@C298B:获取stash列表失败: ')}${data.error}`);
        return [];
      }
    } catch (error) {
      console.error('获取stash列表失败:', error);
      ElMessage.error(`${$t('@C298B:获取stash列表失败: ')}${(error as Error).message}`);
      return [];
    } finally {
      isLoadingStashes.value = false;
    }
  }

  // 保存stash
  async function saveStash(message?: string, includeUntracked = false, excludeLocked = true) {
    if (!isGitRepo.value) {
      ElMessage.warning($t('@C298B:当前目录不是Git仓库'));
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
          includeUntracked,
          excludeLocked
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
      ElMessage.error(`${$t('@C298B:保存stash失败: ')}${(error as Error).message}`);
      return false;
    } finally {
      isSavingStash.value = false;
    }
  }

  // 应用stash
  async function applyStash(stashId: string, pop = false) {
    if (!isGitRepo.value) {
      ElMessage.warning($t('@C298B:当前目录不是Git仓库'));
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
        ElMessage.warning($t('@C298B:应用stash时发生冲突，请手动解决'));
        return false;
      }
      
      if (result.success) {
        ElMessage.success(result.message);
        // 刷新stash列表和Git状态
        await getStashList();
        await fetchStatus();
        return true;
      } else {
        ElMessage.error(`${$t('@C298B:应用stash失败: ')}${result.error}`);
        return false;
      }
    } catch (error) {
      console.error('应用stash失败:', error);
      ElMessage.error(`${$t('@C298B:应用stash失败: ')}${(error as Error).message}`);
      return false;
    } finally {
      isApplyingStash.value = false;
    }
  }

  // 删除stash
  async function dropStash(stashId: string) {
    if (!isGitRepo.value) {
      ElMessage.warning($t('@C298B:当前目录不是Git仓库'));
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
        ElMessage.error(`${$t('@C298B:删除stash失败: ')}${result.error}`);
        return false;
      }
    } catch (error) {
      console.error('删除stash失败:', error);
      ElMessage.error(`${$t('@C298B:删除stash失败: ')}${(error as Error).message}`);
      return false;
    } finally {
      isDroppingStash.value = false;
    }
  }

  // 清空所有stash
  async function clearAllStashes() {
    if (!isGitRepo.value) {
      ElMessage.warning($t('@C298B:当前目录不是Git仓库'));
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
        ElMessage.error(`${$t('@C298B:清空stash失败: ')}${result.error}`);
        return false;
      }
    } catch (error) {
      console.error('清空stash失败:', error);
      ElMessage.error(`${$t('@C298B:清空stash失败: ')}${(error as Error).message}`);
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
    fileList,
    isLoadingLog,
    isLoadingStatus,
    isAddingFiles,
    isCommiting,
    isResetting,
    autoUpdateEnabled,
    
    // 提交历史分页状态
    currentPage,
    hasMoreData,
    totalCommits,
    
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
    refreshLog,
    fetchStatus,
    fetchStatusPorcelain,
    addToStage,
    addAllToStage,
    addFileToStage,
    unstageFile,
    commitChanges,
    pushToRemote,
    pushToRemoteWithProgress,
    addAndCommit,
    addCommitAndPush,
    resetHead,
    resetToRemote,
    getRemoteUrl,
    copyRemoteUrl,
    copyCloneCommand,
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

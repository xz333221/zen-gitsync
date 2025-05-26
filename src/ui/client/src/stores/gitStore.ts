import { defineStore } from 'pinia'
import { ref } from 'vue'
import { ElMessage } from 'element-plus'

// 删除防抖变量
// let branchStatusDebounceTimer: ReturnType<typeof setTimeout> | null = null;
// const BRANCH_STATUS_DEBOUNCE_DELAY = 1000; // 1秒防抖延迟

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
  
  // 添加分支状态相关变量
  const branchAhead = ref(0) // 当前分支领先远程分支的提交数
  const branchBehind = ref(0) // 当前分支落后远程分支的提交数
  const hasUpstream = ref(false) // 当前分支是否有上游分支
  const upstreamBranch = ref('') // 上游分支名称
  // 添加上次获取分支状态的时间戳
  const lastBranchStatusTime = ref(0)
  
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
  }

  // 获取分支状态（领先/落后远程）
  async function getBranchStatus(force = false) {
    if (!isGitRepo.value) return;
    
    // 如果距离上次获取不到1秒且不是强制刷新，则跳过
    const now = Date.now();
    if (!force && now - lastBranchStatusTime.value < 1000) {
      console.log('使用缓存的分支状态，跳过API调用');
      return;
    }
    
    // 简化逻辑，移除防抖，直接发起请求
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
  async function getCurrentBranch(skipBranchStatus = false) {
    try {
      const response = await fetch('/api/branch')
      const data = await response.json()
      if (data.branch) {
        currentBranch.value = data.branch
        // 获取分支状态信息，但可以选择跳过
        if (!skipBranchStatus) {
          await getBranchStatus();
        }
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
    
    // 方法
    $reset,
    checkGitRepo,
    getCurrentBranch,
    getAllBranches,
    changeBranch,
    getUserInfo,
    createBranch,
    loadInitialData,
    clearUserConfig,
    restoreUserConfig,
    getBranchStatus,
    gitPull,
    gitFetchAll
  }
}) 
<script setup lang="ts">
import { ref, onMounted, h } from 'vue'
import GitStatus from '@views/components/GitStatus.vue'
import CommitForm from '@views/components/CommitForm.vue'
import LogList from '@views/components/LogList.vue'
import CommandHistory from '@views/components/CommandHistory.vue'
import CommonDialog from '@components/CommonDialog.vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Edit, Menu, Folder, Plus, Setting, User, Message, InfoFilled, Check, Delete, Clock } from '@element-plus/icons-vue'
import logo from '@assets/logo.svg'
import { useGitStore } from '@stores/gitStore'
import { useConfigStore } from '@stores/configStore'

const configInfo = ref('')
// 添加组件实例类型
const logListRef = ref<InstanceType<typeof LogList> | null>(null)
const gitStatusRef = ref<InstanceType<typeof GitStatus> | null>(null)
const commitFormRef = ref<InstanceType<typeof CommitForm> | null>(null)

// 使用Git Store
const gitStore = useGitStore()
// 使用Config Store
const configStore = useConfigStore()

// 添加初始化完成状态
const initCompleted = ref(false)
const currentDirectory = ref('')

// 更新配置信息显示
function updateConfigInfo() {
  if (configStore.config) {
    configInfo.value = `默认提交信息: ${configStore.config.defaultCommitMessage}`
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
    const dirData = await loadCurrentDirectory()

    // 确保配置已加载
    if (!configStore.isLoaded) {
      await configStore.loadConfig()
    }

    // 更新配置信息显示
    updateConfigInfo()

    // 设置Git仓库状态
    gitStore.isGitRepo = dirData.isGitRepo === true
    gitStore.lastCheckedTime = Date.now()

    // 只有是Git仓库的情况下才加载Git相关信息
    if (gitStore.isGitRepo) {
      // 并行获取所有Git信息，确保每个API只调用一次
      await Promise.all([
        gitStore.getCurrentBranch(true), // 强制获取当前分支（页面首次加载）
        gitStore.getAllBranches(),       // 获取所有分支
        gitStore.getUserInfo(),          // 获取用户信息
        gitStore.getRemoteUrl(),         // 获取远程仓库地址
        gitStore.getBranchStatus(true)   // 强制获取分支状态（页面首次加载）
      ])
    } else {
      ElMessage.warning('当前目录不是Git仓库，部分功能将不可用')
    }
  } catch (error) {
    console.error('初始化失败:', error)
  } finally {
    // 标记初始化完成
    initCompleted.value = true
    console.log('---------- 页面初始化完成 ----------')

    // 无论是否是Git仓库，都应该加载布局比例
    // 使用短延时确保DOM已完全渲染
    setTimeout(() => {
      loadLayoutRatios();
    }, 100);
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

// 添加分隔条相关逻辑
let isVResizing = false;
let isVBottomResizing = false;
let isHResizing = false;
let initialX = 0;
let initialY = 0;
let initialGridTemplateColumns = '';
let initialGridTemplateRows = '';
let activeResizer = null;

// 保存布局比例到localStorage
function saveLayoutRatios() {
  const gridLayout = document.querySelector('.grid-layout') as HTMLElement;
  if (!gridLayout) return;

  // 获取当前的列和行比例
  const columns = getComputedStyle(gridLayout).gridTemplateColumns.split(' ');
  const rows = getComputedStyle(gridLayout).gridTemplateRows.split(' ');

  if (columns.length >= 3 && rows.length >= 3) {
    // 解析左右区域比例
    const leftColWidth = parseFloat(columns[0]);
    const rightColWidth = parseFloat(columns[2]);
    const totalWidth = leftColWidth + rightColWidth;
    const leftRatio = leftColWidth / totalWidth;

    // 解析上下区域比例
    const topRowHeight = parseFloat(rows[0]);
    const bottomRowHeight = parseFloat(rows[2]);
    const totalHeight = topRowHeight + bottomRowHeight;
    const topRatio = topRowHeight / totalHeight;

    // 保存到localStorage
    localStorage.setItem('zen-gitsync-layout-left-ratio', leftRatio.toString());
    localStorage.setItem('zen-gitsync-layout-top-ratio', topRatio.toString());

    console.log(`布局比例已保存 - 左侧: ${(leftRatio * 100).toFixed(0)}%, 上方: ${(topRatio * 100).toFixed(0)}%`);
    
    // 保存底部左右区域比例
    // 注意：底部的列布局与顶部相同，但需要单独保存以防将来改为不同布局
    localStorage.setItem('zen-gitsync-layout-bottom-left-ratio', leftRatio.toString());
    
    console.log(`底部布局比例已保存 - 左侧: ${(leftRatio * 100).toFixed(0)}%`);
  }
}

// 加载布局比例
function loadLayoutRatios() {
  const gridLayout = document.querySelector('.grid-layout') as HTMLElement;
  if (!gridLayout) return;

  // 从localStorage获取保存的比例
  const savedLeftRatio = localStorage.getItem('zen-gitsync-layout-left-ratio');
  const savedTopRatio = localStorage.getItem('zen-gitsync-layout-top-ratio');

  // 应用左右区域比例
  if (savedLeftRatio) {
    const leftRatio = parseFloat(savedLeftRatio);
    const rightRatio = 1 - leftRatio;
    gridLayout.style.gridTemplateColumns = `${leftRatio}fr 8px ${rightRatio}fr`;
    console.log(`已恢复左侧比例: ${(leftRatio * 100).toFixed(0)}%`);
  } else {
    // 默认比例 1:3
    gridLayout.style.gridTemplateColumns = "1fr 8px 3fr";
  }

  // 应用上下区域比例
  if (savedTopRatio) {
    const topRatio = parseFloat(savedTopRatio);
    const bottomRatio = 1 - topRatio;
    gridLayout.style.gridTemplateRows = `${topRatio}fr 8px ${bottomRatio}fr`;
    console.log(`已恢复上方比例: ${(topRatio * 100).toFixed(0)}%`);
  }
  
  // 注意：底部的列布局与顶部相同，使用相同的gridTemplateColumns，
  // 但如果将来需要独立控制，可以使用savedBottomLeftRatio
}

function startVResize(event: MouseEvent) {
  // 记录当前操作的分隔条
  const target = event.currentTarget as HTMLElement;
  if (!target || !target.id) return;
  
  activeResizer = target.id;
  
  // 根据分隔条位置，设置不同的状态
  if (activeResizer === 'v-resizer') {
    isVResizing = true;
  } else if (activeResizer === 'v-resizer-bottom') {
    isVBottomResizing = true;
  }
  
  initialX = event.clientX;

  const gridLayout = document.querySelector('.grid-layout') as HTMLElement;
  initialGridTemplateColumns = getComputedStyle(gridLayout).gridTemplateColumns;

  // 标记当前激活的分隔条
  document.getElementById(activeResizer)?.classList.add('active');

  document.addEventListener('mousemove', handleVResize);
  document.addEventListener('mouseup', stopVResize);

  // 防止文本选择
  event.preventDefault();
}

function handleVResize(event: MouseEvent) {
  if (!isVResizing && !isVBottomResizing) return;

  const gridLayout = document.querySelector('.grid-layout') as HTMLElement;
  const delta = event.clientX - initialX;

  // 解析当前的网格模板列值
  const columns = initialGridTemplateColumns.split(' ');

  // 确保我们有足够的列
  if (columns.length >= 3) {
    // 计算新的左列宽度
    const leftColWidth = parseFloat(columns[0]);
    const rightColWidth = parseFloat(columns[2]);

    // 计算新的左右列比例
    const totalWidth = leftColWidth + rightColWidth;
    const newLeftRatio = (leftColWidth + delta / gridLayout.clientWidth * totalWidth) / totalWidth;
    const newRightRatio = 1 - newLeftRatio;

    // 确保左侧宽度不小于总宽度的10%且不大于50%
    const minLeftRatio = 0.1;
    const maxLeftRatio = 0.5;

    if (newLeftRatio < minLeftRatio) {
      gridLayout.style.gridTemplateColumns = `${minLeftRatio}fr 8px ${1 - minLeftRatio}fr`;
    } else if (newLeftRatio > maxLeftRatio) {
      gridLayout.style.gridTemplateColumns = `${maxLeftRatio}fr 8px ${1 - maxLeftRatio}fr`;
    } else {
      gridLayout.style.gridTemplateColumns = `${newLeftRatio}fr 8px ${newRightRatio}fr`;
    }
  }
}

function stopVResize() {
  isVResizing = false;
  isVBottomResizing = false;
  
  // 移除所有分隔条的active类
  document.getElementById('v-resizer')?.classList.remove('active');
  document.getElementById('v-resizer-bottom')?.classList.remove('active');
  
  document.removeEventListener('mousemove', handleVResize);
  document.removeEventListener('mouseup', stopVResize);

  // 保存布局比例
  saveLayoutRatios();
}

function startHResize(event: MouseEvent) {
  isHResizing = true;
  initialY = event.clientY;

  const gridLayout = document.querySelector('.grid-layout') as HTMLElement;
  initialGridTemplateRows = getComputedStyle(gridLayout).gridTemplateRows;

  document.getElementById('h-resizer')?.classList.add('active');

  document.addEventListener('mousemove', handleHResize);
  document.addEventListener('mouseup', stopHResize);

  // 防止文本选择
  event.preventDefault();
}

function handleHResize(event: MouseEvent) {
  if (!isHResizing) return;

  const gridLayout = document.querySelector('.grid-layout') as HTMLElement;
  const delta = event.clientY - initialY;

  // 解析当前的网格模板行值
  const rows = initialGridTemplateRows.split(' ');

  // 确保我们有足够的行
  if (rows.length >= 3) {
    // 计算新的上行高度
    const topRowHeight = parseFloat(rows[0]);
    const bottomRowHeight = parseFloat(rows[2]);

    // 计算新的上下行比例
    const totalHeight = topRowHeight + bottomRowHeight;
    const newTopRatio = (topRowHeight + delta / gridLayout.clientHeight * totalHeight) / totalHeight;
    const newBottomRatio = 1 - newTopRatio;

    // 确保上方区域不小于总高度的20%且不大于80%
    const minTopRatio = 0.2;
    const maxTopRatio = 0.8;

    if (newTopRatio < minTopRatio) {
      gridLayout.style.gridTemplateRows = `${minTopRatio}fr 8px ${1 - minTopRatio}fr`;
    } else if (newTopRatio > maxTopRatio) {
      gridLayout.style.gridTemplateRows = `${maxTopRatio}fr 8px ${1 - maxTopRatio}fr`;
    } else {
      gridLayout.style.gridTemplateRows = `${newTopRatio}fr 8px ${newBottomRatio}fr`;
    }
  }
}

function stopHResize() {
  isHResizing = false;
  document.getElementById('h-resizer')?.classList.remove('active');
  document.removeEventListener('mousemove', handleHResize);
  document.removeEventListener('mouseup', stopHResize);

  // 保存布局比例
  saveLayoutRatios();
}

// 添加目录切换相关逻辑
const isDirectoryDialogVisible = ref(false)
const newDirectoryPath = ref('')
const isChangingDirectory = ref(false)
const recentDirectories = ref<string[]>([])


// 打开切换目录对话框
function openDirectoryDialog() {
  newDirectoryPath.value = currentDirectory.value
  isDirectoryDialogVisible.value = true
  
  // 获取最近使用过的目录
  getRecentDirectories()
}

// 获取最近访问的目录
async function getRecentDirectories() {
  try {
    const response = await fetch('/api/recent_directories')
    const result = await response.json()
    
    if (result.success && Array.isArray(result.directories)) {
      recentDirectories.value = result.directories
    }
  } catch (error) {
    console.error('获取最近目录失败:', error)
  }
}

// 切换目录
async function changeDirectory() {
  if (!newDirectoryPath.value) {
    ElMessage.warning('目录路径不能为空')
    return
  }

  try {
    isChangingDirectory.value = true
    const response = await fetch('/api/change_directory', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ path: newDirectoryPath.value })
    })

    const result = await response.json()

    if (result.success) {
      ElMessage.success('已切换工作目录')
      currentDirectory.value = result.directory
      isDirectoryDialogVisible.value = false

      // 保存到最近使用的目录
      await saveRecentDirectory(result.directory)
      // 立即刷新最近目录列表，确保对话框里立刻可见
      await getRecentDirectories()

      // 直接使用API返回的Git仓库状态
      gitStore.isGitRepo = result.isGitRepo

      // 切换目录后，强制重新加载当前项目配置（确保新项目配置被初始化并反映到前端）
      await configStore.loadConfig(true)

      // 如果是Git仓库，加载Git相关数据
      if (result.isGitRepo) {
        // 加载Git分支和用户信息
        await Promise.all([
          gitStore.getCurrentBranch(),
          gitStore.getAllBranches(),
          gitStore.getUserInfo(),
          gitStore.getRemoteUrl()
        ])

        // 刷新Git状态
        if (gitStatusRef.value) {
          gitStatusRef.value.refreshStatus()
        }

        // 刷新提交历史
        if (logListRef.value) {
          logListRef.value.refreshLog()
        }
      } else {
        ElMessage.warning('当前目录不是Git仓库，部分功能将不可用')
        // 清空Git相关状态
        gitStore.$reset()
      }
    } else {
      ElMessage.error(result.error || '切换目录失败')
    }
  } catch (error) {
    ElMessage.error(`切换目录失败: ${(error as Error).message}`)
  } finally {
    isChangingDirectory.value = false
  }
}

// 保存最近使用的目录
async function saveRecentDirectory(directory: string) {
  try {
    await fetch('/api/save_recent_directory', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ path: directory })
    })
  } catch (error) {
    console.error('保存最近目录失败:', error)
  }
}

// 在资源管理器中打开当前目录
async function openInFileExplorer() {
  try {
    if (!currentDirectory.value) {
      ElMessage.warning('当前目录路径为空')
      return
    }
    
    const response = await fetch('/api/open_directory', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ path: currentDirectory.value })
    })
    
    const result = await response.json()
    
    if (result.success) {
      ElMessage.success('已在文件管理器中打开目录')
    } else if (result.error) {
      ElMessage.error(result.error)
    }
  } catch (error) {
    console.error('打开目录失败:', error)
    ElMessage.error(`打开目录失败: ${(error as Error).message}`)
  }
}

// 添加浏览目录的功能
async function browseDirectory() {
  try {
    const response = await fetch('/api/browse_directory', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        currentPath: newDirectoryPath.value || currentDirectory.value 
      })
    })
    
    const result = await response.json()
    
    if (result.success) {
      // 打开目录选择对话框
      selectDirectoryDialog(result)
    } else if (result.error) {
      ElMessage.error(result.error)
    }
  } catch (error) {
    console.error('浏览目录失败:', error)
    ElMessage.error(`浏览目录失败: ${(error as Error).message}`)
  }
}

// 打开目录选择对话框
function selectDirectoryDialog(directoryData: any) {
  if (!directoryData || !directoryData.items) return
  
  ElMessageBox.alert(
    h('div', { class: 'directory-browser' }, [
      h('div', { class: 'current-path' }, [
        h('span', { class: 'path-label' }, '当前路径: '),
        h('span', { class: 'path-value' }, directoryData.path)
      ]),
      h('div', { class: 'directory-list' }, [
        // 添加返回上级目录选项
        directoryData.parentPath ? h('div', { 
          class: 'directory-item parent-dir',
          onClick: () => {
            selectDirectory(directoryData.parentPath)
          }
        }, [
          h('span', { class: 'dir-icon' }, 
            h('svg', { 
              class: 'folder-icon', 
              viewBox: '0 0 24 24',
              width: '20',
              height: '20',
              style: { fill: '#E6A23C' }
            }, [
              h('path', { d: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z' })
            ])
          ),
          h('span', { class: 'dir-name' }, '返回上级目录')
        ]) : null,
        // 列出当前目录下的所有子目录
        ...directoryData.items.map((item: any) => h('div', { 
          class: 'directory-item',
          onClick: () => {
            selectDirectory(item.path)
          }
        }, [
          h('span', { class: 'dir-icon' },
            h('svg', { 
              class: 'folder-icon', 
              viewBox: '0 0 24 24',
              width: '20',
              height: '20',
              style: { fill: '#409EFF' }
            }, [
              h('path', { d: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z' })
            ])
          ),
          h('span', { class: 'dir-name' }, item.name)
        ]))
      ])
    ]),
    '浏览并选择目录',
    {
      confirmButtonText: '使用当前目录',
      customClass: 'directory-browser-dialog',
      callback: (action: string) => {
        if (action === 'confirm') {
          newDirectoryPath.value = directoryData.path
        }
      }
    }
  )
}

// 选择目录
async function selectDirectory(dirPath: string) {
  try {
    // 先关闭当前对话框
    ElMessageBox.close();
    
    // 延迟一小段时间再打开新对话框，确保旧对话框已完全关闭
    setTimeout(async () => {
      try {
        const response = await fetch('/api/browse_directory', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ currentPath: dirPath })
        });
        
        const result = await response.json();
        
        if (result.success) {
          // 重新打开目录选择对话框，显示新的目录内容
          selectDirectoryDialog(result);
        } else if (result.error) {
          ElMessage.error(result.error);
        }
      } catch (error) {
        console.error('浏览目录失败:', error);
        ElMessage.error(`浏览目录失败: ${(error as Error).message}`);
      }
    }, 100);
  } catch (error) {
    console.error('处理目录选择时出错:', error);
    ElMessage.error(`处理目录选择时出错: ${(error as Error).message}`);
  }
}
</script>

<template>
  <header class="main-header">
    <div class="header-left">
      <img :src="logo" alt="Zen GitSync Logo" class="logo" />
      <h1>Zen GitSync</h1>
    </div>
    <div class="header-info">
      <div id="user-info" v-if="gitStore.userName && gitStore.userEmail">
        <span class="user-name">{{ gitStore.userName }}</span>
        <span class="user-email">&lt;{{ gitStore.userEmail }}&gt;</span>
        <el-tooltip content="用户设置" placement="bottom" effect="dark" :open-delay="500">
          <button class="modern-btn user-settings-btn" @click="openUserSettingsDialog">
            <el-icon class="btn-icon">
              <Setting />
            </el-icon>
          </button>
        </el-tooltip>
      </div>
      <div id="user-info" v-else>
        <span class="user-label">用户: </span>
        <span class="user-warning">未配置</span>
        <el-tooltip content="用户设置" placement="bottom" effect="dark" :open-delay="500">
          <button class="modern-btn user-settings-btn" @click="openUserSettingsDialog">
            <el-icon class="btn-icon">
              <Setting />
            </el-icon>
          </button>
        </el-tooltip>
      </div>
      <!-- 添加目录选择功能 -->
      <div class="directory-selector">
        <div class="directory-display">
          <div class="directory-icon">
            <el-icon>
              <Folder />
            </el-icon>
          </div>
          <div class="directory-path" :title="currentDirectory">{{ currentDirectory }}</div>
        </div>
        <div class="directory-actions">
          <el-tooltip content="切换目录" placement="bottom" effect="dark" :open-delay="500">
            <button class="modern-btn dir-btn" @click="openDirectoryDialog">
              <el-icon class="btn-icon">
                <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
                  <path fill="currentColor"
                    d="M128 192v640h768V320H485.76L357.504 192H128zm-32-64h287.872l128.384 128H928a32 32 0 0 1 32 32v576a32 32 0 0 1-32 32H96a32 32 0 0 1-32-32V160a32 32 0 0 1 32-32z">
                  </path>
                </svg>
              </el-icon>
            </button>
          </el-tooltip>
          <el-tooltip content="在资源管理器中打开" placement="bottom" effect="dark" :open-delay="500">
            <button class="modern-btn dir-btn" @click="openInFileExplorer">
              <el-icon class="btn-icon">
                <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
                  <path fill="currentColor" 
                    d="M928 444H820V330.4c0-17.7-14.3-32-32-32H473L355.7 186.2a8.15 8.15 0 0 0-5.5-2.2H96c-17.7 0-32 14.3-32 32v592c0 17.7 14.3 32 32 32h698c13 0 24.8-7.9 29.7-20l134-332c1.5-3.8 2.3-7.9 2.3-12 0-17.7-14.3-32-32-32zM136 256h188.5l119.6 114.4H748V444H238c-13 0-24.8 7.9-29.7 20L136 643.2V256zm635.3 512H159l103.3-256h612.4L771.3 768z" />
                </svg>
              </el-icon>
            </button>
          </el-tooltip>
        </div>
      </div>

      <!-- 顶部右侧动作 -->
      <div class="header-actions-right" v-if="gitStore.isGitRepo">
        <!-- 命令历史按钮 -->
        <div class="command-history-section" v-if="gitStore.isGitRepo">
          <CommandHistory />
        </div>
        <el-tooltip content="编辑项目配置" placement="bottom" effect="dark" :open-delay="500">
          <button class="modern-btn config-btn" @click="commitFormRef?.openConfigEditor()">
            <el-icon class="btn-icon"><Edit /></el-icon>
          </button>
        </el-tooltip>
        <el-tooltip content="Git 操作" placement="bottom" effect="dark" :open-delay="500">
          <button class="modern-btn drawer-btn" @click="commitFormRef?.toggleGitOperationsDrawer()">
            <el-icon class="btn-icon"><Menu /></el-icon>
          </button>
        </el-tooltip>
      </div>
    </div>
  </header>

  <main class="main-container">
    <div v-if="!initCompleted" class="loading-container">
      <el-card class="loading-card">
        <div class="loading-spinner">
          <el-icon class="is-loading"><svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
              <path fill="currentColor"
                d="M512 64a32 32 0 0 1 32 32v192a32 32 0 0 1-64 0V96a32 32 0 0 1 32-32zm0 640a32 32 0 0 1 32 32v192a32 32 0 1 1-64 0V736a32 32 0 0 1 32-32zm448-192a32 32 0 0 1-32 32H736a32 32 0 1 1 0-64h192a32 32 0 0 1 32 32zm-640 0a32 32 0 0 1-32 32H96a32 32 0 0 1 0-64h192a32 32 0 0 1 32 32zM195.2 195.2a32 32 0 0 1 45.248 0L376.32 331.008a32 32 0 0 1-45.248 45.248L195.2 240.448a32 32 0 0 1 0-45.248zm452.544 452.544a32 32 0 0 1 45.248 0L828.8 783.552a32 32 0 0 1-45.248 45.248L647.744 692.992a32 32 0 0 1 0-45.248zM828.8 195.264a32 32 0 0 1 0 45.184L692.992 376.32a32 32 0 0 1-45.248-45.248l135.808-135.808a32 32 0 0 1 45.248 0zm-452.544 452.48a32 32 0 0 1 0 45.248L240.448 828.8a32 32 0 0 1-45.248-45.248l135.808-135.808a32 32 0 0 1 45.248 0z">
                </path>
              </svg></el-icon>
        </div>
        <div class="loading-text">加载中...</div>
      </el-card>
    </div>

    <div v-else class="grid-layout">
      <!-- 上方左侧Git状态 -->
      <div class="git-status-panel">
        <GitStatus ref="gitStatusRef" :initial-directory="currentDirectory" />
      </div>

      <!-- 垂直分隔条 -->
      <div class="vertical-resizer" id="v-resizer" @mousedown="startVResize"></div>

      <!-- 上方右侧提交表单 -->
      <div class="commit-form-panel" v-if="gitStore.isGitRepo">
        <!-- 当用户未配置时显示配置提示 -->
        <div v-if="!gitStore.userName || !gitStore.userEmail" class="card">
          <h2>Git用户未配置</h2>
          <p>请先配置Git用户信息才能进行提交操作。</p>
          <div class="tips">
            <h3>您可以通过以下方式配置：</h3>
            <ol>
              <li>点击右上角的设置按钮，配置用户名和邮箱</li>
              <li>或者使用命令行配置：</li>
              <div class="code-block">
                git config --global user.name "您的用户名"<br>
                git config --global user.email "您的邮箱"
              </div>
            </ol>
            <el-button type="primary" @click="openUserSettingsDialog">
              立即配置
            </el-button>
          </div>
        </div>
        <!-- 用户已配置显示提交表单 -->
        <template v-else>
          <CommitForm ref="commitFormRef" />
        </template>
      </div>
      <div class="commit-form-panel" v-else>
        <div class="card" style="padding: 20px;">
          <h2>Git仓库初始化</h2>
          <p>当前目录不是Git仓库，请先初始化Git仓库或切换到Git仓库目录。</p>
          <!-- 实用提示 -->
          <div class="tips">
            <h3>可以使用以下命令初始化仓库：</h3>
            <div class="code-block">git init</div>
          </div>
        </div>
      </div>

      <!-- 水平分隔条 -->
      <div class="horizontal-resizer" id="h-resizer" @mousedown="startHResize"></div>

      <!-- 下方提交历史 -->
      <div class="log-list-panel" v-if="gitStore.isGitRepo">
        <LogList ref="logListRef" />
      </div>

      <!-- 创建分支对话框 -->
      <CommonDialog
        v-model="createBranchDialogVisible"
        title="创建新分支"
        size="small"
        :destroy-on-close="true"
        custom-class="create-branch-dialog"
      >
        <div class="create-branch-content">
          <el-form :model="{ newBranchName, selectedBaseBranch }" label-position="top">
            <el-form-item>
              <template #label>
                <div class="form-label">
                  <el-icon class="label-icon"><Plus /></el-icon>
                  <span>新分支名称</span>
                </div>
              </template>
              <el-input 
                v-model="newBranchName" 
                placeholder="请输入新分支名称" 
                class="modern-input"
                size="large"
              />
            </el-form-item>
            <el-form-item>
              <template #label>
                <div class="form-label">
                  <el-icon class="label-icon"><Menu /></el-icon>
                  <span>基于分支</span>
                </div>
              </template>
              <el-select 
                v-model="selectedBaseBranch" 
                placeholder="选择基础分支" 
                class="modern-select"
                size="large"
                style="width: 100%;"
              >
                <el-option v-for="branch in gitStore.allBranches" :key="branch" :label="branch" :value="branch" />
              </el-select>
            </el-form-item>
          </el-form>
        </div>
        <template #footer>
          <div class="create-branch-footer">
            <div class="footer-actions">
              <button type="button" class="footer-btn cancel-btn" @click="createBranchDialogVisible = false">
                取消
              </button>
              <button type="button" class="footer-btn primary-btn" @click="createNewBranch" :disabled="gitStore.isCreatingBranch">
                <el-icon v-if="!gitStore.isCreatingBranch"><Check /></el-icon>
                <el-icon class="is-loading" v-else>
                  <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
                    <path fill="currentColor" d="M512 64a32 32 0 0 1 32 32v192a32 32 0 0 1-64 0V96a32 32 0 0 1 32-32zm0 640a32 32 0 0 1 32 32v192a32 32 0 1 1-64 0V736a32 32 0 0 1 32-32zm448-192a32 32 0 0 1-32 32H736a32 32 0 1 1 0-64h192a32 32 0 0 1 32 32zm-640 0a32 32 0 0 1-32 32H96a32 32 0 0 1 0-64h192a32 32 0 0 1 32 32z" />
                  </svg>
                </el-icon>
                <span>创建</span>
              </button>
            </div>
          </div>
        </template>
      </CommonDialog>

    </div>
  </main>

  <footer class="main-footer">
    <div class="branch-info" v-if="gitStore.currentBranch">
      <div class="branch-wrapper">
        <span class="branch-label">当前分支:</span>
        <el-select v-model="gitStore.currentBranch" size="small" @change="handleBranchChange"
          :loading="gitStore.isChangingBranch" class="branch-select">
          <el-option v-for="branch in gitStore.allBranches" :key="branch" :label="branch" :value="branch" />
        </el-select>
        <button class="modern-btn create-branch-btn" @click="openCreateBranchDialog">
          <el-icon class="btn-icon">
            <Plus />
          </el-icon>
          <span class="btn-text">新建分支</span>
        </button>
      </div>
    </div>
    <div class="footer-right" v-if="gitStore.remoteUrl">
      <span class="repo-url-label">远程仓库:</span>
      <span class="repo-url">{{ gitStore.remoteUrl }}</span>
      <el-tooltip content="复制仓库地址" placement="top" effect="dark" :open-delay="500">
        <button class="modern-btn copy-url-btn" @click="gitStore.copyRemoteUrl()">
          <el-icon class="btn-icon">
            <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
              <path fill="currentColor"
                d="M768 832a128 128 0 0 1-128 128H192A128 128 0 0 1 64 832V384a128 128 0 0 1 128-128v64a64 64 0 0 0-64 64v448a64 64 0 0 0 64 64h448a64 64 0 0 0 64-64h64z" />
              <path fill="currentColor"
                d="M384 128a64 64 0 0 0-64 64v448a64 64 0 0 0 64 64h448a64 64 0 0 0 64-64V192a64 64 0 0 0-64-64H384zm0-64h448a128 128 0 0 1 128 128v448a128 128 0 0 1-128 128H384a128 128 0 0 1-128-128V192A128 128 0 0 1 384 64z" />
            </svg>
          </el-icon>
        </button>
      </el-tooltip>
    </div>
  </footer>

  <!-- 用户设置对话框 -->
  <CommonDialog
    v-model="userSettingsDialogVisible"
    title="Git 用户设置"
    size="small"
    :destroy-on-close="true"
    custom-class="user-settings-dialog"
  >
    <div class="user-settings-content">
      <el-form class="user-form" :model="{ tempUserName, tempUserEmail }" label-position="top">
        <div class="form-group">
          <el-form-item class="form-item">
            <template #label>
              <div class="form-label">
                <el-icon class="label-icon"><User /></el-icon>
                <span>用户名</span>
              </div>
            </template>
            <el-input 
              v-model="tempUserName" 
              placeholder="请输入 Git 用户名" 
              class="modern-input"
              size="large"
            />
          </el-form-item>
        </div>
        
        <div class="form-group">
          <el-form-item class="form-item">
            <template #label>
              <div class="form-label">
                <el-icon class="label-icon"><Message /></el-icon>
                <span>邮箱地址</span>
              </div>
            </template>
            <el-input 
              v-model="tempUserEmail" 
              placeholder="请输入 Git 邮箱地址" 
              class="modern-input"
              size="large"
            />
          </el-form-item>
        </div>
        
        <div class="info-section">
          <div class="info-card">
            <div class="info-icon">
              <el-icon><InfoFilled /></el-icon>
            </div>
            <div class="info-content">
              <p class="info-title">全局配置</p>
              <p class="info-desc">这些设置将影响全局 Git 配置，对所有 Git 仓库生效</p>
            </div>
          </div>
        </div>
      </el-form>
    </div>
    
    <template #footer>
      <div class="user-settings-footer">
        <button type="button" class="footer-btn danger-btn" @click="clearUserSettings">
          <el-icon><Delete /></el-icon>
          <span>清除配置</span>
        </button>
        <div class="footer-actions">
          <button type="button" class="footer-btn cancel-btn" @click="userSettingsDialogVisible = false">
            取消
          </button>
          <button type="button" class="footer-btn primary-btn" @click="saveUserSettings">
            <el-icon><Check /></el-icon>
            <span>保存设置</span>
          </button>
        </div>
      </div>
    </template>
  </CommonDialog>

  <!-- 添加切换目录对话框 -->
  <CommonDialog
    v-model="isDirectoryDialogVisible"
    title="切换工作目录"
    size="medium"
    :destroy-on-close="true"
    custom-class="directory-dialog"
  >
    <div class="directory-content">
      <el-form label-position="top">
        <el-form-item>
          <template #label>
            <div class="form-label">
              <el-icon class="label-icon"><Folder /></el-icon>
              <span>目录路径</span>
            </div>
          </template>
          <div class="directory-input-group">
            <el-input 
              v-model="newDirectoryPath" 
              placeholder="请输入目录路径" 
              class="modern-input"
              size="large"
            />
            <button type="button" class="browse-btn" @click="browseDirectory">
              <el-icon><Folder /></el-icon>
              <span>浏览</span>
            </button>
          </div>
        </el-form-item>
        <el-form-item v-if="recentDirectories.length > 0">
          <template #label>
            <div class="form-label">
              <el-icon class="label-icon"><Clock /></el-icon>
              <span>常用目录</span>
            </div>
          </template>
          <div class="recent-directories">
            <div 
              v-for="(dir, index) in recentDirectories" 
              :key="index" 
              class="recent-dir-item"
              @click="newDirectoryPath = dir"
            >
              <el-icon class="dir-icon"><Folder /></el-icon>
              <span class="dir-path">{{ dir }}</span>
            </div>
          </div>
        </el-form-item>
      </el-form>
    </div>
    <template #footer>
      <div class="directory-footer">
        <div class="footer-actions">
          <button type="button" class="footer-btn cancel-btn" @click="isDirectoryDialogVisible = false">
            取消
          </button>
          <button type="button" class="footer-btn primary-btn" @click="changeDirectory()" :disabled="isChangingDirectory">
            <el-icon v-if="!isChangingDirectory"><Check /></el-icon>
            <el-icon class="is-loading" v-else>
              <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
                <path fill="currentColor" d="M512 64a32 32 0 0 1 32 32v192a32 32 0 0 1-64 0V96a32 32 0 0 1 32-32zm0 640a32 32 0 0 1 32 32v192a32 32 0 1 1-64 0V736a32 32 0 0 1 32-32zm448-192a32 32 0 0 1-32 32H736a32 32 0 1 1 0-64h192a32 32 0 0 1 32 32zm-640 0a32 32 0 0 1-32 32H96a32 32 0 0 1 0-64h192a32 32 0 0 1 32 32z" />
              </svg>
            </el-icon>
            <span>切换</span>
          </button>
        </div>
      </div>
    </template>
  </CommonDialog>
</template>

<style>
body {
  font-family: 'Arial', sans-serif;
  margin: 0;
  padding: 0;
  background-color: #f5f5f5;
  overflow: hidden;
  /* 防止出现滚动条 */
  height: 100vh;
}

.main-container {
  position: fixed;
  top: 64px;
  /* 顶部导航栏高度 */
  bottom: 60px;
  /* 底部footer高度 */
  left: 0;
  right: 0;
  padding: 12px;
  overflow: hidden;
  z-index: 1001;
  /* 防止整体滚动 */
}

.grid-layout {
  display: grid;
  grid-template-columns: 2fr 4px 3fr;
  /* 左右区域比例为2:3, 分隔线从8px减少到4px */
  grid-template-rows: 1fr 4px 1fr;
  grid-template-areas:
    "git-status v-resizer commit-form"
    "h-resizer h-resizer h-resizer"
    "log-list log-list log-list";
  gap: 6px; /* 从10px减少到6px */
  height: 100%;
}

.git-status-panel {
  grid-area: git-status;
  overflow: hidden;
  max-height: 100%;
  padding: 0;
}

.commit-form-panel {
  grid-area: commit-form;
  overflow: hidden;
  max-height: 100%;
  padding: 0;
}

.log-list-panel {
  grid-area: log-list;
  overflow: hidden;
  max-height: 100%;
  padding: 0;
}



/* 确保每个卡片内部可以滚动 */
.card {
  background-color: white;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
  border: 1px solid rgba(0, 0, 0, 0.03);
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.main-header {
  background: linear-gradient(135deg, #1a1d23 0%, #24292e 50%, #2c3338 100%);
  color: white;
  padding: 0 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 1000;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15), 0 1px 3px rgba(0, 0, 0, 0.1);
  height: 64px;
  box-sizing: border-box;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 220px;
  flex: 1;
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
  align-items: center;
  gap: 8px;
  flex: 1;
  justify-content: flex-end;
  min-width: 0;
}

/* 调整用户信息和目录选择的排列 */
#user-info {
  display: flex;
  align-items: center;
  background: rgba(255, 255, 255, 0.06);
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(10px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  flex-shrink: 0;
  transition: all 0.2s ease;
}

#user-info:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.2);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

/* 添加目录选择器样式 */
.directory-selector {
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  padding: 8px 14px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(10px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  flex-shrink: 0;
  transition: all 0.2s ease;
  max-width: 420px;
}

.directory-selector:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.2);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.command-history-section {
  display: flex;
  align-items: center;
}

/* 顶部右侧动作区 */
.header-actions-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.modern-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.9);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  position: relative;
  overflow: hidden;
}

.modern-btn::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(135deg, rgba(64, 158, 255, 0.1) 0%, rgba(102, 177, 255, 0.1) 100%);
  opacity: 0;
  transition: opacity 0.2s ease;
}

.modern-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  color: white;
  border-color: rgba(255, 255, 255, 0.2);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.modern-btn:hover::before {
  opacity: 1;
}

.modern-btn:active {
  transform: translateY(0);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
}

.config-btn {
  padding: 10px;
  gap: 8px;
}

.drawer-btn {
  padding: 10px;
}

.modern-btn .btn-icon {
  font-size: 16px;
  transition: transform 0.2s ease;
  z-index: 1;
  position: relative;
}

.modern-btn .btn-text {
  font-size: 13px;
  font-weight: 500;
  z-index: 1;
  position: relative;
}

.drawer-btn:hover .btn-icon {
  transform: rotate(180deg);
}

.config-btn:hover .btn-icon {
  transform: scale(1.1);
}

.directory-display {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.directory-path {
  font-family: monospace;
  color: #ffffff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 14px;
  font-weight: 500;
  background-color: rgba(0, 0, 0, 0.2);
  padding: 4px 8px;
  border-radius: 3px;
  border-left: 3px solid #409EFF;
  flex: 1;
  min-width: 0;
  max-width: 500px;
}

.branch-label,
.user-label {
  font-weight: bold;
  margin-right: 5px;
}

.user-name {
  font-weight: bold;
  margin-right: 5px;
}

.user-email {
  color: #e0e0e0;
  font-size: 12px;
}

.branch-name {
  font-family: monospace;
}

.status-box {
  background-color: #f6f8fa;
  border: 1px solid #e1e4e8;
  border-radius: 3px;
  padding: 15px;
  white-space: pre-wrap;
  font-family: monospace;
  overflow-y: auto;
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

/* 加载中样式 */
.loading-container {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
}

.loading-card {
  width: 300px;
  text-align: center;
  padding: 30px;
}

.loading-spinner {
  font-size: 48px;
  color: #409eff;
}

.loading-text {
  font-size: 18px;
  color: #606266;
}

.user-warning {
  color: #E6A23C;
  font-weight: bold;
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
  box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.1);
  height: 60px;
  box-sizing: border-box;
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

.branch-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.branch-wrapper {
  display: flex;
  align-items: center;
  background-color: rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  padding: 8px 12px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  transition: all 0.3s;
}

.branch-wrapper:hover {
  background-color: rgba(255, 255, 255, 0.2);
}

.branch-label {
  margin-right: 10px;
  color: #ffffff;
}

  .branch-select {
    width: 200px;
    margin-right: 10px;
  }
  .footer-right {
    display: flex;
    align-items: center;
    gap: 8px;
    color: rgba(255, 255, 255, 0.9);
    font-size: 13px;
    background-color: rgba(255, 255, 255, 0.1);
    padding: 8px;
    border-radius: 4px;
  }
  .repo-url-label {
    font-weight: bold;
    margin-right: 8px;
    color: #ffffff;
  }

.repo-url {
  color: #e6f7ff;
  font-family: monospace;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}


/* 垂直分隔条样式 */
.vertical-resizer {
  grid-area: v-resizer;
  background-color: #e8e8e8;
  cursor: col-resize;
  transition: background-color 0.2s, box-shadow 0.2s;
  position: relative;
  z-index: 10;
  border-radius: 4px; /* 从8px减少到4px */
  box-shadow: 0 0 2px rgba(0, 0, 0, 0.1); /* 减小阴影 */
}

.vertical-resizer::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 2px; /* 从4px减少到2px */
  height: 40px; /* 从50px减少到40px */
  background-color: #a0a0a0;
  border-radius: 2px; /* 从4px减少到2px */
  transition: background-color 0.2s, width 0.2s, box-shadow 0.2s;
}

.vertical-resizer:hover,
.vertical-resizer.active {
  background-color: #d0d0d0;
  box-shadow: 0 0 4px rgba(0, 0, 0, 0.2); /* 减小阴影 */
}

.vertical-resizer:hover::after,
.vertical-resizer.active::after {
  background-color: #409EFF;
  width: 3px; /* 从6px减少到3px */
  box-shadow: 0 0 6px rgba(64, 158, 255, 0.6); /* 减小阴影 */
}

/* 水平分隔条样式 */
.horizontal-resizer {
  grid-area: h-resizer;
  background-color: #e8e8e8;
  cursor: row-resize;
  transition: background-color 0.2s, box-shadow 0.2s;
  position: relative;
  z-index: 10;
  border-radius: 4px; /* 从8px减少到4px */
  box-shadow: 0 0 2px rgba(0, 0, 0, 0.1); /* 减小阴影 */
}

.horizontal-resizer::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 40px; /* 从50px减少到40px */
  height: 2px; /* 从4px减少到2px */
  background-color: #a0a0a0;
  border-radius: 2px; /* 从4px减少到2px */
  transition: background-color 0.2s, height 0.2s, box-shadow 0.2s;
}

.horizontal-resizer:hover,
.horizontal-resizer.active {
  background-color: #d0d0d0;
  box-shadow: 0 0 4px rgba(0, 0, 0, 0.2); /* 减小阴影 */
}

.horizontal-resizer:hover::after,
.horizontal-resizer.active::after {
  background-color: #409EFF;
  height: 3px; /* 从6px减少到3px */
  box-shadow: 0 0 6px rgba(64, 158, 255, 0.6); /* 减小阴影 */
}

.vertical-resizer-bottom {
  grid-area: v-resizer-bottom;
  background-color: #e8e8e8;
  cursor: col-resize;
  transition: background-color 0.2s, box-shadow 0.2s;
  position: relative;
  z-index: 10;
  border-radius: 4px; /* 从8px减少到4px */
  box-shadow: 0 0 2px rgba(0, 0, 0, 0.1); /* 减小阴影 */
}

.vertical-resizer-bottom::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 2px; /* 从4px减少到2px */
  height: 40px; /* 从50px减少到40px */
  background-color: #a0a0a0;
  border-radius: 2px; /* 从4px减少到2px */
  transition: background-color 0.2s, width 0.2s, box-shadow 0.2s;
}

.vertical-resizer-bottom:hover,
.vertical-resizer-bottom.active {
  background-color: #d0d0d0;
  box-shadow: 0 0 4px rgba(0, 0, 0, 0.2); /* 减小阴影 */
}

.vertical-resizer-bottom:hover::after,
.vertical-resizer-bottom.active::after {
  background-color: #409EFF;
  width: 3px; /* 从6px减少到3px */
  box-shadow: 0 0 6px rgba(64, 158, 255, 0.6); /* 减小阴影 */
}

/* 添加目录选择器样式 */
.directory-selector {
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  background-color: rgba(40, 44, 52, 0.7);
  border-radius: 4px;
  padding: 8px 12px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.directory-display {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  /* 防止flex子项溢出 */
}

.directory-path {
  font-family: monospace;
  color: #ffffff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 14px;
  font-weight: 500;
  background-color: rgba(0, 0, 0, 0.2);
  padding: 4px 8px;
  border-radius: 3px;
  border-left: 3px solid #409EFF;
  flex: 1;
  min-width: 0;
  /* 防止flex子项溢出 */
  max-width: 350px;
  /* 控制最大宽度 */
}

.directory-actions {
  display: flex;
  gap: 6px;
  margin-left: 8px;
}

.dir-btn {
  width: 32px;
  height: 32px;
  padding: 0;
}

.user-settings-btn {
  width: 32px;
  height: 32px;
  padding: 0;
  margin-left: 10px;
}

.create-branch-btn {
  padding: 8px 12px;
  gap: 6px;
}

.copy-url-btn {
  width: 32px;
  height: 32px;
  padding: 0;
}

/* 用户设置对话框样式 */
.user-settings-content {
  padding: 8px 0;
}

.user-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-group {
  position: relative;
}

.form-item {
  margin-bottom: 0;
}

:deep(.form-item .el-form-item__label) {
  padding: 0 0 8px 0;
  font-weight: 500;
  color: #374151;
}

.form-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
  color: #374151;
}

.label-icon {
  font-size: 16px;
  color: #6b7280;
}

:deep(.modern-input .el-input__wrapper) {
  border-radius: 8px;
  border: 1px solid #e5e7eb;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  transition: all 0.2s ease;
  padding: 10px 12px;
  background: #ffffff;
}

:deep(.modern-input .el-input__wrapper:hover) {
  border-color: #d1d5db;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
}

:deep(.modern-input.is-focus .el-input__wrapper) {
  border-color: #3498db;
  box-shadow: 0 0 0 2px rgba(52, 152, 219, 0.1), 0 2px 6px rgba(0, 0, 0, 0.08);
}

:deep(.modern-input .el-input__inner) {
  font-size: 14px;
  color: #374151;
  font-weight: 400;
}

:deep(.modern-input .el-input__inner::placeholder) {
  color: #9ca3af;
  font-weight: 400;
}

.info-section {
  margin-top: 4px;
}

.info-card {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 14px;
  background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
  border: 1px solid #bae6fd;
  border-radius: 8px;
  position: relative;
  overflow: hidden;
}

.info-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 3px;
  height: 100%;
  background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%);
}

.info-icon {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #0284c7;
  flex-shrink: 0;
  margin-top: 1px;
}

.info-icon .el-icon {
  font-size: 16px;
}

.info-content {
  flex: 1;
}

.info-title {
  margin: 0 0 3px 0;
  font-size: 13px;
  font-weight: 600;
  color: #0c4a6e;
}

.info-desc {
  margin: 0;
  font-size: 12px;
  color: #075985;
  line-height: 1.4;
}

.user-settings-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0;
}

.footer-actions {
  display: flex;
  gap: 8px;
}

.footer-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
  overflow: hidden;
}

.footer-btn::before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.2), transparent);
  transition: left 0.5s;
}

.footer-btn:hover::before {
  left: 100%;
}

.primary-btn {
  background: linear-gradient(135deg, #3498db 0%, #2980b9 100%);
  color: white;
  box-shadow: 0 2px 6px rgba(52, 152, 219, 0.25);
}

.primary-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 3px 8px rgba(52, 152, 219, 0.35);
}

.primary-btn:active {
  transform: translateY(0);
}

.cancel-btn {
  background: #ffffff;
  color: #6b7280;
  border: 1px solid #d1d5db;
}

.cancel-btn:hover {
  background: #f9fafb;
  border-color: #9ca3af;
  color: #374151;
}

.danger-btn {
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
  color: white;
  box-shadow: 0 2px 6px rgba(239, 68, 68, 0.25);
}

.danger-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 3px 8px rgba(239, 68, 68, 0.35);
}

.danger-btn:active {
  transform: translateY(0);
}

/* 创建分支对话框样式 */
.create-branch-content {
  padding: 8px 0;
}

.create-branch-footer {
  display: flex;
  justify-content: flex-end;
  padding: 0;
}

/* 切换目录对话框样式 */
.directory-content {
  padding: 8px 0;
}

.directory-input-group {
  display: flex;
  gap: 8px;
  align-items: stretch;
}

.directory-input-group .modern-input {
  flex: 1;
}

.browse-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 16px;
  border: none;
  border-radius: 6px;
  background: linear-gradient(135deg, #3498db 0%, #2980b9 100%);
  color: white;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
  min-height: 40px;
}

.browse-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 3px 8px rgba(52, 152, 219, 0.35);
}

.browse-btn:active {
  transform: translateY(0);
}

.recent-directories {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 200px;
  overflow-y: auto;
  overflow-x: hidden;
}

.recent-dir-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: #f8fafc;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.recent-dir-item:hover {
  background: #f1f5f9;
  border-color: #cbd5e1;
  transform: translateX(2px);
}

.dir-icon {
  font-size: 16px;
  color: #3498db;
  flex-shrink: 0;
}

.dir-path {
  font-size: 13px;
  color: #374151;
  font-family: 'Courier New', monospace;
  word-break: break-all;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.directory-footer {
  display: flex;
  justify-content: flex-end;
  padding: 0;
}

/* 选择框样式 */
:deep(.modern-select .el-select__wrapper) {
  border-radius: 8px;
  border: 1px solid #e5e7eb;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  transition: all 0.2s ease;
  padding: 10px 12px;
  background: #ffffff;
}

:deep(.modern-select .el-select__wrapper:hover) {
  border-color: #d1d5db;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
}

:deep(.modern-select.is-focus .el-select__wrapper) {
  border-color: #3498db;
  box-shadow: 0 0 0 2px rgba(52, 152, 219, 0.1), 0 2px 6px rgba(0, 0, 0, 0.08);
}

/* 加载动画 */
.is-loading {
  animation: rotating 2s linear infinite;
}

@keyframes rotating {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.directory-icon {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 24px;
  height: 24px;
  border-radius: 3px;
  background-color: rgba(64, 158, 255, 0.1);
  color: #409EFF;
  margin-right: 2px;
}

.directory-input-group {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.recent-directories {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.recent-dir-tag {
  cursor: pointer;
  background-color: #e6f7ff;
  border: 1px solid #91d5ff;
  padding: 4px 8px;
  border-radius: 4px;
}

.directory-browser {
  width: 100%;
  height: 400px;
  overflow: auto;
}

.current-path {
  padding: 10px;
  background-color: #f5f7fa;
  border-radius: 4px;
  margin-bottom: 10px;
  border: 1px solid #e4e7ed;
  display: flex;
  align-items: center;
  width: 100%;
  box-sizing: border-box;
}

.path-label {
  font-weight: bold;
  margin-right: 5px;
  white-space: nowrap;
  flex-shrink: 0;
}

.path-value {
  font-family: monospace;
  word-break: break-all;
  flex: 1;
  min-width: 0;
  background-color: #fff;
  padding: 5px 8px;
  border-radius: 3px;
  border: 1px solid #dcdfe6;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.05);
  width: 100%;
}

.directory-list {
  list-style: none !important;
  padding: 0;
  margin: 0;
  border: 1px solid #e4e7ed;
  border-radius: 4px;
  max-height: 300px;
  overflow-y: auto;
  background-color: white;
  display: flex;
  flex-direction: column;
  width: 100%;
  box-sizing: border-box;
}

.directory-item {
  padding: 10px 12px;
  border-bottom: 1px solid #ebeef5;
  cursor: pointer;
  display: flex;
  align-items: center;
  transition: all 0.2s ease;
  position: relative;
  width: 100%;
  box-sizing: border-box;
  list-style: none !important; /* 确保列表项没有项目符号 */
}

.directory-item:hover {
  background-color: #ecf5ff;
}

.directory-item:last-child {
  border-bottom: none;
}

.parent-dir {
  background-color: #f5f7fa;
  font-weight: 500;
}

.dir-icon {
  margin-right: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
}

.dir-name {
  display: flex;
  align-items: center;
  font-size: 14px;
  line-height: 1.4;
}

.folder-icon {
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.1));
  transition: all 0.2s ease;
}

.directory-item:hover .folder-icon {
  transform: scale(1.1);
}

/* 目录浏览器对话框样式 */
:deep(.directory-browser-dialog) {
  border-radius: 8px;
  overflow: hidden;
}

:deep(.directory-browser-dialog .el-message-box__header) {
  background-color: #f5f7fa;
  padding: 15px 20px;
  border-bottom: 1px solid #e4e7ed;
  position: relative;
}

:deep(.directory-browser-dialog .el-message-box__title) {
  color: #409EFF;
  font-weight: 500;
  font-size: 18px;
}

:deep(.directory-browser-dialog .el-message-box__headerbtn) {
  position: absolute;
  top: 15px;
  right: 15px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background-color: rgba(0, 0, 0, 0.05);
  transition: all 0.3s;
  display: flex;
  align-items: center;
  justify-content: center;
}

:deep(.directory-browser-dialog .el-message-box__headerbtn:hover) {
  background-color: rgba(0, 0, 0, 0.1);
  transform: rotate(90deg);
}

:deep(.directory-browser-dialog .el-message-box__headerbtn .el-message-box__close) {
  color: #606266;
  font-weight: bold;
  font-size: 16px;
}

:deep(.directory-browser-dialog .el-message-box__headerbtn:hover .el-message-box__close) {
  color: #409EFF;
}

:deep(.directory-browser-dialog .el-message-box__content) {
  padding: 20px;
}
</style>

<!-- 添加全局样式，确保能影响body下的弹窗 -->
<style>
.el-message-box__message{
  width: 100%;
}
/* 目录浏览器全局样式 */
.directory-browser-dialog {
  border-radius: 8px;
  overflow: hidden;
}

.directory-browser-dialog .el-message-box__header {
  background-color: #f5f7fa;
  padding: 15px 20px;
  border-bottom: 1px solid #e4e7ed;
  position: relative;
}

.directory-browser-dialog .el-message-box__title {
  color: #409EFF;
  font-weight: 500;
  font-size: 18px;
}

.directory-browser-dialog .el-message-box__headerbtn {
  position: absolute;
  top: 15px;
  right: 15px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background-color: rgba(0, 0, 0, 0.05);
  transition: all 0.3s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.directory-browser-dialog .el-message-box__headerbtn:hover {
  background-color: rgba(0, 0, 0, 0.1);
  transform: rotate(90deg);
}

.directory-browser-dialog .el-message-box__headerbtn .el-message-box__close {
  color: #606266;
  font-weight: bold;
  font-size: 16px;
}

.directory-browser-dialog .el-message-box__headerbtn:hover .el-message-box__close {
  color: #409EFF;
}

.directory-browser-dialog .el-message-box__content {
  padding: 20px;
}

.directory-browser-dialog .el-message-box__btns {
  padding: 10px 20px 15px;
  border-top: 1px solid #e4e7ed;
}

.directory-browser {
  width: 100%;
  height: 400px;
  overflow: auto;
}

.current-path {
  padding: 10px;
  background-color: #f5f7fa;
  border-radius: 4px;
  margin-bottom: 10px;
  border: 1px solid #e4e7ed;
  display: flex;
  align-items: center;
  width: 100%;
  box-sizing: border-box;
}

.path-label {
  font-weight: bold;
  margin-right: 5px;
  white-space: nowrap;
  flex-shrink: 0;
}

.path-value {
  font-family: monospace;
  word-break: break-all;
  flex: 1;
  min-width: 0;
  background-color: #fff;
  padding: 5px 8px;
  border-radius: 3px;
  border: 1px solid #dcdfe6;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.05);
  width: 100%;
}

.directory-list {
  list-style: none !important;
  padding: 0;
  margin: 0;
  border: 1px solid #e4e7ed;
  border-radius: 4px;
  max-height: 300px;
  overflow-y: auto;
  background-color: white;
  display: flex;
  flex-direction: column;
  width: 100%;
  box-sizing: border-box;
}

.directory-item {
  padding: 10px 12px;
  border-bottom: 1px solid #ebeef5;
  cursor: pointer;
  display: flex;
  align-items: center;
  transition: all 0.2s ease;
  position: relative;
  width: 100%;
  box-sizing: border-box;
  list-style: none !important; /* 确保列表项没有项目符号 */
}

.directory-item:hover {
  background-color: #ecf5ff;
}

.directory-item:last-child {
  border-bottom: none;
}

.parent-dir {
  background-color: #f5f7fa;
  font-weight: 500;
}

.dir-icon {
  margin-right: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
}

.dir-name {
  display: flex;
  align-items: center;
  font-size: 14px;
  line-height: 1.4;
}

.folder-icon {
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.1));
  transition: all 0.2s ease;
}

.directory-item:hover .folder-icon {
  transform: scale(1.1);
}
</style>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import GitStatus from '@views/components/GitStatus.vue'
import CommitForm from '@views/components/CommitForm.vue'
import LogList from '@views/components/LogList.vue'
import CommandHistory from '@views/components/CommandHistory.vue'
import CommonDialog from '@components/CommonDialog.vue'
import InlineCard from '@components/InlineCard.vue'
import UserSettingsDialog from '@/components/GitGlobalSettingsDialog.vue'
// import LanguageSwitcher from '@components/LanguageSwitcher.vue'
import I18nTest from '@components/I18nTest.vue'
import { ElMessage, ElConfigProvider } from 'element-plus'
import { Edit, Menu, Plus, Setting, Check, DocumentCopy, Sunny, Moon } from '@element-plus/icons-vue'
import logo from '@assets/logo.svg'
import { useGitStore } from '@stores/gitStore'
import { useConfigStore } from '@stores/configStore'
import { useLocaleStore } from '@stores/localeStore'

const configInfo = ref('')
// 添加组件实例类型
const logListRef = ref<InstanceType<typeof LogList> | null>(null)
const gitStatusRef = ref<InstanceType<typeof GitStatus> | null>(null)
const commitFormRef = ref<InstanceType<typeof CommitForm> | null>(null)

// 使用Git Store
const gitStore = useGitStore()
// 使用Config Store
const configStore = useConfigStore()
// 使用Locale Store
const localeStore = useLocaleStore()

// 添加初始化完成状态
const initCompleted = ref(false)
// 从 configStore 代理当前目录
const currentDirectory = computed(() => configStore.currentDirectory)

// 主题切换功能
const isDarkTheme = ref(false)

// 国际化测试开关（开发时使用，完成测试后可删除）
const showI18nTest = ref(false)

// 切换主题
function toggleTheme() {
  isDarkTheme.value = !isDarkTheme.value
  const html = document.documentElement
  if (isDarkTheme.value) {
    html.setAttribute('data-theme', 'dark')
    localStorage.setItem('theme', 'dark')
  } else {
    html.removeAttribute('data-theme')
    localStorage.setItem('theme', 'light')
  }
}

// 初始化主题
function initTheme() {
  const savedTheme = localStorage.getItem('theme')
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  
  if (savedTheme === 'dark' || (!savedTheme && prefersDark)) {
    isDarkTheme.value = true
    document.documentElement.setAttribute('data-theme', 'dark')
  }
}

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
    configStore.setCurrentDirectory(dirData.directory || '未知目录')
    return dirData
  } catch (error) {
    console.error('获取当前目录失败:', error)
    return { directory: '未知目录', isGitRepo: false }
  }
}

onMounted(async () => {
  console.log('---------- 页面初始化开始 ----------')

  // 初始化主题
  initTheme()

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

    // 刷新提交历史（直接调用store方法）
    gitStore.refreshLog()
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

    // 刷新提交历史（直接调用store方法）
    gitStore.refreshLog()
  }
}

// 用户设置对话框
const userSettingsDialogVisible = ref(false)

function openUserSettingsDialog() {
  userSettingsDialogVisible.value = true
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

// 目录切换逻辑已移到 DirectorySelector 组件内部
</script>

<template>
  <el-config-provider :locale="localeStore.elementPlusLocale">
  <header class="main-header app-header">
    <div class="header-left">
      <img :src="logo" alt="Zen GitSync Logo" class="logo" />
      <h1>Zen GitSync</h1>
    </div>
    <div class="header-info">
      <!-- 顶部右侧动作 -->
      <div class="header-actions" v-if="gitStore.isGitRepo">
        <!-- 命令历史按钮 -->
        <div class="command-history-section" v-if="gitStore.isGitRepo">
          <CommandHistory />
        </div>
        <el-tooltip content="编辑项目配置" placement="bottom" effect="dark" :show-after="200">
          <button class="modern-btn btn-icon-36 btn-scale-on-hover" @click="commitFormRef?.openConfigEditor()">
            <el-icon class="btn-icon"><Edit /></el-icon>
          </button>
        </el-tooltip>
        <el-tooltip :content="isDarkTheme ? '切换到浅色主题' : '切换到深色主题'" placement="bottom" effect="dark" :show-after="200">
          <button class="modern-btn btn-icon-36" @click="toggleTheme">
            <el-icon class="btn-icon">
              <Sunny v-if="isDarkTheme" />
              <Moon v-else />
            </el-icon>
          </button>
        </el-tooltip>
        <!-- 语言切换 -->
        <!-- <LanguageSwitcher /> -->
        <!-- 测试按钮（开发时使用） -->
        <!-- <el-tooltip content="国际化测试" placement="bottom" effect="dark" :show-after="200">
          <button class="modern-btn btn-icon-36" @click="showI18nTest = !showI18nTest">
            <el-icon class="btn-icon">🌐</el-icon>
          </button>
        </el-tooltip> -->
        <el-tooltip content="Git 操作" placement="bottom" effect="dark" :show-after="200">
          <button class="modern-btn btn-icon-36 btn-rotate-on-hover" @click="commitFormRef?.toggleGitOperationsDrawer()">
            <el-icon class="btn-icon"><Menu /></el-icon>
          </button>
        </el-tooltip>
      </div>
      <!-- 用户信息卡片 -->
      <InlineCard id="user-info" class="user-info-card" compact>
        <template #content>
          <template v-if="gitStore.userName && gitStore.userEmail">
            <el-tooltip :content="gitStore.userEmail" placement="bottom" effect="dark" :show-after="200">
              <span class="user-name">{{ gitStore.userName }}</span>
            </el-tooltip>
          </template>
          <template v-else>
            <span class="user-label">用户: </span>
            <span class="user-warning">未配置</span>
          </template>
        </template>
        <template #actions>
          <el-tooltip content="用户设置" placement="bottom" effect="dark" :show-after="200">
            <button class="modern-btn btn-icon-28" @click="openUserSettingsDialog">
              <el-icon class="btn-icon"><Setting /></el-icon>
            </button>
          </el-tooltip>
        </template>
      </InlineCard>
    </div>
  </header>

  <main class="main-container">
    <!-- 国际化测试组件（临时，测试完成后可删除） -->
    <div v-if="showI18nTest" class="i18n-test-wrapper">
      <I18nTest />
      <el-button 
        type="danger" 
        @click="showI18nTest = false"
        style="position: fixed; top: 80px; right: 20px; z-index: 1000;"
      >
        关闭测试
      </el-button>
    </div>

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
        <el-card v-if="!gitStore.userName || !gitStore.userEmail" shadow="hover">
          <template #header>
            <h2>Git用户未配置</h2>
          </template>
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
        </el-card>
        <!-- 用户已配置显示提交表单 -->
        <template v-else>
          <CommitForm ref="commitFormRef" />
        </template>
      </div>
      <div class="commit-form-panel" v-else>
        <el-card shadow="hover">
          <template #header>
            <h2>Git仓库初始化</h2>
          </template>
          <p>当前目录不是Git仓库，请先初始化Git仓库或切换到Git仓库目录。</p>
          <!-- 实用提示 -->
          <div class="tips">
            <h3>可以使用以下命令初始化仓库：</h3>
            <div class="code-block">git init</div>
          </div>
        </el-card>
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
                @keyup.enter="createNewBranch"
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

  <footer class="main-footer app-footer p-4">
    <div class="branch-info" v-if="gitStore.currentBranch">
      <InlineCard class="branch-wrapper" compact>
        <template #content>
          <el-tooltip content="当前分支" placement="top" effect="dark" :show-after="200">
            <span class="branch-label" aria-label="当前分支" title="当前分支">
              <el-icon class="branch-icon">
                <!-- 简洁的分支图标 -->
                <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
                  <path fill="currentColor" d="M256 160a96 96 0 1 1 0 192 96 96 0 0 1 0-192zm0 512a96 96 0 1 1 0 192 96 96 0 0 1 0-192zm512-480a96 96 0 1 1 0 192 96 96 0 0 1 0-192zM352 256h288a128 128 0 0 1 128 128v48a144 144 0 0 1-144 144H368a16 16 0 0 0-16 16v64h-96v-64a112 112 0 0 1 112-112h256a80 80 0 0 0 80-80v-16a64 64 0 0 0-64-64H352v-64z"/>
                </svg>
              </el-icon>
            </span>
          </el-tooltip>
          <el-select v-model="gitStore.currentBranch" @change="handleBranchChange"
            :loading="gitStore.isChangingBranch" class="branch-select">
            <el-option v-for="branch in gitStore.allBranches" :key="branch" :label="branch" :value="branch" />
          </el-select>
        </template>
        <template #actions>
          <button class="modern-btn btn-icon-28" @click="openCreateBranchDialog">
            <el-icon class="btn-icon"><Plus /></el-icon>
          </button>
        </template>
      </InlineCard>
    </div>
    <div v-if="gitStore.remoteUrl">
      <InlineCard class="footer-right" compact>
        <template #content>
          <span class="repo-url-label">远程仓库:</span>
          <span class="repo-url">{{ gitStore.remoteUrl }}</span>
        </template>
        <template #actions>
          <el-tooltip content="复制仓库地址" placement="top" effect="dark" :show-after="200">
            <button class="modern-btn btn-icon-28" @click="gitStore.copyRemoteUrl()">
              <el-icon class="btn-icon"><DocumentCopy /></el-icon>
            </button>
          </el-tooltip>
        </template>
      </InlineCard>
    </div>
  </footer>

  <!-- 用户设置对话框 -->
  <UserSettingsDialog v-model="userSettingsDialogVisible" />
  </el-config-provider>
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
  padding: 4px 0;
  overflow: hidden;
  z-index: 1001;
  /* 防止整体滚动 */
}

.grid-layout {
  display: grid;
  grid-template-columns: 2fr 8px 3fr; /* 左列 Git 状态 | 垂直分隔 | 右列 */
  grid-template-rows: 1fr 8px 1fr;     /* 右列上下分区 | 水平分隔 | 右列上下分区 */
  /* 左侧 Git 状态占满两行，右侧上方提交表单，下方提交历史，水平分隔条仅在右侧 */
  grid-template-areas:
    "git-status v-resizer commit-form"
    "git-status v-resizer h-resizer"
    "git-status v-resizer log-list";
  gap: 6px; /* 面板间距 */
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

.main-header {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 1000;
  height: 64px;
  box-sizing: border-box;
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
  padding: 8px;
  border-radius: 8px;
  border: 1px solid var(--border-component);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
  flex-shrink: 0;
  transition: all 0.2s ease;
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

/* .modern-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: var(--bg-title);
  color: var(--color-text);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  border: 1px solid var(--border-component);
  position: relative;
  overflow: hidden;
} */



/* 目录选择器样式由 components/DirectorySelector.vue scoped 管理 */

.branch-label,
.user-label {
  font-weight: bold;
}

.user-name {
  font-weight: bold;
  cursor: help;
  transition: color 0.2s ease;
}

.user-name:hover {
  color: #409EFF;
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
  background-color: var(--bg-panel);
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

.user-warning {
  color: #E6A23C;
  font-weight: bold;
}

.main-footer {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 100;
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

.branch-label {
  color: var(--color-text);
  padding-top: 6px;
  margin-right: 4px;
}

  .branch-select {
    width: 200px;
  }
  .repo-url-label {
    font-weight: bold;
    margin-right: 4px;
    color: var(--color-text);
  }

.repo-url {
  color: #6c757d;
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
  background-color: #a0a0a0;
  height: 40px; /* 从50px减少到40px */
  border-radius: 2px; /* 从4px减少到2px */
  transition: background-color 0.2s, width 0.2s, box-shadow 0.2s;
}

.vertical-resizer:hover,
.vertical-resizer.active {
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



.directory-display {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  /* 防止flex子项溢出 */
}

:deep(.form-item .el-form-item__label) {
  padding: 0 0 8px 0;
  font-weight: 500;
  color: var(--color-text-title);
}

.form-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text-title);
}

.label-icon {
  font-size: 16px;
  color: #6b7280;
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


/* 选择框样式 */
:deep(.modern-select .el-select__wrapper) {
  border-radius: 8px;
  border: 1px solid var(--border-input);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  transition: all 0.2s ease;
  padding: 10px 12px;
  background: var(--bg-container);
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

/* 国际化测试组件样式 */
.i18n-test-wrapper {
  position: fixed;
  top: 64px;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--bg-page);
  z-index: 999;
  overflow-y: auto;
}

</style>



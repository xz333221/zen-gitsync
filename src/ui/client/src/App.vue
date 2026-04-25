<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref, onMounted, computed, watch } from 'vue'
import { getFolderNameFromPath } from '@/utils/path'
import GitStatus from '@views/components/GitStatus.vue'
import CommitForm from '@views/components/CommitForm.vue'
import LogList from '@views/components/LogList.vue'
import CommandConsole from '@components/CommandConsole.vue'
import CommandHistory from '@views/components/CommandHistory.vue'
import InlineCard from '@components/InlineCard.vue'
import RemoteRepoCard from '@components/RemoteRepoCard.vue'
import BranchSelector from '@components/BranchSelector.vue'
import DirectorySelector from '@components/DirectorySelector.vue'
import UserSettingsDialog from '@/components/GitGlobalSettingsDialog.vue'

import { ElMessage, ElConfigProvider, ElButton, ElTooltip, ElIcon } from 'element-plus'
import { Setting, WarningFilled } from '@element-plus/icons-vue'
import logo from '@assets/logo.svg'
import { useGitStore } from '@stores/gitStore'
import { useConfigStore } from '@stores/configStore'
import { useLocaleStore } from '@stores/localeStore'

const configInfo = ref('')
// 添加组件实例类型
const gitStatusRef = ref<InstanceType<typeof GitStatus> | null>(null)

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

// 更新浏览器标签标题
function updateDocumentTitle() {
  const folderName = getFolderNameFromPath(currentDirectory.value)
  document.title = `${folderName} - Zen GitSync`
}

// 监听目录变化，更新标签标题
watch(currentDirectory, () => {
  updateDocumentTitle()
}, { immediate: true })

// 更新配置信息显示
function updateConfigInfo() {
  if (configStore.config) {
    configInfo.value = `${$t('@F13B4:默认提交信息: ')}${configStore.config.defaultCommitMessage}`
  }
}

// 加载当前目录信息
async function loadCurrentDirectory() {
  try {
    const responseDir = await fetch('/api/current_directory')
    const dirData = await responseDir.json()
    configStore.setCurrentDirectory(dirData.directory || $t('@F13B4:未知目录'))
    return dirData
  } catch (error) {
    console.error('获取当前目录失败:', error)
    return { directory: $t('@F13B4:未知目录'), isGitRepo: false }
  }
}

onMounted(async () => {
  console.log($t('@F13B4:---------- 页面初始化开始 ----------'))

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
      ElMessage.warning($t('@F13B4:当前目录不是Git仓库，部分功能将不可用'))
    }
  } catch (error) {
    console.error('初始化失败:', error)
  } finally {
    // 标记初始化完成
    initCompleted.value = true
    console.log($t('@F13B4:---------- 页面初始化完成 ----------'))

    // 无论是否是Git仓库，都应该加载布局比例
    // 使用短延时确保DOM已完全渲染
    setTimeout(() => {
      loadLayoutRatios();
    }, 100);
  }
})

// 处理分支变更事件
function handleBranchChanged() {
  // 刷新Git状态
  if (gitStatusRef.value) {
    gitStatusRef.value.refreshStatus()
  }
}

function handleToggleNpmPanel() {
  gitStatusRef.value?.toggleNpmPanel?.()
}

// 用户设置对话框
const userSettingsDialogVisible = ref(false)

function openUserSettingsDialog() {
  userSettingsDialogVisible.value = true
}

// 添加分隔条相关逻辑
let isVResizing = false;       // 第一条竖分隔条（GitStatus | 中间列）
let isV2Resizing = false;      // 第二条竖分隔条（中间列 | LogList）
let isHResizing = false;
let initialX = 0;
let initialY = 0;
let initialGridTemplateColumns = '';
let initialGridTemplateRows = '';

// 保存布局比例到localStorage
function saveLayoutRatios() {
  const gridLayout = document.querySelector('.grid-layout') as HTMLElement;
  if (!gridLayout) return;

  const columns = getComputedStyle(gridLayout).gridTemplateColumns.split(' ');
  const rows = getComputedStyle(gridLayout).gridTemplateRows.split(' ');

  if (columns.length >= 5 && rows.length >= 3) {
    // 解析三列区域比例
    const leftColWidth = parseFloat(columns[0]);
    const midColWidth = parseFloat(columns[2]);
    const rightColWidth = parseFloat(columns[4]);
    const totalWidth = leftColWidth + midColWidth + rightColWidth;

    const leftRatio = leftColWidth / totalWidth;
    const midRatio = midColWidth / totalWidth;
    const rightRatio = rightColWidth / totalWidth;

    // 解析上下区域比例
    const topRowHeight = parseFloat(rows[0]);
    const bottomRowHeight = parseFloat(rows[2]);
    const totalHeight = topRowHeight + bottomRowHeight;
    const topRatio = topRowHeight / totalHeight;

    // 保存到localStorage
    localStorage.setItem('zen-gitsync-layout-left-ratio', leftRatio.toString());
    localStorage.setItem('zen-gitsync-layout-mid-ratio', midRatio.toString());
    localStorage.setItem('zen-gitsync-layout-right-ratio', rightRatio.toString());
    localStorage.setItem('zen-gitsync-layout-top-ratio', topRatio.toString());

    console.log(`${$t('@F13B4:布局比例已保存 - 左侧: ')}${(leftRatio * 100).toFixed(0)}${$t('@F13B4:%, 中间: ')}${(midRatio * 100).toFixed(0)}${$t('@F13B4:%, 右侧: ')}${(rightRatio * 100).toFixed(0)}${$t('@F13B4:%, 上方: ')}${(topRatio * 100).toFixed(0)}%`);
  }
}

// 加载布局比例
function loadLayoutRatios() {
  const gridLayout = document.querySelector('.grid-layout') as HTMLElement;
  if (!gridLayout) return;

  const savedLeftRatio = localStorage.getItem('zen-gitsync-layout-left-ratio');
  const savedMidRatio = localStorage.getItem('zen-gitsync-layout-mid-ratio');
  const savedRightRatio = localStorage.getItem('zen-gitsync-layout-right-ratio');
  const savedTopRatio = localStorage.getItem('zen-gitsync-layout-top-ratio');

  // 应用三列区域比例
  if (savedLeftRatio && savedMidRatio && savedRightRatio) {
    const leftRatio = parseFloat(savedLeftRatio);
    const midRatio = parseFloat(savedMidRatio);
    const rightRatio = parseFloat(savedRightRatio);
    gridLayout.style.gridTemplateColumns = `${leftRatio}fr 8px ${midRatio}fr 8px ${rightRatio}fr`;
  } else {
    // 默认比例 2:3:3
    gridLayout.style.gridTemplateColumns = "2fr 8px 3fr 8px 3fr";
  }

  // 应用上下区域比例
  if (savedTopRatio) {
    const topRatio = parseFloat(savedTopRatio);
    const bottomRatio = 1 - topRatio;
    gridLayout.style.gridTemplateRows = `${topRatio}fr 8px ${bottomRatio}fr`;
  }
}

// 第一条竖分隔条拖拽（调整 GitStatus 与 中间列+右侧列 的比例）
function startVResize(event: MouseEvent) {
  isVResizing = true;
  initialX = event.clientX;

  const gridLayout = document.querySelector('.grid-layout') as HTMLElement;
  initialGridTemplateColumns = getComputedStyle(gridLayout).gridTemplateColumns;

  document.getElementById('v-resizer')?.classList.add('active');
  document.addEventListener('mousemove', handleVResize);
  document.addEventListener('mouseup', stopVResize);
  event.preventDefault();
}

function handleVResize(event: MouseEvent) {
  if (!isVResizing) return;

  const gridLayout = document.querySelector('.grid-layout') as HTMLElement;
  const delta = event.clientX - initialX;
  const columns = initialGridTemplateColumns.split(' ');

  if (columns.length >= 5) {
    const leftColWidth = parseFloat(columns[0]);
    const midColWidth = parseFloat(columns[2]);
    const rightColWidth = parseFloat(columns[4]);
    const totalWidth = leftColWidth + midColWidth + rightColWidth;

    const newLeftRatio = (leftColWidth + delta / gridLayout.clientWidth * totalWidth) / totalWidth;
    const restRatio = 1 - newLeftRatio;
    // 按原有中间/右侧比例分配剩余空间
    const midShare = midColWidth / (midColWidth + rightColWidth);
    const rightShare = rightColWidth / (midColWidth + rightColWidth);

    const minLeftRatio = 0.08;
    const maxLeftRatio = 0.4;

    if (newLeftRatio < minLeftRatio) {
      gridLayout.style.gridTemplateColumns = `${minLeftRatio}fr 8px ${(1 - minLeftRatio) * midShare}fr 8px ${(1 - minLeftRatio) * rightShare}fr`;
    } else if (newLeftRatio > maxLeftRatio) {
      gridLayout.style.gridTemplateColumns = `${maxLeftRatio}fr 8px ${(1 - maxLeftRatio) * midShare}fr 8px ${(1 - maxLeftRatio) * rightShare}fr`;
    } else {
      gridLayout.style.gridTemplateColumns = `${newLeftRatio}fr 8px ${restRatio * midShare}fr 8px ${restRatio * rightShare}fr`;
    }
  }
}

// 第二条竖分隔条拖拽（调整 中间列 与 LogList 的比例）
function startV2Resize(event: MouseEvent) {
  isV2Resizing = true;
  initialX = event.clientX;

  const gridLayout = document.querySelector('.grid-layout') as HTMLElement;
  initialGridTemplateColumns = getComputedStyle(gridLayout).gridTemplateColumns;

  document.getElementById('v-resizer-2')?.classList.add('active');
  document.addEventListener('mousemove', handleV2Resize);
  document.addEventListener('mouseup', stopVResize);
  event.preventDefault();
}

function handleV2Resize(event: MouseEvent) {
  if (!isV2Resizing) return;

  const gridLayout = document.querySelector('.grid-layout') as HTMLElement;
  const delta = event.clientX - initialX;
  const columns = initialGridTemplateColumns.split(' ');

  if (columns.length >= 5) {
    const leftColWidth = parseFloat(columns[0]);
    const midColWidth = parseFloat(columns[2]);
    const rightColWidth = parseFloat(columns[4]);
    const totalWidth = leftColWidth + midColWidth + rightColWidth;

    // 右侧列新比例
    const newRightRatio = (rightColWidth - delta / gridLayout.clientWidth * totalWidth) / totalWidth;
    const restRatio = 1 - newRightRatio;
    // 按原有左侧/中间比例分配剩余空间
    const leftShare = leftColWidth / (leftColWidth + midColWidth);
    const midShare = midColWidth / (leftColWidth + midColWidth);

    const minRightRatio = 0.1;
    const maxRightRatio = 0.5;

    if (newRightRatio < minRightRatio) {
      gridLayout.style.gridTemplateColumns = `${(1 - minRightRatio) * leftShare}fr 8px ${(1 - minRightRatio) * midShare}fr 8px ${minRightRatio}fr`;
    } else if (newRightRatio > maxRightRatio) {
      gridLayout.style.gridTemplateColumns = `${(1 - maxRightRatio) * leftShare}fr 8px ${(1 - maxRightRatio) * midShare}fr 8px ${maxRightRatio}fr`;
    } else {
      gridLayout.style.gridTemplateColumns = `${restRatio * leftShare}fr 8px ${restRatio * midShare}fr 8px ${newRightRatio}fr`;
    }
  }
}

function stopVResize() {
  isVResizing = false;
  isV2Resizing = false;

  document.getElementById('v-resizer')?.classList.remove('active');
  document.getElementById('v-resizer-2')?.classList.remove('active');

  document.removeEventListener('mousemove', handleVResize);
  document.removeEventListener('mousemove', handleV2Resize);
  document.removeEventListener('mouseup', stopVResize);

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
  event.preventDefault();
}

function handleHResize(event: MouseEvent) {
  if (!isHResizing) return;

  const gridLayout = document.querySelector('.grid-layout') as HTMLElement;
  const delta = event.clientY - initialY;
  const rows = initialGridTemplateRows.split(' ');

  if (rows.length >= 3) {
    const topRowHeight = parseFloat(rows[0]);
    const bottomRowHeight = parseFloat(rows[2]);
    const totalHeight = topRowHeight + bottomRowHeight;
    const newTopRatio = (topRowHeight + delta / gridLayout.clientHeight * totalHeight) / totalHeight;
    const newBottomRatio = 1 - newTopRatio;

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
  saveLayoutRatios();
}

// 目录切换逻辑已移到 DirectorySelector 组件内部

function copyGitInit() {
  navigator.clipboard.writeText('git init').then(() => {
    ElMessage.success($t('@F13B4:已复制'))
  }).catch(() => {
    ElMessage.error('复制失败')
  })
}
</script>

<template>
  <el-config-provider :locale="localeStore.elementPlusLocale">
  <header class="main-header app-header">
    <div class="header-left">
      <img :src="logo" alt="Zen GitSync Logo" class="logo" />
      <h1>Zen GitSync</h1>
    </div>
    <div class="header-center">
      <DirectorySelector variant="header" @toggle-npm-panel="handleToggleNpmPanel" />
    </div>
    <div class="header-info">
      <!-- 顶部右侧动作 -->
      <div class="header-actions" v-if="gitStore.isGitRepo">
        <CommandHistory />
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
            <span class="user-label">{{ $t('@F13B4:用户: ') }}</span>
            <span class="user-warning">{{ $t('@F13B4:未配置') }}</span>
          </template>
        </template>
        <template #actions>
          <el-tooltip :content="$t('@F13B4:用户设置')" placement="bottom" effect="dark" :show-after="200">
            <button class="modern-btn btn-icon-28" @click="openUserSettingsDialog">
              <el-icon class="btn-icon"><Setting /></el-icon>
            </button>
          </el-tooltip>
        </template>
      </InlineCard>
    </div>
  </header>

  <div v-if="configStore.hasConfigLoadError" class="config-broken-banner">
    <div class="banner-left">
      <el-icon class="banner-icon"><WarningFilled /></el-icon>
      <div class="banner-text">
        <span class="banner-title">{{ $t('@CFGERR:系统配置文件有问题') }}</span>
        <el-tooltip
          v-if="configStore.configLoadError"
          :content="configStore.configLoadError"
          placement="bottom"
          effect="dark"
          :show-after="200"
        >
          <span class="banner-detail">{{ $t('@CFGERR:查看原因') }}</span>
        </el-tooltip>
        <span v-if="configStore.configFilePath" class="banner-path">{{ configStore.configFilePath }}</span>
      </div>
    </div>
    <div class="banner-actions">
      <el-button size="small" type="warning" @click="configStore.openSystemConfigFile()">
        {{ $t('@CFGERR:打开系统配置文件') }}
      </el-button>
    </div>
  </div>

  <main class="main-container" :style="{ top: configStore.hasConfigLoadError ? '104px' : '64px' }">
    <div v-if="!initCompleted" class="loading-container">
      <el-card class="loading-card">
        <div class="loading-spinner">
          <el-icon class="is-loading"><svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
              <path fill="currentColor"
                d="M512 64a32 32 0 0 1 32 32v192a32 32 0 0 1-64 0V96a32 32 0 0 1 32-32zm0 640a32 32 0 0 1 32 32v192a32 32 0 1 1-64 0V736a32 32 0 0 1 32-32zm448-192a32 32 0 0 1-32 32H736a32 32 0 1 1 0-64h192a32 32 0 0 1 32 32zm-640 0a32 32 0 0 1-32 32H96a32 32 0 0 1 0-64h192a32 32 0 0 1 32 32zM195.2 195.2a32 32 0 0 1 45.248 0L376.32 331.008a32 32 0 0 1-45.248 45.248L195.2 240.448a32 32 0 0 1 0-45.248zm452.544 452.544a32 32 0 0 1 45.248 0L828.8 783.552a32 32 0 0 1-45.248 45.248L647.744 692.992a32 32 0 0 1 0-45.248zM828.8 195.264a32 32 0 0 1 0 45.184L692.992 376.32a32 32 0 0 1-45.248-45.248l135.808-135.808a32 32 0 0 1 45.248 0zm-452.544 452.48a32 32 0 0 1 0 45.248L240.448 828.8a32 32 0 0 1-45.248-45.248l135.808-135.808a32 32 0 0 1 45.248 0z">
                </path>
              </svg></el-icon>
        </div>
        <div class="loading-text">{{ $t('@F13B4:加载中...') }}</div>
      </el-card>
    </div>

    <div v-else class="grid-layout">
      <!-- 左侧Git状态 -->
      <div class="git-status-panel">
        <GitStatus ref="gitStatusRef" :initial-directory="currentDirectory" />
      </div>

      <!-- 第一条垂直分隔条（GitStatus | 中间列） -->
      <div class="vertical-resizer" id="v-resizer" @mousedown="startVResize"></div>

      <!-- 中间上方提交表单 -->
      <div class="commit-form-panel" v-if="gitStore.isGitRepo">
        <!-- 当用户未配置时显示配置提示 -->
        <el-card v-if="!gitStore.userName || !gitStore.userEmail" shadow="hover">
          <template #header>
            <h2>Git{{ $t('@F13B4:用户未配置') }}</h2>
          </template>
          <p>{{ $t('@F13B4:请先配置Git用户信息才能进行提交操作。') }}</p>
          <div class="tips">
            <h3>{{ $t('@F13B4:您可以通过以下方式配置：') }}</h3>
            <ol>
              <li>{{ $t('@F13B4:点击右上角的设置按钮，配置用户名和邮箱') }}</li>
              <li>{{ $t('@F13B4:或者使用命令行配置：') }}</li>
              <div class="code-block">
                git config {{ $t('@F13B4:--global user.name "您的用户名"') }}<br>
                git config {{ $t('@F13B4:--global user.email "您的邮箱"') }}
              </div>
            </ol>
            <el-button type="primary" @click="openUserSettingsDialog">
              {{ $t('@F13B4:立即配置') }}
            </el-button>
          </div>
        </el-card>
        <!-- 用户已配置显示提交表单 -->
        <template v-else>
          <CommitForm />
        </template>
      </div>
      <div class="commit-form-panel" v-else>
        <div class="not-git-repo-card">
          <div class="not-git-repo-icon">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 22h14a2 2 0 0 0 2-2V7.5L14.5 2H6a2 2 0 0 0-2 2v4"/>
              <path d="M14 2v6h6"/>
              <path d="M2 15h10"/>
              <path d="M5 12l-3 3 3 3"/>
              <path d="M9 12l3 3-3 3"/>
            </svg>
          </div>
          <h2 class="not-git-repo-title">Git{{ $t('@F13B4:仓库初始化') }}</h2>
          <p class="not-git-repo-desc">{{ $t('@F13B4:当前目录不是Git仓库，请先初始化Git仓库或切换到Git仓库目录。') }}</p>
          <div class="not-git-repo-tip">
            <span class="tip-label">{{ $t('@F13B4:可以使用以下命令初始化仓库：') }}</span>
            <div class="not-git-repo-code" @click="copyGitInit">
              <code>git init</code>
              <span class="copy-hint">{{ $t('@F13B4:点击复制') }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 水平分隔条（提交表单 | 自定义指令） -->
      <div class="horizontal-resizer" id="h-resizer" @mousedown="startHResize"></div>

      <!-- 中间下方自定义指令 -->
      <div class="cmd-console-panel">
        <CommandConsole />
      </div>

      <!-- 第二条垂直分隔条（中间列 | 提交历史） -->
      <div class="vertical-resizer-2" id="v-resizer-2" @mousedown="startV2Resize"></div>

      <!-- 右侧提交历史 -->
      <div class="log-list-panel">
        <LogList />
      </div>

    </div>
  </main>

  <footer class="main-footer app-footer px-4 py-2">
    <BranchSelector @branch-changed="handleBranchChanged" />
    <RemoteRepoCard />
  </footer>

  <!-- 用户设置对话框 -->
  <UserSettingsDialog v-model="userSettingsDialogVisible" />
  </el-config-provider>
</template>

<style>
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, 'Plus Jakarta Sans', sans-serif;
  margin: 0;
  padding: 0;
  background-color: var(--bg-page);
  overflow: hidden;
  height: 100vh;
}

.main-container {
  position: fixed;
  top: 64px;
  bottom: 48px;
  left: 0;
  right: 0;
  padding: 8px;
  overflow: hidden;
  z-index: 1001;
  background: var(--bg-page);
}

.config-broken-banner {
  position: fixed;
  top: 64px;
  left: 0;
  right: 0;
  height: 40px;
  z-index: 1002;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--spacing-lg);
  background: rgba(245, 158, 11, 0.12);
  border-bottom: 1px solid rgba(245, 158, 11, 0.25);
  color: var(--text-primary);
}

[data-theme="dark"] .config-broken-banner {
  background: rgba(245, 158, 11, 0.14);
  border-bottom: 1px solid rgba(245, 158, 11, 0.28);
}

.config-broken-banner .banner-left {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  min-width: 0;
}

.config-broken-banner .banner-icon {
  color: rgba(245, 158, 11, 0.95);
}

.config-broken-banner .banner-text {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  min-width: 0;
}

.config-broken-banner .banner-title {
  font-weight: 600;
  white-space: nowrap;
}

.config-broken-banner .banner-detail {
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
}

.config-broken-banner .banner-path {
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 55vw;
}

.config-broken-banner .banner-actions {
  flex-shrink: 0;
}

.grid-layout {
  display: grid;
  grid-template-columns: 2fr 8px 3fr 8px 3fr;
  grid-template-rows: 1fr 8px 1fr;
  grid-template-areas:
    "git-status v-resizer commit-form v-resizer-2 log-list"
    "git-status v-resizer h-resizer   v-resizer-2 log-list"
    "git-status v-resizer cmd-console  v-resizer-2 log-list";
  gap: 0;
  height: 100%;
}

.git-status-panel {
  grid-area: git-status;
  overflow: hidden;
  max-height: 100%;
  padding: 0;
  background: var(--bg-container);
  border-radius: var(--radius-xl);
  border: 1px solid var(--border-color);
  box-shadow: var(--shadow-sm);
}

.commit-form-panel {
  grid-area: commit-form;
  overflow: hidden;
  max-height: 100%;
  padding: 0;
  background: var(--bg-container);
  border-radius: var(--radius-xl);
  border: 1px solid var(--border-color);
  box-shadow: var(--shadow-sm);
}

.cmd-console-panel {
  grid-area: cmd-console;
  overflow: hidden;
  max-height: 100%;
  padding: 0;
  background: var(--bg-container);
  border-radius: var(--radius-xl);
  border: 1px solid var(--border-color);
  box-shadow: var(--shadow-sm);
}

.log-list-panel {
  grid-area: log-list;
  overflow: hidden;
  max-height: 100%;
  padding: 0;
  background: var(--bg-container);
  border-radius: var(--radius-xl);
  border: 1px solid var(--border-color);
  box-shadow: var(--shadow-sm);
}

.main-header {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 1000;
  height: 64px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--spacing-lg);
  position: fixed;
}

.header-left {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  flex-shrink: 0;
  position: relative;
  z-index: 2;
}

.header-center {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(720px, calc(100% - 520px));
  max-width: calc(100% - 520px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1;
  overflow: visible;
}

.logo {
  height: 32px;
  width: auto;
}

h1 {
  margin: 0;
  font-size: var(--font-size-xl);
  font-weight: 700;
  letter-spacing: -0.6px;
  font-family: 'Plus Jakarta Sans', sans-serif;
  color: #1e3a5f;
}

[data-theme="dark"] h1 {
  color: #93c5fd;
}

.header-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  justify-content: flex-end;
  min-width: 0;
  flex-shrink: 0;
  position: relative;
  z-index: 2;
}

/* 调整用户信息和目录选择的排列 */
#user-info {
  display: flex;
  align-items: center;
  padding: 6px var(--spacing-base);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-component);
  box-shadow: none;
  flex-shrink: 0;
  transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
  background: rgba(0, 0, 0, 0.02);
}

#user-info:hover {
  border-color: var(--color-primary);
  background: rgba(59, 130, 246, 0.04);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.12);
}

.command-history-section {
  display: flex;
  align-items: center;
}

/* 顶部右侧动作区 */
.header-actions-right {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
}

.user-label {
  font-weight: bold;
}

.user-name {
  font-weight: bold;
  cursor: help;
  transition: color 0.2s ease;
}

.user-name:hover {
  color: var(--color-primary);
}

.branch-name {
  font-family: monospace;
}

.status-box {
  background-color: var(--bg-code);
  border: 1px solid #e1e4e8;
  border-radius: var(--radius-sm);
  padding: 15px;
  white-space: pre-wrap;
  font-family: monospace;
  overflow-y: auto;
}

.tips {
  margin-top: var(--spacing-lg);
  padding: var(--spacing-lg);
  background-color: var(--bg-panel);
  border-radius: var(--radius-lg);
  border-left: 3px solid var(--color-primary);
}

.tips h3 {
  margin-top: 0;
  font-size: var(--font-size-md);
  font-weight: 600;
  margin-bottom: var(--spacing-base);
}

.code-block {
  background-color: var(--bg-code-dark);
  color: #f8f8f2;
  font-family: var(--font-mono);
  padding: var(--spacing-base) var(--spacing-lg);
  border-radius: var(--radius-md);
  margin-bottom: var(--spacing-base);
  font-size: var(--font-size-sm);
}

/* 加载中样式 */
.loading-container {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
}

.loading-card {
  width: 280px;
  text-align: center;
  padding: 40px;
  border-radius: var(--radius-xl);
  border: 1px solid var(--border-color);
  box-shadow: var(--shadow-md);
}

.loading-spinner {
  font-size: 40px;
  color: var(--color-primary);
  animation: spin 1.5s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.user-warning {
  color: var(--color-warning);
  font-weight: bold;
}

/* 非Git仓库初始化提示卡片 */
.not-git-repo-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: var(--spacing-xl);
  text-align: center;
  background: var(--bg-container);
  border-radius: var(--radius-xl);
}

.not-git-repo-icon {
  color: var(--color-gray-400);
  margin-bottom: var(--spacing-lg);
  opacity: 0.7;
}

.not-git-repo-title {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 var(--spacing-sm) 0;
}

.not-git-repo-desc {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0 0 var(--spacing-lg) 0;
  max-width: 360px;
  line-height: 1.6;
}

.not-git-repo-tip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-sm);
}

.not-git-repo-tip .tip-label {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.not-git-repo-code {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-lg);
  background: var(--bg-code);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.2s ease;
  user-select: all;
}

.not-git-repo-code:hover {
  border-color: var(--color-primary);
  background: var(--bg-hover);
}

.not-git-repo-code code {
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  background: transparent;
  padding: 0;
}

.not-git-repo-code .copy-hint {
  font-size: 11px;
  color: var(--text-muted);
  opacity: 0;
  transition: opacity 0.2s ease;
}

.not-git-repo-code:hover .copy-hint {
  opacity: 1;
}

.main-footer {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 100;
  height: 48px;
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

/* 垂直分隔条样式 */
.vertical-resizer {
  grid-area: v-resizer;
  background-color: transparent;
  cursor: col-resize;
  transition: background-color 0.2s;
  position: relative;
  z-index: 10;
  border-radius: var(--radius-base);
}

.vertical-resizer::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 3px;
  background-color: var(--color-gray-300);
  height: 32px;
  border-radius: 2px;
  transition: background-color 0.2s, width 0.2s, height 0.2s, box-shadow 0.2s;
}

.vertical-resizer:hover,
.vertical-resizer.active {
  background-color: rgba(59, 130, 246, 0.06);
}

.vertical-resizer:hover::after,
.vertical-resizer.active::after {
  background-color: var(--color-primary);
  width: 4px;
  height: 48px;
  border-radius: 2px;
  box-shadow: 0 0 10px rgba(59, 130, 246, 0.45);
}

/* 第二条垂直分隔条样式 */
.vertical-resizer-2 {
  grid-area: v-resizer-2;
  background-color: transparent;
  cursor: col-resize;
  transition: background-color 0.2s;
  position: relative;
  z-index: 10;
  border-radius: var(--radius-base);
}

.vertical-resizer-2::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 3px;
  background-color: var(--color-gray-300);
  height: 32px;
  border-radius: 2px;
  transition: background-color 0.2s, width 0.2s, height 0.2s, box-shadow 0.2s;
}

.vertical-resizer-2:hover,
.vertical-resizer-2.active {
  background-color: rgba(59, 130, 246, 0.06);
}

.vertical-resizer-2:hover::after,
.vertical-resizer-2.active::after {
  background-color: var(--color-primary);
  width: 4px;
  height: 48px;
  border-radius: 2px;
  box-shadow: 0 0 10px rgba(59, 130, 246, 0.45);
}

/* 水平分隔条样式 */
.horizontal-resizer {
  grid-area: h-resizer;
  background-color: transparent;
  cursor: row-resize;
  transition: background-color 0.2s;
  position: relative;
  z-index: 10;
  border-radius: var(--radius-base);
}

.horizontal-resizer::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 32px;
  height: 3px;
  background-color: var(--color-gray-300);
  border-radius: 2px;
  transition: background-color 0.2s, height 0.2s, width 0.2s, box-shadow 0.2s;
}

.horizontal-resizer:hover,
.horizontal-resizer.active {
  background-color: rgba(59, 130, 246, 0.06);
}

.horizontal-resizer:hover::after,
.horizontal-resizer.active::after {
  background-color: var(--color-primary);
  height: 4px;
  width: 48px;
  border-radius: 2px;
  box-shadow: 0 0 10px rgba(59, 130, 246, 0.45);
}



.directory-display {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  flex: 1;
  min-width: 0;
  /* 防止flex子项溢出 */
}

:deep(.form-item .el-form-item__label) {
  padding: 0 0 var(--spacing-base) 0;
  font-weight: 500;
  color: var(--color-text-title);
}

.form-label {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  
  font-weight: 500;
  color: var(--color-text-title);
}

.label-icon {
  font-size: var(--font-size-md);
  color: var(--color-gray-500);
}

.user-settings-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0;
}

/* footer-actions、footer-btn、primary-btn、cancel-btn、danger-btn 样式已移至 @/styles/common.scss */

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



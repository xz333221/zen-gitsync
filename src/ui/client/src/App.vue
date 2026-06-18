<!--
  ~ Copyright 2026 xz333221
  ~
  ~ Licensed under the Apache License, Version 2.0 (the "License");
  ~ you may not use this file except in compliance with the License.
  ~ You may obtain a copy of the License at
  ~
  ~     http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing, software
  ~ distributed under the License is distributed on an "AS IS" BASIS,
  ~ WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  ~ See the License for the specific language governing permissions and
  ~ limitations under the License.
  -->
<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref, onMounted, onBeforeUnmount, computed, watch, defineAsyncComponent } from 'vue'
import { getFolderNameFromPath } from '@/utils/path'
import GitStatus from '@views/components/GitStatus.vue'
import CommitForm from '@views/components/CommitForm.vue'
import LogList from '@views/components/LogList.vue'
import CommandConsole from '@components/CommandConsole.vue'
import RemoteRepoCard from '@components/RemoteRepoCard.vue'
import AppVersionBadge from '@components/AppVersionBadge.vue'
import BranchSelector from '@components/BranchSelector.vue'
import DirectorySelector from '@components/DirectorySelector.vue'
import UserSettingsDialog from '@/components/GitGlobalSettingsDialog.vue'
import ActivityBar from '@/components/ActivityBar.vue'
import InstanceSwitcher from '@/components/InstanceSwitcher.vue'
// 编辑器 / 源码地图视图延迟加载（首屏不下载）
const EditorView = defineAsyncComponent(() => import('@/views/EditorView.vue'))
const SourceMapView = defineAsyncComponent(() => import('@/views/SourceMapView.vue'))
const WorkbenchView = defineAsyncComponent(() => import('@/views/WorkbenchView.vue'))
import { ElMessage, ElConfigProvider, ElButton, ElTooltip, ElIcon } from 'element-plus'
import { Setting, WarningFilled } from '@element-plus/icons-vue'
import logo from '@assets/logo.svg'
import { useGitStore } from '@stores/gitStore'
import { useConfigStore } from '@stores/configStore'
import { useLocaleStore } from '@stores/localeStore'
import { useInstancesStore } from '@stores/instancesStore'

const configInfo = ref('')
// 添加组件实例类型
const gitStatusRef = ref<InstanceType<typeof GitStatus> | null>(null)

// 使用Git Store
const gitStore = useGitStore()
// 使用Config Store
const configStore = useConfigStore()
// 使用Locale Store
const localeStore = useLocaleStore()
// 使用实例注册 Store
const instancesStore = useInstancesStore()

// 添加初始化完成状态
const initCompleted = ref(false)
// 从 configStore 代理当前目录
const currentDirectory = computed(() => configStore.currentDirectory)

const defaultModelName = computed(() => {
  const m = configStore.models.find((m: any) => m.isDefault)
  if (!m) return ''
  return m.name || m.model
})

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

  // 启动实例注册表轮询 + Socket.IO 监听
  instancesStore.start()

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

onBeforeUnmount(() => {
  // 停止实例注册表轮询 + 断开 Socket.IO
  instancesStore.stop()
})

// 监听设置菜单的"重置布局"事件：把新比例立刻应用到 DOM
// 事件由 GitGlobalSettingsDialog.vue 的 onResetUiLayout 派发
function handleUiLayoutReset() {
  // configStore.ui.layout 已经被 resetUiLayout 改回默认值
  // 直接重读即可（loadLayoutRatios 内部已读 configStore.ui.layout）
  loadLayoutRatios()
}
window.addEventListener('ui-layout-reset', handleUiLayoutReset)
onBeforeUnmount(() => {
  window.removeEventListener('ui-layout-reset', handleUiLayoutReset)
})

// 处理分支变更事件
function handleBranchChanged() {
  // 刷新Git状态
  if (gitStatusRef.value) {
    gitStatusRef.value.refreshStatus()
  }
}

// 活动视图切换
const activeView = ref<'git' | 'editor' | 'source-map' | 'workbench'>('git')

// 切换到 Git 视图时静默刷新状态（与窗口焦点/标签页可见时一致）
watch(activeView, (view) => {
  if (view === 'git' && gitStatusRef.value && gitStore.isGitRepo) {
    Promise.all([
      gitStore.fetchStatus(),
      gitStore.getBranchStatus()
    ]).catch(err => console.error('切换到Git视图刷新失败:', err))
  }
})

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

// 保存布局比例到 configStore（持久化到 ~/.git-commit-tool.json 的 ui.layout 字段）
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

    // 写入 configStore（watch 自动防抖落盘）
    configStore.ui.layout = { leftRatio, midRatio, rightRatio, topRatio };

    console.log(`${$t('@F13B4:布局比例已保存 - 左侧: ')}${(leftRatio * 100).toFixed(0)}${$t('@F13B4:%, 中间: ')}${(midRatio * 100).toFixed(0)}${$t('@F13B4:%, 右侧: ')}${(rightRatio * 100).toFixed(0)}${$t('@F13B4:%, 上方: ')}${(topRatio * 100).toFixed(0)}%`);
  }
}

// 加载布局比例（从 configStore.ui.layout 读取）
function loadLayoutRatios() {
  const gridLayout = document.querySelector('.grid-layout') as HTMLElement;
  if (!gridLayout) return;

  const layout = configStore.ui.layout;
  const savedLeftRatio = Number.isFinite(layout?.leftRatio) ? layout.leftRatio : null;
  const savedMidRatio = Number.isFinite(layout?.midRatio) ? layout.midRatio : null;
  const savedRightRatio = Number.isFinite(layout?.rightRatio) ? layout.rightRatio : null;
  const savedTopRatio = Number.isFinite(layout?.topRatio) ? layout.topRatio : null;

  // 应用三列区域比例
  if (savedLeftRatio != null && savedMidRatio != null && savedRightRatio != null) {
    gridLayout.style.gridTemplateColumns = `${savedLeftRatio}fr 8px ${savedMidRatio}fr 8px ${savedRightRatio}fr`;
  } else {
    // 默认比例 2:3:3
    gridLayout.style.gridTemplateColumns = "2fr 8px 3fr 8px 3fr";
  }

  // 应用上下区域比例
  if (savedTopRatio != null) {
    const bottomRatio = 1 - savedTopRatio;
    gridLayout.style.gridTemplateRows = `${savedTopRatio}fr 8px ${bottomRatio}fr`;
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
      <a href="https://github.com/xz333221/zen-gitsync" target="_blank" class="header-brand-link">
        <img :src="logo" alt="Zen GitSync Logo" class="logo" />
        <h1>Zen GitSync</h1>
      </a>
    </div>
    <div class="header-center">
      <DirectorySelector variant="header" />
    </div>
    <div class="header-info">
      <!-- 顶部右侧动作 -->
      <div class="header-actions" v-if="gitStore.isGitRepo">
        <!-- <CommandHistory /> -->
      </div>
      <!-- 实例切换器：显示所有运行中的 GUI 项目 -->
      <InstanceSwitcher />
      <!-- 用户信息 -->
      <div id="user-info" class="user-info-card">
        <template v-if="gitStore.userName">
          <el-tooltip :content="gitStore.userEmail || gitStore.userName" placement="bottom" effect="dark" :show-after="200">
            <span class="user-name">{{ gitStore.userName }}</span>
          </el-tooltip>
        </template>
        <template v-else>
          <span class="user-label">{{ $t('@F13B4:用户: ') }}</span>
          <span class="user-warning">{{ $t('@F13B4:未配置') }}</span>
        </template>
        <el-tooltip :content="$t('@F13B4:用户设置')" placement="bottom" effect="dark" :show-after="200">
          <button class="modern-btn btn-icon-28" @click="openUserSettingsDialog">
            <el-icon class="btn-icon"><Setting /></el-icon>
          </button>
        </el-tooltip>
      </div>
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
      <div class="loading-card" role="status" aria-live="polite">
        <!-- 三层错位旋转环 spinner -->
        <div class="loading-spinner" aria-hidden="true">
          <svg class="loading-spinner__svg" viewBox="0 0 120 120">
            <defs>
              <linearGradient id="loading-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="var(--color-primary)" />
                <stop offset="100%" stop-color="#0ea5e9" />
              </linearGradient>
            </defs>
            <!-- 外环 -->
            <circle
              class="loading-spinner__ring loading-spinner__ring--outer"
              cx="60" cy="60" r="52"
              fill="none"
              stroke="url(#loading-gradient)"
              stroke-width="3"
              stroke-linecap="round"
              stroke-dasharray="80 250"
            />
            <!-- 中环（反向旋转 + 不同颜色） -->
            <circle
              class="loading-spinner__ring loading-spinner__ring--middle"
              cx="60" cy="60" r="38"
              fill="none"
              stroke="var(--color-primary-light)"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-dasharray="60 200"
              opacity="0.7"
            />
            <!-- 内环（慢速旋转 + 低透明度） -->
            <circle
              class="loading-spinner__ring loading-spinner__ring--inner"
              cx="60" cy="60" r="24"
              fill="none"
              stroke="var(--color-primary)"
              stroke-width="2"
              stroke-linecap="round"
              stroke-dasharray="40 150"
              opacity="0.45"
            />
          </svg>
        </div>

        <!-- 加载文字 + 跳动点 -->
        <div class="loading-text">
          <span class="loading-text__label">{{ $t('@F13B4:加载中') }}</span>
          <span class="loading-dots" aria-hidden="true">
            <span class="loading-dots__dot" />
            <span class="loading-dots__dot" />
            <span class="loading-dots__dot" />
          </span>
        </div>
      </div>
    </div>

    <div v-else class="app-body">
      <!-- VS Code 风格活动栏 -->
      <ActivityBar v-model:activeView="activeView" />

      <!-- Git 视图 -->
      <div v-show="activeView === 'git'" class="view-pane grid-layout">
      <!-- 左侧Git状态 -->
      <div class="git-status-panel">
        <GitStatus ref="gitStatusRef" :initial-directory="currentDirectory" />
      </div>

      <!-- 第一条垂直分隔条（GitStatus | 中间列） -->
      <div class="vertical-resizer" id="v-resizer" @mousedown="startVResize"></div>

      <!-- 中间上方提交表单 -->
      <div class="commit-form-panel" v-if="gitStore.isGitRepo">
        <!-- 当用户未配置时显示配置提示 -->
        <div v-if="!gitStore.userName || !gitStore.userEmail" class="user-unconfigured-card">
          <div class="user-unconfigured-icon">
            <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="8" r="4"/>
              <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
              <path d="M17 13.5l1.5 1.5 3-3" stroke="var(--color-warning)" stroke-width="2"/>
            </svg>
          </div>
          <h2 class="user-unconfigured-title">Git {{ $t('@F13B4:用户未配置') }}</h2>
          <p class="user-unconfigured-desc">{{ $t('@F13B4:请先配置Git用户信息才能进行提交操作。') }}</p>
          <div class="user-unconfigured-actions">
            <button class="user-unconfigured-primary-btn" @click="openUserSettingsDialog">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
              {{ $t('@F13B4:立即配置') }}
            </button>
          </div>
          <div class="user-unconfigured-divider">
            <span>{{ $t('@F13B4:或者使用命令行配置：') }}</span>
          </div>
          <div class="user-unconfigured-code">
            <span class="code-prompt">$</span> git config {{ $t('@F13B4:--global user.name "您的用户名"') }}<br>
            <span class="code-prompt">$</span> git config {{ $t('@F13B4:--global user.email "您的邮箱"') }}
          </div>
        </div>
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

      </div><!-- /view-pane git -->

      <!-- 编辑器视图（延迟加载，KeepAlive 缓存实例） -->
      <KeepAlive>
        <div v-show="activeView === 'editor'" class="view-pane editor-pane">
          <EditorView />
        </div>
      </KeepAlive>

      <!-- 源码地图视图（延迟加载，KeepAlive 缓存实例） -->
      <KeepAlive>
        <div v-show="activeView === 'source-map'" class="view-pane source-map-pane">
          <SourceMapView />
        </div>
      </KeepAlive>

      <!-- 工作台视图（延迟加载，KeepAlive 缓存实例） -->
      <KeepAlive>
        <div v-show="activeView === 'workbench'" class="view-pane workbench-pane">
          <WorkbenchView />
        </div>
      </KeepAlive>

    </div><!-- /app-body -->
  </main>

  <footer class="main-footer app-footer">
    <BranchSelector @branch-changed="handleBranchChanged" />
    <div class="footer-model-hint" v-if="defaultModelName">
      <span class="footer-model-hint__label">{{ $t('@F13B4:默认模型') }}</span>
      <span class="footer-model-hint__name">{{ defaultModelName }}</span>
    </div>
    <RemoteRepoCard />
    <AppVersionBadge />
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
  bottom: 32px;
  left: 0;
  right: 0;
  padding: 0;
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
  border-radius: 0;
  border-right: 1px solid var(--border-color);
}

.commit-form-panel {
  grid-area: commit-form;
  overflow: hidden;
  max-height: 100%;
  padding: 0;
  background: var(--bg-container);
  border-radius: 0;
}

.cmd-console-panel {
  grid-area: cmd-console;
  overflow: hidden;
  max-height: 100%;
  padding: 0;
  background: var(--bg-container);
  border-radius: 0;
  border-top: 1px solid var(--border-color);
}

.log-list-panel {
  grid-area: log-list;
  overflow: hidden;
  max-height: 100%;
  padding: 0;
  background: var(--bg-container);
  border-radius: 0;
  border-left: 1px solid var(--border-color);
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

.header-brand-link {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  text-decoration: none;
  color: inherit;
  cursor: pointer;
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
  background: var(--bg-subtle);
}

#user-info:hover {
  border-color: var(--color-primary);
  background: rgba(59, 130, 246, 0.08);
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
  border: 1px solid var(--border-color-medium);
  border-radius: var(--radius-md);
  padding: 15px;
  white-space: pre-wrap;
  font-family: var(--font-mono);
  overflow-y: auto;
}

/* 用户未配置提示卡片 */
.user-unconfigured-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: var(--spacing-xl);
  text-align: center;
}

.user-unconfigured-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 72px;
  height: 72px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--color-warning) 10%, transparent);
  color: var(--color-warning);
  margin-bottom: var(--spacing-lg);
  border: 1.5px solid color-mix(in srgb, var(--color-warning) 25%, transparent);
}

.user-unconfigured-title {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 var(--spacing-sm) 0;
}

.user-unconfigured-desc {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0 0 var(--spacing-xl) 0;
  line-height: 1.6;
}

.user-unconfigured-actions {
  margin-bottom: var(--spacing-xl);
}

.user-unconfigured-primary-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: 8px 20px;
  background: var(--color-primary);
  color: #fff;
  border: none;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s, transform 0.1s;
}

.user-unconfigured-primary-btn:hover {
  opacity: 0.88;
  transform: translateY(-1px);
}

.user-unconfigured-primary-btn:active {
  opacity: 1;
  transform: translateY(0);
}

.user-unconfigured-divider {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  width: 100%;
  max-width: 360px;
  margin-bottom: var(--spacing-base);
}

.user-unconfigured-divider::before,
.user-unconfigured-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border-color);
}

.user-unconfigured-divider span {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  white-space: nowrap;
}

.user-unconfigured-code {
  background: var(--bg-code-dark);
  color: #e2e8f0;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  line-height: 1.8;
  padding: var(--spacing-base) var(--spacing-lg);
  border-radius: var(--radius-md);
  text-align: left;
  width: 100%;
  max-width: 360px;
  user-select: text;
}

.user-unconfigured-code .code-prompt {
  color: var(--color-success, #52c41a);
  margin-right: 6px;
  user-select: none;
}

/* 加载中样式 */
.loading-container {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
}

.loading-card {
  position: relative;
  width: 260px;
  text-align: center;
  padding: 36px 32px 32px;
  border-radius: var(--radius-xl);
  background: var(--bg-container);
  border: 1px solid var(--border-color);
  box-shadow: var(--dialog-shadow);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  overflow: hidden;
  isolation: isolate;
}

/* 顶部高光：让卡片有一层环境光，增加层次 */
.loading-card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(
    120% 80% at 50% 0%,
    var(--tint-primary-12) 0%,
    transparent 60%
  );
  pointer-events: none;
  z-index: -1;
}

.loading-spinner {
  width: 84px;
  height: 84px;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

/* 柔和光晕 */
.loading-spinner::after {
  content: '';
  position: absolute;
  inset: 14px;
  border-radius: 50%;
  background: radial-gradient(
    circle,
    var(--tint-primary-18) 0%,
    transparent 70%
  );
  filter: blur(6px);
  z-index: -1;
}

.loading-spinner__svg {
  width: 100%;
  height: 100%;
  transform-origin: 50% 50%;
}

.loading-spinner__ring {
  transform-origin: 50% 50%;
}

.loading-spinner__ring--outer {
  animation: loading-spin-outer 1.4s linear infinite;
}

.loading-spinner__ring--middle {
  animation: loading-spin-middle 2.1s linear infinite reverse;
}

.loading-spinner__ring--inner {
  animation: loading-spin-inner 2.8s linear infinite;
}

@keyframes loading-spin-outer {
  to { transform: rotate(360deg); }
}

@keyframes loading-spin-middle {
  to { transform: rotate(360deg); }
}

@keyframes loading-spin-inner {
  to { transform: rotate(360deg); }
}

.loading-text {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  color: var(--text-secondary);
  letter-spacing: var(--letter-spacing-wide);
  user-select: none;
}

.loading-text__label {
  /* 给文字一点点节奏感 */
  color: var(--text-primary);
}

/* 三个跳动点：交错延迟 */
.loading-dots {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: 2px;
  transform: translateY(-1px);
}

.loading-dots__dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--color-primary);
  display: inline-block;
  animation: loading-dot-bounce 1.2s var(--ease-in-out) infinite;
}

.loading-dots__dot:nth-child(2) {
  animation-delay: 0.15s;
  background: var(--color-primary-light);
}

.loading-dots__dot:nth-child(3) {
  animation-delay: 0.3s;
  background: #0ea5e9;
}

@keyframes loading-dot-bounce {
  0%, 60%, 100% {
    transform: translateY(0) scale(1);
    opacity: 0.55;
  }
  30% {
    transform: translateY(-3px) scale(1.15);
    opacity: 1;
  }
}

/* 减弱 motion */
@media (prefers-reduced-motion: reduce) {
  .loading-spinner__ring--outer,
  .loading-spinner__ring--middle,
  .loading-spinner__ring--inner,
  .loading-dots__dot {
    animation-duration: 3s;
  }
}

/* 深色主题微调 */
[data-theme="dark"] .loading-card {
  background: var(--bg-container-dark);
  border-color: var(--border-color-dark);
  box-shadow:
    0 18px 40px rgba(0, 0, 0, 0.55),
    0 4px 14px rgba(0, 0, 0, 0.4),
    0 0 0 1px rgba(255, 255, 255, 0.04);
}

[data-theme="dark"] .loading-card::before {
  background: radial-gradient(
    120% 80% at 50% 0%,
    var(--tint-primary-18) 0%,
    transparent 60%
  );
}

[data-theme="dark"] .loading-spinner__ring--outer {
  stroke: url(#loading-gradient);
  filter: drop-shadow(0 0 4px var(--tint-primary-45));
}

[data-theme="dark"] .loading-dots__dot {
  filter: drop-shadow(0 0 4px var(--tint-primary-45));
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
  color: var(--text-tertiary);
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
  background: var(--bg-panel);
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
  color: var(--text-tertiary);
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
  height: 32px;
  box-sizing: border-box;
  padding: 0 var(--spacing-lg);
}

.footer-model-hint {
  display: flex;
  align-items: center;
  gap: 5px;
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
}

.footer-model-hint__label {
  font-size: 11px;
  opacity: 0.55;
}

.footer-model-hint__name {
  font-size: 11px;
  font-weight: 500;
  opacity: 0.85;
  max-width: 200px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* app body 包含活动栏 + 内容区 */
.app-body {
  display: flex;
  width: 100%;
  height: 100%;
  gap: 0;
  overflow: hidden;
}

/* 视图面板 - 占满剩余空间 */
.view-pane {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow: hidden;
}

/* 编辑器面板不用 grid */
.editor-pane {
  display: flex;
}

/* 源码地图面板 */
.source-map-pane {
  display: flex;
  overflow: hidden;
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
  cursor: col-resize;
  width: 8px !important;
  position: relative;
  z-index: 10;
  background-color: transparent;
  transition: background-color 0.15s;
}

.vertical-resizer::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 1px;
  background-color: var(--border-color);
  transition: background-color 0.15s, width 0.15s;
  pointer-events: none;
}

.vertical-resizer:hover::after,
.vertical-resizer.active::after {
  width: 2px;
  background-color: var(--color-primary);
}

/* 第二条垂直分隔条样式 */
.vertical-resizer-2 {
  grid-area: v-resizer-2;
  cursor: col-resize;
  width: 8px !important;
  position: relative;
  z-index: 10;
  background-color: transparent;
  transition: background-color 0.15s;
}

.vertical-resizer-2::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 1px;
  background-color: var(--border-color);
  transition: background-color 0.15s, width 0.15s;
  pointer-events: none;
}

.vertical-resizer-2:hover::after,
.vertical-resizer-2.active::after {
  width: 2px;
  background-color: var(--color-primary);
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



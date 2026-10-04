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
import { ref, onMounted, onBeforeUnmount, computed, watch, nextTick, defineAsyncComponent } from 'vue'
import { getFolderNameFromPath } from '@/utils/path'
// GitStatus 是首屏左侧主面板(默认 git 视图立即渲染),改静态 import:
// - 动态 import(defineAsyncComponent)会等到 App.vue 渲染到 <GitStatus> 时才发起 chunk 请求
// - GitStatus 依赖深(FileDiffViewer/FileTreeView/NpmScriptsPanel/多个 buttons),首次 transform 瀑布式,实测 23s+
// - 静态 import 让 vite 在 transform App.vue 时一次性解析整条依赖链,避免瀑布
import GitStatus from '@views/components/GitStatus.vue'
// 其余首屏组件保持异步:它们在非默认视图或次要位置,首次访问时才加载可接受
const CommitForm = defineAsyncComponent(() => import('@views/components/CommitForm.vue'))
const LogList = defineAsyncComponent(() => import('@views/components/LogList.vue'))
const RemoteRepoCard = defineAsyncComponent(() => import('@components/RemoteRepoCard.vue'))
const RemoteManagerDialog = defineAsyncComponent(() => import('@components/RemoteManagerDialog.vue'))
const AppVersionBadge = defineAsyncComponent(() => import('@components/AppVersionBadge.vue'))
const BranchSelector = defineAsyncComponent(() => import('@components/BranchSelector.vue'))
import DirectorySelector from '@components/DirectorySelector.vue'
import UserSettingsDialog from '@/components/GitGlobalSettingsDialog.vue'
import type { SettingsTab } from '@/components/GitGlobalSettingsDialog.vue'
import ActivityBar from '@/components/ActivityBar.vue'
import InstanceSwitcher from '@/components/InstanceSwitcher.vue'
import AppErrorBanner from '@/components/AppErrorBanner.vue'
import ServerClosedOverlay from '@/components/ServerClosedOverlay.vue'
import RecentDirectoriesList from '@/components/RecentDirectoriesList.vue'
// GitHub / Gitee 仓库列表面板(Git 视图的另外两个 Tab)。静态导入:只有切到对应
// Tab 才挂载,不占首屏请求;但它本身不大,不值得为它多开一个异步 chunk。
import RemoteReposList from '@/components/RemoteReposList.vue'
import ViewLoading from '@/components/ViewLoading.vue'
// 控制台视图:默认加载(静态导入),首屏即打包进 chunk,切过去无需等待。
import ConsoleView from '@views/ConsoleView.vue'
// 视图懒加载:首屏只下载 git 视图,其它视图切过去才请求 chunk。
// loadingComponent:chunk 下载期间显示的内联占位(轻量 spinner,非全屏遮罩)。
// delay:var(--transition-base) 后才显示 loading,避免本地秒加载时 loading 一闪而过造成抖动。
// KeepAlive 缓存命中(已加载过的视图再切回)时 defineAsyncComponent 同步 resolve,
// loadingComponent 不会显示 → 首次切有 loading,之后秒切。
const asyncOpts = {
  loadingComponent: ViewLoading,
  delay: 200,
  // timeout: 60_000  // 超时走 errorComponent,暂不配
}
// 编辑器 / 源码地图等视图延迟加载（首屏不下载）
const EditorView = defineAsyncComponent({ loader: () => import('@/views/EditorView.vue'), ...asyncOpts })
const SourceMapView = defineAsyncComponent({ loader: () => import('@views/SourceMapView.vue'), ...asyncOpts })
const WorkbenchView = defineAsyncComponent({ loader: () => import('@views/WorkbenchView.vue'), ...asyncOpts })
const MonitorView = defineAsyncComponent({ loader: () => import('@views/MonitorView.vue'), ...asyncOpts })
const MindmapView = defineAsyncComponent({ loader: () => import('@views/MindmapView.vue'), ...asyncOpts })
const AgentView = defineAsyncComponent({ loader: () => import('@views/AgentView.vue'), ...asyncOpts })
import { ElConfigProvider, ElButton, ElTooltip, ElIcon } from 'element-plus'
import { Setting, WarningFilled, Sunny, Moon } from '@element-plus/icons-vue'
import logo from '@assets/logo.svg'
import { useGitStore } from '@stores/gitStore'
import { useConfigStore } from '@stores/configStore'
import { useLocaleStore } from '@stores/localeStore'
import { useInstancesStore } from '@stores/instancesStore'
import { useToolsStore } from '@stores/toolsStore'
import { useMonitorStore } from '@stores/monitorStore'
import { useNetworkStatus } from '@/composables/useNetworkStatus'
import { ALL_AI_CONTEXT_SECTIONS, refreshAiContext, refreshAiContextForView } from '@/composables/useAiContextSync'
import { useThemeObserver } from '@/composables/useThemeObserver'
import { useTaskNotifier } from '@/composables/useTaskNotifier'
import { useServerLifecycle } from '@/composables/useServerLifecycle'
import { gesturePermissionDecision, notificationPermission, requestNotificationPermission } from '@/utils/taskNotify'

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
const toolsStore = useToolsStore()
// 系统监控 Store：header 右侧常驻展示 CPU/内存
const monitorStore = useMonitorStore()
// header 系统监控轮询定时器（独立于 MonitorView，避免互相覆盖 timer）
const MONITOR_INTERVAL = 5000
let monitorTimer: number | null = null

function startHeaderMonitor() {
  stopHeaderMonitor()
  monitorStore.fetchSystem().catch(() => {})
  monitorTimer = window.setInterval(() => {
    monitorStore.fetchSystem().catch(() => {})
  }, MONITOR_INTERVAL)
}

function stopHeaderMonitor() {
  if (monitorTimer !== null) {
    window.clearInterval(monitorTimer)
    monitorTimer = null
  }
}

// 任务执行结束提示：独立订阅一条 workbench SSE（不依赖是否打开工作台视图），
// 只把「跑着 → 结束」的跃迁翻译成系统通知 / 应用内提示。
// 开关在 设置 → 通用设置 → 任务完成提示（默认开），每次事件实时读取。
const taskNotifier = useTaskNotifier()

// 宿主服务端生命周期：检出服务端退出后尝试关标签页，关不掉则亮全屏遮罩。
// 判定/关页逻辑在 composable 内，这里只负责「已确认退出」后的收尾——
// 停掉全部轮询与 socket 重连，避免僵尸页面对已死端口无限重试。
// 注意：模板里访问对象嵌套 ref 不会自动解包，所以这里解构到顶层绑定。
const serverLifecycle = useServerLifecycle()
const { isServerGone: serverGone, serverGoneName } = serverLifecycle
watch(serverGone, (gone) => {
  if (!gone) return
  instancesStore.stop()
  toolsStore.stopPolling()
  stopHeaderMonitor()
  taskNotifier.stop()
})

// 通知权限自动申请：开关默认开启后，用户很可能永远不碰设置里那个开关，
// 而浏览器只在用户手势里弹授权询问 —— 所以挂到页面内第一次点击上，补一次申请。
// 判定逻辑在 gesturePermissionDecision（配置没加载完的点击不作数，见那里的注释）；
// 只申请一次，之后无论授权/拒绝都不再打扰。
let notifyPermissionArmed = true
function onUserGestureForNotifyPermission() {
  if (!notifyPermissionArmed) return
  const decision = gesturePermissionDecision({
    loaded: configStore.isLoaded,
    enabled: configStore.notifyOnTaskDone,
    permission: notificationPermission(),
  })
  if (decision === 'wait') return
  notifyPermissionArmed = false
  if (decision === 'skip') return
  // 结果不需要在这里弹提示：拒绝后系统通知自动退回应用内提示，
  // 设置里也会如实显示"浏览器已拒绝通知权限"。
  void requestNotificationPermission()
}

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

  // useThemeObserver 已在 setup() 同步建好观察者(初值从 DOM 读),无需在此再初始化

  // OPT-5: 启动全局网络监听(patch fetch + 监听 online/offline)
  useNetworkStatus().start()

  // 启动实例注册表轮询 + Socket.IO 监听
  instancesStore.start()

  // 启动本地工具检测(vscode / claude 是否已安装),决定要不要显示对应按钮
  toolsStore.startPolling()

  // 启动 header 右侧 CPU/内存监控轮询（全局常驻，不依赖是否打开系统监控面板）
  startHeaderMonitor()

  // 启动任务结束提示的 SSE 订阅（同样全局常驻：任务跑完时用户多半不在工作台视图）
  taskNotifier.start()

  // 通知权限：页面内第一次点击时自动申请一次（capture 兜住个别组件 stopPropagation 的点击）
  window.addEventListener('pointerdown', onUserGestureForNotifyPermission, true)

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

    // Git 用户信息(user.name / user.email)是用户级/全局属性,与当前目录
    // 是否为 Git 仓库无关 —— 后端走 `git config user.name`(不带 --global),
    // 在非仓库目录也会按 local > global > system 层级 fallback 到全局值。
    // 之前它被锁在下面的 if (isGitRepo) 里,导致打开非 Git 仓库目录时
    // userName 永远停留在初始空串,右上角误报"未配置"。
    // 不 await:getUserInfo 自带 try/catch,让它与下面的仓库信息并行跑。
    gitStore.getUserInfo()

    // 只有是Git仓库的情况下才加载Git相关信息
    if (gitStore.isGitRepo) {
      // 并行获取所有Git信息，确保每个API只调用一次
      await Promise.all([
        gitStore.getCurrentBranch(true), // 强制获取当前分支（页面首次加载）
        gitStore.getAllBranches(),       // 获取所有分支
        gitStore.getRemoteUrl(),         // 获取远程仓库地址
        gitStore.fetchRemotes(),         // 获取全部远程仓库列表(多远程管理)
        gitStore.getBranchStatus(true)   // 强制获取分支状态（页面首次加载）
      ])

      // 启动时静默 git fetch --all,如有新提交则刷新右侧 log
      // 不阻塞初始化,失败也只是 warn,不影响主流程
      //
      // 延后 3s 触发:GitStatus 首屏会立刻调 git status --porcelain,
      // 如果 bootFetch 同步发起,git fetch --all 会占用仓库锁,导致 git status 阻塞 4s+。
      // 延后让首屏状态先加载完,fetch-all 再跑就不影响感知。
      setTimeout(() => {
        gitStore.bootFetch().catch(err => {
          console.warn('[App] 启动静默 fetch 异常(已忽略):', err)
        })
      }, 3000)
    }
    // 非 Git 仓库不再弹 ElMessage 提示:左侧 GitStatus 面板已经完整展示
    // "当前目录不是 Git 仓库 / 初始化并提交 / 打开其他目录",顶栏再飘一条
    // 同义 toast 只是重复噪音(顶栏旧的"非 Git 仓库"徽章此前已同理移除)。
  } catch (error) {
    console.error('初始化失败:', error)
  } finally {
    // 标记初始化完成
    initCompleted.value = true
    console.log($t('@F13B4:---------- 页面初始化完成 ----------'))

    // g ai 上下文快照:首屏起来后全量刷一次。
    // 服务端自己在 listening 后 2s 也预热过一遍（server/index.js），这里是补第二次，
    // 覆盖"服务端一直没重启、只是刷新了页面"这种情况——那时服务端那份可能已经放了很久。
    // 延后 1s 错开首屏这一堆并发请求（GitStatus / 工具检测 / 实例轮询）。
    // 两次重复触发不会重复取数:同一板块的并发生成在服务端共享同一个 Promise。
    setTimeout(() => {
      refreshAiContext(ALL_AI_CONTEXT_SECTIONS)
    }, 1000)

    // 无论是否是Git仓库，都应该加载布局比例
    // 使用短延时确保DOM已完全渲染
    setTimeout(() => {
      loadLayoutRatios();
    }, 100);
  }
})

onBeforeUnmount(() => {
  // 清掉服务端生命周期检测的定时器/监听，保证 HMR 不残留
  serverLifecycle.resetAll()

  // 停止实例注册表轮询 + 断开 Socket.IO
  instancesStore.stop()

  // 停止本地工具检测轮询
  toolsStore.stopPolling()

  // 停止 header CPU/内存监控轮询
  stopHeaderMonitor()

  // 断开任务结束提示的 SSE 订阅（停掉后不再自动重连）
  taskNotifier.stop()

  // 摘掉首次点击申请通知权限的监听
  window.removeEventListener('pointerdown', onUserGestureForNotifyPermission, true)

  // 主题 observer 由 useThemeObserver 自动清理

  // OPT-5: 卸载时还原 fetch 补丁,避免 HMR 时累积多次 patch
  useNetworkStatus().stop()
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

// 监听 isGitRepo 变化:切换目录时 grid-template-rows 需要重算
// (非 Git 仓库时清空 inline style 让 CSS class 接管,回到 Git 仓库时按持久化比例重设)
watch(() => gitStore.isGitRepo, () => {
  // 等下一个 tick 让 v-show 切换完成,DOM 区域稳定后再读 inline style
  nextTick(() => loadLayoutRatios())
})

// 处理分支变更事件
function handleBranchChanged() {
  // 刷新Git状态
  if (gitStatusRef.value) {
    gitStatusRef.value.refreshStatus()
  }
}

// 活动视图切换
const activeView = ref<'git' | 'console' | 'editor' | 'source-map' | 'workbench' | 'monitor' | 'mindmap' | 'agent'>('git')

// Git 视图内的三个 Tab:
//   current → 当前项目(原有的 GitStatus + CommitForm/最近项目 + LogList 布局,原样保留)
//   github  → GitHub 账号下的仓库列表(需要 gh)
//   gitee   → Gitee 账号下的仓库列表(需要 @gitee/gitee-cli)
// 默认停在「当前项目」,行为与加 Tab 之前完全一致。
// 只有切到对应 Tab 才会挂载 RemoteReposList(v-if),也就不会在启动时白跑一次
// gh / gitee 的检测与联网请求。
type GitTab = 'current' | 'github' | 'gitee'
const gitTab = ref<GitTab>('current')
const GIT_TABS: Array<{ id: GitTab; labelKey: string }> = [
  { id: 'current', labelKey: '@F13B4:当前项目' },
  { id: 'github', labelKey: '@F13B4:GitHub 仓库' },
  { id: 'gitee', labelKey: '@F13B4:Gitee 仓库' },
]

// 待编辑器打开的文件路径(由文件差异页"在编辑器中打开"按钮触发)。
// 设到这而不是直接 emit:EditorView 是 async 组件,activeView 切到 editor 后才挂载,
// 事件可能比挂载先到。把路径存到这里,EditorView 通过 prop 接收并在变化时 openFile。
const pendingEditorFilePath = ref<string | null>(null)

// 切换到 Git 视图时静默刷新状态（与窗口焦点/标签页可见时一致）
watch(activeView, (view) => {
  if (view === 'git') {
    // 同一个入口（内部含 isGitRepo 守卫 + 状态变化比对），别在这里另写一份
    void gitStore.refreshStatusOnFocus()
  }
})

// 面板切换 → 让服务端把 g ai 上下文里对应的板块刷一遍。
//
// 放在 App.vue 而不是各子 View 里：七个面板的"我在看哪一块"只有这里看得全，
// 而且 App.vue 是常驻的，子 View 是 v-if 懒挂载/KeepAlive——挂在子 View 的
// onActivated 上会漏掉"首次挂载"和"从 Git 视图切回智能体"这两条路径。
//
// 不 await、不 loading、失败无感：它只影响模型看到的东西，与界面无关（见 composable 头注释）。
// gitTab 与 activeView 一起 watch：Git 视图内的三个 Tab 对应的板块完全不同。
watch([activeView, gitTab], ([view, tab]) => {
  refreshAiContextForView(view, tab)
})

// 监听文件差异页"在编辑器中打开"事件 → 切到编辑器视图 + 把路径给 EditorView
// 用 setTimeout 清空 prop,让 EditorView 的 watcher 触发一次后状态可重置
// (用户再次点击同一个文件也能重新打开,而不是被 prop 同值短路)。
const pendingEditorTimer: { value: number | null } = { value: null }
function handleOpenFileInEditor(e: Event) {
  const detail = (e as CustomEvent<{ filePath: string }>).detail
  console.log('[debug-open-in-editor] App.vue handleOpenFileInEditor fired, detail=', detail)
  if (!detail?.filePath) return
  pendingEditorFilePath.value = detail.filePath
  activeView.value = 'editor'
  console.log('[debug-open-in-editor] App.vue set pendingEditorFilePath=', detail.filePath, 'activeView=editor')
  if (pendingEditorTimer.value !== null) {
    clearTimeout(pendingEditorTimer.value)
  }
  pendingEditorTimer.value = window.setTimeout(() => {
    pendingEditorFilePath.value = null
    pendingEditorTimer.value = null
  }, 500)
}
window.addEventListener('zen-gitsync:open-file-in-editor', handleOpenFileInEditor)
onBeforeUnmount(() => {
  window.removeEventListener('zen-gitsync:open-file-in-editor', handleOpenFileInEditor)
})

// 用户设置对话框
const userSettingsDialogVisible = ref(false)
/** 打开 dialog 时要跳转的目标 tab（外部入口控制） */
const userSettingsInitialTab = ref<SettingsTab | undefined>(undefined)

function openUserSettingsDialog(tab?: SettingsTab) {
  userSettingsInitialTab.value = tab ?? 'general'
  userSettingsDialogVisible.value = true
}

// 主题切换快捷按钮:跟踪 documentElement 的 data-theme,
// 这是当前实际渲染态,覆盖 configStore.theme='auto' 时跟随系统的场景
// useThemeObserver 集中处理 MutationObserver + onBeforeUnmount cleanup,
// 与 SourceMapView / MonacoEditor 共用同一份实现
const { theme: isDarkTheme } = useThemeObserver()

// ── header 系统监控指示器辅助函数 ───────────────────────────────────────
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  // 数字部分走 Intl，保证小数位与千分位跟随运行环境语言（不手写格式化）
  const formatted = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: i === 0 ? 0 : 1,
  }).format(v)
  return `${formatted} ${units[i]}`
}

function usageColor(percent: number): string {
  if (percent >= 90) return 'var(--color-danger)'
  if (percent >= 70) return 'var(--color-warning)'
  return 'var(--color-success)'
}

// 添加分隔条相关逻辑
// Git 视图现为 2 列布局:左 GitStatus | v-resizer | 右(上 commit-form / h-resizer / 下 log-list)
// 原 v-resizer-2(中间列 | log-list)随 3 列布局一起移除。
let isVResizing = false;       // 竖分隔条（GitStatus | 右侧列）
let isHResizing = false;
let initialX = 0;
let initialY = 0;
let initialGridTemplateColumns = '';
let initialGridTemplateRows = '';
// RAF 节流:把最近一次 mousemove 的 event 缓存下来,RAF 回调里读取
let lastMouseEvent: MouseEvent | null = null;
// 2 个 resizer 的 RAF id,stopXxx 时取消未触发的回调
let vResizeRafId: number | null = null
let hResizeRafId: number | null = null

// 保存布局比例到 configStore（持久化到 ~/.zen-gitsync/config.json 的 ui.layout 字段）
// 2 列布局:只存 leftRatio(GitStatus 占比) + topRatio(右侧 commit-form 占比)。
// midRatio/rightRatio 是旧 3 列布局的遗留字段,这里用 spread 保留旧值,
// 不再更新——避免给已存配置的用户制造类型迁移负担(字段在 UiLayout 中保留,无害)。
function saveLayoutRatios() {
  const gridLayout = document.querySelector('.grid-layout') as HTMLElement;
  if (!gridLayout) return;
  // 非 Git 仓库:无 h-resizer 可拖,不要保存 grid-template-rows 比例
  // (否则后续回到 Git 仓库会被旧比例覆盖默认值)
  if (!gitStore.isGitRepo) return;

  const columns = getComputedStyle(gridLayout).gridTemplateColumns.split(' ');
  const rows = getComputedStyle(gridLayout).gridTemplateRows.split(' ');

  if (columns.length >= 3 && rows.length >= 3) {
    // 解析两列区域比例(列 0 = 左, 列 2 = 右; 列 1 是 4px 分隔条)
    const leftColWidth = parseFloat(columns[0]);
    const rightColWidth = parseFloat(columns[2]);
    const totalWidth = leftColWidth + rightColWidth;

    const leftRatio = leftColWidth / totalWidth;

    // 解析上下区域比例(行 0 = commit-form, 行 2 = log-list; 行 1 是 4px 分隔条)
    const topRowHeight = parseFloat(rows[0]);
    const bottomRowHeight = parseFloat(rows[2]);
    const totalHeight = topRowHeight + bottomRowHeight;
    const topRatio = topRowHeight / totalHeight;

    // 保留旧字段(midRatio/rightRatio)原值,只更新 leftRatio + topRatio
    configStore.ui.layout = { ...configStore.ui.layout, leftRatio, topRatio };

    console.log(`${$t('@F13B4:布局比例已保存 - 左侧: ')}${(leftRatio * 100).toFixed(0)}${$t('@F13B4:%, 上方: ')}${(topRatio * 100).toFixed(0)}%`);
  }
}

// 加载布局比例（从 configStore.ui.layout 读取）
// 2 列布局:只应用 leftRatio(左 GitStatus) + topRatio(右侧上 commit-form)。
// 旧 3 列配置里的 midRatio/rightRatio 不再使用,忽略即可。
function loadLayoutRatios() {
  const gridLayout = document.querySelector('.grid-layout') as HTMLElement;
  if (!gridLayout) return;

  // 非 Git 仓库:右侧只保留 RecentDirectoriesList 一块,无 h-resizer / log-list,
  // 不需要上下分块比例,直接占满整列。清除 inline style 让 CSS class 接管。
  if (!gitStore.isGitRepo) {
    gridLayout.style.gridTemplateRows = '';
    // 刷新给 resizer aria-valuenow 用的百分比
    refreshGridPercents();
    return;
  }

  const layout = configStore.ui.layout;
  const savedLeftRatio = Number.isFinite(layout?.leftRatio) ? layout.leftRatio : null;
  const savedTopRatio = Number.isFinite(layout?.topRatio) ? layout.topRatio : null;

  // 应用两列区域比例(左 | 4px | 右)
  if (savedLeftRatio != null) {
    gridLayout.style.gridTemplateColumns = `${savedLeftRatio}fr 4px ${1 - savedLeftRatio}fr`;
  } else {
    // 默认比例 左 25% : 右 75%
    gridLayout.style.gridTemplateColumns = "0.25fr 4px 0.75fr";
  }

  // 应用上下区域比例
  if (savedTopRatio != null) {
    const bottomRatio = 1 - savedTopRatio;
    gridLayout.style.gridTemplateRows = `${savedTopRatio}fr 4px ${bottomRatio}fr`;
  } else {
    gridLayout.style.gridTemplateRows = '';
  }

  // 刷新给 resizer aria-valuenow 用的百分比
  refreshGridPercents();
}

/** 读取当前 grid 的两列宽度比(供 aria-valuenow 显示) */
function readGridPercents(): { left: number; top: number } {
  const gridLayout = document.querySelector('.grid-layout') as HTMLElement | null;
  if (!gridLayout) return { left: 25, top: 50 }
  const cols = getComputedStyle(gridLayout).gridTemplateColumns.split(' ')
  const rows = getComputedStyle(gridLayout).gridTemplateRows.split(' ')
  const leftW = parseFloat(cols[0] ?? '0')
  const rightW = parseFloat(cols[2] ?? '0')
  const totalW = leftW + rightW || 1
  const topH = parseFloat(rows[0] ?? '0')
  const bottomH = parseFloat(rows[2] ?? '0')
  const totalH = topH + bottomH || 1
  return {
    left: Math.round((leftW / totalW) * 100),
    top: Math.round((topH / totalH) * 100),
  }
}

const gridLeftPercent = ref(25)
const gridTopPercent = ref(50)

function refreshGridPercents() {
  const p = readGridPercents()
  gridLeftPercent.value = p.left
  gridTopPercent.value = p.top
}

/** 键盘方向键调整:复用拖拽逻辑,只是不进入 isVResizing 状态 */
// 2 列布局:只调 左 | 右 的比例,不再有中间列分配。
function nudgeV(deltaPercent: number) {
  const gridLayout = document.querySelector('.grid-layout') as HTMLElement | null
  if (!gridLayout) return
  const cols = getComputedStyle(gridLayout).gridTemplateColumns.split(' ')
  if (cols.length < 3) return
  const leftW = parseFloat(cols[0])
  const rightW = parseFloat(cols[2])
  const total = leftW + rightW || 1
  let newLeft = (leftW / total) * 100 + deltaPercent
  newLeft = Math.min(40, Math.max(8, newLeft))
  gridLayout.style.gridTemplateColumns = `${newLeft}fr 4px ${100 - newLeft}fr`
  refreshGridPercents()
  saveLayoutRatios()
}

function nudgeH(deltaPercent: number) {
  const gridLayout = document.querySelector('.grid-layout') as HTMLElement | null
  if (!gridLayout) return
  const rows = getComputedStyle(gridLayout).gridTemplateRows.split(' ')
  if (rows.length < 3) return
  const topH = parseFloat(rows[0])
  const bottomH = parseFloat(rows[2])
  const total = topH + bottomH || 1
  let newTop = (topH / total) * 100 + deltaPercent
  newTop = Math.min(80, Math.max(20, newTop))
  gridLayout.style.gridTemplateRows = `${newTop}fr 4px ${100 - newTop}fr`
  refreshGridPercents()
  saveLayoutRatios()
}

// 第一条竖分隔条拖拽（调整 GitStatus 与 右侧列 的比例）
// RAF 节流:把 mousemove 60 fps 合并到显示器刷新率(~16ms),避免 60×3=180 次/秒 style mutation
function scheduleVResize(event: MouseEvent) {
  lastMouseEvent = event
  if (vResizeRafId !== null) return
  vResizeRafId = requestAnimationFrame(() => {
    vResizeRafId = null
    handleVResize()
  })
}

function startVResize(event: MouseEvent) {
  isVResizing = true;
  initialX = event.clientX;

  const gridLayout = document.querySelector('.grid-layout') as HTMLElement;
  initialGridTemplateColumns = getComputedStyle(gridLayout).gridTemplateColumns;

  document.getElementById('v-resizer')?.classList.add('active');
  document.addEventListener('mousemove', scheduleVResize);
  document.addEventListener('mouseup', stopVResize);
  event.preventDefault();
}

function handleVResize() {
  if (!isVResizing) return;
  // 用最近一次 mousemove 的 clientX,避免 RAF 期间坐标漂移
  const event = lastMouseEvent
  if (!event) return;

  const gridLayout = document.querySelector('.grid-layout') as HTMLElement;
  const delta = event.clientX - initialX;
  const columns = initialGridTemplateColumns.split(' ');

  // 2 列布局:列 0 = 左, 列 2 = 右(列 1 是 4px 分隔条)
  if (columns.length >= 3) {
    const leftColWidth = parseFloat(columns[0]);
    const rightColWidth = parseFloat(columns[2]);
    const totalWidth = leftColWidth + rightColWidth;

    const newLeftRatio = (leftColWidth + delta / gridLayout.clientWidth * totalWidth) / totalWidth;

    const minLeftRatio = 0.08;
    const maxLeftRatio = 0.4;

    if (newLeftRatio < minLeftRatio) {
      gridLayout.style.gridTemplateColumns = `${minLeftRatio}fr 4px ${1 - minLeftRatio}fr`;
    } else if (newLeftRatio > maxLeftRatio) {
      gridLayout.style.gridTemplateColumns = `${maxLeftRatio}fr 4px ${1 - maxLeftRatio}fr`;
    } else {
      gridLayout.style.gridTemplateColumns = `${newLeftRatio}fr 4px ${1 - newLeftRatio}fr`;
    }
  }
}

function stopVResize() {
  isVResizing = false;

  document.getElementById('v-resizer')?.classList.remove('active');

  if (vResizeRafId !== null) { cancelAnimationFrame(vResizeRafId); vResizeRafId = null }
  document.removeEventListener('mousemove', scheduleVResize);
  document.removeEventListener('mouseup', stopVResize);

  saveLayoutRatios();
}

function startHResize(event: MouseEvent) {
  isHResizing = true;
  initialY = event.clientY;

  const gridLayout = document.querySelector('.grid-layout') as HTMLElement;
  initialGridTemplateRows = getComputedStyle(gridLayout).gridTemplateRows;

  document.getElementById('h-resizer')?.classList.add('active');
  document.addEventListener('mousemove', scheduleHResize);
  document.addEventListener('mouseup', stopHResize);
  event.preventDefault();
}

function scheduleHResize(event: MouseEvent) {
  lastMouseEvent = event
  if (hResizeRafId !== null) return
  hResizeRafId = requestAnimationFrame(() => {
    hResizeRafId = null
    handleHResize()
  })
}

function handleHResize() {
  if (!isHResizing) return;
  const event = lastMouseEvent
  if (!event) return;

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
      gridLayout.style.gridTemplateRows = `${minTopRatio}fr 4px ${1 - minTopRatio}fr`;
    } else if (newTopRatio > maxTopRatio) {
      gridLayout.style.gridTemplateRows = `${maxTopRatio}fr 4px ${1 - maxTopRatio}fr`;
    } else {
      gridLayout.style.gridTemplateRows = `${newTopRatio}fr 4px ${newBottomRatio}fr`;
    }
  }
}

function stopHResize() {
  isHResizing = false;
  document.getElementById('h-resizer')?.classList.remove('active');
  if (hResizeRafId !== null) { cancelAnimationFrame(hResizeRafId); hResizeRafId = null }
  document.removeEventListener('mousemove', scheduleHResize);
  document.removeEventListener('mouseup', stopHResize);
  saveLayoutRatios();
}

// 目录切换逻辑已移到 DirectorySelector 组件内部
</script>

<template>
  <el-config-provider :locale="localeStore.elementPlusLocale">
  <!-- OPT-5: 全局网络错误横幅(header 下方置顶,不影响主区布局) -->
  <!-- 跳过导航:键盘用户第一次 Tab 就能直达主内容(WCAG 2.4.1) -->
  <a class="skip-link" href="#main-content">{{ $t('@F13B4:跳到主内容') }}</a>
  <AppErrorBanner />
  <!-- 宿主服务端已退出：关闭标签页失败时的全屏兜底遮罩 -->
  <ServerClosedOverlay :visible="serverGone" :name="serverGoneName" />
  <header class="main-header app-header">
    <div class="header-left">
      <a href="https://github.com/xz333221/zen-gitsync" target="_blank" class="header-brand-link">
        <img :src="logo" alt="Zen GitSync Logo" class="logo" width="32" height="32" />
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
      <!-- 主题切换快捷按钮（OPT-2：原本要进设置→通用→主题 4 次点击,现在 1 次） -->
      <el-tooltip
        :content="isDarkTheme ? $t('@F13B4:切换到浅色主题') : $t('@F13B4:切换到深色主题')"
        placement="bottom"
        effect="dark"
        :show-after="200"
      >
        <button
          class="modern-btn btn-icon-32 theme-toggle-btn"
          :aria-label="isDarkTheme ? $t('@F13B4:切换到浅色主题') : $t('@F13B4:切换到深色主题')"
          :aria-pressed="isDarkTheme ? 'true' : 'false'"
          @click="configStore.toggleTheme()"
        >
          <el-icon class="btn-icon" aria-hidden="true">
            <!-- 显示「下一步动作」对应的图标,贴合主流操作系统托盘的直觉:
                 当前 dark → 太阳(点了变亮);当前 light → 月亮(点了变暗)。
                 之前 v-if/v-else 是「显示当前主题」,容易让人误点不下去。 -->
            <Sunny v-if="isDarkTheme" />
            <Moon v-else />
          </el-icon>
        </button>
      </el-tooltip>
      <!-- 系统监控指示器：header 右侧常驻展示 CPU/内存 -->
      <div v-if="monitorStore.overview" class="header-monitor">
        <el-tooltip placement="bottom" effect="dark" :show-after="200">
          <template #content>
            <div class="header-monitor__tooltip">
              <div>CPU: {{ monitorStore.overview.cpu.model }}</div>
              <div>{{ monitorStore.overview.cpu.cores }} {{ $t('@MONITOR:核心') }} · {{ monitorStore.overview.cpu.usage.toFixed(1) }}%</div>
              <div>内存: {{ formatBytes(monitorStore.overview.memory.used) }} / {{ formatBytes(monitorStore.overview.memory.total) }}</div>
              <div>空闲: {{ formatBytes(monitorStore.overview.memory.free) }}</div>
            </div>
          </template>
          <div class="header-monitor__content">
            <div class="header-monitor__item">
              <span class="header-monitor__label">CPU</span>
              <span class="header-monitor__value" :style="{ color: usageColor(monitorStore.overview.cpu.usage) }">
                {{ monitorStore.overview.cpu.usage.toFixed(0) }}%
              </span>
              <div class="header-monitor__bar">
                <div class="header-monitor__fill" :style="{ width: `${Math.min(monitorStore.overview.cpu.usage, 100)}%`, background: usageColor(monitorStore.overview.cpu.usage) }"></div>
              </div>
            </div>
            <div class="header-monitor__divider"></div>
            <div class="header-monitor__item">
              <span class="header-monitor__label">MEM</span>
              <span class="header-monitor__value" :style="{ color: usageColor(monitorStore.overview.memory.usagePercent) }">
                {{ monitorStore.overview.memory.usagePercent.toFixed(0) }}%
              </span>
              <div class="header-monitor__bar">
                <div class="header-monitor__fill" :style="{ width: `${Math.min(monitorStore.overview.memory.usagePercent, 100)}%`, background: usageColor(monitorStore.overview.memory.usagePercent) }"></div>
              </div>
            </div>
          </div>
        </el-tooltip>
      </div>
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
          <button class="modern-btn btn-icon-28" :aria-label="$t('@F13B4:用户设置')" @click="openUserSettingsDialog()">
            <el-icon class="btn-icon" aria-hidden="true"><Setting /></el-icon>
          </button>
        </el-tooltip>
      </div>
    </div>
  </header>

  <div v-if="configStore.hasConfigLoadError" class="config-broken-banner" role="alert" aria-live="polite">
    <div class="banner-left">
      <el-icon class="banner-icon" aria-hidden="true"><WarningFilled /></el-icon>
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

  <main id="main-content" tabindex="-1" class="main-container" :style="{ top: configStore.hasConfigLoadError ? '104px' : '64px' }">
    <div v-if="!initCompleted" class="loading-container">
      <div class="loading-card" role="status" aria-live="polite">
        <!-- 三层错位旋转环 spinner -->
        <div class="loading-spinner" aria-hidden="true">
          <svg class="loading-spinner__svg" viewBox="0 0 120 120">
            <defs>
              <linearGradient id="loading-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="var(--color-primary)" />
                <stop offset="100%" stop-color="var(--action-sky)" />
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

      <!-- Git 视图:2 列布局 — 左 GitStatus | 右(上 commit-form / h-resizer / 下 log-list)
           非 Git 仓库时:右上 RecentDirectoriesList 占满右侧整列,隐藏 h-resizer + log-list-panel,
           由 .grid-layout--no-bottom 控制 grid-template-rows 去掉下方行 -->
      <div v-show="activeView === 'git'" class="view-pane git-pane">
      <!-- 三个 Tab:当前项目 / GitHub 仓库 / Gitee 仓库。
           用 v-show + v-if 混合:当前项目那块要一直挂着(两个 resizer 的拖拽比例、
           LogList 的滚动位置都在它身上,不能反复销毁重建);
          两个仓库面板则是 v-if,切过去才挂载 —— 启动时不白跑 CLI 检测。 -->
      <div class="git-tabs" role="tablist" :aria-label="$t('@F13B4:Git 视图切换')">
        <button
          v-for="tab in GIT_TABS"
          :key="tab.id"
          :id="'git-tab-' + tab.id"
          type="button"
          role="tab"
          class="git-tab"
          :class="{ 'is-active': gitTab === tab.id }"
          :aria-selected="gitTab === tab.id"
          :aria-controls="'git-panel-' + tab.id"
          @click="gitTab = tab.id"
        >{{ $t(tab.labelKey) }}</button>
      </div>

      <div class="git-pane__body">
      <div v-show="gitTab === 'current'" id="git-panel-current" role="tabpanel" aria-labelledby="git-tab-current" class="grid-layout" :class="{ 'grid-layout--no-bottom': !gitStore.isGitRepo }">
      <!-- 左侧Git状态 -->
      <div class="git-status-panel">
        <GitStatus ref="gitStatusRef" :initial-directory="currentDirectory" />
      </div>

      <!-- 垂直分隔条（GitStatus | 右侧列） -->
      <div
        class="vertical-resizer"
        id="v-resizer"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        :aria-label="$t('@F13B4:调整左侧与右侧面板宽度（左右方向键）')"
        :aria-valuenow="gridLeftPercent"
        aria-valuemin="8"
        aria-valuemax="40"
        @mousedown="startVResize"
        @keydown.left.prevent="nudgeV(-2)"
        @keydown.right.prevent="nudgeV(2)"
      ></div>

      <!-- 右侧上方提交表单 -->
      <div class="commit-form-panel" v-if="gitStore.isGitRepo">
        <!-- 当用户未配置时显示配置提示 -->
        <div v-if="!gitStore.userName || !gitStore.userEmail" class="state-block state-block--warning user-unconfigured-card">
          <div class="state-block__icon user-unconfigured-icon">
            <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="8" r="4"/>
              <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
              <path d="M17 13.5l1.5 1.5 3-3" stroke="var(--color-warning)" stroke-width="2"/>
            </svg>
          </div>
          <h2 class="state-block__title user-unconfigured-title">Git {{ $t('@F13B4:用户未配置') }}</h2>
          <p class="state-block__hint user-unconfigured-desc">{{ $t('@F13B4:请先配置Git用户信息才能进行提交操作。') }}</p>
          <div class="user-unconfigured-actions">
            <button class="user-unconfigured-primary-btn" @click="() => openUserSettingsDialog()">
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
      <div class="commit-form-panel commit-form-panel--empty" v-else>
        <!-- 非 Git 仓库时,右侧空态直接用"最近项目"列表代替原"Git 仓库初始化"卡片
             (左侧 GitStatus 已经有"初始化 Git 仓库"按钮 + "尚未配置远程仓库"提示,这里不重复)
             默认即 panel(自带标题/搜索) + open(点击在新标签页打开)形态。
             layout="split":与"切换工作目录"全屏弹窗同一个版式 —— 卡片在左、AI 状态解读 +
             g ai 追问区在右。这块面板横向很宽(占右侧整列),横排比"卡片在上、解读在下"
             更能用满宽度,也让追问区与解读挨在一起。
             refresh-on-mount:这是 g ui 首屏常驻的那块面板 —— 每次打开界面(页面加载)
             自动跑一遍「刷新全部」,免得「领先/落后」一直停在"上次 fetch 时的快照"上。
             整页只跑一次,切目录重建面板不会重复联网(守卫在组件模块作用域里)。 -->
        <RecentDirectoriesList refresh-on-mount layout="split" />
      </div>

      <!-- 水平分隔条（提交表单 | 提交历史） -->
      <div
        v-show="gitStore.isGitRepo"
        class="horizontal-resizer"
        id="h-resizer"
        role="separator"
        tabindex="0"
        aria-orientation="horizontal"
        :aria-label="$t('@F13B4:调整上方与下方面板高度（上下方向键）')"
        :aria-valuenow="gridTopPercent"
        aria-valuemin="20"
        aria-valuemax="80"
        @mousedown="startHResize"
        @keydown.up.prevent="nudgeH(-2)"
        @keydown.down.prevent="nudgeH(2)"
      ></div>

      <!-- 右侧下方提交历史(仅 Git 仓库显示,非 Git 仓库时 RecentDirectoriesList 占满右侧整列) -->
      <div v-show="gitStore.isGitRepo" class="log-list-panel">
        <LogList />
      </div>

      </div><!-- /grid-layout（当前项目） -->

      <!-- GitHub 仓库列表。v-if 而非 v-show:切过来才发请求、才去检测 gh ——
           否则每次启动都会白跑一次 CLI 探测。 -->
      <RemoteReposList
        v-if="gitTab === 'github'"
        id="git-panel-github"
        role="tabpanel"
        aria-labelledby="git-tab-github"
        provider="github"
      />

      <!-- Gitee 仓库列表(检测 gitee / @gitee/gitee-cli) -->
      <RemoteReposList
        v-if="gitTab === 'gitee'"
        id="git-panel-gitee"
        role="tabpanel"
        aria-labelledby="git-tab-gitee"
        provider="gitee"
      />

      </div><!-- /git-pane__body -->

      </div><!-- /view-pane git -->

      <!-- 控制台视图（默认加载：随首屏静态挂载，切过去零等待；KeepAlive 缓存实例保状态） -->
      <div v-show="activeView === 'console'" class="view-pane console-pane">
        <KeepAlive>
          <ConsoleView />
        </KeepAlive>
      </div>

      <!-- 编辑器视图（懒加载：v-if 控制组件加载，KeepAlive 缓存实例保状态；
           wrapper div 仍用 v-show 管 flex 布局占位，display:none 不抢 flex 空间） -->
      <div v-show="activeView === 'editor'" class="view-pane editor-pane">
        <KeepAlive>
          <EditorView v-if="activeView === 'editor'" :pending-file-path="pendingEditorFilePath" />
        </KeepAlive>
      </div>

      <!-- 源码地图视图（懒加载 + KeepAlive 缓存） -->
      <div v-show="activeView === 'source-map'" class="view-pane source-map-pane">
        <KeepAlive>
          <SourceMapView v-if="activeView === 'source-map'" />
        </KeepAlive>
      </div>

      <!-- 工作台视图（懒加载 + KeepAlive 缓存：任务进度/执行状态切走不丢） -->
      <div v-show="activeView === 'workbench'" class="view-pane workbench-pane">
        <KeepAlive>
          <WorkbenchView v-if="activeView === 'workbench'" />
        </KeepAlive>
      </div>

      <!-- 系统监控视图（懒加载 + KeepAlive 缓存） -->
      <div v-show="activeView === 'monitor'" class="view-pane monitor-pane">
        <KeepAlive>
          <MonitorView v-if="activeView === 'monitor'" />
        </KeepAlive>
      </div>

      <!-- 思维导图视图（懒加载 + KeepAlive 缓存） -->
      <div v-show="activeView === 'mindmap'" class="view-pane mindmap-pane">
        <KeepAlive>
          <MindmapView v-if="activeView === 'mindmap'" />
        </KeepAlive>
      </div>

      <!-- 智能体视图（懒加载 + KeepAlive 缓存：会话列表/对话状态切走不丢） -->
      <div v-show="activeView === 'agent'" class="view-pane agent-pane">
        <KeepAlive>
          <AgentView v-if="activeView === 'agent'" />
        </KeepAlive>
      </div>

    </div><!-- /app-body -->
  </main>

  <footer class="main-footer app-footer">
    <div class="footer-left">
      <BranchSelector @branch-changed="handleBranchChanged" />
      <RemoteRepoCard />
    </div>
    <!-- 默认模型：三区栅格的中列，永远居中且不会和两侧文字重叠
         （改前是绝对定位 left:50% + translateX(-50%)，远程地址较长时
         会和它叠在一起，实测窄窗口下「zen-gitsync」与「默认模型」糊成一团） -->
    <button
      v-if="defaultModelName"
      type="button"
      class="footer-model-hint"
      :aria-label="`${$t('@F13B4:默认模型')}: ${defaultModelName}`"
      @click="() => openUserSettingsDialog('ai-models')"
    >
      <span class="footer-model-hint__label">{{ $t('@F13B4:默认模型') }}</span>
      <span class="footer-model-hint__name">{{ defaultModelName }}</span>
    </button>
    <div class="footer-right">
      <AppVersionBadge />
    </div>
  </footer>

  <!-- 用户设置对话框 -->
  <UserSettingsDialog v-model="userSettingsDialogVisible" :initial-tab="userSettingsInitialTab" />

  <!-- 远程仓库管理对话框（可见性由 store 统一持有，多个入口共用） -->
  <RemoteManagerDialog />
  </el-config-provider>
</template>

<style>
body {
  font-family: var(--font-sans);
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
/* footer 走 fixed,不再依赖文档流 #app 高度撑开;
   之前 main-container 已是 position: fixed 脱离文档流,导致 #app 高度坍缩,
   position: static 的 footer 跑到 #app 顶部(top: 0) */
.main-footer {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 32px;
  z-index: 1002;
  background: var(--bg-footer);
  border-top: 1px solid var(--border-color-light);
  /* 左 / 中 / 右 三区栅格：中列的「默认模型」永远居中，
     两侧各自挤占剩余空间，不会互相重叠（改前中列是绝对定位，会和远程地址叠字） */
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  column-gap: var(--spacing-md);
  padding: 0 var(--spacing-md);
}

.footer-left,
.footer-right {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  min-width: 0;   /* 允许内部远程地址按自身 max-width 截断，而不是把中列顶出去 */
}

/* 子项也解除 min-width:auto：
   flex/grid 的「自动最小尺寸」默认取 min-content，URL 这类长串会被算成整串宽度，
   结果是左列不收缩、直接把居中的「默认模型」压住。显式 0 之后
   RemoteRepoCard 自己的 max-width + ellipsis 才会生效。 */
.footer-left > *,
.footer-right > * {
  min-width: 0;
}

.footer-right {
  justify-content: flex-end;
  gap: var(--spacing-sm);
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
  background: var(--tint-warning-14);
  border-bottom: 1px solid color-mix(in srgb, var(--color-warning) 35%, transparent);
  color: var(--text-primary);
  animation: banner-slide-down var(--transition-slow) var(--ease-custom);
}

[data-theme="dark"] .config-broken-banner {
  background: color-mix(in srgb, var(--color-warning) 16%, transparent);
  border-bottom-color: color-mix(in srgb, var(--color-warning) 38%, transparent);
}

@keyframes banner-slide-down {
  from {
    transform: translateY(-100%);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.config-broken-banner .banner-left {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  min-width: 0;
}

.config-broken-banner .banner-icon {
  color: var(--color-warning);
  flex-shrink: 0;
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
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
  text-decoration: underline dotted;
  text-underline-offset: 3px;
  transition: color var(--transition-fast) var(--ease-custom);
}

.config-broken-banner .banner-detail:hover {
  color: var(--text-primary);
}

.config-broken-banner .banner-path {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 55vw;
}

.config-broken-banner .banner-actions {
  flex-shrink: 0;
}

/* ── Git 视图的 Tab 外壳(当前项目 / GitHub 仓库 / Gitee 仓库) ────────────
   .git-pane 取代原来 .view-pane.grid-layout 的双重身份:自己只负责"列方向
   flex + 撑满",网格布局下移到 .git-pane__body 里的 .grid-layout。
   .grid-layout 的类名必须保留 —— App.vue 里两个 resizer 都靠
   querySelector('.grid-layout') 读写 grid-template-rows/columns。 */
.git-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.git-tabs {
  flex: 0 0 auto;
  display: flex;
  align-items: stretch;
  gap: 2px;
  padding: 0 var(--spacing-md);
  border-bottom: 1px solid var(--border-color-light);
  background: var(--bg-panel);
}

.git-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 38px;
  padding: 0 var(--spacing-base);
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--font-size-md);
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--transition-fast), background var(--transition-fast);
}
.git-tab:hover {
  color: var(--text-primary);
  background: var(--bg-component-hover);
}
.git-tab.is-active {
  color: var(--color-primary);
  font-weight: var(--font-weight-medium);
}
/* 选中态下划线压在 1px 分隔线上(bottom:-1px),视觉上把两个区域连起来 */
.git-tab.is-active::after {
  content: '';
  position: absolute;
  left: var(--spacing-sm);
  right: var(--spacing-sm);
  bottom: -1px;
  height: 2px;
  border-radius: var(--radius-xs);
  background: var(--color-primary);
}
.git-tab:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
}

.git-pane__body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* 当前项目那格:min-height:0 是关键 —— 没有它,grid 的 min-content 会把
   flex 项顶高,底部的提交历史会被挤出视口(与 .dir-list--panel 同一个坑) */
.git-pane__body > .grid-layout {
  flex: 1 1 auto;
  min-height: 0;
}

.grid-layout {
  display: grid;
  /* 2 列:左 GitStatus | 4px 分隔条 | 右(上 commit-form / h-resizer / 下 log-list) */
  grid-template-columns: 0.25fr 4px 0.75fr;
  grid-template-rows: 1fr 4px 1fr;
  grid-template-areas:
    "git-status v-resizer commit-form"
    "git-status v-resizer h-resizer"
    "git-status v-resizer log-list";
  gap: 0;
  height: 100%;
}

/* 非 Git 仓库:右侧只保留 RecentDirectoriesList 一块,
   隐藏 h-resizer + log-list 行,让 commit-form 行占满右侧整列。
   用 minmax(0, 1fr) 替代 1fr,让 grid row 高度不被子项 min-content 撑大。
   注意:这里也要重置 grid-template-columns,否则 @media (max-width:1024px)
   媒体查询的 5 列布局会覆盖默认 3 列,让右列 (commit-form) 被挤窄。
   selector 重复 .grid-layout 提升 specificity(media query 用了 !important,
   这里 selector 升级到 (0,2,0) 匹配 media query 的 !important 优先级) */
.grid-layout.grid-layout--no-bottom {
  grid-template-rows: minmax(0, 1fr) 0fr 0fr;
  grid-template-columns: 0.25fr 4px 0.75fr !important;
}

.git-status-panel {
  grid-area: git-status;
  overflow: hidden;
  max-height: 100%;
  padding: 0;
  background: var(--bg-panel);
  border-radius: 0;
  /* 内 1px 描边:与右侧分隔条对齐,亮色下可见,深色下自然隐入 */
  box-shadow: inset -1px 0 0 var(--border-color-light);
}

.commit-form-panel {
  grid-area: commit-form;
  overflow: hidden;
  max-height: 100%;
  padding: 0;
  background: var(--bg-container);
  border-radius: 0;
  /* 右侧列上方面板:左贴 v-resizer、下接 h-resizer,内描边给视觉边界 */
  box-shadow:
    inset -1px 0 0 var(--border-color-light),
    inset 1px 0 0 var(--border-color-light),
    inset 0 -1px 0 var(--border-color-light);
}
/* 非 git 仓库空态:卡片不再贴左右分隔条 */
.commit-form-panel--empty {
  padding: 0 var(--spacing-md);
  /* 让子组件 RecentDirectoriesList 用 height:100% 撑满 panel 自身高度 */
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.log-list-panel {
  grid-area: log-list;
  overflow: hidden;
  max-height: 100%;
  padding: 0;
  background: var(--bg-panel);
  border-radius: 0;
  /* 内 1px 描边:与左侧分隔条对齐 + 顶部贴 h-resizer */
  box-shadow:
    inset 1px 0 0 var(--border-color-light),
    inset 0 1px 0 var(--border-color-light);
}

.main-header {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 1000;
  height: 64px;
  box-sizing: border-box;
  padding: 0 var(--spacing-lg);
  display: grid;
  grid-template-columns: 1fr minmax(0, auto) 1fr;
  align-items: center;
  gap: var(--spacing-base);
}

.header-left {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  justify-self: start;
  position: relative;
  z-index: 2;
  min-width: 0;
}

.header-brand-link {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  text-decoration: none;
  color: inherit;
  cursor: pointer;
  padding: 4px var(--spacing-sm);
  margin-left: calc(-1 * var(--spacing-sm));
  border-radius: var(--radius-md);
  transition:
    background-color var(--transition-base) var(--ease-custom),
    transform var(--transition-base) var(--ease-custom);
}

.header-brand-link:hover {
  background: var(--tint-primary-08);
}

.header-brand-link:active {
  transform: scale(0.98);
}

.header-brand-link:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring-soft);
}

.header-center {
  min-width: 0;
  max-width: min(720px, 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  justify-self: center;
  z-index: 1;
  overflow: visible;
}

.logo {
  height: 32px;
  width: auto;
}

/* 跳过导航链接:默认移出视口,获得焦点时滑入(仅键盘用户可见) */
.skip-link {
  position: fixed;
  top: 8px;
  left: 8px;
  z-index: 2000;
  padding: 8px 14px;
  border-radius: var(--radius-md);
  background: var(--color-primary);
  color: #fff;
  font-size: var(--font-size-base);
  text-decoration: none;
  transform: translateY(-200%);
  transition: transform var(--transition-fast) var(--ease-standard);
}

.skip-link:focus,
.skip-link:focus-visible {
  transform: translateY(0);
  outline: 2px solid var(--color-primary-dark);
  outline-offset: 2px;
}

h1 {
  margin: 0;
  font-size: var(--font-size-xl);
  text-wrap: balance; /* 避免标题末行只剩一个词 */
  font-weight: 700;
  letter-spacing: -0.6px;
  font-family: var(--font-sans);
  color: var(--color-primary-dark);
}

[data-theme="dark"] h1 {
  color: var(--color-primary-light);
}

.header-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  justify-self: end;
  min-width: 0;
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
  transition:
    border-color var(--transition-base) var(--ease-custom),
    box-shadow var(--transition-base) var(--ease-custom),
    background-color var(--transition-base) var(--ease-custom),
    transform var(--transition-base) var(--ease-custom);
  background: var(--bg-subtle);
  cursor: default;
}

#user-info:hover {
  border-color: var(--color-primary);
  background: var(--tint-primary-10);
  box-shadow: var(--focus-ring-soft);
  transform: translateY(-0.5px);
}

#user-info:focus-within {
  border-color: var(--color-primary);
  box-shadow: var(--focus-ring);
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

/* header 右侧系统监控指示器（CPU/内存）
   不加边框容器：顶栏右侧已经有「实例切换器」和用户卡两个描边盒子，
   再加第三个框会让整排变成一列方盒。这里退成纯读数，靠 tooltip 承载细节。 */
.header-monitor {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 42px;
  padding: 0 8px;
  box-sizing: border-box;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  transition: background var(--transition-base) var(--ease-custom);
  cursor: default;
  flex-shrink: 0;
}

.header-monitor:hover {
  background: var(--bg-hover);
}

.header-monitor__content {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
}

.header-monitor__item {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.header-monitor__label {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-tertiary);
  letter-spacing: 0.3px;
}

.header-monitor__value {
  font-size: var(--font-size-sm);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  min-width: 30px;
  text-align: right;
}

.header-monitor__bar {
  width: 24px;
  height: 3px;
  border-radius: var(--radius-xs);
  background: var(--border-color);
  overflow: hidden;
}

.header-monitor__fill {
  height: 100%;
  border-radius: var(--radius-xs);
  transition: width 0.4s ease, background 0.4s ease;
}

.header-monitor__divider {
  display: none;
}

.header-monitor__tooltip {
  font-size: var(--font-size-sm);
  line-height: 1.6;
  white-space: nowrap;
}

.user-label {
  font-weight: bold;
}

.user-name {
  font-weight: bold;
  cursor: help;
  transition: color var(--transition-base) ease;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-name:hover {
  color: var(--color-primary);
}

.branch-name {
  font-family: var(--font-mono);
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

/* 用户未配置提示卡片 —— 复用 .state-block(state-block--warning variant) */
.user-unconfigured-card {
  height: 100%;
  padding: var(--spacing-xl);
  /* state-block 默认 gap 为 12px,这里通过子元素自管 margin 保留原节奏 */
  gap: 0;
}

.user-unconfigured-icon {
  --state-icon-size: 72px;
  /* 强化 warning 视觉:加细描边 */
  border: 1.5px solid color-mix(in srgb, var(--color-warning) 25%, transparent);
}

.user-unconfigured-title {
  font-size: var(--font-size-lg);
}

.user-unconfigured-desc {
  max-width: 40ch;
}

.user-unconfigured-actions {
  margin: var(--spacing-base) 0 var(--spacing-lg);
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
  transition: opacity var(--transition-fast), transform var(--transition-fast), box-shadow var(--transition-fast);
}

.user-unconfigured-primary-btn:hover {
  opacity: 0.92;
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
}

.user-unconfigured-primary-btn:active {
  opacity: 1;
  transform: translateY(0);
}

.user-unconfigured-primary-btn:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
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
  animation-delay: var(--transition-fast);
  background: var(--color-primary-light);
}

.loading-dots__dot:nth-child(3) {
  animation-delay: var(--transition-slow);
  background: var(--action-sky);
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

/* 非Git仓库初始化卡片相关样式已随原卡片整体移除 —— 中间空态改为 RecentDirectoriesList */

/* 底栏本身不可点：整条 hover 变底色的旧样式会让 32px 状态栏在被划过时整条闪一下，
   真正可交互的是里面的分支/模型/版本几个控件，各自有 hover 反馈 */
.footer-model-hint {
  display: flex;
  align-items: center;
  gap: 5px;
  background: transparent;
  border: 1px solid transparent;
  padding: 3px 10px;
  border-radius: var(--radius-md);
  cursor: pointer;
  color: inherit;
  font: inherit;
  user-select: none;
  transition:
    background-color var(--transition-base) var(--ease-custom),
    border-color var(--transition-base) var(--ease-custom),
    color var(--transition-base) var(--ease-custom),
    transform var(--transition-fast) var(--ease-custom);
}

.footer-model-hint:hover {
  background: var(--tint-primary-12);
  border-color: color-mix(in srgb, var(--color-primary) 35%, transparent);
}

.footer-model-hint:hover .footer-model-hint__name {
  color: var(--color-primary);
  opacity: 1;
}

.footer-model-hint:active {
  transform: scale(0.97);
}

.footer-model-hint:focus-visible {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: var(--focus-ring-soft);
}

.footer-model-hint__label {
  font-size: var(--font-size-xs);
  opacity: 0.55;
}

.footer-model-hint__name {
  font-size: var(--font-size-xs);
  font-weight: 500;
  opacity: 0.85;
  max-width: 200px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color var(--transition-base) var(--ease-custom), opacity var(--transition-base) var(--ease-custom);
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

/* 控制台面板:CustomCommandsPanel + CommandConsole 自管内部布局,外层 flex 即可 */
.console-pane {
  display: flex;
  overflow: hidden;
}

</style>

<style scoped>
.logo {
  will-change: filter;
  transition: filter var(--transition-slow);
}

.logo:hover {
  filter: drop-shadow(0 0 2em #42b883aa);
}

/* 垂直分隔条样式 —— 默认 4px 透明细列(不挤压两侧),hover 时整列变浅蓝高亮 */
.vertical-resizer {
  grid-area: v-resizer;
  cursor: col-resize;
  position: relative;
  z-index: 10;
  background-color: transparent;
  transition: background-color var(--transition-fast);
}

.vertical-resizer::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 1px;
  background-color: transparent;
  transition: background-color var(--transition-fast), width var(--transition-fast), box-shadow var(--transition-fast);
  pointer-events: none;
}

.vertical-resizer:hover,
.vertical-resizer.active {
  background-color: var(--tint-primary-12);
}

.vertical-resizer:hover::after,
.vertical-resizer.active::after {
  width: 2px;
  background-color: var(--color-primary);
}

/* 水平分隔条样式 */
.horizontal-resizer {
  grid-area: h-resizer;
  background-color: transparent;
  cursor: row-resize;
  transition: background-color var(--transition-base);
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
  border-radius: var(--radius-xs);
  transition: background-color var(--transition-base), height var(--transition-base), width var(--transition-base), box-shadow var(--transition-base);
}

.horizontal-resizer:hover,
.horizontal-resizer.active {
  background-color: var(--tint-primary-08);
}

.horizontal-resizer:hover::after,
.horizontal-resizer.active::after {
  background-color: var(--color-primary);
  height: 4px;
  width: 48px;
  border-radius: var(--radius-xs);
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

/* 主题切换快捷按钮：无边框图标按钮（悬停才浮出底面）
   之前和实例切换器/用户卡一样带描边，顶栏右侧出现三个并排的方盒 */
.theme-toggle-btn {
  flex-shrink: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-lg);
  padding: 0;
  color: var(--text-tertiary);
  box-shadow: none;
  transition:
    background-color var(--transition-base) var(--ease-custom),
    border-color var(--transition-base) var(--ease-custom),
    color var(--transition-base) var(--ease-custom),
    transform var(--transition-fast) var(--ease-custom);
}

.theme-toggle-btn:hover {
  background: var(--bg-hover);
  border-color: transparent;
  color: var(--text-primary);
}

.theme-toggle-btn:active {
  transform: scale(0.96);
}

.theme-toggle-btn:focus-visible {
  outline: none;
  border-color: transparent;
  box-shadow: var(--focus-ring);
}

.theme-toggle-btn .btn-icon {
  transition: transform var(--transition-slow) var(--ease-enter);
}

.theme-toggle-btn:hover .btn-icon {
  transform: rotate(-18deg) scale(1.08);
}

</style>



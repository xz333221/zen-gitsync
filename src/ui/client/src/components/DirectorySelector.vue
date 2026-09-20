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
import CommonDialog from "@components/CommonDialog.vue";
import { FilePickerModal as FilePicker } from 'local-file-picker/client';
import { ElMessage, ElMessageBox, ElPopover } from "element-plus";
import { Folder, FolderOpened, Clock, Monitor, ArrowDown, ArrowUp } from "@element-plus/icons-vue";
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { useConfigStore } from "@/stores/configStore";
import { useGitStore } from "@/stores/gitStore";
import { useLocaleStore } from "@/stores/localeStore";
import { useToolsStore, type ToolId } from "@/stores/toolsStore";
import { storeToRefs } from "pinia";
import IconButton from "@components/IconButton.vue";
import RecentDirectoriesList from "@components/RecentDirectoriesList.vue";
import SvgIcon from "@components/SvgIcon/index.vue";
import ToolInstallDialog from "@components/ToolInstallDialog.vue";
import claudeCodeIcon from "@/assets/icons/svg/claudecode-color.svg";
import { getFolderNameFromPath } from "@/utils/path";
// 打开方式(文件管理器 / 终端 / 各编辑器与 AI 工具 / 新标签页跑 g ui)统一走这个 composable：
// 编排台的项目列表用的是同一份端点映射和工具展示名，避免同一个工具在顶栏叫一个名、
// 在项目列表里叫另一个名。这里只负责把结果翻译成 toast，交互(安装引导、版本 tooltip)仍在本组件。
import {
  OPEN_WITH_TOOLS,
  TOOL_DISPLAY_NAMES,
  ensureToolsChecked,
  launchGuiInNewTab,
  openPathInFileManager,
  openPathInTerminal,
  openPathWithTool,
  type OpenDirectoryResult,
  type OpenWithToolId,
} from "@/composables/useDirectoryOpenActions";

const props = withDefaults(defineProps<{
  variant?: 'default' | 'header'
}>(), {
  variant: 'default'
})

// 使用 store
const configStore = useConfigStore();
const gitStore = useGitStore();
const toolsStore = useToolsStore();
const { currentLocale } = storeToRefs(useLocaleStore());

// 从 store 中获取当前目录
const currentDirectory = computed(() => configStore.currentDirectory);

// 获取当前文件夹名称（用于显示）
const currentFolderName = computed(() => getFolderNameFromPath(currentDirectory.value));

// 当前是否为深色主题
const isDark = computed(() => {
  const t = configStore.theme
  if (t === 'dark') return true
  if (t === 'light') return false
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
})

// 右键复制目录路径
async function onCopyDirectory() {
  if (!currentDirectory.value) return;
  try {
    await navigator.clipboard.writeText(currentDirectory.value);
    ElMessage.success($t('@67CE7:已复制目录路径'));
  } catch {
    ElMessage.error($t('@67CE7:复制失败'));
  }
}

// 对话框与状态
const isDirectoryDialogVisible = ref(false);
const newDirectoryPath = ref("");
const isChangingDirectory = ref(false);
// 弹窗里的"常用目录"由 RecentDirectoriesList 统一渲染(与最近项目同一套卡片 + 同一份数据),
// 这里只持有实例引用:每次打开弹窗 reload() 一次,避免展示上一次打开时的缓存。
const recentDirsListRef = ref<InstanceType<typeof RecentDirectoriesList> | null>(null);
// 常用目录总数:列表内部滚动,label 上标出总数,避免"看到几个就以为只有几个"
const recentDirsCount = ref(0);
const isBrowserDialogVisible = ref(false);
const installDialogVisible = ref(false);
const selectedInstallTool = ref<ToolId | null>(null);

function openToolInstall(tool: ToolId) {
  selectedInstallTool.value = tool
  installDialogVisible.value = true
}

/**
 * 「打开目录」类操作的统一反馈。
 * 成功文案优先用服务端返回的（可能附 permission-mode 之类的细节），没有才用调用方给的兜底；
 * 失败一律「<动作>失败: 原因」—— 原因可能来自服务端，也可能是网络层异常（此时是 fetch 的
 * 报错信息），对用户来说是同一件事：没打开成。
 */
function toastOpenResult(result: OpenDirectoryResult, successFallbackKey: string, failPrefixKey: string) {
  if (result.success) {
    ElMessage.success(result.message || $t(successFallbackKey))
  } else {
    ElMessage.error(`${$t(failPrefixKey)}${result.error ?? ''}`)
  }
}

/** 路径为空时给个提示并返回 true（调用方直接 return）—— 顶栏的当前目录理论上不会为空，
 *  但兜底一下比把空路径丢给服务端强 */
function warnIfEmptyDirectory(): boolean {
  if (currentDirectory.value) return false
  ElMessage.warning($t('@67CE7:当前目录路径为空'))
  return true
}

function toolTooltip(tool: ToolId, availableText: string) {
  if (toolsStore.lastCheckedAt === null) {
    return $t('@67CE7:正在检测 {tool}', { tool: TOOL_DISPLAY_NAMES[tool] })
  }
  if (!toolsStore.isToolAvailable(tool)) {
    return $t('@67CE7:{tool} 未安装，点击查看安装方式', { tool: TOOL_DISPLAY_NAMES[tool] })
  }
  // 已安装:tooltip 附上本地版本号(来自 check-tools 的 --version 采集);
  // 采集不到(桌面应用/输出格式不认识)就不加,保持原样。
  const version = toolsStore.versions[tool]
  return version ? `${availableText}\nv${version}` : availableText
}

async function runOrInstall(tool: ToolId, action: () => void | Promise<void>) {
  if (!(await ensureToolsChecked())) {
    ElMessage.warning($t('@67CE7:工具检测失败，请稍后重试'))
    return
  }
  if (!toolsStore.isToolAvailable(tool)) {
    openToolInstall(tool)
    return
  }
  await action()
}

function onClaudePrimaryClick() {
  runOrInstall('claude', () => onOpenInClaudeCode('bypassPermissions'))
}

async function onOpenInKimi() {
  if (warnIfEmptyDirectory()) return
  toastOpenResult(
    await openPathWithTool('kimi', currentDirectory.value),
    '@67CE7:已用 Kimi Code 打开目录',
    '@67CE7:打开失败: ',
  )
}

async function onOpenInZcode() {
  if (warnIfEmptyDirectory()) return
  toastOpenResult(
    await openPathWithTool('zcode', currentDirectory.value),
    '@67CE7:已用 ZCode 打开目录',
    '@67CE7:打开失败: ',
  )
}

async function onOpenInDsh() {
  if (warnIfEmptyDirectory()) return
  toastOpenResult(
    await openPathWithTool('dsh', currentDirectory.value),
    '@67CE7:已启动 DeepSeek Harness',
    '@67CE7:打开失败: ',
  )
}

async function onClaudeContextMenu() {
  if (!(await ensureToolsChecked())) {
    ElMessage.warning($t('@67CE7:工具检测失败，请稍后重试'))
    return
  }
  if (toolsStore.claudeAvailable) {
    void toolsStore.fetchLatestVersions() // 右键打开菜单时顺带查最新版(5 分钟缓存)
    openClaudeMenu()
  } else {
    openToolInstall('claude')
  }
}

// ── 工具按钮分组：已安装常驻显示，未安装收进"更多"菜单 ────────────────
// header 空间有限，7 个工具全铺开太长。未安装的工具点了也只会弹安装引导，
// 没必要占常驻位，收进菜单里按需取用。

/** 除 claude 外的工具（claude 有右键菜单，单独渲染） */
type SimpleToolId = OpenWithToolId

interface SimpleTool {
  id: SimpleToolId
  name: string
  icon: string
  label: string
  action: () => void | Promise<void>
}

/** 每个工具的打开动作。成功兜底文案各不相同（服务端一般都给了 message，这里只是保底），
 *  所以仍是一个工具一个函数；图标 / 名称 / 菜单文案统一取自 OPEN_WITH_TOOLS ——
 *  和编排台项目列表的「打开方式」菜单共用一份，避免同一工具两处叫法/图标不一致。 */
const TOOL_ACTIONS: Record<SimpleToolId, () => void | Promise<void>> = {
  vscode: onOpenInVscode,
  codex: onOpenInCodex,
  opencode: onOpenInOpencode,
  kimi: onOpenInKimi,
  zcode: onOpenInZcode,
  dsh: onOpenInDsh,
}

const simpleTools: SimpleTool[] = OPEN_WITH_TOOLS.map((tool) => ({
  id: tool.id,
  name: tool.name,
  icon: tool.icon,
  label: $t(tool.labelKey),
  action: TOOL_ACTIONS[tool.id],
}))

/**
 * "更多"菜单是否展开。
 * 必须和 claude 菜单一样走 manual trigger：IconButton 的根元素是 el-tooltip（组件，
 * 不是原生 DOM），el-popover 的 trigger="click" 拿不到可靠的 reference 节点，
 * 点了不会弹。所以用 span 包一层自己接管 click，关闭交给 document 监听。
 */
const moreToolsVisible = ref(false)
const moreToolsTriggerRef = ref<HTMLElement | null>(null)

function toggleMoreTools() {
  moreToolsVisible.value = !moreToolsVisible.value
}

/** 检测未完成前全部按 checking 态显示，不做分组，避免首屏按钮跳来跳去 */
const toolsDetected = computed(() => toolsStore.lastCheckedAt !== null)

/** 常驻显示的工具：检测中显示全部，检测后只显示已安装的 */
const visibleTools = computed(() =>
  !toolsDetected.value ? simpleTools : simpleTools.filter((t) => toolsStore.isToolAvailable(t.id))
)

/** 未安装的 claude 也要进菜单（已安装的 claude 单独常驻渲染） */
const missingTools = computed(() => {
  const list: { id: ToolId; name: string; icon?: string; label: string }[] = []
  if (!toolsDetected.value) return list
  for (const t of simpleTools) {
    if (!toolsStore.isToolAvailable(t.id)) {
      list.push({ id: t.id, name: t.name, icon: t.icon, label: t.label })
    }
  }
  if (!toolsStore.claudeAvailable) {
    list.push({ id: 'claude', name: TOOL_DISPLAY_NAMES.claude, label: '用 Claude Code 打开' })
  }
  return list
})
const hasMissingTools = computed(() => missingTools.value.length > 0)

function runMissingTool(tool: { id: ToolId }) {
  moreToolsVisible.value = false
  if (tool.id === 'claude') {
    openToolInstall('claude')
    return
  }
  const found = simpleTools.find((t) => t.id === tool.id)
  if (found) runOrInstall(found.id, found.action)
}

/** 已安装 claude 时才常驻渲染（未安装的走"更多"菜单） */
const claudePinned = computed(() => !toolsDetected.value || toolsStore.claudeAvailable)

// 定义emits
defineEmits<{
  toggleNpmPanel: []
  toggleCustomCmdsPanel: []
}>();

// 打开切换目录对话框
function onOpenDialog() {
  newDirectoryPath.value = currentDirectory.value;
  isDirectoryDialogVisible.value = true;
  // 常用目录每次打开都重新拉一次(用户可能刚在别的标签页切过目录)
  recentDirsListRef.value?.reload();
}

// 在资源管理器中打开当前目录
async function onOpenExplorer() {
  if (warnIfEmptyDirectory()) return;
  toastOpenResult(
    await openPathInFileManager(currentDirectory.value),
    '@67CE7:已在文件管理器中打开目录',
    '@67CE7:打开目录失败: ',
  );
}

// 用 VSCode 打开当前目录
async function onOpenInVscode() {
  if (warnIfEmptyDirectory()) return;
  toastOpenResult(
    await openPathWithTool('vscode', currentDirectory.value),
    '@67CE7:已用 VSCode 打开目录',
    '@67CE7:打开失败: ',
  );
}

// 用 Claude Code 打开当前目录
// permissionMode 可选：透传到 claude CLI（例：'acceptEdits' = 完全批准）
async function onOpenInClaudeCode(permissionMode?: string) {
  // 触发时也顺手关掉右键菜单
  closeClaudeMenu()
  if (warnIfEmptyDirectory()) return;
  toastOpenResult(
    await openPathWithTool('claude', currentDirectory.value, permissionMode),
    '@67CE7:已用 Claude Code 打开目录',
    '@67CE7:打开失败: ',
  );
}

// 用 Codex 打开当前目录
async function onOpenInCodex() {
  if (warnIfEmptyDirectory()) return;
  toastOpenResult(
    await openPathWithTool('codex', currentDirectory.value),
    '@67CE7:已用 Codex 打开目录',
    '@67CE7:打开失败: ',
  );
}

// 用 OpenCode 打开当前目录
async function onOpenInOpencode() {
  if (warnIfEmptyDirectory()) return;
  toastOpenResult(
    await openPathWithTool('opencode', currentDirectory.value),
    '@67CE7:已用 OpenCode 打开目录',
    '@67CE7:打开失败: ',
  );
}

// 右键菜单（el-popover manual 模式）—— 避开 el-dropdown 在 el-tooltip 嵌套下的 contextmenu 失效问题
const claudeMenuVisible = ref(false)
const claudeTriggerRef = ref<HTMLElement | null>(null)

function openClaudeMenu() {
  // @contextmenu.prevent 已经阻止了浏览器默认菜单
  claudeMenuVisible.value = !claudeMenuVisible.value
}
function pickClaudeMode(mode: 'default' | 'acceptEdits' | 'bypassPermissions') {
  claudeMenuVisible.value = false
  if (mode === 'default') {
    onOpenInClaudeCode()
  } else {
    onOpenInClaudeCode(mode)
  }
}
// 关闭菜单（在选完菜单项、左键点击 trigger、或点击外部时调用）
function closeClaudeMenu() {
  if (claudeMenuVisible.value) claudeMenuVisible.value = false
}

// ── 更新已安装的工具 ─────────────────────────────────────────────
// 调 /api/update-tool,由服务端白名单决定实际命令(npm @latest / winget upgrade /
// brew upgrade / snap refresh / kimi 官方脚本重跑),前端只传固定 tool id。
// 更新会打开一个新终端窗口跑命令,所以先弹确认。
const updateRunning = ref(false)

// 更新菜单项的版本提示:本地版本 + registry 最新版本都有才显示。
// 两边相等 → 「已是最新 vX」;不等 → 「当前 vX → 最新 vY」;
// 任一边缺失(桌面应用/采集失败/网络失败)→ 返回空串,菜单显示原文案。
// fire-and-forget:菜单打开时触发查询,数据到了提示自然出现(响应式)。
function updateHint(tool: ToolId): string {
  const cur = toolsStore.versions[tool]
  const latest = toolsStore.latestVersions[tool]
  if (!cur || !latest) return ''
  return cur === latest
    ? $t('@67CE7:已是最新 v{ver}', { ver: cur })
    : $t('@67CE7:当前 v{cur} → 最新 v{latest}', { cur, latest })
}

async function onUpdateTool(tool: ToolId) {
  closeClaudeMenu()
  closeSimpleMenu()
  if (updateRunning.value) return
  try {
    await ElMessageBox.confirm(
      $t('@67CE7:将在新终端中执行 {tool} 的更新命令，命令来自服务端白名单，确认继续？', { tool: TOOL_DISPLAY_NAMES[tool] }),
      $t('@67CE7:更新 {tool}', { tool: TOOL_DISPLAY_NAMES[tool] }),
      {
        confirmButtonText: $t('@67CE7:确认更新'),
        cancelButtonText: $t('@67CE7:取消'),
        type: 'info',
        autofocus: false,
      },
    )
  } catch {
    return
  }

  updateRunning.value = true
  try {
    const response = await fetch('/api/update-tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool }),
    })
    const result = await response.json()
    if (!response.ok || !result.success) {
      throw new Error(result.error || $t('@67CE7:启动更新失败'))
    }
    ElMessage.success(result.message || $t('@67CE7:更新命令已在新终端中启动'))
  } catch (error) {
    ElMessage.error(`${$t('@67CE7:更新失败: ')}${(error as Error).message}`)
  } finally {
    updateRunning.value = false
  }
}

// ── simpleTools 的右键菜单 ───────────────────────────────────────
// 目前只含"更新"一项。与 claude 菜单同款 manual 模式(el-dropdown 在 el-tooltip
// 嵌套下 contextmenu 失效,见 claude 菜单处的注释)。已安装才有更新可言,
// 未安装仍走安装引导(openToolInstall)。
const simpleMenuTool = ref<SimpleTool | null>(null)
const simpleMenuVisible = ref(false)

async function onSimpleToolContextMenu(tool: SimpleTool) {
  if (!(await ensureToolsChecked())) {
    ElMessage.warning($t('@67CE7:工具检测失败，请稍后重试'))
    return
  }
  if (!toolsStore.isToolAvailable(tool.id)) {
    openToolInstall(tool.id)
    return
  }
  simpleMenuTool.value = tool
  void toolsStore.fetchLatestVersions() // 右键打开菜单时顺带查最新版(5 分钟缓存)
  simpleMenuVisible.value = !simpleMenuVisible.value
}

function closeSimpleMenu() {
  if (simpleMenuVisible.value) simpleMenuVisible.value = false
}

// manual trigger 下"点外面关闭"要自己挂 document 监听：
// - target 在 trigger 内 → 不关（避免和右键 toggle / 左键 click 冲突）
// - target 在 popover 内容内（teleport 到 body）→ 不关
// - 否则 → 关闭
// claude 菜单和"更多工具"菜单共用这一个监听，各自判断。
function onDocumentMouseDown(e: MouseEvent) {
  const target = e.target as Node | null
  if (!target) return

  if (claudeMenuVisible.value) {
    if (claudeTriggerRef.value && claudeTriggerRef.value.contains(target)) return
    const popoverEl = document.querySelector('.claude-menu-popover')
    if (popoverEl && popoverEl.contains(target)) return
    claudeMenuVisible.value = false
  }

  if (moreToolsVisible.value) {
    if (moreToolsTriggerRef.value && moreToolsTriggerRef.value.contains(target)) return
    const popoverEl = document.querySelector('.tools-more-popover')
    if (popoverEl && popoverEl.contains(target)) return
    moreToolsVisible.value = false
  }

  if (simpleMenuVisible.value) {
    // trigger 是被右键的那个工具按钮外层 span;popover 内容 teleport 到 body
    const popoverEl = document.querySelector('.simple-tool-menu-popover')
    if (popoverEl && popoverEl.contains(target)) return
    // 右键另一个工具时由 onSimpleToolContextMenu 自己 toggle,这里不抢
    simpleMenuVisible.value = false
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentMouseDown, true)
  // 监听全局事件:非 Git 仓库空态里的"打开其他目录"按钮通过这个事件弹出对话框,
  // 复用此处唯一的对话框实例,避免在 GitStatus.vue 再造一份。
  window.addEventListener('zen-gitsync:open-directory-dialog', onOpenDialog as EventListener)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentMouseDown, true)
  window.removeEventListener('zen-gitsync:open-directory-dialog', onOpenDialog as EventListener)
})

// 在终端中打开当前目录
async function onOpenTerminal() {
  if (warnIfEmptyDirectory()) return;
  toastOpenResult(
    await openPathInTerminal(currentDirectory.value),
    '@67CE7:已在终端中打开目录',
    '@67CE7:打开终端失败: ',
  );
}

// npm脚本检查已移至NpmScriptsPanel中，点击按钮时按需加载

// 常用目录的拉取 / 移除 / 复制 / 点击语义全部由 @components/RecentDirectoriesList.vue 承担
// (与"最近项目"共用同一组件、同一份 /api/recent_directories 数据、同一套卡片样式)

// 保存最近使用的目录
async function saveRecentDirectory(directory: string) {
  try {
    await fetch("/api/save_recent_directory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: directory }),
    });
  } catch (error) {
    console.error("保存最近目录失败:", error);
  }
}

// 切换目录
async function changeDirectory() {
  if (!newDirectoryPath.value) {
    ElMessage.warning($t('@67CE7:目录路径不能为空'));
    return;
  }
  try {
    isChangingDirectory.value = true;
    const response = await fetch("/api/change_directory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: newDirectoryPath.value }),
    });
    const result = await response.json();
    if (result.success) {
      ElMessage.success($t('@67CE7:已切换工作目录'));
      isDirectoryDialogVisible.value = false;
      await saveRecentDirectory(result.directory);

      // 立即清空文件列表和提交历史，避免显示旧目录的数据
      gitStore.log = [];
      gitStore.fileList = [];
      gitStore.status = {
        staged: [],
        unstaged: [],
        untracked: []
      };
      gitStore.currentPage = 1;
      gitStore.totalCommits = 0;
      

      // 直接更新 store 状态
      configStore.setCurrentDirectory(result.directory);
      gitStore.isGitRepo = result.isGitRepo;

      // 切换目录后强制重新加载配置
      await configStore.loadConfig(true);

      // 重新加载配置后 layout 已按当前项目挑选(layoutsByProject[cwd]),
      // 需要派发 ui-layout-reset 让 App.vue 把新的 ui.layout 写回 DOM(grid-template)。
      // App.vue 只在初始 mount 时调过一次 loadLayoutRatios,切项目不会自动重应用。
      window.dispatchEvent(new Event('ui-layout-reset'));
      
      if (result.isGitRepo) {
        // 并行加载基本信息
        // 切目录时强制刷分支状态(force=true),hasUpstream / upstreamBranch
        // / branchAhead / branchBehind 否则会保留上一个项目的脏值
        // (上次 getBranchStatus 调用缓存在 5s 内不会重拉,见 branchStatus.js)
        await Promise.all([
          gitStore.getCurrentBranch(),
          gitStore.getAllBranches(),
          gitStore.getUserInfo(),
          gitStore.getRemoteUrl(),
          gitStore.fetchRemotes(),
          gitStore.getBranchStatus(true)
        ]);
        
        // 并行加载提交历史和文件状态，避免串行导致的延迟
        Promise.all([
          gitStore.refreshLog(),
          gitStore.fetchStatus()
        ]);
      } else {
        // 切到非 Git 仓库目录不再弹 toast:左侧 GitStatus 面板会立刻切成
        // "当前目录不是 Git 仓库 + 初始化按钮"空态,顶栏再提示一次是重复噪音。
        gitStore.$reset();
        // $reset() 会连 userName / userEmail 一起清空(见 gitStore.ts:113-114),
        // 但 Git 用户信息是用户级/全局属性,不随目录变化。
        // 这里立刻重拉,否则切到非 Git 仓库目录后右上角会误报"未配置"。
        gitStore.getUserInfo();
      }
    } else {
      ElMessage.error(result.error || $t('@67CE7:切换目录失败'));
    }
  } catch (error) {
    ElMessage.error(`${$t('@67CE7:切换目录失败: ')}${(error as Error).message}`);
  } finally {
    isChangingDirectory.value = false;
  }
}

// 新开 cmd 标签并在目标路径执行 g ui
async function openNewTabGui() {
  if (!newDirectoryPath.value) {
    ElMessage.warning($t('@67CE7:目录路径不能为空'));
    return;
  }
  const result = await launchGuiInNewTab(newDirectoryPath.value);
  if (!result.success) {
    ElMessage.error(result.error || $t('@67CE7:打开失败'));
  }
}

// 常用目录卡片点击: 由 RecentDirectoriesList(mode="pick") 上抛 —— 把路径填进输入框。
// "Ctrl/Cmd+点击 = 新标签页打开"的判定在组件内部处理,这里只负责回填。
function onRecentDirSelect(dirPath: string) {
  newDirectoryPath.value = dirPath;
}

// 浏览目录
async function browseDirectory() {
  isBrowserDialogVisible.value = true;
}

// 目录浏览器选定回调
function onBrowserSelect(path: string) {
  newDirectoryPath.value = path;
}
</script>

<template>
<div id="directory-selector" class="directory-selector" :class="[`directory-selector--${props.variant}`, { 'directory-selector--not-git': gitStore.isGitRepo === false }]">
    <button
      type="button"
      class="directory-display"
      :title="$t('@67CE7:切换工作目录') + '\n' + currentDirectory"
      :aria-label="$t('@67CE7:切换工作目录: {path}', { path: currentDirectory })"
      @click="onOpenDialog"
      @contextmenu.prevent="onCopyDirectory"
    >
      {{ currentFolderName }}
    </button>
    <!-- 旧版"非 Git 仓库"红色徽章已移除:左侧 GitStatus 面板已经完整展示
         "当前目录不是 Git 仓库 + 初始化按钮 + 打开其他目录",顶栏重复出现
         反而挤占目录名空间、显得啰嗦。打开目录后让左侧面板统一兜底即可。 -->
    <div class="directory-actions flex">
      <IconButton
        :tooltip="$t('@67CE7:切换工作目录')"
        :aria-label="$t('@67CE7:切换工作目录')"
        size="large"
        @click="onOpenDialog"
      >
        <el-icon aria-hidden="true"><Folder /></el-icon>
      </IconButton>
      <IconButton
        :tooltip="$t('@67CE7:在资源管理器中打开')"
        :aria-label="$t('@67CE7:在资源管理器中打开')"
        size="large"
        @click="onOpenExplorer"
      >
        <el-icon aria-hidden="true"><FolderOpened /></el-icon>
      </IconButton>
      <IconButton
        :tooltip="$t('@67CE7:在终端中打开')"
        :aria-label="$t('@67CE7:在终端中打开')"
        size="large"
        @click="onOpenTerminal"
      >
        <el-icon aria-hidden="true"><Monitor /></el-icon>
      </IconButton>
      <!--
        编辑器 / AI 工具：已安装的常驻显示，未安装的收进右侧"更多"菜单。
        检测未完成时全部按 checking 态显示，避免首屏按钮位置跳来跳去。
        右键 = 工具操作菜单（当前只有"更新"）；与 claude 菜单同款 manual 模式。
      -->
      <template v-for="tool in visibleTools" :key="tool.id">
        <el-popover
          :visible="simpleMenuVisible && simpleMenuTool?.id === tool.id"
          :trigger="('manual' as any)"
          placement="bottom-end"
          :width="190"
          :show-arrow="false"
          popper-class="simple-tool-menu-popover"
        >
          <template #reference>
            <!-- span 包一层接管 contextmenu：IconButton 根是 el-tooltip，事件挂不住 -->
            <span
              class="simple-tool-trigger"
              @contextmenu.prevent.stop="onSimpleToolContextMenu(tool)"
            >
              <IconButton
                :tooltip="toolTooltip(tool.id, tool.label)"
                :aria-label="toolTooltip(tool.id, tool.label)"
                :custom-class="toolsStore.lastCheckedAt === null ? 'tool-button--checking' : (toolsStore.isToolAvailable(tool.id) ? '' : 'tool-button--missing')"
                size="large"
                @click="runOrInstall(tool.id, tool.action)"
              >
                <svg-icon :icon-class="tool.icon" />
              </IconButton>
            </span>
          </template>
          <ul class="claude-menu" role="menu" :aria-label="tool.name">
            <li
              class="claude-menu__item"
              role="menuitem"
              tabindex="-1"
              @click="onUpdateTool(tool.id)"
              @keydown.enter.prevent="onUpdateTool(tool.id)"
              @keydown.space.prevent="onUpdateTool(tool.id)"
            >
              <span class="claude-menu__label">{{ $t('@67CE7:更新 {tool}', { tool: tool.name }) }}</span>
              <span class="claude-menu__hint">{{ updateHint(tool.id) || $t('@67CE7:升级到最新版本') }}</span>
            </li>
          </ul>
        </el-popover>
      </template>
      <!--
        用 Claude Code 打开：左键 = 默认；右键 = 弹出菜单（默认 / 完全批准）。
        用 el-popover + manual trigger 自己接管右键事件，绕开 el-dropdown contextmenu
        在 IconButton(el-tooltip) 嵌套下的失效问题。
      -->
      <el-popover
        v-if="claudePinned"
        :visible="claudeMenuVisible"
        :trigger="('manual' as any)"
        placement="bottom-end"
        :width="220"
        :show-arrow="false"
        popper-class="claude-menu-popover"
      >
        <template #reference>
          <span
            ref="claudeTriggerRef"
            class="claude-code-trigger"
            @contextmenu.prevent.stop="onClaudeContextMenu"
          >
            <IconButton
              :tooltip="toolTooltip('claude', $t('@67CE7:用 Claude Code 打开（完全批准）'))"
              :aria-label="toolTooltip('claude', $t('@67CE7:用 Claude Code 打开（完全批准）'))"
              :custom-class="toolsStore.lastCheckedAt === null ? 'tool-button--checking' : (toolsStore.claudeAvailable ? '' : 'tool-button--missing')"
              size="large"
              @click="onClaudePrimaryClick"
            >
              <img
                :src="claudeCodeIcon"
                :alt="$t('@67CE7:Claude Code')"
                class="claude-code-btn__icon"
              />
            </IconButton>
          </span>
        </template>
        <ul class="claude-menu" role="menu" :aria-label="$t('@67CE7:Claude Code 启动模式')">
          <li
            class="claude-menu__item"
            role="menuitem"
            tabindex="-1"
            @click="pickClaudeMode('default')"
            @keydown.enter.prevent="pickClaudeMode('default')"
            @keydown.space.prevent="pickClaudeMode('default')"
          >
            <span class="claude-menu__label">{{ $t('@67CE7:用 Claude Code 打开') }}</span>
            <span class="claude-menu__hint">{{ $t('@67CE7:默认权限') }}</span>
          </li>
          <li
            class="claude-menu__item claude-menu__item--accent"
            role="menuitem"
            tabindex="-1"
            @click="pickClaudeMode('acceptEdits')"
            @keydown.enter.prevent="pickClaudeMode('acceptEdits')"
            @keydown.space.prevent="pickClaudeMode('acceptEdits')"
          >
            <span class="claude-menu__label">{{ $t('@67CE7:用 Claude Code 打开') }}</span>
            <span class="claude-menu__hint">批准文件编辑</span>
          </li>
          <li
            class="claude-menu__item claude-menu__item--danger"
            role="menuitem"
            @click="pickClaudeMode('bypassPermissions')"
          >
            <span class="claude-menu__label">
              用 Claude Code 打开
              <el-icon class="claude-menu__warn"><Warning /></el-icon>
            </span>
            <span class="claude-menu__hint">真·完全批准（含 Shell）</span>
          </li>
          <li class="claude-menu__sep" role="separator" />
          <li
            class="claude-menu__item"
            role="menuitem"
            tabindex="-1"
            :aria-disabled="updateRunning"
            @click="onUpdateTool('claude')"
            @keydown.enter.prevent="onUpdateTool('claude')"
            @keydown.space.prevent="onUpdateTool('claude')"
          >
            <span class="claude-menu__label">{{ $t('@67CE7:更新 {tool}', { tool: TOOL_DISPLAY_NAMES.claude }) }}</span>
            <span class="claude-menu__hint">{{ updateHint('claude') || $t('@67CE7:升级到最新版本') }}</span>
          </li>
        </ul>
      </el-popover>
      <!--
        未安装的工具收起在这里：点击展开菜单列出，点某一项走 runOrInstall
        （已装就直接打开，没装就弹安装引导）。
      -->
      <el-popover
        v-if="hasMissingTools"
        :visible="moreToolsVisible"
        :trigger="('manual' as any)"
        placement="bottom-end"
        :width="240"
        :show-arrow="false"
        popper-class="tools-more-popover"
      >
        <template #reference>
          <!-- span 包一层接管 click：IconButton 根是 el-tooltip，不能直接当 popover reference -->
          <span
            ref="moreToolsTriggerRef"
            class="tools-more-trigger"
            @click.prevent.stop="toggleMoreTools"
          >
            <IconButton
              :tooltip="moreToolsVisible ? $t('@67CE7:收起未安装的工具') : $t('@67CE7:展开未安装的工具')"
              :aria-label="moreToolsVisible ? $t('@67CE7:收起未安装的工具') : $t('@67CE7:展开未安装的工具')"
              :active="moreToolsVisible"
              :pressed="moreToolsVisible"
              custom-class="tool-button--more"
              size="large"
            >
              <span class="tools-more__btn">
                <el-icon aria-hidden="true" class="tools-more__arrow">
                  <ArrowUp v-if="moreToolsVisible" />
                  <ArrowDown v-else />
                </el-icon>
              </span>
            </IconButton>
          </span>
        </template>
        <div class="tools-more">
          <div class="tools-more__title">{{ $t('@67CE7:未安装的工具') }}</div>
          <ul class="tools-more__list" role="menu" :aria-label="$t('@67CE7:未安装的工具')">
            <li
              v-for="tool in missingTools"
              :key="tool.id"
              class="tools-more__item"
              role="menuitem"
              tabindex="-1"
              @click="runMissingTool(tool)"
              @keydown.enter.prevent="runMissingTool(tool)"
              @keydown.space.prevent="runMissingTool(tool)"
            >
              <span class="tools-more__icon">
                <img
                  v-if="tool.id === 'claude'"
                  :src="claudeCodeIcon"
                  :alt="tool.name"
                  class="tools-more__claude-icon"
                />
                <svg-icon v-else :icon-class="tool.icon ?? ''" />
              </span>
              <span class="tools-more__label">{{ tool.name }}</span>
              <span class="tools-more__hint">{{ $t('@67CE7:未安装') }}</span>
            </li>
          </ul>
        </div>
      </el-popover>
    </div>
  </div>

  <ToolInstallDialog
    v-model="installDialogVisible"
    :tool="selectedInstallTool"
  />

  <!-- 切换目录对话框 -->
  <CommonDialog
    v-model="isDirectoryDialogVisible"
    :title="$t('@67CE7:切换工作目录')"
    width="min(1040px, 90vw)"
    type="flex"
    top="20px"
    height-offset="32px"
    :destroy-on-close="true"
    :append-to-body="true"
    custom-class="directory-dialog"
  >
    <div class="directory-content">
      <el-form label-position="top">
        <el-form-item>
          <template #label>
            <div class="form-label">
              <el-icon class="label-icon"><Folder /></el-icon>
              <span>{{ $t('@67CE7:目录路径') }}</span>
            </div>
          </template>
          <div class="directory-input-group">
            <el-input
              v-model="newDirectoryPath"
              :placeholder="$t('@67CE7:请输入目录路径')"
              class="modern-input"
              size="large"
            />
            <button type="button" class="browse-btn" @click="browseDirectory">
              <el-icon><Folder /></el-icon>
              <span>{{ $t('@67CE7:浏览') }}</span>
            </button>
          </div>
        </el-form-item>
        <!-- 常用目录:与"最近项目"同一个组件、同一份数据、同一套卡片样式。
             mode="pick"   → 普通点击把路径回填到上面的输入框,Ctrl/Cmd+点击在新标签页打开
             variant="bare" → 不渲染面板外壳(标题由本表单项 label 提供)
             .form-item--dirs 让这一项吃掉弹窗剩余高度,由列表内部滚动 -->
        <el-form-item class="form-item--dirs">
          <template #label>
            <div class="form-label">
              <el-icon class="label-icon"><Clock /></el-icon>
              <span>{{ $t('@67CE7:常用目录') }}</span>
              <span class="label-count">{{ $t('@67CE7:共 {count} 个', { count: recentDirsCount }) }}</span>
            </div>
          </template>
          <RecentDirectoriesList
            ref="recentDirsListRef"
            class="recent-dirs-list"
            mode="pick"
            variant="bare"
            removable="always"
            :remove-label="$t('@67CE7:从常用目录中移除')"
            :empty-text="$t('@67CE7:暂无常用目录')"
            :aria-label="$t('@67CE7:常用目录')"
            @select="onRecentDirSelect"
            @loaded="(n: number) => (recentDirsCount = n)"
          />
        </el-form-item>
      </el-form>
    </div>
    <template #footer>
      <div class="dialog-footer">
        <div class="footer-actions">
          <button
            type="button"
            class="dialog-cancel-btn"
            @click="isDirectoryDialogVisible = false"
          >
            {{ $t('@67CE7:取消') }}
          </button>
          <button
            type="button"
            class="dialog-confirm-btn"
            @click="changeDirectory()"
            :disabled="isChangingDirectory"
          >
            <el-icon v-if="!isChangingDirectory"><Folder /></el-icon>
            <el-icon class="is-loading" v-else>
              <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
                <path
                  fill="currentColor"
                  d="M512 64a32 32 0 0 1 32 32v192a32 32 0 0 1-64 0V96a32 32 0 0 1 32-32zm0 640a32 32 0 0 1 32 32v192a32 32 0 1 1-64 0V736a32 32 0 0 1 32-32zm448-192a32 32 0 0 1-32 32H736a32 32 0 1 1 0-64h192a32 32 0 0 1 32 32zm-640 0a32 32 0 0 1-32 32H96a32 32 0 0 1 0-64h192a32 32 0 0 1 32 32z"
                />
              </svg>
            </el-icon>
            <span>{{ $t('@67CE7:切换') }}</span>
          </button>
          <button
            type="button"
            class="dialog-newtab-btn"
            @click="openNewTabGui()"
          >
            <span>{{ $t('@67CE7:使用新标签打开') }}</span>
          </button>
        </div>
      </div>
    </template>
  </CommonDialog>

  <!-- 目录浏览器弹窗 -->
  <FilePicker
    :visible="isBrowserDialogVisible"
    mode="directory"
    :theme="isDark ? 'dark' : 'light'"
    :locale="currentLocale"
    @close="isBrowserDialogVisible = false"
    @confirm="(paths: string[]) => { onBrowserSelect(paths[0]); isBrowserDialogVisible = false }"
  />
</template>

<style scoped>
.directory-selector {
  width: 100%;
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  border-radius: var(--radius-md);
  padding: 0px;
  gap: 10px;
  /* border: 1px solid var(--border-component);
  box-shadow: var(--shadow-sm); */
  flex-shrink: 0;
  transition: all 0.2s ease;
}

.directory-selector:hover {
  background: var(--border-component);
}

.directory-selector--header {
  padding: 4px 10px;
  border-radius: 14px;
  border: 1px solid rgba(59, 130, 246, 0.16);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.98) 0%, rgba(248, 250, 252, 1) 100%);
  box-shadow:
    0 14px 34px rgba(15, 23, 42, 0.14),
    0 4px 12px rgba(15, 23, 42, 0.08),
    0 0 0 1px rgba(255, 255, 255, 0.75) inset;
}

.directory-selector--header:hover {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.96) 0%, rgba(241, 245, 249, 1) 100%);
  box-shadow:
    0 16px 38px rgba(15, 23, 42, 0.16),
    0 6px 14px rgba(15, 23, 42, 0.1),
    0 0 0 1px rgba(255, 255, 255, 0.82) inset,
    0 0 0 3px rgba(59, 130, 246, 0.08);
}

.directory-selector--header .directory-display {
  font-size: 18px;
}

.directory-selector--header .directory-actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  padding-left: 8px;
}

[data-theme="dark"] .directory-selector--header {
  background: linear-gradient(180deg, rgba(28, 33, 48, 0.92) 0%, rgba(22, 27, 40, 0.96) 100%);
  border-color: rgba(147, 197, 253, 0.12);
  box-shadow:
    0 16px 36px rgba(0, 0, 0, 0.34),
    0 6px 14px rgba(0, 0, 0, 0.24),
    0 0 0 1px rgba(255, 255, 255, 0.03) inset;
}

[data-theme="dark"] .directory-selector--header:hover {
  background: linear-gradient(180deg, rgba(33, 39, 56, 0.96) 0%, rgba(24, 29, 44, 0.98) 100%);
  box-shadow:
    0 18px 42px rgba(0, 0, 0, 0.4),
    0 8px 16px rgba(0, 0, 0, 0.28),
    0 0 0 1px rgba(255, 255, 255, 0.04) inset,
    0 0 0 3px rgba(96, 165, 250, 0.08);
}

.directory-display {
  flex: 1;
  min-width: 0;
  padding-left: var(--spacing-base);
  font-family: 'Plus Jakarta Sans', sans-serif;
  font-size: var(--font-size-2xl);
  font-weight: 600;
  letter-spacing: var(--letter-spacing-tight, -0.4px);
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  border-radius: 6px;
  padding: 2px 8px;
  transition: background 0.15s, color 0.15s;
  /* 按钮重置:继承 div 视觉,但移除浏览器默认样式 */
  border: none;
  background: transparent;
  text-align: left;
  appearance: none;
}

.directory-display:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.directory-display:hover {
  background: rgba(59, 130, 246, 0.1);
  color: var(--color-primary, #3b82f6);
}

[data-theme="dark"] .directory-display:hover {
  background: rgba(96, 165, 250, 0.12);
  color: #60a5fa;
}

/* 旧版 "当前目录不是Git仓库" 状态徽章样式已随 UI 调整移除(左侧 GitStatus 面板兜底) */

.claude-code-btn__icon {
  width: 22px;
  height: 22px;
  display: block;
  object-fit: contain;
  flex-shrink: 0;
  -webkit-user-drag: none;
}

/* 右键菜单触发器：包裹 IconButton，统一处理 contextmenu */
.claude-code-trigger {
  display: inline-flex;
  align-items: center;
}

/* 右键弹出的菜单（el-popover 内容） */
.claude-menu {
  margin: 0;
  padding: 4px 0;
  list-style: none;
  font-size: var(--font-size-sm, 13px);
  color: var(--text-primary);
}

/* 「打开模式」与「更新」之间的分隔线 */
.claude-menu__sep {
  height: 1px;
  margin: 4px 8px;
  background: var(--border-color-light, var(--border-color));
}

.claude-menu__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.15s ease;
}

.claude-menu__item:hover {
  background-color: rgba(64, 158, 255, 0.12);
}

.claude-menu__item:active {
  background-color: rgba(64, 158, 255, 0.2);
}

.claude-menu__label {
  font-weight: 500;
  color: var(--text-primary);
}

.claude-menu__hint {
  font-size: 11px;
  color: var(--text-secondary);
  letter-spacing: 0.2px;
}

.claude-menu__item--accent .claude-menu__hint {
  color: var(--color-primary, #409eff);
  font-weight: 600;
}

.claude-menu__item--danger .claude-menu__label {
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 6px;
}

.claude-menu__warn {
  color: #e6a23c;
  font-size: 13px;
  vertical-align: middle;
}

.claude-menu__item--danger .claude-menu__hint {
  color: #e6a23c;
  font-weight: 600;
}

/* ── "更多"菜单：收起未安装的工具 ──────────────────────────────────── */

/* 触发器容器：包住 IconButton，自己接管 click（见上面 template 的注释） */
.tools-more-trigger {
  display: inline-flex;
  align-items: center;
}

/* 箭头图标比其它工具图标小一档：Element Plus 的 ArrowDown 是实心粗箭头，
   按 large 的 22px 渲染会明显压过旁边的 svg-icon，缩到 18px 视觉才齐平 */
:deep(.tool-button--more) .tools-more__arrow {
  font-size: 18px;
  transition: transform 0.18s ease, color 0.18s ease;
}

/* 菜单展开时箭头轻微上挑，给出"已展开"的额外反馈 */
:deep(.tool-button--more.is-active) .tools-more__arrow {
  transform: translateY(-1px);
}

.tools-more {
  padding: 2px 0;
}

.tools-more__title {
  padding: 4px 12px 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: var(--text-tertiary);
  text-transform: uppercase;
}

.tools-more__list {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--font-size-sm, 13px);
  color: var(--text-primary);
}

.tools-more__item {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 4px;
  padding: 7px 10px;
  border-radius: var(--btn-radius-sm, 6px);
  cursor: pointer;
  user-select: none;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.tools-more__item:hover,
.tools-more__item:focus-visible {
  background-color: rgba(64, 158, 255, 0.12);
  outline: none;
}

.tools-more__item:focus-visible {
  box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.3);
}

.tools-more__item:active {
  background-color: rgba(64, 158, 255, 0.2);
}

.tools-more__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  /* 未安装的工具统一降饱和度，和常驻按钮的 missing 态视觉一致；
     hover 时恢复，暗示"可以点它去安装" */
  opacity: 0.55;
  filter: grayscale(0.65);
  transition: opacity 0.15s ease, filter 0.15s ease;
}

.tools-more__item:hover .tools-more__icon,
.tools-more__item:focus-visible .tools-more__icon {
  opacity: 1;
  filter: grayscale(0);
}

.tools-more__icon :deep(svg) {
  width: 18px;
  height: 18px;
}

.tools-more__claude-icon {
  width: 18px;
  height: 18px;
  object-fit: contain;
  -webkit-user-drag: none;
}

.tools-more__label {
  flex: 1;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tools-more__hint {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-tertiary);
  transition: color 0.15s ease;
}

/* hover 时右侧提示变主色，从"状态描述"变成"可执行的动作" */
.tools-more__item:hover .tools-more__hint,
.tools-more__item:focus-visible .tools-more__hint {
  color: var(--color-primary, #409eff);
}

/* 对话框样式（复用 App.vue 中样式） */
.directory-content {
  padding: var(--spacing-base) 0;
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

.directory-input-group {
  width: 100%;
  display: flex;
  gap: var(--spacing-base);
  align-items: stretch;
}

.directory-input-group .modern-input {
  flex: 1;
}

.browse-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 var(--spacing-lg);
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-primary);
  font-size: var(--font-size-sm);
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
  min-height: 40px;
}

.browse-btn:hover {
  background: rgba(59, 130, 246, 0.08);
}

.browse-btn:active {
  background: rgba(59, 130, 246, 0.15);
}

/* 常用目录列表(RecentDirectoriesList)在弹窗里贴着 form-item 左侧排布,
   卡片样式由组件自己负责,这里只负责"高度链":
   el-dialog__body(flex) → .directory-content → el-form → .form-item--dirs → 列表,
   逐层 flex:1 + min-height:0,让列表吃掉弹窗剩余高度,只有列表内部滚动
   (路径输入框和底部按钮始终可见,不会被长列表顶出视口) */
.recent-dirs-list {
  width: 100%;
}
.directory-content {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.directory-content :deep(.el-form) {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
/* 路径那一项的默认下边距(18px)在矮窗口下太浪费,收紧一点把高度让给列表 */
.directory-content :deep(.el-form-item:first-child) {
  margin-bottom: var(--spacing-sm);
}
/* label 在上、内容在下,内容再撑满剩余空间 */
.directory-content :deep(.form-item--dirs) {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  margin-bottom: 0;
}
.directory-content :deep(.form-item--dirs .el-form-item__content) {
  flex: 1;
  min-height: 0;
  min-width: 0;
  /* 关键:Element Plus 的 content 默认是横向 flex(row + wrap + align-items:center),
     子项高度会按内容撑开而不是被约束。必须改成纵向才吃得住剩余高度,
     否则列表会顶破弹窗 body 造成二级滚动条 */
  flex-direction: column;
  flex-wrap: nowrap;
  align-items: stretch;
}
/* label 右侧的总数提示(列表会滚动,标出总数避免"看到几个就以为只有几个") */
.form-label .label-count {
  margin-left: var(--spacing-base);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-normal);
  color: var(--text-tertiary);
}

/* dialog-footer、footer-actions、dialog-cancel-btn、dialog-confirm-btn 基础样式已移至 @/styles/common.scss */

/* 未安装的工具仍保持可点击，仅降低饱和度并用小圆点提示“需要安装”。 */
:deep(.tool-button--missing) {
  position: relative;
  opacity: 0.52;
  filter: grayscale(0.65);
}

:deep(.tool-button--missing::after) {
  content: '';
  position: absolute;
  right: 5px;
  bottom: 5px;
  width: 5px;
  height: 5px;
  border: 1px solid var(--bg-container);
  border-radius: 50%;
  background: var(--el-color-warning);
}

:deep(.tool-button--missing:hover) {
  opacity: 0.85;
  filter: grayscale(0.2);
}

:deep(.tool-button--checking) {
  opacity: 0.68;
  animation: tool-checking-pulse 1.2s ease-in-out infinite alternate;
}

@keyframes tool-checking-pulse {
  from { opacity: 0.45; }
  to { opacity: 0.82; }
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
</style>

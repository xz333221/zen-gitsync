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
<!--
  「打开方式」菜单的**内容**（文件管理器 / 终端 / 新标签页跑 g ui / 复制名称与路径 /
  各编辑器与 AI 工具的权限档）。

  为什么要单独成组件：这份菜单现在有两个宿主 ——
    · 工作台左栏「项目列表」里 hover 才出现的那颗「…」按钮（WorkbenchProjectPanel）；
    · 「项目管理」视图里每一行的同一个入口。
  菜单项只有一份，就不会出现"工作台里有某档、管理视图里没有"这种漂移（与
  useDirectoryOpenActions 抽出来的理由同源）。

  ⚠️ 这里**只管菜单内容**，不管怎么弹出：
    · el-popover 的 reference 按钮、`openMenuKey` 显隐、点外面关闭全在宿主里
      （两边的触发形态本来就不一样：工作台是 hover 出按钮，管理视图是常驻按钮）；
    · 宿主在 popover 里 `v-if="打开的那一行"` 挂本组件，所以同时只会存在一份菜单。
  任何动作执行完都 emit('done')，宿主据此关掉 popover —— 自己关自己没有意义
  （popover 的 visible 是宿主受控的）。

  DOM 与 class 名（.proj-menu / .proj-menu__item / .proj-menu__title / .proj-menu__sep…）
  是**探针契约**（verify-copy-folder-name / verify-open-with-permission-menus 盯着它们），
  改造时不要改名。
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { CopyDocument, FolderOpened, Monitor, Promotion } from '@element-plus/icons-vue'
import SvgIcon from '@components/SvgIcon/index.vue'
import ToolInstallDialog from '@components/ToolInstallDialog.vue'
import claudeCodeIcon from '@/assets/icons/svg/claudecode-color.svg'
import { $t } from '@/lang/static'
import { useToolsStore, type ToolId } from '@/stores/toolsStore'
import { useOpenWithTool } from '@/composables/useOpenWithTool'
import {
  DARK_TILE_ICON_IDS,
  DESKTOP_APP_TOOL_IDS,
  OPEN_WITH_TOOLS,
  TOOL_DISPLAY_NAMES,
  desktopAppHint,
  desktopAppLabel,
  launchGuiInNewTab,
  openDesktopApp,
  openPathInFileManager,
  openPathInTerminal,
} from '@/composables/useDirectoryOpenActions'

const props = defineProps<{
  /** 项目目录（打开 / 复制的目标） */
  path: string
  /** 项目名（「复制文件夹名称」复制的是它，也就是目录的最后一级） */
  name: string
}>()

/** 任何一个动作执行后通知宿主关闭菜单 */
const emit = defineEmits<{ done: [] }>()

// 「打开方式」的判定与请求走公共 composable（工具快捷条也用同一份）
const { toolMissing, tryOpenWithTool } = useOpenWithTool()
const toolsStore = useToolsStore()
const installVisible = ref(false)
const installTool = ref<ToolId | null>(null)

/**
 * 有官方桌面端、且本机桌面应用状态已知的工具（claude / codex / opencode /
 * codebuddy / kimi / dsh 里 desktopAppOf 有返回值的）。图标沿用该工具在
 * OPEN_WITH_TOOLS 里那颗；claude 不在那张表里（它有权限档、单独排布），
 * 模板里用 img 特例。
 */
const desktopTools = computed(() =>
  DESKTOP_APP_TOOL_IDS.filter((id) => toolsStore.desktopAppOf(id)).map((id) => ({
    id,
    name: TOOL_DISPLAY_NAMES[id],
    icon: OPEN_WITH_TOOLS.find((t) => t.id === id)?.icon ?? '',
  })),
)

/**
 * 「打开 / 下载 X 桌面端」：桌面应用装了 → 一键启动；没装 → 跳官网下载页。
 * 与顶栏右键菜单那项同一份判定（desktopAppOf）与同一个启动端点，别在这里另写。
 */
async function openOrDownloadDesktop(tool: ToolId) {
  const info = toolsStore.desktopAppOf(tool)
  if (!info) return
  emit('done')
  if (!info.installed) {
    window.open(info.downloadUrl, '_blank', 'noopener,noreferrer')
    return
  }
  const r = await openDesktopApp(tool)
  if (r.success) ElMessage.success(r.message || $t('@67CE7:已打开 {app}', { app: info.name }))
  else ElMessage.error(r.error || $t('@WORKBENCH:打开桌面端失败'))
}

/** 在系统文件管理器里打开项目目录 */
async function openInFileManager() {
  emit('done')
  const r = await openPathInFileManager(props.path)
  if (r.success) ElMessage.success(r.message || $t('@WORKBENCH:已在文件管理器中打开文件夹'))
  else ElMessage.error(r.error || $t('@WORKBENCH:打开文件夹失败'))
}

/** 在系统终端里打开项目目录 */
async function openInTerminal() {
  emit('done')
  const r = await openPathInTerminal(props.path)
  if (r.success) ElMessage.success(r.message || $t('@67CE7:已在终端中打开目录'))
  else ElMessage.error(r.error || $t('@WORKBENCH:打开终端失败'))
}

/**
 * 新开一个终端标签页，在这个项目目录里执行 `g ui`。
 * 服务端会剥掉 PORT 再启动，子进程自己挑空闲端口，不会和当前实例抢。
 */
async function launchGui() {
  emit('done')
  const r = await launchGuiInNewTab(props.path)
  if (r.success) ElMessage.success($t('@WORKBENCH:已在新标签页启动 g ui'))
  else ElMessage.error(r.error || $t('@WORKBENCH:启动 g ui 失败'))
}

/**
 * 复制项目**文件夹名称**（只有最后一级目录名，不是完整路径）。
 * 顶栏目录选择器有同一个入口（同一个 i18n key、同一句成功提示）：
 * 拿目录名去建同名目录 / 当文件名 / 写文档标题比粘一条绝对路径更常用。
 */
async function copyFolderName() {
  emit('done')
  if (!props.name) return
  try {
    await navigator.clipboard.writeText(props.name)
    ElMessage.success($t('@67CE7:已复制文件夹名称'))
  } catch {
    ElMessage.error($t('@67CE7:复制失败'))
  }
}

/**
 * 复制项目**文件夹路径**（完整绝对路径，粘进终端 `cd` 用）。
 * 与上面的「复制文件夹名称」成对：名称用于建同名目录 / 当文件名，
 * 路径用于 cd / 喂给命令行工具。成功提示另起一句，别和名称的混。
 */
async function copyFolderPath() {
  emit('done')
  if (!props.path) return
  try {
    await navigator.clipboard.writeText(props.path)
    ElMessage.success($t('@67CE7:已复制文件夹路径'))
  } catch {
    ElMessage.error($t('@67CE7:复制失败'))
  }
}

/**
 * 用某个编辑器 / AI 工具打开项目目录。
 * 没装的走安装引导（和顶栏一致）：这里不直接打开，因为命令必然失败，
 * 而"为什么失败"用户只有看到安装方式才解决得了。
 *
 * ⚠️ 「没装」这条分支**不能**先 emit('done')：宿主收到就把菜单关掉，而菜单内容是
 * `v-if` 挂的 —— 组件一卸载，下面这个安装弹窗连渲染的机会都没有（它的 state 在组件里）。
 * 这条路径曾经因此整个失效（探针 P7d 抓到的就是它）。打开 / 失败两条分支照旧立刻关菜单。
 */
async function openWithTool(tool: ToolId, permissionMode?: string) {
  const status = await tryOpenWithTool(tool, props.path, permissionMode)
  if (status === 'install') {
    installTool.value = tool
    installVisible.value = true
    return
  }
  emit('done')
}
</script>

<template>
  <ul class="proj-menu" role="menu" :aria-label="$t('@WORKBENCH:打开方式')">
    <li
      class="proj-menu__item"
      role="menuitem"
      tabindex="-1"
      @click="openInFileManager"
      @keydown.enter.prevent="openInFileManager"
      @keydown.space.prevent="openInFileManager"
    >
      <span class="proj-menu__icon"><el-icon aria-hidden="true"><FolderOpened /></el-icon></span>
      <span class="proj-menu__label">{{ $t('@WORKBENCH:在文件管理器中打开') }}</span>
    </li>
    <li
      class="proj-menu__item"
      role="menuitem"
      tabindex="-1"
      @click="openInTerminal"
      @keydown.enter.prevent="openInTerminal"
      @keydown.space.prevent="openInTerminal"
    >
      <span class="proj-menu__icon"><el-icon aria-hidden="true"><Monitor /></el-icon></span>
      <span class="proj-menu__label">{{ $t('@WORKBENCH:在终端中打开') }}</span>
    </li>
    <li
      class="proj-menu__item"
      role="menuitem"
      tabindex="-1"
      @click="launchGui"
      @keydown.enter.prevent="launchGui"
      @keydown.space.prevent="launchGui"
    >
      <span class="proj-menu__icon"><el-icon aria-hidden="true"><Promotion /></el-icon></span>
      <span class="proj-menu__label">{{ $t('@WORKBENCH:在新标签页启动 g ui') }}</span>
    </li>
    <!-- 复制文件夹名称：放在"打开"这一组里，因为它操作的是项目目录本身，
         而不是"用哪个工具打开"（下面那组有独立标题）。 -->
    <li
      class="proj-menu__item"
      role="menuitem"
      tabindex="-1"
      @click="copyFolderName"
      @keydown.enter.prevent="copyFolderName"
      @keydown.space.prevent="copyFolderName"
    >
      <span class="proj-menu__icon"><el-icon aria-hidden="true"><CopyDocument /></el-icon></span>
      <span class="proj-menu__label">{{ $t('@67CE7:复制文件夹名称') }}</span>
    </li>
    <!-- 复制文件夹路径：与名称成对（名称=最后一级目录名，路径=完整绝对路径，
         粘进终端 cd 用）。同属"操作目录本身"的一组，排在名称下面。 -->
    <li
      class="proj-menu__item"
      role="menuitem"
      tabindex="-1"
      @click="copyFolderPath"
      @keydown.enter.prevent="copyFolderPath"
      @keydown.space.prevent="copyFolderPath"
    >
      <span class="proj-menu__icon"><el-icon aria-hidden="true"><CopyDocument /></el-icon></span>
      <span class="proj-menu__label">{{ $t('@67CE7:复制文件夹路径') }}</span>
    </li>

    <li class="proj-menu__sep" role="separator" />
    <li class="proj-menu__title" role="presentation">{{ $t('@WORKBENCH:用工具打开') }}</li>

    <li
      v-for="tool in OPEN_WITH_TOOLS"
      :key="tool.id"
      class="proj-menu__item"
      :class="{ 'is-missing': toolMissing(tool.id) }"
      role="menuitem"
      tabindex="-1"
      @click="openWithTool(tool.id)"
      @keydown.enter.prevent="openWithTool(tool.id)"
      @keydown.space.prevent="openWithTool(tool.id)"
    >
      <span class="proj-menu__icon"><svg-icon :icon-class="tool.icon" :class="{ 'icon-invert-dark': tool.id === 'codex', 'icon-outline-dark': DARK_TILE_ICON_IDS.has(tool.id) }" /></span>
      <span class="proj-menu__label">{{ $t(tool.labelKey) }}</span>
      <span v-if="toolMissing(tool.id)" class="proj-menu__hint">{{ $t('@67CE7:未安装') }}</span>
    </li>

    <!-- claude 有两种权限模式，不混进上面的工具列表（顶栏也是单独排布的） -->
    <li
      class="proj-menu__item"
      :class="{ 'is-missing': toolMissing('claude') }"
      role="menuitem"
      tabindex="-1"
      @click="openWithTool('claude')"
      @keydown.enter.prevent="openWithTool('claude')"
      @keydown.space.prevent="openWithTool('claude')"
    >
      <span class="proj-menu__icon">
        <img :src="claudeCodeIcon" alt="" class="proj-menu__img" />
      </span>
      <span class="proj-menu__label">{{ $t('@67CE7:用 Claude Code 打开') }}</span>
      <span class="proj-menu__hint">
        {{ toolMissing('claude') ? $t('@67CE7:未安装') : $t('@67CE7:默认权限') }}
      </span>
    </li>
    <li
      class="proj-menu__item proj-menu__item--danger"
      :class="{ 'is-missing': toolMissing('claude') }"
      role="menuitem"
      tabindex="-1"
      @click="openWithTool('claude', 'bypassPermissions')"
      @keydown.enter.prevent="openWithTool('claude', 'bypassPermissions')"
      @keydown.space.prevent="openWithTool('claude', 'bypassPermissions')"
    >
      <span class="proj-menu__icon">
        <img :src="claudeCodeIcon" alt="" class="proj-menu__img" />
      </span>
      <span class="proj-menu__label">{{ $t('@67CE7:用 Claude Code 打开（完全批准）') }}</span>
    </li>

    <!-- opencode 的「完全批准」（`--auto`）与 claude 的 bypass 档并列收在末尾：
         它带警示色，混进上面的普通工具列表会把"一行一个工具"的节奏打乱，
         而它又确实得单独成项（默认档已经在上面那条 v-for 里了）。 -->
    <li
      class="proj-menu__item proj-menu__item--danger"
      :class="{ 'is-missing': toolMissing('opencode') }"
      role="menuitem"
      tabindex="-1"
      @click="openWithTool('opencode', 'auto')"
      @keydown.enter.prevent="openWithTool('opencode', 'auto')"
      @keydown.space.prevent="openWithTool('opencode', 'auto')"
    >
      <span class="proj-menu__icon"><svg-icon icon-class="opencode" /></span>
      <span class="proj-menu__label">{{ $t('@67CE7:用 OpenCode 打开（完全批准）') }}</span>
    </li>

    <!-- codex 天然有三档（默认档已在上面那条 v-for 里）：自动批准但仍有沙箱 →
         免批准 + 免沙箱。两档都单独成项，理由同 claude / opencode 那两项。 -->
    <li
      class="proj-menu__item"
      :class="{ 'is-missing': toolMissing('codex') }"
      role="menuitem"
      tabindex="-1"
      @click="openWithTool('codex', 'sandboxed')"
      @keydown.enter.prevent="openWithTool('codex', 'sandboxed')"
      @keydown.space.prevent="openWithTool('codex', 'sandboxed')"
    >
      <span class="proj-menu__icon"><svg-icon icon-class="codex" class="icon-invert-dark" /></span>
      <span class="proj-menu__label">{{ $t('@67CE7:用 Codex 打开（自动批准）') }}</span>
      <span v-if="!toolMissing('codex')" class="proj-menu__hint">{{ $t('@67CE7:沙箱内') }}</span>
      <span v-else class="proj-menu__hint">{{ $t('@67CE7:未安装') }}</span>
    </li>
    <li
      class="proj-menu__item proj-menu__item--danger"
      :class="{ 'is-missing': toolMissing('codex') }"
      role="menuitem"
      tabindex="-1"
      @click="openWithTool('codex', 'bypass')"
      @keydown.enter.prevent="openWithTool('codex', 'bypass')"
      @keydown.space.prevent="openWithTool('codex', 'bypass')"
    >
      <span class="proj-menu__icon"><svg-icon icon-class="codex" class="icon-invert-dark" /></span>
      <span class="proj-menu__label">{{ $t('@67CE7:用 Codex 打开（完全批准）') }}</span>
    </li>

    <!-- codebuddy / kimi 的「完全批准」档（默认档已在上面那条 v-for 里）。
         token 与服务端 buildCodebuddyArgs / buildKimiArgs 对齐：
           codebuddy 'bypassPermissions' → `--permission-mode bypassPermissions`
           kimi      'auto'              → `--auto`（Never Ask：从不打断） -->
    <li
      class="proj-menu__item proj-menu__item--danger"
      :class="{ 'is-missing': toolMissing('codebuddy') }"
      role="menuitem"
      tabindex="-1"
      @click="openWithTool('codebuddy', 'bypassPermissions')"
      @keydown.enter.prevent="openWithTool('codebuddy', 'bypassPermissions')"
      @keydown.space.prevent="openWithTool('codebuddy', 'bypassPermissions')"
    >
      <span class="proj-menu__icon"><svg-icon icon-class="codebuddy" /></span>
      <span class="proj-menu__label">{{ $t('@67CE7:用 CodeBuddy Code 打开（完全批准）') }}</span>
    </li>
    <li
      class="proj-menu__item proj-menu__item--danger"
      :class="{ 'is-missing': toolMissing('kimi') }"
      role="menuitem"
      tabindex="-1"
      @click="openWithTool('kimi', 'auto')"
      @keydown.enter.prevent="openWithTool('kimi', 'auto')"
      @keydown.space.prevent="openWithTool('kimi', 'auto')"
    >
      <span class="proj-menu__icon"><svg-icon icon-class="kimi" /></span>
      <span class="proj-menu__label">{{ $t('@67CE7:用 Kimi Code 打开（完全批准）') }}</span>
    </li>

    <!-- 桌面端分组：官方有桌面应用的工具各一项（装了点它启动桌面应用，没装跳
         官网下载页）。vscode / zcode 不进这组 —— 它们的主操作本身就是桌面应用；
         pi 没有官方桌面版。 -->
    <template v-if="desktopTools.length">
      <li class="proj-menu__sep" role="separator" />
      <li class="proj-menu__title" role="presentation">{{ $t('@WORKBENCH:桌面端') }}</li>
      <li
        v-for="tool in desktopTools"
        :key="`desktop-${tool.id}`"
        class="proj-menu__item"
        role="menuitem"
        tabindex="-1"
        @click="openOrDownloadDesktop(tool.id)"
        @keydown.enter.prevent="openOrDownloadDesktop(tool.id)"
        @keydown.space.prevent="openOrDownloadDesktop(tool.id)"
      >
        <span class="proj-menu__icon">
          <img v-if="tool.id === 'claude'" :src="claudeCodeIcon" alt="" class="proj-menu__img" />
          <svg-icon v-else :icon-class="tool.icon" :class="{ 'icon-invert-dark': tool.id === 'codex', 'icon-outline-dark': DARK_TILE_ICON_IDS.has(tool.id) }" />
        </span>
        <span class="proj-menu__label">{{ desktopAppLabel(toolsStore.desktopAppOf(tool.id)) }}</span>
        <span class="proj-menu__hint">{{ desktopAppHint(toolsStore.desktopAppOf(tool.id)) }}</span>
      </li>
    </template>
  </ul>

  <!-- 未安装的工具：复用顶栏那套安装引导（同一个组件），不在这里另写一份说明。
       跟着菜单内容一起挂载，所以同时最多只有一份（宿主只渲染打开的那一行）。 -->
  <ToolInstallDialog v-model="installVisible" :tool="installTool" />
</template>

<style scoped>
/* ── 「打开方式」菜单（el-popover 内容，随 popover 一起 teleport 到 body） ──
   scoped 仍然生效：弹层节点由本组件渲染，data-v 属性照样带着。
   popper 外壳（间距/阴影）走 Element Plus 默认，这里只管列表本身。 */
.proj-menu {
  margin: 0;
  padding: 2px 0;
  list-style: none;
  font-size: var(--font-size-mid);
  color: var(--text-primary);
}
.proj-menu__item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 10px;
  border-radius: var(--radius-md);
  cursor: pointer;
  user-select: none;
  transition:
    background var(--transition-fast) var(--ease-custom),
    color var(--transition-fast) var(--ease-custom);
}
.proj-menu__item:hover,
.proj-menu__item:focus-visible {
  background: var(--tint-primary-12);
  outline: none;
}
.proj-menu__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  font-size: var(--font-size-base);
  color: var(--text-secondary);
}
.proj-menu__icon :deep(svg) { width: 16px; height: 16px; }
.proj-menu__img {
  width: 16px;
  height: 16px;
  object-fit: contain;
  -webkit-user-drag: none;
}
.proj-menu__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.proj-menu__hint {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--text-meta);
  transition: color var(--transition-fast) var(--ease-custom);
}
.proj-menu__item:hover .proj-menu__hint { color: var(--color-primary); }
.proj-menu__sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--border-color);
}
.proj-menu__title {
  padding: 4px 10px 3px;
  font-size: var(--font-size-xs);
  font-weight: 600;
  letter-spacing: 0.3px;
  color: var(--text-meta);
}
/* 完全批准（含 Shell）：给个琥珀色，和顶栏 claude 菜单里那条危险项同一套语言 */
.proj-menu__item--danger .proj-menu__label { color: var(--color-warning-dark); }
/* 未安装：降饱和度（hover 恢复），点它走安装引导而不是硬启动 */
.proj-menu__item.is-missing .proj-menu__icon { opacity: 0.5; filter: grayscale(0.65); }
.proj-menu__item.is-missing:hover .proj-menu__icon { opacity: 0.85; filter: grayscale(0.2); }
</style>

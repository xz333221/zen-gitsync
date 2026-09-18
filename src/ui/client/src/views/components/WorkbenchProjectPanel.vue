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
  多项目编排台 · 左栏上半：项目列表。

  数据全部来自 GET /api/workbench/projects（服务器已算好 Git 状态与任务统计），
  这个组件只负责排版，不做任何推导。

  三处刻意的克制：
    1. Git 状态三态——exists=false 才显示「目录不存在」，exists=null（没探到）什么都不显示。
       宁可没有标记，也不谎报"你的目录没了"。
    2. 分支位只放**真的分支**：不是 Git 仓库时整段不显示（用户看这里没有分支图标就知道了，
       不必再用文字重复一遍"不是仓库"）。徽标位只留给需要动作的信号，
       否则一行里塞四五个标签，项目名会被挤成省略号。
    3. 进度行只给**有任务**的项目：total=0 时整行不渲染。一排「0/0 任务完成」+ 一条空进度条
       全是噪声，占的行高还让有任务的项目不显眼；没有进度行本身就是"这儿还没开工"的信号。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { $t } from '@/lang/static'
import { ElMessage } from 'element-plus'
import {
  Folder,
  FolderOpened,
  Grid,
  Monitor,
  MoreFilled,
  Promotion,
  Search,
} from '@element-plus/icons-vue'
import SvgIcon from '@components/SvgIcon/index.vue'
import ToolInstallDialog from '@components/ToolInstallDialog.vue'
import claudeCodeIcon from '@/assets/icons/svg/claudecode-color.svg'
import { useToolsStore, type ToolId } from '@/stores/toolsStore'
// 打开方式（文件管理器 / 终端 / 编辑器与 AI 工具 / 新标签页跑 g ui）统一走这个 composable：
// 端点映射、工具展示名与顶栏目录选择器共用一份，两处的工具列表不会各自漂移。
import {
  OPEN_WITH_TOOLS,
  TOOL_DISPLAY_NAMES,
  ensureToolsChecked,
  launchGuiInNewTab,
  openPathInFileManager,
  openPathInTerminal,
  openPathWithTool,
} from '@/composables/useDirectoryOpenActions'
import type { ProjectSummary } from '@/types/workbench'
import { relativeTimeFromIso } from '@/utils/relativeTime'

const props = defineProps<{
  projects: ProjectSummary[]
  selectedKey: string
  loading: boolean
}>()

const emit = defineEmits<{
  /** project 为 null 表示选中「全部项目」 */
  select: [project: ProjectSummary | null]
}>()

/** 有活跃执行的排前面，再按最后活跃时间倒序，最后是路径名——保证"正在动的"永远在第一屏 */
const ordered = computed(() => {
  return [...props.projects].sort((a, b) => {
    if ((a.stats.runningJobs > 0) !== (b.stats.runningJobs > 0)) {
      return a.stats.runningJobs > 0 ? -1 : 1
    }
    const ta = a.stats.lastActiveAt || ''
    const tb = b.stats.lastActiveAt || ''
    if (ta !== tb) return tb.localeCompare(ta)
    return a.name.localeCompare(b.name)
  })
})

// ── 筛选（纯前端） ──────────────────────────────────────────────────
// 项目清单本来就整份在内存里（GET /api/workbench/projects 一次给全），
// 筛选再走一趟后端只会多一次往返和一次"筛选态与服务端口径不一致"的可能，
// 所以这里就地对 ordered 过滤。
const query = ref('')
const onlyWithTasks = ref(false)
const hideNonGit = ref(false)

const filtering = computed(
  () => !!query.value.trim() || onlyWithTasks.value || hideNonGit.value
)

/**
 * 筛选结果。三条规则刻意各自独立（可叠加）：
 *   · 「只看有任务」用 stats.total === 0 —— 与左栏进度行"没有就不显示"同一个口径；
 *   · 「隐藏非 Git」只隐藏**明确探到不是仓库**的（isGitRepo === false）。
 *     isGitRepo === null 是"没探到"，把它当成非仓库藏掉就是谎报，与分支位那条克制同源；
 *   · 搜索同时匹配名称与路径（按路径找更快，名字记不全时用得上）。
 */
const visible = computed(() => {
  const q = query.value.trim().toLowerCase()
  return ordered.value.filter((p) => {
    if (onlyWithTasks.value && p.stats.total === 0) return false
    if (hideNonGit.value && p.git && p.git.isGitRepo === false) return false
    if (!q) return true
    return p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)
  })
})

function clearFilters() {
  query.value = ''
  onlyWithTasks.value = false
  hideNonGit.value = false
}

const totals = computed(() => props.projects.reduce(
  (acc, p) => ({
    running: acc.running + p.stats.runningJobs,
    done: acc.done + p.stats.done,
    total: acc.total + p.stats.total,
  }),
  { running: 0, done: 0, total: 0 }
))

/** 「全部项目」的汇总进度：跨项目按任务数加权，无任务时 0 而不是 NaN */
const overallProgress = computed(() =>
  totals.value.total > 0 ? Math.round((totals.value.done / totals.value.total) * 100) : 0
)

/**
 * 左栏那一行的分支文案。**空串 = 这行不显示**：
 * 不是 Git 仓库时不留文字 —— 那一格空着本身就是"这儿没有分支"的信号，
 * 再写一句「不是 Git 仓库」只是把行撑长、把项目名挤成省略号。
 */
function gitLine(p: ProjectSummary): string {
  if (!p.git) return ''
  if (p.git.isGitRepo === null) return $t('@WORKBENCH:未知')
  if (!p.git.isGitRepo) return ''
  if (p.git.detached) return $t('@WORKBENCH:游离 HEAD')
  return p.git.branch || $t('@WORKBENCH:未知')
}

/** 有没有分支可挂图标：只有真的落在某个分支上（含游离 HEAD）才算，"未知"没有 */
function hasBranchIcon(p: ProjectSummary): boolean {
  return !!(p.git && p.git.isGitRepo && (p.git.detached || p.git.branch))
}

// ── 打开方式菜单（hover 才出现的第二个按钮） ──────────────────────────
// 用 el-popover + manual trigger，和顶栏的工具菜单同一套做法：
//   1. trigger 不能是 IconButton 那类"根节点是组件"的元素（拿不到可靠 reference），
//      这里 reference 是原生 <button>，但菜单项点完还要手动关，所以仍然走 manual；
//   2. 每行各有一个 popover，隐藏的那些内容也留在 DOM 里 —— "点外面关闭"不能只查
//      第一个 .proj-open-menu（很可能命中隐藏的那个），必须把所有同名 popper 都过一遍，
//      再单独记住当前展开行的触发按钮（点它只该切换，不该先关再开）。
const openMenuKey = ref<string | null>(null)
const menuTriggerEl = ref<HTMLElement | null>(null)

function toggleOpenMenu(p: ProjectSummary, e: MouseEvent) {
  if (openMenuKey.value === p.key) {
    openMenuKey.value = null
    return
  }
  menuTriggerEl.value = e.currentTarget as HTMLElement
  openMenuKey.value = p.key
}

function closeOpenMenu() {
  openMenuKey.value = null
}

function onDocumentMouseDown(e: MouseEvent) {
  if (!openMenuKey.value) return
  const target = e.target as Node | null
  if (!target) return
  if (menuTriggerEl.value?.contains(target)) return
  for (const el of Array.from(document.querySelectorAll('.proj-open-menu'))) {
    if (el.contains(target)) return
  }
  openMenuKey.value = null
}

onMounted(() => document.addEventListener('mousedown', onDocumentMouseDown, true))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocumentMouseDown, true))

const toolsStore = useToolsStore()
const installVisible = ref(false)
const installTool = ref<ToolId | null>(null)

/**
 * 工具是否"确认未安装"：检测没跑完（lastCheckedAt === null）一律按未知处理 ——
 * 那时 isToolAvailable 全是 false，直接信它会在装了 VSCode 的机器上挂一排「未安装」。
 */
function toolMissing(tool: ToolId): boolean {
  return toolsStore.lastCheckedAt !== null && !toolsStore.isToolAvailable(tool)
}

/** 在系统文件管理器里打开项目目录 */
async function openInFileManager(p: ProjectSummary) {
  closeOpenMenu()
  const r = await openPathInFileManager(p.path)
  if (r.success) ElMessage.success(r.message || $t('@WORKBENCH:已在文件管理器中打开文件夹'))
  else ElMessage.error(r.error || $t('@WORKBENCH:打开文件夹失败'))
}

/** 在系统终端里打开项目目录 */
async function openInTerminal(p: ProjectSummary) {
  closeOpenMenu()
  const r = await openPathInTerminal(p.path)
  if (r.success) ElMessage.success(r.message || $t('@67CE7:已在终端中打开目录'))
  else ElMessage.error(r.error || $t('@WORKBENCH:打开终端失败'))
}

/**
 * 新开一个终端标签页，在这个项目目录里执行 `g ui`。
 * 服务端会剥掉 PORT 再启动，子进程自己挑空闲端口，不会和当前实例抢。
 */
async function launchGui(p: ProjectSummary) {
  closeOpenMenu()
  const r = await launchGuiInNewTab(p.path)
  if (r.success) ElMessage.success($t('@WORKBENCH:已在新标签页启动 g ui'))
  else ElMessage.error(r.error || $t('@WORKBENCH:启动 g ui 失败'))
}

/**
 * 用某个编辑器 / AI 工具打开项目目录。
 * 没装的走安装引导（和顶栏一致）：这里不直接打开，因为命令必然失败，
 * 而"为什么失败"用户只有看到安装方式才解决得了。
 */
async function openWithTool(p: ProjectSummary, tool: ToolId, permissionMode?: string) {
  closeOpenMenu()
  if (!(await ensureToolsChecked())) {
    ElMessage.warning($t('@67CE7:工具检测失败，请稍后重试'))
    return
  }
  if (!toolsStore.isToolAvailable(tool)) {
    installTool.value = tool
    installVisible.value = true
    return
  }
  const r = await openPathWithTool(tool, p.path, permissionMode)
  if (r.success) {
    ElMessage.success(r.message || $t('@67CE7:已用 {tool} 打开目录', { tool: TOOL_DISPLAY_NAMES[tool] }))
  } else {
    ElMessage.error(`${$t('@67CE7:打开失败: ')}${r.error ?? ''}`)
  }
}
</script>

<template>
  <section class="proj">
    <header class="proj__head">
      <h3 class="proj__title">{{ $t('@WORKBENCH:项目列表') }}</h3>
      <span class="proj__count">
        <template v-if="filtering">
          {{ $t('@WORKBENCH:匹配 {n}/{total} 个项目', { n: visible.length, total: projects.length }) }}
        </template>
        <template v-else>{{ projects.length }}</template>
      </span>
    </header>

    <!-- 一个项目都没有时不渲染筛选条：没有可筛的东西，这一行只是占位 -->
    <div v-if="projects.length > 0" class="proj__tools">
      <div class="proj__search">
        <el-icon class="proj__search-icon" aria-hidden="true"><Search /></el-icon>
        <input
          v-model="query"
          class="proj__search-input"
          type="search"
          :placeholder="$t('@WORKBENCH:搜索项目名称或路径')"
          :aria-label="$t('@WORKBENCH:搜索项目名称或路径')"
          @keydown.esc="query = ''"
        />
      </div>
      <div class="proj__toggles">
        <button
          type="button"
          class="proj__toggle"
          :class="{ 'is-on': onlyWithTasks }"
          :aria-pressed="onlyWithTasks"
          :title="$t('@WORKBENCH:只显示有任务的项目')"
          @click="onlyWithTasks = !onlyWithTasks"
        ><span>{{ $t('@WORKBENCH:只看有任务') }}</span></button>
        <button
          type="button"
          class="proj__toggle"
          :class="{ 'is-on': hideNonGit }"
          :aria-pressed="hideNonGit"
          :title="$t('@WORKBENCH:只显示 Git 仓库')"
          @click="hideNonGit = !hideNonGit"
        ><span>{{ $t('@WORKBENCH:隐藏非 Git') }}</span></button>
      </div>
    </div>

    <ul class="proj__list">
      <li
        class="proj-item proj-item--all"
        :class="{ 'is-active': selectedKey === '' }"
        role="button"
        tabindex="0"
        :title="$t('@WORKBENCH:全部项目')"
        @click="emit('select', null)"
        @keydown.enter.prevent="emit('select', null)"
        @keydown.space.prevent="emit('select', null)"
      >
        <div class="proj-item__row1">
          <el-icon class="proj-item__icon"><Grid /></el-icon>
          <span class="proj-item__name">{{ $t('@WORKBENCH:全部项目') }}</span>
          <span v-if="totals.running > 0" class="proj-item__running" aria-hidden="true" />
          <span class="proj-item__num">{{ projects.length }}</span>
        </div>

        <div class="proj-item__row2">
          <span>{{ $t('@WORKBENCH:{n} 个项目', { n: projects.length }) }}</span>
          <span v-if="totals.running > 0" class="proj-item__running-text">
            {{ $t('@WORKBENCH:{n} 个执行中', { n: totals.running }) }}
          </span>
        </div>

        <!-- 一个任务都没有时整行不渲染（「0/0 任务完成」+ 空进度条是纯噪声） -->
        <div v-if="totals.total > 0" class="proj-item__row3">
          <span class="proj-item__bar" aria-hidden="true">
            <i class="proj-item__bar-fill" :style="{ width: overallProgress + '%' }" />
          </span>
          <span class="proj-item__progress-text">
            {{ $t('@WORKBENCH:{done}/{total} 任务完成', { done: totals.done, total: totals.total }) }}
          </span>
        </div>
      </li>

      <li
        v-for="p in visible"
        :key="p.key"
        class="proj-item"
        :class="{
          'is-active': p.key === selectedKey,
          'is-running': p.stats.runningJobs > 0,
          'is-missing': p.exists === false,
        }"
        role="button"
        tabindex="0"
        :title="p.path"
        @click="emit('select', p)"
        @keydown.enter.self.prevent="emit('select', p)"
        @keydown.space.self.prevent="emit('select', p)"
      >
        <div class="proj-item__row1">
          <el-icon class="proj-item__icon"><Folder /></el-icon>
          <span class="proj-item__name">{{ p.name }}</span>
          <!-- 运行中 / 当前 这两个信号与 hover 才出现的操作按钮锚在同一个右端点：
               hover 时整组淡出让位给按钮，而不是让图标压在徽标上 -->
          <span class="proj-item__signals">
            <span v-if="p.stats.runningJobs > 0" class="proj-item__running" aria-hidden="true" />
            <span v-if="p.isCurrent" class="proj-item__badge">{{ $t('@WORKBENCH:当前') }}</span>
          </span>
        </div>

        <div class="proj-item__row2">
          <template v-if="p.exists === false">
            <span class="proj-chip proj-chip--missing">{{ $t('@WORKBENCH:目录不存在') }}</span>
          </template>
          <template v-else>
            <!-- gitLine 为空即"不是 Git 仓库"：不给文字，也不给图标 -->
            <span v-if="gitLine(p)" class="proj-item__branch">
              <svg-icon
                v-if="hasBranchIcon(p)"
                icon-class="git-branch"
                class-name="proj-item__branch-icon"
              />
              <span class="proj-item__branch-name">{{ gitLine(p) }}</span>
            </span>
            <span v-if="p.git && p.git.ahead > 0" class="proj-chip proj-chip--ahead">↑{{ p.git.ahead }}</span>
            <span v-if="p.git && p.git.behind > 0" class="proj-chip proj-chip--behind">↓{{ p.git.behind }}</span>
            <span v-if="p.git && p.git.changed > 0" class="proj-chip proj-chip--dirty">●{{ p.git.changed }}</span>
          </template>
          <span class="proj-item__time">{{ relativeTimeFromIso(p.stats.lastActiveAt) }}</span>
        </div>

        <!-- 同上：这个项目一个任务都没有就不给进度行 -->
        <div v-if="p.stats.total > 0" class="proj-item__row3">
          <span class="proj-item__bar" aria-hidden="true">
            <i class="proj-item__bar-fill" :style="{ width: p.stats.progress + '%' }" />
          </span>
          <span class="proj-item__progress-text">
            {{ $t('@WORKBENCH:{done}/{total} 任务完成', { done: p.stats.done, total: p.stats.total }) }}
          </span>
        </div>

        <!-- 打开动作：与行主体平级，绝对定位锚在 row1 右端（不占位，否则「当前」徽标
             永远离右边缘一条）；.stop 阻止冒泡到行的选中逻辑。目录都不存在了就不渲染——
             点了只会弹一个「无法打开目录」的报错。
             两个按钮：最常用的「打开文件夹」留一键直达，其余打开方式（终端 / 编辑器 /
             AI 工具 / 新标签页跑 g ui）收进「打开方式」菜单 —— 一行放不下七个图标，
             而项目名被挤成省略号比多点一次更难受。
             ⚠️ 行上的 keydown 必须带 .self：事件从按钮冒泡上来，不带 .self 时
             焦点在按钮上按回车会「选中该行 + preventDefault 掉按钮自己的激活」，
             键盘用户反而打不开文件夹。 -->
        <div v-if="p.exists !== false" class="proj-item__actions">
          <button
            type="button"
            class="proj-item__action"
            :title="$t('@WORKBENCH:打开文件夹')"
            :aria-label="`${$t('@WORKBENCH:打开文件夹')} ${p.name}`"
            @click.stop="openInFileManager(p)"
          >
            <el-icon aria-hidden="true"><FolderOpened /></el-icon>
          </button>

          <el-popover
            :visible="openMenuKey === p.key"
            :trigger="('manual' as any)"
            placement="right-start"
            :width="272"
            :show-arrow="false"
            :offset="6"
            popper-class="proj-open-menu"
          >
            <template #reference>
              <button
                type="button"
                class="proj-item__action"
                :class="{ 'is-open': openMenuKey === p.key }"
                :title="$t('@WORKBENCH:打开方式')"
                :aria-label="`${$t('@WORKBENCH:打开方式')} ${p.name}`"
                :aria-expanded="openMenuKey === p.key"
                aria-haspopup="menu"
                @click.stop="toggleOpenMenu(p, $event)"
              >
                <el-icon aria-hidden="true"><MoreFilled /></el-icon>
              </button>
            </template>

            <!-- v-if 而不是"一直渲染":el-popover 默认 persistent，菜单内容会常驻 DOM，
                 十来个项目就是十来份一模一样的菜单（含图标）跟着每次项目轮询一起 diff。
                 只在展开的那一行渲染，popover 外壳仍在（reference 要一直在），
                 右对齐 placement 的锚点是触发按钮的右上角，内容后到也不会跑位。 -->
            <ul v-if="openMenuKey === p.key" class="proj-menu" role="menu" :aria-label="$t('@WORKBENCH:打开方式')">
              <li
                class="proj-menu__item"
                role="menuitem"
                tabindex="-1"
                @click="openInFileManager(p)"
                @keydown.enter.prevent="openInFileManager(p)"
                @keydown.space.prevent="openInFileManager(p)"
              >
                <span class="proj-menu__icon"><el-icon aria-hidden="true"><FolderOpened /></el-icon></span>
                <span class="proj-menu__label">{{ $t('@WORKBENCH:在文件管理器中打开') }}</span>
              </li>
              <li
                class="proj-menu__item"
                role="menuitem"
                tabindex="-1"
                @click="openInTerminal(p)"
                @keydown.enter.prevent="openInTerminal(p)"
                @keydown.space.prevent="openInTerminal(p)"
              >
                <span class="proj-menu__icon"><el-icon aria-hidden="true"><Monitor /></el-icon></span>
                <span class="proj-menu__label">{{ $t('@WORKBENCH:在终端中打开') }}</span>
              </li>
              <li
                class="proj-menu__item"
                role="menuitem"
                tabindex="-1"
                @click="launchGui(p)"
                @keydown.enter.prevent="launchGui(p)"
                @keydown.space.prevent="launchGui(p)"
              >
                <span class="proj-menu__icon"><el-icon aria-hidden="true"><Promotion /></el-icon></span>
                <span class="proj-menu__label">{{ $t('@WORKBENCH:在新标签页启动 g ui') }}</span>
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
                @click="openWithTool(p, tool.id)"
                @keydown.enter.prevent="openWithTool(p, tool.id)"
                @keydown.space.prevent="openWithTool(p, tool.id)"
              >
                <span class="proj-menu__icon"><svg-icon :icon-class="tool.icon" /></span>
                <span class="proj-menu__label">{{ $t(tool.labelKey) }}</span>
                <span v-if="toolMissing(tool.id)" class="proj-menu__hint">{{ $t('@67CE7:未安装') }}</span>
              </li>

              <!-- claude 有两种权限模式，不混进上面的工具列表（顶栏也是单独排布的） -->
              <li
                class="proj-menu__item"
                :class="{ 'is-missing': toolMissing('claude') }"
                role="menuitem"
                tabindex="-1"
                @click="openWithTool(p, 'claude')"
                @keydown.enter.prevent="openWithTool(p, 'claude')"
                @keydown.space.prevent="openWithTool(p, 'claude')"
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
                @click="openWithTool(p, 'claude', 'bypassPermissions')"
                @keydown.enter.prevent="openWithTool(p, 'claude', 'bypassPermissions')"
                @keydown.space.prevent="openWithTool(p, 'claude', 'bypassPermissions')"
              >
                <span class="proj-menu__icon">
                  <img :src="claudeCodeIcon" alt="" class="proj-menu__img" />
                </span>
                <span class="proj-menu__label">{{ $t('@67CE7:用 Claude Code 打开（完全批准）') }}</span>
              </li>
            </ul>
          </el-popover>
        </div>
      </li>

      <li v-if="!loading && projects.length === 0" class="proj-empty">
        <p class="proj-empty__title">{{ $t('@WORKBENCH:尚无项目') }}</p>
        <p class="proj-empty__hint">{{ $t('@WORKBENCH:常用目录与建过任务的目录都会出现在这里') }}</p>
      </li>

      <!-- 有项目、只是被筛没了：这必须说出来。
           空着会让人以为项目列表坏了，而"没有匹配"和"一个项目都没有"是两件事。
           刻意写成两个互斥的 v-if（而不是 v-else-if）：条件里带上了 projects.length，
           读代码时不用回头找上一段才敢确定它们不重叠。 -->
      <li
        v-if="!loading && projects.length > 0 && visible.length === 0"
        class="proj-empty"
      >
        <p class="proj-empty__title">{{ $t('@WORKBENCH:没有匹配的项目') }}</p>
        <button type="button" class="proj-empty__clear" @click="clearFilters">
          {{ $t('@WORKBENCH:清除筛选') }}
        </button>
      </li>
    </ul>

    <!-- 未安装的工具：复用顶栏那套安装引导（同一个组件），不在这里另写一份说明。
         挂在面板根上只渲染一份，而不是每行一个 —— 同时最多只可能开一个。 -->
    <ToolInstallDialog v-model="installVisible" :tool="installTool" />
  </section>
</template>

<style scoped>
.proj {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 auto;
  overflow: hidden;
}
.proj__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px 6px;
  flex-shrink: 0;
}
.proj__title {
  margin: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  flex: 1;
  min-width: 0;
}
.proj__count {
  font-size: 10px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

/* ── 筛选条 ─────────────────────────────────────────── */
/* 两行：搜索独占一行（挤到半行就短得没法用），两个开关并排一行。
   整体是扁平的——只有 1px 边框，不额外加底色块，和下面项目行同一套语言。 */
.proj__tools {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 12px 8px;
  flex-shrink: 0;
}
.proj__search {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 7px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  transition: border-color var(--transition-fast) var(--ease-custom);
}
.proj__search:focus-within { border-color: var(--color-primary); }
.proj__search-icon {
  font-size: 12px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}
.proj__search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  font-family: inherit;
  font-size: 11.5px;
  color: var(--text-primary);
}
.proj__search-input::placeholder { color: var(--text-tertiary); }
.proj__toggles {
  display: flex;
  align-items: center;
  gap: 6px;
}
/* 开关：等宽平分，选中只变颜色 + 一层很淡的主色底（和 .proj-item__action:hover 同款） */
.proj__toggle {
  flex: 1 1 0;
  min-width: 0;
  height: 22px;
  padding: 0 6px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-tertiary);
  font-family: inherit;
  font-size: 10.5px;
  line-height: 1;
  cursor: pointer;
  transition:
    color var(--transition-fast) var(--ease-custom),
    border-color var(--transition-fast) var(--ease-custom),
    background var(--transition-fast) var(--ease-custom);
}
/* ⚠️ 省略号挂在 span 上，不挂在 button 上：button 要参与 flex 分配宽度，
   文字长度不可控时外层撑不住的话会把兄弟按钮挤走 */
.proj__toggle > span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.proj__toggle:hover { color: var(--text-secondary); border-color: var(--text-tertiary); }
.proj__toggle.is-on {
  color: var(--color-primary);
  border-color: var(--color-primary);
  background: var(--tint-primary-12);
}
.proj__toggle:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
.proj__list {
  list-style: none;
  margin: 0;
  padding: 0 6px 8px;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
}

/* 扁平行：无圆角、无边框，靠 hover 底色与行间留白区分 */
.proj-item {
  /* hover 操作按钮的定位锚点 */
  position: relative;
  padding: 7px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background var(--transition-fast) var(--ease-custom);
  outline: none;
}
.proj-item:hover { background: var(--bg-container-hover); }
.proj-item.is-active { background: color-mix(in srgb, var(--color-primary) 10%, transparent); }
.proj-item:focus-visible { outline: var(--focus-outline); outline-offset: -1px; }
.proj-item.is-running { background: color-mix(in srgb, var(--color-warning) 7%, transparent); }

/* 「全部项目」：与真实项目同构，但用一条下边线把它和下面的项目列表分隔开 */
.proj-item--all {
  margin-bottom: 4px;
  border-bottom: 1px solid var(--border-color);
  border-radius: 6px 6px 0 0;
}
.proj-item__num {
  flex-shrink: 0;
  font-size: 10px;
  line-height: 15px;
  padding: 0 5px;
  border-radius: 4px;
  color: var(--text-secondary);
  background: var(--bg-subtle);
  font-variant-numeric: tabular-nums;
}
.proj-item__running-text {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--color-warning);
  font-variant-numeric: tabular-nums;
}

.proj-item__row1 {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.proj-item__icon {
  font-size: 13px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}
.proj-item.is-active .proj-item__icon { color: var(--color-primary); }
.proj-item__name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
  line-height: 1.4;
  /* 给 hover 才出现的两个操作按钮（打开文件夹 + 打开方式）留位：它们绝对定位在 row1 右端，
     没有信号（运行中/当前）时名字会一路顶到那里，不留位就会被图标压住尾巴。
     名字没被截断时这段 padding 完全不可见。 */
  padding-right: 44px;
}
/* 运行中 / 当前：与操作按钮共用 row1 右端这个锚点，hover 时整组淡出让位 */
.proj-item__signals {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: opacity var(--transition-fast) var(--ease-custom);
}
/* ⚠️ 用 `:has(按钮:focus-visible)` 而不是 `.proj-item:focus-within`：
   点击行主体后 Chrome 把焦点留在行上，用 :focus-within 会让信号点击之后一直隐身；
   只有键盘 Tab 真正落到按钮上才需要让位。 */
.proj-item:not(.is-missing):hover .proj-item__signals,
.proj-item:not(.is-missing):has(.proj-item__action:focus-visible) .proj-item__signals {
  opacity: 0;
}
.proj-item__running {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-warning);
  animation: proj-pulse 1.4s ease-in-out infinite;
}
@keyframes proj-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(1.3); }
}
.proj-item__badge {
  flex-shrink: 0;
  font-size: 10px;
  line-height: 15px;
  padding: 0 5px;
  border-radius: 4px;
  color: var(--color-primary);
  background: var(--tint-primary-12);
}

/* ── hover 才出现的「打开文件夹」+「打开方式」 ─────────────────────── */
/* 绝对定位：空闲时不占宽度，row1 右端的徽标才能贴住行边缘。
   隐藏时 pointer-events: none —— 否则它会在右边吞掉本该落到整行的点击。 */
.proj-item__actions {
  position: absolute;
  right: 8px;
  top: 6px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--transition-fast) var(--ease-custom);
}
.proj-item:hover .proj-item__actions,
.proj-item:has(.proj-item__action:focus-visible) .proj-item__actions,
/* ⚠️ 菜单开着时必须继续显示：鼠标移进菜单（在行外面）后 hover 态就没了，
   少了这一条触发按钮会连同菜单一起"消失"，看着像点崩了。 */
.proj-item:has(.proj-item__action.is-open) .proj-item__actions {
  opacity: 1;
  pointer-events: auto;
}
/* 扁平化：无边框无底色，只靠图标颜色表达 hover，和「最近项目」卡片的操作按钮同一套语言 */
.proj-item__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 13px;
  cursor: pointer;
  transition:
    color var(--transition-fast) var(--ease-custom),
    background var(--transition-fast) var(--ease-custom);
}
.proj-item__action:hover {
  color: var(--color-primary);
  background: var(--tint-primary-12);
}
.proj-item__action:active { color: var(--color-primary); }
.proj-item__action:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
/* 菜单展开中：按钮保持主色，鼠标移进菜单后仍能看出"这个菜单是从哪一行开的" */
.proj-item__action.is-open {
  color: var(--color-primary);
  background: var(--tint-primary-12);
}

/* ── 「打开方式」菜单（el-popover 内容，随 popover 一起 teleport 到 body） ──
   scoped 仍然生效：弹层节点由本组件渲染，data-v 属性照样带着。
   popper 外壳（间距/阴影）走 Element Plus 默认，这里只管列表本身。 */
.proj-menu {
  margin: 0;
  padding: 2px 0;
  list-style: none;
  font-size: 12.5px;
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
  font-size: 15px;
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
  font-size: 10.5px;
  color: var(--text-tertiary);
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
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: var(--text-tertiary);
}
/* 完全批准（含 Shell）：给个琥珀色，和顶栏 claude 菜单里那条危险项同一套语言 */
.proj-menu__item--danger .proj-menu__label { color: var(--color-warning); }
/* 未安装：降饱和度（hover 恢复），点它走安装引导而不是硬启动 */
.proj-menu__item.is-missing .proj-menu__icon { opacity: 0.5; filter: grayscale(0.65); }
.proj-menu__item.is-missing:hover .proj-menu__icon { opacity: 0.85; filter: grayscale(0.2); }

.proj-item__row2 {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 2px;
  min-width: 0;
  font-size: 11px;
  color: var(--text-tertiary);
}
.proj-item__branch {
  /* 图标 + 分支名并排；max-width 比只有文字时略宽，给图标让出位置 */
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 130px;
  font-family: var(--font-mono, ui-monospace, monospace);
}
/* ⚠️ 省略号必须挂在分支名这层：flex item 上的 text-overflow 管不到里面的文本节点 */
.proj-item__branch-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 图标与分支名同色，不抢眼。
   ⚠️ color 这条**不能省**：SvgIcon 自己声明了 .svg-icon{color:--text-secondary}，
   不覆盖的话图标比分支名亮一档（实测 rgb(216,220,226) vs rgb(203,208,214)）。
   锚在 .proj-item__branch 下把权重抬到 (0,3,0) 是**防御性**的：裸 :deep() 实测也绿，
   但那是"父组件样式后注入"这个打包顺序白送的，不是权重挣来的 —— 既然覆盖的是
   SvgIcon 自己声明的属性，就显式赢，别把结论押在顺序上。 */
.proj-item__branch :deep(.proj-item__branch-icon) {
  width: 11px;
  height: 11px;
  flex-shrink: 0;
  color: currentColor;
}
.proj-item__time {
  margin-left: auto;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.proj-chip {
  flex-shrink: 0;
  font-size: 10px;
  line-height: 14px;
  padding: 0 4px;
  border-radius: 3px;
  font-variant-numeric: tabular-nums;
}
.proj-chip--ahead { color: var(--color-primary); background: var(--tint-primary-12); }
.proj-chip--behind { color: var(--color-warning); background: color-mix(in srgb, var(--color-warning) 14%, transparent); }
.proj-chip--dirty { color: var(--text-secondary); background: var(--bg-subtle); }
.proj-chip--missing { color: var(--color-danger-light); background: color-mix(in srgb, var(--color-danger) 12%, transparent); }

.proj-item__row3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 5px;
}
.proj-item__bar {
  flex: 1;
  min-width: 0;
  height: 3px;
  border-radius: 2px;
  background: var(--bg-subtle);
  overflow: hidden;
}
.proj-item__bar-fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--color-primary);
  transition: width var(--transition-base) var(--ease-custom);
}
.proj-item__progress-text {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.proj-empty {
  padding: 20px 12px;
  text-align: center;
  list-style: none;
}
.proj-empty__title {
  margin: 0 0 4px;
  font-size: 12.5px;
  color: var(--text-secondary);
}
.proj-empty__hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-tertiary);
}
/* 「清除筛选」：文字按钮，不加底色不加边框，只给主色 */
.proj-empty__clear {
  margin-top: 8px;
  padding: 2px 4px;
  border: none;
  background: transparent;
  color: var(--color-primary);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}
.proj-empty__clear:hover { text-decoration: underline; }
.proj-empty__clear:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
</style>

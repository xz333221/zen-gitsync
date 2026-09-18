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
  多项目编排台（L1）· 三栏骨架。

  · 左：项目列表 + 执行监控（跨项目一览，正在跑的永远排最前）
  · 中：选中项目的任务看板（「全部项目」时是全局视图）
  · 右：主 Agent 控制台（活动流 + 项目概览 + 指令派发）

  刷新策略刻意选了轮询而不是再开一条 SSE：
  现有 /api/workbench/events 那条流是编辑器在为 jobs/output-delta 用的，够重；
  看板需要的是"每几秒对齐一次全局快照"，5s 轮询 + 标签页隐藏时跳过就够，
  而且天然自愈（SSE 断了还要写重连逻辑，轮询下一次就自己好了）。
  Git 状态探测自带 15s TTL 缓存，轮询不会真的每 5s 起十几个 git 进程。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { $t } from '@/lang/static'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Fold, Expand } from '@element-plus/icons-vue'
import type { Attachment, BoardTask, ProjectSummary, Task } from '@/types/workbench'
import { canonicalProjectPath } from '@/utils/path'
import { useWorkbenchProjects } from '@/composables/useWorkbenchProjects'
import { useOrchestrator } from '@/composables/useOrchestrator'
import WorkbenchProjectPanel from './WorkbenchProjectPanel.vue'
import WorkbenchAgentPanel from './WorkbenchAgentPanel.vue'
import WorkbenchKanban from './WorkbenchKanban.vue'
import OrchestratorConsole from './OrchestratorConsole.vue'
import WorkbenchTaskDialog from './WorkbenchTaskDialog.vue'
import WorkbenchTaskCreateDialog from './WorkbenchTaskCreateDialog.vue'

const emit = defineEmits<{
  /** 请求上层切到任务编辑器的某个任务（只由弹窗里的「打开编辑器」显式触发） */
  'open-task': [payload: { taskId: string; projectPath: string }]
}>()

const {
  projects, boardTasks, currentProjectPath, loading,
  loadProjects,
} = useWorkbenchProjects()
const {
  active, activity, running, dispatching, togglingSchedule,
  loadOrchestrator, setSchedulingActive, dispatch,
} = useOrchestrator()

// ── 选中项目（'' = 全部项目） ────────────────────────────────────────
const SELECTED_KEY = 'wb.boardProject.v1'
const selectedKey = ref<string>((() => {
  try { return localStorage.getItem(SELECTED_KEY) || '' } catch { return '' }
})())
watch(selectedKey, (k) => {
  try { localStorage.setItem(SELECTED_KEY, k) } catch { /* 隐私模式：不落地也不影响使用 */ }
})

const selectedProject = computed<ProjectSummary | null>(() => {
  if (!selectedKey.value) return null
  return projects.value.find(p => p.key === selectedKey.value) || null
})

/** 项目被移除 / 首次加载后校正选中项：无效的 key 一律退回「全部项目」 */
watch(projects, (list) => {
  if (!selectedKey.value) return
  if (list.some(p => p.key === selectedKey.value)) return
  selectedKey.value = ''
})

/**
 * 任务 projectPath（原样字符串）→ 项目名。
 * 按任务的原始字符串做键，卡片直接 `labels[t.projectPath]` 取，
 * 免得组件里再引一次路径归一逻辑（两侧规则一旦分叉就会漏标签）。
 */
const projectLabels = computed<Record<string, string>>(() => {
  const byKey = new Map(projects.value.map(p => [p.key, p.name]))
  const map: Record<string, string> = {}
  for (const t of boardTasks.value) {
    if (!t.projectPath) continue
    map[t.projectPath] = byKey.get(canonicalProjectPath(t.projectPath)) || ''
  }
  return map
})

const visibleTasks = computed<BoardTask[]>(() => {
  if (!selectedKey.value) return boardTasks.value
  const key = selectedKey.value
  return boardTasks.value.filter(t => canonicalProjectPath(t.projectPath) === key)
})

const headerStats = computed(() => {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const since = start.getTime()
  return {
    projects: projects.value.length,
    tasks: boardTasks.value.length,
    running: running.value.length,
    todayDone: activity.value.filter(r => r.kind === 'done' && r.at && new Date(r.at).getTime() >= since).length,
  }
})

// ── 任务详情弹窗：点卡片就地看内容，不再跳进编辑器 ────────────────────
// 点卡片只开弹窗、不改 boardMode —— 看板的用处是扫全局、就地处理，
// 点一下就被甩到编辑器再点回来，手上的位置和筛选状态全丢了。
// 想深入编辑走弹窗里的「打开编辑器」这个显式动作。
const dialogOpen = ref(false)
const dialogTask = ref<BoardTask | null>(null)

function onViewTask(t: BoardTask) {
  dialogTask.value = t
  dialogOpen.value = true
}

/** 这一份是"最新的"，用来判断还能不能执行：弹窗拿到的那份快照不会自己更新 */
const dialogFreshTask = computed<BoardTask | null>(() => {
  const id = dialogTask.value?.id
  if (!id) return null
  return boardTasks.value.find(x => x.id === id) || dialogTask.value
})

const dialogProjectName = computed(() => {
  const t = dialogTask.value
  if (!t) return ''
  return projectLabels.value[t.projectPath] || ''
})

const dialogRunning = computed(() => (dialogFreshTask.value?.runningJobs ?? 0) > 0)

/** 弹窗里的「打开编辑器」：到这一步才切 L2，并把弹窗关掉免得回头看到它 */
function onOpenEditor(t: BoardTask) {
  dialogOpen.value = false
  emit('open-task', { taskId: t.id, projectPath: t.projectPath })
}

async function onDialogRun() {
  const fresh = dialogFreshTask.value
  if (fresh) await runTask(fresh)
}

async function onDialogRemove(t: BoardTask) {
  await deleteTask(t)
  // 删掉之后这个任务已经不存在了，弹窗继续开着只会停在 404 空框上
  dialogOpen.value = false
}

// ── 刷新：5s 轮询 + 标签页隐藏时跳过 ────────────────────────────────
const POLL_MS = 5000
let pollTimer: ReturnType<typeof setInterval> | null = null
let inFlight = false

async function refresh(silent = true) {
  if (inFlight) return
  inFlight = true
  try {
    await Promise.all([loadProjects(silent), loadOrchestrator(silent)])
  } finally {
    inFlight = false
  }
}

function onVisibilityChange() {
  if (!document.hidden) refresh(true)
}

onMounted(async () => {
  window.addEventListener('resize', onWindowResize)
  await refresh(false)
  pollTimer = setInterval(() => {
    if (document.hidden) return
    refresh(true)
  }, POLL_MS)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize)
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

// ── 两侧栏布局：拖动分隔条调宽 + 手动折叠（落地 localStorage）──────────
// 和 WorkbenchView 的侧边栏分隔条同款模式（mousedown 绑全局 mousemove/mouseup），
// 宽度实时改内联 CSS 变量，松手才写 localStorage。
const LAYOUT_KEY = 'wb.boardLayout.v1'
const LEFT_W_MIN = 180
const LEFT_W_MAX = 420
const RIGHT_W_MIN = 260
const RIGHT_W_MAX = 560
/**
 * 单侧最多占视口的比例，两侧加起来 ≤ 62% —— 看板任何情况下都还剩 ≥ 38%。
 * 右栏比左栏松一档：它是派发指令的地方，用户要的是"够宽"。
 */
const LEFT_W_SHARE = 0.26
const RIGHT_W_SHARE = 0.36

/**
 * 和响应式媒体查询的关系：**没拖过 = 完全交给媒体查询**（layout 里是 null，
 * 一个内联变量都不写）；拖过一次，这个宽度就是用户的显式选择 —— 内联变量优先级
 * 高于媒体查询，此后各断点不再自动收窄它。但每次渲染都会按**当前视口**重新夹一遍，
 * 免得窗口缩小后两侧加起来把看板吃光（1920 下拖到 900 的两栏，换到 1280 的窗口就是看板消失）。
 */
const layout = reactive({
  /** null = 没手动调过，宽度走 CSS 里的媒体查询默认值 */
  left: null as number | null,
  right: null as number | null,
  /** 宽屏下的手动折叠（窄屏的左栏开合走下面的 leftDrawerOpen，两套状态不混用） */
  leftCollapsed: false,
  rightCollapsed: false,
})

function readLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (!raw) return
    const o = JSON.parse(raw) as Partial<typeof layout>
    if (typeof o.left === 'number' && Number.isFinite(o.left)) layout.left = o.left
    if (typeof o.right === 'number' && Number.isFinite(o.right)) layout.right = o.right
    layout.leftCollapsed = o.leftCollapsed === true
    layout.rightCollapsed = o.rightCollapsed === true
  } catch {
    // 隐私模式 / 脏数据：退回默认布局，不影响使用
  }
}
readLayout()

function saveLayout() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)) } catch { /* quota 不阻塞 UI */ }
}

// ── 视口档位：和下面的媒体查询断点一一对应，只用来决定"拖拽 / 折叠要不要生效" ──
const viewportW = ref(typeof window === 'undefined' ? 1920 : window.innerWidth)
function onWindowResize() { viewportW.value = window.innerWidth }
/** ≤1024：左栏变成浮层抽屉，宽度不吃看板的空间，也不该用分隔条拖 */
const isNarrow = computed(() => viewportW.value <= 1024)
/** ≤860：上下排列，右栏铺满一整块，"收窄 / 折叠"这两个方向都不存在 */
const isStacked = computed(() => viewportW.value <= 860)

function clampWidth(side: 'left' | 'right', raw: number): number {
  const min = side === 'left' ? LEFT_W_MIN : RIGHT_W_MIN
  const cap = Math.min(
    side === 'left' ? LEFT_W_MAX : RIGHT_W_MAX,
    viewportW.value * (side === 'left' ? LEFT_W_SHARE : RIGHT_W_SHARE),
  )
  return Math.round(Math.min(Math.max(raw, min), Math.max(min, cap)))
}

/** 内联到 .board 的 CSS 变量：值为 null 就不写，让媒体查询的默认值生效 */
const boardStyle = computed<Record<string, string>>(() => {
  const s: Record<string, string> = {}
  if (layout.left != null) s['--wb-left-w'] = clampWidth('left', layout.left) + 'px'
  // 竖排时右栏必须是 100%：写成 px 会把铺满压掉，右栏就只剩一条
  if (layout.right != null && !isStacked.value) s['--wb-right-w'] = clampWidth('right', layout.right) + 'px'
  return s
})

const colsRef = ref<HTMLElement | null>(null)
/** 拖动中的那一侧：只为给分隔条自己加高亮、给容器关掉宽度过渡 */
const draggingSide = ref<'left' | 'right' | null>(null)

function panelEl(side: 'left' | 'right'): HTMLElement | null {
  return colsRef.value?.querySelector(side === 'left' ? '.board__left' : '.oc') as HTMLElement | null
}

/**
 * 分隔条拖动。起点宽度**从 DOM 量**而不是读 layout ——
 * 没拖过的时候 layout 里是 null，真正在生效的是媒体查询给的默认值。
 */
function onSplitterMouseDown(side: 'left' | 'right', e: MouseEvent) {
  if (side === 'left' ? isNarrow.value : isStacked.value) return
  const start = panelEl(side)
  if (!start) return
  e.preventDefault()
  const startX = e.clientX
  const startW = start.getBoundingClientRect().width
  draggingSide.value = side
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'
  const onMove = (ev: MouseEvent) => {
    // 右栏在分隔条右边：鼠标往左拖才是变宽，方向要反过来
    const dx = (ev.clientX - startX) * (side === 'left' ? 1 : -1)
    layout[side] = clampWidth(side, startW + dx)
  }
  const onUp = () => {
    window.removeEventListener('mousemove', onMove)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    draggingSide.value = null
    saveLayout()
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp, { once: true })
}

/** 双击分隔条：清掉手动宽度，回到媒体查询给的默认值 */
function onSplitterDblClick(side: 'left' | 'right') {
  layout[side] = null
  saveLayout()
}

/**
 * 左栏抽屉的开合状态。窄屏（≤1024）是"浮在看板上的抽屉"，宽屏是"常驻的一栏"，
 * 两者的默认值天生相反（窄屏要收起把宽度让给看板、宽屏要展开），
 * 所以是两个状态，只在渲染时合流成一个"看不见"的判断。
 */
const leftDrawerOpen = ref(false)
/** 左栏当前是否不可见：窄屏看抽屉状态，宽屏看折叠状态 */
const leftHidden = computed(() => (isNarrow.value ? !leftDrawerOpen.value : layout.leftCollapsed))

function toggleLeft() {
  if (isNarrow.value) {
    leftDrawerOpen.value = !leftDrawerOpen.value
    return
  }
  layout.leftCollapsed = !layout.leftCollapsed
  saveLayout()
}

/** Esc 只收窄屏的抽屉：宽屏那一栏是常驻的，误按 Esc 把它收掉只会让人莫名其妙 */
function onLeftEsc() {
  if (isNarrow.value) leftDrawerOpen.value = false
}

/** 右栏折叠。竖排（≤860）时强制展开 —— 那时候它是看板下面的一整块，没有"收边"可言 */
const rightHidden = computed(() => layout.rightCollapsed && !isStacked.value)

function toggleRight() {
  layout.rightCollapsed = !layout.rightCollapsed
  saveLayout()
}

function onSelectProject(p: ProjectSummary | null) {
  selectedKey.value = p ? p.key : ''
  // 窄屏下选完项目就把抽屉收掉，否则它一直盖着刚选中那个项目的看板
  leftDrawerOpen.value = false
}

// ── 动作 ────────────────────────────────────────────────────────────

/**
 * 打开项目所在文件夹（系统文件管理器 / 资源管理器 / 访达）。
 *
 * 路径直接用服务端 projects 快照里的 p.path，前端不做任何拼接——项目列表本来就是
 * 服务端扫出来的，前端再拼一次只会在 Windows 反斜杠上出岔子。
 * 这是一个纯旁路动作：不切换看板选中态、不刷新数据，开完窗口就结束。
 */
async function onOpenFolder(p: ProjectSummary) {
  try {
    const res = await fetch('/api/open_directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p.path }),
    }).then(r => r.json())
    if (res?.success) {
      ElMessage.success(res.message || $t('@WORKBENCH:已在文件管理器中打开文件夹'))
    } else {
      ElMessage.error(res?.error || $t('@WORKBENCH:打开文件夹失败'))
    }
  } catch (e) {
    ElMessage.error(`${$t('@WORKBENCH:打开文件夹失败')}: ${(e as Error).message}`)
  }
}

// ── 新建任务：弹窗里问清字段，建完就关，卡片直接落在看板上 ──────────────
// 不再"先建一个空任务再把人甩进编辑器" —— 那既让人离开看板，
// 又没说清任务属于哪个项目，还会在看板上留一个需要清理的空条目。
const createOpen = ref(false)

function onCreateClick() {
  createOpen.value = true
}

/** @param openEditor 来自「创建并打开编辑器」——那是显式动作，不是在背后偷偷跳转 */
async function onTaskCreated(payload: { task: Task; openEditor: boolean }) {
  await refresh(true)
  if (payload.openEditor) {
    emit('open-task', { taskId: payload.task.id, projectPath: payload.task.projectPath || '' })
    return
  }
  ElMessage.success($t('@WORKBENCH:已创建任务'))
}

async function runTask(t: BoardTask) {
  if (t.runningJobs > 0) return
  if (t.type !== 'simple' && t.subtaskCount === 0) {
    ElMessage.warning($t('@WORKBENCH:复杂任务要先拆出子任务，打开编辑器添加后再执行'))
    return
  }
  const url = t.type === 'simple'
    ? `/api/workbench/tasks/${encodeURIComponent(t.id)}/run-simple`
    : `/api/workbench/tasks/${encodeURIComponent(t.id)}/run`
  const res = await fetch(url, { method: 'POST' }).then(r => r.json()).catch(() => null)
  if (!res?.success) {
    ElMessage.error(res?.error || $t('@WORKBENCH:执行失败'))
    return
  }
  ElMessage.success($t('@WORKBENCH:已开始执行'))
  await refresh(true)
}

async function deleteTask(t: BoardTask) {
  const name = (t.title || '').trim() || $t('@WORKBENCH:未命名任务')
  try {
    await ElMessageBox.confirm(
      $t('@WORKBENCH:删除任务「{title}」及其所有子任务？', { title: name }),
      $t('@WORKBENCH:确认'),
      { type: 'warning' }
    )
  } catch {
    return
  }
  const res = await fetch(`/api/workbench/tasks/${encodeURIComponent(t.id)}`, { method: 'DELETE' })
    .then(r => r.json()).catch(() => null)
  if (res && res.success === false) {
    ElMessage.error(res.error || $t('@WORKBENCH:删除失败'))
    return
  }
  await refresh(true)
}

/** 控制台组件实例：派发成功后才由它清掉草稿附件（失败要留着，让用户能重试） */
const consoleRef = ref<InstanceType<typeof OrchestratorConsole> | null>(null)

/**
 * 新建任务弹窗的默认项目：选中具体项目就是它，「全部项目」则用应用当前项目。
 * 这里可以有隐式默认值 —— 弹窗里有项目下拉，用户看得见、改得动，不在看板上直接生效。
 */
const defaultProjectPath = computed(
  () => selectedProject.value?.path || currentProjectPath.value
)

/**
 * 派发。projectPath 只在"选中了具体项目"时才非空（显式指定）；
 * 「全部项目」下它是空串，由服务端 targetResolver 按指令内容判断落点
 * （指令里点名 > 主 Agent 判断 > 默认项目）。前端不猜落点 ——
 * 猜出来的和真正执行的各说各话时，吃亏的是用户。
 */
async function onDispatch(payload: {
  text: string; autoRun: boolean; attachments: Attachment[]; projectPath: string
}) {
  const result = await dispatch({
    text: payload.text,
    projectPath: payload.projectPath,
    autoRun: payload.autoRun,
    attachments: payload.attachments,
  })
  if (!result) return
  // 成功即可清：服务端此刻已把暂存文件搬进 `_task-{id}/`，前端留着这份记录只会指向失效路径
  consoleRef.value?.clearAttachments()
  ElMessage.success(
    result.ran
      ? $t('@WORKBENCH:已派发并开始执行')
      : $t('@WORKBENCH:已派发（只建任务未执行）')
  )
  await refresh(true)
}

async function onToggleSchedule(next: boolean) {
  await setSchedulingActive(next)
}
</script>

<template>
  <div class="board" :style="boardStyle">
    <header class="board__top">
      <!-- 左栏的开合。宽屏=收起/展开常驻那一栏；窄屏=抽屉 -->
      <button
        type="button"
        class="board__icon-btn board__fold-btn"
        :class="{ 'is-on': !leftHidden }"
        :title="leftHidden ? $t('@WORKBENCH:展开项目列表') : $t('@WORKBENCH:收起项目列表')"
        :aria-label="leftHidden ? $t('@WORKBENCH:展开项目列表') : $t('@WORKBENCH:收起项目列表')"
        :aria-expanded="!leftHidden"
        @click="toggleLeft"
      >
        <el-icon v-if="!leftHidden"><Fold /></el-icon>
        <el-icon v-else><Expand /></el-icon>
      </button>

      <div class="board__brand">
        <span class="board__live" :class="{ 'is-off': !active }" aria-hidden="true" />
        <div class="board__brand-text">
          <h1 class="board__title">{{ $t('@WORKBENCH:多项目编排台') }}</h1>
          <p class="board__subtitle">
            {{ active ? $t('@WORKBENCH:主 Agent 调度中') : $t('@WORKBENCH:主 Agent 已暂停') }}
          </p>
        </div>
      </div>

      <div class="board__stats">
        <span class="board__stat">
          <span class="board__stat-label">{{ $t('@WORKBENCH:项目') }}</span>
          <strong class="board__stat-value">{{ headerStats.projects }}</strong>
        </span>
        <span class="board__stat">
          <span class="board__stat-label">{{ $t('@WORKBENCH:任务') }}</span>
          <strong class="board__stat-value">{{ headerStats.tasks }}</strong>
        </span>
        <span class="board__stat">
          <span class="board__stat-label">{{ $t('@WORKBENCH:活跃执行') }}</span>
          <strong class="board__stat-value" :class="{ 'is-live': headerStats.running > 0 }">{{ headerStats.running }}</strong>
        </span>
        <span class="board__stat">
          <span class="board__stat-label">{{ $t('@WORKBENCH:今日完成') }}</span>
          <strong class="board__stat-value">{{ headerStats.todayDone }}</strong>
        </span>
      </div>

      <div class="board__actions">
        <button type="button" class="board__icon-btn" :title="$t('@WORKBENCH:刷新')" :aria-label="$t('@WORKBENCH:刷新')" @click="refresh(false)">
          <el-icon><Refresh /></el-icon>
        </button>
        <el-button type="primary" size="small" :icon="Plus" @click="onCreateClick">
          {{ $t('@WORKBENCH:新建开发任务') }}
        </el-button>
      </div>
    </header>

    <div ref="colsRef" class="board__cols" :class="{ 'is-resizing': draggingSide !== null }">
      <!-- 抽屉打开时的点击捕获层：点空白处收起。
           只在窄屏 + 打开时才 display:block（见媒体查询），宽屏下是个不占位的空 div。
           不加遮罩底色而是全透明 —— 只是为了接住点击，不是为了压暗看板；
           真要压暗就得处理深色主题下半透明背景叠不实的老问题（见 NOTES §2）。 -->
      <div
        class="board__scrim"
        :class="{ 'is-on': leftDrawerOpen }"
        aria-hidden="true"
        @click="leftDrawerOpen = false"
      />

      <aside
        class="board__left"
        :class="{ 'is-collapsed': leftHidden }"
        @keydown.esc="onLeftEsc"
      >
        <WorkbenchProjectPanel
          :projects="projects"
          :selected-key="selectedKey"
          :loading="loading"
          @select="onSelectProject"
          @open-folder="onOpenFolder"
        />
        <WorkbenchAgentPanel :running="running" />
      </aside>

      <!-- 左栏分隔条：左栏收起 / 窄屏抽屉模式下不占位（不渲染 / 媒体查询里 display:none） -->
      <div
        v-if="!leftHidden"
        class="board__splitter board__splitter--left"
        role="separator"
        aria-orientation="vertical"
        :title="$t('@WORKBENCH:拖动调整项目列表宽度，双击恢复默认')"
        @mousedown="onSplitterMouseDown('left', $event)"
        @dblclick="onSplitterDblClick('left')"
      />

      <main class="board__main">
        <div class="board__main-head">
          <div class="board__main-title">
            <h2 class="board__project-name">
              {{ selectedProject ? selectedProject.name : $t('@WORKBENCH:全部项目') }}
            </h2>
            <span v-if="selectedProject" class="board__project-path" :title="selectedProject.path">
              {{ selectedProject.path }}
            </span>
            <span v-else class="board__project-path">
              {{ $t('@WORKBENCH:共 {n} 个项目的任务', { n: projects.length }) }}
            </span>
          </div>
          <span v-if="selectedProject" class="board__project-meta">
            {{ $t('@WORKBENCH:{done}/{total} 任务完成', { done: selectedProject.stats.done, total: selectedProject.stats.total }) }}
          </span>
        </div>

        <WorkbenchKanban
          :tasks="visibleTasks"
          :project-labels="projectLabels"
          :show-project-label="!selectedProject"
          @view-task="onViewTask"
          @run-task="runTask"
          @delete-task="deleteTask"
          @create-task="onCreateClick"
        />
      </main>

      <!-- 右栏分隔条：右栏收起 / 竖排（≤860）时不占位 -->
      <div
        v-if="!rightHidden && !isStacked"
        class="board__splitter board__splitter--right"
        role="separator"
        aria-orientation="vertical"
        :title="$t('@WORKBENCH:拖动调整主 Agent 控制台宽度，双击恢复默认')"
        @mousedown="onSplitterMouseDown('right', $event)"
        @dblclick="onSplitterDblClick('right')"
      />

      <OrchestratorConsole
        ref="consoleRef"
        :active="active"
        :activity="activity"
        :running-count="running.length"
        :selected-project="selectedProject"
        :dispatching="dispatching"
        :toggling-schedule="togglingSchedule"
        :today-done="headerStats.todayDone"
        :collapsed="rightHidden"
        @toggle-collapse="toggleRight"
        @toggle-schedule="onToggleSchedule"
        @dispatch="onDispatch"
      />
    </div>

    <!-- 任务详情：就地弹窗，看完关掉还在原来的看板位置 -->
    <WorkbenchTaskDialog
      v-model="dialogOpen"
      :task="dialogTask"
      :project-name="dialogProjectName"
      :running="dialogRunning"
      @run="onDialogRun"
      @open-editor="onOpenEditor"
      @remove="onDialogRemove"
    />

    <!-- 新建任务：弹窗里问清字段，建完就关 -->
    <WorkbenchTaskCreateDialog
      v-model="createOpen"
      :projects="projects"
      :default-project-path="defaultProjectPath"
      @created="onTaskCreated"
    />
  </div>
</template>

<style scoped>
.board {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-container);
  color: var(--text-primary);
  /* 两侧栏宽度的**唯一出处**。右栏（OrchestratorConsole 的 .oc）读同一个变量，
     所以调窄屏宽度只改这里，不用 :deep 进子组件压它的 width。
     下面三档媒体查询就是"越窄越收紧"的全部内容。
     这两个值只在**用户没手动拖过分隔条**时生效（拖过就由 .board 上的内联变量接管）。 */
  --wb-left-w: 264px;
  --wb-right-w: 360px;
}

/* ── 顶栏 ───────────────────────────────────────────── */
.board__top {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 14px;
  height: 52px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-panel);
}
.board__brand {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.board__live {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--color-success);
  animation: board-pulse 1.6s ease-in-out infinite;
}
.board__live.is-off { background: var(--color-warning); animation: none; }
@keyframes board-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(1.4); }
}
.board__brand-text { min-width: 0; }
.board__title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text-primary);
  line-height: 1.3;
}
.board__subtitle {
  margin: 0;
  font-size: 10.5px;
  color: var(--text-tertiary);
  line-height: 1.3;
}

.board__stats {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-left: 4px;
  flex-wrap: wrap;
  min-width: 0;
}
.board__stat {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  font-size: 11px;
  color: var(--text-tertiary);
}
.board__stat-value {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.board__stat-value.is-live { color: var(--color-warning); }

.board__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  flex-shrink: 0;
}
/* 图标按钮只变颜色，不加底色/边框 */
.board__icon-btn {
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  transition: color var(--transition-fast) var(--ease-custom);
}
.board__icon-btn:hover { color: var(--color-primary); }
.board__icon-btn:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }

/* 点击捕获层默认不占位，只在窄屏 + 抽屉打开时 display:block（规则在下面的媒体查询里）。 */
.board__scrim { display: none; }

/* 左栏开合按钮（.board__fold-btn）没有自有样式，靠 .board__icon-btn 兜底 ——
   宽屏窄屏它都在，差别只在点下去收的是常驻那一栏还是浮层抽屉（见 toggleLeft）。
   这个类名同时是验证脚本定位它的锚点，不要删。 */

/* ── 三栏 ───────────────────────────────────────────── */
.board__cols {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  /* 窄屏左栏要改成浮在看板上方的抽屉，这里当它的定位锚点（见媒体查询） */
  position: relative;
}
.board__left {
  display: flex;
  flex-direction: column;
  width: var(--wb-left-w);
  flex-shrink: 0;
  min-height: 0;
  background: var(--bg-panel);
}

/* 两侧栏的分隔条：5px 命中区，常态隐形，hover / 拖动时亮出 1px 主线提示可拖。
   和 WorkbenchView 的 .wb-splitter 同款 —— 宽度不改自己的布局之外的东西，
   拖动时实时改的是 .board 上的 --wb-left-w / --wb-right-w。 */
.board__splitter {
  flex: 0 0 5px;
  position: relative;
  z-index: 5;
  cursor: col-resize;
  touch-action: none;
}
.board__splitter::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 2px;
  width: 1px;
  background: transparent;
  transition: background var(--transition-fast) var(--ease-custom);
}
.board__splitter:hover::after,
.board__splitter:active::after,
.board__cols.is-resizing .board__splitter::after {
  background: var(--color-primary);
}
.board__main {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}
.board__main-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px 8px;
  flex-shrink: 0;
  min-width: 0;
}
.board__main-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.board__project-name {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  flex-shrink: 0;
}
.board__project-path {
  font-size: 11px;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.board__project-meta {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

/* ══ 响应式 ══════════════════════════════════════════════════════════
   下面这些是**默认值**：用户没拖过分隔条时（layout 里是 null，一个内联变量都不写）
   完全由它们决定；拖过一次就由 .board 上的内联 --wb-*-w 接管，这里不再插手。

   默认值按"看板还剩多少"倒推，而不是拍脑袋的整数：
     1440  两侧各收一点，还够看
     1180  再收，左栏到 200px 是项目名还能认出来的下限
     1024  左栏改成抽屉（能收起来才是真的省下 200px）
      860  竖排       → 看板与右栏上下叠，各自占满宽度

   右栏默认比左栏宽一档（360 vs 264）：它是派发指令的地方，输入区越宽越好写。
   ══════════════════════════════════════════════════════════════════ */
@media (max-width: 1440px) {
  .board { --wb-left-w: 224px; --wb-right-w: 320px; }
}
@media (max-width: 1180px) {
  .board { --wb-left-w: 200px; --wb-right-w: 280px; }
}

/* 宽屏（>1024）：左栏是常驻一栏，可以手动折叠成 0 宽。
   折叠只改宽度、不销毁内容 —— 展开回来滚动位置和筛选状态都还在。
   过渡跟着折叠走；拖动分隔条时挂 .is-resizing 关掉它（否则宽度追不上鼠标）。 */
@media (min-width: 1025px) {
  .board__left {
    transition: width var(--transition-base) var(--ease-custom);
  }
  .board__left.is-collapsed {
    width: 0;
    /* 折叠态的子树还占着 200+px 的内容宽度，不裁掉会把看板顶出去 */
    overflow: hidden;
  }
  .board__cols.is-resizing .board__left { transition: none; }
}

/* 左栏改成抽屉：绝对定位浮在看板上方，用 transform 收起（保留过渡）。
   ⚠️ 底色用 --bg-container 而不是 --bg-panel：深色主题的 --bg-panel-dark 是半透明的，
   浮层用它会在看板文字上透出底下的字（同 NOTES §2 那个坑）。 */
@media (max-width: 1024px) {
  /* 抽屉是浮层、不吃看板宽度，横着拖它没有意义 —— 分隔条整个撤掉 */
  .board__splitter--left { display: none; }

  .board__left {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    z-index: 20;
    width: min(var(--wb-left-w), 86vw);
    background: var(--bg-container);
    border-right: 1px solid var(--border-color);
    box-shadow: var(--dialog-shadow);
    transition: transform var(--transition-base) var(--ease-custom);
  }
  .board__left.is-collapsed {
    transform: translateX(-100%);
    /* 收起后必须断掉命中测试，否则它会隔着 86vw 宽的一条透明区域继续吞点击 */
    pointer-events: none;
  }

  .board__scrim.is-on {
    display: block;
    position: absolute;
    inset: 0;
    z-index: 15;
  }
}

/* 手机宽度：看板在上、主 Agent 控制台在下，整块纵向滚动。
   输入区仍可直接用 —— 控制台自带 min-height（见 OrchestratorConsole），
   展开后不用先滚动定位就能点到输入框和派发按钮。 */
@media (max-width: 860px) {
  .board { --wb-right-w: 100%; }
  /* 右栏铺满一整块，没有"收窄"这个方向可拖 */
  .board__splitter--right { display: none; }
  .board__cols {
    flex-direction: column;
    overflow-y: auto;
  }
  .board__main {
    flex: 0 0 auto;
    min-height: 72vh;
  }
  /* 顶栏放不下一行：统计项落到第二行，而不是把标题挤没 */
  .board__top {
    height: auto;
    flex-wrap: wrap;
    padding: 8px 12px;
    gap: 6px 12px;
  }
  .board__stats {
    order: 3;
    flex-basis: 100%;
    margin-left: 0;
    gap: 12px;
  }
  .board__actions { margin-left: auto; }
}
</style>

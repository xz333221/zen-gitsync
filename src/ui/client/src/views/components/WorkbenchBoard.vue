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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
  await refresh(false)
  pollTimer = setInterval(() => {
    if (document.hidden) return
    refresh(true)
  }, POLL_MS)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

// ── 动作 ────────────────────────────────────────────────────────────
/**
 * 左栏抽屉的开合状态。**只在窄屏（≤1024px）有意义**：
 * 宽屏时 .board__left 是常驻一栏，这个 class 没有任何样式（相关规则全在媒体查询里），
 * 所以下面不用写"窗口宽度"判断 —— 状态只有一个，样式决定它怎么表现。
 *
 * 默认 false（收起）：窄屏下看板要占满宽度，左栏按需展开。
 */
const leftDrawerOpen = ref(false)

function onSelectProject(p: ProjectSummary | null) {
  selectedKey.value = p ? p.key : ''
  // 窄屏下选完项目就把抽屉收掉，否则它一直盖着刚选中那个项目的看板
  leftDrawerOpen.value = false
}

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
  <div class="board">
    <header class="board__top">
      <!-- 窄屏下展开/收起左栏。宽屏时这个按钮不显示（左栏本来就常驻） -->
      <button
        type="button"
        class="board__icon-btn board__drawer-btn"
        :class="{ 'is-on': leftDrawerOpen }"
        :title="leftDrawerOpen ? $t('@WORKBENCH:收起项目列表') : $t('@WORKBENCH:展开项目列表')"
        :aria-label="leftDrawerOpen ? $t('@WORKBENCH:收起项目列表') : $t('@WORKBENCH:展开项目列表')"
        :aria-expanded="leftDrawerOpen"
        @click="leftDrawerOpen = !leftDrawerOpen"
      >
        <el-icon v-if="leftDrawerOpen"><Fold /></el-icon>
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

    <div class="board__cols">
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
        :class="{ 'is-collapsed': !leftDrawerOpen }"
        @keydown.esc="leftDrawerOpen = false"
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

      <OrchestratorConsole
        ref="consoleRef"
        :active="active"
        :activity="activity"
        :running-count="running.length"
        :selected-project="selectedProject"
        :dispatching="dispatching"
        :toggling-schedule="togglingSchedule"
        :today-done="headerStats.todayDone"
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
     下面三档媒体查询就是"越窄越收紧"的全部内容。 */
  --wb-left-w: 264px;
  --wb-right-w: 300px;
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

/* 抽屉按钮 / 点击捕获层默认不占位，只在窄屏生效（规则在下面的媒体查询里）。
   ⚠️ 这两条必须写在媒体查询**之前**：`.board__drawer-btn` 在媒体查询里是同一个选择器、
   同为 (0,1,0) 权重，谁在后面谁赢 —— 写在后面会把窄屏那条 display:inline-flex 反压掉。 */
.board__drawer-btn { display: none; }
.board__scrim { display: none; }

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
   三栏固定总宽 = 264 + 300 = 564px，剩给看板；再算上左侧活动栏（约 48px），
   屏宽 1280 时看板只有 660px 左右，三条列每列 220px —— 卡片标题已经开始成省略号。
   所以这里的顺序是：**先收两边，再动结构**，能不折叠就不折叠。

   断点按"看板还剩多少"倒推，而不是拍脑袋的整数：
     1440  看板 ≈ 830  → 两侧各收一点，还够看
     1180  看板 ≈ 570  → 再收，左栏到 200px 是项目名还能认出来的下限
     1024  看板 ≈ 460  → 左栏改成抽屉（能收起来才是真的省下 200px）
      860  竖排       → 看板与右栏上下叠，各自占满宽度

   ⚠️ 右栏（.oc）**不参与折叠**：用户要经常派发指令，它得一直在。
   所以窄屏下被牺牲顺序是"左栏 → 结构"，不是"右栏 → 收起"。
   ══════════════════════════════════════════════════════════════════ */
@media (max-width: 1440px) {
  .board { --wb-left-w: 224px; --wb-right-w: 280px; }
}
@media (max-width: 1180px) {
  .board { --wb-left-w: 200px; --wb-right-w: 260px; }
}

/* 左栏改成抽屉：绝对定位浮在看板上方，用 transform 收起（保留过渡）。
   ⚠️ 底色用 --bg-container 而不是 --bg-panel：深色主题的 --bg-panel-dark 是半透明的，
   浮层用它会在看板文字上透出底下的字（同 NOTES §2 那个坑）。 */
@media (max-width: 1024px) {
  .board__drawer-btn { display: inline-flex; }

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

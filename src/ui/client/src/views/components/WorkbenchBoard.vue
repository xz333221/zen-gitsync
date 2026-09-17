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
import { Plus, Refresh } from '@element-plus/icons-vue'
import type { BoardTask, ProjectSummary } from '@/types/workbench'
import { canonicalProjectPath } from '@/utils/path'
import { useWorkbenchProjects } from '@/composables/useWorkbenchProjects'
import { useOrchestrator } from '@/composables/useOrchestrator'
import WorkbenchProjectPanel from './WorkbenchProjectPanel.vue'
import WorkbenchAgentPanel from './WorkbenchAgentPanel.vue'
import WorkbenchKanban from './WorkbenchKanban.vue'
import OrchestratorConsole from './OrchestratorConsole.vue'

const emit = defineEmits<{
  /** 请求上层切到任务编辑器的某个任务 */
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

/** 控制台右栏要展示的项目：选了具体项目就用它，否则回落到应用当前项目 */
const consoleProject = computed<ProjectSummary | null>(() => {
  if (selectedProject.value) return selectedProject.value
  const key = canonicalProjectPath(currentProjectPath.value)
  if (!key) return null
  return projects.value.find(p => p.key === key) || null
})

const targetProjectName = computed(() => {
  if (selectedProject.value) return selectedProject.value.name
  return consoleProject.value ? consoleProject.value.name : ''
})

function targetProjectPath(): string {
  if (selectedProject.value) return selectedProject.value.path
  return currentProjectPath.value
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
function onSelectProject(p: ProjectSummary | null) {
  selectedKey.value = p ? p.key : ''
}

async function createTask() {
  const projectPath = targetProjectPath()
  const body: Record<string, unknown> = {
    title: '', desc: '', promptId: null, type: 'simple', simpleOverride: '', subtasks: [],
  }
  if (projectPath) body.projectPath = projectPath
  const res = await fetch('/api/workbench/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json()).catch(() => null)
  if (!res?.success) {
    ElMessage.error(res?.error || $t('@WORKBENCH:保存失败'))
    return
  }
  await refresh(true)
  emit('open-task', { taskId: res.task.id, projectPath: res.task.projectPath || projectPath })
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

async function onDispatch(payload: { text: string; autoRun: boolean }) {
  const result = await dispatch({ text: payload.text, projectPath: targetProjectPath(), autoRun: payload.autoRun })
  if (!result) return
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
        <el-button type="primary" size="small" :icon="Plus" @click="createTask">
          {{ $t('@WORKBENCH:新建开发任务') }}
        </el-button>
      </div>
    </header>

    <div class="board__cols">
      <aside class="board__left">
        <WorkbenchProjectPanel
          :projects="projects"
          :selected-key="selectedKey"
          :loading="loading"
          @select="onSelectProject"
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
          @open-task="(t) => emit('open-task', { taskId: t.id, projectPath: t.projectPath })"
          @run-task="runTask"
          @delete-task="deleteTask"
          @create-task="createTask"
        />
      </main>

      <OrchestratorConsole
        :active="active"
        :activity="activity"
        :running-count="running.length"
        :selected-project="consoleProject"
        :dispatching="dispatching"
        :toggling-schedule="togglingSchedule"
        :today-done="headerStats.todayDone"
        :target-project-name="targetProjectName"
        @toggle-schedule="onToggleSchedule"
        @dispatch="onDispatch"
      />
    </div>
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

/* ── 三栏 ───────────────────────────────────────────── */
.board__cols {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}
.board__left {
  display: flex;
  flex-direction: column;
  width: 264px;
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
</style>

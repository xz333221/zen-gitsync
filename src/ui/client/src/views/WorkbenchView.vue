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
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { $t } from '@/lang/static'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Check,
  Document,
  Delete,
  CopyDocument,
  Warning
} from '@element-plus/icons-vue'
import AttachmentZone from '@components/AttachmentZone.vue'
import { ChatInput, ChatContainer } from 'zen-ai-chat-ui'
import 'zen-ai-chat-ui/style.css'
import { avatarForExecutor } from '@/utils/agentAvatar'
import { MESSAGE_RAIL_CONFIG } from '@/utils/agentConversations'
import { useConfigStore } from '@/stores/configStore'
import { useToolsStore } from '@/stores/toolsStore'
const configStore = useConfigStore()
const toolsStore = useToolsStore()
import ExecutionLogManager from '@components/ExecutionLogManager.vue'
import { canonicalProjectPath } from '@/utils/path'
import { relativeTimeFromIso } from '@/utils/relativeTime'
import { taskDurationText, taskTimeIso, taskTimeTitle } from '@/utils/taskTime'
import type { BoardTask, Task } from '@/types/workbench'
import { useWorkbenchAttachments, ALLOWED_EXT_HINT, MAX_ATTACHMENT_BYTES } from '@/composables/useWorkbenchAttachments'
import { useWorkbenchSimpleConversation } from '@/composables/useWorkbenchSimpleConversation'
import { buildTaskExecutionText, type TaskExecutionScope } from '@/utils/taskExecutionExport'
import { useWorkbenchExecution } from '@/composables/useWorkbenchExecution'
import { useTaskExecutorSelection } from '@/composables/useTaskExecutorSelection'
import { TASK_EXECUTOR_OPTIONS, taskExecutorName, type TaskExecutorId } from '@/utils/taskExecutor'
import TaskExecutorIcon from '@components/TaskExecutorIcon.vue'
import { useWorkbenchData } from '@/composables/useWorkbenchData'
import WorkbenchSidebar from '@/views/components/WorkbenchSidebar.vue'
import WorkbenchBoard from '@/views/components/WorkbenchBoard.vue'
import CommonDialog from '@/components/CommonDialog.vue'

// ── 按 projectPath 记忆「该项目最后一次打开的 task」───────────────────────
// 落地 localStorage,key 格式 wb.lastTaskByProject.v1 = { [projectPath]: taskId }。
// 刷新 / 重进工作台时,在当前项目下优先恢复上次打开的任务,而不是默认选第一条。
const LAST_TASK_BY_PROJECT_KEY = 'wb.lastTaskByProject.v1'
const NO_PROJECT_KEY = '__no_project__'

// ── 侧边栏宽度:分隔条拖动调整,落地 localStorage ──────────────────────────
// 与任务拖动排序同款模式(mousedown 绑全局 mousemove/mouseup),
// 不用 HTML5 DnD。宽度实时改 sidebar 内联样式,松手时才写 localStorage。
const SIDEBAR_WIDTH_KEY = 'wb.sidebarWidth.v1'
const SIDEBAR_MIN_W = 200
const SIDEBAR_MAX_W = 480
const SIDEBAR_DEFAULT_W = 268
const sidebarWidth = ref((() => {
  try {
    const v = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) || '', 10)
    return Number.isFinite(v) ? Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, v)) : SIDEBAR_DEFAULT_W
  } catch {
    return SIDEBAR_DEFAULT_W
  }
})())

function onSidebarSplitterMouseDown(e: MouseEvent) {
  e.preventDefault()
  const startX = e.clientX
  const startW = sidebarWidth.value
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'
  const onMove = (ev: MouseEvent) => {
    sidebarWidth.value = Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, startW + ev.clientX - startX))
  }
  const onUp = () => {
    window.removeEventListener('mousemove', onMove)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth.value)) } catch { /* quota 不阻塞 UI */ }
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp, { once: true })
}
// 分隔条键盘替代:←/→ 微调宽度,复用同一 sidebarWidth 状态与落盘逻辑
function nudgeSidebarWidth(delta: number) {
  sidebarWidth.value = Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, sidebarWidth.value + delta))
  try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth.value)) } catch { /* quota 不阻塞 UI */ }
}
function readLastTaskMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LAST_TASK_BY_PROJECT_KEY)
    const obj = raw ? JSON.parse(raw) : {}
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, string>) : {}
  } catch {
    return {}
  }
}
function writeLastTaskMap(m: Record<string, string>) {
  try {
    localStorage.setItem(LAST_TASK_BY_PROJECT_KEY, JSON.stringify(m))
  } catch {
    // 隐私模式 / 配额超限:静默降级,不影响主流程
  }
}
function rememberLastTask(projectPath: string, taskId: string) {
  const map = readLastTaskMap()
  map[projectPath || NO_PROJECT_KEY] = taskId
  writeLastTaskMap(map)
}

// ── 视图层级：L1 多项目编排台（常驻底图）+ L2 任务编辑器（大弹窗） ──────
// 刻意**没有**视图切换了。原来 boardMode 是二选一，进编辑器等于换页：
// 想瞄一眼任务的子任务再回到原来的项目/筛选，就得多点一次返回，还可能滚回顶部。
// 现在看板始终在，编辑器以弹窗浮在它上面，关掉就回到原位 —— 全程没有任何"跳转"。
// 也正因为弹窗天生是临时的，不再持久化"上次在哪一层"：刷新后落在看板才是对的行为。
const editorOpen = ref(false)

function closeEditor() {
  editorOpen.value = false
}

/**
 * 从看板上点开过的任务（本次会话内记住，最后点开的那条为准）。
 * 看板据此给那张卡片挂一枚标记（主色描边 + aria-current）："你最后点开的是这条"。
 *
 * 曾经它还负责取消那张卡片的 hover 操作（2026-09-30），2026-10-05 撤掉了：
 * 编辑器弹窗盖住整个看板，鼠标够不到底下的卡片，那条规则唯一能生效的时刻反而是
 * 关掉编辑器之后 —— 用户看到的是"hover 没反应、点一下又冒出来"。详见 WorkbenchKanban 里
 * .kb-card__actions 那段。所以这里现在**只是标记**，不影响任何交互。
 *
 * 刻意与 selectedTaskId 分开：后者在首次加载时就会自动落到某条任务上
 * （applyRestoredSelection 挑"当前项目上次打开的那条"），拿它当"点开过"
 * 会让一张从没被碰过的卡片莫名戴上标记。
 */
const boardOpenedTaskId = ref<string | null>(null)

/**
 * 从看板打开某个任务（把 L2 编辑器弹窗顶起来）。
 *
 * 两处必须显式处理：
 *   1. 看板上刚建的任务可能还没进 tasks.value（那边是独立拉取的项目/任务快照），
 *      所以先强制重拉一次任务列表，否则 selectedTask 查不到、右侧是空的。
 *   2. 重拉用 _loadDataTasks 而不是 loadTasks() 包装版 —— 后者会按"当前项目上次打开的任务"
 *      重挑选中项，把我们要打开的那条覆盖掉（跨项目任务尤其明显）。
 */
async function openTaskFromBoard(payload: { taskId: string; projectPath: string }) {
  await _loadDataTasks()
  selectedTaskId.value = payload.taskId
  boardOpenedTaskId.value = payload.taskId
  captureSnapshot()
  if (selectedTask.value) {
    rememberLastTask(canonicalProjectPath(currentProject.value.path), payload.taskId)
  }
  editorOpen.value = true
}

// ── 数据层（状态 + 加载 + CRUD） ─────────────────────────────────────────────
const {
  tasks, jobs, currentProject,
  connectSSE, disconnectSSE,
  loadCurrentProject, loadJobs,
  clearJobsByTask,
  loadTasks: _loadDataTasks
} = useWorkbenchData()

/**
 * 重拉任务列表后，按「当前项目最后一次打开的任务 → 当前项目首条 → 任意首条」重新决定选中项。
 *
 * 只适用于**恢复**语境（首次加载 / 切项目）。写操作后的刷新一律用 refreshTasks()：
 * 下面 `remembered.projectPath 必须属于当前项目` 那条护栏，本意是"刷新后别把别的项目的任务
 * 恢复成选中项"，不该在用户正编辑某条跨项目任务时把他手里的任务抢走。
 */
function applyRestoredSelection() {
  const cp = canonicalProjectPath(currentProject.value.path)
  // 决定"应该选中的 task id":优先恢复当前项目最后一次打开的 task,否则降级到当前项目下的首条,
  // 否则(完全没有当前项目的 task)降级到任意首条。
  const curProjectTasks = tasks.value.filter(t => !t.projectPath || canonicalProjectPath(t.projectPath) === cp)
  const map = readLastTaskMap()
  const rememberedId = (cp && map[cp]) || (!cp && map[NO_PROJECT_KEY]) || ''
  const remembered = rememberedId ? tasks.value.find(t => t.id === rememberedId) : null
  const fallback = curProjectTasks[0] || tasks.value[0] || null
  const desiredId = (remembered && remembered.projectPath && canonicalProjectPath(remembered.projectPath) !== cp) ? null
    : remembered ? remembered.id
    : fallback ? fallback.id
    : null
  selectedTaskId.value = desiredId
  captureSnapshot()
}

/**
 * 写操作成功后刷新任务列表，**保持当前选中的任务不变**。
 *
 * 为什么写操作后不能用 loadTasks()（2026-09-20 修，症状：改一下描述、自动保存后编辑器就空了）：
 *   loadTasks() 每次都会重跑上面的选中项推导，而 rememberedId 记的是"当前项目最后一次打开的任务"
 *   —— 键是当前项目，值却可能是用户从跨项目看板上点开的**别的项目**的任务。
 *   于是推导时撞上 `remembered.projectPath !== cp` 这条护栏，desiredId 直接算成 null：
 *   描述其实已经存好了，空掉的是界面里的选中项（右侧退回"请选择任务"占位）。
 *   编辑器允许打开跨项目任务（执行目录按 task.projectPath 走），所以这不是异常路径。
 *   触发它的入口就是"任务级字段的 1.5s 防抖自动保存"——每次自动保存都会走一遍 persistTask → 刷新。
 *
 * 选中项确实不存在了（被删 / 被后端清理）才退回恢复逻辑。
 */
async function refreshTasks() {
  const keepId = selectedTaskId.value
  await _loadDataTasks()
  if (keepId && tasks.value.some(t => t.id === keepId)) {
    captureSnapshot()
    return
  }
  applyRestoredSelection()
}

async function loadTasks() {
  await _loadDataTasks()
  applyRestoredSelection()
}
// 执行日志管理弹窗：默认收起，editor 视图保持常驻
const logsDialogVisible = ref(false)

const selectedTaskId = ref<string | null>(null)
const selectedTask = computed<Task | null>(() => tasks.value.find(t => t.id === selectedTaskId.value) || null)

/**
 * 看板任务快照：WorkbenchBoard 每轮轮询拿到的那一份，原样透传上来（见那边的 'board-tasks'）。
 *
 * 顶部细栏要显示的相对时间与「用时 x」，就是卡片上那两个值 —— 所以直接读**同一个对象**，
 * 而不是在编辑器这边拿 selectedTask + jobs 重算一遍：重算等于把后端 projectRegistry 的
 * column / lastDurationMs 口径在前端再实现一次，两处稍微一改就会分叉，而弹窗正盖在
 * 卡片上面，差一个字都看得见。取哪个时间戳、什么才算"跑过"，口径收口在 utils/taskTime.ts。
 *
 * 看板数据没到 / 里面还没有这条任务（刚建、轮询还没轮到）时为 null，细栏两段一起不渲染 ——
 * 宁可不显示，也不给一个自己推出来的数。
 */
const boardTasks = ref<BoardTask[]>([])
const selectedBoardTask = computed<BoardTask | null>(
  () => boardTasks.value.find(t => t.id === selectedTaskId.value) || null
)

/** 细栏右端的相对时间（与卡片右上角同一口径、同一个值） */
const barTimeText = computed(() =>
  selectedBoardTask.value ? relativeTimeFromIso(taskTimeIso(selectedBoardTask.value)) : ''
)
/**
 * 细栏右端的时长：跑过 →「用时 x」；**正在跑 →「已运行 x」**（那个数每 5s 随看板轮询一起长，
 * 不是 0，也不是上一轮留下的旧值）；从没跑过 / 缺时间戳 → 空串（不写"用时 —"占位）。
 */
const barDurationText = computed(() =>
  selectedBoardTask.value ? taskDurationText(selectedBoardTask.value) : ''
)
/** 相对时间那一段的悬停提示：起止两个绝对时刻（与卡片那行「用时」的 title 同一份实现） */
const barTimeTitle = computed(() =>
  selectedBoardTask.value ? taskTimeTitle(selectedBoardTask.value) : ''
)

/**
 * 打开的任务可能属于别的项目 —— L1 看板是跨项目的，L2 编辑器却只有一个"当前目录"。
 * 后端执行时按 task.projectPath 落目录（resolveTaskRepoPath），与编辑器当前目录无关，
 * 所以这里必须把"这条任务实际在哪个目录执行"明说出来：否则顶部返回栏写着 zen-gitsync、
 * 任务其实跑在 claw-sdd-project，用户会被自己的眼睛误导。
 * 同目录时返回 null，不占用栏位。
 */
const foreignRepo = computed<{ name: string; path: string } | null>(() => {
  const tp = selectedTask.value?.projectPath || ''
  if (!tp) return null
  if (canonicalProjectPath(tp) === canonicalProjectPath(currentProject.value.path)) return null
  const name = tp.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || tp
  return { name, path: tp }
})
// 当前选中 task 在磁盘上的快照（参与 dirty 比较的字段）。
// metaSnapshot 只记 task 自身可编辑的 title/desc（提示词快照是只读的，不进 dirty）。
// - captureSnapshot()  在 loadTasks / persistTask 成功后 / 切换 selectedTaskId 时调用
// - metaDirty    对比 selectedTask.{title,desc} 与 metaSnapshot
const metaSnapshot = ref<{
  title: string
  desc: string
}>({ title: '', desc: '' })

function captureSnapshot() {
  if (selectedTask.value) {
    metaSnapshot.value = {
      title: selectedTask.value.title,
      desc: selectedTask.value.desc
    }
  } else {
    metaSnapshot.value = { title: '', desc: '' }
  }
}

// ── 任务级字段（title / desc）自动保存 ────────────────────
// 改动后 1.5s 防抖自动落盘；切走/关页面前再 flush 一次。
// 状态机：idle → saving → saved(显示时间) → idle；失败回到 idle + 弹错。
type MetaSaveState = 'idle' | 'saving' | 'saved' | 'error'
const metaSaveState = ref<MetaSaveState>('idle')
const metaSavedAt = ref<number>(0)  // 上次成功落盘的时间戳
let metaSaveTimer: number | null = null

const metaDirty = computed(() => {
  if (!selectedTask.value) return false
  const t = selectedTask.value
  return metaSnapshot.value.title !== t.title
    || metaSnapshot.value.desc !== t.desc
})

function clearMetaSaveTimers() {
  if (metaSaveTimer !== null) { clearTimeout(metaSaveTimer); metaSaveTimer = null }
}

// ── 空任务不落盘 ────────────────────────────────────────────────────
// 「空任务」= 标题和描述都没填(点了新建就直接走人/刷新)。这种任务保留下来
// 只会在侧边栏留一行空白条目,所以不保存:切走时直接丢弃,首次加载时清理历史遗留。
// 判定刻意保守——带附件 / 带提示词快照的算不算空由下面逐条把关。
function isTaskBlank(t: Task | null | undefined): boolean {
  if (!t) return false
  if ((t.title || '').trim() || (t.desc || '').trim()) return false
  if ((t.simpleOverride || '').trim()) return false
  if (Array.isArray(t.attachments) && t.attachments.length > 0) return false
  return true
}

/**
 * 静默丢弃一个空任务:不弹确认、不动选中态(选中项靠 selectedTask 查不到自然变 null),
 * 删除失败也不阻塞后续流程——下次加载时的清理兜底会再收拾它。
 */
async function discardBlankTask(t: Task) {
  try {
    await fetch(`/api/workbench/tasks/${t.id}`, { method: 'DELETE' })
  } catch { /* 丢弃失败不阻塞:下次加载兜底清理 */ }
  const i = tasks.value.findIndex(x => x.id === t.id)
  if (i !== -1) tasks.value.splice(i, 1)
}

/**
 * 清理历史遗留的空任务(仅首次加载跑一次)。
 * 刻意跳过「当前选中」的空任务:那可能是用户刚点新建、正准备输入的那一个,
 * 由切走时的丢弃逻辑负责,这里删掉会让输入框瞬间消失。
 */
async function pruneBlankTasks() {
  const doomed = tasks.value.filter(t => t.id !== selectedTaskId.value && isTaskBlank(t))
  for (const t of doomed) await discardBlankTask(t)
}

async function flushMetaSave(): Promise<boolean> {
  if (!selectedTask.value) return false
  if (!metaDirty.value) return true
  metaSaveState.value = 'saving'
  const ok = await persistTask(false)
  if (ok) {
    metaSavedAt.value = Date.now()
    metaSaveState.value = 'saved'
    // 4s 后自动回到 idle，避免 UI 长期挂着 "已保存"
    setTimeout(() => {
      if (metaSaveState.value === 'saved' && Date.now() - metaSavedAt.value >= 4000) {
        metaSaveState.value = 'idle'
      }
    }, 4000)
    return true
  }
  metaSaveState.value = 'error'
  // 失败也走 4s 自动归位，避免"保存失败"标签一直挂在标题旁
  const failedAt = Date.now()
  setTimeout(() => {
    if (metaSaveState.value === 'error' && Date.now() - failedAt >= 4000) {
      metaSaveState.value = 'idle'
    }
  }, 4000)
  return false
}

// 监听 title/desc 变化 → 1.5s 防抖 → flushMetaSave
// 任何字段任一变化都重置计时器（写操作高频时合并）
watch(
  () => selectedTask.value
    ? {
        id: selectedTask.value.id,
        title: selectedTask.value.title,
        desc: selectedTask.value.desc
      }
    : null,
  (cur, prev) => {
    // 首次建立 / 切换 task：prev 为 undefined 或 id 变了 → 不自动保存
    if (!cur || !prev || cur.id !== prev.id) return
    if (metaSaveTimer !== null) clearTimeout(metaSaveTimer)
    metaSaveTimer = window.setTimeout(() => { flushMetaSave() }, 1500)
  },
  { deep: true }
)

// 切换 selectedTaskId 时立刻 flush 当前 task 的未保存改动
// 避免「改了 desc 立刻点别的任务 → desc 丢失」/「程序式切换(创建/删除后)丢改动」
watch(selectedTaskId, async (_n, _o) => {
  clearMetaSaveTimers()
  // selectTask() 自己会负责 flush；这里作为兜底：捕获那些没经过 selectTask
  // 直接改 selectedTaskId 的路径(创建后切到新 task、删除当前 task 后切走等)。
  if (selectedTask.value && metaDirty.value) {
    await flushMetaSave()
  }
  // 新 task 选中时 captureSnapshot() 会在 selectTask() / loadTasks() 内同步调用
})

// currentProject 加载完后(loadTasks 与 loadCurrentProject 并发,loadTasks 可能先跑完 cp 还为空),
// 如果当前选中的 task 不属于当前项目,清掉并走 loadTasks 里的恢复逻辑重选。
watch(currentProject, async (n) => {
  if (!n.path) return
  const cp = canonicalProjectPath(n.path)
  const cur = selectedTask.value
  if (cur && cur.projectPath && canonicalProjectPath(cur.projectPath) !== cp) {
    await loadTasks()
  }
})

// 离开页面 / 切到别的 task 前尝试 flush（best-effort）
// 用 sendBeacon 保证 fetch 在 unload 后也能完成
function beaconPersist(task: Task) {
  try {
    const blob = new Blob([JSON.stringify(task)], { type: 'application/json' })
    navigator.sendBeacon?.('/api/workbench/tasks', blob)
  } catch { /* swallow */ }
}
function onBeforeUnloadPersist() {
  // 空任务(标题/描述都没填)不落盘:写进去反而会留下空白条目,交给下次加载时清理
  if (selectedTask.value && metaDirty.value && !isTaskBlank(selectedTask.value)) {
    beaconPersist(selectedTask.value)
  }
}

// 任务描述（主任务 desc + 附件）默认折叠，避免撑满首屏、把对话区挤到折叠线以下
// （内容不空也不自动展开：有内容时摘要行右侧有「已填写」徽标 + 附件数作为信号）
const taskDescExpanded = ref(false)

/** 复制文本到剪贴板，失败时降级到 textarea + execCommand。 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* 降级 */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/**
 * 复制任务标题/描述的小工具：
 * - 复制成功 → 短暂切换 icon 为 ✓（1.5s 后还原），并在 1.5s 内显示已复制提示
 * - 复制失败 → 弹 ElMessage.error 并保持原 icon
 * - title/desc 都为空时弹 warning，不进入复制流程
 */
const copyTitleFlashId = ref<string | null>(null)
const copyDescFlashId = ref<string | null>(null)

async function copyTaskTitle(t: Task | null) {
  if (!t) return
  const text = (t.title || '').trim() || $t('@WORKBENCH:未命名任务')
  const ok = await copyToClipboard(text)
  if (!ok) {
    ElMessage.error($t('@WORKBENCH:复制失败'))
    return
  }
  copyTitleFlashId.value = t.id
  ElMessage.success($t('@WORKBENCH:已复制任务标题'))
  window.setTimeout(() => {
    if (copyTitleFlashId.value === t.id) copyTitleFlashId.value = null
  }, 1500)
}

async function copyTaskDesc(t: Task | null) {
  if (!t) return
  const text = (t.desc || '').trim()
  if (!text) {
    ElMessage.warning($t('@WORKBENCH:任务描述为空,无需复制'))
    return
  }
  const ok = await copyToClipboard(text)
  if (!ok) {
    ElMessage.error($t('@WORKBENCH:复制失败'))
    return
  }
  copyDescFlashId.value = t.id
  ElMessage.success($t('@WORKBENCH:已复制任务描述'))
  window.setTimeout(() => {
    if (copyDescFlashId.value === t.id) copyDescFlashId.value = null
  }, 1500)
}

// 任务对话流（通 useWorkbenchSimpleConversation 合并 jobs → ChatMessage[]）
const { simpleConversationMessages, simpleAllJobsFor, simpleJobFor, simpleJobState } = useWorkbenchSimpleConversation(jobs, selectedTask)

// ── 一键复制「任务执行内容」──────────────────────────────────────────────────
// 复制的是**这条任务全部轮次**（首次执行 + N 次续聊）的对话流，不是当前屏幕上选中的
// 那一段文本 —— 所以走 utils/taskExecutionExport.ts 从 job 数据现拼，而不是读 DOM /
// window.getSelection()：对话区是 v-for 渲染的，用户在中间划一段再点复制的话，
// "复制了半截"比"复制了全部"更难发现。
//
// 两种范围（下拉菜单）：
//   - 精简（brief）：提示词 + 模型回复 —— 按钮**直接点**就是这个，因为它才是常用形态，
//     思考和工具调用是体积大头（一轮续聊实测几万字符），粘给另一个 AI 时大多是噪音。
//   - 全量（full）：提示词 / 思考 / 工具调用 / 模型回复，走菜单里那一项。
const copyExecFlashId = ref<string | null>(null)

/**
 * 任务实际执行所在目录名。跨项目任务（从看板点开的别的项目的任务）按 task.projectPath 算，
 * 不是编辑器当前项目 —— 与顶部返回栏 foreignRepo 的口径一致。
 */
function taskRepoName(t: Task | null): string {
  const p = (t?.projectPath || '').trim().replace(/[\\/]+$/, '')
  if (p) return p.split(/[\\/]/).pop() || p
  return currentProject.value.name || ''
}

async function copyTaskExecution(t: Task | null, scope: TaskExecutionScope = 'brief') {
  if (!t) return
  const text = buildTaskExecutionText(simpleAllJobsFor(t), {
    title: t.title,
    projectName: taskRepoName(t)
  }, { scope })
  // 空串 = 这条任务一轮有内容的执行都没有（新建后还没跑过 / 执行内容被清空过）
  if (!text) {
    ElMessage.warning($t('@WORKBENCH:暂无执行内容可复制'))
    return
  }
  const ok = await copyToClipboard(text)
  if (!ok) {
    ElMessage.error($t('@WORKBENCH:复制失败'))
    return
  }
  copyExecFlashId.value = t.id
  ElMessage.success($t('@WORKBENCH:已复制执行内容'))
  window.setTimeout(() => {
    if (copyExecFlashId.value === t.id) copyExecFlashId.value = null
  }, 1500)
}

/** 下拉菜单选了某个范围（命令值就是 `TaskExecutionScope`） */
function onCopyExecCommand(cmd: string | number | object) {
  copyTaskExecution(selectedTask.value, cmd === 'full' ? 'full' : 'brief')
}

// ── 打开任务时把对话流钉到最底部 ─────────────────────────────────────────────
// 症状（2026-09-29 用户报）：从看板点开一条跑过的任务，对话区停在**最上面**那轮
// （那条巨大的「运行环境」注入消息），得手动往下滚才能看到最新的回复。
//
// 根因（探针实测，不是猜）：zen-ai-chat-ui 的 MessageList 只在 onMounted 里滚一次底，
// 而那一刻 el-dialog 的内容还没参与布局 —— 探针抓到那次 scrollTo 时
// scrollHeight = 0、clientHeight = 0，等于空转。内容随后才长起来
// （0 → 371 → 1573 → 2542，全在挂载后 ~500ms 内），而库里后续的"自动贴底"只挂在
// 「消息条数 / 末条正文长度 / 末条思考长度」这类**字符串签名**上；markdown 异步高亮
// （shiki）、工具调用分组折叠都是"签名没变、高度变了"，于是没人再滚第二次，视图留在顶部。
//
// 所以补一次 scrollToBottom 不够（只能滚到"当时"的底，之后内容还在长，照样停在半截）。
// 这里用 ResizeObserver 盯住滚动容器 + 内容层，在整个收敛期里高度一变就补滚一次，
// 直到窗口期结束，或者用户自己碰了滚动区（别把正在往回翻记录的人硬拽到底）。
//
// 观察的是 zen-ai-chat-ui 的内部类名 `.acu-message-list` —— 和本文件 CSS 里的
// `:deep(.acu-message-list)` 是同一份依赖，库没暴露"列表滚动容器"的 ref，只能这样拿。
const CHAT_PIN_WINDOW_MS = 3000
/** 用户在收敛期里的滚动意图事件：一旦出现就撒手（程序化的 scrollTo 不会触发这些） */
const CHAT_PIN_USER_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const

const chatRef = ref<InstanceType<typeof ChatContainer> | null>(null)
const chatWrapRef = ref<HTMLElement | null>(null)
let chatPinRO: ResizeObserver | null = null
let chatPinTimer: ReturnType<typeof setTimeout> | null = null
let chatPinEl: HTMLElement | null = null

/** 收工：停观察、拆定时器、摘用户意图监听（幂等，可重复调用） */
function stopChatPin() {
  if (chatPinRO) { chatPinRO.disconnect(); chatPinRO = null }
  if (chatPinTimer !== null) { clearTimeout(chatPinTimer); chatPinTimer = null }
  if (chatPinEl) {
    for (const ev of CHAT_PIN_USER_EVENTS) chatPinEl.removeEventListener(ev, stopChatPin)
    chatPinEl = null
  }
}

/** 立即滚到底，并在收敛期里持续贴底 */
function pinChatToBottom() {
  stopChatPin()
  const inst = chatRef.value
  if (!inst) return
  inst.scrollToBottom?.(false)
  const list = chatWrapRef.value?.querySelector<HTMLElement>('.acu-message-list')
  if (!list || typeof ResizeObserver === 'undefined') return
  chatPinEl = list
  for (const ev of CHAT_PIN_USER_EVENTS) list.addEventListener(ev, stopChatPin, { passive: true })
  // 容器本身（0 → 有高度 = 弹窗布局就位）和内容层（正文异步长高）都要盯
  chatPinRO = new ResizeObserver(() => chatRef.value?.scrollToBottom?.(false))
  chatPinRO.observe(list)
  if (list.firstElementChild) chatPinRO.observe(list.firstElementChild)
  chatPinTimer = setTimeout(stopChatPin, CHAT_PIN_WINDOW_MS)
}

// ChatContainer 只在"这条任务真有对话记录"时才渲染（模板里那个 v-if），
// 用它的渲染条件当 key：换任务、或 jobs 异步到货补上记录时，key 都会从 '' 跳到 taskId。
const chatRenderKey = computed(() =>
  editorOpen.value && selectedTask.value && simpleAllJobsFor(selectedTask.value).length > 0
    ? selectedTask.value.id
    : ''
)

watch(chatRenderKey, async (key) => {
  stopChatPin()
  if (!key) return
  await nextTick()
  pinChatToBottom()
})

onBeforeUnmount(stopChatPin)

/**
 * 左侧任务条目"是否执行中"的统一判断。父组件传给 WorkbenchSidebar。
 * 一条任务 = 一次会话：查 jobs（subId = ${task.id}__simple 或 __rN 后缀），
 * 取最新一条 job，pending/running 都算在跑。
 *
 * 判定本身在 useWorkbenchExecution 里（排队续聊也要用同一个口径，不能各算一遍），
 * 这里只是把 Task 拆成 id 转发过去。
 */
function isTaskRunning(t: Task): boolean {
  if (!t) return false
  return isTaskRunningById(t.id)
}

/** 这条任务跑过没有 —— 决定执行按钮叫「执行任务」还是「重新执行任务」 */
const selectedTaskHasRun = computed(() => simpleAllJobsFor(selectedTask.value).length > 0)
const selectedTaskRunning = computed(() => isTaskRunning(selectedTask.value as Task))

/** 执行按钮的悬停说明：只在"文案与行为不一致会让人误判"的两种状态下给 */
const runButtonTitle = computed(() => {
  if (!selectedTask.value) return ''
  if (selectedTaskRunning.value) return $t('@WORKBENCH:正在执行中,请先「停止」再重新执行')
  return selectedTaskHasRun.value ? $t('@WORKBENCH:重新跑一轮:上一轮的执行记录会被清空') : ''
})

/** 任务「提示词」只读展示：派发时冻结的分段快照（全局/项目两段）；
 *  老任务（合并前派发的）没有分段字段，回退整段展示 simpleOverride。 */
const selectedTaskPromptParts = computed<{ key: string; label: string; text: string }[]>(() => {
  const t = selectedTask.value
  if (!t) return []
  const parts = t.promptParts
  if (parts && (parts.global || parts.project)) {
    const list: { key: string; label: string; text: string }[] = []
    if (parts.global) list.push({ key: 'global', label: $t('@WORKBENCH:全局提示词'), text: parts.global })
    if (parts.project) list.push({ key: 'project', label: $t('@WORKBENCH:项目提示词'), text: parts.project })
    return list
  }
  const legacy = (t.simpleOverride || '').trim()
  if (legacy) return [{ key: 'legacy', label: $t('@WORKBENCH:提示词'), text: legacy }]
  return []
})

// clearExecutionForSelectedTask → 来自 useWorkbenchExecution

// ── 任务 CRUD ───────────────────────────────────────────────────────────────
// 新建任务:点按钮直接创建空任务,自动选中,右侧立即出现编辑器。不再走弹窗。
// - 任务级 title / desc 在右侧 inline 编辑（标题输入、描述折叠面板）；
//   提示词是派发时冻结的只读快照，不参与编辑。
// - 标题为空由后端存储 '' / 前端模板 fallback 显示「未命名任务」,跟弹窗里"不填则自动命名"语义一致。
// - 连续点击防并发:creatingTask 标志位 + 按钮 disabled。
// - 创建后标题输入框自动聚焦,直接打字即可起标题(免去鼠标移到输入框)。
const creatingTask = ref(false)
const titleInputRef = ref<HTMLInputElement | null>(null)
const taskDescTextareaRef = ref<HTMLTextAreaElement | null>(null)

/**
 * 自适应 textarea 高度:
 * - 每次输入后重置 height=auto 让 scrollHeight 重新计算,然后 clamp 到 [minPx, maxPx]
 * - 同时清掉 resize 拖拽手柄(resize:none),避免手动拖拽高度破坏自适应逻辑
 * - 切走任务再切回来时 selectedTask.desc 可能已变,触发 watch 走同一逻辑
 * - 焦点状态下使用更大的最大高度，方便查看输入内容
 */
const DESC_TEXTAREA_MIN_PX = 52
const DESC_TEXTAREA_MAX_PX = 320
const DESC_TEXTAREA_MAX_PX_FOCUS = 500

function autoGrowTextarea(ev?: Event) {
  const el = (ev?.currentTarget as HTMLTextAreaElement | null) || taskDescTextareaRef.value
  if (!el) return
  // 重置回 auto 让浏览器能正确算出真实高度(只设 height 不会触发重新计算)
  el.style.height = 'auto'
  // 焦点状态下使用更大的最大高度
  const isFocused = document.activeElement === el
  const maxPx = isFocused ? DESC_TEXTAREA_MAX_PX_FOCUS : DESC_TEXTAREA_MAX_PX
  const next = Math.min(Math.max(el.scrollHeight, DESC_TEXTAREA_MIN_PX), maxPx)
  el.style.height = `${next}px`
  // 内容超过 max 时启用内部滚动条
  el.style.overflowY = el.scrollHeight > maxPx ? 'auto' : 'hidden'
}

// 默认折叠时首屏不渲染 textarea 高度；一旦展开（含首屏是展开态的历史会话）都补一次 recalc，
// 否则切换任务后 textarea 会沿用上一个任务写入的 height。
watch(taskDescExpanded, async (open) => {
  if (open) {
    await nextTick()
    autoGrowTextarea()
  }
})
// 切换/新建任务时,如果描述是展开着的,需要重新计算一次高度
// (上一任务写入的 height 可能不是新任务的最佳值)
watch(
  () => selectedTask.value?.id,
  async () => {
    if (taskDescExpanded.value) {
      await nextTick()
      autoGrowTextarea()
    }
  }
)
async function createTaskDirect() {
  if (creatingTask.value) return
  creatingTask.value = true
  const body: any = {
    title: '',
    desc: ''
  }
  // 附带当前项目路径,后续按项目分组显示;没有当前项目时后端走默认
  if (currentProject.value.path) {
    body.projectPath = currentProject.value.path
  }
  try {
    const res = await fetch('/api/workbench/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(r => r.json())
    if (!res.success) {
      ElMessage.error(res.error || $t('@WORKBENCH:保存失败'))
      return
    }
    // 先 flush 当前 task 的未保存改动,避免"点了新建 → 老 task 的标题改动丢"
    clearMetaSaveTimers()
    if (selectedTask.value && isTaskBlank(selectedTask.value)) {
      // 上一个 task 是点新建后什么都没填的空任务:直接丢弃,不落盘(否则点两次
      // 新建就会攒出两行空白)
      await discardBlankTask(selectedTask.value)
    } else if (selectedTask.value && metaDirty.value) {
      await flushMetaSave()
    }
    await loadTasks()
    if (res.task?.id) {
      selectedTaskId.value = res.task.id
      captureSnapshot()
      ElMessage.success($t('@WORKBENCH:已新建任务'))
      // 等右侧 v-if 渲染出新任务的标题输入框后再聚焦
      await nextTick()
      titleInputRef.value?.focus()
    }
  } finally {
    creatingTask.value = false
  }
}
async function deleteTask(t: Task) {
  await ElMessageBox.confirm(
    $t('@WORKBENCH:删除任务「{title}」？', { title: t.title }),
    $t('@WORKBENCH:确认'),
    { type: 'warning' }
  )
  await fetch(`/api/workbench/tasks/${t.id}`, { method: 'DELETE' })
  if (selectedTaskId.value === t.id) selectedTaskId.value = null
  loadTasks()
}

/**
 * 复制任务：基于源任务创建一个新任务，标题加"副本"后缀，
 * 保留 desc 与派发时冻结的提示词快照（simpleOverride / promptParts）。
 */
async function copyTask(t: Task) {
  const baseTitle = (t.title || $t('@WORKBENCH:未命名任务')).trim()
  const copyTitle = $t('@WORKBENCH:{title} (副本)', { title: baseTitle })
  const body: any = {
    title: copyTitle,
    desc: t.desc || '',
    simpleOverride: t.simpleOverride || ''
  }
  if (t.promptParts && (t.promptParts.global || t.promptParts.project)) {
    body.promptParts = t.promptParts
  }
  if (currentProject.value.path) {
    body.projectPath = currentProject.value.path
  }
  try {
    const res = await fetch('/api/workbench/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(r => r.json())
    if (!res.success) {
      ElMessage.error(res.error || $t('@WORKBENCH:复制失败'))
      return
    }
    await loadTasks()
    if (res.task?.id) {
      selectedTaskId.value = res.task.id
      captureSnapshot()
    }
    ElMessage.success($t('@WORKBENCH:已复制任务'))
  } catch (err: any) {
    ElMessage.error($t('@WORKBENCH:网络错误: ') + (err && err.message || err))
  }
}
async function selectTask(t: Task) {
  if (selectedTaskId.value === t.id) return
  // 切换前先把当前 task 的未保存 title/desc 落盘
  clearMetaSaveTimers()
  const leaving = selectedTask.value
  if (leaving && isTaskBlank(leaving)) {
    // 空任务(标题/描述都没填)不落盘:切走即丢弃,不给侧边栏留空白行
    await discardBlankTask(leaving)
  } else if (leaving && metaDirty.value) {
    await flushMetaSave()
  }
  selectedTaskId.value = t.id
  // 切换后立刻拍快照，避免新 task 误标为 dirty
  captureSnapshot()
  // 记忆「该项目最后一次打开的 task」,便于下次刷新 / 重进工作台时优先恢复
  rememberLastTask(canonicalProjectPath(currentProject.value.path), t.id)
}

// ── 拖动排序：父组件负责落盘 + 乐观更新 + 失败回滚 ──────────────────
// sidebar 已经 emit 出目标 group 内的新 id 顺序。这里:
//   1) 备份原数组
//   2) 在原数组中按 orderedIds 重排目标 group 的 task(其他 group 保持原相对位置)
//   3) 乐观更新 tasks.value → sidebar 立刻按新顺序渲染
//   4) 调 PUT /api/workbench/tasks/reorder 落盘
//   5) 失败回滚到 snapshot + ElMessage.error
//   6) 成功无操作(后端会 publish 'tasks:reordered' 事件,客户端 SSE 整组覆盖,等价)
async function reorderTasks(payload: { groupPath: string; orderedIds: string[] }) {
  const { groupPath, orderedIds } = payload
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) return
  const snapshot = tasks.value.slice()
  const reordered = applyLocalReorder(tasks.value, groupPath, orderedIds)
  if (reordered === tasks.value) return // 校验失败,sidebar 误调,忽略
  tasks.value = reordered
  try {
    const res = await fetch('/api/workbench/tasks/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds, groupPath })
    }).then(r => r.json()).catch(() => ({ success: false, error: $t('@WORKBENCH:排序保存失败') }))
    if (!res?.success) {
      tasks.value = snapshot
      ElMessage.error(res?.error || $t('@WORKBENCH:排序保存失败'))
    }
  } catch (err: any) {
    tasks.value = snapshot
    ElMessage.error($t('@WORKBENCH:排序保存失败') + ': ' + (err?.message || err))
  }
}

/**
 * 把 list 中 projectPath === groupPath 的 task 按 orderedIds 顺序排,其余保持相对位置。
 * 分组规则与 useWorkbenchProjectGroups 一致:每个项目独立成组,未关联项目归入 NO_PROJECT_KEY。
 * 校验:orderedIds 长度必须等于同组 task 数,且都是同组 id(避免 sidebar 误调)。
 * 校验失败返回原 list(让 reorderTasks 走 no-op 兜底)。
 */
function applyLocalReorder(
  list: Task[],
  groupPath: string,
  orderedIds: string[]
): Task[] {
  const groupKey = (p?: string) => (canonicalProjectPath(p) || NO_PROJECT_KEY)
  const inGroupIds = list.filter(t => groupKey(t.projectPath) === groupPath).map(t => t.id)
  const inGroupSet = new Set(inGroupIds)
  if (orderedIds.length !== inGroupSet.size || orderedIds.some(id => !inGroupSet.has(id))) {
    return list
  }
  const byId = new Map(list.map(t => [t.id, t]))
  const orderedInGroup = orderedIds.map(id => byId.get(id)!).filter(Boolean)
  const result: Task[] = []
  let ptr = 0
  for (const t of list) {
    if (groupKey(t.projectPath) === groupPath) {
      result.push(orderedInGroup[ptr++])
    } else {
      result.push(t)
    }
  }
  return result
}

/**
 * 把 selectedTask 整 task 体提交到后端。
 * 成功 → 静默刷新 selectedTaskId 指向的任务（保留 attachments 等后端规范化字段）。
 * 失败 → 弹错误条。
 * @param showSuccess 是否弹「已保存」提示（手动点保存时为 true，隐式保存为 false）
 */
async function persistTask(showSuccess: boolean): Promise<boolean> {
  if (!selectedTask.value) return false
  const res = await fetch('/api/workbench/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(selectedTask.value)
  }).then(r => r.json())
  if (res.success) {
    if (showSuccess) ElMessage.success($t('@WORKBENCH:已保存'))
    // 刷新必须保留选中项：这条路径由 1.5s 防抖自动保存高频触发，
    // 一旦在这里重推导选中项，跨项目任务会瞬间被清空（见 refreshTasks 注释）
    await refreshTasks()
    return true
  } else {
    ElMessage.error(res.error || $t('@WORKBENCH:保存失败'))
    return false
  }
}

// ── 执行（其余执行函数来自 useWorkbenchExecution） ──

onMounted(async () => {
  await Promise.all([loadTasks(), loadCurrentProject(), loadJobs()])
  // 首次加载清一次历史遗留的空任务(以前点新建没填东西留下的空白行)
  await pruneBlankTasks()
  connectSSE()
  window.addEventListener('beforeunload', onBeforeUnloadPersist)
  // 执行器的当前模型（下拉项右侧要显示）。App 里 startPolling 也会拉一次，
  // 两边都调不重复请求：store 内部有并发去重 + 10 分钟 TTL
  void toolsStore.fetchExecutorModels()
})
onBeforeUnmount(() => {
  disconnectSSE()
  window.removeEventListener('beforeunload', onBeforeUnloadPersist)
  // 卸载时同步 flush 一次（sendBeacon 不支持时也能尽量保住）
  if (selectedTask.value && metaDirty.value && !isTaskBlank(selectedTask.value)) {
    beaconPersist(selectedTask.value)
  }
})

// ── 日志详情面板已抽到 components/JobLogDetails.vue（自动滚动 / 复制 / 截断都在那里）
// ── 附件上传已抽到 composables/useWorkbenchAttachments.ts ────────────
const {
  pasteHoverId,
  isUploading, isImageAttachment, humanSize,
  onAttachmentPaste, onAttachmentDrop,
  uploadAttachment, removeAttachment, pickAttachmentFile
} = useWorkbenchAttachments()

// ── 执行层（run/cancel/continue/clear 等核心交互逻辑） ──
const {
  runTask, onContinueSendFromChat,
  cancelJob, clearExecutionForSelectedTask,
  // 重命名：本文件里已有一个按 Task 判定的 isTaskRunning（见下方 640 行附近），
  // 那边改成委托给这一份，全仓只留一个"这条任务在不在跑"的口径
  isTaskRunning: isTaskRunningById,
  queuedChatsOf, removeQueuedChat, flushNextQueued
} = useWorkbenchExecution(
  jobs, tasks, selectedTask,
  {
    clearJobsByTask,
    persistTask,
    uploadAttachment,
    getExecutor: () => selectedTaskExecutor.value
  }
)

// ── 任务执行器（claude | opencode | codex）────────────────────────────
// 「上次用过哪个」与「设置里的默认值」都收口在 composables/useTaskExecutorSelection：
// 执行按钮旁临时切一下即落 config.json（ui.lastTaskExecutor），下次打开还停在这儿。
// 选中项没装时的回落也在那儿（纯计算，不写回），这里不再自己纠偏一遍。
const {
  active: selectedTaskExecutor,
  availability: executorAvailability,
  hasAnyExecutor,
  choose: pickExecutor,
  executorModelText,
  executorModelTitle,
} = useTaskExecutorSelection()

function executorLabel(id: TaskExecutorId): string {
  return taskExecutorName(id)
}

// 任务连续对话流的助手名/头像：跟随最近一轮 job 实际用的执行器。
// 头像与名字同源（agentAvatar 的 avatarForExecutor），claude → Claude 品牌图，依此类推。
const lastSimpleJob = computed(() => simpleAllJobsFor(selectedTask.value).slice(-1)[0])
const simpleAssistantLabel = computed(() => taskExecutorName(lastSimpleJob.value?.agent))
const simpleAssistantAvatar = computed(() => avatarForExecutor(lastSimpleJob.value?.agent))

// 排队续聊：任务在跑时输入框照样能用，发出去的内容先排队（见 useWorkbenchExecution）。
// 「在不在跑」不在这儿另算一遍 —— 直接用上面那个 isTaskRunning / selectedTaskRunning。
const selectedTaskQueue = computed(() =>
  selectedTask.value ? queuedChatsOf(selectedTask.value.id) : []
)
</script>

<template>
  <div class="workbench">
    <!-- L1：多项目编排台 —— **常驻底图**，不再与编辑器互斥 -->
    <WorkbenchBoard
      :opened-task-id="boardOpenedTaskId"
      @open-task="openTaskFromBoard"
      @board-tasks="boardTasks = $event"
    />

    <!-- L2：单任务编辑器 —— 大弹窗浮在看板之上，关掉即回到原位，全程无跳转 -->
    <CommonDialog
      v-model="editorOpen"
      :title="$t('@WORKBENCH:任务执行')"
      type="flex"
      height-mode="fixed"
      height-offset="88px"
      top="2vh"
      width="min(1520px, 96vw)"
    >
    <div class="wb-editor">
    <!-- 顶部细栏：关闭入口做成独立一条，而不是塞进任务头 ——
         没选中任务时（右侧是空态占位）也需要它，塞进任务头就会出现"进了编辑器却关不掉"的死角。 -->
    <div class="wb-editor-bar">
      <button
        type="button"
        class="wb-back-btn"
        :title="$t('@WORKBENCH:返回看板')"
        @click="closeEditor"
      >
        <el-icon class="wb-back-btn__icon"><ArrowLeft /></el-icon>
        <span>{{ $t('@WORKBENCH:返回看板') }}</span>
      </button>
      <span class="wb-editor-bar__project" :title="currentProject.path">{{ currentProject.name }}</span>
      <span
        v-if="foreignRepo"
        class="wb-editor-bar__repo"
        :title="foreignRepo.path"
      >{{ $t('@WORKBENCH:执行于 {name}', { name: foreignRepo.name }) }}</span>
      <!--
        当前任务的时间 / 用时 —— 与看板卡片右上角的相对时间、卡片那行「用时 x」同一口径
        （值直接取自看板轮询下来的同一条 BoardTask，所以是逐字一致，不是"两边写法对齐"）。

        三个分支：跑过 →「用时 7 分 16 秒」；正在跑 →「已运行 3 分 20 秒」（随轮询长）；
        从没跑过 / 缺时间戳 → 整段不渲染，不写「用时 —」这类占位。

        摆在右端、紧挨「任务执行」标：它是"这条任务怎么样"的补充说明，不该挤进左边那四个
        "我在哪 / 打开的是谁"的信息。窄容器下这一块**先让位**（flex-shrink 远大于其余项，
        一路收到 0），「返回看板 / 项目名 / 执行于 xxx」的宽度全程不变
        （±1px 是 flex 按比例分摊缺口的取整，见样式那段）。
        悬停提示只挂在相对时间上：绝对值区间解释的是"什么时候"，用时本身不用再解释。
      -->
      <span v-if="barTimeText || barDurationText" class="wb-editor-bar__time">
        <span v-if="barTimeText" class="wb-editor-bar__ago" :title="barTimeTitle">{{ barTimeText }}</span>
        <span v-if="barTimeText && barDurationText" class="wb-editor-bar__sep" aria-hidden="true">·</span>
        <span v-if="barDurationText" class="wb-editor-bar__spent">{{ barDurationText }}</span>
      </span>
      <span class="wb-editor-bar__hint">{{ $t('@WORKBENCH:任务执行') }}</span>
    </div>
    <div class="workbench__editor-row">
    <WorkbenchSidebar
      :style="{ width: sidebarWidth + 'px' }"
      :tasks="tasks"
      :selected-task-id="selectedTaskId"
      :current-project="currentProject"
      :creating-task="creatingTask"
      :is-task-running="isTaskRunning"
      @select-task="selectTask"
      @delete-task="deleteTask"
      @copy-task="copyTask"
      @create-task="createTaskDirect"
      @reorder-tasks="reorderTasks"
    />
    <div
      class="wb-splitter"
      role="separator"
      tabindex="0"
      aria-orientation="vertical"
      :aria-label="$t('@WORKBENCH:拖动调整侧边栏宽度')"
      :aria-valuenow="sidebarWidth"
      :aria-valuemin="SIDEBAR_MIN_W"
      :aria-valuemax="SIDEBAR_MAX_W"
      :title="$t('@WORKBENCH:拖动调整侧边栏宽度')"
      @mousedown="onSidebarSplitterMouseDown"
      @keydown.left.prevent="nudgeSidebarWidth(-16)"
      @keydown.right.prevent="nudgeSidebarWidth(16)"
    />

    <!-- 中：单任务编辑区 -->
    <section class="wb-split">
      <div v-if="!selectedTask" class="wb-placeholder">
        <p>{{ $t('@WORKBENCH:左侧选择任务，或新建一个任务开始') }}</p>
      </div>
      <template v-else>
        <div class="wb-split__header">
          <div class="wb-split__title-wrap">
            <input
              ref="titleInputRef"
              class="wb-input wb-input--title"
              v-model="selectedTask.title"
              :placeholder="$t('@WORKBENCH:任务标题')"
              :aria-label="$t('@WORKBENCH:任务标题')"
            />
            <button
              type="button"
              class="wb-copy-btn"
              :class="{ 'is-flash': copyTitleFlashId === selectedTask.id }"
              :title="$t('@WORKBENCH:复制任务标题')"
              :aria-label="$t('@WORKBENCH:复制任务标题')"
              @click="copyTaskTitle(selectedTask)"
            >
              <el-icon class="wb-copy-btn__icon" v-if="copyTitleFlashId !== selectedTask.id"><CopyDocument /></el-icon>
              <el-icon class="wb-copy-btn__icon wb-copy-btn__icon--check" v-else>✓</el-icon>
            </button>
          </div>
          <span
            v-if="metaSaveState !== 'idle' || metaDirty"
            class="wb-meta-save"
            :class="{
              'is-saving': metaSaveState === 'saving',
              'is-saved': metaSaveState === 'saved',
              'is-error': metaSaveState === 'error',
              'is-dirty': metaDirty && metaSaveState === 'idle'
            }"
            :title="metaSaveState === 'saving' ? $t('@WORKBENCH:保存中…')
              : metaSaveState === 'error' ? $t('@WORKBENCH:保存失败')
              : metaSaveState === 'saved' ? $t('@WORKBENCH:已保存')
              : ''"
          >
            <span v-if="metaSaveState === 'saving'" class="wb-meta-save__dot" />
            <span v-else-if="metaSaveState === 'saved'" class="wb-meta-save__check">✓</span>
            <span v-else-if="metaSaveState === 'error'" class="wb-meta-save__bang">!</span>
            <span v-else class="wb-meta-save__dot" />
            {{
              metaSaveState === 'saving' ? $t('@WORKBENCH:保存中…')
              : metaSaveState === 'saved' ? $t('@WORKBENCH:已保存')
              : metaSaveState === 'error' ? $t('@WORKBENCH:保存失败')
              : $t('@WORKBENCH:有未保存的更改')
            }}
          </span>
          <!--
            执行：split button —— 主体按当前选中执行器直接跑，下拉临时切换执行器。
            文案随执行状态变（2026-10-01）：这条任务已经有执行记录时改叫「重新执行任务」，
            因为 runTask 会先清掉旧 job 再开新一轮 —— 挂着「执行任务」会让人以为是接着上一轮跑。
            在跑的时候直接禁用：服务端本来就拒（400 该任务已有正在执行的 job），
            点了只是白跑一趟，还想让人误以为新起了一轮。
          -->
          <el-dropdown
            v-if="hasAnyExecutor"
            split-button
            type="primary"
            class="wb-executor-split"
            trigger="click"
            :disabled="selectedTaskRunning"
            :title="runButtonTitle"
            @click="runTask(selectedTask)"
            @command="pickExecutor"
          >
            {{ selectedTaskHasRun ? $t('@WORKBENCH:重新执行任务') : $t('@WORKBENCH:执行任务') }}
            <span class="wb-executor-split__hint" :title="executorModelTitle(selectedTaskExecutor)">
              <TaskExecutorIcon :executor="selectedTaskExecutor" class="wb-executor-split__hint-icon" />
              {{ executorLabel(selectedTaskExecutor) }}
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  v-for="opt in TASK_EXECUTOR_OPTIONS"
                  :key="opt.id"
                  :command="opt.id"
                  :disabled="!executorAvailability[opt.id]"
                >
                  <span class="wb-executor-item">
                    <TaskExecutorIcon :executor="opt.id" class="wb-executor-item__icon" />
                    <span class="wb-executor-item__name">{{ opt.name }}</span>
                    <span
                      v-if="executorModelText(opt.id)"
                      class="wb-executor-item__model"
                      :title="executorModelTitle(opt.id)"
                    >{{ executorModelText(opt.id) }}</span>
                    <el-icon v-if="selectedTaskExecutor === opt.id" class="wb-executor-item__check"><Check /></el-icon>
                    <span v-else-if="!executorAvailability[opt.id]" class="wb-executor-item__missing">{{ $t('@42BB9:未安装') }}</span>
                  </span>
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <div v-else class="wb-no-claude-hint" role="status">
            <el-icon class="wb-no-claude-hint__icon"><Warning /></el-icon>
            <span class="wb-no-claude-hint__text">{{ $t('@WORKBENCH:未检测到本地 claude / opencode,无法执行任务') }}</span>
            <a
              class="wb-no-claude-hint__link"
              href="https://docs.claude.com/en/docs/claude-code/setup"
              target="_blank"
              rel="noopener noreferrer"
            >{{ $t('@WORKBENCH:查看安装指引') }}</a>
          </div>
          <!-- 一键复制执行内容：非破坏性动作，排在最前；「清空执行」这种危险动作留在后面。
               主按钮直接点 = 精简范围（提示词 + 模型回复）；右边的箭标展开菜单选「全量」 -->
          <div class="wb-copy-exec">
            <button
              type="button"
              class="wb-logs-inline-btn wb-logs-inline-btn--copy wb-copy-exec__main"
              :class="{ 'is-flash': copyExecFlashId === selectedTask.id }"
              :title="$t('@WORKBENCH:复制本任务的对话流（默认精简：仅提示词 + 模型回复）')"
              :aria-label="$t('@WORKBENCH:复制执行内容')"
              @click="copyTaskExecution(selectedTask, 'brief')"
            >
              <el-icon class="wb-logs-inline-btn__icon" v-if="copyExecFlashId !== selectedTask.id"><CopyDocument /></el-icon>
              <el-icon class="wb-logs-inline-btn__icon" v-else>✓</el-icon>
              <span>{{ $t('@WORKBENCH:复制执行内容') }}</span>
            </button>
            <el-dropdown trigger="click" placement="bottom-end" @command="onCopyExecCommand">
              <button
                type="button"
                class="wb-logs-inline-btn wb-copy-exec__caret"
                :title="$t('@WORKBENCH:选择复制范围')"
                :aria-label="$t('@WORKBENCH:选择复制范围')"
              >
                <el-icon class="wb-logs-inline-btn__icon"><ArrowDown /></el-icon>
              </button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="brief">{{ $t('@WORKBENCH:精简：提示词 + 模型回复') }}</el-dropdown-item>
                  <el-dropdown-item command="full">{{ $t('@WORKBENCH:全量：提示词 / 思考 / 工具调用 / 模型回复') }}</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
          <button
            type="button"
            class="wb-logs-inline-btn wb-logs-inline-btn--danger"
            :title="$t('@WORKBENCH:清空当前任务的所有执行内容')"
            :aria-label="$t('@WORKBENCH:清空当前任务的所有执行内容')"
            @click="clearExecutionForSelectedTask"
          >
            <el-icon class="wb-logs-inline-btn__icon"><Delete /></el-icon>
            <span>{{ $t('@WORKBENCH:清空执行') }}</span>
          </button>
          <button
            type="button"
            class="wb-logs-inline-btn"
            :title="$t('@WORKBENCH:执行日志')"
            :aria-label="$t('@WORKBENCH:执行日志')"
            @click="logsDialogVisible = true"
          >
            <el-icon class="wb-logs-inline-btn__icon"><Document /></el-icon>
            <span>{{ $t('@WORKBENCH:执行日志') }}</span>
          </button>
        </div>
        <!-- 任务描述区域：默认折叠，节省首屏空间；展开后可编辑/上传附件 -->
        <details
          class="wb-task-desc"
          :open="taskDescExpanded"
          @toggle="taskDescExpanded = ($event.target as HTMLDetailsElement).open"
        >
          <summary class="wb-task-desc__summary">
            <el-icon class="wb-task-desc__caret">
              <component :is="taskDescExpanded ? ArrowDown : ArrowRight" />
            </el-icon>
            <span class="wb-task-desc__label">{{ $t('@WORKBENCH:任务描述（可选）') }}</span>
            <button
              type="button"
              class="wb-copy-btn wb-copy-btn--inline"
              :class="{ 'is-flash': copyDescFlashId === selectedTask.id }"
              :title="(selectedTask.desc && selectedTask.desc.trim()) ? $t('@WORKBENCH:复制任务描述') : $t('@WORKBENCH:任务描述为空,无需复制')"
              :aria-label="$t('@WORKBENCH:复制任务描述')"
              @click.stop.prevent="copyTaskDesc(selectedTask)"
            >
              <el-icon class="wb-copy-btn__icon" v-if="copyDescFlashId !== selectedTask.id"><CopyDocument /></el-icon>
              <el-icon class="wb-copy-btn__icon wb-copy-btn__icon--check" v-else>✓</el-icon>
            </button>
            <span
              v-if="(selectedTask.desc && selectedTask.desc.length > 0) || (selectedTask.attachments && selectedTask.attachments.length > 0)"
              class="wb-task-desc__tag"
            >
              <span v-if="selectedTask.desc && selectedTask.desc.length > 0">{{ $t('@WORKBENCH:已填写') }}</span>
              <span
                v-if="selectedTask.attachments && selectedTask.attachments.length > 0"
                class="wb-task-desc__tag-attachment"
              >{{ selectedTask.attachments.length }}</span>
            </span>
          </summary>
          <textarea
            ref="taskDescTextareaRef"
            class="wb-textarea wb-textarea--autogrow"
            v-model="selectedTask.desc"
            :placeholder="$t('@WORKBENCH:任务描述（可选）')"
            :aria-label="$t('@WORKBENCH:任务描述（可选）')"
            @input="autoGrowTextarea($event)"
            @focus="autoGrowTextarea($event)"
            @blur="autoGrowTextarea($event)"
            @paste="onAttachmentPaste($event, { kind: 'task', task: selectedTask })"
          />
          <AttachmentZone
            :attachments="selectedTask.attachments || []"
            :is-image="isImageAttachment"
            :human-size="humanSize"
            :is-uploading="isUploading('task-' + selectedTask.id)"
            :is-paste-hover="pasteHoverId === 'task-' + selectedTask.id"
            :on-pick="() => pickAttachmentFile({ kind: 'task', task: selectedTask })"
            :on-remove="(att) => removeAttachment({ kind: 'task', task: selectedTask }, att)"
            @paste="onAttachmentPaste($event, { kind: 'task', task: selectedTask })"
            @drop.prevent="onAttachmentDrop($event, { kind: 'task', task: selectedTask })"
            @dragover.prevent="pasteHoverId = 'task-' + selectedTask.id"
            @dragenter.prevent="pasteHoverId = 'task-' + selectedTask.id"
            @dragleave="pasteHoverId = (pasteHoverId === 'task-' + selectedTask.id ? null : pasteHoverId)"
          />
        </details>
        <!-- ── 执行主体：一条任务 = 一次会话，详情面板占满整行 ── -->
        <div class="wb-execution-body">
          <!-- 详情面板（执行内容区） -->
          <div class="wb-exec-detail">
            <!-- ⚠️ 这一层**不要**用裸 <template> 包起来（踩过，2026-09-22）：
                 Vue 3 只把带 v-if / v-else / v-for / v-slot 的 <template> 编译成片段，
                 裸 <template> 会被当成真的 <template> 元素渲染 —— 浏览器把子节点全塞进
                 template.content（inert DocumentFragment），不产生任何布局盒。
                 症状：任务在跑、看板「执行中」，但对话区一片空白，
                 而 innerText 里明明有内容（元素 0×0）。重构移除子任务概念时留下的空壳。 -->
            <!-- 提示词：派发时冻结的只读快照（全局 + 项目两段），改设置不影响历史任务。
                   任务级不可编辑 —— 编辑入口只有主 Agent 控制台的「预设提示词」设置。 -->
            <details
              class="wb-task-prompt"
              :class="{ 'has-content': selectedTaskPromptParts.length > 0 }"
            >
              <summary class="wb-form-item__label wb-task-prompt__summary">
                <el-icon class="wb-task-prompt__caret"><ArrowRight /></el-icon>
                <span>{{ $t('@WORKBENCH:提示词') }}</span>
                <span
                  v-if="selectedTaskPromptParts.length > 0"
                  class="wb-task-prompt__tag"
                >{{ $t('@WORKBENCH:已填写') }}</span>
                <button
                  v-if="simpleJobState(simpleJobFor(selectedTask)) === 'running' && simpleJobFor(selectedTask)"
                  class="wb-simple__stop"
                  @click.stop="cancelJob(simpleJobFor(selectedTask)!)"
                >
                  {{ $t('@WORKBENCH:停止') }}
                </button>
              </summary>
              <div v-if="selectedTaskPromptParts.length > 0" class="wb-task-prompt__parts">
                <div v-for="part in selectedTaskPromptParts" :key="part.key" class="wb-task-prompt__part">
                  <div class="wb-task-prompt__label">{{ part.label }}</div>
                  <pre class="wb-task-prompt__text">{{ part.text }}</pre>
                </div>
              </div>
              <p v-else class="wb-task-prompt__empty">{{ $t('@WORKBENCH:这条任务没有附加提示词') }}</p>
            </details>
              <!-- 任务对话流：所有轮次合并到单个 ChatContainer -->
              <template v-if="simpleAllJobsFor(selectedTask).length > 0">
                <div class="wb-simple-chat-wrap" ref="chatWrapRef">
                  <!-- ⚠️ 这层 div 不是多余的，class 也**不要**挪回 ChatContainer 上（2026-09-29 踩过）：
                       传给 zen-ai-chat-ui 组件的 class 在**生产构建**里不会落到组件根节点上
                       （同一份源码 dev 会落、prod 静默丢掉，实测 class 与父级 data-v-* 双双消失），
                       于是 `.wb-simple-chat :deep(.acu-*)` 这一组样式钩子在生产 bundle 里全是死的。
                       症状之一就是「已完成的任务点开后有 2 个输入框」：原来靠
                       `.acu-chat-footer{display:none}` 藏 ChatContainer 自带输入框，prod 里那条规则
                       根本没匹配上，lib 自带输入框与下面常驻的 ChatInput 同时显示。
                       把 class 挂在自己的 div 上，样式钩子才在 dev / prod 都成立。 -->
                  <div class="wb-simple-chat">
                    <ChatContainer
                      ref="chatRef"
                      :key="selectedTask.id"
                      :messages="simpleConversationMessages"
                      :assistant-name="simpleAssistantLabel"
                      :assistant-avatar="simpleAssistantAvatar"
                      :show-avatar="true"
                      :theme="configStore.theme"
                      :tool-calls-config="{ group: true, collapseThreshold: 2 }"
                      :plan-config="{ labels: { title: $t('@AGENT:计划'), raw: $t('@AGENT:原始参数') } }"
                      :message-rail-config="MESSAGE_RAIL_CONFIG"
                      :show-input="false"
                    />
                  </div>
                  <!-- 输入区：**任务在跑的时候也常驻**。
                       - 空闲：发送 = 立刻续接一轮
                       - 执行中：发送 = 排队，等这一轮 job 进终态自动接上（见 useWorkbenchExecution）
                       停止按钮不在这里 —— 它一直在上方「提示词」那一行的右侧。 -->
                  <div class="wb-simple-chat__footer">
                    <div v-if="selectedTaskQueue.length" class="wb-chat-queue">
                      <div class="wb-chat-queue__head">
                        <span class="wb-chat-queue__label">{{ $t('@WORKBENCH:排队中') }}</span>
                        <span class="wb-chat-queue__count">{{ selectedTaskQueue.length }}</span>
                        <span class="wb-chat-queue__hint">
                          {{ selectedTaskRunning
                            ? $t('@WORKBENCH:等这一轮跑完自动发送')
                            : $t('@WORKBENCH:当前没有在跑的轮次') }}
                        </span>
                      </div>
                      <div
                        v-for="(item, qi) in selectedTaskQueue"
                        :key="item.id"
                        class="wb-chat-queue__item"
                      >
                        <span class="wb-chat-queue__index">{{ qi + 1 }}</span>
                        <span class="wb-chat-queue__text" :title="item.text">{{ item.text }}</span>
                        <span v-if="item.files.length" class="wb-chat-queue__atts">
                          <span aria-hidden="true">📎</span>
                          {{ item.files.map(f => f.file.name).join('、') }}
                        </span>
                        <!-- 队首 + 没在跑 = 上一笔发失败了（正常情况终态一到就自动发了），
                             给个手动重试；其余情况点它没意义，所以只在队首出现 -->
                        <button
                          v-if="qi === 0 && !selectedTaskRunning"
                          type="button"
                          class="wb-chat-queue__btn"
                          @click="flushNextQueued(selectedTask.id)"
                        >{{ $t('@WORKBENCH:立即发送') }}</button>
                        <button
                          type="button"
                          class="wb-chat-queue__btn is-remove"
                          :title="$t('@WORKBENCH:移出队列')"
                          :aria-label="$t('@WORKBENCH:移出队列')"
                          @click="removeQueuedChat(selectedTask.id, item.id)"
                        >✕</button>
                      </div>
                    </div>
                    <ChatInput
                      :key="'input-' + selectedTask.id"
                      :placeholder="selectedTaskRunning
                        ? $t('@WORKBENCH:执行中，发送后会排队，等这一轮跑完自动接上…')
                        : $t('@WORKBENCH:输入后续问题继续对话…(Ctrl+Enter 发送)')"
                      :upload-config="{
                        enabled: true,
                        accept: ALLOWED_EXT_HINT,
                        multiple: true,
                        // 0 = 不限：lib 内部是 `if (maxCount && ...)`，传 0 才真的不设卡；
                        // 不传会落回它自带的默认值 10，比我们自己那道 9 还小。
                        maxCount: 0,
                        maxSize: MAX_ATTACHMENT_BYTES
                      }"
                      class="wb-simple-chat__input"
                      @send="onContinueSendFromChat(selectedTask, $event)"
                    />
                  </div>
                </div>
              </template>
          </div>
        </div>
      </template>
    </section>
    </div>
    </div>
    </CommonDialog>

    <!-- 执行日志管理：弹窗形式承载，原本独立 tab 切换会占用首屏。

         ⚠️ 必须 append-to-body。app shell 的 main.main-container 是 position:fixed + z-index:1001，
         它自成一个层叠上下文：留在这里面的弹窗 z-index 再高，也只是跟"同一个上下文里的兄弟"比，
         永远压不过挂在 body 下的 L2 编辑器弹窗（它 escape 了 1001 那层）。
         现象就是点了「执行日志」没反应 —— 其实弹窗开了，只是被编辑器整个盖住。 -->
    <CommonDialog
      v-model="logsDialogVisible"
      :title="$t('@WORKBENCH:执行日志')"
      width="1080px"
      :close-on-click-modal="false"
      top="6vh"
      type="flex"
      custom-class="wb-logs-dialog"
      append-to-body
    >
      <ExecutionLogManager />
    </CommonDialog>

    </div>
</template>

<style scoped>
.workbench {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-container);
  color: var(--text-primary);
}

/* ── L2 编辑器弹窗的内容壳 ───────────────────────────────────────
   高度链：CommonDialog 传 type="flex" + height-mode="fixed"，el-dialog 拿到确定高度、
   el-dialog__body 吃到剩余高度；这里再 flex:1 顶满，编辑器内部原有的
   「细栏 + flex:1 的 editor-row」布局就能照旧工作，不用改一行。 */
.wb-editor {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  /* Element Plus 的 el-dialog__body 会把 line-height 一路继承下去，
     编辑器里那些 10~11px 的小徽标会被撑高一圈 —— 在根元素重置（踩过两次的坑） */
  line-height: 1.5;
}

/* ── L2 顶部细栏：返回看板 + 当前项目 ───────────────────────────── */
.wb-editor-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  height: 34px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-color-light);
  background: var(--bg-panel);
  background-image: var(--gradient-accent-soft);
}
.wb-back-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: 22px;
  padding: 0 6px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-custom);
  /* 图标 + 四个字是一个整体，折行就散了。这里不是"随手加一句"：细栏的横向空间一旦
     紧到边缘，「返回看板」的盒子会被分掉零点几像素（flex 按比例分摊缺口，见
     .wb-editor-bar__time 那段），而它的文字宽度正好压在盒子宽度上 —— 差一点点就从
     一行翻成两行（实测 420px 视口：盒子仍是 77px 宽，高度却从 22 变 44，字压在栏外）。
     nowrap 之后标签不再会折，让位全部落到右边那一块（它的宽度本来就是第一个让的）。 */
  white-space: nowrap;
}
.wb-back-btn:hover { color: var(--color-primary); }
.wb-back-btn:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
.wb-back-btn__icon { font-size: var(--font-size-mid); }
.wb-editor-bar__project {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.wb-editor-bar__hint {
  margin-left: auto;
  font-size: var(--font-size-xs);
  color: var(--text-meta);
  flex-shrink: 0;
}
/* ── 细栏右端的「相对时间 · 用时」：与看板卡片同一口径 ─────────────────────
   margin-left: auto 与 .wb-editor-bar__hint 上的那枚分工：**在场的那一个**去吃中间那段
   空白。不这么分的话，空白会被 hint 独占，这一块就贴死在项目名后面（左半栏），
   而它要的是"靠右、紧挨「任务执行」"。下面那条相邻选择器管的就是这个先后：
   时间块在 → 它吃空白；不在（任务没有任何时间戳）→ hint 照旧自己吃（现状不变）。
   注意 auto margin 只在有富余空间时生效，挤的时候自动变 0，不影响下面的让位行为。

   flex-shrink 给 100：窄容器里它必须**第一个**让位。左边四项是"我在哪 / 打开的是谁"
   （返回看板、项目名、执行于 xxx、这栏叫什么），被挤变形就说不清上下文了；
   而时间与用时在底下的卡片上本来就看得到同一份，这里挤没了不丢信息。
   min-width: 0 是关键：少了它 flex 项收不到内容宽度以下，"优先让位"就是假的 ——
   字会被硬裁而不是收窄，容器还会跟着溢出（细栏不换行、不增高，溢出只能往外顶）。 */
.wb-editor-bar__time {
  margin-left: auto;
  flex-shrink: 100;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-xs);
  color: var(--text-meta);
  font-variant-numeric: tabular-nums;
}
/* 与卡片那行同一档语义：用时是"要读的"，相对时间是"背景" */
.wb-editor-bar__spent { color: var(--text-secondary); }
/* 两个事实之间的分隔符：比两边的字轻一档，只为断句，不抢读 */
.wb-editor-bar__sep { margin: 0 5px; opacity: .55; }
/* 时间块在场时由它去吃那段空白（见上），紧挨着的这枚标就不必再要一份 */
.wb-editor-bar__time + .wb-editor-bar__hint { margin-left: 0; }
/* 任务属于别的项目时补一句实话：执行目录不是上面这个当前目录（后端按 task.projectPath 落目录） */
.wb-editor-bar__repo {
  flex-shrink: 0;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-xs);
  line-height: 16px;
  padding: 0 6px;
  border-radius: var(--radius-base);
  color: var(--color-warning-dark);
  background: color-mix(in srgb, var(--color-warning) 12%, transparent);
  font-variant-numeric: tabular-nums;
}

/* 顶部条已移除：执行日志入口直接合到任务头（与「执行任务」按钮同处），节省首屏纵向空间。 */

/* 任务描述折叠：默认收起，点击 summary 展开。 */
.wb-task-desc {
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  padding: 0;
  margin: 0;
  flex-shrink: 0;
  /* 兜底：作为 flex column 子项时被自身内容(尤其 summary 的标签 + textarea 的 placeholder)
     撑出右边界,导致 textarea 看起来"右侧超出"。min-width: 0 让它老老实实按容器宽度收。 */
  min-width: 0;
  overflow: hidden;
}
/* 任务头操作区（连续执行开关等）：与任务描述块同一列、对齐缩进 */
.wb-task-options {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px 0;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}
.wb-task-desc[open] {
  background: var(--bg-container);
}
.wb-task-desc__summary {
  list-style: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  /* 去掉左右 padding:让 summary 的图标/文字/复制按钮/已填写标签
     全部紧贴父容器左右内边线,跟下面 textarea 的 0 margin 对齐,
     整体视觉更紧凑、不再有"两边挤压"的不对齐感。 */
  padding: 8px 0;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  user-select: none;
}
.wb-task-desc__summary::-webkit-details-marker { display: none; }
.wb-task-desc__summary:hover { background: var(--bg-container-hover); }
.wb-task-desc__caret {
  font-size: var(--font-size-sm);
  color: var(--text-meta);
  transition: transform var(--transition-fast);
}
.wb-task-desc__label {
  font-weight: 500;
  letter-spacing: 0.1px;
}
.wb-task-desc__tag {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--font-size-xs);
  color: var(--color-primary);
  font-weight: 600;
}
.wb-task-desc__tag-attachment {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 16px;
  padding: 0 5px;
  border-radius: var(--radius-lg);
  background: var(--tint-primary-14);
  color: var(--color-primary);
  font-variant-numeric: tabular-nums;
}
.wb-task-desc[open] .wb-task-desc__summary {
  margin-bottom: 0;
}
.wb-task-desc > .wb-textarea,
.wb-task-desc > :deep(.attachment-zone) {
  /* 右外边距 14px(与 summary 同步):之前 12px 在 focus 状态下被焦点边框吃掉 1px,
     视觉上 textarea 右边缘几乎贴住父容器右内边缘,显得"右侧超出/没显示全"。
     加 2px 缓冲,并配合 .wb-task-desc 的 min-width: 0 一起保证不撑出父容器。
     上 margin 0:让 textarea 紧贴 summary(默认展开后 summary 和 textarea 紧贴更紧凑)。
     左外边距 0:让 textarea 文本基线与 summary 文本对齐(summary 的图标+文字也是
     紧贴父容器左内边线),不要让 textarea 再往里缩 14px 出现"视觉上偏移"。
     下 margin 0:由 attachment-zone 的上 margin(8px)和 border 视觉自然分隔。 */
  margin: 0 14px 0 0;
}
.wb-task-desc > .wb-textarea {
  margin-bottom: 0;
  /* 双保险:即便父容器出现内容撑出,textarea 也止步于父容器 content-box 之内 */
  max-width: 100%;
}
.wb-task-desc > :deep(.attachment-zone) {
  /* 给 attachment-zone 一个 8px 上 margin,与 textarea 的 0 上 margin
     形成 8px 视觉间距(避免去掉 textarea 上 margin 后两者贴在一起)。 */
  margin-top: 8px;
}

/* editor 视图的子行容器：把 sidebar + split 重新横向排列（workbench 改成 column 后需要这一层） */
.workbench__editor-row {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* 侧边栏 / 主区之间的可拖分隔条:5px 命中区,常态隐形,
   hover / 拖动时亮出 1px 主线提示可拖。宽度本身不改布局,
   拖动时实时改的是 sidebar 的内联 width。 */
.wb-splitter {
  flex: 0 0 5px;
  margin-right: -5px;
  cursor: col-resize;
  position: relative;
  z-index: 5;
}
.wb-splitter::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 2px;
  width: 1px;
  background: transparent;
  transition: background var(--transition-fast) var(--ease-custom);
}
.wb-splitter:hover::after,
.wb-splitter:active::after {
  background: var(--color-primary);
}

.wb-sidebar {
  width: 268px;
  flex-shrink: 0;
  padding: 14px 12px 18px;
  overflow-y: auto;
  background: var(--bg-panel);
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* ── 分组容器 ─────────────────────────────────────────── */
.wb-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  /* 侧栏整体 overflow: auto 已经能滚动；不要让 flex 把分组压扁，
     否则任务列表最后一项会被下方分组压上来形成重叠。 */
  flex-shrink: 0;
}
.wb-section + .wb-section {
  padding-top: 16px;
}
.wb-section__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px;
}
.wb-section__tag {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  font-size: var(--font-size-xs);
  font-weight: 600;
  letter-spacing: 0.4px;
  color: var(--text-meta);
  background: var(--bg-subtle);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
  text-transform: uppercase;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.wb-section__tag--accent {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 9%, transparent);
  border-color: var(--tint-primary-22);
}
.wb-section__title {
  margin: 0;
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: 0.2px;
  flex: 1;
  min-width: 0;
}
.wb-section__action {
  border: none;
  background: transparent;
  color: var(--text-meta);
  width: 28px;
  height: 28px;
  border-radius: var(--radius-base);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: var(--font-size-mid);
  flex-shrink: 0;
  transition: background var(--transition-fast) var(--ease-custom),
              color var(--transition-fast) var(--ease-custom);
}
.wb-section__action:hover {
  background: var(--tint-primary-12);
  color: var(--color-primary);
}

/* ── 主操作：新建任务 ─────────────────────────────── */
.wb-new-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 32px;
  padding: 0 12px;
  border: 1px dashed var(--tint-primary-35, color-mix(in srgb, var(--color-primary) 35%, transparent));
  border-radius: var(--radius-md);
  background: linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 4%, transparent) 0%, color-mix(in srgb, var(--color-primary) 2%, transparent) 100%);
  color: var(--color-primary);
  font-size: var(--font-size-mid);
  font-weight: 600;
  letter-spacing: 0.05px;
  cursor: pointer;
  transition:
    background var(--transition-fast) var(--ease-custom),
    color var(--transition-fast) var(--ease-custom),
    border-color var(--transition-fast) var(--ease-custom),
    transform var(--transition-fast) var(--ease-custom);
}
.wb-new-btn__icon {
  font-size: var(--font-size-mid);
  flex-shrink: 0;
  transition: transform var(--transition-fast) var(--ease-custom);
}
.wb-new-btn__shortcut {
  /* N 快捷键徽标：当前版本未注册全局快捷键，避免误导用户。
     样式保留以便后续接入快捷键时直接恢复。 */
  display: none;
}
.wb-new-btn:hover {
  background: linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 10%, transparent) 0%, color-mix(in srgb, var(--color-primary) 6%, transparent) 100%);
  color: var(--color-primary);
  border-style: solid;
  border-color: var(--tint-primary-50);
}
.wb-new-btn:hover .wb-new-btn__icon {
  transform: rotate(90deg);
}
.wb-new-btn:active {
  transform: scale(0.99);
}
.wb-new-btn:focus-visible {
  outline: var(--focus-outline);
  outline-offset: 1px;
}

/* ── 任务列表 ───────────────────────────────────────── */
.wb-task-list,
.wb-prompt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.wb-task-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  /* 紧凑单行：上下 padding 从 9px → 7px，左右 10 → 10 不变 */
  padding: 7px 10px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  cursor: pointer;
  transition:
    background var(--transition-fast) var(--ease-custom),
    color var(--transition-fast) var(--ease-custom),
    transform var(--transition-fast) var(--ease-custom),
    box-shadow var(--transition-fast) var(--ease-custom);
}
.wb-task-item:hover {
  background: var(--bg-container-hover);
  border-color: transparent;
  transform: translateY(-0.5px);
}
.wb-task-item:hover .wb-task-item__del {
  opacity: 1;
  transform: translateX(0);
}
.wb-task-item.is-running {
  /* 执行中:浅暖色底,左侧竖条留给 active(选中)用 */
  background: color-mix(in srgb, var(--color-warning) 8%, transparent);
}
.wb-task-item.is-running:hover {
  /* hover 时稍微加深一点,提示"在跑但可点" */
  background: color-mix(in srgb, var(--color-warning) 14%, transparent);
  transform: none;
}
.wb-task-item.active {
  background: color-mix(in srgb, var(--color-primary) 10%, var(--bg-container));
  border-color: transparent;
  box-shadow:
    0 1px 3px color-mix(in srgb, var(--color-primary) 12%, transparent),
    0 0 0 1px color-mix(in srgb, var(--color-primary) 18%, transparent);
}
.wb-task-item.active::after {
  content: '';
  position: absolute;
  left: -1px;
  top: 5px;
  bottom: 5px;
  width: 3px;
  border-radius: var(--radius-base);
  background: linear-gradient(180deg, var(--color-primary) 0%, color-mix(in srgb, var(--color-primary) 70%, #fff) 100%);
  box-shadow:
    0 0 8px color-mix(in srgb, var(--color-primary) 50%, transparent),
    0 1px 3px color-mix(in srgb, var(--color-primary) 25%, transparent);
}
.wb-task-item.active .wb-task-item__title { color: var(--color-primary); }
.wb-task-item.active .wb-task-item__del { opacity: 1; color: var(--color-primary); }

/* 执行中脉动圆点：放在右侧(标题和删除按钮之间),不抢左侧 active 竖条的位置 */
.wb-task-item__running-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-warning);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-warning) 60%, transparent);
  animation: wb-running-pulse 1.4s ease-in-out infinite;
  margin-left: auto;
}
@keyframes wb-running-pulse {
  0%, 100% {
    transform: scale(1);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-warning) 60%, transparent);
    opacity: 1;
  }
  50% {
    transform: scale(1.35);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-warning) 0%, transparent);
    opacity: 0.75;
  }
}

.wb-task-item__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
/* 任务标题：与 WorkbenchSidebar.vue 保持一致 —
   略小于 section header，作为分组下的内容项。 */
.wb-task-item__title {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  letter-spacing: -0.05px;
  line-height: 1.3;
}
.wb-task-item__meta {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--font-size-xs);
  color: var(--text-meta);
  line-height: 1;
}
.wb-task-item__meta-item {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
.wb-task-item__meta-item--accent { color: var(--color-primary); }
/* 跨项目的任务：在 meta 行内加一个简短的项目名徽标，提示"这条是别的项目的" */
.wb-task-item__meta-item--project {
  display: inline-flex;
  align-items: center;
  height: 15px;
  padding: 0 5px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-warning, var(--color-warning-light)) 14%, transparent);
  color: color-mix(in srgb, var(--color-warning, var(--color-warning-light)) 80%, var(--text-primary));
  font-size: var(--font-size-xs);
  font-weight: 600;
  letter-spacing: 0.2px;
  white-space: nowrap;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 其他项目的任务卡片整体降饱和度，与当前项目任务视觉区分 */
.wb-task-item.is-other-project { opacity: 0.78; }
.wb-task-item.is-other-project:hover { opacity: 1; }
.wb-task-item__meta-icon { font-size: var(--font-size-xs); opacity: 0.85; }
.wb-task-item__num {
  /* 数字小徽标：基础样式由 .wb-pill 提供（圆角胶囊 + tnum），
     这里仅覆盖：去掉 min-width/padding 让数字紧凑显示 */
  min-width: 14px;
  padding: 0 4px;
  color: var(--text-secondary);
  transition: background var(--transition-fast) var(--ease-custom),
              color var(--transition-fast) var(--ease-custom);
}
.wb-task-item.active .wb-task-item__num {
  color: var(--color-primary);
  background: var(--tint-primary-14);
}
.wb-task-item__meta-item--running .wb-task-item__num {
  color: color-mix(in srgb, var(--color-warning, var(--color-warning-light)) 85%, var(--text-primary));
  background: color-mix(in srgb, var(--color-warning, var(--color-warning-light)) 18%, transparent);
  font-weight: 600;
}
.wb-task-item.is-running .wb-task-item__meta-icon {
  color: color-mix(in srgb, var(--color-warning, var(--color-warning-light)) 80%, var(--text-primary));
  animation: wb-task-running-icon 1.4s ease-in-out infinite;
}
@keyframes wb-task-running-icon {
  0%, 100% { opacity: 0.55; }
  50%      { opacity: 1; }
}

/* 删除按钮：默认隐藏，hover 卡片时淡入 */
.wb-task-item__del {
  border: none;
  background: transparent;
  color: var(--text-meta);
  width: 22px;
  height: 22px;
  border-radius: var(--radius-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: var(--font-size-sm);
  flex-shrink: 0;
  opacity: 0;
  transform: translateX(-2px);
  transition: opacity var(--transition-fast) var(--ease-custom),
              background var(--transition-fast) var(--ease-custom),
              color var(--transition-fast) var(--ease-custom),
              transform var(--transition-fast) var(--ease-custom);
}
.wb-task-item__del:hover {
  background: color-mix(in srgb, var(--color-danger) 14%, transparent);
  color: var(--color-danger-dark);
}
.wb-task-item__del:focus-visible {
  outline: var(--focus-outline);
  outline-offset: var(--focus-outline-offset);
  opacity: 1;
}
.wb-task-item__del,
.wb-prompt-item__del { font-size: var(--font-size-mid); }

/* ── 提示词列表 ─────────────────────────────────────── */
.wb-prompt-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: var(--radius-md);
  font-size: var(--font-size-mid);
  color: var(--text-primary);
  transition: background var(--transition-fast) var(--ease-custom);
  position: relative;
}
.wb-prompt-item:hover {
  background: var(--bg-container-hover);
}
.wb-prompt-item:hover .wb-prompt-item__del { opacity: 1; }
.wb-prompt-item__icon {
  width: 22px;
  height: 22px;
  border-radius: var(--radius-base);
  background: var(--tint-primary-08);
  color: var(--color-primary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--font-size-sm);
  flex-shrink: 0;
}
.wb-prompt-item__name {
  flex: 1;
  min-width: 0;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-primary);
  font-weight: 500;
  letter-spacing: -0.05px;
}
/* 提示词“全局/项目归属”小标签：在名称后面吃一点空间 */
.wb-prompt-item__tag {
  flex-shrink: 0;
  max-width: 96px;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  font-size: var(--font-size-xs);
  line-height: 16px;
  letter-spacing: 0.1px;
  background: var(--tint-primary-08);
  color: var(--color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wb-prompt-item__tag--project {
  background: var(--bg-subtle);
  color: var(--text-secondary);
  border: 1px solid var(--border-color-light);
}
/* .wb-prompt-item__del */
.wb-prompt-item__del {
  border: none;
  background: transparent;
  color: var(--text-meta);
  width: 20px;
  height: 20px;
  border-radius: var(--radius-xs);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: var(--font-size-sm);
  flex-shrink: 0;
  opacity: 0;
  transition: opacity var(--transition-fast) var(--ease-custom),
              background var(--transition-fast) var(--ease-custom),
              color var(--transition-fast) var(--ease-custom);
}
.wb-prompt-item__del:hover {
  background: color-mix(in srgb, var(--color-danger) 14%, transparent);
  color: var(--color-danger-dark);
}
.wb-prompt-item__del:focus-visible {
  outline: var(--focus-outline);
  outline-offset: var(--focus-outline-offset);
  opacity: 1;
}
@media (prefers-reduced-motion: reduce) {
}

.wb-split {
  flex: 1;
  min-height: 0;
  /* 之前 padding-right: 18px 在 1080p 窄窗口下被 header 横向滚动吃光,
     加上滚动条 8-12px 后正文右侧紧贴容器右边缘,
     焦点边框 1px + 卡片背景渐变导致"看不到又边框"。
     18 → 24 给 6px 额外缓冲,并配合 .wb-split__header 的 padding-right: 8px
     保证标题输入框和工具按钮不被父容器右内边线吃掉。 */
  padding: 12px 24px 14px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.wb-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-meta);
  font-size: var(--font-size-mid);
}

/* ── 执行主体：左右两列布局 ── */
/*
  关键:用 CSS Grid 替代 flex row。
  - flex item 的 height: 100% 在父级也是 flex item 时会 fallback 到 auto(父级没有显式 height)
  - grid 子项默认 align-self: stretch + justify-self: stretch,自动撑满 cell 高度
  - 不需要 height: 100% 链,flex chain 也能正常传递 max-height 给子级
  一条任务 = 一次会话,只有详情面板一列,直接 1fr。
*/
.wb-execution-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr;
  border: none;
  border-radius: 0;
  overflow: hidden;
  gap: 16px;
}

/* 详情面板（充满整行，内部滚动交给 JobLogDetails 的 wb-log-pre） */
.wb-exec-detail {
  min-width: 0;
  min-height: 0;
  /* 改 overflow-y: auto → hidden:让子级 wb-log-pre 拿到 max-height 约束,自身不抢滚动 */
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 4px 8px;
  background: transparent;
}

/* ── 任务头操作区：标题 + 提示词下拉 + 按钮组 ────────────────── */
.wb-split__header {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-shrink: 0;
  padding-bottom: 4px;
  /* 右侧 8px padding 让"复制/保存状态"等小工具不被外边线贴住,
     解决"看不到又边框"的问题（之前是 0,边缘 1px focus ring 吃掉 padding
     会让按钮紧贴父容器右内边线,看起来"超出/缺 padding"）。 */
  padding-right: 8px;
}

/* 标题输入 + 复制按钮的横向组合,让按钮紧贴输入框右侧并保持 8px 间距 */
.wb-split__title-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
.wb-split__title-wrap .wb-input--title { flex: 1; min-width: 0; }

/* ── 复制按钮(标题/描述都用,inline 变体用在 summary 行) ───────────── */
.wb-copy-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  background: var(--bg-container);
  color: var(--text-meta);
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
  transition:
    background var(--transition-fast) var(--ease-custom),
    border-color var(--transition-fast) var(--ease-custom),
    color var(--transition-fast) var(--ease-custom),
    transform var(--transition-fast) var(--ease-custom);
}
.wb-copy-btn:hover:not(:disabled) {
  background: var(--tint-primary-12);
  border-color: var(--tint-primary-35);
  color: var(--color-primary);
}
.wb-copy-btn:active:not(:disabled) { transform: scale(0.94); }
.wb-copy-btn:focus-visible {
  outline: var(--focus-outline);
  outline-offset: 1px;
}
.wb-copy-btn.is-flash {
  background: var(--tint-success-14, color-mix(in srgb, var(--color-success) 14%, transparent));
  border-color: var(--tint-success-35, color-mix(in srgb, var(--color-success) 35%, transparent));
  color: var(--color-success-dark);
}
.wb-copy-btn__icon { font-size: var(--font-size-mid); line-height: 1; }
.wb-copy-btn__icon--check {
  font-size: var(--font-size-base);
  font-weight: 800;
}
/* 描述折叠行内的紧凑变体:小一号,跟文字行视觉重量齐平 */
.wb-copy-btn--inline {
  width: 22px;
  height: 22px;
  border-radius: var(--radius-md);
  margin-left: 2px;
}
.wb-copy-btn--inline .wb-copy-btn__icon { font-size: var(--font-size-xs); }
@media (prefers-reduced-motion: reduce) {
}
@keyframes wb-ai-sparkle-pulse {
  0%, 100% { transform: scale(1);   opacity: 0.9; }
  50%      { transform: scale(1.12); opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
}

/* 「执行日志」内联按钮：紧贴「执行任务」右侧，视觉重量接近 secondary */
.wb-no-claude-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid color-mix(in srgb, var(--color-warning, var(--color-warning-light)) 32%, transparent);
  background: color-mix(in srgb, var(--color-warning, var(--color-warning-light)) 8%, transparent);
  color: color-mix(in srgb, var(--color-warning, var(--color-warning-light)) 75%, var(--text-primary));
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
}
/* 执行器 split button：主体「执行」+ 下拉切执行器 */
.wb-executor-split {
  flex-shrink: 0;
}
.wb-executor-split__hint {
  margin-left: 6px;
  padding-left: 8px;
  border-left: 1px solid rgba(255, 255, 255, 0.35);
  font-size: var(--font-size-xs);
  font-weight: 400;
  opacity: 0.85;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.wb-executor-split__hint-icon { font-size: var(--font-size-sm); }
.wb-executor-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 132px;
}
.wb-executor-item__icon { font-size: var(--font-size-base); flex: none; }
.wb-executor-item__name {
  flex: 1;
}
.wb-executor-item__check {
  color: var(--el-color-primary);
}
.wb-executor-item__missing {
  font-size: var(--font-size-xs);
  color: var(--text-secondary, var(--el-text-color-secondary));
}
/* 当前模型：承载信息的元文字（不用 --text-tertiary，那档对比度不够） */
.wb-executor-item__model {
  flex: none;
  max-width: 15em;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--font-size-xs);
  color: var(--text-meta);
}
.wb-no-claude-hint__icon { font-size: var(--font-size-base); opacity: 0.9; }
.wb-no-claude-hint__text { letter-spacing: -0.05px; }
.wb-no-claude-hint__link {
  color: var(--color-primary);
  text-decoration: none;
  font-weight: 600;
  margin-left: 2px;
  border-bottom: 1px dashed color-mix(in srgb, var(--color-primary) 45%, transparent);
}
.wb-no-claude-hint__link:hover { border-bottom-style: solid; }

.wb-logs-inline-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--border-color);
  background: var(--bg-container);
  color: var(--text-secondary);
  border-radius: var(--radius-md);
  font-size: var(--font-size-mid);
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
}
.wb-logs-inline-btn:hover {
  background: var(--tint-primary-12);
  color: var(--color-primary);
  border-color: var(--tint-primary-35);
}
/* 「清空执行」danger 变体：常规态用次级色(不抢眼),hover 才显危险色,避免误点 */
.wb-logs-inline-btn--danger {
  color: var(--text-secondary);
  border-color: var(--border-color);
  background: var(--bg-container);
}
.wb-logs-inline-btn--danger:hover {
  color: var(--color-danger, var(--color-danger-light));
  border-color: var(--tint-danger-50);
  background: var(--tint-danger-06);
}
/* 「复制执行内容」成功后闪一下成功色 —— 与标题/描述旁的 .wb-copy-btn.is-flash 同一套色。
   文案**刻意不换**（只换图标为 ✓）：这一排按钮宽度会跟着文字变，换文案会让
   「清空执行」「执行日志」跟着左右跳一下，banner 级别的抖动不值得。 */
.wb-logs-inline-btn--copy.is-flash {
  color: var(--color-success-dark, var(--color-success));
  border-color: var(--tint-success-35, color-mix(in srgb, var(--color-success) 35%, transparent));
  background: var(--tint-success-14, color-mix(in srgb, var(--color-success) 14%, transparent));
}
.wb-logs-inline-btn:focus-visible {
  outline: var(--focus-outline);
  outline-offset: 1px;
}
.wb-logs-inline-btn__icon { font-size: var(--font-size-base); }

/* 「复制执行内容」= 主按钮 + 范围下拉，拼成一个按钮组：
   主按钮直接点走默认范围（精简）；只有点右箭头才展开菜单去拿「全量」。
   主按钮保持 .wb-logs-inline-btn--copy（探针按这个 class 找它）。 */
.wb-copy-exec {
  display: inline-flex;
  align-items: stretch;
  flex-shrink: 0;
}
.wb-copy-exec .el-dropdown { display: inline-flex; }
.wb-copy-exec__main {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.wb-copy-exec__caret {
  padding: 0 6px;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  margin-left: -1px; /* 两条 1px 边框重合，别在拼缝处显出 2px 的粗边 */
}

/* 「执行日志」弹窗的 max-height / body 滚动限制已放在文件末尾的非 scoped <style> 块里，
   这里不再重复。原因：el-dialog 用 teleport 渲染到 body 下，scoped 选择器（包括 :deep()）
   都拿不到它的根 div，强行写只会变成 dead rule。 */

/* ── 表单控件统一系统（input / textarea 共用基底） ── */
/*    设计目标：与按钮视觉重量齐平、可识别焦点、hover 反馈明确。
      颜色走 --border-color-medium 提升基础边框可见度，hover 阶段加深，
      focus 阶段同时改色 + 套 3px primary-tinted ring。 */
.wb-input,
.wb-textarea {
  font-family: inherit;
  color: var(--text-primary);
  background: var(--bg-container);
  border: 1px solid var(--border-color-medium);
  border-radius: var(--radius-md);
  box-shadow: var(--wb-card-inset-shadow);
  transition:
    border-color var(--transition-fast) var(--ease-custom),
    box-shadow var(--transition-fast) var(--ease-custom),
    background var(--transition-fast) var(--ease-custom);
  outline: none;
  -webkit-appearance: none;
  appearance: none;
}
.wb-input::placeholder,
.wb-textarea::placeholder {
  color: var(--text-placeholder);
  font-weight: 400;
}

/* ── 单行输入 ─────────────────────────────────────── */
.wb-input {
  height: 36px;
  padding: 0 12px;
  font-size: var(--font-size-base);
  line-height: 1.2;
  letter-spacing: -0.05px;
}
.wb-input:hover:not(:focus) {
  border-color: var(--border-input-hover, #cbd5e1);
  background: var(--bg-container-hover);
}
.wb-input:focus {
  border-color: var(--color-primary);
  background: var(--bg-container);
  box-shadow:
    0 0 0 3px var(--tint-primary-18),
    var(--wb-card-inset-shadow);
}

/* ── 标题：hero 级单行输入 ─────────────────────────── */
.wb-input--title {
  /* 极简化：去掉 box-shadow inset，更低视觉重量 */
  height: 36px;
  flex: 1;
  font-size: var(--font-size-base);
  font-weight: 600;
  letter-spacing: -0.4px;
  padding: 0 12px;
  border-color: var(--border-color);
  background: transparent;
  box-shadow: none;
}
.wb-input--title:hover:not(:focus) {
  border-color: var(--border-color-medium);
  background: var(--bg-container);
}
.wb-input--title:focus {
  border-color: var(--color-primary);
  background: var(--bg-container);
  box-shadow: 0 0 0 3px var(--tint-primary-14);
}
.wb-input--title::placeholder {
  font-weight: 500;
  color: var(--text-placeholder);
}

/* ── 多行输入 ─────────────────────────────────────── */
.wb-textarea {
  display: block;
  padding: 10px 14px;
  font-size: var(--font-size-mid);
  line-height: 1.55;
  letter-spacing: -0.05px;
  resize: vertical;
  width: 100%;
  box-sizing: border-box;
  flex-shrink: 0;
  min-height: 52px;
  /* 默认铺实色背景,避免和外层渐变/紫色面板叠加导致"看不清字"。
     focus 用 box-shadow 区分层级,不再靠颜色变化。 */
  background: var(--bg-container);
  box-shadow: none;
  border-color: var(--border-color);
}
.wb-textarea::placeholder {
  line-height: 1.55;
  color: var(--text-placeholder);
}
.wb-textarea:hover:not(:focus) {
  border-color: var(--border-color-medium);
  background: var(--bg-container-hover);
}
        .wb-textarea:focus {
  border-color: var(--color-primary);
  background: var(--bg-container-hover);
  box-shadow: 0 0 0 3px var(--tint-primary-14);
}
.wb-textarea--focus-expand:focus {
  max-height: 500px;
  transition: max-height var(--transition-base) var(--ease-custom);
}

/* 自适应高度 textarea:禁掉手动 resize,高度由 autoGrowTextarea() 写入。
   设 overflow-y: hidden 默认,JS 在内容超 max 时改 overflow-y: auto。 */
.wb-textarea--autogrow {
  resize: none;
  min-height: 52px;
  max-height: 320px;
  overflow-y: hidden;
  /* line-height 1.55 配合 13px 字号 → 行高 ~20px,
     52px 起手约 2 行可写空间,足够 placeholder 完整显示。 */
  transition: height var(--transition-fast) var(--ease-custom);
}

.wb-split__sub-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
  flex-shrink: 0;
}
.wb-split__sub-header h4 {
  margin: 0;
  font-size: var(--font-size-mid);
  font-weight: 600;
  color: var(--text-secondary);
}

/* ── 任务编辑区 ─────────────────────────── */
.wb-simple__header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-top: 8px;
  /* 2026-10-04：原本是 border-left: 2px solid var(--color-primary) 的
     缩进竖条，只表达层级不带语义。缩进交给 padding。 */
  padding-left: 10px;
  flex-shrink: 0;
}
.wb-simple__header h4 {
  margin: 0;
  font-size: var(--font-size-mid);
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.05px;
}
.wb-simple__hint {
  font-size: var(--font-size-sm);
  color: var(--text-meta);
}

/* ── 任务完成态 pill ── */
/* 圆点版：只用状态点+颜色表达状态,无文字。 */
.wb-simple__status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 2px;
  flex-shrink: 0;
}
.wb-simple__status {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0;
  border-radius: 50%;
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  /* 颜色由行内 style 注入；这里只做过渡 */
  transition: background var(--transition-fast) var(--ease-custom);
}
.wb-simple__status--dot {
  border-radius: 50%;
}
.wb-simple__status-text {
  display: none;
}
.wb-simple__meta {
  font-size: var(--font-size-sm);
  color: var(--text-meta);
  letter-spacing: -0.05px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.wb-simple__meta--error {
  color: var(--color-danger-dark);
}
/* idle 灰底：背景由 inline style 注入，无文字无需特殊处理 */
.wb-simple__status[style*="--text-tertiary"] .wb-simple__status-dot {
  background: var(--text-tertiary);
}

/* ── 任务「停止」按钮(running 时详情区状态条末尾) ── */
.wb-simple__stop {
  margin-left: auto;
  padding: 2px 10px;
  border-radius: var(--radius-base);
  border: 1px solid var(--color-danger-bright);
  background: transparent;
  color: var(--color-danger-bright);
  font-size: var(--font-size-sm);
  font-weight: 600;
  cursor: pointer;
  transition:
    background var(--transition-fast) var(--ease-custom),
    color var(--transition-fast) var(--ease-custom);
}
.wb-simple__stop:hover:not(:disabled) {
  background: var(--color-danger-bright);
  color: #fff;
}
.wb-simple__stop:disabled {
  opacity: var(--disabled-opacity);
  cursor: not-allowed;
}

/* ── 任务「提示词」只读展示（派发时快照，拆全局/项目两段） ── */
.wb-task-prompt {
  border-radius: var(--radius-md);
}
.wb-task-prompt__summary {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
  list-style: none;
  padding: 4px 0;
}
.wb-task-prompt__summary::-webkit-details-marker { display: none; }
.wb-task-prompt__caret {
  font-size: var(--font-size-sm);
  color: var(--text-meta);
  transition: transform var(--transition-fast) var(--ease-custom);
}
.wb-task-prompt[open] > .wb-task-prompt__summary .wb-task-prompt__caret {
  transform: rotate(90deg);
  color: var(--color-primary);
}
.wb-task-prompt.has-content > .wb-task-prompt__summary {
  color: var(--text-primary);
}
.wb-task-prompt__tag {
  font-size: var(--font-size-xs);
  font-weight: 600;
  padding: 1px 6px;
  border-radius: var(--radius-lg);
  background: var(--tint-primary-12, color-mix(in srgb, var(--color-primary) 12%, transparent));
  color: var(--color-primary);
  letter-spacing: 0.2px;
}
.wb-task-prompt__parts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}
.wb-task-prompt__part {
  padding: 6px 9px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}
.wb-task-prompt__label {
  margin-bottom: 4px;
  font-size: var(--font-size-xs);
  color: var(--text-meta);
}
.wb-task-prompt__text {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  font-family: inherit;
  font-size: var(--font-size-mid);
  line-height: 1.5;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
.wb-task-prompt__empty {
  margin: 8px 0 0;
  font-size: var(--font-size-xs);
  color: var(--text-meta);
}

/* ── 任务单一对话流：合并所有轮次到一个 ChatContainer ── */
.wb-simple-chat-wrap {
  display: flex;
  flex-direction: column;
  flex: 1 1 0%;
  min-height: 0;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
  background: var(--bg-code);
  overflow: hidden;
  margin-top: 6px;
  /* 强制 zen-ai-chat-ui 内部背景与容器一致 */
  --acu-bg: var(--bg-code);
}
/* 对话容器：外层 div 先吃满 chat-wrap 的剩余高度，ChatContainer（库给 .acu-chat 定了
   height:100%）再填满它。样式钩子统一挂在这层上 —— 见模板里的注释：class 传给组件本身
   在生产构建里会静默丢掉，钩子全变死代码。 */
.wb-simple-chat {
  display: flex;
  flex-direction: column;
  flex: 1 1 0%;
  min-height: 0;
}
/* 自带输入框的主开关是 ChatContainer 的 `show-input=false`（见模板）；这条只是兜底：
   万一那个 prop 在新版本里换名/失效，也不能让对话区同时冒出第二个输入框。 */
.wb-simple-chat :deep(.acu-chat-footer) { display: none; }
.wb-simple-chat :deep(.acu-chat),
.wb-simple-chat :deep(.acu-message-list),
.wb-simple-chat :deep(.acu-message-list-inner) > * { background: transparent; }
.wb-simple-chat :deep(.acu-chat) { background: var(--bg-code); }
.wb-simple-chat :deep(.acu-message-list) { background: var(--bg-code); }
.wb-simple-chat :deep(.acu-message-list-inner) {
  padding: 10px 8px 14px;
  gap: 10px;
  max-width: 100%;
  margin: 0;
}
.wb-simple-chat :deep(.acu-bubble-main) {
  max-width: 100%;
}
.wb-simple-chat :deep(.acu-bubble) { font-size: var(--font-size-sm); border-radius: var(--radius-lg); }
.wb-simple-chat :deep(.acu-bubble-name) { font-size: var(--font-size-xs); }
.wb-simple-chat__footer {
  flex-shrink: 0;
  padding: 0 4px 4px;
  background: var(--bg-code);
}
.wb-simple-chat__input { width: 100%; }

/* 排队续聊条：任务在跑时发出去的内容先落这儿，等这一轮 job 进终态自动接上。
   用 --role-pending-* 这套语义色，跟看板「待处理」列是同一个视觉口径 ——
   「排队中」本来就是 pending。 */
.wb-chat-queue {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0 0 6px;
  padding: 8px 10px;
  border: 1px solid var(--role-pending-edge);
  border-radius: var(--radius-md);
  background: var(--role-pending-surface);
}
.wb-chat-queue__head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-xs);
  color: var(--role-pending-ink);
}
.wb-chat-queue__label { font-weight: 600; }
.wb-chat-queue__count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--role-pending-wash);
  font-weight: 600;
  text-align: center;
}
.wb-chat-queue__hint { color: var(--text-secondary); }
.wb-chat-queue__item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-size-sm);
}
.wb-chat-queue__index {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: 999px;
  background: var(--role-pending-wash);
  color: var(--role-pending-ink);
  font-size: var(--font-size-xs);
  line-height: 16px;
  text-align: center;
}
.wb-chat-queue__text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}
.wb-chat-queue__atts {
  flex-shrink: 0;
  max-width: 36%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
}
.wb-chat-queue__btn {
  flex-shrink: 0;
  padding: 2px 8px;
  border: 1px solid var(--role-pending-edge);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--role-pending-ink);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: background var(--transition-fast) var(--ease-custom),
              border-color var(--transition-fast) var(--ease-custom);
}
.wb-chat-queue__btn:hover {
  background: var(--role-pending-wash);
  border-color: var(--role-pending-ink);
}
.wb-chat-queue__btn:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
.wb-chat-queue__btn.is-remove {
  padding: 2px 6px;
  border-color: transparent;
  color: var(--text-secondary);
}
.wb-chat-queue__btn.is-remove:hover {
  border-color: var(--border-card-hover);
  background: transparent;
  color: var(--text-primary);
}

.wb-form-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}
.wb-form-item__label {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--text-secondary);
  letter-spacing: -0.05px;
}

.wb-sub-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

@keyframes wb-progress-slide {
  0%   { background-position: -50% 0; }
  100% { background-position: 150% 0; }
}
@keyframes wb-card-glow {
  0%, 100% {
    box-shadow:
      0 0 0 1px var(--tint-primary-30),
      0 4px 18px -4px color-mix(in srgb, var(--color-primary) 25%, transparent);
  }
  50% {
    box-shadow:
      0 0 0 1px var(--tint-primary-50),
      0 6px 24px -2px color-mix(in srgb, var(--color-primary) 38%, transparent);
  }
}
@keyframes wb-card-sweep {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@media (prefers-reduced-motion: reduce) {
}

@keyframes wb-border-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@keyframes wb-status-dot-pulse {
  0%, 100% {
    transform: scale(1);
    box-shadow: 0 0 4px rgba(255, 255, 255, 0.45);
  }
  50% {
    transform: scale(1.35);
    box-shadow: 0 0 8px rgba(255, 255, 255, 0.85);
  }
}

@keyframes wb-status-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.55; transform: scale(0.7); }
}
@media (prefers-reduced-motion: reduce) {
  .wb-sub-expand-enter-active,
  .wb-sub-expand-leave-active {
    transition: none;
  }
}

/* ── 子任务展开/收起过渡 ───────────────────────────────────────
   使用 grid-template-rows: 0fr -> 1fr 的"自适应高度过渡"技巧，
   配合 overflow:hidden 让子元素自然撑出高度，无需 JS 测量真实高度。
   enter-from/leave-to 设 0fr（折叠），enter-to/leave-from 设 1fr（展开）。
*/
.wb-sub-expand-enter-active,
.wb-sub-expand-leave-active {
  transition:
    grid-template-rows var(--transition-base, var(--transition-base)) var(--ease-custom),
    opacity var(--transition-fast) var(--ease-custom);
  overflow: hidden;
}
.wb-sub-expand-enter-from,
.wb-sub-expand-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
}
.wb-sub-expand-enter-to,
.wb-sub-expand-leave-from {
  grid-template-rows: 1fr;
  opacity: 1;
}
.wb-sub-expand-inner {
  /* grid-template-rows: 0fr/1fr 需要子节点显式 min-height:0 + overflow:hidden */
  min-height: 0;
  overflow: hidden;
}

/* 日志面板样式已抽到 components/JobLogDetails.vue（self-contained scoped） */

/* ── 子任务附件（wb-attachments 系列已抽到 styles/workbench.scss 全局样式） ──
   按钮的视觉风格由 .wb-soft-btn 提供，子组件 AttachmentZone 在模板中合并使用
   `class="wb-attachments__add wb-soft-btn"`。本作用域内不再重复定义。 */

/* 当前项目名已通过 .wb-task-group__head.is-current 在分组头中突出展示，
   侧栏顶部不再重复渲染"当前项目"条以避免信息冗余。 */

/* ── 任务分组头（多项目时按项目分组显示） ───────────────────────── */
/* 分组头：与 WorkbenchSidebar.vue 保持一致 —
   字号 13px + 字重 600 + secondary 颜色，承担"这是什么项目"的语义。
   移除了 uppercase + tracked-out,避免和 sidebar 双视图风格不一致。 */
.wb-task-group__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 6px 4px;
  margin-top: 4px;
  font-size: var(--font-size-mid);
  font-weight: 600;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
  border-radius: var(--radius-base);
  transition: background var(--transition-fast) var(--ease-custom),
              color var(--transition-fast) var(--ease-custom);
}
.wb-task-group__head:first-child { border-top: none; margin-top: 0; padding-top: 4px; }
.wb-task-group__head:hover {
  background: var(--tint-primary-08);
  color: var(--text-secondary);
}
.wb-task-group__head:focus-visible {
  outline: var(--focus-outline);
  outline-offset: var(--focus-outline-offset);
}
.wb-task-group__head.is-current {
  color: var(--color-primary);
  border-top-color: var(--tint-primary-30);
}
.wb-task-group__head.is-collapsed {
  /* 折叠时给一个更紧凑的高度 + 轻底色，暗示"点开看更多" */
  background: var(--bg-subtle);
  padding-top: 6px;
  padding-bottom: 6px;
  margin-top: 6px;
  border-top-style: solid;
}
.wb-task-group__head.is-collapsed.is-current {
  background: color-mix(in srgb, var(--color-primary) 8%, var(--bg-subtle));
}
.wb-task-group__caret {
  font-size: var(--font-size-sm);
  flex-shrink: 0;
  opacity: 0.75;
  transition: transform var(--transition-fast) var(--ease-custom);
}
.wb-task-group__icon { font-size: var(--font-size-base); flex-shrink: 0; opacity: 0.8; }
.wb-task-group__name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wb-task-group__count {
  /* 基础样式由 .wb-pill 提供（圆角胶囊 + tnum），这里仅调整 min-width */
  min-width: 18px;
}
.wb-task-group__head.is-current .wb-task-group__count {
  background: var(--tint-primary-16, color-mix(in srgb, var(--color-primary) 16%, transparent));
  color: var(--color-primary);
}

/* ── 任务级字段自动保存指示器（title / desc） ─────────── */
.wb-meta-save {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 10px;
  font-size: var(--font-size-xs);
  font-weight: 600;
  letter-spacing: 0.1px;
  border-radius: var(--radius-xl);
  border: 1px solid var(--border-color-medium);
  background: var(--bg-container);
  color: var(--text-meta);
  flex-shrink: 0;
  user-select: none;
  transition:
    background var(--transition-fast) var(--ease-custom),
    border-color var(--transition-fast) var(--ease-custom),
    color var(--transition-fast) var(--ease-custom);
}
.wb-meta-save__dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.85;
}
.wb-meta-save__check { font-size: var(--font-size-sm); line-height: 1; }
.wb-meta-save__bang {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  font-size: var(--font-size-xs);
  font-weight: 800;
  background: currentColor;
  color: #fff;
  line-height: 1;
}
.wb-meta-save.is-saving {
  color: var(--color-primary);
  border-color: var(--tint-primary-35);
  background: color-mix(in srgb, var(--color-primary) 8%, var(--bg-container));
}
.wb-meta-save.is-saving .wb-meta-save__dot {
  animation: wb-meta-pulse 1.2s ease-in-out infinite;
}
.wb-meta-save.is-saved {
  color: var(--color-success-dark);
  border-color: var(--tint-success-35);
  background: var(--tint-success-08);
}
.wb-meta-save.is-dirty {
  color: var(--color-warning-dark);
  border-color: var(--tint-warning-45);
  background: var(--tint-warning-06);
}
.wb-meta-save.is-error {
  color: var(--color-danger-dark, #b91c1c);
  border-color: var(--tint-danger-45);
  background: var(--tint-danger-06);
}
@keyframes wb-meta-pulse {
  0%, 100% { opacity: 0.4; transform: scale(0.85); }
  50%      { opacity: 1;   transform: scale(1.1); }
}
@media (prefers-reduced-motion: reduce) {
  .wb-meta-save.is-saving .wb-meta-save__dot { animation: none; }
}
</style>

<!-- 「执行日志」弹窗：必须放在非 scoped 块里。
     el-dialog 用 teleport 渲染到 body 下，根 div 不带 data-v，
     scoped 选择器（即便 :deep()）都拿不到它。
     这里的规则只匹配 wb-logs-dialog 这一个 class，影响面可控。 -->
<style>
.wb-logs-dialog {
  max-height: 88vh;
  display: flex;
  flex-direction: column;
}
.wb-logs-dialog .el-dialog__body {
  flex: 1 1 auto;
  min-height: 0;
  max-height: calc(88vh - 60px);
  overflow: auto;
  padding: 12px 20px 16px;
}
</style>

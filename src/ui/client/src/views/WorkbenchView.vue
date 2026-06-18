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
import { ref, computed, onMounted, onBeforeUnmount, reactive, markRaw, watch } from 'vue'
import { $t } from '@/lang/static'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Plus,
  Close,
  List,
  Picture as PictureIcon,
  Document as DocumentIcon,
  DocumentAdd,
  Memo,
  EditPen,
  Folder,
  ArrowDown,
  ArrowRight,
  Document
} from '@element-plus/icons-vue'
import AISplitDialog from '@components/AISplitDialog.vue'
import AttachmentZone from '@components/AttachmentZone.vue'
import JobLogDetails from '@components/JobLogDetails.vue'
import ExecutionLogManager from '@components/ExecutionLogManager.vue'
import { useWorkbenchStatusStore } from '@stores/workbenchStatus'
import { statusColor } from '@/utils/jobStatus'
import type { Job } from '@/types/workbench'

// ── 类型 ────────────────────────────────────────────────────────────────────
interface Prompt {
  id: string
  name: string
  content: string
  createdAt?: string
  updatedAt?: string
}
interface Attachment {
  id: string
  originalName: string
  mimeType: string
  size: number
  ext: string
  absolutePath?: string
  createdAt?: string
}
interface SubTask {
  id: string
  title: string
  desc: string
  status: 'todo' | 'running' | 'done' | 'error'
  promptOverride: string
  attachments?: Attachment[]
}
interface Task {
  id: string
  title: string
  desc: string
  promptId: string | null
  // 'simple'=不需要拆分,执行时直接跑 desc; 'complex'=需要拆子任务
  type?: 'simple' | 'complex'
  // 仅 simple 任务有效:覆盖预置提示词的内容,留空走 task.promptId
  simpleOverride?: string
  // 任务所属项目根路径（创建时记录），用于侧边栏按项目分组显示
  projectPath?: string
  subtasks: SubTask[]
  status: string
  attachments?: Attachment[]
  createdAt?: string
  updatedAt?: string
}

// ── 状态 ────────────────────────────────────────────────────────────────────
const prompts = ref<Prompt[]>([])
const tasks = ref<Task[]>([])
const jobs = ref<Job[]>([])
// 执行日志管理弹窗：默认收起，editor 视图保持常驻
const logsDialogVisible = ref(false)

const selectedTaskId = ref<string | null>(null)
const selectedTask = computed<Task | null>(() => tasks.value.find(t => t.id === selectedTaskId.value) || null)
// 兼容历史数据:缺 type 字段一律按 complex 处理
const isSimpleTask = computed(() => selectedTask.value?.type === 'simple')

// 左右布局：右侧面板当前选中的子任务 id（复杂任务）
const selectedSubId = ref<string | null>(null)
const activeSubtask = computed<SubTask | null>(() => {
  if (!selectedTask.value || isSimpleTask.value) return null
  if (!selectedSubId.value) return null
  return selectedTask.value.subtasks.find(s => s.id === selectedSubId.value) || null
})

// 当前选中 task 在磁盘上的快照（参与 dirty 比较的字段）。
// 拆为两份：subSnapshot 记每个 sub 的 title/desc/promptOverride，
// metaSnapshot 记 task 自身的 title/desc/promptId/simpleOverride。
// 任务级 title/desc/promptId/simpleOverride 改动走"防抖自动保存"。
// - captureSnapshot()  在 loadTasks / persistTask 成功后 / 切换 selectedTaskId 时调用
// - dirtySubIds 对比 selectedTask.subtasks 与 subSnapshot
// - metaDirty    对比 selectedTask.{title,desc,promptId,simpleOverride} 与 metaSnapshot
const subSnapshot = ref<Map<string, { id: string; title: string; desc: string; promptOverride: string }>>(new Map())
const metaSnapshot = ref<{
  title: string
  desc: string
  promptId: string | null
  simpleOverride: string
}>({ title: '', desc: '', promptId: null, simpleOverride: '' })

function captureSnapshot() {
  const m = new Map<string, { id: string; title: string; desc: string; promptOverride: string }>()
  if (selectedTask.value) {
    for (const s of selectedTask.value.subtasks) {
      m.set(s.id, { id: s.id, title: s.title, desc: s.desc, promptOverride: s.promptOverride })
    }
  }
  subSnapshot.value = m
  if (selectedTask.value) {
    metaSnapshot.value = {
      title: selectedTask.value.title,
      desc: selectedTask.value.desc,
      promptId: selectedTask.value.promptId,
      simpleOverride: selectedTask.value.simpleOverride || ''
    }
  } else {
    metaSnapshot.value = { title: '', desc: '', promptId: null, simpleOverride: '' }
  }
}

const dirtySubIds = computed<Set<string>>(() => {
  const dirty = new Set<string>()
  if (!selectedTask.value) return dirty
  for (const s of selectedTask.value.subtasks) {
    const snap = subSnapshot.value.get(s.id)
    if (!snap) {
      // 新增的 sub（快照里没有）也算 dirty
      dirty.add(s.id)
      continue
    }
    if (snap.title !== s.title || snap.desc !== s.desc || snap.promptOverride !== s.promptOverride) {
      dirty.add(s.id)
    }
  }
  return dirty
})

const hasDirtySubtasks = computed(() => dirtySubIds.value.size > 0)

// ── 任务级字段（title / desc / promptId）自动保存 ────────────────────
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
    || metaSnapshot.value.promptId !== t.promptId
    || metaSnapshot.value.simpleOverride !== (t.simpleOverride || '')
})

function clearMetaSaveTimers() {
  if (metaSaveTimer !== null) { clearTimeout(metaSaveTimer); metaSaveTimer = null }
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

// 监听 title/desc/promptId/simpleOverride 变化 → 1.5s 防抖 → flushMetaSave
// 任何字段任一变化都重置计时器（写操作高频时合并）
watch(
  () => selectedTask.value
    ? {
        id: selectedTask.value.id,
        title: selectedTask.value.title,
        desc: selectedTask.value.desc,
        promptId: selectedTask.value.promptId,
        simpleOverride: selectedTask.value.simpleOverride || ''
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

// 切换/新建任务时关闭 AI 拆分弹窗。
// AISplitDialog 由 v-if="selectedTask" 包裹，selectedTask 切换时不会卸载；
// 不显式关闭就会看到上一个任务的 4 个 tab 残留在新任务上。
// 由 AISplitDialog 内部的 taskId watch 负责把 phase/数据清回 idle，下次打开会重跑。
watch(selectedTaskId, () => {
  aiSplitDialogVisible.value = false
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
  if (selectedTask.value && metaDirty.value) {
    beaconPersist(selectedTask.value)
  }
}

const promptDialog = reactive({ visible: false, editing: null as Prompt | null, name: '', content: '', aiLoading: false })
const instructionDialog = reactive({ visible: false, text: '', loading: false, saving: false })
// 任务描述（主任务 desc + 附件）默认折叠，避免占满首屏
const taskDescExpanded = ref(false)
// 任务编辑对话框:同时支持「简单任务」和「复杂任务」两种模式
// - type='simple' 时 simpleOverride 启用,执行走 /run-simple,不进入子任务拆分
// - type='complex' 时 simpleOverride 无意义,UI 隐藏
const taskDialog = reactive({
  visible: false,
  editing: null as Task | null,
  title: '',
  desc: '',
  promptId: null as string | null,
  type: 'complex' as 'simple' | 'complex',
  simpleOverride: ''
})

let es: EventSource | null = null

const wbStatus = useWorkbenchStatusStore()

function syncRunningCount() {
  wbStatus.setRunning(jobs.value.filter(j => j.status === 'running').length)
}

function jobOf(subId: string): Job | null {
  return jobs.value.find(j => j.subId === subId) || null
}

function applyJobEvent(evt: string, payload: any) {
  if (evt === 'hello') {
    jobs.value = payload.jobs || []
    syncRunningCount()
    return
  }
  if (evt === 'job:update') {
    const j: Job = payload
    const i = jobs.value.findIndex(x => x.id === j.id)
    if (i >= 0) jobs.value[i] = j
    else jobs.value.push(j)
    syncRunningCount()
    return
  }
  if (evt === 'job:thinking-delta' || evt === 'job:output-delta') {
    // 流式增量：服务端只发新增片段，避免每帧重复广播整段累积文本。
    // 客户端按 id 找到对应 job，append 到对应字段即可。
    const field = evt === 'job:thinking-delta' ? 'thinking' : 'output'
    const delta: string = payload?.delta || ''
    if (!delta) return
    const i = jobs.value.findIndex(x => x.id === payload.id)
    if (i < 0) return
    const cur = (jobs.value[i] as any)[field] || ''
    ;(jobs.value[i] as any)[field] = cur + delta
    return
  }
  if (evt === 'sub:update') {
    const t = tasks.value.find(x => x.id === payload.taskId)
    if (t) {
      const i = t.subtasks.findIndex(s => s.id === payload.sub.id)
      if (i >= 0) t.subtasks[i] = payload.sub
    }
  }
  if (evt === 'task:update') {
    const i = tasks.value.findIndex(t => t.id === payload.id)
    if (i >= 0) tasks.value[i] = payload
  }
  if (evt === 'task:error') {
    ElMessage.error(payload.error || $t('@WORKBENCH:执行出错'))
  }
}

// ── 任务图标：根据标题关键词做一个轻量分类，决定左侧小头像的图标与颜色 ──
//    不引入新的 Task.type 字段，保持后端 schema 不变；仅做 UI 维度的视觉提示
type TaskIconKey = 'icon' | 'image' | 'test' | 'ui' | 'doc' | 'idea'
const TASK_ICON_RULES: { key: TaskIconKey; patterns: RegExp[] }[] = [
  { key: 'image', patterns: [/图\s*片/, /上\s*传/, /upload/i, /image/i, /screenshot/i, /截图/, /附件/, /attachment/i] },
  { key: 'icon',  patterns: [/图\s*标/, /icon/i, /svg/i] },
  { key: 'test',  patterns: [/测\s*试/, /test/i, /spec/i, /\bqa\b/i] },
  { key: 'ui',    patterns: [/ui\s*优\s*化/, /样\s*式/, /style/i, /css/i, /界面/, /视\s*觉/, /design/i] }
]
function pickTaskIcon(title: string): TaskIconKey {
  const t = (title || '').trim()
  if (!t) return 'doc'
  for (const r of TASK_ICON_RULES) {
    if (r.patterns.some(p => p.test(t))) return r.key
  }
  return 'doc'
}
const ICON_COMPONENT: Record<TaskIconKey, unknown> = {
  icon:  markRaw(DocumentIcon),
  image: markRaw(PictureIcon),
  test:  markRaw(EditPen),
  ui:    markRaw(Memo),
  doc:   markRaw(DocumentIcon),
  idea:  markRaw(Memo)
}
function taskIconFor(t: Task) {
  return ICON_COMPONENT[pickTaskIcon(t.title)]
}

// 简单任务的虚拟 subId：和后端 runTaskSimple / JobLogDetails 那侧保持一致
const SIMPLE_SUB_ID_SUFFIX = '__simple'
function simpleJobFor(task: Task | null): Job | null {
  if (!task) return null
  return jobOf(`${task.id}${SIMPLE_SUB_ID_SUFFIX}`)
}
// 简单任务完成态语义：把 Job.status 收敛成 5 态，方便模板/CSS 直接套用
// - idle      没有 job 记录（未执行过）
// - running   pending/running 视为进行中
// - done      成功
// - error     执行失败
// - cancelled 用户主动停止
type SimpleState = 'idle' | 'running' | 'done' | 'error' | 'cancelled'
function simpleJobState(job: Job | null): SimpleState {
  if (!job) return 'idle'
  if (job.status === 'pending' || job.status === 'running') return 'running'
  if (job.status === 'done') return 'done'
  if (job.status === 'cancelled') return 'cancelled'
  return 'error'
}

function attachmentCount(t: Task): number {
  return Array.isArray(t.attachments) ? t.attachments.length : 0
}
function subtaskCount(t: Task): number {
  return Array.isArray(t.subtasks) ? t.subtasks.length : 0
}
function subtaskDoneCount(t: Task): number {
  if (!Array.isArray(t.subtasks)) return 0
  return t.subtasks.filter(s => s && s.status === 'done').length
}
function taskIsRunning(t: Task): boolean {
  if (Array.isArray(t.subtasks) && t.subtasks.some(s => s && s.status === 'running')) return true
  // 简单任务的执行状态存在 jobs 数组里(virtual subId = `${t.id}__simple`),要一并检查
  const j = jobs.value.find(x => x.subId === `${t.id}__simple`)
  if (j && (j.status === 'running' || j.status === 'pending')) return true
  return false
}

// ── 数据加载 ────────────────────────────────────────────────────────────────
async function loadPrompts() {
  const res = await fetch('/api/workbench/prompts').then(r => r.json()).catch(() => ({ prompts: [] }))
  prompts.value = res.prompts || []
}
async function loadTasks() {
  const res = await fetch('/api/workbench/tasks').then(r => r.json()).catch(() => ({ tasks: [] }))
  tasks.value = res.tasks || []
  if (!selectedTaskId.value && tasks.value.length > 0) {
    selectedTaskId.value = tasks.value[0].id
  }
  // 重新加载后立即拍快照——此时 UI 与磁盘一致
  captureSnapshot()
}

// 当前选中的项目路径 + 项目短名（用于侧边栏按项目分组显示）
const currentProject = ref<{ path: string; name: string }>({ path: '', name: '' })
async function loadCurrentProject() {
  const res = await fetch('/api/workbench/current-project').then(r => r.json()).catch(() => ({}))
  if (res && typeof res.projectPath === 'string') {
    currentProject.value = { path: res.projectPath, name: res.projectName || '' }
  }
}
// 任务列表按 projectPath 分组；同组内保持原有顺序
const NO_PROJECT_KEY = '__no_project__'
// 折叠状态：记录哪些项目分组当前是收起的。用户可手动展开/收起。
// 初次出现 / 切换当前项目时，非当前项目分组默认收起，避免侧栏一眼被别处任务占满。
const collapsedGroupPaths = ref<Set<string>>(new Set())
function isGroupCollapsed(path: string): boolean {
  return collapsedGroupPaths.value.has(path)
}
function toggleGroupCollapsed(path: string) {
  if (collapsedGroupPaths.value.has(path)) collapsedGroupPaths.value.delete(path)
  else collapsedGroupPaths.value.add(path)
  collapsedGroupPaths.value = new Set(collapsedGroupPaths.value)
}
const groupedTasksList = computed(() => {
  const list = tasks.value
  const groups = new Map<string, Task[]>()
  for (const t of list) {
    const raw = (t.projectPath || '').trim()
    const key = raw || NO_PROJECT_KEY
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(t)
  }
  const cur = currentProject.value.path
  const keys = Array.from(groups.keys()).sort((a, b) => {
    if (a === cur) return -1
    if (b === cur) return 1
    if (a === NO_PROJECT_KEY) return 1
    if (b === NO_PROJECT_KEY) return -1
    return a.localeCompare(b)
  })
  return {
    groups: keys.map(path => ({
      path,
      label: path === NO_PROJECT_KEY ? $t('@WORKBENCH:未关联项目') : path,
      tasks: groups.get(path)!
    })),
    hasMultiple: keys.length > 1
  }
})
// 把完整路径压缩成"~/.../末级目录"形式，便于侧边栏显示
function shortProjectLabel(fullPath: string): string {
  if (!fullPath || fullPath === NO_PROJECT_KEY) return fullPath
  const parts = fullPath.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 1) return fullPath
  return parts.slice(-2).join('/')
}

// 首次出现 / 切换当前项目时，把所有「非当前项目」分组默认折叠收起。
// 用户手动展开过的会保留展开；这里只在新增 / 变更路径时补齐折叠状态。
watch(
  () => groupedTasksList.value.groups.map(g => g.path),
  (paths) => {
    const cur = currentProject.value.path
    const next = new Set(collapsedGroupPaths.value)
    let changed = false
    for (const p of paths) {
      if (p !== cur && !next.has(p)) {
        next.add(p)
        changed = true
      }
    }
    if (changed) collapsedGroupPaths.value = next
  },
  { immediate: true }
)
async function loadJobs() {
  const res = await fetch('/api/workbench/jobs').then(r => r.json()).catch(() => ({ jobs: [] }))
  jobs.value = res.jobs || []
  syncRunningCount()
}

/**
 * 清空指定 task 下的所有旧 job,用于"重新执行"场景:
 * 用户已执行过的任务点执行按钮时,先清掉旧输出再启动新任务,
 * 避免旧 job 输出和新输出堆叠显示。
 *
 * 返回:后端 removed 数量(仅用于打日志 / 调试)。
 */
async function clearJobsByTask(taskId: string): Promise<number> {
  try {
    const res = await fetch(`/api/workbench/jobs/by-task/${encodeURIComponent(taskId)}`, { method: 'DELETE' }).then(r => r.json())
    if (!res?.success) {
      console.warn('[clearJobsByTask] failed:', res?.error)
      return 0
    }
    // 后端已清空,本地 jobs 列表也同步清一遍(不等 socket 推送)
    jobs.value = jobs.value.filter(j => j.taskId !== taskId)
    syncRunningCount()
    return res.removed || 0
  } catch (err) {
    console.warn('[clearJobsByTask] error:', err)
    return 0
  }
}

function connectSSE() {
  if (es) { es.close(); es = null }
  es = new EventSource('/api/workbench/events')
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data)
      applyJobEvent(data.event, data.payload)
    } catch { /* ignore */ }
  }
  es.onerror = () => {
    // 自动重连
    if (es) { es.close(); es = null }
    setTimeout(connectSSE, 3000)
  }
}

// ── 提示词 CRUD ─────────────────────────────────────────────────────────────
function openCreatePrompt() {
  promptDialog.editing = null
  promptDialog.name = ''
  promptDialog.content = ''
  promptDialog.aiLoading = false
  promptDialog.visible = true
}
function openEditPrompt(p: Prompt) {
  promptDialog.editing = p
  promptDialog.name = p.name
  promptDialog.content = p.content
  promptDialog.aiLoading = false
  promptDialog.visible = true
}
async function aiGeneratePrompt() {
  if (promptDialog.aiLoading) return
  promptDialog.aiLoading = true
  try {
    const res = await fetch('/api/workbench/prompts/ai-generate', { method: 'POST' }).then(r => r.json())
    if (res.success) {
      // 后端只回 summary（架构说明纯文本），不再拼接 template
      promptDialog.name = res.name || promptDialog.name
      promptDialog.content = res.result || ''
      ElMessage.success($t('@WORKBENCH:已生成，可继续编辑'))
    } else {
      ElMessage.error(res.error || $t('@WORKBENCH:生成失败'))
    }
  } catch (err: any) {
    ElMessage.error($t('@WORKBENCH:网络错误: ') + (err && err.message || err))
  } finally {
    promptDialog.aiLoading = false
  }
}
async function openEditInstruction() {
  instructionDialog.visible = true
  instructionDialog.loading = true
  try {
    const res = await fetch('/api/workbench/prompts/ai-instruction').then(r => r.json())
    if (res.success) {
      instructionDialog.text = res.instruction || ''
    } else {
      ElMessage.error(res.error || $t('@WORKBENCH:读取指令失败'))
    }
  } catch (err: any) {
    ElMessage.error($t('@WORKBENCH:读取指令失败') + ': ' + (err && err.message || err))
  } finally {
    instructionDialog.loading = false
  }
}
async function saveInstruction() {
  if (!instructionDialog.text.trim()) {
    ElMessage.warning($t('@WORKBENCH:指令内容不能为空'))
    return
  }
  instructionDialog.saving = true
  try {
    const res = await fetch('/api/workbench/prompts/ai-instruction', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: instructionDialog.text })
    }).then(r => r.json())
    if (res.success) {
      ElMessage.success($t('@WORKBENCH:已保存指令'))
      instructionDialog.visible = false
    } else {
      ElMessage.error(res.error || $t('@WORKBENCH:保存失败'))
    }
  } catch (err: any) {
    ElMessage.error($t('@WORKBENCH:网络错误: ') + (err && err.message || err))
  } finally {
    instructionDialog.saving = false
  }
}
async function savePrompt() {
  if (!promptDialog.name.trim() || !promptDialog.content.trim()) {
    ElMessage.warning($t('@WORKBENCH:名称和内容不能为空'))
    return
  }
  const body = {
    id: promptDialog.editing?.id,
    name: promptDialog.name.trim(),
    content: promptDialog.content
  }
  const res = await fetch('/api/workbench/prompts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(r => r.json())
  if (res.success) {
    ElMessage.success($t('@WORKBENCH:已保存'))
    promptDialog.visible = false
    loadPrompts()
  } else {
    ElMessage.error(res.error || $t('@WORKBENCH:保存失败'))
  }
}
async function deletePrompt(p: Prompt) {
  await ElMessageBox.confirm(
    $t('@WORKBENCH:删除提示词「{name}」？', { name: p.name }),
    $t('@WORKBENCH:确认'),
    { type: 'warning' }
  )
  await fetch(`/api/workbench/prompts/${p.id}`, { method: 'DELETE' })
  loadPrompts()
  // 清掉引用
  for (const t of tasks.value) {
    if (t.promptId === p.id) {
      t.promptId = null
      await fetch('/api/workbench/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(t)
      })
    }
  }
  loadTasks()
}

// ── 任务 CRUD ───────────────────────────────────────────────────────────────
function openCreateTask() {
  taskDialog.editing = null
  taskDialog.title = ''
  taskDialog.desc = ''
  taskDialog.promptId = null
  taskDialog.type = 'simple'
  taskDialog.simpleOverride = ''
  taskDialog.visible = true
}
async function saveTask() {
  // title is optional: empty title is allowed; UI falls back to "Untitled task"
  const body: any = {
    id: taskDialog.editing?.id,
    title: taskDialog.title.trim(),
    desc: taskDialog.desc,
    promptId: taskDialog.promptId,
    type: taskDialog.type,
    // 简单任务才需要覆盖;复杂任务后端会忽略
    simpleOverride: taskDialog.type === 'simple' ? taskDialog.simpleOverride : '',
    subtasks: taskDialog.editing?.subtasks || []
  }
  // 新建任务时附带当前项目路径；编辑已有任务不覆盖 projectPath
  if (!taskDialog.editing?.id && currentProject.value.path) {
    body.projectPath = currentProject.value.path
  }
  const res = await fetch('/api/workbench/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(r => r.json())
  if (res.success) {
    ElMessage.success($t('@WORKBENCH:已保存'))
    const isCreate = !taskDialog.editing?.id
    taskDialog.visible = false
    await loadTasks()
    // 新建后自动切到新任务；编辑场景保持原选中（loadTasks 兜底确保至少有一个选中）
    if (isCreate && res.task?.id) {
      selectedTaskId.value = res.task.id
      captureSnapshot()
    } else if (!selectedTaskId.value) {
      selectedTaskId.value = res.task.id
    }
  } else {
    ElMessage.error(res.error || $t('@WORKBENCH:保存失败'))
  }
}
// 在任务列表条目上直接切换 simple/complex，不进入编辑 dialog。
// - 简单 → 复杂：无副作用，simpleOverride 会被后端清空（仅 simple 时有意义）
// - 复杂 → 简单：会清空现有子任务，弹 ElMessageBox 让用户确认
// setTaskType(t, type) 是底层 setter，UI 上的所有切换入口（左侧 chip / 顶部 segmented）
// 都通过它来保证"复杂 → 简单"的二次确认逻辑不被绕过。
async function setTaskType(t: Task, type: 'simple' | 'complex') {
  if (t.type === type) return
  const isComplexToSimple = t.type === 'complex' && type === 'simple'
  const willClearSubtasks = isComplexToSimple && (t.subtasks?.length ?? 0) > 0
  if (willClearSubtasks) {
    try {
      await ElMessageBox.confirm(
        $t('@WORKBENCH:任务「{title}」当前有 {n} 个子任务，切换为简单任务后会清空这些子任务，确认继续？', {
          title: t.title,
          n: t.subtasks.length
        }),
        $t('@WORKBENCH:切换任务类型'),
        { type: 'warning', confirmButtonText: $t('@WORKBENCH:切换并清空'), cancelButtonText: $t('@WORKBENCH:取消') }
      )
    } catch {
      return // 用户取消
    }
  }
  const body: any = {
    id: t.id,
    title: t.title,
    desc: t.desc,
    promptId: t.promptId,
    type,
    // 切换为 simple 时后端会用 '' 覆盖 simpleOverride；为 complex 时同理
    simpleOverride: t.simpleOverride || '',
    // 复杂 → 简单时显式传空数组清空子任务；其他情况保留现有
    subtasks: willClearSubtasks ? [] : (t.subtasks || [])
  }
  const res = await fetch('/api/workbench/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(r => r.json())
  if (!res.success) {
    ElMessage.error(res.error || $t('@WORKBENCH:保存失败'))
    return
  }
  await loadTasks()
  ElMessage.success(type === 'simple' ? $t('@WORKBENCH:已切换为简单任务') : $t('@WORKBENCH:已切换为复杂任务'))
}

// 顶部 segmented control 入口：把目标类型交给 setTaskType，
// 当 selectedTask 已是目标类型时直接 no-op，避免误触再次落盘。
async function onTypePillClick(target: 'simple' | 'complex') {
  if (!selectedTask.value) return
  await setTaskType(selectedTask.value, target)
}

async function deleteTask(t: Task) {
  await ElMessageBox.confirm(
    $t('@WORKBENCH:删除任务「{title}」及其所有子任务？', { title: t.title }),
    $t('@WORKBENCH:确认'),
    { type: 'warning' }
  )
  await fetch(`/api/workbench/tasks/${t.id}`, { method: 'DELETE' })
  if (selectedTaskId.value === t.id) selectedTaskId.value = null
  loadTasks()
}
async function selectTask(t: Task) {
  if (selectedTaskId.value === t.id) return
  // 切换前先把当前 task 的未保存 title/desc/promptId 落盘
  clearMetaSaveTimers()
  if (selectedTask.value && metaDirty.value) {
    await flushMetaSave()
  }
  selectedTaskId.value = t.id
  // 切换后立刻拍快照，避免新 task 误标为 dirty
  captureSnapshot()
}

// 切换任务时自动选中第一个子任务（优先选正在执行的）
watch(
  () => selectedTask.value,
  (t) => {
    if (!t || t.type === 'simple') {
      selectedSubId.value = null
      return
    }
    const running = t.subtasks.find(s => s.status === 'running')
    selectedSubId.value = running?.id || t.subtasks[0]?.id || null
  },
  { immediate: true }
)
// 子任务列表变化时补选（AI 拆分后 / 新增后自动选中）
watch(
  () => selectedTask.value?.subtasks?.length,
  () => {
    if (!selectedTask.value || isSimpleTask.value) return
    if (!selectedSubId.value || !selectedTask.value.subtasks.find(s => s.id === selectedSubId.value)) {
      selectedSubId.value = selectedTask.value.subtasks[0]?.id || null
    }
  }
)

// ── 子任务编辑（拆分） ─────────────────────────────────────────────────────
// 子任务行内的"持久化中"集合：避免连续点击同一行触发并发落盘
const subtaskPersistingIds = ref<Set<string>>(new Set())
function isSubtaskPersisting(id: string): boolean {
  return subtaskPersistingIds.value.has(id)
}
function setSubtaskPersisting(id: string, on: boolean) {
  if (on) subtaskPersistingIds.value.add(id)
  else subtaskPersistingIds.value.delete(id)
  // 触发响应式（Set 本身不响应）
  subtaskPersistingIds.value = new Set(subtaskPersistingIds.value)
}

async function addSubtask() {
  if (!selectedTask.value) return
  const sub: SubTask = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    title: $t('@WORKBENCH:新子任务'),
    desc: '',
    status: 'todo',
    promptOverride: ''
  }
  selectedTask.value.subtasks.push(sub)
  // 新子任务立刻落盘，避免后续「执行任务」时后端找不到 id。
  // await 是为了保证「点完添加立刻点执行」时，后端已经能看到这条 sub。
  setSubtaskPersisting(sub.id, true)
  try {
    await persistTask(false)
  } finally {
    setSubtaskPersisting(sub.id, false)
  }
}
async function removeSubtask(sub: SubTask) {
  if (!selectedTask.value) return
  selectedTask.value.subtasks = selectedTask.value.subtasks.filter(s => s.id !== sub.id)
  setSubtaskPersisting(sub.id, true)
  try {
    await persistTask(false)
  } finally {
    setSubtaskPersisting(sub.id, false)
  }
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
    if (showSuccess) ElMessage.success($t('@WORKBENCH:已保存拆分'))
    await loadTasks()
    return true
  } else {
    ElMessage.error(res.error || $t('@WORKBENCH:保存失败'))
    return false
  }
}

async function saveSubtasks() {
  await persistTask(true)
}

// ── 执行 ───────────────────────────────────────────────────────────────────
// AI 拆分子任务：打开对话框，所有过程在 AISplitDialog 内部完成
const aiSplitDialogVisible = ref(false)

function openAiSplitDialog() {
  if (!selectedTask.value) return
  const title = (selectedTask.value.title || '').trim()
  if (!title) {
    ElMessage.warning($t('@WORKBENCH:请先填写任务标题'))
    return
  }
  // 若已有子任务，用户在 confirm 时直接追加
  aiSplitDialogVisible.value = true
}

/**
 * 用户在 AI 拆分对话框点"确认入库"：把拆分结果追加到当前 task 的 subtasks 列表。
 * 自动标 dirty（已有的未保存机制会捕捉）。
 */
function applySplitResult(newSubs: { title: string; desc: string }[]) {
  if (!selectedTask.value) return
  for (const s of newSubs) {
    selectedTask.value.subtasks.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      title: s.title,
      desc: s.desc || '',
      status: 'todo',
      promptOverride: '',
      attachments: []
    })
  }
  ElMessage.success(
    $t('@WORKBENCH:已生成 {n} 个子任务，请审阅后保存', { n: newSubs.length })
  )
}

async function runTask(t: Task) {
  // 简单任务:不需要子任务,直接走 /run-simple
  if (t.type === 'simple') {
    return runSimpleTask(t)
  }
  if (!t.subtasks || t.subtasks.length === 0) {
    ElMessage.warning($t('@WORKBENCH:请先拆分任务'))
    return
  }
  // 若用户编辑过 task 但没点保存，先静默持久化一次。
  if (selectedTask.value && selectedTask.value.id === t.id) {
    // 通过 ref 代理对比：title/desc/subtasks 任意一项与磁盘快照不同就写一次
    const onDisk = tasks.value.find(x => x.id === t.id)
    const dirty = !onDisk
      || onDisk.title !== selectedTask.value.title
      || onDisk.desc !== selectedTask.value.desc
      || JSON.stringify(onDisk.subtasks) !== JSON.stringify(selectedTask.value.subtasks)
      || onDisk.promptId !== selectedTask.value.promptId
    if (dirty) {
      const ok = await persistTask(false)
      if (!ok) return
    }
  }
  // 重新执行:清掉该 task 下的旧 job(内存 + 磁盘),再启动新批
  await clearJobsByTask(t.id)
  const res = await fetch(`/api/workbench/tasks/${t.id}/run`, { method: 'POST' }).then(r => r.json())
  if (res.success) {
    ElMessage.success(res.message || $t('@WORKBENCH:已加入执行队列'))
  } else {
    ElMessage.error(res.error || $t('@WORKBENCH:执行失败'))
  }
}

/**
 * 简单任务执行:不需要任何子任务,后端用 task.desc 合成虚拟 sub 跑。
 * 静默落盘行为跟 runTask 一致:title/desc/simpleOverride/promptId 有改动先 flush。
 * 重新执行时清空旧 job,避免新旧输出堆叠。
 */
async function runSimpleTask(t: Task) {
  if (selectedTask.value && selectedTask.value.id === t.id) {
    const onDisk = tasks.value.find(x => x.id === t.id)
    const dirty = !onDisk
      || onDisk.title !== selectedTask.value.title
      || onDisk.desc !== selectedTask.value.desc
      || onDisk.promptId !== selectedTask.value.promptId
      || (onDisk.simpleOverride || '') !== (selectedTask.value.simpleOverride || '')
    if (dirty) {
      const ok = await persistTask(false)
      if (!ok) return
    }
  }
  // 重新执行简单任务:清掉旧 job 再启动新 job
  await clearJobsByTask(t.id)
  const res = await fetch(`/api/workbench/tasks/${t.id}/run-simple`, { method: 'POST' }).then(r => r.json())
  if (res.success) {
    ElMessage.success(res.message || $t('@WORKBENCH:已加入执行队列'))
  } else {
    ElMessage.error(res.error || $t('@WORKBENCH:执行失败'))
  }
}

/**
 * 单 sub 执行：仅跑指定 subId 那一个，不会触发其他 todo sub。
 * 跟整批"执行任务"走同一套后端逻辑(prompt 拼装 / job 跟踪 / 取消 / 落盘),
 * 唯一区别是不遍历 task.subtasks。
 *
 * 静默落盘行为跟 runTask 一致:用户编辑过但没点"保存拆分"时,先把当前
 * selectedTask 写盘,保证后端拿到的 sub 描述/title 是最新的。
 */
async function runSubtask(sub: SubTask) {
  if (!selectedTask.value) return
  const t = selectedTask.value
  // 已经在跑 → 拒绝,UI 上按钮也应该隐藏,这里再兜底一次
  const live = jobOf(sub.id)
  if (live && (live.status === 'running' || live.status === 'pending')) {
    ElMessage.warning($t('@WORKBENCH:该子任务正在执行中'))
    return
  }
  // 静默落盘:title/desc/subtasks 有变更就先写一次
  const onDisk = tasks.value.find(x => x.id === t.id)
  const dirty = !onDisk
    || onDisk.title !== t.title
    || onDisk.desc !== t.desc
    || JSON.stringify(onDisk.subtasks) !== JSON.stringify(t.subtasks)
    || onDisk.promptId !== t.promptId
  if (dirty) {
    const ok = await persistTask(false)
    if (!ok) return
  }
  const res = await fetch(`/api/workbench/subtasks/${sub.id}/run`, { method: 'POST' })
    .then(r => r.json())
    .catch(err => ({ success: false, error: err?.message || String(err) }))
  if (res.success) {
    ElMessage.success(res.message || $t('@WORKBENCH:已开始执行子任务'))
  } else {
    ElMessage.error(res.error || $t('@WORKBENCH:执行失败'))
  }
}

/**
 * 决定某个 sub 行是否需要显示"执行"按钮。
 * 规则:sub 不在 done 状态 && 当前没有 running/pending 的 job。
 * (UI 上和后端 endpoint 的拒绝条件保持一致)
 */
function canRunSubtask(sub: SubTask): boolean {
  if (sub.status === 'done') return false
  const j = jobOf(sub.id)
  if (j && (j.status === 'running' || j.status === 'pending')) return false
  return true
}

async function cancelDone(sub: SubTask) {
  if (!selectedTask.value) return
  // 防止连续点击触发并发落盘 + 状态抖动
  if (isSubtaskPersisting(sub.id)) return
  setSubtaskPersisting(sub.id, true)
  try {
    // 把磁盘快照里这条 sub 的 status 一起改回 todo，避免 dirty 误标
    const snap = subSnapshot.value.get(sub.id)
    if (snap) {
      subSnapshot.value.set(sub.id, { ...snap, status: 'todo' } as any)
    }
    sub.status = 'todo'
    // 静默落盘：让后端 runTaskQueue 在下次执行时把这 sub 重新纳入队列
    await persistTask(false)
  } finally {
    setSubtaskPersisting(sub.id, false)
  }
}

/**
 * 取消正在执行的 job。点击后会弹确认，确认后调后端 cancel 接口。
 * 取消的语义只影响这一个 sub：已输出的内容保留，同 task 后续 sub 仍按队列继续执行。
 */
async function cancelJob(j: Job) {
  try {
    await ElMessageBox.confirm(
      $t('@WORKBENCH:确认停止执行？已输出的内容会保留。'),
      $t('@WORKBENCH:停止执行'),
      {
        confirmButtonText: $t('@WORKBENCH:停止'),
        cancelButtonText: $t('@WORKBENCH:取消'),
        type: 'warning'
      }
    )
  } catch {
    return
  }
  const res = await fetch(`/api/workbench/jobs/${j.id}/cancel`, { method: 'POST' })
    .then(r => r.json())
    .catch(err => ({ success: false, error: err?.message || String(err) }))
  if (res.success) {
    ElMessage.success($t('@WORKBENCH:已发送停止信号'))
  } else {
    ElMessage.error(res.error || $t('@WORKBENCH:停止失败'))
  }
}

onMounted(async () => {
  await Promise.all([loadPrompts(), loadTasks(), loadCurrentProject(), loadJobs()])
  connectSSE()
  window.addEventListener('beforeunload', onBeforeUnloadPersist)
})
onBeforeUnmount(() => {
  if (es) { es.close(); es = null }
  window.removeEventListener('beforeunload', onBeforeUnloadPersist)
  // 卸载时同步 flush 一次（sendBeacon 不支持时也能尽量保住）
  if (selectedTask.value && metaDirty.value) {
    beaconPersist(selectedTask.value)
  }
})

// ── 日志详情面板已抽到 components/JobLogDetails.vue（自动滚动 / 复制 / 截断都在那里）

// ── 附件上传（主任务 + 子任务共用） ────────────────────────────────────
const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
  'image/bmp', 'image/svg+xml',
  'application/pdf',
  'text/plain', 'text/markdown', 'text/x-markdown', 'text/csv',
  'application/json', 'text/json', 'text/x-log'
])
const ALLOWED_EXT_HINT = '.png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,.pdf,.txt,.md,.csv,.json,.log'
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const uploadingTargets = ref<Record<string, boolean>>({})
const pasteHoverId = ref<string | null>(null)

function isUploading(id: string): boolean { return !!uploadingTargets.value[id] }

function ensureFile(blob: Blob, fallbackName: string): File {
  if (blob instanceof File) return blob
  const mime = blob.type || 'application/octet-stream'
  return new File([blob], fallbackName, { type: mime })
}

/** 附件归属：主任务 或 子任务，决定 URL/存储位置 */
type AttachmentTarget =
  | { kind: 'task'; task: Task | null }
  | { kind: 'sub'; task: Task | null; sub: SubTask }

function targetKey(t: AttachmentTarget): string {
  return t.kind === 'task' ? `task-${t.task?.id ?? ''}` : `sub-${t.sub.id}`
}
function targetAttachments(t: AttachmentTarget): Attachment[] {
  const arr = t.kind === 'task' ? t.task?.attachments : t.sub.attachments
  return Array.isArray(arr) ? (arr as Attachment[]) : []
}
function setTargetAttachments(t: AttachmentTarget, att: Attachment[]) {
  if (t.kind === 'task') { if (t.task) t.task.attachments = att }
  else t.sub.attachments = att
}
function targetUploadUrl(t: AttachmentTarget): string {
  return t.kind === 'task'
    ? `/api/workbench/tasks/${t.task?.id ?? ''}/attachments`
    : `/api/workbench/subtasks/${t.sub.id}/attachments`
}
function targetDeleteUrl(t: AttachmentTarget, attId: string): string {
  return t.kind === 'task'
    ? `/api/workbench/tasks/${t.task?.id ?? ''}/attachments/${attId}`
    : `/api/workbench/subtasks/${t.sub.id}/attachments/${attId}`
}

function onAttachmentPaste(e: ClipboardEvent, t: AttachmentTarget) {
  if (!e.clipboardData) return
  const imageItems = Array.from(e.clipboardData.items).filter(
    it => it.kind === 'file' && it.type.startsWith('image/')
  )
  if (imageItems.length > 0) {
    e.preventDefault()
    for (const it of imageItems) {
      const blob = it.getAsFile()
      if (!blob) continue
      const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      uploadAttachment(t, ensureFile(blob, `paste-${stamp}.${ext}`))
    }
    return
  }
  const fileItems = Array.from(e.clipboardData.items).filter(
    it => it.kind === 'file' && !it.type.startsWith('image/')
  )
  if (fileItems.length > 0) {
    e.preventDefault()
    for (const it of fileItems) {
      const blob = it.getAsFile()
      if (!blob) continue
      uploadAttachment(t, ensureFile(blob, blob.name || 'pasted-file'))
    }
  }
}

function onAttachmentDrop(e: DragEvent, t: AttachmentTarget) {
  pasteHoverId.value = null
  const files = Array.from(e.dataTransfer?.files || [])
  files.forEach(f => uploadAttachment(t, f))
}

async function uploadAttachment(t: AttachmentTarget, file: File) {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    ElMessage.error(`「${file.name}」${$t('@WORKBENCH:超过 5MB 限制')}`)
    return
  }
  if (!ALLOWED_MIME.has(file.type) && !file.name.match(/\.(png|jpg|jpeg|gif|webp|bmp|svg|pdf|txt|md|markdown|csv|json|log)$/i)) {
    ElMessage.error(`${$t('@WORKBENCH:不支持的文件类型')}（${file.name}）`)
    return
  }
  const existing = targetAttachments(t)
  if (existing.length >= 9) {
    ElMessage.error($t('@WORKBENCH:单个任务最多 9 个附件'))
    return
  }
  // 客户端去重：相同 originalName + size 已存在则直接复用，重复上传/粘贴不会
  // 再产生第二条记录。key 不用 mimeType——同名同 size 的不同文件几乎不可能，
  // 但万一真撞了，后端会原样落盘，本地去重后用户看到的就是同一条（acceptable）。
  const dup = existing.find(a => a.originalName === file.name && a.size === file.size)
  if (dup) {
    ElMessage.info(`${file.name} ${$t('@WORKBENCH:已存在，已复用')}`)
    return
  }
  const key = targetKey(t)
  uploadingTargets.value[key] = true
  try {
    const res = await fetch(targetUploadUrl(t), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Original-Name': file.name,
        'X-Mime-Type': file.type || 'application/octet-stream'
      },
      body: file
    }).then(r => r.json())
    if (res.success) {
      const list = targetAttachments(t)
      list.push(res.attachment)
      setTargetAttachments(t, list)
      ElMessage.success(`${$t('@WORKBENCH:已添加：')}${file.name}`)
    } else {
      ElMessage.error(res.error || $t('@WORKBENCH:上传失败'))
    }
  } catch (err: any) {
    ElMessage.error($t('@WORKBENCH:上传失败') + '：' + (err && err.message || err))
  } finally {
    uploadingTargets.value[key] = false
  }
}

async function removeAttachment(t: AttachmentTarget, att: Attachment) {
  try {
    await ElMessageBox.confirm(
      $t('@WORKBENCH:删除附件「{name}」？', { name: att.originalName }),
      $t('@WORKBENCH:确认'),
      { type: 'warning' }
    )
  } catch { return }
  const res = await fetch(targetDeleteUrl(t, att.id), { method: 'DELETE' }).then(r => r.json())
  if (res.success) {
    const list = targetAttachments(t).filter(a => a.id !== att.id)
    setTargetAttachments(t, list)
    ElMessage.success($t('@WORKBENCH:已删除'))
  } else {
    ElMessage.error(res.error || $t('@WORKBENCH:删除失败'))
  }
}

function pickAttachmentFile(t: AttachmentTarget) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = ALLOWED_EXT_HINT
  input.multiple = true
  input.onchange = () => {
    const files = Array.from(input.files || [])
    files.forEach(f => uploadAttachment(t, f))
  }
  input.click()
}


const IMAGE_EXTS_UI = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])
function isImageAttachment(att: Attachment): boolean {
  return IMAGE_EXTS_UI.has(String(att.ext || '').toLowerCase())
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
</script>

<template>
  <div class="workbench">
    <div class="workbench__editor-row">
    <!-- 左：任务列表 -->
    <aside class="wb-sidebar">
      <!-- ── 分组 1：任务列表 ── -->
      <section class="wb-section">
        <header class="wb-section__head">
          <span class="wb-section__tag">{{ $t('@WORKBENCH:任务') }}</span>
          <h3 class="wb-section__title">{{ $t('@WORKBENCH:任务列表') }}</h3>
          <span class="wb-pill wb-section__count">{{ tasks.length }}</span>
        </header>

        <!-- 顶部主操作：新建任务 -->
        <button class="wb-new-btn" @click="openCreateTask">
          <el-icon class="wb-new-btn__icon"><Plus /></el-icon>
          <span>{{ $t('@WORKBENCH:新建任务') }}</span>
          <span class="wb-new-btn__shortcut">N</span>
        </button>

        <ul class="wb-task-list">
          <template v-for="group in groupedTasksList.groups" :key="group.path">
            <li
              v-if="groupedTasksList.hasMultiple"
              class="wb-task-group__head"
              :class="{
                'is-current': group.path === currentProject.path,
                'is-collapsed': isGroupCollapsed(group.path)
              }"
              role="button"
              tabindex="0"
              :aria-expanded="!isGroupCollapsed(group.path)"
              :title="isGroupCollapsed(group.path) ? $t('@WORKBENCH:展开') : $t('@WORKBENCH:收起')"
              @click="toggleGroupCollapsed(group.path)"
              @keydown.enter.prevent="toggleGroupCollapsed(group.path)"
              @keydown.space.prevent="toggleGroupCollapsed(group.path)"
            >
              <el-icon class="wb-task-group__caret">
                <component :is="isGroupCollapsed(group.path) ? ArrowRight : ArrowDown" />
              </el-icon>
              <el-icon class="wb-task-group__icon"><Folder /></el-icon>
              <span class="wb-task-group__name" :title="group.path === currentProject.path ? currentProject.path : group.label">
                {{ group.path === currentProject.path ? currentProject.name : shortProjectLabel(group.label) }}
              </span>
              <span class="wb-pill wb-task-group__count">{{ group.tasks.length }}</span>
            </li>
            <template v-if="!isGroupCollapsed(group.path)">
              <li
                v-for="t in group.tasks"
                :key="t.id"
                class="wb-task-item"
                :class="{
                  active: t.id === selectedTaskId,
                  'has-attachment': attachmentCount(t) > 0,
                  'is-other-project': t.projectPath && t.projectPath !== currentProject.path,
                  'is-running': taskIsRunning(t)
                }"
                :data-icon="pickTaskIcon(t.title)"
                @click="selectTask(t)"
              >
                <div class="wb-task-item__avatar" :data-icon="pickTaskIcon(t.title)">
                  <el-icon><component :is="taskIconFor(t)" /></el-icon>
                </div>
                <div class="wb-task-item__body">
                  <div class="wb-task-item__title" :title="t.title">{{ t.title || $t('@WORKBENCH:未命名任务') }}</div>
                  <div class="wb-task-item__meta">
                    <span
                      v-if="subtaskCount(t) > 0"
                      class="wb-task-item__meta-item"
                      :class="{ 'wb-task-item__meta-item--running': taskIsRunning(t) }"
                      :title="$t('@WORKBENCH:个子任务')"
                    >
                      <el-icon class="wb-task-item__meta-icon"><List /></el-icon>
                      <span class="wb-pill wb-task-item__num">
                        {{ subtaskDoneCount(t) }}/{{ subtaskCount(t) }}
                      </span>
                    </span>
                    <span
                      v-if="attachmentCount(t) > 0"
                      class="wb-task-item__meta-item"
                      :title="$t('@WORKBENCH:附件')"
                    >
                      <el-icon class="wb-task-item__meta-icon"><PictureIcon /></el-icon>
                      <span class="wb-pill wb-task-item__num">{{ attachmentCount(t) }}</span>
                    </span>
                    <span
                      v-if="t.promptId"
                      class="wb-task-item__meta-item wb-task-item__meta-item--accent"
                      :title="$t('@WORKBENCH:已绑定预置提示词')"
                    >
                      <el-icon class="wb-task-item__meta-icon"><Memo /></el-icon>
                    </span>
                    <!--
                      任务类型切换按钮:点击在 simple/complex 间互转。
                      - 简单 → 复杂:直接切换,无副作用(简单任务没有子任务)
                      - 复杂 → 简单:弹 ElMessageBox 确认,因为会清空现有子任务
                    -->
                    <button
                      type="button"
                      class="wb-task-item__meta-item wb-task-item__type-toggle"
                      :class="t.type === 'simple' ? 'wb-task-item__meta-item--simple' : 'wb-task-item__meta-item--complex'"
                      :title="t.type === 'simple' ? $t('@WORKBENCH:简单任务 - 点击切换为复杂任务') : $t('@WORKBENCH:复杂任务 - 点击切换为简单任务')"
                      :aria-label="t.type === 'simple' ? $t('@WORKBENCH:切换为复杂任务') : $t('@WORKBENCH:切换为简单任务')"
                    >
                      {{ t.type === 'simple' ? $t('@WORKBENCH:简单') : $t('@WORKBENCH:复杂') }}
                    </button>
                    <span
                      v-if="t.projectPath && t.projectPath !== currentProject.path"
                      class="wb-task-item__meta-item wb-task-item__meta-item--project"
                      :title="t.projectPath"
                    >
                      {{ shortProjectLabel(t.projectPath) }}
                    </span>
                  </div>
                </div>
                <span
                  v-if="taskIsRunning(t)"
                  class="wb-task-item__running-dot"
                  :title="$t('@WORKBENCH:执行中')"
                  aria-hidden="true"
                />
                <button
                  class="wb-task-item__del"
                  @click.stop="deleteTask(t)"
                  :title="$t('@WORKBENCH:删除')"
                  :aria-label="$t('@WORKBENCH:删除')"
                >
                  <el-icon><Close /></el-icon>
                </button>
              </li>
            </template>
          </template>
          <li v-if="tasks.length === 0" class="wb-empty wb-empty--rich">
            <div class="wb-empty__art" aria-hidden="true">
              <el-icon><DocumentAdd /></el-icon>
            </div>
            <div class="wb-empty__title">{{ $t('@WORKBENCH:暂无任务') }}</div>
            <div class="wb-empty__hint">{{ $t('@WORKBENCH:点击上方按钮新建') }}</div>
            <div class="wb-empty__cta">
              <el-button type="primary" size="small" :icon="Plus" @click="openCreateTask">
                {{ $t('@WORKBENCH:新建任务') }}
              </el-button>
            </div>
          </li>
        </ul>
      </section>

      <!-- ── 分组 2：预置提示词 ── -->
      <section class="wb-section">
        <header class="wb-section__head">
          <span class="wb-section__tag wb-section__tag--accent">{{ $t('@WORKBENCH:提示') }}</span>
          <h3 class="wb-section__title">{{ $t('@WORKBENCH:预置提示词') }}</h3>
          <span class="wb-pill wb-section__count">{{ prompts.length }}</span>
          <button
            class="wb-section__action"
            @click="openCreatePrompt"
            :title="$t('@WORKBENCH:新建提示词')"
            :aria-label="$t('@WORKBENCH:新建提示词')"
          >
            <el-icon><Plus /></el-icon>
          </button>
        </header>
        <ul class="wb-prompt-list">
          <li v-for="p in prompts" :key="p.id" class="wb-prompt-item">
            <div class="wb-prompt-item__icon">
              <el-icon><Memo /></el-icon>
            </div>
            <span class="wb-prompt-item__name" @click="openEditPrompt(p)" :title="p.content">
              {{ p.name }}
            </span>
            <span
              v-if="currentProject.name"
              class="wb-prompt-item__project"
              :title="$t('@WORKBENCH:适用于当前项目') + '：' + currentProject.path"
            >
              {{ currentProject.name }}
            </span>
            <button
              class="wb-prompt-item__del"
              @click="deletePrompt(p)"
              :title="$t('@WORKBENCH:删除')"
              :aria-label="$t('@WORKBENCH:删除')"
            >
              <el-icon><Close /></el-icon>
            </button>
          </li>
          <li v-if="prompts.length === 0" class="wb-empty wb-empty--compact">
            {{ $t('@WORKBENCH:暂无提示词') }}
          </li>
        </ul>
      </section>
    </aside>

    <!-- 中：单任务拆分 -->
    <section class="wb-split">
      <div v-if="!selectedTask" class="wb-placeholder">
        <p>{{ $t('@WORKBENCH:左侧选择任务，或新建一个任务开始') }}</p>
      </div>
      <template v-else>
        <div class="wb-split__header">
          <input
            class="wb-input wb-input--title"
            v-model="selectedTask.title"
            :placeholder="$t('@WORKBENCH:任务标题')"
          />
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
          <select class="wb-select" v-model="selectedTask.promptId">
            <option :value="null">{{ $t('@WORKBENCH:不绑定预置提示词') }}</option>
            <option v-for="p in prompts" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <!-- 任务类型 segmented control：简单/复杂二选一。
               复杂任务下右侧再额外出现 AI 拆分按钮，组成「模式选择 + AI 动作 + 执行」的紧凑操作组。 -->
          <div
            class="wb-mode-switch"
            role="tablist"
            :aria-label="$t('@WORKBENCH:任务类型')"
          >
            <button
              type="button"
              role="tab"
              class="wb-mode-switch__btn"
              :class="{ 'is-active': !isSimpleTask }"
              :aria-selected="!isSimpleTask"
              @click="onTypePillClick('complex')"
            >{{ $t('@WORKBENCH:复杂') }}</button>
            <button
              type="button"
              role="tab"
              class="wb-mode-switch__btn"
              :class="{ 'is-active': isSimpleTask }"
              :aria-selected="isSimpleTask"
              @click="onTypePillClick('simple')"
            >{{ $t('@WORKBENCH:简单') }}</button>
            <span
              class="wb-mode-switch__indicator"
              :class="{ 'is-right': isSimpleTask }"
              aria-hidden="true"
            />
          </div>
          <button
            v-if="!isSimpleTask"
            type="button"
            class="wb-ai-split-btn"
            :disabled="!selectedTask.title || !selectedTask.title.trim()"
            :title="$t('@WORKBENCH:AI 拆分')"
            @click="openAiSplitDialog"
          >
            <svg class="wb-ai-split-btn__icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M8 1.5l1.6 3.4 3.4 1.6-3.4 1.6L8 11.5 6.4 8.1 3 6.5l3.4-1.6L8 1.5zM2.5 9.5l.8 1.6 1.6.8-1.6.8-.8 1.6-.8-1.6L.1 11.9l1.6-.8.8-1.6zm11 0l.8 1.6 1.6.8-1.6.8-.8 1.6-.8-1.6-1.6-.8 1.6-.8.8-1.6z" fill="currentColor"/>
            </svg>
            <span>{{ $t('@WORKBENCH:AI 拆分') }}</span>
          </button>
          <el-button type="primary" :loading="false" @click="runTask(selectedTask)">
            {{ isSimpleTask ? $t('@WORKBENCH:执行') : $t('@WORKBENCH:执行任务') }}
          </el-button>
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
            class="wb-textarea"
            v-model="selectedTask.desc"
            :placeholder="$t('@WORKBENCH:任务描述（可选）')"
            rows="2"
            @paste="onAttachmentPaste($event, { kind: 'task', task: selectedTask })"
          />
          <AttachmentZone
            :attachments="selectedTask.attachments || []"
            :is-image="isImageAttachment"
            :human-size="humanSize"
            :is-uploading="isUploading('task-' + selectedTask.id)"
            :is-paste-hover="pasteHoverId === 'task-' + selectedTask.id"
            :max-count="9"
            :on-pick="() => pickAttachmentFile({ kind: 'task', task: selectedTask })"
            :on-remove="(att) => removeAttachment({ kind: 'task', task: selectedTask }, att)"
            @paste="onAttachmentPaste($event, { kind: 'task', task: selectedTask })"
            @drop.prevent="onAttachmentDrop($event, { kind: 'task', task: selectedTask })"
            @dragover.prevent="pasteHoverId = 'task-' + selectedTask.id"
            @dragenter.prevent="pasteHoverId = 'task-' + selectedTask.id"
            @dragleave="pasteHoverId = (pasteHoverId === 'task-' + selectedTask.id ? null : pasteHoverId)"
          />
        </details>
        <!-- ── 执行主体：复杂任务用左（子任务列表）+ 右（详情）左右布局；简单任务只保留详情面板 ── -->
        <div class="wb-execution-body" :class="{ 'wb-execution-body--simple': isSimpleTask }">
          <!-- 左：子任务列表 —— 简单任务时不渲染 -->
          <div v-if="!isSimpleTask" class="wb-exec-list">
            <div class="wb-exec-list__header">
              <h4 class="wb-exec-list__title">{{ $t('@WORKBENCH:子任务拆分') }}</h4>
              <div class="wb-split__sub-actions">
                <el-button size="small" plain :icon="Plus" :disabled="selectedTask.subtasks.length === 0" @click="addSubtask">
                  {{ $t('@WORKBENCH:添加子任务') }}
                </el-button>
                <el-button size="small" :type="hasDirtySubtasks ? 'primary' : 'default'" :disabled="selectedTask.subtasks.length === 0" @click="saveSubtasks">
                  {{ $t('@WORKBENCH:保存拆分') }}
                  <span v-if="hasDirtySubtasks" class="wb-dirty-badge">{{ dirtySubIds.size }}</span>
                </el-button>
              </div>
            </div>
            <ul class="wb-exec-sub-list">
              <li
                v-for="sub in selectedTask.subtasks"
                :key="sub.id"
                class="wb-exec-sub-item"
                :class="{
                  'is-selected': selectedSubId === sub.id,
                  'is-running': sub.status === 'running',
                  'is-done': sub.status === 'done',
                  'is-dirty': dirtySubIds.has(sub.id),
                  'is-persisting': isSubtaskPersisting(sub.id)
                }"
                @click="selectedSubId = sub.id"
              >
                <!-- 第一行：状态徽章 + 标题 -->
                <div class="wb-exec-sub-item__row1">
                  <span class="wb-sub-item__status wb-sub-item__status--dot" :style="{ background: statusColor(sub.status) }" :title="$t('@WORKBENCH:任务完成状态')">
                    <span class="wb-simple__status-dot" aria-hidden="true"></span>
                  </span>
                  <span class="wb-exec-sub-item__title" :title="sub.title">
                    {{ sub.title || $t('@WORKBENCH:未命名子任务') }}
                  </span>
                  <span v-if="dirtySubIds.has(sub.id)" class="wb-exec-sub-item__dirty-dot" title="未保存" />
                </div>
                <!-- 第二行：PID + 操作按钮（hover/选中时浮现） -->
                <div class="wb-exec-sub-item__row2">
                  <span v-if="jobOf(sub.id)" class="wb-sub-item__pid">PID: {{ jobOf(sub.id)?.pid }}</span>
                  <span class="wb-exec-sub-item__actions">
                    <button v-if="canRunSubtask(sub)" class="wb-exec-sub-btn wb-exec-sub-btn--run" :title="$t('@WORKBENCH:单独执行此子任务')" @click.stop="runSubtask(sub)">{{ $t('@WORKBENCH:执行') }}</button>
                    <button v-if="jobOf(sub.id) && (jobOf(sub.id)?.status === 'running' || jobOf(sub.id)?.status === 'pending')" class="wb-exec-sub-btn wb-exec-sub-btn--stop" :title="$t('@WORKBENCH:停止执行')" @click.stop="cancelJob(jobOf(sub.id)!)">{{ $t('@WORKBENCH:停止') }}</button>
                    <button v-if="sub.status === 'done'" class="wb-exec-sub-btn wb-exec-sub-btn--undo" :title="$t('@WORKBENCH:取消完成')" :disabled="isSubtaskPersisting(sub.id)" @click.stop="cancelDone(sub)">{{ $t('@WORKBENCH:取消完成') }}</button>
                    <button class="wb-exec-sub-btn wb-exec-sub-btn--del" :title="$t('@WORKBENCH:删除')" :disabled="isSubtaskPersisting(sub.id)" @click.stop="removeSubtask(sub)">×</button>
                  </span>
                </div>
              </li>
              <li v-if="selectedTask.subtasks.length === 0" class="wb-empty wb-empty--rich">
                <div class="wb-empty__art" aria-hidden="true"><el-icon><List /></el-icon></div>
                <div class="wb-empty__title">{{ $t('@WORKBENCH:拆分任务，逐项执行') }}</div>
                <div class="wb-empty__cta">
                  <el-button type="primary" size="small" :icon="Plus" @click="addSubtask">{{ $t('@WORKBENCH:添加子任务') }}</el-button>
                </div>
              </li>
            </ul>
          </div>

          <!-- 右：详情面板（执行内容区，宽度充足） -->
          <div class="wb-exec-detail">
            <!-- 复杂任务详情：显示选中子任务的完整内容 -->
            <template v-if="!isSimpleTask">
              <div v-if="!activeSubtask" class="wb-placeholder">
                <p>{{ selectedTask.subtasks.length === 0 ? $t('@WORKBENCH:手动添加子任务，或让 AI 帮你自动拆分') : $t('@WORKBENCH:左侧选择子任务查看详情') }}</p>
              </div>
              <template v-else>
                <div class="wb-exec-detail__head">
                  <input
                    class="wb-input"
                    v-model="activeSubtask.title"
                    :placeholder="$t('@WORKBENCH:子任务标题')"
                    @click.stop
                    @paste="onAttachmentPaste($event, { kind: 'sub', task: selectedTask, sub: activeSubtask })"
                  />
                  <span v-if="dirtySubIds.has(activeSubtask.id)" class="wb-sub-item__dirty" :title="$t('@WORKBENCH:有未保存的更改')">{{ $t('@WORKBENCH:未保存') }}</span>
                </div>
                <textarea
                  class="wb-textarea wb-textarea--sm"
                  v-model="activeSubtask.desc"
                  :placeholder="$t('@WORKBENCH:子任务描述 / 独立提示词覆盖')"
                  rows="3"
                  @paste="onAttachmentPaste($event, { kind: 'sub', task: selectedTask, sub: activeSubtask })"
                />
                <JobLogDetails
                  v-if="jobOf(activeSubtask.id)"
                  :job="jobOf(activeSubtask.id)!"
                />
                <AttachmentZone
                  :attachments="activeSubtask.attachments || []"
                  :is-image="isImageAttachment"
                  :human-size="humanSize"
                  :is-uploading="isUploading('sub-' + activeSubtask.id)"
                  :is-paste-hover="pasteHoverId === activeSubtask.id"
                  :max-count="9"
                  :on-pick="() => pickAttachmentFile({ kind: 'sub', task: selectedTask, sub: activeSubtask! })"
                  :on-remove="(att) => removeAttachment({ kind: 'sub', task: selectedTask, sub: activeSubtask! }, att)"
                  @paste="onAttachmentPaste($event, { kind: 'sub', task: selectedTask, sub: activeSubtask })"
                  @drop.prevent="onAttachmentDrop($event, { kind: 'sub', task: selectedTask, sub: activeSubtask })"
                  @dragover.prevent="pasteHoverId = activeSubtask.id"
                  @dragenter.prevent="pasteHoverId = activeSubtask.id"
                  @dragleave="pasteHoverId = (pasteHoverId === activeSubtask.id ? null : pasteHoverId)"
                />
              </template>
            </template>

            <!-- 简单任务详情：状态完全交给 JobLogDetails 的「正在执行…」展示 -->
            <template v-else>
              <details
                class="wb-simple__override"
                :class="{ 'has-content': !!(selectedTask.simpleOverride && selectedTask.simpleOverride.trim()) }"
              >
                <summary class="wb-form-item__label wb-simple__override-summary">
                  <el-icon class="wb-simple__override-caret"><ArrowRight /></el-icon>
                  <span>{{ $t('@WORKBENCH:覆盖预置提示词（可选）') }}</span>
                  <span
                    v-if="selectedTask.simpleOverride && selectedTask.simpleOverride.trim()"
                    class="wb-simple__override-tag"
                    :title="$t('@WORKBENCH:已填写覆盖内容')"
                  >{{ $t('@WORKBENCH:已填写') }}</span>
                  <button
                    v-if="simpleJobState(simpleJobFor(selectedTask)) === 'running' && simpleJobFor(selectedTask)"
                    class="wb-simple__stop"
                    :disabled="isSubtaskPersisting(simpleJobFor(selectedTask)!.id)"
                    @click.stop="cancelJob(simpleJobFor(selectedTask)!)"
                  >
                    {{ $t('@WORKBENCH:停止') }}
                  </button>
                </summary>
                <textarea
                  class="wb-textarea"
                  v-model="selectedTask.simpleOverride"
                  :placeholder="$t('@WORKBENCH:留空则使用上方选定的「预置提示词」模板;可用变量同子任务:｛｛task.title｝｝ ｛｛task.desc｝｝ ｛｛repo.path｝｝ ｛｛branch｝｝')"
                  rows="6"
                />
              </details>
              <!-- 简单任务的执行日志：running 时顶部显示「● 正在执行…」 -->
              <JobLogDetails
                v-if="jobOf(`${selectedTask.id}__simple`)"
                :job="jobOf(`${selectedTask.id}__simple`)!"
              />
            </template>
          </div>
        </div>
      </template>
    </section>
    </div>

    <!-- 执行日志管理：弹窗形式承载，原本独立 tab 切换会占用首屏。 -->
    <el-dialog
      v-model="logsDialogVisible"
      :title="$t('@WORKBENCH:执行日志')"
      width="1080px"
      :close-on-click-modal="false"
      top="6vh"
      class="wb-logs-dialog"
    >
      <ExecutionLogManager />
    </el-dialog>

    <!-- 提示词编辑对话框 -->
    <el-dialog
      v-model="promptDialog.visible"
      :title="promptDialog.editing ? $t('@WORKBENCH:编辑提示词') : $t('@WORKBENCH:新建提示词')"
      width="640px"
    >
      <el-form label-position="top">
        <el-form-item :label="$t('@WORKBENCH:名称')">
          <el-input v-model="promptDialog.name" :placeholder="$t('@WORKBENCH:如：代码审查 / 写测试')" />
        </el-form-item>
        <el-form-item>
          <div style="display: flex; gap: 8px; align-items: center;">
            <el-button
              type="primary"
              plain
              :loading="promptDialog.aiLoading"
              @click="aiGeneratePrompt"
            >
              {{ $t('@WORKBENCH:AI 生成项目架构说明') }}
            </el-button>
            <el-button @click="openEditInstruction">
              {{ $t('@WORKBENCH:编辑指令') }}
            </el-button>
          </div>
        </el-form-item>
        <el-form-item :label="$t('@WORKBENCH:内容')">
          <el-input
            v-model="promptDialog.content"
            type="textarea"
            :rows="10"
            :placeholder="$t('@WORKBENCH:可用变量：') + '｛｛task.title｝｝ ｛｛task.desc｝｝ ｛｛sub.title｝｝ ｛｛sub.desc｝｝ ｛｛repo.path｝｝ ｛｛branch｝｝'"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="promptDialog.visible = false">{{ $t('@WORKBENCH:取消') }}</el-button>
        <el-button type="primary" @click="savePrompt">{{ $t('@WORKBENCH:保存') }}</el-button>
      </template>
    </el-dialog>

    <!-- 生成指令编辑对话框 -->
    <el-dialog
      v-model="instructionDialog.visible"
      :title="$t('@WORKBENCH:编辑生成指令')"
      width="720px"
      append-to-body
    >
      <el-form label-position="top">
        <el-form-item :label="$t('@WORKBENCH:指令内容')">
          <el-input
            v-model="instructionDialog.text"
            type="textarea"
            :rows="18"
            :placeholder="$t('@WORKBENCH:指令内容')"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="instructionDialog.visible = false">{{ $t('@WORKBENCH:取消') }}</el-button>
        <el-button type="primary" :loading="instructionDialog.saving" @click="saveInstruction">{{ $t('@WORKBENCH:保存') }}</el-button>
      </template>
    </el-dialog>

    <!-- 任务编辑对话框 -->
    <el-dialog
      v-model="taskDialog.visible"
      :title="taskDialog.editing ? $t('@WORKBENCH:编辑任务') : $t('@WORKBENCH:新建任务')"
      width="600px"
    >
      <el-form label-position="top">
        <el-form-item :label="$t('@WORKBENCH:标题（可选）')">
          <el-input
            v-model="taskDialog.title"
            :placeholder="$t('@WORKBENCH:不填则自动命名为「无标题」，稍后可在任务列表里改名')"
          />
        </el-form-item>
        <el-form-item :label="$t('@WORKBENCH:类型')">
          <el-radio-group v-model="taskDialog.type">
            <el-radio-button value="complex">{{ $t('@WORKBENCH:复杂任务（需要拆分子任务）') }}</el-radio-button>
            <el-radio-button value="simple">{{ $t('@WORKBENCH:简单任务（直接执行）') }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item
          v-if="taskDialog.type === 'simple'"
          :label="$t('@WORKBENCH:描述')"
        >
          <el-input
            v-model="taskDialog.desc"
            type="textarea"
            :rows="4"
            :placeholder="$t('@WORKBENCH:把要做的事直接写在这里,执行时会把这段描述作为 prompt 喂给 Claude')"
          />
        </el-form-item>
        <el-form-item
          v-else
          :label="$t('@WORKBENCH:描述')"
        >
          <el-input v-model="taskDialog.desc" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item v-if="taskDialog.type === 'simple'" :label="$t('@WORKBENCH:覆盖预置提示词（可选）')">
          <el-input
            v-model="taskDialog.simpleOverride"
            type="textarea"
            :rows="5"
            :placeholder="$t('@WORKBENCH:留空则使用「预置提示词」下拉里选定的模板;可用变量同子任务覆盖。')"
          />
        </el-form-item>
        <el-form-item :label="$t('@WORKBENCH:预置提示词')">
          <el-select v-model="taskDialog.promptId" clearable :placeholder="$t('@WORKBENCH:不绑定')" style="width: 100%;">
            <el-option
              v-for="p in prompts"
              :key="p.id"
              :label="p.name"
              :value="p.id"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="taskDialog.visible = false">{{ $t('@WORKBENCH:取消') }}</el-button>
        <el-button type="primary" @click="saveTask">{{ $t('@WORKBENCH:保存') }}</el-button>
      </template>
    </el-dialog>

    <!-- AI 拆分对话框：流式展示 LLM 思考 + 原始结果 + 入库确认 -->
    <AISplitDialog
      v-if="selectedTask"
      v-model="aiSplitDialogVisible"
      :title="selectedTask.title"
      :desc="selectedTask.desc"
      :task-id="selectedTask.id"
      :prompt-id="selectedTask.promptId"
      @confirm="applySplitResult"
    />
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

/* 顶部条已移除：执行日志入口直接合到任务头（与「执行任务」按钮同处），节省首屏纵向空间。 */

/* 任务描述折叠：默认收起，点击 summary 展开。 */
.wb-task-desc {
  border-radius: 10px;
  background: var(--bg-subtle);
  padding: 0;
  margin: 0;
  flex-shrink: 0;
  overflow: hidden;
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
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  user-select: none;
}
.wb-task-desc__summary::-webkit-details-marker { display: none; }
.wb-task-desc__summary:hover { background: var(--bg-container-hover); }
.wb-task-desc__caret {
  font-size: 12px;
  color: var(--text-tertiary);
  transition: transform 0.15s;
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
  font-size: 10px;
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
  border-radius: 8px;
  background: var(--tint-primary-14);
  color: var(--color-primary);
  font-variant-numeric: tabular-nums;
}
.wb-task-desc[open] .wb-task-desc__summary {
  margin-bottom: 0;
}
.wb-task-desc > .wb-textarea,
.wb-task-desc > :deep(.attachment-zone) {
  margin: 8px 12px 10px;
}
.wb-task-desc > .wb-textarea {
  margin-bottom: 0;
}
.wb-task-desc > :deep(.attachment-zone) {
  margin-top: 0;
}

/* editor 视图的子行容器：把 sidebar + split 重新横向排列（workbench 改成 column 后需要这一层） */
.workbench__editor-row {
  display: flex;
  flex: 1;
  min-height: 0;
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
     否则任务列表最后一项会被下方"预置提示词"分组压上来形成重叠。 */
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
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.4px;
  color: var(--text-tertiary);
  background: var(--bg-subtle);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
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
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: 0.2px;
  flex: 1;
  min-width: 0;
}
.wb-section__action {
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 13px;
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
  height: 30px;
  padding: 0 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--color-primary);
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: 0.05px;
  cursor: pointer;
  transition: background var(--transition-fast) var(--ease-custom),
              color var(--transition-fast) var(--ease-custom);
}
.wb-new-btn__icon {
  font-size: 13px;
  flex-shrink: 0;
  transition: transform var(--transition-fast) var(--ease-custom);
}
.wb-new-btn__shortcut {
  /* N 快捷键徽标：当前版本未注册全局快捷键，避免误导用户。
     样式保留以便后续接入快捷键时直接恢复。 */
  display: none;
}
.wb-new-btn:hover {
  background: var(--tint-primary-12);
  color: var(--color-primary);
}
.wb-new-btn:hover .wb-new-btn__icon {
  transform: rotate(90deg);
}
.wb-new-btn:active {
  transform: scale(0.99);
}
.wb-new-btn:focus-visible {
  outline: 2px solid var(--color-primary);
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
  /* 紧凑单行：上下 padding 从 9px → 6px，左右 10 → 10 不变 */
  padding: 6px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  transition: background var(--transition-fast) var(--ease-custom),
              color var(--transition-fast) var(--ease-custom);
}
.wb-task-item.is-running {
  /* 执行中:浅暖色底,左侧竖条留给 active(选中)用 */
  background: color-mix(in srgb, var(--color-warning) 8%, transparent);
}
.wb-task-item.is-running:hover {
  /* hover 时稍微加深一点,提示"在跑但可点" */
  background: color-mix(in srgb, var(--color-warning) 14%, transparent);
}
.wb-task-item:hover {
  background: var(--bg-container-hover);
  border-color: transparent;
}
.wb-task-item:hover .wb-task-item__del {
  opacity: 1;
  transform: translateX(0);
}
.wb-task-item.active {
  background: color-mix(in srgb, var(--color-primary) 9%, var(--bg-container));
  border-color: transparent;
  box-shadow: none;
}
.wb-task-item.active::after {
  content: '';
  position: absolute;
  left: -1px;
  top: 4px;
  bottom: 4px;
  width: 2px;
  border-radius: 2px;
  background: var(--color-primary);
  box-shadow: 0 0 6px color-mix(in srgb, var(--color-primary) 60%, transparent);
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

/* 左侧头像：紧凑圆形 22×22，去掉边框 */
.wb-task-item__avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  flex-shrink: 0;
  background: var(--bg-subtle);
  color: var(--text-tertiary);
  border: none;
  transition: background var(--transition-fast) var(--ease-custom),
              color var(--transition-fast) var(--ease-custom),
              border-color var(--transition-fast) var(--ease-custom);
}
.wb-task-item__avatar[data-icon="image"] {
  background: color-mix(in srgb, var(--color-think) 12%, transparent);
  color: var(--color-think-dark, #6d28d9);
  border: none;
}
.wb-task-item__avatar[data-icon="icon"] {
  background: color-mix(in srgb, var(--color-info-light) 12%, transparent);
  color: var(--color-info, #0369a1);
  border: none;
}
.wb-task-item__avatar[data-icon="test"] {
  background: var(--tint-success-14);
  color: var(--color-success-dark, #047857);
  border: none;
}
.wb-task-item__avatar[data-icon="ui"] {
  background: color-mix(in srgb, var(--color-warning) 12%, transparent);
  color: var(--color-warning-dark, #b45309);
  border: none;
}
.wb-task-item.active .wb-task-item__avatar {
  background: var(--color-primary);
  color: #fff;
  border-color: var(--color-primary);
}
.wb-task-item__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.wb-task-item__title {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  letter-spacing: -0.1px;
  line-height: 1.25;
}
.wb-task-item__meta {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: var(--text-tertiary);
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
/* 任务类型切换按钮：点击在 simple/complex 间互转。
   复用 meta-item 的尺寸节奏（h=15, r=7, fz=10, fw=600），用色区分两种状态。*/
.wb-task-item__type-toggle {
  height: 15px;
  padding: 0 6px;
  border-radius: 7px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2px;
  white-space: nowrap;
  border: none;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease, transform 0.1s ease;
  font-family: inherit;
}
.wb-task-item__type-toggle:active { transform: scale(0.96); }
.wb-task-item__type-toggle:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}
/* 简单任务徽标：紧凑圆角胶囊,弱色调以不抢戏 */
.wb-task-item__meta-item--simple {
  display: inline-flex;
  align-items: center;
  height: 15px;
  padding: 0 6px;
  border-radius: 7px;
  background: var(--tint-success-14);
  color: var(--color-success-dark, #047857);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2px;
  white-space: nowrap;
}
/* 复杂任务徽标：紫蓝调，区别于简单任务的绿色调 */
.wb-task-item__meta-item--complex {
  background: var(--tint-think-14);
  color: var(--color-think-darker, #4338ca);
}
.wb-task-item__type-toggle:hover {
  filter: brightness(0.95);
}
/* 跨项目的任务：在 meta 行内加一个简短的项目名徽标，提示"这条是别的项目的" */
.wb-task-item__meta-item--project {
  display: inline-flex;
  align-items: center;
  height: 15px;
  padding: 0 5px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--color-warning, #f59e0b) 14%, transparent);
  color: color-mix(in srgb, var(--color-warning, #f59e0b) 80%, var(--text-primary));
  font-size: 10px;
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
.wb-task-item__meta-icon { font-size: 11px; opacity: 0.85; }
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
  color: color-mix(in srgb, var(--color-warning, #f59e0b) 85%, var(--text-primary));
  background: color-mix(in srgb, var(--color-warning, #f59e0b) 18%, transparent);
  font-weight: 600;
}
.wb-task-item.is-running .wb-task-item__meta-icon {
  color: color-mix(in srgb, var(--color-warning, #f59e0b) 80%, var(--text-primary));
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
  color: var(--text-tertiary);
  width: 22px;
  height: 22px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 12px;
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
  color: var(--color-danger);
}
.wb-task-item__del:focus-visible {
  outline: var(--focus-outline);
  outline-offset: var(--focus-outline-offset);
  opacity: 1;
}
.wb-task-item__del,
.wb-prompt-item__del,
.wb-sub-item__del { font-size: 13px; }

/* ── 提示词列表 ─────────────────────────────────────── */
.wb-prompt-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: var(--radius-md);
  font-size: var(--font-size-125);
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
  border-radius: var(--radius-sm);
  background: var(--tint-primary-08);
  color: var(--color-primary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
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
/* 提示词项右侧的项目徽标——提示词本体跨项目共享，仅做"适用于当前项目"的视觉提示 */
.wb-prompt-item__project {
  display: inline-flex;
  align-items: center;
  height: 16px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--tint-primary-12);
  color: var(--color-primary);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2px;
  white-space: nowrap;
  flex-shrink: 0;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wb-prompt-item__del {
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  width: 20px;
  height: 20px;
  border-radius: var(--radius-xs);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 12px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity var(--transition-fast) var(--ease-custom),
              background var(--transition-fast) var(--ease-custom),
              color var(--transition-fast) var(--ease-custom);
}
.wb-prompt-item__del:hover {
  background: color-mix(in srgb, var(--color-danger) 14%, transparent);
  color: var(--color-danger);
}
.wb-prompt-item__del:focus-visible {
  outline: var(--focus-outline);
  outline-offset: var(--focus-outline-offset);
  opacity: 1;
}

/* ── 空状态 ─────────────────────────────────────────── */
.wb-empty {
  padding: 22px 12px 18px;
  text-align: center;
  color: var(--text-tertiary);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}
.wb-empty--compact {
  padding: 10px 12px;
  flex-direction: row;
  justify-content: center;
  gap: 0;
}
.wb-empty__icon {
  font-size: 22px;
  color: var(--text-tertiary);
  opacity: 0.65;
  margin-bottom: 2px;
}
.wb-empty__text {
  font-size: var(--font-size-125);
  font-weight: 500;
  color: var(--text-secondary);
}
.wb-empty__hint {
  font-size: 11px;
  color: var(--text-tertiary);
}

/* ── 空状态：富卡片版（子任务拆分） ────────────────── */
.wb-empty--rich {
  padding: 32px 28px 28px;
  gap: 10px;
  background: var(--bg-container);
  margin: 4px 2px 2px;
}
.wb-empty__art {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--tint-primary-12);
  color: var(--color-primary);
  font-size: 22px;
  margin-bottom: 2px;
}
.wb-empty__title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: var(--letter-spacing-heading, -0.25px);
  color: var(--text-secondary);
  line-height: 1.4;
}
.wb-empty--rich .wb-empty__hint {
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-tertiary);
  max-width: 280px;
}
.wb-empty__cta {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 6px;
  flex-wrap: wrap;
  justify-content: center;
}
.wb-empty__link {
  appearance: none;
  background: none;
  border: 0;
  /* 提升到 ≥32px 命中区，更接近 44px 触摸目标规范（ui-ux-pro-max） */
  min-height: 32px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-primary);
  cursor: pointer;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  transition: color 0.15s ease-out, background-color 0.15s ease-out;
}
.wb-empty__link:hover:not(:disabled) {
  color: var(--color-primary);
  background: var(--tint-primary-08);
}
.wb-empty__link:focus-visible {
  outline: var(--focus-outline);
  outline-offset: var(--focus-outline-offset-lg);
}
.wb-empty__link:disabled {
  color: var(--text-tertiary);
  cursor: not-allowed;
  opacity: 0.6;
}
@media (prefers-reduced-motion: reduce) {
  .wb-empty__link {
    transition: none;
  }
}

.wb-split {
  flex: 1;
  min-height: 0;
  padding: 10px 16px 10px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wb-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  font-size: 13px;
}

/* ── 执行主体：左右两列布局 ── */
/*
  关键:用 CSS Grid 替代 flex row。
  - flex item 的 height: 100% 在父级也是 flex item 时会 fallback 到 auto(父级没有显式 height)
  - grid 子项默认 align-self: stretch + justify-self: stretch,自动撑满 cell 高度
  - 不需要 height: 100% 链,flex chain 也能正常传递 max-height 给子级
  - 简单任务时切到 1fr 单列,详情面板占满
*/
.wb-execution-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 260px 1fr;
  border: none;
  border-radius: 0;
  overflow: hidden;
  gap: 16px;
}
.wb-execution-body--simple {
  grid-template-columns: 1fr;
  gap: 0;
}

/* 左列：子任务列表（固定宽度，内部滚动） */
.wb-exec-list {
  width: 100%;
  min-width: 0;
  min-height: 0;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-subtle);
}
.wb-exec-list__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px 8px;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.wb-exec-list__title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: 0.1px;
  flex-shrink: 0;
}
.wb-exec-list__header .wb-split__sub-actions {
  margin-left: auto;
}
.wb-exec-sub-list {
  list-style: none;
  margin: 0;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

/* 左列子任务条目：两行布局，标题独占第一行，操作按钮 hover 浮现 */
.wb-exec-sub-item {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 7px 8px 5px;
  border-radius: var(--radius-md);
  cursor: pointer;
  user-select: none;
  border: 1px solid transparent;
  transition:
    background var(--transition-fast) var(--ease-custom),
    border-color var(--transition-fast) var(--ease-custom);
}
.wb-exec-sub-item:hover {
  background: var(--bg-container-hover);
  border-color: var(--border-color);
}
.wb-exec-sub-item.is-selected {
  background: color-mix(in srgb, var(--color-primary) 9%, var(--bg-container));
  border-color: var(--tint-primary-35);
}
.wb-exec-sub-item.is-running {
  border-color: var(--tint-primary-45);
  background: color-mix(in srgb, var(--color-primary) 6%, var(--bg-container));
}
/* 执行面板内的徽章：和左侧子任务列表复用同一套执行中特效 */
.wb-exec-sub-item.is-running .wb-sub-item__status {
  background: linear-gradient(
    90deg,
    var(--color-primary) 0%,
    color-mix(in srgb, var(--color-primary) 70%, #fff) 50%,
    var(--color-primary) 100%
  ) !important;
  background-size: 200% 100% !important;
  animation: wb-status-pulse 2.4s ease-in-out infinite,
             wb-status-shimmer 2.4s linear infinite;
  box-shadow:
    0 0 0 0 var(--tint-primary-45),
    0 0 12px var(--tint-primary-35);
}
.wb-exec-sub-item.is-running .wb-sub-item__status::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 6px rgba(255, 255, 255, 0.9);
  animation: wb-status-dot 1.2s ease-in-out infinite;
}
.wb-exec-sub-item.is-running .wb-sub-item__status::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.4) 50%,
    transparent 100%
  );
  animation: wb-status-sweep 2.4s ease-in-out infinite;
  pointer-events: none;
}
.wb-exec-sub-item.is-done:not(.is-selected) {
  opacity: 0.75;
}

/* 第一行：状态徽章 + 标题 */
.wb-exec-sub-item__row1 {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
/* 第二行：PID + 操作按钮（默认高度0隐藏，hover/selected 时展开） */
.wb-exec-sub-item__row2 {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  max-height: 0;
  opacity: 0;
  padding-top: 0;
  transition:
    max-height 0.18s var(--ease-custom),
    opacity 0.15s var(--ease-custom),
    padding-top 0.18s var(--ease-custom);
}
.wb-exec-sub-item:hover .wb-exec-sub-item__row2,
.wb-exec-sub-item.is-selected .wb-exec-sub-item__row2,
.wb-exec-sub-item.is-running .wb-exec-sub-item__row2 {
  max-height: 28px;
  opacity: 1;
  padding-top: 5px;
}
.wb-exec-sub-item__actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
/* 第二行 dirty 小圆点 */
.wb-exec-sub-item__dirty-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-warning);
  flex-shrink: 0;
}

/* 操作按钮（统一小尺寸胶囊） */
.wb-exec-sub-btn {
  appearance: none;
  border: 1px solid var(--border-color-medium);
  background: var(--bg-container);
  color: var(--text-tertiary);
  font-size: 10px;
  font-weight: 600;
  padding: 0 7px;
  height: 20px;
  border-radius: 10px;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.wb-exec-sub-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.wb-exec-sub-btn--run {
  color: var(--color-primary);
  border-color: var(--tint-primary-35);
  background: color-mix(in srgb, var(--color-primary) 6%, var(--bg-container));
}
.wb-exec-sub-btn--run:hover { background: color-mix(in srgb, var(--color-primary) 14%, var(--bg-container)); }
.wb-exec-sub-btn--stop {
  color: var(--color-danger-bright, #ef4444);
  border-color: var(--tint-danger-50);
  background: var(--tint-danger-06);
}
.wb-exec-sub-btn--stop:hover { background: var(--tint-danger-14); }
.wb-exec-sub-btn--undo {
  color: var(--color-primary);
  border-color: var(--tint-primary-35);
  background: color-mix(in srgb, var(--color-primary) 6%, var(--bg-container));
}
.wb-exec-sub-btn--undo:hover { background: color-mix(in srgb, var(--color-primary) 14%, var(--bg-container)); }
.wb-exec-sub-btn--del {
  width: 20px;
  padding: 0;
  font-size: 13px;
  color: var(--text-tertiary);
}
.wb-exec-sub-btn--del:hover { color: var(--color-danger); border-color: var(--tint-danger-50); background: var(--tint-danger-06); }

.wb-exec-sub-item__title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.35;
}
.wb-exec-sub-item.is-selected .wb-exec-sub-item__title {
  color: var(--color-primary);
}
.wb-exec-sub-item.is-done .wb-exec-sub-item__title {
  text-decoration: line-through;
  text-decoration-color: var(--border-color);
  text-decoration-thickness: 1px;
}

/* 右列：详情面板（充满剩余宽度，内部滚动交给 JobLogDetails 的 wb-log-pre） */
.wb-exec-detail {
  min-width: 0;
  min-height: 0;
  /* 改 overflow-y: auto → hidden:让子级 wb-log-pre 拿到 max-height 约束,自身不抢滚动 */
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 4px 8px;
  background: transparent;
}
/* 详情面板头部：标题输入 + dirty 标记 */
.wb-exec-detail__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.wb-exec-detail__head .wb-input {
  flex: 1;
}

/* ── 任务拆分头部：标题 + 提示词下拉 + 按钮组 ────────────────── */
.wb-split__header {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-shrink: 0;
}

/* ── 任务类型 segmented control（顶部头部右侧） ────────────────
   设计参照 Claude Code Overview/Models tab：圆角 8px 灰底容器，
   内部两个等宽按钮，激活态用滑块 + 阴影强调，非激活态保持透明。 */
.wb-mode-switch {
  position: relative;
  display: inline-flex;
  align-items: stretch;
  height: 32px;
  padding: 3px;
  border-radius: 10px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-color);
  flex-shrink: 0;
  user-select: none;
  isolation: isolate;
}
.wb-mode-switch__btn {
  position: relative;
  z-index: 1;
  appearance: none;
  border: none;
  background: transparent;
  padding: 0 14px;
  min-width: 64px;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.1px;
  color: var(--text-tertiary);
  border-radius: 7px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: color 0.18s var(--ease-custom);
}
.wb-mode-switch__btn:hover:not(.is-active) {
  color: var(--text-secondary);
}
.wb-mode-switch__btn.is-active {
  color: var(--text-primary);
  font-weight: 600;
}
.wb-mode-switch__btn:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
/* 滑块：用 transform 在两按钮之间滑动，激活态显示白底+阴影+细描边 */
.wb-mode-switch__indicator {
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 3px;
  width: calc(50% - 3px);
  border-radius: 7px;
  background: var(--bg-container);
  border: 1px solid var(--border-color-medium);
  box-shadow:
    var(--shadow-sm),
    0 0 0 1px var(--tint-primary-06);
  transition: transform 0.22s var(--ease-custom, cubic-bezier(0.4, 0, 0.2, 1));
  z-index: 0;
  pointer-events: none;
}
.wb-mode-switch__indicator.is-right {
  transform: translateX(100%);
}
@media (prefers-reduced-motion: reduce) {
  .wb-mode-switch__indicator { transition: none; }
}

/* ── AI 拆分按钮（次要动作，accent 描边 + sparkle icon） ────────
   视觉权重略低于主「执行任务」按钮，但比 el-button info/plain 灰底明显。 */
.wb-ai-split-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--tint-primary-35, color-mix(in srgb, var(--color-primary) 35%, transparent));
  background: color-mix(in srgb, var(--color-primary) 5%, var(--bg-container));
  color: var(--color-primary);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.1px;
  border-radius: 10px;
  cursor: pointer;
  flex-shrink: 0;
  transition:
    background 0.15s var(--ease-custom, ease),
    border-color 0.15s var(--ease-custom, ease),
    color 0.15s var(--ease-custom, ease),
    transform 0.1s var(--ease-custom, ease);
}
.wb-ai-split-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-primary) 12%, var(--bg-container));
  border-color: var(--color-primary);
  color: var(--color-primary);
}
.wb-ai-split-btn:active:not(:disabled) { transform: scale(0.98); }
.wb-ai-split-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  background: transparent;
  border-color: var(--border-color);
  color: var(--text-tertiary);
}
.wb-ai-split-btn:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
.wb-ai-split-btn__icon {
  flex-shrink: 0;
  /* 给图标加一点 pulse 微动效，强化"这是一个 AI 动作"的视觉提示 */
  animation: wb-ai-sparkle-pulse 2.6s ease-in-out infinite;
  transform-origin: center;
}
@keyframes wb-ai-sparkle-pulse {
  0%, 100% { transform: scale(1);   opacity: 0.9; }
  50%      { transform: scale(1.12); opacity: 1; }
}
.wb-ai-split-btn:disabled .wb-ai-split-btn__icon { animation: none; opacity: 0.5; }
@media (prefers-reduced-motion: reduce) {
  .wb-ai-split-btn__icon { animation: none; }
}

/* 「执行日志」内联按钮：紧贴「执行任务」右侧，视觉重量接近 secondary */
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
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.wb-logs-inline-btn:hover {
  background: var(--tint-primary-12);
  color: var(--color-primary);
  border-color: var(--tint-primary-35);
}
.wb-logs-inline-btn:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}
.wb-logs-inline-btn__icon { font-size: 14px; }

/* 「执行日志」弹窗的 max-height / body 滚动限制已放在文件末尾的非 scoped <style> 块里，
   这里不再重复。原因：el-dialog 用 teleport 渲染到 body 下，scoped 选择器（包括 :deep()）
   都拿不到它的根 div，强行写只会变成 dead rule。 */

/* ── 表单控件统一系统（input / select / textarea 共用基底） ── */
/*    设计目标：与按钮视觉重量齐平、可识别焦点、hover 反馈明确。
      颜色走 --border-color-medium 提升基础边框可见度，hover 阶段加深，
      focus 阶段同时改色 + 套 3px primary-tinted ring。 */
.wb-input,
.wb-select,
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
  font-size: var(--font-size-135);
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
  font-size: 14px;
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

/* ── 下拉选择 ─────────────────────────────────────── */
.wb-select {
  height: 36px;
  padding: 0 32px 0 12px;
  font-size: 13px;
  font-weight: 500;
  min-width: 168px;
  cursor: pointer;
  /* 自绘 chevron，避免浏览器默认箭头视觉噪音 */
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><path d='M3 4.5l3 3 3-3' fill='none' stroke='%236b7280' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 10px center;
  background-size: 12px 12px;
  flex-shrink: 0;
}
.wb-select:hover:not(:focus) {
  border-color: var(--border-input-hover, #cbd5e1);
  background-color: var(--bg-container-hover);
}
.wb-select:focus {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--tint-primary-18);
}
/* 标记「不绑定」之类的占位符选项——当值为 null 时 option label 会更浅，
   但 select 自身无法读到 selectedIndex 状态，用一个轻量颜色 hack：
   没有明显需求的情况下保持现状即可 */

/* ── 多行输入 ─────────────────────────────────────── */
.wb-textarea {
  display: block;
  padding: 10px 14px;
  font-size: 13px;
  line-height: 1.55;
  letter-spacing: -0.05px;
  resize: vertical;
  width: 100%;
  box-sizing: border-box;
  flex-shrink: 0;
  min-height: 52px;
  /* 极简化：去掉 box-shadow inset，默认透明背景（focus 时再铺底） */
  background: transparent;
  box-shadow: none;
  border-color: var(--border-color);
}
.wb-textarea::placeholder {
  line-height: 1.55;
  color: var(--text-placeholder);
}
.wb-textarea:hover:not(:focus) {
  border-color: var(--border-color-medium);
  background: var(--bg-container);
}
.wb-textarea:focus {
  border-color: var(--color-primary);
  background: var(--bg-container);
  box-shadow: 0 0 0 3px var(--tint-primary-14);
}
.wb-textarea--sm { min-height: 44px; padding: 8px 12px; font-size: 13px; }

.wb-split__sub-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
  flex-shrink: 0;
}
.wb-split__sub-header h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}
.wb-split__sub-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

/* ── 简单任务编辑区 ─────────────────────────── */
.wb-simple__header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-top: 8px;
  padding-left: 8px;
  border-left: 2px solid var(--color-primary);
  flex-shrink: 0;
}
.wb-simple__header h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.05px;
}
.wb-simple__hint {
  font-size: var(--font-size-115);
  color: var(--text-tertiary);
}

/* ── 简单任务完成态 pill ── */
/* 圆点版：只用状态点+颜色表达状态,无文字。running 时由外层 wb-exec-sub-item
   的边框跑马灯承担动效,pill 本身只做圆点呼吸。 */
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
.wb-simple__status-dot {
  display: none; /* 圆点 pill 内不再嵌套小圆点 */
}
/* running: pill 圆点呼吸(白光环) */
.wb-exec-sub-item.is-running .wb-simple__status {
  animation: wb-status-dot-pulse 1.4s ease-in-out infinite;
  box-shadow: 0 0 6px rgba(255, 255, 255, 0.7);
}
.wb-simple__status-text {
  display: none;
}
.wb-simple__meta {
  font-size: var(--font-size-115);
  color: var(--text-tertiary);
  letter-spacing: -0.05px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.wb-simple__meta--error {
  color: var(--color-danger);
}
/* idle 灰底：背景由 inline style 注入，无文字无需特殊处理 */
.wb-simple__status[style*="--text-tertiary"] .wb-simple__status-dot {
  background: var(--text-tertiary);
}

/* ── 简单任务「停止」按钮(running 时详情区状态条末尾) ── */
.wb-simple__stop {
  margin-left: auto;
  padding: 2px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-danger-bright);
  background: transparent;
  color: var(--color-danger-bright);
  font-size: var(--font-size-115);
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
  opacity: 0.45;
  cursor: not-allowed;
}

/* ── 简单任务「覆盖预置提示词」可折叠 ── */
.wb-simple__override {
  border-radius: var(--radius-md);
}
.wb-simple__override > .wb-textarea {
  margin-top: 8px;
}
.wb-simple__override-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
  list-style: none;
  padding: 4px 0;
}
.wb-simple__override-summary::-webkit-details-marker { display: none; }
.wb-simple__override-caret {
  font-size: 12px;
  color: var(--text-tertiary);
  transition: transform var(--transition-fast) var(--ease-custom);
}
.wb-simple__override[open] > .wb-simple__override-summary .wb-simple__override-caret {
  transform: rotate(90deg);
  color: var(--color-primary);
}
.wb-simple__override.has-content > .wb-simple__override-summary {
  color: var(--text-primary);
}
.wb-simple__override-tag {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--tint-primary-12, color-mix(in srgb, var(--color-primary) 12%, transparent));
  color: var(--color-primary);
  letter-spacing: 0.2px;
}

.wb-form-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}
.wb-form-item__label {
  font-size: 12px;
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
.wb-sub-item {
  position: relative;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 10px;
  transition: border-color 0.15s, box-shadow 0.15s;
  /* 单卡允许内部纵向滚动：执行中子任务展开日志/思考/附件后可能非常高，
     让卡片自身在超出可视区时出现滚动条，避免把列表下方卡片挤出屏幕。
     border-radius 配合 overflow:hidden 保持圆角裁切效果。 */
  max-height: min(70vh, 720px);
  overflow: auto;
}
.wb-sub-item.is-dirty {
  border-color: var(--tint-warning-45);
  background: var(--tint-warning-04);
}

/* ── 执行中：卡片整体光环 + 顶部流动光带 ────────────────── */
.wb-sub-item.is-running {
  border-color: var(--tint-primary-55);
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--color-primary) 6%, var(--bg-surface)) 0%,
      var(--bg-surface) 60%
    );
  box-shadow:
    0 0 0 1px var(--tint-primary-30),
    0 4px 18px -4px color-mix(in srgb, var(--color-primary) 25%, transparent);
  animation: wb-card-glow 2.4s ease-in-out infinite;
}
.wb-sub-item.is-running::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: linear-gradient(
    90deg,
    transparent 0%,
    var(--color-primary) 50%,
    transparent 100%
  );
  background-size: 50% 100%;
  background-repeat: no-repeat;
  animation: wb-progress-slide 1.6s ease-in-out infinite;
  pointer-events: none;
  z-index: 1;
}
.wb-sub-item.is-running::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(
    90deg,
    transparent 0%,
    var(--tint-primary-10) 50%,
    transparent 100%
  );
  background-size: 200% 100%;
  animation: wb-card-sweep 3.2s linear infinite;
  pointer-events: none;
  opacity: 0.5;
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
  .wb-sub-item.is-running,
  .wb-sub-item.is-running::before,
  .wb-sub-item.is-running::after {
    animation: none;
  }
}
.wb-sub-item__dirty {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  font-weight: 600;
  color: var(--color-warning-dark, #b45309);
  background: var(--tint-warning-14);
  padding: 2px 7px;
  border-radius: 8px;
  flex-shrink: 0;
  letter-spacing: 0.2px;
}
.wb-sub-item__dirty::before {
  content: '';
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-warning);
}
.wb-dirty-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  margin-left: 6px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  color: #fff;
  background: var(--color-danger);
  border-radius: 8px;
  vertical-align: middle;
}
.wb-sub-item__row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 6px;
  /* 整行可点击展开/收起：除操作按钮外任意位置都触发切换 */
  cursor: pointer;
  user-select: none;
  /* 悬停态平滑过渡；与现有 wb-card 背景变化保持一致节奏 */
  padding: 4px 6px;
  margin-left: -6px;
  margin-right: -6px;
  border-radius: var(--radius-sm, 4px);
  transition:
    background var(--transition-fast) var(--ease-custom),
    box-shadow var(--transition-fast) var(--ease-custom);
}
.wb-sub-item__row:hover {
  background: var(--bg-container-hover);
  box-shadow: inset 0 0 0 1px var(--tint-primary-12, transparent);
}
/* 操作按钮 hover 不应再次加深背景，避免双重叠加 */
.wb-sub-item__row:hover .wb-sub-item__toggle,
.wb-sub-item__row:hover .wb-sub-item__undo,
.wb-sub-item__row:hover .wb-sub-item__del,
.wb-sub-item__row:hover .wb-sub-item__run,
.wb-sub-item__row:hover .wb-sub-item__stop {
  /* 让按钮自带 hover 样式生效，不被行底色压住 */
  position: relative;
  z-index: 1;
}
.wb-sub-item__row:focus-visible {
  outline: var(--focus-outline);
  outline-offset: var(--focus-outline-offset);
  border-radius: var(--radius-sm, 4px);
}

/* ── 折叠态：紧凑单行 ─────────────────────────────────────── */
.wb-sub-item__row--compact {
  margin-bottom: 0;
  cursor: pointer;
  gap: 6px;
}
.wb-sub-item__title-compact {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  letter-spacing: -0.05px;
  line-height: 1.3;
  /* 已完成的标题：略灰，区别于进行中 */
  text-decoration: line-through;
  text-decoration-color: var(--border-color);
  text-decoration-thickness: 1px;
}
.wb-sub-item__toggle {
  border: 1px solid var(--border-color-medium);
  background: var(--bg-container);
  color: var(--text-tertiary);
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm, 4px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 12px;
  flex-shrink: 0;
  transition: background var(--transition-fast) var(--ease-custom),
              border-color var(--transition-fast) var(--ease-custom),
              color var(--transition-fast) var(--ease-custom);
}
/* 箭头旋转过渡：折叠/展开切换时平滑旋转，而非瞬时跳变 */
.wb-sub-item__toggle .el-icon {
  display: inline-flex;
  transition: transform var(--transition-base, 200ms) var(--ease-custom);
}
.wb-sub-item__toggle:hover .el-icon {
  transform: scale(1.12);
}
.wb-sub-item__toggle:hover {
  background: var(--bg-container-hover);
  border-color: var(--color-primary);
  color: var(--color-primary);
}
.wb-sub-item__toggle:focus-visible {
  outline: var(--focus-outline);
  outline-offset: var(--focus-outline-offset);
}
.wb-sub-item__undo {
  border: 1px solid var(--tint-primary-35);
  background: color-mix(in srgb, var(--color-primary) 6%, var(--bg-container));
  color: var(--color-primary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1px;
  padding: 0 10px;
  height: 28px;
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  flex-shrink: 0;
  transition: background var(--transition-fast) var(--ease-custom),
              border-color var(--transition-fast) var(--ease-custom),
              color var(--transition-fast) var(--ease-custom);
}
.wb-sub-item__undo:hover {
  background: color-mix(in srgb, var(--color-primary) 14%, var(--bg-container));
  border-color: var(--color-primary);
  color: var(--color-primary-dark, var(--color-primary));
}
.wb-sub-item__undo:focus-visible {
  outline: var(--focus-outline);
  outline-offset: var(--focus-outline-offset);
}
.wb-sub-item__toggle:disabled,
.wb-sub-item__undo:disabled,
.wb-sub-item__del:disabled,
.wb-sub-item__run:disabled,
.wb-sub-item__stop:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  pointer-events: none;
}

/* ── 已完成态：绿色微底 + 圆角柔化（与执行中红色脉冲对比） ─────────── */
.wb-sub-item.is-done:not(.is-running) {
  border-color: var(--tint-success-30);
  background: var(--tint-success-04);
}
.wb-sub-item.is-done.is-collapsed {
  padding: 8px 10px;
}
/* ── 状态点 pill（无文字,只用圆点+边框传递状态）
   running 时不动 pill 本身,而是把动效挪到 wb-exec-sub-item 的边框上 —— 见下方 ── */
.wb-sub-item__status {
  position: relative;
  font-size: 11px;
  color: #fff;
  padding: 0;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-weight: 600;
  letter-spacing: 0.2px;
  overflow: hidden;
  width: 8px;
  height: 8px;
}
.wb-sub-item__status--dot {
  border-radius: 50%;
}

/* idle 状态：inline 注入的背景是 --bg-subtle（灰底），不能用白字
   —— 通过 style 属性匹配把文字色降为中性色，保持可读。 */
.wb-sub-item__status[style*="--bg-subtle"] {
  color: var(--text-secondary);
}
.wb-sub-item__status[style*="--bg-subtle"] .wb-simple__status-dot {
  background: var(--text-tertiary);
}

/* ── 执行中：边框跑马灯 + 状态点呼吸
   pill 内部 ::before/::after 已禁用(让 pill 退化为纯圆点),
   动效全部交给外层 .wb-exec-sub-item 的边框 + 外发光。 ─────────── */
.wb-sub-item.is-running .wb-sub-item__status,
.wb-exec-sub-item.is-running .wb-sub-item__status {
  animation: wb-status-dot-pulse 1.4s ease-in-out infinite;
  box-shadow: 0 0 6px rgba(255, 255, 255, 0.6);
}
.wb-sub-item.is-running .wb-sub-item__status::before,
.wb-sub-item.is-running .wb-sub-item__status::after,
.wb-exec-sub-item.is-running .wb-sub-item__status::before,
.wb-exec-sub-item.is-running .wb-sub-item__status::after {
  content: none;
}

/* 复杂任务子任务 running：边框跑马灯 + 整行外发光 */
.wb-sub-item.is-running {
  position: relative;
  border-color: var(--color-primary);
  background:
    linear-gradient(
      90deg,
      transparent 0%,
      var(--tint-primary-18) 50%,
      transparent 100%
    ) var(--tint-primary-04);
  background-size: 200% 100%;
  animation: wb-border-shimmer 2.4s linear infinite;
  box-shadow: 0 0 0 1px var(--tint-primary-45),
              0 0 12px var(--tint-primary-25);
}

/* 简单任务 running（外层用 wb-exec-sub-item 包） */
.wb-exec-sub-item.is-running {
  position: relative;
  border-color: var(--color-primary);
  background:
    linear-gradient(
      90deg,
      transparent 0%,
      var(--tint-primary-18) 50%,
      transparent 100%
    ) var(--tint-primary-04);
  background-size: 200% 100%;
  animation: wb-border-shimmer 2.4s linear infinite;
  box-shadow: 0 0 0 1px var(--tint-primary-45),
              0 0 12px var(--tint-primary-25);
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
  .wb-sub-item.is-running,
  .wb-exec-sub-item.is-running,
  .wb-sub-item.is-running .wb-sub-item__status,
  .wb-exec-sub-item.is-running .wb-sub-item__status,
  .wb-sub-item.is-running .wb-sub-item__status::before,
  .wb-sub-item.is-running .wb-sub-item__status::after,
  .wb-exec-sub-item.is-running .wb-sub-item__status::before,
  .wb-exec-sub-item.is-running .wb-sub-item__status::after,
  .wb-exec-sub-item.is-running .wb-simple__status-dot {
    animation: none;
  }
  .wb-sub-item__toggle .el-icon,
  .wb-sub-item__row {
    transition: none;
  }
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
    grid-template-rows var(--transition-base, 220ms) var(--ease-custom),
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
.wb-sub-item__pid {
  font-size: 11px;
  color: var(--text-tertiary);
  font-family: ui-monospace, monospace;
  flex-shrink: 0;
}
.wb-sub-item__stop {
  border: 1px solid var(--tint-danger-50);
  background: var(--tint-danger-08);
  color: var(--color-danger-bright, #ef4444);
  font-size: 11px;
  font-weight: 600;
  padding: 2px 10px;
  height: 28px;
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s, color 0.15s;
}
.wb-sub-item__stop:hover {
  background: var(--color-danger);
  color: #fff;
  border-color: var(--color-danger);
}
.wb-sub-item__run {
  border: 1px solid var(--color-primary);
  background: var(--color-primary);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 10px;
  height: 28px;
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  flex-shrink: 0;
  transition: opacity 0.15s, filter 0.15s;
}
.wb-sub-item__run:hover {
  opacity: 0.88;
  filter: brightness(1.05);
}
.wb-sub-item__row .wb-input { flex: 1; }

/* 日志面板样式已抽到 components/JobLogDetails.vue（self-contained scoped） */

/* ── 子任务附件（wb-attachments 系列已抽到 styles/workbench.scss 全局样式） ──
   按钮的视觉风格由 .wb-soft-btn 提供，子组件 AttachmentZone 在模板中合并使用
   `class="wb-attachments__add wb-soft-btn"`。本作用域内不再重复定义。 */

/* 当前项目名已通过 .wb-task-group__head.is-current 在分组头中突出展示，
   侧栏顶部不再重复渲染"当前项目"条以避免信息冗余。 */

/* ── 任务分组头（多项目时按项目分组显示） ───────────────────────── */
.wb-task-group__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 6px 4px;
  margin-top: 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  letter-spacing: 0.3px;
  text-transform: uppercase;
  cursor: pointer;
  user-select: none;
  border-radius: var(--radius-sm);
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
  font-size: 11px;
  flex-shrink: 0;
  opacity: 0.75;
  transition: transform var(--transition-fast) var(--ease-custom);
}
.wb-task-group__icon { font-size: 12px; flex-shrink: 0; opacity: 0.8; }
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

/* ── 任务级字段自动保存指示器（title / desc / promptId） ─────────── */
.wb-meta-save {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 10px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1px;
  border-radius: 12px;
  border: 1px solid var(--border-color-medium);
  background: var(--bg-container);
  color: var(--text-tertiary);
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
.wb-meta-save__check { font-size: 12px; line-height: 1; }
.wb-meta-save__bang {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  font-size: 9px;
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
  color: var(--color-success-dark, #047857);
  border-color: var(--tint-success-35);
  background: var(--tint-success-08);
}
.wb-meta-save.is-dirty {
  color: var(--color-warning-dark, #b45309);
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

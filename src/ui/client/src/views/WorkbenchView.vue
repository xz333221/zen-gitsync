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
  ArrowUp,
  ArrowRight
} from '@element-plus/icons-vue'
import AISplitDialog from '@components/AISplitDialog.vue'
import AttachmentZone from '@components/AttachmentZone.vue'
import JobLogDetails from '@components/JobLogDetails.vue'
import ExecutionLogManager from '@components/ExecutionLogManager.vue'
import { useWorkbenchStatusStore } from '@stores/workbenchStatus'
import { statusLabel, statusColor } from '@/utils/jobStatus'
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
// 顶部 tab 切换：'editor' = 现有任务执行视图，'logs' = 执行日志管理
const activeView = ref<'editor' | 'logs'>('editor')

const selectedTaskId = ref<string | null>(null)
const selectedTask = computed<Task | null>(() => tasks.value.find(t => t.id === selectedTaskId.value) || null)
// 兼容历史数据:缺 type 字段一律按 complex 处理
const isSimpleTask = computed(() => selectedTask.value?.type === 'simple')

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
let metaFlushTimer: number | null = null

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
  if (metaFlushTimer !== null) { clearTimeout(metaFlushTimer); metaFlushTimer = null }
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
// 避免「改了 desc 立刻点别的任务 → desc 丢失」
watch(selectedTaskId, async (_n, _o) => {
  clearMetaSaveTimers()
  // 新 task 选中时 captureSnapshot() 会在 selectTask() 内同步调用；
  // 但要先把上一个 task 的未保存内容落盘
  // （loadTasks 之后 diskSnapshot 也会重新拍，避免下次切回时误标 dirty）
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

function attachmentCount(t: Task): number {
  return Array.isArray(t.attachments) ? t.attachments.length : 0
}
function subtaskCount(t: Task): number {
  return Array.isArray(t.subtasks) ? t.subtasks.length : 0
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
  taskDialog.type = 'complex'
  taskDialog.simpleOverride = ''
  taskDialog.visible = true
}
async function saveTask() {
  if (!taskDialog.title.trim()) {
    ElMessage.warning($t('@WORKBENCH:标题必填'))
    return
  }
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

// ── 子任务编辑（拆分） ─────────────────────────────────────────────────────
function addSubtask() {
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
  // 失败也不影响 UI：用户可以再点「保存拆分」补救。
  persistTask(false)
}
function removeSubtask(sub: SubTask) {
  if (!selectedTask.value) return
  selectedTask.value.subtasks = selectedTask.value.subtasks.filter(s => s.id !== sub.id)
  persistTask(false)
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

// ── 已完成子任务折叠 ─────────────────────────────────────────────────────
// 已完成的 sub 默认折叠成单行（只显示徽标 + 标题 + 展开 + 取消完成），
// 长任务下让用户聚焦于未完成项。点"展开"手动打开看 desc/附件/历史日志。
const expandedSubIds = ref<Set<string>>(new Set())
function isSubCollapsed(sub: SubTask): boolean {
  if (sub.status !== 'done') return false
  return !expandedSubIds.value.has(sub.id)
}
function toggleSubExpand(sub: SubTask) {
  if (expandedSubIds.value.has(sub.id)) expandedSubIds.value.delete(sub.id)
  else expandedSubIds.value.add(sub.id)
  // 触发响应式更新（Set 本身不响应）
  expandedSubIds.value = new Set(expandedSubIds.value)
}
async function cancelDone(sub: SubTask) {
  if (!selectedTask.value) return
  // 把磁盘快照里这条 sub 的 status 一起改回 todo，避免 dirty 误标
  const snap = subSnapshot.value.get(sub.id)
  if (snap) {
    subSnapshot.value.set(sub.id, { ...snap, status: 'todo' } as any)
  }
  sub.status = 'todo'
  // 静默落盘：让后端 runTaskQueue 在下次执行时把这 sub 重新纳入队列
  await persistTask(false)
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
    <!-- 顶部 tab 切换：editor = 任务执行（默认），logs = 执行日志管理 -->
    <header class="wb-tabs">
      <button
        type="button"
        class="wb-tab"
        :class="{ 'is-active': activeView === 'editor' }"
        @click="activeView = 'editor'"
      >
        {{ $t('@WORKBENCH:任务执行') }}
      </button>
      <button
        type="button"
        class="wb-tab"
        :class="{ 'is-active': activeView === 'logs' }"
        @click="activeView = 'logs'"
      >
        {{ $t('@WORKBENCH:执行日志') }}
      </button>
    </header>

    <template v-if="activeView === 'editor'">
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

        <div v-if="tasks.length > 0 && currentProject.name" class="wb-current-project">
          <el-icon class="wb-current-project__icon"><Folder /></el-icon>
          <span class="wb-current-project__label">{{ $t('@WORKBENCH:当前项目') }}</span>
          <span class="wb-current-project__name" :title="currentProject.path">{{ currentProject.name }}</span>
        </div>

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
                  'is-other-project': t.projectPath && t.projectPath !== currentProject.path
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
                    <span class="wb-task-item__meta-item" :title="$t('@WORKBENCH:个子任务')">
                      <el-icon class="wb-task-item__meta-icon"><List /></el-icon>
                      <span class="wb-pill wb-task-item__num">{{ subtaskCount(t) }}</span>
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
                    <span
                      v-if="t.type === 'simple'"
                      class="wb-task-item__meta-item wb-task-item__meta-item--simple"
                      :title="$t('@WORKBENCH:简单任务 - 无需拆分直接执行')"
                    >
                      {{ $t('@WORKBENCH:简单') }}
                    </span>
                    <span
                      v-if="t.projectPath && t.projectPath !== currentProject.path"
                      class="wb-task-item__meta-item wb-task-item__meta-item--project"
                      :title="t.projectPath"
                    >
                      {{ shortProjectLabel(t.projectPath) }}
                    </span>
                  </div>
                </div>
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
          <li v-if="tasks.length === 0" class="wb-empty">
            <div class="wb-empty__icon">
              <el-icon><DocumentAdd /></el-icon>
            </div>
            <div class="wb-empty__text">{{ $t('@WORKBENCH:暂无任务') }}</div>
            <div class="wb-empty__hint">{{ $t('@WORKBENCH:点击上方按钮新建') }}</div>
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
          <el-button
            v-if="!isSimpleTask"
            type="info"
            plain
            :disabled="!selectedTask.title || !selectedTask.title.trim()"
            @click="openAiSplitDialog"
          >
            {{ $t('@WORKBENCH:AI 拆分') }}
          </el-button>
          <el-button type="primary" :loading="false" @click="runTask(selectedTask)">
            {{ isSimpleTask ? $t('@WORKBENCH:执行') : $t('@WORKBENCH:执行任务') }}
          </el-button>
        </div>
        <textarea
          class="wb-textarea"
          v-model="selectedTask.desc"
          :placeholder="$t('@WORKBENCH:任务描述（可选）')"
          rows="3"
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
        <!-- ── 复杂任务：子任务拆分 + 列表 ── -->
        <template v-if="!isSimpleTask">
        <div class="wb-split__sub-header">
          <h4>{{ $t('@WORKBENCH:子任务拆分') }}</h4>
          <div class="wb-split__sub-actions">
            <el-button
              size="small"
              plain
              :icon="Plus"
              :disabled="selectedTask.subtasks.length === 0"
              @click="addSubtask"
            >
              {{ $t('@WORKBENCH:添加子任务') }}
            </el-button>
            <el-button
              size="small"
              :type="hasDirtySubtasks ? 'primary' : 'default'"
              :disabled="selectedTask.subtasks.length === 0"
              @click="saveSubtasks"
            >
              {{ $t('@WORKBENCH:保存拆分') }}
              <span v-if="hasDirtySubtasks" class="wb-dirty-badge">{{ dirtySubIds.size }}</span>
            </el-button>
          </div>
        </div>
        <ul class="wb-sub-list">
          <li
            v-for="sub in selectedTask.subtasks"
            :key="sub.id"
            class="wb-sub-item"
            :class="{
              'is-dirty': dirtySubIds.has(sub.id),
              'is-running': sub.status === 'running',
              'is-done': sub.status === 'done',
              'is-collapsed': isSubCollapsed(sub),
              'is-clickable': isSubCollapsed(sub)
            }"
            @click="isSubCollapsed(sub) && toggleSubExpand(sub)"
          >
            <!-- 折叠态：只显示徽标 + 标题 + 展开 + 取消完成 + 删除 -->
            <template v-if="isSubCollapsed(sub)">
              <div class="wb-sub-item__row wb-sub-item__row--compact">
                <span class="wb-sub-item__status" :style="{ background: statusColor(sub.status) }">
                  {{ statusLabel(sub.status) }}
                </span>
                <span class="wb-sub-item__title-compact" :title="sub.title">
                  {{ sub.title || $t('@WORKBENCH:未命名子任务') }}
                </span>
                <span
                  v-if="jobOf(sub.id)"
                  class="wb-sub-item__pid"
                  :title="$t('@WORKBENCH:进程ID')"
                >
                  PID: {{ jobOf(sub.id)?.pid }}
                </span>
                <button
                  v-if="canRunSubtask(sub)"
                  class="wb-sub-item__run"
                  :title="$t('@WORKBENCH:单独执行此子任务')"
                  :aria-label="$t('@WORKBENCH:单独执行此子任务')"
                  @click.stop="runSubtask(sub)"
                >
                  {{ $t('@WORKBENCH:执行') }}
                </button>
                <button
                  class="wb-sub-item__toggle"
                  :title="$t('@WORKBENCH:展开')"
                  :aria-label="$t('@WORKBENCH:展开')"
                  @click.stop="toggleSubExpand(sub)"
                >
                  <el-icon><ArrowDown /></el-icon>
                </button>
                <button
                  class="wb-sub-item__undo"
                  :title="$t('@WORKBENCH:取消完成')"
                  :aria-label="$t('@WORKBENCH:取消完成')"
                  @click.stop="cancelDone(sub)"
                >
                  {{ $t('@WORKBENCH:取消完成') }}
                </button>
                <button
                  class="wb-sub-item__del"
                  :title="$t('@WORKBENCH:删除')"
                  :aria-label="$t('@WORKBENCH:删除')"
                  @click.stop="removeSubtask(sub)"
                >×</button>
              </div>
            </template>
            <!-- 展开态：完整表单 -->
            <template v-else>
            <div class="wb-sub-item__row">
              <span class="wb-sub-item__status" :style="{ background: statusColor(sub.status) }">
                {{ statusLabel(sub.status) }}
              </span>
              <input class="wb-input" v-model="sub.title" :placeholder="$t('@WORKBENCH:子任务标题')" @paste="onAttachmentPaste($event, { kind: 'sub', task: selectedTask, sub })" />
              <span v-if="dirtySubIds.has(sub.id)" class="wb-sub-item__dirty" :title="$t('@WORKBENCH:有未保存的更改')">
                {{ $t('@WORKBENCH:未保存') }}
              </span>
              <span v-if="jobOf(sub.id)" class="wb-sub-item__pid" :title="$t('@WORKBENCH:进程ID')">
                PID: {{ jobOf(sub.id)?.pid }}
              </span>
              <button
                v-if="canRunSubtask(sub)"
                class="wb-sub-item__run"
                :title="$t('@WORKBENCH:单独执行此子任务')"
                :aria-label="$t('@WORKBENCH:单独执行此子任务')"
                @click="runSubtask(sub)"
              >{{ $t('@WORKBENCH:执行') }}</button>
              <button
                v-if="jobOf(sub.id) && (jobOf(sub.id)?.status === 'running' || jobOf(sub.id)?.status === 'pending')"
                class="wb-sub-item__stop"
                :title="$t('@WORKBENCH:停止执行')"
                @click="cancelJob(jobOf(sub.id)!)"
              >{{ $t('@WORKBENCH:停止') }}</button>
              <button
                v-if="sub.status === 'done'"
                class="wb-sub-item__toggle"
                :title="$t('@WORKBENCH:收起')"
                :aria-label="$t('@WORKBENCH:收起')"
                @click="toggleSubExpand(sub)"
              >
                <el-icon><ArrowUp /></el-icon>
              </button>
              <button
                v-if="sub.status === 'done'"
                class="wb-sub-item__undo"
                :title="$t('@WORKBENCH:取消完成')"
                :aria-label="$t('@WORKBENCH:取消完成')"
                @click="cancelDone(sub)"
              >{{ $t('@WORKBENCH:取消完成') }}</button>
              <button class="wb-sub-item__del" @click="removeSubtask(sub)">×</button>
            </div>
            <textarea
              class="wb-textarea wb-textarea--sm"
              v-model="sub.desc"
              :placeholder="$t('@WORKBENCH:子任务描述 / 独立提示词覆盖')"
              rows="2"
              @paste="onAttachmentPaste($event, { kind: 'sub', task: selectedTask, sub })"
            />
            <JobLogDetails
              v-if="jobOf(sub.id)"
              :job="jobOf(sub.id)!"
            />
            <AttachmentZone
              :attachments="sub.attachments || []"
              :is-image="isImageAttachment"
              :human-size="humanSize"
              :is-uploading="isUploading('sub-' + sub.id)"
              :is-paste-hover="pasteHoverId === sub.id"
              :max-count="9"
              :on-pick="() => pickAttachmentFile({ kind: 'sub', task: selectedTask, sub })"
              :on-remove="(att) => removeAttachment({ kind: 'sub', task: selectedTask, sub }, att)"
              @paste="onAttachmentPaste($event, { kind: 'sub', task: selectedTask, sub })"
              @drop.prevent="onAttachmentDrop($event, { kind: 'sub', task: selectedTask, sub })"
              @dragover.prevent="pasteHoverId = sub.id"
              @dragenter.prevent="pasteHoverId = sub.id"
              @dragleave="pasteHoverId = (pasteHoverId === sub.id ? null : pasteHoverId)"
            />
            </template>
          </li>
          <li v-if="selectedTask.subtasks.length === 0" class="wb-empty wb-empty--rich">
            <div class="wb-empty__art" aria-hidden="true">
              <el-icon><List /></el-icon>
            </div>
            <div class="wb-empty__title">{{ $t('@WORKBENCH:拆分任务，逐项执行') }}</div>
            <div class="wb-empty__hint">
              {{ $t('@WORKBENCH:手动添加子任务，或让 AI 帮你自动拆分') }}
            </div>
            <div class="wb-empty__cta">
              <el-button type="primary" size="small" :icon="Plus" @click="addSubtask">
                {{ $t('@WORKBENCH:添加子任务') }}
              </el-button>
              <button
                type="button"
                class="wb-empty__link"
                :disabled="!selectedTask.title || !selectedTask.title.trim()"
                @click="openAiSplitDialog"
              >
                {{ $t('@WORKBENCH:用 AI 自动拆分') }}
              </button>
            </div>
          </li>
        </ul>
        </template>

        <!-- ── 简单任务：覆盖预置提示词 + 附件(执行时塞 prompt) ── -->
        <template v-else>
          <div class="wb-simple__header">
            <h4>{{ $t('@WORKBENCH:简单任务') }}</h4>
            <span class="wb-simple__hint">{{ $t('@WORKBENCH:无需拆分子任务;点执行后直接用上方描述驱动 Claude') }}</span>
          </div>
          <div class="wb-form-item">
            <label class="wb-form-item__label">{{ $t('@WORKBENCH:覆盖预置提示词（可选）') }}</label>
            <textarea
              class="wb-textarea"
              v-model="selectedTask.simpleOverride"
              :placeholder="$t('@WORKBENCH:留空则使用上方选定的「预置提示词」模板;可用变量同子任务:｛｛task.title｝｝ ｛｛task.desc｝｝ ｛｛repo.path｝｝ ｛｛branch｝｝')"
              rows="6"
            />
          </div>
          <!-- 简单任务的执行日志：用 task 的虚拟 sub id 查 job -->
          <JobLogDetails
            v-if="jobOf(`${selectedTask.id}__simple`)"
            :job="jobOf(`${selectedTask.id}__simple`)!"
          />
        </template>
      </template>
    </section>
    </div>
    </template>
    <!-- v-else 视图：执行日志管理。tab 切换到 logs 时挂载，editor 视图 v-show 保活避免 SSE 重连 -->
    <ExecutionLogManager v-else />

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
        <el-form-item :label="$t('@WORKBENCH:标题')">
          <el-input v-model="taskDialog.title" />
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

/* 顶部 tab 切换条：editor / logs 两栏；用下划线标记激活 */
.wb-tabs {
  display: flex;
  align-items: stretch;
  gap: 4px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-subtle, var(--bg-container));
  flex-shrink: 0;
  min-height: 40px;
}
.wb-tab {
  appearance: none;
  background: transparent;
  border: none;
  padding: 0 16px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-tertiary);
  cursor: pointer;
  position: relative;
  transition: color 0.15s;
  user-select: none;
}
.wb-tab:hover {
  color: var(--text-primary);
}
.wb-tab.is-active {
  color: var(--color-primary);
  font-weight: 600;
}
.wb-tab.is-active::after {
  content: '';
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: -1px;
  height: 2px;
  background: var(--color-primary);
  border-radius: var(--radius-2xs);
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
  border-right: 1px solid var(--border-color);
  padding: 14px 12px 18px;
  overflow-y: auto;
  background: var(--bg-container);
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
  border-top: 1px dashed var(--border-color);
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
  width: 22px;
  height: 22px;
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
  gap: 8px;
  width: 100%;
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--tint-primary-30);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-primary) 8%, var(--bg-container));
  color: var(--color-primary);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.1px;
  cursor: pointer;
  transition: background var(--transition-fast) var(--ease-custom),
              border-color var(--transition-fast) var(--ease-custom),
              box-shadow var(--transition-fast) var(--ease-custom),
              transform var(--transition-fast) var(--ease-custom);
}
.wb-new-btn__icon {
  font-size: 14px;
  flex-shrink: 0;
  transition: transform var(--transition-fast) var(--ease-custom);
}
.wb-new-btn__shortcut {
  margin-left: auto;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: var(--text-tertiary);
  background: var(--bg-subtle);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-xs);
  padding: 1px 5px;
  font-family: var(--font-mono);
  opacity: 0;
  transition: opacity var(--transition-fast) var(--ease-custom);
}
.wb-new-btn:hover {
  background: color-mix(in srgb, var(--color-primary) 14%, var(--bg-container));
  border-color: var(--tint-primary-50);
  box-shadow: var(--wb-card-shadow-hover),
              0 0 0 3px var(--tint-primary-10);
}
.wb-new-btn:hover .wb-new-btn__icon {
  transform: rotate(90deg);
}
.wb-new-btn:hover .wb-new-btn__shortcut {
  opacity: 1;
}
.wb-new-btn:active {
  transform: scale(0.99);
}
.wb-new-btn:focus-visible {
  outline: var(--focus-outline);
  outline-offset: var(--focus-outline-offset-lg);
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
  gap: 10px;
  padding: 9px 10px 9px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--bg-container);
  cursor: pointer;
  transition: background var(--transition-fast) var(--ease-custom),
              border-color var(--transition-fast) var(--ease-custom),
              box-shadow var(--transition-fast) var(--ease-custom),
              transform var(--transition-fast) var(--ease-custom);
}
.wb-task-item:hover {
  background: var(--bg-container-hover);
  border-color: var(--border-color-medium);
  box-shadow: var(--wb-card-shadow-hover);
}
.wb-task-item:hover .wb-task-item__del {
  opacity: 1;
  transform: translateX(0);
}
.wb-task-item.active {
  background: color-mix(in srgb, var(--color-primary) 9%, var(--bg-container));
  border-color: var(--tint-primary-45);
  box-shadow: var(--wb-card-shadow-hover);
}
.wb-task-item.active .wb-task-item__title { color: var(--color-primary); }
.wb-task-item.active .wb-task-item__del { opacity: 1; color: var(--color-primary); }

/* 左侧头像：根据任务类型变色 */
.wb-task-item__avatar {
  width: 30px;
  height: 30px;
  border-radius: var(--radius-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--font-size-15);
  flex-shrink: 0;
  background: var(--bg-subtle);
  color: var(--text-tertiary);
  border: 1px solid var(--border-color);
  transition: background var(--transition-fast) var(--ease-custom),
              color var(--transition-fast) var(--ease-custom),
              border-color var(--transition-fast) var(--ease-custom);
}
.wb-task-item__avatar[data-icon="image"] {
  background: color-mix(in srgb, #8b5cf6 12%, transparent);
  color: #6d28d9;
  border-color: color-mix(in srgb, #8b5cf6 28%, transparent);
}
.wb-task-item__avatar[data-icon="icon"] {
  background: color-mix(in srgb, #0ea5e9 12%, transparent);
  color: #0369a1;
  border-color: color-mix(in srgb, #0ea5e9 28%, transparent);
}
.wb-task-item__avatar[data-icon="test"] {
  background: color-mix(in srgb, #10b981 12%, transparent);
  color: #047857;
  border-color: color-mix(in srgb, #10b981 28%, transparent);
}
.wb-task-item__avatar[data-icon="ui"] {
  background: color-mix(in srgb, #f59e0b 12%, transparent);
  color: #b45309;
  border-color: color-mix(in srgb, #f59e0b 28%, transparent);
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
  gap: 3px;
}
.wb-task-item__title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  letter-spacing: -0.1px;
  line-height: 1.3;
}
.wb-task-item__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
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
/* 简单任务徽标：紧凑圆角胶囊,弱色调以不抢戏 */
.wb-task-item__meta-item--simple {
  display: inline-flex;
  align-items: center;
  height: 15px;
  padding: 0 6px;
  border-radius: 7px;
  background: color-mix(in srgb, #10b981 14%, transparent);
  color: #047857;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2px;
  white-space: nowrap;
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

/* 删除按钮：默认隐藏，hover 卡片时淡入 */
.wb-task-item__del {
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 13px;
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
  border: 1px dashed var(--border-color);
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
  border-style: solid;
  border-color: var(--border-color);
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
  padding: 18px 22px 20px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.wb-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  font-size: 13px;
}

/* ── 任务拆分头部：标题 + 提示词下拉 + 按钮组 ────────────────── */
.wb-split__header {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-shrink: 0;
}

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
  height: 42px;
  flex: 1;
  font-size: var(--font-size-17);
  font-weight: 600;
  letter-spacing: -0.4px;
  padding: 0 14px;
  border-color: var(--border-color-medium);
  background: var(--bg-container);
}
.wb-input--title:hover:not(:focus) {
  border-color: color-mix(in srgb, var(--color-primary) 30%, var(--border-color-medium));
}
.wb-input--title:focus {
  border-color: var(--color-primary);
  box-shadow:
    0 0 0 4px var(--tint-primary-14),
    var(--wb-card-inset-shadow);
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
  padding: 12px 14px;
  font-size: var(--font-size-135);
  line-height: 1.65;
  letter-spacing: -0.05px;
  resize: vertical;
  width: 100%;
  box-sizing: border-box;
  flex-shrink: 0;
  min-height: 72px;
  /* 块级 textarea 在容器内与其它控件等宽 */
}
.wb-textarea::placeholder {
  line-height: 1.65;
}
.wb-textarea:hover:not(:focus) {
  border-color: var(--border-input-hover, #cbd5e1);
  background: var(--bg-container-hover);
}
.wb-textarea:focus {
  border-color: var(--color-primary);
  background: var(--bg-container);
  box-shadow:
    0 0 0 3px var(--tint-primary-18),
    var(--wb-card-inset-shadow);
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
  flex-shrink: 0;
}
.wb-simple__header h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}
.wb-simple__hint {
  font-size: var(--font-size-115);
  color: var(--text-tertiary);
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
  border-color: rgba(245, 158, 11, 0.55);
  background: rgba(245, 158, 11, 0.04);
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
  color: #b45309;
  background: rgba(245, 158, 11, 0.15);
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
  background: #f59e0b;
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
  background: #ef4444;
  border-radius: 8px;
  vertical-align: middle;
}
.wb-sub-item__row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 6px;
}

/* ── 折叠态：紧凑单行 ─────────────────────────────────────── */
.wb-sub-item__row--compact {
  margin-bottom: 0;
  cursor: default;
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
  width: 24px;
  height: 24px;
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
  padding: 0 8px;
  height: 24px;
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

/* ── 已完成态：绿色微底 + 圆角柔化（与执行中红色脉冲对比） ─────────── */
.wb-sub-item.is-done:not(.is-running) {
  border-color: color-mix(in srgb, #22c55e 30%, transparent);
  background: color-mix(in srgb, #22c55e 4%, var(--bg-container));
}
.wb-sub-item.is-done.is-collapsed {
  padding: 8px 10px;
}
/* 折叠态的整行可点击展开：cursor + hover 反馈，避免和展开态冲突 */
.wb-sub-item.is-clickable { cursor: pointer; }
.wb-sub-item.is-clickable:hover {
  background: color-mix(in srgb, var(--color-primary) 6%, var(--bg-surface));
  border-color: color-mix(in srgb, var(--color-primary) 35%, var(--border-color));
}
.wb-sub-item.is-clickable:hover .wb-sub-item__title-compact { color: var(--color-primary); }
.wb-sub-item__status {
  position: relative;
  font-size: 11px;
  color: #fff;
  padding: 2px 8px;
  border-radius: 10px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 600;
  letter-spacing: 0.2px;
  overflow: hidden;
}

/* ── 执行中：徽章呼吸 + 闪烁圆点 + shimmer 高光 ─────────── */
.wb-sub-item.is-running .wb-sub-item__status {
  background: linear-gradient(
    90deg,
    var(--color-primary) 0%,
    color-mix(in srgb, var(--color-primary) 70%, #fff) 50%,
    var(--color-primary) 100%
  ) !important;
  background-size: 200% 100% !important;
  animation: wb-status-shimmer 2.4s linear infinite;
  box-shadow:
    0 0 0 0 var(--tint-primary-45),
    0 0 12px var(--tint-primary-35);
  animation: wb-status-pulse 2.4s ease-in-out infinite,
             wb-status-shimmer 2.4s linear infinite;
}
.wb-sub-item.is-running .wb-sub-item__status::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 6px rgba(255, 255, 255, 0.9);
  animation: wb-status-dot 1.2s ease-in-out infinite;
}
.wb-sub-item.is-running .wb-sub-item__status::after {
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

@keyframes wb-status-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@keyframes wb-status-pulse {
  0%, 100% {
    box-shadow:
      0 0 0 0 var(--tint-primary-45),
      0 0 12px var(--tint-primary-35);
  }
  50% {
    box-shadow:
      0 0 0 4px color-mix(in srgb, var(--color-primary) 0%, transparent),
      0 0 18px var(--tint-primary-55);
  }
}
@keyframes wb-status-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.55; transform: scale(0.7); }
}
@keyframes wb-status-sweep {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
@media (prefers-reduced-motion: reduce) {
  .wb-sub-item.is-running .wb-sub-item__status,
  .wb-sub-item.is-running .wb-sub-item__status::before,
  .wb-sub-item.is-running .wb-sub-item__status::after {
    animation: none;
  }
}
.wb-sub-item__pid {
  font-size: 11px;
  color: var(--text-tertiary);
  font-family: ui-monospace, monospace;
  flex-shrink: 0;
}
.wb-sub-item__stop {
  border: 1px solid rgba(239, 68, 68, 0.5);
  background: rgba(239, 68, 68, 0.08);
  color: #ef4444;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 3px;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s, color 0.15s;
}
.wb-sub-item__stop:hover {
  background: #ef4444;
  color: #fff;
  border-color: #ef4444;
}
.wb-sub-item__run {
  border: 1px solid var(--el-color-primary, #409eff);
  background: var(--el-color-primary, #409eff);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 3px;
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

/* ── 当前项目条（侧边栏任务列表上方） ─────────────────────── */
.wb-current-project {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  margin-bottom: 8px;
  border-radius: var(--radius-md);
  background: var(--tint-primary-10);
  border: 1px solid var(--tint-primary-22);
  font-size: 12px;
  color: var(--text-secondary);
}
.wb-current-project__icon { color: var(--color-primary); font-size: 13px; flex-shrink: 0; }
.wb-current-project__label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: var(--text-tertiary);
  text-transform: uppercase;
}
.wb-current-project__name {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  color: var(--color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

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
  border-top: 1px dashed var(--border-color);
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
  color: #047857;
  border-color: color-mix(in srgb, #10b981 35%, transparent);
  background: color-mix(in srgb, #10b981 8%, var(--bg-container));
}
.wb-meta-save.is-dirty {
  color: #b45309;
  border-color: rgba(245, 158, 11, 0.45);
  background: rgba(245, 158, 11, 0.06);
}
.wb-meta-save.is-error {
  color: #b91c1c;
  border-color: rgba(239, 68, 68, 0.45);
  background: rgba(239, 68, 68, 0.06);
}
@keyframes wb-meta-pulse {
  0%, 100% { opacity: 0.4; transform: scale(0.85); }
  50%      { opacity: 1;   transform: scale(1.1); }
}
@media (prefers-reduced-motion: reduce) {
  .wb-meta-save.is-saving .wb-meta-save__dot { animation: none; }
}
</style>

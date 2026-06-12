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
import { ref, computed, onMounted, onBeforeUnmount, reactive, nextTick, watch } from 'vue'
import { $t } from '@/lang/static'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useWorkbenchStatusStore } from '@stores/workbenchStatus'

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
  storedName: string
  absolutePath: string
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
  subtasks: SubTask[]
  status: string
  createdAt?: string
  updatedAt?: string
}
interface Job {
  id: string
  taskId: string
  subId: string
  title: string
  status: 'pending' | 'running' | 'done' | 'error'
  prompt?: string
  output: string
  pid: number | null
  startedAt: string | null
  endedAt: string | null
  exitCode: number | null
  error: string | null
}

// ── 状态 ────────────────────────────────────────────────────────────────────
const prompts = ref<Prompt[]>([])
const tasks = ref<Task[]>([])
const jobs = ref<Job[]>([])

const selectedTaskId = ref<string | null>(null)
const selectedTask = computed<Task | null>(() => tasks.value.find(t => t.id === selectedTaskId.value) || null)

const promptDialog = reactive({ visible: false, editing: null as Prompt | null, name: '', content: '', aiLoading: false })
const instructionDialog = reactive({ visible: false, text: '', loading: false, saving: false })
const taskDialog = reactive({ visible: false, editing: null as Task | null, title: '', desc: '', promptId: null as string | null })

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
}
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
  taskDialog.visible = true
}
async function saveTask() {
  if (!taskDialog.title.trim()) {
    ElMessage.warning($t('@WORKBENCH:标题必填'))
    return
  }
  const body = {
    id: taskDialog.editing?.id,
    title: taskDialog.title.trim(),
    desc: taskDialog.desc,
    promptId: taskDialog.promptId,
    subtasks: taskDialog.editing?.subtasks || []
  }
  const res = await fetch('/api/workbench/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(r => r.json())
  if (res.success) {
    ElMessage.success($t('@WORKBENCH:已保存'))
    taskDialog.visible = false
    loadTasks()
    if (!selectedTaskId.value) selectedTaskId.value = res.task.id
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
function selectTask(t: Task) {
  selectedTaskId.value = t.id
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
async function runTask(t: Task) {
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

function statusLabel(s: string) {
  switch (s) {
    case 'todo': return $t('@WORKBENCH:待执行')
    case 'running': return $t('@WORKBENCH:执行中')
    case 'done': return $t('@WORKBENCH:已完成')
    case 'error': return $t('@WORKBENCH:出错')
    case 'pending': return $t('@WORKBENCH:排队中')
    default: return s
  }
}
function statusColor(s: string) {
  switch (s) {
    case 'running': return 'var(--color-primary)'
    case 'done': return '#22c55e'
    case 'error': return '#ef4444'
    case 'pending': return '#f59e0b'
    default: return 'var(--text-tertiary)'
  }
}

onMounted(async () => {
  await Promise.all([loadPrompts(), loadTasks(), loadJobs()])
  connectSSE()
})
onBeforeUnmount(() => {
  if (es) { es.close(); es = null }
})

// ── 日志自动滚动 ─────────────────────────────────────────────────────────
const logRefs = ref<Record<string, HTMLElement | null>>({})
function setLogRef(subId: string) {
  return (el: any) => { logRefs.value[subId] = el as HTMLElement | null }
}
watch(
  () => jobs.value.map(j => ({ id: j.id, len: (j.output || '').length })),
  (next) => {
    // 仅当对应子任务日志面板展开（is-open）时滚到底
    next.forEach(({ id }) => {
      const job = jobs.value.find(j => j.id === id)
      if (!job || job.status !== 'running') return
      const el = logRefs.value[job.subId]
      if (!el) return
      nextTick(() => { el.scrollTop = el.scrollHeight })
    })
  },
  { deep: true, flush: 'post' }
)

// 客户端展示上限：镜像后端 256KB，避免渲染超大段文本卡顿
const MAX_LOG_DISPLAY = 64 * 1024
function displayOutput(raw: string | undefined | null): string {
  if (!raw) return ''
  if (raw.length <= MAX_LOG_DISPLAY) return raw
  return `${$t('@WORKBENCH:…（前文已截断）')}\n${raw.slice(-MAX_LOG_DISPLAY)}`
}

// ── 附件上传 ───────────────────────────────────────────────────────────
const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
  'image/bmp', 'image/svg+xml',
  'application/pdf',
  'text/plain', 'text/markdown', 'text/x-markdown', 'text/csv',
  'application/json', 'text/json', 'text/x-log'
])
const ALLOWED_EXT_HINT = '.png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,.pdf,.txt,.md,.csv,.json,.log'
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const uploadingSubs = ref<Record<string, boolean>>({})
const pasteHoverSubId = ref<string | null>(null)

function isUploading(subId: string): boolean { return !!uploadingSubs.value[subId] }

// 把任意输入的文件 / Blob 转成 File（如果没有文件名就给个临时名）
function ensureFile(blob: Blob, fallbackName: string): File {
  if (blob instanceof File) return blob
  // 截图粘贴时浏览器只给 Blob 而没有 File 实例
  const mime = blob.type || 'application/octet-stream'
  return new File([blob], fallbackName, { type: mime })
}

// 监听子任务卡片的 paste 事件
function onSubtaskPaste(e: ClipboardEvent, sub: SubTask) {
  if (!e.clipboardData) return
  // 1) 优先取 image/* Blob（截图、复制图片）
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
      uploadAttachment(sub, ensureFile(blob, `paste-${stamp}.${ext}`))
    }
    return
  }
  // 2) 否则看非图片文件（部分浏览器复制文件走这个）
  const fileItems = Array.from(e.clipboardData.items).filter(
    it => it.kind === 'file' && !it.type.startsWith('image/')
  )
  if (fileItems.length > 0) {
    e.preventDefault()
    for (const it of fileItems) {
      const blob = it.getAsFile()
      if (!blob) continue
      uploadAttachment(sub, ensureFile(blob, blob.name || 'pasted-file'))
    }
  }
}

// 监听 drop 事件
function onSubtaskDrop(e: DragEvent, sub: SubTask) {
  pasteHoverSubId.value = null
  const files = Array.from(e.dataTransfer?.files || [])
  files.forEach(f => uploadAttachment(sub, f))
}

async function uploadAttachment(sub: SubTask, file: File) {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    ElMessage.error(`「${file.name}」${$t('@WORKBENCH:超过 5MB 限制')}`)
    return
  }
  if (!ALLOWED_MIME.has(file.type) && !file.name.match(/\.(png|jpg|jpeg|gif|webp|bmp|svg|pdf|txt|md|markdown|csv|json|log)$/i)) {
    ElMessage.error(`${$t('@WORKBENCH:不支持的文件类型')}（${file.name}）`)
    return
  }
  const existing = sub.attachments || []
  if (existing.length >= 9) {
    ElMessage.error($t('@WORKBENCH:单个子任务最多 9 个附件'))
    return
  }
  uploadingSubs.value[sub.id] = true
  try {
    const res = await fetch(`/api/workbench/subtasks/${sub.id}/attachments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Original-Name': file.name,
        'X-Mime-Type': file.type || 'application/octet-stream'
      },
      body: file
    }).then(r => r.json())
    if (res.success) {
      if (!Array.isArray(sub.attachments)) sub.attachments = []
      sub.attachments.push(res.attachment)
      ElMessage.success(`${$t('@WORKBENCH:已添加：')}${file.name}`)
    } else {
      ElMessage.error(res.error || $t('@WORKBENCH:上传失败'))
    }
  } catch (err: any) {
    ElMessage.error($t('@WORKBENCH:上传失败') + '：' + (err && err.message || err))
  } finally {
    uploadingSubs.value[sub.id] = false
  }
}

async function removeAttachment(sub: SubTask, att: Attachment) {
  try {
    await ElMessageBox.confirm(
      $t('@WORKBENCH:删除附件「{name}」？', { name: att.originalName }),
      $t('@WORKBENCH:确认'),
      { type: 'warning' }
    )
  } catch { return }
  const res = await fetch(`/api/workbench/subtasks/${sub.id}/attachments/${att.id}`, { method: 'DELETE' }).then(r => r.json())
  if (res.success) {
    sub.attachments = (sub.attachments || []).filter(a => a.id !== att.id)
    ElMessage.success($t('@WORKBENCH:已删除'))
  } else {
    ElMessage.error(res.error || $t('@WORKBENCH:删除失败'))
  }
}

function pickAttachmentFile(sub: SubTask) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = ALLOWED_EXT_HINT
  input.multiple = true
  input.onchange = () => {
    const files = Array.from(input.files || [])
    files.forEach(f => uploadAttachment(sub, f))
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
    <!-- 左：任务列表 -->
    <aside class="wb-sidebar">
      <div class="wb-sidebar__header">
        <h3>{{ $t('@WORKBENCH:任务列表') }}</h3>
        <el-button size="small" type="primary" @click="openCreateTask">
          {{ $t('@WORKBENCH:新建任务') }}
        </el-button>
      </div>
      <ul class="wb-task-list">
        <li
          v-for="t in tasks"
          :key="t.id"
          class="wb-task-item"
          :class="{ active: t.id === selectedTaskId }"
          @click="selectTask(t)"
        >
          <div class="wb-task-item__title">{{ t.title }}</div>
          <div class="wb-task-item__meta">
            <span>{{ t.subtasks?.length || 0 }} {{ $t('@WORKBENCH:个子任务') }}</span>
            <button class="wb-task-item__del" @click.stop="deleteTask(t)" :title="$t('@WORKBENCH:删除')">×</button>
          </div>
        </li>
        <li v-if="tasks.length === 0" class="wb-empty">
          {{ $t('@WORKBENCH:暂无任务，点击右上角新建') }}
        </li>
      </ul>

      <div class="wb-sidebar__divider"></div>

      <div class="wb-sidebar__header">
        <h3>{{ $t('@WORKBENCH:预置提示词') }}</h3>
        <el-button size="small" @click="openCreatePrompt">
          {{ $t('@WORKBENCH:新建') }}
        </el-button>
      </div>
      <ul class="wb-prompt-list">
        <li v-for="p in prompts" :key="p.id" class="wb-prompt-item">
          <span class="wb-prompt-item__name" @click="openEditPrompt(p)" :title="p.content">
            {{ p.name }}
          </span>
          <button class="wb-prompt-item__del" @click="deletePrompt(p)">×</button>
        </li>
        <li v-if="prompts.length === 0" class="wb-empty">
          {{ $t('@WORKBENCH:暂无提示词') }}
        </li>
      </ul>
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
          <select class="wb-select" v-model="selectedTask.promptId">
            <option :value="null">{{ $t('@WORKBENCH:不绑定预置提示词') }}</option>
            <option v-for="p in prompts" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <el-button type="primary" :loading="false" @click="runTask(selectedTask)">
            {{ $t('@WORKBENCH:执行任务') }}
          </el-button>
        </div>
        <textarea
          class="wb-textarea"
          v-model="selectedTask.desc"
          :placeholder="$t('@WORKBENCH:任务描述（可选）')"
          rows="3"
        />
        <div class="wb-split__sub-header">
          <h4>{{ $t('@WORKBENCH:子任务拆分') }}</h4>
          <div>
            <el-button size="small" @click="addSubtask">+ {{ $t('@WORKBENCH:添加子任务') }}</el-button>
            <el-button size="small" type="primary" @click="saveSubtasks">{{ $t('@WORKBENCH:保存拆分') }}</el-button>
          </div>
        </div>
        <ul class="wb-sub-list">
          <li v-for="sub in selectedTask.subtasks" :key="sub.id" class="wb-sub-item">
            <div class="wb-sub-item__row">
              <span class="wb-sub-item__status" :style="{ background: statusColor(sub.status) }">
                {{ statusLabel(sub.status) }}
              </span>
              <input class="wb-input" v-model="sub.title" :placeholder="$t('@WORKBENCH:子任务标题')" @paste="onSubtaskPaste($event, sub)" />
              <span v-if="jobOf(sub.id)" class="wb-sub-item__pid" :title="$t('@WORKBENCH:进程ID')">
                PID: {{ jobOf(sub.id)?.pid }}
              </span>
              <button class="wb-sub-item__del" @click="removeSubtask(sub)">×</button>
            </div>
            <textarea
              class="wb-textarea wb-textarea--sm"
              v-model="sub.desc"
              :placeholder="$t('@WORKBENCH:子任务描述 / 独立提示词覆盖')"
              rows="2"
              @paste="onSubtaskPaste($event, sub)"
            />
            <details
              v-if="jobOf(sub.id)"
              class="wb-log-details"
              :open="jobOf(sub.id)?.status === 'running' || jobOf(sub.id)?.status === 'pending'"
            >
              <summary class="wb-log-summary">
                <span v-if="jobOf(sub.id)?.status === 'running'">● {{ $t('@WORKBENCH:正在执行…') }}</span>
                <span v-else-if="jobOf(sub.id)?.status === 'pending'">{{ $t('@WORKBENCH:排队中…') }}</span>
                <span v-else>{{ $t('@WORKBENCH:查看执行日志') }}</span>
                <span class="wb-log-summary__meta">
                  {{ (jobOf(sub.id)?.output || '').length }} {{ $t('@WORKBENCH:字符') }}
                </span>
              </summary>
              <pre :ref="setLogRef(sub.id)" class="wb-log-pre">{{ displayOutput(jobOf(sub.id)?.output) || $t('@WORKBENCH:（暂无输出）') }}</pre>
            </details>
            <div
              class="wb-attachments"
              :class="{ 'is-paste-hover': pasteHoverSubId === sub.id }"
              @paste="onSubtaskPaste($event, sub)"
              @dragover.prevent="pasteHoverSubId = sub.id"
              @dragenter.prevent="pasteHoverSubId = sub.id"
              @dragleave="pasteHoverSubId = (pasteHoverSubId === sub.id ? null : pasteHoverSubId)"
              @drop.prevent="onSubtaskDrop($event, sub)"
            >
              <div class="wb-attachments__head">
                <span class="wb-attachments__label">
                  {{ $t('@WORKBENCH:附件') }}
                  <span class="wb-attachments__count">{{ (sub.attachments || []).length }} / 9</span>
                </span>
                <button
                  class="wb-attachments__add"
                  :disabled="isUploading(sub.id) || (sub.attachments || []).length >= 9"
                  @click="pickAttachmentFile(sub)"
                >
                  {{ isUploading(sub.id) ? $t('@WORKBENCH:上传中…') : $t('@WORKBENCH:添加附件') }}
                </button>
              </div>
              <div v-if="pasteHoverSubId === sub.id" class="wb-attachments__paste-hint">
                {{ $t('@WORKBENCH:粘贴图片以快速添加') }}
              </div>
              <ul v-if="(sub.attachments || []).length > 0" class="wb-attachments__list">
                <li v-for="att in sub.attachments" :key="att.id" class="wb-attachment">
                  <div class="wb-attachment__icon" :class="{ 'wb-attachment__icon--img': isImageAttachment(att) }">
                    <img
                      v-if="isImageAttachment(att)"
                      :src="`/api/workbench/attachments/${att.id}/raw`"
                      :alt="att.originalName"
                      loading="lazy"
                    />
                    <span v-else>{{ att.ext.toUpperCase() }}</span>
                  </div>
                  <div class="wb-attachment__meta">
                    <div class="wb-attachment__name" :title="att.originalName">{{ att.originalName }}</div>
                    <div class="wb-attachment__sub">{{ humanSize(att.size) }} · {{ att.mimeType }}</div>
                  </div>
                  <button class="wb-attachment__del" @click="removeAttachment(sub, att)" :title="$t('@WORKBENCH:删除')">×</button>
                </li>
              </ul>
            </div>
          </li>
          <li v-if="selectedTask.subtasks.length === 0" class="wb-empty">
            {{ $t('@WORKBENCH:暂无子任务，点击上方按钮添加') }}
          </li>
        </ul>
      </template>
    </section>

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
      width="560px"
    >
      <el-form label-position="top">
        <el-form-item :label="$t('@WORKBENCH:标题')">
          <el-input v-model="taskDialog.title" />
        </el-form-item>
        <el-form-item :label="$t('@WORKBENCH:描述')">
          <el-input v-model="taskDialog.desc" type="textarea" :rows="3" />
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
  </div>
</template>

<style scoped>
.workbench {
  display: flex;
  height: 100%;
  background: var(--bg-container);
  color: var(--text-primary);
}

.wb-sidebar {
  width: 260px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-color);
  padding: 12px;
  overflow-y: auto;
  background: var(--bg-surface);
}
.wb-sidebar__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.wb-sidebar__header h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.wb-sidebar__divider {
  height: 1px;
  background: var(--border-color);
  margin: 16px 0;
}

.wb-task-list, .wb-prompt-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.wb-task-item {
  padding: 10px 12px;
  border-radius: var(--radius-md);
  cursor: pointer;
  margin-bottom: 4px;
  border: 1px solid transparent;
  transition: background 0.15s, border-color 0.15s;
}
.wb-task-item:hover { background: var(--bg-hover); }
.wb-task-item.active {
  background: rgba(59, 130, 246, 0.1);
  border-color: var(--color-primary);
}
.wb-task-item__title {
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 2px;
}
.wb-task-item__meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  color: var(--text-tertiary);
}
.wb-task-item__del,
.wb-prompt-item__del,
.wb-sub-item__del {
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}
.wb-task-item__del:hover,
.wb-prompt-item__del:hover,
.wb-sub-item__del:hover { color: #ef4444; }

.wb-prompt-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  font-size: 12px;
}
.wb-prompt-item:hover { background: var(--bg-hover); }
.wb-prompt-item__name {
  flex: 1;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wb-empty {
  padding: 16px 8px;
  text-align: center;
  font-size: 12px;
  color: var(--text-tertiary);
}

.wb-split {
  flex: 1;
  padding: 16px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.wb-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  font-size: 13px;
}
.wb-split__header {
  display: flex;
  gap: 8px;
  align-items: center;
}
.wb-input {
  background: var(--bg-base);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  border-radius: var(--radius-md);
  padding: 6px 10px;
  font-size: 13px;
  outline: none;
}
.wb-input:focus { border-color: var(--color-primary); }
.wb-input--title { font-size: 16px; font-weight: 600; flex: 1; }
.wb-select {
  background: var(--bg-base);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  border-radius: var(--radius-md);
  padding: 6px 8px;
  font-size: 13px;
}
.wb-textarea {
  background: var(--bg-base);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  font-size: 13px;
  font-family: inherit;
  resize: vertical;
  outline: none;
  width: 100%;
  box-sizing: border-box;
}
.wb-textarea:focus { border-color: var(--color-primary); }
.wb-textarea--sm { min-height: 40px; }

.wb-split__sub-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
}
.wb-split__sub-header h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}

.wb-sub-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wb-sub-item {
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 10px;
}
.wb-sub-item__row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 6px;
}
.wb-sub-item__status {
  font-size: 11px;
  color: #fff;
  padding: 2px 8px;
  border-radius: 10px;
  flex-shrink: 0;
}
.wb-sub-item__pid {
  font-size: 11px;
  color: var(--text-tertiary);
  font-family: ui-monospace, monospace;
  flex-shrink: 0;
}
.wb-sub-item__row .wb-input { flex: 1; }

/* ── 流式执行日志面板 ───────────────────────────────────────────── */
.wb-log-details {
  margin-top: 6px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm, 4px);
  background: var(--bg-code);
  overflow: hidden;
}
.wb-log-summary {
  list-style: none;
  cursor: pointer;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-secondary);
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.wb-log-summary::-webkit-details-marker { display: none; }
.wb-log-summary:hover { background: rgba(59, 130, 246, 0.06); }
.wb-log-summary__meta {
  font-size: 11px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.wb-log-pre {
  margin: 0;
  padding: 8px 10px;
  max-height: 240px;
  overflow: auto;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-primary);
  background: var(--bg-code);
  white-space: pre-wrap;
  word-break: break-word;
  border-top: 1px solid var(--border-color);
}

/* ── 子任务附件 ───────────────────────────────────────────────── */
.wb-attachments {
  margin-top: 6px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm, 4px);
  background: var(--bg-subtle, var(--bg-container));
  overflow: hidden;
  transition: border-color 0.15s, background 0.15s;
}
.wb-attachments.is-paste-hover {
  border-color: var(--color-primary);
  background: rgba(59, 130, 246, 0.06);
  box-shadow: inset 0 0 0 1px var(--color-primary);
}
.wb-attachments__paste-hint {
  padding: 4px 10px;
  background: var(--color-primary);
  color: #fff;
  font-size: 12px;
  text-align: center;
  border-top: 1px solid var(--border-color);
}
.wb-attachments__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-color);
}
.wb-attachments__label { display: inline-flex; gap: 6px; align-items: center; }
.wb-attachments__count {
  font-variant-numeric: tabular-nums;
  color: var(--text-tertiary);
  font-size: 11px;
}
.wb-attachments__add {
  border: 1px solid var(--border-color);
  background: var(--bg-container);
  color: var(--text-primary);
  font-size: 12px;
  padding: 3px 10px;
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  transition: background 0.15s;
}
.wb-attachments__add:hover:not(:disabled) {
  background: rgba(59, 130, 246, 0.08);
  border-color: var(--color-primary);
  color: var(--color-primary);
}
.wb-attachments__add:disabled { opacity: 0.5; cursor: not-allowed; }
.wb-attachments__list {
  list-style: none;
  margin: 0;
  padding: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.wb-attachment {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 4px 4px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm, 4px);
  background: var(--bg-container);
  max-width: 240px;
  min-width: 0;
}
.wb-attachment__icon {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  background: var(--bg-code);
  color: var(--text-tertiary);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
  overflow: hidden;
}
.wb-attachment__icon--img { background: var(--bg-code); }
.wb-attachment__icon img {
  width: 100%; height: 100%; object-fit: cover;
}
.wb-attachment__meta { min-width: 0; flex: 1; }
.wb-attachment__name {
  font-size: 12px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wb-attachment__sub {
  font-size: 10px;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wb-attachment__del {
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 16px;
  line-height: 1;
  width: 20px; height: 20px;
  border-radius: 3px;
  cursor: pointer;
  flex-shrink: 0;
}
.wb-attachment__del:hover { color: #ef4444; background: rgba(239,68,68,0.08); }
</style>

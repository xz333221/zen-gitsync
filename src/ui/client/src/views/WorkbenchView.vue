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
import { ref, computed, onMounted, onBeforeUnmount, reactive } from 'vue'
import { $t } from '@/lang/static'
import { ElMessage, ElMessageBox } from 'element-plus'

// ── 类型 ────────────────────────────────────────────────────────────────────
interface Prompt {
  id: string
  name: string
  content: string
  createdAt?: string
  updatedAt?: string
}
interface SubTask {
  id: string
  title: string
  desc: string
  status: 'todo' | 'running' | 'done' | 'error'
  promptOverride: string
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

const promptDialog = reactive({ visible: false, editing: null as Prompt | null, name: '', content: '' })
const taskDialog = reactive({ visible: false, editing: null as Task | null, title: '', desc: '', promptId: null as string | null })

let es: EventSource | null = null

function jobOf(subId: string): Job | null {
  return jobs.value.find(j => j.subId === subId) || null
}

function applyJobEvent(evt: string, payload: any) {
  if (evt === 'hello') {
    jobs.value = payload.jobs || []
    return
  }
  if (evt === 'job:update') {
    const j: Job = payload
    const i = jobs.value.findIndex(x => x.id === j.id)
    if (i >= 0) jobs.value[i] = j
    else jobs.value.push(j)
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
    ElMessage.error(payload.error || '执行出错')
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
  promptDialog.visible = true
}
function openEditPrompt(p: Prompt) {
  promptDialog.editing = p
  promptDialog.name = p.name
  promptDialog.content = p.content
  promptDialog.visible = true
}
async function savePrompt() {
  if (!promptDialog.name.trim() || !promptDialog.content.trim()) {
    ElMessage.warning('名称和内容不能为空')
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
    ElMessage.success('已保存')
    promptDialog.visible = false
    loadPrompts()
  } else {
    ElMessage.error(res.error || '保存失败')
  }
}
async function deletePrompt(p: Prompt) {
  await ElMessageBox.confirm(`删除提示词「${p.name}」？`, '确认', { type: 'warning' })
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
    ElMessage.warning('标题必填')
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
    ElMessage.success('已保存')
    taskDialog.visible = false
    loadTasks()
    if (!selectedTaskId.value) selectedTaskId.value = res.task.id
  } else {
    ElMessage.error(res.error || '保存失败')
  }
}
async function deleteTask(t: Task) {
  await ElMessageBox.confirm(`删除任务「${t.title}」及其所有子任务？`, '确认', { type: 'warning' })
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
    title: '新子任务',
    desc: '',
    status: 'todo',
    promptOverride: ''
  }
  selectedTask.value.subtasks.push(sub)
}
function removeSubtask(sub: SubTask) {
  if (!selectedTask.value) return
  selectedTask.value.subtasks = selectedTask.value.subtasks.filter(s => s.id !== sub.id)
}
async function saveSubtasks() {
  if (!selectedTask.value) return
  const res = await fetch('/api/workbench/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(selectedTask.value)
  }).then(r => r.json())
  if (res.success) {
    ElMessage.success('已保存拆分')
    loadTasks()
  } else {
    ElMessage.error(res.error || '保存失败')
  }
}

// ── 执行 ───────────────────────────────────────────────────────────────────
async function runTask(t: Task) {
  if (!t.subtasks || t.subtasks.length === 0) {
    ElMessage.warning('请先拆分任务')
    return
  }
  const res = await fetch(`/api/workbench/tasks/${t.id}/run`, { method: 'POST' }).then(r => r.json())
  if (res.success) {
    ElMessage.success(res.message || '已加入执行队列')
  } else {
    ElMessage.error(res.error || '执行失败')
  }
}

function statusLabel(s: string) {
  switch (s) {
    case 'todo': return '待执行'
    case 'running': return '执行中'
    case 'done': return '已完成'
    case 'error': return '出错'
    case 'pending': return '排队中'
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
              <input class="wb-input" v-model="sub.title" :placeholder="$t('@WORKBENCH:子任务标题')" />
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
            />
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
        <el-form-item :label="$t('@WORKBENCH:内容')">
          <el-input
            v-model="promptDialog.content"
            type="textarea"
            :rows="10"
            :placeholder="$t('@WORKBENCH:可用变量：{{task.title}} {{task.desc}} {{sub.title}} {{sub.desc}} {{repo.path}} {{branch}}')"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="promptDialog.visible = false">{{ $t('@WORKBENCH:取消') }}</el-button>
        <el-button type="primary" @click="savePrompt">{{ $t('@WORKBENCH:保存') }}</el-button>
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
</style>

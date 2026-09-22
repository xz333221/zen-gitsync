import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { $t } from '@/lang/static'
import type { Job, Task, Prompt } from '@/types/workbench'
import { useWorkbenchStatusStore } from '@stores/workbenchStatus'

export function useWorkbenchData() {
  const prompts = ref<Prompt[]>([])
  const tasks = ref<Task[]>([])
  const jobs = ref<Job[]>([])
  const currentProject = ref<{ path: string; name: string }>({ path: '', name: '' })
  const wbStatus = useWorkbenchStatusStore()

  function syncRunningCount() {
    wbStatus.setRunning(jobs.value.filter(j => j.status === 'running').length)
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
      const field = evt === 'job:thinking-delta' ? 'thinking' : 'output'
      const delta: string = payload?.delta || ''
      if (!delta) return
      const i = jobs.value.findIndex(x => x.id === payload.id)
      if (i < 0) return
      const cur = (jobs.value[i] as any)[field] || ''
      ;(jobs.value[i] as any)[field] = cur + delta
      return
    }
    // 工具调用增量：服务端按批推「整条调用的最新快照」（不是补丁），
    // 所以按 id 覆盖式合并即可 —— 同一条调用先 running 后 done 会推两次，顺序天然正确。
    if (evt === 'job:toolcalls') {
      const updates: any[] = Array.isArray(payload?.updates) ? payload.updates : []
      if (!updates.length) return
      const i = jobs.value.findIndex(x => x.id === payload.id)
      if (i < 0) return
      const job = jobs.value[i]
      for (const u of updates) {
        if (!u || !u.id) continue
        // 懒初始化：整批都是脏数据时不留一个空数组（老 job 的 toolCalls 语义保持 undefined）
        if (!Array.isArray(job.toolCalls)) job.toolCalls = []
        const k = job.toolCalls.findIndex(c => c.id === u.id)
        if (k >= 0) job.toolCalls[k] = { ...job.toolCalls[k], ...u }
        else job.toolCalls.push(u)
      }
      return
    }
    if (evt === 'task:update') {
      const i = tasks.value.findIndex(t => t.id === payload.id)
      if (i >= 0) tasks.value[i] = payload
    }
    if (evt === 'tasks:reordered') {
      // 后端整体广播新顺序；整组替换避免单条 task:update 覆盖歧义。
      // useWorkbenchProjectGroups 是 computed，基于 tasks.value 顺序，渲染同步刷新。
      // 防御性检查：如果服务端返回的任务数比当前少，说明可能丢数据，拒绝覆盖
      if (Array.isArray(payload?.tasks)) {
        if (payload.tasks.length < tasks.value.length) {
          console.warn(`[SSE tasks:reordered] 数据丢失风险：当前 ${tasks.value.length} 个任务，服务端只返回 ${payload.tasks.length} 个，拒绝覆盖`)
          return
        }
        tasks.value = payload.tasks
      }
      return
    }
    if (evt === 'task:error') {
      ElMessage.error(payload.error || $t('@WORKBENCH:执行出错'))
    }
  }

  let es: EventSource | null = null

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
      if (es) { es.close(); es = null }
      setTimeout(connectSSE, 3000)
    }
  }

  function disconnectSSE() {
    if (es) { es.close(); es = null }
  }

  async function loadPrompts() {
    const res = await fetch('/api/workbench/prompts').then(r => r.json()).catch(() => ({ prompts: [] }))
    prompts.value = res.prompts || []
  }
  async function loadTasks(captureSnapshot?: () => void) {
    const res = await fetch('/api/workbench/tasks').then(r => r.json()).catch(() => ({ tasks: [] }))
    tasks.value = res.tasks || []
    captureSnapshot?.()
  }
  async function loadCurrentProject() {
    const res = await fetch('/api/workbench/current-project').then(r => r.json()).catch(() => ({}))
    if (res && typeof res.projectPath === 'string') {
      currentProject.value = { path: res.projectPath, name: res.projectName || '' }
    }
  }
  async function loadJobs() {
    const res = await fetch('/api/workbench/jobs').then(r => r.json()).catch(() => ({ jobs: [] }))
    jobs.value = res.jobs || []
    syncRunningCount()
  }

  async function clearJobsByTask(taskId: string): Promise<number> {
    try {
      const res = await fetch(`/api/workbench/jobs/by-task/${encodeURIComponent(taskId)}`, { method: 'DELETE' }).then(r => r.json())
      if (!res?.success) {
        console.warn('[clearJobsByTask] failed:', res?.error)
        return 0
      }
      jobs.value = jobs.value.filter(j => j.taskId !== taskId)
      syncRunningCount()
      return res.removed || 0
    } catch (err) {
      console.warn('[clearJobsByTask] error:', err)
      return 0
    }
  }

  async function createTask(currentProjectPath?: string): Promise<Task | null> {
    const body: any = {
      title: '',
      desc: '',
      promptId: null,
      simpleOverride: ''
    }
    if (currentProjectPath) {
      body.projectPath = currentProjectPath
    }
    try {
      const res = await fetch('/api/workbench/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(r => r.json())
      if (!res.success) {
        ElMessage.error(res.error || $t('@WORKBENCH:保存失败'))
        return null
      }
      return res.task || null
    } catch {
      ElMessage.error($t('@WORKBENCH:保存失败'))
      return null
    }
  }

  return {
    prompts, tasks, jobs, currentProject,
    syncRunningCount, applyJobEvent,
    connectSSE, disconnectSSE,
    loadPrompts, loadTasks, loadCurrentProject, loadJobs,
    clearJobsByTask, createTask
  }
}

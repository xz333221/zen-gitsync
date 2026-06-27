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
    if (evt === 'tasks:reordered') {
      // 后端整体广播新顺序；整组替换避免单条 task:update 覆盖歧义。
      // useWorkbenchProjectGroups 是 computed，基于 tasks.value 顺序，渲染同步刷新。
      if (Array.isArray(payload?.tasks)) {
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

  async function clearNonDoneJobsByTask(taskId: string): Promise<number> {
    try {
      const res = await fetch(`/api/workbench/jobs/by-task/${encodeURIComponent(taskId)}?keepDone=true`, { method: 'DELETE' }).then(r => r.json())
      if (!res?.success) {
        console.warn('[clearNonDoneJobsByTask] failed:', res?.error)
        return 0
      }
      const removedIds = new Set(res.ids || [])
      jobs.value = jobs.value.filter(j => !(j.taskId === taskId && removedIds.has(j.id)))
      syncRunningCount()
      return res.removed || 0
    } catch (err) {
      console.warn('[clearNonDoneJobsByTask] error:', err)
      return 0
    }
  }

  async function createTask(currentProjectPath?: string): Promise<Task | null> {
    const body: any = {
      title: '',
      desc: '',
      promptId: null,
      type: 'simple',
      simpleOverride: '',
      subtasks: []
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
    syncRunningCount, jobOf, applyJobEvent,
    connectSSE, disconnectSSE,
    loadPrompts, loadTasks, loadCurrentProject, loadJobs,
    clearJobsByTask, clearNonDoneJobsByTask, createTask
  }
}

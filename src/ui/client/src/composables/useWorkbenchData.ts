import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { $t } from '@/lang/static'
import type { Job, Task } from '@/types/workbench'

export function useWorkbenchData() {
  const tasks = ref<Task[]>([])
  const jobs = ref<Job[]>([])
  const currentProject = ref<{ path: string; name: string }>({ path: '', name: '' })

  // 这里曾经往 useWorkbenchStatusStore 写过"左栏工作台角标"的数字（本地 jobs 里数 running）。
  // 已删除：那个口径漏 pending、漏别的 g ui 实例起的 job，与看板表头对不上。
  // 角标现在由 useOrchestrator 用服务端的 running 数组统一投喂（见 stores/workbenchStatus.ts）。

  function applyJobEvent(evt: string, payload: any) {
    if (evt === 'hello') {
      jobs.value = payload.jobs || []
      return
    }
    if (evt === 'job:update') {
      const j: Job = payload
      const i = jobs.value.findIndex(x => x.id === j.id)
      if (i >= 0) {
        // 整条快照替换，但**本地已经打过的思考计时点要保住**：
        // 服务端只在起跑 / 终态推 job:update，起跑那条的两个字段还是 null
        // （甚至老服务端根本没有这两个字段）—— 不保的话，运行中攒下的窗口
        // 会被这条快照抹掉（表现：数字闪一下没了）。
        // 服务端给了值就以服务端为准（终态那条就是），它才是跨实例一致的口径。
        const prev = jobs.value[i]
        if (!j.thinkingStartedAt && prev.thinkingStartedAt) j.thinkingStartedAt = prev.thinkingStartedAt
        if (!j.thinkingEndedAt && prev.thinkingEndedAt) j.thinkingEndedAt = prev.thinkingEndedAt
        jobs.value[i] = j
      } else jobs.value.push(j)
      return
    }
    if (evt === 'job:thinking-delta' || evt === 'job:output-delta') {
      const field = evt === 'job:thinking-delta' ? 'thinking' : 'output'
      const delta: string = payload?.delta || ''
      if (!delta) return
      const i = jobs.value.findIndex(x => x.id === payload.id)
      if (i < 0) return
      const job = jobs.value[i]
      const cur = (job as any)[field] || ''
      ;(job as any)[field] = cur + delta
      // 思考段计时：服务端只在起跑 / 终态推整条 job:update，运行中的这两个时间戳
      // 得由增量自己打点 —— 否则折叠态的「思考 x 秒」要等这一轮跑完才出现。
      // 口径与服务端一致（第一个分片记起点、之后每个分片把终点往前推）；终态那条
      // job:update 是整条快照，会用服务端的值覆盖，最终数字以服务端为准。
      if (evt === 'job:thinking-delta') {
        const at = new Date().toISOString()
        if (!job.thinkingStartedAt) job.thinkingStartedAt = at
        job.thinkingEndedAt = at
      }
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
  }

  async function clearJobsByTask(taskId: string): Promise<number> {
    try {
      const res = await fetch(`/api/workbench/jobs/by-task/${encodeURIComponent(taskId)}`, { method: 'DELETE' }).then(r => r.json())
      if (!res?.success) {
        console.warn('[clearJobsByTask] failed:', res?.error)
        return 0
      }
      jobs.value = jobs.value.filter(j => j.taskId !== taskId)
      return res.removed || 0
    } catch (err) {
      console.warn('[clearJobsByTask] error:', err)
      return 0
    }
  }

  async function createTask(currentProjectPath?: string): Promise<Task | null> {
    const body: any = {
      title: '',
      desc: ''
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
    tasks, jobs, currentProject,
    applyJobEvent,
    connectSSE, disconnectSSE,
    loadTasks, loadCurrentProject, loadJobs,
    clearJobsByTask, createTask
  }
}

import { ElMessage, ElMessageBox } from 'element-plus'
import { $t } from '@/lang/static'
import { computed, reactive, watch } from 'vue'
import type { Ref, ComputedRef } from 'vue'
import type { Task, Job } from '@/types/workbench'
import type { TaskExecutorId } from '@/utils/taskExecutor'
import type { SelectedFile } from 'zen-ai-chat-ui'

/** 排队中的一条续聊（任务还在跑，等这一轮结束再发） */
export interface QueuedChat {
  id: string
  text: string
  /** 带着的附件。**队列里存 File 本体、等真正发出去那一刻才上传** ——
   *  排队时先传的话，用户把这条从队列里删掉就会在任务附件里留一份孤儿 */
  files: SelectedFile[]
}

/**
 * 工作台的执行动作。
 *
 * 每个任务都是一次会话：执行 = 把任务标题/描述（+ 附件 + 提示词覆盖）交给本地 CLI 跑一轮。
 * 因此这里只有一条执行路径，`runTask` 是唯一入口（首次执行、重跑、卡片上的「执行」都走它）。
 *
 * 另外管一条**排队续聊**：任务在跑的时候用户也能继续发，发出去的先排队，
 * 等这一轮 job 进入终态再自动接上（见文件末尾的 watch）。
 */
export function useWorkbenchExecution(
  jobs: Ref<Job[]>,
  tasks: Ref<Task[]>,
  selectedTask: ComputedRef<Task | null>,
  options: {
    clearJobsByTask: (taskId: string) => Promise<number>
    persistTask: (showSuccess: boolean) => Promise<boolean>
    uploadAttachment: (target: any, file: File) => Promise<void>
    /** 本次执行用哪个本地 CLI（claude | opencode | codex）。工作台执行按钮旁的临时选择 */
    getExecutor: () => TaskExecutorId
  }
) {
  // 所有执行请求统一带上 executor；不传时后端回落到配置里的全局默认。
  function executorBody(): Record<string, string> {
    return { executor: options.getExecutor() }
  }

  /** 编辑器里改了没落盘时，执行前先存一次 —— 否则跑的还是旧内容 */
  async function persistIfDirty(t: Task): Promise<boolean> {
    if (!selectedTask.value || selectedTask.value.id !== t.id) return true
    const onDisk = tasks.value.find(x => x.id === t.id)
    const dirty = !onDisk
      || onDisk.title !== selectedTask.value.title
      || onDisk.desc !== selectedTask.value.desc
    if (!dirty) return true
    return await options.persistTask(false)
  }

  async function runTask(t: Task) {
    if (!(await persistIfDirty(t))) return
    // 重跑 = 新的一轮：先清掉这个任务旧的执行记录，否则对话区会把上一轮和这一轮混在一起
    await options.clearJobsByTask(t.id)
    const res = await fetch(`/api/workbench/tasks/${encodeURIComponent(t.id)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(executorBody())
    })
      .then(r => r.json())
      .catch(err => ({ success: false, error: err?.message || String(err) }))
    if (res.success) {
      ElMessage.success(res.message || $t('@WORKBENCH:已加入执行队列'))
    } else {
      ElMessage.error(res.error || $t('@WORKBENCH:执行失败'))
    }
  }

  /** 续接一轮对话。返回是否真的发出去了（排队那边靠它决定要不要出队） */
  async function continueChat(t: Task, message: string): Promise<boolean> {
    const latest = jobs.value
      .filter(j => j.taskId === t.id)
      .slice(-1)[0]
    if (!latest) {
      ElMessage.error($t('@WORKBENCH:没有可续接的会话'))
      return false
    }
    const carryAtts = Array.isArray(t.attachments) ? t.attachments : []
    const res = await fetch(`/api/workbench/jobs/${latest.id}/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userMessage: message,
        attachments: carryAtts
      })
    }).then(r => r.json()).catch(err => ({ success: false, error: err?.message || String(err) }))
    if (res.success) {
      ElMessage.success(res.message || $t('@WORKBENCH:已加入续接队列'))
      return true
    }
    ElMessage.error(res.error || $t('@WORKBENCH:续接失败'))
    return false
  }

  // ── 排队续聊 ──────────────────────────────────────────────────────────
  // 任务在跑的时候用户也要能继续打字：先排队，等这一轮 job 进入终态再自动接上。
  // 队列按 taskId 分开存（同一个页面里可能来回切任务）。
  const chatQueue = reactive<Record<string, QueuedChat[]>>({})
  // 非响应式，只用来防「同一条队列同时有两笔在途的续接请求」——
  // 终态事件可能连着来（job:update 一次、后面的 job:output-delta 收尾再一次），
  // 没有这道闩锁会把队列里两条一起发出去。
  const flushInFlight = new Set<string>()
  let queueSeq = 0

  /** 这个任务此刻有没有 job 在跑（pending 也算：排队中同样是"在跑"） */
  function isTaskRunning(taskId: string): boolean {
    return jobs.value.some(
      j => j.taskId === taskId && (j.status === 'running' || j.status === 'pending')
    )
  }

  function queuedChatsOf(taskId: string): QueuedChat[] {
    return chatQueue[taskId] ?? []
  }

  function enqueueChat(t: Task, text: string, files: SelectedFile[] = []) {
    const list = chatQueue[t.id] ?? (chatQueue[t.id] = [])
    list.push({ id: `q-${Date.now()}-${++queueSeq}`, text, files })
  }

  function removeQueuedChat(taskId: string, queuedId: string) {
    const list = chatQueue[taskId]
    if (!list) return
    const i = list.findIndex(x => x.id === queuedId)
    if (i < 0) return
    list.splice(i, 1)
    if (!list.length) delete chatQueue[taskId]
  }

  /** 附件上传 + 续接，串成一步；排队出队和直接发送都走它 */
  async function deliverChat(t: Task, item: { text: string; files: SelectedFile[] }): Promise<boolean> {
    for (const sf of item.files) {
      await options.uploadAttachment({ kind: 'task', task: t }, sf.file)
    }
    return await continueChat(t, item.text)
  }

  /**
   * 把队首发出去。只在「队列有货 + 这个任务当前没在跑」时动手 ——
   * 「立即发送」按钮和终态自动接棒都调它，所以两条路径共用同一份判定。
   */
  async function flushNextQueued(taskId: string) {
    if (flushInFlight.has(taskId)) return
    const list = chatQueue[taskId]
    if (!list || list.length === 0) return
    if (isTaskRunning(taskId)) return
    const t = tasks.value.find(x => x.id === taskId)
    if (!t) {
      // 任务已被删掉：队列留着也没意义，直接丢掉，避免点了没反应
      delete chatQueue[taskId]
      return
    }
    const next = list[0]
    flushInFlight.add(taskId)
    try {
      // 失败了就把这条留在队里（continueChat 已经弹过错误提示），
      // 用户可以点「立即发送」重试，或者「移除」
      if (await deliverChat(t, next)) removeQueuedChat(taskId, next.id)
    } finally {
      flushInFlight.delete(taskId)
    }
  }

  /**
   * 有 job 在跑的任务集合。刻意只读 `j.status`（不碰 thinking/output），
   * 所以流式的每个 token 都不会把这个 computed 打成热路径。
   */
  const runningTaskIds = computed(() => {
    const ids = new Set<string>()
    for (const j of jobs.value) {
      if (j.status === 'running' || j.status === 'pending') ids.add(j.taskId)
    }
    return ids
  })

  // 任务从「在跑」变成「不跑了」→ 队列自动接棒
  watch(runningTaskIds, (now, prev) => {
    if (!prev) return
    for (const taskId of prev) {
      if (now.has(taskId)) continue
      if (!chatQueue[taskId]?.length) continue
      // 「重新执行 / 清空执行」会把 job 全删掉，那时也会走到这儿 —— 不该补发，
      // 交给新跑起来的那一轮的终态去触发（否则刚清完就冒出一条旧续聊）
      if (!jobs.value.some(j => j.taskId === taskId)) continue
      void flushNextQueued(taskId)
    }
  })

  async function onContinueSendFromChat(t: Task, payload: { text: string; files: SelectedFile[] }) {
    const msg = payload.text.trim()
    if (!msg) return
    // 正在跑 → 排队，等这一轮结束自动接上；空闲 → 照旧直接发
    if (isTaskRunning(t.id)) {
      enqueueChat(t, msg, payload.files)
      return
    }
    await deliverChat(t, { text: msg, files: payload.files })
  }

  /**
   * 执行日志里点「重新执行」：找回这条 job 所属的任务再跑一轮。
   * job.subId 形如 `{taskId}__simple[__rN]`，但更稳的是直接用 taskId —— 任务被删过就报错。
   */
  async function onReExecuteJob(j: Job) {
    const t = tasks.value.find(x => x.id === j.taskId)
      || tasks.value.find(x => x.id === String(j.subId || '').replace(/__simple(?:__r\d+)?$/, ''))
    if (!t) {
      ElMessage.error($t('@WORKBENCH:找不到对应任务,无法重新执行'))
      return
    }
    await runTask(t)
  }

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

  async function clearExecutionForSelectedTask() {
    if (!selectedTask.value) return
    const t = selectedTask.value
    const localJobs = jobs.value.filter(j => j.taskId === t.id)
    const runCount = localJobs.filter(j => j.status === 'running' || j.status === 'pending').length
    const confirmMsg = localJobs.length === 0
      ? $t('@WORKBENCH:当前任务还没有执行内容,确认仍要清空?')
      : $t('@WORKBENCH:将清空 {m} 条执行记录,任务描述/附件保留。', { m: localJobs.length })
    try {
      await ElMessageBox.confirm(
        confirmMsg,
        $t('@WORKBENCH:清空执行内容'),
        {
          confirmButtonText: $t('@WORKBENCH:清空'),
          cancelButtonText: $t('@WORKBENCH:取消'),
          type: 'warning'
        }
      )
    } catch {
      return
    }
    if (runCount > 0) {
      ElMessage.warning($t('@WORKBENCH:任务正在执行,请先停止'))
      return
    }
    const res = await fetch(`/api/workbench/tasks/${encodeURIComponent(t.id)}/clear-execution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
      .then(r => r.json())
      .catch(err => ({ success: false, error: err?.message || String(err) }))
    if (res?.success) {
      jobs.value = jobs.value.filter(j => j.taskId !== t.id)
      ElMessage.success(res.message || $t('@WORKBENCH:已清空执行内容'))
    } else {
      ElMessage.error(res?.error || $t('@WORKBENCH:清空失败'))
    }
  }

  return {
    runTask, continueChat, onContinueSendFromChat,
    onReExecuteJob, cancelJob,
    clearExecutionForSelectedTask,
    // 排队续聊
    isTaskRunning, queuedChatsOf, removeQueuedChat, flushNextQueued
  }
}

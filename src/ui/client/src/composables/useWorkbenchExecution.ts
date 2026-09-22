import { ElMessage, ElMessageBox } from 'element-plus'
import { $t } from '@/lang/static'
import type { Ref, ComputedRef } from 'vue'
import type { Task, Job } from '@/types/workbench'
import type { SelectedFile } from 'zen-ai-chat-ui'

/**
 * 工作台的执行动作。
 *
 * 每个任务都是一次会话：执行 = 把任务标题/描述（+ 附件 + 提示词覆盖）交给本地 CLI 跑一轮。
 * 因此这里只有一条执行路径，`runTask` 是唯一入口（首次执行、重跑、卡片上的「执行」都走它）。
 */
export function useWorkbenchExecution(
  jobs: Ref<Job[]>,
  tasks: Ref<Task[]>,
  selectedTask: ComputedRef<Task | null>,
  options: {
    syncRunningCount: () => void
    clearJobsByTask: (taskId: string) => Promise<number>
    persistTask: (showSuccess: boolean) => Promise<boolean>
    uploadAttachment: (target: any, file: File) => Promise<void>
    /** 本次执行用哪个本地 CLI（claude | opencode）。工作台执行按钮旁的临时选择 */
    getExecutor: () => 'claude' | 'opencode'
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
      || onDisk.promptId !== selectedTask.value.promptId
      || (onDisk.simpleOverride || '') !== (selectedTask.value.simpleOverride || '')
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

  async function continueChat(t: Task, message: string) {
    const latest = jobs.value
      .filter(j => j.taskId === t.id)
      .slice(-1)[0]
    if (!latest) {
      ElMessage.error($t('@WORKBENCH:没有可续接的会话'))
      return
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
    } else {
      ElMessage.error(res.error || $t('@WORKBENCH:续接失败'))
    }
  }

  async function onContinueSendFromChat(t: Task, payload: { text: string; files: SelectedFile[] }) {
    const msg = payload.text.trim()
    if (!msg) return
    for (const sf of payload.files) {
      await options.uploadAttachment({ kind: 'task', task: t }, sf.file)
    }
    await continueChat(t, msg)
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
      options.syncRunningCount()
      ElMessage.success(res.message || $t('@WORKBENCH:已清空执行内容'))
    } else {
      ElMessage.error(res?.error || $t('@WORKBENCH:清空失败'))
    }
  }

  return {
    runTask, continueChat, onContinueSendFromChat,
    onReExecuteJob, cancelJob,
    clearExecutionForSelectedTask
  }
}

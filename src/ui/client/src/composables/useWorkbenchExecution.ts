import { ElMessage, ElMessageBox } from 'element-plus'
import { $t } from '@/lang/static'
import type { Ref, ComputedRef } from 'vue'
import type { Task, SubTask, Job } from '@/types/workbench'
import type { SelectedFile } from 'zen-ai-chat-ui'

export function useWorkbenchExecution(
  jobs: Ref<Job[]>,
  tasks: Ref<Task[]>,
  selectedTask: ComputedRef<Task | null>,
  options: {
    syncRunningCount: () => void
    jobOf: (subId: string) => Job | null
    simpleAllJobsFor: (task: Task | null) => Job[]
    clearJobsByTask: (taskId: string) => Promise<number>
    clearNonDoneJobsByTask: (taskId: string) => Promise<number>
    persistTask: (showSuccess: boolean) => Promise<boolean>
    loadTasks: (captureSnapshot?: () => void) => Promise<void>
    uploadAttachment: (target: any, file: File) => Promise<void>
  }
) {
  async function runTask(t: Task) {
    if (t.type === 'simple') {
      return runSimpleTask(t)
    }
    if (!t.subtasks || t.subtasks.length === 0) {
      ElMessage.warning($t('@WORKBENCH:请先拆分任务'))
      return
    }
    if (selectedTask.value && selectedTask.value.id === t.id) {
      const onDisk = tasks.value.find(x => x.id === t.id)
      const dirty = !onDisk
        || onDisk.title !== selectedTask.value.title
        || onDisk.desc !== selectedTask.value.desc
        || JSON.stringify(onDisk.subtasks) !== JSON.stringify(selectedTask.value.subtasks)
        || onDisk.promptId !== selectedTask.value.promptId
      if (dirty) {
        const ok = await options.persistTask(false)
        if (!ok) return
      }
    }
    const doneSubs = t.subtasks.filter(s => s.status === 'done')
    if (doneSubs.length > 0) {
      let choice: 'confirm' | 'cancel' | 'close' = 'close'
      try {
        await ElMessageBox.confirm(
          $t('@WORKBENCH:该任务有 {n} 个子任务已 done,如何处理?', { n: doneSubs.length }) + '\n\n' +
            $t('@WORKBENCH:点"确定"将重置全部 done 为 todo,从头跑一遍(会消耗 token)') + '\n' +
            $t('@WORKBENCH:点"取消"将保留 done 状态,只跑未完成的 sub'),
          $t('@WORKBENCH:检测到已完成子任务'),
          {
            confirmButtonText: $t('@WORKBENCH:重置全部并重跑'),
            cancelButtonText: $t('@WORKBENCH:只跑未完成'),
            type: 'warning',
            distinguishCancelAndClose: true,
            showClose: true
          }
        )
        choice = 'confirm'
      } catch (action: any) {
        choice = action === 'cancel' ? 'cancel' : 'close'
      }
      if (choice === 'close') return
      if (choice === 'confirm') {
        const res = await fetch(`/api/workbench/tasks/${encodeURIComponent(t.id)}/clear-execution`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }).then(r => r.json()).catch(err => ({ success: false, error: err?.message || String(err) }))
        if (!res?.success) {
          ElMessage.error(res?.error || $t('@WORKBENCH:清空失败'))
          return
        }
        if (Array.isArray(t.subtasks)) {
          for (const s of t.subtasks) {
            s.status = 'todo'
            if (s.error) delete s.error
          }
        }
        jobs.value = jobs.value.filter(j => j.taskId !== t.id)
        options.syncRunningCount()
        ElMessage.success(res.message || $t('@WORKBENCH:已重置,准备从头执行'))
      }
    }
    await options.clearNonDoneJobsByTask(t.id)
    const res = await fetch(`/api/workbench/tasks/${t.id}/run`, { method: 'POST' }).then(r => r.json())
    if (res.success) {
      ElMessage.success(res.message || $t('@WORKBENCH:已加入执行队列'))
    } else {
      ElMessage.error(res.error || $t('@WORKBENCH:执行失败'))
    }
  }

  async function runSimpleTask(t: Task) {
    if (selectedTask.value && selectedTask.value.id === t.id) {
      const onDisk = tasks.value.find(x => x.id === t.id)
      const dirty = !onDisk
        || onDisk.title !== selectedTask.value.title
        || onDisk.desc !== selectedTask.value.desc
        || onDisk.promptId !== selectedTask.value.promptId
        || (onDisk.simpleOverride || '') !== (selectedTask.value.simpleOverride || '')
      if (dirty) {
        const ok = await options.persistTask(false)
        if (!ok) return
      }
    }
    await options.clearJobsByTask(t.id)
    const res = await fetch(`/api/workbench/tasks/${t.id}/run-simple`, { method: 'POST' }).then(r => r.json())
    if (res.success) {
      ElMessage.success(res.message || $t('@WORKBENCH:已加入执行队列'))
    } else {
      ElMessage.error(res.error || $t('@WORKBENCH:执行失败'))
    }
  }

  async function continueChat(t: Task, message: string) {
    const latest = options.simpleAllJobsFor(t).slice(-1)[0]
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

  async function onReExecuteJob(j: Job) {
    const subId = j.subId || ''
    const simpleMatch = subId.match(/^(.+)__simple(?:__r\d+)?$/)
    if (simpleMatch) {
      const taskId = simpleMatch[1]
      const t = tasks.value.find(x => x.id === taskId)
      if (!t) {
        ElMessage.error($t('@WORKBENCH:任务不存在,无法重新执行'))
        return
      }
      await runSimpleTask(t)
      return
    }
    for (const t of tasks.value) {
      const sub = (t.subtasks || []).find(s => s.id === subId)
      if (sub) {
        const live = options.jobOf(sub.id)
        if (live && (live.status === 'running' || live.status === 'pending')) {
          ElMessage.warning($t('@WORKBENCH:该子任务正在执行中'))
          return
        }
        const res = await fetch(`/api/workbench/subtasks/${sub.id}/run`, { method: 'POST' })
          .then(r => r.json())
          .catch(err => ({ success: false, error: err?.message || String(err) }))
        if (res.success) {
          ElMessage.success(res.message || $t('@WORKBENCH:已开始执行子任务'))
        } else {
          ElMessage.error(res.error || $t('@WORKBENCH:执行失败'))
        }
        return
      }
    }
    ElMessage.error($t('@WORKBENCH:找不到对应任务,无法重新执行'))
  }

  async function runSubtask(sub: SubTask) {
    if (!selectedTask.value) return
    const t = selectedTask.value
    const live = options.jobOf(sub.id)
    if (live && (live.status === 'running' || live.status === 'pending')) {
      ElMessage.warning($t('@WORKBENCH:该子任务正在执行中'))
      return
    }
    const onDisk = tasks.value.find(x => x.id === t.id)
    const dirty = !onDisk
      || onDisk.title !== t.title
      || onDisk.desc !== t.desc
      || JSON.stringify(onDisk.subtasks) !== JSON.stringify(t.subtasks)
      || onDisk.promptId !== t.promptId
    if (dirty) {
      const ok = await options.persistTask(false)
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

  function canRunSubtask(sub: SubTask): boolean {
    if (sub.status === 'done') return false
    const j = options.jobOf(sub.id)
    if (j && (j.status === 'running' || j.status === 'pending')) return false
    return true
  }

  function canRunFromHere(sub: SubTask): boolean {
    if (!canRunSubtask(sub)) return false
    if (!selectedTask.value) return false
    const subs = selectedTask.value.subtasks || []
    const idx = subs.findIndex(s => s.id === sub.id)
    if (idx < 0) return false
    if (idx === subs.length - 1) return false
    return true
  }

  async function runFromHere(sub: SubTask) {
    if (!selectedTask.value) return
    const t = selectedTask.value
    const subs = t.subtasks || []
    const startIndex = subs.findIndex(s => s.id === sub.id)
    if (startIndex < 0) return
    const onDisk = tasks.value.find(x => x.id === t.id)
    const dirty = !onDisk
      || onDisk.title !== t.title
      || onDisk.desc !== t.desc
      || JSON.stringify(onDisk.subtasks) !== JSON.stringify(t.subtasks)
      || onDisk.promptId !== t.promptId
    if (dirty) {
      const ok = await options.persistTask(false)
      if (!ok) return
    }
    const res = await fetch(`/api/workbench/tasks/${t.id}/run-from`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startSubIndex: startIndex })
    })
      .then(r => r.json())
      .catch(err => ({ success: false, error: err?.message || String(err) }))
    if (res.success) {
      ElMessage.success(res.message || $t('@WORKBENCH:已从此处开始执行'))
    } else {
      ElMessage.error(res.error || $t('@WORKBENCH:执行失败'))
    }
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

  async function cancelDone(sub: SubTask, persistTaskFn: (showSuccess: boolean) => Promise<boolean>) {
    if (!selectedTask.value) return
    sub.status = 'todo'
    await persistTaskFn(false)
  }

  async function clearExecutionForSelectedTask() {
    if (!selectedTask.value) return
    const t = selectedTask.value
    const subs = Array.isArray(t.subtasks) ? t.subtasks : []
    const doneCount = subs.filter(s => s.status === 'done').length
    const errCount = subs.filter(s => s.status === 'error').length
    const runCount = subs.filter(s => s.status === 'running').length
    const localJobs = jobs.value.filter(j => j.taskId === t.id)
    const confirmMsg = doneCount + errCount === 0
      ? $t('@WORKBENCH:当前任务还没有执行内容,确认仍要清空?')
      : $t('@WORKBENCH:将清空 {n} 个已执行/失败的子任务和 {m} 条执行记录,任务拆分/描述/附件保留。', {
          n: doneCount + errCount,
          m: localJobs.length
        })
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
      ElMessage.warning($t('@WORKBENCH:有 {n} 个子任务正在执行,请先停止', { n: runCount }))
      return
    }
    const res = await fetch(`/api/workbench/tasks/${encodeURIComponent(t.id)}/clear-execution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
      .then(r => r.json())
      .catch(err => ({ success: false, error: err?.message || String(err) }))
    if (res?.success) {
      if (Array.isArray(t.subtasks)) {
        for (const s of t.subtasks) {
          s.status = 'todo'
          if (s.error) delete s.error
        }
      }
      jobs.value = jobs.value.filter(j => j.taskId !== t.id)
      options.syncRunningCount()
      ElMessage.success(res.message || $t('@WORKBENCH:已清空执行内容'))
    } else {
      ElMessage.error(res?.error || $t('@WORKBENCH:清空失败'))
    }
  }

  async function clearSubtasksForSelectedTask(clearDirty: () => void) {
    if (!selectedTask.value) return
    const t = selectedTask.value
    const subCount = Array.isArray(t.subtasks) ? t.subtasks.length : 0
    if (subCount === 0) {
      ElMessage.warning($t('@WORKBENCH:当前任务没有子任务'))
      return
    }
    const runningJob = jobs.value.find(j => j.taskId === t.id && (j.status === 'running' || j.status === 'pending'))
    if (runningJob) {
      ElMessage.warning($t('@WORKBENCH:有子任务正在执行,请先停止'))
      return
    }
    try {
      await ElMessageBox.confirm(
        $t('@WORKBENCH:将删除 {n} 个子任务,任务描述/附件/标题保留,确认?', { n: subCount }),
        $t('@WORKBENCH:清空子任务'),
        {
          confirmButtonText: $t('@WORKBENCH:清空'),
          cancelButtonText: $t('@WORKBENCH:取消'),
          type: 'warning'
        }
      )
    } catch {
      return
    }
    const res = await fetch(`/api/workbench/tasks/${encodeURIComponent(t.id)}/clear-subtasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
      .then(r => r.json())
      .catch(err => ({ success: false, error: err?.message || String(err) }))
    if (res?.success) {
      t.subtasks = []
      clearDirty()
      jobs.value = jobs.value.filter(j => j.taskId !== t.id)
      options.syncRunningCount()
      ElMessage.success(res.message || $t('@WORKBENCH:已清空子任务'))
    } else {
      ElMessage.error(res?.error || $t('@WORKBENCH:清空失败'))
    }
  }

  return {
    runTask, runSimpleTask, continueChat, onContinueSendFromChat,
    onReExecuteJob, runSubtask, canRunSubtask, canRunFromHere, runFromHere,
    cancelJob, cancelDone,
    clearExecutionForSelectedTask, clearSubtasksForSelectedTask
  }
}

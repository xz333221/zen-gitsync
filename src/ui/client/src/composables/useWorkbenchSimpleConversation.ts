import { computed } from 'vue'
import type { Ref, ComputedRef } from 'vue'
import type { ChatMessage, MessageStatus } from 'zen-ai-chat-ui'
import type { Job, Task } from '@/types/workbench'

const SIMPLE_SUB_ID_SUFFIX = '__simple'
const MAX_LOG_DISPLAY_SIMPLE = 64 * 1024

export function useWorkbenchSimpleConversation(jobs: Ref<Job[]>, selectedTask: ComputedRef<Task | null>) {

  function simpleAllJobsFor(task: Task | null): Job[] {
    if (!task) return []
    const prefix = `${task.id}${SIMPLE_SUB_ID_SUFFIX}`
    return jobs.value
      .filter(j => j.subId === prefix || j.subId.startsWith(`${prefix}__r`))
      .sort((a, b) => {
        const sa = a.startedAt || ''
        const sb = b.startedAt || ''
        if (sa && sb) return sa.localeCompare(sb)
        if (sa) return -1
        if (sb) return 1
        return 0
      })
  }

  function simpleJobFor(task: Task | null): Job | null {
    if (!task) return null
    const list = simpleAllJobsFor(task)
    return list.length > 0 ? list[list.length - 1] : null
  }

  type SimpleState = 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  function simpleJobState(job: Job | null): SimpleState {
    if (!job) return 'idle'
    if (job.status === 'pending' || job.status === 'running') return 'running'
    if (job.status === 'done') return 'done'
    if (job.status === 'cancelled') return 'cancelled'
    return 'error'
  }

  const simpleConversationMessages = computed<ChatMessage[]>(() => {
    if (!selectedTask.value) return []
    const allJobs = simpleAllJobsFor(selectedTask.value)
    if (allJobs.length === 0) return []
    const msgs: ChatMessage[] = []
    allJobs.forEach((j, idx) => {
      const isLast = idx === allJobs.length - 1
      const createdAt = j.startedAt ? new Date(j.startedAt).getTime() : Date.now()
      if (j.prompt) {
        msgs.push({
          id: `${j.id}-u`,
          role: 'user',
          content: j.prompt,
          status: 'done',
          createdAt
        })
      }
      const rawOutput = j.output || ''
      const rawThinking = j.thinking || ''
      const outputText = rawOutput.length > MAX_LOG_DISPLAY_SIMPLE
        ? `\u2026（前文已截断）\n${rawOutput.slice(-MAX_LOG_DISPLAY_SIMPLE)}`
        : rawOutput
      const thinkingText = rawThinking.length > MAX_LOG_DISPLAY_SIMPLE
        ? `\u2026（前文已截断）\n${rawThinking.slice(-MAX_LOG_DISPLAY_SIMPLE)}`
        : rawThinking
      const hasOutput = !!outputText
      const hasThinking = !!thinkingText
      const hasContent = hasOutput || hasThinking
      let status: MessageStatus
      if (!isLast) {
        status = 'done'
      } else {
        const s = j.status
        if (s === 'running' || s === 'pending') {
          status = hasContent ? 'streaming' : 'pending'
        } else if (s === 'error') {
          status = 'error'
        } else {
          status = 'done'
        }
      }
      msgs.push({
        id: `${j.id}-a`,
        role: 'assistant',
        content: outputText,
        reasoning: hasThinking ? thinkingText : undefined,
        reasoningStatus: hasThinking
          ? (!isLast && hasOutput ? 'done' : (hasOutput ? 'done' : (status === 'streaming' ? 'streaming' : 'done')))
          : undefined,
        status,
        error: status === 'error' ? (j.error || undefined) : undefined,
        createdAt
      })
    })
    return msgs
  })

  return {
    simpleConversationMessages,
    simpleAllJobsFor,
    simpleJobFor,
    simpleJobState,
    SIMPLE_SUB_ID_SUFFIX,
    MAX_LOG_DISPLAY_SIMPLE
  }
}

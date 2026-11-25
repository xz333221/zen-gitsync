import { computed } from 'vue'
import type { Ref, ComputedRef } from 'vue'
import type { ChatMessage, MessageStatus } from 'zen-ai-chat-ui'
import type { Job, Task } from '@/types/workbench'
import { buildJobToolCalls } from '@/utils/jobToolCalls'
import { buildJobReasoningTiming } from '@/utils/jobReasoningTiming'
import { userFacingPrompt } from '@/utils/jobUserPrompt'
import { jobMessageAttachments, toChatAttachments } from '@/utils/jobPromptAttachments'
import { resolveLocalImages } from '@/utils/localImageSrc'

const SIMPLE_SUB_ID_SUFFIX = '__simple'
const MAX_LOG_DISPLAY_SIMPLE = 64 * 1024

/**
 * 一轮在时间线上的位置（毫秒，升序排用）。
 *
 * 不能只看 `startedAt`：spawn 直接失败的那轮（`spawn claude.exe ENOENT`）在
 * 2026-11-25 之前的服务端从来没写过时间戳（见 taskRunner 的 stampJobFailure），
 * 缺失值一律当"最末"，于是**更早**的失败被排到对话流底部、永远贴在输入框上面。
 * 老记录只剩 id 可用 —— 它的首段就是 `Date.now().toString(36)`（shared.js），
 * 反解回毫秒就能和 ISO 时间放进同一把尺子里比较。
 */
function jobTimeMs(j: Job): number {
  const t = Date.parse(j.startedAt || j.endedAt || '')
  if (!Number.isNaN(t)) return t
  const m = /^([0-9a-z]{6,})-/i.exec(j.id || '')
  const fromId = m ? parseInt(m[1], 36) : NaN
  // 连 id 都不认识：沿用旧口径（缺失算最末），别让脏记录蹿到最前面
  return Number.isNaN(fromId) ? Number.MAX_SAFE_INTEGER : fromId
}

export function useWorkbenchSimpleConversation(jobs: Ref<Job[]>, selectedTask: ComputedRef<Task | null>) {

  function simpleAllJobsFor(task: Task | null): Job[] {
    if (!task) return []
    const prefix = `${task.id}${SIMPLE_SUB_ID_SUFFIX}`
    return jobs.value
      .filter(j => j.subId === prefix || j.subId.startsWith(`${prefix}__r`))
      .sort((a, b) => jobTimeMs(a) - jobTimeMs(b))
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
    const task = selectedTask.value
    const allJobs = simpleAllJobsFor(task)
    if (allJobs.length === 0) return []
    const msgs: ChatMessage[] = []
    allJobs.forEach((j, idx) => {
      const isLast = idx === allJobs.length - 1
      const createdAt = j.startedAt ? new Date(j.startedAt).getTime() : Date.now()
      // 气泡只显示用户真正说过的那部分：job.prompt 前面还挂着环境块/记忆块、后面挂着
      // 附件清单与「续接 #N」（见 utils/jobUserPrompt.ts 里的实测数据 —— 原样渲染会让
      // 每轮气泡糊一大块重复内容，而且用户复制对话再粘回去时会把这些块一起带回去）。
      if (j.prompt) {
        const content = userFacingPrompt(j.prompt)
        // 这一轮实际带走的附件：prompt 尾部清单是 spawn 时冻结的（比任务当前的
        // attachments 更贴近历史），id / 大小从任务当前记录里按路径认领，
        // 认领到的图片出缩略图。与 JobLogDetails 共用同一份解析（jobPromptAttachments.ts）。
        const atts = jobMessageAttachments(j.prompt, task.attachments)
        if (content || atts.length > 0) {
          msgs.push({
            id: `${j.id}-u`,
            role: 'user',
            content,
            attachments: atts.length > 0 ? toChatAttachments(atts) : undefined,
            status: 'done',
            createdAt
          })
        }
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
      // 工具调用也算法内容：模型可能一句正文都不说就直接开干，
      // 只按 output/thinking 判断的话这条 assistant 消息会整条不显示。
      const toolCalls = buildJobToolCalls(j)
      const hasToolCalls = toolCalls.length > 0
      const hasContent = hasOutput || hasThinking || hasToolCalls
      // 一轮压根没跑起来（spawn 失败）、零产出，而且后面还有别的轮次：assistant 侧不画。
      // 组件库只在 status==='error' 时渲错误块，非最后一轮一律降级成 done —— 硬画出来
      // 就是个空气泡（"用户说了一句、底下跟一坨空的"），比不画更难懂。最后一轮仍然
      // 走 error（重试按钮挂在它身上），失败原因没丢；历史去「执行记录 / 历史报告」查。
      // （forEach 回调里没有 continue，用 return 跳过本次 push。）
      if (!isLast && j.status === 'error' && !hasContent) return
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
        // 正文里嵌的本机图片路径 → 后端端点（模型写 `![](c:\…\a.png)` 时才看得见图，
        // 见 utils/localImageSrc.ts）。放在这里而不是组件里：两个视图共用这一份映射。
        content: resolveLocalImages(outputText, j.id),
        reasoning: hasThinking ? thinkingText : undefined,
        reasoningStatus: hasThinking
          ? (!isLast && hasOutput ? 'done' : (hasOutput ? 'done' : (status === 'streaming' ? 'streaming' : 'done')))
          : undefined,
        // 思考段计时（job.thinkingStartedAt/EndedAt → 库认的毫秒时间戳），
        // ThinkingBlock 靠它在标题右侧显示「思考 4.2s」（折叠着也看得见）
        ...buildJobReasoningTiming(j),
        // 工具调用（读文件 / 跑命令 / 改代码）——没有它就只能看到"模型在思考"，
        // 看不出这一轮到底干了什么（2026-09-22）。
        toolCalls: hasToolCalls ? toolCalls : undefined,
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

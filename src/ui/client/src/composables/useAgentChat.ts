// useAgentChat — 智能体对话 composable
//
// 职责：
//   1. 会话列表 CRUD（加载 / 删除 / 重命名）
//   2. SSE 流式聊天（thinking / content / tool_call / tool_result / done / error）
//   3. 后端 OpenAI 格式消息 → zen-ai-chat-ui ChatMessage 格式转换
//   4. 取消正在进行的请求

import { computed, reactive, ref } from 'vue'
import type { ChatMessage, ToolCall, ChatAttachment, SelectedFile } from 'zen-ai-chat-ui'
import { ElMessage, ElMessageBox } from 'element-plus'
import { uid } from 'zen-ai-chat-ui'
import { extractThinkSegments } from 'zen-ai-chat-ui'
import { $t } from '@/lang/static'
import { useConfigStore } from '@/stores/configStore'

// ── 类型 ──────────────────────────────────────────────────
interface SessionMeta {
  sessionId: string
  title: string
  source: string
  cwd: string
  model: string
  createdAt: string
  updatedAt: string
  messageCount: number
  size: number
  // 本地乐观标记：本轮 SSE 还在跑（服务端尚未落盘）。仅存在于前端内存，
  // 流结束后 loadSessions() 会用服务端数据整体覆盖。
  isGenerating?: boolean
}

export interface PendingAgentQuestion {
  interactionId: string
  question: string
  options: string[]
  allowFreeText: boolean
}

// 后端 session 完整数据
interface AgentSession {
  version: number
  sessionId: string
  title: string
  source: string
  cwd: string
  model: string
  createdAt: string
  updatedAt: string
  messages: AgentMsg[]
}

// OpenAI 兼容的消息格式
interface AgentMsg {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | Array<{ type: string; text?: string; image_url?: { url: string } }>
  tool_calls?: Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

// ── 常量 ──────────────────────────────────────────────────
const MAX_LOG_DISPLAY = 64 * 1024

// 新会话在服务端 meta 事件返回真实 sessionId 之前使用的本地临时 key 前缀
const LOCAL_KEY_PREFIX = 'local-'

// ── 后端消息 → ChatMessage 转换 ──────────────────────────
// 把 OpenAI 格式的消息数组转换为 zen-ai-chat-ui 的 ChatMessage[]
// system 消息被跳过（不展示给用户）
// assistant + tool_calls → 合并为一条 assistant 消息，tool_calls 展示为 ToolCall[]
// tool 消息 → 附加到前一条 assistant 的 toolCalls 对应项的 result
export function convertSessionToMessages(session: AgentSession | null): ChatMessage[] {
  if (!session || !Array.isArray(session.messages)) return []
  const result: ChatMessage[] = []
  const msgCount = session.messages.length

  for (let i = 0; i < msgCount; i++) {
    const m = session.messages[i]

    if (m.role === 'system') continue

    if (m.role === 'user') {
      let text = ''
      let attachments: ChatAttachment[] | undefined
      if (typeof m.content === 'string') {
        text = m.content
      } else if (Array.isArray(m.content)) {
        text = m.content.filter(p => p?.type === 'text').map(p => p.text || '').join(' ')
        // 多模态消息里的 image_url 部件还原为附件，历史里也能看到当时发的图
        const imageAtts = m.content
          .filter(p => p?.type === 'image_url' && typeof p.image_url?.url === 'string')
          .map((p, idx) => ({
            id: `att-${i}-${idx}`,
            name: 'image',
            size: 0,
            type: mimeFromDataUrl(p.image_url?.url || '') || 'image/*',
            preview: p.image_url?.url
          }))
        if (imageAtts.length > 0) attachments = imageAtts
      }
      if (text || attachments) {
        result.push({
          id: `msg-${i}`,
          role: 'user',
          content: text,
          attachments,
          status: 'done',
          createdAt: Date.now()
        })
      }
    } else if (m.role === 'assistant') {
      let content = ''
      if (typeof m.content === 'string') {
        content = m.content
      }

      // 截断过长内容
      if (content.length > MAX_LOG_DISPLAY) {
        content = `…（前文已截断）\n${content.slice(-MAX_LOG_DISPLAY)}`
      }

      const toolCalls: ToolCall[] = []
      if (m.tool_calls && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          toolCalls.push({
            id: tc.id || tc.function?.name || uid(),
            name: tc.function?.name || '',
            arguments: tc.function?.arguments || '',
            argsPreview: summarizeToolArgs(tc.function?.name || '', tc.function?.arguments || ''),
            status: 'done',
            result: ''
          })
        }
      }

      // 收集后续的 tool 消息结果
      let j = i + 1
      while (j < msgCount && session.messages[j].role === 'tool') {
        const toolMsg = session.messages[j]
        const toolCallId = toolMsg.tool_call_id || toolMsg.name || ''
        const tc = toolCalls.find(t => t.id === toolCallId)
        if (tc) {
          let result = toolMsg.content
          if (typeof result !== 'string') result = '(non-text result)'
          if (result.length > MAX_LOG_DISPLAY) {
            result = `…（前文已截断）\n${result.slice(-MAX_LOG_DISPLAY)}`
          }
          tc.result = result
        }
        i = j
        j++
      }

      const hasContent = !!content
      const hasToolCalls = toolCalls.length > 0
      if (hasContent || hasToolCalls) {
        result.push({
          id: `msg-${i}`,
          role: 'assistant',
          content: content || '',
          toolCalls: hasToolCalls ? toolCalls : undefined,
          status: 'done',
          createdAt: Date.now()
        })
      }
    }
  }

  return result
}

// 工具参数简短摘要
function summarizeToolArgs(name: string, argsStr: string): string {
  try {
    const args = JSON.parse(argsStr)
    switch (name) {
      case 'run_command': return String(args.command || '').slice(0, 200)
      case 'read_file':
      case 'write_file':
      case 'edit_file': return String(args.path || '')
      case 'list_files': return String(args.path || '.')
      case 'search_text': return String(args.pattern || '')
      default: return JSON.stringify(args).slice(0, 200)
    }
  } catch {
    return argsStr.slice(0, 200)
  }
}

// File → base64 dataURL（图片随聊天请求发给后端）
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
    reader.readAsDataURL(file)
  })
}

// 从 dataURL 解析 MIME（data:image/png;base64,... → image/png）
function mimeFromDataUrl(u: string): string {
  const m = /^data:([^;,]+)/.exec(u)
  return m ? m[1] : ''
}

// ── 单个会话的运行时状态 ─────────────────────────────────
// 每个会话各持一份：后台流写自己的 run，切换会话只改 currentSessionId 指向，
// 不再打断正在跑的流，也不会把增量写进别的会话。
interface SessionRun {
  key: string
  sessionId: string | null
  title: string
  messages: ChatMessage[]
  isStreaming: boolean
  abortController: AbortController | null
  nonce: number
  pendingQuestion: PendingAgentQuestion | null
  answeringQuestion: boolean
}

// ── composable ───────────────────────────────────────────
export function useAgentChat() {
  const configStore = useConfigStore()

  // 会话列表
  const sessions = ref<SessionMeta[]>([])
  const sessionsLoading = ref(false)

  // 打开过的会话的运行时状态，按 key（真实 sessionId / 未落盘时的本地临时 key）索引
  const runs = reactive(new Map<string, SessionRun>())

  // 当前激活的会话 key
  const currentSessionId = ref<string | null>(null)
  const sessionLoading = ref(false)

  // 会话列表请求计数（防止乱序响应覆盖）；各会话 SSE 用 run.nonce 各自独立
  let sessionsRequestNonce = 0
  let localKeySeed = 0

  // ── 运行时状态存取 ─────────────────────────────────────
  function createRun(key: string): SessionRun {
    return {
      key,
      sessionId: key.startsWith(LOCAL_KEY_PREFIX) ? null : key,
      title: '',
      messages: [],
      isStreaming: false,
      abortController: null,
      nonce: 0,
      pendingQuestion: null,
      answeringQuestion: false
    }
  }

  function ensureRun(key: string): SessionRun {
    let run = runs.get(key)
    if (!run) {
      runs.set(key, createRun(key))
      // 必须从 map 取回(响应式代理),否则新建的这一条拿到的还是原始对象，
      // 之后 push 消息/改 isStreaming 都不会触发视图更新
      run = runs.get(key)!
    }
    return run
  }

  // 当前激活会话的派生视图
  const activeRun = computed<SessionRun | null>(() =>
    currentSessionId.value ? runs.get(currentSessionId.value) ?? null : null
  )
  const messages = computed<ChatMessage[]>(() => activeRun.value?.messages ?? [])
  const isStreaming = computed(() => activeRun.value?.isStreaming ?? false)
  const pendingQuestion = computed<PendingAgentQuestion | null>(() => activeRun.value?.pendingQuestion ?? null)
  const answeringQuestion = computed(() => activeRun.value?.answeringQuestion ?? false)

  // 供会话列表判断某个会话是否正在生成（含后台生成）
  function isSessionGenerating(sessionId: string): boolean {
    return Boolean(runs.get(sessionId)?.isStreaming)
  }

  // ── 加载会话列表(按当前项目隔离) ─────────────────────
  // 服务端只返回已落盘的会话；正在后台流式、尚未落盘的会话要补回列表，
  // 否则并发/切会话时刷新列表会把还在生成的那条"吞掉"。
  function mergeGeneratingSessions(server: SessionMeta[]): SessionMeta[] {
    const merged = [...server]
    for (const run of runs.values()) {
      if (!run.isStreaming || !run.sessionId) continue
      const idx = merged.findIndex(s => s.sessionId === run.sessionId)
      if (idx === -1) {
        const nowIso = new Date().toISOString()
        merged.unshift({
          sessionId: run.sessionId,
          title: run.title || $t('@AGENT:无标题'),
          source: 'web',
          cwd: configStore.currentDirectory || '',
          model: '',
          createdAt: nowIso,
          updatedAt: nowIso,
          messageCount: run.messages.filter(m => m.role === 'user').length || 1,
          size: 0,
          isGenerating: true
        })
      } else {
        merged[idx] = { ...merged[idx], isGenerating: true }
      }
    }
    return merged
  }

  async function loadSessions() {
    const requestNonce = ++sessionsRequestNonce
    const cwd = configStore.currentDirectory || ''
    if (!cwd) {
      sessions.value = []
      sessionsLoading.value = false
      return
    }
    sessionsLoading.value = true
    try {
      const url = `/api/agent/sessions?cwd=${encodeURIComponent(cwd)}`
      const res = await fetch(url).then(r => r.json())
      if (requestNonce !== sessionsRequestNonce) return
      if (!res.success) {
        ElMessage.error(res.error || $t('@AGENT:加载会话列表失败'))
        return
      }
      const server = Array.isArray(res.sessions) ? res.sessions : []
      sessions.value = mergeGeneratingSessions(server)
    } catch (err: any) {
      if (requestNonce !== sessionsRequestNonce) return
      ElMessage.error($t('@AGENT:加载会话列表失败') + ': ' + (err?.message || err))
    } finally {
      if (requestNonce === sessionsRequestNonce) sessionsLoading.value = false
    }
  }

  // ── 乐观插入会话(流式期间让左栏立刻出现这一条) ─────────
  // 服务端要等整轮回答跑完才 writeSession(),前端也只在流结束后 loadSessions(),
  // 中间这几分钟左栏完全静止。meta 事件已经带了 sessionId + 自动标题,
  // 这里先本地插一条标记 isGenerating 的条目占位,流结束后由 loadSessions() 覆盖。
  function upsertGeneratingSession(sessionId: string, title: string) {
    const nowIso = new Date().toISOString()
    const existing = sessions.value.find(s => s.sessionId === sessionId)
    if (existing) {
      // 老会话续聊：只打生成标记，不新建条目、不改标题(标题永远取自首条 user 消息)
      existing.isGenerating = true
      existing.updatedAt = nowIso
      return
    }
    sessions.value = [
      {
        sessionId,
        title: title || $t('@AGENT:无标题'),
        source: 'web',
        cwd: configStore.currentDirectory || '',
        model: '',
        createdAt: nowIso,
        updatedAt: nowIso,
        messageCount: 1,
        size: 0,
        isGenerating: true
      },
      ...sessions.value
    ]
  }

  // 清除乐观标记(流结束/出错/中止都要清，否则徽章一直转)
  function clearGeneratingSession(sessionId: string) {
    const s = sessions.value.find(s => s.sessionId === sessionId)
    if (s) s.isGenerating = false
  }

  // ── 加载会话详情 ────────────────────────────────────────
  async function loadSession(sessionId: string) {
    // 该会话正在后台流式：直接挂载它的实时缓冲，别用磁盘(尚未落盘)内容覆盖
    const existing = runs.get(sessionId)
    if (existing?.isStreaming) {
      currentSessionId.value = sessionId
      return
    }
    sessionLoading.value = true
    currentSessionId.value = sessionId
    try {
      const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`).then(r => r.json())
      if (!res.success) {
        ElMessage.error(res.error || $t('@AGENT:加载会话失败'))
        return
      }
      const run = ensureRun(sessionId)
      run.sessionId = sessionId
      run.messages = convertSessionToMessages(res.session)
      if (res.session?.title) run.title = res.session.title
    } catch (err: any) {
      ElMessage.error($t('@AGENT:加载会话失败') + ': ' + (err?.message || err))
    } finally {
      sessionLoading.value = false
    }
  }

  // ── 删除会话 ────────────────────────────────────────────
  async function deleteSession(sessionId: string) {
    try {
      await ElMessageBox.confirm($t('@AGENT:确认删除该会话'), $t('@AGENT:删除后无法恢复'), { type: 'warning' })
    } catch {
      return
    }
    // 正在后台生成的会话先中止它，避免删完还有流继续写
    const run = runs.get(sessionId)
    if (run?.abortController) {
      try { run.abortController.abort() } catch {}
    }
    runs.delete(sessionId)
    try {
      const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE'
      }).then(r => r.json())
      if (!res.success) {
        ElMessage.error(res.error || $t('@AGENT:删除失败'))
        return
      }
      sessions.value = sessions.value.filter(s => s.sessionId !== sessionId)
      if (currentSessionId.value === sessionId) {
        currentSessionId.value = null
      }
      ElMessage.success($t('@AGENT:已删除'))
    } catch (err: any) {
      ElMessage.error($t('@AGENT:删除失败') + ': ' + (err?.message || err))
    }
  }

  // ── 重命名会话 ──────────────────────────────────────────
  async function renameSession(sessionId: string, title: string) {
    try {
      const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title })
      }).then(r => r.json())
      if (!res.success) {
        ElMessage.error(res.error || $t('@AGENT:重命名失败'))
        return
      }
      const s = sessions.value.find(s => s.sessionId === sessionId)
      if (s) s.title = title
      const run = runs.get(sessionId)
      if (run) run.title = title
      ElMessage.success($t('@AGENT:已重命名'))
    } catch (err: any) {
      ElMessage.error($t('@AGENT:重命名失败') + ': ' + (err?.message || err))
    }
  }

  // ── 新建会话（切到一个空白会话，首次发消息时后端自动创建） ──
  // 不再清空其它会话状态：后台正在生成的会话保持继续。
  function newSession() {
    currentSessionId.value = null
  }

  // ── 发送消息（SSE 流式，按会话隔离，可后台并行） ────────
  async function sendMessage(text: string, files: SelectedFile[] = []) {
    // 组件库允许选任意文件，但多模态消息只支持图片；非图片提示后忽略
    const imageFiles = files.filter(f => f?.file?.type?.startsWith('image/'))
    if (imageFiles.length < files.length) {
      ElMessage.warning($t('@AGENT:仅支持发送图片，非图片文件已忽略'))
    }

    // 目标会话：已有会话用其 id；全新会话先用本地临时 key，等 meta 回来再迁移
    const runKey = currentSessionId.value || `${LOCAL_KEY_PREFIX}${Date.now()}-${++localKeySeed}`
    const run = ensureRun(runKey)
    // 只在"当前激活会话"层面拦截重复发送，不影响其它会话后台继续
    if ((!text.trim() && imageFiles.length === 0) || run.isStreaming) return

    // 图片 File → base64 dataURL，随请求发给后端组装多模态 content
    const settled = await Promise.allSettled(imageFiles.map(f => fileToDataUrl(f.file)))
    const images = settled
      .map(r => (r.status === 'fulfilled' ? r.value : ''))
      .filter(u => u.startsWith('data:image/'))

    // 切到这条会话(新会话从 null 切到本地 key)，让乐观消息立刻可见
    currentSessionId.value = run.key

    run.nonce += 1
    const myNonce = run.nonce
    run.abortController = new AbortController()
    const myController = run.abortController
    run.pendingQuestion = null
    run.answeringQuestion = false

    // 乐观推入 user 消息（图片以附件缩略图展示）
    const userMsg: ChatMessage = {
      id: uid(),
      role: 'user',
      content: text,
      status: 'done',
      createdAt: Date.now()
    }
    if (imageFiles.length > 0) {
      userMsg.attachments = imageFiles.map(f => ({
        id: f.id,
        name: f.file.name || 'image',
        size: f.file.size || 0,
        type: f.file.type || '',
        preview: f.preview
      }))
    }
    run.messages.push(userMsg)

    // 占位 assistant 消息
    // 注意:必须用 reactive() 包装,否则 push 进 run.messages 后,
    // assistantMsg 变量指向原始 plain object,SSE 循环里的
    // `assistantMsg.content += delta` 修改的是 plain object,
    // 而 Vue 渲染看到的是 reactive Proxy(初始 content=''),
    // 内容永远不变,loading dots 一直不消失。
    const assistantMsg = reactive<ChatMessage>({
      id: uid(),
      role: 'assistant',
      content: '',
      status: 'pending',
      createdAt: Date.now()
    })
    run.messages.push(assistantMsg)

    run.isStreaming = true

    // 当前 assistant 消息的工具调用列表（实时更新）
    let currentToolCalls: ToolCall[] = []

    // 本轮实际落盘的会话 ID（meta 事件到达后才有值）
    let streamSessionId: string | null = run.sessionId

    try {
      const resp = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          sessionId: run.sessionId || '',
          userMessage: text,
          // 新建会话时服务端用它确定项目归属(已有会话沿用其落盘 cwd)
          cwd: configStore.currentDirectory || '',
          ...(images.length > 0 ? { images } : {})
        }),
        signal: myController.signal
      })

      if (myNonce !== run.nonce) return

      if (!resp.ok || !resp.body) {
        const errText = await resp.text().catch(() => '')
        throw new Error(errText || `HTTP ${resp.status}`)
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buf = ''

      while (true) {
        const { value, done } = await reader.read()
        if (myNonce !== run.nonce) return
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (!payload) continue
          let evt: any
          try { evt = JSON.parse(payload) } catch { continue }

          switch (evt.type) {
            case 'meta':
              if (evt.sessionId) {
                const realId = String(evt.sessionId)
                streamSessionId = realId
                // 新会话：把 run 从本地临时 key 迁移到服务端真实 sessionId，
                // 这样后台继续跑的同时左栏/切换都能按真实 id 找到它
                if (run.sessionId !== realId) {
                  const oldKey = run.key
                  run.sessionId = realId
                  run.key = realId
                  if (oldKey !== realId) {
                    runs.delete(oldKey)
                    runs.set(realId, run)
                    if (currentSessionId.value === oldKey) currentSessionId.value = realId
                  }
                }
                // 服务端 autoTitle 已按首条 user 消息算好标题；为空(纯图片消息等)
                // 时退回本地文本，保证左栏不会出现空白行
                const optimisticTitle = String(evt.title || '').trim() ||
                  text.trim().split('\n')[0].trim().slice(0, 40) ||
                  $t('@AGENT:无标题')
                if (!run.title) run.title = optimisticTitle
                upsertGeneratingSession(realId, optimisticTitle)
              }
              break

            case 'thinking':
              if (!assistantMsg.reasoning) {
                assistantMsg.reasoning = ''
                assistantMsg.reasoningStatus = 'streaming'
              }
              assistantMsg.reasoning += String(evt.delta || '')
              assistantMsg.status = 'streaming'
              break

            case 'content':
              if (assistantMsg.status === 'pending') {
                assistantMsg.status = 'streaming'
              }
              {
                const delta = String(evt.delta || '')
                assistantMsg.content += delta
                // 模型常把 <think>…</think> 直接写在 content 流里
                // (典型如 MiniMax-M3、DeepSeek)。已闭合段立即抽到
                // reasoning，剩余未闭合段继续留在 content，下一次
                // chunk 增长时由 extractThinkSegments 重试。
                const split = extractThinkSegments(assistantMsg.content)
                if (split.reasoning) {
                  if (!assistantMsg.reasoning) {
                    assistantMsg.reasoning = ''
                    assistantMsg.reasoningStatus = 'streaming'
                  }
                  // 整段替换 reasoning，避免重复累加
                  assistantMsg.reasoning = split.reasoning
                  assistantMsg.content = split.content
                }
              }
              break

            case 'tool_call_start': {
              // 注意:必须用 reactive() 包装,否则 tool_result 事件里
              // 修改 tc.status/tc.result 时 Vue 看不到(plain object vs Proxy),
              // 工具块一直停在 'running' 转圈。跟 assistantMsg 是同一个根因。
              const tc = reactive<ToolCall>({
                id: evt.toolCallId || uid(),
                name: evt.name || '',
                argsPreview: evt.argsPreview || '',
                arguments: evt.argsPreview || '',
                status: 'running',
                result: ''
              })
              currentToolCalls.push(tc)
              if (!assistantMsg.toolCalls) {
                assistantMsg.toolCalls = []
              }
              assistantMsg.toolCalls.push(tc)
              if (assistantMsg.status === 'pending') {
                assistantMsg.status = 'streaming'
              }
              break
            }

            case 'tool_result': {
              const tc = currentToolCalls.find(t => t.id === evt.toolCallId)
              if (tc) {
                tc.result = String(evt.result || '')
                tc.status = 'done'
                if (tc.name === 'ask_user') run.pendingQuestion = null
              }
              break
            }

            case 'ask_user':
              run.pendingQuestion = {
                interactionId: String(evt.interactionId || ''),
                question: String(evt.question || ''),
                options: Array.isArray(evt.options) ? evt.options.map((v: unknown) => String(v)) : [],
                allowFreeText: evt.allowFreeText !== false,
              }
              break

            case 'done': {
              const finalContent = evt.content || assistantMsg.content
              // 最终落地时再剥一次 <think> 标签，确保历史落盘不含思考标签
              const split = extractThinkSegments(finalContent)
              if (split.reasoning && !assistantMsg.reasoning) {
                assistantMsg.reasoning = split.reasoning
              }
              assistantMsg.content = split.content
              assistantMsg.status = 'done'
              if (assistantMsg.reasoningStatus === 'streaming') {
                assistantMsg.reasoningStatus = 'done'
              }
              break
            }

            case 'error':
              assistantMsg.status = 'error'
              assistantMsg.error = String(evt.error || $t('@AGENT:未知错误'))
              if (assistantMsg.reasoningStatus === 'streaming') {
                assistantMsg.reasoningStatus = 'done'
              }
              break
          }
        }
      }

      if (myNonce !== run.nonce) return

      // 如果 assistant 状态还是 pending（没有任何内容），标记为 done
      if (assistantMsg.status === 'pending') {
        assistantMsg.status = 'done'
      }
    } catch (err: any) {
      if (myNonce !== run.nonce) return
      if (err?.name === 'AbortError' || myController.signal.aborted) {
        assistantMsg.content = (assistantMsg.content || '') + '\n\n[' + $t('@AGENT:已停止') + ']'
        assistantMsg.status = 'done'
        if (assistantMsg.reasoningStatus === 'streaming') {
          assistantMsg.reasoningStatus = 'done'
        }
      } else {
        assistantMsg.status = 'error'
        assistantMsg.error = err?.message || String(err)
        ElMessage.error(assistantMsg.error || $t('@AGENT:对话失败'))
      }
    } finally {
      if (myNonce === run.nonce) {
        run.isStreaming = false
        run.pendingQuestion = null
        run.answeringQuestion = false
        run.abortController = null
      }
      // 清掉乐观徽章；成功路径的 loadSessions() 会拉到服务端真实数据，
      // 中止/出错路径靠这一步兜底，避免左栏一直显示"正在生成中..."
      if (streamSessionId) clearGeneratingSession(streamSessionId)
      // 刷新会话列表：并入仍在后台流的其它会话，并顺带清掉未落盘的幽灵条目
      loadSessions().catch(() => {})
    }
  }

  async function answerQuestion(answer: string) {
    const run = activeRun.value
    const pending = run?.pendingQuestion
    const sessionId = run?.sessionId
    const value = String(answer || '').trim()
    if (!run || !pending || !sessionId || !value || run.answeringQuestion) return false
    run.answeringQuestion = true
    try {
      const res = await fetch('/api/agent/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          interactionId: pending.interactionId,
          answer: value,
        }),
      }).then(r => r.json())
      if (!res.success) throw new Error(res.error || $t('@AGENT:回答提交失败'))
      run.pendingQuestion = null
      return true
    } catch (err: any) {
      ElMessage.error(err?.message || $t('@AGENT:回答提交失败'))
      return false
    } finally {
      run.answeringQuestion = false
    }
  }

  // ── 停止生成（只中止当前激活会话的流，其它后台会话不受影响） ──
  function stop() {
    const run = activeRun.value
    if (run?.abortController) {
      run.abortController.abort()
      run.abortController = null
    }
  }

  return {
    sessions,
    sessionsLoading,
    currentSessionId,
    messages,
    isStreaming,
    sessionLoading,
    pendingQuestion,
    answeringQuestion,
    isSessionGenerating,
    loadSessions,
    loadSession,
    deleteSession,
    renameSession,
    newSession,
    sendMessage,
    answerQuestion,
    stop
  }
}

// useAgentChat — 智能体对话 composable
//
// 职责：
//   1. 会话列表 CRUD（加载 / 删除 / 重命名）
//   2. SSE 流式聊天（thinking / content / tool_call / tool_result / done / error）
//   3. 后端 OpenAI 格式消息 → zen-ai-chat-ui ChatMessage 格式转换
//   4. 取消正在进行的请求

import { reactive, ref } from 'vue'
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

// ── composable ───────────────────────────────────────────
export function useAgentChat() {
  const configStore = useConfigStore()

  // 会话列表
  const sessions = ref<SessionMeta[]>([])
  const sessionsLoading = ref(false)

  // 当前选中的会话
  const currentSessionId = ref<string | null>(null)
  const messages = ref<ChatMessage[]>([])
  const isStreaming = ref(false)
  const sessionLoading = ref(false)

  // SSE 控制
  let abortController: AbortController | null = null
  let runNonce = 0

  // ── 加载会话列表(按当前项目隔离) ─────────────────────
  async function loadSessions() {
    sessionsLoading.value = true
    try {
      // 带上当前项目路径,服务端只返回该项目的会话;
      // 项目路径尚未就绪(socket 未推送)时退化为全量列表
      const cwd = configStore.currentDirectory || ''
      const url = cwd
        ? `/api/agent/sessions?cwd=${encodeURIComponent(cwd)}`
        : '/api/agent/sessions'
      const res = await fetch(url).then(r => r.json())
      if (!res.success) {
        ElMessage.error(res.error || $t('@AGENT:加载会话列表失败'))
        return
      }
      sessions.value = Array.isArray(res.sessions) ? res.sessions : []
    } catch (err: any) {
      ElMessage.error($t('@AGENT:加载会话列表失败') + ': ' + (err?.message || err))
    } finally {
      sessionsLoading.value = false
    }
  }

  // ── 加载会话详情 ────────────────────────────────────────
  async function loadSession(sessionId: string) {
    sessionLoading.value = true
    currentSessionId.value = sessionId
    try {
      const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`).then(r => r.json())
      if (!res.success) {
        ElMessage.error(res.error || $t('@AGENT:加载会话失败'))
        return
      }
      messages.value = convertSessionToMessages(res.session)
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
        messages.value = []
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
      ElMessage.success($t('@AGENT:已重命名'))
    } catch (err: any) {
      ElMessage.error($t('@AGENT:重命名失败') + ': ' + (err?.message || err))
    }
  }

  // ── 新建会话（清空当前状态，首次发消息时后端自动创建） ──
  function newSession() {
    currentSessionId.value = null
    messages.value = []
  }

  // ── 发送消息（SSE 流式） ────────────────────────────────
  async function sendMessage(text: string, files: SelectedFile[] = []) {
    // 组件库允许选任意文件，但多模态消息只支持图片；非图片提示后忽略
    const imageFiles = files.filter(f => f?.file?.type?.startsWith('image/'))
    if (imageFiles.length < files.length) {
      ElMessage.warning($t('@AGENT:仅支持发送图片，非图片文件已忽略'))
    }
    if ((!text.trim() && imageFiles.length === 0) || isStreaming.value) return

    // 图片 File → base64 dataURL，随请求发给后端组装多模态 content
    const settled = await Promise.allSettled(imageFiles.map(f => fileToDataUrl(f.file)))
    const images = settled
      .map(r => (r.status === 'fulfilled' ? r.value : ''))
      .filter(u => u.startsWith('data:image/'))

    const myNonce = ++runNonce
    abortController = new AbortController()
    const myController = abortController

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
    messages.value.push(userMsg)

    // 占位 assistant 消息
    // 注意:必须用 reactive() 包装,否则 push 进 messages.value 后,
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
    messages.value.push(assistantMsg)

    isStreaming.value = true

    // 当前 assistant 消息的工具调用列表（实时更新）
    let currentToolCalls: ToolCall[] = []

    try {
      const resp = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          sessionId: currentSessionId.value || '',
          userMessage: text,
          // 新建会话时服务端用它确定项目归属(已有会话沿用其落盘 cwd)
          cwd: configStore.currentDirectory || '',
          ...(images.length > 0 ? { images } : {})
        }),
        signal: myController.signal
      })

      if (myNonce !== runNonce) return

      if (!resp.ok || !resp.body) {
        const errText = await resp.text().catch(() => '')
        throw new Error(errText || `HTTP ${resp.status}`)
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buf = ''
      let sessionId = currentSessionId.value

      while (true) {
        const { value, done } = await reader.read()
        if (myNonce !== runNonce) return
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
                sessionId = evt.sessionId
                currentSessionId.value = evt.sessionId
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
              }
              break
            }

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
        // 触发响应式更新
        messages.value = [...messages.value]
      }

      if (myNonce !== runNonce) return

      // 如果 assistant 状态还是 pending（没有任何内容），标记为 done
      if (assistantMsg.status === 'pending') {
        assistantMsg.status = 'done'
      }

      // 刷新会话列表（标题可能已更新）
      if (sessionId && sessionId !== currentSessionId.value) {
        currentSessionId.value = sessionId
      }
      loadSessions().catch(() => {})

    } catch (err: any) {
      if (myNonce !== runNonce) return
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
      if (myNonce === runNonce) {
        isStreaming.value = false
        abortController = null
      }
    }
  }

  // ── 停止生成 ────────────────────────────────────────────
  function stop() {
    if (abortController) {
      abortController.abort()
      abortController = null
    }
  }

  return {
    sessions,
    sessionsLoading,
    currentSessionId,
    messages,
    isStreaming,
    sessionLoading,
    loadSessions,
    loadSession,
    deleteSession,
    renameSession,
    newSession,
    sendMessage,
    stop
  }
}

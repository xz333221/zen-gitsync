// useAgentChat — 智能体对话 composable
//
// 职责：
//   1. 会话列表 CRUD（加载 / 删除 / 重命名）
//   2. SSE 流式聊天（thinking / content / tool_call / tool_result / done / error）
//   3. 后端 OpenAI 格式消息 → zen-ai-chat-ui ChatMessage 格式转换
//   4. 取消正在进行的请求

import { ref } from 'vue'
import type { ChatMessage, ToolCall } from 'zen-ai-chat-ui'
import { ElMessage, ElMessageBox } from 'element-plus'
import { uid } from 'zen-ai-chat-ui'
import { $t } from '@/lang/static'

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
      if (typeof m.content === 'string') {
        text = m.content
      } else if (Array.isArray(m.content)) {
        text = m.content.filter(p => p?.type === 'text').map(p => p.text || '').join(' ')
      }
      if (text) {
        result.push({
          id: `msg-${i}`,
          role: 'user',
          content: text,
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

// ── composable ───────────────────────────────────────────
export function useAgentChat() {
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

  // ── 加载会话列表 ────────────────────────────────────────
  async function loadSessions() {
    sessionsLoading.value = true
    try {
      const res = await fetch('/api/agent/sessions').then(r => r.json())
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
  async function sendMessage(text: string) {
    if (!text.trim() || isStreaming.value) return

    const myNonce = ++runNonce
    abortController = new AbortController()
    const myController = abortController

    // 乐观推入 user 消息
    const userMsg: ChatMessage = {
      id: uid(),
      role: 'user',
      content: text,
      status: 'done',
      createdAt: Date.now()
    }
    messages.value.push(userMsg)

    // 占位 assistant 消息
    const assistantMsg: ChatMessage = {
      id: uid(),
      role: 'assistant',
      content: '',
      status: 'pending',
      createdAt: Date.now()
    }
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
          userMessage: text
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
              assistantMsg.content += String(evt.delta || '')
              break

            case 'tool_call_start': {
              const tc: ToolCall = {
                id: evt.toolCallId || uid(),
                name: evt.name || '',
                argsPreview: evt.argsPreview || '',
                arguments: evt.argsPreview || '',
                status: 'running',
                result: ''
              }
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

            case 'done':
              assistantMsg.content = evt.content || assistantMsg.content
              assistantMsg.status = 'done'
              if (assistantMsg.reasoningStatus === 'streaming') {
                assistantMsg.reasoningStatus = 'done'
              }
              break

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

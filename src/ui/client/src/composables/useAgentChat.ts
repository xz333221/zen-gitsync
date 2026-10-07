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
// 计划类工具的预览与渲染判定统一走组件库那份解析（浏览器端与服务端各有一份是刻意的边界）
import { parsePlanArgs, planProgress } from 'zen-ai-chat-ui'
import { $t } from '@/lang/static'
import { useConfigStore } from '@/stores/configStore'
import { useAgentActivityStore } from '@/stores/agentActivity'
import { announceAgentTurn, type AgentTurnKind } from '@/utils/agentTurnNotify'
import {
  getSelectedAgentEngine,
  setSelectedAgentEngine,
  isAgentEngineId,
  type AgentEngineId,
} from '@/utils/agentEngine'

// ── 附件口径 ──────────────────────────────────────────────
// 图片走多模态（转 dataURL 随请求发给模型）；**非图片只在服务端落盘，把绝对路径写进
// 请求副本的 system 提示**，模型需要时自己用 read / grep 读（见 server/utils/agentAttachments.js）。
// 所以这里的 accept 不再是 'image/*' —— 图片之外的类型也能选。
export const AGENT_UPLOAD_ACCEPT = [
  'image/*',
  '.pdf', '.txt', '.md', '.json', '.csv', '.log', '.yml', '.yaml', '.xml', '.toml', '.ini',
  '.html', '.css', '.js', '.ts', '.tsx', '.vue', '.py', '.java', '.go', '.rs', '.sql', '.sh'
].join(',')
/** 单个附件上限（与 server/utils/agentAttachments.js 的 MAX_ATTACHMENT_BYTES 对齐） */
export const MAX_AGENT_ATTACHMENT_BYTES = 10 * 1024 * 1024
/** 单轮附件数量与合计上限（服务端另有同口径校验，这里是为了提前给出提示） */
export const MAX_AGENT_ATTACHMENTS = 10
export const MAX_AGENT_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024

// ── 类型 ──────────────────────────────────────────────────
interface SessionMeta {
  sessionId: string
  title: string
  source: string
  cwd: string
  model: string
  // 跑这个会话的引擎：'gai'（内置，默认）| 'claude' | 'opencode' | 'codex'
  engine?: string
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
  /** 多选：勾选后提交；单选点选项即提交 */
  multiple: boolean
}

// 后端 session 完整数据
interface AgentSession {
  version: number
  sessionId: string
  title: string
  source: string
  cwd: string
  model: string
  // 引擎在会话建立时锁死，中途不可换（服务端会拦 ENGINE_LOCKED）
  engine?: string
  // 外部 CLI 自己的续聊标识；g ai 用不到
  engineSessionId?: string
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

// 每个 useAgentChat 实例一个序号：起流登记令牌里必须能区分是**哪个实例**起的
// —— 四个入口各持一份独立的 runs，同一个 sessionId 完全可能同时在两处跑。
let instanceSeed = 0

// ── 后端消息 → ChatMessage 转换 ──────────────────────────
// 把 OpenAI 格式的消息数组转换为 zen-ai-chat-ui 的 ChatMessage[]
// system 消息被跳过（不展示给用户）
// 一次 AI 回合（工具循环会产生多条 assistant + tool 记录）→ 合并为一条
// assistant 消息：各轮正文拼接，tool_calls 汇总为 ToolCall[]，tool 结果
// 附加到对应 toolCall 的 result
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
      // 工具循环的每一轮都会落成一条独立 assistant 记录（紧随其后是该轮的
      // role:'tool' 结果）。展示时合并到同一条 ChatMessage，才能和实时流式
      // 一致 —— 流式时所有轮次都累加在同一个占位消息上；历史若不合并，
      // 每个工具调用会渲染成独立气泡。
      // 合并范围：从当前 assistant 直到下一个 user/system 消息之前的连续记录。
      const id = `msg-${i}`
      let content = ''
      const toolCalls: ToolCall[] = []

      let j = i
      while (j < msgCount) {
        const cur = session.messages[j]
        if (cur.role !== 'assistant' && cur.role !== 'tool') break

        if (cur.role === 'assistant') {
          if (typeof cur.content === 'string') content += cur.content
          if (cur.tool_calls && cur.tool_calls.length > 0) {
            for (const tc of cur.tool_calls) {
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
        } else {
          // 工具结果挂到对应 toolCall 的 result 上
          const toolCallId = cur.tool_call_id || cur.name || ''
          const tc = toolCalls.find(t => t.id === toolCallId)
          if (tc) {
            // read_image 的 tool 消息是多模态数组(文本 + image_url)。历史里只还原
            // 文本部分 —— 图片本体已经在会话记录里,但对话流的气泡不适合再塞一张
            // base64 大图,而且用户当时是看着模型回答的,不需要回看原图。
            let toolResult: string
            if (typeof cur.content === 'string') toolResult = cur.content
            else if (Array.isArray(cur.content)) {
              toolResult = cur.content
                .filter(p => p?.type === 'text')
                .map(p => p.text || '')
                .join('\n') || '(non-text result)'
            } else toolResult = '(non-text result)'
            if (toolResult.length > MAX_LOG_DISPLAY) {
              toolResult = `…（前文已截断）\n${toolResult.slice(-MAX_LOG_DISPLAY)}`
            }
            tc.result = toolResult
          }
        }
        j++
      }
      // 已合并的记录一并跳过，外层 i++ 后指向下一条未消费消息
      i = j - 1

      // 截断过长内容
      if (content.length > MAX_LOG_DISPLAY) {
        content = `…（前文已截断）\n${content.slice(-MAX_LOG_DISPLAY)}`
      }

      const hasContent = !!content
      const hasToolCalls = toolCalls.length > 0
      if (hasContent || hasToolCalls) {
        result.push({
          id,
          role: 'assistant',
          content,
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
      case 'update_plan': {
        // 计划类:预览用「完成数/总数」而不是 JSON —— 摘要行的定位就是"扫一眼"
        const steps = parsePlanArgs(argsStr, 'update_plan')
        if (!steps) return ''
        const { total, done } = planProgress(steps)
        const why = String(args.explanation || '').replace(/\s+/g, ' ').trim()
        return [`${done}/${total}`, why].filter(Boolean).join(' — ').slice(0, 200)
      }
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
  // 全局活动计数（左侧机器人图标徽标读它）：本实例起的流在起流/收流时登记/销号
  const agentActivity = useAgentActivityStore()
  const instanceId = ++instanceSeed

  // 会话列表
  const sessions = ref<SessionMeta[]>([])
  const sessionsLoading = ref(false)

  // ── 引擎选择 ──────────────────────────────────────────────
  // `pendingEngine` 是"下一次新建会话用哪个引擎"，记在 localStorage（同工作台的临时切换口径）。
  // 已有会话**不用它** —— 引擎在会话建立时锁死，服务端也会拦中途切换（ENGINE_LOCKED）。
  const pendingEngine = ref<AgentEngineId>(getSelectedAgentEngine())
  function pickEngine(id: AgentEngineId) {
    if (!isAgentEngineId(id)) return
    pendingEngine.value = id
    setSelectedAgentEngine(id)
  }

  // 打开过的会话的运行时状态，按 key（真实 sessionId / 未落盘时的本地临时 key）索引
  const runs = reactive(new Map<string, SessionRun>())

  // 当前激活的会话 key
  const currentSessionId = ref<string | null>(null)
  const sessionLoading = ref(false)

  // 会话列表请求计数（防止乱序响应覆盖）；各会话 SSE 用 run.nonce 各自独立
  let sessionsRequestNonce = 0
  let localKeySeed = 0

  // 刚被"停止"、服务端 writeSession 可能还没写完盘的会话：列表刷新时先保留它的条目，
  // 等某次刷新在服务端列表里看到它再交回给服务端数据（见 mergeGeneratingSessions）
  const pendingPersistIds = new Set<string>()

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

  // 当前会话用的引擎。已有会话取它自己落盘的那个；没有会话（或还没落盘的新会话）
  // 取用户选的默认值 —— 这样"新建会话用 g ai，切到 claude 后再新建就是 claude"。
  const currentEngine = computed<AgentEngineId>(() => {
    const meta = sessions.value.find(s => s.sessionId === currentSessionId.value)
    return isAgentEngineId(meta?.engine) ? meta!.engine as AgentEngineId : pendingEngine.value
  })

  /**
   * 引擎是否已被锁死（不能在当前会话里改）。
   *
   * 判据：这条会话**已经落盘过**（左栏列表里存在）。落盘意味着它至少跑过一轮，
   * 而三家的续聊标识互不通用、历史消息格式也不同，中途换引擎只会把上下文搅乱。
   * 此时选择器置灰，要换就新建会话 —— 服务端也做同样的拦截。
   */
  const isEngineLocked = computed(() =>
    sessions.value.some(s => s.sessionId === currentSessionId.value)
  )
  const pendingQuestion = computed<PendingAgentQuestion | null>(() => activeRun.value?.pendingQuestion ?? null)
  const answeringQuestion = computed(() => activeRun.value?.answeringQuestion ?? false)

  // 供会话列表判断某个会话是否正在生成（含后台生成）
  function isSessionGenerating(sessionId: string): boolean {
    return Boolean(runs.get(sessionId)?.isStreaming)
  }

  // ── 加载会话列表(按当前项目隔离) ─────────────────────
  // 服务端只返回已落盘的会话；正在后台流式、以及刚被停止但还没写完盘的会话要补回列表，
  // 否则并发/切会话/点停止时刷新列表会把还在生成的那条"吞掉"。
  function mergeGeneratingSessions(server: SessionMeta[]): SessionMeta[] {
    const merged = [...server]
    for (const run of runs.values()) {
      if (!run.sessionId) continue
      const idx = merged.findIndex(s => s.sessionId === run.sessionId)
      if (idx !== -1) {
        // 服务端已落盘：撤掉待落盘标记，之后完全以服务端数据为准
        pendingPersistIds.delete(run.sessionId)
        if (run.isStreaming) merged[idx] = { ...merged[idx], isGenerating: true }
        continue
      }
      // 停止后的这次刷通常早于服务端 writeSession —— 列表里还没有这条时不能直接丢弃，
      // 否则用户看到的就是"一停止，左栏这条会话就没了"。保留到服务端列表出现为止。
      if (!run.isStreaming && !pendingPersistIds.has(run.sessionId)) continue
      const nowIso = new Date().toISOString()
      merged.unshift({
        sessionId: run.sessionId,
        title: run.title || $t('@AGENT:无标题'),
        source: 'web',
        cwd: configStore.currentDirectory || '',
        model: '',
        engine: pendingEngine.value,
        createdAt: nowIso,
        updatedAt: nowIso,
        messageCount: run.messages.filter(m => m.role === 'user').length || 1,
        size: 0,
        isGenerating: run.isStreaming
      })
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
        engine: pendingEngine.value,
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
  // options.engine：**只在新建会话时生效**的引擎覆盖。默认用当前选择（currentEngine），
  //   传它的是「切换工作目录」弹窗里那块 g ai 追问 —— 那个入口固定用内置 g ai
  //   （见 components/RecentDirectoriesChat.vue），不该被用户在别处选的 claude/codex 带走。
  //   ⚠️ 已有会话仍以服务端落盘的引擎为准，传进来只会被 ENGINE_LOCKED 拦下（本来也不该传）。
  // options.dirStatus / dirSummary：「常用目录」那批目录的 Git 状态与界面上那段自动解读，
  //   服务端只把它注进**本轮请求副本**的 system 提示（不落会话历史，见
  //   server/routes/workbench/agentChat.js 的 injectRequestContext）。
  async function sendMessage(text: string, files: SelectedFile[] = [], options: { openFilePath?: string; engine?: AgentEngineId; dirStatus?: unknown[]; dirSummary?: string; allowDispatch?: boolean; dispatchExecutor?: string; dispatchUseDefaultPrompt?: boolean } = {}) {
    // 图片 → 多模态 dataURL（模型直接"看"）；
    // 非图片 → 字节交给服务端落盘，模型拿到的是**绝对路径**，需要时自己 read。
    const imageFiles = files.filter(f => f?.file?.type?.startsWith('image/'))
    const otherFiles = files.filter(f => !f?.file?.type?.startsWith('image/'))

    // 先按上限筛一遍：超限的当场告知，别让用户以为附件已经发出去了
    const attachable: SelectedFile[] = []
    let attachTotal = 0
    for (const f of otherFiles) {
      const size = f.file.size || 0
      if (size > MAX_AGENT_ATTACHMENT_BYTES) continue
      if (attachable.length >= MAX_AGENT_ATTACHMENTS) break
      if (attachTotal + size > MAX_AGENT_ATTACHMENT_TOTAL_BYTES) break
      attachTotal += size
      attachable.push(f)
    }
    const skipped = otherFiles.filter(f => !attachable.includes(f))
    if (skipped.length > 0) {
      ElMessage.warning(
        `${$t('@AGENT:以下附件超过大小或数量上限，已忽略：')}${skipped.map(f => f.file.name).join('、')}`
      )
    }

    // 目标会话：已有会话用其 id；全新会话先用本地临时 key，等 meta 回来再迁移
    const runKey = currentSessionId.value || `${LOCAL_KEY_PREFIX}${Date.now()}-${++localKeySeed}`
    const run = ensureRun(runKey)
    // 只在"当前激活会话"层面拦截重复发送，不影响其它会话后台继续
    if ((!text.trim() && imageFiles.length === 0 && attachable.length === 0) || run.isStreaming) return

    // 图片 File → base64 dataURL，随请求发给后端组装多模态 content
    const settled = await Promise.allSettled(imageFiles.map(f => fileToDataUrl(f.file)))
    const images = settled
      .map(r => (r.status === 'fulfilled' ? r.value : ''))
      .filter(u => u.startsWith('data:image/'))

    // 非图片同样转 dataURL 上传，但服务端只拿它落盘，内容**不进消息体**（只把路径给模型）
    const attachSettled = await Promise.allSettled(attachable.map(async f => ({
      name: f.file.name || 'file',
      dataUrl: await fileToDataUrl(f.file)
    })))
    const attachments = attachSettled
      .map(r => (r.status === 'fulfilled' ? r.value : null))
      .filter((a): a is { name: string; dataUrl: string } => !!a && typeof a.dataUrl === 'string' && a.dataUrl.startsWith('data:'))

    // 切到这条会话(新会话从 null 切到本地 key)，让乐观消息立刻可见
    currentSessionId.value = run.key

    run.nonce += 1
    const myNonce = run.nonce
    run.abortController = new AbortController()
    const myController = run.abortController
    run.pendingQuestion = null
    run.answeringQuestion = false

    // 乐观推入 user 消息（图片显示缩略图，非图片显示文件名 chip）
    const userMsg: ChatMessage = {
      id: uid(),
      role: 'user',
      content: text,
      status: 'done',
      createdAt: Date.now()
    }
    const chips = [...imageFiles, ...attachable]
    if (chips.length > 0) {
      userMsg.attachments = chips.map(f => ({
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

    // 登记到全局活动计数（ActivityBar 左侧机器人图标上的数字读它）。
    // 令牌 = 实例 + 目标会话 + 本会话第几轮：三者都带上才不会与另一实例 / 另一轮撞号；
    // 下面 finally 里销号，重复销号幂等，被下一轮顶掉时也只减自己那一个。
    const turnToken = `${instanceId}:${runKey}:${myNonce}`
    agentActivity.begin(turnToken)

    // 当前 assistant 消息的工具调用列表（实时更新）
    let currentToolCalls: ToolCall[] = []

    // 本轮实际落盘的会话 ID（meta 事件到达后才有值）
    let streamSessionId: string | null = run.sessionId
    // 本轮是否被用户"停止"中止（中止后的列表刷新要保留条目，见 pendingPersistIds）
    let stoppedByUser = false

    try {
      const resp = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          sessionId: run.sessionId || '',
          userMessage: text,
          // 新建会话时服务端用它确定项目归属(已有会话沿用其落盘 cwd)
          cwd: configStore.currentDirectory || '',
          // 引擎：只在**新建会话**时生效（已有会话服务端沿用自己落盘的那个，
          // 想换会回 ENGINE_LOCKED）。传当前值即可，两种情形都对。
          engine: options.engine ?? currentEngine.value,
          ...(images.length > 0 ? { images } : {}),
          // 非图片附件：服务端落到数据目录后，只把绝对路径写进请求副本的 system 提示
          ...(attachments.length > 0 ? { attachments } : {}),
          // 文件空间对话：把"当前打开的文档"带给服务端（请求级注入上下文，不落会话历史）
          ...(options.openFilePath ? { openFilePath: options.openFilePath } : {}),
          // 常用目录对话：把"那批目录的状态 + 界面上那段解读"带给服务端（同样只进请求副本）
          ...(options.dirStatus?.length ? { dirStatus: options.dirStatus } : {}),
          ...(options.dirSummary ? { dirSummary: options.dirSummary } : {}),
          // 主 Agent 控制台：允许这一轮对话调用 dispatch_task 派发工作台任务，
          // 并把界面上选好的执行器 / 预设提示词勾选一并带上（服务端拿它当工具的默认值）。
          // 只在显式开启时才出现在请求体里 —— 其它入口（智能体页、编辑器面板）的请求
          // 与改造前逐字节一致，它们没有派发能力。
          ...(options.allowDispatch
            ? {
              allowDispatch: true,
              dispatchExecutor: options.dispatchExecutor || '',
              dispatchUseDefaultPrompt: options.dispatchUseDefaultPrompt !== false
            }
            : {})
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
                // 服务端每种工具都发完整 arguments(见 agentChat.js 的 tool_call_start
                // 注释);这里兜底退回摘要,只为老会话 / 字段缺失时不至于空着
                arguments: evt.arguments || evt.argsPreview || '',
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

            // 命令执行中的实时输出：先累加到 toolCall.result 上，界面在运行期间
            // 就能看到命令进度；tool_result 到达后再用带 exit code 的最终结果覆盖
            case 'tool_output': {
              const tc = currentToolCalls.find(t => t.id === evt.toolCallId)
              if (tc) {
                const next = `${tc.result || ''}${String(evt.chunk || '')}`
                tc.result = next.length > MAX_LOG_DISPLAY
                  ? `…（前文已截断）\n${next.slice(-MAX_LOG_DISPLAY)}`
                  : next
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
                multiple: evt.multiple === true,
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
        stoppedByUser = true
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
      // 收尾提示的两个判据必须**在**清 pendingQuestion 之前取：模型 ask_user 时这一轮
      // 并没有结束（SSE 还挂着等回答，见服务端 agentRoutes 的 pendingInteractions），
      // 弹"已完成"是骗人。下面紧接着就把 pendingQuestion 清成 null 了。
      const awaitingAnswer = Boolean(run.pendingQuestion)
      const turnKind: AgentTurnKind = assistantMsg.status === 'error' ? 'error' : 'done'
      // 销号放在最前面、且不看 nonce：这一轮请求**确实**已经结束了（正常 / 出错 / 中止
      // 都走到这里），而同一会话的新一轮有它自己的令牌，不该由我这一轮的收尾去动它。
      agentActivity.end(turnToken)
      if (myNonce === run.nonce) {
        run.isStreaming = false
        run.pendingQuestion = null
        run.answeringQuestion = false
        run.abortController = null
        // 提示音 / 系统通知 / toast 的分流见 utils/agentTurnNotify。
        // 用户自己按的停止不问（人就在页面上点的那一下）；出错那条 catch 里已经弹过
        // ElMessage.error，所以 alreadyToast 传 true，不让同一条错误在页面上弹两遍。
        if (!stoppedByUser && !awaitingAnswer) {
          announceAgentTurn({
            kind: turnKind,
            title: run.title,
            detail: turnKind === 'error' ? (assistantMsg.error || assistantMsg.content) : assistantMsg.content,
            tag: `zen-gitsync-agent-${streamSessionId || run.key}`,
            alreadyToast: turnKind === 'error'
          })
        }
      }
      // 清掉乐观徽章；成功路径的 loadSessions() 会拉到服务端真实数据，
      // 中止/出错路径靠这一步兜底，避免左栏一直显示"正在生成中..."
      if (streamSessionId) {
        // 被停止的轮次服务端仍会落盘，但 writeSession 往往晚于下面这次刷新：
        // 先标记保留这条，别让刚停止的会话从列表里消失
        if (stoppedByUser) pendingPersistIds.add(streamSessionId)
        clearGeneratingSession(streamSessionId)
      }
      // 刷新会话列表：并入仍在后台流的其它会话，并顺带清掉未落盘的幽灵条目
      loadSessions().catch(() => {})
    }
  }

  async function answerQuestion(answers: string[]) {
    const run = activeRun.value
    const pending = run?.pendingQuestion
    const sessionId = run?.sessionId
    const values = (Array.isArray(answers) ? answers : [answers])
      .map(v => String(v ?? '').trim())
      .filter(Boolean)
    if (!run || !pending || !sessionId || !values.length || run.answeringQuestion) return false
    run.answeringQuestion = true
    try {
      const res = await fetch('/api/agent/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          interactionId: pending.interactionId,
          // 单选发字符串、多选发数组；序列化成 JSON 数组字符串回喂模型是服务端的事
          answer: pending.multiple ? values : values[0],
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
    // 引擎选择：currentEngine 是"这次会用的"，isEngineLocked 决定选择器是否置灰
    currentEngine,
    pendingEngine,
    isEngineLocked,
    pickEngine,
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

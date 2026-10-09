// useAgentChat — 智能体对话 composable
//
// 职责：
//   1. 会话列表 CRUD（加载 / 删除 / 重命名）
//   2. SSE 流式聊天（thinking / content / tool_call / tool_result / done / error）
//   3. 后端 OpenAI 格式消息 → zen-ai-chat-ui ChatMessage 格式转换
//   4. 取消正在进行的请求
//   5. 生成中排队：发送先入队，本轮正常跑完自动接下一条；被停止 / 报错则暂停等人续
//      （队列按会话各持一份，UI 在库的输入框条带里，见 queuedMessages / flushQueued）

import { computed, reactive, ref } from 'vue'
import type { ChatMessage, ToolCall, ChatAttachment, SelectedFile, QueuedMessage } from 'zen-ai-chat-ui'
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

/**
 * sendMessage 的第三个参数：这一轮的**请求级**上下文（都不落会话历史）。
 *
 * 队列里存的就是这份快照 —— 排队时界面上选着的引擎 / 打开的文件 / 派发开关，
 * 到真正发出去那一刻可能已经变了，重算一遍等于把用户的意图改掉。
 */
export interface AgentSendOptions {
  /** 文件空间对话：当前打开的文档路径（请求副本的 system 注入） */
  openFilePath?: string
  /** 引擎覆盖：只在新建会话时生效（已有会话由服务端按落盘引擎接管） */
  engine?: AgentEngineId
  /** 常用目录对话：那批目录的 Git 状态 */
  dirStatus?: unknown[]
  /** 常用目录对话：界面上那段自动解读 */
  dirSummary?: string
  /** 主 Agent 控制台：这一轮是否允许调用 dispatch_task 派发任务 */
  allowDispatch?: boolean
  /** 派发用的执行器 */
  dispatchExecutor?: string
  /** 派发时是否附上编排台的预设提示词 */
  dispatchUseDefaultPrompt?: boolean
  /**
   * 内部标记：本次发送要落到哪个会话（默认 = 当前会话）。
   * 队列接棒时必须带上它：用户可能已经切到别的会话，而排队那条是**原会话**的事 ——
   * 不指定的话 sendMessage 会按"当前会话"去找 run，把消息发进别人家的会话。
   */
  targetKey?: string
  /**
   * 内部标记：队列接棒发起的后台轮次。
   * 与用户手发的那一轮有两处不同 —— 落到指定会话（targetKey）、不抢当前视图
   * （用户可能正在看别的会话）。**不进请求体**，服务端看不到它。
   */
  background?: boolean
}

/**
 * 排队中的一条消息：本轮还在跑时用户发的，等这一轮完了再发。
 *
 * 附件存 **File 本体**、请求参数存**发送那一刻的快照**：排队时先转 dataURL /
 * 先落盘的话，用户把这条从队列里删掉就会留下一份孤儿；快照则是为了防止
 * 「排队时选着 A 引擎，轮到它时已经切成 B 引擎」这种悄悄改意图的事。
 */
export interface QueuedAgentMessage {
  id: string
  text: string
  files: SelectedFile[]
  options: AgentSendOptions
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
  /** 每轮用时（服务端与 CLI 两个写入方共用，见 cli/ai/sessionStore.js 的 recordTurnTiming） */
  turnTimings?: AgentTurnTiming[]
}

/**
 * 一轮对话的用时记录。
 *
 * `turnIndex` = 这一轮的 user 消息是会话里的第几条 user 消息（0 基），不是消息数组下标
 * —— 数组还在长，下标会漂。同一序号后写的覆盖先写的（失败轮次会把 user 消息弹掉，
 * 废记录会被复用同一序号的下一轮顶掉）。
 */
interface AgentTurnTiming {
  turnIndex: number
  durationMs: number
  finishedAt?: string
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

  // 每轮用时按"第几条 user 消息"对齐（见 AgentTurnTiming）。同一序号后写的覆盖先写的
  // —— 与服务端 recordTurnTiming 的覆盖规则一致，别一边覆盖一边取第一条。
  const turnTimings = new Map<number, AgentTurnTiming>()
  for (const t of session.turnTimings || []) {
    if (typeof t?.turnIndex !== 'number' || !Number.isFinite(t?.durationMs)) continue
    turnTimings.set(t.turnIndex, t)
  }
  // 已经走过的 user 消息条数 - 1 = 当前这一轮的序号
  let turnIndex = -1

  for (let i = 0; i < msgCount; i++) {
    const m = session.messages[i]

    if (m.role === 'system') continue

    if (m.role === 'user') {
      // 序号在"是否渲染这条气泡"之前就递增：服务端数的是会话里的 user 消息条数，
      // 而**内容为空、不渲染气泡的那条同样占一轮** —— 漏算它后面全错位。
      turnIndex += 1
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
        // 这一轮的用时（工具循环的多条记录合并成一条气泡，仍然是**同一轮**，
        // 与实时流式期间那个占位消息的口径一致）。
        // 时间戳一并补上：历史消息原先写的是 Date.now()（"翻译时刻"而不是"发送时刻"），
        // 有真值就用真值 —— 库优先取 meta.durationMs，其余两个只影响将来可能的展示。
        const timing = turnTimings.get(turnIndex)
        const finishedAt = timing?.finishedAt ? Date.parse(timing.finishedAt) : NaN
        result.push({
          id,
          role: 'assistant',
          content,
          toolCalls: hasToolCalls ? toolCalls : undefined,
          status: 'done',
          createdAt: Number.isFinite(finishedAt) && timing
            ? finishedAt - timing.durationMs
            : Date.now(),
          finishedAt: Number.isFinite(finishedAt) ? finishedAt : undefined,
          meta: timing ? { durationMs: timing.durationMs } : undefined
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

/**
 * 上下文占用（服务端 measureContextUsage 的形状，见 cli/ai/context.js）。
 *
 * `estTokens` 是**估算** —— 请求发出去之前算的（provider 的真实 usage 还没回来）。
 * `actualInputTokens` 是 provider 报回来的真实输入 token，响应到达后才有。
 * UI 优先用真的，没有才退回估算。
 *
 * 为什么要有 `droppedMessages` / `transcriptMessages`：这两个数一起才说得清
 * "为什么会失忆"——磁盘上存着 1766 条，这次请求只带了 39 条，剩下的不是丢了，
 * 是按预算被摘成了梗概。少了它们，进度条满格 100% 反而会让人以为全带上了。
 */
export interface AgentContextUsage {
  /** 请求副本的字符数（附带信息，闸门与显示主口径都是 token） */
  chars: number
  /** 请求副本的 token 估算 —— 主口径 */
  tokens: number
  messages: number
  images: number
  estTokens: number
  maxTokens: number
  maxChars: number
  maxMessages: number
  /** token 占用比0~1（UI 画环用） */
  tokenRatio: number
  messageRatio: number
  transcriptMessages: number
  transcriptChars: number
  droppedMessages: number
  actualInputTokens?: number | null
}

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
  /** 本会话最近一次请求的上下文占用；还没发过消息时为 null */
  contextUsage: AgentContextUsage | null
  /** 排队中的消息：生成中发出的先落在这儿，等本轮结束依次发 */
  queue: QueuedAgentMessage[]
  /**
   * 队列暂停：用户按了「停止」或本轮报错 → 内容原样留着但**不自动发**，
   * 条带上出现「立即发送」等用户拍板（只由它解除）。
   */
  queuePaused: boolean
  /**
   * 本会话最近一次发送的请求级参数（引擎 / 打开的文档 / 派发开关…）。
   * 重试上一轮时原样复用 —— 用户在报错到点重试之间可能改过界面上的选择，
   * 重算一遍等于把那一轮发出去时的东西换掉（与队列存快照同理）。
   */
  lastSendOptions?: AgentSendOptions
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
      answeringQuestion: false,
      contextUsage: null,
      queue: [],
      queuePaused: false
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
  // 上下文占用：随会话走（切换会话时进度条跟着切，不留在上一个会话的数字上）
  const contextUsage = computed<AgentContextUsage | null>(() => activeRun.value?.contextUsage ?? null)

  /**
   * 喂给组件库 `ChatInput.contextUsage` 的形状。
   *
   * 库刻意**不替你算占用率**（见 zen-ai-chat-ui 的 `ContextUsage` 类型注释）——
   * 怎么算取决于业务口径，写死在库里等于逼每个宿主绕开它。所以这一步是
   * 「把自家字段翻译成库的通用形状」，一个字段对一个字段，没有计算。
   *
   * `ratio` 取字符与条数占用的**较大者**：两条是独立闸门，任一撞满都���开始裁剪。
   * 只看字符会漏掉「字符还很空但条数已满」——那正是旧默认值 80k/40 条的形态。
   *
   * 显示用字符（`unit: ''`）而不是 token：预算是按字符定义的，
   * token 只是估算。真实 token 在 hover 的 `detail` 里，不占主视觉。
   */
  const inputContextUsage = computed(() => {
    const u = contextUsage.value
    if (!u) return null
    return {
      ratio: Math.min(Math.max(u.tokenRatio, u.messageRatio), 1),
      current: u.tokens,
      total: u.maxTokens,
      unit: 'K',
      suffix: '上下文已使用',
      detail: [
        `${u.messages} / ${u.maxMessages} 条消息`,
        typeof u.actualInputTokens === 'number' && u.actualInputTokens > 0
          ? `实测 ${u.actualInputTokens.toLocaleString()} token`
          : `估算 ${Math.round(u.estTokens).toLocaleString()} token`,
        u.droppedMessages > 0
          ? `会话共 ${u.transcriptMessages} 条，本次只带入 ${u.messages} 条（其余已摘成梗概）`
          : '',
      ].filter(Boolean).join('\n'),
    }
  })

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

  // ── 排队（生成中继续发） ─────────────────────────────────
  // 队列本体按会话各持一份（见 SessionRun.queue），这里只把当前会话那份翻给 UI。
  const queuePaused = computed(() => activeRun.value?.queuePaused ?? false)

  /**
   * 喂给组件库 `ChatInput.queued` 的形状。
   *
   * 与 `inputContextUsage` 同一个套路：**只翻译，不加逻辑** —— 附件在条带里只需要
   * 文件名（队列本体里的 File 不外给），其余字段一一对应。翻译放这里而不是各个消费方
   * 各写一遍，是为了四个入口（智能体页 / 主 Agent 控制台 / 文件空间面板 / 常用目录弹窗）
   * 显示出来永远一致。
   */
  const queuedMessages = computed<QueuedMessage[]>(() =>
    (activeRun.value?.queue ?? []).map(q => ({
      id: q.id,
      text: q.text,
      attachmentNames: q.files.map(f => f.file.name)
    }))
  )

  /** 从队里移除一条（条带上的 ✕）；队列清空顺带把暂停标记复位 */
  function removeQueuedMessage(id: string) {
    const run = activeRun.value
    if (!run) return
    const i = run.queue.findIndex(q => q.id === id)
    if (i < 0) return
    run.queue.splice(i, 1)
    if (run.queue.length === 0) run.queuePaused = false
  }

  /**
   * 队列接棒：把队首发出去（只在「没在跑」时动手）。
   *
   * 出队即发送 —— 发失败的那一条已经进了对话（能看见错误气泡与重试），不该再压回
   * 队里；它后面那些则因为暂停标记停在原处（见 sendMessage 收尾处的判定）。
   */
  function flushNextQueued(run: SessionRun) {
    if (run.isStreaming) return
    const next = run.queue.shift()
    if (!next) return
    // targetKey 把消息送回它排队的那个会话（用户可能已经看着别的会话了）；
    // background 则保证这一轮不把视图抢过去（见 AgentSendOptions 里两段的说明）
    void sendMessage(next.text, next.files, { ...next.options, targetKey: run.key, background: true })
  }

  /** 用户点了条带上的「立即发送」（暂停态才有）：解除暂停并把队首发出去 */
  function flushQueued() {
    const run = activeRun.value
    if (!run || run.isStreaming || run.queue.length === 0) return
    run.queuePaused = false
    flushNextQueued(run)
  }

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
  async function sendMessage(text: string, files: SelectedFile[] = [], options: AgentSendOptions = {}) {
    // 图片 → 多模态 dataURL（模型直接"看"）；
    // 非图片 → 字节交给服务端落盘，模型拿到的是**绝对路径**，需要时自己 read。
    const imageFiles = files.filter(f => f?.file?.type?.startsWith('image/'))
    const otherFiles = files.filter(f => !f?.file?.type?.startsWith('image/'))

    // 先按上限筛一遍：超限的当场告知，别让用户以为附件已经发出去了。
    // （排队那条路径也走这遍筛选 —— 入队时就给结论，出队时才说"附件被丢了"更莫名其妙）
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

    // 目标会话：已有会话用其 id；全新会话先用本地临时 key，等 meta 回来再迁移。
    // `options.targetKey` 是队列接棒给的（见 AgentSendOptions.targetKey）——
    // 那种时刻"当前会话"是用户眼睛正看着的那个，未必是这条消息该去的那个。
    const runKey = options.targetKey || currentSessionId.value || `${LOCAL_KEY_PREFIX}${Date.now()}-${++localKeySeed}`
    const run = ensureRun(runKey)
    // 只在"当前激活会话"层面拦截重复发送，不影响其它会话后台继续
    if (!text.trim() && imageFiles.length === 0 && attachable.length === 0) return

    // 生成中：不打断这一轮，把这条原样排进队列 —— 本轮结束后由 flushNextQueued 发。
    // 附件留 File 本体、参数留快照（见 QueuedAgentMessage 的注释）；这条不算"发出去"，
    // 所以连 currentSessionId 都不用动（队列本来就是当前会话的）。
    if (run.isStreaming) {
      run.queue.push({ id: uid(), text, files: [...imageFiles, ...attachable], options })
      return
    }

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

    // 切到这条会话(新会话从 null 切到本地 key)，让乐观消息立刻可见。
    // 队列接棒的**后台轮次**不抢视图：用户可能正在别处看着别的会话，替他把屏幕
    // 搬到一个不是他刚操作的地方，是最容易被当成 bug 的那类行为。
    if (!options.background) currentSessionId.value = run.key

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
    // 记住这一轮的请求参数：重试时要原样再来一遍（引擎 / 打开的文档 / 派发开关…），
    // 见 retryTurn。存快照而不是重算 —— 用户在这中间可能改了界面上的选择。
    run.lastSendOptions = options

    // 登记到全局活动计数（ActivityBar 左侧机器人图标上的数字读它）。
    // 令牌 = 实例 + 目标会话 + 本会话第几轮：三者都带上才不会与另一实例 / 另一轮撞号；
    // runStream 的 finally 里销号，重复销号幂等，被下一轮顶掉时也只减自己那一个。
    const turnToken = `${instanceId}:${runKey}:${myNonce}`
    agentActivity.begin(turnToken)

    await runStream(run, myNonce, myController, assistantMsg, turnToken, {
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
    })
  }

  /**
   * 一次流式请求的执行体 —— 新的一轮（sendMessage）与重试上一轮（retryTurn）共用。
   *
   * 两者只有"请求体里带什么"不同：读 SSE、按事件更新那条 assistant 气泡、
   * 收尾（活动计数 / 提示音 / 队列接棒 / 刷新会话列表）逐字一样。
   * 抄第二份的话迟早只改一处 —— 本仓库 agentParity.test.js 就是为这类分叉立的规矩。
   *
   * @param requestBody  POST /api/agent/chat 的请求体（`{ resume: true }` 表示接着上一轮跑）
   */
  async function runStream(
    run: SessionRun,
    myNonce: number,
    myController: AbortController,
    assistantMsg: ChatMessage,
    turnToken: string,
    requestBody: Record<string, unknown>
  ) {
    const userText = String(requestBody.userMessage || '')
    // 当前 assistant 消息的工具调用列表（实时更新）
    let currentToolCalls: ToolCall[] = []

    // 本轮实际落盘的会话 ID（meta 事件到达后才有值）
    let streamSessionId: string | null = run.sessionId
    // 本轮是否被用户"停止"中止（中止后的列表刷新要保留条目，见 pendingPersistIds）
    let stoppedByUser = false
    // 本次尝试的断点：服务端 attempt 事件给的"这一刻气泡里已经有多少内容"。
    // 自动重试时按它回退，只丢掉失败那次尝试吐的字（见 'retry' 分支）。
    let attemptMark: { content: number; reasoning: number; tools: number } | null = null

    try {
      const resp = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(requestBody),
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
            // 上下文占用：每次请求发出前服务端都会发一条（工具循环里每轮都发，
            // 因为上下文在持续增长）。响应回来后可能补一条带 actualInputTokens 的 ——
            // 那是 provider 报的真实输入 token，比估算准，UI 优先显示它。
            case 'context':
              if (evt.usage) run.contextUsage = { ...(run.contextUsage || {}), ...evt.usage }
              break

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
                  userText.trim().split('\n')[0].trim().slice(0, 40) ||
                  $t('@AGENT:无标题')
                if (!run.title) run.title = optimisticTitle
                upsertGeneratingSession(realId, optimisticTitle)
              }
              break

            // 一次 LLM 请求开始（工具循环里每轮一次，自动重试也算新的一次）。
            // 记下"这一刻气泡里已经有多少字 / 多少个工具块"当断点 —— 传输层自动重试时
            // 按它回退，只丢掉失败那次尝试吐的字，本轮前面几轮说过的话、跑过的工具留着。
            case 'attempt':
              attemptMark = {
                content: (assistantMsg.content || '').length,
                reasoning: (assistantMsg.reasoning || '').length,
                tools: assistantMsg.toolCalls?.length ?? 0
              }
              break

            // 传输层正在自动重试（最多 10 次，见 cli/ai/transport.js）：
            // 回退到断点、回到"生成中"，等服务端下一次尝试的增量。
            // 不做这件事的后果是界面上出现"半截答案 + 重来一遍"拼在一起的两段话。
            case 'retry': {
              if (attemptMark) {
                assistantMsg.content = (assistantMsg.content || '').slice(0, attemptMark.content)
                if (assistantMsg.reasoning) {
                  assistantMsg.reasoning = assistantMsg.reasoning.slice(0, attemptMark.reasoning)
                }
                if (assistantMsg.toolCalls && assistantMsg.toolCalls.length > attemptMark.tools) {
                  assistantMsg.toolCalls.length = attemptMark.tools
                  currentToolCalls = [...assistantMsg.toolCalls]
                }
              }
              assistantMsg.status = 'pending'
              assistantMsg.error = ''
              assistantMsg.finishedAt = undefined
              if (assistantMsg.reasoningStatus === 'streaming') {
                assistantMsg.reasoningStatus = 'done'
              }
              // 服务端自己会重试，这条只是让用户知道"它在自愈"，不是要他再点一次
              ElMessage.info($t('@AGENT:连接中断，正在自动重试（{attempt}/{max}）：{reason}', {
                attempt: Number(evt.attempt) || 0,
                max: Number(evt.maxRetries) || 0,
                reason: String(evt.reason || '')
              }))
              break
            }

            case 'thinking':
              if (!assistantMsg.reasoning) {
                assistantMsg.reasoning = ''
                assistantMsg.reasoningStatus = 'streaming'
              }
              // 思考段计时：第一个分片记起点，之后每个分片把终点往前推。
              // ThinkingBlock 靠这两个时间戳在标题右侧显示「思考中 3.2s」，
              // 流式期间实时跳、结束后定格（见 zen-ai-chat-ui 的「思考过程」一节）
              if (typeof assistantMsg.reasoningStartedAt !== 'number') {
                assistantMsg.reasoningStartedAt = Date.now()
              }
              assistantMsg.reasoningEndedAt = Date.now()
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

            // 本轮用时定格：服务端在这条之后才结束响应，所以它总是本轮**最后**到达的增量。
            // 用服务端这个数、而不是前端自己再减一遍 —— 刷新后从会话文件读出来的
            // 就是同一个值（见 convertSessionToMessages），否则同一轮会出现两个用时。
            case 'turn_done': {
              const ms = Number(evt.durationMs)
              if (!Number.isFinite(ms) || ms < 0) break
              if (assistantMsg.meta?.durationMs !== undefined) break
              assistantMsg.finishedAt = Date.now()
              assistantMsg.meta = { ...(assistantMsg.meta || {}), durationMs: ms }
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
        // 用时的兜底：点「停止」会把 fetch 直接掐断，服务端随后补发的 turn_done
        // 根本到不了（响应已经没了）—— 而"这一轮到底跑了多久"正是停下那一刻最想知道的事。
        // 这里用前端自己量的值（发送 → 停止）顶上，与服务端口径只差请求往返那几十毫秒；
        // 重新打开这条会话时读到的是落盘那份。
        if (assistantMsg.meta?.durationMs === undefined) {
          assistantMsg.finishedAt = Date.now()
          assistantMsg.meta = {
            ...(assistantMsg.meta || {}),
            durationMs: assistantMsg.finishedAt - (assistantMsg.createdAt || assistantMsg.finishedAt)
          }
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
        // 队列接棒：**只有这一轮正常跑完**才自动发下一条。
        // 被用户停止 / 本轮报错 → 队列留在原处、置暂停标记：那种时刻用户要的是"别跑了"，
        // 自动接上下一句正好违背它；内容一条不丢，条带上的「立即发送」随时能续。
        if (run.queue.length > 0) {
          if (stoppedByUser || assistantMsg.status === 'error') {
            run.queuePaused = true
          } else if (!awaitingAnswer) {
            flushNextQueued(run)
          }
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

  /**
   * 重试失败的那一轮 —— 错误气泡里那颗「重试」（zen-ai-chat-ui 的 `retry` 事件）。
   *
   * 做法是**接着跑**（请求体 `resume: true`），不是把用户那句话重发一遍：
   * 失败十有八九发生在工具循环中途（比如第二轮请求超时），那时会话尾巴上是
   * "assistant(tool_calls) + 一批 tool 结果"，重发 user 会让模型看到两条同样的请求、
   * 还得把已经跑完的工具再跑一遍。服务端沿用它现有的会话状态，只把最后那次请求重来。
   *
   * 三条边界：
   *   · 只认**最后一轮** —— 服务端的会话状态就挂在这一轮尾巴上，
   *     重试中间的轮次要么重放不了、要么把后面的历史弄乱（库里那颗按钮按消息渲染，
   *     历史里若有旧错误气泡也会显示，这里明确挡掉并说明）。
   *   · 只认**内置 g ai** —— 外部 CLI 每轮都是新起一个进程，服务端手上没有
   *     中途状态可续（服务端也会回 ENGINE_NO_RETRY）。
   *   · 正在跑就不动（服务端另有同会话并发闸）。
   */
  async function retryTurn(message?: ChatMessage): Promise<boolean> {
    const run = activeRun.value
    if (!run || run.isStreaming) return false

    const lastAssistant = [...run.messages].reverse().find(m => m.role === 'assistant')
    const target = (message?.id ? run.messages.find(m => m.id === message.id) : null) || lastAssistant
    if (!target || target.role !== 'assistant') return false
    if (lastAssistant && target.id !== lastAssistant.id) {
      ElMessage.warning($t('@AGENT:只能重试最后一轮'))
      return false
    }

    // 续跑的对象是**服务端那条会话**：连 meta 都没回来过（例如"未配置模型"这种
    // 请求还没进循环就被挡掉的失败）就没有可续的会话，只能让用户重新发。
    if (!run.sessionId) {
      ElMessage.warning($t('@AGENT:这条会话还没在服务端建立，请重新发送消息'))
      return false
    }

    // 会话由哪个引擎跑以**会话**为准（引擎在会话建立时锁死，服务端会拦中途切换）
    const sessionEngine = sessions.value.find(s => s.sessionId === run.sessionId)?.engine
    const engine = (sessionEngine || currentEngine.value) as AgentEngineId
    if (engine !== 'gai') {
      ElMessage.warning($t('@AGENT:该会话由外部 CLI 引擎运行，不支持重试上一轮，请重新发送'))
      return false
    }

    // 回退到"这一轮开始前"：丢掉失败那次尝试吐的内容，保留已经跑过的工具块
    //（它们是这一轮真实干过的事，服务端的会话历史里也有）。
    target.content = ''
    target.reasoning = undefined
    target.reasoningStatus = undefined
    target.reasoningStartedAt = undefined
    target.reasoningEndedAt = undefined
    target.error = ''
    target.status = 'pending'
    target.finishedAt = undefined
    // 用时也必须清掉：turn_done 那条有"已经有了就不覆盖"的保护，
    // 留着上一轮的值会让重试跑完的用时定格在失败那次上。
    if (target.meta) target.meta = { ...target.meta, durationMs: undefined }

    run.nonce += 1
    const myNonce = run.nonce
    run.abortController = new AbortController()
    const myController = run.abortController
    run.pendingQuestion = null
    run.answeringQuestion = false
    run.isStreaming = true

    const turnToken = `${instanceId}:${run.key}:${myNonce}`
    agentActivity.begin(turnToken)
    await runStream(run, myNonce, myController, target, turnToken, {
      sessionId: run.sessionId || '',
      // 服务端看到 resume 就不再压 user 消息，直接接着现有尾巴跑
      resume: true,
      cwd: configStore.currentDirectory || '',
      engine,
      ...(run.lastSendOptions?.openFilePath ? { openFilePath: run.lastSendOptions.openFilePath } : {}),
      ...(run.lastSendOptions?.dirStatus?.length ? { dirStatus: run.lastSendOptions.dirStatus } : {}),
      ...(run.lastSendOptions?.dirSummary ? { dirSummary: run.lastSendOptions.dirSummary } : {}),
      ...(run.lastSendOptions?.allowDispatch
        ? {
          allowDispatch: true,
          dispatchExecutor: run.lastSendOptions.dispatchExecutor || '',
          dispatchUseDefaultPrompt: run.lastSendOptions.dispatchUseDefaultPrompt !== false
        }
        : {})
    })
    return true
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
    // 上下文占用：当前会话最近一次请求的实测/估算值（服务端 measureContextUsage 的形状）
    contextUsage,
    // 组件库 ChatInput 的 `contextUsage` prop 形状（库不替你算，这里做翻译）
    inputContextUsage,
    // 排队：当前会话的队列（库 ChatInput 的 `queued` 形状）+ 暂停态 + 出队/移除/手动接续
    queuedMessages,
    queuePaused,
    removeQueuedMessage,
    flushQueued,
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
    // 重试失败的那一轮（组件库 ChatContainer 的 `retry` 事件 → 四个 g ai 对话入口共用）
    retryTurn,
    answerQuestion,
    stop
  }
}

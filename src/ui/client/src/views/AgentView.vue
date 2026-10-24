<!--
  ~ Copyright 2026 xz333221
  ~
  ~ Licensed under the Apache License, Version 2.0 (the "License");
  ~ you may not use this file except in compliance with the License.
  ~ You may obtain a copy of the License at
  ~
  ~     http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing, software
  ~ distributed under the License is distributed on an "AS IS" BASIS,
  ~ WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  ~ See the License for the specific language governing permissions and
  ~ limitations under the License.
  -->

<!--
  智能体视图：顶部 Tab 切换「对话 / 定时任务 / Skill 广场 / MCP 广场 / 设置」。
  - 对话：左侧会话列表 + 右侧使用 zen-ai-chat-ui 的 ChatContainer 渲染对话
  - 两个广场：按来源展示可安装的 Skill / MCP，装到当前项目或 g ai 智能体
  - 设置：提示词设置（g ai 默认提示词 + 派发任务的提示词，见 AgentPromptSettings.vue）
  - SSE 流式：thinking + content + tool_call + tool_result
  - 会话持久化：后端自动保存到 ~/.zen-gitsync/agent-sessions/
-->
<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount, defineComponent, h } from 'vue'
import { $t } from '@/lang/static'
import { ElIcon } from 'element-plus'
import { Loading } from '@element-plus/icons-vue'
import { ChatContainer, ConversationList } from 'zen-ai-chat-ui'
import 'zen-ai-chat-ui/style.css'
import { useConfigStore } from '@/stores/configStore'
import { useGitStore } from '@/stores/gitStore'
import { useAgentChat, AGENT_UPLOAD_ACCEPT } from '@/composables/useAgentChat'
import { buildConversationItems, agentConversationLabels, agentQuestionLabels, agentQueueLabels, AGENT_ASSISTANT_NAME, AGENT_ASSISTANT_AVATAR, MESSAGE_RAIL_CONFIG, MESSAGE_META_CONFIG } from '@/utils/agentConversations'
import { resolveAgentPresets } from '@/utils/agentPresets'
import { subscribeScheduleEvents } from '@/utils/scheduleApi'
import { agentEngineName, type AgentEngineId } from '@/utils/agentEngine'
import { useNarrowPane } from '@/composables/useNarrowPane'
import { useConvListCollapse } from '@/composables/useConvListCollapse'
import MarketplacePanel from '@/components/MarketplacePanel.vue'
import SchedulePanel from '@/components/SchedulePanel.vue'
import AgentPromptSettings from '@/components/AgentPromptSettings.vue'
import AgentEngineSelector from '@/components/AgentEngineSelector.vue'
import CopySessionButton from '@/components/CopySessionButton.vue'
import ChatSilenceBadge from '@/components/ChatSilenceBadge.vue'

const props = defineProps<{
  /**
   * dock 传入：编辑器当前激活文件路径（绝对或相对都行，服务端会归一化）。
   * 整合前这是 EditorAgentPanel 的 activeFilePath —— 文件空间的对话靠它把
   * 「当前打开的文档」带给模型；入口收拢到右下角 dock 后由这里接管。
   */
  contextFilePath?: string
  /** 当前激活文件名（只用于输入区那张上下文小卡） */
  contextFileName?: string
}>()

const configStore = useConfigStore()
const gitStore = useGitStore()

// ── 面板宽度：够窄就把「会话列表」和「对话」折成两个页面 ──────────
// 量的是这个视图容器自己的宽度（窄屏下拖动侧栏 / 分屏都会变；视口宽度反映不了）。
const rootRef = ref<HTMLElement | null>(null)
const { width, narrow } = useNarrowPane(rootRef)
/**
 * 头部至少这么宽才摆「静默 x 秒」。
 *
 * 这一行已经站着五个 Tab + 引擎选择器 + 复制按钮；再加一枚 ~90px 的徽标，
 * 900px 以下 Tab 文字就会被压得折行（导航条突然长高一倍，比少一条提示更糟）。
 * 扣掉左侧会话列（240px）之后 ≈ 860px，够放下整行。
 */
const TABS_SILENCE_MIN_WIDTH = 1100
/**
 * 再窄就把 Tab 行压成「图标 + tooltip」紧凑态：5 个文字 tab + 引擎选择器 + 复制按钮
 * 在 640px 以下放不下（文字会被压折行，导航条突然长高一倍）。
 * dock 默认面板 560px 恒触发；最大化（≥680）恢复完整文字态。
 */
const TABS_COMPACT_MAX_WIDTH = 640
const tabsCompact = computed(() => width.value > 0 && width.value < TABS_COMPACT_MAX_WIDTH)
/** 窄屏下的当前页。宽屏两栏并排时用不到它 */
const chatPage = ref<'list' | 'chat'>('chat')

// ── 顶部 Tab ─────────────────────────────────────────────
// 会话列表只在「对话」Tab 显示 —— 广场/定时任务/设置占满宽度更好浏览;
// 两个广场共用一个 MarketplacePanel 实例,切类型时组件内部自己重拉数据。
type AgentTab = 'chat' | 'schedule' | 'skill' | 'mcp' | 'settings'
const activeTab = ref<AgentTab>('chat')
const marketplaceType = computed(() => (activeTab.value === 'mcp' ? 'mcp' : 'skill'))

/** Tabler 图标（MIT）→ el-icon 可消费的组件（tabs 数组原来直接放 EP 图标组件，
 *  换成官方线稿后保持同一形态：`<component :is="tab.icon" />` 不用动） */
const tablerIcon = (...paths: string[]) => defineComponent({
  render: () => h('svg', {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  }, paths.map((d) => h('path', { d }))),
})

const tabs = computed(() => [
  { id: 'chat' as const, label: $t('@AGENT:对话'), icon: tablerIcon(
    'M12 11v.01', 'M8 11v.01', 'M16 11v.01',
    'M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-5l-5 3v-3h-2a3 3 0 0 1-3-3v-8a3 3 0 0 1 3-3l12 0',
  ) },
  { id: 'schedule' as const, label: $t('@AGENT:定时任务'), icon: tablerIcon(
    'M5 13a7 7 0 1 0 14 0a7 7 0 0 0-14 0', 'M14.5 10.5l-2.5 2.5', 'M17 8l1-1', 'M14 3h-4',
  ) },
  { id: 'skill' as const, label: $t('@AGENT:Skill 广场'), icon: tablerIcon(
    'M6.331 8h11.339a2 2 0 0 1 1.977 2.304l-1.255 8.152a3 3 0 0 1-2.966 2.544h-6.852a3 3 0 0 1-2.965-2.544l-1.255-8.152a2 2 0 0 1 1.977-2.304',
    'M9 11v-5a3 3 0 0 1 6 0v5',
  ) },
  { id: 'mcp' as const, label: $t('@AGENT:MCP 广场'), icon: tablerIcon(
    'M7 12l5 5l-1.5 1.5a3.536 3.536 0 1 1-5-5l1.5-1.5', 'M17 12l-5-5l1.5-1.5a3.536 3.536 0 1 1 5 5l-1.5 1.5',
    'M3 21l2.5-2.5', 'M18.5 5.5l2.5-2.5', 'M10 11l-2 2', 'M13 14l-2 2',
  ) },
  // 设置放最后：它是配置项，不是日常入口。里面目前只有提示词设置
  //（两块：g ai 默认提示词 + 派发任务的提示词，见 AgentPromptSettings.vue）
  { id: 'settings' as const, label: $t('@AGENT:设置'), icon: tablerIcon(
    'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37c1 .608 2.296.07 2.572-1.065',
    'M9 12a3 3 0 1 0 6 0a3 3 0 0 0-6 0',
  ) },
])

const {
  sessions,
  sessionsLoading,
  currentSessionId,
  messages,
  // 展示用：正文里嵌的本机图片路径已改写成会话图片端点（见 useAgentChat 的注释）。
  // 「复制会话」那边仍传原始 messages —— 导出要的是模型写的原文，不是端点 URL。
  displayMessages,
  isStreaming,
  sessionLoading,
  loadSessions,
  loadSession,
  deleteSession,
  renameSession,
  newSession,
  sendMessage,
  retryTurn,
  questionPanel,
  answeringQuestion,
  answerQuestion,
  isSessionGenerating,
  currentEngine,
  pendingEngine,
  isEngineLocked,
  pickEngine,
  stop,
  inputContextUsage,
  queuedMessages,
  queuePaused,
  removeQueuedMessage,
  flushQueued,
  // 本轮静默时长（毫秒）；头部那枚「静默 x 秒」读它，口径见 ChatSilenceBadge
  silentMs
} = useAgentChat()

// ── 引擎选择 ──────────────────────────────────────────────
// 展示哪个：已有会话显示它自己的引擎，没有会话显示"下次新建会用哪个"。
// 下拉本体、可用性映射、未安装→安装弹窗都收口在 AgentEngineSelector 里
//（文件空间 g ai 面板同一处消费，免得同一套实现抄两遍）。
const displayEngine = computed(() => (isEngineLocked.value ? currentEngine.value : pendingEngine.value))

function handleEngineSelect(id: AgentEngineId) {
  // 已落盘的会话不允许中途换引擎（服务端也会拦），要换必须新建会话
  if (isEngineLocked.value) return
  pickEngine(id)
}

// ── 主题 ──────────────────────────────────────────────────
const chatTheme = computed<'light' | 'dark'>(() => {
  const t = configStore.theme
  if (t === 'dark') return 'dark'
  if (t === 'auto') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'light'
})

// ── 输入框工具条上的「分支 + 模型」展示片 ──────────────────
// 与工作台 g ai 面板（AgentChatSurface）、App.vue 底栏同一口径：
// 分支读 gitStore.currentBranch（App 首次加载已强制拉取，切目录时 DirectorySelector 会刷新），
// 模型读设置里标了「默认」的那一条。读不到就传 undefined —— 工具条那一片不渲染，
// 不显示"未知"占位（库的 prop 默认空串同样不渲染）。
const inputModelName = computed(() => {
  const m = configStore.models.find((x: any) => x.isDefault)
  if (!m) return ''
  return m.name || m.model || ''
})

// ── 会话列表数据（喂给组件库的 ConversationList，映射逻辑与文件空间面板共用） ──
const conversationItems = computed(() => buildConversationItems(sessions.value, isSessionGenerating))
const conversationLabels = agentConversationLabels()

/** 窄屏对话页顶部返回条上的标题：直接取当前会话在列表里的那条（标题兜底/截断规则与列表一致） */
const currentSessionTitle = computed(
  () => conversationItems.value.find(i => i.id === currentSessionId.value)?.title || $t('@AGENT:对话')
)

// ── 欢迎区品牌图标 ─────────────────────────────────────
// 组件库把欢迎区 logo 写死成内联 SVG（没有 prop / 插槽可换），只能把那个 div
// 改造成图片盒子，背景图走这里。SVG 被 vite 内联成 data URI，而它内部含单引号
// （xmlns='...'），所以外层必须用**双引号**包 url() —— 用单引号会被 data URI
// 里的第一个单引号截断，整条 background 声明作废（实测 bgImage=none，图标空白）。
const welcomeAvatarStyle = { '--welcome-avatar': `url("${AGENT_ASSISTANT_AVATAR}")` }

// ── 当前文档上下文卡：锚点插进库输入框容器，和附件同处一行 ────────
// 与 EditorAgentPanel 同一套形状（那里是文件空间面板的常住实现）：组件库的
// ChatContainer / ChatInput 没有任何插槽，只能往 `.acu-input-wrap` 插一个空锚点，
// 再把卡片 Teleport 进去（节点仍由 Vue 渲染）。锚点是动态创建的、没有 scoped 属性，
// 定位规则走 :deep()（见 <style>）。dock 在编辑器视图激活时经 props 传入当前文件。
const chatHostRef = ref<HTMLElement | null>(null)
const contextSlot = ref<HTMLElement | null>(null)
/** 用户点了卡片上的 ✕：本轮不把当前文档带给模型（切换文档时恢复） */
const contextDismissed = ref(false)
let slotObserver: MutationObserver | null = null

const showContextCard = computed(() => !!props.contextFileName && !contextDismissed.value)

/** 库里真附件行的容器（.acu-input-attachments）—— 没有附件时库不渲染它 */
function findAttachmentsHost(wrap: HTMLElement): HTMLElement | null {
  return (Array.from(wrap.children).find(c =>
    (c as HTMLElement).classList?.contains('acu-input-attachments')
  ) as HTMLElement | undefined) ?? null
}

/**
 * 让锚点落到正确的宿主里（两种形态与 EditorAgentPanel 一致）：
 *   · 有附件行 → 住进 `.acu-input-attachments`，卡片就是那一行的 flex item，与附件并排；
 *   · 没附件行 → 自己待在输入框最前面（样式复刻成同一行的样子）。
 * ChatContainer 自带输入框，锚点在 .agent-chat-host 里找 `.acu-input-wrap`。
 */
function syncContextSlot() {
  const wrap = chatHostRef.value?.querySelector('.acu-input-wrap') as HTMLElement | null | undefined
  if (!wrap) return

  const existing = wrap.querySelector('.agent-context-slot') as HTMLElement | null

  // 不该显示（没打开文档 / 用户点了 ✕）：把锚点摘干净，别在输入框里留一行空白
  if (!showContextCard.value) {
    if (!existing) return
    contextSlot.value = null          // 先让 Teleport 卸载卡片
    nextTick(() => existing.remove()) // 再摘锚点（等 Vue 把卡片节点收走）
    return
  }

  let slot = contextSlot.value && wrap.contains(contextSlot.value) ? contextSlot.value : existing
  if (!slot) {
    slot = document.createElement('div')
    slot.className = 'agent-context-slot'
  }

  const attachments = findAttachmentsHost(wrap)
  const host = attachments ?? wrap
  if (slot.parentElement !== host) {
    host.insertBefore(slot, attachments ? attachments.firstChild : wrap.firstChild)
  }

  contextSlot.value = slot
}

/** 锚点住在那条输入框里，盯着它：库在有/无附件时会动态增删附件行，锚点得跟着搬进搬出 */
function watchChatDom() {
  const host = chatHostRef.value
  if (!host || typeof MutationObserver === 'undefined') return
  slotObserver?.disconnect()
  slotObserver = new MutationObserver(() => syncContextSlot())
  slotObserver.observe(host, { childList: true, subtree: true })
}

onMounted(() => {
  nextTick(() => {
    syncContextSlot()
    watchChatDom()
  })
})

onBeforeUnmount(() => {
  slotObserver?.disconnect()
  slotObserver = null
  // 锚点是插进库 DOM 的，随组件一起卸载；这里只清引用，别去 remove
  contextSlot.value = null
})

// 换了个打开的文档 → 之前点掉的 ✕ 作废，新的文档要重新带上下文
watch(() => props.contextFilePath, () => {
  contextDismissed.value = false
})

// 没打开文档 / 又打开了 → 让锚点跟着来去（MutationObserver 只负责"位置"，不负责"有没有"）
watch(showContextCard, (show) => {
  if (show) nextTick(syncContextSlot)
})

// ── 预设问题 ──────────────────────────────────────────────
// 内容可配（设置 → AI 模型配置 → 预设提示词）：configStore 里有自定义用自定义，
// 否则回落 utils/agentPresets 的内置默认（原先是这里硬编码的 5 条）。
// computed 依赖 store，改完设置回来看欢迎页即时生效，不需要新开会话或刷新。
const presetQuestions = computed(() => resolveAgentPresets(configStore.agentPresetPrompts))

// ── 发送消息 ──────────────────────────────────────────────
// 编辑器视图激活时把「当前打开的文档」一起发给服务端（请求级注入，不落会话历史，
// 与旧文件空间面板同口径）。点过上下文卡上的 ✕ 就不带 —— 与"移除一个附件"同义。
async function onSend(payload: { text: string; files: any[] }) {
  const openFilePath = contextDismissed.value ? undefined : (props.contextFilePath || undefined)
  await sendMessage(payload.text, payload.files, openFilePath ? { openFilePath } : undefined)
  await nextTick()
  scrollToBottom()
}

// ── 预设问题点击 ──────────────────────────────────────────
async function onSelectPreset(q: any) {
  await sendMessage(q.prompt)
  await nextTick()
  scrollToBottom()
}

// ── 提问面板文案（面板 UI 在 zen-ai-chat-ui 里，这里只负责翻译；与文件空间面板共用映射） ──
const questionLabels = agentQuestionLabels()

// ── ChatContainer ref ────────────────────────────────────
const chatContainerRef = ref<InstanceType<typeof ChatContainer> | null>(null)

// ── 排队条带文案（与主 Agent 控制台 / 文件空间面板共用同一份映射） ──
const queueLabels = agentQueueLabels()

function scrollToBottom(smooth = true) {
  chatContainerRef.value?.scrollToBottom(smooth)
}

// 监听消息变化自动滚动到底部
watch(() => messages.value.length, () => {
  nextTick(() => scrollToBottom(false))
})

// ── 选中会话 ──────────────────────────────────────────────
// 可随时切换：正在生成的会话在后台继续跑，切回来能看到实时进度。
// 窄屏下顺带切到对话页 —— 在列表页点了会话却停在原地，等于没反应。
function selectSession(sessionId: string) {
  loadSession(sessionId)
  chatPage.value = 'chat'
}

// ── 定时任务面板「查看会话」────────────────────────────────
// 切回对话 Tab 并打开该任务的专属会话 —— 执行结果都在那里面，这是看结果的唯一入口。
// 窄屏顺带切到对话页（否则还停在列表页）。
function handleScheduleOpenSession(sessionId: string) {
  if (!sessionId) return
  activeTab.value = 'chat'
  selectSession(sessionId)
}

// ── 新建会话 ──────────────────────────────────────────────
function handleNewSession() {
  newSession()
  chatPage.value = 'chat'
}

// ── 侧边栏宽度拖拽 ────────────────────────────────────────
const sidebarWidth = ref(280)
const isResizing = ref(false)

/**
 * 会话列表收起 / 展开。收起时左栏只剩组件库那条收纳条（宽度见 CONV_RAIL_WIDTH），
 * 拖拽分隔条随之隐藏 —— 40px 的收纳条没有可拖的余地，留着只会误触。
 * 状态与主 Agent 控制台、文件空间 g ai 面板共用一份（见 useConvListCollapse）。
 */
const { convListCollapsed, setConvListCollapsed } = useConvListCollapse()
/**
 * 收起时的列宽：收纳条（图标 + 竖排文案）在 40px 里放得下，再窄就只剩图标。
 * 与另两个入口（主 Agent 控制台 / 文件空间面板）的 `.is-convs-collapsed` 取同一个数 ——
 * 三处是同一个控件，宽度不一样会显得像两个东西。
 */
const CONV_RAIL_WIDTH = 40

function startResize(e: MouseEvent) {
  if (convListCollapsed.value) return
  isResizing.value = true
  const startX = e.clientX
  const startWidth = sidebarWidth.value

  const onMove = (ev: MouseEvent) => {
    const delta = ev.clientX - startX
    const newWidth = Math.max(200, Math.min(500, startWidth + delta))
    sidebarWidth.value = newWidth
  }

  const onUp = () => {
    isResizing.value = false
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// ── 变宽后回到对话页 ──────────────────────────────────────
// 两栏重新出现时列表已经能同时看到，没必要再停在列表页 ——
// 否则下次变窄会莫名其妙地「一进来就是列表」。
watch(narrow, (isNarrow) => {
  if (!isNarrow) chatPage.value = 'chat'
})

// ── 项目切换:会话列表按项目隔离 ──────────────────────────
// currentDirectory 变化(socket 推送 / 启动后异步就绪)时重新拉取;
// 流式生成期间不打断，结束后再次检查并清掉不属于新项目的旧会话。
// 注意: 流式刚结束时也要先 await loadSessions() 再做清理判断——
// 新会话的 meta 事件在流式期间就把 currentSessionId 置上了, 若不先
// 刷新列表, sessions 还是旧的(不含新会话), 会误判"当前会话不属于本项目"
// 把刚回答完的对话直接清掉(新建会话发第一条消息后被自动关闭的根因)。
watch(() => [configStore.currentDirectory, isStreaming.value] as const, async ([cwd, streaming], previous) => {
  const dirChanged = !previous || cwd !== previous[0]
  const streamJustFinished = !!previous && previous[1] === true && !streaming
  if (dirChanged || streamJustFinished) await loadSessions()
  if (currentSessionId.value && !isStreaming.value &&
      !sessions.value.some(s => s.sessionId === currentSessionId.value)) {
    newSession()
  }
}, { immediate: true })

// ── 定时任务跑完 → 顺手刷新会话列表 ────────────────────────
// 调度器在后台把这一轮写进任务的会话（专属会话续写；sessionMode=new 则每次新建一条），
// 前端这边一条通知都没有 —— 左栏会一直停在打开页面时那份，用户得手动刷新才看得见新会话。
// 复用定时任务面板那个事件源（/api/schedules/events），跑完就重拉一次。
// 只认 task_finished：task_started 那一刻会话还没落盘，拉了也是旧数据。
let disposeScheduleEvents: (() => void) | null = null
onMounted(() => {
  disposeScheduleEvents = subscribeScheduleEvents((evt) => {
    if (evt.type === 'task_finished') loadSessions().catch(() => {})
  })
})
onBeforeUnmount(() => {
  disposeScheduleEvents?.()
  disposeScheduleEvents = null
})

/**
 * 外部入口（目前只有 Git 视图「AI 项目状态解读」下面的追问 chips）：把问题发进对话。
 * 与服务端口径同旧追问区：问题卡的 prompt 与用户手输的文本没有区别，
 * 带 dirStatus/dirSummary 时固定 g ai 引擎 + 目录上下文。
 */
defineExpose({
  async askQuestion(text: string, ctx?: { dirStatus?: unknown[]; dirSummary?: string }) {
    activeTab.value = 'chat'
    chatPage.value = 'chat'
    await sendMessage(text, [], ctx
      ? { engine: 'gai', dirStatus: ctx.dirStatus, dirSummary: ctx.dirSummary }
      : undefined)
    await nextTick()
    scrollToBottom()
  },
})
</script>

<template>
  <div ref="rootRef" class="agent-view">
    <!-- ═══ 宽屏：左侧会话列表（只在「对话」Tab 显示）═══
         窄屏时这一整块不渲染，会话列表改成 body 里的一个整页（见 .agent-list-page）。
         v-show 而非 v-if：切到定时/广场再回来，列表的滚动位置不丢（display:none
         不占 flex 空间，布局与 v-if 逐像素一致）。 -->
    <aside
      v-show="activeTab === 'chat' && !narrow"
      class="agent-sidebar"
      :class="{ 'is-convs-collapsed': convListCollapsed }"
      :style="{ width: (convListCollapsed ? CONV_RAIL_WIDTH : sidebarWidth) + 'px' }"
    >
    <!-- 会话列表：UI 与交互都在组件库的 ConversationList 里（含收起 / 展开） -->
    <ConversationList
      class="agent-conversations"
      :items="conversationItems"
      :active-id="currentSessionId"
      :loading="sessionsLoading"
      :labels="conversationLabels"
      collapsible
      :collapsed="convListCollapsed"
      @update:collapsed="setConvListCollapsed"
      @select="selectSession"
      @new="handleNewSession"
      @rename="renameSession"
      @delete="deleteSession"
    />
    </aside>

    <!-- 拖拽分隔条（收起时藏起来：40px 的收纳条没有可拖的余地） -->
    <div
      v-show="activeTab === 'chat' && !narrow && !convListCollapsed"
      class="sidebar-resizer"
      @mousedown="startResize"
      :class="{ active: isResizing }"
    ></div>

    <!-- ═══ 右侧：Tab 栏 + 内容区 ═══ -->
    <main class="agent-chat-area">
      <nav class="agent-tabs" role="tablist">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          class="agent-tab"
          :class="{ active: activeTab === tab.id }"
          role="tab"
          :aria-selected="activeTab === tab.id"
          :title="tab.label"
          :aria-label="tab.label"
          @click="activeTab = tab.id"
        >
          <el-icon><component :is="tab.icon" /></el-icon>
          <!-- 紧凑态（dock 默认 560px 面板）只留图标，文字进 tooltip；
               最大化后宽度 ≥680，恢复完整文字 tab -->
          <span v-if="!tabsCompact">{{ tab.label }}</span>
        </button>

        <!-- ═══ 引擎选择器 ═══
             与工作台执行器下拉同一套交互（点击展开、未安装标出来、点了直接开安装弹窗）。
             下拉本体收口在 AgentEngineSelector，文件空间 g ai 面板复用同一份实现。
             会话一旦落盘就置灰：引擎在会话建立时锁定（三家续聊标识互不通用），要换请新建。 -->
        <AgentEngineSelector
          v-if="activeTab === 'chat'"
          class="agent-engine"
          :engine="displayEngine"
          :locked="isEngineLocked"
          @select="handleEngineSelect"
        />

        <!-- 复制整条会话（默认精简范围，小箭头可选全量）——与工作台的「复制执行内容」同一套口径 -->
        <CopySessionButton
          v-if="activeTab === 'chat' && !tabsCompact"
          class="agent-copy"
          :messages="messages"
          :title="currentSessionTitle"
          :engine="agentEngineName(displayEngine)"
        />

        <!-- 本轮静默：挂在 Tab 行最右端（与引擎 / 复制同一条右对齐线）。
             等回答时不算静默 —— 那一轮挂着是在等用户点选项（见 ChatSilenceBadge 文件头）。
             紧凑态（dock 默认 560px 面板）也显示：图标行的剩余宽度放得下这枚 ~90px
             徽标，而「静默 N 秒」正是用户盯着面板时最需要的信号；TABS_SILENCE_MIN_WIDTH
             那条 1100px 门槛是给整行文字 tab 定的，紧凑行不适用。 -->
        <ChatSilenceBadge
          v-if="activeTab === 'chat' && (tabsCompact || width >= TABS_SILENCE_MIN_WIDTH)"
          class="agent-silence"
          :silent-ms="silentMs"
          :streaming="isStreaming && !questionPanel"
        />
      </nav>

      <div class="agent-tab-body">
        <!-- ── 对话 ── -->
        <div v-if="activeTab === 'chat'" class="agent-chat-pane">
          <!-- 窄屏 · 会话列表页：列表独占整页 -->
          <div v-if="narrow && chatPage === 'list'" class="agent-list-page">
            <ConversationList
              class="agent-conversations"
              :items="conversationItems"
              :active-id="currentSessionId"
              :loading="sessionsLoading"
              :labels="conversationLabels"
              @select="selectSession"
              @new="handleNewSession"
              @rename="renameSession"
              @delete="deleteSession"
            />
          </div>

          <!-- 对话页（窄屏时顶上多一条返回条；宽屏左侧就摆着列表，不需要） -->
          <template v-else>
            <div v-if="narrow" class="agent-page-bar">
              <button
                type="button"
                class="agent-page-back"
                :title="$t('@AGENT:返回会话列表')"
                :aria-label="$t('@AGENT:返回会话列表')"
                @click="chatPage = 'list'"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
                </svg>
              </button>
              <span class="agent-page-title">{{ currentSessionTitle }}</span>
            </div>

            <!--
              对话宿主：单独开一层裁剪边界。
              欢迎页在矮/窄窗口里会比可用高度还高，而它是垂直居中的 —— 溢出的部分
              会**向上**跑出 .acu-chat，盖到刚加的返回条上（把返回条的点击也一起吃掉，
              e2e 实测就是这个症状）。宿主的 overflow:hidden 把它裁在自己这一格里。
            -->
            <div
              class="agent-chat-host"
              ref="chatHostRef"
              :style="welcomeAvatarStyle"
            >
              <!-- 加载中 -->
              <div v-if="sessionLoading" class="chat-loading">
                <el-icon class="is-loading" :size="32"><Loading /></el-icon>
                <span>{{ $t('@AGENT:加载会话中...') }}</span>
              </div>

              <!-- ChatContainer -->
              <ChatContainer
                v-else
                ref="chatContainerRef"
                :messages="displayMessages"
                :preset-questions="presetQuestions"
                :welcome-title="$t('@AGENT:智能体助手')"
                :welcome-description="$t('@AGENT:我可以帮你阅读代码、执行命令、修改文件。选择下方话题或直接输入你的问题。')"
                :assistant-name="AGENT_ASSISTANT_NAME"
                :assistant-avatar="AGENT_ASSISTANT_AVATAR"
                :theme="chatTheme"
                :generating="isStreaming"
                :allow-queue="true"
                :queued="queuedMessages"
                :queue-paused="queuePaused"
                :queue-labels="queueLabels"
                :upload-config="{ accept: AGENT_UPLOAD_ACCEPT }"
                :context-usage="inputContextUsage"
                :git-branch="gitStore.currentBranch || undefined"
                :model="inputModelName || undefined"
                :placeholder="isStreaming ? $t('@AGENT:生成中，发送后会排队，等本轮跑完自动接上…') : $t('@AGENT:输入消息，Enter 发送')"
                :question="questionPanel"
                :question-submitting="answeringQuestion"
                :question-labels="questionLabels"
                :plan-config="{ labels: { title: $t('@AGENT:计划'), raw: $t('@AGENT:原始参数') } }"
                :message-rail-config="MESSAGE_RAIL_CONFIG"
                :message-meta-config="MESSAGE_META_CONFIG"
                @send="onSend"
                @select="onSelectPreset"
                @stop="stop"
                @unqueue="removeQueuedMessage"
                @flush-queued="flushQueued"
                @answer="answerQuestion"
                @retry="retryTurn"
              >
              </ChatContainer>
            </div>
          </template>

          <!--
            当前文档上下文卡：与添加的附件同处一行、同一副样子。
            组件库的 ChatContainer / ChatInput 没有任何插槽，只能往 `.acu-input-wrap`
            插一个锚点（syncContextSlot 负责），再把卡片 Teleport 进去；
            有附件行时锚点住进它内部，卡片就是那一行的 flex item（详见 script 里那段）。
          -->
          <Teleport v-if="contextSlot" :to="contextSlot">
            <div v-if="showContextCard" class="agent-context-att" :title="props.contextFilePath || ''">
              <svg class="agent-context-att-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 3 14 8 19 8"/>
              </svg>
              <span class="agent-context-att-name">{{ props.contextFileName }}</span>
              <button
                type="button"
                class="agent-context-att-remove"
                :title="$t('@EDITOR:不引用当前文档')"
                :aria-label="$t('@EDITOR:不引用当前文档')"
                @click="contextDismissed = true"
              >
                <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          </Teleport>
        </div>

        <!-- ── 定时任务 ── -->
        <SchedulePanel
          v-else-if="activeTab === 'schedule'"
          @open-session="handleScheduleOpenSession"
        />

        <!-- ── Skill 广场 / MCP 广场 ── -->
        <MarketplacePanel v-else-if="activeTab === 'skill' || activeTab === 'mcp'" :type="marketplaceType" />

        <!-- ── 设置（提示词设置）── -->
        <AgentPromptSettings v-else />
      </div>
    </main>
  </div>
</template>

<style scoped lang="scss">
.agent-view {
  display: flex;
  height: 100%;
  min-height: 0;
  background: var(--bg-container);
}

/* ── 左侧侧边栏 ─────────────────────────────────── */
.agent-sidebar {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border-right: 1px solid var(--border-color);
  overflow: hidden;
  /* 收起 / 展开的收放动画（与主 Agent 控制台折叠同一条曲线）。
     拖动分隔条那一路没有过渡 —— 它直接改 sidebarWidth，慢半拍会像拽橡皮筋。 */
  transition: width var(--transition-base) var(--ease-custom);
}

/* 会话列表用组件库的 ConversationList（搜索/新建/重命名/删除/收起都在组件里） */
.agent-conversations {
  flex: 1;
  min-height: 0;
  padding: 10px 6px 8px 12px;
}

/* 收起态：40px 的收纳条 —— 常态那份「左 12 右 6」的内边距得让开，
   否则收纳条只剩 22px，竖排文案会被裁掉（数值见 CONV_RAIL_WIDTH 的注释） */
.agent-sidebar.is-convs-collapsed .agent-conversations {
  padding: 10px 4px 8px;
}

/* ── 拖拽分隔条 ─────────────────────────────────── */
.sidebar-resizer {
  width: 4px;
  flex-shrink: 0;
  cursor: col-resize;
  background: transparent;
  transition: background var(--transition-fast) ease;

  &:hover,
  &.active {
    background: var(--color-primary);
    opacity: 0.3;
  }
}

/* ── 右侧对话区 ─────────────────────────────────── */
.agent-chat-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
}

/* ── 顶部 Tab 栏 ────────────────────────────────── */
/* ── 引擎选择器 ───────────────────────────────────────────────
   放 Tab 行右端：常驻可见、不挤占对话区、也不用改组件库的 ChatContainer。
   （按钮自身样式收口在 AgentEngineSelector，这里只管它在 Tab 行里的位置） */
.agent-engine {
  margin-left: auto;
  margin-bottom: 7px;
}

/* 复制会话：紧跟在引擎选择器右边（margin-left:auto 在它身上，所以这两个一起被推到 Tab 行右端）。
   7px 是让它与 Tab 的文字中线平齐 —— Tab 自己有 9px 下内边距。 */
.agent-copy {
  margin-left: 2px;
  margin-bottom: 7px;
}
/* 静默提示：复制按钮右边。同样吃 7px 的下外边距，与引擎 / 复制站在同一条中线上 */
.agent-silence {
  margin-left: 10px;
  margin-bottom: 7px;
}


.agent-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px 0;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-panel);
}

.agent-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px 9px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-meta);
  font-size: var(--font-size-mid);
  font-family: inherit;
  cursor: pointer;
  transition: color var(--transition-fast) ease, border-color var(--transition-fast) ease, background var(--transition-fast) ease;
  border-radius: var(--radius-base) var(--radius-base) 0 0;

  &:hover { color: var(--text-secondary); background: var(--bg-hover); }

  &.active {
    color: var(--color-primary);
    border-bottom-color: var(--color-primary);
    font-weight: 600;
  }
}

.agent-tab-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 对话 Pane 保持原有的纵向布局 */
.agent-chat-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
}

/* 广场面板占满剩余空间 */
.agent-tab-body > :deep(.marketplace-panel) {
  flex: 1;
  min-height: 0;
}

.chat-loading {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-meta);
  font-size: var(--font-size-base);
}

/* ── 窄屏：会话列表页 / 对话页 ─────────────────────────
   面板放不下并排两栏时（阈值见 useNarrowPane，默认 680px），
   改成两个整页轮换：点会话进对话、左上角返回箭头回列表。 */
.agent-list-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-panel);

  /* 独占整页了，左右不用再迁就窄栏，给足留白 */
  .agent-conversations {
    padding: 12px 12px 10px 14px;
  }
}

.agent-page-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  height: 34px;
  padding: 0 12px 0 6px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-panel);
}

.agent-page-back {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-meta);
  cursor: pointer;
  transition: var(--transition-ui-fast);

  &:hover {
    background: var(--bg-hover);
    color: var(--text-secondary);
  }
}

.agent-page-title {
  flex: 1;
  min-width: 0;
  font-size: var(--font-size-mid);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 对话宿主：自己开一层裁剪边界。
   欢迎页在矮/窄窗口里比可用高度还高、又是垂直居中的，溢出的部分会向上跑出
   .acu-chat 盖住返回条（连返回条的点击一起吃掉）。顺带给 .acu-chat 的
   height: 100% 一个明确的参照高度。 */
.agent-chat-host {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* g ai 头像是仓库自有的彩色标识（自带底色），不要再套组件库那层浅色圆底 ——
   它的背景是透明的，叠上去会在图标后面露出一个灰圈。 */
.agent-chat-host :deep(.acu-avatar--left) {
  background: transparent;
}

/* ── 本轮用时：钉在气泡头部右端（与「g ai」那一行同排） ──────────────
   库把元信息行（耗时）渲染在气泡**下方**那行操作栏里，而与它同排的复制 / 重新生成按钮
   平时是 opacity:0 —— 于是那行左边空着一截、只在最右边挂个「8.9s」，看着像掉队的一小段字
   （用户 2026-10-09 截图指出）。库的 MessageMetaConfig 只有 inline / below 两种位置、
   也没有插槽可换，只能盖样式：把它绝对定位到气泡本体右上角。

   定位基准必须**钉住宽度**：库只给 max-width，这一列是 shrink-to-fit 的 —— 内容一短
   （pending 的三个点、一句「好的」）它的右缘就缩到名字旁边，`right: 0` 的用时会跟着跑到
   左边压在「g ai」上（用户 2026-10-09 第二次截图：同一屏里长回答的在右、短回答的在左）。
   钉成库自己那个上限后，用时的 x 就恒定了。**只钉 assistant 行**：user 行不显示用时，
   而且它靠 `align-items: flex-end` 靠右，一并钉宽会把它的气泡挪到左边去。
   该规则必须成对存在 —— 只写 position: relative 是「页面照样渲染、只有位置不对」的
   静默失效，所以源码守卫按成对钉死（agentConversations.test.ts）。 */
.agent-chat-host :deep(.acu-bubble-row.is-assistant .acu-bubble-main) {
  position: relative;
  width: var(--acu-bubble-max-width);
  max-width: var(--acu-bubble-max-width);
}
/* 基准被钉宽后，气泡本体继续按内容收窄 —— 短回答的外观与改前逐像素一致
   （长回答的 max-content 本来就顶到上限，收不收都一样宽）。 */
.agent-chat-host :deep(.acu-bubble-row.is-assistant .acu-bubble) {
  align-self: flex-start;
}
.agent-chat-host :deep(.acu-message-meta) {
  position: absolute;
  top: 0;
  right: 0;
  /* 库给 .acu-bubble-footer 的 margin-top 对绝对定位元素照样生效，会把它往下推 8px */
  margin: 0;
}

/* 排队条带换成本项目「待处理」档的语义色 —— 与任务对话里那条 .wb-chat-queue 同一副面孔。
   库给 --acu-queue-* 四个变量就是留给宿主做这件事的，所以这里只映射颜色，不碰它的 class。 */
.agent-chat-host :deep(.acu-input-queue) {
  --acu-queue-edge: var(--role-pending-edge);
  --acu-queue-surface: var(--role-pending-surface);
  --acu-queue-ink: var(--role-pending-ink);
  --acu-queue-wash: var(--role-pending-wash);
}

/* ── 欢迎区大图标：换成 g ai 标识 ────────────────────────────────
   zen-ai-chat-ui 的 WelcomeScreen 把 logo 写死成一串内联 SVG（三颗闪光星），
   没有 prop / 插槽可换（dist 里 slots 出现 0 次），所以只能盖样式：
   藏掉它自带的 <svg>，把 div 本身当图片盒子，背景图走 AGENT_ASSISTANT_AVATAR
   （与消息气泡里的助手头像同一张，模板上用 --welcome-avatar 传进来）。
   同样因为图标自带底色，那层 primary-soft 圆底 + 描边要去掉，不然会露出灰圈。 */
.agent-chat-host :deep(.acu-welcome-logo) {
  width: 56px;
  height: 56px;
  background: var(--welcome-avatar) center / 46px 46px no-repeat;
  box-shadow: none;
}
.agent-chat-host :deep(.acu-welcome-logo > svg) {
  display: none;
}

/* ── 欢迎区预设卡片：末行自动铺满，不留孤零零的一张 ────────────────
   库里 .acu-welcome-grid 是 grid + repeat(auto-fit, minmax(280px, 1fr))，列数随面板
   宽度浮动（920px 上限下宽面板是 3 列）。5 条落进 3 列 = 3 + 1 + 1，而原来那条
   ":last-child 跨满整行"的规则会让落单的第 4 张留在第 2 行、第 5 张独占第 3 行拉满
   —— 排出来是「3 + 1 + 整行」，第 2 行右侧空两格，看着像漏了两张卡（实测症状）。

   改成 flex 换行：每张卡 flex-grow:1，于是**每一行**（含末行）都按行均分整行宽度，
   末行剩几张就分几份。宽面板 3+2、窄面板 2+2+1、单列，任何宽度下都不会留空洞，
   也不需要再写 nth-child 特例（预设条数变了也不会排歪）。 */
.agent-chat-host :deep(.acu-welcome-grid) {
  display: flex;
  flex-wrap: wrap;
}
.agent-chat-host :deep(.acu-welcome-grid > .acu-preset-q) {
  flex: 1 1 260px;
  min-width: 0;
  /* 库里每张预设是「白底 + 1px 描边 + 圆角」的小卡片，五张并排时边界比内容还抢眼
     （用户点名不要这种形态）。宿主按广场的写法压成平铺块：去底、去描边，
     hover 才铺一层淡底。序号保留 —— 它承担「一页目录」的定位，不是重复信息。 */
  background: transparent;
  border: 0;
  border-radius: var(--radius-lg);
  padding: 12px 10px 12px 0;
}
.agent-chat-host :deep(.acu-welcome-grid > .acu-preset-q:hover) {
  background: var(--bg-hover);
  box-shadow: none;
  transform: none;
}

/* ── 暗色主题适配 ───────────────────────────────── */
:global([data-theme='dark']) {
  .agent-sidebar {
    background: var(--bg-panel);
  }
}

/* ── 当前文档上下文卡：和添加的附件同处一行、同一副样子 ─────────
   锚点由 JS 插进库的输入框 DOM，动态创建的元素拿不到 scoped 属性，
   所以定位规则必须走 :deep()（卡片本体是 Teleport 进来的、带 scoped 属性，用普通规则）。
   形状逐项复刻 EditorAgentPanel 那份（同一个控件在两个宿主长得必须一样）。 */
.agent-chat-host :deep(.acu-input-wrap) > .agent-context-slot {
  display: flex;
  flex-wrap: wrap;
  gap: var(--acu-space-2, 8px);
  padding: var(--acu-space-2, 8px) var(--acu-space-2, 8px) 0;
}
.agent-chat-host :deep(.acu-input-attachments) > .agent-context-slot {
  display: inline-flex;
}

/* 卡片本体：逐项对齐库的 .acu-input-att-file（库的规则带 [data-v-...] 作用域，
   宿主侧用同名 class 命不中，只能复刻；颜色/圆角仍取库变量，跟随主题）。 */
.agent-context-att {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--acu-space-2, 8px);
  max-width: 180px;
  padding: var(--acu-space-2, 8px) var(--acu-space-3, 12px);
  border: 1px solid var(--acu-border);
  border-radius: var(--acu-radius-sm, 8px);
  background: var(--acu-bg, var(--bg-container));
  color: var(--acu-text-secondary, var(--text-secondary));
  font-size: var(--acu-font-size-xs, 12px);
}

.agent-context-att-icon {
  flex-shrink: 0;
  opacity: 0.75;
}

.agent-context-att-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 移除按钮：复刻库的 .acu-input-att-remove（悬在卡片右上角外边） */
.agent-context-att-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--acu-radius-full, 999px);
  background: var(--acu-text, var(--text-primary));
  color: var(--acu-bg, var(--bg-container));
  cursor: pointer;
  box-shadow: var(--acu-shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.2));
  transition: transform var(--acu-duration-fast, 0.15s) var(--acu-easing, ease);

  &:hover {
    transform: scale(1.12);
  }

  &:active {
    transform: scale(1.02);
  }
}
</style>

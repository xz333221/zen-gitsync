<template>
  <!--
    文件空间右侧的 g ai 对话面板。
    - 够宽（≥680px，判据同「智能体」视图）：左边一列会话历史 + 右边对话，历史**直接摆在那儿**，
      不用先点按钮翻过去；不够宽就折成两页，头部按钮来回翻
    - 输入框常驻底部：ChatContainer 传 show-input=false，输入框拆出来自己摆在面板最下方。
      于是两种形态、两个页面都有输入框 —— 列表页也能直接开聊，翻页时草稿与附件都不丢
    - 复用的都是组件库的独立导出：ConversationList（列表）+ ChatContainer（气泡区）+ ChatInput（输入框）
    - "当前打开的文档"通过请求级注入告知模型（sendMessage 的 openFilePath 选项）；
      它修饰的是**这一条消息的上下文**，所以做成附件卡片、搬进输入框内部（见 contextSlot）
    - 自己持有一个 useAgentChat 实例：runs/refs 与「对话」Tab 隔离，互不打断
  -->
  <div ref="rootRef" class="editor-agent-panel">
    <div class="agent-panel-header">
      <!-- 窄屏的列表页：整条 header 让给「返回对话 + 标题」 -->
      <template v-if="narrow && page === 'list'">
        <button
          class="agent-panel-icon-btn agent-panel-back-btn"
          :title="$t('@EDITOR:返回对话')"
          :aria-label="$t('@EDITOR:返回对话')"
          @click="page = 'chat'"
        >
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
        </button>
        <span class="agent-panel-title">{{ $t('@EDITOR:会话列表') }}</span>
      </template>

      <template v-else>
        <span class="agent-panel-title">{{ $t('@EDITOR:g ai 对话') }}</span>
      </template>

      <div class="agent-panel-spacer" />
      <!-- 引擎切换：与「智能体」视图同一套（同一个 AgentEngineSelector）。
           宽屏左边摆着历史，对话区一直在，所以常驻；窄屏只在对话页出现 ——
           列表页没有正在跑的对话，摆这儿只会挤占标题。 -->
      <AgentEngineSelector
        v-if="!narrow || page === 'chat'"
        class="agent-panel-engine"
        :engine="displayEngine"
        :locked="isEngineLocked"
        @select="onEngineSelect"
      />
      <!-- 会话列表按钮：只有"列表是独立一页"时才需要它（宽屏列表就在旁边） -->
      <button
        v-if="narrow && page === 'chat'"
        class="agent-panel-icon-btn agent-panel-list-btn"
        :title="$t('@EDITOR:会话列表')"
        :aria-label="$t('@EDITOR:会话列表')"
        @click="page = 'list'"
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
          <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
        </svg>
      </button>
      <button
        class="agent-panel-icon-btn"
        :title="$t('@EDITOR:关闭对话')"
        @click="emit('close')"
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>

    <div class="agent-panel-body" :class="{ 'is-wide': !narrow }">
      <!-- 会话历史：宽屏是常驻左列（行高正常 + 带搜索框），窄屏是独享整页 -->
      <div v-show="!narrow || page === 'list'" class="agent-panel-convs">
        <ConversationList
          :show-search="true"
          :items="conversationItems"
          :active-id="currentSessionId"
          :loading="sessionsLoading"
          :labels="conversationLabels"
          @select="onSelectSession"
          @new="onNewSession"
          @rename="renameSession"
          @delete="deleteSession"
        />
      </div>

      <!-- 气泡区：输入框已经不在这里了（show-input=false），见下面常驻的那一条 -->
      <div v-show="!narrow || page === 'chat'" ref="chatHostRef" class="agent-panel-chat">
        <ChatContainer
          ref="chatRef"
          :show-input="false"
          :messages="messages"
          :assistant-name="AGENT_ASSISTANT_NAME"
          :assistant-avatar="AGENT_ASSISTANT_AVATAR"
          :theme="chatTheme"
          :question="pendingQuestion"
          :question-submitting="answeringQuestion"
          :question-labels="questionLabels"
          :plan-config="{ labels: { title: $t('@AGENT:计划'), raw: $t('@AGENT:原始参数') } }"
          @answer="answerQuestion"
        />
      </div>

      <!--
        输入框常驻：两种形态、两个页面都在最下方（与演示页同一套做法）。
        它被拆到 ChatContainer 外面，所以 acu-root 与 data-theme 得自己套上：
        库把盒模型重置限定在 .acu-root 子树里，而 ChatInput 根节点是 div（不是 button），
        少了它就会退回 content-box、横着溢出面板。

        v-if="width > 0"：**等量到本面板的宽度再挂载输入框**。库的 ChatInput 只在
        onMounted 里量一次 scrollHeight，量到的宽度不对就再也纠不回来 —— 实测首帧挂载时
        容器还没宽度，占位文案被折成十几行，textarea 直接顶到 200px 上限并一直卡在那里。
        宽度是 useNarrowPane 在 onMounted 里同步量到的，所以这里晚的只是一次重渲染。
      -->
      <div
        v-if="width > 0"
        ref="composerRef"
        class="agent-panel-composer acu-root"
        :data-theme="chatTheme"
      >
        <ChatInput
          ref="inputRef"
          :disabled="isStreaming"
          :generating="isStreaming"
          :placeholder="isStreaming ? $t('@AGENT:正在生成中...') : $t('@AGENT:输入消息，Enter 发送')"
          :upload-config="{ accept: AGENT_UPLOAD_ACCEPT }"
          @send="onSend"
          @stop="stop"
        />

        <!--
          当前文档：**和添加的附件同处一行、同一副样子**。
          组件库的 ChatContainer / ChatInput 没有任何插槽（dist 里 `slots` 出现 0 次），
          没法声明式地往输入框里放东西，所以：
            · 往 `.acu-input-wrap` 插一个锚点，再把卡片 Teleport 进去（节点仍是 Vue 渲染的）；
            · **有附件行（.acu-input-attachments）时锚点住进它内部** —— 卡片因此成为那一行的
              flex item，与附件并排、共用同一套 gap/wrap。只插在输入框最前面是不行的：
              Vue 更新输入框时会用自己的锚点 `insertBefore`，把外来节点挤到后面去。
        -->
        <Teleport v-if="contextSlot" :to="contextSlot">
          <div v-if="showContextCard" class="agent-context-att" :title="activeFilePath || ''">
            <svg class="agent-context-att-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 3 14 8 19 8"/>
            </svg>
            <span class="agent-context-att-name">{{ activeFileName }}</span>
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
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { $t } from '@/lang/static'
import { ChatContainer, ChatInput, ConversationList } from 'zen-ai-chat-ui'
// 组件库的样式表必须由**每个消费方自己引**：Vite 只会随各自的异步 chunk 按需注入，
// 而 AgentView / WorkbenchView / JobLogDetails 都是懒加载的 —— 从文件空间直接打开本面板时
// 那三个 chunk 一个都没加载过，漏了这行就是整块面板无样式裸奔（2026-09-27 用户实测报过）。
import 'zen-ai-chat-ui/style.css'
import { useAgentChat, AGENT_UPLOAD_ACCEPT } from '@/composables/useAgentChat'
import { useThemeObserver } from '@/composables/useThemeObserver'
import { useNarrowPane } from '@/composables/useNarrowPane'
import type { AgentEngineId } from '@/utils/agentEngine'
import {
  buildConversationItems,
  agentConversationLabels,
  agentQuestionLabels,
  AGENT_ASSISTANT_NAME,
  AGENT_ASSISTANT_AVATAR,
} from '@/utils/agentConversations'
import AgentEngineSelector from '@/components/AgentEngineSelector.vue'

const props = defineProps<{
  /** 当前打开的文档路径（绝对或相对都行，服务端会归一化到项目根目录） */
  activeFilePath?: string | null
  /** 当前打开的文档名（只用于输入框里那张卡片） */
  activeFileName?: string
  /** 面板是否可见：v-show 隐藏时收不到通知，靠它在重新可见时贴底并刷新会话列表 */
  active?: boolean
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const { theme } = useThemeObserver()
const chatTheme = computed<'light' | 'dark'>(() => (theme.value === 'dark' ? 'dark' : 'light'))

// 独立实例：与「对话」Tab 的 runs/refs 完全隔离（那边后台跑着的流不会被这里影响）
const {
  sessions,
  sessionsLoading,
  currentSessionId,
  messages,
  isStreaming,
  pendingQuestion,
  answeringQuestion,
  isSessionGenerating,
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
  stop,
} = useAgentChat()

// ── 引擎：与「智能体」视图同一口径 ────────────────────────────
// 已有会话显示它自己的引擎（且锁定），没有会话显示"下次新建会用哪个"。
// 这条面板自己持有一个 useAgentChat 实例（见文件头注释），所以选择状态与
// 那边的「对话」Tab 天然隔离 —— 但用的一定是同一个 AgentEngineSelector。
const displayEngine = computed(() => (isEngineLocked.value ? currentEngine.value : pendingEngine.value))

function onEngineSelect(id: AgentEngineId) {
  if (isEngineLocked.value) return
  pickEngine(id)
}

const conversationItems = computed(() => buildConversationItems(sessions.value, isSessionGenerating))
const conversationLabels = agentConversationLabels()
const questionLabels = agentQuestionLabels()

const chatRef = ref<InstanceType<typeof ChatContainer> | null>(null)
const inputRef = ref<InstanceType<typeof ChatInput> | null>(null)
const chatHostRef = ref<HTMLElement | null>(null)
const composerRef = ref<HTMLElement | null>(null)

// ── 版面：够宽就左列表右对话，不够宽折成两页 ──────────────────
// 量的是这块面板自己的宽度（跟 Monaco 分空间、用户拖动分隔条都会变；视口宽度反映不了）。
// 判据与「智能体」视图共用一份（useNarrowPane）：280 列表 + 400 对话 ≈ 680。
//
// 为什么不"列表压在上面 + 对话在下面"：那种堆叠无论面板多宽都在抢对话的高度，
// 列表一开就只剩两三行对话。所以这里只有两种形态 —— 并排，或者分页，永不堆叠。
const rootRef = ref<HTMLElement | null>(null)
// width 也留着用：输入框要等量到宽度再挂载（见模板里的 v-if，原因写在那一行上面）
const { width, narrow } = useNarrowPane(rootRef)
/** 窄屏下的当前页。宽屏两栏并排时用不到它 */
const page = ref<'list' | 'chat'>('chat')

// ── 当前文档卡片：锚点插进库的输入框容器，和附件同处一行 ────────
// 锚点是个空 div，样式靠 `:deep()` 从父级选择器下发（动态创建的元素没有 scoped 属性，
// 普通 scoped 规则命中不了它）。Teleport 的内容才是真正的卡片，由 Vue 渲染。
const contextSlot = ref<HTMLElement | null>(null)
/** 用户点了卡片上的 ✕：本轮不把当前文档带给模型（切换文档 / 重开面板时恢复） */
const contextDismissed = ref(false)
let slotObserver: MutationObserver | null = null

const showContextCard = computed(() => !!props.activeFileName && !contextDismissed.value)

/** 库里真附件行的容器（.acu-input-attachments）—— 没有附件时库不渲染它 */
function findAttachmentsHost(wrap: HTMLElement): HTMLElement | null {
  return (Array.from(wrap.children).find(c =>
    (c as HTMLElement).classList?.contains('acu-input-attachments')
  ) as HTMLElement | undefined) ?? null
}

/**
 * 让锚点落到正确的宿主里。两种形态：
 *   · 有附件行 → 住进 `.acu-input-attachments`，卡片就是那一行的 flex item，与附件并排；
 *   · 没附件行 → 自己待在输入框最前面（样式复刻成同一行的样子，见 <style>）。
 *
 * 为什么不干脆固定插在 `.acu-input-wrap` 最前：**位置保不住**。Vue 更新输入框时
 * 用自己的锚点 `insertBefore` 插入 `.acu-input-attachments`，会把外来的兄弟节点挤到后面 ——
 * 上一版就是因此在有附件时掉到了附件行的下面（用户截图）。住进容器内部才是稳的。
 */
function syncContextSlot() {
  // 输入框已经拆到 ChatContainer 外面自己摆了（见文件头），锚点要找那条常驻的 ChatInput：
  // 它的根节点就是 .acu-input-wrap。再往 ChatContainer 里找只会找到 null。
  const wrap = inputRef.value?.$el as HTMLElement | null | undefined
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

function scrollToBottom(smooth = true) {
  chatRef.value?.scrollToBottom(smooth)
}

async function onSend(payload: { text: string; files: any[] }) {
  // 关键：把"当前打开的文档"一起发给服务端（请求级注入，不落会话历史）。
  // 点过卡片上的 ✕ 就不带 —— 与"移除一个附件"是同一种语义：这一条不要它。
  const openFilePath = contextDismissed.value ? undefined : (props.activeFilePath || undefined)
  await sendMessage(payload.text, payload.files, { openFilePath })
  await nextTick()
  scrollToBottom()
}

function onSelectSession(sessionId: string) {
  loadSession(sessionId)
  // 点了会话要真的进对话页，否则停在列表页等于没反应
  page.value = 'chat'
}

function onNewSession() {
  newSession()
  page.value = 'chat'
}

watch(() => messages.value.length, () => {
  nextTick(() => scrollToBottom(false))
})

// 锚点住在那条常驻输入框里，盯着它：库在有/无附件时会动态增删附件行，
// 锚点得跟着搬进搬出（比在各个 watch 里到处补一遍可靠）。
function watchChatDom() {
  const host = composerRef.value
  if (!host || typeof MutationObserver === 'undefined') return
  slotObserver?.disconnect()
  slotObserver = new MutationObserver(() => syncContextSlot())
  slotObserver.observe(host, { childList: true, subtree: true })
}

// 面板重新可见时：回到对话页 + 贴底，并顺手刷新一次会话列表（另一处视图可能新建/删除了会话）
// 回到对话页是必要的：面板是「懒挂载 + v-show」保状态的（见 EditorView 的 v-if/v-show），
// 上次关面板时如果正停在列表页，直接复用挂载状态会让用户"点开 g ai 面板，看到的却是列表"。
watch(
  () => props.active,
  (visible) => {
    if (!visible) return
    page.value = 'chat'
    loadSessions().catch(() => {})
    nextTick(() => {
      syncContextSlot()
      scrollToBottom(false)
    })
  }
)

// 变宽后回到对话页：两栏并排时列表已经摆在旁边，没必要再停在列表页 ——
// 否则下次变窄会莫名其妙地「一进来就是列表」（与 AgentView 同一处置）。
watch(narrow, (isNarrow) => {
  if (!isNarrow) page.value = 'chat'
})

// 换了个打开的文档 → 之前点掉的 ✕ 作废，新的文档要重新带上下文
watch(() => props.activeFilePath, () => {
  contextDismissed.value = false
})

// 没打开文档 / 又打开了 → 让锚点跟着来去（MutationObserver 只负责"位置"，不负责"有没有"）
watch(showContextCard, (show) => {
  if (show) nextTick(syncContextSlot)
})

onMounted(() => {
  loadSessions().catch(() => {})
  nextTick(() => {
    syncContextSlot()
    watchChatDom()
  })
})

onBeforeUnmount(() => {
  slotObserver?.disconnect()
  slotObserver = null
  // 锚点是插进库 DOM 的，随组件一起卸载（父级销毁时它自然没了），
  // 这里只清引用，别去 remove —— 那时 Teleport 内容还挂在里面。
  contextSlot.value = null
})
</script>

<style lang="scss" scoped>
.editor-agent-panel {
  display: flex;
  flex-direction: column;
  flex-grow: 1;
  flex-basis: 0;
  min-width: 200px;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-panel);
  border-left: 1px solid var(--border-color);
}

.agent-panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 6px 0 12px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-color);
}

.agent-panel-title {
  font-size: var(--font-size-xs);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-meta);
  white-space: nowrap;
  /* 面板跟 Monaco 抢宽度，天生很窄：标题给引擎下拉与图标让位，超了就省略号 */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.agent-panel-spacer {
  flex: 1;
}

/* 引擎切换：不参与压缩（引擎名是身份标识，挤扁了没法认），狭面板优先压标题 */
.agent-panel-engine {
  flex: none;
}

.agent-panel-icon-btn {
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

/*
  中间区用 grid 划三块：会话历史 / 气泡区 / 常驻输入框。
  窄屏只有一列 —— 历史与气泡区都落在 stage 上，靠 page 决定谁可见；
  宽屏两列两行 —— 历史整列贯通，右边上是气泡、右下是输入框，
  输入框因此只落在对话那一列里，不会伸到历史列表底下。
*/
.agent-panel-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto;
  grid-template-areas:
    'stage'
    'composer';
}

.agent-panel-body.is-wide {
  grid-template-columns: 240px minmax(0, 1fr);
  grid-template-areas:
    'list chat'
    'list composer';
}

/* 会话历史：窄屏整页独占（行高正常 + 带搜索框），宽屏是左侧常驻一列 */
.agent-panel-convs {
  grid-area: stage;
  min-height: 0;
  padding: 8px 10px;
  overflow-y: auto;
}

.agent-panel-chat {
  grid-area: stage;
  min-height: 0;
  display: flex;
}

.agent-panel-body.is-wide .agent-panel-convs {
  grid-area: list;
}

.agent-panel-body.is-wide .agent-panel-chat {
  grid-area: chat;
}

/*
  常驻输入框条：留白与渐变对齐库的 .acu-chat-footer，拆出来之后视觉上不该有差别。
  两列版式下它住在 chat 那一格，所以不会横到会话历史下面去。
*/
.agent-panel-composer {
  grid-area: composer;
  padding: var(--acu-space-3) var(--acu-space-4) var(--acu-space-4);
  background: linear-gradient(to top, var(--acu-bg) 70%, transparent);
}

/* ChatContainer 根节点（.acu-chat）吃满剩余空间 */
.agent-panel-chat > :deep(.acu-chat) {
  flex: 1;
  min-width: 0;
}

/* g ai 头像是仓库自有的彩色标识（自带底色），不要再套组件库那层浅色圆底 ——
   它的背景是透明的，叠上去会在图标后面露出一个灰圈。 */
.agent-panel-chat :deep(.acu-avatar--left) {
  background: transparent;
}

/* ── 当前文档卡片：和添加的附件同处一行、同一副样子 ─────────────
   锚点由 JS 插进库的输入框 DOM，动态创建的元素拿不到 scoped 属性，
   所以这些规则必须走 :deep()（编译成 `.agent-panel-chat[data-v-x] .agent-context-slot`，
   后代选择器部分不要求属性）。 */

/* 形态一：**没有真附件**。此时库不渲染 .acu-input-attachments，锚点自己当那一行 ——
   逐项复刻附件行的布局（flex + wrap + gap + 同样的内边距），视觉上无缝。 */
.agent-panel-composer :deep(.acu-input-wrap) > .agent-context-slot {
  display: flex;
  flex-wrap: wrap;
  gap: var(--acu-space-2, 8px);
  padding: var(--acu-space-2, 8px) var(--acu-space-2, 8px) 0;
}

/* 形态二：**有真附件**。锚点住在 .acu-input-attachments 里，自己是那一行的一个 flex item ——
   于是和附件卡片并排、共用同一套 gap/wrap，也就是"跟加附件一样"。 */
.agent-panel-composer :deep(.acu-input-attachments) > .agent-context-slot {
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

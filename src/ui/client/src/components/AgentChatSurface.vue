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
  一块可嵌进窄栏的 g ai 对话面。

  版面与文件空间的 g ai 面板同一套（判据共用 useNarrowPane）：
  · 够宽（≥680px，右栏能拖到 900）：左边一列会话历史 + 右边对话，历史**直接摆在那儿**；
  · 不够宽：折成两页，头部按钮来回翻。
  两种形态都不堆叠 —— 「列表压在上面」会把对话挤到只剩两三行。
  输入框常驻底部（ChatContainer 传 show-input=false，输入框拆出来自己摆），
  两种形态、两个页面都在：列表页也能直接开聊，翻页时草稿与附件都不丢。

  为什么不是直接把 EditorAgentPanel 拿来用：
    · 那块面板绑着"当前打开的文档"那条上下文卡片（往库的输入框里 Teleport 锚点），
      主 Agent 控制台里没有"当前文档"这回事；
    · 它还有"关闭面板"按钮 —— 控制台是常驻栏，没有关闭语义。
  AgentChatSurface 则是"从栏里长出来"的那一半：两个页面/两栏、引擎选择、提问面板、贴底滚动。
  将来若要合并，方向是把这里当底、把文档卡片当插槽传进去。

  与「对话」Tab、编辑器面板**共享同一份会话**（agentSessionStore 按项目归属），
  所以这里看到的就是同一个 g ai 的上下文 —— 刻意不另开一套会话存储：同一个
  "主 Agent"被切成两个记忆会更难解释。

  allowDispatch 是本组件唯一的知识点：只有在主 Agent 控制台里，这一轮对话才被允许
  调用 dispatch_task 派发工作台任务（服务端按 allowDispatch 决定注不注入那个工具）。
-->

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { $t } from '@/lang/static'
import { ChatContainer, ChatInput, ConversationList } from 'zen-ai-chat-ui'
// 组件库样式必须由每个消费方自己引（原因见 EditorAgentPanel 里那段注释：
// Vite 按各自异步 chunk 注入，工作台这条 chunk 不一定加载过 style.css）
import 'zen-ai-chat-ui/style.css'
import { useAgentChat, AGENT_UPLOAD_ACCEPT } from '@/composables/useAgentChat'
import { useThemeObserver } from '@/composables/useThemeObserver'
import { useNarrowPane } from '@/composables/useNarrowPane'
import { agentEngineName, type AgentEngineId } from '@/utils/agentEngine'
import {
  buildConversationItems,
  agentConversationLabels,
  agentQuestionLabels,
  AGENT_ASSISTANT_NAME,
  AGENT_ASSISTANT_AVATAR,
} from '@/utils/agentConversations'
import AgentEngineSelector from '@/components/AgentEngineSelector.vue'
import TaskExecutorPicker from '@/components/TaskExecutorPicker.vue'
import type { TaskExecutorId } from '@/utils/taskExecutor'

const props = defineProps<{
  /** 头部标题（各入口自己决定叫"主 Agent 对话"还是别的） */
  title?: string
  /** 面板可见：重新可见时要贴底 + 刷新会话列表（列表可能被别处动过） */
  active?: boolean
  /** 这一轮对话是否允许派发工作台任务（服务端按它决定注不注入 dispatch_task） */
  allowDispatch?: boolean
  /** 派发时要不要附加编排台的默认提示词（跟随控制台那个勾选） */
  dispatchUseDefaultPrompt?: boolean
  /** 输入框占位文案 */
  placeholder?: string
}>()

/** 派出去的任务由谁跑。与工作台执行按钮共用同一份选择（见 TaskExecutorPicker 的注释） */
const executor = defineModel<TaskExecutorId>('dispatchExecutor', { default: 'claude' })

const { theme } = useThemeObserver()
const chatTheme = computed<'light' | 'dark'>(() => (theme.value === 'dark' ? 'dark' : 'light'))

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

const displayEngine = computed(() => (isEngineLocked.value ? currentEngine.value : pendingEngine.value))
function onEngineSelect(id: AgentEngineId) {
  if (isEngineLocked.value) return
  pickEngine(id)
}

/**
 * 「这个引擎不会派发」的提示。
 *
 * 这不是防御性代码，是**必须说清的产品约束**：只有内置 g ai 在服务端跑工具循环，
 * 外部三家 CLI 自带一套工具集、根本不认识 dispatch_task。用户在这里切了 opencode
 * 却期待它派活，会得到一个"它答应了但什么都没发生"的对话 —— 与其让他自己撞上去，
 * 不如当场把话说白（引擎一旦开聊就锁死，所以这条提示同时也是"想派活得新建会话"的指引）。
 */
const engineCantDispatch = computed(() => props.allowDispatch !== false && displayEngine.value !== 'gai')

const conversationItems = computed(() => buildConversationItems(sessions.value, isSessionGenerating))
const conversationLabels = agentConversationLabels()
const questionLabels = agentQuestionLabels()

// ── 版面：够宽就左列表右对话，不够宽折成两页 ──────────────────
// 量的是这块面自己的宽度（工作台右栏能拖到 260–900，还会被视口比例再卡一道），
// 判据与「智能体」视图、文件空间面板共用一份（useNarrowPane）。
// 不堆叠：「列表压在上面」无论多宽都在抢对话高度，要窄就老老实实分页。
const rootRef = ref<HTMLElement | null>(null)
// width 也留着用：输入框要等量到宽度再挂载（见模板里的 v-if，原因写在那一行上面）
const { width, narrow } = useNarrowPane(rootRef)
/** 窄屏下的当前页。宽屏两栏并排时用不到它 */
const page = ref<'list' | 'chat'>('chat')

const chatRef = ref<InstanceType<typeof ChatContainer> | null>(null)
function scrollToBottom(smooth = true) {
  chatRef.value?.scrollToBottom?.(smooth)
}

async function onSend(payload: { text: string; files: any[] }) {
  await sendMessage(payload.text, payload.files, {
    allowDispatch: props.allowDispatch === true,
    dispatchExecutor: executor.value,
    dispatchUseDefaultPrompt: props.dispatchUseDefaultPrompt !== false,
  })
  await nextTick()
  scrollToBottom()
}

function onSelectSession(sessionId: string) {
  loadSession(sessionId)
  page.value = 'chat'
}
function onNewSession() {
  newSession()
  page.value = 'chat'
}

watch(() => messages.value.length, () => {
  nextTick(() => scrollToBottom(false))
})

// 可见时重新贴底 + 刷一次会话列表（另一个入口可能刚建/删过会话）
watch(() => props.active, (visible) => {
  if (!visible) return
  loadSessions().catch(() => {})
  nextTick(() => scrollToBottom(false))
})

// 变宽后回到对话页：两栏并排时列表已经摆在旁边，没必要再停在列表页 ——
// 否则下次变窄会莫名其妙地「一进来就是列表」（与 AgentView / 文件空间面板同一处置）。
watch(narrow, (isNarrow) => {
  if (!isNarrow) page.value = 'chat'
})

onMounted(() => {
  loadSessions().catch(() => {})
  nextTick(() => scrollToBottom(false))
})
</script>

<template>
  <div ref="rootRef" class="acs">
    <div class="acs__head">
      <!-- 窄屏的列表页：整条头让给「返回对话 + 标题」 -->
      <button
        v-if="narrow && page === 'list'"
        type="button"
        class="acs__icon-btn"
        :title="$t('@EDITOR:返回对话')"
        :aria-label="$t('@EDITOR:返回对话')"
        @click="page = 'chat'"
      >
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
        </svg>
      </button>
      <span class="acs__title">{{ title || $t('@WORKBENCH:g ai 对话') }}</span>
      <span class="acs__spacer" />
      <!-- 引擎切换：与「智能体」视图 / 编辑器面板同一个选择器（唯一那份实现）。
           宽屏对话区一直在，所以常驻；窄屏只在对话页出现 —— 列表页摆它只会挤占标题。 -->
      <AgentEngineSelector
        v-if="!narrow || page === 'chat'"
        class="acs__engine"
        :engine="displayEngine"
        :locked="isEngineLocked"
        @select="onEngineSelect"
      />
      <!-- 会话列表按钮：只有"列表是独立一页"时才需要它（宽屏列表就在旁边） -->
      <button
        v-if="narrow && page === 'chat'"
        type="button"
        class="acs__icon-btn"
        :title="$t('@EDITOR:会话列表')"
        :aria-label="$t('@EDITOR:会话列表')"
        @click="page = 'list'"
      >
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
          <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
        </svg>
      </button>
    </div>

    <div class="acs__body" :class="{ 'is-wide': !narrow }">
      <!-- 会话历史：宽屏是常驻左列，窄屏是独享整页 -->
      <div v-show="!narrow || page === 'list'" class="acs__convs">
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
      <div v-show="!narrow || page === 'chat'" class="acs__chat">
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
          @answer="answerQuestion"
        />
      </div>

      <!--
        输入框常驻：两种形态、两个页面都在最下方。
        它被拆到 ChatContainer 外面，所以 acu-root 与 data-theme 得自己套上：
        库把盒模型重置限定在 .acu-root 子树里，而 ChatInput 根节点是 div（不是 button），
        少了它就会退回 content-box、横着溢出这条栏。

        v-if="width > 0"：**等量到本面板的宽度再挂载输入框**。库的 ChatInput 只在
        onMounted 里量一次 scrollHeight，量到的宽度不对就再也纠不回来 —— 实测首帧挂载时
        容器还没宽度，占位文案被折成十几行，textarea 直接顶到 200px 上限并一直卡在那里
        （切走再切回才对）。宽度是 useNarrowPane 在 onMounted 里同步量到的，所以这里
        晚的只是一次重渲染，同一帧内就补上了，看不到闪烁。
      -->
      <div
        v-if="width > 0"
        class="acs__composer acu-root"
        :data-theme="chatTheme"
      >
        <ChatInput
          :disabled="isStreaming"
          :generating="isStreaming"
          :placeholder="placeholder || (isStreaming ? $t('@AGENT:正在生成中...') : $t('@AGENT:输入消息，Enter 发送'))"
          :upload-config="{ accept: AGENT_UPLOAD_ACCEPT }"
          @send="onSend"
          @stop="stop"
        />
      </div>
    </div>

    <!-- 底部：派发执行器。放在输入框下面而不是头部 —— 它修饰的是"派出去的活谁跑"，
         不是"我在跟谁聊"，和引擎选择器挤在一行会让人分不清哪个管哪件事 -->
    <div v-if="allowDispatch && page === 'chat'" class="acs__foot">
      <template v-if="engineCantDispatch">
        <p class="acs__notice">
          {{ $t('@WORKBENCH:当前引擎「{name}」只能对话，不能派发任务 —— 切到内置 g ai 才能派活', { name: agentEngineName(displayEngine) }) }}
        </p>
      </template>
      <template v-else>
        <span class="acs__foot-label">{{ $t('@WORKBENCH:派发执行器') }}</span>
        <TaskExecutorPicker
          v-model="executor"
          :title="$t('@WORKBENCH:它派出去的任务由这个执行器跑（与执行按钮的临时切换共用）')"
        />
        <span class="acs__foot-hint">{{ $t('@WORKBENCH:任务会落到看板，跑完有完成提示') }}</span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.acs {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.acs__head {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  flex: none;
  padding: 0 8px;
  border-bottom: 1px solid var(--border-color-light);
}
.acs__title {
  font-size: var(--font-size-xs);
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.acs__spacer { flex: 1; }
/* 引擎选择器不参与压缩（引擎名是身份标识，挤扁了没法认） */
.acs__engine { flex: none; }
.acs__icon-btn {
  width: 22px;
  height: 22px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: var(--transition-ui-fast);
}
.acs__icon-btn:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

/*
  中间区用 grid 划三块：会话历史 / 气泡区 / 常驻输入框。
  窄栏只有一列 —— 两块都落在 stage 上，靠 page 决定谁可见；
  够宽时两列两行 —— 历史整列贯通，右边上是气泡、右下是输入框，
  输入框因此只落在对话那一列里，不会伸到历史列表底下。
*/
.acs__body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto;
  grid-template-areas:
    'stage'
    'composer';
}
.acs__body.is-wide {
  grid-template-columns: 240px minmax(0, 1fr);
  grid-template-areas:
    'list chat'
    'list composer';
}
.acs__convs {
  grid-area: stage;
  min-height: 0;
  padding: 8px;
  overflow-y: auto;
}
.acs__chat {
  grid-area: stage;
  min-height: 0;
  display: flex;
}
.acs__body.is-wide .acs__convs { grid-area: list; }
.acs__body.is-wide .acs__chat { grid-area: chat; }
/* 常驻输入框条：留白与渐变对齐库的 .acu-chat-footer */
.acs__composer {
  grid-area: composer;
  padding: var(--acu-space-3) var(--acu-space-4) var(--acu-space-4);
  background: linear-gradient(to top, var(--acu-bg) 70%, transparent);
}
/* ChatContainer 根节点（.acu-chat）吃满剩余空间 */
.acs__chat > :deep(.acu-chat) {
  flex: 1;
  min-width: 0;
}
/* g ai 头像是仓库自有的彩色标识（自带底色），不要再套组件库那层浅色圆底 ——
   它的背景是透明的，叠上去会在图标后面露出一个灰圈。 */
.acs__chat :deep(.acu-avatar--left) {
  background: transparent;
}
.acs__foot {
  flex: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 8px;
  border-top: 1px solid var(--border-color-light);
}
.acs__foot-label {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
}
.acs__foot-hint {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 引擎不会派发：说清为什么，别让人以为"它答应了但没动" */
.acs__notice {
  margin: 0;
  font-size: var(--font-size-xs);
  line-height: 1.5;
  color: var(--color-warning);
}
</style>

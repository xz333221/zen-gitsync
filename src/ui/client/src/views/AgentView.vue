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
  智能体视图：顶部 Tab 切换「对话 / Skill 广场 / MCP 广场」。
  - 对话：左侧会话列表 + 右侧使用 zen-ai-chat-ui 的 ChatContainer 渲染对话
  - 两个广场：按来源展示可安装的 Skill / MCP，装到当前项目或 g ai 智能体
  - SSE 流式：thinking + content + tool_call + tool_result
  - 会话持久化：后端自动保存到 ~/.zen-gitsync/agent-sessions/
-->
<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { $t } from '@/lang/static'
import { ElIcon } from 'element-plus'
import { Loading, ChatDotRound, Goods, Connection } from '@element-plus/icons-vue'
import { ChatContainer, ConversationList } from 'zen-ai-chat-ui'
import 'zen-ai-chat-ui/style.css'
import { useConfigStore } from '@/stores/configStore'
import { useAgentChat, AGENT_UPLOAD_ACCEPT } from '@/composables/useAgentChat'
import { buildConversationItems, agentConversationLabels, agentQuestionLabels, AGENT_ASSISTANT_NAME } from '@/utils/agentConversations'
import type { AgentEngineId } from '@/utils/agentEngine'
import { useNarrowPane } from '@/composables/useNarrowPane'
import MarketplacePanel from '@/components/MarketplacePanel.vue'
import AgentEngineSelector from '@/components/AgentEngineSelector.vue'

const configStore = useConfigStore()

// ── 面板宽度：够窄就把「会话列表」和「对话」折成两个页面 ──────────
// 量的是这个视图容器自己的宽度（窄屏下拖动侧栏 / 分屏都会变；视口宽度反映不了）。
const rootRef = ref<HTMLElement | null>(null)
const { narrow } = useNarrowPane(rootRef)
/** 窄屏下的当前页。宽屏两栏并排时用不到它 */
const chatPage = ref<'list' | 'chat'>('chat')

// ── 顶部 Tab ─────────────────────────────────────────────
// 会话列表只在「对话」Tab 显示 —— 广场占满宽度更好浏览;
// 两个广场共用一个 MarketplacePanel 实例,切类型时组件内部自己重拉数据。
type AgentTab = 'chat' | 'skill' | 'mcp'
const activeTab = ref<AgentTab>('chat')
const marketplaceType = computed(() => (activeTab.value === 'mcp' ? 'mcp' : 'skill'))
const tabs = computed(() => [
  { id: 'chat' as const, label: $t('@AGENT:对话'), icon: ChatDotRound },
  { id: 'skill' as const, label: $t('@AGENT:Skill 广场'), icon: Goods },
  { id: 'mcp' as const, label: $t('@AGENT:MCP 广场'), icon: Connection },
])

const {
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
  pendingQuestion,
  answeringQuestion,
  answerQuestion,
  isSessionGenerating,
  currentEngine,
  pendingEngine,
  isEngineLocked,
  pickEngine,
  stop
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

// ── 会话列表数据（喂给组件库的 ConversationList，映射逻辑与文件空间面板共用） ──
const conversationItems = computed(() => buildConversationItems(sessions.value, isSessionGenerating))
const conversationLabels = agentConversationLabels()

/** 窄屏对话页顶部返回条上的标题：直接取当前会话在列表里的那条（标题兜底/截断规则与列表一致） */
const currentSessionTitle = computed(
  () => conversationItems.value.find(i => i.id === currentSessionId.value)?.title || $t('@AGENT:对话')
)

// ── 预设问题 ──────────────────────────────────────────────
const presetQuestions = computed(() => [
  { id: 'p1', label: $t('@AGENT:查看项目结构'), prompt: $t('@AGENT:prompt_p1') },
  { id: 'p2', label: $t('@AGENT:分析代码质量'), prompt: $t('@AGENT:prompt_p2') },
  { id: 'p3', label: $t('@AGENT:帮我写测试'), prompt: $t('@AGENT:prompt_p3') },
  { id: 'p4', label: $t('@AGENT:Git 状态检查'), prompt: $t('@AGENT:prompt_p4') },
  { id: 'p5', label: $t('@AGENT:帮我启动项目'), prompt: $t('@AGENT:prompt_p5') }
])

// ── 发送消息 ──────────────────────────────────────────────
async function onSend(payload: { text: string; files: any[] }) {
  await sendMessage(payload.text, payload.files)
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

// ── 新建会话 ──────────────────────────────────────────────
function handleNewSession() {
  newSession()
  chatPage.value = 'chat'
}

// ── 侧边栏宽度拖拽 ────────────────────────────────────────
const sidebarWidth = ref(280)
const isResizing = ref(false)

function startResize(e: MouseEvent) {
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
</script>

<template>
  <div ref="rootRef" class="agent-view">
    <!-- ═══ 宽屏：左侧会话列表（只在「对话」Tab 显示）═══
         窄屏时这一整块不渲染，会话列表改成 body 里的一个整页（见 .agent-list-page） -->
    <template v-if="activeTab === 'chat' && !narrow">
      <aside class="agent-sidebar" :style="{ width: sidebarWidth + 'px' }">
      <!-- 会话列表：UI 与交互都在组件库的 ConversationList 里 -->
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
      </aside>

    <!-- 拖拽分隔条 -->
    <div
      class="sidebar-resizer"
      @mousedown="startResize"
      :class="{ active: isResizing }"
    ></div>
    </template>

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
          @click="activeTab = tab.id"
        >
          <el-icon><component :is="tab.icon" /></el-icon>
          <span>{{ tab.label }}</span>
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
            <div class="agent-chat-host">
              <!-- 加载中 -->
              <div v-if="sessionLoading" class="chat-loading">
                <el-icon class="is-loading" :size="32"><Loading /></el-icon>
                <span>{{ $t('@AGENT:加载会话中...') }}</span>
              </div>

              <!-- ChatContainer -->
              <ChatContainer
                v-else
                ref="chatContainerRef"
                :messages="messages"
                :preset-questions="presetQuestions"
                :welcome-title="$t('@AGENT:智能体助手')"
                :welcome-description="$t('@AGENT:我可以帮你阅读代码、执行命令、修改文件。选择下方话题或直接输入你的问题。')"
                :assistant-name="AGENT_ASSISTANT_NAME"
                :theme="chatTheme"
                :disabled="isStreaming"
                :generating="isStreaming"
                :upload-config="{ accept: AGENT_UPLOAD_ACCEPT }"
                :placeholder="isStreaming ? $t('@AGENT:正在生成中...') : $t('@AGENT:输入消息，Enter 发送')"
                :question="pendingQuestion"
                :question-submitting="answeringQuestion"
                :question-labels="questionLabels"
                @send="onSend"
                @select="onSelectPreset"
                @stop="stop"
                @answer="answerQuestion"
              >
              </ChatContainer>
            </div>
          </template>
        </div>

        <!-- ── Skill 广场 / MCP 广场 ── -->
        <MarketplacePanel v-else :type="marketplaceType" />
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
}

/* 会话列表用组件库的 ConversationList（搜索/新建/重命名/删除都在组件里） */
.agent-conversations {
  flex: 1;
  min-height: 0;
  padding: 10px 6px 8px 12px;
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
  color: var(--text-tertiary);
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
  color: var(--text-tertiary);
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
  color: var(--text-tertiary);
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

/* ── 欢迎区预设卡片：把落单的第 5 张拉满整行 ────────────────
   预设共 5 条（presetQuestions），而 zen-ai-chat-ui 的 .acu-welcome-grid
   是 2 列网格 → 排成 2+2+1，末行右侧空一格，看起来像漏了一张卡。
   让最后一张（奇数序号时）跨两列收尾，网格不再有空洞，也不用凑内容。
   （选择器带 .acu-welcome-grid 是为了盖过库里的 [data-v-*] 作用域样式） */
:deep(.acu-welcome-grid > .acu-preset-q:last-child:nth-child(odd)) {
  grid-column: 1 / -1;
}

/* ── 暗色主题适配 ───────────────────────────────── */
:global([data-theme='dark']) {
  .agent-sidebar {
    background: var(--bg-panel);
  }
}
</style>

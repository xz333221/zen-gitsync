<template>
  <!--
    文件空间右侧的 g ai 对话面板。
    - 会话列表（可折叠，复用组件库 ConversationList）+ ChatContainer，与「对话」Tab 看同一批服务端会话
    - "当前打开的文档"通过请求级注入告知模型（sendMessage 的 openFilePath 选项），header 的 chip 让用户看得见
    - 自己持有一个 useAgentChat 实例：runs/refs 与「对话」Tab 隔离，互不打断
  -->
  <div class="editor-agent-panel">
    <div class="agent-panel-header">
      <span class="agent-panel-title">{{ $t('@EDITOR:g ai 对话') }}</span>
      <span
        v-if="activeFileName"
        class="agent-context-chip"
        :title="activeFilePath || ''"
      >
        {{ $t('@EDITOR:当前文档') }}: {{ activeFileName }}
      </span>
      <div class="agent-panel-spacer" />
      <button
        class="agent-panel-icon-btn"
        :title="listCollapsed ? $t('@EDITOR:展开会话列表') : $t('@EDITOR:收起会话列表')"
        @click="listCollapsed = !listCollapsed"
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

    <!-- 会话列表：窄面板里默认展开得克制，可用 header 按钮折叠 -->
    <div class="agent-panel-convs" :class="{ collapsed: listCollapsed }">
      <ConversationList
        compact
        :show-search="false"
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

    <div class="agent-panel-chat">
      <ChatContainer
        ref="chatRef"
        :messages="messages"
        :assistant-name="AGENT_ASSISTANT_NAME"
        :theme="chatTheme"
        :disabled="isStreaming"
        :generating="isStreaming"
        :placeholder="isStreaming ? $t('@AGENT:正在生成中...') : $t('@AGENT:输入消息，Enter 发送')"
        :upload-config="{ accept: 'image/*' }"
        :question="pendingQuestion"
        :question-submitting="answeringQuestion"
        :question-labels="questionLabels"
        @send="onSend"
        @stop="stop"
        @answer="answerQuestion"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { $t } from '@/lang/static'
import { ChatContainer, ConversationList } from 'zen-ai-chat-ui'
// 组件库的样式表必须由**每个消费方自己引**：Vite 只会随各自的异步 chunk 按需注入，
// 而 AgentView / WorkbenchView / JobLogDetails 都是懒加载的 —— 从文件空间直接打开本面板时
// 那三个 chunk 一个都没加载过，漏了这行就是整块面板无样式裸奔（2026-09-27 用户实测报过）。
import 'zen-ai-chat-ui/style.css'
import { useAgentChat } from '@/composables/useAgentChat'
import { useThemeObserver } from '@/composables/useThemeObserver'
import {
  buildConversationItems,
  agentConversationLabels,
  agentQuestionLabels,
  AGENT_ASSISTANT_NAME,
} from '@/utils/agentConversations'

const props = defineProps<{
  /** 当前打开的文档路径（绝对或相对都行，服务端会归一化到项目根目录） */
  activeFilePath?: string | null
  /** 当前打开的文档名（只用于 header 的 chip 展示） */
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
  loadSessions,
  loadSession,
  deleteSession,
  renameSession,
  newSession,
  sendMessage,
  answerQuestion,
  stop,
} = useAgentChat()

const conversationItems = computed(() => buildConversationItems(sessions.value, isSessionGenerating))
const conversationLabels = agentConversationLabels()
const questionLabels = agentQuestionLabels()

const listCollapsed = ref(false)
const chatRef = ref<InstanceType<typeof ChatContainer> | null>(null)

function scrollToBottom(smooth = true) {
  chatRef.value?.scrollToBottom(smooth)
}

async function onSend(payload: { text: string; files: any[] }) {
  // 关键：把"当前打开的文档"一起发给服务端（请求级注入，不落会话历史）
  await sendMessage(payload.text, payload.files, { openFilePath: props.activeFilePath || undefined })
  await nextTick()
  scrollToBottom()
}

function onSelectSession(sessionId: string) {
  loadSession(sessionId)
}

function onNewSession() {
  newSession()
  listCollapsed.value = true
}

watch(() => messages.value.length, () => {
  nextTick(() => scrollToBottom(false))
})

// 面板重新可见时贴底，并顺手刷新一次会话列表（另一处视图可能新建/删除了会话）
watch(
  () => props.active,
  (visible) => {
    if (!visible) return
    loadSessions().catch(() => {})
    nextTick(() => scrollToBottom(false))
  }
)

onMounted(() => {
  loadSessions().catch(() => {})
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
  color: var(--text-tertiary);
  white-space: nowrap;
}

.agent-context-chip {
  display: inline-flex;
  align-items: center;
  max-width: 46%;
  padding: 2px 6px;
  border-radius: var(--radius-xs);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
  color: var(--color-primary);
  font-size: var(--font-size-xs);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.agent-panel-spacer {
  flex: 1;
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
  color: var(--text-tertiary);
  cursor: pointer;
  transition: var(--transition-ui-fast);

  &:hover {
    background: var(--bg-hover);
    color: var(--text-secondary);
  }
}

.agent-panel-convs {
  flex-shrink: 0;
  max-height: 38%;
  padding: 8px 8px 0;
  overflow-y: auto;
  transition: max-height var(--transition-fast) ease, padding var(--transition-fast) ease;

  &.collapsed {
    max-height: 0;
    padding-top: 0;
  }
}

.agent-panel-chat {
  flex: 1;
  min-height: 0;
  display: flex;
}

/* ChatContainer 根节点（.acu-chat）吃满剩余空间 */
.agent-panel-chat > :deep(.acu-chat) {
  flex: 1;
  min-width: 0;
}
</style>
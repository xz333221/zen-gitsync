<script setup lang="ts">
// 「常用目录 / 最近项目」列表底下那段 AI 解读的**追问区** —— 把 g ai 引到这块来。
//
// 原来这段说明是"一段话"：读完就完了,想问"那第二个呢""这个该怎么处理"只能自己另开
// 智能体视图重新描述一遍背景。这里就地接一个 g ai 对话：它拿到的上下文就是**用户眼前
// 这份状态**(下面 props.dirStatus 与 props.summary 每轮都随请求带给服务端,见
// server/routes/workbench/agentChat.js 的 injectRequestContext),所以问"先处理哪个"
// 不需要用户再复述一遍有哪些项目。
//
// 三个刻意的取舍(改之前先读):
//
// 1. **引擎固定 g ai**。这块地方就是"g ai 引用到这儿",不该被用户在智能体视图里选的
//    claude/codex 带走 —— 那三家的权限档与续聊口径完全不同,在这里静默生效会让人莫名其妙。
//    实现上是给 sendMessage 传 engine: 'gai'(见 composables/useAgentChat.ts)。
//
// 2. **不跨弹窗续聊**。弹窗是 destroy-on-close 的,每次打开都是一次新的对话。看起来
//    "该把上次的会话恢复回来",但那是错的:这批目录的领先/落后每次刷新都在变,上次那轮
//    回答说的是**当时**的状态,接着聊等于让模型拿旧数字答新问题。每次重开都是新会话,
//    上下文永远等于界面上这一刻的状态。代价是同一批追问不会攒在一条会话里。
//
// 3. **归属当前项目**。会话的 cwd 走 configStore.currentDirectory(useAgentChat 的口径),
//    也就是"切过去之前的那个项目";服务端会校验它必须与当前项目一致。这里不做任何特殊处理,
//    与其他入口完全一样 —— 切完目录弹窗会关掉,不构成问题。
//
// 懒加载：父组件用 defineAsyncComponent 引它,zen-ai-chat-ui 那一大坨只在这块真的渲染时
// 才进 bundle(最近项目面板在 App 首屏上,不能为它拖进整个组件库)。
import { computed, onBeforeUnmount } from 'vue'
import { ChatContainer } from 'zen-ai-chat-ui'
// 组件库样式要由**每个消费方自己引**:Vite 只随各自的异步 chunk 注入,
// 漏了这行就是整块面板无样式裸奔(与 EditorAgentPanel.vue 同一个坑,2026-09-27 实测过)。
import 'zen-ai-chat-ui/style.css'
import type { PresetQuestion } from 'zen-ai-chat-ui'
import { $t } from '@/lang/static'
import { useAgentChat } from '@/composables/useAgentChat'
import { useThemeObserver } from '@/composables/useThemeObserver'
import { AGENT_ASSISTANT_NAME, agentQuestionLabels } from '@/utils/agentConversations'

const props = defineProps<{
  /** 这批目录的状态(与发给 /api/recent_directories/summary 的是同一份,原样转发给服务端) */
  dirStatus: unknown[]
  /** 界面上那段自动解读的原文:用户说"那第二个呢"时指的就是它 */
  summary?: string
}>()

const { theme } = useThemeObserver()
const chatTheme = computed<'light' | 'dark'>(() => (theme.value === 'dark' ? 'dark' : 'light'))

// 独立实例：与智能体视图的「对话」Tab、文件空间面板互不影响(同一套 useAgentChat,各自一份 runs)
const {
  messages,
  isStreaming,
  pendingQuestion,
  answeringQuestion,
  sendMessage,
  answerQuestion,
  stop,
} = useAgentChat()

const questionLabels = agentQuestionLabels()

/**
 * 开场白里的建议问题。这块地方没有输入提示词可抄,用户第一次看到多半不知道该问什么 ——
 * 给两句"拿到这批状态之后最自然会问的",点一下就能跑起来。
 */
const presetQuestions = computed<PresetQuestion[]>(() => [
  {
    id: 'priority',
    label: $t('@13D1C:这些项目该先处理哪个？'),
    prompt: $t('@13D1C:这些项目里该先处理哪个？按优先级给我一个处理顺序，并说明每一项该做什么。'),
  },
  {
    id: 'behind',
    label: $t('@13D1C:哪些项目落后远端？'),
    prompt: $t('@13D1C:哪些项目落后远端？分别落后多少个提交？'),
  },
])

async function onSend(payload: { text: string; files: any[] }) {
  await sendMessage(payload.text, payload.files, {
    // 固定内置 g ai(见文件头取舍 1)
    engine: 'gai',
    dirStatus: props.dirStatus,
    dirSummary: props.summary,
  })
}

onBeforeUnmount(() => {
  // 关弹窗时把还在跑的这一轮停掉:否则服务端会继续生成完再落盘,
  // 用户回来时那条会话已经躺在智能体视图里,而他记得自己明明关掉了。
  stop()
})
</script>

<template>
  <div class="dir-chat">
    <ChatContainer
      :messages="messages"
      :assistant-name="AGENT_ASSISTANT_NAME"
      :theme="chatTheme"
      :disabled="isStreaming"
      :generating="isStreaming"
      :show-avatar="false"
      :upload-config="{ enabled: false }"
      :placeholder="isStreaming
        ? $t('@13D1C:g ai 正在回答...')
        : $t('@13D1C:追问 g ai：这批项目该怎么处理？')"
      :welcome-title="$t('@13D1C:可以接着问 g ai')"
      :welcome-description="$t('@13D1C:它已经拿到了这批目录的 Git 状态，可以直接问该先处理哪个、某个项目落后了什么。')"
      :preset-questions="presetQuestions"
      :question="pendingQuestion"
      :question-submitting="answeringQuestion"
      :question-labels="questionLabels"
      @send="onSend"
      @stop="stop"
      @answer="answerQuestion"
    />
  </div>
</template>

<style scoped>
/* 一块固定高的对话区:上面是列表与那段解读,这里只占"够问一句、够看一段回答"的高度。
   固定高度是必需的 —— 库的 ChatContainer 是 flex:1 铺满父级的,父级没有确定高度时
   它会按内容长到天上去,把上面的目录列表整个挤出弹窗。 */
.dir-chat {
  display: flex;
  height: min(340px, 34vh);
  min-height: 200px;
  margin-top: var(--spacing-sm);
  border-top: 1px solid var(--border-color-light);
  padding-top: var(--spacing-sm);
}

/* ChatContainer 根节点(.acu-chat)吃满这块高度,滚动留给它内部 */
.dir-chat > :deep(.acu-chat) {
  flex: 1;
  min-width: 0;
}

/* ── 开场白瘦身 ──────────────────────────────────────────────────────────
   库里那套开场白是给整页对话设计的(56px 图标 + 大标题 + 描述 + 两列问题卡,
   上下还各留 32px),塞进这 300px 高的条里会被裁掉一头。这里只砍尺寸、不砍内容:
   标题、说明、两个可点的问题都留着 —— 它们正是"不知道能问什么"时的入口。
   图标去掉是因为这块地方头上已经有「AI 项目状态解读」标题了,再顶一个头像纯属重复。 */
.dir-chat :deep(.acu-welcome) {
  padding: var(--spacing-base);
}
.dir-chat :deep(.acu-welcome-logo) {
  display: none;
}
.dir-chat :deep(.acu-welcome-title) {
  font-size: var(--font-size-lg);
  margin-bottom: var(--spacing-xs);
}
.dir-chat :deep(.acu-welcome-desc) {
  font-size: var(--font-size-sm);
  margin-bottom: var(--spacing-base);
}
.dir-chat :deep(.acu-welcome-grid) {
  gap: var(--spacing-sm);
}
</style>

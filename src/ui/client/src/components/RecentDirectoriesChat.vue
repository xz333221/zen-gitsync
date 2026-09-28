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
  /** 撑满父级剩余高度(切换工作目录弹窗 / 最近项目面板的右栏)。默认 false = 底部那一块固定高的条 */
  fill?: boolean
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
 * 给几句"拿到这批状态之后最自然会问的",点一下就能跑起来。
 *
 * 前两句是"问状态"(先处理哪个 / 谁落后了),后两句是**承接状态的动作**(落后就拉、
 * 脏工作区就看看改了什么)——后两句正是看完解读之后最常用的处置,不写在这儿用户得自己
 * 敲一遍"落后远端的有哪些"再补一句"都帮我 pull 下"。
 * 库里的问题是两列网格,四条正好铺满两行 —— 这也是这块固定高的条能装下的上限
 * (再添一条开场白就装不下了,得连下面 .dir-chat 的高度一起改)。
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
  {
    // 与上一条连着用:先看清谁落后,再一句"都拉一下"。工作区不干净时由模型自己判断
    // 该不该先 stash(模型手上有 dirStatus,看得见未提交数),这里不替它预设策略。
    id: 'pull-behind',
    label: $t('@13D1C:落后远端的都帮我 pull 下代码'),
    prompt: $t('@13D1C:落后远端的项目都帮我 pull 下代码，逐个执行并汇报结果。'),
  },
  {
    id: 'uncommitted',
    label: $t('@13D1C:看一下各项目未提交的都改了什么'),
    prompt: $t('@13D1C:看一下各项目未提交的改动都改了什么，按项目列出来。'),
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

/**
 * 开场白问题卡点击。**必须接 `@select`,否则点了完全没反应** ——
 * 组件库的 WelcomeScreen 只 `emit('select', q)`、ChatContainer 原样往上传,
 * 没有"默认自动发送"的兜底(对比 followup 的 onFollowupSelect 是会自动发的)。
 * 不接就是死按钮:没有报错、没有 loading,什么都不发生。
 *
 * 走 onSend 而不是另起一条路径 —— 问题卡的 prompt 与用户手输的文本在服务端看来
 * 完全等价,上下文(engine / dirStatus / dirSummary)必须与输入框那条一模一样。
 */
async function onSelectPreset(q: PresetQuestion) {
  await onSend({ text: q.prompt, files: [] })
}

onBeforeUnmount(() => {
  // 关弹窗时把还在跑的这一轮停掉:否则服务端会继续生成完再落盘,
  // 用户回来时那条会话已经躺在智能体视图里,而他记得自己明明关掉了。
  stop()
})
</script>

<template>
  <div class="dir-chat" :class="{ 'dir-chat--fill': fill }">
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
      @select="onSelectPreset"
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
  /* 420 而不是 340:问题卡从两条变成四条,开场白整体高了一行多(~95px),固定高得跟着涨,
     否则每次打开都能看见开场白被顶掉一截。上限仍受 42vh 约束 —— 窗口矮的时候宁可让开场白
     自己滚(见下面 .acu-welcome),也不要把上面的目录列表整个挤走。 */
  height: min(420px, 42vh);
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

/* fill:全屏弹窗右栏 —— 不再用固定高度,而是吃掉父级(解读块)剩下的全部高度。
   父级是 flex column + min-height:0 链,这里 flex:1 + min-height:0 即可;
   高度不确定时 ChatContainer 会长到天上,所以父级那条高度链必须完整。 */
.dir-chat--fill {
  flex: 1 1 auto;
  height: auto;
  min-height: 0;
}

/* ── 开场白瘦身 ──────────────────────────────────────────────────────────
   库里那套开场白是给整页对话设计的(56px 图标 + 大标题 + 描述 + 两列问题卡,
   上下还各留 32px),塞进这块几百像素高的条里会被裁掉一头。这里只砍尺寸、不砍内容:
   标题、说明、四条可点的问题都留着 —— 它们正是"不知道能问什么"时的入口。
   图标去掉是因为这块地方头上已经有「AI 项目状态解读」标题了,再顶一个头像纯属重复。 */
.dir-chat :deep(.acu-welcome) {
  padding: var(--spacing-base);
  /* 四条卡在矮窗口里(42vh 生效时)会高过这块条:让开场白自己滚,别让内容溢出到
     下面的输入框上面。align-items 换成 flex-start 是必需的 —— 居中溢出时上半截
     会被顶到滚不到的地方;居中的效果改由 inner 的 margin-block:auto 兜(有富余空间
     时它照旧居中,没空间时自动退化成 0,也就是顶端对齐)。 */
  align-items: flex-start;
  overflow-y: auto;
}
.dir-chat :deep(.acu-welcome-inner) {
  margin-block: auto;
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

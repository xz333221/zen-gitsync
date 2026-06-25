<!--
  JobLogDetails.vue
  共享的"执行日志"折叠面板，WorkbenchView 子任务行 + ExecutionLogManager 卡片复用。
  - 单 prop: job（Job 或 JobFull，结构兼容）
  - 自带 copy / displayOutput 截断（不依赖父组件），彻底解耦
  - 视觉：单轮 job 内部用 zen-ai-chat-ui 的 ChatContainer 渲染对话
    · 用户提示词 → 右侧气泡（user 消息）
    · Claude 思考 → 左侧气泡内可折叠思考块（assistant.reasoning）
    · 模型返回  → 左侧气泡正文（assistant.content，Markdown 渲染 + 流式光标）
  - 简单任务的"续聊"由父组件 v-for 多轮叠加，天然形成纵向对话流；
    续聊输入框在父组件，本组件隐藏 ChatContainer 自带输入框（避免多输入框冲突）。
-->
<!--
  注:本组件历史上用 <details> 元素,但 <details> 子级的 div 不能正确继承
  height: 100% / min-height: 100% / position: absolute top:0 bottom:0,
  导致模型返回区无法用 flex 收敛到父级剩余高度(踩过的真实坑)。
  改用普通 <div> + 自定义 summary 按钮(@click toggle body 显隐),
  让外层 div 真正拿到父级高度,内部 flex column 正常收敛。
-->
<template>
  <div
    class="wb-log-details"
    :class="{
      'is-running': isActive,
      'is-pending': job.status === 'pending',
      'is-finished': isFinished
    }"
  >
    <div class="wb-log-summary" @click="toggleOpen" role="button" :aria-expanded="!isCollapsed">
      <span class="wb-log-summary__left">
        <span v-if="job.status === 'running'" class="wb-log-summary__status wb-log-summary__status--running">
          <span class="wb-log-summary__label">{{ $t('@WORKBENCH:正在执行…') }}</span>
          <span class="wb-log-dots" aria-hidden="true">
            <span class="wb-log-dots__dot"></span>
            <span class="wb-log-dots__dot"></span>
            <span class="wb-log-dots__dot"></span>
          </span>
          <span v-if="elapsedLabel" class="wb-log-summary__elapsed">{{ elapsedLabel }}</span>
        </span>
        <span v-else-if="job.status === 'pending'" class="wb-log-summary__status wb-log-summary__status--pending">
          <span class="wb-log-summary__label">{{ $t('@WORKBENCH:排队中…') }}</span>
          <span class="wb-log-dots" aria-hidden="true">
            <span class="wb-log-dots__dot"></span>
            <span class="wb-log-dots__dot"></span>
            <span class="wb-log-dots__dot"></span>
          </span>
        </span>
        <span v-else-if="isFinished" :class="['wb-log-summary__status', finishedStatusClass]">
          <span class="wb-log-summary__icon">{{ finishedStatusIcon }}</span>
          <span class="wb-log-summary__label">{{ finishedStatusLabel }}</span>
          <span v-if="elapsedLabel" class="wb-log-summary__elapsed">{{ elapsedLabel }}</span>
        </span>
        <span v-else>{{ $t('@WORKBENCH:查看执行日志') }}</span>
      </span>
      <span class="wb-log-summary__right">
        <span class="wb-log-summary__meta">
          {{ (job.output || '').length }} {{ $t('@WORKBENCH:字符') }}
        </span>
        <button
          type="button"
          class="wb-log-copy"
          :title="$t('@WORKBENCH:复制全部（含提示词与输出）')"
          :aria-label="$t('@WORKBENCH:复制全部')"
          @click.stop="copyAll"
        >
          ⧉
        </button>
      </span>
    </div>

    <!--
      body 容器:用 zen-ai-chat-ui 的 ChatContainer 渲染单轮对话。
      隐藏 ChatContainer 自带的输入框(acu-chat-footer),续聊输入由父组件统一承载。
      下方保留"重新执行"footer。
    -->
    <div v-show="!isCollapsed" class="wb-log-details__body">
      <ChatContainer
        :messages="chatMessages"
        :assistant-name="assistantLabel"
        :show-avatar="false"
        theme="auto"
        class="wb-job-chat"
      />

      <!-- footer:任务结束后显示"重新执行",运行中不显示 -->
      <footer v-if="canReExecute" class="wb-chat__foot">
        <button
          type="button"
          class="wb-chat__action"
          :title="$t('@WORKBENCH:用相同的提示词重新执行此任务')"
          :aria-label="$t('@WORKBENCH:重新执行')"
          @click="onReExecute"
        >
          ↻
        </button>
      </footer>

      <!-- 全屏查看 dialog -->
      <el-dialog
        v-model="fullscreenOpen"
        :title="$t('@WORKBENCH:模型返回 - 全屏查看')"
        fullscreen
        :close-on-click-modal="false"
        class="wb-log-fullscreen-dialog"
        @closed="onFullscreenClosed"
      >
        <div ref="fullscreenContainerRef" class="wb-log-fullscreen">
          <MarkdownRenderer
            v-if="hasOutput"
            :source="fullscreenSource"
            class="wb-log-fullscreen__render"
          />
          <div v-else class="wb-log-fullscreen__empty">{{ $t('@WORKBENCH:（暂无输出）') }}</div>
        </div>
      </el-dialog>
    </div><!-- /.wb-log-details__body -->
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
// 模型对话 UI 改为引用 zen-ai-chat-ui(本地 chat-ui 项目发布的组件库)
import { ChatContainer, MarkdownRenderer, type ChatMessage, type MessageStatus } from 'zen-ai-chat-ui'
import 'zen-ai-chat-ui/style.css'
import { $t } from '@/lang/static'
import type { Job, JobStatus } from '@/types/workbench'

const props = defineProps<{ job: Job }>()
const emit = defineEmits<{
  (e: 're-execute', job: Job): void
}>()

/* 默认展开:任务执行后用户期望看到完整对话流,不要收起。
   ExecutionLogManager 50+ 条历史卡顿的担心:已经在 ExecutionLogManager 父级
   限定 .exec-card 容器高度 + 内部 scroll,JobLogDetails 这里只需保持"展开"即可,
   性能由父级虚拟/分页承担。 */
const isCollapsed = ref(false)
function toggleOpen() { isCollapsed.value = !isCollapsed.value }
// 模板里用作 is-running class 条件,必须先于任何 watch 定义。
const isActive = computed(() => props.job.status === 'running' || props.job.status === 'pending')

// 新一轮 job 重新激活(running/pending)时,自动展开,避免用户上轮手动
// 折叠的偏好带到下轮。完成态保持用户当前选择不变。
watch(() => props.job.status, (s, prev) => {
  const wasActive = prev === 'running' || prev === 'pending'
  const nowActive = s === 'running' || s === 'pending'
  if (!wasActive && nowActive) {
    isCollapsed.value = false
  }
})

const MAX_LOG_DISPLAY = 64 * 1024
function displayOutput(): string {
  const raw = props.job.output || ''
  if (!raw) return ''
  if (raw.length <= MAX_LOG_DISPLAY) return raw
  return `${$t('@WORKBENCH:…（前文已截断）')}\n${raw.slice(-MAX_LOG_DISPLAY)}`
}
/* thinking 也走 64KB 截断,跟 displayOutput 同语义。
   之前没截断的隐患:thinking 在模板里直接展示,50 条全展开时
   巨型 thinking 单条可达数百 KB,光 DOM 内插就足以让主线程卡顿。 */
function displayThinking(): string {
  const raw = props.job.thinking || ''
  if (!raw) return ''
  if (raw.length <= MAX_LOG_DISPLAY) return raw
  return `${$t('@WORKBENCH:…（前文已截断）')}\n${raw.slice(-MAX_LOG_DISPLAY)}`
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* 权限拒绝 / 非安全上下文 → 走 textarea 兜底 */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

async function copyAll() {
  const sections: string[] = []
  if (props.job.prompt) sections.push(`## ${$t('@WORKBENCH:用户提示词')}\n\n${props.job.prompt}`)
  if (props.job.thinking) sections.push(`## ${$t('@WORKBENCH:Claude 思考')}\n\n${props.job.thinking}`)
  if (props.job.output) sections.push(`## ${$t('@WORKBENCH:模型返回')}\n\n${props.job.output}`)
  if (!sections.length) {
    ElMessage.warning($t('@WORKBENCH:暂无内容可复制'))
    return
  }
  const ok = await copyToClipboard(sections.join('\n\n---\n\n'))
  if (ok) ElMessage.success($t('@WORKBENCH:已复制到剪贴板'))
  else ElMessage.error($t('@WORKBENCH:复制失败'))
}

const isFinished = computed(() => {
  const s = props.job.status
  return s === 'done' || s === 'error' || s === 'cancelled'
})
// 终态分三态：done → 绿色执行完成，cancelled → 灰色已停止，error → 红色执行出错
const finishedStatusClass = computed(() => {
  if (props.job.status === 'cancelled') return 'wb-log-summary__status--cancelled'
  if (props.job.status === 'error') return 'wb-log-summary__status--error'
  return 'wb-log-summary__status--done'
})
const finishedStatusIcon = computed(() => {
  if (props.job.status === 'cancelled') return '⏹'
  if (props.job.status === 'error') return '✗'
  return '✓'
})
const finishedStatusLabel = computed(() => {
  if (props.job.status === 'cancelled') return $t('@WORKBENCH:已停止')
  if (props.job.status === 'error') return $t('@WORKBENCH:执行出错')
  return $t('@WORKBENCH:执行完成')
})

// ── zen-ai-chat-ui 消息映射 ────────────────────────────────────────────
// 把单轮 Job 映射成 ChatContainer 的 messages 数组:
//   job.prompt        → user 消息(右气泡)
//   job.thinking      → assistant.reasoning(可折叠思考块)
//   job.output        → assistant.content(Markdown 正文 + 流式光标)
//   job.status        → message.status(streaming 光标 / pending 打字点 / done / error)
// 流式状态由 message.status 驱动,不再需要自定义 typewriter。
// Claude 为产品名,中英文一致,无需走 i18n
const assistantLabel = 'Claude'

function mapStatus(s: JobStatus, hasContent: boolean): MessageStatus {
  if (s === 'running' || s === 'pending') {
    // 有任何输出(思考或正文)→ streaming(显示光标/思考流式);否则 pending(打字点)
    return hasContent ? 'streaming' : 'pending'
  }
  if (s === 'error') return 'error'
  // done / cancelled → done(cancelled 保留已有输出,不显示错误)
  return 'done'
}

const chatMessages = computed<ChatMessage[]>(() => {
  const j = props.job
  const msgs: ChatMessage[] = []
  const createdAt = j.startedAt ? new Date(j.startedAt).getTime() : Date.now()

  if (j.prompt) {
    msgs.push({
      id: `${j.id}-u`,
      role: 'user',
      content: j.prompt,
      status: 'done',
      createdAt
    })
  }

  const outputText = displayOutput()
  const thinkingText = displayThinking()
  const hasOutput = !!outputText
  const hasThinking = !!thinkingText
  const hasContent = hasOutput || hasThinking
  const status = mapStatus(j.status, hasContent)

  msgs.push({
    id: `${j.id}-a`,
    role: 'assistant',
    content: outputText,
    reasoning: hasThinking ? thinkingText : undefined,
    // 有思考:思考阶段(output 为空)→ streaming 思考块;output 出现后 → done 折叠
    reasoningStatus: hasThinking
      ? (hasOutput ? 'done' : (status === 'streaming' ? 'streaming' : 'done'))
      : undefined,
    status,
    error: status === 'error' ? (j.error || undefined) : undefined,
    createdAt
  })

  return msgs
})

// 耗时统计:从 running 起累计,完成时定格
const startedAt = ref<number | null>(null)
watch(() => props.job.status, (s, prev) => {
  if (s === 'running' && prev !== 'running') {
    startedAt.value = startedAt.value ?? Date.now()
  }
})
const elapsedLabel = computed(() => {
  if (!startedAt.value) return ''
  const startMs = startedAt.value
  const endMs = props.job.endedAt
    ? new Date(props.job.endedAt).getTime()
    : Date.now()
  const sec = Math.max(0, Math.floor((endMs - startMs) / 1000))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}分${s.toString().padStart(2, '0')}秒`
})

// 全屏查看：dialog 打开时显示完整 output(无截断),关闭后回到 inline 视图
const fullscreenOpen = ref(false)
const hasOutput = computed(() => !!(props.job.output && props.job.output.length))
const fullscreenSource = computed(() => props.job.output || '')
const fullscreenContainerRef = ref<HTMLElement | null>(null)

// 进入全屏后,若日志还在流式追加,保持滚到底
watch(fullscreenOpen, async (open) => {
  if (!open) return
  await nextTick()
  if (fullscreenContainerRef.value) fullscreenContainerRef.value.scrollTop = fullscreenContainerRef.value.scrollHeight
})
watch(
  () => (props.job.output || '').length,
  async () => {
    if (!fullscreenOpen.value) return
    await nextTick()
    if (fullscreenContainerRef.value) fullscreenContainerRef.value.scrollTop = fullscreenContainerRef.value.scrollHeight
  }
)

function onFullscreenClosed() {
  // el-dialog 关闭后清理:确保下次打开重新挂载 ref
}

// ── 重新执行 ────────────────────────────────────────────────────────
// 仅在任务处于终态 + 有 prompt 时才显示"重新执行"按钮
// 父组件在 v-for 模式下需要根据 job 上下文(所属 task/subtask)决定如何重跑
const canReExecute = computed(() => {
  return isFinished.value && !!(props.job.prompt)
})
function onReExecute() {
  emit('re-execute', props.job)
}
</script>

<style scoped>
/* 与原 WorkbenchView wb-log-* 同款，scoped 到本组件，互不污染 */
.wb-log-details {
  margin-top: 6px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm, 4px);
  background: var(--bg-code);
  overflow: auto;
  display: flex;
  flex-direction: column;
  flex: 1 1 0%;
  min-height: 0;
  height: 100%;
}

/* body 容器:flex column,ChatContainer 占满剩余高度,footer 固定底部 */
.wb-log-details__body {
  display: flex;
  flex-direction: column;
  flex: 1 1 0%;
  min-height: 0;
  overflow: hidden;
}

/* ChatContainer 容器:占满 body 剩余高度,隐藏自带输入框(续聊由父组件承载) */
.wb-job-chat {
  flex: 1;
  min-height: 0;
}
.wb-job-chat :deep(.acu-chat-footer) {
  display: none;
}
/* 让 zen-ai-chat-ui 的背景融入 zen-git 代码区背景 */
.wb-job-chat :deep(.acu-chat) {
  background: transparent;
}
/* 贴合原有气泡密度:略微收紧内边距 */
.wb-job-chat :deep(.acu-message-list-inner) {
  padding: 10px 12px 14px;
  gap: 10px;
}
.wb-job-chat :deep(.acu-bubble) {
  font-size: 12px;
}
.wb-job-chat :deep(.acu-bubble-name) {
  font-size: 10px;
}

.wb-log-summary {
  cursor: pointer;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-secondary);
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
}
.wb-log-summary:hover { background: var(--tint-primary-06); }
.wb-log-summary__left {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.wb-log-summary__right {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.wb-log-summary__meta {
  font-size: 11px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.wb-log-copy {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
  background: var(--bg-container);
  border: 1px solid var(--border-color-medium);
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.wb-log-copy:hover {
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
  border-color: color-mix(in srgb, var(--color-primary) 35%, transparent);
  color: var(--color-primary);
}
.wb-log-copy:active {
  background: color-mix(in srgb, var(--color-primary) 18%, transparent);
}
.wb-log-copy:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--color-primary) 50%, transparent);
  outline-offset: 1px;
}

/* ── 重新执行 footer ────────────────────────────────────────────────── */
.wb-chat__foot {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  padding: 4px 10px 6px;
  border-top: 1px solid color-mix(in srgb, var(--border-color) 60%, transparent);
  background: color-mix(in srgb, var(--text-tertiary) 3%, transparent);
  flex-shrink: 0;
}
.wb-chat__action {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 500;
  color: #6d28d9;
  background: color-mix(in srgb, #8b5cf6 10%, var(--bg-container));
  border: 1px solid color-mix(in srgb, #8b5cf6 30%, transparent);
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  user-select: none;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.wb-chat__action:hover {
  background: color-mix(in srgb, #8b5cf6 18%, var(--bg-container));
  border-color: color-mix(in srgb, #8b5cf6 50%, transparent);
  color: #5b21b6;
}
.wb-chat__action:active {
  background: color-mix(in srgb, #8b5cf6 26%, var(--bg-container));
}
.wb-chat__action:focus-visible {
  outline: 2px solid color-mix(in srgb, #8b5cf6 50%, transparent);
  outline-offset: 1px;
}

/* ── 全屏查看 dialog ──────────────────────────────────────── */
.wb-log-fullscreen-dialog .el-dialog__body {
  padding: 0 16px 16px;
  height: calc(100vh - 54px);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.wb-log-fullscreen {
  flex: 1;
  min-height: 0;
  display: flex;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm, 4px);
  background: var(--bg-code);
  overflow: hidden;
}
.wb-log-fullscreen__render {
  flex: 1;
  min-height: 0;
  padding: 14px 18px;
  font-size: 13px;
  line-height: 1.65;
  color: var(--text-primary);
  overflow: auto;
}
.wb-log-fullscreen__render :deep(pre) { margin: 8px 0; }
.wb-log-fullscreen__empty {
  padding: 14px 18px;
  color: var(--text-tertiary);
  font-style: italic;
}

/* ── 运行中 / 排队中 / 完成 视觉指示 ──────────────────────────────────────── */
.wb-log-summary__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 12px;
}
.wb-log-summary__status--running {
  color: var(--color-warning-dark, #b45309);
}
.wb-log-summary__status--pending {
  color: var(--color-primary);
}
.wb-log-summary__status--done {
  color: var(--color-success-dark, #15803d);
}
/* cancelled 用中性灰（与 statusColor.ts 里 cancelled=#9ca3af 对齐），区别于 error 红和 done 绿 */
.wb-log-summary__status--cancelled {
  color: #9ca3af;
}
.wb-log-summary__status--error {
  color: var(--color-danger, #ef4444);
}
.wb-log-summary__icon {
  font-size: 13px;
  line-height: 1;
}
.wb-log-summary__elapsed {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  margin-left: 2px;
}

/* 三点跳动动画:左→右 错相位 1.4s 循环 */
.wb-log-dots {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: -2px;
}
.wb-log-dots__dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.35;
  animation: wb-log-dot-bounce 1.4s ease-in-out infinite;
}
.wb-log-dots__dot:nth-child(2) { animation-delay: 0.2s; }
.wb-log-dots__dot:nth-child(3) { animation-delay: 0.4s; }

/* 状态行背景:running 暖色,pending 主色,done 绿色 */
.wb-log-details.is-running .wb-log-summary {
  background: color-mix(in srgb, var(--color-warning, #f59e0b) 8%, transparent);
}
.wb-log-details.is-pending .wb-log-summary {
  background: color-mix(in srgb, var(--color-primary) 6%, transparent);
}
.wb-log-details.is-finished .wb-log-summary {
  background: color-mix(in srgb, var(--color-success, #22c55e) 6%, transparent);
}

/* 完成时整条详情面板闪一下绿光,持续 1.5s 后渐隐,吸引注意力 */
.wb-log-details.is-finished {
  animation: wb-log-finished-flash 1.5s ease-out;
}

@keyframes wb-log-dot-bounce {
  0%, 80%, 100% { opacity: 0.3; transform: translateY(0); }
  40% { opacity: 1; transform: translateY(-2px); }
}
@keyframes wb-log-finished-flash {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-success, #22c55e) 50%, transparent); }
  60% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-success, #22c55e) 0%, transparent); }
  100% { box-shadow: 0 0 0 0 transparent; }
}

@media (prefers-reduced-motion: reduce) {
  .wb-log-dots__dot,
  .wb-log-details.is-finished {
    animation: none;
  }
}
</style>

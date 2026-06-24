<!--
  JobLogDetails.vue
  共享的"执行日志"折叠面板，WorkbenchView 子任务行 + ExecutionLogManager 卡片复用。
  - 单 prop: job（Job 或 JobFull，结构兼容）
  - 自带 copy / displayOutput 截断（不依赖父组件），彻底解耦
  - 视觉：单轮 job 内部按"对话气泡"组织
    · 用户提示词 → 右侧气泡（蓝）
    · Claude 思考 → 左侧气泡（紫，可折叠）
    · 模型返回  → 左侧气泡（紫，带"重新执行"按钮）
  - 简单任务的"续聊"由父组件 v-for 多轮叠加，天然形成纵向对话流。
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
      body 容器:对话气泡列表,纵向堆叠,气泡间用 gap 分隔。
      用户气泡靠右,AI 气泡靠左,用 is-user / is-ai 区分。
    -->
    <div v-show="!isCollapsed" class="wb-log-details__body wb-chat">
      <!-- 用户提示词气泡：靠右 -->
      <div v-if="job.prompt" class="wb-chat__row is-user">
        <div class="wb-chat__bubble wb-chat__bubble--user">
          <header class="wb-chat__head">
            <span class="wb-chat__tag wb-chat__tag--user">{{ $t('@WORKBENCH:用户提示词') }}</span>
            <span class="wb-chat__count">{{ (job.prompt || '').length }} {{ $t('@WORKBENCH:字符') }}</span>
            <button
              type="button"
              class="wb-log-copy wb-log-copy--sm"
              :title="$t('@WORKBENCH:复制用户提示词')"
              :aria-label="$t('@WORKBENCH:复制用户提示词')"
              @click.stop="copyField('prompt')"
            >
              ⧉
            </button>
          </header>
          <pre class="wb-chat__pre wb-chat__pre--user">{{ job.prompt }}</pre>
        </div>
      </div>

      <!-- Claude 思考过程气泡：靠左(紫),默认折叠 -->
      <div v-if="job.thinking" class="wb-chat__row is-ai">
        <div class="wb-chat__bubble wb-chat__bubble--think">
          <header
            class="wb-chat__head"
            role="button"
            :aria-expanded="thinkingOpen"
            @click="toggleThinking"
          >
            <span class="wb-chat__toggle-icon" :class="{ 'is-expanded': thinkingOpen }" aria-hidden="true">▸</span>
            <span class="wb-chat__tag wb-chat__tag--think">{{ $t('@WORKBENCH:Claude 思考') }}</span>
            <span class="wb-chat__count">{{ (job.thinking || '').length }} {{ $t('@WORKBENCH:字符') }}</span>
            <button
              type="button"
              class="wb-log-copy wb-log-copy--sm"
              :title="$t('@WORKBENCH:复制思考内容')"
              :aria-label="$t('@WORKBENCH:复制思考内容')"
              @click.stop="copyField('thinking')"
            >
              ⧉
            </button>
          </header>
          <pre v-show="thinkingOpen" class="wb-chat__pre wb-chat__pre--think">{{ displayThinking() }}</pre>
        </div>
      </div>

      <!-- 模型返回气泡：靠左(紫),主内容 -->
      <div class="wb-chat__row is-ai">
        <div class="wb-chat__bubble wb-chat__bubble--ai">
          <header class="wb-chat__head">
            <span class="wb-chat__tag wb-chat__tag--ai">{{ $t('@WORKBENCH:模型返回') }}</span>
            <span class="wb-chat__count">{{ (job.output || '').length }} {{ $t('@WORKBENCH:字符') }}</span>
            <button
              type="button"
              class="wb-log-copy wb-log-copy--sm"
              :title="$t('@WORKBENCH:复制模型返回')"
              :aria-label="$t('@WORKBENCH:复制模型返回')"
              @click.stop="copyField('output')"
            >
              ⧉
            </button>
            <button
              type="button"
              class="wb-log-copy wb-log-copy--sm"
              :title="$t('@WORKBENCH:全屏查看模型返回')"
              :aria-label="$t('@WORKBENCH:全屏查看模型返回')"
              :disabled="!hasOutput"
              @click.stop="fullscreenOpen = true"
            >
              ⛶
            </button>
          </header>
          <div class="wb-chat__body">
            <MarkdownRender
              v-if="hasOutput"
              :content="displayText"
              :final="isFinalReached"
              :typewriter="false"
              class="wb-chat__render"
            />
            <div v-else class="wb-chat__empty">{{ $t('@WORKBENCH:（暂无输出）') }}</div>
          </div>
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
        </div>
      </div>

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
          <MarkdownRender
            v-if="hasOutput"
            :content="fullscreenDisplayText"
            :final="isFinalReached"
            :typewriter="false"
            class="wb-log-fullscreen__render"
          />
          <div v-else class="wb-log-fullscreen__empty">{{ $t('@WORKBENCH:（暂无输出）') }}</div>
        </div>
      </el-dialog>
    </div><!-- /.wb-log-details__body -->
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { MarkdownRender } from 'markstream-vue'
import { $t } from '@/lang/static'
import type { Job } from '@/types/workbench'

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
   之前没截断的隐患:thinking 在模板里直接 <pre>{{ job.thinking }}</pre>,50 条全展开时
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

async function copyField(field: 'prompt' | 'thinking' | 'output') {
  const text = (props.job as any)[field] || ''
  if (!text) {
    ElMessage.warning($t('@WORKBENCH:暂无内容可复制'))
    return
  }
  const ok = await copyToClipboard(text)
  if (ok) ElMessage.success($t('@WORKBENCH:已复制到剪贴板'))
  else ElMessage.error($t('@WORKBENCH:复制失败'))
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

// MarkdownRender 的输入:
// - outputText:模型返回完整文本(走 displayOutput 截断策略)
// - isActive:status 是 running/pending,标识任务在流式生成
// - isFinished:流是否结束(done/error/cancelled),决定是否启用 typewriter
// - visibleLength:自己控制的 typewriter 进度。markstream-vue 自带的 typewriter
//   在 catch-up 模式下会瞬间刷出,看不到逐字效果,所以这里改成:
//   1) visibleLength 跟踪 outputText 长度,以 ~50 CPS 速度追上
//   2) 用 displayText = outputText.slice(0, visibleLength) 喂给 markstream
//   3) 已完成 job 直接 visibleLength = full(全量展示,不动画)
const outputText = computed(() => displayOutput())
// isActive 已提前到上面与 isCollapsed 一起定义(避免 TDZ 报错)
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

// 自定义 typewriter:visibleLength 从 0 累加到 outputText.length
const visibleLength = ref(0)
let typewriterTimer: ReturnType<typeof setInterval> | null = null
const TYPEWRITER_CPS = 60 // 字符/秒,可调

function startTypewriter() {
  stopTypewriter()
  typewriterTimer = setInterval(() => {
    const target = outputText.value.length
    if (target === 0) {
      visibleLength.value = 0
      stopTypewriter()
      return
    }
    // 按 TYPEWRITER_CPS 字符/秒的速度累加
    const step = Math.max(1, Math.ceil(TYPEWRITER_CPS / 30))
    if (visibleLength.value < target) {
      visibleLength.value = Math.min(target, visibleLength.value + step)
    }
    if (visibleLength.value >= target) {
      // 追上了,停定时器(但 watch 会在下次 output 增长时重新启动)
      stopTypewriter()
    }
  }, 33) // 约 30fps
}

function stopTypewriter() {
  if (typewriterTimer) {
    clearInterval(typewriterTimer)
    typewriterTimer = null
  }
}

// watch output 长度变化:
// - 已完成 job:visibleLength 直接 = full(全量,无动画)
// - running/pending:启动累加器
watch(
  () => [props.job.output?.length || 0, props.job.status] as const,
  ([len, status]) => {
    if (status === 'done' || status === 'error' || status === 'cancelled') {
      // 任务完成 → 直接全量展示
      stopTypewriter()
      visibleLength.value = len
    } else {
      // 任务在跑:启动累加器(如果还没追上)
      if (visibleLength.value < len && !typewriterTimer) {
        startTypewriter()
      }
    }
  },
  { immediate: true }
)

// 组件卸载时清理定时器
onUnmounted(() => stopTypewriter())

// displayText:截断到 visibleLength,喂给 markstream-vue
const displayText = computed(() => outputText.value.slice(0, visibleLength.value))
const fullscreenDisplayText = computed(() => (props.job.output || '').slice(0, visibleLength.value))
// :final 仅在显示追上时传 true,避免 markstream 提前 end-streaming
const isFinalReached = computed(() => visibleLength.value >= (props.job.output || '').length)

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

/**
 * 思考区自动展开/合上:
 * - 默认按 status 自动控制(运行中有内容时展开,完成后合上)
 * - 用户手动点 header 改 open 后,本组件生命周期内不再覆盖(尊重用户)
 * - job 状态从未活跃 → 活跃(新一轮开始)时,清掉用户覆盖标记
 */
let thinkingUserOverride = false
const thinkingOpen = ref(false)
function toggleThinking() {
  thinkingUserOverride = true
  thinkingOpen.value = !thinkingOpen.value
}

function recomputeThinkingOpen() {
  if (thinkingUserOverride) return
  // 输出已经有内容 → 思考阶段已结束,合上思考区把屏幕让给模型返回
  if ((props.job.output || '').length > 0) {
    thinkingOpen.value = false
    return
  }
  const s = props.job.status
  if (s === 'running' || s === 'pending') {
    thinkingOpen.value = (props.job.thinking || '').length > 0
  } else {
    thinkingOpen.value = false
  }
}

// 任务重新进入活跃态 → 清掉用户覆盖
watch(() => props.job.status, (s, prev) => {
  const wasActive = prev === 'running' || prev === 'pending'
  const isActive = s === 'running' || s === 'pending'
  if (!wasActive && isActive) {
    thinkingUserOverride = false
  }
  recomputeThinkingOpen()
})

// thinking 长度变化 → 重新计算(运行中长度 > 0 就展开)
watch(() => (props.job.thinking || '').length, () => recomputeThinkingOpen(), { immediate: true })

// output 长度变化 → 模型开始返回时折叠思考区,把屏幕让给输出
watch(() => (props.job.output || '').length, () => recomputeThinkingOpen())

// 全屏查看：dialog 打开时显示完整 output(无截断),关闭后回到 inline 视图
const fullscreenOpen = ref(false)
const hasOutput = computed(() => !!(props.job.output && props.job.output.length))
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

/* body 容器:对话气泡列表,纵向堆叠 */
.wb-log-details__body {
  display: flex;
  flex-direction: column;
  flex: 1 1 0%;
  min-height: 0;
  overflow: auto;
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
.wb-log-copy--sm {
  padding: 1px 6px;
  font-size: 10px;
}

/* ── 对话气泡布局 ────────────────────────────────────────────────── */
.wb-chat {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background: var(--bg-code);
}
.wb-chat__row {
  display: flex;
  width: 100%;
  min-width: 0;
}
.wb-chat__row.is-user { justify-content: flex-end; }
.wb-chat__row.is-ai   { justify-content: flex-start; }

/* 气泡本体:最大宽度 85%,留出对齐侧的小尾巴空间 */
.wb-chat__bubble {
  max-width: 85%;
  min-width: 0;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-container);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.wb-chat__bubble--user {
  border-color: color-mix(in srgb, var(--color-primary) 35%, transparent);
  background: color-mix(in srgb, var(--color-primary) 5%, var(--bg-container));
}
.wb-chat__bubble--ai {
  border-color: color-mix(in srgb, #8b5cf6 35%, transparent);
  background: color-mix(in srgb, #8b5cf6 4%, var(--bg-container));
}
.wb-chat__bubble--think {
  border-color: color-mix(in srgb, #8b5cf6 25%, transparent);
  background: color-mix(in srgb, #8b5cf6 2%, var(--bg-container));
}

.wb-chat__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 11px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--text-tertiary) 6%, transparent);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  user-select: none;
}
.wb-chat__bubble--think .wb-chat__head { cursor: pointer; }

.wb-chat__tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.3px;
  text-transform: uppercase;
}
.wb-chat__tag--user {
  background: color-mix(in srgb, var(--color-primary) 18%, transparent);
  color: var(--color-primary);
}
.wb-chat__tag--ai {
  background: color-mix(in srgb, #8b5cf6 18%, transparent);
  color: #6d28d9;
}
.wb-chat__tag--think {
  background: color-mix(in srgb, #8b5cf6 18%, transparent);
  color: #6d28d9;
}

.wb-chat__toggle-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  font-size: 10px;
  color: var(--text-tertiary);
  transition: transform 0.15s ease;
  flex-shrink: 0;
}
.wb-chat__toggle-icon.is-expanded { transform: rotate(90deg); }

.wb-chat__count {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.wb-chat__pre {
  margin: 0;
  padding: 8px 12px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-primary);
  background: transparent;
  max-height: 800px;
  overflow: auto;
}
.wb-chat__pre--user {
  background: transparent;
}
.wb-chat__pre--think {
  font-style: italic;
  color: var(--text-secondary);
  max-height: 600px;
}

.wb-chat__body {
  padding: 6px 12px 4px;
  min-height: 24px;
}
.wb-chat__render {
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-primary);
}
/* 强制 markstream-vue 不开 content-visibility:auto,否则 flex 父容器拿不到真实高度 */
.wb-chat__render,
.wb-chat__render.markdown-renderer {
  content-visibility: visible;
  contain-intrinsic-size: auto;
}
.wb-chat__render :deep(pre) { margin: 6px 0; }
.wb-chat__render :deep(code) {
  font-family: var(--font-mono, ui-monospace, monospace);
}
.wb-chat__empty {
  color: var(--text-tertiary);
  font-size: 12px;
  font-style: italic;
  padding: 4px 0;
}

.wb-chat__foot {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  padding: 4px 10px 6px;
  border-top: 1px solid color-mix(in srgb, var(--border-color) 60%, transparent);
  background: color-mix(in srgb, var(--text-tertiary) 3%, transparent);
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

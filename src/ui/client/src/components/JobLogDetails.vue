<!--
  JobLogDetails.vue
  共享的"执行日志"折叠面板，WorkbenchView 子任务行 + ExecutionLogManager 卡片复用。
  - 单 prop: job（Job 或 JobFull，结构兼容）
  - 自带 copy / displayOutput 截断（不依赖父组件），彻底解耦
  - 替换原 WorkbenchView L1252-1335 的 <details> 块
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
        <span v-else-if="isFinished" class="wb-log-summary__status wb-log-summary__status--done">
          <span v-if="job.status === 'error'" class="wb-log-summary__icon">✗</span>
          <span v-else class="wb-log-summary__icon">✓</span>
          <span class="wb-log-summary__label">
            {{ job.status === 'error' ? $t('@WORKBENCH:执行出错') : $t('@WORKBENCH:执行完成') }}
          </span>
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
          @click.stop="copyAll"
        >
          ⧉ {{ $t('@WORKBENCH:复制全部') }}
        </button>
      </span>
    </div>

    <!--
      body 容器:真正的 flex column 布局。让 wb-log-pre flex: 1 收敛到剩余空间。
    -->
    <div v-show="!isCollapsed" class="wb-log-details__body">
    <!-- 用户提示词 -->
    <!--
      展开策略:默认一直展开(用户提示词是输入,展开方便回看),
      用户可手动合上,尊重用户选择。
    -->
    <details
      v-if="job.prompt"
      class="wb-log-section"
      :open="promptOpen"
      @toggle="onPromptToggle"
    >
      <summary class="wb-log-section__summary">
        <span class="wb-log-section__tag wb-log-section__tag--user">
          {{ $t('@WORKBENCH:用户提示词') }}
        </span>
        <span class="wb-log-section__count">
          {{ (job.prompt || '').length }} {{ $t('@WORKBENCH:字符') }}
        </span>
        <button
          type="button"
          class="wb-log-copy wb-log-copy--sm"
          :title="$t('@WORKBENCH:复制用户提示词')"
          @click.stop="copyField('prompt')"
        >
          ⧉ {{ $t('@WORKBENCH:复制') }}
        </button>
      </summary>
      <pre class="wb-log-section__pre wb-log-section__pre--user">{{ job.prompt }}</pre>
    </details>

    <!-- Claude 思考过程 -->
    <!--
      展开策略:
      - 任务运行中(thinking 已有内容) → 展开,方便用户实时看到 AI 思考过程
      - 任务结束(done/error/cancelled) → 合上,让出屏幕给"模型返回"区
      - 用户手动展开/合上后,本次会话内尊重用户的选择(不强行覆盖)
    -->
    <details
      v-if="job.thinking"
      class="wb-log-section"
      :open="thinkingOpen"
      @toggle="onThinkingToggle"
    >
      <summary class="wb-log-section__summary">
        <span class="wb-log-section__tag wb-log-section__tag--think">
          {{ $t('@WORKBENCH:Claude 思考') }}
        </span>
        <span class="wb-log-section__count">
          {{ (job.thinking || '').length }} {{ $t('@WORKBENCH:字符') }}
        </span>
        <button
          type="button"
          class="wb-log-copy wb-copy--sm"
          :title="$t('@WORKBENCH:复制思考内容')"
          @click.stop="copyField('thinking')"
        >
          ⧉ {{ $t('@WORKBENCH:复制') }}
        </button>
      </summary>
      <pre class="wb-log-section__pre wb-log-section__pre--think">{{ job.thinking }}</pre>
    </details>

    <!-- 模型返回 -->
    <div class="wb-log-pre__head">
      <span class="wb-log-pre__label">{{ $t('@WORKBENCH:模型返回') }}</span>
      <span class="wb-log-pre__meta">
        {{ (job.output || '').length }} {{ $t('@WORKBENCH:字符') }}
      </span>
      <button
        type="button"
        class="wb-log-copy wb-log-copy--sm"
        :title="$t('@WORKBENCH:复制模型返回')"
        @click.stop="copyField('output')"
      >
        ⧉ {{ $t('@WORKBENCH:复制') }}
      </button>
      <button
        type="button"
        class="wb-log-copy wb-log-copy--sm"
        :title="$t('@WORKBENCH:全屏查看模型返回')"
        :disabled="!hasOutput"
        @click.stop="fullscreenOpen = true"
      >
        ⛶ {{ $t('@WORKBENCH:全屏') }}
      </button>
    </div>
    <div ref="preRef" class="wb-log-pre">
      <MarkdownRender
        v-if="hasOutput"
        :content="displayText"
        :final="isFinalReached"
        :typewriter="false"
        class="wb-log-pre__render"
      />
      <div v-else class="wb-log-pre__empty">{{ $t('@WORKBENCH:（暂无输出）') }}</div>
    </div>

    <!-- 全屏查看 -->
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

/* 折叠状态:与历史上 <details> open 的语义对齐。
   本组件历史上用 <details> 元素,但 <details> 子级 div 不接受 height: 100% /
   min-height: 100% / position: absolute 撑满,导致 flex 子级无法收敛。
   改用普通 div + v-show 模拟 <details> 行为,外层 div 拿到显式 height。 */
const isCollapsed = ref(false)
function toggleOpen() { isCollapsed.value = !isCollapsed.value }

// 展开策略：默认展开。用户希望「任务执行时日志需要能直接看到」，
// 不再仅在 running/pending 状态自动展开。运行结束/异常后日志仍可直接查阅。
/* 历史保留:autoOpen 表达式改由 isCollapsed 控制显隐(见模板 v-show="!isCollapsed")。
   函数体删除,只留注释占位避免外部 import 误用。 */

const MAX_LOG_DISPLAY = 64 * 1024
function displayOutput(): string {
  const raw = props.job.output || ''
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
const isActive = computed(() => props.job.status === 'running' || props.job.status === 'pending')
const isFinished = computed(() => {
  const s = props.job.status
  return s === 'done' || s === 'error' || s === 'cancelled'
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

// 流式追加时自动滚到底：仅当面板展开时滚动
const preRef = ref<HTMLElement | null>(null)

/**
 * 思考区自动展开/合上:
 * - 默认按 status 自动控制(运行中有内容时展开,完成后合上)
 * - 用户手动点 summary 改 open 后,本组件生命周期内不再覆盖(尊重用户)
 * - job 状态从未活跃 → 活跃(新一轮开始)时,清掉用户覆盖标记
 *
 * 实现要点:`<details :open="thinkingOpen">` 的 open 是个 prop,
 * Vue 不会"双向同步"用户点击造成的状态变化(@toggle 事件能拿到事件后状态),
 * 所以需要在 @toggle 里手动同步 + 设标记
 */
let thinkingUserOverride = false
const thinkingOpen = ref(false)

function recomputeThinkingOpen() {
  if (thinkingUserOverride) return
  const s = props.job.status
  if (s === 'running' || s === 'pending') {
    thinkingOpen.value = (props.job.thinking || '').length > 0
  } else {
    thinkingOpen.value = false
  }
}

function onThinkingToggle(e: Event) {
  const el = e.target as HTMLDetailsElement
  thinkingUserOverride = true
  thinkingOpen.value = el.open
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

// 用户提示词区:默认展开;用户可手动合上,尊重用户选择(新一轮开始时重置)
let promptUserOverride = false
const promptOpen = ref(true)
function onPromptToggle(e: Event) {
  const el = e.target as HTMLDetailsElement
  promptUserOverride = true
  promptOpen.value = el.open
}
watch(() => props.job.status, (s, prev) => {
  const wasActive = prev === 'running' || prev === 'pending'
  const isActive = s === 'running' || s === 'pending'
  if (!wasActive && isActive) {
    // 新一轮开始 → 重置用户覆盖 + 重新展开
    promptUserOverride = false
    promptOpen.value = true
  } else if (!promptUserOverride) {
    promptOpen.value = true
  }
  // 用户覆盖后保持用户的选择
})

watch(
  () => (props.job.output || '').length,
  async () => {
    if (isCollapsed.value) return
    await nextTick()
    if (preRef.value) preRef.value.scrollTop = preRef.value.scrollHeight
  }
)

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
</script>

<style scoped>
/* 与原 WorkbenchView wb-log-* 同款，scoped 到本组件，互不污染 */
.wb-log-details {
  margin-top: 6px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm, 4px);
  background: var(--bg-code);
  overflow: hidden;
  /* 撑满父容器剩余高度,让模型返回区填满。
     历史上用 <details> 元素 + display: flex,Chromium 不能正确收缩 flex 子级;
     改用普通 div + flex column 后正常工作。 */
  display: flex;
  flex-direction: column;
  flex: 1 1 0%;
  min-height: 0;
  height: 100%;
}

/* body 容器:summary 之外的所有内容在这里 flex column 布局,
   wb-log-pre flex: 1 收敛到剩余空间。 */
.wb-log-details__body {
  display: flex;
  flex-direction: column;
  flex: 1 1 0%;
  min-height: 0;
  overflow: hidden;
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
.wb-log-pre__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-top: 1px solid var(--border-color);
  background: var(--bg-subtle, var(--bg-container));
  font-size: 11px;
  color: var(--text-secondary);
}
.wb-log-pre__label {
  flex: 1;
  font-weight: 600;
  letter-spacing: 0.3px;
  text-transform: uppercase;
}
.wb-log-pre__meta {
  font-size: 11px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.wb-log-pre {
  margin: 0;
  padding: 8px 10px;
  /* flex: 1 1 0% 在 flex column 父里收敛到剩余空间,让模型返回区填满。 */
  flex: 1 1 0%;
  min-height: 0;
  overflow: auto;
  background: var(--bg-code);
}
.wb-log-pre__render {
  /* MarkdownRender 自带根容器样式,这里只补全边距让它贴合容器 */
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-primary);
}
/* 强制覆盖 markstream-vue 默认的 content-visibility: auto
   content-visibility: auto 会让浏览器对未滚到视口的部分用 contain-intrinsic-size
   假高度(800x600)渲染,导致 flex 父容器拿不到真实内容高度,
   子级 wb-log-pre 的 overflow: auto 永远不触发滚动。
   改为 visible 后浏览器立即按真实尺寸布局,父级 max-height 约束生效。
   注:.markdown-renderer 节点本身就是 .wb-log-pre__render(class 同时存在),
   所以直接在 wb-log-pre__render 上覆盖即可,不用 :deep 找后代。 */
.wb-log-pre__render,
.wb-log-pre__render.markdown-renderer {
  content-visibility: visible;
  contain-intrinsic-size: auto;
}
.wb-log-pre__render :deep(pre) {
  margin: 6px 0;
}
.wb-log-pre__render :deep(code) {
  font-family: var(--font-mono, ui-monospace, monospace);
}
.wb-log-pre__empty {
  color: var(--text-tertiary);
  font-size: 12px;
  font-style: italic;
  padding: 4px 0;
}
.wb-log-section {
  border-top: 1px solid var(--border-color);
}
.wb-log-section__summary {
  list-style: none;
  cursor: pointer;
  padding: 5px 10px;
  font-size: 11px;
  color: var(--text-secondary);
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: var(--bg-subtle, var(--bg-container));
}
.wb-log-section__summary::-webkit-details-marker { display: none; }
.wb-log-section__summary:hover { background: var(--tint-primary-06); }
.wb-log-section__tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.3px;
  text-transform: uppercase;
}
.wb-log-section__tag--user {
  background: var(--tint-warning-14);
  color: var(--color-warning-dark, #b45309);
}
.wb-log-section__tag--think {
  background: var(--tint-think-14);
  color: var(--color-think-dark, #6d28d9);
}
.wb-log-section__count {
  font-size: 10px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.wb-log-section__pre {
  margin: 0;
  padding: 8px 10px;
  max-height: 800px;
  overflow: auto;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.wb-log-section__pre--user {
  background: var(--tint-warning-04, rgba(245, 158, 11, 0.06));
  color: var(--text-primary);
  border-left: 2px solid var(--tint-warning-45, rgba(245, 158, 11, 0.45));
}
.wb-log-section__pre--think {
  background: var(--tint-think-04, rgba(139, 92, 246, 0.06));
  color: var(--text-secondary);
  border-left: 2px solid var(--tint-think-45, rgba(139, 92, 246, 0.45));
  font-style: italic;
}

/* ── 全屏查看 dialog ──────────────────────────────────────── */
.wb-log-fullscreen-dialog .el-dialog__body {
  /* 顶到屏幕底,不浪费屏幕高度 */
  padding: 0 16px 16px;
  height: calc(100vh - 54px); /* 减去 el-dialog__header */
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
.wb-log-fullscreen__render :deep(pre) {
  margin: 8px 0;
}
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

/* 模型返回区左侧条带颜色,跟状态行对应 */
.wb-log-details.is-running .wb-log-pre {
  border-left: 2px solid var(--color-warning, #f59e0b);
}
.wb-log-details.is-pending .wb-log-pre {
  border-left: 2px solid color-mix(in srgb, var(--color-primary) 50%, transparent);
}
.wb-log-details.is-finished .wb-log-pre {
  border-left: 2px solid color-mix(in srgb, var(--color-success, #22c55e) 60%, transparent);
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

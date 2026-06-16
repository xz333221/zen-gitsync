<!--
  JobLogDetails.vue
  共享的"执行日志"折叠面板，WorkbenchView 子任务行 + ExecutionLogManager 卡片复用。
  - 单 prop: job（Job 或 JobFull，结构兼容）
  - 自带 copy / displayOutput 截断（不依赖父组件），彻底解耦
  - 替换原 WorkbenchView L1252-1335 的 <details> 块
-->
<template>
  <details
    class="wb-log-details"
    :class="{ 'is-running': isActive, 'is-pending': job.status === 'pending' }"
    :open="autoOpen"
  >
    <summary class="wb-log-summary">
      <span class="wb-log-summary__left">
        <span v-if="job.status === 'running'" class="wb-log-summary__status">
          <span class="wb-log-pulse" aria-hidden="true"></span>
          <span class="wb-log-summary__status-text">{{ $t('@WORKBENCH:正在执行…') }}</span>
        </span>
        <span v-else-if="job.status === 'pending'" class="wb-log-summary__status">
          <span class="wb-log-pulse wb-log-pulse--pending" aria-hidden="true"></span>
          <span class="wb-log-summary__status-text">{{ $t('@WORKBENCH:排队中…') }}</span>
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
    </summary>

    <!-- 用户提示词 -->
    <details v-if="job.prompt" class="wb-log-section">
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
    <details v-if="job.thinking" class="wb-log-section">
      <summary class="wb-log-section__summary">
        <span class="wb-log-section__tag wb-log-section__tag--think">
          {{ $t('@WORKBENCH:Claude 思考') }}
        </span>
        <span class="wb-log-section__count">
          {{ (job.thinking || '').length }} {{ $t('@WORKBENCH:字符') }}
        </span>
        <button
          type="button"
          class="wb-log-copy wb-log-copy--sm"
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
        :content="outputText"
        :final="isFinished"
        :typewriter="streamAnimating"
        class="wb-log-pre__render"
      />
      <div v-else class="wb-log-pre__empty">{{ $t('@WORKBENCH:（暂无输出）') }}</div>
    </div>

    <!-- 全屏查看 -->
    <el-dialog
      v-model="fullscreenOpen"
      :title="$t('@WORKBENCH:模型返回 - 全屏查看')"
      fullscreen
      :close-on-click-modal="true"
      class="wb-log-fullscreen-dialog"
      @closed="onFullscreenClosed"
    >
      <div ref="fullscreenContainerRef" class="wb-log-fullscreen">
        <MarkdownRender
          v-if="hasOutput"
          :content="fullscreenText"
          :final="isFinished"
          :typewriter="streamAnimating"
          class="wb-log-fullscreen__render"
        />
        <div v-else class="wb-log-fullscreen__empty">{{ $t('@WORKBENCH:（暂无输出）') }}</div>
      </div>
    </el-dialog>
  </details>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { MarkdownRender } from 'markstream-vue'
import { $t } from '@/lang/static'
import type { Job } from '@/types/workbench'

const props = defineProps<{ job: Job }>()

// 展开策略：默认展开。用户希望「任务执行时日志需要能直接看到」，
// 不再仅在 running/pending 状态自动展开。运行结束/异常后日志仍可直接查阅。
const autoOpen = computed(() => true)

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
// - outputText:主视图(走 displayOutput 截断策略,内容过长保留尾部 64KB)
// - isFinished:流是否结束(done/error/stopped),结束信号告诉 markstream 完成增量
// - streamAnimating:运行中启用 typewriter 逐字符动画;已结束的 job 进来直接全量展示,不从头动画
const outputText = computed(() => displayOutput())
const isActive = computed(() => props.job.status === 'running' || props.job.status === 'pending')
const isFinished = computed(() => {
  const s = props.job.status
  return s === 'done' || s === 'error' || s === 'cancelled'
})
const streamAnimating = computed(() => {
  const s = props.job.status
  return s === 'running' || s === 'pending'
})

// 流式追加时自动滚到底：仅当面板展开时滚动
const preRef = ref<HTMLElement | null>(null)
watch(
  () => (props.job.output || '').length,
  async () => {
    if (!autoOpen.value) return
    await nextTick()
    if (preRef.value) preRef.value.scrollTop = preRef.value.scrollHeight
  }
)

// 全屏查看：dialog 打开时显示完整 output(无截断),关闭后回到 inline 视图
const fullscreenOpen = ref(false)
const fullscreenText = computed(() => props.job.output || $t('@WORKBENCH:（暂无输出）'))
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
  /* 撑满父容器剩余高度,让模型返回区填满 */
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
.wb-log-summary {
  list-style: none;
  cursor: pointer;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-secondary);
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.wb-log-summary::-webkit-details-marker { display: none; }
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
  /* 撑满 details 内部剩余高度,而不是硬编码 600px */
  flex: 1 1 auto;
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
  overflow: auto;
}
.wb-log-fullscreen__render {
  flex: 1;
  min-height: 0;
  padding: 14px 18px;
  font-size: 13px;
  line-height: 1.65;
  color: var(--text-primary);
}
.wb-log-fullscreen__render :deep(pre) {
  margin: 8px 0;
}
.wb-log-fullscreen__empty {
  padding: 14px 18px;
  color: var(--text-tertiary);
  font-style: italic;
}

/* ── 运行中 / 排队中 视觉指示 ──────────────────────────────────────── */
.wb-log-summary__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--color-warning-dark, #b45309);
}
.wb-log-details.is-running .wb-log-summary {
  background: color-mix(in srgb, var(--color-warning, #f59e0b) 8%, transparent);
  animation: wb-log-pulse-bg 2s ease-in-out infinite;
}
.wb-log-details.is-pending .wb-log-summary {
  background: color-mix(in srgb, var(--color-primary) 6%, transparent);
}
.wb-log-pulse {
  position: relative;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--color-warning, #f59e0b);
  flex-shrink: 0;
}
.wb-log-pulse::after {
  content: '';
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  background: var(--color-warning, #f59e0b);
  opacity: 0.6;
  animation: wb-log-pulse-ring 1.6s ease-out infinite;
}
.wb-log-pulse--pending {
  background: var(--color-primary);
}
.wb-log-pulse--pending::after {
  background: var(--color-primary);
  animation-duration: 2.4s;
}
/* 模型返回区:运行中加微弱的脉冲左边框,提示“正在这里输出” */
.wb-log-details.is-running .wb-log-pre {
  border-left: 2px solid var(--color-warning, #f59e0b);
  animation: wb-log-pulse-border 2s ease-in-out infinite;
}
.wb-log-details.is-pending .wb-log-pre {
  border-left: 2px solid color-mix(in srgb, var(--color-primary) 50%, transparent);
}

@keyframes wb-log-pulse-bg {
  0%, 100% { background: color-mix(in srgb, var(--color-warning, #f59e0b) 6%, transparent); }
  50% { background: color-mix(in srgb, var(--color-warning, #f59e0b) 16%, transparent); }
}
@keyframes wb-log-pulse-ring {
  0% { transform: scale(0.6); opacity: 0.7; }
  100% { transform: scale(2.2); opacity: 0; }
}
@keyframes wb-log-pulse-border {
  0%, 100% { border-left-color: color-mix(in srgb, var(--color-warning, #f59e0b) 50%, transparent); }
  50% { border-left-color: var(--color-warning, #f59e0b); }
}
@media (prefers-reduced-motion: reduce) {
  .wb-log-details.is-running .wb-log-summary,
  .wb-log-pulse::after,
  .wb-log-details.is-running .wb-log-pre {
    animation: none;
  }
  .wb-log-details.is-running .wb-log-summary {
    background: color-mix(in srgb, var(--color-warning, #f59e0b) 10%, transparent);
  }
}
</style>

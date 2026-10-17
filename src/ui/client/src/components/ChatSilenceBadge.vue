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
  「这一轮已经静默多久」—— g ai 四个入口的头部共用这一枚。

  ── 为什么要它 ───────────────────────────────────────────────
  看板的任务卡在静默超过 60 秒时会挂一行「静默 x 分」（jobActivity.silentMsOf），
  但 g ai 对话里没有这个东西：模型卡在网关 / 工具跑完没回显时，气泡上只有一个
  一直在跳的"回答耗时"，读不出"它其实已经十分钟没吐字了"。
  这里把同一件事搬到对话上：距最后一次 SSE 事件多久，数字每秒自己走。

  ── 三条口径 ─────────────────────────────────────────────────
  1. **阈值在这里**（NOTABLE_MS = 10s）：低于它的静默不渲染，
     否则每次长工具调用都会闪一下，反而像噪音。60 秒后转告警色，与看板同一个数
     （看板那边 60 秒才起报，是因为一条任务跑十分钟不吐字很常见；对话正常时
     token 是每秒几十个地到的，10 秒没一条事件就已经卡在等模型 / 等工具回显了）。
  2. **只读原始毫秒**：composable 给 `silentMs`，这里负责"该不该显示 / 什么颜色"，
     不在组件里重新算时间（两份时钟迟早分叉）。
  3. **等回答时不算静默**：调用方传的 `streaming` 要把 `pendingQuestion` 排除掉 ——
     那一轮挂着是在等用户点选项，不是模型卡住了。
-->
<template>
  <span
    v-if="visible"
    class="chat-silence"
    :class="{ 'is-warn': warn }"
    :title="$t('@AGENT:已经有一段时间没有收到模型的输出与工具调用了')"
  >
    <span class="chat-silence__dot" aria-hidden="true" />
    {{ $t('@AGENT:静默 {elapsed}', { elapsed: formatDurationMs(silentMs) }) }}
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { $t } from '@/lang/static'
import { formatDurationMs } from '@/utils/relativeTime'

/** 低于这个静默不显示（理由见文件头第 1 条） */
const NOTABLE_MS = 10 * 1000
/** 静默到这一刻换成告警色（与看板「静默 x 分」同一个门槛） */
const WARN_MS = 60 * 1000

const props = withDefaults(defineProps<{
  /** 距最后一次 SSE 事件的毫秒数；null = 不在跑 / 还没收到过事件 */
  silentMs?: number | null
  /** 这一轮是否还在生成（等回答时应传 false，见文件头第 3 条） */
  streaming?: boolean
}>(), {
  silentMs: null,
  streaming: false,
})

const visible = computed(() =>
  props.streaming && props.silentMs !== null && props.silentMs >= NOTABLE_MS
)
const warn = computed(() => (props.silentMs ?? 0) >= WARN_MS)
</script>

<style scoped>
/* 平铺的一行字，不是胶囊（本仓库对"圆角 + 单 border"的态度见 feedback 记忆/UI 审计）。
   数字用 tabular-nums：每秒跳一次，比例字宽会让旁边的引擎选择器跟着左右抖。 */
.chat-silence {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  font-size: var(--font-size-xs);
  line-height: 1;
  color: var(--text-meta);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.chat-silence__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
/* 告警档：与看板卡片上「静默 x 分」同一个色值，两处看到的是同一件事 */
.chat-silence.is-warn {
  color: var(--color-warning-dark);
}
.chat-silence.is-warn .chat-silence__dot {
  animation: chat-silence-pulse 1.6s var(--ease-custom) infinite;
}
@keyframes chat-silence-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}
@media (prefers-reduced-motion: reduce) {
  .chat-silence.is-warn .chat-silence__dot { animation: none; }
}
</style>

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
<script setup lang="ts">
/**
 * AiDiffSummary —— 在文件差异页 / 提交详情页自动生成 AI 差异说明。
 *
 * 功能：
 *   - 当前文件说明（scope=file）：对右侧选中的单个文件生成变更说明
 *   - 整体说明（scope=overall）：对工作区未提交变更 / 整个提交生成整体说明
 *
 * 仅当用户已配置 AI 模型时渲染并自动触发（configStore.models 非空）。
 * 服务端自行取 diff，前端不传 diff 文本。
 *
 * 流式：消费 POST /api/ai/diff-summary 的 SSE 流，逐字渲染 markdown。
 */
import { ref, computed, watch, onBeforeUnmount, onMounted } from 'vue'
import { $t } from '@/lang/static'
import { useConfigStore } from '@stores/configStore'
import MarkdownPreview from '@/components/MarkdownPreview.vue'
import { Refresh, Loading, Warning, MagicStick } from '@element-plus/icons-vue'

type SummaryScope = 'file' | 'overall'
type SummaryStatus = 'idle' | 'loading' | 'done' | 'error' | 'empty' | 'no-model'

interface SummaryState {
  status: SummaryStatus
  text: string
  error: string
}

interface Props {
  /** 差异来源：工作区未提交变更 / 某个提交 */
  source: 'worktree' | 'commit'
  /** source=commit 时的提交哈希 */
  commitHash?: string
  /** 当前选中的文件（仓库相对路径），用于文件级说明；为空则不显示文件卡 */
  file?: string
  /** 文件显示名（可选，默认用 file） */
  fileName?: string
  showFileSummary?: boolean
  showOverallSummary?: boolean
  /** 是否自动触发生成（模型已配置时） */
  auto?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  commitHash: '',
  file: '',
  fileName: '',
  showFileSummary: true,
  showOverallSummary: true,
  auto: true
})

const configStore = useConfigStore()

const hasModel = computed(() => Array.isArray(configStore.models) && configStore.models.length > 0)
const locale = computed(() => (configStore.locale || '').startsWith('en') ? 'en' : 'zh')

const fileState = ref<SummaryState>({ status: 'idle', text: '', error: '' })
const overallState = ref<SummaryState>({ status: 'idle', text: '', error: '' })

// 按 source+hash+scope+file 缓存，避免重复请求（同一文件/提交切换回来直接展示）
const cache = new Map<string, string>()
function cacheKey(scope: SummaryScope): string {
  return `${props.source}|${props.commitHash || ''}|${scope}|${props.file || ''}`
}

let activeAbort: AbortController | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null

async function generate(scope: SummaryScope, force = false) {
  if (!hasModel.value) return
  if (scope === 'file' && !props.file) return
  if (scope === 'overall' && props.source === 'commit' && !props.commitHash) return

  const state = scope === 'file' ? fileState : overallState
  const key = cacheKey(scope)

  // 命中缓存且非强制刷新：直接展示，避免重复消耗额度
  if (!force && cache.has(key)) {
    state.value = { status: 'done', text: cache.get(key) || '', error: '' }
    return
  }

  state.value = { status: 'loading', text: '', error: '' }

  // 取消上一次可能仍在进行的流
  activeAbort?.abort()
  const ac = new AbortController()
  activeAbort = ac

  let acc = ''
  try {
    const body: Record<string, unknown> = {
      scope,
      source: props.source,
      locale: locale.value
    }
    if (scope === 'file') body.file = props.file
    if (props.source === 'commit') body.hash = props.commitHash

    const resp = await fetch('/api/ai/diff-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal
    })
    if (!resp.ok || !resp.body) {
      state.value = { status: 'error', text: '', error: `HTTP ${resp.status}` }
      return
    }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const raw = trimmed.slice(5).trim()
        if (!raw) continue
        let evt: { type?: string; content?: string; error?: string; code?: string }
        try {
          evt = JSON.parse(raw)
        } catch {
          continue
        }
        if (evt.type === 'delta') {
          acc += evt.content || ''
          state.value = { status: 'loading', text: acc, error: '' }
        } else if (evt.type === 'done') {
          state.value = { status: 'done', text: acc, error: '' }
        } else if (evt.type === 'error') {
          if (evt.code === 'NO_MODEL') {
            state.value = { status: 'no-model', text: '', error: evt.error || '' }
          } else if (evt.code === 'EMPTY_DIFF') {
            state.value = { status: 'empty', text: '', error: evt.error || '' }
          } else {
            state.value = { status: 'error', text: '', error: evt.error || $t('@DIFFAI:生成失败') }
          }
        }
      }
    }

    if (state.value.status === 'loading') {
      state.value = { status: acc ? 'done' : 'empty', text: acc, error: '' }
    }
    if (state.value.status === 'done' && acc) {
      cache.set(key, acc)
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') return
    state.value = { status: 'error', text: '', error: err?.message || $t('@DIFFAI:生成失败') }
  }
}

function refresh(scope: SummaryScope) {
  const key = cacheKey(scope)
  cache.delete(key)
  generate(scope, true)
}

function triggerAuto() {
  if (!props.auto || !hasModel.value) return
  if (props.showFileSummary) generate('file')
  if (props.showOverallSummary) generate('overall')
}

function scheduleAuto() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => triggerAuto(), 350)
}

// 依赖变化（文件/提交/来源/模型可用性/显隐开关）时自动触发
watch(
  () => [
    props.file,
    props.commitHash,
    props.source,
    props.showFileSummary,
    props.showOverallSummary,
    hasModel.value,
    props.auto
  ],
  () => scheduleAuto(),
  { immediate: true }
)

onBeforeUnmount(() => {
  activeAbort?.abort()
  if (debounceTimer) clearTimeout(debounceTimer)
})

onMounted(() => {
  // 配置可能在挂载后才加载完成，确保挂载时按当前状态补一次
  if (hasModel.value) scheduleAuto()
})
</script>

<template>
  <div v-if="hasModel" class="ai-diff-summary">
    <!-- 当前文件说明 -->
    <div v-if="showFileSummary && file" class="summary-card">
      <div class="summary-head">
        <span class="summary-title">
          <el-icon class="ai-badge"><MagicStick /></el-icon>
          <span class="summary-label">{{ $t('@DIFFAI:AI 文件说明') }}</span>
          <span class="summary-sub" :title="file">{{ fileName || file }}</span>
        </span>
        <span class="summary-actions">
          <el-icon v-if="fileState.status === 'loading'" class="spin"><Loading /></el-icon>
          <el-button
            text
            size="small"
            :icon="Refresh"
            :disabled="fileState.status === 'loading'"
            :title="$t('@DIFFAI:重新生成')"
            @click="refresh('file')"
          />
        </span>
      </div>
      <div class="summary-body">
        <MarkdownPreview v-if="fileState.text" :content="fileState.text" />
        <div v-else-if="fileState.status === 'loading'" class="summary-placeholder">{{ $t('@DIFFAI:正在生成差异说明...') }}</div>
        <div v-else-if="fileState.status === 'empty'" class="summary-placeholder">{{ $t('@DIFFAI:该文件没有可总结的变更') }}</div>
        <div v-else-if="fileState.status === 'error'" class="summary-error">
          <el-icon><Warning /></el-icon>
          <span class="err-msg">{{ fileState.error }}</span>
          <el-button text size="small" :icon="Refresh" @click="refresh('file')">{{ $t('@DIFFAI:重试') }}</el-button>
        </div>
      </div>
    </div>

    <!-- 整体说明 -->
    <div v-if="showOverallSummary" class="summary-card">
      <div class="summary-head">
        <span class="summary-title">
          <el-icon class="ai-badge"><MagicStick /></el-icon>
          <span class="summary-label">{{ $t('@DIFFAI:AI 整体说明') }}</span>
          <span class="summary-sub">{{ source === 'commit' ? $t('@DIFFAI:本次提交') : $t('@DIFFAI:未提交变更') }}</span>
        </span>
        <span class="summary-actions">
          <el-icon v-if="overallState.status === 'loading'" class="spin"><Loading /></el-icon>
          <el-button
            text
            size="small"
            :icon="Refresh"
            :disabled="overallState.status === 'loading'"
            :title="$t('@DIFFAI:重新生成')"
            @click="refresh('overall')"
          />
        </span>
      </div>
      <div class="summary-body">
        <MarkdownPreview v-if="overallState.text" :content="overallState.text" />
        <div v-else-if="overallState.status === 'loading'" class="summary-placeholder">{{ $t('@DIFFAI:正在生成差异说明...') }}</div>
        <div v-else-if="overallState.status === 'empty'" class="summary-placeholder">{{ $t('@DIFFAI:没有可总结的变更') }}</div>
        <div v-else-if="overallState.status === 'error'" class="summary-error">
          <el-icon><Warning /></el-icon>
          <span class="err-msg">{{ overallState.error }}</span>
          <el-button text size="small" :icon="Refresh" @click="refresh('overall')">{{ $t('@DIFFAI:重试') }}</el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.ai-diff-summary {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md) 0;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-container);
}

.summary-card {
  border: 1px solid var(--border-card);
  border-radius: var(--radius-sm);
  background: var(--bg-icon);
  overflow: hidden;
}

.summary-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-xs) var(--spacing-sm);
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border-card);
}

.summary-title {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  min-width: 0;
}

.ai-badge {
  color: var(--color-primary);
  font-size: var(--font-size-md);
}

.summary-label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  white-space: nowrap;
}

.summary-sub {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}

.summary-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.summary-body {
  padding: var(--spacing-sm);
  max-height: 320px;
  overflow: auto;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  line-height: 1.6;
}

.summary-placeholder {
  color: var(--text-tertiary);
  font-size: var(--font-size-sm);
  padding: var(--spacing-xs) 0;
}

.summary-error {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  color: var(--color-danger, #f56c6c);
  font-size: var(--font-size-sm);

  .err-msg {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.spin {
  animation: ai-spin 1s linear infinite;
  color: var(--color-primary);
}

@keyframes ai-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* 让 MarkdownPreview 内部样式适配暗色卡片 */
.summary-body :deep(.markdown-body) {
  background: transparent;
}
</style>

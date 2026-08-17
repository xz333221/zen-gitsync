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
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ArrowDown, ArrowUp, Loading, Memo, Refresh, Warning } from '@element-plus/icons-vue'
import MarkdownPreview from '@/components/MarkdownPreview.vue'
import { $t } from '@/lang/static'
import { useConfigStore } from '@stores/configStore'

type SummaryScope = 'file' | 'overall'
type SummaryStatus = 'idle' | 'loading' | 'done' | 'error' | 'empty' | 'no-model'

interface SummaryState {
  status: SummaryStatus
  text: string
  error: string
}

interface Props {
  source: 'worktree' | 'commit'
  scope: SummaryScope
  commitHash?: string
  file?: string
  fileName?: string
  /** 当前文件 diff 的修订标记，只用于使工作区文件总结缓存失效。 */
  fileRevision?: string
  /** 整体变更集合的修订标记，只用于使工作区整体总结缓存失效。 */
  revision?: string
  auto?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  commitHash: '',
  file: '',
  fileName: '',
  fileRevision: '',
  revision: '',
  auto: true
})

const configStore = useConfigStore()
const hasModel = computed(() => Array.isArray(configStore.models) && configStore.models.length > 0)
const locale = computed(() => (configStore.locale || '').startsWith('en') ? 'en' : 'zh')
const modelKey = computed(() => {
  const models = Array.isArray(configStore.models) ? configStore.models : []
  const model = models.find(item => item.isDefault) || models[0]
  return model ? `${model.id}|${model.baseURL}|${model.model}` : ''
})
const state = ref<SummaryState>({ status: 'idle', text: '', error: '' })
const collapsed = ref(false)
const cache = new Map<string, string>()
let controller: AbortController | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null

function fingerprint(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${value.length}:${(hash >>> 0).toString(36)}`
}

function cacheKey(): string {
  const base = `${props.source}|${props.commitHash || ''}|${props.scope}|${locale.value}|${modelKey.value}`
  if (props.scope === 'overall') {
    const revision = props.source === 'worktree' ? fingerprint(props.revision) : ''
    return `${base}|${revision}`
  }
  const revision = props.source === 'worktree' ? fingerprint(props.fileRevision) : ''
  return `${base}|${props.file || ''}|${revision}`
}

function restoreState() {
  const cached = cache.get(cacheKey())
  state.value = cached
    ? { status: 'done', text: cached, error: '' }
    : { status: 'idle', text: '', error: '' }
}

function abort() {
  controller?.abort()
  controller = null
}

async function generate(force = false) {
  if (!hasModel.value) return
  if (props.scope === 'file' && !props.file) return
  if (props.source === 'commit' && !props.commitHash) return

  const key = cacheKey()
  if (!force && cache.has(key)) {
    state.value = { status: 'done', text: cache.get(key) || '', error: '' }
    return
  }

  abort()
  const requestController = new AbortController()
  controller = requestController
  state.value = { status: 'loading', text: '', error: '' }

  let content = ''
  const consumeLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const raw = trimmed.slice(5).trim()
    if (!raw) return

    let event: { type?: string; content?: string; error?: string; code?: string }
    try {
      event = JSON.parse(raw)
    } catch {
      return
    }

    if (event.type === 'delta') {
      content += event.content || ''
      state.value = { status: 'loading', text: content, error: '' }
    } else if (event.type === 'done') {
      state.value = { status: 'done', text: content, error: '' }
    } else if (event.type === 'error') {
      const status = event.code === 'NO_MODEL'
        ? 'no-model'
        : event.code === 'EMPTY_DIFF' ? 'empty' : 'error'
      state.value = { status, text: '', error: event.error || $t('@DIFFAI:生成失败') }
    }
  }

  try {
    const body: Record<string, unknown> = { scope: props.scope, source: props.source, locale: locale.value }
    if (props.scope === 'file') body.file = props.file
    if (props.source === 'commit') body.hash = props.commitHash
    if (force) body.bypassCache = true

    const response = await fetch('/api/ai/diff-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: requestController.signal
    })
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      lines.forEach(consumeLine)
    }
    buffer += decoder.decode()
    if (buffer) consumeLine(buffer)

    if (state.value.status === 'loading') {
      state.value = { status: content ? 'done' : 'empty', text: content, error: '' }
    }
    if (state.value.status === 'done' && content) cache.set(key, content)
  } catch (error: any) {
    if (error?.name !== 'AbortError' && controller === requestController) {
      state.value = { status: 'error', text: '', error: error?.message || $t('@DIFFAI:生成失败') }
    }
  } finally {
    if (controller === requestController) controller = null
  }
}

function refresh() {
  cache.delete(cacheKey())
  void generate(true)
}

function triggerAuto() {
  if (!props.auto || !hasModel.value) return
  if (props.scope === 'file' && !props.file) return
  void generate()
}

function scheduleAuto() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(triggerAuto, 350)
}

watch(
  () => [
    props.file,
    props.fileRevision,
    props.revision,
    props.commitHash,
    props.source,
    props.scope,
    hasModel.value,
    locale.value,
    modelKey.value,
    props.auto
  ],
  () => {
    abort()
    restoreState()
    if (!hasModel.value) return
    scheduleAuto()
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  abort()
  if (debounceTimer) clearTimeout(debounceTimer)
})

const title = computed(() => props.scope === 'file'
  ? $t('@DIFFAI:AI 文件说明')
  : $t('@DIFFAI:AI 整体说明'))
const context = computed(() => {
  if (props.scope === 'file') return props.fileName || props.file
  return props.source === 'commit' ? $t('@DIFFAI:本次提交') : $t('@DIFFAI:未提交变更')
})
</script>

<template>
  <section v-if="hasModel" class="ai-diff-summary" :class="`is-${scope}`">
    <header class="summary-head">
      <div class="summary-heading">
        <el-icon class="ai-badge"><Memo /></el-icon>
        <span class="summary-label">{{ title }}</span>
      </div>

      <span class="summary-context" :title="context">{{ context }}</span>
      <div class="summary-actions">
        <el-icon v-if="state.status === 'loading'" class="spin"><Loading /></el-icon>
        <el-button
          text
          size="small"
          :icon="Refresh"
          :disabled="state.status === 'loading'"
          :title="$t('@DIFFAI:重新生成')"
          @click="refresh"
        />
        <el-button
          text
          size="small"
          :icon="collapsed ? ArrowDown : ArrowUp"
          :title="collapsed ? $t('@DIFFAI:展开说明') : $t('@DIFFAI:收起说明')"
          @click="collapsed = !collapsed"
        />
      </div>
    </header>

    <div v-show="!collapsed" class="summary-body">
      <MarkdownPreview v-if="state.text" :content="state.text" :allow-html="false" />
      <div v-else-if="state.status === 'loading'" class="summary-placeholder is-loading">
        {{ $t('@DIFFAI:正在生成差异说明...') }}
      </div>
      <div v-else-if="state.status === 'empty'" class="summary-placeholder">
        {{ scope === 'file' ? $t('@DIFFAI:该文件没有可总结的变更') : $t('@DIFFAI:没有可总结的变更') }}
      </div>
      <div v-else-if="state.status === 'no-model'" class="summary-placeholder">
        {{ state.error }}
      </div>
      <div v-else-if="state.status === 'error'" class="summary-error">
        <el-icon><Warning /></el-icon>
        <span class="err-msg">{{ state.error }}</span>
        <el-button text size="small" :icon="Refresh" @click="refresh">
          {{ $t('@DIFFAI:重试') }}
        </el-button>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.ai-diff-summary {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-container);
  overflow: hidden;
}

.ai-diff-summary.is-overall {
  border-left: 3px solid var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 3%, var(--bg-container));
}

.summary-head {
  min-height: 36px;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: 4px var(--spacing-md);
  background: color-mix(in srgb, var(--bg-panel) 88%, transparent);
}

.summary-heading,
.summary-actions {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
}

.summary-heading { gap: 6px; }
.summary-actions { margin-left: auto; gap: 2px; }
.ai-badge {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--color-primary) 9%, transparent);
  color: color-mix(in srgb, var(--color-primary) 82%, var(--text-primary));
  font-size: 13px;
}
.summary-label {
  color: var(--text-primary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
}

.summary-context {
  min-width: 0;
  overflow: hidden;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
}

.summary-body {
  max-height: 180px;
  min-height: 40px;
  overflow: auto;
  padding: 8px var(--spacing-md) 10px;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

.summary-body :deep(.md-preview) { padding: 0; }
.summary-body :deep(.md-preview p:last-child),
.summary-body :deep(.md-preview ul:last-child),
.summary-body :deep(.md-preview ol:last-child) { margin-bottom: 0; }

.summary-placeholder { color: var(--text-tertiary); line-height: 24px; }
.summary-placeholder.is-loading { color: var(--text-secondary); }
.summary-error {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  color: var(--color-danger, #f56c6c);
}
.err-msg { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spin { animation: ai-spin 1s linear infinite; color: var(--color-primary); }

@keyframes ai-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@media (max-width: 720px) {
  .summary-context { display: none; }
  .summary-head { gap: var(--spacing-xs); padding-inline: var(--spacing-sm); }
  .summary-body { max-height: 140px; padding-inline: var(--spacing-sm); }
}
</style>

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
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Loading, CircleClose } from '@element-plus/icons-vue'
import { $t } from '@/lang/static'

export interface SplitSubtask {
  title: string
  desc: string
}

type Phase = 'idle' | 'running' | 'result' | 'error'

const props = defineProps<{
  modelValue: boolean
  title: string
  desc: string
  taskId?: string
  promptId?: string | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'confirm', subtasks: SplitSubtask[]): void
}>()

// ── 状态 ─────────────────────────────────────────────────────────────────
const phase = ref<Phase>('idle')
const activeTab = ref<'prompt' | 'thinking' | 'raw' | 'confirm'>('prompt')

const systemPrompt = ref('')
const userPrompt = ref('')
const thinkingText = ref('')
const contentText = ref('')
const rawResponse = ref('')
const subtasks = ref<SplitSubtask[]>([])
const errorMessage = ref('')
// 拆分流跑完但 JSON 解析失败：单独存解析错误，
// "确认入库" tab 上展示 + 引导用户去看「原始结果」/「编辑指令」
const parseError = ref('')
const parseStage = ref('')

let abortController: AbortController | null = null
// 每次 start 自增，回调里判断 nonce 是否匹配，过期请求的结果直接丢弃，
// 避免连点 / watch 重复触发时旧流的 abort 把 phase 推到 error
let runNonce = 0

// ── 派生 ─────────────────────────────────────────────────────────────────
const thinkingLen = computed(() => thinkingText.value.length)
const contentLen = computed(() => contentText.value.length)
const canConfirm = computed(() => phase.value === 'result' && subtasks.value.length > 0)
const isRunning = computed(() => phase.value === 'running')

// ── 行为 ─────────────────────────────────────────────────────────────────
// 关闭意图只走 close()（用户点 X / 取消按钮 / ESC / 点遮罩）；
// 不在 watch 的 else 里 abort——el-dialog 在打开瞬间会回弹一次 false，
// 那种"假关闭"会把刚启动的 LLM 流打断。
function close() {
  abortTyping()
  // 用户主动关闭：把 phase 与四个 tab 的数据清回 idle，
  // 配合父组件 v-if 复用 + taskId watch，下一次打开会强制重新初始化。
  // 已确认入库的子任务在父组件的 selectedTask.subtasks 里，不受此影响。
  reset()
  emit('update:modelValue', false)
}

function abortTyping() {
  if (abortController) {
    abortController.abort()
    abortController = null
  }
}

function reset() {
  abortTyping()
  phase.value = 'idle'
  activeTab.value = 'prompt'
  systemPrompt.value = ''
  userPrompt.value = ''
  thinkingText.value = ''
  contentText.value = ''
  rawResponse.value = ''
  subtasks.value = []
  errorMessage.value = ''
  parseError.value = ''
  parseStage.value = ''
}

async function start() {
  if (!props.title.trim()) {
    ElMessage.warning($t('@WORKBENCH:请先填写任务标题'))
    return
  }
  reset()
  const myNonce = ++runNonce
  phase.value = 'running'
  activeTab.value = 'thinking' // 默认展示"思考"tab

  abortController = new AbortController()
  const myController = abortController
  try {
    const resp = await fetch('/api/workbench/tasks/ai-split-subtasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({
        title: props.title,
        desc: props.desc,
        taskId: props.taskId || '',
        promptId: props.promptId || ''
      }),
      signal: myController.signal
    })
    if (myNonce !== runNonce) return // 已被新的 start 接替
    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => '')
      throw new Error(errText || `HTTP ${resp.status}`)
    }

    // ── 消费 SSE 流：每个 "data: {...}" 一帧 ──
    const reader = resp.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buf = ''
    let doneEvent: { subtasks?: SplitSubtask[]; raw?: string; parseError?: string; parseStage?: string } | null = null

    while (true) {
      const { value, done } = await reader.read()
      if (myNonce !== runNonce) return
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload) continue
        let evt: any
        try { evt = JSON.parse(payload) } catch { continue }
        switch (evt.type) {
          case 'meta':
            systemPrompt.value = evt.prompt?.system || ''
            userPrompt.value = evt.prompt?.user || ''
            break
          case 'thinking':
            thinkingText.value += String(evt.delta || '')
            break
          case 'content':
            contentText.value += String(evt.delta || '')
            break
          case 'done':
            doneEvent = evt
            break
          case 'error':
            throw new Error(evt.error || 'AI 拆分失败')
        }
      }
    }

    if (myNonce !== runNonce) return
    if (!doneEvent) throw new Error($t('@WORKBENCH:AI 未返回结果'))

    subtasks.value = Array.isArray(doneEvent.subtasks) ? doneEvent.subtasks : []
    rawResponse.value = doneEvent.raw || contentText.value
    parseError.value = String(doneEvent.parseError || '')
    parseStage.value = String(doneEvent.parseStage || '')
    // 若模型没吐 reasoning_content，给一个占位说明，避免空 tab 误导用户
    if (!thinkingText.value) {
      thinkingText.value = $t('@WORKBENCH:（当前模型未返回独立的思考内容，可切换到「原始结果」查看完整输出）')
    }
    phase.value = 'result'
    // 解析失败 → 直接把用户引到「原始结果」，那里能看到模型实际吐了什么
    activeTab.value = subtasks.value.length > 0
      ? 'confirm'
      : (parseError.value ? 'raw' : 'raw')
  } catch (err: any) {
    console.log('[AI Split] catch err:', { name: err?.name, msg: err?.message, aborted: myController.signal.aborted, nonce: { mine: myNonce, cur: runNonce } })
    if (myNonce !== runNonce) return // 旧请求被替代，不影响当前
    if (err?.name === 'AbortError' || myController.signal.aborted) {
      // 用户主动关闭/被替代——不刷成 error
      return
    }
    phase.value = 'error'
    errorMessage.value = err?.message || String(err)
  } finally {
    if (myNonce === runNonce) abortController = null
  }
}

function confirmImport() {
  if (!canConfirm.value) return
  emit('confirm', subtasks.value.slice())
  emit('update:modelValue', false)
}

function retry() {
  start()
}

// 编辑「原始结果」文本框直接重跑后端的多级解析（不再走 LLM）。
// 用户场景：模型输出里夹了 ASCII 双引号导致解析失败 → 用户在文本框
// 里把引号改成中文「」或加 \ 转义 → 点「重新解析」就能入库。
const reparsing = ref(false)
async function reparse() {
  if (!contentText.value.trim()) {
    ElMessage.warning($t('@WORKBENCH:原始结果为空，无法解析'))
    return
  }
  reparsing.value = true
  try {
    const res = await fetch('/api/workbench/tasks/parse-subtasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: contentText.value })
    }).then(r => r.json())
    if (!res.success) {
      ElMessage.error(res.error || $t('@WORKBENCH:解析失败'))
      return
    }
    subtasks.value = Array.isArray(res.subtasks) ? res.subtasks : []
    parseError.value = String(res.parseError || '')
    parseStage.value = String(res.parseStage || '')
    rawResponse.value = contentText.value
    if (subtasks.value.length > 0) {
      ElMessage.success($t('@WORKBENCH:解析成功，已识别 {n} 个子任务', { n: subtasks.value.length }))
      activeTab.value = 'confirm'
    } else {
      ElMessage.warning($t('@WORKBENCH:仍未解析到子任务，请继续修改原始结果'))
    }
  } catch (err: any) {
    ElMessage.error($t('@WORKBENCH:解析失败: ') + (err?.message || err))
  } finally {
    reparsing.value = false
  }
}

// 打开弹窗时自动启动；关闭意图由 close() 处理（见上注释）
watch(() => props.modelValue, (v) => {
  if (v && phase.value === 'idle') start()
})

// 父组件用 v-if="selectedTask" 复用同一份实例，selectedTask 切换时组件不会被卸载。
// 这里 watch taskId 把 phase/数据清回 idle，避免上一个任务的 LLM 输出
// 残留在新任务上。父组件的 selectedTaskId watch 会同步关闭弹窗，
// 这里的 reset 是双保险：哪怕未来重构去掉父组件的关闭逻辑，状态也不会泄漏。
watch(() => props.taskId, () => {
  reset()
})

// ── 提示词编辑 ──────────────────────────────────────────────────────
// 内联展开：复用 ai-instruction 那种"提示词文本 + 编辑按钮"模式
const editingPrompt = ref(false)
const editedSystemPrompt = ref('')
const savingPrompt = ref(false)

function openEditPrompt() {
  editedSystemPrompt.value = systemPrompt.value
  editingPrompt.value = true
}
async function saveEditedPrompt() {
  if (!editedSystemPrompt.value.trim()) {
    ElMessage.warning($t('@WORKBENCH:指令内容不能为空'))
    return
  }
  savingPrompt.value = true
  try {
    const res = await fetch('/api/workbench/tasks/ai-subtask-instruction', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: editedSystemPrompt.value })
    }).then(r => r.json())
    if (res.success) {
      ElMessage.success($t('@WORKBENCH:已保存指令'))
      editingPrompt.value = false
      // 重跑——用户编辑指令后通常想立刻看到效果
      retry()
    } else {
      ElMessage.error(res.error || $t('@WORKBENCH:保存失败'))
    }
  } catch (err: any) {
    ElMessage.error($t('@WORKBENCH:保存失败: ') + (err?.message || err))
  } finally {
    savingPrompt.value = false
  }
}
function cancelEditPrompt() {
  editingPrompt.value = false
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
    :title="$t('@WORKBENCH:AI 拆分任务')"
    width="800px"
    :close-on-click-modal="false"
    :close-on-press-escape="!isRunning"
    :show-close="!isRunning"
    @close="close"
  >
    <div v-if="isRunning" class="ai-split-status">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>{{ $t('@WORKBENCH:AI 正在拆分…') }}</span>
    </div>
    <div v-else-if="phase === 'error'" class="ai-split-status is-error">
      <el-icon color="#f56c6c"><CircleClose /></el-icon>
      <span>{{ errorMessage }}</span>
    </div>

    <el-tabs v-model="activeTab" class="ai-split-tabs">
      <!-- 1. 提示词 -->
      <el-tab-pane :label="$t('@WORKBENCH:提示词')" name="prompt">
        <div class="ai-split-prompt-actions">
          <el-button size="small" :disabled="isRunning" @click="openEditPrompt">
            {{ $t('@WORKBENCH:编辑指令') }}
          </el-button>
        </div>
        <div v-if="editingPrompt" class="ai-split-prompt-editor">
          <el-input
            v-model="editedSystemPrompt"
            type="textarea"
            :rows="12"
            :placeholder="$t('@WORKBENCH:指令内容')"
          />
          <div class="ai-split-prompt-editor__actions">
            <el-button size="small" @click="cancelEditPrompt">{{ $t('@WORKBENCH:取消') }}</el-button>
            <el-button size="small" type="primary" :loading="savingPrompt" @click="saveEditedPrompt">
              {{ $t('@WORKBENCH:保存并重跑') }}
            </el-button>
          </div>
        </div>
        <pre v-else class="ai-split-pre">{{ systemPrompt || '（等待 LLM 启动…）' }}</pre>
        <h4 class="ai-split-subhead">{{ $t('@WORKBENCH:用户提示词（拼装后）') }}</h4>
        <pre class="ai-split-pre">{{ userPrompt || '（等待 LLM 启动…）' }}</pre>
      </el-tab-pane>

      <!-- 2. 思考 -->
      <el-tab-pane :name="'thinking'">
        <template #label>
          <span>
            {{ $t('@WORKBENCH:思考') }}
            <span v-if="thinkingLen > 0" class="ai-split-tab-count">({{ thinkingLen }})</span>
          </span>
        </template>
        <pre class="ai-split-pre ai-split-pre--think">{{ thinkingText || $t('@WORKBENCH:（暂无输出）') }}</pre>
      </el-tab-pane>

      <!-- 3. 原始结果 -->
      <el-tab-pane :name="'raw'">
        <template #label>
          <span>
            {{ $t('@WORKBENCH:原始结果') }}
            <span v-if="contentLen > 0" class="ai-split-tab-count">({{ contentLen }})</span>
          </span>
        </template>
        <el-alert
          v-if="parseError && phase === 'result'"
          type="warning"
          show-icon
          :closable="false"
          class="ai-split-parse-error"
        >
          <template #title>
            {{ $t('@WORKBENCH:模型返回内容解析失败，无法识别为有效的子任务 JSON') }}
          </template>
          <div class="ai-split-parse-error__detail">{{ parseError }}</div>
          <div class="ai-split-parse-error__hint">
            {{ $t('@WORKBENCH:常见原因：desc 内夹杂了 ASCII 双引号、出现尾随逗号，或输出被截断。可在下方文本框中手动修改后点「重新解析」，或重新生成。') }}
          </div>
          <div class="ai-split-parse-error__actions">
            <el-button size="small" type="primary" :loading="reparsing" @click="reparse">{{ $t('@WORKBENCH:重新解析') }}</el-button>
            <el-button size="small" @click="retry">{{ $t('@WORKBENCH:重新生成') }}</el-button>
            <el-button size="small" @click="activeTab = 'prompt'">{{ $t('@WORKBENCH:去编辑指令') }}</el-button>
          </div>
        </el-alert>
        <div class="ai-split-raw-toolbar" v-if="phase === 'result' || contentText">
          <span class="ai-split-raw-tip">
            {{ $t('@WORKBENCH:可直接编辑下方文本，修正后点「重新解析」即可入库') }}
          </span>
          <el-button size="small" type="primary" :loading="reparsing" :disabled="!contentText.trim()" @click="reparse">
            {{ $t('@WORKBENCH:重新解析') }}
          </el-button>
        </div>
        <el-input
          v-model="contentText"
          type="textarea"
          :rows="14"
          :placeholder="$t('@WORKBENCH:（暂无输出）')"
          :readonly="isRunning"
          class="ai-split-raw-editor"
          resize="none"
        />
      </el-tab-pane>

      <!-- 4. 确认入库 -->
      <el-tab-pane :name="'confirm'" :disabled="subtasks.length === 0">
        <template #label>
          <span>
            {{ $t('@WORKBENCH:确认入库') }}
            <span v-if="subtasks.length > 0" class="ai-split-tab-count">({{ subtasks.length }})</span>
          </span>
        </template>
        <div v-if="subtasks.length === 0" class="ai-split-empty">
          {{ $t('@WORKBENCH:（暂无子任务）') }}
        </div>
        <ul v-else class="ai-split-list">
          <li v-for="(s, i) in subtasks" :key="i" class="ai-split-list__item">
            <div class="ai-split-list__no">{{ i + 1 }}</div>
            <div class="ai-split-list__body">
              <div class="ai-split-list__title">{{ s.title }}</div>
              <div class="ai-split-list__desc">{{ s.desc }}</div>
            </div>
          </li>
        </ul>
      </el-tab-pane>
    </el-tabs>

    <!-- footer 上方的解析失败横幅：用户在任意 tab 都能看到 -->
    <div v-if="parseError && phase === 'result' && subtasks.length === 0" class="ai-split-footer-hint">
      <el-icon color="#e6a23c"><CircleClose /></el-icon>
      <span>{{ $t('@WORKBENCH:解析失败，未能从模型输出中提取出子任务 — 请查看「原始结果」') }}</span>
    </div>

    <template #footer>
      <el-button v-if="phase === 'error' || (phase === 'result' && parseError && subtasks.length === 0)" @click="retry">
        {{ $t('@WORKBENCH:重新生成') }}
      </el-button>
      <el-button @click="close">
        {{ $t('@WORKBENCH:取消') }}
      </el-button>
      <el-button type="primary" :disabled="!canConfirm" @click="confirmImport">
        {{ $t('@WORKBENCH:确认入库') }} ({{ subtasks.length }})
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped lang="scss">
.ai-split-status {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  margin-bottom: var(--spacing-md);
  font-size: 13px;
  color: var(--el-color-primary);

  &.is-error { color: var(--el-color-danger); }

  .is-loading { animation: rotating 2s linear infinite; }
}
@keyframes rotating {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.ai-split-tabs {
  margin-top: -8px;
}
.ai-split-tab-count {
  margin-left: 4px;
  color: var(--text-tertiary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.ai-split-prompt-actions {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
.ai-split-prompt-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}
.ai-split-prompt-editor__actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.ai-split-subhead {
  margin: 12px 0 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.ai-split-pre {
  background: var(--bg-code);
  color: var(--text-primary);
  padding: 10px 12px;
  border-radius: 4px;
  max-height: 280px;
  overflow: auto;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}
.ai-split-pre--think {
  font-style: italic;
  color: var(--text-secondary);
  background: rgba(139, 92, 246, 0.06);
  border-left: 2px solid rgba(139, 92, 246, 0.45);
}

.ai-split-empty {
  text-align: center;
  padding: 32px;
  color: var(--text-tertiary);
  font-size: 13px;
}
.ai-split-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 360px;
  overflow: auto;
}
.ai-split-list__item {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 4px;
}
.ai-split-list__no {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  border-radius: 12px;
  background: var(--el-color-primary);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
}
.ai-split-list__body { min-width: 0; flex: 1; }
.ai-split-list__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}
.ai-split-list__desc {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.ai-split-parse-error {
  margin-bottom: 10px;
}
.ai-split-parse-error__detail {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  margin: 4px 0 6px;
  word-break: break-word;
  color: var(--text-primary);
}
.ai-split-parse-error__hint {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.55;
  margin-bottom: 8px;
}
.ai-split-parse-error__actions {
  display: flex;
  gap: 8px;
}

.ai-split-footer-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 4px;
  background: rgba(230, 162, 60, 0.1);
  color: var(--el-color-warning);
  font-size: 12px;
}

.ai-split-raw-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  padding: 6px 10px;
  border-radius: 4px;
  background: rgba(64, 158, 255, 0.06);
  font-size: 12px;
}
.ai-split-raw-tip {
  color: var(--text-secondary);
}
.ai-split-raw-editor :deep(.el-textarea__inner) {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  line-height: 1.6;
  max-height: 360px;
}
</style>

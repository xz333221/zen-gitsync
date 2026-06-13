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
import { computed, nextTick, ref, watch } from 'vue'
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

let typingTimer: number | null = null
let abortController: AbortController | null = null

// ── 派生 ─────────────────────────────────────────────────────────────────
const thinkingLen = computed(() => thinkingText.value.length)
const contentLen = computed(() => contentText.value.length)
const canConfirm = computed(() => phase.value === 'result' && subtasks.value.length > 0)
const isRunning = computed(() => phase.value === 'running')

// ── 行为 ─────────────────────────────────────────────────────────────────
function close() {
  abortTyping()
  emit('update:modelValue', false)
}

function abortTyping() {
  if (typingTimer) {
    clearInterval(typingTimer)
    typingTimer = null
  }
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
}

async function start() {
  if (!props.title.trim()) {
    ElMessage.warning($t('@WORKBENCH:请先填写任务标题'))
    return
  }
  reset()
  phase.value = 'running'
  activeTab.value = 'thinking' // 默认展示"思考"tab

  abortController = new AbortController()
  try {
    const resp = await fetch('/api/workbench/tasks/ai-split-subtasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: props.title, desc: props.desc, taskId: props.taskId || '' }),
      signal: abortController.signal
    })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(errText || `HTTP ${resp.status}`)
    }
    const data = await resp.json()
    if (!data.success) {
      throw new Error(data.error || 'AI 拆分失败')
    }
    // 一次性拿到结果：前端"打字机"模拟流
    systemPrompt.value = data.prompt?.system || ''
    userPrompt.value = data.prompt?.user || ''
    rawResponse.value = data.raw || ''
    subtasks.value = Array.isArray(data.subtasks) ? data.subtasks : []

    // thinking 用 LLM 原始 content 的"摘要"（用 raw 的前 N 字模拟"思考"过程）
    // 真实 LLM 流才有真 thinking；这里取 raw 的 markdown 块之外的前缀作为"思考"
    const fakeThinking = (() => {
      // raw 形如 {"subtasks": [...]}，没有 thinking 字段
      // 我们给"思考"一个 placeholder 提示，承认这是 LLM 的隐藏工作
      return $t('@WORKBENCH:（AI 内部思考过程，模型未直接返回。可切换到「原始结果」查看 LLM 完整输出。）')
    })()
    thinkingText.value = fakeThinking

    // 用 setInterval 把 contentText 一字一字显示——"打字机"效果
    const fullText = rawResponse.value
    let i = 0
    const chunkSize = 30
    const interval = 20
    typingTimer = window.setInterval(() => {
      if (i >= fullText.length) {
        if (typingTimer) { clearInterval(typingTimer); typingTimer = null }
        // 打字完成 → 切到入库确认
        if (subtasks.value.length > 0) {
          activeTab.value = 'confirm'
        } else {
          activeTab.value = 'raw'
        }
        phase.value = 'result'
        return
      }
      contentText.value = fullText.slice(0, i + chunkSize)
      i += chunkSize
    }, interval)
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      // 用户主动关闭弹窗
    } else {
      phase.value = 'error'
      errorMessage.value = err?.message || String(err)
    }
  } finally {
    abortController = null
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

// 打开弹窗时自动启动
watch(() => props.modelValue, (v) => {
  if (v) {
    if (phase.value === 'idle') start()
  } else {
    if (isRunning.value) abortTyping()
  }
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
        <pre class="ai-split-pre">{{ contentText || $t('@WORKBENCH:（暂无输出）') }}</pre>
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

    <template #footer>
      <el-button v-if="phase === 'error'" @click="retry">
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
</style>

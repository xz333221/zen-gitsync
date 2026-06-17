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
import { computed, nextTick, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CircleClose, Promotion, ChatLineRound, Refresh, Clock } from '@element-plus/icons-vue'
import { $t } from '@/lang/static'
import type { SplitSubtask } from './AISplitDialog.vue'

type Phase = 'idle' | 'streaming' | 'error'

interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  subtasks?: SplitSubtask[]
  raw?: string
  parseError?: string
  parseStage?: string
}

interface SessionMeta {
  sessionId: string
  title: string
  taskId: string
  createdAt: string
  updatedAt: string
  messageCount: number
  latestSubtaskCount: number
  size: number
}

const props = defineProps<{
  title: string
  desc: string
  taskId?: string
  promptId?: string | null
  initialSessionId?: string | null
}>()

const emit = defineEmits<{
  (e: 'confirm', subtasks: SplitSubtask[]): void
}>()

// ── 状态 ─────────────────────────────────────────────────────────────────
const phase = ref<Phase>('idle')
const sessionId = ref<string>('')
const turns = ref<ChatTurn[]>([])
const draftMessage = ref('')
const errorMessage = ref('')

let abortController: AbortController | null = null
let runNonce = 0
const streamEl = ref<HTMLElement | null>(null)

const isStreaming = computed(() => phase.value === 'streaming')

// ── 历史抽屉 ──────────────────────────────────────────────────────────
const historyDrawerVisible = ref(false)
const historyLoading = ref(false)
const historyList = ref<SessionMeta[]>([])

// ── 行为 ─────────────────────────────────────────────────────────────────
function scrollToBottom() {
  if (!streamEl.value) return
  streamEl.value.scrollTop = streamEl.value.scrollHeight
}

async function send() {
  const text = draftMessage.value.trim()
  if (!text || isStreaming.value) return
  // 新建会话(无 sessionId)时必须有 title
  if (!sessionId.value && !props.title.trim()) {
    ElMessage.warning($t('@WORKBENCH:请先填写任务标题'))
    return
  }

  const myNonce = ++runNonce
  abortController = new AbortController()
  const myController = abortController

  // 乐观把 user 消息推入 turns
  const userTurn: ChatTurn = { role: 'user', content: text }
  turns.value.push(userTurn)
  draftMessage.value = ''
  // 占位 assistant turn,边流边填充
  const assistantTurn: ChatTurn = { role: 'assistant', content: '', thinking: '' }
  turns.value.push(assistantTurn)
  phase.value = 'streaming'
  await nextTick()
  scrollToBottom()

  try {
    const resp = await fetch('/api/workbench/tasks/ai-chat-split', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        sessionId: sessionId.value,
        title: props.title,
        desc: props.desc,
        taskId: props.taskId || '',
        promptId: props.promptId || '',
        userMessage: text
      }),
      signal: myController.signal
    })
    if (myNonce !== runNonce) return
    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => '')
      throw new Error(errText || `HTTP ${resp.status}`)
    }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buf = ''
    let doneEvent: any = null
    let echoReceived = false
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
            if (evt.sessionId) sessionId.value = evt.sessionId
            break
          case 'user_echo':
            echoReceived = true
            break
          case 'thinking':
            assistantTurn.thinking = (assistantTurn.thinking || '') + String(evt.delta || '')
            break
          case 'content':
            assistantTurn.content += String(evt.delta || '')
            break
          case 'done':
            doneEvent = evt
            break
          case 'error':
            throw new Error(evt.error || '对话拆分失败')
        }
      }
      // 触发响应式:替换数组触发 Vue 重渲染
      turns.value = [...turns.value]
      await nextTick()
      scrollToBottom()
    }

    if (myNonce !== runNonce) return
    if (!echoReceived && !doneEvent) throw new Error($t('@WORKBENCH:AI 未返回结果'))

    if (doneEvent) {
      assistantTurn.subtasks = Array.isArray(doneEvent.subtasks) ? doneEvent.subtasks : []
      assistantTurn.raw = String(doneEvent.raw || assistantTurn.content)
      assistantTurn.parseError = String(doneEvent.parseError || '')
      assistantTurn.parseStage = String(doneEvent.parseStage || '')
    }
    turns.value = [...turns.value]
    await nextTick()
    scrollToBottom()
    phase.value = 'idle'
  } catch (err: any) {
    if (myNonce !== runNonce) return
    if (err?.name === 'AbortError' || myController.signal.aborted) {
      // 用户主动停止
      assistantTurn.content = (assistantTurn.content || '') + '\n\n[已停止]'
      turns.value = [...turns.value]
      phase.value = 'idle'
      return
    }
    phase.value = 'error'
    errorMessage.value = err?.message || String(err)
    ElMessage.error(errorMessage.value)
  } finally {
    if (myNonce === runNonce) abortController = null
  }
}

function stop() {
  if (abortController) {
    abortController.abort()
    abortController = null
  }
}

function resetConversation() {
  if (isStreaming.value) {
    ElMessage.warning($t('@WORKBENCH:请先停止当前生成'))
    return
  }
  turns.value = []
  sessionId.value = ''
  errorMessage.value = ''
  phase.value = 'idle'
}

function applyTurn(turn: ChatTurn) {
  if (!turn.subtasks || turn.subtasks.length === 0) {
    ElMessage.warning($t('@WORKBENCH:当前没有可应用的子任务'))
    return
  }
  emit('confirm', turn.subtasks.slice())
}

// ── 历史会话 ──────────────────────────────────────────────────────────
async function openHistory() {
  historyDrawerVisible.value = true
  historyLoading.value = true
  try {
    const res = await fetch('/api/workbench/tasks/ai-chat-sessions').then(r => r.json())
    if (!res.success) {
      ElMessage.error(res.error || $t('@WORKBENCH:加载历史会话失败'))
      return
    }
    historyList.value = Array.isArray(res.sessions) ? res.sessions : []
  } catch (err: any) {
    ElMessage.error($t('@WORKBENCH:加载历史会话失败: ') + (err?.message || err))
  } finally {
    historyLoading.value = false
  }
}

async function restoreSession(sid: string) {
  historyDrawerVisible.value = false
  if (isStreaming.value) {
    ElMessage.warning($t('@WORKBENCH:请先停止当前生成'))
    return
  }
  try {
    const res = await fetch(`/api/workbench/tasks/ai-chat-sessions/${encodeURIComponent(sid)}`).then(r => r.json())
    if (!res.success) {
      ElMessage.error(res.error || $t('@WORKBENCH:加载历史会话失败'))
      return
    }
    const s = res.session
    sessionId.value = s.sessionId
    const restored: ChatTurn[] = (s.messages || [])
      .filter((m: any) => m.role === 'user' || m.role === 'assistant')
      .map((m: any) => ({
        role: m.role,
        content: m.content || '',
        thinking: '',
        subtasks: undefined,
        raw: undefined,
        parseError: '',
        parseStage: ''
      }))
    // 把 latestSubtasks 附到最后一条 assistant
    const lastA = [...restored].reverse().find(t => t.role === 'assistant')
    if (lastA && Array.isArray(s.latestSubtasks)) {
      lastA.subtasks = s.latestSubtasks
      lastA.raw = s.latestRaw
      lastA.parseStage = s.latestParseStage
    }
    turns.value = restored
    phase.value = 'idle'
    ElMessage.success($t('@WORKBENCH:已恢复历史会话'))
    await nextTick()
    scrollToBottom()
  } catch (err: any) {
    ElMessage.error($t('@WORKBENCH:加载历史会话失败: ') + (err?.message || err))
  }
}

async function deleteSession(sid: string) {
  try {
    await ElMessageBox.confirm(
      $t('@WORKBENCH:确认删除该会话'),
      $t('@WORKBENCH:删除后无法恢复'),
      { type: 'warning' }
    )
  } catch {
    return // 用户取消
  }
  try {
    const res = await fetch(`/api/workbench/tasks/ai-chat-sessions/${encodeURIComponent(sid)}`, {
      method: 'DELETE'
    }).then(r => r.json())
    if (!res.success) {
      ElMessage.error(res.error || $t('@WORKBENCH:删除失败'))
      return
    }
    historyList.value = historyList.value.filter(s => s.sessionId !== sid)
    ElMessage.success($t('@WORKBENCH:已删除'))
  } catch (err: any) {
    ElMessage.error($t('@WORKBENCH:删除失败: ') + (err?.message || err))
  }
}

function formatDate(iso: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return iso
  }
}

function formatSize(bytes: number): string {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

// 打开组件时如果传了 initialSessionId,自动恢复
if (props.initialSessionId) {
  restoreSession(props.initialSessionId)
}
</script>

<template>
  <div class="ai-chat-pane">
    <!-- 中间:消息流 -->
    <div ref="streamEl" class="ai-chat-stream">
      <div v-if="turns.length === 0" class="ai-chat-empty">
        <el-icon :size="32" color="#909399"><ChatLineRound /></el-icon>
        <div class="ai-chat-empty__title">{{ $t('@WORKBENCH:开始与 AI 对话拆分') }}</div>
        <div class="ai-chat-empty__desc">
          {{ $t('@WORKBENCH:输入你想让 AI 怎么拆分或调整(Enter 发送,Shift+Enter 换行)') }}
        </div>
      </div>

      <div
        v-for="(t, i) in turns"
        :key="i"
        :class="['ai-chat-turn', `ai-chat-turn--${t.role}`]"
      >
        <!-- 用户气泡 -->
        <div v-if="t.role === 'user'" class="ai-chat-bubble user">
          <pre class="ai-chat-content">{{ t.content }}</pre>
        </div>

        <!-- AI 气泡 -->
        <div v-else class="ai-chat-bubble assistant">
          <!-- 思考过程 -->
          <el-collapse v-if="t.thinking" class="ai-chat-collapse">
            <el-collapse-item :title="$t('@WORKBENCH:思考过程') + ` (${t.thinking.length})`" name="think">
              <pre class="ai-chat-pre ai-chat-pre--think">{{ t.thinking }}</pre>
            </el-collapse-item>
          </el-collapse>

          <!-- 解析结果 -->
          <div v-if="t.subtasks && t.subtasks.length > 0" class="ai-chat-subtasks">
            <div class="ai-chat-subtasks__head">
              <span class="ai-chat-subtasks__count">
                {{ $t('@WORKBENCH:识别到 {n} 个子任务', { n: t.subtasks.length }) }}
              </span>
            </div>
            <ul class="ai-chat-list">
              <li v-for="(s, j) in t.subtasks" :key="j" class="ai-chat-list__item">
                <div class="ai-chat-list__no">{{ j + 1 }}</div>
                <div class="ai-chat-list__body">
                  <div class="ai-chat-list__title">{{ s.title }}</div>
                  <div class="ai-chat-list__desc">{{ s.desc }}</div>
                </div>
              </li>
            </ul>
          </div>

          <!-- 解析失败提示 -->
          <el-alert
            v-else-if="t.parseError"
            type="warning"
            show-icon
            :closable="false"
            class="ai-chat-parse-error"
          >
            <template #title>
              {{ $t('@WORKBENCH:本轮未识别到子任务') }}
            </template>
            <div class="ai-chat-parse-error__detail">{{ t.parseError }}</div>
          </el-alert>

          <!-- 原始 LLM 输出 -->
          <el-collapse v-if="t.raw && t.raw !== t.content" class="ai-chat-collapse">
            <el-collapse-item :title="$t('@WORKBENCH:查看原始 LLM 输出')" name="raw">
              <pre class="ai-chat-pre">{{ t.raw }}</pre>
            </el-collapse-item>
          </el-collapse>

          <!-- 应用本轮按钮 -->
          <div v-if="t.subtasks && t.subtasks.length > 0" class="ai-chat-turn__actions">
            <el-button
              type="primary"
              size="small"
              :icon="Promotion"
              @click="applyTurn(t)"
            >
              {{ $t('@WORKBENCH:应用本轮') }} ({{ t.subtasks.length }})
            </el-button>
          </div>

          <!-- 流式中的占位提示 -->
          <div v-if="!t.content && !t.thinking && isStreaming" class="ai-chat-streaming-hint">
            <el-icon class="is-loading"><Loading /></el-icon>
            <span>{{ $t('@WORKBENCH:AI 正在思考…') }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部:输入区 -->
    <div class="ai-chat-input">
      <el-input
        v-model="draftMessage"
        type="textarea"
        :rows="3"
        :disabled="isStreaming"
        :placeholder="$t('@WORKBENCH:输入你想让 AI 怎么拆分或调整(Enter 发送,Shift+Enter 换行)')"
        @keydown.enter.exact.prevent="send"
      />
      <div class="ai-chat-input__actions">
        <el-button
          v-if="isStreaming"
          type="danger"
          :icon="CircleClose"
          @click="stop"
        >
          {{ $t('@WORKBENCH:停止') }}
        </el-button>
        <el-button
          v-else
          type="primary"
          :icon="Promotion"
          :disabled="!draftMessage.trim()"
          @click="send"
        >
          {{ $t('@WORKBENCH:发送') }}
        </el-button>
        <el-button :disabled="isStreaming" :icon="Refresh" @click="resetConversation">
          {{ $t('@WORKBENCH:清空对话') }}
        </el-button>
        <el-button :disabled="isStreaming" :icon="Clock" @click="openHistory">
          {{ $t('@WORKBENCH:历史会话') }}
        </el-button>
      </div>
    </div>

    <!-- 历史会话抽屉 -->
    <el-drawer
      v-model="historyDrawerVisible"
      :title="$t('@WORKBENCH:历史会话')"
      direction="rtl"
      size="420px"
    >
      <div v-if="historyLoading" class="ai-chat-history__loading">
        <el-icon class="is-loading"><Loading /></el-icon>
      </div>
      <div v-else-if="historyList.length === 0" class="ai-chat-history__empty">
        {{ $t('@WORKBENCH:暂无历史会话') }}
      </div>
      <ul v-else class="ai-chat-history__list">
        <li v-for="s in historyList" :key="s.sessionId" class="ai-chat-history__item">
          <div class="ai-chat-history__title">{{ s.title || '(无标题)' }}</div>
          <div class="ai-chat-history__meta">
            <span>{{ formatDate(s.updatedAt) }}</span>
            <span>·</span>
            <span>{{ s.messageCount }} 条消息</span>
            <span>·</span>
            <span>{{ s.latestSubtaskCount }} 个子任务</span>
            <span>·</span>
            <span>{{ formatSize(s.size) }}</span>
          </div>
          <div class="ai-chat-history__actions">
            <el-button size="small" type="primary" @click="restoreSession(s.sessionId)">
              {{ $t('@WORKBENCH:恢复') }}
            </el-button>
            <el-button size="small" type="danger" @click="deleteSession(s.sessionId)">
              {{ $t('@WORKBENCH:删除') }}
            </el-button>
          </div>
        </li>
      </ul>
    </el-drawer>
  </div>
</template>

<style scoped lang="scss">
.ai-chat-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 480px;
}

.ai-chat-stream {
  flex: 1;
  overflow-y: auto;
  padding: 12px 4px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ai-chat-empty {
  margin: auto;
  text-align: center;
  color: #909399;

  &__title {
    font-size: 16px;
    margin-top: 12px;
    color: #606266;
  }
  &__desc {
    font-size: 13px;
    margin-top: 6px;
    line-height: 1.6;
  }
}

.ai-chat-turn {
  display: flex;
  width: 100%;

  &--user {
    justify-content: flex-end;
  }
  &--assistant {
    justify-content: flex-start;
  }
}

.ai-chat-bubble {
  max-width: 80%;
  padding: 10px 14px;
  border-radius: 8px;
  word-wrap: break-word;

  &.user {
    background: #409eff;
    color: #fff;

    .ai-chat-content {
      margin: 0;
      white-space: pre-wrap;
      font-family: inherit;
      font-size: 14px;
      line-height: 1.6;
    }
  }

  &.assistant {
    background: #f4f4f5;
    color: #303133;
    width: 100%;
    max-width: 100%;
  }
}

.ai-chat-collapse {
  margin-bottom: 8px;
  border: none;

  :deep(.el-collapse-item__header) {
    font-size: 12px;
    color: #909399;
    background: transparent;
    border: none;
  }
  :deep(.el-collapse-item__wrap) {
    background: transparent;
    border: none;
  }
}

.ai-chat-pre {
  margin: 0;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.04);
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-wrap: break-word;
  max-height: 300px;
  overflow-y: auto;

  &--think {
    background: rgba(64, 158, 255, 0.08);
    color: #606266;
  }
}

.ai-chat-subtasks {
  margin: 8px 0;

  &__head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }
  &__count {
    font-size: 13px;
    color: #67c23a;
    font-weight: 500;
  }
}

.ai-chat-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;

  &__item {
    display: flex;
    gap: 10px;
    padding: 8px 10px;
    background: #fff;
    border: 1px solid #ebeef5;
    border-radius: 4px;
  }

  &__no {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: #409eff;
    color: #fff;
    text-align: center;
    line-height: 22px;
    font-size: 12px;
    font-weight: 500;
  }

  &__body {
    flex: 1;
    min-width: 0;
  }

  &__title {
    font-size: 14px;
    font-weight: 500;
    color: #303133;
    margin-bottom: 2px;
  }

  &__desc {
    font-size: 12px;
    color: #606266;
    line-height: 1.5;
    white-space: pre-wrap;
  }
}

.ai-chat-parse-error {
  margin: 8px 0;

  &__detail {
    font-size: 12px;
    color: #606266;
    margin-top: 4px;
    white-space: pre-wrap;
  }
}

.ai-chat-turn__actions {
  margin-top: 8px;
  display: flex;
  justify-content: flex-end;
}

.ai-chat-streaming-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #909399;
  font-size: 13px;
}

.ai-chat-input {
  border-top: 1px solid #ebeef5;
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;

  &__actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
}

.ai-chat-history {
  &__loading {
    text-align: center;
    padding: 40px 0;
    color: #909399;
  }
  &__empty {
    text-align: center;
    padding: 40px 0;
    color: #909399;
  }
  &__list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  &__item {
    border: 1px solid #ebeef5;
    border-radius: 6px;
    padding: 10px 12px;
  }
  &__title {
    font-size: 14px;
    font-weight: 500;
    color: #303133;
    margin-bottom: 4px;
  }
  &__meta {
    font-size: 12px;
    color: #909399;
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  &__actions {
    margin-top: 8px;
    display: flex;
    gap: 6px;
  }
}
</style>

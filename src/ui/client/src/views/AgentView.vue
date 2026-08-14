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
  智能体视图：左侧会话列表 + 右侧对话区。
  - 左侧：会话列表（搜索 / 新建 / 删除 / 重命名）
  - 右侧：使用 zen-ai-chat-ui 的 ChatContainer 渲染对话
  - SSE 流式：thinking + content + tool_call + tool_result
  - 会话持久化：后端自动保存到 ~/.zen-gitsync/agent-sessions/
-->
<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { $t } from '@/lang/static'
import { ElMessage, ElMessageBox, ElTooltip, ElIcon } from 'element-plus'
import { Plus, Search, Delete, Edit, ChatLineRound, Loading } from '@element-plus/icons-vue'
import { ChatContainer } from 'zen-ai-chat-ui'
import 'zen-ai-chat-ui/style.css'
import { useConfigStore } from '@/stores/configStore'
import { useAgentChat } from '@/composables/useAgentChat'

const configStore = useConfigStore()

const {
  sessions,
  sessionsLoading,
  currentSessionId,
  messages,
  isStreaming,
  sessionLoading,
  loadSessions,
  loadSession,
  deleteSession,
  renameSession,
  newSession,
  sendMessage,
  stop
} = useAgentChat()

// ── 主题 ──────────────────────────────────────────────────
const chatTheme = computed<'light' | 'dark'>(() => {
  const t = configStore.theme
  if (t === 'dark') return 'dark'
  if (t === 'auto') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'light'
})

// ── 搜索 ──────────────────────────────────────────────────
const searchQuery = ref('')
const filteredSessions = computed(() => {
  if (!searchQuery.value.trim()) return sessions.value
  const q = searchQuery.value.toLowerCase()
  return sessions.value.filter(s =>
    (s.title || '').toLowerCase().includes(q) ||
    (s.model || '').toLowerCase().includes(q)
  )
})

// ── 预设问题 ──────────────────────────────────────────────
const presetQuestions = computed(() => [
  { id: 'p1', label: $t('@AGENT:查看项目结构'), prompt: $t('@AGENT:prompt_p1') },
  { id: 'p2', label: $t('@AGENT:分析代码质量'), prompt: $t('@AGENT:prompt_p2') },
  { id: 'p3', label: $t('@AGENT:帮我写测试'), prompt: $t('@AGENT:prompt_p3') },
  { id: 'p4', label: $t('@AGENT:Git 状态检查'), prompt: $t('@AGENT:prompt_p4') }
])

// ── 发送消息 ──────────────────────────────────────────────
async function onSend(payload: { text: string; files: any[] }) {
  await sendMessage(payload.text, payload.files)
  await nextTick()
  scrollToBottom()
}

// ── 预设问题点击 ──────────────────────────────────────────
async function onSelectPreset(q: any) {
  await sendMessage(q.prompt)
  await nextTick()
  scrollToBottom()
}

// ── ChatContainer ref ────────────────────────────────────
const chatContainerRef = ref<InstanceType<typeof ChatContainer> | null>(null)

function scrollToBottom(smooth = true) {
  chatContainerRef.value?.scrollToBottom(smooth)
}

// 监听消息变化自动滚动到底部
watch(() => messages.value.length, () => {
  nextTick(() => scrollToBottom(false))
})

// ── 选中会话 ──────────────────────────────────────────────
function selectSession(sessionId: string) {
  if (isStreaming.value) {
    ElMessage.warning($t('@AGENT:请先停止当前生成'))
    return
  }
  loadSession(sessionId)
}

// ── 新建会话 ──────────────────────────────────────────────
function handleNewSession() {
  if (isStreaming.value) {
    ElMessage.warning($t('@AGENT:请先停止当前生成'))
    return
  }
  newSession()
}

// ── 删除会话 ──────────────────────────────────────────────
function handleDelete(sessionId: string, e: Event) {
  e.stopPropagation()
  if (isStreaming.value && currentSessionId.value === sessionId) {
    ElMessage.warning($t('@AGENT:请先停止当前生成'))
    return
  }
  deleteSession(sessionId)
}

// ── 重命名会话 ────────────────────────────────────────────
async function handleRename(sessionId: string, currentTitle: string, e: Event) {
  e.stopPropagation()
  try {
    const { value } = await ElMessageBox.prompt($t('@AGENT:请输入新的会话标题'), $t('@AGENT:重命名会话'), {
      inputValue: currentTitle,
      inputPattern: /.+/,
      inputErrorMessage: $t('@AGENT:标题不能为空')
    })
    if (value && value !== currentTitle) {
      await renameSession(sessionId, value)
    }
  } catch {
    // 用户取消
  }
}

// ── 格式化时间 ────────────────────────────────────────────
function formatDate(iso: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const now = new Date()
    const diff = now.getTime() - d.getTime()
    const pad = (n: number) => String(n).padStart(2, '0')
    // 同一天只显示时间
    if (d.toDateString() === now.toDateString()) {
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
    // 7 天内显示 "N天前"
    if (diff < 7 * 24 * 60 * 60 * 1000) {
      const days = Math.floor(diff / (24 * 60 * 60 * 1000))
      return days === 0 ? $t('@AGENT:今天') : `${days}${$t('@AGENT:天前')}`
    }
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  } catch {
    return iso
  }
}

// ── 侧边栏宽度拖拽 ────────────────────────────────────────
const sidebarWidth = ref(280)
const isResizing = ref(false)

function startResize(e: MouseEvent) {
  isResizing.value = true
  const startX = e.clientX
  const startWidth = sidebarWidth.value

  const onMove = (ev: MouseEvent) => {
    const delta = ev.clientX - startX
    const newWidth = Math.max(200, Math.min(500, startWidth + delta))
    sidebarWidth.value = newWidth
  }

  const onUp = () => {
    isResizing.value = false
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// ── 项目切换:会话列表按项目隔离 ──────────────────────────
// currentDirectory 变化(socket 推送 / 启动后异步就绪)时重新拉取;
// 流式生成期间不打断，结束后再次检查并清掉不属于新项目的旧会话。
watch(() => [configStore.currentDirectory, isStreaming.value] as const, async ([cwd], previous) => {
  if (!previous || cwd !== previous[0]) await loadSessions()
  if (currentSessionId.value && !isStreaming.value &&
      !sessions.value.some(s => s.sessionId === currentSessionId.value)) {
    newSession()
  }
}, { immediate: true })
</script>

<template>
  <div class="agent-view">
    <!-- ═══ 左侧：会话列表 ═══ -->
    <aside class="agent-sidebar" :style="{ width: sidebarWidth + 'px' }">
      <!-- 顶部操作栏 -->
      <div class="sidebar-header">
        <button class="new-session-btn" @click="handleNewSession">
          <el-icon><Plus /></el-icon>
          <span>{{ $t('@AGENT:新建会话') }}</span>
        </button>
      </div>

      <!-- 搜索框 -->
      <div class="sidebar-search">
        <el-icon class="search-icon"><Search /></el-icon>
        <input
          v-model="searchQuery"
          :placeholder="$t('@AGENT:搜索会话...')"
          class="search-input"
          type="text"
        />
      </div>

      <!-- 会话列表 -->
      <div class="session-list" v-loading="sessionsLoading">
        <div v-if="filteredSessions.length === 0 && !sessionsLoading" class="empty-state">
          <el-icon :size="28" color="var(--text-tertiary)"><ChatLineRound /></el-icon>
          <div class="empty-text">{{ searchQuery ? $t('@AGENT:未找到匹配的会话') : $t('@AGENT:暂无会话') }}</div>
          <div v-if="!searchQuery" class="empty-hint">{{ $t('@AGENT:点击上方按钮开始对话') }}</div>
        </div>

        <div
          v-for="s in filteredSessions"
          :key="s.sessionId"
          class="session-item"
          :class="{ active: currentSessionId === s.sessionId }"
          @click="selectSession(s.sessionId)"
        >
          <div class="session-item-main">
            <div class="session-item-title">{{ s.title || $t('@AGENT:无标题') }}</div>
            <div class="session-item-meta">
              <span class="meta-time">{{ formatDate(s.updatedAt) }}</span>
              <span class="meta-dot">·</span>
              <span class="meta-count">{{ s.messageCount }} {{ $t('@AGENT:条') }}</span>
              <span v-if="s.source === 'cli'" class="meta-source cli">CLI</span>
            </div>
          </div>
          <div class="session-item-actions" @click.stop>
            <el-tooltip :content="$t('@AGENT:重命名')" placement="top" :show-after="500">
              <button class="item-action-btn" @click="handleRename(s.sessionId, s.title, $event)">
                <el-icon><Edit /></el-icon>
              </button>
            </el-tooltip>
            <el-tooltip :content="$t('@AGENT:删除')" placement="top" :show-after="500">
              <button class="item-action-btn danger" @click="handleDelete(s.sessionId, $event)">
                <el-icon><Delete /></el-icon>
              </button>
            </el-tooltip>
          </div>
        </div>
      </div>
    </aside>

    <!-- 拖拽分隔条 -->
    <div
      class="sidebar-resizer"
      @mousedown="startResize"
      :class="{ active: isResizing }"
    ></div>

    <!-- ═══ 右侧：对话区域 ═══ -->
    <main class="agent-chat-area">
      <!-- 加载中 -->
      <div v-if="sessionLoading" class="chat-loading">
        <el-icon class="is-loading" :size="32"><Loading /></el-icon>
        <span>{{ $t('@AGENT:加载会话中...') }}</span>
      </div>

      <!-- ChatContainer -->
      <ChatContainer
        v-else
        ref="chatContainerRef"
        :messages="messages"
        :preset-questions="presetQuestions"
        :welcome-title="$t('@AGENT:智能体助手')"
        :welcome-description="$t('@AGENT:我可以帮你阅读代码、执行命令、修改文件。选择下方话题或直接输入你的问题。')"
        :assistant-name="'g ai'"
        :theme="chatTheme"
        :disabled="isStreaming"
        :upload-config="{ accept: 'image/*' }"
        :placeholder="isStreaming ? $t('@AGENT:正在生成中...') : $t('@AGENT:输入消息，Enter 发送')"
        @send="onSend"
        @select="onSelectPreset"
      >
      </ChatContainer>

      <!-- 停止按钮浮层 -->
      <transition name="fade">
        <div v-if="isStreaming" class="stop-button-bar">
          <button class="stop-button" @click="stop">
            <el-icon><Loading class="is-loading" /></el-icon>
            <span>{{ $t('@AGENT:停止生成') }}</span>
          </button>
        </div>
      </transition>
    </main>
  </div>
</template>

<style scoped lang="scss">
.agent-view {
  display: flex;
  height: 100%;
  min-height: 0;
  background: var(--bg-container);
}

/* ── 左侧侧边栏 ─────────────────────────────────── */
.agent-sidebar {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border-right: 1px solid var(--border-color);
  overflow: hidden;
}

.sidebar-header {
  padding: 10px 12px;
  flex-shrink: 0;
}

.new-session-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 12px;
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover {
    border-color: var(--color-primary);
    color: var(--color-primary);
    background: color-mix(in srgb, var(--color-primary) 6%, transparent);
  }
}

.sidebar-search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px 8px;
  flex-shrink: 0;

  .search-icon {
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .search-input {
    flex: 1;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: 13px;
    font-family: inherit;
    outline: none;
    padding: 4px 0;

    &::placeholder {
      color: var(--text-tertiary);
    }
  }
}

.session-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 6px 8px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 16px;
  text-align: center;
  color: var(--text-tertiary);

  .empty-text {
    font-size: 14px;
    margin-top: 10px;
    color: var(--text-secondary);
  }

  .empty-hint {
    font-size: 12px;
    margin-top: 4px;
  }
}

.session-item {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.12s ease;
  position: relative;

  &:hover {
    background: var(--bg-hover);

    .session-item-actions {
      opacity: 1;
    }
  }

  &.active {
    background: color-mix(in srgb, var(--color-primary) 10%, transparent);

    .session-item-title {
      color: var(--color-primary);
    }

    &::before {
      content: '';
      position: absolute;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 3px;
      height: 20px;
      background: var(--color-primary);
      border-radius: 0 2px 2px 0;
    }
  }
}

.session-item-main {
  flex: 1;
  min-width: 0;
}

.session-item-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 2px;
}

.session-item-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-tertiary);

  .meta-dot {
    opacity: 0.5;
  }

  .meta-source {
    padding: 0 4px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;

    &.cli {
      background: color-mix(in srgb, var(--color-warning) 20%, transparent);
      color: var(--color-warning);
    }
  }
}

.session-item-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.12s ease;
  flex-shrink: 0;
}

.item-action-btn {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  border-radius: var(--radius-xs);
  transition: all 0.12s ease;
  padding: 0;

  &:hover {
    background: var(--bg-hover);
    color: var(--text-secondary);
  }

  &.danger:hover {
    color: var(--color-danger);
    background: color-mix(in srgb, var(--color-danger) 10%, transparent);
  }
}

/* ── 拖拽分隔条 ─────────────────────────────────── */
.sidebar-resizer {
  width: 4px;
  flex-shrink: 0;
  cursor: col-resize;
  background: transparent;
  transition: background 0.15s ease;

  &:hover,
  &.active {
    background: var(--color-primary);
    opacity: 0.3;
  }
}

/* ── 右侧对话区 ─────────────────────────────────── */
.agent-chat-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
}

.chat-loading {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-tertiary);
  font-size: 14px;
}

/* ── 停止按钮 ───────────────────────────────────── */
.stop-button-bar {
  position: absolute;
  bottom: 80px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
}

.stop-button {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 16px;
  border: 1px solid var(--color-danger);
  border-radius: 20px;
  background: var(--bg-container);
  color: var(--color-danger);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  transition: all 0.15s ease;

  &:hover {
    background: var(--color-danger);
    color: #fff;
  }
}

/* ── 过渡动画 ───────────────────────────────────── */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* ── 暗色主题适配 ───────────────────────────────── */
:global([data-theme='dark']) {
  .agent-sidebar {
    background: var(--bg-panel);
  }
}
</style>

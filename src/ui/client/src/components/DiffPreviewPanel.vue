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
 * 文件差异预览面板
 * - 用于 FileDiffViewer 右侧差异区下方的预览区域
 * - 支持 .md / .markdown: 走 MarkdownPreview
 * - 支持 .html / .htm / .svg: 走沙箱化 iframe (sandbox)
 * - 与 EditorView 中的预览保持一致体验
 */
import { computed, ref, watch } from 'vue'
import { ElIcon, ElTooltip } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import MarkdownPreview from '@/components/MarkdownPreview.vue'

interface Props {
  /** 当前预览的文件路径 */
  filePath: string
  /** 文件内容（已被父组件加载并传入，避免重复抓取） */
  content: string
  /** 是否正在加载 */
  loading?: boolean
  /** 加载失败的错误信息 */
  error?: string
  /** 上下文，决定从哪里取原始内容 */
  context?: 'git-status' | 'commit-detail' | 'stash-detail'
  /** commit-detail 时使用的提交哈希 */
  commitHash?: string
}

const props = withDefaults(defineProps<Props>(), {
  loading: false,
  error: '',
  context: 'git-status',
  commitHash: '',
})

const emit = defineEmits<{
  (e: 'refresh'): void
}>()

const ext = computed(() => {
  const name = props.filePath || ''
  return name.split('.').pop()?.toLowerCase() ?? ''
})

const isMarkdown = computed(() => ext.value === 'md' || ext.value === 'markdown')
const isHtmlLike = computed(() => ext.value === 'html' || ext.value === 'htm' || ext.value === 'svg')
const isPreviewable = computed(() => isMarkdown.value || isHtmlLike.value)

const isDark = ref(true)
function syncTheme() {
  if (typeof document === 'undefined') return
  isDark.value = document.documentElement.getAttribute('data-theme') !== 'light'
}

// iframe srcdoc：HTML / SVG 直接灌入，背景随主题调整；沙箱关闭 JS 执行以保证安全
const previewSrcdoc = computed(() => {
  if (!isHtmlLike.value) return ''
  const bg = isDark.value ? '#0d1117' : '#ffffff'
  const textColor = isDark.value ? '#e6edf3' : '#1f2328'
  if (ext.value === 'svg') {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:${bg};color:${textColor};display:flex;align-items:center;justify-content:center;min-height:100vh;}svg{max-width:100%;max-height:90vh;}</style></head><body>${props.content || ''}</body></html>`
  }
  return props.content || ''
})

watch(() => props.filePath, () => {
  syncTheme()
}, { immediate: true })
syncTheme()
</script>

<template>
  <div class="diff-preview-panel" v-if="isPreviewable">
    <div class="diff-preview-header">
      <span class="diff-preview-title">{{ $t('@E80AC:文件预览') }}</span>
      <span class="diff-preview-ext-badge">{{ ext.toUpperCase() }}</span>
      <div class="diff-preview-spacer" />
      <el-tooltip :content="$t('@E80AC:刷新预览')" placement="top">
        <button
          class="diff-preview-btn"
          :title="$t('@E80AC:刷新预览')"
          @click="emit('refresh')"
        >
          <el-icon><Refresh /></el-icon>
        </button>
      </el-tooltip>
    </div>
    <div class="diff-preview-body">
      <div v-if="loading" class="diff-preview-loading">
        <span>{{ $t('@E80AC:正在加载预览...') }}</span>
      </div>
      <div v-else-if="error" class="diff-preview-error">
        <span>{{ error }}</span>
      </div>
      <iframe
        v-else-if="isHtmlLike"
        class="diff-preview-iframe"
        sandbox="allow-same-origin"
        :srcdoc="previewSrcdoc"
      />
      <MarkdownPreview
        v-else-if="isMarkdown"
        :content="props.content || ''"
        class="diff-preview-markdown"
      />
    </div>
  </div>
  <div v-else class="diff-preview-panel diff-preview-unsupported">
    <div class="diff-preview-body">
      <span class="diff-preview-empty">{{ $t('@E80AC:当前文件类型不支持预览') }}</span>
    </div>
  </div>
</template>

<style scoped>
.diff-preview-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-panel);
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
}

.diff-preview-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  height: 34px;
  flex-shrink: 0;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border-color-light);
}

.diff-preview-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-secondary);
  user-select: none;
}

.diff-preview-ext-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(59, 130, 246, 0.15);
  color: var(--color-primary);
  letter-spacing: 0.04em;
}

.diff-preview-spacer {
  flex: 1;
}

.diff-preview-btn {
  background: none;
  border: none;
  padding: 3px;
  cursor: pointer;
  color: var(--text-tertiary);
  border-radius: var(--radius-base);
  display: flex;
  align-items: center;
  transition: color 0.1s, background 0.1s;
  font-size: 13px;
}

.diff-preview-btn:hover {
  color: var(--color-primary);
  background: var(--bg-hover);
}

.diff-preview-body {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--bg-container, #ffffff);
  color: var(--text-primary, inherit);
}

.diff-preview-iframe {
  flex: 1;
  width: 100%;
  height: 100%;
  border: none;
  background: transparent;
}

.diff-preview-markdown {
  flex: 1;
  width: 100%;
  height: 100%;
  overflow: auto;
}

.diff-preview-loading,
.diff-preview-error {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  font-size: 13px;
}

.diff-preview-error {
  color: var(--color-danger, #f56c6c);
}

.diff-preview-unsupported {
  border-style: dashed;
  background: transparent;
}

.diff-preview-empty {
  color: var(--text-tertiary);
  font-size: 12px;
}
</style>

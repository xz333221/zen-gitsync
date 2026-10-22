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
 * 音视频预览（文件空间里点 mp3 / mp4 直接播放）
 * - 二进制走 /api/editor/raw（服务端支持 Range，拖进度条才不卡整份下载）
 * - 用浏览器原生 <audio>/<video> 控件：播放 / 暂停 / 进度 / 音量 / 全屏都由它负责，
 *   不自绘播放器（编码支持面也比第三方库宽）
 * - 时长来自 loadedmetadata，体积来自 /api/editor/file?meta=1（一次 stat，不读正文）
 */
import { computed, ref, watch } from 'vue'
import { $t } from '@/lang/static'
import { getMediaKind, getRawFileUrl } from '@/utils/fileKind'

interface Props {
  filePath: string
  /** 文件名（用于显示），可省略 */
  fileName?: string
}

const props = defineProps<Props>()

const kind = computed(() => getMediaKind(props.filePath) ?? 'audio')
const src = computed(() => getRawFileUrl(props.filePath))
const displayName = computed(() => props.fileName || props.filePath.split(/[\\/]/).pop() || '')

const loading = ref(true)
const error = ref(false)
const duration = ref(0)
const size = ref(0)
const videoW = ref(0)
const videoH = ref(0)

async function fetchSize() {
  try {
    const resp = await fetch(`/api/editor/file?path=${encodeURIComponent(props.filePath)}&meta=1`)
    const data = await resp.json()
    if (data?.success && typeof data.size === 'number') size.value = data.size
  } catch {
    // 体积只是辅助信息，取不到就不显示
  }
}

// 换文件 = 换一个媒体源：元素用 :key="filePath" 重建，状态统一在这里复位
watch(() => props.filePath, () => {
  loading.value = true
  error.value = false
  duration.value = 0
  size.value = 0
  videoW.value = 0
  videoH.value = 0
  void fetchSize()
}, { immediate: true })

function onLoadedMetadata(e: Event) {
  const el = e.target as HTMLMediaElement
  if (Number.isFinite(el.duration) && el.duration > 0) duration.value = el.duration
  if (el instanceof HTMLVideoElement) {
    videoW.value = el.videoWidth
    videoH.value = el.videoHeight
  }
  loading.value = false
}

function onCanPlay() {
  loading.value = false
}

function onError() {
  loading.value = false
  error.value = true
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '--:--'
  const total = Math.floor(sec)
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const mm = String(m).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

function formatSize(bytes: number): string {
  if (!bytes || bytes < 0) return ''
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

const metaLine = computed(() => {
  const parts = [kind.value === 'video' ? $t('@EDITOR:视频') : $t('@EDITOR:音频')]
  if (duration.value > 0) parts.push(formatDuration(duration.value))
  if (videoW.value > 0 && videoH.value > 0) parts.push(`${videoW.value} × ${videoH.value}`)
  const sz = formatSize(size.value)
  if (sz) parts.push(sz)
  return parts.join(' · ')
})
</script>

<template>
  <div class="media-preview" :data-media-kind="kind" :data-media-path="props.filePath">
    <div class="media-preview-stage">
      <div v-if="error" class="media-preview-error">
        <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <line x1="12" y1="8" x2="12" y2="13" />
          <line x1="12" y1="16.5" x2="12" y2="16.6" />
        </svg>
        <p class="media-preview-error-title">{{ $t('@EDITOR:无法播放该文件，可能是编码或格式不受支持') }}</p>
        <p class="media-preview-error-path">{{ props.filePath }}</p>
      </div>

      <template v-else>
        <!-- 视频：占满可用区域，等比缩放（黑边由舞台底色补） -->
        <video
          v-if="kind === 'video'"
          :key="props.filePath"
          class="media-preview-video"
          :src="src"
          controls
          playsinline
          preload="metadata"
          @loadedmetadata="onLoadedMetadata"
          @canplay="onCanPlay"
          @error="onError"
        />

        <!-- 音频：中间一块信息 + 原生控制条。不套"圆角 + 单边框"的卡片 -->
        <div v-else class="media-preview-audio">
          <div class="media-preview-glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 17a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" />
              <path d="M9 17v-13h10v13" />
              <path d="M9 8h10" />
            </svg>
          </div>
          <p class="media-preview-title" :title="props.filePath">{{ displayName }}</p>
          <audio
            :key="props.filePath"
            class="media-preview-audio-el"
            :src="src"
            controls
            preload="metadata"
            @loadedmetadata="onLoadedMetadata"
            @canplay="onCanPlay"
            @error="onError"
          />
        </div>

        <div v-if="loading" class="media-preview-loading">
          <span class="media-preview-spinner" />
          <span>{{ $t('@EDITOR:正在载入媒体文件…') }}</span>
        </div>
      </template>
    </div>

    <div class="media-preview-footer">
      <span class="media-preview-meta">{{ metaLine }}</span>
      <span v-if="kind === 'video'" class="media-preview-name" :title="props.filePath">{{ displayName }}</span>
    </div>
  </div>
</template>

<style scoped>
.media-preview {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-container);
  overflow: hidden;
}

.media-preview-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-lg);
  background: var(--bg-panel);
}

.media-preview-video {
  max-width: 100%;
  max-height: 100%;
  min-height: 0;
  display: block;
  background: #000;
}

.media-preview-audio {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-md);
  width: min(560px, 100%);
}

.media-preview-glyph {
  color: var(--color-primary);
  opacity: 0.85;
}

.media-preview-title {
  margin: 0;
  max-width: 100%;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  text-align: center;
  word-break: break-all;
}

.media-preview-audio-el {
  width: 100%;
  color-scheme: inherit;
}

.media-preview-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--bg-panel) 78%, transparent);
  pointer-events: none;
}

.media-preview-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border-color);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: media-spin 0.8s linear infinite;
}

@keyframes media-spin {
  to { transform: rotate(360deg); }
}

.media-preview-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-sm);
  color: var(--text-secondary);
  text-align: center;
  padding: var(--spacing-lg);
}

.media-preview-error-title {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--font-size-md);
}

.media-preview-error-path {
  margin: 0;
  max-width: 520px;
  color: var(--text-meta);
  font-size: var(--font-size-xs);
  word-break: break-all;
}

.media-preview-footer {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: 4px 12px;
  background: var(--bg-panel);
  font-size: var(--font-size-xs);
  color: var(--text-meta);
}

.media-preview-meta {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.media-preview-name {
  margin-left: auto;
  max-width: 55%;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>

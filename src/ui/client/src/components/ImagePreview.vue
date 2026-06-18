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
 * 图片预览组件
 * - 通过 /api/editor/raw 端点取二进制
 * - 大图缩放、拖拽平移、滚轮缩放、双击重置
 * - 显示文件名 + 像素尺寸
 */
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { ElIcon } from 'element-plus'
import { ZoomIn, ZoomOut, Refresh, FullScreen } from '@element-plus/icons-vue'
import { getRawFileUrl } from '@/utils/fileKind'

interface Props {
  filePath: string
  /** 文件名（用于显示），可省略 */
  fileName?: string
}

const props = defineProps<Props>()

const containerRef = ref<HTMLElement | null>(null)

const scale = ref(1)
const translateX = ref(0)
const translateY = ref(0)
const isDragging = ref(false)
const dragStart = ref({ x: 0, y: 0 })
const naturalSize = ref<{ w: number; h: number } | null>(null)
const loadError = ref(false)
const imgRef = ref<HTMLImageElement | null>(null)

const fit = () => {
  if (!containerRef.value || !naturalSize.value) return
  const cw = containerRef.value.clientWidth - 32
  const ch = containerRef.value.clientHeight - 32
  if (cw <= 0 || ch <= 0) return
  const s = Math.min(cw / naturalSize.value.w, ch / naturalSize.value.h, 1)
  scale.value = s
  translateX.value = 0
  translateY.value = 0
}

const zoomIn = () => {
  scale.value = Math.min(scale.value * 1.2, 8)
}
const zoomOut = () => {
  scale.value = Math.max(scale.value / 1.2, 0.1)
}
const reset = () => {
  scale.value = 1
  translateX.value = 0
  translateY.value = 0
  fit()
}

const onWheel = (e: WheelEvent) => {
  e.preventDefault()
  if (e.deltaY < 0) zoomIn()
  else zoomOut()
}

const onMouseDown = (e: MouseEvent) => {
  if (e.button !== 0) return
  isDragging.value = true
  dragStart.value = { x: e.clientX - translateX.value, y: e.clientY - translateY.value }
}
const onMouseMove = (e: MouseEvent) => {
  if (!isDragging.value) return
  translateX.value = e.clientX - dragStart.value.x
  translateY.value = e.clientY - dragStart.value.y
}
const onMouseUp = () => { isDragging.value = false }

const onImgLoad = (e: Event) => {
  const img = e.target as HTMLImageElement
  naturalSize.value = { w: img.naturalWidth, h: img.naturalHeight }
  loadError.value = false
  // 等容器尺寸 ready
  requestAnimationFrame(() => fit())
}

const onImgError = () => {
  loadError.value = true
}

const displayName = computed(() => props.fileName || props.filePath?.split('/').pop() || '')

const imageUrl = computed(() => getRawFileUrl(props.filePath))

onMounted(() => {
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
  window.addEventListener('resize', fit)
})
onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
  window.removeEventListener('resize', fit)
})

// 文件切换时重置
watch(() => props.filePath, () => {
  naturalSize.value = null
  loadError.value = false
  scale.value = 1
  translateX.value = 0
  translateY.value = 0
})
</script>

<template>
  <div class="image-preview" ref="containerRef" @wheel="onWheel">
    <!-- 顶部工具条 -->
    <div class="image-preview-toolbar">
      <span class="image-preview-name" :title="props.filePath">{{ displayName }}</span>
      <span v-if="naturalSize" class="image-preview-dim">{{ naturalSize.w }} × {{ naturalSize.h }} px</span>
      <span v-else class="image-preview-dim">{{ Math.round(scale * 100) }}%</span>
      <div class="image-preview-spacer" />
      <el-tooltip content="放大" placement="top">
        <button class="image-preview-btn" @click="zoomIn">
          <el-icon><ZoomIn /></el-icon>
        </button>
      </el-tooltip>
      <el-tooltip content="缩小" placement="top">
        <button class="image-preview-btn" @click="zoomOut">
          <el-icon><ZoomOut /></el-icon>
        </button>
      </el-tooltip>
      <el-tooltip content="适应窗口" placement="top">
        <button class="image-preview-btn" @click="reset">
          <el-icon><Refresh /></el-icon>
        </button>
      </el-tooltip>
    </div>

    <!-- 图片区域 -->
    <div
      class="image-preview-stage"
      :class="{ 'is-dragging': isDragging }"
      @mousedown="onMouseDown"
    >
      <div v-if="loadError" class="image-preview-error">
        <el-icon size="32" color="var(--color-danger)"><FullScreen /></el-icon>
        <p>图片加载失败</p>
        <p class="image-preview-error-path">{{ props.filePath }}</p>
      </div>
      <img
        v-else
        ref="imgRef"
        :src="imageUrl"
        :alt="displayName"
        class="image-preview-img"
        :style="{
          transform: `translate(${translateX}px, ${translateY}px) scale(${scale})`,
        }"
        @load="onImgLoad"
        @error="onImgError"
        draggable="false"
      />
    </div>

    <!-- 底部提示 -->
    <div class="image-preview-footer">
      <span>滚轮缩放 · 拖拽平移 · 双击重置</span>
      <span class="image-preview-zoom">{{ Math.round(scale * 100) }}%</span>
    </div>
  </div>
</template>

<style scoped>
.image-preview {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-container);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
  overflow: hidden;
}

.image-preview-toolbar {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: 6px 10px;
  background: var(--bg-panel);
  flex-shrink: 0;
  font-size: var(--font-size-sm);
}

.image-preview-name {
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  max-width: 50%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.image-preview-dim {
  color: var(--text-tertiary);
  font-size: var(--font-size-xs);
}

.image-preview-spacer {
  flex: 1;
}

.image-preview-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--border-color);
  background: var(--bg-container);
  color: var(--text-secondary);
  border-radius: var(--radius-base);
  cursor: pointer;
  transition: var(--transition-all);
  font-size: 13px;
}

.image-preview-btn:hover {
  color: var(--color-primary);
  border-color: var(--color-primary);
  background: var(--bg-hover);
}

.image-preview-stage {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background:
    linear-gradient(45deg, var(--bg-panel) 25%, transparent 25%),
    linear-gradient(-45deg, var(--bg-panel) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--bg-panel) 75%),
    linear-gradient(-45deg, transparent 75%, var(--bg-panel) 75%);
  background-size: 20px 20px;
  background-position: 0 0, 0 10px, 10px -10px, -10px 0;
  cursor: grab;
  user-select: none;
}

.image-preview-stage.is-dragging {
  cursor: grabbing;
}

.image-preview-img {
  max-width: none;
  max-height: none;
  display: block;
  transition: transform 0.05s linear;
  -webkit-user-drag: none;
}

.image-preview-error {
  text-align: center;
  color: var(--text-secondary);
}

.image-preview-error-path {
  color: var(--text-tertiary);
  font-size: var(--font-size-xs);
  margin-top: var(--spacing-xs);
  max-width: 400px;
  word-break: break-all;
}

.image-preview-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 12px;
  background: var(--bg-panel);
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.image-preview-zoom {
  font-weight: var(--font-weight-medium);
  color: var(--text-secondary);
  min-width: 50px;
  text-align: right;
}
</style>

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
import { computed, ref, onBeforeUnmount } from 'vue'
import { ElImageViewer, ElMessage } from 'element-plus'
import { $t } from '@/lang/static'

interface AttachmentItem {
  id: string
  originalName: string
  mimeType: string
  size: number
  ext: string
  absolutePath?: string
}

const props = defineProps<{
  attachments: AttachmentItem[]
  isImage: (att: AttachmentItem) => boolean
  humanSize: (n: number) => string
  isUploading: boolean
  isPasteHover: boolean
  maxCount: number
  onPick: () => void
  onRemove: (att: AttachmentItem) => void
}>()

const emit = defineEmits<{
  (e: 'paste', evt: ClipboardEvent): void
  (e: 'drop', evt: DragEvent): void
  (e: 'dragover', evt: DragEvent): void
  (e: 'dragenter', evt: DragEvent): void
  (e: 'dragleave', evt: DragEvent): void
}>()

// 图片预览：抽出所有图片附件，supports 左右切换
const imageList = computed(() =>
  props.attachments.filter(a => props.isImage(a))
)
const previewUrls = computed(() =>
  imageList.value.map(a => `/api/workbench/attachments/${a.id}/raw`)
)
const previewIndex = ref(0)
const previewVisible = ref(false)

function previewAttachment(att: AttachmentItem) {
  if (props.isImage(att)) {
    const idx = imageList.value.findIndex(x => x.id === att.id)
    previewIndex.value = idx >= 0 ? idx : 0
    previewVisible.value = true
  } else {
    // 非图片：交给浏览器原生处理（PDF/纯文本/JSON 等会直接展示，其他会下载）
    window.open(`/api/workbench/attachments/${att.id}/raw`, '_blank', 'noopener')
  }
}
function closePreview() {
  previewVisible.value = false
}

// ── 右键菜单：复制图片 ─────────────────────────────────────
interface ContextMenuState {
  visible: boolean
  x: number
  y: number
  att: AttachmentItem | null
}
const contextMenu = ref<ContextMenuState>({ visible: false, x: 0, y: 0, att: null })
const copyBusy = ref(false)

function openContextMenu(att: AttachmentItem, evt: MouseEvent) {
  // 只对图片附件提供此能力
  if (!props.isImage(att)) return
  evt.preventDefault()
  // 防止菜单溢出到屏幕右下外
  const maxX = window.innerWidth - 180
  const maxY = window.innerHeight - 120
  contextMenu.value = {
    visible: true,
    x: Math.min(evt.clientX, maxX),
    y: Math.min(evt.clientY, maxY),
    att
  }
}

function closeContextMenu() {
  if (contextMenu.value.visible) {
    contextMenu.value.visible = false
  }
}

async function copyImageToClipboard() {
  const att = contextMenu.value.att
  if (!att || copyBusy.value) return
  closeContextMenu()

  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
    ElMessage({
      type: 'warning',
      message: $t('@WORKBENCH:当前浏览器不支持复制图片')
    })
    return
  }

  copyBusy.value = true
  try {
    const res = await fetch(`/api/workbench/attachments/${att.id}/raw`, {
      credentials: 'same-origin'
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    // 浏览器只接受 png/jpeg 等常见格式；非常规 mime 时回退为 png
    const type = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(blob.type)
      ? blob.type
      : 'image/png'
    const item = new ClipboardItem({ [type]: blob })
    await navigator.clipboard.write([item])
    ElMessage({
      type: 'success',
      message: $t('@WORKBENCH:图片已复制到剪贴板'),
      duration: 1800
    })
  } catch (err: any) {
    ElMessage({
      type: 'error',
      message: $t('@WORKBENCH:复制失败 {error}', { error: err?.message || '' })
    })
  } finally {
    copyBusy.value = false
  }
}

// 全局 click/滚轮/缩放 关闭菜单
if (typeof window !== 'undefined') {
  window.addEventListener('click', closeContextMenu)
  window.addEventListener('scroll', closeContextMenu, true)
  window.addEventListener('blur', closeContextMenu)
}
onBeforeUnmount(() => {
  if (typeof window === 'undefined') return
  window.removeEventListener('click', closeContextMenu)
  window.removeEventListener('scroll', closeContextMenu, true)
  window.removeEventListener('blur', closeContextMenu)
})
</script>

<template>
  <div
    class="wb-attachments"
    :class="{ 'is-paste-hover': isPasteHover }"
    @paste="emit('paste', $event)"
    @drop.prevent="emit('drop', $event)"
    @dragover.prevent="emit('dragover', $event)"
    @dragenter.prevent="emit('dragenter', $event)"
    @dragleave="emit('dragleave', $event)"
  >
    <div class="wb-attachments__head">
      <span class="wb-attachments__label">
        {{ $t('@WORKBENCH:附件') }}
        <span class="wb-attachments__count">{{ attachments.length }} / {{ maxCount }}</span>
      </span>
      <button
        class="wb-attachments__add wb-soft-btn"
        :disabled="isUploading || attachments.length >= maxCount"
        @click="onPick"
      >
        {{ isUploading ? $t('@WORKBENCH:上传中…') : $t('@WORKBENCH:添加附件') }}
      </button>
    </div>
    <div v-if="isPasteHover" class="wb-attachments__paste-hint">
      {{ $t('@WORKBENCH:粘贴图片以快速添加') }}
    </div>
    <ul v-if="attachments.length > 0" class="wb-attachments__list">
      <li v-for="att in attachments" :key="att.id" class="wb-attachment">
        <button
          type="button"
          class="wb-attachment__preview"
          :title="$t('@WORKBENCH:点击预览')"
          @click="previewAttachment(att)"
          @contextmenu="openContextMenu(att, $event)"
        >
          <div class="wb-attachment__icon" :class="{ 'wb-attachment__icon--img': isImage(att) }">
            <img
              v-if="isImage(att)"
              :src="`/api/workbench/attachments/${att.id}/raw`"
              :alt="att.originalName"
              loading="lazy"
            />
            <span v-else>{{ att.ext.toUpperCase() }}</span>
          </div>
          <div class="wb-attachment__meta">
            <div class="wb-attachment__name" :title="att.originalName">{{ att.originalName }}</div>
            <div class="wb-attachment__sub">{{ humanSize(att.size) }} · {{ att.mimeType }}</div>
          </div>
        </button>
        <button class="wb-attachment__del" @click.stop="onRemove(att)" :title="$t('@WORKBENCH:删除')">×</button>
      </li>
    </ul>
  </div>
  <teleport to="body">
    <el-image-viewer
      v-if="previewVisible && previewUrls.length > 0"
      :url-list="previewUrls"
      :initial-index="previewIndex"
      :hide-on-click-modal="true"
      @close="closePreview"
    />
  </teleport>

  <!-- 右键菜单：仅图片附件可用 -->
  <teleport to="body">
    <ul
      v-if="contextMenu.visible && contextMenu.att && isImage(contextMenu.att)"
      class="wb-ctx-menu"
      :style="{ top: contextMenu.y + 'px', left: contextMenu.x + 'px' }"
      @contextmenu.prevent
    >
      <li
        class="wb-ctx-menu__item"
        :class="{ 'is-disabled': copyBusy }"
        @click="copyImageToClipboard"
      >
        <span class="wb-ctx-menu__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="11" height="11" rx="2"></rect>
            <path d="M5 15V5a2 2 0 0 1 2-2h10"></path>
          </svg>
        </span>
        <span>{{ $t('@WORKBENCH:复制图片') }}</span>
      </li>
    </ul>
  </teleport>
</template>

<style scoped lang="scss">
.wb-ctx-menu {
  position: fixed;
  z-index: 9999;
  min-width: 140px;
  margin: 0;
  padding: 4px;
  list-style: none;
  background: var(--bg-container, var(--color-white, #ffffff));
  border: 1px solid var(--border-color, rgba(0, 0, 0, 0.08));
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
  user-select: none;
  font-size: 13px;

  &__item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: 4px;
    cursor: pointer;
    color: var(--text-primary, #303133);

    &:hover {
      background: var(--bg-container-hover, rgba(64, 158, 255, 0.12));
      color: var(--el-color-primary, #409eff);
    }

    &.is-disabled {
      cursor: progress;
      opacity: 0.6;
    }
  }

  &__icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
  }
}
</style>

<!--
  wb-attachments / wb-attachment / wb-attachments__add 等样式已抽到
  src/ui/client/src/styles/workbench.scss（全局）。这里不再重复定义。
  若需要在本组件内补充局部微调，可写 <style scoped> 并用 :deep() 穿透。
-->

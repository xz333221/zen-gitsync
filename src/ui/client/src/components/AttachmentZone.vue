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
import { computed, ref } from 'vue'
import { ElImageViewer } from 'element-plus'
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
        class="wb-attachments__add"
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
</template>

<style>
/* 非 scoped：让父组件 wb-attachments 样式生效。父组件的 .wb-attachments 块需要改为非 scoped，
   或使用 :deep() 包裹。简化方案：样式与父组件重复（保持非 scoped 即可）。 */
.wb-attachments {
  margin-top: 6px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm, 4px);
  background: var(--bg-subtle, var(--bg-container));
  overflow: hidden;
  transition: border-color 0.15s, background 0.15s;
  flex-shrink: 0;
}
.wb-attachments.is-paste-hover {
  border-color: var(--color-primary);
  background: rgba(59, 130, 246, 0.06);
  box-shadow: inset 0 0 0 1px var(--color-primary);
}
.wb-attachments__paste-hint {
  padding: 4px 10px;
  background: var(--color-primary);
  color: #fff;
  font-size: 12px;
  text-align: center;
  border-top: 1px solid var(--border-color);
}
.wb-attachments__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-color);
}
.wb-attachments__label { display: inline-flex; gap: 6px; align-items: center; }
.wb-attachments__count {
  font-variant-numeric: tabular-nums;
  color: var(--text-tertiary);
  font-size: 11px;
}
.wb-attachments__add {
  border: 1px solid var(--border-color);
  background: var(--bg-container);
  color: var(--text-primary);
  font-size: 12px;
  padding: 3px 10px;
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  transition: background 0.15s;
}
.wb-attachments__add:hover:not(:disabled) {
  background: rgba(59, 130, 246, 0.08);
  border-color: var(--color-primary);
  color: var(--color-primary);
}
.wb-attachments__add:disabled { opacity: 0.5; cursor: not-allowed; }
.wb-attachments__list {
  list-style: none;
  margin: 0;
  padding: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.wb-attachment {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 4px 4px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm, 4px);
  background: var(--bg-container);
  max-width: 240px;
  min-width: 0;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.wb-attachment:hover {
  border-color: var(--color-primary, #3b82f6);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.12);
}
.wb-attachment__preview {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.wb-attachment__preview:focus-visible {
  outline: 2px solid var(--color-primary, #3b82f6);
  outline-offset: 2px;
  border-radius: 3px;
}
.wb-attachment__icon {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  background: var(--bg-code);
  color: var(--text-tertiary);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
  overflow: hidden;
}
.wb-attachment__icon--img { background: var(--bg-code); }
.wb-attachment__icon img {
  width: 100%; height: 100%; object-fit: cover;
}
.wb-attachment__meta { min-width: 0; flex: 1; }
.wb-attachment__name {
  font-size: 12px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wb-attachment__sub {
  font-size: 10px;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wb-attachment__del {
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 16px;
  line-height: 1;
  width: 20px; height: 20px;
  border-radius: 3px;
  cursor: pointer;
  flex-shrink: 0;
}
.wb-attachment__del:hover { color: #ef4444; background: rgba(239,68,68,0.08); }
</style>

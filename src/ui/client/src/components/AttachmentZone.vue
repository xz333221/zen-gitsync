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

<!--
  wb-attachments / wb-attachment / wb-attachments__add 等样式已抽到
  src/ui/client/src/styles/workbench.scss（全局）。这里不再重复定义。
  若需要在本组件内补充局部微调，可写 <style scoped> 并用 :deep() 穿透。
-->

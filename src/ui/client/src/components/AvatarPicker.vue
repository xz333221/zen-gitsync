<template>
  <div class="avatar-picker">
    <div class="avatar-row">
      <!-- 预览：图片走 <img>，字符（emoji / 首字）直接渲染 -->
      <span class="avatar-preview" :style="{ background: previewBg }">
        <img v-if="isImage" :src="modelValue" alt="" />
        <span v-else class="avatar-text">{{ fallbackText }}</span>
      </span>

      <div class="avatar-actions">
        <button class="avatar-btn" type="button" @click="pickFile">{{ $t('@PEER:上传图片') }}</button>
        <button v-if="modelValue" class="avatar-btn avatar-btn--quiet" type="button" @click="choose('')">
          {{ $t('@PEER:清除') }}
        </button>
        <span class="avatar-hint">{{ $t('@PEER:PNG / JPG，自动裁成正方形') }}</span>
      </div>

      <input ref="fileRef" type="file" accept="image/png,image/jpeg,image/webp,image/gif" class="avatar-file" @change="onFile" />
    </div>

    <!-- 预设：一组 emoji 头像。比内置 PNG 更省事 —— 不受构建哈希影响、不算资源体积，
         在天蓝色的圆形底上看起来就是一张"头像"。 -->
    <div class="avatar-grid">
      <button
        v-for="emoji in PRESETS"
        :key="emoji"
        class="avatar-item"
        :class="{ active: modelValue === emoji }"
        type="button"
        @click="choose(emoji)"
      >{{ emoji }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
// 头像选择器：预设 emoji + 本地图片上传（客户端裁成 256×256 后转 data URL）。
//
// 为什么把图片转成 data URL 而不是传文件到服务端：
//   头像要跨机器显示 —— 对方是拿 /api/peer/info 里的那串字符串去渲染的，没有本机
//   的静态目录可访问。data URL 自带内容，天然跟着这串字符串走，也不需要给 peer
//   端口再加一个"取头像"的鉴权接口。
// 代价是 peers.json 里会多十几 KB —— 一张 256×256 的 webp 大约 10~30KB，可接受。
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { $t } from '@/lang/static'

const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const PRESETS = ['🐱', '🦊', '🐼', '🐧', '🐳', '🦉', '🐙', '🦄', '🤖', '👾', '🌵', '🍊', '🌙', '⚡']

const MAX_SIDE = 256
const fileRef = ref<HTMLInputElement | null>(null)

const isImage = computed(() => /^data:image\//i.test(props.modelValue) || /^https?:\/\//i.test(props.modelValue))
const fallbackText = computed(() => (props.modelValue || '?').slice(0, 2))
const previewBg = computed(() => (isImage.value ? 'var(--bg-subtle)' : 'var(--role-ai-surface, var(--bg-subtle))'))

function choose(value: string) {
  emit('update:modelValue', value)
}

function pickFile() {
  fileRef.value?.click()
}

/** 中心正方形裁切 + 缩放到 MAX_SIDE，再转 data URL。 */
async function toAvatarDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = MAX_SIDE
  canvas.height = MAX_SIDE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    MAX_SIDE,
    MAX_SIDE
  )
  // webp 体积大约是 png 的 1/4；老浏览器不支持时 canvas 会自动回落成 png
  return canvas.toDataURL('image/webp', 0.86)
}

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 允许重复选同一个文件
  if (!file) return
  if (!/^image\//.test(file.type)) {
    ElMessage.warning($t('@PEER:只能选图片文件'))
    return
  }
  if (file.size > 8 * 1024 * 1024) {
    ElMessage.warning($t('@PEER:图片太大了（上限 8MB）'))
    return
  }
  try {
    emit('update:modelValue', await toAvatarDataUrl(file))
  } catch (err: any) {
    ElMessage.error($t('@PEER:读取图片失败：{msg}', { msg: err?.message || err }))
  }
}
</script>

<style scoped>
.avatar-picker {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.avatar-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.avatar-preview {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  line-height: 1;
}

.avatar-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.avatar-text {
  font-size: 22px;
}

.avatar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.avatar-btn {
  padding: 4px 10px;
  font-size: 11px;
  color: var(--text-primary);
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
}

.avatar-btn:hover {
  background: var(--bg-hover);
}

.avatar-btn--quiet {
  background: transparent;
  color: var(--text-secondary);
}

.avatar-hint {
  font-size: 11px;
  color: var(--text-secondary);
}

.avatar-file {
  display: none;
}

.avatar-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(34px, 1fr));
  gap: 6px;
  max-width: 420px;
}

.avatar-item {
  width: 34px;
  height: 34px;
  padding: 0;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  background: var(--bg-subtle);
  border: 1px solid transparent;
  border-radius: 50%;
  transition: border-color 120ms ease, background 120ms ease;
}

.avatar-item:hover {
  background: var(--bg-hover);
}

.avatar-item.active {
  border-color: var(--color-primary);
}
</style>

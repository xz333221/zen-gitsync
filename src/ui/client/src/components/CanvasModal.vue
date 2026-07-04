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
 * CanvasModal: 画布内浮层 + 局部 backdrop。
 *
 * 设计成 el-dialog 的替代品:不走 el-plus 默认的 Teleport-to-body,
 * 而是用 absolute 定位嵌套在父容器(典型如 .mm-editor)里。结果是
 * backdrop 只遮画布,不挡宿主页面顶 toolbar / 侧栏。父容器需要是
 * position: relative / absolute 才能容纳本组件的 absolute children。
 */
withDefaults(
  defineProps<{
    /** Show / hide. Animation handles the transition. */
    open?: boolean
    /** Header text. */
    title?: string
    /** Modal width in pixels. Default 480. */
    width?: number
    /** Hide the close (×) button. Default false. */
    closable?: boolean
    /** Dismiss by clicking the backdrop. Default true. */
    closeOnBackdrop?: boolean
  }>(),
  { open: false, title: '', width: 480, closable: true, closeOnBackdrop: true }
)
const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'close'): void
}>()

function close() {
  emit('update:open', false)
  emit('close')
}
function onBackdrop() {
  emit('update:open', false)
  emit('close')
}
</script>

<template>
  <Transition name="cm-fade">
    <div
      v-if="open"
      class="canvas-modal-backdrop"
      :aria-hidden="!open"
      @click="closeOnBackdrop && onBackdrop()"
    />
  </Transition>
  <Transition name="cm-pop">
    <div
      v-if="open"
      class="canvas-modal"
      :style="{ width: width + 'px' }"
      role="dialog"
      :aria-modal="open"
    >
      <header v-if="title || $slots.header" class="canvas-modal-header">
        <h3 v-if="title" class="canvas-modal-title">{{ title }}</h3>
        <slot name="header" />
        <button
          v-if="closable"
          class="canvas-modal-close"
          title="关闭"
          type="button"
          @click="close"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M6 6 L18 18 M18 6 L6 18" />
          </svg>
        </button>
      </header>
      <div class="canvas-modal-body">
        <slot />
      </div>
      <footer v-if="$slots.footer" class="canvas-modal-footer">
        <slot name="footer" />
      </footer>
    </div>
  </Transition>
</template>

<style>
.canvas-modal-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(15, 23, 42, 0.36);
  z-index: 50;
}
.canvas-modal {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  max-width: calc(100% - 32px);
  max-height: calc(100% - 32px);
  background: var(--el-bg-color, #ffffff);
  color: var(--el-text-color-primary, #1e293b);
  border-radius: 6px;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
  z-index: 51;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.canvas-modal-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--el-border-color-lighter, #f1f5f9);
  flex-shrink: 0;
}
.canvas-modal-title {
  margin: 0;
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.canvas-modal-close {
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.canvas-modal-close:hover {
  background: var(--el-fill-color-light, #f1f5f9);
  color: var(--el-text-color-primary, #1e293b);
}
.canvas-modal-body {
  padding: 16px;
  overflow: auto;
  flex: 1;
  min-height: 0;
}
.canvas-modal-footer {
  padding: 10px 16px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  border-top: 1px solid var(--el-border-color-lighter, #f1f5f9);
  flex-shrink: 0;
}
.cm-fade-enter-active,
.cm-fade-leave-active {
  transition: opacity 0.18s ease;
}
.cm-fade-enter-from,
.cm-fade-leave-to {
  opacity: 0;
}
.cm-pop-enter-active,
.cm-pop-leave-active {
  transition: opacity 0.18s ease, transform 0.22s ease;
}
.cm-pop-enter-from,
.cm-pop-leave-to {
  opacity: 0;
  transform: translate(-50%, -50%) scale(0.96);
}
</style>

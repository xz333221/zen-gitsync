<template>
  <teleport to="body">
    <transition name="success-fade">
      <div v-if="visible" class="success-overlay" @click.stop>
        <div class="success-container">
          <!-- 成功图标 -->
          <div class="success-icon">
            <svg viewBox="0 0 52 52" class="success-svg">
              <circle class="success-circle" cx="26" cy="26" r="25" fill="none"/>
              <path class="success-check" fill="none" d="m14.1 27.2l7.1 7.2 16.7-16.8"/>
            </svg>
          </div>
          
          <!-- 成功文字 -->
          <div class="success-text">{{ text }}</div>
          
          <!-- 描述文字 -->
          <div v-if="description" class="success-description">{{ description }}</div>
        </div>
      </div>
    </transition>
  </teleport>
</template>

<script setup lang="ts">
import { $t } from '@/lang/static'
interface Props {
  visible?: boolean
  text?: string
  description?: string
}

withDefaults(defineProps<Props>(), {
  visible: false,
  text: $t('@71545:操作成功！'),
  description: ''
})
</script>

<style scoped lang="scss">
.success-overlay {
  position: fixed;
  inset: 0;
  background: var(--dialog-overlay);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-2xl);
  z-index: 9999;
}

.success-container {
  width: min(92vw, 420px);
  background: var(--bg-container);
  border: 1px solid var(--dialog-border-color);
  border-radius: var(--dialog-radius);
  padding: 32px 30px 28px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  box-shadow: var(--dialog-shadow);
  text-align: center;
}

.success-icon {
  width: 76px;
  height: 76px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-success) 10%, var(--bg-container) 90%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-success) 18%, transparent 82%);
}

.success-svg {
  width: 48px;
  height: 48px;
}

.success-circle {
  stroke: var(--color-success);
  stroke-width: 2;
  stroke-miterlimit: 10;
  stroke-dasharray: 166;
  stroke-dashoffset: 166;
  fill: none;
  animation: success-circle-animation 0.58s cubic-bezier(0.22, 1, 0.36, 1) forwards;
}

.success-check {
  stroke: var(--color-success);
  stroke-width: 3;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-dasharray: 48;
  stroke-dashoffset: 48;
  animation: success-check-animation 0.24s cubic-bezier(0.22, 1, 0.36, 1) 0.5s forwards;
}

.success-text {
  max-width: 18ch;
  font-size: clamp(20px, 2vw, 22px);
  font-weight: var(--font-weight-semibold);
  line-height: 1.25;
  letter-spacing: var(--letter-spacing-heading);
  margin: 0;
  color: var(--text-title);
}

.success-description {
  max-width: 28ch;
  font-size: var(--font-size-base);
  color: var(--text-secondary);
  margin: 0;
  line-height: var(--line-height-relaxed);
}

/* 动画效果 */
@keyframes success-circle-animation {
  to {
    stroke-dashoffset: 0;
  }
}

@keyframes success-check-animation {
  to {
    stroke-dashoffset: 0;
  }
}

/* 过渡动画 */
.success-fade-enter-active,
.success-fade-leave-active {
  transition: opacity 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}

.success-fade-enter-from,
.success-fade-leave-to {
  opacity: 0;
}

.success-fade-enter-to,
.success-fade-leave-from {
  opacity: 1;
}

.success-fade-enter-active .success-container,
.success-fade-leave-active .success-container {
  transition:
    opacity 0.22s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}

.success-fade-enter-from .success-container,
.success-fade-leave-to .success-container {
  opacity: 0;
  transform: translateY(8px) scale(0.985);
}

.success-fade-enter-to .success-container,
.success-fade-leave-from .success-container {
  opacity: 1;
  transform: translateY(0) scale(1);
}
</style>

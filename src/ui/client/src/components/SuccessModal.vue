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
interface Props {
  visible?: boolean
  text?: string
  description?: string
}

withDefaults(defineProps<Props>(), {
  visible: false,
  text: '操作成功！',
  description: ''
})
</script>

<style scoped lang="scss">
.success-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.success-container {
  background: #ffffff;
  border-radius: 16px;
  padding: 40px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.2);
  max-width: 400px;
  text-align: center;
}

.success-icon {
  width: 80px;
  height: 80px;
}

.success-svg {
  width: 100%;
  height: 100%;
}

.success-circle {
  stroke: #67c23a;
  stroke-width: 2;
  stroke-miterlimit: 10;
  stroke-dasharray: 166;
  stroke-dashoffset: 166;
  fill: none;
  animation: success-circle-animation 0.6s cubic-bezier(0.65, 0, 0.45, 1) forwards;
}

.success-check {
  stroke: #67c23a;
  stroke-width: 3;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-dasharray: 48;
  stroke-dashoffset: 48;
  animation: success-check-animation 0.3s cubic-bezier(0.65, 0, 0.45, 1) 0.8s forwards;
}

.success-text {
  font-size: 24px;
  font-weight: 700;
  color: #303133;
  margin: 0;
}

.success-description {
  font-size: 16px;
  color: #606266;
  margin: 0;
  line-height: 1.5;
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
  transition: all 0.3s ease;
}

.success-fade-enter-from,
.success-fade-leave-to {
  opacity: 0;
  backdrop-filter: blur(0px);
}

.success-fade-enter-to,
.success-fade-leave-from {
  opacity: 1;
  backdrop-filter: blur(8px);
}

.success-fade-enter-active .success-container,
.success-fade-leave-active .success-container {
  transition: all 0.3s ease;
}

.success-fade-enter-from .success-container,
.success-fade-leave-to .success-container {
  opacity: 0;
  transform: scale(0.8) translateY(20px);
}

.success-fade-enter-to .success-container,
.success-fade-leave-from .success-container {
  opacity: 1;
  transform: scale(1) translateY(0);
}
</style>

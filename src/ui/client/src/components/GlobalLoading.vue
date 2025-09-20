<template>
  <teleport to="body">
    <transition name="loading-fade">
      <div v-if="visible" class="global-loading-overlay" @click.stop>
        <div class="loading-container">
          <!-- 主加载器 -->
          <div class="loading-spinner">
            <div class="spinner-ring"></div>
            <div class="spinner-ring"></div>
            <div class="spinner-ring"></div>
          </div>
          
          <!-- 加载文字 -->
          <div class="loading-text">{{ text }}</div>
          
          <!-- 进度条（可选） -->
          <div v-if="showProgress" class="loading-progress">
            <div class="progress-bar" :style="{ width: progress + '%' }"></div>
          </div>
        </div>
      </div>
    </transition>
  </teleport>
</template>

<script setup lang="ts">
interface Props {
  visible?: boolean
  text?: string
  showProgress?: boolean
  progress?: number
}

withDefaults(defineProps<Props>(), {
  visible: false,
  text: '加载中...',
  showProgress: false,
  progress: 0
})
</script>

<style scoped lang="scss">
.global-loading-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(135deg, rgba(64, 158, 255, 0.95) 0%, rgba(103, 194, 58, 0.95) 100%);
  backdrop-filter: blur(15px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.loading-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
}

.loading-spinner {
  position: relative;
  width: 120px;
  height: 120px;
}

.spinner-ring {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border: 4px solid transparent;
  border-radius: 50%;
}

.spinner-ring:nth-child(1) {
  border-top: 4px solid rgba(255, 255, 255, 0.9);
  animation: spin 2s linear infinite;
}

.spinner-ring:nth-child(2) {
  border-right: 4px solid rgba(255, 255, 255, 0.6);
  animation: spin 3s linear infinite reverse;
  width: 90%;
  height: 90%;
  top: 5%;
  left: 5%;
}

.spinner-ring:nth-child(3) {
  border-bottom: 4px solid rgba(255, 255, 255, 0.3);
  animation: spin 4s linear infinite;
  width: 80%;
  height: 80%;
  top: 10%;
  left: 10%;
}

.loading-text {
  color: #ffffff;
  font-size: 18px;
  font-weight: 600;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  letter-spacing: 1px;
  text-align: center;
  animation: pulse-text 2s ease-in-out infinite;
}

.loading-progress {
  width: 200px;
  height: 4px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  background: linear-gradient(90deg, #ffffff 0%, rgba(255, 255, 255, 0.8) 100%);
  border-radius: 2px;
  transition: width 0.3s ease;
  box-shadow: 0 0 10px rgba(255, 255, 255, 0.5);
}

/* 动画效果 */
@keyframes spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

@keyframes pulse-text {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.8;
    transform: scale(1.05);
  }
}

/* 过渡动画 */
.loading-fade-enter-active,
.loading-fade-leave-active {
  transition: all 0.3s ease;
}

.loading-fade-enter-from,
.loading-fade-leave-to {
  opacity: 0;
  backdrop-filter: blur(0px);
}

.loading-fade-enter-to,
.loading-fade-leave-from {
  opacity: 1;
  backdrop-filter: blur(15px);
}

.loading-fade-enter-active .loading-container,
.loading-fade-leave-active .loading-container {
  transition: all 0.3s ease;
}

.loading-fade-enter-from .loading-container,
.loading-fade-leave-to .loading-container {
  opacity: 0;
  transform: scale(0.8);
}

.loading-fade-enter-to .loading-container,
.loading-fade-leave-from .loading-container {
  opacity: 1;
  transform: scale(1);
}
</style>

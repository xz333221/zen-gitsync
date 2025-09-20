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
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.loading-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  background: rgba(255, 255, 255, 0.95);
  padding: 24px;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
  backdrop-filter: blur(8px);
  min-width: 120px;
}

.loading-spinner {
  position: relative;
  width: 32px;
  height: 32px;
}

.spinner-ring {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border: 2px solid #e4e7ed;
  border-top: 2px solid #409eff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.spinner-ring:nth-child(2),
.spinner-ring:nth-child(3) {
  display: none;
}

.loading-text {
  color: #606266;
  font-size: 13px;
  font-weight: 400;
  text-align: center;
  margin-top: 4px;
}

.loading-progress {
  width: 200px;
  height: 4px;
  background: #f0f0f0;
  border-radius: 2px;
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  background: #409eff;
  border-radius: 2px;
  transition: width 0.3s ease;
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

/* 过渡动画 */
.loading-fade-enter-active,
.loading-fade-leave-active {
  transition: all 0.2s ease;
}

.loading-fade-enter-from,
.loading-fade-leave-to {
  opacity: 0;
}

.loading-fade-enter-to,
.loading-fade-leave-from {
  opacity: 1;
}

.loading-fade-enter-active .loading-container,
.loading-fade-leave-active .loading-container {
  transition: all 0.2s ease;
}

.loading-fade-enter-from .loading-container,
.loading-fade-leave-to .loading-container {
  opacity: 0;
  transform: scale(0.9);
}

.loading-fade-enter-to .loading-container,
.loading-fade-leave-from .loading-container {
  opacity: 1;
  transform: scale(1);
}
</style>

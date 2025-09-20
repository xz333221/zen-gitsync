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
  background: #ffffff;
  padding: 32px;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.loading-spinner {
  position: relative;
  width: 40px;
  height: 40px;
}

.spinner-ring {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border: 3px solid #f3f3f3;
  border-top: 3px solid #409eff;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

.spinner-ring:nth-child(2),
.spinner-ring:nth-child(3) {
  display: none;
}

.loading-text {
  color: #606266;
  font-size: 14px;
  font-weight: 400;
  text-align: center;
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

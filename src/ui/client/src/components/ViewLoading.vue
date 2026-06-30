<!--
  视图懒加载占位组件:defineAsyncComponent 的 loadingComponent 用。
  首次切换到某视图时,chunk 还在下载,这里显示一个内联居中的轻量 spinner;
  chunk 加载完成 / KeepAlive 缓存命中后秒切,不再显示。
  不用全屏遮罩(GlobalLoading 那种),只在视图面板内部占位。
-->
<template>
  <div class="view-loading">
    <div class="view-loading__spinner" role="status" :aria-label="text">
      <svg viewBox="0 0 24 24" class="view-loading__icon">
        <circle class="view-loading__track" cx="12" cy="12" r="9" fill="none" stroke-width="2.5" />
        <circle class="view-loading__arc" cx="12" cy="12" r="9" fill="none" stroke-width="2.5" stroke-linecap="round" />
      </svg>
      <span class="view-loading__text">{{ text }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { $t } from '@/lang/static'
interface Props {
  text?: string
}
withDefaults(defineProps<Props>(), {
  text: $t('@2AEBA:加载中...')
})
</script>

<style scoped lang="scss">
.view-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-height: 240px;
  background: var(--bg-page, transparent);
}

.view-loading__spinner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-md, 12px);
}

.view-loading__icon {
  width: 36px;
  height: 36px;
  animation: view-loading-spin 0.9s linear infinite;
}

.view-loading__track {
  stroke: var(--border-color, rgba(0, 0, 0, 0.1));
  opacity: 0.5;
}

.view-loading__arc {
  stroke: var(--color-primary, #409eff);
  stroke-dasharray: 42 60;
  stroke-dashoffset: 0;
  transform-origin: 50% 50%;
}

.view-loading__text {
  font-size: var(--font-size-sm, 13px);
  color: var(--color-text-secondary, rgba(0, 0, 0, 0.55));
  letter-spacing: 0.5px;
}

@keyframes view-loading-spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

[data-theme="dark"] .view-loading {
  background: var(--bg-page, transparent);
}

[data-theme="dark"] .view-loading__track {
  stroke: rgba(255, 255, 255, 0.12);
}

[data-theme="dark"] .view-loading__text {
  color: var(--color-text-secondary, rgba(255, 255, 255, 0.6));
}
</style>

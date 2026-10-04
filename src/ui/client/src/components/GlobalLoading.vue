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
<template>
  <teleport to="body">
    <transition name="loading-fade">
      <div v-if="visible || mock" class="global-loading-overlay" @click.stop>
        <div class="loading-container">
          <!-- 主加载器 -->
          <div class="loading-spinner">
            <div class="spinner-ring"></div>
            <div class="spinner-ring"></div>
            <div class="spinner-ring"></div>
          </div>
          
          <!-- 加载文字 -->
          <div class="loading-text">{{ text }}</div>
          
          <!-- 进度条（可选/Mock） -->
          <div v-if="showProgress || mock" class="loading-progress">
            <div class="progress-bar" :class="{ 'is-mock': mock && !showProgress }" :style="showProgress ? { width: progress + '%' } : undefined"></div>
          </div>
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
  showProgress?: boolean
  progress?: number
  /** 开启后组件将强制展示，适合开发/演示使用 */
  mock?: boolean
}

withDefaults(defineProps<Props>(), {
  visible: false,
  text: $t('@2AEBA:加载中...'),
  showProgress: false,
  progress: 0,
  mock: false
})
</script>

<style scoped lang="scss">
.global-loading-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  /* 浅色原本是 rgba(255,255,255,0) 全透明，暗色却是 0.45 —— 同一个遮罩在两套
     主题下是两件不同的东西。现统一成一层极淡的面板色，挡得住但不抢戏。 */
  background: var(--bg-panel);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-menu-float);
}

.loading-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  /* 固定宽度让 loading 框保持紧凑,不被 spinner/文字撑长 */
  width: 240px;
  /* 全局有 .loading-container { height: 100% } 会把它撑到 overlay 全高,
     这里用 !important 压住,让高度由内容决定 */
  height: auto !important;
  gap: var(--spacing-md);
  padding: 28px 32px;
  border-radius: var(--radius-xl);
  /* 2026-10-04：原来是蓝→绿彩虹渐变 + backdrop-filter: blur(25px) + 0 8px 32px
     重阴影，三样都撞在 PRODUCT.md 的反参考上（禁彩虹渐变 / 禁玻璃拟态 / 禁重阴影），
     而且用的是 Element Plus 旧默认蓝 #409eff —— variables.scss:394-397 已明确
     不再保留它（历史上两套蓝同屏可见色差）。现改为纯令牌底 + 1px 描边，
     明暗两套主题自动切换，下面的 [data-theme="dark"] 整段覆盖已随之删除。 */
  background: var(--bg-container);
  border: 1px solid var(--border-color);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.loading-spinner {
  position: relative;
  width: 64px;
  height: 64px;
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
  border-top: 4px solid var(--color-primary);
  animation: spin 2s linear infinite;
}

.spinner-ring:nth-child(2) {
  border-right: 4px solid var(--tint-primary-45);
  animation: spin 3s linear infinite reverse;
  width: 90%;
  height: 90%;
  top: 5%;
  left: 5%;
}

.spinner-ring:nth-child(3) {
  border-bottom: 4px solid var(--tint-primary-20);
  animation: spin 4s linear infinite;
  width: 80%;
  height: 80%;
  top: 10%;
  left: 10%;
}

.loading-text {
  font-size: var(--font-size-lg);
  font-weight: 600;
  letter-spacing: 1px;
  text-align: center;
  /* 文字压在面板底色上（不再是半透明彩底），所以不需要 text-shadow ——
     原来那层阴影是为了在蓝绿渐变上把白字捞出来。 */
  color: var(--text-primary);
  animation: pulse-text 2s ease-in-out infinite;
}

.loading-progress {
  width: 200px;
  height: 4px;
  background: var(--bg-subtle);
  border-radius: var(--radius-xs);
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  /* 原来是白→白半透明渐变压在蓝绿底上，浅色主题下几乎看不见。 */
  background: var(--color-primary);
  border-radius: var(--radius-xs);
  transition: width var(--transition-slow) ease;
}

/* Mock 进度：自动循环 */
.progress-bar.is-mock {
  width: 0%;
  animation: mock-progress 2.4s ease-in-out infinite;
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
  /* 原来 50% 那一帧还带 transform: scale(1.05)。呼吸感来自透明度就够了，
     缩放属于装饰性动效（PRODUCT.md: 禁 decorative motion）。 */
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.65;
  }
}

@keyframes mock-progress {
  0% { width: 0%; }
  50% { width: 70%; }
  100% { width: 100%; }
}

/* 过渡动画 */
.loading-fade-enter-active,
.loading-fade-leave-active {
  transition: var(--transition-ui-slow);
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
  transition: var(--transition-ui-slow);
}

.loading-fade-enter-from .loading-container,
.loading-fade-leave-to .loading-container {
  opacity: 0;
  transform: scale(0.96);
}

.loading-fade-enter-to .loading-container,
.loading-fade-leave-from .loading-container {
  opacity: 1;
  transform: scale(1);
}

/* 原先这里有 5 条 [data-theme="dark"] 覆盖，其中 .loading-container 用的还是
   另一套纯灰渐变 rgba(22,22,22,.9)→rgba(28,28,28,.9) —— 和浅色的蓝绿渐变
   完全是两个物体。现在底色/文字/进度条全部走令牌，这 5 条覆盖自然失效，
   不需要再各自维护一遍。 */
</style>

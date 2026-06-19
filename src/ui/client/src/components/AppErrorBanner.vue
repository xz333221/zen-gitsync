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
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { $t } from '@/lang/static'
import { useNetworkStatus } from '@/composables/useNetworkStatus'
import { WarningFilled, Refresh, Close } from '@element-plus/icons-vue'

const { isOnline, lastError, lastErrorAt, isDismissed, retryLast, dismiss } = useNetworkStatus()

const shouldShow = computed(() => !isOnline.value && !isDismissed.value)

// 手动控制 enter/leave 状态:用 v-if + isLeaving 标记 + setTimeout 收尾
// 原因:Vue <transition> 在某些环境(chromium devtools sandbox、prefers-reduced-motion)
// 下 transitionend 不触发,会导致 leave 状态机卡死,元素永远不消失。改用 v-if +
// isLeaving flag 自己控制,逻辑更直观可控。
const visible = ref(false)
const isLeaving = ref(false)
const LEAVE_ANIMATION_MS = 280

watch(shouldShow, (show, prev) => {
  if (show) {
    // enter:清除 leaving 标记,直接显示
    isLeaving.value = false
    visible.value = true
  } else if (visible.value && prev !== undefined) {
    // leave:只触发一次
    isLeaving.value = true
    window.setTimeout(() => {
      visible.value = false
      isLeaving.value = false
    }, LEAVE_ANIMATION_MS)
  }
}, { immediate: true })

const relativeTime = ref($t('@NET:刚刚'))
let relativeTimer: ReturnType<typeof setInterval> | null = null

function updateRelativeTime() {
  const ts = lastErrorAt.value
  if (!ts) {
    relativeTime.value = $t('@NET:刚刚')
    return
  }
  const diff = Math.max(0, Date.now() - ts)
  if (diff < 1000) relativeTime.value = $t('@NET:刚刚')
  else if (diff < 60_000) relativeTime.value = `${Math.floor(diff / 1000)}s`
  else relativeTime.value = `${Math.floor(diff / 60_000)}m`
}

function startRelativeTimer() {
  if (relativeTimer) return
  updateRelativeTime()
  relativeTimer = setInterval(updateRelativeTime, 1000)
}

function stopRelativeTimer() {
  if (!relativeTimer) return
  clearInterval(relativeTimer)
  relativeTimer = null
}

watch(shouldShow, (show) => {
  if (show) startRelativeTimer()
  else stopRelativeTimer()
})

onBeforeUnmount(stopRelativeTimer)
</script>

<template>
  <div
    v-if="visible"
    :class="['app-error-banner', { 'is-leaving': isLeaving }]"
    role="alert"
    aria-live="assertive"
  >
    <div class="banner-left">
      <el-icon class="banner-icon" aria-hidden="true"><WarningFilled /></el-icon>
      <div class="banner-text">
        <span class="banner-title">
          {{ $t('@NET:无法连接到本地服务,请检查后端进程') }}
        </span>
        <span v-if="lastError" class="banner-detail">
          {{ lastError }} ·
          <span data-net-error-time>{{ relativeTime }}</span>
        </span>
      </div>
    </div>
    <div class="banner-actions">
      <button
        type="button"
        class="banner-btn banner-btn--retry"
        @click="retryLast"
      >
        <el-icon class="banner-btn-icon" aria-hidden="true"><Refresh /></el-icon>
        <span>{{ $t('@NET:重试') }}</span>
      </button>
      <button
        type="button"
        class="banner-btn banner-btn--close"
        :aria-label="$t('@NET:关闭')"
        @click="dismiss"
      >
        <el-icon class="banner-btn-icon" aria-hidden="true"><Close /></el-icon>
      </button>
    </div>
  </div>
</template>

<style scoped>
.app-error-banner {
  position: fixed;
  top: 64px;
  left: 0;
  right: 0;
  height: 44px;
  z-index: 1002;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--spacing-lg);
  background: var(--tint-danger-14);
  border-bottom: 1px solid color-mix(in srgb, var(--color-danger) 35%, transparent);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  /* enter: 从上方滑入 + 渐显 */
  animation: app-error-banner-enter 0.28s var(--ease-custom);
}

.app-error-banner.is-leaving {
  /* leave: 滑出 + 渐隐,通过 is-leaving class 触发,不用 Vue <transition> */
  animation: app-error-banner-leave 0.28s var(--ease-custom) forwards;
}

[data-theme="dark"] .app-error-banner {
  background: color-mix(in srgb, var(--color-danger) 18%, transparent);
  border-bottom-color: color-mix(in srgb, var(--color-danger) 40%, transparent);
}

@keyframes app-error-banner-enter {
  from {
    transform: translateY(-100%);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

@keyframes app-error-banner-leave {
  from {
    transform: translateY(0);
    opacity: 1;
  }
  to {
    transform: translateY(-100%);
    opacity: 0;
  }
}

.banner-left {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  min-width: 0;
}

.banner-icon {
  color: var(--color-danger);
  flex-shrink: 0;
  font-size: 18px;
}

.banner-text {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  min-width: 0;
  flex-wrap: wrap;
}

.banner-title {
  font-weight: 600;
  white-space: nowrap;
}

.banner-detail {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 60vw;
}

.banner-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex-shrink: 0;
}

.banner-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: var(--transition-all);
}

.banner-btn:hover {
  background: var(--tint-danger-08);
  border-color: var(--color-danger);
  color: var(--color-danger);
}

.banner-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--focus-ring-color);
  border-color: var(--color-danger);
}

.banner-btn--close {
  width: 28px;
  padding: 0;
  justify-content: center;
}

.banner-btn-icon {
  font-size: 14px;
}

/* 减弱 motion —— 把 enter/leave 时长缩短为 1ms,视觉上无动画但状态机不卡死 */
@media (prefers-reduced-motion: reduce) {
  .app-error-banner,
  .app-error-banner.is-leaving {
    animation-duration: 1ms;
  }
}
</style>

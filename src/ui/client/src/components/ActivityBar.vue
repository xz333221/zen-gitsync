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
import { $t } from '@/lang/static'
import { ElTooltip } from 'element-plus'
import { useWorkbenchStatusStore } from '@stores/workbenchStatus'

const props = defineProps<{
  activeView: 'git' | 'editor' | 'source-map' | 'workbench'
}>()

const emit = defineEmits<{
  'update:activeView': [view: 'git' | 'editor' | 'source-map' | 'workbench']
}>()

const wbStatus = useWorkbenchStatusStore()

function select(view: 'git' | 'editor' | 'source-map' | 'workbench') {
  emit('update:activeView', view)
}
</script>

<template>
  <div class="activity-bar">
    <!-- Git 页面 -->
    <el-tooltip :content="$t('@ACTBAR:Git')" placement="right" :show-after="300">
      <button
        class="activity-btn"
        :class="{ active: props.activeView === 'git' }"
        @click="select('git')"
        :aria-label="$t('@ACTBAR:Git')"
        :aria-pressed="props.activeView === 'git'"
      >
        <!-- Git 分支图：竖干 + 向右开出分支 + 圆形节点 -->
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <circle cx="7" cy="4.5" r="2" />
          <circle cx="7" cy="19.5" r="2" />
          <circle cx="17" cy="8.5" r="2" />
          <line x1="7" y1="6.5" x2="7" y2="17.5" />
          <path d="M7 6.5 C7 10 17 8.5 17 8.5" />
        </svg>
      </button>
    </el-tooltip>

    <!-- 编辑器页面 -->
    <el-tooltip :content="$t('@ACTBAR:编辑器')" placement="right" :show-after="300">
      <button
        class="activity-btn"
        :class="{ active: props.activeView === 'editor' }"
        @click="select('editor')"
        :aria-label="$t('@ACTBAR:编辑器')"
        :aria-pressed="props.activeView === 'editor'"
      >
        <!-- 文件资源管理器：文件夹 + 文件树 -->
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <!-- 文件夹 -->
          <path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7z" />
          <!-- 内部文件行 -->
          <line x1="8" y1="13" x2="16" y2="13" stroke-width="1.5" />
          <line x1="8" y1="16" x2="13" y2="16" stroke-width="1.5" />
        </svg>
      </button>
    </el-tooltip>

    <!-- 源码地图 -->
    <el-tooltip :content="$t('@ACTBAR:源码地图')" placement="right" :show-after="300">
      <button
        class="activity-btn"
        :class="{ active: props.activeView === 'source-map' }"
        @click="select('source-map')"
        :aria-label="$t('@ACTBAR:源码地图')"
        :aria-pressed="props.activeView === 'source-map'"
      >
        <!-- 思维导图：中心节点 + 三条分支辐射 -->
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="2.4" />
          <!-- 上分支 -->
          <line x1="12" y1="9.6" x2="12" y2="4" />
          <circle cx="12" cy="3" r="1.5" />
          <!-- 左下分支 -->
          <line x1="9.9" y1="13.4" x2="6" y2="18" />
          <circle cx="5.2" cy="19" r="1.5" />
          <!-- 右下分支 -->
          <line x1="14.1" y1="13.4" x2="18" y2="18" />
          <circle cx="18.8" cy="19" r="1.5" />
        </svg>
      </button>
    </el-tooltip>

    <!-- 工作台 -->
    <el-tooltip :content="$t('@ACTBAR:工作台')" placement="right" :show-after="300">
      <button
        class="activity-btn"
        :class="{ active: props.activeView === 'workbench' }"
        @click="select('workbench')"
        :aria-label="$t('@ACTBAR:工作台')"
        :aria-pressed="props.activeView === 'workbench'"
      >
        <!-- 任务清单：勾选列表（代表 AI 任务工作台） -->
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <rect x="3" y="3" width="18" height="18" rx="2.5" />
          <!-- 第一行：勾 + 文字线 -->
          <polyline points="7 8.5 9 10.5 12.5 7" stroke-width="1.7" />
          <line x1="14" y1="8.5" x2="18" y2="8.5" stroke-width="1.5" />
          <!-- 第二行：勾 + 文字线 -->
          <polyline points="7 13 9 15 12.5 11.5" stroke-width="1.7" />
          <line x1="14" y1="13" x2="18" y2="13" stroke-width="1.5" />
          <!-- 第三行：空圆 + 短文字线（未完成） -->
          <circle cx="8" cy="17.5" r="1.3" stroke-width="1.4" />
          <line x1="11" y1="17.5" x2="17" y2="17.5" stroke-width="1.5" />
        </svg>
        <span
          v-if="wbStatus.hasRunning"
          class="wb-running-dot"
          :title="$t('@ACTBAR:有任务正在执行')"
          aria-hidden="true"
        />
      </button>
    </el-tooltip>
  </div>
</template>

<style scoped>
.activity-bar {
  width: 48px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 10px 0;
  gap: 6px;
  background: var(--bg-container);
  border-right: 1px solid var(--border-color);
  border-radius: 0;
  box-shadow: var(--shadow-sm);
}

/* ── 单个活动按钮 ─────────────────────────────────────────────── */
.activity-btn {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  border-radius: var(--radius-md);
  color: var(--text-tertiary);
  cursor: pointer;
  padding: 0;
  position: relative;
  /* 颜色 + 背景平滑过渡 */
  transition:
    color 0.18s cubic-bezier(0.4, 0, 0.2, 1),
    background-color 0.18s cubic-bezier(0.4, 0, 0.2, 1),
    transform 0.18s cubic-bezier(0.4, 0, 0.2, 1);
  outline: none;
}

/* hover：图标变深灰 */
.activity-btn:hover {
  color: var(--text-secondary);
  background: var(--bg-hover);
}

/* 键盘聚焦：可见焦点环 */
.activity-btn:focus-visible {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 55%, transparent);
}

/* ── 选中态：品牌色图标 + 淡色背景填充 ─────────────────────────── */
.activity-btn.active {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
}

/* 左侧高亮指示条（VS Code 风格） */
.activity-btn.active::before {
  content: '';
  position: absolute;
  left: -6px;
  top: 50%;
  width: 3px;
  height: 24px;
  background: var(--color-primary);
  border-radius: 0 2px 2px 0;
  transform: translateY(-50%) scaleY(1);
  box-shadow: 0 0 8px 0 color-mix(in srgb, var(--color-primary) 55%, transparent);
  /* 从 0 高度展开，避免初次渲染跳动 */
  animation: actbar-indicator-in 0.22s cubic-bezier(0.4, 0, 0.2, 1);
  transform-origin: center;
}

/* active 态的图标轻微缩放，增强反馈 */
.activity-btn.active svg {
  transform: scale(1.06);
  transition: transform 0.18s cubic-bezier(0.4, 0, 0.2, 1);
}

.activity-btn svg {
  transition: transform 0.18s cubic-bezier(0.4, 0, 0.2, 1);
}

/* 按下反馈 */
.activity-btn:active:not(.active) {
  transform: scale(0.94);
}

/* ── 预留样式：暂未启用的 Tab ─────────────────────────────────── */
.activity-btn--soon {
  opacity: 0.35;
  cursor: not-allowed;
}

.activity-btn--soon:hover {
  background: transparent;
  color: var(--text-tertiary);
}

/* ── Workbench 任务运行指示器 ─────────────────────────────────── */
.wb-running-dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-primary);
  box-shadow: 0 0 0 2px var(--bg-container);
  animation: wb-dot-pulse 1.5s ease-in-out infinite;
  pointer-events: none;
}

@keyframes wb-dot-pulse {
  0%, 100% { transform: scale(1);   opacity: 1; }
  50%      { transform: scale(1.3); opacity: 0.55; }
}

/* 左侧指示条进入动画 */
@keyframes actbar-indicator-in {
  from {
    transform: translateY(-50%) scaleY(0.2);
    opacity: 0;
  }
  to {
    transform: translateY(-50%) scaleY(1);
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .wb-running-dot,
  .activity-btn.active::before {
    animation: none;
  }
  .activity-btn,
  .activity-btn svg,
  .activity-btn.active svg {
    transition: none;
  }
}
</style>
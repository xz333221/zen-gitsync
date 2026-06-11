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
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <!-- 分支图：左下 main，右下 feature，右上 head 合并 -->
          <circle cx="6" cy="19" r="2.2" fill="var(--bg-container)"/>
          <circle cx="18" cy="19" r="2.2" fill="var(--bg-container)"/>
          <circle cx="18" cy="5" r="2.2" fill="var(--bg-container)"/>
          <line x1="6" y1="16.8" x2="6" y2="11"/>
          <line x1="6" y1="11" x2="18" y2="11"/>
          <line x1="18" y1="11" x2="18" y2="7.2"/>
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
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <!-- 文件折角：轮廓 + 折页 -->
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/>
          <polyline points="14 3 14 8 19 8"/>
          <!-- 代码标记 </> -->
          <polyline points="9.5 12 7 14.5 9.5 17"/>
          <polyline points="14.5 12 17 14.5 14.5 17"/>
          <line x1="13.5" y1="11" x2="10.5" y2="18"/>
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
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <!-- 中心节点 + 四个外围节点 + 连线（关系图谱） -->
          <circle cx="12" cy="12" r="2.2"/>
          <circle cx="4.5" cy="4.5" r="1.7" fill="var(--bg-container)"/>
          <circle cx="19.5" cy="4.5" r="1.7" fill="var(--bg-container)"/>
          <circle cx="4.5" cy="19.5" r="1.7" fill="var(--bg-container)"/>
          <circle cx="19.5" cy="19.5" r="1.7" fill="var(--bg-container)"/>
          <line x1="6.3" y1="6.3" x2="10.1" y2="10.1"/>
          <line x1="17.7" y1="6.3" x2="13.9" y2="10.1"/>
          <line x1="6.3" y1="17.7" x2="10.1" y2="13.9"/>
          <line x1="17.7" y1="17.7" x2="13.9" y2="13.9"/>
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
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <!-- 仪表板：外框 + 左侧导航 + 右侧 2x2 卡片网格 -->
          <rect x="3" y="4" width="18" height="16" rx="2.2"/>
          <line x1="9" y1="4" x2="9" y2="20"/>
          <!-- 导航条：活动指示点 + 菜单行 -->
          <circle cx="6" cy="7.5" r="0.7" fill="currentColor" stroke="none"/>
          <line x1="4.6" y1="11.5" x2="7.4" y2="11.5"/>
          <line x1="4.6" y1="14.5" x2="7.4" y2="14.5"/>
          <line x1="4.6" y1="17.5" x2="7.4" y2="17.5"/>
          <!-- 右上卡片 -->
          <rect x="11" y="6" width="8" height="5" rx="1"/>
          <!-- 右下两个小卡片 -->
          <rect x="11" y="13" width="3.7" height="5" rx="1"/>
          <rect x="15.3" y="13" width="3.7" height="5" rx="1"/>
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
  padding: 8px 0;
  gap: 4px;
  background: var(--bg-container);
  border-right: 1px solid var(--border-color);
  border-radius: 0;
  box-shadow: var(--shadow-sm);
}

.activity-btn {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  border-radius: var(--radius-lg);
  color: var(--text-tertiary);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
  padding: 0;
  position: relative;
}

.activity-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.activity-btn.active {
  color: var(--color-primary);
  background: rgba(59, 130, 246, 0.1);
}

.activity-btn.active::before {
  content: '';
  position: absolute;
  left: -4px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 20px;
  background: var(--color-primary);
  border-radius: 0 2px 2px 0;
}

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
@media (prefers-reduced-motion: reduce) {
  .wb-running-dot { animation: none; }
}
</style>

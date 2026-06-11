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

const props = defineProps<{
  activeView: 'git' | 'editor' | 'source-map' | 'workbench'
}>()

const emit = defineEmits<{
  'update:activeView': [view: 'git' | 'editor' | 'source-map' | 'workbench']
}>()

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
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          <path d="M23.546 10.93L13.067.452a1.55 1.55 0 0 0-2.188 0L8.708 2.627l2.76 2.76a1.838 1.838 0 0 1 2.327 2.341l2.658 2.66a1.838 1.838 0 1 1-1.101 1.103l-2.48-2.48v6.511a1.84 1.84 0 1 1-1.512-.035V9.003a1.839 1.839 0 0 1-.997-2.415L7.617 3.83 .45 10.928a1.55 1.55 0 0 0 0 2.188l10.48 10.478a1.55 1.55 0 0 0 2.187 0l10.428-10.43a1.55 1.55 0 0 0 0-2.233z"/>
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
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
          <line x1="10" y1="9" x2="8" y2="9"/>
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
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/>
          <line x1="9" y1="3" x2="9" y2="18"/>
          <line x1="15" y1="6" x2="15" y2="21"/>
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
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <rect x="3" y="4" width="18" height="14" rx="2"/>
          <line x1="3" y1="9" x2="21" y2="9"/>
          <line x1="9" y1="9" x2="9" y2="18"/>
        </svg>
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
</style>

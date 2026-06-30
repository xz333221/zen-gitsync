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
import { computed } from 'vue'
import { useWorkbenchStatusStore } from '@stores/workbenchStatus'
import { useGitStore } from '@stores/gitStore'
import { useEditorTabsStore } from '@stores/editorTabs'
import { useTerminalSessionsStore } from '@stores/terminalSessions'

const props = defineProps<{
  activeView: 'git' | 'console' | 'editor' | 'source-map' | 'workbench' | 'monitor' | 'mindmap'
}>()

const emit = defineEmits<{
  'update:activeView': [view: 'git' | 'console' | 'editor' | 'source-map' | 'workbench' | 'monitor' | 'mindmap']
}>()

const wbStatus = useWorkbenchStatusStore()
const gitStore = useGitStore()
const editorTabsStore = useEditorTabsStore()
const terminalSessionsStore = useTerminalSessionsStore()

// 未提交文件数:与文件列表 badge 对齐,包含所有 git status --porcelain 的变更
// (modified / staged / added / deleted / conflicted / untracked)。
// 之前 .filter(f => f.type !== 'untracked') 会漏掉未跟踪文件,
// 导致左侧红点和文件列表 badge 数字不一致。
const uncommittedCount = computed(() => {
  return gitStore.fileList?.length ?? 0
})
const uncommittedBadge = computed(() => {
  const n = uncommittedCount.value
  return n > 99 ? '99+' : String(n)
})

// 编辑器未保存文件数：与 Git 的 uncommitted 徽标刻意区分开。
//   - editor dirty（这里）= 文件已改动但尚未落盘（编辑器内部状态）
//   - git uncommitted   = 改动已落盘但尚未提交（仓库状态）
// 数值由 EditorView 通过 editorTabs store 同步。
const editorDirtyBadge = computed(() => {
  const n = editorTabsStore.dirtyCount
  return n > 99 ? '99+' : String(n)
})

function select(view: 'git' | 'console' | 'editor' | 'source-map' | 'workbench' | 'monitor' | 'mindmap') {
  emit('update:activeView', view)
}
</script>

<template>
  <div class="activity-bar">
    <!-- Git 页面 -->
    <el-tooltip
      :content="uncommittedCount > 0 ? `${$t('@ACTBAR:Git')} · ${uncommittedCount} ${$t('@ACTBAR:个未提交文件')}` : $t('@ACTBAR:Git')"
      placement="right"
      :show-after="300"
    >
      <button
        class="activity-btn"
        :class="{ active: props.activeView === 'git' }"
        @click="select('git')"
        :aria-label="uncommittedCount > 0 ? `${$t('@ACTBAR:Git')} · ${uncommittedCount} ${$t('@ACTBAR:个未提交文件')}` : $t('@ACTBAR:Git')"
        :aria-pressed="props.activeView === 'git'"
      >
        <!-- git.svg -->
        <svg viewBox="0 0 1025 1024" width="20" height="20" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          <path d="M1004.728 466.4l-447.104-447.072c-25.728-25.76-67.488-25.76-93.28 0l-103.872 103.872 78.176 78.176c12.544-5.984 26.56-9.376 41.376-9.376 53.024 0 96 42.976 96 96 0 14.816-3.36 28.864-9.376 41.376l127.968 127.968c12.544-5.984 26.56-9.376 41.376-9.376 53.024 0 96 42.976 96 96s-42.976 96-96 96-96-42.976-96-96c0-14.816 3.36-28.864 9.376-41.376l-127.968-127.968c-3.04 1.472-6.176 2.752-9.376 3.872l0 266.976c37.28 13.184 64 48.704 64 90.528 0 53.024-42.976 96-96 96s-96-42.976-96-96c0-41.792 26.72-77.344 64-90.528l0-266.976c-37.28-13.184-64-48.704-64-90.528 0-14.816 3.36-28.864 9.376-41.376l-78.176-78.176-295.904 295.872c-25.76 25.792-25.76 67.52 0 93.28l447.136 447.072c25.728 25.76 67.488 25.76 93.28 0l444.992-444.992c25.76-25.76 25.76-67.552 0-93.28z"/>
        </svg>
        <span
          v-if="uncommittedCount > 0"
          class="git-uncommitted-badge"
          :title="`${uncommittedCount} ${$t('@ACTBAR:个未提交文件')}`"
          aria-hidden="true"
        >{{ uncommittedBadge }}</span>
      </button>
    </el-tooltip>

    <!-- 控制台页面:自定义命令 + 命令控制台(从 Git 视图拆出) -->
    <el-tooltip
      :content="terminalSessionsStore.hasActive ? `${$t('@ACTBAR:控制台')} · ${terminalSessionsStore.count} ${$t('@ACTBAR:个终端会话')}` : $t('@ACTBAR:控制台')"
      placement="right"
      :show-after="300"
    >
      <button
        class="activity-btn"
        :class="{ active: props.activeView === 'console' }"
        @click="select('console')"
        :aria-label="terminalSessionsStore.hasActive ? `${$t('@ACTBAR:控制台')} · ${terminalSessionsStore.count} ${$t('@ACTBAR:个终端会话')}` : $t('@ACTBAR:控制台')"
        :aria-pressed="props.activeView === 'console'"
      >
        <!-- terminal.svg: 终端窗口 + 光标 -->
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="M6 9l3 3-3 3" />
          <line x1="12" y1="15" x2="17" y2="15" />
        </svg>
        <span
          v-if="terminalSessionsStore.hasActive"
          class="console-sessions-badge"
          :title="$t('@ACTBAR:个终端会话')"
          aria-hidden="true"
        >{{ terminalSessionsStore.count > 99 ? '99+' : terminalSessionsStore.count }}</span>
      </button>
    </el-tooltip>

    <!-- 编辑器页面 -->
    <el-tooltip
      :content="editorTabsStore.hasDirty ? `${$t('@ACTBAR:编辑器')} · ${editorTabsStore.dirtyCount} ${$t('@ACTBAR:个未保存文件')}` : $t('@ACTBAR:编辑器')"
      placement="right"
      :show-after="300"
    >
      <button
        class="activity-btn"
        :class="{ active: props.activeView === 'editor' }"
        @click="select('editor')"
        :aria-label="editorTabsStore.hasDirty ? `${$t('@ACTBAR:编辑器')} · ${editorTabsStore.dirtyCount} ${$t('@ACTBAR:个未保存文件')}` : $t('@ACTBAR:编辑器')"
        :aria-pressed="props.activeView === 'editor'"
      >
        <!-- code-folder.svg -->
        <svg viewBox="0 0 1024 1024" width="20" height="20" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          <path d="M928 687.9c-17.8 0-32.2 14.4-32.2 32.1v80.7c0 35.3-28.7 64-64 64H192.5c-35.3 0-64-28.7-64-64V225c0-35.3 28.7-64 64-64H415l82.7 143.3c6.6 11.4 19.2 17.2 31.5 15.8h302.5c35.3 0 64 28.7 64 64v80c0 17.7 14.4 32.1 32.2 32.1s32.2-14.4 32.2-32.1c0-0.8 0-1.6-0.1-2.4v-77.5C960 329 925.1 282 876.1 264v-1c0-68.2-55.8-124-124-124H476.2l-14.8-25.7c-7.4-12.9-18-16.2-27.3-16l-0.1-0.1H192.1c-70.7 0-128 57.3-128 128v574.1c0 70.7 57.3 128 128 128h640c70.7 0 128-57.3 128-128v-76.9c0.1-0.8 0.1-1.6 0.1-2.4 0-17.7-14.4-32.1-32.2-32.1zM747.1 202.8c31.6 0 58 23.2 63.1 53.4H543.9l-30.8-53.4h234z"/>
        </svg>
        <span
          v-if="editorTabsStore.hasDirty"
          class="editor-dirty-badge"
          :title="`${editorTabsStore.dirtyCount} ${$t('@ACTBAR:个未保存文件')}`"
          aria-hidden="true"
        >{{ editorDirtyBadge }}</span>
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
        <!-- code-map.svg -->
        <svg viewBox="0 0 1024 1024" width="20" height="20" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          <path d="M961.5 700.5 889 700.5 889 512c0-24-19.5-43.5-43.5-43.5L541 468.5l0-145 72.5 0c24 0 43.5-19.5 43.5-43.5L657 77c0-24-19.5-43.5-43.5-43.5l-203 0C386.5 33.5 367 53 367 77l0 203c0 24 19.5 43.5 43.5 43.5L483 323.5l0 145L178.5 468.5c-24 0-43.5 19.5-43.5 43.5l0 188.5L62.5 700.5C38.5 700.5 19 720 19 744l0 203c0 24 19.5 43.5 43.5 43.5l203 0c24 0 43.5-19.5 43.5-43.5L309 744c0-24-19.5-43.5-43.5-43.5L193 700.5l0-174 290 0 0 174-72.5 0c-24 0-43.5 19.5-43.5 43.5l0 203c0 24 19.5 43.5 43.5 43.5l203 0c24 0 43.5-19.5 43.5-43.5L657 744c0-24-19.5-43.5-43.5-43.5L541 700.5l0-174 290 0 0 174-72.5 0c-24 0-43.5 19.5-43.5 43.5l0 203c0 24 19.5 43.5 43.5 43.5l203 0c24 0 43.5-19.5 43.5-43.5L1005 744C1005 720 985.5 700.5 961.5 700.5zM425 91.5l174 0 0 174L425 265.5 425 91.5zM251 758.5l0 174L77 932.5l0-174L251 758.5zM599 932.5 425 932.5l0-174 174 0L599 932.5zM947 932.5 773 932.5l0-174 174 0L947 932.5z"/>
        </svg>
      </button>
    </el-tooltip>

    <!-- 工作台 -->
    <el-tooltip :content="$t('@ACTBAR:工作台')" placement="right" :show-after="300">
      <button
        class="activity-btn"
        :class="{ active: props.activeView === 'workbench' }"
        @click="select('workbench')"
        :aria-label="wbStatus.runningCount > 0 ? `${$t('@ACTBAR:工作台')} · ${wbStatus.runningCount} ${$t('@ACTBAR:个任务正在执行')}` : $t('@ACTBAR:工作台')"
        :aria-pressed="props.activeView === 'workbench'"
      >
        <!-- code-task.svg -->
        <svg viewBox="0 0 1044 1024" width="20" height="20" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          <path d="M840.454 62.442H201.849c-76.445 0-139.409 63.68-139.409 141.007v614.048c0 77.326 62.963 141.007 139.408 141.007h638.605c76.454 0 139.408-63.68 139.408-141.007V203.449c0-77.326-58.454-141.007-139.408-141.007z m71.955 759.608c0 40.931-31.473 72.772-71.954 72.772H201.85c-40.473 0-71.954-31.84-71.954-72.772V203.447c0-40.931 31.481-72.772 71.954-72.772h638.605c40.481 0 71.954 31.84 71.954 72.772V822.05zM399.73 285.32l-98.936 100.065-44.973-45.477c-13.5-13.647-35.981-13.647-44.973 0-13.5 13.638-13.5 36.386 0 45.477l71.954 72.781c4.5 4.546 13.492 9.092 26.981 9.092 13.5 0 13.5-4.546 26.981-9.092L458.19 335.353c13.5-13.647 13.5-36.386 0-45.487-26.981-13.638-44.973-13.638-58.463-4.546z m413.743 54.588H503.165c-22.481 0-31.481 13.638-31.481 31.84 0 22.739 13.5 31.84 31.481 31.84h310.316c22.481 0 31.473-13.647 31.473-31.84 0-18.202-13.5-31.84-31.481-31.84zM318.775 544.584c-58.463 0-103.436 45.487-103.436 104.62 0 59.125 44.973 104.611 103.436 104.611 58.473 0 103.436-45.487 103.436-104.611 0-63.68-49.463-104.62-103.436-104.62z m0 136.459c-22.481 0-35.973-13.647-35.973-36.386 0-22.747 13.492-36.395 35.973-36.395 22.492 0 35.981 13.647 35.981 36.395 0 22.739-17.992 36.386-35.981 36.386z m494.698-68.235H503.165c-22.481 0-31.481 13.647-31.481 31.849 0 18.184 13.5 31.84 31.481 31.84h310.316c22.481 0 31.473-13.647 31.473-31.84 0-18.202-13.5-31.84-31.481-31.84z"/>
        </svg>
        <span
          v-if="wbStatus.runningCount > 0"
          class="wb-running-badge"
          :title="$t('@ACTBAR:有任务正在执行')"
          aria-hidden="true"
        >{{ wbStatus.runningCount > 99 ? '99+' : wbStatus.runningCount }}</span>
      </button>
    </el-tooltip>

    <!-- 系统监控 -->
    <el-tooltip :content="$t('@ACTBAR:系统监控')" placement="right" :show-after="300">
      <button
        class="activity-btn"
        :class="{ active: props.activeView === 'monitor' }"
        @click="select('monitor')"
        :aria-label="$t('@ACTBAR:系统监控')"
        :aria-pressed="props.activeView === 'monitor'"
      >
        <!-- activity.svg: 心跳/波形监控图标 -->
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
        </svg>
      </button>
    </el-tooltip>

    <!-- 思维导图 -->
    <el-tooltip :content="$t('@ACTBAR:思维导图')" placement="right" :show-after="300">
      <button
        class="activity-btn"
        :class="{ active: props.activeView === 'mindmap' }"
        @click="select('mindmap')"
        :aria-label="$t('@ACTBAR:思维导图')"
        :aria-pressed="props.activeView === 'mindmap'"
      >
        <!-- mindmap.svg: 中心节点 + 四向辐射的节点拓扑 -->
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="2.2" />
          <circle cx="4.5" cy="5" r="1.8" />
          <circle cx="19.5" cy="5" r="1.8" />
          <circle cx="4.5" cy="19" r="1.8" />
          <circle cx="19.5" cy="19" r="1.8" />
          <line x1="10.3" y1="10.6" x2="6" y2="6.2" />
          <line x1="13.7" y1="10.6" x2="18" y2="6.2" />
          <line x1="10.3" y1="13.4" x2="6" y2="17.8" />
          <line x1="13.7" y1="13.4" x2="18" y2="17.8" />
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
  padding: 10px 0;
  gap: 6px;
  background: var(--bg-panel);
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

/* ―― Workbench 任务执行数量徽标 ――――――――――――――――――――――――――― */
.wb-running-badge {
  position: absolute;
  top: -2px;
  right: -4px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  color: #fff;
  background: var(--color-success, #34d399);
  border-radius: 8px;
  box-shadow: 0 0 0 2px var(--bg-container);
  pointer-events: none;
  animation: wb-badge-in 0.22s cubic-bezier(0.34, 1.56, 0.64, 1), wb-badge-pulse 2s ease-in-out 0.3s infinite;
  z-index: 1;
}

@keyframes wb-badge-in {
  0%   { transform: scale(0.4); opacity: 0; }
  60%  { transform: scale(1.18); opacity: 1; }
  100% { transform: scale(1);    opacity: 1; }
}
@keyframes wb-badge-pulse {
  0%, 100% { box-shadow: 0 0 0 2px var(--bg-container); }
  50%      { box-shadow: 0 0 0 2px var(--bg-container), 0 0 6px 1px color-mix(in srgb, var(--color-success, #34d399) 60%, transparent); }
}

/* ── 控制台终端会话数量徽标 ─────────────────────────────────────── */
/* 几何与 wb/git/editor 徽标一致,颜色用青色(cyan)呼应终端主题,
   与工作台绿色(running)、Git 品牌色(uncommitted)、编辑器橙色(dirty)区分。 */
.console-sessions-badge {
  position: absolute;
  top: -2px;
  right: -4px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  color: #fff;
  background: var(--color-info, #06b6d4);
  border-radius: 8px;
  box-shadow: 0 0 0 2px var(--bg-container);
  pointer-events: none;
  animation: wb-badge-in 0.22s cubic-bezier(0.34, 1.56, 0.64, 1), console-badge-pulse 2s ease-in-out 0.3s infinite;
  z-index: 1;
}

@keyframes console-badge-pulse {
  0%, 100% { box-shadow: 0 0 0 2px var(--bg-container); }
  50%      { box-shadow: 0 0 0 2px var(--bg-container), 0 0 6px 1px color-mix(in srgb, var(--color-info, #06b6d4) 60%, transparent); }
}

/* ── Git 未提交文件数量徽标 ─────────────────────────────────────── */
.git-uncommitted-badge {
  position: absolute;
  top: -2px;
  right: -4px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  color: #fff;
  background: var(--color-primary);
  border-radius: 8px;
  box-shadow: 0 0 0 2px var(--bg-container);
  pointer-events: none;
  /* 数字变化时的入场动画 */
  animation: git-badge-pop-in 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
  z-index: 1;
}

@keyframes git-badge-pop-in {
  0%   { transform: scale(0.4); opacity: 0; }
  60%  { transform: scale(1.18); opacity: 1; }
  100% { transform: scale(1);    opacity: 1; }
}

/* ── 编辑器未保存文件数量徽标 ─────────────────────────────────────── */
/* 几何与 Git 徽标一致，颜色用 warning 橙色以呼应编辑器 tab 上的 dirty dot，
   与 Git 的品牌色"未提交"徽标形成视觉区分。 */
.editor-dirty-badge {
  position: absolute;
  top: -2px;
  right: -4px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  color: #fff;
  background: var(--color-warning);
  border-radius: 8px;
  box-shadow: 0 0 0 2px var(--bg-container);
  pointer-events: none;
  animation: git-badge-pop-in 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
  z-index: 1;
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
  .wb-running-badge,
  .git-uncommitted-badge,
  .editor-dirty-badge,
  .console-sessions-badge,
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

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
  activeView: 'git' | 'console' | 'editor' | 'source-map' | 'workbench' | 'projects' | 'monitor' | 'mindmap'
}>()

const emit = defineEmits<{
  'update:activeView': [view: 'git' | 'console' | 'editor' | 'source-map' | 'workbench' | 'projects' | 'monitor' | 'mindmap']
}>()

const wbStatus = useWorkbenchStatusStore()
const gitStore = useGitStore()
const editorTabsStore = useEditorTabsStore()
const terminalSessionsStore = useTerminalSessionsStore()

// 源码地图 tab 开关：暂时隐藏入口（反馈当前实用价值不大）。
// 改回 true 即可恢复，SourceMapView 组件与 App.vue 的懒加载分支保持原样未动。
const SHOW_SOURCE_MAP = false

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

// 与远程分支的领先 / 落后提交数:同一颗 Git 图标上再挂一个「底部」徽标。
// 为什么要有:右上角那个未提交徽标只能表达"本地有东西没提交",而
// "你的分支落后 'origin/master' 1 个提交"此前只写在左侧面板里那行蓝条上 ——
// 切到别的视图、或面板滚出视口之后完全无感,偏偏它是最需要立刻 pull 的状态。
const syncAhead = computed(() => (gitStore.isGitRepo ? gitStore.branchAhead : 0))
const syncBehind = computed(() => (gitStore.isGitRepo ? gitStore.branchBehind : 0))
const hasSyncBadge = computed(() => syncAhead.value > 0 || syncBehind.value > 0)

// ↑2 ↓1 形态:箭头表方向、数字表个数,一眼能分清"要 push"还是"要 pull"。
// 数字同样封顶 99+(三位数会把 36px 的按钮撑爆)。
function capBadge(n: number) {
  return n > 99 ? '99+' : String(n)
}
const syncBadgeText = computed(() => {
  const parts: string[] = []
  if (syncAhead.value > 0) parts.push(`↑${capBadge(syncAhead.value)}`)
  if (syncBehind.value > 0) parts.push(`↓${capBadge(syncBehind.value)}`)
  return parts.join(' ')
})

// 颜色按「该做什么」分档,而不是按方向(方向已经由箭头表达):
//   behind   → warning:远端有新提交待拉取,最需要立刻处理
//   ahead    → success:本地提交待推送,属于正常待办
//   diverged → danger:两边都有,得先解决分叉
const syncBadgeClass = computed(() => {
  if (syncAhead.value > 0 && syncBehind.value > 0) return 'git-sync-badge--diverged'
  if (syncBehind.value > 0) return 'git-sync-badge--behind'
  return 'git-sync-badge--ahead'
})

// 领先 / 落后的文字描述(徽标 title + 按钮 aria-label 复用同一份)
const gitSyncSummary = computed(() => {
  const parts: string[] = []
  if (syncAhead.value > 0) parts.push($t('@ACTBAR:领先 {count} 个提交', { count: syncAhead.value }))
  if (syncBehind.value > 0) parts.push($t('@ACTBAR:落后 {count} 个提交', { count: syncBehind.value }))
  return parts.join(' · ')
})

// Git 按钮的 tooltip / aria-label:未提交 + 领先/落后合成一句,空则退回纯名称
const gitButtonLabel = computed(() => {
  const parts: string[] = []
  if (uncommittedCount.value > 0) parts.push(`${uncommittedCount.value} ${$t('@ACTBAR:个未提交文件')}`)
  if (gitSyncSummary.value) parts.push(gitSyncSummary.value)
  return parts.length ? `${$t('@ACTBAR:Git')} · ${parts.join(' · ')}` : $t('@ACTBAR:Git')
})

// 编辑器未保存文件数：与 Git 的 uncommitted 徽标刻意区分开。
//   - editor dirty（这里）= 文件已改动但尚未落盘（编辑器内部状态）
//   - git uncommitted   = 改动已落盘但尚未提交（仓库状态）
// 数值由 EditorView 通过 editorTabs store 同步。
const editorDirtyBadge = computed(() => {
  const n = editorTabsStore.dirtyCount
  return n > 99 ? '99+' : String(n)
})

function select(view: 'git' | 'console' | 'editor' | 'source-map' | 'workbench' | 'projects' | 'monitor' | 'mindmap') {
  emit('update:activeView', view)
}
</script>

<template>
  <div class="activity-bar">
    <!-- Git 页面 -->
    <el-tooltip
      :content="gitButtonLabel"
      placement="right"
      :show-after="300"
    >
      <button
        class="activity-btn"
        :class="{ active: props.activeView === 'git' }"
        @click="select('git')"
        :aria-label="gitButtonLabel"
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
        <!-- 与远程分支的领先 / 落后:落在按钮右下角,与右上的未提交徽标错开 -->
        <span
          v-if="hasSyncBadge"
          class="git-sync-badge"
          :class="syncBadgeClass"
          :title="gitSyncSummary"
          aria-hidden="true"
        >{{ syncBadgeText }}</span>
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
        <!-- terminal-2.svg（Tabler icons，MIT）：终端窗口 + 光标 -->
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <path d="M8 9l3 3l-3 3" />
          <path d="M13 15l3 0" />
          <path d="M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-14a2 2 0 0 1-2-2l0-12" />
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
        <!-- folder-code.svg（Tabler icons，MIT）：文件夹 + 代码角标 -->
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <path d="M11 19h-6a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v4" />
          <path d="M20 21l2-2l-2-2" />
          <path d="M17 17l-2 2l2 2" />
        </svg>
        <span
          v-if="editorTabsStore.hasDirty"
          class="editor-dirty-badge"
          :title="`${editorTabsStore.dirtyCount} ${$t('@ACTBAR:个未保存文件')}`"
          aria-hidden="true"
        >{{ editorDirtyBadge }}</span>
      </button>
    </el-tooltip>

    <!-- 源码地图（SHOW_SOURCE_MAP = false 时隐藏入口） -->
    <el-tooltip v-if="SHOW_SOURCE_MAP" :content="$t('@ACTBAR:源码地图')" placement="right" :show-after="300">
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
        <!-- clipboard-check.svg（Tabler icons，MIT）：工作台 = 任务清单剪贴板 -->
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <path d="M9 5h-2a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-12a2 2 0 0 0-2-2h-2" />
          <path d="M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2" />
          <path d="M9 14l2 2l4-4" />
        </svg>
        <!-- 活跃执行数：与看板表头同源（useOrchestrator 投喂，口径 = running | pending，
             含别的 g ui 实例正在跑的 job）。别改回"本地 jobs 里数 running"——见 stores/workbenchStatus.ts -->
        <span
          v-if="wbStatus.runningCount > 0"
          class="wb-running-badge"
          :title="$t('@ACTBAR:有任务正在执行')"
          aria-hidden="true"
        >{{ wbStatus.runningCount > 99 ? '99+' : wbStatus.runningCount }}</span>
      </button>
    </el-tooltip>

    <!-- 项目管理：把项目清单当"资产"管理（添加 / 删除 / 看启动方式与打开方式）。
         与「工作台」分开是刻意的：工作台管任务（选中项目 = 过滤看板），
         这里管项目本身，两种语义混在一个面板里会让"点一下"的含义变得不确定。
         不加角标：48px 活动栏已经挂满了（见 lessons/activity-bar-badges）。 -->
    <el-tooltip :content="$t('@ACTBAR:项目管理')" placement="right" :show-after="300">
      <button
        class="activity-btn"
        :class="{ active: props.activeView === 'projects' }"
        @click="select('projects')"
        :aria-label="$t('@ACTBAR:项目管理')"
        :aria-pressed="props.activeView === 'projects'"
      >
        <!-- project-manage.svg: 叠层文件夹（Tabler icons 「folders」官方线稿，MIT）——
             "多个项目目录" 的意象。2026-10-16 二次换稿：前两版手绘（文件夹+裸线 / 圆点清单）
             用户反馈观感不达标，改用 Tabler 成品。选叠层而不是单文件夹：本栏编辑器图标
             已是文件夹（code-folder），单文件夹会与之撞脸；叠层 = 集合，和"单个"区分开。 -->
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <path d="M9 3h3l2 2h5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2" />
          <path d="M17 16v2a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h2" />
        </svg>
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
        <!-- activity.svg（Tabler icons，MIT）：心跳/波形监控图标 -->
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <path d="M3 12h4l3 8l4-16l3 8h4" />
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
        <!-- topology-star.svg（Tabler icons，MIT）：中心节点 + 四向辐射的节点拓扑 -->
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <path d="M8 18a2 2 0 1 0-4 0a2 2 0 0 0 4 0" />
          <path d="M20 6a2 2 0 1 0-4 0a2 2 0 0 0 4 0" />
          <path d="M8 6a2 2 0 1 0-4 0a2 2 0 0 0 4 0" />
          <path d="M20 18a2 2 0 1 0-4 0a2 2 0 0 0 4 0" />
          <path d="M14 12a2 2 0 1 0-4 0a2 2 0 0 0 4 0" />
          <path d="M7.5 7.5l3 3" />
          <path d="M7.5 16.5l3-3" />
          <path d="M13.5 13.5l3 3" />
          <path d="M16.5 7.5l-3 3" />
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
  color: var(--text-meta);
  cursor: pointer;
  padding: 0;
  position: relative;
  /* 颜色 + 背景平滑过渡 */
  transition:
    color var(--transition-base) var(--ease-standard),
    background-color var(--transition-base) var(--ease-standard),
    transform var(--transition-base) var(--ease-standard);
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

/* 左侧高亮指示条（VS Code 风格）
   不加外发光：PRODUCT.md 明确「无装饰效果 / 不加重的阴影」，
   选中态由品牌色 + 淡底已足够表达 */
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
  /* 从 0 高度展开，避免初次渲染跳动 */
  animation: actbar-indicator-in var(--transition-base) var(--ease-standard);
  transform-origin: center;
}

/* active 态的图标轻微缩放，增强反馈 */
.activity-btn.active svg {
  transform: scale(1.06);
  transition: transform var(--transition-base) var(--ease-standard);
}

.activity-btn svg {
  transition: transform var(--transition-base) var(--ease-standard);
}

/* 按下反馈 */
.activity-btn:active:not(.active) {
  transform: scale(0.94);
}

/* ―― Workbench 任务执行数量徽标 ――――――――――――――――――――――――――― */
/* ⚠️ 活动栏角标家族统一口径：白字实底角标的底色一律「令牌色兑 55% 黑」。
   原始令牌（--color-success/warning/danger/primary 等）是给色块/描边用的亮度，
   10~11px 白字压上去只有 2.0~3.7:1（2026-10-16 对比度走查实测，7 枚全中招）；
   兑 55% 黑后全部 ≥6:1，色相身份不变。改任何一档前先重算白字对比度。 */
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
  font-size: var(--font-size-xs);
  font-weight: 600;
  line-height: 1;
  color: #fff;
  background: color-mix(in srgb, var(--color-success) 55%, #000);
  border-radius: var(--radius-lg);
  box-shadow: 0 0 0 2px var(--bg-container);
  pointer-events: none;
  /* 只保留一次入场弹入。原先还挂了一条 2s 无限 pulse：
     常驻动画会一直抢注意力，且四个徽标各闪各的更吵 —— 数值本身已是状态信号。 */
  animation: wb-badge-in var(--transition-base) var(--ease-spring);
  z-index: 1;
}

@keyframes wb-badge-in {
  0%   { transform: scale(0.4); opacity: 0; }
  60%  { transform: scale(1.18); opacity: 1; }
  100% { transform: scale(1);    opacity: 1; }
}

/* ── 控制台终端会话数量徽标 ─────────────────────────────────────── */
/* 几何与 wb/git/editor 徽标一致,颜色用青色(cyan)呼应终端主题,
   与工作台绿色(running)、Git 品牌色(uncommitted)、编辑器橙色(dirty)区分。
   注:原写法 var(--color-info, var(--action-teal)) 里 --color-info 是有定义的
   (#909399 灰),fallback 永远不生效 —— 与注释里「青色呼应终端」的意图不符,
   这里直接取 --action-teal。 */
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
  font-size: var(--font-size-xs);
  font-weight: 600;
  line-height: 1;
  color: #fff;
  background: color-mix(in srgb, var(--action-teal) 55%, #000);
  border-radius: var(--radius-lg);
  box-shadow: 0 0 0 2px var(--bg-container);
  pointer-events: none;
  animation: wb-badge-in var(--transition-base) var(--ease-spring);
  z-index: 1;
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
  font-size: var(--font-size-xs);
  font-weight: 600;
  line-height: 1;
  color: #fff;
  background: color-mix(in srgb, var(--color-primary) 55%, #000);
  border-radius: var(--radius-lg);
  box-shadow: 0 0 0 2px var(--bg-container);
  pointer-events: none;
  /* 数字变化时的入场动画 */
  animation: git-badge-pop-in var(--transition-base) var(--ease-spring);
  z-index: 1;
}

@keyframes git-badge-pop-in {
  0%   { transform: scale(0.4); opacity: 0; }
  60%  { transform: scale(1.18); opacity: 1; }
  100% { transform: scale(1);    opacity: 1; }
}

/* ―― Git 领先 / 落后远程分支徽标 ―――――――――――――――――――――――――――――――――
   锚点在按钮「右下角」(未提交徽标在右上角),一个贴顶一个贴底,互不遮挡。
   尺寸沿用同一套,唯独 bottom 压到 -5px:图标只有 20px 高,若按 -2px 贴,
   上下两枚徽标会把图标夹得只剩中间 8px 可见 —— 图标是主 affordance,不能被角标吃光。
   压到 -5px 后与图标只重叠 3px,余下 5px 落在活动栏 6px 的按钮间隙里。 */
.git-sync-badge {
  position: absolute;
  bottom: -5px;
  right: -4px;
  min-width: 16px;
  height: 16px;
  padding: 0 3px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 字号比其余徽标低一档(--font-size-xs 是 11px):这一枚要并排塞下
     「↑N ↓M」两个数,11px 时两位数形态实测 51px,比 48px 的活动栏还宽。
     10px 下(探针实测)单数 ↑2 ↓3 = 33px、两位数 ↑12 ↓34 = 45px,都留得住余量。
     代价是「两边都 ≥ 100」的极端情况下(↑99+ ↓99+ 约 55px)会略微溢出活动栏 ——
     正常仓库不会同时领先又落后三位数,真到那一步左侧面板里的蓝条仍给完整信息。 */
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: #fff;
  border-radius: var(--radius-lg);
  box-shadow: 0 0 0 2px var(--bg-container);
  pointer-events: none;
  animation: git-badge-pop-in var(--transition-base) var(--ease-spring);
  z-index: 1;
}

/* 落后:远端有新提交待拉取 —— 最需要注意的一档 */
.git-sync-badge--behind {
  background: color-mix(in srgb, var(--color-warning) 55%, #000);
}

/* 只领先:本地提交待推送 —— 正常待办,用 success 而不是 warning 免得跟"落后"同色 */
.git-sync-badge--ahead {
  background: color-mix(in srgb, var(--color-success) 55%, #000);
}

/* 两边都有(分叉):得先解决,用 danger */
.git-sync-badge--diverged {
  background: color-mix(in srgb, var(--color-danger) 55%, #000);
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
  font-size: var(--font-size-xs);
  font-weight: 600;
  line-height: 1;
  color: #fff;
  background: color-mix(in srgb, var(--color-warning) 55%, #000);
  border-radius: var(--radius-lg);
  box-shadow: 0 0 0 2px var(--bg-container);
  pointer-events: none;
  animation: git-badge-pop-in var(--transition-base) var(--ease-spring);
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
  .git-sync-badge,
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

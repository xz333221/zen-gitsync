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
<!-- 控制台视图:从 Git 视图拆出的"自定义命令 + 命令控制台"两块。
     左右布局:
     - 左:CustomCommandsPanel 自定义命令快捷面板(手风琴竖向列表,固定宽度,
       折叠后只留 header 竖条,不占横向空间)
     - 右:CommandConsole 命令控制台(终端执行 / 自定义指令管理),占主要空间
     两者通过 window 事件 'zen-gitsync:terminal-session-created' 联动:
     CustomCommandsPanel 跑命令后派发,CommandConsole 监听后刷新终端会话列表。
     放同一视图让联动更紧凑,也把 Git 视图瘦身回 2 列。-->
<script setup lang="ts">
import CustomCommandsPanel from '@components/CustomCommandsPanel.vue'
import CommandConsole from '@components/CommandConsole.vue'
</script>

<template>
  <div class="console-view">
    <!-- 左侧:自定义命令快捷面板(手风琴竖向列表,折叠后只留 header 竖条) -->
    <aside class="console-view__sidebar">
      <CustomCommandsPanel />
    </aside>

    <!-- 右侧:命令控制台(终端 + 自定义指令管理),占满剩余空间 -->
    <main class="console-view__terminal">
      <CommandConsole />
    </main>
  </div>
</template>

<style scoped>
.console-view {
  display: flex;
  flex-direction: row;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--bg-console, var(--bg-container));
}

/* 左侧自定义命令面板:固定宽度,内容竖向滚动。
   CustomCommandsPanel 自身是手风琴,折叠后 header 竖条宽度天然窄,
   不折叠时列表项也只占这一列。 */
.console-view__sidebar {
  flex: 0 0 260px;
  min-width: 180px;
  max-width: 420px;
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-color-light);
  background: var(--bg-container);
}

/* 让 CustomCommandsPanel 撑满侧栏高度,其内部手风琴列表自管滚动 */
.console-view__sidebar :deep(.custom-commands-panel) {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 命令列表区在侧栏里撑满剩余高度并可滚 */
.console-view__sidebar :deep(.custom-commands-panel .commands-list) {
  flex: 1 1 0;
  max-height: none !important;
  overflow-y: auto;
}

/* 左右布局下高度由侧栏 flex 撑满,隐藏组件自带的高度调节条(它本用于上下布局) */
.console-view__sidebar :deep(.custom-commands-panel .resize-handle) {
  display: none !important;
}

/* 右侧终端区:占满剩余宽度,内部 CommandConsole 自管滚动 */
.console-view__terminal {
  flex: 1 1 0;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  display: flex;
}
</style>


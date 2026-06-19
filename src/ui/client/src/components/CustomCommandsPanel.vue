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
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { $t } from '@/lang/static'
import IconButton from '@components/IconButton.vue'
import SvgIcon from '@components/SvgIcon/index.vue'
import CustomCommandManager from '@components/CustomCommandManager.vue'
import { useConfigStore } from '@stores/configStore'
import { replaceVariables } from '@/utils/commandParser'

// @CMDPANEL: file path: components\CustomCommandsPanel.vue

// 手风琴折叠状态（仿 VS Code 抽屉）
const collapsed = ref(false)

function toggleCollapsed() {
  collapsed.value = !collapsed.value
}

// 管理弹窗
const managerVisible = ref(false)
function openManager() {
  managerVisible.value = true
}

const configStore = useConfigStore()
const commands = computed(() => configStore.customCommands || [])
const isRunning = ref<Record<string, boolean>>({})

// 高度调节
const panelHeight = ref(240)
const isResizing = ref(false)
const startY = ref(0)
const startHeight = ref(0)
const MIN_PANEL_HEIGHT = 120
const MAX_PANEL_HEIGHT = 600
const KEY_NUDGE_PX = 16

function startResize(e: MouseEvent) {
  isResizing.value = true
  startY.value = e.clientY
  startHeight.value = panelHeight.value
  document.addEventListener('mousemove', handleResize)
  document.addEventListener('mouseup', stopResize)
  e.preventDefault()
}

function handleResize(e: MouseEvent) {
  if (!isResizing.value) return
  const deltaY = startY.value - e.clientY
  panelHeight.value = Math.max(MIN_PANEL_HEIGHT, Math.min(MAX_PANEL_HEIGHT, startHeight.value + deltaY))
}

function stopResize() {
  isResizing.value = false
  document.removeEventListener('mousemove', handleResize)
  document.removeEventListener('mouseup', stopResize)
}

// OPT-4: 键盘方向键调高度,纯键盘用户也能调整面板尺寸
function onResizeKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    panelHeight.value = Math.min(MAX_PANEL_HEIGHT, panelHeight.value + KEY_NUDGE_PX)
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    panelHeight.value = Math.max(MIN_PANEL_HEIGHT, panelHeight.value - KEY_NUDGE_PX)
  } else if (event.key === 'Home') {
    event.preventDefault()
    panelHeight.value = MAX_PANEL_HEIGHT
  } else if (event.key === 'End') {
    event.preventDefault()
    panelHeight.value = MIN_PANEL_HEIGHT
  }
}

// 执行命令
async function runCommand(cmd: any) {
  const id = String(cmd.id || cmd.name)
  if (isRunning.value[id]) return

  const targetDir = cmd.directory || configStore.currentDirectory || ''
  // 将所有参数替换为默认值（无默认值的留空）
  const paramsMap: Record<string, string> = {}
  if (Array.isArray(cmd.params)) {
    for (const p of cmd.params) {
      paramsMap[p.name] = p.defaultValue || ''
    }
  }
  const commandText = replaceVariables(cmd.command, paramsMap)

  isRunning.value[id] = true
  try {
    const resp = await fetch('/api/exec-in-terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: commandText, workingDirectory: targetDir })
    })
    const result = await resp.json()
    if (result?.success) {
      ElMessage.success($t('@CMDPANEL:已在新终端中执行', { name: cmd.name }))
      window.dispatchEvent(new Event('zen-gitsync:terminal-session-created'))
    } else {
      ElMessage.error(result?.error || $t('@CMDPANEL:执行失败'))
    }
  } catch (e: any) {
    ElMessage.error(e?.message || $t('@CMDPANEL:执行失败'))
  } finally {
    isRunning.value[id] = false
  }
}
</script>

<template>
  <div class="custom-commands-panel">
    <div class="panel-header accordion-header" @click="toggleCollapsed">
      <div class="header-left">
        <el-icon class="accordion-chevron" :class="{ 'is-collapsed': collapsed }">
          <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
            <path fill="currentColor" d="M340.864 149.312a30.592 30.592 0 0 0 0 42.752L652.736 512 340.864 831.872a30.592 30.592 0 0 0 0 42.752 29.12 29.12 0 0 0 41.728 0L714.24 534.336a32 32 0 0 0 0-44.672L382.592 149.376a29.12 29.12 0 0 0-41.728 0z"/>
          </svg>
        </el-icon>
        <SvgIcon icon-class="command-list" class-name="cmd-panel-icon" />
        <span class="panel-title">{{ $t('@CMDPANEL:自定义命令') }}</span>
      </div>
      <div class="header-right" @click.stop>
        <IconButton
          size="small"
          :tooltip="$t('@CMDPANEL:管理命令')"
          @click="openManager"
        >
          <el-icon>
            <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
              <path fill="currentColor" d="M600.704 64a32 32 0 0 1 30.464 22.208l35.2 109.376c14.784 7.232 28.928 15.36 42.432 24.512l112.384-24.192a32 32 0 0 1 34.432 15.36L944.32 364.8a32 32 0 0 1-4.032 37.504l-77.12 85.12a357.12 357.12 0 0 1 0 49.024l77.12 85.248a32 32 0 0 1 4.032 37.504l-88.704 153.6a32 32 0 0 1-34.432 15.296L708.8 803.904c-13.44 9.088-27.648 17.28-42.368 24.512l-35.264 109.376A32 32 0 0 1 600.704 960H423.296a32 32 0 0 1-30.464-22.208L357.696 828.48a351.616 351.616 0 0 1-42.56-24.64l-112.32 24.256a32 32 0 0 1-34.432-15.36L79.68 659.2a32 32 0 0 1 4.032-37.504l77.12-85.248a357.12 357.12 0 0 1 0-48.896l-77.12-85.248A32 32 0 0 1 79.68 364.8l88.704-153.6a32 32 0 0 1 34.432-15.296L315.2 220.096c13.568-9.152 27.776-17.408 42.56-24.64l35.2-109.312A32 32 0 0 1 423.232 64H600.64zm-23.424 64H446.72l-36.352 113.088-24.512 11.968a294.113 294.113 0 0 0-34.816 20.096l-22.656 15.36-116.224-25.088-65.28 113.152 79.68 88.192-1.92 27.136a293.12 293.12 0 0 0 0 40.192l1.92 27.136-79.808 88.192 65.344 113.152 116.224-25.024 22.656 15.296a294.113 294.113 0 0 0 34.816 20.096l24.512 11.968L446.72 896h130.688l36.48-113.152 24.448-11.904a288.282 288.282 0 0 0 34.752-20.096l22.592-15.296 116.288 25.024 65.28-113.152-79.744-88.192 1.92-27.136a293.12 293.12 0 0 0 0-40.256l-1.92-27.136 79.808-88.128-65.344-113.152-116.288 24.96-22.592-15.232a287.616 287.616 0 0 0-34.752-20.096l-24.448-11.904L577.344 128zM512 320a192 192 0 1 1 0 384 192 192 0 0 1 0-384zm0 64a128 128 0 1 0 0 256 128 128 0 0 0 0-256z"/>
            </svg>
          </el-icon>
        </IconButton>
      </div>
    </div>

    <!-- 拖拽调高度（展开时显示） OPT-4: 补 role/tabindex/aria-orientation + 键盘 nudge -->
    <div
      v-show="!collapsed"
      class="resize-handle"
      role="separator"
      tabindex="0"
      aria-orientation="horizontal"
      :aria-valuenow="panelHeight"
      :aria-valuemin="MIN_PANEL_HEIGHT"
      :aria-valuemax="MAX_PANEL_HEIGHT"
      :aria-label="$t('@CMDPANEL:调整自定义命令面板高度（上下方向键）')"
      @mousedown="startResize"
      @keydown="onResizeKeydown"
    />

    <div v-if="!collapsed && commands.length === 0" class="empty-container">
      <svg class="empty-icon" viewBox="0 0 1024 1024" width="40" height="40">
        <path fill="currentColor" d="M832 384H576V128H192v768h640V384zm-26.496-64L640 154.496V320h165.504zM160 64h480l256 256v608a32 32 0 0 1-32 32H160a32 32 0 0 1-32-32V96a32 32 0 0 1 32-32z"/>
      </svg>
      <p class="empty-text">{{ $t('@CMDPANEL:暂无自定义命令') }}</p>
      <el-button size="small" text type="primary" @click="openManager">
        {{ $t('@CMDPANEL:去添加') }}
      </el-button>
    </div>

    <div v-else-if="!collapsed" class="commands-list" :style="{ maxHeight: panelHeight + 'px' }">
      <div
        v-for="cmd in commands"
        :key="cmd.id || cmd.name"
        class="command-item"
        :class="{ running: isRunning[String(cmd.id || cmd.name)] }"
        @click="runCommand(cmd)"
      >
        <div class="command-left">
          <el-icon class="play-icon" :class="{ 'is-loading': isRunning[String(cmd.id || cmd.name)] }">
            <svg v-if="!isRunning[String(cmd.id || cmd.name)]" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
              <path fill="currentColor" d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z"/>
              <path fill="currentColor" d="M719.4 499.1l-296.1-215A15.9 15.9 0 0 0 398 297v430c0 13.1 14.8 20.5 25.3 12.9l296.1-215a15.9 15.9 0 0 0 0-25.8zm-257.6 134V390.9L628.5 512 461.8 633.1z"/>
            </svg>
            <svg v-else viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
              <path fill="currentColor" d="M512 64a32 32 0 0 1 32 32v192a32 32 0 0 1-64 0V96a32 32 0 0 1 32-32zm0 640a32 32 0 0 1 32 32v192a32 32 0 1 1-64 0V736a32 32 0 0 1 32-32zm448-192a32 32 0 0 1-32 32H736a32 32 0 1 1 0-64h192a32 32 0 0 1 32 32zm-640 0a32 32 0 0 1-32 32H96a32 32 0 0 1 0-64h192a32 32 0 0 1 32 32z"/>
            </svg>
          </el-icon>
          <div class="command-info">
            <span class="command-name">{{ cmd.name }}</span>
            <span v-if="cmd.description" class="command-desc">{{ cmd.description }}</span>
            <span v-else class="command-desc command-text">{{ cmd.command }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 命令管理弹窗 -->
  <CustomCommandManager
    v-model:visible="managerVisible"
    :fullscreen="true"
    @execute-command="runCommand"
  />
</template>

<style scoped>
.custom-commands-panel {
  position: relative;
  background: var(--bg-container);
  border-radius: 0;
  overflow: hidden;
  box-shadow: var(--shadow-md);
}

.resize-handle {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 8px;
  cursor: ns-resize;
  z-index: 10;
  transition: background 0.2s ease;
  /* OPT-4: padding 提命中区,背景只画在 content-box 不影响视觉 */
  padding: 2px 0;
  background: transparent;
  background-clip: content-box;
  box-sizing: border-box;
}

.resize-handle:focus-visible {
  outline: none;
}

.resize-handle:focus-visible::before {
  background: var(--color-primary) !important;
  box-shadow: 0 0 0 2px var(--focus-ring-color);
}

.resize-handle::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 40px;
  height: 3px;
  border-radius: var(--radius-xs);
  background: transparent;
  transition: background 0.2s ease;
}

.resize-handle:hover::before {
  background: rgba(102, 126, 234, 0.4);
}

.resize-handle:active::before {
  background: rgba(102, 126, 234, 0.7);
}

.accordion-header {
  cursor: pointer;
  user-select: none;
}

.accordion-header:hover {
  background: var(--bg-input-hover) !important;
}

.accordion-chevron {
  color: var(--text-secondary);
  transition: transform 0.2s ease;
  transform: rotate(90deg);
  flex-shrink: 0;
}

.accordion-chevron.is-collapsed {
  transform: rotate(0deg);
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 5px 4px 5px var(--spacing-md);
  background: var(--bg-input);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cmd-panel-icon {
  width: 16px;
  height: 16px;
  color: var(--color-primary);
}

.panel-title {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 2px;
}

.empty-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 16px 12px;
  gap: 6px;
}

.empty-icon {
  color: var(--text-tertiary);
  opacity: 0.5;
}

.empty-text {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  margin: 0;
}

.commands-list {
  overflow-y: auto;
  overflow-x: hidden;
}

.command-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px var(--spacing-md);
  cursor: pointer;
  transition: background 0.15s ease;
  border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.04));
  user-select: none;
}

.command-item:last-child {
  border-bottom: none;
}

.command-item:hover {
  background: var(--bg-hover);
}

.command-item.running {
  opacity: 0.7;
  cursor: not-allowed;
}

.command-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.play-icon {
  flex-shrink: 0;
  font-size: 15px;
  color: var(--color-primary);
  opacity: 0.85;
  transition: opacity 0.15s;
}

.command-item:hover .play-icon {
  opacity: 1;
}

.command-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.command-name {
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.command-desc {
  font-size: 11px;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 1px;
}

.command-text {
  font-family: var(--font-mono);
  font-size: 11px;
}
</style>

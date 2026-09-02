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
import { ElMessage } from 'element-plus'
import { $t } from '@/lang/static'
import IconButton from '@components/IconButton.vue'
import SvgIcon from '@components/SvgIcon/index.vue'
import CustomCommandManager from '@components/CustomCommandManager.vue'
import { useConfigStore } from '@stores/configStore'
import { useGitStore } from '@stores/gitStore'
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
const gitStore = useGitStore()
const commands = computed(() => configStore.customCommands || [])
const isRunning = ref<Record<string, boolean>>({})

// ──────────────────────────────────────────────
// 定时提交:按设定间隔自动 git add-all + commit
// - 间隔任意(分钟/小时/天),启动时可立即提交一次
// - 提交信息:默认提交信息(configStore.defaultCommitMessage)或 AI 生成
// - setTimeout 链式调度(而非 setInterval),避免上一次还没跑完就叠下一次
// - 设置持久化到 localStorage,刷新后不用重新填
// ──────────────────────────────────────────────
const SCHEDULE_SETTINGS_KEY = 'zen-gitsync:schedule-commit-settings'

type ScheduleUnit = 'min' | 'hour' | 'day'
type MessageMode = 'default' | 'ai'
interface ScheduleLog {
  time: number
  message: string
  ok: boolean
  skipped?: boolean
  error?: string
}

const scheduleEnabled = ref(false)
const scheduleInterval = ref(30)
const scheduleUnit = ref<ScheduleUnit>('min')
const scheduleCommitNow = ref(true)
const scheduleMessageMode = ref<MessageMode>('default')
// 默认模式下的自定义提交信息:空串 = 不覆盖,按「全局默认信息 → chore 兜底」链取值
const scheduleCustomMessage = ref('')
const scheduleBusy = ref(false)
const nextCommitAt = ref(0)
const nowTick = ref(Date.now())
const scheduleLogs = ref<ScheduleLog[]>([])
// 启动时的工作目录快照:运行中若用户切换了项目目录,
// 继续自动提交会把变更提交到错误的仓库,必须拦下
const scheduleStartDir = ref('')

const UNIT_MS: Record<ScheduleUnit, number> = { min: 60_000, hour: 3_600_000, day: 86_400_000 }

const intervalMs = computed(() => {
  const v = Math.max(1, Number(scheduleInterval.value) || 1)
  return v * UNIT_MS[scheduleUnit.value]
})

// 设置持久化:启动状态不持久化(刷新后默认停止,避免用户不知情时后台一直在提交)
watch([scheduleInterval, scheduleUnit, scheduleCommitNow, scheduleMessageMode, scheduleCustomMessage], () => {
  try {
    localStorage.setItem(SCHEDULE_SETTINGS_KEY, JSON.stringify({
      interval: scheduleInterval.value,
      unit: scheduleUnit.value,
      commitNow: scheduleCommitNow.value,
      messageMode: scheduleMessageMode.value,
      customMessage: scheduleCustomMessage.value
    }))
  } catch { /* 隐私模式等场景 localStorage 不可用,忽略 */ }
}, { deep: true })

try {
  const saved = JSON.parse(localStorage.getItem(SCHEDULE_SETTINGS_KEY) || '{}')
  if (saved.interval) scheduleInterval.value = Math.max(1, Number(saved.interval) || 30)
  if (saved.unit && UNIT_MS[saved.unit as ScheduleUnit]) scheduleUnit.value = saved.unit as ScheduleUnit
  if (typeof saved.commitNow === 'boolean') scheduleCommitNow.value = saved.commitNow
  if (saved.messageMode === 'ai' || saved.messageMode === 'default') scheduleMessageMode.value = saved.messageMode
  if (typeof saved.customMessage === 'string') scheduleCustomMessage.value = saved.customMessage
} catch { /* 解析失败用默认值 */ }

// 「默认提交信息」实际会用的内容,用于输入框 placeholder 预览
const defaultMessagePreview = computed(() =>
  configStore.defaultCommitMessage || `chore: auto commit at ${fmtClock(Date.now())}`
)

let scheduleTimer: ReturnType<typeof setTimeout> | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null

function armNextTimer() {
  if (!scheduleEnabled.value) return
  // 关键:先清掉可能存在的旧定时器再排新的。
  // 否则定时运行中点「立即提交一次」会再排一条链,提交频率就不再是设定间隔了。
  if (scheduleTimer) clearTimeout(scheduleTimer)
  nextCommitAt.value = Date.now() + intervalMs.value
  scheduleTimer = setTimeout(runScheduledCommit, intervalMs.value)
}

function toggleSchedule(running: boolean | string | number) {
  if (running) {
    scheduleEnabled.value = true
    scheduleStartDir.value = configStore.currentDirectory || ''
    nowTick.value = Date.now()
    tickTimer = setInterval(() => { nowTick.value = Date.now() }, 1000)
    if (scheduleCommitNow.value) {
      runScheduledCommit()
    } else {
      armNextTimer()
    }
    ElMessage.success($t('@CMDPANEL:定时提交已启动'))
  } else {
    scheduleEnabled.value = false
    if (scheduleTimer) { clearTimeout(scheduleTimer); scheduleTimer = null }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
    nextCommitAt.value = 0
    ElMessage.info($t('@CMDPANEL:定时提交已停止'))
  }
}

onBeforeUnmount(() => {
  if (scheduleTimer) clearTimeout(scheduleTimer)
  if (tickTimer) clearInterval(tickTimer)
})

function pushLog(entry: ScheduleLog) {
  scheduleLogs.value.unshift(entry)
  // 只保留最近 20 条,防长时间运行内存膨胀
  if (scheduleLogs.value.length > 20) scheduleLogs.value.length = 20
}

function fmtClock(ts: number) {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const countdownText = computed(() => {
  if (!scheduleEnabled.value || !nextCommitAt.value) return ''
  const remain = Math.max(0, nextCommitAt.value - nowTick.value)
  const s = Math.floor(remain / 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${p(h)}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`
})

// 手动「立即提交一次」:不改调度状态,只跑一轮
async function commitOnceNow() {
  if (scheduleBusy.value) return
  await runScheduledCommit()
}

async function runScheduledCommit() {
  if (scheduleBusy.value) return
  scheduleBusy.value = true
  try {
    if (!gitStore.isGitRepo) {
      pushLog({ time: Date.now(), message: '', ok: false, error: $t('@CMDPANEL:当前目录不是Git仓库') })
      return
    }

    // 目录守卫:项目目录变了就立刻停掉定时,绝不往错误的仓库里自动提交。
    // 仅对「定时运行中」生效 —— 手动点「立即提交一次」时 scheduleEnabled 为 false,
    // scheduleStartDir 还没被赋值(空串),若不限定会永远判定为「目录已切换」而误拦。
    if (scheduleEnabled.value && (configStore.currentDirectory || '') !== scheduleStartDir.value) {
      pushLog({
        time: Date.now(), message: '', ok: false,
        error: $t('@CMDPANEL:项目目录已切换，定时提交已自动停止')
      })
      scheduleEnabled.value = false
      if (scheduleTimer) { clearTimeout(scheduleTimer); scheduleTimer = null }
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
      nextCommitAt.value = 0
      ElMessage.warning($t('@CMDPANEL:项目目录已切换，定时提交已自动停止'))
      return
    }

    // 1. 刷新工作区状态,没有变更就跳过这一轮(不报错,定时任务静默空转很正常)
    await gitStore.fetchStatusPorcelain()
    if (gitStore.fileList.length === 0) {
      pushLog({ time: Date.now(), message: $t('@CMDPANEL:无变更，跳过本次提交'), ok: true, skipped: true })
      return
    }

    // 2. 生成提交信息
    let message = ''
    if (scheduleMessageMode.value === 'ai') {
      const res = await fetch('/api/config/generate-commit-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })
      const data = await res.json()
      if (!data.success) {
        pushLog({ time: Date.now(), message: '', ok: false, error: data.error || $t('@CMDPANEL:AI 生成失败') })
        return
      }
      message = data.scope
        ? `${data.type}(${data.scope}): ${data.description}`
        : `${data.type}: ${data.description}`
    } else {
      const ts = fmtClock(Date.now())
      // 优先级:自定义信息 > 全局默认提交信息 > chore 时间戳兜底
      message = scheduleCustomMessage.value.trim()
        || configStore.defaultCommitMessage
        || `chore: auto commit at ${ts}`
    }

    // 3. 暂存全部变更(静默 fetch,不走 addAllToStage 免得每轮弹 toast)
    const addResp = await fetch('/api/add-all', { method: 'POST' })
    const addResult = await addResp.json()
    if (!addResult.success) {
      pushLog({ time: Date.now(), message, ok: false, error: addResult.error || 'git add 失败' })
      return
    }

    // 4. 提交(commitChanges 会顺带刷新状态和历史;锁定文件由后端 /api/commit 自动排除)
    const ok = await gitStore.commitChanges(message, false)
    pushLog({ time: Date.now(), message, ok })
  } catch (e: any) {
    pushLog({ time: Date.now(), message: '', ok: false, error: e?.message || String(e) })
  } finally {
    scheduleBusy.value = false
    // 链式调度:本轮跑完再排下一轮,间隔从「本轮完成时刻」起算
    if (scheduleEnabled.value) armNextTimer()
  }
}

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

    <!-- 定时提交:按间隔自动 add-all + commit,支持默认信息 / AI 生成 -->
    <div class="schedule-section" :class="{ 'is-running': scheduleEnabled }">
      <div class="schedule-header">
        <div class="schedule-header-left">
          <el-icon class="schedule-icon">
            <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
              <path fill="currentColor" d="M512 896a384 384 0 1 0 0-768 384 384 0 0 0 0 768zm0 64a448 448 0 1 1 0-896 448 448 0 0 1 0 896z"/>
              <path fill="currentColor" d="M480 256a32 32 0 0 1 32 32v224a32 32 0 0 1-14.08 26.56l-128 85.312a32 32 0 1 1-35.456-53.248L448 495.168V288a32 32 0 0 1 32-32z"/>
            </svg>
          </el-icon>
          <span class="schedule-title">{{ $t('@CMDPANEL:定时提交') }}</span>
          <span v-if="scheduleEnabled && countdownText" class="schedule-countdown">
            {{ $t('@CMDPANEL:下次提交') }} {{ countdownText }}
          </span>
        </div>
        <div class="schedule-header-right" @click.stop>
          <el-switch
            v-model="scheduleEnabled"
            :disabled="!gitStore.isGitRepo || (!scheduleEnabled && scheduleBusy)"
            :aria-label="$t('@CMDPANEL:定时提交')"
            @change="toggleSchedule"
          />
        </div>
      </div>

      <div class="schedule-body">
        <div class="schedule-row">
          <span class="schedule-label">{{ $t('@CMDPANEL:提交间隔') }}</span>
          <el-input-number
            v-model="scheduleInterval"
            :min="1"
            :max="999"
            :step="scheduleUnit === 'min' ? 5 : 1"
            size="small"
            controls-position="right"
            class="schedule-interval-input"
            :disabled="scheduleEnabled"
          />
          <el-select
            v-model="scheduleUnit"
            size="small"
            class="schedule-unit-select"
            :disabled="scheduleEnabled"
          >
            <el-option :label="$t('@CMDPANEL:分钟')" value="min" />
            <el-option :label="$t('@CMDPANEL:小时')" value="hour" />
            <el-option :label="$t('@CMDPANEL:天')" value="day" />
          </el-select>
          <el-checkbox
            v-model="scheduleCommitNow"
            size="small"
            :disabled="scheduleEnabled"
            class="schedule-commit-now"
          >
            {{ $t('@CMDPANEL:启动时立即提交一次') }}
          </el-checkbox>
        </div>

        <div class="schedule-row">
          <span class="schedule-label">{{ $t('@CMDPANEL:提交信息') }}</span>
          <el-radio-group
            v-model="scheduleMessageMode"
            size="small"
            :disabled="scheduleEnabled"
          >
            <el-radio value="default">{{ $t('@CMDPANEL:默认提交信息') }}</el-radio>
            <el-radio value="ai">
              {{ $t('@CMDPANEL:AI 生成') }}
              <el-tooltip placement="top" effect="dark" :show-after="200">
                <template #content>
                  <span>{{ $t('@CMDPANEL:使用通用设置中已配置的默认模型，按当前变更生成 Conventional Commits 信息') }}</span>
                </template>
                <el-icon class="schedule-help-icon"><svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M512 64a448 448 0 1 1 0 896 448 448 0 0 1 0-896zm0 64a384 384 0 1 0 0 768 384 384 0 0 0 0-768zm0 128a96 96 0 0 1 96 96c0 36.032-20.864 64.192-51.392 82.752-8.832 5.376-16.832 9.6-27.264 14.272l-5.312 2.368v16.832a32 32 0 0 1-63.488 5.632L448 576v-64a32 32 0 0 1 32-32c22.528 0 32.896-3.776 44.48-10.816C537.344 461.632 544 452.032 544 416a32 32 0 0 0-64 0 32 32 0 0 1-64 0 96 96 0 0 1 96-96zm0 416a40 40 0 1 1 0-80 40 40 0 0 1 0 80z"/></svg></el-icon>
              </el-tooltip>
            </el-radio>
          </el-radio-group>
          <el-button
            size="small"
            class="schedule-once-btn"
            :disabled="!gitStore.isGitRepo || scheduleBusy"
            :loading="scheduleBusy"
            @click="commitOnceNow"
          >
            {{ $t('@CMDPANEL:立即提交一次') }}
          </el-button>
        </div>

        <!-- 默认模式:展示实际会用的信息并可编辑;留空则回落到全局默认/时间戳兜底 -->
        <div v-if="scheduleMessageMode === 'default'" class="schedule-row">
          <span class="schedule-label">{{ $t('@CMDPANEL:信息内容') }}</span>
          <el-input
            v-model="scheduleCustomMessage"
            size="small"
            class="schedule-message-input"
            :placeholder="defaultMessagePreview"
            :maxlength="200"
            clearable
            :disabled="scheduleEnabled"
          />
        </div>

        <!-- 运行日志:只展示最近几条 -->
        <div v-if="scheduleLogs.length > 0" class="schedule-logs">
          <div
            v-for="(log, idx) in scheduleLogs.slice(0, 3)"
            :key="log.time + '-' + idx"
            class="schedule-log-item"
            :class="{ 'is-error': !log.ok, 'is-skipped': log.skipped }"
          >
            <span class="schedule-log-time">{{ fmtClock(log.time) }}</span>
            <span class="schedule-log-text">
              {{ log.ok ? log.message : `${$t('@CMDPANEL:提交失败')}: ${log.error}` }}
            </span>
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

/* ── 定时提交区块 ── */
.schedule-section {
  border-top: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.06));
  background: var(--bg-input);
}

.schedule-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 5px var(--spacing-md);
}

.schedule-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.schedule-icon {
  font-size: 15px;
  color: var(--color-primary);
  flex-shrink: 0;
}

.schedule-title {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.schedule-countdown {
  font-size: 11px;
  color: var(--color-success);
  font-family: var(--font-mono);
  white-space: nowrap;
}

.schedule-header-right {
  display: flex;
  align-items: center;
}

.schedule-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 2px var(--spacing-md) 8px;
}

.schedule-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.schedule-label {
  font-size: 11px;
  color: var(--text-secondary);
  flex-shrink: 0;
  min-width: 52px;
}

.schedule-interval-input {
  width: 90px;
}

.schedule-unit-select {
  width: 78px;
}

.schedule-commit-now {
  margin-left: 4px;
}

.schedule-commit-now :deep(.el-checkbox__label) {
  font-size: 11px;
  color: var(--text-secondary);
}

.schedule-once-btn {
  margin-left: auto;
}

.schedule-message-input {
  flex: 1;
  min-width: 160px;
}

.schedule-message-input :deep(.el-input__inner) {
  font-family: var(--font-mono);
  font-size: 11px;
}

.schedule-help-icon {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-left: 2px;
  vertical-align: middle;
  cursor: help;
}

.schedule-logs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 66px;
  overflow-y: auto;
  background: var(--bg-container);
  border-radius: var(--radius-xs);
  padding: 4px 6px;
}

.schedule-log-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 11px;
  line-height: 1.6;
  min-width: 0;
}

.schedule-log-time {
  font-family: var(--font-mono);
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.schedule-log-text {
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.schedule-log-item.is-error .schedule-log-text {
  color: var(--color-danger);
}

.schedule-log-item.is-skipped .schedule-log-text {
  color: var(--text-tertiary);
  font-style: italic;
}
</style>

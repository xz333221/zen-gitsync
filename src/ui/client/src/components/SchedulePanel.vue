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

<!--
  定时任务面板（智能体视图的一个 Tab）。
  - 列表：任务名 / 计划描述 / 下次执行 / 上次结果 / 开关 / 立即运行 / 编辑 / 删除
  - 新建与编辑走弹窗表单（频率预设生成 cron，也支持手写 cron）
  - 实时性：SSE（/api/schedules/events）收到 task_started / task_finished / tasks_changed
    就重新拉列表 —— 与"对话里让 g ai 建任务"这条链路共用同一个事件源
  - 执行结果都落在任务的专属会话里，卡片上的「查看会话」emit 给父级切换
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { $t } from '@/lang/static'
import { ElMessage } from 'element-plus'
import CommonDialog from '@components/CommonDialog.vue'
import { useConfigStore } from '@/stores/configStore'
import {
  fetchSchedules, createSchedule, updateSchedule, deleteSchedule, runSchedule, stopSchedule,
  subscribeScheduleEvents, describeSchedule, formatNextRun, formatDuration, classifyRunStatus, buildCron,
  type ScheduleTask, type ScheduleDraft,
} from '@/utils/scheduleApi'

const emit = defineEmits<{ (e: 'open-session', sessionId: string): void }>()

const configStore = useConfigStore()

const tasks = ref<ScheduleTask[]>([])
const loading = ref(true)
const errorMsg = ref('')
/** 每个任务的操作进行中（按钮禁用，防连点） */
const pending = ref<Record<string, boolean>>({})
let disposeEvents: (() => void) | null = null
let refreshTimer: number | null = null

async function refresh() {
  try {
    tasks.value = await fetchSchedules()
    errorMsg.value = ''
  } catch (err: any) {
    errorMsg.value = err?.message || String(err)
  } finally {
    loading.value = false
  }
}

/** SSE 可能连发数条事件，合并成一次拉取 */
function scheduleRefresh() {
  if (refreshTimer !== null) return
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null
    refresh()
  }, 150)
}

onMounted(async () => {
  await refresh()
  disposeEvents = subscribeScheduleEvents((evt) => {
    if (['tasks_changed', 'task_started', 'task_finished', 'hello'].includes(evt.type)) scheduleRefresh()
  })
})

onBeforeUnmount(() => {
  disposeEvents?.()
  if (refreshTimer !== null) window.clearTimeout(refreshTimer)
})

// ── 展示文案 ──────────────────────────────────────────────────

const summaryText = computed(() => {
  const on = tasks.value.filter(t => t.enabled).length
  const off = tasks.value.length - on
  if (!tasks.value.length) return ''
  return $t('@SCHED:{on} 个启用 · {off} 个停用', { on, off })
})

const WEEKDAY_KEYS = ['@SCHED:周日', '@SCHED:周一', '@SCHED:周二', '@SCHED:周三', '@SCHED:周四', '@SCHED:周五', '@SCHED:周六']

function descText(task: ScheduleTask): string {
  const d = describeSchedule(task.schedule)
  switch (d.kind) {
    case 'every-minute': return $t('@SCHED:每分钟')
    case 'every-n-minutes': return $t('@SCHED:每 {n} 分钟', { n: d.n })
    case 'hourly': return $t('@SCHED:每小时第 {minute} 分钟', { minute: d.minute })
    case 'daily': return $t('@SCHED:每天 {time}', { time: `${String(d.hour).padStart(2, '0')}:${String(d.minute).padStart(2, '0')}` })
    case 'weekly': return $t('@SCHED:每周 {weekday} {time}', { weekday: $t(WEEKDAY_KEYS[d.weekday]), time: `${String(d.hour).padStart(2, '0')}:${String(d.minute).padStart(2, '0')}` })
    case 'monthly': return $t('@SCHED:每月 {day} 日 {time}', { day: d.day, time: `${String(d.hour).padStart(2, '0')}:${String(d.minute).padStart(2, '0')}` })
    default: return d.raw
  }
}

function nextText(task: ScheduleTask): string {
  if (!task.enabled) return $t('@SCHED:已停用')
  if (task.running) return $t('@SCHED:运行中...')
  const info = formatNextRun(task.nextRunAt)
  switch (info.kind) {
    case 'none': return ''
    case 'today': return $t('@SCHED:下次 今天 {time}', { time: info.time })
    case 'tomorrow': return $t('@SCHED:下次 明天 {time}', { time: info.time })
    case 'weekday': return $t('@SCHED:下次 {weekday} {time}', { weekday: $t(WEEKDAY_KEYS[info.weekday]), time: info.time })
    case 'date': return $t('@SCHED:下次 {date} {time}', { date: info.date, time: info.time })
  }
}

function lastStatusText(task: ScheduleTask): string {
  const run = task.lastRun
  if (!run) return $t('@SCHED:还没执行过')
  switch (run.status) {
    case 'ok': return $t('@SCHED:成功')
    case 'error': return $t('@SCHED:失败')
    case 'timed-out': return $t('@SCHED:超时中止')
    case 'skipped-busy': return $t('@SCHED:已跳过（会话忙）')
    case 'missed': return $t('@SCHED:已错过（未运行）')
    case 'cancelled': return $t('@SCHED:已停止')
    default: return run.status
  }
}

function lastText(task: ScheduleTask): string {
  const run = task.lastRun
  if (!run) return $t('@SCHED:还没执行过')
  const duration = formatDuration(run.durationMs)
  const base = $t('@SCHED:上次 {status}', { status: lastStatusText(task) })
  return duration ? `${base} · ${duration}` : base
}

function lastClass(task: ScheduleTask): string {
  if (!task.lastRun) return 'is-muted'
  return `is-${classifyRunStatus(task.lastRun.status)}`
}

// ── 操作 ──────────────────────────────────────────────────────

async function withPending(task: ScheduleTask, fn: () => Promise<unknown>) {
  if (pending.value[task.id]) return
  pending.value = { ...pending.value, [task.id]: true }
  try {
    await fn()
    await refresh()
  } catch (err: any) {
    ElMessage.error(err?.message || String(err))
  } finally {
    const next = { ...pending.value }
    delete next[task.id]
    pending.value = next
  }
}

function toggle(task: ScheduleTask) {
  return withPending(task, () => updateSchedule(task.id, { enabled: !task.enabled }))
}

function runNow(task: ScheduleTask) {
  return withPending(task, () => runSchedule(task.id))
}

function stop(task: ScheduleTask) {
  return withPending(task, () => stopSchedule(task.id))
}

// ── 删除确认 ──────────────────────────────────────────────────

const confirmVisible = ref(false)
const confirmTarget = ref<ScheduleTask | null>(null)

function askRemove(task: ScheduleTask) {
  confirmTarget.value = task
  confirmVisible.value = true
}

async function confirmRemove() {
  const task = confirmTarget.value
  if (!task) return
  try {
    await deleteSchedule(task.id)
    confirmVisible.value = false
    await refresh()
  } catch (err: any) {
    ElMessage.error(err?.message || String(err))
  }
}

// ── 新建 / 编辑表单 ───────────────────────────────────────────

type FormFreq = 'minutes' | 'hourly' | 'daily' | 'weekly' | 'custom'

const formVisible = ref(false)
const editingId = ref('')
const formError = ref('')
const saving = ref(false)
const form = ref({
  name: '',
  freq: 'daily' as FormFreq,
  everyMinutes: 30,
  minute: 0,
  hour: 9,
  weekday: 1,
  custom: '',
  cwd: '',
  prompt: '',
  onMissed: 'run' as 'run' | 'skip',
  enabled: true,
})

const freqOptions = computed<Array<{ value: FormFreq; label: string }>>(() => [
  { value: 'minutes', label: $t('@SCHED:每 N 分钟') },
  { value: 'hourly', label: $t('@SCHED:每小时') },
  { value: 'daily', label: $t('@SCHED:每天') },
  { value: 'weekly', label: $t('@SCHED:每周') },
  { value: 'custom', label: $t('@SCHED:自定义 cron') },
])

/** 表单当前会生成什么 cron（给用户一个所见即所得的预览） */
const cronPreview = computed(() => buildCron({
  freq: form.value.freq,
  everyMinutes: form.value.everyMinutes,
  minute: form.value.minute,
  hour: form.value.hour,
  weekday: form.value.weekday,
  custom: form.value.custom,
}))

function resetForm() {
  form.value = {
    name: '',
    freq: 'daily',
    everyMinutes: 30,
    minute: 0,
    hour: 9,
    weekday: 1,
    custom: '',
    cwd: configStore.currentDirectory || '',
    prompt: '',
    onMissed: 'run',
    enabled: true,
  }
  formError.value = ''
}

function openCreate() {
  editingId.value = ''
  resetForm()
  formVisible.value = true
}

function openEdit(task: ScheduleTask) {
  editingId.value = task.id
  const d = describeSchedule(task.schedule)
  const next = {
    name: task.name,
    freq: 'custom' as FormFreq,
    everyMinutes: 30,
    minute: 0,
    hour: 9,
    weekday: 1,
    custom: task.schedule,
    cwd: task.cwd,
    prompt: task.prompt,
    onMissed: (task.onMissed === 'skip' ? 'skip' : 'run') as 'run' | 'skip',
    enabled: task.enabled,
  }
  switch (d.kind) {
    case 'every-n-minutes': next.freq = 'minutes'; next.everyMinutes = d.n; break
    case 'hourly': next.freq = 'hourly'; next.minute = d.minute; break
    case 'daily': next.freq = 'daily'; next.minute = d.minute; next.hour = d.hour; break
    case 'weekly': next.freq = 'weekly'; next.minute = d.minute; next.hour = d.hour; next.weekday = d.weekday; break
    default: next.freq = 'custom'
  }
  form.value = next
  formError.value = ''
  formVisible.value = true
}

async function submitForm() {
  const f = form.value
  if (!f.name.trim()) {
    formError.value = $t('@SCHED:任务名不能为空')
    return
  }
  if (!f.prompt.trim()) {
    formError.value = $t('@SCHED:提示词不能为空')
    return
  }
  const schedule = cronPreview.value
  if (!schedule) {
    formError.value = $t('@SCHED:cron 表达式不能为空')
    return
  }
  const draft: ScheduleDraft = {
    name: f.name.trim(),
    schedule,
    cwd: f.cwd.trim(),
    prompt: f.prompt.trim(),
    enabled: f.enabled,
    onMissed: f.onMissed,
  }
  saving.value = true
  try {
    if (editingId.value) await updateSchedule(editingId.value, draft)
    else await createSchedule(draft)
    formVisible.value = false
    await refresh()
  } catch (err: any) {
    formError.value = err?.message || String(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="schedule-panel">
    <div class="schedule-toolbar">
      <span class="schedule-summary">{{ summaryText }}</span>
      <button type="button" class="sch-btn sch-btn-primary" @click="openCreate">
        {{ $t('@SCHED:新建任务') }}
      </button>
    </div>

    <div v-if="errorMsg" class="schedule-error">{{ $t('@SCHED:操作失败：{error}', { error: errorMsg }) }}</div>

    <div v-if="loading" class="schedule-loading">{{ $t('@SCHED:加载中...') }}</div>

    <div v-else-if="!tasks.length" class="schedule-empty">
      <p class="schedule-empty-title">{{ $t('@SCHED:还没有定时任务') }}</p>
      <p class="schedule-empty-desc">
        {{ $t('@SCHED:让 g ai 在指定时间自动做事：定时拉代码、定时巡检、定时汇总。也可以在对话里直接说「每天 9 点帮我…」，让 g ai 来创建。') }}
      </p>
    </div>

    <div v-else class="schedule-list">
      <article
        v-for="task in tasks"
        :key="task.id"
        class="schedule-card"
        :class="{ 'is-disabled': !task.enabled, 'is-running': !!task.running }"
      >
        <div class="schedule-card-body">
          <div class="schedule-card-head">
            <span class="schedule-name">{{ task.name }}</span>
            <span v-if="task.running" class="schedule-running">{{ $t('@SCHED:运行中') }}</span>
            <button
              type="button"
              class="sch-switch"
              :class="{ on: task.enabled }"
              role="switch"
              :aria-checked="task.enabled"
              :aria-label="task.enabled ? $t('@SCHED:停用') : $t('@SCHED:启用')"
              @click="toggle(task)"
            >
              <span class="sch-switch-knob"></span>
            </button>
          </div>
          <div class="schedule-card-sub">
            <span class="schedule-desc">{{ descText(task) }}</span>
            <span class="schedule-sep">·</span>
            <span class="schedule-last" :class="lastClass(task)">{{ lastText(task) }}</span>
            <button
              v-if="task.sessionId"
              type="button"
              class="sch-link"
              @click="emit('open-session', task.sessionId)"
            >{{ $t('@SCHED:查看会话') }}</button>
          </div>
        </div>
        <div class="schedule-card-side">
          <div class="schedule-next" :class="{ 'is-muted': !task.enabled }">{{ nextText(task) }}</div>
          <div class="schedule-actions">
            <button
              v-if="task.running"
              type="button"
              class="sch-btn"
              :disabled="!!pending[task.id]"
              @click="stop(task)"
            >{{ $t('@SCHED:停止') }}</button>
            <button
              v-else
              type="button"
              class="sch-btn"
              :disabled="!!pending[task.id]"
              @click="runNow(task)"
            >{{ $t('@SCHED:运行') }}</button>
            <button type="button" class="sch-btn" @click="openEdit(task)">{{ $t('@SCHED:编辑') }}</button>
            <button type="button" class="sch-btn sch-btn-danger" @click="askRemove(task)">{{ $t('@SCHED:删除') }}</button>
          </div>
        </div>
      </article>
    </div>

    <!-- 新建 / 编辑 -->
    <CommonDialog
      v-model="formVisible"
      :title="editingId ? $t('@SCHED:编辑任务') : $t('@SCHED:新建任务')"
      :close-on-click-modal="false"
      :append-to-body="true"
      size="medium"
      width="560px"
      :z-index="3000000"
      custom-class="schedule-dialog"
    >
      <div class="sch-form">
        <label class="sch-field">
          <span class="sch-field-label">{{ $t('@SCHED:任务名') }}</span>
          <input v-model="form.name" class="sch-input" type="text" :placeholder="$t('@SCHED:如：每日拉代码')" />
        </label>

        <div class="sch-field">
          <span class="sch-field-label">{{ $t('@SCHED:执行计划') }}</span>
          <div class="sch-freq-row">
            <select v-model="form.freq" class="sch-input sch-select">
              <option v-for="opt in freqOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>

            <template v-if="form.freq === 'minutes'">
              <span class="sch-inline-label">{{ $t('@SCHED:每') }}</span>
              <select v-model.number="form.everyMinutes" class="sch-input sch-select sch-select-sm">
                <option v-for="n in [5, 10, 15, 20, 30, 60]" :key="n" :value="n">{{ n }}</option>
              </select>
              <span class="sch-inline-label">{{ $t('@SCHED:分钟') }}</span>
            </template>

            <template v-else-if="form.freq === 'daily' || form.freq === 'weekly'">
              <select v-if="form.freq === 'weekly'" v-model.number="form.weekday" class="sch-input sch-select sch-select-sm">
                <option v-for="(key, idx) in WEEKDAY_KEYS" :key="idx" :value="idx">{{ $t(key) }}</option>
              </select>
              <select v-model.number="form.hour" class="sch-input sch-select sch-select-sm">
                <option v-for="h in 24" :key="h - 1" :value="h - 1">{{ String(h - 1).padStart(2, '0') }}</option>
              </select>
              <span class="sch-inline-label">:</span>
              <select v-model.number="form.minute" class="sch-input sch-select sch-select-sm">
                <option v-for="m in 60" :key="m - 1" :value="m - 1">{{ String(m - 1).padStart(2, '0') }}</option>
              </select>
            </template>

            <template v-else-if="form.freq === 'hourly'">
              <span class="sch-inline-label">{{ $t('@SCHED:第') }}</span>
              <select v-model.number="form.minute" class="sch-input sch-select sch-select-sm">
                <option v-for="m in 60" :key="m - 1" :value="m - 1">{{ String(m - 1).padStart(2, '0') }}</option>
              </select>
              <span class="sch-inline-label">{{ $t('@SCHED:分钟') }}</span>
            </template>

            <input
              v-else
              v-model="form.custom"
              class="sch-input sch-input-cron"
              type="text"
              spellcheck="false"
              :placeholder="$t('@SCHED:如：0 9 * * 1-5')"
            />
          </div>
          <span class="sch-hint">{{ $t('@SCHED:cron：{cron}（分 时 日 月 周，本地时间）', { cron: cronPreview || '—' }) }}</span>
        </div>

        <label class="sch-field">
          <span class="sch-field-label">{{ $t('@SCHED:项目目录') }}</span>
          <input v-model="form.cwd" class="sch-input" type="text" spellcheck="false" :placeholder="$t('@SCHED:任务在该目录下执行（默认当前项目）')" />
        </label>

        <label class="sch-field">
          <span class="sch-field-label">{{ $t('@SCHED:提示词') }}</span>
          <textarea
            v-model="form.prompt"
            class="sch-input sch-textarea"
            rows="4"
            :placeholder="$t('@SCHED:到点后发给 g ai 的完整指令，例如：检查所有仓库远端更新，有变更就 pull；写成一次自足的请求（未来那一轮没有现在的上下文）')"
          ></textarea>
        </label>

        <div class="sch-field">
          <span class="sch-field-label">{{ $t('@SCHED:错过补偿') }}</span>
          <div class="sch-radio-row">
            <label class="sch-radio">
              <input v-model="form.onMissed" type="radio" value="run" />
              <span>{{ $t('@SCHED:补跑一次（g ui 重新运行后）') }}</span>
            </label>
            <label class="sch-radio">
              <input v-model="form.onMissed" type="radio" value="skip" />
              <span>{{ $t('@SCHED:跳过') }}</span>
            </label>
            <label class="sch-radio">
              <input v-model="form.enabled" type="checkbox" />
              <span>{{ $t('@SCHED:创建后启用') }}</span>
            </label>
          </div>
        </div>

        <p v-if="formError" class="sch-form-error">{{ formError }}</p>
      </div>

      <div class="sch-form-footer">
        <button type="button" class="sch-btn" @click="formVisible = false">{{ $t('@SCHED:取消') }}</button>
        <button type="button" class="sch-btn sch-btn-primary" :disabled="saving" @click="submitForm">
          {{ saving ? $t('@SCHED:保存中...') : $t('@SCHED:保存') }}
        </button>
      </div>
    </CommonDialog>

    <!-- 删除确认 -->
    <CommonDialog
      v-model="confirmVisible"
      :title="$t('@SCHED:删除任务')"
      :close-on-click-modal="false"
      :append-to-body="true"
      size="small"
      width="400px"
      :z-index="3000000"
      custom-class="schedule-dialog"
    >
      <p class="sch-confirm-text">
        {{ $t('@SCHED:确定删除「{name}」吗？已产生的会话会保留，但任务不再执行。', { name: confirmTarget?.name || '' }) }}
      </p>
      <div class="sch-form-footer">
        <button type="button" class="sch-btn" @click="confirmVisible = false">{{ $t('@SCHED:取消') }}</button>
        <button type="button" class="sch-btn sch-btn-danger" @click="confirmRemove">{{ $t('@SCHED:删除') }}</button>
      </div>
    </CommonDialog>
  </div>
</template>

<style scoped lang="scss">
.schedule-panel {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.schedule-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.schedule-summary {
  font-size: 12px;
  color: var(--text-secondary);
}

.schedule-error {
  font-size: 12px;
  color: var(--text-danger);
  background: color-mix(in srgb, var(--color-danger) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-danger) 25%, transparent);
  border-radius: 6px;
  padding: 8px 10px;
}

.schedule-loading,
.schedule-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 13px;
  padding: 40px 20px;
}

.schedule-empty-title {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.schedule-empty-desc {
  margin: 0;
  max-width: 440px;
  text-align: center;
  line-height: 1.7;
  font-size: 12px;
  color: var(--text-tertiary);
}

.schedule-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.schedule-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  transition: border-color 0.15s ease, background 0.15s ease;

  &:hover {
    border-color: var(--border-color-medium);
  }

  &.is-running {
    border-color: var(--tint-primary-35);
    background: var(--tint-primary-04);
  }

  &.is-disabled {
    .schedule-name {
      color: var(--text-secondary);
    }
  }
}

.schedule-card-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.schedule-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.schedule-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.schedule-running {
  font-size: 11px;
  color: var(--color-primary);
  background: var(--tint-primary-10);
  border-radius: 4px;
  padding: 1px 6px;
  white-space: nowrap;
}

.schedule-card-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
}

.schedule-desc {
  overflow: hidden;
  text-overflow: ellipsis;
}

.schedule-sep {
  color: var(--text-tertiary);
}

.schedule-last {
  overflow: hidden;
  text-overflow: ellipsis;

  &.is-ok { color: var(--text-success); }
  &.is-error { color: var(--text-danger); }
  &.is-skipped { color: var(--text-warning); }
  &.is-muted { color: var(--text-tertiary); }
}

.sch-link {
  border: none;
  background: none;
  padding: 0;
  font-size: 12px;
  color: var(--color-primary);
  cursor: pointer;

  &:hover {
    text-decoration: underline;
  }
}

.schedule-card-side {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.schedule-next {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;

  &.is-muted {
    color: var(--text-tertiary);
  }
}

.schedule-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

/* ── 开关 ─────────────────────────────────────────── */
.sch-switch {
  position: relative;
  width: 34px;
  height: 20px;
  border-radius: 10px;
  border: 1px solid var(--border-color-medium);
  background: var(--bg-subtle);
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
  transition: background 0.15s ease, border-color 0.15s ease;

  .sch-switch-knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--text-tertiary);
    transition: transform 0.15s ease, background 0.15s ease;
  }

  &.on {
    background: var(--tint-primary-18);
    border-color: var(--tint-primary-45);

    .sch-switch-knob {
      transform: translateX(14px);
      background: var(--color-primary);
    }
  }
}

/* ── 按钮 ─────────────────────────────────────────── */
.sch-btn {
  border: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;

  &:hover:not(:disabled) {
    background: var(--bg-subtle-hover);
    color: var(--text-primary);
    border-color: var(--border-color-medium);
  }

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
}

.sch-btn-primary {
  background: var(--tint-primary-10);
  border-color: var(--tint-primary-35);
  color: var(--color-primary);

  &:hover:not(:disabled) {
    background: var(--tint-primary-18);
    color: var(--color-primary);
    border-color: var(--tint-primary-45);
  }
}

.sch-btn-danger {
  color: var(--text-danger);

  &:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-danger) 8%, transparent);
    color: var(--text-danger);
    border-color: color-mix(in srgb, var(--color-danger) 30%, transparent);
  }
}

/* ── 表单 ─────────────────────────────────────────── */
.sch-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.sch-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sch-field-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.sch-input {
  width: 100%;
  box-sizing: border-box;
  font-size: 13px;
  color: var(--text-primary);
  background: var(--bg-container);
  border: 1px solid var(--border-color-medium);
  border-radius: 6px;
  padding: 6px 10px;
  outline: none;
  transition: border-color 0.15s ease;
  font-family: inherit;

  &:focus {
    border-color: var(--tint-primary-55);
  }
}

.sch-select {
  cursor: pointer;
}

.sch-select-sm {
  width: auto;
  min-width: 64px;
}

.sch-input-cron {
  font-family: var(--font-mono, monospace);
}

.sch-textarea {
  resize: vertical;
  min-height: 72px;
  line-height: 1.6;
}

.sch-freq-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.sch-inline-label {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.sch-hint {
  font-size: 11px;
  color: var(--text-tertiary);
}

.sch-radio-row {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

.sch-radio {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;

  input {
    accent-color: var(--color-primary);
    margin: 0;
    cursor: pointer;
  }
}

.sch-form-error {
  margin: 0;
  font-size: 12px;
  color: var(--text-danger);
}

.sch-form-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}

.sch-confirm-text {
  margin: 0;
  font-size: 13px;
  color: var(--text-primary);
  line-height: 1.7;
}
</style>

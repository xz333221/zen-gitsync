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
  多项目编排台 · 任务详情弹窗。

  为什么是弹窗而不是跳进编辑器：看板的用处是"扫一眼全局、就地处理"，
  点一张卡片就被甩到另一个页面（还要再点回来）会把手上的上下文全丢掉。
  详情在这里就地展开，看完点关闭就还在原来看板位置上。

  数据在**打开时按需取一次**（GET /api/workbench/tasks/:id/detail），
  不并进 5s 轮询的 /projects —— 那边只该发摘要，见 decorateTaskForBoard 的注释。
  弹窗开着时自己也按 5s 刷新一次，这样点了执行能看着它从"进行中"走到"已完成"；
  标签页隐藏时不请求。

  一处刻意的克制：output 由服务端截尾（只回末尾若干字符），
  这里**如实标注"仅显示末尾"**，不让人以为整份日志就这么长。
  想看全文有编辑器里的执行日志面板。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { $t } from '@/lang/static'
import { ArrowRight, VideoPlay } from '@element-plus/icons-vue'
import CommonDialog from '@/components/CommonDialog.vue'
import type { BoardTask, TaskColumn, TaskDetailJob, TaskDetailResponse, SubTask } from '@/types/workbench'
import { formatElapsed, relativeTimeFromIso } from '@/utils/relativeTime'

const props = defineProps<{
  modelValue: boolean
  /** 被点击的卡片：先拿它的标题/项目把框撑起来，不必等接口回来才有内容 */
  task: BoardTask | null
  projectName: string
  /** 执行中（由上层传入，避免弹窗自己再维护一份"正在执行"状态） */
  running: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [open: boolean]
  run: [task: BoardTask]
  'open-editor': [task: BoardTask]
  remove: [task: BoardTask]
}>()

const detail = ref<TaskDetailResponse | null>(null)
const loading = ref(false)
const loadError = ref('')

const COLUMN_LABEL: Record<TaskColumn, string> = {
  todo: '@WORKBENCH:待处理',
  doing: '@WORKBENCH:进行中',
  review: '@WORKBENCH:评审中',
  done: '@WORKBENCH:已完成',
}

const SUB_LABEL: Record<string, string> = {
  todo: '@WORKBENCH:待处理',
  running: '@WORKBENCH:进行中',
  done: '@WORKBENCH:已完成',
  error: '@WORKBENCH:出错',
}

const JOB_LABEL: Record<string, string> = {
  pending: '@WORKBENCH:待处理',
  running: '@WORKBENCH:执行中',
  done: '@WORKBENCH:完成',
  error: '@WORKBENCH:出错',
  cancelled: '@WORKBENCH:取消',
}

/** 标题与元信息：详情没回来之前先用卡片上的摘要显示，避免框里空一片 */
const title = computed(() => {
  const t = props.task
  if (!t) return ''
  const head = (t.title || '').trim()
  if (head) return head
  return (t.desc || '').replace(/\s+/g, ' ').trim() || $t('@WORKBENCH:未命名任务')
})

const column = computed<TaskColumn>(() => detail.value?.column || props.task?.column || 'todo')
const taskType = computed(() => detail.value?.task?.type || props.task?.type || 'complex')
const subtasks = computed<SubTask[]>(() => detail.value?.task?.subtasks || [])
const attachments = computed(() => detail.value?.task?.attachments || [])
const lastJob = computed<TaskDetailJob | null>(() => detail.value?.lastJob || null)
const desc = computed(() => (detail.value?.task?.desc || props.task?.desc || '').trim())

const subDone = computed(() => subtasks.value.filter(s => s.status === 'done').length)

async function load(silent = false) {
  const id = props.task?.id
  if (!id) return
  if (!silent) loading.value = true
  try {
    const res = await fetch(`/api/workbench/tasks/${encodeURIComponent(id)}/detail`, { cache: 'no-store' })
      .then(r => r.json())
    if (!res?.success) {
      // 静默轮询失败不清空已显示的内容，免得内容闪一下没了
      if (!silent) loadError.value = res?.error || $t('@WORKBENCH:读取任务详情失败')
      return
    }
    detail.value = res
    loadError.value = ''
  } catch (err: any) {
    if (!silent) loadError.value = err?.message || $t('@WORKBENCH:读取任务详情失败')
  } finally {
    if (!silent) loading.value = false
  }
}

// ── 打开/换任务时立刻取一次；关闭时清干净，避免下次开别的任务先闪旧内容 ──
let pollTimer: ReturnType<typeof setInterval> | null = null

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

function startPoll() {
  stopPoll()
  pollTimer = setInterval(() => {
    if (document.hidden) return
    if (!props.modelValue) return
    load(true)
  }, 5000)
}

watch(
  () => [props.modelValue, props.task?.id],
  ([open]) => {
    if (open && props.task?.id) {
      detail.value = null
      loadError.value = ''
      load(false)
      startPoll()
    } else {
      stopPoll()
      detail.value = null
    }
  },
  { immediate: true }
)

onBeforeUnmount(stopPoll)

function jobDuration(j: TaskDetailJob): string {
  return formatElapsed(j.startedAt, j.endedAt)
}

function jobTime(j: TaskDetailJob): string {
  return relativeTimeFromIso(j.endedAt || j.startedAt)
}

function attachmentSize(bytes?: number): string {
  if (typeof bytes !== 'number' || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <CommonDialog
    :model-value="modelValue"
    :title="title"
    type="flex"
    width="min(760px, 94vw)"
    height-offset="140px"
    top="6vh"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="td">
      <!-- 元信息条：贴着一条底线，不做卡片 -->
      <div class="td__meta">
        <span class="td__meta-item">
          <span class="td__meta-label">{{ $t('@WORKBENCH:项目') }}</span>
          <span class="td__meta-value" :title="task?.projectPath">{{ projectName || '—' }}</span>
        </span>
        <span class="td__meta-item">
          <span class="td__meta-label">{{ $t('@WORKBENCH:状态') }}</span>
          <span class="td__status" :class="'is-' + column">{{ $t(COLUMN_LABEL[column]) }}</span>
        </span>
        <span class="td__meta-item">
          <span class="td__meta-label">{{ $t('@WORKBENCH:类型') }}</span>
          <span class="td__meta-value">
            {{ taskType === 'simple' ? $t('@WORKBENCH:简单') : $t('@WORKBENCH:复杂') }}
          </span>
        </span>
        <span v-if="subtasks.length > 0" class="td__meta-item">
          <span class="td__meta-label">{{ $t('@WORKBENCH:子任务') }}</span>
          <span class="td__meta-value">{{ subDone }}/{{ subtasks.length }}</span>
        </span>
        <span class="td__meta-item">
          <span class="td__meta-label">{{ $t('@WORKBENCH:创建于') }}</span>
          <span class="td__meta-value">{{ relativeTimeFromIso(task?.createdAt) || '—' }}</span>
        </span>
        <span class="td__meta-item">
          <span class="td__meta-label">{{ $t('@WORKBENCH:更新于') }}</span>
          <span class="td__meta-value">{{ relativeTimeFromIso(task?.updatedAt) || '—' }}</span>
        </span>
      </div>

      <p v-if="loadError" class="td__error-bar">{{ loadError }}</p>

      <!-- 任务描述 -->
      <section class="td__sec">
        <h4 class="td__sec-title">{{ $t('@WORKBENCH:任务描述') }}</h4>
        <p v-if="desc" class="td__desc">{{ desc }}</p>
        <p v-else class="td__muted">{{ loading ? $t('@WORKBENCH:加载中…') : $t('@WORKBENCH:暂无描述') }}</p>
      </section>

      <!-- 子任务（复杂任务才有） -->
      <section v-if="subtasks.length > 0" class="td__sec">
        <h4 class="td__sec-title">{{ $t('@WORKBENCH:子任务') }}</h4>
        <ul class="td__subs">
          <li v-for="(s, i) in subtasks" :key="s.id" class="td-sub" :class="'is-' + s.status">
            <span class="td-sub__idx">{{ i + 1 }}</span>
            <div class="td-sub__body">
              <p class="td-sub__title">{{ s.title || $t('@WORKBENCH:未命名任务') }}</p>
              <p v-if="s.desc" class="td-sub__desc">{{ s.desc }}</p>
              <p v-if="s.error" class="td-sub__error" :title="s.error">{{ s.error }}</p>
            </div>
            <span class="td-sub__status">{{ $t(SUB_LABEL[s.status] || '@WORKBENCH:待处理') }}</span>
          </li>
        </ul>
      </section>

      <!-- 附件：只列名字与大小，下载走编辑器 -->
      <section v-if="attachments.length > 0" class="td__sec">
        <h4 class="td__sec-title">{{ $t('@WORKBENCH:附件') }}</h4>
        <ul class="td__atts">
          <li v-for="a in attachments" :key="a.id" class="td-att">
            <span class="td-att__name" :title="a.originalName">{{ a.originalName }}</span>
            <span class="td-att__size">{{ attachmentSize(a.size) }}</span>
          </li>
        </ul>
      </section>

      <!-- 最近一次执行 -->
      <section class="td__sec">
        <h4 class="td__sec-title">
          {{ $t('@WORKBENCH:最近执行') }}
          <span v-if="detail && detail.jobCount > 1" class="td__sec-note">
            {{ $t('@WORKBENCH:共 {n} 次执行', { n: detail.jobCount }) }}
          </span>
        </h4>

        <template v-if="lastJob">
          <div class="td__run">
            <span class="td__job-status" :class="'is-' + lastJob.status">
              {{ $t(JOB_LABEL[lastJob.status] || '@WORKBENCH:执行中') }}
            </span>
            <span v-if="lastJob.exitCode !== null" class="td__run-meta">
              {{ $t('@WORKBENCH:退出码 {code}', { code: lastJob.exitCode }) }}
            </span>
            <span v-if="jobDuration(lastJob)" class="td__run-meta">{{ jobDuration(lastJob) }}</span>
            <span class="td__run-meta td__run-meta--right">{{ jobTime(lastJob) }}</span>
          </div>

          <p v-if="lastJob.error" class="td__job-error">{{ lastJob.error }}</p>

          <template v-if="lastJob.hasOutput">
            <pre class="td__out">{{ lastJob.outputTail }}</pre>
            <p v-if="lastJob.outputTruncated" class="td__trunc">
              {{ $t('@WORKBENCH:仅显示末尾 {n} 字符', { n: lastJob.outputTail.length }) }}
            </p>
          </template>
          <p v-else class="td__muted">{{ $t('@WORKBENCH:本次执行没有输出') }}</p>
        </template>

        <p v-else-if="loading" class="td__muted">{{ $t('@WORKBENCH:加载中…') }}</p>
        <p v-else class="td__muted">{{ $t('@WORKBENCH:暂无执行记录') }}</p>
      </section>
    </div>

    <template #footer>
      <div class="td__foot">
        <button v-if="task" type="button" class="td__btn td__btn--danger" @click="emit('remove', task)">
          {{ $t('@WORKBENCH:删除') }}
        </button>
        <span class="td__foot-spacer" />
        <button type="button" class="td__btn" @click="emit('update:modelValue', false)">
          {{ $t('@WORKBENCH:关闭') }}
        </button>
        <button v-if="task" type="button" class="td__btn" @click="emit('open-editor', task)">
          <el-icon class="td__btn-icon"><ArrowRight /></el-icon>
          <span>{{ $t('@WORKBENCH:打开编辑器') }}</span>
        </button>
        <button
          v-if="task"
          type="button"
          class="td__btn td__btn--primary"
          :disabled="running || (task.type !== 'simple' && task.subtaskCount === 0)"
          :title="task.type !== 'simple' && task.subtaskCount === 0 ? $t('@WORKBENCH:复杂任务要先拆出子任务，打开编辑器添加后再执行') : ''"
          @click="emit('run', task)"
        >
          <el-icon class="td__btn-icon"><VideoPlay /></el-icon>
          <span>{{ running ? $t('@WORKBENCH:执行中') : $t('@WORKBENCH:执行') }}</span>
        </button>
      </div>
    </template>
  </CommonDialog>
</template>

<style scoped>
.td {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  /* Element Plus 的 el-dialog__body 里 line-height 会给到 32px 一路继承，
     小字号徽标会被撑高一圈 —— 在根元素重置（这个坑踩过两次，见项目记忆） */
  line-height: 1.5;
}

/* ── 元信息条 ─────────────────────────────────────── */
.td__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border-color);
}
.td__meta-item {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  font-size: 11.5px;
  min-width: 0;
}
.td__meta-label { color: var(--text-tertiary); flex-shrink: 0; }
.td__meta-value {
  color: var(--text-secondary);
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.td__status {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 3px;
  background: var(--bg-subtle);
  color: var(--text-secondary);
}
.td__status.is-doing { color: var(--color-warning); }
.td__status.is-review { color: var(--color-primary); }
.td__status.is-done { color: var(--color-success); }

.td__error-bar {
  margin: 0;
  padding: 6px 8px;
  font-size: 11.5px;
  border-radius: var(--radius-md);
  color: var(--color-danger-light);
  background: color-mix(in srgb, var(--color-danger) 10%, transparent);
}

/* ── 小节 ─────────────────────────────────────────── */
.td__sec { display: flex; flex-direction: column; gap: 6px; }
.td__sec-title {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-tertiary);
}
.td__sec-note { font-size: 10.5px; color: var(--text-tertiary); font-weight: 400; }
.td__muted { margin: 0; font-size: 12px; color: var(--text-tertiary); }

/* 描述：原样保留换行（任务描述常是用户贴进来的多行文本，压成一行反而难读） */
.td__desc {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 220px;
  overflow-y: auto;
}

/* ── 子任务 ───────────────────────────────────────── */
.td__subs { list-style: none; margin: 0; padding: 0; }
.td-sub {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 1px solid var(--border-color);
}
.td-sub:last-child { border-bottom: none; }
.td-sub__idx {
  flex-shrink: 0;
  width: 18px;
  text-align: right;
  font-size: 11px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  padding-top: 1px;
}
.td-sub__body { flex: 1; min-width: 0; }
.td-sub__title {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-primary);
  word-break: break-word;
}
.td-sub__desc {
  margin: 2px 0 0;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-tertiary);
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.td-sub__error {
  margin: 3px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--color-danger-light);
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.td-sub__status {
  flex-shrink: 0;
  font-size: 10.5px;
  color: var(--text-tertiary);
  padding-top: 1px;
}
.td-sub.is-done .td-sub__status { color: var(--color-success); }
.td-sub.is-running .td-sub__status { color: var(--color-warning); }
.td-sub.is-error .td-sub__status { color: var(--color-danger-light); }

/* ── 附件 ─────────────────────────────────────────── */
.td__atts { list-style: none; margin: 0; padding: 0; }
.td-att {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 11.5px;
}
.td-att__name {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.td-att__size {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

/* ── 最近执行 ─────────────────────────────────────── */
.td__run {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11.5px;
}
.td__job-status {
  font-size: 11px;
  padding: 0 6px;
  line-height: 16px;
  border-radius: 3px;
  background: var(--bg-subtle);
  color: var(--text-secondary);
}
.td__job-status.is-running { color: var(--color-warning); }
.td__job-status.is-done { color: var(--color-success); }
.td__job-status.is-error { color: var(--color-danger-light); }
.td__run-meta { color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
.td__run-meta--right { margin-left: auto; }
.td__job-error {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--color-danger-light);
  word-break: break-word;
}
.td__out {
  margin: 0;
  padding: 8px 10px;
  max-height: 260px;
  overflow: auto;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  line-height: 1.55;
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border-radius: var(--radius-md);
  white-space: pre-wrap;
  word-break: break-word;
}
.td__trunc { margin: 0; font-size: 10.5px; color: var(--text-tertiary); }

/* ── 底部动作 ─────────────────────────────────────── */
.td__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.td__foot-spacer { flex: 1; }
.td__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 28px;
  padding: 0 12px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-custom), background var(--transition-fast) var(--ease-custom);
}
.td__btn:hover:not(:disabled) { color: var(--color-primary); background: var(--bg-container-hover); }
.td__btn:disabled { opacity: 0.45; cursor: default; }
.td__btn:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
.td__btn--primary { background: var(--color-primary); color: #fff; }
.td__btn--primary:hover:not(:disabled) { background: var(--color-primary); color: #fff; opacity: 0.88; }
.td__btn--danger { color: var(--text-tertiary); }
.td__btn--danger:hover:not(:disabled) { color: var(--color-danger-light); background: transparent; }
.td__btn-icon { font-size: 12px; }
</style>

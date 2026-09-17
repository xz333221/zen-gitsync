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
  多项目编排台 · 右栏：主 Agent 控制台。

  这里没有"Token 速率 / 预估成本 / 实时响应"这类指标 —— 本地执行引擎
  （claude CLI + jobStore）根本没有采集 token 与费用，编三个漂亮数字出来
  只会让人在排障时被误导。取而代之的是能真算出来的量：活跃执行数、
  今日完成轮次、项目/任务总数，以及每个项目的真实 Git 状态。

  活动流的两类来源泾渭分明：
    · 执行事实（派发 / 完成 / 出错 / 取消）—— 由 job 的起止推导，不可编辑；
    · 人类干预 —— 你敲进去的指令，连同派发结果（建了任务 / 只建未执行 / 被拒绝）。
  两者混在同一条时间线上，才看得出"我说了什么 → 系统做了什么"。
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { $t } from '@/lang/static'
import { Promotion } from '@element-plus/icons-vue'
import type { OrchestratorActivity, ProjectSummary } from '@/types/workbench'
import { clockFromIso, relativeTimeFromIso } from '@/utils/relativeTime'

const props = defineProps<{
  active: boolean
  activity: OrchestratorActivity[]
  runningCount: number
  selectedProject: ProjectSummary | null
  dispatching: boolean
  togglingSchedule: boolean
  /** 今日已完成的执行轮次，由看板统一算好后传入（两处各算一遍必然对不上） */
  todayDone: number
  /** 指令会落到哪个项目：选中具体项目时是它，选中「全部项目」时是应用当前项目 */
  targetProjectName: string
}>()

const emit = defineEmits<{
  'toggle-schedule': [next: boolean]
  dispatch: [payload: { text: string; autoRun: boolean }]
}>()

const draft = ref('')
const autoRun = ref(true)

const canSend = computed(() => draft.value.trim().length > 0 && !props.dispatching)

function send() {
  if (!canSend.value) return
  emit('dispatch', { text: draft.value.trim(), autoRun: autoRun.value })
  draft.value = ''
}

/** 活动流一行的正文。文案全部走 i18n，服务端只给结构化字段 */
function describe(r: OrchestratorActivity): string {
  const task = r.taskTitle || r.subTitle || $t('@WORKBENCH:未命名任务')
  const project = r.projectName || '—'
  switch (r.kind) {
    case 'user':
      return r.text || ''
    case 'dispatch':
      return $t('@WORKBENCH:派发「{task}」至 {project}', { task, project })
    case 'done':
      return $t('@WORKBENCH:「{task}」执行完成', { task })
    case 'error':
      return $t('@WORKBENCH:「{task}」执行出错', { task })
    case 'cancelled':
      return $t('@WORKBENCH:「{task}」已取消', { task })
    default:
      return task
  }
}

const KIND_LABEL: Record<string, string> = {
  user: '@WORKBENCH:人类干预',
  dispatch: '@WORKBENCH:派发',
  done: '@WORKBENCH:完成',
  error: '@WORKBENCH:出错',
  cancelled: '@WORKBENCH:取消',
}

/** 指令的落点说明：建了任务并执行 / 只建了任务 / 被拒绝，各给一句实话 */
function instructionNote(r: OrchestratorActivity): string {
  if (r.kind !== 'user') return ''
  if (r.instructionStatus === 'accepted') return $t('@WORKBENCH:已建任务并开始执行')
  if (r.instructionStatus === 'rejected') return $t('@WORKBENCH:被拒绝：{reason}', { reason: r.reason || '' })
  return r.reason || $t('@WORKBENCH:已建任务（未执行）')
}

const gitSummary = computed(() => {
  const p = props.selectedProject
  if (!p) return []
  const out: { label: string; value: string; tone: string }[] = []
  if (p.exists === false) {
    out.push({ label: $t('@WORKBENCH:工作区'), value: $t('@WORKBENCH:目录不存在'), tone: 'danger' })
    return out
  }
  const g = p.git
  if (!g || g.isGitRepo === null) {
    out.push({ label: $t('@WORKBENCH:Git 状态'), value: $t('@WORKBENCH:未知'), tone: '' })
    return out
  }
  if (!g.isGitRepo) {
    out.push({ label: $t('@WORKBENCH:Git 状态'), value: $t('@WORKBENCH:不是 Git 仓库'), tone: '' })
    return out
  }
  out.push({
    label: $t('@WORKBENCH:分支'),
    value: g.detached ? $t('@WORKBENCH:游离 HEAD') : (g.branch || $t('@WORKBENCH:未知')),
    tone: '',
  })
  out.push({
    label: $t('@WORKBENCH:工作区'),
    value: g.changed > 0 ? $t('@WORKBENCH:未提交 {n} 项', { n: g.changed }) : $t('@WORKBENCH:干净'),
    tone: g.changed > 0 ? 'warn' : '',
  })
  if (g.hasUpstream && (g.ahead > 0 || g.behind > 0)) {
    out.push({
      label: $t('@WORKBENCH:与上游'),
      value: $t('@WORKBENCH:领先 {ahead} / 落后 {behind}', { ahead: g.ahead, behind: g.behind }),
      tone: g.behind > 0 ? 'warn' : '',
    })
  }
  return out
})
</script>

<template>
  <aside class="oc">
    <header class="oc__head">
      <span class="oc__live" :class="{ 'is-off': !active }" aria-hidden="true" />
      <h3 class="oc__title">{{ $t('@WORKBENCH:主 Agent 控制台') }}</h3>
      <button
        type="button"
        class="oc__toggle"
        :disabled="togglingSchedule"
        :title="active ? $t('@WORKBENCH:暂停后派发只建任务，不会自动执行') : $t('@WORKBENCH:恢复后派发会自动执行')"
        @click="emit('toggle-schedule', !active)"
      >{{ active ? $t('@WORKBENCH:暂停调度') : $t('@WORKBENCH:恢复调度') }}</button>
    </header>

    <div class="oc__state" :class="{ 'is-paused': !active }">
      <span class="oc__state-label">{{ $t('@WORKBENCH:调度状态') }}</span>
      <span class="oc__state-value">
        {{ active ? $t('@WORKBENCH:调度中') : $t('@WORKBENCH:已暂停') }}
      </span>
      <span class="oc__state-meta">{{ $t('@WORKBENCH:{n} 个执行中', { n: runningCount }) }}</span>
    </div>

    <div class="oc__feed">
      <p class="oc__feed-title">{{ $t('@WORKBENCH:活动日志') }}</p>
      <ul class="oc__feed-list">
        <li v-for="r in activity" :key="r.id" class="oc-row" :class="'oc-row--' + r.kind">
          <div class="oc-row__head">
            <span class="oc-row__kind">{{ $t(KIND_LABEL[r.kind] || '@WORKBENCH:派发') }}</span>
            <!-- 时间走 clockFromIso：非当天会带上日期前缀，避免跨天记录看起来像今天刚发生 -->
            <span class="oc-row__time">{{ clockFromIso(r.at) }}</span>
          </div>
          <p class="oc-row__text">{{ describe(r) }}</p>
          <p v-if="instructionNote(r)" class="oc-row__note">{{ instructionNote(r) }}</p>
          <p v-if="r.kind === 'error' && r.error" class="oc-row__error" :title="r.error">{{ r.error }}</p>
          <p v-if="r.kind === 'done' && r.projectName" class="oc-row__note">{{ r.projectName }}</p>
        </li>
        <li v-if="activity.length === 0" class="oc-empty">{{ $t('@WORKBENCH:暂无活动记录') }}</li>
      </ul>
    </div>

    <div class="oc__git">
      <p class="oc__feed-title">
        {{ $t('@WORKBENCH:项目概览') }}
        <span v-if="selectedProject" class="oc__git-name">{{ selectedProject.name }}</span>
      </p>
      <dl class="oc__git-list">
        <template v-for="row in gitSummary" :key="row.label">
          <dt class="oc__git-label">{{ row.label }}</dt>
          <dd class="oc__git-value" :class="{ 'is-warn': row.tone === 'warn', 'is-danger': row.tone === 'danger' }">
            {{ row.value }}
          </dd>
        </template>
        <dt class="oc__git-label">{{ $t('@WORKBENCH:今日完成') }}</dt>
        <dd class="oc__git-value">{{ todayDone }}</dd>
        <dt class="oc__git-label">{{ $t('@WORKBENCH:最后活跃') }}</dt>
        <dd class="oc__git-value">
          {{ selectedProject ? relativeTimeFromIso(selectedProject.stats.lastActiveAt) || '—' : '—' }}
        </dd>
      </dl>
    </div>

    <div class="oc__compose">
      <textarea
        class="oc__input"
        v-model="draft"
        rows="3"
        :placeholder="$t('@WORKBENCH:给主 Agent 下一条指令，例如：把登录模块的错误处理重构一遍')"
        @keydown.ctrl.enter.prevent="send"
        @keydown.meta.enter.prevent="send"
      />
      <div class="oc__compose-foot">
        <label class="oc__autorn" :title="$t('@WORKBENCH:取消勾选则只建任务草稿，不自动执行')">
          <input type="checkbox" v-model="autoRun" />
          <span>{{ $t('@WORKBENCH:立即执行') }}</span>
        </label>
        <button type="button" class="oc__send" :disabled="!canSend" @click="send">
          <el-icon class="oc__send-icon"><Promotion /></el-icon>
          <span>{{ dispatching ? $t('@WORKBENCH:派发中…') : $t('@WORKBENCH:派发') }}</span>
        </button>
      </div>
      <p class="oc__hint">
        <template v-if="targetProjectName">
          {{ $t('@WORKBENCH:指令会在「{name}」下新建一个任务；Ctrl+Enter 派发', { name: targetProjectName }) }}
        </template>
        <template v-else>
          {{ $t('@WORKBENCH:没有可用的项目，先在左侧选一个项目；Ctrl+Enter 派发') }}
        </template>
      </p>
    </div>
  </aside>
</template>

<style scoped>
.oc {
  display: flex;
  flex-direction: column;
  width: 300px;
  flex-shrink: 0;
  min-height: 0;
  border-left: 1px solid var(--border-color);
  background: var(--bg-panel);
}
.oc__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}
.oc__live {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--color-success);
  animation: oc-pulse 1.6s ease-in-out infinite;
}
.oc__live.is-off { background: var(--color-warning); animation: none; }
@keyframes oc-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(1.35); }
}
.oc__title {
  margin: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  flex: 1;
  min-width: 0;
}
.oc__toggle {
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-custom), background var(--transition-fast) var(--ease-custom);
}
.oc__toggle:hover:not(:disabled) { color: var(--color-warning); background: color-mix(in srgb, var(--color-warning) 10%, transparent); }
.oc__toggle:disabled { opacity: 0.5; cursor: default; }
.oc__toggle:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }

.oc__state {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-subtle);
  flex-shrink: 0;
}
.oc__state.is-paused { color: var(--color-warning); }
.oc__state-label { color: var(--text-tertiary); }
.oc__state-value { font-weight: 500; }
.oc__state-meta { margin-left: auto; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }

.oc__feed {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  padding: 8px 0 0;
}
.oc__feed-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 12px 6px;
  font-size: 11px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}
.oc__feed-list {
  list-style: none;
  margin: 0;
  padding: 0 10px 10px;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
}
.oc-row {
  padding: 6px 8px;
  margin-bottom: 4px;
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}
.oc-row--user { background: color-mix(in srgb, var(--color-primary) 9%, transparent); }
.oc-row--error { background: color-mix(in srgb, var(--color-danger) 9%, transparent); }
.oc-row--done { background: color-mix(in srgb, var(--color-success) 8%, transparent); }
.oc-row__head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
  font-size: 10px;
}
.oc-row__kind { color: var(--text-tertiary); }
.oc-row--user .oc-row__kind { color: var(--color-primary); }
.oc-row--error .oc-row__kind { color: var(--color-danger-light); }
.oc-row--done .oc-row__kind { color: var(--color-success); }
.oc-row__time { margin-left: auto; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
.oc-row__text {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-secondary);
  word-break: break-word;
  white-space: pre-wrap;
}
.oc-row--user .oc-row__text { color: var(--text-primary); }
.oc-row__note {
  margin: 2px 0 0;
  font-size: 10px;
  color: var(--text-tertiary);
}
.oc-row__error {
  margin: 3px 0 0;
  font-size: 10px;
  line-height: 1.5;
  color: var(--color-danger-light);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
}
.oc-empty {
  padding: 20px 10px;
  text-align: center;
  font-size: 11px;
  color: var(--text-tertiary);
  list-style: none;
}

.oc__git {
  padding: 8px 12px 10px;
  border-top: 1px solid var(--border-color);
  flex-shrink: 0;
}
.oc__git-name {
  color: var(--text-secondary);
  font-weight: 500;
}
.oc__git-list {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 10px;
  margin: 0;
  font-size: 11px;
}
.oc__git-label { color: var(--text-tertiary); }
.oc__git-value {
  margin: 0;
  text-align: right;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.oc__git-value.is-warn { color: var(--color-warning); }
.oc__git-value.is-danger { color: var(--color-danger-light); }

.oc__compose {
  padding: 8px 12px 10px;
  border-top: 1px solid var(--border-color);
  flex-shrink: 0;
}
.oc__input {
  width: 100%;
  resize: vertical;
  min-height: 52px;
  max-height: 160px;
  padding: 7px 8px;
  font-size: 12px;
  line-height: 1.5;
  font-family: inherit;
  color: var(--text-primary);
  background: var(--bg-subtle);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  outline: none;
  transition: border-color var(--transition-fast) var(--ease-custom);
}
.oc__input:focus { border-color: var(--color-primary); }
.oc__input::placeholder { color: var(--text-tertiary); }
.oc__compose-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.oc__autorn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
}
.oc__autorn input { cursor: pointer; }
.oc__send {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--color-primary);
  color: #fff;
  font-size: 11.5px;
  line-height: 24px;
  padding: 0 12px;
  cursor: pointer;
  transition: opacity var(--transition-fast) var(--ease-custom);
}
.oc__send:hover:not(:disabled) { opacity: 0.88; }
.oc__send:disabled { opacity: 0.45; cursor: default; }
.oc__send:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
.oc__send-icon { font-size: 12px; }
.oc__hint {
  margin: 6px 0 0;
  font-size: 10px;
  line-height: 1.5;
  color: var(--text-tertiary);
}
</style>

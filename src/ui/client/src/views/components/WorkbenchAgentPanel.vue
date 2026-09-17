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
  多项目编排台 · 左栏下半：执行监控。

  一行 = 一个活跃 job，不是"一个 Agent"：本地跑的是 claude CLI 进程，
  一个任务并行跑三个子任务就是三个进程。把它叫做"Agent 集群"会让人以为有多个智能体在协作，
  而实际上这里能看到的就是"哪个项目的哪个任务正在跑，PID 多少，跑了多久"。
  ——按事实命名，不做超出实现的包装。

  计时器只在真有活跃执行时才起（避免空列表也每秒唤醒一次）。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { $t } from '@/lang/static'
import type { RunningAgent } from '@/types/workbench'
import { formatElapsed } from '@/utils/relativeTime'

const props = defineProps<{
  running: RunningAgent[]
}>()

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

function stopTimer() {
  if (timer) { clearInterval(timer); timer = null }
}
function syncTimer() {
  if (props.running.length > 0) {
    if (timer) return
    now.value = Date.now()
    timer = setInterval(() => { now.value = Date.now() }, 1000)
  } else {
    stopTimer()
  }
}
watch(() => props.running.length, syncTimer, { immediate: true })
onBeforeUnmount(stopTimer)

/** elapsed 依赖 now 才能每秒刷新，这里显式读一下 now 建立依赖 */
const rows = computed(() => props.running.map(r => ({
  ...r,
  elapsed: formatElapsed(r.startedAt, null, now.value),
})))
</script>

<template>
  <section class="agents">
    <header class="agents__head">
      <h3 class="agents__title">{{ $t('@WORKBENCH:执行监控') }}</h3>
      <span class="agents__count" :class="{ 'is-live': running.length > 0 }">
        {{ $t('@WORKBENCH:{n} 个执行中', { n: running.length }) }}
      </span>
    </header>

    <ul class="agents__list">
      <li v-for="r in rows" :key="r.jobId" class="agent-item">
        <div class="agent-item__row1">
          <span class="agent-item__dot" :class="{ 'is-pending': r.status === 'pending' }" aria-hidden="true" />
          <span class="agent-item__project" :title="r.projectName">{{ r.projectName || '—' }}</span>
          <span class="agent-item__status">
            {{ r.status === 'pending' ? $t('@WORKBENCH:排队中') : $t('@WORKBENCH:执行中') }}
          </span>
        </div>
        <p class="agent-item__task" :title="r.taskTitle">{{ r.taskTitle || $t('@WORKBENCH:未命名任务') }}</p>
        <p v-if="r.subTitle" class="agent-item__sub" :title="r.subTitle">{{ r.subTitle }}</p>
        <div class="agent-item__row3">
          <span v-if="r.pid" class="agent-item__pid">PID {{ r.pid }}</span>
          <span class="agent-item__elapsed">{{ r.elapsed }}</span>
        </div>
      </li>

      <li v-if="running.length === 0" class="agents-empty">
        {{ $t('@WORKBENCH:暂无执行中的任务') }}
      </li>
    </ul>
  </section>
</template>

<style scoped>
.agents {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 0 1 auto;
  max-height: 42%;
  border-top: 1px solid var(--border-color);
  overflow: hidden;
}
.agents__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px 6px;
  flex-shrink: 0;
}
.agents__title {
  margin: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  flex: 1;
  min-width: 0;
}
.agents__count {
  font-size: 10px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.agents__count.is-live { color: var(--color-warning); }
.agents__list {
  list-style: none;
  margin: 0;
  padding: 0 6px 8px;
  overflow-y: auto;
  min-height: 0;
  flex: 1 1 auto;
}

.agent-item {
  padding: 7px 8px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--color-warning) 7%, transparent);
  margin-bottom: 4px;
}
.agent-item__row1 {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.agent-item__dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-warning);
  animation: agent-pulse 1.4s ease-in-out infinite;
}
.agent-item__dot.is-pending {
  background: var(--text-tertiary);
  animation: none;
}
@keyframes agent-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(1.3); }
}
.agent-item__project {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
.agent-item__status {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--color-warning);
}
.agent-item__task {
  margin: 3px 0 0 12px;
  font-size: 11.5px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.5;
}
.agent-item__sub {
  margin: 1px 0 0 12px;
  font-size: 11px;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.5;
}
.agent-item__row3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 3px 0 0 12px;
  font-size: 10px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.agent-item__elapsed { margin-left: auto; }

.agents-empty {
  padding: 14px 10px;
  text-align: center;
  font-size: 11px;
  color: var(--text-tertiary);
  list-style: none;
}
</style>

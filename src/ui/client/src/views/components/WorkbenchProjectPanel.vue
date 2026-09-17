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
  多项目编排台 · 左栏上半：项目列表。

  数据全部来自 GET /api/workbench/projects（服务器已算好 Git 状态与任务统计），
  这个组件只负责排版，不做任何推导。

  两处刻意的克制：
    1. Git 状态三态——exists=false 才显示「目录不存在」，exists=null（没探到）什么都不显示。
       宁可没有标记，也不谎报"你的目录没了"。
    2. 不显示「非 Git 仓库」这类中性标记（除非真的不是仓库）：徽标位只留给需要动作的信号，
       否则一行里塞四五个标签，项目名会被挤成省略号。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { $t } from '@/lang/static'
import { Folder, Grid } from '@element-plus/icons-vue'
import type { ProjectSummary } from '@/types/workbench'
import { relativeTimeFromIso } from '@/utils/relativeTime'

const props = defineProps<{
  projects: ProjectSummary[]
  selectedKey: string
  loading: boolean
}>()

const emit = defineEmits<{
  /** project 为 null 表示选中「全部项目」 */
  select: [project: ProjectSummary | null]
}>()

/** 有活跃执行的排前面，再按最后活跃时间倒序，最后是路径名——保证"正在动的"永远在第一屏 */
const ordered = computed(() => {
  return [...props.projects].sort((a, b) => {
    if ((a.stats.runningJobs > 0) !== (b.stats.runningJobs > 0)) {
      return a.stats.runningJobs > 0 ? -1 : 1
    }
    const ta = a.stats.lastActiveAt || ''
    const tb = b.stats.lastActiveAt || ''
    if (ta !== tb) return tb.localeCompare(ta)
    return a.name.localeCompare(b.name)
  })
})

const totals = computed(() => props.projects.reduce(
  (acc, p) => ({
    running: acc.running + p.stats.runningJobs,
    done: acc.done + p.stats.done,
    total: acc.total + p.stats.total,
  }),
  { running: 0, done: 0, total: 0 }
))

/** 「全部项目」的汇总进度：跨项目按任务数加权，无任务时 0 而不是 NaN */
const overallProgress = computed(() =>
  totals.value.total > 0 ? Math.round((totals.value.done / totals.value.total) * 100) : 0
)

function gitLine(p: ProjectSummary): string {
  if (!p.git) return ''
  if (p.git.isGitRepo === null) return $t('@WORKBENCH:未知')
  if (!p.git.isGitRepo) return $t('@WORKBENCH:不是 Git 仓库')
  if (p.git.detached) return $t('@WORKBENCH:游离 HEAD')
  return p.git.branch || $t('@WORKBENCH:未知')
}
</script>

<template>
  <section class="proj">
    <header class="proj__head">
      <h3 class="proj__title">{{ $t('@WORKBENCH:项目列表') }}</h3>
      <span class="proj__count">{{ projects.length }}</span>
    </header>

    <ul class="proj__list">
      <li
        class="proj-item proj-item--all"
        :class="{ 'is-active': selectedKey === '' }"
        role="button"
        tabindex="0"
        :title="$t('@WORKBENCH:全部项目')"
        @click="emit('select', null)"
        @keydown.enter.prevent="emit('select', null)"
        @keydown.space.prevent="emit('select', null)"
      >
        <div class="proj-item__row1">
          <el-icon class="proj-item__icon"><Grid /></el-icon>
          <span class="proj-item__name">{{ $t('@WORKBENCH:全部项目') }}</span>
          <span v-if="totals.running > 0" class="proj-item__running" aria-hidden="true" />
          <span class="proj-item__num">{{ projects.length }}</span>
        </div>

        <div class="proj-item__row2">
          <span>{{ $t('@WORKBENCH:{n} 个项目', { n: projects.length }) }}</span>
          <span v-if="totals.running > 0" class="proj-item__running-text">
            {{ $t('@WORKBENCH:{n} 个执行中', { n: totals.running }) }}
          </span>
        </div>

        <div class="proj-item__row3">
          <span class="proj-item__bar" aria-hidden="true">
            <i class="proj-item__bar-fill" :style="{ width: overallProgress + '%' }" />
          </span>
          <span class="proj-item__progress-text">
            {{ $t('@WORKBENCH:{done}/{total} 任务完成', { done: totals.done, total: totals.total }) }}
          </span>
        </div>
      </li>

      <li
        v-for="p in ordered"
        :key="p.key"
        class="proj-item"
        :class="{ 'is-active': p.key === selectedKey, 'is-running': p.stats.runningJobs > 0 }"
        role="button"
        tabindex="0"
        :title="p.path"
        @click="emit('select', p)"
        @keydown.enter.prevent="emit('select', p)"
        @keydown.space.prevent="emit('select', p)"
      >
        <div class="proj-item__row1">
          <el-icon class="proj-item__icon"><Folder /></el-icon>
          <span class="proj-item__name">{{ p.name }}</span>
          <span v-if="p.stats.runningJobs > 0" class="proj-item__running" aria-hidden="true" />
          <span v-if="p.isCurrent" class="proj-item__badge">{{ $t('@WORKBENCH:当前') }}</span>
        </div>

        <div class="proj-item__row2">
          <template v-if="p.exists === false">
            <span class="proj-chip proj-chip--missing">{{ $t('@WORKBENCH:目录不存在') }}</span>
          </template>
          <template v-else>
            <span class="proj-item__branch">{{ gitLine(p) }}</span>
            <span v-if="p.git && p.git.ahead > 0" class="proj-chip proj-chip--ahead">↑{{ p.git.ahead }}</span>
            <span v-if="p.git && p.git.behind > 0" class="proj-chip proj-chip--behind">↓{{ p.git.behind }}</span>
            <span v-if="p.git && p.git.changed > 0" class="proj-chip proj-chip--dirty">●{{ p.git.changed }}</span>
          </template>
          <span class="proj-item__time">{{ relativeTimeFromIso(p.stats.lastActiveAt) }}</span>
        </div>

        <div class="proj-item__row3">
          <span class="proj-item__bar" aria-hidden="true">
            <i class="proj-item__bar-fill" :style="{ width: p.stats.progress + '%' }" />
          </span>
          <span class="proj-item__progress-text">
            {{ $t('@WORKBENCH:{done}/{total} 任务完成', { done: p.stats.done, total: p.stats.total }) }}
          </span>
        </div>
      </li>

      <li v-if="!loading && projects.length === 0" class="proj-empty">
        <p class="proj-empty__title">{{ $t('@WORKBENCH:尚无项目') }}</p>
        <p class="proj-empty__hint">{{ $t('@WORKBENCH:常用目录与建过任务的目录都会出现在这里') }}</p>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.proj {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 auto;
  overflow: hidden;
}
.proj__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px 6px;
  flex-shrink: 0;
}
.proj__title {
  margin: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  flex: 1;
  min-width: 0;
}
.proj__count {
  font-size: 10px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.proj__list {
  list-style: none;
  margin: 0;
  padding: 0 6px 8px;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
}

/* 扁平行：无圆角、无边框，靠 hover 底色与行间留白区分 */
.proj-item {
  padding: 7px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background var(--transition-fast) var(--ease-custom);
  outline: none;
}
.proj-item:hover { background: var(--bg-container-hover); }
.proj-item.is-active { background: color-mix(in srgb, var(--color-primary) 10%, transparent); }
.proj-item:focus-visible { outline: var(--focus-outline); outline-offset: -1px; }
.proj-item.is-running { background: color-mix(in srgb, var(--color-warning) 7%, transparent); }

/* 「全部项目」：与真实项目同构，但用一条下边线把它和下面的项目列表分隔开 */
.proj-item--all {
  margin-bottom: 4px;
  border-bottom: 1px solid var(--border-color);
  border-radius: 6px 6px 0 0;
}
.proj-item__num {
  flex-shrink: 0;
  font-size: 10px;
  line-height: 15px;
  padding: 0 5px;
  border-radius: 4px;
  color: var(--text-secondary);
  background: var(--bg-subtle);
  font-variant-numeric: tabular-nums;
}
.proj-item__running-text {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--color-warning);
  font-variant-numeric: tabular-nums;
}

.proj-item__row1 {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.proj-item__icon {
  font-size: 13px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}
.proj-item.is-active .proj-item__icon { color: var(--color-primary); }
.proj-item__name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
  line-height: 1.4;
}
.proj-item__running {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-warning);
  animation: proj-pulse 1.4s ease-in-out infinite;
}
@keyframes proj-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(1.3); }
}
.proj-item__badge {
  flex-shrink: 0;
  font-size: 10px;
  line-height: 15px;
  padding: 0 5px;
  border-radius: 4px;
  color: var(--color-primary);
  background: var(--tint-primary-12);
}

.proj-item__row2 {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 2px;
  min-width: 0;
  font-size: 11px;
  color: var(--text-tertiary);
}
.proj-item__branch {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 110px;
  font-family: var(--font-mono, ui-monospace, monospace);
}
.proj-item__time {
  margin-left: auto;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.proj-chip {
  flex-shrink: 0;
  font-size: 10px;
  line-height: 14px;
  padding: 0 4px;
  border-radius: 3px;
  font-variant-numeric: tabular-nums;
}
.proj-chip--ahead { color: var(--color-primary); background: var(--tint-primary-12); }
.proj-chip--behind { color: var(--color-warning); background: color-mix(in srgb, var(--color-warning) 14%, transparent); }
.proj-chip--dirty { color: var(--text-secondary); background: var(--bg-subtle); }
.proj-chip--missing { color: var(--color-danger-light); background: color-mix(in srgb, var(--color-danger) 12%, transparent); }

.proj-item__row3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 5px;
}
.proj-item__bar {
  flex: 1;
  min-width: 0;
  height: 3px;
  border-radius: 2px;
  background: var(--bg-subtle);
  overflow: hidden;
}
.proj-item__bar-fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--color-primary);
  transition: width var(--transition-base) var(--ease-custom);
}
.proj-item__progress-text {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.proj-empty {
  padding: 20px 12px;
  text-align: center;
  list-style: none;
}
.proj-empty__title {
  margin: 0 0 4px;
  font-size: 12.5px;
  color: var(--text-secondary);
}
.proj-empty__hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-tertiary);
}
</style>

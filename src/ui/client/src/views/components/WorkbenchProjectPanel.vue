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
    2. 分支位只放**真的分支**：不是 Git 仓库时整段不显示（用户看这里没有分支图标就知道了，
       不必再用文字重复一遍"不是仓库"）。徽标位只留给需要动作的信号，
       否则一行里塞四五个标签，项目名会被挤成省略号。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { $t } from '@/lang/static'
import { Folder, FolderOpened, Grid } from '@element-plus/icons-vue'
import SvgIcon from '@components/SvgIcon/index.vue'
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
  /** 在系统文件管理器里打开该项目的目录（不改动看板选中态） */
  'open-folder': [project: ProjectSummary]
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

/**
 * 左栏那一行的分支文案。**空串 = 这行不显示**：
 * 不是 Git 仓库时不留文字 —— 那一格空着本身就是"这儿没有分支"的信号，
 * 再写一句「不是 Git 仓库」只是把行撑长、把项目名挤成省略号。
 */
function gitLine(p: ProjectSummary): string {
  if (!p.git) return ''
  if (p.git.isGitRepo === null) return $t('@WORKBENCH:未知')
  if (!p.git.isGitRepo) return ''
  if (p.git.detached) return $t('@WORKBENCH:游离 HEAD')
  return p.git.branch || $t('@WORKBENCH:未知')
}

/** 有没有分支可挂图标：只有真的落在某个分支上（含游离 HEAD）才算，"未知"没有 */
function hasBranchIcon(p: ProjectSummary): boolean {
  return !!(p.git && p.git.isGitRepo && (p.git.detached || p.git.branch))
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
        :class="{
          'is-active': p.key === selectedKey,
          'is-running': p.stats.runningJobs > 0,
          'is-missing': p.exists === false,
        }"
        role="button"
        tabindex="0"
        :title="p.path"
        @click="emit('select', p)"
        @keydown.enter.self.prevent="emit('select', p)"
        @keydown.space.self.prevent="emit('select', p)"
      >
        <div class="proj-item__row1">
          <el-icon class="proj-item__icon"><Folder /></el-icon>
          <span class="proj-item__name">{{ p.name }}</span>
          <!-- 运行中 / 当前 这两个信号与 hover 才出现的操作按钮锚在同一个右端点：
               hover 时整组淡出让位给按钮，而不是让图标压在徽标上 -->
          <span class="proj-item__signals">
            <span v-if="p.stats.runningJobs > 0" class="proj-item__running" aria-hidden="true" />
            <span v-if="p.isCurrent" class="proj-item__badge">{{ $t('@WORKBENCH:当前') }}</span>
          </span>
        </div>

        <div class="proj-item__row2">
          <template v-if="p.exists === false">
            <span class="proj-chip proj-chip--missing">{{ $t('@WORKBENCH:目录不存在') }}</span>
          </template>
          <template v-else>
            <!-- gitLine 为空即"不是 Git 仓库"：不给文字，也不给图标 -->
            <span v-if="gitLine(p)" class="proj-item__branch">
              <svg-icon
                v-if="hasBranchIcon(p)"
                icon-class="git-branch"
                class-name="proj-item__branch-icon"
              />
              <span class="proj-item__branch-name">{{ gitLine(p) }}</span>
            </span>
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

        <!-- 打开文件夹：与行主体平级，绝对定位锚在 row1 右端（不占位，否则「当前」徽标
             永远离右边缘一条）；.stop 阻止冒泡到行的选中逻辑。目录都不存在了就不渲染——
             点了只会弹一个「无法打开目录」的报错。
             ⚠️ 行上的 keydown 必须带 .self：事件从按钮冒泡上来，不带 .self 时
             焦点在按钮上按回车会「选中该行 + preventDefault 掉按钮自己的激活」，
             键盘用户反而打不开文件夹。 -->
        <div v-if="p.exists !== false" class="proj-item__actions">
          <button
            type="button"
            class="proj-item__action"
            :title="$t('@WORKBENCH:打开文件夹')"
            :aria-label="`${$t('@WORKBENCH:打开文件夹')} ${p.name}`"
            @click.stop="emit('open-folder', p)"
          >
            <el-icon aria-hidden="true"><FolderOpened /></el-icon>
          </button>
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
  /* hover 操作按钮的定位锚点 */
  position: relative;
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
  /* 给 hover 才出现的「打开文件夹」按钮留位：按钮绝对定位在 row1 右端，
     没有信号（运行中/当前）时名字会一路顶到那里，不留位就会被图标压住尾巴。
     名字没被截断时这段 padding 完全不可见。 */
  padding-right: 20px;
}
/* 运行中 / 当前：与操作按钮共用 row1 右端这个锚点，hover 时整组淡出让位 */
.proj-item__signals {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: opacity var(--transition-fast) var(--ease-custom);
}
/* ⚠️ 用 `:has(按钮:focus-visible)` 而不是 `.proj-item:focus-within`：
   点击行主体后 Chrome 把焦点留在行上，用 :focus-within 会让信号点击之后一直隐身；
   只有键盘 Tab 真正落到按钮上才需要让位。 */
.proj-item:not(.is-missing):hover .proj-item__signals,
.proj-item:not(.is-missing):has(.proj-item__action:focus-visible) .proj-item__signals {
  opacity: 0;
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

/* ── hover 才出现的「打开文件夹」 ──────────────────────────────────── */
/* 绝对定位：空闲时不占宽度，row1 右端的徽标才能贴住行边缘。
   隐藏时 pointer-events: none —— 否则它会在右边吞掉本该落到整行的点击。 */
.proj-item__actions {
  position: absolute;
  right: 8px;
  top: 6px;
  display: inline-flex;
  align-items: center;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--transition-fast) var(--ease-custom);
}
.proj-item:hover .proj-item__actions,
.proj-item:has(.proj-item__action:focus-visible) .proj-item__actions {
  opacity: 1;
  pointer-events: auto;
}
/* 扁平化：无边框无底色，只靠图标颜色表达 hover，和「最近项目」卡片的操作按钮同一套语言 */
.proj-item__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 13px;
  cursor: pointer;
  transition:
    color var(--transition-fast) var(--ease-custom),
    background var(--transition-fast) var(--ease-custom);
}
.proj-item__action:hover {
  color: var(--color-primary);
  background: var(--tint-primary-12);
}
.proj-item__action:active { color: var(--color-primary); }
.proj-item__action:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }

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
  /* 图标 + 分支名并排；max-width 比只有文字时略宽，给图标让出位置 */
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 130px;
  font-family: var(--font-mono, ui-monospace, monospace);
}
/* ⚠️ 省略号必须挂在分支名这层：flex item 上的 text-overflow 管不到里面的文本节点 */
.proj-item__branch-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 图标与分支名同色，不抢眼。
   ⚠️ color 这条**不能省**：SvgIcon 自己声明了 .svg-icon{color:--text-secondary}，
   不覆盖的话图标比分支名亮一档（实测 rgb(216,220,226) vs rgb(203,208,214)）。
   锚在 .proj-item__branch 下把权重抬到 (0,3,0) 是**防御性**的：裸 :deep() 实测也绿，
   但那是"父组件样式后注入"这个打包顺序白送的，不是权重挣来的 —— 既然覆盖的是
   SvgIcon 自己声明的属性，就显式赢，别把结论押在顺序上。 */
.proj-item__branch :deep(.proj-item__branch-icon) {
  width: 11px;
  height: 11px;
  flex-shrink: 0;
  color: currentColor;
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

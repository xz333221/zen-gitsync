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
  多项目编排台 · 中栏：任务看板。

  关于「列」的一处重要克制：这四列是**推导出来的阶段**，不是可拖拽的状态字段。
  待处理/进行中/已完成 全部由执行事实推出（后端 deriveTaskColumn）：
  有 job 在跑就是进行中、子任务全完成才是已完成……
  所以卡片不支持拖动换列——拖过去也没有对应的写操作可做，
  与其做一个拖了就弹回去的假交互，不如让动作落在「执行 / 查看详情」这两个真按钮上。

  点卡片 = 直接进任务编辑器（open-task）：编辑器是"浮在看板之上的弹窗"，
  关掉就回到原来的位置和筛选，本身就不会丢上下文。
  （曾经这里先弹一个只读详情弹窗、再从里面点「打开编辑器」——那多出来的一跳，
   在编辑器还是独立页面时是为了保住看板位置；编辑器改成弹窗之后这个理由就不成立了，
   2026-09-20 去掉。执行 / 删除仍然留在卡片上，扫全局时就地处理的路子没变。）
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { $t } from '@/lang/static'
import { Search } from '@element-plus/icons-vue'
import type { BoardTask, TaskColumn } from '@/types/workbench'
import { relativeTimeFromIso } from '@/utils/relativeTime'

const props = defineProps<{
  tasks: BoardTask[]
  /** 视图为「全部项目」时在卡片上标出项目名，避免同名任务分不清 */
  projectLabels: Record<string, string>
  showProjectLabel: boolean
}>()

const emit = defineEmits<{
  /** 打开任务编辑器（上层把编辑器弹窗顶起来，不换页） */
  'open-task': [task: BoardTask]
  'run-task': [task: BoardTask]
  'delete-task': [task: BoardTask]
  'create-task': []
}>()

const VIEW_KEY = 'wb.boardView.v1'

const view = ref<'kanban' | 'list'>((() => {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    return v === 'list' ? 'list' : 'kanban'
  } catch {
    return 'kanban'
  }
})())
watch(view, (v) => {
  try { localStorage.setItem(VIEW_KEY, v) } catch { /* 隐私模式：不落地也不影响使用 */ }
})

const search = ref('')
const typeFilter = ref<'all' | 'simple' | 'complex'>('all')
const onlyErrors = ref(false)

const COLUMNS: { key: TaskColumn; labelKey: string }[] = [
  { key: 'todo', labelKey: '@WORKBENCH:待处理' },
  { key: 'doing', labelKey: '@WORKBENCH:进行中' },
  { key: 'done', labelKey: '@WORKBENCH:已完成' },
]

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  return props.tasks.filter(t => {
    if (typeFilter.value !== 'all' && t.type !== typeFilter.value) return false
    if (onlyErrors.value && t.subtaskErrorCount === 0 && t.lastJobStatus !== 'error') return false
    if (!q) return true
    return (t.title || '').toLowerCase().includes(q) || (t.desc || '').toLowerCase().includes(q)
  })
})

const columns = computed(() =>
  COLUMNS.map(c => ({ ...c, tasks: filtered.value.filter(t => t.column === c.key) }))
)

/**
 * 列轨道数跟着列数走。
 * 写死在 CSS 里的 `repeat(4, ...)` 在去掉「评审中」之后留了一条**空轨道**——
 * 三条列各占 1/4，剩下 1/4 全白，正是"评审列占了很大面积"观感的来源。
 * 这里用内联样式取值（而不是改 CSS 里的数字），增删列时不用再记得改 CSS。
 * 窄屏堆叠走的是 @media 改 `display`（不是改轨道数），所以不会被内联样式压住。
 */
const columnsStyle = computed(() => ({
  gridTemplateColumns: `repeat(${columns.value.length}, minmax(0, 1fr))`,
}))

/** 卡片标题：优先任务标题；没写标题时用描述压平成一行（与侧边栏任务行同一约定） */
function cardTitle(t: BoardTask): string {
  const title = (t.title || '').trim()
  if (title) return title
  return (t.desc || '').replace(/\s+/g, ' ').trim()
}

function projectLabel(t: BoardTask): string {
  return props.projectLabels[t.projectPath] || ''
}

/** 有未完成却报过错的子任务——给卡片一个"需要你看一眼"的标记 */
function hasError(t: BoardTask): boolean {
  return t.subtaskErrorCount > 0 || t.lastJobStatus === 'error'
}
</script>

<template>
  <div class="kb">
    <div class="kb__toolbar">
      <div class="kb__views" role="tablist">
        <button
          type="button"
          role="tab"
          class="kb__view-btn"
          :class="{ 'is-active': view === 'kanban' }"
          :aria-selected="view === 'kanban'"
          @click="view = 'kanban'"
        >{{ $t('@WORKBENCH:看板视图') }}</button>
        <button
          type="button"
          role="tab"
          class="kb__view-btn"
          :class="{ 'is-active': view === 'list' }"
          :aria-selected="view === 'list'"
          @click="view = 'list'"
        >{{ $t('@WORKBENCH:列表视图') }}</button>
      </div>

      <div class="kb__filters">
        <select class="kb__select" v-model="typeFilter" :aria-label="$t('@WORKBENCH:任务类型')">
          <option value="all">{{ $t('@WORKBENCH:全部类型') }}</option>
          <option value="simple">{{ $t('@WORKBENCH:简单') }}</option>
          <option value="complex">{{ $t('@WORKBENCH:复杂') }}</option>
        </select>
        <label class="kb__check" :title="$t('@WORKBENCH:只显示子任务或最近一次执行报错的任务')">
          <input type="checkbox" v-model="onlyErrors" />
          <span>{{ $t('@WORKBENCH:仅看报错') }}</span>
        </label>
        <div class="kb__search">
          <el-icon class="kb__search-icon"><Search /></el-icon>
          <input
            class="kb__search-input"
            type="search"
            v-model="search"
            :placeholder="$t('@WORKBENCH:搜索任务标题或描述')"
          />
        </div>
      </div>
    </div>

    <!-- 看板视图 -->
    <div v-if="view === 'kanban'" class="kb__columns" :style="columnsStyle">
      <section v-for="col in columns" :key="col.key" class="kb-col" :class="'kb-col--' + col.key">
        <header class="kb-col__head">
          <span class="kb-col__dot" aria-hidden="true" />
          <h3 class="kb-col__title">{{ $t(col.labelKey) }}</h3>
          <span class="kb-col__count">{{ col.tasks.length }}</span>
        </header>

        <ul class="kb-col__list">
          <li
            v-for="t in col.tasks"
            :key="t.id"
            class="kb-card"
            :class="{ 'is-running': t.runningJobs > 0, 'has-error': hasError(t) }"
            @click="emit('open-task', t)"
          >
            <div class="kb-card__row1">
              <span v-if="t.runningJobs > 0" class="kb-card__running" aria-hidden="true" />
              <span v-if="t.type === 'simple'" class="kb-card__type">{{ $t('@WORKBENCH:简单') }}</span>
              <span v-if="t.subtaskErrorCount > 0" class="kb-card__error">
                {{ $t('@WORKBENCH:{n} 个子任务报错', { n: t.subtaskErrorCount }) }}
              </span>
              <span class="kb-card__time">{{ relativeTimeFromIso(t.updatedAt || t.createdAt) }}</span>
            </div>

            <p class="kb-card__title" :title="cardTitle(t)">{{ cardTitle(t) || $t('@WORKBENCH:未命名任务') }}</p>

            <p v-if="showProjectLabel && projectLabel(t)" class="kb-card__project">{{ projectLabel(t) }}</p>

            <div v-if="t.subtaskCount > 0" class="kb-card__progress">
              <span class="kb-card__bar" aria-hidden="true">
                <i
                  class="kb-card__bar-fill"
                  :style="{ width: Math.round((t.subtaskDoneCount / t.subtaskCount) * 100) + '%' }"
                />
              </span>
              <span class="kb-card__progress-text">{{ t.subtaskDoneCount }}/{{ t.subtaskCount }}</span>
            </div>

            <div class="kb-card__actions">
              <button
                v-if="t.runningJobs === 0"
                type="button"
                class="kb-card__btn"
                :title="$t('@WORKBENCH:执行')"
                @click.stop="emit('run-task', t)"
              >{{ $t('@WORKBENCH:执行') }}</button>
              <button
                type="button"
                class="kb-card__btn kb-card__btn--danger"
                :title="$t('@WORKBENCH:删除')"
                :aria-label="$t('@WORKBENCH:删除')"
                @click.stop="emit('delete-task', t)"
              >×</button>
            </div>
          </li>

          <li v-if="col.tasks.length === 0" class="kb-col__empty">
            <button v-if="col.key === 'todo'" type="button" class="kb-col__empty-btn" @click="emit('create-task')">
              {{ $t('@WORKBENCH:新建任务') }}
            </button>
            <span v-else>{{ $t('@WORKBENCH:暂无任务') }}</span>
          </li>
        </ul>
      </section>
    </div>

    <!-- 列表视图 -->
    <div v-else class="kb__table-wrap">
      <table class="kb-table">
        <thead>
          <tr>
            <th class="kb-table__th">{{ $t('@WORKBENCH:任务') }}</th>
            <th class="kb-table__th kb-table__th--narrow">{{ $t('@WORKBENCH:状态') }}</th>
            <th class="kb-table__th kb-table__th--narrow">{{ $t('@WORKBENCH:类型') }}</th>
            <th class="kb-table__th kb-table__th--narrow">{{ $t('@WORKBENCH:子任务') }}</th>
            <th class="kb-table__th kb-table__th--narrow">{{ $t('@WORKBENCH:更新时间') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in filtered" :key="t.id" class="kb-table__row" @click="emit('open-task', t)">
            <td class="kb-table__td">
              <span class="kb-table__name">{{ cardTitle(t) || $t('@WORKBENCH:未命名任务') }}</span>
              <span v-if="showProjectLabel && projectLabel(t)" class="kb-table__project">{{ projectLabel(t) }}</span>
            </td>
            <td class="kb-table__td">
              <span class="kb-table__status" :class="'is-' + t.column">
                {{ $t(COLUMNS.find(c => c.key === t.column)!.labelKey) }}
              </span>
            </td>
            <td class="kb-table__td">
              {{ t.type === 'simple' ? $t('@WORKBENCH:简单') : $t('@WORKBENCH:复杂') }}
            </td>
            <td class="kb-table__td kb-table__td--num">
              <template v-if="t.subtaskCount > 0">{{ t.subtaskDoneCount }}/{{ t.subtaskCount }}</template>
              <template v-else>—</template>
            </td>
            <td class="kb-table__td kb-table__td--num">{{ relativeTimeFromIso(t.updatedAt || t.createdAt) }}</td>
          </tr>
          <tr v-if="filtered.length === 0">
            <td class="kb-table__td kb-table__empty" colspan="5">{{ $t('@WORKBENCH:暂无任务') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.kb {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}

/* ── 工具条 ─────────────────────────────────────────── */
.kb__toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.kb__views {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  flex-shrink: 0;
}
.kb__view-btn {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11.5px;
  line-height: 20px;
  padding: 0 10px;
  border-radius: 4px;
  cursor: pointer;
  transition: background var(--transition-fast) var(--ease-custom), color var(--transition-fast) var(--ease-custom);
}
.kb__view-btn:hover { color: var(--text-primary); }
.kb__view-btn.is-active {
  background: var(--bg-panel);
  color: var(--color-primary);
  font-weight: 500;
}
.kb__filters {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
  flex-wrap: wrap;
}
.kb__select {
  height: 24px;
  padding: 0 4px;
  font-size: 11.5px;
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  cursor: pointer;
  outline: none;
}
.kb__select:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
.kb__check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
}
.kb__check input { cursor: pointer; }
.kb__search { position: relative; display: inline-flex; align-items: center; }
.kb__search-icon {
  position: absolute;
  left: 7px;
  font-size: 12px;
  color: var(--text-tertiary);
  pointer-events: none;
}
.kb__search-input {
  width: 168px;
  height: 24px;
  padding: 0 8px 0 24px;
  font-size: 11.5px;
  color: var(--text-primary);
  background: var(--bg-subtle);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  outline: none;
  transition: border-color var(--transition-fast) var(--ease-custom), width var(--transition-base) var(--ease-custom);
}
.kb__search-input:focus { border-color: var(--color-primary); width: 216px; }
.kb__search-input::placeholder { color: var(--text-tertiary); }

/* ── 看板列 ─────────────────────────────────────────── */
.kb__columns {
  display: grid;
  /* 轨道数由 columnsStyle 内联给出（= 列数），别在这儿写死数字 */
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
.kb-col {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  border-left: 1px solid var(--border-color);
}
.kb-col:first-child { border-left: none; }
.kb-col__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 10px 7px;
  flex-shrink: 0;
}
.kb-col__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-tertiary);
}
.kb-col--doing .kb-col__dot { background: var(--color-warning); animation: kb-pulse 1.4s ease-in-out infinite; }
.kb-col--done .kb-col__dot { background: var(--color-success); }
@keyframes kb-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(1.35); }
}
.kb-col__title {
  margin: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  flex: 1;
  min-width: 0;
}
.kb-col__count {
  font-size: 10px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.kb-col__list {
  list-style: none;
  margin: 0;
  padding: 0 8px 10px;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
}

/* ── 卡片：扁平行，圆角克制在 6px，没有左侧色条 ── */
.kb-card {
  position: relative;
  padding: 8px 10px;
  margin-bottom: 6px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  cursor: pointer;
  transition: border-color var(--transition-fast) var(--ease-custom), background var(--transition-fast) var(--ease-custom);
}
.kb-card:hover { border-color: var(--border-card-hover); background: var(--bg-container-hover); }
.kb-card.is-running { border-color: color-mix(in srgb, var(--color-warning) 45%, var(--border-color)); }
.kb-card.has-error { border-color: color-mix(in srgb, var(--color-danger) 40%, var(--border-color)); }

.kb-card__row1 {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  margin-bottom: 4px;
  font-size: 10px;
  color: var(--text-tertiary);
}
.kb-card__running {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-warning);
  flex-shrink: 0;
  animation: kb-pulse 1.4s ease-in-out infinite;
}
.kb-card__type {
  flex-shrink: 0;
  padding: 0 4px;
  border-radius: 3px;
  line-height: 14px;
  background: var(--bg-subtle);
  color: var(--text-tertiary);
}
.kb-card__error {
  flex-shrink: 0;
  padding: 0 4px;
  border-radius: 3px;
  line-height: 14px;
  color: var(--color-danger-light);
  background: color-mix(in srgb, var(--color-danger) 12%, transparent);
}
.kb-card__time { margin-left: auto; flex-shrink: 0; font-variant-numeric: tabular-nums; }
.kb-card__title {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-primary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.kb-card__project {
  margin: 3px 0 0;
  font-size: 10.5px;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.kb-card__progress {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
.kb-card__bar {
  flex: 1;
  min-width: 0;
  height: 3px;
  border-radius: 2px;
  background: var(--bg-subtle);
  overflow: hidden;
}
.kb-card__bar-fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--color-primary);
  transition: width var(--transition-base) var(--ease-custom);
}
.kb-card__progress-text {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

/* hover 才出现的操作组：绝对定位不占位，空闲时连点击也一起让开
   （否则隐形的按钮会吞掉本该落到卡片的点击） */
.kb-card__actions {
  position: absolute;
  right: 8px;
  bottom: 6px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding-left: 12px;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--transition-fast) var(--ease-custom);
}
.kb-card:hover .kb-card__actions,
.kb-card:focus-within .kb-card__actions {
  opacity: 1;
  pointer-events: auto;
}

/*
 * 操作组正压在进度条和 "0/8" 上。这里**不用"给它加背景"的办法去盖**：
 *   · 面板/容器类底色 token 在深色主题下本身就是半透明的
 *     （--bg-panel-dark = rgba(255,255,255,.06)），拿它当浮层背景等于没挡；
 *   · 换成不透明的 --bg-container 又比卡片暗，左边缘会留一道色阶；
 *   · 而且浮层底色还得跟着 hover / focus-within / is-running 逐一对齐，很容易漏。
 * 改成把**底下的进度行在右侧渐隐掉**：不涉及任何颜色，深浅主题都成立，也没有接缝。
 * （组内按钮本身是 transparent，所以必须让它所在区域完全透明，不能只减淡。）
 *
 * 渐隐位置按操作组的实际占位反推：组右边缘距卡片右内边 8px、组宽 ≈ 62px
 * （padding-left 12 + 「执行」32 + gap 2 + ×16），即组左边缘在内容盒右侧 60px 处。
 * 所以让 mask 在「距右侧 64px」处就完全透明 —— 留 4px 余量，按钮（含 padding）
 * 整个落在全透明区里，不会露出半截字形；再往左 16px 是淡出段。
 * 英文标签（Run）比中文窄，组更小、左边缘更靠右，同样被完全透明区覆盖，不会失效。
 */
.kb-card:hover .kb-card__progress,
.kb-card:focus-within .kb-card__progress {
  -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 80px), transparent calc(100% - 64px));
  mask-image: linear-gradient(to right, #000 calc(100% - 80px), transparent calc(100% - 64px));
}
.kb-card__btn {
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 18px;
  padding: 0 5px;
  border-radius: 4px;
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-custom);
}
.kb-card__btn:hover { color: var(--color-primary); }
.kb-card__btn--danger { font-size: 14px; padding: 0 4px; }
.kb-card__btn--danger:hover { color: var(--color-danger-light); }
.kb-card__btn:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }

.kb-col__empty {
  padding: 18px 8px;
  text-align: center;
  font-size: 11px;
  color: var(--text-tertiary);
  list-style: none;
}
.kb-col__empty-btn {
  border: 1px dashed var(--border-color-medium);
  background: transparent;
  color: var(--text-tertiary);
  font-size: 11px;
  padding: 3px 10px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-custom), border-color var(--transition-fast) var(--ease-custom);
}
.kb-col__empty-btn:hover { color: var(--color-primary); border-color: var(--color-primary); }

/* ── 列表视图 ───────────────────────────────────────── */
.kb__table-wrap {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
.kb-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.kb-table__th {
  position: sticky;
  top: 0;
  z-index: 1;
  text-align: left;
  padding: 7px 10px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-tertiary);
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-color);
  white-space: nowrap;
}
.kb-table__th--narrow { width: 96px; }
.kb-table__row {
  cursor: pointer;
  transition: background var(--transition-fast) var(--ease-custom);
}
.kb-table__row:hover { background: var(--bg-container-hover); }
.kb-table__td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-color);
  color: var(--text-secondary);
  vertical-align: middle;
}
.kb-table__td--num { font-variant-numeric: tabular-nums; }
.kb-table__name { color: var(--text-primary); }
.kb-table__project {
  margin-left: 6px;
  font-size: 10.5px;
  color: var(--text-tertiary);
}
.kb-table__status {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--bg-subtle);
  color: var(--text-secondary);
}
.kb-table__status.is-doing { color: var(--color-warning); }
.kb-table__status.is-done { color: var(--color-success); }
.kb-table__empty {
  text-align: center;
  padding: 28px 10px;
  color: var(--text-tertiary);
}

/* ── 窄屏：三列竖排 ─────────────────────────────────── */
/* 手机宽度下横排三列每列只剩 1/3 屏，卡片标题一律成省略号，不如竖着排、整块滚动。
   这里切的是 display 而**不是** grid-template-columns：轨道数由 columnsStyle 内联
   给出（= 列数，见脚本里的注释），媒体查询压不过内联样式，而 display 不受它影响。 */
@media (max-width: 860px) {
  .kb__columns {
    display: block;
    overflow-y: auto;
  }
  .kb-col {
    border-left: none;
    border-top: 1px solid var(--border-color);
  }
  .kb-col:first-child { border-top: none; }
  /* 每列不再各自滚：一屏三个滚动区手感很碎，交给外层整块滚 */
  .kb-col__list { overflow: visible; }
}
</style>

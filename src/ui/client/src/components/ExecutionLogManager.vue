<!--
  ExecutionLogManager.vue
  执行日志管理页：列表 / 过滤 / 批量删除 / 清空 / 保留策略。
  数据全部走 REST，每次切到本 tab 时 onMounted 拉一次；之后点刷新 / 过滤变化 / 删除 后再拉。
-->
<template>
  <div class="exec-logs">
    <!-- 头部：标题 + 统计 + 刷新 -->
    <header class="exec-logs__head">
      <div class="exec-logs__title-block">
        <h2 class="exec-logs__title">{{ $t('@WORKBENCH:执行日志') }}</h2>
        <span class="exec-logs__stats">
          {{ $t('@WORKBENCH:共 {count} 条，占 {size} MB', { count: stats.count, size: stats.sizeMB }) }}
        </span>
      </div>
      <div class="exec-logs__head-actions">
        <el-button :icon="Refresh" size="small" :loading="loading" @click="load">
          {{ $t('@WORKBENCH:刷新') }}
        </el-button>
        <el-button
          type="danger"
          plain
          size="small"
          :disabled="stats.count === 0"
          @click="clearAll"
        >
          {{ $t('@WORKBENCH:清空全部') }}
        </el-button>
      </div>
    </header>

    <!-- 保留策略 -->
    <div class="exec-logs__config">
      <span class="exec-logs__config-label">{{ $t('@WORKBENCH:保存策略') }}</span>
      <span class="exec-logs__config-field">
        <span class="exec-logs__config-name">{{ $t('@WORKBENCH:最大条数') }}</span>
        <el-input-number
          v-model="configDraft.maxCount"
          :min="0"
          :max="10000"
          :step="50"
          size="small"
          controls-position="right"
          style="width: 130px"
        />
      </span>
      <span class="exec-logs__config-field">
        <span class="exec-logs__config-name">{{ $t('@WORKBENCH:最大体积 (MB)') }}</span>
        <el-input-number
          v-model="configDraft.maxSizeMB"
          :min="0"
          :max="10240"
          :step="32"
          size="small"
          controls-position="right"
          style="width: 140px"
        />
      </span>
      <el-button type="primary" size="small" :loading="configSaving" @click="saveConfig">
        {{ $t('@WORKBENCH:保存策略') }}
      </el-button>
    </div>

    <!-- 过滤栏 -->
    <div class="exec-logs__filter">
      <el-input
        v-model="filter.q"
        :placeholder="$t('@WORKBENCH:搜索标题 / 任务')"
        clearable
        size="small"
        style="width: 240px"
        @keyup.enter="onFilterChange"
        @clear="onFilterChange"
      />
      <el-select
        v-model="filter.status"
        :placeholder="$t('@WORKBENCH:全部状态')"
        clearable
        size="small"
        style="width: 130px"
        @change="onFilterChange"
      >
        <el-option v-for="s in STATUS_OPTIONS" :key="s.value" :label="s.label" :value="s.value" />
      </el-select>
      <el-button size="small" @click="resetFilter">
        {{ $t('@WORKBENCH:重置') }}
      </el-button>
      <span class="exec-logs__filter-spacer" />
      <span v-if="selectedIds.size > 0" class="exec-logs__batch-meta">
        {{ $t('@WORKBENCH:已选择 {count} 项', { count: selectedIds.size }) }}
      </span>
    </div>

    <!-- 批量操作条 -->
    <div v-if="selectedIds.size > 0" class="exec-logs__batch">
      <el-checkbox
        :model-value="isAllOnPageSelected"
        :indeterminate="isSomeOnPageSelected"
        @change="toggleSelectAllOnPage"
      >
        {{ isAllOnPageSelected ? $t('@WORKBENCH:取消全选') : $t('@WORKBENCH:全选') }}
      </el-checkbox>
      <el-button type="danger" size="small" @click="batchDelete">
        {{ $t('@WORKBENCH:批量删除') }}
      </el-button>
    </div>

    <!-- 列表 -->
    <div v-loading="loading" class="exec-logs__list">
      <div v-if="!loading && list.length === 0" class="exec-logs__empty">
        <div class="exec-logs__empty-art" aria-hidden="true">
          <el-icon><Document /></el-icon>
        </div>
        <div class="exec-logs__empty-title">{{ $t('@WORKBENCH:暂无执行日志') }}</div>
        <div class="exec-logs__empty-hint">
          {{ $t('@WORKBENCH:点击「执行任务」开始一次执行，日志会出现在这里。') }}
        </div>
      </div>

      <article
        v-for="job in list"
        :key="job.id"
        class="exec-card"
        :class="{ 'is-selected': selectedIds.has(job.id) }"
      >
        <header class="exec-card__head">
          <el-checkbox
            :model-value="selectedIds.has(job.id)"
            @change="(v: any) => toggleSelect(job.id, v)"
          />
          <span class="exec-card__status" :style="{ color: statusColor(job.status), borderColor: statusColor(job.status) }">
            {{ statusLabel(job.status) }}
          </span>
          <span class="exec-card__title" :title="job.title || $t('@WORKBENCH:无标题')">
            {{ job.title || $t('@WORKBENCH:无标题') }}
          </span>
          <span class="exec-card__spacer" />
          <span class="exec-card__meta">
            <span v-if="job.taskTitle" class="exec-card__task">📁 {{ job.taskTitle }}</span>
            <span v-if="job.startedAt" class="exec-card__time">⏱ {{ formatDuration(job.startedAt, job.endedAt) }}</span>
            <span v-if="job.exitCode !== null" class="exec-card__exit">exit {{ job.exitCode }}</span>
          </span>
          <button
            type="button"
            class="exec-card__del"
            :title="$t('@WORKBENCH:删除')"
            @click="deleteOne(job.id)"
          >×</button>
        </header>
        <p v-if="job.error" class="exec-card__error">⚠ {{ job.error }}</p>
        <JobLogDetails :job="job" />
      </article>
    </div>

    <!-- 分页 -->
    <footer v-if="total > pageSize" class="exec-logs__pager">
      <el-pagination
        v-model:current-page="filter.page"
        :page-size="pageSize"
        :total="total"
        layout="prev, pager, next, total"
        background
        small
        @current-change="load"
      />
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Document, Refresh } from '@element-plus/icons-vue'
import { $t } from '@/lang/static'
import { statusLabel, statusColor } from '@/utils/jobStatus'
import type { JobFull, JobsConfig, JobsListResponse, JobStatus } from '@/types/workbench'
import JobLogDetails from './JobLogDetails.vue'

/** 从 unknown 错误里安全地拿 message 字符串（TS 严格模式下 catch (err) 是 unknown） */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── 状态 ────────────────────────────────────────────────────────────
const list = ref<JobFull[]>([])
const total = ref(0)
const stats = reactive({ count: 0, sizeMB: 0, byStatus: {} as Record<string, number> })
const loading = ref(false)
const selectedIds = ref<Set<string>>(new Set())
const pageSize = 50

const filter = reactive({
  q: '',
  status: '' as '' | JobStatus,
  page: 1,
})

const config = ref<JobsConfig>({ maxCount: 500, maxSizeMB: 256 })
const configDraft = reactive({ maxCount: 500, maxSizeMB: 256 })
const configSaving = ref(false)

const STATUS_OPTIONS: { value: JobStatus; label: string }[] = [
  { value: 'pending',   label: $t('@WORKBENCH:排队中') },
  { value: 'running',   label: $t('@WORKBENCH:执行中') },
  { value: 'done',      label: $t('@WORKBENCH:已完成') },
  { value: 'error',     label: $t('@WORKBENCH:出错') },
  { value: 'cancelled', label: $t('@WORKBENCH:已取消') },
]

// ── 计算 ────────────────────────────────────────────────────────────
const isAllOnPageSelected = computed(() =>
  list.value.length > 0 && list.value.every(j => selectedIds.value.has(j.id))
)
const isSomeOnPageSelected = computed(() =>
  list.value.some(j => selectedIds.value.has(j.id)) && !isAllOnPageSelected.value
)

// ── 数据加载 ────────────────────────────────────────────────────────
async function load() {
  loading.value = true
  try {
    const params = new URLSearchParams()
    if (filter.q) params.set('q', filter.q)
    if (filter.status) params.set('status', filter.status)
    params.set('limit', String(pageSize))
    params.set('offset', String((filter.page - 1) * pageSize))
    const res = await fetch(`/api/workbench/jobs/list?${params.toString()}`).then(r => r.json()) as JobsListResponse
    if (!res.success) throw new Error(res.error || 'list failed')
    list.value = res.jobs
    total.value = res.total
    stats.count = res.stats.count
    stats.sizeMB = res.stats.sizeMB
    stats.byStatus = res.stats.byStatus
    // 清掉已不在当前页的选中项（防止跨页误删）
    const pageIds = new Set(list.value.map(j => j.id))
    for (const id of Array.from(selectedIds.value)) {
      if (!pageIds.has(id)) selectedIds.value.delete(id)
    }
  } catch (err) {
    ElMessage.error($t('@WORKBENCH:加载失败') + ': ' + errMsg(err))
  } finally {
    loading.value = false
  }
}

async function loadConfig() {
  try {
    const res = await fetch('/api/workbench/jobs/config').then(r => r.json())
    if (res.success) {
      config.value = res.config
      configDraft.maxCount = res.config.maxCount
      configDraft.maxSizeMB = res.config.maxSizeMB
    }
  } catch { /* 静默——用默认 */ }
}

async function saveConfig() {
  configSaving.value = true
  try {
    const res = await fetch('/api/workbench/jobs/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        maxCount: configDraft.maxCount,
        maxSizeMB: configDraft.maxSizeMB,
      }),
    }).then(r => r.json())
    if (!res.success) throw new Error(res.error || 'save failed')
    config.value = res.config
    ElMessage.success($t('@WORKBENCH:已保存策略'))
    await load()
  } catch (err) {
    ElMessage.error($t('@WORKBENCH:保存失败') + ': ' + errMsg(err))
  } finally {
    configSaving.value = false
  }
}

function onFilterChange() {
  filter.page = 1
  load()
}

function resetFilter() {
  filter.q = ''
  filter.status = ''
  filter.page = 1
  load()
}

// ── 选择 / 删除 ─────────────────────────────────────────────────────
function toggleSelect(id: string, checked: any) {
  if (checked) selectedIds.value.add(id)
  else selectedIds.value.delete(id)
  // 触发响应式
  selectedIds.value = new Set(selectedIds.value)
}

function toggleSelectAllOnPage(checked: any) {
  if (checked) {
    for (const j of list.value) selectedIds.value.add(j.id)
  } else {
    for (const j of list.value) selectedIds.value.delete(j.id)
  }
  selectedIds.value = new Set(selectedIds.value)
}

async function deleteOne(id: string) {
  try {
    await ElMessageBox.confirm(
      $t('@WORKBENCH:确定要删除所选的 {count} 条日志吗？', { count: 1 }),
      $t('@WORKBENCH:删除'),
      { type: 'warning' }
    )
  } catch { return }
  try {
    const res = await fetch(`/api/workbench/jobs/${id}`, { method: 'DELETE' }).then(r => r.json())
    if (!res.success) throw new Error(res.error || 'delete failed')
    selectedIds.value.delete(id)
    selectedIds.value = new Set(selectedIds.value)
    await load()
  } catch (err) {
    ElMessage.error($t('@WORKBENCH:保存失败') + ': ' + errMsg(err))
  }
}

async function batchDelete() {
  const ids = Array.from(selectedIds.value)
  if (ids.length === 0) return
  try {
    await ElMessageBox.confirm(
      $t('@WORKBENCH:确定要删除所选的 {count} 条日志吗？', { count: ids.length }),
      $t('@WORKBENCH:批量删除'),
      { type: 'warning' }
    )
  } catch { return }
  try {
    const res = await fetch('/api/workbench/jobs/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    }).then(r => r.json())
    if (!res.success) throw new Error(res.error || 'batch delete failed')
    ElMessage.success($t('@WORKBENCH:成功删除 {count} 条', { count: res.removed || ids.length }))
    selectedIds.value = new Set()
    await load()
  } catch (err) {
    ElMessage.error($t('@WORKBENCH:保存失败') + ': ' + errMsg(err))
  }
}

async function clearAll() {
  const count = stats.count
  if (count === 0) return
  try {
    await ElMessageBox.confirm(
      $t('@WORKBENCH:确定要清空所有 {count} 条执行日志吗？此操作不可恢复。', { count }),
      $t('@WORKBENCH:清空全部'),
      { type: 'warning', confirmButtonText: $t('@WORKBENCH:清空全部') }
    )
  } catch { return }
  try {
    const res = await fetch('/api/workbench/jobs/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }).then(r => r.json())
    if (!res.success) throw new Error(res.error || 'clear failed')
    ElMessage.success($t('@WORKBENCH:成功删除 {count} 条', { count: res.removed || count }))
    selectedIds.value = new Set()
    await load()
  } catch (err) {
    ElMessage.error($t('@WORKBENCH:保存失败') + ': ' + errMsg(err))
  }
}

// ── 格式化 ─────────────────────────────────────────────────────────
function formatDuration(start: string | null, end: string | null): string {
  if (!start) return ''
  const s = new Date(start).getTime()
  const e = end ? new Date(end).getTime() : Date.now()
  const ms = Math.max(0, e - s)
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`
}

// ── 启动 ────────────────────────────────────────────────────────────
onMounted(() => {
  load()
  loadConfig()
})
</script>

<style scoped>
.exec-logs {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px;
  height: 100%;
  overflow: auto;
}
.exec-logs__head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.exec-logs__title-block {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex: 1;
  min-width: 0;
}
.exec-logs__title {
  font-size: 18px;
  font-weight: 600;
  margin: 0;
  color: var(--text-primary);
}
.exec-logs__stats {
  font-size: 12px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.exec-logs__head-actions {
  display: inline-flex;
  gap: 8px;
  flex-shrink: 0;
}
.exec-logs__config {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 14px;
  background: var(--bg-subtle, var(--bg-container));
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md, 6px);
  flex-wrap: wrap;
}
.exec-logs__config-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}
.exec-logs__config-field {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.exec-logs__config-name {
  font-size: 12px;
  color: var(--text-tertiary);
}
.exec-logs__filter {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.exec-logs__filter-spacer { flex: 1; }
.exec-logs__batch-meta {
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.exec-logs__batch {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  background: color-mix(in srgb, var(--color-primary) 6%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-primary) 25%, transparent);
  border-radius: var(--radius-md, 6px);
}
.exec-logs__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
  min-height: 200px;
}
.exec-logs__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-md, 6px);
  color: var(--text-tertiary);
  text-align: center;
}
.exec-logs__empty-art {
  font-size: 36px;
  margin-bottom: 8px;
  opacity: 0.5;
}
.exec-logs__empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 4px;
}
.exec-logs__empty-hint {
  font-size: 12px;
  max-width: 400px;
}
.exec-logs__pager {
  display: flex;
  justify-content: center;
  padding-top: 8px;
}

/* 卡片 */
.exec-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  background: var(--bg-container);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md, 6px);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.exec-card:hover {
  border-color: var(--color-primary);
}
.exec-card.is-selected {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 1px var(--color-primary);
}
.exec-card__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.exec-card__status {
  display: inline-block;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid currentColor;
  border-radius: 999px;
  flex-shrink: 0;
}
.exec-card__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  max-width: 360px;
}
.exec-card__spacer { flex: 1; }
.exec-card__meta {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--text-tertiary);
  flex-wrap: wrap;
  flex-shrink: 0;
}
.exec-card__task { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
.exec-card__time { font-variant-numeric: tabular-nums; }
.exec-card__exit { font-family: var(--font-mono, ui-monospace, monospace); }
.exec-card__del {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  line-height: 1;
  color: var(--text-tertiary);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s, color 0.15s;
}
.exec-card__del:hover {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
}
.exec-card__error {
  margin: 0;
  padding: 6px 10px;
  font-size: 12px;
  color: #b91c1c;
  background: rgba(239, 68, 68, 0.06);
  border-left: 2px solid #ef4444;
  border-radius: 3px;
  font-family: var(--font-mono, ui-monospace, monospace);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>

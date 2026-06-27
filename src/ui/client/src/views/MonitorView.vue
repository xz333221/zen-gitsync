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
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { $t } from '@/lang/static'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Search } from '@element-plus/icons-vue'
import { useMonitorStore } from '@/stores/monitorStore'
import type { PortEntry } from '@/stores/monitorStore'

const store = useMonitorStore()

// 端口搜索
const portSearch = ref('')

// 端口排序：默认按端口升序
const sortField = ref<'port' | 'pid' | 'process'>('port')
const sortOrder = ref<'asc' | 'desc'>('asc')

function toggleSort(field: 'port' | 'pid' | 'process') {
  if (sortField.value === field) {
    sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortField.value = field
    sortOrder.value = 'asc'
  }
}

const filteredPorts = computed<PortEntry[]>(() => {
  let list = store.ports.slice()
  const q = portSearch.value.trim().toLowerCase()
  if (q) {
    list = list.filter((p) => {
      return (
        String(p.localPort).includes(q) ||
        String(p.pid).includes(q) ||
        (p.processName || '').toLowerCase().includes(q) ||
        (p.localAddress || '').toLowerCase().includes(q) ||
        (p.protocol || '').toLowerCase().includes(q) ||
        (p.state || '').toLowerCase().includes(q)
      )
    })
  }
  const dir = sortOrder.value === 'asc' ? 1 : -1
  list.sort((a, b) => {
    let av: number | string
    let bv: number | string
    if (sortField.value === 'port') {
      av = a.localPort
      bv = b.localPort
    } else if (sortField.value === 'pid') {
      av = Number(a.pid) || 0
      bv = Number(b.pid) || 0
    } else {
      av = (a.processName || '').toLowerCase()
      bv = (b.processName || '').toLowerCase()
    }
    if (av < bv) return -1 * dir
    if (av > bv) return 1 * dir
    return 0
  })
  return list
})

// ── 格式化工具 ──────────────────────────────────────────────────────────
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '-'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const parts: string[] = []
  if (d > 0) parts.push(`${d} ${$t('@MONITOR:天')}`)
  if (h > 0) parts.push(`${h} ${$t('@MONITOR:时')}`)
  if (m > 0) parts.push(`${m} ${$t('@MONITOR:分')}`)
  parts.push(`${s} ${$t('@MONITOR:秒')}`)
  return parts.join(' ')
}

// 数值到颜色的映射，给 el-progress 用
function usageColor(percent: number): string {
  if (percent >= 90) return 'var(--color-danger)'
  if (percent >= 70) return 'var(--color-warning)'
  return 'var(--color-success)'
}

// ── kill 进程 ────────────────────────────────────────────────────────────
const killingPids = ref<Set<string | number>>(new Set())

async function handleKill(port: PortEntry) {
  const pid = port.pid
  const procName = port.processName || $t('@MONITOR:未知进程')
  try {
    await ElMessageBox.confirm(
      $t('@MONITOR:确认终止进程提示')
        .replace('{pid}', String(pid))
        .replace('{process}', procName)
        .replace('{port}', String(port.localPort)),
      $t('@MONITOR:终止进程'),
      {
        confirmButtonText: $t('@MONITOR:终止'),
        cancelButtonText: $t('@MONITOR:取消'),
        type: 'warning'
      }
    )
  } catch {
    return // 用户取消
  }

  killingPids.value.add(pid)
  try {
    await store.killProcess(pid, true)
    ElMessage.success(
      $t('@MONITOR:已终止进程').replace('{pid}', String(pid))
    )
  } catch (e: any) {
    ElMessage.error(e?.message || $t('@MONITOR:终止进程失败'))
  } finally {
    killingPids.value.delete(pid)
  }
}

// ── 刷新控制 ────────────────────────────────────────────────────────────
function handleManualRefresh() {
  store.refresh().catch((e: any) => {
    ElMessage.error(e?.message || $t('@MONITOR:刷新失败'))
  })
}

function handleAutoRefreshChange(on: boolean) {
  store.setAutoRefresh(on)
}

function handleShowAllPortsChange(on: boolean) {
  store.setShowAllPorts(on)
}

// ── 生命周期 ────────────────────────────────────────────────────────────
onMounted(() => {
  store.startAutoRefresh()
})

onBeforeUnmount(() => {
  store.stopAutoRefresh()
})
</script>

<template>
  <div class="monitor-view">
    <!-- 顶部工具栏 -->
    <div class="monitor-toolbar">
      <div class="toolbar-title">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
        </svg>
        <span>{{ $t('@MONITOR:系统监控') }}</span>
        <span v-if="store.overview" class="toolbar-host">{{ store.overview.system.hostname }} · {{ store.overview.system.platform }}/{{ store.overview.system.arch }}</span>
      </div>
      <div class="toolbar-actions">
        <el-tooltip :content="$t('@MONITOR:显示所有连接')" placement="bottom">
          <el-switch
            :model-value="store.showAllPorts"
            @change="handleShowAllPortsChange"
            size="small"
          />
        </el-tooltip>
        <span class="toolbar-label">{{ $t('@MONITOR:全部连接') }}</span>
        <el-tooltip :content="$t('@MONITOR:自动刷新')" placement="bottom">
          <el-switch
            :model-value="store.autoRefresh"
            @change="handleAutoRefreshChange"
            size="small"
          />
        </el-tooltip>
        <span class="toolbar-label">{{ $t('@MONITOR:自动') }}</span>
        <el-button
          size="small"
          :icon="Refresh"
          :loading="store.loading"
          @click="handleManualRefresh"
        >
          {{ $t('@MONITOR:刷新') }}
        </el-button>
      </div>
    </div>

    <!-- KPI 卡片 -->
    <div class="monitor-cards" v-if="store.overview">
      <div class="metric-card">
        <div class="metric-card__header">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <rect x="9" y="9" width="6" height="6" />
            <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
          </svg>
          <span>{{ $t('@MONITOR:CPU 占用') }}</span>
        </div>
        <div class="metric-card__body">
          <div class="metric-value" :style="{ color: usageColor(store.overview.cpu.usage) }">
            {{ store.overview.cpu.usage.toFixed(1) }}<span class="metric-unit">%</span>
          </div>
          <div class="metric-sub">{{ store.overview.cpu.cores }} {{ $t('@MONITOR:核心') }}</div>
        </div>
        <el-progress
          :percentage="store.overview.cpu.usage"
          :stroke-width="6"
          :show-text="false"
          :color="usageColor(store.overview.cpu.usage)"
        />
        <div class="metric-card__footer" :title="store.overview.cpu.model">
          {{ store.overview.cpu.model }}
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-card__header">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="6" width="20" height="12" rx="2" />
            <path d="M6 10v4M10 10v4M14 10v4M18 10v4" />
          </svg>
          <span>{{ $t('@MONITOR:内存占用') }}</span>
        </div>
        <div class="metric-card__body">
          <div class="metric-value" :style="{ color: usageColor(store.overview.memory.usagePercent) }">
            {{ store.overview.memory.usagePercent.toFixed(1) }}<span class="metric-unit">%</span>
          </div>
          <div class="metric-sub">
            {{ formatBytes(store.overview.memory.used) }} / {{ formatBytes(store.overview.memory.total) }}
          </div>
        </div>
        <el-progress
          :percentage="store.overview.memory.usagePercent"
          :stroke-width="6"
          :show-text="false"
          :color="usageColor(store.overview.memory.usagePercent)"
        />
        <div class="metric-card__footer">
          {{ $t('@MONITOR:空闲') }} {{ formatBytes(store.overview.memory.free) }}
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-card__header">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <span>{{ $t('@MONITOR:系统运行时间') }}</span>
        </div>
        <div class="metric-card__body">
          <div class="metric-value">{{ formatUptime(store.overview.system.uptime) }}</div>
          <div class="metric-sub">{{ store.overview.system.nodeVersion }}</div>
        </div>
        <div class="metric-card__footer">
          {{ store.overview.system.hostname }}
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-card__header">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
          <span>{{ $t('@MONITOR:监听端口') }}</span>
        </div>
        <div class="metric-card__body">
          <div class="metric-value">{{ store.ports.length }}</div>
          <div class="metric-sub">
            {{ $t('@MONITOR:TCP') }} {{ store.ports.filter(p => p.protocol === 'TCP').length }} ·
            {{ $t('@MONITOR:UDP') }} {{ store.ports.filter(p => p.protocol === 'UDP').length }}
          </div>
        </div>
        <div class="metric-card__footer">
          {{ store.showAllPorts ? $t('@MONITOR:显示全部连接') : $t('@MONITOR:仅监听端口') }}
        </div>
      </div>
    </div>

    <!-- 加载占位 -->
    <div v-else-if="store.loading" class="monitor-placeholder">
      <el-icon class="is-loading"><Refresh /></el-icon>
      <span>{{ $t('@MONITOR:加载中') }}</span>
    </div>

    <!-- 错误提示 -->
    <div v-if="store.error && !store.overview" class="monitor-error">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span>{{ store.error }}</span>
      <el-button size="small" @click="handleManualRefresh">{{ $t('@MONITOR:重试') }}</el-button>
    </div>

    <!-- 端口列表 -->
    <div class="monitor-ports" v-if="store.overview">
      <div class="ports-header">
        <span class="ports-title">{{ $t('@MONITOR:端口占用列表') }}</span>
        <el-input
          v-model="portSearch"
          :placeholder="$t('@MONITOR:搜索端口 / PID / 进程名')"
          size="small"
          clearable
          class="ports-search"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
      </div>

      <div class="ports-table-wrap">
        <table class="ports-table">
          <thead>
            <tr>
              <th class="col-protocol">{{ $t('@MONITOR:协议') }}</th>
              <th class="col-address">{{ $t('@MONITOR:本地地址') }}</th>
              <th class="col-port sortable" @click="toggleSort('port')">
                {{ $t('@MONITOR:端口') }}
                <span class="sort-arrow" :class="{ active: sortField === 'port', desc: sortOrder === 'desc' }">↕</span>
              </th>
              <th class="col-state">{{ $t('@MONITOR:状态') }}</th>
              <th class="col-pid sortable" @click="toggleSort('pid')">
                PID
                <span class="sort-arrow" :class="{ active: sortField === 'pid', desc: sortOrder === 'desc' }">↕</span>
              </th>
              <th class="col-process sortable" @click="toggleSort('process')">
                {{ $t('@MONITOR:进程') }}
                <span class="sort-arrow" :class="{ active: sortField === 'process', desc: sortOrder === 'desc' }">↕</span>
              </th>
              <th class="col-action">{{ $t('@MONITOR:操作') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(p, idx) in filteredPorts" :key="`${p.protocol}-${p.localPort}-${p.pid}-${idx}`">
              <td class="col-protocol">
                <span class="proto-badge" :class="`proto-${p.protocol.toLowerCase()}`">{{ p.protocol }}</span>
              </td>
              <td class="col-address">{{ p.localAddress }}</td>
              <td class="col-port"><span class="port-num">{{ p.localPort }}</span></td>
              <td class="col-state">
                <span class="state-tag" :class="`state-${(p.state || 'unknown').toLowerCase()}`">
                  {{ p.state || '-' }}
                </span>
              </td>
              <td class="col-pid">{{ p.pid }}</td>
              <td class="col-process" :title="p.processName">{{ p.processName || $t('@MONITOR:未知') }}</td>
              <td class="col-action">
                <el-button
                  size="small"
                  type="danger"
                  plain
                  :loading="killingPids.has(p.pid)"
                  :disabled="killingPids.has(p.pid)"
                  @click="handleKill(p)"
                >
                  {{ $t('@MONITOR:终止') }}
                </el-button>
              </td>
            </tr>
            <tr v-if="filteredPorts.length === 0">
              <td colspan="7" class="ports-empty">
                {{ portSearch ? $t('@MONITOR:无匹配结果') : $t('@MONITOR:暂无端口占用') }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.monitor-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-page);
  overflow: hidden;
}

/* ── 顶部工具栏 ─────────────────────────────────────────────────────── */
.monitor-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: var(--bg-container);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.toolbar-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.toolbar-title svg {
  color: var(--color-primary);
}

.toolbar-host {
  margin-left: 8px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-tertiary);
  background: var(--bg-subtle);
  border-radius: var(--radius-pill);
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toolbar-label {
  font-size: 12px;
  color: var(--text-secondary);
  margin-right: 4px;
}

/* ── KPI 卡片 ───────────────────────────────────────────────────────── */
.monitor-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  padding: 12px 16px;
  flex-shrink: 0;
}

.metric-card {
  background: var(--bg-container);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-shadow: var(--shadow-sm);
  transition: box-shadow 0.18s ease, transform 0.18s ease;
}

.metric-card:hover {
  box-shadow: var(--shadow-md);
}

.metric-card__header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-tertiary);
}

.metric-card__header svg {
  color: var(--text-tertiary);
}

.metric-card__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.metric-value {
  font-size: 24px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.metric-unit {
  font-size: 14px;
  font-weight: 600;
  margin-left: 2px;
}

.metric-sub {
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.metric-card__footer {
  font-size: 11px;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── 占位 / 错误 ─────────────────────────────────────────────────────── */
.monitor-placeholder,
.monitor-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 60px 20px;
  color: var(--text-tertiary);
  font-size: 14px;
}

.monitor-error {
  color: var(--color-danger);
}

/* ── 端口列表 ───────────────────────────────────────────────────────── */
.monitor-ports {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-container);
  margin: 0 16px 16px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.ports-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-panel);
  flex-shrink: 0;
}

.ports-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.ports-search {
  width: 260px;
}

.ports-table-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.ports-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
  table-layout: fixed;
}

.ports-table thead {
  position: sticky;
  top: 0;
  background: var(--bg-container);
  z-index: 1;
}

.ports-table th {
  text-align: left;
  padding: 8px 12px;
  font-weight: 600;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-color);
  white-space: nowrap;
  user-select: none;
}

.ports-table th.sortable {
  cursor: pointer;
}

.ports-table th.sortable:hover {
  color: var(--color-primary);
}

.sort-arrow {
  display: inline-block;
  margin-left: 4px;
  opacity: 0.4;
  font-size: 11px;
  transition: opacity 0.15s ease;
}

.sort-arrow.active {
  opacity: 1;
  color: var(--color-primary);
}

.sort-arrow.active.desc::before {
  content: '↓';
}

.sort-arrow.active:not(.desc)::before {
  content: '↑';
}

.sort-arrow:not(.active)::before {
  content: '↕';
}

.ports-table td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  color: var(--text-primary);
  vertical-align: middle;
}

.ports-table tbody tr:hover {
  background: var(--bg-container-hover);
}

.ports-table tbody tr:last-child td {
  border-bottom: none;
}

/* 列宽 */
.col-protocol { width: 70px; }
.col-address { width: 30%; }
.col-port { width: 90px; }
.col-state { width: 110px; }
.col-pid { width: 80px; }
.col-process { width: auto; }
.col-action { width: 80px; text-align: right; }

/* 协议徽标 */
.proto-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
}

.proto-badge.proto-tcp {
  color: var(--color-primary-dark);
  background: var(--tint-primary-12);
}

.proto-badge.proto-udp {
  color: var(--color-warning-dark);
  background: var(--tint-warning-14);
}

.proto-badge.proto-tcp6 {
  color: var(--color-info);
  background: var(--tint-info-12);
}

/* 端口号：等宽 */
.port-num {
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--color-primary);
}

/* 状态标签 */
.state-tag {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 600;
  border-radius: var(--radius-sm);
  letter-spacing: 0.3px;
}

.state-tag.state-listening,
.state-tag.state-listen {
  color: var(--color-success-dark);
  background: var(--tint-success-14);
}

.state-tag.state-established {
  color: var(--color-primary-dark);
  background: var(--tint-primary-12);
}

.state-tag.state-time_wait,
.state-tag.state-close_wait,
.state-tag.state-closing {
  color: var(--text-tertiary);
  background: var(--bg-subtle);
}

.state-tag.state-unknown,
.state-tag.state- {
  color: var(--text-tertiary);
  background: var(--bg-subtle);
}

.ports-empty {
  text-align: center;
  padding: 40px 12px;
  color: var(--text-tertiary);
  font-size: 13px;
}

/* ── 响应式 ─────────────────────────────────────────────────────────── */
@media (max-width: 1100px) {
  .monitor-cards {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 720px) {
  .monitor-cards {
    grid-template-columns: 1fr;
  }
  .ports-search {
    width: 160px;
  }
}
</style>

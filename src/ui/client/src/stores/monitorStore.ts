// Copyright 2026 xz333221
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// 系统监控 store：管理 CPU/内存/端口数据，以及自动轮询。
// MonitorView 在 onMounted 启动轮询、onBeforeUnmount 停止轮询。
// kill 进程后立即触发一次刷新，让 UI 反馈及时。

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface CpuInfo {
  usage: number
  cores: number
  model: string
  loadAvg: number[]
}

export interface MemoryInfo {
  total: number
  free: number
  used: number
  usagePercent: number
}

export interface SystemInfo {
  platform: string
  arch: string
  hostname: string
  uptime: number
  nodeVersion: string
}

export interface SystemOverview {
  cpu: CpuInfo
  memory: MemoryInfo
  system: SystemInfo
  timestamp: number
}

export interface PortEntry {
  protocol: string
  localAddress: string
  localPort: number
  state: string
  pid: number | string
  processName: string
}

const DEFAULT_REFRESH_INTERVAL = 3000

export const useMonitorStore = defineStore('monitor', () => {
  const overview = ref<SystemOverview | null>(null)
  const ports = ref<PortEntry[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  // 自动刷新
  const autoRefresh = ref(true)
  const refreshInterval = ref(DEFAULT_REFRESH_INTERVAL)
  let timer: number | null = null

  // 是否显示所有端口（含 ESTABLISHED 外网连接）
  const showAllPorts = ref(false)

  const hasData = computed(() => overview.value !== null)

  async function fetchSystem() {
    try {
      const res = await fetch('/api/monitor/system')
      const json = await res.json()
      if (json.success) {
        overview.value = json.data
        error.value = null
      } else {
        error.value = json.error || '获取系统信息失败'
      }
    } catch (e: any) {
      error.value = e?.message || String(e)
    }
  }

  async function fetchPorts() {
    try {
      const url = showAllPorts.value
        ? '/api/monitor/ports?all=1'
        : '/api/monitor/ports'
      const res = await fetch(url)
      const json = await res.json()
      if (json.success) {
        ports.value = json.data || []
        error.value = null
      } else {
        error.value = json.error || '获取端口列表失败'
      }
    } catch (e: any) {
      error.value = e?.message || String(e)
    }
  }

  // 一次性刷新：并发拉取 system + ports
  async function refresh() {
    if (loading.value) return
    loading.value = true
    try {
      await Promise.all([fetchSystem(), fetchPorts()])
    } finally {
      loading.value = false
    }
  }

  async function killProcess(pid: number | string, force = false) {
    const res = await fetch('/api/monitor/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid, force })
    })
    const json = await res.json()
    if (!json.success) {
      throw new Error(json.error || '终止进程失败')
    }
    // kill 成功后立即刷新端口列表
    await fetchPorts()
    return json
  }

  function startAutoRefresh() {
    stopAutoRefresh()
    if (autoRefresh.value) {
      // 立即拉一次，再启动定时器
      refresh().catch(() => {})
      timer = window.setInterval(() => {
        refresh().catch(() => {})
      }, refreshInterval.value)
    }
  }

  function stopAutoRefresh() {
    if (timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
  }

  function setAutoRefresh(on: boolean) {
    autoRefresh.value = on
    if (on) {
      startAutoRefresh()
    } else {
      stopAutoRefresh()
    }
  }

  function setShowAllPorts(on: boolean) {
    showAllPorts.value = on
    if (autoRefresh.value) {
      fetchPorts().catch(() => {})
    }
  }

  return {
    overview,
    ports,
    loading,
    error,
    autoRefresh,
    refreshInterval,
    showAllPorts,
    hasData,
    fetchSystem,
    fetchPorts,
    refresh,
    killProcess,
    startAutoRefresh,
    stopAutoRefresh,
    setAutoRefresh,
    setShowAllPorts
  }
})

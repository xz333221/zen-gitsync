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
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { io, Socket } from 'socket.io-client'
import type { InstanceInfo, InstancesResponse } from '@/types/instances'

// 与 gitStore 同款后端端口探测：开发环境从 VITE_BACKEND_PORT 读，生产从 window.location
function getBackendPort(): number {
  const currentPort = window.location.port || '80'

  // 开发环境：5173 / 4173 / 5544 视为 Vite dev server
  if (currentPort === '5173' || currentPort === '4173' || currentPort === '5544') {
    const envPort = import.meta.env.VITE_BACKEND_PORT
    if (envPort) return parseInt(envPort, 10)
    return 3000
  }

  return parseInt(currentPort, 10)
}

const backendPort = getBackendPort()
const POLL_INTERVAL_MS = 15_000

export const useInstancesStore = defineStore('instances', () => {
  // 状态
  const list = ref<InstanceInfo[]>([])
  const currentInstanceId = ref<number | null>(null)
  const socketRef = ref<Socket | null>(null)
  const lastError = ref<string | null>(null)

  // 计算属性
  const currentInstance = computed<InstanceInfo | null>(() => {
    if (currentInstanceId.value == null) return null
    return list.value.find((i) => i.pid === currentInstanceId.value) ?? null
  })

  const otherInstances = computed<InstanceInfo[]>(() => {
    if (currentInstanceId.value == null) return list.value
    return list.value.filter((i) => i.pid !== currentInstanceId.value)
  })

  // 从后端拉取最新列表
  async function refresh() {
    try {
      const res = await fetch('/api/instances')
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const data = (await res.json()) as InstancesResponse | { success: false; error: string }
      if (data && 'success' in data && data.success) {
        list.value = data.instances
        currentInstanceId.value = data.currentInstanceId
        lastError.value = null
      } else {
        lastError.value = ('error' in data && data.error) || '未知错误'
      }
    } catch (e) {
      // 后端未启动等情况，静默忽略，不打扰用户
      lastError.value = (e as Error).message
    }
  }

  // 监听后端 Socket.IO 推送
  function attachSocket() {
    if (socketRef.value) return
    const url = `http://localhost:${backendPort}`
    const s = io(url, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      reconnectionAttempts: Infinity,
      timeout: 20000,
      forceNew: true
    })
    socketRef.value = s
    s.on('instances_changed', (payload: { instances: InstanceInfo[] }) => {
      if (payload && Array.isArray(payload.instances)) {
        list.value = payload.instances
      }
    })
  }

  function detachSocket() {
    if (socketRef.value) {
      try { socketRef.value.off('instances_changed') } catch (_) {}
      try { socketRef.value.disconnect() } catch (_) {}
      socketRef.value = null
    }
  }

  // 启动：拉一次 + 15 秒轮询 + 接 socket
  function start() {
    refresh()
    attachSocket()
    pollTimer = window.setInterval(() => { refresh() }, POLL_INTERVAL_MS)
  }

  function stop() {
    detachSocket()
    if (pollTimer != null) {
      window.clearInterval(pollTimer)
      pollTimer = null
    }
  }

  let pollTimer: number | null = null

  return {
    list,
    currentInstanceId,
    currentInstance,
    otherInstances,
    lastError,
    refresh,
    start,
    stop
  }
})

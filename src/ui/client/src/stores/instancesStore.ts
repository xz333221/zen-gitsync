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
import { getBackendPort } from '@/utils/backendUrl'

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
    schedulePoll()
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  function stop() {
    detachSocket()
    cancelPoll()
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }

  // 轮询由 visibility 控制:页面可见时 15s 兜底轮询(兼容 Windows fs.watch 跨进程不可靠),
  // 失焦时停掉以省请求;重新聚焦时立即拉一次保证数据是新的
  function schedulePoll() {
    cancelPoll()
    if (typeof document !== 'undefined' && document.hidden) return
    pollTimer = window.setInterval(() => { refresh() }, POLL_INTERVAL_MS)
  }

  function cancelPoll() {
    if (pollTimer != null) {
      window.clearInterval(pollTimer)
      pollTimer = null
    }
  }

  function onVisibilityChange() {
    if (document.hidden) {
      cancelPoll()
    } else {
      refresh()        // 切回前台立即拉一次,补齐失焦期间可能错过的变化
      schedulePoll()   // 恢复 15s 兜底轮询
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

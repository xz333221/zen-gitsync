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
// 回归测试:实例 socket 上的服务端生命周期信号接线。
// 守两点——(1) server_shutdown/disconnect/connect 都接到了 useServerLifecycle；
// (2) 我们自己调 disconnect() 造成的 'io client disconnect' 绝不能触发关页判定。
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { InstanceInfo } from '@/types/instances'

type Handler = (...args: any[]) => void

const { fakeSocket, handlers, lifecycleMock } = vi.hoisted(() => {
  const handlers = new Map<string, Handler>()
  const fakeSocket: any = {
    on: vi.fn((event: string, cb: Handler) => { handlers.set(event, cb); return fakeSocket }),
    off: vi.fn((event: string) => { handlers.delete(event); return fakeSocket }),
    disconnect: vi.fn(() => fakeSocket),
  }
  const lifecycleMock = {
    armGraceful: vi.fn(),
    armDisconnect: vi.fn(),
    noteConnected: vi.fn(),
    cancel: vi.fn(),
    resetAll: vi.fn(),
  }
  return { fakeSocket, handlers, lifecycleMock }
})

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => fakeSocket),
  Socket: class {},
}))

vi.mock('@/composables/useServerLifecycle', () => ({
  useServerLifecycle: () => lifecycleMock,
}))

import { useInstancesStore } from './instancesStore'

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeInstance(pid: number, projectName: string): InstanceInfo {
  return {
    pid,
    port: 5800 + pid - 100,
    projectName,
    projectPath: `D:\\fake\\${projectName}`,
    startedAt: 0,
    lastHeartbeat: 0,
    hostname: 'test-host',
  }
}

describe('instancesStore 服务端生命周期接线', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    handlers.clear()
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: true, instances: [], currentInstanceId: 100 })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('start() 注册四个事件处理器', () => {
    const store = useInstancesStore()
    store.start()
    try {
      expect([...handlers.keys()].sort()).toEqual(
        ['connect', 'disconnect', 'instances_changed', 'server_shutdown'].sort(),
      )
    } finally {
      store.stop()
    }
  })

  test("server_shutdown: 只处理本实例(pid 匹配 currentInstanceId)", () => {
    const store = useInstancesStore()
    store.start()
    try {
      store.list = [makeInstance(100, 'self')]
      store.currentInstanceId = 100

      handlers.get('server_shutdown')!({ pid: 100, signal: 'SIGTERM' })
      expect(lifecycleMock.armGraceful).toHaveBeenCalledTimes(1)
      expect(lifecycleMock.armGraceful).toHaveBeenCalledWith({ pid: 100, name: 'self' })

      // 别的实例退出与本页无关
      lifecycleMock.armGraceful.mockClear()
      handlers.get('server_shutdown')!({ pid: 999, signal: 'SIGTERM' })
      expect(lifecycleMock.armGraceful).not.toHaveBeenCalled()
    } finally {
      store.stop()
    }
  })

  test("disconnect: 'io client disconnect'(我们主动断开)不触发判定", () => {
    const store = useInstancesStore()
    store.start()
    try {
      store.list = [makeInstance(100, 'self')]
      store.currentInstanceId = 100

      handlers.get('disconnect')!('io client disconnect')
      expect(lifecycleMock.armDisconnect).not.toHaveBeenCalled()

      handlers.get('disconnect')!('transport close')
      expect(lifecycleMock.armDisconnect).toHaveBeenCalledWith({ pid: 100, name: 'self' })
    } finally {
      store.stop()
    }
  })

  test('connect: 通知 composable 取消判定', () => {
    const store = useInstancesStore()
    store.start()
    try {
      handlers.get('connect')!()
      expect(lifecycleMock.noteConnected).toHaveBeenCalledTimes(1)
    } finally {
      store.stop()
    }
  })

  test('detachSocket/stop: 解绑四个事件并断开连接', () => {
    const store = useInstancesStore()
    store.start()
    store.stop()

    const offEvents = fakeSocket.off.mock.calls.map(([event]: [string]) => event)
    expect(offEvents).toEqual(
      expect.arrayContaining(['instances_changed', 'server_shutdown', 'disconnect', 'connect']),
    )
    expect(fakeSocket.disconnect).toHaveBeenCalled()
  })
})

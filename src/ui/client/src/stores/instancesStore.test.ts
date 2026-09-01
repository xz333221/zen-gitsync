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
// 回归测试:closeInstance 现在允许关闭当前实例(此前有 "不能关闭当前实例" 硬编码,
// 锁死了 UI 上给当前实例加关闭按钮的方案)。
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useInstancesStore } from './instancesStore'
import type { InstanceInfo } from '@/types/instances'

function stubFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => responder(url, init)))
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// 构造一个最小可用的 InstanceInfo,测试只关心 pid/port/projectName。
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

describe('instancesStore.closeInstance', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('回归:关闭当前实例不再 throw,而是正常调后端并从 list 过滤', async () => {
    // 旧实现:`if (pid === currentInstanceId.value) throw new Error('不能关闭当前实例')`
    // 直接阻断 UI 给当前实例加关闭按钮。新实现放开了这个限制。
    stubFetch((url) => {
      if (url === '/api/instances/100/close') {
        return jsonResponse({ success: true, closedPid: 100, selfClose: true })
      }
      return jsonResponse({})
    })
    const store = useInstancesStore()
    store.currentInstanceId = 100
    store.list = [makeInstance(100, 'self')]

    await expect(store.closeInstance(100)).resolves.toBeUndefined()
    expect(store.list.find((i) => i.pid === 100)).toBeUndefined()
  })

  test('关闭当前实例的 fetch 调用是正确的 POST /api/instances/<pid>/close', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ success: true, closedPid: 100, selfClose: true }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const store = useInstancesStore()
    store.currentInstanceId = 100

    await store.closeInstance(100)

    const closeCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/close'))
    expect(closeCalls).toHaveLength(1)
    expect(closeCalls[0][0]).toBe('/api/instances/100/close')
    const init = closeCalls[0][1] as RequestInit | undefined
    expect(init?.method).toBe('POST')
  })

  test('关闭其他实例仍正常工作,只过滤目标 pid', async () => {
    stubFetch((url) => {
      if (url === '/api/instances/200/close') {
        return jsonResponse({ success: true, closedPid: 200, selfClose: false })
      }
      return jsonResponse({})
    })
    const store = useInstancesStore()
    store.currentInstanceId = 100
    store.list = [makeInstance(100, 'self'), makeInstance(200, 'other')]

    await store.closeInstance(200)

    expect(store.list.map((i) => i.pid)).toEqual([100])
  })

  test('关闭失败:后端 success=false 时抛错,list 保持不变', async () => {
    stubFetch((url) => {
      if (url === '/api/instances/100/close') {
        return jsonResponse({ success: false, error: '实例不存在或已经关闭' }, 404)
      }
      return jsonResponse({})
    })
    const store = useInstancesStore()
    store.currentInstanceId = 100
    store.list = [makeInstance(100, 'self')]

    await expect(store.closeInstance(100)).rejects.toThrow(/不存在/)
    expect(store.list.map((i) => i.pid)).toEqual([100])
  })

  test('PID 无效(<=0 或非整数)时抛错,不调 fetch', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}))
    vi.stubGlobal('fetch', fetchMock)
    const store = useInstancesStore()

    await expect(store.closeInstance(0)).rejects.toThrow(/PID 无效/)
    await expect(store.closeInstance(-1)).rejects.toThrow(/PID 无效/)
    await expect(store.closeInstance(1.5)).rejects.toThrow(/PID 无效/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
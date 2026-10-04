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
// 左栏「工作台」角标的数字来源：useOrchestrator 拉到服务端的 running 数组后写进
// useWorkbenchStatusStore。守的是「角标 = 看板表头那个活跃执行数」这条线。
//
// 它曾经是客户端自己从本地 jobs 数组里数 `status === 'running'` —— 那个口径
// 漏 pending、漏别的 g ui 实例起的 job，于是同一个界面里左栏 2 / 表头 3。
// 所以这里的断言不看 jobs，只看服务端下发的 running 里有什么。

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createTestPinia } from '@/test-utils/createTestPinia'
import { useWorkbenchStatusStore } from '@/stores/workbenchStatus'

vi.mock('@/lang/static', () => ({ $t: (key: string) => key }))

import { useOrchestrator } from './useOrchestrator'

/** 造一个 /api/workbench/orchestrator 的最小响应 */
function payload(running: Array<{ status: string }>) {
  return { success: true, active: true, running }
}

function stubFetch(body: unknown, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({
    json: async () => body,
  })
  if (!ok) fetchMock.mockRejectedValue(new Error('network down'))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('useOrchestrator → 工作台角标', () => {
  beforeEach(() => {
    createTestPinia()
    vi.unstubAllGlobals()
  })

  test('角标数 = 服务端 running 数组的长度（running 与 pending 都算）', async () => {
    stubFetch(payload([{ status: 'running' }, { status: 'pending' }, { status: 'running' }]))
    const store = useWorkbenchStatusStore()
    expect(store.runningCount).toBe(0)

    await useOrchestrator().loadOrchestrator()

    // pending 也算 —— 这正是它和"本地数 running"的差别所在
    expect(store.runningCount).toBe(3)
  })

  test('别的实例正在跑的 job 由服务端带下来，前端照收（不看本地 jobs）', async () => {
    stubFetch(payload([{ status: 'running' }]))
    const store = useWorkbenchStatusStore()

    await useOrchestrator().loadOrchestrator()

    expect(store.runningCount).toBe(1)
  })

  test('全部跑完时归零（角标随之消失）', async () => {
    const store = useWorkbenchStatusStore()
    stubFetch(payload([{ status: 'running' }]))
    const orch = useOrchestrator()
    await orch.loadOrchestrator()
    expect(store.runningCount).toBe(1)

    stubFetch(payload([]))
    await orch.loadOrchestrator()
    expect(store.runningCount).toBe(0)
  })

  test('请求失败不清零：保留上一次的值，别把角标闪没', async () => {
    const store = useWorkbenchStatusStore()
    stubFetch(payload([{ status: 'running' }, { status: 'pending' }]))
    const orch = useOrchestrator()
    await orch.loadOrchestrator()
    expect(store.runningCount).toBe(2)

    stubFetch(null, false)
    await expect(orch.loadOrchestrator(true)).resolves.toBe(false)
    expect(store.runningCount).toBe(2)
  })

  test('响应里没有 running 字段（老服务端）时按 0 处理，不抛', async () => {
    stubFetch({ success: true, active: true })
    const store = useWorkbenchStatusStore()

    await expect(useOrchestrator().loadOrchestrator()).resolves.toBe(true)
    expect(store.runningCount).toBe(0)
  })
})

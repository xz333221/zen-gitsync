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
// 回归测试:服务端退出后的确认窗口。
// 这里守的核心是「不能误关」——dev 后端热重启、网络抖动、我们自己调 disconnect()
// 都不能把标签页关掉;只有连续探针失败才判定服务端真的走了。
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useServerLifecycle } from './useServerLifecycle'

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// 探针成功：返回指定 pid 的健康响应
function healthy(pid: number) {
  return vi.fn(async () => jsonResponse({ success: true, pid }))
}

// 探针失败：模拟连接被拒(fetch reject)
function refused() {
  return vi.fn(async () => { throw new TypeError('Failed to fetch') })
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('useServerLifecycle', () => {
  let closeSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', { onLine: true })
    closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
    useServerLifecycle().resetAll()
  })

  afterEach(() => {
    useServerLifecycle().resetAll()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    closeSpy.mockRestore()
  })

  test('SC-01 优雅关闭：连续探针失败到阈值 → window.close 并亮遮罩', async () => {
    vi.stubGlobal('fetch', refused())
    const lc = useServerLifecycle()

    lc.armGraceful({ pid: 100, name: 'zen-gitsync' })
    // 第 1 次探针立刻发；随后每 1s 一次，第 4 次失败达到阈值
    await advance(3100)

    expect(closeSpy).toHaveBeenCalledTimes(1)
    expect(lc.isServerGone.value).toBe(false) // 遮罩要等 250ms 兜底窗口

    await advance(250)
    expect(lc.isServerGone.value).toBe(true)
    expect(lc.serverGoneName.value).toBe('zen-gitsync')
  })

  test('SC-02 dev 热重启不误关：探到不同 pid 即取消', async () => {
    // 先失败 2 次(旧进程正在退出)，随后新进程(pid=200)起来
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1
      if (n <= 2) throw new TypeError('Failed to fetch')
      return jsonResponse({ success: true, pid: 200 })
    }))
    const lc = useServerLifecycle()

    lc.armGraceful({ pid: 100, name: 'zen-gitsync' })
    await advance(2100)
    expect(closeSpy).not.toHaveBeenCalled()

    // 继续跑满整个窗口，也不应该关
    await advance(9000)
    expect(closeSpy).not.toHaveBeenCalled()
    expect(lc.isServerGone.value).toBe(false)
  })

  test('SC-03 同 pid 的 200 探针：广播来源继续等 drain，断连来源判定为误报', async () => {
    // (a) 广播来源：服务端仍活着(同一 pid)，说明还在 drain → 不能取消，也不能关
    vi.stubGlobal('fetch', healthy(100))
    const lc = useServerLifecycle()
    lc.armGraceful({ pid: 100, name: 'self' })
    await advance(2100)
    expect(closeSpy).not.toHaveBeenCalled()
    expect(lc.isServerGone.value).toBe(false)
    lc.cancel()

    // (b) 断连来源：服务端还活着(同一 pid) → 是抖动/误报，取消
    lc.armDisconnect({ pid: 100, name: 'self' })
    await advance(1100)
    expect(closeSpy).not.toHaveBeenCalled()
    // 取消后即便继续失败也不该再关
    vi.stubGlobal('fetch', refused())
    await advance(9000)
    expect(closeSpy).not.toHaveBeenCalled()
  })

  test('SC-04 socket 重新连上(connect) → 取消判定', async () => {
    vi.stubGlobal('fetch', refused())
    const lc = useServerLifecycle()

    lc.armDisconnect({ pid: 100, name: 'self' })
    await advance(2100) // 累积 2~3 次失败

    lc.noteConnected()
    await advance(9000)
    expect(closeSpy).not.toHaveBeenCalled()
    expect(lc.isServerGone.value).toBe(false)
  })

  test('SC-05 armDisconnect 重复触发 → 幂等，只有一套定时器', async () => {
    vi.stubGlobal('fetch', refused())
    const lc = useServerLifecycle()

    lc.armDisconnect({ pid: 100, name: 'self' })
    lc.armDisconnect({ pid: 100, name: 'self' }) // transport close + transport error

    await advance(3100)
    // 若不幂等会出现两套探针，失败计数翻倍，提前关页
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  test('SC-06 探针命中 /api/instance-health 且带 AbortSignal', async () => {
    const fetchMock = healthy(100)
    vi.stubGlobal('fetch', fetchMock)
    const lc = useServerLifecycle()

    lc.armGraceful({ pid: 100, name: 'self' })
    await advance(0)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/instance-health')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.cache).toBe('no-store')
  })

  test('SC-07 判定后 cancel 不清除已亮起的遮罩', async () => {
    vi.stubGlobal('fetch', refused())
    const lc = useServerLifecycle()

    lc.armGraceful({ pid: 100, name: 'self' })
    await advance(3100)
    await advance(250)
    expect(lc.isServerGone.value).toBe(true)

    lc.cancel()
    expect(lc.isServerGone.value).toBe(true)
  })

  test('SC-08 offline 时不计失败，不会在断网期间关页面', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    vi.stubGlobal('fetch', refused())
    const lc = useServerLifecycle()

    lc.armDisconnect({ pid: 100, name: 'self' })
    await advance(9000)
    expect(closeSpy).not.toHaveBeenCalled()
    // 重新联网(online 事件清零失败计数)后仍需重新累积 4 次失败
    vi.stubGlobal('navigator', { onLine: true })
    window.dispatchEvent(new Event('online'))
    await advance(4300)
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })
})

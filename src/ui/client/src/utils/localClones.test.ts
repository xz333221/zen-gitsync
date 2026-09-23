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
// utils/localClones.ts 单测:归一化匹配、失败降级、请求去重与 TTL、
// 以及「服务端首扫还没完 → 隔几秒再问」这条轮询。
//
// 这里钉的是**模块级**行为(缓存 / in-flight 去重),它们放在组件里会随 Tab
// 切换重建 —— 那正是必须放独立模块的理由,所以断言也写在模块这一层。
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

import { loadLocalClones, resetLocalClones, rescanLocalClones } from './localClones'

/** 服务端 GET /api/local-repos 的响应：(仓库目录 → origin 地址) */
const jsonRes = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

const snap = (repos: Record<string, string>, extra: Record<string, unknown> = {}) =>
  jsonRes({ success: true, scanning: false, scannedAt: 1, repos, ...extra })

beforeEach(() => {
  // 模块级缓存,不重置会串到下一个用例(与 remoteReposCache 同一个理由)
  resetLocalClones()
  vi.useRealTimers()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('loadLocalClones', () => {
  test('本地 origin 归一化成 host/owner/repo,SSH 与 HTTPS 两种写法都认', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      snap({
        'D:/workspace/github_workspace/zen-gitsync': 'git@github.com:xz333221/zen-gitsync.git',
        'D:/workspace/gitee_workspace/xiangqi': 'https://gitee.com/xz_web/xiangqi.git',
      }),
    )

    const map = await loadLocalClones()
    expect(spy.mock.calls[0][0]).toBe('/api/local-repos')
    expect(map).toEqual({
      'github.com/xz333221/zen-gitsync': 'D:/workspace/github_workspace/zen-gitsync',
      'gitee.com/xz_web/xiangqi': 'D:/workspace/gitee_workspace/xiangqi',
    })
  })

  test('同一个仓库克隆在多个目录时,以先出现的那个为准;解析不出的地址丢掉', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      snap({
        'D:/first': 'git@gitee.com:xz_web/xiangqi.git',
        'D:/second': 'https://gitee.com/xz_web/xiangqi',
        // 不是仓库地址 → 丢弃,不能凭半个地址去误配
        'D:/junk': 'not-a-url',
      }),
    )

    expect(await loadLocalClones()).toEqual({ 'gitee.com/xz_web/xiangqi': 'D:/first' })
  })

  test('拿不到数据(旧服务端回 HTML / 网络失败)一律回空对象,不抛错', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<!DOCTYPE html><html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    )
    await expect(loadLocalClones()).resolves.toEqual({})

    vi.restoreAllMocks()
    resetLocalClones()
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    await expect(loadLocalClones()).resolves.toEqual({})
  })

  test('TTL 内只请求一次,两个 Tab 同时挂载也只发一个请求', async () => {
    // 工厂而非 mockResolvedValue:两次调用要能各自读 body(Response 是一次性的)
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => snap({}))

    // 并发调用 = App.vue 里两个仓库面板同时 onMounted
    await Promise.all([loadLocalClones(), loadLocalClones()])
    expect(spy).toHaveBeenCalledTimes(1)

    // 缓存还新鲜:再来一次也不发请求
    await loadLocalClones()
    expect(spy).toHaveBeenCalledTimes(1)

    // force 绕过缓存(留给"用户刚克隆完想看结果"的场景)
    await loadLocalClones(true)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  test('首次运行还在扫(scanning 且空)→ 隔一会儿再问,扫完就定稿', async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(snap({}, { scanning: true }))
      .mockResolvedValueOnce(snap({}, { scanning: true }))
      .mockResolvedValueOnce(snap({ 'D:/w/zen': 'git@github.com:xz333221/zen-gitsync.git' }))

    const pending = loadLocalClones()
    // 每次重试之间必须让出事件循环,把 sleep 推过去
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(3_000)

    expect(await pending).toEqual({ 'github.com/xz333221/zen-gitsync': 'D:/w/zen' })
    expect(spy).toHaveBeenCalledTimes(3)
  })

  test('还在扫但服务端已有旧快照 → 先用着,不让用户干等', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      snap({ 'D:/old/zen': 'git@github.com:xz333221/zen-gitsync.git' }, { scanning: true }),
    )

    // 一次请求就返回:非首次运行时不该因为"正在重扫"而空手而归
    expect(await loadLocalClones()).toEqual({ 'github.com/xz333221/zen-gitsync': 'D:/old/zen' })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  test('一直扫不完也回最后一次拿到的(空)结果,不无限轮询', async () => {
    vi.useFakeTimers()
    // 用工厂而不是 mockResolvedValue:同一个 Response 的 body 只能读一次,
    // 复用会让第二次 res.json() 直接 reject,轮询就"提前结束"了(踩过)
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => snap({}, { scanning: true }),
    )

    const pending = loadLocalClones()
    await vi.advanceTimersByTimeAsync(3_000 * 8)

    await expect(pending).resolves.toEqual({})
    // MAX_RETRIES = 8
    expect(spy).toHaveBeenCalledTimes(8)
  })
})

describe('rescanLocalClones', () => {
  /** 按 URL + method 分派的 fetch 替身;`gets` 记录 GET 次数 */
  function stubScan({ scanFails = false, staleRounds = 1, stale, fresh }: {
    scanFails?: boolean
    staleRounds?: number
    stale: Record<string, string>
    fresh: Record<string, string>
  }) {
    const seen: string[] = []
    let gets = 0
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const url = typeof input === 'string' ? input : input.url
      seen.push(`${init?.method || 'GET'} ${url}`)
      if (url.endsWith('/api/local-repos/scan')) {
        if (scanFails) throw new Error('404')
        return jsonRes({ success: true, started: true })
      }
      gets += 1
      return gets <= staleRounds
        ? snap(stale, { scanning: true })
        : snap(fresh, { scanning: false })
    })
    return { spy, seen, gets: () => gets }
  }

  test('先 POST /scan,再等到扫完才回结果 —— 绝不把重扫前的旧快照当答案', async () => {
    vi.useFakeTimers()
    const { seen, gets } = stubScan({
      stale: { 'D:/old/xiangqi': 'git@gitee.com:xz_web/xiangqi.git' },
      fresh: { 'D:/new/zen': 'git@github.com:xz333221/zen-gitsync.git' },
    })

    const pending = rescanLocalClones()
    // 第一趟 GET 时服务端还在扫(旧快照里只有 xiangqi)—— 不能就此收工
    await vi.advanceTimersByTimeAsync(3_000)

    await expect(pending).resolves.toEqual({ 'github.com/xz333221/zen-gitsync': 'D:/new/zen' })
    expect(gets()).toBe(2)
    // 顺序必须是"先踢重扫,再取快照" —— 反了就等于取的是重扫前的值
    expect(seen[0]).toBe('POST /api/local-repos/scan')
    expect(seen[1]).toBe('GET /api/local-repos')
  })

  test('重扫接口不存在(旧服务端)时静默降级成只重取快照,不抛错', async () => {
    const { seen } = stubScan({
      scanFails: true,
      staleRounds: 0,
      stale: {},
      fresh: { 'D:/new/zen': 'git@github.com:xz333221/zen-gitsync.git' },
    })

    await expect(rescanLocalClones()).resolves.toEqual({
      'github.com/xz333221/zen-gitsync': 'D:/new/zen',
    })
    expect(seen[0]).toBe('POST /api/local-repos/scan')
  })

  test('一直扫不完时不无限轮询,回最后一次拿到的快照', async () => {
    vi.useFakeTimers()
    const { gets } = stubScan({
      staleRounds: Number.MAX_SAFE_INTEGER,
      stale: { 'D:/old/xiangqi': 'git@gitee.com:xz_web/xiangqi.git' },
      fresh: {},
    })

    const pending = rescanLocalClones()
    await vi.advanceTimersByTimeAsync(3_000 * 8)

    await expect(pending).resolves.toEqual({ 'gitee.com/xz_web/xiangqi': 'D:/old/xiangqi' })
    // MAX_RETRIES = 8
    expect(gets()).toBe(8)
  })
})

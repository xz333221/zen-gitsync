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
// 回归测试:Git 用户信息(user.name / user.email)的读取与回填。
//
// 背景:user.name / user.email 是用户级/全局属性,与"当前目录是否为 Git
// 仓库"无关。但调用方曾把它锁在 isGitRepo 分支里,导致打开非 Git 仓库
// 目录时 userName 停留在初始空串,右上角误报"未配置"。
// 本文件锁定两件事:
//   1. getUserInfo() 自身不依赖 isGitRepo,且缺项时如实回填已有那一项;
//   2. $reset() 确实会清空用户信息 —— 这正是切目录后必须重拉的缘由。
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useGitStore } from './gitStore'

function stubUserInfo(payload: unknown, { fail = false }: { fail?: boolean } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/user-info') {
      if (fail) throw new Error('network down')
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  }))
}

describe('gitStore.getUserInfo', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('name 与 email 齐全时都回填', async () => {
    stubUserInfo({ name: 'xuze', email: '569552263@qq.com' })
    const store = useGitStore()

    await store.getUserInfo()

    expect(store.userName).toBe('xuze')
    expect(store.userEmail).toBe('569552263@qq.com')
  })

  test('回归:只配了 name 没配 email 时,name 仍应显示', async () => {
    // 旧实现是 `if (data.name && data.email)` —— 任一项缺失就整体不赋值,
    // 已配好的 name 被一起吞掉,UI 反而误报"未配置"。只配 name 是很常见的
    // 状态,必须能正常显示,由 UI 侧 (!userName || !userEmail) 决定提示。
    stubUserInfo({ name: 'xuze', email: '' })
    const store = useGitStore()

    await store.getUserInfo()

    expect(store.userName).toBe('xuze')
    expect(store.userEmail).toBe('')
  })

  test('回归:只配了 email 没配 name 时,email 仍应回填', async () => {
    stubUserInfo({ name: '', email: '569552263@qq.com' })
    const store = useGitStore()

    await store.getUserInfo()

    expect(store.userEmail).toBe('569552263@qq.com')
    expect(store.userName).toBe('')
  })

  test('用户信息不依赖 isGitRepo,非 Git 仓库目录同样能拿到', async () => {
    // 后端走 `git config user.name`(不带 --global),按 local > global >
    // system 层级读取,在非仓库目录也会 fallback 到全局值。
    stubUserInfo({ name: 'xuze', email: '569552263@qq.com' })
    const store = useGitStore()
    store.isGitRepo = false

    await store.getUserInfo()

    expect(store.isGitRepo).toBe(false)
    expect(store.userName).toBe('xuze')
    expect(store.userEmail).toBe('569552263@qq.com')
  })

  test('请求失败时静默降级,不抛出且保留原值', async () => {
    stubUserInfo(null, { fail: true })
    const store = useGitStore()
    store.userName = 'cached'

    await expect(store.getUserInfo()).resolves.toBeUndefined()

    expect(store.userName).toBe('cached')
  })

  test('$reset() 会清空用户信息 —— 故切目录后必须重拉', async () => {
    // 这条锁定 DirectorySelector 里 `$reset(); getUserInfo()` 的必要性:
    // 少了后面那句,切到非 Git 仓库目录后右上角就会误报"未配置"。
    stubUserInfo({ name: 'xuze', email: '569552263@qq.com' })
    const store = useGitStore()
    await store.getUserInfo()
    expect(store.userName).toBe('xuze')

    store.$reset()
    expect(store.userName).toBe('')
    expect(store.userEmail).toBe('')

    await store.getUserInfo()
    expect(store.userName).toBe('xuze')
  })
})

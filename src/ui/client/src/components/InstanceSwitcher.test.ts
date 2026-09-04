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
// InstanceSwitcher.vue 回归测试。
// 覆盖:当前实例行「端口徽章 + 关闭按钮」并存(不重叠的结构前提)、
//       关闭当前/其他实例的确认流程分支、取消确认不关闭、空列表不渲染、
//       以及 CSS 并排布局守卫。
//
// 为什么要有 CSS 守卫(ISSW-07~10):
//   2026-09-05 修过一次 bug —— .instance-close 是 position:absolute 叠在端口徽章
//   槽位上,而「当前实例」又被设成常驻 opacity:1,端口却只在 hover 才淡出,
//   于是默认状态下两个元素抢同一槽位而重叠。jsdom 不做 CSS 布局计算,
//   DOM 结构在 bug 前后完全一样,所以这个 bug 只能从样式源码层面守住。

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { ElMessageBox } from 'element-plus'
import type { InstanceInfo } from '@/types/instances'

// 可控的 fake store:测试直接改写 list/currentInstanceId,
// 由 setInstances() 维护 currentInstance/otherInstances 两个派生值。
const fakeStore = {
  list: [] as InstanceInfo[],
  currentInstanceId: null as number | null,
  currentInstance: null as InstanceInfo | null,
  otherInstances: [] as InstanceInfo[],
  closeInstance: vi.fn<(pid: number) => Promise<void>>().mockResolvedValue(undefined),
  closeAllInstances: vi.fn().mockResolvedValue({ closed: 0, failed: 0, total: 0 }),
  refresh: vi.fn().mockResolvedValue(undefined),
}

vi.mock('@/stores/instancesStore', () => ({
  useInstancesStore: () => fakeStore,
}))

import InstanceSwitcher from './InstanceSwitcher.vue'
import { mountWithSetup } from '@/test-utils/mount'

function makeInstance(pid: number, projectName: string, port: number): InstanceInfo {
  return {
    pid,
    port,
    projectName,
    projectPath: `D:\\fake\\${projectName}`,
    startedAt: 0,
    lastHeartbeat: 0,
    hostname: 'test-host',
  }
}

// 与 store 的真实语义保持一致:currentInstanceId 为 null 时 otherInstances 即全部 list。
function setInstances(currentPid: number | null, all: InstanceInfo[]) {
  fakeStore.list = all
  fakeStore.currentInstanceId = currentPid
  fakeStore.currentInstance = currentPid == null
    ? null
    : all.find((i) => i.pid === currentPid) ?? null
  fakeStore.otherInstances = all.filter((i) => i.pid !== currentPid)
}

let wrapper: any = null

function mountSwitcher() {
  if (wrapper) {
    try { wrapper.unmount() } catch {}
    wrapper = null
  }
  wrapper = mountWithSetup(InstanceSwitcher, {
    // el-dropdown 的下拉内容是 Teleport + 懒渲染,jsdom 里走不通真实交互。
    // 这里 stub 成透传插槽的壳,让 #dropdown 内容直接渲染出来供结构断言。
    global: {
      stubs: {
        'el-dropdown': { template: '<div class="el-dropdown"><slot /><slot name="dropdown" /></div>' },
        'el-dropdown-menu': { template: '<ul class="el-dropdown-menu"><slot /></ul>' },
        'el-dropdown-item': { template: '<li class="el-dropdown-item"><slot /></li>' },
      },
    },
    attachTo: document.body,
  })
  return wrapper
}

// 等微任务 + 一轮宏任务,确保 await ElMessageBox / await closeInstance 都落定
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

// 当前行用组件内的 .instance-row--current 定位(class 稳定,不依赖 Element Plus 内部)
function currentRow(w: any) {
  return w.find('.instance-row--current')
}

function otherRows(w: any) {
  return w
    .findAll('.instance-row')
    .filter((r: any) => !r.classes().includes('instance-row--current'))
}

describe('InstanceSwitcher.vue 结构', () => {
  beforeEach(() => {
    vi.mocked(ElMessageBox.confirm).mockClear()
    fakeStore.closeInstance.mockClear()
    fakeStore.closeAllInstances.mockClear()
    vi.mocked(ElMessageBox.confirm).mockResolvedValue('confirm' as any)
  })

  afterEach(() => {
    if (wrapper) {
      try { wrapper.unmount() } catch {}
      wrapper = null
    }
  })

  test('ISSW-01: 当前实例行同时渲染端口徽章和关闭按钮,且同属一个 action 容器', () => {
    setInstances(100, [makeInstance(100, 'self', 433), makeInstance(200, 'other', 5510)])
    const w = mountSwitcher()

    const row = currentRow(w)
    expect(row.exists()).toBe(true)

    const badge = row.find('.port-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe(':433')

    const closeBtn = row.find('button.instance-close')
    expect(closeBtn.exists()).toBe(true)

    // 并排布局的结构前提:两者必须在同一个 .instance-action 内,
    // 而不是一个叠在另一个上面(旧实现正是靠绝对定位抢同一槽位才重叠的)。
    const action = row.find('.instance-action')
    expect(action.exists()).toBe(true)
    expect(action.element.contains(badge.element)).toBe(true)
    expect(action.element.contains(closeBtn.element)).toBe(true)
  })

  test('ISSW-02: 其他实例行同样同时渲染端口徽章和关闭按钮', () => {
    setInstances(100, [makeInstance(100, 'self', 433), makeInstance(200, 'zen-gitsync', 5510)])
    const w = mountSwitcher()

    expect(otherRows(w)).toHaveLength(1)
    const row = otherRows(w)[0]
    expect(row.find('.port-badge').text()).toBe(':5510')
    expect(row.find('button.instance-close').exists()).toBe(true)
  })

  test('ISSW-03: 无实例(v-if=hasAny)时不渲染触发器', () => {
    setInstances(null, [])
    const w = mountSwitcher()
    expect(w.find('button.instance-switcher').exists()).toBe(false)
  })

  test('ISSW-04: 只有当前实例时,otherInstances 为空 → 显示空状态', () => {
    setInstances(100, [makeInstance(100, 'self', 433)])
    const w = mountSwitcher()
    expect(currentRow(w).exists()).toBe(true)
    expect(otherRows(w)).toHaveLength(0)
    expect(w.find('.instance-empty').exists()).toBe(true)
  })
})

describe('InstanceSwitcher.vue 关闭流程', () => {
  beforeEach(() => {
    vi.mocked(ElMessageBox.confirm).mockClear()
    fakeStore.closeInstance.mockClear()
    vi.mocked(ElMessageBox.confirm).mockResolvedValue('confirm' as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (wrapper) {
      try { wrapper.unmount() } catch {}
      wrapper = null
    }
  })

  test('ISSW-05: 关闭当前实例 → 走 isSelf 分支,确认后关闭并尝试 window.close', async () => {
    setInstances(100, [makeInstance(100, 'self', 433)])
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
    const w = mountSwitcher()

    await currentRow(w).find('button.instance-close').trigger('click')
    await flush()

    expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1)
    const [content, title] = vi.mocked(ElMessageBox.confirm).mock.calls[0] as [string, string]
    // $t 在测试里被 mock 成 identity(不插值),所以拿到的是文案 key。
    // isSelf 分支用的是「关闭当前实例确认内容」,与关闭他人(「关闭实例确认内容」)区分。
    expect(title).toBe('@INSSW:关闭当前实例')
    expect(content).toBe('@INSSW:关闭当前实例确认内容')

    expect(fakeStore.closeInstance).toHaveBeenCalledWith(100)
    // isSelf 分支才会尝试关当前 tab
    expect(closeSpy).toHaveBeenCalled()
  })

  test('ISSW-06: 关闭其他实例 → 普通分支,不碰 window.close', async () => {
    setInstances(100, [makeInstance(100, 'self', 433), makeInstance(200, 'zen-gitsync', 5510)])
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
    const w = mountSwitcher()

    await otherRows(w)[0].find('button.instance-close').trigger('click')
    await flush()

    const [, title] = vi.mocked(ElMessageBox.confirm).mock.calls[0] as [string, string]
    expect(title).toBe('@INSSW:关闭实例')
    expect(fakeStore.closeInstance).toHaveBeenCalledWith(200)
    expect(closeSpy).not.toHaveBeenCalled()
  })

  test('ISSW-07: 取消确认 → 不调 closeInstance', async () => {
    setInstances(100, [makeInstance(100, 'self', 433)])
    vi.mocked(ElMessageBox.confirm).mockRejectedValueOnce('cancel')
    const w = mountSwitcher()

    await currentRow(w).find('button.instance-close').trigger('click')
    await flush()

    expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1)
    expect(fakeStore.closeInstance).not.toHaveBeenCalled()
  })

  test('ISSW-08: 关闭失败 → 提示错误并 refresh 一次', async () => {
    setInstances(100, [makeInstance(100, 'self', 433)])
    fakeStore.closeInstance.mockRejectedValueOnce(new Error('boom'))
    fakeStore.refresh.mockClear()
    const w = mountSwitcher()

    await currentRow(w).find('button.instance-close').trigger('click')
    await flush()

    expect(fakeStore.refresh).toHaveBeenCalledTimes(1)
  })
})

// jsdom 不做 CSS 布局计算,DOM 结构在重叠 bug 前后完全一致,
// 因此「不再重叠」这一约束只能从样式源码层面守住。
describe('InstanceSwitcher.vue CSS 布局守卫', () => {
  // 用 vite 的 ?raw 直接取 SFC 源码文本(避免依赖 import.meta.url ——
  // 它在 vitest 下不是 file: scheme,喂给 readFileSync 会报 "must be of scheme file")。
  const rawModules = import.meta.glob('./InstanceSwitcher.vue', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>
  const src = Object.values(rawModules)[0] ?? ''
  const styleBlock = src.slice(src.indexOf('<style'))

  // 取出某条规则的花括号内容。
  // 注意:源码里这些规则都裹在 :global(...) 里,选择器与 `{` 之间还隔着一个 `)`。
  function ruleBody(selector: string): string | null {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = styleBlock.match(new RegExp(escaped + '\\s*\\)\\s*\\{([^}]*)\\}'))
    return m ? m[1] : null
  }

  test('ISSW-09: 当前行关闭按钮是 position:static(不再绝对定位叠在端口上)', () => {
    const body = ruleBody('.instance-menu-item--current .instance-close')
    expect(body, '未找到 --current .instance-close 规则').toBeTruthy()
    expect(body).toMatch(/position:\s*static/)
  })

  test('ISSW-10: 当前行 action 容器是 inline-flex 并排布局且带 gap', () => {
    const body = ruleBody('.instance-menu-item--current .instance-action')
    expect(body, '未找到 --current .instance-action 规则').toBeTruthy()
    expect(body).toMatch(/inline-flex/)
    expect(body).toMatch(/gap:\s*\d/)
  })

  test('ISSW-11: 回归防线 —— 不再有「当前行 hover/focus 时淡出端口」的规则', () => {
    expect(styleBlock).not.toMatch(/--current:hover\s+\.port-badge/)
    expect(styleBlock).not.toMatch(/--current:focus-within\s+\.port-badge/)
  })

  test('ISSW-12: 当前行端口徽章不被设为 opacity:0', () => {
    const body = ruleBody('.instance-menu-item--current .port-badge')
    if (body) expect(body).not.toMatch(/opacity:\s*0\b/)
  })
})

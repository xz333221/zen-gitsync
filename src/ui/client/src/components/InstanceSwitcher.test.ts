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
//       关闭当前实例时 window.close 被拦截的兜底遮罩(ISSW-13/14)、
//       以及 CSS 布局守卫(ISSW-09~11)。
//
// 为什么要有 CSS 守卫(ISSW-09~11):
//   2026-09-05 修过一次 bug —— .instance-close 是 position:absolute 叠在端口徽章
//   槽位上,而「当前实例」又被设成常驻 opacity:1,端口却只在 hover 才淡出,
//   于是默认状态下两个元素抢同一槽位而重叠。jsdom 不做 CSS 布局计算,
//   DOM 结构在 bug 前后完全一样,所以这个 bug 只能从样式源码层面守住。
//   2026-10-06(d2e275a4) 换掉了当时的修复形态:「当前行例外」(× 常驻 + 并排布局)
//   被废除,当前行回归与其余行一致的 hover 换显。守卫已随实现同步(ISSW-09~11):
//   显现规则存在 / 端口淡出与 × 显现成对 / 旧例外不许回来。

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
  closeAllInstances: vi.fn().mockResolvedValue({ closed: 0, failed: 0, total: 0, selfClose: false }),
  refresh: vi.fn().mockResolvedValue(undefined),
  // 「关闭当前实例」兜底流程会调用 stop() 停掉轮询/socket 重连
  stop: vi.fn(),
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

  test('ISSW-15: 只有当前实例时「关闭所有实例」按钮仍渲染(count 用总数)', () => {
    // 回归点:「关闭全部」曾经只在 otherCount > 0 时出现,且只关别人;
    // 现在它关的是**所有**实例(含当前),所以只剩自己一个时也必须能点。
    setInstances(100, [makeInstance(100, 'self', 433)])
    const w = mountSwitcher()

    const btn = w.find('button.instance-close-all')
    expect(btn.exists()).toBe(true)
    // $t 在测试里被 mock 成 identity(不插值),所以断言的是文案 key
    expect(btn.attributes('title')).toBe('@INSSW:关闭所有实例 {count}')
    expect(btn.text()).toContain('@INSSW:关闭所有实例 {count}')
  })
})

describe('InstanceSwitcher.vue 关闭流程', () => {
  beforeEach(() => {
    vi.mocked(ElMessageBox.confirm).mockClear()
    fakeStore.closeInstance.mockClear()
    fakeStore.closeAllInstances.mockClear()
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

  test('ISSW-13: 关闭当前实例且 window.close 被拦截 → 兜底遮罩出现并调用 store.stop', async () => {
    setInstances(100, [makeInstance(100, 'self', 433)])
    fakeStore.stop.mockClear()
    // 模拟 Chrome 拦截:window.close() 静默不生效,页面仍然存活
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
    const w = mountSwitcher()

    await currentRow(w).find('button.instance-close').trigger('click')
    // 关闭刚完成、250ms 兜底定时器未到:遮罩不应出现
    // (遮罩 Teleport 到 body,不在 wrapper 树内,必须查 document)
    expect(document.querySelector('.self-closed-overlay')).toBeNull()

    // 越过 250ms 兜底阈值(留裕量)
    await new Promise((resolve) => setTimeout(resolve, 350))

    // 页面还活着(window.close 被拦截)→ 遮罩出现,僵尸页面停止轮询/重连
    expect(document.querySelector('.self-closed-overlay')).not.toBeNull()
    expect(fakeStore.stop).toHaveBeenCalledTimes(1)
    expect(closeSpy).toHaveBeenCalledTimes(1)
  }, 5000)

  test('ISSW-14: 关闭其他实例 → 不触发兜底遮罩', async () => {
    setInstances(100, [makeInstance(100, 'self', 433), makeInstance(200, 'zen-gitsync', 5510)])
    fakeStore.stop.mockClear()
    const w = mountSwitcher()

    await otherRows(w)[0].find('button.instance-close').trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 350))

    expect(document.querySelector('.self-closed-overlay')).toBeNull()
    expect(fakeStore.stop).not.toHaveBeenCalled()
  }, 5000)

  test('ISSW-16: 关闭所有实例含当前实例 → 确认后关 tab 并亮兜底遮罩', async () => {
    setInstances(100, [makeInstance(100, 'self', 433), makeInstance(200, 'zen-gitsync', 5510)])
    fakeStore.closeAllInstances.mockResolvedValueOnce({ closed: 2, failed: 0, total: 2, selfClose: true })
    fakeStore.stop.mockClear()
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
    const w = mountSwitcher()

    await w.find('button.instance-close-all').trigger('click')
    await flush()

    expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1)
    const [content, title] = vi.mocked(ElMessageBox.confirm).mock.calls[0] as [string, string]
    expect(title).toBe('@INSSW:关闭所有实例')
    // 确认文案必须说清「包括当前实例」——这是与旧行为的唯一区别,
    // 不写清楚用户会以为只关别人。
    expect(content).toBe('@INSSW:关闭所有实例确认内容')

    expect(fakeStore.closeAllInstances).toHaveBeenCalledTimes(1)
    // 走的是与「关闭当前实例」同一条收尾:先试 window.close
    expect(closeSpy).toHaveBeenCalledTimes(1)
    // 刚关完、250ms 兜底定时器未到:遮罩不应出现
    expect(document.querySelector('.self-closed-overlay')).toBeNull()

    await new Promise((resolve) => setTimeout(resolve, 350))

    // window.close 被拦截 → 遮罩出现,僵尸页面停止轮询/重连
    expect(document.querySelector('.self-closed-overlay')).not.toBeNull()
    expect(fakeStore.stop).toHaveBeenCalledTimes(1)
  }, 5000)

  test('ISSW-17: selfClose 为假时(当前实例不在关闭批次里)不关 tab', async () => {
    setInstances(100, [makeInstance(100, 'self', 433)])
    fakeStore.closeAllInstances.mockResolvedValueOnce({ closed: 1, failed: 0, total: 1, selfClose: false })
    fakeStore.stop.mockClear()
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
    const w = mountSwitcher()

    await w.find('button.instance-close-all').trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 350))

    expect(closeSpy).not.toHaveBeenCalled()
    expect(document.querySelector('.self-closed-overlay')).toBeNull()
    expect(fakeStore.stop).not.toHaveBeenCalled()
  }, 5000)
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
  // 剥注释再断言：解释性注释里会引用选择器名（"改前这里有一整套……"），
  // 不剥的话正/反两种断言都可能被注释文本绊倒
  const styleNoComments = styleBlock.replace(/\/\*[\s\S]*?\*\//g, '')

  // 取出某条规则的花括号内容。
  // 注意:源码里这些规则都裹在 :global(...) 里,选择器与 `{` 之间还隔着一个 `)`。
  function ruleBody(selector: string): string | null {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = styleBlock.match(new RegExp(escaped + '\\s*\\)\\s*\\{([^}]*)\\}'))
    return m ? m[1] : null
  }

  // 与 ruleBody 的区别：规则组可能由多行 :global(...) 选择器逗号连接、
  // 只有最后一个才接 `{`（如 :hover 与 :focus-within 成对的两行），
  // 所以从选择器出现处向后找第一个 `{`，而不是要求它紧跟 `)`。
  // ⚠️ 选择器后必须加边界前瞻（`)` / `,` / `{`）：反样本训练抓出来的 ——
  // 不加的话把 "…instance-close" 改名成 "…instance-close-ZZ)" 也会被前缀命中，
  // 等于"规则已失效"却测试照过（假绿）。
  function ruleBodyAfter(selector: string): string | null {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = styleNoComments.match(new RegExp(escaped + '(?=\\s*[),{])[\\s\\S]*?\\{([^}]*)\\}'))
    return m ? m[1] : null
  }

  test('ISSW-09: 当前行 × 与其余行一致 —— 默认隐藏、hover/focus 才显现(disabled 行须有独立补充规则)', () => {
    // 2026-10-06(d2e275a4) 起:当前行不再「常驻 ×」,改为与其余行一致的 hover 换显。
    // 组件注释里标了 ⚠️:当前行是 disabled,通用规则写的是 :not(.is-disabled):hover,
    // 它吃不到 —— 必须补一份不带 :not() 的 --current 专属规则,否则永远不显现。
    const hover = ruleBodyAfter('--current:hover .instance-close')
    const focus = ruleBodyAfter('--current:focus-within .instance-close')
    expect(hover, '未找到 --current:hover .instance-close 规则').toBeTruthy()
    expect(focus, '未找到 --current:focus-within .instance-close 规则(键盘可达性)').toBeTruthy()
    expect(hover).toMatch(/opacity:\s*1/)
    expect(hover).toMatch(/pointer-events:\s*auto/)
  })

  test('ISSW-10: 当前行 hover 时端口徽章淡出 —— 与 × 显现成对(只删其一会留空档或重现重叠)', () => {
    // 组件注释:「写在一起是因为它们永远是成对出现——只淡出不显现会留下一个空档」。
    // 这条守的是防重叠 bug 在新机制下的形态:同槽位两个元素,任何时刻最多一个可见。
    const dim = ruleBodyAfter('--current:hover .port-badge')
    expect(dim, '未找到 --current:hover .port-badge 规则').toBeTruthy()
    expect(dim).toMatch(/opacity:\s*0/)
  })

  test('ISSW-11: 回归防线 —— 旧「当前行常驻例外」不许回来(第一行不许再特殊化)', () => {
    // 旧例外(已被 d2e275a4 废除):--current 行的 × 走 position:static 常驻、
    // action 走 inline-flex 并排 —— 结局是"6 行里只有第一行的 × 常驻",看着像 bug。
    // 若有人加回这类「当前行专属的静态规则」,测试当场红。
    expect(styleNoComments).not.toMatch(/--current \.instance-close[\s\S]{0,120}?\{/)
    expect(styleNoComments).not.toMatch(/--current \.instance-action[\s\S]{0,120}?\{/)
  })

  test('ISSW-12: 当前行端口徽章不被设为 opacity:0', () => {
    const body = ruleBody('.instance-menu-item--current .port-badge')
    if (body) expect(body).not.toMatch(/opacity:\s*0\b/)
  })
})

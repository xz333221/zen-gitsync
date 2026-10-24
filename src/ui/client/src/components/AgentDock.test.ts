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
// AgentDock：右下角 g ai 悬浮入口。
// 守四条线：① 徽标跟着 agentActivity store 走（从 ActivityBar 搬迁来的口径）；
// ② mascot 开合与 aria 状态；③ Esc / bus 打开并提问；④ contextFile 透传给 AgentView。
// AgentView 用 stub（真实组件拖整个 zen-ai-chat-ui，且这里只测 dock 自己的行为）。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mountWithSetup } from '@/test-utils/mount'
import AgentDock from './AgentDock.vue'
import { useAgentActivityStore } from '@/stores/agentActivity'
import { agentDockBus } from '@/utils/agentDockBus'

/** stub 掉 AgentView，顺带记录 askQuestion 调用（bus 消费的落点） */
const askQuestion = vi.fn(() => Promise.resolve())
const AgentViewStub = defineComponent({
  name: 'AgentView',
  props: {
    contextFilePath: { type: String, default: undefined },
    contextFileName: { type: String, default: undefined },
  },
  setup(props, { expose }) {
    expose({ askQuestion })
    return () => h('div', {
      class: 'agent-view-stub',
      'data-path': props.contextFilePath ?? '',
      'data-name': props.contextFileName ?? '',
    })
  },
})

function mountDock(contextFile?: { path: string; name: string } | null) {
  return mountWithSetup(AgentDock, {
    props: contextFile === undefined ? {} : { contextFile },
    global: { stubs: { AgentView: AgentViewStub } },
  })
}

function mascot(w: any) {
  return w.find('.agent-dock__mascot')
}

/**
 * 面板的显示状态读**内联 display**，不用 isVisible()：
 * jsdom 的 getComputedStyle 在首次调用后会缓存 display（后续内联改动不反映），
 * VTU 的 isVisible() 正踩这个坑 —— 点开前读过一次 "none"，点开后永远报 false。
 * v-show 的契约就是内联 display（隐藏时 'none'、显示时 ''），直接断它。
 */
function panelShown(w: any) {
  return w.find('.agent-dock__panel').element.style.display !== 'none'
}

// bus 是模块级 reactive，测试间必须手动复位
beforeEach(() => {
  agentDockBus.open = false
  agentDockBus.pending = null
  askQuestion.mockClear()
})

describe('AgentDock 徽标（从 ActivityBar 搬迁的口径）', () => {
  it('没有轮次在跑时不显示徽标，aria-label 是纯名称', () => {
    const w = mountDock()
    expect(w.find('.agent-dock__badge').exists()).toBe(false)
    expect(mascot(w).attributes('aria-label')).toBe('@ACTBAR:智能体')
    expect(mascot(w).attributes('aria-pressed')).toBe('false')
  })

  it('登记一轮后出现数字，销号后消失', async () => {
    const w = mountDock()
    const store = useAgentActivityStore()

    store.begin('1:A:1')
    await nextTick()
    expect(w.find('.agent-dock__badge').text()).toBe('1')
    expect(mascot(w).find('.agent-dock__badge').exists()).toBe(true)

    store.end('1:A:1')
    await nextTick()
    expect(w.find('.agent-dock__badge').exists()).toBe(false)
  })

  it('超过 99 显示 99+', async () => {
    const w = mountDock()
    const store = useAgentActivityStore()
    for (let i = 0; i < 100; i++) store.begin(`t${i}`)
    await nextTick()
    expect(w.find('.agent-dock__badge').text()).toBe('99+')
  })
})

describe('AgentDock 开合', () => {
  it('点 mascot 展开面板，再点收起；aria-pressed 跟随', async () => {
    const w = mountDock()
    expect(panelShown(w)).toBe(false)

    await mascot(w).trigger('click')
    await nextTick()
    expect(panelShown(w)).toBe(true)
    expect(mascot(w).attributes('aria-pressed')).toBe('true')
    // 展开后才挂载 AgentView（首次打开懒挂载，之后常驻不卸载）
    expect(w.find('.agent-view-stub').exists()).toBe(true)

    await mascot(w).trigger('click')
    await nextTick()
    expect(panelShown(w)).toBe(false)
    expect(mascot(w).attributes('aria-pressed')).toBe('false')
  })

  it('Esc 关闭（且只在面板开着时）', async () => {
    const w = mountDock()
    await mascot(w).trigger('click')
    await nextTick()
    expect(panelShown(w)).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(panelShown(w)).toBe(false)

    // 关着再按 Esc 不炸
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(panelShown(w)).toBe(false)
  })

  it('头部 ✕ 收起；最大化/还原切换面板 class', async () => {
    const w = mountDock()
    await mascot(w).trigger('click')
    await nextTick()

    const panel = w.find('.agent-dock__panel')
    expect(panel.classes()).not.toContain('is-maximized')
    await w.find('button[aria-label="@ACTBAR:最大化对话"]').trigger('click')
    await nextTick()
    expect(w.find('.agent-dock__panel').classes()).toContain('is-maximized')
    await w.find('button[aria-label="@ACTBAR:还原对话"]').trigger('click')
    await nextTick()
    expect(w.find('.agent-dock__panel').classes()).not.toContain('is-maximized')

    await w.find('button[aria-label="@ACTBAR:关闭对话"]').trigger('click')
    await nextTick()
    expect(panelShown(w)).toBe(false)
  })
})

describe('AgentDock bus 消费', () => {
  it('bus 置 open + pending → 面板打开并把问题发给 AgentView.askQuestion', async () => {
    const w = mountDock()
    agentDockBus.open = true
    agentDockBus.pending = { text: '哪些项目落后远端？', dirStatus: [{ path: 'x' }], dirSummary: '解读原文' }
    await nextTick()
    await nextTick()

    expect(panelShown(w)).toBe(true)
    expect(askQuestion).toHaveBeenCalledTimes(1)
    expect(askQuestion).toHaveBeenCalledWith(
      '哪些项目落后远端？',
      { text: '哪些项目落后远端？', dirStatus: [{ path: 'x' }], dirSummary: '解读原文' },
    )
    // 消费后清掉，防重入
    expect(agentDockBus.pending).toBeNull()
  })

  it('面板已开着时来 pending：不重开，只发问', async () => {
    const w = mountDock()
    await mascot(w).trigger('click')
    await nextTick()
    askQuestion.mockClear()

    agentDockBus.pending = { text: '第二个问题' }
    await nextTick()
    await nextTick()
    expect(askQuestion).toHaveBeenCalledWith('第二个问题', { text: '第二个问题' })
  })
})

describe('AgentDock contextFile 透传', () => {
  it('传入当前文件 → AgentView 收到 path/name', async () => {
    const w = mountDock({ path: 'd:/repo/a.ts', name: 'a.ts' })
    await mascot(w).trigger('click')
    await nextTick()
    const stub = w.find('.agent-view-stub')
    expect(stub.attributes('data-path')).toBe('d:/repo/a.ts')
    expect(stub.attributes('data-name')).toBe('a.ts')
  })

  it('不传（非编辑器视图）→ 两个 prop 均为 undefined', async () => {
    const w = mountDock(null)
    await mascot(w).trigger('click')
    await nextTick()
    const stub = w.find('.agent-view-stub')
    expect(stub.attributes('data-path')).toBe('')
    expect(stub.attributes('data-name')).toBe('')
  })
})

// 点击外部关闭：两条分支都要锁住 —— 普通外部点击要关；活动栏（切视图）不关
//（用户要求「切换视图时对话框仍在右下角」，那排按钮属于 shell 而不是「外部内容」）。
describe('AgentDock 点击外部关闭', () => {
  /** 模拟真实点击：mousedown 先走 capture 快照，再在目标上派发冒泡的 click */
  function realClick(el: Element) {
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }

  it('点面板外部 → 关闭', async () => {
    const w = mountDock()
    await mascot(w).trigger('click')
    await nextTick()
    expect(panelShown(w)).toBe(true)

    const outside = document.createElement('div')
    document.body.appendChild(outside)
    realClick(outside)
    await nextTick()
    expect(panelShown(w)).toBe(false)
    outside.remove()
  })

  it('点活动栏（切视图）→ 不关闭', async () => {
    const w = mountDock()
    await mascot(w).trigger('click')
    await nextTick()

    const bar = document.createElement('div')
    bar.className = 'activity-bar'
    const btn = document.createElement('button')
    bar.appendChild(btn)
    document.body.appendChild(bar)
    realClick(btn)
    await nextTick()
    expect(panelShown(w)).toBe(true)
    bar.remove()
  })
})

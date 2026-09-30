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
// ActivityBar 智能体徽标：g ai 有轮次在生成时，机器人图标右上角出现数字。
// 这里守的是「徽标跟着 store 走」这条线 —— 徽标曾经完全没有，回归时最容易出现的是
// v-if 条件写反 / class 改名 / 数字没跟 runningCount 联动。
import { describe, it, expect } from 'vitest'
import { nextTick } from 'vue'
import type { VueWrapper } from '@vue/test-utils'
import { mountWithSetup } from '@/test-utils/mount'
import ActivityBar from './ActivityBar.vue'
import { useAgentActivityStore } from '@/stores/agentActivity'
import { useGitStore } from '@/stores/gitStore'

/**
 * 智能体那个按钮。靠 aria-label 里的 @ACTBAR:智能体 认（测试里 $t 是恒等函数，
 * 所以两种状态都含这个 key），不靠 class 或出现序号 —— 图标顺序会变。
 */
function agentBtn(wrapper: VueWrapper<any>) {
  return wrapper.find('button[aria-label*="@ACTBAR:智能体"]')
}

/**
 * Git 那个按钮。用 aria-label 里的 @ACTBAR:Git 认（其余按钮的 key 都不是它的前缀）。
 */
function gitBtn(wrapper: VueWrapper<any>) {
  return wrapper.find('button[aria-label*="@ACTBAR:Git"]')
}

describe('ActivityBar 智能体徽标', () => {
  it('没有轮次在跑时不显示徽标', () => {
    const w = mountWithSetup(ActivityBar, { props: { activeView: 'agent' } })
    expect(w.find('.agent-running-badge').exists()).toBe(false)
    expect(w.html()).toContain('@ACTBAR:智能体')
  })

  it('登记一轮后出现数字，销号后消失', async () => {
    const w = mountWithSetup(ActivityBar, { props: { activeView: 'git' } })
    const store = useAgentActivityStore()

    store.begin('1:A:1')
    await nextTick()
    expect(w.find('.agent-running-badge').text()).toBe('1')
    // 徽标落在机器人按钮内，不是漂在别处
    expect(agentBtn(w).find('.agent-running-badge').exists()).toBe(true)

    store.begin('1:B:1')
    await nextTick()
    expect(w.find('.agent-running-badge').text()).toBe('2')

    store.end('1:A:1')
    await nextTick()
    expect(w.find('.agent-running-badge').text()).toBe('1')

    store.end('1:B:1')
    await nextTick()
    expect(w.find('.agent-running-badge').exists()).toBe(false)
  })

  it('aria-label 带上数量，0 时回到纯名称', async () => {
    const w = mountWithSetup(ActivityBar, { props: { activeView: 'git' } })
    const store = useAgentActivityStore()

    store.begin('1:A:1')
    await nextTick()
    expect(agentBtn(w).attributes('aria-label')).toContain('1')
    expect(agentBtn(w).attributes('aria-label')).toContain('@ACTBAR:个对话正在生成')

    store.end('1:A:1')
    await nextTick()
    expect(agentBtn(w).attributes('aria-label')).toBe('@ACTBAR:智能体')
  })

  it('超过 99 显示 99+', async () => {
    const w = mountWithSetup(ActivityBar, { props: { activeView: 'git' } })
    const store = useAgentActivityStore()

    for (let i = 0; i < 100; i++) store.begin(`t${i}`)
    await nextTick()
    expect(w.find('.agent-running-badge').text()).toBe('99+')
  })
})

/**
 * Git 图标上的领先 / 落后徽标：落在按钮右下角（未提交徽标在右上角），
 * 跟着 gitStore.branchAhead / branchBehind 走。
 * 守的是「有领先或落后时左侧图标上必须看得到数字」这条线 —— 这个状态此前
 * 只写在左侧面板那行蓝条里，切到别的视图就完全无感，而它恰恰最需要立刻 pull。
 */
describe('ActivityBar Git 领先/落后徽标', () => {
  /** 挂一个 Git 仓库场景下的活动栏（gitStore 与组件共用同一个 pinia 实例） */
  function mountBar() {
    const w = mountWithSetup(ActivityBar, { props: { activeView: 'git' } })
    const gitStore = useGitStore()
    gitStore.isGitRepo = true
    return { w, gitStore }
  }

  it('没有领先/落后时不显示徽标', () => {
    const { w } = mountBar()
    expect(gitBtn(w).find('.git-sync-badge').exists()).toBe(false)
  })

  it('落后时显示 ↓N，走 behind 档', async () => {
    const { w, gitStore } = mountBar()
    gitStore.branchBehind = 1
    await nextTick()
    const badge = gitBtn(w).find('.git-sync-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('↓1')
    expect(badge.classes()).toContain('git-sync-badge--behind')
  })

  it('领先时显示 ↑N，走 ahead 档', async () => {
    const { w, gitStore } = mountBar()
    gitStore.branchAhead = 2
    await nextTick()
    const badge = gitBtn(w).find('.git-sync-badge')
    expect(badge.text()).toBe('↑2')
    expect(badge.classes()).toContain('git-sync-badge--ahead')
  })

  it('两边都有时同一个徽标给出 ↑N ↓M，走 diverged 档', async () => {
    const { w, gitStore } = mountBar()
    gitStore.branchAhead = 2
    gitStore.branchBehind = 3
    await nextTick()
    const badge = gitBtn(w).find('.git-sync-badge')
    expect(badge.text()).toBe('↑2 ↓3')
    expect(badge.classes()).toContain('git-sync-badge--diverged')
  })

  it('与右上角的未提交徽标并存，两个徽标同时可见', async () => {
    const { w, gitStore } = mountBar()
    gitStore.fileList = [{ path: 'a.ts', type: 'modified' }]
    gitStore.branchBehind = 1
    await nextTick()
    const btn = gitBtn(w)
    expect(btn.find('.git-uncommitted-badge').text()).toBe('1')
    expect(btn.find('.git-sync-badge').text()).toBe('↓1')
  })

  it('不是 Git 仓库时不显示（store 里的脏值不算数）', async () => {
    const w = mountWithSetup(ActivityBar, { props: { activeView: 'git' } })
    const gitStore = useGitStore()
    gitStore.branchAhead = 3
    gitStore.isGitRepo = false
    await nextTick()
    expect(gitBtn(w).find('.git-sync-badge').exists()).toBe(false)
  })

  it('超过 99 显示 99+', async () => {
    const { w, gitStore } = mountBar()
    gitStore.branchAhead = 120
    await nextTick()
    expect(gitBtn(w).find('.git-sync-badge').text()).toBe('↑99+')
  })

  it('aria-label 带上领先/落后，供读屏与 tooltip 使用', async () => {
    const { w, gitStore } = mountBar()
    gitStore.branchBehind = 1
    await nextTick()
    expect(gitBtn(w).attributes('aria-label')).toContain('@ACTBAR:落后 {count} 个提交')
  })
})

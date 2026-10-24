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
// 注：「智能体」入口已整合为右下角悬浮 dock（AgentDock.vue），
// 「正在生成的对话数」徽标随之搬到 dock 的 mascot 上，回归测试见 AgentDock.test.ts。
import { describe, it, expect } from 'vitest'
import { nextTick } from 'vue'
import type { VueWrapper } from '@vue/test-utils'
import { mountWithSetup } from '@/test-utils/mount'
import ActivityBar from './ActivityBar.vue'
import { useWorkbenchStatusStore } from '@/stores/workbenchStatus'
import { useGitStore } from '@/stores/gitStore'

/**
 * Git 那个按钮。用 aria-label 里的 @ACTBAR:Git 认（其余按钮的 key 都不是它的前缀）。
 */
function gitBtn(w: VueWrapper<any>) {
  return w.find('button[aria-label*="@ACTBAR:Git"]')
}

/**
 * 工作台图标上的活跃执行徽标：跟着 useWorkbenchStatusStore 走。
 * 数字本身由 useOrchestrator 从服务端下发的 running 数组投喂（见
 * composables/useOrchestrator.test.ts 那组用例），这里只守"store 变了徽标就变"。
 */
describe('ActivityBar 工作台活跃执行徽标', () => {
  function wbBtn(w: VueWrapper<any>) {
    return w.find('button[aria-label*="@ACTBAR:工作台"]')
  }

  it('没有活跃执行时不显示徽标', () => {
    const w = mountWithSetup(ActivityBar, { props: { activeView: 'workbench' } })
    expect(w.find('.wb-running-badge').exists()).toBe(false)
  })

  it('store 有数时出现，落在工作台按钮内，归零后消失', async () => {
    const w = mountWithSetup(ActivityBar, { props: { activeView: 'git' } })
    const store = useWorkbenchStatusStore()

    store.setRunning(3)
    await nextTick()
    const badge = wbBtn(w).find('.wb-running-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('3')

    store.setRunning(0)
    await nextTick()
    expect(w.find('.wb-running-badge').exists()).toBe(false)
  })

  it('超过 99 显示 99+', async () => {
    const w = mountWithSetup(ActivityBar, { props: { activeView: 'git' } })
    useWorkbenchStatusStore().setRunning(120)
    await nextTick()
    expect(w.find('.wb-running-badge').text()).toBe('99+')
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

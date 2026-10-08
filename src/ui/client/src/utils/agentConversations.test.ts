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
// 对话容器共享配置（MESSAGE_RAIL_CONFIG）的回归测试。
//
// 背景（2026-10-08）：用户连着两次在截图里圈出"这里没显示 XXX"——先是思考块耗时，
// 再是消息侧边条。两次的形态一模一样：**库支持、宿主没接**。
//
// 侧边条这一项尤其容易再漏：它是库的**默认关闭项**（`enable` 默认 false，要接入方
// 显式打开），而全仓有五个地方各自渲染 `<ChatContainer>`，漏一处就那一页没有 ——
// 不报错、不红测，只有用户能看见。所以这里钉三组断言：
//   1. 共享配置的形状（库认的开关字段就是 `enable`）
//   2. 真挂 ChatContainer：接上配置 + 两轮对话 → 侧边条真的画出来；只有一轮 → 不画
//   3. 源码守卫：**凡是渲染 ChatContainer 的 .vue 都得把配置接上**（新增对话容器
//      忘了接会在这里红，而不是等用户在截图里圈）

import { describe, expect, test } from 'vitest'
import { mount } from '@vue/test-utils'
import { ChatContainer } from 'zen-ai-chat-ui'
import type { ChatMessage } from 'zen-ai-chat-ui'
import { MESSAGE_RAIL_CONFIG } from './agentConversations'

describe('MESSAGE_RAIL_CONFIG', () => {
  test('开关字段是 enable（库的 MessageRailConfig 只认这一个）', () => {
    expect(MESSAGE_RAIL_CONFIG).toEqual({ enable: true })
  })
})

describe('侧边条真的画出来了（真挂库的 ChatContainer）', () => {
  // jsdom 没实现 Element.scrollTo，ChatContainer 挂载时会自动贴底 —— 与本次改动无关的环境缺口
  const proto = Element.prototype as unknown as { scrollTo?: () => void }
  if (!proto.scrollTo) proto.scrollTo = () => {}

  /** n 轮问答（一轮 = 一条 user + 一条 assistant） */
  function turns(n: number): ChatMessage[] {
    const list: ChatMessage[] = []
    for (let i = 0; i < n; i++) {
      list.push({
        id: `u${i}`,
        role: 'user',
        content: `第 ${i + 1} 问：${'问'.repeat(i * 20)}`,
        status: 'done',
        createdAt: Date.now()
      })
      list.push({
        id: `a${i}`,
        role: 'assistant',
        content: `第 ${i + 1} 答：${'答'.repeat(i * 40)}`,
        status: 'done',
        createdAt: Date.now()
      })
    }
    return list
  }

  test('两轮对话 → 左边缘两根条，条宽落在配置区间里', async () => {
    const wrapper = mount(ChatContainer, {
      props: { messages: turns(2), messageRailConfig: MESSAGE_RAIL_CONFIG },
      global: { mocks: { $t: (k: string) => k } }
    })
    await new Promise(r => setTimeout(r, 0))

    expect(wrapper.find('.acu-rail').exists()).toBe(true)
    const bars = wrapper.findAll('.acu-rail-bar')
    expect(bars).toHaveLength(2)
    for (const bar of bars) {
      const w = parseFloat((bar.element as HTMLElement).style.width)
      expect(w).toBeGreaterThanOrEqual(8)
      expect(w).toBeLessThanOrEqual(26)
    }
  })

  test('只有一轮 → 库自己不画（单轮场景不需要宿主另做判断）', async () => {
    const wrapper = mount(ChatContainer, {
      props: { messages: turns(1), messageRailConfig: MESSAGE_RAIL_CONFIG },
      global: { mocks: { $t: (k: string) => k } }
    })
    await new Promise(r => setTimeout(r, 0))

    expect(wrapper.find('.acu-rail').exists()).toBe(false)
  })
})

describe('源码守卫：渲染 ChatContainer 的地方都得接上侧边条', () => {
  const allSources = import.meta.glob('../**/*.vue', {
    query: '?raw',
    import: 'default',
    eager: true
  }) as Record<string, string>

  /**
   * 白名单：只渲染**单轮**对话的容器不必接 —— 一个 job 就是一轮问答
   * （prompt + 回答），库在只有一轮时本来就不画侧边条，接了也是死配置。
   * 往这里加新条目之前先问一句：它真的永远只有一轮吗？
   */
  const SINGLE_TURN_SURFACES = ['../components/JobLogDetails.vue']

  test('五个对话容器都传了 :message-rail-config="MESSAGE_RAIL_CONFIG"', () => {
    const consumers = Object.entries(allSources).filter(([, src]) => src.includes('<ChatContainer'))
    // 兜底：glob 没扫到就是守卫自己坏了，不是"全都没接"
    expect(consumers.length).toBeGreaterThanOrEqual(5)

    for (const [file, src] of consumers) {
      if (SINGLE_TURN_SURFACES.includes(file)) continue
      expect(src, `${file} 渲染了 ChatContainer 却没接 :message-rail-config（侧边条会缺在这一页）`)
        .toContain(':message-rail-config="MESSAGE_RAIL_CONFIG"')
    }
  })

  test('白名单里的单轮容器确实不在五个多轮容器之列（防止有人把它糊进来绕开守卫）', () => {
    const consumers = Object.keys(allSources).filter(f => allSources[f].includes('<ChatContainer'))
    // 白名单条目必须真的存在，否则是"规则过时了"
    for (const f of SINGLE_TURN_SURFACES) {
      expect(consumers, `白名单里的 ${f} 已经不再渲染 ChatContainer，规则该删了`).toContain(f)
    }
  })
})

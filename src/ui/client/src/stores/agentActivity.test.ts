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
// agentActivity：在跑轮次的登记处（左侧机器人图标徽标的数据源）。
// 这里守的是「令牌语义」——计数用 Set 而不是 +1/-1 就是为了这两条幂等性，
// 一旦有人改成裸计数器，本文件的重复 begin / 重复 end 用例会立刻红。
import { describe, expect, test, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentActivityStore } from './agentActivity'

describe('agentActivity 在跑轮次登记', () => {
  beforeEach(() => setActivePinia(createPinia()))

  test('登记后计数增加，销号后归零', () => {
    const store = useAgentActivityStore()
    expect(store.runningCount).toBe(0)
    expect(store.hasRunning).toBe(false)

    expect(store.begin('a')).toBe(true)
    expect(store.runningCount).toBe(1)
    expect(store.hasRunning).toBe(true)

    store.begin('b')
    expect(store.runningCount).toBe(2)

    expect(store.end('a')).toBe(true)
    expect(store.runningCount).toBe(1)
    store.end('b')
    expect(store.runningCount).toBe(0)
    expect(store.hasRunning).toBe(false)
  })

  test('重复登记 / 重复销号幂等，不会多算也不会把别人的轮次减掉', () => {
    const store = useAgentActivityStore()
    store.begin('a')
    store.begin('b')

    // 同一令牌登记两次：不能变成 3
    expect(store.begin('a')).toBe(false)
    expect(store.runningCount).toBe(2)

    // 销一个没登记过的号：不能把 b 也带走
    expect(store.end('zzz')).toBe(false)
    expect(store.runningCount).toBe(2)

    // 同一令牌销两次：第一次减一，第二次不动
    expect(store.end('a')).toBe(true)
    expect(store.end('a')).toBe(false)
    expect(store.runningCount).toBe(1)
    expect(store.activeTokens).toEqual(['b'])
  })

  test('空令牌不登记', () => {
    const store = useAgentActivityStore()
    expect(store.begin('')).toBe(false)
    expect(store.runningCount).toBe(0)
  })
})

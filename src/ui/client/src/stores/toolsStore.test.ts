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
// toolsStore 里「执行器当前用什么模型」那块的回归。
//
// 为什么这些用例值得写：这块的核心不是"能取到模型"，而是**三态不许混淆** ——
//   unknown（还没问到） / unset（确实没配） / set（有）
// 把 unknown 显示成 unset（"未在配置中指定"）就是在撒谎，而用户会信 ——
// 他会去翻三个配置文件找一个根本不存在的问题。这条口径在浏览器探针里也验
// （verify-wb-executor-models 的 F 组），但那要起 dev server；这里钉住纯逻辑，
// 包括探针做不到的两条：**未知执行器 id** 与 **并发/缓存去重**。
//
// ⚠️ vitest.setup.ts 把 `@/lang/static` 的 $t mock 成 identity（返回 key 本身），
// 所以下面断言的是 i18n **key** 而不是中文译文 —— 这反而更严：
// 它顺手证明了这句文案走的是 i18n，而不是硬编码在 store 里的中文字符串。
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useToolsStore } from './toolsStore'

const UNSET_KEY = '@42BB9:未在配置中指定'
const STATE_SOURCE_KEY = '@42BB9:CLI 内最近使用'

const MODELS = {
  claude: { name: 'deepseek-v4.1-flash', detail: 'claude-sonnet-5[1M]', provider: 'http://127.0.0.1:15721', source: null },
  codex: { name: 'gpt-6-astra', detail: null, provider: 'kakouai', source: null },
  opencode: null, // 两处来源都没有：配置文件没写，CLI state 里也没有
}

/** 把 /api/workbench/executor-models 固定成给定响应；其余请求给个空成功 */
function stubModels(payload: unknown, { status = 200 } = {}) {
  const mock = vi.fn(async (url: string) => {
    if (String(url).includes('/api/workbench/executor-models')) {
      return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

describe('toolsStore 执行器模型', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.unstubAllGlobals()
  })

  test('还没探测到：三态是 unknown，文案一律空串（不先闪一句"未配置"）', () => {
    const s = useToolsStore()
    expect(s.executorModelState('claude')).toEqual({ status: 'unknown' })
    expect(s.executorModelText('claude')).toBe('')
    expect(s.executorModelDetail('claude')).toBe('')
  })

  test('探测成功：有模型的 set、没配的 unset，文案各归其位', async () => {
    stubModels({ success: true, models: MODELS })
    const s = useToolsStore()
    await s.fetchExecutorModels()

    expect(s.executorModelState('claude')).toEqual({ status: 'set', info: MODELS.claude })
    expect(s.executorModelText('claude')).toBe('deepseek-v4.1-flash')
    // 次要信息是「别名 · 服务商」，不含模型名本身（模型名由 executorModelText 给）
    expect(s.executorModelDetail('claude')).toBe('claude-sonnet-5[1M] · http://127.0.0.1:15721')

    expect(s.executorModelState('opencode')).toEqual({ status: 'unset' })
    expect(s.executorModelText('opencode')).toBe(UNSET_KEY)
    expect(s.executorModelDetail('opencode')).toBe('')

    // codex 只有模型名 + 服务商，没有第二层别名
    expect(s.executorModelText('codex')).toBe('gpt-6-astra')
    expect(s.executorModelDetail('codex')).toBe('kakouai')
  })

  test('未知执行器 id（老 job 的 agent 字段）按 unset 处理，不落到 undefined 上装死', async () => {
    stubModels({ success: true, models: MODELS })
    const s = useToolsStore()
    await s.fetchExecutorModels()
    expect(s.executorModelState('gemini')).toEqual({ status: 'unset' })
    expect(s.executorModelState(null)).toEqual({ status: 'unset' })
    expect(s.executorModelState(undefined)).toEqual({ status: 'unset' })
  })

  test('接口报错（success=false）时保持 unknown —— 不把"没问到"写成"没配置"', async () => {
    stubModels({ success: false }, { status: 500 })
    const s = useToolsStore()
    await s.fetchExecutorModels()
    expect(s.executorModelState('claude')).toEqual({ status: 'unknown' })
    expect(s.executorModelText('claude')).toBe('')
  })

  test('网络异常同样保持 unknown，且不往外抛', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const s = useToolsStore()
    await expect(s.fetchExecutorModels()).resolves.toBeUndefined()
    expect(s.executorModelState('claude')).toEqual({ status: 'unknown' })
  })

  test('后端给了脏数据时不显示半截（名字是空串/不是对象 → 一律当没配）', async () => {
    stubModels({ success: true, models: { claude: { name: '' }, codex: {}, opencode: 'not-an-object' } })
    const s = useToolsStore()
    await s.fetchExecutorModels()
    expect(s.executorModelText('claude')).toBe(UNSET_KEY)
    expect(s.executorModelText('codex')).toBe(UNSET_KEY)
    expect(s.executorModelText('opencode')).toBe(UNSET_KEY)
  })

  test('来源是 CLI 内 state 时标出来源：模型名照常显示，detail 说明它从哪来', async () => {
    // opencode 的 TUI 选择不写回配置文件，模型只存在于它自己的 state 里。
    // 这时候必须显示真实模型名（而不是"未在配置中指定"），并在 detail 里说清来源 ——
    // 否则用户看到模型名第一反应是"我配置里没写啊"。
    stubModels({
      success: true,
      models: {
        claude: null,
        codex: null,
        opencode: { name: 'opencode-go/space-bunny-free (max)', detail: null, provider: null, source: 'state' },
      },
    })
    const s = useToolsStore()
    await s.fetchExecutorModels()
    expect(s.executorModelText('opencode')).toBe('opencode-go/space-bunny-free (max)')
    expect(s.executorModelDetail('opencode')).toBe(STATE_SOURCE_KEY)
  })

  test('来源是配置文件时不加来源标签（就是"配置里写的"，无需额外说明）', async () => {
    stubModels({
      success: true,
      models: {
        claude: null,
        codex: null,
        opencode: { name: 'a/b', detail: null, provider: null, source: 'config' },
      },
    })
    const s = useToolsStore()
    await s.fetchExecutorModels()
    expect(s.executorModelDetail('opencode')).toBe('')
  })

  test('未知来源值不显示来源标签（将来后端加新来源时前端不瞎猜）', async () => {
    stubModels({
      success: true,
      models: {
        claude: null,
        codex: null,
        opencode: { name: 'a/b', detail: null, provider: null, source: 'something-new' },
      },
    })
    const s = useToolsStore()
    await s.fetchExecutorModels()
    expect(s.executorModelText('opencode')).toBe('a/b')
    expect(s.executorModelDetail('opencode')).toBe('')
  })

  test('TTL 内重复调用不重发；force 时重探', async () => {
    const fetchMock = stubModels({ success: true, models: MODELS })
    const s = useToolsStore()
    await s.fetchExecutorModels()
    await s.fetchExecutorModels()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await s.fetchExecutorModels(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('并发调用只发一次请求（三处下拉同时挂载时的常态）', async () => {
    const fetchMock = stubModels({ success: true, models: MODELS })
    const s = useToolsStore()
    await Promise.all([s.fetchExecutorModels(), s.fetchExecutorModels(), s.fetchExecutorModels()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

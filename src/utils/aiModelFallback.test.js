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
// src/utils/aiModelFallback.js 单元测试（node:test 内置）。
//
// 这一层是为了修「默认模型额度用完，AI 启动建议 / 差异说明 / 提交信息全不可用」
// 而抽出来的，所以把口径钉死：
//   1) 候选链默认模型排第一，其余按配置顺序；同一 baseURL+model 只算一个
//   2) 前一个失败才换下一个；用户取消（Abort）和 isFatal 判定的失败不换
//   3) 全都失败时错误里要能看到每个模型各自的报错，而不是只剩最后一条
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_FALLBACK_MODELS,
  buildModelFallbackChain,
  isAbortLikeError,
  modelLabel,
  runWithModelFallback,
} from './aiModelFallback.js'

const A = { id: 'a', name: '模型 A', model: 'a-model', baseURL: 'https://a.test/v1', apiKey: 'k' }
const B = { id: 'b', name: '模型 B', model: 'b-model', baseURL: 'https://b.test/v1', apiKey: 'k' }
const C = { id: 'c', name: '模型 C', model: 'c-model', baseURL: 'https://c.test/v1', apiKey: 'k' }
const D = { id: 'd', name: '模型 D', model: 'd-model', baseURL: 'https://d.test/v1', apiKey: 'k' }
const DEFAULT = { ...B, isDefault: true }

test('buildModelFallbackChain: 默认模型排第一，其余按配置顺序', () => {
  const chain = buildModelFallbackChain([A, DEFAULT, C])
  assert.deepEqual(chain.map(m => m.id), ['b', 'a', 'c'])
})

test('buildModelFallbackChain: 没有默认模型时保持原顺序', () => {
  const chain = buildModelFallbackChain([A, B])
  assert.deepEqual(chain.map(m => m.id), ['a', 'b'])
})

test('buildModelFallbackChain: defaultFirst=false 时不重排（用户显式指定打头）', () => {
  const chain = buildModelFallbackChain([A, DEFAULT], { defaultFirst: false })
  assert.deepEqual(chain.map(m => m.id), ['a', 'b'])
})

test('buildModelFallbackChain: 同一端点+模型只保留一条，缺字段的条目被丢掉', () => {
  const dup = { id: 'a2', name: 'A 重复', model: 'a-model', baseURL: 'https://a.test/v1/' }
  const noKey = { id: 'x', model: 'x-model' }
  const noModel = { id: 'y', baseURL: 'https://y.test/v1' }
  const chain = buildModelFallbackChain([A, dup, noKey, noModel, B])
  assert.deepEqual(chain.map(m => m.id), ['a', 'b'])
})

test(`buildModelFallbackChain: 默认最多 ${MAX_FALLBACK_MODELS} 个候选`, () => {
  const chain = buildModelFallbackChain([A, B, C, D])
  assert.equal(chain.length, MAX_FALLBACK_MODELS)
  // limit<=0 表示不限
  assert.equal(buildModelFallbackChain([A, B, C, D], { limit: 0 }).length, 4)
})

test('runWithModelFallback: 第一个就成功时不调用后面的，也不触发 onFallback', async () => {
  const calls = []
  const fallbacks = []
  const { result, model } = await runWithModelFallback(
    [A, B],
    async (m) => { calls.push(m.id); return `ok-${m.id}` },
    { onFallback: (info) => fallbacks.push(info) }
  )
  assert.equal(result, 'ok-a')
  assert.equal(model.id, 'a')
  assert.deepEqual(calls, ['a'])
  assert.deepEqual(fallbacks, [])
})

test('runWithModelFallback: 默认模型失败后换下一个，并把失败原因传出去', async () => {
  const calls = []
  const fallbacks = []
  const { result, model } = await runWithModelFallback(
    [A, B],
    async (m) => {
      calls.push(m.id)
      if (m.id === 'a') throw new Error('HTTP 429 额度不足')
      return `ok-${m.id}`
    },
    { onFallback: (info) => fallbacks.push(info) }
  )
  assert.equal(result, 'ok-b')
  assert.equal(model.id, 'b')
  assert.deepEqual(calls, ['a', 'b'])
  assert.equal(fallbacks.length, 1)
  assert.equal(fallbacks[0].from.id, 'a')
  assert.equal(fallbacks[0].to.id, 'b')
  assert.match(fallbacks[0].error.message, /429/)
})

test('runWithModelFallback: 全都失败时错误里带上每个模型的报错', async () => {
  await assert.rejects(
    () => runWithModelFallback(
      [A, B],
      async (m) => { throw new Error(`${m.id} 挂了`) }
    ),
    (err) => {
      assert.match(err.message, /模型 A/)
      assert.match(err.message, /模型 B/)
      assert.match(err.message, /a 挂了/)
      assert.match(err.message, /b 挂了/)
      assert.equal(err.attempts.length, 2)
      return true
    }
  )
})

test('runWithModelFallback: 只试了一个模型时原样抛（保持各调用点原有文案）', async () => {
  const boom = new Error('HTTP 401')
  await assert.rejects(
    () => runWithModelFallback([A], async () => { throw boom }),
    (err) => err === boom
  )
})

test('runWithModelFallback: 用户取消不换模型', async () => {
  const abort = new Error('aborted')
  abort.name = 'AbortError'
  const calls = []
  await assert.rejects(
    () => runWithModelFallback(
      [A, B],
      async (m) => { calls.push(m.id); throw abort }
    ),
    (err) => err === abort
  )
  assert.deepEqual(calls, ['a'], 'Abort 之后不该再用下一个模型续上')
})

test('runWithModelFallback: isFatal 返回 true 时立刻收手', async () => {
  const calls = []
  await assert.rejects(
    () => runWithModelFallback(
      [A, B],
      async (m) => { calls.push(m.id); throw new Error('stream 中途断了') },
      { isFatal: () => true }
    ),
    /stream 中途断了/
  )
  assert.deepEqual(calls, ['a'])
})

test('runWithModelFallback: 空候选链抛「未配置 AI 模型」', async () => {
  await assert.rejects(() => runWithModelFallback([], async () => 'x'), /未配置 AI 模型/)
})

test('isAbortLikeError / modelLabel 的基本口径', () => {
  assert.equal(isAbortLikeError({ name: 'AbortError' }), true)
  assert.equal(isAbortLikeError({ code: 'ERR_CANCELED' }), true)
  assert.equal(isAbortLikeError(new Error('HTTP 500')), false)
  assert.equal(modelLabel({ name: '自动分类', model: 'x' }), '自动分类')
  assert.equal(modelLabel({ model: 'x' }), 'x')
  assert.equal(modelLabel({}), '未命名模型')
})

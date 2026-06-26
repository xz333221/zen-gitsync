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
// src/utils/format.js 纯函数单元测试(node:test 内置)。
// 覆盖 formatDuration(中文时长格式)与 delay(Node 原生 sleep 替代),
// 以及从 utils/index.js 透传过来的 re-export。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatDuration, delay, parseCwdArg, truncateForHistory } from './format.js'

// ========== formatDuration ==========

test('formatDuration: 0 毫秒 → "0秒"', () => {
  assert.equal(formatDuration(0), '0秒')
})

test('formatDuration: 999 毫秒(不到 1 秒)→ "0秒" 向下取整', () => {
  // 防御:Math.floor 不能向上进位
  assert.equal(formatDuration(999), '0秒')
})

test('formatDuration: 1 秒 → "1秒"', () => {
  assert.equal(formatDuration(1000), '1秒')
})

test('formatDuration: 60 秒 → "1分0秒"(filter 不会去 0 秒)', () => {
  // 实现:`[days, hours, minutes, 'X秒'].filter(Boolean)`
  // → '0秒' 是字符串,Boolean('0秒')===true,不被 filter 掉
  // → 60 秒 = '1分0秒'
  assert.equal(formatDuration(60 * 1000), '1分0秒')
})

test('formatDuration: 1 小时 30 分 15 秒拼接正确', () => {
  const ms = (1 * 3600 + 30 * 60 + 15) * 1000
  const out = formatDuration(ms)
  assert.equal(out, '1小时30分15秒')
})

test('formatDuration: 1 天 + 2 小时 + 3 分 + 4 秒全量拼接', () => {
  const ms = (1 * 24 * 3600 + 2 * 3600 + 3 * 60 + 4) * 1000
  assert.equal(formatDuration(ms), '1天2小时3分4秒')
})

test('formatDuration: 0 分 0 小时(单秒)只显示秒', () => {
  // 验证中间 0 部分被 filter 掉,不留 "0分0秒" 噪音
  assert.equal(formatDuration(5 * 1000), '5秒')
})

test('formatDuration: 负数 / NaN / Infinity 安全回退 "0秒"', () => {
  assert.equal(formatDuration(-1), '0秒')
  assert.equal(formatDuration(NaN), '0秒')
  assert.equal(formatDuration(Infinity), '0秒')
  assert.equal(formatDuration(-Infinity), '0秒')
})

test('formatDuration: 非数字入参回退 "0秒"', () => {
  assert.equal(formatDuration('1000'), '0秒')
  assert.equal(formatDuration(null), '0秒')
  assert.equal(formatDuration(undefined), '0秒')
  assert.equal(formatDuration({}), '0秒')
})

// ========== delay ==========

test('delay: 0ms 立即 resolve', async () => {
  const start = Date.now()
  await delay(0)
  const elapsed = Date.now() - start
  assert.ok(elapsed < 50, `0ms delay 应基本立即返回,实际 ${elapsed}ms`)
})

test('delay: 实际等待 ≥ 指定毫秒数', async () => {
  const start = Date.now()
  await delay(80)
  const elapsed = Date.now() - start
  assert.ok(elapsed >= 75, `delay(80) 应至少等 80ms,实际 ${elapsed}ms`)
})

test('delay: 负数 / 非数字入参也 resolve(不抛)', async () => {
  // setTimeout 对负数 / NaN 行为是:负数当 0,NaN 当 0,都不抛
  // 这里只验证不抛
  await delay(-1)
  await delay(NaN)
  await delay('100')
  // 全部 resolve 即通过
  assert.ok(true)
})

test('delay: 返回 Promise', () => {
  const p = delay(0)
  assert.ok(p instanceof Promise, 'delay 应返回 Promise')
  // 不 await 测试立刻完成,验证类型契约
  p.then(() => {}, () => {}) // 吞 unhandled rejection
})

// ========== parseCwdArg / truncateForHistory 透传验证 ==========

test('format.js parseCwdArg 与 utils/index.js 行为一致(透传)', () => {
  assert.equal(parseCwdArg(['--path=/foo']), '/foo')
  assert.equal(parseCwdArg([]), null)
  assert.equal(parseCwdArg(null), null)
})

test('format.js truncateForHistory 与 utils/index.js 行为一致(透传)', () => {
  // 短字符串原样返回
  assert.equal(truncateForHistory('hi', 100, '...'), 'hi')
  // 长字符串截断
  assert.equal(truncateForHistory('abcdef', 3, '...'), 'abc...')
})

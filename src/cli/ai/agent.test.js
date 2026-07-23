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
// src/cli/ai/agent.js 中 truncateDisplay(回显截断)的单元测试。
// 源自实测踩坑:git status 输出 614 字符被截断 —— 只省 14 字符没意义,
// 且切口把 "src/cli/ai/agent.js" 从中间切断显示成 "rc/cli/ai/agent.js"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { truncateDisplay } from './agent.js'

const LIMIT = 600

test('短文本原样返回', () => {
  assert.equal(truncateDisplay('hello'), 'hello')
  assert.equal(truncateDisplay(''), '')
  assert.equal(truncateDisplay(null), '')
  assert.equal(truncateDisplay(undefined), '')
})

test('只超出一点点(<200 字符)不截断 — git status 614 字符回归', () => {
  // 构造恰好超过 limit 14 字符的文本(复现实测场景)
  const text = 'x'.repeat(LIMIT + 14)
  assert.equal(truncateDisplay(text, LIMIT), text)
})

test('超过阈值才截断,且包含省略标记', () => {
  const text = 'a'.repeat(LIMIT + 500)
  const r = truncateDisplay(text, LIMIT)
  assert.match(r, /回显省略 \d+ 字符/)
  assert.ok(r.length < text.length)
})

test('切口对齐整行边界,不把路径/单词从中间切断', () => {
  // 每行 50 字符,构造 30 行的文本
  const lines = Array.from({ length: 30 }, (_, i) => `line-${String(i).padStart(2, '0')}-${'x'.repeat(41)}`)
  const text = lines.join('\n')   // 30 * 50 + 29 ≈ 1529 字符,远超 limit
  const r = truncateDisplay(text, LIMIT)
  const parts = r.split('\n')
  const markerIdx = parts.findIndex(l => l.includes('回显省略'))
  assert.ok(markerIdx > 0, '应有省略标记行')
  // 标记行之前的那行,必须是原文里的某一整行(不是半拉行)
  const headLine = parts[markerIdx - 1]
  assert.ok(lines.includes(headLine), `头部末行应为完整行,实际: ${headLine}`)
  // 标记行之后的那行,也必须是原文里的某一整行
  const tailLine = parts[markerIdx + 1]
  assert.ok(lines.includes(tailLine), `尾部首行应为完整行,实际: ${tailLine}`)
  // 尾部最后一行是原文最后一行
  assert.ok(r.endsWith(lines[lines.length - 1]))
})

test('单行超长文本也能截断(无换行可对齐时按字符截)', () => {
  const text = 'y'.repeat(LIMIT + 500)
  const r = truncateDisplay(text, LIMIT)
  assert.match(r, /回显省略/)
  assert.ok(r.startsWith('yyy'))
  assert.ok(r.endsWith('yyy'))
})

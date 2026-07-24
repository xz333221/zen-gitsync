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
import { truncateDisplay, stripStaleImages, sanitizeMessages } from './agent.js'

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

// ── stripStaleImages:多模态历史的图片瘦身 ──
test('stripStaleImages: 只保留最近一条带图消息的图片,更早的降级为占位文字', () => {
  const img = (n) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${n}` } })
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'text', text: '第一问' }, img('AAA')] },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: [{ type: 'text', text: '第二问' }, img('BBB')] },
    { role: 'assistant', content: '第二答' },
    { role: 'user', content: [{ type: 'text', text: '第三问' }, img('CCC')] },
  ]
  stripStaleImages(messages, 'zh-CN')
  // 最近一条(第三问)图片原样保留
  assert.equal(messages[5].content[1].type, 'image_url')
  // 更早的图片变成文字占位
  for (const i of [1, 3]) {
    assert.equal(messages[i].content[1].type, 'text')
    assert.match(messages[i].content[1].text, /图片/)
  }
  // 文本部件不动
  assert.equal(messages[1].content[0].text, '第一问')
  // 纯字符串 content 的消息不受影响
  assert.equal(messages[0].content, 'sys')
})

test('stripStaleImages: 没有图片时完全不动', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '纯文本问题' },
    { role: 'user', content: [{ type: 'text', text: '多部件但没图' }] },
  ]
  const snapshot = JSON.parse(JSON.stringify(messages))
  stripStaleImages(messages, 'zh-CN')
  assert.deepEqual(messages, snapshot)
})

test('stripStaleImages: en locale 用英文占位符', () => {
  const messages = [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:...' } }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:...' } }] },
  ]
  stripStaleImages(messages, 'en-US')
  assert.equal(messages[0].content[0].text, '[image omitted from history]')
  assert.equal(messages[1].content[0].type, 'image_url')
})

// ── sanitizeMessages:空 content 消毒(防止 provider 报 2013) ──
test('sanitizeMessages: assistant 空 content 转 null(带 tool_calls 场景)', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'tc1', name: 'read_file', content: 'file contents...' },
  ]
  sanitizeMessages(messages)
  assert.equal(messages[2].content, null, 'assistant 空 content 应转为 null')
  assert.ok(messages[2].tool_calls, 'tool_calls 应保留不动')
})

test('sanitizeMessages: assistant 空 content 转 null(无 tool_calls)', () => {
  const messages = [
    { role: 'assistant', content: '' },
  ]
  sanitizeMessages(messages)
  assert.equal(messages[0].content, null)
})

test('sanitizeMessages: tool 空 content 兜底为 (no output)', () => {
  const messages = [
    { role: 'tool', tool_call_id: 'tc1', name: 'run_command', content: '' },
  ]
  sanitizeMessages(messages)
  assert.equal(messages[0].content, '(no output)')
})

test('sanitizeMessages: user 空 content 兜底为空格', () => {
  const messages = [
    { role: 'user', content: '' },
  ]
  sanitizeMessages(messages)
  assert.equal(messages[0].content, ' ')
})

test('sanitizeMessages: 非空 content 不受影响', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'world' },
    { role: 'tool', tool_call_id: 'tc1', name: 'read_file', content: 'output' },
  ]
  const snapshot = JSON.parse(JSON.stringify(messages))
  sanitizeMessages(messages)
  assert.deepEqual(messages, snapshot)
})

test('sanitizeMessages: 数组 content(多模态)不受影响', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:...' } }] },
  ]
  const snapshot = JSON.parse(JSON.stringify(messages))
  sanitizeMessages(messages)
  assert.deepEqual(messages, snapshot)
})

test('sanitizeMessages: 模拟真实工具调用流程后消息数组无空 content', () => {
  // 模拟:模型只返回 tool_calls 没有文本 → 工具执行 → 下次请求
  const messages = [
    { role: 'system', content: 'sys prompt' },
    { role: 'user', content: '帮我读一下文件' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }] },
    { role: 'tool', tool_call_id: 'tc1', name: 'read_file', content: '1→hello' },
  ]
  sanitizeMessages(messages)
  // 消毒后所有消息的 content 都不应是空字符串
  for (const m of messages) {
    if (typeof m.content === 'string') {
      assert.ok(m.content.length > 0, `role=${m.role} 的 content 不应为空字符串`)
    }
  }
  assert.equal(messages[2].content, null, 'assistant 空 content 应为 null')
})

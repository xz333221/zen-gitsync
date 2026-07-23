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
// src/cli/ai/streamFilter.js 单元测试。
// 重点覆盖 SSE 分片把 <think>/</think> 标签切碎的场景 —— 这正是
// MiniMax 模型裸标签问题的根源,整标签输入反而没啥可测的。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createThinkFilter } from './streamFilter.js'

// 辅助:把一串分片喂给过滤器,返回渲染后的 {content, thinking} 全文
function runChunks(chunks) {
  const f = createThinkFilter()
  const segs = []
  for (const c of chunks) segs.push(...f.feed(c))
  segs.push(...f.flush())
  return {
    segs,
    content: segs.map(s => s.content || '').join(''),
    thinking: segs.map(s => s.thinking || '').join(''),
  }
}

test('纯文本无标签原样通过', () => {
  const r = runChunks(['你好,', '这是正文。'])
  assert.equal(r.content, '你好,这是正文。')
  assert.equal(r.thinking, '')
})

test('完整 think 块:标签剥离,内容归类 thinking', () => {
  const r = runChunks(['<think>让我想想</think>答案是 42。'])
  assert.equal(r.content, '答案是 42。')
  assert.equal(r.thinking, '让我想想')
})

test('开标签被分片切碎(<thi + nk>)也能识别', () => {
  const r = runChunks(['<thi', 'nk>思考中</thi', 'nk>正文'])
  assert.equal(r.content, '正文')
  assert.equal(r.thinking, '思考中')
})

test('闭标签跨 3 个分片也能识别', () => {
  const r = runChunks(['<think>想</', 'th', 'ink>做完'])
  assert.equal(r.content, '做完')
  assert.equal(r.thinking, '想')
})

test('正文与 think 块交替多次', () => {
  const r = runChunks(['先想<think>一</think>再说<think>二</think>完'])
  assert.equal(r.content, '先想再说完')
  assert.equal(r.thinking, '一二')
})

test('未闭合的 think 块在 flush 时按 thinking 吐出', () => {
  const r = runChunks(['前置<think>想到一半被截断'])
  assert.equal(r.content, '前置')
  assert.equal(r.thinking, '想到一半被截断')
})

test('空 think 块不产生空段干扰', () => {
  const r = runChunks(['<think></think>正文'])
  assert.equal(r.content, '正文')
  assert.equal(r.thinking, '')
})

test('逐字符投喂的极端分片', () => {
  const full = '<think>深</think>答'
  const r = runChunks([...full])
  assert.equal(r.content, '答')
  assert.equal(r.thinking, '深')
})

test('文末残留的半个开标签在 flush 时按正文吐出(不是标签)', () => {
  const r = runChunks(['正常结尾<thi'])
  assert.equal(r.content, '正常结尾<thi')
  assert.equal(r.thinking, '')
})

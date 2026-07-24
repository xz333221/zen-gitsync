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
// src/cli/ai/termui.js 单元测试:
//   - 渲染结构用注入 write 的方式收集输出,stripAnsi 后断言纯文本结构
//   - ANSI 着色本身不在断言范围(非 TTY 下 chalk 自动降级,测了也没意义)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  stripAnsi, truncateDisplay, summarizeToolArgs,
  createAssistantWriter, printToolHeader, printToolResult,
} from './termui.js'

// 收集 write 输出的辅助:返回 {text(), lines()}
function collect() {
  let buf = ''
  return {
    write: (s) => { buf += s },
    text: () => stripAnsi(buf),
    lines: () => stripAnsi(buf).split('\n'),
  }
}

// ── truncateDisplay(回归基础,主测试在 agent.test.js)──
test('truncateDisplay: 短文本原样,长文本头尾保留', () => {
  assert.equal(truncateDisplay('abc'), 'abc')
  const long = Array.from({ length: 40 }, (_, i) => `row${i}-` + 'x'.repeat(40)).join('\n')
  const r = truncateDisplay(long, 600)
  assert.match(r, /回显省略/)
  assert.ok(r.startsWith('row0'))
  assert.ok(r.trimEnd().endsWith('x'.repeat(40)))
})

// ── summarizeToolArgs ──
test('summarizeToolArgs: run_command 带 $ 前缀', () => {
  assert.equal(summarizeToolArgs('run_command', { command: 'npm test' }), '$ npm test')
})

test('summarizeToolArgs: read_file 行范围与非范围', () => {
  assert.equal(summarizeToolArgs('read_file', { path: 'a.js' }), 'a.js')
  assert.equal(
    summarizeToolArgs('read_file', { path: 'a.js', offset: 10, limit: 50 }),
    'a.js L10-59',
  )
})

test('summarizeToolArgs: write_file 显示字符数,单位可本地化', () => {
  assert.equal(summarizeToolArgs('write_file', { path: 'a.js', content: 'abcd' }), 'a.js (4 字符)')
  assert.equal(summarizeToolArgs('write_file', { path: 'a.js', content: 'abcd' }, { chars: 'chars' }), 'a.js (4 chars)')
})

test('summarizeToolArgs: 其余工具的摘要格式', () => {
  assert.equal(summarizeToolArgs('edit_file', { path: 'a.js' }), 'a.js')
  assert.equal(summarizeToolArgs('list_files', {}), '. depth=2')
  assert.equal(summarizeToolArgs('search_text', { pattern: 'foo', path: 'src' }), '/foo/ src')
})

test('summarizeToolArgs: 超长命令截断到 120 字符', () => {
  const s = summarizeToolArgs('run_command', { command: 'x'.repeat(200) })
  assert.ok(s.length <= 123)   // '$ ' 前缀 + 120 字符 + '…'
  assert.ok(s.endsWith('…'))
})

test('summarizeToolArgs: 未知工具回退 JSON,缺参数不炸', () => {
  assert.equal(summarizeToolArgs('whatever', { a: 1 }), '{"a":1}')
  assert.equal(summarizeToolArgs('run_command', undefined), '$ ')
})

// ── createAssistantWriter ──
test('writer: 思考段头部只打印一次,内容直写', () => {
  const c = collect()
  const w = createAssistantWriter({ thinkingHeader: '✻ 思考', write: c.write })
  w.writeThinking('第一段')
  w.writeThinking('第二段')
  w.finish()
  const text = c.text()
  assert.equal(text.match(/✻ 思考/g).length, 1)
  assert.ok(text.includes('第一段第二段'))
})

test('writer: showThinking=false 时丢弃思考段', () => {
  const c = collect()
  const w = createAssistantWriter({ showThinking: false, thinkingHeader: '✻ 思考', write: c.write })
  w.writeThinking('看不见')
  w.writeContent('正文\n')
  w.finish()
  const text = c.text()
  assert.ok(!text.includes('看不见'))
  assert.ok(!text.includes('✻ 思考'))
  assert.ok(text.includes('正文'))
})

test('writer: 正文首行 ⏺ 子弹头,后续行缩进对齐', () => {
  const c = collect()
  const w = createAssistantWriter({ write: c.write })
  w.writeContent('第一行\n第二行\n第三行')
  w.finish()
  const lines = c.lines()
  assert.ok(lines.some(l => l.startsWith('⏺ 第一行')))
  assert.ok(lines.some(l => l.startsWith('  第二行')))
  assert.ok(lines.some(l => l.startsWith('  第三行')))
})

test('writer: 行内 markdown — bold 标记被消费,code 反引号被消费', () => {
  const c = collect()
  const w = createAssistantWriter({ write: c.write })
  w.writeContent('这是 **加粗** 和 `代码` 混排\n')
  w.finish()
  const text = c.text()
  assert.ok(text.includes('加粗'))
  assert.ok(text.includes('代码'))
  assert.ok(!text.includes('**'), '不应残留 ** 标记')
  assert.ok(!text.includes('`'), '不应残留反引号')
})

test('writer: 标题与列表渲染', () => {
  const c = collect()
  const w = createAssistantWriter({ write: c.write })
  w.writeContent('## 标题文字\n- 列表项\n')
  w.finish()
  const text = c.text()
  assert.ok(text.includes('标题文字'))
  assert.ok(!text.includes('##'), '标题井号应被消费')
  assert.ok(text.includes('- 列表项'))
})

test('writer: 代码围栏内容带槽线,围栏标记不原样显示', () => {
  const c = collect()
  const w = createAssistantWriter({ write: c.write })
  w.writeContent('```js\nconst x = 1\n```\n围栏外\n')
  w.finish()
  const lines = c.lines()
  assert.ok(lines.some(l => l.includes('│ const x = 1')), '代码行应有 │ 槽线')
  assert.ok(!lines.some(l => l.trim() === '```js' || l.trim() === '```'), '裸围栏标记不应出现')
  assert.ok(lines.some(l => l.includes('围栏外')))
})

test('writer: ** 标记跨 chunk 也能正确渲染(行缓冲)', () => {
  const c = collect()
  const w = createAssistantWriter({ write: c.write })
  // ** 被流式分片切开:buf 里暂不渲染,等行尾到了一次性渲染
  w.writeContent('这是 *')
  w.writeContent('*加粗** 文本\n')
  w.finish()
  const text = c.text()
  assert.ok(text.includes('加粗'))
  assert.ok(!text.includes('**'))
})

test('writer: 思考→正文切换插入换行分隔', () => {
  const c = collect()
  const w = createAssistantWriter({ thinkingHeader: '✻ 思考', write: c.write })
  w.writeThinking('想了一下')
  w.writeContent('正文\n')
  w.finish()
  const text = c.text()
  assert.ok(/想了一下\n/.test(text), '思考与正文之间应有换行')
})

test('writer: 完全无输出时 finish 不产生空行', () => {
  const c = collect()
  const w = createAssistantWriter({ write: c.write })
  w.finish()
  assert.equal(c.text(), '')
})

test('writer: 头部空白行被吞掉,连续空白行合并(真实 MiniMax 输出形态)', () => {
  const c = collect()
  const w = createAssistantWriter({ write: c.write })
  // 模拟模型先吐几个空行再出正文的场景(实测 minimax-m2.7 的流式输出)
  w.writeContent('\n\n\n')
  w.writeContent('答案\n\n\n\n下一段\n')
  w.finish()
  const lines = c.lines()
  assert.equal(lines[0], '⏺ 答案', `首行应为 ⏺ 答案,实际: ${lines[0]}`)
  // "答案"与"下一段"之间最多一个空行,且空行不带缩进
  const midBlank = lines.slice(1, lines.indexOf('  下一段')).filter(l => l === '').length
  assert.ok(midBlank <= 1, `空行应被合并,实际行: ${JSON.stringify(lines)}`)
  assert.ok(lines.includes('  下一段'))
})

// ── 工具块 ──
test('printToolHeader: ⏺ + 名称 + 摘要', () => {
  const c = collect()
  printToolHeader('run_command', '$ npm test', c.write)
  const text = c.text()
  assert.ok(text.includes('⏺ run_command'))
  assert.ok(text.includes('$ npm test'))
})

test('printToolResult: 首行 ⎿,后续行 │ 槽线', () => {
  const c = collect()
  printToolResult('$ ls\n(exit 0)\nfile1\nfile2', c.write)
  const lines = c.lines()
  assert.ok(lines[0].startsWith('  ⎿  '), `首行应为 ⎿ 槽线,实际: ${lines[0]}`)
  assert.ok(lines.slice(1).every(l => l.startsWith('  │  ') || l === ''), '后续行应为 │ 槽线')
})

test('printToolResult: 超长结果被截断并含省略标记', () => {
  const c = collect()
  const long = Array.from({ length: 60 }, (_, i) => `line${i} ` + 'y'.repeat(40)).join('\n')
  printToolResult(long, c.write)
  assert.match(c.text(), /回显省略/)
})

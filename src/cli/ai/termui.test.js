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
import chalk from 'chalk'
import {
  stripAnsi, truncateDisplay, summarizeToolArgs,
  createAssistantWriter, printToolHeader, printToolResult,
  formatDuration,
  filterSlashCommands, renderSlashHintBody, parseKeyForSlashHint, SLASH_COMMANDS,
} from './termui.js'

// 测试在非 TTY 环境下跑,chalk 默认 level=0(全部降级为纯文本),会让
// inverse 反白 / chalk 着色等被吃掉。强制把 level 提到 2(256 色 + 完整 ANSI),
// 断言就能直接看 raw 字节里的 \x1b 序列;不依赖 terminal capability 检测。
chalk.level = 2

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

test('writer: 正文首行 🤖 子弹头,后续行缩进对齐', () => {
  const c = collect()
  const w = createAssistantWriter({ write: c.write })
  w.writeContent('第一行\n第二行\n第三行')
  w.finish()
  const lines = c.lines()
  assert.ok(lines.some(l => l.startsWith('🤖  第一行')))
  assert.ok(lines.some(l => l.startsWith('   第二行')))
  assert.ok(lines.some(l => l.startsWith('   第三行')))
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
  // null→content 自动在 🤖 上方加一空行,跳过空行找正文首行
  const firstContent = lines.find(l => l !== '')
  assert.equal(firstContent, '🤖  答案', `首行应为 🤖  答案,实际: ${JSON.stringify(lines)}`)
  // "答案"与"下一段"之间最多一个空行,且空行不带缩进
  const midBlank = lines.slice(1, lines.indexOf('   下一段')).filter(l => l === '').length
  assert.ok(midBlank <= 1, `空行应被合并,实际行: ${JSON.stringify(lines)}`)
  assert.ok(lines.includes('   下一段'))
})

// ── 工具块 ──
test('printToolHeader: ▶ + 名称(粗)+ 摘要(粗)', () => {
  const c = collect()
  printToolHeader('run_command', '$ npm test', c.write)
  const text = c.text()
  assert.ok(text.includes('▶  run_command'))
  assert.ok(text.includes('$ npm test'))
})

test('printToolResult: 全部行统一 │ 槽线(无 └─ 拐角)', () => {
  const c = collect()
  printToolResult('$ ls\n(exit 0)\nfile1\nfile2', c.write)
  const lines = c.lines()
  assert.ok(lines.every(l => l.startsWith('  │  ') || l === ''), `每行都应为 │ 槽线,实际: ${JSON.stringify(lines)}`)
  assert.ok(!lines.some(l => l.includes('└─')), '不应出现 └─ 拐角字符')
})

test('printToolResult: 超长结果被截断并含省略标记', () => {
  const c = collect()
  const long = Array.from({ length: 60 }, (_, i) => `line${i} ` + 'y'.repeat(40)).join('\n')
  printToolResult(long, c.write)
  assert.match(c.text(), /回显省略/)
})

// ── formatDuration ──
test('formatDuration: 毫秒级显示 ms', () => {
  assert.equal(formatDuration(0), '0ms')
  assert.equal(formatDuration(123), '123ms')
  assert.equal(formatDuration(999), '999ms')
})

test('formatDuration: 秒级显示一位小数', () => {
  assert.equal(formatDuration(1000), '1.0s')
  assert.equal(formatDuration(1500), '1.5s')
  assert.equal(formatDuration(59999), '60.0s')
})

test('formatDuration: 分钟级显示 m+s', () => {
  assert.equal(formatDuration(60000), '1m0s')
  assert.equal(formatDuration(125000), '2m5s')
  assert.equal(formatDuration(3600000), '60m0s')
})

test('formatDuration: 无效输入返回空串', () => {
  assert.equal(formatDuration(-1), '')
  assert.equal(formatDuration(NaN), '')
  assert.equal(formatDuration(Infinity), '')
  assert.equal(formatDuration(undefined), '')
})

// ── printToolResult 带耗时 ──
test('printToolResult: 传入 durationMs 时末尾追加 ⏱ 计时行', () => {
  const c = collect()
  printToolResult('hello world', c.write, 1500)
  // 去掉末尾空行(split('\n') 在末尾 \n 后产生空串)
  const lines = c.lines().filter(l => l !== '')
  const lastLine = lines[lines.length - 1]
  assert.ok(lastLine.includes('⏱'), `应包含 ⏱,实际: ${lastLine}`)
  assert.ok(lastLine.includes('1.5s'), `应包含 1.5s,实际: ${lastLine}`)
  assert.ok(lastLine.startsWith('  │  '), `计时行应与结果块同缩进,实际: ${lastLine}`)
})

test('printToolResult: 不传 durationMs 时无计时行(向后兼容)', () => {
  const c = collect()
  printToolResult('hello world', c.write)
  const text = c.text()
  assert.ok(!text.includes('⏱'), '不应包含 ⏱ 计时行')
})

// ── 斜杠命令即时提示 ──

test('filterSlashCommands: 单个 / 返回全部命令', () => {
  const got = filterSlashCommands('/', 'zh').map(m => m.cmd)
  assert.deepEqual(got, SLASH_COMMANDS.map(c => c.cmd))
})

test('filterSlashCommands: 前缀过滤,大小写不敏感', () => {
  assert.deepEqual(filterSlashCommands('/m', 'zh').map(m => m.cmd), ['/model'])
  assert.deepEqual(filterSlashCommands('/AD', 'zh').map(m => m.cmd), ['/addmodel'])
  assert.deepEqual(filterSlashCommands('/exit', 'zh').map(m => m.cmd), ['/exit'])
})

test('filterSlashCommands: 已输入空格(进入参数)时不再提示', () => {
  assert.deepEqual(filterSlashCommands('/model 2', 'zh'), [])
  assert.deepEqual(filterSlashCommands('/cd ..', 'zh'), [])
})

test('filterSlashCommands: 非 slash 输入 / 无匹配返回空', () => {
  assert.deepEqual(filterSlashCommands('hello', 'zh'), [])
  assert.deepEqual(filterSlashCommands('', 'zh'), [])
  assert.deepEqual(filterSlashCommands('/xyz', 'zh'), [])
})

test('filterSlashCommands: locale 决定说明语言', () => {
  const zh = filterSlashCommands('/help', 'zh')[0]
  const en = filterSlashCommands('/help', 'en')[0]
  assert.equal(zh.desc, '显示帮助')
  assert.equal(en.desc, 'Show help')
})

test('renderSlashHintBody: 每行含命令名与说明,空输入返回空串', () => {
  assert.equal(renderSlashHintBody([]), '')
  const body = stripAnsi(renderSlashHintBody(filterSlashCommands('/m', 'en')))
  assert.match(body, /\/model\s+List \/ switch models/)
})

test('renderSlashHintBody: 选中行整行反白,不另加 ❯ 前缀(避免反白块偏左)', () => {
  const matches = filterSlashCommands('/h', 'zh')   // 1 个: /help
  // 选中:不应有 ❯ 前缀;行首应是 2 空格 + 命令名 + padEnd + 空格 + 说明
  const rawSel = renderSlashHintBody(matches, 0)
  const bodySel = stripAnsi(rawSel)
  assert.equal(bodySel.includes('❯'), false, '选中行不应出现 ❯ 前缀')
  assert.ok(bodySel.startsWith('  /help'), '选中行应以 2 空格 + /help 开头,与未选中行起点对齐')
  // 未选中(默认):同样以 2 空格 + /help 开头
  const bodyNoSel = stripAnsi(renderSlashHintBody(matches))
  assert.ok(bodyNoSel.startsWith('  /help'), '未选中行应以 2 空格 + /help 开头')
  // raw 长度差异(反白序列加 \x1b[7m / \x1b[27m 共 10 字节)即可识别选中态
  // —— 即使非 TTY 下 chalk.inverse 自动降级,断言 raw 字节差异更稳
  const rawNoSel = renderSlashHintBody(matches)
  assert.notEqual(rawSel.length, rawNoSel.length,
    `选中行 raw 与未选中行 raw 长度应不同(inverse 加了 ANSI 序列),实际: ${rawSel.length} vs ${rawNoSel.length}`)
})

test('renderSlashHintBody: 选中行与其他行起点严格一致(无 ❯ 偏移)', () => {
  const matches = filterSlashCommands('/', 'zh')   // 全部命令
  const bodySel = stripAnsi(renderSlashHintBody(matches, 0))
  const lines = bodySel.split('\n')
  // 所有行(含选中与未选中)的视觉起点都应是 2 空格 + 命令名(无 ❯ 偏移)
  for (let i = 0; i < lines.length; i++) {
    assert.ok(
      lines[i].startsWith('  /'),
      `第 ${i} 行应以 2 空格 + 命令名开头,实际: ${JSON.stringify(lines[i])}`,
    )
    assert.equal(lines[i].includes('❯'), false, `第 ${i} 行不应含 ❯`)
  }
})

test('renderSlashHintBody: 未选中行不带 ❯ 也不带反白', () => {
  const matches = filterSlashCommands('/', 'zh')   // 全部命令
  const rawSel = renderSlashHintBody(matches, 0)
  const body = stripAnsi(rawSel)
  const lines = body.split('\n')
  // 所有行都不应出现 ❯ 前缀
  for (let i = 0; i < lines.length; i++) {
    assert.equal(lines[i].includes('❯'), false, `第 ${i} 行不应有 ❯`)
  }
})

test('renderSlashHintBody: 越界 selectedIndex 安全回退(不高亮)', () => {
  const matches = filterSlashCommands('/h', 'zh')   // 1 个: /help
  // 越界 → 应当作无选中,不应抛错也不应高亮
  const body = stripAnsi(renderSlashHintBody(matches, 99))
  assert.equal(body.includes('❯'), false, '越界 index 不应渲染 ❯ 标记')
  // selectedIndex < 0 同样安全
  const body2 = stripAnsi(renderSlashHintBody(matches, -1))
  assert.equal(body2.includes('❯'), false)
})

test('renderSlashHintBody: 默认 selectedIndex=-1 与旧行为一致(向后兼容)', () => {
  const matches = filterSlashCommands('/m', 'zh')
  // 不传 selectedIndex:不应出现 ❯
  const body = stripAnsi(renderSlashHintBody(matches))
  assert.equal(body.includes('❯'), false)
})

test('parseKeyForSlashHint: ↑↓/Tab/Enter/Esc 返回动作', () => {
  assert.equal(parseKeyForSlashHint({ name: 'up' }), 'prev')
  assert.equal(parseKeyForSlashHint({ name: 'down' }), 'next')
  assert.equal(parseKeyForSlashHint({ name: 'tab' }), 'complete')
  assert.equal(parseKeyForSlashHint({ name: 'tab', shift: true }), 'prev')
  assert.equal(parseKeyForSlashHint({ name: 'return' }), 'submit')
  assert.equal(parseKeyForSlashHint({ name: 'enter' }), 'submit')
  assert.equal(parseKeyForSlashHint({ name: 'escape' }), 'cancel')
})

test('parseKeyForSlashHint: 普通字符 / null key 返回 null(消费方透传给 readline)', () => {
  assert.equal(parseKeyForSlashHint(null), null)
  assert.equal(parseKeyForSlashHint({ name: 'a' }), null)
  assert.equal(parseKeyForSlashHint({ name: 'space' }), null)
  assert.equal(parseKeyForSlashHint({ name: 'backspace' }), null)
  assert.equal(parseKeyForSlashHint(undefined), null)
})

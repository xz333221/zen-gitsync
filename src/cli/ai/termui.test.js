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
  renderSelectableListBody, parseKeyForSelectableList,
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
  assert.deepEqual(filterSlashCommands('/n', 'zh').map(m => m.cmd), ['/new'])
  assert.deepEqual(filterSlashCommands('/res', 'zh').map(m => m.cmd), ['/resume'])
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

test('renderSlashHintBody: 选中行使用箭头标记,命令行起点对齐', () => {
  const matches = filterSlashCommands('/h', 'zh')   // 1 个: /help
  const rawSel = renderSlashHintBody(matches, 0)
  const bodySel = stripAnsi(rawSel)
  const selectedLine = bodySel.split('\n').find(line => line.includes('/help'))
  assert.ok(selectedLine.startsWith('› /help'))
  const bodyNoSel = stripAnsi(renderSlashHintBody(matches))
  const unselectedLine = bodyNoSel.split('\n').find(line => line.includes('/help'))
  assert.ok(unselectedLine.startsWith('  /help'))
  const rawNoSel = renderSlashHintBody(matches)
  assert.notEqual(rawSel.length, rawNoSel.length,
    `选中行 raw 与未选中行 raw 长度应不同,实际: ${rawSel.length} vs ${rawNoSel.length}`)
})

test('renderSlashHintBody: 所有命令行无左侧边框且对齐', () => {
  const matches = filterSlashCommands('/', 'zh')   // 全部命令
  const bodySel = stripAnsi(renderSlashHintBody(matches, 0))
  const commandLines = bodySel.split('\n').filter(line => line.includes('/'))
  assert.equal(commandLines.length, matches.length)
  for (const line of commandLines) {
    assert.equal(/[╭│╰]/.test(line), false, `命令行不应含左侧框线,实际: ${JSON.stringify(line)}`)
  }
})

test('renderSlashHintBody: 面板无标题和外层缩进,保留导航提示与显式 ANSI reset', () => {
  const matches = filterSlashCommands('/', 'zh')   // 全部命令
  const raw = renderSlashHintBody(matches, 0)
  const body = stripAnsi(raw)
  assert.ok(raw.startsWith('\x1b[0m'), '面板开头必须重置输入提示符遗留样式')
  assert.equal(body.includes('命令'), false)
  assert.ok(body.startsWith('› /help'))
  assert.match(body, /↑↓ 选择 · Enter 补全 · Esc 关闭/)
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
  assert.equal(parseKeyForSlashHint({ name: 'return' }), 'complete')
  assert.equal(parseKeyForSlashHint({ name: 'enter' }), 'complete')
  assert.equal(parseKeyForSlashHint({ name: 'escape' }), 'cancel')
})

test('parseKeyForSlashHint: 普通字符 / null key 返回 null(消费方透传给 readline)', () => {
  assert.equal(parseKeyForSlashHint(null), null)
  assert.equal(parseKeyForSlashHint({ name: 'a' }), null)
  assert.equal(parseKeyForSlashHint({ name: 'space' }), null)
  assert.equal(parseKeyForSlashHint({ name: 'backspace' }), null)
  assert.equal(parseKeyForSlashHint(undefined), null)
})

// ── 可选项列表(供 /addmodel 等交互式列表选择)──

test('renderSelectableListBody: 默认选中第一项(整行反白,起点与未选中行对齐)', () => {
  const items = [
    { label: 'OpenAI', value: 'openai' },
    { label: 'Anthropic (Claude)', value: 'anthropic' },
    { label: 'DeepSeek', value: 'deepseek' },
  ]
  const body = renderSelectableListBody(items, 0)
  const lines = stripAnsi(body).split('\n')
  assert.equal(lines.length, 3)
  // 每行视觉对齐到"缩进 + 数字 + . "结构(padStart(2) 让 1-9 编号前面再补 1 空格)
  // → "   1." / "   2." / "   3." 都是"3 个字符前导:空格+空格+空格+数字+点+空格"+ label
  // 选中行(反白)也用同样的"  "前缀,不能因为反白就丢掉缩进(否则反白块起点会偏左)
  for (const l of lines) {
    assert.match(l, /^ +\d+\. /, `每行应以"缩进 + 标号 + . "开头: ${JSON.stringify(l)}`)
  }
  // 进一步:每行的"前导列宽"(即 'padStart(2) 后的数字 + . ' 之前的所有字符)长度一致,
  // 才能保证反白块的左缘跟未选中行的左缘对齐(这是 renderSlashHintBody 同款设计)
  const indentCols = lines.map(l => l.indexOf('.') + 1)   // 标号结束列
  assert.ok(indentCols.every(c => c === indentCols[0]),
    `每行标号结束列应一致(选中行不能比未选中行更长/更短): ${JSON.stringify(indentCols)}`)
  assert.ok(lines[0].includes('OpenAI'))
  assert.ok(lines[1].includes('Anthropic (Claude)'))
  assert.ok(lines[2].includes('DeepSeek'))
  // raw 中:选中行含 inverse(\x1b[7m),未选中行不含
  const rawLines = body.split('\n')
  assert.match(rawLines[0], /\x1b\[7m/, '选中行首行应含 inverse')
  assert.ok(!rawLines[1].includes('\x1b[7m'), '未选中行不应含 inverse')
  assert.ok(!rawLines[2].includes('\x1b\[7m'), '未选中行不应含 inverse')
})

test('renderSelectableListBody: selectedIndex 切换,反白行随之改变', () => {
  const items = [
    { label: 'A', value: 'a' },
    { label: 'B', value: 'b' },
    { label: 'C', value: 'c' },
  ]
  // 选中中间
  const sel = renderSelectableListBody(items, 1)
  const rawLines = sel.split('\n')
  assert.ok(!rawLines[0].includes('\x1b[7m'), '首行 A 不应被反白')
  assert.match(rawLines[1], /\x1b\[7m/, '中间行 B 应被反白')
  assert.ok(!rawLines[2].includes('\x1b[7m'), '末行 C 不应被反白')
})

test('renderSelectableListBody: selectedIndex 越界(<0 或 >=total)静默回退为 0', () => {
  const items = [{ label: 'X', value: 'x' }, { label: 'Y', value: 'y' }]
  // 负数
  assert.match(
    renderSelectableListBody(items, -1).split('\n')[0],
    /\x1b\[7m/,
    '负索引应回退为 0,首行反白',
  )
  // 超出范围
  assert.match(
    renderSelectableListBody(items, 99).split('\n')[0],
    /\x1b\[7m/,
    '超出范围应回退为 0,首行反白',
  )
  // 非整数
  assert.match(
    renderSelectableListBody(items, 1.5).split('\n')[0],
    /\x1b\[7m/,
    '非整数应回退为 0,首行反白',
  )
})

test('renderSelectableListBody: extraOptionLabel 出现且选中时也是整行反白', () => {
  const items = [{ label: 'A', value: 'a' }]
  // 选中 extra(items.length = 1)
  const sel = renderSelectableListBody(items, 1, 'Custom')
  const lines = stripAnsi(sel).split('\n')
  assert.equal(lines.length, 2)
  assert.ok(lines[0].includes('A'))
  assert.ok(lines[1].includes('0'), 'extra 应显示 0 号')
  assert.ok(lines[1].includes('Custom'))
  // raw 中 extra 是反白行
  assert.match(sel.split('\n')[1], /\x1b\[7m/, 'extra 项选中时也应反白')
})

test('renderSelectableListBody: extraOptionLabel 未选中时是 dim 灰,无反白', () => {
  const items = [{ label: 'A', value: 'a' }]
  const sel = renderSelectableListBody(items, 0, 'Custom')
  // standard 行反白,extra 行不反白
  const rawLines = sel.split('\n')
  assert.match(rawLines[0], /\x1b\[7m/, '标准行应反白')
  assert.ok(!rawLines[1].includes('\x1b[7m'), 'extra 行未选中时不应反白')
  // dim 灰用 \x1b[2m 或 grayscale 序列,宽松断言含 \x1b
  assert.match(rawLines[1], /\x1b\[/, 'extra 行应用 dim 着色')
})

test('renderSelectableListBody: 空 items + 无 extra → 返回空串(无渲染)', () => {
  assert.equal(renderSelectableListBody([], 0), '')
  assert.equal(renderSelectableListBody([], 0, undefined), '')
  assert.equal(renderSelectableListBody(undefined, 0), '')
})

test('parseKeyForSelectableList: ↑↓/Enter/Esc/Ctrl+C 返回动作', () => {
  assert.equal(parseKeyForSelectableList({ name: 'up' }), 'prev')
  assert.equal(parseKeyForSelectableList({ name: 'down' }), 'next')
  assert.equal(parseKeyForSelectableList({ name: 'return' }), 'confirm')
  assert.equal(parseKeyForSelectableList({ name: 'enter' }), 'confirm')
  assert.equal(parseKeyForSelectableList({ name: 'escape' }), 'cancel')
  // Ctrl+C 也视作取消
  assert.equal(parseKeyForSelectableList({ name: 'c', ctrl: true }), 'cancel')
})

test('parseKeyForSelectableList: Tab 视作 next,Shift+Tab 视作 prev(同 slash hint)', () => {
  assert.equal(parseKeyForSelectableList({ name: 'tab' }), 'next')
  assert.equal(parseKeyForSelectableList({ name: 'tab', shift: true }), 'prev')
})

test('parseKeyForSelectableList: 数字键 0..9 返回 jump:N(数字直跳)', () => {
  assert.equal(parseKeyForSelectableList({ name: '1' }), 'jump:1')
  assert.equal(parseKeyForSelectableList({ name: '5' }), 'jump:5')
  assert.equal(parseKeyForSelectableList({ name: '9' }), 'jump:9')
  assert.equal(parseKeyForSelectableList({ name: '0' }), 'jump:0')
})

test('parseKeyForSelectableList: 其他字符 / null / undefined 返回 null(透传给 readline)', () => {
  assert.equal(parseKeyForSelectableList(null), null)
  assert.equal(parseKeyForSelectableList(undefined), null)
  assert.equal(parseKeyForSelectableList({ name: 'a' }), null)
  assert.equal(parseKeyForSelectableList({ name: 'space' }), null)
  assert.equal(parseKeyForSelectableList({ name: 'backspace' }), null)
  // Ctrl+(非 c) 不视作取消
  assert.equal(parseKeyForSelectableList({ name: 'd', ctrl: true }), null)
})

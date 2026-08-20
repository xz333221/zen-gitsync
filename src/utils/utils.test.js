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
// utils/index.js 中暴露的工具函数测试(node:test 内置)。
// 覆盖 truncateForHistory(surrogate-pair 安全截断)+ exec_exit(字符串 'false' 回归)
// + coloredLog 表格化输出的边框对齐。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import chalk from 'chalk'
import stringWidth from 'string-width'
import { truncateForHistory, exec_exit, coloredLog } from './index.js'

// chalk 在非 TTY 下 level=0 会把所有着色降级为空串,影响 stripAnsi 后长度计算;
// 显式提升到 level=2 让 \x1b 序列可见但断言统一走 stripAnsi 拿纯文本。
chalk.level = 2

// ========== truncateForHistory ==========

test('truncateForHistory: 短字符串原样返回', () => {
  assert.equal(truncateForHistory('hello', 100, '...[t]'), 'hello')
})

test('truncateForHistory: 长度等于 limit 原样返回', () => {
  // 边界条件:不超 limit 就保持原状
  assert.equal(truncateForHistory('hello', 5, '...[t]'), 'hello')
})

test('truncateForHistory: 长 ASCII 字符串按 limit 截断 + suffix', () => {
  const out = truncateForHistory('abcdefghijklmnop', 10, '...[t]')
  assert.equal(out, 'abcdefghij...[t]')
})

test('truncateForHistory: 不会切断 UTF-16 代理对(emoji)', () => {
  // 🦄 = U+1F984,UTF-16 编码是 0xD83E 0xDD84(一对 surrogate)。
  // 如果 limit=1,substring(0,1) 会拿到 0xD83E(孤立 high surrogate),
  // 截断函数应识别并回退 1 位,返回 suffix。
  const out = truncateForHistory('🦄hello', 1, '...[t]')
  // 不应包含未配对的 high surrogate
  assert.ok(!out.startsWith('\uD83E'), '不应以孤立 high surrogate 开头')
  assert.ok(out.endsWith('...[t]'), '应以 suffix 收尾')
})

test('truncateForHistory: 完整 emoji 不会被切坏', () => {
  // 🦄🐢🐲 = 3 个 supplementary plane 字符,每个 2 码元,共 6 码元
  // limit=7 → cutAt=7,正好停在 'r' 上,完整保留 3 emoji
  const out = truncateForHistory('🦄🐢🐲rest', 7, '...[t]')
  // 高低位 surrogate 总是成对出现 → 数 codepoint 数应等于 emoji 数
  // 不应出现奇数个 surrogate(否则有孤立的)
  const codeUnits = [...out].map(c => c.codePointAt(0))
  const highSurrogates = codeUnits.filter(c => c >= 0xD800 && c <= 0xDBFF).length
  const lowSurrogates = codeUnits.filter(c => c >= 0xDC00 && c <= 0xDFFF).length
  assert.equal(highSurrogates, lowSurrogates, 'high/low surrogate 必须成对')
  assert.ok(out.startsWith('🦄🐢🐲'), '前 3 个 emoji 应完整保留')
  assert.ok(out.endsWith('...[t]'))
})

test('truncateForHistory: 截断位置恰好在 emoji 边界时回退', () => {
  // helper: 数 surrogate 是否成对(无孤立)
  const checkPaired = (s) => {
    const codeUnits = [...s].map(c => c.codePointAt(0))
    const high = codeUnits.filter(c => c >= 0xD800 && c <= 0xDBFF).length
    const low = codeUnits.filter(c => c >= 0xDC00 && c <= 0xDFFF).length
    return high === low
  }
  // 🦄 = 2 码元,limit=2 想保留前 2 码元 → 完整 emoji → 不回退
  const out1 = truncateForHistory('🦄hello', 2, '...[t]')
  assert.ok(out1.startsWith('🦄'), 'limit=2 应保留完整 emoji')
  assert.ok(checkPaired(out1), '应无孤立 surrogate')
  // limit=3 想保留前 3 码元 = 高+低+'h',emoji 已完整,直接切
  const out2 = truncateForHistory('🦄hello', 3, '...[t]')
  assert.ok(out2.startsWith('🦄h'), 'limit=3 应保留 emoji + 后续字符')
  assert.ok(checkPaired(out2), '应无孤立 surrogate')
})

test('truncateForHistory: 中日韩 BMP 字符不被切断(单码元)', () => {
  // 中文 = BMP 字符,每个 1 码元,substring 不会切坏
  // '你好世界你好世界' 共 10 字符,substring(0, 6) = '你好世界你好'
  const out = truncateForHistory('你好世界你好世界', 6, '...[t]')
  assert.equal(out, '你好世界你好' + '...[t]')
})

test('truncateForHistory: 非字符串输入安全返回原值', () => {
  // 防御:execGitCommand 失败时 stdout/stderr 可能 undefined
  assert.equal(truncateForHistory(undefined, 100, '...[t]'), undefined)
  assert.equal(truncateForHistory(null, 100, '...[t]'), null)
  assert.equal(truncateForHistory(123, 100, '...[t]'), 123)
})

test('truncateForHistory: limit=0 / 负数返回原值(防御退化)', () => {
  // limit<=0 没有合理的"保留 N 码元"语义,直接原样返回,避免误返回空+suffix
  assert.equal(truncateForHistory('abc', 0, '...[t]'), 'abc')
  assert.equal(truncateForHistory('abc', -1, '...[t]'), 'abc')
})

// ========== exec_exit ==========

test('exec_exit: 显式 true 触发 process.exit', () => {
  const original = process.exit
  let exitCode = null
  process.exit = (code) => {
    exitCode = code
    // 不真退出,抛个特殊标记让测试断言
    const e = new Error('__test_exit_called__')
    e.__isExitStub = true
    throw e
  }
  try {
    try {
      exec_exit(true)
    } catch (e) {
      assert.ok(e.__isExitStub, '应调用 process.exit')
    }
    assert.equal(exitCode, undefined, 'process.exit 默认无参')
  } finally {
    process.exit = original
  }
})

test('exec_exit: false 不退出', () => {
  const original = process.exit
  let called = false
  process.exit = () => {
    called = true
    const e = new Error('__test_exit_called__')
    e.__isExitStub = true
    throw e
  }
  try {
    exec_exit(false)
    assert.equal(called, false, 'false 不应触发 exit')
  } finally {
    process.exit = original
  }
})

test('exec_exit: 字符串 "false" 不退出(回归)', () => {
  // 修复前:if (exit) 会把 'false' 当 true → 错误退出
  // 修复后:if (exit === true) 只接受 boolean true
  const original = process.exit
  let called = false
  process.exit = () => {
    called = true
    const e = new Error('__test_exit_called__')
    e.__isExitStub = true
    throw e
  }
  try {
    exec_exit('false')
    assert.equal(called, false, '字符串 "false" 不应触发 exit')
  } finally {
    process.exit = original
  }
})

test('exec_exit: 字符串 "true" 也不退出(严格 boolean 契约)', () => {
  // 修复策略:严格 === true,任何非 boolean true 都不退,
  // 包括 "true" / 1 / {} 等 truthy 值 — 防止调用方传字符串/数字的歧义
  const original = process.exit
  let called = false
  process.exit = () => {
    called = true
    const e = new Error('__test_exit_called__')
    e.__isExitStub = true
    throw e
  }
  try {
    exec_exit('true')
    assert.equal(called, false, '字符串 "true" 不应触发 exit')
    exec_exit(1)
    assert.equal(called, false, '数字 1 不应触发 exit')
    exec_exit({})
    assert.equal(called, false, '空对象不应触发 exit')
  } finally {
    process.exit = original
  }
})

test('exec_exit: undefined / null 不退出', () => {
  const original = process.exit
  let called = false
  process.exit = () => {
    called = true
    const e = new Error('__test_exit_called__')
    e.__isExitStub = true
    throw e
  }
  try {
    exec_exit(undefined)
    exec_exit(null)
    exec_exit(0)
    exec_exit('')
    assert.equal(called, false, 'falsy 值不应触发 exit')
  } finally {
    process.exit = original
  }
})

// ========== coloredLog 表格边框对齐 ==========
//
// tableLog 复刻旧版 coloredLog 的盒式边框 ┌─┐│├─┤└─┘,每行显示宽 = terminalWidth。
// 历史 bug:header 行 `padRight(headLabel, 2)` 多扣了 2 字符 + 公式里 -3 多扣 1 字符,
// 导致右边框 │ 比顶边框 ┐ 早 3 格。回归测试:5 行显示宽必须相等。
//
// 关键:测试断言用显示宽(stringWidth),不是字符数(length)。
// "─" 在 string-width 库里按 1 字符计(等同 box-drawing 不是 CJK),
// 但中日韩是 2 字符。混排字符串的 length 和 stringWidth 不一致,
// 用 length 断言会把 "字符数 74 / 显示宽 80" 这种"终端上正确对齐"的行判失败。

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '')
// 显示宽(等同 string-width 库):中日韩 / emoji 计 2,其它 1。用于断言终端视觉对齐。
const displayWidth = (s) => stringWidth(stripAnsi(s))

function captureColoredLog(columns, headLabel, content) {
  // tableLog 用 process.stdout.columns 定框宽,mock 一个确定值便于断言
  const originalCols = Object.getOwnPropertyDescriptor(process.stdout, 'columns')
  Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true })
  const captured = []
  const originalLog = console.log
  console.log = (s) => { captured.push(String(s)) }
  try {
    coloredLog(headLabel, content)
  } finally {
    console.log = originalLog
    if (originalCols) {
      Object.defineProperty(process.stdout, 'columns', originalCols)
    } else {
      delete process.stdout.columns
    }
  }
  return captured
}

test('coloredLog: 五行显示宽相等,header 右边框与 ┐ 对齐(回归)', () => {
  const lines = captureColoredLog(80, '> rev-parse --show-toplevel', 'D:/xz_workspace/ai-model-form')
  // 4 行边框(顶/header/中/底)+ 1 行内容 = 5
  assert.equal(lines.length, 5, `4 边框 + 1 内容 = 5,实际 ${lines.length}`)
  const widths = lines.map(displayWidth)
  // 5 行必须同显示宽,这样 │ 能竖直对齐 ┐ / ┘(等宽字体下显示宽相等 ⇒ 视觉对齐)
  assert.ok(widths.every((w) => w === widths[0]),
    `5 行显示宽应一致,实际: ${JSON.stringify(widths)}`)
  assert.equal(widths[0], 80, `终端列 80 时框宽应为 80,实际: ${widths[0]}`)
  // 顶/中/底:边框行(纯 ASCII)
  assert.ok(stripAnsi(lines[0]).startsWith('┌'), `第 1 行应以 ┌ 开头: ${stripAnsi(lines[0])}`)
  assert.ok(stripAnsi(lines[0]).endsWith('┐'), `第 1 行应以 ┐ 结尾: ${stripAnsi(lines[0])}`)
  assert.ok(stripAnsi(lines[2]).startsWith('├'), `第 3 行应以 ├ 开头: ${stripAnsi(lines[2])}`)
  assert.ok(stripAnsi(lines[2]).endsWith('┤'), `第 3 行应以 ┤ 结尾: ${stripAnsi(lines[2])}`)
  assert.ok(stripAnsi(lines[4]).startsWith('└'), `第 5 行应以 └ 开头: ${stripAnsi(lines[4])}`)
  assert.ok(stripAnsi(lines[4]).endsWith('┘'), `第 5 行应以 ┘ 结尾: ${stripAnsi(lines[4])}`)
  // header / 内容:都是 │ ... │ 结构(关键回归点 — 旧版 header 行 │ 提前 3 格)
  assert.ok(stripAnsi(lines[1]).startsWith('│'), `header 行应以 │ 开头: ${stripAnsi(lines[1])}`)
  assert.ok(stripAnsi(lines[1]).endsWith('│'), `header 行应以 │ 结尾(必须对齐到 ┐): ${stripAnsi(lines[1])}`)
  assert.ok(stripAnsi(lines[3]).startsWith('│'), `内容行应以 │ 开头: ${stripAnsi(lines[3])}`)
  assert.ok(stripAnsi(lines[3]).endsWith('│'), `内容行应以 │ 结尾: ${stripAnsi(lines[3])}`)
})

test('coloredLog: terminalWidth 顶到上限 120 时仍等宽', () => {
  // min(cols, 120) 触发:模拟大屏终端
  const lines = captureColoredLog(200, '$ git status', 'On branch main\nnothing to commit')
  // 边框 4 行(顶/header/中/底)+ 内容 2 行 = 6
  assert.equal(lines.length, 6, `4 边框 + 2 内容 = 6,实际 ${lines.length}`)
  const widths = lines.map(displayWidth)
  assert.ok(widths.every((w) => w === widths[0]),
    `所有行显示宽应一致,实际: ${JSON.stringify(widths)}`)
  assert.equal(widths[0], 120, `上限 120 时框宽应为 120,实际: ${widths[0]}`)
})

test('coloredLog: 中文 header 宽度仍对齐(stringWidth 处理宽字符)', () => {
  // 验证 stringWidth(text) 正确计算中日韩 / emoji 宽度。
  // 关键:用显示宽断言,不用字符数 — "─" 当 1 字符,但中日韩是 2 字符,
  // 字符数 != 显示宽。只有显示宽相等,终端才视觉对齐。
  const lines = captureColoredLog(80, '> 中文命令 测试', '目录: D:/中文路径')
  const widths = lines.map(displayWidth)
  assert.ok(widths.every((w) => w === widths[0]),
    `含中文的 5 行显示宽应一致,实际: ${JSON.stringify(widths)}`)
  assert.equal(widths[0], 80, `中文场景下框宽应仍为 80,实际: ${widths[0]}`)
})
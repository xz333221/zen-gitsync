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
// 覆盖 truncateForHistory(surrogate-pair 安全截断)+ exec_exit(字符串 'false' 回归)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { truncateForHistory, exec_exit } from './index.js'

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
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
// shellQuote 单元测试（node:test 内置）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shQuote, psEscape, appleEscape } from '../utils/shellQuote.js'

test('shQuote 普通字符串', () => {
  assert.equal(shQuote('hello'), "'hello'")
})

test('shQuote 单引号需要转义', () => {
  // POSIX shell: 单引号字符串里唯一需要处理的就是单引号自身
  // 关闭单引号 + 转义 + 开启单引号 = '\''
  assert.equal(shQuote("a'b"), "'a'\\''b'")
})

test('shQuote 注入字符也能合法包裹', () => {
  // POSIX shell 单引号内 $ ` " \ 都不展开,所以原样包住就是安全的
  // 函数职责只保证产出一个语法合法的单引号字符串
  const evil = '$(rm -rf /); `whoami` "$PATH" \\path'
  const quoted = shQuote(evil)
  // 必须以单引号开头和结尾,内部任何单引号都被 '\'' 转义
  assert.ok(quoted.startsWith("'"))
  assert.ok(quoted.endsWith("'"))
  // 内部裸的单引号不会破坏字符串:
  // 统计未配对的单引号数量,被正确转义的 ' 必须成对出现 '\''
  // 这里因为输入不含单引号,所以 quoted 形如 '<evil>'
  assert.equal(quoted.length, evil.length + 2)
})

test('shQuote null / undefined / number 都安全', () => {
  assert.equal(shQuote(null), "''")
  assert.equal(shQuote(undefined), "''")
  assert.equal(shQuote(42), "'42'")
})

test('shQuote 文件名场景:含空格和双引号', () => {
  // 模拟 git status --porcelain 解出的文件名
  assert.equal(shQuote('my file.txt'), "'my file.txt'")
  assert.equal(shQuote('a"b.txt'), `'a"b.txt'`)
})

test('psEscape $ 变量必须前置反引号', () => {
  // 原: $(rm -rf /)  → 期望:  `$(rm -rf /)
  // （PowerShell 双引号内 $ 会触发子表达式求值,前置 ` 取消求值）
  assert.equal(psEscape('$(rm -rf /)'), '`$(rm -rf /)')
})

test('psEscape 反引号自身先转义', () => {
  // 反引号是 PowerShell 转义符,先自身转义避免吃掉后续的转义符
  // 原: `n  → 期望: ``n
  assert.equal(psEscape('`n'), '``n')
  // 原: $`n (3 字符) → 期望: `$``n (5 字符: ` $ ` ` n)
  //   反引号先转:  $``n (4)  →  然后 $ 前置: `$``n (5)
  assert.equal(psEscape('$`n'), '`$``n')
})

test('psEscape 双引号用 "" 转义', () => {
  assert.equal(psEscape('a"b'), 'a""b')
})

test('psEscape 普通字符串不变', () => {
  assert.equal(psEscape('hello world'), 'hello world')
})

test('psEscape null / undefined → 空字符串', () => {
  assert.equal(psEscape(null), '""')
  assert.equal(psEscape(undefined), '""')
})

test('psEscape 工作目录路径 (Windows 含反斜杠和 $)', () => {
  // PowerShell 里 $env:TEMP 是变量; $ 开头的路径是注入面
  const path = '$env:TEMP\\evil$(rm).txt'
  const escaped = psEscape(path)
  // 所有 $ 必须前置反引号
  assert.ok(!escaped.match(/(?<!`)\$/), '不应有未转义的 $')
  assert.ok(escaped.includes('`$env:'))
  assert.ok(escaped.includes('`$(rm)'))
})

test('appleEscape 双引号前置反斜杠', () => {
  assert.equal(appleEscape('a"b'), 'a\\"b')
})

test('appleEscape 反斜杠先转义', () => {
  // 反斜杠要双写避免吃掉后面的 "
  assert.equal(appleEscape('a\\"b'), 'a\\\\\\"b')
})

test('appleEscape 普通字符串不变', () => {
  assert.equal(appleEscape('cd /tmp && ls'), 'cd /tmp && ls')
})

test('appleEscape null / undefined → 空字符串', () => {
  assert.equal(appleEscape(null), '""')
  assert.equal(appleEscape(undefined), '""')
})
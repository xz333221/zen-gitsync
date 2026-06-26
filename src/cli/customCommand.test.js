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
// src/cli/customCommand.js 单元测试。
// 覆盖 validateCustomCommand(输入校验)与 isCmdStrictMode(--cmd-strict 检测)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateCustomCommand, isCmdStrictMode, MAX_CUSTOM_CMD_LENGTH } from './customCommand.js'

// ========== validateCustomCommand: 入参类型 ==========

test('validateCustomCommand: 非字符串直接拒绝', () => {
  for (const bad of [null, undefined, 123, true, [], {}, Symbol('x')]) {
    const r = validateCustomCommand(bad)
    assert.equal(r.ok, false, `validateCustomCommand(${String(bad)}) 应拒绝`)
    assert.ok(r.rejectReason, '应给出拒绝原因')
  }
})

test('validateCustomCommand: 空字符串 / 纯空白拒绝', () => {
  assert.equal(validateCustomCommand('').ok, false)
  assert.equal(validateCustomCommand('   ').ok, false)
  assert.equal(validateCustomCommand('\n\t').ok, false)
  assert.match(validateCustomCommand('').rejectReason, /不能为空/)
})

// ========== validateCustomCommand: 长度限制 ==========

test('validateCustomCommand: 长度等于 MAX_CUSTOM_CMD_LENGTH 通过', () => {
  const cmd = 'echo ' + 'a'.repeat(MAX_CUSTOM_CMD_LENGTH - 5)
  assert.equal(cmd.length, MAX_CUSTOM_CMD_LENGTH)
  const r = validateCustomCommand(cmd)
  assert.equal(r.ok, true, `length=${cmd.length} 应通过`)
})

test('validateCustomCommand: 长度超过上限拒绝', () => {
  const cmd = 'echo ' + 'a'.repeat(MAX_CUSTOM_CMD_LENGTH) // +1 over
  const r = validateCustomCommand(cmd)
  assert.equal(r.ok, false)
  assert.match(r.rejectReason, /过长/)
})

// ========== validateCustomCommand: - 开头拒绝 ==========

test('validateCustomCommand: 以 - 开头的命令拒绝(避免 exec 误解析为 flag)', () => {
  for (const cmd of ['-rf /', '--help', '-v', '  -something']) {
    const r = validateCustomCommand(cmd)
    assert.equal(r.ok, false, `"${cmd}" 应被拒绝`)
    assert.match(r.rejectReason, /-/)
  }
})

// ========== validateCustomCommand: 正常命令通过 ==========

test('validateCustomCommand: 正常命令通过且无 warning', () => {
  for (const cmd of [
    'echo hello',
    'npm run dev',
    'git status',
    'ls -la',
    'echo "hello world"',
    "echo 'with quotes'",
    'cmd1 | cmd2',           // shell 管道(本地 CLI 允许)
    'cmd > out.txt',         // shell 重定向
    'echo $HOME',            // shell 变量
    'cmd && other',          // shell 列表
  ]) {
    const r = validateCustomCommand(cmd)
    assert.equal(r.ok, true, `"${cmd}" 应通过`)
    assert.equal(r.warnings.length, 0, `"${cmd}" 不应有 warning`)
  }
})

// ========== validateCustomCommand: 危险模式 warning ==========

test('validateCustomCommand: rm -<flag> / 模式 warning', () => {
  const r1 = validateCustomCommand('rm -rf /')
  assert.equal(r1.ok, true, '本地 CLI,警告而非阻止')
  assert.ok(r1.warnings.some(w => /rm/.test(w)), '应有 rm 警告')

  const r2 = validateCustomCommand('rm -fr /*')
  assert.equal(r2.ok, true)
  assert.ok(r2.warnings.some(w => /rm/.test(w)))
})

test('validateCustomCommand: fork bomb 模式 warning', () => {
  // 经典 fork bomb: :(){ :|:& };:
  const r = validateCustomCommand(':(){ :|:& };:')
  assert.equal(r.ok, true)
  assert.ok(r.warnings.some(w => /fork bomb/i.test(w)))
})

test('validateCustomCommand: chmod 777 / 模式 warning', () => {
  const r = validateCustomCommand('chmod -R 777 /')
  assert.equal(r.ok, true)
  assert.ok(r.warnings.some(w => /chmod/.test(w)))
})

test('validateCustomCommand: 普通 chmod 不 warning', () => {
  // chmod 644 a.txt 不应触发(危险模式只匹配根目录)
  const r = validateCustomCommand('chmod 644 a.txt')
  assert.equal(r.ok, true)
  assert.equal(r.warnings.length, 0)
})

test('validateCustomCommand: rm 局部文件不 warning', () => {
  // rm -rf build/ 不应触发(只匹配根目录形式)
  const r = validateCustomCommand('rm -rf build/')
  assert.equal(r.ok, true)
  assert.equal(r.warnings.length, 0)
})

// ========== isCmdStrictMode ==========

test('isCmdStrictMode: argv 含 --cmd-strict 返回 true', () => {
  assert.equal(isCmdStrictMode(['node', 'g.js', '--cmd-strict']), true)
  assert.equal(isCmdStrictMode(['--cmd=echo hi', '--cmd-strict']), true)
})

test('isCmdStrictMode: argv 不含 --cmd-strict 返回 false', () => {
  assert.equal(isCmdStrictMode(['node', 'g.js', '--cmd=echo hi']), false)
  assert.equal(isCmdStrictMode([]), false)
  // 相似名字不误匹配
  assert.equal(isCmdStrictMode(['--cmd-strict-mode']), false)
  assert.equal(isCmdStrictMode(['--strict-cmd']), false)
})

test('isCmdStrictMode: 非数组入参返回 false', () => {
  assert.equal(isCmdStrictMode(null), false)
  assert.equal(isCmdStrictMode(undefined), false)
  assert.equal(isCmdStrictMode('--cmd-strict'), false) // 字符串而非数组
})
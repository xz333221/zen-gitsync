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
// parseCwdArg 单元测试（node:test 内置）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCwdArg } from './index.js'

test('--path=<v> 形式解析', () => {
  assert.equal(parseCwdArg(['node', 'g.js', '--path=/tmp/proj']), '/tmp/proj')
})

test('--cwd=<v> 形式解析', () => {
  assert.equal(parseCwdArg(['node', 'g.js', '--cwd=E:\\project']), 'E:\\project')
})

test('--path <v> 空格分隔形式解析', () => {
  assert.equal(parseCwdArg(['node', 'g.js', '--path', '/tmp/proj']), '/tmp/proj')
})

test('--cwd <v> 空格分隔形式解析', () => {
  assert.equal(parseCwdArg(['node', 'g.js', '--cwd', '/tmp/proj']), '/tmp/proj')
})

test('没有 --path / --cwd 时返回 null', () => {
  assert.equal(parseCwdArg(['node', 'g.js', '-y', '-m', 'msg']), null)
})

test('空 argv 返回 null', () => {
  assert.equal(parseCwdArg([]), null)
})

test('非数组输入返回 null', () => {
  assert.equal(parseCwdArg(null), null)
  assert.equal(parseCwdArg(undefined), null)
  assert.equal(parseCwdArg('not array'), null)
})

test('--pathTo / --cwd-prefix 不会误匹配', () => {
  // 修复前: startsWith('--path') 会把 --pathTo=... 误判
  assert.equal(parseCwdArg(['--pathTo=/etc']), null)
  assert.equal(parseCwdArg(['--cwd-prefix=foo']), null)
  assert.equal(parseCwdArg(['--pathway=evil', '--path=/good']), '/good')
})

test('--path= 但值为空返回 null', () => {
  // 空值视为非法,解析失败
  assert.equal(parseCwdArg(['--path=']), null)
  // find() 只取第一个匹配的形参,即使后续有合法 --cwd 也不会 fallback
  // (语义明确:第一个出现的 cwd 参数生效,避免歧义)
  assert.equal(parseCwdArg(['--path=', '--cwd=/fallback']), null)
})

test('--path 后面没有参数也返回 null', () => {
  assert.equal(parseCwdArg(['--path']), null)
})

test('多个候选只取第一个', () => {
  assert.equal(parseCwdArg(['--path=/first', '--path=/second']), '/first')
})

test('混合 -y -m --path 也正确', () => {
  assert.equal(
    parseCwdArg(['node', 'g', '-y', '-m', 'fix', '--path=/repo']),
    '/repo'
  )
})

test('--cwd 优先 --path 之前出现', () => {
  // 顺序: --cwd 出现在 --path 之前,find() 取第一个,行为明确
  assert.equal(
    parseCwdArg(['--cwd=/c', '--path=/p']),
    '/c'
  )
})
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

// ========== 边界用例扩展(2026-06-26 增补) ==========

test('带空格的路径(带引号包裹)', () => {
  // POSIX/macOS 常见: --path="/Users/me/My Project"
  // 解析行为:eqIdx 取第一个 `=`,整段 `--path=` 之后保留引号本身,
  // 由下游 getCwd → process.chdir 或 exec cwd 自行去引号(shell 词法在 child_process 那层)
  assert.equal(
    parseCwdArg(['node', 'g.js', '--path="/Users/me/My Project"']),
    '"/Users/me/My Project"'
  )
})

test('带空格的路径(无引号 + 空格分隔形式)', () => {
  // --path <value> 形式,value 含空格
  assert.equal(
    parseCwdArg(['node', 'g.js', '--path', '/Users/me/My Project']),
    '/Users/me/My Project'
  )
})

test('相对路径 ./ 与 ../', () => {
  // 用户在子目录下用 --path=./repo 触发相对路径解析,
  // parseCwdArg 只做字符串切片,不解析;是否 resolve 由 getCwd 决定
  assert.equal(parseCwdArg(['--path=./repo']), './repo')
  assert.equal(parseCwdArg(['--path=../sibling']), '../sibling')
  assert.equal(parseCwdArg(['--path', './inner']), './inner')
})

test('Windows 盘符 C:\\Project 不被特殊处理', () => {
  // 解析器对盘符大小写不敏感,字符串原样返回;
  // 真正的 case-insensitive 去重在 normalizeProjectPath(config.js)层做
  assert.equal(
    parseCwdArg(['node', 'g.js', '--path=C:\\Project']),
    'C:\\Project'
  )
  assert.equal(
    parseCwdArg(['node', 'g.js', '--path=c:\\project']),
    'c:\\project'
  )
  assert.equal(
    parseCwdArg(['node', 'g.js', '--path=D:/work']),
    'D:/work'
  )
})

test('value 中嵌入等号不被截断', () => {
  // --path=/a=b → indexOf 取第一个 `=`,value 保留嵌入等号
  // 例: --path=/opt/some=weird-name
  assert.equal(
    parseCwdArg(['--path=/opt/some=weird-name']),
    '/opt/some=weird-name'
  )
  // 多重等号同理
  assert.equal(
    parseCwdArg(['--path=x=y=z']),
    'x=y=z'
  )
})

test('--path= 仅在 argv 末尾也安全返回 null', () => {
  // 防御:argv 解析不抛
  assert.equal(parseCwdArg(['--path=']), null)
})

test('argv 中混入无关 unicode 不影响解析', () => {
  // 中间混 emoji / CJK,只关心 --path 的值
  assert.equal(
    parseCwdArg(['node', 'g.js', '🚀', '--path=/repo', '中文']),
    '/repo'
  )
})

test('--path 等号紧贴无空格', () => {
  // --path=/repo(无空格) vs --path /repo(空格)
  // 行为应一致
  assert.equal(
    parseCwdArg(['--path=/repo']),
    parseCwdArg(['--path', '/repo'])
  )
})

test('重复 --path 取首个出现', () => {
  // 已经测过,这里再确认带空格的重复
  assert.equal(
    parseCwdArg(['--path=/first with space', '--path=/second']),
    '/first with space'
  )
})
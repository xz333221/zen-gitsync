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
// src/cli/ai/tools.js 单元测试 — 在系统临时目录里做真实的文件读写,
// 覆盖 write/read/edit/list/search 的往返与 run_command 的安全守卫联动。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TOOL_DEFINITIONS, executeTool } from './tools.js'

let tmpDir
const ctx = { cwd: null, onChild: null }

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'g-ai-tools-'))
  ctx.cwd = tmpDir
})

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

// ========== schema 基本形态 ==========

test('TOOL_DEFINITIONS 符合 OpenAI function calling 格式', () => {
  assert.ok(Array.isArray(TOOL_DEFINITIONS))
  assert.ok(TOOL_DEFINITIONS.length >= 5)
  for (const t of TOOL_DEFINITIONS) {
    assert.equal(t.type, 'function')
    assert.ok(t.function.name, '工具要有名字')
    assert.ok(t.function.description, '工具要有描述')
    assert.equal(t.function.parameters.type, 'object')
  }
})

// ========== write_file / read_file 往返 ==========

test('write_file 创建嵌套文件,read_file 带行号读回', async () => {
  const w = await executeTool('write_file', { path: 'src/deep/hello.txt', content: 'line1\nline2\nline3' }, ctx)
  assert.match(w, /已写入/)

  const r = await executeTool('read_file', { path: 'src/deep/hello.txt' }, ctx)
  assert.match(r, /1→line1/)
  assert.match(r, /3→line3/)
  assert.match(r, /共 3 行/)
})

test('read_file 支持 offset/limit 分段', async () => {
  const r = await executeTool('read_file', { path: 'src/deep/hello.txt', offset: 2, limit: 1 }, ctx)
  assert.match(r, /2→line2/)
  assert.doesNotMatch(r, /1→line1/)
})

test('read_file 不存在的文件返回错误字符串(不抛异常)', async () => {
  const r = await executeTool('read_file', { path: 'no-such-file.txt' }, ctx)
  assert.match(r, /^错误:/)
})

// ========== edit_file ==========

test('edit_file 唯一匹配替换成功', async () => {
  const r = await executeTool('edit_file', { path: 'src/deep/hello.txt', old_string: 'line2', new_string: 'LINE-2' }, ctx)
  assert.match(r, /已修改/)
  const content = await fs.readFile(path.join(tmpDir, 'src/deep/hello.txt'), 'utf-8')
  assert.ok(content.includes('LINE-2'))
})

test('edit_file 找不到 old_string 时报错并提示先 read_file', async () => {
  const r = await executeTool('edit_file', { path: 'src/deep/hello.txt', old_string: 'not-exist', new_string: 'x' }, ctx)
  assert.match(r, /找不到 old_string/)
})

test('edit_file 多处匹配默认拒绝,replace_all 放行', async () => {
  await executeTool('write_file', { path: 'multi.txt', content: 'a=a\nb=a' }, ctx)
  const dup = await executeTool('edit_file', { path: 'multi.txt', old_string: 'a', new_string: 'z' }, ctx)
  assert.match(dup, /不唯一/)

  const all = await executeTool('edit_file', { path: 'multi.txt', old_string: 'a', new_string: 'z', replace_all: true }, ctx)
  assert.match(all, /替换 3 处/)
})

// ========== list_files ==========

test('list_files 列出结构并跳过 node_modules', async () => {
  await fs.mkdir(path.join(tmpDir, 'node_modules/pkg'), { recursive: true })
  await fs.writeFile(path.join(tmpDir, 'node_modules/pkg/x.js'), 'x')
  const r = await executeTool('list_files', { depth: 3 }, ctx)
  assert.match(r, /src\//)
  assert.match(r, /hello\.txt/)
  assert.doesNotMatch(r, /node_modules/)
})

// ========== search_text ==========

test('search_text 能找到匹配行并带行号', async () => {
  const r = await executeTool('search_text', { pattern: 'LINE-2' }, ctx)
  assert.match(r, /hello\.txt:2:/)
})

test('search_text 支持 ext 过滤与 ignore_case', async () => {
  const miss = await executeTool('search_text', { pattern: 'LINE-2', ext: 'md' }, ctx)
  assert.match(miss, /未找到/)
  const hit = await executeTool('search_text', { pattern: 'line-2', ignore_case: true }, ctx)
  assert.match(hit, /hello\.txt/)
})

test('search_text 非法正则不抛异常', async () => {
  const r = await executeTool('search_text', { pattern: '([' }, ctx)
  assert.match(r, /正则无效/)
})

// ========== run_command ==========

test('run_command 执行成功并返回输出与退出码', async () => {
  const r = await executeTool('run_command', { command: 'echo hello-g-ai' }, ctx)
  assert.match(r, /\(exit 0\)/)
  assert.match(r, /hello-g-ai/)
})

test('run_command 非零退出也正常返回(不抛异常)', async () => {
  const r = await executeTool('run_command', { command: 'exit 3' }, ctx)
  assert.match(r, /\(exit 3\)/)
})

test('run_command 被安全守卫拦截系统级毁灭命令', async () => {
  const r = await executeTool('run_command', { command: 'rm -rf /' }, ctx)
  assert.match(r, /已拒绝执行/)
})

test('run_command 放行项目内删除操作(不被守卫拦截)', async () => {
  await fs.mkdir(path.join(tmpDir, 'junk'), { recursive: true })
  // 注意不断言 exit 0:Windows 默认 cmd.exe 没有 rm 命令,删不删得掉是 shell 的事,
  // 这里只验证安全守卫**不拦截**项目内删除(那是模型的正常工作流)
  const r = await executeTool('run_command', { command: 'rm -rf junk' }, ctx)
  assert.doesNotMatch(r, /已拒绝执行/)
})

test('run_command 不存在的 cwd 返回错误', async () => {
  const r = await executeTool('run_command', { command: 'echo x', cwd: 'no-such-dir-xyz' }, ctx)
  assert.match(r, /目录不存在/)
})

// ========== 未知工具 ==========

test('未知工具返回错误字符串并列出可用工具', async () => {
  const r = await executeTool('nope_tool', {}, ctx)
  assert.match(r, /未知工具/)
  assert.match(r, /run_command/)
})

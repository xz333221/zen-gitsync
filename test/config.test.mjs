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
// src/config.js 的契约测试(node:test 内置)。
// 重点覆盖:
//   1. normalizeProjectPath: 跨平台大小写 + 路径解析
//   2. saveConfig 错误契约(MAINT-4 修复):入参非法抛 ConfigWriteError
//
// 隔离策略(2026-08-30 修订):
//   在 import src/config.js **之前**把 USERPROFILE/HOME 指到 mkdtemp 沙箱,
//   所有读写落在临时目录,不触碰真实 ~/.git-commit-tool.json。
//
//   修订原因:本文件原先只做纯函数测试,但"saveConfig: 合法非空对象不抛
//   ConfigWriteError"这个用例会真的调 saveConfig({ defaultCommitMessage:
//   'test' }) —— 注释说"不验证是否真的写入磁盘",实际却写进了用户 home。
//   它是 2026-08-30 配置被冲掉事故的第二个污染源(config.atomic-write.test.mjs
//   是第一个)。node --test 按文件并发跑,任何一处漏沙箱都会踩到真实配置。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

// ---- 环境隔离:必须在 import src/config.js 之前完成 ----
const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'zgs-config-contract-test-'))
const savedEnv = {
  USERPROFILE: process.env.USERPROFILE,
  HOME: process.env.HOME,
  HOMEDRIVE: process.env.HOMEDRIVE,
  HOMEPATH: process.env.HOMEPATH
}
process.env.USERPROFILE = fakeHome
process.env.HOME = fakeHome
// Windows 下 os.homedir() 的兜底是 HOMEDRIVE+HOMEPATH,清掉以防 USERPROFILE 被忽略
delete process.env.HOMEDRIVE
delete process.env.HOMEPATH

after(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try { await fs.rm(fakeHome, { recursive: true, force: true }) } catch {}
})

const configMod = await import(pathToFileURL(path.join(projectRoot, 'src/config.js')).href)
// 注意:saveConfig / loadConfig 等业务函数挂在 default export 上;
// ConfigWriteError / normalizeProjectPath 是命名导出(用于测试与复用)
const { normalizeProjectPath, ConfigWriteError } = configMod
const { saveConfig } = configMod.default

// ========== normalizeProjectPath ==========

test('normalizeProjectPath: 绝对路径原样返回(非 Windows)', () => {
  // 在 Windows 下运行,会走 toLowerCase 分支,所以本测试只在 POSIX 验证语义
  if (process.platform === 'win32') {
    // Windows 下绝对路径会被小写化,跳过原样断言
    return
  }
  assert.equal(normalizeProjectPath('/usr/local/bin'), path.resolve('/usr/local/bin'))
})

test('normalizeProjectPath: 相对路径解析为绝对路径', () => {
  const out = normalizeProjectPath('./repo')
  assert.ok(path.isAbsolute(out), '相对路径应解析为绝对')
  assert.ok(out.endsWith(`${path.sep}repo`))
})

test('normalizeProjectPath: Windows 路径小写化', () => {
  if (process.platform !== 'win32') return
  // Windows 盘符大小写不敏感,统一小写
  assert.equal(normalizeProjectPath('C:\\Project'), 'c:\\project')
  assert.equal(normalizeProjectPath('c:\\project'), 'c:\\project')
})

test('normalizeProjectPath: POSIX 路径保持大小写', () => {
  if (process.platform === 'win32') return
  // macOS/Linux 默认大小写敏感,不作处理
  const out = normalizeProjectPath('/Users/Me/MyProject')
  assert.equal(out, '/Users/Me/MyProject')
})

// ========== saveConfig 错误契约(MAINT-4 修复回归) ==========

test('saveConfig: null / undefined / 字符串 / 数组入参抛 ConfigWriteError', async () => {
  for (const badInput of [null, undefined, 'not an object', 42, true, []]) {
    let thrown = null
    try {
      await saveConfig(badInput)
    } catch (e) {
      thrown = e
    }
    assert.ok(thrown, `saveConfig(${JSON.stringify(badInput)}) 应抛错`)
    assert.ok(
      thrown instanceof ConfigWriteError || thrown?.name === 'ConfigWriteError',
      `saveConfig(${JSON.stringify(badInput)}) 抛出的应是 ConfigWriteError,实际: ${thrown?.name}`
    )
  }
})

test('saveConfig: 空对象入参抛 ConfigWriteError(防止覆盖)', async () => {
  let thrown = null
  try {
    await saveConfig({})
  } catch (e) {
    thrown = e
  }
  assert.ok(thrown, 'saveConfig({}) 应抛错,防止把磁盘已有项目级配置覆盖成空')
  assert.ok(
    thrown instanceof ConfigWriteError || thrown?.name === 'ConfigWriteError',
    '抛出的应是 ConfigWriteError'
  )
  assert.match(thrown.message, /为空/, '错误信息应说明是"为空"问题')
})

test('saveConfig: 合法非空对象不抛 ConfigWriteError(可能抛别的 IO 错)', async () => {
  // 【重要】这个用例会真的走完 IO 落到磁盘 —— 但写的是文件顶部的 mkdtemp
  // 沙箱,不是用户 home。沙箱靠 USERPROFILE/HOME 注入生效,一旦被绕过,
  // config.atomic-write.test.mjs 的真实配置哨兵会失败告警。
  // 只验证入参校验已通过,走到 IO 阶段。
  // 在沙箱不可写或无 git repo 时可能抛别的错 — 捕获即可,断言"不是 ConfigWriteError(参数错)"
  let thrown = null
  try {
    await saveConfig({ defaultCommitMessage: 'test' })
  } catch (e) {
    thrown = e
  }
  if (thrown) {
    assert.ok(
      !(thrown instanceof ConfigWriteError) && thrown?.name !== 'ConfigWriteError',
      '参数校验应已通过,不应抛 ConfigWriteError,实际错: ' + thrown.message
    )
  }
  // 不抛也算通过(成功路径)
})

// ========== ConfigWriteError 形状 ==========

test('ConfigWriteError: 错误对象正确关联 cause', () => {
  const cause = new Error('underlying')
  const err = new ConfigWriteError('wrapper', cause)
  assert.equal(err.name, 'ConfigWriteError')
  assert.equal(err.message, 'wrapper')
  assert.equal(err.cause, cause)
  assert.ok(err instanceof Error)
  assert.ok(err instanceof ConfigWriteError)
})
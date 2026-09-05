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

// 配置缓存多进程一致性回归测试(2026-08-07)。
//
// 背景:src/config.js 的 _rawConfigCache 之前不感知外部进程修改 ——
// 一个 g ui 实例(独立进程)改了模型配置,另一个实例要重启才能看到。
// 修复后:缓存命中时先 fs.stat 比对 mtimeMs+size,签名变了自动重读。
//
// 隔离策略:
//   config.js 的 configPath 在模块加载时由 os.homedir() 决定。
//   本文件在 import config.js **之前**把 USERPROFILE/HOME 指到临时目录,
//   使所有读写落在 mkdtemp 沙箱里,完全不触碰真实 ~/.git-commit-tool.json。
//   (os.homedir() 在 Windows 每次调用都重读 USERPROFILE,POSIX 读 HOME,
//    因此在 import 前设置环境变量即可生效。)

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

// ---- 环境隔离:必须在 import src/config.js 之前完成 ----
const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'zgs-config-cache-test-'))
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

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const configMod = await import(pathToFileURL(path.join(projectRoot, 'src/config.js')).href)
const { invalidateRawConfigCache } = configMod
const { readRawConfigFile, writeRawConfigFile } = configMod.default

//  sanity check:模块确实把配置路径指到了 fakeHome,绝不在真实 home 上操作
const configPathInSandbox = path.join(fakeHome, '.git-commit-tool.json')

before(async () => {
  // 确认隔离生效:此时 fakeHome 里不应有配置文件
  const entries = await fs.readdir(fakeHome)
  assert.ok(!entries.includes('.git-commit-tool.json'), '测试前沙箱 home 应为空')
})

after(async () => {
  // 恢复环境变量并清理临时目录
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try { await fs.rm(fakeHome, { recursive: true, force: true }) } catch {}
})

/** 模拟外部进程直接写盘(不经过本模块,不失效本进程缓存) */
async function externalWrite(obj) {
  await fs.writeFile(configPathInSandbox, JSON.stringify(obj, null, 2), 'utf-8')
}

test('cache: 同进程内重复读 → 返回同一对象引用(缓存生效,未反复读盘)', async () => {
  invalidateRawConfigCache()
  await externalWrite({ __test_marker: 'cache-hit', padding: 'x'.repeat(64) })
  const first = await readRawConfigFile()
  const second = await readRawConfigFile()
  assert.equal(first.__test_marker, 'cache-hit')
  assert.ok(first === second, '缓存新鲜时应返回同一对象引用,而不是重新 parse 出新对象')
})

test('cache: 外部进程修改文件后 → 无需手动失效,下次读自动看到新值', async () => {
  invalidateRawConfigCache()
  await externalWrite({ __test_marker: 'before-external', padding: 'a'.repeat(32) })
  const before_ = await readRawConfigFile()
  assert.equal(before_.__test_marker, 'before-external')

  // 模拟另一个 g ui 实例写盘(注意:不调 writeRawConfigFile,以免走内部失效)
  await externalWrite({ __test_marker: 'after-external', padding: 'b'.repeat(128) })

  const after_ = await readRawConfigFile()
  assert.equal(after_.__test_marker, 'after-external', '外部写盘后应自动重读,而不是继续返回旧缓存')
  assert.ok(before_ !== after_, '重读后应是新对象')
})

test('cache: 外部进程新建文件(之前不存在)→ 下次读能感知', async () => {
  invalidateRawConfigCache()
  try { await fs.unlink(configPathInSandbox) } catch {}
  const empty = await readRawConfigFile()
  assert.deepEqual(empty, {}, '文件不存在时应返回空对象')

  await externalWrite({ __test_marker: 'created-externally', padding: 'c'.repeat(48) })
  const now = await readRawConfigFile()
  assert.equal(now.__test_marker, 'created-externally', '外部新建配置文件后应能读到')
})

test('cache: 外部进程删除文件(之前存在)→ 下次读降级为空对象而非报错', async () => {
  invalidateRawConfigCache()
  await externalWrite({ __test_marker: 'will-be-deleted', padding: 'd'.repeat(16) })
  const existed = await readRawConfigFile()
  assert.equal(existed.__test_marker, 'will-be-deleted')

  await fs.unlink(configPathInSandbox)
  const gone = await readRawConfigFile()
  assert.deepEqual(gone, {}, '文件被外部删除后应返回空对象,不应抛错')
})

test('cache: 本进程 writeRawConfigFile 写盘后 → 下次读看到最新值(原有契约不回归)', async () => {
  invalidateRawConfigCache()
  await writeRawConfigFile({ __test_marker: 'internal-write-1', padding: 'e'.repeat(24) })
  const v1 = await readRawConfigFile()
  assert.equal(v1.__test_marker, 'internal-write-1')

  await writeRawConfigFile({ __test_marker: 'internal-write-2', padding: 'f'.repeat(40) })
  const v2 = await readRawConfigFile()
  assert.equal(v2.__test_marker, 'internal-write-2')
})

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
//   使所有读写落在 mkdtemp 沙箱里,完全不触碰真实 ~/.zen-gitsync/config.json。
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
//  2026-09-18 起主配置落在统一数据目录 ~/.zen-gitsync/config.json(见 src/paths.js)
const configDirInSandbox = path.join(fakeHome, '.zen-gitsync')
const configPathInSandbox = path.join(configDirInSandbox, 'config.json')

before(async () => {
  // 确认隔离生效:此时 fakeHome 里不应有配置文件
  const entries = await fs.readdir(fakeHome)
  assert.ok(!entries.includes('.git-commit-tool.json'), '测试前沙箱 home 应为空')
  assert.ok(!entries.includes('.zen-gitsync'), '测试前沙箱 home 应为空(不该有数据目录)')
  // 本文件的 externalWrite 是"模拟别的进程直接写盘",绕过本模块的建目录逻辑,
  // 所以这里先把数据目录建出来
  await fs.mkdir(configDirInSandbox, { recursive: true })
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
  // 2026-09-18 起返回形状是 `{ projects: {} }`(而不是裸 `{}`)—— 分文件模式下
  // projects 由 projects/ 组装,loadConfig 靠 `raw.projects` 是否存在区分新旧结构,
  // 所以"空配置"也必须是带空 projects 容器的对象。契约实质不变:不抛错、无数据。
  assert.deepEqual(empty.projects, {}, '文件不存在时应返回空对象,且 projects 容器须存在')
  assert.equal(Object.keys(empty).length, 1, '空配置不该凭空多出别的顶层键')

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
  assert.deepEqual(gone.projects, {}, '文件被外部删除后应降级为空配置,不应抛错')
  assert.equal(gone.__test_marker, undefined, '删掉之后不该还能读到旧值')
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

// ========== 缓存判新鲜期间被并发失效的竞态(2026-09-18) ==========
//
// 现场报错:GUI 顶部弹 "加载锁定文件列表失败:系统配置文件JSON格式错误…原因:
// Cannot read properties of null (reading 'existed')",而磁盘上的配置其实是合法 JSON。
//
// 根因:safeLoadRaw 的命中判断是 `if (_rawConfigCache && await isRawConfigCacheFresh())`。
// isRawConfigCacheFresh 内部先 `await fs.stat`,让出事件循环;在此期间并发路径
// (writeRawConfigFile 尾部 / chdir)调用 invalidateRawConfigCache() 把模块级
// _rawConfigCache 置 null,恢复执行后再解引用 `_rawConfigCache.existed` → TypeError。
// 该 await 位于 try 之外,错误直接冒到 loadConfig,被无条件包成"JSON 格式错误"。
//
// 下面的用例用"同步发起读 → 立刻失效缓存"构造确定性交错,不依赖时序碰运气。

test('cache: 判新鲜挂起期间被失效 → 不得抛 null 解引用,而是回落实盘读(回归)', async () => {
  invalidateRawConfigCache()
  await externalWrite({ __test_marker: 'race-window', padding: 'g'.repeat(32) })
  await readRawConfigFile() // 预热:缓存 existed=true,走 stat 比对分支

  // 同步发起读 —— 会一路执行到 isRawConfigCacheFresh 里的 await fs.stat 才返回控制权
  const pending = readRawConfigFile()
  // 模拟并发写盘路径在 stat 挂起窗口内失效缓存(真实场景:另一个请求 saveConfig 落盘)
  invalidateRawConfigCache()

  await assert.doesNotReject(
    () => pending,
    '读操作在缓存判新鲜挂起期间被失效时不得抛出 TypeError'
  )
  const obj = await pending
  assert.equal(obj.__test_marker, 'race-window', '缓存失效后应回落实盘读取,而不是拿旧快照')
})

test('cache: 并发读 + 写高频交错 → 全部成功且最终值一致(真实竞态压力)', async () => {
  invalidateRawConfigCache()
  await externalWrite({ __test_marker: 'burst-0', padding: 'h'.repeat(16) })

  const tasks = []
  for (let i = 1; i <= 12; i++) {
    tasks.push(readRawConfigFile())
    tasks.push(writeRawConfigFile({ __test_marker: `burst-${i}`, padding: 'i'.repeat(16 + i) }))
  }
  const results = await Promise.allSettled(tasks)
  const rejected = results.filter(r => r.status === 'rejected')
  assert.equal(
    rejected.length,
    0,
    `并发读写不得有失败: ${rejected.map(r => r.reason?.message).join(' | ')}`
  )

  const final = await readRawConfigFile()
  assert.equal(final.__test_marker, 'burst-12', '最后一次写入应可读回')
})

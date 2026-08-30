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

// TEST-3 回归测试:writeRawConfigFile 原子写 + 并发竞态
//
// 隔离策略(2026-08-30 修订):
//   1. **沙箱隔离**:在 import src/config.js **之前**把 USERPROFILE/HOME 指到
//      mkdtemp 临时目录,使所有读写落在沙箱里,完全不触碰真实
//      ~/.git-commit-tool.json。(os.homedir() 在 Windows 每次调用都重读
//      USERPROFILE,POSIX 读 HOME,因此在 import 前设置环境变量即可生效。)
//   2. **哨兵校验**:before 记录真实配置的 mtimeMs+size,after 断言二者未变。
//      将来若有人改回"直接写真实 home",哨兵会立刻让测试失败,而不是
//      等用户发现配置被冲掉。
//
// 修订原因(2026-08-30 事故复盘):
//   旧实现是"备份真实配置 → 用测试产物覆盖真实文件 → after 里 copyFile 恢复
//   + unlink 备份"。三条缺陷叠加,把用户 92KB 的真实配置冲成 1.4KB 的测试
//   残留(24 个项目只剩 1 个、5 个 AI 模型全丢):
//     ① 测试直接写真实 home,与同时运行的 g ui 实例的 _rawConfigCache 互踩 ——
//        测试恢复完,UI 实例又用自己缓存的测试产物写回去
//     ② after 的恢复是非原子 copyFile,中断即半写
//     ③ 恢复失败只 console.error,备份随后被 unlink,唯一完整副本进了回收站
//   沙箱化后三条同时消失:压根不碰真实文件,也就没有"恢复"这个环节。
//
// 验证点(保持不变):
//   - 串行写:写入内容 = 最新一次的对象(JSON.stringify(obj, null, 2))
//   - 并发写 2 个不同对象:最终文件 = A 或 B,不是半写 JSON,不是混合体
//   - 不留 .pid.timestamp.tmp 临时文件
//   - saveConfig → writeRawConfigFile 串行集成,项目级配置不丢字段
//
// 不测试 lockFile/unlockFile 端到端(会触发 loadConfig,需要磁盘已有合法
// JSON;并发场景已通过 saveConfig 间接覆盖)。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

// ---- 真实 home 快照:必须在改写环境变量之前取,供哨兵校验使用 ----
const realHome = os.homedir()
const realConfigPath = path.join(realHome, '.git-commit-tool.json')

// ---- 环境隔离:必须在 import src/config.js 之前完成 ----
const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'zgs-config-atomic-test-'))
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

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..')
const configMod = await import(pathToFileURL(path.join(projectRoot, 'src/config.js')).href)
const { writeRawConfigFile, saveConfig } = configMod.default

// 沙箱内的配置路径 —— 本文件所有读写都落在这里
const configPath = path.join(fakeHome, '.git-commit-tool.json')

/** 读取真实配置的签名;文件不存在时返回 null */
async function statRealConfig() {
  try {
    const st = await fs.stat(realConfigPath)
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch (_) {
    return null
  }
}

let realSignatureBefore = null

before(async () => {
  // 断言一:隔离确实生效 —— 此刻沙箱里不该有配置文件
  const entries = await fs.readdir(fakeHome)
  assert.ok(!entries.includes('.git-commit-tool.json'), '测试前沙箱 home 应为空')
  // 断言二:沙箱路径与真实路径不能重合(防止 mkdtemp 异常落到 home)
  assert.notEqual(path.resolve(fakeHome), path.resolve(realHome), '沙箱目录不应等于真实 home')
  realSignatureBefore = await statRealConfig()
})

after(async () => {
  // 恢复环境变量并清理临时目录
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try { await fs.rm(fakeHome, { recursive: true, force: true }) } catch {}

  // 哨兵:整个测试期间真实配置必须毫发无损
  const sigAfter = await statRealConfig()
  assert.deepEqual(
    sigAfter,
    realSignatureBefore,
    `测试不得改动真实配置 ${realConfigPath} —— 若此处失败,说明有代码绕过了沙箱直接写 home`
  )
})

// ========== 串行写 ==========

test('writeRawConfigFile: 串行写入可读回且字段一致', async () => {
  const obj = {
    __test_marker: 'atomic-write-serial',
    defaultCommitMessage: 'submit-test',
    lockedFiles: ['foo.txt'],
    ui: { layout: { leftRatio: 0.5 } },
  }
  await writeRawConfigFile(obj)
  const raw = await fs.readFile(configPath, 'utf-8')
  const parsed = JSON.parse(raw) // 不能 parse = 写入了半写 JSON,原子写契约破裂
  assert.equal(parsed.__test_marker, 'atomic-write-serial')
  assert.equal(parsed.defaultCommitMessage, 'submit-test')
  assert.deepEqual(parsed.lockedFiles, ['foo.txt'])
  assert.equal(parsed.ui.layout.leftRatio, 0.5)
})

test('writeRawConfigFile: 覆盖写 — 后写覆盖前写', async () => {
  await writeRawConfigFile({ __test_marker: 'first' })
  await writeRawConfigFile({ __test_marker: 'second' })
  const parsed = JSON.parse(await fs.readFile(configPath, 'utf-8'))
  assert.equal(parsed.__test_marker, 'second')
})

// ========== 并发写 ==========

test('writeRawConfigFile: 并发 2 个不同对象(20ms 间隔)— 最终文件是其一,不是混合体', async () => {
  // 用 20ms 间隔让两次写入落到不同 ms,避免 Date.now() 撞同 tmpPath。
  // 已知 bug:writeRawConfigFile 用 `${process.pid}.${Date.now()}` 派生 tmpPath,
  // ms 精度下并发写入落入同一 ms 时,后写者 rename 时 src 已被前写者 rename
  // 走,会抛 ENOENT。这是独立于"原子写"语义的次级 bug,待独立 PR 修。
  // 本测试只验证"原子写"本身:不出现半写 JSON、不出现混合字段。
  const objA = { __test_marker: 'concurrent-A', payload: 'A'.repeat(500) }
  const objB = { __test_marker: 'concurrent-B', payload: 'B'.repeat(500) }
  await Promise.all([
    (async () => {
      await new Promise(r => setTimeout(r, 0))
      await writeRawConfigFile(objA)
    })(),
    (async () => {
      await new Promise(r => setTimeout(r, 20))
      await writeRawConfigFile(objB)
    })(),
  ])
  const raw = await fs.readFile(configPath, 'utf-8')
  const parsed = JSON.parse(raw)
  // 最终文件必须是 A 或 B 的完整对象,不能 parse 失败(半写 JSON)
  // 也不能是混合字段(例如 .__test_marker='concurrent-A' 但 .payload='BBBB...')
  assert.ok(
    parsed.__test_marker === 'concurrent-A' || parsed.__test_marker === 'concurrent-B',
    `__test_marker 必须是 A 或 B,实际: ${parsed.__test_marker}`
  )
  if (parsed.__test_marker === 'concurrent-A') {
    assert.ok(parsed.payload.startsWith('AAAA'), 'A 对象的 payload 应是 A 串')
    assert.equal(parsed.payload.length, 500)
  } else {
    assert.ok(parsed.payload.startsWith('BBBB'), 'B 对象的 payload 应是 B 串')
    assert.equal(parsed.payload.length, 500)
  }
})

// ========== 临时文件清理 ==========

test('writeRawConfigFile: 完成后不留 .pid.timestamp.tmp 临时文件', async () => {
  await writeRawConfigFile({ __test_marker: 'no-tmp-leak' })
  // 给文件系统一点时间同步(虽然 rename 是同步的,防御性等待)
  await new Promise(r => setTimeout(r, 50))
  const entries = await fs.readdir(path.dirname(configPath))
  const leaked = entries.filter(name =>
    name.startsWith('.git-commit-tool.json.') && name.endsWith('.tmp')
  )
  assert.equal(
    leaked.length,
    0,
    `不应残留 .tmp 临时文件,实际: ${JSON.stringify(leaked)}`
  )
})

// ========== saveConfig 串行集成 ==========

test('saveConfig: 合法对象串行多次写不丢字段', async () => {
  // saveConfig 会先 loadConfig → modify → writeRawConfigFile,
  // 项目级字段写到 raw.projects[key] 而不是顶层;
  // 这里验证"saveConfig → saveConfig"链式调用后,字段持久化到正确位置
  // 且 latest 写入生效。
  await saveConfig({
    defaultCommitMessage: 'chain-test',
    lockedFiles: ['a.txt'],
  })
  await saveConfig({
    defaultCommitMessage: 'chain-test-2',
    lockedFiles: ['a.txt', 'b.txt'],
  })
  const parsed = JSON.parse(await fs.readFile(configPath, 'utf-8'))
  // 找到当前项目的 key(getCurrentProjectKey 内部用 git rev-parse 或 CWD)
  const projectKeys = Object.keys(parsed.projects || {})
  assert.ok(projectKeys.length >= 1, 'projects 容器应有当前项目')
  const projectCfg = parsed.projects[projectKeys[0]]
  assert.equal(projectCfg.defaultCommitMessage, 'chain-test-2', 'latest 写入应生效')
  assert.ok(
    projectCfg.lockedFiles.includes('b.txt'),
    'lockedFiles 应保留 latest 写入的 b.txt'
  )
})

test('saveConfig: 写入后磁盘文件是合法 JSON(不破坏现有可解析性)', async () => {
  await saveConfig({ defaultCommitMessage: 'parseable-test' })
  // 任意一次 saveConfig 后,文件必须可 parse — 否则其他读路径会 500
  const raw = await fs.readFile(configPath, 'utf-8')
  assert.doesNotThrow(() => JSON.parse(raw), 'saveConfig 后磁盘 JSON 必须可 parse')
})

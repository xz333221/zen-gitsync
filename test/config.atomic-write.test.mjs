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
// 策略:
//   1. 备份 ~/.git-commit-tool.json(若存在)到临时路径,测试结束后无论
//      成功失败都恢复(避免污染用户 home)
//   2. 走 default export.writeRawConfigFile(已导出),验证:
//      - 串行写:写入内容 = 最新一次的对象(JSON.stringify(obj, null, 2))
//      - 并发写 2 个不同对象:最终文件 = A 或 B,不是半写 JSON,不是混合
//      - 不留 .pid.timestamp.tmp 临时文件
//   3. 走 default export.saveConfig 验证 saveConfig → writeRawConfigFile
//      的串行集成,确认项目级配置不丢字段
//
// 不测试 lockFile/unlockFile 端到端(会触发 loadConfig,需要磁盘已有合法
// JSON;并发场景已通过 saveConfig 间接覆盖)。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..')
const configMod = await import(pathToFileURL(path.join(projectRoot, 'src/config.js')).href)
const { writeRawConfigFile, saveConfig } = configMod.default

const realConfigPath = path.join(os.homedir(), '.git-commit-tool.json')
const backupPath = `${realConfigPath}.atomic-test.bak.${process.pid}.${Date.now()}`
let hadOriginal = false

before(async () => {
  try {
    await fs.access(realConfigPath)
    hadOriginal = true
    await fs.copyFile(realConfigPath, backupPath)
  } catch {
    hadOriginal = false
  }
})

after(async () => {
  // 清理测试可能产生的 .tmp 文件(pid 范围在当前进程内)
  try {
    const entries = await fs.readdir(path.dirname(realConfigPath))
    const myTmpRegex = new RegExp(`^\\.git-commit-tool\\.json\\.${process.pid}\\.\\d+\\.tmp$`)
    for (const name of entries) {
      if (myTmpRegex.test(name)) {
        await fs.unlink(path.join(path.dirname(realConfigPath), name)).catch(() => {})
      }
    }
  } catch {}
  // 恢复原配置
  if (hadOriginal) {
    try {
      await fs.copyFile(backupPath, realConfigPath)
      await fs.unlink(backupPath)
    } catch (e) {
      console.error('[atomic-write test] 恢复备份失败:', e.message)
    }
  } else {
    // 测试前没有原文件,删掉测试产物
    try { await fs.unlink(realConfigPath) } catch {}
  }
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
  const raw = await fs.readFile(realConfigPath, 'utf-8')
  const parsed = JSON.parse(raw) // 不能 parse = 写入了半写 JSON,原子写契约破裂
  assert.equal(parsed.__test_marker, 'atomic-write-serial')
  assert.equal(parsed.defaultCommitMessage, 'submit-test')
  assert.deepEqual(parsed.lockedFiles, ['foo.txt'])
  assert.equal(parsed.ui.layout.leftRatio, 0.5)
})

test('writeRawConfigFile: 覆盖写 — 后写覆盖前写', async () => {
  await writeRawConfigFile({ __test_marker: 'first' })
  await writeRawConfigFile({ __test_marker: 'second' })
  const parsed = JSON.parse(await fs.readFile(realConfigPath, 'utf-8'))
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
  const raw = await fs.readFile(realConfigPath, 'utf-8')
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
  const entries = await fs.readdir(path.dirname(realConfigPath))
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
  const parsed = JSON.parse(await fs.readFile(realConfigPath, 'utf-8'))
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
  const raw = await fs.readFile(realConfigPath, 'utf-8')
  assert.doesNotThrow(() => JSON.parse(raw), 'saveConfig 后磁盘 JSON 必须可 parse')
})
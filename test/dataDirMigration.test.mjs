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

// 数据目录布局迁移回归测试(2026-09-18)。
//
// 背景:历史上数据散在用户主目录的三套命名前缀里 ——
//   .git-commit-tool.json / .git-commit-tool.json.bak / .git-commit-tool/ai-images
//   .zen-gitsync-instances/ / .zen-gitsync-instances.json(.tmp)
//   .zen-gitsync/(唯一收敛好的)
// 迁移把它们收进 ~/.zen-gitsync/(见 src/paths.js + src/dataDirMigration.js)。
//
// 隔离策略与 config.*.test.mjs 一致:在 import 之前把 USERPROFILE/HOME 指向
// mkdtemp 沙箱,因此 src/paths.js 求值出的所有路径都落在沙箱里。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const realHome = os.homedir()

const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'zgs-migration-test-'))
const savedEnv = {
  USERPROFILE: process.env.USERPROFILE,
  HOME: process.env.HOME,
  HOMEDRIVE: process.env.HOMEDRIVE,
  HOMEPATH: process.env.HOMEPATH
}
process.env.USERPROFILE = fakeHome
process.env.HOME = fakeHome
delete process.env.HOMEDRIVE
delete process.env.HOMEPATH

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const migrationMod = await import(pathToFileURL(path.join(projectRoot, 'src/dataDirMigration.js')).href)
const { migrateDataDir } = migrationMod

// 沙箱内的东西南北
const dataDir = path.join(fakeHome, '.zen-gitsync')
const newConfig = path.join(dataDir, 'config.json')
const newConfigBak = path.join(dataDir, 'config.json.bak')
const newInstancesDir = path.join(dataDir, 'instances')
const newImagesDir = path.join(dataDir, 'ai-images')
const markerFile = path.join(dataDir, '.layout-migrated')
const cleanupDir = path.join(dataDir, '_legacy-cleanup')

const legacyConfig = path.join(fakeHome, '.git-commit-tool.json')
const legacyConfigBak = path.join(fakeHome, '.git-commit-tool.json.bak')
const legacyInstancesDir = path.join(fakeHome, '.zen-gitsync-instances')
// 本机真实存在过的脏状态:旧单文件注册表的位置被建成了一个**空目录**
const legacyInstancesFileAsDir = path.join(fakeHome, '.zen-gitsync-instances.json')
const legacyStrayTmp = path.join(fakeHome, '.zen-gitsync-instances.json.tmp')
const legacyConfigTmp = path.join(fakeHome, '.git-commit-tool.json.12345.1700000000000.tmp')
const legacyImagesParent = path.join(fakeHome, '.git-commit-tool')
const legacyImagesDir = path.join(legacyImagesParent, 'ai-images')

// 用户的无关文件:任何情况下都不许碰
const foreignTmp = path.join(fakeHome, 'other-tool.tmp')
const foreignNearMiss = path.join(fakeHome, '.git-commit-tool.jsonx')

const CONFIG_CONTENT = {
  theme: 'dark',
  locale: 'zh-CN',
  projects: { 'd:\\xz_workspace\\demo': { defaultCommitMessage: '迁移前的内容' } }
}

async function seedLegacyLayout() {
  await fs.writeFile(legacyConfig, JSON.stringify(CONFIG_CONTENT, null, 2), 'utf-8')
  await fs.writeFile(legacyConfigBak, JSON.stringify({ old: true }), 'utf-8')
  await fs.writeFile(legacyConfigTmp, '{"half":', 'utf-8')

  await fs.mkdir(legacyInstancesDir, { recursive: true })
  await fs.writeFile(path.join(legacyInstancesDir, '21160.json'), '{"pid":21160}', 'utf-8')
  await fs.writeFile(path.join(legacyInstancesDir, '2576.json'), '{"pid":2576}', 'utf-8')
  await fs.writeFile(path.join(legacyInstancesDir, '51492.json.tmp'), '{"pid":51492', 'utf-8')
  await fs.writeFile(path.join(legacyInstancesDir, '.migrated'), '2026-09-01T00:00:00.000Z', 'utf-8')

  await fs.mkdir(legacyInstancesFileAsDir, { recursive: true }) // 空目录(真实脏状态)
  await fs.writeFile(legacyStrayTmp, '{"instances":{}}', 'utf-8')

  await fs.mkdir(legacyImagesDir, { recursive: true })
  await fs.writeFile(path.join(legacyImagesDir, 'clip-1.png'), 'PNGDATA', 'utf-8')

  await fs.writeFile(foreignTmp, 'user data', 'utf-8')
  await fs.writeFile(foreignNearMiss, 'user data', 'utf-8')
}

async function resetSandbox() {
  // 只删沙箱内的目标,保留沙箱根
  for (const p of [dataDir, legacyConfig, legacyConfigBak, legacyConfigTmp, legacyInstancesDir,
    legacyInstancesFileAsDir, legacyStrayTmp, legacyImagesParent]) {
    await fs.rm(p, { recursive: true, force: true })
  }
  await seedLegacyLayout()
}

async function exists(p) {
  try { await fs.access(p); return true } catch { return false }
}

before(async () => {
  assert.notEqual(path.resolve(fakeHome), path.resolve(realHome), '沙箱不应等于真实 home')
  await seedLegacyLayout()
})

after(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try { await fs.rm(fakeHome, { recursive: true, force: true }) } catch {}
})

test('迁移:主配置/备份/实例目录/贴图/临时残渣全部收进 ~/.zen-gitsync/', async () => {
  const report = await migrateDataDir()

  assert.deepEqual(report.errors, [], `迁移不得有错误: ${JSON.stringify(report.errors)}`)
  assert.equal(report.configPath, newConfig, '迁移后应使用新配置路径')
  assert.equal(report.alreadyMigrated, false, '首次迁移不应标记为"已完成过"')

  // 主配置:内容完整搬过去,旧文件不再存在
  const moved = JSON.parse(await fs.readFile(newConfig, 'utf-8'))
  assert.deepEqual(moved, CONFIG_CONTENT, '迁移后配置内容必须一模一样')
  assert.equal(await exists(legacyConfig), false, '旧配置文件应已被搬走(rename,不是复制)')

  // 备份
  assert.equal(JSON.parse(await fs.readFile(newConfigBak, 'utf-8')).old, true)
  assert.equal(await exists(legacyConfigBak), false)

  // 实例心跳:逐个合并进 instances/,.migrated 标记也带过去
  assert.equal(await exists(path.join(newInstancesDir, '21160.json')), true)
  assert.equal(await exists(path.join(newInstancesDir, '2576.json')), true)
  assert.equal(await exists(path.join(newInstancesDir, '.migrated')), true)
  assert.equal(await exists(legacyInstancesDir), false, '搬空后的旧目录应被收走')

  // 脏状态:旧单文件位置的空目录必须被清掉(真实机器上就卡在这里)
  assert.equal(await exists(legacyInstancesFileAsDir), false, '被误建成的空目录应被收走')

  // 贴图目录
  assert.equal(await exists(path.join(newImagesDir, 'clip-1.png')), true)
  assert.equal(await exists(legacyImagesParent), false, '贴图搬走且腾空后,旧父目录应被收走')

  // 残渣:一律留档,不直接删
  const aside = await fs.readdir(cleanupDir)
  assert.ok(aside.includes(path.basename(legacyConfigTmp)), `半写的旧 tmp 应留档: ${aside.join(',')}`)
  assert.ok(aside.includes(path.basename(legacyStrayTmp)), `旧心跳 tmp 应留档: ${aside.join(',')}`)
  assert.ok(aside.includes(path.basename(legacyInstancesFileAsDir)), '空目录应留档')
  assert.ok(aside.includes('51492.json.tmp'), '心跳目录里的 tmp 残渣应留档')
  assert.equal(await exists(legacyConfigTmp), false)
  assert.equal(await exists(legacyStrayTmp), false)

  // 迁移标记
  const marker = JSON.parse(await fs.readFile(markerFile, 'utf-8'))
  assert.equal(marker.version, 1)

  // 用户的无关文件:一个都不许动
  assert.equal(await exists(foreignTmp), true, '不得清理用户自己的 .tmp 文件')
  assert.equal(await exists(foreignNearMiss), true, '不得误伤名字相近的文件')
})

test('迁移:幂等 —— 第二次调用直接标记为已完成且不做任何动作', async () => {
  const report = await migrateDataDir()
  assert.equal(report.alreadyMigrated, true)
  assert.deepEqual(report.errors, [])
  assert.deepEqual(report.moved, [], '已迁移过就不该再搬任何东西')
  assert.deepEqual(report.cleaned, [], '已迁移过就不该再清理任何东西')
})

test('迁移:新旧配置同时存在 → 不动旧文件(可能还有旧版本实例在读它)', async () => {
  await fs.writeFile(legacyConfig, JSON.stringify({ theme: 'legacy-still-here' }), 'utf-8')
  const newBefore = await fs.readFile(newConfig, 'utf-8')

  const report = await migrateDataDir({ force: true })

  assert.equal(await exists(legacyConfig), true, '新配置已存在时,旧文件必须原样保留')
  assert.equal(await fs.readFile(newConfig, 'utf-8'), newBefore, '新配置不得被旧文件覆盖')
  assert.ok(
    report.skipped.some(s => s.includes(legacyConfig)),
    `应记录 skipped: ${JSON.stringify(report.skipped)}`
  )
})

test('迁移:旧实例目录整目录归我们所有 → 内容全搬走、目录收走(不丢文件)', async () => {
  await fs.mkdir(legacyInstancesDir, { recursive: true })
  await fs.writeFile(path.join(legacyInstancesDir, 'keepme.txt'), 'not a registry entry', 'utf-8')
  // 重开一次搬迁:删掉标记模拟"下次启动重新扫"
  await fs.rm(markerFile, { force: true })

  const report = await migrateDataDir()

  // 该目录名属于本工具,内容整体归我们:不认识的条目也一并搬进新目录(而不是删掉)
  assert.equal(await exists(legacyInstancesDir), false, '搬空后旧目录应被收走')
  assert.ok(
    await exists(path.join(newInstancesDir, 'keepme.txt')),
    '旧目录里的内容必须全部搬进新目录,一个都不能丢'
  )
  assert.deepEqual(report.errors, [], `不该有错误: ${JSON.stringify(report.errors)}`)
})

test('迁移:共用的旧父目录非空时保留不动(绝不误伤别人的数据)', async () => {
  // ~/.git-commit-tool/ 是"贴图目录的父目录":只该在它被搬空后才收走
  await fs.mkdir(legacyImagesParent, { recursive: true })
  await fs.writeFile(path.join(legacyImagesParent, 'unrelated.txt'), 'someone else data', 'utf-8')
  await fs.rm(markerFile, { force: true })

  const report = await migrateDataDir()

  assert.equal(
    await exists(path.join(legacyImagesParent, 'unrelated.txt')),
    true,
    '非空的旧父目录必须原样保留'
  )
  assert.ok(
    report.skipped.some(s => s.includes(legacyImagesParent)),
    `应记录 skipped: ${JSON.stringify(report.skipped)}`
  )
  assert.deepEqual(report.errors, [], '非空目录是正常情况,不该记错误')
})

test('迁移:配置路径被非空目录占用 → 回退旧路径并记 skipped(不让应用读不到配置)', async () => {
  await fs.rm(legacyImagesParent, { recursive: true, force: true })
  await fs.writeFile(legacyConfig, JSON.stringify(CONFIG_CONTENT), 'utf-8')
  // 把目标路径占成一个**非空**目录:既不能落位,也不该被我们搬走
  await fs.rm(newConfig, { force: true })
  await fs.mkdir(newConfig, { recursive: true })
  await fs.writeFile(path.join(newConfig, 'occupied.txt'), 'in the way', 'utf-8')
  await fs.rm(markerFile, { force: true })

  const report = await migrateDataDir()

  assert.equal(report.configPath, legacyConfig, '无法落位时应回退旧路径(只读兜底)')
  assert.equal(await exists(legacyConfig), true, '回退模式下旧文件必须原地保留')
  assert.equal(
    await exists(path.join(newConfig, 'occupied.txt')),
    true,
    '非空的占用目录不得被动过'
  )
  assert.ok(
    report.skipped.some(s => s.includes('非空目录占用')),
    `应记录 skipped: ${JSON.stringify(report.skipped)}`
  )
})

test('迁移:落位失败时 config.js 仍能从旧路径读到配置(子进程端到端)', async () => {
  // 上一轮用例已经把"回退"状态留在这里:legacyConfig 有内容、newConfig 是非空目录
  assert.ok(await exists(legacyConfig), '前置:旧配置应存在')
  assert.equal(JSON.parse(await fs.readFile(legacyConfig, 'utf-8')).theme, 'dark', '前置:旧配置内容')

  const configJsUrl = pathToFileURL(path.join(projectRoot, 'src/config.js')).href
  const code = `
process.env.USERPROFILE = ${JSON.stringify(fakeHome)};
process.env.HOME = ${JSON.stringify(fakeHome)};
const { default: config } = await import(${JSON.stringify(configJsUrl)});
const cfg = await config.loadConfig();
console.log('THEME=' + cfg.theme);
`
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf-8' })
  assert.equal(res.status, 0, `子进程应正常退出,stderr: ${res.stderr}`)
  assert.match(res.stdout, /THEME=dark/, `回退模式下应能读到旧配置的 theme,实际输出: ${res.stdout}${res.stderr}`)

  // 复原:把占用目录挪走,让后续用例(如果有)看到干净状态
  await fs.rm(newConfig, { recursive: true, force: true })
})

test('迁移:配置读写在迁移后仍可正常工作(与 config.js 的集成)', async () => {
  await resetSandbox()
  const configMod = await import(pathToFileURL(path.join(projectRoot, 'src/config.js')).href)
  const { loadConfig } = configMod.default

  const cfg = await loadConfig()
  // theme 是顶层全局设置,不依赖"当前项目键",可以直接断言迁移过来的值
  assert.equal(cfg.theme, 'dark', '迁移过来的 theme 应能被读到')
  assert.equal(cfg.locale, 'zh-CN', '迁移过来的 locale 应能被读到')

  // 写一次,确认落在新路径而不是旧路径
  cfg.autoClosePushModal = false
  await configMod.default.saveConfig(cfg)
  const raw = JSON.parse(await fs.readFile(newConfig, 'utf-8'))
  assert.equal(raw.theme, 'dark', '写回后顶层全局设置不应丢失')
  // 2026-09-18:projects 已拆到 projects/<fileId>.json,config.json 里**不该**再有它。
  // 断言改走 readRawConfigFile()(组装后的 API 视图)—— 要钉的仍是原来那件事:
  // 迁移过来、且不属于"当前项目"的项目条目不能被擦掉。
  assert.equal(raw.projects, undefined, 'projects 不该再出现在 config.json 里')
  const assembled = await configMod.default.readRawConfigFile()
  assert.ok(assembled.projects && typeof assembled.projects === 'object', '写回应保留 projects 容器')
  assert.ok(
    assembled.projects['d:\\xz_workspace\\demo'],
    '迁移过来、且不属于"当前项目"的项目条目必须原样保留'
  )
  assert.equal(await exists(legacyConfig), false, '写入不该把旧文件又创建出来')
})

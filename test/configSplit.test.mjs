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

// 配置分文件存储回归测试(2026-09-18 第二轮)。
//
// 背景:config.json 里 projects 占 93%(605KB 中的 563KB),其中 82% 是画布 flowData。
// 任何一次琐碎写入(改主题 / 拖布局比例 / 记最近目录)都要重写整份文件并全量复制
// .bak(实测 save 45~66ms)。拆成 projects/<fileId>.json +
// orchestration/<fileId>/<orchId>.json 后,热文件降到 ~40KB,且未变更的文件不重写。
//
// 隔离策略与 config.*.test.mjs 一致:import 之前把 USERPROFILE/HOME 指向 mkdtemp
// 沙箱,所以 src/paths.js 求值出的所有路径都落在沙箱里,绝不碰用户真实数据。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const cwdBefore = process.cwd()
const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'zgs-config-split-test-'))
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
const configMod = await import(pathToFileURL(path.join(projectRoot, 'src/config.js')).href)
const splitMod = await import(pathToFileURL(path.join(projectRoot, 'src/configSplit.js')).href)
// config.js 的门面方法挂在 default 上;invalidateRawConfigCache /
// invalidateCurrentProjectKey / normalizeProjectPath 才是命名导出
const cfg = configMod.default

const dataDir = path.join(fakeHome, '.zen-gitsync')
const configFile = path.join(dataDir, 'config.json')
const projectsDir = path.join(dataDir, 'projects')
const orchDir = path.join(dataDir, 'orchestration')
const splitMarker = path.join(dataDir, '.split-migrated')

// 两个项目键故意让 basename 相同 —— 验证文件名唯一性靠哈希而不是 slug
const KEY_A = 'd:\\sandbox\\alpha\\demo-app'
const KEY_B = 'd:\\sandbox\\beta\\demo-app'

function orchestration(id, name, flowNodes) {
  return {
    id,
    name,
    description: `${name} 的描述`,
    flowData: { nodes: flowNodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 } }
  }
}

/** 造一份"拆分前"的内联配置。画布顺序刻意不是字母序,用来抓"顺序丢失" */
function inlineConfig() {
  return {
    theme: 'dark',
    locale: 'zh-CN',
    models: [{ id: 'm1', name: '模型一' }],
    ui: { layout: { leftRatio: 0.3 } },
    recentDirectories: ['d:\\sandbox\\alpha\\demo-app', 'd:\\sandbox\\beta\\demo-app'],
    projects: {
      [KEY_A]: {
        defaultCommitMessage: 'A 的提交信息',
        lockedFiles: ['d:\\sandbox\\alpha\\demo-app\\a.txt'],
        currentDirectory: 'd:\\sandbox\\alpha\\demo-app',
        // 顺序:z 在前、a 在后。若实现偷懒按 readdir 字母序,这里就会翻过来
        orchestrations: [
          orchestration('orch_z_last_created', '晚创建的', [{ id: 'n1', label: '节点一' }]),
          orchestration('orch_a_first_created', '早创建的', [{ id: 'n2', label: '节点二' }]),
        ],
      },
      [KEY_B]: {
        defaultCommitMessage: 'B 的提交信息',
        orchestrations: [],
      },
    },
  }
}

/** 重置沙箱:清空数据目录 + 清掉模块级缓存,再写入给定的内联配置 */
async function resetSandbox(config = inlineConfig()) {
  await fs.rm(dataDir, { recursive: true, force: true })
  await fs.mkdir(dataDir, { recursive: true })
  if (config !== null) {
    await fs.writeFile(configFile, JSON.stringify(config, null, 2), 'utf-8')
  }
  configMod.invalidateRawConfigCache()
  splitMod.resetSplitCaches()
}

async function readJson(p) {
  return JSON.parse(await fs.readFile(p, 'utf-8'))
}

async function listJson(dir) {
  try {
    return (await fs.readdir(dir)).filter((n) => n.endsWith('.json')).sort()
  } catch {
    return []
  }
}

async function mtimes(dir) {
  const out = {}
  for (const name of await listJson(dir)) {
    out[name] = (await fs.stat(path.join(dir, name))).mtimeMs
  }
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

after(async () => {
  process.chdir(cwdBefore)
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try { await fs.rm(fakeHome, { recursive: true, force: true }) } catch { /* ignore */ }
})

// ─────────────────────────────────────────────────────────────

test('文件名映射:同 basename 不撞、同键稳定、只含安全字符', () => {
  const idA = splitMod.projectFileId(KEY_A)
  const idB = splitMod.projectFileId(KEY_B)
  assert.notEqual(idA, idB, 'basename 相同但路径不同 → 文件名必须不同')
  assert.equal(idA, splitMod.projectFileId(KEY_A), '同一键必须稳定')
  assert.ok(/^[A-Za-z0-9._-]+$/.test(idA), `文件名含不安全字符: ${idA}`)
  assert.ok(idA.startsWith('demo-app-'), `可读 slug 前缀丢了: ${idA}`)

  // 画布 id:安全字符原样保留,含非法字符时降级为 slug + 哈希且不撞
  assert.equal(splitMod.orchestrationFileId('orch_1_abc'), 'orch_1_abc')
  const weird1 = splitMod.orchestrationFileId('a/b:c')
  const weird2 = splitMod.orchestrationFileId('a\\b:c')
  assert.notEqual(weird1, weird2, '不同 id 经替换后仍必须不撞')
  assert.ok(/^[A-Za-z0-9._-]+$/.test(weird1))
})

test('首次读取:内联 projects 被拆成文件,config.json 只留全局,并留档原文件', async () => {
  await resetSandbox()
  const before = await readJson(configFile)
  assert.ok(before.projects, '前置条件:沙箱 config.json 是内联格式')

  const raw = await cfg.readRawConfigFile()

  // 读回来的形状必须与拆分前一致
  assert.deepEqual(Object.keys(raw.projects).sort(), [KEY_A, KEY_B].sort())
  assert.equal(raw.projects[KEY_A].defaultCommitMessage, 'A 的提交信息')
  assert.equal(raw.theme, 'dark')
  assert.deepEqual(raw.recentDirectories, before.recentDirectories)

  // 磁盘上:config.json 不再含 projects,并新增两类文件
  const onDisk = await readJson(configFile)
  assert.equal(onDisk.projects, undefined, 'config.json 不该再有内联 projects')
  assert.equal(onDisk.theme, 'dark', '全局字段必须留在 config.json')

  const projectFiles = await listJson(projectsDir)
  assert.equal(projectFiles.length, 2, `projects/ 应有 2 个文件,实际 ${projectFiles.join(', ')}`)

  const orchFiles = await listJson(path.join(orchDir, splitMod.projectFileId(KEY_A)))
  assert.equal(orchFiles.length, 2, 'A 项目应有 2 个画布文件')
  assert.deepEqual(await listJson(path.join(orchDir, splitMod.projectFileId(KEY_B))), [], 'B 项目没有画布')

  assert.ok(await fs.stat(splitMarker).then(() => true, () => false), '迁移标记必须写出来')

  // 拆分前原文件必须留档(只搬不删)
  const backups = (await fs.readdir(dataDir)).filter((n) => n.startsWith('_migration-backup-split-'))
  assert.equal(backups.length, 1, `应有 1 个留档目录,实际 ${backups.join(', ')}`)
  const archived = await readJson(path.join(dataDir, backups[0], 'config.json'))
  assert.ok(archived.projects, '留档里必须是拆分前的完整内联版本')
  assert.equal(Object.keys(archived.projects).length, 2)
})

test('画布顺序按写入顺序保留,不依赖 readdir 字母序', async () => {
  await resetSandbox()
  const raw = await cfg.readRawConfigFile()
  const ids = raw.projects[KEY_A].orchestrations.map((o) => o.id)
  assert.deepEqual(
    ids,
    ['orch_z_last_created', 'orch_a_first_created'],
    '画布顺序被 readdir 的字母序改写了 —— 用户拖拽排过的序会丢'
  )
  // 项目文件里存的顺序表也应是原序
  const envelope = await readJson(splitMod.projectFilePath(KEY_A))
  assert.deepEqual(envelope.orchestrationOrder, ids)
})

test('幂等:第二次读取不再重新拆分,文件不被重写', async () => {
  await resetSandbox()
  await cfg.readRawConfigFile()
  const beforeMtimes = await mtimes(projectsDir)

  // 模拟新进程:只清模块缓存,不动磁盘
  configMod.invalidateRawConfigCache()
  splitMod.resetSplitCaches()
  await sleep(15)
  const raw = await cfg.readRawConfigFile()

  assert.equal(Object.keys(raw.projects).length, 2)
  assert.deepEqual(await mtimes(projectsDir), beforeMtimes, '已拆分状态下读取不该重写任何项目文件')
  const backups = (await fs.readdir(dataDir)).filter((n) => n.startsWith('_migration-backup-split-'))
  assert.equal(backups.length, 1, '不该产生第二个留档目录')
})

test('写差分:只重写变更过的项目,画布未动则连项目文件都不动', async () => {
  await resetSandbox()
  const raw = await cfg.readRawConfigFile()

  // 原地改一个字段后写回 —— 等价于 saveConfig 走到写盘那一步
  raw.projects[KEY_A].defaultCommitMessage = 'A 改过了'
  const res = await splitMod.writeSplitStore(raw)
  assert.deepEqual(res.errors, [])
  assert.equal(res.stats.projectWrites, 1, '只有 A 的项目文件该被重写')
  assert.equal(res.stats.projectSkips, 1, 'B 的项目文件该被跳过')
  assert.equal(res.stats.orchWrites, 0, '画布没变,不该重写')
  assert.equal(res.stats.orchSkips, 2, '两条画布都该跳过')

  // 再写一次同样内容 → 全部跳过
  const again = await splitMod.writeSplitStore(raw)
  assert.equal(again.stats.projectWrites, 0)
  assert.equal(again.stats.projectSkips, 2)
  assert.equal(again.stats.orchWrites, 0)

  const cfgB = await readJson(splitMod.projectFilePath(KEY_B))
  assert.equal(cfgB.config.defaultCommitMessage, 'B 的提交信息', 'B 没被改过')
})

test('只改画布 flowData:只重写那一条画布文件,项目文件保持跳过', async () => {
  await resetSandbox()
  const raw = await cfg.readRawConfigFile()

  raw.projects[KEY_A].orchestrations[1].flowData.nodes.push({ id: 'n3', label: '新增节点' })
  const res = await splitMod.writeSplitStore(raw)

  assert.equal(res.stats.orchWrites, 1, '只有被改的那条画布要重写')
  assert.equal(res.stats.orchSkips, 1)
  assert.equal(res.stats.projectWrites, 0, '顺序表没变 → 项目文件不该重写(这是差分的关键收益)')

  const reread = await cfg.readRawConfigFile()
  assert.equal(reread.projects[KEY_A].orchestrations[1].flowData.nodes.length, 2)
})

test('删除画布:对应文件被删掉,不会在读的时候复活', async () => {
  await resetSandbox()
  const raw = await cfg.readRawConfigFile()
  const removedId = raw.projects[KEY_A].orchestrations[0].id

  raw.projects[KEY_A].orchestrations = raw.projects[KEY_A].orchestrations.slice(1)
  const res = await splitMod.writeSplitStore(raw)
  assert.equal(res.stats.orchDeletes, 1, '被删的画布文件必须清理掉')

  const reread = await cfg.readRawConfigFile()
  assert.deepEqual(reread.projects[KEY_A].orchestrations.map((o) => o.id), ['orch_a_first_created'])
  assert.ok(!(await listJson(path.join(orchDir, splitMod.projectFileId(KEY_A)))).includes(`${removedId}.json`))
})

test('写路径不删项目:projects 里没出现的键,其文件必须原样保留', async () => {
  await resetSandbox()
  await cfg.readRawConfigFile()

  // 只带 A 去写 —— 单文件时代这么写会把 B 连带清空
  await cfg.writeRawConfigFile({
    theme: 'light',
    projects: { [KEY_A]: { defaultCommitMessage: '只剩 A' } },
  })

  assert.ok(
    await fs.stat(splitMod.projectFilePath(KEY_B)).then(() => true, () => false),
    'B 的项目文件被连带删掉了 —— 这正是拆分后必须守住的边界'
  )
  const raw = await cfg.readRawConfigFile()
  assert.equal(raw.projects[KEY_B].defaultCommitMessage, 'B 的提交信息')
  assert.equal(raw.theme, 'light')
})

test('单项损坏不拖垮整体:坏的跳过并如实报告,其余照常读出', async () => {
  await resetSandbox()
  await cfg.readRawConfigFile()
  await fs.writeFile(splitMod.projectFilePath(KEY_B), '{ 这不是合法 JSON', 'utf-8')
  configMod.invalidateRawConfigCache()
  splitMod.resetSplitCaches()

  const raw = await cfg.readRawConfigFile()
  assert.ok(raw.projects[KEY_A], 'A 必须还能读出来')
  assert.equal(raw.projects[KEY_B], undefined, '坏掉的 B 应被跳过')
  assert.deepEqual(raw.recentDirectories.length, 2, '全局字段不受影响')
})

test('拆分失败必须退回内联模式,且绝不摘掉 config.json 里的 projects', async () => {
  await resetSandbox()
  // projects/ 被一个**文件**占住 → ensureDir 必然失败 → 拆分必须整体放弃
  await fs.writeFile(projectsDir, 'not a directory', 'utf-8')
  configMod.invalidateRawConfigCache()
  splitMod.resetSplitCaches()

  const raw = await cfg.readRawConfigFile()

  // 数据必须还在(从内联读出来)
  assert.equal(Object.keys(raw.projects).length, 2, '拆分失败后项目数据必须仍可读')
  assert.equal(raw.projects[KEY_A].defaultCommitMessage, 'A 的提交信息')

  // 关键:config.json 不能被精简 —— 那是唯一的数据副本
  const onDisk = await readJson(configFile)
  assert.ok(onDisk.projects, '拆分失败却把 config.json 的 projects 摘掉了 = 数据丢失')
  assert.equal(Object.keys(onDisk.projects).length, 2)
})

test('有项目未能安全落盘时,同样不许精简 config.json', async () => {
  await resetSandbox()
  // 与上一条的区别:projects/ 本身可写,只有 A 的**画布目录**位置被文件占住。
  // 这时 ensureDir(PROJECTS_DIR) 成功、项目文件也写了,只有 A 的画布一条都落不下盘 ——
  // 若此时仍然精简 config.json,内联副本一没,A 的画布就只剩半份数据。
  await fs.mkdir(projectsDir, { recursive: true })
  await fs.mkdir(orchDir, { recursive: true })
  await fs.writeFile(path.join(orchDir, splitMod.projectFileId(KEY_A)), 'blocked', 'utf-8')
  configMod.invalidateRawConfigCache()
  splitMod.resetSplitCaches()

  const raw = await cfg.readRawConfigFile()

  const onDisk = await readJson(configFile)
  assert.ok(
    onDisk.projects,
    'A 的画布没落盘却把 config.json 精简了 —— 内联副本是唯一数据源,摘掉就等于丢画布'
  )
  assert.equal(Object.keys(onDisk.projects).length, 2)
  assert.equal(Object.keys(raw.projects).length, 2, '退回内联模式后仍应读到全部项目')
  assert.equal(raw.projects[KEY_A].orchestrations.length, 2, 'A 的两条画布一条都不能少')
})

test('有项目未落全时不写该项目文件,免得留下一份明知不全的快照', async () => {
  await resetSandbox()
  await fs.mkdir(projectsDir, { recursive: true })
  await fs.mkdir(orchDir, { recursive: true })
  await fs.writeFile(path.join(orchDir, splitMod.projectFileId(KEY_A)), 'blocked', 'utf-8')
  configMod.invalidateRawConfigCache()
  splitMod.resetSplitCaches()

  await cfg.readRawConfigFile()
  assert.ok(
    !(await fs.stat(splitMod.projectFilePath(KEY_A)).then(() => true, () => false)),
    'A 没落全时不该写出一份 orchestrationOrder 为空的残缺快照'
  )
})

test('config.json 不存在但分文件还在:项目配置必须照常读出来', async () => {  await resetSandbox()
  await cfg.readRawConfigFile()   // 先正常拆分一次
  await fs.rm(configFile)               // 模拟 config.json 被误删
  configMod.invalidateRawConfigCache()
  splitMod.resetSplitCaches()

  const raw = await cfg.readRawConfigFile()
  assert.equal(Object.keys(raw.projects).length, 2, 'config.json 没了不代表数据没了')
  assert.equal(raw.projects[KEY_A].defaultCommitMessage, 'A 的提交信息')
})

test('显式删除项目:项目文件与画布目录一并清掉', async () => {
  await resetSandbox()
  await cfg.readRawConfigFile()
  const res = await cfg.deleteProjectConfig(KEY_A)

  assert.deepEqual(res.errors, [])
  assert.ok(!(await fs.stat(splitMod.projectFilePath(KEY_A)).then(() => true, () => false)))
  assert.deepEqual(await listJson(path.join(orchDir, splitMod.projectFileId(KEY_A))), [])

  const raw = await cfg.readRawConfigFile()
  assert.deepEqual(Object.keys(raw.projects), [KEY_B])
})

test('多进程一致性:任何写入都必须重写 config.json 以刷新签名', async () => {
  await resetSandbox()
  const raw = await cfg.readRawConfigFile()
  // 只改画布、完全不动全局字段
  raw.projects[KEY_A].orchestrations[0].flowData.viewport.zoom = 2
  const sigBefore = await fs.stat(configFile)

  await sleep(15)
  await splitMod.writeSplitStore(raw)
  const sigAfter = await fs.stat(configFile)

  assert.ok(
    sigAfter.mtimeMs > sigBefore.mtimeMs,
    '只改画布时 config.json 没被重写 → 别的实例的缓存签名不变,会一直读到旧值'
  )
})

test('saveConfig 端到端:当前项目走通「读→改→写→再读」', async () => {
  await resetSandbox()
  // 让"当前项目"确定下来:切到一个非 git 沙箱目录,getCurrentProjectKey 会退化成该目录
  const workDir = path.join(fakeHome, 'workdir')
  await fs.mkdir(workDir, { recursive: true })
  process.chdir(workDir)
  configMod.invalidateCurrentProjectKey()

  const key = configMod.normalizeProjectPath(workDir)
  const seeded = inlineConfig()
  seeded.projects[key] = { defaultCommitMessage: '初始值', orchestrations: [], lockedFiles: [] }
  await resetSandbox(seeded)

  const projCfg = await cfg.loadConfig()
  assert.equal(projCfg.defaultCommitMessage, '初始值')

  projCfg.defaultCommitMessage = '改后的值'
  projCfg.lockedFiles.push(path.join(workDir, 'x.txt'))
  await cfg.saveConfig(projCfg)

  configMod.invalidateRawConfigCache()
  splitMod.resetSplitCaches()
  const again = await cfg.loadConfig()
  assert.equal(again.defaultCommitMessage, '改后的值')
  assert.equal(again.lockedFiles.length, 1)

  // 其它项目不受影响
  const raw = await cfg.readRawConfigFile()
  assert.equal(raw.projects[KEY_A].defaultCommitMessage, 'A 的提交信息')
  assert.equal(raw.projects[KEY_B].defaultCommitMessage, 'B 的提交信息')
})

test('各种形状的改动写后必能读回(含画布改名 / 换序 / 整组替换)', async () => {
  await resetSandbox()
  // 这一条专门盯"差分跳过"这类优化的副作用:只要有一次该写的被跳过,
  // 就会表现为"保存成功了但读回来还是旧的"。
  // 尤其覆盖**画布改名** —— 它不改顺序表、也不改项目配置,只动画布文件内容,
  // 是"按项目文件是否变化来决定要不要处理画布"这种偷懒实现最容易漏掉的形状。
  const cases = [
    ['项目字段', (r) => { r.projects[KEY_A].defaultCommitMessage = '改过了' }],
    ['项目新增字段', (r) => { r.projects[KEY_B].lockedFiles = ['x.txt'] }],
    ['画布改名(不动顺序表)', (r) => { r.projects[KEY_A].orchestrations[0].name = '改名后的画布' }],
    ['画布改 flowData', (r) => { r.projects[KEY_A].orchestrations[1].flowData.nodes.push({ id: 'n9', label: '九' }) }],
    ['全局字段', (r) => { r.recentDirectories = ['d:\\sandbox\\alpha\\demo-app'] }],
    ['画布整组替换', (r) => {
      r.projects[KEY_B].orchestrations = [orchestration('orch_brand_new', '新画布', [{ id: 'z', label: 'z' }])]
    }],
    ['清空画布', (r) => { r.projects[KEY_A].orchestrations = [] }],
  ]

  for (const [label, mutate] of cases) {
    const before = await cfg.readRawConfigFile()
    mutate(before)
    await cfg.writeRawConfigFile(before)

    // 写后必读:必须能看到刚写进去的值
    const after = await cfg.readRawConfigFile()
    assert.deepEqual(
      JSON.parse(JSON.stringify(after)),
      JSON.parse(JSON.stringify(before)),
      `「${label}」写完后读回来的不是刚写的内容 —— 有文件被差分逻辑错误跳过了`
    )

    // 再冷读一次(清缓存 + 清基线),对齐"磁盘才是真相"
    configMod.invalidateRawConfigCache()
    splitMod.resetSplitCaches()
    const cold = await cfg.readRawConfigFile()
    assert.deepEqual(
      JSON.parse(JSON.stringify(cold)),
      JSON.parse(JSON.stringify(before)),
      `「${label}」冷读与写入内容不一致 —— 磁盘上的状态不是我们以为的那个`
    )
  }
})

test('原子写无 tmp 残渣', async () => {
  await resetSandbox()
  const raw = await cfg.readRawConfigFile()
  raw.projects[KEY_A].defaultCommitMessage = '再改一次'
  await splitMod.writeSplitStore(raw)

  // 前缀从路径常量推导,不写死文件名 —— 写死的话改路径后断言会变成"永远通过"
  const strayDirs = [dataDir, projectsDir, path.join(orchDir, splitMod.projectFileId(KEY_A))]
  for (const dir of strayDirs) {
    const names = await fs.readdir(dir).catch(() => [])
    const tmps = names.filter((n) => n.endsWith('.tmp'))
    assert.deepEqual(tmps, [], `${dir} 残留 tmp: ${tmps.join(', ')}`)
  }
})

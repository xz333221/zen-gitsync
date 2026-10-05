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
//   所有读写落在临时目录,不触碰真实 ~/.zen-gitsync/config.json。
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
const { normalizeProjectPath, ConfigWriteError, normalizeAiMaxToolIterations, normalizeNotifySwitch } = configMod
const { saveConfig } = configMod.default

// 直接读沙箱磁盘上的 config.json：比走 loadConfig 更能暴露"写入位置不对"
const configFilePath = path.join(fakeHome, '.zen-gitsync', 'config.json')
const readRawConfig = async () => JSON.parse(await fs.readFile(configFilePath, 'utf-8'))
// 直接铺一份原始配置（用来造"老版本留下的键"这类迁移场景；saveConfig 是合并语义，
// 造不出"某个键压根没写过"的状态）
const writeRawConfig = (raw) => configMod.default.writeRawConfigFile(raw)

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

// ========== normalizeAiMaxToolIterations(单轮工具调用上限) ==========

test('normalizeAiMaxToolIterations: 合法整数原样返回', () => {
  assert.equal(normalizeAiMaxToolIterations(200), 200)
  assert.equal(normalizeAiMaxToolIterations(1), 1)
  assert.equal(normalizeAiMaxToolIterations(2000), 2000)
})

test('normalizeAiMaxToolIterations: 数字字符串与小数被接受', () => {
  // 配置文件手改 / 表单回传都可能是字符串
  assert.equal(normalizeAiMaxToolIterations('120'), 120)
  assert.equal(normalizeAiMaxToolIterations(88.9), 88)
})

test('normalizeAiMaxToolIterations: 越界值夹取到区间而不是回退默认', () => {
  // 用户改成 50000 的意图是"想更大",夹到上限比悄悄退回默认小值更贴近意图
  assert.equal(normalizeAiMaxToolIterations(50000), 10000)
  assert.equal(normalizeAiMaxToolIterations(2000), 2000)
  assert.equal(normalizeAiMaxToolIterations(0), 1)
  assert.equal(normalizeAiMaxToolIterations(-10), 1)
})

test('normalizeAiMaxToolIterations: 无法解析的值返回 null(调用方取默认)', () => {
  assert.equal(normalizeAiMaxToolIterations(undefined), null)
  assert.equal(normalizeAiMaxToolIterations(null), null)
  assert.equal(normalizeAiMaxToolIterations(''), null)
  assert.equal(normalizeAiMaxToolIterations('abc'), null)
  assert.equal(normalizeAiMaxToolIterations(NaN), null)
  assert.equal(normalizeAiMaxToolIterations(Infinity), null)
})

test('normalizeAiMaxToolIterations: 默认上限不再是 40(用户反馈太小)', async () => {
  const cfg = await configMod.default.loadConfig()
  assert.ok(
    cfg.aiMaxToolIterations >= 100,
    `默认单轮工具调用上限应 >= 100,实际 ${cfg.aiMaxToolIterations}`
  )
  assert.equal(normalizeAiMaxToolIterations(cfg.aiMaxToolIterations), cfg.aiMaxToolIterations)
})

// ========== normalizeNotifySwitch(任务/对话结束提示的三个通道开关) ==========
// 2026-10-05：原来是「总开关 notifyOnTaskDone + 子开关 notifySoundOnTaskDone」，
// 现在拆成三个**平级**的通道键（页面提示 / 浏览器通知 / 提示音），共用同一个规范化函数。
// 规范化只认布尔值这条契约没变（'false' 强转成 true 会让用户在设置里明明关着却照样被弹）。

test('normalizeNotifySwitch: 只接受布尔值', () => {
  assert.equal(normalizeNotifySwitch(true), true)
  assert.equal(normalizeNotifySwitch(false), false)
})

test('normalizeNotifySwitch: 非布尔值一律 null(调用方取默认/保留磁盘值)', () => {
  for (const bad of [undefined, null, 0, 1, '', 'true', 'false', {}, [], NaN]) {
    assert.equal(normalizeNotifySwitch(bad), null, `${JSON.stringify(bad)} 应返回 null`)
  }
})

const NOTIFY_KEYS = ['notifyPageOnTaskDone', 'notifyBrowserOnTaskDone', 'notifySoundOnTaskDone']

test('三个通道的默认值：页面提示开、提示音开、浏览器通知关', async () => {
  const cfg = await configMod.default.loadConfig()
  // 浏览器通知默认关是这次改动的核心 —— 它要申请浏览器通知权限，默认开会 + 自动申请
  // 就是"每次开 GUI 都弹授权框"（用户反馈的主诉）。想用的人自己去设置里拨开。
  assert.equal(cfg.notifyPageOnTaskDone, true, '新装/未设置时页面提示应为开')
  assert.equal(cfg.notifySoundOnTaskDone, true, '新装/未设置时提示音应为开')
  assert.equal(cfg.notifyBrowserOnTaskDone, false, '新装/未设置时浏览器通知应为关')
})

test('三个通道各自存成顶层全局键，且能独立开关', async () => {
  for (const key of NOTIFY_KEYS) {
    await saveConfig({ defaultCommitMessage: 'test', [key]: true })
    assert.equal((await readRawConfig())[key], true, `${key}=true 应写在 config.json 顶层`)
    await saveConfig({ defaultCommitMessage: 'test', [key]: false })
    assert.equal((await readRawConfig())[key], false, `${key} 关得掉才算真的可用`)
    assert.equal((await configMod.default.loadConfig())[key], false, `${key} 应能读回顶层值`)
  }
})

test('三个通道互不干扰：改一个不动另外两个', async () => {
  await saveConfig({
    defaultCommitMessage: 'test',
    notifyPageOnTaskDone: true,
    notifyBrowserOnTaskDone: true,
    notifySoundOnTaskDone: true
  })
  await saveConfig({ defaultCommitMessage: 'test', notifySoundOnTaskDone: false })
  const raw = await readRawConfig()
  assert.equal(raw.notifySoundOnTaskDone, false, '提示音应被关掉')
  assert.equal(raw.notifyPageOnTaskDone, true, '页面提示不该被顺手改动')
  assert.equal(raw.notifyBrowserOnTaskDone, true, '浏览器通知不该被顺手改动')
})

test('三个通道：非法值不落盘，保留磁盘旧值', async () => {
  for (const key of NOTIFY_KEYS) {
    await saveConfig({ defaultCommitMessage: 'test', [key]: true })
    await saveConfig({ defaultCommitMessage: 'test', [key]: 'false' })
    assert.equal((await readRawConfig())[key], true, `${key} 的非法值应被忽略，而不是覆盖成 true`)
  }
})

test('旧键 notifyOnTaskDone 只作迁移输入：显式 false → 三个通道全关', async () => {
  // 老用户磁盘上是"总开关关着"（那时关掉它 = 什么都不要）。升级后不能让三个默认值
  // （页面提示 + 提示音开）把提示又弹回来 —— 迁移必须尊重"我以前就是关掉的"。
  await writeRawConfig({
    defaultCommitMessage: 'test',
    projects: {},
    notifyOnTaskDone: false
  })
  const cfg = await configMod.default.loadConfig()
  for (const key of NOTIFY_KEYS) {
    assert.equal(cfg[key], false, `旧总开关为 false 时 ${key} 应迁移成 false`)
  }
})

test('旧键 notifyOnTaskDone: true → 三个通道走各自的新默认值', async () => {
  await writeRawConfig({
    defaultCommitMessage: 'test',
    projects: {},
    notifyOnTaskDone: true
  })
  const cfg = await configMod.default.loadConfig()
  assert.equal(cfg.notifyPageOnTaskDone, true)
  assert.equal(cfg.notifySoundOnTaskDone, true)
  assert.equal(cfg.notifyBrowserOnTaskDone, false, '浏览器通知即便旧总开关开着也仍是关（新默认）')
})

test('新键一旦写过，就盖过旧总开关的迁移结果', async () => {
  await writeRawConfig({
    defaultCommitMessage: 'test',
    projects: {},
    notifyOnTaskDone: false,
    notifyPageOnTaskDone: true
  })
  const cfg = await configMod.default.loadConfig()
  assert.equal(cfg.notifyPageOnTaskDone, true, '显式写过的新键优先于迁移')
  assert.equal(cfg.notifySoundOnTaskDone, false, '没写过的新键仍按迁移走')
})

test('旧键 notifyOnTaskDone 不再被写入，也不会漏进项目配置', async () => {
  // 全局设置漏进项目级是这一族键最容易踩的坑：saveConfig 的 ...projectConfig 展开
  // 会把没解构出来的键写进 raw.projects[key]。旧键已不再是活配置，但必须继续被剔除。
  // 先铺一份干净的 raw（上一条用例可能留下过旧键 —— saveConfig 只写不删，不会清掉它）。
  await writeRawConfig({ defaultCommitMessage: 'test', projects: {} })
  await saveConfig({ defaultCommitMessage: 'test', notifyOnTaskDone: true, notifyPageOnTaskDone: true })
  const raw = await readRawConfig()
  assert.equal(raw.notifyOnTaskDone, undefined, '旧键不该再被写进顶层')
  assert.equal(raw.notifyPageOnTaskDone, true, '新键应正常落盘')
  const polluted = Object.entries(raw.projects || {})
    .filter(([, p]) => p && typeof p === 'object' && 'notifyOnTaskDone' in p)
    .map(([k]) => k)
  assert.deepEqual(polluted, [], `旧键不该出现在项目配置里: ${polluted.join(', ')}`)
})

test('默认导出对象必须包含路由要用的规范化函数（漏加 = undefined 调用 → 路由 500）', () => {
  // src/ui/server 是 `import config from '../../config.js'`，拿的是**默认导出的对象字面量**；
  // 只在命名导出里加函数是不够的。2026-09-29 加提示音开关时正是漏了这一步：
  // 路由里 configManager.normalizeNotifySoundOnTaskDone(...) 变成 undefined 调用，
  // 被 try/catch 兜成 500，前端只看到"保存失败"，查了半天。
  // 这个断言专门钉住这一类漏加（新增规范化函数时把它加进下面的名单即可）。
  for (const name of [
    'normalizeAiMaxToolIterations',
    'normalizeTaskExecutor',
    'normalizeNotifySwitch'
  ]) {
    assert.equal(typeof configMod.default[name], 'function', `默认导出缺少 ${name}`)
  }
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
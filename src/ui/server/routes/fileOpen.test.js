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
// findDshExecutable 回归测试(2026-09-05)
// 旧实现只查 %APPDATA%\npm + npm prefix -g,在 nvm4w 用户(全局包在
// C:\nvm4w\nodejs\) 上"未安装"误报。改用 where.exe dsh 优先后,这里守住
// "返回的路径必须真实存在"这条契约。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { findDshExecutable, getToolInstallers, parseVersionOutput, registerFileOpenRoutes } from './fileOpen.js'

// ── parseVersionOutput(版本号采集,2026-09-05 check-tools 增强)────────────

test('parseVersionOutput: 各工具的 --version 输出都能提取 semver', () => {
  assert.equal(parseVersionOutput('0.1.1-rc.2\n'), '0.1.1-rc.2')               // dsh(带 prerelease)
  assert.equal(parseVersionOutput('1.0.60 (Claude Code)'), '1.0.60')           // claude
  assert.equal(parseVersionOutput('1.92.0 abc123def (commit)\n'), '1.92.0')    // vscode
  assert.equal(parseVersionOutput('opencode 0.1.30\n'), '0.1.30')              // opencode 前缀
  assert.equal(parseVersionOutput('codex-cli 0.9.2+build.1'), '0.9.2+build.1') // build 元数据
})

test('parseVersionOutput: 边界输入返回 null', () => {
  assert.equal(parseVersionOutput(''), null)
  assert.equal(parseVersionOutput(null), null)
  assert.equal(parseVersionOutput(undefined), null)
  assert.equal(parseVersionOutput('no version here'), null)
  // 多段数字但不是 semver(如日期 2026.09.05 会被提取——可接受,总比没有强)
  assert.ok(parseVersionOutput('version: 2.16.42\nsomething 1.0.0').startsWith('2.16.42'))
})

test('findDshExecutable: Windows 上返回 string 或 null,且非 null 时路径必须存在', async () => {
  const result = await findDshExecutable()
  if (process.platform !== 'win32') {
    // 非 win32 平台走 commandExists('dsh') 路径:要么是 'dsh'(which 命中),
    // 要么是 null。不强求特定值,只断言类型。
    assert.ok(result === null || typeof result === 'string')
    return
  }
  if (result !== null) {
    assert.equal(typeof result, 'string')
    // 核心契约:返回的路径必须真实存在且是文件。
    // 这正是这次修复要解决的:不允许再出现"返回看似合法但 fs.stat 不到的路径"
    // (旧实现里 APPDATA/npm/dsh.cmd + npm prefix -g 拼出的废地址都是 fs.stat 不到的)。
    const stat = await fs.stat(result)
    assert.equal(stat.isFile(), true, `${result} 不是文件`)
  }
})

// ── 工具升级(updateCommand)──────────────────────────────────────────
// 2026-09-05 新增:右键工具 → 更新。install 与 update 命令动词不同
// (npm @latest / winget upgrade / brew upgrade / snap refresh / kimi 脚本重跑)。

test('getToolInstallers: npm 包工具的升级变体带 @latest', () => {
  const installers = getToolInstallers('win32', () => true)
  for (const tool of ['claude', 'codex', 'opencode', 'dsh']) {
    const inst = installers[tool]
    assert.match(inst.updateCommand, /@latest$/, `${tool}.updateCommand 应带 @latest`)
    assert.ok(inst.updateExecutable, `${tool}.updateExecutable 缺失`)
    assert.ok(
      inst.updateArgs.at(-1).endsWith('@latest'),
      `${tool}.updateArgs 最后一项应带 @latest`,
    )
    // 安装命令不被升级字段污染
    assert.doesNotMatch(inst.command, /@latest/, `${tool}.command 不应带 @latest`)
  }
})

test('getToolInstallers: 各平台 vscode 升级用各自的 upgrade 动词', () => {
  const win = getToolInstallers('win32', () => true)
  assert.match(win.vscode.updateCommand, /^winget upgrade/)
  assert.deepEqual(win.vscode.updateArgs.slice(0, 2), ['upgrade', '--id'])

  const mac = getToolInstallers('darwin', () => true)
  assert.match(mac.vscode.updateCommand, /^brew upgrade/)

  const linux = getToolInstallers('linux', () => true)
  assert.match(linux.vscode.updateCommand, /^sudo snap refresh/)
})

test('getToolInstallers: kimi 升级复用幂等脚本,zcode 不支持一键升级', () => {
  const installers = getToolInstallers('win32', () => true)
  assert.equal(installers.kimi.updateKind, 'script')
  assert.match(installers.kimi.updateCommand, /install\.ps1/)
  // zcode 是桌面应用,updateCommand 必须为空 → /api/update-tool 对它返回 400
  assert.equal(installers.zcode.updateCommand, undefined)
})

test('update-tool 路由: zcode(无 updateCommand)返回 400 且不启动任何进程', async () => {
  // zcode 的 400 在 launchToolInstaller 之前抛出,本测试不会真的打开终端窗口。
  const routes = new Map()
  const app = {
    get(path, handler) { routes.set(`GET ${path}`, handler) },
    post(path, handler) { routes.set(`POST ${path}`, handler) },
  }
  registerFileOpenRoutes({ app })
  const handler = routes.get('POST /api/update-tool')
  assert.ok(handler, 'POST /api/update-tool 路由未注册')

  let statusCode = 200
  let payload = null
  const res = {
    status(code) { statusCode = code; return this },
    json(value) { payload = value; return this },
  }
  await handler({ method: 'POST', path: '/api/update-tool', body: { tool: 'zcode' } }, res, () => {})

  assert.equal(statusCode, 400)
  assert.equal(payload.success, false)
  assert.match(payload.error, /不支持一键更新|桌面应用/)
})

test('update-tool 路由: 未知工具 id 返回 400', async () => {
  const routes = new Map()
  const app = {
    get(path, handler) { routes.set(`GET ${path}`, handler) },
    post(path, handler) { routes.set(`POST ${path}`, handler) },
  }
  registerFileOpenRoutes({ app })
  const handler = routes.get('POST /api/update-tool')

  let statusCode = 200
  let payload = null
  const res = {
    status(code) { statusCode = code; return this },
    json(value) { payload = value; return this },
  }
  await handler({ method: 'POST', path: '/api/update-tool', body: { tool: 'not-a-tool' } }, res, () => {})

  assert.equal(statusCode, 400)
  assert.equal(payload.success, false)
})
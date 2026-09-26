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
// 资源管理器右键菜单（设置 → 通用设置 → 系统集成）的回归测试。
// 全程用假的 execFileFn —— 真的往 HKCU 写注册表会污染跑测试的这台机器。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMenuCommand,
  getExplorerContextMenuStatus,
  installExplorerContextMenu,
  MENU_REGISTRY_ROOTS,
  registerExplorerContextMenuRoutes,
  sanitizeMenuLabel,
  uninstallExplorerContextMenu,
} from './explorerContextMenu.js'

/** 记录所有 reg.exe 调用并返回空输出的假实现 */
function createFakeReg({ fail = () => false } = {}) {
  const calls = []
  const execFileFn = async (file, args) => {
    calls.push({ file, args })
    const error = fail(args)
    if (error) throw error
    return { stdout: '', stderr: '' }
  }
  return { calls, execFileFn }
}

/** 从假调用记录里取出某个 reg 子命令的目标键 */
function targetsOf(calls, subcommand) {
  return calls.filter((c) => c.args[0] === subcommand).map((c) => c.args[1])
}

test('sanitizeMenuLabel: 空值/非字符串退回默认标题', () => {
  const fallback = '用 g UI 打开'
  for (const input of [undefined, null, '', '   ', 42, {}, '\n\t']) {
    assert.equal(sanitizeMenuLabel(input), fallback)
  }
})

test('sanitizeMenuLabel: 控制字符换空格、首尾裁剪、超长截断', () => {
  assert.equal(sanitizeMenuLabel('  用 g UI 打开  '), '用 g UI 打开')
  assert.equal(sanitizeMenuLabel('用 g UI\n打开'), '用 g UI 打开')
  assert.equal(sanitizeMenuLabel('x'.repeat(200)).length, 64)
})

test('buildMenuCommand: 指向本包 CLI 的 ui 子命令，目录交给 %V', () => {
  const command = buildMenuCommand({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', entryPath: 'D:\\a b\\gitCommit.js' })
  assert.equal(command, '"C:\\Program Files\\nodejs\\node.exe" "D:\\a b\\gitCommit.js" ui --path="%V"')
  // 不带 cmd.exe / start：%V 由 Explorer 展开后才交给 node，中间没有第二层词法
  assert.doesNotMatch(command, /cmd\.exe/i)
})

test('install: 两个落点都写入标题 + 图标 + command 子键', async () => {
  const { calls, execFileFn } = createFakeReg()
  const { label } = await installExplorerContextMenu({ label: '用 g UI 打开', execFileFn, nodePath: 'C:\\node\\node.exe', entryPath: 'D:\\zen\\gitCommit.js' })

  assert.equal(label, '用 g UI 打开')
  const menuKeys = targetsOf(calls, 'add').filter((k) => !k.endsWith('\\command'))
  assert.deepEqual([...new Set(menuKeys)], [...MENU_REGISTRY_ROOTS])
  assert.deepEqual(targetsOf(calls, 'add').filter((k) => k.endsWith('\\command')), MENU_REGISTRY_ROOTS.map((k) => `${k}\\command`))
  for (const call of calls) {
    assert.equal(call.file, 'reg.exe')
    assert.ok(call.args.includes('/f'), 'reg add 必须带 /f，否则第二次点击会弹覆盖确认')
  }
  const titleCall = calls.find((c) => c.args[1] === MENU_REGISTRY_ROOTS[0] && c.args[2] === '/ve')
  assert.deepEqual(titleCall.args.slice(-2), ['用 g UI 打开', '/f'])
  const commandCall = calls.find((c) => c.args[1] === `${MENU_REGISTRY_ROOTS[0]}\\command`)
  assert.equal(commandCall.args.at(-2), '"C:\\node\\node.exe" "D:\\zen\\gitCommit.js" ui --path="%V"')
})

test('install: 客户端传来的脏标题被清洗后写入', async () => {
  const { calls, execFileFn } = createFakeReg()
  await installExplorerContextMenu({ label: 'Open with g UI\r\nrm -rf /', execFileFn })
  const titleCall = calls.find((c) => c.args[1] === MENU_REGISTRY_ROOTS[0] && c.args[2] === '/ve')
  assert.equal(titleCall.args.at(-2), 'Open with g UI  rm -rf /')
})

test('uninstall: 两个落点都删，键不存在(退出码 1)不算失败', async () => {
  const missing = Object.assign(new Error('reg.exe exited with code 1'), { code: 1 })
  const { calls, execFileFn } = createFakeReg({ fail: (args) => (args[0] === 'delete' && args[1].includes('Background') ? missing : false) })
  await uninstallExplorerContextMenu({ execFileFn })
  assert.deepEqual(targetsOf(calls, 'delete'), [...MENU_REGISTRY_ROOTS])
})

test('uninstall: 真正的删除失败(非"键不存在")必须抛出来', async () => {
  const { execFileFn } = createFakeReg({ fail: () => Object.assign(new Error('拒绝访问'), { code: 5 }) })
  await assert.rejects(() => uninstallExplorerContextMenu({ execFileFn }), /拒绝访问/)
})

test('status: 两个键都在才算已安装', async () => {
  const both = createFakeReg()
  assert.equal((await getExplorerContextMenuStatus({ execFileFn: both.execFileFn })).installed, true)
  assert.deepEqual(targetsOf(both.calls, 'query'), [...MENU_REGISTRY_ROOTS])

  const half = createFakeReg({ fail: (args) => (args[1].includes('Background') ? Object.assign(new Error('missing'), { code: 1 }) : false) })
  const status = await getExplorerContextMenuStatus({ execFileFn: half.execFileFn })
  assert.equal(status.installed, false)
  assert.equal(status.keys[MENU_REGISTRY_ROOTS[1]], false)
})

// ── 路由层 ────────────────────────────────────────────────────────────────

function createRouteHarness(options) {
  const routes = new Map()
  const app = {
    get(path, handler) { routes.set(`GET ${path}`, handler) },
    post(path, handler) { routes.set(`POST ${path}`, handler) },
  }
  registerExplorerContextMenuRoutes({ app, ...options })
  async function request(key, body) {
    const response = { code: 200, body: null, status(code) { this.code = code; return this }, json(value) { this.body = value; return this } }
    await routes.get(key)({ method: key.split(' ')[0], path: key.split(' ')[1], body }, response, () => {})
    return response
  }
  return { request }
}

test('route: 非 Windows 返回 supported=false，写操作直接 400', async () => {
  const { calls, execFileFn } = createFakeReg()
  const { request } = createRouteHarness({ platform: 'darwin', execFileFn })

  const status = await request('GET /api/explorer-context-menu')
  assert.equal(status.body.supported, false)
  assert.equal(status.body.installed, false)

  for (const key of ['POST /api/explorer-context-menu/install', 'POST /api/explorer-context-menu/uninstall']) {
    const response = await request(key)
    assert.equal(response.code, 400)
    assert.equal(response.body.success, false)
  }
  assert.equal(calls.length, 0, '非 Windows 不该调用 reg.exe')
})

test('route: 安装→查询→卸载 的状态流转', async () => {
  const installedKeys = new Set()
  const execFileFn = async (file, args) => {
    assert.equal(file, 'reg.exe')
    if (args[0] === 'add') return { stdout: '', stderr: '' }
    if (args[0] === 'delete') { installedKeys.delete(args[1]); return { stdout: '', stderr: '' } }
    if (installedKeys.has(args[1])) return { stdout: '', stderr: '' }
    throw Object.assign(new Error('missing'), { code: 1 })
  }
  // add 之后把键记成已存在，模拟真实注册表
  const wrapping = async (file, args) => { const r = await execFileFn(file, args); if (args[0] === 'add' && !args[1].endsWith('\\command')) installedKeys.add(args[1]); return r }

  const { request } = createRouteHarness({ platform: 'win32', execFileFn: wrapping, nodePath: 'C:\\node\\node.exe', entryPath: 'D:\\zen\\gitCommit.js' })

  assert.equal((await request('GET /api/explorer-context-menu')).body.installed, false)

  const install = await request('POST /api/explorer-context-menu/install', { label: '用 g UI 打开' })
  assert.equal(install.body.success, true)
  assert.match(install.body.message, /用 g UI 打开/)

  assert.equal((await request('GET /api/explorer-context-menu')).body.installed, true)

  const uninstall = await request('POST /api/explorer-context-menu/uninstall')
  assert.equal(uninstall.body.success, true)
  assert.equal((await request('GET /api/explorer-context-menu')).body.installed, false)
})

test('route: reg.exe 写失败时返回 400 和原因', async () => {
  const { execFileFn } = createFakeReg({ fail: () => Object.assign(new Error('拒绝访问注册表'), { code: 5 }) })
  const { request } = createRouteHarness({ platform: 'win32', execFileFn })
  const response = await request('POST /api/explorer-context-menu/install', { label: '用 g UI 打开' })
  assert.equal(response.code, 400)
  assert.match(response.body.error, /拒绝访问注册表/)
})
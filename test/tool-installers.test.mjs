import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getToolInstallers, registerFileOpenRoutes } from '../src/ui/server/routes/fileOpen.js'

test('tool installers: Windows 使用 winget + 固定 npm 包名', () => {
  const installers = getToolInstallers('win32', () => true)

  assert.equal(installers.vscode.executable, 'winget')
  assert.deepEqual(installers.vscode.args.slice(0, 3), ['install', '--id', 'Microsoft.VisualStudioCode'])
  assert.equal(installers.claude.executable, 'npm.cmd')
  assert.deepEqual(installers.claude.args, ['install', '-g', '@anthropic-ai/claude-code'])
  assert.deepEqual(installers.codex.args, ['install', '-g', '@openai/codex'])
  assert.deepEqual(installers.opencode.args, ['install', '-g', 'opencode-ai'])
})

test('tool installers: macOS 和 Linux 选择平台对应的 VS Code 安装器', () => {
  const mac = getToolInstallers('darwin', command => command === 'brew' || command === 'npm')
  assert.equal(mac.vscode.supported, true)
  assert.equal(mac.vscode.command, 'brew install --cask visual-studio-code')

  const linuxWithSnap = getToolInstallers('linux', command => command === 'snap' || command === 'npm')
  assert.equal(linuxWithSnap.vscode.supported, true)
  assert.equal(linuxWithSnap.vscode.executable, 'sudo')
  assert.deepEqual(linuxWithSnap.vscode.args, ['snap', 'install', 'code', '--classic'])

  const linuxWithoutManager = getToolInstallers('linux', () => false)
  assert.equal(linuxWithoutManager.vscode.supported, false)
  assert.equal(linuxWithoutManager.codex.supported, false)
  assert.ok(linuxWithoutManager.vscode.docsUrl.startsWith('https://'))
})

test('install API: 拒绝任意命令和未知工具 id', async () => {
  const routes = new Map()
  const app = {
    post(path, handler) { routes.set(`POST ${path}`, handler) },
    get(path, handler) { routes.set(`GET ${path}`, handler) },
  }
  registerFileOpenRoutes({ app })

  const handler = routes.get('POST /api/install-tool')
  assert.equal(typeof handler, 'function')

  let statusCode = 200
  let payload = null
  const req = {
    method: 'POST',
    path: '/api/install-tool',
    body: { tool: 'npm', command: 'malicious-command' },
  }
  const res = {
    headersSent: false,
    status(code) { statusCode = code; return this },
    json(value) { payload = value; return this },
  }

  await handler(req, res, () => {})
  assert.equal(statusCode, 400)
  assert.equal(payload.success, false)
  assert.equal(payload.error, '不支持的工具')
})

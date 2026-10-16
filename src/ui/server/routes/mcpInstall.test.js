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
// 「添加 zen-gitsync MCP」GUI 路由（routes/mcpInstall.js）的契约测试。
//
// 守两条线:
//   · 路由确实注册了三个端点,参数缺失 / 未知 target 走 400 且不写文件;
//   · 安装链路真的把条目写进了目标配置文件(用 ZEN_MCP_HOME 指到临时目录)。
// 安装逻辑本身的逐家形状在 src/mcp/install.test.js,这里不重复。
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { registerMcpInstallRoutes } from './mcpInstall.js'

/** 收集 app.get/post 的假 express(与 fileOpen.test.js 同一套路) */
function fakeApp() {
  const routes = new Map()
  return {
    routes,
    get(p, h) { routes.set(`GET ${p}`, h) },
    post(p, h) { routes.set(`POST ${p}`, h) },
  }
}

function fakeRes() {
  const res = {
    statusCode: 200,
    payload: null,
    status(code) { res.statusCode = code; return res },
    json(value) { res.payload = value; return res },
  }
  return res
}

let tmpHome = ''
const savedHome = process.env.ZEN_MCP_HOME

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-mcp-route-'))
  process.env.ZEN_MCP_HOME = tmpHome
  await fs.mkdir(path.join(tmpHome, '.codex'), { recursive: true })
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env.ZEN_MCP_HOME
  else process.env.ZEN_MCP_HOME = savedHome
  await fs.rm(tmpHome, { recursive: true, force: true })
})

test('三个端点都注册了', () => {
  const app = fakeApp()
  registerMcpInstallRoutes({ app })
  assert.ok(app.routes.has('GET /api/mcp-install/targets'))
  assert.ok(app.routes.has('POST /api/mcp-install/install'))
  assert.ok(app.routes.has('POST /api/mcp-install/remove'))
})

test('install: 缺 target 参数 → 400', async () => {
  const app = fakeApp()
  registerMcpInstallRoutes({ app })
  const res = fakeRes()
  await app.routes.get('POST /api/mcp-install/install')({ body: {} }, res, () => {})
  assert.equal(res.statusCode, 400)
  assert.equal(res.payload.success, false)
  assert.match(res.payload.error, /target/)
})

test('install: 未知 target → 400 且不写任何文件', async () => {
  const app = fakeApp()
  registerMcpInstallRoutes({ app })
  const res = fakeRes()
  await app.routes.get('POST /api/mcp-install/install')({ body: { target: 'evil-path' } }, res, () => {})
  assert.equal(res.statusCode, 400)
  const entries = await fs.readdir(tmpHome, { recursive: true })
  assert.deepEqual(entries, ['.codex'])
})

test('install: 登记成功 → success + message 带文件路径;再移除 → 段消失', async () => {
  const app = fakeApp()
  registerMcpInstallRoutes({ app })

  const res = fakeRes()
  await app.routes.get('POST /api/mcp-install/install')({ body: { target: 'codex' } }, res, () => {})
  assert.equal(res.statusCode, 200)
  assert.equal(res.payload.success, true)
  assert.equal(res.payload.changed, true)
  assert.match(res.payload.message, /Codex CLI/)
  const toml = await fs.readFile(path.join(tmpHome, '.codex', 'config.toml'), 'utf8')
  assert.match(toml, /\[mcp_servers\.zen-gitsync\]/)

  const res2 = fakeRes()
  await app.routes.get('POST /api/mcp-install/remove')({ body: { target: 'codex' } }, res2, () => {})
  assert.equal(res2.payload.success, true)
  const after = await fs.readFile(path.join(tmpHome, '.codex', 'config.toml'), 'utf8')
  assert.doesNotMatch(after, /zen-gitsync/)
})

test('targets: 返回全部目标及 installed 状态', async () => {
  const app = fakeApp()
  registerMcpInstallRoutes({ app })
  const res = fakeRes()
  await app.routes.get('GET /api/mcp-install/targets')({}, res, () => {})
  assert.equal(res.payload.success, true)
  const ids = res.payload.targets.map(t => t.id)
  assert.ok(ids.includes('claude-code'))
  assert.ok(ids.includes('codex'))
  assert.ok(ids.includes('opencode'))
  assert.ok(res.payload.targets.every(t => t.installed === false), '临时 HOME 里谁都还没登记')
})

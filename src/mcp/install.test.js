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
// MCP 安装模块（src/mcp/install.js）的回归测试。
//
// 这个模块对外动作是**写别人产品的配置文件**，所以每条契约都不能只跑 happy path：
//   · 合并写入不能吃掉用户已有的 server / 配置项（各目标形状不同，逐家钉）；
//   · 幂等（第二次安装 changed=false，且不再产生 .bak）；
//   · 移除只删自己那一段；
//   · 配置坏掉（JSONC 注释 / 非对象层）时**跳过并报错**，绝不写坏；
//   · 目标目录不存在 → skipped，不凭空造文件。
//
// 路径全部用 ZEN_MCP_HOME / ZEN_MCP_APPDATA / PI_CODING_AGENT_DIR 指到临时目录
// （install.js 的 file() 是调用时求值，import 之后设环境变量来得及）。
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { install, uninstall, listTargets, TARGETS, SERVER_ID } from './install.js'

const ENV_KEYS = ['ZEN_MCP_HOME', 'ZEN_MCP_APPDATA', 'PI_CODING_AGENT_DIR']

let tmpHome = ''
let tmpAppData = ''
let tmpPiDir = ''
const savedEnv = {}

beforeEach(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-mcp-home-'))
  tmpAppData = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-mcp-appdata-'))
  tmpPiDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-mcp-pi-'))
  process.env.ZEN_MCP_HOME = tmpHome
  process.env.ZEN_MCP_APPDATA = tmpAppData
  process.env.PI_CODING_AGENT_DIR = tmpPiDir
})

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  await fs.rm(tmpHome, { recursive: true, force: true })
  await fs.rm(tmpAppData, { recursive: true, force: true })
  await fs.rm(tmpPiDir, { recursive: true, force: true })
})

const readJson = async (p) => JSON.parse(await fs.readFile(p, 'utf8'))
const p = (...seg) => path.join(tmpHome, ...seg)

/** VS Code 用户级 mcp.json 的路径按平台分叉(win 走 APPDATA,其余走 XDG),与 install.js 同口径 */
const vscodeFile = () => process.platform === 'win32'
  ? path.join(tmpAppData, 'Code', 'User', 'mcp.json')
  : p('.config', 'Code', 'User', 'mcp.json')

/** 目标产品的父目录存在，parentExists 才放行 */
async function ensureParent(file) {
  await fs.mkdir(path.dirname(file), { recursive: true })
}

// ── Claude Code（~/.claude.json，默认 mcpServers 键） ───────────────

test('claude-code: 合并写入，保留用户已有的 mcpServers 与其它配置', async () => {
  const file = p('.claude.json')
  await ensureParent(file)
  await fs.writeFile(file, JSON.stringify({
    projects: { 'C:\\proj': { allowedTools: ['Bash'] } },
    mcpServers: { other: { command: 'other', args: ['x'] } },
  }, null, 2))

  const r = await install('claude-code')
  assert.equal(r.ok, true)
  assert.equal(r.changed, true)
  assert.equal(r.backup, true)
  assert.ok(existsSync(`${file}.bak`), '写入前应备份')

  const after = await readJson(file)
  assert.deepEqual(after.mcpServers.other, { command: 'other', args: ['x'] })
  assert.deepEqual(after.mcpServers[SERVER_ID], { command: 'g', args: ['mcp'] })
  assert.deepEqual(after.projects['C:\\proj'], { allowedTools: ['Bash'] })
})

test('claude-code: 幂等 —— 第二次安装 changed=false 且不再备份', async () => {
  const file = p('.claude.json')
  await ensureParent(file)
  await install('claude-code')
  const first = await fs.readFile(file, 'utf8')
  await fs.rm(`${file}.bak`, { force: true })

  const r = await install('claude-code')
  assert.equal(r.ok, true)
  assert.equal(r.changed, false)
  assert.equal(r.backup, false)
  assert.equal(await fs.readFile(file, 'utf8'), first)
})

test('claude-code: 移除只删自己那一段', async () => {
  const file = p('.claude.json')
  await ensureParent(file)
  await fs.writeFile(file, JSON.stringify({
    mcpServers: { other: { command: 'o' }, [SERVER_ID]: { command: 'g', args: ['mcp'] } },
  }, null, 2))

  const r = await uninstall('claude-code')
  assert.equal(r.ok, true)
  assert.equal(r.changed, true)
  const after = await readJson(file)
  assert.ok(!(SERVER_ID in after.mcpServers))
  assert.deepEqual(after.mcpServers.other, { command: 'o' })
})

// ── VS Code（servers 键，不是 mcpServers） ─────────────────────────

test('vscode: 写到 servers 键下；已有 mcpServers 键不受影响', async () => {
  const file = vscodeFile()
  await ensureParent(file)
  await fs.writeFile(file, JSON.stringify({ servers: { keep: { command: 'k' } } }, null, 2))

  const r = await install('vscode')
  assert.equal(r.ok, true)
  const after = await readJson(file)
  assert.deepEqual(after.servers.keep, { command: 'k' })
  assert.deepEqual(after.servers[SERVER_ID], { command: 'g', args: ['mcp'] })
  // VS Code 的格式里没有 mcpServers 这一说，不能顺手建一个
  assert.equal(after.mcpServers, undefined)
})

// ── OpenCode（mcp 键 + 数组 command + enabled） ─────────────────────

test('opencode: entry 形状是 type/command 数组/enabled，且保留 mcp 下的其他 server', async () => {
  const file = p('.config', 'opencode', 'opencode.json')
  await ensureParent(file)
  await fs.writeFile(file, JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    mcp: { other: { type: 'local', command: ['o', 's'], enabled: true } },
  }, null, 2))

  const r = await install('opencode')
  assert.equal(r.ok, true)
  const after = await readJson(file)
  assert.deepEqual(after.mcp[SERVER_ID], { type: 'local', command: ['g', 'mcp'], enabled: true })
  assert.deepEqual(after.mcp.other, { type: 'local', command: ['o', 's'], enabled: true })
  assert.equal(after.$schema, 'https://opencode.ai/config.json')
})

test('opencode: 用户已按新版把 server 挂在 mcp.servers 下时，两处共存不互删', async () => {
  const file = p('.config', 'opencode', 'opencode.json')
  await ensureParent(file)
  await fs.writeFile(file, JSON.stringify({
    mcp: { servers: { other: { type: 'local', command: ['o', 's'] } } },
  }, null, 2))

  const r = await install('opencode')
  assert.equal(r.ok, true)
  const after = await readJson(file)
  assert.deepEqual(after.mcp[SERVER_ID], { type: 'local', command: ['g', 'mcp'], enabled: true })
  assert.deepEqual(after.mcp.servers.other, { type: 'local', command: ['o', 's'] })
})

// ── CodeBuddy（三选一文件优先级 + JSONC 熔断） ──────────────────────

test('codebuddy: 都没建过 → 建优先级最高的 ~/.codebuddy/.mcp.json', async () => {
  // ~/.codebuddy 目录存在 = 这个产品在这台机器上跑过(parentExists 的判据);
  // 目录都没有时安装会按"未检测到"跳过,那条契约在下面的通用用例里验。
  await fs.mkdir(p('.codebuddy'), { recursive: true })
  const r = await install('codebuddy')
  assert.equal(r.ok, true)
  assert.equal(r.file, p('.codebuddy', '.mcp.json'))
  const after = await readJson(r.file)
  assert.deepEqual(after.mcpServers[SERVER_ID], { type: 'stdio', command: 'g', args: ['mcp'] })
})

test('codebuddy: legacy ~/.codebuddy.json 已存在 → 合并进它，不建新文件（否则旧 server 消失）', async () => {
  await ensureParent(p('.codebuddy.json'))
  await fs.writeFile(p('.codebuddy.json'), JSON.stringify({
    mcpServers: { other: { command: 'o' } },
  }, null, 2))

  const r = await install('codebuddy')
  assert.equal(r.ok, true)
  assert.equal(r.file, p('.codebuddy.json'))
  assert.ok(!existsSync(p('.codebuddy', '.mcp.json')), '不得新建会遮蔽旧配置的文件')
  const after = await readJson(p('.codebuddy.json'))
  assert.deepEqual(after.mcpServers.other, { command: 'o' })
  assert.deepEqual(after.mcpServers[SERVER_ID], { type: 'stdio', command: 'g', args: ['mcp'] })
})

test('codebuddy: 配置文件带 JSONC 注释 → 跳过并报错，绝不写坏', async () => {
  const file = p('.codebuddy', '.mcp.json')
  await ensureParent(file)
  await fs.writeFile(file, '{\n  // 注释\n  "mcpServers": {}\n}\n')

  const r = await install('codebuddy')
  assert.equal(r.ok, false)
  assert.match(r.error, /不是合法 JSON/)
  // 原文件一字未动
  assert.match(await fs.readFile(file, 'utf8'), /\/\/ 注释/)
})

// ── Pi Agent（agentDir 可被环境变量覆盖） ───────────────────────────

test('pi: 默认写 ~/.pi/agent/mcp.json；PI_CODING_AGENT_DIR 覆盖生效', async () => {
  const r1 = await install('pi')
  assert.equal(r1.ok, true)
  assert.equal(r1.file, path.join(tmpPiDir, 'mcp.json'))
  assert.deepEqual((await readJson(r1.file)).mcpServers[SERVER_ID], { command: 'g', args: ['mcp'] })

  delete process.env.PI_CODING_AGENT_DIR
  await fs.mkdir(p('.pi', 'agent'), { recursive: true })
  const r2 = await install('pi')
  assert.equal(r2.ok, true)
  assert.equal(r2.file, p('.pi', 'agent', 'mcp.json'))
})

// ── Codex（TOML） ──────────────────────────────────────────────────

test('codex: 追加 [mcp_servers.zen-gitsync] 段，原有段落逐字保留', async () => {
  const file = p('.codex', 'config.toml')
  await ensureParent(file)
  const original = [
    'model = "gpt-6-astra"',
    '',
    '[mcp_servers]',
    '',
    '[mcp_servers.cua_repl]',
    "command = 'C:\\\\Tools\\\\cua.exe'",
    'enabled = false',
    '',
    '[windows]',
    'sandbox = "unelevated"',
    '',
  ].join('\n')
  await fs.writeFile(file, original)

  const r = await install('codex')
  assert.equal(r.ok, true)
  assert.equal(r.changed, true)
  const text = await fs.readFile(file, 'utf8')
  assert.match(text, /\[mcp_servers\.zen-gitsync\]/)
  assert.match(text, /command = "g"/)
  assert.match(text, /args = \["mcp"\]/)
  // 原有内容一行不少（cua_repl / windows 段 / model 行）
  for (const line of original.split('\n').filter(Boolean)) {
    assert.ok(text.includes(line), `原有行被改动: ${line}`)
  }
})

test('codex: 幂等 + 移除只删自己那一段', async () => {
  const file = p('.codex', 'config.toml')
  await ensureParent(file)
  await fs.writeFile(file, 'model = "m"\n\n[mcp_servers.cua_repl]\ncommand = "c"\n')

  await install('codex')
  const once = await fs.readFile(file, 'utf8')
  const r2 = await install('codex')
  assert.equal(r2.changed, false)
  assert.equal(await fs.readFile(file, 'utf8'), once)

  const r3 = await uninstall('codex')
  assert.equal(r3.ok, true)
  const text = await fs.readFile(file, 'utf8')
  assert.doesNotMatch(text, /zen-gitsync/)
  assert.match(text, /\[mcp_servers\.cua_repl\]/, '别人的 server 不能被动到')
})

// ── 通用契约 ───────────────────────────────────────────────────────

test('listTargets: 安装后 installed 翻真，且返回目标 id 全覆盖', async () => {
  await ensureParent(p('.claude.json'))
  const before = await listTargets()
  assert.ok(before.find(t => t.id === 'claude-code' && !t.installed))
  await install('claude-code')
  const after = await listTargets()
  assert.ok(after.find(t => t.id === 'claude-code' && t.installed))
  // TARGETS 与 listTargets 输出的 id 集合一致（GUI 靠 id 映射，错位就点错人）
  assert.deepEqual(after.map(t => t.id).sort(), TARGETS.map(t => t.id).sort())
})

test('目标目录不存在 → skipped，不凭空造配置文件', async () => {
  // cursor 的 ~/.cursor 目录没建 → 未检测到
  const r = await install('cursor')
  assert.equal(r.ok, true)
  assert.equal(r.skipped, true)
  assert.match(r.reason, /没检测到/)
  assert.ok(!existsSync(p('.cursor', 'mcp.json')))
})

test('未知 target id → ok:false，不写任何文件', async () => {
  const r = await install('not-a-tool')
  assert.equal(r.ok, false)
  assert.match(r.error, /未知目标/)
})

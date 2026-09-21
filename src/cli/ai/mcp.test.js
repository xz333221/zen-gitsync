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
// MCP stdio 客户端的回归测试。
//
// 这里最值钱的一条是 buildSpawnSpec 的转义用例 —— Windows 上
// `spawn(cmd, args, { shell: true })` 会把含空格的参数拆碎(实测 C:\a b\proj
// 会变成 "C:a" + "bproj"),而直接 spawn .cmd 又会被 Node 拒绝(EINVAL)。
// 项目路径带空格是常态,这两条任一回归都会让"装了 MCP 但连不上"变成玄学问题。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const sandboxHome = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-mcp-home-'));
const sandboxProject = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-mcp-project-'));
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

const { buildSpawnSpec, loadMcpServers, McpManager } = await import('./mcp.js');
const { AI_MCP_FILE } = await import('../../paths.js');

const IS_WIN = process.platform === 'win32';

// ── buildSpawnSpec ────────────────────────────────────────────

test('buildSpawnSpec: 解析到可执行文件时不经 shell,参数原样保留', () => {
  const spec = buildSpawnSpec(process.execPath, ['-e', 'console.log(1)', 'C:\\a b\\proj'], {});
  assert.equal(spec.file, process.execPath);
  assert.deepEqual(spec.argv, ['-e', 'console.log(1)', 'C:\\a b\\proj']);
  assert.notEqual(spec.options.shell, true, '绝不能用 shell:true —— 含空格的参数会被拆碎');
  assert.equal(spec.options.windowsVerbatimArguments, undefined, '直接 spawn 时不应开启 verbatim');
});

test('buildSpawnSpec: 批处理走 cmd.exe,反斜杠与元字符按 cmd 规则转义', { skip: !IS_WIN }, () => {
  const spec = buildSpawnSpec('npx', ['-y', 'pkg', 'C:\\a b\\proj', 'trail\\', 'a&b'], {});
  assert.match(spec.file, /cmd\.exe$/i, '批处理必须交给 cmd.exe');
  assert.deepEqual(spec.argv.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(spec.options.windowsVerbatimArguments, true, '整行由我们自己转义,不能再让 Node 加引号');

  const line = spec.argv[3];
  assert.match(line, /"C:\\a b\\proj"/, '含空格的路径必须整体加引号,否则会被拆成两段');
  assert.match(line, /"trail\\\\"/, '行尾反斜杠必须加倍,否则会被 cmd 当转义符吃掉');
  assert.match(line, /a\^&b/, '元字符 & 必须加 ^ 前缀,否则会被当成管道/顺序执行');
  // 整行外层再加一层引号,配合 /s 的"去掉首尾引号"规则
  assert.ok(line.startsWith('""') && line.endsWith('""'), `整行需要被引号包裹: ${line}`);
});

test('buildSpawnSpec: 含空格的 .cmd 实参能原样到达子进程(端到端)', { skip: !IS_WIN }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-mcp-cmd-'));
  const script = path.join(dir, 'echo-args.cmd');
  // %* 会把收到的参数原样回显,是最直接的"参数有没有被拆碎"探针
  await fs.writeFile(script, '@echo off\r\necho ARGS:%*\r\n', 'utf8');

  const spaced = 'C:\\a b\\proj';
  const spec = buildSpawnSpec(script, [spaced, 'plain'], {});
  const output = await new Promise((resolve, reject) => {
    const child = spawn(spec.file, spec.argv, { ...spec.options });
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; });
    child.on('error', reject);
    child.on('exit', () => resolve(text.trim()));
  });

  assert.match(output, /ARGS:.*a b.*proj/, `参数被拆碎了,实际情况: ${output}`);
  assert.match(output, /plain/);
});

// ── loadMcpServers ────────────────────────────────────────────

test('loadMcpServers: 项目级覆盖全局同名 server,坏的 JSON 只当没有配置', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-mcp-merge-'));
  await fs.mkdir(path.dirname(AI_MCP_FILE), { recursive: true });
  await fs.writeFile(AI_MCP_FILE, JSON.stringify({
    mcpServers: {
      shared: { command: 'npx', args: ['global'] },
      onlyGlobal: { command: 'npx', args: ['g'] },
      broken: { args: ['no-command'] },
    },
  }), 'utf8');
  await fs.writeFile(path.join(project, '.mcp.json'), JSON.stringify({
    mcpServers: { shared: { command: 'npx', args: ['project'] } },
  }), 'utf8');

  const { servers, sources } = await loadMcpServers({ cwd: project });
  assert.deepEqual(servers.shared.args, ['project'], '项目级应覆盖全局级');
  assert.ok(servers.onlyGlobal);
  assert.equal(servers.broken, undefined, '没有 command 的条目应被丢弃');
  assert.equal(sources.length, 2);

  // 坏文件:整个文件当空配置,不抛错
  await fs.writeFile(path.join(project, '.mcp.json'), '{ this is not json', 'utf8');
  const broken = await loadMcpServers({ cwd: project });
  assert.deepEqual(broken.servers.shared.args, ['global'], '坏的项目配置应回落到全局配置');
});

// ── 真实 stdio 往返 ───────────────────────────────────────────

// 一个最小可用的 MCP server:换行分隔 JSON-RPC,只实现握手 + tools/list + tools/call。
const FAKE_SERVER = `
let buffer = '';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } });
    } else if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [
        { name: 'echo', description: '回显输入', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
        { name: 'weird-name/with spaces', description: '', inputSchema: { type: 'object' } },
        { name: 'boom', description: '永远失败', inputSchema: { type: 'object' } },
      ] } });
    } else if (message.method === 'tools/call') {
      if (message.params.name === 'boom') {
        send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: '炸了' }] } });
      } else if (message.params.name === 'weird-name/with spaces') {
        send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'image', mimeType: 'image/png' }] } });
      } else {
        send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'echo:' + (message.params.arguments?.text ?? '') }] } });
      }
    }
  }
});
`;

async function startFakeManager({ servers }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-mcp-fake-'));
  const script = path.join(dir, 'fake-mcp.mjs');
  await fs.writeFile(script, FAKE_SERVER, 'utf8');
  return await McpManager.create({
    cwd: sandboxProject,
    servers: servers ?? { fake: { command: process.execPath, args: [script] } },
  });
}

test('McpManager: 握手后把工具挂成 mcp__<server>__<tool>,名字收敛到安全字符集', async () => {
  const manager = await startFakeManager({});
  try {
    assert.deepEqual(manager.status().map(s => s.error), [null], 'server 应连接成功');
    const names = manager.toolDefinitions.map(tool => tool.function.name);
    assert.ok(names.includes('mcp__fake__echo'));
    // OpenAI function name 只允许 [A-Za-z0-9_-],空格与斜杠必须被替换
    assert.ok(names.some(name => name === 'mcp__fake__weird-name_with_spaces'), names.join(','));
    for (const tool of manager.toolDefinitions) {
      assert.match(tool.function.name, /^[a-zA-Z0-9_-]+$/);
      assert.ok(tool.function.parameters, '每个工具都要带 inputSchema');
    }
  } finally {
    await manager.close();
  }
});

test('McpManager: tools/call 的 content 数组被拍平成字符串回喂给模型', async () => {
  const manager = await startFakeManager({});
  try {
    assert.equal(await manager.call('mcp__fake__echo', { text: '你好' }), 'echo:你好');
    // isError 的结果也要变成可读字符串,而不是把异常抛进 agent 循环
    assert.match(await manager.call('mcp__fake__boom', {}), /^错误: 炸了/);
    // 非文本 part 用占位符表示,不能让模型看到 undefined
    assert.match(await manager.call('mcp__fake__weird-name_with_spaces', {}), /\[image image\/png/);
    // 不认识的名字返回 null,由调用方回落到内置工具
    assert.equal(await manager.call('mcp__nope__nope', {}), null);
  } finally {
    await manager.close();
  }
});

test('McpManager: 未知工具不进入 registry,describe 只描述真实工具数', async () => {
  const manager = await startFakeManager({});
  try {
    assert.equal(manager.has('mcp__fake__echo'), true);
    assert.equal(manager.has('read_file'), false, '内置工具不该被扩展层接管');
    assert.equal(manager.toolCount, 3);

    const zh = manager.describe({ locale: 'zh-CN' });
    assert.match(zh, /已接入的 MCP 服务/);
    assert.match(zh, /fake: 3 个工具/);
    assert.doesNotMatch(manager.describe({ locale: 'en' }), /已接入/);
  } finally {
    await manager.close();
  }
});

test('McpManager: 启动失败只记录错误,不抛异常也不拖垮其他 server', async () => {
  const manager = await McpManager.create({
    cwd: sandboxProject,
    servers: {
      good: { command: process.execPath, args: ['-e', 'process.stdin.resume()'] },
      missing: { command: IS_WIN ? 'definitely-not-a-real-command-xyz' : 'definitely-not-a-real-command-xyz', args: [] },
    },
  });
  try {
    const status = manager.status();
    assert.equal(status.length, 2);
    const missing = status.find(item => item.id === 'missing');
    assert.ok(missing.error, '起不来的 server 必须有可读错误');
    assert.equal(missing.tools, 0);
  } finally {
    await manager.close();
  }
});

test('McpManager: server 中途退出时调用立刻失败,而不是干等到超时', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-mcp-die-'));
  const script = path.join(dir, 'die.mjs');
  // 握完手就退出,模拟 server 崩溃
  await fs.writeFile(script, `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'die', version: '0' } } }) + '\\n');
    } else if (message.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'later', description: '', inputSchema: { type: 'object' } }] } }) + '\\n');
      setTimeout(() => process.exit(1), 30);
    }
  }
});
`, 'utf8');

  const manager = await McpManager.create({ cwd: sandboxProject, servers: { die: { command: process.execPath, args: [script] } } });
  try {
    assert.equal(manager.toolCount, 1);
    await new Promise(resolve => setTimeout(resolve, 120)); // 等子进程真的死掉
    const started = Date.now();
    const result = await manager.call('mcp__die__later', {});
    assert.ok(Date.now() - started < 5000, '应在子进程退出后立即返回,不该等满 120s 超时');
    assert.match(result, /错误: MCP 工具/);
    assert.match(String(result), /已退出|不可写/, `错误信息应说明原因,实际: ${result}`);
  } finally {
    await manager.close();
  }
});

test('McpManager: 没有配置任何 server 时是空管理器,不影响内置工具', async () => {
  const manager = await McpManager.create({ cwd: sandboxProject, servers: {} });
  try {
    assert.equal(manager.toolCount, 0);
    assert.deepEqual(manager.toolDefinitions, []);
    assert.equal(manager.describe({ locale: 'zh-CN' }), '', '没有连接成功任何 server 时不应往提示词里塞标题');
    assert.equal(await manager.call('mcp__x__y', {}), null);
  } finally {
    await manager.close();
  }
});

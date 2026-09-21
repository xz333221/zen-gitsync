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
// Skill / MCP 广场后端的回归测试。
//
// 重点钉住三类容易悄悄坏掉的行为:
//   1) 安装目标落盘位置(项目级 vs g ai 全局级)—— 路径一旦漂移,
//      前端显示"已安装"而 g ai 读不到,是最难排查的一类 bug;
//   2) 网络数据落盘前的白名单校验(仓库名 / 包名 / 子路径 / 路径穿越);
//   3) 单个来源抓取失败不能影响其他来源(按来源分组的核心承诺)。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── 沙箱 ──────────────────────────────────────────────────────
// paths.js 在模块加载时就用 os.homedir() 求值,必须在 import 之前改环境变量。
// HOMEDRIVE/HOMEPATH 是 Windows 上 os.homedir() 的另一条取值路径,必须删掉,
// 否则 USERPROFILE 改了也不生效。
const sandboxHome = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-mp-home-'));
const sandboxProject = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-mp-project-'));
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

const { registerAgentMarketplaceRoutes } = await import('./agentMarketplace.js');
const { AI_SKILLS_DIR, AI_MCP_FILE } = await import('../../../../paths.js');

// ── 测试脚手架:把注册的 handler 抓出来直接调 ──────────────────
function harness(currentProject = sandboxProject) {
  const handlers = new Map();
  const app = {
    get(route, handler) { handlers.set(`GET ${route}`, handler); },
    post(route, handler) { handlers.set(`POST ${route}`, handler); },
    delete(route, handler) { handlers.set(`DELETE ${route}`, handler); },
  };
  registerAgentMarketplaceRoutes({ app, getCurrentProjectPath: () => currentProject });

  const call = async (key, { query = {}, body = {}, params = {} } = {}) => {
    const handler = handlers.get(key);
    assert.ok(handler, `未注册路由: ${key}`);
    let payload = null;
    let status = 200;
    const res = {
      status(code) { status = code; return this; },
      json(data) { payload = data; return this; },
    };
    await handler({ method: key.split(' ')[0], path: key.split(' ')[1], query, body, params }, res);
    return { status, payload };
  };
  return { call };
}

async function exists(target) {
  return await fs.stat(target).then(() => true).catch(() => false);
}

test('catalog: 只查内置来源时完全离线,并保留按来源分组的形状', async () => {
  const { call } = harness();
  const { status, payload } = await call('GET /api/agent/marketplace/catalog', {
    query: { type: 'skill', sources: 'builtin', cwd: sandboxProject },
  });

  assert.equal(status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.groups.length, 1, '指定单个来源时只应返回该组');

  const [group] = payload.groups;
  assert.equal(group.id, 'builtin');
  assert.equal(group.status, 'ok');
  assert.ok(group.items.length > 0, '内置精选不能是空列表(否则离线时广场全空)');

  // 内置条目必须带可安装信息,否则前端会给出一个必然失败的按钮
  for (const item of group.items) {
    assert.ok(item.installable, `${item.name} 应可安装`);
    assert.ok(item.repository || item.package, `${item.name} 缺少仓库或包名`);
  }
});

test('catalog: 未指定来源时返回全部来源,每个来源是独立的一组', async () => {
  const { call } = harness();
  const { payload } = await call('GET /api/agent/marketplace/catalog', {
    query: { type: 'mcp', sources: 'builtin', cwd: sandboxProject },
  });
  const ids = payload.groups.map(group => group.id);
  assert.deepEqual(ids, ['builtin']);

  // 不带 sources 时应覆盖该类型的全部来源定义
  const { payload: all } = await call('GET /api/agent/marketplace/sources', { query: { type: 'mcp' } });
  assert.ok(all.sources.length >= 4, 'MCP 至少应有 4 个来源');
  assert.equal(all.sources[0].id, 'builtin');
});

test('sources: 拒绝未知类型', async () => {
  const { call } = harness();
  const { status, payload } = await call('GET /api/agent/marketplace/sources', { query: { type: 'plugin' } });
  assert.equal(status, 400);
  assert.equal(payload.success, false);
});

test('install skill: 项目级落到 <cwd>/.claude/skills,全局级落到 ~/.zen-gitsync/ai/skills', async () => {
  const { call } = harness();
  const content = '---\nname: demo\n description: x\n---\n# demo\n';
  const body = { type: 'skill', item: { id: 'demo-skill', name: 'demo', content } };

  const project = await call('POST /api/agent/marketplace/install', {
    body: { ...body, target: 'project', cwd: sandboxProject },
  });
  assert.equal(project.status, 200);
  assert.ok(await exists(path.join(sandboxProject, '.claude', 'skills', 'demo-skill', 'SKILL.md')));

  const global = await call('POST /api/agent/marketplace/install', {
    body: { ...body, target: 'global', cwd: sandboxProject },
  });
  assert.equal(global.status, 200);
  assert.ok(await exists(path.join(AI_SKILLS_DIR, 'demo-skill', 'SKILL.md')));
  // 全局级必须先解析到 paths.js 的常量,而不是某个自己拼的路径
  assert.equal(global.payload.item.dir, path.join(AI_SKILLS_DIR, 'demo-skill'));
});

test('install skill: 重复安装同一目标返回 409', async () => {
  const { call } = harness();
  const install = () => call('POST /api/agent/marketplace/install', {
    body: { type: 'skill', target: 'project', cwd: sandboxProject, item: { id: 'dup-skill', content: '---\nname: d\n---\n' } },
  });
  assert.equal((await install()).status, 200);
  const second = await install();
  assert.equal(second.status, 409);
  assert.match(second.payload.error, /已安装/);
});

test('install skill: 没有仓库也没有正文时拒绝,不产生空目录', async () => {
  const { call } = harness();
  const { status, payload } = await call('POST /api/agent/marketplace/install', {
    body: { type: 'skill', target: 'project', cwd: sandboxProject, item: { id: 'useless', name: 'useless' } },
  });
  assert.equal(status, 400);
  assert.match(payload.error, /没有可安装的仓库地址/);
  assert.equal(await exists(path.join(sandboxProject, '.claude', 'skills', 'useless')), false);
});

test('install skill: 仓库名与子路径都要过白名单', async () => {
  const { call } = harness();
  const cases = [
    { id: 'bad-repo-1', repository: 'https://evil.example.com/a/b' },
    { id: 'bad-repo-2', repository: '../../etc' },
    { id: 'bad-repo-3', repository: 'owner' },
  ];
  for (const item of cases) {
    const { status } = await call('POST /api/agent/marketplace/install', {
      body: { type: 'skill', target: 'project', cwd: sandboxProject, item },
    });
    assert.equal(status, 400, `${JSON.stringify(item)} 应被拒绝`);
  }
});

test('install mcp: 写入目标文件、补齐 name/description,并把 ${project} 展开成真实路径', async () => {
  const { call } = harness();
  const { status, payload } = await call('POST /api/agent/marketplace/install', {
    body: {
      type: 'mcp',
      target: 'project',
      cwd: sandboxProject,
      // 用 builtin 里带 ${project} 占位符的形态,但包名换成不会真去下载的名字
      item: {
        id: 'mcp-fake-fs',
        name: 'Fake FS',
        description: '测试用',
        package: '@modelcontextprotocol/server-filesystem',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '${project}'],
        envKeys: ['SOME_TOKEN'],
      },
    },
  });

  assert.equal(status, 200);
  const file = path.join(sandboxProject, '.mcp.json');
  const config = JSON.parse(await fs.readFile(file, 'utf8'));
  const server = config.mcpServers['mcp-fake-fs'];
  assert.ok(server, '应写入 mcpServers');
  assert.equal(server.command, 'npx');
  assert.equal(server.args[2], sandboxProject, '${project} 必须被替换成项目真实路径');
  assert.deepEqual(server.requiredEnv, ['SOME_TOKEN']);
  assert.equal(payload.item.file, file);
});

test('install mcp: 非法包名被拒绝,且不写出配置文件', async () => {
  const { call } = harness();
  const before = await exists(path.join(sandboxProject, '.mcp.json'));
  const { status } = await call('POST /api/agent/marketplace/install', {
    body: { type: 'mcp', target: 'project', cwd: sandboxProject, item: { id: 'evil', package: 'pkg; rm -rf /' } },
  });
  assert.equal(status, 400);
  if (!before) assert.equal(await exists(path.join(sandboxProject, '.mcp.json')), false);
});

test('install mcp: 只有远程端点时用 mcp-remote 桥接,而不是报错或装出一个无效配置', async () => {
  const { call } = harness();
  const { status } = await call('POST /api/agent/marketplace/install', {
    body: {
      type: 'mcp',
      target: 'global',
      cwd: sandboxProject,
      item: { id: 'remote-only', name: 'Remote', remoteUrl: 'https://example.com/mcp', transport: 'remote' },
    },
  });
  assert.equal(status, 200);
  const config = JSON.parse(await fs.readFile(AI_MCP_FILE, 'utf8'));
  const server = config.mcpServers['remote-only'];
  assert.equal(server.command, 'npx');
  assert.deepEqual(server.args, ['-y', 'mcp-remote', 'https://example.com/mcp']);
  assert.equal(server.transport, 'remote');
});

test('install mcp: 既没有包也没有远程端点时拒绝', async () => {
  const { call } = harness();
  const { status } = await call('POST /api/agent/marketplace/install', {
    body: { type: 'mcp', target: 'project', cwd: sandboxProject, item: { id: 'nothing', name: 'Nothing' } },
  });
  assert.equal(status, 422);
});

test('installed: 同时列出项目级与全局级,并标明 target', async () => {
  const { call } = harness();
  const { status, payload } = await call('GET /api/agent/marketplace/installed', {
    query: { type: 'skill', cwd: sandboxProject },
  });
  assert.equal(status, 200);
  const ids = payload.items.map(item => `${item.target}:${item.id}`);
  assert.ok(ids.includes('project:demo-skill'));
  assert.ok(ids.includes('global:demo-skill'));

  const { payload: mcpPayload } = await call('GET /api/agent/marketplace/installed', {
    query: { type: 'mcp', cwd: sandboxProject },
  });
  const mcpIds = mcpPayload.items.map(item => `${item.target}:${item.id}`);
  assert.ok(mcpIds.includes('project:mcp-fake-fs'));
  assert.ok(mcpIds.includes('global:remote-only'));
});

test('uninstall: 只删指定目标的那一份,另一份保留', async () => {
  const { call } = harness();
  const { status } = await call('DELETE /api/agent/marketplace/item/:type/:id', {
    params: { type: 'skill', id: 'demo-skill' },
    query: { target: 'project', cwd: sandboxProject },
  });
  assert.equal(status, 200);
  assert.equal(await exists(path.join(sandboxProject, '.claude', 'skills', 'demo-skill')), false);
  assert.ok(await exists(path.join(AI_SKILLS_DIR, 'demo-skill', 'SKILL.md')), '全局那份不应被连坐删掉');
});

test('uninstall: MCP 从配置里摘掉对应键,保留其他 server', async () => {
  const { call } = harness();
  const { status } = await call('DELETE /api/agent/marketplace/item/:type/:id', {
    params: { type: 'mcp', id: 'mcp-fake-fs' },
    query: { target: 'project', cwd: sandboxProject },
  });
  assert.equal(status, 200);
  const config = JSON.parse(await fs.readFile(path.join(sandboxProject, '.mcp.json'), 'utf8'));
  assert.equal(Object.prototype.hasOwnProperty.call(config.mcpServers, 'mcp-fake-fs'), false);
  assert.ok(await exists(AI_MCP_FILE), '全局配置文件应保持不变');
});

test('uninstall: 路径穿越形态的 id 被拒绝', async () => {
  const { call } = harness();
  for (const id of ['..', '../..', 'a/../../b', 'a\\b']) {
    const { status } = await call('DELETE /api/agent/marketplace/item/:type/:id', {
      params: { type: 'skill', id: encodeURIComponent(id) },
      query: { target: 'project', cwd: sandboxProject },
    });
    assert.equal(status, 400, `id=${id} 应被拒绝`);
  }
});

test('uninstall: 未安装的条目返回 404', async () => {
  const { call } = harness();
  const { status } = await call('DELETE /api/agent/marketplace/item/:type/:id', {
    params: { type: 'skill', id: 'never-installed' },
    query: { target: 'global', cwd: sandboxProject },
  });
  assert.equal(status, 404);
});

test('install: 项目不存在时拒绝,不会把 .claude/skills 建到奇怪的地方', async () => {
  const { call } = harness();
  const missing = path.join(sandboxProject, 'no-such-dir');
  const { status, payload } = await call('POST /api/agent/marketplace/install', {
    body: { type: 'skill', target: 'project', cwd: missing, item: { id: 'x', content: '---\nname: x\n---\n' } },
  });
  assert.equal(status, 400);
  assert.match(payload.error, /项目目录不存在/);
});

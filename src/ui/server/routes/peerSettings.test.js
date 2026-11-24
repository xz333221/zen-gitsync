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
// 「跨机器」设置面板后端的回归测试。
//
// 这组用例守的是**一条分工**：peer 端口整机唯一，只有 hub 负责 listen，
// 项目窗口一律不抢 —— 改开关时它转发给 hub，而不是自己绑 5600。
// 之前没有测试，回归时最典型的坏结果是"项目窗口也去 bind"（第二个窗口起不来）
// 或"开关开着但面板显示已停止"（状态只看本进程）。
//
// 隔离三件套（都必须，少一件就会碰到真实环境）：
//   · 沙箱 home —— paths.js 在**模块加载时**求值 DATA_DIR，所以先改 HOME/USERPROFILE，
//     再动态 import，peers.json 才会落在临时目录（见 src/paths.js 顶部说明）。
//   · 注入 runtime —— 否则 role=hub 的用例会真的 bind 一个 0.0.0.0 端口。
//   · 注入 query / fetchFn —— 否则读这台机器真实的实例注册表、真的往 hub 发请求。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const sandboxHome = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-peer-settings-'));
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
await fs.mkdir(path.join(sandboxHome, '.zen-gitsync'), { recursive: true });

const { registerPeerSettingsRoutes } = await import('./peerSettings.js');
const { createPeerApp } = await import('../../../peer/server.js');
const { PEERS_FILE } = await import('../../../paths.js');
const { ensureSelf, updateSelf, readState } = await import('../../../peer/store.js');

// 沙箱没生效就立刻停：后面的用例会往真实 peers.json 里写 enabled/port
assert.ok(
  PEERS_FILE.startsWith(sandboxHome),
  `沙箱未生效：PEERS_FILE=${PEERS_FILE}（不是 ${sandboxHome} 之下），拒绝继续跑`
);

/** 每个用例从干净状态开始：删掉 peers.json 后重新生成身份。 */
async function resetState(patch = {}) {
  await fs.rm(PEERS_FILE, { force: true });
  await ensureSelf();
  if (Object.keys(patch).length) await updateSelf(patch);
}

/** 造一个收集路由的假 app，并把 handler 包成"直接拿到响应"的 request。 */
function createHarness(options = {}) {
  const routes = new Map();
  const app = {
    get(p, h) { routes.set(`GET ${p}`, h); },
    post(p, h) { routes.set(`POST ${p}`, h); },
    delete(p, h) { routes.set(`DELETE ${p}`, h); }
  };
  registerPeerSettingsRoutes({ app, ...options });

  async function request(key, { body, query } = {}) {
    const handler = routes.get(key);
    if (!handler) throw new Error(`没有注册的路由：${key}`);
    const res = {
      code: 200,
      body: null,
      status(code) { this.code = code; return this; },
      json(value) { this.body = value; return this; }
    };
    await handler({ method: key.split(' ')[0], path: key.split(' ')[1], body, query: query || {} }, res, () => {});
    return res;
  }
  return { request, routes };
}

/** 假 runtime：默认"没在听"，调用次数记下来供断言。 */
function fakeRuntime({ running = false, port = 0, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    applyPeerRuntime: async (self) => {
      calls.push({ op: 'apply', self });
      if (fail) throw fail;
    },
    isPeerRunning: () => running,
    getPeerPort: () => port
  };
}

/** 假 query：默认"没有 hub、也没有人持有端口"。 */
function fakeQuery({ hub = null, owner = null } = {}) {
  return {
    findHubInstance: async () => hub,
    findPeerOwner: async () => owner
  };
}

/** 假 fetch：记录请求，按给定响应返回。 */
function fakeFetch(response) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (typeof response === 'function') return response(url, opts);
    return { ok: true, status: 200, json: async () => response };
  };
  return { calls, fn };
}

// ── 入参校验 ────────────────────────────────────────────────────────────────

test('POST self: 端口越界直接 400，且不落盘', async () => {
  await resetState();
  const runtime = fakeRuntime();
  const { request } = createHarness({ role: 'hub', runtime, query: fakeQuery() });

  const res = await request('POST /api/peer-settings/self', { body: { port: 70000 } });
  assert.equal(res.code, 400);
  assert.match(res.body.error, /1-65535/);
  assert.equal(runtime.calls.length, 0, '校验失败不该去动监听');

  const state = await readState(PEERS_FILE);
  assert.notEqual(state.self.port, 70000);
});

// ── project 角色：永不自己 listen ───────────────────────────────────────────

test('project 角色 + 没有 hub：开关照样落盘，但带 warning 说没人提供服务', async () => {
  await resetState();
  const runtime = fakeRuntime();
  const { request } = createHarness({ role: 'project', runtime, query: fakeQuery({ hub: null }) });

  const res = await request('POST /api/peer-settings/self', { body: { enabled: true, port: 5600 } });
  assert.equal(res.code, 200);
  assert.equal(res.body.running, false);
  assert.match(res.body.warning, /没有运行中的 hub/);
  assert.equal(runtime.calls.length, 0, 'project 角色绝不允许自己 bind 端口');

  const state = await readState(PEERS_FILE);
  assert.equal(state.self.enabled, true, '档位要落盘：hub 起来后按它生效');
  assert.equal(state.self.port, 5600);
});

test('project 角色 + 有 hub：转发 POST /reload 给 hub，并把它的结果原样带回', async () => {
  await resetState();
  const runtime = fakeRuntime();
  const fetch = fakeFetch({ success: true, running: true, port: 5600 });
  const { request } = createHarness({
    role: 'project',
    runtime,
    query: fakeQuery({ hub: { pid: 4242, port: 5599, role: 'hub' } }),
    fetchFn: fetch.fn
  });

  const res = await request('POST /api/peer-settings/self', { body: { enabled: true } });
  assert.equal(res.code, 200);
  assert.equal(res.body.running, true);
  assert.equal(res.body.warning, '');

  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, 'http://127.0.0.1:5599/api/peer-settings/reload');
  assert.equal(fetch.calls[0].opts.method, 'POST');
  assert.equal(runtime.calls.length, 0);
});

test('project 角色 + hub 不认识 reload（新旧版本混跑）：400 且说清是转发失败', async () => {
  await resetState();
  const fetch = fakeFetch(() => ({ ok: false, status: 404, json: async () => ({ success: false, error: 'not found' }) }));
  const { request } = createHarness({
    role: 'project',
    runtime: fakeRuntime(),
    query: fakeQuery({ hub: { pid: 4242, port: 5599, role: 'hub' } }),
    fetchFn: fetch.fn
  });

  const res = await request('POST /api/peer-settings/self', { body: { enabled: true } });
  assert.equal(res.code, 400);
  assert.match(res.body.error, /通知 hub 失败/);
  assert.match(res.body.error, /404/);
});

// ── hub 角色：就地起停 ──────────────────────────────────────────────────────

test('hub 角色：开关直接应用到本进程，running/port 取自 runtime', async () => {
  await resetState();
  const runtime = fakeRuntime({ running: true, port: 5600 });
  const { request } = createHarness({ role: 'hub', runtime, query: fakeQuery() });

  const res = await request('POST /api/peer-settings/self', { body: { enabled: true, port: 5600 } });
  assert.equal(res.code, 200);
  assert.equal(res.body.running, true);
  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0].self.port, 5600);
});

test('hub 角色 + 端口被占：400 报原因，并把开关回滚成关闭（不许假装开着）', async () => {
  await resetState();
  const runtime = fakeRuntime({ fail: new Error('peer 端口 5600 已被占用') });
  const { request } = createHarness({ role: 'hub', runtime, query: fakeQuery() });

  const res = await request('POST /api/peer-settings/self', { body: { enabled: true } });
  assert.equal(res.code, 400);
  assert.match(res.body.error, /5600/);

  const state = await readState(PEERS_FILE);
  assert.equal(state.self.enabled, false, '绑不上就必须回滚，否则界面会一直骗用户');
});

// ── 状态判定：以"端口上有没有人在服务"为准 ─────────────────────────────────

test('GET：端口由**别的进程**持有也算运行中（修"开关开着却显示已停止"）', async () => {
  await resetState({ enabled: true });
  const { request } = createHarness({
    role: 'project',
    runtime: fakeRuntime({ running: false }),
    query: fakeQuery({ owner: { pid: process.pid + 1, port: 5599, peerPort: 5600 } })
  });

  const res = await request('GET /api/peer-settings');
  assert.equal(res.code, 200);
  assert.equal(res.body.running, true);
  assert.equal(res.body.peers.length, 0);
});

test('GET：注册表里那条"持有者"就是自己时不算运行（自欺会掩盖绑定失败）', async () => {
  await resetState({ enabled: true });
  const { request } = createHarness({
    role: 'project',
    runtime: fakeRuntime({ running: false }),
    query: fakeQuery({ owner: { pid: process.pid, port: 5599, peerPort: 5600 } })
  });

  const res = await request('GET /api/peer-settings');
  assert.equal(res.body.running, false);
});

// ── reload：hub 干活，project 装死（避免转发链打转）────────────────────────

test('reload：hub 收到就重读配置并重起监听', async () => {
  await resetState({ enabled: true });
  const runtime = fakeRuntime({ running: true, port: 5600 });
  const { request } = createHarness({ role: 'hub', runtime, query: fakeQuery() });

  const res = await request('POST /api/peer-settings/reload');
  assert.equal(res.code, 200);
  assert.equal(res.body.running, true);
  assert.equal(res.body.port, 5600);
  assert.equal(runtime.calls.length, 1);
});

test('reload：project 收到只回报状态，绝不自己 bind', async () => {
  await resetState({ enabled: true });
  const runtime = fakeRuntime({ running: false, port: 0 });
  const { request } = createHarness({ role: 'project', runtime, query: fakeQuery({ owner: null }) });

  const res = await request('POST /api/peer-settings/reload');
  assert.equal(res.code, 200);
  assert.equal(runtime.calls.length, 0, '转发链打转的根源就在这里');
});

// ── 对端系统标识 ────────────────────────────────────────────────────────────
//
// 面板要显示"对端是什么系统"，数据只能来自对端自报的 /api/peer/info。
// 老版本对端没有 os 字段 → 面板显示"系统未知"，不能凭空造一个。

/** 起一个真的 peer 服务，返回 { url, token, close }。 */
async function servePeer(self) {
  const app = createPeerApp({ self, getLocalPort: () => 1234, getVersion: () => '2.19.18' });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test('添加对端 / 列表 probe 都透传对端自报的 os 与 shell', async () => {
  await resetState();
  const remote = await servePeer({ id: 'node-os', name: '远端', avatar: '', token: 's'.repeat(64) });
  try {
    const { request } = createHarness({ role: 'project', runtime: fakeRuntime(), query: fakeQuery() });
    const added = await request('POST /api/peer-settings/peers', {
      body: { url: remote.url, token: 's'.repeat(64) }
    });
    assert.equal(added.code, 200);
    assert.equal(added.body.peer.os.platform, process.platform);
    assert.ok(added.body.peer.os.label, '添加时就要把系统带回来');

    const list = await request('GET /api/peer-settings');
    assert.equal(list.code, 200);
    const [row] = list.body.peers;
    assert.equal(row.os.label, added.body.peer.os.label, '列表与添加必须是同一份口径');
    const expectedShell = process.platform === 'win32' ? 'cmd.exe / PowerShell' : (process.env.SHELL || '/bin/sh');
    assert.equal(row.shell, expectedShell);
  } finally {
    await remote.close();
  }
});

test('老版本对端没有 os 字段：os 为 null（界面显示"系统未知"，不是"没有系统"）', async () => {
  await resetState();
  // 一个只回旧字段的 peer 服务：模拟还没升级的对端
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id: 'node-old', name: '旧版对端', avatar: '', version: '2.0.0', capabilities: ['ask'] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const { request } = createHarness({ role: 'project', runtime: fakeRuntime(), query: fakeQuery() });
    const added = await request('POST /api/peer-settings/peers', {
      body: { url, token: 'o'.repeat(64) }
    });
    assert.equal(added.code, 200);
    assert.equal(added.body.peer.os, null);

    const list = await request('GET /api/peer-settings');
    assert.equal(list.body.peers[0].os, null);
    assert.equal(list.body.peers[0].shell, '');
    assert.equal(list.body.peers[0].online, true, '没有 os 不影响"在线"判断');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

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
import os from 'node:os';
import path from 'node:path';

const sandboxHome = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-peer-settings-'));
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
await fs.mkdir(path.join(sandboxHome, '.zen-gitsync'), { recursive: true });

const { registerPeerSettingsRoutes } = await import('./peerSettings.js');
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

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
// peer 客户端（我去问别人）的回归测试。
//
// 重点是 listPeerStatus —— 它是 g ai 里 ask_peer 工具的"我能问谁"数据源。
// 2026-11-01 的真实故障：它拿 store.listPeers() 的**脱敏**清单（不含令牌）去探活，
// 请求头里 Bearer 是空的 → 对端一律 401 → 每台都显示离线；而设置面板用的是
// 含令牌的完整条目，同一条对端显示在线。用户看到的就是"同一个对端，两个界面两种结论"。
//
// 所以这里起一个**真的** peer 服务（createPeerApp + 随机端口）来测，而不是 mock fetch：
// 只有真走一遍鉴权，才守得住"探活必须带令牌"这条。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// ⚠️ 这里**不能**静态 import ./server.js：它经 store.js → paths.js，而 paths.js 在
// 模块加载时就把 DATA_DIR 定死了。静态 import 会先于下面的 env 赋值执行，
// 沙箱直接失效（文件末尾那条断言当场就会炸）。所以 server 也走动态 import。
const sandboxHome = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-peer-client-'));
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
await fs.mkdir(path.join(sandboxHome, '.zen-gitsync'), { recursive: true });

const { createPeerApp } = await import('./server.js');
const { listPeerStatus, askPeer } = await import('./client.js');
const { writeState } = await import('./store.js');
const { PEERS_FILE } = await import('../paths.js');

assert.ok(
  PEERS_FILE.startsWith(sandboxHome),
  `沙箱未生效：PEERS_FILE=${PEERS_FILE}（不是 ${sandboxHome} 之下），拒绝继续跑`
);

const REMOTE = { id: 'node-remote01', name: '远端服务器', avatar: '', token: 'r'.repeat(64) };

/** 起一个真的 peer 服务（只挂 /api/peer/*），返回地址与关闭函数。 */
async function serveRemote() {
  const app = createPeerApp({
    self: REMOTE,
    getLocalPort: () => 1234,
    getVersion: () => '9.9.9'
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** 写一条对端到沙箱 peers.json。 */
async function registerPeer({ url, token, name = '远端服务器', id = REMOTE.id }) {
  await writeState({
    version: 1,
    self: null,
    peers: [{ id, name, url, token }],
    sessions: {}
  }, PEERS_FILE);
}

// ── 核心回归 ────────────────────────────────────────────────────────────────

test('listPeerStatus：令牌正确时判在线（回归：曾因拿脱敏清单探活而永远离线）', async () => {
  const remote = await serveRemote();
  try {
    await registerPeer({ url: remote.url, token: REMOTE.token });

    const [p] = await listPeerStatus({ probe: true });
    assert.equal(p.online, true, '带令牌探活必须成功');
    assert.equal(p.name, REMOTE.name, '昵称以对端自报为准');
    assert.equal(p.id, REMOTE.id);
    assert.equal(p.label, '9.9.9');
    assert.equal(p.error, undefined);
  } finally {
    await remote.close();
  }
});

test('listPeerStatus：令牌不对时离线，并把「令牌无效」这个原因带出来', async () => {
  const remote = await serveRemote();
  try {
    await registerPeer({ url: remote.url, token: 'x'.repeat(64) });

    const [p] = await listPeerStatus({ probe: true });
    assert.equal(p.online, false);
    assert.match(p.error, /令牌无效/, '不能只报"离线"——真实原因是鉴权失败');
  } finally {
    await remote.close();
  }
});

test('listPeerStatus：没登记任何对端时返回空数组', async () => {
  await writeState({ version: 1, self: null, peers: [], sessions: {} }, PEERS_FILE);
  assert.deepEqual(await listPeerStatus({ probe: true }), []);
});

test('listPeerStatus：连不上时离线，原因里带地址（区别对待"没开机"与"鉴权失败"）', async () => {
  // 先起再关，拿到一个肯定没人听的端口
  const remote = await serveRemote();
  const url = remote.url;
  await remote.close();
  await registerPeer({ url, token: REMOTE.token });

  const [p] = await listPeerStatus({ probe: true });
  assert.equal(p.online, false);
  assert.match(p.error, /连不上|超时/);
});

test('listPeerStatus：probe=false 时不发请求（给"我只想要清单"的调用方）', async () => {
  await registerPeer({ url: 'http://127.0.0.1:1', token: REMOTE.token });
  const [p] = await listPeerStatus({ probe: false });
  assert.equal(p.online, false);
  assert.equal(p.hasToken, true);
});

// ── 令牌不外泄 ──────────────────────────────────────────────────────────────

test('listPeerStatus 的返回值里不许出现令牌明文', async () => {
  const remote = await serveRemote();
  try {
    await registerPeer({ url: remote.url, token: REMOTE.token });
    for (const row of [await listPeerStatus({ probe: true }), await listPeerStatus({ probe: false })]) {
      assert.ok(!JSON.stringify(row).includes(REMOTE.token), '脱敏是对外输出的规矩，内部读数据不等于可以外泄');
    }
  } finally {
    await remote.close();
  }
});

/** 轮询等待条件成立 */
async function waitUntil(check, timeoutMs = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// 回归（2026-11-09 跨机器 ask_peer 一直回 SESSION_BUSY）：
//
// 工具层 150s 放弃等待时，跨机器那一跳必须**真的断开**。以前 callPeer 只认自己的
// 10 分钟超时：本地不等了，请求却还挂着 → 对端继续跑完那一轮 → 它的会话闸一直
// 占着固定的 `in:<from>` key → 后续提问全部 SESSION_BUSY。
test('askPeer：上游 abort 必须掐断这一跳（不能让它挂在对端）', async () => {
  // 一个永不应答的 peer 服务，只记录连接何时被关上
  let disconnected = false;
  const server = http.createServer((req, res) => {
    res.on('close', () => { disconnected = true; });
    // 故意不回任何东西
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  const controller = new AbortController();
  try {
    const pending = askPeer({ id: REMOTE.id, url, token: REMOTE.token }, { id: 'me' }, '在吗', {
      signal: controller.signal
    });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, /已取消/, '上游取消要说清是取消，不能误报成超时');
    await waitUntil(() => disconnected, 3000);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

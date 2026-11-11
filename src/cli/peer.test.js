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
// `g peer status` 的探活回归。
//
// 2026-11-11 实测故障：命令行把一台**在线**的对端报成「[离线] 令牌无效」，
// 而同一条对端在设置面板与直接 curl 时都是通的。根因是 cmdStatus 用
// store.listPeers() 的脱敏视图（不含 token）去 fetchPeerInfo，Bearer 为空。
// 同一类 bug 之前已在 src/peer/client.js 的 listPeerStatus 修过，CLI 这条漏了。
//
// 这里起一个**真的** HTTP 服务校验 Authorization，而不是 mock fetch：只有真走一遍
// 鉴权，才守得住「状态探活必须带对端令牌」这条。正反样本各一条，防止断言假绿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// ⚠️ 不能静态 import ./peer.js：它经 store.js → paths.js，而 paths.js 在模块加载时
// 就把 DATA_DIR 定死了。静态 import 会先于下面的 env 赋值执行，沙箱直接失效。
const sandboxHome = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-peer-cli-'));
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
await fs.mkdir(path.join(sandboxHome, '.zen-gitsync'), { recursive: true });

const { writeState } = await import('../peer/store.js');
const { runPeerCli } = await import('./peer.js');
const { PEERS_FILE } = await import('../paths.js');

assert.ok(
  PEERS_FILE.startsWith(sandboxHome),
  `沙箱未生效：PEERS_FILE=${PEERS_FILE}（不是 ${sandboxHome} 之下），拒绝继续跑`
);

const REMOTE_TOKEN = 'r'.repeat(64);
const SELF_TOKEN = 's'.repeat(64);

/** 起一个只认 REMOTE_TOKEN 的 /api/peer/info，返回地址与关闭函数。 */
async function serveRemote() {
  const server = http.createServer((req, res) => {
    const auth = String(req.headers.authorization || '');
    if (req.url !== '/api/peer/info' || auth !== `Bearer ${REMOTE_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '令牌无效' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, id: 'node-remote01', name: '远端服务器', version: '9.9.9', capabilities: ['ask']
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/** 写一份 peers.json，再抓 `g peer status` 的完整 stdout。 */
async function runStatus(peerToken) {
  const remote = await serveRemote();
  try {
    await writeState({
      version: 1,
      self: {
        id: 'node-self0001', name: '本机', avatar: '', port: 5600,
        host: '0.0.0.0', enabled: true, token: SELF_TOKEN,
      },
      peers: [{
        id: 'node-remote01', name: '远端服务器', url: remote.url, token: peerToken,
      }],
      sessions: {},
    });

    const lines = [];
    const originalLog = console.log;
    console.log = (...args) => { lines.push(stripAnsi(args.map(String).join(' '))); };
    try {
      await runPeerCli(['status']);
    } finally {
      console.log = originalLog;
    }
    return lines.join('\n');
  } finally {
    await remote.close();
  }
}

test('正样本：peers.json 里的令牌能探到在线对端（不误报离线）', async () => {
  const out = await runStatus(REMOTE_TOKEN);
  assert.match(out, /对端（1）/);
  assert.match(out, /\[在线\]/);
  assert.match(out, /远端服务器/);
  assert.match(out, /9\.9\.9/);
  assert.doesNotMatch(out, /\[离线\]/);
  assert.doesNotMatch(out, /令牌无效/);
});

test('反样本：令牌写错时确实报离线（证明上一条不是恒绿）', async () => {
  const out = await runStatus('x'.repeat(64));
  assert.match(out, /\[离线\]/);
  assert.doesNotMatch(out, /\[在线\]/);
});

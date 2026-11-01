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
// 「跨机器」设置面板的后端：本机身份 + 对端清单的读写与探活。
//
// 挂在**主服务**上（127.0.0.1 + Origin 守卫），不是 peer 端口 —— peer 端口是给
// 别的机器用的（要令牌），这组接口是给本机界面用的（不需要令牌，也拿不到对方机器的
// 东西）。两套路由同名会混淆，所以这里统一用 /api/peer-settings 前缀。
//
// 一个必须记住的事实：**peer 端口整机唯一**。一台机器可以同时开好几个 g ui
// （项目窗口随用随开），但 5600 只能有一个进程 listen。所以这里定了一条分工：
//
//   · hub / full 角色 —— 自己监听，持有端口
//   · project 角色   —— 永不监听；改开关时把"重新读配置"转发给 hub
//
// 状态一律以"端口上有没有人在服务"为准（本进程 handle ∪ 注册表里的 peerPort 持有者），
// 不能只看自己进程 —— 否则项目窗口会显示"开关开着却已停止"，而 5600 其实是好的。

import { asyncRoute, HttpError } from '../utils/asyncRoute.js';
import logger from '../utils/logger.js';
import {
  ensureSelf,
  readState,
  updateSelf,
  upsertPeer,
  removePeer,
  rotateSelfToken,
  PEER_DEFAULT_PORT
} from '../../../peer/store.js';
import { fetchPeerInfo } from '../../../peer/client.js';
import { applyPeerRuntime, isPeerRunning, getPeerPort } from '../utils/peerRuntime.js';
import { findPeerOwner, findHubInstance } from '../utils/instanceQuery.js';

const PROBE_TIMEOUT_MS = 2500;

/** 对端在线探测：失败不抛，只标记 offline（面板要能一眼看出"连不上"）。 */
async function probe(peer) {
  try {
    const info = await fetchPeerInfo(peer, { timeoutMs: PROBE_TIMEOUT_MS });
    return { online: true, remoteName: info.name || '', version: info.version || '', remoteId: info.id || '' };
  } catch (err) {
    return { online: false, error: String(err?.message || err) };
  }
}

export function registerPeerSettingsRoutes({
  app,
  role = 'project',
  // 注入口（与 explorerContextMenu 的 execFileFn 同一套做法）：
  //   runtime —— 单测替换掉，避免真的 bind 一个 0.0.0.0 端口；
  //   query   —— 同上，避免读这台机器真实的实例注册表；
  //   fetchFn —— 转发给 hub 的那一次请求，单测直接给假响应。
  runtime = { applyPeerRuntime, isPeerRunning, getPeerPort },
  query = { findPeerOwner, findHubInstance },
  fetchFn = (...args) => fetch(...args)
} = {}) {
  /** 本角色是否有资格自己监听 peer 端口。 */
  const canServe = role !== 'project';

  /** 端口上到底有没有人在服务（含"另一个进程在服务"这种情况）。 */
  async function isServing(port) {
    if (runtime.isPeerRunning()) return true;
    const owner = await query.findPeerOwner(port);
    return !!owner && owner.pid !== process.pid;
  }

  /**
   * 让配置生效。
   * hub/full：就地重起监听；project：转发给 hub（自己不抢端口）。
   */
  async function applyConfig(self) {
    if (canServe) {
      await runtime.applyPeerRuntime(self);
      return { running: runtime.isPeerRunning(), port: runtime.getPeerPort(), warning: '' };
    }
    const hub = await query.findHubInstance();
    if (!hub) {
      return { running: false, port: 0, warning: '当前没有运行中的 hub —— 跨机器服务由 hub 提供，先把 hub 起起来' };
    }
    try {
      const res = await fetchFn(`http://127.0.0.1:${hub.port}/api/peer-settings/reload`, { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        // 状态码必须露出来：hub 是旧版本时这条路由根本不存在，用户只看到
        // 「not found」会以为是网络问题；写成 HTTP 404 才看得出是版本不一致。
        throw new Error(`HTTP ${res.status}${data?.error ? `：${data.error}` : ''}`);
      }
      return { running: data.running === true, port: data.port || 0, warning: '' };
    } catch (err) {
      throw new HttpError(400, `通知 hub 失败：${err?.message || err}`);
    }
  }

  /**
   * GET /api/peer-settings
   * 本机身份 + 对端清单（附带一次并发探活）。
   */
  app.get('/api/peer-settings', asyncRoute(async (req, res) => {
    const state = await ensureSelf();
    const peers = state.peers || [];
    const probed = await Promise.all(peers.map(async (p) => ({ ...p, ...(await probe(p)) })));

    // 昵称**以对方自报为准**（对方在它自己的设置里改了就跟着变）。
    // 变了顺手落盘：否则对方改名后、下次它离线时又显示回旧名字。
    const rows = await Promise.all(probed.map(async (p) => {
      const remoteName = p.online ? String(p.remoteName || '').trim() : '';
      if (remoteName && remoteName !== p.name) {
        await upsertPeer({ id: p.id, name: remoteName, url: p.url, token: p.token }).catch(() => {});
      }
      return {
        id: p.id,
        name: remoteName || p.name,
        url: p.url,
        online: p.online,
        version: p.version || '',
        error: p.error || ''
      };
    }));

    res.json({
      success: true,
      running: await isServing(state.self.port),
      self: state.self,
      peers: rows
    });
  }));

  /** POST /api/peer-settings/self —— 改昵称 / 头像 / 端口 / 开关。 */
  app.post('/api/peer-settings/self', asyncRoute(async (req, res) => {
    const body = req.body || {};
    if (body.port !== undefined) {
      const port = Number(body.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new HttpError(400, '端口必须是 1-65535 的整数');
      }
    }
    const state = await updateSelf({
      name: typeof body.name === 'string' ? body.name : undefined,
      avatar: typeof body.avatar === 'string' ? body.avatar.slice(0, 200) : undefined,
      port: body.port !== undefined ? Number(body.port) : undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined
    });

    let applied;
    try {
      applied = await applyConfig(state.self);
    } catch (err) {
      // 起不来就别假装开着：回滚开关，把真实原因交给用户
      if (state.self.enabled) await updateSelf({ enabled: false });
      throw new HttpError(400, `peer 端口 ${state.self.port} 起不来：${err?.message || err}`);
    }

    res.json({ success: true, running: applied.running, warning: applied.warning, self: state.self });
  }));

  /** POST /api/peer-settings/token —— 重新生成令牌（旧的立即失效）。 */
  app.post('/api/peer-settings/token', asyncRoute(async (req, res) => {
    const state = await rotateSelfToken();
    logger.info('[peer-settings] 令牌已重置');
    // 必须重启监听：运行中的实例持有的是**旧令牌**的闭包，不换就不生效
    let applied = { running: false, warning: '' };
    try {
      applied = await applyConfig(state.self);
    } catch (err) {
      logger.warn(`[peer-settings] 令牌已换但监听未重启: ${err?.message || err}`);
    }
    res.json({ success: true, running: applied.running, warning: applied.warning, self: state.self });
  }));

  /**
   * POST /api/peer-settings/reload —— 让持有 peer 端口的进程重新读一遍 peers.json。
   *
   * 存在的理由：项目窗口改开关时不自己绑端口，而是打这个接口让 hub 去做。
   * 只有 hub/full 会真的处理，别的角色收到就忽略（避免"转发链"打转）。
   */
  app.post('/api/peer-settings/reload', asyncRoute(async (req, res) => {
    if (!canServe) {
      res.json({ success: true, running: await isServing(runtime.getPeerPort() || PEER_DEFAULT_PORT), port: runtime.getPeerPort() });
      return;
    }
    const state = await ensureSelf();
    await runtime.applyPeerRuntime(state.self);
    res.json({ success: true, running: runtime.isPeerRunning(), port: runtime.getPeerPort() });
  }));

  /**
   * POST /api/peer-settings/peers —— 添加（或覆盖）一台对端。
   * 先真连一次：连不上/令牌错当场报错，别让用户以为加好了。
   */
  app.post('/api/peer-settings/peers', asyncRoute(async (req, res) => {
    const rawUrl = String(req.body?.url || '').trim();
    const token = String(req.body?.token || '').trim();
    if (!rawUrl) throw new HttpError(400, '请填对端地址');
    if (!token) throw new HttpError(400, '请填对端令牌');

    const url = (rawUrl.startsWith('http') ? rawUrl : `http://${rawUrl}`).replace(/\/+$/, '');
    let info;
    try {
      info = await fetchPeerInfo({ url, token }, { timeoutMs: 5000 });
    } catch (err) {
      throw new HttpError(400, `连不上对端：${err?.message || err}`);
    }
    // 昵称由**对方**决定（它在自己的设置里写什么就叫什么），本机只在对方没设时退回地址。
    // 这里允许显式传 name，是给将来"本地备注"留的口子；界面不再问用户填。
    const name = String(req.body?.name || '').trim() || String(info.name || '').trim() || url;
    const state = await upsertPeer({ id: info.id || '', name, url, token });
    res.json({ success: true, peer: { id: info.id || '', name, url, online: true, version: info.version || '' }, count: state.peers.length });
  }));

  /** DELETE /api/peer-settings/peers/:ref —— 移除（ref 可以是 id 或昵称）。 */
  app.delete('/api/peer-settings/peers/:ref', asyncRoute(async (req, res) => {
    const { removed, peer } = await removePeer(decodeURIComponent(req.params.ref));
    if (!removed) throw new HttpError(404, '没有这台对端');
    res.json({ success: true, peer: { id: peer.id, name: peer.name } });
  }));

  /** POST /api/peer-settings/peers/:ref/test —— 单独重测一台。 */
  app.post('/api/peer-settings/peers/:ref/test', asyncRoute(async (req, res) => {
    const ref = decodeURIComponent(req.params.ref).toLowerCase();
    const state = await readState();
    const peer = (state.peers || []).find((p) => p.id.toLowerCase() === ref || p.name.toLowerCase() === ref || p.url.toLowerCase() === ref);
    if (!peer) throw new HttpError(404, '没有这台对端');
    const result = await probe(peer);
    res.json({ success: true, ...result });
  }));

  /** GET /api/peer-settings/defaults —— 面板第一次打开时给默认值（端口号）。 */
  app.get('/api/peer-settings/defaults', (req, res) => {
    res.json({ success: true, port: PEER_DEFAULT_PORT });
  });
}

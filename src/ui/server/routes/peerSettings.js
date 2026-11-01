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
// 唯一会返回令牌明文的地方就是 GET /api/peer-settings：配对时用户必须能复制它到
// 另一台机器。它只在 127.0.0.1 上、只给本机界面看。

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
import { applyPeerRuntime, isPeerRunning } from '../utils/peerRuntime.js';

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

export function registerPeerSettingsRoutes({ app }) {
  /**
   * GET /api/peer-settings
   * 本机身份 + 对端清单（附带一次并发探活）。
   */
  app.get('/api/peer-settings', asyncRoute(async (req, res) => {
    const state = await ensureSelf();
    const peers = state.peers || [];
    const probed = await Promise.all(peers.map(async (p) => ({ ...p, ...(await probe(p)) })));
    res.json({
      success: true,
      running: isPeerRunning(),
      self: state.self,
      peers: probed.map((p) => ({
        id: p.id,
        name: p.name,
        url: p.url,
        online: p.online,
        version: p.version || '',
        error: p.error || ''
      }))
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
    // 立刻生效：开/关/换端口都当场应用，设置面板里的开关不该要求重启进程。
    try {
      await applyPeerRuntime(state.self);
    } catch (err) {
      // 起不来就别假装开着：回滚开关，把真实原因交给用户
      if (state.self.enabled) await updateSelf({ enabled: false });
      throw new HttpError(400, `peer 端口 ${state.self.port} 起不来：${err?.message || err}`);
    }
    res.json({ success: true, running: isPeerRunning(), self: state.self });
  }));

  /** POST /api/peer-settings/token —— 重新生成令牌（旧的立即失效）。 */
  app.post('/api/peer-settings/token', asyncRoute(async (req, res) => {
    const state = await rotateSelfToken();
    logger.info('[peer-settings] 令牌已重置');
    // 必须重启监听：运行中的实例持有的是**旧令牌**的闭包，不换就不生效
    try {
      await applyPeerRuntime(state.self);
    } catch (err) {
      logger.warn(`[peer-settings] 令牌已换但监听未重启: ${err?.message || err}`);
    }
    res.json({ success: true, running: isPeerRunning(), self: state.self });
  }));

  /**
   * POST /api/peer-settings/peers —— 添加（或覆盖）一台对端。
   * 先真连一次：连不上/令牌错当场报错，别让用户以为加好了。
   */
  app.post('/api/peer-settings/peers', asyncRoute(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const rawUrl = String(req.body?.url || '').trim();
    const token = String(req.body?.token || '').trim();
    if (!name) throw new HttpError(400, '请填对端昵称');
    if (!rawUrl) throw new HttpError(400, '请填对端地址');
    if (!token) throw new HttpError(400, '请填对端令牌');

    const url = (rawUrl.startsWith('http') ? rawUrl : `http://${rawUrl}`).replace(/\/+$/, '');
    let info;
    try {
      info = await fetchPeerInfo({ url, token }, { timeoutMs: 5000 });
    } catch (err) {
      throw new HttpError(400, `连不上对端：${err?.message || err}`);
    }
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

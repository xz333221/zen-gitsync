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
// peer 客户端：本机 g ai 去问别的机器（跨机器通信的"出口"）。
//
// 与 server.js 是镜像的两半：
//   server.js —— 别人来问我（入口，固定端口，令牌校验）
//   client.js —— 我去问别人（出口，读 peers.json 里的地址与令牌）
//
// 这一层不做自动发现：局域网里没有可信的发现协议（mDNS 在 Windows 上默认不开，
// 广播包也穿不过 Wi-Fi 隔离），地址必须由用户显式登记 —— 也就意味着**不存在**
// "随便一台机器就能连上来问"的情况，这正是我们要的。

import {
  listPeers,
  readState,
  findPeer,
  getSessionId,
  setSessionId,
  ensureSelf
} from './store.js';

const INFO_TIMEOUT_MS = 4000;
const ASK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 打一个 peer 接口，统一超时与错误文案。
 *
 * `signal`（可选）是**上游的取消通道**：本机这一轮被停止 / 工具层放弃等待时，
 * 必须把这一跳一起掐断。只做"本地不等了"是不够的 —— 对端会继续跑完那一轮，
 * 它的会话闸一直占着（peer 进来固定用 `in:<from>` 这个 key），后续提问全撞
 * SESSION_BUSY。断开连接后由对端自行中止，见 server.js 的 res close 监听。
 *
 * @param {string} url
 * @param {{method?:string, token:string, body?:object, timeoutMs?:number, signal?:AbortSignal}} opts
 */
async function callPeer(url, { method = 'GET', token, body, timeoutMs = INFO_TIMEOUT_MS, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const onUpstreamAbort = () => { try { controller.abort(); } catch {} };
  if (signal?.aborted) onUpstreamAbort();
  else signal?.addEventListener?.('abort', onUpstreamAbort, { once: true });
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token || ''}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }

    if (res.status === 401) throw new Error('令牌无效（对端 peers.json 里的 token 与本机不匹配）');
    if (!res.ok || !data || data.ok === false) {
      throw new Error(data?.error || `对端返回 ${res.status}`);
    }
    return data;
  } catch (err) {
    if (err?.name === 'AbortError') {
      // 两种 abort 要分开：上游取消不是"超时"，否则日志/回喂都会被误导成网络问题
      if (signal?.aborted) throw new Error('提问已取消（本机这一轮已结束或工具层放弃等待）');
      throw new Error(`连 ${url} 超时（${Math.round(timeoutMs / 1000)}s）`);
    }
    if (err instanceof TypeError) {
      throw new Error(`连不上 ${url}（对方 g ui 没开 peer 端口、防火墙拦了，或地址写错）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onUpstreamAbort);
  }
}

/**
 * 取对端的身份信息（同时兼作"在不在线"的探活）。
 * @param {{url:string, token:string}} peer
 * @param {{timeoutMs?:number}} [opts]
 */
export async function fetchPeerInfo(peer, { timeoutMs = INFO_TIMEOUT_MS } = {}) {
  return callPeer(`${peer.url}/api/peer/info`, { token: peer.token, timeoutMs });
}

/**
 * 向对端提问，拿回它的回答。
 *
 * @param {object} peer peers.json 里的一条
 * @param {object} self 本机身份（把 id 带过去，对端据此保持会话连续性）
 * @param {string} question
 * @param {{timeoutMs?:number, signal?:AbortSignal}} [opts]
 *        signal：上游取消（本轮被停止 / 工具层放弃等待），会掐断这一跳并让对端中止
 * @returns {Promise<{answer:string, sessionId:string, ms:number}>}
 */
export async function askPeer(peer, self, question, { timeoutMs = ASK_TIMEOUT_MS, signal } = {}) {
  const data = await callPeer(`${peer.url}/api/peer/ask`, {
    method: 'POST',
    token: peer.token,
    body: { question, from: self?.id || '' },
    timeoutMs,
    signal
  });
  if (peer.id && data.sessionId) {
    await setSessionId(`out:${peer.id}`, data.sessionId).catch(() => {});
  }
  return data;
}

/**
 * 工具层用的"我都有哪些对端"—— 附带一次快速探活。
 *
 * 为什么把探活放在这里而不是常驻心跳：对端可能十天半个月不开机，常驻心跳只会
 * 白烧请求；工具调用是低频的，届时有几台就探几台（并发，2s 级超时）。
 *
 * ⚠️ **必须用 readState() 的完整条目，不能用 listPeers()**：后者是**脱敏视图**
 * （只给 id/name/url/hasToken，按设计不含令牌明文，见 store.listPeers 的测试）。
 * 拿它去探活，请求头里的 `Authorization: Bearer ` 是空的 → 对端一律回 401 →
 * 每一台都被判成离线。2026-11-01 用户就是这么撞上的：设置面板点「测试」显示在线，
 * 同一条对端在 g ai 里问「你和谁连着」却报离线（AI 走的正是这个函数）。
 * 脱敏是**对外输出**的规矩，不是内部读数据的方式 —— 这里返回值里仍然只给
 * online / label，令牌一个字节都不出去。
 *
 * 顺带把失败原因放进 `error`：只报"离线"会让用户去查网络，而真实原因常常是
 * 令牌不匹配（对端重生成过令牌）或地址写错，两者该被区分开。
 *
 * @param {{probe?:boolean}} [opts]
 * @returns {Promise<Array<{id:string,name:string,url:string,online:boolean,label?:string,error?:string}>>}
 */
export async function listPeerStatus({ probe = true } = {}) {
  const { peers } = await readState();
  if (!peers.length) return [];
  return Promise.all(peers.map(async (p) => {
    if (!probe) {
      return { id: p.id, name: p.name, url: p.url, hasToken: !!p.token, online: false };
    }
    try {
      const info = await fetchPeerInfo(p, { timeoutMs: 2000 });
      return { id: info.id || p.id, name: info.name || p.name, url: p.url, online: true, label: info.version || '' };
    } catch (err) {
      return { id: p.id, name: p.name, url: p.url, online: false, error: String(err?.message || err) };
    }
  }));
}

/**
 * 按 id 或昵称提问（工具层入口）。
 *
 * @param {string} ref 对端 id 或昵称；空 = 只有一台对端时自动选它
 * @param {string} question
 * @param {{timeoutMs?:number, signal?:AbortSignal}} [opts] 透传给 askPeer（见上面的取消说明）
 */
export async function askPeerByRef(ref, question, opts = {}) {
  const self = (await ensureSelf()).self;
  const key = String(ref || '').trim();

  let peer = key ? await findPeer(key) : null;
  if (!peer && !key) {
    const all = await listPeers();
    if (all.length === 1) {
      peer = await findPeer(all[0].url);
    } else if (all.length > 1) {
      throw new Error(`有多台对端，请指定 peer：${all.map((p) => p.name).join(' / ')}`);
    }
  }
  if (!peer) {
    const all = await listPeers();
    throw new Error(all.length
      ? `没有名为「${key}」的对端。现有：${all.map((p) => p.name).join(' / ')}`
      : '还没有登记任何对端。在**对端机器**上开 `g peer on`，拿到它的地址和令牌后，在这台机器上执行 `g peer add <昵称> <地址> --token <令牌>`。');
  }
  if (!peer.url || !peer.token) throw new Error(`对端「${peer.name}」缺少地址或令牌，请重新 \`g peer add\``);

  const result = await askPeer(peer, self, question, opts);
  return { peer, ...result };
}

/** 取与某个对端的上一次会话 id（调试/CLI 用）。 */
export async function lastSessionIdOf(peerId) {
  return getSessionId(`out:${peerId}`);
}

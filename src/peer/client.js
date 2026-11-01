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
  findPeer,
  getSessionId,
  setSessionId,
  ensureSelf
} from './store.js';

const INFO_TIMEOUT_MS = 4000;
const ASK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 打一个 peer 接口，统一超时与错误文案。
 * @param {string} url
 * @param {{method?:string, token:string, body?:object, timeoutMs?:number}} opts
 */
async function callPeer(url, { method = 'GET', token, body, timeoutMs = INFO_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
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
      throw new Error(`连 ${url} 超时（${Math.round(timeoutMs / 1000)}s）`);
    }
    if (err instanceof TypeError) {
      throw new Error(`连不上 ${url}（对方 g ui 没开 peer 端口、防火墙拦了，或地址写错）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
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
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{answer:string, sessionId:string, ms:number}>}
 */
export async function askPeer(peer, self, question, { timeoutMs = ASK_TIMEOUT_MS } = {}) {
  const data = await callPeer(`${peer.url}/api/peer/ask`, {
    method: 'POST',
    token: peer.token,
    body: { question, from: self?.id || '' },
    timeoutMs
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
 * @param {{probe?:boolean}} [opts]
 * @returns {Promise<Array<{id:string,name:string,url:string,online:boolean,label?:string}>>}
 */
export async function listPeerStatus({ probe = true } = {}) {
  const peers = await listPeers();
  if (!peers.length) return [];
  return Promise.all(peers.map(async (p) => {
    if (!probe) return { ...p, online: false };
    try {
      const info = await fetchPeerInfo(p, { timeoutMs: 2000 });
      return { id: info.id || p.id, name: info.name || p.name, url: p.url, online: true, label: info.version || '' };
    } catch {
      return { ...p, online: false };
    }
  }));
}

/**
 * 按 id 或昵称提问（工具层入口）。
 *
 * @param {string} ref 对端 id 或昵称；空 = 只有一台对端时自动选它
 * @param {string} question
 */
export async function askPeerByRef(ref, question) {
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

  const result = await askPeer(peer, self, question);
  return { peer, ...result };
}

/** 取与某个对端的上一次会话 id（调试/CLI 用）。 */
export async function lastSessionIdOf(peerId) {
  return getSessionId(`out:${peerId}`);
}

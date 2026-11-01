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
// 跨机器 peer 的本地状态：<DATA_DIR>/peers.json。
//
// 形状（version 1）：
//   self     这台机器的身份 —— id / 昵称 / 头像 / 固定端口 / 是否开启 / 访问令牌
//   peers    对端清单 —— 每条含 id / 昵称 / url / token（对方的令牌）
//   sessions 每个对端用于续聊的会话 id（对端 agent 的会话，不是本机的）
//
// 为什么单独一个文件而不是塞进 config.json：
//   · config.json 是**按项目分片**的（configSplit），而 peer 身份只跟机器有关；
//   · config.json 会被备份/同步，令牌不该跟着项目配置流动；
//   · 这里没有 read-modify-write 的并发焦虑 —— 改写频率是"人手动加一台机器"级别，
//     真正的并发热点（任务、job）不在这里。
//
// 令牌纪律：只在**内存里**参与比较，日志/CLI 输出一律走 maskToken()。这个文件
// 不进 git，路径也不在任何项目的同步范围里。

import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { PEERS_FILE } from '../paths.js';
import { atomicWriteText } from '../fsAtomic.js';

// 5600：5599 留给 hub 的固定端口（见 ui/server/utils/ensureHub.js 的 HUB_DEFAULT_PORT）。
// 两个都是长驻服务，撞在一起会让「开 peer」和「开 hub」变成互斥。
export const PEER_DEFAULT_PORT = 5600;

/** peers.json 的默认形状（读不到 / 坏文件时的兜底）。 */
function emptyState() {
  return { version: 1, self: null, peers: [], sessions: {} };
}

/** 生成 `node-xxxxxxxx` 形态的节点 id（8 位十六进制，够区分局域网里的几台机器）。 */
export function makeNodeId() {
  return `node-${randomBytes(4).toString('hex')}`;
}

/** 生成 32 字节令牌的十六进制串。 */
export function makeToken() {
  return randomBytes(32).toString('hex');
}

/**
 * 令牌的展示形态：只留末 4 位。
 * @param {string} token
 */
export function maskToken(token) {
  const t = String(token || '');
  if (!t) return '(未设置)';
  if (t.length <= 8) return '****';
  return `${'*'.repeat(8)}${t.slice(-4)}`;
}

/**
 * 常量时间比较两个令牌。
 *
 * 为什么不用 `===`：字符串比较会在第一个不同的字节提前返回，理论上可以按响应
 * 时间逐字节猜出令牌。这里先各做一次 sha256 再比 —— 长度不同也不会因为
 * timingSafeEqual 抛错（它要求等长），且比较的是定长摘要。
 *
 * @param {string} given 请求带来的令牌
 * @param {string} expected 本机令牌
 */
export function tokenEquals(given, expected) {
  const a = createHash('sha256').update(String(given || '')).digest();
  const b = createHash('sha256').update(String(expected || '')).digest();
  return timingSafeEqual(a, b);
}

/** 把磁盘上/调用方给的对象归一成固定形状，脏字段一律丢掉。 */
function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;

  const self = raw.self && typeof raw.self === 'object' ? raw.self : null;
  if (self && typeof self.id === 'string' && self.id) {
    base.self = {
      id: self.id,
      name: typeof self.name === 'string' && self.name.trim() ? self.name.trim() : '未命名节点',
      avatar: typeof self.avatar === 'string' ? self.avatar : '',
      port: Number.isInteger(self.port) && self.port > 0 && self.port < 65536 ? self.port : PEER_DEFAULT_PORT,
      host: typeof self.host === 'string' && self.host ? self.host : '0.0.0.0',
      enabled: self.enabled === true,
      token: typeof self.token === 'string' ? self.token : ''
    };
  }

  if (Array.isArray(raw.peers)) {
    for (const p of raw.peers) {
      if (!p || typeof p !== 'object') continue;
      const url = typeof p.url === 'string' ? p.url.trim().replace(/\/+$/, '') : '';
      if (!url) continue;
      const id = typeof p.id === 'string' && p.id ? p.id : '';
      base.peers.push({
        id,
        name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : (id || url),
        url,
        token: typeof p.token === 'string' ? p.token : ''
      });
    }
  }

  if (raw.sessions && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions)) {
    for (const [k, v] of Object.entries(raw.sessions)) {
      if (typeof v === 'string' && v) base.sessions[k] = v;
    }
  }
  return base;
}

/**
 * 读 peers.json。文件不存在或损坏一律返回空状态 —— **不抛异常**：
 * 这个文件坏了最多是"没有对端"，不该让 g ui 起不来。
 *
 * @param {string} [filePath]
 */
export async function readState(filePath = PEERS_FILE) {
  try {
    const text = await fs.readFile(filePath, 'utf-8');
    return normalizeState(JSON.parse(text));
  } catch {
    return emptyState();
  }
}

/**
 * 原子写回。
 * @param {object} state
 * @param {string} [filePath]
 */
export async function writeState(state, filePath = PEERS_FILE) {
  const normalized = normalizeState(state);
  await atomicWriteText(filePath, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

/**
 * 保证本机身份存在：第一次调用时生成 id 与令牌并落盘。
 *
 * 幂等，且**不覆盖**已有字段 —— 昵称、端口这些是用户手动设的。
 *
 * @param {string} [filePath]
 */
export async function ensureSelf(filePath = PEERS_FILE) {
  const state = await readState(filePath);
  if (state.self && state.self.id && state.self.token) return state;

  state.self = {
    id: state.self?.id || makeNodeId(),
    name: state.self?.name || '这台电脑',
    avatar: state.self?.avatar || '',
    port: state.self?.port || PEER_DEFAULT_PORT,
    host: state.self?.host || '0.0.0.0',
    enabled: state.self?.enabled === true,
    token: state.self?.token || makeToken()
  };
  return writeState(state, filePath);
}

/**
 * 改本机身份（昵称 / 头像 / 端口 / 开关）。只接受白名单字段。
 *
 * @param {object} patch
 * @param {string} [filePath]
 */
export async function updateSelf(patch, filePath = PEERS_FILE) {
  const state = await ensureSelf(filePath);
  const next = { ...state, self: { ...state.self } };
  if (typeof patch.name === 'string' && patch.name.trim()) next.self.name = patch.name.trim();
  if (typeof patch.avatar === 'string') next.self.avatar = patch.avatar;
  if (Number.isInteger(patch.port) && patch.port > 0 && patch.port < 65536) next.self.port = patch.port;
  if (typeof patch.host === 'string' && patch.host) next.self.host = patch.host;
  if (typeof patch.enabled === 'boolean') next.self.enabled = patch.enabled;
  return writeState(next, filePath);
}

/**
 * 按 id / 昵称 / 地址找对端（忽略大小写；昵称重复时以先加入的为准）。
 * 地址也认，是为了让"只有一台对端"这类场景能直接用 listPeers() 的结果回查。
 *
 * @param {string} ref
 * @param {string} [filePath]
 */
export async function findPeer(ref, filePath = PEERS_FILE) {
  const key = String(ref || '').trim().toLowerCase();
  if (!key) return null;
  const state = await readState(filePath);
  return state.peers.find((p) => p.id.toLowerCase() === key
    || p.name.toLowerCase() === key
    || p.url.toLowerCase() === key
    || p.url.toLowerCase() === key.replace(/\/+$/, '')) || null;
}

/**
 * 新增 / 覆盖一条对端。
 *
 * 以 id 为键覆盖；没有 id 时用 url 兜底（重复添加同一地址 = 改令牌，不产生两条）。
 *
 * @param {{id?:string,name?:string,url:string,token?:string}} peer
 * @param {string} [filePath]
 */
export async function upsertPeer(peer, filePath = PEERS_FILE) {
  const url = String(peer?.url || '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('对端地址不能为空');

  const state = await readState(filePath);
  const id = String(peer?.id || '').trim();
  const idx = state.peers.findIndex((p) => (id && p.id === id) || p.url === url);
  const entry = {
    id: id || (idx >= 0 ? state.peers[idx].id : ''),
    name: String(peer?.name || '').trim() || (idx >= 0 ? state.peers[idx].name : url),
    url,
    token: String(peer?.token || '').trim()
  };
  if (idx >= 0) state.peers[idx] = { ...state.peers[idx], ...entry, id: entry.id || state.peers[idx].id };
  else state.peers.push(entry);
  return writeState(state, filePath);
}

/**
 * 删一条对端（连带删掉与它绑定的会话 id）。
 * @param {string} ref id 或昵称
 * @param {string} [filePath]
 */
export async function removePeer(ref, filePath = PEERS_FILE) {
  const target = await findPeer(ref, filePath);
  if (!target) return { removed: false, peer: null };
  const state = await readState(filePath);
  state.peers = state.peers.filter((p) => p !== target && !(target.id && p.id === target.id) &&
    !(!target.id && p.url === target.url));
  if (target.id) delete state.sessions[target.id];
  await writeState(state, filePath);
  return { removed: true, peer: target };
}

/**
 * 取某个对端的续聊会话 id（对端机器上那个会话）。
 * @param {string} peerId
 * @param {string} [filePath]
 */
export async function getSessionId(peerId, filePath = PEERS_FILE) {
  if (!peerId) return '';
  const state = await readState(filePath);
  return state.sessions[peerId] || '';
}

/**
 * 记住某个对端的续聊会话 id。
 * @param {string} peerId
 * @param {string} sessionId
 * @param {string} [filePath]
 */
export async function setSessionId(peerId, sessionId, filePath = PEERS_FILE) {
  if (!peerId || !sessionId) return;
  const state = await ensureSelf(filePath);
  state.sessions[peerId] = sessionId;
  await writeState(state, filePath);
}

/**
 * 换一把新令牌（旧令牌立即失效 —— 已经配对过的机器要重新 `g peer add`）。
 * @param {string} [filePath]
 */
export async function rotateSelfToken(filePath = PEERS_FILE) {
  const state = await ensureSelf(filePath);
  state.self.token = makeToken();
  return writeState(state, filePath);
}

/** 对端清单（供 CLI / 工具描述用，不含令牌明文）。 */
export async function listPeers(filePath = PEERS_FILE) {
  const state = await readState(filePath);
  return state.peers.map((p) => ({
    id: p.id,
    name: p.name,
    url: p.url,
    hasToken: !!p.token
  }));
}

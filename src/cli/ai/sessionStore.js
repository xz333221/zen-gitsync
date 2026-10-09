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
// CLI 侧智能体会话持久化。
//
// 与 Web 端 (src/ui/server/routes/workbench/agentSessionStore.js) 共享同一数据目录
// (~/.zen-gitsync/agent-sessions/) 和同一 JSON 格式,这样:
//   - CLI 对话在 Web UI 的智能体 tab 里可见(带 CLI 标记)
//   - Web UI 可以读取/继续 CLI 创建的会话
//
// 本模块刻意不依赖服务器代码,仅用 node 内置 fs/path + 共享的路径常量,保持 CLI 自包含。

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { AGENT_SESSIONS_DIR as SESSIONS_DIR } from '../../paths.js';
const MAX_SESSIONS = 200;
const KEEP_SESSIONS = 100;

/**
 * 生成会话 ID: ag-{时间戳base36}-{随机base36}
 */
export function genSessionId() {
  return `ag-${Date.now().toString(36).slice(-8)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 从第一条 user 消息自动生成标题(取第一行,截断 40 字符)
 */
export function autoTitle(messages) {
  for (const m of messages) {
    if (m.role === 'user') {
      let text = '';
      if (typeof m.content === 'string') {
        text = m.content;
      } else if (Array.isArray(m.content)) {
        text = m.content.filter(p => p?.type === 'text').map(p => p.text).join(' ');
      }
      text = text.trim();
      if (text) {
        const firstLine = text.split('\n')[0].trim();
        return firstLine.length > 40 ? firstLine.slice(0, 40) + '…' : firstLine;
      }
    }
  }
  return '(新会话)';
}

// ── 每轮用时（session.turnTimings）────────────────────────────────────────
//
// 存的是一条条 `{ turnIndex, durationMs, finishedAt }`，给对话界面在气泡下方显示
// 「这一轮跑了多久」。CLI 与 Web 两个写入方共用这一份形状，读的那一侧是
// src/ui/client/src/composables/useAgentChat.ts 的 convertSessionToMessages。
//
// 为什么挂在会话顶层而不是塞进某条消息里：
//   messages 是 **OpenAI 格式**，出站请求由 cli/ai/context.js 的
//   buildRequestMessages 逐条 `{ ...m }` 复制 —— 往消息上挂自定义字段会连同它一起
//   发给 provider（部分厂商对未知字段直接 400 拒掉整轮）。挂顶层就永远出不了站。
//
// turnIndex 对齐的是「本轮的 user 消息是会话里的第几条 user 消息」（0 基），
// 不是消息数组下标：数组还在往后长，下标会漂；user 序号只增不改。
// 同一 turnIndex **后写的覆盖先写的** —— 一轮失败时服务端会把刚塞进去的 user 消息
// 弹掉（见 agentChat.js 的 LLM 请求失败分支），那条废记录的序号会被下一轮
// 复用，覆盖后读出来指向的永远是真正跑完的那一轮。
export const MAX_TURN_TIMINGS = 500;

/**
 * 记一轮用时。
 *
 * 调用方必须在**本轮 user 消息入栈之前**取好 turnIndex —— 失败轮次会把这条消息弹掉，
 * 事后按消息数数出来的序号会指向上一条（覆盖掉别人跑完的那一轮）。
 */
export function recordTurnTiming(session, { turnIndex, durationMs, finishedAt }) {
  const turn = Math.floor(Number(turnIndex));
  const ms = Math.round(Number(durationMs));
  if (!session || !Number.isFinite(turn) || turn < 0 || !Number.isFinite(ms) || ms < 0) return;
  if (!Array.isArray(session.turnTimings)) session.turnTimings = [];
  const entry = {
    turnIndex: turn,
    durationMs: ms,
    finishedAt: typeof finishedAt === 'string' && finishedAt ? finishedAt : new Date().toISOString(),
  };
  const at = session.turnTimings.findIndex(t => t?.turnIndex === turn);
  if (at >= 0) session.turnTimings[at] = entry;
  else session.turnTimings.push(entry);
  // 长会话（几百轮）不该让这个数组无限长:它只是给界面显示用时,留最近这些轮足够
  if (session.turnTimings.length > MAX_TURN_TIMINGS) {
    session.turnTimings.splice(0, session.turnTimings.length - MAX_TURN_TIMINGS);
  }
}

/**
 * 写入会话(原子操作: tmp + rename)
 */
export async function writeSession(sessionId, data) {
  await fsp.mkdir(SESSIONS_DIR, { recursive: true });
  const file = path.join(SESSIONS_DIR, `${sessionId}.json`);
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fsp.rename(tmp, file);
}

/**
 * 读取会话
 */
export async function readSession(sessionId) {
  const file = path.join(SESSIONS_DIR, `${sessionId}.json`);
  return JSON.parse(await fsp.readFile(file, 'utf-8'));
}

/**
 * 列出可恢复的会话,按最近更新时间倒序排列。
 * 单个损坏的 JSON 不应阻断整个列表,因此会静默跳过。
 */
export async function listSessions(directory = SESSIONS_DIR) {
  const files = await fsp.readdir(directory).catch(() => []);
  const sessions = await Promise.all(
    files.filter(file => file.endsWith('.json')).map(async (file) => {
      try {
        const raw = await fsp.readFile(path.join(directory, file), 'utf-8');
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object' || !Array.isArray(data.messages)) return null;
        const sessionId = file.slice(0, -'.json'.length);
        return { ...data, sessionId };
      } catch {
        return null;
      }
    }),
  );
  return sessions
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
}

/**
 * 保留策略:超过 MAX_SESSIONS 时删最旧的,保留 KEEP_SESSIONS 个
 */
export async function enforceRetention() {
  const files = await fsp.readdir(SESSIONS_DIR).catch(() => []);
  const jsonFiles = files.filter(f => f.endsWith('.json'));
  if (jsonFiles.length < MAX_SESSIONS) return;
  const stats = await Promise.all(jsonFiles.map(async f => {
    const full = path.join(SESSIONS_DIR, f);
    const s = await fsp.stat(full);
    return { file: full, mtime: s.mtimeMs };
  }));
  stats.sort((a, b) => b.mtime - a.mtime);
  const toDelete = stats.slice(KEEP_SESSIONS);
  await Promise.all(toDelete.map(s => fsp.unlink(s.file).catch(() => {})));
}

export { SESSIONS_DIR };

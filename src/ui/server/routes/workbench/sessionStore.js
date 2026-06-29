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
// AI 对话拆分: session 持久化层。
// 拆分自原 routes/workbench.js 166-260 行。
//
// 文件命名: {sessionId}.json
// 内容: { version, sessionId, title, desc, taskId, promptId, createdAt, updatedAt,
//         messages: [{role, content}], latestSubtasks, latestRaw, latestParseStage }
// 写入用临时文件 + rename 原子替换（与 workbench 现有 writeJson 模式一致），
// 避免半写状态被读到。并发安全: 单进程内同一 session 串行调用，
// 跨端点并发写同 session 概率极低，丢失只会是最后一次 user/assistant pair，可重发。

import fsp from 'fs/promises';
import path from 'path';
import { logger } from './shared.js';
import { SESSIONS_DIR, MAX_SESSIONS, SESSIONS_KEEP } from './shared.js';

// 16 字符: 时间戳后 8 位 + 随机 8 位 base36，既可读也基本不冲突
export function genSessionId() {
  return `${Date.now().toString(36).slice(-8)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function readSessionFile(sessionId) {
  if (!/^[a-z0-9-]{4,32}$/i.test(sessionId)) {
    const err = new Error('非法 sessionId'); err.statusCode = 400; throw err;
  }
  const file = path.join(SESSIONS_DIR, `${sessionId}.json`);
  try {
    return JSON.parse(await fsp.readFile(file, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      const e = new Error('会话不存在'); e.statusCode = 404; throw e;
    }
    throw err;
  }
}

async function writeSessionFile(sessionId, data) {
  await fsp.mkdir(SESSIONS_DIR, { recursive: true });
  const file = path.join(SESSIONS_DIR, `${sessionId}.json`);
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fsp.rename(tmp, file);
}

async function deleteSessionFile(sessionId) {
  if (!/^[a-z0-9-]{4,32}$/i.test(sessionId)) {
    const err = new Error('非法 sessionId'); err.statusCode = 400; throw err;
  }
  const file = path.join(SESSIONS_DIR, `${sessionId}.json`);
  try {
    await fsp.unlink(file);
  } catch (err) {
    if (err.code === 'ENOENT') {
      const e = new Error('会话不存在'); e.statusCode = 404; throw e;
    }
    throw err;
  }
}

// 列表只读 metadata 不读 messages 内容，启动无需预加载
async function listSessionsMeta() {
  await fsp.mkdir(SESSIONS_DIR, { recursive: true });
  const files = await fsp.readdir(SESSIONS_DIR);
  const list = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const sid = f.slice(0, -5);
    try {
      const file = path.join(SESSIONS_DIR, f);
      const stat = await fsp.stat(file);
      const data = JSON.parse(await fsp.readFile(file, 'utf-8'));
      list.push({
        sessionId: data.sessionId || sid,
        title: data.title || '(无标题)',
        taskId: data.taskId || '',
        createdAt: data.createdAt || '',
        updatedAt: data.updatedAt || '',
        messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
        latestSubtaskCount: Array.isArray(data.latestSubtasks) ? data.latestSubtasks.length : 0,
        size: stat.size
      });
    } catch { /* 跳过坏文件 */ }
  }
  list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return list;
}

// 容量控制: 超过 MAX_SESSIONS 时按 mtime 删旧的，保留最新 SESSIONS_KEEP 个
async function enforceSessionsRetention() {
  const files = await fsp.readdir(SESSIONS_DIR).catch(() => []);
  const jsonFiles = files.filter(f => f.endsWith('.json'));
  if (jsonFiles.length < MAX_SESSIONS) return;
  const stats = await Promise.all(jsonFiles.map(async f => {
    const full = path.join(SESSIONS_DIR, f);
    const s = await fsp.stat(full);
    return { file: full, mtime: s.mtimeMs };
  }));
  stats.sort((a, b) => b.mtime - a.mtime);
  const toDelete = stats.slice(SESSIONS_KEEP);
  await Promise.all(toDelete.map(s => fsp.unlink(s.file).catch(() => {})));
  if (toDelete.length > 0) {
    logger.info(`[workbench] ai-split sessions: cleaned up ${toDelete.length} old files`);
  }
}

export const sessionStore = {
  genSessionId,
  read: readSessionFile,
  write: writeSessionFile,
  delete: deleteSessionFile,
  listMeta: listSessionsMeta,
  enforceRetention: enforceSessionsRetention,
};

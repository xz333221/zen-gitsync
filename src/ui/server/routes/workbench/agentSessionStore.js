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
// 智能体对话 session 持久化层。
//
// 与 ai-split-sessions 不同，这里存储的是完整 agent 对话（含工具调用）。
// 消息格式兼容 OpenAI chat completions：
//   - { role: 'system', content: string }
//   - { role: 'user', content: string | content_parts[] }
//   - { role: 'assistant', content: string|null, tool_calls?: [{id,type,function:{name,arguments}}] }
//   - { role: 'tool', tool_call_id, name, content: string }
//
// 文件命名: {sessionId}.json，原子写(tmp + rename)。
// 数据目录: ~/.zen-gitsync/agent-sessions/

import fsp from 'fs/promises';
import path from 'path';
import { logger } from './shared.js';

// 数据目录：与 ai-split-sessions 平级
export const AGENT_SESSIONS_DIR = path.join(
  path.dirname(path.dirname(path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''))))),
  '.zen-gitsync',
  'agent-sessions'
);
// 上面路径在 Windows 下不可靠，改用 os.homedir
import os from 'os';
export const AGENT_SESSIONS_DIR_FIXED = path.join(os.homedir(), '.zen-gitsync', 'agent-sessions');

export const MAX_AGENT_SESSIONS = 200;
export const AGENT_SESSIONS_KEEP = 100;

// 16 字符: 时间戳后 8 位 + 随机 8 位 base36
export function genAgentSessionId() {
  return `ag-${Date.now().toString(36).slice(-8)}-${Math.random().toString(36).slice(2, 10)}`;
}

// 从第一条 user 消息自动生成标题
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
        // 取第一行，截断到 40 字符
        const firstLine = text.split('\n')[0].trim();
        return firstLine.length > 40 ? firstLine.slice(0, 40) + '…' : firstLine;
      }
    }
  }
  return '(新会话)';
}

async function readAgentSessionFile(sessionId) {
  if (!/^ag-[a-z0-9-]{4,32}$/i.test(sessionId)) {
    const err = new Error('非法 sessionId'); err.statusCode = 400; throw err;
  }
  const file = path.join(AGENT_SESSIONS_DIR_FIXED, `${sessionId}.json`);
  try {
    return JSON.parse(await fsp.readFile(file, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      const e = new Error('会话不存在'); e.statusCode = 404; throw e;
    }
    throw err;
  }
}

async function writeAgentSessionFile(sessionId, data) {
  await fsp.mkdir(AGENT_SESSIONS_DIR_FIXED, { recursive: true });
  const file = path.join(AGENT_SESSIONS_DIR_FIXED, `${sessionId}.json`);
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fsp.rename(tmp, file);
}

async function deleteAgentSessionFile(sessionId) {
  if (!/^ag-[a-z0-9-]{4,32}$/i.test(sessionId)) {
    const err = new Error('非法 sessionId'); err.statusCode = 400; throw err;
  }
  const file = path.join(AGENT_SESSIONS_DIR_FIXED, `${sessionId}.json`);
  try {
    await fsp.unlink(file);
  } catch (err) {
    if (err.code === 'ENOENT') {
      const e = new Error('会话不存在'); e.statusCode = 404; throw e;
    }
    throw err;
  }
}

// 列表只读 metadata
async function listAgentSessionsMeta() {
  await fsp.mkdir(AGENT_SESSIONS_DIR_FIXED, { recursive: true });
  const files = await fsp.readdir(AGENT_SESSIONS_DIR_FIXED);
  const list = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const sid = f.slice(0, -5);
    try {
      const file = path.join(AGENT_SESSIONS_DIR_FIXED, f);
      const stat = await fsp.stat(file);
      const data = JSON.parse(await fsp.readFile(file, 'utf-8'));
      list.push({
        sessionId: data.sessionId || sid,
        title: data.title || '(无标题)',
        source: data.source || 'web',  // 'web' | 'cli'
        cwd: data.cwd || '',
        model: data.model || '',
        createdAt: data.createdAt || '',
        updatedAt: data.updatedAt || '',
        messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
        size: stat.size
      });
    } catch { /* 跳过坏文件 */ }
  }
  list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return list;
}

async function enforceAgentSessionsRetention() {
  const files = await fsp.readdir(AGENT_SESSIONS_DIR_FIXED).catch(() => []);
  const jsonFiles = files.filter(f => f.endsWith('.json'));
  if (jsonFiles.length < MAX_AGENT_SESSIONS) return;
  const stats = await Promise.all(jsonFiles.map(async f => {
    const full = path.join(AGENT_SESSIONS_DIR_FIXED, f);
    const s = await fsp.stat(full);
    return { file: full, mtime: s.mtimeMs };
  }));
  stats.sort((a, b) => b.mtime - a.mtime);
  const toDelete = stats.slice(AGENT_SESSIONS_KEEP);
  await Promise.all(toDelete.map(s => fsp.unlink(s.file).catch(() => {})));
  if (toDelete.length > 0) {
    logger.info(`[agent] sessions: cleaned up ${toDelete.length} old files`);
  }
}

// 更新会话标题
async function renameAgentSession(sessionId, title) {
  const data = await readAgentSessionFile(sessionId);
  data.title = String(title || '').trim() || '(无标题)';
  data.updatedAt = new Date().toISOString();
  await writeAgentSessionFile(sessionId, data);
  return data;
}

export const agentSessionStore = {
  genSessionId: genAgentSessionId,
  autoTitle,
  read: readAgentSessionFile,
  write: writeAgentSessionFile,
  delete: deleteAgentSessionFile,
  listMeta: listAgentSessionsMeta,
  enforceRetention: enforceAgentSessionsRetention,
  rename: renameAgentSession,
  DIR: AGENT_SESSIONS_DIR_FIXED,
};

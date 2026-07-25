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
// 本模块刻意不依赖服务器代码,仅用 node 内置 fs/path/os,保持 CLI 自包含。

import fsp from 'fs/promises';
import path from 'path';
import os from 'os';

const SESSIONS_DIR = path.join(os.homedir(), '.zen-gitsync', 'agent-sessions');
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

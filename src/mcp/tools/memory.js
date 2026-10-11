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
// 板块六:跨会话记忆库(~/.zen-gitsync/memory/)。
//
// 这不是 zen-gitsync 自己的功能数据,而是**被派发的 Agent 自己写的**经验库:
// 服务端只铺种子(INDEX.md / GLOBAL.md),正文由 Agent 在用文件工具时自己维护。
// 对外暴露它的价值:让另一个 Agent 能读到"这个项目以前踩过哪些坑"。
//
// 设计上刻意**只读**:写入归 Agent 自己用文件工具做(它有 read_file / write_file,
// 而且它知道自己在写哪一段)。MCP 侧提供写入口只会多一条并发路径,
// 而这份文件的冲突语义(append 还是 rewrite)只有写的人清楚。
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  MEMORY_DIR,
  MEMORY_INDEX_FILE,
  MEMORY_GLOBAL_FILE,
  MEMORY_PROJECTS_DIR,
} from '../paths.js';
import { readTextFile, truncate, asString, asInt } from '../util.js';

/** 记忆库里允许被读的顶层标量文件(白名单,不开放任意路径)。 */
const TOP_FILES = {
  index: MEMORY_INDEX_FILE,
  global: MEMORY_GLOBAL_FILE,
  rules: path.join(MEMORY_DIR, 'RULES.md'),
};

/**
 * 列出一个 scope 下的全部 .md —— **递归**。
 *
 * 为什么必须递归:记忆库的正文不在顶层,而在 `lessons/<topic>.md`(这是 AGENTS.md
 * 定的约定:索引进上下文、正文按需懒加载)。只列顶层的话,memory_index 会
 * 报"这个项目只有 INDEX.md",而真正有价值的坑全在下一层 —— 调用方根本发现不了
 * 它们存在,memory_read 也就没人会去调。
 *
 * 深度与条数都设上限:这是索引,不是目录遍历工具。
 */
async function listMarkdown(dir, { maxDepth = 3, maxEntries = 200 } = {}) {
  const out = [];
  const walk = async (current, depth) => {
    if (depth > maxDepth || out.length >= maxEntries) return;
    let names;
    try {
      names = await fs.readdir(current);
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= maxEntries) return;
      if (name.startsWith('.')) continue;
      const full = path.join(current, name);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      if (stat.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!name.endsWith('.md')) continue;
      out.push({
        // 相对 scope 根的路径 —— memory_read 的 file 参数直接吃这个
        file: path.relative(dir, full).split(path.sep).join('/'),
        size: stat.size,
        modified_at: new Date(stat.mtimeMs).toISOString(),
      });
    }
  };
  await walk(dir, 0);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

export const memoryTools = [
  {
    name: 'memory_index',
    description:
      '读 zen-gitsync 的跨会话记忆库索引:全局主题词 + 每个项目的经验目录(含每个 scope 有哪些文件)。'
      + '想知道"这个项目以前踩过什么坑、定过什么约定",先看这里,再用 memory_read 读具体那一篇。',
    inputSchema: {
      type: 'object',
      properties: {
        include_projects: { type: 'boolean', description: '是否连同每个项目 scope 的文件清单一起返回,默认 true' },
      },
    },
    async handler(args) {
      const index = await readTextFile(MEMORY_INDEX_FILE, '');
      const global = await readTextFile(MEMORY_GLOBAL_FILE, '');
      const rules = await readTextFile(TOP_FILES.rules, '');

      const result = {
        source: 'file',
        dir: MEMORY_DIR,
        initialized: !!index.trim() || !!global.trim(),
        index: index.trim() ? truncate(index, 8000) : '(还没有索引)',
        has_global: !!global.trim(),
        has_rules: !!rules.trim(),
        scopes: Object.keys(TOP_FILES),
      };

      if (args?.include_projects !== false) {
        let names = [];
        try {
          names = await fs.readdir(MEMORY_PROJECTS_DIR);
        } catch { /* 还没有 projects/ 目录 */ }
        const projects = [];
        for (const name of names) {
          if (name.startsWith('.')) continue;
          const dir = path.join(MEMORY_PROJECTS_DIR, name);
          const stat = await fs.stat(dir).catch(() => null);
          if (!stat?.isDirectory()) continue;
          projects.push({ scope: name, files: await listMarkdown(dir) });
        }
        result.projects = projects;
        result.project_count = projects.length;
      }

      const archive = await listMarkdown(path.join(MEMORY_DIR, 'archive'));
      if (archive.length) result.archive = archive;

      return result;
    },
  },

  {
    name: 'memory_read',
    description:
      '读记忆库里的一篇正文。scope 取 index / global / rules,或某个项目 scope(见 memory_index 返回的 scope 名);'
      + 'file 是该 scope 下的文件名(默认 INDEX.md)。只能读记忆库目录内的文件。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'index | global | rules | <项目 scope 名>' },
        file: { type: 'string', description: 'scope 内的文件名,如 lessons/shared-worktree.md;默认 INDEX.md' },
        max_chars: { type: 'integer', description: '最多返回多少字符,默认 20000' },
      },
      required: ['scope'],
    },
    async handler(args) {
      const scope = asString(args?.scope);
      if (!scope) return { error: '需要 scope。先用 memory_index 看有哪些 scope。' };
      const maxChars = asInt(args?.max_chars, 20_000, { min: 200, max: 200_000 });

      let baseDir;
      if (TOP_FILES[scope]) {
        baseDir = MEMORY_DIR;
      } else if (scope === 'projects') {
        baseDir = MEMORY_PROJECTS_DIR;
      } else {
        baseDir = path.join(MEMORY_PROJECTS_DIR, scope);
      }

      const rel = asString(args?.file, 'INDEX.md');
      const target = path.resolve(baseDir, rel);
      const root = path.resolve(MEMORY_DIR);

      // 路径穿越防护:归一后必须仍在记忆库目录里。这里不做"允许读任意路径"的扩展 ——
      // 需要读别的文件,调用方有自己的文件工具。
      if (target !== root && !target.startsWith(root + path.sep)) {
        return { error: `拒绝:解析后的路径落在记忆库目录之外(${target})。` };
      }

      const text = await readTextFile(target, '');
      if (!text.trim()) {
        const exists = await fs.stat(target).then(() => true).catch(() => false);
        return exists
          ? { source: 'file', file: target, empty: true, content: '' }
          : { error: `读不到 ${target}(文件不存在或为空)。` };
      }

      return {
        source: 'file',
        scope,
        file: target,
        size: text.length,
        truncated: text.length > maxChars,
        content: truncate(text, maxChars, maxChars),
      };
    },
  },
];

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
// 板块五:思维导图。
//
// 落盘形态:用户自选目录里的 `*.mindmap.json`,内容就是 flow-mindmap 组件的
// exportData() JSON(根 {id, text, children})。**不在** ~/.zen-gitsync/ 下。
//
// 目录从哪来:没有中心化登记。唯一一份"用户用过哪些目录"的记录是
// ~/.zen-gitsync/ai-context/mindmap.md(由 g ui 生成,`## <目录>（N 个）` 分段)。
// 所以不传 dir 时按那份快照里的目录列表逐个扫。
import path from 'node:path';

import { AI_CONTEXT_DIR } from '../paths.js';
import { readTextFile, truncate, asString } from '../util.js';

const MINDMAP_EXT = '.mindmap.json';

/** 从 mindmap.md 快照里抠出目录列表(`## D:\path\here（N 个）`)。 */
function parseMindmapDirs(md) {
  const dirs = [];
  const re = /^##\s+(.+?)(?:（\d+\s*个）)?\s*$/gm;
  let m;
  while ((m = re.exec(String(md || ''))) !== null) {
    const dir = m[1].trim();
    // 跳过 markdown 里其它层级的伪标题;目录一定含路径分隔符
    if (dir && /[\\/]/.test(dir)) dirs.push(dir);
  }
  return Array.from(new Set(dirs));
}

/** 扫一个目录里的 .mindmap.json。目录不存在就是空数组,不是错误。 */
async function scanDir(dir) {
  const { promises: fs } = await import('node:fs');
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return { dir, exists: false, files: [] };
  }
  const files = [];
  for (const name of names) {
    if (name.startsWith('.') || !name.endsWith(MINDMAP_EXT)) continue;
    const full = path.join(dir, name);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat?.isFile()) continue;
    const title = await readMindmapTitle(full);
    files.push({
      name,
      title,
      path: full,
      size: stat.size,
      modified_at: new Date(stat.mtimeMs).toISOString(),
    });
  }
  files.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return { dir, exists: true, files };
}

/** 只为了拿标题,读整份 JSON —— 导图不大(本机最大 15KB),不值得为省这点 IO 加复杂度。 */
async function readMindmapTitle(file) {
  try {
    const raw = await readTextFile(file, '');
    const parsed = JSON.parse(raw);
    return String(parsed?.text || '') || path.basename(file, MINDMAP_EXT);
  } catch {
    return path.basename(file, MINDMAP_EXT);
  }
}

/**
 * 导图 JSON → 缩进大纲文本。
 * 为什么要转:给模型看一棵嵌套 JSON 远不如看缩进列表省 token 也更好理解结构。
 * 纯文本大纲同时保留了层级与顺序,丢的只有 id / 折叠态这些给渲染用的字段。
 */
function renderOutline(node, depth, lines, budget) {
  if (!node || typeof node !== 'object' || lines.length >= budget) return;
  const text = String(node.text ?? '').replace(/\s+/g, ' ').trim();
  lines.push(`${'  '.repeat(depth)}- ${text || '(空节点)'}`);
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) renderOutline(child, depth + 1, lines, budget);
}

function countNodes(node) {
  if (!node || typeof node !== 'object') return 0;
  let n = 1;
  for (const child of Array.isArray(node.children) ? node.children : []) n += countNodes(child);
  return n;
}

export const mindmapTools = [
  {
    name: 'mindmap_list',
    description:
      '列出用户的思维导图。导图是散在用户自选目录里的 *.mindmap.json 文件,'
      + '不传 dir 时会按工作区快照里记录过的那些导图目录逐个扫。'
      + '想看某张导图的内容用 mindmap_read。',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '可选,指定一个目录;不传则扫快照里记录过的全部导图目录' },
      },
    },
    async handler(args) {
      const explicit = asString(args?.dir);
      let dirs;
      let sourceOfDirs;

      if (explicit) {
        dirs = [explicit];
        sourceOfDirs = 'explicit';
      } else {
        const md = await readTextFile(path.join(AI_CONTEXT_DIR, 'mindmap.md'), '');
        dirs = parseMindmapDirs(md);
        sourceOfDirs = 'ai-context/ mindmap.md 快照';
        if (dirs.length === 0) {
          return {
            source: 'file',
            available: false,
            note: '没有已知的思维导图目录。让用户传 dir,或先让 g ui 生成一次工作区快照'
              + '(它把用过的导图目录记在 ai-context/mindmap.md 里)。',
          };
        }
      }

      const scanned = [];
      for (const dir of dirs) scanned.push(await scanDir(dir));

      return {
        source: 'file',
        dirs_source: sourceOfDirs,
        dir_count: scanned.length,
        file_count: scanned.reduce((n, s) => n + s.files.length, 0),
        directories: scanned,
        note: '导图文件扩展名约定是 .mindmap.json。modified_at 倒序。',
      };
    },
  },

  {
    name: 'mindmap_read',
    description:
      '读一张思维导图的内容。返回缩进大纲(层级 + 顺序,给模型读最省 token)以及原始节点的数量与结构信息。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '导图文件的绝对路径(从 mindmap_list 拿,必须以 .mindmap.json 结尾)' },
        max_lines: { type: 'integer', description: '大纲最多输出多少行,默认 400' },
        include_raw: { type: 'boolean', description: '是否连同原始 JSON 一起返回,默认 false(可能很大)' },
      },
      required: ['path'],
    },
    async handler(args) {
      const file = asString(args?.path);
      if (!file) return { error: '需要 path(导图文件路径)。' };
      if (!file.endsWith(MINDMAP_EXT)) {
        return { error: `这不是一个思维导图文件 —— 本项目约定的扩展名是 ${MINDMAP_EXT}。收到的是: ${file}` };
      }
      const maxLines = Math.min(Math.max(Number(args?.max_lines) || 400, 10), 3000);

      const raw = await readTextFile(file, '');
      if (!raw.trim()) return { error: `读不到文件(不存在或为空): ${file}` };

      let tree;
      try {
        tree = JSON.parse(raw);
      } catch (err) {
        return { error: `解析失败,这不是合法的导图 JSON: ${err.message}` };
      }

      const lines = [];
      renderOutline(tree, 0, lines, maxLines);

      const result = {
        source: 'file',
        file,
        title: String(tree?.text || ''),
        node_count: countNodes(tree),
        outline_lines: lines.length,
        truncated: lines.length >= maxLines,
        outline: lines.join('\n'),
      };
      if (args?.include_raw === true) result.raw = truncate(raw, 20_000);
      return result;
    },
  },
];

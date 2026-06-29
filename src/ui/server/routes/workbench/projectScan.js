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
// 子项目识别 / manifest 读取 / 目录树扫描。
// 拆分自原 routes/workbench.js 313-390 行 + 1000-1079 行。
//
// 用途：AI 生成架构说明时把项目结构喂给 LLM。
// 设计要点：
//   - 只读 manifest 与 README，不读源码（避免上下文爆炸）
//   - findSubProjects 递归找 .git / manifest；A 是 B 的祖先时只保留 B
//   - 大文件用 safeReadFile 截断到 maxBytes

import fsp from 'fs/promises';
import path from 'path';
import { SKIP_DIRS, MANIFEST_FILES } from './shared.js';

// 轻量级：仅告诉 LLM 项目的主 manifest 是什么（用于 AI 拆分时让 LLM 知道项目类型）。
// 不读内容，只 stat 存在性——拆分子任务不需要细节。
export async function detectProjectManifest(projectPath) {
  if (!projectPath) return '';
  for (const f of MANIFEST_FILES) {
    try {
      const stat = await fsp.stat(path.join(projectPath, f));
      if (stat.isFile()) return f;
    } catch { /* 不存在，继续 */ }
  }
  return '';
}

// 读取项目所有 manifest 内容（限 20KB / 文件），返回 { [filename]: content }
export async function readProjectManifest(projectPath) {
  const out = {};
  for (const f of MANIFEST_FILES) {
    const p = path.join(projectPath, f);
    try {
      const stat = await fsp.stat(p);
      if (!stat.isFile()) continue;
      const content = stat.size > 20000
        ? (await safeReadFile(p, 20000))
        : (await fsp.readFile(p, 'utf8'));
      out[f] = content;
    } catch { /* 不存在就跳过 */ }
  }
  return out;
}

// 安全读文件：超 maxBytes 时只读前 maxBytes 字节，避免巨型文件把上下文打爆
export async function safeReadFile(filePath, maxBytes = 200000) {
  try {
    const stat = await fsp.stat(filePath);
    if (stat.size > maxBytes) {
      const buf = Buffer.alloc(maxBytes);
      const fd = await fsp.open(filePath, 'r');
      await fd.read(buf, 0, maxBytes, 0);
      await fd.close();
      return buf.toString('utf8').slice(0, maxBytes);
    }
    return await fsp.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

// 列出项目目录树（默认 2 层），过滤掉 node_modules / dist / .git 等
export async function listDirTree(projectPath, maxDepth = 2, maxEntries = 400) {
  const lines = [];
  async function walk(dir, depth) {
    if (depth > maxDepth || lines.length >= maxEntries) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    const filtered = entries.filter(e => {
      if (e.name.startsWith('.')) return false;
      if (['node_modules', 'dist', 'build', '.next', '.nuxt', '__pycache__', 'target', 'out', 'coverage', 'vendor'].includes(e.name)) return false;
      return true;
    });
    const indent = '  '.repeat(depth);
    for (const e of filtered) {
      if (lines.length >= maxEntries) return;
      if (e.isDirectory()) {
        lines.push(`${indent}${e.name}/`);
        await walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        lines.push(`${indent}${e.name}`);
      }
    }
  }
  await walk(projectPath, 0);
  return lines.join('\n');
}

/**
 * 递归识别子项目：找含 .git 目录或 manifest 文件的目录。
 * A 是 B 的祖先时只保留更深的 B（避免父项目重复包含子项目）。
 *
 * @param {string} projectPath 项目根路径
 * @param {object} [opts]
 * @param {number} [opts.maxDepth=4] 最大递归深度
 * @returns {Promise<Array<{root, name, manifests, readme, dirTree}>>}
 */
export async function findSubProjects(projectPath, opts = {}) {
  const { maxDepth = 4 } = opts;
  const candidates = [];

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }

    let hasManifest = false;
    let hasGit = false;
    const subDirs = [];
    for (const e of entries) {
      if (!e.isDirectory() && !e.isFile()) continue;
      if (e.name.startsWith('.')) {
        if (e.name === '.git' && e.isDirectory()) hasGit = true;
        continue;
      }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        subDirs.push(path.join(dir, e.name));
      } else if (e.isFile() && MANIFEST_FILES.includes(e.name)) {
        hasManifest = true;
      }
    }
    if (hasManifest || hasGit) {
      candidates.push(dir);
      return; // 子目录里若还有 manifest，会被自己发现；这里不再下钻避免冗余
    }
    if (depth >= maxDepth) return;
    for (const sub of subDirs) {
      await walk(sub, depth + 1);
    }
  }

  await walk(projectPath, 0);

  // 去重：若 candidates 里 A 是 B 的祖先，只保留更深一级的 B
  candidates.sort((a, b) => a.length - b.length);
  const kept = [];
  for (const c of candidates) {
    let dominated = false;
    for (const k of kept) {
      if (c === k || c.startsWith(k + path.sep)) { dominated = true; break; }
    }
    if (!dominated) kept.push(c);
  }

  // 收集每个子项目的关键文件
  const result = [];
  for (const root of kept) {
    const manifests = {};
    for (const m of MANIFEST_FILES) {
      const p = path.join(root, m);
      try {
        const stat = await fsp.stat(p);
        if (stat.isFile()) {
          manifests[m] = stat.size > 20000
            ? await safeReadFile(p, 20000)
            : await fsp.readFile(p, 'utf8');
        }
      } catch { /* 不存在就跳过 */ }
    }
    let readme = '';
    try {
      const stat = await fsp.stat(path.join(root, 'README.md'));
      if (stat.isFile()) readme = await safeReadFile(path.join(root, 'README.md'), 8000);
    } catch { /* 不存在就跳过 */ }
    const dirTree = await listDirTree(root, 2, 200);
    result.push({
      root,
      name: path.basename(root) || path.basename(projectPath),
      manifests,
      readme,
      dirTree
    });
  }
  return result;
}

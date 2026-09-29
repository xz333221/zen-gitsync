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
// 记忆库的**浏览 / 删除**能力。store.js 只管"写的时候路径对不对"，
// 这里管"界面看到什么、能删什么"。
//
// ── 身份是怎么表达的 ────────────────────────────────────────────────
// 记忆条目的定位是 `{ scope, file }`：
//   scope = `'global'`                    → `MEMORY_DIR/GLOBAL.md`
//   scope = `'global-index'`              → `MEMORY_DIR/INDEX.md`
//   scope = 任意 slug                     → `MEMORY_DIR/projects/<slug>/lessons/<file>`
// **前端永远只传 scope + file 两个字符串，不传绝对路径** ——
// 这是本文件最重要的安全设计：路径由服务端从 scope 重新拼，
// 前端传什么都只能落到"某个 slug 下的某个 lessons/*.md"，
// 不存在拼出 `~/.claude/settings.json` 的可能。
// （对比 mindmap.js：那边让前端传 path，所以得靠 validatePath + pathGuard 双重拦；
//   这里是结构性防��� —— 越界参数压根不参与路径拼接。）
//
// ⚠️ 因此下面所有对 `scope` / `file` 的合法性检查都**不是可选的加固**，
// 而是这条安全边界的组成部分。改这个文件时别把它们当冗余删掉。

import fs from 'node:fs/promises';
import path from 'node:path';
import { MEMORY_DIR, MEMORY_GLOBAL_FILE, MEMORY_INDEX_FILE, MEMORY_PROJECTS_DIR } from '../paths.js';

/** 单条正文的大小上限：超过就不给读（界面也渲染不动） */
export const ENTRY_MAX_BYTES = 64 * 1024;

/** 列表条目数上限：避免一个 slug 下堆了上千文件时把响应撑爆 */
export const LIST_MAX_ENTRIES = 500;

/** scope 的两种特殊值（其余都当 slug 处理） */
export const SCOPE_GLOBAL = 'global';
export const SCOPE_GLOBAL_INDEX = 'global-index';

const LESSON_EXT = '.md';

/** slug 形状：可读部分 + 6 位十六进制哈希。**必须严格校验**（见文件头） */
const SLUG_RE = /^[a-z0-9_][a-z0-9_-]{0,120}-[0-9a-f]{6}$/;

/** lesson 文件名：kebab-case，不允许点号/斜杠/上跳（`.` 与 `..` 靠这条挡掉） */
const FILE_RE = /^[a-z0-9][a-z0-9._-]{0,79}\.md$/i;

export function isValidScope(scope) {
  return scope === SCOPE_GLOBAL || scope === SCOPE_GLOBAL_INDEX || (typeof scope === 'string' && SLUG_RE.test(scope));
}

export function isValidFile(file) {
  return typeof file === 'string' && FILE_RE.test(file);
}

/**
 * `{scope,file}` → 绝对路径。**不合法就返回空串**（调用方决定报什么错）。
 *
 * 注意它只可能落在三处：全局正文、全局索引、某 slug 的 lessons/ 下。
 * 别的路径**在这个函数里无法被构造出来**。
 */
export function resolveEntryPath(scope, file) {
  if (!isValidScope(scope) || !isValidFile(file)) return '';
  // ⚠️ 这里必须用 endsWith 而不是 ===：全局两篇是**固定文件名**（GLOBAL.md / INDEX.md），
  // 但 isValidFile 只保证"是个合法的 .md 文件名"，不保证叫这两个名字。
  // 写 === '.md' 会让所有全局条目一律解析失败（第一版就是这么写错的，测出来的）。
  if (scope === SCOPE_GLOBAL) return file.toLowerCase() === 'global.md' ? MEMORY_GLOBAL_FILE : '';
  if (scope === SCOPE_GLOBAL_INDEX) return file.toLowerCase() === 'index.md' ? MEMORY_INDEX_FILE : '';
  return path.join(MEMORY_PROJECTS_DIR, scope, 'lessons', file);
}

async function statOrNull(p) {
  try { return await fs.stat(p); } catch { return null; }
}

/**
 * 列出一个 scope 下的条目。
 *
 * @param {string} scope  'global' | 'global-index' | <slug>
 * @returns {Promise<Array<{file, title, size, mtime, indexed: boolean, summary: string}>>}
 *          mtime 倒序（最新在前），与 ExecutionLogManager 的列表口径一致。
 */
export async function listEntries(scope) {
  if (scope === SCOPE_GLOBAL || scope === SCOPE_GLOBAL_INDEX) {
    const abs = scope === SCOPE_GLOBAL ? MEMORY_GLOBAL_FILE : MEMORY_INDEX_FILE;
    const st = await statOrNull(abs);
    if (!st || !st.isFile()) return [];
    return [{
      file: path.basename(abs),
      title: scope === SCOPE_GLOBAL ? 'GLOBAL.md' : 'INDEX.md',
      size: st.size,
      mtime: st.mtimeMs,
      // 全局两篇是"索引本身"，条目字段不适用
      indexed: true,
      summary: '',
    }];
  }

  if (!isValidScope(scope)) return [];
  const dir = path.join(MEMORY_PROJECTS_DIR, scope, 'lessons');
  let names;
  try {
    names = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  // 索引里出现过的文件名 → 这条经验是有索引的（没索引的属于"孤儿"，界面要标出来）
  const indexed = await readIndexedFiles(scope);

  const out = [];
  for (const e of names) {
    if (!e.isFile()) continue;
    if (e.name.startsWith('.')) continue;
    if (!isValidFile(e.name)) continue;
    if (out.length >= LIST_MAX_ENTRIES) break;
    const st = await statOrNull(path.join(dir, e.name));
    if (!st) continue;
    out.push({
      file: e.name,
      title: e.name.slice(0, -LESSON_EXT.length),
      size: st.size,
      mtime: st.mtimeMs,
      indexed: indexed.has(e.name),
      summary: '',
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** 从项目 INDEX.md 里抽出被索引到的 lesson 文件名集合。解析失败时返回空集。 */
async function readIndexedFiles(scope) {
  const set = new Set();
  try {
    const text = await fs.readFile(path.join(MEMORY_PROJECTS_DIR, scope, 'INDEX.md'), 'utf8');
    for (const m of text.matchAll(/\((lessons\/[^)]+)\)/g)) {
      const name = m[1].slice('lessons/'.length);
      if (isValidFile(name)) set.add(name);
    }
  } catch { /* 索引读不到就当作"都没有索引"，界面会提示补索引 */ }
  return set;
}

/** 从 INDEX.md 的一行里取出标题与摘要，供界面直接显示（省得读正文） */
export function parseIndexLine(line) {
  const m = /^\s*-\s*\[([^\]]+)\]\([^)]+\)\s*(?:[—-]\s*(.*))?$/.exec(line);
  if (!m) return null;
  return { title: m[1].trim(), summary: (m[2] || '').trim() };
}

/**
 * 列出全部 scope（给界面的项目切换器用）。
 *
 * slug → 展示名：优先用项目 INDEX.md 头里记的仓库路径（那才是人能认出的东西），
 * 退化时显示 slug 本体。**绝不在这里暴露绝对路径之外的东西** ——
 * 仓库路径本来就存在 INDEX.md 里，是给用户看的，不是秘密。
 */
export async function listScopes() {
  const out = [];
  for (const [scope, label] of [[SCOPE_GLOBAL, 'GLOBAL'], [SCOPE_GLOBAL_INDEX, 'INDEX']]) {
    const st = await statOrNull(scope === SCOPE_GLOBAL ? MEMORY_GLOBAL_FILE : MEMORY_INDEX_FILE);
    if (st && st.isFile()) out.push({ scope, label, repoPath: '', count: 1, mtime: st.mtimeMs });
  }

  let names = [];
  try { names = await fs.readdir(MEMORY_PROJECTS_DIR, { withFileTypes: true }); } catch { names = []; }

  for (const e of names) {
    if (!e.isDirectory() || !isValidScope(e.name)) continue;
    const entries = await listEntries(e.name);
    const idx = path.join(MEMORY_PROJECTS_DIR, e.name, 'INDEX.md');
    let repoPath = '';
    try {
      const m = /^>\s*仓库：\s*`(.+?)`/m.exec(await fs.readFile(idx, 'utf8'));
      if (m) repoPath = m[1];
    } catch { /* 头没写就退化显示 slug */ }
    out.push({
      scope: e.name,
      label: repoPath || e.name,
      repoPath,
      count: entries.length,
      mtime: entries.length ? entries[0].mtime : 0,
    });
  }
  // 最新的在前；全局两篇永远排最上（它们是"所有项目都适用"的那部分）
  out.sort((a, b) => (a.scope === SCOPE_GLOBAL || a.scope === SCOPE_GLOBAL_INDEX ? -1 : 1)
    - (b.scope === SCOPE_GLOBAL || b.scope === SCOPE_GLOBAL_INDEX ? -1 : 1) || b.mtime - a.mtime);
  return out;
}

/** 读一条正文；不存在返回 {missing:true}，过大返回 {tooLarge:true}。都**不抛错**。 */
export async function readEntry(scope, file) {
  const abs = resolveEntryPath(scope, file);
  if (!abs) return { error: 'invalid' };
  let st;
  try { st = await fs.stat(abs); } catch { return { missing: true }; }
  if (!st.isFile()) return { missing: true };
  if (st.size > ENTRY_MAX_BYTES) return { tooLarge: true, size: st.size };
  try {
    return { content: await fs.readFile(abs, 'utf8'), size: st.size, mtime: st.mtimeMs };
  } catch {
    return { missing: true };
  }
}

/**
 * 删一条。
 *
 * ⚠️ 删 lesson 会**连带删掉它在 INDEX.md 里的那一行** —— 留着就是一条指向
 * 死链的索引（Agent 命中它会去读一个不存在的文件）。这是"删除"语义完整的
 * 一部分，不是副作用。`archive/` 里的同名文件不动。
 *
 * @returns {Promise<{removed: boolean, indexLineRemoved: boolean, alreadyGone: boolean}>}
 */
export async function deleteEntry(scope, file) {
  const abs = resolveEntryPath(scope, file);
  if (!abs) return { error: 'invalid' };

  let alreadyGone = false;
  try {
    await fs.unlink(abs);
  } catch (err) {
    if (err.code === 'ENOENT') alreadyGone = true;   // 幂等：本来就没有也算成功
    else throw err;
  }

  let indexLineRemoved = false;
  if (isValidScope(scope) && scope !== SCOPE_GLOBAL && scope !== SCOPE_GLOBAL_INDEX) {
    indexLineRemoved = await removeIndexLine(scope, file);
  }
  return { removed: !alreadyGone, indexLineRemoved, alreadyGone };
}

/** 从项目 INDEX.md 里删掉指向某个 lesson 的那一行。读不到/没这行都算无事发生。 */
async function removeIndexLine(scope, file) {
  const idx = path.join(MEMORY_PROJECTS_DIR, scope, 'INDEX.md');
  let text;
  try { text = await fs.readFile(idx, 'utf8'); } catch { return false; }
  const needle = `(lessons/${file})`;
  if (!text.includes(needle)) return false;
  // 逐行过滤而不是 replace：needle 只在行首的链接形态里出现，
  // 行级过滤天然不会误伤正文里恰好提到同一路径的段落。
  const kept = text.split(/\r?\n/).filter((l) => !l.includes(needle));
  if (kept.length === text.split(/\r?\n/).length) return false;
  await writeTextAtomic(idx, kept.join('\n'));
  return true;
}

/** 原子写：tmp + rename。直接 writeFile 会和读者（正在渲染的面板）撞出半截内容。 */
async function writeTextAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

/** 记忆库是否已就位（目录在不在） */
export async function memoryDirExists() {
  const st = await statOrNull(MEMORY_DIR);
  return !!(st && st.isDirectory());
}

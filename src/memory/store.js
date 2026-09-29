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
// 跨会话「记忆库」的读写层。
//
// ── 为什么是"索引 + 正文"两层 ─────────────────────────────────────────
// 用户原话点破的那件事:「总结要尽可能简洁,或者用索引的方式,不然上下文会太长」。
// 早期形态是单个 MEMORY.md 全文进上下文,越记越贵、越贵越没人看。所以:
//
//   INDEX.md   每条 ≤100 字,只有它进 prompt(见 memoryContext.js)
//   lessons/   正文单条 ≤25 行,Agent 命中关键词才自己 read
//   archive/   冻结历史,永不读
//
// ── 谁在写 ───────────────────────────────────────────────────────────
// **Agent 自己**,不是服务端。服务端只在 prompt 里给一段指针,Agent 用它自己的
// 文件工具去读索引、按需读正文、收尾时追加 lesson。理由:
//   · Agent 才知道"这次踩的坑"是什么,服务端只有一堆 IO 事件;
//   · 少一次 LLM 调用(服务端代写就得再起一轮模型,还猜不准该记什么);
//   · Agent 写完立刻能自己验证路径对不对。
// 服务端只保留两件事:目录不存在时铺种子、算 slug 告诉 Agent 写哪儿。
//
// ⚠️ 这个模块**只碰 MEMORY_DIR 下的路径**,一个字节都不写到用户工作区或
// 第三方工具的配置目录(~/.claude、~/.codex 等)。Agent 按 prompt 里的
// 指令去写那些文件时是它自己的选择,不是本产品替他改配置。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MEMORY_DIR, MEMORY_GLOBAL_FILE, MEMORY_INDEX_FILE, MEMORY_PROJECTS_DIR } from '../paths.js';

/** 种子模板:随包发布,首次运行时铺进 MEMORY_DIR(见 templates.js) */
import { MEMORY_SEED_FILES } from './templates.js';

/**
 * 仓库绝对路径 → 记忆库里的项目 slug。
 *
 * 形状：`<可读部分>-<路径哈希 6 位>`
 *   `C:\workspace\github_workspace\xz333221\zen-gitsync`
 *     → `c-workspace-github_workspace-xz333221-zen-gitsync-3f2a1b`
 *
 * ⚠️ **哈希是必须的，不是装饰**（2026-09-29 实测踩到）：
 * 只做"小写 + 非 [a-z0-9_] 压成 -"的话，两个不同的中文路径会塌成同一个 slug ——
 *   `C:\中文\项目` 与 `C:\中文\别的` → 都是 `c-`
 * 于是两个仓库共用一份 lessons，A 项目的教训会被当成 B 项目的写进 prompt。
 * 这类污染**不报错、不可见**，是记忆系统最坏的一类失效。
 *
 * 哈希前先把 `\` 归一成 `/` 再算：`C:\a\b` 与 `C:/a/b` 是同一个仓库的两个写法，
 * 归一后才能算出同一个 slug（否则同仓库会裂成两份记忆）。
 *
 * ⚠️ 两条纪律(改这个函数前先读):
 *   1. **纯函数,不碰文件系统** —— 单测要能直接钉住映射规则,不许夹带 stat。
 *   2. **规则一改 = 全量历史记忆失联**（目录名变了）。所以要改必须同时带一份
 *      重命名迁移;宁可永远不改规则也不要"顺手优化一下"。
 *
 * 保留 `_`(不下划线)是为了让 slug 读起来还认得出仓库名。
 */
export function projectSlug(repoPath) {
  if (typeof repoPath !== 'string') return '';
  const s = repoPath.trim();
  if (!s) return '';
  // 分隔符先归一,让同一个仓库的两种写法落到同一个 slug
  const normalized = s.replace(/\\/g, '/').toLowerCase();
  const readable = normalized
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // 哈希走归一后的路径:大小写与分隔符差异不该让同一个仓库裂成两份
  const hash = createHash('sha1').update(normalized).digest('hex').slice(0, 6);
  return `${readable || 'root'}-${hash}`;
}

/** 某仓库的项目目录绝对路径(不保证存在 —— 存在性由 ensureProjectDir 负责) */
export function projectMemoryDir(repoPath) {
  const slug = projectSlug(repoPath);
  return slug ? path.join(MEMORY_PROJECTS_DIR, slug) : '';
}

/** 某仓库的项目索引绝对路径 */
export function projectIndexFile(repoPath) {
  const dir = projectMemoryDir(repoPath);
  return dir ? path.join(dir, 'INDEX.md') : '';
}

/** 读一个文本文件;不存在返回 ''，读失败也返回 ''（记忆读不到不该影响任何事） */
async function readTextOrEmpty(file) {
  if (!file) return '';
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 幂等铺种子:目录不存在时把 MEMORY_SEED_FILES 写进去。
 *
 * **已存在的文件一律不覆盖** —— 用户(和 Agent)可能在里面写过东西,
 * 每次启动都重铺等于把记忆洗回出厂设置。
 *
 * @returns {Promise<{created: string[], existed: number}>} created = 实际新建的文件名
 */
export async function ensureMemoryStore() {
  await fsp.mkdir(MEMORY_DIR, { recursive: true });
  await fsp.mkdir(path.join(MEMORY_DIR, 'archive'), { recursive: true });

  let existed = 0;
  const created = [];
  for (const [rel, content] of Object.entries(MEMORY_SEED_FILES)) {
    const target = path.join(MEMORY_DIR, ...rel.split('/'));
    try {
      await fsp.access(target);
      existed += 1;
    } catch {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, content, 'utf8');
      created.push(rel);
    }
  }
  return { created, existed };
}

/**
 * 确保某仓库的项目目录存在,并返回它的索引路径。
 * 索引不存在就铺一份**带 path 头**的骨架 —— 头里记着仓库绝对路径,
 * 这样即便将来 slug 规则变了,人/Agent 还能从 INDEX.md 认回来。
 *
 * @returns {Promise<string>} 项目索引绝对路径；repoPath 非法时返回 ''
 */
export async function ensureProjectMemory(repoPath) {
  const dir = projectMemoryDir(repoPath);
  if (!dir) return '';
  await fsp.mkdir(path.join(dir, 'lessons'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'archive'), { recursive: true });

  const idx = path.join(dir, 'INDEX.md');
  try {
    await fsp.access(idx);
  } catch {
    await fsp.writeFile(idx, renderProjectIndexHeader(repoPath), 'utf8');
  }
  return idx;
}

/** 新项目索引的头部。抽成函数是为了单测能直接断言首行格式。 */
export function renderProjectIndexHeader(repoPath) {
  return [
    '# 记忆索引 · 本项目',
    '',
    `> 仓库：\`${repoPath}\``,
    '> 预算：≤40 条 / ≤6KB，**每条 ≤100 字**。**正文在 `lessons/`，只有命中本行才去 Read 对应文件。**',
    '> 条目只写"先查什么 / 以后怎么做"，不写"我做了什么"。单条 >25 行 → 那是文档，踢去项目 `docs/`。',
    '',
    '## 主题',
    '',
  ].join('\n');
}

/** 全局索引内容（可能为空串） */
export function readGlobalIndex() {
  return readTextOrEmpty(MEMORY_INDEX_FILE);
}

/** 跨项目经验正文（可能为空串） */
export function readGlobalMemory() {
  return readTextOrEmpty(MEMORY_GLOBAL_FILE);
}

/** 某仓库的项目索引内容（可能为空串） */
export function readProjectIndex(repoPath) {
  return readTextOrEmpty(projectIndexFile(repoPath));
}

/**
 * 记忆库是否"可用"。
 *
 * 判据刻意很弱:只要 MEMORY_DIR 存在就算可用。因为产品默认**不预填任何经验**,
 * 一个只有种子文件、没有一条 lesson 的空库也该被指针照常指向 ——
 * 否则第一次派发时 Agent 看不到"有个记忆库存在",永远写不出第一条。
 * 首次写入的活由 ensureMemoryStore() 兜。
 */
export function memoryAvailable() {
  try {
    fs.accessSync(MEMORY_DIR);
    return true;
  } catch {
    return false;
  }
}

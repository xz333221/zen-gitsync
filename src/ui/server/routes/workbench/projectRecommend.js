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
// 「推荐添加的项目」扫描 —— 找那些**已经躺在磁盘上、但不在项目清单里**的仓库。
//
// 为什么需要它：写 recentDirectories 的地方只有两处（GUI 启动 + /api/change_directory），
// 所以"让智能体克隆一个仓库 / 新建一个项目"之后，那个文件夹不会自己出现在项目列表里。
// 与其让用户自己去翻路径，不如扫一遍他放项目的那些目录，把没加进来的仓库列出来。
//
// 扫描范围刻意收得很紧（不是全盘扫描）：
//   · roots = 已有项目路径的**父目录**去重（+ 当前项目父目录排第一）。
//     "克隆到同一批 workspace 里"正是真实场景，所以父目录这一层就是命中率最高的地方。
//   · 只下钻**一层**（roots 的直接子目录）。已知项目的兄弟节点全在这一层，
//     再深就滑向全盘扫描，收益极低。
//   · 只看含 `.git` 的目录 —— 这一层过滤直接对上"克隆/拉取代码"的诉求，
//     不至于把 Downloads 里的杂七杂八目录也报上来。
//
// 预算与安全：
//   · 目录总量 / 时间双重预算 + 并发上限，防止某个 root 恰好是盘根时把磁盘读爆。
//   · 只 readdir + 一次 .git 存在性探测，**不读任何文件内容**，也不跑 git 命令。
//   · roots 全部来自用户自己的配置（项目清单），不是客户端传入的 —— 这个端点
//     因此没有"扫任意路径"的口子（与 /projects 那条"不接受客户端路径"的边界一致）。

import path from 'path';
import fsp from 'fs/promises';
import { canonicalProjectPath } from './projectRegistry.js';

/** 结果条数上限。推荐列表是"帮忙想起来"，不是一份需要滚很久的清单 */
export const RECOMMENDED_MAX = 50;
/** 单次扫描检查的目录总量预算（roots 的子目录之和） */
export const SCAN_MAX_DIRS = 400;
/** 单次扫描时间预算（毫秒）—— 与总量预算谁先到算谁 */
export const SCAN_TIME_BUDGET_MS = 2000;
/** 一次并发的 .git 探测数 */
export const SCAN_CONCURRENCY = 8;
/** roots 条数上限（父目录去重之后） */
export const MAX_ROOTS = 8;

/**
 * 进不去"项目"这一层的目录名（小写比较）。
 * 点目录另有统一规则（isIgnoredDirName 里判首字符），不必在这里列。
 * 这一份是"构建产物 / 依赖 / 系统缓存"——它们即使带 .git（子模块残留之类）也不该被推荐。
 */
const IGNORED_DIR_NAMES = new Set([
  'node_modules', 'bower_components', 'jspm_packages', '.pnpm-store', '.yarn',
  'dist', 'build', 'out', 'output', 'target', 'coverage', 'release', 'debug',
  'bin', 'obj', 'vendor', 'packages-cache',
  '__pycache__', '.venv', 'venv', 'virtualenv', 'site-packages', 'eggs',
  '.next', '.nuxt', '.svelte-kit', '.angular', '.parcel-cache', '.cache', '.gradle',
  '.idea', '.vscode', '.terraform', '.serverless', '.turbo', '.nx',
  'tmp', 'temp', 'cache', 'caches', 'logs',
  '$recycle.bin', 'system volume information', 'appdata', 'application data',
  'local settings', 'recovery', 'windows', 'program files', 'program files (x86)',
  'programdata', 'perflogs', 'msocache', 'intel', 'nvidia',
]);

/** 目录名是否应当被跳过：点目录（含 .git 本身）+ 上面那张名单 */
export function isIgnoredDirName(name) {
  if (typeof name !== 'string' || !name) return true;
  if (name.startsWith('.')) return true;
  return IGNORED_DIR_NAMES.has(name.toLowerCase());
}

/** 把一串路径归一成 key 集合（忽略空值，幂等） */
function toKeySet(list) {
  const set = new Set();
  for (const item of list || []) {
    const key = canonicalProjectPath(item);
    if (key) set.add(key);
  }
  return set;
}

/**
 * 从已知项目路径推出扫描根目录。
 *
 * 取**父目录**而不是项目目录本身：我们要找的是"还没加进清单的项目"，
 * 它们最可能出现在已知项目的旁边（同一个 github_workspace / flowrepos 目录下）。
 *
 * @param {string[]} knownPaths  项目清单里的路径（buildProjectEntries 的 path）
 * @param {string}   [currentPath] 应用当前所在项目 —— 它的父目录排第一
 * @returns {string[]} 去重后的扫描根（最多 MAX_ROOTS 条）
 */
export function buildRecommendRoots(knownPaths = [], currentPath = '') {
  const out = [];
  const seen = new Set();
  const push = (p) => {
    if (typeof p !== 'string' || !p.trim()) return;
    const parent = path.dirname(p.trim());
    // 盘根没有"父目录"这一说（dirname('d:\\') === 'd:\\'），扫它等于全盘扫描
    if (!parent || parent === path.dirname(parent)) return;
    const key = canonicalProjectPath(parent);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(parent);
  };

  // 当前项目的父目录优先 —— 用户正在这个项目里干活，"旁边刚克隆的仓库"最可能是他想加的
  push(currentPath);
  for (const p of knownPaths || []) push(p);
  return out.slice(0, MAX_ROOTS);
}

/**
 * 扫一层目录，挑出"含 .git 且不在清单里"的目录。
 *
 * @param {object} input
 * @param {string[]} input.roots       扫描根（buildRecommendRoots 的产物）
 * @param {Iterable<string>} input.knownKeys   已在清单里的 key
 * @param {Iterable<string>} [input.hiddenKeys] 用户显式移除过的 key —— 不推荐回来
 * @param {number} [input.maxDirs]     覆盖目录总量预算（测试用）
 * @param {number} [input.timeBudgetMs] 覆盖时间预算（测试用）
 * @returns {Promise<Array<{path: string, name: string, mtime: number}>>} 按 mtime 倒序
 */
export async function scanRecommendedProjects({
  roots = [],
  knownKeys,
  hiddenKeys,
  maxDirs = SCAN_MAX_DIRS,
  timeBudgetMs = SCAN_TIME_BUDGET_MS,
} = {}) {
  // 两侧都过一遍 canonicalProjectPath：清单里存的是归一后的 key，而调用方（以及测试）
  // 递进来的可能是原始写法的小写盘符路径 —— 只在候选那侧归一会让"同一个目录两种写法"
  // 漏成一条假的推荐。归一本身是幂等的纯字符串操作，多做一遍没有副作用。
  const known = toKeySet(knownKeys);
  const hidden = toKeySet(hiddenKeys);
  const deadline = Date.now() + timeBudgetMs;
  const results = [];

  const rootList = (Array.isArray(roots) ? roots : []).slice(0, MAX_ROOTS);
  // 先把每个 root 的一层目录读出来（root 本身 ≤ MAX_ROOTS 个，直接并发）
  const childLists = await Promise.all(rootList.map(async (root) => {
    try {
      return await fsp.readdir(root, { withFileTypes: true });
    } catch {
      return []; // 读不动（权限 / 已删除）就当它是空的，不影响别的 root
    }
  }));

  const candidates = [];
  for (let i = 0; i < rootList.length; i++) {
    for (const item of childLists[i]) {
      // isDirectory() 对符号链接目录为 false —— 顺带把软链接环挡掉了，不必再单独判
      if (!item.isDirectory()) continue;
      if (isIgnoredDirName(item.name)) continue;
      candidates.push({ dir: path.join(rootList[i], item.name), name: item.name });
    }
  }

  let cursor = 0;
  let visited = 0;
  let exhausted = false;

  async function worker() {
    while (true) {
      if (exhausted) return;
      if (visited >= maxDirs) { exhausted = true; return; }
      if (Date.now() > deadline) { exhausted = true; return; }
      const index = cursor;
      cursor += 1;
      if (index >= candidates.length) return;
      visited += 1;

      const { dir, name } = candidates[index];
      const key = canonicalProjectPath(dir);
      if (!key || known.has(key) || hidden.has(key)) continue;

      let isRepo = false;
      try {
        await fsp.access(path.join(dir, '.git'));
        isRepo = true;
      } catch {
        isRepo = false;
      }
      if (!isRepo) continue;

      let mtime = 0;
      try {
        mtime = (await fsp.stat(dir)).mtimeMs;
      } catch {
        mtime = 0;
      }
      results.push({ path: dir, name, mtime });
    }
  }

  const workerCount = Math.max(1, Math.min(SCAN_CONCURRENCY, candidates.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  results.sort((a, b) => (b.mtime - a.mtime) || a.name.localeCompare(b.name));
  return results.slice(0, RECOMMENDED_MAX);
}

export const __testables = { isIgnoredDirName, buildRecommendRoots, scanRecommendedProjects };

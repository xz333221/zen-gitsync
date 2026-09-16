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
// 批量探测目录的 Git 状态(是不是仓库 / 有没有未提交改动)。
//
// 用途:「最近项目」「常用目录」列表要在卡片上标出 Git 状态,列表里可能有十几个目录,
// 因此这里做三件事:
//   1. 每个目录只跑**一次** git(status 成功即说明是仓库,失败即非仓库),
//      避免 rev-parse + status 两次 spawn;
//   2. 并发上限 + 单目录超时,别让某个大仓库(或网络盘)拖死整个请求;
//   3. 结果短 TTL 缓存,弹窗反复打开不必重复扫盘。
//
// 不用 src/utils/index.js 的 execGitCommand:那个函数固定跑在当前项目 cwd,
// 且会把每次调用写进命令历史和 socket 广播 —— 探测十几个无关目录不该污染这些。
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';

/** 单目录 git status 超时。大仓库 status 通常 <300ms,5s 已是宽容上限 */
export const DEFAULT_PROBE_TIMEOUT_MS = 5000;
/** 结果缓存 TTL。用户连续开几次弹窗时命中缓存,不必重复扫盘 */
export const DEFAULT_CACHE_TTL_MS = 15000;
/** 并发上限:并发开满会在慢盘/大仓库上互相抢 IO,4 是实测比较稳的值 */
export const DEFAULT_CONCURRENCY = 4;

const MAX_BUFFER = 8 * 1024 * 1024;
const cache = new Map(); // key: normalizeDirKey(path) → { ts, state }

/**
 * 路径缓存键。Windows 上同一目录可能以 `D:/x`、`d:\x`、`d:\x\` 多种写法出现,
 * 统一成小写 + 正斜杠 + 去尾斜杠,避免同一目录缓存成多份。
 */
export function normalizeDirKey(dirPath) {
  return String(dirPath || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 空状态(非仓库 / 探测失败时复用),避免各处手写零值 */
function emptyState(extra = {}) {
  return { exists: true, isGitRepo: false, changed: 0, staged: 0, unstaged: 0, untracked: 0, ...extra };
}

/**
 * 解析 `git status --porcelain=v1` 输出 → 计数。
 * 纯函数,单测覆盖。
 *
 * 格式:`XY path`,X=暂存区状态,Y=工作区状态。
 *   - `??` → 未跟踪
 *   - `!!` → 被忽略(porcelain 默认不输出,防御性跳过)
 *   - 其余非空位 → 计入暂存/未暂存(冲突如 `UU` 会同时计入两边)
 * `changed` 按**条目数**数,所以"已暂存又被修改"的文件只算 1 个,不重复计数。
 */
export function parsePorcelainStatus(stdout) {
  const result = { changed: 0, staged: 0, unstaged: 0, untracked: 0 };
  for (const rawLine of String(stdout || '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.length < 3) continue;
    const x = line[0];
    const y = line[1];
    if (x === '!' && y === '!') continue;
    if (x === '?' && y === '?') {
      result.untracked += 1;
    } else {
      if (x !== ' ' && x !== '?') result.staged += 1;
      if (y !== ' ' && y !== '?') result.unstaged += 1;
    }
    result.changed += 1;
  }
  return result;
}

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * 探测单个目录。
 * 返回 isGitRepo:true|false|null  —— null 表示"没探到"(超时/权限等),
 * 前端对 null 不显示任何 Git 标记,避免把未知谎报成"非仓库"。
 */
export async function probeDirectoryGitState(dirPath, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  try {
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) return emptyState({ exists: false });
  } catch {
    return emptyState({ exists: false });
  }

  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        '-C', dirPath,
        // --no-optional-locks:纯读探测不抢 index.lock,避免和用户正在跑的 git 操作打架
        '--no-optional-locks',
        'status',
        '--porcelain=v1',
        // normal 会把未跟踪目录折叠成一条,大目录(node_modules 之类)下比 all 快很多,
        // 而这里只需要"有没有 / 有几项"
        '--untracked-files=normal',
      ],
      {
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        env: {
          ...process.env,
          // 与 execGitCommand 保持一致:关闭路径转义,避免中文/空格路径变成 \xxx 八进制
          GIT_CONFIG_PARAMETERS: "'core.quotepath=false'",
        },
      }
    );
    return { exists: true, isGitRepo: true, ...parsePorcelainStatus(stdout) };
  } catch (error) {
    const text = `${error?.stderr || ''}\n${error?.message || ''}`;
    if (/not a git repository|not a git repo/i.test(text)) {
      // 目录存在但不是仓库:明确回答"不是",不算错误
      return emptyState();
    }
    // 超时 / 权限 / git 不存在等 —— 状态未知
    return emptyState({ isGitRepo: null, error: String(error?.message || error).split('\n')[0] });
  }
}

/** 以固定并发跑完所有任务,保持入参顺序输出 */
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

/**
 * 批量探测。返回 `{ [原始路径]: state }` —— 键用调用方传入的原始字符串,
 * 前端可以直接 `states[item.path]` 取,不必关心后端的归一化规则。
 *
 * @param {string[]} paths
 * @param {{ timeoutMs?: number, ttlMs?: number, concurrency?: number, useCache?: boolean }} [options]
 */
export async function probeDirectoryGitStates(paths, options = {}) {
  const {
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    ttlMs = DEFAULT_CACHE_TTL_MS,
    concurrency = DEFAULT_CONCURRENCY,
    useCache = true,
  } = options;

  const list = Array.isArray(paths) ? paths.filter(p => typeof p === 'string' && p.trim()) : [];
  const results = {};
  const pending = [];
  const now = Date.now();

  for (const original of list) {
    if (Object.prototype.hasOwnProperty.call(results, original)) continue; // 重复路径只探一次
    const key = normalizeDirKey(original);
    const hit = useCache ? cache.get(key) : undefined;
    if (hit && now - hit.ts < ttlMs) {
      results[original] = hit.state;
      continue;
    }
    pending.push({ key, original });
  }

  const probed = await runWithConcurrency(pending, concurrency, async ({ key, original }) => {
    const state = await probeDirectoryGitState(original, { timeoutMs });
    return { key, original, state };
  });

  for (const { key, original, state } of probed) {
    if (state.isGitRepo !== null) {
      // 只有确定的结果才缓存:超时/未知下次还要再试
      cache.set(key, { ts: Date.now(), state });
    }
    results[original] = state;
  }

  return results;
}

/** 仅供测试:清空缓存 */
export function clearGitStateCache() {
  cache.clear();
}

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
// 批量探测目录的 Git 状态(是不是仓库 / 有没有未提交改动 / 与上游差多少)。
//
// 用途:「最近项目」「常用目录」列表要在卡片上标出 Git 状态,列表里可能有十几个目录,
// 因此这里做四件事:
//   1. 每个目录只跑**一次** git(status 成功即说明是仓库,失败即非仓库),
//      并用 --branch 顺带拿到分支与领先/落后,避免额外 3 次 spawn;
//   2. 并发上限 + 单目录超时,别让某个大仓库(或网络盘)拖死整个请求;
//   3. 结果短 TTL 缓存,弹窗反复打开不必重复扫盘;
//   4. 领先/落后只读**本地 remote-tracking 引用,不联网 fetch** —— 探测十几个目录
//      去联网是不可接受的;口径与应用里那条「你的分支落后」提示一致。
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
  return {
    exists: true,
    isGitRepo: false,
    // 工作区计数
    changed: 0, staged: 0, unstaged: 0, untracked: 0,
    // 分支与上游跟踪
    branch: null, upstream: null, hasUpstream: false, detached: false, ahead: 0, behind: 0,
    ...extra,
  };
}

/**
 * 解析 `git status --porcelain=v1` 输出 → 工作区计数。
 * 纯函数,单测覆盖。
 *
 * 格式:`XY path`,X=暂存区状态,Y=工作区状态。
 *   - `## ...` → 分支头(见 parseBranchTracking),**不计入改动**
 *   - `??` → 未跟踪
 *   - `!!` → 被忽略(porcelain 默认不输出,防御性跳过)
 *   - 其余非空位 → 计入暂存/未暂存(冲突如 `UU` 会同时计入两边)
 * `changed` 按**条目数**数,所以"已暂存又被修改"的文件只算 1 个,不重复计数。
 */
export function parsePorcelainStatus(stdout) {
  const result = { changed: 0, staged: 0, unstaged: 0, untracked: 0 };
  for (const rawLine of String(stdout || '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    // 必须显式跳过分支头:`## main...origin/main` 的前两个字符是 `#`,
    // 既不是 `!!` 也不是 `??`,漏掉会把它算成 1 个"已暂存 + 未暂存"的文件。
    if (line.startsWith('##')) continue;
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

/**
 * 解析 `git status --porcelain=v1 --branch` 的 `##` 头 → 分支与领先/落后。
 * 纯函数,单测覆盖。
 *
 * 见过的几种形状:
 *   `## main...origin/main [ahead 1, behind 2]`  有上游且有差异
 *   `## main...origin/main`                     有上游且同步
 *   `## main...origin/main [gone]`              上游被删了(ahead/behind 无意义)
 *   `## main`                                   有分支但没设上游
 *   `## HEAD (no branch)`                       分离 HEAD
 *   `## No commits yet on main`                 空仓库(老 git 是 `## Initial commit on main`)
 *
 * 领先/落后取自**本地 remote-tracking 引用**,不联网 fetch —— 与应用里那条
 * 「你的分支落后 'origin/develop' 17 个提交」同一口径(都基于上次 fetch 的结果)。
 */
export function parseBranchTracking(stdout) {
  const result = { branch: null, upstream: null, hasUpstream: false, detached: false, ahead: 0, behind: 0 };
  const headLine = String(stdout || '')
    .split('\n')
    .map(l => l.replace(/\r$/, ''))
    .find(l => l.startsWith('## '));
  if (!headLine) return result;

  let head = headLine.slice(3).trim();
  // 跟踪信息固定在末尾方括号里,先摘掉再拆分支名(分支名里不可能出现 `[`)
  const bracket = head.match(/\s+\[(.+)\]$/);
  let tracking = '';
  if (bracket) {
    tracking = bracket[1];
    head = head.slice(0, head.length - bracket[0].length).trim();
  }

  if (/^HEAD \(no branch\)/.test(head)) {
    result.detached = true;
    return result;
  }

  const fresh = head.match(/^(?:No commits yet on|Initial commit on)\s+(.+)$/);
  if (fresh) {
    result.branch = fresh[1].trim();
    return result;
  }

  // git 的 ref 命名规则禁止 `..`,所以 `...` 只会是分隔符
  const sep = head.indexOf('...');
  if (sep === -1) {
    result.branch = head;
  } else {
    result.branch = head.slice(0, sep);
    result.upstream = head.slice(sep + 3);
    // [gone] 表示上游引用已不存在,这时不算"有上游可比较"
    result.hasUpstream = !/gone/.test(tracking);
  }

  const ahead = tracking.match(/ahead (\d+)/);
  const behind = tracking.match(/behind (\d+)/);
  if (ahead) result.ahead = Number(ahead[1]);
  if (behind) result.behind = Number(behind[1]);

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
        // --branch 让 status 顺带输出 `## main...origin/main [ahead 1, behind 2]`,
        // 领先/落后就白拿 —— 否则要再起 3 个进程(symbolic-ref + rev-parse @{u} + rev-list)。
        // 只读本地 remote-tracking 引用,**不联网**。
        '--branch',
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
    return {
      exists: true,
      isGitRepo: true,
      ...parsePorcelainStatus(stdout),
      ...parseBranchTracking(stdout),
    };
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

/**
 * 探测单个目录的 origin 远程地址。
 *
 * 用途:远程仓库列表要回答"这个仓库本地已经克隆过了吗" —— 判据只能是本地
 * 某个目录的 origin 指向谁。口径与 probeDirectoryGitState 一致:一次 spawn、
 * 超时即放弃、**不联网**(`git remote get-url` 只读 .git/config,不发请求)。
 *
 * 非仓库、目录不存在、没有名为 origin 的 remote 都是失败(退出码非 0)——
 * 统一收敛成 null:对"是不是克隆来的"这个问题,这些情况的答案都是"不知道/不是",
 * 调用方不需要区分。
 */
export async function probeDirectoryOrigin(dirPath, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', dirPath, 'remote', 'get-url', 'origin'],
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true }
    );
    const url = String(stdout || '').trim();
    return url || null;
  } catch {
    return null;
  }
}

/**
 * 批量探测 origin 地址。返回 `{ [调用方传入的原始路径]: url|null }`
 * —— 键用原始字符串,前端可以直接 `origins[item.path]` 取。
 *
 * 为什么不做缓存(同一个文件里 git 状态就有 15s TTL):remote 是用户随时在改的
 * 东西(刚加了 remote、刚把地址换成 SSH),缓存只会让「已克隆」这个标识慢半拍地
 * 骗人;而调用方只有仓库列表挂载时那一次请求,重复扫的代价可以忽略。
 */
export async function probeDirectoryOrigins(paths, options = {}) {
  const { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, concurrency = DEFAULT_CONCURRENCY } = options;
  const list = Array.isArray(paths) ? paths.filter(p => typeof p === 'string' && p.trim()) : [];
  // 同一个目录可能以不同写法出现在配置里,先按原始串去重再探(normalizeDirKey
  // 会把 `D:/x` 与 `d:\x\` 合并,但这里要保持"键用原始串"的约定)
  const unique = [...new Set(list)];
  const results = {};

  const probed = await runWithConcurrency(unique, concurrency, async (dir) => ({
    dir,
    url: await probeDirectoryOrigin(dir, { timeoutMs }),
  }));
  for (const { dir, url } of probed) results[dir] = url;
  return results;
}

/** 仅供测试:清空缓存 */
export function clearGitStateCache() {
  cache.clear();
}

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
//      唯一的例外是"没配远程仓库"这一条(见 hasRemote),它只在 status 没能
//      给出上游时才补一次 `git remote`,不在常见路径上;
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
/**
 * 缓存条目上限。目录数量本身不多,但路径写法、临时目录、已删项目会一直累积,
 * 而这份缓存的失效只靠 TTL —— TTL 只影响"读不算旧",不负责清理。
 * 给个硬上限 + 插入序淘汰(Map 保持插入顺序,set 前先 delete 就是 LRU 序),
 * 让它有界。
 */
export const MAX_CACHE_ENTRIES = 512;

const MAX_BUFFER = 8 * 1024 * 1024;
const cache = new Map(); // key: normalizeDirKey(path) → { ts, state }
/**
 * 正在探测中的目录:key → Promise<state>。
 *
 * 为什么需要它:同一次扫描可能被多个轮询器**同拍**触发 ——
 * 工作台 5s、项目管理 10s 打的是同一个 `/api/workbench/projects`,
 * 两者都落到 listProjects → probeDirectoryGitStates。没有这一层时,
 * 缓存未命中的那一拍会各自 spawn 一整套 git(每个目录一个进程 + 一个 conhost),
 * 明明是同一个目录、同一瞬间,却把进程 churn 翻倍。
 * 有了它,后到的调用直接复用前一个的 Promise,一个目录同一时刻只跑一个 git。
 */
const inflight = new Map();

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
    // hasRemote: true=配了 remote / false=一个都没配 / null=没探到(超时等)。
    // 列表卡片据此挂「未配远程」徽标 —— null 不挂,不把未知谎报成"没配"。
    hasRemote: false,
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
 * 探测单个目录的实际实现(不做单飞合并,只由 probeDirectoryGitState 调用)。
 * 返回 isGitRepo:true|false|null  —— null 表示"没探到"(超时/权限等),
 * 前端对 null 不显示任何 Git 标记,避免把未知谎报成"非仓库"。
 */
async function probeDirectoryGitStateUncoalesced(dirPath, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
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
    const tracking = parseBranchTracking(stdout);
    // 「有没有配远程仓库」:有上游(`origin/main` 这种)就说明 remote 一定在,
    // 不必再起进程;没有上游时才补跑一次 `git remote` —— 列表里十个仓库
    // 九个都有上游,这一条因此不在常见路径上。
    // 注意第二个参数是**选项对象**不是数字:早先这里直接传了 `timeoutMs`,
    // 被 `{ timeoutMs = DEFAULT } = {}` 解构后拿到 undefined,自定义超时静默失效。
    const hasRemote = tracking.hasUpstream ? true : await probeHasRemote(dirPath, { timeoutMs });
    return {
      exists: true,
      isGitRepo: true,
      ...parsePorcelainStatus(stdout),
      ...tracking,
      hasRemote,
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

/**
 * 探测单个目录(带同拍合并)。
 *
 * 同一目录在同一时刻只会有一个 git 进程在跑:并发调用方拿到的是**同一个 Promise**,
 * 而不是各自去 spawn。缓存未命中的那一拍常有两三个轮询器同时到达(5s / 10s 的拍点
 * 在 10 的倍数上重合),不合并就是白白多出几倍进程 —— 这些进程每个都带一个 conhost,
 * 也是任务管理器里 conhost 数量不断堆积的来源。
 *
 * 复用 inflight 不会让调用方拿到"旧数据":条目只在这一个探测的生命周期内存在
 * (最长 timeoutMs,默认 5s),结束即删。所以 `useCache:false` 的强制刷新也一样可以
 * 走合并 —— 它要的是"现在这一刻的真实状态",而正在跑的那次探测给出的正是这个。
 */
export async function probeDirectoryGitState(dirPath, options = {}) {
  const key = normalizeDirKey(dirPath);
  const running = inflight.get(key);
  if (running) return running;

  const task = probeDirectoryGitStateUncoalesced(dirPath, options);
  inflight.set(key, task);
  try {
    return await task;
  } finally {
    // 只删自己那一条:理论上不会有人覆盖,但判断一下免得未来改动踩到
    if (inflight.get(key) === task) inflight.delete(key);
  }
}

/**
 * 这个仓库配了 remote 吗?
 *
 * 与 probeDirectoryGitState 同口径:一次 spawn、超时即放弃、**不联网**
 * (`git remote` 只读 .git/config,不请求远端)。
 *
 * 三态:true=至少有一个 / false=一个都没配 / null=没探到(超时、git 不存在等)。
 * null 不能塌成 false —— 列表卡片要靠它决定挂不挂「未配远程」徽标,
 * 把"没探到"说成"没配"就是谎报。
 *
 * 已知是仓库时调用;非仓库也会直接失败并返回 null,不会给出错误的 false。
 */
export async function probeHasRemote(dirPath, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', dirPath, 'remote'],
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true }
    );
    // 有输出就是有 remote(每个 remote 一行);空输出 = 一个都没配
    return String(stdout || '').trim().length > 0;
  } catch (error) {
    const text = `${error?.stderr || ''}\n${error?.message || ''}`;
    // 不是仓库是明确答案(不是"没探到"),返回 false 让调用方不必再判 isGitRepo
    if (/not a git repository|not a git repo/i.test(text)) return false;
    return null;
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
 * 写缓存:先 delete 再 set,让 Map 的插入顺序始终等于"最近使用顺序",
 * 超上限时从头部(最久没被写入的)淘汰。
 *
 * 只用 TTL 管理这份缓存是不够的:TTL 决定"读到的算不算旧",不负责回收,
 * 于是一年内见过的每个目录都会留一条记录。条目本身不大,但它是**常驻**的,
 * 配合前端 5s 轮询看起来就是"内存慢慢往上爬"。
 */
function writeCache(key, state, limit = MAX_CACHE_ENTRIES) {
  cache.delete(key);
  cache.set(key, { ts: Date.now(), state });
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * 批量探测。返回 `{ [原始路径]: state }` —— 键用调用方传入的原始字符串,
 * 前端可以直接 `states[item.path]` 取,不必关心后端的归一化规则。
 *
 * @param {string[]} paths
 * @param {{ timeoutMs?: number, ttlMs?: number, concurrency?: number, useCache?: boolean, maxCacheEntries?: number }} [options]
 */
export async function probeDirectoryGitStates(paths, options = {}) {
  const {
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    ttlMs = DEFAULT_CACHE_TTL_MS,
    concurrency = DEFAULT_CONCURRENCY,
    useCache = true,
    maxCacheEntries = MAX_CACHE_ENTRIES,
  } = options;

  const list = Array.isArray(paths) ? paths.filter(p => typeof p === 'string' && p.trim()) : [];
  const results = {};
  const pending = [];
  /** key → 已排队的探测条目。同一目录的不同写法(`D:/x` 与 `d:\x\`)合并成一次 spawn */
  const queued = new Map();
  const now = Date.now();

  for (const original of list) {
    if (Object.prototype.hasOwnProperty.call(results, original)) continue; // 重复路径只探一次
    const key = normalizeDirKey(original);
    if (useCache) {
      const hit = cache.get(key);
      if (hit && now - hit.ts < ttlMs) {
        results[original] = hit.state;
        continue;
      }
    }
    const existing = queued.get(key);
    if (existing) {
      existing.originals.push(original);
      continue;
    }
    const entry = { key, original, originals: [original] };
    queued.set(key, entry);
    pending.push(entry);
  }

  const probed = await runWithConcurrency(pending, concurrency, async (entry) => {
    const state = await probeDirectoryGitState(entry.original, { timeoutMs });
    return { ...entry, state };
  });

  for (const { key, originals, state } of probed) {
    // 只有确定的结果才缓存:超时/未知下次还要再试
    if (state.isGitRepo !== null) writeCache(key, state, maxCacheEntries);
    // 同一目录的各种写法都拿到同一份结果(前端按原始串取)
    for (const original of originals) results[original] = state;
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

/** 当前缓存条数。诊断与单测用:这份缓存是常驻的,有界才敢说"不会慢慢涨" */
export function getGitStateCacheSize() {
  return cache.size;
}

/** 仅供测试:清空缓存与在途记录 */
export function clearGitStateCache() {
  cache.clear();
  inflight.clear();
}

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
// 对「最近项目」里的**一个**目录执行 git fetch，把卡片上「领先/落后」徽标
// 从"上次 fetch 时的快照"拉回真实状态。
//
// 为什么单独一个模块，不塞进 directoryGitState.js:
//   那个模块的契约是「纯读探测、不联网」（见其文件头注释）。fetch 是网络操作，
//   混进去会让"探测十几个目录"这条路径随时可能变成十几个网络请求 ——
//   那是它当初刻意避开的坑，不能在同一个文件里再挖回来。
//
// 为什么一次只处理一个目录、并发交给调用方:
//   列表里十几个仓库同时联网会互相抢网络与代理，也更容易撞出一堆凭据提示。
//   拆成单目录请求后，每个请求的耗时被**单个超时**箍住（不会出现一挂两分钟、
//   还看不到进度的大请求），前端也能每完成一个项目就地更新那张卡片的徽标。
//
// 绝不能停在交互式凭据提示上（这是批量动作，卡一个仓库就卡掉整轮刷新）:
//   - GIT_TERMINAL_PROMPT=0  让 git 直接失败，而不是在终端上等人输密码
//   - GIT_SSH_COMMAND 注入 BatchMode=yes，让 ssh 的 passphrase 也变成明确报错；
//     用户自己设过 GIT_SSH_COMMAND 就不动他的（那可能是他的跳板机/密钥配置）
//   两者叠加的效果是：需要认证又没存凭据的仓库会**快速失败**并回报一句人话，
//   而不是留下一个永远不返回的进程。
//
// 不做的事:
//   - 不加 --prune：prune 与否跟随仓库/全局的 fetch.prune 配置（与应用里
//     「Git Fetch All」按钮同口径），不在这里替用户改口径。
//   - 不走 execGitCommand：那个函数固定跑在当前项目 cwd，还会写命令历史并
//     广播 socket —— 刷新十几个无关目录不该污染当前项目的命令历史。
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { normalizeDirKey } from './directoryGitState.js';

/** 单个目录 fetch 的超时。网络操作，比 status 那 5s 宽松得多 */
export const DEFAULT_FETCH_TIMEOUT_MS = 30000;

/** fetch 结果状态 */
export const FETCH_STATUS = {
  OK: 'ok',
  SKIPPED: 'skipped',
  FAILED: 'failed',
};

/** 跳过原因（都不算错误，前端只用于计数与排障） */
export const SKIP_REASON = {
  /** 目录不存在（或不是目录） */
  MISSING: 'missing',
  /** 目录存在但不是 Git 仓库 */
  NOT_A_REPO: 'not-a-repo',
  /** 是仓库但一个 remote 都没配 —— fetch 无事可做 */
  NO_REMOTE: 'no-remote',
  /** 同一目录已有一轮 fetch 在进行中（多标签页/重复点击） */
  IN_FLIGHT: 'in-flight',
};

const MAX_BUFFER = 4 * 1024 * 1024;
/** 报错只回第一行、并截断到这个长度：tooltip 里塞整份 git 输出没法看 */
const ERROR_LINE_MAX = 200;

/**
 * 正在 fetch 的目录集合（normalizeDirKey 形式）。
 *
 * 为什么需要它：git fetch 之间会抢 `.git/FETCH_HEAD.lock`，后到的会以
 * "Unable to create '.../FETCH_HEAD.lock': File exists" 失败 ——
 * 用户看到的就是一条莫名其妙的"刷新失败"。前端按钮本身就防了重复点击，
 * 这里防的是多标签页/多实例同时刷同一个项目。
 */
const inFlight = new Set();

/** 判定 git 的失败输出是否属于"这不是个仓库"（与 directoryGitState 同口径） */
export function isNotARepoMessage(text) {
  return /not a git repository|not a git repo/i.test(String(text || ''));
}

/**
 * 取 git 输出的第一行有效内容。
 * git 的 stderr 里混着以 \r 结尾的进度条（"Receiving objects: 42%"）和多行提示，
 * 整份塞进 tooltip 没法读，所以要按 \r 和 \n **都**拆行。
 */
export function firstErrorLine(text, maxLen = ERROR_LINE_MAX) {
  const lines = String(text || '')
    .split(/[\r\n]+/)
    .map(l => l.trim())
    .filter(Boolean);
  const line = lines[0] || '';
  return line.length > maxLen ? `${line.slice(0, maxLen)}…` : line;
}

/**
 * fetch 子进程的环境变量。纯函数，单测覆盖。
 *
 * GIT_CONFIG_PARAMETERS 与目录状态探测保持一致（关闭路径转义，否则中文/空格
 * 路径在报错里会变成 \xxx 八进制，用户没法对着看）。
 */
export function buildFetchEnv(baseEnv = process.env) {
  const env = {
    ...baseEnv,
    GIT_CONFIG_PARAMETERS: "'core.quotepath=false'",
    GIT_TERMINAL_PROMPT: '0',
  };
  if (!baseEnv.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = 'ssh -oBatchMode=yes';
  return env;
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

function runGit(args, timeoutMs) {
  return execFileAsync('git', args, {
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    env: buildFetchEnv(process.env),
  });
}

/** 把 catch 到的子进程错误压成一句能在 tooltip 里显示的话 */
export function describeFetchError(error, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  if (error?.killed || error?.signal) {
    // 超时的话，git 自己不会说什么有用的 —— 由前端把 timeout 翻成本地化文案
    return { error: `git fetch timed out after ${Math.round(timeoutMs / 1000)}s`, timeout: true };
  }
  const text = `${error?.stderr || ''}\n${error?.message || ''}`;
  if (isNotARepoMessage(text)) return { error: 'not a git repository' };
  return { error: firstErrorLine(error?.stderr) || firstErrorLine(error?.message) || 'git fetch failed' };
}

/**
 * 对单个目录执行 `git fetch --all`。
 *
 * @param {string} dirPath
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ status: 'ok'|'skipped'|'failed', reason?: string, error?: string, timeout?: boolean, timeoutSeconds?: number }>}
 *   只有 ok / skipped / failed 三种终态，**不抛异常** ——
 *   列表里一个仓库失败不该让整轮刷新中断。
 */
export async function fetchDirectoryRemotes(dirPath, { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) {
  const dir = String(dirPath || '').trim();
  if (!dir) return { status: FETCH_STATUS.SKIPPED, reason: SKIP_REASON.MISSING };

  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return { status: FETCH_STATUS.SKIPPED, reason: SKIP_REASON.MISSING };
  } catch {
    return { status: FETCH_STATUS.SKIPPED, reason: SKIP_REASON.MISSING };
  }

  const key = normalizeDirKey(dir);
  if (inFlight.has(key)) return { status: FETCH_STATUS.SKIPPED, reason: SKIP_REASON.IN_FLIGHT };
  inFlight.add(key);

  try {
    // 先问一句"有哪些 remote"：一次纯本地读，就能区分三种不需要联网的情况
    // （不是仓库 / 没配 remote / 正常该 fetch），避免对非仓库目录发起网络请求。
    let remotesStdout = '';
    try {
      ({ stdout: remotesStdout } = await runGit(['-C', dir, 'remote'], timeoutMs));
    } catch (error) {
      const text = `${error?.stderr || ''}\n${error?.message || ''}`;
      if (isNotARepoMessage(text)) return { status: FETCH_STATUS.SKIPPED, reason: SKIP_REASON.NOT_A_REPO };
      const described = describeFetchError(error, timeoutMs);
      return { status: FETCH_STATUS.FAILED, ...described, timeoutSeconds: described.timeout ? Math.round(timeoutMs / 1000) : undefined };
    }
    if (!String(remotesStdout || '').trim()) {
      return { status: FETCH_STATUS.SKIPPED, reason: SKIP_REASON.NO_REMOTE };
    }

    try {
      // --no-optional-locks：不抢 index.lock，不打扰用户正在跑的 git 操作
      await runGit(['-C', dir, '--no-optional-locks', 'fetch', '--all'], timeoutMs);
      return { status: FETCH_STATUS.OK };
    } catch (error) {
      const described = describeFetchError(error, timeoutMs);
      return {
        status: FETCH_STATUS.FAILED,
        ...described,
        timeoutSeconds: described.timeout ? Math.round(timeoutMs / 1000) : undefined,
      };
    }
  } finally {
    inFlight.delete(key);
  }
}

/** 仅供测试：清空 in-flight 标记 */
export function clearFetchInFlight() {
  inFlight.clear();
}

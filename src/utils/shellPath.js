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
// ─────────────────────────────────────────────────────────────────────────────
// Windows 上「进程 PATH 快照过期」的统一修补层。
//
// 问题：安装器（winget / MSI / brew 等）改的是**注册表里的 PATH**，而已经跑起来的
// node 进程持有的是启动那一刻的环境块快照 —— 它不会自己更新。典型表现（2026-09-22 实测）：
// 用户在 GUI 里一键装完 gh，探测侧能找到（因为探测会读注册表兜底），但真去执行
// `cmd /c gh auth login` 时照样报「'gh' 不是内部或外部命令」。
//
// 当时先打的补丁是「登录接口显式传 pathDirs」—— 那只救了一个入口。同样的病在
// run_command（智能体）、/api/exec-stream、socket 交互式执行、以及"另起一个终端窗口"
// 这些地方全都存在。所以统一收在这里：**把注册表 Machine + User 的 PATH 里
// 「当前进程没有的目录」补到子进程的 PATH 上**，语义等价于"这个进程是现在才启动的"。
//
// 为什么补在**末尾**而不是像 pathDirs 那样前置：
//   PATH 的语义是「先命中先赢」。注册表 PATH 是当前进程 PATH 的**超集** ——
//   进程启动后新装的目录在注册表里有、进程里没有；反过来进程里多出来的是启动后
//   被卸载的目录。只把缺的补在末尾，原有目录的优先级顺序一个都没动，等于把快照
//   更新到最新；若前置，反而会改掉用户既有的解析顺序（让某个兜底目录抢在正主前面）。
//   fileOpen.launchCommandInTerminal 的 pathDirs 前置是对的，因为那是另一种语义：
//   "我已经知道要跑的就是这个绝对路径，把它优先"。
//
// 为什么每次都重新比对、而不是"补一次就完"：
//   用户可能在同一个进程会话里接着装第二个 CLI，而修补只作用于子进程的 env。
//   这里刻意**不改动 process.env**，避免影响其它模块（进程级副作用最难排查）。
//   注册表读取有 TTL 缓存，正常路径零额外开销；tools.js 在"命令找不到"时会
//   force 刷一次缓存重试，覆盖"刚装完、缓存还没过期"的那个窗口。
//
// 平台：仅 win32 生效。POSIX 侧的 PATH 由启动它的 shell 决定，没有"安装器改注册表"
// 这套机制，终端新装的 CLI 一般也落在已有 PATH 目录里 —— 所以那边原样返回。
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/** 注册表里两个 PATH 的宿主。缺一个都会漏装到相应作用域的 CLI：
 *  winget / MSI 默认写 Machine（HKLM），npm -g / 用户级安装器写 User（HKCU）。 */
const REG_KEY_MACHINE = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const REG_KEY_USER = 'HKCU\\Environment';

/** PATH 键名在 Windows 上大小写不定（`Path` / `PATH` 都见过，取决于父进程怎么给的）。
 *  回写时若按错大小写，环境块里会出现**两个** PATH 键，子进程取哪个是未定义的 ——
 *  于是就有了"明明前置了却没生效"的补丁。所以一律按实际存在的那个键名回写。 */
const PATH_KEY_RE = /^path$/i;

/** 注册表目录列表的缓存时长。取值考虑：短到"装完 CLI 基本立刻可用"，
 *  长到"不会每条命令都去 spawn 一次 reg.exe"（那是同步阻塞，会卡事件循环）。 */
const DEFAULT_TTL_MS = 15000;

/** @type {{ at: number, dirs: string[] }} */
let cache = { at: 0, dirs: [] };

// ── 纯函数区（都可单测，不碰进程状态） ──────────────────────────────────────

/** 找出 env 里 PATH 的实际键名；没有则返回 null。 */
export function findPathKey(env) {
  return Object.keys(env).find((key) => PATH_KEY_RE.test(key)) || null;
}

/**
 * 大小写安全地把 PATH 写回 env：只保留**一个** PATH 键（沿用原来那个键名）。
 * 返回新对象，不改入参。
 */
export function withPathValue(env, value) {
  const key = findPathKey(env) || 'PATH';
  const next = {};
  for (const k of Object.keys(env)) { if (!PATH_KEY_RE.test(k)) next[k] = env[k]; }
  next[key] = value;
  return next;
}

/** 同步取出 env 里的 PATH 值。 */
export function pathValueOf(env) {
  const key = findPathKey(env);
  return key ? String(env[key] ?? '') : '';
}

/** PATH 字符串 → 目录数组（去空白、丢空段）。分隔符按当前平台，注册表值在
 *  win32 下就是 `;`。 */
export function splitPathList(value, { delimiter = path.delimiter } = {}) {
  return String(value ?? '')
    .split(delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 比较用的归一形式：忽略大小写与结尾分隔符（`C:\Tools\` 与 `c:\tools` 是同一个）。
 *  Windows 路径这两点都必须归一 —— 只按字符串比对会把同一个目录当成新目录，
 *  于是每次修补都往 PATH 里再塞一遍。 */
function normalizeDir(dir) {
  return String(dir ?? '').trim().replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * 找出 dirs 里 currentValue 还没有的目录，保持原顺序。
 * dirs 内部也去重（Machine 与 User 的 PATH 常有重叠）。
 */
export function missingPathDirs(currentValue, dirs, options) {
  const seen = new Set(splitPathList(currentValue, options).map(normalizeDir));
  const out = [];
  for (const dir of dirs) {
    const key = normalizeDir(dir);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(String(dir).trim());
  }
  return out;
}

/** 按环境块大小写不敏感地查一个变量（%SystemRoot% 与 %systemroot% 都该命中）。
 *  展开不出来就原样保留 —— 宁可在子进程里报"路径不存在"，也不要静默删掉一段 PATH。 */
function lookupVar(env, name) {
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  const hit = Object.keys(env).find((k) => k.toLowerCase() === String(name).toLowerCase());
  return hit ? env[hit] : undefined;
}

/** 注册表 Path 里的 %USERPROFILE% / %SystemRoot% 这类变量不展开就写进子进程会失效。 */
export function expandVars(raw, env = process.env) {
  return String(raw ?? '').replace(/%([^%]+)%/g, (whole, name) => {
    const value = lookupVar(env, name);
    return value === undefined ? whole : String(value);
  });
}

/**
 * 解析 `reg query <key> /v Path` 的输出，取出 Path 的值；没有该值时返回 null。
 *
 * 输出形如（值名与类型之间是连续空白，`REG_EXPAND_SZ` 与 `REG_SZ` 都可能）：
 *     Path    REG_EXPAND_SZ    %SystemRoot%\system32;%SystemRoot%;...
 */
export function parseRegQueryPath(stdout) {
  const line = String(stdout ?? '')
    .split(/\r?\n/)
    .find((l) => /\sPath\s+REG_(?:EXPAND_)?SZ\s+/i.test(l));
  if (!line) return null;
  return line.replace(/^.*?REG_(?:EXPAND_)?SZ\s+/i, '').trim();
}

/**
 * 判断一段命令输出是否属于「这条命令本身找不到」。
 *
 * 刻意**不收** POSIX 的 "No such file or directory"：那条既可能指"命令不存在"，
 * 也可能只是 `type missing.txt` 这类**参数**文件缺失。调用方（tools.js）会据此
 * 重试一次命令，而重试对"参数缺失"是白跑、对有副作用的命令更是危险 ——
 * 所以只认能确定"整条命令没被执行过"的几种说法。
 */
export function isCommandNotFound(...parts) {
  const text = parts.filter(Boolean).join('\n');
  if (!text) return false;
  return [
    /不是内部或外部命令/,                                          // 中文 Windows cmd
    /is not recognized as an internal or external command/i,       // 英文 cmd
    /command not found/i,                                         // POSIX sh / bash
    /\bENOENT\b/,                                                 // node spawn 找不到可执行文件
  ].some((re) => re.test(text));
}

// ── 读注册表 ────────────────────────────────────────────────────────────────

async function readRegPath(regKey, { execFileFn = execFileAsync } = {}) {
  try {
    const { stdout } = await execFileFn('reg.exe', ['query', regKey, '/v', 'Path'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return parseRegQueryPath(stdout);
  } catch {
    // 键或值不存在（reg.exe 退出码 1）、被策略拦下、reg.exe 本身缺失 —— 都不该让
    // 调用方失败，按"这项没有"处理即可
    return null;
  }
}

/** 清空缓存。装了新 CLI 想立刻生效、或测试之间需要隔离时调用。 */
export function invalidatePathCache() {
  cache = { at: 0, dirs: [] };
}

/**
 * 读注册表 Machine + User 的 PATH，展开变量后返回目录数组（Machine 在前，与
 * Windows 自身的 PATH 拼接顺序一致）。
 *
 * `ttlMs: 0` 表示禁用缓存（每次都真读）；`force: true` 忽略现有缓存。
 */
export async function readRegistryPathDirs({
  platform = process.platform,
  execFileFn,
  env = process.env,
  ttlMs = DEFAULT_TTL_MS,
  force = false,
} = {}) {
  if (platform !== 'win32') return [];
  const now = Date.now();
  if (!force && ttlMs > 0 && cache.at && now - cache.at < ttlMs) return cache.dirs;

  const [machine, user] = await Promise.all([
    readRegPath(REG_KEY_MACHINE, { execFileFn }),
    readRegPath(REG_KEY_USER, { execFileFn }),
  ]);

  const dirs = [];
  const seen = new Set();
  for (const raw of [machine, user]) {
    if (!raw) continue;
    for (const dir of splitPathList(expandVars(raw, env))) {
      const key = normalizeDir(dir);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      dirs.push(dir);
    }
  }

  cache = { at: now, dirs };
  return dirs;
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

/**
 * 返回一份**补过 PATH** 的 env（新对象），语义为"这个子进程是现在才启动的"。
 *
 * 已经是超集时原样返回入参（连引用都不换），调用方无需判断，直接丢给 spawn 即可。
 * 非 win32 一律原样返回。
 */
export async function augmentEnvPath(env = process.env, options = {}) {
  const { platform = process.platform } = options;
  if (platform !== 'win32') return env;

  const current = pathValueOf(env);
  const dirs = await readRegistryPathDirs({ ...options, env });
  const missing = missingPathDirs(current, dirs, options);
  if (!missing.length) return env;

  const merged = [...splitPathList(current, options), ...missing].join(path.delimiter);
  return withPathValue(env, merged);
}

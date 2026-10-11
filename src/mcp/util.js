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
// MCP 服务端的通用工具:读 JSON / 列目录 / 判进程存活 / 跑外部 CLI / 截断。
//
// 设计口径(与 src/cli/ai/tools.js 一致):**任何失败都变成"能读懂的字符串",不抛**。
// 一个板块读不到不该让整个 tools/call 变成异常 —— 调用方是模型,它需要的是
// "这一块现在拿不到,原因是 X",而不是一句 JSON-RPC error。
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 读一个 JSON 文件。不存在 / 坏了都回落到 fallback,不抛。 */
export async function readJsonFile(file, fallback = null) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** 读一个文本文件。失败回落 fallback。 */
export async function readTextFile(file, fallback = '') {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return fallback;
  }
}

/** 文件是否存在(只看普通文件,目录算不存在)。 */
export async function fileExists(file) {
  try {
    const stat = await fs.stat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * 列目录里"看起来是数据文件"的条目,返回绝对路径数组。
 *
 * ⚠️ 必须跳过 `.tmp` 与点开头文件:Windows 上强杀进程会留下大量半写的
 * `<name>.json.tmp`(本机 instances/ 实测 6 个),解析它们要么报错要么读到半截数据。
 * live-jobs/instances 两处的官方读法也都是这么过滤的。
 */
export async function listDataFiles(dir, { ext = '.json', withStat = false } = {}) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const picked = names.filter(n => n.endsWith(ext) && !n.startsWith('.') && !n.endsWith('.tmp'));
  const out = [];
  for (const name of picked) {
    const full = path.join(dir, name);
    if (!withStat) {
      out.push(full);
      continue;
    }
    try {
      const stat = await fs.stat(full);
      if (stat.isFile()) out.push({ path: full, name, size: stat.size, mtime: stat.mtimeMs });
    } catch { /* 列目录期间被删掉,跳过 */ }
  }
  return out;
}

/**
 * 进程是否还活着。
 * 用 `kill(pid, 0)` 探活 —— 不发信号,只做权限/存在性检查,是 Node 里的标准做法。
 * EPERM 表示"进程在但不属于我",同样算活着。
 */
export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * 跑一个外部 CLI(gh / gitee 这类),带超时与输出上限。
 * 永不抛:失败信息放在返回值里,由调用方决定怎么讲给模型听。
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ timeoutMs?: number, cwd?: string, maxChars?: number }} [options]
 * @returns {Promise<{ ok: boolean, code: number|null, stdout: string, stderr: string, error?: string, timedOut?: boolean }>}
 */
export function runCli(command, args, { timeoutMs = 25_000, cwd, maxChars = 400_000 } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = payload => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    let child;
    try {
      // shell:false(默认)—— 参数里带空格/引号也不会被拆碎。这三个 CLI 都是 argv 型。
      child = execFile(command, args, {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        env: process.env,
      }, (err, stdout, stderr) => {
        const out = String(stdout || '').slice(0, maxChars);
        const errOut = String(stderr || '').slice(0, 4000);
        if (err) {
          // execFile 在非零退出/超时/ENOENT 时都走这里。区分开,好写成人话。
          if (err.killed || err.signal) {
            return finish({ ok: false, code: null, stdout: out, stderr: errOut, timedOut: true, error: `命令超时(${Math.round(timeoutMs / 1000)}s 无响应)` });
          }
          if (err.code === 'ENOENT') {
            return finish({ ok: false, code: null, stdout: out, stderr: errOut, error: `找不到可执行文件 ${command}` });
          }
          return finish({ ok: false, code: typeof err.code === 'number' ? err.code : null, stdout: out, stderr: errOut, error: errOut.trim() || err.message });
        }
        finish({ ok: true, code: 0, stdout: out, stderr: errOut });
      });
    } catch (err) {
      finish({ ok: false, code: null, stdout: '', stderr: '', error: err?.message || String(err) });
    }
    // 子进程句柄只在需要取消时有用,MCP 侧没有取消入口,这里不持有
    void child;
  });
}

/** 截断长文本,附一句"已截断多少字符",避免把一个 37MB 的 jobs.json 塞进模型上下文。 */
export function truncate(text, max = 8000, head = 6000) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, head)}\n\n... [已截断 ${s.length - head} 字符,共 ${s.length} 字符]`;
}

/** 字符串参数收敛:trim 后为空则用 fallback。 */
export function asString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  const s = String(value).trim();
  return s === '' ? fallback : s;
}

/**
 * 整数参数收敛。
 *
 * 口径：**认不出来**（非数字 / NaN / Infinity）→ 用 fallback；认出来了但越界 → 夹到边界。
 * 夹取而不是回落，是因为调用方传 9999 时明显想要"尽可能多"，回落到默认值反而更意外；
 * 夹取同时也挡住了 `limit: 1e9` 这种会把几十 MB 塞进上下文的值。
 * fallback 自身也会被夹一次 —— 免得调用方写的默认值越界后偷偷生效。
 */
export function asInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const clamp = n => Math.min(Math.max(n, min), max);
  const n = Number(value);
  if (!Number.isFinite(n)) return clamp(fallback);
  return clamp(Math.trunc(n));
}

/** 布尔参数收敛:只有显式 false 才算 false(与 tools.js 的 auto_run 口径一致)。 */
export function asBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (s === 'false' || s === '0' || s === 'no') return false;
  if (s === 'true' || s === '1' || s === 'yes') return true;
  return fallback;
}

/**
 * 项目路径归一。与 workbench/projectRegistry.js:74 的 canonicalProjectPath 同口径
 * (Windows 形式 → 小写 + 反斜杠归一;其余原样)。
 *
 * ⚠️ 刻意**不** resolve / 不展开 `..` / 不查文件系统 —— 与那边保持一致,
 * 否则同一目录会裂成两个 key(MCP 侧算一次、看板侧算一次,两边口径不同就永远对不上)。
 */
export function canonicalProjectPath(p) {
  const s = asString(p);
  if (!s) return '';
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.includes('\\')) {
    return s.replace(/\//g, '\\').toLowerCase();
  }
  return s;
}

/** 取路径最后一段当项目名(盘符根目录时保留盘符)。 */
export function projectNameOf(p) {
  const s = asString(p);
  if (!s) return '';
  const trimmed = s.replace(/[\\/]+$/, '');
  const base = path.basename(trimmed);
  return base || trimmed;
}

/** 人类可读的文件大小。 */
export function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

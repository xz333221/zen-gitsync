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
// 原子写盘工具:tmp + rename,带 Windows "目标被占用" 重试与降级覆盖。
//
// 为什么抽出来(2026-09-18 配置分文件):写入点从 1 个变成
//   1(config.json) + N(projects/*.json) + M(orchestration/*/*.json)
// 若各写一份重试逻辑,迟早有一边漏掉 EPERM/EACCES/EBUSY 重试 —— 那正是
// 之前 "并发读写配置偶发 500" 的成因,不能靠"记得两边都改"来维持。
import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';

// Windows 上 rename / 覆盖写会撞上"目标此刻被别的句柄占着",libuv 报 EPERM / EACCES / EBUSY。
// 这类占用都是毫秒级的,重试几次就能穿过,不该立刻降级 —— 实测并发读写时降级路径自己也会
// 因目标被占用抛 EBUSY,把"慢一点的成功写"变成前端看到的 500。
//
// ⚠️ 最典型的占用来源就是**本进程/别的实例的 Node 读者**:libuv 在 Windows 上打开文件
// 用的是 FILE_SHARE_READ|FILE_SHARE_WRITE,**没带 FILE_SHARE_DELETE**(nodejs/node#16423),
// 于是只要有人正在 readFile,对同一路径的 rename 就必然 EPERM。实测:并发读一份 70MB 的
// jobs.json 期间裸 rename 6/6 全 EPERM;而同一份文件 readFile 本身只要 ~170ms。
// 所以重试预算必须覆盖"一次大文件读取",否则每次 5s 轮询读 jobs.json 都会顺手打死
// 一次落盘(本机 hub.log 里攒了 400+ 条 `EPERM: ... rename 'tasks.json.tmp'`)。
export const BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

// 默认 10 次 × 40ms 递增 ≈ 1.8s,够覆盖一次 70MB 读取(≈170ms)加排队
export async function retryOnBusy(fn, { attempts = 10, baseDelayMs = 40 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // 只有"占用类"错误值得重试;ENOENT(源没了)、权限外的错误立刻上抛
      if (!BUSY_CODES.has(err?.code)) throw err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
    }
  }
  throw lastErr;
}

// tmp 名带自增序号:同一毫秒内的两次写若共用同一个 tmp,先完成的 rename 会把
// tmp 搬走,后者的 rename 拿到 ENOENT/EPERM 而被迫降级覆盖写,原子性就丢了。
// 多进程之间靠 pid 天然不同,进程内靠这个序号。
let _tmpSeq = 0;

/**
 * 原子地把 text 写到 filePath。
 *
 * - 先写 `<filePath>.<pid>.<ms>.<seq>.tmp` 再 rename(同目录同盘,rename 是原子的)。
 * - rename 撞"占用"类错误先重试;重试仍失败才降级为直接覆盖写 —— 此时数据完整性
 *   由 writeFile 保证,只是丢了 rename 的原子性(极端情况下可能留 truncate 到一半的
 *   中间态,概率远低于整体写入失败)。
 * - ⚠️ **降级写成功就算成功,不能把 rename 的错误再抛出去**:原实现 throw err,
 *   于是数据其实已经落盘、调用方却收到异常,前端表现为"保存失败 500"。
 * - 失败时清理孤儿 tmp,避免 `.zen-gitsync/` 里堆积 `*.tmp`。
 * - `opts.fsMod` 只给**单测注入 mock fs** 用(instanceRegistry 那几个用例要跨平台
 *   伪造路径)。传了就全程走它,别混用真 fs —— 混用会让 mock 的路径跑到真实磁盘上。
 */
export async function atomicWriteText(filePath, text, { fsMod = fs } = {}) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${++_tmpSeq}.tmp`;
  try {
    await fsMod.writeFile(tmpPath, text, 'utf-8');
    try {
      await retryOnBusy(() => fsMod.rename(tmpPath, filePath));
    } catch (err) {
      console.warn(chalk.yellow(
        `[fsAtomic] 原子写降级为覆盖写(${path.basename(filePath)} rename 失败: ${err?.code || err?.message || err})`
      ));
      try { await fsMod.unlink(tmpPath); } catch (_) { /* ignore */ }
      await retryOnBusy(() => fsMod.writeFile(filePath, text, 'utf-8'));
    }
  } catch (err) {
    try { await fsMod.unlink(tmpPath); } catch (_) { /* ignore */ }
    throw err;
  }
}

/** 安全的 unlink:ENOENT 不算错误(目标本来就不在) */
export async function unlinkIfExists(filePath) {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

/** 安全的 mkdir -p。若目标存在但不是目录则抛 ENOTDIR(见下方注释) */
export async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }
  // ⚠️ mkdir 在"目标已存在,但它是个**文件**"时同样报 EEXIST。只吞 EEXIST 就返回,
  // 会让后续所有写入都撞 ENOTDIR —— 错误被推到很远的地方才暴露,而且中间可能已经
  // 做了不可逆的破坏(实测:配置拆分因此把 config.json 里的内联 projects 摘掉了,
  // 而分文件一个都没写成功 = 直接丢数据)。所以这里补一次类型校验,立刻抛。
  const st = await fs.lstat(dirPath).catch(() => null);
  if (!st || !st.isDirectory()) {
    const err = new Error(`ensureDir: ${dirPath} 已存在但不是目录`);
    err.code = 'ENOTDIR';
    throw err;
  }
}

/** 目录是否存在(且是目录) */
export async function dirExists(dirPath) {
  try {
    return (await fs.lstat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

/** 文件是否存在(且是文件) */
export async function fileExists(filePath) {
  try {
    return (await fs.lstat(filePath)).isFile();
  } catch {
    return false;
  }
}

export default { atomicWriteText, retryOnBusy, unlinkIfExists, ensureDir, dirExists, fileExists, BUSY_CODES };

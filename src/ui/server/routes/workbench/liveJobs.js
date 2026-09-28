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
// 「运行中」job 的跨实例可见性：每进程一个 ~/.zen-gitsync/live-jobs/<pid>.json。
//
// ── 要解决的问题（2026-09-28） ────────────────────────────────
// 看板的「进行中」列由执行记录推导（projectRegistry.deriveTaskColumn），
// 而执行记录只有**终态**才会落进 jobs.json（taskRunner 结束时才 flush）。
// 于是同时开两个 g ui 时：
//   · 已完成 / 已失败 —— 两边一致（终态在 jobs.json 里，谁都能读到）
//   · 进行中 —— 只有**跑它的那个**实例显示"进行中"，其它实例的看板上那几条还挂在
//     「待处理」。实测复现：A(4114) 正在跑的任务，B(5966) 的 /api/workbench/projects
//     里该任务 column=todo、runningJobs=0，A 那边 column=doing、runningJobs=1。
// 根因不是"没读"，而是"没写"：jobStore.js 里的 scheduleJobsSave() 是死代码，
// 全仓没有任何调用点 —— 运行中的 job 从头到尾只活在跑它的那个进程内存里。
// （同文件 index.js 的 cancel 路由早就写了"这个任务正在另一个 g ui 实例里执行"
//   的友好提示，说明"跨实例可见"本来就是设计意图，只是写盘这一环断了。）
//
// ── 为什么是目录 + 每进程一个文件 ─────────────────────────────
// 直接让每条 chunk 都去写 jobs.json 会把历史档案整份重写（本机 7.5MB / 48 条），
// 1.5s 一次，还要连带跑一遍保留策略 —— 搬砖量全花在"同步一条状态"上，且阻塞
// 事件循环反过来卡住流式输出。这里只写运行中那几条，几十 KB 封顶。
// 目录形态则沿用 instances/ 的结论：各写各的文件，天然没有 read-modify-write
// 丢更新，也不需要在 Windows 上做跨进程锁。
//
// ── 生命周期 ─────────────────────────────────────────────────
//   写：job 转 running/pending 时、以及流式 chunk 到达时，1.5s 防抖写一次
//   删：本进程再没有 running/pending 的 job 时（终态 flush 会立刻走一次）
//   读：遍历目录，**跳过 owner 进程已消失的文件**（顺手删掉，自愈），
//       坏文件跳过不抛（与 instanceRegistry 同口径）
// 所以进程被 kill -9 也不会留下幽灵"进行中"：下次别人读的时候 owner pid 已经不在了。
//
// 重要口径：**本进程内存里的 job 永远优先**（见 jobStore.mergedJobs）。这里的
// output/thinking/toolCalls 是**截尾**的（远端只看个大概，不需要搬全文），
// 本进程自己看的始终是内存里那份完整的。

import fsp from 'fs/promises';
import path from 'path';
import { logger, LIVE_JOBS_DIR } from './shared.js';

/** 远端可见的输出尾巴长度。整份日志动辄几十万字符，跨实例只需要"跑到哪了" */
export const LIVE_OUTPUT_TAIL_CHARS = 32 * 1024;
export const LIVE_THINKING_TAIL_CHARS = 8 * 1024;
/** 工具调用只留最近若干条；单条字段再做一次截断 */
export const LIVE_TOOL_CALL_LIMIT = 20;
export const LIVE_TOOL_CALL_FIELD_CHARS = 2 * 1024;
/**
 * owner 进程还活着、但文件太久没更新时不再采信。
 * 触发条件很苛刻（只有 pid 被复用才会出现），作用是给"幽灵进行中"一个硬上限，
 * 而不是给正常任务设超时 —— 模型闷头想 20 分钟不吐一个 chunk 是正常的。
 */
export const LIVE_MAX_AGE_MS = 60 * 60 * 1000;

/** 信号 0 探测存活。任何报错都当"进程不在了"——与 jobStore/taskRunner 同一口径 */
function defaultIsProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

/**
 * job → 可序列化投影。**全仓唯一一份**：SSE 快照（jobStore.snapshotJobs）与
 * live-jobs 落盘都用它 —— 两处各写一份字段清单时，加一个字段漏掉一处不会报错，
 * 只会让"本实例看得到、别的实例看不到"。
 *
 * 白名单投影：未登记字段静默剥掉（child 是 ChildProcess，不可序列化，必须剥）。
 */
export function projectJob(j) {
  return {
    id: j.id,
    taskId: j.taskId,
    subId: j.subId,
    title: j.title,
    status: j.status,
    prompt: j.prompt || '',
    output: j.output || '',
    thinking: j.thinking || '',
    pid: j.pid || null,
    startedAt: j.startedAt || null,
    endedAt: j.endedAt || null,
    exitCode: typeof j.exitCode === 'number' ? j.exitCode : null,
    error: j.error || null,
    // 本轮用的执行器（claude | opencode）。前端对话区助手名 / 日志详情按它显示。
    agent: j.agent || null,
    // 工具调用流水（{id,name,argsPreview,arguments,result,status,error}[]）。
    // 前端靠它画工具块;刷新页面 / 换实例后仍然可见,所以必须过白名单。
    toolCalls: Array.isArray(j.toolCalls) ? j.toolCalls : [],
    // 续接对话用:claude --output-format stream-json 的 system.init 事件捕获到的 session_id
    claudeSessionId: j.claudeSessionId || null
  };
}

/** 取尾部 N 个字符（截断方向与 taskRunner 的 MAX_OUTPUT 尾部保底一致） */
function tail(text, max) {
  const s = typeof text === 'string' ? text : '';
  return s.length > max ? s.slice(-max) : s;
}

/** 落盘前的瘦身：正文/思考/工具流水截尾，其余字段原样 */
export function toLiveRecord(job) {
  const rec = projectJob(job);
  rec.output = tail(rec.output, LIVE_OUTPUT_TAIL_CHARS);
  rec.thinking = tail(rec.thinking, LIVE_THINKING_TAIL_CHARS);
  rec.toolCalls = rec.toolCalls.slice(-LIVE_TOOL_CALL_LIMIT).map((c) => ({
    id: c && c.id,
    name: c && c.name,
    argsPreview: tail(c && c.argsPreview, LIVE_TOOL_CALL_FIELD_CHARS),
    arguments: tail(c && c.arguments, LIVE_TOOL_CALL_FIELD_CHARS),
    result: tail(c && c.result, LIVE_TOOL_CALL_FIELD_CHARS),
    status: c && c.status,
    error: (c && c.error) || null
  }));
  return rec;
}

export function liveJobsFilePath(ownerPid) {
  return path.join(LIVE_JOBS_DIR, `${ownerPid}.json`);
}

/** 写自己的那份。records 为空 = 本进程没有运行中的 job，直接删文件 */
export async function writeLiveJobsFile(ownerPid, records) {
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) throw new Error('writeLiveJobsFile: ownerPid 非法');
  const list = Array.isArray(records) ? records : [];
  if (list.length === 0) return removeLiveJobsFile(ownerPid);
  await fsp.mkdir(LIVE_JOBS_DIR, { recursive: true });
  const file = liveJobsFilePath(ownerPid);
  const tmp = `${file}.tmp`;
  // 原子写：tmp + rename（与 readJson/writeJson 同口径）。tmp 文件名带 pid 后缀
  // 天然不撞车，读者按 /^\d+\.json$/ 过滤也就不会读到半截文件。
  await fsp.writeFile(tmp, JSON.stringify({
    version: 1,
    ownerPid,
    updatedAt: Date.now(),
    jobs: list
  }), 'utf-8');
  await fsp.rename(tmp, file);
}

/** 删自己的那份。失败只记 warn —— 读者那边还有"owner pid 已死就跳过"兜底 */
export async function removeLiveJobsFile(ownerPid) {
  try {
    await fsp.unlink(liveJobsFilePath(ownerPid));
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    logger.warn(`[workbench] 清理 live-jobs/${ownerPid}.json 失败: ${err?.message || err}`);
  }
}

// entry 文件名匹配：<pid>.json（pid 是正整数）。跳过 .tmp 等写入中间态
function isEntryFileName(name) {
  return typeof name === 'string' && /^\d+\.json$/.test(name);
}

/**
 * 扫描目录，返回所有**别的实例**正在跑的 job。
 *
 * 返回 `signature` 是为了让调用方（jobStore）能像 jobs.json 那样用
 * mtime+size 做短路：看板 5s 轮询一次，目录没变化就不该真去 parse。
 *
 * @returns {Promise<{ signature: string, jobs: object[] }>}
 */
export async function scanLiveJobsDir({ isProcessAlive = defaultIsProcessAlive, now = Date.now() } = {}) {
  let names;
  try {
    names = await fsp.readdir(LIVE_JOBS_DIR);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { signature: '', jobs: [] };
    throw err;
  }

  const files = [];
  for (const name of names) {
    if (!isEntryFileName(name)) continue;
    const fp = path.join(LIVE_JOBS_DIR, name);
    try {
      const st = await fsp.stat(fp);
      files.push({ name, fp, size: st.size, mtimeMs: st.mtimeMs });
    } catch { /* 刚被删掉，跳过 */ }
  }
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const signature = files.map(f => `${f.name}:${f.mtimeMs}:${f.size}`).join('|');

  const jobs = [];
  for (const f of files) {
    const ownerPid = Number(f.name.slice(0, -'.json'.length));
    // owner 不在了 —— 它跑到一半的 job 永远不会再有下文（连终态都没落进 jobs.json），
    // 顺手把文件删掉自愈，别让别的实例的看板永远挂着"进行中"。
    if (!isProcessAlive(ownerPid)) {
      await removeLiveJobsFile(ownerPid);
      continue;
    }
    let data;
    try {
      data = JSON.parse(await fsp.readFile(f.fp, 'utf-8'));
    } catch (err) {
      logger.warn(`[workbench] live-jobs/${f.name} 读取失败，跳过: ${err?.message || err}`);
      continue;
    }
    if (!data || data.ownerPid !== ownerPid || !Array.isArray(data.jobs)) continue;
    if (now - Number(data.updatedAt || 0) > LIVE_MAX_AGE_MS) continue;
    for (const j of data.jobs) {
      if (j && j.id) jobs.push(j);
    }
  }
  return { signature, jobs };
}

export const liveJobs = {
  projectJob,
  toLiveRecord,
  writeLiveJobsFile,
  removeLiveJobsFile,
  scanLiveJobsDir,
  liveJobsFilePath,
};

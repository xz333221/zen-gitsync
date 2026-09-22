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
// 执行日志持久化 + 进程表（jobs Map）+ 事件总线（bus）。
// 拆分自原 routes/workbench.js 814-955 行。
//
// 设计要点：
//   - 写盘在流式 chunk 阶段走 1.5s debounce；终态时（finally / cancel）强制 flush
//   - 永不持久化 child 引用（参考 cancel 路由的浅拷贝模式）
//   - hydrate 时把 running/pending 降级为 error：原 child 进程已不存在
//   - enforceRetention 在每次落盘后跑，按 endedAt desc FIFO 裁剪
//
// 模块级单例：bus / jobs / cancelledJobs 跨整个进程共享，
// SSE /api/workbench/events 与 cancel 接口都从这里读

import { EventEmitter } from 'events';
import fsp from 'fs/promises';
import {
  logger,
  fsp as _fsp,
  JOBS_FILE,
  JOBS_CONFIG_FILE,
  TASKS_FILE,
  JOBS_SAVE_DEBOUNCE_MS,
  DEFAULT_JOBS_CONFIG,
  readJson,
  writeJson,
  nowIso,
} from './shared.js';

// 进程表：记录每个子任务的运行状态
// jobId -> { id, taskId, subId, status, pid, startedAt, endedAt, exitCode, error, prompt, child, output, thinking, claudeSessionId, toolCalls }
export const jobs = new Map();

// 事件总线：SSE /api/workbench/events 监听 'event'，路由层用 publish() 推送
export const bus = new EventEmitter();

// 被用户主动取消的 jobId 集合——runTaskQueue 在 waitProcessExit 之后检查这个集合
// 来决定把 job 标为 'cancelled' 还是 'done'。
// 用 Set 而不是 job.cancelled 标志，是为了在 SIGTERM 发出后到 child 真正退出之间
// 有一个简洁的"待回收"窗口。
export const cancelledJobs = new Set();

// ── 磁盘快照（跨实例同步的读取侧） ────────────────────────────
// 背景(2026-09-20):jobs Map 只在进程启动时 hydrate 一次,之后永不回读磁盘。
// 于是开了两个 g ui 时,跑任务的那个知道"这两条已完成",另一个(启动更早的)看板里
// 同样的任务还挂在"待处理" —— 因为看板列是由执行记录推导的(见 projectRegistry.js
// 的 deriveTaskColumn),而数据其实一直在 jobs.json 里,只是没第二个进程去读它。
//
// 现在:凡是需要"反映别的 g ui 进程"的读取路径,先 await refreshJobsFromDisk(),
// 再用 mergedJobs() 拿「磁盘 ∪ 内存」。**内存优先** —— 本进程跑的 job 带着最新的
// 流式输出和终态,磁盘上的那一份还可能停在 1.5s debounce 之前的旧状态。
//
// 同步 vs 异步:refreshJobsFromDisk() 是异步的(要 stat + 读文件),mergedJobs() /
// snapshotJobs() 保持同步纯函数,读缓存的磁盘那一半 —— 调用点"先 await 刷新、
// 再同步取快照"这个顺序别颠倒,否则拿到的是上一次的磁盘内容。
//
// 用户明确接受秒级延迟:看板本身 5s 轮询,不需要为跨实例推送再造一套 IPC/SSE。
//
// mtime + size 短路:jobs.json 涨到几百 KB 后,每 5s 一次的轮询不该真去 parse 它,
// 没变就是一个 stat。
let diskCache = { mtimeMs: -1, size: -1, jobs: [] };

/** 磁盘记录自称 running/pending,但进程已消失、文件也已 N 秒没被写过 → 判为孤儿 */
// 宽限期要大于 jobs 落盘的 1.5s debounce:job 刚结束时 child 已退出、终态还没 flush,
// 那个窗口里(pid 死 + 磁盘 running)不该被误判。5s 足够跨过它,又快到用户感知不到。
const ORPHAN_GRACE_MS = 5000;

/** 信号 0 探测存活。任何报错都当"进程不在了"——与 taskRunner.waitProcessExit 同一口径 */
function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

/**
 * 磁盘上那条"还在跑"的记录是个孤儿吗?
 * 场景:另一个 g ui 被 Ctrl+C / kill 掉在跑任务的中间,它的终态永远不会 flush ——
 * 不做这个回收,那条 job 会在**所有其他实例**的看板上永远占着"进行中"。
 * 口径与 hydrateJobs 启动回收一致(降级为 error,error 里写明原因)。
 */
function reclaimOrphan(j, fileMtimeMs) {
  if (!j || (j.status !== 'running' && j.status !== 'pending')) return j;
  const pid = Number(j.pid);
  if (!Number.isFinite(pid) || pid <= 0) return j;      // 老数据没 pid,无从判断,不动它
  if (isProcessAlive(pid)) return j;
  if (fileMtimeMs > 0 && Date.now() - fileMtimeMs < ORPHAN_GRACE_MS) return j;
  return {
    ...j,
    status: 'error',
    error: (j.error || '') + ' [进程不存在：已回收]',
    endedAt: j.endedAt || nowIso(),
    exitCode: typeof j.exitCode === 'number' ? j.exitCode : 1,
  };
}

/**
 * 把 jobs.json 当前内容读进缓存。没变( mtime + size 都没动)就直接返回。
 * 读失败一律降级成"沿用上次缓存":看板请求不该因为一个坏文件而 500。
 */
export async function refreshJobsFromDisk({ force = false } = {}) {
  let st;
  try {
    st = await fsp.stat(JOBS_FILE);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      diskCache = { mtimeMs: -1, size: -1, jobs: [] };
      return;
    }
    logger.warn('[workbench] jobs.json stat 失败，沿用上次缓存:', err.message);
    return;
  }
  if (!force && st.mtimeMs === diskCache.mtimeMs && st.size === diskCache.size) return;
  try {
    const data = await readJson(JOBS_FILE, { version: 1, jobs: [] });
    diskCache = {
      mtimeMs: st.mtimeMs,
      size: st.size,
      jobs: (data && Array.isArray(data.jobs)) ? data.jobs : [],
    };
  } catch (err) {
    // 半写 / 损坏:保留上一次的缓存,下一次刷新(mtime 还会变)自然会重试
    logger.warn('[workbench] jobs.json 读取失败，沿用上次缓存:', err.message);
  }
}

/** 本进程自己写完盘后把缓存作废,免得下一次 refresh 被 mtime 短路在旧内容上 */
function invalidateDiskCache() {
  diskCache = { mtimeMs: -1, size: -1, jobs: [] };
}

/**
 * 磁盘 ∪ 内存的 job 表(id -> 记录)。内存优先。
 * 同步、无 IO —— 磁盘那一半由 refreshJobsFromDisk() 预先填好。
 */
export function mergedJobs() {
  const map = new Map();
  for (const j of diskCache.jobs) {
    if (!j || !j.id) continue;
    if (jobs.has(j.id)) continue;                        // 本进程跑的,下面用内存里的覆盖
    map.set(j.id, reclaimOrphan(j, diskCache.mtimeMs));
  }
  for (const [id, j] of jobs) map.set(id, j);
  return map;
}

// ── 持久化层 ─────────────────────────────────────────────────
// jobs.json 是历史档案；jobs Map 只承载当前进程产出的活跃 job
let jobsSaveTimer = null;

// 序列化 job 落盘：剥离 child 引用（ChildProcess 无法 JSON.stringify），
// 反范式 taskTitle 方便管理页直接读
export function serializeJob(j, taskMap) {
  const { child, ...rest } = j;
  const t = taskMap ? taskMap.get(rest.taskId) : null;
  // size 是保留策略（maxSizeMB）的计价口径，工具调用也会占体积，必须算进去，
  // 否则一份全是工具流水的 job 会被当成"很小"而留下来。
  const toolCallsSize = Array.isArray(rest.toolCalls)
    ? rest.toolCalls.reduce((sum, c) => sum + (typeof c?.arguments === 'string' ? c.arguments.length : 0)
      + (typeof c?.result === 'string' ? c.result.length : 0)
      + (typeof c?.argsPreview === 'string' ? c.argsPreview.length : 0), 0)
    : 0;
  const size = ((rest.prompt || '').length
    + (rest.output || '').length
    + (rest.thinking || '').length
    + toolCallsSize);
  return {
    ...rest,
    taskTitle: t ? t.title : '',
    size
  };
}

// 流式 chunk 阶段 debounce 写盘；终态时由 flushJobsSaveNow() 强制立即落盘
export function scheduleJobsSave() {
  if (jobsSaveTimer) clearTimeout(jobsSaveTimer);
  jobsSaveTimer = setTimeout(() => {
    jobsSaveTimer = null;
    flushJobsSaveNow().catch(err => logger.warn('[workbench] jobs save failed:', err.message));
  }, JOBS_SAVE_DEBOUNCE_MS);
}

// 立即落盘（终态调用）：把 jobs Map 当前快照写到 jobs.json，然后跑 retention
export async function flushJobsSaveNow() {
  if (jobsSaveTimer) { clearTimeout(jobsSaveTimer); jobsSaveTimer = null; }
  // 读 tasks.json 给落盘 job 反范式 taskTitle——父任务被删后管理页仍可读
  const tasksData = await readJson(TASKS_FILE, { tasks: [] });
  const taskMap = new Map((tasksData.tasks || []).map(t => [t.id, t]));
  // **必须并上磁盘上的历史 job 再写**：别的 g ui 进程跑的记录不在本进程内存里,
  // 直接写内存快照会把它抹掉(一个实例落盘、另一个实例的记录就没了)。
  await refreshJobsFromDisk();
  const payload = {
    version: 1,
    jobs: Array.from(mergedJobs().values()).map(j => serializeJob(j, taskMap))
  };
  await writeJson(JOBS_FILE, payload);
  invalidateDiskCache();
  await enforceRetention();
}

// jobs-config.json 读写：maxCount / maxSizeMB 保留策略
export async function readJobsConfig() {
  const cfg = await readJson(JOBS_CONFIG_FILE, null);
  if (!cfg || typeof cfg !== 'object') return { ...DEFAULT_JOBS_CONFIG };
  return {
    maxCount: Number.isFinite(cfg.maxCount) ? Math.max(0, Math.floor(cfg.maxCount)) : DEFAULT_JOBS_CONFIG.maxCount,
    maxSizeMB: Number.isFinite(cfg.maxSizeMB) ? Math.max(0, Math.floor(cfg.maxSizeMB)) : DEFAULT_JOBS_CONFIG.maxSizeMB
  };
}

export async function writeJobsConfig(cfg) {
  // 校验：非负整数；硬上限防误填爆盘
  const out = {};
  if (cfg.maxCount !== undefined) {
    const n = Math.floor(Number(cfg.maxCount));
    if (!Number.isFinite(n) || n < 0 || n > 10000) throw new Error('maxCount 必须在 0-10000 之间');
    out.maxCount = n;
  }
  if (cfg.maxSizeMB !== undefined) {
    const n = Math.floor(Number(cfg.maxSizeMB));
    if (!Number.isFinite(n) || n < 0 || n > 10240) throw new Error('maxSizeMB 必须在 0-10240 之间');
    out.maxSizeMB = n;
  }
  const merged = { ...(await readJobsConfig()), ...out };
  await writeJson(JOBS_CONFIG_FILE, merged);
  return merged;
}

// 进程启动时把磁盘上的历史拉回内存 Map；陈旧的 running/pending 强制降级。
// 陈旧 job 的 child 进程已退出，标记为 error 方便用户识别。
export async function hydrateJobs() {
  let data;
  try {
    data = await readJson(JOBS_FILE, null);
  } catch (err) {
    // 损坏文件：改名备份避免下次 flush 静默覆盖用户数据
    logger.warn('[workbench] jobs.json 解析失败，备份原文件后重置:', err.message);
    try { await _fsp.rename(JOBS_FILE, `${JOBS_FILE}.bak-${Date.now()}`); } catch { /* 文件可能已不在 */ }
    return;
  }
  if (!data || !Array.isArray(data.jobs)) return;
  for (const j of data.jobs) {
    if (j.status === 'running' || j.status === 'pending') {
      j.status = 'error';
      j.error = (j.error || '') + ' [重启后回收：原进程已退出]';
      j.endedAt = j.endedAt || nowIso();
      j.exitCode = typeof j.exitCode === 'number' ? j.exitCode : 1;
    }
    // 旧版本可能没 size 字段；补齐以兼容历史文件
    if (typeof j.size !== 'number') {
      const toolSize = Array.isArray(j.toolCalls)
        ? j.toolCalls.reduce((sum, c) => sum + (c?.arguments || '').length + (c?.result || '').length, 0)
        : 0;
      j.size = ((j.prompt || '').length + (j.output || '').length + (j.thinking || '').length + toolSize);
    }
    jobs.set(j.id, j);
  }
  // 启动后也跑一遍保留策略，让历史文件立刻缩到当前配置
  try { await enforceRetention(); } catch (err) { logger.warn('[workbench] 启动时 enforceRetention 失败:', err.message); }
}

// 保留策略：按 endedAt desc（fallback startedAt / id）排序，先按 maxCount 截，
// 再按 maxSizeMB 累计裁，淘汰同步从内存 Map 删除。
export async function enforceRetention() {
  const cfg = await readJobsConfig();
  const data = await readJson(JOBS_FILE, { version: 1, jobs: [] });
  if (!data || !Array.isArray(data.jobs) || data.jobs.length === 0) return;
  const sortKey = (j) => j.endedAt || j.startedAt || j.id || '';
  data.jobs.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  if (cfg.maxCount > 0) data.jobs = data.jobs.slice(0, cfg.maxCount);
  if (cfg.maxSizeMB > 0) {
    const cap = cfg.maxSizeMB * 1024 * 1024;
    let total = data.jobs.reduce((s, j) => s + (j.size || 0), 0);
    while (total > cap && data.jobs.length > 1) {
      const dropped = data.jobs.pop();
      total -= (dropped && dropped.size) || 0;
    }
  }
  await writeJson(JOBS_FILE, data);
  invalidateDiskCache();
  const keepIds = new Set(data.jobs.map(j => j.id));
  for (const id of Array.from(jobs.keys())) {
    if (!keepIds.has(id)) jobs.delete(id);
  }
}

// 进程启动时拉回历史 job（陈旧 running/pending 自动降级 error）
// 模块加载即触发，与原 workbench.js 顶层调用保持一致
hydrateJobs().catch(err => logger.warn('[workbench] hydrate jobs failed:', err.message));

// ── 事件推送 + 快照 ─────────────────────────────────────────
// publish 给 SSE 路由用：所有事件都走 bus.emit('event', {event, payload, ts})
export function publish(event, payload) {
  bus.emit('event', { event, payload, ts: nowIso() });
}

// 给 SSE / 看板 / cancel / continue 路由用：返回「磁盘 ∪ 内存」的可序列化快照
// 剥离 child 引用（不可序列化），只保留前端需要的字段。
//
// 同步函数,磁盘那一半读的是 refreshJobsFromDisk() 填好的缓存 —— 想让别的 g ui
// 进程跑的 job 出现在结果里,调用前先 await 一次刷新(见文件头的说明)。
export function snapshotJobs() {
  return Array.from(mergedJobs().values()).map(j => ({
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
    // 本轮用的执行器（claude | opencode）。前端对话区助手名 / 日志详情按它显示;
    // 加字段时记得同步这里 —— 白名单投影会把没列出的字段静默剥掉。
    agent: j.agent || null,
    // 工具调用流水（{id,name,argsPreview,arguments,result,status,error}[]）。
    // 前端靠它画工具块;刷新页面 / 换实例后仍然可见,所以必须过白名单。
    toolCalls: Array.isArray(j.toolCalls) ? j.toolCalls : [],
    // 续接对话用:claude --output-format stream-json 的 system.init 事件捕获到的 session_id
    claudeSessionId: j.claudeSessionId || null
  }));
}

export const jobStore = {
  jobs,
  bus,
  cancelledJobs,
  serializeJob,
  scheduleJobsSave,
  flushJobsSaveNow,
  readJobsConfig,
  writeJobsConfig,
  hydrateJobs,
  enforceRetention,
  publish,
  snapshotJobs,
  refreshJobsFromDisk,
  mergedJobs,
};

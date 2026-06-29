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
// jobId -> { id, taskId, subId, status, pid, startedAt, endedAt, exitCode, error, prompt, child, output, thinking, claudeSessionId }
export const jobs = new Map();

// 事件总线：SSE /api/workbench/events 监听 'event'，路由层用 publish() 推送
export const bus = new EventEmitter();

// 被用户主动取消的 jobId 集合——runTaskQueue 在 waitProcessExit 之后检查这个集合
// 来决定把 job 标为 'cancelled' 还是 'done'。
// 用 Set 而不是 job.cancelled 标志，是为了在 SIGTERM 发出后到 child 真正退出之间
// 有一个简洁的"待回收"窗口。
export const cancelledJobs = new Set();

// ── 持久化层 ─────────────────────────────────────────────────
// jobs.json 是历史档案；jobs Map 只承载当前进程产出的活跃 job
let jobsSaveTimer = null;

// 序列化 job 落盘：剥离 child 引用（ChildProcess 无法 JSON.stringify），
// 反范式 taskTitle/subTitle 方便管理页直接读
export function serializeJob(j, taskMap) {
  const { child, ...rest } = j;
  const t = taskMap ? taskMap.get(rest.taskId) : null;
  const sub = t && Array.isArray(t.subtasks) ? t.subtasks.find(s => s.id === rest.subId) : null;
  const size = ((rest.prompt || '').length
    + (rest.output || '').length
    + (rest.thinking || '').length);
  return {
    ...rest,
    taskTitle: t ? t.title : '',
    subTitle: sub ? sub.title : '',
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
  // 读 tasks.json 给落盘 job 反范式 taskTitle/subTitle——父任务被删后管理页仍可读
  const tasksData = await readJson(TASKS_FILE, { tasks: [] });
  const taskMap = new Map((tasksData.tasks || []).map(t => [t.id, t]));
  const payload = {
    version: 1,
    jobs: Array.from(jobs.values()).map(j => serializeJob(j, taskMap))
  };
  await writeJson(JOBS_FILE, payload);
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
      j.size = ((j.prompt || '').length + (j.output || '').length + (j.thinking || '').length);
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

// 给 SSE / cancel / continue 路由用：返回当前所有 job 的可序列化快照
// 剥离 child 引用（不可序列化），只保留前端需要的字段
export function snapshotJobs() {
  return Array.from(jobs.values()).map(j => ({
    id: j.id,
    taskId: j.taskId,
    subId: j.subId,
    title: j.title,
    status: j.status,
    prompt: j.prompt || '',
    output: j.output || '',
    pid: j.pid || null,
    startedAt: j.startedAt || null,
    endedAt: j.endedAt || null,
    exitCode: typeof j.exitCode === 'number' ? j.exitCode : null,
    error: j.error || null,
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
};

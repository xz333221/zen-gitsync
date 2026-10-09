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
// 定时任务库：任务的持久化 / 校验 / 多实例认领。
//
// ── 存放位置与共享口径 ──────────────────────────────────────────
// 任务库在 ~/.zen-gitsync/schedules.json —— **CLI 与 GUI 共享同一份**：
// 用户在 g ai 对话里说"每天 9 点拉代码"，工具写的就是这个文件；
// 真正到点执行的是 g ui 服务端的调度器（CLI 是即用即走的进程，不做调度）。
//
// ── 多实例并发（本机常态是同时开好几个 g ui）────────────────────────
// 靠两层防重：
//   1. lastFire：任务上记录"最近一次已处置的触发时刻"。调度器判定
//      `prevFire <= lastFire` 就跳过 —— 单实例下的常规去重。
//   2. 认领文件：真要执行前用 `wx` **原子创建** `schedule-claims/<id>__<fireKey>.json`，
//      创建失败的实例直接让过。这是多实例下的权威判据（与 instances/、live-jobs/
//      同思路：各写各的文件，天然没有跨进程锁的问题）。
//      fireKey 是分钟粒度的时间键，同一个触发时刻只可能有一个认领文件。
//
// ── 读缓存 ───────────────────────────────────────────────────
// loadTasks 按 mtime+size 判定文件是否变过；CLI 侧创建的任务、别的实例改的任务，
// 调度器下一个 tick 就能看到（不需要任何显式通知）。
// 写操作一律"重读 → 改 → 原子写（tmp+rename）"，把读-改-写窗口压到最小。

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { SCHEDULES_FILE, SCHEDULE_CLAIMS_DIR } from '../paths.js';
import { validateCron } from './scheduleCron.js';

export { SCHEDULES_FILE, SCHEDULE_CLAIMS_DIR };

/** 任务数量上限：一个本机定时任务库没有理由超过这个数 */
export const MAX_TASKS = 100;
/** 认领文件的保留时长（诊断用，过期即清） */
export const CLAIM_TTL_MS = 2 * 24 * 3600 * 1000;

const MAX_NAME = 100;
const MAX_PROMPT = 20000;
const MAX_CWD = 260;
const MAX_MODEL = 80;

export const SESSION_MODES = ['dedicated', 'new'];
export const ON_MISSED = ['run', 'skip'];

/** 带 HTTP 状态码的错误：路由层直接透出 message（与 agentSessionStore 同口径） */
function bad(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

const asStr = (value, max) => String(value ?? '').trim().slice(0, max);

function genTaskId() {
  return `sch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── 字段归一化 ────────────────────────────────────────────────

/**
 * 把"用户输入"归一化成一个完整任务对象。创建与更新共用同一份不变式。
 * @param {object} input 用户可改字段（部分）
 * @param {object} [existing] 更新时的存量任务（系统字段从这里继承）
 */
function normalizeTask(input, existing = null) {
  const src = input || {};
  const base = existing || {};

  const name = asStr(src.name !== undefined ? src.name : base.name, MAX_NAME);
  if (!name) throw bad('任务名不能为空');

  const prompt = String(src.prompt !== undefined ? src.prompt : base.prompt ?? '').trim().slice(0, MAX_PROMPT);
  if (!prompt) throw bad('提示词不能为空 —— 定时任务到点后就是把这段内容发给 g ai');

  const schedule = asStr(src.schedule !== undefined ? src.schedule : base.schedule, 80);
  const cronCheck = validateCron(schedule);
  if (!cronCheck.ok) throw bad(cronCheck.error);

  const cwd = asStr(src.cwd !== undefined ? src.cwd : base.cwd, MAX_CWD);
  if (!cwd) throw bad('项目目录不能为空');
  if (!path.isAbsolute(cwd)) throw bad(`项目目录必须是绝对路径: ${cwd}`);

  const model = asStr(src.model !== undefined ? src.model : base.model, MAX_MODEL);

  const localeRaw = asStr(src.locale !== undefined ? src.locale : base.locale, 8);
  const locale = localeRaw === 'en' ? 'en' : 'zh';

  const sessionModeRaw = asStr(src.sessionMode !== undefined ? src.sessionMode : base.sessionMode, 16);
  const sessionMode = SESSION_MODES.includes(sessionModeRaw) ? sessionModeRaw : 'dedicated';

  const onMissedRaw = asStr(src.onMissed !== undefined ? src.onMissed : base.onMissed, 8);
  const onMissed = ON_MISSED.includes(onMissedRaw) ? onMissedRaw : 'run';

  const enabled = src.enabled !== undefined ? src.enabled === true : base.enabled !== false;

  const nowIso = new Date().toISOString();
  return {
    id: base.id || genTaskId(),
    name,
    enabled,
    schedule,
    cwd,
    prompt,
    model,
    locale,
    sessionMode,
    onMissed,
    // 会话忙时的策略：当前只有"跳过本轮"（记录原因），字段先留着，行为不变
    onBusy: 'skip',
    // 专属会话 id（sessionMode === 'dedicated' 时由调度器在首次执行后回填）
    sessionId: asStr(src.sessionId !== undefined ? src.sessionId : base.sessionId, 64),
    // 最近一次**已处置**的触发时刻（ISO）——含"跑了"和"按策略跳过"两种
    lastFire: asStr(src.lastFire !== undefined ? src.lastFire : base.lastFire, 40),
    // 最近一次执行记录（调度器 / 手动运行写入；形状自由，读侧全部兜底）
    lastRun: (src.lastRun !== undefined ? src.lastRun : base.lastRun) || null,
    createdAt: base.createdAt || nowIso,
    updatedAt: nowIso,
  };
}

// ── 读 ────────────────────────────────────────────────────────

/** 模块级读缓存：{ mtimeMs, size, tasks }。文件没动就不重复读盘 */
let cache = null;

async function readFromDisk() {
  try {
    const raw = await fsp.readFile(SCHEDULES_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const tasks = Array.isArray(data?.tasks) ? data.tasks.filter(t => t && typeof t === 'object' && t.id) : [];
    return tasks;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    // 坏文件不抛给调用方（调度器每 30 秒读一次，一次坏文件不该让整个调度停摆）：
    // 记一条日志、按"没有任务"处理。真正的修复手段是用户重新保存任务。
    console.warn(`[scheduleStore] schedules.json 读取失败，按空任务库处理: ${err?.message || err}`);
    return [];
  }
}

/**
 * 列出全部任务。文件未变时走缓存。
 * @param {{ fresh?: boolean }} [opts] fresh=true 时强制重读
 */
export async function loadTasks({ fresh = false } = {}) {
  let stat = null;
  try {
    stat = await fsp.stat(SCHEDULES_FILE);
  } catch {
    cache = { mtimeMs: -1, size: -1, tasks: [] };
    return [];
  }
  if (!fresh && cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.tasks;
  }
  const tasks = await readFromDisk();
  cache = { mtimeMs: stat.mtimeMs, size: stat.size, tasks };
  return tasks;
}

/** 按 id 找一个任务 */
export async function getTask(id) {
  const tasks = await loadTasks();
  return tasks.find(t => t.id === id) || null;
}

// ── 写 ────────────────────────────────────────────────────────

async function writeToDisk(tasks) {
  await fsp.mkdir(path.dirname(SCHEDULES_FILE), { recursive: true });
  const payload = { version: 1, tasks };
  const tmp = `${SCHEDULES_FILE}.tmp.${process.pid}.${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  await fsp.rename(tmp, SCHEDULES_FILE);
  cache = null; // 下次读重新 stat + load
}

/**
 * 重读 → 改 → 写。mutator 拿到**磁盘上的最新**任务数组，直接改它。
 * 多实例并发时窗口极小；真正的防重靠 claimFire 的原子文件。
 * @param {(tasks: object[]) => any} mutator
 */
async function mutateTasks(mutator) {
  const tasks = await loadTasks({ fresh: true });
  const result = mutator(tasks);
  await writeToDisk(tasks);
  return result;
}

/** 校验目录存在（创建/更新时用；执行时调度器会再查一次） */
async function assertCwdUsable(cwd) {
  try {
    const st = await fsp.stat(cwd);
    if (!st.isDirectory()) throw bad(`项目目录不是一个目录: ${cwd}`);
  } catch (err) {
    if (err.statusCode) throw err;
    throw bad(`项目目录不存在: ${cwd}`);
  }
}

/**
 * 创建任务。
 * @returns {Promise<object>} 归一化后的完整任务
 */
export async function createTask(input) {
  const task = normalizeTask(input);
  await assertCwdUsable(task.cwd);
  await mutateTasks((tasks) => {
    if (tasks.length >= MAX_TASKS) throw bad(`定时任务数量已达上限(${MAX_TASKS})`);
    if (tasks.some(t => t.id === task.id)) throw bad('任务 id 冲突，请重试');
    tasks.push(task);
  });
  return task;
}

/** updateTask 允许改的字段白名单：其余（id/sessionId/lastFire/lastRun/createdAt…）是系统字段 */
const PATCH_KEYS = ['name', 'schedule', 'cwd', 'prompt', 'model', 'enabled', 'sessionMode', 'onMissed', 'locale'];

/**
 * 更新任务（只接受用户可改字段，白名单见 PATCH_KEYS）。
 * 校验（含目录存在性）全部通过后才落盘 —— 校验失败时磁盘上的旧任务保持不变。
 * @returns {Promise<object>} 更新后的任务
 */
export async function updateTask(id, patch) {
  const tasks = await loadTasks({ fresh: true });
  const idx = tasks.findIndex(t => t.id === id);
  if (idx < 0) throw bad(`任务不存在: ${id}`);
  const clean = {};
  for (const key of PATCH_KEYS) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) clean[key] = patch[key];
  }
  const next = normalizeTask(clean, tasks[idx]);
  if (Object.prototype.hasOwnProperty.call(clean, 'cwd')) await assertCwdUsable(next.cwd);
  tasks[idx] = next;
  await writeToDisk(tasks);
  return next;
}

/** 删除任务 */
export async function deleteTask(id) {
  return mutateTasks((tasks) => {
    const idx = tasks.findIndex(t => t.id === id);
    if (idx < 0) throw bad(`任务不存在: ${id}`);
    tasks.splice(idx, 1);
    return true;
  });
}

// ── 系统字段写入口（调度器专用）────────────────────────────────

/** 标记"这个触发时刻已处置"（跑了 / 按策略跳过 / 被别的实例跑了都算） */
export async function setTaskFire(id, fireIso) {
  return mutateTasks((tasks) => {
    const task = tasks.find(t => t.id === id);
    if (!task) return null;
    task.lastFire = fireIso || '';
    return task;
  });
}

/** 写入最近一次执行记录 + （可选）回填专属会话 id */
export async function setTaskRun(id, run, sessionId) {
  return mutateTasks((tasks) => {
    const task = tasks.find(t => t.id === id);
    if (!task) return null;
    task.lastRun = run || null;
    if (sessionId !== undefined) task.sessionId = sessionId || '';
    return task;
  });
}

// ── 多实例认领 ────────────────────────────────────────────────

/**
 * 尝试认领一个触发时刻。原子（wx）：
 * @returns {Promise<boolean>} true = 本进程抢到了，去执行；false = 已被认领
 */
export async function claimFire(taskId, key) {
  await fsp.mkdir(SCHEDULE_CLAIMS_DIR, { recursive: true });
  const file = path.join(SCHEDULE_CLAIMS_DIR, `${taskId}__${key}.json`);
  let fh;
  try {
    fh = await fsp.open(file, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    await fh.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf-8');
  } finally {
    await fh.close().catch(() => {});
  }
  return true;
}

/** 清理过期认领文件（保留近两天的，供诊断"为什么这轮没跑"） */
export async function cleanClaims(maxAgeMs = CLAIM_TTL_MS) {
  const now = Date.now();
  let files = [];
  try {
    files = await fsp.readdir(SCHEDULE_CLAIMS_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const f of files) {
    const full = path.join(SCHEDULE_CLAIMS_DIR, f);
    try {
      const st = await fsp.stat(full);
      if (now - st.mtimeMs > maxAgeMs) {
        await fsp.unlink(full);
        removed++;
      }
    } catch { /* 单个文件失败不影响清理 */ }
  }
  return removed;
}

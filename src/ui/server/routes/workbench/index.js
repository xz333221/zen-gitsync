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
// 工作台路由入口。
//
// 历史背景：本文件曾是 3539 行的巨型文件，包含所有顶层工具函数 + 45 个路由端点。
// 2026-06-29 按业务域拆分为 workbench/ 子目录的 9 个模块：
//   - shared.js          常量 + 通用工具 (nowIso, genId, readJson, writeJson, interpolate)
//   - jsonParse.js       从 LLM 输出里抠 JSON 的纯函数
//   - llmClient.js       LLM 客户端 (callLlmJson, callLlmStream)
//   - projectScan.js     子项目识别 (findSubProjects, detectProjectManifest)
//   - attachmentUtils.js 附件白名单 (sanitizeExt, resolveExt, MIME_TO_EXT)
//   - jobStore.js        jobs Map + bus + 持久化 + retention
//   - taskRunner.js      任务执行引擎 (runSingleSubtask —— 一次任务 = 一次会话)
//
// 本文件（index.js）只做 registerWorkbenchRoutes 入口聚合，按业务域分节注册路由。
// 错误处理：
//   - 非 SSE 路由统一用 asyncRoute 包装，handler 内部不再写 try/catch
//   - 异常自动走 asyncRoute → 全局 errorHandler 中间件（server/index.js 注册）
//   - SSE 路由保留 try/catch：错误必须以 SSE data 帧 format 发出，不能转 JSON
//   - handler 抛 HttpError(statusCode, msg) 可定制状态码

import path from 'path';
import { execFile } from 'child_process';
import express from 'express';
import { asyncRoute, HttpError } from '../../utils/asyncRoute.js';

import {
  logger,
  fs,
  fsp,
  TASKS_FILE,
  JOBS_FILE,
  TRUTH_FILES,
  IMAGES_DIR,
  MAX_IMAGE_BYTES,
  MAX_DEFAULT_PROMPT_CHARS,
  MAX_INSTRUCTION_CHARS,
  INSTRUCTION_PREVIEW_CHARS,
  readJson,
  writeJson,
  nowIso,
  genId,
} from './shared.js';
import {
  isImageExt,
  resolveExt,
  ALLOWED_EXTS,
  ensureImagesDir,
  DISPATCH_STAGING_DIR,
  isSafeAttId,
  mimeForExt,
  findStagingFile,
  cleanupDispatchStaging,
} from './attachmentUtils.js';
import {
  resolveJobImagePath,
  isInsideRoot,
  IMAGE_PATH_ERRORS,
  IMAGE_PATH_STATUS,
} from './jobImage.js';
import {
  jobs,
  bus,
  cancelledJobs,
  serializeJob,
  flushJobsSaveNow,
  clearOwnLiveJobsFile,
  readJobsConfig,
  writeJobsConfig,
  enforceRetention,
  publish,
  snapshotJobs,
  refreshJobsFromDisk,
  mergedJobs,
} from './jobStore.js';
import {
  normalizeTaskExecutor,
  runSingleSubtask,
  setEnvContextProvider,
} from './taskRunner.js';
import {
  listProjects,
  groupJobsByTask,
  decorateTaskForBoard,
  resolveTaskRepoPath,
  buildTaskDetail,
  buildProjectEntries,
  canonicalProjectPath,
} from './projectRegistry.js';
import { buildEnvContextBlock } from './envContext.js';
import { readHiddenProjects, hideProject, filterHiddenProjects } from './hiddenProjects.js';
import { ensureMemoryStore } from '../../../../memory/store.js';
import { createJobSettledRefresher } from '../aiContext/jobRefresh.js';
import {
  createDispatcher,
  resolveExecutor,
} from './dispatchInstruction.js';
import {
  readOrchestrator,
  setOrchestratorActive,
  setDefaultPrompt,
  setProjectPrompt,
  buildActivityFeed,
  buildRunningAgents,
  setReportIntervalMs,
  claimReportSlot,
  readReports,
  appendReport,
  withInstructionPreview,
} from './orchestratorStore.js';
import {
  buildRunningFacts,
  generateProgressReport,
} from './progressReport.js';
import {
  applyStallVerdict,
  buildStallFact,
  judgeStalledJob,
  shouldCheckStall,
} from './stallWatchdog.js';
import { detectExecutorModels, formatExecutorModel } from './executorModels.js';

/**
 * 「任务结束 → 刷快照」的监听器。存成模块级的，是为了在重复装配路由时
 * 先把上一个摘掉（bus 是模块级单例，否则同一次 job 结束会被刷好几遍）。
 * @type {((evt: object) => boolean)|null}
 */
let jobSettledHandler = null;

/** 自动进度报告的定时器。同上：重复装配路由时先清掉上一个 */
let reportTimer = null;

/** 静默看门狗的定时器（与报告同一个粒度，各自独立装配/清理） */
let stallTimer = null;

/** 自动报告的检查粒度。它**不等于**报告间隔 —— 见 tickProgressReport 的注释 */
const REPORT_TICK_MS = 30 * 1000;

/**
 * 注册所有 workbench 路由（共 45 个端点）。
 * @param {Object} deps
 * @param {import('express').Express} deps.app
 * @param {() => string} deps.getCurrentProjectPath
 * @param {() => string} deps.getProjectRoomId
 * @param {import('socket.io').Server} deps.io
 * @param {Object} deps.configManager
 * @param {() => object|null} [deps.getAiContextSnapshotter]
 *        工作区状态快照生成器（延迟取值的 getter，见下面 setEnvContextProvider 的注释）
 */
export function registerWorkbenchRoutes({
  app,
  getCurrentProjectPath,
  getProjectRoomId,
  io,
  configManager,
  getAiContextSnapshotter,
}) {

  // ════════════════════════════════════════════════════════════════════════
  // §3. SSE 事件流（订阅 job/sub/task 更新）
  // ════════════════════════════════════════════════════════════════════════
  app.get('/api/workbench/events', asyncRoute(async (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    // 先把 jobs.json 刷进缓存——别的 g ui 进程跑的 job 只在那里。刷新放在这里
    // (await 完再往下走),是为了让后面的「取快照 → 发 hello → 注册 handler」保持
    // 全同步:中间没有 await 就不会有 job:update 插到 hello 前面去。
    await refreshJobsFromDisk();
    const send = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    // 初始快照
    send({ event: 'hello', payload: { jobs: snapshotJobs() }, ts: nowIso() });
    const handler = (evt) => send(evt);
    bus.on('event', handler);
    const ka = setInterval(() => res.write(`: keep-alive\n\n`), 15000);
    req.on('close', () => {
      clearInterval(ka);
      bus.off('event', handler);
    });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §11. 任务 CRUD
  // ════════════════════════════════════════════════════════════════════════
  app.get('/api/workbench/tasks', asyncRoute(async (_req, res) => {
    const data = await readJson(TASKS_FILE, { tasks: [] });
    res.json({ success: true, tasks: data.tasks || [] });
  }));

  app.get('/api/workbench/current-project', asyncRoute(async (_req, res) => {
    const projectPath = typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '';
    const projectName = projectPath ? projectPath.split(/[\\/]/).filter(Boolean).pop() : '';
    res.json({ success: true, projectPath, projectName });
  }));

  // 任务排序：拖动落盘。body: { orderedIds, groupPath? }
  app.put('/api/workbench/tasks/reorder', asyncRoute(async (req, res) => {
    const orderedIds = Array.isArray(req.body && req.body.orderedIds) ? req.body.orderedIds : null;
    const groupPath = typeof (req.body && req.body.groupPath) === 'string' ? req.body.groupPath.trim() || null : null;
    if (!orderedIds || orderedIds.length === 0) throw new HttpError(400, 'orderedIds 不能为空');
    if (!orderedIds.every((x) => typeof x === 'string' && x.length > 0)) {
      throw new HttpError(400, 'orderedIds 必须是字符串数组');
    }
    if (new Set(orderedIds).size !== orderedIds.length) {
      throw new HttpError(400, 'orderedIds 包含重复 id');
    }
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const tasks = data.tasks || [];
    const idIndex = new Map();
    for (let i = 0; i < tasks.length; i++) idIndex.set(tasks[i].id, i);
    const missing = orderedIds.filter((id) => !idIndex.has(id));
    if (missing.length > 0) {
      throw new HttpError(400, `id 不存在: ${missing.slice(0, 3).join(',')}`);
    }

    // groupPath 完整性校验
    if (groupPath) {
      const groupKey = groupPath || '__no_project__';
      const groupTasks = tasks.filter(t => ((t.projectPath || '').trim() || '__no_project__') === groupKey);
      if (groupTasks.length > 0 && orderedIds.length !== groupTasks.length) {
        throw new HttpError(400, `orderedIds 不完整：该组有 ${groupTasks.length} 个任务，但只传了 ${orderedIds.length} 个 id`);
      }
      const nonGroupIds = orderedIds.filter(id => {
        const t = tasks.find(x => x.id === id);
        return !t || ((t.projectPath || '').trim() || '__no_project__') !== groupKey;
      });
      if (nonGroupIds.length > 0) {
        throw new HttpError(400, `以下 id 不属于指定分组: ${nonGroupIds.slice(0, 3).join(',')}`);
      }
    }

    // 安全重排：用 Map 按序取
    const orderedSet = new Set(orderedIds);
    const byId = new Map(tasks.map(t => [t.id, t]));
    const reordered = [];
    let ptr = 0;
    for (const t of tasks) {
      if (orderedSet.has(t.id)) {
        if (ptr < orderedIds.length) {
          const target = byId.get(orderedIds[ptr++]);
          if (target) {
            reordered.push(target);
            continue;
          }
        }
        reordered.push(t);
      } else {
        reordered.push(t);
      }
    }
    // 最终校验：数量必须一致（绝对不能丢任务）
    if (reordered.length !== tasks.length) {
      logger.error('[reorder] 数据丢失风险！原始 %d 个，重排后 %d 个', tasks.length, reordered.length);
      throw new HttpError(500, '内部错误：重排结果数量不一致');
    }
    data.tasks = reordered;
    await writeJson(TASKS_FILE, data);
    publish('tasks:reordered', { tasks: reordered });
    res.json({ success: true, tasks: reordered });
  }));

  app.post('/api/workbench/tasks', asyncRoute(async (req, res) => {
    const { id, title, desc, simpleOverride } = req.body || {};
    const safeTitle = typeof title === 'string' ? title.trim() : '';
    const safeOverride = typeof simpleOverride === 'string' ? simpleOverride.slice(0, 8000) : '';
    // promptParts 是任务详情「提示词」区的只读分段快照（复制任务时透传），执行链路不读它
    const rawParts = req.body?.promptParts;
    const safeParts = rawParts && typeof rawParts === 'object'
      ? {
          global: typeof rawParts.global === 'string' ? rawParts.global.slice(0, 8000) : '',
          project: typeof rawParts.project === 'string' ? rawParts.project.slice(0, 8000) : '',
        }
      : null;
    // 显式指定的归属项目（多项目编排台传选中项目）；不传则沿用当前项目。
    // 只影响**新建**，更新分支一律保留任务原有的 projectPath（否则编辑一次就会把任务挪到当前项目去）。
    const bodyProjectPath = typeof req.body?.projectPath === 'string' ? req.body.projectPath.trim() : '';
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const tasks = data.tasks || [];
    const now = nowIso();
    const currentProjectPath = typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '';
    if (id) {
      const i = tasks.findIndex(t => t.id === id);
      if (i < 0) throw new HttpError(404, '任务不存在');
      tasks[i] = {
        ...tasks[i],
        title: safeTitle,
        desc: desc || '',
        updatedAt: now
      };
      // simpleOverride 是派发时的提示词快照：只在调用方显式带了字符串时才覆盖，
      // 缺省不能清空（否则编辑器把整 task 体提交一遍就把提示词抹掉了）
      if (typeof simpleOverride === 'string') tasks[i].simpleOverride = safeOverride;
      await writeJson(TASKS_FILE, { tasks });
      return res.json({ success: true, task: tasks[i] });
    }
    const task = {
      id: genId(),
      title: safeTitle,
      desc: desc || '',
      simpleOverride: safeOverride,
      projectPath: bodyProjectPath || currentProjectPath || '',
      status: 'todo',
      createdAt: now,
      updatedAt: now
    };
    if (safeParts && (safeParts.global || safeParts.project)) task.promptParts = safeParts;
    tasks.push(task);
    await writeJson(TASKS_FILE, { tasks });
    res.json({ success: true, task });
  }));

  app.delete('/api/workbench/tasks/:id', asyncRoute(async (req, res) => {
    const taskId = req.params.id;
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const allTasks = data.tasks || [];
    const task = allTasks.find(t => t.id === taskId);
    if (!task) throw new HttpError(404, '任务不存在');

    // 检查活跃 job —— 有 running/pending 直接拒绝
    const live = [];
    for (const j of jobs.values()) {
      if (j.taskId !== taskId) continue;
      if (j.status === 'running' || j.status === 'pending') live.push(j.id);
    }
    if (live.length > 0) {
      throw new HttpError(400, `有 ${live.length} 个 job 正在执行,请先停止`);
    }

    // 清理磁盘上的图片目录（失败只 warn 不阻断）
    try {
      await fsp.rm(path.join(IMAGES_DIR, '_task-' + taskId), { recursive: true, force: true });
    } catch (e) {
      logger.warn(`[workbench] failed to remove task image dir for ${taskId}: ${e.message}`);
    }

    const tasks = allTasks.filter(t => t.id !== taskId);
    await writeJson(TASKS_FILE, { tasks });
    res.json({ success: true });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §12. 执行任务（每个任务都是一次会话）
  // ════════════════════════════════════════════════════════════════════════
  app.post('/api/workbench/tasks/:id/run', asyncRoute(async (req, res) => {
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const task = (data.tasks || []).find(t => t.id === req.params.id);
    if (!task) throw new HttpError(404, '任务不存在');
    // 兜底：磁盘上没有 running 状态，但还有 job 在跑（可能是别的 g ui 起的），也拦一下。
    // 先刷磁盘再取快照，否则另一个实例正在跑的这个任务会被重复起一份。
    await refreshJobsFromDisk();
    const liveJob = snapshotJobs().find(j => j.taskId === task.id && (j.status === 'running' || j.status === 'pending'));
    if (liveJob) throw new HttpError(400, '该任务已有正在执行的 job');
    const repoPath = resolveTaskRepoPath(task, typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '');
    const executor = await resolveExecutor(req.body?.executor, configManager);
    const virtualSub = {
      id: `${task.id}__simple`,
      title: task.title,
      desc: task.desc || '',
      status: 'todo',
      promptOverride: task.simpleOverride || '',
      attachments: Array.isArray(task.attachments) ? task.attachments : []
    };
    res.json({ success: true, message: '已开始执行任务' });
    runSingleSubtask(task, virtualSub, repoPath, '', { executor }).catch(err => {
      publish('task:error', { taskId: task.id, error: err.message });
    });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §12.5 手动标记「已完成」/ 撤销这个标记
  //   POST   /api/workbench/tasks/:id/done
  //   DELETE /api/workbench/tasks/:id/done
  //
  // 列本来是纯推导的（projectRegistry.deriveTaskColumn），但有两件事推不出来 ——
  // 一条待在「待处理」里的任务其实早在别处干完了；一条「进行中」的任务模型已经不说话了、
  // 用户比静默看门狗更早判断它干完了。这两件事只有人知道，所以给一个人工落点：
  // 写 task.manualDoneAt，列由它推导（判据与失效条件都在 deriveTaskColumn 的注释里）。
  //
  // 为什么标记写在 task 上、而不是补一条 job：job 是「这轮执行发生了什么」的事实记录，
  // 混进人工判断之后，"跑了多久 / 谁跑的 / 输出了什么"就再也分不清真假了。
  // ════════════════════════════════════════════════════════════════════════

  app.post('/api/workbench/tasks/:id/done', asyncRoute(async (req, res) => {
    const taskId = req.params.id;
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const task = (data.tasks || []).find(t => t && t.id === taskId);
    if (!task) throw new HttpError(404, '任务不存在');

    // 标「已完成」的同时把这一轮停掉：一张卡片不能既是"已完成"又还在跑
    // （列的口径是"在跑 ⇔ 进行中"，不先停就会当场翻回去，用户以为按钮坏了）。
    // 先刷磁盘再取快照 —— 别的实例刚起的 job 也要看得到（与 /tasks/:id/run 同一口径）。
    await refreshJobsFromDisk();
    const liveJobs = [];
    for (const j of mergedJobs().values()) {
      if (!j || j.taskId !== taskId) continue;
      if (j.status !== 'running' && j.status !== 'pending') continue;
      const local = jobs.get(j.id);
      // child 句柄只活在跑它的那个进程里，别的实例起的 job 这里停不掉 ——
      // 那就别假装标成功。这句话与 §14 的取消路由**逐字一致**：
      // 同一个事实在两个入口有两种说法，用户会以为是两件事。
      if (!local) throw new HttpError(404, '这个任务正在另一个 g ui 实例里执行，请到那个窗口停止它');
      liveJobs.push(local);
    }
    for (const j of liveJobs) {
      try {
        cancelRunningJob(j);
      } catch (err) {
        throw new HttpError(500, '停止这一轮执行失败: ' + err.message);
      }
    }

    const now = nowIso();
    task.manualDoneAt = now;
    task.updatedAt = now;
    await writeJson(TASKS_FILE, data);
    publish('task:update', task);
    res.json({ success: true, task, stoppedJobs: liveJobs.length });
  }));

  app.delete('/api/workbench/tasks/:id/done', asyncRoute(async (req, res) => {
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const task = (data.tasks || []).find(t => t && t.id === req.params.id);
    if (!task) throw new HttpError(404, '任务不存在');
    // 幂等：没标过也回成功。撤销是"点错了要退回来"的动作，为它再弹一个错误没有意义。
    // 撤销之后回到哪一列由执行事实说了算 —— 最近一条 job 是跑完的，它本来就该在「已完成」。
    if (task.manualDoneAt) {
      delete task.manualDoneAt;
      task.updatedAt = nowIso();
      await writeJson(TASKS_FILE, data);
      publish('task:update', task);
    }
    res.json({ success: true, task });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §13. Job 查询（兜底，SSE 断了也能拉）
  // ════════════════════════════════════════════════════════════════════════
  app.get('/api/workbench/jobs', asyncRoute(async (_req, res) => {
    // 与看板同源：磁盘 ∪ 内存（内存优先）。之前这里自己拼「文件 + 内存里非文件的」，
    // 优先级正好反过来 —— 正在跑的 job 显示的是磁盘上 1.5s 前的旧快照。
    await refreshJobsFromDisk();
    res.json({ success: true, jobs: snapshotJobs() });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §14. 取消正在执行的 job
  // ════════════════════════════════════════════════════════════════════════

  /**
   * 停掉**本进程**里正在跑的一个 job：先落终态 + 广播，再杀进程树。
   *
   * 抽出来是因为 §12.5 的「手动标记完成」也要用它（标完成时这一轮必须先停下来）——
   * 两处各写一份杀进程的逻辑，早晚会分叉成"一个入口停得掉、另一个停不干净"，
   * 而且分叉了不报错，只有用户能看见：一张卡片停在「进行中」不动。
   *
   * **调用方负责判断这个 job 归不归本进程管**：child 句柄只活在跑它的那个进程里，
   * 别的 g ui 实例起的 job 在这里只有一条磁盘记录（§14 的路由为这种情况单独给了 404
   * 与一句明确的话；§12.5 则直接拒绝落标记）。
   *
   * @returns {boolean} 是否真的发了信号（false = 只是改了状态，进程句柄不在手上）
   */
  function cancelRunningJob(job) {
    cancelledJobs.add(job.id);
    // 立即给前端一个状态反馈（不等 child 真正退出）
    job.status = 'cancelled';
    job.error = '用户已停止执行';
    job.endedAt = nowIso();
    publish('job:update', { ...job }); // 浅拷贝避免序列化 child 引用
    // 终态：fire-and-forget 同步落盘
    flushJobsSaveNow().catch(err => logger.warn('[workbench] jobs save failed:', err.message));

    const child = job.child;
    if (!child) return false;
    try {
      if (process.platform === 'win32') {
        // Windows: child.kill(SIGTERM) 经常无效，用 taskkill 杀进程树
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (err) => {
          if (err) {
            logger.warn(`[workbench] taskkill ${child.pid} 失败: ${err.message}`);
          }
        });
      } else {
        child.kill('SIGTERM');
      }
      return true;
    } catch (err) {
      cancelledJobs.delete(job.id);
      throw err;
    }
  }

  app.post('/api/workbench/jobs/:id/cancel', asyncRoute(async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      // 看板现在能看到**别的 g ui 实例**正在跑的 job(执行记录合并了),但 child 句柄
      // 只活在跑它的那个进程里 —— 这里停不了。给个说得清的理由,别让用户对着
      // "job 不存在"发懵(他明明在卡片上看着它转)。
      await refreshJobsFromDisk();
      throw new HttpError(404, mergedJobs().has(req.params.id)
        ? '这个任务正在另一个 g ui 实例里执行，请到那个窗口停止它'
        : 'job 不存在');
    }
    if (job.status !== 'running' && job.status !== 'pending') {
      throw new HttpError(400, `当前状态 ${job.status} 不可取消`);
    }
    let signalled;
    try {
      signalled = cancelRunningJob(job);
    } catch (err) {
      throw new HttpError(500, '发送停止信号失败: ' + err.message);
    }
    res.json({
      success: true,
      message: signalled ? '已发送停止信号' : '已标记取消，进程将尽快结束'
    });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §15. 续接简单任务对话（基于上一轮 claudeSessionId 用 --resume 续接）
  // ════════════════════════════════════════════════════════════════════════
  app.post('/api/workbench/jobs/:id/continue', asyncRoute(async (req, res) => {
    const userMessage = String(req.body?.userMessage || '').trim();
    if (!userMessage) throw new HttpError(400, 'userMessage 不能为空');
    const prevJob = jobs.get(req.params.id);
    if (!prevJob) throw new HttpError(404, 'job 不存在');
    if (prevJob.status === 'running' || prevJob.status === 'pending') {
      throw new HttpError(400, '上一轮还在执行,请等结束后再续接');
    }
    if (!prevJob.claudeSessionId) {
      throw new HttpError(400, '无法续接:会话标识未捕获');
    }
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const task = (data.tasks || []).find(t => t.id === prevJob.taskId);
    if (!task) throw new HttpError(404, '所属任务不存在');
    // 计算续接轮次号
    const subIdPrefix = `${task.id}__simple`;
    let maxRound = 0;
    for (const j of jobs.values()) {
      if (j.taskId !== task.id) continue;
      if (j.subId === subIdPrefix) continue;
      const m = j.subId && j.subId.match(/__simple__r(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!isNaN(n) && n > maxRound) maxRound = n;
      }
    }
    const nextRound = maxRound + 1;
    const bodyAtts = req.body?.attachments;
    const carryAtts = Array.isArray(bodyAtts) && bodyAtts.length > 0
      ? bodyAtts
      : (Array.isArray(task.attachments) ? task.attachments : []);
    const virtualSub = {
      id: `${task.id}__simple__r${nextRound}`,
      title: `续接 #${nextRound}`,
      desc: '',
      status: 'todo',
      promptOverride: userMessage,
      attachments: carryAtts
    };
    // 工作目录口径必须与「执行任务」那条路一致：**任务自己的项目优先**，没有才回落当前项目
    // （resolveTaskRepoPath）。这里以前直接用 getCurrentProjectPath()，于是"在 B 项目里打开
    // A 项目的任务续聊"会把 CLI spawn 到 B（甚至空路径 → process.cwd()，即服务器所在的仓库）：
    // 续接的这轮在错误的工作区里干活，而 --resume 又把上下文带过来了，症状很隐蔽。
    // 2026-09-30 由 verify:wb-env-context 第 8 组抓到（续聊轮的 prompt 里出现的不是任务的项目）。
    const repoPath = resolveTaskRepoPath(task, typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '');
    res.json({ success: true, message: '已加入续接队列' });
    // 执行器必须沿用上一轮 job 的 agent：claude 的 --resume 和 opencode 的 --session
    // 互不认对方的会话 id，串了执行器续接必然失败。
    runSingleSubtask(task, virtualSub, repoPath, '', {
      resumeSessionId: prevJob.claudeSessionId,
      executor: normalizeTaskExecutor(prevJob.agent)
    })
      .catch(err => {
        publish('task:error', { taskId: task.id, error: err.message });
      });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §16. 执行日志管理 API（持久化 + 清理）
  // /list、/config、/batch-delete、/clear 是字面路径，必须排在 :id 之前注册
  // ════════════════════════════════════════════════════════════════════════
  async function loadAllJobs() {
    // 与看板同源：磁盘 ∪ 内存（内存优先）。理由同 GET /api/workbench/jobs。
    await refreshJobsFromDisk();
    const tasksData = await readJson(TASKS_FILE, { tasks: [] });
    const taskMap = new Map((tasksData.tasks || []).map(t => [t.id, t]));
    return Array.from(mergedJobs().values()).map(j => serializeJob(j, taskMap));
  }

  function applyJobsFilter(list, q) {
    const status = (q.status || '').trim();
    const taskId = (q.taskId || '').trim();
    const term = (q.q || '').trim().toLowerCase();
    return list.filter(j => {
      if (status && j.status !== status) return false;
      if (taskId && j.taskId !== taskId) return false;
      if (term) {
        const hay = `${j.title || ''} ${j.taskTitle || ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }

  app.get('/api/workbench/jobs/list', asyncRoute(async (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const all = await loadAllJobs();
    const filtered = applyJobsFilter(all, req.query);
    const sortKey = (j) => j.endedAt || j.startedAt || j.id || '';
    filtered.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);
    const byStatus = {};
    let totalSize = 0;
    for (const j of all) {
      byStatus[j.status] = (byStatus[j.status] || 0) + 1;
      totalSize += j.size || 0;
    }
    res.json({
      success: true,
      jobs: page,
      total,
      stats: { count: all.length, sizeMB: +(totalSize / 1024 / 1024).toFixed(2), byStatus }
    });
  }));

  app.get('/api/workbench/jobs/config', asyncRoute(async (_req, res) => {
    res.json({ success: true, config: await readJobsConfig() });
  }));

  app.put('/api/workbench/jobs/config', asyncRoute(async (req, res) => {
    const cfg = await writeJobsConfig(req.body || {});
    // 配置变更后立刻 enforce，让已落盘的多余记录立刻被裁掉
    await enforceRetention();
    res.json({ success: true, config: cfg });
  }));

  app.post('/api/workbench/jobs/batch-delete', asyncRoute(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(s => typeof s === 'string') : [];
    if (ids.length === 0) return res.json({ success: true, removed: 0 });
    let removed = 0;
    for (const id of ids) {
      if (jobs.delete(id)) removed++;
    }
    const data = await readJson(JOBS_FILE, { version: 1, jobs: [] });
    if (data && Array.isArray(data.jobs)) {
      const set = new Set(ids);
      const before = data.jobs.length;
      data.jobs = data.jobs.filter(j => !set.has(j.id));
      removed += before - data.jobs.length;
      await writeJson(JOBS_FILE, data);
    }
    res.json({ success: true, removed });
  }));

  app.post('/api/workbench/jobs/clear', asyncRoute(async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, '需要 confirm: true');
    let removed = 0;
    for (const j of jobs.values()) {
      // 不清当前还在跑/排队的
      if (j.status === 'running' || j.status === 'pending') continue;
      jobs.delete(j.id);
      removed++;
    }
    await writeJson(JOBS_FILE, { version: 1, jobs: [] });
    res.json({ success: true, removed });
  }));

  app.delete('/api/workbench/jobs/by-task/:taskId', asyncRoute(async (req, res) => {
    const taskId = req.params.taskId;
    if (!taskId) throw new HttpError(400, '缺少 taskId');
    const keepDone = String(req.query.keepDone || '').toLowerCase() === 'true';
    const ids = [];
    for (const j of jobs.values()) {
      if (j.taskId !== taskId) continue;
      if (j.status === 'running' || j.status === 'pending') continue;
      if (keepDone && j.status === 'done') continue;
      jobs.delete(j.id);
      ids.push(j.id);
    }
    const data = await readJson(JOBS_FILE, { version: 1, jobs: [] });
    if (data && Array.isArray(data.jobs)) {
      const before = data.jobs.length;
      data.jobs = data.jobs.filter(j => {
        if (j.taskId !== taskId) return true;
        if (keepDone && j.status === 'done') return true;
        return !ids.includes(j.id);
      });
      const removed = before - data.jobs.length;
      if (removed > 0) await writeJson(JOBS_FILE, data);
      return res.json({ success: true, removed: ids.length + removed, ids });
    }
    res.json({ success: true, removed: ids.length, ids });
  }));

  app.post('/api/workbench/tasks/:id/clear-execution', asyncRoute(async (req, res) => {
    const taskId = req.params.id;
    if (!taskId) throw new HttpError(400, '缺少 taskId');
    // 检查活跃 job
    const live = [];
    for (const j of jobs.values()) {
      if (j.taskId !== taskId) continue;
      if (j.status === 'running' || j.status === 'pending') live.push(j.id);
    }
    if (live.length > 0) {
      throw new HttpError(400, `有 ${live.length} 个 job 正在执行,请先停止`);
    }
    // 1) 清空 jobs(内存 + 磁盘)
    const removedJobIds = [];
    for (const j of jobs.values()) {
      if (j.taskId !== taskId) continue;
      jobs.delete(j.id);
      removedJobIds.push(j.id);
    }
    const jobsData = await readJson(JOBS_FILE, { version: 1, jobs: [] });
    if (jobsData && Array.isArray(jobsData.jobs)) {
      const before = jobsData.jobs.length;
      jobsData.jobs = jobsData.jobs.filter(j => j.taskId !== taskId);
      if (jobsData.jobs.length !== before) await writeJson(JOBS_FILE, jobsData);
    }
    // 2) 不用再改任务本体 —— 看板列完全由 job 推导，job 没了自然回到「待执行」
    res.json({
      success: true,
      removedJobs: removedJobIds.length,
      message: `已清空 ${removedJobIds.length} 条执行记录`
    });
  }));

  app.post('/api/workbench/tasks/:id/reset-shell', asyncRoute(async (req, res) => {
    const taskId = req.params.id;
    if (!taskId) throw new HttpError(400, '缺少 taskId');
    const live = [];
    for (const j of jobs.values()) {
      if (j.taskId !== taskId) continue;
      if (j.status === 'running' || j.status === 'pending') live.push(j.id);
    }
    if (live.length > 0) {
      throw new HttpError(400, `有 ${live.length} 个 job 正在执行,请先停止`);
    }
    const removedJobIds = [];
    for (const j of jobs.values()) {
      if (j.taskId !== taskId) continue;
      jobs.delete(j.id);
      removedJobIds.push(j.id);
    }
    const jobsData = await readJson(JOBS_FILE, { version: 1, jobs: [] });
    if (jobsData && Array.isArray(jobsData.jobs)) {
      const before = jobsData.jobs.length;
      jobsData.jobs = jobsData.jobs.filter(j => j.taskId !== taskId);
      if (jobsData.jobs.length !== before) await writeJson(JOBS_FILE, jobsData);
    }
    const tasksData = await readJson(TASKS_FILE, { tasks: [] });
    const task = (tasksData.tasks || []).find(t => t.id === taskId);
    if (!task) {
      return res.json({ success: true, removedJobs: removedJobIds.length, message: '任务不存在,仅清空 job' });
    }
    const removedAttCount = Array.isArray(task.attachments) ? task.attachments.length : 0;
    const hadDesc = !!(task.desc && task.desc.length > 0);
    // 提示词快照（simpleOverride / promptParts）随 desc 一起清 —— 这个动作的语义是"回到空任务"
    const hadPrompt = !!(task.simpleOverride || task.promptParts);
    const preservedProjectPath = task.projectPath;
    const preservedCreatedAt = task.createdAt;
    const preservedStatus = task.status || 'todo';
    const newTask = { id: task.id, title: task.title, status: preservedStatus };
    if (preservedProjectPath) newTask.projectPath = preservedProjectPath;
    if (preservedCreatedAt) newTask.createdAt = preservedCreatedAt;
    newTask.attachments = [];
    newTask.updatedAt = nowIso();
    for (const k of Object.keys(task)) delete task[k];
    Object.assign(task, newTask);
    await writeJson(TASKS_FILE, tasksData);
    publish('task:update', task);
    res.json({
      success: true,
      removedJobs: removedJobIds.length,
      removedAttachments: removedAttCount,
      clearedDesc: hadDesc,
      clearedPrompt: hadPrompt,
      message: `已清空:${removedAttCount ? '删除 ' + removedAttCount + ' 个附件' : '无附件'}${hadDesc ? '、任务描述' : ''},任务标题保留`
    });
  }));


  // GET /api/workbench/jobs/:id  (放在所有字面路径之后)
  app.get('/api/workbench/jobs/:id', asyncRoute(async (req, res) => {
    // 优先查内存（含活跃）
    const live = jobs.get(req.params.id);
    const tasksData = await readJson(TASKS_FILE, { tasks: [] });
    const taskMap = new Map((tasksData.tasks || []).map(t => [t.id, t]));
    if (live) {
      return res.json({ success: true, job: serializeJob(live, taskMap) });
    }
    // 退回「磁盘历史 ∪ 别的实例正在跑」的合并表 —— 光读 jobs.json 会让
    // "看板上明明在转的那条"点开变成 404(运行中的记录不在历史档案里)。
    await refreshJobsFromDisk();
    const j = mergedJobs().get(req.params.id);
    if (!j) throw new HttpError(404, 'job 不存在');
    res.json({ success: true, job: serializeJob(j, taskMap) });
  }));

  // GET /api/workbench/jobs/:id/image?path=…  —— 正文内嵌图片（模型写 ![说明](本机路径)）
  //
  // 为什么要有这个端点：执行器在本机干活，"展示一张图"最自然的写法是贴一条本机路径，
  // 而对话流是 markdown 渲染 —— `<img src="c:\ws\repo\docs\a.png">` 在浏览器里永远是
  // 裂图。前端把这类路径重写成这个 URL（utils/localImageSrc.ts，两处对话流共用）。
  //
  // 权限边界 =「这个 job 所属仓库内的图片文件」（判定见 jobImage.js）：
  //   · 后缀过 IMAGE_EXTS 白名单；路径必须落在仓库根内（`..` 穿越在那里就挡掉了）；
  //   · 这里**再按 realpath 校验一次** —— lexical 判定挡不住仓库里一个指向外部的
  //     符号链接，而仓库内容很可能是从网上 clone 来的；
  //   · 响应带 nosniff + CSP(sandbox)：同上前提下，一份恶意 SVG 被直接在浏览器里
  //     打开时，它的脚本不能跑在本应用的源上（<img> 里本来就不会执行，这里防的是直接访问）。
  app.get('/api/workbench/jobs/:id/image', asyncRoute(async (req, res) => {
    const id = req.params.id;
    // 优先内存；退回「磁盘历史 ∪ 别的实例正在跑」的合并表 —— 看板上能看到、日志也能
    // 在本实例渲染的 job，它的图不该因为"不是这个进程起的"就裂掉（与 GET /jobs/:id 同源）。
    let job = jobs.get(id);
    if (!job) {
      await refreshJobsFromDisk();
      job = mergedJobs().get(id);
    }
    if (!job) throw new HttpError(404, 'job 不存在');

    const tasksData = await readJson(TASKS_FILE, { tasks: [] });
    const task = (tasksData.tasks || []).find(t => t.id === job.taskId);
    const root = resolveTaskRepoPath(
      task,
      typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '',
    );

    const resolved = resolveJobImagePath({ root, requested: req.query.path });
    if (!resolved.ok) {
      throw new HttpError(
        IMAGE_PATH_STATUS[resolved.reason] || 400,
        IMAGE_PATH_ERRORS[resolved.reason] || '图片路径不合法',
      );
    }

    let realFile;
    try {
      realFile = await fsp.realpath(resolved.absPath);
    } catch {
      throw new HttpError(404, '图片不存在（模型给的路径在本机读不到）');
    }
    let realRoot;
    try {
      realRoot = await fsp.realpath(root);
    } catch {
      realRoot = root; // 仓库根都没了的话，下面那次 stat 也会失败，不必在这里另报一种错
    }
    if (!isInsideRoot(realRoot, realFile)) {
      throw new HttpError(IMAGE_PATH_STATUS['outside-root'], IMAGE_PATH_ERRORS['outside-root']);
    }

    let stat;
    try {
      stat = await fsp.stat(realFile);
    } catch {
      throw new HttpError(404, '图片不存在（模型给的路径在本机读不到）');
    }
    if (!stat.isFile()) throw new HttpError(404, '路径不是一个文件');
    // 与附件同一个上限：正文里嵌一张 20MB 以上的图只会把页面拖死
    if (stat.size > MAX_IMAGE_BYTES) {
      throw new HttpError(413, `图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB，未加载`);
    }

    // mime 按**后缀**给（不读文件头）：后缀已过白名单，且这条内容只喂给 <img>
    res.set('Content-Type', resolved.mime);
    res.set('Content-Length', String(stat.size));
    res.set('Content-Disposition', 'inline');
    res.set('Cache-Control', 'private, max-age=300');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    const stream = fs.createReadStream(realFile);
    stream.on('error', () => res.end());
    stream.pipe(res);
  }));

  app.delete('/api/workbench/jobs/:id', asyncRoute(async (req, res) => {
    const id = req.params.id;
    let removed = false;
    if (jobs.delete(id)) removed = true;
    const data = await readJson(JOBS_FILE, { version: 1, jobs: [] });
    if (data && Array.isArray(data.jobs)) {
      const before = data.jobs.length;
      data.jobs = data.jobs.filter(j => j.id !== id);
      if (data.jobs.length !== before) {
        removed = true;
        await writeJson(JOBS_FILE, data);
      }
    }
    if (!removed) throw new HttpError(404, 'job 不存在');
    res.json({ success: true, removed: 1 });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §17. 附件：上传 / 删除 / 原文件读取
  // ════════════════════════════════════════════════════════════════════════
  const rawAttachment = express.raw({
    type: '*/*',
    // 路由上限 = 单文件上限的 2 倍：留出余量让超限请求落到业务层的 413（带"不得超过 XX MB"
    // 的可读文案），而不是 body-parser 直接抛的裸 entity.too.large
    limit: MAX_IMAGE_BYTES * 2
  });

  // 共享 helper：找到一个 attachment 所在的位置
  async function findAttachmentLocation(attId) {
    const data = await readJson(TASKS_FILE, { tasks: [] });
    for (const t of data.tasks || []) {
      const list = Array.isArray(t.attachments) ? t.attachments : [];
      const att = list.find(x => x.id === attId);
      if (att) {
        return { owner: 'task', task: t, list, att, storageDir: path.join(IMAGES_DIR, '_task-' + t.id) };
      }
    }
    return null;
  }

  // 共享 helper：写入新附件
  //
  // 只负责把字节落盘 + 造出附件记录，**不碰 target.attachments** —— 由调用方决定挂到哪。
  // 之前这里既 push 了一次、调用方又 push 一次，而两处指向同一个数组（target 是浅拷贝），
  // 于是每次上传都在 tasks.json 里留下一条 id 完全相同的幽灵附件：附件数翻倍、
  // 缩略图列表出现重复项，删一条另一条还在。
  async function writeAttachmentTo({ req, target }) {
    if (!req.body || !(req.body instanceof Buffer) || req.body.length === 0) {
      throw new HttpError(400, '请求体为空');
    }
    if (req.body.length > MAX_IMAGE_BYTES) {
      throw new HttpError(413, `单文件不得超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`);
    }
    const originalName = String(req.get('X-Original-Name') || 'attachment').slice(0, 200);
    const mimeType = String(req.get('X-Mime-Type') || 'application/octet-stream').slice(0, 120);
    const ext = resolveExt({ originalName, mime: mimeType });
    if (!ext) {
      throw new HttpError(400, `不支持的文件类型（仅允许 ${[...ALLOWED_EXTS].join(', ')}）`);
    }

    const attId = genId();
    await fsp.mkdir(target.storageDir, { recursive: true });
    const storedName = `${attId}.${ext}`;
    const storedPath = path.join(target.storageDir, storedName);
    await fsp.writeFile(storedPath, req.body);

    return {
      id: attId,
      originalName,
      mimeType,
      size: req.body.length,
      ext,
      storedName,
      absolutePath: storedPath,
      createdAt: nowIso()
    };
  }

  // 子任务附件
  // 任务附件
  app.post('/api/workbench/tasks/:taskId/attachments', rawAttachment, asyncRoute(async (req, res) => {
    const { taskId } = req.params;
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const task = (data.tasks || []).find(t => t.id === taskId);
    if (!task) throw new HttpError(404, '任务不存在');
    const target = { ...task, storageDir: path.join(IMAGES_DIR, '_task-' + taskId) };
    const att = await writeAttachmentTo({ req, target });
    task.attachments = Array.isArray(task.attachments) ? task.attachments : [];
    task.attachments.push(att);
    task.updatedAt = nowIso();
    await writeJson(TASKS_FILE, data);
    res.json({ success: true, attachment: att });
  }));

  app.delete('/api/workbench/tasks/:taskId/attachments/:attId', asyncRoute(async (req, res) => {
    const { taskId, attId } = req.params;
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const task = (data.tasks || []).find(t => t.id === taskId);
    if (!task) throw new HttpError(404, '任务不存在');
    const list = Array.isArray(task.attachments) ? task.attachments : [];
    const i = list.findIndex(a => a.id === attId);
    if (i < 0) throw new HttpError(404, '附件不存在');
    const [removed] = list.splice(i, 1);
    try {
      await fsp.unlink(path.join(IMAGES_DIR, '_task-' + taskId, removed.storedName));
    } catch { /* 文件可能已不存在 */ }
    task.updatedAt = nowIso();
    await writeJson(TASKS_FILE, data);
    res.json({ success: true });
  }));

  // 附件原文件读取（前端 <img> 缩略图用）—— 支持 task 和 sub 两种归属
  app.get('/api/workbench/attachments/:attId/raw', asyncRoute(async (req, res) => {
    const { attId } = req.params;
    const loc = await findAttachmentLocation(attId);
    if (!loc) throw new HttpError(404, '附件不存在');
    const filePath = path.join(loc.storageDir, loc.att.storedName);
    try {
      const stat = await fsp.stat(filePath);
      res.set('Content-Type', loc.att.mimeType || 'application/octet-stream');
      res.set('Content-Length', String(stat.size));
      res.set('Cache-Control', 'private, max-age=3600');
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => res.end());
      stream.pipe(res);
    } catch {
      throw new HttpError(404, '文件已丢失');
    }
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §16. 多项目编排台（L1 看板 + 主 Agent 控制台）
  //   GET  /api/workbench/projects               项目清单 + 看板任务
  //   POST /api/workbench/projects/remove        从清单里移除一个项目条目
  //   GET  /api/workbench/orchestrator           调度开关 + 指令存档 + 活动流 + 预设提示词
  //   POST /api/workbench/orchestrator/state     暂停 / 恢复调度
  //   POST /api/workbench/orchestrator/dispatch  派发一条人类干预指令
  //   POST /api/workbench/orchestrator/default-prompt   写全局预设提示词
  //   POST /api/workbench/orchestrator/project-prompt   写某个项目的预设提示词
  //
  // 「暂停调度」的实际语义：只拦**自动派发**（dispatch 里带 autoRun），
  // 手动点执行 / 子任务执行一概不受影响 —— 暂停的是主 Agent 的自主行为，
  // 不是把用户的手也一起绑住。
  // ════════════════════════════════════════════════════════════════════════

  /**
   * 组装「项目清单 + 看板任务」。
   *
   * 要探测 Git 状态的路径全部来自**服务端可信来源** —— configManager 的最近目录
   * 与 tasks.json 里已有的 projectPath。本路由不接受任何客户端传入的路径，
   * 因此不会被当成「任意路径 git 探测」的口子（口径同 /api/recent_directories/git-state）。
   */
  async function loadBoardPayload() {
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const tasks = data.tasks || [];
    // 看板列（待处理/进行中/已完成）全由执行记录推导，而执行记录是「跨 g ui 实例共享
    // 在 jobs.json 里、本进程内存只持有自己跑的那些」——所以取快照前必须刷一次磁盘，
    // 否则另一个实例刚跑完的任务在本实例看板上会一直停在"待处理"。
    // 看板 5s 轮询一次，代价是 mtime 没变时的一个 stat。
    await refreshJobsFromDisk();
    const jobsSnap = snapshotJobs();

    let recentDirs = [];
    try {
      if (configManager && typeof configManager.getRecentDirectories === 'function') {
        recentDirs = (await configManager.getRecentDirectories()) || [];
      }
    } catch (err) {
      // 最近目录读不到不该让整个看板挂掉：退化成"只按任务里出现过的项目"生成清单
      logger.warn('[workbench] 读取最近目录失败，项目清单退化为仅按任务路径生成:', err.message);
    }

    const currentProjectPath = typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '';
    // Git 探测自带 15s TTL 缓存（directoryGitState.js），看板 5s 轮询里有 2/3 是命中缓存，
    // 实际 spawn 频率被自然限制在 15s 一次，不需要再给这个接口加"跳过一次探测"的开关。
    const allProjects = await listProjects({ recentDirs, tasks, jobs: jobsSnap, currentProjectPath });
    // 滤掉用户手动移除、且目录确实已经不在了的那些条目（语义见 hiddenProjects.js）。
    // 放在 listProjects 之后而不是之前：Git 探测得照常跑完 —— 目录有没有回来，
    // 正是"该不该继续藏着"这条判据的依据。
    let projects = allProjects;
    const hidden = await readHiddenProjects();
    if (hidden.length) projects = filterHiddenProjects(allProjects, hidden);
    const jobsByTask = groupJobsByTask(jobsSnap);
    const boardTasks = tasks.map(t => decorateTaskForBoard(t, jobsByTask.get(t.id) || []));
    return { projects, tasks: boardTasks, currentProjectPath };
  }

  /**
   * 注册「运行环境上下文」的提供者 —— 执行引擎（taskRunner）拼 prompt 时会回调它。
   *
   * ⚠️ 数据**不再在这里现读**。项目清单 / 各列计数 / 合计口径一律从
   * aiContext 的 `tasks` 板块拿（collectWorkbenchTasks 的结构化 `data`）。
   * 以前这里是"读 tasks.json + 最近目录 + buildProjectEntries + summarizeProjectTasks"
   * 的第二份实现，与 aiContext 那份是同一个口径的两个副本 —— 改一处漏一处不会报错，
   * 只会让 Agent 在编排台里和智能体页里看到**不同的项目数**。现在只剩一份。
   *
   * 拿之前先**强制刷一次 tasks**：这次派发出去的 prompt 必须看到"刚刚"的看板状态
   *（别的 g ui 实例刚跑完的任务、刚改过状态的任务）。tasks 的 forceTtlMs = 0，是真刷，
   * 成本与改动前（每次都现读 tasks.json + refreshJobsFromDisk）完全一样。
   *
   * 为什么是 getter 而不是直接传 snapshotter：本函数在 registerWorkbenchRoutes 里被调用，
   * 而快照生成器在服务端入口创建、注册顺序在它之前就已经建好了 —— 但两者是同一次装配，
   * 用 getter 可以避免"必须记得按某个顺序注册"这种隐性契约。
   */
  setEnvContextProvider(async ({ repoPath, compact } = {}) => {
    const snapshotter = typeof getAiContextSnapshotter === 'function' ? getAiContextSnapshotter() : null;

    if (!snapshotter || typeof snapshotter.refreshSections !== 'function') {
      // 快照生成器没装配上（理论上不会发生）。至少把**不需要取数**的两样递进去：
      // 用户偏好与真相源路径 —— 前者少一次就会让任务卡在 https 凭据窗口上。
      return buildEnvContextBlock({ currentProjectPath: repoPath || '', truthFiles: TRUTH_FILES, compact });
    }

    try {
      await snapshotter.refreshSections(['tasks'], { force: true });
    } catch (err) {
      // 刷不动就用快照里已有的（哪怕旧一点）—— 上下文是锦上添花，
      // 不能因为它挂了就让用户的指令执行不了（与 taskRunner.resolveEnvContext 同一条原则）。
      logger.warn('[workbench] 注入运行环境上下文前刷新 tasks 板块失败，改用现有快照:', err?.message || err);
    }

    let board = null;
    try {
      // 用 getSectionResult 而不是 getSnapshot：后者会顺手把其余过期板块推到后台刷，
      // 派发任务没理由因此去拉 gh/gitee（只在智能体页聊天时才值得那样做）。
      board = snapshotter.getSectionResult?.('tasks')?.data || null;
    } catch (err) {
      logger.warn('[workbench] 读取快照里的 tasks 板块失败，本次只注入偏好与真相源路径:', err?.message || err);
    }

    return buildEnvContextBlock({
      currentProjectPath: repoPath || '',
      board,
      truthFiles: TRUTH_FILES,
      // 续聊轮走精简刷新版（调用方 taskRunner 按 resumeSessionId 判定）
      compact,
    });
  });

  /**
   * 铺一次记忆库种子（幂等，only-if-missing）。
   *
   * **为什么在这里而不是 taskRunner 每次派发时**：目录不存在时若每次派发都尝试
   * 铺，等于把"有没有记忆"绑在"这次有没有干活"上；而且首次铺种子的 IO 抖动会
   * 落在派发的关键路径上。注册路由时铺一次，语义是"工作台起来了，记忆库就位"。
   *
   * 失败只记日志不抛：记忆库铺不出来不该让整个工作台起不来
   * （与上面 resolveEnvContext 同一原则）。真正注入时 taskRunner 拿不到项目索引
   * 会自动降级成"只有全局那层"，Agent 照样能用。
   */
  ensureMemoryStore()
    .then(({ created }) => {
      if (created.length) logger.info(`[workbench] 已铺记忆库种子: ${created.join(', ')}`);
    })
    .catch((err) => logger.warn('[workbench] 铺记忆库种子失败，记忆功能降级:', err?.message || err));

  /**
   * 「工作台任务执行结束」→ 定向刷新快照。
   *
   * 挂在 jobStore 的事件总线上（本层已经在消费同一条总线做 SSE 广播）。
   * 终态判定与去重都在 createJobSettledRefresher 里，见那个文件的头注释。
   *
   * `bus.on` 前先 `off` 掉上一个：bus 是模块级单例，重复注册（例如同一进程里
   * 再次装配路由）会让同一次 job 结束被刷好几遍。
   */  if (jobSettledHandler) bus.off('event', jobSettledHandler);
  jobSettledHandler = createJobSettledRefresher({
    getSnapshotter: getAiContextSnapshotter,
    onError: (err) => logger.warn('[workbench] 任务结束后刷新工作区快照失败:', err?.message || err),
  });
  bus.on('event', jobSettledHandler);

  app.get('/api/workbench/projects', asyncRoute(async (_req, res) => {
    const payload = await loadBoardPayload();
    res.json({ success: true, ...payload });
  }));

  /**
   * 把一个项目条目从工作台清单里移除（左栏「目录不存在」那一行的删除按钮）。
   *
   * 做两件事，缺一不可：
   *   ① 从常用目录（config.json 的 recentDirectories）里摘掉；
   *   ② 记进 hidden-projects.json —— 只删 ① 的话，只要还有任务记着这个路径，
   *      它会立刻从「任务」那半边被重新生成，用户看到的是"点了没反应"。
   *   语义、为什么不去改任务的 projectPath，见 hiddenProjects.js 的文件头注释。
   *
   * **不删任何任务/job/历史**：只是让这一行不再出现在清单里。
   * 它在目录仍然不存在期间一直藏着；哪天目录被重新克隆回来，它会自己回来。
   *
   * 路径只认"当前清单里确实有"的那一个（用与 buildProjectEntries 同一份归一口径比对），
   * 不接受任意路径 —— 与 GET /projects 的安全边界一致，这个端点不是任意路径写配置的入口。
   */
  app.post('/api/workbench/projects/remove', asyncRoute(async (req, res) => {
    const rawPath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
    const key = canonicalProjectPath(rawPath);
    if (!key) throw new HttpError(400, '缺少项目路径');
    if (!configManager || typeof configManager.removeRecentDirectory !== 'function') {
      throw new HttpError(500, '配置管理不可用，无法移除项目');
    }

    const tasksData = await readJson(TASKS_FILE, { tasks: [] });
    const tasks = tasksData.tasks || [];
    let recentDirs = [];
    try {
      recentDirs = (await configManager.getRecentDirectories()) || [];
    } catch (err) {
      logger.warn('[workbench] 移除项目时读取最近目录失败:', err?.message || err);
    }

    // 只承认清单里真实存在的条目：key 归一后必须命中 buildProjectEntries 的某一条，
    // 否则 404 —— 否则这个端点就成了"往 config.json 删任意字符串"的通道。
    const entry = buildProjectEntries({ recentDirs, tasks }).find(e => e.key === key);
    if (!entry) throw new HttpError(404, '项目不在清单里，可能已经被移除');

    // ① 常用目录。同一目录可能有多种写法（大小写 / 斜杠），逐条摘干净 ——
    //    漏掉任何一种，那一条就会在下一轮轮询里把项目重新"复活"成 source:'recent'。
    let removedFromRecent = 0;
    for (const dir of recentDirs) {
      if (canonicalProjectPath(dir) !== key) continue;
      await configManager.removeRecentDirectory(dir);
      removedFromRecent += 1;
    }

    // ② 隐藏名单。idempotent：重复点第二次不会把它顶到最前面之外的地方。
    await hideProject(key);

    // 通知别的 g ui 实例：它们的看板是 5s 轮询，晚一轮刷新而已，不值得推 SSE。
    publish('projects:removed', { key, path: entry.path, removedFromRecent });

    res.json({
      success: true,
      removedFromRecent,
      // 回给前端说清楚"任务一条都没删"，好让它把这句话原样讲给用户听
      keptTasks: tasks.filter(t => canonicalProjectPath(t.projectPath) === key).length,
    });
  }));

  /**
   * 单个任务的详情 —— 点看板卡片弹出的那个框用它。
   *
   * 为什么不把详情并进 /projects：那个接口是 5s 轮询的，只该发摘要
   * （decorateTaskForBoard）。把子任务描述、报错、执行输出一起推，
   * 十几条任务每 5 秒来一遍，纯属浪费带宽和解析时间。
   * 这里按需取一次，且 output 由 trimJobForDetail 在服务端截尾。
   *
   * 注册位置：字面量路径 /tasks/ai-* 都在上面且只有一段，
   * :id/detail 是两段，不会互相抢匹配。
   */
  app.get('/api/workbench/tasks/:id/detail', asyncRoute(async (req, res) => {
    const id = req.params.id;
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const task = (data.tasks || []).find(t => t && t.id === id);
    if (!task) throw new HttpError(404, '任务不存在');

    // loadAllJobs 已经把「文件里归档的 + 内存里还活着的」合并过（含 taskTitle）
    const allJobs = await loadAllJobs();
    const detail = buildTaskDetail(task, allJobs.filter(j => j && j.taskId === id));
    if (!detail) throw new HttpError(404, '任务不存在');

    res.json({ success: true, ...detail });
  }));

  app.get('/api/workbench/orchestrator', asyncRoute(async (_req, res) => {
    const state = await readOrchestrator();
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const tasks = data.tasks || [];
    // 同 loadBoardPayload：活动流 / 正在跑的 Agent 都从执行记录来，先刷磁盘才能看到
    // 别的 g ui 实例跑出来的记录（前端的「今日完成」也是数这份 activity）。
    await refreshJobsFromDisk();
    const jobsSnap = snapshotJobs();
    res.json({
      success: true,
      active: state.active,
      updatedAt: state.updatedAt,
      // ⚠️ 这个接口是 5s 轮询的。指令正文在**下发这一份**里被截到
      // INSTRUCTION_PREVIEW_CHARS（落盘那份不截，见 shared.js 的注释）。
      // 指令上限放宽到十万字之后不截就是 200 × 100000 = 20MB 一轮。
      instructions: state.instructions.map(withInstructionPreview),
      // 指令正文上限跟着状态一起下发：前端要显示"还剩多少字"就得知道这个数，
      // 而它归服务端定（派发校验也在这儿）。前端不再自己写一份数字 ——
      // 之前 maxlength 那种"界面说能发、后端 400"的分叉就是这么来的。
      maxInstructionChars: MAX_INSTRUCTION_CHARS,
      // 预设提示词跟着这份状态一起下发：控制台要拿它显示"当前会附带什么"，
      // 设置弹窗打开时也不必再单独取一次（单条上限 8000 字，体积可控）
      defaultPrompt: state.defaultPrompt,
      projectPrompts: state.projectPrompts,
      // 进度报告的**配置**（一个数字 + 一个时间戳）跟着轮询走，报告的**正文**走
      // /orchestrator/reports：报告历史一份几 KB，20 份就是几十 KB，
      // 塞进这个 5s 轮询的接口纯属浪费（与 /tasks/:id/detail 不进 /projects 同一个理由）。
      reportIntervalMs: state.reportIntervalMs,
      lastReportAt: state.lastReportAt,
      activity: buildActivityFeed({ jobs: jobsSnap, tasks, instructions: state.instructions }),
      running: buildRunningAgents({ jobs: jobsSnap, tasks }),
    });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §19.5 进度报告（右栏「进度报告」面板）
  //
  // 面板上那一段"现在跑到哪一步了"由模型写，但**什么时候写、写几次**由这一层管：
  //   · 手动「立即报告」→ POST /orchestrator/report，永远可用；
  //   · 自动报告 → 下面的定时器，间隔来自用户设置（0 = 关）。
  // 两份历史都存在 orchestrator-reports.json，读取走 /orchestrator/reports。
  // ════════════════════════════════════════════════════════════════════════

  /**
   * 报告要用到的两份东西：默认模型 + 界面语言。
   * 一次 config 读出来 —— 分两次读会读到"两个瞬间"（改设置的同时正好在报告）。
   */
  async function readReportContext() {
    const out = { model: null, locale: '' };
    if (!configManager || typeof configManager.readRawConfigFile !== 'function') return out;
    try {
      const raw = await configManager.readRawConfigFile();
      const models = Array.isArray(raw && raw.models) ? raw.models : [];
      out.model = models.find(m => m && m.isDefault) || models[0] || null;
      out.locale = typeof (raw && raw.locale) === 'string' ? raw.locale : '';
    } catch (err) {
      logger.warn('[workbench] 读取模型配置失败，本次报告只记事实:', (err && err.message) || err);
    }
    return out;
  }

  /** 当前在跑的 job 拼成报告事实。先刷磁盘那一半，别的实例跑的任务也要算进来 */
  async function collectRunningFacts() {
    const data = await readJson(TASKS_FILE, { tasks: [] });
    await refreshJobsFromDisk();
    return buildRunningFacts({ jobs: Array.from(mergedJobs().values()), tasks: data.tasks || [] });
  }

  /**
   * 生成并落盘一份进度报告。
   *
   * @param {'auto'|'manual'} trigger
   * @param {{ locale?: string, intervalMs?: number }} [opts]
   *        locale 缺省时用配置里的界面语言；intervalMs 只在 auto 时用（抢占名额）
   * @returns {Promise<object|null>} null = 这次不该报（没任务在跑 / 名额已被占）
   */
  async function runProgressReport(trigger, { locale = '', intervalMs = 0 } = {}) {
    const facts = await collectRunningFacts();

    // 没有任务在跑就**不生成报告**，自动与手动一视同仁。
    //   · 自动：一条"什么都没发生"每 10 分钟占一格，只会把真正有用的挤出历史（上限 20 条）；
    //   · 手动：用户点这一下是想知道"现在跑到哪一步了"，而此刻确实没有东西在跑 ——
    //     前端弹一句"当前没有正在执行的任务"（useOrchestrator.generateReport）比往历史里
    //     塞一条空记录有用：空记录回头翻的时候零信息量，还会把有用的挤出去。
    //     （用户 2026-09-29 报的问题：历史里 4 条"当时没有任务在执行"两两重复，
    //      点一下「立即报告」就多两条 —— 空报告本机几十毫秒返回，前端的防抖拦不住第二次点击。）
    // 返回 null 是"这次不该报"的正常结果，不是错误。
    if (!facts.length) return null;
    if (trigger === 'auto' && !(await claimReportSlot(intervalMs))) return null;

    const ctx = await readReportContext();
    const report = await generateProgressReport({
      facts,
      locale: locale || ctx.locale,
      trigger,
      model: ctx.model,
    });
    const saved = await appendReport(report);
    publish('orchestrator:report', { id: saved.id, at: saved.at, trigger: saved.trigger });
    return saved;
  }

  /**
   * 同一时刻只跑一次生成。
   * 「立即报告」连点两下、或手动与自动撞在一起时，第二次应该**等第一份**，
   * 而不是再打一次模型换回一份几乎一样的报告。
   */
  let reportInFlight = null;
  function runProgressReportOnce(trigger, opts) {
    if (reportInFlight) return reportInFlight;
    reportInFlight = runProgressReport(trigger, opts).finally(() => { reportInFlight = null; });
    return reportInFlight;
  }

  /** 取报告历史（新的在前）。面板打开时取一次、之后每次生成后取一次 */
  app.get('/api/workbench/orchestrator/reports', asyncRoute(async (_req, res) => {
    res.json({ success: true, reports: await readReports() });
  }));

  /**
   * 手动生成一份报告。body: { locale? }
   *
   * 与自动报告共用同一条链路，只在两处不同：
   *   · 不占用自动报告的间隔名额（否则用户点一下「立即报告」，下一次自动报告被推迟一整个间隔）；
   *   · 间隔窗口内**内容一样**的第二份不重复落盘（连点两下只留一份，见 appendReport）。
   *
   * 没有任务在跑时同样返回 `report: null` —— 这时前端弹一句"当前没有正在执行的任务"，
   * 而不是往历史里记一条空报告（理由见 runProgressReport）。
   */
  app.post('/api/workbench/orchestrator/report', asyncRoute(async (req, res) => {
    const locale = typeof req.body?.locale === 'string' ? req.body.locale : '';
    const report = await runProgressReportOnce('manual', { locale });
    res.json({ success: true, report });
  }));

  /**
   * 改自动报告间隔。body: { intervalMs }
   * 取值由 shared.js 的白名单卡死（0 / 5 / 10 / 15 / 30 / 60 分钟），非法值回落默认 ——
   * 这个数字直接决定每多久烧一次额度，不能让请求体里的任意值进来。
   */
  app.post('/api/workbench/orchestrator/report-interval', asyncRoute(async (req, res) => {
    const reportIntervalMs = await setReportIntervalMs(req.body?.intervalMs);
    publish('orchestrator:report-interval', { reportIntervalMs });
    res.json({ success: true, reportIntervalMs });
  }));

  /**
   * 自动报告定时器。
   *
   * 30s 一跳，但每一跳**只是判断该不该报**：读 orchestrator.json 拿间隔 + 看内存里
   * 有没有在跑的 job。真正花额度的那一步被三重条件挡住 —— 开关打开、有任务在跑、
   * 距上次报告满一个间隔。所以"10 分钟报一次"的实际误差不超过 30s，
   * 而不是每 30 秒打一次模型。
   *
   * 为什么放服务端而不是前端定时器：报告是给**离开键盘的人**看的，
   * 前端定时器在标签页隐藏/关掉后就不跑了，而那正是最需要它的时刻。
   */
  async function tickProgressReport() {
    const state = await readOrchestrator();
    if (!state.reportIntervalMs) return;
    await runProgressReportOnce('auto', { intervalMs: state.reportIntervalMs });
  }

  if (reportTimer) { clearInterval(reportTimer); reportTimer = null; }
  reportTimer = setInterval(() => {
    tickProgressReport().catch(err => {
      logger.warn('[workbench] 自动进度报告失败:', (err && err.message) || err);
    });
  }, REPORT_TICK_MS);
  // 定时器不该把进程吊着不退出
  reportTimer.unref?.();

  /**
   * 静默看门狗的一跳：把**本进程**跑着的、已经静默够久的 job 挨个判一次，
   * 判成"已经做完了"就把这条执行落成终态（卡片随即从「进行中」挪到「已完成」）。
   *
   * 与自动报告的三点不同，都是有意的：
   *   · **不吃报告开关**：报告间隔是"隔多久汇报一次"的偏好，不是"允不允许后台打模型"
   *     的总闸。用户关掉报告之后，卡了 54 分钟的任务仍然该被收掉。
   *   · **只判本进程的 job**：别人的 job 只在 live-jobs 缓存里，终态由它的 owner 落盘 ——
   *     从这边改会被下一轮刷新盖回去（见 stallWatchdog 文件头的第 4 条）。
   *   · **串行判**：一次模型往返几秒到几十秒，同时跑好几条就是同时打十几次模型。
   *     排队判的代价只是排在后面的那几条晚几十秒，而它们已经静默十分钟了。
   *
   * 判定的准入条件（该不该判）全在 stallWatchdog.shouldCheckStall 里，这里只负责
   * "把模型的话落到 job 上"，免得同一套门槛出现两份。
   */
  let stallTickInFlight = false;
  async function tickStallWatchdog() {
    if (stallTickInFlight) return;
    stallTickInFlight = true;
    try {
      // 每判完一条都重新取一次时间：判定本身要花几秒，用 tick 开始时的 now
      // 会让"刚刚已经恢复产出"的任务在第二次静默检查里蒙混过关
      const pending = Array.from(jobs.values()).filter(j => shouldCheckStall(j, Date.now()));
      if (!pending.length) return;

      const data = await readJson(TASKS_FILE, { tasks: [] });
      const taskMap = new Map((data.tasks || []).filter(t => t && t.id).map(t => [t.id, t]));
      const ctx = await readReportContext();

      for (const job of pending) {
        if (!shouldCheckStall(job, Date.now())) continue;
        const fact = buildStallFact(job, taskMap.get(job.taskId), Date.now());
        const verdict = await judgeStalledJob({ fact, locale: ctx.locale, model: ctx.model });
        const settled = applyStallVerdict(job, { at: nowIso(), verdict });
        if (settled) {
          // 先告诉前端（SSE）再落盘：卡片该立刻动，而不是等下一次 5s 轮询
          publish('job:update', job);
          logger.info(`[workbench] 静默看门狗判定任务已完成，自动收尾 (job=${job.id}): ${job.autoCompleted.reason || '（模型未给依据）'}`);
          try {
            await flushJobsSaveNow();
          } catch (err) {
            logger.warn('[workbench] 自动收尾落盘失败:', (err && err.message) || err);
          }
        } else if (verdict.errorCode) {
          logger.info(`[workbench] 静默判定未采纳 (job=${job.id}): ${verdict.errorCode} ${verdict.errorDetail}`.trim());
        } else if (verdict.done) {
          // 判成完成但没落成终态 —— 判定期间它又动了（见 applyStallVerdict）
          logger.info(`[workbench] 静默判定为已完成，但期间任务又有产出，本次不改状态 (job=${job.id})`);
        }
      }
    } finally {
      stallTickInFlight = false;
    }
  }

  if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
  stallTimer = setInterval(() => {
    tickStallWatchdog().catch(err => {
      logger.warn('[workbench] 静默看门狗失败:', (err && err.message) || err);
    });
  }, REPORT_TICK_MS);
  stallTimer.unref?.();

  app.post('/api/workbench/orchestrator/state', asyncRoute(async (req, res) => {
    const active = req.body?.active;
    if (typeof active !== 'boolean') throw new HttpError(400, 'active 必须是布尔值');
    const state = await setOrchestratorActive(active);
    publish('orchestrator:state', { active: state.active, updatedAt: state.updatedAt });
    res.json({ success: true, active: state.active, updatedAt: state.updatedAt });
  }));

  /** 提示词参数校验：空串是合法值（= 清除），只拦超长与非字符串 */
  function assertPromptText(prompt) {
    if (typeof prompt !== 'string') throw new HttpError(400, 'prompt 必须是字符串');
    if (prompt.length > MAX_DEFAULT_PROMPT_CHARS) {
      throw new HttpError(400, `预设提示词过长（上限 ${MAX_DEFAULT_PROMPT_CHARS} 字）`);
    }
  }

  /**
   * 写**全局**预设提示词。body: { prompt }
   *
   * 存的是"派发时自动附加的约束"，不是某条任务的内容 —— 改它只影响**之后**的派发：
   * 已建任务在派发那一刻就把当时生效的提示词抄进了自己的 simpleOverride，
   * 事后改设置不会去动历史任务（否则用户改一次设置，一批跑过的任务描述就对不上了）。
   */
  app.post('/api/workbench/orchestrator/default-prompt', asyncRoute(async (req, res) => {
    assertPromptText(req.body?.prompt);
    const defaultPrompt = await setDefaultPrompt(req.body.prompt);
    res.json({ success: true, defaultPrompt });
  }));

  /**
   * 写**某个项目**的预设提示词。body: { projectPath, prompt }
   *
   * 只接受项目清单里真实存在的路径：这张表的键就是项目 key，不校验的话
   * 请求体里的任意字符串都能往里塞（那些键永远不会被读到，只会把文件撑大）。
   */
  app.post('/api/workbench/orchestrator/project-prompt', asyncRoute(async (req, res) => {
    const projectPath = typeof req.body?.projectPath === 'string' ? req.body.projectPath.trim() : '';
    if (!projectPath) throw new HttpError(400, 'projectPath 不能为空');
    assertPromptText(req.body?.prompt);

    const data = await readJson(TASKS_FILE, { tasks: [] });
    let recentDirs = [];
    try {
      if (configManager && typeof configManager.getRecentDirectories === 'function') {
        recentDirs = (await configManager.getRecentDirectories()) || [];
      }
    } catch (err) {
      logger.warn('[workbench] 写项目提示词时读取最近目录失败，仅按任务路径校验:', err.message);
    }
    const key = canonicalProjectPath(projectPath);
    const known = buildProjectEntries({ recentDirs, tasks: data.tasks || [] });
    if (!key || !known.some(e => e.key === key)) {
      throw new HttpError(400, `项目不在清单里：${projectPath}`);
    }

    const projectPrompts = await setProjectPrompt({ projectPath, prompt: req.body.prompt });
    res.json({ success: true, projectPrompts });
  }));

  // 派发器实例：它需要的两个依赖（configManager / getCurrentProjectPath）只有装配层
  // 拿得到，所以在这一层建一次。无状态 —— agentRoutes 那边会用同一套依赖另建一个实例，
  // 两边跑的是**同一份实现**（见 dispatchInstruction.js 的文件头）。
  const { dispatchInstruction } = createDispatcher({ configManager, getCurrentProjectPath });

  /**
   * 派发一条指令。
   * body: { text, projectPath?, autoRun?, useDefaultPrompt?, executor?, attachments? }
   *   - projectPath 缺省 -> 交给 targetResolver 判断落到哪个项目（显式指定 > 指令里点名
   *     > 主 Agent 判断 > 应用当前项目）。用户不必先选项目，落点会如实记进指令流水
   *   - autoRun 默认 true；调度暂停时只建任务不执行（指令记录里会写明原因）
   *
   * 一条指令落成目标项目下的一个任务：整段指令就是那次会话的 prompt。
   *
   * 这里只做「从 req.body 取字段 -> 交给派发器 -> 回响应」。逻辑一概不放 ——
   * 同一个派发动作还有第二个入口：内置智能体的 dispatch_task 工具（g ai 在主 Agent
   * 控制台里自己派活）。两份实现分叉的表现是"不报错，只是落点 / 提示词不一样"。
   */
  app.post('/api/workbench/orchestrator/dispatch', asyncRoute(async (req, res) => {
    const result = await dispatchInstruction({
      text: req.body?.text,
      projectPath: req.body?.projectPath,
      autoRun: req.body?.autoRun,
      useDefaultPrompt: req.body?.useDefaultPrompt,
      executor: req.body?.executor,
      attachments: req.body?.attachments,
    });
    res.json({ success: true, ...result });
  }));

  /**
   * 派发前把附件落到暂存区。
   *
   * 为什么需要这一层：§17 的上传端点都要求 taskId / subId 当挂载点，而派发这一刻
   * 任务还不存在。所以先写进 `_dispatch/`，**不写任何 JSON** —— 附件记录回给前端持有，
   * 派发时再按 id 搬进任务目录。
   * 代价是服务端在这里无状态：它不知道前端一共攒了几个（数量本来也不设上限，
   * 所以这份无状态不再有代价 —— 真要卡也只能卡在派发那一刻，而那时已经晚了）。
   */
  app.post('/api/workbench/orchestrator/attachments', rawAttachment, asyncRoute(async (req, res) => {
    await fsp.mkdir(DISPATCH_STAGING_DIR, { recursive: true });
    const att = await writeAttachmentTo({ req, target: { storageDir: DISPATCH_STAGING_DIR } });
    res.json({ success: true, attachment: att });
  }));

  /** 撤掉一个还没派发的附件（用户点了 ×）。id 形状不合法一律 404，不做路径拼接。 */
  app.delete('/api/workbench/orchestrator/attachments/:attId', asyncRoute(async (req, res) => {
    const full = await findStagingFile(req.params.attId);
    if (!full) throw new HttpError(404, '附件不存在');
    try { await fsp.unlink(full); } catch { /* 文件可能已不在 */ }
    res.json({ success: true });
  }));

  /** 暂存附件的缩略图 / 预览。与 §17 的 raw 端点同形，只是从暂存区取 */
  app.get('/api/workbench/orchestrator/attachments/:attId/raw', asyncRoute(async (req, res) => {
    const full = await findStagingFile(req.params.attId);
    if (!full) throw new HttpError(404, '附件不存在');
    const ext = path.extname(full).slice(1).toLowerCase();
    try {
      const st = await fsp.stat(full);
      res.set('Content-Type', mimeForExt(ext));
      res.set('Content-Length', String(st.size));
      res.set('Cache-Control', 'private, max-age=3600');
      const stream = fs.createReadStream(full);
      stream.on('error', () => res.end());
      stream.pipe(res);
    } catch {
      throw new HttpError(404, '文件已丢失');
    }
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §20. 执行器模型探测（只读）
  // ════════════════════════════════════════════════════════════════════════
  /**
   * 「这三个执行器现在实际在用什么模型」。
   *
   * 为什么需要这个端点：工作台派任务**一律不传 --model**（见 executorModels.js 的
   * 长注释），模型完全跟随各自 CLI 的配置文件。副作用是界面上一个执行器的模型都
   * 看不到 —— 用户想确认"这活到底是哪个模型跑的"只能去翻三个不同格式的配置文件。
   * 这个端点把那件事收口到一次请求里。
   *
   * 无参数、服务端不算缓存：三个文件都很小，每次实读比让前端踩脏缓存划算；
   * 前端那边（stores/toolsStore）自己按分钟级 TTL + 并发去重压请求频率。
   * 返回值里某项为 null = 那个 CLI 没在配置里写模型，前端照实显示「未在配置中指定」。
   * key 恒为 claude / codex / opencode 三个，与 TASK_EXECUTOR_OPTIONS 对齐。
   */
  app.get('/api/workbench/executor-models', asyncRoute(async (_req, res) => {
    const detected = await detectExecutorModels();
    const models = {};
    for (const [executor, info] of Object.entries(detected)) {
      models[executor] = formatExecutorModel(info);
    }
    res.json({ success: true, checkedAt: nowIso(), models });
  }));

  // 暂存区兜底清理：粘了图却没派发就关页面的痕迹，不该永久占着磁盘。
  // 不上定时器 —— 暂存区的生命周期本来就是"几分钟内被派发掉"，启动清一次足够。
  cleanupDispatchStaging().catch(err => {
    logger.warn('[workbench] 清理派发附件暂存区失败:', err.message);
  });
}

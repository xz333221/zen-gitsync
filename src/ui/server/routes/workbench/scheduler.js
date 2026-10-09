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
// 定时任务调度器：到点把任务的提示词发进它的专属会话，跑完整轮 g ai 对话。
//
// ── 定位 ───────────────────────────────────────────────────────
// 调度器是整个进程里**唯一**会"自己发起对话"的东西。执行体完全复用
// agentChat.runAgentTurn（LLM 循环 + 工具/MCP + 上下文快照 + 落盘），
// 所以这里只负责四件事：
//   1. 到点判定：prevFire ≤ now 且还没处置过（lastFire）
//   2. 防重：多实例抢认领文件（claimFire），单实例看 lastFire
//   3. 会话编排：读/建专属会话 → 过共享闸 → 跑 → 记执行记录 → 落盘
//   4. 广播：把"任务开始/结束"推给前端（SSE，见 scheduleRoutes.js）
//
// ── tick 模型 ──────────────────────────────────────────────────
// 每 30 秒醒一次，处理"当前时刻之前最近一个未处置的触发点"。刻意不用
// "算好 nextRun 再 setTimeout 精确等待"：长定时器在 Windows 休眠/唤醒后
// 不可靠，而 30s 轮询对分钟粒度的 cron 来说最坏也只延迟 30 秒。
// 错过补偿天然包含在这个模型里：g ui 关了 3 小时再启动，第一轮 tick 就会
// 看到"上一个触发点没处置过"——onMissed=run 补跑一次，skip 则标记放行。
// （距触发点超过 MISSED_THRESHOLD_MS 才算"错过"，正常 tick 的 30s 延迟不算。）
//
// ── 与手动对话的关系 ──────────────────────────────────────────
// 到点时如果专属会话正被用户聊着（共享闸被占），按 onBusy=skip 跳过本轮并
// 记录原因（用户能在任务历史里看到）；反向也成立——定时任务占用会话期间，
// 用户发消息会收到"该会话正在生成中"。

import fsp from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { runAgentTurn } from './agentChat.js';
import { agentSessionStore } from './agentSessionStore.js';
import { isSessionBusy, acquireSession, releaseSession } from './sessionGate.js';
import { logger as defaultLogger, nowIso } from './shared.js';
import { recordTurnTiming } from '../../../../cli/ai/sessionStore.js';
import { resolveRequestBudget } from '../../../../cli/ai/context.js';
import {
  loadTasks, getTask, claimFire, cleanClaims, setTaskFire, setTaskRun,
} from '../../../../utils/scheduleStore.js';
import { parseCron, prevFireBefore, fireKey } from '../../../../utils/scheduleCron.js';

/** 轮询间隔：分钟粒度 cron 的最坏延迟 = 这个值 */
export const TICK_INTERVAL_MS = 30_000;
/** 距触发点超过这个时长才算"错过"（低于它的延迟是正常 tick 抖动） */
export const MISSED_THRESHOLD_MS = 10 * 60_000;
/** 单次执行的硬上限：无人值守必须有兜底，到点强制中止并标记 */
export const MAX_RUN_MS = 60 * 60_000;

/**
 * 创建调度器（不自动启动 —— 由生产入口在服务就绪后调 start()，
 * 与 workspaceSnapshotter 的 warm() 同一约定：单测创建实例不会真的开跑）。
 *
 * @param {object} deps
 * @param {object} deps.configManager           读全局模型配置（与对话链路同源）
 * @param {() => string} [deps.getCurrentProjectPath]
 * @param {Function} [deps.listProjects]        list_projects 工具的实现（GUI 侧注入）
 * @param {Function} [deps.dispatchTask]        dispatch_task 工具的实现（已绑定默认参数）
 * @param {Function} [deps.getContextBlock]     工作区状态快照
 * @param {Function} [deps.runTurn]             执行一轮对话（默认 runAgentTurn；测试注入替身）
 * @param {object} [deps.logger]                日志替身（测试用）
 * @param {() => Date} [deps.now]               时钟替身（测试用）
 */
export function createScheduler({
  configManager,
  getCurrentProjectPath,
  listProjects,
  dispatchTask,
  getContextBlock,
  runTurn = runAgentTurn,
  logger = defaultLogger,
  now = () => new Date(),
} = {}) {
  /** taskId -> { abortController, startedAt, sessionId, fireIso, child } */
  const running = new Map();
  const emitter = new EventEmitter();
  let timer = null;
  let ticking = false;
  /** 上一次巡检时的任务库签名：外部（CLI / 对话工具 / 别的实例）改了任务就广播一次 */
  let lastTasksSignature = null;

  function tasksSignature(tasks) {
    return tasks.map(t => `${t.id}|${t.updatedAt}|${t.enabled ? 1 : 0}`).join('\n');
  }

  function broadcast(evt) {
    try {
      emitter.emit('event', { ...evt, ts: nowIso() });
    } catch (err) {
      logger.warn(`[scheduler] 广播事件失败: ${err?.message || err}`);
    }
  }

  // ── 执行 ────────────────────────────────────────────────────

  /**
   * 启动一个任务（**立即返回**，执行在返回的 done promise 里进行）。
   * 保证：
   *  - 同一任务不会并发执行（running 表）
   *  - 会话闸被占用时按 onBusy=skip 记一笔并放行
   *  - 无论成败都落盘会话 + 写 lastRun
   * @returns {Promise<{started:boolean, reason?:string, done?:Promise, sessionId?:string}>}
   */
  async function executeTask(task, { trigger, fireIso = null } = {}) {
    if (running.has(task.id)) return { started: false, reason: 'already-running' };

    // 目录不存在就别跑了 —— 工具在 cwd 里全都会失败，跑一轮纯烧 token。
    // （任务创建时校验过，这里再查一次是因为目录可能事后被删/改名。）
    try {
      const st = await fsp.stat(task.cwd);
      if (!st.isDirectory()) throw new Error('not a directory');
    } catch {
      const record = { at: nowIso(), status: 'error', error: `项目目录不存在: ${task.cwd}`, trigger, fire: fireIso };
      await setTaskRun(task.id, record).catch(() => {});
      broadcast({ type: 'task_finished', taskId: task.id, status: 'error', trigger, error: record.error });
      return { started: false, reason: 'cwd-missing' };
    }

    // 会话：dedicated 模式复用专属会话（跑过一次后 sessionId 已回填），
    // new 模式每次新建。会话读不出来（被删了）就重建一个，不让任务卡死。
    let session = null;
    if (task.sessionMode !== 'new' && task.sessionId) {
      try {
        session = await agentSessionStore.read(task.sessionId);
      } catch {
        session = null;
      }
    }
    if (!session) {
      session = {
        version: 1,
        sessionId: agentSessionStore.genSessionId(),
        title: task.name,
        source: 'schedule',
        cwd: task.cwd,
        model: '',
        engine: 'gai',
        engineSessionId: '',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        messages: [],
      };
    }

    if (isSessionBusy(session.sessionId)) {
      const record = {
        at: nowIso(), status: 'skipped-busy', trigger, fire: fireIso, sessionId: session.sessionId,
        error: '该会话正在生成中，本轮跳过',
      };
      await setTaskRun(task.id, record, session.sessionId).catch(() => {});
      broadcast({ type: 'task_finished', taskId: task.id, sessionId: session.sessionId, status: 'skipped-busy', trigger });
      return { started: false, reason: 'session-busy' };
    }
    acquireSession(session.sessionId);

    const abortController = new AbortController();
    const startedAt = Date.now();
    const runInfo = { abortController, startedAt, sessionId: session.sessionId, fireIso, child: null };
    running.set(task.id, runInfo);
    broadcast({ type: 'task_started', taskId: task.id, sessionId: session.sessionId, trigger });

    // 轮次序号要在 user 消息入栈之前取（与 agentRoutes.js 同一口径，见 sessionStore.recordTurnTiming）
    const turnIndex = (Array.isArray(session.messages) ? session.messages : [])
      .filter(m => m?.role === 'user').length;

    // 执行体放进内部 promise：调用方拿到 done 即可自行决定等不等。
    // （调度器 tick 不等它，避免长任务阻塞后续巡检；手动运行的路由也不等，
    //   否则"点一下立即运行"要等整轮跑完才收到响应。）
    const done = (async () => {
      let status = 'ok';
      let errorMsg = '';
      let summary = '';
      let toolCalls = 0;
      let timeoutHit = false;
      const timeoutId = setTimeout(() => {
        timeoutHit = true;
        try { abortController.abort(); } catch {}
      }, MAX_RUN_MS);

      try {
        if (!configManager) throw new Error('configManager 不可用');
        const rawConfig = await configManager.readRawConfigFile();
        const models = Array.isArray(rawConfig.models) ? rawConfig.models : [];
        // 任务可指定模型（按 name 或 model 匹配）；匹配不到回落全局默认
        let model = task.model
          ? models.find(m => m.name === task.model || m.model === task.model) || null
          : null;
        if (!model) model = models.find(m => m.isDefault) || models[0];
        if (!model) throw new Error('未配置 AI 模型，请先在设置中添加');
        session.model = `${model.model || ''} (${model.name || ''})`;
        const requestBudget = resolveRequestBudget(rawConfig.aiMaxRequestTokens);

        const send = (ev) => {
          if (!ev || typeof ev !== 'object') return;
          if (ev.type === 'tool_call_start') toolCalls++;
          if (ev.type === 'done' && typeof ev.content === 'string') summary = ev.content;
          if (ev.type === 'error') errorMsg = String(ev.error || '');
        };

        await runTurn({
          session,
          model,
          userMessage: task.prompt,
          cwd: task.cwd,
          locale: task.locale || 'zh',
          signal: abortController.signal,
          send,
          onChild: (child) => { runInfo.child = child; },
          // 无人值守：ask_user 不能挂起等回答（没人会答）。直接给模型一句
          // "没有人在场"的说明，让它自行判断继续，必要时把问题留在最终答复里。
          askUser: async () => '（这是定时任务的自动执行，当前没有人在实时回答。）'
            + '请基于已有信息自行判断并继续；如果这一步必须由人决定，跳过它，'
            + '并在最终答复里明确说明需要用户确认什么。',
          listProjects,
          dispatchTask,
          getContextBlock,
          requestBudget,
        });

        if (abortController.signal.aborted) {
          status = timeoutHit ? 'timed-out' : 'cancelled';
        }
      } catch (err) {
        if (abortController.signal.aborted) {
          status = timeoutHit ? 'timed-out' : 'cancelled';
        } else {
          status = 'error';
          errorMsg = err?.message || String(err);
        }
      } finally {
        clearTimeout(timeoutId);
        releaseSession(session.sessionId);
        running.delete(task.id);

        const durationMs = Date.now() - startedAt;
        try {
          recordTurnTiming(session, { turnIndex, durationMs });
          session.updatedAt = nowIso();
          await agentSessionStore.write(session.sessionId, session);
          agentSessionStore.enforceRetention().catch(() => {});
        } catch (err) {
          logger.warn(`[scheduler] 会话落盘失败(${task.id}): ${err?.message || err}`);
        }

        const record = {
          at: nowIso(),
          status,
          durationMs,
          sessionId: session.sessionId,
          trigger,
          fire: fireIso,
          toolCalls,
        };
        if (errorMsg) record.error = errorMsg;
        if (summary) record.summary = summary.slice(0, 600);
        if (status === 'timed-out') record.error = `执行超过 ${Math.round(MAX_RUN_MS / 60000)} 分钟，已强制中止`;

        await setTaskRun(task.id, record, task.sessionMode === 'new' ? '' : session.sessionId).catch((err) => {
          logger.warn(`[scheduler] 执行记录落盘失败(${task.id}): ${err?.message || err}`);
        });
        broadcast({
          type: 'task_finished',
          taskId: task.id,
          sessionId: session.sessionId,
          status,
          durationMs,
          trigger,
          error: record.error || '',
        });
      }
    })();

    return { started: true, done, sessionId: session.sessionId };
  }

  // ── 到点判定 ────────────────────────────────────────────────

  /**
   * 处理一轮。导出给测试与路由层（手动触发一次巡检）。
   * @returns {Promise<{ results: Array<{id:string, action:string}> }>}
   */
  async function tick() {
    if (ticking) return { results: [], note: 'tick-in-progress' };
    ticking = true;
    const results = [];
    try {
      const tasks = await loadTasks();
      // 任务集合变了（对话工具创建 / CLI 改 / 别的实例写）→ 通知前端刷新列表。
      // 首轮不广播（那是初始态，不是"变化"）。
      const signature = tasksSignature(tasks);
      if (lastTasksSignature !== null && signature !== lastTasksSignature) {
        broadcast({ type: 'tasks_changed' });
      }
      lastTasksSignature = signature;

      const nowD = now();
      for (const task of tasks) {
        if (!task.enabled) continue;
        if (running.has(task.id)) continue;

        let parsed;
        try {
          parsed = parseCron(task.schedule);
        } catch {
          continue; // 表达式非法：创建时校验过，这里防御坏数据
        }
        const prev = prevFireBefore(parsed, nowD);
        if (!prev) continue;

        // 已处置过这个触发点（跑过 / 按策略跳过 / 别处已认领）→ 放过
        if (task.lastFire && Date.parse(task.lastFire) >= prev.getTime()) continue;

        const missed = nowD.getTime() - prev.getTime() > MISSED_THRESHOLD_MS;
        if (missed && task.onMissed === 'skip') {
          await setTaskFire(task.id, prev.toISOString()).catch(() => {});
          await setTaskRun(task.id, {
            at: nowIso(), status: 'missed', trigger: 'schedule', fire: prev.toISOString(),
            error: '触发时间已过（g ui 未运行），按任务设置跳过',
          }).catch(() => {});
          broadcast({ type: 'task_finished', taskId: task.id, status: 'missed', trigger: 'schedule' });
          results.push({ id: task.id, action: 'missed-skipped' });
          continue;
        }

        // 抢认领：抢不到 = 别的实例在跑这个触发点
        let claimed = false;
        try {
          claimed = await claimFire(task.id, fireKey(prev));
        } catch (err) {
          logger.warn(`[scheduler] 认领失败(${task.id}): ${err?.message || err}`);
        }
        if (!claimed) {
          results.push({ id: task.id, action: 'claimed-elsewhere' });
          continue;
        }

        // 先记 lastFire 再执行：认领即处置。执行中途进程崩掉也不重跑
        //（宁可跳一轮，也不要重启后把一条已经跑了一半的任务再来一遍）。
        await setTaskFire(task.id, prev.toISOString()).catch(() => {});
        results.push({ id: task.id, action: 'started' });
        executeTask(task, { trigger: 'schedule', fireIso: prev.toISOString() })
          .then((r) => {
            // 执行体自带 try/catch，这里的兜底只防"它自己抛出"这种意外
            if (r?.done) {
              r.done.catch((err) => logger.error(`[scheduler] 任务执行异常(${task.id}): ${err?.message || err}`));
            }
          })
          .catch((err) => logger.error(`[scheduler] 任务启动异常(${task.id}): ${err?.message || err}`));
      }

      // 顺手清理过期认领文件（保留近两天，供排查"这轮为什么没跑"）
      cleanClaims().catch(() => {});
      return { results };
    } finally {
      ticking = false;
    }
  }

  // ── 对外接口 ────────────────────────────────────────────────

  function start() {
    if (timer) return;
    // 启动即巡检一轮：错过补偿就发生在这一轮里
    tick().catch((err) => logger.warn(`[scheduler] 首轮巡检失败: ${err?.message || err}`));
    timer = setInterval(() => {
      tick().catch((err) => logger.warn(`[scheduler] 巡检失败: ${err?.message || err}`));
    }, TICK_INTERVAL_MS);
    // 不阻止进程退出（测试里创建了实例也不会有悬挂句柄）
    timer.unref?.();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  /** 手动立即执行（不参与 cron 判定，也不写 lastFire —— 不干扰正常调度节奏） */
  async function runTaskNow(taskId) {
    const task = await getTask(taskId);
    if (!task) {
      const err = new Error(`任务不存在: ${taskId}`);
      err.statusCode = 404;
      throw err;
    }
    return executeTask(task, { trigger: 'manual' });
  }

  /** 停止正在执行的任务（手动运行与定时运行一视同仁） */
  function stopTask(taskId) {
    const info = running.get(taskId);
    if (!info) return false;
    try { info.child?.kill?.('SIGTERM'); } catch {}
    try { info.abortController.abort(); } catch {}
    return true;
  }

  /** 运行中快照（路由/前端用）：taskId → 概要 */
  function getRunningTasks() {
    return [...running.entries()].map(([taskId, info]) => ({
      taskId,
      sessionId: info.sessionId,
      startedAt: new Date(info.startedAt).toISOString(),
      fire: info.fireIso || '',
    }));
  }

  /**
   * 广播"任务列表变了"。路由层在 CRUD 之后调它，让所有打开面板的窗口立即刷新
   *（调度器 tick 里的签名检测是外部改动的兜底通道）。
   */
  function emitTasksChanged() {
    // 同步刷新签名，避免下一个 tick 因同一变化再广播一次
    loadTasks().then((tasks) => { lastTasksSignature = tasksSignature(tasks); }).catch(() => {});
    broadcast({ type: 'tasks_changed' });
  }

  function onEvent(handler) {
    emitter.on('event', handler);
    return () => emitter.off('event', handler);
  }

  return {
    start,
    stop,
    tick,
    runTaskNow,
    stopTask,
    getRunningTasks,
    emitTasksChanged,
    onEvent,
    /** 测试用：直接跑一个任务对象（跳过任务库查找） */
    _executeTask: executeTask,
  };
}

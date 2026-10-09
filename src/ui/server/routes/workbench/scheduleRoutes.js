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
// 定时任务路由。
//
// 路由清单:
//   GET    /api/schedules              — 列表(+ 每个任务算好的 nextRunAt 与运行中状态)
//   POST   /api/schedules              — 创建
//   PUT    /api/schedules/:id          — 更新(白名单字段,见 scheduleStore.PATCH 口径)
//   DELETE /api/schedules/:id          — 删除(运行中先停)
//   POST   /api/schedules/:id/run      — 手动立即执行(立即响应,执行在后台)
//   POST   /api/schedules/:id/stop     — 中止正在执行的那一轮
//   GET    /api/schedules/events       — SSE:任务增删改 + 执行开始/结束
//
// nextRunAt 在**服务端**算：cron 解析只有一份实现（utils/scheduleCron.js），
// 前端拿现成的 ISO 时间只做展示格式化，不自己算 —— 免得两个口径漂移。

import { asyncRoute, HttpError } from '../../utils/asyncRoute.js';
import {
  loadTasks, createTask, updateTask, deleteTask,
} from '../../../../utils/scheduleStore.js';
import { nextFireAfter } from '../../../../utils/scheduleCron.js';
import { nowIso } from './shared.js';

const RUN_FAIL_REASONS = {
  'already-running': '该任务正在执行中，请等它跑完',
  'session-busy': '专属会话正在生成中（可能你正在和它对话），请稍后再试',
  'cwd-missing': '项目目录不存在，请先修正任务的项目目录',
};

export function registerScheduleRoutes({ app, scheduler, getCurrentProjectPath }) {
  // ════════════════════════════════════════════════════════════════════════
  // §1. 列表
  // ════════════════════════════════════════════════════════════════════════
  app.get('/api/schedules', asyncRoute(async (_req, res) => {
    const tasks = await loadTasks();
    const runningByTask = new Map(scheduler.getRunningTasks().map(r => [r.taskId, r]));
    const nowD = new Date();
    const list = tasks.map((t) => ({
      ...t,
      nextRunAt: t.enabled ? (nextFireAfter(t.schedule, nowD)?.toISOString() || '') : '',
      running: runningByTask.get(t.id) || null,
    }));
    res.json({ success: true, tasks: list });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §2. 创建 / 更新 / 删除
  // ════════════════════════════════════════════════════════════════════════
  app.post('/api/schedules', asyncRoute(async (req, res) => {
    const body = req.body || {};
    const task = await createTask({
      ...body,
      // 不指定项目目录时落在"当前项目"——面板里最常见的用法
      cwd: body.cwd || (typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : ''),
    });
    scheduler.emitTasksChanged();
    res.json({ success: true, task });
  }));

  app.put('/api/schedules/:id', asyncRoute(async (req, res) => {
    const task = await updateTask(req.params.id, req.body || {});
    scheduler.emitTasksChanged();
    res.json({ success: true, task });
  }));

  app.delete('/api/schedules/:id', asyncRoute(async (req, res) => {
    // 先停：正在跑的轮次没有理由跟着任务一起被删掉后还往不存在的任务上写记录
    scheduler.stopTask(req.params.id);
    await deleteTask(req.params.id);
    scheduler.emitTasksChanged();
    res.json({ success: true });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §3. 手动执行 / 停止
  // ════════════════════════════════════════════════════════════════════════
  app.post('/api/schedules/:id/run', asyncRoute(async (req, res) => {
    const result = await scheduler.runTaskNow(req.params.id);
    if (!result.started) {
      throw new HttpError(409, RUN_FAIL_REASONS[result.reason] || `无法启动: ${result.reason}`);
    }
    // 执行在后台跑：路由不等（面板上看"运行中"，结束后 SSE 推 task_finished）
    if (result.done) result.done.catch(() => {});
    res.json({ success: true, started: true, sessionId: result.sessionId });
  }));

  app.post('/api/schedules/:id/stop', asyncRoute(async (req, res) => {
    const stopped = scheduler.stopTask(req.params.id);
    res.json({ success: true, stopped });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §4. SSE 事件流（格式与 /api/workbench/events 一致：data: {...}）
  // ════════════════════════════════════════════════════════════════════════
  app.get('/api/schedules/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    const send = (data) => {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
    };
    send({ type: 'hello', running: scheduler.getRunningTasks(), ts: nowIso() });
    const dispose = scheduler.onEvent(evt => send(evt));
    const keepAlive = setInterval(() => {
      try { res.write(': keep-alive\n\n'); } catch {}
    }, 15000);
    req.on('close', () => {
      clearInterval(keepAlive);
      dispose();
    });
  });
}

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
// 定时任务路由单测：CRUD / 手动执行 / SSE 事件转发。
// 调度器与任务库都用替身/沙箱，测的是路由层的组装与错误口径。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'zen-sched-routes-'));
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

const { registerScheduleRoutes } = await import('./scheduleRoutes.js');
const { deleteTask } = await import('../../../../utils/scheduleStore.js');

const WORKDIR = mkdtempSync(path.join(os.tmpdir(), 'zen-sched-routes-work-'));

function makeApp() {
  const routes = { get: {}, post: {}, put: {}, delete: {} };
  return {
    routes,
    get(route, handler) { routes.get[route] = handler; },
    post(route, handler) { routes.post[route] = handler; },
    put(route, handler) { routes.put[route] = handler; },
    delete(route, handler) { routes.delete[route] = handler; },
  };
}

function makeSchedulerStub({ running = [], runResult = { started: true, done: Promise.resolve(), sessionId: 'ag-x' }, stopResult = true } = {}) {
  const calls = { changed: 0, runFor: [], stopped: [], listeners: [] };
  return {
    calls,
    getRunningTasks: () => running,
    runTaskNow: async (id) => { calls.runFor.push(id); return runResult; },
    stopTask: (id) => { calls.stopped.push(id); return stopResult; },
    emitTasksChanged: () => { calls.changed++; },
    onEvent: (handler) => { calls.listeners.push(handler); return () => { calls.listeners = calls.listeners.filter(h => h !== handler); }; },
  };
}

function makeRes() {
  return {
    code: 200,
    payload: null,
    json(v) { this.payload = v; return this; },
    status(code) { this.code = code; return this; },
  };
}

function makeReq(over = {}) {
  return { params: {}, body: {}, query: {}, method: 'GET', path: '/', on() {}, ...over };
}

test('GET 列表:附 nextRunAt 与运行中状态', async () => {
  const app = makeApp();
  const scheduler = makeSchedulerStub({ running: [{ taskId: 'sch-abc', sessionId: 'ag-1', startedAt: 'x', fire: '' }] });
  registerScheduleRoutes({ app, scheduler, getCurrentProjectPath: () => WORKDIR });

  // 先用创建路由建一条任务
  const createRes = makeRes();
  await app.routes.post['/api/schedules'](
    makeReq({ method: 'POST', body: { name: '列表用例', schedule: '0 9 * * *', cwd: WORKDIR, prompt: 'x' } }),
    createRes
  );
  assert.equal(createRes.payload.success, true);
  assert.equal(scheduler.calls.changed, 1);
  const taskId = createRes.payload.task.id;

  // 让运行中的那条对上刚建的任务 id（模拟正在跑）
  scheduler.getRunningTasks = () => [{ taskId, sessionId: 'ag-1', startedAt: 'x', fire: '' }];

  const res = makeRes();
  await app.routes.get['/api/schedules'](makeReq(), res);
  assert.equal(res.payload.success, true);
  const listed = res.payload.tasks.find(t => t.id === taskId);
  assert.ok(listed);
  assert.ok(listed.nextRunAt, 'enabled 任务应带 nextRunAt');
  assert.equal(listed.running.taskId, taskId);

  await deleteTask(taskId);
});

test('POST 创建:不传 cwd 时落在当前项目;校验失败转 400', async () => {
  const app = makeApp();
  const scheduler = makeSchedulerStub();
  registerScheduleRoutes({ app, scheduler, getCurrentProjectPath: () => WORKDIR });

  const okRes = makeRes();
  await app.routes.post['/api/schedules'](
    makeReq({ method: 'POST', body: { name: '默认目录', schedule: '*/5 * * * *', prompt: 'x' } }),
    okRes
  );
  assert.equal(okRes.payload.task.cwd, WORKDIR);
  await deleteTask(okRes.payload.task.id);

  const badRes = makeRes();
  await app.routes.post['/api/schedules'](
    makeReq({ method: 'POST', body: { name: '', schedule: '0 9 * * *', cwd: WORKDIR, prompt: 'x' } }),
    badRes
  );
  assert.equal(badRes.code, 400);
  assert.equal(badRes.payload.success, false);
  assert.match(badRes.payload.error, /任务名不能为空/);
  assert.equal(scheduler.calls.changed, 1, '校验失败不该广播 tasks_changed');
});

test('PUT 更新 / DELETE 删除(先停后删)', async () => {
  const app = makeApp();
  const scheduler = makeSchedulerStub();
  registerScheduleRoutes({ app, scheduler, getCurrentProjectPath: () => WORKDIR });

  const createRes = makeRes();
  await app.routes.post['/api/schedules'](
    makeReq({ method: 'POST', body: { name: '待改', schedule: '0 9 * * *', cwd: WORKDIR, prompt: 'x' } }),
    createRes
  );
  const taskId = createRes.payload.task.id;

  const putRes = makeRes();
  await app.routes.put['/api/schedules/:id'](
    makeReq({ method: 'PUT', params: { id: taskId }, body: { name: '改完', enabled: false } }),
    putRes
  );
  assert.equal(putRes.payload.task.name, '改完');
  assert.equal(putRes.payload.task.enabled, false);

  const delRes = makeRes();
  await app.routes.delete['/api/schedules/:id'](makeReq({ method: 'DELETE', params: { id: taskId } }), delRes);
  assert.equal(delRes.payload.success, true);
  assert.deepEqual(scheduler.calls.stopped, [taskId], '删除前应先停掉运行中的轮次');
  assert.equal(scheduler.calls.changed, 3, '创建/更新/删除各广播一次');
});

test('POST run:成功立即响应;会话忙等失败转 409', async () => {
  const app = makeApp();

  const okScheduler = makeSchedulerStub();
  registerScheduleRoutes({ app, scheduler: okScheduler, getCurrentProjectPath: () => WORKDIR });
  const okRes = makeRes();
  await app.routes.post['/api/schedules/:id/run'](makeReq({ method: 'POST', params: { id: 'sch-1' } }), okRes);
  assert.equal(okRes.payload.success, true);
  assert.equal(okRes.payload.started, true);
  assert.deepEqual(okScheduler.calls.runFor, ['sch-1']);

  const busyApp = makeApp();
  const busyScheduler = makeSchedulerStub({ runResult: { started: false, reason: 'session-busy' } });
  registerScheduleRoutes({ app: busyApp, scheduler: busyScheduler, getCurrentProjectPath: () => WORKDIR });
  const busyRes = makeRes();
  await busyApp.routes.post['/api/schedules/:id/run'](makeReq({ method: 'POST', params: { id: 'sch-2' } }), busyRes);
  assert.equal(busyRes.code, 409);
  assert.match(busyRes.payload.error, /专属会话正在生成中/);
});

test('POST stop:透传 stopped 结果', async () => {
  const app = makeApp();
  const scheduler = makeSchedulerStub({ stopResult: false });
  registerScheduleRoutes({ app, scheduler, getCurrentProjectPath: () => WORKDIR });
  const res = makeRes();
  await app.routes.post['/api/schedules/:id/stop'](makeReq({ method: 'POST', params: { id: 'sch-9' } }), res);
  assert.equal(res.payload.success, true);
  assert.equal(res.payload.stopped, false);
});

test('SSE:hello 快照 + 转发调度器事件 + 断开时清理', async () => {
  const app = makeApp();
  const scheduler = makeSchedulerStub({ running: [{ taskId: 'sch-a', sessionId: 'ag-1', startedAt: 'x', fire: '' }] });
  registerScheduleRoutes({ app, scheduler, getCurrentProjectPath: () => WORKDIR });

  const written = [];
  let closeHandler = null;
  const res = {
    set() {},
    flushHeaders() {},
    write(chunk) { written.push(chunk); return true; },
  };
  const req = { on(event, cb) { if (event === 'close') closeHandler = cb; } };

  app.routes.get['/api/schedules/events'](req, res);
  assert.equal(scheduler.calls.listeners.length, 1, 'SSE 连接应挂上事件监听');

  // hello
  assert.match(written[0], /^data: /);
  const hello = JSON.parse(written[0].slice(6));
  assert.equal(hello.type, 'hello');
  assert.equal(hello.running.length, 1);

  // 调度器广播一条事件 → 转发
  scheduler.calls.listeners[0]({ type: 'task_finished', taskId: 'sch-a', status: 'ok' });
  assert.match(written[1], /task_finished/);

  // 断开清理
  closeHandler();
  assert.equal(scheduler.calls.listeners.length, 0);
});

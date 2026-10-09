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
// schedule_task 工具的单测。
//
// 为什么单独一个文件（而不是并进 tools.test.js）：本工具会**真实读写**
// 任务库（~/.zen-gitsync/schedules.json），而 tools.test.js 是静态 import、
// HOME 指向的是真实目录 —— 并进去就会往用户的任务库里写测试数据。
// 这里先建沙箱再动态 import，与 scheduler.test.js 同一套做法。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'zen-sched-tool-'));
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

const { TOOL_DEFINITIONS, executeTool } = await import('./tools.js');
const { loadTasks, deleteTask } = await import('../../utils/scheduleStore.js');

const WORKDIR = mkdtempSync(path.join(os.tmpdir(), 'zen-sched-tool-work-'));
const ctx = { cwd: WORKDIR, locale: 'zh' };

test('schema:schedule_task 已注册,action 枚举完整', () => {
  const def = TOOL_DEFINITIONS.find(t => t.function.name === 'schedule_task');
  assert.ok(def, 'TOOL_DEFINITIONS 里必须有 schedule_task');
  assert.deepEqual(def.function.parameters.required, ['action']);
  assert.deepEqual(
    def.function.parameters.properties.action.enum,
    ['create', 'list', 'remove', 'enable', 'disable'],
  );
  // 边界说明必须写进描述：执行者是 g ui 调度器 + 没运行时不会跑
  assert.match(def.function.description, /g ui/);
  assert.match(def.function.description, /不会执行/);
});

test('create:成功登记,默认绑定 ctx.cwd,on_missed 默认 run', async () => {
  const out = await executeTool('schedule_task', {
    action: 'create',
    name: '每日拉代码',
    schedule: '0 9 * * *',
    prompt: '检查所有仓库远端更新，有变更就 pull',
  }, ctx);
  assert.match(out, /已创建定时任务「每日拉代码」/);
  assert.match(out, /下次执行/);
  assert.match(out, /g ui 服务端的调度器/);

  const tasks = await loadTasks({ fresh: true });
  const task = tasks.find(t => t.name === '每日拉代码');
  assert.ok(task);
  assert.equal(task.cwd, WORKDIR);
  assert.equal(task.onMissed, 'run');
  assert.equal(task.enabled, true);
  await deleteTask(task.id);
});

test('create:缺字段 / 坏 cron / 目录不存在都给可读错误,不落库', async () => {
  const before = (await loadTasks({ fresh: true })).length;

  assert.match(await executeTool('schedule_task', { action: 'create', schedule: '0 9 * * *', prompt: 'x' }, ctx), /需要 name/);
  assert.match(await executeTool('schedule_task', { action: 'create', name: 'x', prompt: 'x' }, ctx), /需要 schedule/);
  assert.match(await executeTool('schedule_task', { action: 'create', name: 'x', schedule: '0 9 * * *' }, ctx), /需要 prompt/);
  assert.match(await executeTool('schedule_task', { action: 'create', name: 'x', schedule: '99 9 * * *', prompt: 'x' }, ctx), /cron/);
  assert.match(
    await executeTool('schedule_task', { action: 'create', name: 'x', schedule: '0 9 * * *', prompt: 'x', cwd: path.join(WORKDIR, 'nope') }, ctx),
    /目录不存在/,
  );

  assert.equal((await loadTasks({ fresh: true })).length, before, '非法输入不该落库');
});

test('create:on_missed=skip 透传;cwd 显式传入优先于 ctx', async () => {
  const other = mkdtempSync(path.join(os.tmpdir(), 'zen-sched-tool-other-'));
  const out = await executeTool('schedule_task', {
    action: 'create', name: '跳过型', schedule: '30 18 * * 1-5', prompt: 'x', cwd: other, on_missed: 'skip',
  }, ctx);
  assert.match(out, /直接跳过/);
  const tasks = await loadTasks({ fresh: true });
  const task = tasks.find(t => t.name === '跳过型');
  assert.equal(task.cwd, other);
  assert.equal(task.onMissed, 'skip');
  await deleteTask(task.id);
});

test('list / enable / disable / remove 全流程', async () => {
  assert.equal(await executeTool('schedule_task', { action: 'list' }, ctx), '当前没有任何定时任务。');

  await executeTool('schedule_task', { action: 'create', name: '流程用例', schedule: '*/30 * * * *', prompt: 'ping' }, ctx);
  const listed = await executeTool('schedule_task', { action: 'list' }, ctx);
  assert.match(listed, /\[启用\] 流程用例/);
  assert.match(listed, /\*\/30 \* \* \* \*/);
  const id = listed.match(/id=(sch-[\w-]+)/)?.[1];
  assert.ok(id, 'list 结果里必须带 id');

  assert.match(await executeTool('schedule_task', { action: 'disable', id }, ctx), /已停用/);
  assert.match(await executeTool('schedule_task', { action: 'list' }, ctx), /\[停用\] 流程用例/);
  assert.match(await executeTool('schedule_task', { action: 'enable', id }, ctx), /已启用/);

  assert.match(await executeTool('schedule_task', { action: 'remove', id }, ctx), /已删除/);
  assert.equal(await executeTool('schedule_task', { action: 'list' }, ctx), '当前没有任何定时任务。');
});

test('remove/enable 缺 id;未知 action 都给明确错误', async () => {
  assert.match(await executeTool('schedule_task', { action: 'remove' }, ctx), /需要 id/);
  assert.match(await executeTool('schedule_task', { action: 'enable' }, ctx), /需要 id/);
  assert.match(await executeTool('schedule_task', { action: 'explode' }, ctx), /未知的 action/);
  assert.match(await executeTool('schedule_task', { action: 'remove', id: 'sch-nope' }, ctx), /任务不存在/);
});

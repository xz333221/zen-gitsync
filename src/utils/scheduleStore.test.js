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
// 任务库单测。HOME/USERPROFILE 必须在 import 之前指向沙箱 —— paths.js 的
// 常量在模块加载时求值，晚一步就写到真实 ~/.zen-gitsync 里了。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'zen-sched-store-'));
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

const {
  createTask, updateTask, deleteTask, loadTasks, getTask,
  setTaskFire, setTaskRun, claimFire, cleanClaims,
  SCHEDULES_FILE, SCHEDULE_CLAIMS_DIR, MAX_TASKS,
} = await import('./scheduleStore.js');

const WORKDIR = mkdtempSync(path.join(os.tmpdir(), 'zen-sched-cwd-'));
const base = (over = {}) => ({
  name: '每日拉代码',
  schedule: '0 9 * * *',
  cwd: WORKDIR,
  prompt: '检查所有仓库远端更新，有变更就 pull',
  ...over,
});

test('createTask:归一化默认值 + 落盘', async () => {
  const task = await createTask(base());
  assert.match(task.id, /^sch-/);
  assert.equal(task.enabled, true);
  assert.equal(task.locale, 'zh');
  assert.equal(task.sessionMode, 'dedicated');
  assert.equal(task.onMissed, 'run');
  assert.equal(task.sessionId, '');
  assert.equal(task.lastFire, '');
  assert.equal(task.lastRun, null);

  const raw = JSON.parse(await (await import('node:fs/promises')).readFile(SCHEDULES_FILE, 'utf-8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.tasks.length, 1);
  assert.equal(raw.tasks[0].id, task.id);
});

test('createTask:非法输入被拒(空名 / 坏 cron / 相对路径 / 目录不存在)', async () => {
  await assert.rejects(createTask(base({ name: '' })), /任务名不能为空/);
  await assert.rejects(createTask(base({ prompt: '  ' })), /提示词不能为空/);
  await assert.rejects(createTask(base({ schedule: '0 9 * *' })), /5 个字段/);
  await assert.rejects(createTask(base({ schedule: '99 9 * * *' })), /范围/);
  await assert.rejects(createTask(base({ cwd: 'relative/dir' })), /绝对路径/);
  await assert.rejects(createTask(base({ cwd: path.join(WORKDIR, 'not-exists') })), /目录不存在/);
});

test('updateTask:部分更新、保留系统字段、失败不落盘', async () => {
  const task = await createTask(base({ name: '待改任务' }));
  await setTaskFire(task.id, '2026-01-15T01:00:00.000Z');

  const updated = await updateTask(task.id, { name: '改名了', enabled: false });
  assert.equal(updated.name, '改名了');
  assert.equal(updated.enabled, false);
  // 系统字段不被 patch 波及
  assert.equal(updated.lastFire, '2026-01-15T01:00:00.000Z');
  assert.equal(updated.schedule, '0 9 * * *');
  assert.equal(updated.createdAt, task.createdAt);

  // sessionId 是调度器回填的，走 setTaskRun 通道；patch 里带同名字段也不该生效？
  // —— 这里明确：patch 走 normalizeTask，sessionId 从 existing 继承（白名单外字段忽略）
  const sneaky = await updateTask(task.id, { sessionId: 'ag-hack', bogus: 1 });
  assert.equal(sneaky.sessionId, '');
  assert.equal(sneaky.bogus, undefined);

  // 校验失败：磁盘上保持原样
  await assert.rejects(updateTask(task.id, { schedule: 'bad cron here' }), /cron/);
  const after = await getTask(task.id);
  assert.equal(after.schedule, '0 9 * * *');
  assert.equal(after.name, '改名了');

  await assert.rejects(updateTask('sch-not-exist', { name: 'x' }), /任务不存在/);
});

test('deleteTask:删除 + 不存在时报错', async () => {
  const task = await createTask(base({ name: '待删' }));
  await deleteTask(task.id);
  assert.equal(await getTask(task.id), null);
  await assert.rejects(deleteTask(task.id), /任务不存在/);
});

test('loadTasks:外部改动按 mtime 自动重读(模拟 CLI/另一实例写库)', async () => {
  const before = await loadTasks();
  const extra = {
    id: 'sch-external-1', name: '外部创建', enabled: true, schedule: '*/5 * * * *',
    cwd: WORKDIR, prompt: '来自外部', model: '', locale: 'zh', sessionMode: 'dedicated',
    onMissed: 'run', onBusy: 'skip', sessionId: '', lastFire: '', lastRun: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const raw = JSON.parse(await (await import('node:fs/promises')).readFile(SCHEDULES_FILE, 'utf-8'));
  raw.tasks.push(extra);
  writeFileSync(SCHEDULES_FILE, JSON.stringify(raw, null, 2));
  // 确保 mtime 与 size 至少有一项变化（同尺寸快速改写时 mtimeMs 精度足够，但保险起见动一下时间）
  const now = Date.now();
  utimesSync(SCHEDULES_FILE, now / 1000, now / 1000);

  const after = await loadTasks();
  assert.equal(after.length, before.length + 1);
  assert.ok(after.some(t => t.id === 'sch-external-1'));
});

test('claimFire:wx 原子认领,同一时刻只成功一次;不同时刻互不影响', async () => {
  const ok1 = await claimFire('sch-x', '202601150900');
  const ok2 = await claimFire('sch-x', '202601150900');
  assert.equal(ok1, true);
  assert.equal(ok2, false);
  assert.equal(await claimFire('sch-x', '202601150901'), true);
  assert.equal(await claimFire('sch-y', '202601150900'), true);
});

test('cleanClaims:过期的认领文件被清掉,新的保留', async () => {
  await claimFire('sch-clean', '202001010000');
  await claimFire('sch-clean', '202001010001');
  const old = path.join(SCHEDULE_CLAIMS_DIR, 'sch-clean__202001010000.json');
  const stale = Date.now() - 3 * 24 * 3600 * 1000;
  utimesSync(old, stale / 1000, stale / 1000);

  const removed = await cleanClaims();
  assert.ok(removed >= 1);
  const rest = await (await import('node:fs/promises')).readdir(SCHEDULE_CLAIMS_DIR);
  assert.ok(!rest.includes('sch-clean__202001010000.json'));
  assert.ok(rest.includes('sch-clean__202001010001.json'));
});

test('setTaskRun:执行记录与专属会话回填', async () => {
  const task = await createTask(base({ name: '跑一次' }));
  await setTaskRun(task.id, { at: '2026-01-15T09:00:12.000Z', status: 'ok', durationMs: 12000 }, 'ag-abc12345-xyz98765');
  const t = await getTask(task.id);
  assert.equal(t.lastRun.status, 'ok');
  assert.equal(t.sessionId, 'ag-abc12345-xyz98765');
});

test('createTask:数量上限', async () => {
  const current = await loadTasks();
  const room = MAX_TASKS - current.length;
  const created = [];
  for (let i = 0; i < room; i++) {
    created.push(await createTask(base({ name: `占位${i}` })));
  }
  await assert.rejects(createTask(base({ name: '超限' })), /上限/);
  // 自清理：别把 100 个占位留给后面的用例
  for (const t of created) await deleteTask(t.id);
  assert.equal((await loadTasks({ fresh: true })).length, current.length);
});

test('坏文件:读取时按空任务库处理,不抛给调用方', async () => {
  const before = await loadTasks({ fresh: true });
  assert.ok(before.length > 0, '本用例依赖前面用例已创建任务');
  const backup = await (await import('node:fs/promises')).readFile(SCHEDULES_FILE, 'utf-8');
  writeFileSync(SCHEDULES_FILE, '{ not valid json');
  const tasks = await loadTasks({ fresh: true });
  assert.deepEqual(tasks, []);
  writeFileSync(SCHEDULES_FILE, backup);
  const restored = await loadTasks({ fresh: true });
  assert.equal(restored.length, before.length);
});

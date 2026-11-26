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
// task_status 数据源单测：列表 / 指定 id / 找不到 / 空看板。
// 数据全部落在临时沙盒（USERPROFILE 指过去），绝不碰真实任务库。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'zen-taskstatus-'));
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

const { createTaskStatusProvider } = await import('./taskStatusProvider.js');
const { TASKS_FILE, JOBS_FILE } = await import('./shared.js');

async function seed({ tasks = [], jobs = [] }) {
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true });
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ tasks }));
  await fsp.writeFile(JOBS_FILE, JSON.stringify({ version: 1, jobs }));
}

test('空看板：给一句能照着做的话', async () => {
  await seed({});
  const text = await createTaskStatusProvider()({});
  assert.ok(text.includes('没有任何任务'));
});

test('不带 id：按最近更新列出任务，列口径与看板同一份（deriveTaskColumn）', async () => {
  await seed({
    tasks: [
      { id: 't-old', title: '旧任务', projectPath: 'D:/p', updatedAt: '2026-11-25T00:00:00.000Z' },
      { id: 't-new', title: '新任务', projectPath: 'D:/p', updatedAt: '2026-11-26T00:00:00.000Z' },
    ],
    jobs: [{
      id: 'j1', taskId: 't-new', status: 'done',
      startedAt: '2026-11-26T01:00:00.000Z', endedAt: '2026-11-26T01:02:00.000Z',
      output: '干完了',
    }],
  });
  const text = await createTaskStatusProvider()({});
  // 最新的排前面
  assert.ok(text.indexOf('新任务') < text.indexOf('旧任务'));
  assert.ok(text.includes('id=t-new'));
  assert.ok(text.includes('看板状态：已完成'));
  assert.ok(text.includes('最近一次执行：成功'));
  assert.ok(text.includes('用时2分'));
  assert.ok(text.includes('干完了'));
  // 没跑过的任务给"还没执行过"
  assert.ok(text.includes('还没执行过'));
});

test('带 id：只查那一条；输出按结尾截取', async () => {
  await seed({
    tasks: [{ id: 't-1', title: '派出去的活', projectPath: 'D:/p', updatedAt: '2026-11-26T00:00:00.000Z' }],
    jobs: [{
      id: 'j1', taskId: 't-1', status: 'error', error: 'spawn 失败',
      startedAt: '2026-11-26T01:00:00.000Z', endedAt: '2026-11-26T01:00:30.000Z',
      output: 'x'.repeat(1000) + '真正的结尾',
    }],
  });
  const text = await createTaskStatusProvider({ outputTailChars: 50 })({ taskId: 't-1' });
  assert.ok(text.includes('看板状态：待处理'), 'error 的任务回到待处理列（与看板同口径）');
  assert.ok(text.includes('最近一次执行：出错'));
  assert.ok(text.includes('错误：spawn 失败'));
  assert.ok(text.includes('真正的结尾'));
  assert.ok(!text.includes('x'.repeat(200)), '只给输出尾部');
});

test('id 不存在：明确说没找到，并提示可列出最近任务', async () => {
  await seed({ tasks: [{ id: 't-1', title: 'x', updatedAt: '' }] });
  const text = await createTaskStatusProvider()({ taskId: '没有的' });
  assert.ok(text.includes('没有找到'));
  assert.ok(text.includes('taskId'));
});

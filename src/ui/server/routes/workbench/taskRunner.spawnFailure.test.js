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

// 回归：spawn 失败的那一轮也必须留下时间戳（2026-11-25 实测事故）。
//
// 现场：用户的 blog 任务点「重试」时正好撞上 `npm i -g @anthropic-ai/claude-code`
// 换包窗口，启动器抛 `spawn claude.exe ENOENT`。这条 job 只写了 error / status，
// startedAt 与 endedAt 都是空的（`job.startedAt = nowIso()` 在启动器返回之后才执行），
// 结果：
//   1. 前端按 startedAt 升序排、缺失当最末 —— 更早的失败被摆到对话流最底部，
//      后面成功的轮次反而排在它上面，看着像"报错常驻在下面"；
//   2. jobActivity 的耗时 / 静默判定拿不到锚点。
// 这里钉住收口函数本身（跑真 spawn 失败要造 PATH，不划算），口径：
//   · startedAt 缺失 → 用失败时刻补上
//   · startedAt 已有（跑到一半才炸）→ 原值不动，只补 endedAt
//   · 非 Error 抛出物（字符串）也要留下原因

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../../../..');

// ---- 环境隔离:必须在 import taskRunner.js 之前完成 ----
// 只测一个纯函数，但 import 链会带上 jobStore 的 hydrate —— 不隔离就会去读
// 用户真实的 ~/.zen-gitsync/jobs.json（几十 MB），沙箱里读不到反而是好事。
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'zen-taskrunner-spawnfail-test-'));
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

const { stampJobFailure } = await import(
  pathToFileURL(path.join(projectRoot, 'src/ui/server/routes/workbench/taskRunner.js')).href
);

test('spawn ENOENT：startedAt 与 endedAt 都补上，等于失败时刻', () => {
  const job = { id: 'j1', status: 'pending', error: null };
  const at = '2026-11-25T13:35:22.000Z';
  const err = Object.assign(new Error('spawn claude.exe ENOENT'), { code: 'ENOENT' });

  const out = stampJobFailure(job, err, at);

  assert.equal(out, job, '返回同一个 job（便于链式断言）');
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'spawn claude.exe ENOENT');
  assert.equal(job.startedAt, at);
  assert.equal(job.endedAt, at);
});

test('跑到一半才炸：已有的 startedAt 不被覆盖，只补 endedAt', () => {
  const job = { id: 'j2', status: 'running', startedAt: '2026-11-25T13:30:00.000Z' };

  stampJobFailure(job, new Error('解析中途炸了'), '2026-11-25T13:31:00.000Z');

  assert.equal(job.startedAt, '2026-11-25T13:30:00.000Z', '真实起跑时刻不能被抹成失败时刻');
  assert.equal(job.endedAt, '2026-11-25T13:31:00.000Z');
});

test('非 Error 抛出物（字符串）也留得下原因', () => {
  const job = { id: 'j3' };

  stampJobFailure(job, 'plain string failure', '2026-11-25T13:32:00.000Z');

  assert.equal(job.error, 'plain string failure');
  assert.equal(job.status, 'error');
});

test('不注入时刻时落当前时间（能被 Date.parse 吃掉）', () => {
  const job = { id: 'j4' };

  stampJobFailure(job, new Error('x'));

  assert.ok(!Number.isNaN(Date.parse(job.startedAt)));
  assert.ok(!Number.isNaN(Date.parse(job.endedAt)));
  assert.equal(job.startedAt, job.endedAt);
});

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
// 思考段计时的回归测试（2026-10-08）。
//
// 背景：任务执行弹窗里的思考块以前只有「思考」两个字，折叠着看不出它想了多久。
// zen-ai-chat-ui 的 ThinkingBlock 支持在标题右侧显示「第一个思考分片 → 最后一个
// 分片」的耗时（折叠也看得见），但时间戳得由宿主喂 —— 也就是这里测的
// appendThinkingToJob。口径拧了「单测全绿而数字是错的」（比如把起点记成 job 开始、
// 或每次追加都重置起点），所以把口径钉死在单测里。
//
// 钉住的口径：
//   1. 第一个分片记起点，之后每个分片把终点往前推（**不是**"到第一个正文为止"）
//   2. 起点一旦记下就不再移动（中途隔着工具调用再想一段，预览窗口跟着往后推）
//   3. 空分片不产生任何副作用（连 lastActivityAt 都不碰）
//   4. 老 job（没有这两个字段）第一次追加也补得上
//   5. 返回值 = 本次真正追加的增量（批量推送 job:thinking-delta 用它）
//
// 隔离策略同 taskRunner.toolcalls.test.js：import taskRunner.js 之前把
// USERPROFILE/HOME 指向 mkdtemp 沙箱（taskRunner → jobStore import 时就会 hydrate）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../../../..');

// ---- 环境隔离:必须在 import taskRunner.js 之前完成 ----
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'zen-thinking-test-'));
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

const { appendThinkingToJob } = await import(
  pathToFileURL(path.join(projectRoot, 'src/ui/server/routes/workbench/taskRunner.js')).href
);

/** 一个刚创建、还没产出任何思考的 job（字段形状照 runSingleSubtask 里那个字面量） */
const makeJob = (extra = {}) => ({
  id: 'j1',
  thinking: '',
  lastActivityAt: null,
  thinkingStartedAt: null,
  thinkingEndedAt: null,
  ...extra,
});

test('第一个分片记起点，之后每个分片把终点往前推', () => {
  const job = makeJob();
  const t1 = '2026-10-08T01:00:00.000Z';
  const t2 = '2026-10-08T01:00:03.000Z';
  const t3 = '2026-10-08T01:00:09.000Z';

  appendThinkingToJob(job, '先看看目录', t1);
  assert.equal(job.thinkingStartedAt, t1, '第一个分片就是起点');
  assert.equal(job.thinkingEndedAt, t1, '只有一个分片时终点与起点相同');

  appendThinkingToJob(job, '，再读文件', t2);
  assert.equal(job.thinkingStartedAt, t1, '起点不随后续分片移动');
  assert.equal(job.thinkingEndedAt, t2, '每来一个分片，终点往前推');

  // 中间隔着工具调用再想一段 —— 窗口跟着推到最后一段（与 ThinkingBlock 的
  // 「第一个思考分片 → 最后一个分片」同口径，不把中间干活的时间算进去）
  appendThinkingToJob(job, '，最后收个尾', t3);
  assert.equal(job.thinkingStartedAt, t1);
  assert.equal(job.thinkingEndedAt, t3);
  assert.equal(job.thinking, '先看看目录，再读文件，最后收个尾');
});

test('每次追加都把 lastActivityAt 记到同一时刻（静默看门狗的记账口径）', () => {
  const job = makeJob();
  appendThinkingToJob(job, '想', '2026-10-08T02:00:00.000Z');
  assert.equal(job.lastActivityAt, '2026-10-08T02:00:00.000Z');
});

test('返回值 = 本次真正追加的增量（供批量推送 job:thinking-delta）', () => {
  const job = makeJob();
  assert.equal(appendThinkingToJob(job, '第一段', '2026-10-08T02:10:00.000Z'), '第一段');
  assert.equal(appendThinkingToJob(job, '第二段', '2026-10-08T02:10:01.000Z'), '第二段');
  assert.equal(job.thinking, '第一段第二段');
});

test('空分片：整条记录一个字都不动（连 lastActivityAt 都不碰）', () => {
  const job = makeJob({ lastActivityAt: '2026-10-08T03:00:00.000Z' });
  assert.equal(appendThinkingToJob(job, ''), '');
  assert.equal(appendThinkingToJob(job, undefined), '');
  assert.equal(job.thinking, '');
  assert.equal(job.thinkingStartedAt, null, '空分片不该开出计时窗口');
  assert.equal(job.thinkingEndedAt, null);
  assert.equal(job.lastActivityAt, '2026-10-08T03:00:00.000Z', 'lastActivityAt 保持原值');
});

test('老 job（字段都不存在）第一次追加也补得上计时', () => {
  const job = { id: 'old', thinking: '旧内容' };
  appendThinkingToJob(job, '新的', '2026-10-08T04:00:00.000Z');
  assert.equal(job.thinkingStartedAt, '2026-10-08T04:00:00.000Z');
  assert.equal(job.thinkingEndedAt, '2026-10-08T04:00:00.000Z');
  assert.equal(job.thinking, '旧内容新的');
});

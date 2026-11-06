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
// 「主 Agent 判断这条已完成任务是不是在等你回话」的单测。
//
// 这组守的不是 prompt 文采，而是几条**不能出错**的边界：
//   · 认不出 / 没给答案的条目不能变成一枚标（宁可少标）；
//   · 判定按 jobId 记账 —— 任务重跑一轮，上一轮的结论必须失效；
//   · 缓存读写只碰传入的临时文件（绝不能在单测里写用户真实的 ~/.zen-gitsync）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildTriagePrompt,
  parseTriageVerdicts,
  judgeReplies,
  readTriageStore,
  writeTriageStore,
  pickTriageForTask,
  selectTriageCandidates,
  applyTriageVerdicts,
  runTriageBatch,
  TRIAGE_MAX_ATTEMPTS,
} from './replyTriage.js';

const job = (id, taskId, status, startedAt, endedAt = null) => ({
  id, taskId, subId: `${taskId}__${id}`, title: '', status, startedAt, endedAt,
});

const done = (taskId, jobId, output, at = '2026-01-02T00:00:00Z') => ({
  ...job(jobId, taskId, 'done', at, at), output,
});

// ── prompt ──────────────────────────────────────────────────────────────

test('buildTriagePrompt: 每条任务的 id / 标题 / 收尾都在，且把"不可信数据"写清楚', () => {
  const zh = buildTriagePrompt([
    { taskId: 't1', title: '改样式', reply: '改好了。要不要我顺手把测试补上？' },
    { taskId: 't2', title: '', reply: '已提交并推送。' },
  ], 'zh-CN');
  assert.match(zh, /id=t1/);
  assert.match(zh, /改样式/);
  assert.match(zh, /要不要我顺手把测试补上/);
  assert.match(zh, /id=t2/);
  assert.match(zh, /（无标题）/);
  assert.match(zh, /不可信数据/);
  // 输出契约必须写死在 prompt 里（模型漏了 results 就会被当成解析失败）
  assert.match(zh, /"results"/);

  const en = buildTriagePrompt([{ taskId: 't1', title: 'x', reply: 'done' }], 'en-US');
  assert.match(en, /id=t1/);
  assert.match(en, /untrusted data/);
  assert.match(en, /"results"/);
});

// ── 解析 ────────────────────────────────────────────────────────────────

test('parseTriageVerdicts: 只认明确的布尔值；字符串 "true" 不算', () => {
  const { verdicts, parsed } = parseTriageVerdicts({
    results: [
      { id: 't1', waiting: true, reason: '在问要不要 push' },
      { id: 't2', waiting: 'true', reason: '字符串不算' },
      { id: 't3', waiting: false, reason: '' },
    ],
  }, ['t1', 't2', 't3']);
  assert.equal(parsed, true);
  assert.deepEqual(verdicts.map(v => v.id), ['t1', 't3']);
  assert.equal(verdicts[0].reason, '在问要不要 push');
});

test('parseTriageVerdicts: 不在本批次的 id / 重复 id / 脏结构一律丢掉', () => {
  const { verdicts } = parseTriageVerdicts({
    results: [
      { id: 't1', waiting: true, reason: 'a' },
      { id: 't1', waiting: false, reason: '重复，后到的不要' },
      { id: 'nope', waiting: true, reason: '模型编的 id' },
      null,
      { id: 5, waiting: true },
      { id: 't2', waiting: true, reason: 42 },
    ],
  }, ['t1', 't2']);
  assert.deepEqual(verdicts.map(v => [v.id, v.waiting]), [['t1', true], ['t2', true]]);
  // 非字符串的 reason 也要落成字符串，不能把 42 原样带进缓存
  assert.equal(verdicts[1].reason, '42');
});

test('parseTriageVerdicts: 不是 JSON / 没有 results 都算 parse 失败（调用方据此不落缓存）', () => {
  assert.equal(parseTriageVerdicts('not json', ['t1']).parsed, false);
  assert.equal(parseTriageVerdicts({ foo: 1 }, ['t1']).parsed, false);
  assert.equal(parseTriageVerdicts(null, ['t1']).parsed, false);
});

// ── 调模型 ──────────────────────────────────────────────────────────────

test('judgeReplies: 没配模型 → NO_MODEL 且不抛错', async () => {
  const out = await judgeReplies({ items: [{ taskId: 't1', reply: 'x' }], model: null });
  assert.equal(out.errorCode, 'NO_MODEL');
  assert.deepEqual(out.verdicts, []);
});

test('judgeReplies: 模型调用抛错 → LLM_FAILED（后台定时器不能被一次网络错打断）', async () => {
  const out = await judgeReplies({
    items: [{ taskId: 't1', reply: 'x' }],
    model: { model: 'm' },
    callJson: async () => { throw new Error('timeout') },
  });
  assert.equal(out.errorCode, 'LLM_FAILED');
  assert.match(out.errorDetail, /timeout/);
});

test('judgeReplies: 正常返回 → 逐条给出判定', async () => {
  const out = await judgeReplies({
    items: [
      { taskId: 't1', reply: '要不要我接着做？' },
      { taskId: 't2', reply: '已提交。' },
    ],
    model: { model: 'm' },
    callJson: async () => ({
      results: [
        { id: 't1', waiting: true, reason: '在征求意见' },
        { id: 't2', waiting: false, reason: '' },
      ],
    }),
  });
  assert.equal(out.errorCode, '');
  assert.deepEqual(out.verdicts.map(v => [v.id, v.waiting]), [['t1', true], ['t2', false]]);
});

// ── 选谁去判 ────────────────────────────────────────────────────────────

test('selectTriageCandidates: 只挑"已完成 + 有收尾 + 没判过这一轮"的任务', () => {
  const tasks = [
    { id: 'ok', title: '跑完的', desc: '', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'todo', title: '没跑过', desc: '', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'err', title: '报错了', desc: '', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'manual', title: '手动标的', desc: '', createdAt: '2026-01-01T00:00:00Z', manualDoneAt: '2026-01-03T00:00:00Z' },
    { id: 'silent', title: '没写正文', desc: '', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'fresh', title: '已经判过', desc: '', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'stale', title: '换了一轮', desc: '', createdAt: '2026-01-01T00:00:00Z' },
  ];
  const jobs = [
    done('ok', 'ok-1', '要 push 吗？'),
    job('todo-1', 'todo', 'error', '2026-01-02T00:00:00Z', '2026-01-02T00:10:00Z'),
    job('err-1', 'err', 'error', '2026-01-02T00:00:00Z', '2026-01-02T00:10:00Z'),
    done('manual', 'manual-1', '要不要继续？'),
    done('silent', 'silent-1', ''),
    done('fresh', 'fresh-1', '要不要继续？'),
    done('stale', 'stale-2', '要不要继续？', '2026-01-05T00:00:00Z'),
    job('stale-1', 'stale', 'done', '2026-01-02T00:00:00Z', '2026-01-02T00:10:00Z'),
  ];
  const jobsByTask = new Map();
  for (const j of jobs) {
    if (!jobsByTask.has(j.taskId)) jobsByTask.set(j.taskId, []);
    jobsByTask.get(j.taskId).push(j);
  }
  const store = {
    fresh: { jobId: 'fresh-1', waiting: true, reason: '问过了', at: '2026-01-03T00:00:00Z', attempts: 1 },
    stale: { jobId: 'stale-1', waiting: true, reason: '上一轮的结论', at: '2026-01-03T00:00:00Z', attempts: 1 },
  };
  const picked = selectTriageCandidates({ tasks, jobsByTask, store, limit: 10 }).map(t => t.taskId).sort();
  // stale 要重判（jobId 换了）；fresh 跳过；manual / todo / err / silent 都不挑
  assert.deepEqual(picked, ['ok', 'stale']);
});

test('selectTriageCandidates: 最新的先判，且受 limit 限制', () => {
  const tasks = ['a', 'b', 'c'].map(id => ({ id, title: id, desc: '', createdAt: '2026-01-01T00:00:00Z' }));
  const jobsByTask = new Map([
    ['a', [done('a', 'a-1', '收尾', '2026-01-02T00:00:00Z')]],
    ['b', [done('b', 'b-1', '收尾', '2026-01-04T00:00:00Z')]],
    ['c', [done('c', 'c-1', '收尾', '2026-01-03T00:00:00Z')]],
  ]);
  const picked = selectTriageCandidates({ tasks, jobsByTask, store: {}, limit: 2 }).map(t => t.taskId);
  assert.deepEqual(picked, ['b', 'c']);
});

test('selectTriageCandidates: 模型漏答过的条目重试到上限就不再问', () => {
  const tasks = [{ id: 'a', title: 'a', desc: '', createdAt: '2026-01-01T00:00:00Z' }];
  const jobsByTask = new Map([['a', [done('a', 'a-1', '收尾')]]]);
  const store = attempts => ({ a: { jobId: 'a-1', waiting: null, reason: '', at: '2026-01-03T00:00:00Z', attempts } });
  assert.equal(selectTriageCandidates({ tasks, jobsByTask, store: store(1), limit: 5 }).length, 1);
  assert.equal(selectTriageCandidates({ tasks, jobsByTask, store: store(TRIAGE_MAX_ATTEMPTS), limit: 5 }).length, 0);
});

test('pickTriageForTask: jobId 对不上（重跑过）就当没判过', () => {
  const store = { t1: { jobId: 'j-old', waiting: true, reason: '上一轮', at: '', attempts: 1 } };
  assert.equal(pickTriageForTask(store, 't1', [done('t1', 'j-new', '新的一轮')]), null);
  assert.deepEqual(
    pickTriageForTask(store, 't1', [done('t1', 'j-old', '同一轮')]),
    { waiting: true, reason: '上一轮' },
  );
  // 漏答（waiting: null）不给卡片挂标
  assert.equal(pickTriageForTask({ t1: { jobId: 'j', waiting: null, reason: '', at: '', attempts: 1 } }, 't1', [done('t1', 'j', 'x')]), null);
  assert.equal(pickTriageForTask({}, 't1', [done('t1', 'j', 'x')]), null);
});

// ── 落账 ────────────────────────────────────────────────────────────────

test('applyTriageVerdicts: 答了的记答案，没答的记 waiting=null 并累加 attempts', () => {
  const items = [
    { taskId: 'a', jobId: 'a-1', title: '', reply: '' },
    { taskId: 'b', jobId: 'b-1', title: '', reply: '' },
    { taskId: 'c', jobId: 'c-1', title: '', reply: '' },
  ];
  const store = { c: { jobId: 'c-1', waiting: null, reason: '', at: '', attempts: 2 } };
  const next = applyTriageVerdicts(store, items, [
    { id: 'a', waiting: true, reason: '在问' },
    { id: 'b', waiting: false, reason: '' },
  ], { at: '2026-01-05T00:00:00Z' });
  assert.equal(next.a.waiting, true);
  assert.equal(next.a.attempts, 1);
  assert.equal(next.b.waiting, false);
  assert.equal(next.c.waiting, null);
  assert.equal(next.c.attempts, 3, '漏答要累加，否则同一批会无限重问');
});

test('applyTriageVerdicts: 换了 job 就重新计 attempts（新的一轮不该继承上一轮的重试次数）', () => {
  const store = { a: { jobId: 'a-old', waiting: null, reason: '', at: '', attempts: 3 } };
  const next = applyTriageVerdicts(store, [{ taskId: 'a', jobId: 'a-new', title: '', reply: '' }], []);
  assert.equal(next.a.attempts, 1);
  assert.equal(next.a.jobId, 'a-new');
});

test('read/writeTriageStore: 只碰传入的临时文件，脏值退化成安全形态', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-triage-'));
  const file = path.join(dir, 'awaiting-replies.json');
  try {
    await writeTriageStore({
      t1: { jobId: 'j1', waiting: true, reason: '在问', at: '2026-01-05T00:00:00Z', attempts: 1 },
      t2: { jobId: 'j2', waiting: null, reason: '', at: '2026-01-05T00:00:00Z', attempts: 2 },
      gone: { jobId: 'j3', waiting: false, reason: '', at: '2026-01-05T00:00:00Z', attempts: 1 },
    }, { keepTaskIds: new Set(['t1', 't2']), file });
    const back = await readTriageStore(file);
    assert.deepEqual(Object.keys(back).sort(), ['t1', 't2'], '任务删了，判定也要跟着走');
    assert.equal(back.t1.waiting, true);
    assert.equal(back.t2.waiting, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readTriageStore: 文件不存在 / 脏内容都给空表（不能把看板弄挂）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-triage-'));
  try {
    assert.deepEqual(await readTriageStore(path.join(dir, 'nope.json')), {});
    const file = path.join(dir, 'bad.json');
    await fs.writeFile(file, '{not json', 'utf8');
    assert.deepEqual(await readTriageStore(file), {});
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── 整批入口 ────────────────────────────────────────────────────────────

test('runTriageBatch: 没模型时原样返回 store，attempts 不动（不是任务的错，不能计入重试）', async () => {
  const tasks = [{ id: 'a', title: 'a', desc: '', createdAt: '2026-01-01T00:00:00Z' }];
  const jobs = [done('a', 'a-1', '要不要我继续？')];
  const store = {};
  const out = await runTriageBatch({ tasks, jobs, store, model: null });
  assert.equal(out.errorCode, 'NO_MODEL');
  assert.deepEqual(out.store, {});
  assert.equal(out.judged, 0);
  // asked 要如实给出：调用侧靠它决定"这一批有没有活可干"（0 就收工）
  assert.equal(out.asked, 1);
});

test('runTriageBatch: 正常一轮 → store 里带上本轮的判定与 jobId', async () => {
  const tasks = [{ id: 'a', title: 'a', desc: '', createdAt: '2026-01-01T00:00:00Z' }];
  const jobs = [done('a', 'a-1', '要不要我继续？')];
  const out = await runTriageBatch({
    tasks,
    jobs,
    store: {},
    model: { model: 'm' },
    callJson: async () => ({ results: [{ id: 'a', waiting: true, reason: '在征求意见' }] }),
  });
  assert.equal(out.judged, 1);
  assert.equal(out.store.a.jobId, 'a-1');
  assert.equal(out.store.a.waiting, true);
  assert.equal(out.store.a.reason, '在征求意见');
});

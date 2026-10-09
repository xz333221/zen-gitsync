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
// 调度器单测：到点判定 / 防重 / 错过补偿 / 会话编排 / 停止。
// runTurn 注入替身（绝不真发 LLM 请求），时钟注入假值（绝不依赖真实时间）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'zen-sched-run-'));
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

const { createScheduler, MISSED_THRESHOLD_MS } = await import('./scheduler.js');
const { createTask, deleteTask, getTask, setTaskRun, claimFire } = await import('../../../../utils/scheduleStore.js');
const { acquireSession, releaseSession, isSessionBusy } = await import('./sessionGate.js');
const { prevFireBefore, fireKey } = await import('../../../../utils/scheduleCron.js');
const { agentSessionStore } = await import('./agentSessionStore.js');

const WORKDIR = mkdtempSync(path.join(os.tmpdir(), 'zen-sched-work-'));
const silent = { warn() {}, error() {}, info() {}, log() {} };
const FAKE_CFG = {
  readRawConfigFile: async () => ({
    models: [{ name: '测试模型', model: 'test-model', isDefault: true }],
    aiMaxRequestTokens: 100000,
  }),
};

async function waitUntil(check, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    // check 可以是 async（多数等待都要重新读任务库）
    if (await check()) return;
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/**
 * 等一个任务"跑完一轮"。
 *
 * 不能用"running 表为空"当判据 —— executeTask 是发射后不管的，tick 返回时
 * 它可能还没执行到 running.set，那一刻"为空"是假象。权威判据是 lastRun 落库。
 */
async function waitRun(taskId) {
  await waitUntil(async () => {
    const t = await getTask(taskId);
    return !!(t && t.lastRun);
  });
}

/** 假的一轮对话：把 user 消息压进会话 + 发 done（形状对齐 runAgentTurn 的产出） */
function makeFakeTurn(calls) {
  return async ({ session, userMessage, send, signal }) => {
    calls.push({ userMessage, sessionId: session.sessionId, prompt: userMessage });
    session.messages.push({ role: 'user', content: userMessage });
    if (signal?.aborted) throw new Error('aborted');
    send({ type: 'tool_call_start', name: 'run_command' });
    send({ type: 'done', content: `已执行：${userMessage}` });
    session.messages.push({ role: 'assistant', content: `已执行：${userMessage}` });
  };
}

function makeScheduler({ calls = [], clock, over = {} } = {}) {
  return createScheduler({
    configManager: FAKE_CFG,
    runTurn: makeFakeTurn(calls),
    now: () => clock.value,
    logger: silent,
    ...over,
  });
}

async function cleanup(task) {
  if (task) await deleteTask(task.id).catch(() => {});
}

test('到点触发:跑一轮、建专属会话、写 lastFire/lastRun、广播事件', async () => {
  const calls = [];
  const events = [];
  const clock = { value: new Date(2026, 0, 15, 9, 0, 30) };
  const scheduler = makeScheduler({ calls, clock });
  scheduler.onEvent(e => events.push(e));

  const task = await createTask({ name: '触发用例', schedule: '* * * * *', cwd: WORKDIR, prompt: '检查远端更新' });
  try {
    const r = await scheduler.tick();
    assert.ok(r.results.some(x => x.id === task.id && x.action === 'started'));
    await waitRun(task.id);

    const t = await getTask(task.id);
    assert.equal(t.lastRun.status, 'ok');
    assert.equal(t.lastRun.trigger, 'schedule');
    assert.equal(t.lastRun.toolCalls, 1);
    assert.ok(t.lastRun.durationMs >= 0);
    assert.ok(t.sessionId, '专属会话 id 应被回填');
    assert.ok(t.lastFire, 'lastFire 应被标记');

    const session = await agentSessionStore.read(t.sessionId);
    assert.equal(session.source, 'schedule');
    assert.equal(session.title, '触发用例');
    assert.ok(session.messages.some(m => m.role === 'user' && m.content === '检查远端更新'));
    assert.ok(session.messages.some(m => m.role === 'assistant'));
    assert.ok(Array.isArray(session.turnTimings) && session.turnTimings.length === 1);

    assert.ok(events.some(e => e.type === 'task_started' && e.taskId === task.id));
    assert.ok(events.some(e => e.type === 'task_finished' && e.taskId === task.id && e.status === 'ok'));
  } finally {
    await cleanup(task);
  }
});

test('同一触发点不重复跑;时钟前进后新触发点继续跑', async () => {
  const calls = [];
  const clock = { value: new Date(2026, 0, 15, 9, 0, 30) };
  const scheduler = makeScheduler({ calls, clock });

  const task = await createTask({ name: '去重用例', schedule: '* * * * *', cwd: WORKDIR, prompt: 'ping' });
  try {
    await scheduler.tick();
    await waitRun(task.id);
    assert.equal(calls.length, 1);

    // 同一个分钟内再巡检：已处置，不跑
    await scheduler.tick();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(calls.length, 1, '同一触发点不得重复执行');

    // 时钟前进到下一分钟：新的触发点。lastRun 会被新记录覆盖，
    // 所以这里等的是"calls 到 2"而不是 lastRun 变化
    clock.value = new Date(2026, 0, 15, 9, 1, 10);
    await scheduler.tick();
    await waitUntil(() => calls.length === 2);
    assert.equal(calls.length, 2);
  } finally {
    await cleanup(task);
  }
});

test('错过补偿:onMissed=skip 只标记不跑;onMissed=run 补跑一次', async () => {
  const calls = [];
  const events = [];
  // 每天 09:00 的任务；时钟 14:00 = 距触发点 5 小时（远超阈值）→ 算"错过"
  const clock = { value: new Date(2026, 0, 15, 14, 0, 0) };

  const skipTask = await createTask({ name: '跳过型', schedule: '0 9 * * *', cwd: WORKDIR, prompt: 'skip me', onMissed: 'skip' });
  const runTask = await createTask({ name: '补跑型', schedule: '0 9 * * *', cwd: WORKDIR, prompt: 'run me', onMissed: 'run' });
  const scheduler = makeScheduler({ calls, clock });
  scheduler.onEvent(e => events.push(e));
  try {
    await scheduler.tick();
    await waitRun(runTask.id);

    const skipped = await getTask(skipTask.id);
    assert.equal(skipped.lastRun.status, 'missed');
    assert.equal(skipped.lastRun.trigger, 'schedule');
    assert.ok(skipped.lastFire, '跳过也要标记触发点已处置');
    assert.ok(!calls.some(c => c.prompt === 'skip me'), 'skip 型不得执行');

    const ran = await getTask(runTask.id);
    assert.equal(ran.lastRun.status, 'ok');
    assert.ok(calls.some(c => c.prompt === 'run me'), 'run 型应补跑');
    assert.ok(events.some(e => e.type === 'task_finished' && e.status === 'missed' && e.taskId === skipTask.id));
  } finally {
    await cleanup(skipTask);
    await cleanup(runTask);
  }
});

test('正常 tick 延迟不算错过:距触发点 30 秒照样执行', async () => {
  const calls = [];
  // 触发点 09:00，时钟 09:00:30（30s < 10min 阈值）
  const clock = { value: new Date(2026, 0, 15, 9, 0, 30) };
  assert.ok(30_000 < MISSED_THRESHOLD_MS);
  const scheduler = makeScheduler({ calls, clock });
  const task = await createTask({ name: '正常延迟', schedule: '0 9 * * *', cwd: WORKDIR, prompt: 'tick 正常', onMissed: 'skip' });
  try {
    await scheduler.tick();
    await waitRun(task.id);
    const t = await getTask(task.id);
    assert.equal(t.lastRun.status, 'ok', '30 秒的 tick 抖动不该被判成错过');
  } finally {
    await cleanup(task);
  }
});

test('会话忙:onBusy=skip 记一笔跳过,不碰会话内容', async () => {
  const calls = [];
  const clock = { value: new Date(2026, 0, 15, 9, 0, 30) };
  const sessionId = 'ag-busy0001-abcdef';
  await agentSessionStore.write(sessionId, {
    version: 1, sessionId, title: '被占用', source: 'schedule', cwd: WORKDIR,
    messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });

  const scheduler = makeScheduler({ calls, clock });
  const task = await createTask({ name: '忙型', schedule: '* * * * *', cwd: WORKDIR, prompt: 'busy me' });
  try {
    await setTaskRun(task.id, null, sessionId);
    acquireSession(sessionId);
    try {
      const r = await scheduler.tick();
      assert.ok(r.results.some(x => x.id === task.id && x.action === 'started'));
      await waitRun(task.id);
      assert.equal(calls.length, 0, '会话忙时不得执行');
      const t = await getTask(task.id);
      assert.equal(t.lastRun.status, 'skipped-busy');
      assert.ok(t.lastRun.error.includes('跳过'));
    } finally {
      releaseSession(sessionId);
    }
  } finally {
    await cleanup(task);
  }
});

test('项目目录被删:执行前拦截并记 error,不启动对话', async () => {
  const calls = [];
  const clock = { value: new Date(2026, 0, 15, 9, 0, 30) };
  const sub = mkdtempSync(path.join(WORKDIR, 'will-be-gone-'));
  const scheduler = makeScheduler({ calls, clock });
  const task = await createTask({ name: '目录没了', schedule: '* * * * *', cwd: sub, prompt: 'x' });
  try {
    await fsp.rm(sub, { recursive: true, force: true });
    await scheduler.tick();
    await waitRun(task.id);
    const t = await getTask(task.id);
    assert.equal(t.lastRun.status, 'error');
    assert.ok(t.lastRun.error.includes('项目目录不存在'));
    assert.equal(calls.length, 0);
  } finally {
    await cleanup(task);
  }
});

test('多实例认领:触发点已被别处认领时不执行', async () => {
  const calls = [];
  const clock = { value: new Date(2026, 0, 15, 9, 0, 30) };
  const scheduler = makeScheduler({ calls, clock });
  const task = await createTask({ name: '认领用例', schedule: '* * * * *', cwd: WORKDIR, prompt: 'claimed' });
  try {
    const prev = prevFireBefore('* * * * *', clock.value);
    await claimFire(task.id, fireKey(prev));
    const r = await scheduler.tick();
    assert.ok(r.results.some(x => x.id === task.id && x.action === 'claimed-elsewhere'));
    await new Promise(res => setTimeout(res, 30));
    assert.equal(calls.length, 0);
  } finally {
    await cleanup(task);
  }
});

test('手动运行:trigger=manual、不写 lastFire、可被 stopTask 中止', async () => {
  const calls = [];
  const clock = { value: new Date(2026, 0, 15, 9, 0, 30) };
  const scheduler = makeScheduler({ calls, clock });
  const task = await createTask({ name: '手动用例', schedule: '0 3 * * *', cwd: WORKDIR, prompt: 'manual run' });
  try {
    const r = await scheduler.runTaskNow(task.id);
    assert.equal(r.started, true);
    await r.done;
    const t = await getTask(task.id);
    assert.equal(t.lastRun.trigger, 'manual');
    assert.equal(t.lastFire, '', '手动运行不该干扰调度节奏');

    // 停止：让 runTurn 挂在 abort 上
    const hanging = createScheduler({
      configManager: FAKE_CFG,
      runTurn: ({ signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      }),
      now: () => clock.value,
      logger: silent,
    });
    const r2 = await hanging.runTaskNow(task.id);
    await waitUntil(() => hanging.getRunningTasks().length === 1);
    assert.equal(hanging.stopTask(task.id), true);
    await r2.done;
    const t2 = await getTask(task.id);
    assert.equal(t2.lastRun.status, 'cancelled');
    assert.equal(hanging.stopTask(task.id), false, '没有在跑的任务再停应返回 false');
  } finally {
    await cleanup(task);
  }
});

test('禁用与坏表达式:不参与调度', async () => {
  const calls = [];
  const clock = { value: new Date(2026, 0, 15, 9, 0, 30) };
  const scheduler = makeScheduler({ calls, clock });
  const task = await createTask({ name: '停用中', schedule: '* * * * *', cwd: WORKDIR, prompt: 'disabled', enabled: false });
  try {
    await scheduler.tick();
    await new Promise(res => setTimeout(res, 30));
    assert.equal(calls.length, 0);
  } finally {
    await cleanup(task);
  }
});

test('执行期间会话闸被占用,结束后释放', async () => {
  const calls = [];
  const clock = { value: new Date(2026, 0, 15, 9, 0, 30) };
  let seenBusyDuringRun = null;
  const scheduler = createScheduler({
    configManager: FAKE_CFG,
    runTurn: async ({ session, send }) => {
      // 执行中：该会话必须在闸里（挡住手动对话并发）
      seenBusyDuringRun = isSessionBusy(session.sessionId);
      calls.push(1);
      send({ type: 'done', content: 'ok' });
    },
    now: () => clock.value,
    logger: silent,
  });
  const task = await createTask({ name: '闸用例', schedule: '* * * * *', cwd: WORKDIR, prompt: 'gate' });
  try {
    await scheduler.tick();
    await waitRun(task.id);
    assert.equal(seenBusyDuringRun, true, '执行期间会话应处于占用态');
    assert.equal(isSessionBusy((await getTask(task.id)).sessionId), false, '结束后应释放');
  } finally {
    await cleanup(task);
  }
});

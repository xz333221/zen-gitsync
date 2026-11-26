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
// 派发监听器单测：注册 / 终态唤醒 / 忙重试 / 消费语义。
// 全部依赖注入替身，绝不真发 LLM 请求、不碰真实会话目录。

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createDispatchWatch, buildWakeMessage, formatDurationMs, WAKE_TURN_MAX_MS } = await import('./dispatchWatch.js');

const silent = { warn() {}, error() {}, info() {}, log() {} };

/** 现成的依赖组：闸真的会占、会话存内存 Map，runTurn 收集调用 */
function makeDeps(overrides = {}) {
  const sessions = new Map();
  const gate = new Set();
  const turnCalls = [];
  const deps = {
    readSession: async (id) => sessions.get(id) || null,
    // 存快照而不是对象引用：检查点落盘的断言要区分"中途写下去的版本"和"最终版"，
    // 引用的话中途读到的永远是最新内容，等于没测。
    writeSession: async (id, session) => {
      sessions.set(id, { ...session, messages: session.messages.map(m => ({ ...m })) });
    },
    acquireTurn: (id) => (gate.has(id) ? null : { token: id }),
    releaseTurn: (id) => { gate.delete(id); },
    runTurn: async ({ session, userMessage }) => {
      turnCalls.push({ sessionId: session.sessionId, userMessage });
      session.messages.push({ role: 'user', content: userMessage });
      session.messages.push({ role: 'assistant', content: '收到，任务已完成。' });
    },
    resolveTurnModel: async () => ({ model: 'test-model', name: '测试模型' }),
    logger: silent,
    retryDelayMs: 0,
    maxRetries: 3,
    ...overrides,
  };
  return { deps, sessions, gate, turnCalls };
}

function makeSession(id) {
  return {
    version: 1,
    sessionId: id,
    title: '测试会话',
    cwd: 'D:/proj',
    model: '',
    messages: [{ role: 'user', content: '帮我派个活' }],
  };
}

const DONE_JOB = {
  id: 'job-1',
  taskId: 'task-1',
  status: 'done',
  startedAt: '2026-11-26T01:00:00.000Z',
  endedAt: '2026-11-26T01:03:30.000Z',
  output: '改完了三个文件\n全部测试通过',
};

test('终态到达：往来源会话注入通知并跑完整一轮，会话落盘', async () => {
  const { deps, sessions, turnCalls } = makeDeps();
  sessions.set('sess-1', makeSession('sess-1'));
  const watch = createDispatchWatch(deps);

  assert.equal(watch.register({ taskId: 'task-1', sessionId: 'sess-1', taskTitle: '拉代码' }), true);
  const result = await watch.handleJobUpdate(DONE_JOB);

  assert.equal(result.handled, true);
  assert.equal(result.woken, true);
  assert.equal(turnCalls.length, 1);
  assert.equal(turnCalls[0].sessionId, 'sess-1');
  assert.ok(turnCalls[0].userMessage.includes('「拉代码」'), '通知里要有任务标题');
  assert.ok(turnCalls[0].userMessage.includes('taskId=task-1'));
  assert.ok(turnCalls[0].userMessage.includes('执行成功'));
  assert.ok(turnCalls[0].userMessage.includes('全部测试通过'), '通知里要有输出结尾');
  // 落盘：原有 user + 通知 user + assistant 回复都进了会话
  const saved = sessions.get('sess-1');
  assert.equal(saved.messages.length, 3);
  assert.equal(saved.messages[1].content, turnCalls[0].userMessage);
  assert.equal(saved.messages[2].role, 'assistant');
});

test('不认识的 taskId：不处理', async () => {
  const { deps, turnCalls } = makeDeps();
  const watch = createDispatchWatch(deps);
  const result = await watch.handleJobUpdate({ ...DONE_JOB, taskId: 'task-其他' });
  assert.deepEqual(result, { handled: false });
  assert.equal(turnCalls.length, 0);
});

test('一条任务只唤醒一次：终态消费后再次终态不再跑（用户手动重跑不刷屏）', async () => {
  const { deps, sessions, turnCalls } = makeDeps();
  sessions.set('sess-1', makeSession('sess-1'));
  const watch = createDispatchWatch(deps);
  watch.register({ taskId: 'task-1', sessionId: 'sess-1' });
  await watch.handleJobUpdate(DONE_JOB);
  const again = await watch.handleJobUpdate(DONE_JOB);
  assert.deepEqual(again, { handled: false });
  assert.equal(turnCalls.length, 1);
});

test('会话被占：按间隔重试，闸松开后唤醒', async () => {
  const { deps, sessions, gate, turnCalls } = makeDeps();
  sessions.set('sess-1', makeSession('sess-1'));
  gate.add('sess-1');
  const watch = createDispatchWatch(deps);
  watch.register({ taskId: 'task-1', sessionId: 'sess-1' });
  const pending = watch.handleJobUpdate(DONE_JOB);
  // 第一轮重试间隙让出闸
  setTimeout(() => gate.delete('sess-1'), 5);
  const result = await pending;
  assert.equal(result.woken, true);
  assert.equal(turnCalls.length, 1);
});

test('会话持续被占：重试耗尽后放弃并记 busy', async () => {
  const { deps, gate, turnCalls } = makeDeps({ maxRetries: 2, retryDelayMs: 0 });
  gate.add('sess-1');
  const watch = createDispatchWatch(deps);
  watch.register({ taskId: 'task-1', sessionId: 'sess-1' });
  const result = await watch.handleJobUpdate(DONE_JOB);
  assert.equal(result.woken, false);
  assert.equal(result.reason, 'busy');
  assert.equal(turnCalls.length, 0);
});

test('来源会话已被删：不外抛，记 error', async () => {
  const { deps, turnCalls } = makeDeps();
  const watch = createDispatchWatch(deps);
  watch.register({ taskId: 'task-1', sessionId: 'sess-没了' });
  const result = await watch.handleJobUpdate(DONE_JOB);
  assert.equal(result.woken, false);
  assert.equal(result.reason, 'error');
  assert.equal(turnCalls.length, 0);
});

test('注册补查：终态抢在 register 前面的任务（spawn 秒败）也照样唤醒', async () => {
  const { deps, sessions, turnCalls } = makeDeps({
    findLatestTerminalJob: (taskId) => (taskId === 'task-1' ? DONE_JOB : null),
  });
  sessions.set('sess-1', makeSession('sess-1'));
  const watch = createDispatchWatch(deps);
  watch.register({ taskId: 'task-1', sessionId: 'sess-1' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(turnCalls.length, 1, '注册时发现已有终态 → 立即唤醒');
});

test('buildWakeMessage：cancelled 带取消提示、error 带错误信息、输出按尾部截取', () => {
  const cancelled = buildWakeMessage(
    { taskId: 't', taskTitle: '标题', projectPath: '' },
    { status: 'cancelled' },
  );
  assert.ok(cancelled.includes('已被用户取消'));
  assert.ok(cancelled.includes('不要自动重跑'));

  const failed = buildWakeMessage(
    { taskId: 't', taskTitle: '标题' },
    { status: 'error', error: 'x'.repeat(600) },
  );
  assert.ok(failed.includes('执行出错'));
  assert.ok(failed.includes('x'.repeat(500)), '错误信息保留前 500 字');
  assert.ok(!failed.includes('x'.repeat(501)), '错误信息被截断');

  const withOutput = buildWakeMessage(
    { taskId: 't', taskTitle: '标题' },
    { status: 'done', output: 'a'.repeat(2000) + '结尾标记' },
    { outputTailChars: 100 },
  );
  assert.ok(withOutput.includes('结尾标记'));
  assert.ok(!withOutput.includes('a'.repeat(150)), '只给尾部');
});

test('formatDurationMs：秒 / 分秒 / 整分', () => {
  assert.equal(formatDurationMs(45_000), '45秒');
  assert.equal(formatDurationMs(210_000), '3分30秒');
  assert.equal(formatDurationMs(180_000), '3分');
});

test('唤醒轮有硬上限（无人值守必须兜底）', () => {
  assert.equal(WAKE_TURN_MAX_MS, 15 * 60_000);
});

// ── 2026-11-26 用户消息抢占 + 检查点落盘 ─────────────────────
// 用户的原始反馈：任务完成后，通知消息再发消息就撞"该会话正在生成中"，
// 而且通知的回复是"突然出现"的。前者靠 abort 通道 + 对话路由抢占修复，
// 后者靠轮内检查点落盘修复 —— 这里把三件事都钉住。

test('唤醒轮占用闸时带 stage 标记与 abort 通道（抢占的依据）', async () => {
  const { WAKE_TURN_STAGE } = await import('./dispatchWatch.js');
  let acquiredOpts = null;
  const { deps } = makeDeps({
    acquireTurn: (id, opts) => { acquiredOpts = opts || null; return { token: 't' }; },
  });
  const watch = createDispatchWatch(deps);
  watch.register({ taskId: 'task-1', sessionId: 'sess-1' });
  await watch.handleJobUpdate(DONE_JOB);
  assert.ok(acquiredOpts, '唤醒轮应当带 options 占闸');
  assert.equal(acquiredOpts.stage, WAKE_TURN_STAGE);
  assert.equal(typeof acquiredOpts.abort, 'function', '必须挂 abort 通道，否则 /api/agent/abort 与抢占都掐不动它');
  assert.equal(typeof acquiredOpts.onAbandon, 'function', '必须挂 onAbandon（宽限兜底强制放闸的停写标志）');
});

test('唤醒轮 abort 通道真的能掐到 runTurn 的 signal', async () => {
  let acquiredOpts = null;
  let sawAborted = null;
  const { deps, sessions } = makeDeps({
    acquireTurn: (id, opts) => { acquiredOpts = opts || null; return { token: 't' }; },
    runTurn: async ({ signal }) => {
      acquiredOpts.abort();
      sawAborted = signal.aborted;
    },
  });
  sessions.set('sess-1', makeSession('sess-1'));
  const watch = createDispatchWatch(deps);
  watch.register({ taskId: 'task-1', sessionId: 'sess-1' });
  await watch.handleJobUpdate(DONE_JOB);
  assert.equal(sawAborted, true, '外部调 abort 后，runTurn 收到的 signal 必须是 aborted');
});

test('唤醒轮检查点落盘：跑的过程中通知消息就可见（不用等整轮结束）', async () => {
  const { deps, sessions } = makeDeps({
    checkpointMs: 5,
    runTurn: async ({ session, userMessage }) => {
      session.messages.push({ role: 'user', content: userMessage });
      // 轮还挂着：模拟模型在跑工具 / 写汇报
      await new Promise(resolve => setTimeout(resolve, 40));
      session.messages.push({ role: 'assistant', content: '汇报完毕' });
    },
  });
  sessions.set('sess-1', makeSession('sess-1'));
  const watch = createDispatchWatch(deps);
  watch.register({ taskId: 'task-1', sessionId: 'sess-1' });
  const pending = watch.handleJobUpdate(DONE_JOB);
  await new Promise(resolve => setTimeout(resolve, 25));
  const mid = sessions.get('sess-1');
  assert.equal(mid.messages.length, 2, '检查点窗口内通知消息就应已落盘（前端靠它渐进看到汇报）');
  await pending;
  const final = sessions.get('sess-1');
  assert.equal(final.messages.length, 3, '整轮结束后最终版照常落盘');
});

test('被抢占（闸被强制收走）后：检查点与最终落盘都停，不覆盖用户轮次的消息', async () => {
  let acquiredOpts = null;
  let writeCount = 0;
  const { deps, sessions } = makeDeps({
    checkpointMs: 5,
    acquireTurn: (id, opts) => { acquiredOpts = opts || null; return { token: 't' }; },
    writeSession: async () => { writeCount += 1; },
    runTurn: async ({ session, userMessage }) => {
      session.messages.push({ role: 'user', content: userMessage });
      // 模拟用户消息抢占：宽限兜底强制放闸（onAbandon）→ 唤醒轮的写必须全停
      acquiredOpts.onAbandon();
      await new Promise(resolve => setTimeout(resolve, 20));
      session.messages.push({ role: 'assistant', content: '迟到的汇报' });
    },
  });
  sessions.set('sess-1', makeSession('sess-1'));
  const watch = createDispatchWatch(deps);
  watch.register({ taskId: 'task-1', sessionId: 'sess-1' });
  const result = await watch.handleJobUpdate(DONE_JOB);
  assert.equal(result.woken, true);
  assert.equal(writeCount, 0, '被抢占后任何落盘都必须停（再写就是覆盖用户轮次的会话快照）');
});

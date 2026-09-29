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
// 「这个 job 现在在干嘛」的纯函数单测。
//
// 这些函数过去挂在 progressReport.js 上（只喂给主 Agent 写汇报），2026-09-29 起看板
// 「进行中」卡片直接把它们的结果显示给人看 —— 断言重心因此变成：**卡片上那句话是不是
// 真话**。挑错 job（拿一条早就结束的）/ 把空串渲染成"暂无" / 静默没到阈值就报"卡住了"，
// 在界面上都是"看起来很正常"的错，只有单测挡得住。
//
// 前四组（tailLine / describeLastTool / describeToolMix / silentMsOf）随实现一起从
// progressReport.test.js 搬过来，断言原样保留。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  tailLine,
  describeLastTool,
  describeToolMix,
  silentMsOf,
  buildLiveActivity,
  pickLiveActivity,
  TOOL_MIX_WINDOW,
  SILENT_NOTABLE_MS,
} from './jobActivity.js';

// ── tailLine ────────────────────────────────────────────────────────────

test('tailLine 取最后一行有效文本，跳过末尾空行', () => {
  assert.equal(tailLine('第一行\n第二行\n\n   \n'), '第二行');
});

test('tailLine 把行内空白折成一个空格（多行输出里的缩进不该原样进 prompt / 卡片）', () => {
  assert.equal(tailLine('a\n   正在   编辑\t文件   '), '正在 编辑 文件');
});

test('tailLine 截断超长行，且空 / 非字符串一律返回空串', () => {
  assert.equal(tailLine('x'.repeat(500)).length, 160);
  assert.equal(tailLine(''), '');
  assert.equal(tailLine(null), '');
  assert.equal(tailLine(undefined), '');
});

// ── describeLastTool ────────────────────────────────────────────────────

test('describeLastTool 取最后一次带名字的调用，优先用 argsPreview', () => {
  const calls = [
    { name: 'Read', argsPreview: 'a.ts', arguments: '{"file_path":"a.ts"}' },
    { name: 'Edit', argsPreview: 'b.ts', arguments: '{"file_path":"b.ts"}' },
  ];
  assert.equal(describeLastTool(calls), 'Edit b.ts');
});

test('describeLastTool 跳过没有名字的尾部记录（老数据 / 半截记录）', () => {
  const calls = [{ name: 'Bash', argsPreview: 'npm test' }, { id: 'anon-1' }];
  assert.equal(describeLastTool(calls), 'Bash npm test');
});

test('describeLastTool 没有 argsPreview 时退回 arguments；两者都没有就只给工具名', () => {
  assert.equal(describeLastTool([{ name: 'Bash', arguments: 'ls -la' }]), 'Bash ls -la');
  assert.equal(describeLastTool([{ name: 'Bash' }]), 'Bash');
  assert.equal(describeLastTool([]), '');
  assert.equal(describeLastTool(null), '');
});

// ── describeToolMix / silentMsOf ────────────────────────────────────────

test('describeToolMix 给出最近几次调用的分布，多的在前', () => {
  const calls = [
    { name: 'Bash' }, { name: 'Read' }, { name: 'Bash' },
    { name: 'Read' }, { name: 'Bash' }, { name: 'Edit' },
  ];
  assert.equal(describeToolMix(calls), 'Bash×3 · Read×2 · Edit');
});

test('describeToolMix 只看最近 TOOL_MIX_WINDOW 次 —— 早先的模式早被淹没了', () => {
  // 先 30 次 Edit，再 20 次 Read：窗口内只有 Read，分布里不该冒出 Edit
  const calls = [
    ...Array.from({ length: 30 }, () => ({ name: 'Edit' })),
    ...Array.from({ length: TOOL_MIX_WINDOW }, () => ({ name: 'Read' })),
  ];
  assert.equal(describeToolMix(calls), `Read×${TOOL_MIX_WINDOW}`);
});

test('describeToolMix 跳过没有名字的记录，但它们不占窗口名额', () => {
  const calls = [
    { name: 'Bash' },
    ...Array.from({ length: TOOL_MIX_WINDOW }, () => ({ id: 'anon-1' })),
  ];
  assert.equal(describeToolMix(calls), 'Bash');
});

test('describeToolMix 没有调用时给空串（调用方据此不显示这一行）', () => {
  assert.equal(describeToolMix([]), '');
  assert.equal(describeToolMix(null), '');
  assert.equal(describeToolMix(undefined), '');
});

test('silentMsOf 到阈值才算静默，不到 / 没这个字段一律 null', () => {
  const at = '2026-09-28T10:00:00.000Z';
  const base = Date.parse(at);
  const job = { lastActivityAt: at };
  assert.equal(silentMsOf(job, base + SILENT_NOTABLE_MS), SILENT_NOTABLE_MS);
  assert.equal(silentMsOf(job, base + SILENT_NOTABLE_MS - 1), null);
  // 老记录 / 别的实例上的旧版进程没有这个字段：给 null，而不是编一个 0
  assert.equal(silentMsOf({}, base), null);
  assert.equal(silentMsOf({ lastActivityAt: '不是时间' }, base), null);
  assert.equal(silentMsOf(null, base), null);
});

// ── buildLiveActivity ───────────────────────────────────────────────────

const START = '2026-09-28T10:00:00.000Z';
const NOW = Date.parse('2026-09-28T10:03:20.000Z'); // 距 START 3 分 20 秒

/** 一条"跑了 3 分 20 秒"的 job 模板 */
function liveJob(over = {}) {
  return {
    id: 'j1',
    taskId: 't1',
    status: 'running',
    agent: 'claude',
    startedAt: START,
    thinking: '先看现状\n这个文件的锁逻辑有问题，得先弄清楚谁在什么时候写',
    output: '我先读一下 login.ts',
    toolCalls: [{ name: 'Read', argsPreview: 'src/login.ts' }],
    ...over,
  };
}

test('buildLiveActivity：终态 / 空 job 返回 null（卡片据此不显示活动区）', () => {
  assert.equal(buildLiveActivity(liveJob({ status: 'done' }), NOW), null);
  assert.equal(buildLiveActivity(liveJob({ status: 'error' }), NOW), null);
  assert.equal(buildLiveActivity(null, NOW), null);
  // pending 也算在跑（进程刚起来还没吐字）：卡片上仍要给"已运行 0 秒"，不能空着
  assert.equal(buildLiveActivity(liveJob({ status: 'pending' }), NOW).status, 'pending');
});

test('buildLiveActivity：把思考 / 工具 / 最新回复都抽成一句话，时长按传入的 now 算', () => {
  const live = buildLiveActivity(liveJob(), NOW);
  assert.equal(live.elapsedMs, 3 * 60 * 1000 + 20 * 1000);
  assert.equal(live.agent, 'claude');
  assert.equal(live.startedAt, START);
  assert.equal(live.toolCallCount, 1);
  assert.equal(live.lastTool, 'Read src/login.ts');
  assert.equal(live.toolMix, 'Read');
  assert.equal(live.lastThought, '这个文件的锁逻辑有问题，得先弄清楚谁在什么时候写');
  assert.equal(live.lastLine, '我先读一下 login.ts');
  // 没有 lastActivityAt → 静默这条不成立，给 null 而不是编个 0
  assert.equal(live.silentMs, null);
});

test('buildLiveActivity：老记录没有 agent / toolCalls 时给出空值，不抛错', () => {
  const live = buildLiveActivity({ id: 'j2', status: 'running', startedAt: START }, NOW);
  assert.equal(live.agent, '');
  assert.equal(live.toolCallCount, 0);
  assert.equal(live.lastTool, '');
  assert.equal(live.lastThought, '');
  assert.equal(live.lastLine, '');
});

test('buildLiveActivity：startedAt 缺失或脏值时 elapsedMs 记 0（不显示负数 / NaN）', () => {
  assert.equal(buildLiveActivity({ id: 'j', status: 'running' }, NOW).elapsedMs, 0);
  assert.equal(buildLiveActivity({ id: 'j', status: 'running', startedAt: '不是时间' }, NOW).elapsedMs, 0);
});

// ── pickLiveActivity ────────────────────────────────────────────────────

test('pickLiveActivity：一个任务有多条 job 时挑最近有动静的那条，不是跑得最久的', () => {
  const live = pickLiveActivity([
    { id: 'old', status: 'running', startedAt: '2026-09-28T09:00:00.000Z', output: '老的那条' },
    {
      id: 'fresh',
      status: 'running',
      startedAt: '2026-09-28T10:00:00.000Z',
      lastActivityAt: '2026-09-28T10:03:00.000Z',
      output: '刚吐过字的那条',
    },
  ], NOW);
  assert.equal(live.jobId, 'fresh');
  assert.equal(live.lastLine, '刚吐过字的那条');
});

test('pickLiveActivity：只看在跑的 —— 有终态 job 时不拿它顶替', () => {
  const done = { id: 'done', status: 'done', startedAt: '2026-09-28T10:02:00.000Z', output: '已经结束了' };
  assert.equal(pickLiveActivity([done], NOW), null);
  const running = { id: 'run', status: 'running', startedAt: START, output: '还在跑' };
  assert.equal(pickLiveActivity([done, running], NOW).jobId, 'run');
});

test('pickLiveActivity：时间戳打平时取末条（与 latestJob 同口径），空数组给 null', () => {
  const same = [
    { id: 'a', status: 'running', startedAt: START, output: 'a' },
    { id: 'b', status: 'running', startedAt: START, output: 'b' },
  ];
  assert.equal(pickLiveActivity(same, NOW).jobId, 'b');
  assert.equal(pickLiveActivity([], NOW), null);
  assert.equal(pickLiveActivity(null, NOW), null);
});

test('pickLiveActivity：lastActivityAt 是脏值时退回 startedAt 比较', () => {
  const live = pickLiveActivity([
    { id: 'a', status: 'running', startedAt: '2026-09-28T09:00:00.000Z', lastActivityAt: '不是时间' },
    { id: 'b', status: 'running', startedAt: '2026-09-28T08:00:00.000Z' },
  ], NOW);
  assert.equal(live.jobId, 'a');
});

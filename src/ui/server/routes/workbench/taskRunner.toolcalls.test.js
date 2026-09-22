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

// 工具调用（tool_use）采集的回归测试（2026-09-22）。
//
// 背景：两个事件处理器原本把 tool_use 整段丢掉，执行流里只剩「思考 + 正文」，
// 模型闷头跑的几分钟完全看不出它在干什么。现在归一成 job.toolCalls。
//
// 钉住的口径：
//   1. claude：assistant 的 tool_use 块建条目，user 事件里的 tool_result 回填结果
//   2. claude：user 事件里"用户自己那条 prompt"（content 是字符串）不能误判成工具结果
//   3. claude：is_error 的 tool_result → status error + error 文案
//   4. opencode：同一个 part 的 running → completed 只更新一条，不重复建
//   5. 参数 / 结果都截断（jobs.json 不能被一次长跑撑爆）
//   6. 超上限后丢弃新调用但保留已有条目
//   7. flush 只在有增量时发事件；seal 把没收尾的调用收口成终态
//
// 隔离策略同 taskRunner.opencode.test.js：import taskRunner.js 之前把
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
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'zen-toolcalls-test-'));
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

const {
  createClaudeEventHandler,
  createOpencodeEventHandler,
  createToolCallTracker,
  MAX_TOOL_CALLS,
} = await import(
  pathToFileURL(path.join(projectRoot, 'src/ui/server/routes/workbench/taskRunner.js')).href
);

function makeSink() {
  const sink = { output: [], thinking: [] };
  sink.appendOutput = (t) => { if (t) sink.output.push(t); };
  sink.appendThinking = (t) => { if (t) sink.thinking.push(t); };
  return sink;
}

/** 建一个带推送记录的 tracker（onUpdates 收集每一批） */
function makeTracker(job) {
  const batches = [];
  const tracker = createToolCallTracker(job, (updates) => batches.push(updates));
  return { tracker, batches };
}

test('claude：tool_use 建条目，user 事件里的 tool_result 回填结果', () => {
  const job = {};
  const sink = makeSink();
  const handle = createClaudeEventHandler(job, sink.appendOutput, sink.appendThinking);

  handle({
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: '先看看文件' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test', description: '跑测试' } },
      ],
    },
  });
  assert.equal(job.toolCalls.length, 1);
  assert.equal(job.toolCalls[0].id, 'toolu_1');
  assert.equal(job.toolCalls[0].name, 'Bash');
  assert.equal(job.toolCalls[0].status, 'running');
  // 摘要优先取 command（不是退化成整段 JSON）
  assert.equal(job.toolCalls[0].argsPreview, 'npm test');
  assert.equal(job.toolCalls[0].arguments, '{"command":"npm test","description":"跑测试"}');
  // 思考照旧落 thinking，不受影响
  assert.deepEqual(sink.thinking, ['先看看文件']);

  handle({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'all tests pass' }] },
  });
  assert.equal(job.toolCalls.length, 1);
  assert.equal(job.toolCalls[0].status, 'done');
  assert.equal(job.toolCalls[0].result, 'all tests pass');
  // 工具结果不能被当成"模型说的话"塞进正文
  assert.deepEqual(sink.output, []);
});

test('claude：user 事件里的普通 prompt（content 是字符串）不产生工具调用', () => {
  const job = {};
  const sink = makeSink();
  const handle = createClaudeEventHandler(job, sink.appendOutput, sink.appendThinking);

  handle({ type: 'user', message: { role: 'user', content: '帮我改个 bug' } });
  handle({ type: 'user', message: { content: [{ type: 'text', text: '普通文本块' }] } });

  assert.deepEqual(job.toolCalls, []);
  assert.deepEqual(sink.output, []);
});

test('claude：tool_result 的 content 是块数组 / is_error 时分别抽取与标错', () => {
  const job = {};
  const sink = makeSink();
  const handle = createClaudeEventHandler(job, sink.appendOutput, sink.appendThinking);

  handle({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'ok_1', name: 'Read', input: { file_path: 'src/a.js' } },
        { type: 'tool_use', id: 'bad_1', name: 'Edit', input: { file_path: 'src/b.js' } },
      ],
    },
  });
  handle({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'ok_1', content: [{ type: 'text', text: '第一行' }, { type: 'text', text: '第二行' }] },
        { type: 'tool_result', tool_use_id: 'bad_1', is_error: true, content: 'File has not been read yet' },
      ],
    },
  });

  assert.equal(job.toolCalls.length, 2);
  assert.equal(job.toolCalls[0].status, 'done');
  assert.equal(job.toolCalls[0].result, '第一行\n第二行');
  assert.equal(job.toolCalls[0].argsPreview, 'src/a.js');
  assert.equal(job.toolCalls[1].status, 'error');
  assert.equal(job.toolCalls[1].error, 'File has not been read yet');
  assert.equal(job.toolCalls[1].result, 'File has not been read yet');
});

test('opencode：同一个 part 的 running → completed 只更新一条', () => {
  const job = {};
  const sink = makeSink();
  const handle = createOpencodeEventHandler(job, sink.appendOutput, sink.appendThinking);

  const part = (state) => ({
    type: 'tool_use',
    sessionID: 'ses_1',
    part: { id: 'prt_1', callID: 'call_1', type: 'tool', tool: 'bash', state },
  });

  handle(part({ status: 'running', input: { command: 'ls -la' } }));
  assert.equal(job.toolCalls.length, 1);
  assert.equal(job.toolCalls[0].id, 'call_1');
  assert.equal(job.toolCalls[0].name, 'bash');
  assert.equal(job.toolCalls[0].status, 'running');
  assert.equal(job.toolCalls[0].argsPreview, 'ls -la');

  handle(part({ status: 'completed', input: { command: 'ls -la' }, output: 'a.js\nb.js' }));
  assert.equal(job.toolCalls.length, 1, '同一 part 不能重复建条目');
  assert.equal(job.toolCalls[0].status, 'done');
  assert.equal(job.toolCalls[0].result, 'a.js\nb.js');

  // completed → error（opencode 的错误形态：state.error 是对象）
  handle(part({ status: 'error', error: { message: '命令不存在' } }));
  assert.equal(job.toolCalls.length, 1);
  assert.equal(job.toolCalls[0].status, 'error');
  assert.equal(job.toolCalls[0].error, '命令不存在');
});

test('opencode：part.type 不是 tool 时忽略（不制造空条目）', () => {
  const job = {};
  const sink = makeSink();
  const handle = createOpencodeEventHandler(job, sink.appendOutput, sink.appendThinking);

  handle({ type: 'tool_use', sessionID: 'ses_2', part: { id: 'p1', type: 'text', text: 'hi' } });
  assert.deepEqual(job.toolCalls, []);
});

test('参数与结果都按上限截断', () => {
  const job = {};
  const sink = makeSink();
  const handle = createClaudeEventHandler(job, sink.appendOutput, sink.appendThinking);

  handle({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'big', name: 'Bash', input: { command: 'x'.repeat(9000) } }] },
  });
  assert.ok(job.toolCalls[0].arguments.length < 2100, '参数应被截断');
  assert.ok(job.toolCalls[0].arguments.includes('已截断'));
  assert.ok(job.toolCalls[0].argsPreview.length <= 200, '摘要不超过 200 字');

  handle({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'big', content: 'y'.repeat(9000) }] },
  });
  assert.ok(job.toolCalls[0].result.length < 4100, '结果应被截断');
  assert.ok(job.toolCalls[0].result.includes('已截断'));
});

test('超过 MAX_TOOL_CALLS 后丢弃新调用，已有条目仍可更新', () => {
  const job = {};
  const sink = makeSink();
  const handle = createClaudeEventHandler(job, sink.appendOutput, sink.appendThinking);

  for (let i = 0; i < MAX_TOOL_CALLS + 5; i++) {
    handle({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `cmd-${i}` } }] },
    });
  }
  assert.equal(job.toolCalls.length, MAX_TOOL_CALLS);

  // 已被记下的那条还能收到结果（超限之后不能变成"半截"）
  handle({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't0', content: 'ok' }] },
  });
  assert.equal(job.toolCalls[0].status, 'done');
  assert.equal(job.toolCalls[0].result, 'ok');
});

test('tracker：flush 只在有增量时推送，且推的是快照', () => {
  const job = {};
  const { tracker, batches } = makeTracker(job);

  tracker.flush();
  assert.deepEqual(batches, [], '没有增量时不该发空事件');

  tracker.record({ id: 'a', name: 'Read', input: { file_path: 'a.js' }, status: 'running' });
  assert.equal(batches.length, 0, 'record 只入队，不立即推送');

  tracker.flush();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1);
  assert.deepEqual(batches[0][0], {
    id: 'a',
    name: 'Read',
    argsPreview: 'a.js',
    arguments: '{"file_path":"a.js"}',
    result: '',
    status: 'running',
    error: undefined,
  });

  // 推出去的是快照：后续状态变更不会改掉已经 emit 的那一份
  tracker.record({ id: 'a', name: 'Read', status: 'done', output: '文件内容' });
  tracker.flush();
  assert.equal(batches[0][0].status, 'running');
  assert.equal(batches[1][0].status, 'done');
  assert.equal(batches[1][0].result, '文件内容');
});

test('tracker：seal 把没收尾的调用收口成终态', () => {
  const done = {};
  const t1 = makeTracker(done);
  t1.tracker.record({ id: 'a', name: 'Read', status: 'running' });
  t1.tracker.flush();
  t1.tracker.seal('done');
  assert.equal(done.toolCalls[0].status, 'done');
  assert.equal(t1.batches.length, 2, 'seal 要把终态也推给前端');

  const cancelled = {};
  const t2 = makeTracker(cancelled);
  t2.tracker.record({ id: 'a', name: 'Read', status: 'running' });
  t2.tracker.seal('cancelled');
  assert.equal(cancelled.toolCalls[0].status, 'error');
  assert.equal(cancelled.toolCalls[0].error, '未返回结果（执行已停止）');

  const errored = {};
  const t3 = makeTracker(errored);
  t3.tracker.record({ id: 'a', name: 'Read', status: 'running' });
  t3.tracker.seal('error');
  assert.equal(errored.toolCalls[0].status, 'error');
  assert.equal(errored.toolCalls[0].error, '未返回结果（执行出错）');

  // 已经收尾的条目不被 seal 改写
  const mixed = {};
  const t4 = makeTracker(mixed);
  t4.tracker.record({ id: 'a', name: 'Read', status: 'done', output: 'ok' });
  t4.tracker.flush();
  const before = t4.batches.length;
  t4.tracker.seal('cancelled');
  assert.equal(mixed.toolCalls[0].status, 'done');
  assert.equal(t4.batches.length, before, '没有需要收口的条目时 seal 不该推空事件');
});

test('tracker：没有 id 的事件按序号兜底，不会互相覆盖', () => {
  const job = {};
  const { tracker } = makeTracker(job);
  tracker.record({ name: 'Unknown' });
  tracker.record({ name: 'Unknown' });
  assert.equal(job.toolCalls.length, 2);
  assert.notEqual(job.toolCalls[0].id, job.toolCalls[1].id);
});

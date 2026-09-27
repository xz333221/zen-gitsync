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

// codex 执行器事件处理器的回归测试（2026-09-27）。
//
// 钉住 codex `exec --json` 适配层的五条口径（事件样例取自 codex-cli 0.157.x 实测输出）：
//   1. thread.started 的 thread_id 落 job.claudeSessionId（续接 exec resume 的取值来源）
//   2. agent_message / reasoning 分别落 output / thinking，且按 item.id 去重累积推送
//   3. command_execution / file_change / mcp_tool_call / web_search 归一成工具调用，
//      item.started(status=in_progress) → item.completed 更新同一条
//   4. error 类事件（顶层 error / item.type=error）是非致命信息，只贴 output，
//      绝不写 job.agentError —— 否则配置告警会被误判成任务失败
//   5. turn.failed 才是终态失败：error.message 写进 job.agentError
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
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'zen-taskrunner-codex-test-'));
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

const { createCodexEventHandler } = await import(
  pathToFileURL(path.join(projectRoot, 'src/ui/server/routes/workbench/taskRunner.js')).href
);

/** 可断言的 appendOutput/appendThinking 收集器 */
function makeSink() {
  const sink = { output: [], thinking: [] };
  sink.appendOutput = (t) => { if (t) sink.output.push(t); };
  sink.appendThinking = (t) => { if (t) sink.thinking.push(t); };
  return sink;
}

test('codex 事件：thread_id 落 claudeSessionId，正文/思考分别归位', () => {
  const job = {};
  const sink = makeSink();
  const handle = createCodexEventHandler(job, sink.appendOutput, sink.appendThinking);

  handle({ type: 'thread.started', thread_id: '01a0e088-32fc-7511-aa6e-4e836bf138f7' });
  handle({ type: 'turn.started' });
  handle({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '先看一眼目录' } });
  handle({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '改好了' } });
  handle({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });

  assert.equal(job.claudeSessionId, '01a0e088-32fc-7511-aa6e-4e836bf138f7');
  assert.deepEqual(sink.output, ['改好了']);
  assert.deepEqual(sink.thinking, ['先看一眼目录']);
  assert.equal(job.agentError, undefined);
});

test('codex 事件：同一 item.id 累积推送只追加增量', () => {
  const job = {};
  const sink = makeSink();
  const handle = createCodexEventHandler(job, sink.appendOutput, sink.appendThinking);

  // 累积语义：第二次的 text 是第一次的前缀延长
  handle({ type: 'item.updated', item: { id: 'item_0', type: 'agent_message', text: 'Hello' } });
  handle({ type: 'item.updated', item: { id: 'item_0', type: 'agent_message', text: 'Hello, world' } });
  // 重复事件（完全相同）：不产生任何输出
  handle({ type: 'item.updated', item: { id: 'item_0', type: 'agent_message', text: 'Hello, world' } });
  // 不同 item.id：各自独立，整段落下
  handle({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Hello' } });

  assert.deepEqual(sink.output, ['Hello', ', world', 'Hello']);
});

test('codex 事件：command_execution 的 started → completed 更新同一条工具调用', () => {
  const job = {};
  const sink = makeSink();
  const handle = createCodexEventHandler(job, sink.appendOutput, sink.appendThinking);

  handle({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'npm test', aggregated_output: '', exit_code: null, status: 'in_progress' } });
  assert.equal(job.toolCalls.length, 1);
  assert.equal(job.toolCalls[0].status, 'running');
  assert.equal(job.toolCalls[0].argsPreview, 'npm test');

  handle({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'npm test', aggregated_output: 'ok 12 tests', exit_code: 0, status: 'completed' } });
  assert.equal(job.toolCalls.length, 1, '同一 id 不新增记录');
  assert.equal(job.toolCalls[0].status, 'done');
  assert.equal(job.toolCalls[0].result, 'ok 12 tests');
  assert.ok(!job.toolCalls[0].error);
});

test('codex 事件：命令失败/文件改动的工具调用落 error、文件清单作结果', () => {
  const job = {};
  const sink = makeSink();
  const handle = createCodexEventHandler(job, sink.appendOutput, sink.appendThinking);

  handle({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'npm run build', aggregated_output: 'boom', exit_code: 1, status: 'failed' } });
  assert.equal(job.toolCalls[0].status, 'error');
  assert.match(job.toolCalls[0].error, /exit_code=1/);

  handle({ type: 'item.completed', item: { id: 'item_1', type: 'file_change', changes: [{ path: 'src/a.js', kind: 'update' }, { path: 'src/b.js', kind: 'add' }], status: 'completed' } });
  assert.equal(job.toolCalls[1].status, 'done');
  assert.equal(job.toolCalls[1].result, 'update src/a.js\nadd src/b.js');
});

test('codex 事件：mcp_tool_call / web_search 归一成工具调用', () => {
  const job = {};
  const sink = makeSink();
  const handle = createCodexEventHandler(job, sink.appendOutput, sink.appendThinking);

  handle({ type: 'item.completed', item: { id: 'item_0', type: 'mcp_tool_call', server: 'node_repl', tool: 'run', arguments: { code: '1+1' }, result: { content: [{ type: 'text', text: '2' }] }, status: 'completed' } });
  assert.equal(job.toolCalls[0].name, 'node_repl.run');
  assert.equal(job.toolCalls[0].status, 'done');
  assert.equal(job.toolCalls[0].result, '2');

  handle({ type: 'item.completed', item: { id: 'item_1', type: 'web_search', query: 'codex exec json', action: 'search', status: 'completed' } });
  assert.equal(job.toolCalls[1].name, 'web_search');
  assert.equal(job.toolCalls[1].argsPreview, 'codex exec json');
});

test('codex 事件：告警只贴 output，不置 agentError；turn.failed 才判失败', () => {
  const job = {};
  const sink = makeSink();
  const handle = createCodexEventHandler(job, sink.appendOutput, sink.appendThinking);

  // 配置告警（item.type=error）与重试提示（顶层 error）都是非终止信息
  handle({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Codex is ignoring 2 unrecognized configuration settings.' } });
  handle({ type: 'error', message: 'Reconnecting... 1/5 (unexpected status 401 Unauthorized)' });
  assert.equal(job.agentError, undefined, '告警不能把任务判成失败');
  assert.equal(sink.output.length, 2);

  // 终态失败
  handle({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized' } });
  assert.equal(job.agentError, 'unexpected status 401 Unauthorized');
  // 只记第一条
  handle({ type: 'turn.failed', error: { message: 'second one' } });
  assert.equal(job.agentError, 'unexpected status 401 Unauthorized');
});

test('codex 事件：未知 item 类型 / 缺字段事件不抛错也不产生输出', () => {
  const job = {};
  const sink = makeSink();
  const handle = createCodexEventHandler(job, sink.appendOutput, sink.appendThinking);

  handle({ type: 'item.completed', item: { id: 'item_0', type: 'todo_list', items: [{ text: 'step', completed: false }] } });
  handle({ type: 'item.completed', item: { id: 'item_1', type: 'collab_tool_call', tool: 'wait', status: 'completed' } });
  handle({ type: 'item.completed', item: { id: 'item_2', type: 'some_future_item_type' } });
  handle({ type: 'item.completed' });
  handle({ type: 'turn.started' });
  handle(null);

  assert.deepEqual(sink.output, []);
  assert.deepEqual(sink.thinking, []);
  assert.equal(job.claudeSessionId, undefined);
  assert.equal(job.agentError, undefined);
});
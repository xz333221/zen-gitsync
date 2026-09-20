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

// opencode 执行器事件处理器的回归测试（2026-09-20）。
//
// 钉住 opencode `run --format json` 适配层的四条口径：
//   1. text / reasoning 事件的 part.text 分别落到 output / thinking
//   2. 顶层 sessionID 覆盖 job.claudeSessionId（续接 --session 的取值来源）
//   3. 同一 part.id 重复出现时按"前缀延长"只追加增量，不把同一段文字拼两遍
//   4. error 事件写入 job.agentError（进程退出码可能是 0，终态判定靠它）
//
// 隔离策略同 jobStore.test.js：import taskRunner.js 之前把 USERPROFILE/HOME
// 指向 mkdtemp 沙箱（taskRunner → jobStore import 时就会 hydrate）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../../../..');

// ---- 环境隔离:必须在 import taskRunner.js 之前完成 ----
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'zen-taskrunner-test-'));
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

const { createOpencodeEventHandler, normalizeTaskExecutor, TASK_EXECUTORS } = await import(
  pathToFileURL(path.join(projectRoot, 'src/ui/server/routes/workbench/taskRunner.js')).href
);

/** 可断言的 appendOutput/appendThinking 收集器 */
function makeSink() {
  const sink = { output: [], thinking: [] };
  sink.appendOutput = (t) => { if (t) sink.output.push(t); };
  sink.appendThinking = (t) => { if (t) sink.thinking.push(t); };
  return sink;
}

test('normalizeTaskExecutor：白名单 + 大小写 + 非法回落', () => {
  assert.deepEqual(TASK_EXECUTORS, ['claude', 'opencode']);
  assert.equal(normalizeTaskExecutor('opencode'), 'opencode');
  // 大小写不敏感（存储前统一小写）
  assert.equal(normalizeTaskExecutor('OpenCode'), 'opencode');
  assert.equal(normalizeTaskExecutor('opencode '), 'opencode');
  assert.equal(normalizeTaskExecutor('codex'), 'claude');
  assert.equal(normalizeTaskExecutor(undefined), 'claude');
  assert.equal(normalizeTaskExecutor(null), 'claude');
});

test('opencode 事件：text/reasoning 分别落 output/thinking，sessionID 被捕获', () => {
  const job = {};
  const sink = makeSink();
  const handle = createOpencodeEventHandler(job, sink.appendOutput, sink.appendThinking);

  handle({ type: 'step_start', sessionID: 'ses_a', part: { type: 'step-start' } });
  handle({ type: 'reasoning', sessionID: 'ses_a', part: { id: 'p1', type: 'reasoning', text: '想一下' } });
  handle({ type: 'text', sessionID: 'ses_a', part: { id: 'p2', type: 'text', text: '好的' } });
  handle({ type: 'step_finish', sessionID: 'ses_a', part: { type: 'step-finish', tokens: {} } });

  assert.deepEqual(sink.output, ['好的']);
  assert.deepEqual(sink.thinking, ['想一下']);
  assert.equal(job.claudeSessionId, 'ses_a');
  assert.equal(job.agentError, undefined);
});

test('opencode 事件：同一 part 累积推送只追加增量', () => {
  const job = {};
  const sink = makeSink();
  const handle = createOpencodeEventHandler(job, sink.appendOutput, sink.appendThinking);

  // 累积语义：第二次事件的 text 是第一次的前缀延长
  handle({ type: 'text', sessionID: 'ses_b', part: { id: 'p1', text: 'Hello' } });
  handle({ type: 'text', sessionID: 'ses_b', part: { id: 'p1', text: 'Hello, world' } });
  // 重复事件（完全相同）：不产生任何输出
  handle({ type: 'text', sessionID: 'ses_b', part: { id: 'p1', text: 'Hello, world' } });

  assert.deepEqual(sink.output, ['Hello', ', world']);

  // 纯增量语义（text 不是前次的前缀延长）：整段追加
  handle({ type: 'text', sessionID: 'ses_b', part: { id: 'p1', text: '!' } });
  assert.deepEqual(sink.output, ['Hello', ', world', '!']);
});

test('opencode 事件：error 事件写入 agentError，只记第一条', () => {
  const job = {};
  const sink = makeSink();
  const handle = createOpencodeEventHandler(job, sink.appendOutput, sink.appendThinking);

  handle({ type: 'error', sessionID: 'ses_c', error: { name: 'UnknownError', data: { message: 'Unexpected server error' } } });
  handle({ type: 'error', sessionID: 'ses_c', error: { name: 'UnknownError', data: { message: 'second one' } } });

  assert.equal(job.agentError, 'Unexpected server error');
  // error 前若有正文，正文保留（前端能看到已产出的部分）
  assert.deepEqual(sink.output, []);
});

test('opencode 事件：error 结构缺 data.message 时逐级回落', () => {
  const job = {};
  const sink = makeSink();
  const handle = createOpencodeEventHandler(job, sink.appendOutput, sink.appendThinking);

  handle({ type: 'error', sessionID: 'ses_d', error: { name: 'ProviderError' } });
  assert.equal(job.agentError, 'ProviderError');

  const job2 = {};
  const handle2 = createOpencodeEventHandler(job2, sink.appendOutput, sink.appendThinking);
  handle2({ type: 'error', sessionID: 'ses_e', error: {} });
  assert.equal(job2.agentError, 'opencode 执行出错');
});

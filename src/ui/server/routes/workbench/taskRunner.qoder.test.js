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

// qoder 执行器（阿里 Qoder CLI，2026-11-12 接入）的回归测试。
//
// 钉住的口径（来自 1.1.87 的静态核对 + 官方文档；真实事件流以登录后的活体探针为准）：
//   1. 白名单 / 归一化里有 qoder（config.js 与 taskRunner 两份清单一致）
//   2. spawn argv：-p + stream-json + **--permission-mode bypass_permissions**
//      （headless 默认 ask=deny，少了它所有写操作都被自动拒绝）
//      + --add-dir <cwd>（folderTrust 默认开）+ --settings 内联关自动更新
//      + 续聊时 --resume <id> 在前；**不出现** qoder 分发器参数（无头只走 qodercli）
//   3. 事件映射：init → session_id（只认第一条）；assistant 的 text/thinking/tool_use；
//      user 里的 tool_result 回指；result 成功分支忽略；error / result.is_error 落 agentError
//
// 隔离策略同 taskRunner.codebuddy.test.js。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../../../..');

// ---- 环境隔离:必须在 import taskRunner.js 之前完成 ----
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'zen-taskrunner-qoder-test-'));
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

const {
  createQoderEventHandler,
  buildQoderArgs,
  buildQoderEnv,
  normalizeTaskExecutor,
  TASK_EXECUTORS,
} = await import(
  pathToFileURL(path.join(projectRoot, 'src/ui/server/routes/workbench/taskRunner.js')).href
);

function makeSink() {
  const sink = { output: [], thinking: [] };
  sink.appendOutput = (t) => { if (t) sink.output.push(t); };
  sink.appendThinking = (t) => { if (t) sink.thinking.push(t); };
  return sink;
}

function makeTrackerSpy() {
  const records = [];
  return {
    records,
    record: (r) => records.push(r),
    flush: () => {},
  };
}

test('normalizeTaskExecutor：qoder 在白名单里，非法值回落 claude', () => {
  assert.deepEqual(TASK_EXECUTORS, ['claude', 'opencode', 'codex', 'codebuddy', 'pi', 'codearts', 'qoder']);
  assert.equal(normalizeTaskExecutor('qoder'), 'qoder');
  assert.equal(normalizeTaskExecutor('Qoder'), 'qoder');
  assert.equal(normalizeTaskExecutor(' qoder '), 'qoder');
  assert.equal(normalizeTaskExecutor(undefined), 'claude');
  assert.equal(normalizeTaskExecutor('qorder'), 'claude');
});

test('buildQoderArgs：无头参数 + 权限档 + cwd 信任 + 本轮关自动更新', () => {
  const args = buildQoderArgs('D:\\repo', '');
  assert.deepEqual(args, [
    '-p',
    '--output-format', 'stream-json',
    '--permission-mode', 'bypass_permissions',
    '--add-dir', 'D:\\repo',
    '--settings', '{"general":{"enableAutoUpdate":false}}',
  ]);
  // prompt 必须走 stdin（不带 query），否则 Windows 32K 命令行上限会炸长 prompt
  assert.equal(args[args.indexOf('-p') + 1], '--output-format');
  // 无头任务不能问批准：headless 默认 ask=deny（官方文档）
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypass_permissions');
  // 不传模型：跟随 CLI 自己的配置
  assert.ok(!args.includes('--model'));
});

test('buildQoderArgs：有续聊 id 时 --resume 在最前', () => {
  const args = buildQoderArgs('D:\\repo', 'sess-abc');
  assert.deepEqual(args.slice(0, 2), ['--resume', 'sess-abc']);
  assert.ok(args.includes('-p'));
});

test('buildQoderEnv：只统一 locale，不覆盖 QODER_* 凭据', () => {
  const prev = process.env.QODER_PERSONAL_ACCESS_TOKEN;
  process.env.QODER_PERSONAL_ACCESS_TOKEN = 'pat-xyz';
  try {
    const env = buildQoderEnv();
    assert.equal(env.LANG, 'zh_CN.UTF-8');
    assert.equal(env.QODER_PERSONAL_ACCESS_TOKEN, 'pat-xyz');
  } finally {
    if (prev === undefined) delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
    else process.env.QODER_PERSONAL_ACCESS_TOKEN = prev;
  }
});

test('qoder 事件：init 落 session_id，text/thinking/tool_use 分派', () => {
  const job = {};
  const sink = makeSink();
  const tracker = makeTrackerSpy();
  const handle = createQoderEventHandler(job, sink.appendOutput, sink.appendThinking, tracker);

  handle({ type: 'system', subtype: 'init', session_id: 'qoder-sess-1', model: 'auto' });
  handle({ type: 'assistant', message: { content: [{ type: 'text', text: '你好' }] } });
  handle({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '先想想' }] } });
  handle({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } }] } });

  assert.equal(job.claudeSessionId, 'qoder-sess-1');
  assert.deepEqual(sink.output, ['你好']);
  assert.deepEqual(sink.thinking, ['先想想']);
  assert.deepEqual(tracker.records, [{ id: 'tu-1', name: 'Bash', input: { command: 'ls' }, status: 'running' }]);
});

test('qoder 事件：user 里的 tool_result 回指，is_error 映射 error', () => {
  const job = {};
  const sink = makeSink();
  const tracker = makeTrackerSpy();
  const handle = createQoderEventHandler(job, sink.appendOutput, sink.appendThinking, tracker);

  handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'a.txt\nb.txt' }] } });
  handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-2', is_error: true, content: 'boom' }] } });

  assert.equal(tracker.records[0].status, 'done');
  assert.match(String(tracker.records[0].output), /a\.txt/);
  assert.equal(tracker.records[1].status, 'error');
  assert.match(String(tracker.records[1].error), /boom/);
  assert.deepEqual(sink.output, []);
});

test('qoder 事件：stream_event / 成功的 result 不当正文，未知事件不抛错', () => {
  const job = {};
  const sink = makeSink();
  const tracker = makeTrackerSpy();
  const handle = createQoderEventHandler(job, sink.appendOutput, sink.appendThinking, tracker);

  handle({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } });
  handle({ type: 'result', subtype: 'success', is_error: false, result: '最终快照', total_credits: 1 });
  handle(null);
  handle('not-an-object');
  handle({ type: 'assistant' });
  handle({ type: 'assistant', message: { content: 'string-not-array' } });
  handle({ type: 'user', message: { content: 'plain user prompt' } });

  assert.deepEqual(sink.output, [], 'result.result 是终态快照，不是新的正文分片');
  assert.deepEqual(sink.thinking, []);
  assert.equal(tracker.records.length, 0);
  assert.equal(job.claudeSessionId, undefined);
  assert.equal(job.agentError, undefined);
});

test('qoder 事件：error / result.is_error 落 agentError（进程可能 exit 0）', () => {
  const job = {};
  const handle = createQoderEventHandler(job, () => {}, () => {}, makeTrackerSpy());
  handle({ type: 'error', error: 'No conversation found with session ID: x' });
  assert.equal(job.agentError, 'No conversation found with session ID: x');

  const job2 = {};
  const handle2 = createQoderEventHandler(job2, () => {}, () => {}, makeTrackerSpy());
  handle2({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Not logged in'] });
  assert.equal(job2.agentError, 'Not logged in');

  const job3 = {};
  const handle3 = createQoderEventHandler(job3, () => {}, () => {}, makeTrackerSpy());
  handle3({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });
  assert.equal(job3.agentError, undefined);
});

test('qoder 事件：子会话 init 不能顶掉主会话 id（--resume 全靠它）', () => {
  const job = {};
  const handle = createQoderEventHandler(job, () => {}, () => {}, makeTrackerSpy());
  handle({ type: 'system', subtype: 'init', session_id: 'main-sess' });
  handle({ type: 'system', subtype: 'init', session_id: 'sub-sess' });
  assert.equal(job.claudeSessionId, 'main-sess');
});

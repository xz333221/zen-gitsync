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

// codebuddy 执行器（CodeBuddy Code CLI）的回归测试（2026-10-12）。
//
// 钉住的口径（全部来自当天实测，CLI 2.164.0）：
//   1. 白名单 / 归一化里有 codebuddy（config.js 与 taskRunner 两份清单一致）
//   2. spawn argv：-p + stream-json + -y + **--port 0**（避开桌面版占用的 62443）
//      + 续聊时 --resume <id>；**不出现** --verbose（cbc 不需要，claude 才需要）
//   3. 子进程环境：DISABLE_AUTOUPDATER / CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS
//      必须带上（丢了不会报错，只会某天任务跑到一半被自动更新换掉二进制）
//   4. 事件映射：init → session_id；assistant 的 text/thinking/tool_use 分派；
//      user 里的 tool_result 回指；cbc 特有的 system/status、ai-title、result 一律忽略
//   5. 工具调用是"先 tool_use(running)、后 user(tool_result)"两条，不是一次性终态
//      （runExternalTurn 的 announced 补 start 机制就是为后者准备的，两条式直接命中）
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
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'zen-taskrunner-cb-test-'));
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

const {
  createCodebuddyEventHandler,
  buildCodebuddyArgs,
  buildCodebuddyEnv,
  normalizeTaskExecutor,
  TASK_EXECUTORS,
} = await import(
  pathToFileURL(path.join(projectRoot, 'src/ui/server/routes/workbench/taskRunner.js')).href
);

/** 可断言的 appendOutput/appendThinking 收集器 */
function makeSink() {
  const sink = { output: [], thinking: [] };
  sink.appendOutput = (t) => { if (t) sink.output.push(t); };
  sink.appendThinking = (t) => { if (t) sink.thinking.push(t); };
  return sink;
}

/** tracker 探针：只记 handler 喂了哪些 record（不碰真 tracker 的落盘/推送） */
function makeTrackerSpy() {
  const records = [];
  return {
    records,
    record: (r) => records.push(r),
    flush: () => {},
  };
}

test('normalizeTaskExecutor：codebuddy 在白名单里，非法值回落 claude', () => {
  assert.deepEqual(TASK_EXECUTORS, ['claude', 'opencode', 'codex', 'codebuddy']);
  assert.equal(normalizeTaskExecutor('codebuddy'), 'codebuddy');
  assert.equal(normalizeTaskExecutor('CodeBuddy'), 'codebuddy');
  assert.equal(normalizeTaskExecutor('codebuddy '), 'codebuddy');
  // 历史默认不能变：老配置/老 job 缺 executor 时仍落在 claude
  assert.equal(normalizeTaskExecutor(undefined), 'claude');
  assert.equal(normalizeTaskExecutor('cursor'), 'claude');
});

test('buildCodebuddyArgs：基础 argv 带 -p/stream-json/-y/--port 0，不带 --verbose', () => {
  const args = buildCodebuddyArgs('');
  assert.deepEqual(args, ['-p', '--output-format', 'stream-json', '-y', '--port', '0']);
  // claude 的 stream-json 必须配 --verbose，cbc 不需要 —— 多传一个少传一个都是坑，
  // 这里双向钉住：不许出现 verbose，也不许漏掉 port 0
  assert.ok(!args.includes('--verbose'));
  assert.equal(args[args.indexOf('--port') + 1], '0');
  // 不传模型：跟随 CLI 自己的配置（与另三家同一口径）
  assert.ok(!args.includes('--model'));
});

test('buildCodebuddyArgs：有续聊 id 时 --resume 在前', () => {
  const args = buildCodebuddyArgs('sess-abc');
  assert.deepEqual(args.slice(0, 2), ['--resume', 'sess-abc']);
  assert.ok(args.includes('-p'));
});

test('buildCodebuddyEnv：禁自动更新 + 禁后台任务 + LANG，不隔离配置目录', () => {
  const env = buildCodebuddyEnv();
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
  assert.equal(env.CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS, '1');
  assert.equal(env.LANG, 'zh_CN.UTF-8');
  // 刻意不设 CODEBUDDY_CONFIG_DIR：与桌面版共用 ~/.codebuddy 才能拿到登录态/MCP/Skills
  assert.equal(env.CODEBUDDY_CONFIG_DIR, undefined);
});

test('codebuddy 事件：init 落 session_id，text/thinking/tool_use 分派', () => {
  const job = {};
  const sink = makeSink();
  const tracker = makeTrackerSpy();
  const handle = createCodebuddyEventHandler(job, sink.appendOutput, sink.appendThinking, tracker);

  handle({ type: 'system', subtype: 'init', session_id: 'cbc-sess-1', apiKeySource: 'www.workbuddy.cn', tools: [] });
  handle({ type: 'assistant', message: { content: [{ type: 'text', text: '你好' }] } });
  handle({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '先想想' }] } });
  handle({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } }] } });

  assert.equal(job.claudeSessionId, 'cbc-sess-1');
  assert.deepEqual(sink.output, ['你好']);
  assert.deepEqual(sink.thinking, ['先想想']);
  assert.equal(tracker.records.length, 1);
  assert.deepEqual(tracker.records[0], { id: 'tu-1', name: 'Bash', input: { command: 'ls' }, status: 'running' });
});

test('codebuddy 事件：user 里的 tool_result 回指 tool_use_id，is_error 映射 error', () => {
  const job = {};
  const sink = makeSink();
  const tracker = makeTrackerSpy();
  const handle = createCodebuddyEventHandler(job, sink.appendOutput, sink.appendThinking, tracker);

  handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'a.txt\nb.txt' }] } });
  handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-2', is_error: true, content: 'boom' }] } });

  assert.equal(tracker.records.length, 2);
  assert.equal(tracker.records[0].id, 'tu-1');
  assert.equal(tracker.records[0].status, 'done');
  assert.match(String(tracker.records[0].output), /a\.txt/);
  assert.equal(tracker.records[1].status, 'error');
  assert.match(String(tracker.records[1].error), /boom/);
  // tool_result 是回指，不当正文吐出来
  assert.deepEqual(sink.output, []);
});

test('codebuddy 事件：cbc 特有事件（system/status、ai-title、result）一律忽略', () => {
  const job = {};
  const sink = makeSink();
  const tracker = makeTrackerSpy();
  const handle = createCodebuddyEventHandler(job, sink.appendOutput, sink.appendThinking, tracker);

  handle({ type: 'system', subtype: 'status', status: 'compacting', session_id: 's' });
  handle({ type: 'ai-title', title: '某个标题' });
  handle({ type: 'result', subtype: 'success', is_error: false, session_id: 's', usage: {} });
  // 未知/畸形事件也不能抛错（NDJSON 分行解析里抛错会打死整轮对话）
  handle(null);
  handle('not-an-object');
  handle({ type: 'assistant' });
  handle({ type: 'assistant', message: { content: 'string-not-array' } });
  handle({ type: 'user', message: { content: 'plain user prompt' } });

  assert.deepEqual(sink.output, []);
  assert.deepEqual(sink.thinking, []);
  assert.equal(tracker.records.length, 0);
  assert.equal(job.claudeSessionId, undefined);
});

test('codebuddy 事件：工具调用是两条式（running → tool_result），不是一次性终态', () => {
  const job = {};
  const sink = makeSink();
  const tracker = makeTrackerSpy();
  const handle = createCodebuddyEventHandler(job, sink.appendOutput, sink.appendThinking, tracker);

  // 实测序列（2026-10-12）：Glob running → Glob 结果 → Read running → Read 结果 → 正文
  handle({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call_1', name: 'Glob', input: { pattern: '**/a.txt' } }] } });
  handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: '["a.txt"]' }] }] } });
  handle({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call_2', name: 'Read', input: { file_path: 'a.txt' } }] } });
  handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call_2', content: [{ type: 'text', text: 'hello' }] }] } });
  handle({ type: 'assistant', message: { content: [{ type: 'text', text: '读完了' }] } });

  assert.deepEqual(tracker.records.map(r => [r.id, r.status]), [
    ['call_1', 'running'],
    ['call_1', 'done'],
    ['call_2', 'running'],
    ['call_2', 'done'],
  ]);
  // tool_result.content 是块数组时抽文本（与 claude 的 extractToolText 同口径）
  assert.match(String(tracker.records[1].output), /a\.txt/);
  assert.deepEqual(sink.output, ['读完了']);
});

test('codebuddy 事件：init 重复推送（实测出现过两条）只认第一条', () => {
  const job = {};
  const sink = makeSink();
  const handle = createCodebuddyEventHandler(job, sink.appendOutput, sink.appendThinking, makeTrackerSpy());

  handle({ type: 'system', subtype: 'init', session_id: 'cbc-sess-x' });
  handle({ type: 'system', subtype: 'init', session_id: 'cbc-sess-x' });

  assert.equal(job.claudeSessionId, 'cbc-sess-x');
  assert.deepEqual(sink.output, []);
});

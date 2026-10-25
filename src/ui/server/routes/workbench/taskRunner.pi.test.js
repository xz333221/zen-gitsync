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

// pi 执行器（Pi Agent CLI，npm @earendil-works/pi-coding-agent）的回归测试
// （2026-10-13）。
//
// 钉住的口径（协议部分来自官方 docs/json.md，**事件形状全部经本机 v1.2.0 实测核对**
// —— 用 mock provider 真跑过一轮"文本 + 工具调用"， fixture 就是那次输出的原样）：
//   1. 白名单 / 归一化里有 pi（config.js 与 taskRunner 两份清单一致）
//   2. spawn argv：--mode json + -a（信任项目本地配置；pi 没有权限系统，
//      不存在 -y / --dangerously-* 那类档位参数）；续聊传 --session <id>
//      （**不是 --resume** —— 那是交互式会话选择器，headless 会卡住）；
//      不出现 --model（跟随 CLI 自己的配置，与另四家同口径）
//   3. 子进程环境：PI_SKIP_VERSION_CHECK=1（禁 pi.dev 启动版本检查）、
//      PI_TELEMETRY=0、LANG=zh_CN.UTF-8；继承来的嵌套会话标记
//      PI_SESSION_ID / PI_SESSION_FILE / PI_CODING_AGENT / AI_AGENT 必须剥掉
//      （官方环境变量文档警告嵌套 pi 会暴露父会话过期元数据）
//   4. 事件映射（pi 自有 JSONL，与 claude 的 stream-json 一处都对不上）：
//      session header → 会话 id；message_update.assistantMessageEvent 的
//      text_delta / thinking_delta → 正文 / 思考；tool_execution_start /
//      tool_execution_end → 工具调用两条；error / auto_retry_end(finalError) /
//      compaction_end(errorMessage) → job.agentError
//   5. agent_* / turn_* / message_start|end / queue_* / tool_execution_update
//      一律忽略 —— message_start 里那条 system prompt 有几万字节，
//      当正文吐出去会直接淹没有用输出
//
// 隔离策略同 taskRunner.codebuddy.test.js：import taskRunner.js 之前把
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
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'zen-taskrunner-pi-test-'));
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

const {
  createPiEventHandler,
  buildPiArgs,
  buildPiEnv,
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

test('normalizeTaskExecutor：pi 在白名单里，非法值回落 claude', () => {
  assert.deepEqual(TASK_EXECUTORS, ['claude', 'opencode', 'codex', 'codebuddy', 'pi', 'codearts']);
  assert.equal(normalizeTaskExecutor('pi'), 'pi');
  assert.equal(normalizeTaskExecutor('PI'), 'pi');
  assert.equal(normalizeTaskExecutor(' pi '), 'pi');
  // 历史默认不能变：老配置/老 job 缺 executor 时仍落在 claude
  assert.equal(normalizeTaskExecutor(undefined), 'claude');
  assert.equal(normalizeTaskExecutor('cursor'), 'claude');
});

test('buildPiArgs：基础 argv 带 --mode json + -a，不带 --model / --resume', () => {
  const args = buildPiArgs('');
  assert.deepEqual(args, ['--mode', 'json', '-a']);
  // 不传模型：跟随 CLI 自己的配置（与另四家同一口径）
  assert.ok(!args.includes('--model'));
  // ⚠️ --resume 是 pi 的**交互式会话选择器**，headless 下会开 TUI 卡住 ——
  // 续聊只能走 --session（见下一条）。这里双向钉住：不许出现。
  assert.ok(!args.includes('--resume'));
});

test('buildPiArgs：有续聊 id 时 --session 在前（不是 --resume）', () => {
  const args = buildPiArgs('01a13370-8352-75bb-9ccd-6e56480e704d');
  assert.deepEqual(args.slice(0, 2), ['--session', '01a13370-8352-75bb-9ccd-6e56480e704d']);
  assert.ok(args.includes('--mode'));
  assert.ok(args.includes('-a'));
});

test('buildPiEnv：禁版本检查 + 关遥测 + LANG，剥掉继承来的嵌套会话标记', () => {
  // 模拟"g gui 在某个 pi 会话的 bash 工具里被拉起"：父会话的标记会继承过来。
  const had = {};
  const pollution = {
    // 嵌套 pi 的过期会话元数据（官方环境变量文档明确警告的一类）
    PI_SESSION_ID: 'parent-session-id',
    PI_SESSION_FILE: 'C:/parent/session.jsonl',
    PI_CODING_AGENT: 'true',
    AI_AGENT: 'pi',
    // 反例：用户的合法配置不在剥离范围
    ANTHROPIC_API_KEY: 'user-key',
    HTTPS_PROXY: 'http://127.0.0.1:10808',
  };
  for (const [k, v] of Object.entries(pollution)) { had[k] = process.env[k]; process.env[k] = v; }
  try {
    const env = buildPiEnv();
    for (const k of ['PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_CODING_AGENT', 'AI_AGENT']) {
      assert.equal(env[k], undefined, `${k} 应被剥掉（嵌套 pi 的父会话元数据）`);
    }
    // 自己的三项设定
    assert.equal(env.PI_SKIP_VERSION_CHECK, '1');
    assert.equal(env.PI_TELEMETRY, '0');
    assert.equal(env.LANG, 'zh_CN.UTF-8');
    // 用户合法变量原样继承（认证 / 代理）
    assert.equal(env.ANTHROPIC_API_KEY, 'user-key');
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:10808');
  } finally {
    for (const [k, v] of Object.entries(had)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('pi 事件：session header 落会话 id，text_delta/thinking_delta 分派', () => {
  const job = {};
  const sink = makeSink();
  const tracker = makeTrackerSpy();
  const handle = createPiEventHandler(job, sink.appendOutput, sink.appendThinking, tracker);

  // 首条就是 session header（实测输出的第一条，原样）
  handle({ type: 'session', version: 3, id: '01a13370-8352-75bb-9ccd-6e56480e704d', timestamp: '2026-10-13T04:06:14.099Z', cwd: 'D:/ws' });
  handle({ type: 'message_update', usage: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '让我跑个命令。' } });
  handle({ type: 'message_update', usage: {}, assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '先想想' } });
  handle({ type: 'message_update', usage: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '跑完了' } });

  assert.equal(job.claudeSessionId, '01a13370-8352-75bb-9ccd-6e56480e704d');
  assert.deepEqual(sink.output, ['让我跑个命令。', '跑完了']);
  assert.deepEqual(sink.thinking, ['先想想']);
  assert.equal(tracker.records.length, 0);
});

test('pi 事件：tool_execution_start/end 两条式（args 完整、result 抽文本、isError 映射 error）', () => {
  const job = {};
  const sink = makeSink();
  const tracker = makeTrackerSpy();
  const handle = createPiEventHandler(job, sink.appendOutput, sink.appendThinking, tracker);

  // 实测序列（v1.2.0 + mock provider）：bash 跑通 → bash 报错
  handle({ type: 'tool_execution_start', toolCallId: 'call_mock_1', toolName: 'bash', args: { command: 'echo mock-output' } });
  handle({ type: 'tool_execution_update', toolCallId: 'call_mock_1', toolName: 'bash', args: { command: 'echo mock-output' }, partialResult: { content: [{ type: 'text', text: 'partial' }], details: {} } });
  handle({ type: 'tool_execution_end', toolCallId: 'call_mock_1', toolName: 'bash', result: { content: [{ type: 'text', text: 'mock-output\n' }], details: {} }, isError: false, durationMs: 54 });
  handle({ type: 'tool_execution_start', toolCallId: 'call_mock_2', toolName: 'read', args: { path: 'missing.txt' } });
  handle({ type: 'tool_execution_end', toolCallId: 'call_mock_2', toolName: 'read', result: { content: [{ type: 'text', text: 'ENOENT' }], details: {} }, isError: true, durationMs: 3 });

  // end 记录只带 id/status/output/error：name 在 start 那条里，真 tracker 按 id
  // 合并（与 codebuddy 的 user(tool_result) 同一口径 —— 那条也不重复带 name）
  assert.deepEqual(tracker.records.map(r => [r.id, r.status]), [
    ['call_mock_1', 'running'],
    ['call_mock_1', 'done'],
    ['call_mock_2', 'running'],
    ['call_mock_2', 'error'],
  ]);
  assert.equal(tracker.records[0].name, 'bash');
  assert.equal(tracker.records[2].name, 'read');
  // start 带的是完整解析值（不用拼 toolcall_delta），原样进 input
  assert.deepEqual(tracker.records[0].input, { command: 'echo mock-output' });
  // end 的 result.content 是块数组（与 claude 的 tool_result 同形状）
  assert.match(String(tracker.records[1].output), /mock-output/);
  assert.match(String(tracker.records[3].error), /ENOENT/);
  // 工具事件不当正文吐出来
  assert.deepEqual(sink.output, []);
});

test('pi 事件：agent_*/turn_*/message_start|end 等一律忽略（system prompt 有几万字节）', () => {
  const job = {};
  const sink = makeSink();
  const tracker = makeTrackerSpy();
  const handle = createPiEventHandler(job, sink.appendOutput, sink.appendThinking, tracker);

  // message_start 的 system 消息在实测里是**整份系统提示词**（preamble/tools/rules/
  // docs/skills 五大段），当正文吐出去会淹没有用输出；message_end 只是权威副本
  // （正文已由 text_delta 增量覆盖，再吐一遍就是重复）。
  handle({ type: 'agent_start' });
  handle({ type: 'turn_start' });
  handle({ type: 'message_start', message: { role: 'system', content: '', sections: { preamble: 'You are an expert coding assistant…' }, timestamp: 1 } });
  handle({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'hi, run echo' }], timestamp: 2 } });
  handle({ type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } });
  handle({ type: 'message_update', usage: {}, assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
  handle({ type: 'message_update', usage: {}, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: '完整文本' } });
  handle({ type: 'message_update', usage: {}, assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: 'c1', toolName: 'bash' } });
  handle({ type: 'message_update', usage: {}, assistantMessageEvent: { type: 'toolcall_end', contentIndex: 1, toolCall: { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } } } });
  handle({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '完整文本' }] } });
  handle({ type: 'turn_end', message: { role: 'assistant' }, toolResults: [] });
  handle({ type: 'queue_update', steering: [], followUp: [] });
  handle({ type: 'agent_end', messages: [], willRetry: false });
  handle({ type: 'agent_settled', aborted: false });

  assert.deepEqual(sink.output, []);
  assert.deepEqual(sink.thinking, []);
  assert.equal(tracker.records.length, 0);
  assert.equal(job.claudeSessionId, undefined);
});

test('pi 事件：协议层错误置 job.agentError（message error / auto_retry_end / compaction_end）', () => {
  // provider 流中途出错：message_update 的 assistantMessageEvent.type === 'error'
  const job1 = {};
  createPiEventHandler(job1, () => {}, () => {}, makeTrackerSpy())(
    { type: 'message_update', usage: {}, assistantMessageEvent: { type: 'error', reason: 'error', error: '529 overloaded' } }
  );
  assert.equal(job1.agentError, '529 overloaded');

  // 自动重试耗尽：auto_retry_end success:false + finalError
  const job2 = {};
  createPiEventHandler(job2, () => {}, () => {}, makeTrackerSpy())(
    { type: 'auto_retry_end', success: false, attempt: 3, finalError: 'rate limited after 3 attempts' }
  );
  assert.equal(job2.agentError, 'rate limited after 3 attempts');

  // 压缩失败且不重试：compaction_end 带 errorMessage
  const job3 = {};
  createPiEventHandler(job3, () => {}, () => {}, makeTrackerSpy())(
    { type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false, errorMessage: 'summarization failed' }
  );
  assert.equal(job3.agentError, 'summarization failed');

  // 只记第一条（后续事件可能是同一次失败的余波）
  const job4 = {};
  const h4 = createPiEventHandler(job4, () => {}, () => {}, makeTrackerSpy());
  h4({ type: 'message_update', usage: {}, assistantMessageEvent: { type: 'error', reason: 'error', error: 'first' } });
  h4({ type: 'message_update', usage: {}, assistantMessageEvent: { type: 'error', reason: 'error', error: 'second' } });
  assert.equal(job4.agentError, 'first');

  // 成功的 compaction / auto_retry 不判失败
  const job5 = {};
  const h5 = createPiEventHandler(job5, () => {}, () => {}, makeTrackerSpy());
  h5({ type: 'compaction_end', reason: 'threshold', result: { summary: 'ok' }, aborted: false, willRetry: false });
  h5({ type: 'auto_retry_end', success: true, attempt: 2 });
  assert.equal(job5.agentError, undefined);
});

test('pi 事件：畸形/未知事件不能抛错（NDJSON 分行解析里抛错会打死整轮对话）', () => {
  const job = {};
  const sink = makeSink();
  const tracker = makeTrackerSpy();
  const handle = createPiEventHandler(job, sink.appendOutput, sink.appendThinking, tracker);

  handle(null);
  handle('not-an-object');
  handle({});
  handle({ type: 'message_update' });                          // 缺 assistantMessageEvent
  handle({ type: 'message_update', assistantMessageEvent: null });
  handle({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' } }); // 缺 delta
  handle({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 42 } }); // delta 非字符串
  handle({ type: 'session', id: 123 });                        // id 非字符串 → 不当会话标识
  handle({ type: 'tool_execution_start', toolName: 'bash' });  // 缺 toolCallId
  handle({ type: 'tool_execution_end', toolCallId: 'c9', result: null, isError: false });
  handle({ type: 'tool_execution_end', toolCallId: 'c10', result: { content: [] }, isError: true });

  assert.deepEqual(sink.output, []);
  assert.equal(job.claudeSessionId, undefined);
  // 只有带了合法 toolCallId 的两条 end 进了 tracker
  assert.deepEqual(tracker.records.map(r => [r.id, r.status]), [['c9', 'done'], ['c10', 'error']]);
});

test('pi 事件：session header 重复推送只认第一条', () => {
  const job = {};
  const sink = makeSink();
  const handle = createPiEventHandler(job, sink.appendOutput, sink.appendThinking, makeTrackerSpy());

  handle({ type: 'session', version: 3, id: 'pi-sess-x', cwd: 'D:/ws' });
  handle({ type: 'session', version: 3, id: 'pi-sess-x', cwd: 'D:/ws' });

  assert.equal(job.claudeSessionId, 'pi-sess-x');
  assert.deepEqual(sink.output, []);
});

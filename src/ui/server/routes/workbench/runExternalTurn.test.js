// 外部引擎一轮对话的适配器单测。
//
// 这里**故意不 mock 事件处理器** —— 用的是 taskRunner 里真的那三个
// （createClaudeEventHandler / createOpencodeEventHandler / createCodexEventHandler），
// 只把 spawn 换成假的子进程喂固定的 NDJSON。这样测的是"三家协议 → SSE 事件"这条真链路：
// mock 掉处理器就只能测到我自己写的胶水，而那恰恰是最不容易错的部分。
//
// 每个引擎的样例 NDJSON 都取自实测（见 taskRunner 各 handler 的头部注释与
// taskRunner.opencode.test.js / taskRunner.codex.test.js 的 fixture 口径）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import { runExternalTurn } from './runExternalTurn.js';

/** 假子进程：按顺序把 lines 推给 stdout，然后 close。 */
function fakeChild(lines, { exitCode = 0 } = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.kill = () => { child.exitCode = 0; child.emit('close', 0); };
  setImmediate(() => {
    for (const l of lines) child.stdout.push(`${l}\n`);
    child.stdout.push(null);
    child.exitCode = exitCode;
    child.emit('close', exitCode);
  });
  return child;
}

/** 收事件的小工具 */
function collector() {
  const events = [];
  return {
    events,
    send: (evt) => events.push(evt),
    of: (type) => events.filter(e => e.type === type),
    types: () => events.map(e => e.type),
  };
}

const baseSession = () => ({ messages: [], engineSessionId: '' });

test('claude:stream-json → content / thinking / tool_call_start / tool_result / done', async () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '你好' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '先看看' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt\nb.txt' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '结束' }] } }),
  ];
  const session = baseSession();
  const c = collector();
  await runExternalTurn({
    session, engine: 'claude', userMessage: '列个目录', cwd: 'D:/ws',
    send: c.send,
    launchers: { claude: async () => ({ pid: 4242, child: fakeChild(lines) }) },
  });

  assert.equal(c.of('content').map(e => e.delta).join(''), '你好结束');
  assert.equal(c.of('thinking').map(e => e.delta).join(''), '先看看');
  const starts = c.of('tool_call_start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].toolCallId, 't1');
  assert.equal(starts[0].name, 'Bash');
  assert.match(starts[0].argsPreview, /ls/);
  const results = c.of('tool_result');
  assert.equal(results.length, 1);
  assert.match(String(results[0].result), /a\.txt/);
  assert.equal(c.of('done').length, 1);
  assert.equal(c.of('error').length, 0);
  assert.equal(c.of('done')[0].content, '你好结束');

  // 续聊标识搬运：claude 的 session_id → session.engineSessionId
  assert.equal(session.engineSessionId, 'claude-sess-1');
});

test('opencode:--format json → 同一组事件（含 completed 态工具）', async () => {
  const lines = [
    JSON.stringify({ type: 'step_start', sessionID: 'oc-1', part: { type: 'step-start' } }),
    JSON.stringify({ type: 'text', sessionID: 'oc-1', part: { id: 'p1', type: 'text', text: '看看' } }),
    JSON.stringify({ type: 'reasoning', sessionID: 'oc-1', part: { id: 'p2', type: 'reasoning', text: '思考中' } }),
    JSON.stringify({ type: 'tool_use', sessionID: 'oc-1', part: { id: 'p3', callID: 'c1', type: 'tool', tool: 'bash', state: { status: 'completed', input: { cmd: 'ls' }, output: 'ok' } } }),
    JSON.stringify({ type: 'step_finish', sessionID: 'oc-1', part: { type: 'step-finish' } }),
  ];
  const session = baseSession();
  const c = collector();
  await runExternalTurn({
    session, engine: 'opencode', userMessage: 'hi', cwd: 'D:/ws',
    send: c.send,
    launchers: { opencode: async () => ({ pid: 4242, child: fakeChild(lines) }) },
  });

  assert.equal(c.of('content').map(e => e.delta).join(''), '看看');
  assert.equal(c.of('thinking').map(e => e.delta).join(''), '思考中');
  assert.equal(c.of('tool_call_start')[0].name, 'bash');
  assert.match(String(c.of('tool_result')[0].result), /ok/);
  assert.equal(c.of('done').length, 1);
  assert.equal(session.engineSessionId, 'oc-1');
});

test('codex:exec --json → 同一组事件（item.* 分派）', async () => {
  const lines = [
    JSON.stringify({ type: 'thread.started', thread_id: 'th-1' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: '好了' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'i2', type: 'reasoning', text: '想想' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'i3', type: 'command_execution', command: 'ls', status: 'completed', aggregated_output: 'files', exit_code: 0 } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
  ];
  const session = baseSession();
  const c = collector();
  await runExternalTurn({
    session, engine: 'codex', userMessage: 'hi', cwd: 'D:/ws',
    send: c.send,
    launchers: { codex: async () => ({ pid: 4242, child: fakeChild(lines) }) },
  });

  assert.equal(c.of('content').map(e => e.delta).join(''), '好了');
  assert.equal(c.of('thinking').map(e => e.delta).join(''), '想想');
  assert.equal(c.of('tool_call_start')[0].name, 'command_execution');
  assert.match(String(c.of('tool_result')[0].result), /files/);
  assert.equal(c.of('done').length, 1);
  assert.equal(session.engineSessionId, 'th-1');
});

test('非 JSON 行（CLI 的告警）原样贴出来，不当成事件丢掉', async () => {
  const session = baseSession();
  const c = collector();
  await runExternalTurn({
    session, engine: 'claude', userMessage: 'hi', cwd: 'D:/ws',
    send: c.send,
    launchers: { claude: async () => ({ pid: 4242, child: fakeChild(['Warning: something odd', '{"type":"result","subtype":"success"}']) }) },
  });
  assert.match(c.of('content').map(e => e.delta).join(''), /Warning: something odd/);
  assert.equal(c.of('error').length, 0, '告警不该被判成失败');
});

test('跨数据块被切断的 NDJSON 行要能拼回来', async () => {
  const session = baseSession();
  const c = collector();
  const child = new EventEmitter();
  child.pid = 1; child.exitCode = null;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.kill = () => {};
  setImmediate(() => {
    // 一条 JSON 被从中间切开推送
    child.stdout.push('{"type":"assistant","message":{"content":[{"type":"te');
    child.stdout.push('xt","text":"拼回来了"}]}}\n');
    child.stdout.push(null);
    child.emit('close', 0);
  });
  await runExternalTurn({
    session, engine: 'claude', userMessage: 'hi', cwd: 'D:/ws',
    send: c.send,
    launchers: { claude: async () => ({ pid: 1, child }) },
  });
  assert.equal(c.of('content').map(e => e.delta).join(''), '拼回来了');
});

test('工作区状态块拼在用户消息前面（不写进用户的仓库文件）', async () => {
  const session = baseSession();
  const c = collector();
  let seenPrompt = '';
  await runExternalTurn({
    session, engine: 'claude', userMessage: '我的仓库有哪些', cwd: 'D:/ws',
    promptPrefix: '【工作区状态】快照目录: C:/u/.zen-gitsync/ai-context',
    send: c.send,
    launchers: { claude: async (_cwd, prompt) => { seenPrompt = prompt; return { pid: 1, child: fakeChild([]) }; } },
  });
  assert.match(seenPrompt, /【工作区状态】/);
  assert.match(seenPrompt, /我的仓库有哪些/);
  assert.ok(seenPrompt.indexOf('【工作区状态】') < seenPrompt.indexOf('我的仓库有哪些'), '状态块必须在用户消息之前');
});

test('附件只传绝对路径，内容不进 prompt', async () => {
  const session = baseSession();
  const c = collector();
  let seenPrompt = '';
  await runExternalTurn({
    session, engine: 'claude', userMessage: '看看附件', cwd: 'D:/ws',
    filePaths: ['C:/u/.zen-gitsync/agent-attachments/2026-09-28/a.pdf'],
    send: c.send,
    launchers: { claude: async (_cwd, prompt) => { seenPrompt = prompt; return { pid: 1, child: fakeChild([]) }; } },
  });
  assert.match(seenPrompt, /a\.pdf/);
  assert.match(seenPrompt, /绝对路径/);
});

test('续聊：把上次的 engineSessionId 交给 launcher（--resume / --session）', async () => {
  const session = { messages: [], engineSessionId: 'prev-id' };
  const c = collector();
  let resumeArg = null;
  await runExternalTurn({
    session, engine: 'claude', userMessage: '继续', cwd: 'D:/ws',
    send: c.send,
    launchers: { claude: async (_cwd, _prompt, resumeId) => { resumeArg = resumeId; return { pid: 1, child: fakeChild([]) }; } },
  });
  assert.equal(resumeArg, 'prev-id');
});

test('launcher 抛错（CLI 没装）→ 发 error，不让整轮静默失败', async () => {
  const session = baseSession();
  const c = collector();
  await runExternalTurn({
    session, engine: 'codex', userMessage: 'hi', cwd: 'D:/ws',
    send: c.send,
    launchers: { codex: async () => { throw new Error('spawn codex ENOENT'); } },
  });
  assert.equal(c.of('error').length, 1);
  assert.match(c.of('error')[0].error, /Codex 启动失败/);
  assert.match(c.of('error')[0].error, /ENOENT/);
  assert.equal(c.of('done').length, 0, '启动失败不该再发 done');
});

test('未知引擎 → 明确报错（不静默当内置处理）', async () => {
  const c = collector();
  await runExternalTurn({ session: baseSession(), engine: 'gemini', userMessage: 'hi', cwd: 'D:/ws', send: c.send });
  assert.equal(c.of('error').length, 1);
  assert.match(c.of('error')[0].error, /未知的外部引擎/);
});

test('落盘：user + assistant(带 tool_calls) + tool 结果，形状与 g ai 一致', async () => {
  const lines = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '看完了' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't9', name: 'Read', input: { path: 'a.md' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't9', content: '内容' }] } }),
  ];
  const session = baseSession();
  const c = collector();
  await runExternalTurn({
    session, engine: 'claude', userMessage: '看看', cwd: 'D:/ws',
    send: c.send,
    launchers: { claude: async () => ({ pid: 1, child: fakeChild(lines) }) },
  });

  assert.equal(session.messages[0].role, 'user');
  const assistant = session.messages.find(m => m.role === 'assistant');
  assert.equal(assistant.content, '看完了');
  assert.equal(assistant.tool_calls[0].id, 't9');
  assert.equal(assistant.tool_calls[0].type, 'function');
  assert.equal(assistant.tool_calls[0].function.name, 'Read');
  const tool = session.messages.find(m => m.role === 'tool');
  assert.equal(tool.tool_call_id, 't9');
  assert.equal(tool.content, '内容');
});

test('中止：用户点停止 → 杀掉子进程树并标 [已停止]', async () => {
  const session = baseSession();
  const c = collector();
  const ac = new AbortController();
  let killed = false;
  const child = new EventEmitter();
  child.pid = 999; child.exitCode = null;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.kill = () => { child.exitCode = 143; child.emit('close', 143); };
  setImmediate(() => { child.stdout.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '写了一半' }] } }) + '\n'); ac.abort(); });

  await runExternalTurn({
    session, engine: 'claude', userMessage: 'hi', cwd: 'D:/ws',
    signal: ac.signal,
    send: c.send,
    launchers: { claude: async () => ({ pid: 999, child }) },
    // 注入杀掉实现：真实现走 taskkill，假子进程上观察不到，只能注入
    killTree: () => { killed = true; child.kill(); },
  });

  assert.equal(killed, true, '中止必须杀掉子进程（否则界面停了、机器上还在跑）');
  assert.match(c.of('done')[0].content, /已停止/);
});

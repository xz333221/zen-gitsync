import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// agentSessionStore 的落盘目录在模块加载时由 os.homedir() 求值，必须在 import 之前
// 把 HOME 指到沙箱，否则这个文件会往真实 ~/.zen-gitsync/agent-sessions 里写会话。
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'zen-agent-routes-'));
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

const { registerAgentRoutes, waitForAgentAnswer } = await import('./agentRoutes.js');

// 工作区状态快照的替身。真实实现会 spawn `gh` / `gitee` / PowerShell 并联网,
// 单测里一律用空壳 —— 否则跑一次对话就在测试机上拉起一串子进程、还连一次网。
// getBlock 回空串 = "这一轮不注入快照",与冷启动时的真实行为一致(见 aiContext/index.js
// 的 getSnapshot:冷启动先回 null,后台再生成)。
const STUB_SNAPSHOTTER = {
  getBlock: async () => '',
  warm: async () => null,
  refreshAll: async () => null,
  refreshSections: async () => ({ dir: '', persistedAt: null, sections: [] }),
  getState: () => ({ dir: '', persistedAt: null, sections: [] }),
  invalidate() {}
};

const event = data => `data: ${JSON.stringify(data)}\n\n`;

// 轮询等待条件成立（SSE 是边跑边写出来的，没有可 await 的句柄）
async function waitUntil(check, timeoutMs = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// 面板切换 → 定向刷新快照的端点。守两件事：
//   ① sections 原样透传给生成器（前端按"我在看哪一块"决定刷哪几块）
//   ② 不带 body / 不带 sections 时等于"全部"，不是"什么都不刷"
test('ai-context 刷新端点:按板块定向刷新，并把各板块状态回给前端', async () => {
  const calls = [];
  let refreshHandler;
  let stateHandler;
  const FAKE_STATE = { dir: 'D:/snap', persistedAt: '2026-09-28 10:00:00', sections: [{ id: 'git', fresh: true }] };
  const app = {
    get(route, handler) { if (route === '/api/ai-context/state') stateHandler = handler; },
    delete() {},
    put() {},
    post(route, handler) { if (route === '/api/ai-context/refresh') refreshHandler = handler; }
  };
  registerAgentRoutes({
    app,
    getCurrentProjectPath: () => path.resolve('active-project'),
    configManager: null,
    snapshotter: {
      ...STUB_SNAPSHOTTER,
      refreshSections: async (ids, opts) => { calls.push({ ids, opts }); return FAKE_STATE; },
      getState: () => FAKE_STATE
    }
  });

  let payload;
  const res = { json(v) { payload = v; } };

  await refreshHandler({ body: { sections: ['github'], force: true } }, res);
  assert.deepEqual(calls[0].ids, ['github']);
  assert.equal(calls[0].opts.force, true);
  assert.equal(payload.success, true);
  assert.equal(payload.dir, 'D:/snap');

  // 不带 body：sections 为 undefined = 全部，force 默认 false（尊重各板块 TTL）
  await refreshHandler({}, res);
  assert.equal(calls[1].ids, undefined);
  assert.equal(calls[1].opts.force, false);

  // 只读状态的口：不触发任何取数
  await stateHandler({}, res);
  assert.equal(payload.dir, 'D:/snap');
  assert.equal(calls.length, 2, 'GET /state 不该触发刷新');
});

test('agent respond resolves a pending ask_user question and validates answers', async () => {
  let respondHandler;
  const app = {
    get() {},
    delete() {},
    put() {},
    post(route, handler) {
      if (route === '/api/agent/respond') respondHandler = handler;
    }
  };
  registerAgentRoutes({
    app,
    getCurrentProjectPath: () => path.resolve('active-project'),
    configManager: null,
    snapshotter: STUB_SNAPSHOTTER
  });

  const sent = [];
  const pending = waitForAgentAnswer({
    sessionId: 'session-test',
    interactionId: 'call-test',
    question: 'Pick one',
    options: ['A', 'B'],
    allowFreeText: false,
    send: event => sent.push(event),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, [{ type: 'ask_user', interactionId: 'call-test', question: 'Pick one', options: ['A', 'B'], allowFreeText: false, multiple: false }]);

  let statusCode = 200;
  let responseBody;
  const response = {
    status(code) { statusCode = code; return this; },
    json(body) { responseBody = body; return body; },
  };
  await respondHandler({ body: { sessionId: 'session-test', interactionId: 'call-test', answer: 'C' } }, response);
  assert.equal(statusCode, 400);
  assert.equal(responseBody.success, false);

  statusCode = 200;
  await respondHandler({ body: { sessionId: 'session-test', interactionId: 'call-test', answer: 'B' } }, response);
  assert.equal(statusCode, 200);
  assert.deepEqual(responseBody, { success: true });
  assert.equal(await pending, 'B');

  await respondHandler({ body: { sessionId: 'session-test', interactionId: 'call-test', answer: 'B' } }, response);
  assert.equal(statusCode, 404);
  assert.equal(responseBody.success, false);
});

test('agent respond: 多选提交逐项校验,回给模型的是 JSON 数组字符串', async () => {
  let respondHandler;
  const app = {
    get() {},
    delete() {},
    put() {},
    post(route, handler) {
      if (route === '/api/agent/respond') respondHandler = handler;
    }
  };
  registerAgentRoutes({
    app,
    getCurrentProjectPath: () => path.resolve('active-project'),
    configManager: null,
    snapshotter: STUB_SNAPSHOTTER
  });

  const sent = [];
  const pending = waitForAgentAnswer({
    sessionId: 'session-multi',
    interactionId: 'call-multi',
    question: 'Pick some',
    options: ['A', 'B', 'C'],
    allowFreeText: false,
    multiple: true,
    send: event => sent.push(event),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent[0].multiple, true);

  let statusCode = 200;
  let responseBody;
  const response = {
    status(code) { statusCode = code; return this; },
    json(body) { responseBody = body; return body; },
  };

  // 只要有一项不在选项里就整体拒绝
  await respondHandler({ body: { sessionId: 'session-multi', interactionId: 'call-multi', answer: ['A', 'X'] } }, response);
  assert.equal(statusCode, 400);
  assert.equal(responseBody.success, false);

  await respondHandler({ body: { sessionId: 'session-multi', interactionId: 'call-multi', answer: ['A', 'C'] } }, response);
  assert.deepEqual(responseBody, { success: true });
  assert.equal(await pending, '["A","C"]');
});

test('agent chat rejects a cwd that differs from the active server project', async () => {
  let chatHandler;
  const app = {
    get() {},
    delete() {},
    put() {},
    post(route, handler) {
      if (route === '/api/agent/chat') chatHandler = handler;
    }
  };
  const activeCwd = path.resolve('active-project');
  const otherCwd = path.resolve('other-project');
  registerAgentRoutes({
    app,
    getCurrentProjectPath: () => activeCwd,
    configManager: null,
    snapshotter: STUB_SNAPSHOTTER
  });

  let output = '';
  const req = {
    body: { userMessage: 'hello', cwd: otherCwd },
    headers: {},
    socket: { once() {} }
  };
  const res = {
    set() {},
    flushHeaders() {},
    write(chunk) { output += chunk; },
    end() {}
  };

  await chatHandler(req, res);
  assert.match(output, /PROJECT_MISMATCH/);
  assert.match(output, /项目不一致/);
});

// 回归：用户点"停止"（客户端断开连接 → 服务端 abort）后，这条会话仍要落盘。
// 之前中止分支直接 res.end()，磁盘上没有会话文件，前端停止后立刻刷新列表
// 就把左栏这一条整个吞掉了 —— 用户看到的是"一停止任务就没了"。
test('停止(客户端断开)后会话仍要落盘，并带上自动标题与已流出的正文', async () => {
  const activeCwd = path.resolve('active-project');
  let chatHandler;
  const app = {
    get() {},
    delete() {},
    put() {},
    post(route, handler) {
      if (route === '/api/agent/chat') chatHandler = handler;
    }
  };
  registerAgentRoutes({
    app,
    getCurrentProjectPath: () => activeCwd,
    configManager: {
      readRawConfigFile: async () => ({
        models: [{ model: 'test', name: 'T', baseURL: 'https://example.invalid/v1', apiKey: 'k', isDefault: true }]
      })
    },
    snapshotter: STUB_SNAPSHOTTER
  });

  // 模型流：吐一段正文后挂住（模拟"停在生成中"）。真 fetch 在 signal abort 时会打断
  // body 读取，桩里照做才能真的走到中止分支
  const hanging = init => new Response(new ReadableStream({
    start(stream) {
      const bytes = new TextEncoder();
      stream.enqueue(bytes.encode(event({ choices: [{ delta: { content: '已经写了一半' } }] })));
      init?.signal?.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')));
    }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => hanging(init);

  let onSocketClose;
  let output = '';
  let ended = false;
  const req = {
    body: { userMessage: '请列出当前项目的目录结构', cwd: activeCwd },
    headers: {},
    socket: { once(_evt, cb) { onSocketClose = cb; } }
  };
  const res = {
    set() {},
    flushHeaders() {},
    write(chunk) { output += chunk; },
    end() { ended = true; }
  };

  try {
    const route = chatHandler(req, res);
    await waitUntil(() => output.includes('"type":"content"'));
    onSocketClose();
    await route;
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(ended, true, '中止后也要正常收尾');
  const dir = path.join(SANDBOX, '.zen-gitsync', 'agent-sessions');
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 1, '被停止的会话必须落盘，否则左栏这一条会消失');
  const saved = JSON.parse(readFileSync(path.join(dir, files[0]), 'utf-8'));
  assert.equal(saved.title, '请列出当前项目的目录结构');
  const last = saved.messages[saved.messages.length - 1];
  assert.equal(last.role, 'assistant');
  assert.equal(last.content, '已经写了一半');
});

// ── dispatch_task 的注入闸门（2026-09-28）────────────────────────────────
// 主 Agent 控制台改用 g ai 派活之后，这一条守两件事：
//   ① allowDispatch 的对话里，dispatch_task 真的能建出任务，且工具结果说清了
//      "落到哪个项目 / 有没有跑 / 凭什么这么落点" —— 这三句是模型不重复派发、
//      不把"已建任务"说成"已经跑完"的唯一依据；
//   ② 没开 allowDispatch 的入口（智能体页 / 编辑器面板 / CLI）拿到一句明确的
//      unavailable，而不是静默成功或让模型反复重试。
// 派发会写 tasks.json 与 orchestrator.json（HOME 已指向沙箱），所以断言直接读沙箱。
test('dispatch_task：开了 allowDispatch 才注入，且工具结果说清落点与是否执行', async () => {
  const activeCwd = path.resolve('active-project');
  const projDir = mkdtempSync(path.join(SANDBOX, 'proj-dispatch-'));

  let chatHandler;
  const app = {
    get() {},
    delete() {},
    put() {},
    post(route, handler) {
      if (route === '/api/agent/chat') chatHandler = handler;
    }
  };
  registerAgentRoutes({
    app,
    // 派发器用它读全局默认执行器；这个假配置里没有 loadConfig →
    // resolveExecutor 走 catch 回落 claude（正是要测的那条兜底）
    configManager: {
      readRawConfigFile: async () => ({
        models: [{ model: 'test', name: 'T', baseURL: 'https://example.invalid/v1', apiKey: 'k', isDefault: true }]
      })
    },
    getCurrentProjectPath: () => activeCwd,
    snapshotter: STUB_SNAPSHOTTER
  });

  const sse = payload => `data: ${JSON.stringify(payload)}\n\n`;
  const scripted = (chunks) => () => new Response(new ReadableStream({
    start(stream) {
      const bytes = new TextEncoder();
      for (const c of chunks) stream.enqueue(bytes.encode(sse(c)));
      stream.enqueue(bytes.encode('data: [DONE]\n\n'));
      stream.close();
    }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const toolCall = args => scripted([{ choices: [{ delta: { tool_calls: [
    { index: 0, id: 'call_dispatch_1', type: 'function', function: { name: 'dispatch_task', arguments: JSON.stringify(args) } }
  ] } }] }]);
  const text = t => scripted([{ choices: [{ delta: { content: t } }] }]);

  let queue = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => queue.shift()();

  const runChat = async (body) => {
    let output = '';
    const req = { body: { cwd: activeCwd, ...body }, headers: {}, socket: { once() {} } };
    const res = { set() {}, flushHeaders() {}, write: c => { output += c }, end() {} };
    await chatHandler(req, res);
    return output.split('\n').filter(l => l.trim().startsWith('data:'))
      .map(l => { try { return JSON.parse(l.trim().slice(5)) } catch { return null } })
      .filter(Boolean);
  };

  const dataDir = path.join(SANDBOX, '.zen-gitsync');
  const readTasks = () => {
    try { return JSON.parse(readFileSync(path.join(dataDir, 'tasks.json'), 'utf-8')).tasks || [] } catch { return [] }
  };
  const before = readTasks().length;

  try {
    // ① 控制台：allowDispatch + 显式落点 + auto_run=false（只建不跑，
    //    单测里绝不 spawn 本机真实的 claude）
    queue = [
      toolCall({ text: '给路由层补一组单测', project_path: projDir, auto_run: false }),
      text('已经派给本地执行器了。')
    ];
    const events1 = await runChat({ userMessage: '把补单测这件事派出去', allowDispatch: true, dispatchExecutor: 'codex' });

    const start1 = events1.find(e => e.type === 'tool_call_start' && e.name === 'dispatch_task');
    assert.ok(start1, '开了 allowDispatch 就该看到 dispatch_task 的工具调用');
    const result1 = events1.find(e => e.type === 'tool_result' && e.name === 'dispatch_task');
    assert.match(result1.result, /已派发/);
    assert.match(result1.result, /没有开始执行/);
    assert.match(result1.result, /派发时显式指定了项目/, '落点依据要写给模型看');
    assert.match(result1.result, /taskId=/);

    const tasks = readTasks();
    assert.equal(tasks.length, before + 1);
    const created = tasks[tasks.length - 1];
    assert.equal(created.projectPath, projDir);
    assert.equal(created.desc, '给路由层补一组单测');

    const state = JSON.parse(readFileSync(path.join(dataDir, 'orchestrator.json'), 'utf-8'));
    const record = state.instructions[state.instructions.length - 1];
    assert.equal(record.taskId, created.id);
    assert.equal(record.status, 'created', 'auto_run=false 时只建任务');
    assert.equal(record.targetSource, 'explicit');

    // ② 同一个端点、不带 allowDispatch：工具仍在那张表里，但注入是关的 →
    //    必须回一句明确的 unavailable，且不得建出任何任务
    queue = [
      toolCall({ text: '这条不该被派出去', project_path: projDir }),
      text('我没法在这里派发。')
    ];
    const events2 = await runChat({ userMessage: '派一条给别的 agent 试试' });
    const result2 = events2.find(e => e.type === 'tool_result' && e.name === 'dispatch_task');
    assert.match(result2.result, /只在 g ui 的「主 Agent 控制台」/);
    assert.equal(readTasks().length, before + 1, '没开闸门的入口不该建任务');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

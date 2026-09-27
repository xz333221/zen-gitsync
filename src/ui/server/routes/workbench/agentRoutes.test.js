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

const event = data => `data: ${JSON.stringify(data)}\n\n`;

// 轮询等待条件成立（SSE 是边跑边写出来的，没有可 await 的句柄）
async function waitUntil(check, timeoutMs = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

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
    configManager: null
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
    configManager: null
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
    configManager: null
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
    }
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createPeerApp } from './server.js';

const SELF = { id: 'node-abc12345', name: '这台电脑', avatar: '', token: 'k'.repeat(64) };

/**
 * 造一个 app：会话表用**内存版**注入。
 * 不注入就会落到真实 <DATA_DIR>/peers.json —— 单测不许写用户的真实数据目录。
 */
function makeApp(opts = {}) {
  const sessions = new Map();
  const app = createPeerApp({
    self: SELF,
    getLocalPort: () => 1234,
    getSession: async (k) => sessions.get(k) || '',
    setSession: async (k, v) => { sessions.set(k, v); },
    ...opts
  });
  return { app, sessions };
}

/** 在随机端口起一个 app，返回 { url, close }。 */
async function serve(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test('没有令牌 / 令牌错都是 401，且不回显令牌', async () => {
  const { app } = makeApp();
  const { url, close } = await serve(app);
  try {
    const noAuth = await fetch(`${url}/api/peer/info`);
    assert.equal(noAuth.status, 401);
    const body = await noAuth.json();
    assert.equal(body.ok, false);
    assert.ok(!JSON.stringify(body).includes(SELF.token));

    const wrong = await fetch(`${url}/api/peer/info`, { headers: { Authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);
  } finally {
    await close();
  }
});

test('info 带令牌可读，且不返回项目清单/路径', async () => {
  const { app } = makeApp({ getVersion: () => '2.18.27' });
  const { url, close } = await serve(app);
  try {
    const res = await fetch(`${url}/api/peer/info`, { headers: { Authorization: `Bearer ${SELF.token}` } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.id, SELF.id);
    assert.equal(data.version, '2.18.27');
    assert.deepEqual(data.capabilities, ['ask']);
    assert.equal(data.projects, undefined, '这一层不该暴露项目清单');
  } finally {
    await close();
  }
});

test('ask 走注入的执行器，并把问题原样交过去', async () => {
  let seen = null;
  const { app } = makeApp({
    ask: async (args) => {
      seen = args;
      return { answer: '我这边有 3 个项目', sessionId: 'sess-9', ms: 42 };
    }
  });
  const { url, close } = await serve(app);
  try {
    const res = await fetch(`${url}/api/peer/ask`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SELF.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '你那边有哪些项目？', from: 'node-remote1' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.answer, '我这边有 3 个项目');
    assert.equal(data.sessionId, 'sess-9');
    assert.equal(seen.question, '你那边有哪些项目？');
    assert.equal(seen.from, 'node-remote1');
  } finally {
    await close();
  }
});

test('同一提问方第二问带上第一问的会话 id（上下文不串、不丢）', async () => {
  const seenSessions = [];
  const { app, sessions } = makeApp({
    ask: async ({ sessionId }) => {
      seenSessions.push(sessionId);
      return { answer: 'ok', sessionId: sessionId || `sess-${seenSessions.length}`, ms: 1 };
    }
  });
  const { url, close } = await serve(app);
  const headers = { Authorization: `Bearer ${SELF.token}`, 'Content-Type': 'application/json' };
  try {
    await fetch(`${url}/api/peer/ask`, { method: 'POST', headers, body: JSON.stringify({ question: '第一问', from: 'node-a' }) });
    await fetch(`${url}/api/peer/ask`, { method: 'POST', headers, body: JSON.stringify({ question: '第二问', from: 'node-a' }) });
    assert.deepEqual(seenSessions, ['', 'sess-1']);
    assert.equal(sessions.get('in:node-a'), 'sess-1');
  } finally {
    await close();
  }
});

test('ask 空问题 400、超长 413', async () => {
  const { app } = makeApp({ ask: async () => ({ answer: 'x', sessionId: '', ms: 0 }) });
  const { url, close } = await serve(app);
  const headers = { Authorization: `Bearer ${SELF.token}`, 'Content-Type': 'application/json' };
  try {
    const empty = await fetch(`${url}/api/peer/ask`, { method: 'POST', headers, body: JSON.stringify({ question: '   ' }) });
    assert.equal(empty.status, 400);

    const long = await fetch(`${url}/api/peer/ask`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ question: 'x'.repeat(5000) })
    });
    assert.equal(long.status, 413);
  } finally {
    await close();
  }
});

test('执行器抛错时报 502 且带错误文案', async () => {
  const { app } = makeApp({ ask: async () => { throw new Error('模型不可用'); } });
  const { url, close } = await serve(app);
  try {
    const res = await fetch(`${url}/api/peer/ask`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SELF.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '在吗' })
    });
    assert.equal(res.status, 502);
    const data = await res.json();
    assert.match(data.error, /模型不可用/);
  } finally {
    await close();
  }
});

test('未知路径 404 且是 JSON（不暴露技术栈）', async () => {
  const { app } = makeApp();
  const { url, close } = await serve(app);
  try {
    const res = await fetch(`${url}/api/exec`, { headers: { Authorization: `Bearer ${SELF.token}` } });
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    assert.equal(res.headers.get('x-powered-by'), null);
  } finally {
    await close();
  }
});

/** 轮询等待条件成立（SSE / 连接断开没有可 await 的句柄） */
async function waitUntil(check, timeoutMs = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// 回归（2026-11-09 跨机器 ask_peer 一直回 SESSION_BUSY）：
//
// 本机工具层 ask_peer 有 150s 上限，到点只是"本地不等了"，跨机器那一跳还挂着。
// 对端会把这一轮跑到底，会话闸一直占着固定的 `in:<from>` key —— 后续每次提问
// 都在 1~2 秒内回 SESSION_BUSY。修法不是让本地无限等，而是**断开就把对端这一轮
// 掐掉**：提问方断开 → 这里 abort → localAsk 掐断环回 /api/agent/chat → 那一轮
// 中止并释放闸。
test('提问方断开时，/api/peer/ask 必须中止本机这一轮', async () => {
  let runnerSignal = null;
  let aborted = false;
  const { app } = makeApp({
    ask: ({ signal }) => new Promise((resolve, reject) => {
      runnerSignal = signal;
      signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('caller gone'));
      }, { once: true });
    })
  });
  const { url, close } = await serve(app);
  const controller = new AbortController();
  try {
    const pending = fetch(`${url}/api/peer/ask`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SELF.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '在吗', from: 'node-gone' }),
      signal: controller.signal
    }).catch((err) => err);

    await waitUntil(() => runnerSignal);
    assert.equal(runnerSignal.aborted, false, '提问方还在，这一轮不该被掐');

    controller.abort();
    await pending;
    await waitUntil(() => aborted);
    assert.equal(runnerSignal.aborted, true, '提问方断开必须把这个信号打给本机那一轮');
  } finally {
    await close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { registerAgentRoutes, waitForAgentAnswer } from './agentRoutes.js';

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
  assert.deepEqual(sent, [{ type: 'ask_user', interactionId: 'call-test', question: 'Pick one', options: ['A', 'B'], allowFreeText: false }]);

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

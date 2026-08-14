import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { registerAgentRoutes } from './agentRoutes.js';

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

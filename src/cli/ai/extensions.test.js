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
// 扩展层的接线测试 —— 这一层最容易"看起来接好了但实际没生效":
//   · transport 有没有把 MCP 工具塞进请求体
//   · turn 有没有按名字把 mcp__ 调用分给扩展,而不是丢给内置工具表(结果是"未知工具")
//   · 没装扩展时行为必须与改动前完全一致(不能因为引入扩展而改变默认请求)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamChatOnce } from './transport.js';
import { runAgentTurn } from './turn.js';
import { AgentExtensions } from './extensions.js';
import { TOOL_DEFINITIONS } from './tools.js';

const model = { model: 'test', baseURL: 'https://example.invalid/v1', apiKey: 'test' };
const event = data => `data: ${JSON.stringify(data)}\n\n`;
const response = chunks => new Response(new ReadableStream({ start(controller) {
  const bytes = new TextEncoder();
  chunks.forEach(chunk => controller.enqueue(bytes.encode(chunk)));
  controller.close();
} }));
const noop = () => {};
const quiet = {
  startSpinner: () => ({ stop: noop }),
  createAssistantWriter: () => ({ writeContent: noop, writeThinking: noop, finish: noop }),
  printToolHeader: noop, printToolResult: noop, printWarn: noop, printError: noop, printTurnSummary: noop,
};
const strings = new Proxy({}, { get: () => (typeof value === 'string' ? value : String), has: () => true });
const newState = () => ({ messages: [{ role: 'system', content: 'rules' }], ctx: { cwd: '.' }, abortController: new AbortController(), maxToolIterations: 4 });
const toolCall = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } });

// 一个只认 mcp__ 前缀的假扩展,用来观察分流。
// 刻意用鸭子类型而不是继承 AgentExtensions —— 这样顺带钉住
// "turn.js 只依赖 { owns, execute, tools } 这套接口",换实现不会被测试绑死。
function fakeExtensions({ tools = [], calls = [] } = {}) {
  return {
    tools,
    owns: name => name.startsWith('mcp__'),
    execute: async (name, args) => { calls.push({ name, args }); return `mcp-result:${name}`; },
    promptSuffix: () => '\n\n# 已接入的 MCP 服务\n- fake: 1 个工具',
    close: async () => {},
  };
}

test('transport: 没有扩展工具时请求体与改动前完全一致(不含空 tools 数组)', async () => {
  let sent;
  await streamChatOnce({ model, messages: [], fetchFn: async (_url, init) => {
    sent = JSON.parse(init.body);
    return response([event({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }), 'data: [DONE]']);
  } });
  assert.deepEqual(sent.tools, TOOL_DEFINITIONS);

  // 显式传空数组也不能退化
  await streamChatOnce({ model, messages: [], extraTools: [], fetchFn: async (_url, init) => {
    sent = JSON.parse(init.body);
    return response([event({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }), 'data: [DONE]']);
  } });
  assert.deepEqual(sent.tools, TOOL_DEFINITIONS);
});

test('transport: 扩展工具叠加在内置工具之后,内置工具不被挤掉', async () => {
  let sent;
  const extra = [{ type: 'function', function: { name: 'mcp__fake__echo', description: 'x', parameters: { type: 'object' } } }];
  await streamChatOnce({ model, messages: [], extraTools: extra, fetchFn: async (_url, init) => {
    sent = JSON.parse(init.body);
    return response([event({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }), 'data: [DONE]']);
  } });

  const names = sent.tools.map(tool => tool.function.name);
  assert.deepEqual(names.slice(0, TOOL_DEFINITIONS.length), TOOL_DEFINITIONS.map(tool => tool.function.name));
  assert.equal(names.at(-1), 'mcp__fake__echo');
  assert.equal(names.length, TOOL_DEFINITIONS.length + 1);
});

test('turn: mcp__ 调用被分给扩展,普通工具名仍走内置执行器', async () => {
  const calls = [];
  const extensions = fakeExtensions({ calls });
  const executed = [];
  const s = { ...newState(), extensions };
  let round = 0;

  const stats = await runAgentTurn(s, 'task', strings, [], {
    ui: quiet,
    execute: async name => { executed.push(name); return 'builtin-result'; },
    chat: async () => {
      round++;
      if (round === 1) return { content: '', toolCalls: [toolCall('a', 'mcp__fake__echo'), toolCall('b', 'read_file')] };
      return { content: 'done', toolCalls: [] };
    },
  });

  assert.equal(stats.status, 'completed');
  assert.deepEqual(calls.map(item => item.name), ['mcp__fake__echo'], 'MCP 工具必须走扩展');
  assert.deepEqual(executed, ['read_file'], '内置工具不能被扩展层截胡');

  const toolMessages = s.messages.filter(message => message.role === 'tool').map(message => message.content);
  assert.deepEqual(toolMessages, ['mcp-result:mcp__fake__echo', 'builtin-result']);
});

test('turn: 扩展未接管的名字会回落到内置执行器(而不是报未知工具)', async () => {
  const extensions = new AgentExtensions({ skills: [] });
  const s = { ...newState(), extensions };
  const executed = [];
  let round = 0;

  await runAgentTurn(s, 'task', strings, [], {
    ui: quiet,
    execute: async name => { executed.push(name); return 'ok'; },
    chat: async () => (++round === 1 ? { content: '', toolCalls: [toolCall('a', 'list_files')] } : { content: 'done', toolCalls: [] }),
  });

  assert.deepEqual(executed, ['list_files']);
});

test('turn: 传了 extensions 但没有工具时,chat 收到的 extraTools 是空数组', async () => {
  const s = { ...newState(), extensions: new AgentExtensions({ skills: [] }) };
  const seen = [];
  let round = 0;
  await runAgentTurn(s, 'task', strings, [], {
    ui: quiet,
    chat: async payload => {
      seen.push(payload.extraTools);
      return ++round === 1 ? { content: 'hi', toolCalls: [] } : { content: '', toolCalls: [] };
    },
  });
  assert.deepEqual(seen, [[]]);
});

test('AgentExtensions: 没有任何扩展时 promptSuffix 为空串、tools 为空', () => {
  const extensions = new AgentExtensions({ skills: [] });
  assert.equal(extensions.promptSuffix('zh-CN'), '');
  assert.deepEqual(extensions.tools, []);
  assert.equal(extensions.owns('read_file'), false);
  assert.equal(extensions.promptSuffix('en-US'), '');
});

test('AgentExtensions: skill 与 MCP 的提示词片段拼接顺序稳定,并带 locale 区分', () => {
  const mcp = { describe: ({ locale }) => (String(locale).startsWith('en') ? '\n\n# Connected MCP servers\n- x' : '\n\n# 已接入的 MCP 服务\n- x') };
  const extensions = new AgentExtensions({
    skills: [{ id: 'a', name: 'pdf', description: 'd', file: '/x/SKILL.md', scope: 'global' }],
    mcp,
  });
  const zh = extensions.promptSuffix('zh-CN');
  assert.ok(zh.indexOf('已安装的 Skill') < zh.indexOf('已接入的 MCP 服务'), 'skill 片段应在 MCP 片段之前');
  assert.match(extensions.promptSuffix('en'), /Connected MCP servers/);
});

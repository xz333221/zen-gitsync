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
// src/utils/aiEndpoint.js 单元测试(node:test 内置)。
//
// 这一层是为了修「生成提交信息报 Request is missing x-opencode-session」而抽出来的，
// 所以用测试把三件事钉死：
//   1) 只对 OpenCode 网关加 x-opencode-session，别的 provider 不加（避免污染第三方请求）
//   2) 请求头里必须有自己的客户端名字（User-Agent 不能是 node-fetch/undici）
//   3) OpenCode / Command Code 网关上非 chat 协议族的模型要**明确报错**，不能把 OpenAI
//      body 打错路由（两家网关的协议族识别与伪装域名都要各自钉死）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AI_USER_AGENT,
  COMMAND_CODE_URL,
  OPENCODE_GO_URL,
  buildAiApiRequest,
  buildAiChatRequest,
  commandCodeFamily,
  describeAiHttpError,
  isCommandCodeGateway,
  isOpenCodeGateway,
  normalizeBaseURL,
  openCodeGoFamily,
  processAiSessionId,
} from './aiEndpoint.js'

const GO = 'https://opencode.ai/zen/go/v1'
const CC = 'https://api.commandcode.ai/provider/v1'

// ========== normalizeBaseURL ==========

test('normalizeBaseURL: 去掉尾部斜杠并 trim', () => {
  assert.equal(normalizeBaseURL('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1')
  assert.equal(normalizeBaseURL('  https://api.deepseek.com/v1//  '), 'https://api.deepseek.com/v1')
  assert.equal(normalizeBaseURL(''), '')
  assert.equal(normalizeBaseURL(undefined), '')
})

// ========== isOpenCodeGateway ==========

test('isOpenCodeGateway: 识别 opencode.ai 及其子域', () => {
  assert.equal(isOpenCodeGateway(GO), true)
  assert.equal(isOpenCodeGateway('https://opencode.ai/zen/go/v1/'), true)
  assert.equal(isOpenCodeGateway('https://api.opencode.ai/v1'), true)
  assert.equal(isOpenCodeGateway('https://api.deepseek.com/v1'), false)
  // 不能被"看起来像"的域名骗到（endsWith 判断容易踩）
  assert.equal(isOpenCodeGateway('https://evil-opencode.ai.attacker.com/v1'), false)
  assert.equal(isOpenCodeGateway('not-a-url'), false)
  assert.equal(isOpenCodeGateway(''), false)
})

// ========== openCodeGoFamily ==========

test('openCodeGoFamily: 三种协议族与默认 chat', () => {
  assert.equal(openCodeGoFamily('deepseek-v4.1-flash'), 'chat')
  assert.equal(openCodeGoFamily('glm-5.3'), 'chat')
  assert.equal(openCodeGoFamily('minimax-m3'), 'messages')
  assert.equal(openCodeGoFamily('qwen3.8-max'), 'messages')
  assert.equal(openCodeGoFamily('grok-4.6'), 'responses')
  assert.equal(openCodeGoFamily('gpt-5.6-luna'), 'responses')
  // 大小写/空格容错
  assert.equal(openCodeGoFamily(' MiniMax-M3 '), 'messages')
  // 未知/新增模型一律按 chat：网关以后加 chat 模型不需要同步改代码
  assert.equal(openCodeGoFamily('brand-new-model'), 'chat')
  assert.equal(openCodeGoFamily(''), 'chat')
})

// ========== isCommandCodeGateway ==========

test('isCommandCodeGateway: 识别 commandcode.ai 及其子域', () => {
  assert.equal(isCommandCodeGateway(CC), true)
  assert.equal(isCommandCodeGateway('https://api.commandcode.ai/provider/v1/'), true)
  assert.equal(isCommandCodeGateway('https://commandcode.ai/api'), true)
  assert.equal(isCommandCodeGateway('https://api.deepseek.com/v1'), false)
  // 伪装域名不能被当成官方入口
  assert.equal(isCommandCodeGateway('https://evil-commandcode.ai.attacker.com/v1'), false)
  assert.equal(isCommandCodeGateway('not-a-url'), false)
  assert.equal(isCommandCodeGateway(''), false)
})

// ========== commandCodeFamily ==========

test('commandCodeFamily: claude-* 走 messages，其余默认 chat', () => {
  assert.equal(commandCodeFamily('claude-sonnet-5'), 'messages')
  assert.equal(commandCodeFamily('claude-opus-5-5'), 'messages')
  // 大小写/空格容错
  assert.equal(commandCodeFamily(' Claude-Haiku-5-5 '), 'messages')
  assert.equal(commandCodeFamily('moonshotai/Kimi-K3'), 'chat')
  assert.equal(commandCodeFamily('deepseek/deepseek-v4-flash'), 'chat')
  assert.equal(commandCodeFamily('inclusionai/ling-3.1-flash:free'), 'chat')
  assert.equal(commandCodeFamily(''), 'chat')
})

// ========== buildAiChatRequest ==========

test('buildAiChatRequest: 普通 provider 拼 url + Bearer，不带 opencode 会话头', () => {
  const { url, headers } = buildAiChatRequest({
    baseURL: 'https://api.deepseek.com/v1/',
    model: 'deepseek-chat',
    apiKey: 'sk-abc',
  })
  assert.equal(url, 'https://api.deepseek.com/v1/chat/completions')
  assert.equal(headers['Content-Type'], 'application/json')
  assert.equal(headers['Authorization'], 'Bearer sk-abc')
  assert.equal(headers['User-Agent'], AI_USER_AGENT)
  assert.ok(!('x-opencode-session' in headers), '非 OpenCode 网关不应带 x-opencode-session')
})

test('buildAiChatRequest: OpenCode Go + chat 模型带上客户端身份与会话 ID', () => {
  const { url, headers } = buildAiChatRequest({
    baseURL: GO,
    model: 'deepseek-v4.1-flash',
    apiKey: 'sk-go',
  })
  assert.equal(url, `${OPENCODE_GO_URL}/chat/completions`)
  assert.equal(headers['Authorization'], 'Bearer sk-go')
  assert.ok(headers['x-opencode-session'], '缺少 x-opencode-session 会被网关拒绝')
  // 网关要求"用自己的名字"当 UA，通用库名（node-fetch/undici）会命中风控
  assert.match(headers['User-Agent'], /^zen-gitsync\/\d+\.\d+\.\d+$/)
})

test('buildAiChatRequest: 省略 sessionId 时同进程内保持稳定（吃提示缓存）', () => {
  const a = buildAiChatRequest({ baseURL: GO, model: 'deepseek-v4.1-flash', apiKey: 'k' })
  const b = buildAiChatRequest({ baseURL: GO, model: 'deepseek-v4.1-flash', apiKey: 'k' })
  assert.equal(a.headers['x-opencode-session'], b.headers['x-opencode-session'])
  assert.equal(a.headers['x-opencode-session'], processAiSessionId())
})

test('buildAiChatRequest: 显式 sessionId 覆盖进程级兜底（对话级复用）', () => {
  const { headers } = buildAiChatRequest({
    baseURL: GO,
    model: 'deepseek-v4.1-flash',
    apiKey: 'k',
    sessionId: 'session-42',
  })
  assert.equal(headers['x-opencode-session'], 'session-42')
})

test('buildAiChatRequest: OpenCode Go 上非 chat 协议族的模型直接给可读报错', () => {
  assert.throws(
    () => buildAiChatRequest({ baseURL: GO, model: 'minimax-m3', apiKey: 'k' }),
    /minimax-m3.*Anthropic.*\/messages.*换一个/
  )
  assert.throws(
    () => buildAiChatRequest({ baseURL: GO, model: 'grok-4.6', apiKey: 'k' }),
    /grok-4\.6.*\/responses/
  )
})

test('buildAiChatRequest: Command Code + chat 模型拼 url，且不该带 opencode 会话头', () => {
  const { url, headers } = buildAiChatRequest({
    baseURL: CC,
    model: 'moonshotai/Kimi-K3',
    apiKey: 'user_abc',
  })
  assert.equal(url, `${COMMAND_CODE_URL}/chat/completions`)
  assert.equal(headers['Authorization'], 'Bearer user_abc')
  // Command Code 只认 Bearer，别误判成 OpenCode 网关往上加会话头
  assert.ok(!('x-opencode-session' in headers), 'Command Code 不需要 x-opencode-session')
})

test('buildAiChatRequest: Command Code 上 claude-* 只能走 /messages，直接给可读报错', () => {
  assert.throws(
    () => buildAiChatRequest({ baseURL: CC, model: 'claude-sonnet-5', apiKey: 'k' }),
    /claude-sonnet-5.*Anthropic.*\/messages.*换一个/
  )
})

test('buildAiChatRequest: 无 apiKey 不发 Authorization，extraHeaders 可覆盖默认头', () => {
  const { headers } = buildAiChatRequest({
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    extraHeaders: { 'X-Trace': '1' },
  })
  assert.ok(!('Authorization' in headers))
  assert.equal(headers['X-Trace'], '1')
})

test('buildAiChatRequest: 缺 baseURL 时明确报错（而不是拼出 /chat/completions）', () => {
  assert.throws(() => buildAiChatRequest({ model: 'm' }), /baseURL/)
})

// ========== buildAiApiRequest ==========

test('buildAiApiRequest: 拼 /models 并同样带身份头', () => {
  const { url, headers } = buildAiApiRequest({ baseURL: GO + '/', path: '/models', apiKey: 'k' })
  assert.equal(url, `${OPENCODE_GO_URL}/models`)
  assert.equal(headers['Authorization'], 'Bearer k')
  assert.ok(headers['x-opencode-session'])
  assert.ok(headers['User-Agent'])
})

// ========== describeAiHttpError ==========

test('describeAiHttpError: 抽 error.message，抽不到才退回原文', () => {
  assert.equal(
    describeAiHttpError(JSON.stringify({
      error: {
        message: 'Request is missing x-opencode-session and cannot be routed efficiently.',
        code: 'HTTP_ERR',
      },
    }), 400),
    'Request is missing x-opencode-session and cannot be routed efficiently.'
  )
  assert.equal(describeAiHttpError('{"error":"boom"}', 500), 'boom')
  assert.equal(describeAiHttpError('{"message":"boom"}', 500), 'boom')
  assert.equal(describeAiHttpError('plain failure', 500), 'plain failure')
  assert.equal(describeAiHttpError('', 502), 'HTTP 502')
  // 超长原文截断，不把整页 HTML 甩到界面上
  const long = 'x'.repeat(500)
  assert.equal(describeAiHttpError(long, 500).length, 301)
})

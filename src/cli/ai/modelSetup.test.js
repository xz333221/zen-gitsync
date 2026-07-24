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
// src/cli/ai/modelSetup.js 的单元测试。
// 覆盖纯函数:getBuiltinModels / findProviderByUrl / validateEndpoint /
// buildModelConfig / testModelConnection(注入 mock fetch)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getBuiltinModels,
  findProviderByUrl,
  validateEndpoint,
  buildModelConfig,
  testModelConnection,
  PROVIDERS,
  BUILTIN_MODELS,
} from './modelSetup.js'

// ── getBuiltinModels ──────────────────────────

test('getBuiltinModels: 已知 baseURL 返回模型列表', () => {
  const models = getBuiltinModels('https://api.deepseek.com/v1')
  assert.ok(Array.isArray(models))
  assert.ok(models.length > 0)
  assert.ok(models.includes('deepseek-chat'))
})

test('getBuiltinModels: 尾斜杠的 baseURL 也能匹配', () => {
  const a = getBuiltinModels('https://api.deepseek.com/v1')
  const b = getBuiltinModels('https://api.deepseek.com/v1/')
  assert.deepEqual(a, b)
})

test('getBuiltinModels: 未知 baseURL 返回空数组', () => {
  assert.deepEqual(getBuiltinModels('https://example.com/v1'), [])
})

test('getBuiltinModels: null / undefined / 空字符串 返回空数组', () => {
  assert.deepEqual(getBuiltinModels(null), [])
  assert.deepEqual(getBuiltinModels(undefined), [])
  assert.deepEqual(getBuiltinModels(''), [])
  assert.deepEqual(getBuiltinModels(123), [])
})

// ── findProviderByUrl ─────────────────────────

test('findProviderByUrl: 已知 URL 返回 provider 对象', () => {
  const p = findProviderByUrl('https://api.openai.com/v1')
  assert.ok(p)
  assert.equal(p.id, 'openai')
  assert.equal(p.label, 'OpenAI')
})

test('findProviderByUrl: 尾斜杠的 URL 也能匹配', () => {
  const p = findProviderByUrl('https://api.openai.com/v1/')
  assert.ok(p)
  assert.equal(p.id, 'openai')
})

test('findProviderByUrl: 未知 URL 返回 null', () => {
  assert.equal(findProviderByUrl('https://example.com/v1'), null)
})

test('findProviderByUrl: null / undefined 返回 null', () => {
  assert.equal(findProviderByUrl(null), null)
  assert.equal(findProviderByUrl(undefined), null)
  assert.equal(findProviderByUrl(''), null)
})

test('findProviderByUrl: 每个预设都能被找到', () => {
  for (const p of PROVIDERS) {
    const found = findProviderByUrl(p.url)
    assert.ok(found, `应能找到 provider: ${p.id}`)
    assert.equal(found.id, p.id)
  }
})

// ── validateEndpoint ──────────────────────────

test('validateEndpoint: 合法 https URL', () => {
  assert.equal(validateEndpoint('https://api.openai.com/v1'), true)
  assert.equal(validateEndpoint('https://example.com'), true)
})

test('validateEndpoint: 合法 http URL', () => {
  assert.equal(validateEndpoint('http://localhost:11434/v1'), true)
  assert.equal(validateEndpoint('http://192.168.1.1:8080'), true)
})

test('validateEndpoint: 非法协议(ftp)返回 false', () => {
  assert.equal(validateEndpoint('ftp://example.com'), false)
})

test('validateEndpoint: 无协议返回 false', () => {
  assert.equal(validateEndpoint('example.com'), false)
  assert.equal(validateEndpoint('api.openai.com/v1'), false)
})

test('validateEndpoint: null / undefined / 空字符串返回 false', () => {
  assert.equal(validateEndpoint(null), false)
  assert.equal(validateEndpoint(undefined), false)
  assert.equal(validateEndpoint(''), false)
})

// ── buildModelConfig ──────────────────────────

test('buildModelConfig: 基本构建', () => {
  const m = buildModelConfig({
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: 'sk-test',
    name: 'My DeepSeek',
    isDefault: true,
  })
  assert.equal(m.model, 'deepseek-chat')
  assert.equal(m.name, 'My DeepSeek')
  assert.equal(m.baseURL, 'https://api.deepseek.com/v1')
  assert.equal(m.apiKey, 'sk-test')
  assert.equal(m.isDefault, true)
  assert.ok(m.id, 'id 不应为空')
  assert.match(m.id, /^model-/, 'id 应以 model- 开头')
})

test('buildModelConfig: 不传 name 时默认用 model 名', () => {
  const m = buildModelConfig({
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o',
  })
  assert.equal(m.name, 'gpt-4o')
})

test('buildModelConfig: name 为空白时默认用 model 名', () => {
  const m = buildModelConfig({
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    name: '   ',
  })
  assert.equal(m.name, 'gpt-4o')
})

test('buildModelConfig: baseURL 去尾斜杠', () => {
  const m = buildModelConfig({
    baseURL: 'https://api.openai.com/v1/',
    model: 'gpt-4o',
  })
  assert.equal(m.baseURL, 'https://api.openai.com/v1')
})

test('buildModelConfig: isDefault 默认 false', () => {
  const m = buildModelConfig({
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o',
  })
  assert.equal(m.isDefault, false)
})

test('buildModelConfig: apiKey 为空时存空字符串', () => {
  const m = buildModelConfig({
    baseURL: 'http://localhost:11434/v1',
    model: 'llama3',
  })
  assert.equal(m.apiKey, '')
})

test('buildModelConfig: id 包含 name 的 slug 化形式', () => {
  const m = buildModelConfig({
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    name: 'GPT 4o Mini!',
  })
  // name 中的非 a-z0-9 字符被替换为 -
  assert.match(m.id, /^model-gpt-4o-mini-/)
})

// ── testModelConnection ───────────────────────
// 注入 mock fetch 避免真实网络请求

function mockFetch({ status = 200, ok = true, body = {} } = {}) {
  return async (url, opts) => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })
}

test('testModelConnection: 200 成功', async () => {
  const result = await testModelConnection({
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: 'sk-test',
    fetchFn: mockFetch({ status: 200, ok: true }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.status, 200)
})

test('testModelConnection: 400 也视为成功(连接通的)', async () => {
  const result = await testModelConnection({
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    fetchFn: mockFetch({ status: 400, ok: false }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.status, 400)
})

test('testModelConnection: 401 API Key 无效', async () => {
  const result = await testModelConnection({
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: 'sk-bad',
    fetchFn: mockFetch({ status: 401, ok: false }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 401)
  assert.match(result.message, /401/)
})

test('testModelConnection: 404 模型不存在', async () => {
  const result = await testModelConnection({
    baseURL: 'https://api.deepseek.com/v1',
    model: 'nonexistent',
    fetchFn: mockFetch({ status: 404, ok: false }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 404)
  assert.match(result.message, /404/)
})

test('testModelConnection: 500 服务器错误', async () => {
  const result = await testModelConnection({
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    fetchFn: mockFetch({ status: 500, ok: false }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 500)
  assert.match(result.message, /500/)
})

test('testModelConnection: AbortError 返回超时消息', async () => {
  const abortFetch = async () => {
    const err = new Error('aborted')
    err.name = 'AbortError'
    throw err
  }
  const result = await testModelConnection({
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    fetchFn: abortFetch,
    timeoutMs: 100,
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /超时|timeout/i)
})

test('testModelConnection: 网络错误返回失败消息', async () => {
  const failFetch = async () => {
    throw new Error('ECONNREFUSED')
  }
  const result = await testModelConnection({
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    fetchFn: failFetch,
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /ECONNREFUSED|连接失败/)
})

test('testModelConnection: baseURL 尾斜杠被正确处理', async () => {
  let calledUrl = ''
  const spyFetch = async (url) => {
    calledUrl = url
    return { ok: true, status: 200, json: async () => ({}) }
  }
  await testModelConnection({
    baseURL: 'https://api.deepseek.com/v1/',
    model: 'deepseek-chat',
    fetchFn: spyFetch,
  })
  // 尾斜杠被去掉,不产生双斜杠
  assert.equal(calledUrl, 'https://api.deepseek.com/v1/chat/completions')
})

test('testModelConnection: 无 apiKey 时不发 Authorization 头', async () => {
  let calledHeaders = {}
  const spyFetch = async (url, opts) => {
    calledHeaders = opts.headers
    return { ok: true, status: 200, json: async () => ({}) }
  }
  await testModelConnection({
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: '',
    fetchFn: spyFetch,
  })
  assert.ok(!calledHeaders['Authorization'], '无 apiKey 时不应有 Authorization 头')
  assert.equal(calledHeaders['Content-Type'], 'application/json')
})

test('testModelConnection: 有 apiKey 时发 Bearer token', async () => {
  let calledHeaders = {}
  const spyFetch = async (url, opts) => {
    calledHeaders = opts.headers
    return { ok: true, status: 200, json: async () => ({}) }
  }
  await testModelConnection({
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: 'sk-abc123',
    fetchFn: spyFetch,
  })
  assert.equal(calledHeaders['Authorization'], 'Bearer sk-abc123')
})

// ── 数据完整性 ────────────────────────────────

test('PROVIDERS: 至少有 16 个预设', () => {
  assert.ok(PROVIDERS.length >= 16)
})

test('PROVIDERS: 每个预设有 id / label / url', () => {
  for (const p of PROVIDERS) {
    assert.ok(p.id, `provider 缺少 id: ${JSON.stringify(p)}`)
    assert.ok(p.label, `provider 缺少 label: ${JSON.stringify(p)}`)
    assert.ok(p.url, `provider 缺少 url: ${JSON.stringify(p)}`)
    assert.ok(validateEndpoint(p.url), `provider url 不合法: ${p.url}`)
  }
})

test('BUILTIN_MODELS: 每个 baseURL 都对应一个非空数组', () => {
  for (const [url, models] of Object.entries(BUILTIN_MODELS)) {
    assert.ok(Array.isArray(models), `BUILTIN_MODELS[${url}] 应为数组`)
    assert.ok(models.length > 0, `BUILTIN_MODELS[${url}] 不应为空`)
    for (const m of models) {
      assert.equal(typeof m, 'string', `模型名应为字符串: ${m}`)
      assert.ok(m.length > 0, `模型名不应为空`)
    }
  }
})

test('BUILTIN_MODELS: 每个 key 都能在 PROVIDERS 中找到', () => {
  const providerUrls = new Set(PROVIDERS.map(p => p.url))
  for (const url of Object.keys(BUILTIN_MODELS)) {
    assert.ok(providerUrls.has(url), `BUILTIN_MODELS 的 key "${url}" 不在 PROVIDERS 中`)
  }
})

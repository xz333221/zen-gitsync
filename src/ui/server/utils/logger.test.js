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

import { test } from 'node:test'
import assert from 'node:assert/strict'
import logger, { redact, SENSITIVE_KEYS } from './logger.js'

test('redact: 命中已知敏感 key → 值变 [REDACTED]', () => {
  assert.equal(redact({ apiKey: 'sk-12345' }).apiKey, '[REDACTED]')
  assert.equal(redact({ token: 'tok-abc' }).token, '[REDACTED]')
  assert.equal(redact({ Authorization: 'Bearer xyz' }).Authorization, '[REDACTED]')
  assert.equal(redact({ password: 'pw' }).password, '[REDACTED]')
  assert.equal(redact({ secret: 's' }).secret, '[REDACTED]')
})

test('redact: 大小写不敏感', () => {
  assert.equal(redact({ APIKEY: 'x' }).APIKEY, '[REDACTED]')
  assert.equal(redact({ Token: 'x' }).Token, '[REDACTED]')
  assert.equal(redact({ AUTHORIZATION: 'x' }).AUTHORIZATION, '[REDACTED]')
})

test('redact: 安全字段保留', () => {
  const out = redact({ user: 'alice', count: 3, file: 'a.ts' })
  assert.equal(out.user, 'alice')
  assert.equal(out.count, 3)
  assert.equal(out.file, 'a.ts')
})

test('redact: 嵌套对象递归打码', () => {
  const out = redact({
    request: { prompt: 'long prompt', model: 'gpt-4' },
    safe: 1,
  })
  assert.equal(out.request.prompt, '[REDACTED]')
  assert.equal(out.request.model, 'gpt-4')
  assert.equal(out.safe, 1)
})

test('redact: 数组递归', () => {
  const out = redact([{ token: 'a' }, { token: 'b' }])
  assert.equal(out[0].token, '[REDACTED]')
  assert.equal(out[1].token, '[REDACTED]')
})

test('redact: 长字符串截断 2000 字符(非敏感字段才截断)', () => {
  const big = 'x'.repeat(3000)
  const out = redact({ fileContent: big })
  assert.equal(out.fileContent.length, 2000 + '...[truncated]'.length)
  assert.match(out.fileContent, /\.\.\.\[truncated\]$/)
})

test('redact: 敏感字段长字符串直接整体 redact,不截断(防 token 残留)', () => {
  const big = 'x'.repeat(5000)
  const out = redact({ prompt: big })
  assert.equal(out.prompt, '[REDACTED]')
})

test('redact: null / undefined / 数字 / 布尔 透传', () => {
  assert.equal(redact(null), null)
  assert.equal(redact(undefined), undefined)
  assert.equal(redact(42), 42)
  assert.equal(redact(true), true)
})

test('logger.debug: 默认 DEBUG 未设 → 不打印', () => {
  const orig = process.env.DEBUG
  delete process.env.DEBUG
  const captured = []
  const origLog = console.log
  console.log = (...args) => captured.push(args)
  logger.debug('hidden')
  console.log = origLog
  if (orig != null) process.env.DEBUG = orig
  assert.equal(captured.length, 0, '默认应静默')
})

test('logger.debug: DEBUG=1 → 打印并加 [debug] 前缀', () => {
  const orig = process.env.DEBUG
  process.env.DEBUG = '1'
  const captured = []
  const origLog = console.log
  console.log = (...args) => captured.push(args)
  logger.debug('visible')
  console.log = origLog
  if (orig != null) process.env.DEBUG = orig
  assert.equal(captured.length, 1)
  assert.equal(captured[0][0], '[debug]')
  assert.equal(captured[0][1], 'visible')
})

test('logger.info: 自动 redact 对象中的敏感字段', () => {
  const orig = process.env.DEBUG
  delete process.env.DEBUG
  const captured = []
  const origLog = console.log
  console.log = (...args) => captured.push(args)
  logger.info('with secrets:', { apiKey: 'sk-12345', safe: 'ok' })
  console.log = origLog
  if (orig != null) process.env.DEBUG = orig
  assert.equal(captured[0][1].apiKey, '[REDACTED]')
  assert.equal(captured[0][1].safe, 'ok')
})

test('SENSITIVE_KEYS 导出且非空', () => {
  assert.ok(SENSITIVE_KEYS instanceof Set)
  assert.ok(SENSITIVE_KEYS.size > 0)
})
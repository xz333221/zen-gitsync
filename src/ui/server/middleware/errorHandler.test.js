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
// src/ui/server/middleware/errorHandler.js 单元测试。
//
// 核心契约:
//   - HttpError → 用其 statusCode
//   - 普通 Error → 500
//   - SyntaxError (express.json 解析失败) → 400
//   - res.headersSent → 不再 res.status,转 next(err)
//   - err.status / err.statusCode 也被识别
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createErrorHandler } from './errorHandler.js'
import { HttpError } from '../utils/asyncRoute.js'

function makeMockRes(headersSent = false) {
  return {
    statusCode: 200,
    headersSent,
    _json: null,
    status(code) { this.statusCode = code; return this },
    json(p) { this._json = p; this.headersSent = true; return this }
  }
}

function makeMockReq(method = 'GET', path = '/api/foo') {
  return { method, path }
}

test('errorHandler: HttpError(404) → 404 + message', () => {
  const handler = createErrorHandler()
  const err = new HttpError(404, '资源不存在')
  const req = makeMockReq()
  const res = makeMockRes()
  handler(err, req, res, () => {})
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res._json, { success: false, error: '资源不存在' })
})

test('errorHandler: 普通 Error → 500', () => {
  const handler = createErrorHandler()
  const err = new Error('内部炸了')
  const req = makeMockReq()
  const res = makeMockRes()
  handler(err, req, res, () => {})
  assert.equal(res.statusCode, 500)
  assert.equal(res._json.success, false)
  assert.equal(res._json.error, '内部炸了')
})

test('errorHandler: err.status 优先级仅次于 HttpError', () => {
  // express 惯例:某些中间件(如 express-jwt)会给 err 设 status 而非 statusCode
  const handler = createErrorHandler()
  const err = Object.assign(new Error('未授权'), { status: 401 })
  const req = makeMockReq()
  const res = makeMockRes()
  handler(err, req, res, () => {})
  assert.equal(res.statusCode, 401)
  assert.equal(res._json.error, '未授权')
})

test('errorHandler: SyntaxError 带 status=400 → 400 (express.json 解析失败)', () => {
  const handler = createErrorHandler()
  const err = Object.assign(new SyntaxError('Unexpected token'), { status: 400, body: '{bad}' })
  const req = makeMockReq()
  const res = makeMockRes()
  handler(err, req, res, () => {})
  assert.equal(res.statusCode, 400, 'JSON 解析错误不应是 500')
})

test('errorHandler: res.headersSent=true → 不覆盖,转 next(err)', () => {
  const handler = createErrorHandler()
  const err = new Error('已发响应后抛错')
  const req = makeMockReq()
  const res = makeMockRes(true)  // 模拟已发响应
  let nextCalled = null
  handler(err, req, res, (e) => { nextCalled = e })
  assert.equal(res._json, null, '不应再调 res.json')
  assert.ok(nextCalled, '应调用 next(err) 让 express 关连接')
  assert.equal(nextCalled, err)
})

test('errorHandler: err 无 message (throw null) → 500 + 兜底文案', () => {
  const handler = createErrorHandler()
  const req = makeMockReq()
  const res = makeMockRes()
  handler(null, req, res, () => {})
  assert.equal(res.statusCode, 500)
  assert.equal(res._json.error, 'Internal Server Error')
})

test('errorHandler: 兼容 asyncRoute 的错误响应格式', () => {
  // errorHandler 与 asyncRoute 共享 {success:false, error} 格式,
  // 前端不需要区分错误来自哪个路径
  const handler = createErrorHandler()
  const err = new HttpError(422, '校验失败')
  const req = makeMockReq()
  const res = makeMockRes()
  handler(err, req, res, () => {})
  assert.deepEqual(Object.keys(res._json).sort(), ['error', 'success'])
  assert.equal(res._json.success, false)
})

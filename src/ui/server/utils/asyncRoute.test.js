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
// src/ui/server/utils/asyncRoute.js 单元测试。
// 14 个 routes 文件都依赖这个包装器,核心契约:
//   - 成功:handler 的返回值 / res.json 透传
//   - 抛 HttpError:用其 statusCode + message
//   - 抛普通 Error:500 + message
//   - 抛非 Error:500 + 字符串
//   - res.headersSent 后不再重复响应
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { asyncRoute, HttpError } from './asyncRoute.js'

/** 构造一个最小 mock res,记录 status / json 调用 */
function makeMockRes() {
  const res = {
    statusCode: 200,
    headersSent: false,
    _json: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this._json = payload; this.headersSent = true; return this }
  }
  return res
}

function makeMockReq(method = 'GET', path = '/api/foo') {
  return { method, path }
}

// ========== 成功路径 ==========

test('asyncRoute: 正常 handler 执行后 res.json 透传', async () => {
  const handler = asyncRoute(async (req, res) => {
    res.json({ success: true, data: 42 })
  })
  const req = makeMockReq()
  const res = makeMockRes()
  await handler(req, res, () => {})
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res._json, { success: true, data: 42 })
})

test('asyncRoute: 正常 handler 即使无 res.json 也不报错', async () => {
  // 防御:某些 handler 可能在中间件链路里手动 res.end,asyncRoute 不应崩
  const handler = asyncRoute(async (req, res) => {
    // 什么都不做
  })
  const req = makeMockReq()
  const res = makeMockRes()
  await handler(req, res, () => {})
  assert.equal(res.statusCode, 200)
})

// ========== HttpError 透传 statusCode ==========

test('asyncRoute: handler 抛 HttpError(400) → 400 + message', async () => {
  const handler = asyncRoute(async (req, res) => {
    throw new HttpError(400, '缺少参数')
  })
  const req = makeMockReq()
  const res = makeMockRes()
  await handler(req, res, () => {})
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res._json, { success: false, error: '缺少参数' })
})

test('asyncRoute: handler 抛 HttpError(404) → 404 + message', async () => {
  const handler = asyncRoute(async (req, res) => {
    throw new HttpError(404, '资源不存在')
  })
  const req = makeMockReq()
  const res = makeMockRes()
  await handler(req, res, () => {})
  assert.equal(res.statusCode, 404)
  assert.match(res._json.error, /不存在/)
})

test('asyncRoute: handler 抛 HttpError(403) → 403(SEC-PATH 系列错误码回归)', async () => {
  // 路径越界类的安全检查都走 HttpError(403, ...)
  const handler = asyncRoute(async (req, res) => {
    throw new HttpError(403, '路径超出项目范围')
  })
  const req = makeMockReq()
  const res = makeMockRes()
  await handler(req, res, () => {})
  assert.equal(res.statusCode, 403)
})

// ========== 普通 Error → 500 ==========

test('asyncRoute: handler 抛普通 Error → 500 + message', async () => {
  const handler = asyncRoute(async (req, res) => {
    throw new Error('文件系统炸了')
  })
  const req = makeMockReq()
  const res = makeMockRes()
  await handler(req, res, () => {})
  assert.equal(res.statusCode, 500)
  assert.equal(res._json.success, false)
  assert.equal(res._json.error, '文件系统炸了')
})

test('asyncRoute: handler 抛字符串 → 500 + 字符串', async () => {
  // 防御:某些粗心代码可能 throw 'plain string' 而不是 throw new Error(...)
  const handler = asyncRoute(async (req, res) => {
    // eslint-disable-next-line no-throw-literal
    throw 'string-error'
  })
  const req = makeMockReq()
  const res = makeMockRes()
  await handler(req, res, () => {})
  assert.equal(res.statusCode, 500)
  assert.equal(res._json.error, 'Internal Server Error', '字符串无 .message,走兜底文案')
})

test('asyncRoute: handler 抛 null → 500 + 兜底文案', async () => {
  const handler = asyncRoute(async (req, res) => {
    // eslint-disable-next-line no-throw-literal
    throw null
  })
  const req = makeMockReq()
  const res = makeMockRes()
  await handler(req, res, () => {})
  assert.equal(res.statusCode, 500)
  // null 没有 .message,兜底 'Internal Server Error'
  assert.equal(res._json.error, 'Internal Server Error')
})

// ========== headersSent 后调用 next ==========

test('asyncRoute: res.headersSent=true 时不再覆盖响应,转交 next(err)', async () => {
  const handler = asyncRoute(async (req, res) => {
    res.status(200).json({ partial: true })  // 已发响应
    throw new Error('后置异常')
  })
  const req = makeMockReq()
  const res = makeMockRes()
  let nextCalled = null
  await handler(req, res, (err) => { nextCalled = err })
  // res._json 应保持首次写入的 partial
  assert.deepEqual(res._json, { partial: true })
  // next(err) 应被调用,带原 error
  assert.ok(nextCalled, 'next 应被调用')
  assert.equal(nextCalled.message, '后置异常')
})

// ========== HttpError 构造约束 ==========

test('HttpError: statusCode 字段被设置', () => {
  const e = new HttpError(400, 'bad')
  assert.equal(e.statusCode, 400)
  assert.equal(e.message, 'bad')
  assert.equal(e.name, 'HttpError')
  // 仍是 Error 子类
  assert.ok(e instanceof Error)
})

test('HttpError: 不传 statusCode 也安全(但 statusCode 字段为 undefined)', () => {
  // 防御:调用方忘了传 statusCode 时,asyncRoute 走兜底 500 分支
  const e = new HttpError(undefined, 'oops')
  assert.equal(e.statusCode, undefined)
  assert.equal(e.message, 'oops')
})

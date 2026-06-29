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
// Express 全局错误处理中间件。
//
// 触发条件（按发生频率排序）：
//   1) 路由用 asyncRoute 包装后 throw 出来的、未被捕获的异常
//      —— asyncRoute 自己已经 res.json 返回了，不会到这里
//   2) 路由没用 asyncRoute（仍写 try/catch），但忘了 res 的场景
//   3) handler 内部 next(err) 主动透传
//   4) express.json() / 静态资源 fallback / socket.io 之外的中间件抛错
//   5) headersSent 之后 next(err) 走 express 默认兜底（关闭连接）
//
// 设计要点：
//   - 必须是 4-arity (err, req, res, next) 才会被 express 识别为错误中间件
//   - 必须注册在所有 register*Routes 之后、express.static 之后（兜底最后）
//   - 兼容 HttpError（来自 asyncRoute.js）的 statusCode 字段
//   - 兼容 express.json() 抛的 SyntaxError（400 Bad Request）
//   - headersSent 时只能 next(error) 让 express 关连接，不能再 res.write
//
// 用法：
//   app.use(createErrorHandler())

import logger from '../utils/logger.js'
import { HttpError } from '../utils/asyncRoute.js'

/**
 * 全局错误处理中间件工厂。
 * @returns {import('express').ErrorRequestHandler}
 */
export function createErrorHandler() {
  return (err, req, res, next) => {
    // 已经回包了就只能让 express 关连接，再 res.status 会抛 ERR_HTTP_HEADERS_SENT
    if (res.headersSent) {
      return next(err)
    }

    // 状态码优先级：HttpError.statusCode > err.status（express 惯例）> err.statusCode > 500
    let statusCode = 500
    if (err instanceof HttpError && Number.isInteger(err.statusCode)) {
      statusCode = err.statusCode
    } else if (err?.status && Number.isInteger(err.status)) {
      statusCode = err.status
    } else if (err?.statusCode && Number.isInteger(err.statusCode)) {
      statusCode = err.statusCode
    }

    // express.json() 解析失败抛 SyntaxError → 400，不要让用户看到 500
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
      statusCode = 400
    }

    // 4xx 一般是用户输入问题，info 级即可；5xx 是真异常，error 级
    const logLevel = statusCode >= 500 ? 'error' : 'info'
    // 与 asyncRoute 一致：err 无 message（throw null/数字/字符串无 .message）时走兜底文案，
    // 避免 String(null) = 'null' 这种无意义错误信息泄露到响应里
    const rawMsg = typeof err?.message === 'string' && err.message.length > 0 ? err.message : ''
    const redactedMsg = rawMsg || 'Internal Server Error'
    const logLine = `[${req.method} ${req.path}] ${statusCode} ${redactedMsg}`
    if (logLevel === 'error') {
      logger.error(logLine)
      if (err?.stack) logger.error(err.stack)
    } else {
      logger.info(logLine)
    }

    // 错误响应体格式与 asyncRoute 保持一致
    res.status(statusCode).json({
      success: false,
      error: redactedMsg || 'Internal Server Error'
    })
  }
}

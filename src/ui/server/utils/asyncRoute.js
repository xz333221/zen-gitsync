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
// 统一 Express async route handler 错误处理。
//
// 历史问题:每个 route 都重复
//   app.get('/api/foo', async (req, res) => {
//     try { ... } catch (error) { res.status(500).json({ success: false, error: error.message }) }
//   })
// 全仓 13 个 routes 文件 77 处这种包装,改一个错误格式要 grep 全部替换。
//
// 用法:用 asyncRoute(handler) 包一层,handler 内部不再写 try/catch,异常
// 自动转 500 JSON 响应;handler 也可以 throw HttpError(400, 'msg') 抛任意
// 状态码,包装器识别后透传。
//
//   app.get('/api/foo', asyncRoute(async (req, res) => {
//     const file = req.query.path
//     if (!file) throw new HttpError(400, '缺少 path 参数')
//     const data = await fs.readFile(file)
//     res.json({ success: true, data })
//   }))

import logger from './logger.js'

/**
 * 带 statusCode 字段的 Error 子类,asyncRoute 识别后转 HTTP 响应;
 * 普通 Error 一律按 500 Internal Server Error 处理。
 */
export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.name = 'HttpError'
    this.statusCode = statusCode
  }
}

/**
 * 包一层 Express handler,把异常自动转 JSON 响应。
 *
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => any | Promise<any>} handler
 * @returns {import('express').RequestHandler}
 */
export function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next)
    } catch (error) {
      const statusCode = error?.statusCode && Number.isInteger(error.statusCode) ? error.statusCode : 500
      // 5xx 走 logger(redact 敏感字段),4xx 通常是用户输入问题,logger.info 即可
      if (statusCode >= 500) {
        logger.error(`[${req.method} ${req.path}] ${error?.message || error}`)
      } else {
        logger.info(`[${req.method} ${req.path}] ${statusCode} ${error?.message || error}`)
      }
      if (res.headersSent) {
        return next(error)
      }
      res.status(statusCode).json({
        success: false,
        error: error?.message || 'Internal Server Error'
      })
    }
  }
}
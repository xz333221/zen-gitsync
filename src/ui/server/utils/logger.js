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

/**
 * 轻量 logger,带敏感字段自动打码,防止 AI prompt / API key / token 落地泄露。
 *
 * 用法:
 *   import logger from '../utils/logger.js'
 *   logger.info('hello', { user: 'a', apiKey: 'sk-xxx' })
 *   // -> hello { user: 'a', apiKey: '[REDACTED]' }
 *   logger.debug('prompt', bigPrompt)  // 仅当 DEBUG=1 / DEBUG=logger 时打印
 *
 * 设计目标:
 *   - 零依赖,直接接管全后端 console.{log,info,warn,error}
 *   - 不改格式,console.* 调用 1:1 替换为 logger.*
 *   - 自动递归 redact 已知敏感字段(apiKey / token / prompt / Authorization 等)
 *   - debug 级别默认关闭,需 DEBUG 环境变量开启,避免误把整段 prompt 写到磁盘
 */

// 命中这些 key(大小写不敏感)→ 值打印成 [REDACTED]
const SENSITIVE_KEYS = new Set([
  'apikey', 'api_key', 'token', 'authorization', 'prompt', 'password',
  'secret', 'access_token', 'refreshtoken', 'sessiontoken',
])

const REDACTED = '[REDACTED]'
const MAX_STRING = 2000 // 单个字符串超过这个长度截断,防止 prompt 整段冲爆日志

function redact(value) {
  if (value == null) return value
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '...[truncated]' : value
  }
  if (Array.isArray(value)) return value.map(redact)
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? REDACTED : redact(v)
    }
    return out
  }
  return value
}

function fmt(args) {
  return args.map(a => (typeof a === 'object' && a !== null ? redact(a) : a))
}

function debugEnabled() {
  const flag = (process.env.DEBUG || '').toLowerCase()
  if (!flag) return false
  return flag === '1' || flag === 'true' || flag === '*' || flag.includes('logger')
}

const logger = {
  /** debug 级,默认关闭,需 DEBUG=1 或 DEBUG=logger */
  debug: (...args) => { if (debugEnabled()) console.log('[debug]', ...fmt(args)) },
  info: (...args) => console.log(...fmt(args)),
  warn: (...args) => console.warn(...fmt(args)),
  error: (...args) => console.error(...fmt(args)),
  redact,
  SENSITIVE_KEYS,
}

export default logger
export { redact, SENSITIVE_KEYS }
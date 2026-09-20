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
// ─────────────────────────────────────────────────────────────
// AI 请求的地址 + 请求头统一构造层
//
// 为什么要单独抽一层（以前这些逻辑散在 7 个调用点，只改一处等于没改）：
//
// 1) 客户端身份 + 会话 ID。OpenCode 的网关（opencode.ai/zen/**，含 $10/月的 Go 订阅）
//    要求客户端「用自己的名字当 User-Agent」（不能是 node-fetch/undici 这类通用库名），
//    并且每次对话在 `x-opencode-session` 里带一个稳定会话 ID，用于路由与提示缓存。
//    缺了会被网关直接拒掉：
//      Request is missing x-opencode-session and cannot be routed efficiently.
//      Please see https://opencode.ai/docs/go/#where-can-i-use-it
//    用 node-fetch 默认 UA 也会被当成"通用 HTTP 库"而命中滥用风控。
//
// 2) 协议族选择。同一个 baseURL 后面挂着三种协议，path 与鉴权方式都不同：
//      chat      → POST /chat/completions  (Authorization: Bearer)
//      messages  → POST /messages          (x-api-key + anthropic-version)
//      responses → POST /responses         (Authorization: Bearer)
//    本仓库的 AI 调用全部只实现了 OpenAI 兼容的 chat 形态，所以碰到后两种协议族
//    要**明确报错**（提示换模型），而不是把 OpenAI body 打到 Anthropic 路由上等一个
//    看不懂的 4xx。
//
// 参考实现：ai-model-form 包的 server/middleware.js（同一套判断，那边只做连通性测试）。
// ─────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** 本包版本，用于 User-Agent（从模块自身位置往上找 package.json，不受 cwd 影响） */
const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** 网关/风控认的客户端标识：得是"自己的名字"，不能是通用 HTTP 库 */
export const AI_USER_AGENT = `zen-gitsync/${PKG_VERSION}`

/** OpenCode 网关的 Go 订阅入口（ai-model-form 里叫 OPENCODE_GO_URL） */
export const OPENCODE_GO_URL = 'https://opencode.ai/zen/go/v1'

/**
 * OpenCode Go 上走 Anthropic /messages 协议的模型（鉴权是 x-api-key，不是 Bearer）。
 * 只列**非 chat** 的模型：没列到的一律按 chat 处理，这样网关以后新增 chat 模型
 * 不需要同步改这里（新增非 chat 模型时才会退化回"上游报错"）。
 */
const OPENCODE_GO_MESSAGES_MODELS = new Set([
  'minimax-m3', 'minimax-m2.7', 'minimax-m2.5',
  'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-max', 'qwen3.7-plus',
  'qwen3.6-plus', 'qwen3.5-plus', 'union-alpha',
])

/** OpenCode Go 上走 OpenAI Responses 协议（/responses）的模型 */
const OPENCODE_GO_RESPONSES_MODELS = new Set([
  'grok-4.6', 'grok-4.5', 'gpt-5.6-luna',
  'muse-spark-1.3-contributor', 'muse-spark-1.2-contributor',
])

/**
 * 归一化 baseURL：去掉尾部斜杠（兼容用户填 .../v1/ 的写法）
 * @param {string} baseURL
 * @returns {string}
 */
export function normalizeBaseURL(baseURL) {
  return String(baseURL || '').trim().replace(/\/+$/, '')
}

/**
 * 是否为 OpenCode 网关（opencode.ai 及其子域）。
 * 只有这类端点才需要客户端身份 + 会话 ID；其它 provider 不必多带这几个头。
 * @param {string} baseURL
 * @returns {boolean}
 */
export function isOpenCodeGateway(baseURL) {
  try {
    const host = new URL(normalizeBaseURL(baseURL)).hostname
    return /(^|\.)opencode\.ai$/i.test(host)
  } catch {
    return false
  }
}

/**
 * 判断模型在 OpenCode Go 上走哪种协议族。
 * @param {string} modelId
 * @returns {'chat'|'messages'|'responses'}
 */
export function openCodeGoFamily(modelId) {
  const id = String(modelId || '').trim().toLowerCase()
  if (OPENCODE_GO_MESSAGES_MODELS.has(id)) return 'messages'
  if (OPENCODE_GO_RESPONSES_MODELS.has(id)) return 'responses'
  return 'chat'
}

let _processSessionId = null

/**
 * 进程级稳定会话 ID（懒创建）。
 * 一次性调用（生成提交信息 / 分支名 / 代码分析…）没有"对话"概念，用同一个值把
 * 同一进程里的这类请求归到一条会话上——重复点"重新生成"还能吃到网关的提示缓存。
 * @returns {string}
 */
export function processAiSessionId() {
  if (!_processSessionId) _processSessionId = randomUUID()
  return _processSessionId
}

/**
 * 请求的公共头：客户端身份（+ OpenCode 网关的会话 ID）。
 * GET /models、连通性探测这类非 chat 请求也应该带上，否则同样会被风控挡。
 *
 * @param {object} opts
 * @param {string} opts.baseURL
 * @param {string} [opts.apiKey]
 * @param {string} [opts.sessionId] - 对话级 ID；不传则用进程级兜底
 * @returns {Record<string,string>}
 */
export function buildAiBaseHeaders({ baseURL, apiKey, sessionId } = {}) {
  const headers = { 'User-Agent': AI_USER_AGENT }
  if (isOpenCodeGateway(baseURL)) {
    headers['x-opencode-session'] = sessionId || processAiSessionId()
  }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  return headers
}

/**
 * 构造「OpenAI 兼容 chat 请求」的 URL 与完整请求头。
 *
 * @param {object} opts
 * @param {string} opts.baseURL
 * @param {string} [opts.model]     - 用于识别 OpenCode Go 的协议族
 * @param {string} [opts.apiKey]
 * @param {string} [opts.sessionId] - 对话级 ID（多轮对话请传，一次性调用可省略）
 * @param {Record<string,string>} [opts.extraHeaders]
 * @returns {{ url: string, headers: Record<string,string> }}
 * @throws {Error} baseURL 缺失，或所选模型在 OpenCode 网关上不是 chat/completions 协议
 */
export function buildAiChatRequest({ baseURL, model, apiKey, sessionId, extraHeaders } = {}) {
  const base = normalizeBaseURL(baseURL)
  if (!base) throw new Error('AI 模型未配置接口地址（baseURL）')

  if (isOpenCodeGateway(base)) {
    const family = openCodeGoFamily(model)
    if (family !== 'chat') {
      const proto = family === 'messages'
        ? 'Anthropic 的 /messages（鉴权走 x-api-key）'
        : 'OpenAI 的 /responses'
      throw new Error(
        `模型「${model}」在 OpenCode 网关上走 ${proto} 协议，本工具的 AI 调用只实现了 ` +
        'OpenAI 兼容的 /chat/completions。请在设置里换一个走 chat/completions 的模型' +
        '（如 deepseek-v4.1-flash、glm-5.3、kimi-k3）。'
      )
    }
  }

  return {
    url: `${base}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      ...buildAiBaseHeaders({ baseURL: base, apiKey, sessionId }),
      ...extraHeaders,
    },
  }
}

/**
 * 把上游返回的错误体整理成一句人能读的话。
 *
 * 各家 provider 的错误体形态不一（OpenAI 兼容是 {error:{message}}，Anthropic 是
 * {error:{message}} / {message}，还有些直接返回纯文本或 HTML），以前直接把整个响应体
 * 丢进 Error 里，界面上就是一大坨 JSON。这里统一抽 message，抽不到才退回原文（截断）。
 *
 * @param {string} bodyText - 响应体原文
 * @param {number} [status]
 * @returns {string}
 */
export function describeAiHttpError(bodyText, status) {
  const raw = String(bodyText || '').trim()
  let message = ''
  try {
    const data = JSON.parse(raw)
    message = data?.error?.message
      || (typeof data?.error === 'string' ? data.error : '')
      || data?.message
      || ''
  } catch {
    message = ''
  }
  if (message) return message
  const fallback = raw.length > 300 ? `${raw.slice(0, 300)}…` : raw
  return fallback || `HTTP ${status}`
}

/**
 * 构造非 chat 请求（GET /models 等）的 URL 与请求头。
 * @param {object} opts
 * @param {string} opts.baseURL
 * @param {string} opts.path      - 以 / 开头的路径，如 '/models'
 * @param {string} [opts.apiKey]
 * @param {string} [opts.sessionId]
 * @param {Record<string,string>} [opts.extraHeaders]
 * @returns {{ url: string, headers: Record<string,string> }}
 */
export function buildAiApiRequest({ baseURL, path, apiKey, sessionId, extraHeaders } = {}) {
  const base = normalizeBaseURL(baseURL)
  if (!base) throw new Error('AI 模型未配置接口地址（baseURL）')
  return {
    url: `${base}${path}`,
    headers: {
      ...buildAiBaseHeaders({ baseURL: base, apiKey, sessionId }),
      ...extraHeaders,
    },
  }
}

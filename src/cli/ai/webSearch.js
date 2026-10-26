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
// g ai 的联网搜索 / 网页抓取 —— provider 抽象层。
//
// 设计约定：
//   · web_search **只回摘要**（标题 / URL / 摘要片段），不抓正文 —— 让模型自己判断
//     哪几条值得深读，再对那个 URL 调 web_fetch。token 花在"真的要看的那页"上。
//   · provider 可切换（firecrawl / tavily / exa），配置来自 config.json 的全局键
//     `webSearch`（形状与归一化见 src/config.js 的 normalizeWebSearch）。
//   · 代理走 undici 的 ProxyAgent：Node 内置 fetch **不认** HTTPS_PROXY（除非进程
//     启动时带 --use-env-proxy），所以配了代理就用 undici 自己的 fetch + ProxyAgent，
//     两者同源、版本自洽。undici 是可选依赖：没配代理时零影响。
//   · CA 补齐（enableSystemCAs）与远程 MCP 同一手法：Node 只认内置根证书，
//     企业/自签代理环境下会 UNABLE_TO_VERIFY_LEAF_SIGNATURE。
//
// 与 tools.js 的边界：本文件只负责"发请求 + 把各家返回裁成统一形状"；
// 工具 schema、结果格式化、给模型的错误话术都在 tools.js 的 handler 里。

import { enableSystemCAs } from './systemCa.js'

const DEFAULT_TIMEOUT_MS = 20000
const DEFAULT_MAX_RESULTS = 5
const MAX_RESULTS_LIMIT = 10
const MAX_SNIPPET_CHARS = 500
const DEFAULT_FETCH_CHARS = 20000
const MAX_FETCH_CHARS = 50000

// provider 白名单 —— 与 src/config.js 的 WEB_SEARCH_PROVIDERS 必须一致。
export const WEB_SEARCH_PROVIDERS = ['firecrawl', 'tavily', 'exa']

// 聚合模式标识：provider 传 'all'（或设置里的默认引擎选它）时**并发打多家、合并去重**。
// 它不是 provider 白名单成员（不参与 API Key 那几行），所以单独列出来。
export const WEB_SEARCH_AGGREGATE_ID = 'all'

function str(v) {
  return typeof v === 'string' ? v : (v === undefined || v === null ? '' : String(v))
}

function clip(text, max = MAX_SNIPPET_CHARS) {
  const s = str(text).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function clampResults(n) {
  const num = Number(n)
  const base = Number.isFinite(num) && num > 0 ? Math.floor(num) : DEFAULT_MAX_RESULTS
  return Math.max(1, Math.min(MAX_RESULTS_LIMIT, base))
}

// CA 补齐（幂等、只做一次）。Node < 24 或异常静默跳过，不影响主流程。
let caReady = false
function ensureCa() {
  if (caReady) return
  caReady = true
  try { enableSystemCAs() } catch { /* 低版本 Node 没有该 API，忽略 */ }
}

// undici 是**可选**依赖：只在配了代理时才需要，动态 import（没装也不影响直连）。
let undiciModule = null
let undiciTried = false
async function loadUndici() {
  if (undiciTried) return undiciModule
  undiciTried = true
  try {
    undiciModule = await import('undici')
  } catch {
    undiciModule = null
  }
  return undiciModule
}

/**
 * 构造一个 http 函数：(url, init) => Promise<解析后的 JSON>。
 * 直连走全局 fetch；配了代理则换用 undici 的 fetch + ProxyAgent（同源自洽）。
 * 每次调用都新建 AbortController 超时，异常一律翻译成人话再抛。
 */
async function makeHttp(proxy) {
  const proxyUrl = str(proxy).trim()
  let fetchFn = fetch
  let dispatcher
  if (proxyUrl) {
    const undici = await loadUndici()
    if (!undici || typeof undici.fetch !== 'function' || typeof undici.ProxyAgent !== 'function') {
      throw new Error(`已配置代理 ${proxyUrl}，但缺少 undici 依赖，无法走代理。请安装 undici，或清空设置里的代理地址改用直连。`)
    }
    fetchFn = undici.fetch
    try {
      dispatcher = new undici.ProxyAgent(proxyUrl)
    } catch (err) {
      throw new Error(`代理地址无法解析：${proxyUrl}（${err.message}）`)
    }
  }

  return async function http(url, { method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    ensureCa()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let resp
    try {
      resp = await fetchFn(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        ...(dispatcher ? { dispatcher } : {}),
      })
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error(`请求超时（${timeoutMs / 1000}s）：${url}`)
      throw new Error(`请求失败：${err.message}`)
    } finally {
      clearTimeout(timer)
    }
    const text = await resp.text()
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}${text ? ` ${clip(text, 300)}` : ''}`)
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`返回不是合法 JSON：${clip(text, 200)}`)
    }
  }
}

function normalizeResults(list) {
  const out = []
  for (const it of Array.isArray(list) ? list : []) {
    if (!it || typeof it !== 'object') continue
    const url = str(it.url || it.link).trim()
    if (!/^https?:\/\//i.test(url)) continue
    out.push({
      title: clip(str(it.title), 200) || url,
      url,
      snippet: clip(str(it.description ?? it.snippet ?? it.content ?? it.text ?? it.summary)),
    })
    if (out.length >= MAX_RESULTS_LIMIT) break
  }
  return out
}

// 各 provider 的 search / fetch 实现。http 是上面 makeHttp 造的函数。
const PROVIDERS = {
  firecrawl: {
    // 无 key 也能用（按 IP 限流）；有 key 时带上 Bearer。
    authHeaders: (apiKey) => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    async search({ query, maxResults, apiKey, http }) {
      const data = await http('https://api.firecrawl.dev/v2/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...PROVIDERS.firecrawl.authHeaders(apiKey) },
        body: { query, limit: maxResults },
      })
      const list = Array.isArray(data?.data) ? data.data
        : Array.isArray(data?.data?.web) ? data.data.web
          : Array.isArray(data?.web) ? data.web : []
      return normalizeResults(list)
    },
    async fetch({ url, apiKey, http }) {
      const data = await http('https://api.firecrawl.dev/v2/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...PROVIDERS.firecrawl.authHeaders(apiKey) },
        body: { url, formats: ['markdown'] },
      })
      const md = data?.data?.markdown ?? data?.markdown ?? ''
      return { title: clip(str(data?.data?.metadata?.title), 200), url, text: str(md) }
    },
  },
  tavily: {
    async search({ query, maxResults, apiKey, http }) {
      if (!apiKey) throw new Error('未配置 Tavily API Key（设置 → AI 模型配置 → 联网搜索）')
      const data = await http('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { api_key: apiKey, query, max_results: maxResults, search_depth: 'basic' },
      })
      return normalizeResults(data?.results)
    },
    async fetch({ url, apiKey, http }) {
      if (!apiKey) throw new Error('未配置 Tavily API Key（设置 → AI 模型配置 → 联网搜索）')
      const data = await http('https://api.tavily.com/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { api_key: apiKey, urls: [url] },
      })
      const item = Array.isArray(data?.results) ? data.results[0] : null
      return { title: clip(str(item?.title), 200), url, text: str(item?.raw_content) }
    },
  },
  exa: {
    async search({ query, maxResults, apiKey, http }) {
      if (!apiKey) throw new Error('未配置 Exa API Key（设置 → AI 模型配置 → 联网搜索）')
      const data = await http('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: { query, numResults: maxResults, contents: { text: { maxCharacters: MAX_SNIPPET_CHARS } } },
      })
      return normalizeResults(data?.results)
    },
    async fetch({ url, apiKey, http }) {
      if (!apiKey) throw new Error('未配置 Exa API Key（设置 → AI 模型配置 → 联网搜索）')
      const data = await http('https://api.exa.ai/contents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: { urls: [url], text: true },
      })
      const item = Array.isArray(data?.results) ? data.results[0] : null
      return { title: clip(str(item?.title), 200), url, text: str(item?.text) }
    },
  },
}

/**
 * 决定这次搜索用哪种模式：
 *   · 显式传 'all'       → 聚合模式（并发多引擎）
 *   · 显式传具体 provider → 就用它（覆盖配置里的默认）
 *   · 都没传            → 看配置默认：是 'all' 就聚合，否则用该 provider，最后兜底 firecrawl
 * 白名单外的名字一律忽略 —— 免得模型瞎传一个不存在的名字把请求打到未知端点。
 */
function resolveMode(explicit, configProvider) {
  const a = str(explicit).trim().toLowerCase()
  if (a === WEB_SEARCH_AGGREGATE_ID) return { aggregate: true }
  if (WEB_SEARCH_PROVIDERS.includes(a)) return { aggregate: false, provider: a }
  const b = str(configProvider).trim().toLowerCase()
  if (b === WEB_SEARCH_AGGREGATE_ID) return { aggregate: true }
  if (WEB_SEARCH_PROVIDERS.includes(b)) return { aggregate: false, provider: b }
  return { aggregate: false, provider: 'firecrawl' }
}

// 该 provider 这次是否"可用"：firecrawl 免 key 总可用；tavily / exa 必须有 key。
// 聚合时提前滤掉没 key 的，省一次注定失败的网络往返。
function providerAvailable(id, apiKeys) {
  if (id === 'firecrawl') return true
  return Boolean(str(apiKeys[id]).trim())
}

// 仅用于**去重**的 URL 归一化：去 hash、去末尾斜杠、host 小写。
// 刻意不剥查询参数 —— 有些站点靠 query 区分内容，剥了会误合并。
function urlKey(url) {
  try {
    const u = new URL(url)
    u.hash = ''
    let key = `${u.protocol}//${u.host}${u.pathname}`
    if (key.endsWith('/')) key = key.slice(0, -1)
    return key.toLowerCase()
  } catch {
    return str(url).toLowerCase()
  }
}

// 交错取样：各引擎的结果按轮次轮流取，保证来源均衡（不让第一家占满名额），
// 同时按 URL 去重。limit 是最终条数上限。
function interleaveResults(groups, limit) {
  const out = []
  const seen = new Set()
  const maxLen = groups.reduce((m, g) => Math.max(m, g.length), 0)
  for (let idx = 0; idx < maxLen && out.length < limit; idx++) {
    for (const g of groups) {
      const item = g[idx]
      if (!item) continue
      const k = urlKey(item.url)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(item)
      if (out.length >= limit) break
    }
  }
  return out
}

// 聚合：并发打所有可用 provider（Promise.allSettled，个别失败不拖垮整次），
// 合并去重后交错取样。返回 { provider: 'all', results(每条带 source), sources, errors }。
async function runAggregateSearch({ query, maxResults, config }) {
  const cfg = config || {}
  const apiKeys = (cfg.apiKeys && typeof cfg.apiKeys === 'object') ? cfg.apiKeys : {}
  const ids = WEB_SEARCH_PROVIDERS.filter((id) => providerAvailable(id, apiKeys))
  const http = await makeHttp(cfg.proxy)
  const limit = clampResults(maxResults)
  const settled = await Promise.allSettled(
    ids.map((id) => PROVIDERS[id].search({ query, maxResults: limit, apiKey: str(apiKeys[id]), http }))
  )
  const groups = []
  const errors = []
  settled.forEach((res, i) => {
    if (res.status === 'fulfilled') {
      groups.push(res.value.map((r) => ({ ...r, source: ids[i] })))
    } else {
      errors.push(`${ids[i]}: ${res.reason?.message || String(res.reason)}`)
    }
  })
  const results = interleaveResults(groups, limit)
  if (!results.length && errors.length) {
    throw new Error(`所有引擎都失败了（${errors.join('；')}）`)
  }
  return { provider: WEB_SEARCH_AGGREGATE_ID, results, sources: ids, errors }
}

/**
 * 执行一次联网搜索，返回 { provider, results }。
 * provider 为 'all'（或配置里选它）时走聚合：每条结果的 source 字段标明来自哪个引擎。
 * @param {{ query: string, maxResults?: number, provider?: string,
 *   config?: { provider?: string, apiKeys?: Record<string,string>, proxy?: string } }} opts
 */
export async function runWebSearch({ query, maxResults, provider, config } = {}) {
  const cfg = config || {}
  const q = str(query).trim()
  const mode = resolveMode(provider, cfg.provider)
  if (mode.aggregate) {
    return runAggregateSearch({ query: q, maxResults, config: cfg })
  }
  const apiKeys = (cfg.apiKeys && typeof cfg.apiKeys === 'object') ? cfg.apiKeys : {}
  const http = await makeHttp(cfg.proxy)
  const limit = clampResults(maxResults)
  const results = await PROVIDERS[mode.provider].search({ query: q, maxResults: limit, apiKey: str(apiKeys[mode.provider]), http })
  return { provider: mode.provider, results: results.map((r) => ({ ...r, source: mode.provider })) }
}

/**
 * 抓取一个网页的正文（markdown）。返回 { provider, title, url, text }。
 * 正文可能很长，进上下文前先按 maxChars 裁（默认 20,000 字符）。
 */
export async function runWebFetch({ url, provider, config, maxChars } = {}) {
  const cfg = config || {}
  const mode = resolveMode(provider, cfg.provider)
  // 抓正文只能用单个 provider；参数/配置给的是聚合时退回 firecrawl（抓正文能力最强且免 key）
  const chosen = mode.aggregate ? 'firecrawl' : mode.provider
  const apiKeys = (cfg.apiKeys && typeof cfg.apiKeys === 'object') ? cfg.apiKeys : {}
  const http = await makeHttp(cfg.proxy)
  const out = await PROVIDERS[chosen].fetch({ url: str(url).trim(), apiKey: str(apiKeys[chosen]), http })
  const limit = Math.max(1000, Math.min(MAX_FETCH_CHARS, Number(maxChars) || DEFAULT_FETCH_CHARS))
  return { provider: chosen, title: out.title || str(url), url: out.url || str(url), text: str(out.text).slice(0, limit) }
}

export default { WEB_SEARCH_PROVIDERS, WEB_SEARCH_AGGREGATE_ID, runWebSearch, runWebFetch }
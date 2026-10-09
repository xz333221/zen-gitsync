import { TOOL_DEFINITIONS } from './tools.js'
import { buildAiChatRequest, describeAiHttpError } from '../../utils/aiEndpoint.js'
import { normalizeUsage } from './telemetry.js'

// Some compatible gateways reject stream_options. Remember that for this process.
const withoutStreamUsage = new Set()

// ── 超时与自动重试口径（2026-10-09 改） ────────────────────────────────
//
// **超时是"空闲"超时，不再是"整条流"上限。**
// 原先是一个从请求发出就开始跑的 300s 总时限：一次正常但比较慢的回答
// （长思考 / 长正文 / 大上下文的首字延迟）跑满 5 分钟就被判"模型响应超时"掐断，
// 而对面其实还在正常吐字 —— 用户看到的是"跑得好好的突然失败"。
// 现在只在**连续 idleTimeoutMs 毫秒收不到任何字节**时才判定连接已死：
// 每收到一段数据就重置计时（见 attemptOnce 里的 touch()）。慢但活着的回答可以一直跑，
// 真挂死的连接照样会被发现。窗口里那句"模型响应超时"因此换了说法（见 stallError）。
//
// 判死的连接不再直接失败：交给下面这条自动重试接手，最多 MAX_LLM_RETRIES 次
// （口径对齐 Claude Code 的 MAX_RETRIES=10）。
//
// 外层的两个调用点（CLI 的 turn.js / Web 的 agentChat.js）通过 onRetry 拿到
// "这次尝试吐了哪些字"的快照，据此把界面上那半截丢掉再重来。
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000
export const MAX_LLM_RETRIES = 10
const RETRY_BASE_DELAY_MS = 500
const RETRY_MAX_DELAY_MS = 30_000

// 值得再试一次的 HTTP 状态：限流 / 请求超时 / 服务端 5xx —— 都是"再试一次可能就好了"。
// 其余 4xx（400 参数错、401/403 鉴权、404 模型名不对、422 校验失败）再试十次也一样，
// 直接失败，并把网关的原话交给用户。
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524])

// 把"网关返回了什么"翻成"用户该做什么"。400 且正文提到 tool/function 时,十有八九是
// 模型本身不支持 function calling —— 直接说清楚,比把网关 JSON 原样甩出来有用。
// 这条口径原先只在 Web 智能体面板里写了一份,现在收敛到此处,CLI 与 Web 共用。
//
// status 同时决定这件事**要不要重试**（retryable），所以错误对象上必须带住它 ——
// 重试判定发生在 catch 里，那时响应对象已经不在手上了。
function httpFailure(status, detail, statusText, { retryAfterMs = null } = {}) {
  const suffix = detail || statusText || ''
  const error = status === 400 && /tool|function/i.test(String(detail || ''))
    ? new Error(`HTTP 400: 当前模型可能不支持 function calling(${suffix})。请在设置中换用支持工具调用的模型。`)
    : new Error(`HTTP ${status}: ${suffix}`)
  error.status = status
  error.retryable = RETRYABLE_STATUS.has(status)
  if (Number.isFinite(retryAfterMs)) error.retryAfterMs = retryAfterMs
  return error
}

/** 网关给的 Retry-After（秒数或 HTTP 日期）。拿不到返回 null，别让解析失败影响重试。 */
function readRetryAfter(resp) {
  let raw = null
  try { raw = resp?.headers?.get?.('retry-after') } catch { return null }
  if (!raw) return null
  const secs = Number(raw)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}

/**
 * 这个错误值不值得再试一次。
 *
 * 默认**值得**：传输层抛出来的绝大多数是网络/流层面的瞬时故障（连接被掐、网关 5xx、
 * 流没跑完就断、长时间没数据），重试是唯一能自愈的手段。
 * "重试也没用"的那几类在建错误时就打了 retryable=false：HTTP 4xx（除限流/超时那三个）、
 * 模型给了非法的 tool call index（同样的请求发过去还是同一个非法值）。
 */
function isRetryable(err) {
  if (!err) return false
  if (typeof err.retryable === 'boolean') return err.retryable
  return true
}

/** 指数退避 + 抖动；网关给了 Retry-After 就听它的（封顶，免得被一个 3600 挂住半小时）。 */
function retryDelayMs(attempt, err) {
  const exp = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** attempt)
  const jittered = exp / 2 + Math.random() * (exp / 2)
  const hinted = Number.isFinite(err?.retryAfterMs) ? err.retryAfterMs : 0
  return Math.max(jittered, Math.min(hinted, RETRY_MAX_DELAY_MS * 2))
}

/** 可被 abort 打断的 sleep —— 用户点了停止就别在这儿干等下一次重试。 */
function defaultSleep(ms, signal) {
  return new Promise(resolve => {
    if (!(ms > 0) || signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * 跑一次 LLM 流式请求（失败按上面的口径自动重试）。
 *
 * @param {object}   o
 * @param {number}   [o.idleTimeoutMs] 连续多久收不到数据算连接已死（0 = 不判超时）
 * @param {number}   [o.maxRetries]    自动重试次数上限（不含首次尝试）
 * @param {Function} [o.onRetry]       每次重试**之前**调用：
 *                                     `({ attempt, maxRetries, delayMs, error, partial })`，
 *                                     attempt 从 1 开始。调用方拿它把界面上那半截丢掉
 *                                     （partial = 这次尝试已经吐出去的正文/思考/工具调用）。
 * @param {Function} [o.sleepFn]       退避等待（测试注入用，签名 (ms, signal) => Promise）
 */
export async function streamChatOnce({ model, messages, signal, onToken = () => {}, onRetry = null,
  sessionId, extraTools, fetchFn = fetch, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  maxRetries = MAX_LLM_RETRIES, sleepFn = defaultSleep }) {
  const { url, headers } = buildAiChatRequest({ ...model, sessionId })
  const providerKey = `${url}\n${model.model}`
  // 内置 7 个工具是底座;extraTools 是 MCP 等外部能力的叠加(见 extensions.js)。
  // 扩展工具为空时**必须回落到原始数组**,避免把 tools: [] 发给模型。
  const tools = Array.isArray(extraTools) && extraTools.length ? [...TOOL_DEFINITIONS, ...extraTools] : TOOL_DEFINITIONS
  const body = { model: model.model, messages, tools, temperature: 0.3, stream: true }
  if (!withoutStreamUsage.has(providerKey)) body.stream_options = { include_usage: true }
  const abortedByUser = () => Boolean(signal?.aborted)
  const emptyResult = () => ({ content: '', reasoning: '', toolCalls: [], usage: null, aborted: true })
  const stallError = () => new Error(
    `模型响应超时：连续 ${Math.round(idleTimeoutMs / 1000)} 秒没有收到任何数据，请重试或切换模型。`)

  // 一次尝试：建连接 → 收流 → 返回结果。失败时把"已经吐出去的半截"挂在错误上抛给调用方。
  const attemptOnce = async () => {
    const controller = new AbortController()
    let timedOut = false
    let timer = null
    // 每收到一段数据就重置空闲计时（这就是"整条流上限"变"空闲上限"的全部实现）
    const touch = () => {
      if (!(idleTimeoutMs > 0)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timedOut = true; controller.abort() }, idleTimeoutMs)
    }
    const onAbort = () => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', onAbort)
    let content = '', reasoning = '', usage = null, finished = false
    const toolCalls = []

    const consumeLine = line => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) return
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') { finished = true; return }
      if (!payload) return
      let evt
      try { evt = JSON.parse(payload) } catch { throw new Error('Invalid JSON in model stream') }
      if (evt.error) throw new Error(evt.error.message || 'Model stream failed')
      // Usage may arrive after finish_reason, in a final event with choices: [].
      // Events report snapshots, so replace fields instead of summing snapshots.
      const nextUsage = normalizeUsage(evt.usage)
      if (nextUsage) usage = Object.fromEntries(Object.entries(nextUsage).map(([key, value]) => [key, value ?? usage?.[key] ?? null]))
      if (evt.choices?.[0]?.finish_reason) finished = true
      const delta = evt.choices?.[0]?.delta || {}
      const thinking = delta.reasoning_content || delta.reasoning || delta.reasoning_text || ''
      if (thinking) { reasoning += thinking; onToken({ thinking }) }
      if (delta.content) { content += delta.content; onToken({ content: delta.content }) }
      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? 0
        // 非法 index 是模型/网关给的脏数据，同样的请求重发还是同一个脏值 —— 明确不可重试
        if (!Number.isInteger(i) || i < 0 || i > 1024) {
          const err = new Error('Invalid tool call index')
          err.retryable = false
          throw err
        }
        if (!toolCalls[i]) toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } }
        if (tc.id) toolCalls[i].id += tc.id
        if (tc.function?.name) toolCalls[i].function.name += tc.function.name
        if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments
      }
      if (delta.tool_calls?.length) onToken({ toolCalls: true })
    }

    try {
      // 首次计时在请求发出**之前**开始：连响应头都还没回来的那段时间同样算"没有数据"
      touch()
      const request = () => fetchFn(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
      let resp = await request()
      if (!resp.ok) {
        const detail = describeAiHttpError(await resp.text().catch(() => ''), resp.status)
        if ([400, 422].includes(resp.status) && body.stream_options && /stream_options|include_usage/i.test(detail)) {
          // 网关不认 stream_options：去掉它再来一次。这不是"重试"（请求本身没错），
          // 所以不占重试次数，也不通知 onRetry。
          delete body.stream_options
          withoutStreamUsage.add(providerKey)
          touch()
          resp = await request()
        } else throw httpFailure(resp.status, detail, resp.statusText, { retryAfterMs: readRetryAfter(resp) })
      }
      if (!resp.ok || !resp.body) {
        throw httpFailure(resp.status, describeAiHttpError(await resp.text().catch(() => ''), resp.status), resp.statusText,
          { retryAfterMs: readRetryAfter(resp) })
      }
      const decoder = new TextDecoder()
      let buf = ''
      for await (const chunk of resp.body) {
        touch()
        buf += decoder.decode(chunk, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) consumeLine(line)
      }
      buf += decoder.decode()
      if (buf.trim()) consumeLine(buf)
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
      if (!finished) throw new Error('模型响应意外中断，请重试；未执行不完整的工具调用。')
      return { content, reasoning, toolCalls: toolCalls.filter(Boolean), usage, aborted: false }
    } catch (err) {
      if (controller.signal.aborted && !timedOut) {
        return { content, reasoning, toolCalls: [], usage, aborted: true }
      }
      const error = timedOut ? stallError() : err
      error.usage = usage
      // 这次尝试已经吐给 onToken 的东西。调用方在重试前必须把它丢掉，
      // 否则界面上会出现"半截 + 重来一遍"拼在一起的两段话。
      error.partial = { content, reasoning, toolCalls: toolCalls.filter(Boolean) }
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  for (let attempt = 0; ; attempt++) {
    if (abortedByUser()) return emptyResult()
    try {
      return await attemptOnce()
    } catch (err) {
      // 用户点的停止不是故障，绝不重试
      if (abortedByUser()) throw err
      if (!isRetryable(err) || attempt >= maxRetries) throw err
      const delayMs = retryDelayMs(attempt, err)
      try {
        onRetry?.({ attempt: attempt + 1, maxRetries, delayMs, error: err, partial: err.partial })
      } catch { /* onRetry 是调用方的界面钩子，它自己抛错不该吃掉这次重试 */ }
      await sleepFn(delayMs, signal)
      // 退避期间用户点了停止：当"已中止"收场，别再抛一个超时错误吓他
      if (abortedByUser()) return emptyResult()
    }
  }
}

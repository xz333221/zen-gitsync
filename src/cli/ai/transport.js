import { TOOL_DEFINITIONS } from './tools.js'
import { buildAiChatRequest, describeAiHttpError } from '../../utils/aiEndpoint.js'
import { normalizeUsage } from './telemetry.js'

// Some compatible gateways reject stream_options. Remember that for this process.
const withoutStreamUsage = new Set()

export async function streamChatOnce({ model, messages, signal, onToken = () => {}, sessionId,
  fetchFn = fetch, timeoutMs = 300000 }) {
  const { url, headers } = buildAiChatRequest({ ...model, sessionId })
  const providerKey = `${url}\n${model.model}`
  const body = { model: model.model, messages, tools: TOOL_DEFINITIONS, temperature: 0.3, stream: true }
  if (!withoutStreamUsage.has(providerKey)) body.stream_options = { include_usage: true }
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
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
      if (!Number.isInteger(i) || i < 0 || i > 1024) throw new Error('Invalid tool call index')
      if (!toolCalls[i]) toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } }
      if (tc.id) toolCalls[i].id += tc.id
      if (tc.function?.name) toolCalls[i].function.name += tc.function.name
      if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments
    }
    if (delta.tool_calls?.length) onToken({ toolCalls: true })
  }
  try {
    const request = () => fetchFn(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
    let resp = await request()
    if (!resp.ok) {
      const detail = describeAiHttpError(await resp.text().catch(() => ''), resp.status)
      if ([400, 422].includes(resp.status) && body.stream_options && /stream_options|include_usage/i.test(detail)) {
        delete body.stream_options
        withoutStreamUsage.add(providerKey)
        resp = await request()
      } else throw new Error(`HTTP ${resp.status}: ${detail || resp.statusText}`)
    }
    if (!resp.ok || !resp.body) {
      throw new Error(`HTTP ${resp.status}: ${describeAiHttpError(await resp.text().catch(() => ''), resp.status) || resp.statusText}`)
    }
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of resp.body) {
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
    const error = timedOut ? new Error('模型响应超时，请重试或切换模型。') : err
    error.usage = usage
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

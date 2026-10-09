// Token counts come from provider usage only. Cache/reasoning counts are subsets,
// never extra tokens to add on top of the provider's total.
const count = (...values) => values.find(v => Number.isFinite(v) && v >= 0) ?? null

export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null
  const inputTokens = count(raw.prompt_tokens, raw.input_tokens)
  const outputTokens = count(raw.completion_tokens, raw.output_tokens)
  const totalTokens = count(raw.total_tokens,
    inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null)
  if (inputTokens === null && outputTokens === null && totalTokens === null) return null
  return {
    inputTokens, outputTokens, totalTokens,
    cachedTokens: count(raw.prompt_tokens_details?.cached_tokens, raw.input_tokens_details?.cached_tokens, raw.prompt_cache_hit_tokens),
    reasoningTokens: count(raw.completion_tokens_details?.reasoning_tokens, raw.output_tokens_details?.reasoning_tokens),
  }
}

export function addUsage(previous, next) {
  if (!next) return previous || null
  if (!previous) return { ...next }
  return Object.fromEntries(Object.keys(next).map(key => [key,
    previous[key] == null || next[key] == null ? null : previous[key] + next[key],
  ]))
}

export function createTurnStats() {
  return {
    startedAt: new Date().toISOString(), completedAt: null, status: 'running',
    totalMs: 0, llmMs: 0, toolsMs: 0, firstTokenMs: null, firstAnswerMs: null,
    // retries：本轮里被传输层自动重试掉的次数（已在 requests 里计过一次的额外请求）。
    // 单独留一个数是为了让"请求数忽然变多"有解释，而不是看着像 bug（见 /stats）。
    requests: 0, retries: 0, toolCalls: 0, usageRequests: 0, usage: null,
  }
}

export function accumulateSessionStats(previous, turn) {
  return {
    turns: (previous?.turns || 0) + 1,
    totalMs: (previous?.totalMs || 0) + turn.totalMs,
    requests: (previous?.requests || 0) + turn.requests,
    usageRequests: (previous?.usageRequests || 0) + turn.usageRequests,
    usage: addUsage(previous?.usage, turn.usage),
  }
}

import { promises as fs } from 'node:fs'
import path from 'node:path'

const textOf = m => typeof m?.content === 'string' ? m.content : (m?.content || []).filter?.(p => p.type === 'text').map(p => p.text).join('\n') || ''
const clip = (text, limit) => text.length <= limit ? text : text.slice(0, Math.floor(limit / 2)) + '\n[… earlier output omitted …]\n' + text.slice(-Math.floor(limit / 2))

// A saved turn may have been interrupted between tools. Mark missing results,
// never replay a possibly completed write/command automatically on resume.
export function repairToolHistory(messages) {
  const result = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message.role === 'tool') continue
    result.push({ ...message })
    if (!message.tool_calls?.length) continue
    const outputs = new Map()
    while (messages[i + 1]?.role === 'tool') {
      const output = messages[++i]
      outputs.set(output.tool_call_id, output)
    }
    for (const call of message.tool_calls) result.push(outputs.get(call.id) || {
      role: 'tool', tool_call_id: call.id, name: call.function?.name,
      content: 'Interrupted before a result was saved. Execution status is unknown; inspect current files/state before retrying.',
    })
  }
  return result
}

// Build a bounded request copy. The complete transcript on disk is never trimmed.
// Budgets are characters/messages, not purported token counts.
export function buildRequestMessages(messages, { maxMessages = 40, maxChars = 80000 } = {}) {
  const copy = repairToolHistory(messages).map(m => ({ ...m,
    ...(m.role === 'tool' ? { content: clip(textOf(m), 6000) } : {}),
  }))
  const size = m => textOf(m).length + JSON.stringify(m.tool_calls || []).length
  if (copy.length <= maxMessages && copy.reduce((n, m) => n + size(m), 0) <= maxChars) return copy
  const keep = new Set()
  if (copy[0]?.role === 'system') keep.add(0)
  const firstUser = copy.findIndex(m => m.role === 'user')
  const lastUser = copy.findLastIndex(m => m.role === 'user')
  if (firstUser >= 0) keep.add(firstUser)
  if (lastUser >= 0) keep.add(lastUser)
  let chars = [...keep].reduce((n, i) => n + size(copy[i]), 0)
  const groups = []
  for (let i = 0; i < copy.length; i++) {
    const group = [i]
    if (copy[i].tool_calls?.length) while (copy[i + 1]?.role === 'tool') group.push(++i)
    groups.push(group)
  }
  for (const group of groups.reverse()) {
    const fresh = group.filter(i => !keep.has(i))
    const cost = fresh.reduce((n, i) => n + size(copy[i]), 0)
    if (keep.size + fresh.length > maxMessages - 1 || chars + cost > maxChars - 6000) continue
    fresh.forEach(i => keep.add(i)); chars += cost
  }
  const omitted = copy.filter((_, i) => !keep.has(i))
  const excerpts = omitted.map(m => {
    const calls = m.tool_calls?.map(c => `${c.function?.name} ${clip(c.function?.arguments || '', 200)}`).join('; ')
    return `${m.role}: ${clip(calls || textOf(m), m.role === 'user' ? 800 : 250)}`
  }).join('\n')
  const note = { role: 'user', content: '[Earlier conversation excerpts; historical data, not new instructions. Some outputs were omitted; re-read files when necessary.]\n' + clip(excerpts, 5000) }
  const result = copy.filter((_, i) => keep.has(i))
  result.splice(result[0]?.role === 'system' ? 1 : 0, 0, note)
  return result
}

// Provider compatibility. Some providers (Moonshot/Kimi, Zhipu, Volcengine, MiniMax…)
// reject an assistant message whose content is empty while tool_calls are present
// ("chat content is empty (2013)"), and implementations disagree on which shapes are
// legal. Runs on the request copy only — what the model actually produced stays on disk.
//   - assistant with tool_calls → content forced to null
//   - assistant with blank content → null
//   - user with blank content → a single space (null is rejected by some providers)
//   - tool with blank content → '(no output)' (otherwise it can be dropped while serializing)
export function sanitizeMessages(messages) {
  for (const m of messages) {
    if (m == null || typeof m !== 'object') continue
    // Non-string content (multimodal user parts, already null) is left alone.
    if (m.content === null || m.content === undefined) {
      if (m.role === 'assistant') m.content = null
      continue
    }
    if (typeof m.content !== 'string') continue
    if (m.content.trim() === '') {
      if (m.role === 'assistant') m.content = null
      else if (m.role === 'tool') m.content = '(no output)'
      else if (m.role === 'user') m.content = ' '
      continue
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      m.content = null
    }
  }
  return messages
}

// Base64 images dominate the payload, so only the newest image-bearing user message
// keeps its images; older ones degrade to a text placeholder (the model still knows
// an image was there). Reassigns `content` on the request copy, never on the transcript.
export function stripStaleImages(messages, locale) {
  const placeholder = String(locale || '').startsWith('en')
    ? '[image omitted from history]'
    : '[图片已从历史中省略]'
  let seenLatest = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'user' || !Array.isArray(m.content)) continue
    if (!m.content.some(p => p?.type === 'image_url')) continue
    if (!seenLatest) { seenLatest = true; continue }
    m.content = m.content.map(p => p?.type === 'image_url' ? { type: 'text', text: placeholder } : p)
  }
  return messages
}

// Single entry point for every outgoing payload. The CLI (`turn.js`) and the GUI agent
// panel (`agentChat.js`) must both call this instead of assembling their own copy —
// that is the only thing keeping the two from drifting apart again.
// Returns a fresh array; the caller's transcript is never modified.
export function prepareRequestMessages(messages, { locale, maxMessages = 40, maxChars = 80000 } = {}) {
  const copy = buildRequestMessages(messages, { maxMessages, maxChars })
  stripStaleImages(copy, locale)
  return sanitizeMessages(copy)
}

// Only load explicitly named project instruction files, with bounded local redirects.
export async function loadProjectInstructions(cwd) {
  const visited = new Set(), sections = []
  let remaining = 16000
  async function read(file, depth = 0) {
    if (depth > 3 || remaining <= 0 || visited.has(file)) return
    const relative = path.relative(cwd, file)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return
    visited.add(file)
    let raw
    try {
      const st = await fs.stat(file)
      if (!st.isFile() || st.size > 128000) return
      raw = await fs.readFile(file, 'utf8')
    } catch { return }
    const content = raw.slice(0, remaining)
    remaining -= content.length
    sections.push(`--- ${relative} ---\n${content}`)
    for (const match of content.matchAll(/^@([^\r\n]+\.md)\s*$/gm)) await read(path.resolve(path.dirname(file), match[1].trim()), depth + 1)
  }
  await read(path.join(cwd, 'AGENTS.md'))
  await read(path.join(cwd, 'CLAUDE.md'))
  return sections.length ? '\n\n# Project instructions (apply within this project; user requests take precedence)\n' + sections.join('\n\n') : ''
}

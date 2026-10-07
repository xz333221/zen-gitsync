import { promises as fs } from 'node:fs'
import path from 'node:path'

const textOf = m => typeof m?.content === 'string' ? m.content : (m?.content || []).filter?.(p => p.type === 'text').map(p => p.text).join('\n') || ''
const imagePartsOf = content => Array.isArray(content) ? content.filter(p => p?.type === 'image_url') : []
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
  // tool 消息的正文按 6000 字符截断,但**图片部件必须原样留着**。这里以前是
  // `content: clip(textOf(m), 6000)` 直接覆盖 —— 那会把 read_image 刚附上的图
  // 悄悄删掉,而模型仍然收到"已读取图片 xxx.png"的文本,于是理直气壮地编内容。
  // (有单测钉住这条:tool 消息里的图必须活到请求体。)
  const copy = repairToolHistory(messages).map(m => {
    if (m.role !== 'tool') return { ...m }
    const images = imagePartsOf(m.content)
    const text = clip(textOf(m), 6000)
    return { ...m, content: images.length ? [{ type: 'text', text }, ...images] : text }
  })
  // size 只算文本:图片是 base64,一张截图就上百万字符。若把它计进预算,第一轮
  // 就会因为"超预算"把刚读进来的那张图所在的消息组整组丢掉 —— 越需要看图越丢图。
  // 图片总量另有约束:stripStaleImages 只留最新一张,详见那里的注释。
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

// Base64 images dominate the payload, so only the newest image-bearing message
// keeps its images; older ones degrade to a text placeholder (the model still knows
// an image was there). Reassigns `content` on the request copy, never on the transcript.
//
// 覆盖**两种**能带图的角色,而且它们共用同一个"最新"名额:
//   - user → 用户粘贴 / 附件发的图(gai 的 /image、Alt+V、Web 面板附件框)
//   - tool → read_image 自己读进来的图
// 为什么必须共用名额而不是各留一张:一个"看截图改样式"的任务里,模型会连着读好几张
// 图,每张都随历史每轮重发,几张 4MB 的图能把上下文和账单一起顶穿。
export function stripStaleImages(messages, locale) {
  const placeholder = String(locale || '').startsWith('en')
    ? '[image omitted from history]'
    : '[图片已从历史中省略]'
  let seenLatest = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const parts = Array.isArray(m?.content) ? m.content : null
    if (!parts || !parts.some(p => p?.type === 'image_url')) continue
    if (!seenLatest) { seenLatest = true; continue }
    m.content = parts.map(p => p?.type === 'image_url' ? { type: 'text', text: placeholder } : p)
  }
  return messages
}

// 已经不含图片的多模态数组一律塌回字符串。理由:OpenAI 兼容的各家实现里,
// 「content 是数组」的支持面明显窄于「content 是字符串」,Moonshot / 智谱 /
// MiniMax 这些在别处已经踩过形状坑(见下面 sanitizeMessages 的注释)。
// 塌回字符串等于让被省略掉图的那条历史走最保守的线格式,不赌厂商实现。
export function collapseTextParts(messages) {
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue
    if (m.content.some(p => p?.type === 'image_url')) continue
    m.content = m.content.filter(p => p?.type === 'text').map(p => p.text || '').join('\n')
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
  collapseTextParts(copy)
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

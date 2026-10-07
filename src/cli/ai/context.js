import { promises as fs } from 'node:fs'
import path from 'node:path'

const textOf = m => typeof m?.content === 'string' ? m.content : (m?.content || []).filter?.(p => p.type === 'text').map(p => p.text).join('\n') || ''
const imagePartsOf = content => Array.isArray(content) ? content.filter(p => p?.type === 'image_url') : []
const clip = (text, limit) => text.length <= limit ? text : text.slice(0, Math.floor(limit / 2)) + '\n[… earlier output omitted …]\n' + text.slice(-Math.floor(limit / 2))

// ── 请求预算 ──────────────────────────────────────────────────────────────
// 每轮请求的两把尺子：条数 + 字符。默认值与历史行为一致（40 条 / 80,000 字符）。
//
// 为什么要可配：模型窗口差异极大（8k 到 1M），一刀切 80k 会让大窗口模型吃不满、
// 却又要为小窗口兜底。全局配置 aiMaxRequestChars（设置 → AI 模型配置 → 智能体运行时）
// 由用户按自己模型的窗口来调，越界值夹取到 [20,000, 1,000,000]。
//
// 2026-10-07 事故复盘（主 Agent 控制台单轮 1132 次工具调用死循环）：用户把 11 万字符的
// 任务导出粘进对话，**单条 user 消息自己就超过整个预算**；裁剪算法无条件保留最后一条
// user 消息 → 保留集开局就超预算 → 从最近往前补工具消息组时逐条被拒 → 模型看不到自己
// 刚读到的任何内容，只能一遍遍重读同一个文件。修复分两层：
//   ① 单条 user 消息像 tool 消息一样截断（maxUserChars，首尾保留）—— 任何一条消息
//      都挤不掉别人；
//   ② 预算可调大 —— 模型窗口装得下的用户，不必再被 80k 卡住。
export const AI_REQUEST_CHARS_MIN = 20000
export const AI_REQUEST_CHARS_MAX = 1000000
// 默认预算（字符）。config.js 的 defaultConfig.aiMaxRequestChars 引用它，保证一处定义。
//
// 2026-10-07 第二次调整：80,000 → 400,000（同日）。理由是拿本机一场真实会话回放出来的：
//   · 字符↔token 实测 1 token ≈ 2.57 字符（该会话 525 万字符 ≈ 204 万 token，
//     中文字 86 万 / ascii 407 万），所以旧默认只等于 **31k token**。
//   · 当代旗舰窗口已经全是 1M 一档（GPT-6.1 Sol 1,050,000 / Claude Opus 5.5 1,000,000
//     / Gemini 3.5 Flash 1,000,000 / DeepSeek V4 1,000,000 / Qwen3.8 Max 1,000,000），
//     31k 只占 **3%** —— 一半以上的模型窗口是空着的。
//   · 400,000 字符 ≈ 156k token，**仍在 OpenAI 的 272k 长上下文计价线之下**
//     （GPT-6/6.1/5.6 家族对 >272k 输入按整请求 2x 输入 + 1.5x 输出计价），
//     所以这一档"装得下又不触发涨价"。真要更大请往上调，但那是拿钱换窗口。
export const REQUEST_DEFAULT_MAX_CHARS = 400000
export const REQUEST_DEFAULT_MAX_MESSAGES = 40

/**
 * 规范化单条请求的字符预算。与 normalizeAiMaxToolIterations 同一套语义：
 * 越界夹取（手改成天文数字的意图是"想更大"，夹到上限比悄悄回落默认更贴近意图），
 * 完全无法解析（undefined / 'abc'）才返回 null，交给调用方取默认值。
 */
export function normalizeAiRequestChars(value) {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const int = Math.floor(n)
  if (int < AI_REQUEST_CHARS_MIN) return AI_REQUEST_CHARS_MIN
  if (int > AI_REQUEST_CHARS_MAX) return AI_REQUEST_CHARS_MAX
  return int
}

/**
 * 由配置值解析出三个预算参数（字符上限 / 消息条数上限 / 单条 user 截断线）。
 * 非法/缺省一律回落默认（400,000 字符）。
 *
 * 条数与单条线都随字符预算**等比缩放** —— 用户只调一个数，三个数不许各自漂移：
 *   · maxMessages = 字符预算 / 1000，下限保持默认 40 条、上限 600 条。
 *     **分母为什么是 1000 而不是原来的 2000**：条数上限存在的意义是"别让请求
 *     长到 provider 拒收"，而字符预算才是真正的闸门。实测（525 组工具调用的真实
 *     会话）每条消息约 2,700 字符，所以 /1000 意味着条数只在字符预算用满之前
 *     就先撞顶的极端情况下才生效；/2000 会让它在预算只用到一半时就卡住 ——
 *     旧默认 80k 就是这么把 40 条变成真瓶颈的（实测只填到 57,638/80,000 字符，
 *     仅覆盖整场会话的 2.1% 工具调用轮）。改大字符预算而不动这个分母，等于白改。
 *   · maxUserChars —— 单条 user 消息的上限，默认 120,000 字符（≈47k token 中文）。
 *     它决定了"一条超长粘贴最多能吃掉多少预算"：被截断时首尾都保留（见 clip），
 *     指令通常在开头、最新的追问在结尾，两边都不丢；中间省略处带明确标记。
 *     上限还绑了 maxChars - 12000，保证单条消息永远挤不掉"最近发生了什么"。
 */
export function resolveRequestBudget(configuredMaxChars) {
  const maxChars = normalizeAiRequestChars(configuredMaxChars) ?? REQUEST_DEFAULT_MAX_CHARS
  const maxMessages = Math.min(Math.max(Math.round(maxChars / 1000), REQUEST_DEFAULT_MAX_MESSAGES), 600)
  const maxUserChars = Math.min(Math.max(Math.floor(maxChars * 0.3), 8000), 500000, maxChars - 12000)
  return { maxChars, maxMessages, maxUserChars }
}

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
export function buildRequestMessages(messages, {
  maxMessages = resolveRequestBudget(REQUEST_DEFAULT_MAX_CHARS).maxMessages,
  maxChars = REQUEST_DEFAULT_MAX_CHARS,
  maxUserChars = resolveRequestBudget(maxChars).maxUserChars,
} = {}) {
  // tool 消息的正文按 6000 字符截断,但**图片部件必须原样留着**。这里以前是
  // `content: clip(textOf(m), 6000)` 直接覆盖 —— 那会把 read_image 刚附上的图
  // 悄悄删掉,而模型仍然收到"已读取图片 xxx.png"的文本,于是理直气壮地编内容。
  // (有单测钉住这条:tool 消息里的图必须活到请求体。)
  //
  // user 消息同理、但上限不同（maxUserChars，默认 24,000）：单条超长粘贴不许
  // 挤掉全部工具结果 —— 2026-10-07 的 1132 次调用死循环就是"11 万字符的 user
  // 消息独占保留集"造成的（复盘见文件头的请求预算一节）。多模态消息同样只裁
  // 文本、图原样保留。
  const copy = repairToolHistory(messages).map(m => {
    if (m.role === 'tool') {
      const images = imagePartsOf(m.content)
      const text = clip(textOf(m), 6000)
      return { ...m, content: images.length ? [{ type: 'text', text }, ...images] : text }
    }
    if (m.role === 'user') {
      const images = imagePartsOf(m.content)
      const text = clip(textOf(m), maxUserChars)
      return { ...m, content: images.length ? [{ type: 'text', text }, ...images] : text }
    }
    return { ...m }
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
//
// ⚠️ maxMessages / maxUserChars **从 maxChars 派生**，不各自带常量默认值。
// 带独立默认值会造出一个病态组合：调用方只传 maxChars（或什么都不传）时拿到
// 「40 条 / 400k 字符」—— 字符预算永远用不完，条数提前卡死，实测只用到 72% 的字符、
// 覆盖 2.1% 的工具调用轮。那正是 2026-10-07 之前默认值的真实形态，别再让它回来。
// （REQUEST_DEFAULT_MAX_MESSAGES 只作为 resolveRequestBudget 里的**下限**存在，
//   不是本函数的默认值。）
export function prepareRequestMessages(messages, {
  locale,
  maxChars = REQUEST_DEFAULT_MAX_CHARS,
  maxMessages = resolveRequestBudget(maxChars).maxMessages,
  maxUserChars = resolveRequestBudget(maxChars).maxUserChars,
} = {}) {
  const copy = buildRequestMessages(messages, { maxMessages, maxChars, maxUserChars })
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

import { promises as fs } from 'node:fs'
import path from 'node:path'

const textOf = m => typeof m?.content === 'string' ? m.content : (m?.content || []).filter?.(p => p.type === 'text').map(p => p.text).join('\n') || ''
const imagePartsOf = content => Array.isArray(content) ? content.filter(p => p?.type === 'image_url') : []
const clip = (text, limit) => text.length <= limit ? text : text.slice(0, Math.floor(limit / 2)) + '\n[… earlier output omitted …]\n' + text.slice(-Math.floor(limit / 2))

// ── token 估算（必须定义在裁剪算法之前）────────────────────────────
//
// 为什么不放在文件后面的「占用测量」那节：buildRequestMessages 的预算累加现在
// 直接用本函数，而 const 箭头函数**不会**被hoist —— 放在后面会在真跑起来时撞
// TDZ（ReferenceError），报错信息还不指向原因，很难一眼看出。
//
// 为什么必须按 token 而不是字符：预算是"别让请求被 provider 拒收"，而 provider
// 只认 token。用字符当闸门，纯中文内容（1 字 = 1 token）会多出 1.5 倍 ——
// 实测本机那条 525轮会话是 2.37 字符/token（大量 ascii），但同一段代码换成中文
// 注释就掉到 1.6，纯中文正文更低。改 token 口径后这个偏差不再影响闸门。
//
// 系数从真实负载校准（2026-10-07，ag-muxglt4p：525 万字符 ≈ 228 万 token）：
// 中文 1 字/token、ascii 3.5 字符/token，其他 2 字符/token。
// 只用于**估算** —— provider 报的真实 usage 才是权威（见 measureContextUsage）。
const CJK_RE = /[㐀-鿿豈-﫿　-〿＀-￯]/g
const ASCII_RE = /[ -~]/g
const ASCII_TOKEN_CHARS = 3.5
const CJK_TOKEN_PER_CHAR = 1
const OTHER_TOKEN_CHARS = 2

/** 估算一段文本的 token 数。空/非字符串一律 0。 */
export function estimateTokens(text) {
  const s = typeof text === 'string' ? text : ''
  if (!s) return 0
  const cjk = (s.match(CJK_RE) || []).length
  const ascii = (s.match(ASCII_RE) || []).length
  const rest = s.length - cjk - ascii
  return Math.ceil(cjk * CJK_TOKEN_PER_CHAR + ascii / ASCII_TOKEN_CHARS + rest / OTHER_TOKEN_CHARS)
}

/**
 * token 上限 → 字符上限（**保守**换算，给按字符切的地方用）。
 *
 * 为什么要有这个：单条消息的截断（clip）拿到的必须还是"字符数"，而预算闸门
 * 已经是 token 了。两者之间需要一个换算，而它**只能偏小** —— 宁可少留一点内容，
 * 也不能让实际 token 超过用户设的上限。所以用 1.5 字符/token（而不是实测的 2.37）：
 * 中文最坏情况（1 字 1 token）仍留 1.5 倍余量；纯 ascii 时只用掉 62% 预算，
 * 属于安全侧的浪费。
 */
const TOKEN_TO_CHARS_CONSERVATIVE = 1.5
export const tokenToChars = tokens => Math.max(Math.floor(tokens * TOKEN_TO_CHARS_CONSERVATIVE), 1000)

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
export const AI_REQUEST_TOKENS_MIN = 20000
export const AI_REQUEST_TOKENS_MAX = 1000000
// 默认预算（token）。config.js 的 defaultConfig.aiMaxRequestTokens 引用它，保证一处定义。
//
// 2026-10-07 第三次调整：字符口径 → token 口径，同日把默认从 80k 字符一路放到
// 1,000,000 token。三个理由：
//
//   ① **单位对齐**。用户的模型都是 1M 档（已核对官方文档）：
//      · MiniMax-M3 —— 官方页面写"up to 1M tokens context window"
//      · DeepSeek V4 Flash —— 官方 API 文档 CONTEXT LENGTH 1M，且**默认就是 1M**
//      界面里写"字符"逼着用户心算「400k 字符 ≈ 多少 token」，这本身就是 bug 源。
//
//   ② **字符口径在中文场景会超窗口**。provider 只认 token；纯中文 1 字 = 1 token，
//      而实测那条 525轮会话是 2.37 字符/token（大量 ascii）。同一段代码换成中文
//      注释就掉到 1.6，纯中文正文更低 —— 按字符设闸门 = 按最坏情况少留、
//      按最好情况超窗口。改成 token 累加后这个偏差彻底消失。
//
//   ③ **成本不是障碍**（这条推翻了我自己上一轮的建议）。DeepSeek V4 Flash 输入
//      ¥1/1M token，但**缓存命中只¥0.02/1M**（50 倍差价），而工具循环每轮都重发
//      **完全相同的前缀**，缓存命中率极高。1M token 每轮实际只花 ¥0.02。
//      （OpenAI 那套 >272k 整请求 2x 的规则只对 GPT-6/6.1/5.6 家族成立。）
// 默认给 **800,000 token 而不是顶格的 1,000,000** —— 这是刻意的。
// 模型标称的 1M 是"输入 + 输出 + reasoning 共享"的天花板：gai 每一轮都要留出
// 位置给模型的回复（DeepSeek V4 Flash / MiniMax M3 的 max output 都是 128K~384K
// 量级），而 thinking 模式的 reasoning token **同样占窗口**。顶格 1M 意味着
// 历史一满，请求就因为"输出放不下"被 provider 拒掉 —— 表现为莫名其妙的 400。
// 留 20% 余量（约 20 万 token）足够正常回复 + 长推理。
export const REQUEST_DEFAULT_MAX_TOKENS = 800000
export const REQUEST_DEFAULT_MAX_MESSAGES = 40

/**
 * 规范化 token 预算。与 normalizeAiMaxToolIterations 同一套语义：
 * 越界夹取（手改成天文数字的意图是"想更大"，夹到上限比悄悄回落默认更贴近意图），
 * 完全无法解析（undefined / 'abc'）才返回 null，交给调用方取默认值。
 */
export function normalizeAiRequestTokens(value) {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const int = Math.floor(n)
  if (int < AI_REQUEST_TOKENS_MIN) return AI_REQUEST_TOKENS_MIN
  if (int > AI_REQUEST_TOKENS_MAX) return AI_REQUEST_TOKENS_MAX
  return int
}

/**
 * 旧配置项 `aiMaxRequestChars`（字符）→ 新口径的 token 值。
 *
 * 为什么需要迁移而不是直接回落默认：用户**已经存在**的 config.json 里存着旧值
 * （本机就是 80,000），改字段名后它读不到 → 静默回落 1M，等于把用户的设置清了。
 * 按实测换比 2.37 字符/token 折算，80,000 字符 ≈ 34k token。
 *
 * 注意这是**有损**的（估算换算），但只影响一次迁移，且落在用户原意附近。
 * 反向（旧 token 值 → 字符）不做：那会让 config.js 里出现两个方向的换算，
 * 早晚有一处忘了更新。
 */
export function migrateLegacyCharsToTokens(charsValue) {
  const chars = Number(charsValue)
  if (!Number.isFinite(chars) || chars <= 0) return null
  // 用实测换比（525 轮工具调用负载）而非理论值，那是这类会话的典型形态
  return Math.round(chars / 2.37)
}

/**
 * 由配置值解析出四个预算参数。
 * 非法/缺省一律回落默认（1,000,000 token）。
 *
 * 三者都随 token 预算**等比缩放** —— 用户只调一个数，其余不许各自漂移：
 *   · maxChars —— **给按字符切的地方用**（单条 user / tool 消息的截断线），
 *     由 token 预算保守换算而来（见 tokenToChars）。
 *   · maxMessages —— 条数上限 = token 预算 / 400，下限 40、上限 4000。
 *     **分母 400 是实测各形态 token 跨度后定的**：单条消息的 token 数随内容形态
 *     差 21 倍（实测 2026-10-07，同一把尺子量出来的）：
 *       · 短 tool_calls（path 只有几十字符）→118 token
 *       · ascii 工具结果 4,000 字符 → 1,143 token（clip 后 6,000 → 1,715）
 *       · 中文 2,000 字 → 2,000 token
 *       · 中文注释 + ascii 代码混合 → 2,572 token
 *     条数上限的作用是"别让请求长到 provider 拒收"，**token 闸门才是真闸门**。
 *     分母取最省的常见形态（400，略高于 118 那档，留出余量），意味着任何形态下
 *     都是 token 先耗尽。反面教材（都是这轮实测踩到的）：
 *       分母 2500 → 1M 档只给 400 条，纯 ascii 场景 400×584 = 23 万（23%）
 *       分母 1200 → 833 条 × 584 = 49 万（49%）
 *       分母 700  → 1429 条 × 584 = 83.5 万（83.5%）
 *     也就是分母每放大一档，就多浪费一截预算 —— 而这个浪费**用户看不到**，
 *     只会表现为"上限设了 1M 但条数远远没到就停了"。
 *     上限 4000兜底极端轻内容：118 token × 4000 = 47 万（这时是条数先到顶，
 *     但那种消息本身就这么小，撑不满 1M 不是缺陷）。
 *   · maxUserChars —— 单条 user 消息的截断线，上限绑 maxChars - 12000，
 *     保证单条消息永远挤不掉"最近发生了什么"。
 */
export function resolveRequestBudget(configuredMaxTokens) {
  const maxTokens = normalizeAiRequestTokens(configuredMaxTokens) ?? REQUEST_DEFAULT_MAX_TOKENS
  const maxChars = tokenToChars(maxTokens)
  const maxMessages = Math.min(Math.max(Math.round(maxTokens / 400), REQUEST_DEFAULT_MAX_MESSAGES), 4000)
  const maxUserChars = Math.min(Math.max(Math.floor(maxTokens * 0.3), 8000), 500000, maxChars - 12000)
  return { maxTokens, maxChars, maxMessages, maxUserChars }
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
export function buildRequestMessages(messages, budget = {}) {
  const { maxTokens, maxChars, maxMessages, maxUserChars } = { ...resolveRequestBudget(), ...budget }
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
  // 预算闸门按 **token** 累加（不是字符）。provider 只认 token，用字符设闸门
  // 在纯中文内容上会超窗口 —— 纯中文 1 字 = 1 token，而实测那条 525 轮会话
  // 是 2.37 字符/token。estimateTokens 的精度对闸门足够（宁可略保守）。
  // 图片**不计入**：base64 一张截图就上百万字符，计进预算会把刚读进来的那张图
  // 所在消息组整组丢掉 —— 越需要看图越丢图。图片总量另有约束
  // （stripStaleImages 只留最新一张，详见那里的注释）。
  if (copy.length <= maxMessages && copy.reduce((n, m) => n + messageTokens(m), 0) <= maxTokens) return copy
  const keep = new Set()
  if (copy[0]?.role === 'system') keep.add(0)
  const firstUser = copy.findIndex(m => m.role === 'user')
  const lastUser = copy.findLastIndex(m => m.role === 'user')
  if (firstUser >= 0) keep.add(firstUser)
  if (lastUser >= 0) keep.add(lastUser)
  let used = [...keep].reduce((n, i) => n + messageTokens(copy[i]), 0)
  const groups = []
  for (let i = 0; i < copy.length; i++) {
    const group = [i]
    if (copy[i].tool_calls?.length) while (copy[i + 1]?.role === 'tool') group.push(++i)
    groups.push(group)
  }
  for (const group of groups.reverse()) {
    const fresh = group.filter(i => !keep.has(i))
    const cost = fresh.reduce((n, i) => n + messageTokens(copy[i]), 0)
    // 留 5% 余量：估算有误差，贴着上限装满容易在 provider 侧撞到 400
    if (keep.size + fresh.length > maxMessages - 1 || used + cost > maxTokens * 0.95) continue
    fresh.forEach(i => keep.add(i)); used += cost
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
export function prepareRequestMessages(messages, budget = {}) {
  const { locale } = budget
  const copy = buildRequestMessages(messages, budget)
  stripStaleImages(copy, locale)
  collapseTextParts(copy)
  return sanitizeMessages(copy)
}

// ── 上下文占用测量（给 UI 显示"这次请求占了多少"）─────────────────────
//
// 为什么单独一个函数而不是让调用方自己算：
//   · token 数没有真值 —— 只有 provider 返回的 usage 才是权威，而它在**响应回来之后**
//     才有。一轮工具循环里要在**请求发出去之前**就知道这次会带多少过去，只能估。
//   · 估法必须一处。CLI（turn.js）与 Web（agentChat.js）各估一次必然漂移 —— 这仓库
//     已经被"同一口径写两遍"坑过（提示词四处、路径归一三处，失效方式是不报错、
//     两个入口表现不一样）。所以只有这一份。
//
// 这一节的估算函数已提到文件头部（裁剪算法要用，且 const 不会 hoist）。
// 为什么只留一份：CLI（turn.js）与 Web（agentChat.js）各估一次必然漂移 —— 这仓库
// 已经被"同一口径写两遍"坑过（提示词四处、路径归一三处，失效方式是不报错、
// 两个入口表现不一样）。精度只够画进度条/当闸门，不足以算钱；真要精确用量
// 请看 provider 报的 usage（CLI 的 /stats 有，Web 侧见 agentChat.js 的 context 事件）。

// 与 buildRequestMessages 里的 size() 同一口径：只算文本，不算图片 base64
// （图片是 base64，一张截图就上百万字符，计进预算会把进度条顶满）。
const messageTextSize = m => textOf(m).length + JSON.stringify(m.tool_calls || []).length
/** 消息的 token 估算：正文 + tool_calls 参数的序列化长度。图片不算。 */
const messageTokens = m => estimateTokens(textOf(m)) + estimateTokens(JSON.stringify(m.tool_calls || []))

/**
 * 量一次请求的实际占用。给 UI 画圆环/进度条用，不参与任何裁剪决策。
 *
 * 主口径是 **token**（与裁剪算法同一个闸门），`chars` 只作附带信息。
 * 之前主口径是字符，那是错的：用户看到"80,000 字符"根本不知道等于多少 token，
 * 而模型窗口是按 token 计的。
 *
 * @param {Array} requestMessages 已经过 prepareRequestMessages 的**请求副本**
 * @param {object} opts
 * @param {number} opts.maxTokens     当前预算的 token 上限（画环的分母）
 * @param {number} opts.maxMessages   当前预算的条数上限
 * @param {number} [opts.maxChars]    当前预算的字符换算值（原样带回，供 UI 附带显示）
 * @param {Array}  [opts.transcript]  磁盘上的完整会话，算"被裁掉了多少"用
 * @returns {{
 *   chars: number, tokens: number, estTokens: number, messages: number, images: number,
 *   maxTokens: number, maxMessages: number, maxChars: number | null,
 *   tokenRatio: number, messageRatio: number,
 *   transcriptMessages: number, transcriptChars: number, droppedMessages: number
 * }}
 */
export function measureContextUsage(requestMessages, { maxTokens = REQUEST_DEFAULT_MAX_TOKENS, maxMessages = REQUEST_DEFAULT_MAX_MESSAGES, maxChars = null, transcript = null } = {}) {
  const messages = Array.isArray(requestMessages) ? requestMessages : []
  let chars = 0
  let images = 0
  let tokens = 0
  for (const m of messages) {
    chars += messageTextSize(m)
    tokens += messageTokens(m)
    if (Array.isArray(m?.content)) images += m.content.filter(p => p?.type === 'image_url').length
  }
  const transcriptChars = Array.isArray(transcript)
    ? transcript.reduce((n, m) => n + messageTextSize(m), 0)
    : 0
  return {
    chars,
    tokens,
    messages: messages.length,
    images,
    estTokens: tokens,
    maxTokens,
    maxMessages,
    // maxChars 原样带回（调用方传的是 resolveRequestBudget 的结果，里面有它）。
    // 不重算 —— 调用方那份是按自己的预算解析出来的，重算会与实际裁剪用的不一致。
    maxChars,
    // 比率按 0~1 给，UI 拿它画进度/弧长就行，不必再除一遍
    tokenRatio: maxTokens > 0 ? Math.min(tokens / maxTokens, 1) : 0,
    messageRatio: maxMessages > 0 ? Math.min(messages.length / maxMessages, 1) : 0,
    transcriptMessages: Array.isArray(transcript) ? transcript.length : messages.length,
    transcriptChars,
    droppedMessages: Array.isArray(transcript) ? Math.max(transcript.length - messages.length, 0) : 0,
  }
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

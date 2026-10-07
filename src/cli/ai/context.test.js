// context.js 是 CLI(`g ai`)与 Web 智能体面板共用的**唯一**一份上下文准备实现。
// 这里钉住它对外承诺的口径:
//   1. 请求副本有界(条数 + 字符双预算),但会话记录本身永不被改写
//   2. 被丢弃的旧消息要摘录成一条梗概,而不是静默消失
//   3. tool_calls 与其 tool 结果必须整组保留,不能从中间撕开
//   4. provider 兼容消毒与旧图片降级只作用在副本上
//   5. 单条 user 消息超上限被首尾保留地截断,不许独占保留集把工具结果全挤走
//      (2026-10-07 主 Agent 控制台 1132 次调用死循环的事故回归,见 context.js 文件头)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareRequestMessages, sanitizeMessages, stripStaleImages, resolveRequestBudget, measureContextUsage, estimateTokens, migrateLegacyCharsToTokens } from './context.js'

const call = n => ({ id: `call${n}`, type: 'function', function: { name: 'read_file', arguments: '{}' } })

// 工具调用长会话。**组数按当前默认预算反算**，不写死——
// 默认预算 2026-10-07 一天内改了三次（80k字符 → 400k 字符 → 1M token），
// 每次写死的组数都会在某次改完后变成"不够触发裁剪"，让下面所有
// 「被丢弃的消息要摘录成梗概」「整包仍有界」的断言**假绿**。
//
// 现在的实测（同一把 estimateTokens 尺子量出来的）：
//   tool 的 'data'.repeat(4000) = 4,000 纯 ascii →≈1,143 token
//     （clip 的 6,000 上限用不上，所以是 4,000 不是 6,000）
//   assistant 的 tool_calls 参数极短 → 几十 token
//   两组一条组 ≈ 1,200 token 上下，1M 预算需≈850 组才填满。
// 给 1,500 组留足余量，确保裁剪一定发生。
//
// ⚠️ 判据（今天踩了三次才学会）：**条数上限 × 单组 token 必须明显大于 token 预算**，
// 否则裁剪不触发，断言全绿但什么都没验到。改默认值时必须回来重算这个数。
const LONG_TRANSCRIPT_GROUPS = 1500
const longTranscript = () => {
  const messages = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'original goal' }]
  for (let i = 0; i < LONG_TRANSCRIPT_GROUPS; i++) {
    messages.push({ role: 'assistant', tool_calls: [call(i)] })
    messages.push({ role: 'tool', tool_call_id: `call${i}`, content: 'data'.repeat(4000) })
  }
  return messages
}

// 默认预算解析一次,断言直接引用它 —— 写死数字就会在改默认值的那天全部变成假绿。
const DEFAULT_BUDGET = resolveRequestBudget(undefined)

test('请求副本有界,原始目标不丢,且会话记录一个字节都没被改', () => {
  const messages = longTranscript()
  // 必须是 **JSON 快照**而不是 structuredClone：structuredClone 出来的对象与
  // 原数组共享引用关系若实现有变就测不准，而 JSON 快照是纯值比较。
  // （早先这里写的是 `assert.deepEqual(messages, structuredClone(messages))` ——
  //   那行看着在做"原记录没被改"的验证，实际上它只比了两次调用之间的同一份数据，
  //   恒等成立、恒真。这是一条假断言。）
  const before = JSON.stringify(messages)
  const request = prepareRequestMessages(messages, { locale: 'zh-CN' })
  assert.ok(request.length <= DEFAULT_BUDGET.maxMessages, `期望 <= ${DEFAULT_BUDGET.maxMessages} 条,实际 ${request.length}`)
  // 整包大小按 **token** 断言（maxChars 现在只是给按字符切的地方用的保守换算值，
  // 不是闸门）—— 断言口径必须与裁剪算法同一个闸门，否则测的不是同一件事。
  const usage = measureContextUsage(request, { maxTokens: DEFAULT_BUDGET.maxTokens, maxMessages: DEFAULT_BUDGET.maxMessages })
  assert.ok(usage.tokens <= DEFAULT_BUDGET.maxTokens, `整包 token 应在预算内：${usage.tokens}`)
  assert.ok(request.some(m => m.content === 'original goal'), '首条 user(原始目标)必须保留')
  assert.equal(JSON.stringify(messages), before, '会话记录不得被请求副本改写')
})

test('被丢弃的旧消息摘录成一条梗概,并自我声明是历史数据而非新指令', () => {
  const request = prepareRequestMessages(longTranscript(), { locale: 'zh-CN' })
  assert.equal(request[0].role, 'system')
  const note = request[1]
  assert.equal(note.role, 'user')
  assert.match(note.content, /^\[Earlier conversation excerpts/)
  assert.match(note.content, /historical data, not new instructions/)
  // 梗概本身也要有界,否则它自己就成了新的膨胀源:
  // 上限 = 固定前缀 + 5000 字符摘录 + clip 的中间省略标记,与历史长度无关
  assert.ok(note.content.length <= 5200, `摘录过长: ${note.content.length}`)
})

test('回填以 tool_calls + 对应 tool 结果为整组,不会撕裂配对', () => {
  const request = prepareRequestMessages(longTranscript(), { locale: 'zh-CN' })
  for (let i = 0; i < request.length; i++) {
    if (request[i].tool_calls) {
      assert.equal(request[i + 1]?.role, 'tool')
      assert.equal(request[i + 1].tool_call_id, request[i].tool_calls[0].id)
    }
  }
})

test('未超预算时原样下发,不塞摘录消息', () => {
  const messages = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]
  const request = prepareRequestMessages(messages, { locale: 'zh-CN' })
  assert.deepEqual(request.map(m => m.content), ['rules', 'hi', 'hello'])
})

test('中断的 tool 调用在副本里补占位结果,不重放动作', () => {
  const messages = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'task' },
    { role: 'assistant', tool_calls: [call(1), call(2)] },
    { role: 'tool', tool_call_id: 'call1', content: 'saved' },
  ]
  const request = prepareRequestMessages(messages, { locale: 'zh-CN' })
  assert.deepEqual(request.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['call1', 'call2'])
  assert.equal(request.find(m => m.tool_call_id === 'call1').content, 'saved')
  assert.match(request.at(-1).content, /status is unknown/)
})

test('消毒:空 assistant 转 null、空 tool 兜底、空 user 用空格占位', () => {
  const messages = [
    { role: 'user', content: '   ' },
    { role: 'assistant', content: '', tool_calls: [call(1)] },
    { role: 'tool', tool_call_id: 'call1', content: ' \n\t ' },
    { role: 'assistant', content: '有正文但带 tool_calls', tool_calls: [call(2)] },
    { role: 'tool', tool_call_id: 'call2', content: 'ok' },
  ]
  sanitizeMessages(messages)
  assert.equal(messages[0].content, ' ')
  assert.equal(messages[1].content, null)
  assert.equal(messages[2].content, '(no output)')
  assert.equal(messages[3].content, null, 'tool_calls 存在时正文必须置 null,否则某些 provider 报 2013')
})

test('旧图片降级为占位文字,占位符跟随 locale', () => {
  const text = t => ({ type: 'text', text: t })
  const img = u => ({ type: 'image_url', image_url: { url: u } })
  const build = () => [
    { role: 'user', content: [text('first'), img('old')] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [text('second'), img('new')] },
  ]
  const zh = build()
  stripStaleImages(zh, 'zh-CN')
  assert.equal(zh[0].content[1].text, '[图片已从历史中省略]')
  assert.equal(zh[2].content[1].type, 'image_url', '最近一条带图消息必须保留图片')

  const en = build()
  stripStaleImages(en, 'en-US')
  assert.equal(en[0].content[1].text, '[image omitted from history]')
})

test('图片降级只发生在请求副本上,会话记录里的图还在', () => {
  const messages = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'old' } }] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [{ type: 'text', text: 'b' }, { type: 'image_url', image_url: { url: 'new' } }] },
  ]
  const request = prepareRequestMessages(messages, { locale: 'zh-CN' })
  // 老消息里的图降级成文字占位后,整个数组会塌回字符串(见 collapseTextParts)——
  // 所以这里断言的是"请求副本里再也找不到那张老图",而不是某个部件的 type。
  assert.equal(typeof request[1].content, 'string')
  assert.match(request[1].content, /图片已从历史中省略/)
  assert.ok(!JSON.stringify(request.slice(1)).includes('"old"'), '请求体里不许再出现老图的 data URL')
  assert.equal(request[3].content[1].type, 'image_url', '最新一张图必须留着')
  assert.equal(messages[1].content[1].type, 'image_url')
})

// ── read_image 的图必须活到请求体 ──
// buildRequestMessages 以前用 `content: clip(textOf(m), 6000)` 覆盖**每一条** tool 消息,
// 那会把 read_image 刚附上的图悄悄删掉,而模型仍然收到"已读取图片 xxx.png"的文本,
// 于是理直气壮地编内容 —— 不报错、只答错。下面三条钉住这个静默丢图不许回来。

const toolImage = (n, payload = `PAYLOAD${n}`) => ({
  role: 'tool', tool_call_id: `call${n}`, name: 'read_image',
  content: [
    { type: 'text', text: `已读取图片 shot${n}.png` },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${payload}` } },
  ],
})

test('tool 消息里的图必须活到请求体', () => {
  const messages = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: '看下 shot1.png' },
    { role: 'assistant', content: null, tool_calls: [call(1)] },
    toolImage(1),
  ]
  const tool = prepareRequestMessages(messages, { locale: 'zh-CN' }).find(m => m.role === 'tool')
  assert.ok(Array.isArray(tool.content), 'tool 消息应保持多模态数组')
  assert.equal(tool.content[1].type, 'image_url')
  assert.match(tool.content[1].image_url.url, /PAYLOAD1/)
})

test('tool 消息正文超长被截断时,图仍然留着', () => {
  const messages = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'x' },
    { role: 'assistant', content: null, tool_calls: [call(9)] },
    { role: 'tool', tool_call_id: 'call9', name: 'read_image', content: [
      { type: 'text', text: 'y'.repeat(20000) },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,KEEP' } },
    ] },
  ]
  const tool = prepareRequestMessages(messages, { locale: 'zh-CN' }).find(m => m.role === 'tool')
  assert.ok(tool.content[0].text.length < 20000, '正文该截还是得截')
  assert.match(tool.content[1].image_url.url, /KEEP/)
})

test('图片名额由 user 与 tool 共用：只留最新一张,老图连 data URL 一起消失', () => {
  const messages = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: [
      { type: 'text', text: '看这两张' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,USERIMG' } },
    ] },
    { role: 'assistant', content: null, tool_calls: [call(1)] },
    toolImage(1),
  ]
  const body = JSON.stringify(prepareRequestMessages(messages, { locale: 'zh-CN' }))
  assert.ok(!body.includes('USERIMG'), '更早的 user 图应被降级')
  assert.match(body, /PAYLOAD1/, '最新的 tool 图要留着')
})

test('已经不含图片的多模态数组塌回字符串(贴着最保守的线格式)', () => {
  const messages = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: [{ type: 'text', text: 'a' }] },   // 本来就是纯文本数组
    { role: 'assistant', content: null, tool_calls: [call(1)] },
    toolImage(1),                                                // 会被后来的图顶掉
    { role: 'user', content: [
      { type: 'text', text: '再看这张' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,NEWER' } },
    ] },
  ]
  const request = prepareRequestMessages(messages, { locale: 'zh-CN' })
  assert.equal(request[1].content, 'a')
  assert.equal(request[3].content, '已读取图片 shot1.png\n[图片已从历史中省略]')
  assert.equal(request[4].content[1].type, 'image_url', '最新那张仍是多模态数组')
})

// ── 单条巨消息不许挤掉全部工具结果（2026-10-07 事故回归）──
// 事故现场：11 万字符的任务导出作为最后一条 user 消息进入对话，保留集
// （system + 首条 user + 最后一条 user）开局就超预算 → 所有工具消息组被拒 →
// 模型每一轮都看不到自己刚读到的内容 → 反复重读同一个文件 1132 次。
// 修复后：单条 user 被首尾保留地截断，工具结果永远有存活位。

test('单条超长 user 消息被首尾保留地截断,工具结果不再被全部挤走', () => {
  // 巨消息按**当前默认预算的单条线**放大，不写死字符数：默认线 2026-10-07 从
  // 24,000 字符（token 口径下折算）变成了 300,000 字符，写死 200,000 的数据
  // 在新默认下**根本不会被截断**，这条测试会变成"测的是不该截的路径"——
  // 断言全绿但什么都没验到。跟longTranscript 那个坑同源。
  const huge = 'HEAD指令' + 'x'.repeat(DEFAULT_BUDGET.maxUserChars + 10000) + 'TAIL追问'
  const messages = [{ role: 'system', content: 'rules' }, { role: 'user', content: huge }]
  for (let i = 0; i < 30; i++) {
    messages.push({ role: 'assistant', tool_calls: [call(i)] })
    messages.push({ role: 'tool', tool_call_id: `call${i}`, content: 'data'.repeat(4000) })
  }
  const request = prepareRequestMessages(messages, { locale: 'zh-CN' })
  const user = request.find(m => typeof m.content === 'string' && m.content.includes('HEAD指令'))
  assert.ok(user, '被截断的 user 消息本体必须还在')
  assert.ok(user.content.length <= DEFAULT_BUDGET.maxUserChars + 40,
    `单条 user 应截到默认线 ${DEFAULT_BUDGET.maxUserChars},实际 ${user.content.length}`)
  assert.match(user.content, /^HEAD指令/, '开头（指令）要保留')
  assert.match(user.content, /TAIL追问$/, '结尾（最新追问）要保留')
  assert.match(user.content, /earlier output omitted/, '中间省略处要有明确标记')
  const tools = request.filter(m => m.role === 'tool').length
  assert.ok(tools >= 3, `巨消息之后工具结果必须还有存活位,实际只剩 ${tools} 条`)
  assert.ok(JSON.stringify(request).length < DEFAULT_BUDGET.maxChars * 1.1,
    `整包仍在默认预算的量级内（${JSON.stringify(request).length} < ${Math.round(DEFAULT_BUDGET.maxChars * 1.1)}）`)
})

test('多模态 user 消息截断时图仍然留着(图不参与字符预算)', () => {
  const messages = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: [
      { type: 'text', text: 'y'.repeat(DEFAULT_BUDGET.maxUserChars + 20000) },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,USERKEEP' } },
    ] },
    { role: 'assistant', content: 'ok' },
  ]
  const request = prepareRequestMessages(messages, { locale: 'zh-CN' })
  const user = request.find(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'))
  assert.ok(user, '最新一条带图 user 消息必须还活着')
  assert.ok(user.content[0].text.length <= DEFAULT_BUDGET.maxUserChars + 40, '正文该截还是得截')
  assert.match(user.content[1].image_url.url, /USERKEEP/, '图不许被截断逻辑碰掉')
})

test('resolveRequestBudget:默认口径与等比缩放,越界夹取/无法解析回落', () => {
  // 默认 **800,000 token**：用户模型都是 1M 档（MiniMax-M3 / DeepSeek V4 Flash），
  // 但顶格 1M 不留输出余量 —— 模型的回复和 thinking 的 reasoning 都占同一个窗口。
  assert.equal(DEFAULT_BUDGET.maxTokens, 800000, '默认 800k（1M 窗口的 80%，留 200k 给输出+reasoning）')
  assert.equal(DEFAULT_BUDGET.maxMessages, 2000, '800k / 400 = 2000 条（分母见 resolveRequestBudget 注释）')
  // maxChars 是给按字符切的地方（单条截断线）用的保守换算值，不是主口径
  assert.ok(DEFAULT_BUDGET.maxChars > DEFAULT_BUDGET.maxTokens,
    `保守换算应大于token 数（保守系数 1.5），实际 maxChars=${DEFAULT_BUDGET.maxChars}`)
  // 越界夹取：手改成天文数字的意图是"想更大"，夹到上限而不是回落默认
  assert.equal(resolveRequestBudget(1).maxTokens, 20000, '越界值夹取到下限而不是回落默认')
  assert.equal(resolveRequestBudget(99999999).maxTokens, 1000000, '越界值夹取到上限 1M（区间不随默认缩放）')
  assert.equal(resolveRequestBudget('abc').maxTokens, 800000, '无法解析才回落默认')
  // 等比缩放：条数随 token 预算走
  // 下限 40 现在**碰不到**了：最小合法预算 20,000 ÷ 400 = 50 > 40。
  // 这不是 bug —— 下限 40 是字符口径时代的护栏（那时最小预算 20,000/2000 = 10 会
  // 撞下限），token 口径下同样的 20,000 预算能装 50 条，原护栏已无意义。
  // 留着它是为了「预算被改小时不至于只剩个位数条数」，而 20,000 的下限本身
  // 已经把最坏情况兜住了。断言写成"下限护栏仍存在但当前碰不到"：
  const minBudget = resolveRequestBudget(undefined)
  assert.ok(minBudget.maxMessages >= 40, '条数下限护栏仍在')
  assert.equal(resolveRequestBudget(20000).maxMessages, 50, '最小合法预算 → 50 条（20000/400）')
  const mid = resolveRequestBudget(100000)
  assert.equal(mid.maxMessages, 250, '100k token → 250 条（100000/400）')
  assert.ok(mid.maxUserChars < DEFAULT_BUDGET.maxUserChars, '单条线随预算缩放')
})

test('旧配置项 aiMaxRequestChars 能迁成 token 值（2026-10-07 口径变更回归）', () => {
  // 本机历史值 80,000 字符 → 约 34k token。**不能回落默认 1M**，否则等于
  // 静默把用户的设置清了一轮 —— 那正是口径变更最容易犯的错。
  assert.equal(migrateLegacyCharsToTokens(80000), 33755)
  assert.equal(migrateLegacyCharsToTokens(null), null)
  assert.equal(migrateLegacyCharsToTokens(0), null)
  assert.equal(migrateLegacyCharsToTokens('abc'), null)
  // 迁出来的值必须落在合法区间内（超上限要被夹回，而不是照单全收）
  assert.equal(resolveRequestBudget(migrateLegacyCharsToTokens(99999999)).maxTokens, 1000000)
})

test('条数上限不再提前撞满 token 预算（2026-10-07 回归）', () => {
  // 旧公式（字符口径 /2000）让 80k 预算只填到 72% 就被 40 条卡住，实测只覆盖
  // 2.1% 的工具调用轮 —— 字符预算没用满就被条数卡死。
  //
  // token 口径下"条数上限"是**同样的瓶颈**：分母取大就会复现同一个病。
  // 实测单组 token（不是估算）：纯 ascii 的 tool被 clip 到 6,000 字符 = 1,715 token
  // + assistant 的 tool_calls 24 → 1,740/组。
  //   分母 2500 → 400 条 × 584 = 23 万（23%）
  //   分母 1200 → 833 条 × 584 = 49 万（49%）
  //   分母 700  → 1429 条 × 584 = 83.5 万（83.5%）
  //   分母 400  → 2500 条 × 1,143 = 286 万，token 闸门先耗尽（100%）
  //
  // ⚠️ 造数据时先算这笔账：条数上限 × 单条 token 必须 ≥ token 预算，否则
  // "token 先耗尽"永远不成立，而失败原因（数据不够大）极易被误读成公式错。
  const messages = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'goal' },
  ]
  // 本形态实测单条 ≈584 token（4,000 ascii 字符 clip 后≈1,143，但 tool_calls
  // 参数极短，assistant 那条只几十 token，两条平均下来 584）。
  // 2,500 条 × 584 = 146万 > 1M，所以 token 闸门会先耗尽 —— 断言要验的正是这个。
  // 给 1200 组（2,400 条）：既超够填满 token 预算，也超够接近条数上限，
  // 数据不够大就验不出"token 先耗尽"。
  for (let i = 0; i < 1200; i++) {
    messages.push({ role: 'assistant', tool_calls: [call(i)] })
    messages.push({ role: 'tool', tool_call_id: `call${i}`, content: 'x'.repeat(4200) })
  }
  const request = prepareRequestMessages(messages, { locale: 'zh-CN' })
  // 用 measureContextUsage 量，与 UI 看到的是同一个口径 ——
  // 断言"条数不该提前卡住"这件事本身就是在验这套测量算得对不对。
  const usage = measureContextUsage(request, {
    maxTokens: DEFAULT_BUDGET.maxTokens, maxMessages: DEFAULT_BUDGET.maxMessages,
  })
  assert.ok(usage.tokenRatio > 0.9,
    `token 预算应当基本耗尽（实测只用到 ${(usage.tokenRatio * 100).toFixed(1)}%），条数不该提前卡住`)
  assert.ok(request.length < DEFAULT_BUDGET.maxMessages, `条数也不该撞顶：${request.length}`)
})

test('measureContextUsage:只量请求副本,不含图片,并算出被裁掉多少', () => {
  const transcript = [
    { role: 'system', content: 'r'.repeat(1000) },
    { role: 'user', content: 'goal' },
    { role: 'assistant', content: 'a'.repeat(500) },
    { role: 'user', content: [
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(50000) } },
    ] },
  ]
  const request = transcript.slice(0, 3)
  const usage = measureContextUsage(request, { maxTokens: 800000, maxMessages: 2000, transcript })
  assert.equal(usage.messages, 3)
  assert.equal(usage.images, 0, '副本里没有图')
  // 图片 base64 不该计入字符预算（否则一张截图就把进度条顶满）
  assert.ok(usage.chars < 5000, `实际 ${usage.chars} —— 图片 base64 似乎被算进去了`)
  assert.equal(usage.transcriptMessages, 4)
  assert.equal(usage.droppedMessages, 1)
  assert.ok(usage.tokens > 0 && usage.tokens < usage.chars, '估算 token 应落在 0 与字符数之间')
  assert.equal(usage.tokenRatio, usage.tokens / 800000)
})

test('estimateTokens:中文一字一 token,ascii 按 3.5 字符一 token', () => {
  assert.equal(estimateTokens('中'.repeat(500)), 500)
  assert.equal(estimateTokens('a'.repeat(3500)), 1000)
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens(null), 0)
  // 混合：中英各一半应落在两者之间（100 中文 + 350 ascii ≈ 100 + 100 = 200）
  const mixed = estimateTokens('中'.repeat(100) + 'a'.repeat(350))
  assert.ok(mixed > 100 && mixed <= 200, `实际 ${mixed}`)
})

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
import { prepareRequestMessages, sanitizeMessages, stripStaleImages, resolveRequestBudget } from './context.js'

const call = n => ({ id: `call${n}`, type: 'function', function: { name: 'read_file', arguments: '{}' } })

// 200 轮工具调用,每轮结果 16000 字符(会被 clip 到 6000)—— 必须**远超**默认预算。
//
// 为什么是 200 而不是历史上的 60:默认预算 2026-10-07 从 80k 提到 400k,60 组
// (120 条 × 6000 字符 ≈ 360k)正好卡在新预算底下,裁剪根本不触发,那些"被丢弃的
// 消息要摘录成梗概""条数要有上限"的断言会**假绿**。测试数据的量必须跟着预算走,
// 否则改完默认值等于把回归测试改成了空转。
const longTranscript = () => {
  const messages = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'original goal' }]
  for (let i = 0; i < 200; i++) {
    messages.push({ role: 'assistant', tool_calls: [call(i)] })
    messages.push({ role: 'tool', tool_call_id: `call${i}`, content: 'data'.repeat(4000) })
  }
  return messages
}

// 默认预算解析一次,断言直接引用它 —— 写死数字就会在改默认值的那天全部变成假绿。
const DEFAULT_BUDGET = resolveRequestBudget(undefined)

test('请求副本有界,原始目标不丢,且会话记录一个字节都没被改', () => {
  const messages = longTranscript()
  const before = structuredClone(messages)
  const request = prepareRequestMessages(messages, { locale: 'zh-CN' })
  assert.ok(request.length <= DEFAULT_BUDGET.maxMessages, `期望 <= ${DEFAULT_BUDGET.maxMessages} 条,实际 ${request.length}`)
  assert.ok(JSON.stringify(request).length < DEFAULT_BUDGET.maxChars * 1.1)
  assert.ok(request.some(m => m.content === 'original goal'), '首条 user(原始目标)必须保留')
  assert.deepEqual(messages, before, '会话记录不得被请求副本改写')
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
  const huge = 'HEAD指令' + 'x'.repeat(200000) + 'TAIL追问'
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
  assert.ok(JSON.stringify(request).length < DEFAULT_BUDGET.maxChars * 1.1, '整包仍在默认预算的量级内')
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
  assert.deepEqual(DEFAULT_BUDGET, { maxChars: 400000, maxMessages: 400, maxUserChars: 120000 })
  // 越界夹取：手改成天文数字的意图是"想更大"，夹到上限而不是回落默认
  assert.equal(resolveRequestBudget(1).maxChars, 20000, '越界值夹取到下限而不是回落默认')
  const top = resolveRequestBudget(99999999)
  assert.equal(top.maxChars, 1000000, '越界值夹取到上限')
  assert.equal(top.maxMessages, 600, '条数上限独立于字符上限（分母 1000 后 1000k→1000 条，夹到 600）')
  assert.equal(resolveRequestBudget('abc').maxChars, 400000, '无法解析才回落默认')
})

test('条数上限不再提前撞满字符预算（2026-10-07 回归）', () => {
  // 旧公式 /2000 让 80k 预算只填到 72% 就被 40 条卡住，实测只覆盖 2.1% 的工具调用轮。
  // 现在分母 /1000：实测每条消息约 2,700 字符，字符预算应当先耗尽，条数只在极端情况下生效。
  const messages = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'goal' },
  ]
  for (let i = 0; i < 300; i++) {
    messages.push({ role: 'assistant', tool_calls: [call(i)] })
    messages.push({ role: 'tool', tool_call_id: `call${i}`, content: 'x'.repeat(2700) })
  }
  const request = prepareRequestMessages(messages, { locale: 'zh-CN' })
  // 自己按文本长度算（与 buildRequestMessages 里的 size() 同口径），
  // 刻意不依赖 measureContextUsage —— 那个函数是「占用可视化」那批改动才加的，
  // 预算这一组提交里还没有它。
  const used = request.reduce((n, m) => {
    const c = typeof m.content === 'string' ? m.content : ''
    return n + c.length + JSON.stringify(m.tool_calls || []).length
  }, 0)
  assert.ok(used / DEFAULT_BUDGET.maxChars > 0.9,
    `字符预算应当基本耗尽（实测只用到 ${(used / DEFAULT_BUDGET.maxChars * 100).toFixed(1)}%），条数不该提前卡住`)
  assert.ok(request.length < DEFAULT_BUDGET.maxMessages, `条数也不该撞顶：${request.length}`)
})

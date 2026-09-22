// context.js 是 CLI(`g ai`)与 Web 智能体面板共用的**唯一**一份上下文准备实现。
// 这里钉住它对外承诺的口径:
//   1. 请求副本有界(条数 + 字符双预算),但会话记录本身永不被改写
//   2. 被丢弃的旧消息要摘录成一条梗概,而不是静默消失
//   3. tool_calls 与其 tool 结果必须整组保留,不能从中间撕开
//   4. provider 兼容消毒与旧图片降级只作用在副本上
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareRequestMessages, sanitizeMessages, stripStaleImages } from './context.js'

const call = n => ({ id: `call${n}`, type: 'function', function: { name: 'read_file', arguments: '{}' } })

// 60 轮工具调用,每轮结果 16000 字符(会被 clip 到 6000)—— 远超任何预算
const longTranscript = () => {
  const messages = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'original goal' }]
  for (let i = 0; i < 60; i++) {
    messages.push({ role: 'assistant', tool_calls: [call(i)] })
    messages.push({ role: 'tool', tool_call_id: `call${i}`, content: 'data'.repeat(4000) })
  }
  return messages
}

test('请求副本有界,原始目标不丢,且会话记录一个字节都没被改', () => {
  const messages = longTranscript()
  const before = structuredClone(messages)
  const request = prepareRequestMessages(messages, { locale: 'zh-CN' })
  assert.ok(request.length <= 40, `期望 <= 40 条,实际 ${request.length}`)
  assert.ok(JSON.stringify(request).length < 90000)
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
  assert.equal(request[1].content[1].type, 'text')
  assert.equal(messages[1].content[1].type, 'image_url')
})

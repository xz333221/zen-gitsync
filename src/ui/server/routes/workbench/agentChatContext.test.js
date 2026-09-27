// injectRequestContext：把"当前打开的文档"与"本轮附件路径"注进**请求副本**。
// 关键口径：只改请求副本、不碰 session.messages；越界路径忽略；下一轮不会重复累积；
// 附件只给绝对路径、不给内容（内容由模型自己用 read / grep 取）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { injectRequestContext } from './agentChat.js'

const ROOT = path.resolve('C:/proj')

test('injectRequestContext: 相对项目根的斜杠路径追加进 system 消息', () => {
  const messages = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'hi' }
  ]
  injectRequestContext(messages, { cwd: ROOT, openFilePath: path.join(ROOT, 'src', 'a.md'), locale: 'zh' })
  assert.match(messages[0].content, /^rules\n\n# 当前上下文/)
  assert.match(messages[0].content, /src\/a\.md/)
  assert.equal(messages[1].content, 'hi', '其它消息不受影响')
})

test('injectRequestContext: 项目外路径 / 空值一律忽略', () => {
  const outside = [{ role: 'system', content: 'rules' }]
  injectRequestContext(outside, { cwd: ROOT, openFilePath: 'D:/other/x.md', locale: 'zh' })
  assert.equal(outside[0].content, 'rules', '项目外路径不注入')

  const none = [{ role: 'system', content: 'rules' }]
  injectRequestContext(none, { cwd: ROOT, openFilePath: '', locale: 'zh' })
  assert.equal(none[0].content, 'rules', '没传 openFilePath 时不动消息')
})

test('injectRequestContext: 没有 system 消息时补一条，英文 locale 用英文说明', () => {
  const messages = [{ role: 'user', content: 'hi' }]
  injectRequestContext(messages, { cwd: ROOT, openFilePath: 'README.md', locale: 'en' })
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'system')
  assert.match(messages[0].content, /README\.md/)
  assert.match(messages[0].content, /Current context/)
})

test('injectRequestContext: 每轮都基于副本重新注入，不会重复累积', () => {
  const session = [{ role: 'system', content: 'rules' }]
  const first = session.map(m => ({ ...m }))
  const second = session.map(m => ({ ...m }))
  injectRequestContext(first, { cwd: ROOT, openFilePath: 'a.md', locale: 'zh' })
  injectRequestContext(second, { cwd: ROOT, openFilePath: 'a.md', locale: 'zh' })
  assert.equal(session[0].content, 'rules', '原始会话记录保持干净')
  assert.equal((first[0].content.match(/# 当前上下文/g) || []).length, 1)
  assert.equal((second[0].content.match(/# 当前上下文/g) || []).length, 1)
})

test('injectRequestContext: 附件只注入绝对路径,内容不进消息体', () => {
  const messages = [{ role: 'system', content: 'rules' }, { role: 'user', content: '看下这个日志' }]
  injectRequestContext(messages, {
    cwd: ROOT,
    locale: 'zh',
    attachments: [
      { name: '错误日志.log', path: 'C:\\Users\\x\\.zen-gitsync\\agent-attachments\\20260927-193000-ab12\\错误日志.log' }
    ]
  })
  assert.match(messages[0].content, /^rules\n\n# 当前上下文/)
  assert.match(messages[0].content, /用户本轮附带了 1 个文件/)
  assert.match(messages[0].content, /agent-attachments.+错误日志\.log/)
  assert.match(messages[0].content, /不要臆测/)
  // 消息体本身没有任何文件内容
  assert.equal(messages[1].content, '看下这个日志')
})

test('injectRequestContext: 文档 + 附件可以同时注入,各成一段', () => {
  const messages = [{ role: 'system', content: 'rules' }]
  injectRequestContext(messages, {
    cwd: ROOT,
    openFilePath: 'src/a.md',
    locale: 'en',
    attachments: [
      { name: 'a.log', path: '/tmp/att/a.log' },
      { name: 'b.csv', path: '/tmp/att/b.csv' }
    ]
  })
  const sys = messages[0].content
  assert.match(sys, /# Current context/)
  assert.match(sys, /src\/a\.md/)
  assert.match(sys, /attached 2 file/)
  assert.match(sys, /\/tmp\/att\/a\.log/)
  assert.match(sys, /\/tmp\/att\/b\.csv/)
  // 只加一个标题段
  assert.equal((sys.match(/# Current context/g) || []).length, 1)
})

test('injectRequestContext: 脏附件数据(缺 path / 空数组)不会破坏消息,也不留空段', () => {
  const dirty = [{ role: 'system', content: 'rules' }]
  injectRequestContext(dirty, { cwd: ROOT, locale: 'zh', attachments: [{ name: 'x.txt' }, null, 'oops'] })
  assert.equal(dirty[0].content, 'rules', '没有可用 path 时不注入')

  const empty = [{ role: 'system', content: 'rules' }]
  injectRequestContext(empty, { cwd: ROOT, locale: 'zh', attachments: [] })
  assert.equal(empty[0].content, 'rules')
})

test('injectRequestContext: 附件条数超过 20 时截断(防御性上限)', () => {
  const messages = [{ role: 'system', content: 'rules' }]
  const many = Array.from({ length: 25 }, (_, i) => ({ name: `f${i}.txt`, path: `/tmp/att/f${i}.txt` }))
  injectRequestContext(messages, { cwd: ROOT, locale: 'zh', attachments: many })
  assert.match(messages[0].content, /用户本轮附带了 20 个文件/)
  assert.ok(!messages[0].content.includes('f24.txt'), '第 21 个之后不该出现')
})

// injectOpenFileContext：文件空间对话时把"当前打开的文档"注进请求副本。
// 关键口径：只改请求副本、不碰 session.messages；越界路径忽略；下一轮不会重复累积。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { injectOpenFileContext } from './agentChat.js'

const ROOT = path.resolve('C:/proj')

test('injectOpenFileContext: 相对项目根的斜杠路径追加进 system 消息', () => {
  const messages = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'hi' }
  ]
  injectOpenFileContext(messages, { cwd: ROOT, openFilePath: path.join(ROOT, 'src', 'a.md'), locale: 'zh' })
  assert.match(messages[0].content, /^rules\n\n# 当前上下文/)
  assert.match(messages[0].content, /src\/a\.md/)
  assert.equal(messages[1].content, 'hi', '其它消息不受影响')
})

test('injectOpenFileContext: 项目外路径 / 空值一律忽略', () => {
  const outside = [{ role: 'system', content: 'rules' }]
  injectOpenFileContext(outside, { cwd: ROOT, openFilePath: 'D:/other/x.md', locale: 'zh' })
  assert.equal(outside[0].content, 'rules', '项目外路径不注入')

  const none = [{ role: 'system', content: 'rules' }]
  injectOpenFileContext(none, { cwd: ROOT, openFilePath: '', locale: 'zh' })
  assert.equal(none[0].content, 'rules', '没传 openFilePath 时不动消息')
})

test('injectOpenFileContext: 没有 system 消息时补一条，英文 locale 用英文说明', () => {
  const messages = [{ role: 'user', content: 'hi' }]
  injectOpenFileContext(messages, { cwd: ROOT, openFilePath: 'README.md', locale: 'en' })
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'system')
  assert.match(messages[0].content, /README\.md/)
  assert.match(messages[0].content, /Current context/)
})

test('injectOpenFileContext: 每轮都基于副本重新注入，不会重复累积', () => {
  const session = [{ role: 'system', content: 'rules' }]
  const first = session.map(m => ({ ...m }))
  const second = session.map(m => ({ ...m }))
  injectOpenFileContext(first, { cwd: ROOT, openFilePath: 'a.md', locale: 'zh' })
  injectOpenFileContext(second, { cwd: ROOT, openFilePath: 'a.md', locale: 'zh' })
  assert.equal(session[0].content, 'rules', '原始会话记录保持干净')
  assert.equal((first[0].content.match(/# 当前上下文/g) || []).length, 1)
  assert.equal((second[0].content.match(/# 当前上下文/g) || []).length, 1)
})
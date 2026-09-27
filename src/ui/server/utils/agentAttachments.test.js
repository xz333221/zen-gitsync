// 智能体非图片附件落盘:文件名消毒 / 体积与数量上限 / 同名不覆盖 / 轮次目录清理。
// 关键口径:客户端传的 name 是不可信输入,任何情况下都不能拼进目录外。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  saveAgentAttachments,
  sanitizeFileName,
  decodeDataUrl,
  pruneUploadDirs,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS
} from './agentAttachments.js'

async function tmpDir(prefix = 'zen-att-') {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

function dataUrl(text, mime = 'text/plain') {
  return `data:${mime};base64,${Buffer.from(text, 'utf8').toString('base64')}`
}

test('sanitizeFileName: 剥路径穿越、控制字符与 Windows 非法字符', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd')
  assert.equal(sanitizeFileName('C:\\Windows\\evil.txt'), 'evil.txt')
  assert.equal(sanitizeFileName('a\u0000b.txt'), 'a_b.txt')
  assert.equal(sanitizeFileName('bad:name?.log'), 'bad_name_.log')
  assert.equal(sanitizeFileName('..'), 'file', '纯点名要回落默认名')
  assert.equal(sanitizeFileName(''), 'file')
  assert.equal(sanitizeFileName(null), 'file')
})

test('sanitizeFileName: 超长名截断但保留扩展名', () => {
  const long = 'x'.repeat(200) + '.log'
  const out = sanitizeFileName(long)
  assert.ok(out.length <= 80, `长度应被截断,实际 ${out.length}`)
  assert.ok(out.endsWith('.log'), '扩展名要保留')
})

test('decodeDataUrl: 只认 base64 dataURL', () => {
  assert.equal(decodeDataUrl(dataUrl('hi')).toString('utf8'), 'hi')
  assert.equal(decodeDataUrl('data:text/plain,hi'), null, '非 base64 不认')
  assert.equal(decodeDataUrl('not-a-data-url'), null)
  assert.equal(decodeDataUrl(undefined), null)
})

test('saveAgentAttachments: 落盘到指定目录并返回绝对路径,内容一致', async () => {
  const dir = await tmpDir()
  const saved = await saveAgentAttachments(
    [{ name: '错误日志.log', dataUrl: dataUrl('boom\n', 'text/plain') }],
    { dir }
  )
  assert.equal(saved.length, 1)
  assert.equal(saved[0].name, '错误日志.log')
  assert.ok(path.isAbsolute(saved[0].path), '返回的必须是绝对路径(模型按绝对路径读)')
  assert.equal(await fs.readFile(saved[0].path, 'utf8'), 'boom\n')
  // 落在 dir 的子目录里(一轮一个目录)
  assert.equal(path.dirname(path.dirname(saved[0].path)), dir)
  await fs.rm(dir, { recursive: true, force: true })
})

test('saveAgentAttachments: 目录穿越的 name 写不到目录外', async () => {
  const dir = await tmpDir()
  const saved = await saveAgentAttachments(
    [{ name: '../../escaped.txt', dataUrl: dataUrl('x') }],
    { dir }
  )
  assert.equal(saved.length, 1)
  assert.equal(saved[0].name, 'escaped.txt')
  assert.ok(saved[0].path.startsWith(dir), '必须仍在传入目录内')
  await fs.rm(dir, { recursive: true, force: true })
})

test('saveAgentAttachments: 超大 / 空 payload / 数量超限都会被跳过并回调', async () => {
  const dir = await tmpDir()
  const skipped = []
  const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x61).toString('base64')
  const list = [
    { name: 'ok.txt', dataUrl: dataUrl('fine') },
    { name: 'big.bin', dataUrl: `data:application/octet-stream;base64,${big}` },
    { name: 'broken.txt', dataUrl: 'not-a-data-url' },
    { name: 'empty.txt', dataUrl: 'data:text/plain;base64,' }
  ]
  const saved = await saveAgentAttachments(list, { dir, onSkip: i => skipped.push(i.reason) })
  assert.deepEqual(saved.map(s => s.name), ['ok.txt'])
  assert.ok(skipped.includes('too-large'))
  assert.ok(skipped.includes('bad-payload'))
  await fs.rm(dir, { recursive: true, force: true })
})

test('saveAgentAttachments: 超过 MAX_ATTACHMENTS 的余量直接截掉', async () => {
  const dir = await tmpDir()
  const list = Array.from({ length: MAX_ATTACHMENTS + 3 }, (_, i) => ({
    name: `f${i}.txt`,
    dataUrl: dataUrl(String(i))
  }))
  const saved = await saveAgentAttachments(list, { dir })
  assert.equal(saved.length, MAX_ATTACHMENTS)
  await fs.rm(dir, { recursive: true, force: true })
})

test('saveAgentAttachments: 同一轮内同名文件加序号,不互相覆盖', async () => {
  const dir = await tmpDir()
  const saved = await saveAgentAttachments(
    [
      { name: 'a.txt', dataUrl: dataUrl('first') },
      { name: 'a.txt', dataUrl: dataUrl('second') }
    ],
    { dir }
  )
  assert.equal(saved.length, 2)
  assert.notEqual(saved[0].path, saved[1].path)
  assert.equal(await fs.readFile(saved[0].path, 'utf8'), 'first')
  assert.equal(await fs.readFile(saved[1].path, 'utf8'), 'second')
  await fs.rm(dir, { recursive: true, force: true })
})

test('saveAgentAttachments: 空数组不建目录(没人上传就别留垃圾)', async () => {
  const dir = path.join(await tmpDir(), 'never')
  const saved = await saveAgentAttachments([], { dir })
  assert.deepEqual(saved, [])
  await assert.rejects(fs.stat(dir), '目录不该被创建')
})

test('pruneUploadDirs: 只保留最近 KEEP_UPLOAD_TURNS 轮', async () => {
  const dir = await tmpDir()
  // 目录名按时间戳字典序排序,这里直接造有序名字
  for (const n of ['20260101-000000-aaaa', '20260102-000000-bbbb', '20260103-000000-cccc']) {
    const d = path.join(dir, n)
    await fs.mkdir(d, { recursive: true })
    await fs.writeFile(path.join(d, 'x.txt'), 'x')
  }
  const removed = await pruneUploadDirs(dir, new Date(), 2)
  assert.equal(removed, 1)
  const left = (await fs.readdir(dir)).sort()
  assert.deepEqual(left, ['20260102-000000-bbbb', '20260103-000000-cccc'])
  await fs.rm(dir, { recursive: true, force: true })
})

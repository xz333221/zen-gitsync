// 路径越界检查单元测试（用 node:test 内置）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureWithinCwd, ensureWithinCwdSync, pathGuard } from '../utils/pathGuard.js'

const cwd = process.platform === 'win32' ? 'E:\\project' : '/tmp/project'

test('合法路径在 cwd 内', async () => {
  const r = await ensureWithinCwd('src/foo.ts', cwd)
  assert.ok(r, '应返回结果')
  assert.match(r.safePath, /[\\/]project[\\/]src[\\/]foo\.ts$/)
})

test('合法绝对路径在 cwd 内', async () => {
  const absInCwd = process.platform === 'win32' ? 'E:\\project\\sub' : '/tmp/project/sub'
  const r = await ensureWithinCwd(absInCwd, cwd)
  assert.ok(r, '应通过')
  assert.equal(r.safePath, absInCwd)
})

test('../ 父目录逃逸被拒绝', async () => {
  const r = await ensureWithinCwd('../etc/passwd', cwd)
  assert.equal(r, null, '../ 应该被拒')
})

test('cwd 的同级目录（startsWith 假阳性）被拒绝', async () => {
  const evil = process.platform === 'win32' ? 'E:\\project-evil' : '/tmp/project-evil'
  const r = await ensureWithinCwd(evil, cwd)
  assert.equal(r, null, '同名前缀目录应该被拒')
})

test('绝对路径在 cwd 外被拒', async () => {
  const outside = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc/passwd'
  const r = await ensureWithinCwd(outside, cwd)
  assert.equal(r, null, '绝对外部路径应该被拒')
})

test('空字符串 / null / undefined 被拒', async () => {
  assert.equal(await ensureWithinCwd('', cwd), null)
  assert.equal(await ensureWithinCwd(null, cwd), null)
  assert.equal(await ensureWithinCwd(undefined, cwd), null)
  assert.equal(await ensureWithinCwd(123, cwd), null)
})

test('多重 ../ 也被拒', async () => {
  const r = await ensureWithinCwd('../../../../etc/passwd', cwd)
  assert.equal(r, null)
})

test('相对 cwd 自身（.）允许', async () => {
  const r = await ensureWithinCwd('.', cwd)
  assert.ok(r, '点 应解析为 cwd 本身')
})

test('Windows 反斜杠与正斜杠混用允许', async () => {
  if (process.platform !== 'win32') return
  const r = await ensureWithinCwd('src\\sub/foo.ts', cwd)
  assert.ok(r)
})

test('Windows 大小写不敏感', async () => {
  if (process.platform !== 'win32') return
  const r = await ensureWithinCwd('SRC/FOO.TS', 'E:\\Project')
  assert.ok(r, 'Windows 下大小写不敏感应允许')
})

test('sync 版本对 .. 同样拒绝', () => {
  assert.equal(ensureWithinCwdSync('../foo', cwd), null)
  const r = ensureWithinCwdSync('sub/file', cwd)
  assert.ok(r)
})

test('中间件: 合法 path 通过 + 挂到 res.locals.safePath', async () => {
  let nextCalled = false
  const req = { query: { path: 'src/foo.ts' } }
  const res = {
    locals: {},
    status() { return this },
    json() { return this },
  }
  await pathGuard(cwd)(req, res, () => { nextCalled = true })
  assert.equal(nextCalled, true)
  assert.match(res.locals.safePath, /[\\/]src[\\/]foo\.ts$/)
})

test('中间件: 越界 path 返回 403', async () => {
  let nextCalled = false
  let statusCode = 0
  let body = null
  const req = { query: { path: '../etc/passwd' } }
  const res = {
    locals: {},
    status(c) { statusCode = c; return this },
    json(b) { body = b; return this },
  }
  await pathGuard(cwd)(req, res, () => { nextCalled = true })
  assert.equal(nextCalled, false)
  assert.equal(statusCode, 403)
  assert.match(body.error, /禁止访问/)
})

test('中间件: 缺字段返回 400', async () => {
  let statusCode = 0
  const req = { query: {} }
  const res = {
    locals: {},
    status(c) { statusCode = c; return this },
    json() { return this },
  }
  await pathGuard(cwd)(req, res, () => {})
  assert.equal(statusCode, 400)
})

test('中间件: 多字段校验（rename 用）', async () => {
  let nextCalled = false
  const req = { query: { oldPath: 'src/a.ts', newPath: '../b.ts' } }
  const res = {
    locals: {},
    status() { return this },
    json() { return this },
  }
  await pathGuard(cwd, ['oldPath', 'newPath'])(req, res, () => { nextCalled = true })
  assert.equal(nextCalled, false, 'newPath 越界应拒')
})

// Copyright 2026 xz333221
// Licensed under the Apache License, Version 2.0

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { listSessions, recordTurnTiming, MAX_TURN_TIMINGS } from './sessionStore.js'

test('listSessions: 按更新时间倒序列出有效会话并跳过损坏文件', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-gitsync-sessions-'))
  t.after(() => fsp.rm(directory, { recursive: true, force: true }))

  await Promise.all([
    fsp.writeFile(path.join(directory, 'older.json'), JSON.stringify({
      sessionId: 'wrong-id',
      title: '旧对话',
      updatedAt: '2026-01-01T00:00:00.000Z',
      messages: [{ role: 'user', content: 'old' }],
    })),
    fsp.writeFile(path.join(directory, 'newer.json'), JSON.stringify({
      title: '新对话',
      updatedAt: '2026-02-01T00:00:00.000Z',
      messages: [{ role: 'user', content: 'new' }],
    })),
    fsp.writeFile(path.join(directory, 'broken.json'), '{not json'),
    fsp.writeFile(path.join(directory, 'not-a-session.json'), JSON.stringify({ title: 'missing messages' })),
    fsp.writeFile(path.join(directory, 'ignored.txt'), 'ignored'),
  ])

  const sessions = await listSessions(directory)
  assert.deepEqual(sessions.map(session => session.sessionId), ['newer', 'older'])
  assert.deepEqual(sessions.map(session => session.title), ['新对话', '旧对话'])
})

// 每轮用时记录（session.turnTimings）。三个必须成立的性质：
//   ① 同一 turnIndex 后写的覆盖先写的 —— 失败轮次会把 user 消息弹掉，
//      那条废记录的序号会被下一轮复用，读出来必须指向真正跑完的那一轮；
//   ② 非法输入不写进去（否则界面上会出现 NaN / 负耗时）；
//   ③ 长会话不会让数组无限长。
test('recordTurnTiming: 记本轮用时，同序号覆盖、非法值不写、超长截断', () => {
  const session = {}
  recordTurnTiming(session, { turnIndex: 0, durationMs: 12_345, finishedAt: '2026-10-09T01:00:12.345Z' })
  recordTurnTiming(session, { turnIndex: 1, durationMs: 489_000 })
  assert.deepEqual(session.turnTimings.map(t => [t.turnIndex, t.durationMs]), [[0, 12345], [1, 489000]])
  assert.equal(session.turnTimings[0].finishedAt, '2026-10-09T01:00:12.345Z')
  // 没给 finishedAt 也要有一个能看的时刻，不能是 undefined
  assert.match(session.turnTimings[1].finishedAt, /^\d{4}-\d{2}-\d{2}T/)

  // 同一轮重来（上一轮失败被弹掉 / 用户重发）→ 覆盖，不是追加
  recordTurnTiming(session, { turnIndex: 1, durationMs: 2000, finishedAt: '2026-10-09T02:00:00.000Z' })
  assert.deepEqual(session.turnTimings.map(t => [t.turnIndex, t.durationMs]), [[0, 12345], [1, 2000]])

  // 非法值一律不写
  recordTurnTiming(session, { turnIndex: -1, durationMs: 100 })
  recordTurnTiming(session, { turnIndex: 2, durationMs: -5 })
  recordTurnTiming(session, { turnIndex: 'x', durationMs: 100 })
  recordTurnTiming(session, { turnIndex: 3, durationMs: Number.NaN })
  recordTurnTiming(null, { turnIndex: 4, durationMs: 100 })
  assert.equal(session.turnTimings.length, 2)

  // 小数毫秒四舍五入（界面上不显示 12.7ms）
  recordTurnTiming(session, { turnIndex: 5, durationMs: 12.7 })
  assert.equal(session.turnTimings[2].durationMs, 13)

  for (let i = 0; i < MAX_TURN_TIMINGS + 20; i++) {
    recordTurnTiming(session, { turnIndex: 100 + i, durationMs: i })
  }
  assert.equal(session.turnTimings.length, MAX_TURN_TIMINGS)
  // 截断的是最旧的，最近的还在
  assert.equal(session.turnTimings[session.turnTimings.length - 1].turnIndex, 100 + MAX_TURN_TIMINGS + 19)
})

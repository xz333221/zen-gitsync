// Copyright 2026 xz333221
// Licensed under the Apache License, Version 2.0

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { listSessions } from './sessionStore.js'

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

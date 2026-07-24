// Copyright 2026 xz333221
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// src/cli/ai/platformGuard.js 单元测试
// 覆盖纯函数(splitCommandSegments / extractCommandName / detectUnixOnlyCommands)
// 和异步主接口(guardCommand,注入 mock exec 避免 PATH 依赖)。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  splitCommandSegments,
  extractCommandName,
  detectUnixOnlyCommands,
  guardCommand,
  checkCommandAvailability,
  _clearAvailabilityCache,
  UNIX_ONLY_COMMANDS,
} from './platformGuard.js'

// ── splitCommandSegments ──────────────────────

test('splitCommandSegments: 按管道切分', () => {
  assert.deepEqual(
    splitCommandSegments('npm test | tail -60'),
    ['npm test', 'tail -60'],
  )
})

test('splitCommandSegments: 按 && 切分', () => {
  assert.deepEqual(
    splitCommandSegments('echo a && echo b'),
    ['echo a', 'echo b'],
  )
})

test('splitCommandSegments: 按 || 和 ; 切分', () => {
  assert.deepEqual(
    splitCommandSegments('echo a || echo b ; echo c'),
    ['echo a', 'echo b', 'echo c'],
  )
})

test('splitCommandSegments: 空串/纯空白返回空数组', () => {
  assert.deepEqual(splitCommandSegments(''), [])
  assert.deepEqual(splitCommandSegments('   '), [])
})

test('splitCommandSegments: 无操作符的命令返回单段', () => {
  assert.deepEqual(splitCommandSegments('echo hello'), ['echo hello'])
})

// ── extractCommandName ────────────────────────

test('extractCommandName: 提取第一个 token 并小写', () => {
  assert.equal(extractCommandName('TAIL -60'), 'tail')
  assert.equal(extractCommandName('node -e "code"'), 'node')
})

test('extractCommandName: 跳过 sudo/doas 前缀', () => {
  assert.equal(extractCommandName('sudo tail -f log'), 'tail')
  assert.equal(extractCommandName('doas grep pattern'), 'grep')
})

test('extractCommandName: 空串返回空', () => {
  assert.equal(extractCommandName(''), '')
})

// ── detectUnixOnlyCommands ────────────────────

test('detectUnixOnlyCommands: 检测管道中的 Unix 命令', () => {
  // 复现用户踩坑场景:npm test | tail -60
  assert.deepEqual(detectUnixOnlyCommands('npm test | tail -60'), ['tail'])
})

test('detectUnixOnlyCommands: 检测多个不同的 Unix 命令', () => {
  assert.deepEqual(
    detectUnixOnlyCommands('cat file.txt | grep foo | wc -l'),
    ['cat', 'grep', 'wc'],
  )
})

test('detectUnixOnlyCommands: 同一命令去重', () => {
  assert.deepEqual(
    detectUnixOnlyCommands('grep a && grep b'),
    ['grep'],
  )
})

test('detectUnixOnlyCommands: 没有 Unix 命令时返回空数组', () => {
  assert.deepEqual(detectUnixOnlyCommands('npm test'), [])
  assert.deepEqual(detectUnixOnlyCommands('node -e "console.log(1)"'), [])
  assert.deepEqual(detectUnixOnlyCommands('git status'), [])
})

test('detectUnixOnlyCommands: 带路径前缀的命令也能检测', () => {
  // /usr/bin/tail → tail
  assert.deepEqual(detectUnixOnlyCommands('/usr/bin/tail -f log'), ['tail'])
})

test('detectUnixOnlyCommands: 空输入返回空数组', () => {
  assert.deepEqual(detectUnixOnlyCommands(''), [])
  assert.deepEqual(detectUnixOnlyCommands(null), [])
  assert.deepEqual(detectUnixOnlyCommands(undefined), [])
})

test('detectUnixOnlyCommands: 不误判 Windows 自带命令', () => {
  // sort/find/where 在 Windows 上存在(行为不同但不是 Unix-only)
  assert.deepEqual(detectUnixOnlyCommands('sort file.txt'), [])
  assert.deepEqual(detectUnixOnlyCommands('where node'), [])
})

// ── guardCommand:非 Windows 平台 ─────────────

test('guardCommand: 非 Windows 平台直接放行', async () => {
  const r = await guardCommand('tail -f log', { platform: 'linux' })
  assert.equal(r.blocked, false)
  assert.equal(r.reason, null)
})

test('guardCommand: macOS 也放行', async () => {
  const r = await guardCommand('cat file | grep foo', { platform: 'darwin' })
  assert.equal(r.blocked, false)
})

test('guardCommand: 空/非字符串命令放行', async () => {
  assert.equal((await guardCommand('', { platform: 'win32' })).blocked, false)
  assert.equal((await guardCommand(null, { platform: 'win32' })).blocked, false)
})

// ── guardCommand:Windows + mock exec ──────────
//
// 注入 mock execFn 模拟 `where` 的成功/失败,避免依赖真实 PATH。
// 每个测试前清空缓存,确保 mock 不互相污染。

// mock exec:commands 里列出的命令名返回"找到"(无 err),其余返回"找不到"(err)
function createMockExec(notFoundCommands = []) {
  const notFound = new Set(notFoundCommands)
  return (cmd, _opts, cb) => {
    // 提取 `where <cmd>` 中的 cmd 名
    const m = cmd.match(/^where\s+(\S+)/)
    const name = m?.[1] || ''
    if (notFound.has(name)) {
      cb(new Error('not found'), '')
    } else {
      cb(null, `C:\\fake\\${name}.exe`)
    }
  }
}

beforeEach(() => {
  _clearAvailabilityCache()
})

test('guardCommand: Windows 上 tail 不存在 → 拦截并给出替代方案', async () => {
  const r = await guardCommand('npm test | tail -60', {
    platform: 'win32',
    execFn: createMockExec(['tail']),
  })
  assert.equal(r.blocked, true)
  assert.match(r.reason, /tail/)
  assert.match(r.reason, /Select-Object/)
  assert.match(r.reason, /npm test \| tail -60/)
})

test('guardCommand: Windows 上 tail 存在(如 Git Bash) → 放行', async () => {
  const r = await guardCommand('npm test | tail -60', {
    platform: 'win32',
    execFn: createMockExec([]), // 所有命令都"找到"
  })
  assert.equal(r.blocked, false)
})

test('guardCommand: Windows 上无 Unix 命令 → 放行', async () => {
  const r = await guardCommand('npm test', {
    platform: 'win32',
    execFn: createMockExec(),
  })
  assert.equal(r.blocked, false)
})

test('guardCommand: 多个 Unix 命令都不存在 → 全部列出', async () => {
  const r = await guardCommand('cat file | grep foo | wc -l', {
    platform: 'win32',
    execFn: createMockExec(['cat', 'grep', 'wc']),
  })
  assert.equal(r.blocked, true)
  assert.match(r.reason, /cat/)
  assert.match(r.reason, /grep/)
  assert.match(r.reason, /wc/)
})

test('guardCommand: 多个 Unix 命令,部分存在部分不存在 → 只拦截不存在的', async () => {
  // grep 存在(Git Bash),cat/wc 不存在
  const r = await guardCommand('cat file | grep foo | wc -l', {
    platform: 'win32',
    execFn: createMockExec(['cat', 'wc']),
  })
  assert.equal(r.blocked, true)
  assert.match(r.reason, /cat/)
  assert.doesNotMatch(r.reason, /• grep/)
  assert.match(r.reason, /wc/)
})

test('guardCommand: 拦截原因包含原始命令', async () => {
  const cmd = 'echo hello | tail -5'
  const r = await guardCommand(cmd, {
    platform: 'win32',
    execFn: createMockExec(['tail']),
  })
  assert.match(r.reason, new RegExp(cmd.replace(/\|/g, '\\|')))
})

// ── checkCommandAvailability:缓存行为 ────────

test('checkCommandAvailability: 缓存结果,第二次不调 exec', async () => {
  let callCount = 0
  const execFn = (cmd, _opts, cb) => {
    callCount++
    cb(new Error('not found'), '')
  }
  _clearAvailabilityCache()
  const a1 = await checkCommandAvailability('tail', { execFn })
  const a2 = await checkCommandAvailability('tail', { execFn })
  assert.equal(a1, false)
  assert.equal(a2, false)
  assert.equal(callCount, 1, '第二次应命中缓存,不调 exec')
})

// ── 数据完整性 ────────────────────────────────

test('UNIX_ONLY_COMMANDS: 每个条目都有非空的替代方案说明', () => {
  for (const [name, hint] of Object.entries(UNIX_ONLY_COMMANDS)) {
    assert.ok(typeof name === 'string' && name.length > 0)
    assert.ok(typeof hint === 'string' && hint.length > 10, `${name} 的替代方案说明过短`)
  }
})

test('UNIX_ONLY_COMMANDS: 不包含 Windows 自带命令(防误杀)', () => {
  const windowsBuiltins = ['sort', 'find', 'where', 'dir', 'type', 'copy', 'move', 'del']
  for (const w of windowsBuiltins) {
    assert.ok(!UNIX_ONLY_COMMANDS[w], `${w} 是 Windows 自带命令,不应在 Unix-only 清单中`)
  }
})

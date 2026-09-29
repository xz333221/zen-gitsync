/**
 * 「用工具打开」的权限档位 —— 参数映射的运行时断言。
 *
 * 契约（见 src/ui/server/routes/fileOpen.js 的 buildOpencodeArgs / buildCodexArgs）：
 *   opencode  'auto' | 'bypassPermissions' → `--auto`（官方 auto mode：自动批准**未被
 *             显式拒绝**的权限，配置里显式 deny 的仍会被拦）
 *   codex     'sandboxed'                  → `-a never -s workspace-write`
 *                                          （从不问人，但命令仍在沙箱里跑）
 *             'bypass' | 'bypassPermissions' → `--dangerously-bypass-approvals-and-sandbox`
 *                                          （免批准 + 免沙箱）
 *   其余一切（undefined / 'default' / 未知串 / 非字符串）→ 一个 flag 都不带
 *
 * 为什么单独测这两个函数而不是打 HTTP 接口：真去打 /api/open-directory-with-* 会 spawn
 * 一个终端（codex / opencode 的 TUI 会停在那里等人输入）—— 验证不能有这种副作用。
 * 抽成纯函数后，映射关系是真的被跑过断言，不是在源码里搜字符串。
 *
 * 反向验证（把改动撤掉后哪几条会红）：
 *   · 把 opencode 的档位表清空 → 第 1 组红
 *   · 把 codex 的 'sandboxed' 那行删掉 → 第 4 组红
 *   · 让默认档也返回 flag → 第 2、3、5 组红
 *
 * 用法：npm run verify:open-with-permission
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOpencodeArgs, buildCodexArgs } from '../src/ui/server/routes/fileOpen.js'

/** 默认档（以及一切不认识的 token）必须一个参数都不带 —— 不能偷偷进免批准 */
const NO_FLAG_TOKENS = [undefined, null, '', 'default', 'acceptEdits', 'allow', 'readOnly', 0, false, {}, []]

/** 拼串 / 大小写变体 / 原型链上的名字：白名单式匹配，一律拿不到参数 */
const NASTY_TOKENS = [
  '--auto; rm -rf /',
  'auto --dangerously-bypass-approvals-and-sandbox',
  'AUTO',
  'Auto',
  ' auto',
  'auto ',
  '"auto"',
  '__proto__',
  'constructor',
]

test('opencode 完全批准档：auto / bypassPermissions → --auto', () => {
  assert.deepEqual(buildOpencodeArgs('auto'), ['--auto'])
  assert.deepEqual(buildOpencodeArgs('bypassPermissions'), ['--auto'])
})

test('opencode 默认档：不带任何 flag', () => {
  for (const token of NO_FLAG_TOKENS) {
    assert.deepEqual(buildOpencodeArgs(token), [], `token=${JSON.stringify(token)} 不该带参`)
  }
})

test('opencode 注入面：只认白名单 token', () => {
  for (const token of NASTY_TOKENS) {
    assert.deepEqual(buildOpencodeArgs(token), [], `token=${JSON.stringify(token)} 不该带参`)
  }
})

test('codex 自动批准档（仍有沙箱）：sandboxed → -a never -s workspace-write', () => {
  assert.deepEqual(buildCodexArgs('sandboxed'), ['-a', 'never', '-s', 'workspace-write'])
})

test('codex 完全批准档：bypass / bypassPermissions → 免批准 + 免沙箱', () => {
  const expected = ['--dangerously-bypass-approvals-and-sandbox']
  assert.deepEqual(buildCodexArgs('bypass'), expected)
  assert.deepEqual(buildCodexArgs('bypassPermissions'), expected)
})

test('codex 默认档：不带任何 flag', () => {
  for (const token of NO_FLAG_TOKENS) {
    assert.deepEqual(buildCodexArgs(token), [], `token=${JSON.stringify(token)} 不该带参`)
  }
})

test('codex 注入面：只认白名单 token', () => {
  for (const token of NASTY_TOKENS) {
    assert.deepEqual(buildCodexArgs(token), [], `token=${JSON.stringify(token)} 不该带参`)
  }
})

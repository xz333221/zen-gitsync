/**
 * opencode 的「完全批准」档 —— 参数映射的运行时断言。
 *
 * 契约（见 src/ui/server/routes/fileOpen.js 的 buildOpencodeArgs）：
 *   'auto'（本工具正式叫法）与 'bypassPermissions'（与 claude 那档共用同一个 token）
 *   → 启动参数 `--auto`
 *   其余一切（undefined / 'default' / 未知串 / 非字符串）→ 不带任何 flag
 *
 * 为什么单独测这个函数而不是打 HTTP 接口：真去打 /api/open-directory-with-opencode
 * 会 spawn 一个带 `--auto` 的 opencode TUI 窗口并停在那里等输入 —— 验证不能有这种
 * 副作用。抽成纯函数后，映射关系是真的被跑过断言，不是在源码里搜字符串。
 *
 * 反向验证（把改动撤掉后哪几条会红）：
 *   · OPENCODE_AUTO_MODES 清空 → 第 1 组红
 *   · buildOpencodeArgs 改成恒返回 [] → 第 1 组红
 *   · 改成恒返回 ['--auto']（默认档也放行）→ 第 2、3 组红
 *
 * 用法：npm run verify:opencode-permission
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOpencodeArgs } from '../src/ui/server/routes/fileOpen.js'

test('完全批准档：auto / bypassPermissions 都映射到 --auto', () => {
  assert.deepEqual(buildOpencodeArgs('auto'), ['--auto'])
  assert.deepEqual(buildOpencodeArgs('bypassPermissions'), ['--auto'])
})

test('默认档：不带任何 flag（不能偷偷进入免批准）', () => {
  const tokens = [undefined, null, '', 'default', 'acceptEdits', 'allow', 0, false, {}, []]
  for (const token of tokens) {
    assert.deepEqual(buildOpencodeArgs(token), [], `token=${JSON.stringify(token)} 不该带参`)
  }
})

test('注入面：只认白名单 token，拼串 / 大小写变体一律拿不到 flag', () => {
  const nasty = [
    '--auto; rm -rf /',
    'auto --dangerously-skip-permissions',
    'AUTO',
    'Auto',
    ' auto',
    'auto ',
    '"auto"',
  ]
  for (const token of nasty) {
    assert.deepEqual(buildOpencodeArgs(token), [], `token=${JSON.stringify(token)} 不该带参`)
  }
})

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
// 自升级命令环境判定回归测试(2026-09-12)
//
// 背景:GUI 里点「升级」曾固定执行 `sudo -n npm install -g zen-gitsync` 并报
// "sudo: 需要密码",用户无论输什么都装不上。根因是判定写成了
// `process.platform === 'win32'`,而 MSYS/Cygwin 的 Node 是伪 Unix 构建
// (platform 报 'linux'),于是误走 sudo 分支,撞上 MSYS 那个只会输出
// "a password is required" 的 sudo 桩程序。
//
// 这里守住两条契约:
//   1. needsSudo() 只在"真 Unix + 非 root"时返回 true;
//   2. resolveUpgradeCommand() 在 MSYS/Cygwin 下拼出的命令里绝不能出现 sudo。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { needsSudo, resolveUpgradeCommand } from './npm.js'

// ── needsSudo:环境判定 ────────────────────────────────────────────────

test('needsSudo: Windows 原生 Node 不需要 sudo', () => {
  assert.equal(needsSudo({ platform: 'win32', env: {}, getuid: undefined }), false)
})

test('needsSudo: MSYS/Cygwin 的伪 Unix Node 不需要 sudo(本次 bug 的核心场景)', () => {
  // MSYS2 / Git Bash:platform 报 linux,但注入 MSYSTEM
  assert.equal(
    needsSudo({ platform: 'linux', env: { MSYSTEM: 'MINGW64' }, getuid: undefined }),
    false
  )
  // Cygwin:platform 报 linux,但注入 CYGWIN
  assert.equal(
    needsSudo({ platform: 'linux', env: { CYGWIN: 'ntsec' }, getuid: undefined }),
    false
  )
  // Git Bash 通常两个都有
  assert.equal(
    needsSudo({ platform: 'linux', env: { MSYSTEM: 'MINGW64', CYGWIN: 'nodosfilewarning' }, getuid: undefined }),
    false
  )
})

test('needsSudo: 真 Unix 的普通用户需要 sudo', () => {
  assert.equal(needsSudo({ platform: 'linux', env: {}, getuid: () => 1000 }), true)
  assert.equal(needsSudo({ platform: 'darwin', env: {}, getuid: () => 501 }), true)
})

test('needsSudo: 真 Unix 的 root(uid 0)不需要 sudo', () => {
  assert.equal(needsSudo({ platform: 'linux', env: {}, getuid: () => 0 }), false)
})

test('needsSudo: getuid 缺失时不崩,保守返回需要 sudo', () => {
  assert.equal(needsSudo({ platform: 'linux', env: {}, getuid: undefined }), true)
})

test('needsSudo: getuid 抛异常时不崩,保守返回需要 sudo', () => {
  assert.equal(
    needsSudo({ platform: 'linux', env: {}, getuid: () => { throw new Error('EPERM') } }),
    true
  )
})

test('needsSudo: 默认参数取自 process,不会抛错', () => {
  assert.equal(typeof needsSudo(), 'boolean')
})

// ── resolveUpgradeCommand:命令拼装 ────────────────────────────────────

const PKG_ARGS = ['install', '-g', 'zen-gitsync', '--registry', 'https://registry.npmjs.org/']

test('resolveUpgradeCommand: Windows 原生走 npm.cmd + shell:true,无 sudo', () => {
  const r = resolveUpgradeCommand(PKG_ARGS, { platform: 'win32', env: {}, getuid: undefined })
  assert.equal(r.cmd, 'npm.cmd')
  assert.equal(r.useShell, true)
  assert.equal(r.sudo, false)
  assert.deepEqual(r.args, PKG_ARGS)
  assert.ok(!r.args.includes('sudo'))
})

test('resolveUpgradeCommand: MSYS 下绝不出现 sudo(回归本次 bug)', () => {
  const r = resolveUpgradeCommand(PKG_ARGS, {
    platform: 'linux',
    env: { MSYSTEM: 'MINGW64' },
    getuid: undefined,
  })
  assert.equal(r.cmd, 'npm')
  assert.equal(r.sudo, false)
  assert.equal(r.isMsysLike, true)
  assert.ok(
    !r.args.some((a) => String(a).includes('sudo')),
    `MSYS 环境不应拼出 sudo,实际: ${[r.cmd, ...r.args].join(' ')}`
  )
})

test('resolveUpgradeCommand: Cygwin 下同样不走 sudo', () => {
  const r = resolveUpgradeCommand(PKG_ARGS, {
    platform: 'linux',
    env: { CYGWIN: 'ntsec' },
    getuid: undefined,
  })
  assert.equal(r.sudo, false)
  assert.match(r.cmd, /^npm(\.cmd)?$/)
  assert.ok(!r.args.some((a) => String(a).includes('sudo')))
})

test('resolveUpgradeCommand: 真 Unix 普通用户走 sudo -n', () => {
  const r = resolveUpgradeCommand(PKG_ARGS, { platform: 'linux', env: {}, getuid: () => 1000 })
  assert.equal(r.cmd, 'sudo')
  assert.equal(r.sudo, true)
  // -n 保证非交互:免密直接过,需密码立刻失败,不挂死 GUI
  assert.deepEqual(r.args, ['-n', 'npm', ...PKG_ARGS])
})

test('resolveUpgradeCommand: 真 Unix root 直接裸装 npm,无 sudo', () => {
  const r = resolveUpgradeCommand(PKG_ARGS, { platform: 'linux', env: {}, getuid: () => 0 })
  assert.equal(r.cmd, 'npm')
  assert.equal(r.sudo, false)
  assert.deepEqual(r.args, PKG_ARGS)
  assert.ok(!r.args.includes('sudo'))
})

test('resolveUpgradeCommand: 完整命令串里不会出现 "sudo -n npm" 之外的提权痕迹', () => {
  // 三个免提权场景逐个检查拼出的完整命令
  const cases = [
    { platform: 'win32', env: {}, getuid: undefined },
    { platform: 'linux', env: { MSYSTEM: 'MINGW64' }, getuid: undefined },
    { platform: 'linux', env: {}, getuid: () => 0 },
  ]
  for (const c of cases) {
    const r = resolveUpgradeCommand(PKG_ARGS, c)
    const full = [r.cmd, ...r.args].join(' ')
    assert.ok(!full.includes('sudo'), `不应含 sudo: ${full}`)
    assert.ok(full.includes('zen-gitsync'), `应含包名: ${full}`)
  }
})

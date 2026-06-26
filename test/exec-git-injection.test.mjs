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

// TEST-3 回归测试:execGitCommand 不会被 shell 注入(SEC-INJ-3 守住)
//
// 核心断言:
//   1. 用 execFile('git', argv) 而非 spawn('git <joined>', { shell: true }) 模式,
//      攻击者拼接 'git status; touch /tmp/pwned' 作为 argv 第一个元素时,
//      git 把它当成一个未知的子命令直接报错,不会执行 ; 后面的 touch。
//   2. 命令历史只写入 head(数组 join 的字符串),不会让 ';' 解析成 shell。
//   3. 正常 git status 仍能跑通 — 防回归过度修。
//
// 注意:本测试在仓库根目录跑(本身是 git 仓库),`execGitCommand(['status'])`
// 必须成功;`execGitCommand(['status; touch /tmp/exec-git-injection-pwn'])` 必须
// 失败(返回 error 或 success=false),且 /tmp/exec-git-injection-pwn 不能被创建。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, unlinkSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..')
const utilsMod = await import(pathToFileURL(path.join(projectRoot, 'src/utils/index.js')).href)
const { execGitCommand, getCommandHistory, clearCommandHistory } = utilsMod

// 用 os.tmpdir() 派生 pwn 路径,跨平台
const pwnDir = path.join(os.tmpdir(), 'exec-git-injection-test-' + process.pid)
try { mkdirSync(pwnDir, { recursive: true }) } catch {}
const pwnFile = path.join(pwnDir, 'pwned.txt')

// 清理:确保 pwn 文件不存在(防止前一次失败遗留影响)
function cleanupPwn() {
  try { unlinkSync(pwnFile) } catch {}
}
cleanupPwn()

after(() => {
  cleanupPwn()
})

// ========== 正常路径(防回归) ==========

test('execGitCommand: 正常 git rev-parse 可跑通(防回归)', async () => {
  // 在仓库根目录跑,git rev-parse 应能拿到 toplevel
  const result = await execGitCommand(['rev-parse', '--show-toplevel'], { log: false })
  // 成功路径:error 为 undefined(或 falsy 且非 Error 实例)
  assert.ok(!result.error, 'rev-parse 不应抛错: ' + (result.error?.message || ''))
  assert.ok(result.stdout && result.stdout.trim().length > 0, 'stdout 应非空')
})

// ========== 注入攻击回归(SEC-INJ-3 守住) ==========

test('execGitCommand: argv 第一元素是 "status; touch ..." 不执行 touch', async () => {
  // 攻击者构造:execGitCommand(['status; touch ' + pwnFile])
  // 正确行为:execFile('git', ['status; touch ' + pwnFile]) → git 报
  // "git: 'status; touch /tmp/...pwned.txt' is not a git command",exit ≠ 0,
  // touch 不执行,pwnFile 不存在。
  let rejected = null
  try {
    await execGitCommand(['status; touch ' + pwnFile], { log: false })
  } catch (e) {
    rejected = e
  }
  // 应 reject(git 退出非零)
  assert.ok(rejected, '注入的 "status; touch ..." 应被 git 拒收并 reject')
  // 关键:pwn 文件不能被创建
  assert.equal(
    existsSync(pwnFile),
    false,
    `pwn 文件 ${pwnFile} 不应被创建(说明 ; 后面的 touch 没执行)`
  )
})

test('execGitCommand: argv 含 && 命令链不执行', async () => {
  // 攻击者构造:execGitCommand(['rev-parse', '--show-toplevel', '&&', 'touch', pwnFile])
  // execFile('git', argv) 下 && 只是 argv 的字面字符,git 报 ambiguous argument。
  let rejected = null
  try {
    await execGitCommand(
      ['rev-parse', '--show-toplevel', '&&', 'touch', pwnFile],
      { log: false }
    )
  } catch (e) {
    rejected = e
  }
  assert.ok(rejected, '含 && 的 argv 应被 git 拒收并 reject')
  assert.equal(
    existsSync(pwnFile),
    false,
    'pwn 文件不应被创建'
  )
})

// ========== 命令历史契约 ==========

test('execGitCommand: 命令历史 head 字段是 join 后的字符串,不是数组', async () => {
  clearCommandHistory()
  await execGitCommand(['status', '--short'], { log: true }).catch(() => {})
  const hist = getCommandHistory()
  assert.ok(hist.length >= 1, '至少应有一条历史')
  const last = hist[0]
  // head 必须是字符串(由 [a,b].join(' ') 派生),不能是数组
  assert.equal(typeof last.command, 'string', `command 字段必须是 string,实际: ${typeof last.command}`)
  // head 默认是 command.join(' '),不包含 'git ' 前缀
  assert.match(last.command, /^status\s+--short/, '历史 command 应以 "status --short" 开头(head = join 后的 argv,不含 git)')
})

test('execGitCommand: 注入尝试写入历史时 command 字段也是字面字符串', async () => {
  clearCommandHistory()
  await execGitCommand(
    ['status; touch ' + pwnFile],
    { log: true }
  ).catch(() => {})
  const hist = getCommandHistory()
  assert.ok(hist.length >= 1)
  const last = hist[0]
  assert.equal(typeof last.command, 'string')
  // 历史里应保留完整字面字符串,不被任何 shell 解析
  assert.ok(last.command.includes('status; touch'), '历史应保留原样字面字符串')
  assert.equal(last.success, false, '注入尝试的 success 应是 false')
})
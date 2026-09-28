#!/usr/bin/env node
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
// 离线重放 scripts/release.js 的「发布后自更新」轮询 —— 不需要真的发一次包。
//
// 做法:把 release.js 读进来,做**逐条断言过**的字符串替换(network/npm 叶子函数换成
// 可编程桩、main() 换成直接调 selfUpdateGlobal),写成 scripts/.self-update-harness.mjs,
// 用子进程跑。任何一条替换没命中就报"release.js 结构变了,请同步本探针"并退出 1 ——
// 所以它同时也是一道"改坏了就喊"的守门。
//
// 三个场景:
//   A 探针全程 404、npm 其实能装(复现 v2.17.21 那次) → 必须在强制轮就装上
//   B 探针全程 404、npm 也真装不上 → 必须出现"超时前补的真装",且真调 npm 次数 ≥ 3
//   C 反证(--reverse):把判定换回旧的 `if (probe.ok)` → 真调 npm 次数必然是 0
//     (= 那次 600s 白等的根因)。C 不做成"期望失败",而是直接断言旧行为"零真试",
//     这样新代码一旦退化回硬闸门,C 也会跟着变红。
//
// 退出码:0 = 全绿;1 = 有断言失败(含"release.js 结构变了")
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, 'release.js')
const HARNESS = path.join(__dirname, '.self-update-harness.mjs')
const REVERSE = process.argv.includes('--reverse')

const STUBS = `
// ===================== 探针注入(仅本 harness 副本里有) =====================
const HARNESS_CFG = JSON.parse(process.env.HARNESS_CONFIG || '{}')
const HARNESS_LOG = { installs: [], probes: 0, packument: 0, stops: 0 }
let HARNESS_INSTALLED = null
function FAKE_PROBE() {
  HARNESS_LOG.probes += 1
  return { ok: !!HARNESS_CFG.probeOk, status: HARNESS_CFG.probeOk ? 206 : 404 }
}
function FAKE_PACKUMENT() {
  HARNESS_LOG.packument += 1
  return !!HARNESS_CFG.packumentHasVersion
}
function FAKE_INSTALL(spec) {
  HARNESS_LOG.installs.push(spec)
  if (!HARNESS_CFG.installSucceeds) {
    return { ok: false, output: 'npm error code E404\\nnpm error 404 Not Found - GET https://registry.npmjs.org/...' }
  }
  HARNESS_INSTALLED = HARNESS_CFG.version
  return { ok: true }
}
function FAKE_INSTALLED() { return HARNESS_INSTALLED }
async function FAKE_STOP() { HARNESS_LOG.stops += 1; return [] }
async function FAKE_STOP_QUIET() { HARNESS_LOG.stops += 1; return [] }
process.on('exit', () => { console.log('HARNESS_LOG ' + JSON.stringify(HARNESS_LOG)) })
`

// 旧实现(硬闸门)的等价物:只有探针说可取才真装,且没有"超时前补一次"。
// 用于反证 —— 顺便把这个"旧行为长什么样"钉在探针里,而不是靠注释描述。
const LEGACY_GATE = `
const FORCE_INSTALL_EVERY = 4
const shouldAttemptInstall = ({ probe }) => ({ attempt: !!probe?.ok, reason: probe?.ok ? 'tarball-ready' : 'probe-says-missing' })
const shouldFinalAttempt = () => false
`

const REPLACEMENTS = [
  {
    label: '策略模块 import',
    from: "import { shouldAttemptInstall, shouldFinalAttempt, FORCE_INSTALL_EVERY } from '../src/utils/selfUpdatePolicy.js'",
    to: "__POLICY_LINE__",
  },
  { label: '探针调用点', from: 'await isTarballFetchable(version, bust)', to: 'await FAKE_PROBE(version, bust)' },
  {
    label: 'packument 就绪判据(循环内)',
    from: 'const packumentHasVersion = readPackumentHasVersion(version)',
    to: 'const packumentHasVersion = FAKE_PACKUMENT(version)',
  },
  {
    label: 'packument 就绪判据(超时前补试)',
    from: "runInstallRound(readPackumentHasVersion(version), '超时前补的真装')",
    to: "runInstallRound(FAKE_PACKUMENT(version), '超时前补的真装')",
  },
  { label: 'npm install 调用点', from: 'const res = tryInstallGlobal(spec)', to: 'const res = FAKE_INSTALL(spec)' },
  { label: '读全局版本', from: 'const installed = readGlobalInstalledVersion()', to: 'const installed = FAKE_INSTALLED()' },
  { label: '停实例(常规)', from: 'await stopRunningInstances()', to: 'await FAKE_STOP()' },
  {
    label: '停实例(文件占用补刀)',
    from: 'if (!KEEP_INSTANCES) await stopRunningInstances({ quiet: true })',
    to: 'if (!KEEP_INSTANCES) await FAKE_STOP_QUIET()',
  },
  {
    label: '入口(改成直接调 selfUpdateGlobal)',
    from: `main().catch((err) => {
  console.error(chalk.red('\\n❌ 未捕获的错误:'), err)
  process.exit(1)
})`,
    to: `selfUpdateGlobal(process.env.HARNESS_VERSION || '0.0.1').then(() => {
  console.log('HARNESS_DONE')
}).catch((err) => {
  console.error('HARNESS_ERROR ' + (err?.stack || err))
  process.exit(1)
})`,
  },
]

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

function buildHarnessSource() {
  let code = fs.readFileSync(SRC, 'utf8')
  let bad = false
  for (const r of REPLACEMENTS) {
    const hits = code.split(r.from).length - 1
    if (hits !== 1) {
      console.error(`✘ release.js 结构变了:「${r.label}」期望命中 1 次,实际 ${hits} 次。请同步本探针。`)
      bad = true
      continue
    }
    // 反证模式下**整条 import 换掉**(不能只追加 —— 同名绑定会撞重复声明):
    // 换成旧那套硬闸门。两种模式都要带 STUBS(FAKE_* 桩与策略无关)。
    const to = r.to === '__POLICY_LINE__'
      ? (REVERSE ? LEGACY_GATE + STUBS : r.from + STUBS)
      : r.to
    code = code.replace(r.from, to)
  }
  return bad ? null : code
}

function runScenario(cfg, { intervalSec = 1, timeoutSec = 8 } = {}) {
  const env = { ...process.env, HARNESS_CONFIG: JSON.stringify(cfg), HARNESS_VERSION: cfg.version }
  const res = spawnSync(
    process.execPath,
    [HARNESS, `--poll-interval=${intervalSec}`, `--poll-timeout=${timeoutSec}`],
    { cwd: path.join(__dirname, '..'), env, encoding: 'utf8', timeout: 120000 }
  )
  const out = `${res.stdout || ''}\n${res.stderr || ''}`
  const m = out.match(/^HARNESS_LOG (\{.*\})$/m)
  let log = null
  try {
    log = m ? JSON.parse(m[1]) : null
  } catch {
    log = null
  }
  // 桩没跑起来(语法错 / 崩了)时,把子进程原样输出打出来 —— 否则只剩一排 null 无从下手
  if (!log && process.env.HARNESS_DEBUG === '1') console.log(out.slice(0, 3000))
  return { out, log, status: res.status }
}

// ============================== 主流程 ==============================
console.log(`\n=== release 自更新轮询探针${REVERSE ? '(反证模式)' : ''} ===`)

const source = buildHarnessSource()
if (!source) process.exit(1)

fs.writeFileSync(HARNESS, source, 'utf8')
try {
  if (!REVERSE) {
    // ---- 场景 A:探针全程 404,但 npm 其实能装(v2.17.21 原样重放)----
    console.log('\n[场景 A] 探针 35 轮全 404 + npm 能装 → 必须在强制轮装上,不许等满窗口')
    const a = runScenario({ version: '9.9.9', probeOk: false, packumentHasVersion: false, installSucceeds: true }, { timeoutSec: 40 })
    check('进程正常退出(装上了就别继续磨)', a.status === 0, `exit=${a.status}`)
    check('出现 HARNESS_DONE(不是异常退出)', a.out.includes('HARNESS_DONE'))
    check('日志里有"真试安装(forced)"', a.out.includes('真试安装(forced)'))
    check('第 4 轮就真试(不是等满 600s)', /第 4 轮\(.*\) → 真试安装\(forced\)/.test(a.out))
    check('确实调了 npm install', (a.log?.installs.length ?? 0) >= 1, `installs=${a.log?.installs.length ?? 'null'}`)
    check('先试 tarball 直连(packument 还没同步)',
      (a.log?.installs[0] ?? '').includes('.tgz'), `first=${a.log?.installs[0]}`)
    check('成功文案带"第 N 次真装"', /全局已更新到 .*第 1 次真装/.test(a.out))
    check('没有报"仍未装上"', !a.out.includes('仍未装上'))
    check('跳过 npm 时会自我说明(不是默默重试)', a.out.includes('跳过只是为了省一次注定失败的调用'))

    // ---- 场景 B:探针 404 且 npm 真装不上 → 超时前补一次真装 + 说清试了几次 ----
    console.log('\n[场景 B] 探针全程 404 + npm 也失败 → 超时前补真装,摘要报清"真调 npm 几次"')
    const b = runScenario({ version: '9.9.9', probeOk: false, packumentHasVersion: false, installSucceeds: false }, { timeoutSec: 6 })
    check('进程退出码仍为 0(失败不 panic)', b.status === 0, `exit=${b.status}`)
    check('出现"补最后一次真装"(超时兜底)', b.out.includes('补最后一次真装'))
    check('真调 npm ≥ 4 次(强制轮 2 条 spec + 补试 2 条 spec)', (b.log?.installs.length ?? 0) >= 4, `installs=${b.log?.installs.length ?? 'null'}`)
    check('失败摘要报"已试 N 轮(其中真调 npm M 次)"', /已试 \d+ 轮\(其中真调 npm \d+ 次\)/.test(b.out))
    check('提示"探针误报"而不是让用户以为 registry 没就绪', b.out.includes('探针误报'))
    check('给出放宽窗口的提示', b.out.includes('--poll-timeout=1800'))
  } else {
    // ---- 场景 C:反证 —— 换回旧的硬闸门,零真试 ----
    console.log('\n[场景 C·反证] 旧实现(if (probe.ok) 硬闸门)+ 探针全程 404 → npm 一次都不该被调')
    const c = runScenario({ version: '9.9.9', probeOk: false, packumentHasVersion: false, installSucceeds: true }, { timeoutSec: 6 })
    check('旧实现确实"零真试"(= v2.17.21 白等 600s 的根因)', (c.log?.installs.length ?? -1) === 0, `installs=${c.log?.installs.length ?? 'null'}`)
    check('旧实现没有"超时前补的真装"', !c.out.includes('超时前补的真装'))
    check('旧实现虽然探针全 404,却报"仍未装上"', c.out.includes('仍未装上'))
    check('探针重复探测(说明它一直在等,而不是在装)', (c.log?.probes ?? 0) >= 3, `probes=${c.log?.probes ?? 'null'}`)
  }
} finally {
  try {
    fs.rmSync(HARNESS, { force: true })
  } catch {
    /* 忽略清理失败 */
  }
}

console.log(failures === 0 ? `\n✔ 全部通过\n` : `\n✘ ${failures} 条断言失败\n`)
process.exit(failures === 0 ? 0 : 1)

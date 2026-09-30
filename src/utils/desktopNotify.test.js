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
// src/utils/desktopNotify.js 里"纯函数 + 转义"部分的单元测试(node:test 内置)。
//
// 只测到 buildNotifyPlan 为止,**不真的 spawn** —— 单测里弹窗/响一声会打扰跑测试的人。
// 这里要守住的三件事,全都是"错了不会报错、只会静默失效"的类型:
//   ① 文案里的 `<` / `&` 没转义 → toast 的 XML 解析失败 → 一条都不弹,且错误被吞;
//   ② 文案里的单引号没翻倍 → PowerShell 语法错 → 静默什么都不做;
//   ③ 弹窗脚本没被正确 base64 编进启动器 → Start-Process 收到一段垃圾,弹窗永远不出现。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildNotifyPlan,
  winPopupScript,
  winLauncherScript,
  psQuote,
  xmlEscape,
  appleScriptQuote,
} from './desktopNotify.js'

// ========== 转义 ==========

test('psQuote: 单引号翻倍,其余原样(反斜杠 / 中文不处理)', () => {
  assert.equal(psQuote("it's"), "'it''s'")
  assert.equal(psQuote('C:\\a\\b'), "'C:\\a\\b'")
  assert.equal(psQuote('发布完成'), "'发布完成'")
  assert.equal(psQuote(null), "''")
})

test('xmlEscape: 只转 & < >,引号在文本节点里合法不用转', () => {
  assert.equal(xmlEscape('a & b < c > d'), 'a &amp; b &lt; c &gt; d')
  assert.equal(xmlEscape('Unexpected token < in JSON'), 'Unexpected token &lt; in JSON')
  assert.equal(xmlEscape('"quoted"'), '"quoted"')
})

test('appleScriptQuote: 先转反斜杠再转双引号(顺序反了会把 \\" 二次转义)', () => {
  assert.equal(appleScriptQuote('say "hi"'), '"say \\"hi\\""')
  assert.equal(appleScriptQuote('C:\\tmp'), '"C:\\\\tmp"')
})

// ========== Windows:启动器 ==========

test('win32 plan: 只起一个 PowerShell(三件事都在同一个进程里做,省两次冷启动)', () => {
  const plan = buildNotifyPlan({ platform: 'win32', title: 't', message: 'm', ok: true })
  assert.equal(plan.cmds.length, 1)
  assert.equal(plan.cmds[0].cmd, 'powershell.exe')
  assert.ok(plan.cmds[0].args.includes('-NoProfile'))
  assert.ok(plan.cmds[0].args.includes('-NonInteractive'))
})

test('win32 启动器:toast + 甩弹窗 + 提示音三件事齐,且各自 try 住', () => {
  const script = buildNotifyPlan({ platform: 'win32', title: 't', message: 'm', ok: true }).cmds[0].args.at(-1)
  assert.ok(script.includes('ToastNotificationManager'), '缺 toast')
  assert.ok(script.includes('Start-Process -WindowStyle Hidden'), '缺甩弹窗')
  assert.ok(script.includes('SoundPlayer'), '缺提示音')
  assert.ok(script.includes('try {') && script.includes('catch { }'), '三件事没各自 try 住')
})

test('win32 启动器:弹窗脚本按 UTF-16LE base64 编进 -EncodedCommand', () => {
  const title = '发布完成 · zen-gitsync v1.2.3'
  const message = "包里有 'quote' 与 <tag>"
  const script = winLauncherScript({ title, message, level: 'ok' })
  const popup = winPopupScript({ title, message, level: 'ok' })
  const b64 = Buffer.from(popup, 'utf16le').toString('base64')
  assert.ok(script.includes(b64), '启动器里的 base64 与 winPopupScript 对不上')
  // 反向自证:解回来必须还是原脚本(自证不是空断言)
  const decoded = Buffer.from(b64, 'base64').toString('utf16le')
  assert.equal(decoded, popup)
  assert.ok(decoded.includes("包里有 ''quote'' 与 <tag>"), 'PS 单引号未翻倍')
})

test('win32 toast: 正文走 XML 转义,且整段脚本是单引号字面量', () => {
  const script = buildNotifyPlan({
    platform: 'win32',
    title: "it's done",
    message: 'Unexpected token < in JSON & "x"',
    ok: true,
  }).cmds[0].args.at(-1)
  assert.ok(script.includes('Unexpected token &lt; in JSON &amp; "x"'), 'XML 未转义')
  assert.ok(script.includes("it''s done"), 'PS 单引号未翻倍')
  assert.ok(!script.includes('< in JSON'), '原始 < 漏进了 XML')
})

test('win32 提示音:成功与失败是不同的音源,且成功走普通提示音', () => {
  const okScript = buildNotifyPlan({ platform: 'win32', title: 't', message: 'm', ok: true }).cmds[0].args.at(-1)
  const errScript = buildNotifyPlan({ platform: 'win32', title: 't', message: 'm', ok: false }).cmds[0].args.at(-1)
  assert.ok(okScript.includes('Windows Notify System Generic.wav'))
  assert.ok(errScript.includes('Windows Critical Stop.wav'))
  assert.ok(okScript.includes('SystemSounds]::Asterisk.Play()'))
  assert.ok(errScript.includes('SystemSounds]::Hand.Play()'))
})

test('win32 提示音:warn 用普通提示音(要人看一眼,但不是出错)', () => {
  const script = buildNotifyPlan({ platform: 'win32', title: 't', message: 'm', level: 'warn' }).cmds[0].args.at(-1)
  assert.ok(script.includes('Windows Notify System Generic.wav'))
  assert.ok(!script.includes('Windows Critical Stop.wav'))
})

// ========== Windows:弹窗 ==========

test('弹窗:置顶 + 可点掉 + 有兜底自动关闭(不然会一直挂在桌面上)', () => {
  const script = winPopupScript({ title: 't', message: 'm', level: 'ok', timeoutMs: 5000 })
  assert.ok(script.includes('$f.TopMost = $true'))
  assert.ok(script.includes('$f.Add_Click({ $f.Close() })'))
  assert.ok(script.includes("$_.KeyCode -eq 'Escape'"))
  assert.ok(script.includes('$timer.Interval = 5000'))
})

test('弹窗:先 Show 一个丢弃窗体吞掉 STARTUPINFO 的 SW_HIDE,否则真窗体永远不显示', () => {
  const script = winPopupScript({ title: 't', message: 'm' })
  const dummyAt = script.indexOf('$d.Show(); $d.Hide(); $d.Dispose()')
  const realAt = script.indexOf('ShowDialog()')
  assert.ok(dummyAt >= 0 && realAt > dummyAt, '丢弃窗体没出现在真窗体之前')
})

test('弹窗:三种结局三套配色,ok / warn / 未给 level 时按 ok 回落', () => {
  // 取顶部色条的颜色(背景色在脚本里更靠前,不能拿"第一个 Argb"当判据)
  const colorOf = (opts) =>
    winPopupScript({ title: 't', message: 'm', ...opts }).match(/\$bar\.BackColor = .*?Argb\((\d+, \d+, \d+)\)/)[1]
  assert.equal(colorOf({ level: 'ok' }), '46, 160, 67')
  assert.equal(colorOf({ level: 'warn' }), '204, 141, 30')
  assert.equal(colorOf({ level: 'error' }), '200, 70, 70')
  // 没给 level:ok:false 应当拿到错误色,而不是默认色
  assert.equal(colorOf({ ok: true }), '46, 160, 67')
  assert.equal(colorOf({ ok: false }), '200, 70, 70')
})

test('弹窗:正文里的单引号 / 换行不会破语法(整体走 psQuote)', () => {
  const script = winPopupScript({ title: "it's", message: "line1\nline2 'quoted'" })
  assert.ok(script.includes("line1\nline2 ''quoted''"))
})

// ========== macOS / Linux ==========

test('darwin plan: 一条 osascript,成功用 Glass、出错用 Basso', () => {
  const okPlan = buildNotifyPlan({ platform: 'darwin', title: 't', message: 'm', ok: true })
  const errPlan = buildNotifyPlan({ platform: 'darwin', title: 't', message: 'm', ok: false })
  assert.equal(okPlan.cmds.length, 1)
  assert.equal(okPlan.cmds[0].cmd, 'osascript')
  assert.ok(okPlan.cmds[0].args[1].includes('sound name "Glass"'))
  assert.ok(errPlan.cmds[0].args[1].includes('sound name "Basso"'))
  assert.ok(errPlan.cmds[0].args[1].includes('with title "t"'))
})

test('darwin plan: 文案里的双引号转义后再进 AppleScript', () => {
  const plan = buildNotifyPlan({ platform: 'darwin', title: 'he said "hi"', message: 'm' })
  assert.ok(plan.cmds[0].args[1].includes('with title "he said \\"hi\\""'))
})

test('linux plan: 失败用 critical 优先级,标题与正文原样落参数(不走 shell,无需转义)', () => {
  const plan = buildNotifyPlan({ platform: 'linux', title: "it's <ok>", message: 'm & m', ok: false })
  const notify = plan.cmds.find((c) => c.cmd === 'notify-send')
  assert.deepEqual(notify.args, ['-a', 'zen-gitsync', '-u', 'critical', "it's <ok>", 'm & m'])
})

test('未知平台按 linux 兜底(不抛异常)', () => {
  const plan = buildNotifyPlan({ platform: 'freebsd', title: 't', message: 'm' })
  assert.ok(plan.cmds.some((c) => c.cmd === 'notify-send'))
})

test('缺省参数不炸:title / message 全空也能生成计划', () => {
  const plan = buildNotifyPlan({ platform: 'win32' })
  assert.equal(plan.title, '')
  assert.equal(plan.cmds.length, 1)
})

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
// 只测到 buildNotifyPlan 为止,**不真的 spawn** —— 单测里弹 toast / 响一声会打扰跑测试的人。
// 这里要守住的两件事,都是"错了不会报错、只会静默失效"的类型:
//   ① 文案里的 `<` / `&` 没转义 → toast 的 XML 解析失败 → 一条都不弹,且错误被吞;
//   ② 文案里的单引号没翻倍 → PowerShell 语法错 → 静默什么都不做。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildNotifyPlan,
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

// ========== Windows ==========

test('win32 plan: 两个进程 —— toast 一个、提示音一个', () => {
  const plan = buildNotifyPlan({ platform: 'win32', title: 't', message: 'm', ok: true })
  assert.equal(plan.cmds.length, 2)
  assert.ok(plan.cmds.every((c) => c.cmd === 'powershell.exe'))
  assert.ok(plan.cmds.every((c) => c.args.includes('-NoProfile') && c.args.includes('-NonInteractive')))
})

test('win32 toast: 正文走 XML 转义,且整段脚本是单引号字面量(带引号也不炸)', () => {
  const plan = buildNotifyPlan({
    platform: 'win32',
    title: "it's done",
    message: 'Unexpected token < in JSON & "x"',
    ok: true,
  })
  const script = plan.cmds[0].args.at(-1)
  assert.ok(script.includes('Unexpected token &lt; in JSON &amp; "x"'), 'XML 未转义')
  assert.ok(script.includes("it''s done"), 'PS 单引号未翻倍')
  // 转义后的正文不能再出现裸的 <text> 之外的尖括号
  assert.ok(!script.includes('< in JSON'), '原始 < 漏进了 XML')
})

test('win32 提示音:成功与失败是不同的音源', () => {
  const okScript = buildNotifyPlan({ platform: 'win32', title: 't', message: 'm', ok: true }).cmds[1].args.at(-1)
  const failScript = buildNotifyPlan({ platform: 'win32', title: 't', message: 'm', ok: false }).cmds[1].args.at(-1)
  assert.notEqual(okScript, failScript)
  assert.ok(okScript.includes('Windows Notify System Generic.wav'))
  assert.ok(failScript.includes('Windows Critical Stop.wav'))
  // 各自的兜底音也要分开
  assert.ok(okScript.includes('SystemSounds]::Asterisk.Play()'))
  assert.ok(failScript.includes('SystemSounds]::Hand.Play()'))
})

test('win32 提示音:先 PlaySync 播 wav,播到了就不放兜底音', () => {
  const script = buildNotifyPlan({ platform: 'win32', title: 't', message: 'm' }).cmds[1].args.at(-1)
  assert.ok(script.includes('PlaySync()'))
  assert.ok(script.includes('if (-not $played)'), '兜底音没被 $played 拦住 → 会响两遍')
})

// ========== macOS / Linux ==========

test('darwin plan: 一条 osascript,成功失败用不同的 sound name', () => {
  const okPlan = buildNotifyPlan({ platform: 'darwin', title: 't', message: 'm', ok: true })
  const failPlan = buildNotifyPlan({ platform: 'darwin', title: 't', message: 'm', ok: false })
  assert.equal(okPlan.cmds.length, 1)
  assert.equal(okPlan.cmds[0].cmd, 'osascript')
  assert.ok(okPlan.cmds[0].args[1].includes('sound name "Glass"'))
  assert.ok(failPlan.cmds[0].args[1].includes('sound name "Basso"'))
  assert.ok(failPlan.cmds[0].args[1].includes('with title "t"'))
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
  assert.equal(plan.cmds.length, 2)
})

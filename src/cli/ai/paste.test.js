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
// src/cli/ai/paste.js 单元测试:
//   - 仓库/过滤器/归一化都是纯逻辑,直接断言字符串
//   - 最后一组用真 readline + PassThrough 跑端到端(terminal: true 在非 TTY stream 上可用),
//     验证"一次粘贴 = 一个 line 事件"和 rl.question 的还原 —— 这两条是本次改动的立身之本,
//     光测过滤器测不出 readline 那层的真实行为
import { test } from 'node:test'
import assert from 'node:assert/strict'
import readline from 'node:readline'
import { PassThrough } from 'node:stream'
import {
  PASTE_START, PASTE_END,
  normalizePasteText, createPasteStore, createPasteFilter, installPasteCapture,
  enableBracketedPaste, disableBracketedPaste,
} from './paste.js'

// ── 归一化 ──────────────────────────────────────────────

test('normalizePasteText: CRLF/CR 归一为 LF,并去掉复制带上的行尾换行', () => {
  assert.equal(normalizePasteText('a\r\nb\r\n'), 'a\nb')
  assert.equal(normalizePasteText('a\rb'), 'a\nb')
  assert.equal(normalizePasteText('a\nb\n'), 'a\nb')
  assert.equal(normalizePasteText('a\n\n'), 'a\n')      // 只去一个,用户主动留的空行不吞
  assert.equal(normalizePasteText(''), '')
  assert.equal(normalizePasteText(null), '')
})

// ── 仓库 ────────────────────────────────────────────────

test('store: 占位符可自定义,原文按行数/字符数生成,能原样还原', () => {
  const store = createPasteStore({
    formatToken: ({ index, lines }) => `[粘贴 #${index} · ${lines} 行]`,
  })
  const token = store.add('RADAR_REVIEW_API_KEY=sk-1\nRADAR_REVIEW_MODEL=deepseek\n')
  assert.equal(token, '[粘贴 #1 · 2 行]')

  const expanded = store.expand(`加上 .env ${token}`)
  assert.equal(expanded.text, '加上 .env RADAR_REVIEW_API_KEY=sk-1\nRADAR_REVIEW_MODEL=deepseek')
  assert.equal(expanded.used, 1)
  assert.deepEqual(expanded.stale, [])
})

test('store: 空内容不占位(只粘了一个换行不该塞个空占位符)', () => {
  const store = createPasteStore()
  assert.equal(store.add('\n'), '')
  assert.equal(store.add(''), '')
  assert.equal(store.size, 0)
})

test('store: 普通方括号文本不会被误还原', () => {
  const store = createPasteStore()
  store.add('x\ny')
  const out = store.expand('数组 [1] 和 [粘贴 stuff] 都该原样保留')
  assert.equal(out.text, '数组 [1] 和 [粘贴 stuff] 都该原样保留')
  assert.equal(out.used, 0)
})

test('store: 多段粘贴各自还原,互不串门', () => {
  const store = createPasteStore({ formatToken: ({ index }) => `<p${index}>` })
  const a = store.add('A1\nA2')
  const b = store.add('B1\nB2')
  assert.equal(store.expand(`${a} 与 ${b}`).text, 'A1\nA2 与 B1\nB2')
})

test('store: 超容量淘汰最旧的,命中旧占位符时报 stale 而不是静默出错', () => {
  const store = createPasteStore({ maxEntries: 2, formatToken: ({ index }) => `<p${index}>` })
  store.add('one')
  store.add('two')
  store.add('three')                       // 挤掉 <p1>
  const out = store.expand('<p1> 和 <p2>')
  assert.equal(out.text, '<p1> 和 two')    // 活的照常还原
  assert.deepEqual(out.stale, ['<p1>'])    // 死的明确点名
  assert.equal(out.used, 1)
})

// ── 过滤器 ──────────────────────────────────────────────

test('filter: 整段粘贴替换为一个占位符,后面的回车照常透传', () => {
  const store = createPasteStore({ formatToken: ({ index, lines }) => `<p${index}:${lines}>` })
  const filter = createPasteFilter({ store })
  const out = filter.push(`${PASTE_START}a\nb\nc${PASTE_END}\r`)
  assert.equal(out, '<p1:3>\r')
  assert.equal(store.expand('<p1:3>').text, 'a\nb\nc')
})

test('filter: 标记被切在两个 chunk 里也能识别', () => {
  const store = createPasteStore({ formatToken: () => '<P>' })
  const filter = createPasteFilter({ store })
  // 起止标记各切一刀,内容再切一刀 —— 模拟大粘贴被 TCP/终端分片
  assert.equal(filter.push(`\x1b[20`), '')
  assert.equal(filter.push(`0~first\n`), '')
  assert.equal(filter.push(`second\x1b[20`), '')
  assert.equal(filter.push(`1~\r`), '<P>\r')
  assert.equal(store.expand('<P>').text, 'first\nsecond')
})

test('filter: 不含粘贴标记的普通数据原样输出(含跨块拼接)', () => {
  const store = createPasteStore()
  const filter = createPasteFilter({ store })
  assert.equal(filter.push('hello'), 'hello')
  assert.equal(filter.push(' world'), ' world')
  assert.equal(filter.push(Buffer.from('中文\n', 'utf8')), '中文\n')
})

test('filter: needsRewrite 对普通打字走快路径,只有疑似粘贴标记才改写', () => {
  const filter = createPasteFilter({ store: createPasteStore() })
  assert.equal(filter.needsRewrite('abc'), false)
  assert.equal(filter.needsRewrite(Buffer.from('abc')), false)
  // 方向键这类 ESC 序列不含 `\x1b[20`,照样走快路径(Buffer 都不转字符串)
  assert.equal(filter.needsRewrite('\x1b[A'), false)
  assert.equal(filter.push('\x1b[A'), '\x1b[A')
  // 疑似标记(可能被切块)→ 走改写;解析器找不到完整标记时原样返回
  assert.equal(filter.needsRewrite('\x1b[20'), true)
  assert.equal(filter.push('\x1b[20'), '')
  assert.equal(filter.push('04h'), '\x1b[2004h')      // 拼回原样,没被吃掉
})

test('filter: 结束标记一直不来时兜底关闭,不吞后续输入', async () => {
  const store = createPasteStore({ formatToken: () => '<P>' })
  const flushed = []
  const filter = createPasteFilter({ store, flushDelayMs: 20, onFlush: (t) => flushed.push(t) })
  assert.equal(filter.push(`${PASTE_START}orphan\ncontent`), '')
  assert.equal(filter.inPaste, true)
  await new Promise((r) => setTimeout(r, 60))
  assert.deepEqual(flushed, ['<P>'])
  assert.equal(filter.inPaste, false)
  assert.equal(store.expand('<P>').text, 'orphan\ncontent')
  filter.dispose()
})

test('filter: 未开 bracketed paste 的终端不会被改坏(没有标记 = 没有行为)', () => {
  const store = createPasteStore()
  const filter = createPasteFilter({ store })
  // 终端不支持时,多行粘贴就是一串带 \n 的普通字节 —— 过滤器照原样放行
  assert.equal(filter.push('line1\nline2\n'), 'line1\nline2\n')
  assert.equal(store.size, 0)
})

// ── 终端开关 ────────────────────────────────────────────

test('bracketed paste 开关: 只在 TTY 且未禁用时写 DECSET 2004', () => {
  const tty = { isTTY: true }
  const out = []
  assert.equal(enableBracketedPaste(s => out.push(s), { env: {}, stream: tty }), true)
  assert.equal(disableBracketedPaste(s => out.push(s), { env: {}, stream: tty }), true)
  assert.deepEqual(out, ['\x1b[?2004h', '\x1b[?2004l'])

  // 管道 / CI / TERM=dumb / 逃生开关:一个字节都不该写出去
  const silent = []
  const write = s => silent.push(s)
  assert.equal(enableBracketedPaste(write, { env: {}, stream: { isTTY: false } }), false)
  assert.equal(enableBracketedPaste(write, { env: {}, stream: undefined }), false)
  assert.equal(enableBracketedPaste(write, { env: { TERM: 'dumb' }, stream: tty }), false)
  assert.equal(enableBracketedPaste(write, { env: { ZEN_AI_NO_BRACKETED_PASTE: '1' }, stream: tty }), false)
  assert.equal(disableBracketedPaste(write, { env: { ZEN_AI_NO_BRACKETED_PASTE: '1' }, stream: tty }), false)
  assert.deepEqual(silent, [])
})

// ── 端到端:真 readline ─────────────────────────────────

/** 造一个跑在内存流上的 readline(terminal: true,与线上 TTY 分支同一套键位解析) */
function makeRepl() {
  const input = new PassThrough()
  const output = new PassThrough()
  output.resume()
  const rl = readline.createInterface({ input, output, terminal: true, prompt: '> ' })
  const lines = []
  rl.on('line', (line) => lines.push(line))
  return { input, output, rl, lines }
}

function nextLine(lines, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (lines.length) return resolve(lines[0])
      if (Date.now() - started > timeoutMs) return reject(new Error('no line event'))
      setTimeout(tick, 5)
    }
    tick()
  })
}

test('端到端: 多行粘贴只产生一个 line 事件,展开后就是原文', async () => {
  const { input, rl, lines } = makeRepl()
  const capture = installPasteCapture(rl, {
    formatToken: ({ index, lines: n }) => `[粘贴 #${index} · ${n} 行]`,
  })
  assert.ok(capture)

  input.write(`${PASTE_START}加上 .env\nRADAR_REVIEW_API_KEY=sk-x2Gt\nRADAR_REVIEW_MODEL=deepseek\x1b[201~\r`)
  const line = await nextLine(lines)

  // 修复前:这里会是 3 个 line 事件,且只有第一个能发出去
  assert.equal(lines.length, 1)
  assert.equal(line, '[粘贴 #1 · 3 行]')
  assert.equal(
    capture.expand(line).text,
    '加上 .env\nRADAR_REVIEW_API_KEY=sk-x2Gt\nRADAR_REVIEW_MODEL=deepseek'
  )
  rl.close()
})

test('端到端: 占位符里含中文/中点也不破坏 readline 的按键解析', async () => {
  const { input, rl, lines } = makeRepl()
  const capture = installPasteCapture(rl, { formatToken: ({ index, lines: n }) => `[粘贴 #${index} · ${n} 行]` })

  input.write(`${PASTE_START}甲乙丙\n丁戊己${PASTE_END}\r`)
  const line = await nextLine(lines)
  // 真值:中文占位符原样进输入行(说明 string chunk 没被 readline 的 StringDecoder 啃坏)
  assert.equal(line, '[粘贴 #1 · 2 行]')
  assert.equal(capture.expand(line).text, '甲乙丙\n丁戊己')
  rl.close()
})

test('端到端: 粘贴后继续手打再回车,拼接顺序正确', async () => {
  const { input, rl, lines } = makeRepl()
  const capture = installPasteCapture(rl, { formatToken: () => '<P>' })

  input.write(`${PASTE_START}KEY=1\nSECRET=2${PASTE_END}`)
  input.write(' 请写进 .env')
  input.write('\r')
  const line = await nextLine(lines)
  assert.equal(capture.expand(line.trim()).text, 'KEY=1\nSECRET=2 请写进 .env')
  rl.close()
})

test('端到端: rl.question 的回调拿到的是还原后的答案(不经过 line 事件)', async () => {
  const { input, rl, lines } = makeRepl()
  const capture = installPasteCapture(rl, { formatToken: () => '<P>' })

  const answer = await new Promise((resolve) => {
    rl.question('path: ', (a) => resolve(a))
    input.write(`${PASTE_START}/var/www/a\n/var/www/b${PASTE_END}\r`)
  })
  assert.equal(answer, '/var/www/a\n/var/www/b')
  assert.equal(lines.length, 0)     // question 期间不触发 line 事件 —— 所以必须单独包 question
  rl.close()
})

test('installPasteCapture: 输入流不可改写时给空实现,调用方无需判空', () => {
  const capture = installPasteCapture({ /* 没有 input */ })
  assert.equal(capture.expand('原文').text, '原文')
  assert.equal(capture.expand('原文').used, 0)
  capture.dispose()   // 不应抛
})

test('端到端: dispose 后恢复原样,不再拦数据(也不会把终端留在 bracketed paste 里)', async () => {
  const { input, rl, lines } = makeRepl()
  const capture = installPasteCapture(rl, { formatToken: () => '<P>' })
  // 补丁是给 input 加的自有属性(原型上的 emit 没被动过)→ 卸载后应当连属性都不剩
  assert.equal(Object.prototype.hasOwnProperty.call(input, 'emit'), true)
  capture.dispose()
  assert.equal(Object.prototype.hasOwnProperty.call(input, 'emit'), false)
  assert.equal(typeof rl.question, 'function')

  // 卸载后:多行粘贴回到"每个 \n 一次提交"的 readline 原生行为(不再吞内容)
  input.write('a\nb\n')
  await nextLine(lines)
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(lines, ['a', 'b'])
  rl.close()
})

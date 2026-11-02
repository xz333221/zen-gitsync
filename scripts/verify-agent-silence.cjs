#!/usr/bin/env node
/**
 * g ai 的「静默提示」契约探针。
 *
 * 来历（2026-10-17）：用户反馈「任务看板不动了有静默时间，g ai 静默了体现不出来」
 *   —— 对话头部新增「静默 x 秒」（ChatSilenceBadge），计时源是本轮最后一次 SSE 事件。
 * 同一轮里还给 .acu-input-wrap 加过一层「平铺」覆盖（浅底 + 6px 圆角 + 无描边），
 * 那一层在 2026-11-01 **整块删掉**了：库自己改成了 WorkBuddy 式卡片，用户要求
 * g ai 与演示页一致。所以本探针不再量输入框样式 —— 那已经是库的契约，宿主别再覆盖。
 *
 * B 组（静默徽标）：桩一条「吐两个事件后永不结束」的 SSE（route.fulfill 会整段发完、
 * 流立刻结束，测不出中间的静默态，必须覆盖 window.fetch 自己造流）。
 *   B1 发送前不渲染          B2 刚出字（<10s）不渲染
 *   B3 静默 >10s 渲染        B4 文案形如「静默 N 秒」
 *   B5 点「停止」后消失（isStreaming=false 要立刻收掉，不是等下一轮）
 * 桩必须自己响应 AbortSignal：真 fetch 会随 signal 断流，不实现它「停止」永远不生效。
 *
 * 反向（--reverse）：把徽标 display:none!important，B3 必须翻红 ——
 *   否则这组断言在"样式没生效"时照样绿。
 *
 * 前置：dev server 已起（前端 5544；后端 5545 供其它请求走通）。
 * 用法：node scripts/verify-agent-silence.cjs
 *       node scripts/verify-agent-silence.cjs --reverse
 * 退出码：0 全通过；1 有失败项；2 环境没起。
 */
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const REVERSE = process.argv.includes('--reverse')

module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const API = process.env.ZEN_API || 'http://127.0.0.1:5545'

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)

/** 库内 MessageRail 的 ResizeObserver 在 jsdom/浏览器里报的老问题（存量，与本轮无关） */
const STOCK_ERROR = /getBoundingClientRect is not a function/

async function alive() {
  try {
    const res = await fetch(`${API}/api/app-version`)
    return res.ok
  } catch { return false }
}

async function openAgent(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-body', { timeout: 60000 })
  // AI 对话入口 2026-10 整合为右下角悬浮 dock：点 mascot 展开面板
  await page.click('.agent-dock__mascot')
  await page.waitForSelector('.acu-input-textarea', { timeout: 30000 })
}

/**
 * 桩一条「吐两个事件后永不结束」的 SSE（必须在 goto 之前装 —— addInitScript 只对
 * 之后的导航生效）。route.fulfill 会把 body 整段发完、流立刻结束，测不出中间的静默态。
 */
function installChatStub(page) {
  return page.addInitScript(() => {
    const orig = window.fetch
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      if (url.includes('/api/agent/chat')) {
        const encoder = new TextEncoder()
        let ctrl
        const stream = new ReadableStream({ start(c) { ctrl = c } })
        const push = (obj) => ctrl.enqueue(encoder.encode('data: ' + JSON.stringify(obj) + '\n\n'))
        setTimeout(() => push({ type: 'meta', sessionId: 'probe-silence', title: '静默探针' }), 120)
        setTimeout(() => push({ type: 'content', delta: '开始回答' }), 400)
        // 之后只静默：不发 done、不 close。
        // 桩必须自己响应 abort —— 真 fetch 会随 signal 断流，不实现它的话
        // 点「停止」后 reader.read() 永远挂着，isStreaming 不会回 false（探针假红）。
        if (init && init.signal) {
          init.signal.addEventListener('abort', () => {
            try { ctrl.error(new DOMException('aborted', 'AbortError')) } catch { /* 已关 */ }
          })
        }
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return orig(input, init)
    }
  })
}

async function silenceChecks(page) {
  if (REVERSE) {
    await page.addStyleTag({ content: '.chat-silence{display:none!important}' })
  }

  const idle = await page.locator('.agent-tabs .chat-silence').count()
  check('B1 发送前不渲染', idle === 0, 'count=' + idle)

  await page.fill('.agent-chat-host .acu-input-textarea', '测一下静默提示')
  await page.press('.agent-chat-host .acu-input-textarea', 'Enter')

  await page.waitForTimeout(1500)
  const early = await page.locator('.agent-tabs .chat-silence').count()
  check('B2 刚出字（<10s）不渲染', early === 0, 'count=' + early)

  const appeared = await page.waitForSelector('.agent-tabs .chat-silence', { timeout: 20000 })
    .then(() => true).catch(() => false)

  if (REVERSE) {
    check('R5 徽标被藏掉后「静默 >10s 出现」翻红', !appeared, 'appeared=' + appeared)
    return
  }

  check('B3 静默 >10s 出现', appeared)
  const text = appeared ? (await page.locator('.agent-tabs .chat-silence').innerText()).trim() : ''
  check('B4 文案是「静默 N 秒」', /^静默 \d+ 秒$/.test(text), text)

  const stop = page.locator('.acu-input-send.is-stop')
  if (await stop.count()) {
    await stop.click()
    await page.waitForTimeout(1200)
    check('B5 停止后立刻消失', (await page.locator('.agent-tabs .chat-silence').count()) === 0)
  } else {
    check('B5 前置：停止按钮存在', false, 'not found')
  }
}

;(async () => {
  if (!(await alive())) {
    console.error(`后端没起（${API}/api/app-version）—— 先 npm run dev:server`)
    process.exit(2)
  }

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    const errors = []
    page.on('pageerror', e => {
      const msg = String(e.message || e)
      if (!STOCK_ERROR.test(msg)) errors.push(msg)
    })

    await installChatStub(page)
    await openAgent(page)
    await silenceChecks(page)

    check('无新增 pageerror（库内 MessageRail 存量已排除）', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
  }

  const failed = results.filter(r => !r.ok)
  log(`${results.length - failed.length}/${results.length} passed${REVERSE ? '（反向）' : ''}`)
  process.exit(failed.length ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })

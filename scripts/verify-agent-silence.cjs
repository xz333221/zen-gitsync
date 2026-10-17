#!/usr/bin/env node
/**
 * g ai 的「平铺输入框 + 静默提示」契约探针。
 *
 * 两件事是同一轮用户反馈的两半（2026-10-17）：
 *   ① "我不喜欢圆角加单 border 的样式" —— 四个 g ai 入口共用的 .acu-input-wrap
 *      从组件库的「20px 圆角 + 1px 描边 + 静息阴影」改成「浅底 + 6px 圆角 + 无描边」；
 *   ② "任务看板不动了有静默时间，g ai 静默了体现不出来" —— 对话头部新增
 *      「静默 x 秒」（ChatSilenceBadge），计时源是本轮最后一次 SSE 事件。
 *
 * A 组（输入框）：直接量 computed style，light / dark 两套都要成立。
 *   A1 静止态描边不可见（transparent，保留 1px 占位）   A2 圆角 6px
 *   A3 无静息阴影                                     A4 静止底色不是纯白（平铺浅底）
 *   A5 聚焦后出现 1px 主色描边（不是 3px 光晕）        A6 深色静止态同样无可见描边
 *   ⚠️ 选择器必须带 html body + 重复类名：库的 ChatInput 是 scoped 样式
 *      （.acu-input-wrap[data-v-x] = 0,2,0），普通 `html .acu-input-wrap` 压不住它。
 *
 * B 组（静默徽标）：桩一条「吐两个事件后永不结束」的 SSE（route.fulfill 会整段发完、
 * 流立刻结束，测不出中间的静默态，必须覆盖 window.fetch 自己造流）。
 *   B1 发送前不渲染          B2 刚出字（<10s）不渲染
 *   B3 静默 >10s 渲染        B4 文案形如「静默 N 秒」
 *   B5 点「停止」后消失（isStreaming=false 要立刻收掉，不是等下一轮）
 * 桩必须自己响应 AbortSignal：真 fetch 会随 signal 断流，不实现它「停止」永远不生效。
 *
 * 反向（--reverse）：注入旧输入框样式 + 把徽标 display:none!important，
 *   A1~A4 / B3 必须全部翻红 —— 否则这组断言在"样式没生效"时照样绿。
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
  // aria-label 可能带「· N 个对话正在生成」后缀，用前缀匹配
  await page.click('.activity-bar button[aria-label^="智能体"]')
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

function readWrap(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.agent-chat-host .acu-input-wrap')
    if (!el) return null
    const cs = getComputedStyle(el)
    return {
      border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
      radius: cs.borderTopLeftRadius,
      bg: cs.backgroundColor,
      shadow: cs.boxShadow,
    }
  })
}
const noBorder = (v) => !!v && v.startsWith('1px solid rgba(0, 0, 0, 0)')
const primaryBorder = (v) => !!v && /^1px solid rgb\(59, 130, 246\)/.test(v)

async function styleChecks(page) {
  // 明确 blur / focus，别靠"点一下别处"（Chrome 下按钮点击不一定转移焦点）
  await page.evaluate(() => document.activeElement && document.activeElement.blur())
  await page.waitForTimeout(250)
  const light = await readWrap(page)
  await page.evaluate(() => document.querySelector('.agent-chat-host .acu-input-textarea')?.focus())
  await page.waitForTimeout(250)
  const lightFocus = await readWrap(page)
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await page.evaluate(() => document.activeElement && document.activeElement.blur())
  await page.waitForTimeout(250)
  const dark = await readWrap(page)

  // 反向：把库的旧写法注回去（!important 才压得过 scoped 规则），A 组必须翻红
  if (REVERSE) {
    await page.addStyleTag({
      content: `.acu-input-wrap{border:1px solid #dfe0e9!important;border-radius:20px!important;
        box-shadow:0 1px 2px rgba(24,24,35,.04)!important;background:#fff!important}`,
    })
    await page.waitForTimeout(200)
    const back = await readWrap(page)
    check('R1 旧样式注入后「无描边」翻红', !noBorder(back?.border), back?.border)
    check('R2 旧样式注入后「6px 圆角」翻红', back?.radius !== '6px', back?.radius)
    check('R3 旧样式注入后「无阴影」翻红', back?.shadow !== 'none', back?.shadow)
    check('R4 旧样式注入后「非纯白底」翻红', back?.bg === 'rgb(255, 255, 255)', back?.bg)
    return
  }

  check('A1 静止态无可见描边（浅色）', noBorder(light?.border), light?.border)
  check('A2 圆角 6px（--radius-md）', light?.radius === '6px', light?.radius)
  check('A3 无静息阴影', light?.shadow === 'none', light?.shadow)
  check('A4 静止底是浅色平铺底（不是纯白）', !!light && light.bg !== 'rgb(255, 255, 255)', light?.bg)
  check('A5 聚焦后是 1px 主色描边', primaryBorder(lightFocus?.border), lightFocus?.border)
  check('A6 深色静止态同样无可见描边', noBorder(dark?.border), dark?.border)
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
    await styleChecks(page)
    await silenceChecks(page)

    check('无新增 pageerror（库内 MessageRail 存量已排除）', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
  }

  const failed = results.filter(r => !r.ok)
  log(`${results.length - failed.length}/${results.length} passed${REVERSE ? '（反向）' : ''}`)
  process.exit(failed.length ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })

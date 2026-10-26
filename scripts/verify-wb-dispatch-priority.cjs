/**
 * 「派活执行器优先级」的浏览器验收。
 *
 * 为什么要有这个：
 *   优先级是**纯前端解析**的（可用性只有 /api/check-tools 知道），失效方式是
 *   "设置里排好了、派发时还是走原来那个" —— 不报错、界面也看不出问题。
 *   所以这里验两件事：
 *     1. 设置面板里的列表真的渲染出来了，并且顺序就是存的顺序；
 *     2. dock 底栏在**有优先级**时变成只读链条、**清空后**变回可点下拉。
 *   第 2 条自带反向对照（同一趟里两个方向都断言），比单独跑 --reverse 更直接。
 *
 * 前置：dev server 已启动（后端 5545 / 前端 5544）。
 * ⚠️ 脚本会临时改写 ui.dispatchExecutorPriority，结束时**逐字还原**。
 * 用法：node scripts/verify-wb-dispatch-priority.cjs
 * 退出码：0 全通过；1 有失败项；2 环境没起。
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const API = process.env.ZEN_API || 'http://127.0.0.1:5545'

const results = []
const pageErrors = []
const consoleErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function launchBrowser() {
  const attempts = [
    ['chromium', {}],
    ['msedge', { channel: 'msedge' }],
    ['chrome', { channel: 'chrome' }],
  ]
  const errors = []
  for (const [name, opts] of attempts) {
    try {
      const b = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...opts })
      log('浏览器:', name)
      return b
    } catch (e) {
      errors.push(`${name}: ${String(e.message || e).split('\n')[0]}`)
    }
  }
  throw new Error('没有可用的浏览器:\n  ' + errors.join('\n  '))
}

const post = (url, body) => fetch(`${API}${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(r => r.json()).catch(() => null)

const getConfig = () => fetch(`${API}/api/config/getConfig`, { cache: 'no-store' })
  .then(r => r.json()).catch(() => null)

async function waitFor(fn, { timeout = 8000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) return null
    await sleep(interval)
  }
}

/** 开 dock → 最大化（窄面板下 Tab 是图标紧凑态，读不到文字） */
async function openDock(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-body', { timeout: 60000 })
  await page.click('.agent-dock__mascot')
  await page.waitForSelector('.agent-view', { timeout: 30000 })
  await page.click('.agent-dock__btn--max')
  await page.waitForSelector('.agent-tab', { timeout: 30000 })
}

async function run() {
  const cfg0 = await getConfig()
  if (!cfg0) { console.error('读不到配置，dev server 起了吗？'); process.exit(2) }
  const original = Array.isArray(cfg0?.ui?.dispatchExecutorPriority)
    ? cfg0.ui.dispatchExecutorPriority
    : []
  log('原优先级:', JSON.stringify(original))

  const browser = await launchBrowser()
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage()
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    if (/Failed to load resource/.test(m.text())) return
    consoleErrors.push(m.text())
  })

  try {
    // ── ① 空优先级：底栏是**可点下拉**（改造前行为，作为反向对照） ──
    await post('/api/config/save-ui-settings', { dispatchExecutorPriority: [] })
    await openDock(page)
    await page.waitForSelector('.agent-dispatch-foot', { timeout: 15000 })
    const emptyState = await page.evaluate(() => {
      const foot = document.querySelector('.agent-dispatch-foot')
      if (!foot) return null
      return {
        hasDropdown: !!foot.querySelector('.tep .tep__btn-caret'),
        hasStatic: !!foot.querySelector('.tep--static'),
        label: (foot.textContent || '').replace(/\s+/g, ' ').trim(),
      }
    })
    check('A1 没配优先级 → 底栏仍是原来的可点下拉', !!emptyState && emptyState.hasDropdown && !emptyState.hasStatic,
      JSON.stringify(emptyState))

    // ── ② 设置面板里有「派发设置」区块 ──
    await page.click('.agent-tab[title="设置"]')
    await page.waitForSelector('.aps', { timeout: 15000 })
    const settings = await page.evaluate(() => {
      const root = document.querySelector('.dps')
      if (!root) return null
      return {
        title: (root.querySelector('.dps__title')?.textContent || '').trim(),
        switch: !!root.querySelector('.dps__switch'),
        empty: (root.querySelector('.dps__empty')?.textContent || '').trim(),
        items: Array.from(root.querySelectorAll('.dps__item')).map(el =>
          (el.querySelector('.dps__name')?.textContent || '').trim()),
      }
    })
    check('B1 设置面板里出现「派发设置」（标题 + 主动派活开关）',
      !!settings && settings.title.includes('派发') && settings.switch, JSON.stringify(settings))
    check('B2 没配优先级时给一句空态说明（不是一片空白）',
      !!settings && settings.empty.length > 0, JSON.stringify(settings && settings.empty))

    // ── ③ 写入优先级 → 列表按存储顺序渲染 ──
    await post('/api/config/save-ui-settings', { dispatchExecutorPriority: ['claude', 'pi'] })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.app-body', { timeout: 60000 })
    await page.click('.agent-dock__mascot')
    await page.waitForSelector('.agent-view', { timeout: 30000 })
    await page.click('.agent-dock__btn--max')
    await page.waitForSelector('.agent-tab', { timeout: 30000 })
    await page.click('.agent-tab[title="设置"]')
    await page.waitForSelector('.dps', { timeout: 15000 })

    const rows = await page.$$eval('.dps__item', els => els.map(el => ({
      order: (el.querySelector('.dps__order')?.textContent || '').trim(),
      name: (el.querySelector('.dps__name')?.textContent || '').trim(),
    })))
    check('C1 优先级列表按存储顺序渲染（两条、序号 1/2）',
      rows.length === 2 && rows[0].order === '1' && rows[1].order === '2',
      JSON.stringify(rows))
    check('C2 第一条是 claude（顺序是用户的成本意图，不能被排序改掉）',
      rows[0] && rows[0].name === 'Claude Code', JSON.stringify(rows))

    // ── ④ dock 底栏变只读链条 ──
    await page.click('.agent-tab[title="对话"]')
    await page.waitForSelector('.agent-dispatch-foot', { timeout: 15000 })
    const withPriority = await page.evaluate(() => {
      const foot = document.querySelector('.agent-dispatch-foot')
      if (!foot) return null
      const btn = foot.querySelector('.tep__btn')
      return {
        hasStatic: !!foot.querySelector('.tep--static'),
        hasDropdown: !!foot.querySelector('.tep .tep__btn-caret'),
        name: (btn?.querySelector('.tep__btn-name')?.textContent || '').trim(),
        tag: (btn?.querySelector('.tep__btn-tag')?.textContent || '').trim(),
        title: btn?.getAttribute('title') || '',
        hint: (foot.querySelector('.agent-dispatch-hint')?.textContent || '').replace(/\s+/g, ' ').trim(),
      }
    })
    check('D1 配了优先级 → 底栏变只读链条（不再给可点的下拉）',
      !!withPriority && withPriority.hasStatic && !withPriority.hasDropdown, JSON.stringify(withPriority))
    check('D2 只读态标出「按优先级」并显示具体执行器',
      !!withPriority && withPriority.tag.length > 0 && withPriority.name.length > 0,
      JSON.stringify(withPriority))
    check('D3 title 里摊开整条链（面板窄时链不上屏，靠 title 兜）',
      !!withPriority && withPriority.title.includes('→'), JSON.stringify(withPriority && withPriority.title))

    // ── ⑤ 清空 → 变回下拉（同一趟里的反向对照） ──
    await post('/api/config/save-ui-settings', { dispatchExecutorPriority: [] })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.app-body', { timeout: 60000 })
    await page.click('.agent-dock__mascot')
    await page.waitForSelector('.agent-view', { timeout: 30000 })
    await page.click('.agent-dock__btn--max')
    await page.waitForSelector('.agent-dispatch-foot', { timeout: 15000 })
    const cleared = await page.evaluate(() => {
      const foot = document.querySelector('.agent-dispatch-foot')
      return foot ? {
        hasDropdown: !!foot.querySelector('.tep .tep__btn-caret'),
        hasStatic: !!foot.querySelector('.tep--static'),
      } : null
    })
    check('E1 清空优先级 → 底栏回到可点下拉（这条同时是 D1 的反向对照）',
      !!cleared && cleared.hasDropdown && !cleared.hasStatic, JSON.stringify(cleared))

    check('F1 无 JS 运行时异常', pageErrors.length === 0, pageErrors.join(' | '))
    check('F2 无控制台错误', consoleErrors.length === 0, consoleErrors.join(' | '))
  } finally {
    try { await post('/api/config/save-ui-settings', { dispatchExecutorPriority: original }) } catch { /* ignore */ }
    try { await browser.close() } catch { /* ignore */ }
  }
}

run().catch((err) => {
  results.push({ name: '异常', ok: false, extra: String(err && err.message || err) })
}).then(async () => {
  // 还原后等一下落盘（save-ui-settings 是同步写，这里只是给日志一点余量）
  await sleep(200)
  const failed = results.filter(r => !r.ok)
  if (failed.length) {
    console.error('\n[wb-dispatch-priority] 失败:')
    failed.forEach(f => console.error('  ✗ ' + f.name + (f.extra ? '  :: ' + f.extra : '')))
    process.exit(1)
  }
  console.log(`[wb-dispatch-priority] 全部断言通过（${results.length} 条）`)
})

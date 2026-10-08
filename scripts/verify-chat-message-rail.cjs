/**
 * 对话侧边条（消息缩略指示器）的浏览器验收。
 *
 * 症状（用户报 2026-10-08，附两张截图）：任务执行弹窗与主 Agent 控制台的对话流左边缘
 * **都没有那条「一轮问答一根」的短横条**。根因是库的 MessageRail 属于**默认关闭**项
 * （`enable` 默认 false，要接入方显式打开），而宿主五个对话容器从来没把配置传下去 ——
 * 「库支持、宿主没接」，与上一轮的「思考块耗时」是同一形态。
 *
 * 验收契约：
 *   A1 任务执行弹窗：对话流左边缘出现侧边条，**条数 = 该会话的用户消息数**（一轮一根）
 *   A2 条宽落在配置区间（8..26px，宽度是"这一轮篇幅"的编码）；静止态半透明、悬停整组显形
 *   A3 悬停某根条 → 浮层出现，且带的是**那一轮**的提问摘要（不是别的轮）
 *   A4 点第一根条 → 对话流跳回该轮提问（滚动位置显著上移、且那一轮进视口）
 *   B1 主 Agent 控制台：选一条 ≥2 轮的会话，对话流同样出现侧边条
 *   R1 反向护栏：只有一轮的对话**不画**侧边条（库的门槛）——证明上面几条不是"到处都有"的假绿
 *
 * 为什么必须量 DOM 而不是只读配置：用户的两次反馈都出在"配置/数据都对、界面上没有"，
 * 只断言宿主传了参数等于什么都没验 —— 库认不认这个字段、条画不画得出来，只有真挂出来算数。
 *
 * 前置：dev server 已启动（vite 5544 + 后端 5545；先 `npm run dev:ping` 两个 OK）。
 * 用法：node scripts/verify-chat-message-rail.cjs
 * 退出码：0 全通过，1 有失败项，2 脚本异常。
 */
const os = require('node:os')
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const API = BASE
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'zen-chat-rail')
const RAIL_MIN_W = 8
const RAIL_MAX_W = 26

const results = []
const consoleErrors = []
const pageErrors = []
const skips = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
function skip(name, why) {
  skips.push({ name, why })
  console.log(`  SKIP  ${name}  :: ${why}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()

async function waitFor(fn, timeout = 10000, step = 150) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 > timeout) return false
    await sleep(step)
  }
}

/** 当前对话流里侧边条与用户消息的读数（都从真的 DOM 上读）。
 *  scope = 某个对话流容器里的 `.acu-message-list`；看板背后还挂着主 Agent 控制台，
 *  不限定作用域会读到那一边的条（第一版就是这么写错的）。 */
async function readRail(page, scope = '.acu-message-list') {
  return page.evaluate((sel) => {
    const list = document.querySelector(sel)
    const wrap = list ? list.closest('.acu-message-list-wrap') : null
    if (!list || !wrap) return { rail: false, list: !!list }
    const rail = wrap.querySelector('.acu-rail')
    if (!rail) return { rail: false, list: true }
    const bars = [...rail.querySelectorAll('.acu-rail-bar')]
    const users = [...list.querySelectorAll('.acu-bubble-row.is-user')]
    const first = users[0] || null
    const listRect = list.getBoundingClientRect()
    const inner = list.querySelector('.acu-message-list-inner')
    return {
      rail: true,
      list: true,
      bars: bars.length,
      users: users.length,
      widths: bars.map(b => Math.round(parseFloat(b.style.width) || 0)),
      railOpacity: getComputedStyle(rail).opacity,
      /** 侧边条的右缘 / 内容列的左缘（都相对视口）——两者相减 ≤ 2 才算没压到内容 */
      railRight: Math.round(rail.getBoundingClientRect().right),
      innerLeft: Math.round((inner || list).getBoundingClientRect().left),
      firstUserText: first ? (first.textContent || '').replace(/\s+/g, ' ').trim() : '',
      firstUserTop: first ? Math.round(first.getBoundingClientRect().top - listRect.top) : null,
      scrollTop: Math.round(list.scrollTop),
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
    }
  }, scope)
}

async function main() {
  // ── 挑样本 ──────────────────────────────────────────────────────────────
  const jobsRes = await fetch(`${API}/api/workbench/jobs`).then(r => r.json()).catch(() => ({}))
  const tasksRes = await fetch(`${API}/api/workbench/tasks`).then(r => r.json()).catch(() => ({}))
  const jobs = jobsRes.jobs || []
  const tasks = tasksRes.tasks || []

  /** 该任务的"轮"（有 prompt 的 job）——与 WorkbenchView 的 subId 过滤同口径 */
  const turnsOf = (taskId) => jobs.filter(j =>
    (j.subId === `${taskId}__simple` || String(j.subId || '').startsWith(`${taskId}__simple__r`)) && (j.prompt || '').length > 0)

  const multi = tasks
    .map(t => ({ t, n: turnsOf(t.id).length }))
    .filter(x => x.n >= 3 && (x.t.title || '').trim().length >= 6)
    .sort((a, b) => b.n - a.n)[0]

  check('A0 有一条 ≥3 轮的任务当样本', !!multi, multi ? `${multi.t.title.slice(0, 20)}｜${multi.n} 轮` : '没有')
  if (!multi) {
    console.error('[verify] 没有多轮任务样本，无法验证（先在工作台跑几轮）')
    process.exit(2)
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  /** 从看板点某条任务的卡片，等弹窗出来 */
  async function openFromBoard(task) {
    const card = page.locator('.kb-card', { hasText: task.title.slice(0, 18) }).first()
    if (!(await card.count())) return false
    await card.click()
    return waitFor(async () => page.evaluate(() => {
      const el = document.querySelector('.wb-editor')
      return !!el && el.offsetParent !== null
    }), 12000)
  }

  /** 关掉任务弹窗（幂等：没开就不动 —— 无条件点会等一个不可见的按钮 30s 然后抛） */
  async function closeEditor() {
    const btn = page.locator('.wb-back-btn').first()
    if ((await btn.count()) && await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {})
      await sleep(700)
    }
  }

  /** 等"平滑滚动"停稳（库用的是 behavior:'smooth'，19k px 的距离要滚一秒多） */
  async function settleScroll(scope, timeout = 4000) {
    let last = null
    const t0 = Date.now()
    for (;;) {
      const now = (await readRail(page, scope)).scrollTop
      if (last !== null && Math.abs(now - last) <= 1) return now
      last = now
      if (Date.now() - t0 > timeout) return now
      await sleep(150)
    }
  }

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 30000 })
    await page.locator('.loading-container').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.board', { timeout: 15000 })
    await sleep(2500)
    const allProj = page.locator('.proj-item--all')
    if (await allProj.count()) { await allProj.first().click(); await sleep(800) }

    // ── A1~A4 任务执行弹窗 ────────────────────────────────────────────────
    // 所有选择器都限定在弹窗内：看板背后还挂着主 Agent 控制台，不限定会读到那一边
    const MODAL_LIST = '.wb-editor .acu-message-list'
    const opened = await openFromBoard(multi.t)
    check('A1a 点卡片打开任务编辑器弹窗', opened, multi.t.title.slice(0, 24))
    if (!opened) throw new Error('编辑器弹窗没出来')

    await sleep(3500) // 等收敛期 + markdown 异步渲染落定
    const railOk = await waitFor(async () => (await readRail(page, MODAL_LIST)).rail === true, 8000, 250)
    const r = await readRail(page, MODAL_LIST)
    check('A1 ★ 对话流左边缘出现侧边条', railOk && r.rail, r.rail ? '' : '没找到 .acu-rail')
    check('A1b 条数 = 用户消息数（一轮一根）',
      r.rail && r.users >= 3 && r.bars === r.users,
      `bars=${r.bars} users=${r.users}（期望相等且 ≥3）`)
    check('A2 条宽落在 8..26px 区间',
      Array.isArray(r.widths) && r.widths.length > 0 && r.widths.every(w => w >= RAIL_MIN_W && w <= RAIL_MAX_W),
      `widths=${JSON.stringify(r.widths)}`)
    // ★ 不许压内容（用户 2026-10-08 截图指出的问题）：条右缘不得超过内容列左缘 +2
    // （+2 是「列左-40px」设计间距里自带的 2px 余量；第一版实测压进去 60px）
    check('A2c 侧边条不压内容列',
      r.rail && r.railRight <= r.innerLeft + 2,
      `rail.right=${r.railRight} vs 内容列.left=${r.innerLeft}（超出 ${(r.railRight - r.innerLeft).toFixed(0)}px）`)

    // 静止态半透明（0.3）、悬停整组显形 —— 这是"不打扰"这条设计的一部分
    const idleOpacity = Number(r.railOpacity)
    await page.locator('.wb-editor .acu-rail').first().hover()
    await sleep(400)
    const hovered = await readRail(page, MODAL_LIST)
    const hoverOpacity = Number(hovered.railOpacity)
    check('A2b 静止态半透明、悬停整组显形',
      Math.abs(idleOpacity - 0.3) < 0.03 && hoverOpacity > 0.95,
      `idle=${idleOpacity} hover=${hoverOpacity}`)

    // ── A3 悬停第 2 根条 → 浮层带的是**那一轮**的提问 ─────────────────────
    const bars = page.locator('.wb-editor .acu-rail-bar')
    await bars.nth(1).hover()
    await sleep(300)
    const tip = await page.evaluate(() => {
      const wrap = document.querySelector('.wb-editor .acu-message-list-wrap') || document
      const t = wrap.querySelector('.acu-rail-tip')
      if (!t) return null
      return {
        q: (t.querySelector('.acu-rail-tip-q')?.textContent || '').replace(/\s+/g, ' ').trim(),
        a: (t.querySelector('.acu-rail-tip-a')?.textContent || '').replace(/\s+/g, ' ').trim(),
      }
    })
    const secondUserText = await page.evaluate(() => {
      const list = document.querySelector('.wb-editor .acu-message-list')
      const users = [...list.querySelectorAll('.acu-bubble-row.is-user')]
      return users[1] ? (users[1].textContent || '') : ''
    })
    const clipQ = (tip?.q || '').replace(/…$/, '')
    check('A3 悬停浮层带着那一轮的提问与回答',
      !!tip && !!tip.q && !!tip.a && norm(secondUserText).includes(clipQ),
      tip ? `tip.q="${tip.q.slice(0, 24)}" 轮内提问含它=${norm(secondUserText).includes(clipQ)}` : '没有浮层')

    // ── A4 点第一根条 → 跳回该轮提问 ──────────────────────────────────────
    const beforeClick = await readRail(page, MODAL_LIST)
    const canScroll = beforeClick.scrollHeight > beforeClick.clientHeight + 80
    if (canScroll) {
      await bars.nth(0).click()
      const settled = await settleScroll(MODAL_LIST)
      const after = await readRail(page, MODAL_LIST)
      check('A4 点第一根条 → 对话流跳回该轮提问',
        settled < beforeClick.scrollTop - 100 && after.firstUserTop !== null && after.firstUserTop >= -8 && after.firstUserTop <= 120,
        `scrollTop ${beforeClick.scrollTop} → ${after.scrollTop}（停稳 ${settled}）；首轮 top=${after.firstUserTop}`)
    } else {
      skip('A4 点击跳转', `对话流不够高（${beforeClick.scrollHeight}/${beforeClick.clientHeight}），滚不动`)
    }

    await page.screenshot({ path: path.join(SHOT_DIR, 'rail-workbench.png') }).catch(() => {})

    // ── R1 单轮对话不画侧边条（反向护栏） ────────────────────────────────
    // 样本按「同项目优先、job 越新越优先」排：看板每列只渲染前若干张卡，
    // 太老的任务卡根本不在 DOM 里，点了也没反应（第一版就是这么 skip 掉的）
    const jobTimeOf = (taskId) => {
      const js = jobs.filter(j => j.subId === `${taskId}__simple` || String(j.subId || '').startsWith(`${taskId}__simple__r`))
      return js.map(j => j.endedAt || j.startedAt || '').sort().slice(-1)[0] || ''
    }
    const singleCandidates = tasks
      .map(t => ({ t, n: turnsOf(t.id).length, at: jobTimeOf(t.id) }))
      .filter(x => x.n === 1 && (x.t.title || '').trim().length >= 6)
      .sort((a, b) => {
        const sameA = a.t.projectPath === multi.t.projectPath ? 1 : 0
        const sameB = b.t.projectPath === multi.t.projectPath ? 1 : 0
        if (sameA !== sameB) return sameB - sameA
        return String(b.at).localeCompare(String(a.at))
      })
      .slice(0, 8)
    let r1done = false
    for (const cand of singleCandidates) {
      await closeEditor()
      if (!(await openFromBoard(cand.t))) continue
      await sleep(2500)
      const rs = await readRail(page, MODAL_LIST)
      // 弹窗里必须真的有对话列表，否则这条断言测的是"没打开"
      if (!rs.list) continue
      check('R1 只有一轮的对话不画侧边条（库的门槛，宿主不该绕过）',
        !rs.rail,
        `rail=${rs.rail} users=${rs.users}（样本：${cand.t.title.slice(0, 18)}）`)
      r1done = true
      break
    }
    if (!r1done) skip('R1 单轮反向护栏', `单轮样本（${singleCandidates.length} 条候选）都没能在看板上打开`)
    await closeEditor()

    // ── B1 主 Agent 控制台 ────────────────────────────────────────────────
    // 弹窗关干净（否则读到的还是它的对话流），再展开面板、切「对话」Tab
    await closeEditor()
    if (await page.locator('.oc__rail').count()) { await page.locator('.oc__rail').first().click(); await sleep(600) }
    const chatTab = page.locator('.oc__mode-btn', { hasText: '对话' }).first()
    if (await chatTab.count()) { await chatTab.click(); await sleep(600) }
    await page.locator('.acs__convs .acu-conv-item').first().waitFor({ timeout: 10000 }).catch(() => {})

    const CONSOLE_LIST = '.acs__chat .acu-message-list'
    const items = page.locator('.acs__convs .acu-conv-item')
    const n = await items.count()
    // 先把每条会话的"条数"读全（有的会话上千条，渲染慢 —— 挑**最短且 ≥4 条**的先试）
    const cands = []
    for (let i = 0; i < n; i += 1) {
      const meta = await items.nth(i).locator('.acu-conv-meta').first().textContent().catch(() => '')
      const count = Number((String(meta).match(/(\d+)\s*条/) || [])[1] || 0)
      if (count >= 4) cands.push({ i, count, title: norm(await items.nth(i).textContent()).slice(0, 18) })
    }
    cands.sort((a, b) => a.count - b.count)
    /** 窄面板里"列表"与"对话"是两页：选过一条之后列表被 v-show 藏了，
     *  不点回来下一条会等一个不可见的元素（第一版就卡在这 30s 超时上） */
    async function backToList() {
      const btn = page.locator('.acs__icon-btn[aria-label="会话列表"]')
      if ((await btn.count()) && await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {})
        await sleep(500)
      }
    }
    let b1done = false
    for (const cand of cands.slice(0, 3)) {
      await backToList()
      await items.nth(cand.i).click()
      // 大会话渲染要几秒：轮询等它出结果（≥2 轮），等不到就换下一条
      const ok = await waitFor(async () => {
        const rb = await readRail(page, CONSOLE_LIST)
        return rb.list && rb.users >= 2
      }, 20000, 500)
      if (!ok) continue
      const rb = await readRail(page, CONSOLE_LIST)
      check('B1 ★ 主 Agent 控制台：≥2 轮的会话也画出侧边条',
        rb.rail === true && rb.bars === rb.users,
        `bars=${rb.bars} users=${rb.users}（会话「${cand.title}」，${cand.count} 条）`)
      check('B1b 主 Agent 控制台：侧边条不压内容列',
        rb.railRight <= rb.innerLeft + 2,
        `rail.right=${rb.railRight} vs 内容列.left=${rb.innerLeft}（超出 ${(rb.railRight - rb.innerLeft).toFixed(0)}px）`)
      b1done = true
      break
    }
    if (!b1done) {
      // 没找到合适会话是夹具问题，不该算产品缺陷，但也不能当通过
      skip('B1 主 Agent 控制台', `会话列表里没有 ≥4 条、≥2 轮的样本（列表共 ${n} 条）`)
    }
    await page.screenshot({ path: path.join(SHOT_DIR, 'rail-console.png') }).catch(() => {})
  } catch (err) {
    check('脚本异常', false, String((err && err.message) || err))
  } finally {
    await browser.close().catch(() => {})
  }

  const failed = results.filter(r => !r.ok)
  console.log('\n[verify] 截图目录:', SHOT_DIR)
  console.log(`[verify] 结果: ${results.length - failed.length}/${results.length} 通过${skips.length ? `，跳过 ${skips.length} 项` : ''}`)
  failed.forEach(f => console.log(`  - ${f.name} ${f.extra}`))
  const noisy = consoleErrors.filter(e => !/favicon|ResizeObserver|DevTools|Failed to fetch/i.test(e))
  if (noisy.length) console.log('[verify] console errors:', noisy.slice(0, 5))
  if (pageErrors.length) console.log('[verify] page errors:', pageErrors.slice(0, 5))
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('[verify] 脚本异常:', e)
  process.exit(2)
})

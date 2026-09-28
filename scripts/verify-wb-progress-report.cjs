/**
 * 右栏「进度报告」面板的运行时验证（取代了原来的「活动日志」）。
 *
 * 验收契约（对应 OrchestratorConsole.vue 的 .oc__report / useOrchestrator.ts /
 * routes/workbench/progressReport.js）：
 *   P1 指令模式下右栏出现进度报告面板，活动日志那套行（.oc__row）已经不在了
 *   P2 间隔下拉的档位与服务端白名单一致，且当前值 = 服务端下发的值
 *   P3 改间隔真的落盘：POST /report-interval 带上的值 = 选中的值，
 *      刷新后仍是它（不是只改了本地 ref）—— 跑完恢复原值，别改用户的设置
 *   P4 点「立即报告」→ 真打接口 → 面板上出现一张**手动**的报告卡片；
 *      没有任务在跑时那句话必须说实话（不能装作有进度）
 *   P5 这一份真的进了服务端历史：GET /orchestrator/reports 里能看到它
 *   P6 两份以上时出现历史区，点其中一条能把上面那张换掉（选中态跟着走）
 *   P7 无 JS 运行时异常 / 无控制台错误
 *   P8 截图存证
 *
 * 前置：dev server 已启动（npm run dev，后端 5545 / 前端 5544）。
 * 用法：node scripts/verify-wb-progress-report.cjs
 * 退出码：0 全通过，1 有失败项，2 环境没起。
 */
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544'
const results = []
const consoleErrors = []
const pageErrors = []
/** 连不上的请求带上 URL —— 只报 "ERR_CONNECTION_REFUSED" 的话，根本看不出是谁在连谁 */
const failedRequests = []
/** 5xx 响应也带上 URL：本仓库常年有多个 session 同时改同一份代码，
 *  控制台里的 "Failed to load resource: 500" 得能一眼看出是本面板的接口还是隔壁的 */
const badResponses = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const getJson = (url) => fetch(`${BASE}${url}`, { cache: 'no-store' }).then(r => r.json()).catch(() => null)

/** 一次读全面板状态，避免多次 evaluate 之间被 5s 轮询刷掉中间态 */
async function readPanel(page) {
  return page.evaluate(() => {
    const sel = document.querySelector('.oc__interval')
    const card = document.querySelector('.rp')
    return {
      hasPanel: !!document.querySelector('.oc__report'),
      legacyRows: document.querySelectorAll('.oc-row').length,
      options: sel ? Array.from(sel.options).map(o => ({ value: o.value, text: o.textContent.trim() })) : [],
      interval: sel ? sel.value : null,
      hasRunBtn: !!document.querySelector('.oc__report-run'),
      runLabel: (document.querySelector('.oc__report-run span')?.textContent || '').trim(),
      trigger: (card?.querySelector('.rp__trigger')?.textContent || '').trim(),
      count: (card?.querySelector('.rp__count')?.textContent || '').trim(),
      text: (document.querySelector('.rp__text')?.textContent || '').trim(),
      notice: (document.querySelector('.rp__notice')?.textContent || '').trim(),
      factTitles: Array.from(document.querySelectorAll('.rpt__title')).map(e => e.textContent.trim()),
      historyCount: document.querySelectorAll('.oc__history-item').length,
      /** 选中项的下标。别拿文字比：多份报告的摘要可能一模一样（都是"当时没有任务在执行"），
       *  文字相同 ≠ 选中没变 */
      historyActiveIndex: Array.from(document.querySelectorAll('.oc__history-item'))
        .findIndex(e => e.classList.contains('is-active')),
      historyActive: (document.querySelector('.oc__history-item.is-active .oc__history-sum')?.textContent || '').trim(),
      empty: (document.querySelector('.oc-empty')?.textContent || '').trim(),
    }
  })
}

/** 切到工作台 -> 「指令」模式 */
async function openCommandMode(page) {
  await page.waitForSelector('.activity-bar', { timeout: 30000 })
  await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
  await page.waitForSelector('.oc', { timeout: 30000 })
  const cmdTab = page.locator('.oc__mode-btn').filter({ hasText: '指令' }).first()
  await cmdTab.click()
  await sleep(400)
}

async function main() {
  const boot = await getJson('/api/workbench/orchestrator')
  if (!boot?.success) { console.error('读不到编排状态，dev server 起了吗？', boot); process.exit(2) }
  const originalInterval = boot.reportIntervalMs
  log('服务端当前间隔:', originalInterval, '| 在跑的任务:', (boot.running || []).length)
  if (!Number.isFinite(originalInterval)) {
    console.error('服务端没下发 reportIntervalMs —— 跑的是旧后端？确认 vite 代理指向含本功能的那个进程');
    process.exit(2)
  }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('requestfailed', (r) => {
    failedRequests.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText || ''}`)
  })
  page.on('response', (r) => {
    if (r.status() >= 500) badResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`)
  })

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await openCommandMode(page)

    /* ══ P1 面板在，活动日志不在 ══ */
    let m = await readPanel(page)
    check('P1a 指令模式下出现进度报告面板', m.hasPanel === true)
    check('P1b 活动日志那套行已经不在了', m.legacyRows === 0, `oc-row=${m.legacyRows}`)
    check('P1c 「立即报告」按钮在', m.hasRunBtn === true, `label="${m.runLabel}"`)

    /* ══ P2 间隔档位 ══ */
    const OPTIONS = [0, 5 * 60 * 1000, 10 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000]
    check('P2a 间隔下拉有 6 档且与服务端白名单一致',
      JSON.stringify(m.options.map(o => Number(o.value))) === JSON.stringify(OPTIONS),
      JSON.stringify(m.options.map(o => o.value)))
    check('P2b 当前值 = 服务端下发的值',
      Number(m.interval) === originalInterval, `select=${m.interval} server=${originalInterval}`)
    check('P2c 首个档位是「关闭自动报告」（关得掉，不是只能调频率）',
      m.options[0]?.value === '0' && m.options[0]?.text.length > 0, `text="${m.options[0]?.text}"`)

    /* ══ P3 改间隔真的落盘 ══ */
    const target = 30 * 60 * 1000
    await page.selectOption('.oc__interval', String(target))
    await sleep(800)
    const afterSet = await getJson('/api/workbench/orchestrator')
    check('P3a 选新档位后服务端跟着变（不是只改了本地 ref）',
      afterSet?.reportIntervalMs === target, `server=${afterSet?.reportIntervalMs}`)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openCommandMode(page)
    m = await readPanel(page)
    check('P3b 刷新后仍显示该档位（记住了，不是每次回默认）',
      Number(m.interval) === target, `select=${m.interval}`)

    /* ══ P4 立即报告 ══ */
    // ⚠️ 这里刻意**不**用「点完等 .rp 出现」判定：上一轮的报告卡片本来就还在 DOM 里，
    // 那个 waitForSelector 会立刻返回旧卡片（2026-09-28 实测踩过：断言读到的是
    // 几分钟前那份自动报告）。判据必须是「服务端多了一份 manual」。因此先数一遍再点。
    const before = await getJson('/api/workbench/orchestrator/reports')
    const beforeManual = (before?.reports || []).filter(r => r.trigger === 'manual').length

    await page.click('.oc__report-run')
    let mine = null
    for (let i = 0; i < 45; i++) {
      const now = await getJson('/api/workbench/orchestrator/reports')
      const manual = (now?.reports || []).filter(r => r.trigger === 'manual')
      if (manual.length > beforeManual) { mine = manual[0]; break }
      await sleep(2000)
    }
    check('P4a 点「立即报告」真的生成了一份并落盘',
      !!mine, `manual: ${beforeManual} -> ${(await getJson('/api/workbench/orchestrator/reports'))?.reports?.filter(r => r.trigger === 'manual').length}`)
    if (!mine) throw new Error('没生成出报告，后面的断言没有意义')

    // 面板自己把这份换上来（本地插入，不必等 30s 的报告轮询）
    let shown = { trigger: '' }
    for (let i = 0; i < 15; i++) {
      shown = await readPanel(page)
      if (shown.trigger === '手动') break
      await sleep(1000)
    }
    check('P4b 面板上换成了刚点出来的那一份（标「手动」）', shown.trigger === '手动', `trigger="${shown.trigger}"`)
    check('P4c 卡片头上的任务数 = 生成时那批（不是拿现在的时钟另算）',
      shown.count.includes(String(mine.tasks.length)), `count="${shown.count}" tasks=${mine.tasks.length}`)

    if (mine.tasks.length === 0) {
      check('P4d 没有任务在跑时那句话说实话（不编进度）',
        shown.notice.includes('没有任务在执行') && !shown.text, `notice="${shown.notice}" text="${shown.text.slice(0, 40)}"`)
    } else {
      // 有任务在跑：要么有正文，要么明说为什么没有（没配模型 / 生成失败）
      check('P4d 有任务在跑时给正文，或说清为什么没有',
        mine.text.length > 0 || mine.errorCode !== '',
        `text=${mine.text.length}字 errorCode="${mine.errorCode}"`)
      check('P4e 事实快照里带着当时的项目与任务标题',
        mine.tasks.every(t => typeof t.taskTitle === 'string' && typeof t.elapsedMs === 'number'),
        JSON.stringify(mine.tasks[0] || {}).slice(0, 160))
    }

    /* ══ P5 落盘的那份长什么样 ══ */
    check('P5a 记录字段齐全（trigger / at / tasks / errorCode）',
      mine.trigger === 'manual' && typeof mine.at === 'string' && Array.isArray(mine.tasks)
        && ['', 'NO_MODEL', 'LLM_TIMEOUT', 'LLM_FAILED'].includes(mine.errorCode || ''),
      `trigger=${mine.trigger} at=${mine.at} errorCode="${mine.errorCode}"`)
    check('P5b 事实快照存的是**时长**（elapsedMs），不是一对会随历史一起变大的起止时间',
      mine.tasks.every(t => Number.isFinite(t.elapsedMs) && t.elapsedMs >= 0
        // 有 startedAt 的必须算出正数时长 —— 全是 0 说明这个字段根本没被算过
        && (!t.startedAt || t.elapsedMs > 0)),
      JSON.stringify(mine.tasks.map(t => ({ startedAt: t.startedAt, elapsedMs: t.elapsedMs }))))

    /* ══ P6 历史区 + 选中态 ══ */
    // 再造一份，凑到两份以上
    await page.click('.oc__report-run')
    let historyCount = 0
    for (let i = 0; i < 45; i++) {
      historyCount = (await readPanel(page)).historyCount
      if (historyCount >= 2) break
      await sleep(2000)
    }
    check('P6a 两份以上时出现历史区', historyCount >= 2, `items=${historyCount}`)
    m = await readPanel(page)
    const beforeIndex = m.historyActiveIndex
    await page.locator('.oc__history-item').last().click()
    await sleep(400)
    m = await readPanel(page)
    check('P6b 点历史里的一条能把上面那张换掉（选中态跟着走）',
      m.historyActiveIndex === m.historyCount - 1 && m.historyActiveIndex !== beforeIndex,
      `activeIndex ${beforeIndex} -> ${m.historyActiveIndex} / items=${m.historyCount}`)

    /* ══ P7 无异常 ══ */
    check('P7a 无 JS 运行时异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300))
    const bad = consoleErrors.filter(t => !/favicon|ResizeObserver/i.test(t))
    // 连接被拒时把 URL 一起报出来：只看到 "ERR_CONNECTION_REFUSED" 是没法判断
    // 「我这个面板的接口挂了」还是「旁边某个后台服务没起」的
    const refused = failedRequests.filter(t => /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET/.test(t))
    check('P7b 无控制台错误', bad.length === 0,
      bad.length
        ? `${bad.slice(0, 3).join(' | ').slice(0, 160)} || 5xx: ${badResponses.slice(0, 5).join(' , ')} || refused: ${refused.slice(0, 5).join(' , ')}`
        : '')

    /* ══ P8 截图存证 ══ */
    const shot = path.resolve(__dirname, '../.tmp/verify-wb-progress-report.png')
    await page.locator('.oc').screenshot({ path: shot }).catch(() => {})
    log('截图:', shot)
  } finally {
    await browser.close()
    // 间隔改回原值：这是用户自己的配置，验证脚本不该留下痕迹
    await fetch(`${BASE}/api/workbench/orchestrator/report-interval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intervalMs: originalInterval }),
    }).catch(() => {})
    const restored = await getJson('/api/workbench/orchestrator')
    log('间隔已恢复:', restored?.reportIntervalMs)
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n[verify] ${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) {
    console.log('[verify] 失败项:')
    for (const f of failed) console.log(`   - ${f.name}${f.extra ? '  :: ' + f.extra : ''}`)
  }
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })

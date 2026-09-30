/**
 * 右栏「进度报告」面板的运行时验证（取代了原来的「活动日志」）。
 *
 * 验收契约（对应 OrchestratorConsole.vue 的 .oc__report / useOrchestrator.ts /
 * routes/workbench/progressReport.js）：
 *   P1 指令模式下右栏出现进度报告面板，活动日志那套行（.oc__row）已经不在了
 *   P2 间隔下拉的档位与服务端白名单一致，且当前值 = 服务端下发的值
 *   P3 改间隔真的落盘：POST /report-interval 带上的值 = 选中的值，
 *      刷新后仍是它（不是只改了本地 ref）—— 跑完恢复原值，别改用户的设置
 *   P4 点「立即报告」→ 真打接口 → 面板上出现一张**手动**的报告卡片。
 *      有任务在跑：生成并落盘；**没有任务在跑：不生成、不落盘**，只给一句明确回应（toast）。
 *      空报告不进历史是 2026-09-29 用户反馈的结果 —— 那种记录零信息量，还占历史格子
 *   P5 落盘的那份字段齐全；接口与面板的历史里**都没有空报告**（本次反馈的直接目的）；
 *      另外把「服务端不给报告」那一条桩出来，单独验前端的回应（真实环境里
 *      "恰好没有任务在跑"不可控，见 P5e/P5f）
 *   P6 两份以上时出现历史区，点其中一条能把上面那张换掉（选中态跟着走）
 *   P7 进度条：主 Agent 给的百分比被画成条（宽度 = 那个数），带「AI 估计」字样与
 *      role=progressbar；每个任务各自的百分比只在模型给了时才画一条；历史列表那一列
 *      **没有进度时留空但占位**；**没给百分比就一条都不画**（反证：桩一份 percent=null 的报告）
 *   P10 空正文的原因码：LLM_EMPTY（模型答了但没写正文）与通用失败说两句不同的话，
 *     悬停带服务端写的 errorDetail；认不出来的码仍然退回通用文案（反证）
 *   P8 无 JS 运行时异常 / 无控制台错误
 *   P9 截图存证
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
      /** 没有正文时那句说明的悬停提示 = 服务端写的 errorDetail（失败原因的细节） */
      noticeTitle: document.querySelector('.rp__notice')?.getAttribute('title') || '',
      factTitles: Array.from(document.querySelectorAll('.rpt__title')).map(e => e.textContent.trim()),
      historyCount: document.querySelectorAll('.oc__history-item').length,
      /** 选中项的下标。别拿文字比：多份报告的摘要可能一模一样（都是"当时没有任务在执行"），
       *  文字相同 ≠ 选中没变 */
      historyActiveIndex: Array.from(document.querySelectorAll('.oc__history-item'))
        .findIndex(e => e.classList.contains('is-active')),
      historyActive: (document.querySelector('.oc__history-item.is-active .oc__history-sum')?.textContent || '').trim(),
      empty: (document.querySelector('.oc-empty')?.textContent || '').trim(),
      /** 进度条：卡片整体那条（`.rpt__bar` 是每个任务各自的那条，别混） */
      hasBar: !!card?.querySelector('.rp__bar'),
      barRole: card?.querySelector('.rp__bar')?.getAttribute('role') || '',
      barAriaNow: card?.querySelector('.rp__bar')?.getAttribute('aria-valuenow') || '',
      barInlineWidth: card?.querySelector('.rp__bar-fill')?.style.width || '',
      /** 实测像素：光看内联 style 分不出"CSS 把宽度吃掉了"这种情况 */
      barTrackPx: card?.querySelector('.rp__bar')?.getBoundingClientRect().width ?? 0,
      barFillPx: card?.querySelector('.rp__bar-fill')?.getBoundingClientRect().width ?? 0,
      percentText: (card?.querySelector('.rp__percent')?.textContent || '').trim(),
      barTitle: card?.querySelector('.rp__progress')?.getAttribute('title') || '',
      /** 每个任务各自那条进度条的百分比文案（没有的不渲染，所以数量 ≤ 任务数） */
      factPercents: Array.from(document.querySelectorAll('.rpt__percent')).map(e => e.textContent.trim()),
      factTitlesWithPct: Array.from(document.querySelectorAll('.rpt'))
        .filter(li => li.querySelector('.rpt__percent'))
        .map(li => (li.querySelector('.rpt__title')?.textContent || '').trim()),
      historyPercents: Array.from(document.querySelectorAll('.oc__history-pct')).map(e => e.textContent.trim()),
    }
  })
}

/**
 * 读当前挂着的 ElMessage 提示文案（多条拼一起，调用方用正则判）。
 * 没有提示是正常情况 —— 等不到就返回空串，不抛。
 */
async function readToast(page, timeout = 4000) {
  try {
    await page.waitForSelector('.el-message', { state: 'visible', timeout })
  } catch {
    return ''
  }
  return page.evaluate(() => Array.from(document.querySelectorAll('.el-message'))
    .map(el => (el.querySelector('.el-message__content')?.textContent || el.textContent || '').trim())
    .join(' | '))
}

/**
 * 清掉当前挂着的提示。读 toast 之前先清一次，免得读到上一步残留的那条
 * （ElMessage 默认活 3 秒，交叉的两步之间会撞上）。
 */
async function clearToasts(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.el-message').forEach(el => el.remove())
  })
}

/** 切到工作台 -> 「指令」模式 */async function openCommandMode(page) {
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
    const runningNow = ((await getJson('/api/workbench/orchestrator'))?.running || []).length
    log('点之前：在跑的任务', runningNow, '个 | 历史里的手动报告', beforeManual, '份')

    await clearToasts(page)
    await page.click('.oc__report-run')
    // toast 只活三秒上下，必须在轮询之前读 —— 没有任务在跑时，服务端立刻返回，
    // 这一句就是"点这一下"的全部回应
    const toast = await readToast(page)

    let mine = null
    if (runningNow > 0) {
      // ⚠️ 窗口必须**大于服务端自己那条 90 秒的超时**（progressReport 的 REPORT_TIMEOUT_MS），
      // 否则等不到的那一下不是"没生成"，而是"还没生成" —— 2026-09-30 实测踩过：
      // 三个任务同时跑、同一个网关在给它们供货时，这一份报告用了 95 秒才落盘，
      // 而这里的 45×2s≈88s 刚好在它写完之前放弃，报了个假 FAIL。
      // 刷新拿到的那一份是按 `manual.length` 变的，所以窗口放大只是失败时多等一会儿。
      for (let i = 0; i < 100; i++) {
        const now = await getJson('/api/workbench/orchestrator/reports')
        const manual = (now?.reports || []).filter(r => r.trigger === 'manual')
        if (manual.length > beforeManual) { mine = manual[0]; break }
        await sleep(2000)
      }
      check('P4a 有任务在跑时，点「立即报告」生成了一份并落盘',
        !!mine, `manual: ${beforeManual} -> ${(await getJson('/api/workbench/orchestrator/reports'))?.reports?.filter(r => r.trigger === 'manual').length}`)
      if (!mine) throw new Error('没生成出报告，后面的断言没有意义')
    } else {
      // 没有任务在跑：**不生成、不落盘** —— 往历史里记一条"当时没有任务在执行"，
      // 用户回头翻的时候零信息量（2026-09-29 反馈：这种空报告两两重复还占着历史）
      await sleep(3000)
      const afterManual = ((await getJson('/api/workbench/orchestrator/reports'))?.reports || [])
        .filter(r => r.trigger === 'manual').length
      check('P4a 没有任务在跑时不落盘空报告（历史份数不变）',
        afterManual === beforeManual, `manual: ${beforeManual} -> ${afterManual}`)
      check('P4b 点完给了一句明确回应（不是静默无反应）',
        /没有正在执行的任务/.test(toast), `toast="${toast}"`)
    }

    if (mine) {
      // 面板自己把这份换上来（本地插入，不必等 30s 的报告轮询）
      let shown = { trigger: '' }
      for (let i = 0; i < 15; i++) {
        shown = await readPanel(page)
        if (shown.trigger === '手动') break
        await sleep(1000)
      }
      check('P4c 面板上换成了刚点出来的那一份（标「手动」）', shown.trigger === '手动', `trigger="${shown.trigger}"`)
      check('P4d 卡片头上的任务数 = 生成时那批（不是拿现在的时钟另算）',
        shown.count.includes(String(mine.tasks.length)), `count="${shown.count}" tasks=${mine.tasks.length}`)
      // 有任务在跑：要么有正文，要么明说为什么没有（没配模型 / 生成失败）
      check('P4e 有任务在跑时给正文，或说清为什么没有',
        mine.text.length > 0 || mine.errorCode !== '',
        `text=${mine.text.length}字 errorCode="${mine.errorCode}"`)
      check('P4f 事实快照里带着当时的任务标题与项目',
        mine.tasks.every(t => typeof t.taskTitle === 'string' && typeof t.elapsedMs === 'number'),
        JSON.stringify(mine.tasks[0] || {}).slice(0, 160))
    }

    /* ══ P5 历史里不该再有"当时没有任务在执行"的空报告 ══ */
    // 本次修改的直接目的：空报告既不落盘，也不在面板上露脸
    const hist = await getJson('/api/workbench/orchestrator/reports')
    const empties = (hist?.reports || []).filter(r => !r.tasks.length)
    check('P5a 接口返回的历史里没有空报告', empties.length === 0,
      `空报告 ${empties.length} 条 / 共 ${(hist?.reports || []).length} 条`)
    const sums = await page.$$eval('.oc__history-item .oc__history-sum',
      els => els.map(e => (e.textContent || '').trim()))
    check('P5b 面板的历史列表里也没有这种行', !sums.some(t => t.includes('当时没有任务在执行')),
      sums.join(' / ').slice(0, 240))

    if (mine) {
      /* ══ P5c 落盘的那份长什么样 ══ */
      check('P5c 记录字段齐全（trigger / at / tasks / errorCode）',
        mine.trigger === 'manual' && typeof mine.at === 'string' && Array.isArray(mine.tasks)
          && ['', 'NO_MODEL', 'LLM_TIMEOUT', 'LLM_EMPTY', 'LLM_FAILED'].includes(mine.errorCode || ''),
        `trigger=${mine.trigger} at=${mine.at} errorCode="${mine.errorCode}"`)
      check('P5d 事实快照存的是**时长**（elapsedMs），不是一对会随历史一起变大的起止时间',
        mine.tasks.every(t => Number.isFinite(t.elapsedMs) && t.elapsedMs >= 0
          // 有 startedAt 的必须算出正数时长 —— 全是 0 说明这个字段根本没被算过
          && (!t.startedAt || t.elapsedMs > 0)),
        JSON.stringify(mine.tasks.map(t => ({ startedAt: t.startedAt, elapsedMs: t.elapsedMs }))))
    }

    /* ══ P5e 服务端说"没有任务在跑"（report: null）时，面板必须给一句回应 ══ */
    // 真实环境里"没有任务在跑"的时刻不可控，所以这一条把 POST 桩掉，单独验前端那半条链路：
    // report 为 null 时必须弹一句实话。静默无反应正是用户"再点一下"、
    // 于是历史里出现重复记录的起点
    const apiCountBeforeStub = ((await getJson('/api/workbench/orchestrator/reports'))?.reports || []).length
    await page.route('**/api/workbench/orchestrator/report', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, report: null }),
    }))
    await clearToasts(page)
    await page.click('.oc__report-run')
    const stubToast = await readToast(page)
    check('P5e 没有任务在跑（服务端不给报告）时弹一句实话',
      /没有正在执行的任务/.test(stubToast), `toast="${stubToast}"`)
    const apiCountAfterStub = ((await getJson('/api/workbench/orchestrator/reports'))?.reports || []).length
    check('P5f 桩掉的那一下没有在服务端留下任何记录',
      apiCountAfterStub === apiCountBeforeStub, `${apiCountBeforeStub} -> ${apiCountAfterStub}`)
    await page.unroute('**/api/workbench/orchestrator/report')

    /* ══ P6 历史区 + 选中态 ══ */
    let historyCount = (await readPanel(page)).historyCount
    // 只有一份时再造一份凑出历史区。⚠️ 先等过服务端的去重窗口（10s）：窗口里内容一样的
    // 第二份会被合并掉（连点两下只留一份，见 orchestratorStore.appendReport），
    // 那不是这里要测的东西 —— 等过窗口再点才是新的一份
    if (runningNow > 0 && historyCount < 2) {
      await sleep(11000)
      await page.click('.oc__report-run')
      // 窗口与 P4a 同一个理由（服务端超时 90 秒，这一份还得排在前面那批之后）
      for (let i = 0; i < 100; i++) {
        historyCount = (await readPanel(page)).historyCount
        if (historyCount >= 2) break
        await sleep(2000)
      }
    }
    const apiCount = ((await getJson('/api/workbench/orchestrator/reports'))?.reports || []).length
    check('P6a 历史区的出现与接口返回的份数对齐（>1 份才出现）',
      (historyCount > 0) === (apiCount > 1), `dom=${historyCount} api=${apiCount}`)
    if (historyCount >= 2) {
      m = await readPanel(page)
      const beforeIndex = m.historyActiveIndex
      await page.locator('.oc__history-item').last().click()
      await sleep(400)
      m = await readPanel(page)
      check('P6b 点历史里的一条能把上面那张换掉（选中态跟着走）',
        m.historyActiveIndex === m.historyCount - 1 && m.historyActiveIndex !== beforeIndex,
        `activeIndex ${beforeIndex} -> ${m.historyActiveIndex} / items=${m.historyCount}`)
    } else {
      // 没有任务在跑时本脚本不再造空报告，历史可能本来就凑不出两份 —— 明说是环境问题，
      // 不装作通过
      check('P6b 点历史里的一条能把上面那张换掉（选中态跟着走）', false,
        `历史只有 ${historyCount} 份（没任务在跑时不会再多造），先手动攒够两份再跑本脚本`)
    }

    /* ══ P7 进度条（主 Agent 给的百分比）══ */
    // 真模型给不给百分比不可控（它会照 62 写、也可能整行不写），所以这一组把 POST 的
    // 响应**桩掉**：面板读的就是响应里那份记录（useOrchestrator.generateReport 直接
    // 插到列表最前），桩住才能验到确定的数字。
    // 先 reload 一次：P6b 点过历史里的一条，选中态还停在那份老报告上，
    // 不重置的话新插进来的这份根本不会显示在卡片里（选中态优先于"跟随最新"）。
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openCommandMode(page)

    /** 桩一份报告：percent 给不给、每个任务给不给都由参数说了算 */
    const stubReport = (percent, taskPercents, textStub) => ({
      id: 'probe-percent-' + Math.random().toString(36).slice(2, 8),
      at: new Date().toISOString(),
      trigger: 'manual',
      text: textStub,
      percent,
      errorCode: '',
      errorDetail: '',
      tasks: taskPercents.map((p, i) => ({
        taskId: `probe-${i}`,
        taskTitle: `桩任务 ${i + 1}`,
        projectName: 'zen-gitsync',
        startedAt: null,
        elapsedMs: 60000 - i * 1000,
        agent: 'claude',
        toolCallCount: 3,
        lastTool: '',
        lastLine: '',
        percent: p,
      })),
    })

    const STUB_PERCENT = 62
    /** 把 POST /report 换成"直接返回这一份"。三处都用它 —— 各写一遍很容易漏掉 unroute，
     *  上一处的桩会一直挂到脚本结束，后面所有断言读到的都是同一份假报告 */
    const stubPost = async (report) => {
      await page.unroute('**/api/workbench/orchestrator/report')
      await page.route('**/api/workbench/orchestrator/report', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, report }),
      }))
    }
    /** 点一次「立即报告」，把桩那份插到面板最前 */
    const stubOnce = async (report) => {
      await stubPost(report)
      await clearToasts(page)
      await page.click('.oc__report-run')
      await sleep(800)
    }

    await stubOnce(stubReport(STUB_PERCENT, [70, null], '桩：正在改登录模块。'))
    let pm = await readPanel(page)

    check('P7a 卡片上画出进度条，宽度 = 主 Agent 给的那个数',
      pm.hasBar && pm.barInlineWidth === `${STUB_PERCENT}%`
        && pm.barTrackPx > 0
        && Math.abs(pm.barFillPx / pm.barTrackPx - STUB_PERCENT / 100) < 0.02,
      `inline=${pm.barInlineWidth} px=${pm.barFillPx.toFixed(1)}/${pm.barTrackPx.toFixed(1)}`)
    check('P7b 百分比带「AI 估计」字样（不能光甩一个数字让人当成实测值）',
      /AI/.test(pm.percentText) && pm.percentText.includes(`${STUB_PERCENT}%`),
      `text="${pm.percentText}"`)
    check('P7c 进度条有 progressbar 语义（aria 值 = 那个数）',
      pm.barRole === 'progressbar' && pm.barAriaNow === String(STUB_PERCENT),
      `role=${pm.barRole} now=${pm.barAriaNow}`)
    check('P7d 悬停能说明这个数字的来路（"不是精确进度"那句）',
      pm.barTitle.length > 0, `title="${pm.barTitle.slice(0, 60)}"`)
    // 桩里的两个任务一个给了 70、一个没给 —— 只有给了的那条该画出来
    check('P7e 每个任务的百分比只在模型给了时才画（null 那条不画）',
      pm.factPercents.length === 1 && pm.factPercents[0] === '70%', pm.factPercents.join(','))
    check('P7f 有进度的那条挂在**给了数字的那个任务**下面，没给的那条没有',
      pm.factTitlesWithPct.length === 1 && pm.factTitlesWithPct[0] === '桩任务 1',
      pm.factTitlesWithPct.join(' / '))
    // 历史区要在两份以上才出现；出现时第一条就是刚插进来的这份
    check('P7g 历史列表里也带百分比',
      pm.historyCount <= 1 || pm.historyPercents[0] === `${STUB_PERCENT}%`,
      `items=${pm.historyCount} percents=${pm.historyPercents.join(',')}`)

    /* ══ P7 反证：模型没给百分比 → 一条进度条都不许有 ══ */
    // 少了这一条，上面那组"画出来了"完全可能是"条一直在那儿"（假绿）——
    // 本仓库踩过探针只验正向的坑
    await stubOnce(stubReport(null, [null, null], '桩：这次模型没给百分比。'))
    pm = await readPanel(page)
    check('P7h 模型没给百分比时：卡片上一条进度条都没有（不画 0% 糊弄人）',
      pm.hasBar === false && pm.percentText === '' && pm.factPercents.length === 0,
      `bar=${pm.hasBar} percent="${pm.percentText}" facts=${pm.factPercents.join(',')}`)
    check('P7i 历史里那一列空着但占位（没有进度的那几条摘要不会整体左移）',
      pm.historyCount <= 1
        || (pm.historyPercents.length === pm.historyCount && pm.historyPercents[0] === ''),
      `items=${pm.historyCount} percents=${JSON.stringify(pm.historyPercents.slice(0, 4))}`)
    check('P7j 这一份的正文照常显示（少一条进度条不该影响报告本身）',
      pm.text.includes('这次模型没给百分比'), `text="${pm.text.slice(0, 40)}"`)
    await page.unroute('**/api/workbench/orchestrator/report')

    /* ══ P10 空正文为什么空，面板上要分得清（LLM_EMPTY，2026-09-30 新增）══ */
    // 用户报的"进度有时候会生成失败"：推理模型的 max_tokens 是**思考 + 正文共用**的，
    // 思考写满预算时正文一个字都没有，HTTP 还是 200。服务端现在把它记成 LLM_EMPTY 而不是
    // 通用的 LLM_FAILED —— 两种失败的处理办法不同（这个要调生成预算，不是查网络），
    // 面板上也就得说两句不同的话。同样把响应桩掉：真模型给不给正文不可控。
    await stubOnce({
      ...stubReport(null, [null], ''),
      errorCode: 'LLM_EMPTY',
      errorDetail: 'max_tokens=8000 finish_reason=length reasoning_tokens=7980',
    })
    let em = await readPanel(page)
    check('P10a LLM_EMPTY 说的是自己那句话（不是通用的"生成失败"）',
      em.notice.includes('没有返回正文'), `notice="${em.notice}"`)
    check('P10b 悬停能看到服务端写的 errorDetail（finish_reason / 思考用量）',
      em.noticeTitle.includes('finish_reason=length') && em.noticeTitle.includes('reasoning_tokens'),
      `title="${em.noticeTitle}"`)
    // 反证：认不出来的码仍然退回通用文案 —— 少了这条，上面 P10a 完全可能是
    // "所有码都在说同一句话"（假绿）
    await stubOnce({ ...stubReport(null, [null], ''), errorCode: 'SOMETHING_NEW' })
    em = await readPanel(page)
    check('P10c 没见过的码仍然退回通用的「生成失败」',
      /生成失败/.test(em.notice) && !em.notice.includes('没有返回正文'),
      `notice="${em.notice}"`)
    await page.unroute('**/api/workbench/orchestrator/report')

    /* ══ P8 无异常 ══ */
    check('P8a 无 JS 运行时异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300))
    const bad = consoleErrors.filter(t => !/favicon|ResizeObserver/i.test(t))
    // 连接被拒时把 URL 一起报出来：只看到 "ERR_CONNECTION_REFUSED" 是没法判断
    // 「我这个面板的接口挂了」还是「旁边某个后台服务没起」的
    const refused = failedRequests.filter(t => /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET/.test(t))
    check('P8b 无控制台错误', bad.length === 0,
      bad.length
        ? `${bad.slice(0, 3).join(' | ').slice(0, 160)} || 5xx: ${badResponses.slice(0, 5).join(' , ')} || refused: ${refused.slice(0, 5).join(' , ')}`
        : '')

    /* ══ P9 截图存证 ══ */
    // 截图前把带百分比的那份换回来：上面那组反证最后留在面板上的是"没有进度条"的一份，
    // 直接截的话存证图上根本看不到这个功能
    await stubOnce(stubReport(STUB_PERCENT, [70, 30], '桩：正在改登录模块，两处改动都还没验证。'))
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

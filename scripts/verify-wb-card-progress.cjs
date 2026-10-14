/**
 * 看板「进行中」卡片上那条**进度条**的验证（2026-10-14）。
 *
 * 背景：每个任务自己的百分比原来画在右栏「任务事实」那一区（OrchestratorConsole 的
 * .rpt__*）。那一区与看板卡片是同一批字段（服务端同一份 jobActivity 实现），两处并排
 * 就是同一件事说两遍（用户截图反馈："左右都有，有点重叠"），于是整块下掉、进度条搬到卡片上。
 * 这个脚本守的就是搬过来之后的三件事：**画在哪、什么时候画、什么时候不画**。
 *
 * 验收契约：
 *   A 有数字就画：轨道 + 填充（宽度 = 那个数，量像素不信内联 style）、「AI 估计 62%」、
 *     role=progressbar + aria、悬停说明；位置在活动行**上面**、元信息行下面（先总述后证据）
 *   B **不该画的一条都不画**（这一组才是重点，五条各有各的成因）：
 *     B1 模型没给（percent: null）    B2 只认当前这一轮：报告里只有**上一轮**的 jobId
 *     B3 越界的脏值（130）           B4 报告还没覆盖到这条新任务
 *     B5 没在跑的任务（进度只属于正在跑的那一轮）
 *   C 反向对照（**恒绿检查**）：把 B2 那张卡的 jobId 改成报告里那个 → 条必须**出现**。
 *     少了这条，B2 完全可能是"这张卡永远不画条"（比如 live 根本没渲染）
 *   D 老记录（报告里没有 jobId 字段，2026-10 之前落的）退回按 taskId 认 → 照画
 *   E 列表视图里同一份数字以文字出现（两种画法一边有一边没有会让人以为是两份数据）
 *   F 右栏「任务事实」那一区已经不在了，且**面板本身渲染着**（正向对照，否则 F1 是空断言）
 *   G 无 JS 运行时异常 / 无控制台错误
 *   H 截图存证
 *
 * --reverse：把旧的那一区（.rp__facts / .rpt）注回右栏 DOM —— F1 必须变红，
 *   证明它守的是"这一区真的没了"，而不是"选择器写错了所以永远数到 0"。
 *   A–E 那几组在反证下照旧全绿：卡片这边不受右栏影响，搬迁是单向的。
 *
 * 前置：dev server 已启动（vite 5544；`npm run dev:ping`）。接口全被 route 拦掉，
 *   不碰真实任务、不依赖"此刻有任务在跑"。
 * 用法：node scripts/verify-wb-card-progress.cjs [--reverse]
 * 退出码：0 全通过，1 有失败项。
 */
const fs = require('node:fs')
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const CHROME = process.env.ZEN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
/** 反证：见文件头 */
const REVERSE = process.argv.includes('--reverse')

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const PROJECT_PATH = 'D:\\ws\\zen-gitsync'

/**
 * 七张卡，把"画 / 不画"的每条成因都摆齐（标题就是它的身份，断言按标题找卡）。
 * 每张在跑的都带一个**独一无二的 jobId** —— 报告的配对全靠它，串了就看不出 B2 那条。
 */
const CARDS = [
  { id: 'syn-hit', title: '【合成】有进度', jobId: 'job-hit' },
  { id: 'syn-null', title: '【合成】模型没给数字', jobId: 'job-null' },
  { id: 'syn-prev', title: '【合成】报告只讲了上一轮', jobId: 'job-prev-new' },
  { id: 'syn-legacy', title: '【合成】老记录（报告里没有 jobId）', jobId: 'job-legacy' },
  { id: 'syn-bad', title: '【合成】越界的脏值', jobId: 'job-bad' },
  { id: 'syn-untouched', title: '【合成】报告还没覆盖到', jobId: 'job-untouched' },
]

/**
 * 桩数据。`prevJobId` 是 C 组那个**唯一**的变量：默认给"卡上这一轮"的 jobId（与报告里
 * 那条讲的 `job-prev-old` 对不上 → 不画），反向对照时改成报告里那个（对得上 → 画）。
 * 除了这一个字段，两次跑的是同一份夹具。
 */
function fixture({ prevJobId = 'job-prev-new' } = {}) {
  const at = (minAgo) => new Date(Date.now() - minAgo * 60 * 1000).toISOString()
  const board = CARDS.map(c => ({
    id: c.id, title: c.title, desc: '', projectPath: PROJECT_PATH,
    column: 'doing', attachmentCount: 0, runningJobs: 1,
    live: {
      jobId: c.id === 'syn-prev' ? prevJobId : c.jobId,
      status: 'running', agent: 'claude', startedAt: at(3), pid: 4242,
      elapsedMs: 3 * 60 * 1000, toolCallCount: 12, toolMix: 'Bash×12',
      lastTool: 'Edit src/ui/client/src/views/components/WorkbenchKanban.vue',
      lastThought: '把进度条搬到卡片上', lastLine: '', silentMs: null,
    },
    lastReply: null, lastJobAgent: 'claude', lastJobStatus: 'running',
    lastJobEndedAt: null, createdAt: at(60), updatedAt: at(3),
  }))
  // 已完成的一条：报告里有它的 40%，但它在"已完成"列 —— 不该画（B5）
  board.push({
    id: 'syn-done', title: '【合成】已完成但报告里有它', desc: '', projectPath: PROJECT_PATH,
    column: 'done', attachmentCount: 0, runningJobs: 0, live: null,
    lastReply: '跑完了', lastJobAgent: 'claude', lastJobStatus: 'success',
    lastJobEndedAt: at(20), lastDurationMs: 4 * 60 * 1000, lastJobStartedAt: at(24),
    createdAt: at(90), updatedAt: at(20),
  })

  const fact = (taskId, jobId, percent, title) => ({
    taskId, jobId, taskTitle: title, projectName: 'zen-gitsync',
    startedAt: at(3), elapsedMs: 3 * 60 * 1000, agent: 'claude', toolCallCount: 12,
    lastTool: '', lastLine: '', percent,
  })
  const reports = [{
    id: 'probe-report-1', at: at(1), trigger: 'auto',
    text: '桩：正在把进度条搬到看板卡片上。', percent: 62, errorCode: '', errorDetail: '',
    tasks: [
      fact('syn-hit', 'job-hit', 62, '【合成】有进度'),
      fact('syn-null', 'job-null', null, '【合成】模型没给数字'),
      // B2：这条讲的是**上一轮**（job-prev-old），卡上跑的是 job-prev-new
      fact('syn-prev', 'job-prev-old', 90, '【合成】报告只讲了上一轮'),
      // D：老记录没有 jobId 字段 → 退回按 taskId 认
      { ...fact('syn-legacy', null, 35, '【合成】老记录（报告里没有 jobId）'), jobId: null },
      // B3：越界的脏值（老服务端 / 别的实例写的）
      fact('syn-bad', 'job-bad', 130, '【合成】越界的脏值'),
      // B5：已完成的那条，报告里有它的数字
      fact('syn-done', 'job-done', 40, '【合成】已完成但报告里有它'),
      // B4 的对照：报告里**没有** syn-untouched 这一条
    ],
  }]

  const tasks = board.map(t => ({
    id: t.id, title: t.title, desc: t.desc, promptId: null, simpleOverride: '',
    projectPath: PROJECT_PATH, status: t.column, attachments: [],
    createdAt: t.createdAt, updatedAt: t.updatedAt,
  }))
  const project = {
    path: PROJECT_PATH, key: PROJECT_PATH.toLowerCase(), name: 'zen-gitsync',
    source: 'both', isCurrent: true, git: null, stats: {
      total: board.length, todo: 0, doing: CARDS.length, done: 1, progress: 0,
      runningJobs: CARDS.length, lastActiveAt: at(3),
    },
  }
  return { board, tasks, project, reports }
}

/** 把 stub 装上（board / 报告 / 在跑列表各一份；C 组会带着新夹具重装一次） */
async function installStubs(page, data) {
  const json = (route, body) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(body),
  })
  await page.unroute('**/api/workbench/projects*')
  await page.unroute('**/api/workbench/orchestrator/reports*')
  await page.unroute('**/api/workbench/orchestrator')
  await page.route('**/api/workbench/projects*', (route) => json(route, {
    success: true, projects: [data.project], tasks: data.board, currentProjectPath: PROJECT_PATH,
  }))
  await page.route('**/api/workbench/orchestrator/reports*', (route) =>
    json(route, { success: true, reports: data.reports }))
  /**
   * 在跑列表：F2 要的正向对照（右栏的报告卡只在"它讲的那批 job 还在跑"时才挂出来，
   * 判据是 jobId 对不对得上 running —— 见 OrchestratorConsole 的 reportIsLive）。
   * 不桩这个的话右栏恒为空态，F1「那一区没了」就成了空断言。
   */
  await page.route('**/api/workbench/orchestrator', (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return json(route, {
      success: true, active: true, updatedAt: null, instructions: [], activity: [],
      maxInstructionChars: 100000, defaultPrompt: '', projectPrompts: {}, reportIntervalMs: 600000,
      running: data.reports[0].tasks.filter(f => f.jobId).map(f => ({
        jobId: f.jobId, taskId: f.taskId, subId: null, taskTitle: f.taskTitle,
        status: 'running', pid: 4242, startedAt: f.startedAt,
        projectPath: PROJECT_PATH, projectName: 'zen-gitsync',
      })),
    })
  })
}

/**
 * 一次读完所有卡片的进度条状态（别分多次 evaluate —— 5s 轮询会在两次之间把 DOM 换掉）。
 *
 * 宽度同时读**内联 style** 与**实测像素**：只看内联的话，"CSS 把宽度吃掉了"
 * 这种情况量不出来（本仓库在进度条上踩过）。
 */
function readCards(page) {
  return page.evaluate(() => {
    const out = {}
    for (const card of document.querySelectorAll('.kb-card')) {
      const title = (card.querySelector('.kb-card__title')?.textContent || '').trim()
      const row = card.querySelector('.kb-card__live-progress')
      const meta = card.querySelector('.kb-card__live-meta')
      const fill = row ? row.querySelector('.kb-card__live-bar-fill') : null
      const track = row ? row.querySelector('.kb-card__live-bar') : null
      out[title] = {
        found: true,
        hasRow: !!row,
        count: card.querySelectorAll('.kb-card__live-progress').length,
        inlineWidth: fill ? fill.style.width : '',
        fillPx: fill ? fill.getBoundingClientRect().width : 0,
        trackPx: track ? track.getBoundingClientRect().width : 0,
        text: row ? (row.querySelector('.kb-card__live-pct')?.textContent || '').trim() : '',
        role: track ? track.getAttribute('role') : '',
        ariaNow: track ? track.getAttribute('aria-valuenow') : '',
        ariaLabel: track ? track.getAttribute('aria-label') : '',
        title: row ? row.getAttribute('title') : '',
        /** 进度行在活动行上面（先总述后证据）—— 量几何，别数节点 */
        rowTop: row ? +row.getBoundingClientRect().top.toFixed(1) : null,
        metaBottom: meta ? +meta.getBoundingClientRect().bottom.toFixed(1) : null,
        lineTop: card.querySelector('.kb-card__live-line')
          ? +card.querySelector('.kb-card__live-line').getBoundingClientRect().top.toFixed(1)
          : null,
        hasLive: !!card.querySelector('.kb-card__live'),
      }
    }
    return out
  })
}

/** 右栏「任务事实」那一区还在不在（选择器 + 计数一起报，红了能看出是"没渲染"还是"真没了"） */
function readConsole(page) {
  return page.evaluate(() => ({
    reportPanel: !!document.querySelector('.oc__report'),
    reportCard: !!document.querySelector('.rp'),
    facts: document.querySelectorAll('.rp__facts').length,
    factItems: document.querySelectorAll('.rpt').length,
    factPercents: document.querySelectorAll('.rpt__percent').length,
  }))
}

async function openCommandMode(page) {
  await page.waitForSelector('.activity-bar', { timeout: 30000 })
  await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
  await page.waitForSelector('.oc', { timeout: 30000 })
  const cmdTab = page.locator('.oc__mode-btn').filter({ hasText: '指令' }).first()
  if (await cmdTab.count()) await cmdTab.click()
  await sleep(400)
}

async function main() {
  const data = fixture()
  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox'],
  })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  let shot = null
  try {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('wb.boardView.v1', 'kanban')
        // 预置「全部项目」：全新上下文里 savedSelection === null 时 applyDefaultSelection()
        // 会把选中项落到「当前项目」，这里直接给上，省一次点击也少一处时序依赖
        localStorage.setItem('wb.boardProject.v1', '')
      } catch { /* 隐私模式 */ }
    })
    await installStubs(page, data)
    // 其余接口一律给空，免得真实数据（别的 session 正在跑的任务）混进这批断言
    const json = (route, body) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(body),
    })
    await page.route('**/api/workbench/tasks*', (route) => json(route, { tasks: data.tasks }))
    await page.route('**/api/workbench/jobs*', (route) => json(route, { jobs: [] }))
    await page.route('**/api/workbench/current-project*', (route) => json(route, { path: PROJECT_PATH }))

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.kb-card', { timeout: 15000 })
    await page.locator('.proj-item--all').first().click()
    await page.waitForSelector('.kb-card[data-task-id="syn-hit"]', { timeout: 15000 })
    // 报告是 30s 一次的轮询，首帧那次 loadReports 也可能还没回来 —— 等到进度条出现为止
    await page.waitForSelector('.kb-card__live-progress', { timeout: 15000 }).catch(() => {})
    await sleep(600)

    const cards = await readCards(page)
    const hit = cards['【合成】有进度'] || { found: false }
    log('有进度那张:', JSON.stringify(hit))

    /* ══ A 有数字就画 ══ */
    check('A1 卡片上画出进度条（轨道 + 填充都在）', hit.hasRow && hit.trackPx > 0,
      `row=${hit.hasRow} track=${hit.trackPx}`)
    check('A2 填充宽度 = 主 Agent 给的那个数（量像素，不信内联 style）',
      hit.inlineWidth === '62%' && Math.abs(hit.fillPx / hit.trackPx - 0.62) < 0.02,
      `inline=${hit.inlineWidth} px=${hit.fillPx.toFixed(1)}/${hit.trackPx.toFixed(1)}`)
    check('A3 数字带「AI 估计」字样（不能光甩一个 62% 让人当成实测进度）',
      /AI/.test(hit.text) && hit.text.includes('62%'), `text="${hit.text}"`)
    check('A4 有 progressbar 语义（aria 值 = 那个数，名字是任务标题）',
      hit.role === 'progressbar' && hit.ariaNow === '62' && hit.ariaLabel === '【合成】有进度',
      `role=${hit.role} now=${hit.ariaNow} label="${hit.ariaLabel}"`)
    check('A5 悬停能说明这个数字的来路（"不是精确进度"那句）',
      hit.title.length > 0, `title="${hit.title.slice(0, 50)}"`)
    check('A6 位置在元信息行下面、活动行上面（先总述后证据）',
      hit.rowTop !== null && hit.metaBottom !== null && hit.lineTop !== null
      && hit.rowTop >= hit.metaBottom - 1 && hit.rowTop <= hit.lineTop,
      `meta.bottom=${hit.metaBottom} row.top=${hit.rowTop} line.top=${hit.lineTop}`)
    check('A7 一张卡只有一条进度条', hit.count === 1, `count=${hit.count}`)

    /* ══ B 不该画的一条都不画 ══ */
    const notDrawn = [
      ['B1 模型没给百分比（null）→ 不画 0% 糊弄人', '【合成】模型没给数字'],
      ['B2 报告讲的是**上一轮**（jobId 对不上）→ 不画（否则"刚点执行就显示 90%"）', '【合成】报告只讲了上一轮'],
      ['B3 越界的脏值（130）→ 不画（画成 100% 等于替模型说"做完了"）', '【合成】越界的脏值'],
      ['B4 报告还没覆盖到这条新任务 → 不画（不是画 0）', '【合成】报告还没覆盖到'],
      ['B5 没在跑的任务 → 不画（进度只属于正在跑的那一轮）', '【合成】已完成但报告里有它'],
    ]
    for (const [name, title] of notDrawn) {
      const c = cards[title] || { found: false }
      check(name, c.found && !c.hasRow, `found=${c.found} row=${c.hasRow} text="${c.text || ''}"`)
    }

    /* ══ D 老记录（报告里没有 jobId）退回按 taskId 认 ══ */
    const legacy = cards['【合成】老记录（报告里没有 jobId）'] || { found: false }
    check('D1 老记录没有 jobId 时退回按 taskId 认 → 照画 35%',
      legacy.hasRow && legacy.text.includes('35%'), `row=${legacy.hasRow} text="${legacy.text || ''}"`)

    /* ══ C 反向对照：把 B2 那张卡的 jobId 改成报告里那个 → 条必须出现 ══ */
    // 与 B2 的差别**只有**这一个字段（见 fixture 的 prevJobId）：条出现了，
    // 就证明 B2 那条不是"这张卡永远不画"（比如 live 根本没渲染）
    await installStubs(page, fixture({ prevJobId: 'job-prev-old' }))
    await page.waitForSelector('.kb-card[data-task-id="syn-prev"] .kb-card__live-progress', { timeout: 15000 })
      .catch(() => {})
    await sleep(600)
    const cards2 = await readCards(page)
    const prev = cards2['【合成】报告只讲了上一轮'] || { found: false }
    check('C1 反向对照：jobId 对上当前这一轮时那条**出现**了（B2 不是恒绿）',
      prev.hasRow && prev.text.includes('90%'), `row=${prev.hasRow} text="${prev.text || ''}"`)

    /* ══ E 列表视图：同一份数字以文字出现 ══ */
    // ⚠️ 走工具栏那颗「列表视图」（不是改 localStorage 再 reload）：本脚本的
    //    addInitScript 每次导航都把视图写回 kanban，reload 会把设置冲掉
    await page.locator('.kb__view-btn').filter({ hasText: '列表视图' }).first().click()
    await page.waitForSelector('.kb-table__row', { timeout: 15000 })
    await sleep(800)
    const listRow = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.kb-table__row'))
      const row = rows.find(r => (r.querySelector('.kb-table__name')?.textContent || '').trim() === '【合成】有进度')
      if (!row) return { found: false, names: rows.map(r => (r.querySelector('.kb-table__name')?.textContent || '').trim()) }
      const el = row.querySelector('.kb-table__pct')
      return { found: true, text: el ? el.textContent.trim() : '', title: el ? el.getAttribute('title') : '' }
    })
    check('E1 列表视图同一行也有这个数字（两种画法一边有一边没有会让人以为是两份数据）',
      listRow.found && /AI/.test(listRow.text) && listRow.text.includes('62%'),
      `found=${listRow.found} text="${listRow.text || ''}" names=${JSON.stringify(listRow.names || []).slice(0, 120)}`)

    // 回看板视图（截图与 F 组都在看板这边）
    await page.locator('.kb__view-btn').filter({ hasText: '看板视图' }).first().click()
    await page.waitForSelector('.kb-card', { timeout: 15000 })
    await sleep(400)

    /* ══ F 右栏那一区已经不在了 ══ */
    await openCommandMode(page)
    if (REVERSE) {
      // 反证：把旧的那一区注回右栏（结构照旧：.rp__facts > .rp__tasks > li.rpt > .rpt__percent）
      await page.evaluate(() => {
        const host = document.querySelector('.oc__report') || document.querySelector('.oc')
        const wrap = document.createElement('div')
        wrap.className = 'rp__facts'
        wrap.innerHTML = '<ul class="rp__tasks"><li class="rpt">'
          + '<p class="rpt__title">桩：旧位置的进度</p>'
          + '<p class="rpt__progress"><i class="rpt__bar-fill" style="width:62%"></i>'
          + '<span class="rpt__percent">62%</span></p></li></ul>'
        host.appendChild(wrap)
      })
      await sleep(200)
    }
    const cons = await readConsole(page)
    check('F1 右栏已经没有「任务事实」那一区（事实与进度都在卡片上）',
      cons.facts === 0 && cons.factItems === 0 && cons.factPercents === 0,
      `facts=${cons.facts} items=${cons.factItems} percents=${cons.factPercents}`)
    check('F2 正向对照：进度报告面板本身渲染着（否则 F1 只是"面板没出来"）',
      cons.reportPanel && cons.reportCard, `panel=${cons.reportPanel} card=${cons.reportCard}`)

    /* ══ G 无异常 ══ */
    check('G1 无 JS 运行时异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300))
    const bad = consoleErrors.filter(t => !/favicon|ResizeObserver/i.test(t))
    check('G2 无控制台错误', bad.length === 0, bad.slice(0, 3).join(' | ').slice(0, 300))

    /* ══ H 截图存证 ══ */
    shot = path.resolve(__dirname, '../.tmp/verify-wb-card-progress.png')
    await page.locator('.kb-col--doing').first().screenshot({ path: shot }).catch(() => {})
    log('截图:', shot)
  } finally {
    await browser.close()
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

/**
 * 看板「等你回话」标的验证。
 *
 * 解决的问题：已完成列里混着两种任务 —— 真做完的，和模型收尾时反问
 * 「要不要我接着做？」的。两者在卡片上长得一模一样（标题 + 用时 + 一段收尾），
 * 用户要分辨只能把那段收尾读完，而这一列动辄两三百张（本机 2026-11-06 实测 237 张）。
 *
 * 验收契约（改这块时别破坏）：
 *   A 判成「在等回话」的卡片上有「等你回话」标，文字对、能看见，
 *     悬停提示里带着**主 Agent 给的依据**（标只有四个字，凭什么说它在等我，只有依据能答）
 *   B 判成"普通完成"的对照卡**没有**这枚标（满屏都是标等于没标）
 *   C 用户手动标过完成的任务不再挂这枚标（那是用户已经表过态的事）
 *   D 标**不在** .kb-card__reply 里面 —— 引文有逐字断言（verify-wb-card-reply 的 A2），
 *     往里加字会把它打红；这里直接量"引文文字与 lastReply 逐字一致"
 *   E 列表视图也挂在**状态列**（与卡片同一口径），回复那行的文字不动（G1 的契约）
 *   F 服务端：判定只在自己那一轮 job 上有效（jobId 记账），手动完成 / 不在已完成列都不挂标
 *   G 页面无 console / page 错误
 *   H 已完成列头「等你回话」聚合 chip：计数对、默认关（不改变既有渲染）、点一下只留
 *     等回话的卡、再点还原（2026-11-13）
 *   R 负控（--reverse）：夹具里把这枚标抹掉、把聚合 chip 藏掉 —— A/E/H 必须变红
 *
 * 注意：**判定本身（模型读句子）不在这里验**。它是异步的、要真实模型往返，
 * 而且是"读懂一句话"，不是可以离线复现的纯函数 —— prompt / 解析 / 缓存边界的
 * 单测在 replyTriage.test.js。本脚本只钉"判定结果怎么落到屏幕上"。
 *
 * 为什么用 route 拦截 /api/workbench/projects 而不是读真实响应：
 *   "哪条在等你回话"取决于模型当时怎么判，真实数据里凑不齐"该标 / 不该标"的对照；
 *   没有对照，这脚本就成了永远绿的空跑。所以夹具在脚本里调用真正的后端函数
 *   （decorateTaskForBoard + pickTriageForTask）造三种情形，只少一次网络跳。
 *
 * 前置：dev server 已启动（vite 5544）；后端活着（默认 5545，端口漂了用 ZEN_API 指）
 * 用法：node scripts/verify-wb-awaiting-reply.cjs [--reverse]
 * 退出码：0 全通过，1 有失败项。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544'
const API = process.env.ZEN_API || 'http://127.0.0.1:5545'
const DATA_DIR = path.join(os.homedir(), '.zen-gitsync')
const CHROME = process.env.ZEN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const REVERSE = process.argv.includes('--reverse')

const LABEL = '等你回话'
/** 合成卡片上主 Agent 给的依据 —— A2 要断言它真的出现在悬停提示里 */
const REASON = '收尾在问要不要顺手更新文档'
const PROJECT_PATH = 'D:\\ws\\zen-gitsync'
const ASK_TITLE = '【合成】收尾在问用户：该有这枚标'
const PLAIN_TITLE = '【合成】陈述式收尾：不该有这枚标'
const MANUAL_TITLE = '【合成】用户手动标完成：不该有这枚标'

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
/** DOM 里的空白（模板缩进 / 换行）不该影响"文字对不对"的判断 */
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()

/**
 * 读执行记录：历史档案（jobs.json）∪ 各实例正在跑的（live-jobs/*.json），同 id 时 live 赢
 * —— 后端 mergedJobs 的口径（内存 > live > 磁盘；本脚本没有"本进程自己跑的 job"）。
 */
async function readRealJobs() {
  const byId = new Map()
  try {
    const disk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'jobs.json'), 'utf-8'))
    for (const j of Array.isArray(disk.jobs) ? disk.jobs : []) if (j && j.id) byId.set(j.id, j)
  } catch (err) {
    log('读 jobs.json 失败（继续，只影响非运行中任务的列推导）:', err.message)
  }
  try {
    const dir = path.join(DATA_DIR, 'live-jobs')
    for (const name of fs.readdirSync(dir)) {
      if (!/^\d+\.json$/.test(name)) continue
      const ownerPid = Number(name.slice(0, -'.json'.length))
      try { process.kill(ownerPid, 0) } catch { continue } // owner 不在了：与后端同口径跳过
      const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'))
      for (const j of Array.isArray(data.jobs) ? data.jobs : []) if (j && j.id) byId.set(j.id, j)
    }
  } catch (err) {
    if (err.code !== 'ENOENT') log('读 live-jobs 失败:', err.message)
  }
  return [...byId.values()]
}

/** 一条跑完的 job（收尾文字由调用方给），时刻都落在"现在前几分钟" —— 保证排在已完成列最上边 */
function doneJob(taskId, output, endedAt) {
  return {
    id: `${taskId}-job`,
    taskId,
    status: 'done',
    pid: 1234,
    startedAt: new Date(Date.parse(endedAt) - 8 * 60 * 1000).toISOString(),
    endedAt,
    lastActivityAt: endedAt,
    output,
    thinking: '',
    toolCalls: [],
  }
}

/**
 * 三条合成任务：判成"在等回话"的 / 判成普通完成的 / 用户手动标完成的。
 * `--reverse` 把 awaitingReply 抹掉（= 这次改动之前的形态），用来证明断言真的在守它。
 *
 * ⚠️ 判据本身（主 Agent / 模型）不在这里验：判定是异步的、要真实模型往返，
 * 探针只负责"判定结果怎么落到卡片上"。prompt / 解析 / 按 jobId 记账的边界在
 * replyTriage.test.js 里，逐条覆盖。
 */
function syntheticTasks({ decorate }) {
  const at = (minAgo) => new Date(Date.now() - minAgo * 60 * 1000).toISOString()
  const rows = [
    [{
      id: 'syn-ask', title: ASK_TITLE, desc: '', projectPath: PROJECT_PATH, createdAt: at(30),
    }, [doneJob('syn-ask', '三处都改完了，已提交。需要我顺手把文档也更新一下吗？', at(5))],
    { waiting: true, reason: '收尾在问要不要顺手更新文档' }],
    [{
      id: 'syn-plain', title: PLAIN_TITLE, desc: '', projectPath: PROJECT_PATH, createdAt: at(30),
    }, [doneJob('syn-plain', '三处都改完了，已提交并推送。', at(7))],
    { waiting: false, reason: '' }],
    [{
      id: 'syn-manual', title: MANUAL_TITLE, desc: '', projectPath: PROJECT_PATH,
      createdAt: at(30), manualDoneAt: at(9),
    }, [doneJob('syn-manual', '改了一半。要我现在接着做吗？', at(10))],
    { waiting: true, reason: '收尾在问要不要接着做' }],
  ]
  return rows.map(([task, jobs, triage]) => {
    const card = decorate(task, jobs, { triage })
    return REVERSE ? { ...card, awaitingReply: false, awaitingReason: '' } : card
  })
}

async function main() {
  const registry = await import(pathToFileURL(
    path.resolve(__dirname, '../src/ui/server/routes/workbench/projectRegistry.js')
  ).href)
  const triage = await import(pathToFileURL(
    path.resolve(__dirname, '../src/ui/server/routes/workbench/replyTriage.js')
  ).href)

  // ── F 服务端：判定结果怎么落到卡片上 ─────────────────────────────────
  // 判定本身（模型读句子）不在这里验 —— 那是异步的、要真实模型往返；
  // prompt / 解析 / 按 jobId 记账的边界在 replyTriage.test.js 里逐条覆盖。
  const sampleTask = { id: 't-sample', title: '样本', desc: '', projectPath: PROJECT_PATH }
  const sampleJob = doneJob('t-sample', '改好了。要不要我顺手把测试也补上？', new Date().toISOString())
  const askCard = registry.decorateTaskForBoard(sampleTask, [sampleJob], {
    triage: { waiting: true, reason: '收尾在征求用户意见' },
  })
  check('F1 主 Agent 判成「在等回话」→ 卡片挂标，且把它的依据一并带出',
    askCard.awaitingReply === true && askCard.awaitingReason === '收尾在征求用户意见',
    `${askCard.awaitingReply} / ${askCard.awaitingReason}`)

  const plainCardServer = registry.decorateTaskForBoard(sampleTask, [sampleJob], {
    triage: { waiting: false, reason: '' },
  })
  check('F2 判定为 false → 不挂标（满屏都是标等于没标）',
    plainCardServer.awaitingReply === false && plainCardServer.awaitingReason === '', String(plainCardServer.awaitingReply))

  const manualCard = registry.decorateTaskForBoard(
    { ...sampleTask, manualDoneAt: new Date().toISOString() },
    [sampleJob],
    { triage: { waiting: true, reason: '在问你要不要继续' } },
  )
  check('F3 用户手动标过完成 → 即使模型判了"在等回话"也不挂（用户已经表过态）',
    manualCard.awaitingReply === false, String(manualCard.awaitingReply))

  // 缓存按 jobId 记账：任务重跑一轮，上一轮的结论必须失效
  const staleStore = { 't-sample': { jobId: 'old-job', waiting: true, reason: '上一轮', at: '', attempts: 1 } }
  const stale = triage.pickTriageForTask(staleStore, 't-sample', [sampleJob])
  const fresh = triage.pickTriageForTask(
    { 't-sample': { jobId: sampleJob.id, waiting: true, reason: '这一轮', at: '', attempts: 1 } },
    't-sample', [sampleJob],
  )
  check('F4 判定按 jobId 记账：换了一轮 job 旧结论作废，同一轮才采纳',
    stale === null && !!fresh && fresh.waiting === true, JSON.stringify({ stale, fresh }))

  // ── 真实数据 + 合成数据拼成看板负载 ──────────────────────────────────
  const now = Date.now()
  const realTasks = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tasks.json'), 'utf-8')).tasks || []
  const jobs = await readRealJobs()
  const byTask = registry.groupJobsByTask(jobs)
  // 真实卡也用真实缓存（只读）：这样看板上"等回话"的分布就是用户实际看到的那份
  const realStore = await triage.readTriageStore()
  const boardTasks = realTasks.map((t) => {
    const jobsForTask = byTask.get(t.id) || []
    return registry.decorateTaskForBoard(t, jobsForTask, {
      now, triage: triage.pickTriageForTask(realStore, t.id, jobsForTask),
    })
  })
  log(`真实数据：任务 ${boardTasks.length} 条，已完成里 ${boardTasks.filter(t => t.awaitingReply).length} 条在等你回话`)

  const live = await fetch(`${API}/api/workbench/projects`).then(r => r.json())
  const backendHasField = (live.tasks || []).every(t => typeof t.awaitingReply === 'boolean')
  check('F5 服务端接口已经把这枚标发出来了（不是前端各自算一遍）',
    REVERSE ? true : backendHasField, REVERSE ? '反向模式跳过' : '')

  const tasks = boardTasks.concat(syntheticTasks({ decorate: registry.decorateTaskForBoard }))
  const askCardData = tasks.find(t => t.id === 'syn-ask')

  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox'],
  })
  // 视口按用户实际窗口取：卡片窄，标要和标题 / 用时放在同一张卡里还不挤
  const page = await (await browser.newContext({ viewport: { width: 2000, height: 1274 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  try {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('wb.boardView.v1', 'kanban')
        // 必须预置「全部项目」（''），否则选中项会落到当前项目，合成任务全被过滤掉
        localStorage.setItem('wb.boardProject.v1', '')
      } catch { /* 隐私模式 */ }
    })
    await page.route('**/api/workbench/projects*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, projects: live.projects, tasks, currentProjectPath: live.currentProjectPath }),
    }))

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.board', { timeout: 15000 })
    await page.locator('.proj-item--all').first().click()
    await sleep(1200)

    if (REVERSE) {
      // 负控（H 组）：把聚合 chip 藏掉。真实数据里可能仍有等回话的卡（chip 会被渲染），
      // 所以不能只靠夹具抹 awaitingReply —— 注入样式确保 chip 不可见，H1 反证才稳定。
      await page.addStyleTag({ content: '.kb-col__awaiting-chip { display: none !important; }' })
    }

    /**
     * 已完成列默认只铺最近 30 张（DONE_PAGE）。合成任务的时刻都造在"几分钟前"，
     * 正常都在第一屏；真实数据哪天多到把它们挤下去，这里按「显示更早的」翻出来。
     */
    const revealDoneCard = async (title) => {
      for (let i = 0; i < 20; i++) {
        const present = await page.evaluate((t) => Array.from(document.querySelectorAll('.kb-col--done .kb-card'))
          .some(c => (c.querySelector('.kb-card__title')?.textContent || '').trim() === t), title)
        if (present) return true
        const more = page.locator('.kb-col--done .kb-col__more-btn')
        if ((await more.count()) === 0) return false
        await more.first().click()
        await sleep(200)
      }
      return false
    }

    const readCard = (title) => page.evaluate((t) => {
      const cards = Array.from(document.querySelectorAll('.kb-card'))
      const card = cards.find(c => (c.querySelector('.kb-card__title')?.textContent || '').trim() === t)
      if (!card) return { found: false, titles: cards.map(c => (c.querySelector('.kb-card__title')?.textContent || '').trim()) }
      const mark = card.querySelector('.kb-card__awaiting')
      const rect = mark ? mark.getBoundingClientRect() : null
      const reply = card.querySelector('.kb-card__reply')
      const replyText = card.querySelector('.kb-card__reply-text')
      return {
        found: true,
        mark: mark ? mark.textContent.replace(/\s+/g, ' ').trim() : null,
        markTitle: mark ? mark.getAttribute('title') : null,
        markVisible: rect ? rect.width > 0 && rect.height > 0 : null,
        // 标必须在引文**外面**：引文那段有逐字断言（A2），往里加字就打红了
        markInReply: !!(mark && reply && reply.contains(mark)),
        reply: reply ? reply.textContent : null,
        replySpan: replyText ? replyText.textContent : null,
        cardWidth: Math.round(card.getBoundingClientRect().width),
        markWidth: rect ? Math.round(rect.width) : null,
        isDone: !!card.closest('.kb-col--done'),
      }
    }, title)

    for (const t of [ASK_TITLE, PLAIN_TITLE, MANUAL_TITLE]) {
      if (!await revealDoneCard(t)) throw new Error(`「显示更早的」点到底也找不到合成卡片：${t}`)
    }

    // ── A 收尾在问用户的卡：标在、文字对、能看见 ──────────────────────
    const ask = await readCard(ASK_TITLE)
    if (!ask.found) throw new Error(`看板上找不到合成卡片，实际有：${JSON.stringify(ask.titles)}`)
    check('A1 收尾在问用户的卡片上有「等你回话」标',
      REVERSE ? ask.mark === null : norm(ask.mark) === LABEL, String(ask.mark))
    check('A2 悬停提示里有主 Agent 给的依据 + 该怎么办（标只有四个字，读不出为什么算等你）',
      REVERSE ? ask.markTitle === null : (/点开看看/.test(String(ask.markTitle)) && String(ask.markTitle).includes(REASON)), String(ask.markTitle))
    check('A3 标能被看见（宽度 > 0，且没铺满整张卡）',
      REVERSE ? ask.mark === null : (ask.markVisible === true && ask.markWidth < ask.cardWidth),
      `${ask.markVisible} / ${ask.markWidth}of${ask.cardWidth}`)
    check('A4 卡片确实在「已完成」列（不是因为它压根不在这一列才没标）', ask.isDone === true, String(ask.isDone))

    // ── D 标不在引文里：引文文字与服务端 lastReply 逐字一致 ────────────
    check('D1 标不在 .kb-card__reply 里（那段有逐字断言，塞字会打红它）', ask.markInReply === false,
      String(ask.markInReply))
    check('D2 引文文字与服务端 lastReply 逐字一致',
      norm(ask.reply) === norm(askCardData.lastReply), `${norm(ask.reply)} ≠ ${norm(askCardData.lastReply)}`)

    // ── B/C 对照组：陈述式收尾、手动标完成，都不该有这枚标 ─────────────
    const plain = await readCard(PLAIN_TITLE)
    check('B1 陈述式收尾的卡片上没有这枚标', plain.found && plain.mark === null, `${plain.found} / ${plain.mark}`)
    const manual = await readCard(MANUAL_TITLE)
    check('C1 用户手动标「完成」的任务上也没有这枚标', manual.found && manual.mark === null,
      `${manual.found} / ${manual.mark}`)
    check('C2 对照组确实是「已完成」（不是因为不在这一列才没标）',
      plain.isDone === true && manual.isDone === true, `${plain.isDone} / ${manual.isDone}`)

    // 截图存证（反向模式也留一张：一眼能看出标确实没了）
    const shotsDir = path.resolve(__dirname, '../docs/shots')
    fs.mkdirSync(shotsDir, { recursive: true })
    await page.locator('.kb-col--done').first().screenshot({
      path: path.join(shotsDir, REVERSE ? 'wb-awaiting-reply-reverse.png' : 'wb-awaiting-reply.png'),
    })

    // ── H 「等你回话」聚合 chip + 过滤（2026-11-13）─────────────────────
    // 列头一枚琥珀 chip 报"有几条在等你"，点一下只留那些卡、再点还原。默认关。
    const chipSel = '.kb-col--done .kb-col__awaiting-chip'
    if (REVERSE) {
      const chipVisible = await page.evaluate(() => {
        const el = document.querySelector('.kb-col--done .kb-col__awaiting-chip')
        if (!el) return false
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      })
      check('H1 反证：聚合 chip 被藏掉（负控，证明下面的断言真在守它）', chipVisible === false, String(chipVisible))
    } else {
      const expectedAwaiting = tasks.filter(t => t.column === 'done' && t.awaitingReply).length
      const chipInfo = await page.evaluate(() => {
        const el = document.querySelector('.kb-col--done .kb-col__awaiting-chip')
        if (!el) return { found: false }
        const r = el.getBoundingClientRect()
        return {
          found: true,
          text: el.textContent.replace(/\s+/g, ' ').trim(),
          visible: r.width > 0 && r.height > 0,
          pressed: el.getAttribute('aria-pressed'),
        }
      })
      check('H1 已完成列头有「等你回话」chip，计数 = 等回话的已完成卡数，默认未按',
        chipInfo.found && chipInfo.visible && chipInfo.text.includes(String(expectedAwaiting)) && chipInfo.pressed === 'false',
        `${chipInfo.text}（期望含 ${expectedAwaiting}）pressed=${chipInfo.pressed}`)
      const plainVisibleDefault = await page.evaluate((t) => Array.from(document.querySelectorAll('.kb-col--done .kb-card'))
        .some(c => (c.querySelector('.kb-card__title')?.textContent || '').trim() === t), PLAIN_TITLE)
      check('H2 默认关：普通完成卡仍在列里（不改变既有渲染，A–E 不受影响）', plainVisibleDefault === true)
      await page.locator(chipSel).click()
      await sleep(300)
      const afterFilter = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.kb-col--done .kb-card'))
        return {
          count: cards.length,
          allAwaiting: cards.every(c => !!c.querySelector('.kb-card__awaiting')),
          titles: cards.map(c => (c.querySelector('.kb-card__title')?.textContent || '').trim()),
          pressed: document.querySelector('.kb-col--done .kb-col__awaiting-chip')?.getAttribute('aria-pressed'),
        }
      })
      check('H3 点一下只留等回话的卡（每张都带标、普通卡被滤掉、aria-pressed=true）',
        afterFilter.count > 0 && afterFilter.allAwaiting && !afterFilter.titles.includes(PLAIN_TITLE) && afterFilter.pressed === 'true',
        `${afterFilter.count} 张 allAwaiting=${afterFilter.allAwaiting} pressed=${afterFilter.pressed}`)
      await page.locator(chipSel).click()
      await sleep(300)
      const plainBack = await revealDoneCard(PLAIN_TITLE)
      check('H4 再点一下清除过滤，普通完成卡回到列里', plainBack === true)
    }

    // ── E 列表视图：同一口径挂在状态列，回复行文字不动 ────────────────
    await page.getByRole('tab', { name: /列表视图|List/ }).first().click()
    await page.waitForSelector('.kb-table__row', { timeout: 10000 })
    await sleep(400)
    const readRow = (title) => page.evaluate((t) => {
      const rows = Array.from(document.querySelectorAll('.kb-table__row'))
      const row = rows.find(r => (r.querySelector('.kb-table__name')?.textContent || '').trim() === t)
      if (!row) return { found: false }
      const mark = row.querySelector('.kb-table__awaiting')
      const reply = row.querySelector('.kb-table__live--reply')
      const time = row.querySelector('.kb-table__time')
      return {
        found: true,
        mark: mark ? mark.textContent.replace(/\s+/g, ' ').trim() : null,
        inStatusCell: !!(mark && mark.closest('td') && mark.closest('td').querySelector('.kb-table__status')),
        reply: reply ? reply.textContent : null,
        timeWrap: time ? getComputedStyle(time).whiteSpace : null,
        timeHeight: time ? Math.round(time.getBoundingClientRect().height) : null,
      }
    }, title)
    const askRow = await readRow(ASK_TITLE)
    const plainRow = await readRow(PLAIN_TITLE)
    check('E1 列表视图里这一行也有标（同一批任务的两种画法不能一边有一边没有）',
      REVERSE ? askRow.mark === null : norm(askRow.mark) === LABEL, String(askRow.mark))
    check('E2 标挂在状态列里，不塞进「最后回复」那行（G1 的逐字断言守着它）',
      REVERSE ? true : askRow.inStatusCell === true, String(askRow.inStatusCell))
    check('E3 回复行文字仍是服务端给的原文（没被标污染）',
      norm(askRow.reply) === norm(askCardData.lastReply), norm(askRow.reply).slice(0, 40))
    check('E4 时间格仍是单行（标落在状态列，不顶行高）',
      askRow.timeWrap === 'nowrap' && plainRow.timeWrap === 'nowrap',
      `${askRow.timeWrap} / ${plainRow.timeWrap} / h=${askRow.timeHeight}`)
    check('E5 陈述式收尾那一行没有标', plainRow.found && plainRow.mark === null, `${plainRow.found} / ${plainRow.mark}`)

    check('G1 页面无 console / page 错误',
      consoleErrors.length === 0 && pageErrors.length === 0,
      [...consoleErrors, ...pageErrors].slice(0, 3).join(' | '))
  } finally {
    // 只关自己起的这个浏览器实例（按 CDP，不用 taskkill /IM —— 那会连带关掉用户的浏览器）
    await browser.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n[verify] ${results.length - failed.length}/${results.length} 通过${REVERSE ? '（--reverse 反向模式）' : ''}`)
  if (failed.length) process.exit(1)
}

main().catch((err) => {
  console.error('[verify] 异常退出:', err)
  process.exit(1)
})

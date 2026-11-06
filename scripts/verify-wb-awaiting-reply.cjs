/**
 * 看板「等你回话」标的验证。
 *
 * 解决的问题：已完成列里混着两种任务 —— 真做完的，和模型收尾时反问
 * 「要不要我接着做？」的。两者在卡片上长得一模一样（标题 + 用时 + 一段收尾），
 * 用户要分辨只能把那段收尾读完，而这一列动辄两三百张（本机 2026-11-06 实测 237 张）。
 *
 * 验收契约（改这块时别破坏）：
 *   A 收尾在问用户的卡片上有「等你回话」标，文字对、能看见、悬停提示说得清"该怎么办"
 *   B 陈述式收尾的对照卡**没有**这枚标（满屏都是标等于没标）
 *   C 用户手动标过完成的任务不再挂这枚标（那是用户已经表过态的事）
 *   D 标**不在** .kb-card__reply 里面 —— 引文有逐字断言（verify-wb-card-reply 的 A2），
 *     往里加字会把它打红；这里直接量"引文文字与 lastReply 逐字一致"
 *   E 列表视图也挂在**状态列**（与卡片同一口径），回复那行的文字不动（G1 的契约）
 *   F 服务端判据：问句 / 礼貌性征询算，正文里的"要不要"不算；在跑 / 待处理 / 手动完成都不算
 *   G 页面无 console / page 错误
 *   R 负控（--reverse）：夹具里把这枚标抹掉 —— A/E 必须变红
 *
 * 为什么用 route 拦截 /api/workbench/projects 而不是读真实响应：
 *   "收尾在问用户"是个概率事件（本机 237 条已完成里 48 条），而且要看的是
 *   **有没有标的对照**；真实数据哪天一条都没有，这脚本就成了永远绿的空跑。
 *   所以夹具在脚本里调用真正的后端函数（decorateTaskForBoard）造三种收尾，只少一次网络跳。
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
 * 三条合成任务：问用户的 / 陈述式收尾的 / 用户手动标完成的。
 * `--reverse` 把 awaitingReply 抹掉（= 这次改动之前的形态），用来证明断言真的在守它。
 */
function syntheticTasks({ decorate }) {
  const at = (minAgo) => new Date(Date.now() - minAgo * 60 * 1000).toISOString()
  const rows = [
    [ASK_TITLE, { id: 'syn-ask', title: ASK_TITLE, desc: '', projectPath: PROJECT_PATH, createdAt: at(30) },
      [doneJob('syn-ask', '三处都改完了，已提交。需要我顺手把文档也更新一下吗？', at(5))]],
    [PLAIN_TITLE, { id: 'syn-plain', title: PLAIN_TITLE, desc: '', projectPath: PROJECT_PATH, createdAt: at(30) },
      [doneJob('syn-plain', '三处都改完了，已提交并推送。', at(7))]],
    [MANUAL_TITLE, {
      id: 'syn-manual', title: MANUAL_TITLE, desc: '', projectPath: PROJECT_PATH,
      createdAt: at(30), manualDoneAt: at(9),
    }, [doneJob('syn-manual', '改了一半。要我现在接着做吗？', at(10))]],
  ]
  return rows.map(([, task, jobs]) => {
    const card = decorate(task, jobs)
    return REVERSE ? { ...card, awaitingReply: false } : card
  })
}

async function main() {
  const registry = await import(pathToFileURL(
    path.resolve(__dirname, '../src/ui/server/routes/workbench/projectRegistry.js')
  ).href)

  // ── F 服务端判据 ─────────────────────────────────────────────────────
  const sampleTask = { id: 't-sample', title: '样本', desc: '', projectPath: PROJECT_PATH }
  const askCard = registry.decorateTaskForBoard(sampleTask, [
    doneJob('t-sample', '改好了。要不要我顺手把测试也补上？', new Date().toISOString()),
  ])
  check('F1 收尾是问句 → awaitingReply=true，且 lastReply 原样给出（判定依据要看得见）',
    askCard.awaitingReply === true && askCard.lastReply.includes('要不要我'), JSON.stringify(askCard.awaitingReply))

  const plainCardServer = registry.decorateTaskForBoard(sampleTask, [
    doneJob('t-sample', '改好了，已提交并推送。', new Date().toISOString()),
  ])
  check('F2 陈述式收尾 → false（不把"看什么都像在等你"变成噪声）',
    plainCardServer.awaitingReply === false, String(plainCardServer.awaitingReply))

  const midCard = registry.decorateTaskForBoard(sampleTask, [{
    ...doneJob('t-sample', '要不要这件事我们讨论过。结论是不做。已提交。', new Date().toISOString()),
  }])
  check('F3 正文里出现「要不要」但收尾是陈述 → false（只看最后两句）',
    midCard.awaitingReply === false, String(midCard.awaitingReply))

  const manualCard = registry.decorateTaskForBoard(
    { ...sampleTask, manualDoneAt: new Date().toISOString() },
    [doneJob('t-sample', '要我现在接着做吗？', new Date().toISOString())],
  )
  check('F4 用户手动标过完成 → false（用户已经表过态，不该替他反悔）',
    manualCard.awaitingReply === false, String(manualCard.awaitingReply))

  // ── 真实数据 + 合成数据拼成看板负载 ──────────────────────────────────
  const now = Date.now()
  const realTasks = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tasks.json'), 'utf-8')).tasks || []
  const jobs = await readRealJobs()
  const byTask = registry.groupJobsByTask(jobs)
  const boardTasks = realTasks.map(t => registry.decorateTaskForBoard(t, byTask.get(t.id) || [], { now }))
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
    check('A2 悬停提示说清"该怎么办"（标只有四个字，读不出为什么算等你）',
      REVERSE ? ask.markTitle === null : /点开看看/.test(String(ask.markTitle)), String(ask.markTitle))
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

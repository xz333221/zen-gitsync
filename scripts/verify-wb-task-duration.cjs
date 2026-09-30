/**
 * 看板「用时」统计的验证（2026-09-30 加）。
 *
 * 背景：卡片上原本只有"3 小时前"，答不出"这条到底跑了多久"——同一栏里
 * "跑了 12 分"和"跑了 3 小时"是完全不同的两件事，前者是顺手改个文案，
 * 后者是有人盯着屏幕等了半小时。于是补 lastDurationMs（服务端算）+ 卡片上那行「用时 x」。
 *
 * 验收契约（改这块时别破坏）：
 *   A 已完成的卡片上出现「用时 x」，与服务端 lastDurationMs 逐字一致；而且它**独占一行** ——
 *     首行时间位仍只有"什么时候的事"。第一版是把它塞进首行的，实测立刻把项目色标
 *     压出 1px 省略号（verify-wb-card-row1 的 C 组守的正是"色标一枚都不许被压窄"）
 *   B 正在跑的任务不给用时：那个时长每 5s 都在长，已经写在活动区的「已运行」里，
 *     两处各给一个会长一个不长的数字，用户会以为其中一个坏了
 *   C 推不出时长的两类任务（从没跑过 / 老记录只有 startedAt 没有 endedAt）不显示用时，
 *     更不写"用时 0 秒"—— 假 0 比不显示更糟
 *   D 渲染出的字符串形状由合成任务钉死（20 分整 → 中文「用时 20 分 0 秒」/ 英文「took 20 min 0 s」），
 *     格式化函数改档位（少一档 / 多一档 / 换分隔符）这里立刻红
 *   E 列表视图同一行也有（同一批任务的两种画法，一边有一边没有会让人以为是两份数据），
 *     且时间格不换行（fixed 布局下换行会把行高顶高，整张表参差）
 *   F 悬停提示给出起止两个绝对时刻（"几点到几点"，排查"那段时间跑过什么"要用）
 *   G 页面无 console / page 错误
 *   D/F1–F3 是前置事实而不是 UI 契约：F1 fixture 与运行中后端口径无漂移（否则后面的断言
 *   验的不是同一块板子）、F2/F3 服务端时长口径（反证注入到真正拍板的那一层）。
 *
 * 为什么用 route 拦截 /api/workbench/projects 而不是直接读真实响应：
 *   运行中的后端可能是旧进程（改完代码不一定重启），拿它验证等于在验旧代码。
 *   这里改为在脚本里调用真正的后端函数（projectRegistry.decorateTaskForBoard），
 *   喂真实数据（~/.zen-gitsync 的 tasks.json / jobs.json / live-jobs/*.json），
 *   再把结果从 HTTP 那一段接过去 —— 链路是：新后端代码 + 真实数据 → 前端渲染。
 *
 * 语言：探针不改用户配置里的 locale（那会动到 ~/.zen-gitsync/config.json），
 * 所以期望值按 config.json 里**当前语言**取，并给一份中英对照 —— 加第三种语言时
 * 这里会硬失败，提醒补期望值而不是悄悄放行。
 *
 * 前置：dev server 已启动（vite 5544）；后端 5545 活着（提供其余接口的真实响应）。
 * 用法：node scripts/verify-wb-task-duration.cjs
 * 退出码：0 全通过，1 有失败项，2 前置数据不足。
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

/** 界面语言：只读不写，探针不许动用户的 config.json */
function uiLanguage() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf-8'))
    return String(cfg.locale || 'zh-CN').startsWith('en') ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

/**
 * 毫秒 → 与页面同形的文案。镜像前端 utils/relativeTime.ts 的 formatDurationMs
 * （本仓惯例：改文案换 key，所以这里的字面量对得上 zh/en 词表）。
 * 别在这里再加一档或改分隔符 —— D1 那条断言就是拿它当基准的。
 */
function expectDuration(ms, lang) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const body = h > 0
    ? (lang === 'en' ? `${h} h ${m} min` : `${h} 小时 ${m} 分`)
    : m > 0
      ? (lang === 'en' ? `${m} min ${s} s` : `${m} 分 ${s} 秒`)
      : (lang === 'en' ? `${s} s` : `${s} 秒`)
  return lang === 'en' ? `took ${body}` : `用时 ${body}`
}

/**
 * 读执行记录：历史档案（jobs.json）∪ 各实例正在跑的（live-jobs/*.json），**同 id 时 live 赢**
 * —— 这就是后端 mergedJobs 的口径（内存 > live > 磁盘；本脚本没有"本进程自己跑的 job"，
 * 所以只剩 live > 磁盘这一条）。
 *
 * 为什么不直接 import jobStore 用它的 mergedJobs：那个模块 import 时就会
 * fire-and-forget 跑 hydrateJobs()，把磁盘上"上一次留下的 running 记录"在内存里标成
 * error —— 而验证脚本恰恰要在别的进程正在跑的时候读同一批数据。
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

/**
 * 合成任务：覆盖真实数据里不一定出现的分支。
 * 关键那条 synth-dur 的时长**正好 20 分钟整**，让 D1 能逐字钉住渲染形状。
 */
function syntheticTasks({ decorate, now }) {
  const at = (minAgo) => new Date(now - minAgo * 60 * 1000).toISOString()
  const cases = [
    // 20 分整（20:00 → 20:00 之前 20 分钟）
    ['dur', '【合成】精确时长 20 分整', {
      id: 'synth-dur-job', taskId: 'synth-dur', subId: 'synth-dur__j', title: '',
      status: 'done', startedAt: at(25), endedAt: at(5), output: '改完了，不用推。',
    }],
    // 正在跑：首行不该有「用时」
    ['running', '【合成】正在跑：时长归活动区', {
      id: 'synth-running-job', taskId: 'synth-running', subId: 'synth-running__j', title: '',
      status: 'running', startedAt: at(2), lastActivityAt: at(1), output: '刚起步',
    }],
    // 老记录：只有 startedAt，没有 endedAt → 算不出时长
    ['legacy', '【合成】老记录缺 endedAt', {
      id: 'synth-legacy-job', taskId: 'synth-legacy', subId: 'synth-legacy__j', title: '',
      status: 'done', startedAt: at(30), output: '很久以前的记录',
    }],
    // 从没跑过
    ['virgin', '【合成】从没跑过', null],
  ]
  return cases.map(([id, title, job]) =>
    decorate({ id: `synth-${id}`, title, desc: '', projectPath: 'D:\\ws\\zen-gitsync', createdAt: at(40) }, job ? [job] : []),
  )
}

async function main() {
  const registry = await import(pathToFileURL(
    path.resolve(__dirname, '../src/ui/server/routes/workbench/projectRegistry.js')
  ).href)

  const lang = uiLanguage()
  const now = Date.now()
  const realTasks = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tasks.json'), 'utf-8')).tasks || []
  const jobs = await readRealJobs()
  const byTask = registry.groupJobsByTask(jobs)
  const boardTasks = realTasks.map(t => registry.decorateTaskForBoard(t, byTask.get(t.id) || [], { now }))
  const finished = boardTasks.filter(t => t.column === 'done' && typeof t.lastDurationMs === 'number')
  const running = boardTasks.filter(t => t.live)

  log(`界面语言：${lang}（期望文案按它取）`)
  log(`真实数据：任务 ${boardTasks.length} 条，已完成且有时长 ${finished.length} 条，正在跑 ${running.length} 条`)
  if (!finished.length) {
    console.error('没有任何"跑完且算得出时长"的真实任务：这个功能的核心分支没得验，先跑一条任务再来')
    process.exit(2)
  }
  // 挑时长最长的那条：它最能验"卡片放不放得下"（20 秒和 3 小时是两截完全不同的字符串）
  const target = finished.slice().sort((a, b) => b.lastDurationMs - a.lastDurationMs)[0]
  log(`断言对象：${target.title || target.id}  用时 ${(target.lastDurationMs / 1000).toFixed(0)}s`)

  // 与运行中的后端对一次账：除了新加的 lastDurationMs，其余字段（列 / 活跃执行数）必须一模一样
  const live = await fetch(`${API}/api/workbench/projects`).then(r => r.json())
  const realById = new Map((live.tasks || []).map(t => [t.id, t]))
  const drift = boardTasks.filter(t => {
    const r = realById.get(t.id)
    return r && (r.column !== t.column || r.runningJobs !== t.runningJobs)
  })
  check('F1 fixture 与运行中后端的看板口径一致（列 / 活跃执行数无漂移）',
    drift.length === 0, drift.length ? `漂移 ${drift.length} 条：${drift.map(t => t.id).join(',')}` : '')

  const tasks = boardTasks.concat(syntheticTasks({ decorate: registry.decorateTaskForBoard, now }))
  const synthDur = tasks.find(t => t.id === 'synth-dur')
  const synthRunning = tasks.find(t => t.id === 'synth-running')
  const synthLegacy = tasks.find(t => t.id === 'synth-legacy')
  const synthVirgin = tasks.find(t => t.id === 'synth-virgin')

  // 前置事实：服务端口径本身对不对（反证注入到真正拍板的那一层，别让 UI 断言替它背锅）
  const targetJob = (byTask.get(target.id) || []).slice().sort(
    (a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')),
  )[0] || {}
  check('F2 服务端：lastDurationMs 就是那条 job 的 endedAt - startedAt',
    target.lastDurationMs === Date.parse(targetJob.endedAt) - Date.parse(targetJob.startedAt),
    `${target.lastDurationMs} vs ${Date.parse(targetJob.endedAt) - Date.parse(targetJob.startedAt)}`)
  check('F3 服务端：正在跑 / 缺 endedAt / 从没跑过一律 null（不拿别的戳凑假时长）',
    synthRunning.lastDurationMs === null && synthLegacy.lastDurationMs === null && synthVirgin.lastDurationMs === null,
    [synthRunning.lastDurationMs, synthLegacy.lastDurationMs, synthVirgin.lastDurationMs].join('/'))

  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox'],
  })
  const page = await (await browser.newContext({ viewport: { width: 2000, height: 1274 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  let shot = null
  try {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('wb.boardView.v1', 'kanban')
        // 必须预置「全部项目」（''）：全新上下文里 savedSelection === null 时，
        // WorkbenchBoard 的 applyDefaultSelection() 会把选中项落到当前项目，
        // 合成任务（synth-dur 等）会被 visibleTasks 全部过滤掉，B/C/D 一起假失败。
        localStorage.setItem('wb.boardProject.v1', '')
      } catch { /* 隐私模式 */ }
    })
    await page.route('**/api/workbench/projects*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, projects: live.projects, tasks, currentProjectPath: live.currentProjectPath }),
      })
    })

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.board', { timeout: 15000 })
    await page.locator('.proj-item--all').first().click()
    await sleep(1200)
    // 固定 sleep 会在这台机器上先于异步数据落 DOM：截图里明明已有「用时」，
    // readCard 却读到 null，后面整串断言假红。等到目标卡片自己的用时行出现，
    // 才是页面上真正渲染完成的那一刻。
    await page.waitForFunction((title) => {
      const card = Array.from(document.querySelectorAll('.kb-card'))
        .find(c => (c.querySelector('.kb-card__title')?.textContent || '').trim() === title)
      return !!card?.querySelector('.kb-card__spent')
    }, target.title, { timeout: 15000 })

/** 按标题找到卡片，读它那行「用时」与首行时间位（DOM ↔ 数据关联不用标题当键会串） */
    const readCard = (title) => page.evaluate((t) => {
      // norm 必须在浏览器上下文里自己有一份：page.evaluate 里的代码被序列化后
      // 送到页面执行，拿不到 Node 侧闭包（2026-09-30 实测 ReferenceError: norm is not defined）
      const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
      const cards = Array.from(document.querySelectorAll('.kb-card'))
      const card = cards.find(c => (c.querySelector('.kb-card__title')?.textContent || '').trim() === t)
      if (!card) return { found: false, titles: cards.map(c => (c.querySelector('.kb-card__title')?.textContent || '').trim()) }
      const time = card.querySelector('.kb-card__time')
      const spent = card.querySelector('.kb-card__spent')
      const liveEl = card.querySelector('.kb-card__live')
      return {
        found: true,
        hasLive: !!liveEl,
        spent: spent ? norm(spent.textContent) : null,
        spentTitle: spent ? spent.getAttribute('title') : null,
        // 那行有没有被 CSS 挤没（宽度为 0 就是在位却看不见）
        spentVisible: spent ? spent.getBoundingClientRect().width > 0 : null,
        // 自身盒子装不下时被裁掉多少（>0 = 尾巴上的信息被 ellipsis 吃掉了）
        spentClipped: spent ? spent.scrollWidth - spent.clientWidth : null,
        // 首行时间位：只有"什么时候的事"这一件事，用时不该挤进去（挤进去会压窄项目色标）
        rowTime: time ? norm(time.textContent) : null,
        timeOverflow: time ? time.scrollWidth - time.clientWidth : null,
        liveText: liveEl ? norm(liveEl.textContent) : '',
      }
    }, title)

    // ── A 真实已完成卡片：用时在那儿，且首行没被它挤变形 ───────────────
    const card = await readCard(target.title)
    if (!card.found) throw new Error(`看板上找不到「${target.title}」这张卡片，实际有：${JSON.stringify(card.titles)}`)
    const wantSpent = expectDuration(target.lastDurationMs, lang)
    check('A1 卡片上显示「用时 x」，与服务端 lastDurationMs 逐字一致',
      card.spent === wantSpent, `${card.spent} ≠ ${wantSpent}`)
    check('A2 首行时间位仍只有相对时间（用时挤进去会把项目色标压窄，见 verify-wb-card-row1 的 C 组）',
      !/用时|took/.test(card.rowTime) && /前|ago|刚刚|Just now/.test(card.rowTime), card.rowTime)
    check('A3 用时那一行没被 CSS 挤没 / 没被裁掉尾巴',
      card.spentVisible === true && card.spentClipped <= 0, `visible=${card.spentVisible} clipped=${card.spentClipped}px`)

    // ── F 悬停提示给出起止两个绝对时刻 ────────────────────────────────
    const clocks = norm(card.spentTitle).match(/\d{1,2}:\d{2}:\d{2}/g) || []
    check('F4 悬停提示里能看到起止两个时刻（"几点到几点"）', clocks.length >= 2, norm(card.spentTitle))

    // ── B 正在跑：不给用时（时长归活动区） ────────────────────────────
    const runningCard = await readCard(synthRunning.title)
    check('B1 正在跑的任务不显示用时（那个时长在活动区的「已运行」里）',
      runningCard.found && !runningCard.spent, runningCard.spent)
    check('B2 它的时长确实还在活动区里（不是被一起去掉了）',
      runningCard.hasLive && /已运行|running|运行中/i.test(runningCard.liveText), runningCard.liveText.slice(0, 40))

    // ── C 推不出时长就不显示 ─────────────────────────────────────────
    const legacyCard = await readCard(synthLegacy.title)
    check('C1 老记录缺 endedAt：不显示用时，也不写"用时 0 秒"',
      legacyCard.found && !legacyCard.spent, legacyCard.spent)
    const virginCard = await readCard(synthVirgin.title)
    check('C2 从没跑过：不显示用时', virginCard.found && !virginCard.spent, virginCard.spent)

    // ── D 渲染形状由合成任务钉死 ─────────────────────────────────────
    const durCard = await readCard(synthDur.title)
    check('D1 20 分整渲染成期望的那一串（格式化改档位 / 换分隔符会立刻红）',
      durCard.spent === expectDuration(20 * 60 * 1000, lang),
      `${durCard.spent} ≠ ${expectDuration(20 * 60 * 1000, lang)}`)
    check('D2 加上用时之后首行时间位没变窄、也没溢出',
      /前|ago|刚刚|Just now/.test(durCard.rowTime) && durCard.timeOverflow <= 0,
      `${durCard.rowTime} overflow=${durCard.timeOverflow}px`)

    // ── 截图存证：把「已完成」列整列拍下来 ────────────────────────────
    shot = path.resolve(__dirname, '../tmp-verify-wb-task-duration.png')
    await page.locator('.kb-col--done').first().screenshot({ path: shot })
    log('截图:', shot)

    // ── E 列表视图：同一行也有，且不换行 ──────────────────────────────
    await page.locator('.kb__view-btn', { hasText: /列表视图|List/ }).first().click()
    await page.waitForSelector('.kb-table__row', { timeout: 10000 })
    await sleep(400)
    const readRow = (title) => page.evaluate((t) => {
      const rows = Array.from(document.querySelectorAll('.kb-table__row'))
      const row = rows.find(r => (r.querySelector('.kb-table__name')?.textContent || '').trim() === t)
      if (!row) return { found: false, titles: rows.map(r => (r.querySelector('.kb-table__name')?.textContent || '').trim()) }
      const cell = row.querySelector('.kb-table__time')
      const dur = row.querySelector('.kb-table__dur')
      const cs = cell ? getComputedStyle(cell) : null
      return {
        found: true,
        dur: dur ? dur.textContent : null,
        whiteSpace: cs ? cs.whiteSpace : null,
        // 换行的话这一格会明显高于单行；量它的高度而不是量 CSS 属性，
        // 属性说的是"要求"，高度才是屏幕上真的发生的事
        lines: cell ? Math.round(cell.getBoundingClientRect().height / parseFloat(cs.lineHeight || '16')) : null,
      }
    }, title)
    const listRow = await readRow(target.title)
    check('E1 列表视图那一行也给出用时（与看板卡片同一口径）',
      listRow.found && norm(listRow.dur) === card.spent, `${norm(listRow.dur)} ≠ ${card.spent}`)
    check('E2 时间格不换行（换行会把这一行顶高，整张表参差不齐）',
      listRow.whiteSpace === 'nowrap' && listRow.lines === 1, `${listRow.whiteSpace} / ${listRow.lines} 行`)

    check('G1 页面无 console / page 错误', consoleErrors.length === 0 && pageErrors.length === 0,
      [...consoleErrors, ...pageErrors].slice(0, 3).join(' | '))
  } finally {
    // 只关自己起的这个浏览器实例（按 CDP，不用 taskkill /IM —— 那会连带关掉用户的浏览器）
    await browser.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n[verify] ${results.length - failed.length}/${results.length} 通过`)
  for (const f of failed) console.log(`  FAIL  ${f.name}  ::  ${f.extra}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify] 异常退出:', err); process.exit(1) })

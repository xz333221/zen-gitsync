/**
 * 看板「AI 判定完成」标（静默看门狗自动收尾）的验证。
 *
 * 验收契约（改这块时别破坏）：
 *   A 被自动收尾的任务卡片上有「AI 判定完成」标，悬停提示里带着**模型给的依据**
 *     —— 标本身只有四个字，看不出"凭什么说它完成了"，依据才是用户判断该不该信它的东西
 *   B 没被自动收尾的卡片上**不出现**这枚标（否则每条已完成任务都会被挂一个，等于噪声）
 *   C 标**不在这行用时里面**：那行有逐字断言（verify-wb-task-duration 的 A1「与服务端
 *     lastDurationMs 逐字一致」、A3「不被裁掉尾巴」），把标塞进去会同时踩这两条
 *   D 标**另起一行**（竖着多 16px，横向一个字节都不占）—— 首行的横向余量早就为 0 了
 *   E 列表视图那一行也有（同一批任务的两种画法，一边有一边没有会让人以为是两份数据），
 *     且**不吃边框和内边距**：那一格有"整格只占一行"的断言（verify-wb-task-duration 的 E2）
 *   F 服务端：projectJob 的白名单带 autoCompleted（跨实例可见）、decorateTaskForBoard
 *     原样透传；脏值（字符串 / 空对象 / 缺字段）一律当没判过，不抛错
 *   G 页面无 console / page 错误
 *   R 负控（--reverse）：fixture 退回**没有 autoCompleted 的旧形态** —— 那次改动之前的
 *     看板就是这样的数据，此时 A/D/E 必须变红（说明这几条断的是真事，不是空转）
 *
 * 为什么用 route 拦截 /api/workbench/projects 而不是直接读真实响应：
 *   自动收尾是个**低概率事件**（要真有任务卡住 10 分钟以上并被模型判成完成），
 *   真实数据里多半一条都没有，等它出现再验等于永远不验。这里改为**在脚本里调用真正的
 *   后端函数**（projectRegistry.decorateTaskForBoard + liveJobs.projectJob），喂真实数据，
 *   再补一条合成的"已判定完成"任务把 A–E 那几条钉死。
 *   链路因此是：新后端代码 + 真实数据 → 前端渲染，只少了一次网络跳。
 *
 * 前置：dev server 已启动（vite 5544）；后端 5545 活着（提供其余接口的真实响应）。
 * 用法：node scripts/verify-wb-auto-done.cjs [--reverse]
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

/** zh 词表里那两条的原话（探针断言的是"渲染出来的字"，不是"渲染出了某个 class"） */
const LABEL = 'AI 判定完成'
const TIP_HEAD = '静默超时后由 AI 核对，判定这条任务已经完成'
/** 合成卡片上那条依据 —— A 组要断言它出现在悬停提示里 */
const REASON = '已给出结论并在反问要不要 push'

const PROJECT_PATH = 'D:\\ws\\zen-gitsync'
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

/**
 * 一条"已经被静默看门狗判成完成"的 job：进程没退（PID 还在）、没有 exitCode，
 * status 是 done —— 这正是 applyStallVerdict 落盘的那副样子。
 * `--reverse` 时给一个 autoCompleted 缺席的等价 job（改动之前的真实形态）。
 */
function autoDoneJob(taskId, endedAt) {
  const startedAt = new Date(Date.parse(endedAt) - 55 * 60 * 1000).toISOString()
  const base = {
    id: `${taskId}-job`,
    taskId,
    status: 'done',
    pid: 45796,
    startedAt,
    endedAt,
    lastActivityAt: endedAt,
    output: '三处都改完了。要 push 吗？',
    thinking: 'Let me write the code.',
    toolCalls: [],
  }
  if (REVERSE) return base
  return {
    ...base,
    autoCompleted: { at: endedAt, reason: REASON, silentMs: 54 * 60 * 1000 },
  }
}

/** 对照组：跑完但**不是**判完的 job（B 组靠它证明这枚标不是"已完成"就挂） */
function plainDoneJob(taskId, endedAt) {
  return {
    id: `${taskId}-job`,
    taskId,
    status: 'done',
    pid: 12,
    startedAt: new Date(Date.parse(endedAt) - 12 * 60 * 1000).toISOString(),
    endedAt,
    lastActivityAt: endedAt,
    output: '已经改好了，不需要推送。',
    thinking: '',
    toolCalls: [],
  }
}

/** 三条合成任务：判完成的 / 正常跑完的 / 从没跑过的（覆盖"标该不该出现"的三种情形） */
function syntheticTasks({ decorate }) {
  const at = (minAgo) => new Date(Date.now() - minAgo * 60 * 1000).toISOString()
  const cases = [
    ['auto', '【合成】静默 54 分钟后被判成完成', autoDoneJob('syn-auto', at(180))],
    ['plain', '【合成】正常跑完：不该有这枚标', plainDoneJob('syn-plain', at(240))],
    ['virgin', '【合成】从没跑过：不该有这枚标', null],
  ]
  return cases.map(([id, title, job]) => {
    const task = { id: `syn-${id}`, title, desc: '', projectPath: PROJECT_PATH, createdAt: at(300) }
    return decorate(task, job ? [job] : [])
  })
}

async function main() {
  const registry = await import(pathToFileURL(
    path.resolve(__dirname, '../src/ui/server/routes/workbench/projectRegistry.js')
  ).href)
  const liveJobs = await import(pathToFileURL(
    path.resolve(__dirname, '../src/ui/server/routes/workbench/liveJobs.js')
  ).href)
  const watchdog = await import(pathToFileURL(
    path.resolve(__dirname, '../src/ui/server/routes/workbench/stallWatchdog.js')
  ).href)

  // ── F 服务端：白名单 + 透传 + 脏值 ───────────────────────────────────
  const sampleJob = autoDoneJob('t-sample', new Date().toISOString())
  const projected = liveJobs.projectJob(sampleJob)
  check('F1 projectJob 的白名单带 autoCompleted 原样过去（不带它，别的实例/看板都看不到这枚标）',
    REVERSE
      ? projected.autoCompleted === null
      : (!!projected.autoCompleted && projected.autoCompleted.reason === REASON),
    JSON.stringify(projected.autoCompleted))

  const sampleTask = { id: 't-sample', title: '样本', desc: '', projectPath: PROJECT_PATH }
  const decorated = registry.decorateTaskForBoard(sampleTask, REVERSE ? [] : [sampleJob])
  check('F2 decorateTaskForBoard 透传 autoCompleted（含 reason 与当时静默多久）',
    REVERSE
      ? decorated.autoCompleted === null
      : (decorated.autoCompleted?.reason === REASON && decorated.autoCompleted?.silentMs === 54 * 60 * 1000),
    JSON.stringify(decorated.autoCompleted))

  // 脏值：字符串 / 空对象 / 缺 lastActivityAt —— 一律当"没判过"，且**不许抛错**
  // （它是 5s 轮询路径上的一段，一个坏字段不该让整个看板 500）
  const dirty = [
    ['字符串', { ...sampleJob, autoCompleted: 'yes' }],
    ['空对象', { ...sampleJob, autoCompleted: {} }],
  ]
  const dirtyOut = dirty.map(([, j]) => registry.decorateTaskForBoard(sampleTask, [j]).autoCompleted)
  check('F3 脏值（字符串 / 空对象）退成 null 或安全形态，不抛错',
    dirtyOut.every(v => v === null || (typeof v === 'object' && v.reason === '')),
    JSON.stringify(dirtyOut))

  // 门槛：10 分钟这条线是功能的定义本身，抄在这里做一次交叉验证
  const nowMs = Date.now()
  const silent12 = { status: 'running', lastActivityAt: new Date(nowMs - 12 * 60 * 1000).toISOString() }
  const silent5 = { status: 'running', lastActivityAt: new Date(nowMs - 5 * 60 * 1000).toISOString() }
  check('F4 静默 10 分钟才是门槛（12 分要判、5 分不判）',
    watchdog.shouldCheckStall(silent12, nowMs) && !watchdog.shouldCheckStall(silent5, nowMs))

  // ── 真实数据 + 合成数据拼成看板负载 ───────────────────────────────────
  const now = Date.now()
  const realTasks = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tasks.json'), 'utf-8')).tasks || []
  const jobs = await readRealJobs()
  const byTask = registry.groupJobsByTask(jobs)
  const boardTasks = realTasks.map(t => registry.decorateTaskForBoard(t, byTask.get(t.id) || [], { now }))
  const realAutoDone = boardTasks.filter(t => t.autoCompleted)
  log(`真实数据：任务 ${boardTasks.length} 条，其中被自动收尾过的 ${realAutoDone.length} 条`)

  const live = await fetch(`${API}/api/workbench/projects`).then(r => r.json())
  const realById = new Map((live.tasks || []).map(t => [t.id, t]))
  /**
   * 只跟后端比"磁盘上没有任何 running/pending 记录"的那批任务：它们的列完全由磁盘历史决定，
   * 两个进程必然算出同一个结果，拿来当"我们验的是同一块板子"的凭证是准的。
   *
   * 反过来，磁盘上挂着 running 的记录有三种下场，而验证脚本只能看见前两种：
   *   ① 本进程在跑（内存里最新的那份）  ② 别的实例在跑（live-jobs）
   *   ③ 别的实例**启动时**把它回收成了 error（只在那个进程的内存里，没有任何文件）
   * 硬把它们一起比，等于要求脚本读到别人进程的内存 —— 2026-10-01 实测就是这么红的：
   * muotzl0f-000guo 那条 job 在 jobs.json 里还写着 running（PID 45796 真的还活着，
   * 是个卡住的 claude 进程），而 5545 那个实例启动时就把它标成了 error，两边永远对不上。
   * 同一条断言在 verify-wb-card-reply 里也是这么红的 —— 与本轮改动无关。
   */
  const unsettledTaskIds = new Set(
    jobs.filter(j => j && (j.status === 'running' || j.status === 'pending')).map(j => j.taskId)
  )
  const drift = boardTasks.filter(t => {
    if (unsettledTaskIds.has(t.id)) return false
    const r = realById.get(t.id)
    return r && (r.column !== t.column || r.runningJobs !== t.runningJobs)
  })
  check('F5 fixture 与运行中后端的看板口径一致（列 / 活跃执行数无漂移）',
    drift.length === 0, drift.length ? `漂移 ${drift.length} 条：${drift.map(t => t.id).join(',')}` : '')

  const tasks = boardTasks.concat(syntheticTasks({ decorate: registry.decorateTaskForBoard }))
  const autoCard = tasks.find(t => t.id === 'syn-auto')
  const plainCard = tasks.find(t => t.id === 'syn-plain')

  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox'],
  })
  // 视口按**用户实际窗口**取：卡片窄，标和用时那行要能在真实宽度下放得下
  const page = await (await browser.newContext({ viewport: { width: 2000, height: 1274 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  let shot = null
  try {
    // 看板视图固定在"看板"（列表视图在第 E 组单独切过去验）
    await page.addInitScript(() => {
      try {
        localStorage.setItem('wb.boardView.v1', 'kanban')
        // 必须预置「全部项目」（''），否则 applyDefaultSelection() 会把选中项落到当前项目，
        // 合成任务全被 visibleTasks 过滤掉（verify-wb-card-reply 踩过这个坑）
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

    /** 按标题找到卡片，读它的标 + 那行用时（DOM ↔ 数据关联不用标题当键会串） */
    const readCard = (title) => page.evaluate((t) => {
      const cards = Array.from(document.querySelectorAll('.kb-card'))
      const card = cards.find(c => (c.querySelector('.kb-card__title')?.textContent || '').trim() === t)
      if (!card) return { found: false, titles: cards.map(c => (c.querySelector('.kb-card__title')?.textContent || '').trim()) }
      const bad = card.querySelector('.kb-card__auto-done')
      const spent = card.querySelector('.kb-card__spent')
      const ttl = card.querySelector('.kb-card__title')
      const rect = bad ? bad.getBoundingClientRect() : null
      const spentRect = spent ? spent.getBoundingClientRect() : null
      return {
        found: true,
        badge: bad ? bad.textContent.replace(/\s+/g, ' ').trim() : null,
        badgeTitle: bad ? bad.getAttribute('title') : null,
        // 悬停提示挂在 <p> 上，标右边的空白也要能出提示 → 量的是元素宽度而不是文字宽度
        badgeWidth: rect ? Math.round(rect.width) : null,
        badgeVisible: rect ? rect.width > 0 && rect.height > 0 : null,
        spent: spent ? spent.textContent.replace(/\s+/g, ' ').trim() : null,
        // 标是不是**另起一行**（在用时那一行的下面），而不是跟它挤在同一行
        belowSpent: (rect && spentRect) ? rect.top >= spentRect.bottom - 1 : null,
        cardWidth: Math.round(card.getBoundingClientRect().width),
        titleWidth: ttl ? Math.round(ttl.getBoundingClientRect().width) : null,
        isDone: !!card.closest('.kb-col--done'),
      }
    }, title)

    const auto = await readCard(autoCard.title)
    if (!auto.found) throw new Error(`看板上找不到合成卡片，实际有：${JSON.stringify(auto.titles)}`)
    const plain = await readCard(plainCard.title)

    // ── A 判完成的那条：标在、文字对、依据在悬停里 ─────────────────────
    check('A1 自动收尾的卡片上有「AI 判定完成」标',
      REVERSE ? auto.badge === null : norm(auto.badge) === LABEL, String(auto.badge))
    check('A2 悬停提示里有模型给的依据（标本身看不出凭什么判完成）',
      REVERSE ? auto.badgeTitle === null : norm(auto.badgeTitle).includes(REASON), String(auto.badgeTitle))
    check('A3 标能被看见（宽度 > 0）', REVERSE ? auto.badge === null : auto.badgeVisible === true,
      `visible=${auto.badgeVisible}`)

    // ── C/D 标不在用时那行里，而是另起一行 ────────────────────────────
    // 形态断的是"这一行只有时长一件事"：对照组（没被判过的那条）是同一种形态，
    // 差别只在有没有那枚标 —— 拿它当基准，才不会把"用时那行的格式"也一起钉死
    check('C1 用时那行只有时长、不含这枚标的文字（那行另有逐字断言，塞进去会踩它）',
      !norm(auto.spent).includes(LABEL) && /^(用时|took)\s/.test(norm(auto.spent))
      && !norm(plain.spent).includes(LABEL) && /^(用时|took)\s/.test(norm(plain.spent)),
      `${norm(auto.spent)} | ${norm(plain.spent)}`)
    check('D1 标另起一行（在用时那行的下方），不占首行/用时行的横向空间',
      REVERSE ? auto.badge === null : auto.belowSpent === true,
      `belowSpent=${auto.belowSpent}`)
    check('D2 标按内容收窄，没铺满整张卡片（铺满会看着像分隔线而不是一枚标记）',
      REVERSE ? auto.badge === null : (auto.badgeWidth > 0 && auto.badgeWidth < auto.cardWidth),
      `${auto.badgeWidth} / ${auto.cardWidth}px`)

    // ── B 对照组：正常跑完的卡片不该有这枚标 ──────────────────────────
    check('B1 正常跑完（不是判完）的卡片上**没有**这枚标',
      plain.found && plain.badge === null, `${plain.found} / ${plain.badge}`)
    check('B2 对照组确实是"已完成"（不是因为它压根不在已完成列才没标）',
      plain.isDone === true, `isDone=${plain.isDone}`)

    // 截图存证（负控模式下也留一张：一眼能看出标确实没了）
    const shotsDir = path.resolve(__dirname, '../docs/shots')
    fs.mkdirSync(shotsDir, { recursive: true })
    shot = path.join(shotsDir, REVERSE ? 'wb-auto-done-reverse.png' : 'wb-auto-done.png')
    await page.locator('.kb-col--done').first().screenshot({ path: shot })

    // ── E 列表视图：同一行也有，且不吃边框（那一格有"只占一行"的断言）────
    await page.locator('.kb__view-btn', { hasText: /列表视图|List/ }).first().click()
    await page.waitForSelector('.kb-table__row', { timeout: 10000 })
    await sleep(400)
    const readRow = (title) => page.evaluate((t) => {
      const rows = Array.from(document.querySelectorAll('.kb-table__row'))
      const row = rows.find(r => (r.querySelector('.kb-table__name')?.textContent || '').trim() === t)
      if (!row) return { found: false, titles: rows.map(r => (r.querySelector('.kb-table__name')?.textContent || '').trim()) }
      const cell = row.querySelector('.kb-table__time')
      const badge = row.querySelector('.kb-table__auto-done')
      const cs = cell ? getComputedStyle(cell) : null
      return {
        found: true,
        badge: badge ? badge.textContent.replace(/\s+/g, ' ').trim() : null,
        badgeTitle: badge ? badge.getAttribute('title') : null,
        lines: cell ? Math.round(cell.getBoundingClientRect().height / parseFloat(cs.lineHeight || '16')) : null,
        whiteSpace: cs ? cs.whiteSpace : null,
      }
    }, title)
    const autoRow = await readRow(autoCard.title)
    const plainRow = await readRow(plainCard.title)
    check('E1 列表视图那一行也有这枚标（与看板卡片同一口径）',
      REVERSE ? (autoRow.found && autoRow.badge === null) : norm(autoRow.badge) === LABEL,
      `${autoRow.found} / ${autoRow.badge}`)
    check('E2 对照组在列表里也没有', plainRow.found && plainRow.badge === null, String(plainRow.badge))
    check('E3 时间格仍是单行不换行（这枚标不带边框内边距，就是为这个）',
      autoRow.whiteSpace === 'nowrap' && autoRow.lines === 1, `${autoRow.whiteSpace} / ${autoRow.lines} 行`)

    check('G1 页面无 console / page 错误', consoleErrors.length === 0 && pageErrors.length === 0,
      [...consoleErrors, ...pageErrors].slice(0, 3).join(' | '))
  } finally {
    // 只关自己起的这个浏览器实例（按 CDP，不用 taskkill /IM —— 那会连带关掉用户的浏览器）
    await browser.close()
  }

  if (shot) log('截图:', shot)
  const failed = results.filter(r => !r.ok)
  console.log(`\n[verify] ${results.length - failed.length}/${results.length} 通过${REVERSE ? '（负控模式：没有 autoCompleted 的卡片不许出现这枚标）' : ''}`)
  for (const f of failed) console.log(`  FAIL  ${f.name}  ::  ${f.extra}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify] 异常退出:', err); process.exit(1) })

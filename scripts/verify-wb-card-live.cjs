/**
 * 看板「进行中」卡片显示任务状态的验证（最近思考 / 工具调用 / 最新回复 / 已运行 / 静默）。
 *
 * 验收契约（改这块时别破坏）：
 *   A 正在跑的任务卡片上有活动区，四行各就各位：元信息（执行器 / 已运行 / 工具 N 次）
 *     → 最近一次工具调用 → 最近思考 → 最新回复；每一行的文字与后端给的事实**逐字一致**
 *   B 没有内容的那一行整行不渲染（思考 / 回复都可能为空）—— 不写"暂无"
 *   C 元信息行在没有任何正文时仍然渲染（刚起来的任务不是空白卡片，至少能看到"已运行 3 秒"）
 *   D 服务端判定"显然静默"时给出静默时长，并用告警色（这是卡片上唯一"可能卡住了"的信号）
 *   E 没在跑的任务（待处理 / 已完成）卡片不出现活动区 —— 它不是"永远存在的一块区域"
 *
 * 为什么用 route 拦截 /api/workbench/projects 而不是直接读真实响应：
 *   运行中的后端可能是旧进程（本仓库的后端由 nodemon / g ui 启动，改完代码不一定重启），
 *   拿它验证等于在验旧代码。这里改为**在脚本里调用真正的后端函数**
 *   （projectRegistry.decorateTaskForBoard + jobActivity.pickLiveActivity），
 *   喂**真实数据**（~/.zen-gitsync 的 tasks.json / jobs.json / live-jobs/*.json，
 *   含此刻正在跑的那个 job），再把结果从 HTTP 那一段接过去。
 *   于是链路是：新后端代码 + 真实数据 → 前端渲染，只少了一次网络跳。
 *   另外补两条合成任务，覆盖真实数据里不一定存在的分支（静默 / 只有元信息）。
 *
 * 前置：dev server 已启动（vite 5544）；后端 5545 活着（提供其余接口的真实响应）。
 * 用法：node scripts/verify-wb-card-live.cjs
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
 * 读执行记录：历史档案（jobs.json）∪ 各实例正在跑的（live-jobs/*.json），**同 id 时 live 赢**
 * —— 这就是后端 mergedJobs 的口径（内存 > live > 磁盘；本脚本没有"本进程自己跑的 job"，
 * 所以只剩 live > 磁盘这一条）。
 *
 * 为什么不直接 import jobStore 用它的 mergedJobs：那个模块 import 时就会
 * fire-and-forget 跑 hydrateJobs()，把磁盘上"上一次留下的 running 记录"在内存里标成
 * error（生产环境里那个假设是对的：进程刚起来，磁盘上的 running 一定是上一轮遗留的）。
 * 而验证脚本恰恰要在**别的进程正在跑**的时候读同一批数据，于是那条外来的活记录会被
 * 内存里这份 error 副本盖掉，看板算出来"没有任务在跑"——正是本脚本要验的东西。
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

/** 合成任务：覆盖真实数据里不一定出现的分支（静默 / 只有元信息 / 没在跑） */
function syntheticTasks({ decorate, pickLive, now }) {
  const startedAt = new Date(now - 7 * 60 * 1000).toISOString()
  const silentJob = {
    id: 'synth-silent-job', taskId: 'synth-silent', status: 'running', agent: 'claude',
    startedAt, lastActivityAt: new Date(now - 4 * 60 * 1000).toISOString(),
    thinking: '改了三个文件，下一步该跑测试了',
    output: '已经把事件监听的泄漏补上',
    toolCalls: [{ name: 'Edit', argsPreview: 'src/ui/server/routes/workbench/index.js' }],
  }
  const bareJob = {
    id: 'synth-bare-job', taskId: 'synth-bare', status: 'running', agent: 'claude', startedAt,
  }
  const mk = (id, title, job) => {
    const card = decorate({ id, title, desc: '', projectPath: 'D:\\ws\\zen-gitsync', createdAt: startedAt }, job ? [job] : [])
    return { ...card, _synthetic: true }
  }
  return [
    mk('synth-silent', '【合成】静默分支：四行齐全 + 静默告警', silentJob),
    mk('synth-bare', '【合成】只有元信息：刚起来还没吐字', bareJob),
    mk('synth-idle', '【合成】没在跑的任务不该有活动区', null),
  ]
  // 注：pickLive 由 decorate 内部调用（decorateTaskForBoard 的 live 字段），
  // 这里单独传进来只是为了让依赖一眼可见
}

async function main() {
  const registry = await import(pathToFileURL(
    path.resolve(__dirname, '../src/ui/server/routes/workbench/projectRegistry.js')
  ).href)
  const activity = await import(pathToFileURL(
    path.resolve(__dirname, '../src/ui/server/routes/workbench/jobActivity.js')
  ).href)

  const now = Date.now()
  const realTasks = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tasks.json'), 'utf-8')).tasks || []
  const jobs = await readRealJobs()
  const byTask = registry.groupJobsByTask(jobs)
  const boardTasks = realTasks.map(t => registry.decorateTaskForBoard(t, byTask.get(t.id) || [], { now }))
  const running = boardTasks.filter(t => t.live)

  log(`真实数据：任务 ${boardTasks.length} 条，正在跑 ${running.length} 条`)
  for (const t of running) {
    log(`  · ${t.title || t.id} | 工具 ${t.live.toolCallCount} 次 | 思考 ${JSON.stringify(t.live.lastThought.slice(0, 40))}`)
  }
  if (!running.length) {
    console.error('此刻没有任何正在跑的任务：这张卡片的核心分支没得验，等有任务在跑再跑本脚本')
    process.exit(2)
  }

  // 与运行中的后端对一次账：除了新加的 live，其余字段（列 / 活跃执行数）必须一模一样，
  // 否则说明我这份 fixture 和真实看板不是同一块板子，后面的断言就没有意义了
  const live = await fetch(`${API}/api/workbench/projects`).then(r => r.json())
  const realById = new Map((live.tasks || []).map(t => [t.id, t]))
  const drift = boardTasks.filter(t => {
    const r = realById.get(t.id)
    return r && (r.column !== t.column || r.runningJobs !== t.runningJobs)
  })
  check('F1 fixture 与运行中后端的看板口径一致（列 / 活跃执行数无漂移）',
    drift.length === 0, drift.length ? `漂移 ${drift.length} 条：${drift.map(t => t.id).join(',')}` : '')

  const tasks = boardTasks.concat(syntheticTasks({ decorate: registry.decorateTaskForBoard, pickLive: activity.pickLiveActivity, now }))
  const target = running[0]                      // 真实的那条：断言"新后端给的事实 → DOM"
  const silent = tasks.find(t => t.id === 'synth-silent')
  const bare = tasks.find(t => t.id === 'synth-bare')
  const idle = tasks.find(t => t.id === 'synth-idle')

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
    // 看板视图固定在"看板"（列表视图是另一套渲染，本脚本不覆盖）
    await page.addInitScript(() => {
      try { localStorage.setItem('wb.boardView.v1', 'kanban') } catch { /* 隐私模式 */ }
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

    /** 按标题找到卡片，读它的活动区（DOM ↔ 数据关联不用标题当键会串，这里标题独一无二） */
    const readCard = (title) => page.evaluate((t) => {
      const cards = Array.from(document.querySelectorAll('.kb-card'))
      const card = cards.find(c => (c.querySelector('.kb-card__title')?.textContent || '').trim() === t)
      if (!card) return { found: false, titles: cards.map(c => (c.querySelector('.kb-card__title')?.textContent || '').trim()) }
      const live = card.querySelector('.kb-card__live')
      const lines = Array.from(card.querySelectorAll('.kb-card__live-line'))
      const silentEl = card.querySelector('.kb-card__live-silent')
      return {
        found: true,
        running: card.classList.contains('is-running'),
        hasLive: !!live,
        meta: live ? live.querySelector('.kb-card__live-meta').textContent : null,
        lines: lines.map(el => ({
          tool: el.classList.contains('is-tool'),
          thought: el.classList.contains('is-thought'),
          tag: el.querySelector('.kb-card__live-tag')?.textContent || '',
          text: el.textContent,
        })),
        silent: silentEl ? silentEl.textContent : null,
        silentColor: silentEl ? getComputedStyle(silentEl).color : null,
      }
    }, title)

    const card = await readCard(target.title)
    if (!card.found) throw new Error(`看板上找不到「${target.title}」这张卡片，实际有：${JSON.stringify(card.titles)}`)
    log('真实运行中卡片:', JSON.stringify(card))

    // ── A 四行齐全，内容与后端事实逐字一致 ────────────────────────────
    check('A1 运行中的卡片有活动区', card.hasLive && card.running)
    check('A2 元信息行含「已运行 N」与执行器',
      norm(card.meta).includes(norm(target.live.agent)) && /已运行|Running for/.test(card.meta), norm(card.meta))
    check('A3 元信息行的工具次数与后端一致',
      !target.live.toolCallCount || norm(card.meta).includes(`${target.live.toolCallCount}`), norm(card.meta))

    const toolLine = card.lines.find(l => l.tool)
    const thoughtLine = card.lines.find(l => l.thought)
    const replyLine = card.lines.find(l => !l.tool && !l.thought)
    if (target.live.lastTool) {
      check('A4 最近一次工具调用逐字一致', norm(toolLine && toolLine.text) === norm(target.live.lastTool),
        `${norm(toolLine && toolLine.text)} ≠ ${target.live.lastTool}`)
    } else check('A4 没有工具调用时该行不渲染', !toolLine)
    if (target.live.lastThought) {
      check('A5 最近思考逐字一致（带「思考」标签）',
        !!thoughtLine && /^(思考|Thinking)$/.test(norm(thoughtLine.tag))
        && norm(thoughtLine.text).endsWith(norm(target.live.lastThought)),
        `${norm(thoughtLine && thoughtLine.text)} ≠ …${target.live.lastThought}`)
    } else check('A5 没有思考时该行不渲染', !thoughtLine)
    if (target.live.lastLine) {
      check('A6 最新回复逐字一致（带「回复」标签）',
        !!replyLine && /^(回复|Reply)$/.test(norm(replyLine.tag))
        && norm(replyLine.text).endsWith(norm(target.live.lastLine)),
        `${norm(replyLine && replyLine.text)} ≠ …${target.live.lastLine}`)
    } else check('A6 没有正文时该行不渲染', !replyLine)

    // ── C 只有元信息的任务：不是空白，也不是"暂无" ──────────────────
    const bareCard = await readCard(bare.title)
    check('C1 刚起来（无工具/思考/正文）的卡片仍有元信息行',
      bareCard.hasLive && /已运行|Running for/.test(bareCard.meta || ''), norm(bareCard.meta))
    check('C2 它没有多余的空行（不写"暂无"）', bareCard.lines.length === 0, `lines=${bareCard.lines.length}`)
    check('C3 已运行时长从 0 起算（不是空白也不是负数）', /0 秒|0s|1 秒|1s/.test(norm(bareCard.meta)), norm(bareCard.meta))

    // ── D 静默：给出时长 + 告警色 ───────────────────────────────────
    const silentCard = await readCard(silent.title)
    check('D1 显然静默时给出静默时长', /静默|Silent for/.test(norm(silentCard.silent)),
      norm(silentCard.silent))
    const warn = await page.evaluate(() => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--color-warning)'
      document.body.appendChild(probe)
      const c = getComputedStyle(probe).color
      probe.remove()
      return c
    })
    check('D2 静默用告警色', silentCard.silentColor === warn, `${silentCard.silentColor} vs ${warn}`)
    check('D3 合成任务四行齐全（工具 / 思考 / 回复）',
      silentCard.lines.length >= 3, `lines=${silentCard.lines.length}`)

    // ── E 没在跑的任务没有活动区 ────────────────────────────────────
    const idleCard = await readCard(idle.title)
    check('E1 没在跑的任务卡片不出现活动区', idleCard.found && !idleCard.hasLive && !idleCard.running)

    // ── 截图存证：把「进行中」列整列拍下来 ──────────────────────────
    const col = page.locator('.kb-col--doing').first()
    shot = path.resolve(__dirname, '../tmp-verify-wb-card-live.png')
    await col.screenshot({ path: shot })
    log('截图:', shot)

    check('F2 页面无 console / page 错误', consoleErrors.length === 0 && pageErrors.length === 0,
      [...consoleErrors, ...pageErrors].slice(0, 3).join(' | '))
  } finally {
    // 只关自己起的这个浏览器实例（按 CDP，不用 taskkill /IM —— 那会连带关掉用户的浏览器）
    await browser.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n[verify] ${results.length - failed.length}/${results.length} 通过`)
  for (const f of failed) console.log(`  FAIL  ${f.name}  :: ${f.extra}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify] 异常退出:', err); process.exit(1) })

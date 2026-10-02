/**
 * 看板「已完成」卡片显示 AI 最后回复的验证。
 *
 * 验收契约（改这块时别破坏）：
 *   A 跑完的任务卡片上有「最后回复」段落，文字与服务端 lastReply 逐字一致，且**结尾那句在**
 *     —— 这段摘录取的是尾部，模型收尾时那句「要 push 吗？」被截掉的话这功能就白做了
 *   B 与 live 互斥：有 job 在跑的任务只显示活动区，不出现「最后回复」（否则同一张卡片上
 *     会有两段相似但不同时刻的话）
 *   C 没有正文的任务（从没跑过 / 那次没写正文）不出现该段落 —— 不写"暂无"、也不拿旧话顶
 *   D `…` 只在**真被截断**时出现（它是"这句话从中间开始"的标记，没截就不该标）
 *   E 卡片上没有 markdown 标记（`**` / 反引号 / 表格竖线）—— 卡片没有富文本，留着没法读
 *   F 引用样式：左侧竖线 + 次亮色，与标题（正文色）区分得开；hover 时右下角的操作组浮出，
 *     摘录**只把最后一行**渐隐（按钮只压着最后一行，几何由 verify-wb-card-fade-band 量）
 *   G 列表视图同一行也有（同一批任务的两种画法，一边有一边没有会让人以为是两份数据）
 *   H 页面无 console / page 错误
 * F1–F3 是前置事实而不是 UI 契约：F1 fixture 与运行中后端口径无漂移（否则后面的断言
 * 验的不是同一块板子）、F2/F3 服务端预处理（截断加 `…` / 没截不加）。
 *
 * 为什么用 route 拦截 /api/workbench/projects 而不是直接读真实响应：
 *   运行中的后端可能是旧进程（本仓库的后端由 nodemon / g ui 启动，改完代码不一定重启），
 *   拿它验证等于在验旧代码。这里改为**在脚本里调用真正的后端函数**
 *   （projectRegistry.decorateTaskForBoard），喂**真实数据**（~/.zen-gitsync 的
 *   tasks.json / jobs.json / live-jobs/*.json），再把结果从 HTTP 那一段接过去。
 *   于是链路是：新后端代码 + 真实数据 → 前端渲染，只少了一次网络跳。
 *   另外补几条合成任务，覆盖真实数据里不一定存在的分支（没写正文 / 超长被截断 / 正在跑）。
 *
 * 前置：dev server 已启动（vite 5544）；后端 5545 活着（提供其余接口的真实响应）。
 * 用法：node scripts/verify-wb-card-reply.cjs
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

/** 合成任务：覆盖真实数据里不一定出现的分支（没写正文 / 超长被截断 / 正在跑 / 从没跑过） */
function syntheticTasks({ decorate, now }) {
  const at = (minAgo) => new Date(now - minAgo * 60 * 1000).toISOString()
  const done = (id, output) => ({
    id: `synth-${id}-job`, taskId: `synth-${id}`, subId: `synth-${id}__j`, title: '',
    status: 'done', startedAt: at(30), endedAt: at(20), output,
  })
  const running = {
    id: 'synth-running-job', taskId: 'synth-running', subId: 'synth-running__j', title: '',
    status: 'running', startedAt: at(2), lastActivityAt: at(1),
    output: '这一轮刚开始，我先看一眼现状',
  }
  const long = `${'前情提要：'.repeat(40)}收尾那句：要 push 吗？`
  const cases = [
    ['long', '【合成】超长回复：截断但要留住结尾那句', done('long', long)],
    ['short', '【合成】短回复：不该出现省略号', done('short', '已经改好了，不需要推送。')],
    ['silent', '【合成】跑完但没写正文：不该有这一段', done('silent', '')],
    ['running', '【合成】正在跑：只显示活动区', running],
    ['virgin', '【合成】从没跑过：不该有这一段', null],
  ]
  return cases.map(([id, title, job]) => {
    const card = decorate({ id: `synth-${id}`, title, desc: '', projectPath: 'D:\\ws\\zen-gitsync', createdAt: at(40) }, job ? [job] : [])
    return { ...card, _synthetic: true }
  })
}

async function main() {
  const registry = await import(pathToFileURL(
    path.resolve(__dirname, '../src/ui/server/routes/workbench/projectRegistry.js')
  ).href)

  const now = Date.now()
  const realTasks = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tasks.json'), 'utf-8')).tasks || []
  const jobs = await readRealJobs()
  const byTask = registry.groupJobsByTask(jobs)
  const boardTasks = realTasks.map(t => registry.decorateTaskForBoard(t, byTask.get(t.id) || [], { now }))
  const finished = boardTasks.filter(t => !t.live && t.lastReply)

  log(`真实数据：任务 ${boardTasks.length} 条，跑完且写了正文 ${finished.length} 条`)
  if (!finished.length) {
    console.error('没有任何"跑完并写了正文"的真实任务：这段摘录的核心分支没得验，先跑一条任务再来')
    process.exit(2)
  }
  // 挑一条真实任务作断言对象：优先**结尾是提问**的那条 —— 这正是这个功能要解决的问题
  const target = finished.find(t => /[?？]$/.test(t.lastReply)) || finished[0]
  const targetJob = byTask.get(target.id).find(j => j && j.output) || {}
  log(`断言对象：${target.title || target.id}`)
  log(`  服务端给的最后回复：${target.lastReply}`)

  // 与运行中的后端对一次账：除了新加的 lastReply，其余字段（列 / 活跃执行数）必须一模一样，
  // 否则说明我这份 fixture 和真实看板不是同一块板子，后面的断言就没有意义了
  const live = await fetch(`${API}/api/workbench/projects`).then(r => r.json())
  const realById = new Map((live.tasks || []).map(t => [t.id, t]))
  const drift = boardTasks.filter(t => {
    const r = realById.get(t.id)
    return r && (r.column !== t.column || r.runningJobs !== t.runningJobs)
  })
  check('F1 fixture 与运行中后端的看板口径一致（列 / 活跃执行数无漂移）',
    drift.length === 0, drift.length ? `漂移 ${drift.length} 条：${drift.map(t => t.id).join(',')}` : '')

  const tasks = boardTasks.concat(syntheticTasks({ decorate: registry.decorateTaskForBoard, now }))
  const long = tasks.find(t => t.id === 'synth-long')
  const short = tasks.find(t => t.id === 'synth-short')
  const silent = tasks.find(t => t.id === 'synth-silent')
  const runningSynth = tasks.find(t => t.id === 'synth-running')
  const virgin = tasks.find(t => t.id === 'synth-virgin')

  // 前端拿到的必须是服务端算好的那段（两侧同源，这里先把期望值记下来）
  check('F2 服务端：超长输出的摘录以 … 开头且留住结尾那句',
    long.lastReply.startsWith('…') && long.lastReply.endsWith('要 push 吗？'), long.lastReply)
  check('F3 服务端：短输出的摘录不加 …（没截就不标）',
    short.lastReply === '已经改好了，不需要推送。', short.lastReply)

  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox'],
  })
  // 视口按**用户实际窗口**取（2000×1274）：MAX_REPLY_CHARS = 100 这个数就是按它推出来的
  // （卡片宽 → 每行多少字 → 3 行放得下多少字）。换个更窄的视口跑，A6 那条"整段可见"
  // 会假失败，而它验的其实是"这个数选得对不对"，不是"任意宽度都不截断"。
  const page = await (await browser.newContext({ viewport: { width: 2000, height: 1274 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  let shot = null
  try {
    // 看板视图固定在"看板"（列表视图在第 G 组单独切过去验）
    await page.addInitScript(() => {
      try {
        localStorage.setItem('wb.boardView.v1', 'kanban')
        // 必须预置「全部项目」（''）。全新上下文里 savedSelection === null 时，
        // WorkbenchBoard 的 applyDefaultSelection() 会把选中项落到**当前项目**；
        // 它烧的是 mock 的 projects 接口 —— 返回得比那次点击晚，就会把「全部项目」
        // 顶掉，合成任务（synth-running 等）全被 visibleTasks 过滤掉，
        // B1/D1/D2/D4/G2 一起假失败（2026-09-29 实测同一个脚本两次跑出 21/23 与 17/23）。
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

    /** 按标题找到卡片，读它的「最后回复」段落（DOM ↔ 数据关联不用标题当键会串） */
    const readCard = (title) => page.evaluate((t) => {
      const cards = Array.from(document.querySelectorAll('.kb-card'))
      const card = cards.find(c => (c.querySelector('.kb-card__title')?.textContent || '').trim() === t)
      if (!card) return { found: false, titles: cards.map(c => (c.querySelector('.kb-card__title')?.textContent || '').trim()) }
      const reply = card.querySelector('.kb-card__reply')
      // 截行的活儿在**正文 span** 上，不在引文容器上：引文是 flex 行（图标 + 正文），
      // 而 -webkit-line-clamp 要的 display:-webkit-box 与 flex 互斥，所以 clamp 只能落在
      // .kb-card__reply-text 上（见 WorkbenchKanban.vue 的样式注释）。读容器会恒得
      // webkitLineClamp: 'none' —— 2026-09-29 引文拆成「图标 + 正文」之后本探针没跟着改，
      // A5 一直红着（拿 DOM 复核过：容器 flex / 正文 -webkit-box + clamp 3）。
      const replyText = card.querySelector('.kb-card__reply-text')
      const titleEl = card.querySelector('.kb-card__title')
      return {
        found: true,
        running: card.classList.contains('is-running'),
        hasLive: !!card.querySelector('.kb-card__live'),
        reply: reply ? reply.textContent : null,
        title2: reply ? reply.getAttribute('title') : null,
        borderLeft: reply ? getComputedStyle(reply).borderLeftWidth : null,
        color: reply ? getComputedStyle(reply).color : null,
        titleColor: titleEl ? getComputedStyle(titleEl).color : null,
        clamp: replyText ? getComputedStyle(replyText).webkitLineClamp : null,
        // 被 CSS 截掉多少（0 = 整段都看得见）。卡片宽、字号、行数三者一变这个就会变，
        // 所以它验的是"MAX_REPLY_CHARS 这个数是不是按这块地方定的"。
        // 同样必须量 clamp 所在的正文 span：量外层 flex 容器的话，子元素自己 overflow:hidden
        // 把高度收住了，容器永远不溢出 → 恒 0，等于一条测不出东西的断言。
        overflowPx: replyText ? replyText.scrollHeight - replyText.clientHeight : null,
      }
    }, title)

    // ── A 真实已完成任务：段落在了，文字与后端事实逐字一致 ──────────────
    const card = await readCard(target.title)
    if (!card.found) throw new Error(`看板上找不到「${target.title}」这张卡片，实际有：${JSON.stringify(card.titles)}`)
    log('真实已完成卡片:', JSON.stringify(card))

    check('A1 跑完的任务卡片上有「最后回复」', !!card.reply, norm(card.reply).slice(0, 60))
    check('A2 文字与服务端 lastReply 逐字一致',
      norm(card.reply) === norm(target.lastReply), `${norm(card.reply)} ≠ ${norm(target.lastReply)}`)
    // "取的是尾部"这件事只有拿原始输出对才有意义：结尾那句必须原样出现在卡片上。
    // 期望值同样要去掉 `**` / 反引号 —— 服务端摘录时就会去掉（E1 那条契约），
    // 不比这一下的话，一条带行内代码的回复会让这条断言假失败。
    const lastSentence = norm(String(targetJob.output || '').split('\n').filter(l => l.trim()).pop() || '')
      .replace(/\*\*|`/g, '')
    check('A3 结尾那句在卡片上（摘录取的是尾部）',
      !lastSentence || norm(card.reply).endsWith(lastSentence.slice(-24)),
      `卡片尾：…${norm(card.reply).slice(-30)} / 原文尾：${lastSentence.slice(-30)}`)
    check('A4 悬停提示是完整摘录（卡片上被 CSS 截断时还能看全）',
      norm(card.title2) === norm(target.lastReply), norm(card.title2).slice(0, 40))
    check('A5 截到 3 行以内（卡片小，不能长成一块正文）', card.clamp === '3', String(card.clamp))

    // ── B 与 live 互斥 ────────────────────────────────────────────────
    const runningCard = await readCard(runningSynth.title)
    check('B1 正在跑的任务显示活动区', runningCard.hasLive && runningCard.running)
    check('B2 它不同时显示「最后回复」（两段相似的话会让人以为是两条消息）',
      !runningCard.reply, norm(runningCard.reply))

    // ── C 没有正文的任务不出现这一段 ──────────────────────────────────
    const silentCard = await readCard(silent.title)
    check('C1 跑完但没写正文：不出现这一段，也不写"暂无"',
      !silentCard.reply, norm(silentCard.reply))
    const virginCard = await readCard(virgin.title)
    check('C2 从没跑过：不出现这一段', !virginCard.reply, norm(virginCard.reply))

    // ── D `…` 只在真截断时出现 ───────────────────────────────────────
    const longCard = await readCard(long.title)
    check('D1 超长回复被截断且留住结尾那句',
      norm(longCard.reply).startsWith('…') && norm(longCard.reply).endsWith('要 push 吗？'),
      norm(longCard.reply).slice(0, 30) + ' … ' + norm(longCard.reply).slice(-20))
    check('D2 截断后的长度就是服务端给的长度（前端不二次加工）',
      norm(longCard.reply) === norm(long.lastReply), `${norm(longCard.reply).length} vs ${norm(long.lastReply).length}`)
    const shortCard = await readCard(short.title)
    check('D3 没截断的回复不带 …', !norm(shortCard.reply).startsWith('…'), norm(shortCard.reply))
    // 卡片上放得下多少字，决定了服务端该给多少字（MAX_REPLY_CHARS 是倒推出来的）。
    // 最坏情况是正好给满 100 字的合成任务：它在**本机窗口宽度**下必须整段可见 ——
    // 一旦这里溢出，说明那个数大于卡片容量，尾部那句反问就又会被 CSS 吃掉。
    check('D4 在本机窗口宽度（2000px）下整段可见，没被 CSS 再截一刀',
      longCard.overflowPx === 0 && card.overflowPx === 0,
      `合成 ${longCard.overflowPx}px / 真实 ${card.overflowPx}px`)

    // ── E 卡片上没有 markdown 标记 ────────────────────────────────────
    check('E1 摘录里没有 `**` / 反引号 / 表格竖线（卡片渲染不了富文本）',
      !/\*\*|`|\|/.test(norm(card.reply) + norm(longCard.reply)), norm(card.reply).slice(0, 60))

    // ── F 引用样式：竖线 + 次亮色，与标题区分 ─────────────────────────
    const probe = await page.evaluate(() => {
      const mk = (v) => {
        const el = document.createElement('span')
        el.style.color = v
        document.body.appendChild(el)
        const c = getComputedStyle(el).color
        el.remove()
        return c
      }
      return { secondary: mk('var(--text-secondary)'), primary: mk('var(--text-primary)') }
    })
    check('F4 左侧有引用竖线（与活动区里"思考"那行同一记号）', card.borderLeft === '2px', String(card.borderLeft))
    check('F5 用次亮色而不是标题那档正文色', card.color === probe.secondary && card.color !== probe.primary,
      `${card.color} vs secondary ${probe.secondary} / primary ${probe.primary}`)

    // 悬停时才出现的「执行 / ×」是绝对定位在右下角的，而这段摘录正是卡片最后一块 ——
    // 少了渐隐，按钮会直接压在字上。（看板原有的 mask 规则只认活动区的最后一个孩子，
    // 这里新加的元素必须一起进那条规则。）
    // 注意：「点开过的那张卡片取消 hover」（.kb-card.is-opened，2026-09-30）不影响这条断言 ——
    // 本脚本全程不点卡片，所以断言对象一定处于 hover 态。那条契约由 verify-wb-card-opened 验。
    const box = await page.evaluate((t) => {
      const cards = Array.from(document.querySelectorAll('.kb-card'))
      const el = cards.find(c => (c.querySelector('.kb-card__title')?.textContent || '').trim() === t)
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }, target.title)
    await page.mouse.move(box.x, box.y)
    await sleep(350)
    const hovered = await page.evaluate((t) => {
      const cards = Array.from(document.querySelectorAll('.kb-card'))
      const el = cards.find(c => (c.querySelector('.kb-card__title')?.textContent || '').trim() === t)
      const reply = el.querySelector('.kb-card__reply')
      const actions = el.querySelector('.kb-card__actions')
      const cs = getComputedStyle(reply)
      const mask = cs.maskImage || cs.webkitMaskImage
      return {
        mask, actions: getComputedStyle(actions).opacity,
        composite: cs.maskComposite || cs.webkitMaskComposite,
        layers: (mask.match(/linear-gradient\(/g) || []).length,
      }
    }, target.title)
    check('F6 悬停时操作组浮出，且摘录在它底下渐隐（按钮不压在字上）',
      hovered.actions === '1' && /gradient/.test(hovered.mask || ''),
      `actions=${hovered.actions} mask=${String(hovered.mask).slice(0, 40)}`)
    // F7 摘录能到 3 行，而操作组只压着最后一行 —— 遮罩因此必须**同时**带一层
    // 「条带之外一律不透明」的纵向层（--kb-mask-outside-band），两层按 add 合成：
    // 只剩一层横向渐隐时，每一行的右端都会被洗掉，右上角空出一大块
    // （2026-10-02 用户报的那条）。渐隐带的具体几何、以及"倒数第二行右端确实还有墨"
    // 由 verify-wb-card-fade-band 验（真实数据里这张卡未必折到 3 行，这里只钉住结构）。
    check('F7 摘录的遮罩是「横向渐隐 + 带外不透明」两层，且按 add 合成（只有最后一行渐隐）',
      hovered.layers === 2 && /^add/.test(hovered.composite || ''),
      `layers=${hovered.layers} composite=${hovered.composite}`)

    // ── 截图存证：把「已完成」列整列拍下来 ────────────────────────────
    const col = page.locator('.kb-col--done').first()
    shot = path.resolve(__dirname, '../tmp-verify-wb-card-reply.png')
    await col.screenshot({ path: shot })
    log('截图:', shot)

    // ── G 列表视图：同一行也有 ────────────────────────────────────────
    await page.locator('.kb__view-btn', { hasText: /列表视图|List/ }).first().click()
    await page.waitForSelector('.kb-table__row', { timeout: 10000 })
    await sleep(400)
    const readRow = (title) => page.evaluate((t) => {
      const rows = Array.from(document.querySelectorAll('.kb-table__row'))
      const row = rows.find(r => (r.querySelector('.kb-table__name')?.textContent || '').trim() === t)
      if (!row) return { found: false, titles: rows.map(r => (r.querySelector('.kb-table__name')?.textContent || '').trim()) }
      const reply = row.querySelector('.kb-table__live--reply')
      return { found: true, hasLive: !!row.querySelector('.kb-table__live:not(.kb-table__live--reply)'), reply: reply ? reply.textContent : null }
    }, title)
    const listRow = await readRow(target.title)
    check('G1 列表视图那一行也给出最后回复',
      listRow.found && norm(listRow.reply) === norm(target.lastReply), norm(listRow.reply).slice(0, 60))
    const listRunning = await readRow(runningSynth.title)
    check('G2 列表视图里正在跑的那条仍走活动摘要（不与回复行重复）',
      listRunning.hasLive && !listRunning.reply)

    check('H1 页面无 console / page 错误', consoleErrors.length === 0 && pageErrors.length === 0,
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

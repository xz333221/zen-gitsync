/**
 * 看板卡片标出「这条是哪个执行器跑的」的验证。
 *
 * 为什么要有这个：执行器从 1 个变成 3 个（claude / opencode / codex）之后，
 * 卡片上「已运行 6 分 48 秒 · 工具 52 次」只说了"跑了多久"，没说"谁在跑"。
 * 用户看板上同时挂着 Claude、Codex 跑的任务时，分不清哪张是哪张。
 *
 * 验收契约（改这块时别破坏）：
 *   A 正在跑的任务：活动区那一行有品牌图标，src 指向**这个执行器自己的**图
 *     （不是随便一张 —— 三个执行器三个图标，画错比不画更糟）
 *   B 跑完的任务：图标挂在「最后回复」引文的开头（那句收尾的话是它说的）
 *   C 认不出执行器时不画图标 —— 老记录没写 agent 字段，以及写了不等于瞎猜一个品牌
 *   D 从没跑过的任务：卡片上一个图标都没有
 *   E 列表视图同一行也有（同一批任务的两种画法，一边有一边没有会让人以为是两份数据）
 *   F 图标尺寸与文字同量级（12px，不是糊成一团也不是抢戏），且不描边
 *   G 悬停提示是产品名（Claude Code / OpenCode / Codex），鼠标停上去能认清是哪个
 *   H 页面无 console / page 错误
 * F1–F3 是前置事实而不是 UI 契约：F1 fixture 与运行中后端的看板口径无漂移、
 * F2/F3 服务端（decorateTaskForBoard）给出的执行器字段本身是对的。
 *
 * 为什么用 route 拦截 /api/workbench/projects 而不是直接读真实响应：
 *   运行中的后端可能是旧进程（本仓库后端由 nodemon / g ui 启动，改完代码不一定重启），
 *   拿它验证等于在验旧代码。这里改为**在脚本里调用真正的后端函数**
 *   （projectRegistry.decorateTaskForBoard），喂**真实数据**（~/.zen-gitsync 的
 *   tasks.json / jobs.json / live-jobs/*.json），再把结果从 HTTP 那一段接过去。
 *   于是链路是：新后端代码 + 真实数据 → 前端渲染，只少了一次网络跳。
 *   另外补几条合成任务，覆盖真实数据里不一定存在的分支
 *   （三个执行器各一条 / 认不出 / 从没跑过）。
 *
 * 前置：dev server 已启动（vite 5544）；后端 5545 活着（提供其余接口的真实响应）。
 * 用法：node scripts/verify-wb-card-executor-icon.cjs
 * 退出码：0 全通过，1 有失败项，2 前置数据不足。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544'
const API = process.env.ZEN_API || 'http://127.0.0.1:5545'
const DATA_DIR = path.join(os.homedir(), '.zen-gitsync')
const CHROME = process.env.ZEN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'

/**
 * 图标内容 → 指纹前的归一。
 *
 * 为什么不认 src 里的文件名：vite 把小 SVG 内联成 data URL（`data:image/svg+xml,%3csvg...`），
 * 文件名根本不在 src 里，拿名字匹配等于永远匹配不上（第一版就是这么假失败的）。
 * 也不能拿 data URL 里的 `<svg t='...'>` 时间戳当指纹：那是文件 mtime，
 * 换个 checkout / 重新 clone 就变了。
 *
 * 为什么要归一引号：vite 内联时会**把属性上的双引号改写成单引号**（data URL 里落在
 * `%27`），所以直接对文件字节做 hash 和浏览器里的对不上（第二版就是这么假失败的）。
 * 归一之后两侧一致，灵敏度仍然够：改图形本身会变，只动注释也不会误报。
 */
const normIcon = (s) => String(s).trim().replace(/"/g, "'")
const sha12 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 12)

/** 执行器 id → 图标内容指纹（前 12 位） */
const ICON_SHA = Object.fromEntries(
  [['claude', 'claudecode-color.svg'], ['opencode', 'opencode.svg'], ['codex', 'codex.svg']].map(([id, file]) => [
    id,
    sha12(normIcon(fs.readFileSync(path.resolve(__dirname, '../src/ui/client/src/assets/icons/svg', file), 'utf8'))),
  ])
)
/** 产品名（与前端 utils/taskExecutor 的 TASK_EXECUTOR_OPTIONS 同一份口径） */
const PRODUCT_NAME = { claude: 'Claude Code', opencode: 'OpenCode', codex: 'Codex' }

/**
 * 浏览器里读到的 src（data URL）→ 归一后的内容指纹（口径与上面同一份）。
 * 真取不到内容时回空串，让断言以"没认出图标"的形式失败，而不是抛异常。
 */
function srcSha(src) {
  const m = /^data:image\/svg\+xml[^,]*,(.*)$/s.exec(String(src || ''))
  if (!m) return ''
  try {
    return sha12(normIcon(decodeURIComponent(m[1])))
  } catch {
    return ''
  }
}

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

/** 合成任务：真实数据里不一定同时挂齐三种执行器、也未必有"认不出"的老记录 */
function syntheticTasks({ decorate, now }) {
  const at = (minAgo) => new Date(now - minAgo * 60 * 1000).toISOString()
  const running = (id, agent) => ({
    id: `synth-${id}-job`, taskId: `synth-${id}`, subId: `synth-${id}__j`, title: '',
    status: 'running', agent, startedAt: at(4), lastActivityAt: at(1),
    output: '先说结论：改完了，等你说要不要推', toolCalls: [{ name: 'Edit', argsPreview: 'src/a.ts' }],
  })
  const done = (id, agent, output) => ({
    id: `synth-${id}-job`, taskId: `synth-${id}`, subId: `synth-${id}__j`, title: '',
    status: 'done', agent, startedAt: at(30), endedAt: at(20), output,
  })
  const cases = [
    // 三个执行器每个都来一条跑着的：claude 是回落值，只验它等于没验到映射；
    // 三条都验才能证明"这个 id 画这张图"这张表整张是对的
    ['run-claude', '【合成】Claude 正在跑：活动区标出 claude', running('run-claude', 'claude')],
    ['run-opencode', '【合成】OpenCode 正在跑：活动区标出 opencode', running('run-opencode', 'opencode')],
    ['run-codex', '【合成】Codex 正在跑：活动区标出 codex', running('run-codex', 'codex')],
    // 跑完的：走的是另一条链路（lastJobAgent 而不是 live.agent）
    ['done-claude', '【合成】Claude 跑完的：引文开头标出 claude', done('done-claude', 'claude', '已经好了，要 push 吗？')],
    ['done-opencode', '【合成】OpenCode 跑完的：引文开头标出 opencode', done('done-opencode', 'opencode', '改完了，要不要 push？')],
    ['done-codex', '【合成】Codex 跑完的：引文开头标出 codex', done('done-codex', 'codex', 'Codex 这边也改完了。')],
    // 认不出 / 从没跑过：一个图标都不许有
    ['legacy', '【合成】老记录没写 agent：不画图标', done('legacy', undefined, '这条是加 agent 字段之前跑的')],
    ['bogus', '【合成】agent 写了个不认识的：不画图标', done('bogus', 'gemini', '执行器名字对不上，宁可空着')],
    ['virgin', '【合成】从没跑过：不画图标', null],
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

  // 真实数据里得有一条"能标出执行器"的任务，否则"真实数据上也成立"这条（A6）没得验
  const known = boardTasks.filter(t => t.lastJobAgent)
  log(`真实数据：任务 ${boardTasks.length} 条，能认出执行器 ${known.length} 条`)
  if (!known.length) {
    console.error('没有任何"认得出执行器"的真实任务（jobs.json 里 agent 字段全是空/不认识）：先跑一条任务再来')
    process.exit(2)
  }

  // 与运行中的后端对一次账：除了新加的字段，其余（列 / 活跃执行数）必须一模一样，
  // 否则说明我这份 fixture 和真实看板不是同一块板子，后面的断言就没有意义了。
  //
  // 唯一的例外是**本脚本自己正跑在其中的那条任务**（就是发起这次验证的 job）：
  // 它此刻还在跑，内存里那台后端可能已经把它标成终态（比如 API 报错退出），
  // 而磁盘上的 live-jobs 快照还停在 running —— 这正是 card-reply 脚本注释里说的那个
  // "在别的进程正在跑的时候读同一批数据"的固有偏差，不是口径漂移。
  // 判据：两边都对不上活跃执行数（0 ↔ 非 0），且其中一边是 0，说明分歧只在"跑没跑完"。
  const live = await fetch(`${API}/api/workbench/projects`).then(r => r.json())
  const realById = new Map((live.tasks || []).map(t => [t.id, t]))
  const drift = boardTasks.filter(t => {
    const r = realById.get(t.id)
    if (!r) return false
    if (r.column === t.column && r.runningJobs === t.runningJobs) return false
    const onlyAlive = r.runningJobs === 0 || t.runningJobs === 0
    return !onlyAlive
  })
  check('F1 fixture 与运行中后端的看板口径一致（列 / 活跃执行数无漂移）',
    drift.length === 0, drift.length ? `漂移 ${drift.length} 条：${drift.map(t => t.id).join(',')}` : '')

  const tasks = boardTasks.concat(syntheticTasks({ decorate: registry.decorateTaskForBoard, now }))
  const pick = (id) => tasks.find(t => t.id === `synth-${id}`)
  // 三个执行器 × 跑着 / 跑完 六条，每条都是同一套断言的输入
  const AGENT_CASES = ['claude', 'opencode', 'codex']
  const running = Object.fromEntries(AGENT_CASES.map(a => [a, pick(`run-${a}`)]))
  const finished = Object.fromEntries(AGENT_CASES.map(a => [a, pick(`done-${a}`)]))
  const legacy = pick('legacy')
  const bogus = pick('bogus')
  const virgin = pick('virgin')

  // 前端拿到的必须是服务端算好的那个执行器（两侧同源，这里先把期望值记下来）
  check('F2 服务端：正在跑的三条 live.agent 与执行器一一对应',
    AGENT_CASES.every(a => running[a].live?.agent === a),
    AGENT_CASES.map(a => `${a}=${running[a].live?.agent}`).join(' '))
  check('F3 服务端：跑完的三条 lastJobAgent 与执行器一一对应；认不出的两种都是空串',
    AGENT_CASES.every(a => finished[a].lastJobAgent === a) && legacy.lastJobAgent === '' && bogus.lastJobAgent === '',
    `${AGENT_CASES.map(a => finished[a].lastJobAgent).join('/')} + ${legacy.lastJobAgent || '空'}/${bogus.lastJobAgent || '空'}`)

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

    /**
     * 按**任务 id** 找卡片（卡片上带 data-task-id），把它上面两处图标都读出来。
     *
     * 为什么不按标题找：看板上**标题不唯一**（真实数据里"你好"同时存在 5 条，还都在已完成列），
     * 按标题 find 会撞上另一条同名的，于是拿别人的图标判自己的对错 ——
     * 本仓库历史上最贵的一类误判就是"看错元素"（见 .claude/rules/hmr-debug-check.md）。
     * 带列也不够（同列同名照样有），id 才是唯一键。
     */
    const readCard = (id, column) => page.evaluate(({ id, col }) => {
      const card = document.querySelector('.kb-col--' + col + ' .kb-card[data-task-id="' + id + '"]')
      if (!card) {
        return {
          found: false,
          inColumn: Array.from(document.querySelectorAll('.kb-col--' + col + ' .kb-card'))
            .map(c => (c.getAttribute('data-task-id') || '?') + '/' + (c.querySelector('.kb-card__title')?.textContent || '').trim().slice(0, 8)),
        }
      }
      const read = (sel, iconSel) => {
        const el = card.querySelector(sel)
        if (!el) return null
        const img = el.querySelector(iconSel)
        const cs = img ? getComputedStyle(img) : null
        return {
          title: el.getAttribute('title'),
          src: img ? img.getAttribute('src') : null,
          // 尺寸量 img 而不是外层 span：span 是 inline-flex 容器，TaskExecutorIcon 自带
          // width:1em，真正被缩放的只有 img（量 span 的话 0 宽也会"通过"）
          width: cs ? cs.width : null,
          border: cs ? cs.borderTopWidth : null,
          // 位置用 rect 而不是 offsetLeft —— offsetLeft **不含外边距**，
          // 而这里要验的恰好就是负外边距的位移（第一版拿 offsetLeft 量，恒等于引文的左缘）
          left: img ? img.getBoundingClientRect().left : null,
        }
      }
      const reply = card.querySelector('.kb-card__reply')
      return {
        found: true,
        running: card.classList.contains('is-running'),
        hasLive: !!card.querySelector('.kb-card__live'),
        liveAgent: read('.kb-card__live-agent', '.kb-card__live-agent-icon'),
        quoteAgent: read('.kb-card__quote-agent', '.kb-card__quote-agent-icon'),
        reply: reply ? reply.textContent : null,
        replyTextLeft: card.querySelector('.kb-card__reply-text') ? card.querySelector('.kb-card__reply-text').getBoundingClientRect().left : null,
        replyPadReal: reply ? parseFloat(getComputedStyle(reply).paddingLeft) : null,
        replyLeft: reply ? reply.getBoundingClientRect().left : null,
        replyPad: reply ? getComputedStyle(reply).paddingLeft : null,
        // 卡片上任何位置的执行器图标（C/D 组要断言"一个都没有"）
        anyIcon: card.querySelectorAll('.kb-card__live-agent-icon, .kb-card__quote-agent-icon').length,
      }
    }, { id, col: column })

    let realHit = null
    const realProbe = []

    const need = (card, what) => {
      if (!card.found) throw new Error(`看板「${what}」列里找不到这张卡片，那一列实际有：${JSON.stringify(card.inColumn)}`)
      return card
    }

    // ── A 正在跑的任务：活动区图标 = live.agent ────────────────────────
    for (const a of AGENT_CASES) {
      const card = need(await readCard(running[a].id, 'doing'), '进行中')
      check(`A[${a}] 正在跑：活动区有图标，且就是这个执行器自己的图`,
        !!card.liveAgent && srcSha(card.liveAgent.src) === ICON_SHA[a],
        `期望 ${a}(${ICON_SHA[a]})，实际 ${srcSha(card.liveAgent && card.liveAgent.src)}`)
      check(`A[${a}] 悬停提示是产品名（${PRODUCT_NAME[a]}）`,
        !!card.liveAgent && card.liveAgent.title === PRODUCT_NAME[a], String(card.liveAgent && card.liveAgent.title))
      // 跑着的时候不该同时出现引文（两段相似的话会让人以为是两条消息）
      check(`A[${a}] 与「最后回复」互斥：跑着时没有引文图标`, !card.quoteAgent && card.hasLive)
      if (a === 'codex') {
        // 尺寸与描边只挑一条量（三条共用同一份 CSS，量三遍是同一个断言写三遍）
        const pxOf = (v) => parseFloat(String(v || '0'))
        check('F4 图标是 12px（三个品牌标都是实心小色块，跟 11px 正文字号走会糊）',
          pxOf(card.liveAgent.width) === 12, card.liveAgent.width)
        check('F5 图标不描边（品牌标原图自带留白，套一圈方框反而像图标坏了）',
          pxOf(card.liveAgent.border) === 0, card.liveAgent.border)
      }
    }

    // ── B 跑完的任务：图标挂在引文开头 ────────────────────────────────
    for (const a of AGENT_CASES) {
      const fixture = finished[a]
      const card = need(await readCard(fixture.id, 'done'), '已完成')
      check(`B[${a}] 跑完：引文开头有图标，且就是这个执行器自己的图`,
        !!card.quoteAgent && srcSha(card.quoteAgent.src) === ICON_SHA[a],
        `期望 ${a}(${ICON_SHA[a]})，实际 ${srcSha(card.quoteAgent && card.quoteAgent.src)}`)
      check(`B[${a}] 悬停提示是产品名（${PRODUCT_NAME[a]}）`,
        !!card.quoteAgent && card.quoteAgent.title === PRODUCT_NAME[a], String(card.quoteAgent && card.quoteAgent.title))
      check(`B[${a}] 引文正文没被图标改坏（文字仍是服务端给的那段）`,
        norm(card.reply) === norm(fixture.lastReply), norm(card.reply))
      // 图标与引文同一个 flex 行：落在竖线里侧、正文之前。
      // 断言写成"在引文左缘 → 正文左缘之间"，既挡住"图标跑到正文后面去了"（丢失），
      // 也挡住"图标被推到竖线里面"（那是上一版负外边距的错法，本文件注释里记着）
      const textLeft = (card.quoteAgent ? card.quoteAgent.left + 16 : null)
      check(`B[${a}] 图标落在引文竖线左缘（在竖线里侧、正文之前）`,
        !!card.quoteAgent && card.quoteAgent.left > card.replyLeft && card.quoteAgent.left <= textLeft,
        `iconLeft=${card.quoteAgent && card.quoteAgent.left} 引文左缘=${card.replyLeft} 正文左缘=${textLeft}`)
    }

    // ── C/D 认不出 / 从没跑过：一个图标都不许有 ──────────────────────
    const legacyCard = need(await readCard(legacy.id, 'done'), '已完成')
    check('C1 老记录（没写 agent 字段）跑完的卡片：不画图标，但回复照常显示',
      legacyCard.anyIcon === 0 && !!legacyCard.reply, `icons=${legacyCard.anyIcon} reply=${norm(legacyCard.reply)}`)
    const bogusCard = need(await readCard(bogus.id, 'done'), '已完成')
    check('C2 agent 写了但不认识：不画图标（宁可空着也不猜一个品牌）',
      bogusCard.anyIcon === 0, `icons=${bogusCard.anyIcon}`)
    const virginCard = need(await readCard(virgin.id, 'todo'), '待处理')
    check('D1 从没跑过的任务：一个图标都没有', virginCard.anyIcon === 0, `icons=${virginCard.anyIcon}`)

    // ── A6 真实数据冒烟：真实任务（不是合成的那几条）也能标出执行器 ────
    // 合成用例走的是同一份服务端函数，但"真实数据里也成立"是另一回事：
    // 真实 job 的 agent 字段可能是老记录、可能是手工编辑过的，这里确认没有整列失效。
    // 逐条试而不是只看第一条 —— 真实数据里 title 会重名（"你好"有 5 条），
    // 头部那条未必是"跑完且写了正文"的那一条。找不到任何一条才是真失败。
    //
    // 取样必须**在看板视图下**做：下面切到列表视图之后 .kb-card 就没了，readCard 会一条都找不到
    // （第一版把循环留在切换之后，于是"每条都 found:false"，看着像功能坏了，其实是看错了地方）。
    for (const t of boardTasks.filter(x => x.lastJobAgent)) {
      const c = await readCard(t.id, t.column)
      if (realProbe.length < 2) realProbe.push({ id: t.id, col: t.column, found: c.found, icons: c.anyIcon })
      if (c.found && c.anyIcon > 0) { realHit = { t, c }; break }
    }
    check('A6 真实任务卡片上也画得出图标（不是只有合成数据能标）',
      !!realHit,
      realHit
        ? `${realHit.t.title}@${realHit.t.column} 执行器=${realHit.t.lastJobAgent}`
        : `试遍所有认得出执行器的真实任务，没有一条画出图标。抽样：${JSON.stringify(realProbe)}`)

    // ── G 截图存证：把「进行中」和「已完成」两列各拍一张 ──────────────
    shot = path.resolve(__dirname, '../tmp-verify-wb-card-executor-icon-running.png')
    await page.locator('.kb-col--doing').first().screenshot({ path: shot })
    log('截图:', shot)
    shot = path.resolve(__dirname, '../tmp-verify-wb-card-executor-icon-done.png')
    await page.locator('.kb-col--done').first().screenshot({ path: shot })
    log('截图:', shot)

    // ── E 列表视图：同一行也有 ────────────────────────────────────────
    await page.locator('.kb__view-btn', { hasText: /列表视图|List/ }).first().click()
    await page.waitForSelector('.kb-table__row', { timeout: 10000 })
    await sleep(400)
    // 列表行没有分列，标题就必须唯一 —— 合成用例的标题都带【合成】前缀，不会和真实任务撞
    const readRow = (title) => page.evaluate((t) => {
      const rows = Array.from(document.querySelectorAll('.kb-table__row'))
      const row = rows.find(r => (r.querySelector('.kb-table__name')?.textContent || '').trim() === t)
      if (!row) return { found: false, titles: rows.map(r => (r.querySelector('.kb-table__name')?.textContent || '').trim()) }
      const agents = Array.from(row.querySelectorAll('.kb-table__agent'))
      return {
        found: true,
        icons: agents.length,
        src: agents[0] ? agents[0].querySelector('img')?.getAttribute('src') : null,
        title: agents[0] ? agents[0].getAttribute('title') : null,
      }
    }, title)
    for (const a of AGENT_CASES) {
      const doneRow = await readRow(finished[a].title)
      check(`E1[${a}] 列表视图那一行也有执行器图标（同一条任务两种画法不能一边有一边没有）`,
        doneRow.icons === 1 && srcSha(doneRow.src) === ICON_SHA[a],
        `icons=${doneRow.icons} sha=${srcSha(doneRow.src)} vs ${ICON_SHA[a]}`)
      const runRow = await readRow(running[a].title)
      check(`E2[${a}] 正在跑的那条在列表行里标的也是 live.agent`,
        runRow.icons === 1 && srcSha(runRow.src) === ICON_SHA[a],
        `icons=${runRow.icons} sha=${srcSha(runRow.src)} vs ${ICON_SHA[a]}`)
    }
    const listOpencode = await readRow(finished.opencode.title)
    check('E3 列表行的图标带产品名提示（与卡片同一份口径）',
      listOpencode.title === PRODUCT_NAME.opencode, String(listOpencode.title))
    const listLegacy = await readRow(legacy.title)
    check('E4 认不出执行器的那条在列表行里同样不画图标', listLegacy.icons === 0, `icons=${listLegacy.icons}`)

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

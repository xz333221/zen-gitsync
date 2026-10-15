/**
 * 「本轮实际执行器」常驻徽标的验证（2026-10-15）。
 *
 * 背景：任务执行弹窗里"这一轮是用什么跑的"只有一个出处 —— 对话流左侧那颗执行器头像
 * （跟着最近一轮 job 的 agent 字段走）。但对话流是会滚的，滚下去之后屏幕上唯一还能
 * 看到的执行器信息是顶部 split button 上挂的 hint，而那个是**下次**用谁
 * （selectedTaskExecutor，用户临时选择，落 config.json 的 ui.lastTaskExecutor）。
 * 两者经常不一致（切了执行器还没重跑 / 这单是别的 g ui 实例跑的），用户反馈：
 * "只有对话左侧有图标，滚动到别处就看不到了，会误以为是上面的执行器按钮执行的"。
 * 现在工具栏常驻一枚徽标，写明白"本轮由 X 执行"，数据源与对话流头像同源。
 *
 * 验收契约（改这块时别破坏）：
 *   A 已跑过（job.agent=codebuddy）→ 徽标文案「本轮由 CodeBuddy Code 执行」，
 *     data-executor=codebuddy，图标真的加载出来了（naturalWidth>0）
 *   B 正在跑（running job, agent=claude）→ 文案翻成「正在由 Claude Code 执行」，
 *     带 is-running（琥珀档）
 *   C 从没跑过 → 徽标整个不渲染（没有"本轮"可言）
 *   D 徽标与按钮 hint 相互独立（本反馈的核心）：config 把 lastTaskExecutor 钉成 pi、
 *     check-tools 里 pi 可用，而最近一轮 job 的 agent 是 claude → 按钮 hint 是
 *     「Pi Agent」，徽标是「Claude Code」。写死跟按钮同源也能让 A 变绿，D 翻红
 *   E 滚动不断链：把对话流（.wb-exec-detail）滚到底，徽标几何上仍在视口内，
 *     且 DOM 上它挂在常驻工具栏 .wb-split__header 里（不是会被滚走的那一层）
 *   F 悬停说明解释区别：title 含「本轮实际使用的执行器」
 *   G 窄视口（<1180px）整枚隐藏：保护工具栏行不被挤变形（与 .wb-editor-bar__status
 *     在 620px 退场同一套让位思路）
 *   H 无 console error / pageerror
 *   R 负控（--reverse）：job 列表全空（"这些任务从没被执行过"）→ 所有任务的徽标
 *     都不渲染，哪怕按钮 hint 照旧显示选中的执行器。它证明 A/B 的判据是真的 ——
 *     一个无脑渲染的模板会让 R 翻红。
 *
 * 数据是手搓的、且拦掉全部 /api：不碰用户真实任务（会污染 ~/.zen-gitsync/jobs.json）。
 * 前置：dev server 已启动（vite 5544，`npm run dev:ping` 两个 OK）。
 * 用法：node scripts/verify-wb-run-executor-badge.cjs [--reverse]
 *   ZEN_SHOT_DIR 可指定截图目录（默认系统临时目录）
 * 退出码：0 全通过，1 有失败项。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const CHROME = process.env.ZEN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'zen-wb-run-executor-badge')
/** 负控（不是反证）：见文件头 R 段 */
const REVERSE = process.argv.includes('--reverse')

const PROJECT_PATH = 'D:\\ws\\zen-gitsync'
/** 徽标的选择器：data-executor 给一个稳定钩子，值 = 执行器 id */
const BADGE = '.wb-run-executor'

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function waitFor(fn, ms = 8000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await sleep(100)
  }
}

/**
 * 四条合成任务，覆盖三种形态。
 * `--reverse`：jobs 全空 —— "这些任务从没被执行过"，等价于这次改动之前的数据形态。
 *
 * syn-cb / syn-live / syn-pi-btn 三条的 agent 互不相同（codebuddy / claude / claude），
 * 是为了让"徽标跟 job 事实走"这件事可分辨 —— 五条全填 claude 的话，文案断言
 * 永远绿，分不清是读了 agent 还是写死的（probe-assertion-design 的同名教训）。
 */
function fixture() {
  const at = (minAgo) => new Date(Date.now() - minAgo * 60 * 1000).toISOString()
  const card = (id, title, column, at_min) => ({
    id, title, desc: '', projectPath: PROJECT_PATH, column,
    attachmentCount: 0, runningJobs: 0, live: null,
    lastReply: '', lastJobAgent: 'claude', lastJobStatus: null,
    lastJobEndedAt: null, createdAt: at(60), updatedAt: at(at_min),
  })
  const board = [
    card('syn-cb', '【合成】CodeBuddy 跑完的', 'done', 5),
    card('syn-live', '【合成】Claude 正在跑', 'doing', 2),
    card('syn-pi-btn', '【合成】按钮选 Pi、实际 Claude 跑的', 'done', 8),
    card('syn-new', '【合成】从没跑过', 'todo', 30),
  ]
  const tasks = board.map(t => ({
    id: t.id, title: t.title, desc: t.desc, promptId: null, simpleOverride: '',
    projectPath: t.projectPath, status: t.column, attachments: [],
    createdAt: t.createdAt, updatedAt: t.updatedAt,
  }))
  // subId 用 `${taskId}__simple`：useWorkbenchSimpleConversation 只认这个前缀（含 __rN 后缀）
  const jobs = REVERSE ? [] : [
    {
      id: 'syn-cb-j1', taskId: 'syn-cb', subId: 'syn-cb__simple', status: 'done',
      agent: 'codebuddy', prompt: '跑一轮', output: '跑完了。', thinking: '',
      startedAt: at(10), endedAt: at(8), error: null, toolCalls: [],
    },
    {
      id: 'syn-live-j1', taskId: 'syn-live', subId: 'syn-live__simple', status: 'running',
      agent: 'claude', prompt: '跑一轮看看', output: '正在处理…', thinking: '',
      startedAt: at(2), endedAt: null, error: null, toolCalls: [],
    },
    {
      id: 'syn-pi-btn-j1', taskId: 'syn-pi-btn', subId: 'syn-pi-btn__simple', status: 'done',
      agent: 'claude', prompt: '也是 claude 跑的', output: '好了。', thinking: '',
      startedAt: at(20), endedAt: at(18), error: null, toolCalls: [],
    },
  ]
  const project = {
    path: PROJECT_PATH, key: PROJECT_PATH.toLowerCase(), name: 'zen-gitsync',
    source: 'both', isCurrent: true, git: null,
    stats: { total: 4, todo: 1, doing: 1, done: 2, progress: 50, runningJobs: REVERSE ? 0 : 1, lastActiveAt: at(2) },
  }
  return { board, tasks, jobs, project }
}

/**
 * 读工具栏那枚徽标。found=false = 整个元素没渲染（v-if lastSimpleJob）。
 * 图标要断 naturalWidth>0：只断 <img> 存在是假绿（data URL 挂不上时 src 照样有值）。
 */
function readBadge(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return { found: false }
    const r = el.getBoundingClientRect()
    const img = el.querySelector('img')
    return {
      found: true,
      executor: el.getAttribute('data-executor') || '',
      text: (el.querySelector('.wb-run-executor__text')?.textContent || '').trim(),
      running: el.className.includes('is-running'),
      title: el.getAttribute('title') || '',
      // 常驻性：它必须挂在会被滚动容器之上的工具栏行里（.wb-exec-detail 才会滚）
      inToolbar: !!el.closest('.wb-split__header'),
      inViewport: r.top >= 0 && r.bottom <= (window.innerHeight || 0) && r.width > 0,
      iconLoaded: !!img && img.naturalWidth > 0,
    }
  }, BADGE)
}

/** 读 split button 上挂的 hint（"下次用谁"）：主按钮 textContent 里混着它，单独摘出来 */
function readHint(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.wb-executor-split__hint')
    return el ? el.textContent.trim() : ''
  })
}

/** 把对话流滚到底（用户反馈的场景：滚开之后看不到执行器是谁） */
async function scrollChatToBottom(page) {
  await page.evaluate(() => {
    const el = document.querySelector('.wb-exec-detail')
    if (el) el.scrollTop = el.scrollHeight
  })
  await sleep(300)
}

async function main() {
  const { board, tasks, project } = fixture()
  /**
   * 这份 job 列表是**活的**：SSE 每次重连都会推一份 `hello`，而前端的
   * `applyJobEvent('hello')` 是**整体替换** `jobs.value`（不是合并）——
   * 所以任何清空/改动之后这里必须跟着同步，否则下一次重连就把旧状态灌回来。
   */
  let liveJobs = fixture().jobs

  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox'],
  })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  try {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('wb.boardView.v1', 'kanban')
        localStorage.setItem('wb.boardProject.v1', '')
      } catch { /* 隐私模式 */ }
    })
    const json = (route, body) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(body),
    })
    // ⚠️ 兜底路由**先注册**：playwright 是"后注册的先匹配"，兜底放最后会把下面每条具体路由都吞掉
    await page.route('**/api/**', (route) => json(route, { success: true }))
    /**
     * SSE 必须自己接管，**不能**放行给真后端：hello 事件在前端是**整体替换** jobs.value
     * （useWorkbenchData 的 applyJobEvent），放行就等于让后端那份真实的 job 列表
     * 把这里合成的 syn-* 覆盖掉。用合成 hello 顶掉：body 发完连接就断，
     * 浏览器按 3s 自己重连，重连再推一份同样的 hello（实测不往 console 写错误）。
     */
    await page.route('**/api/workbench/events', (route) => route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ event: 'hello', payload: { jobs: liveJobs } })}\n\n`,
    }))
    await page.route('**/api/scan-npm-scripts', (route) =>
      json(route, { success: true, cancelled: false, packages: [], totalScripts: 0 }))
    await page.route('**/api/instances', (route) => json(route, { success: true, instances: [] }))
    // 执行器可用性：claude 与 pi 都可用。pi 必须可用 —— D 组要把"按钮选中的执行器"
    // 钉成 pi（没装的话 active 会回落，按钮 hint 就不显示 pi 了）
    await page.route('**/api/check-tools', (route) => json(route, {
      success: true, claude: true, opencode: false, codex: false,
      codebuddy: true, pi: true,
      kimi: false, zcode: false, dsh: false, vscode: true,
      platform: 'win32', installers: {}, versions: {},
    }))
    /**
     * D 组的关键一桩：把"上次用过哪个执行器"（按钮 hint 的来源）钉成 pi。
     * 走 route.fetch() 拿真配置再改一个字段，别整个手搓 —— 手搓的瘦身配置
     * 会缺一堆 ui 字段，把设置/布局那一片打进 defaults，与本次断言无关的
     * 副作用只会让 H 组变红。
     */
    await page.route('**/api/config/getConfig', async (route) => {
      const resp = await route.fetch()
      let data = null
      try { data = await resp.json() } catch { /* 非 JSON 走兜底 */ }
      if (data && typeof data === 'object') {
        data.ui = { ...(data.ui || {}), lastTaskExecutor: 'pi' }
        await route.fulfill({ response: resp, json: data })
      } else {
        await json(route, { success: true, ui: { lastTaskExecutor: 'pi' } })
      }
    })
    await page.route('**/api/workbench/projects*', (route) =>
      json(route, { success: true, projects: [project], tasks: board, currentProjectPath: PROJECT_PATH }))
    await page.route('**/api/workbench/tasks*', (route) => json(route, { tasks }))
    await page.route('**/api/workbench/jobs', (route) => json(route, { success: true, jobs: liveJobs }))
    await page.route('**/api/workbench/current-project*', (route) => json(route, { path: PROJECT_PATH }))

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.kb-card', { timeout: 15000 })
    await page.locator('.proj-item--all').first().click()
    await page.waitForSelector('.kb-card[data-task-id="syn-cb"]', { timeout: 15000 })
    await sleep(600)

    /** 点卡片开编辑器 → 等工具栏出现；Escape 关掉（CommonDialog closeOnPressEscape 默认 true） */
    const openTask = async (id) => {
      await page.locator(`.kb-card[data-task-id="${id}"]`).click()
      await page.waitForSelector('.wb-split__header', { timeout: 15000 })
      await sleep(500)
    }
    const closeEditor = async () => {
      await page.keyboard.press('Escape')
      await sleep(600)
    }

    // ── A 已跑过一轮（agent=codebuddy）────────────────────────────────
    await openTask('syn-cb')
    let b = await readBadge(page)
    if (REVERSE) {
      check('A 负控：没有 job → 徽标不渲染', b.found === false)
    } else {
      check('A1 已跑过 → 徽标渲染', b.found)
      check('A2 文案「本轮由 CodeBuddy Code 执行」', b.text === '本轮由 CodeBuddy Code 执行', `实际「${b.text}」`)
      check('A3 data-executor=codebuddy（跟 job.agent 走）', b.executor === 'codebuddy', `实际「${b.executor}」`)
      check('A4 不是 is-running（上一轮已跑完）', b.running === false)
      check('A5 图标真的加载出来了', b.iconLoaded === true)
      check('A6 挂在常驻工具栏行里（不是会被滚走的那层）', b.inToolbar === true)
      check('A7 悬停说明解释它与按钮的区别', b.title.includes('本轮实际使用的执行器'), `title="${b.title}"`)
      await fs.promises.mkdir(SHOT_DIR, { recursive: true })
      await page.screenshot({ path: path.join(SHOT_DIR, 'wb-run-executor-badge.png') })
      log('截图:', path.join(SHOT_DIR, 'wb-run-executor-badge.png'))

      // ── E 滚动不断链 ────────────────────────────────────────────────
      await scrollChatToBottom(page)
      b = await readBadge(page)
      check('E1 对话流滚到底后徽标仍在视口内', b.found && b.inViewport,
        `found=${b.found} inViewport=${b.inViewport}`)
      check('E2 滚完之后文案没变（不随滚动丢事实）', b.text === '本轮由 CodeBuddy Code 执行', `实际「${b.text}」`)
    }
    await closeEditor()

    // ── B 正在跑（agent=claude, running）──────────────────────────────
    await openTask('syn-live')
    b = await readBadge(page)
    if (REVERSE) {
      check('B 负控：没有 job → 徽标不渲染', b.found === false)
    } else {
      check('B1 正在跑 → 文案翻成「正在由 Claude Code 执行」', b.text === '正在由 Claude Code 执行', `实际「${b.text}」`)
      check('B2 正在跑 → is-running（琥珀档）', b.running === true)
      check('B3 data-executor=claude', b.executor === 'claude', `实际「${b.executor}」`)
      await page.screenshot({ path: path.join(SHOT_DIR, 'wb-run-executor-badge-running.png') })
    }
    await closeEditor()

    // ── C 从没跑过 ────────────────────────────────────────────────────
    await openTask('syn-new')
    b = await readBadge(page)
    check('C 从没跑过 → 徽标整个不渲染', b.found === false, `found=${b.found} text="${b.text}"`)
    await closeEditor()

    // ── D 徽标与按钮 hint 相互独立（本反馈的核心）──────────────────────
    // config 把 lastTaskExecutor 钉成 pi、check-tools 里 pi 可用 → 按钮 hint 是 Pi Agent；
    // 而这单最近一轮 job 的 agent 是 claude → 徽标必须是 Claude Code。
    // 一个"跟按钮同源"的实现能让 A 变绿、让这里翻红。
    await openTask('syn-pi-btn')
    b = await readBadge(page)
    const hint = await readHint(page)
    if (REVERSE) {
      check('D 负控：没有 job → 徽标不渲染（哪怕按钮 hint 显示选中的执行器）',
        b.found === false, `found=${b.found} text="${b.text}"`)
      check('D2 负控下按钮 hint 照旧是 Pi Agent（证明不是按钮本身坏了）',
        hint.includes('Pi Agent'), `hint="${hint}"`)
    } else {
      check('D1 按钮 hint 显示选中的执行器 Pi Agent', hint.includes('Pi Agent'), `hint="${hint}"`)
      check('D2 徽标显示实际跑了的 Claude Code（与按钮不一致也不跟它走）',
        b.found && b.text === '本轮由 Claude Code 执行', `found=${b.found} text="${b.text}"`)
    }
    await closeEditor()

    // ── G 窄视口整枚隐藏（保护工具栏行）───────────────────────────────
    // 1180px 是按"弹窗 96vw − 侧栏 240px − 内边距"算出来的让位阈值（见样式那段注释）。
    // 注意量之前先等工具栏渲染落定：刚 setViewportSize 那一瞬布局还没重排完。
    await openTask('syn-cb')
    await page.setViewportSize({ width: 1100, height: 900 })
    await sleep(400)
    const narrowVisible = await page.evaluate((sel) => {
      const el = document.querySelector(sel)
      if (!el) return false
      return getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0
    }, BADGE)
    if (REVERSE) {
      check('G 负控：没有 job → 窄视口下同样不渲染', narrowVisible === false)
    } else {
      check('G1 窄视口（1100px < 1180px）徽标整枚隐藏', narrowVisible === false,
        `visible=${narrowVisible}`)
      // 反证那一半：放宽视口它必须回来 —— 证明 G1 不是"元素压根不存在"型假绿
      await page.setViewportSize({ width: 1600, height: 1000 })
      await sleep(400)
      const wide = await readBadge(page)
      check('G2 视口放宽回 1600px 后徽标回来', wide.found === true && wide.inViewport,
        `found=${wide.found} inViewport=${wide.inViewport}`)
    }
    await closeEditor()

    check('H 无 console error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
    check('H2 无 pageerror', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过${REVERSE ? '（负控 --reverse）' : ''}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify] 崩了:', err); process.exit(1) })

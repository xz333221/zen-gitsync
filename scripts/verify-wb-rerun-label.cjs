/**
 * 「执行任务 → 重新执行任务」按钮状态的验证（2026-10-01）。
 *
 * 背景：任务执行弹窗顶部那个 split button 一直写着「执行任务」，但它**不是**接着上一轮跑 ——
 * `runTask()` 会先 `clearJobsByTask()` 把这条任务旧的 job 全删掉再开新一轮
 * （lib 里那句注释：「重跑 = 新的一轮：先清掉这个任务旧的执行记录」）。于是：
 *   · 已经跑过的任务：用户以为点的是"继续"，实际把上一轮对话抹了；
 *   · 正在跑的任务：点了先白清一遍，再被服务端 400 顶回来（"该任务已有正在执行的 job"），
 *     看起来像"点了没反应"。
 * 现在文案跟着执行事实走，在跑的时候直接禁用。
 *
 * 验收契约（改这块时别破坏）：
 *   A 这条任务**已经有执行记录**（job 列表里有它）：按钮文案是「重新执行任务」，可点
 *   B 这条任务**从没跑过**：文案仍是「执行任务」（不是整排都变成"重新"，见 R）
 *   C 这条任务**正在跑**：按钮 disabled，文案仍是「重新执行任务」，
 *     且带一句说明（"正在执行中,请先「停止」再重新执行"）—— 点了不起新的一轮
 *   D 文案的来源是**服务端的 job 事实**，不是任务身上的某个标记：
 *     点「清空执行」把这些 job 清掉之后，同一条任务的按钮必须回到「执行任务」
 *   E 未跑过 / 已跑过两种状态下都**不发** run 请求；C 的 disabled 状态下强制点击也不发
 *   R 负控（--reverse）：把三张卡片的 job 数据全换成空数组（即"这些任务从没被执行过"），
 *     此时三条任务的按钮必须全是「执行任务」、且都不可 disabled。
 *     它证明的不是"改对了"，而是 A/C 那组的判据是真的 —— 一个写死渲染「重新执行任务」
 *     的模板也能让 A 变绿，却会让 R 翻红。（注入点是**服务端给前端的 job 列表**，
 *     也就是这个判断唯一的输入。）
 *
 * 数据是手搓的、且拦掉全部 /api：本脚本验的是"按钮文案 + disabled + 一次 fetch"，
 * 与后端怎么存 job 无关；不碰用户真实任务（会污染 ~/.zen-gitsync/jobs.json）。
 * 服务端那份"已有 running job 就 400"的规则在 routes/workbench/index.js 里，本脚本不重复验。
 *
 * 前置：dev server 已启动（vite 5544，`npm run dev:ping` 两个 OK）。
 * 用法：node scripts/verify-wb-rerun-label.cjs [--reverse]
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
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'zen-wb-rerun-label')
/** 负控（不是反证）：见文件头 R 段 */
const REVERSE = process.argv.includes('--reverse')

const PROJECT_PATH = 'D:\\ws\\zen-gitsync'
const LABEL_RUN = '执行任务'
const LABEL_RERUN = '重新执行任务'
const TITLE_RUNNING = '正在执行中,请先「停止」再重新执行'

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
 * 四条合成任务，覆盖三种状态。
 * `--reverse`：jobs 全空 —— "这些任务从没被执行过"，等价于这次改动之前的数据形态。
 *
 * 为什么要两条"已跑过"（syn-ran / syn-ran2）：A 组要点一次按钮证明它真的能起执行，
 * 而那一轮 `runTask` 会先 DELETE 掉这条任务的 job 记录（前端本地也会 filter 一遍），
 * 之后再拿同一条去验 D 组的"清空后回到执行任务"就是**空断言** —— 判据早在 A 组就被拆了。
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
    card('syn-ran', '【合成】已跑过一轮', 'done', 5),
    card('syn-ran2', '【合成】已跑过一轮（用于清空）', 'done', 6),
    card('syn-new', '【合成】从没跑过', 'todo', 30),
    card('syn-live', '【合成】正在跑', 'doing', 2),
  ]
  const tasks = board.map(t => ({
    id: t.id, title: t.title, desc: t.desc, promptId: null, simpleOverride: '',
    projectPath: t.projectPath, status: t.column, attachments: [],
    createdAt: t.createdAt, updatedAt: t.updatedAt,
  }))
  // subId 用 `${taskId}__simple`：useWorkbenchSimpleConversation 只认这个前缀（含 __rN 后缀）
  const jobs = REVERSE ? [] : [
    {
      id: 'syn-ran-j1', taskId: 'syn-ran', subId: 'syn-ran__simple', status: 'done',
      agent: 'claude', prompt: '把这段说明补上', output: '已补上。', thinking: '',
      startedAt: at(20), endedAt: at(18), error: null, toolCalls: [],
    },
    {
      id: 'syn-ran2-j1', taskId: 'syn-ran2', subId: 'syn-ran2__simple', status: 'done',
      agent: 'claude', prompt: '补一份说明', output: '好了。', thinking: '',
      startedAt: at(25), endedAt: at(23), error: null, toolCalls: [],
    },
    {
      id: 'syn-live-j1', taskId: 'syn-live', subId: 'syn-live__simple', status: 'running',
      agent: 'claude', prompt: '跑一轮看看', output: '正在处理…', thinking: '',
      startedAt: at(2), endedAt: null, error: null, toolCalls: [],
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
 * 读任务头那个 split button。
 * 主按钮的 textContent 里除了文案还挂着执行器名（`.wb-executor-split__hint`），
 * 直接把 hint 摘掉再取文本，避免断言里混进"Claude"。
 */
function readSplit(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.wb-executor-split')
    if (!el) return { found: false }
    const btn = el.querySelector('button')
    let label = ''
    if (btn) {
      const clone = btn.cloneNode(true)
      clone.querySelectorAll('.wb-executor-split__hint').forEach(n => n.remove())
      label = clone.textContent.trim()
    }
    return {
      found: true,
      label,
      disabled: !!(btn && btn.disabled),
      rootDisabled: el.className.includes('is-disabled'),
      title: el.getAttribute('title') || '',
      box: btn ? { x: (r => r.x + r.width / 2)(btn.getBoundingClientRect()), y: (r => r.y + r.height / 2)(btn.getBoundingClientRect()) } : null,
    }
  })
}

async function main() {
  const { board, tasks, project } = fixture()
  /**
   * 这份 job 列表是**活的**：SSE 每次重连都会推一份 `hello`，而前端的
   * `applyJobEvent('hello')` 是**整体替换** `jobs.value`（不是合并）——
   * 所以 D 组清空执行之后，这里必须跟着少一条，否则下一次重连就把清掉的 job 又灌回去，
   * 按钮文案会翻回「重新执行任务」，看起来像功能坏了，其实是探针自己没同步。
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

  /** 本次运行里前端发出的 run / clear-execution 请求 */
  const runCalls = []
  const clearCalls = []

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
     * 把这里合成的 syn-* 覆盖掉 —— 第一版就是这么写的，按钮永远停在「执行任务」。
     * 用合成 hello 顶掉：body 发完连接就断，浏览器按 3s 自己重连，重连再推一份同样的 hello
     * （实测不往 console 写错误，比 route.abort() 干净）。
     */
    await page.route('**/api/workbench/events', (route) => route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ event: 'hello', payload: { jobs: liveJobs } })}\n\n`,
    }))
    // NPM 面板读的是 result.packages.length（不是 scripts），兜底那个 {success:true}
    // 会让它抛 TypeError 刷 console，把 H 带崩
    await page.route('**/api/scan-npm-scripts', (route) =>
      json(route, { success: true, cancelled: false, packages: [], totalScripts: 0 }))
    // 顶部实例切换器同理：拿不到 instances 数组会在 computed 里抛 pageerror
    await page.route('**/api/instances', (route) => json(route, { success: true, instances: [] }))
    // 执行器可用性：钉成"claude 可用"，否则 `.wb-executor-split` 会退化成"未检测到本地 CLI"提示条，
    // 整个探针验不到目标元素（也与本机装没装 CLI 有关，不该是这条断言的前提）
    await page.route('**/api/check-tools', (route) => json(route, {
      success: true, claude: true, opencode: false, codex: false,
      kimi: false, zcode: false, dsh: false, vscode: true,
      platform: 'win32', installers: {}, versions: {},
    }))
    await page.route('**/api/workbench/projects*', (route) =>
      json(route, { success: true, projects: [project], tasks: board, currentProjectPath: PROJECT_PATH }))
    await page.route('**/api/workbench/tasks*', (route) => json(route, { tasks }))
    await page.route('**/api/workbench/prompts*', (route) => json(route, { prompts: [] }))
    await page.route('**/api/workbench/jobs', (route) => json(route, { success: true, jobs: liveJobs }))
    await page.route('**/api/workbench/current-project*', (route) => json(route, { path: PROJECT_PATH }))
    await page.route('**/api/workbench/tasks/*/run', (route) => {
      runCalls.push(route.request().url())
      return json(route, { success: true, message: '已开始执行任务' })
    })
    // runTask 的第一步是 DELETE /jobs/by-task/:id（"重跑 = 先清掉旧记录"）——
    // 这里跟着改 liveJobs，否则 SSE 下一次重连又把旧 job 推回来，跟真接口的行为对不上
    await page.route('**/api/workbench/jobs/by-task/*', (route) => {
      const taskId = decodeURIComponent(route.request().url().split('?')[0].split('/').pop())
      liveJobs = liveJobs.filter(j => j.taskId !== taskId)
      return json(route, { success: true, removed: 1 })
    })
    await page.route('**/api/workbench/tasks/*/clear-execution', (route) => {
      const url = route.request().url()
      clearCalls.push(url)
      // 与真接口同口径（by-task 清掉这条任务的 job），否则 SSE 下一次重连就把它们推回来
      liveJobs = liveJobs.filter(j => !url.includes(`/${j.taskId}/`))
      return json(route, { success: true, message: '已清空 1 条执行记录' })
    })

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.kb-card', { timeout: 15000 })
    await page.locator('.proj-item--all').first().click()
    await page.waitForSelector('.kb-card[data-task-id="syn-ran"]', { timeout: 15000 })
    await sleep(600)

    /** 点卡片开编辑器 → 等按钮出现；Escape 关掉（CommonDialog closeOnPressEscape 默认 true） */
    const openTask = async (id) => {
      await page.locator(`.kb-card[data-task-id="${id}"]`).click()
      await page.waitForSelector('.wb-executor-split', { timeout: 15000 })
      await sleep(500)
    }
    const closeEditor = async () => {
      await page.keyboard.press('Escape')
      await sleep(600)
    }

    // ── A 已跑过一轮 ────────────────────────────────────────────────
    await openTask('syn-ran')
    let s = await readSplit(page)
    check('A 找到执行按钮（split button）', s.found)
    const wantRan = REVERSE ? LABEL_RUN : LABEL_RERUN
    check(`A2 已跑过一轮 → 文案「${wantRan}」`, s.label === wantRan, `实际「${s.label}」`)
    check('A3 已跑过一轮 → 可点（没在跑就不该禁用）', s.disabled === false, `disabled=${s.disabled}`)
    if (!REVERSE) {
      check('A4 悬停说明写明会清空上一轮', s.title.includes('上一轮的执行记录会被清空'), `title="${s.title}"`)
    }
    // 截图存证：必须在下面那次点击**之前**拍 —— 点完 runTask 会清掉这条任务的 job，
    // 按钮自己就翻回「执行任务」了，拍到的是翻转后的状态，不是要证明的那个
    await fs.promises.mkdir(SHOT_DIR, { recursive: true })
    const shot = path.join(SHOT_DIR, REVERSE ? 'wb-rerun-label-reverse.png' : 'wb-rerun-label.png')
    await page.screenshot({ path: shot })
    log('截图:', shot)

    // 点一次，证明这个按钮不是摆着好看（请求被拦下来了，不碰用户的 jobs.json）
    const runCallsBefore = runCalls.length
    if (s.box && !s.disabled) {
      await page.mouse.click(s.box.x, s.box.y)
      await sleep(600)
    }
    if (!REVERSE) {
      check('A5 点「重新执行任务」确实发了 run 请求',
        runCalls.slice(runCallsBefore).some(u => u.includes('/tasks/syn-ran/run')),
        runCalls.slice(runCallsBefore).join(', ') || '一个都没发')
    }
    await closeEditor()

    // ── B 从没跑过 ──────────────────────────────────────────────────
    await openTask('syn-new')
    s = await readSplit(page)
    check('B 从没跑过 → 文案「执行任务」', s.label === LABEL_RUN, `实际「${s.label}」`)
    check('B2 从没跑过 → 可点', s.disabled === false, `disabled=${s.disabled}`)
    check('B3 从没跑过 → 没有"会清空上一轮"那句说明', !s.title.includes('上一轮'), `title="${s.title}"`)
    await closeEditor()

    // ── C 正在跑 ────────────────────────────────────────────────────
    await openTask('syn-live')
    s = await readSplit(page)
    if (REVERSE) {
      check('C 负控：没有 running job → 文案「执行任务」且可点',
        s.label === LABEL_RUN && s.disabled === false, `「${s.label}」 disabled=${s.disabled}`)
    } else {
      check('C 正在跑 → 文案仍是「重新执行任务」', s.label === LABEL_RERUN, `实际「${s.label}」`)
      check('C2 正在跑 → 按钮 disabled（服务端本来就会 400）',
        s.disabled && s.rootDisabled, `disabled=${s.disabled} class=${s.rootDisabled}`)
      check('C3 正在跑 → 说明是"先停止再重新执行"', s.title === TITLE_RUNNING, `title="${s.title}"`)
      await page.screenshot({ path: path.join(SHOT_DIR, 'wb-rerun-label-running.png') })
      // 强制点击（绕过 playwright 对 disabled 元素的等待）：必须一个 run 请求都不发。
      // 计数在**第一次点击之前**取 —— 放到后面取的话，万一第一次点击真发了请求，它自己就被算进基线了
      const before = runCalls.length
      if (s.box) {
        await page.mouse.click(s.box.x, s.box.y)
        await sleep(600)
        await page.locator('.wb-executor-split button').first().click({ force: true, timeout: 5000 }).catch(() => {})
        await sleep(600)
      }
      check('C4 强制点击 disabled 按钮 → 不起新的一轮', runCalls.length === before,
        `新增 run 请求 ${runCalls.length - before} 次`)
    }
    await closeEditor()

    // ── D 清空执行之后，文案要回到「执行任务」（判据是 job 事实，不是任务标记）──
    // 用的是 syn-ran2 而不是 A 组那条：A 组点过一次按钮，那一下就把它自己的 job 记录删了，
    // 拿它验 D 等于验一个"早就空了的任务"，必然绿
    if (!REVERSE) {
      await openTask('syn-ran2')
      const beforeLabel = (await readSplit(page)).label
      // 点「清空执行」→ 确认框 → POST
      await page.locator('.wb-logs-inline-btn--danger').first().click()
      await page.waitForSelector('.el-message-box', { timeout: 8000 })
      await page.locator('.el-message-box__btns button', { hasText: '清空' }).first().click()
      const flipped = await waitFor(async () => (await readSplit(page)).label === LABEL_RUN, 8000)
      check('D 清空执行后 → 文案回到「执行任务」',
        flipped && beforeLabel === LABEL_RERUN,
        `清空前「${beforeLabel}」→ 清空后「${(await readSplit(page)).label}」`)
      check('D2 清空执行确实调了接口', clearCalls.length === 1, clearCalls.join(', '))
      await closeEditor()
    }

    // ── E 按钮真的能触发执行（不是摆着好看）──
    check('E 点按钮确实发了 run 请求', runCalls.length > 0, `run 请求 ${runCalls.length} 次`)
    check('E2 run 请求打的是本任务的 id',
      runCalls.every(u => u.includes('/tasks/syn-')), runCalls.join(', '))
    if (!REVERSE) {
      check('E3 其中包含「重新执行任务」那一次（A5 已单独断言）',
        runCalls.some(u => u.includes('/tasks/syn-ran/run')), runCalls.join(', '))
    }

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

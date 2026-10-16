/**
 * 「项目管理」视图（左栏新入口）—— 浏览器验证。
 *
 * 守的契约：
 *   P0  活动栏有「项目管理」入口，点开渲染 .pm（与「工作台」是两个入口）
 *   P1  项目清单渲染：名字 / 分支 / 进度 / 「目录不存在」chip（与工作台同一份数据）
 *   P2  删除活项目：确认框含"任务不会被删除" → /projects/remove 收到该路径 → 列表刷新
 *   P3  取消删除 → 一个 remove 请求都不发（反向对照，否则 P2 恒绿）
 *   P4  「添加项目」：填路径 → /projects/add 收到该路径 → 成功关窗 + 列表刷新
 *   P4r 添加失败（服务端 400）→ 报错 toast 且**弹窗仍然打开**（不丢用户输入）
 *   P4r2 该目录已在清单里（alreadyKnown）→ 提示"已在项目列表中"，不说"添加成功"
 *   P5  推荐列表渲染 + 一键「添加」→ /projects/add 收到那一行的路径
 *   P5r 推荐为空 → 空态文案
 *   P6  启动方式**懒加载**：初始 0 次带 projectPath 的请求；展开某一行 → 1 次且
 *       body.projectPath = 那一行的路径；点「启动」→ run-npm-script 收到 packagePath/scriptName
 *   P7  行内「打开方式」菜单能开（复用 ProjectOpenMenuList，与工作台同一份菜单）
 *   P8  无 console / page 错误
 *
 * 反向（--reverse）：把三条**行为契约**的期望反过来，要求它们确实翻红 ——
 * 证明这些断言不是恒绿的空跑：
 *   · P3  "取消不发请求" 反成 "取消也发请求" → 必须红
 *   · P4r "失败不关窗"   反成 "失败也关窗"   → 必须红
 *   · P6  "懒加载 0 次"  反成 "挂载即请求"   → 必须红
 * 其余是"存在性/文案"断言（P0/P1/P2/P4/P5/P7…），反向下照旧应当绿（它们守的是
 * "功能在不在"，注入什么都不会变）—— 所以 MUST_FAIL 名单只列上面三条。
 */
const path = require('node:path')
const os = require('node:os')
// playwright 装在 src/ui/client 下，把它的 node_modules 挂进解析路径，脚本才能独立跑
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544' // 前端
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'pm-verify')
const REVERSE = process.argv.includes('--reverse')

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitUntil(fn, timeout = 12000, interval = 150) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true
    await sleep(interval)
  }
  return false
}

// ── 夹具 ──────────────────────────────────────────────────────────────────
const P_ALPHA = 'Z:\\zen-verify\\alpha-repo'
const P_BETA = 'Z:\\zen-verify\\beta-repo'
const P_GONE = 'Z:\\zen-verify\\gone-repo'
const P_NEW = 'Z:\\zen-verify\\new-repo'

const git = (over = {}) => ({
  isGitRepo: true, branch: 'main', upstream: null, hasUpstream: false, detached: false,
  ahead: 0, behind: 0, changed: 0, staged: 0, unstaged: 0, untracked: 0, ...over,
})
const stats = (over = {}) => ({
  total: 0, todo: 0, doing: 0, done: 0, progress: 0, runningJobs: 0,
  lastActiveAt: '2026-10-07T02:00:00.000Z', ...over,
})
const entry = (name, p, over = {}) => ({
  key: p.toLowerCase(), path: p, name, source: 'recent', isCurrent: false, exists: true,
  git: git(), stats: stats(), iconUrl: null, ...over,
})

/** 桩里的项目清单可变 —— P2 删除后要让它少一条，好断言"列表刷新了" */
let projectsFixture = []

function resetFixture() {
  projectsFixture = [
    entry('alpha-repo', P_ALPHA, { isCurrent: true, stats: stats({ total: 4, done: 3, progress: 75 }) }),
    entry('beta-repo', P_BETA, { git: git({ branch: 'feat/x' }), stats: stats({ total: 2, done: 0, runningJobs: 1 }) }),
    entry('gone-repo', P_GONE, { exists: false, git: null, stats: stats() }),
  ]
}

const SUGGESTIONS = [
  { id: 'npm:.:dev', kind: 'npm', title: '启动开发环境', order: 1, reason: '一条命令起全套', command: 'npm run dev', packagePath: P_ALPHA, packageLabel: '.', packageName: 'alpha-repo', scriptName: 'dev' },
]

async function main() {
  resetFixture()
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await context.newPage()

  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })

  // 记录收到的请求（断言"发了什么"用）
  const removeCalls = []
  const addCalls = []
  const startupCalls = []
  const npmLaunchCalls = []
  let addResponse = { success: true, alreadyKnown: false }

  await page.route('**/api/workbench/projects', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ success: true, projects: projectsFixture, tasks: [], currentProjectPath: P_ALPHA }),
  }))
  await page.route('**/api/workbench/projects/recommended', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      recommendations: [
        { path: 'Z:\\zen-verify\\rec-one', name: 'rec-one', mtime: Date.now() },
        { path: 'Z:\\zen-verify\\rec-two', name: 'rec-two', mtime: Date.now() - 1000 },
      ],
      roots: ['Z:\\zen-verify'],
    }),
  }))
  await page.route('**/api/workbench/projects/add', (route) => {
    addCalls.push(JSON.parse(route.request().postData() || '{}'))
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(addResponse) })
  })
  await page.route('**/api/workbench/projects/remove', (route) => {
    const body = JSON.parse(route.request().postData() || '{}')
    removeCalls.push(body)
    // 删成功就让它从清单里消失（下一轮 /projects 就能看到行数变了）
    projectsFixture = projectsFixture.filter(p => p.path !== body.path)
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, removedFromRecent: 1, keptTasks: 2 }),
    })
  })
  await page.route('**/api/project-startup/suggestions', (route) => {
    const body = JSON.parse(route.request().postData() || '{}')
    startupCalls.push(body)
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, suggestions: body.projectPath ? SUGGESTIONS : [], model: 'fixture', analyzedAt: Date.now(), scannedDirs: 3 }),
    })
  })
  await page.route('**/api/run-npm-script', (route) => {
    npmLaunchCalls.push(JSON.parse(route.request().postData() || '{}'))
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) })
  })
  // 工具检测：**桩死**，否则"已装/未装"取决于跑探针的那台机器，断言会飘。
  // vscode/claude 装、其余没装 → 一次跑完"能打开"与"弹安装引导"两条路径。
  await page.route('**/api/check-tools', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      success: true, vscode: true, claude: true, codex: false, opencode: false,
      codebuddy: false, pi: false, kimi: false, zcode: false, dsh: false,
      platform: 'win32', installers: {}, versions: {},
    }),
  }))
  const vscodeOpenCalls = []
  await page.route('**/api/open-directory-with-vscode', (route) => {
    vscodeOpenCalls.push(JSON.parse(route.request().postData() || '{}'))
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, message: '已用 VSCode 打开目录' }) })
  })
  const piOpenCalls = []
  await page.route('**/api/open-directory-with-pi', (route) => {
    piOpenCalls.push(JSON.parse(route.request().postData() || '{}'))
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) })
  })

  const toasts = () => page.evaluate(() => Array.from(document.querySelectorAll('.el-message')).map(n => (n.textContent || '').trim()))
  const hasToast = async (s) => (await toasts()).some(t => t.includes(s))
  const waitToast = (s, timeout = 8000) => waitUntil(async () => await hasToast(s), timeout)
  const clearToasts = () => page.evaluate(() => document.querySelectorAll('.el-message').forEach(n => n.remove()))
  const pmRows = page.locator('.pm-item')
  const rowByName = (name) => pmRows.filter({ has: page.locator('.pm-item__name', { hasText: name }) }).first()
  /**
   * 弹窗"在不在"必须量**可见性**：CommonDialog 没开 destroy-on-close，
   * 关掉之后 `.el-dialog` 节点仍留在 DOM 里（只是 display:none）——
   * 数节点会得到"恒等于 1"，删除/提交之后照样绿（恒绿断言，反向也抓不出来）。
   */
  const addDialogVisible = async () => {
    const dlg = page.locator('.pm-add-dialog')
    if ((await dlg.count()) === 0) return false
    return await dlg.first().isVisible()
  }

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 25000 })

    // ── P0 入口 ───────────────────────────────────────────────────────
    const entryBtn = page.locator('.activity-btn[aria-label="项目管理"]')
    check('P0a 活动栏有「项目管理」入口', (await entryBtn.count()) === 1, `count=${await entryBtn.count()}`)
    await entryBtn.first().click()
    const pmOk = await waitUntil(async () => (await page.locator('.pm').count()) === 1, 15000)
    check('P0b 点开渲染出项目管理视图', pmOk)
    check('P0c 护栏：应用外壳仍在（不是整页挂掉）', (await page.locator('.activity-bar').count()) === 1)
    if (!pmOk) throw new Error('项目管理视图没渲染出来')

    // ── P0d 推荐区在项目列表**上面**（本轮用户明确要求） ────────────────
    const recAbove = await page.evaluate(() => {
      const rec = document.querySelector('.pm-rec')
      const list = document.querySelector('.pm-list__items') || document.querySelector('.pm-list')
      if (!rec || !list) return null
      // DOM 顺序 + 几何各判一次：只看 DOM 顺序会被 CSS 的 order/direction 骗过，
      // 只看几何会在"两边都还没渲染完"时给出假绿
      const domBefore = !!(rec.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING)
      return { domBefore, recTop: rec.getBoundingClientRect().top, listTop: list.getBoundingClientRect().top }
    })
    check('P0d 推荐添加上移：在项目列表上方（DOM 顺序 + 几何）',
      !!recAbove && recAbove.domBefore && recAbove.recTop < recAbove.listTop,
      JSON.stringify(recAbove))

    // ── P1 列表 ───────────────────────────────────────────────────────
    await waitUntil(async () => (await pmRows.count()) >= 3, 15000)
    check('P1a 渲染出 3 个项目行', (await pmRows.count()) === 3, `rows=${await pmRows.count()}`)
    const alphaText = await rowByName('alpha-repo').textContent()
    check('P1b 行里有分支与进度', /main/.test(alphaText) && /3\/4 任务完成/.test(alphaText), alphaText.replace(/\s+/g, ' ').slice(0, 90))
    check('P1c 行里有完整路径', alphaText.includes(P_ALPHA))
    check('P1d 目录不存在的项目标了 chip', (await rowByName('gone-repo').locator('.pm-chip--missing').count()) === 1)
    check('P1e 当前项目的行有当前标记', (await rowByName('alpha-repo').locator('.pm-chip--current').count()) === 1)
    await page.screenshot({ path: path.join(SHOT_DIR, 'pm-list.png') })

    // ── P1f 卡片正面不再摆工具图标（用户 2026-10-16：太多了，看着好乱） ──
    const cardToolIcons = await page.locator('.pm-item .pm-tool').count()
    check('P1f 卡片正面没有工具图标（全部收回「…」菜单）', cardToolIcons === 0, `count=${cardToolIcons}`)
    const cardActionCount = await rowByName('alpha-repo').locator('.pm-item__action').count()
    check('P1f2 卡片上只剩 3 颗管理按钮（启动方式 / 打开方式 / 删除）',
      cardActionCount === 3, `count=${cardActionCount}`)

    // 用户明确不要"圆角 + 单 border"的卡片：行与推荐带都不许有边框
    const borders = await page.evaluate(() => {
      const read = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const cs = getComputedStyle(el)
        return { top: cs.borderTopWidth, left: cs.borderLeftWidth, right: cs.borderRightWidth, bottom: cs.borderBottomWidth }
      }
      return { item: read('.pm-item'), rec: read('.pm-rec') }
    })
    const noBorder = (b) => !!b && [b.top, b.left, b.right, b.bottom].every(w => w === '0px')
    check('P1i 项目行与推荐带都是平铺（无 border），不是"圆角卡片"',
      noBorder(borders.item) && noBorder(borders.rec), JSON.stringify(borders))

    // ── P1j..P1l 一行多张卡片（响应式网格） ─────────────────────────────
    // 「每行多展示一些卡片」是用户明确要求（2026-10-16 澄清：不是卡片里多塞内容）。
    const gridInfo = () => page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.pm-item'))
      if (!items.length) return null
      const rows = new Map()
      for (const el of items) {
        const r = el.getBoundingClientRect()
        const key = Math.round(r.top)
        if (!rows.has(key)) rows.set(key, [])
        rows.get(key).push({ left: r.left, right: r.right })
      }
      const first = rows.get(Math.round(items[0].getBoundingClientRect().top)) || []
      first.sort((a, b) => a.left - b.left)
      return {
        perRow: first.length,
        rowCount: rows.size,
        itemCount: items.length,
        // 同一行里的卡片不许压在一起
        overlaps: first.some((c, i) => i > 0 && c.left < first[i - 1].right - 0.5),
      }
    })

    // 探针视口 1500px（含 48px 活动栏）→ 网格 minmax(420px) 应当排出多列
    const wide = await gridInfo()
    check('P1j 宽屏下一行放多张卡片（每行 ≥2 张、行数 < 卡片数）',
      !!wide && wide.perRow >= 2 && wide.rowCount < wide.itemCount,
      JSON.stringify(wide))
    check('P1k 同一行的卡片互不重叠', !!wide && !wide.overlaps, JSON.stringify(wide))

    // 响应式：窄下来自然回到单列（证明列数是"按页面宽度"来的，不是写死的）
    await page.setViewportSize({ width: 900, height: 950 })
    await sleep(400)
    const narrow = await gridInfo()
    check('P1l 窄屏（900px）退回单列', !!narrow && narrow.perRow === 1, JSON.stringify(narrow))
    await page.setViewportSize({ width: 1500, height: 950 })
    await sleep(400)

    // ── P6 启动方式懒加载（先量"初始 0 次"，再展开） ───────────────────
    const withPath = () => startupCalls.filter(b => b.projectPath)
    check('P6a 初始没有任何带 projectPath 的分析请求（没展开就没请求）',
      (REVERSE ? withPath().length > 0 : withPath().length === 0),
      `带 projectPath 的请求=${withPath().length}`)

    const alphaStartupBtn = rowByName('alpha-repo').locator('button[aria-label^="展开启动方式"]')
    await alphaStartupBtn.click()
    const analyzed = await waitUntil(async () => withPath().length >= 1, 12000)
    check('P6b 展开那一行后发出 1 次分析请求，且 body.projectPath = 该行路径',
      analyzed && withPath().length === 1 && withPath()[0].projectPath === P_ALPHA,
      JSON.stringify(withPath()))
    const sugOk = await waitUntil(async () => (await rowByName('alpha-repo').locator('.suggestion-item').count()) === 1, 8000)
    check('P6c 建议渲染在该行下面（复用 AI 启动建议面板）', sugOk)
    // 反向：--reverse 时期望"挂载即请求"，此时 P6a 已经红 —— 这里不再重复判
    if (sugOk) {
      await rowByName('alpha-repo').locator('.suggestion-item').first().locator('button').first().click()
      const launched = await waitUntil(async () => npmLaunchCalls.length === 1, 8000)
      check('P6d 点「启动」→ run-npm-script 收到 packagePath + scriptName',
        launched && npmLaunchCalls[0].packagePath === P_ALPHA && npmLaunchCalls[0].scriptName === 'dev',
        JSON.stringify(npmLaunchCalls))
    }

    // ── P7 打开方式菜单（复用共享菜单） ────────────────────────────────
    await rowByName('beta-repo').locator('button[aria-label^="打开方式"]').click()
    const menuOk = await waitUntil(async () => (await page.locator('.proj-menu').count()) === 1, 8000)
    check('P7a 行内「打开方式」菜单能打开', menuOk)
    if (menuOk) {
      const labels = (await page.locator('.proj-menu .proj-menu__label').allTextContents()).map(s => s.trim())
      check('P7b 菜单项与工作台同一份（含复制两项与用工具打开）',
        labels.includes('在文件管理器中打开') && labels.includes('复制文件夹名称') && labels.includes('用 VSCode 打开'),
        `共 ${labels.length} 项`)

      // 工具打开这条链路现在只走菜单（卡片正面不再摆图标）—— 两条分支都在这里守：
      // 已装工具（默认档）直开、未装工具弹安装引导且不发打开请求。
      await page.locator('.proj-menu__item', { hasText: '用 VSCode 打开' }).first().click()
      const menuOpened = await waitUntil(async () => vscodeOpenCalls.length === 1, 8000)
      check('P7c 菜单里点「用 VSCode 打开」→ 对应端点收到该行路径（不带 permissionMode）',
        menuOpened && vscodeOpenCalls[0].path === P_BETA && !vscodeOpenCalls[0].permissionMode,
        JSON.stringify(vscodeOpenCalls))
      await waitUntil(async () => (await page.locator('.proj-menu').count()) === 0, 5000)

      await rowByName('beta-repo').locator('button[aria-label^="打开方式"]').click()
      await waitUntil(async () => (await page.locator('.proj-menu').count()) === 1, 8000)
      await page.locator('.proj-menu__item', { hasText: '用 Pi Agent 打开' }).first().click()
      const installShown = await waitUntil(async () => {
        const dlg = page.locator('.tool-install-dialog')
        return (await dlg.count()) > 0 && await dlg.first().isVisible()
      }, 8000)
      check('P7d 菜单里点未装的工具 → 弹安装引导', installShown)
      check('P7e 未装工具不发打开请求', piOpenCalls.length === 0, JSON.stringify(piOpenCalls))
      await page.keyboard.press('Escape')
      await waitUntil(async () => {
        const dlg = page.locator('.tool-install-dialog')
        return (await dlg.count()) === 0 || !(await dlg.first().isVisible())
      }, 5000)
      await waitUntil(async () => (await page.locator('.proj-menu').count()) === 0, 5000)
    }

    // ── P3 取消删除（先做取消，避免列表被改） ──────────────────────────
    clearToasts()
    await rowByName('beta-repo').locator('button[aria-label^="从清单移除"]').click()
    const boxOk = await waitUntil(async () => (await page.locator('.el-message-box').count()) === 1, 8000)
    check('P3a 弹出确认框', boxOk)
    check('P3b 确认框里写明了任务不会被删', /任务不会被删除/.test(await page.locator('.el-message-box').textContent()))
    await page.locator('.el-message-box__btns button', { hasText: '取消' }).first().click()
    await waitUntil(async () => (await page.locator('.el-message-box').count()) === 0, 5000)
    await sleep(300)
    check('P3c 取消后一个 remove 请求都没发',
      REVERSE ? removeCalls.length > 0 : removeCalls.length === 0,
      `removeCalls=${removeCalls.length}`)

    // ── P2 删除活项目 ─────────────────────────────────────────────────
    clearToasts()
    await rowByName('beta-repo').locator('button[aria-label^="从清单移除"]').click()
    await waitUntil(async () => (await page.locator('.el-message-box').count()) === 1, 8000)
    await page.locator('.el-message-box__btns button', { hasText: '移除' }).first().click()
    const removed = await waitUntil(async () => removeCalls.length === 1, 8000)
    check('P2a /projects/remove 收到该项目的路径', removed && removeCalls[0].path === P_BETA, JSON.stringify(removeCalls))
    // ⚠️ 必须等这条 toast 真的出现：上面那个 waitUntil 只等到"请求被发出"，
    //    响应回来之前查 .el-message 一定是空的（第一版就踩了这个竞态）
    check('P2b 提示里说清了任务仍保留', await waitToast('2 条任务仍保留'), JSON.stringify(await toasts()))
    const shrank = await waitUntil(async () => (await pmRows.count()) === 2, 8000)
    check('P2c 删除后列表就地刷新（行数 3 → 2）', shrank, `rows=${await pmRows.count()}`)
    clearToasts()

    // ── P4 添加项目（成功） ───────────────────────────────────────────
    // 让它重新出现，好断言"加完列表里有它"（服务端真实行为也是这样：加进 recentDirectories）
    addResponse = { success: true, alreadyKnown: false }
    await page.locator('.pm__add').click()
    const dlgOk = await waitUntil(addDialogVisible, 8000)
    check('P4a 弹窗打开', dlgOk)
    await page.locator('.pm-add__input input').fill(P_NEW)
    // 补一条进夹具，模拟服务端把新项目放进清单
    projectsFixture = [...projectsFixture, entry('new-repo', P_NEW)]
    await page.locator('.pm-add-dialog button', { hasText: '添加' }).first().click()
    const added = await waitUntil(async () => addCalls.length === 1, 8000)
    check('P4b /projects/add 收到该路径', added && addCalls[0].path === P_NEW, JSON.stringify(addCalls))
    check('P4c 成功 toast', await waitToast('已添加到项目列表'), JSON.stringify(await toasts()))
    const closed = await waitUntil(async () => !(await addDialogVisible()), 8000)
    check('P4d 成功后弹窗关闭', closed)
    const grown = await waitUntil(async () => (await pmRows.count()) === 3, 8000)
    check('P4e 列表刷新后能看到新项目', grown, `rows=${await pmRows.count()}`)
    clearToasts()

    // ── P4r 添加失败：不关窗 ──────────────────────────────────────────
    addResponse = { success: false, error: '该路径不是一个存在的目录' }
    await page.locator('.pm__add').click()
    await waitUntil(addDialogVisible, 8000)
    await page.locator('.pm-add__input input').fill('Z:\\zen-verify\\nope')
    await page.locator('.pm-add-dialog button', { hasText: '添加' }).first().click()
    const failed = await waitToast('该路径不是一个存在的目录')
    check('P4r1 失败时透传服务端错误文案', failed, JSON.stringify(await toasts()))
    await sleep(400)
    const stillOpen = await addDialogVisible()
    check('P4r2 失败后弹窗仍然打开（不丢用户输入）',
      REVERSE ? !stillOpen : stillOpen, `stillOpen=${stillOpen}`)
    check('P4r3 输入框里的路径还在', (await page.locator('.pm-add__input input').inputValue()) === 'Z:\\zen-verify\\nope')
    clearToasts()

    // ── P4r2b alreadyKnown ────────────────────────────────────────────
    addResponse = { success: true, alreadyKnown: true }
    await page.locator('.pm-add__input input').fill(P_ALPHA)
    await page.locator('.pm-add-dialog button', { hasText: '添加' }).first().click()
    check('P4r2b 已在清单里 → 提示"已在项目列表中"', await waitToast('该目录已在项目列表中'),
      JSON.stringify(await toasts()))
    clearToasts()

    // ── P5 推荐列表 ───────────────────────────────────────────────────
    addResponse = { success: true, alreadyKnown: false }   // 推荐项是"还没加进来"的，别沿用上一轮的 alreadyKnown
    const recRows = page.locator('.pm-rec__item')
    check('P5a 推荐列表渲染出 2 条', (await recRows.count()) === 2, `rows=${await recRows.count()}`)
    const before = addCalls.length
    await recRows.first().locator('.pm-rec__add').click()
    const recAdded = await waitUntil(async () => addCalls.length === before + 1, 8000)
    check('P5b 一键添加发的是这一行的路径',
      recAdded && addCalls[addCalls.length - 1].path === 'Z:\\zen-verify\\rec-one',
      JSON.stringify(addCalls[addCalls.length - 1]))
    check('P5c 该行变成「已添加」', await waitUntil(async () => (await recRows.locator('.pm-rec__added').count()) === 1, 5000))
    clearToasts()

    await page.screenshot({ path: path.join(SHOT_DIR, 'pm-final.png'), fullPage: true })
  } finally {
    await browser.close()
  }

  const noisy = (t) => /favicon|ERR_|net::|ResizeObserver|Download the Vue/.test(t)
  const realErrors = [...pageErrors, ...consoleErrors].filter((t) => !noisy(t))
  check('P8 无 console / page 错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

  const failed = results.filter((r) => !r.ok)
  console.log('')
  if (pageErrors.length) pageErrors.slice(0, 5).forEach((e) => console.log('  ! ' + e.slice(0, 200)))

  const MUST_FAIL_IN_REVERSE = [
    'P3c 取消后一个 remove 请求都没发',
    'P4r2 失败后弹窗仍然打开（不丢用户输入）',
    'P6a 初始没有任何带 projectPath 的分析请求（没展开就没请求）',
  ]

  console.log(`用例 ${results.length}，通过 ${results.length - failed.length}，失败 ${failed.length}`
    + (REVERSE ? '（--reverse：下面这几条必须红）' : ''))
  console.log('截图:', SHOT_DIR)

  let okOverall
  if (REVERSE) {
    const notRed = MUST_FAIL_IN_REVERSE.filter((n) => results.find((r) => r.name === n)?.ok !== false)
    okOverall = notRed.length === 0
    console.log(okOverall
      ? '反向验证通过：三条行为契约确实被断言挡下'
      : '反向验证失败：这几条居然过关 —— 断言守错了地方：' + notRed.join(' / '))
  } else {
    okOverall = failed.length === 0
    console.log(okOverall ? '[verify] 合计 PASS' : '[verify] 有失败')
  }
  process.exit(okOverall ? 0 : 1)
}

main().catch((e) => { console.error('脚本异常', e.message); process.exit(1) })

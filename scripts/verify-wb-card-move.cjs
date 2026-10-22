/**
 * 看板「待处理」卡片右键 → 移动到其他项目 的验证（2026-10-22）。
 *
 * 背景：多项目编排台的看板按项目筛选，「这条任务归错项目了"只能删了重建。
 * 现在待处理列的卡片右键弹出「移动到其他项目」，选一个项目即把任务的
 * projectPath 改过去（POST /api/workbench/tasks/:id/move）。
 *
 * 验收契约（改这块时别破坏）：
 *   A 右键待处理卡：弹出菜单，标题是「移动到其他项目」；全局只有一份菜单实例
 *     （33 张卡各挂一份弹窗是踩过的坑，这里连 v-for 的痕迹都不该有）
 *   B 候选项目 = 除**这张卡自己所属项目**外的全部项目。按 canonicalProjectPath
 *     比较：卡片的 projectPath 与项目路径大小写/斜杠写法不同，也认作同一个，
 *     不得把"当前项目"列出来（点了什么都不会发生的假选项）
 *   C 排除口径是**按任务**、不是按应用当前项目：B 项目的卡右键，候选里出现的是
 *     A 项目（即便 A 才是当前项目）—— 否则"全部项目"视图下每张卡的候选都一样
 *   D 只有待处理列开放：进行中 / 已完成的卡右键不弹菜单（在跑的换了项目，
 *     这一轮还在旧目录里跑，后端也会拒；已完成的是历史）
 *   E 点候选项目：POST /api/workbench/tasks/<任务id>/move，body.projectPath 是
 *     项目的**原始路径**（落库用原串，与 buildProjectEntries"首次出现的写法"一致；
 *     发归一化 key 会让界面上的路径随比较规则漂移），成功后 toast「已移动到」
 *   F 菜单开着时点别处：菜单关闭，且一个请求都不发（负控）
 *   G 服务端拒绝（400 正在执行）：原话透出，不吞成笼统的"移动失败"（负控）
 *   H 贴屏显右下角右键：菜单被夹回视口内，不溢出屏幕（几何）
 *   I 页面无 console / page 错误
 *
 * 为什么没有 --reverse：这个功能是**行为**（contextmenu 处理器 + 一次 fetch），
 * 不是数据形状 —— 参照 verify-wb-card-done 文件头对其自身反证限度的说明：
 * SFC 跑在 vite dev server 里，DOM 探针换不掉事件处理器，"功能之前的状态"
 * 无法用注入数据还原。负控交给 D/F/G 三组（它们守的是"不该发生时不发生"）。
 *
 * 前置：dev server 已启动（vite 5544，`npm run dev:ping` 两个 OK）。
 * 后端**不需要** —— 所有 /api 都由 page.route 打桩，不碰真进程、不碰用户真任务。
 * 用法：node scripts/verify-wb-card-move.cjs
 * 退出码：0 全通过，1 有失败项。
 */
const fs = require('node:fs')
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
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

/** 轮询等待而不是 sleep 一个拍脑袋的时长（同 verify-wb-card-done） */
async function waitFor(fn, ms = 8000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await sleep(100)
  }
}

/** 应用当前所在项目（左栏"当前"标记 + 新建任务的默认落点） */
const P1 = 'D:\\ws\\zen-gitsync'
/** 另一个项目（移动的目标） */
const P2 = 'D:\\ws\\todo'
/** 服务端在"任务正在执行"时回的那句话（routes/workbench/index.js §11.5） */
const BUSY_ERROR = '该任务正在执行,请先停止再移动'

/**
 * 四张卡 + 两个项目，把该演的都演出来：
 *   syn-todo       待处理，归属 P1 —— 但 projectPath 用**另一种写法**（小写盘符 +
 *                  正斜杠），逼实现走 canonicalProjectPath 比较而不是原串
 *   syn-other-todo 待处理，归属 P2 —— 验证排除口径按任务而非应用当前项目
 *   syn-run        进行中（有 live）—— 右键不该弹菜单
 *   syn-done       已完成 —— 右键不该弹菜单
 */
function fixture() {
  const at = (minAgo) => new Date(Date.now() - minAgo * 60 * 1000).toISOString()
  const board = [
    {
      id: 'syn-todo', title: '【合成】T：待处理', desc: '', projectPath: 'd:/ws/zen-gitsync',
      column: 'todo', attachmentCount: 0, runningJobs: 0, live: null,
      lastReply: '', lastJobAgent: 'claude', lastJobStatus: null,
      lastJobEndedAt: null, manualDoneAt: null, createdAt: at(30), updatedAt: at(30),
    },
    {
      id: 'syn-other-todo', title: '【合成】O：P2 的待处理', desc: '', projectPath: P2,
      column: 'todo', attachmentCount: 0, runningJobs: 0, live: null,
      lastReply: '', lastJobAgent: 'claude', lastJobStatus: null,
      lastJobEndedAt: null, manualDoneAt: null, createdAt: at(40), updatedAt: at(40),
    },
    {
      id: 'syn-run', title: '【合成】R：进行中', desc: '', projectPath: P1,
      column: 'doing', attachmentCount: 0, runningJobs: 1,
      live: {
        jobId: 'syn-run-job', status: 'running', agent: 'claude', startedAt: at(3), pid: 4242,
        elapsedMs: 3 * 60 * 1000, toolCallCount: 12, lastTool: 'Edit src/ui/client/src/views/components/WorkbenchKanban.vue',
        toolMix: 'Edit×8 · Read×4', lastThought: '把这条规则的收尾补上',
        lastLine: '正在给卡片补移动到其他项目', silentMs: null,
      },
      lastReply: null, lastJobAgent: 'claude', lastJobStatus: 'running',
      lastJobEndedAt: null, manualDoneAt: null, createdAt: at(60), updatedAt: at(3),
    },
    {
      id: 'syn-done', title: '【合成】N：已完成', desc: '', projectPath: P1,
      column: 'done', attachmentCount: 0, runningJobs: 0, live: null,
      lastReply: '改完了，要 push 吗？', lastJobAgent: 'claude', lastJobStatus: 'done',
      lastJobEndedAt: at(5), manualDoneAt: null, createdAt: at(120), updatedAt: at(5),
    },
  ]
  // 编辑器（弹窗）用的是 Task 形态，与看板的 BoardTask 不是同一个接口，各给一份
  const tasks = board.map(t => ({
    id: t.id, title: t.title, desc: t.desc, promptId: null, simpleOverride: '',
    projectPath: t.projectPath, status: t.column, attachments: [],
    createdAt: t.createdAt, updatedAt: t.updatedAt,
  }))
  const mkProject = (p, name, isCurrent) => ({
    path: p, key: p.toLowerCase(), name, source: 'both', isCurrent,
    git: null, iconUrl: null,
    stats: { total: 2, todo: 1, doing: 1, done: 1, progress: 25, runningJobs: 1, lastActiveAt: at(3) },
  })
  const projects = [mkProject(P1, 'zen-gitsync', true), mkProject(P2, 'todo', false)]
  return { board, tasks, projects }
}

/** 读菜单：是否存在、标题、候选（纯文本）、几何与视口关系 */
function readMenu(page) {
  return page.evaluate(() => {
    const all = [...document.querySelectorAll('.kb-move-menu')]
    const m = all[0]
    if (!m) return { found: false, count: all.length }
    const r = m.getBoundingClientRect()
    return {
      found: true,
      count: all.length,
      head: (m.querySelector('.kb-move-menu__head')?.textContent || '').trim(),
      items: [...m.querySelectorAll('.kb-move-menu__item')]
        .map(b => b.textContent.replace(/\s+/g, ' ').trim()),
      titles: [...m.querySelectorAll('.kb-move-menu__item')].map(b => b.getAttribute('title')),
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      vw: window.innerWidth, vh: window.innerHeight,
    }
  })
}

/** 当前所有 toast 的文案（ElMessage 3s 后自己消失，要读得快） */
function readToasts(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.el-message')].map(n => n.innerText.replace(/\s+/g, ' ').trim()))
}

/** 在卡片上派发一次合成 contextmenu（H 组贴角用例要用：真鼠标点不到那个位置） */
async function synthContextMenu(page, taskId, x, y) {
  await page.evaluate(({ id, cx, cy }) => {
    const el = document.querySelector(`.kb-card[data-task-id="${id}"]`)
    if (!el) throw new Error(`card ${id} not found`)
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: cx, clientY: cy,
    }))
  }, { id: taskId, cx: x, cy: y })
}

async function main() {
  const { board, tasks, projects } = fixture()

  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox'],
  })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage()

  /**
   * G 组故意让服务端回 400（那就是真实响应）—— Chrome 会为此往 console 写一条
   * "Failed to load resource"。它是**我们要求的**失败，不是页面出错；
   * I 组守的是"没有意料之外的 console 错误"，所以只在 G 组期间放行这一类。
   */
  let allowExpected400 = false
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const text = m.text()
    if (allowExpected400 && /Failed to load resource/.test(text)) return
    consoleErrors.push(text)
  })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  /** 拦到的 move 请求（方法 + URL + body），B/E 两组断言它 */
  const moveCalls = []
  /** G 组要换的应答：默认成功 */
  let moveReply = { status: 200, body: { success: true, task: tasks[0] } }

  try {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('wb.boardView.v1', 'kanban')
        // 预置「全部项目」：全新上下文里 savedSelection === null 时 applyDefaultSelection()
        // 会把选中项落到「当前项目」，那张 P2 的卡就看不见了
        localStorage.setItem('wb.boardProject.v1', '')
      } catch { /* 隐私模式 */ }
    })
    const json = (route, body) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(body),
    })
    await page.route('**/api/workbench/projects*', (route) =>
      json(route, { success: true, projects, tasks: board, currentProjectPath: P1 }))
    // 编辑器弹窗要用的几个接口也拦掉：点卡片会开编辑器，它一开就拉这些，
    // 失败会在控制台刷红，把 I 那条（无 console 错误）带崩
    await page.route('**/api/workbench/tasks*', (route) => json(route, { tasks }))
    await page.route('**/api/workbench/jobs*', (route) => json(route, { jobs: [] }))
    await page.route('**/api/workbench/current-project*', (route) => json(route, { path: P1 }))
    // ⚠️ 这条**必须**注册在上面那条通配 `**/api/workbench/tasks*` 之后：
    // playwright 的路由是后注册的先匹配，反过来就被通配那条吞掉，move 请求永远拦不到
    await page.route('**/api/workbench/tasks/*/move', (route) => {
      moveCalls.push({
        line: `${route.request().method()} ${route.request().url()}`,
        body: route.request().postDataJSON(),
      })
      return route.fulfill({
        status: moveReply.status,
        contentType: 'application/json',
        body: JSON.stringify(moveReply.body),
      })
    })

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.kb-card', { timeout: 15000 })
    await page.locator('.proj-item--all').first().click()
    await page.waitForSelector('.kb-card[data-task-id="syn-todo"]', { timeout: 15000 })
    await page.waitForSelector('.kb-card[data-task-id="syn-other-todo"]', { timeout: 15000 })
    await sleep(800)

    const card = (id) => page.locator(`.kb-card[data-task-id="${id}"]`)
    /** 真鼠标右键（避开右下角操作组：点位取卡片左上角内侧） */
    const rightClick = async (id) => {
      await card(id).click({ button: 'right', position: { x: 30, y: 14 } })
      await sleep(250)
    }

    // ── A 右键待处理卡：菜单出现 + 全局一份 ────────────────────────
    await rightClick('syn-todo')
    let menu = await readMenu(page)
    check('A1 右键待处理卡弹出「移动到其他项目」菜单', menu.found, JSON.stringify(menu).slice(0, 120))
    check('A2 菜单标题是「移动到其他项目」', (menu.head || '').includes('移动到其他项目'), `head=${menu.head}`)
    check('A3 ★ 全局只有一份菜单实例（不随卡片数量增长）', menu.count === 1, `count=${menu.count}`)

    // ── B 候选 = 除这张卡自己项目外的全部（写法不同也是同一个） ────
    check('B1 候选里出现 P2（todo）', (menu.items || []).some(t => t.includes('todo')), JSON.stringify(menu.items))
    check('B2 ★ 候选里没有 P1（卡片的 projectPath 是另一种写法，按 canonical 比较）',
      !(menu.items || []).some(t => t.includes('zen-gitsync')), JSON.stringify(menu.items))
    check('B3 候选项的悬停提示是项目原始路径', (menu.titles || []).includes(P2), JSON.stringify(menu.titles))

    // ── E 点候选：POST + 原串 + toast ─────────────────────────────
    await page.locator('.kb-move-menu__item', { hasText: 'todo' }).first().click()
    const moved = await waitFor(() => moveCalls.length > 0)
    check('E1 点候选后发出了移动请求', moved, `calls=${JSON.stringify(moveCalls)}`)
    check('E2 ★ 打的是 POST /api/workbench/tasks/<任务id>/move',
      moveCalls.length === 1 && /^POST .*\/api\/workbench\/tasks\/syn-todo\/move$/.test(moveCalls[0]?.line || ''),
      moveCalls[0]?.line || '')
    check('E3 ★ body.projectPath 是项目原始路径（不是归一化 key）',
      moveCalls[0]?.body?.projectPath === P2, JSON.stringify(moveCalls[0]?.body))
    const okToast = await waitFor(async () => (await readToasts(page)).some(t => t.includes('已移动到')))
    check('E4 成功后有反馈（已移动到「todo」）',
      okToast && (await readToasts(page)).some(t => t.includes('todo')), JSON.stringify(await readToasts(page)))
    await waitFor(async () => !(await readMenu(page)).found)

    // ── C 排除口径按任务：P2 的卡，候选是 P1 ───────────────────────
    await rightClick('syn-other-todo')
    menu = await readMenu(page)
    check('C1 P2 的卡右键也弹菜单（排除口径与列无关）', menu.found)
    check('C2 ★ 候选里是 P1（zen-gitsync）—— 按任务归属排除，不是按应用当前项目',
      (menu.items || []).some(t => t.includes('zen-gitsync')) && !(menu.items || []).some(t => t.includes('todo')),
      JSON.stringify(menu.items))
    await page.keyboard.press('Escape')
    await waitFor(async () => !(await readMenu(page)).found)

    // ── D 只有待处理列开放 ────────────────────────────────────────
    await rightClick('syn-run')
    check('D1 右键「进行中」卡不弹菜单（在跑的换了项目，这一轮还在旧目录里跑）',
      !(await readMenu(page)).found)
    await rightClick('syn-done')
    check('D2 右键「已完成」卡不弹菜单（那是历史）', !(await readMenu(page)).found)

    // ── F 菜单开着时点别处：关闭且不发请求（负控） ────────────────
    // “别处”取列头：那里没有任何点击处理器（取 (4,4) 会点到活动栏按钮，把视图切走）
    moveCalls.length = 0
    await rightClick('syn-todo')
    check('F1 菜单重新弹出', (await readMenu(page)).found)
    await page.locator('.kb-col__head').first().click()
    const closed = await waitFor(async () => !(await readMenu(page)).found)
    await sleep(500) // 反向等一小段：请求真发出去的话，本地回环在 500ms 内必到
    check('F2 点别处菜单关闭', closed)
    check('F3 点别处一个请求都不发（负控）', moveCalls.length === 0, `calls=${JSON.stringify(moveCalls)}`)

    // ── G 服务端拒绝：原话透出（负控） ────────────────────────────
    moveReply = { status: 400, body: { success: false, error: BUSY_ERROR } }
    allowExpected400 = true // 见 page.on('console') 那段：这条 400 是我们要的
    await waitFor(async () => (await readToasts(page)).length === 0)
    await rightClick('syn-todo')
    await page.locator('.kb-move-menu__item', { hasText: 'todo' }).first().click()
    const told = await waitFor(async () => (await readToasts(page)).some(t => t.includes(BUSY_ERROR)))
    check('G1 服务端的原话被透出（不是笼统的"移动失败"）', told, JSON.stringify(await readToasts(page)))
    allowExpected400 = false
    moveReply = { status: 200, body: { success: true, task: tasks[0] } }
    await waitFor(async () => !(await readMenu(page)).found)

    // ── H 贴屏显右下角右键：菜单夹回视口内 ────────────────────────
    const vp = page.viewportSize()
    await synthContextMenu(page, 'syn-todo', vp.width - 4, vp.height - 4)
    await sleep(300)
    menu = await readMenu(page)
    check('H1 贴角右键菜单仍弹出', menu.found)
    check('H2 ★ 菜单被夹回视口内（不溢出屏幕）',
      menu.found && menu.rect.right <= menu.vw + 1 && menu.rect.bottom <= menu.vh + 1
        && menu.rect.left >= -1 && menu.rect.top >= -1,
      menu.found ? `rect=${JSON.stringify(menu.rect)} vw=${menu.vw} vh=${menu.vh}` : 'no menu')
    await page.keyboard.press('Escape')
    await waitFor(async () => !(await readMenu(page)).found)

    check('I1 页面无 console / page 错误', consoleErrors.length === 0 && pageErrors.length === 0,
      [...consoleErrors, ...pageErrors].slice(0, 3).join(' | '))
    return finish(browser, page)
  } catch (err) {
    await browser.close().catch(() => {})
    throw err
  }
}

/** 截图存证 + 打印结论 + 退出码 */
async function finish(browser, page) {
  try {
    const shotDir = path.resolve(__dirname, '../tmp')
    await page.locator('.kb-card[data-task-id="syn-todo"]').click({ button: 'right', position: { x: 30, y: 14 } })
    await sleep(300)
    const menu = page.locator('.kb-move-menu').first()
    if (await menu.count()) {
      const file = path.join(shotDir, 'verify-wb-card-move-menu.png')
      await menu.screenshot({ path: file })
      log('截图:', file)
    }
  } catch (err) {
    log('截图失败（不影响结论）:', err.message)
  }
  await browser.close().catch(() => {})

  const failed = results.filter(r => !r.ok)
  console.log(`\n[verify] ${results.length - failed.length}/${results.length} 通过`)
  for (const f of failed) console.log(`  FAIL  ${f.name}  ::  ${f.extra}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify] 异常退出:', err); process.exit(1) })

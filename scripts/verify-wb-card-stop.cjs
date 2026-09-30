/**
 * 看板卡片「停止」按钮的验证（2026-09-30）。
 *
 * 背景：进行中的卡片此前右下角只有 hover 才浮出的「×」，想停掉一轮只能点开卡片、
 * 在任务编辑器里翻到那个「停止」—— 一条卡了半小时的任务，用户在看板上看着它转却停不掉。
 * 现在在跑的任务 hover 出来的是「停止」，空闲的是「执行」，两者同一个位置、不并排。
 *
 * 验收契约（改这块时别破坏）：
 *   A 在跑的卡片 hover：操作组浮出，里面是「停止」而不是「执行」
 *   B 空闲的卡片 hover：仍是「执行」，没有「停止」（不是整板都变成停止）
 *   C 点「停止」先弹确认框，文案与编辑器那个「停止」**逐字一致**
 *   D 确认后 POST /api/workbench/jobs/<live.jobId>/cancel —— 带的必须是 **job id**：
 *     卡片身上只有任务 id（t.id），写错就打到别的任务上去了，这条正是守它的
 *   E 确认框点「取消」：一个请求都不发
 *   F 服务端拒绝（任务在另一个 g ui 实例里跑 → 404 + 一句明确的话）：原话透出，
 *     不吞成笼统的"停止失败"
 *   G 几何：在跑卡与空闲卡的操作组同宽（正文右侧那 64px 渐隐区是按组宽反推的，
 *     标签一变长就会露出半截按钮），且组左边缘确实落在那 64px 里
 *   H 页面无 console / page 错误
 *   R 负控（--reverse）：把 fixture 换回**没有 live / runningJobs=0 的卡片数据**（即
 *     "这轮执行没有任何在跑的事实"），此时必须看不到「停止」、只剩「执行」。
 *     它在新代码上同样是绿的 —— 它证明的不是"改对了"，而是**A 那组的判据是真的**：
 *     一个写死渲染「停止」的模板也能让 A 变绿，却会让 R 翻红。
 *     （注入点是**服务端给卡片的那份数据** —— 前端唯一真正的输入。SFC 跑在 vite dev
 *     server 里，DOM 探针换不掉它，所以这里做不到 verify-release-self-update 那种
 *     "改叶子函数"式的反证，如实说明。）
 *
 * 为什么 fixture 是手搓的、而不是 import 服务端 decorateTaskForBoard：本脚本验的是
 * "卡片 + hover 交互 + 一次 fetch"，与后端怎么算列无关；手搓还能让它在后端没起时也跑
 * （cancel 请求由 page.route 拦住，不碰真进程）。走真实响应的 verify-wb-card-live / -reply
 * 负责验"服务端给的事实"，职责不重叠。
 *
 * 前置：dev server 已启动（vite 5544，`npm run dev:ping` 两个 OK）。后端**不需要**。
 * 用法：node scripts/verify-wb-card-stop.cjs [--reverse]
 * 退出码：0 全通过，1 有失败项。
 */
const fs = require('node:fs')
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const CHROME = process.env.ZEN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
/** 负控（不是反证）：见文件头 R 段 */
const REVERSE = process.argv.includes('--reverse')

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * 轮询等待，而不是 sleep 一个拍脑袋的时长：
 * 请求要经过「确认弹窗关闭 → fetch → 服务端 → refresh」，固定 sleep 短了会假红、
 * 长了白等（verify-probe-template 那条教训）。窗口给足 8s。
 */
async function waitFor(fn, ms = 8000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await sleep(100)
  }
}

const PROJECT_PATH = 'D:\\ws\\zen-gitsync'
const STOP_MSG = '确认停止执行？已输出的内容会保留。'
/** 服务端在"这个 job 活在另一个 g ui 实例里"时回的那句话（routes/workbench/index.js §14） */
const OTHER_INSTANCE = '这个任务正在另一个 g ui 实例里执行，请到那个窗口停止它'

/**
 * 三条任务：一条在跑（带 live）、两条空闲。
 * runningJobs 与 live 的口径与 decorateTaskForBoard 一致（有 running/pending 的 job 才有 live）。
 * `--reverse` 时把在跑那条退回"没有 live 字段"的旧形态 —— 那次改动之前的看板就是这样的数据。
 */
function fixture() {
  const at = (minAgo) => new Date(Date.now() - minAgo * 60 * 1000).toISOString()
  const running = REVERSE
    ? {
        id: 'syn-run', title: '【合成】R：进行中', desc: '', projectPath: PROJECT_PATH,
        column: 'doing', attachmentCount: 0, runningJobs: 0, live: null,
        lastReply: '', lastJobAgent: 'claude', lastJobStatus: null,
        lastJobEndedAt: null, createdAt: at(60), updatedAt: at(3),
      }
    : {
        id: 'syn-run', title: '【合成】R：进行中', desc: '', projectPath: PROJECT_PATH,
        column: 'doing', attachmentCount: 0, runningJobs: 1,
        live: {
          jobId: 'syn-run-job', status: 'running', agent: 'claude', startedAt: at(3), pid: 4242,
          elapsedMs: 3 * 60 * 1000, toolCallCount: 12, lastTool: 'Edit src/ui/client/src/views/WorkbenchKanban.vue',
          toolMix: 'Edit×8 · Read×4', lastThought: '把这条规则的收尾补上',
          lastLine: '正在给卡片补停止按钮', silentMs: null,
        },
        lastReply: null, lastJobAgent: 'claude', lastJobStatus: 'running',
        lastJobEndedAt: null, createdAt: at(60), updatedAt: at(3),
      }
  const board = [
    {
      id: 'syn-idle', title: '【合成】I：待处理', desc: '', projectPath: PROJECT_PATH,
      column: 'todo', attachmentCount: 0, runningJobs: 0, live: null,
      lastReply: '', lastJobAgent: 'claude', lastJobStatus: null,
      lastJobEndedAt: null, createdAt: at(30), updatedAt: at(30),
    },
    running,
  ]
  // 编辑器（弹窗）用的是 Task 形态，与看板的 BoardTask 不是同一个接口，各给一份
  const tasks = board.map(t => ({
    id: t.id, title: t.title, desc: t.desc, promptId: null, simpleOverride: '',
    projectPath: t.projectPath, status: t.column, attachments: [],
    createdAt: t.createdAt, updatedAt: t.updatedAt,
  }))
  const project = {
    path: PROJECT_PATH, key: PROJECT_PATH.toLowerCase(), name: 'zen-gitsync',
    source: 'both', isCurrent: true, git: null, stats: {
      total: 2, todo: 1, doing: REVERSE ? 0 : 1, done: 0, progress: 0,
      runningJobs: REVERSE ? 0 : 1, lastActiveAt: at(3),
    },
  }
  return { board, tasks, project }
}

/**
 * 读一张卡片的操作组：按钮文案、透明度、几何。
 * `gapToMask` = 操作组左边缘到标题盒右边缘的距离。标题是携带渐隐遮罩的那个元素
 * （.kb-card:hover .kb-card__title 的 mask 在"距右 64px"处就完全透明），
 * 所以这个值必须 ≤ 64，否则按钮会露出半截字形（样式注释里那段推导守的就是它）。
 */
function readCard(page, id) {
  return page.evaluate((taskId) => {
    const el = document.querySelector(`.kb-card[data-task-id="${taskId}"]`)
    if (!el) return { found: false }
    const actions = el.querySelector('.kb-card__actions')
    const title = el.querySelector('.kb-card__title')
    const ar = actions.getBoundingClientRect()
    const tr = title.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return {
      found: true,
      opacity: getComputedStyle(actions).opacity,
      buttons: [...actions.querySelectorAll('.kb-card__btn')].map(b => b.textContent.trim()),
      width: ar.width,
      gapToMask: tr.right - ar.left,
      box: { x: r.x + r.width / 2, y: r.y + r.height / 2 },
    }
  }, id)
}

/** Element Plus 的确认框；返回 { open, text } */
function readConfirm(page) {
  return page.evaluate(() => {
    const box = document.querySelector('.el-message-box')
    if (!box) return { open: false, text: '' }
    return { open: true, text: box.innerText.replace(/\s+/g, ' ').trim() }
  })
}

/** 当前所有 toast 的文案（ElMessage 3s 后自己消失，F 组要读得快） */
function readToasts(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.el-message')].map(n => n.innerText.replace(/\s+/g, ' ').trim()))
}

/** 点确认框里的某个按钮（按文案找，不按顺序 —— 顺序随 element-plus 版本变过） */
async function clickConfirmButton(page, text) {
  await page.locator('.el-message-box__btns button', { hasText: text }).first().click()
  await sleep(400)
}

async function main() {
  const { board, tasks, project } = fixture()

  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox'],
  })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage()
  /**
   * F 组故意让服务端回 404（那就是真实响应）—— Chrome 会为此往 console 写一条
   * "Failed to load resource: ... 404"。它是**我们要求的**失败，不是页面出错；
   * H 组要守的是"没有意料之外的 console 错误"，所以只在 F 组期间放行这一类。
   */
  let allowExpected404 = false
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const text = m.text()
    if (allowExpected404 && /Failed to load resource/.test(text)) return
    consoleErrors.push(text)
  })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  /** 拦到的 cancel 请求 URL（D / E 两组都断言它） */
  const cancelCalls = []
  /** F 组要换的应答：默认成功 */
  let cancelReply = { status: 200, body: { success: true, message: '已发送停止信号' } }

  try {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('wb.boardView.v1', 'kanban')
        // 预置「全部项目」：全新上下文里 savedSelection === null 时 applyDefaultSelection()
        // 会把选中项落到「当前项目」，这里直接给上两条，省一次点击也少一处时序依赖
        localStorage.setItem('wb.boardProject.v1', '')
      } catch { /* 隐私模式 */ }
    })
    const json = (route, body) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(body),
    })
    await page.route('**/api/workbench/projects*', (route) =>
      json(route, { success: true, projects: [project], tasks: board, currentProjectPath: PROJECT_PATH }))
    // 编辑器弹窗要用的几个接口也拦掉：点卡片会开编辑器，它一开就拉这些，
    // 失败会在控制台刷红，把 H 那条（无 console 错误）带崩
    await page.route('**/api/workbench/tasks*', (route) => json(route, { tasks }))
    await page.route('**/api/workbench/prompts*', (route) => json(route, { prompts: [] }))
    await page.route('**/api/workbench/jobs*', (route) => json(route, { jobs: [] }))
    await page.route('**/api/workbench/current-project*', (route) => json(route, { path: PROJECT_PATH }))
    // ⚠️ 这条**必须**注册在上面那条通配 `**/api/workbench/jobs*` 之后：
    // playwright 的路由是后注册的先匹配，反过来就被通配那条吞掉，cancel 永远拦不到
    await page.route('**/api/workbench/jobs/*/cancel', (route) => {
      cancelCalls.push(route.request().url())
      return route.fulfill({
        status: cancelReply.status,
        contentType: 'application/json',
        body: JSON.stringify(cancelReply.body),
      })
    })

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.kb-card', { timeout: 15000 })
    await page.locator('.proj-item--all').first().click()
    await page.waitForSelector('.kb-card[data-task-id="syn-run"]', { timeout: 15000 })
    await sleep(800)

    /** 悬停到卡片正中（读完坐标再动鼠标：DOM 会随轮询重排，边读边动会飘） */
    const hoverCard = async (id) => {
      const box = (await readCard(page, id)).box
      await page.mouse.move(box.x, box.y)
      await sleep(300)
    }
    const hoverAway = async () => {
      await page.mouse.move(4, 4)
      await sleep(300)
    }
    const stopBtn = (id) => page.locator(`.kb-card[data-task-id="${id}"] .kb-card__btn--stop`)

    // ── A / R 在跑的卡片：hover 出来的是「停止」 ────────────────────
    await hoverCard('syn-run')
    const run = await readCard(page, 'syn-run')
    check('A1 hover 时操作组浮出', run.opacity === '1', `opacity=${run.opacity}`)
    if (REVERSE) {
      // 反证：卡片数据里没有 live / runningJobs=0，就不该出现「停止」
      check('R1 负控：卡片不带 live 时不出现「停止」', !run.buttons.includes('停止'), `buttons=${JSON.stringify(run.buttons)}`)
      check('R2 负控：此时是「执行」', run.buttons.includes('执行'), `buttons=${JSON.stringify(run.buttons)}`)
    } else {
      check('A2 在跑的卡片上是「停止」', run.buttons.includes('停止'), `buttons=${JSON.stringify(run.buttons)}`)
      check('A3 同一格不并排「执行」（不能在跑还能再跑一轮）', !run.buttons.includes('执行'), `buttons=${JSON.stringify(run.buttons)}`)
      check('A4 「×」照旧在（停止没有顶掉删除）', run.buttons.includes('×'), `buttons=${JSON.stringify(run.buttons)}`)
    }

    // ── B 空闲的卡片：仍是「执行」 ──────────────────────────────────
    await hoverCard('syn-idle')
    const idle = await readCard(page, 'syn-idle')
    check('B1 空闲卡片上是「执行」', idle.buttons.includes('执行'), `buttons=${JSON.stringify(idle.buttons)}`)
    check('B2 空闲卡片上没有「停止」', !idle.buttons.includes('停止'), `buttons=${JSON.stringify(idle.buttons)}`)

    // ── G 几何：两个标签同宽，组都落在 64px 渐隐区里 ────────────────
    check('G1 在跑卡的操作组落在正文右侧 64px 渐隐区内',
      run.gapToMask <= 64, `gap=${run.gapToMask.toFixed(1)}px`)
    check('G2 空闲卡同理', idle.gapToMask <= 64, `gap=${idle.gapToMask.toFixed(1)}px`)
    // 英文下 Stop 比 Run 宽约 3px，中文两者完全同宽；再大就说明有人换成更长的标签了
    check('G3 「停止」与「执行」的操作组同宽（渐隐距离按组宽反推，不能变胖）',
      Math.abs(run.width - idle.width) <= 6,
      `在跑卡=${run.width.toFixed(1)} 空闲卡=${idle.width.toFixed(1)}`)

    // 两张截图存证，各停在自己的卡片上（同一时刻只有一张卡能被 hover，所以要两张）：
    // 看板里"在跑的那张"与"空闲的那张"各自长什么样，一眼可比
    await hoverCard('syn-run')
    await page.screenshot({ path: path.resolve(__dirname, '../tmp/verify-wb-card-stop.png') })
    log('截图（在跑的那张）:', path.resolve(__dirname, '../tmp/verify-wb-card-stop.png'))
    await hoverCard('syn-idle')
    await page.screenshot({ path: path.resolve(__dirname, '../tmp/verify-wb-card-idle.png') })
    log('截图（空闲的那张）:', path.resolve(__dirname, '../tmp/verify-wb-card-idle.png'))

    if (!REVERSE && !run.buttons.includes('停止')) {
      // 上一组已经红了，这里再点下去只会拿到 30s 的 locator 超时 + 一整屏调用栈，
      // 把真正的失败（卡片上没有那个按钮）埋在末尾。给一条说得清的收尾就够。
      check('C–F 跳过：卡片上没有「停止」按钮可点（见 A 组）', false, `buttons=${JSON.stringify(run.buttons)}`)
    } else if (!REVERSE) {
      // ── C 点「停止」：先弹确认框，文案与编辑器那个停止一致 ─────────
      await hoverCard('syn-run')
      await stopBtn('syn-run').click()
      const dlg = await readConfirm(page)
      check('C1 点「停止」弹出确认框', dlg.open, JSON.stringify(dlg.text).slice(0, 60))
      check('C2 确认框文案与编辑器的「停止」逐字一致', dlg.text.includes(STOP_MSG), dlg.text.slice(0, 80))
      check('C3 点停止没有顺手把任务编辑器打开', (await page.locator('.wb-back-btn').count()) === 0)

      // ── D 确认：POST 到 jobs/<jobId>/cancel ───────────────────────
      await clickConfirmButton(page, '停止')
      const posted = await waitFor(() => cancelCalls.length > 0)
      check('D1 确认后发起了取消请求', posted, `calls=${cancelCalls.length}`)
      check('D2 ★ 打的是 live.jobId 而不是任务 id',
        cancelCalls.length === 1 && /\/api\/workbench\/jobs\/syn-run-job\/cancel$/.test(cancelCalls[0]),
        String(cancelCalls[0] || ''))
      const okToast = await waitFor(async () => (await readToasts(page)).some(t => t.includes('已发送停止信号')))
      check('D3 成功后有反馈（已发送停止信号）', okToast, JSON.stringify(await readToasts(page)))
      check('D4 确认框已关闭', !(await readConfirm(page)).open)

      // ── E 取消：一个请求都不发 ────────────────────────────────────
      cancelCalls.length = 0
      await hoverCard('syn-run')
      await stopBtn('syn-run').click()
      check('E1 再次点「停止」照旧弹确认框', (await readConfirm(page)).open)
      await clickConfirmButton(page, '取消')
      check('E2 确认框已关闭', !(await readConfirm(page)).open)
      // 反向等一小段：请求真发出去的话，本地回环在 800ms 内必到
      await sleep(800)
      check('E3 点「取消」不发任何请求', cancelCalls.length === 0, `calls=${cancelCalls.length}`)

      // ── F 服务端拒绝：原话透出，不吞成"停止失败" ──────────────────
      cancelReply = { status: 404, body: { success: false, error: OTHER_INSTANCE } }
      allowExpected404 = true // 见 page.on('console') 那段：这条 404 是我们要的
      // 先把上一条成功 toast 等消失，否则下面的断言可能读到它
      await waitFor(async () => (await readToasts(page)).length === 0)
      await hoverCard('syn-run')
      await stopBtn('syn-run').click()
      await clickConfirmButton(page, '停止')
      const told = await waitFor(async () => (await readToasts(page)).some(t => t.includes(OTHER_INSTANCE)))
      check('F1 服务端的原话被透出（不是笼统的"停止失败"）', told, JSON.stringify(await readToasts(page)))
      allowExpected404 = false
    }

    await hoverAway()
    check('H1 页面无 console / page 错误', consoleErrors.length === 0 && pageErrors.length === 0,
      [...consoleErrors, ...pageErrors].slice(0, 3).join(' | '))
  } finally {
    // 只关自己起的这个浏览器实例（按 CDP，不用 taskkill /IM —— 那会连带关掉用户的浏览器）
    await browser.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n[verify] ${results.length - failed.length}/${results.length} 通过${REVERSE ? '（负控模式：卡片不带"在跑"的事实时不许出现「停止」）' : ''}`)
  for (const f of failed) console.log(`  FAIL  ${f.name}  ::  ${f.extra}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify] 异常退出:', err); process.exit(1) })

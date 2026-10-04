/**
 * 看板卡片「手动标记已完成」的验证（2026-10-01）。
 *
 * 背景：看板的列本来是**纯推导**的（后端 deriveTaskColumn：有 job 在跑=进行中、
 * 最近一条 job 跑完=已完成），推导不出来的是两件只有人知道的事 ——
 * 一条待在「待处理」里的任务其实早在别处干完了；一条「进行中」的任务模型已经不说话了。
 * 现在待处理 / 进行中的卡片右下角多了一颗「完成」，已完成列上手动标进去的那张多了一颗「撤销」。
 *
 * 验收契约（改这块时别破坏）：
 *   A 待处理卡：有「完成」、没有「撤销」（撤销只属于手动标进去的那种卡）
 *   B 进行中卡：「停止」与「完成」并排 —— 两者含义不同（停在这儿 vs 停掉并收进已完成）
 *   C 手动标进去的已完成卡：是「撤销」而不是「完成」
 *   D 自己跑完的已完成卡：两颗都没有 —— 撤销一颗"最近一条 job 就是 done"的任务
 *     什么都不会发生（标记一撤，它还是按执行事实回到已完成），那是个骗人的按钮
 *   E 点「完成」（待处理卡）：不弹确认框，直接 POST /api/workbench/tasks/<任务id>/done，
 *     成功后提示「已标记为已完成」
 *   F 点「完成」（进行中卡）：先弹确认框（这一下会把那一轮也停掉）；点「取消」一个请求都不发，
 *     点「标记完成」才发 POST
 *   G 点「撤销」：DELETE /api/workbench/tasks/<任务id>/done
 *   H 服务端拒绝（任务在另一个 g ui 实例里跑 → 404 + 一句明确的话）：原话透出，
 *     不吞成笼统的"标记失败"
 *   I 几何：带第三颗按钮的三种卡操作组同宽（渐隐距离是按组宽反推的：组一胖，
 *     按钮就露出半截字形），且组左边缘确实落在被遮那一行的完全透明区里；
 *     只有两颗按钮的那张（自己跑完的已完成卡）合理地更窄 —— 窄不会露字形，宽才会
 *   J 页面无 console / page 错误
 *   R 负控（--reverse）：把 fixture 换回**没有任何手动标记**的数据（即"这个新功能之前"的
 *     卡片数据），此时已完成卡上必须看不到「撤销」—— A/C 那两组的判据才算是真的钉在
 *     服务端的 manualDoneAt 上；一个写死渲染「撤销」的模板也能让 C 变绿，却会让 R 翻红。
 *     （注入点是**服务端给卡片的那份数据** —— 前端唯一真正的输入。SFC 跑在 vite dev server
 *     里，DOM 探针换不掉它，所以这里做不到 verify-release-self-update 那种"改叶子函数"式的
 *     反证，如实说明。）
 *
 * 为什么 fixture 是手搓的、而不是 import 服务端 deriveTaskColumn：本脚本验的是
 * "卡片按钮 + 一次 fetch"，与后端怎么算列无关（那部分由 projectRegistry.test.js 单测覆盖）；
 * 手搓还能让它在后端没起时也跑（done 请求由 page.route 拦住，不碰真进程、不碰用户真任务）。
 *
 * 前置：dev server 已启动（vite 5544，`npm run dev:ping` 两个 OK）。后端**不需要**。
 * 用法：node scripts/verify-wb-card-done.cjs [--reverse]
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

/** 轮询等待而不是 sleep 一个拍脑袋的时长（同 verify-wb-card-stop，见 verify-probe-template） */
async function waitFor(fn, ms = 8000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await sleep(100)
  }
}

const PROJECT_PATH = 'D:\\ws\\zen-gitsync'
/** 服务端在"这个 job 活在另一个 g ui 实例里"时回的那句话（routes/workbench/index.js §12.5） */
const OTHER_INSTANCE = '这个任务正在另一个 g ui 实例里执行，请到那个窗口停止它'
/** F 组确认框里的那句话（文案见 WorkbenchBoard.completeTask） */
const CONFIRM_HINT = '还在执行'

/**
 * 四张卡，把按钮的四种状态都摆出来：
 *   待处理（没跑过）→ 执行 + 完成 + ×
 *   进行中（有 live）→ 停止 + 完成 + ×
 *   已完成（手动标的）→ 执行 + 撤销 + ×
 *   已完成（自己跑完的）→ 执行 + ×
 *
 * `--reverse` 时把两份"已完成"数据里的 manualDoneAt 去掉 —— 那就是这个功能之前的看板数据。
 * 注意反向时**保留两张已完成卡**：R 守的是"没有手动标记就不该有撤销"，
 * 卡全删掉的话，撤销不见了有可能只是因为那列空了，什么都验不出来。
 */
function fixture() {
  const at = (minAgo) => new Date(Date.now() - minAgo * 60 * 1000).toISOString()
  const board = [
    {
      id: 'syn-todo', title: '【合成】T：待处理', desc: '', projectPath: PROJECT_PATH,
      column: 'todo', attachmentCount: 0, runningJobs: 0, live: null,
      lastReply: '', lastJobAgent: 'claude', lastJobStatus: null,
      lastJobEndedAt: null, manualDoneAt: null, createdAt: at(30), updatedAt: at(30),
    },
    {
      id: 'syn-run', title: '【合成】R：进行中', desc: '', projectPath: PROJECT_PATH,
      column: 'doing', attachmentCount: 0, runningJobs: 1,
      live: {
        jobId: 'syn-run-job', status: 'running', agent: 'claude', startedAt: at(3), pid: 4242,
        elapsedMs: 3 * 60 * 1000, toolCallCount: 12, lastTool: 'Edit src/ui/client/src/views/components/WorkbenchKanban.vue',
        toolMix: 'Edit×8 · Read×4', lastThought: '把这条规则的收尾补上',
        lastLine: '正在给卡片补手动完成按钮', silentMs: null,
      },
      lastReply: null, lastJobAgent: 'claude', lastJobStatus: 'running',
      lastJobEndedAt: null, manualDoneAt: null, createdAt: at(60), updatedAt: at(3),
    },
    {
      id: 'syn-manual', title: '【合成】M：手动标完成', desc: '', projectPath: PROJECT_PATH,
      column: 'done', attachmentCount: 0, runningJobs: 0, live: null,
      lastReply: '这条早就干完了，直接标掉', lastJobAgent: 'claude', lastJobStatus: 'cancelled',
      lastJobEndedAt: at(20), manualDoneAt: REVERSE ? null : at(10),
      createdAt: at(90), updatedAt: at(10),
    },
    {
      id: 'syn-natural', title: '【合成】N：自己跑完的', desc: '', projectPath: PROJECT_PATH,
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
  const project = {
    path: PROJECT_PATH, key: PROJECT_PATH.toLowerCase(), name: 'zen-gitsync',
    source: 'both', isCurrent: true, git: null, stats: {
      total: 4, todo: 1, doing: 1, done: 2, progress: 50,
      runningJobs: 1, lastActiveAt: at(3),
    },
  }
  return { board, tasks, project }
}

/**
 * 读一张卡片的操作组：按钮文案、几何、以及"被渐隐的那一行"。
 * 与 verify-wb-card-stop 的 readCard 同一份口径（那个探针守的是遮罩挂在**哪一行**上，
 * 这里守的是**组宽**——加了「完成 / 撤销」之后组必须还是常数宽，那两个数字才对得上）。
 *
 * `transparent` 直接从计算后的 mask-image 里抠出来（`calc(100% - 102px)` 的那个数），
 * 所以样式里改数字，这里自动跟着走（只取横向那层 —— 遮罩已是两层，见下面 readCard）。
 */
function readCard(page, id) {
  return page.evaluate((taskId) => {
    const el = document.querySelector(`.kb-card[data-task-id="${taskId}"]`)
    if (!el) return { found: false }
    const actions = el.querySelector('.kb-card__actions')
    const ar = actions.getBoundingClientRect()
    const r = el.getBoundingClientRect()

    const maskedEl = [...el.querySelectorAll('*')].find(e => getComputedStyle(e).maskImage !== 'none')
    const maskVal = maskedEl ? getComputedStyle(maskedEl).maskImage : ''
    // 只取横向那层（`to right`）：遮罩是「横向渐隐 ∩ 纵向条带」两层（--kb-fade-band，
    // 2026-10-02），纵向那层的数字不是"横向能洗掉多少"，别把它当成最后一个 stop。
    // 从 `to right` 切到下一层 `linear-gradient(` —— 不能按 ')' 截：计算值里颜色是
    // rgb(0, 0, 0)，按 ')' 截会正好截在颜色函数中间，把后面的 calc() 丢掉。
    const hAt = maskVal.indexOf('to right')
    const hNext = maskVal.indexOf('linear-gradient(', hAt + 1)
    const hLayer = hAt < 0 ? '' : maskVal.slice(hAt, hNext < 0 ? undefined : hNext)
    const stops = [...hLayer.matchAll(/calc\(100% - (\d+(?:\.\d+)?)px\)/g)].map(m => Number(m[1]))
    const mr = maskedEl ? maskedEl.getBoundingClientRect() : null

    return {
      found: true,
      opacity: getComputedStyle(actions).opacity,
      buttons: [...actions.querySelectorAll('.kb-card__btn')].map(b => b.textContent.trim()),
      width: ar.width,
      box: { x: r.x + r.width / 2, y: r.y + r.height / 2 },
      masked: maskedEl ? String(maskedEl.className) : null,
      gapToMask: mr ? mr.right - ar.left : null,
      transparent: stops.length ? stops[stops.length - 1] : null,
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

/** 当前所有 toast 的文案（ElMessage 3s 后自己消失，H 组要读得快） */
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
   * H 组故意让服务端回 404（那就是真实响应）—— Chrome 会为此往 console 写一条
   * "Failed to load resource: ... 404"。它是**我们要求的**失败，不是页面出错；
   * J 组守的是"没有意料之外的 console 错误"，所以只在 H 组期间放行这一类。
   */
  let allowExpected404 = false
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const text = m.text()
    if (allowExpected404 && /Failed to load resource/.test(text)) return
    consoleErrors.push(text)
  })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  /** 拦到的 done 请求（方法 + URL），E/F/G 三组都断言它 */
  const doneCalls = []
  /** H 组要换的应答：默认成功 */
  let doneReply = { status: 200, body: { success: true } }

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
    // 失败会在控制台刷红，把 J 那条（无 console 错误）带崩
    await page.route('**/api/workbench/tasks*', (route) => json(route, { tasks }))
    await page.route('**/api/workbench/jobs*', (route) => json(route, { jobs: [] }))
    await page.route('**/api/workbench/current-project*', (route) => json(route, { path: PROJECT_PATH }))
    // ⚠️ 这条**必须**注册在上面那条通配 `**/api/workbench/tasks*` 之后：
    // playwright 的路由是后注册的先匹配，反过来就被通配那条吞掉，done 请求永远拦不到
    await page.route('**/api/workbench/tasks/*/done', (route) => {
      doneCalls.push(`${route.request().method()} ${route.request().url()}`)
      return route.fulfill({
        status: doneReply.status,
        contentType: 'application/json',
        body: JSON.stringify(doneReply.body),
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
    const btn = (id) => page.locator(`.kb-card[data-task-id="${id}"] .kb-card__btn`)

    // ── A 待处理卡：执行 + 完成 + × ────────────────────────────────
    await hoverCard('syn-todo')
    const todo = await readCard(page, 'syn-todo')
    check('A1 待处理卡的操作组浮出', todo.opacity === '1', `opacity=${todo.opacity}`)
    check('A2 待处理卡上有「完成」', todo.buttons.includes('完成'), `buttons=${JSON.stringify(todo.buttons)}`)
    check('A3 待处理卡上没有「撤销」（撤销只属于手动标进去的那种卡）',
      !todo.buttons.includes('撤销'), `buttons=${JSON.stringify(todo.buttons)}`)
    check('A4 待处理卡上没有「停止」（不是整板都变成运行态操作）',
      !todo.buttons.includes('停止'), `buttons=${JSON.stringify(todo.buttons)}`)

    // ── B 进行中卡：停止 + 完成 ────────────────────────────────────
    await hoverCard('syn-run')
    const run = await readCard(page, 'syn-run')
    check('B1 进行中卡上是「停止」', run.buttons.includes('停止'), `buttons=${JSON.stringify(run.buttons)}`)
    check('B2 进行中卡上同时有「完成」（停在这儿 ≠ 停掉并收进已完成）',
      run.buttons.includes('完成'), `buttons=${JSON.stringify(run.buttons)}`)
    check('B3 进行中卡上没有「撤销」', !run.buttons.includes('撤销'), `buttons=${JSON.stringify(run.buttons)}`)

    // ── C / D 两张已完成卡 ────────────────────────────────────────
    await hoverCard('syn-manual')
    const manual = await readCard(page, 'syn-manual')
    await hoverCard('syn-natural')
    const natural = await readCard(page, 'syn-natural')
    if (REVERSE) {
      check('R1 负控：卡片数据里没有 manualDoneAt 时，已完成卡上没有「撤销」',
        !manual.buttons.includes('撤销'), `buttons=${JSON.stringify(manual.buttons)}`)
      check('R2 负控：那张卡照旧只有「执行」+「×」',
        manual.buttons.includes('执行') && manual.buttons.includes('×') && manual.buttons.length === 2,
        `buttons=${JSON.stringify(manual.buttons)}`)
    } else {
      check('C1 手动标进去的已完成卡上是「撤销」', manual.buttons.includes('撤销'), `buttons=${JSON.stringify(manual.buttons)}`)
      check('C2 它没有「完成」（列本身已经是答案）', !manual.buttons.includes('完成'), `buttons=${JSON.stringify(manual.buttons)}`)
      check('D1 ★ 自己跑完的卡上既没有「撤销」也没有「完成」',
        !natural.buttons.includes('撤销') && !natural.buttons.includes('完成'),
        `buttons=${JSON.stringify(natural.buttons)}`)
    }

    // ── I 几何：操作组宽度与渐隐区 ────────────────────────────────
    // 带第三颗按钮的三张卡（待处理 / 进行中 / 手动标完成）必须**同宽**：
    // 那两组渐隐数字是按组宽反推的，组一胖按钮就露出半截字形。
    // 只有两颗的那张（自己跑完的已完成卡）合理地更窄 —— 更窄永远不会露字形，
    // 所以这里守的是"不许比它更宽"，不是"四张必须一样宽"。
    // --reverse 时那张"手动标完成"的卡按数据退化成两颗按钮（C 组已经断言过了），
    // 所以这里比的是"仍然带第三颗按钮的卡"：三种状态本来就该同宽 ——
    // 待处理(执行+完成+×) / 进行中(停止+完成+×) / 手动已完成(执行+撤销+×)。
    const wide = (REVERSE ? [todo, run] : [todo, run, manual]).map(c => c.width)
    check('I1 带「完成/撤销」的三种卡操作组同宽（渐隐距离按组宽反推，组一胖就露半截字形）',
      Math.max(...wide) - Math.min(...wide) <= 6,
      wide.map(w => w.toFixed(1)).join(' / '))
    check('I2 只有两颗按钮的那张更窄（窄是安全的，宽才是 bug）',
      natural.width <= Math.min(...wide) + 1,
      `两按钮=${natural.width.toFixed(1)} 三按钮=${Math.min(...wide).toFixed(1)}`)
    const gapsOk = [todo, run, manual, natural].every(c =>
      c.gapToMask != null && c.transparent != null && c.gapToMask <= c.transparent)
    check('I3 每张卡的组左边缘都落在被遮那一行的完全透明区内',
      gapsOk,
      [todo, run, manual, natural].map(c =>
        `${c.gapToMask != null ? c.gapToMask.toFixed(1) : '?'}≤${c.transparent}`).join(' '))

    if (REVERSE) {
      // 负控模式只验"没有手动标记就没有撤销"：后面的点击与请求断言都建立在有这个按钮上
      await hoverAway()
      check('J1 页面无 console / page 错误', consoleErrors.length === 0 && pageErrors.length === 0,
        [...consoleErrors, ...pageErrors].slice(0, 3).join(' | '))
      return finish(browser, page)
    }

    // ── E 点「完成」（待处理卡）：不弹确认框，直接 POST ────────────
    hoverAway()
    await hoverCard('syn-todo')
    await btn('syn-todo').filter({ hasText: '完成' }).first().click()
    check('E1 待处理卡点「完成」不弹确认框（可逆的动作不该拦一道）', !(await readConfirm(page)).open)
    const posted = await waitFor(() => doneCalls.length > 0)
    check('E2 确认后发出了标记请求', posted, `calls=${JSON.stringify(doneCalls)}`)
    check('E3 ★ 打的是 POST /api/workbench/tasks/<任务id>/done',
      doneCalls.length === 1 && /^POST .*\/api\/workbench\/tasks\/syn-todo\/done$/.test(doneCalls[0]),
      String(doneCalls[0] || ''))
    check('E4 点「完成」没有顺手把任务编辑器打开', (await page.locator('.wb-back-btn').count()) === 0)
    const okToast = await waitFor(async () => (await readToasts(page)).some(t => t.includes('已标记为已完成')))
    check('E5 成功后有反馈（已标记为已完成）', okToast, JSON.stringify(await readToasts(page)))

    // ── F 点「完成」（进行中卡）：先确认，取消则一个请求都不发 ──────
    doneCalls.length = 0
    await waitFor(async () => (await readToasts(page)).length === 0)
    await hoverCard('syn-run')
    await btn('syn-run').filter({ hasText: '完成' }).first().click()
    const dlg = await readConfirm(page)
    check('F1 进行中卡点「完成」先弹确认框（这一下会连那一轮一起停掉）', dlg.open, JSON.stringify(dlg.text).slice(0, 80))
    check('F2 确认框里说清了"会停掉还在执行的这一轮"', dlg.text.includes(CONFIRM_HINT), dlg.text.slice(0, 80))
    await clickConfirmButton(page, '取消')
    check('F3 确认框已关闭', !(await readConfirm(page)).open)
    // 反向等一小段：请求真发出去的话，本地回环在 800ms 内必到
    await sleep(800)
    check('F4 点「取消」不发任何请求', doneCalls.length === 0, `calls=${JSON.stringify(doneCalls)}`)

    await hoverCard('syn-run')
    await btn('syn-run').filter({ hasText: '完成' }).first().click()
    await clickConfirmButton(page, '标记完成')
    const posted2 = await waitFor(() => doneCalls.length > 0)
    check('F5 确认后才发 POST（进行中卡的标记要先停掉那一轮）',
      posted2 && /^POST .*\/api\/workbench\/tasks\/syn-run\/done$/.test(doneCalls[0] || ''),
      JSON.stringify(doneCalls))

    // ── G 点「撤销」：DELETE ───────────────────────────────────────
    doneCalls.length = 0
    await waitFor(async () => (await readToasts(page)).length === 0)
    await hoverCard('syn-manual')
    await btn('syn-manual').filter({ hasText: '撤销' }).first().click()
    check('G1 点「撤销」不弹确认框（它本身就是"点错了要退回来"的那一下）', !(await readConfirm(page)).open)
    const undone = await waitFor(() => doneCalls.length > 0)
    check('G2 ★ 撤销打的是 DELETE /api/workbench/tasks/<任务id>/done',
      undone && /^DELETE .*\/api\/workbench\/tasks\/syn-manual\/done$/.test(doneCalls[0] || ''),
      JSON.stringify(doneCalls))
    const undoToast = await waitFor(async () => (await readToasts(page)).some(t => t.includes('已撤销完成标记')))
    check('G3 撤销后有反馈（已撤销完成标记）', undoToast, JSON.stringify(await readToasts(page)))

    // ── H 服务端拒绝：原话透出，不吞成"标记失败" ──────────────────
    doneReply = { status: 404, body: { success: false, error: OTHER_INSTANCE } }
    allowExpected404 = true // 见 page.on('console') 那段：这条 404 是我们要的
    doneCalls.length = 0
    await waitFor(async () => (await readToasts(page)).length === 0)
    await hoverCard('syn-todo')
    await btn('syn-todo').filter({ hasText: '完成' }).first().click()
    const told = await waitFor(async () => (await readToasts(page)).some(t => t.includes(OTHER_INSTANCE)))
    check('H1 服务端的原话被透出（不是笼统的"标记失败"）', told, JSON.stringify(await readToasts(page)))
    allowExpected404 = false

    await hoverAway()
    check('J1 页面无 console / page 错误', consoleErrors.length === 0 && pageErrors.length === 0,
      [...consoleErrors, ...pageErrors].slice(0, 3).join(' | '))
    return finish(browser, page)
  } catch (err) {
    await browser.close().catch(() => {})
    throw err
  }
}

/**
 * 截图存证 + 打印结论 + 退出码。
 * 四张卡在同一时刻只有一张能被 hover（鼠标只有一个），所以要一张一张拍 ——
 * 拍的是"这颗按钮在卡片上长什么样、跟旁边那颗的关系"，肉眼一眼能看出来的东西。
 */
async function finish(browser, page) {
  try {
    const shotDir = path.resolve(__dirname, '../tmp')
    for (const id of ['syn-todo', 'syn-run', 'syn-manual', 'syn-natural']) {
      const card = page.locator(`.kb-card[data-task-id="${id}"]`)
      if (await card.count() === 0) continue
      await card.hover()
      await sleep(300)
      const file = path.join(shotDir, `verify-wb-card-done-${id}${REVERSE ? '-reverse' : ''}.png`)
      await card.screenshot({ path: file })
      log('截图:', file)
    }
  } catch (err) {
    log('截图失败（不影响结论）:', err.message)
  }
  await browser.close().catch(() => {})

  const failed = results.filter(r => !r.ok)
  console.log(`\n[verify] ${results.length - failed.length}/${results.length} 通过${REVERSE ? '（负控模式：数据里没有手动标记时不许出现「撤销」）' : ''}`)
  for (const f of failed) console.log(`  FAIL  ${f.name}  ::  ${f.extra}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify] 异常退出:', err); process.exit(1) })

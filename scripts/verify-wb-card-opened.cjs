/**
 * 看板卡片「点开之后取消 hover」的验证。
 *
 * 背景：卡片右下角的「执行 / ×」是 hover 才浮出来的（绝对定位，正文右侧为此做了渐隐遮罩）。
 * 用户在编辑器里已经能执行 / 删除这条任务了，卡片上再摆一份只会跟正文抢右下角那块地方，
 * 顺带把"鼠标恰好停在自己正在编辑的那张卡上"的误触也堵掉 —— 所以点开过的那张卡片
 * （.kb-card.is-opened）不再响应 hover。同一条规则必须**成对**撤干净：只撤按钮不撤遮罩，
 * 会留下"按钮没了但字白少一截"的半吊子状态。
 *
 * 验收契约（改这块时别破坏）：
 *   A 点开之前 hover 照旧：操作组浮出（opacity 1）+ 正文渐隐（mask 是 gradient）+ 卡片抬升
 *   B 点开（走 open-task）之后：那张卡片带 .is-opened / aria-current，别的卡片没有
 *   C 点开之后 hover 它：操作组不浮出（opacity 0 且 pointer-events none）、正文不再渐隐、
 *     卡片也不再抬升 —— 三件一起撤，缺一件就是半吊子
 *   D 没点开过的卡片不受影响（不能因为"有过一次点开"就整板都失去 hover 操作）
 *   E 键盘仍然可达：Tab 进卡片里的按钮时操作组照旧浮出（:focus-within 那一路没加条件）
 *   F 标记只跟着**最后点开的那条**：点开第二张之后第一张恢复 hover 操作
 *   G 页面无 console / page 错误
 *
 * 为什么 fixture 是手搓的、而不是像 verify-wb-card-live / -reply 那样去 import 服务端
 * decorateTaskForBoard：这里验的是**纯 CSS + class 契约**，与服务端怎么算列 / 摘录无关。
 * 手搓的三条任务（两条已完成带 lastReply、一条进行中带 live）刚好覆盖两处遮罩规则
 * （.kb-card__reply 与 .kb-card__live 的最后一个孩子），也让本脚本在后端没起时也能跑。
 * 走真实响应的那两个脚本负责验"服务端给的事实"，职责不重叠。
 *
 * 前置：dev server 已启动（vite 5544）。后端**不需要**——本脚本把编辑器要用的几个接口
 * 也一并拦掉，避免编辑器弹窗里刷一串 fetch 失败把 G 那条带崩。
 * 用法：node scripts/verify-wb-card-opened.cjs
 * 退出码：0 全通过，1 有失败项。
 */
const fs = require('node:fs')
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544'
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

const PROJECT_PATH = 'D:\\ws\\zen-gitsync'
const REPLY = '已经把事件监听的泄漏补上，改完记得跑一遍测试再提交。'

/** 三条任务：两条已完成（带 lastReply → 触发 .kb-card__reply 的遮罩）、一条进行中（带 live） */
function fixture() {
  const at = (minAgo) => new Date(Date.now() - minAgo * 60 * 1000).toISOString()
  const board = [
    {
      id: 'syn-a', title: '【合成】A：已完成，带最后回复', desc: '', projectPath: PROJECT_PATH,
      column: 'done', attachmentCount: 0, runningJobs: 0, live: null,
      lastReply: REPLY, lastJobAgent: 'claude', lastJobStatus: 'done',
      lastJobEndedAt: at(30), createdAt: at(120), updatedAt: at(30),
    },
    {
      id: 'syn-b', title: '【合成】B：另一条已完成', desc: '', projectPath: PROJECT_PATH,
      column: 'done', attachmentCount: 0, runningJobs: 0, live: null,
      lastReply: '文档补完了，可以合了。', lastJobAgent: 'claude', lastJobStatus: 'done',
      lastJobEndedAt: at(20), createdAt: at(90), updatedAt: at(20),
    },
    {
      id: 'syn-c', title: '【合成】C：进行中（活动区是另一处遮罩）', desc: '', projectPath: PROJECT_PATH,
      column: 'doing', attachmentCount: 0, runningJobs: 1,
      live: {
        jobId: 'syn-c-job', status: 'running', agent: 'claude', startedAt: at(3), pid: 4242,
        elapsedMs: 3 * 60 * 1000, toolCallCount: 12, lastTool: 'Edit src/ui/client/src/views/WorkbenchView.vue',
        toolMix: 'Edit×8 · Read×4', lastThought: '把这条规则的收尾补上',
        lastLine: '正在改 WorkbenchKanban 的样式', silentMs: null,
      },
      lastReply: '', lastJobAgent: 'claude', lastJobStatus: 'running',
      lastJobEndedAt: null, createdAt: at(60), updatedAt: at(3),
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
      total: 3, todo: 0, doing: 1, done: 2, progress: 67, runningJobs: 1, lastActiveAt: at(3),
    },
  }
  return { board, tasks, project }
}

/** 读一张卡片的 hover 相关计算样式（DOM ↔ 数据用 data-task-id 关联，不用标题当键） */
function readCard(page, id) {
  return page.evaluate((taskId) => {
    const el = document.querySelector(`.kb-card[data-task-id="${taskId}"]`)
    if (!el) return { found: false }
    const actions = el.querySelector('.kb-card__actions')
    // 两处遮罩各读各的：已完成卡看 .kb-card__reply，进行中卡看活动区**最后一个孩子**
    // （活动区渲染到哪一行取决于哪个字段有值，见 WorkbenchKanban 的样式注释）
    const reply = el.querySelector('.kb-card__reply')
    const liveLast = el.querySelector('.kb-card__live > :last-child')
    const maskOf = (node) => {
      if (!node) return null
      const cs = getComputedStyle(node)
      return cs.maskImage || cs.webkitMaskImage || 'none'
    }
    const r = el.getBoundingClientRect()
    return {
      found: true,
      opened: el.classList.contains('is-opened'),
      ariaCurrent: el.getAttribute('aria-current'),
      actionsOpacity: getComputedStyle(actions).opacity,
      actionsPointer: getComputedStyle(actions).pointerEvents,
      replyMask: maskOf(reply),
      liveMask: maskOf(liveLast),
      transform: getComputedStyle(el).transform,
      box: { x: r.x + r.width / 2, y: r.y + r.height / 2 },
    }
  }, id)
}

async function main() {
  const { board, tasks, project } = fixture()

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
        // 预置「全部项目」：全新上下文里 savedSelection === null 时 applyDefaultSelection()
        // 会把选中项落到「当前项目」，这里就直接把三条都给上，省一次点击也少一处时序依赖
        localStorage.setItem('wb.boardProject.v1', '')
      } catch { /* 隐私模式 */ }
    })
    const json = (route, body) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(body),
    })
    await page.route('**/api/workbench/projects*', (route) =>
      json(route, { success: true, projects: [project], tasks: board, currentProjectPath: PROJECT_PATH }))
    // 编辑器弹窗要用的几个接口也拦掉：它一开就会拉这些，失败会在控制台刷红，
    // 把 G 那条（无 console 错误）带崩，而那些失败与本脚本要验的契约无关
    await page.route('**/api/workbench/tasks*', (route) => json(route, { tasks }))
    await page.route('**/api/workbench/prompts*', (route) => json(route, { prompts: [] }))
    await page.route('**/api/workbench/jobs*', (route) => json(route, { jobs: [] }))
    await page.route('**/api/workbench/current-project*', (route) => json(route, { path: PROJECT_PATH }))

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.kb-card', { timeout: 15000 })
    await page.locator('.proj-item--all').first().click()
    await page.waitForSelector('.kb-card[data-task-id="syn-a"]', { timeout: 15000 })
    await sleep(800)

    /** 悬停到卡片正中（读完坐标再动鼠标：DOM 会随轮询重排，边读边动会飘） */
    const hoverCard = async (id) => {
      const box = (await readCard(page, id)).box
      await page.mouse.move(box.x, box.y)
      await sleep(300)
    }
    /** 鼠标挪到空白处（工具条上），确保后面的读数只可能来自 :focus-within 而不是 :hover */
    const hoverAway = async () => {
      await page.mouse.move(4, 4)
      await sleep(300)
    }
    /** 点开卡片 → 关掉编辑器弹窗 → 回到看板。id 会带上 .is-opened（这条正是要验的） */
    const openAndBack = async (id) => {
      await page.locator(`.kb-card[data-task-id="${id}"]`).click()
      await page.waitForSelector('.wb-back-btn', { timeout: 15000 })
      await page.locator('.wb-back-btn').first().click()
      await page.waitForSelector('.wb-back-btn', { state: 'hidden', timeout: 15000 })
      await sleep(600)
    }

    // ── A 点开之前：hover 那一套齐全 ────────────────────────────────
    await hoverCard('syn-a')
    const before = await readCard(page, 'syn-a')
    check('A1 hover 时操作组浮出（执行 / × 可点）', before.actionsOpacity === '1', `opacity=${before.actionsOpacity}`)
    check('A2 hover 时正文右侧渐隐（按钮不压在字上）', /gradient/.test(before.replyMask || ''), String(before.replyMask).slice(0, 40))
    check('A3 hover 时卡片抬升', before.transform && before.transform !== 'none', before.transform)
    check('A4 此刻还没有卡片被标记成"点开过"', !before.opened && before.ariaCurrent === null,
      `is-opened=${before.opened} aria-current=${before.ariaCurrent}`)

    // ── B 点开之后：标记落在那张卡上，别的卡不受影响 ────────────────
    await openAndBack('syn-a')
    const openedA = await readCard(page, 'syn-a')
    const otherB = await readCard(page, 'syn-b')
    check('B1 点开的卡片带 .is-opened', openedA.opened)
    check('B2 同时对读屏声明 aria-current', openedA.ariaCurrent === 'true', String(openedA.ariaCurrent))
    check('B3 没点开的卡片没有这个标记（不是整板生效）', !otherB.opened)

    // ── C 点开之后 hover 它：操作组 / 遮罩 / 抬升三件一起撤 ─────────
    // 先把焦点挪走再量。点卡片那一下会让它自己拿到焦点（卡片本身可聚焦，读数是
    // LI.kb-card is-opened），于是 :focus-within 那一路照样把操作组亮着 —— 那是**键盘可达**
    // 的设计（E 组专门验它），不是 hover 那一路没撤干净。不 blur 就量，C1–C3 恒红，
    // 而 C4（抬升只挂在 :hover 上）正常绿 —— 2026-09-30 实测就是这么个"三条红一条绿"。
    await page.evaluate(() => document.activeElement && document.activeElement.blur())
    await hoverCard('syn-a')
    const after = await readCard(page, 'syn-a')
    check('C1 hover 不再浮出操作组', after.actionsOpacity === '0', `opacity=${after.actionsOpacity}`)
    // 只藏起来不够：opacity 0 的按钮仍会吃掉落在它上面的点击（卡片因此点不开）
    check('C2 操作组连点击一起让开', after.actionsPointer === 'none', after.actionsPointer)
    check('C3 正文不再被渐隐（撤按钮必须连遮罩一起撤）', after.replyMask === 'none', String(after.replyMask).slice(0, 40))
    check('C4 卡片不再抬升', after.transform === 'none', after.transform)
    await page.screenshot({ path: path.resolve(__dirname, '../tmp-verify-wb-card-opened.png') })
    log('截图:', path.resolve(__dirname, '../tmp-verify-wb-card-opened.png'))

    // ── D 没点开过的卡片照旧 ────────────────────────────────────────
    await hoverCard('syn-c')
    const other = await readCard(page, 'syn-c')
    check('D1 没点开过的卡片 hover 仍浮出操作组', other.actionsOpacity === '1', `opacity=${other.actionsOpacity}`)
    check('D2 它的活动区也照旧渐隐（另一处遮罩规则同样只对 hover 生效）',
      /gradient/.test(other.liveMask || ''), String(other.liveMask).slice(0, 40))

    // ── E 键盘仍然可达 ──────────────────────────────────────────────
    await hoverAway()
    await page.locator('.kb-card[data-task-id="syn-a"] .kb-card__btn').first().focus()
    await sleep(300)
    const focused = await readCard(page, 'syn-a')
    check('E1 Tab 进按钮时操作组照旧浮出（键盘用户不能因此够不到执行 / 删除）',
      focused.actionsOpacity === '1', `opacity=${focused.actionsOpacity}`)
    await page.evaluate(() => document.activeElement && document.activeElement.blur())

    // ── F 标记只跟着最后点开的那条 ──────────────────────────────────
    await openAndBack('syn-b')
    const nowB = await readCard(page, 'syn-b')
    const nowA = await readCard(page, 'syn-a')
    check('F1 点开第二张之后标记跟着走', nowB.opened && !nowA.opened,
      `b=${nowB.opened} a=${nowA.opened}`)
    await hoverCard('syn-a')
    const backA = await readCard(page, 'syn-a')
    check('F2 先前那张恢复 hover 操作（只有一条处于"点开过"）',
      backA.actionsOpacity === '1', `opacity=${backA.actionsOpacity}`)

    check('G1 页面无 console / page 错误', consoleErrors.length === 0 && pageErrors.length === 0,
      [...consoleErrors, ...pageErrors].slice(0, 3).join(' | '))
  } finally {
    // 只关自己起的这个浏览器实例（按 CDP，不用 taskkill /IM —— 那会连带关掉用户的浏览器）
    await browser.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n[verify] ${results.length - failed.length}/${results.length} 通过`)
  for (const f of failed) console.log(`  FAIL  ${f.name}  ::  ${f.extra}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify] 异常退出:', err); process.exit(1) })

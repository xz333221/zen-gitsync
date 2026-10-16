/**
 * 看板头部动作区（2026-10-16）：「80/82 任务完成」徽章去掉 + 视图切换/搜索上移。
 *
 * 守的契约（对应 WorkbenchBoard.vue 的 .board__head-actions）：
 *   S1 静态：WorkbenchBoard.vue 模板里不再有 .board__project-meta（徽章去掉）
 *   S2 静态：.board__head-actions 样式块存在（不是 DOM 里裸奔的两个按钮）
 *   B1 徽章在 DOM 里不存在
 *   B2 视图切换是两个纯图标 tab：role=tab、有 aria-label、按钮内无文字
 *   B3 两个 tab 都能切换视图（列表 → .kb-table-wrap，看板 → .kb__columns）
 *   B4 搜索默认收起：输入框宽 ≈ 0，放大镜按钮常驻可见
 *   B5 点放大镜 → 输入框展开（宽 > 150px）且拿到焦点
 *   B6 搜索词真的在过滤（fixture 三条任务，输入只命中一条的标题 → 只剩一张卡）
 *   B7 有词时失焦不收起（筛选结果还在屏幕上）；空词失焦收起
 *   B8 Esc 收起
 *   B9 动作区整体不溢出标题行（几何：右边界 ≤ 标题行右边界）
 *   B10 默认视图是看板（localStorage 空值时三列在）
 *
 * 为什么 B4/B7/B8 必须是**几何量测**（width）而不是"元素在不在"：
 * 展开态是个 width 过渡，display 切换会让"在不在"恒真恒假，
 * 量宽度才守得住"默认只露一枚图标"这条本体。
 *
 * --reverse 反证（把新契约逐条打回旧样子，这几条必须红）：
 *   R1 append 一个假 .board__project-meta 徽章        → B1 红
 *   R2 删掉两个 tab 的 role / aria-label               → B2 / B3 红
 *   R3 注入 CSS 把输入框钉成"永不收起"                  → B4 / B7b / B8 红
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const ROOT = path.resolve(__dirname, '..')
const SRC_FILE = path.join(ROOT, 'src/ui/client/src/views/components/WorkbenchBoard.vue')
const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const CHROME = process.env.ZEN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'wb-head-actions-verify')
const REVERSE = process.argv.includes('--reverse')

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── fixture：一个项目 + 三条 todo 任务（标题/描述各带可搜的词） ──
   ⚠️ key 必须是 canonicalProjectPath 规范化后的形态（Windows = 小写 + 反斜杠，
   与后端 projectRegistry 的 key 逐字一致）：visibleTasks 按
   canonicalProjectPath(task.projectPath) === selectedKey 过滤，selectedProject 又按
   p.key === selectedKey 精确匹配 —— key 用原始写法会筛掉全部任务（0 张卡）。 */
const KEY = 'd:\\ws\\zen-verify-head'
const PATH = 'D:\\ws\\zen-verify-head'
const PROJ = {
  key: KEY, path: PATH, name: 'zen-verify-head',
  source: 'recent', isCurrent: true, exists: true, iconUrl: null,
  git: {
    isGitRepo: true, branch: 'main', upstream: null, hasUpstream: false, detached: false,
    ahead: 0, behind: 0, changed: 0, staged: 0, unstaged: 0, untracked: 0,
  },
  stats: { total: 3, todo: 3, doing: 0, done: 0, progress: 0, runningJobs: 0, lastActiveAt: null },
}
const mkTask = (id, title, desc) => ({
  id, title, desc, projectPath: PATH, column: 'todo',
  attachmentCount: 0, images: [], runningJobs: 0, live: null, lastReply: null,
  lastJobAgent: '', lastJobStatus: null, lastJobEndedAt: null, lastDurationMs: null,
  lastJobStartedAt: null, autoCompleted: null, manualDoneAt: null,
  createdAt: '2026-10-16T02:00:00.000Z', updatedAt: '2026-10-16T02:00:00.000Z',
})
const TASKS = [
  mkTask('head-alpha', '【头部】甲 看板图标切换', '视图切换收成图标后的契约'),
  mkTask('head-beta', '【头部】乙 列表图标切换', '另一个标题不同的任务'),
  mkTask('head-gamma', '【头部】丙 无关任务', '描述里没有任何可搜的特殊词'),
]

/** 输入框当前宽度（px）。-1 = 元素不在 */
function inputWidth(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.board__search-input')
    return el ? el.getBoundingClientRect().width : -1
  })
}
/** 等宽度过渡落到目标档位（展开 > 150 / 收起 < 2），超时返回 false */
async function settleWidth(page, open, timeout = 3000) {
  try {
    await page.waitForFunction((wantOpen) => {
      const el = document.querySelector('.board__search-input')
      if (!el) return false
      const w = el.getBoundingClientRect().width
      return wantOpen ? w > 150 : w < 2
    }, open, { timeout })
    return true
  } catch {
    return false
  }
}

async function main() {
  fs.rmSync(SHOT_DIR, { recursive: true, force: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  /* ── A. 静态断言（源码） ── */
  console.log('── A. 静态断言（源码）──')
  const raw = fs.readFileSync(SRC_FILE, 'utf8')
  check('S1 模板里不再有 .board__project-meta（「80/82 任务完成」徽章去掉）',
    !raw.includes('board__project-meta'),
    raw.includes('board__project-meta') ? '模板或样式里还留着这个 class' : '模板与样式均已移除')
  const actionsFrom = raw.indexOf('.board__head-actions {')
  check('S2 .board__head-actions 样式块存在（按钮不是 DOM 里裸奔）', actionsFrom >= 0)

  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox'],
  })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })).newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)))

  try {
    // 选中 fixture 项目（标题行显示项目名那一支）；视图 key 不设 = 默认看板
    await page.addInitScript(() => {
      try { localStorage.setItem('wb.boardProject.v1', 'd:\\ws\\zen-verify-head') } catch { /* ignore */ }
    })
    await page.route('**/api/workbench/projects*', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, projects: [PROJ], tasks: TASKS, currentProjectPath: PATH }),
    }))

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 30000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.board__main-head', { timeout: 15000 })
    await page.waitForSelector('.kb-card', { timeout: 15000 })
    await sleep(400)

    if (REVERSE) {
      await page.evaluate(() => {
        // R1 假徽章
        const meta = document.createElement('span')
        meta.className = 'board__project-meta'
        meta.textContent = '80/82 任务完成'
        document.querySelector('.board__main-head').appendChild(meta)
        // R2 视图 tab 整个移出 DOM。⚠️ 不要只 removeAttribute('role')：
        //   静态属性会在轮询触发的 patch 里被 Vue 写回去，反向时绿时红；
        //   移出节点才是稳的"这两个按钮没了"。
        document.querySelectorAll('.board__view-btn').forEach((b) => b.remove())
      })
      // R3 输入框钉成永不收起
      await page.addStyleTag({ content: '.board__search-input { width: 200px !important; padding: 0 8px !important; border-color: var(--input-border) !important; opacity: 1 !important; pointer-events: auto !important; }' })
      await sleep(400)
    }

    /* ── B. 运行时断言 ── */
    console.log('── B. 运行时断言 ──')

    check('B1 标题行里没有「任务完成」徽章',
      await page.locator('.board__project-meta').count() === 0,
      REVERSE ? 'reverse：注入了假徽章，这条必须红' : '')

    const name = await page.locator('.board__project-name').textContent()
    check('B0 标题行仍显示项目名（没把标题行改坏）',
      (name || '').trim() === 'zen-verify-head', `name=${name}`)

    const tabs = await page.evaluate(() => [...document.querySelectorAll('.board__view-btn')].map((b) => ({
      role: b.getAttribute('role'),
      aria: b.getAttribute('aria-label') || '',
      title: b.getAttribute('title') || '',
      text: (b.textContent || '').trim(),
    })))
    check('B2 视图切换 = 两个纯图标 tab（role=tab、aria-label 在、按钮内无文字）',
      tabs.length === 2
      && tabs.every((t) => t.role === 'tab' && /看板|列表|Board|List/.test(t.aria) && t.text === ''),
      JSON.stringify(tabs.map((t) => `${t.role}/${t.aria}/${t.text}`)))

    // B10 默认视图 = 看板。放在一切点击**之前**验：B3 会把视图切走，
    // 那时再验"默认"验的就不是默认了（reverse 下 B3a 失败时视图从没切走，
    // 放在后边会恒绿）。
    const initiallyKanban = await page.locator('.kb__columns').count() > 0
      && await page.locator('.kb__table-wrap').count() === 0
    check('B10 默认视图是看板（localStorage 空值时三列在）', initiallyKanban)

    // B3 切换视图。reverse 下 role 被删，getByRole 找不到 —— 短超时 + 吞异常，
    // 让后面的 waitForSelector 断言判红（点不存在的元素抛异常会吞掉整轮结论）。
    const listTab = page.getByRole('tab', { name: /列表视图|List/ }).first()
    await listTab.click({ timeout: 3000 }).catch((e) => log('B3a click 列表 tab 失败:', String(e.message).slice(0, 200)))
    const listShown = await page.waitForSelector('.kb__table-wrap', { timeout: 3000 }).then(() => true).catch(async () => {
      const diag = await page.evaluate(() => {
        const wrap = document.querySelector('.kb__table-wrap')
        const sel = [...document.querySelectorAll('.board__view-btn')].map((b) => b.getAttribute('aria-selected'))
        return {
          wrap: !!wrap,
          wrapH: wrap ? Math.round(wrap.getBoundingClientRect().height) : -1,
          selected: sel,
          cards: document.querySelectorAll('.kb-card').length,
        }
      })
      log('B3a 诊断:', JSON.stringify(diag))
      return false
    })
    check('B3a 点列表 tab 切到列表视图（.kb__table-wrap 出现）', listShown)
    // B3b 的前置 = 此刻真在 list 视图（B3a 成功的证据）。没有这个前置，
    // B3a 一旦失败视图就还在看板，.kb__columns 原地未动 → 这条恒绿。
    const inListView = await page.locator('.kb__table-wrap').count() > 0
    await page.getByRole('tab', { name: /看板视图|Board/ }).first().click({ timeout: 3000 }).catch(() => {})
    const kanbanShown = inListView
      && await page.waitForSelector('.kb__columns', { timeout: 3000 }).then(() => true).catch(() => false)
    check('B3b 点看板 tab 切回看板视图（.kb__columns 回来）', kanbanShown)

    // B4 默认收起
    const w0 = await inputWidth(page)
    check('B4 搜索默认收起：输入框宽 ≈ 0，只露放大镜按钮',
      w0 >= 0 && w0 < 2 && await page.locator('.board__search-btn').count() === 1,
      `width=${w0.toFixed(1)}px${REVERSE ? '（reverse：钉成 200px，必须红）' : ''}`)

    // B5 点开 → 展开 + 聚焦
    await page.getByRole('button', { name: /搜索任务标题或描述/ }).first().click()
    await sleep(250)
    const focused = await page.evaluate(() =>
      document.activeElement && document.activeElement.classList.contains('board__search-input'))
    const w1 = await inputWidth(page)
    check('B5 点放大镜 → 输入框展开（宽 > 150px）且拿到焦点',
      w1 > 150 && !!focused, `width=${w1.toFixed(1)}px focused=${!!focused}`)

    // B6 搜索词真的在过滤
    await page.locator('.board__search-input').fill('乙')
    await sleep(350)
    const cards = await page.locator('.kb-card').count()
    const todoCount = await page.locator('.kb-col--todo .kb-col__count').first().textContent()
    check('B6 搜索词在过滤（三条任务输入「乙」→ 只剩一张卡）',
      cards === 1 && (todoCount || '').trim() === '1',
      `cards=${cards} todoCount=${todoCount}`)

    // B7 有词失焦不收起；清空失焦收起
    await page.locator('.board__search-input').blur()
    await sleep(400)
    const wKeep = await inputWidth(page)
    check('B7a 有词时失焦不收起（筛选结果还在屏幕上）', wKeep > 150, `width=${wKeep.toFixed(1)}px`)
    await page.locator('.board__search-input').fill('')
    await page.locator('.board__search-input').blur()
    await sleep(400)
    const wDrop = await inputWidth(page)
    check('B7b 空词失焦收起', wDrop >= 0 && wDrop < 2, `width=${wDrop.toFixed(1)}px`)

    // B8 Esc 收起（先点开、灌入词，Esc 只收框不动词）
    await page.locator('.board__search-btn').click()
    await settleWidth(page, true)
    await page.locator('.board__search-input').fill('乙')
    await page.keyboard.press('Escape')
    await sleep(400)
    const wEsc = await inputWidth(page)
    check('B8 Esc 收起', wEsc >= 0 && wEsc < 2, `width=${wEsc.toFixed(1)}px`)

    // B9 几何：动作区不溢出标题行
    const geo = await page.evaluate(() => {
      const head = document.querySelector('.board__main-head').getBoundingClientRect()
      const act = document.querySelector('.board__head-actions').getBoundingClientRect()
      return { headR: head.right, headL: head.left, actR: act.right, actL: act.left, actW: act.width }
    })
    check('B9 动作区不溢出标题行（几何）',
      geo.actR <= geo.headR + 0.5 && geo.actL >= geo.headL - 0.5,
      `actions=[${geo.actL.toFixed(0)},${geo.actR.toFixed(0)}] head=[${geo.headL.toFixed(0)},${geo.headR.toFixed(0)}]`)

    await page.screenshot({ path: path.join(SHOT_DIR, REVERSE ? 'head-reverse.png' : 'head.png') })
    log('截图:', path.join(SHOT_DIR, REVERSE ? 'head-reverse.png' : 'head.png'))
  } finally {
    await browser.close()
  }

  const noisy = (t) => /favicon|ERR_|net::|ResizeObserver|Download the Vue/.test(t)
  const realErrors = pageErrors.filter((t) => !noisy(t))
  check('无 page 错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

  const failed = results.filter((r) => !r.ok)
  console.log('')
  if (pageErrors.length) pageErrors.slice(0, 5).forEach((e) => console.log('  ! ' + e.slice(0, 200)))

  /* --reverse 期望**指定那几条**变红，不是"全红"：S1/S2/B0/B5/B6/B7a/B9 不受
     R1/R2/R3 影响，照旧应当是绿的。 */
  const MUST_FAIL_IN_REVERSE = [
    'B1 标题行里没有「任务完成」徽章',
    'B2 视图切换 = 两个纯图标 tab（role=tab、aria-label 在、按钮内无文字）',
    'B3a 点列表 tab 切到列表视图（.kb__table-wrap 出现）',
    'B3b 点看板 tab 切回看板视图（.kb__columns 回来）',
    'B4 搜索默认收起：输入框宽 ≈ 0，只露放大镜按钮',
    'B7b 空词失焦收起',
    'B8 Esc 收起',
  ]

  console.log(`用例 ${results.length}，通过 ${results.length - failed.length}，失败 ${failed.length}`
    + (REVERSE ? '（--reverse：下面这几条必须红）' : ''))

  let okOverall
  if (REVERSE) {
    const notRed = MUST_FAIL_IN_REVERSE.filter((n) => results.find((r) => r.name === n)?.ok !== false)
    okOverall = notRed.length === 0
    console.log(okOverall
      ? '反向验证通过：旧样子确实被这几条断言挡下'
      : '反向验证失败：旧样子居然过关 —— 断言守错了地方：' + notRed.join(' / '))
  } else {
    okOverall = failed.length === 0
    console.log(okOverall ? '[verify] 合计 PASS' : '[verify] 有失败')
  }
  process.exit(okOverall ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })

/**
 * 左栏项目行「选中态」—— 浏览器交互验证。
 *
 * 背景：用户 2026-10-13「我感觉这块选中状态不是很明显」。原来只有一道
 * 10%→4% 的主色渐变 + 1px 14% 内描边，十几个项目排在一起时分不出
 * "选中" 与 "旁边那行稍微亮一点"。
 *
 * 守的契约（对应 WorkbenchProjectPanel.vue 的 .proj-item.is-active）：
 *   A1 选中行画出左缘 3px **主色**竖条（::before）—— 一屏扫过去不用逐行比对
 *   A2 竖条**不占内容宽度**：所有行的图标槽与项目名左边缘完全一致。
 *      ⚠️ 这条是本脚本最重要的一条：竖条一旦写成 border-left，它挤进内容盒、
 *      把该行内容整体右移 3px，A2 立刻红（verify-wb-proj-icon 的 K5b 也会一起红）。
 *   A3 同一时刻只有一行带 is-active；点另一行，竖条跟着走
 *   A4 选中行的底色是主色渐变，未选中行是 none（"更明显"的另一半）
 *   A5 「全部项目」行与真实项目行同构，选中时同样有竖条
 *   A6 底色只有一个出处：选中一个「正在跑」的项目时，底色仍给选中态
 *      （琥珀 wash 让位给选中），但在跑的信号没丢 —— row1 那枚呼吸圆点还在
 *
 * 夹具是**整份替换** /api/workbench/projects：真实清单里"有在跑的项目"不一定刚好有，
 * 靠真数据撞这条等于让 A6 变成随机绿/红。
 *
 * 反向验证（把实现撤掉后哪几条会红）：
 *   · 删掉 `.proj-item.is-active::before` → A1 / A3 / A5 红
 *   · 竖条改成 `border-left: 3px` → A2 红（该行名字/图标槽右移 3px）
 *   · 底色换回 `--tint-primary-10` 那条更淡的渐变 → A4 仍绿（它只判"有没有渐变"，
 *     判深浅没有稳定口径）—— 所以 A4 守的是"底色来自选中态"，不是"深浅足够"
 *   · 把 `.proj-item.is-running` 上的 `:not(.is-active)` 去掉 → A6 红
 */
const path = require('node:path')
// playwright 装在 src/ui/client 下，把它的 node_modules 挂进解析路径，脚本才能独立跑
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544' // 前端
const API = process.env.ZEN_API || 'http://127.0.0.1:5545' // 后端
const SHOT = process.env.ZEN_SHOT || ''

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function waitUntil(fn, timeout = 12000, interval = 150) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true
    await sleep(interval)
  }
  return false
}

const stats = (over = {}) => ({
  total: 3, todo: 1, doing: 1, done: 1,
  progress: 33, runningJobs: 0, errorSubtasks: 0,
  lastActiveAt: '2026-10-13T02:00:00.000Z', ...over,
})
const git = () => ({
  isGitRepo: true, branch: 'main', upstream: 'origin/main', hasUpstream: true, detached: false,
  ahead: 0, behind: 0, changed: 0, staged: 0, unstaged: 0, untracked: 0,
})
const entry = (name, p, over = {}) => ({
  key: p, path: p, name, source: 'recent', isCurrent: false, exists: true,
  git: git(), iconUrl: null, stats: stats(), ...over,
})

/** 名字带 zen-verify- 前缀：不会和用户真实项目撞车 */
const RUNNING = 'zen-verify-Alpha'
const PLAIN = 'zen-verify-Beta'
const IDLE = 'zen-verify-Gamma'

const FIXTURE = [
  // 正在跑：既用来验 A6（底色归选中态），也验选中态不会吃掉在跑的信号
  entry(RUNNING, '/zen-verify/Alpha', { stats: stats({ runningJobs: 2, total: 5, done: 1 }) }),
  // 普通、有任务：A1/A3/A4 的主角
  entry(PLAIN, '/zen-verify/Beta'),
  // 一个任务都没有：整行没有进度行，验证"行高不同不影响竖条与对齐"
  entry(IDLE, '/zen-verify/Gamma', { stats: stats({ total: 0, todo: 0, doing: 0, done: 0, progress: 0 }) }),
]

/** 页面侧观测：一次拿全"选中态"相关的 DOM + 计算样式 */
function OBS() {
  const root = document.documentElement
  // --color-primary 可能是 hex / color-mix，解析成 rgb 才能和 ::before 的计算值比对
  const probe = document.createElement('div')
  probe.style.background = getComputedStyle(root).getPropertyValue('--color-primary').trim()
  document.body.appendChild(probe)
  const primary = getComputedStyle(probe).backgroundColor
  probe.remove()

  const rows = Array.from(document.querySelectorAll('.proj-item'))
  return {
    primary,
    rows: rows.map((el) => {
      const nameEl = el.querySelector('.proj-item__name')
      const slot = el.querySelector('.proj-item__icon-slot')
      const before = getComputedStyle(el, '::before')
      const cs = getComputedStyle(el)
      return {
        name: nameEl ? (nameEl.textContent || '').trim() : '',
        isAll: el.classList.contains('proj-item--all'),
        active: el.classList.contains('is-active'),
        barContent: before.content,
        barWidth: before.width,
        barBg: before.backgroundColor,
        bgImage: cs.backgroundImage,
        bgColor: cs.backgroundColor,
        runningDot: !!el.querySelector('.proj-item__running'),
        nameLeft: nameEl ? Math.round(nameEl.getBoundingClientRect().left) : null,
        slotLeft: slot ? Math.round(slot.getBoundingClientRect().left) : null,
      }
    }),
  }
}

const isGradient = (s) => typeof s === 'string' && s.includes('linear-gradient')
const isNoneImage = (s) => s === 'none'
const transparent = (s) => s === 'rgba(0, 0, 0, 0)' || s === 'transparent'
const hasBar = (r) => r.barContent !== 'none' && r.barWidth === '3px'
const byName = (o, n) => o.rows.find((r) => r.name === n)
const allRow = (o) => o.rows.find((r) => r.isAll)

async function openBoard(page) {
  await page.waitForSelector('.activity-bar', { timeout: 20000 })
  await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
  await page.waitForSelector('.board', { timeout: 15000 })
  await page.waitForSelector('.proj-item', { timeout: 15000 })
  await waitUntil(async () => (await page.locator('.proj-item').count()) >= FIXTURE.length + 1)
}

async function clickProj(page, name) {
  await page.locator('.proj-item', { hasText: name }).first().click()
  await waitUntil(async () => {
    const o = await page.evaluate(OBS)
    return !!byName(o, name)?.active
  }, 5000)
}
const clickAll = async (page) => {
  await page.locator('.proj-item--all').first().click()
  await waitUntil(async () => !!allRow(await page.evaluate(OBS))?.active, 5000)
}

async function main() {
  const alive = await fetch(`${API}/api/app-version`).then(r => r.ok).catch(() => false)
  if (!alive) {
    console.error(`后端没起（${API}）—— 先 npm run dev`)
    process.exit(2)
  }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  /** 每个状态都记一份"名字/图标槽左边缘"，最后统一断言它们从没变过 */
  const leftEdges = []
  const noteEdges = (o, tag) => {
    leftEdges.push({
      tag,
      names: [...new Set(o.rows.map(r => r.nameLeft))].join('/'),
      slots: [...new Set(o.rows.map(r => r.slotLeft))].join('/'),
    })
  }

  try {
    await page.route('**/api/workbench/projects', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, currentProjectPath: '', projects: FIXTURE }),
    }))

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await openBoard(page)

    // ── 初始：没存过选中项、当前项目也不在夹具里 → 落在「全部项目」 ──
    let o = await page.evaluate(OBS)
    check('A0 夹具就绪：左栏渲染出 3 个项目行 + 「全部项目」行',
      o.rows.length === FIXTURE.length + 1, `实际 ${o.rows.length} 行`)
    const all = allRow(o)
    check('A5 「全部项目」选中时也有左缘竖条（与真实项目行同构）',
      !!(all && all.active && hasBar(all)), `active=${all && all.active} width=${all && all.barWidth}`)
    noteEdges(o, '初始(全部项目选中)')

    // ── A6 前半：在跑的项目**未**选中时，底色是琥珀 wash（平涂，没有渐变） ──
    const runIdle = byName(o, RUNNING)
    check('A6a 未选中时「正在跑」的行底色是琥珀平涂（background-image: none）',
      !!(runIdle && !runIdle.active && isNoneImage(runIdle.bgImage) && !transparent(runIdle.bgColor)),
      `bgImage=${runIdle && runIdle.bgImage} bgColor=${runIdle && runIdle.bgColor} dot=${runIdle && runIdle.runningDot}`)

    // ── A1 / A4：选中一个普通项目 ──
    await clickProj(page, PLAIN)
    o = await page.evaluate(OBS)
    const plain = byName(o, PLAIN)
    check('A1 选中行画出左缘 3px 竖条（::before，content 不是 none）',
      !!(plain && hasBar(plain)), `content=${plain && plain.barContent} width=${plain && plain.barWidth}`)
    check('A1b 竖条用的是主色（与 --color-primary 的计算值逐字一致）',
      !!(plain && plain.barBg === o.primary), `bar=${plain && plain.barBg} primary=${o.primary}`)
    check('A4 选中行的底色是主色渐变；未选中的真实项目行 background-image 是 none',
      !!(plain && isGradient(plain.bgImage))
      && o.rows.filter(r => !r.active && !r.isAll).every(r => isNoneImage(r.bgImage)),
      `选中=${plain && plain.bgImage.slice(0, 40)}`)
    check('A4b 未选中的行不再带左缘竖条',
      o.rows.filter(r => !r.active).every(r => r.barContent === 'none'),
      o.rows.filter(r => !r.active && r.barContent !== 'none').map(r => r.name).join(',') || '无')
    noteEdges(o, `选中 ${PLAIN}`)

    // ── A3：切换选中，竖条跟着走，且始终只有一行 ──
    await clickProj(page, IDLE)
    o = await page.evaluate(OBS)
    const activeRows = o.rows.filter(r => r.active)
    const idle = byName(o, IDLE)
    check('A3 点另一行后，恰好一行是 is-active，且竖条在它身上',
      activeRows.length === 1 && activeRows[0].name === IDLE && hasBar(idle),
      `active=${activeRows.map(r => r.name).join(',')}`)
    check(`A3b 切换后上一行（${PLAIN}）的竖条撤掉了`,
      !hasBar(byName(o, PLAIN)), `width=${byName(o, PLAIN) && byName(o, PLAIN).barWidth}`)
    noteEdges(o, `选中 ${IDLE}`)

    // ── A6 后半：选中「正在跑」的项目 —— 底色给选中态，在跑的圆点还在 ──
    await clickProj(page, RUNNING)
    o = await page.evaluate(OBS)
    const runActive = byName(o, RUNNING)
    check('A6b 选中「正在跑」的项目时，底色仍是选中态的渐变（不被琥珀 wash 盖掉）',
      !!(runActive && runActive.active && isGradient(runActive.bgImage)),
      `bgImage=${runActive && runActive.bgImage.slice(0, 40)} bgColor=${runActive && runActive.bgColor}`)
    check('A6c 底色让位之后，「在跑」的信号没丢：圆形呼吸点还在',
      !!(runActive && runActive.runningDot))
    noteEdges(o, `选中 ${RUNNING}`)

    // ── A2：全程所有行的图标槽 / 项目名左边缘都没动过 ──
    check('A2 竖条不占内容宽度：每个状态下所有行的图标槽左边缘一致',
      new Set(leftEdges.map(e => e.slots)).size === 1,
      leftEdges.map(e => `${e.tag}:${e.slots}`).join(' | '))
    check('A2b 竖条不占内容宽度：每个状态下所有行的项目名左边缘一致',
      new Set(leftEdges.map(e => e.names)).size === 1,
      leftEdges.map(e => `${e.tag}:${e.names}`).join(' | '))

    if (SHOT) {
      await page.mouse.move(1200, 700)
      await sleep(300)
      await page.locator('.proj').first()
        .screenshot({ path: SHOT })
        .catch(() => page.screenshot({ path: SHOT }))
      log(`截图：${SHOT}`)
    }
  } catch (err) {
    check('脚本异常', false, String(err?.message || err))
  } finally {
    await browser.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n用例 ${results.length}，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  failed.forEach(f => console.log(`  - ${f.name} ${f.extra}`))
  const real = consoleErrors.filter(e => !/Failed to fetch|获取当前目录失败|net::ERR|404/.test(e))
  console.log(`控制台错误(过滤噪音): ${real.length}`)
  real.slice(0, 8).forEach(e => console.log('  ! ' + e.slice(0, 220)))
  if (pageErrors.length) {
    console.log(`页面异常: ${pageErrors.length}`)
    pageErrors.slice(0, 4).forEach(e => console.log('  ! ' + e.slice(0, 220)))
  }
  log(`合计 ${failed.length === 0 && real.length === 0 && pageErrors.length === 0 ? 'PASS' : 'FAIL'}`)
  process.exit(failed.length ? 1 : 0)
}

main()

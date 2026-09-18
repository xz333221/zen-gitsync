/**
 * 左栏「项目列表」筛选 —— 浏览器交互验证。
 *
 * 守的契约（对应 WorkbenchProjectPanel.vue 的 visible / filtering）：
 *   P1  有项目时筛选条才渲染（没有项目时整块不占位）
 *   P2  搜索按项目名匹配；P3 大小写不敏感；P4 也匹配路径
 *   P5/P6 筛没了要**说出来**（「没有匹配的项目」+ 清除按钮），且不能和「尚无项目」混为一谈
 *   P7  「只看有任务」按 stats.total === 0 排除
 *   P8  「隐藏非 Git」只排除**明确探到不是仓库**的 —— isGitRepo === null（没探到）必须留下。
 *       ⚠️ 这条是本脚本最重要的一条：把 `isGitRepo === false` 写成 `!isGitRepo`，
 *       null 与 false 一起被藏，delta 立刻消失 → P8 红。
 *   P9  两个开关可叠加；P10 计数改成「匹配 n/total」；P11 aria-pressed 与 is-on 同步
 *   P12 Esc 清空搜索；P13 项目数为 0 时筛选条不渲染 + 显示「尚无项目」（反向锚）
 *
 * 夹具是**整份替换** `/api/workbench/projects`（不是追加）：真实 home 里
 * "有任务/没任务/非 Git/没探到"这四种形态不一定凑得齐，追加式伪造等于靠运气撞。
 * 每个项目钉一条契约，断言之间互不干扰。
 *
 * 反向验证（把修复撤掉后哪几条会红）：
 *   · 去掉 onlyWithTasks 那行过滤 → P7 / P9 / P10 红
 *   · 把 hideNonGit 的 `p.git.isGitRepo === false` 改成 `!p.git?.isGitRepo` → P8 红
 *   · 把 visible 换回 ordered（筛选不生效）→ P2/P4/P7/P8/P9 红，P13 仍绿
 *   · 去掉空状态那个 li → P5 红、P6 红（找不到清除按钮）
 */
const path = require('node:path')
// playwright 装在 src/ui/client 下，把它的 node_modules 挂进解析路径，脚本才能独立跑
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544' // 前端
const API = process.env.ZEN_API || 'http://127.0.0.1:5545' // 后端

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
  lastActiveAt: '2026-09-18T02:00:00.000Z', ...over,
})
const noneStats = () => stats({ total: 0, todo: 0, doing: 0, done: 0, progress: 0 })
const git = (over = {}) => ({
  isGitRepo: true, branch: null, upstream: null, hasUpstream: false, detached: false,
  ahead: 0, behind: 0, changed: 0, staged: 0, unstaged: 0, untracked: 0, ...over,
})

/** 每个项目钉一条契约；名前缀 zen-verify- 以免和真实项目撞车 */
const entry = (name, p, over = {}) => ({
  key: p, path: p, name, source: 'recent', isCurrent: false, exists: true, ...over,
})

const FIXTURE = [
  // 有任务 + Git：三种筛选下都该留下
  entry('zen-verify-Alpha', '/zen-verify/Alpha', { git: git({ branch: 'main' }), stats: stats() }),
  // 没有任务 + 明确非 Git：会被两个开关分别命中
  entry('zen-verify-Beta', '/zen-verify/Beta', { git: git({ isGitRepo: false }), stats: noneStats() }),
  // 有任务 + Git，且路径里有一段别的项目没有的目录 —— 给"按路径搜"用
  entry('zen-verify-Gamma', '/zen-verify/zzz-deep-path/Gamma', { git: git({ branch: 'dev' }), stats: stats() }),
  // 没有任务 + isGitRepo=null（没探到）：两个开关都不该动它
  entry('zen-verify-Delta', '/zen-verify/Delta', { git: { ...git(), isGitRepo: null }, stats: noneStats() }),
]

const NAMES = FIXTURE.map(f => f.name)

/** 页面侧的观测函数：一次拿全筛选相关的 DOM 状态 */
function OBS() {
  const rows = Array.from(document.querySelectorAll('.proj-item'))
    .filter(n => !n.classList.contains('proj-item--all'))
  const input = document.querySelector('.proj__search-input')
  return {
    names: rows.map(n => (n.querySelector('.proj-item__name')?.textContent || '').trim()),
    hasTools: !!document.querySelector('.proj__tools'),
    count: (document.querySelector('.proj__count')?.textContent || '').replace(/\s+/g, ' ').trim(),
    toggles: Array.from(document.querySelectorAll('.proj__toggle')).map(b => ({
      text: (b.textContent || '').trim(),
      pressed: b.getAttribute('aria-pressed'),
      on: b.classList.contains('is-on'),
    })),
    emptyTitle: (document.querySelector('.proj-empty__title')?.textContent || '').trim() || null,
    hasClear: !!document.querySelector('.proj-empty__clear'),
    query: input ? input.value : null,
  }
}

/** 排序无关的集合比较 */
const sameSet = (a, b) => {
  const x = [...a].sort(); const y = [...b].sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
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

  const fulfillProjects = (projects) => page.route('**/api/workbench/projects', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, projects, counts: {} }),
    })
  )

  await fulfillProjects(FIXTURE)

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.board', { timeout: 15000 })

    const obs = () => page.evaluate(OBS)
    const search = page.locator('.proj__search-input')
    const onlyTasks = page.locator('.proj__toggle').nth(0)
    const hideNonGit = page.locator('.proj__toggle').nth(1)

    // ── P0 / P1：夹具与筛选条 ────────────────────────────────────────
    const ready = await waitUntil(async () => (await obs()).names.length >= FIXTURE.length)
    let s = await obs()
    check(`P0 夹具就绪：左栏渲染出 ${FIXTURE.length} 个合成项目`, ready, `实际 ${s.names.length} 行`)
    check('P1a 有项目时筛选条渲染', s.hasTools)
    check('P1b 两个开关文案正确（顺序：只看有任务 / 隐藏非 Git）',
      s.toggles.length === 2 && s.toggles[0].text === '只看有任务' && s.toggles[1].text === '隐藏非 Git',
      JSON.stringify(s.toggles.map(t => t.text)))
    check('P1c 未筛选时计数就是项目总数', s.count === String(FIXTURE.length), `count="${s.count}"`)

    // ── P2 / P3 / P4：搜索 ──────────────────────────────────────────
    await search.fill('Alpha')
    await waitUntil(async () => (await obs()).names.length === 1)
    s = await obs()
    check('P2 搜索按项目名过滤', sameSet(s.names, ['zen-verify-Alpha']), JSON.stringify(s.names))

    await search.fill('aLpHa')
    await waitUntil(async () => (await obs()).names.length === 1)
    s = await obs()
    check('P3 搜索大小写不敏感', sameSet(s.names, ['zen-verify-Alpha']), JSON.stringify(s.names))

    // 路径独有片段：Gamma 的路径里有 zzz-deep-path，别的项目都没有
    await search.fill('zzz-deep-path')
    await waitUntil(async () => (await obs()).names.length === 1)
    s = await obs()
    check('P4 搜索也匹配路径', sameSet(s.names, ['zen-verify-Gamma']), JSON.stringify(s.names))

    // ── P5 / P6：筛没了要说出来 ─────────────────────────────────────
    await search.fill('绝对不存在的项目名')
    await waitUntil(async () => (await obs()).names.length === 0)
    s = await obs()
    check('P5a 无匹配时一行项目都不渲染', s.names.length === 0, JSON.stringify(s.names))
    check('P5b 显示「没有匹配的项目」', s.emptyTitle === '没有匹配的项目', `emptyTitle="${s.emptyTitle}"`)
    check('P5c 提供「清除筛选」按钮', s.hasClear)
    check('P5d 不能和「尚无项目」混淆', s.emptyTitle !== '尚无项目', `emptyTitle="${s.emptyTitle}"`)

    await page.locator('.proj-empty__clear').click()
    await waitUntil(async () => (await obs()).names.length === FIXTURE.length)
    s = await obs()
    check('P6a 清除筛选后项目全部回来', sameSet(s.names, NAMES), JSON.stringify(s.names))
    check('P6b 清除后搜索框被清空', s.query === '', `query="${s.query}"`)
    check('P6c 清除后两个开关都回到未选中',
      s.toggles.every(t => t.pressed === 'false' && !t.on), JSON.stringify(s.toggles))

    // ── P7：只看有任务 ──────────────────────────────────────────────
    await onlyTasks.click()
    await waitUntil(async () => (await obs()).names.length === 2)
    s = await obs()
    check('P7a 「只看有任务」留下有任务的两个（正向锚）',
      sameSet(s.names, ['zen-verify-Alpha', 'zen-verify-Gamma']), JSON.stringify(s.names))
    check('P7b 没有任务的 Beta / Delta 被排除',
      !s.names.includes('zen-verify-Beta') && !s.names.includes('zen-verify-Delta'), JSON.stringify(s.names))
    check('P7c 开关进入选中态', s.toggles[0].pressed === 'true' && s.toggles[0].on)

    await onlyTasks.click()
    await waitUntil(async () => (await obs()).names.length === FIXTURE.length)

    // ── P8：隐藏非 Git（本脚本最关键的一条） ────────────────────────
    await hideNonGit.click()
    await waitUntil(async () => (await obs()).names.length === 3)
    s = await obs()
    check('P8a 明确非 Git 的 Beta 被隐藏', !s.names.includes('zen-verify-Beta'), JSON.stringify(s.names))
    check('P8b isGitRepo=null（没探到）的 Delta 必须留下 —— 没探到不等于不是仓库',
      s.names.includes('zen-verify-Delta'), JSON.stringify(s.names))
    check('P8c 另外两个 Git 仓库照常显示（正向锚）',
      s.names.includes('zen-verify-Alpha') && s.names.includes('zen-verify-Gamma'), JSON.stringify(s.names))

    // ── P9 / P10：叠加 ─────────────────────────────────────────────
    await onlyTasks.click()
    await waitUntil(async () => (await obs()).names.length === 2)
    s = await obs()
    check('P9 只看有任务 + 隐藏非 Git 叠加：只剩两个有任务的 Git 仓库',
      sameSet(s.names, ['zen-verify-Alpha', 'zen-verify-Gamma']), JSON.stringify(s.names))
    check('P10 计数改成「匹配 n/total」',
      s.count === `匹配 2/${FIXTURE.length} 个项目`, `count="${s.count}"`)
    check('P11 两个开关的 aria-pressed 与 is-on 同步',
      s.toggles.every(t => t.pressed === 'true' && t.on), JSON.stringify(s.toggles))

    // ── P12：Esc 清空 ──────────────────────────────────────────────
    await search.fill('Gamma')
    await waitUntil(async () => (await obs()).names.length === 1)
    await search.press('Escape')
    await waitUntil(async () => (await obs()).query === '')
    s = await obs()
    check('P12 Esc 清空搜索框，列表随之恢复', s.query === '' && s.names.length === 2, JSON.stringify(s))

    // ── P13：项目数为 0 —— 筛选条不该占位 ───────────────────────────
    await page.unroute('**/api/workbench/projects')
    await fulfillProjects([])
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.board', { timeout: 15000 })
    await waitUntil(async () => (await obs()).emptyTitle === '尚无项目')
    s = await obs()
    check('P13a 一个项目都没有时显示「尚无项目」（正向锚：空状态还在）',
      s.emptyTitle === '尚无项目', `emptyTitle="${s.emptyTitle}"`)
    check('P13b 一个项目都没有时筛选条整块不渲染（空状态不占位）', !s.hasTools)
  } catch (err) {
    check('脚本异常', false, String(err?.message || err))
  } finally {
    await browser.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n用例 ${results.length}，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  failed.forEach(f => console.log(`  - ${f.name} ${f.extra}`))
  const real = consoleErrors.filter(e => !/Failed to fetch|获取当前目录失败|404|net::ERR/.test(e))
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

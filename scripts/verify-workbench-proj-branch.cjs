/**
 * 工作台**左栏项目列表**每一行的渲染契约（分支位 + 进度行）。
 *
 * 验收契约（改这块时别破坏）：
 *   F1 真的在某个分支上   -> 显示分支名 + 名字**左边**一个 git-branch 图标
 *   F2 图标几何           -> 图标右缘 <= 分支名左缘；图标有实际尺寸（11px 一档）
 *   F3 **不是 Git 仓库**  -> 分支位整段不渲染（不留「不是 Git 仓库」这类文字）
 *     ⚠️ 回归点：曾经这里写着一句「不是 Git 仓库」。它把 row2 撑长、把项目名挤成
 *        省略号，而且信息量为零 —— 那一格空着本身就等于"这儿没有分支"。
 *   F4 游离 HEAD          -> 「游离 HEAD」+ 图标（落在分离头指针上，仍然是"有分支位"）
 *   F5 没探到（null）     -> 「未知」且**不挂图标**（宁可什么都不标，也别谎报）
 *   F6 长分支名           -> 省略号真的发生（scrollWidth > clientWidth），且发生在
 *        `.proj-item__branch-name` 这一层
 *     ⚠️ 回归点：省略号一度挂在 flex 容器 `.proj-item__branch` 上 —— text-overflow
 *        管不到子元素的文本节点，长分支名会直接顶破 130px 把后面的时间戳挤走。
 *   F7 图标颜色           -> 与分支名同色（SvgIcon 自己声明了
 *        `.svg-icon{color:--text-secondary}`，覆盖它必须**锚在 .proj-item__branch 下**
 *        把权重抬到 (0,3,0)；裸 :deep() 与之同为 (0,2,0)，谁生效只看样式表注入顺序）
 *   F8 exists=false 优先  -> 目录都不存在时只显示「目录不存在」，不显示分支位
 *   G1 total=0            -> **进度行整行不渲染**（不留「0/0 任务完成」和空进度条）
 *     ⚠️ 回归点：一排 0/0 + 空进度条是纯噪声，占的行高还让有任务的项目不显眼。
 *   G2 total>0            -> 进度行照常渲染（G1 不能变成"把进度行全关了"）
 *
 * 前置：dev server 已启动（npm run dev，后端 5545 / 前端 5544）。
 * 用法：node scripts/verify-workbench-proj-branch.cjs
 * 退出码：0 全通过，1 有失败项，2 环境没起。
 *
 * 数据不碰真实 config：整份替换 `/api/workbench/projects` 的响应体（只改响应）。
 */
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544'
const API = process.env.ZEN_API || 'http://127.0.0.1:5545'

const LONG_BRANCH = 'feature/BUGFIX-12345-extremely-long-branch-name-for-ellipsis'

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 固定 sleep 会误判（route 的 fetch→fulfill 偶发慢到 2.5s+），统一轮询 */
async function waitUntil(fn, timeout = 12000, interval = 150) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true
    await sleep(interval)
  }
  return false
}

const stats = (over = {}) => ({
  total: 3, todo: 1, doing: 1, review: 0, done: 1,
  progress: 33, runningJobs: 0, errorSubtasks: 0, lastActiveAt: '2026-09-18T02:00:00.000Z', ...over,
})

const git = (over = {}) => ({
  isGitRepo: true, branch: null, upstream: null, hasUpstream: false, detached: false,
  ahead: 0, behind: 0, changed: 0, staged: 0, unstaged: 0, untracked: 0, ...over,
})

/** 各原子用例各占一个项目，名字前缀带 zen-verify- 以免和真实项目撞车 */
const FIXTURE = [
  { key: '/zen-verify/RepoMain', path: '/zen-verify/RepoMain', name: 'zen-verify-RepoMain',
    source: 'recent', isCurrent: false, exists: true, git: git({ branch: LONG_BRANCH }), stats: stats() },
  { key: '/zen-verify/PlainFolder', path: '/zen-verify/PlainFolder', name: 'zen-verify-PlainFolder',
    source: 'recent', isCurrent: false, exists: true, git: git({ isGitRepo: false }), stats: stats() },
  { key: '/zen-verify/DetachedRepo', path: '/zen-verify/DetachedRepo', name: 'zen-verify-DetachedRepo',
    source: 'recent', isCurrent: false, exists: true, git: git({ detached: true }), stats: stats() },
  { key: '/zen-verify/UnknownGit', path: '/zen-verify/UnknownGit', name: 'zen-verify-UnknownGit',
    source: 'recent', isCurrent: false, exists: true, git: { ...git(), isGitRepo: null }, stats: stats() },
  { key: '/zen-verify/MissingDir', path: '/zen-verify/MissingDir', name: 'zen-verify-MissingDir',
    source: 'recent', isCurrent: false, exists: false, git: git({ branch: 'main' }), stats: stats() },
  // G1：一个任务都没有 -> 整条进度行不该出现
  { key: '/zen-verify/NoTask', path: '/zen-verify/NoTask', name: 'zen-verify-NoTask',
    source: 'recent', isCurrent: false, exists: true, git: git({ branch: 'main' }),
    stats: stats({ total: 0, todo: 0, doing: 0, done: 0, progress: 0 }) },
]

/** 一行的 row2 观测结果；只取语义，不把选择器范围搞混 */
const ROW = (name) => {
  const el = Array.from(document.querySelectorAll('.proj-item')).find(
    (n) => !n.classList.contains('proj-item--all')
      && n.querySelector('.proj-item__name')?.textContent.trim() === name
  )
  if (!el) return null
  const row2 = el.querySelector('.proj-item__row2')
  const branch = el.querySelector('.proj-item__branch')
  const icon = el.querySelector('.proj-item__branch-icon')
  const nameEl = el.querySelector('.proj-item__branch-name')
  const rect = (n) => (n ? n.getBoundingClientRect() : null)
  const box = (n) => {
    const r = rect(n)
    return r ? { left: +r.left.toFixed(2), right: +r.right.toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2) } : null
  }
  const row3 = el.querySelector('.proj-item__row3')
  return {
    row2Text: row2 ? row2.textContent.trim() : null,
    hasBranch: !!branch,
    branchText: nameEl ? nameEl.textContent.trim() : null,
    // 「未知」有文字但没图标 —— 所以这两个要分开看
    iconHTML: icon ? icon.outerHTML.slice(0, 200) : null,
    iconBox: box(icon),
    nameBox: box(nameEl),
    iconColor: icon ? getComputedStyle(icon).color : null,
    nameColor: nameEl ? getComputedStyle(nameEl).color : null,
    // 省略号是否真的发生：内容比可视宽度长
    nameOverflowed: nameEl ? nameEl.scrollWidth > nameEl.clientWidth : null,
    branchBox: box(branch),
    // 进度行（G1/G2）：有没有整行、里面写的是什么、有没有进度条本体
    hasRow3: !!row3,
    row3Text: row3 ? row3.textContent.replace(/\s+/g, ' ').trim() : null,
    hasBar: !!el.querySelector('.proj-item__bar'),
  }
}

async function main() {
  // 探活失败就 exit 2，别让"环境没起"伪装成"用例失败"
  const alive = await fetch(`${API}/api/app-version`).then((r) => r.ok).catch(() => false)
  if (!alive) {
    console.error(`后端没起（${API}）—— 先 npm run dev`)
    process.exit(2)
  }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  // 整份替换项目列表：真实 home 里有没有非 Git 仓库、分支名多长都不由我们说了算
  await page.route('**/api/workbench/projects', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, projects: FIXTURE, counts: {} }),
    })
  )

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.board', { timeout: 15000 })

    // 等到夹具项目全部渲染出来（1 个「全部项目」+ N）
    const ready = await waitUntil(async () => (await page.locator('.proj-item').count()) >= FIXTURE.length + 1)
    check(`夹具就绪：左栏渲染出 ${FIXTURE.length} 个合成项目`, ready, `实际 ${await page.locator('.proj-item').count()} 行`)

    // 图标能不能画出来，取决于 sprite 里有没有注册这个 symbol
    const symbolOk = await page.evaluate(() => !!document.querySelector('symbol#icon-git-branch'))
    check('F0 sprite 已注册 symbol#icon-git-branch', symbolOk)

    const rows = await page.evaluate(
      ([fn, names]) => {
        // ROW 需要 document / getComputedStyle，只能在页面上下文里重新落地
        // eslint-disable-next-line no-eval
        const ROW = eval(`(${fn})`)
        return Object.fromEntries(names.map((n) => [n, ROW(n)]))
      },
      [ROW.toString(), FIXTURE.map((f) => f.name)]
    )
    FIXTURE.forEach((f) => { if (!rows[f.name]) check(`夹具行存在 ${f.name}`, false, '没找到 .proj-item') })

    /* ---------- F1 / F2：真分支 + 图标在左边 ---------- */
    const main = rows['zen-verify-RepoMain'] || {}
    check('F1a 真分支：渲染分支位', main.hasBranch === true && main.branchText === LONG_BRANCH,
      `hasBranch=${main.hasBranch} text=${main.branchText}`)
    const useHrefOk = !!main.iconHTML && main.iconHTML.includes('#icon-git-branch')
    check('F1b 真分支：图标用的正是 git-branch', useHrefOk, main.iconHTML || 'null')
    check('F2a 图标有实际尺寸（不是 0 宽）', !!main.iconBox && main.iconBox.width > 0 && main.iconBox.height > 0,
      JSON.stringify(main.iconBox))
    check('F2b 图标在分支名左边（几何）',
      !!main.iconBox && !!main.nameBox && main.iconBox.right <= main.nameBox.left,
      `icon.right=${main.iconBox?.right} <= name.left=${main.nameBox?.left}`)

    /* ---------- F3：不是 Git 仓库 -> 整段不渲染 ---------- */
    const plain = rows['zen-verify-PlainFolder'] || {}
    check('F3a 非 Git 仓库：分支位不渲染', plain.hasBranch === false && !plain.iconHTML,
      `hasBranch=${plain.hasBranch}`)
    check('F3b 非 Git 仓库：row2 里没有「不是 Git 仓库」这类文字',
      !!plain.row2Text && !/不是\s*Git\s*仓库|Not a Git repo/.test(plain.row2Text),
      `row2="${plain.row2Text}"`)

    /* ---------- F4：游离 HEAD ---------- */
    const det = rows['zen-verify-DetachedRepo'] || {}
    check('F4 游离 HEAD：有文字且有图标',
      det.branchText === '游离 HEAD' && !!det.iconHTML && det.iconHTML.includes('#icon-git-branch'),
      `text=${det.branchText} icon=${det.iconHTML ? 'yes' : 'no'}`)

    /* ---------- F5：没探到 -> 未知，不挂图标 ---------- */
    const unk = rows['zen-verify-UnknownGit'] || {}
    check('F5 未探到：显示「未知」但不挂图标',
      unk.branchText === '未知' && !unk.iconHTML,
      `text=${unk.branchText} icon=${unk.iconHTML ? 'yes' : 'no'}`)

    /* ---------- F6：长分支名的省略号发生在名字那层 ---------- */
    check('F6 长分支名截断（省略号真的发生）', main.nameOverflowed === true,
      `scrollW>clientW = ${main.nameOverflowed}`)

    /* ---------- F7：图标与分支名同色 ---------- */
    check('F7 图标与分支名同色', !!main.iconColor && main.iconColor === main.nameColor,
      `icon=${main.iconColor} name=${main.nameColor}`)

    /* ---------- F8：目录不存在优先于分支位 ---------- */
    const miss = rows['zen-verify-MissingDir'] || {}
    check('F8 目录不存在：只显示「目录不存在」，不显示分支位',
      miss.hasBranch === false && !!miss.row2Text && miss.row2Text.includes('目录不存在'),
      `hasBranch=${miss.hasBranch} row2="${miss.row2Text}"`)

    /* ---------- G1：一个任务都没有 -> 进度行整行不渲染 ---------- */
    const noTask = rows['zen-verify-NoTask'] || {}
    check('G1a 无任务的项目：不渲染进度行', noTask.hasRow3 === false,
      `hasRow3=${noTask.hasRow3} row3Text="${noTask.row3Text}"`)
    check('G1b 无任务的项目：进度条本体也不在（不是只藏了文字）', noTask.hasBar === false,
      `hasBar=${noTask.hasBar}`)
    check('G1c 无任务的项目：整行文本里不该出现「任务完成」',
      !!noTask.row3Text === false || !/任务完成/.test(noTask.row3Text),
      `row3Text="${noTask.row3Text}"`)

    /* ---------- G2：有任务的项目照旧渲染（防止 G1 变成"把进度行全关了"） ---------- */
    check('G2 有任务的项目：进度行照常渲染且文案正确',
      main.hasRow3 === true && main.hasBar === true && /1\/3\s*任务完成/.test(main.row3Text || ''),
      `hasRow3=${main.hasRow3} hasBar=${main.hasBar} row3Text="${main.row3Text}"`)
  } catch (err) {
    check('脚本异常', false, String(err?.message || err))
  } finally {
    await browser.close()
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n用例 ${results.length}，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  failed.forEach((f) => console.log(`  - ${f.name} ${f.extra}`))
  const real = consoleErrors.filter((e) => !/Failed to fetch|获取当前目录失败|404|net::ERR/.test(e))
  console.log(`控制台错误(过滤噪音): ${real.length}`)
  real.slice(0, 8).forEach((e) => console.log('  ! ' + e.slice(0, 220)))
  if (pageErrors.length) console.log(`页面异常: ${pageErrors.length}`)
  process.exit(failed.length ? 1 : 0)
}

main()

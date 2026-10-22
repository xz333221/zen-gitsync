/**
 * Skill / MCP 广场「已安装」区的展示与「打开文件夹」验证。
 *
 * 验收的行为契约（改这块 UI 时别破坏）：
 *   A 已安装行必须**同时**显示 SKILL.md 里的 name 和实际落盘的目录 id。
 *     这两个名字经常不一样：仓库叫 taste-skill，里面的 SKILL.md 却自称 brandkit。
 *     过去只显示 name，用户点着装完回列表里找不到"taste-skill"，
 *     只能怀疑是不是没装成功 —— 这一条就是那次反馈的直接回归点。
 *   B 每个已安装行要有「打开文件夹」按钮，点了打 POST /api/agent/marketplace/reveal，
 *     只带 type / target / id / cwd（路径由后端推导，前端不传路径，免路径穿越）。
 *   C id 与 name 相同时不显示重复的 id 角标（反向自证：角标不是无脑常显）。
 *   E 卡片图标三层契约：有 repository → 品牌 logo 图（simple-icons CDN）；
 *     名单外且无 repository → 首字母砖；图片加载失败（路由 abort）→
 *     也退回首字母砖，不留破图。E1 同时充当"新代码在跑吗"的开路断言
 *     （旧版卡片没有 .mp-card-icon，dev server 模块过期时它必红）。
 *   F 来源筛选：筛选项来自 /marketplace/sources（与 catalog 返回的组无关），
 *     点一下要真的重拉目录并带上 sources=；「全部来源」把筛选清空。
 *     这是「点了标签没反应」那次反馈的回归点：旧代码 watch(selectedSources)
 *     没开 deep，push/splice 原地改数组不触发监听 —— 只有标签自己亮一下。
 *
 * 前置：dev server 已启动（npm run dev；前端 5544，后端 5545）。
 * 用法：node scripts/verify-marketplace-panel.cjs
 * 退出码：0 全通过，1 有失败项。
 */
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// 完全走固定桩数据：不依赖真机上装没装过东西，也不依赖当前选中的项目
const CWD = 'C:\\verify\\project'
const DIFFERENT = {
  id: 'github-Leonxlnx-taste-skill',
  name: 'brandkit',
  description: 'Premium brand-kit image generation skill',
  target: 'project',
  dir: `${CWD}\\.zen-gitsync\\ai\\skills\\github-Leonxlnx-taste-skill`,
}
const SAME = { id: 'docx', name: 'docx', description: 'Word 处理', target: 'project', dir: `${CWD}\\.zen-gitsync\\ai\\skills\\docx` }

// 图标契约用例：有 repository（命中 curated 名单 anthropic → claude logo）
const REPO_ITEM = {
  id: 'docx', name: 'docx', description: 'Word 文档处理', repository: 'anthropics/skills',
  subpath: 'skills/docx', installable: true, installed: false,
}
// 名字不在 curated 名单、又没有 repository → 只能渲染首字母砖
const UNKNOWN_ITEM = { id: 'zzz-unknown', name: 'zzz-unknown', description: '名单外条目', installable: true, installed: false }

// null = 用默认的 docx 卡片（保持 A/B/C 段行为不变）
let fixtureItems = null

// 筛选器桩：来源清单 3 个，但 catalog 只回得来 2 个组（npm 那组"取不到"）。
// 这样 chips 数量与 groups 数量对不上 —— 谁把 chips 从 groups 推出来，F1 立刻红。
const SOURCES = [
  { id: 'builtin', label: '内置精选', kind: 'builtin' },
  { id: 'official', label: 'Anthropic 官方仓库', kind: 'live' },
  { id: 'npm', label: 'npm', kind: 'live' },
]
const PDF_ITEM = {
  id: 'pdf', name: 'pdf', description: 'PDF 处理', repository: 'anthropics/skills',
  subpath: 'skills/pdf', installable: true, installed: false,
}
let respectSources = false
const catalogRequests = []

function groupOf(id) {
  if (id === 'builtin') {
    return {
      id: 'builtin', label: '内置精选', kind: 'builtin', status: 'ok', count: 1,
      items: fixtureItems || [{
        id: 'docx', name: 'docx', description: 'Word 文档处理', repository: 'anthropics/skills',
        subpath: 'skills/docx', installable: true, installed: false,
      }],
    }
  }
  if (id === 'official') {
    return { id: 'official', label: 'Anthropic 官方仓库', kind: 'live', status: 'ok', count: 1, items: [PDF_ITEM] }
  }
  return null
}

function catalogBody(installed, requested) {
  // 老用例（A/B/C/E）走老桩：恒回 builtin 一组，卡片数才确定
  const ids = respectSources ? (requested.length ? requested : ['builtin', 'official']) : ['builtin']
  return {
    success: true,
    type: 'skill',
    query: '',
    cwd: CWD,
    groups: ids.map(groupOf).filter(Boolean),
    installed,
  }
}

async function openMarketplace(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.activity-bar', { timeout: 30000 })
  await page.locator('.activity-btn[aria-label^="智能体"]').first().click()
  await page.waitForSelector('.agent-tabs', { timeout: 15000 })
  await page.locator('.agent-tab').filter({ hasText: 'Skill 广场' }).first().click()
  await page.waitForSelector('.marketplace-panel', { timeout: 15000 })
  await page.waitForSelector('.mp-chip', { timeout: 15000 })
  await page.waitForSelector('.mp-installed-row', { timeout: 15000 })
}

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', e => pageErrors.push(String(e)))

  let fixture = [DIFFERENT]
  const revealCalls = []
  let revealStatus = 200
  let deliberate404 = false
  let iconAborted = false
  await page.route('**/api/agent/marketplace/catalog*', route => {
    const url = new URL(route.request().url())
    catalogRequests.push(url)
    const requested = String(url.searchParams.get('sources') || '').split(',').filter(Boolean)
    return route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(catalogBody(fixture, requested)),
    })
  })
  await page.route('**/api/agent/marketplace/sources*', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, type: 'skill', sources: SOURCES }),
  }))
  await page.route('**/api/agent/marketplace/reveal', async route => {
    revealCalls.push(JSON.parse(route.request().postData() || '{}'))
    await route.fulfill({
      status: revealStatus,
      contentType: 'application/json',
      body: JSON.stringify(revealStatus === 200 ? { success: true } : { success: false, error: '目标不存在' }),
    })
  })

  try {
    await openMarketplace(page)

    // ── A 名字对不上时的展示 ──────────────────────────────────────
    const row = page.locator('.mp-installed-row').first()
    check('A1 已安装行渲染出 name', (await row.locator('.mp-installed-name').innerText()).trim() === 'brandkit')
    const idChip = row.locator('.mp-installed-id')
    check('A2 同时显示实际落盘的目录 id', await idChip.count() === 1
      && (await idChip.innerText()).trim() === 'github-Leonxlnx-taste-skill',
    `id="${await idChip.count() ? (await idChip.innerText()).trim() : '(缺失)'}"`)

    // ── B 打开文件夹 ─────────────────────────────────────────────
    const revealBtn = row.locator('.mp-reveal-btn')
    check('B0 点之前没有发出过 reveal 请求（自证：请求由点击触发）', revealCalls.length === 0, `已发 ${revealCalls.length} 次`)
    check('B1 已安装行有「打开文件夹」按钮', await revealBtn.count() === 1
      && (await revealBtn.innerText()).trim() === '打开文件夹')
    await revealBtn.click()
    await sleep(800)
    check('B2 点击发出一次 reveal 请求', revealCalls.length === 1, `实际 ${revealCalls.length} 次`)
    const body = revealCalls[0] || {}
    // cwd 用的是应用当前选中的项目（不在桩数据里），这里只要求它非空
    check('B3 请求体只带 type/target/id/cwd，不带路径',
      body.type === 'skill' && body.target === 'project' && body.id === DIFFERENT.id
      && typeof body.cwd === 'string' && body.cwd.length > 0
      && !('path' in body) && !('dir' in body),
      JSON.stringify(body))
    check('B4 成功后不弹错误提示', (await page.locator('.el-message--error').count()) === 0)

    // ── B5 失败路径也要有提示（不是静默吞掉）──────────────────────
    revealStatus = 404
    deliberate404 = true
    await revealBtn.click()
    await sleep(800)
    const errText = (await page.locator('.el-message--error').count())
      ? (await page.locator('.el-message--error').first().innerText()).trim()
      : ''
    check('B5 后端报错时弹出错误提示', errText.length > 0, `提示="${errText}"`)
    revealStatus = 200

    // ── C 反向自证：id 与 name 相同就不该有重复角标 ────────────────
    fixture = [SAME]
    await openMarketplace(page)
    const sameRow = page.locator('.mp-installed-row').first()
    check('C1 id 与 name 相同时不显示 id 角标', (await sameRow.locator('.mp-installed-id').count()) === 0)
    check('C2 该行按钮仍在', (await sameRow.locator('.mp-reveal-btn').count()) === 1)

    // ── E 图标契约 ─────────────────────────────────────────────
    // E1：有 repository 的条目渲染品牌 logo 图（anthropic 命中 curated 名单 → claude）。
    //     只断 src 不断 naturalWidth：CDN 通不通是网络问题，不是契约问题；
    //     这条同时是"新代码在跑吗"的开路断言（旧卡片没有 .mp-card-icon）。
    fixtureItems = [REPO_ITEM]
    await openMarketplace(page)
    const iconImg = page.locator('.mp-card-icon img')
    const iconSrc = await iconImg.count() === 1 ? (await iconImg.getAttribute('src')) || '' : ''
    check('E1 有 repository 的卡片渲染品牌 logo 图',
      iconSrc.includes('cdn.simpleicons.org/claude'), `src="${iconSrc || '(缺失)'}"`)

    // E2（反向）：名单外 + 无 repository → 首字母砖，不是破图也不是空占位
    fixtureItems = [UNKNOWN_ITEM]
    await openMarketplace(page)
    const tile = page.locator('.mp-card-icon.tile')
    check('E2 名单外条目渲染首字母砖',
      await tile.count() === 1 && (await tile.innerText()).trim() === 'Z',
      `count=${await tile.count()}`)

    // E3：图标请求被 abort → @error 兜底退回首字母砖（GitHub 头像 404/抖动同路径）
    iconAborted = true
    await page.route('https://cdn.simpleicons.org/**', route => route.abort())
    fixtureItems = [REPO_ITEM]
    await openMarketplace(page)
    await page.waitForSelector('.mp-card-icon.tile', { timeout: 10000 })
    const fallbackTile = page.locator('.mp-card-icon.tile')
    check('E3 图标加载失败退回首字母砖',
      await fallbackTile.count() === 1 && (await fallbackTile.innerText()).trim() === 'D'
      && await page.locator('.mp-card-icon img').count() === 0,
      `tile="${await fallbackTile.count() ? (await fallbackTile.innerText()).trim() : '(缺失)'}"`)

    // ── F 来源筛选（「点了标签没反应」的回归点）────────────────────
    respectSources = true
    await openMarketplace(page)
    const chips = page.locator('.mp-chip:not(.clear)')
    const chipLabels = (await chips.allInnerTexts()).map(t => t.trim())
    check('F1 筛选项按来源清单渲染，不跟着 catalog 的组缩水',
      chipLabels.length === SOURCES.length, `count=${chipLabels.length} / ${chipLabels.join('|')}`)
    const groupTitles = page.locator('.mp-group:not(.installed) .mp-group-title')
    check('F2 未筛选时两组都在（对照，证明下面的"只剩一组"不是恒真）',
      await groupTitles.count() === 2, `titles=${(await groupTitles.allInnerTexts()).join('|')}`)

    const reqBefore = catalogRequests.length
    await chips.nth(1).click()
    await page.waitForFunction(() => document.querySelectorAll('.mp-group:not(.installed) .mp-group-title').length === 1, null, { timeout: 10000 })
      .catch(() => {})
    const filteredTitles = (await groupTitles.allInnerTexts()).map(t => t.trim())
    check('F3 点来源标签后目录真的按来源重拉（只剩该来源的组）',
      filteredTitles.length === 1 && filteredTitles[0] === 'Anthropic 官方仓库', `titles=${filteredTitles.join('|')}`)
    const filteredReq = catalogRequests.slice(reqBefore).map(u => u.searchParams.get('sources')).filter(Boolean)
    check('F4 请求确实带上了 sources 参数', filteredReq.includes('official'), `requests=${filteredReq.join('|') || '(无)'}`)
    check('F5 选中的标签有 active 态', await page.locator('.mp-chip.active').count() === 1
      && (await page.locator('.mp-chip.active').innerText()).trim() === 'Anthropic 官方仓库')
    check('F6 筛选后筛选项没跟着消失（还能再选别的来源）',
      await chips.count() === SOURCES.length, `count=${await chips.count()}`)

    const clearBefore = catalogRequests.length
    await page.locator('.mp-chip.clear').click()
    await page.waitForFunction(() => document.querySelectorAll('.mp-group:not(.installed) .mp-group-title').length === 2, null, { timeout: 10000 })
      .catch(() => {})
    const clearedReq = catalogRequests.slice(clearBefore).map(u => u.searchParams.get('sources'))
    check('F7 「全部来源」清空筛选（请求不再带 sources，两组都回来）',
      clearedReq.length > 0 && clearedReq.every(v => !v) && await groupTitles.count() === 2,
      `requests=${clearedReq.map(v => v || '(空)').join('|')}`)
    check('F8 清空后没有标签处于 active 态', await page.locator('.mp-chip.active').count() === 0)

    check('D 无 JS 运行时异常', pageErrors.length === 0, pageErrors.join(' | '))
    // B5 是探针自己 stub 的 404、E3 是探针自己 abort 的图标请求，
    // 浏览器必然会各记一条 "Failed to load resource" —— 扣掉
    const badConsole = consoleErrors
      .filter(t => !/favicon|ResizeObserver/i.test(t))
      .filter(t => !(deliberate404 && /Failed to load resource.*404/i.test(t)))
      .filter(t => !(iconAborted && /Failed to load resource/i.test(t)))
    check('D2 无控制台错误', badConsole.length === 0, badConsole.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n[verify] ${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) {
    console.log('[verify] 失败项:')
    for (const f of failed) console.log(`   - ${f.name}${f.extra ? '  :: ' + f.extra : ''}`)
  }
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })

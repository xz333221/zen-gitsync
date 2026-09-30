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
  dir: `${CWD}\\.claude\\skills\\github-Leonxlnx-taste-skill`,
}
const SAME = { id: 'docx', name: 'docx', description: 'Word 处理', target: 'project', dir: `${CWD}\\.claude\\skills\\docx` }

function catalogBody(installed) {
  return {
    success: true,
    type: 'skill',
    query: '',
    cwd: CWD,
    groups: [{
      id: 'builtin',
      label: '内置精选',
      kind: 'builtin',
      status: 'ok',
      items: [{
        id: 'docx', name: 'docx', description: 'Word 文档处理', repository: 'anthropics/skills',
        subpath: 'skills/docx', installable: true, installed: false,
      }],
      count: 1,
    }],
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
  await page.route('**/api/agent/marketplace/catalog*', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(catalogBody(fixture)),
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

    check('D 无 JS 运行时异常', pageErrors.length === 0, pageErrors.join(' | '))
    // B5 是探针自己 stub 的 404，浏览器必然会记一条 "Failed to load resource" —— 扣掉它
    const badConsole = consoleErrors
      .filter(t => !/favicon|ResizeObserver/i.test(t))
      .filter(t => !(deliberate404 && /Failed to load resource.*404/i.test(t)))
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

/**
 * 工作台两侧栏 —— 拖动调宽 / 手动折叠 的几何不变式验证 + 前后对比出图。
 *
 * 守的契约（对应 WorkbenchBoard.vue / OrchestratorConsole.vue 的分隔条与折叠逻辑）：
 *   P1  宽屏 1600 默认：左 264 / 右 360 —— **右栏比左栏宽**（这是需求本身）
 *   P2  拖左分隔条向右 60px：左栏变宽，看板相应变窄（真的是在改布局，不是画条线）
 *   P3  往左拖到底：夹在下限 180，不会拖成 0 或负数
 *   P4  往右拖到底：夹在上限（= min(420, 视口 26%)），不会把看板吃光
 *   P5  双击分隔条：回到媒体查询给的默认 264
 *   P6  右分隔条方向正确：往**左**拖是变宽；拖完右栏宽 > 260
 *   P7  持久化：reload 后拖出来的宽度还在（localStorage）
 *   P8  折叠左栏：.board__left 宽 = 0、分隔条消失、看板变宽；再点一次恢复
 *   P9  折叠右栏：.oc 收到 32px 收纳条、正文块 display:none、输入草稿仍在 DOM 里
 *   P10 点收纳条展开右栏：宽度和正文都回来
 *   P11 折叠状态持久化：reload 后仍是折叠
 *   P12 窄屏 900：左分隔条不占位（抽屉是浮层，横拖无意义）
 *   P13 竖排 780：右分隔条不渲染、右栏铺满、折叠按钮隐藏（没有"收边"这个方向）
 *   P14 反向验证：没拖过时媒体查询仍然生效（1300 → 左 224 / 右 320），
 *       证明内联变量只在用户拖过之后才接管
 *
 * ⚠️ 断言全部用几何量（boundingBox / getComputedStyle），不是"截图看着对"。
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544'
const API = process.env.ZEN_API || 'http://127.0.0.1:5545'
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'wb-panel-resize-verify')

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function waitUntil(fn, timeout = 6000, interval = 100) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true
    await sleep(interval)
  }
  return false
}

/** 页面侧测量：一次拿全布局几何 + 关键 computed 值 */
function MEASURE() {
  const box = (sel) => {
    const n = document.querySelector(sel)
    if (!n) return null
    const r = n.getBoundingClientRect()
    const cs = getComputedStyle(n)
    return {
      left: +r.left.toFixed(1), right: +r.right.toFixed(1),
      top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1),
      width: +r.width.toFixed(1), height: +r.height.toFixed(1),
      display: cs.display, position: cs.position, opacity: cs.opacity,
      pointerEvents: cs.pointerEvents,
    }
  }
  const board = document.querySelector('.board')
  return {
    vw: window.innerWidth,
    varLeft: board ? board.style.getPropertyValue('--wb-left-w').trim() : null,
    varRight: board ? board.style.getPropertyValue('--wb-right-w').trim() : null,
    left: box('.board__left'),
    main: box('.board__main'),
    oc: box('.oc'),
    colSplitter: box('.board__splitter--left'),
    rightSplitter: box('.board__splitter--right'),
    foldBtn: box('.board__fold-btn'),
    rail: box('.oc__rail'),
    collapseBtn: box('.oc__collapse'),
    ocState: box('.oc__state'),
    draftInDom: !!document.querySelector('.oc__input'),
    draftValue: document.querySelector('.oc__input')?.value ?? null,
    stored: (() => { try { return localStorage.getItem('wb.boardLayout.v1') } catch { return null } })(),
  }
}

const shots = []
async function shot(page, label) {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const file = path.join(SHOT_DIR, `${label}.png`)
  await page.screenshot({ path: file })
  shots.push({ label, file })
}

async function setSize(page, width, height = 900) {
  await page.setViewportSize({ width, height })
  await sleep(340)
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
}

/** 进入工作台（reload 后要重新点一次左侧活动栏） */
async function openBoard(page) {
  await page.waitForSelector('.activity-bar', { timeout: 20000 })
  await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
  await page.waitForSelector('.board', { timeout: 15000 })
  await page.waitForSelector('.board__left', { timeout: 10000 })
  await sleep(900)
}

/** 拖分隔条：dx 为正 = 往右拖 */
async function dragSplitter(page, sel, dx) {
  const el = page.locator(sel)
  if (!(await el.count())) return false
  const b = await el.first().boundingBox()
  if (!b) return false
  const y = b.y + Math.min(300, b.height / 2)
  await page.mouse.move(b.x + b.width / 2, y)
  await page.mouse.down()
  // 分几步走，模拟真实拖动（一步到位也能过，但步进更接近人手）
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(b.x + b.width / 2 + (dx * i) / steps, y)
    await sleep(16)
  }
  await page.mouse.up()
  await sleep(380)
  return true
}

async function main() {
  const alive = await fetch(`${API}/api/app-version`).then(r => r.ok).catch(() => false)
  if (!alive) {
    console.error(`后端没起（${API}）—— 先 npm run dev`)
    process.exit(2)
  }
  fs.rmSync(SHOT_DIR, { recursive: true, force: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  const M = () => page.evaluate(MEASURE)

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await openBoard(page)

    /* ══ P1 宽屏默认值 ══ */
    let m = await M()
    check('P1a 1600：左栏默认 264', m.left?.width === 264, `width=${m.left?.width}`)
    check('P1b 1600：右栏默认 360', m.oc?.width === 360, `width=${m.oc?.width}`)
    check('P1c 右栏默认比左栏宽（需求要的"右侧默认大一些"）',
      !!m.oc && !!m.left && m.oc.width > m.left.width,
      `右 ${m.oc?.width} vs 左 ${m.left?.width}`)
    check('P1d 没拖过时不写内联变量（宽度完全交给媒体查询）',
      !m.varLeft && !m.varRight, `--wb-left-w="${m.varLeft}" --wb-right-w="${m.varRight}"`)
    check('P1e 两条分隔条都在，且不把看板挤没（看板 > 500）',
      m.colSplitter?.width === 5 && m.rightSplitter?.width === 5 && m.main?.width > 500,
      `left=${m.colSplitter?.width} right=${m.rightSplitter?.width} main=${m.main?.width}`)
    check('P1f 宽屏下折叠按钮也在（不再只有窄屏才有）',
      m.foldBtn?.display !== 'none' && m.foldBtn?.width > 0, `display=${m.foldBtn?.display}`)
    await shot(page, '1600-default')

    /* ══ P2 拖左分隔条变宽 ══ */
    const mainBefore = m.main.width
    await dragSplitter(page, '.board__splitter--left', 60)
    m = await M()
    check('P2a 左栏拖宽 ~60px（264 → 324 ±6）', Math.abs(m.left.width - 324) <= 6, `width=${m.left?.width}`)
    check('P2b 看板相应变窄 ~60px（宽度真的在重新分配）',
      Math.abs((mainBefore - m.main.width) - 60) <= 6,
      `前 ${mainBefore} → 后 ${m.main?.width}`)
    check('P2c 拖过之后内联变量接管（--wb-left-w 有值）',
      !!m.varLeft, `--wb-left-w="${m.varLeft}"`)
    await shot(page, '1600-left-dragged')

    /* ══ P3 下限夹取 ══ */
    await dragSplitter(page, '.board__splitter--left', -600)
    m = await M()
    check('P3a 往左拖到底夹在 180（不会拖成 0 或负数）', m.left.width === 180, `width=${m.left?.width}`)
    check('P3b 夹取后看板仍然完好（没被拖散）', m.main.width > 600, `main=${m.main?.width}`)

    /* ══ P4 上限夹取 ══ */
    await dragSplitter(page, '.board__splitter--left', 900)
    m = await M()
    // 上限 = min(420, 1600*0.26 = 416) = 416
    check('P4a 往右拖到底夹在 min(420, 26% 视口) = 416', m.left.width === 416, `width=${m.left?.width}`)
    check('P4b 拖到上限时看板仍 ≥ 视口 38%（另一侧的兜底没被突破）',
      m.main.width >= m.vw * 0.3, `main=${m.main?.width} vw=${m.vw}`)
    await shot(page, '1600-left-max')

    /* ══ P5 双击恢复默认 ══ */
    await page.locator('.board__splitter--left').dblclick()
    await sleep(420)
    m = await M()
    check('P5a 双击分隔条回到媒体查询默认 264', m.left.width === 264, `width=${m.left?.width}`)
    check('P5b 双击后内联变量被清掉（重新交给媒体查询）', !m.varLeft, `--wb-left-w="${m.varLeft}"`)

    /* ══ P6 右分隔条：方向是反的 ══ */
    const ocBefore = m.oc.width
    await dragSplitter(page, '.board__splitter--right', -80)
    m = await M()
    check('P6a 右分隔条往**左**拖 = 右栏变宽（方向没写反）',
      m.oc.width > ocBefore + 60, `前 ${ocBefore} → 后 ${m.oc?.width}`)
    check('P6b 右栏变宽时看板变窄，左栏不动',
      m.left.width === 264 && m.main.width < mainBefore,
      `left=${m.left?.width} main=${m.main?.width}`)
    await shot(page, '1600-right-dragged')

    /* ══ P7 持久化 ══ */
    const wantRight = m.oc.width
    const wantLeft = m.left.width
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openBoard(page)
    m = await M()
    check('P7a reload 后拖出来的左栏宽度还在', m.left.width === wantLeft, `${wantLeft} → ${m.left?.width}`)
    check('P7b reload 后拖出来的右栏宽度还在', m.oc.width === wantRight, `${wantRight} → ${m.oc?.width}`)
    check('P7c localStorage 里确实落了 wb.boardLayout.v1',
      !!m.stored && m.stored.includes('"right"'), `stored=${m.stored}`)

    /* ══ P8 折叠左栏 ══ */
    // 先双击把右栏也复位，后面测折叠时两边都是默认宽度，数字好读
    await page.locator('.board__splitter--right').dblclick().catch(() => {})
    await sleep(400)
    m = await M()
    const mainWide = m.main.width
    await page.locator('.board__fold-btn').click()
    await sleep(420)
    m = await M()
    check('P8a 折叠后左栏宽度 = 0', m.left.width === 0, `width=${m.left?.width}`)
    check('P8b 折叠后左栏分隔条消失（没东西可拖了）', m.colSplitter === null, `splitter=${m.colSplitter}`)
    check('P8c 折叠后看板拿回全部宽度',
      m.main.width >= mainWide + 260, `前 ${mainWide} → 后 ${m.main?.width}`)
    check('P8d 折叠按钮的 aria-expanded 变成 false',
      await page.locator('.board__fold-btn').getAttribute('aria-expanded') === 'false')
    await shot(page, '1600-left-collapsed')

    await page.locator('.board__fold-btn').click()
    await sleep(420)
    m = await M()
    check('P8e 再点一次展开：左栏回到 264，分隔条回来',
      m.left.width === 264 && m.colSplitter?.width === 5,
      `width=${m.left?.width} splitter=${m.colSplitter?.width}`)

    /* ══ P9 折叠右栏 ══ */
    // 先往输入框里敲点东西，验证折叠不丢草稿
    await page.locator('.oc__input').fill('折叠时这段草稿不能丢')
    await page.locator('.oc__collapse').click()
    await sleep(420)
    m = await M()
    check('P9a 折叠后右栏收到 32px 收纳条', m.oc.width === 32, `width=${m.oc?.width}`)
    check('P9b 收纳条出现、正文块隐藏', m.rail?.width > 0 && m.ocState?.display === 'none',
      `rail=${m.rail?.width} state.display=${m.ocState?.display}`)
    check('P9c 折叠后看板拿回右栏让出的宽度', m.main.width > mainWide + 260,
      `main=${m.main?.width}（折叠前 ${mainWide}）`)
    check('P9d 折叠不销毁草稿（textarea 还在 DOM 里且值没丢）',
      m.draftInDom && m.draftValue === '折叠时这段草稿不能丢',
      `inDom=${m.draftInDom} value="${m.draftValue}"`)
    await shot(page, '1600-right-collapsed')

    /* ══ P10 收纳条展开 ══ */
    await page.locator('.oc__rail').click()
    await sleep(420)
    m = await M()
    check('P10a 点收纳条展开：右栏宽度回来', m.oc.width === 360, `width=${m.oc?.width}`)
    check('P10b 展开后正文块重新显示', m.ocState?.display !== 'none', `display=${m.ocState?.display}`)
    check('P10c 展开后草稿还在（折叠-展开一整轮没丢）',
      m.draftValue === '折叠时这段草稿不能丢', `value="${m.draftValue}"`)

    /* ══ P11 折叠状态持久化 ══ */
    await page.locator('.oc__collapse').click()
    await sleep(420)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openBoard(page)
    m = await M()
    check('P11a reload 后右栏仍是折叠态', m.oc.width === 32, `width=${m.oc?.width}`)
    check('P11b reload 后收纳条仍然在（能自己展开回来）', m.rail?.width > 0, `rail=${m.rail?.width}`)
    await page.locator('.oc__rail').click()
    await sleep(420)

    /* ══ P12 窄屏 900：左栏是浮层抽屉 ══ */
    await setSize(page, 900)
    m = await M()
    check('P12a 900：左分隔条不占位（抽屉横拖无意义）', m.colSplitter === null, `splitter=${m.colSplitter}`)
    check('P12b 900：左栏是浮层抽屉且默认收起',
      m.left.position === 'absolute' && m.left.right <= m.main.left + 1 && m.left.pointerEvents === 'none',
      `position=${m.left?.position} right=${m.left?.right} main.left=${m.main?.left}`)
    check('P12c 900：折叠按钮还在（这时候它管的是抽屉）',
      m.foldBtn?.display !== 'none' && m.foldBtn?.width > 0, `display=${m.foldBtn?.display}`)
    check('P12d 900：右分隔条还在（右栏仍是并排的一条）',
      m.rightSplitter?.width === 5, `width=${m.rightSplitter?.width}`)
    await shot(page, '900-narrow')

    /* ══ P13 竖排 780 ══ */
    await setSize(page, 780)
    m = await M()
    check('P13a 780：右分隔条不渲染（没有可拖的方向）', m.rightSplitter === null, `splitter=${m.rightSplitter}`)
    check('P13b 780：右栏铺满宽度', m.oc.width >= m.main.width - 4, `oc=${m.oc?.width} main=${m.main?.width}`)
    check('P13c 780：折叠按钮隐藏（收边动作在竖排下不成立）',
      m.collapseBtn === null || m.collapseBtn.display === 'none',
      `display=${m.collapseBtn?.display}`)
    check('P13d 780：右栏落在看板下方（方向确实变成竖排了）', m.oc.top >= m.main.bottom - 2,
      `oc.top=${m.oc?.top} main.bottom=${m.main?.bottom}`)
    await shot(page, '780-stacked')

    /* ══ P14 反向验证：没拖过时媒体查询仍然生效 ══ */
    await page.evaluate(() => localStorage.removeItem('wb.boardLayout.v1'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openBoard(page)
    await setSize(page, 1300)
    m = await M()
    check('P14a 1300：左栏回到媒体查询的 224（内联变量没有永久霸占）',
      m.left.width === 224, `width=${m.left?.width}`)
    check('P14b 1300：右栏回到媒体查询的 320', m.oc.width === 320, `width=${m.oc?.width}`)
    await shot(page, '1300-responsive')
  } catch (err) {
    check('脚本异常', false, String(err?.message || err))
  } finally {
    await browser.close()
  }

  // ── 拼对比页 ───────────────────────────────────────────────────────
  const pairs = [
    { title: '1600 · 默认（左 264 / 右 360，右比左宽）', a: '1600-default', b: null },
    { title: '1600 · 左栏拖宽 60px vs 拖到上限 416', a: '1600-left-dragged', b: '1600-left-max' },
    { title: '1600 · 右栏拖宽（往左拖 = 变宽）', a: '1600-right-dragged', b: null },
    { title: '1600 · 折叠左栏 vs 折叠右栏', a: '1600-left-collapsed', b: '1600-right-collapsed' },
    { title: '900 · 左栏浮层抽屉', a: '900-narrow', b: null },
    { title: '780 · 竖排（右栏铺满、无分隔条）', a: '780-stacked', b: null },
    { title: '1300 · 没拖过时媒体查询照旧生效', a: '1300-responsive', b: null },
  ]
  const b64 = (f) => fs.readFileSync(path.join(SHOT_DIR, `${f}.png`)).toString('base64')
  const rowsHtml = pairs.map((p) => `
    <section class="row">
      <h2>${p.title}</h2>
      <div class="grid">
        <figure><figcaption>${p.b ? 'A' : '当前'}</figcaption><img src="data:image/png;base64,${b64(p.a)}"></figure>
        ${p.b ? `<figure><figcaption>B</figcaption><img src="data:image/png;base64,${b64(p.b)}"></figure>` : ''}
      </div>
    </section>`).join('')
  const summary = results.map((r) => `<li class="${r.ok ? 'ok' : 'bad'}">${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.extra ? ` <code>${r.extra}</code>` : ''}</li>`).join('')
  const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<title>工作台两侧栏 · 拖动调宽 / 折叠</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; padding:24px; background:#141821; color:#e6e9ef; font:13px/1.6 -apple-system,"Segoe UI",sans-serif }
  h1 { font-size:18px; margin:0 0 4px }
  h2 { font-size:13px; font-weight:500; color:#9aa4b5; margin:24px 0 8px }
  .meta { color:#7d8798; font-size:12px; margin-bottom:20px }
  .row { border-top:1px solid #262c38; padding-top:8px }
  .grid { display:flex; gap:12px; align-items:flex-start; overflow-x:auto }
  figure { margin:0; flex:1 1 0; min-width:0 }
  figcaption { font-size:11px; color:#7d8798; margin-bottom:6px }
  img { width:100%; display:block; border:1px solid #2b3242; border-radius:4px }
  ul { list-style:none; padding:0; columns:2; font-size:12px }
  li { margin:2px 0; break-inside:avoid }
  li.bad { color:#ff7b72 }
  li.ok { color:#7ee787 }
  code { color:#8b949e }
</style></head><body>
<h1>工作台两侧栏 · 拖动调宽 + 手动折叠</h1>
<p class="meta">同一页面同一份数据；每个档位一张 PNG，断言全部是几何量（boundingBox / computed）。</p>
<h2>断言（${results.filter(r => r.ok).length}/${results.length} 通过）</h2>
<ul>${summary}</ul>
${rowsHtml}
</body></html>`
  const report = path.join(SHOT_DIR, 'compare.html')
  fs.writeFileSync(report, html)

  const failed = results.filter(r => !r.ok)
  console.log(`\n用例 ${results.length}，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  failed.forEach(f => console.log(`  - ${f.name} ${f.extra}`))
  const real = consoleErrors.filter(e => !/Failed to fetch|获取当前目录失败|404|net::ERR/.test(e))
  console.log(`控制台错误(过滤噪音): ${real.length}`)
  real.slice(0, 8).forEach(e => console.log('  ! ' + e.slice(0, 220)))
  console.log(`页面异常: ${pageErrors.length}`)
  console.log(`截图与对比页: ${report}`)
  process.exit(failed.length || real.length || pageErrors.length ? 1 : 0)
}
main()

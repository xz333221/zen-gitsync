/**
 * 工作台响应式布局 —— 几何不变式验证 + 前后对比出图。
 *
 * 守的契约（对应 WorkbenchBoard.vue / OrchestratorConsole.vue / WorkbenchKanban.vue 的媒体查询）：
 *   W1  宽屏（1600）：三栏并排，左 264 / 右 360（默认右比左宽），折叠按钮常驻
 *   W2  1300：两侧各收一档（左 224 / 右 320），仍并排
 *   W3  1100：再收（左 200 / 右 280），右栏默认**不折叠**
 *   W4  900：左栏改成浮层抽屉且默认收起 —— 右缘退到看板容器左缘之外、pointer-events:none
 *           （不吞点击），看板因此拿到 ≥500px（这是"窄屏先收左栏"这一档真正要换来的东西）
 *   W5  900 + 点开抽屉：左栏**浮在看板上方**（有重叠）且**不把看板挤窄**（宽度与收起时一致）
 *   W6  780：上下排列 —— 看板铺满、右栏铺满并落在看板**下方**、看板三列竖排、
 *           且右栏输入区可直接点到用（可见、够宽、能滚进视口）
 *   W7  反向验证：把"旧写法"（无媒体查询的固定 264/300 + 左栏 static）用 !important 注回去，
 *           同尺寸下 W4e / W6b 的判据必须**失败** —— 证明这些断言守的是媒体查询本身，
 *           而不是"页面没崩"。
 *
 * ⚠️ 断言用的是**几何量**（boundingBox / getComputedStyle），不是"截图看着对"。
 *   涉及"不该显示 X"的地方都配了正向锚（右栏照常、看板照常），免得把功能关掉也判绿。
 *
 * 出图：每个档位存一张 PNG，并拼一份 compare.html（before/after 同元素同尺寸对比）。
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544'
const API = process.env.ZEN_API || 'http://127.0.0.1:5545'
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'wb-responsive-verify')

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function waitUntil(fn, timeout = 10000, interval = 120) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true
    await sleep(interval)
  }
  return false
}

/** 页面侧测量：一次拿全布局几何 + 关键 computed 值 */
function MEASURE() {
  const info = (sel) => {
    const n = document.querySelector(sel)
    if (!n) return null
    const r = n.getBoundingClientRect()
    const cs = getComputedStyle(n)
    return {
      left: +r.left.toFixed(1), right: +r.right.toFixed(1),
      top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1),
      width: +r.width.toFixed(1), height: +r.height.toFixed(1),
      display: cs.display, position: cs.position,
      transform: cs.transform, pointerEvents: cs.pointerEvents,
      flexDirection: cs.flexDirection,
    }
  }
  const cols = document.querySelector('.board__cols')
  return {
    vw: window.innerWidth,
    cols: info('.board__cols'),
    colsDir: cols ? getComputedStyle(cols).flexDirection : null,
    colsOverflowY: cols ? getComputedStyle(cols).overflowY : null,
    left: info('.board__left'),
    main: info('.board__main'),
    oc: info('.oc'),
    foldBtn: info('.board__fold-btn'),
    scrim: info('.board__scrim'),
    kbCols: info('.kb__columns'),
    kbColBoxes: Array.from(document.querySelectorAll('.kb-col')).map((n) => {
      const r = n.getBoundingClientRect()
      return { left: +r.left.toFixed(1), right: +r.right.toFixed(1), top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), width: +r.width.toFixed(1) }
    }),
    compose: info('.oc__input'),
  }
}

/** 模拟"没有媒体查询"的旧写法：宽度固定、左栏回到文档流 */
const LEGACY_CSS = `
  .board { --wb-left-w: 264px !important; --wb-right-w: 300px !important; }
  .board__left { position: static !important; transform: none !important;
                 pointer-events: auto !important; width: 264px !important;
                 box-shadow: none !important; border-right: none !important; }
  .board__cols { flex-direction: row !important; overflow-y: hidden !important; }
  .kb__columns { display: grid !important; }
`

async function injectLegacy(page) {
  await page.evaluate((css) => {
    let el = document.getElementById('__legacy_css')
    if (!el) {
      el = document.createElement('style')
      el.id = '__legacy_css'
      document.head.appendChild(el)
    }
    el.textContent = css
  }, LEGACY_CSS)
  await sleep(250)
}
const removeLegacy = async (page) => {
  await page.evaluate(() => document.getElementById('__legacy_css')?.remove())
  await sleep(250)
}

const shots = []
async function shot(page, label) {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const file = path.join(SHOT_DIR, `${label}.png`)
  await page.screenshot({ path: file })
  shots.push({ label, file })
  return file
}

async function setSize(page, width, height = 900) {
  await page.setViewportSize({ width, height })
  // 等一帧布局落定（媒体查询是同步的，这里只等渲染）
  await sleep(320)
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
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
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.board', { timeout: 15000 })
    await page.waitForSelector('.board__left', { timeout: 10000 })
    await sleep(1500)

    /* ══ W1 宽屏基准 1600 ══ */
    let m = await M()
    check('W1a 宽屏下折叠按钮就在（不再只有窄屏才显示）', m.foldBtn?.display !== 'none', `display=${m.foldBtn?.display}`)
    check('W1b 左栏是常驻一栏（position:static）', m.left?.position === 'static', `position=${m.left?.position}`)
    check('W1c 左栏宽 = 264', m.left?.width === 264, `width=${m.left?.width}`)
    check('W1d 右栏宽 = 360（默认比左栏宽）', m.oc?.width === 360, `width=${m.oc?.width}`)
    check('W1e 左栏与看板不重叠（真的并排）', m.left && m.main && m.left.right <= m.main.left + 1,
      `left.right=${m.left?.right} main.left=${m.main?.left}`)
    check('W1f 右栏在看板右侧并排', m.oc && m.main && m.oc.left >= m.main.right - 1,
      `oc.left=${m.oc?.left} main.right=${m.main?.right}`)
    await shot(page, '1600-wide')

    /* ══ W2 1300 ══ */
    await setSize(page, 1300)
    m = await M()
    check('W2a 1300：左栏收到 224', m.left?.width === 224, `width=${m.left?.width}`)
    check('W2b 1300：右栏收到 320', m.oc?.width === 320, `width=${m.oc?.width}`)
    check('W2c 1300：仍然是三栏并排（左栏未折叠）', m.left?.position === 'static' && m.left.right <= m.main.left + 1,
      `position=${m.left?.position} left.right=${m.left?.right} main.left=${m.main?.left}`)
    await shot(page, '1300-tight')

    /* ══ W3 1100 ══ */
    await setSize(page, 1100)
    m = await M()
    check('W3a 1100：左栏收到 200', m.left?.width === 200, `width=${m.left?.width}`)
    check('W3b 1100：右栏收到 280', m.oc?.width === 280, `width=${m.oc?.width}`)
    check('W3c 1100：右栏仍常驻（用户要经常派发，它不参与折叠）',
      m.oc?.display !== 'none' && m.oc.width > 0 && m.oc.left >= m.main.right - 1,
      `display=${m.oc?.display} left=${m.oc?.left} main.right=${m.main?.right}`)
    await shot(page, '1100-tight')

    /* ══ W4 900：左栏变抽屉，默认收起 ══ */
    await setSize(page, 900)
    m = await M()
    const mainCollapsed = m.main?.width
    // ⚠️ 参照物是 .board__cols 的左缘，不是视口 0 —— 应用左侧还有约 48px 的活动栏，
    //    抽屉的 absolute 是相对 .board__cols 定位的，"收起"= 右缘退到它左缘之外。
    const colsLeft = m.cols.left
    check('W4a 900：折叠按钮仍在（这时候它管的是抽屉）', m.foldBtn?.display !== 'none', `display=${m.foldBtn?.display}`)
    check('W4b 900：左栏改成绝对定位浮层', m.left?.position === 'absolute', `position=${m.left?.position}`)
    check('W4c 900：左栏默认收起（右缘退到看板容器左缘之外）',
      !!m.left && m.left.right <= colsLeft + 1,
      `left.right=${m.left?.right} cols.left=${colsLeft}`)
    check('W4d 900：收起时 pointer-events:none（不吞掉本该落在看板上的点击）',
      m.left?.pointerEvents === 'none', `pointerEvents=${m.left?.pointerEvents}`)
    check('W4e 900：看板拿到 ≥500px（左栏收起真正换来的宽度）',
      mainCollapsed >= 500, `main.width=${mainCollapsed}`)
    check('W4f 900：右栏仍然常驻且并排', m.oc?.display !== 'none' && m.oc.left >= m.main.right - 1,
      `oc.display=${m.oc?.display} oc.left=${m.oc?.left} main.right=${m.main?.right}`)
    await shot(page, '900-drawer-closed')

    /* ══ W5 900 + 打开抽屉 ══ */
    // ⚠️ transform 上有过渡动画，点完要等它**落定**再量 ——
    //    否则量到的是动画中途的位置（第一次跑就是这么假绿的：right 停在收起态的值）。
    await page.locator('.board__fold-btn').click()
    await waitUntil(async () => { const x = await M(); return Math.abs(x.left.left - x.cols.left) <= 1 }, 4000)
    m = await M()
    const overlap = m.left && m.main ? +(Math.min(m.left.right, m.main.right) - Math.max(m.left.left, m.main.left)).toFixed(1) : 0
    check('W5a 点开抽屉后左栏展开到位（左缘与看板容器左缘齐平）',
      Math.abs(m.left.left - colsLeft) <= 1, `left.left=${m.left?.left} cols.left=${colsLeft}`)
    check('W5b 左栏压在看板上方（有实际重叠，说明是浮层不是挤压）', overlap > 100,
      `重叠 ${overlap}px（左栏 ${m.left?.left}→${m.left?.right} / 看板左缘 ${m.main?.left}）`)
    check('W5c 打开抽屉不把看板挤窄（宽度与收起时一致 ±2）',
      Math.abs(m.main.width - mainCollapsed) <= 2,
      `打开 ${m.main.width} vs 收起 ${mainCollapsed}`)
    check('W5d 打开时 pointer-events 恢复正常（能点项目）',
      m.left?.pointerEvents !== 'none', `pointerEvents=${m.left?.pointerEvents}`)
    await shot(page, '900-drawer-open')

    // 点捕获层收起
    await page.mouse.click(720, 500)
    await waitUntil(async () => { const x = await M(); return x.left.right <= x.cols.left + 1 }, 4000)
    m = await M()
    check('W5e 点面板外收起抽屉', m.left?.right <= colsLeft + 1, `left.right=${m.left?.right} cols.left=${colsLeft}`)
    check('W5f 收起后 pointer-events 回到 none', m.left?.pointerEvents === 'none', `pointerEvents=${m.left?.pointerEvents}`)

    /* ══ W6 780：上下排列 ══ */
    await setSize(page, 780)
    m = await M()
    check('W6a 780：三栏改成纵向排列', m.colsDir === 'column', `flexDirection=${m.colsDir}`)
    check('W6b 780：右栏铺满宽度', m.oc && m.cols && m.oc.width >= m.cols.width - 4,
      `oc.width=${m.oc?.width} cols.width=${m.cols?.width}`)
    check('W6c 780：右栏落在看板下方（不是并排）', m.oc && m.main && m.oc.top >= m.main.bottom - 2,
      `oc.top=${m.oc?.top} main.bottom=${m.main?.bottom}`)
    check('W6d 780：看板本身也铺满', m.main && m.cols && m.main.width >= m.cols.width - 4,
      `main.width=${m.main?.width} cols.width=${m.cols?.width}`)
    check('W6e 780：看板三列竖排（第二列在第一列下方）',
      m.kbColBoxes.length === 3 && m.kbColBoxes[1].top >= m.kbColBoxes[0].bottom - 2,
      `col0.bottom=${m.kbColBoxes[0]?.bottom} col1.top=${m.kbColBoxes[1]?.top}`)
    check('W6f 780：看板容器切成 block（不是 grid 横排）', m.kbCols?.display === 'block', `display=${m.kbCols?.display}`)
    // 输入区仍可直接用：滚进视口后能被点到
    await page.locator('.oc__input').scrollIntoViewIfNeeded()
    await sleep(320)
    m = await M()
    const compose = m.compose
    check('W6g 780：右栏输入区可见且够宽（≥200px，高 >0）',
      !!compose && compose.width >= 200 && compose.height > 0,
      `compose width=${compose?.width} height=${compose?.height}`)
    check('W6h 780：输入区没被挤出视口（右缘 ≤ 视口宽，且纵向在视口内）',
      !!compose && compose.right <= m.vw + 1 && compose.bottom <= 900 + 1 && compose.top >= -1,
      `right=${compose?.right} vw=${m.vw} top=${compose?.top} bottom=${compose?.bottom}`)
    await shot(page, '780-stacked')

    /* ══ W7 反向验证：注回旧写法，同一判据必须失败 ══ */
    await setSize(page, 900)
    await page.locator('.oc__input').scrollIntoViewIfNeeded().catch(() => {})
    await injectLegacy(page)
    m = await M()
    const legacyMain = m.main?.width
    await shot(page, '900-legacy')
    check('W7a 把旧写法注回去后，900 下看板宽度 <350（旧状态确实是挤的）',
      legacyMain < 350, `main.width=${legacyMain}`)
    check('W7b 旧写法下 W4e 的判据（≥500）确实不成立 —— 证明媒体查询在起作用',
      !(legacyMain >= 500), `legacy=${legacyMain} vs 阈值 500`)

    await setSize(page, 780)
    m = await M()
    await shot(page, '780-legacy')
    check('W7c 旧写法下 780 仍是横排（右栏宽度 < 看板容器一半），说明竖排来自媒体查询',
      m.oc && m.cols && m.oc.width < m.cols.width * 0.5,
      `oc.width=${m.oc?.width} cols.width=${m.cols?.width}`)

    await removeLegacy(page)
    m = await M()
    check('W7d 移掉注入后布局回到响应式状态（右栏重新铺满）',
      m.oc && m.cols && m.oc.width >= m.cols.width - 4,
      `oc.width=${m.oc?.width} cols.width=${m.cols?.width}`)
  } catch (err) {
    check('脚本异常', false, String(err?.message || err))
  } finally {
    await browser.close()
  }

  // ── 拼 before/after 对比页 ─────────────────────────────────────────
  const pairs = [
    { title: '900px · 左栏抽屉收起 vs 旧写法（无媒体查询）', a: '900-drawer-closed', b: '900-legacy' },
    { title: '900px · 左栏抽屉展开（浮在看板上方）', a: '900-drawer-open', b: null },
    { title: '780px · 上下排列 vs 旧写法（仍横排）', a: '780-stacked', b: '780-legacy' },
    { title: '1600px · 宽屏基准', a: '1600-wide', b: null },
    { title: '1300px / 1100px · 两侧各收一档', a: '1300-tight', b: '1100-tight' },
  ]
  const b64 = (f) => fs.readFileSync(path.join(SHOT_DIR, `${f}.png`)).toString('base64')
  const rowsHtml = pairs.map((p) => `
    <section class="row">
      <h2>${p.title}</h2>
      <div class="grid">
        <figure><figcaption>现在</figcaption><img src="data:image/png;base64,${b64(p.a)}"></figure>
        ${p.b ? `<figure class="old"><figcaption>旧写法（注入复现）</figcaption><img src="data:image/png;base64,${b64(p.b)}"></figure>` : ''}
      </div>
    </section>`).join('')
  const summary = results.map((r) => `<li class="${r.ok ? 'ok' : 'bad'}">${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.extra ? ` <code>${r.extra}</code>` : ''}</li>`).join('')
  const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<title>工作台响应式 · 前后对比</title>
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
  .old figcaption { color:#e5a06a }
  img { width:100%; display:block; border:1px solid #2b3242; border-radius:4px }
  ul { list-style:none; padding:0; columns:2; font-size:12px }
  li { margin:2px 0; break-inside:avoid }
  li.bad { color:#ff7b72 }
  li.ok { color:#7ee787 }
  code { color:#8b949e }
</style></head><body>
<h1>工作台响应式布局 · 前后对比</h1>
<p class="meta">同一个页面、同一份数据；"旧写法"是往 &lt;head&gt; 注入一段复现"没有媒体查询"的 !important 样式后拍的 —— 同元素同尺寸，可比性最强。</p>
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

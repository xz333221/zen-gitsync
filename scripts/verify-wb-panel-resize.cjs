/**
 * 工作台三块面板 —— 拖动调节（横向调宽 + 纵向调高）/ 手动折叠 的几何不变式验证 + 前后对比出图。
 *
 * 守的契约（对应 WorkbenchBoard.vue / OrchestratorConsole.vue / WorkbenchAgentPanel.vue
 * 的分隔条与折叠逻辑）：
 *   P1  宽屏 1600 默认：左 264 / 右 360 —— **右栏比左栏宽**（这是需求本身）
 *   P2  拖左分隔条向右 60px：左栏变宽，看板相应变窄（真的是在改布局，不是画条线）
 *   P3  往左拖到底：夹在下限 180，不会拖成 0 或负数
 *   P4  往右拖到底：夹在上限（= min(420, 视口 26%)），不会把看板吃光
 *   P5  双击分隔条：回到媒体查询给的默认 264
 *   P6  右分隔条方向正确：往**左**拖是变宽；拖完右栏宽 > 260
 *   P6c 上限放开到 min(900, 46% 视口)：1600 下能拖到 736（旧上限 560 一碰就到顶）
 *   P6d 拉满时看板仍 ≥ 视口 30%
 *   P6e 右栏变宽真的传给了输入框（这栏的主要用途是写指令）
 *   P7  持久化：reload 后拖出来的宽度还在（localStorage）
 *   P8  折叠左栏：.board__left 宽 = 0、分隔条消失、看板变宽；再点一次恢复
 *   P9  折叠右栏：.oc 收到 32px 收纳条、正文块 display:none、输入草稿仍在 DOM 里
 *   P10 点收纳条展开右栏：宽度和正文都回来
 *   P11 折叠状态持久化：reload 后仍是折叠
 *   P12 窄屏 900：左分隔条不占位（抽屉是浮层，横拖无意义）
 *   P13 竖排 780：右分隔条不渲染、右栏铺满、折叠按钮隐藏（没有"收边"这个方向）
 *   P14 反向验证：没拖过时媒体查询仍然生效（1300 → 左 224 / 右 320），
 *       证明内联变量只在用户拖过之后才接管
 *   ── 以下守左栏内部的纵向轴（项目列表 / 执行监控）──
 *   P15 默认：不写 --wb-agents-h、横向分隔条 5px + row-resize、常态画 1px 线
 *   P16 往上拖 140：执行监控变高、项目列表等量变矮（守恒），内联变量接管
 *   P17 往下拖到底：夹在下限 120，不会拖成 0
 *   P18 往上拖到底：夹在 min(560, 视口 50%)；此时监控列表 scrollHeight ≤ clientHeight
 *       —— 这条直接对应需求里的"显示不全"
 *   P19 双击复位：清掉内联变量，回到内容自适应
 *   P20 持久化：reload 后监控高度还在（localStorage 里的 agentH）
 *   P21 视口变矮：拖出来的高度按新视口重新夹，项目列表不会被挤没
 *   P22 窄屏抽屉（900）里横向分隔条照样能拖 —— 抽屉也是一列，没有理由禁用纵向调节
 *   P23 塞 3 张合成卡片撑满内容：**默认态就不许裁卡片**（需求"显示不全"的真身，
 *       同时是 flex-shrink 那个坑的回归护栏 —— 早先 0 1 auto 会把 260px 压成 ~118px）
 *   P24 拖到下限：内容改成列表内滚动，面板没溢出左栏
 *   P25 再拖回去：被裁的内容重新完整可见（"可上下调节"的闭环）
 *   ── 以下守右栏派发输入框（需求："输入框也调大一些"）──
 *   P26 默认：rows=4、高度 ≥ 76（旧的 min-height 52）、上限从写死的 160 放到 min(380px, 45vh)
 *   P27 拖右下角 grip：高度真的变大，并落进 localStorage（wb.ocInputHeight.v1）
 *   P28 持久化：reload 后高度还在（不用每次开局重拖一遍）
 *   P29 拖到超限：夹在 max-height，但**仍然写盘** —— 拖到顶也是用户的选择
 *   P30 窗口变矮：高度被 max-height 压低，此时**不许覆盖**已存的高度（P29 的值要还在）
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
  /**
   * 元素实际生效的 max-height（px）。
   *
   * 为什么不直接 parseFloat(getComputedStyle().maxHeight)：输入框那条规则写的是
   * `min(380px, 45vh)`，部分浏览器会把 min()/clamp() 原样当字符串返回，
   * parseFloat 拿到 NaN，"有没有被夹住"就永远判不出来了。
   * 这时用一个探针 div（高 9999、套同一条 max-height）量出真实生效值 ——
   * 量的是浏览器自己的解析结果，和被测元素同一条规则。
   *
   * 注意：这个 helper 必须写在 MEASURE 内部 —— page.evaluate(MEASURE) 只序列化
   * 这个函数本身，外面的同级函数在页面里并不存在。
   */
  const effMaxH = (el) => {
    const raw = getComputedStyle(el).maxHeight
    const direct = parseFloat(raw)
    if (Number.isFinite(direct)) return direct
    const probe = document.createElement('div')
    probe.style.cssText =
      'position:absolute;top:-9999px;left:-9999px;width:10px;height:9999px;visibility:hidden;max-height:' + raw
    document.body.appendChild(probe)
    const v = probe.getBoundingClientRect().height
    probe.remove()
    return Number.isFinite(v) && v < 9999 ? v : NaN
  }
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
  const boardLeft = document.querySelector('.board__left')
  const agentsList = document.querySelector('.agents__list')
  const hSplit = document.querySelector('.board__splitter--h')
  return {
    vw: window.innerWidth,
    vh: window.innerHeight,
    varLeft: board ? board.style.getPropertyValue('--wb-left-w').trim() : null,
    varRight: board ? board.style.getPropertyValue('--wb-right-w').trim() : null,
    // 执行监控高度挂在左栏而不是 .board 上
    varAgents: boardLeft ? boardLeft.style.getPropertyValue('--wb-agents-h').trim() : null,
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
    // ── 左栏内部：项目列表 / 横向分隔条 / 执行监控 ──
    proj: box('.proj'),
    agents: box('.agents'),
    agentsSplitter: box('.board__splitter--h'),
    /** 横向分隔条自己那条线的样式（常态就该看得见，和纵向两条相反） */
    hSplitLine: hSplit
      ? {
          cursor: getComputedStyle(hSplit).cursor,
          height: getComputedStyle(hSplit, '::after').height,
          background: getComputedStyle(hSplit, '::after').backgroundColor,
        }
      : null,
    /** 监控列表有没有被裁：scrollHeight > clientHeight 就是还有内容露不出来 */
    agentsList: agentsList
      ? { scrollH: agentsList.scrollHeight, clientH: agentsList.clientHeight }
      : null,
    agentCards: document.querySelectorAll('.agent-item').length,
    // ── 派发输入框（右栏 compose 区）──
    input: (() => {
      const n = document.querySelector('.oc__input')
      if (!n) return null
      const cs = getComputedStyle(n)
      const maxH = effMaxH(n)
      const r = n.getBoundingClientRect()
      return {
        h: +r.height.toFixed(1),
        w: +r.width.toFixed(1),
        top: +r.top.toFixed(1),
        bottom: +r.bottom.toFixed(1),
        minH: cs.minHeight,
        maxH: cs.maxHeight,
        maxHpx: maxH,
        /** 当前是不是正被 max-height 夹着（夹住 = 这个高度不是用户拖出来的） */
        clamped: Number.isFinite(maxH) && n.offsetHeight >= maxH - 1,
        rows: n.getAttribute('rows'),
        inline: n.style.height || '',
        resize: cs.resize,
        /** 组件为"记住手拖高度"落的那把 key */
        storedH: (() => { try { return localStorage.getItem('wb.ocInputHeight.v1') } catch { return null } })(),
      }
    })(),
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

/** 拖横向分隔条：dy 为正 = 往下拖（往下拖 = 执行监控变矮） */async function dragSplitterY(page, sel, dy) {
  const el = page.locator(sel)
  if (!(await el.count())) return false
  const b = await el.first().boundingBox()
  if (!b) return false
  const x = b.x + Math.min(120, b.width / 2)
  const y = b.y + b.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x, y + (dy * i) / steps)
    await sleep(16)
  }
  await page.mouse.up()
  await sleep(380)
  return true
}

/**
 * 往执行监控列表里塞 n 张合成卡片。
 *
 * 为什么需要它：真跑一轮 job 要在本机拉起 claude CLI 进程，验证脚本不该干这事；
 * 而没有 job 时列表只有一个空状态，量出来的高度恒等于内容高度，"会不会被裁"永远成立，
 * 断言等于空跑。这里注入的是**固定高度**的元素，验的是布局契约
 * （容器裁不裁内容 / 拖完还裁不裁），不是卡片渲染得对不对 —— 后者归组件自己的用例。
 */
async function injectFakeCards(page, n, cardH = 70) {
  await page.evaluate(({ n, cardH }) => {
    const list = document.querySelector('.agents__list')
    if (!list) return
    list.innerHTML = ''
    for (let i = 0; i < n; i++) {
      const li = document.createElement('li')
      li.className = 'agent-item'
      li.style.height = cardH + 'px'
      li.style.marginBottom = '4px'
      li.style.flexShrink = '0'
      li.textContent = 'synthetic-card-' + i
      list.appendChild(li)
    }
  }, { n, cardH })
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
  await sleep(150)
}

/** 拖 textarea 右下角那个**原生** resize grip（需求："输入框也调大一些"）。
 *  grip 是浏览器内部实现的，不是 DOM 节点，只能靠坐标命中右下角那十几个像素 ——
 *  所以从右下角往内缩 4px 起手，再按 dy 往下拖。
 *  注意：输入框钉在右栏底部，拖动时它是**往上长**的（上面的活动流让位），
 *  光标会一路移到元素外面 —— 这正是真实用户的操作，不该拦。 */
async function dragInputGrip(page, dy) {
  const el = page.locator('.oc__input')
  if (!(await el.count())) return false
  const b = await el.first().boundingBox()
  if (!b) return false
  const x = b.x + b.width - 4
  const y = b.y + b.height - 4
  await page.mouse.move(x, y)
  await page.mouse.down()
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x, y + (dy * i) / steps)
    await sleep(20)
  }
  await page.mouse.up()
  await sleep(320)
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

    /* ══ P6c 右栏上限放开（需求："右侧区域要能调大"，旧上限 560 拖到那儿就卡住）══ */
    await dragSplitter(page, '.board__splitter--right', -900)
    m = await M()
    // 上限 = min(900, 1600 * 0.46 = 736) = 736
    check('P6c 拖到上限 = min(900, 46% 视口) = 736（不再卡在旧的 560）',
      m.oc.width === 736, `width=${m.oc?.width}`)
    check('P6d 右栏拉满时看板仍 ≥ 视口 30%（没把看板吃光）',
      m.main.width >= m.vw * 0.3, `main=${m.main?.width} vw=${m.vw}`)
    check('P6e 右栏变宽真的传给了输入框（这栏的主要用途：写指令）',
      !!m.input && m.input.w > 600, `input.w=${m.input?.w}（默认 360 宽时约 336）`)
    await shot(page, '1600-right-max')

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

    /* ══ P15 左栏内部：执行监控高度可拖（需求："这里可上下调节，现在显示不全"）══
       P14 已经把 localStorage 清空，这里从干净的默认态开始。 */
    await setSize(page, 1600, 900)
    m = await M()
    check('P15a 没拖过时不写 --wb-agents-h（高度仍由 WorkbenchAgentPanel 的 CSS 决定）',
      !m.varAgents, `--wb-agents-h="${m.varAgents}"`)
    check('P15b 横向分隔条在：5px 命中区 + row-resize 光标',
      m.agentsSplitter?.height === 5 && m.hSplitLine?.cursor === 'row-resize',
      `h=${m.agentsSplitter?.height} cursor=${m.hSplitLine?.cursor}`)
    check('P15c 横向分隔条常态就画一条 1px 线（原 .agents 的 border-top 挪到这儿，视觉没变）',
      m.hSplitLine?.height === '1px' && m.hSplitLine?.background !== 'rgba(0, 0, 0, 0)',
      `line ${m.hSplitLine?.height} ${m.hSplitLine?.background}`)
    check('P15d 分隔条紧贴监控面板上沿（拖的就是这条线）',
      Math.abs((m.agentsSplitter?.bottom ?? 0) - (m.agents?.top ?? -99)) <= 1,
      `splitter.bottom=${m.agentsSplitter?.bottom} agents.top=${m.agents?.top}`)
    await shot(page, '1600-agents-default')

    /* ══ P16 往上拖 = 监控变高、项目列表让位 ══ */
    const projBefore = m.proj.height
    const agentsBefore = m.agents.height
    await dragSplitterY(page, '.board__splitter--h', -140)
    m = await M()
    check('P16a 往上拖 140：执行监控真的变高了', m.agents.height > agentsBefore + 100,
      `前 ${agentsBefore} → 后 ${m.agents?.height}`)
    check('P16b 项目列表相应变矮（空间是从列表那边让出来的，不是盖上去的）',
      m.proj.height < projBefore - 100, `前 ${projBefore} → 后 ${m.proj?.height}`)
    check('P16c 两段之和守恒（没凭空多出/吃掉高度）',
      Math.abs((projBefore + agentsBefore) - (m.proj.height + m.agents.height)) <= 6,
      `前 ${(projBefore + agentsBefore).toFixed(1)} → 后 ${(m.proj.height + m.agents.height).toFixed(1)}`)
    check('P16d 拖过之后内联变量接管', !!m.varAgents, `--wb-agents-h="${m.varAgents}"`)
    const projSqueezed = m.proj.height
    await shot(page, '1600-agents-dragged')

    /* ══ P17 下限夹取 ══ */
    await dragSplitterY(page, '.board__splitter--h', 600)
    m = await M()
    check('P17a 往下拖到底夹在 120（不会拖成 0 或负数）', m.agents.height === 120,
      `height=${m.agents?.height}`)
    // 比的是"被拖高时压扁过一次的列表"，不是最初的默认高度 ——
    // 下限 120 本身就比空列表的自然高度（~84）高，回不到默认值是正常的
    check('P17b 从被压扁的状态缩回下限：项目列表把高度拿回去了',
      m.proj.height > projSqueezed + 50, `压扁时 ${projSqueezed} → 缩回后 ${m.proj?.height}`)

    /* ══ P18 上限夹取 + 内容真的看得全 ══ */
    await dragSplitterY(page, '.board__splitter--h', -900)
    m = await M()
    // 上限 = min(560, 900 * 0.5 = 450) = 450
    check('P18a 往上拖到底夹在 min(560, 视口 50%) = 450', m.agents.height === 450,
      `height=${m.agents?.height}`)
    check('P18b 到上限时项目列表仍留着高度（没被吃光）', m.proj.height > 200, `proj=${m.proj?.height}`)
    check('P18c 拖大之后监控列表内容容纳得下（"显示不全"要解决的正是这条）',
      m.agentsList && m.agentsList.scrollH <= m.agentsList.clientH + 1,
      `scrollH=${m.agentsList?.scrollH} clientH=${m.agentsList?.clientH} 卡片=${m.agentCards}`)
    await shot(page, '1600-agents-max')

    /* ══ P19 双击复位 ══ */
    await page.locator('.board__splitter--h').dblclick()
    await sleep(420)
    m = await M()
    check('P19a 双击后内联变量被清掉（重新交给 CSS）', !m.varAgents, `--wb-agents-h="${m.varAgents}"`)
    check('P19b 双击后高度回到内容自适应（小于刚拖出来的 450）', m.agents.height < 450,
      `height=${m.agents?.height}`)

    /* ══ P20 持久化 ══ */
    await dragSplitterY(page, '.board__splitter--h', -120)
    m = await M()
    const wantAgents = m.agents.height
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openBoard(page)
    m = await M()
    check('P20a reload 后拖出来的监控高度还在', m.agents.height === wantAgents,
      `${wantAgents} → ${m.agents?.height}`)
    check('P20b localStorage 里确实落了 agentH', !!m.stored && m.stored.includes('"agentH"'),
      `stored=${m.stored}`)

    /* ══ P21 视口变矮的兜底：按新视口重新夹一遍 ══ */
    await setSize(page, 1600, 620)
    m = await M()
    check('P21a 视口变矮后监控高度被重新夹到 ≤ 50% 视口，项目列表没被挤没',
      m.agents.height <= 620 * 0.5 + 6 && m.proj.height > 100,
      `agents=${m.agents?.height} proj=${m.proj?.height} vh=${m.vh}`)
    await shot(page, '1600-agents-short-viewport')

    /* ══ P22 窄屏抽屉里同样能拖（抽屉也是一列，纵向没有禁用它的理由）══ */
    await setSize(page, 900, 900)
    await page.locator('.board__fold-btn').click()
    await sleep(420)
    m = await M()
    check('P22a 900 抽屉展开后横向分隔条仍在', m.agentsSplitter?.height === 5,
      `h=${m.agentsSplitter?.height}`)
    const drawerAgentsBefore = m.agents.height
    await dragSplitterY(page, '.board__splitter--h', -100)
    m = await M()
    check('P22b 900 抽屉里往上拖同样能加高', m.agents.height > drawerAgentsBefore,
      `前 ${drawerAgentsBefore} → 后 ${m.agents?.height}`)
    await shot(page, '900-agents-drawer')

    /* ══ P23 内容撑满时的真身：默认态不许把卡片裁掉（= 需求里的"显示不全"）══
       前面 P15~P22 是在"空列表"上量几何；那时光看高度看不出裁没裁
       （空状态只有一个 li，怎么压都"放得下"），所以这里塞合成卡片把内容撑到真实尺寸。
       这条同时也是 flex-shrink 那个坑的回归护栏：早先 .agents 写的是 flex: 0 1 auto，
       被项目列表按 flex-basis 加权一收缩，260px 的内容只剩 ~118px，卡片直接被切。 */
    await setSize(page, 1600, 900)
    await page.locator('.board__splitter--h').dblclick()   // 先回到"没拖过"的默认态
    await sleep(400)
    await injectFakeCards(page, 3, 70)                     // 3 × 74 = 222px 内容
    m = await M()
    check('P23a 默认态（没拖过）3 张卡片完整可见 —— 面板没被 flex 收缩压扁',
      m.agentsList && m.agentsList.scrollH <= m.agentsList.clientH + 1 && m.agents.height >= 240,
      `agents=${m.agents?.height} scrollH=${m.agentsList?.scrollH} clientH=${m.agentsList?.clientH}`)
    await shot(page, '1600-agents-realcontent-default')

    /* ══ P24 拖到下限：内容改成列表内滚动，而不是溢出面板 ══ */
    await dragSplitterY(page, '.board__splitter--h', 600)
    m = await M()
    check('P24a 拖到下限（120）时列表内部滚动起来（内容没消失，只是要滚）',
      m.agentsList.scrollH > m.agentsList.clientH,
      `scrollH=${m.agentsList?.scrollH} clientH=${m.agentsList?.clientH}`)
    check('P24b 缩到下限也没把卡片挤出面板（面板没溢出左栏）',
      m.agents.bottom <= m.left.bottom + 1 && m.agents.height === 120,
      `agents.bottom=${m.agents?.bottom} left.bottom=${m.left?.bottom} h=${m.agents?.height}`)
    await shot(page, '1600-agents-realcontent-min')

    /* ══ P25 用户实际会做的动作：拖回去，被裁的内容就出来了（需求闭环）══ */
    await dragSplitterY(page, '.board__splitter--h', -600)
    m = await M()
    check('P25a 再往上拖：3 张卡片重新完整可见（这就是"可上下调节"要解决的事）',
      m.agentsList.scrollH <= m.agentsList.clientH + 1,
      `scrollH=${m.agentsList?.scrollH} clientH=${m.agentsList?.clientH}`)
    check('P25b 拖高之后项目列表仍在（没有为了看监控把列表牺牲掉）',
      m.proj.height > 150, `proj=${m.proj?.height}`)
    await shot(page, '1600-agents-realcontent-expanded')

    /* ══ P26 派发输入框的默认高度（需求："输入框也调大一些"）══
       P14 清过一次 localStorage，这一节从"没拖过"的干净态开始量默认值。 */
    await setSize(page, 1600, 900)
    await page.evaluate(() => { try { localStorage.removeItem('wb.ocInputHeight.v1') } catch {} })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openBoard(page)
    m = await M()
    check('P26a 输入框默认 4 行（旧的是 3 行）', m.input?.rows === '4', `rows=${m.input?.rows}`)
    check('P26b 默认高度 ≥ 76（旧的 min-height 是 52，量出来约 88）',
      !!m.input && m.input.h >= 76 && m.input.h <= 120, `h=${m.input?.h}`)
    check('P26c 上限从写死的 160 放开到 min(380px, 45vh) —— 900 高视口下 = 380',
      m.input?.maxHpx === 380 && m.input?.resize === 'vertical',
      `max-height=${m.input?.maxH} (${m.input?.maxHpx}px) resize=${m.input?.resize}`)
    check('P26d 没拖过时不写内联高度、localStorage 里也没有那把 key（默认完全交给 CSS）',
      m.input?.inline === '' && m.input?.storedH === null,
      `inline="${m.input?.inline}" storedH=${m.input?.storedH}`)
    await shot(page, '1600-input-default')

    /* ══ P27 拖右下角变高 + 落盘 ══ */
    const inputBefore = m.input.h
    await dragInputGrip(page, 120)
    m = await M()
    check('P27a 拖右下角真的把输入框拖高了（约 +120）',
      m.input.h > inputBefore + 90, `前 ${inputBefore} → 后 ${m.input?.h}`)
    check('P27b 拖出来的高度落进 localStorage（key = wb.ocInputHeight.v1）',
      m.input.storedH !== null && Number(m.input.storedH) === Math.round(m.input.h),
      `storedH=${m.input?.storedH} h=${m.input?.h}`)
    check('P27c 输入框变高时是往上长的（底边不动、上面的活动流让位，没把容器顶穿）',
      m.input.bottom <= m.oc.bottom + 1 && m.input.bottom > m.input.top,
      `input.bottom=${m.input?.bottom} oc.bottom=${m.oc?.bottom}`)
    const wantInputH = Math.round(m.input.h)
    await shot(page, '1600-input-dragged')

    /* ══ P28 持久化：重新加载后还是这么高 ══ */
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openBoard(page)
    m = await M()
    check('P28a reload 后输入框高度还在（不用每次开局重拖）',
      Math.round(m.input.h) === wantInputH, `${wantInputH} → ${m.input?.h}`)
    check('P28b reload 后用内联高度还原（不是又回到 88）',
      m.input.inline !== '' && Number(parseFloat(m.input.inline)) === wantInputH,
      `inline="${m.input?.inline}"`)
    await shot(page, '1600-input-after-reload')

    /* ══ P29 拖到超限：夹住，但仍算用户的选择（要写盘）══ */
    await dragInputGrip(page, 500)
    m = await M()
    check('P29a 拖过头被 max-height 夹住在 380',
      m.input.h === 380 && m.input.clamped === true, `h=${m.input?.h} clamped=${m.input?.clamped}`)
    check('P29b 夹住的值仍然写盘（拖到顶也是一次真实拖拽，下次还得是这个高度）',
      Math.round(Number(m.input.storedH)) === 380, `storedH=${m.input?.storedH}`)
    await shot(page, '1600-input-max')

    /* ══ P30 反向：窗口变矮把高度压低时，不许把偏好一起改小 ══ */
    await setSize(page, 1600, 620)
    m = await M()
    // 45vh = 279 < 380 → 实际高度被压到 279
    check('P30a 视口变矮（45vh = 279）后输入框被 max-height 压低',
      m.input.h < 300 && m.input.clamped === true, `h=${m.input?.h} maxH=${m.input?.maxH}`)
    check('P30b 被压低时**没有**覆盖已存的高度（否则窗口小一次，偏好就永久没了）',
      Number(m.input.storedH) === 380, `storedH=${m.input?.storedH}（应仍为 380）`)
    await shot(page, '1600-input-short-viewport')

    await setSize(page, 1600, 900)
    m = await M()
    check('P30c 视口恢复后输入框回到 380（偏好本来就没丢）', m.input.h === 380, `h=${m.input?.h}`)
    await shot(page, '1600-input-restored')
  } catch (err) {
    check('脚本异常', false, String(err?.message || err))
  } finally {
    await browser.close()
  }

  // ── 拼对比页 ───────────────────────────────────────────────────────
  const pairs = [
    { title: '1600 · 默认（左 264 / 右 360，右比左宽）', a: '1600-default', b: null },
    { title: '1600 · 左栏拖宽 60px vs 拖到上限 416', a: '1600-left-dragged', b: '1600-left-max' },
    { title: '1600 · 右栏拖宽（往左拖 = 变宽）', a: '1600-right-dragged', b: '1600-right-max' },
    { title: '1600 · 折叠左栏 vs 折叠右栏', a: '1600-left-collapsed', b: '1600-right-collapsed' },
    { title: '900 · 左栏浮层抽屉', a: '900-narrow', b: null },
    { title: '780 · 竖排（右栏铺满、无分隔条）', a: '780-stacked', b: null },
    { title: '1300 · 没拖过时媒体查询照旧生效', a: '1300-responsive', b: null },
    { title: '执行监控 · 默认（内容自适应）vs 往上拖到上限', a: '1600-agents-default', b: '1600-agents-max' },
    { title: '执行监控 · 往上拖 140（列表让位）vs 视口变矮后的重新夹取', a: '1600-agents-dragged', b: '1600-agents-short-viewport' },
    { title: '900 · 抽屉展开后也能上下拖执行监控', a: '900-agents-drawer', b: null },
    { title: '执行监控（合成卡片撑满内容）· 默认态不裁 vs 拖到下限改成内滚', a: '1600-agents-realcontent-default', b: '1600-agents-realcontent-min' },
    { title: '执行监控 · 拖回去后内容重新完整可见', a: '1600-agents-realcontent-expanded', b: null },
    { title: '派发输入框 · 默认（4 行）vs 拖高', a: '1600-input-default', b: '1600-input-dragged' },
    { title: '派发输入框 · reload 后高度还在 vs 拖到上限 380', a: '1600-input-after-reload', b: '1600-input-max' },
    { title: '派发输入框 · 视口变矮被压低（偏好不丢）vs 恢复后回到 380', a: '1600-input-short-viewport', b: '1600-input-restored' },
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

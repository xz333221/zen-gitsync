/**
 * 角色色 —— 浓度分层 + 列头/首卡间距 + 进度条填充亮度。
 *
 * 守的契约（对应 variables.scss / dark-theme.scss 的 `--role-*` 与
 * WorkbenchKanban.vue / WorkbenchProjectPanel.vue / OrchestratorConsole.vue）：
 *   C1  角色色的 surface / wash / **bar** 一律**不许从 ink 调**。
 *       ink 是为小字过 AA 4.5:1 刻意压暗的档（active 的 ink 是 #b45309 深棕），
 *       拿它当调色源，4~14% 兑出来是灰褐 / 灰绿 —— 这正是用户 2026-10-04 报的
 *       "白色主题下颜色偏深偏暗"。调色源必须是 hue。
 *       同日第四轮的"进度条还是偏深"是同一个错的另一个出口：
 *       进度条**整条**吃了 ink，所以这里把 bar 也一并纳进 C1。
 *   C2  五个角色 × hue / ink / surface / wash / edge / bar 齐全，且
 *       dark-theme.scss 必须**整套**覆盖 surface + wash + bar ——
 *       浅色那套是不透明的（基底是白的 --surface-elevated），漏覆盖 = 暗色下满屏白板。
 *   C3  列身 / 列头 / 首卡之间得分得开：列头色带必须比列身浓，列身必须比底板亮；
 *       进行中的卡**不许**自己换底色（与同列普通卡同底，状态交给列 + 描边 + 活动行），
 *       出错的卡反过来必须有浅红底（出错是跨列的，不染就扫不出哪条失败）。
 *   C4  列头与首卡之间要有间距 —— 曾是 0（`padding: 0 12px 12px`），
 *       首卡和列头色带贴死，用户报"卡片和上边的看板类型的 title 之间没有间距"。
 *   C5  进度条填充不许直接吃 ink（三个消费点：项目列表 / 控制台进度报告 /
 *       任务事实每条进度），必须走 --role-*-bar。
 *   C6  进度条填充**实测亮度**（WCAG 相对亮度）：亮于同角色 ink ≥1.6×
 *       （pending 档 ≥1.05×，它的 hue 与 ink 同族）、对轨道 ≥2.0:1。
 *       两头都卡 —— 见 C6 处的取舍说明。
 *
 * ⚠️ 断言用**几何量 + 合成后的实际底色**（getComputedStyle 一路往父层合成到不透明为止），
 *   不是"截图看着对"。--reverse 把旧写法（ink 调色 + 透明 + 上边距 0 + 进度条吃 ink）
 *   注回去，C1 / C3 / C4 / C6 必须变红 —— 证明这些断言守的是这套值本身，而不是"页面没崩"。
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'src/ui/client/src')
const BASE = process.env.ZEN_BASE || 'http://localhost:5544'
const API = process.env.ZEN_API || 'http://127.0.0.1:5545'
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'wb-color-verify')
const REVERSE = process.argv.includes('--reverse')

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ROLES = ['pending', 'active', 'done', 'error', 'ai']

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// ─────────────────────────────────────────────────────────────
// A. 静态断言
// ─────────────────────────────────────────────────────────────
console.log('── A. 静态断言 ──')

// C1 淡底 / 进度条填充必须调自 hue，不能调自 ink
//    这里**只**管角色令牌表，不去扫组件 —— 组件里从 ink 调色有正当用法
//    （AiQuickPushButton 的 hover 是 `color-mix(--role-ai-ink 86%, #000)`，
//    那是在把实心色压暗，不是拿它当淡底）。会渲染成"脏"的是**低浓度的大面积底**，
//    那部分由下面的 C3 用真实合成色去守。
//    bar 只在**浅色**表里查 hue（暗色的 bar 故意就是 ink，理由见下面那个 slots）。
{
  const tables = ['styles/variables.scss', 'styles/dark-theme.scss']
    .map((p) => [p, stripComments(fs.readFileSync(path.join(SRC, p), 'utf8'))])
  const bad = []
  for (const [name, t] of tables) {
    // 暗色那张表**不查 bar**：暗色里 bar 就是 ink（ink 在暗色走亮档 #34d399 / #fbbf24），
    // 把浅色那套"hue 兑 ink"搬过去只会把条压暗 —— 这是设计决定，不是漏改。
    // 对应地 C2b 仍然要求暗色表里有 bar，别把覆盖整条删了。
    const slots = name.endsWith('dark-theme.scss') ? ['surface', 'wash'] : ['surface', 'wash', 'bar']
    for (const r of ROLES) {
      for (const slot of slots) {
        const m = t.match(new RegExp(`--role-${r}-${slot}\\s*:([^;]+);`))
        if (!m) continue
        if (!new RegExp(`var\\(--role-${r}-hue`).test(m[1])) {
          bad.push(`${name}  --role-${r}-${slot}: ${m[1].trim().slice(0, 56)}`)
        }
      }
    }
  }
  check('C1 角色的淡底与进度条填充一律调自 hue（从 ink 调出来的是灰褐/灰绿/发沉）', bad.length === 0,
    bad.length ? bad.slice(0, 4).join(' | ') : '')
}

// C2 令牌齐全 + 暗色整套覆盖
{
  const v = stripComments(fs.readFileSync(path.join(SRC, 'styles/variables.scss'), 'utf8'))
  const d = stripComments(fs.readFileSync(path.join(SRC, 'styles/dark-theme.scss'), 'utf8'))
  const missingLight = []
  const missingDark = []
  for (const r of ROLES) {
    for (const slot of ['hue', 'ink', 'surface', 'wash', 'edge', 'bar']) {
      if (!new RegExp(`--role-${r}-${slot}\\s*:`).test(v)) missingLight.push(`--role-${r}-${slot}`)
    }
    for (const slot of ['surface', 'wash', 'bar']) {
      if (!new RegExp(`--role-${r}-${slot}\\s*:`).test(d)) missingDark.push(`--role-${r}-${slot}`)
    }
  }
  check('C2a 五个角色 × hue/ink/surface/wash/edge/bar 齐全', missingLight.length === 0, missingLight.join(' '))
  check('C2b dark-theme.scss 整套覆盖 surface + wash + bar（否则暗色下白板 / 条被压暗）', missingDark.length === 0, missingDark.join(' '))
}

// C5 进度条填充不许吃 ink。三个消费点各是一条 `background:`，这里按选择器抓那一条，
//    不去全文 grep —— 同文件里 ink 还有正当用法（文字/图标/图标底色）。
{
  const consumers = [
    ['views/components/WorkbenchProjectPanel.vue', /\.proj-item__bar-fill\s*\{([^}]*)\}/g, 3],
    ['views/components/OrchestratorConsole.vue', /\.rp__bar-fill\s*\{([^}]*)\}/g, 1],
    ['views/components/OrchestratorConsole.vue', /\.rpt__bar-fill\s*\{([^}]*)\}/g, 1],
  ]
  const bad = []
  for (const [rel, re, atLeast] of consumers) {
    const t = stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'))
    const hits = [...t.matchAll(re)].map((m) => m[1])
    const okOnes = hits.filter((b) => /background:\s*var\(--role-[a-z]+-bar\)/.test(b))
    if (okOnes.length < atLeast) {
      bad.push(`${rel} ${re.source.split('\\')[0]} 命中 ${hits.length} 条、走 bar 的 ${okOnes.length} 条（要 ≥${atLeast}）`)
    }
  }
  check('C5 三个进度条消费点都走 --role-*-bar（不吃 ink）', bad.length === 0, bad.join(' | '))
}

// ─────────────────────────────────────────────────────────────
// B. 运行时断言
// ─────────────────────────────────────────────────────────────
const MEASURE = () => {
  const parse = (c) => {
    const m = String(c).match(/^(rgba?|color)\(([^)]+)\)/)
    if (!m) return null
    if (m[1] === 'color') {
      /* `color(srgb 0.9 0.5 0.2 / 0.06)` —— 斜杠必须换成空格再切，
         否则 p[4] 是 "/"，parseFloat 出来 NaN，alpha 判成"不是 > 0"，
         整层淡底会被**静默跳过**（第一版就踩了：反向验证里三列全量成底板色，
         看起来像"旧写法没被注入"，其实是解析器把带 alpha 的那层丢了）。 */
      const p = m[2].trim().replace('/', ' ').split(/\s+/)
      return { r: +p[1] * 255, g: +p[2] * 255, b: +p[3] * 255, a: p[4] === undefined ? 1 : parseFloat(p[4]) }
    }
    const p = m[2].replace('/', ' ').split(/[\s,]+/).filter(Boolean).map(parseFloat)
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
  }
  const over = (top, bot) => {
    const a = top.a + bot.a * (1 - top.a)
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
    return {
      r: (top.r * top.a + bot.r * bot.a * (1 - top.a)) / a,
      g: (top.g * top.a + bot.g * bot.a * (1 - top.a)) / a,
      b: (top.b * top.a + bot.b * bot.a * (1 - top.a)) / a,
      a,
    }
  }
  /** 一路往父层合成到不透明 —— color-mix 出来的底色常常带 alpha，直接读会算错 */
  const resolveBg = (el) => {
    if (!el) return null
    let acc = null
    let n = el
    while (n) {
      const c = parse(getComputedStyle(n).backgroundColor)
      if (c && c.a > 0) {
        acc = acc ? over(acc, c) : c
        if (acc.a >= 0.999) break
      }
      n = n.parentElement
    }
    if (!acc) return null
    if (acc.a < 0.999) acc = over(acc, { r: 255, g: 255, b: 255, a: 1 })
    return acc
  }
  const lum = (c) => (c ? +((0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255).toFixed(4) : null)
  /* C6 用的是**真正的 WCAG 相对亮度**（先线性化），不是上面那个加权平均。
     上面那个当"谁比谁亮"的排序够用（C3a/C3b 都是同一把尺子比大小），
     但它不是对比度公式的输入 —— 拿它算出来的"对比度"会比真值低一档
     （实测 done 1.7 vs 真值 2.46），照着调阈值就等于把标准定错了。 */
  const lin = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
  const wcag = (c) => (c ? 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b) : null)
  const rgb = (c) => (c ? `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})` : 'none')
  const contrast = (a, b) => {
    const [x, y] = [wcag(a), wcag(b)].sort((p, q) => q - p)
    return +((x + 0.05) / (y + 0.05)).toFixed(2)
  }
  /** 令牌表里的 ink 是 `var(--color-*-dark)` 链，getComputedStyle 读自定义属性时
      已经做过替换，所以这里只会拿到 `#rrggbb` 字面量。 */
  const hexc = (s) => {
    const m = String(s).trim().match(/^#([0-9a-f]{6})$/i)
    return m
      ? { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: 1 }
      : null
  }

  const cols = Array.from(document.querySelectorAll('.kb-col'))
  const out = { canvas: null, cols: [], running: null, error: null, plain: null, gap: null, padTop: null }
  out.canvas = { lum: lum(resolveBg(document.querySelector('.board__main'))), rgb: rgb(resolveBg(document.querySelector('.board__main'))) }

  for (const col of cols) {
    const key = (col.className.match(/kb-col--(\w+)/) || [, 'pending'])[1]
    const head = col.querySelector('.kb-col__head')
    const list = col.querySelector('.kb-col__list')
    const card = col.querySelector('.kb-card')
    out.cols.push({
      key,
      body: { lum: lum(resolveBg(col)), rgb: rgb(resolveBg(col)) },
      head: { lum: lum(resolveBg(head)), rgb: rgb(resolveBg(head)) },
      padTop: list ? getComputedStyle(list).paddingTop : null,
      gap: head && card ? +(card.getBoundingClientRect().top - head.getBoundingClientRect().bottom).toFixed(1) : null,
    })
  }
  const r = document.querySelector('.kb-card.is-running')
  const e = document.querySelector('.kb-card.has-error')
  const p = document.querySelector('.kb-card:not(.is-running):not(.has-error)')
  const st = (n) => (n ? { lum: lum(resolveBg(n)), rgb: rgb(resolveBg(n)) } : null)
  out.running = st(r)
  out.error = st(e)
  out.plain = st(p)
  if (out.cols[0]) { out.gap = out.cols[0].gap; out.padTop = out.cols[0].padTop }

  /* 进度条填充：**强制**把三行分别摆成 idle / 在跑 / 已完成再量。
     实时数据里三种状态不一定同时在场（没有在跑的活儿时琥珀条压根不渲染），
     顺着数据量就会出现"这条断言今天没测、明天才红"的假象。 */
  out.bars = []
  const barRows = Array.from(document.querySelectorAll('.proj-item')).filter(
    (n) => n.querySelector('.proj-item__bar-fill') && n.querySelector('.proj-item__bar'),
  )
  const rootCS = getComputedStyle(document.documentElement)
  const ROLE_UI = [
    ['pending', (n) => n.classList.remove('is-running', 'is-complete')],
    ['active', (n) => { n.classList.remove('is-complete'); n.classList.add('is-running') }],
    ['done', (n) => { n.classList.remove('is-running'); n.classList.add('is-complete') }],
  ]
  ROLE_UI.forEach(([role, apply], i) => {
    const row = barRows[i]
    if (!row) return
    apply(row)
    const f = parse(getComputedStyle(row.querySelector('.proj-item__bar-fill')).backgroundColor)
    const track = resolveBg(row.querySelector('.proj-item__bar'))
    const ink = hexc(rootCS.getPropertyValue(`--role-${role}-ink`))
    out.bars.push({
      role,
      fill: rgb(f),
      fillLum: +wcag(f).toFixed(4),
      ink: ink ? rgb(ink) : null,
      inkLum: ink ? +wcag(ink).toFixed(4) : null,
      // 记的是实时墨水色而不是硬编码 —— 令牌表改了这里跟着改，比值才一直有意义
      ratio: ink ? +(wcag(f) / wcag(ink)).toFixed(2) : null,
      track: rgb(track),
      contrast: contrast(f, track),
    })
  })
  return out
}

/** 逐字复现返工前的旧写法（不是随便搭个稻草人）：
 *  列身 = 各角色 4~6% 的**透明**淡底（落在深灰底板上再掉一档明度）；
 *  列头 = `color-mix(--col-ink 14%)` —— 从压暗过的 ink 调色（灰褐/灰绿的来源）；
 *  状态卡 = 同一个 6% 透明淡底直接当卡片自己的背景（盖掉卡片的白底）；
 *  列表上内边距 = 0；
 *  进度条 = 三条直接吃 ink（第四轮"进度条还是偏深"的来源）。 */
const LEGACY_CSS = `
  .kb-col { background: color-mix(in srgb, #64748b 6%, transparent) !important; }
  .kb-col.kb-col--doing { background: color-mix(in srgb, var(--color-warning) 6%, transparent) !important; }
  .kb-col.kb-col--done { background: color-mix(in srgb, var(--color-success) 4%, transparent) !important; }
  .kb-col__head { background: color-mix(in srgb, var(--col-ink) 14%, transparent) !important; }
  .kb-card.is-running { background: color-mix(in srgb, var(--color-warning) 6%, transparent) !important; }
  .kb-card.has-error { background: color-mix(in srgb, var(--color-danger) 6%, transparent) !important; }
  .kb-col__list { padding: 0 12px 12px !important; }
  /* 进度条吃 ink —— 2026-10-04 第四轮前的写法（"黄色和绿色的进度条还是感觉有点深"） */
  .proj-item__bar-fill { background: var(--role-pending-ink) !important; }
  .proj-item.is-running .proj-item__bar-fill { background: var(--role-active-ink) !important; }
  .proj-item.is-complete .proj-item__bar-fill { background: var(--role-done-ink) !important; }
`

async function main() {
  const alive = await fetch(`${API}/api/app-version`).then((r) => r.ok).catch(() => false)
  if (!alive) {
    console.error(`后端没起（${API}）—— 先 npm run dev / preview_start("zen-backend")`)
    process.exit(2)
  }
  fs.rmSync(SHOT_DIR, { recursive: true, force: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 30000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.board', { timeout: 20000 })
    await page.waitForSelector('.kb-col .kb-card', { timeout: 20000 })
    await sleep(1500)

    /* ① 本文件所有运行时常量都是**浅色**口径（C3c/C3d 要求 lum ≥ 0.90、
          C6 要求进度条亮于 ink）—— 用户机器上如果是暗色主题，这些断言会集体假红。
          量之前钉死浅色，比"看运气"强。
       ② 底色 / 进度条都挂了 transition，改完 class 立刻读拿到的是**过渡中的当前值**
          （等于读到改之前那一版）。先把过渡关掉，读数才是落点。 */
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' })
    await sleep(200)

    if (REVERSE) {
      await page.evaluate((css) => {
        const el = document.createElement('style')
        el.id = '__legacy_colors'
        el.textContent = css
        document.head.appendChild(el)
      }, LEGACY_CSS)
      await sleep(400)
    }

    const m = await page.evaluate(MEASURE)
    console.log('── B. 运行时断言（实际合成后的底色） ──')
    console.log(`        底板 --surface-canvas  ${m.canvas.rgb}  lum=${m.canvas.lum}`)
    for (const c of m.cols) {
      console.log(`        列 ${c.key.padEnd(8)} 列身 ${c.body.rgb} lum=${c.body.lum} | 列头 ${c.head.rgb} lum=${c.head.lum} | 间距 ${c.gap}px`)
    }
    console.log(`        进行中卡 ${m.running && m.running.rgb} lum=${m.running && m.running.lum}`)
    console.log(`        出错卡   ${m.error && m.error.rgb} lum=${m.error && m.error.lum}`)
    console.log(`        普通卡   ${m.plain && m.plain.rgb} lum=${m.plain && m.plain.lum}`)

    // C3 列身比底板亮（"偏深偏暗"的直接判据：旧写法列身比底板还暗）
    const darker = m.cols.filter((c) => !(c.body.lum >= m.canvas.lum))
    check('C3a 每一列的列身都不比底板暗', darker.length === 0,
      darker.map((c) => `${c.key} ${c.body.lum} < canvas ${m.canvas.lum}`).join(' | '))

    // C3 列头色带比列身浓（标识 > 氛围）
    const flat = m.cols.filter((c) => !(c.head.lum < c.body.lum))
    check('C3b 每一列的列头色带都比列身浓（标识压得住氛围）', flat.length === 0,
      flat.map((c) => `${c.key} head ${c.head.lum} >= body ${c.body.lum}`).join(' | '))

    // C3 状态卡得是"浅色卡"而不是"脏底"：亮度 ≥ 0.90 且色相方向对
    const red = m.error && m.error.rgb.match(/\d+/g).map(Number)
    /* C3c 进行中的卡**与普通卡同底**（2026-10-05 第五轮）。
       卡落在哪一列是它自己的状态推出来的（is-running ⇔ 进行中 列），
       所以给卡面再染一遍色是纯冗余，代价却是同屏别的卡都白、唯独它一块暖色 ——
       用户报「我非进行中的正常任务都是白色，进行中的是橙色有点奇怪」。
       断言写成"与普通卡逐位相同"而不是"等于 #fff"：要守的契约是**一致**，
       哪天卡面整体换个底色不该把这条带红。 */
    check('C3c 进行中的卡与同列的普通卡同底（状态不靠换底色表达）',
      !!m.running && !!m.plain && m.running.rgb === m.plain.rgb,
      m.running ? `running ${m.running.rgb} vs plain ${m.plain && m.plain.rgb}` : '没有 .kb-card.is-running（数据里没在跑的任务）')
    check('C3d 出错的卡是浅红底（lum ≥ 0.90 且 r > g）',
      !!m.error && m.error.lum >= 0.9 && red[0] > red[1],
      m.error ? `${m.error.rgb} lum=${m.error.lum}` : '没有 .kb-card.has-error（数据里没有出错的任务）')

    // C4 列头与首卡之间要有间距
    const gaps = m.cols.map((c) => c.gap).filter((g) => g !== null)
    check('C4a 列头与首卡之间有间距（≥ 8px）', gaps.length > 0 && gaps.every((g) => g >= 8),
      `gaps=${gaps.join(',')} padTop=${m.padTop}`)
    check('C4b .kb-col__list 上内边距不为 0', m.padTop !== '0px' && m.padTop !== null, `padding-top=${m.padTop}`)

    // C6 进度条填充的**实测亮度**。两头都卡，因为用户报过两次"深"，
    //    而"浅到看不见"是它的对称失败：
    //   下限方向（不许再深）：填充亮度 ≥ 同角色 ink 亮度 × 1.6
    //   上限方向（不许糊）：填充对轨道 ≥ 2.0:1
    //   ⚠️ 只有 1.6× 这条能在 --reverse 里变红（旧写法 = ink，比值恒为 1.0）。
    //      2.0:1 那条旧写法反而更高（4.1~4.4:1），拿它做反向证据是错的 ——
    //      它的边界是**反方向**的：注一版 `--role-*-hue` 纯色进去（比值 2.7~3.0×，
    //      C6a 反而更绿）才会把 C6b 顶红，实测 amber 1.78:1 / done 2.02:1 越界。
    const bars = m.bars || []
    bars.forEach((b) => console.log(`        进度条 ${b.role.padEnd(7)} 填充 ${b.fill} lum=${b.fillLum} | ink ${b.ink} lum=${b.inkLum} 亮 ${b.ratio}× | 轨道 ${b.track} 对比 ${b.contrast}:1`))
    /* 每档的下限不同：pending 的 hue(#64748b) 与 ink(#5b6472) 本来就同族，
       浅色档不该为了"亮"把它洗成灰白 —— 它答的是"这个项目没在跑"，静默是它的语义。
       所以那档只卡"不许退回 ink"，有色的两档才卡 1.6×。 */
    const BAR_FLOOR = { pending: 1.05, active: 1.6, done: 1.6 }
    const deep = bars.filter((b) => !(b.ratio >= (BAR_FLOOR[b.role] || 1.6)))
    check('C6a 进度条填充亮于同角色 ink（active/done ≥1.6×，pending ≥1.05×）',
      bars.length === 3 && deep.length === 0,
      bars.length !== 3
        ? `只量到 ${bars.length} 条（.proj-item 不够三条）`
        : bars.map((b) => `${b.role} ${b.ratio}×/≥${BAR_FLOOR[b.role]}`).join(' '))
    check('C6b 进度条填充对轨道 ≥2.0:1', bars.length === 3 && bars.every((b) => b.contrast >= 2.0),
      bars.map((b) => `${b.role} ${b.contrast}:1`).join(' '))

    await page.locator('.kb__columns').first().screenshot({ path: path.join(SHOT_DIR, REVERSE ? 'kanban-legacy.png' : 'kanban.png') })
    await browser.close()
  } catch (err) {
    console.error(err)
    await browser.close()
    process.exit(1)
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n用例 ${results.length}，通过 ${results.length - failed.length}，失败 ${failed.length}${REVERSE ? '（--reverse：下面这几条必须红）' : ''}`)
  failed.forEach((f) => console.log(`  - ${f.name} ${f.extra}`))
  console.log(`截图: ${SHOT_DIR}`)
  if (pageErrors.length) pageErrors.slice(0, 5).forEach((e) => console.log('  ! ' + e.slice(0, 200)))

  /* --reverse 的期望是**指定那几条**变红。不是"运行时全红"：
     旧写法的列头（14% ink）恰好仍然比列身暗，C3b 那条关系旧写法也成立 ——
     要求它变红就等于在断言一条它本来就不违反的东西。
     C1 是源码断言，注入的旧 CSS 在运行时，它照旧应当是绿的。 */
  const MUST_FAIL_IN_REVERSE = [
    'C3a 每一列的列身都不比底板暗',      // 旧写法列身比底板暗 —— 这就是"偏深偏暗"
    'C3c 进行中的卡与同列的普通卡同底（状态不靠换底色表达）',  // 旧写法给卡面染 6~16% 暖色
    'C3d 出错的卡是浅红底（lum ≥ 0.90 且 r > g）',
    'C4a 列头与首卡之间有间距（≥ 8px）',
    'C4b .kb-col__list 上内边距不为 0',
    'C6a 进度条填充亮于同角色 ink（active/done ≥1.6×，pending ≥1.05×）',  // 旧写法直接吃 ink，比值恒 1.0
  ]
  let okOverall
  if (REVERSE) {
    const notRed = MUST_FAIL_IN_REVERSE.filter((n) => results.find((r) => r.name === n)?.ok !== false)
    okOverall = notRed.length === 0
    console.log(okOverall
      ? '反向验证通过：旧写法确实被这几条断言挡下'
      : '反向验证失败：旧写法居然过关 —— 断言守错了地方：' + notRed.join(' / '))
  } else {
    okOverall = failed.length === 0
    console.log(okOverall ? '全部通过' : '有失败')
  }
  process.exit(okOverall ? 0 : 1)
}
main()

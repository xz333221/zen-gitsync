/**
 * 看板角色色 —— 浓度分层 + 列头/首卡间距。
 *
 * 守的契约（对应 variables.scss / dark-theme.scss 的 `--role-*` 与 WorkbenchKanban.vue）：
 *   C1  角色色的 surface / wash **不许从 ink 调**。
 *       ink 是为小字过 AA 4.5:1 刻意压暗的档（active 的 ink 是 #b45309 深棕），
 *       拿它当调色源，4~14% 兑出来是灰褐 / 灰绿 —— 这正是用户 2026-10-04 报的
 *       "白色主题下颜色偏深偏暗"。调色源必须是 hue。
 *   C2  五个角色 × hue / ink / surface / wash / edge 齐全，且
 *       dark-theme.scss 必须**整套**覆盖 surface + wash ——
 *       浅色那套是不透明的（基底是白的 --surface-elevated），漏覆盖 = 暗色下满屏白板。
 *   C3  列身 / 列头 / 首卡之间得分得开：列头色带必须比列身浓，列身必须比底板亮。
 *   C4  列头与首卡之间要有间距 —— 曾是 0（`padding: 0 12px 12px`），
 *       首卡和列头色带贴死，用户报"卡片和上边的看板类型的 title 之间没有间距"。
 *
 * ⚠️ 断言用**几何量 + 合成后的实际底色**（getComputedStyle 一路往父层合成到不透明为止），
 *   不是"截图看着对"。--reverse 把旧写法（ink 调色 + 透明 + 上边距 0）注回去，
 *   C1 / C3 / C4 必须变红 —— 证明这些断言守的是这套值本身，而不是"页面没崩"。
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

// C1 淡底必须调自 hue，不能调自 ink
//    这里**只**管角色令牌表，不去扫组件 —— 组件里从 ink 调色有正当用法
//    （AiQuickPushButton 的 hover 是 `color-mix(--role-ai-ink 86%, #000)`，
//    那是在把实心色压暗，不是拿它当淡底）。会渲染成"脏"的是**低浓度的大面积底**，
//    那部分由下面的 C3 用真实合成色去守。
{
  const tables = ['styles/variables.scss', 'styles/dark-theme.scss']
    .map((p) => [p, stripComments(fs.readFileSync(path.join(SRC, p), 'utf8'))])
  const bad = []
  for (const [name, t] of tables) {
    for (const r of ROLES) {
      for (const slot of ['surface', 'wash']) {
        const m = t.match(new RegExp(`--role-${r}-${slot}\\s*:([^;]+);`))
        if (!m) continue
        if (!new RegExp(`var\\(--role-${r}-hue`).test(m[1])) {
          bad.push(`${name}  --role-${r}-${slot}: ${m[1].trim().slice(0, 56)}`)
        }
      }
    }
  }
  check('C1 角色淡底一律调自 hue（从 ink 调出来的是灰褐/灰绿）', bad.length === 0,
    bad.length ? bad.slice(0, 4).join(' | ') : '')
}

// C2 令牌齐全 + 暗色整套覆盖
{
  const v = stripComments(fs.readFileSync(path.join(SRC, 'styles/variables.scss'), 'utf8'))
  const d = stripComments(fs.readFileSync(path.join(SRC, 'styles/dark-theme.scss'), 'utf8'))
  const missingLight = []
  const missingDark = []
  for (const r of ROLES) {
    for (const slot of ['hue', 'ink', 'surface', 'wash', 'edge']) {
      if (!new RegExp(`--role-${r}-${slot}\\s*:`).test(v)) missingLight.push(`--role-${r}-${slot}`)
    }
    for (const slot of ['surface', 'wash']) {
      if (!new RegExp(`--role-${r}-${slot}\\s*:`).test(d)) missingDark.push(`--role-${r}-${slot}`)
    }
  }
  check('C2a 五个角色 × hue/ink/surface/wash/edge 齐全', missingLight.length === 0, missingLight.join(' '))
  check('C2b dark-theme.scss 整套覆盖 surface + wash（否则暗色下白板）', missingDark.length === 0, missingDark.join(' '))
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
  const rgb = (c) => (c ? `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})` : 'none')

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
  return out
}

/** 逐字复现返工前的旧写法（不是随便搭个稻草人）：
 *  列身 = 各角色 4~6% 的**透明**淡底（落在深灰底板上再掉一档明度）；
 *  列头 = `color-mix(--col-ink 14%)` —— 从压暗过的 ink 调色（灰褐/灰绿的来源）；
 *  状态卡 = 同一个 6% 透明淡底直接当卡片自己的背景（盖掉卡片的白底）；
 *  列表上内边距 = 0。 */
const LEGACY_CSS = `
  .kb-col { background: color-mix(in srgb, #64748b 6%, transparent) !important; }
  .kb-col.kb-col--doing { background: color-mix(in srgb, var(--color-warning) 6%, transparent) !important; }
  .kb-col.kb-col--done { background: color-mix(in srgb, var(--color-success) 4%, transparent) !important; }
  .kb-col__head { background: color-mix(in srgb, var(--col-ink) 14%, transparent) !important; }
  .kb-card.is-running { background: color-mix(in srgb, var(--color-warning) 6%, transparent) !important; }
  .kb-card.has-error { background: color-mix(in srgb, var(--color-danger) 6%, transparent) !important; }
  .kb-col__list { padding: 0 12px 12px !important; }
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
    const warm = m.running && m.running.rgb.match(/\d+/g).map(Number)
    const red = m.error && m.error.rgb.match(/\d+/g).map(Number)
    check('C3c 进行中的卡是浅暖底（lum ≥ 0.90 且 r > b）',
      !!m.running && m.running.lum >= 0.9 && warm[0] > warm[2],
      m.running ? `${m.running.rgb} lum=${m.running.lum}` : '没有 .kb-card.is-running（数据里没在跑的任务）')
    check('C3d 出错的卡是浅红底（lum ≥ 0.90 且 r > g）',
      !!m.error && m.error.lum >= 0.9 && red[0] > red[1],
      m.error ? `${m.error.rgb} lum=${m.error.lum}` : '没有 .kb-card.has-error（数据里没有出错的任务）')

    // C4 列头与首卡之间要有间距
    const gaps = m.cols.map((c) => c.gap).filter((g) => g !== null)
    check('C4a 列头与首卡之间有间距（≥ 8px）', gaps.length > 0 && gaps.every((g) => g >= 8),
      `gaps=${gaps.join(',')} padTop=${m.padTop}`)
    check('C4b .kb-col__list 上内边距不为 0', m.padTop !== '0px' && m.padTop !== null, `padding-top=${m.padTop}`)

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
    'C3c 进行中的卡是浅暖底（lum ≥ 0.90 且 r > b）',
    'C3d 出错的卡是浅红底（lum ≥ 0.90 且 r > g）',
    'C4a 列头与首卡之间有间距（≥ 8px）',
    'C4b .kb-col__list 上内边距不为 0',
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

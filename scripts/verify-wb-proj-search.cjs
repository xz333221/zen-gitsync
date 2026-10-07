/**
 * 左栏「项目列表」搜索框：固定白底 + 白底可读性 —— 浏览器验证。
 *
 * 守的契约（对应 WorkbenchProjectPanel.vue 的 .proj__search / __icon / __input）：
 *   S1  静态：`.proj__search` 块内**不再引用随主题翻转的令牌**（--text-* / --bg-subtle /
 *       --border-color / --focus-ring-soft / --color-primary）。这是本页最核心的一条 ——
 *       只要有一个漏回去，深色主题下就是白底白字 / 看不见的描边。
 *   S2  静态：`.proj__search` 显式声明 color-scheme: light，`.proj__search-input` 有 caret-color
 *   R1/R2  两套主题下容器底色都是纯白、图标与 placeholder 都是 #6b7280
 *   R3  已输入文字 #1f2937、caret 同色、color-scheme 实测 light
 *   R4  静止态描边可见（非透明、非零宽）且无焦点环；聚焦态描边 #2563eb + 3px 实蓝焦点环
 *   R5  正文 / placeholder 对白底都 ≥ 4.5:1（WCAG AA）
 *   R6  两个开关仍完整落在筛选条内、等宽不重叠、搜索框内无横向溢出（白底没挤坏这一行）
 *
 * ⚠️ 断言用**实测计算样式 + WCAG 对比度**，不是"截图看着白"。--reverse 把旧写法
 *   （--bg-subtle 底 + --text-* 前景 + --focus-ring-soft 焦点环）注回去，R1~R5 必须变红 ——
 *   证明这些断言守的是这套值本身，而不是"页面没崩"。S1/S2 是源码断言，注入的 CSS 在运行时，
 *   它们照旧应当是绿的。
 *
 * 反向验证（把修复撤掉后哪几条会红）：
 *   · 底色换回 var(--bg-subtle) → R1 红（深色下 rgba(255,255,255,.05)）
 *   · 前景换回 var(--text-primary) / var(--text-meta) → R2 / R3 红，深色下对比度掉到 1.0:1
 *   · 焦点环换回 var(--focus-ring-soft) → R4 红（12% 透明蓝，实测 alpha .12）
 *   · 去掉 color-scheme: light → R3 红（深色主题下实测 color-scheme=dark，
 *     原生 type=search 的清除按钮会按浅色渲染，压在纯白上等于看不见）
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
// playwright 装在 src/ui/client 下，把它的 node_modules 挂进解析路径，脚本才能独立跑
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const ROOT = path.resolve(__dirname, '..')
const SRC_FILE = path.join(ROOT, 'src/ui/client/src/views/components/WorkbenchProjectPanel.vue')
const BASE = process.env.ZEN_BASE || 'http://localhost:5544' // 前端
const API = process.env.ZEN_API || 'http://127.0.0.1:5545' // 后端
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'wb-proj-search-verify')
const REVERSE = process.argv.includes('--reverse')

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// ─────────────────────────────────────────────────────────────
// A. 静态断言（源码）
// ─────────────────────────────────────────────────────────────
console.log('── A. 静态断言（源码）──')

const raw = fs.readFileSync(SRC_FILE, 'utf8')
// 取 `.proj__search {` 到 `.proj__toggles {` 之间的样式块（模板里是 class="proj__search"，
// 不带前导点，所以这个 indexOf 命中的一定是 CSS 选择器）
const from = raw.indexOf('.proj__search {')
const to = raw.indexOf('.proj__toggles {')
if (from < 0 || to < 0 || to <= from) {
  console.error('S0 在 WorkbenchProjectPanel.vue 里定位不到 .proj__search / .proj__toggles 样式块 —— 选择器改名了？')
  process.exit(2)
}
const block = stripComments(raw.slice(from, to))

const BANNED = ['--text-primary', '--text-secondary', '--text-meta', '--bg-subtle',
  '--border-color', '--focus-ring-soft', '--color-primary']
const leaked = BANNED.filter((v) => block.includes(v))
check('S1 .proj__search 块内不引用随主题翻转的令牌', leaked.length === 0,
  leaked.length ? `漏进去的：${leaked.join(' ')}` : `检查了 ${BANNED.length} 个令牌`)

check('S2a .proj__search 声明了 color-scheme: light', /color-scheme:\s*light/.test(block))
check('S2b .proj__search-input 声明了 caret-color', /caret-color:/.test(block))
check('S2c 底色是纯白字面量（不是令牌）', /background:\s*#fff\b/i.test(block))
check('S2d 范围没外溢：右栏「搜索任务标题或描述」的样式不在这个块里',
  !block.includes('__task-search') && !block.includes('placeholder="搜索任务'))

// ─────────────────────────────────────────────────────────────
// B. 运行时断言（两套主题各量一次）
// ─────────────────────────────────────────────────────────────

/** 旧写法 —— 只给 --reverse 注入用 */
const LEGACY_CSS = `
.proj__search {
  background: var(--bg-subtle) !important;
  border-color: var(--border-color) !important;
  color-scheme: dark !important;
}
.proj__search:focus-within {
  border-color: var(--color-primary) !important;
  box-shadow: var(--focus-ring-soft) !important;
}
.proj__search-icon { color: var(--text-meta) !important; }
.proj__search-input { color: var(--text-primary) !important; caret-color: var(--text-primary) !important; }
.proj__search-input::placeholder { color: var(--text-meta) !important; }
`

const stats = (over = {}) => ({
  total: 3, todo: 1, doing: 1, done: 1, progress: 33, runningJobs: 0,
  errorSubtasks: 0, lastActiveAt: '2026-10-07T02:00:00.000Z', ...over,
})
const git = (over = {}) => ({
  isGitRepo: true, branch: 'main', upstream: null, hasUpstream: false, detached: false,
  ahead: 0, behind: 0, changed: 0, staged: 0, unstaged: 0, untracked: 0, ...over,
})
const entry = (name, p, over = {}) => ({
  key: p, path: p, name, source: 'recent', isCurrent: false, exists: true, ...over,
})
/** 夹具只求「筛选条渲染出来」：两个项目就够，断言全落在搜索框自身上 */
const FIXTURE = [
  entry('zen-verify-Alpha', '/zen-verify/Alpha', { git: git(), stats: stats() }),
  entry('zen-verify-Beta', '/zen-verify/Beta', { git: git(), stats: stats() }),
]

/** 页面侧观测：一次拿全搜索框的计算样式与几何 */
function OBS() {
  const box = document.querySelector('.proj__search')
  const icon = document.querySelector('.proj__search-icon')
  const input = document.querySelector('.proj__search-input')
  const tools = document.querySelector('.proj__tools')
  if (!box || !icon || !input || !tools) return null
  const cs = (el, pseudo) => getComputedStyle(el, pseudo || undefined)
  const r = (el) => {
    const b = el.getBoundingClientRect()
    return { t: b.top, l: b.left, w: b.width, h: b.height, r: b.right, b: b.bottom }
  }
  return {
    theme: document.documentElement.getAttribute('data-theme') || 'light',
    bg: cs(box).backgroundColor,
    borderColor: cs(box).borderTopColor,
    borderWidth: cs(box).borderTopWidth,
    colorScheme: cs(box).colorScheme,
    boxShadow: cs(box).boxShadow,
    iconColor: cs(icon).color,
    textColor: cs(input).color,
    caretColor: cs(input).caretColor,
    placeholderColor: cs(input, '::placeholder').color,
    boxRect: r(box),
    toolsRect: r(tools),
    toggles: Array.from(document.querySelectorAll('.proj__toggle')).map((b) => ({
      text: b.textContent.trim(), rect: r(b),
    })),
    overflow: { box: box.scrollWidth <= box.clientWidth + 1, input: input.scrollWidth <= input.clientWidth + 1 },
  }
}

/** WCAG 相对亮度 / 对比度 */
const lum = (rgb) => rgb.reduce((acc, v, i) => {
  const s = v / 255
  const t = s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  return acc + t * [0.2126, 0.7152, 0.0722][i]
}, 0)
const parseRgb = (s) => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number)
const contrast = (a, b) => {
  const [x, y] = [lum(parseRgb(a)), lum(parseRgb(b))].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}

const WHITE = 'rgb(255, 255, 255)'
const GRAY = 'rgb(107, 114, 128)' // #6b7280
const INK = 'rgb(31, 41, 55)' // #1f2937
const BLUE_EDGE = 'rgb(37, 99, 235)' // #2563eb

/** 等焦点环的过渡彻底退完再量 —— 否则读到的是过渡中的中间值 */
async function settleIdle(page) {
  await page.waitForFunction(() => {
    const b = document.querySelector('.proj__search')
    return b && getComputedStyle(b).boxShadow === 'none'
  }, null, { timeout: 3000 }).catch(() => {})
  await sleep(100)
}

async function main() {
  const alive = await fetch(`${API}/api/app-version`).then((r) => r.ok).catch(() => false)
  if (!alive) {
    console.error(`后端没起（${API}）—— 先 npm run dev`)
    process.exit(2)
  }
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 2 })).newPage()
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })

  await page.route('**/api/workbench/projects', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ success: true, projects: FIXTURE, counts: {} }),
  }))

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.activity-bar', { timeout: 20000 })
  await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
  await page.waitForSelector('.board', { timeout: 15000 })
  await page.waitForSelector('.proj__search-input', { timeout: 15000 })

  const obs = () => page.evaluate(OBS)
  const setTheme = (t) => page.evaluate((v) => {
    if (v === 'dark') document.documentElement.setAttribute('data-theme', 'dark')
    else document.documentElement.removeAttribute('data-theme')
  }, t)

  try {
    console.log('── B. 运行时断言（两套主题）──')

    for (const theme of ['light', 'dark']) {
      await setTheme(theme)
      if (REVERSE) {
        await page.evaluate((css) => {
          let el = document.getElementById('__legacy_proj_search')
          if (!el) {
            el = document.createElement('style')
            el.id = '__legacy_proj_search'
            document.head.appendChild(el)
          }
          el.textContent = css
        }, LEGACY_CSS)
      }
      await sleep(250)
      const tag = theme === 'light' ? 'L' : 'D'

      // 静止态：placeholder / 描边 / 焦点环
      await page.locator('.proj__search-input').fill('')
      await page.locator('.proj__search-input').blur()
      await settleIdle(page)
      let s = await obs()
      if (!s) { check(`${tag}0 搜索框 + 筛选条都在 DOM 里`, false); continue }

      check(`${tag}1  容器底色 = 纯白`, s.bg === WHITE, s.bg)
      check(`${tag}2  图标与 placeholder 色 = #6b7280`,
        s.iconColor === GRAY && s.placeholderColor === GRAY, `icon ${s.iconColor} / ph ${s.placeholderColor}`)
      check(`${tag}3  color-scheme 实测 light（原生清除按钮/光标按浅色渲染）`,
        s.colorScheme.includes('light'), s.colorScheme)
      check(`${tag}4a 静止态描边可见（非透明、非零宽）`,
        s.borderWidth !== '0px' && !/rgba\(0, 0, 0, 0\)/.test(s.borderColor),
        `${s.borderWidth} ${s.borderColor}`)
      check(`${tag}4b 静止态无焦点环`, s.boxShadow === 'none', s.boxShadow)
      await page.locator('.proj__search').screenshot({ path: path.join(SHOT_DIR, `search-${theme}-idle${REVERSE ? '-legacy' : ''}.png`) })

      // 已输入 + 聚焦：正文色 / caret / 焦点环
      await page.locator('.proj__search-input').fill('Alpha')
      await page.locator('.proj__search-input').focus()
      await sleep(250)
      s = await obs()
      check(`${tag}5a 已输入文字色 = #1f2937`, s.textColor === INK, s.textColor)
      check(`${tag}5b caret 色 = #1f2937（白底可见）`, s.caretColor === INK, s.caretColor)
      check(`${tag}6a 聚焦态描边 = #2563eb`, s.borderColor === BLUE_EDGE, s.borderColor)
      check(`${tag}6b 聚焦态焦点环可见（实蓝 28%，不是 12% 灰雾）`,
        /rgba\(37, 99, 235, 0\.28\)/.test(s.boxShadow), s.boxShadow)
      await page.locator('.proj__search').screenshot({ path: path.join(SHOT_DIR, `search-${theme}-focus${REVERSE ? '-legacy' : ''}.png`) })

      // 对比度：白底上的正文与 placeholder
      const cInk = contrast(s.textColor, s.bg)
      const cMeta = contrast(s.placeholderColor, s.bg)
      check(`${tag}7a 正文对白底 ≥ 4.5:1（WCAG AA）`, cInk >= 4.5, `${cInk.toFixed(2)}:1`)
      check(`${tag}7b placeholder 对白底 ≥ 4.5:1`, cMeta >= 4.5, `${cMeta.toFixed(2)}:1`)

      // 几何：白底没把这一行挤坏
      const inTools = (r) => r.l >= s.toolsRect.l - 0.5 && r.r <= s.toolsRect.r + 0.5
      const [t0, t1] = s.toggles
      check(`${tag}8a 两个开关都完整落在筛选条内`,
        s.toggles.length === 2 && inTools(t0.rect) && inTools(t1.rect),
        `${JSON.stringify([t0 && t0.text, t1 && t1.text])} tools=[${s.toolsRect.l},${s.toolsRect.r}]`)
      check(`${tag}8b 两个开关等宽且不重叠`,
        !!t0 && !!t1 && Math.abs(t0.rect.w - t1.rect.w) < 0.5 && t0.rect.r <= t1.rect.l + 0.5,
        t0 && t1 ? `w=${t0.rect.w}/${t1.rect.w}` : '开关不足两个')
      check(`${tag}8c 搜索框内无横向溢出`, s.overflow.box && s.overflow.input, JSON.stringify(s.overflow))

      // 记录一行几何：这一行到底是几行（改了两行布局再回来看这里）
      log(`${tag} 布局：搜索框 top=${s.boxRect.t.toFixed(1)} 开关 top=${t0 ? t0.rect.t.toFixed(1) : 'n/a'}`
        + `（相等=同一行；本项目按设计是两行，搜索独占一行）`)
    }

    // 留一张整页图，深浅各一张
    for (const theme of ['light', 'dark']) {
      await setTheme(theme)
      await sleep(200)
      await page.screenshot({ path: path.join(SHOT_DIR, `page-${theme}${REVERSE ? '-legacy' : ''}.png`) })
    }
  } finally {
    await browser.close()
  }

  const noisy = (t) => /favicon|ERR_|net::|ResizeObserver|Download the Vue/.test(t)
  const realErrors = [...pageErrors, ...consoleErrors].filter((t) => !noisy(t))
  check('无 console / page 错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

  const failed = results.filter((r) => !r.ok)
  console.log('')
  if (pageErrors.length) pageErrors.slice(0, 5).forEach((e) => console.log('  ! ' + e.slice(0, 200)))

  /* --reverse 的期望是**指定那几条**变红，不是"运行时全红"：
     S1/S2 是源码断言，注入的旧 CSS 在运行时，它们照旧应当是绿的；
     8a/8b/8c 量的是布局，旧写法不动布局，也不该红。 */
  const MUST_FAIL_IN_REVERSE = [
    'L1  容器底色 = 纯白',
    'L2  图标与 placeholder 色 = #6b7280',
    'L3  color-scheme 实测 light（原生清除按钮/光标按浅色渲染）',
    'L5a 已输入文字色 = #1f2937',
    'L5b caret 色 = #1f2937（白底可见）',
    'L6a 聚焦态描边 = #2563eb',
    'L6b 聚焦态焦点环可见（实蓝 28%，不是 12% 灰雾）',
    'L7a 正文对白底 ≥ 4.5:1（WCAG AA）',
    'L7b placeholder 对白底 ≥ 4.5:1',
    'D1  容器底色 = 纯白',
    'D2  图标与 placeholder 色 = #6b7280',
    'D3  color-scheme 实测 light（原生清除按钮/光标按浅色渲染）',
    'D5a 已输入文字色 = #1f2937',
    'D5b caret 色 = #1f2937（白底可见）',
    'D6a 聚焦态描边 = #2563eb',
    'D6b 聚焦态焦点环可见（实蓝 28%，不是 12% 灰雾）',
    'D7a 正文对白底 ≥ 4.5:1（WCAG AA）',
    'D7b placeholder 对白底 ≥ 4.5:1',
  ]

  console.log(`用例 ${results.length}，通过 ${results.length - failed.length}，失败 ${failed.length}`
    + (REVERSE ? '（--reverse：下面这几条必须红）' : ''))
  console.log('截图:', SHOT_DIR)

  let okOverall
  if (REVERSE) {
    const notRed = MUST_FAIL_IN_REVERSE.filter((n) => results.find((r) => r.name === n)?.ok !== false)
    okOverall = notRed.length === 0
    console.log(okOverall
      ? '反向验证通过：旧写法确实被这几条断言挡下'
      : '反向验证失败：旧写法居然过关 —— 断言守错了地方：' + notRed.join(' / '))
  } else {
    okOverall = failed.length === 0
    console.log(okOverall ? '[verify] 合计 PASS' : '[verify] 有失败')
  }
  process.exit(okOverall ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })

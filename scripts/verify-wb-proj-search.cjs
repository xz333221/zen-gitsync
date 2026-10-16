/**
 * 左栏「项目列表」搜索框：跟随主题 + 可读性 —— 浏览器验证。
 *
 * 守的契约（对应 WorkbenchProjectPanel.vue 的 .proj__search / __icon / __input）：
 *   S1  静态：`.proj__search` 块内**不含写死的浅色字面量**（#fff / #1f2937 / #6b7280 /
 *       #d1d5db / #2563eb / --proj-search- 本地变量）。这是本页最核心的一条 ——
 *       只要又写死回来，深色主题下就是一块刺眼白底。
 *   S2a 静态：`.proj__search` 块内**不声明 color-scheme**（底色已随主题翻转，
 *       原生清除按钮 / 光标继承根节点即可）
 *   S2b 静态：块内引用全套随主题翻转的输入框令牌（--bg-input / --border-input /
 *       --border-input-hover / --text-primary / --text-meta / --focus-ring-soft / --color-primary）
 *   S2c 静态：`.proj__search-input` 有 caret-color
 *   R1  两套主题下容器底色分别是白 / #24292e（跟随 --bg-input）
 *   R2  图标与 placeholder 跟随 --text-meta（light #686a6f / dark #cbd0d6）
 *   R3  color-scheme 跟随主题（light→light / dark→dark），原生控件不再被钉死成浅色
 *   R4  静止态描边可见（非透明、非零宽）且无焦点环；聚焦态描边 = --color-primary + --focus-ring-soft
 *   R5  正文 / placeholder 对**各自底色**都 ≥ 4.5:1（WCAG AA）
 *   R6  两个开关仍完整落在筛选条内、等宽不重叠、搜索框内无横向溢出
 *   R0a 默认态只露一枚放大镜（容器 ≈34px 宽、未展开）
 *   R0b 点开后输入框展开（容器明显变宽）
 *
 * ⚠️ 2026-10-16：搜索从"常驻输入框"改成"一枚放大镜、点开展开"（与看板标题行
 *    .board__head-search 同一交互）。底色 / 描边 / 焦点环契约原样（容器仍是
 *    那个带边框的框），只是默认 34px 只露图标；因此主流程先点开再量
 *    （input 默认 display:none，fill 会打空），静止态不再 fill('')+blur
 *    （空词失焦会按新交互收起）。
 *
 * ⚠️ 断言用**实测计算样式 + WCAG 对比度**，不是"截图看着白"。--reverse 把旧写法
 *   （固定 #fff 白底 + 写死灰阶 + color-scheme: light + 28% 实蓝焦点环）注回去，
 *   那些"跟随主题"的断言必须变红 —— 证明它们守的是这套值本身，而不是"页面没崩"。
 *   S1/S2 是源码断言，注入的 CSS 在运行时，它们照旧应当是绿的。
 *
 * 反向验证（把新写法撤成旧写法后哪几条会红）：
 *   · 底色/字色换回写死的 #fff + #1f2937 + #6b7280 → 深色下 D1/D2/D5a 红（白底扎眼、
 *     与浅色主题同款值）；浅色下 L2/L5a 也红（旧灰阶 ≠ 新令牌值）
 *   · 去掉 color-scheme: light 后旧写法在深色下 D3 红 — 新写法本就不该有 color-scheme
 *   · 焦点环换回 rgba(37,99,235,.28) → L6a/L6b、D6a/D6b 红
 *   · 对比度断言两套主题下都该**保持绿**：旧白底配深字本身也过 AA，它守的是可读性、
 *     不是主题跟随，所以不在 MUST_FAIL 名单里。
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

// 写死的浅色字面量 / 本地变量：只要有一个回来，就说明底色或字色又被钉死了
const BANNED = ['#fff', '#1f2937', '#6b7280', '#d1d5db', '#2563eb', '--proj-search-']
const banned = BANNED.filter((v) => block.includes(v))
check('S1 .proj__search 块内不含写死的浅色字面量 / 本地变量', banned.length === 0,
  banned.length ? `又写死回来的：${banned.join(' ')}` : `检查了 ${BANNED.length} 个字面量`)

check('S2a .proj__search 块内不声明 color-scheme（底色已随主题翻转）',
  !/color-scheme/.test(block))

const REQUIRED = ['--bg-input', '--border-input', '--border-input-hover', '--text-primary',
  '--text-meta', '--focus-ring-soft', '--color-primary']
const missing = REQUIRED.filter((v) => !block.includes(v))
check('S2b .proj__search 块引用了全套随主题翻转的输入框令牌', missing.length === 0,
  missing.length ? `缺令牌：${missing.join(' ')}` : `检查了 ${REQUIRED.length} 个令牌`)

check('S2c .proj__search-input 声明了 caret-color', /caret-color:/.test(block))
check('S2d 范围没外溢：右栏「搜索任务标题或描述」的样式不在这个块里',
  !block.includes('__task-search') && !block.includes('placeholder="搜索任务'))

// ─────────────────────────────────────────────────────────────
// B. 运行时断言（两套主题各量一次）
// ─────────────────────────────────────────────────────────────

/** 旧写法（固定白底）—— 只给 --reverse 注入用 */
const LEGACY_CSS = `
.proj__search {
  background: #fff !important;
  border-color: #d1d5db !important;
  color-scheme: light !important;
}
.proj__search:hover:not(:focus-within) { border-color: #d1d5db !important; }
.proj__search:focus-within {
  border-color: #2563eb !important;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.28) !important;
}
.proj__search-icon { color: #6b7280 !important; }
.proj__search-input { color: #1f2937 !important; caret-color: #1f2937 !important; }
.proj__search-input::placeholder { color: #6b7280 !important; }
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

/* 新契约的期望值（与 variables.scss / dark-theme.scss 一一对应）：
   --bg-input     light white / dark #24292e
   --text-primary light #303133 / dark #fff
   --text-meta    light #686a6f / dark #cbd0d6
   --color-primary #3b82f6（两套同值） */
const EXPECT = {
  light: {
    bg: 'rgb(255, 255, 255)',
    ink: 'rgb(48, 49, 51)',   // #303133
    meta: 'rgb(104, 106, 111)', // #686a6f
    colorScheme: 'light',
  },
  dark: {
    bg: 'rgb(36, 41, 46)',    // #24292e
    ink: 'rgb(255, 255, 255)',
    meta: 'rgb(203, 208, 214)', // #cbd0d6
    colorScheme: 'dark',
  },
}
const BLUE = 'rgb(59, 130, 246)' // #3b82f6 --color-primary

/* --focus-ring-soft = 「--color-primary 12% 透明」的焦点环。
   ⚠️ ChatGPT/Chrome 会把 color-mix() 的结果序列化成 `color(srgb 0.231373 0.509804 0.964706 / 0.12)`，
   而不是 `rgba(59, 130, 246, 0.12)` —— 所以不能只匹配 rgba 写法，得同时认两种，
   并按 `--color-primary` 的通道值（59/255=0.231373, 130/255=0.509804, 246/255=0.964706）
   与 12% 的 alpha 判，别用裸 `0.12` 子串。 */
const isPrimarySoftRing = (shadow) =>
  shadow !== 'none' && /3px/.test(shadow)
  && (/59,\s*130,\s*246|0\.231373\s+0\.509804\s+0\.964706/.test(shadow))
  && /[\/,]\s*0\.12\s*\)/.test(shadow) // 12% alpha（.28 的实蓝环不会命中）

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
  // 2026-10-16：搜索改成"一枚放大镜、点开展开"（同看板标题行那枚），
  // input 默认 display:none —— 等容器而不是等 input（visible 会超时）
  await page.waitForSelector('.proj__search', { timeout: 15000 })

  // 新契约：默认态只露一枚图标（容器 ≈34px），点开才长出输入框
  const idleBox = await page.evaluate(() => {
    const el = document.querySelector('.proj__search')
    if (!el) return null
    return { w: +el.getBoundingClientRect().width.toFixed(1), open: el.classList.contains('is-open') }
  })
  check('R0a 默认态只露一枚放大镜（容器 ≈34px、未展开）',
    !!idleBox && idleBox.w >= 20 && idleBox.w <= 40 && !idleBox.open,
    idleBox ? `w=${idleBox.w} open=${idleBox.open}` : '容器不在')

  const obs = () => page.evaluate(OBS)
  const setTheme = (t) => page.evaluate((v) => {
    if (v === 'dark') document.documentElement.setAttribute('data-theme', 'dark')
    else document.documentElement.removeAttribute('data-theme')
  }, t)
  /** 点开搜索并等 width 过渡落定（过渡 260ms，立即量会读到中间值） */
  async function openSearchAndSettle() {
    await page.locator('.proj__search-btn').click()
    await page.waitForSelector('.proj__search-input', { state: 'visible', timeout: 5000 })
    await page.waitForFunction(() => {
      const el = document.querySelector('.proj__search')
      return el && el.getBoundingClientRect().width > 100
    }, null, { timeout: 3000 }).catch(() => {})
    // 点完鼠标还悬在按钮上：图标在按钮里，:hover 会把它染成 --text-primary，
    // 污染后面所有颜色读数 —— 挪到面板外（中栏看板区域）再量
    await page.mouse.move(700, 300)
    await sleep(120)
  }
  /** 收回搜索（空词失焦即收起，与产品交互同一条判据） */
  async function closeSearch() {
    const open = await page.locator('.proj__search.is-open').count()
    if (!open) return
    await page.locator('.proj__search-input').fill('')
    await page.locator('.proj__search-input').blur()
    await page.waitForFunction(() => !document.querySelector('.proj__search.is-open'), null, { timeout: 3000 }).catch(() => {})
  }

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
      const exp = EXPECT[theme]

      // 每轮都从**收起态**开始（dark 轮开始时上一轮是展开+聚焦的）。
      // ⚠️ 收起态的 input 是 display:none —— 但颜色 / caret / placeholder 的
      // 计算样式照常可读（getComputedStyle 不要求元素渲染出来），
      // 所以静止态整套可以在收起态量；这也正是用户的默认所见。
      await closeSearch()
      // 等焦点环过渡彻底退完再量静止态 —— blur 后 box-shadow 从蓝环过渡回 none
      // 要 260ms，过渡中间值（2.47px / alpha 0.1 的淡环）会被 D4b 当成"有环"
      await page.waitForFunction(() => {
        const b = document.querySelector('.proj__search')
        return b && getComputedStyle(b).boxShadow === 'none'
      }, null, { timeout: 3000 }).catch(() => {})
      let s = await obs()
      if (!s) { check(`${tag}0 搜索框 + 筛选条都在 DOM 里`, false); continue }

      check(`${tag}1  容器底色跟随 --bg-input`, s.bg === exp.bg, `实测 ${s.bg} / 期望 ${exp.bg}`)
      check(`${tag}2  图标与 placeholder 色跟随 --text-meta`,
        s.iconColor === exp.meta && s.placeholderColor === exp.meta,
        `icon ${s.iconColor} / ph ${s.placeholderColor} / 期望 ${exp.meta}`)
      check(`${tag}3  color-scheme 跟随主题（原生清除按钮/光标不再被钉死）`,
        s.colorScheme.includes(exp.colorScheme), s.colorScheme)
      check(`${tag}4a 静止态描边可见（非透明、非零宽）`,
        s.borderWidth !== '0px' && !/rgba\(0, 0, 0, 0\)/.test(s.borderColor),
        `${s.borderWidth} ${s.borderColor}`)
      check(`${tag}4b 静止态无焦点环`, s.boxShadow === 'none', s.boxShadow)
      await page.locator('.proj__search').screenshot({ path: path.join(SHOT_DIR, `search-${theme}-idle${REVERSE ? '-legacy' : ''}.png`) })

      // 点开 → 输入框展开（R0b），鼠标挪开 → 已输入 + 聚焦
      await openSearchAndSettle()
      const openW = await page.evaluate(() => {
        const el = document.querySelector('.proj__search')
        return el ? +el.getBoundingClientRect().width.toFixed(1) : -1
      })
      check('R0b 点开后输入框展开（容器明显变宽）', openW > 100, `w=${openW}`)
      await page.locator('.proj__search-input').fill('Alpha')
      await sleep(250)
      s = await obs()
      check(`${tag}5a 已输入文字色跟随 --text-primary`, s.textColor === exp.ink,
        `实测 ${s.textColor} / 期望 ${exp.ink}`)
      check(`${tag}5b caret 色 = --color-primary`, s.caretColor === BLUE, s.caretColor)
      check(`${tag}6a 聚焦态描边 = --color-primary`, s.borderColor === BLUE, s.borderColor)
      check(`${tag}6b 聚焦态焦点环可见（--focus-ring-soft，蓝 12%）`,
        isPrimarySoftRing(s.boxShadow), s.boxShadow)
      await page.locator('.proj__search').screenshot({ path: path.join(SHOT_DIR, `search-${theme}-focus${REVERSE ? '-legacy' : ''}.png`) })

      // 对比度：**各自底色**上的正文与 placeholder
      const cInk = contrast(s.textColor, s.bg)
      const cMeta = contrast(s.placeholderColor, s.bg)
      check(`${tag}7a 正文对本主题底色 ≥ 4.5:1（WCAG AA）`, cInk >= 4.5, `${cInk.toFixed(2)}:1`)
      check(`${tag}7b placeholder 对本主题底色 ≥ 4.5:1`, cMeta >= 4.5, `${cMeta.toFixed(2)}:1`)

      // 几何：这一行没被挤坏
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
     4a/4b/7a/7b/8a/8b/8c 不受旧写法影响，也不该红（对比度旧白底也过 AA）。 */
  const MUST_FAIL_IN_REVERSE = [
    'L2  图标与 placeholder 色跟随 --text-meta',
    'L5a 已输入文字色跟随 --text-primary',
    'L5b caret 色 = --color-primary',
    'L6a 聚焦态描边 = --color-primary',
    'L6b 聚焦态焦点环可见（--focus-ring-soft，蓝 12%）',
    'D1  容器底色跟随 --bg-input',
    'D2  图标与 placeholder 色跟随 --text-meta',
    'D3  color-scheme 跟随主题（原生清除按钮/光标不再被钉死）',
    'D5a 已输入文字色跟随 --text-primary',
    'D5b caret 色 = --color-primary',
    'D6a 聚焦态描边 = --color-primary',
    'D6b 聚焦态焦点环可见（--focus-ring-soft，蓝 12%）',
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

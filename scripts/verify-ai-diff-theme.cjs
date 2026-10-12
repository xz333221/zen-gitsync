/**
 * AI 差异说明（AiDiffSummary）在深色主题下不再是一块白底 —— 浏览器验证。
 *
 * 背景：说明区的 markdown 原本跟**全局 markdown 主题**走 —— 那是用户给"文档预览"
 * 选的皮肤（默认 github = 白底 #ffffff），深色应用里嵌进去就是两块纯白。
 * 现在它跟**应用亮暗**走（APP_MARKDOWN_THEME：light→github / dark→github-dark），
 * 用实例级作用域的主题样式（`.md-preview.md-preview--scoped-<主题名>`）覆盖全局那套，
 * 并把自身底色让给面板（background: transparent）。
 *
 * 守的契约：
 *   S1  AiDiffSummary.vue：两处 MarkdownPreview 都传了 :theme="summaryMarkdownTheme"
 *   S2  AiDiffSummary.vue：主题来源是 <html data-theme>（useThemeObserver + APP_MARKDOWN_THEME），
 *       **不读** configStore.markdownTheme（用户给文档选的皮肤）
 *   S3  AiDiffSummary.vue：.summary-body / .dialog-body 的 :deep(.md-preview) 把底色让掉
 *   S4  MarkdownPreview.vue：theme prop → 根节点挂 scoped 类；不传则不挂
 *   S5  markdownTheme.ts：APP_MARKDOWN_THEME 有 light/dark 两档；scoped 注入把选择器抬成
 *       两段类名（特异性 0-2-0 > 全局 0-1-0），不留裸 .md-preview，且类名里带主题名
 *   L1/D1 说明区渲染出来，根节点带 md-preview--scoped-<主题名>
 *   L2/D2 根节点自身底色透明（底色由面板决定）
 *   L3/D3 往上找到的第一个不透明祖先底色：浅色亮 / 深色暗 —— **这条就是用户看到的白底**
 *   L4/D4 正文色 = 该主题的前景色（light #1f2328 / dark #e6edf3）：证明走的是 github-dark，
 *         而不是全局那套 github
 *   L5/D5 正文对**实测底色** ≥ 4.5:1（WCAG AA）
 *   D6    弹窗（"弹窗查看"）那条渲染路径同样是深色
 *   L7/D7 实例级样式表存在且不含裸 .md-preview 选择器
 *
 * --reverse 把旧写法（白底 + 深字，!important）注回去，D2/D3/D4/D6 必须变红 ——
 * 证明它们守的是这套值本身，而不是"页面没崩"。
 *
 * ⚠️ 踩过的坑（别再犯）：两套实例级主题如果**共用一个类名**，抬升后的选择器特异性相同，
 *   谁后进 <head> 谁赢 —— 浅色→深色切一次，`-github` 就永久盖住 `-github-dark`，
 *   表现为"深色下还是浅色字"。所以类名必须带主题名（S5d 守这条）。
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
// playwright 装在 src/ui/client 下，把它的 node_modules 挂进解析路径，脚本才能独立跑
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const ROOT = path.resolve(__dirname, '..')
const SRC = (p) => path.join(ROOT, 'src/ui/client/src', p)
const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'ai-diff-theme-verify')
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

const summarySrc = stripComments(fs.readFileSync(SRC('components/AiDiffSummary.vue'), 'utf8'))
const previewSrc = stripComments(fs.readFileSync(SRC('components/MarkdownPreview.vue'), 'utf8'))
const themeSrc = stripComments(fs.readFileSync(SRC('utils/markdownTheme.ts'), 'utf8'))

const themePropCount = (summarySrc.match(/:theme="summaryMarkdownTheme"/g) || []).length
check('S1 两处 MarkdownPreview 都指定了实例级主题', themePropCount === 2,
  `实测 ${themePropCount} 处（模板里 overall 面板 + 弹窗各一处）`)

const previewUses = (summarySrc.match(/<MarkdownPreview/g) || []).length
check('S1b MarkdownPreview 的用法数没变（没有漏掉新增的一处）', previewUses === themePropCount,
  `${previewUses} 处用法 / ${themePropCount} 处带 theme`)

check('S2a 主题来自 APP_MARKDOWN_THEME[appTheme]（跟随 <html data-theme>）',
  /APP_MARKDOWN_THEME\s*\[\s*appTheme\.value\s*\]/.test(summarySrc) && /useThemeObserver\(\)/.test(summarySrc))
// 说明区只该认 APP_MARKDOWN_THEME；除了自己那个 summaryMarkdownTheme 变量，
// 不该再出现别的 markdownTheme 引用（尤其是 configStore.markdownTheme —— 用户给文档选的皮肤）。
// import 行要剔掉：`@/utils/markdownTheme` 这个模块路径里就带 markdownTheme。
const summaryBody = summarySrc.split('\n').filter((l) => !/^\s*import\b/.test(l)).join('\n')
const themeRefs = (summaryBody.match(/markdownTheme/gi) || []).length
const ownRefs = (summaryBody.match(/summaryMarkdownTheme/g) || []).length
check('S2b 不读 configStore.markdownTheme（那是用户给文档选的皮肤）',
  !/configStore\.markdownTheme/.test(summaryBody) && themeRefs === ownRefs,
  `${themeRefs} 处引用 / 其中 ${ownRefs} 处是自己的 summaryMarkdownTheme`)

const transparentCount = (summarySrc.match(/background:\s*transparent/g) || []).length
check('S3 .summary-body / .dialog-body 都把 md 底色让掉', transparentCount === 2,
  `实测 ${transparentCount} 处 background: transparent`)
check('S3b 两处仍各自把 padding 归零（主题自带 16px 内边距）',
  (summarySrc.match(/:deep\(\.md-preview\)\s*\{[^}]*padding:\s*0/g) || []).length === 2)

check('S4 MarkdownPreview 的根节点按 theme prop 挂 scoped 类',
  /:class="scopedClass"/.test(previewSrc)
  && /scopedMarkdownClass\(props\.theme\)/.test(previewSrc)
  && /watchEffect\(/.test(previewSrc))
check('S4b theme prop 默认空串 → 不传 theme 的调用方仍走全局主题',
  /theme:\s*''/.test(previewSrc))

check('S5a APP_MARKDOWN_THEME 有 light / dark 两档',
  /APP_MARKDOWN_THEME[\s\S]{0,200}?light:[\s\S]{0,80}?dark:/.test(themeSrc))
check('S5b scoped 注入把选择器抬成两段类名（特异性高于全局那套）',
  /\.md-preview\.\$\{className\}/.test(themeSrc))
check('S5c 替换带否定前瞻，不会把 .md-preview-xxx 这类名字切坏',
  /\\\.md-preview\(\?!\[\\w-\]\)/.test(themeSrc))
check('S5d 类名里带主题名（两套实例级主题不会因文档序互盖）',
  /SCOPED_MARKDOWN_CLASS_PREFIX\s*=\s*'md-preview--scoped-'/.test(themeSrc)
  && /scopedMarkdownClass/.test(themeSrc))

// ─────────────────────────────────────────────────────────────
// B. 运行时断言（两套主题各量一次）
// ─────────────────────────────────────────────────────────────

/** 旧写法（说明区固定白底 + 深字）—— 只给 --reverse 注入用。
 *  两条选择器都得写：弹窗是 Teleport 出去的，不在 .ai-diff-summary 里。 */
const LEGACY_CSS = `
.ai-diff-summary .md-preview,
.ai-summary-dialog .md-preview {
  background: #ffffff !important;
  color: #1f2328 !important;
}
`

/** 一份足够触发渲染的 SSE 说明内容（不真的打 LLM） */
const SSE_BODY = [
  'data: {"type":"delta","content":"### 整体意图\\n\\n为后台批量 fetch 补上 GCM 的交互开关，避免凭据弹窗挂住刷新。\\n"}\n\n',
  'data: {"type":"delta","content":"- 新增 `GCM_INTERACTIVE` 开关\\n- 同步补一篇介绍文档\\n"}\n\n',
  'data: {"type":"done"}\n\n'
].join('')

/** 页面侧观测：拿说明区 markdown 的计算样式 + 有效底色（往上找第一个不透明祖先） */
function OBS({ selector, scopedClass }) {
  const host = document.querySelector(selector)
  if (!host) return { rendered: false, reason: 'host-missing' }
  const root = host.querySelector('.md-preview')
  if (!root) return { rendered: false, reason: 'md-preview-missing' }
  const cs = getComputedStyle(root)

  let node = root
  let effectiveBg = ''
  while (node) {
    const c = getComputedStyle(node).backgroundColor
    if (c && !/^(rgba?\(0,\s*0,\s*0,\s*0\)|transparent)$/.test(c)) { effectiveBg = c; break }
    node = node.parentElement
  }

  const scoped = document.getElementById(scopedClass.replace('md-preview--scoped-', 'flowdash-md-preview-scoped-'))
  return {
    rendered: true,
    theme: document.documentElement.getAttribute('data-theme') || 'light',
    classes: root.className,
    ownBg: cs.backgroundColor,
    color: cs.color,
    effectiveBg: effectiveBg || 'none',
    effectiveBgFrom: node ? node.className : 'none',
    scopedStyleText: scoped ? scoped.textContent : null
  }
}

/** WCAG 相对亮度 / 对比度。
 *  ⚠️ color-mix() 的计算值在 Chrome 里序列化成 `color(srgb r g b / a)`（分量是 0–1 浮点），
 *  不是 `rgba(r,g,b,a)` —— 两种都得认，否则 .is-overall 那层带主色淡混的底色会被读成 0–1。 */
const parseRgb = (s) => {
  if (/^color\(/i.test(s)) {
    const nums = (s.match(/-?\d*\.?\d+/g) || []).map(Number)
    return nums.slice(0, 3).map((v) => v * 255)
  }
  return (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number)
}
const lum = (rgb) => rgb.reduce((acc, v, i) => {
  const s = v / 255
  const t = s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  return acc + t * [0.2126, 0.7152, 0.0722][i]
}, 0)
const contrast = (a, b) => {
  const [x, y] = [lum(parseRgb(a)), lum(parseRgb(b))].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}

/* 期望值：github 前景 #1f2328 / github-dark 前景 #e6edf3（来自 flowdash-md-preview 的主题预设） */
const EXPECT = {
  light: { color: 'rgb(31, 35, 40)', bgIsLight: true, themeName: 'github' },
  dark: { color: 'rgb(230, 237, 243)', bgIsLight: false, themeName: 'github-dark' }
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 2 })).newPage()
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })

  // 说明内容是 SSE：桩掉，别真的打 LLM
  await page.route('**/api/ai/diff-summary', (route) => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: SSE_BODY
  }))

  const setTheme = (t) => page.evaluate((v) => {
    if (v === 'dark') document.documentElement.setAttribute('data-theme', 'dark')
    else document.documentElement.removeAttribute('data-theme')
  }, t)

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })

    // 进 Git 视图 → 点第一个文件 → 打开「文件差异」弹窗（说明区挂在它的左栏底部）
    await page.locator('.activity-btn[aria-label^="Git"]').first().click()
    const rowSel = await page.waitForSelector('.vfl__row--file, .vft__row--node', { timeout: 25000 })
      .then((h) => h.evaluate((el) => (el.classList.contains('vfl__row--file') ? '.vfl__row--file' : '.vft__row--node')))
    log('文件行选择器:', rowSel)
    await page.locator(rowSel).first().click()
    await page.waitForSelector('.file-diff-dialog', { timeout: 15000 })
    await page.waitForSelector('.ai-diff-summary', { timeout: 20000 })
    await page.waitForSelector('.ai-diff-summary .md-preview', { timeout: 20000 })
    log('文件差异弹窗 + AI 说明区已渲染')

    console.log('── B. 运行时断言（两套主题）──')

    for (const theme of ['light', 'dark']) {
      await setTheme(theme)
      if (REVERSE) {
        await page.evaluate((css) => {
          let el = document.getElementById('__legacy_ai_diff')
          if (!el) {
            el = document.createElement('style')
            el.id = '__legacy_ai_diff'
            document.head.appendChild(el)
          }
          el.textContent = css
        }, LEGACY_CSS)
      }
      await sleep(300)

      const tag = theme === 'light' ? 'L' : 'D'
      const exp = EXPECT[theme]
      const scopedClass = `md-preview--scoped-${exp.themeName}`
      const s = await page.evaluate(OBS, { selector: '.ai-diff-summary.is-overall', scopedClass })

      if (!s.rendered) {
        check(`${tag}1 说明区渲染出来`, false, `渲染失败：${s.reason}（模型没配 / AI 说明被关掉？）`)
        continue
      }

      check(`${tag}1 说明区渲染出来且根节点带实例级主题标记`,
        s.rendered && s.classes.includes(scopedClass), s.classes)
      check(`${tag}2 根节点自身底色透明（底色交给面板）`,
        /^(rgba?\(0,\s*0,\s*0,\s*0\)|transparent)$/.test(s.ownBg), s.ownBg)

      // 这条就是用户看到的"白底"：说明区实际压在什么底色上
      const bgLum = lum(parseRgb(s.effectiveBg))
      check(`${tag}3 有效底色${exp.bgIsLight ? '是浅色' : '不是浅色'}（深色主题下不许出现白底）`,
        exp.bgIsLight ? bgLum > 0.6 : bgLum < 0.2,
        `实测 ${s.effectiveBg}（亮度 ${bgLum.toFixed(3)}，来自 ${s.effectiveBgFrom}）`)

      check(`${tag}4 正文色 = 该亮暗档的 markdown 主题前景色`, s.color === exp.color,
        `实测 ${s.color} / 期望 ${exp.color}`)

      const c = contrast(s.color, s.effectiveBg)
      check(`${tag}5 正文对实测底色 ≥ 4.5:1（WCAG AA）`, c >= 4.5, `${c.toFixed(2)}:1`)

      check(`${tag}7 实例级样式表存在且不含裸 .md-preview 选择器`,
        !!s.scopedStyleText && s.scopedStyleText.includes(`.md-preview.${scopedClass}`)
        && !/\.md-preview\s*[,{]/.test(s.scopedStyleText),
        s.scopedStyleText ? `样式表 ${s.scopedStyleText.length} 字符` : '样式表不在 DOM 里')

      if (theme === 'dark') {
        // 弹窗那条渲染路径（同一个组件里的第二处 MarkdownPreview）
        await page.locator('.ai-diff-summary.is-overall .summary-actions button').first().click()
        await page.waitForSelector('.ai-summary-dialog .dialog-body .md-preview', { timeout: 10000 })
        await sleep(200)
        const d = await page.evaluate(OBS, { selector: '.ai-summary-dialog .dialog-body', scopedClass })
        check('D6 弹窗里的说明同样是深色（另一条渲染路径没漏）',
          d.rendered && d.color === exp.color && /^(rgba?\(0,\s*0,\s*0,\s*0\)|transparent)$/.test(d.ownBg),
          d.rendered ? `色 ${d.color} / 自身底色 ${d.ownBg}` : `渲染失败：${d.reason}`)
        await page.screenshot({ path: path.join(SHOT_DIR, `ai-diff-dialog-${theme}${REVERSE ? '-legacy' : ''}.png`) })
        await page.keyboard.press('Escape')
        await sleep(300)
      }

      await page.locator('.file-diff-dialog').screenshot({ path: path.join(SHOT_DIR, `ai-diff-${theme}${REVERSE ? '-legacy' : ''}.png`) })
      await page.locator('.ai-diff-summary.is-overall').screenshot({ path: path.join(SHOT_DIR, `ai-diff-summary-${theme}${REVERSE ? '-legacy' : ''}.png`) })
    }
  } finally {
    await browser.close()
  }

  const noisy = (t) => /favicon|ERR_|net::|ResizeObserver|Download the Vue|404 \(Not Found\)/.test(t)
  const realErrors = [...pageErrors, ...consoleErrors].filter((t) => !noisy(t))
  check('无 console / page 错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

  const failed = results.filter((r) => !r.ok)
  console.log('')
  if (pageErrors.length) pageErrors.slice(0, 5).forEach((e) => console.log('  ! ' + e.slice(0, 200)))

  /* --reverse 的期望是**指定那几条**变红，不是"运行时全红"：
     S1–S5 是源码断言（注入的旧 CSS 在运行时），照旧应当是绿的；
     L1/L7 不受旧写法影响；L5/D5 是**可读性**断言 —— 旧的白底配深字本身也过 AA，
     它守的是"读得清"不是"跟主题"，所以不在 MUST_FAIL 名单里。 */
  const MUST_FAIL_IN_REVERSE = ['D2', 'D3', 'D4', 'D6']
    .map((tag) => results.find((r) => r.name.startsWith(tag + ' ')))
    .filter(Boolean)
    .map((r) => r.name)

  console.log(`用例 ${results.length}，通过 ${results.length - failed.length}，失败 ${failed.length}`
    + (REVERSE ? '（--reverse：下面这几条必须红）' : ''))
  console.log('截图:', SHOT_DIR)

  let okOverall
  if (REVERSE) {
    const notRed = MUST_FAIL_IN_REVERSE.filter((n) => results.find((r) => r.name === n)?.ok !== false)
    okOverall = notRed.length === 0
    console.log(okOverall
      ? '反向验证通过：旧的白底写法确实被这几条断言挡下'
      : '反向验证失败：旧写法居然过关 —— 断言守错了地方：' + notRed.join(' / '))
  } else {
    okOverall = failed.length === 0
    console.log(okOverall ? '[verify] 合计 PASS' : '[verify] 有失败')
  }
  process.exit(okOverall ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })

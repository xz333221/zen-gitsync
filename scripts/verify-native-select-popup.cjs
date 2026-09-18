/**
 * 原生下拉（<select>）弹出层在深色主题下必须可读。
 *
 * 验收契约：
 *   P1 option 的解析后背景色必须是**不透明**的（半透明 = 弹出层会叠在 UA 浅色兜底上）
 *   P2 option 的文字色 vs 自身背景色，WCAG 对比度 >= 4.5:1
 *   P3 **选项文字真的画在采样区**：拍"未打开 / 已打开"两张同区域截图，必须能找回 option 的
 *      文字色（且关闭态找不回）—— 否则弹出层没开，后面拿页面底色一量就是空过
 *   P4 **实测底色 × option 的 computed 文字色**，对比度 >= 4.5:1
 *      —— 只断言 CSS 是"说了什么"，这一步才证明"渲染成什么"
 *   P5 深色下实测底色偏暗、浅色下偏亮（防止"两边都写成同一个色"蒙对比度）
 *   明暗两套主题都要过（切主题用 removeAttribute，不落盘、不碰用户配置）
 *
 * ⚠️ 回归点（2026-09-18）：`.kb__select` 的背景是 --bg-subtle = rgba(255,255,255,.05)。
 *    在页面里叠在深色容器上没问题；但弹出层是**独立画布**，半透明底会叠在 UA 的浅色
 *    兜底上 → 白底，而 option 文字是深色主题的浅色 --text-secondary → 浅灰写白底，
 *    实测对比度 1.40:1，等于看不见。
 *    撤掉 common.scss 里的 `select option{...}` 规则 → P1（两套主题）、P2（浅色）、P5 变红。
 *    注意：给 html 加 color-scheme:dark **修不了**这个（只改选中行的高亮色）——
 *    这条断言就是为了防止"用 color-scheme 糊过去"。
 *
 * ⚠️ 这条脚本自己踩过的坑（写断言时别再犯）：最初 P4 写成"区域内偏离底色最多的像素 = 文字"，
 *    结果被弹出层的**边框/阴影**骗了 —— 白底弹出层边框 #3b3b3b 量出 11.2:1 直接 PASS，
 *    而选项文字其实是隐形的。所以文字色必须取自 CSS computed，不是从像素里猜。
 *
 * 前置：dev server 已启动（npm run dev，后端 5545 / 前端 5544）。
 * 用法：node scripts/verify-native-select-popup.cjs
 * 退出码：0 全通过，1 有失败项，2 环境没起。
 *
 * ⚠️ 别给 newContext 加 deviceScaleFactor: 2 想着"截清楚点"：实测 dsf=2 时
 *    Playwright 的 page.screenshot **完全不包含原生 <select> 弹出层**
 *    （同一区域像素零变化、白像素 0），P3/P4 会全部失去意义。
 *    另外带 clip 参数的截图同样丢弹出层 —— 要裁切就整页拍完再裁。
 */
const path = require('node:path')

module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544'
const API = process.env.ZEN_API || 'http://127.0.0.1:5545'

const results = []
const consoleErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** WCAG 相对亮度 */
const relLum = ([r, g, b]) => {
  const f = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const contrast = (a, b) => {
  const [x, y] = [relLum(a), relLum(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}
const parseRgb = (s) => {
  const m = /rgba?\(([^)]+)\)/.exec(s || '')
  if (!m) return null
  const p = m[1].split(',').map((v) => parseFloat(v))
  return { rgb: p.slice(0, 3), alpha: p.length > 3 ? p[3] : 1 }
}
const hex = (rgb) => rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

/**
 * 量弹出层区域：众数色（= 弹出层底色）+ 指定文字色在该区域出现的像素数。
 *
 * ⚠️ 两个都踩过的坑，别再犯：
 *  1) 别用"偏离底色最多的像素 = 文字"这条启发式 —— 被弹出层的**边框/阴影**骗过：
 *     白底弹出层的边框 #3b3b3b 被当成文字，量出 11.2:1 直接 PASS，而选项文字其实是隐形的。
 *     所以文字色一律取自 **option 的 computed color**，不从像素里猜。
 *  2) 别用"底色变了 = 弹出层在采样区"当判据 —— 修好之后弹出层底色与页面底色**恰好相同**
 *     （都是 --bg-container），判据反而在正确状态下失效。改用"文字色出现了"这条指纹。
 */
async function popupStats(decoder, buf, rect, target) {
  return decoder.evaluate(async ({ b64, rect, target }) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const W = Math.min(rect.width, c.width - rect.x)
    const H = Math.min(rect.height, c.height - rect.y)
    const d = ctx.getImageData(rect.x, rect.y, W, H).data
    const hist = new Map()
    let near = 0
    for (let i = 0; i < d.length; i += 4) {
      const px = [d[i], d[i + 1], d[i + 2]]
      const k = px.join(',')
      hist.set(k, (hist.get(k) || 0) + 1)
      if (target && Math.abs(px[0] - target[0]) <= 24 && Math.abs(px[1] - target[1]) <= 24
        && Math.abs(px[2] - target[2]) <= 24) near++
    }
    const mode = [...hist.entries()].sort((a, b) => b[1] - a[1])[0]
    return {
      bg: mode[0].split(',').map(Number),
      modeShare: +(mode[1] / (W * H) * 100).toFixed(1),
      near,
      w: W,
      h: H,
    }
  }, { b64: buf.toString('base64'), rect, target: target || null })
}

async function main() {
  const alive = await fetch(`${API}/api/app-version`).then((r) => r.ok).catch(() => false)
  if (!alive) {
    console.error(`后端没起（${API}）—— 先 npm run dev`)
    process.exit(2)
  }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
  const decoder = await (await browser.newContext()).newPage()
  await decoder.goto('about:blank')
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })

  /** 对当前主题下的 select 做一轮测量 */
  async function measure(themeLabel) {
    const sel = page.locator('.kb__select').first()
    await sel.scrollIntoViewIfNeeded()
    const box = await sel.boundingBox()

    // ---- P1/P2：CSS 层（确定性，不依赖弹出层能不能截到）
    const css = await page.evaluate(() => {
      const s = document.querySelector('.kb__select')
      const o = s.querySelector('option')
      const cs = getComputedStyle(o)
      return { bg: cs.backgroundColor, color: cs.color, selectBg: getComputedStyle(s).backgroundColor }
    })
    const bgP = parseRgb(css.bg)
    const fgP = parseRgb(css.color)
    const opaque = !!bgP && bgP.alpha === 1
    check(`[${themeLabel}] P1 option 底色不透明`,
      opaque, `optionBg=${css.bg}（select 自身底色=${css.selectBg}）`)
    const cssRatio = bgP && fgP ? contrast(bgP.rgb, fgP.rgb) : 0
    // ⚠️ 底色透明时 bgP.rgb 会被解析成 [0,0,0]，这条对比度就没意义了（会假绿）——
    // 所以它只当"底色不透明时"的补充，透明的情形由 P1 兜住，这里标注出来免得误读。
    check(`[${themeLabel}] P2 option 文字/底色 CSS 对比度 >= 4.5`,
      cssRatio >= 4.5,
      `${cssRatio.toFixed(2)}:1  (${css.color} on ${css.bg})${opaque ? '' : '  ⚠️ 底色透明，本值无意义，看 P1'}`)

    // ---- P3/P4：真机像素
    // 先拍"未打开"时同一区域，作为对照：文字色若在关闭态也出现，就说明这几像素不是弹出层给的
    const rect = {
      x: Math.max(0, Math.round(box.x)),
      y: Math.round(box.y + box.height),
      width: Math.round(box.width),
      height: 70,
    }
    const textRgb = fgP ? fgP.rgb : null
    const closedShot = await popupStats(decoder, await page.screenshot(), rect, textRgb)

    await sel.click()
    await sleep(600)
    const open = await page.evaluate(() => document.querySelector('.kb__select').matches(':open'))
    const st = await popupStats(decoder, await page.screenshot(), rect, textRgb)

    check(`[${themeLabel}] P3 弹出层真的打开了`, open)
    check(`[${themeLabel}] P3 采样区里找回了 option 的文字色（且关闭态没有），证明文字真的画在这里`,
      st.near >= 5 && st.near > closedShot.near,
      `关闭态 ${closedShot.near} 像素 → 打开后 ${st.near} 像素  匹配 ${css.color}`)

    // 实测底色 × option 的 computed 文字色 —— 这才是"会被画上去的组合"
    const pxRatio = textRgb ? contrast(st.bg, textRgb) : 0
    check(`[${themeLabel}] P4 实测底色 与 option 文字色 对比度 >= 4.5`,
      pxRatio >= 4.5,
      `${pxRatio.toFixed(2)}:1  实拍底色#${hex(st.bg)} on 文字${css.color} (${st.w}x${st.h})`)

    await page.keyboard.press('Escape')
    await sleep(300)
    return { cssBg: css.bg, bgHex: '#' + hex(st.bg), pxRatio, box }
  }

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.kb__select', { timeout: 20000 })
    await sleep(800)

    // ---- 深色主题
    const themeNow = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    check('前置：应用当前处于深色主题', themeNow === 'dark', `data-theme=${themeNow}`)
    const dark = await measure('深色')

    // ---- 浅色主题：只摘掉属性，不写回配置
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
    await sleep(400)
    const light = await measure('浅色')

    // 深色下必须是深底浅字，浅色下必须反过来 —— 防止"两边都写成同一个色"蒙过对比度断言
    const darkIsDark = relLum(dark.bgHex.match(/\w\w/g).map((h) => parseInt(h, 16))) < 0.2
    const lightIsLight = relLum(light.bgHex.match(/\w\w/g).map((h) => parseInt(h, 16))) > 0.6
    check('P5 深色主题下弹出层是深底', darkIsDark, `实拍底色 ${dark.bgHex}`)
    check('P5 浅色主题下弹出层是浅底', lightIsLight, `实拍底色 ${light.bgHex}`)
  } catch (err) {
    check('脚本异常', false, String(err?.message || err))
  } finally {
    await browser.close()
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n用例 ${results.length}，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  failed.forEach((f) => console.log(`  - ${f.name} ${f.extra}`))
  const real = consoleErrors.filter((e) => !/Failed to fetch|获取当前目录失败|404|net::ERR/.test(e))
  console.log(`控制台错误(过滤噪音): ${real.length}`)
  process.exit(failed.length ? 1 : 0)
}

main()

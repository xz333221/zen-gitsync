/**
 * 顶栏 CPU / MEM 进度条 —— 必须**常驻**，且水位与读数一致。
 *
 * 守的契约（对应 App.vue 的 `.header-monitor`）：
 *   H1  两条读数各带一条 `.header-monitor__bar`，**任何占用下都在**。
 *       2026-10-05 评审曾把条改成"低于 70% 不画"，理由是同屏出现第二套进度条
 *       （第一套是项目进度）；用户当轮推翻：「右侧这个还把之前的进度条展示出来吧」
 *       —— 数字 8 和 61 在 11px 灰字下是两串同形符号，**条长才是水位**，
 *       藏到 70% 才给等于"只在出问题时才提供用来看出问题的东西"。
 *       ⚠️ 这条不再回退：要拿掉条必须先说服用户，别再拿 P2-12 当依据。
 *   H2  填充宽度 = 24px 轨道 × 读数（±3px），并且真的画出来了（不透明、与轨道不同色）。
 *   H3  低于阈值走 `--role-done-bar`（绿），**不上琥珀**；数字本身不上色。
 *       实心色块走 `--role-*-bar` 而非 `--color-success` 的口径见
 *       docs/ui-audit/README.md 第四轮（实心块不继承文字的对比度预算）。
 *
 * ⚠️ 本脚本**没有 `--reverse`**：要"反向"就得把源码里的 v-if 注回去（改源文件），
 *   不是注一段旧 CSS 能做到的；而 H1 断言的正是"元素在不在"，
 *   元素不在时 waitForSelector 会直接超时失败 —— 它天然会红，不需要稻草人。
 *
 * 用户报的原始现场是 CPU 8% / MEM 61%（截图），所以第二段用 stub 把这一帧复现出来，
 * 而不是碰运气等机器闲下来。
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544'
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'zen-header-monitor')

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}

// 浅色档 --role-done-bar = color-mix(hue 70%, ink)，落在 color(srgb 0.04x 0.6x 0.4x)
const GREEN = /^color\(srgb 0\.0[0-9]+ 0\.6[0-9]+ 0\.4[0-9]+/
const AMBER = /^color\(srgb 0\.8[0-9]+ 0\.5[0-9]+ 0\.1[0-9]+/
const isGray = (c) => {
  const [r, g, b] = (c?.match(/\d+/g) ?? []).map(Number)
  return [r, g, b].every((n) => Number.isFinite(n)) && Math.max(r, g, b) - Math.min(r, g, b) <= 8
}

const readHeader = (page) =>
  page.evaluate(() => {
    const items = [...document.querySelectorAll('.header-monitor__item')]
    return items.map((it) => {
      const bar = it.querySelector('.header-monitor__bar')
      const fill = it.querySelector('.header-monitor__fill')
      const value = it.querySelector('.header-monitor__value')
      const cs = fill ? getComputedStyle(fill) : null
      const barCs = bar ? getComputedStyle(bar) : null
      return {
        label: it.querySelector('.header-monitor__label')?.textContent,
        value: value?.textContent?.trim(),
        percent: parseFloat(value?.textContent ?? ''),
        valueColor: value ? getComputedStyle(value).color : null,
        hasBar: !!bar,
        barWidth: bar ? bar.getBoundingClientRect().width : 0,
        barBg: barCs ? barCs.backgroundColor : null,
        fillWidth: fill ? fill.getBoundingClientRect().width : 0,
        fillBg: cs ? cs.backgroundColor : null,
        fillOpacity: cs ? cs.opacity : null,
      }
    })
  })

const assertGeometry = (data, tag) => {
  check(`${tag} · 两条读数都在`, data.length === 2, `count=${data.length}`)
  for (const d of data) {
    check(`${tag} · ${d.label} 有进度条（H1）`, d.hasBar)
    const expected = (d.barWidth * Math.min(d.percent, 100)) / 100
    check(
      `${tag} · ${d.label} 填充宽度 = 轨道 × 读数（H2）`,
      Math.abs(d.fillWidth - expected) <= 3,
      `${d.percent}% → fill=${d.fillWidth.toFixed(1)}px 期望 ${expected.toFixed(1)}px（轨道 ${d.barWidth}px）`,
    )
    check(
      `${tag} · ${d.label} 填充真的画出来了（H2）`,
      d.fillBg !== 'rgba(0, 0, 0, 0)' && d.fillOpacity === '1' && d.fillBg !== d.barBg,
      `fill=${d.fillBg} track=${d.barBg}`,
    )
  }
}

;(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const browser = await chromium.launch()

  // ── 场景 1：真实读数（可能是任意一档）──
  const page = await browser.newPage({ viewport: { width: 1440, height: 300 } })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.header-monitor__fill', { timeout: 60000 })
  await page.waitForTimeout(1500)
  const real = await readHeader(page)
  console.log('── 场景 1：真实读数 ──')
  assertGeometry(real, 'real')
  await page.screenshot({ path: path.join(SHOT_DIR, 'real.png'), clip: { x: 900, y: 0, width: 540, height: 60 } })

  // ── 场景 2：复现用户截图那一帧（CPU 8% / MEM 61%）──
  // 低于阈值必须**有**条、走绿档 —— 这正是上一版塌掉的那一档。
  const page2 = await browser.newPage({ viewport: { width: 1440, height: 300 } })
  await page2.route('**/api/monitor/system', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          cpu: { model: 'stub', cores: 8, usage: 8 },
          memory: { total: 16e9, used: 9.76e9, free: 6.24e9, usagePercent: 61 },
        },
      }),
    }),
  )
  await page2.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page2.waitForSelector('.header-monitor__fill', { timeout: 60000 })
  await page2.waitForTimeout(1200)
  const low = await readHeader(page2)
  console.log('── 场景 2：stub 复现用户截图那一帧（8% / 61%）──')
  assertGeometry(low, 'low')
  check('low · CPU 读数就是 8%', low[0]?.percent === 8, `got ${low[0]?.percent}`)
  check('low · MEM 读数就是 61%', low[1]?.percent === 61, `got ${low[1]?.percent}`)
  for (const d of low) {
    check(`low · ${d.label} 低于阈值走绿档不是琥珀（H3）`, GREEN.test(d.fillBg), d.fillBg)
  }
  check(
    'low · 数字低于阈值不上色（H3）',
    low.every((d) => isGray(d.valueColor)) && low[0].valueColor === low[1].valueColor,
    low.map((d) => `${d.label}=${d.valueColor}`).join(' '),
  )
  await page2.screenshot({ path: path.join(SHOT_DIR, 'low.png'), clip: { x: 900, y: 0, width: 540, height: 60 } })

  // ── 场景 3：越阈值（CPU 77% / MEM 95%）必须转琥珀 / 红 ──
  const page3 = await browser.newPage({ viewport: { width: 1440, height: 300 } })
  await page3.route('**/api/monitor/system', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          cpu: { model: 'stub', cores: 8, usage: 77 },
          memory: { total: 16e9, used: 15.2e9, free: 0.8e9, usagePercent: 95 },
        },
      }),
    }),
  )
  await page3.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page3.waitForSelector('.header-monitor__fill', { timeout: 60000 })
  await page3.waitForTimeout(1200)
  const high = await readHeader(page3)
  console.log('── 场景 3：stub 越阈值（77% / 95%）──')
  assertGeometry(high, 'high')
  check('high · CPU 77% 走琥珀档', AMBER.test(high[0]?.fillBg), high[0]?.fillBg)
  check('high · MEM 95% 不再是绿/琥珀', !GREEN.test(high[1]?.fillBg), high[1]?.fillBg)
  // 数字上色以场景 2 的灰为基线比，不硬写 rgb：要守的是"越阈值才变色"
  check(
    'high · 数字越过阈值才上色（H3）',
    high.every((d) => d.valueColor !== low[0].valueColor),
    `neutral=${low[0].valueColor} → ${high.map((d) => `${d.label}=${d.valueColor}`).join(' ')}`,
  )
  await page3.screenshot({ path: path.join(SHOT_DIR, 'high.png'), clip: { x: 900, y: 0, width: 540, height: 60 } })

  await browser.close()
  const bad = results.filter((r) => !r.ok).length
  console.log(`\n用例 ${results.length}，通过 ${results.length - bad}，失败 ${bad}`)
  console.log(`截图: ${SHOT_DIR}`)
  process.exit(bad === 0 ? 0 : 1)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})

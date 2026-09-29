/**
 * 看板卡片首行（色标 / 标题 / 时间）的几何断言 + 截图。
 *
 *   A 每张卡的标题都只有一行（盒高 ≈ 行高）
 *   B 被截断的标题真的打出了省略号（scrollWidth > clientWidth —— 不是被硬裁）
 *   C 项目色标无一枚被压窄（clientWidth >= scrollWidth）
 *   D 色标 / 时间与标题**同一条文字基线**（逐卡 < 1px）
 *   E 反证口：把标题打回 -webkit-box + line-clamp:2，标题必定变回两行（证明 A 测的是这条改动）
 *
 * ⚠️ D 不能用「盒子中心」比 —— 三者盒子高天生不同（胶囊 18px / 标题 21px / 时间 13px），
 *    基线对齐时盒心必然差 ~2px（实测 1.75px = 盒高差一半）。必须先按字体度量把
 *    「文字基线 y」还原出来再比，否则会把对齐正确判成失败（第一版就踩了这个）。
 *
 * ⚠️ C 是这张卡**最容易静默回归**的一条：色标被压窄只发生在渲染上（`flex-basis: auto`
 *    时标题基准 = 整段文字 max-content，负空间按基准比例分摊，把基准只有几十 px 的
 *    色标连累缩成 `zen-…`），"在不在同一行"之类的断言会全绿放过。
 *
 * 依赖：dev server 已在 5544 上跑（`ZEN_BASE` 可覆盖），本机装了 Chrome。
 *
 * 用法：
 *   npm run verify:wb-card-row1              正常跑，A~D 全绿才算过
 *   npm run verify:wb-card-row1 -- --reverse  反证：E（A 必定变红）必须成立
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544'
const CHROME = process.env.ZEN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SHOT = path.join(os.tmpdir(), 'wb-card-row1')
const REVERSE = process.argv.includes('--reverse')

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function measure(page) {
  return page.evaluate(() => {
    /** 字体度量 + 行盒矩形 → 文字基线的 y（像素，视口坐标） */
    const ctx = document.createElement('canvas').getContext('2d')
    const baselineFromLineBox = (el, lineRect) => {
      const cs = getComputedStyle(el)
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      const m = ctx.measureText(el.textContent || 'x')
      const ascent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent
      const descent = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent
      const lh = parseFloat(cs.lineHeight) || (ascent + descent)
      const halfLeading = (lh - (ascent + descent)) / 2
      return lineRect.top + halfLeading + ascent
    }
    /** 元素**首行文字**的行盒（Range 只框文字节点，不含 border/padding） */
    const firstLineRect = (el) => {
      if (!el || !el.firstChild) return null
      const r = document.createRange()
      r.selectNodeContents(el)
      const rects = Array.from(r.getClientRects())
      if (!rects.length) return null
      // ⚠️ 取 top 最小的那个（= 首行），不能取最宽的：标题折两行时第二行可能更宽，
      //    取最宽会拿到第二行的行盒，基线差就凭空多出整整一行（实测 42.3px）——
      //    反证模式里这个错会把"对齐正确"报成错。
      let best = rects[0]
      for (const b of rects) if (b.top < best.top) best = b
      return best
    }

    const cards = Array.from(document.querySelectorAll('.kb-card'))
    const out = []
    for (const c of cards) {
      const ti = c.querySelector('.kb-card__title')
      const ch = c.querySelector('.kb-card__project-chip')
      const tm = c.querySelector('.kb-card__time')
      if (!ti) continue
      const cs = getComputedStyle(ti)
      const tb = ti.getBoundingClientRect()
      const lh = parseFloat(cs.lineHeight) || 0
      const lineCount = lh ? Math.round(tb.height / lh) : 1
      const tr = firstLineRect(ti)
      const baseT = tr ? baselineFromLineBox(ti, tr) : null
      const chipRect = ch ? firstLineRect(ch) : null
      const timeRect = tm ? firstLineRect(tm) : null
      const baseC = ch && chipRect ? baselineFromLineBox(ch, chipRect) : null
      const baseM = tm && timeRect ? baselineFromLineBox(tm, timeRect) : null
      out.push({
        title: (ti.textContent || '').trim().slice(0, 18),
        lineCount,
        boxH: +tb.height.toFixed(2),
        lineH: +lh.toFixed(2),
        singleLine: lineCount === 1,
        ellipsized: ti.scrollWidth > ti.clientWidth + 1,
        scrollW: ti.scrollWidth,
        clientW: ti.clientWidth,
        chip: ch ? { t: ch.textContent.trim(), cw: ch.clientWidth, sw: ch.scrollWidth, clipped: ch.clientWidth < ch.scrollWidth } : null,
        baseDelta: (baseC != null && baseM != null && baseT != null)
          ? +Math.max(Math.abs(baseC - baseT), Math.abs(baseM - baseT)).toFixed(2)
          : null,
      })
    }
    // 反事实：盒心对齐会让字与字差多少（盒高差的一半）
    const f = cards.find((c) => c.querySelector('.kb-card__project-chip') && c.querySelector('.kb-card__title') && c.querySelector('.kb-card__time'))
    let centerDelta = null
    if (f) {
      const g = (s) => f.querySelector(s).getBoundingClientRect().height
      centerDelta = +(Math.max(Math.abs((g('.kb-card__project-chip') - g('.kb-card__title')) / 2), Math.abs((g('.kb-card__time') - g('.kb-card__title')) / 2))).toFixed(2)
    }
    return { cards: out, count: out.length, centerDelta }
  })
}

async function main() {
  fs.rmSync(SHOT, { recursive: true, force: true })
  fs.mkdirSync(SHOT, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox'],
  })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })).newPage()
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)))
  try {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('wb.boardView.v1', 'kanban')
        localStorage.setItem('wb.boardProject.v1', '')   // '' = 全部项目（色标才渲染）
      } catch { /* ignore */ }
    })
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.board', { timeout: 15000 })
    await page.locator('.proj-item--all').first().click()
    await page.waitForFunction(() => document.querySelectorAll('.kb-card__project-chip').length > 0, { timeout: 20000 })
    await sleep(600)

    if (REVERSE) {
      await page.addStyleTag({
        content: `.kb-card__title {
          white-space: normal !important;
          display: -webkit-box !important;
          -webkit-line-clamp: 2 !important;
          line-clamp: 2 !important;
          -webkit-box-orient: vertical !important;
          word-break: break-word !important;
        }`,
      })
      await sleep(500)
    }

    const { cards, count, centerDelta } = await measure(page)
    console.log('[探针] 卡片数', count, '· 若改回盒心对齐，字与字会偏', centerDelta, 'px')

    const row = (c) => `${c.title}（${c.lineCount} 行 / 盒高 ${c.boxH} vs 行高 ${c.lineH}`
      + `${c.ellipsized ? ` / 省略 ${c.clientW}<${c.scrollW}` : ' / 未截'}`
      + `${c.chip ? ` / 色标 ${c.chip.t}:${c.chip.cw}${c.chip.clipped ? '<' + c.chip.sw : '='}` : ''}`
      + `${c.baseDelta != null ? ` / 基线差 ${c.baseDelta}` : ''}）`
    for (const c of cards.slice(0, 8)) console.log('   ', row(c))

    const multi = cards.filter((c) => !c.singleLine)
    const ellipsized = cards.filter((c) => c.ellipsized)
    const clippedChips = cards.filter((c) => c.chip && c.chip.clipped)
    const baseDeltas = cards.filter((c) => c.baseDelta != null).map((c) => c.baseDelta)
    const worstBase = baseDeltas.length ? Math.max(...baseDeltas) : NaN

    if (REVERSE) {
      check('E 反证：打回 clamp:2 之后标题必定变回两行（A 会变红）',
        multi.length > 0,
        multi.length ? `多行标题 ${multi.length}/${count} 张，例：${row(multi[0])}` : '竟然全是一行 —— A 没测到点子上')
    } else {
      check('A 每张卡的标题都只有一行', multi.length === 0,
        multi.length ? `多行 ${multi.length}/${count}：${multi.slice(0, 3).map(row).join(' | ')}` : `${count}/${count} 张全部单行（盒高均 = 行高 21px）`)
      check('B 被截断的标题真的出了省略号（不是硬裁）', ellipsized.length > 0,
        `${ellipsized.length}/${count} 张被截：${ellipsized.slice(0, 3).map((c) => `${c.title} ${c.clientW}<${c.scrollW}`).join(' | ') || '一张都没被截'}`)
      check('C 项目色标无一枚被压窄', clippedChips.length === 0,
        clippedChips.length ? clippedChips.map((c) => `${c.chip.t} ${c.chip.cw}<${c.chip.sw}`).join(', ') : '全部完整')
      check('D 色标 / 时间与标题同一条文字基线（逐卡 < 1px）', Number.isFinite(worstBase) && worstBase < 1,
        `最差 ${worstBase}px（对比：改回盒心对齐会偏 ${centerDelta}px）`)
    }

    await page.locator('.board__main').screenshot({ path: path.join(SHOT, REVERSE ? 'board-reverse.png' : 'board.png') })
    const card = page.locator('.kb-card').filter({ has: page.locator('.kb-card__project-chip') }).first()
    if (await card.count()) await card.screenshot({ path: path.join(SHOT, REVERSE ? 'card-reverse.png' : 'card.png') })
    console.log('[探针] 截图:', SHOT)
  } catch (err) {
    check('脚本异常', false, String(err?.message || err))
  } finally {
    await browser.close()
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${REVERSE ? '[reverse] ' : ''}用例 ${results.length}，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  process.exit(failed.length ? 1 : 0)
}

main()

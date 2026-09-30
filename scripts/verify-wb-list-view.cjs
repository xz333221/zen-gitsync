/**
 * 编排台列表视图：两列露不露得出来 + 行序对不对。
 *
 *   A 表格不横向溢出（table 宽 ≤ 容器宽）—— 这是两列能露出来的**前提**
 *   B 「状态」「时间」两列表头都落在容器的可视范围内
 *   C 每一行的时间单元格都非空（口径 = 看板卡片的 cardTime）
 *   D 行序按时间倒序（最新的在最上边），且每一行的显示时间与排序键一致
 *   E 反证口：把 table-layout 打回 auto，A/B 必定变红（证明这两条测的是同一处改动）
 *
 * ⚠️ A 是这个问题里最静默的一条：默认的 table-layout: auto 按**内容**算列宽，
 *    「任务」格里有 nowrap 正文时整张表会被撑到容器之外，右边两列被推出屏幕 ——
 *    DOM 里 querySelector 照样量得到、断言也照样"存在"，肉眼里却什么都没有。
 *    所以必须断言**几何**（右边界 ≤ 容器右边界），不能只断言元素存在。
 *
 * 依赖：dev server 已在 5544 上跑（`ZEN_BASE` 可覆盖），本机装了 Chrome。
 *
 * 用法：
 *   npm run verify:wb-list-view               正常跑，A~D 全绿才算过
 *   npm run verify:wb-list-view -- --reverse  反证：E（A/B 必定变红）必须成立
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const CHROME = process.env.ZEN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SHOT = path.join(os.tmpdir(), 'wb-list-view')
const REVERSE = process.argv.includes('--reverse')

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function measure(page) {
  return page.evaluate(() => {
    const wrap = document.querySelector('.kb__table-wrap')
    const table = document.querySelector('.kb-table')
    const wrapBox = wrap.getBoundingClientRect()
    const ths = [...document.querySelectorAll('.kb-table__th')].map((e) => {
      const r = e.getBoundingClientRect()
      return { t: e.textContent.trim(), right: r.right, w: r.width }
    })
    const rows = [...document.querySelectorAll('.kb-table__row')].map((r) => {
      const tds = [...r.querySelectorAll('.kb-table__td')]
      const name = tds[0]?.querySelector('.kb-table__name')?.textContent.trim().slice(0, 14) || ''
      const time = (tds[2]?.textContent || '').trim()
      const status = (tds[1]?.textContent || '').trim()
      return { name, status, time }
    })
    return {
      wrapW: Math.round(wrap.clientWidth),
      scrollW: wrap.scrollWidth,
      tableW: Math.round(table.getBoundingClientRect().width),
      wrapRight: Math.round(wrapBox.right),
      ths,
      rows,
    }
  })
}

/** "12 天前" / "19 分钟前" → 近似分钟数；认不出的返回 null（不参与排序断言） */
function toMinutes(text) {
  const m = /^(\d+)\s+(天|小时|分钟)/.exec(text)
  if (!m) return null
  const n = Number(m[1])
  if (m[2] === '天') return n * 1440
  if (m[2] === '小时') return n * 60
  return n
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
        localStorage.setItem('wb.boardView.v1', 'list')
        localStorage.setItem('wb.boardProject.v1', '')   // '' = 全部项目
      } catch { /* ignore */ }
    })
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 30000 })
    await sleep(1500)
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.kb__table-wrap', { timeout: 30000 })
    await sleep(1500)

    if (REVERSE) {
      await page.addStyleTag({ content: '.kb-table { table-layout: auto !important; }' })
      await sleep(600)
    }

    const d = await measure(page)
    console.log(`[探针] 容器 ${d.wrapW}px · 表格 ${d.tableW}px · 滚动宽 ${d.scrollW}px · ${d.rows.length} 行`)
    console.log('[探针] 表头右边界:', d.ths.map((t) => `${t.t}@${t.right}`).join(' | '), `容器右边界 ${d.wrapRight}`)

    const overflow = d.tableW > d.wrapW + 1
    const offscreen = d.ths.filter((t) => t.right > d.wrapRight + 1)
    const emptyTime = d.rows.filter((r) => !r.time)

    // 倒序（最新的在最上边）："x 分钟前"的 x 越小越新，所以**后**一行的 x 必须 >= 前一行。
    // x 更大 = 更旧，出现在后面才对；x 更小（更新的）却排在后面 = 逆序。
    // 「刚刚」这类没有数字的返回 null，成对跳过（它们本来就该在最上，不参与比较）。
    const pairs = []
    for (let i = 0; i < d.rows.length - 1; i++) {
      const a = toMinutes(d.rows[i].time)
      const b = toMinutes(d.rows[i + 1].time)
      if (a == null || b == null) continue
      if (a > b) pairs.push(`${d.rows[i].name} ${d.rows[i].time} 竟然排在更旧的 ${d.rows[i + 1].name} ${d.rows[i + 1].time} 后面`)
    }

    if (REVERSE) {
      check('E 反证：打回 table-layout: auto 之后表格必定横向溢出（A/B 会变红）', overflow,
        overflow ? `表格 ${d.tableW}px > 容器 ${d.wrapW}px` : '竟然没溢出 —— A/B 没测到点子上')
      check('E 反证：溢出时右列必定被推出可视区', offscreen.length > 0,
        offscreen.length ? `${offscreen.length} 个表头右边界超出容器：${offscreen.map((t) => t.t).join(', ')}` : '右列竟然还在屏内')
    } else {
      check('A 表格不横向溢出（两列能露出来的前提）', !overflow,
        overflow ? `表格 ${d.tableW}px > 容器 ${d.wrapW}px` : `${d.tableW}px ≤ ${d.wrapW}px`)
      check('B 「状态」「时间」两列都在可视区内', offscreen.length === 0,
        offscreen.length ? `${offscreen.map((t) => `${t.t} 右边界 ${t.right} > ${d.wrapRight}`).join('; ')}` : `表头右边界 ${d.wrapRight} 以内`)
      check('C 每行都有时间（口径 = 看板卡片 cardTime）', emptyTime.length === 0,
        emptyTime.length ? `${emptyTime.length}/${d.rows.length} 行为空，例：${emptyTime[0].name}` : `${d.rows.length}/${d.rows.length} 行非空`)
      check('D 行序按时间倒序（最新的在最上边）', pairs.length === 0,
        pairs.length ? `${pairs.length} 处逆序，例：${pairs[0]}` : d.rows.slice(0, 3).map((r) => `${r.time}`).join(' → '))
    }

    await page.screenshot({ path: path.join(SHOT, REVERSE ? 'list-reverse.png' : 'list.png') })
    console.log('[截图]', path.join(SHOT, REVERSE ? 'list-reverse.png' : 'list.png'))

    const failed = results.filter((r) => !r.ok)
    console.log(failed.length ? `\n✗ ${failed.length}/${results.length} 条未通过` : `\n✓ ${results.length}/${results.length} 条全部通过`)
    process.exitCode = failed.length ? 1 : 0
  } finally {
    await browser.close()
  }
}
main().catch((e) => { console.error(e); process.exit(1) })

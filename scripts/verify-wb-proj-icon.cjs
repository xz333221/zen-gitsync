/**
 * 左栏「项目列表」的项目图标（favicon）—— 浏览器交互验证。
 *
 * 守的契约（对应 WorkbenchProjectPanel.vue 的图标位 + 后端 /api/workbench/project-icon）：
 *   K1 服务端给了 iconUrl 的行渲染 <img>，且**图真的加载出来了**（naturalWidth > 0）——
 *      只断言 <img> 存在是假绿：src 指向一个 404 时元素照样在，只是屏幕上一片空白。
 *   K2 有图标的行不再画文件夹图标（两者互斥，不能叠着）
 *   K3 没图标（iconUrl = null）的行退回文件夹图标，且没有 <img>
 *   K4 图标全部 404 时（服务端重启 / 文件被删），行**当场退回**文件夹图标 ——
 *      不许留破图。这一条用 route 挡掉端点来造，是 K1 的反向对照。
 *   K5 几何：图标 14×14；有图标与没图标的行，项目名左边缘对齐（宽度不一致会让名字左右跳）
 *   K6 端点契约：真图标返回 200 + 图片 Content-Type + 长缓存；不在清单里的路径 404
 *      （白名单，不能变成"任意目录里 favicon.* 的读取通道"）
 *
 * 为什么用**真实项目清单**而不是夹具：这个功能的输入就是用户机器上那些项目的
 * favicon，夹具只能证明"我造的 JSON 能渲染"。所以正向用例吃真数据（本机 32 个项目里
 * 一半以上带图标），兜底用例用 route 挡端点造。
 *
 * 反向验证（撤掉实现后哪几条会红）：
 *   · 模板里把 img 的 v-if 改成 false（永远画文件夹图标）→ K1 / K2 红
 *   · 去掉 @error="markIconFailed" → K4 红（行上留着破图）
 *   · CSS 里 .proj-item__icon--img 不写 width/height → K5 红（图标按原始尺寸铺开）
 *   · 后端路由去掉 isKnownProjectKey 那道门 → K6c 红（任意路径都能读）
 */
const path = require('node:path')
// playwright 装在 src/ui/client 下，把它的 node_modules 挂进解析路径，脚本才能独立跑
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544' // 前端
const API = process.env.ZEN_API || 'http://127.0.0.1:5545' // 后端
const SHOT = process.env.ZEN_SHOT || ''

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function waitUntil(fn, timeout = 15000, interval = 150) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true
    await sleep(interval)
  }
  return false
}

/** 读一屏项目行：图标形态 + 几何 */
const obs = (page) => page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('.proj-item'))
    .filter(n => !n.classList.contains('proj-item--all'))
  return rows.map((r) => {
    const img = r.querySelector('img.proj-item__icon--img')
    const icon = r.querySelector('.proj-item__icon')
    const nameEl = r.querySelector('.proj-item__name')
    const rect = icon ? icon.getBoundingClientRect() : null
    return {
      name: nameEl ? (nameEl.textContent || '').trim() : '',
      hasImg: !!img,
      hasFolder: !!r.querySelector('.el-icon.proj-item__icon'),
      src: img ? (img.getAttribute('src') || '') : '',
      loaded: img ? !!(img.complete && img.naturalWidth > 0) : null,
      iconW: rect ? Math.round(rect.width) : 0,
      iconH: rect ? Math.round(rect.height) : 0,
      nameLeft: nameEl ? Math.round(nameEl.getBoundingClientRect().left) : 0,
    }
  })
})

async function openBoard(page) {
  await page.waitForSelector('.activity-bar', { timeout: 20000 })
  await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
  await page.waitForSelector('.board', { timeout: 15000 })
  await page.waitForSelector('.proj-item', { timeout: 15000 })
  // 等一轮轮询把图标地址带回来（首屏那次 /projects 通常已经带了，这里只是兜底）
  await waitUntil(async () => (await obs(page)).length > 0)
}

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  try {
    // ── 服务端契约（先测，不依赖页面） ──────────────────────────────
    const list = await fetch(`${API}/api/workbench/projects`, { cache: 'no-store' }).then(r => r.json())
    const withIcon = (list.projects || []).filter(p => p.iconUrl)
    const withoutIcon = (list.projects || []).filter(p => !p.iconUrl)
    log(`真实清单：${(list.projects || []).length} 个项目，其中 ${withIcon.length} 个带图标`)
    check('K0a 真实清单里既有带图标的项目、也有没图标的项目（否则下面的用例是空跑）',
      withIcon.length > 0 && withoutIcon.length > 0,
      `带图标 ${withIcon.length} / 没图标 ${withoutIcon.length}`)

    const local = withIcon.find(p => p.iconUrl.startsWith('/api/'))
    const res = await fetch(`${API}${local.iconUrl}`)
    const buf = Buffer.from(await res.arrayBuffer())
    check('K6a 本地图标端点：200 + 图片 Content-Type + 长缓存',
      res.status === 200
      && /^image\//.test(res.headers.get('content-type') || '')
      && /max-age=\d+/.test(res.headers.get('cache-control') || ''),
      `${res.status} ${res.headers.get('content-type')} ${res.headers.get('cache-control')} ${buf.length}B`)
    check('K6b 取到的是真图片字节（不是一段 HTML 错误页）',
      buf.length > 0 && !buf.subarray(0, 64).toString('utf8').toLowerCase().includes('<html'),
      `${buf.length}B`)

    const outsider = await fetch(`${API}/api/workbench/project-icon?path=${encodeURIComponent('C:\\Windows')}`)
    check('K6c 不在清单里的路径被挡（404，不是任意路径读盘通道）', outsider.status === 404, `status=${outsider.status}`)

    // ── 浏览器：正常形态 ────────────────────────────────────────────
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await openBoard(page)
    let rows = await obs(page)

    const iconRows = rows.filter(r => r.hasImg)
    const folderRows = rows.filter(r => !r.hasImg)
    check('K1a 有图标地址的行渲染出 <img class="proj-item__icon--img">',
      iconRows.length > 0, `${iconRows.length} 行`)
    // 图是异步下载的：行一出现就断言"加载完了"必然红（那是探针的错，不是功能的错），
    // 先等它们落地，再判有没有 404 破图。
    await waitUntil(async () => (await obs(page)).filter(r => r.hasImg).every(r => r.loaded === true), 10000)
    rows = await obs(page)
    const iconRows2 = rows.filter(r => r.hasImg)
    check('K1b 这些 <img> 真的加载出来了（naturalWidth > 0，不是 404 破图）',
      iconRows2.length > 0 && iconRows2.every(r => r.loaded === true),
      iconRows2.filter(r => !r.loaded).map(r => r.name).join(',') || '全部已加载')
    check('K2 有图标的行不再画文件夹图标（两者互斥）',
      iconRows2.every(r => !r.hasFolder))
    check('K3 没有图标地址的行退回文件夹图标，且没有 <img>',
      folderRows.length > 0 && folderRows.every(r => r.hasFolder && !r.hasImg),
      `${folderRows.length} 行退回文件夹图标`)
    check('K6d <img> 的 src 指向本站图标端点（或项目声明的远程地址）',
      iconRows2.every(r => r.src.startsWith('/api/workbench/project-icon') || /^https?:/.test(r.src)),
      iconRows2.map(r => r.src.slice(0, 46)).slice(0, 3).join(' | '))

    // ── K5 几何：图标尺寸与文件夹图标一致，名字左边缘对齐 ────────────
    // 不钉死具体像素（那会随 --font-size-mid 变），钉的是"两种形态同尺寸"这个契约。
    const sizes = new Set(rows.map(r => `${r.iconW}x${r.iconH}`))
    const one = [...sizes][0] || ''
    check('K5a 有图标与没图标的行，图标是同一个尺寸（否则项目名会左右跳）',
      sizes.size === 1 && /^(\d+)x\1$/.test(one) && Number(one.split('x')[0]) >= 12,
      `实际尺寸 ${[...sizes].join(' / ')}`)
    const lefts = new Set(rows.map(r => r.nameLeft))
    check('K5b 有图标与没图标的行，项目名左边缘对齐',
      lefts.size === 1, `左边缘 ${[...lefts].join(' / ')}`)

    if (SHOT) {
      // 把鼠标挪开再截图：点过活动栏之后那枚按钮的 tooltip 会一直挂在左栏上挡住几行
      await page.mouse.move(900, 600)
      await sleep(400)
      const panel = page.locator('.proj').first()
      const target = (await panel.count()) ? panel : page.locator('.proj-item').first()
      await target.screenshot({ path: SHOT }).catch(() => page.screenshot({ path: SHOT }))
      log(`截图：${SHOT}`)
    }

    // ── K4 反向：图标端点全 404 → 必须当场退回文件夹图标 ──────────────
    await page.route('**/api/workbench/project-icon**', (route) => route.fulfill({ status: 404, body: '' }))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openBoard(page)
    await waitUntil(async () => (await obs(page)).every(r => !r.hasImg), 8000)
    rows = await obs(page)
    check('K4 图标全部 404 时每一行都退回文件夹图标（不留破图）',
      rows.length > 0 && rows.every(r => !r.hasImg && r.hasFolder),
      `仍有 img 的行：${rows.filter(r => r.hasImg).map(r => r.name).join(',') || '无'}`)
    await page.unroute('**/api/workbench/project-icon**')
  } catch (err) {
    check('脚本异常', false, String(err?.message || err))
  } finally {
    await browser.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n用例 ${results.length}，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  failed.forEach(f => console.log(`  - ${f.name} ${f.extra}`))
  const real = consoleErrors.filter(e => !/Failed to fetch|获取当前目录失败|net::ERR|404/.test(e))
  console.log(`控制台错误(过滤噪音): ${real.length}`)
  real.slice(0, 8).forEach(e => console.log('  ! ' + e.slice(0, 220)))
  if (pageErrors.length) {
    console.log(`页面异常: ${pageErrors.length}`)
    pageErrors.slice(0, 4).forEach(e => console.log('  ! ' + e.slice(0, 220)))
  }
  log(`合计 ${failed.length === 0 && real.length === 0 && pageErrors.length === 0 ? 'PASS' : 'FAIL'}`)
  process.exit(failed.length ? 1 : 0)
}

main()

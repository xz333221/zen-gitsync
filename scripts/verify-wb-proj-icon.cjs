/**
 * 项目图标（favicon）—— 浏览器交互验证。三处消费点：左栏项目列表 + 「常用目录」卡片
 * + 顶栏目录选择器（当前项目图标）。
 *
 * 守的契约：
 *   左栏（WorkbenchProjectPanel）
 *   K1 服务端给了 iconUrl 的行渲染 <img>，且**图真的加载出来了**（naturalWidth > 0）——
 *      只断言 <img> 存在是假绿：src 指向一个 404 时元素照样在，只是屏幕上一片空白。
 *   K2 有图标的行不再画文件夹图标（两者互斥）
 *   K3 没图标（iconUrl = null）的行退回文件夹图标，且没有 <img>
 *   K4 图标全部 404 时（服务端重启 / 文件被删），行**当场退回**文件夹图标 ——
 *      不许留破图。这一条用 route 挡掉端点来造，是 K1 的反向对照。
 *   K5 几何：图标槽 32px 且两种形态同尺寸、项目名左边缘对齐；**图标真的占两行**
 *      （高度≈row1.top→row2.bottom 那一段）；文件夹字形比槽小（"这儿没图标"要更轻）
 *   常用目录（RecentDirectoriesList，弹窗里的卡片）
 *   D1/D2 有图标的卡片渲染 <img> 且真的加载出来
 *   D3 图标槽 38px，两种形态同尺寸、名字左边缘对齐
 *   D4 端点全 404 时每张卡都退回文件夹字形（与 K4 同一个兜底，另一处消费点）
 * 顶栏目录选择器（DirectorySelector，当前项目图标）
 *   H0 /api/current_directory 带 iconUrl 且本仓库能探到自己的 favicon（端点可取）
 *   H1-H5 顶栏画出图标槽 + <img> 真加载出来 + 排在目录名左侧 + 槽 20px
 *   H6 端点全 404 时顶栏当场退回文件夹字形（第三处消费点，同一个兜底）
 *   服务端契约
 *   K6 真图标 200 + 图片 Content-Type + 长缓存；不在清单里的路径 404（白名单）
 *
 * 为什么用**真实项目清单**而不是夹具：这个功能的输入就是用户机器上那些项目的
 * favicon，夹具只能证明"我造的 JSON 能渲染"。所以正向用例吃真数据（本机 32 个项目里
 * 15 个带图标），兜底用例用 route 挡端点造。
 *
 * 反向验证（撤掉实现后哪几条会红）：
 *   · 模板里把 img 的 v-if 改成 false（永远画文件夹图标）→ K1 / K2 / D1 红
 *   · 去掉 @error="markIconFailed" → K4 / D4 红（屏幕上留着破图）
 *   · CSS 里 .proj-item__icon--img 去掉 width/height → K5a 红（图标按原始尺寸铺开）
 *   · 图标槽退回塞进 row1（不跨两行）→ K5c 红（图标高度只有一行）
 *   · 后端路由去掉 isKnownProjectKey 那道门 → K6c 红（任意路径都能读）
 *   · 顶栏去掉图标槽 / DirectorySelector 不再渲染 img → H1 / H2 / H4 / H5 红
 *   · /api/current_directory 不返回 iconUrl → H0a / H0b 红
 */
const path = require('node:path')
// playwright 装在 src/ui/client 下，把它的 node_modules 挂进解析路径，脚本才能独立跑
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544' // 前端
const API = process.env.ZEN_API || 'http://127.0.0.1:5545' // 后端
const SHOT = process.env.ZEN_SHOT || ''
const SHOT_DIALOG = process.env.ZEN_SHOT_DIALOG || ''

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
const obsRows = (page) => page.evaluate(() => {
  const rect = (el) => {
    if (!el) return null
    const b = el.getBoundingClientRect()
    return {
      w: Math.round(b.width), h: Math.round(b.height),
      left: Math.round(b.left), top: Math.round(b.top), bottom: Math.round(b.bottom),
    }
  }
  const rows = Array.from(document.querySelectorAll('.proj-item'))
    .filter(n => !n.classList.contains('proj-item--all'))
  return rows.map((r) => {
    const img = r.querySelector('img.proj-item__icon--img')
    const folder = r.querySelector('i.el-icon.proj-item__icon')
    const nameEl = r.querySelector('.proj-item__name')
    const row1 = r.querySelector('.proj-item__row1')
    const row2 = r.querySelector('.proj-item__row2')
    return {
      name: nameEl ? (nameEl.textContent || '').trim() : '',
      hasImg: !!img,
      hasFolder: !!folder,
      src: img ? (img.getAttribute('src') || '') : '',
      loaded: img ? !!(img.complete && img.naturalWidth > 0) : null,
      slot: rect(r.querySelector('.proj-item__icon-slot')),
      imgBox: rect(img),
      folderBox: rect(folder),
      nameLeft: nameEl ? Math.round(nameEl.getBoundingClientRect().left) : 0,
      // row1 顶到 row2 底 = 「两行文字」的实际高度，图标该覆盖这一段
      textSpan: (row1 && row2)
        ? Math.round(row2.getBoundingClientRect().bottom - row1.getBoundingClientRect().top)
        : null,
    }
  })
})

/** 读「常用目录」弹窗里的卡片 */
const obsCards = (page) => page.evaluate(() => {
  const cards = Array.from(document.querySelectorAll('.dir-card'))
  return cards.map((c) => {
    const img = c.querySelector('img.dir-card__icon--img')
    const slot = c.querySelector('.dir-card__icon')
    const nameEl = c.querySelector('.dir-card__name-base')
    const b = slot ? slot.getBoundingClientRect() : null
    const cardBox = c.getBoundingClientRect()
    const nameBox = nameEl ? nameEl.getBoundingClientRect() : null
    return {
      name: nameEl ? (nameEl.textContent || '').trim() : '',
      hasImg: !!img,
      hasFolder: !!c.querySelector('i.el-icon.dir-card__icon'),
      src: img ? (img.getAttribute('src') || '') : '',
      loaded: img ? !!(img.complete && img.naturalWidth > 0) : null,
      size: b ? `${Math.round(b.width)}x${Math.round(b.height)}` : '',
      // 名字相对**本张卡**左边缘的偏移：弹窗是两栏布局，绝对值按栏不同，
      // 只有这个相对量才是"图标槽宽度 + 间距"那件事的度量
      nameOffset: nameBox ? Math.round(nameBox.left - cardBox.left) : null,
    }
  })
})

/** 读顶栏目录选择器那枚「当前项目图标」 */
const obsHeader = (page) => page.evaluate(() => {
  const btn = document.querySelector('.directory-display')
  if (!btn) return null
  const slot = btn.querySelector('.directory-display__icon')
  const img = btn.querySelector('img.directory-display__icon-img')
  const glyph = btn.querySelector('i.el-icon.directory-display__icon-glyph')
  const nameEl = btn.querySelector('.directory-display__name')
  const r = (el) => (el ? el.getBoundingClientRect() : null)
  const b = r(btn), s = r(slot), n = r(nameEl)
  return {
    name: nameEl ? (nameEl.textContent || '').trim() : '',
    hasSlot: !!slot,
    hasImg: !!img,
    hasGlyph: !!glyph,
    src: img ? (img.getAttribute('src') || '') : '',
    loaded: img ? !!(img.complete && img.naturalWidth > 0) : null,
    slotBox: s ? { w: Math.round(s.width), h: Math.round(s.height), left: Math.round(s.left) } : null,
    imgBox: img ? { w: Math.round(img.width), h: Math.round(img.height) } : null,
    nameLeft: n ? Math.round(n.left) : null,
    // 图标是否落在目录名左侧（有/无图标两种形态都该成立）
    iconLeftOfName: (!!s && !!n) ? s.left < n.left : null,
  }
})

async function openBoard(page) {
  await page.waitForSelector('.activity-bar', { timeout: 20000 })
  await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
  await page.waitForSelector('.board', { timeout: 15000 })
  await page.waitForSelector('.proj-item', { timeout: 15000 })
  await waitUntil(async () => (await obsRows(page)).length > 0)
}

/** 打开「切换工作目录」弹窗（常用目录卡片在那儿）。走窗口事件，不赌点哪个元素 */
async function openDirDialog(page) {
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('zen-gitsync:open-directory-dialog'))
  })
  const ok = await waitUntil(async () => (await obsCards(page)).length > 0, 20000)
  return ok
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

    // 最近目录那份清单也得带图标地址（常用目录卡片的数据源）
    const recent = await fetch(`${API}/api/recent_directories`, { cache: 'no-store' }).then(r => r.json())
    const recentDirs = recent.directories || []
    check('K0b /api/recent_directories 每条都带 iconUrl 字段（常用目录卡片的数据源）',
      recentDirs.length > 0 && recentDirs.every(d => 'iconUrl' in d) && recentDirs.some(d => d.iconUrl),
      `${recentDirs.filter(d => d.iconUrl).length}/${recentDirs.length} 个目录带图标`)

    // 顶栏那枚「当前项目图标」的数据源：/api/current_directory 也得带 iconUrl。
    // 本项目自身带 public/favicon.svg（index.html 里声明了），所以正常应该拿到一个本站端点地址。
    const cur = await fetch(`${API}/api/current_directory`, { cache: 'no-store' }).then(r => r.json())
    check('H0a /api/current_directory 带 iconUrl 字段（顶栏图标的数据源）',
      'iconUrl' in cur, `directory=${cur.directory} iconUrl=${cur.iconUrl}`)
    check('H0b 当前项目（本仓库）探测到了自己的 favicon（地址指向本站图标端点）',
      typeof cur.iconUrl === 'string' && cur.iconUrl.startsWith('/api/workbench/project-icon'),
      `iconUrl=${cur.iconUrl}`)
    if (typeof cur.iconUrl === 'string' && cur.iconUrl.startsWith('/api/')) {
      const iconRes = await fetch(`${API}${cur.iconUrl}`)
      check('H0c 当前目录图标端点可取（200 + 图片）',
        iconRes.status === 200 && /^image\//.test(iconRes.headers.get('content-type') || ''),
        `${iconRes.status} ${iconRes.headers.get('content-type')}`)
    } else {
      check('H0c 当前目录图标端点可取（200 + 图片）', false, '没有拿到本站图标地址，跳过')
    }

    // ── 左栏项目列表 ────────────────────────────────────────────────
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await openBoard(page)
    let rows = await obsRows(page)

    check('K1a 有图标地址的行渲染出 <img class="proj-item__icon--img">',
      rows.some(r => r.hasImg), `${rows.filter(r => r.hasImg).length} 行`)
    // 图是异步下载的：行一出现就断言"加载完了"必然红（那是探针的错，不是功能的错），
    // 先等它们落地，再判有没有 404 破图。
    await waitUntil(async () => (await obsRows(page)).filter(r => r.hasImg).every(r => r.loaded === true), 10000)
    rows = await obsRows(page)
    const iconRows = rows.filter(r => r.hasImg)
    const folderRows = rows.filter(r => !r.hasImg)
    check('K1b 这些 <img> 真的加载出来了（naturalWidth > 0，不是 404 破图）',
      iconRows.length > 0 && iconRows.every(r => r.loaded === true),
      iconRows.filter(r => !r.loaded).map(r => r.name).join(',') || '全部已加载')
    check('K2 有图标的行不再画文件夹图标（两者互斥）',
      iconRows.every(r => !r.hasFolder))
    check('K3 没有图标地址的行退回文件夹图标，且没有 <img>',
      folderRows.length > 0 && folderRows.every(r => r.hasFolder && !r.hasImg),
      `${folderRows.length} 行退回文件夹图标`)
    check('K6d <img> 的 src 指向本站图标端点（或项目声明的远程地址）',
      iconRows.every(r => r.src.startsWith('/api/workbench/project-icon') || /^https?:/.test(r.src)),
      iconRows.map(r => r.src.slice(0, 46)).slice(0, 2).join(' | '))

    // ── K5 几何 ────────────────────────────────────────────────────
    const slots = new Set(rows.map(r => `${r.slot.w}x${r.slot.h}`))
    check('K5a 每行的图标槽都是同一个尺寸（32×32，两种形态共用）',
      slots.size === 1 && [...slots][0] === '32x32', `实际 ${[...slots].join(' / ')}`)
    const lefts = new Set(rows.map(r => r.nameLeft))
    check('K5b 有图标与没图标的行，项目名左边缘对齐',
      lefts.size === 1, `左边缘 ${[...lefts].join(' / ')}`)
    // 用户要的"占 2 行的位置"：图标高度得跟 row1.top→row2.bottom 那一段对得上
    const spanOk = iconRows.every(r => r.textSpan && Math.abs(r.imgBox.h - r.textSpan) <= 8)
    check('K5c 图标真的占两行（高度≈名字行 + 分支行的总高）', spanOk,
      iconRows.map(r => `${r.name}:${r.imgBox.h}/${r.textSpan}`).slice(0, 3).join(' '))
    check('K5d 文件夹字形比槽小（"这儿没有图标"该更轻，而不是撑满 32px）',
      folderRows.length > 0 && folderRows.every(r => r.folderBox && r.folderBox.h <= 24),
      folderRows.map(r => r.folderBox && r.folderBox.h).slice(0, 3).join(','))

    // ── 顶栏目录选择器：当前项目图标 ───────────────────────────────────
    // 当前项目（本仓库）自带 favicon，所以正向期望是 <img> 且真的加载出来。
    const header = await obsHeader(page)
    check('H1 顶栏目录胶囊渲染出图标槽（.directory-display__icon）', !!(header && header.hasSlot))
    if (header && header.hasSlot) {
      check('H2 有 favicon 时顶栏画 <img>（与左栏同一枚图，不是文件夹）',
        header.hasImg && !header.hasGlyph, `img=${header.hasImg} glyph=${header.hasGlyph}`)
      // 图异步下载：等到落地再断言，否则是探针假红
      await waitUntil(async () => {
        const h = await obsHeader(page)
        return !h || !h.hasImg || h.loaded === true
      }, 10000)
      const h2 = await obsHeader(page)
      check('H3 顶栏图标真的加载出来了（naturalWidth > 0，不是 404 破图）',
        !!(h2 && h2.hasImg && h2.loaded === true), JSON.stringify(h2 && h2.imgBox))
      check('H4 图标排在目录名左侧（点图标＝点目录名的同一条热区）',
        !!(h2 && h2.iconLeftOfName === true), `slot.left=${h2 && h2.slotBox && h2.slotBox.left} name.left=${h2 && h2.nameLeft}`)
      check('H5 图标槽是 20px 的方槽（两种形态共用同一尺寸契约）',
        !!(h2 && h2.slotBox && h2.slotBox.w === 20 && h2.slotBox.h === 20), JSON.stringify(h2 && h2.slotBox))
    }

    if (SHOT) {
      // 把鼠标挪开再截图：点过活动栏之后那枚按钮的 tooltip 会一直挂在左栏上挡住几行
      await page.mouse.move(900, 600)
      await sleep(400)
      await page.locator('.proj').first().screenshot({ path: SHOT }).catch(() => page.screenshot({ path: SHOT }))
      log(`截图：${SHOT}`)
    }

    // ── 常用目录卡片 ────────────────────────────────────────────────
    const opened = await openDirDialog(page)
    check('D0 「切换工作目录」弹窗打开并渲染出常用目录卡片', opened)
    if (opened) {
      await waitUntil(async () => (await obsCards(page)).filter(c => c.hasImg).every(c => c.loaded === true), 10000)
      // 等弹窗的入场动画走完再量：动画期间整张弹窗带 transform，量出来是 37px 不是 38px
      await sleep(600)
      const cards = await obsCards(page)
      const imgCards = cards.filter(c => c.hasImg)
      const glyphCards = cards.filter(c => !c.hasImg)
      check('D1 有图标地址的卡片渲染出 <img class="dir-card__icon--img">',
        imgCards.length > 0, `${imgCards.length}/${cards.length} 张卡带图标`)
      check('D2 这些 <img> 真的加载出来了（不是 404 破图）',
        imgCards.every(c => c.loaded === true),
        imgCards.filter(c => !c.loaded).map(c => c.name).join(',') || '全部已加载')
      check('D3 有图标与没图标的卡片，图标槽同尺寸（38×38）且名字相对卡片的左偏移一致',
        new Set(cards.map(c => c.size)).size === 1
        && new Set(cards.map(c => c.nameOffset)).size === 1
        && cards[0].size === '38x38',
        `尺寸 ${[...new Set(cards.map(c => c.size))].join('/')} 名字偏移 ${[...new Set(cards.map(c => c.nameOffset))].join('/')}`)
      check('D5 没图标的卡片退回文件夹字形（两种形态共存）',
        glyphCards.length > 0 && glyphCards.every(c => c.hasFolder), `${glyphCards.length} 张退回`)

      if (SHOT_DIALOG) {
        await page.locator('.directory-dialog').first()
          .screenshot({ path: SHOT_DIALOG })
          .catch(() => page.screenshot({ path: SHOT_DIALOG }))
        log(`截图：${SHOT_DIALOG}`)
      }
    }

    // ── K4/D4 反向：图标端点全 404 → 两处都必须当场退回文件夹图标 ──────
    await page.route('**/api/workbench/project-icon**', (route) => route.fulfill({ status: 404, body: '' }))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openBoard(page)
    await waitUntil(async () => (await obsRows(page)).every(r => !r.hasImg), 8000)
    rows = await obsRows(page)
    check('K4 图标全部 404 时每一行都退回文件夹图标（不留破图）',
      rows.length > 0 && rows.every(r => !r.hasImg && r.hasFolder),
      `仍有 img 的行：${rows.filter(r => r.hasImg).map(r => r.name).join(',') || '无'}`)

    // 同一批 404 下，顶栏那枚也得当场退回文件夹字形（@error → markIconFailed）
    await waitUntil(async () => {
      const h = await obsHeader(page)
      return !!h && !h.hasImg && h.hasGlyph
    }, 8000)
    const h404 = await obsHeader(page)
    check('H6 图标端点全 404 时，顶栏当场退回文件夹字形（不留破图）',
      !!(h404 && !h404.hasImg && h404.hasGlyph),
      `img=${h404 && h404.hasImg} glyph=${h404 && h404.hasGlyph}`)

    const opened2 = await openDirDialog(page)
    if (opened2) {
      await waitUntil(async () => (await obsCards(page)).every(c => !c.hasImg), 8000)
      const cards2 = await obsCards(page)
      check('D4 同一批 404 下，常用目录卡片也全部退回文件夹字形',
        cards2.length > 0 && cards2.every(c => !c.hasImg && c.hasFolder),
        `仍有 img 的卡：${cards2.filter(c => c.hasImg).map(c => c.name).join(',') || '无'}`)
    } else {
      check('D4 同一批 404 下，常用目录卡片也全部退回文件夹字形', false, '弹窗没打开')
    }
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

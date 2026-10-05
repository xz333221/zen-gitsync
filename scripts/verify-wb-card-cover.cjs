/**
 * 看板卡片「封面」（任务附件里的图片）的验证。
 *
 * 验收契约（改这块时别破坏）：
 *   A 服务端：decorateTaskForBoard 把附件里的**图片**挑出来放 images；
 *     非图片附件（pdf / log）不算，缺 id 的脏记录不算；空数组而不是 undefined
 *   B 有图的卡片上有封面，**图真的解码出来了**（naturalWidth > 0）—— 光有 <img> 元素
 *     可能是一张 404 裂图，那正是本次要消灭的"看不见图"
 *   C 「还有 N 张」的 N 数的是**图**不是附件（2 图 + 1 份日志要写 +1 而不是 +2）；
 *     只有一张时不出现这枚角标
 *   D 封面出血到卡片边缘、且**在首行之上**——放最顶就一辈子不被卡片底部那组
 *     hover 按钮压住（那套渐隐遮罩只认"最后一行"，见 .kb-card__actions 的注释）
 *   E 点封面**看图**而不是**打开任务**：卡片整块是"打开任务"的可点区域，
 *     封面必须把自己摘出来（@click.stop）
 *   F 列表视图那一行也有「N 张图」，且**不吃行高**（那一格与无图任务逐像素等高）
 *   G 页面无 console / page 错误
 *   R 负控（--reverse）：fixture 退回**没有 images 字段的旧形态** —— 那次改动之前的
 *     看板就是这样的数据，此时 B/C/D/E/F 必须变红（说明这几条断的是真事，不是空转）
 *
 * 为什么用 route 拦截 /api/workbench/projects 而不是直接读真实响应：
 *   合成任务能把「1 张图 / 3 张图 / 有附件但没图」这几种边界一次凑齐，真实数据里
 *   凑巧同时具备的概率不高。图片本身**不造假**：合成任务借用真实附件的 id，
 *   <img> 打的是真后端的 /api/workbench/attachments/:id/raw，所以 B 组断的是
 *   "这张图真的显示得出来"，不是"src 字符串写对了"。
 *
 * 前置：dev server 已启动（vite 5544）；后端 5545 活着（提供附件原图与其余接口）。
 * 用法：node scripts/verify-wb-card-cover.cjs [--reverse]
 * 退出码：0 全通过，1 有失败项。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544'
const API = process.env.ZEN_API || 'http://127.0.0.1:5545'
const DATA_DIR = path.join(os.homedir(), '.zen-gitsync')
const CHROME = process.env.ZEN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const REVERSE = process.argv.includes('--reverse')

const PROJECT_PATH = 'D:\\ws\\zen-gitsync'
/** 列表视图里那枚标的中文原话（断言渲染出来的字，不是某个 class） */
const LIST_LABEL = (n) => `${n} 张图`
/**
 * 故意指向一个不存在的附件 id：/raw 会 404，<img> 触发 onerror。
 * 本机真实数据里有 4 条"附件记录还在、文件已经没了"（清理过 workbench-images 或换机器），
 * 那种卡上留着的是浏览器默认的裂图图标 —— 比"这张卡没有封面"难看得多。
 */
const MISSING_ATT_ID = 'no-such-attachment-id'

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()

/** 读真实附件：按后缀挑出图片 id，合成任务借它们当"这条任务带的图" */
function readRealAttachments() {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tasks.json'), 'utf-8'))
  const imageIds = []
  const docIds = []
  for (const t of Array.isArray(raw.tasks) ? raw.tasks : []) {
    for (const a of Array.isArray(t.attachments) ? t.attachments : []) {
      if (!a || !a.id) continue
      const ext = String(a.ext || '').toLowerCase()
      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) imageIds.push(a.id)
      else if (ext) docIds.push(a.id)
    }
  }
  return { imageIds, docIds, tasks: Array.isArray(raw.tasks) ? raw.tasks : [] }
}

/**
 * 四条合成任务，覆盖"封面该不该出现 / 角标该写几"的全部分支。
 * 图片用的是真实附件 id —— 路径能取到文件，B 组才验得了"图真的显示出来"。
 */
function syntheticTasks({ decorate, imageIds, docIds }) {
  const at = (minAgo) => new Date(Date.now() - minAgo * 60 * 1000).toISOString()
  const img = (id, n) => ({ id, ext: 'png', originalName: `shot-${n}.png`, mimeType: 'image/png' })
  const [i1, i2, i3] = imageIds
  const doc = docIds[0] || 'doc-missing'
  const cases = [
    ['one', '【合成】只有一张图', [img(i1, 1)]],
    ['three', '【合成】三张图', [img(i1, 1), img(i2, 2), img(i3, 3)]],
    ['mixed', '【合成】两张图 + 一份日志', [img(i1, 1), img(i2, 2), { id: doc, ext: 'log', originalName: 'run.log' }]],
    ['doc', '【合成】只有非图片附件', [{ id: doc, ext: 'log', originalName: 'run.log' }]],
    ['none', '【合成】没有附件', []],
    // 附件记录还在、文件已经没了 —— 本机真实数据里就有 4 条这种（见 B7）
    ['broken', '【合成】图片文件已丢失', [{ ...img(MISSING_ATT_ID, 9), originalName: 'gone.png' }]],
  ]
  return cases.map(([id, title, attachments], idx) => {
    const task = { id: `syn-${id}`, title, desc: '', projectPath: PROJECT_PATH, attachments, createdAt: at(600 + idx) }
    return decorate(task, [])
  })
}

async function main() {
  const registry = await import(pathToFileURL(
    path.resolve(__dirname, '../src/ui/server/routes/workbench/projectRegistry.js')
  ).href)

  const { imageIds, docIds, tasks: realTasks } = readRealAttachments()
  if (imageIds.length < 3) {
    console.error('[verify] 真实数据里的图片附件不足 3 个，合成用例凑不齐（换个数据源或先造几张图）')
    process.exit(1)
  }

  // ── A 服务端：挑图的规则 ────────────────────────────────────────────
  const sample = registry.pickBoardImages([
    { id: 'a1', ext: 'png', originalName: 'a.png', absolutePath: 'C:\\secret\\a.png' },
    { id: 'a2', ext: 'log', originalName: 'a.log' },
    { id: 'a3', ext: '', mimeType: 'image/webp', originalName: 'a.webp' },
    { id: 'a4', ext: 'pdf', originalName: 'a.pdf', mimeType: 'application/pdf' },
  ])
  check('A1 只挑图片（后缀优先，缺后缀时看 mime），日志 / PDF 不算',
    sample.length === 2 && sample[0].id === 'a1' && sample[1].id === 'a3',
    JSON.stringify(sample))
  check('A2 只回 id / originalName / ext —— absolutePath 不随看板接口漏出去',
    Object.keys(sample[0]).sort().join(',') === 'ext,id,originalName', Object.keys(sample[0]).join(','))
  check('A3 没附件 / 形态不对时给空数组，不抛（前端模板直接按长度判断）',
    Array.isArray(registry.decorateTaskForBoard({ id: 'x', title: '', desc: '' }, []).images)
    && registry.decorateTaskForBoard({ id: 'x', title: '', desc: '' }, []).images.length === 0)

  const realWithImages = realTasks.filter(t => Array.isArray(t.attachments) && t.attachments.some(a => a && a.ext === 'png'))
  const realImages = realWithImages.length
    ? registry.decorateTaskForBoard(realWithImages[0], []).images
    : []
  check('A4 真实数据上口径一致：带 png 附件的任务在 images 里就有图',
    realImages.length > 0 && realImages.every(x => x.id && x.ext === 'png'),
    `任务 ${realWithImages[0]?.id} → ${JSON.stringify(realImages.map(x => x.id))}`)

  // 卡片的图必须**真的取得到**：这一层前端断言验不了（<img> 看不出 404 还是加载失败）
  const probeRes = await fetch(`${API}/api/workbench/attachments/${realImages[0].id}/raw`)
  check('A5 images 里的 id 能取到原图，且 Content-Type 是图片（404 的话封面就是一张裂图）',
    probeRes.ok && /^image\//.test(probeRes.headers.get('content-type') || ''),
    `${probeRes.status} ${probeRes.headers.get('content-type')}`)
  await probeRes.arrayBuffer()

  // ── 拼 fixture：真实卡片 + 合成卡片 ─────────────────────────────────
  const live = await fetch(`${API}/api/workbench/projects`).then(r => r.json())
  const jobsRaw = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'jobs.json'), 'utf-8')).jobs || [] } catch { return [] }
  })()
  const byTask = registry.groupJobsByTask(jobsRaw)
  const boardTasks = realTasks.map(t => registry.decorateTaskForBoard(t, byTask.get(t.id) || []))
  const synth = syntheticTasks({ decorate: registry.decorateTaskForBoard, imageIds, docIds })
  let tasks = boardTasks.concat(synth)
  if (REVERSE) tasks = tasks.map(({ images, ...rest }) => rest)  // 改动之前的负载形态

  log(`真实数据：任务 ${boardTasks.length} 条，其中带图的 ${boardTasks.filter(t => (t.images || []).length).length} 条`)

  // 后端实例也得发 images —— 它不发（比如 nodemon 没重启），卡片上照样一片空白。
  // 这条**两种模式都按同一个方向断言**：它守的是"跑着的那个进程有没有跟进改动"，
  // 与 fixture 是不是退回旧形态无关（--reverse 只管前端那半段）。
  const liveWithImages = (live.tasks || []).filter(t => Array.isArray(t.images) && t.images.length)
  check('A6 运行中的后端也在发 images（只验磁盘函数的话，进程没重启就看不出来）',
    liveWithImages.length > 0,
    `${liveWithImages.length} / ${(live.tasks || []).length}`)

  const byId = (id) => tasks.find(t => t.id === id)

  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox'],
  })
  // 视口按**用户实际窗口**取：卡片窄，封面要能在真实宽度下铺满
  const page = await (await browser.newContext({ viewport: { width: 2000, height: 1274 } })).newPage()
  page.on('console', (m) => {
    // 带上 url：G1 要放行"那条故意造的 404 图"，别的 console error 一律不许有
    if (m.type() === 'error') consoleErrors.push(`${m.text()} @${(m.location() && m.location().url) || ''}`)
  })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  let shot = null
  try {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('wb.boardView.v1', 'kanban')
        // 必须预置「全部项目」（''），否则 applyDefaultSelection() 会把选中项落到当前项目，
        // 合成任务全被 visibleTasks 过滤掉（verify-wb-card-reply 踩过这个坑）
        localStorage.setItem('wb.boardProject.v1', '')
      } catch { /* 隐私模式 */ }
    })
    await page.route('**/api/workbench/projects*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, projects: live.projects, tasks, currentProjectPath: live.currentProjectPath }),
    }))

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.board', { timeout: 15000 })
    await page.locator('.proj-item--all').first().click()
    await sleep(1500)

    /** 按标题定位卡片，读封面的一切（DOM ↔ 数据关联不用标题当键会串） */
    const readCard = (title) => page.evaluate(async (t) => {
      const cards = Array.from(document.querySelectorAll('.kb-card'))
      const card = cards.find(c => (c.querySelector('.kb-card__title')?.textContent || '').trim() === t)
      if (!card) return { found: false, titles: cards.slice(0, 8).map(c => (c.querySelector('.kb-card__title')?.textContent || '').trim()) }
      const cover = card.querySelector('.kb-card__cover')
      const img = cover ? cover.querySelector('.kb-card__cover-img') : null
      // 等 lazy 图解码（最多 3s）：只断言"元素在"会放过一张 404 裂图
      const deadline = Date.now() + 3000
      while (img && !(img.complete && img.naturalWidth > 0) && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100))
      }
      const more = cover ? cover.querySelector('.kb-card__cover-more') : null
      const row1 = card.querySelector('.kb-card__row1')
      const cb = card.getBoundingClientRect()
      const vb = cover ? cover.getBoundingClientRect() : null
      const rb = row1 ? row1.getBoundingClientRect() : null
      return {
        found: true,
        hasCover: !!cover,
        tag: cover ? cover.tagName : null,
        src: img ? img.getAttribute('src') : null,
        naturalWidth: img ? img.naturalWidth : 0,
        complete: img ? img.complete : false,
        alt: img ? img.getAttribute('alt') : null,
        more: more ? more.textContent.replace(/\s+/g, ' ').trim() : null,
        coverW: vb ? Math.round(vb.width) : null,
        coverH: vb ? Math.round(vb.height) : null,
        cardW: Math.round(cb.width),
        // 出血：封面左右边缘应当与卡片**边框盒**对齐（不是内容盒）
        bleedLeft: vb ? Math.round(vb.left - cb.left) : null,
        bleedRight: vb ? Math.round(cb.right - vb.right) : null,
        // 封面在首行**上方**：操作组压的是卡片最后一行，封面在最顶就永远不相干
        aboveRow1: (vb && rb) ? vb.bottom <= rb.top + 1 : null,
        titleTop: rb ? Math.round(rb.top - cb.top) : null,
      }
    }, title)

    const one = await readCard(byId('syn-one').title)
    if (!one.found) throw new Error(`看板上找不到合成卡片，实际有：${JSON.stringify(one.titles)}`)
    const three = await readCard(byId('syn-three').title)
    const mixed = await readCard(byId('syn-mixed').title)
    const doc = await readCard(byId('syn-doc').title)
    const none = await readCard(byId('syn-none').title)
    const broken = await readCard(byId('syn-broken').title)

    // ── B 有图的卡片：封面在，且图真的解码了 ───────────────────────────
    check('B1 有图的卡片上有封面',
      REVERSE ? one.hasCover === false : one.hasCover === true, `hasCover=${one.hasCover}`)
    check('B2 封面里的图**真的解码出来了**（naturalWidth > 0；只断元素在会放过一张裂图）',
      REVERSE ? one.naturalWidth === 0 : one.naturalWidth > 0,
      `complete=${one.complete} naturalWidth=${one.naturalWidth}`)
    check('B3 图片地址指向附件原图端点 /api/workbench/attachments/:id/raw',
      REVERSE ? one.src === null : /^\/api\/workbench\/attachments\/[^/]+\/raw$/.test(String(one.src || '')),
      String(one.src))
    check('B4 alt 是文件名（加载失败时至少知道是"哪张图没出来"）',
      REVERSE ? one.alt === null : /^shot-1\.png$/.test(String(one.alt || '')), String(one.alt))

    // ── C 角标数的是图不是附件 ────────────────────────────────────────
    check('C1 三张图 → 角标是 +2',
      REVERSE ? three.more === null : norm(three.more) === '+2', String(three.more))
    check('C2 只有一张图时**不出现**角标（+0 是噪声）',
      one.more === null, `one=${one.more}`)
    check('C3 两张图 + 一份日志 → +1（数的是图，不是 attachmentCount）',
      REVERSE ? mixed.more === null : norm(mixed.more) === '+1', String(mixed.more))

    // ── B5/负控：有附件但没图 / 压根没附件，都不该有封面 ──────────────
    check('B5 只有非图片附件（日志）的卡片上没有封面',
      doc.found && doc.hasCover === false, `found=${doc.found} hasCover=${doc.hasCover}`)
    check('B6 没有附件的卡片上没有封面',
      none.found && none.hasCover === false, `found=${none.found} hasCover=${none.hasCover}`)
    // B7 是**负向断言**，两种模式都成立（旧负载下也没封面），所以不靠 --reverse 反证；
    // 它守的坑是"图 404 之后那张裂图一直挂在卡上" —— 前端实测过本机就有 4 条这种附件
    check('B7 附件文件取不到时整块封面消失，不留一枚浏览器裂图',
      broken.found && broken.hasCover === false, `found=${broken.found} hasCover=${broken.hasCover}`)
    // 正向护栏：B7 不能因为"这张卡压根没渲染"而假绿 —— 同一批里另外那张有图的卡封面还在
    check('B8 正向护栏：同一批里有图的卡封面照旧在（B7 不是"整批都没封面"）',
      one.hasCover === (REVERSE ? false : true), `hasCover=${one.hasCover}`)

    // ── D 几何：出血到卡片边缘 + 在首行之上 ───────────────────────────
    check('D1 封面横向铺满卡片（出血到边框盒，两侧误差 ≤ 2px）',
      REVERSE ? one.coverW === null : (Math.abs(one.bleedLeft) <= 2 && Math.abs(one.bleedRight) <= 2),
      `left=${one.bleedLeft} right=${one.bleedRight} coverW=${one.coverW} cardW=${one.cardW}`)
    check('D2 封面在首行**上方**（操作组只压最后一行，靠这层位置关系避开它）',
      REVERSE ? one.aboveRow1 === null : one.aboveRow1 === true,
      `aboveRow1=${one.aboveRow1} titleTop=${one.titleTop}`)
    check('D3 封面让首行整体下移（有封面的卡 titleTop 明显大于没有的）',
      REVERSE ? true : (one.titleTop != null && none.titleTop != null && one.titleTop > none.titleTop + 40),
      `有图 ${one.titleTop} / 没图 ${none.titleTop}`)

    // 截图存证（先截有图那一列，看得见封面）
    const shotsDir = path.resolve(__dirname, '../docs/shots')
    fs.mkdirSync(shotsDir, { recursive: true })
    shot = path.join(shotsDir, REVERSE ? 'wb-card-cover-reverse.png' : 'wb-card-cover.png')
    await page.locator('.kb-col--todo').first().screenshot({ path: shot })

    // ── E 点封面 = 看图，不是打开任务 ─────────────────────────────────
    const editorBefore = await page.locator('.wb-editor').count()
    check('E0 前置：此刻没有打开任何任务编辑器', editorBefore === 0, `count=${editorBefore}`)

    if (REVERSE) {
      // 旧负载下这张卡上压根没有封面 —— 点它这件事本身就不成立，
      // 所以这里断言的是"没得点"，而不是"点了没反应"（后者恒真，等于空转）
      check('E1 负控：旧负载下这张卡上没有封面可点', one.hasCover === false, `hasCover=${one.hasCover}`)
      check('E2 负控：也就没有"点封面误开任务"这条路径', one.hasCover === false && editorBefore === 0)
    } else {
      await page.locator('.kb-card', { hasText: byId('syn-one').title }).first()
        .locator('.kb-card__cover').click({ timeout: 8000 })
      await sleep(600)
      const viewerCount = await page.locator('.el-image-viewer__wrapper').count()
      const editorAfter = await page.locator('.wb-editor').count()
      check('E1 点封面弹出了看图器', viewerCount === 1, `viewer=${viewerCount}`)
      check('E2 点封面**没有**顺手把任务也打开（卡片整块是可点区域，封面得 stop）',
        editorAfter === 0, `editor=${editorAfter}`)

      if (viewerCount === 1) {
        // 关掉：看图器自己监听 Esc
        await page.keyboard.press('Escape')
        await sleep(400)
        const viewerAfterEsc = await page.locator('.el-image-viewer__wrapper').count()
        check('E3 Esc 能关掉看图器', viewerAfterEsc === 0, `viewer=${viewerAfterEsc}`)
      }
    }

    // ── F 列表视图：同一批任务的另一种画法 ────────────────────────────
    await page.locator('.kb__view-btn', { hasText: /列表视图|List/ }).first().click()
    await page.waitForSelector('.kb-table__row', { timeout: 10000 })
    await sleep(400)
    const readRow = (title) => page.evaluate((t) => {
      const rows = Array.from(document.querySelectorAll('.kb-table__row'))
      const row = rows.find(r => (r.querySelector('.kb-table__name')?.textContent || '').trim() === t)
      if (!row) return { found: false }
      const badge = row.querySelector('.kb-table__shots')
      const cell = row.querySelector('.kb-table__td')
      return {
        found: true,
        badge: badge ? badge.textContent.replace(/\s+/g, ' ').trim() : null,
        badgeTitle: badge ? badge.getAttribute('title') : null,
        cellH: cell ? Math.round(cell.getBoundingClientRect().height * 10) / 10 : null,
        rowH: Math.round(row.getBoundingClientRect().height * 10) / 10,
      }
    }, title)

    const rowOne = await readRow(byId('syn-one').title)
    const rowThree = await readRow(byId('syn-three').title)
    const rowNone = await readRow(byId('syn-none').title)
    check('F1 列表视图那一行也有「N 张图」（与看板卡片同一份数据）',
      REVERSE ? rowOne.badge === null : norm(rowOne.badge) === LIST_LABEL(1), String(rowOne.badge))
    check('F2 数量按**图**算（三张图的行写 3 张图）',
      REVERSE ? rowThree.badge === null : norm(rowThree.badge) === LIST_LABEL(3), String(rowThree.badge))
    check('F3 没有图的任务那一行不出现这枚标',
      rowNone.found && rowNone.badge === null, String(rowNone.badge))
    check('F4 这枚标**不吃行高**：有图与没图的两行逐像素等高',
      rowOne.rowH != null && rowNone.rowH != null && Math.abs(rowOne.rowH - rowNone.rowH) < 0.5,
      `有图 ${rowOne.rowH} / 没图 ${rowNone.rowH}`)

    // 只有"故意造的那条 404 图"允许出现在 console 里，别的 error 一律算红
    const expected404 = consoleErrors.filter(t => t.includes(MISSING_ATT_ID))
    const unexpected = consoleErrors.filter(t => !t.includes(MISSING_ATT_ID))
    // 正向护栏：那条 404 得**真的发生过** —— 否则 B7 验的是"没请求过"，不是"请求失败后被撤掉"
    check('G0 故意造的 404 确实发生了（B7 不是空转）',
      REVERSE ? true : expected404.length > 0, `expected404=${expected404.length}`)
    check('G1 页面无 console / page 错误（只有那条故意造的 404 图被放行）',
      unexpected.length === 0 && pageErrors.length === 0,
      [...unexpected, ...pageErrors].slice(0, 3).join(' | '))
  } finally {
    // 只关自己起的这个浏览器实例（按 CDP，不用 taskkill /IM —— 那会连带关掉用户的浏览器）
    await browser.close()
  }

  if (shot) log('截图:', shot)
  const failed = results.filter(r => !r.ok)
  console.log(`\n[verify] ${results.length - failed.length}/${results.length} 通过${REVERSE ? '（负控模式：没有 images 字段的负载不许出现封面）' : ''}`)
  for (const f of failed) console.log(`  FAIL  ${f.name}  ::  ${f.extra}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify] 异常退出:', err); process.exit(1) })

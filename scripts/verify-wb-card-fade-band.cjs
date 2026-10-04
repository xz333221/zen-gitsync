/**
 * 看板卡片 hover 渐隐「只洗最后一行」的验证（2026-10-02）。
 *
 * 背景：hover 时浮出的操作组（执行 / 完成 / ×）绝对定位在右下角，它压住的永远是卡片的
 * **最后一行**。原先遮罩只有一层横向渐隐，挂在整块上 —— 于是一张引文折到 3 行的卡，
 * hover 一下**每一行**的右端都被洗掉 102px，而按钮只压着最后一行：右上角空出两大块
 * 空白（用户 2026-10-02 报的"hover 时候一片空白"）。
 * 现在遮罩是两层 add：横向渐隐 + 一层「条带之外一律不透明」的纵向层（--kb-mask-outside-band），
 * 于是只有按钮压住的那条带渐隐。
 *
 * ⚠️ 这里踩过一个**看不出来的坑，值得记在契约里**：合成方式写成 `intersect` 时，
 * 全部几何断言都是绿的（层数 2、纵向 stop 也都在），**截图却与改动前一模一样** ——
 * intersect 只能把两层相乘，而横向层在上面几行本来就是 0（那正是要渐隐的地方），
 * 一相交它们永远是 0。加法（add）才是"只在带里渐隐"那个效果的正确写法。
 * 所以光量 CSS 数字不够，本脚本最后还要**数像素**（P 组）。
 *
 * 验收契约（改这块时别破坏）：
 *   A 三行引文的卡 hover：被遮的是引文，操作组浮出，组左边缘落在横向完全透明区里
 *   B 遮罩是两层 add（横向渐隐 + 带外不透明），纵向过渡带起点不低于倒数第二行的行盒下沿
 *   C 纵向过渡带终点 ≥ 操作组盒顶（整组按钮落在全透明带里）、且 ≤ 末行行盒上沿
 *     （末行右侧仍被完整遮住，上一行完全不受影响）
 *   D guard：那三行的引文**确实**折到了 ≥2 行 —— 否则 B/C 是条空断言
 *   E 两行活动区（live 那行 line-clamp: 2）与单行卡走同一套条带
 *   P **数像素**：倒数第二行右端（横向完全透明区之内）必须还有墨。
 *     这一条才是用户诉求本身；几何判据全绿也可能因为合成方式写错而什么都没遮住。
 *   H 页面无 console / page 错误
 *   R 反证（--reverse）：把遮罩注入回**改动前**的样子（单层横向渐隐），
 *     R 组断言旧行为可观测（只有一层、没有纵向层）**且 P 组数不到墨** —— 后者才是反证。
 *     注入的是**样式**不是数据：SFC 跑在 vite dev server 里，换数据改不了 CSS 那一层。
 *
 * 为什么不并进 verify-wb-card-stop：那个探针的 --reverse 撤的是「停止」按钮那次改动，
 *     一次 flag 只该撤一件事。这里要撤的是遮罩的层数，判据完全不同。
 *
 * 前置：dev server 已启动（vite 5544，`npm run dev:ping` 两个 OK）。后端**不需要**
 *      （接口全被 route 拦掉，不碰真进程）。
 * 用法：node scripts/verify-wb-card-fade-band.cjs [--reverse]
 * 退出码：0 全通过，1 有失败项。
 */
const fs = require('node:fs')
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const CHROME = process.env.ZEN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
/** 反证：见文件头 R 段 */
const REVERSE = process.argv.includes('--reverse')

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const PROJECT_PATH = 'D:\\ws\\zen-gitsync'
/** 够长才能折到 3 行（-webkit-line-clamp: 3）。服务端真数据只给 100 字，这里不受那条限制。 */
const LONG_REPLY = 'node --check 和渲染自检。对比断言只数了 8 个模型，一条「不能出现多于 120」的重复被去重后仍有两处，要修'

/**
 * 三张卡，把「被遮的行」三种形态都摆齐：
 *   syn-reply 空闲 + 三行引文（.kb-card__reply）
 *   syn-live  在跑 + 活动区（最后那个孩子是折了两行的 .kb-card__live-line）
 *   syn-idle  从没跑过（卡里只有首行，遮的是标题）
 */
function fixture() {
  const at = (minAgo) => new Date(Date.now() - minAgo * 60 * 1000).toISOString()
  const board = [
    {
      id: 'syn-reply', title: '【合成】三行引文', desc: '', projectPath: PROJECT_PATH,
      column: 'todo', attachmentCount: 0, runningJobs: 0, live: null,
      lastReply: LONG_REPLY, lastJobAgent: 'claude', lastJobStatus: 'success',
      lastJobEndedAt: at(30), createdAt: at(60), updatedAt: at(30),
    },
    {
      id: 'syn-live', title: '【合成】活动区两行', desc: '', projectPath: PROJECT_PATH,
      column: 'doing', attachmentCount: 0, runningJobs: 1,
      live: {
        jobId: 'syn-live-job', status: 'running', agent: 'claude', startedAt: at(3), pid: 4242,
        elapsedMs: 3 * 60 * 1000, toolCallCount: 118, toolMix: 'Bash×118',
        lastTool: 'Edit src/ui/client/src/views/components/WorkbenchKanban.vue',
        lastThought: LONG_REPLY, lastLine: null, silentMs: 90 * 1000,
      },
      lastReply: null, lastJobAgent: 'claude', lastJobStatus: 'running',
      lastJobEndedAt: null, createdAt: at(60), updatedAt: at(3),
    },
    {
      id: 'syn-idle', title: '【合成】只有标题', desc: '', projectPath: PROJECT_PATH,
      column: 'todo', attachmentCount: 0, runningJobs: 0, live: null,
      lastReply: '', lastJobAgent: null, lastJobStatus: null,
      lastJobEndedAt: null, createdAt: at(30), updatedAt: at(30),
    },
  ]
  const tasks = board.map(t => ({
    id: t.id, title: t.title, desc: t.desc, promptId: null, simpleOverride: '',
    projectPath: PROJECT_PATH, status: t.column, attachments: [],
    createdAt: t.createdAt, updatedAt: t.updatedAt,
  }))
  const project = {
    path: PROJECT_PATH, key: PROJECT_PATH.toLowerCase(), name: 'zen-gitsync',
    source: 'both', isCurrent: true, git: null, stats: {
      total: 3, todo: 2, doing: 1, done: 0, progress: 0, runningJobs: 1, lastActiveAt: at(3),
    },
  }
  return { board, tasks, project }
}

/** 卡片正中坐标 —— hover 之前读（那时还没有 mask，readMask 量不到东西） */
function readBox(page, id) {
  return page.evaluate((taskId) => {
    const el = document.querySelector(`.kb-card[data-task-id="${taskId}"]`)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }, id)
}

/**
 * 量一张卡在 hover 时的遮罩几何。
 *
 * 返回的数字都是"从被遮元素的**下边缘**往上算"，这样跟 CSS 里 `calc(100% - Npx)`
 * 一一对应（渐变原点在被遮元素的 border box）：
 *   bandTop   纵向层的**不透明**边界（往上）。≥ bandTop 的地方一个字都不洗
 *   bandEnd   纵向层**完全透明**处（往上）。≤ bandEnd 的地方横向整段透明
 * 行盒用 Range.getClientRects() 取 —— 它给的是真实的行盒，比量元素盒子准。
 * 顺带把倒数第二行的行盒返回成**视口坐标**下的矩形，P 组要在那块数像素。
 */
function readMask(page, id) {
  return page.evaluate((taskId) => {
    const el = document.querySelector(`.kb-card[data-task-id="${taskId}"]`)
    if (!el) return { found: false }
    const actions = el.querySelector('.kb-card__actions')
    const ar = actions.getBoundingClientRect()
    const r = el.getBoundingClientRect()

    const maskedEl = [...el.querySelectorAll('*')].find(e => getComputedStyle(e).maskImage !== 'none')
    if (!maskedEl) return { found: true, masked: null }
    const mr = maskedEl.getBoundingClientRect()
    const cs = getComputedStyle(maskedEl)
    const maskVal = cs.maskImage
    // 按**顶层逗号**拆层（颜色函数里的逗号不能算）。不能按 ')' 截 —— 计算值里颜色是
    // rgb(0, 0, 0)，截在颜色函数中间会把后面的 calc() 丢掉（踩过：hTransparent 恒 null）。
    const layers = (() => {
      const out = []; let depth = 0, start = 0
      for (let i = 0; i < maskVal.length; i++) {
        const c = maskVal[i]
        if (c === '(') depth++
        else if (c === ')') depth--
        else if (c === ',' && depth === 0) { out.push(maskVal.slice(start, i)); start = i + 1 }
      }
      out.push(maskVal.slice(start))
      return out
    })()
    // ⚠️ 纵向那层在计算值里**不带方向词**：`to bottom` 是默认值，Chrome 序列化时省掉，
    // 所以只能靠"横向那层带 to right"来区分，不能去找 `to bottom`（找不到 → 恒 null）。
    const hLayer = layers.find(l => /to (right|left)/.test(l)) || ''
    const vLayer = layers.find(l => l !== hLayer) || ''
    // 横向那层：最后一个 stop 就是"完全透明"的位置（px，从右边缘算）
    const hStops = [...hLayer.matchAll(/calc\(100% - (\d+(?:\.\d+)?)px\)/g)].map(m => Number(m[1]))
    // 纵向那层：第一个 stop = 不透明边界，最后一个 = 完全透明处（px，从下边缘算）
    const vStops = [...vLayer.matchAll(/calc\(100% - (\d+(?:\.\d+)?)px\)/g)].map(m => Number(m[1]))
    const textEl = maskedEl.querySelector('.kb-card__reply-text') || maskedEl
    const range = document.createRange()
    range.selectNodeContents(textEl)
    // 行盒：同一行可能有多个 span → 多个同顶的 rect，先按顶去重再从上往下排
    const rows = []
    for (const rect of range.getClientRects()) {
      const key = Math.round(rect.top * 10) / 10
      const hit = rows.find(w => w.top === key)
      if (hit) { hit.bottom = Math.max(hit.bottom, rect.bottom); hit.right = Math.max(hit.right, rect.right) }
      else rows.push({ top: key, bottom: rect.bottom, right: rect.right })
    }
    rows.sort((a, b) => b.top - a.top)   // 从最上面一行往下排
    const penult = rows.length >= 2 ? rows[rows.length - 2] : null
    return {
      found: true,
      masked: String(maskedEl.className),
      composite: cs.maskComposite,
      layers: (maskVal.match(/linear-gradient\(/g) || []).length,
      hTransparent: hStops.length ? hStops[hStops.length - 1] : null,
      bandTop: vStops.length ? vStops[0] : null,
      bandEnd: vStops.length ? vStops[vStops.length - 1] : null,
      /** 行盒行高：相邻两行的间距（只有一行时为 0） */
      lineHeight: rows.length >= 2 ? +(rows[0].top - rows[1].top).toFixed(2) : 0,
      lineCount: rows.length,
      /** 倒数第二行的行盒（视口坐标）：P 组在它右端那块数像素 */
      penultBox: penult ? { top: penult.top, bottom: penult.bottom, right: penult.right } : null,
      cardBox: { x: r.x, y: r.y, width: r.width, height: r.height },
      /** 操作组盒顶在被遮元素下边缘之上多少 px */
      actionsTopAbove: +(mr.bottom - ar.top).toFixed(2),
      /** 操作组左边缘到被遮元素右边缘；必须 ≤ hTransparent 才不露半截字形 */
      gapToMask: +(mr.right - ar.left).toFixed(2),
    }
  }, id)
}

/**
 * 数一块矩形里有多少"墨"（亮度低于阈值的像素）。
 * 截图是 PNG，本脚本自带一个最小解码器 —— 探针里没有别的图像库，
 * zlib 是 node 内置的，够解 Playwright 截出来的 8bit RGB/RGBA 非隔行图。
 */
function countInk(buf, rect) {
  const img = decodePng(buf)
  const { x0, y0, x1, y1 } = rect
  let ink = 0
  for (let y = Math.max(0, Math.round(y0)); y < Math.min(img.h, Math.round(y1)); y++) {
    for (let x = Math.max(0, Math.round(x0)); x < Math.min(img.w, Math.round(x1)); x++) {
      const i = (y * img.w + x) * img.bpp
      const lum = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]
      if (lum < 200) ink++
    }
  }
  return ink
}

function decodePng(buf) {
  let off = 8
  const idat = []
  let w = 0, h = 0, color = 0
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.slice(off + 4, off + 8).toString('ascii')
    const d = buf.slice(off + 8, off + 8 + len)
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); color = d[9] }
    else if (type === 'IDAT') idat.push(d)
    off += 12 + len
  }
  if (!w) throw new Error('不是 PNG')
  const bpp = color === 2 ? 3 : 4
  const raw = require('node:zlib').inflateSync(Buffer.concat(idat))
  const stride = w * bpp
  const out = Buffer.alloc(h * stride)
  let p = 0
  for (let y = 0; y < h; y++) {
    const f = raw[p++]
    const cur = out.slice(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev ? prev[x] : 0
      const c = (prev && x >= bpp) ? prev[x - bpp] : 0
      let v = raw[p++]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      }
      cur[x] = v & 0xff
    }
  }
  return { w, h, bpp, data: out }
}

async function main() {
  const { board, tasks, project } = fixture()
  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox'],
  })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage()
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  try {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('wb.boardView.v1', 'kanban')
        // 预置「全部项目」：全新上下文里 savedSelection === null 时 applyDefaultSelection()
        // 会把选中项落到「当前项目」，这里直接给上，省一次点击也少一处时序依赖
        localStorage.setItem('wb.boardProject.v1', '')
      } catch { /* 隐私模式 */ }
    })
    const json = (route, body) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(body),
    })
    await page.route('**/api/workbench/projects*', (route) =>
      json(route, { success: true, projects: [project], tasks: board, currentProjectPath: PROJECT_PATH }))
    await page.route('**/api/workbench/tasks*', (route) => json(route, { tasks }))
    await page.route('**/api/workbench/jobs*', (route) => json(route, { jobs: [] }))
    await page.route('**/api/workbench/current-project*', (route) => json(route, { path: PROJECT_PATH }))

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.kb-card', { timeout: 15000 })
    await page.locator('.proj-item--all').first().click()
    await page.waitForSelector('.kb-card[data-task-id="syn-reply"]', { timeout: 15000 })
    await sleep(900)

    if (REVERSE) {
      // 反证：把遮罩打回改动前的样子（单层横向渐隐、没有纵向条带）。
      // !important 是必须的 —— 原规则挂在 :hover 上（还有 :not(.is-opened)），特异性更高。
      // 选择器必须跟原规则一一对应（标题那条还带着「row1 是最后一行」的 :has 判据）：
      // 写成分组选择器（无 :hover / 无 :has）的话，遮罩会**常驻**或跑到不该遮的标题上，
      // 于是「找带 mask 的那个元素」先撞上标题，A1/D 全被带偏（踩过）。
      await page.addStyleTag({
        content: `
          .kb-card:hover .kb-card__reply,
          .kb-card:hover .kb-card__live > :last-child,
          .kb-card:hover .kb-card__row1:not(:has(~ *:not(.kb-card__actions))) .kb-card__title {
            -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 118px), transparent calc(100% - 102px)) !important;
            mask-image: linear-gradient(to right, #000 calc(100% - 118px), transparent calc(100% - 102px)) !important;
            -webkit-mask-composite: source-over !important;
            mask-composite: add !important;
          }`,
      })
      log('已注入改动前的遮罩（单层横向渐隐）')
    }

    /** 悬停到卡片正中（读完坐标再动鼠标：DOM 会随轮询重排，边读边动会飘） */
    const hover = async (id) => {
      const box = await readBox(page, id)
      await page.mouse.move(box.x, box.y)
      await sleep(350)
      return readMask(page, id)
    }

    // ── A / B / C / D 三行引文那张 ──────────────────────────────────
    const reply = await hover('syn-reply')
    check('A1 被遮的是引文（卡片的最后一块），不是标题',
      /kb-card__reply/.test(reply.masked || ''), `被遮=${reply.masked}`)
    check('A2 操作组左边缘落在横向完全透明区里（不露半截字形）',
      reply.gapToMask <= reply.hTransparent,
      `gap=${reply.gapToMask}px ≤ 透明区 ${reply.hTransparent}px`)
    check('D 引文确实折到了 ≥2 行（否则下面两条是空断言）',
      reply.lineCount >= 2, `行数=${reply.lineCount} 行高=${reply.lineHeight}`)
    if (REVERSE) {
      check('R1 反证：单层遮罩下没有纵向层（B 会翻红）',
        reply.bandTop === null && reply.layers === 1,
        `layers=${reply.layers} bandTop=${reply.bandTop}`)
    } else {
      check('B1 遮罩是「横向渐隐 + 带外不透明」两层，且按 add 合成',
        reply.layers === 2 && /^add/.test(reply.composite || ''),
        `layers=${reply.layers} composite=${reply.composite}`)
      check('B2 纵向过渡带起点不低于倒数第二行的行盒下沿（那行一像素都不受影响）',
        reply.bandTop != null && reply.lineHeight > 0 && reply.bandTop >= reply.lineHeight,
        `bandTop=${reply.bandTop}px ≥ 行高 ${reply.lineHeight}px`)
      check('C1 纵向过渡带终点 ≥ 操作组盒顶（整组按钮落在全透明带里）',
        reply.bandEnd != null && reply.bandEnd >= reply.actionsTopAbove,
        `bandEnd=${reply.bandEnd}px ≥ 组盒顶 ${reply.actionsTopAbove}px`)
      check('C2 纵向过渡带终点 ≤ 末行行盒上沿（末行右侧仍被完整遮住，上一行完全不受影响）',
        reply.bandEnd != null && reply.lineHeight > 0 && reply.bandEnd <= reply.lineHeight,
        `bandEnd=${reply.bandEnd}px ≤ 行高 ${reply.lineHeight}px`)
    }

    // ── E 活动区那行（line-clamp: 2）走同一套条带 ────────────────────
    const live = await hover('syn-live')
    check('E1 活动区最后一行被遮，操作组左边缘落在它的透明区里',
      /kb-card__live/.test(live.masked || '') && live.gapToMask <= live.hTransparent,
      `被遮=${live.masked} gap=${live.gapToMask} ≤ ${live.hTransparent}`)
    if (!REVERSE) {
      check('E2 活动区那条同样限在纵向条带里（两行时上一行不透明、按钮整组被盖住）',
        live.lineCount >= 2 && live.bandTop != null && live.lineHeight > 0
        && live.bandTop >= live.lineHeight
        && live.bandEnd != null && live.bandEnd >= live.actionsTopAbove
        && live.bandEnd <= live.lineHeight,
        `行数=${live.lineCount} bandTop=${live.bandTop} ≥ ${live.lineHeight} / bandEnd=${live.bandEnd} ∈ [${live.actionsTopAbove}, ${live.lineHeight}]`)
    }

    // ── 单行卡：条带比元素还高，两个 stop 都被 clamp，等价于整行渐隐 ────
    const idle = await hover('syn-idle')
    check('E3 单行卡（只有标题）：遮罩照旧挂在标题上，组落在它的透明区里',
      /kb-card__title/.test(idle.masked || '') && idle.gapToMask <= idle.hTransparent,
      `被遮=${idle.masked} gap=${idle.gapToMask} ≤ ${idle.hTransparent}`)

    // ── P 数像素：这一条才是用户诉求本身 ──────────────────────────────
    // 量出来的 CSS 数字全绿也可能是"遮了个寂寞"（第一版 intersect 就是这么骗过了全部
    // 几何断言的：层数对、stop 对，截图与改动前逐像素一致）。所以最后直接拍一张卡，
    // 在**倒数第二行右端、横向完全透明区之内**数墨：
    //   · 改动后这里仍然是字 → 必须数得到墨
    //   · 改动前这里是空白 → 一颗墨都没有（--reverse 断言的就是这条）
    await hover('syn-reply')
    const penult = (await readMask(page, 'syn-reply')).penultBox
    const card = (await readMask(page, 'syn-reply')).cardBox
    const clip = { x: Math.max(0, card.x - 8), y: Math.max(0, card.y - 8), width: card.width + 16, height: card.height + 16 }
    const shot = path.resolve(__dirname, '../tmp/verify-wb-card-fade-band.png')
    const shotBuf = await page.screenshot({ path: shot, clip })
    log('截图:', shot)
    check('P0 有倒数第二行可数（guard）', !!penult && reply.lineCount >= 2,
      penult ? `行盒 top=${penult.top.toFixed(1)} right=${penult.right.toFixed(1)}` : '没量到')
    if (penult) {
      // 取行右端往左 30~14px 那一竖条：既在文字范围内，又整条落在完全透明区里
      const strip = {
        x0: penult.right - 30 - clip.x,
        x1: penult.right - 14 - clip.x,
        y0: penult.top + 1 - clip.y,
        y1: penult.bottom - 1 - clip.y,
      }
      const ink = countInk(shotBuf, strip)
      if (REVERSE) {
        check('R3 反证：单层遮罩下倒数第二行右端**数不到墨**（那就是"一片空白"）',
          ink === 0, `墨=${ink}px（期望 0）`)
      } else {
        check('P1 倒数第二行右端（横向完全透明区之内）仍有字 —— 只有按钮那一条带被洗掉',
          ink >= 3, `墨=${ink}px（期望 ≥3）`)
      }
    }

    check('H1 页面无 console / page 错误', consoleErrors.length === 0 && pageErrors.length === 0,
      [...consoleErrors, ...pageErrors].slice(0, 3).join(' | '))
  } finally {
    // 只关自己起的这个浏览器实例（按 CDP，不用 taskkill /IM —— 那会连带关掉用户的浏览器）
    await browser.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n[verify] ${results.length - failed.length}/${results.length} 通过${REVERSE ? '（反证模式：遮罩已打回改动前，R 组确认旧行为可观测 → B/C 的判据是真的）' : ''}`)
  for (const f of failed) console.log(`  FAIL  ${f.name}  ::  ${f.extra}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify] 异常退出:', err); process.exit(1) })
/**
 * 工作台弹窗链路验证（多项目编排台）。
 *
 * 验收的行为契约（改这块 UI 时别破坏）：
 *   A 看板是**常驻底图** —— 它不再和编辑器二选一
 *   B 点看板卡片 -> **直接打开任务编辑器弹窗**，看板仍在（不再有中间的只读详情弹窗）
 *   C 关掉编辑器 -> 还在看板原处
 *   D 看板「待处理」列末尾的「新建任务」-> 新建弹窗，看板仍在
 *   E 创建成功 -> 成功提示 + 弹窗自动关 + 卡片直接落在看板上
 *   F 点卡片 -> 编辑器以**大弹窗**浮在看板上，看板仍在
 *   G 点「返回看板」-> 编辑器弹窗关闭，看板仍在
 *   H 编辑器里点「执行日志」-> 日志弹窗必须压在编辑器之上
 *     （app shell 的 main-container 是 fixed + z-index:1001 的层叠上下文，
 *      内部弹窗不加 append-to-body 就会被关在里面、永远盖不过 body 层的编辑器弹窗）
 *
 * 另含两条易回归的点：
 *   D3/D4 项目下拉必须自动选中**当前项目**（项目条目 key 是归一化路径、path 是原始路径，
 *         两个口径搞混就会让下拉显示空白、提示错说成"跟随当前目录"）
 *   F2    编辑器弹窗宽度必须 ≥1200px（用户明确要求"弹窗可以做得比较大"）
 *
 * 新建弹窗的附件链路（2026-10-09 补，契约是「任务还不存在时先落暂存区」）：
 *   D5 在弹窗里粘一张图 -> 恰好 1 个草稿附件（回归：@paste 只挂一层，挂两层会重复上传）
 *   D6 缩略图必须走**暂存端点** /api/workbench/orchestrator/attachments/:id/raw
 *      且真的加载出来（任务侧端点此刻一定 404）—— 顺带记下 id 供后面查暂存文件
 *   D9 中文文件名也要传得上去（HTTP 头只认 ISO-8859-1，前端不 encode 就发不出去）
 *   D7 点「取消」-> 暂存文件被删掉（放弃新建就不该在 _dispatch/ 里堆截图）
 *   D8 再次打开弹窗 -> 草稿为空（上一条的附件不会跟到这一次）
 *   E5 创建请求带上附件后，任务记录里的附件已落到 `_task-{id}/`（不是还躺在暂存区）
 *
 * 前置：dev server 已启动（npm run dev，前端 5544）。
 * 用法：node scripts/verify-workbench-dialogs.cjs
 * 退出码：0 全通过，1 有失败项。
 */
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544'
const MARK = '【弹窗验证】' + Date.now().toString().slice(-6)
const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 当前**可见**的弹窗（overlay 为 display:none 时 offsetParent 为 null，正好用来判可见） */
async function visibleDialogs(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.el-dialog'))
      .filter(d => d.offsetParent !== null)
      .map(d => ({
        title: d.querySelector('.el-dialog__title')?.textContent?.trim() || '',
        hasEditor: !!d.querySelector('.wb-editor'),
        hasCreate: !!d.querySelector('.nc')
      }))
  )
}

async function waitDialog(page, pred, timeout = 6000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const hit = (await visibleDialogs(page)).find(pred)
    if (hit) return hit
    await sleep(120)
  }
  return null
}

async function noVisibleDialog(page, timeout = 6000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if ((await visibleDialogs(page)).length === 0) return true
    await sleep(120)
  }
  return false
}

async function boardVisible(page) {
  const el = page.locator('.board').first()
  return (await el.count()) > 0 && (await el.isVisible())
}

/** 轮询直到条件成立（上传要经 vite 代理转发，偶发慢到 2.5s，别用固定 sleep 等） */
async function waitUntil(fn, timeout = 12000, interval = 150) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true
    await sleep(interval)
  }
  return false
}

// 1x1 红点 PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 往新建弹窗根节点派发一次「粘贴了一张 PNG」事件（模拟用户 Ctrl+V） */
async function pastePng(page, fileName) {
  await page.evaluate(({ b64, fileName }) => {
    const el = document.querySelector('.nc')
    if (!el) throw new Error('找不到新建弹窗根节点 .nc')
    const bin = atob(b64)
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    const file = new File([arr], fileName, { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, { b64: PNG_B64, fileName })
}

/** 弹窗里草稿附件的原始文件地址形如 /api/workbench/orchestrator/attachments/<id>/raw */
const STAGING_RE = /\/api\/workbench\/orchestrator\/attachments\/([^/]+)\/raw/

/**
 * 等这一轮上传真的结束。
 *
 * 必须先等"开始了"（出现附件或按钮转成「上传中…」）再等"结束了"：
 * 直接看按钮文案会在上传还没开始时就读到「添加附件」，把还在飞的那一份漏掉，
 * 于是重复上传（@paste 挂两层）反而"通过"。
 */
async function uploadSettled(page) {
  await waitUntil(async () => {
    const n = await page.locator('.nc .wb-attachment').count()
    if (n > 0) return true
    const t = await page.locator('.nc .wb-attachments__add').first().textContent().catch(() => '')
    return !!t && /上传中/.test(t)
  })
  return await waitUntil(async () => {
    const t = await page.locator('.nc .wb-attachments__add').first().textContent().catch(() => '')
    return !!t && !/上传中/.test(t)
  })
}

async function main() {
  // ── 造一条测试任务 ────────────────────────────────────────────────────
  const created = await fetch(`${BASE}/api/workbench/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: MARK, desc: '用于验证弹窗链路', promptId: null, simpleOverride: '' })
  }).then(r => r.json()).catch(() => null)
  if (!created?.success) { console.error('无法创建测试任务，dev server 起了吗？', created); process.exit(2) }
  const taskId = created.task.id
  log('测试任务:', MARK, taskId)

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.board', { timeout: 15000 })
    await sleep(2500)

    check('A 看板作为常驻底图渲染', await boardVisible(page))

    // 切到「全部项目」，保证刚建的任务可见
    const allProj = page.locator('.proj-item--all')
    if (await allProj.count()) { await allProj.first().click(); await sleep(800) }

    // ── B 点卡片 -> 编辑器弹窗（不跳转、不再有中间的只读详情弹窗）────────
    const card = page.locator('.kb-card', { hasText: MARK }).first()
    if (!(await card.count())) {
      check('B 点卡片 -> 编辑器弹窗（能否找到目标卡片）', false, '看板上没有测试任务卡片')
    } else {
      await card.click()
      const dlg = await waitDialog(page, d => d.hasEditor, 12000)
      check('B 点卡片 -> 编辑器弹窗直接打开', !!dlg, dlg ? `title="${dlg.title}"` : '未出现编辑器弹窗')
      check('B2 弹窗打开时看板仍在（无视图跳转）', await boardVisible(page))
    }

    // ── C 返回看板 ────────────────────────────────────────────────────
    await page.locator('.wb-back-btn').first().click()
    check('C 关闭编辑器后无可见弹窗', await noVisibleDialog(page, 12000))
    check('C2 关闭后看板仍在', await boardVisible(page))

    // ── D 新建走弹窗 ─────────────────────────────────────────────────
    // 入口是看板「待处理」列末尾的幽灵项（顶栏那个「新建开发任务」按钮 2026-09-29 去掉了）
    await page.locator('.kb-col__add-btn').first().click()
    const cdlg = await waitDialog(page, d => d.hasCreate)
    check('D 「新建任务」打开新建弹窗', !!cdlg, cdlg ? `title="${cdlg.title}"` : '未出现新建弹窗')
    check('D2 新建弹窗打开时看板仍在', await boardVisible(page))

    // ── D3/D4 项目下拉口径 ───────────────────────────────────────────
    const sel = await page.evaluate(() => {
      const s = document.querySelector('#nc-project')
      if (!s) return null
      const opt = Array.from(s.options).find(o => o.value === s.value)
      return { value: s.value, matchedText: opt ? opt.textContent.trim() : null, hint: document.querySelector('.nc__hint')?.textContent?.trim() || '' }
    })
    check('D3 项目下拉自动匹配到当前项目（非空白）', !!(sel && sel.value && sel.matchedText), sel ? `value="${sel.value}" -> "${sel.matchedText}"` : '找不到下拉')
    check('D4 归属提示指向真实项目', !!(sel && sel.hint && !/跟随/.test(sel.hint)), sel ? `hint="${sel.hint}"` : '')

    // ── D5/D6 附件：草稿先落暂存区，缩略图必须走暂存端点 ──────────────
    await pastePng(page, 'dialog-draft.png')
    await uploadSettled(page)
    const draftN = await page.locator('.nc .wb-attachment').count()
    check('D5 弹窗里粘图 -> 恰好 1 个草稿附件', draftN === 1, `实测 ${draftN} 个`)

    const thumb = await page.evaluate(() => {
      const img = document.querySelector('.nc .wb-attachment__icon img')
      return img ? { src: img.getAttribute('src') || '', w: img.naturalWidth } : null
    })
    const draftId = (thumb?.src.match(STAGING_RE) || [])[1] || ''
    // 任务还不存在，走任务侧端点必然 404；这里同时钉住"端点对"与"图真的加载出来了"
    check('D6 草稿缩略图走暂存端点且真的加载出来',
      !!thumb && /orchestrator\/attachments/.test(thumb.src) && thumb.w > 0,
      thumb ? `src=${thumb.src} naturalWidth=${thumb.w}` : '没渲染出缩略图')

    // ── D9 中文文件名 ─────────────────────────────────────────────────
    // HTTP 头只允许 ISO-8859-1，前端不 encodeURIComponent 的话浏览器在 fetch 阶段
    // 就抛错 —— 上传根本没发出去，用户只看到"上传失败"（截图存成中文名太常见了）。
    await pastePng(page, '登录模块-改造前.png')
    const cnN = await waitUntil(async () => (await page.locator('.nc .wb-attachment').count()) === 2)
    await uploadSettled(page)
    const cnName = ((await page.locator('.nc .wb-attachment__name').last().textContent().catch(() => '')) || '').trim()
    check('D9 中文文件名能传上去且名字不走样', cnN && cnName === '登录模块-改造前.png',
      `实测 ${await page.locator('.nc .wb-attachment').count()} 个，末条名字="${cnName}"`)

    // ── D7/D8 取消 -> 暂存文件清掉；再打开 -> 草稿不留痕 ───────────────
    const draftIds = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.nc .wb-attachment__icon img'))
        .map(img => (img.getAttribute('src') || '').match(/\/orchestrator\/attachments\/([^/]+)\/raw/)?.[1])
        .filter(Boolean)
    )
    await page.locator('.nc__foot .nc__btn').first().click()
    check('D7 点「取消」关闭新建弹窗', await noVisibleDialog(page))
    const allGone = draftIds.length > 0 && await waitUntil(async () => {
      for (const id of draftIds) {
        const r = await fetch(`${BASE}/api/workbench/orchestrator/attachments/${encodeURIComponent(id)}/raw`)
        if (r.status !== 404) return false
      }
      return true
    })
    check('D7b 取消后暂存区的草稿附件全部被清掉', allGone,
      draftIds.length ? `${draftIds.length} 个：${draftIds.join(', ')}（含最初粘的那个 ${draftId}）` : '没从缩略图拿到草稿 id')

    await page.locator('.kb-col__add-btn').first().click()
    const cdlg2 = await waitDialog(page, d => d.hasCreate)
    const reopenN = await page.locator('.nc .wb-attachment').count()
    check('D8 重新打开弹窗时草稿为空（上一次的附件不跟过来）', !!cdlg2 && reopenN === 0, `实测 ${reopenN} 个`)

    // ── E 创建 -> 提示 + 关闭 + 上板（这一次带一张附件）─────────────────
    await page.fill('#nc-title', MARK)
    await pastePng(page, 'dialog-created.png')
    await uploadSettled(page)
    await page.locator('.nc__foot .nc__btn--primary').first().click()
    // 认「已创建任务」这条，而不是"随便哪条 success toast" —— 前面粘图时的那条
    // 「已添加：xxx」还在屏幕上挂着，按 `.el-message--success` 取第一条会白捡一个绿。
    const toastOk = await page.locator('.el-message--success', { hasText: '已创建任务' }).first()
      .waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)
    check('E 创建成功出现成功提示', toastOk, toastOk ? ((await page.locator('.el-message--success', { hasText: '已创建任务' }).first().textContent()) || '').trim() : '')
    check('E2 创建后新建弹窗自动关闭', await noVisibleDialog(page))

    let cardThere = false
    for (let i = 0; i < 20 && !cardThere; i++) {
      cardThere = (await page.locator('.kb-card', { hasText: MARK }).count()) > 0
      if (!cardThere) await sleep(500)
    }
    check('E3 新任务卡片出现在看板上（未离开看板）', cardThere)
    check('E4 创建全程看板仍在', await boardVisible(page))

    // ── E5/E6 服务端把暂存附件认领进了任务目录 ─────────────────────────
    // 按"带附件的那条 MARK 任务"取样：开头为了验弹窗直接 POST 过一条同名任务（无附件）。
    const withAtt = (await fetch(`${BASE}/api/workbench/tasks`).then(r => r.json()).catch(() => ({})))
      .tasks?.find(t => t && t.title === MARK && (t.attachments || []).length > 0) || null
    const atts = withAtt?.attachments || []
    check('E5 新任务的附件已从暂存区搬进 _task-{id}/',
      atts.length === 1 && /[\\/]_task-[^\\/]+[\\/]/.test(atts[0]?.absolutePath || ''),
      atts.length ? `count=${atts.length} path=${atts[0].absolutePath}` : '任务上没有附件')
    const claimed = atts[0]
      ? await fetch(`${BASE}/api/workbench/orchestrator/attachments/${encodeURIComponent(atts[0].id)}/raw`).then(r => r.status === 404)
      : false
    check('E6 暂存区里那份已被认领（raw 404，不留双份）', claimed)

    // ── F 点卡片 -> 编辑器大弹窗 ─────────────────────────────────────
    // （这里顺带钉住"点卡片不再被中间的只读详情弹窗拦一道"：一次点击就该看到 .wb-editor）
    const card2 = page.locator('.kb-card', { hasText: MARK }).first()
    if (!(await card2.count())) {
      check('F 打开编辑器链路', false, '创建后找不到卡片')
    } else {
      await card2.click()
      const edlg = await waitDialog(page, d => d.hasEditor, 12000)
      check('F 点卡片一次点击即打开编辑器弹窗', !!edlg, edlg ? `title="${edlg.title}"` : '未出现编辑器弹窗')
      if (edlg) {
        const w = await page.evaluate(() => {
          const d = Array.from(document.querySelectorAll('.el-dialog')).find(x => x.offsetParent !== null && x.querySelector('.wb-editor'))
          return d ? Math.round(d.getBoundingClientRect().width) : 0
        })
        check('F2 编辑器弹窗是"大弹窗"（宽度 ≥ 1200px）', w >= 1200, `实测 ${w}px`)
        check('F3 编辑器打开时看板仍在 DOM（无跳转）', (await page.locator('.board').count()) > 0)

        // ── H 从编辑器里打开的子弹窗必须压得住编辑器 ──────────────────
        // app shell 的 main.main-container 是 position:fixed + z-index:1001，自成层叠上下文；
        // 没 append-to-body 的弹窗被关在里面，z-index 再高也只跟"同一上下文里的兄弟"比，
        // 永远盖不过挂在 body 下的编辑器弹窗 —— 现象是「点了执行日志没反应」，其实开了、被盖住了。
        await page.locator('button', { hasText: '执行日志' }).first().click()
        await sleep(1200)
        const logsTop = await page.evaluate(() => {
          const d = document.querySelector('.wb-logs-dialog')
          if (!d) return { exists: false }
          const r = d.getBoundingClientRect()
          const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + 120))
          const ov = d.closest('.el-overlay')
          return {
            exists: true,
            escaped: !!(ov && ov.parentElement === document.body),
            topmost: !!(hit && hit.closest('.wb-logs-dialog'))
          }
        })
        check('H 「执行日志」弹窗压在编辑器之上（已逃出 main-container）',
          logsTop.exists && logsTop.escaped && logsTop.topmost, JSON.stringify(logsTop))
        if (logsTop.exists) {
          await page.locator('.wb-logs-dialog .el-dialog__headerbtn').first().click()
          await sleep(900)
        }
      }
      await page.locator('.wb-back-btn').first().click()
      check('G 「返回看板」关闭编辑器弹窗', await noVisibleDialog(page, 12000))
      check('G2 关闭后看板仍在', await boardVisible(page))
    }
  } catch (err) {
    check('脚本异常', false, String((err && err.message) || err))
  } finally {
    // 清场：本脚本一共会造出**两个**叫 MARK 的任务 —— 开头自己 POST 的那个，
    // 以及步骤 E 通过 UI 新建的那个。只删 taskId 会漏掉后者，于是每跑一次就在
    // 用户看板上留一张卡（实测连跑 4 次留了 4 张）。按标题扫一遍最省事。
    //
    // ⚠️ 必须**串行**删。DELETE 处理器是"读 tasks.json → 过滤 → 写回"，两个并发
    // 请求会互相覆盖（后写的把先写的回滚），结果必然漏掉一个 —— 用 Promise.all
    // 发出去看着都返回 200，实际只生效一次（踩过）。
    try {
      const list = await fetch(`${BASE}/api/workbench/tasks`).then(r => r.json())
      for (const t of (list.tasks || [])) {
        if (!t || t.title !== MARK) continue
        await fetch(`${BASE}/api/workbench/tasks/${encodeURIComponent(t.id)}`, { method: 'DELETE' })
      }
    } catch { /* 清理失败不该盖住断言结果 */ }
    await browser.close()
  }

  console.log('\n================ 汇总 ================')
  const failed = results.filter(r => !r.ok)
  console.log(`用例 ${results.length} 个，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  failed.forEach(f => console.log(`  - ${f.name} ${f.extra}`))
  // 「获取当前目录失败 / Failed to fetch」是刷新时的既有噪音，与本链路无关
  const realErrors = consoleErrors.filter(e => !/Failed to fetch|获取当前目录失败/.test(e))
  console.log(`控制台错误(过滤已知噪音): ${realErrors.length}`)
  realErrors.slice(0, 8).forEach(e => console.log('  ! ' + e.slice(0, 220)))
  console.log(`页面异常: ${pageErrors.length}`)
  pageErrors.slice(0, 5).forEach(e => console.log('  ! ' + e.slice(0, 220)))
  process.exit(failed.length ? 1 : 0)
}

main()

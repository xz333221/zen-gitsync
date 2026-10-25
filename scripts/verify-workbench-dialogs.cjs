/**
 * 工作台弹窗链路验证（多项目编排台）。
 *
 * 验收的行为契约（改这块 UI 时别破坏）：
 *   A 看板是**常驻底图** —— 它不再和编辑器二选一
 *   B 点看板卡片 -> **直接打开任务编辑器弹窗**，看板仍在（不再有中间的只读详情弹窗）
 *   C 关掉编辑器 -> 还在看板原处
 *   D 看板「待处理」列末尾的「新建任务」-> **直接打开任务编辑器**（2026-10-25），
 *     不再有独立的 600px 窄窗，也没有另做的"草稿表单"：标题 / 描述 / 附件 / 执行
 *     全部复用编辑器里已有的那套组件，光标直接落在标题输入框里
 *   E 填标题即落盘 -> 卡片出现在看板上（同一个编辑器里完成，不用再点"创建"）
 *   F 点卡片 -> 编辑器以**大弹窗**浮在看板上，看板仍在
 *   G 点「返回看板」-> 编辑器弹窗关闭，看板仍在
 *   H 编辑器里点「执行日志」-> 日志弹窗必须压在编辑器之上
 *     （app shell 的 main-container 是 fixed + z-index:1001 的层叠上下文，
 *      内部弹窗不加 append-to-body 就会被关在里面、永远盖不过 body 层的编辑器弹窗）
 *
 * 另含几条易回归的点：
 *   D2b   光标必须真落在**空的**标题框里 —— 只看"编辑器开着"的话，
 *         新建退化成"打开某条老任务"也照样绿
 *   D3    新任务必须带上 projectPath（新建下拉没了，落点跟看板当前筛选走；
 *         不验这条，任务会默默落到另一个项目下）
 *   D7b   什么都没填就返回 -> 那条空任务要被丢弃，看板不留「未命名任务」
 *   F2    编辑器弹窗宽度必须 ≥1200px（用户明确要求"弹窗可以做得比较大"）
 *
 * 草稿附件（先落 `_dispatch/` 暂存区、创建时认领进 `_task-{id}/`）那条链路
 * 现在只存在于主 Agent 控制台的派发入口，由 verify-workbench-dispatch-attach.cjs 覆盖 ——
 * 新建任务已经没有"任务还不存在"的中间态了，所以这里不再验暂存端点。
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

    // ── D 新建 = 直接进任务编辑器（复用编辑器里的那套组件）──────────────
    // 2026-10-25：不再有独立的 600px 新建弹窗，也没有另做的"草稿表单"。
    // 点新建 = 立刻建一条空白任务 + 顶起编辑器 + 光标落在标题上。
    const beforeIds = await fetch(`${BASE}/api/workbench/tasks`)
      .then(r => r.json()).then(j => (j.tasks || []).map(t => t.id)).catch(() => [])
    await page.locator('.kb-col__add-btn').first().click()
    const cdlg = await waitDialog(page, d => d.hasEditor, 12000)
    check('D 「新建任务」直接打开任务编辑器', !!cdlg, cdlg ? `title="${cdlg.title}"` : '未出现编辑器')
    check('D2 新建时看板仍在（弹窗浮在它上面）', await boardVisible(page))

    // 光标必须落在标题框、且值为空 —— 否则"新建"就退化成"打开某条老任务"
    const dInfo = await waitUntil(async () => {
      const v = await page.evaluate(() => {
        const inp = document.querySelector('.wb-split__title-wrap .wb-input--title')
        return inp ? { value: inp.value, focused: document.activeElement === inp } : null
      })
      return v && v.value === '' && v.focused ? v : null
    })
    check('D2b 光标落在空的标题输入框里（直接打字即可）', !!dInfo)

    // 任务列表按创建时间升序，新任务排在这一组最后 —— 不自动滚过去的话，
    // 用户建完只看到一堆老任务，会以为没建上
    const inView = await page.evaluate(() => {
      const el = document.querySelector('.wb-task-item.active')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return r.top >= 0 && r.bottom <= window.innerHeight
    })
    check('D2c 新建的任务在左栏可见（自动滚到它）', inView === true, String(inView))

    // D3 项目落点：新建表单里的下拉没有了，落点跟看板当前筛选走
    // （脚本前面切到了「全部项目」→ 用应用当前目录）。这条得验，否则任务会默默落错项目。
    const fresh = (await fetch(`${BASE}/api/workbench/tasks`).then(r => r.json()).catch(() => ({})))
      .tasks?.find(t => t && !beforeIds.includes(t.id)) || null
    const curDir = await fetch(`${BASE}/api/current_directory`).then(r => r.json()).catch(() => ({}))
    const norm = (p) => String(p || '').trim().toLowerCase().replace(/[\\/]+$/, '')
    check('D3 新任务落在「全部项目」视图下的应用当前目录',
      !!fresh && !!norm(fresh.projectPath) && norm(fresh.projectPath) === norm(curDir.directory),
      fresh ? `projectPath="${fresh.projectPath}" 当前目录="${curDir.directory || ''}"` : '没找到刚建的任务')

    // ── D7/D8 空着没填就走 -> 不留「未命名任务」；再新建仍是空的 ────────
    const blankId = fresh?.id || ''
    await page.locator('.wb-back-btn').first().click()
    check('D7 返回看板关闭编辑器', await noVisibleDialog(page, 12000))
    const gone = await waitUntil(async () => {
      const list = await fetch(`${BASE}/api/workbench/tasks`)
        .then(r => r.json()).then(j => j.tasks || []).catch(() => [])
      return !!blankId && !list.some(t => t.id === blankId)
    })
    check('D7b 没填内容的空任务被丢弃（看板不留脏卡）', gone, `id=${blankId}`)

    await page.locator('.kb-col__add-btn').first().click()
    const cdlg2 = await waitDialog(page, d => d.hasEditor, 12000)
    const again = await page.locator('.wb-split__title-wrap .wb-input--title').first().inputValue().catch(() => '?')
    check('D8 再次新建时标题为空（上一次的残渣不跟过来）', !!cdlg2 && again === '', `value="${again}"`)

    // ── E 填标题 -> 自动落盘 -> 卡片上板（全程在这一个编辑器里完成）──────
    await page.fill('.wb-split__title-wrap .wb-input--title', MARK)
    check('E 直接复用编辑器：标题写进输入框（没有第二个"创建"按钮）',
      (await page.locator('.wb-split__title-wrap .wb-input--title').first().inputValue()) === MARK)

    let cardThere = false
    for (let i = 0; i < 40 && !cardThere; i++) {
      cardThere = (await page.locator('.kb-card', { hasText: MARK }).count()) > 0
      if (!cardThere) await sleep(500)
    }
    check('E2 标题落盘后卡片出现在看板上（未离开看板）', cardThere)
    check('E3 填写全程看板仍在', await boardVisible(page))

    // F 要回到看板点卡片：先把编辑器正常关掉
    await page.locator('.wb-back-btn').first().click()
    check('E3b 从编辑器返回看板', await noVisibleDialog(page, 12000))

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

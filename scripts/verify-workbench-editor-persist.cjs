/**
 * 工作台编辑器「写操作后不丢选中项」回归验证。
 *
 * 钉住的是 2026-09-20 修的那个 bug，症状：**改一下任务描述、自动保存后编辑器就空了**。
 *
 * 机理：任务级字段（title / desc / promptId / simpleOverride）走 1.5s 防抖自动保存，
 * 每次自动保存都会 POST → 成功 → 重拉任务列表。而重拉这一步如果顺带**重推导选中项**
 * （loadTasks() 的老行为），就会踩到它那条"记忆中的任务必须属于当前项目"的护栏：
 *   - 编辑器允许打开**别的项目**的任务（跨项目看板上点的卡片，执行目录按 task.projectPath 走）；
 *   - 而 localStorage 里记的"该项目上次打开的任务"是用**当前项目**当键、值是这条外项目任务；
 *   - 于是 desiredId 被算成 null → selectedTask 变 null → 右侧退回"请选择任务"占位。
 * 描述其实早存好了，空掉的是界面里的选中项。
 *
 *   A 跨项目任务能在编辑器里正常打开（标题/描述就位，不是空白占位）
 *   B 改描述 → 自动保存后**编辑器仍停在这条任务**（标题还在、没有退回空白占位）
 *   C 描述确实落盘（后端读得到），证明"空掉"的只是 UI
 *   D 「任务类型」切换控件已移除，编辑器里不该再出现（防回归）
 *
 * 前置：dev server 已启动（npm run dev，前端 5544）。
 * 用法：node scripts/verify-workbench-editor-persist.cjs
 * 退出码：0 全通过，1 有失败项。
 */
const os = require('node:os')
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544'
const API = BASE
const MARK = '【选中项验证】' + Date.now().toString().slice(-6)
const DESC = '自动保存不该把我正在编辑的任务换掉。' + Date.now()
const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 归一化路径：只用来判断"这两个路径是不是同一个目录"（和前端 canonicalProjectPath 同口径） */
function norm(p) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

async function readTitleValue(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.wb-split__title-wrap .wb-input--title')
    return el ? el.value : null
  })
}

/** 编辑器是不是"空的"（右侧只剩空态占位 = 选中项被清掉了） */
async function editorBlanked(page) {
  return page.evaluate(() => {
    const ph = document.querySelector('.wb-split .wb-placeholder')
    return !!ph && ph.offsetParent !== null
  })
}

async function waitEditorVisible(page, timeout = 12000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const ok = await page.evaluate(() => {
      const el = document.querySelector('.wb-editor')
      return !!el && el.offsetParent !== null
    })
    if (ok) return true
    await sleep(300)
  }
  return false
}

async function main() {
  // ── 造一条**属于别的项目**的任务（当前项目由服务端 cwd 决定）────────────
  // ⚠️ 浏览器先起、任务后造：`chromium.launch` 在 try 之外，浏览器缺失（未 install）时
  // 直接抛在这里，若任务已经建好就没人清场了 —— 会在用户看板上留一张卡（踩过：
  // 一次 chromium 没装，留下一条 【选中项验证】xxx）。
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  const cp = await fetch(`${API}/api/workbench/current-project`).then(r => r.json()).catch(() => ({}))
  const currentProject = cp.projectPath || ''
  let otherProject = path.join(os.tmpdir(), 'zen-verify-other-project')
  if (norm(otherProject) === norm(currentProject)) otherProject = path.join(otherProject, 'nested')
  log('当前项目:', currentProject || '(空)')
  log('任务归属:', otherProject)

  const created = await fetch(`${API}/api/workbench/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: MARK, desc: '', promptId: null, simpleOverride: '',
      projectPath: otherProject
    })
  }).then(r => r.json())
  if (!created?.success) {
    console.error('造测试任务失败:', created?.error || created)
    await browser.close()
    process.exit(1)
  }
  const taskId = created.task.id
  log('测试任务:', MARK, taskId)
  check('前置 测试任务归属项目 ≠ 当前项目', norm(created.task.projectPath) !== norm(currentProject),
    `task=${created.task.projectPath} / current=${currentProject}`)

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.board', { timeout: 15000 })
    await sleep(2500)

    // 全部项目视角，保证这条外项目任务可见
    const allProj = page.locator('.proj-item--all')
    if (await allProj.count()) { await allProj.first().click(); await sleep(800) }

    // ── A 点卡片打开跨项目任务 ──────────────────────────────────────────
    const card = page.locator('.kb-card', { hasText: MARK }).first()
    let cardReady = (await card.count()) > 0
    for (let i = 0; i < 24 && !cardReady; i++) {
      await sleep(500)
      cardReady = (await card.count()) > 0
    }
    check('A 测试任务出现在看板上', cardReady)
    if (!cardReady) throw new Error('看板上找不到测试任务卡片')

    await card.click()
    const opened = await waitEditorVisible(page)
    check('A2 点卡片打开编辑器弹窗', opened)
    if (!opened) throw new Error('编辑器弹窗未出现')

    await sleep(600)
    check('A3 编辑器里是这条任务（标题就位）', (await readTitleValue(page)) === MARK,
      `title="${await readTitleValue(page)}"`)
    check('A4 编辑器没有退回空态占位', !(await editorBlanked(page)))

    // ── B 改描述 → 等自动保存（1.5s 防抖）──────────────────────────────
    // 描述折叠面板默认展开，这里防御性地再打开一次
    await page.evaluate(() => { document.querySelectorAll('details.wb-task-desc').forEach(d => { d.open = true }) })
    const descBox = page.locator('.wb-task-desc .wb-textarea--autogrow').first()
    await descBox.fill(DESC)
    log('已改描述，等 1.5s 防抖 + 保存 + 重拉...')
    await sleep(1200)
    await descBox.fill(DESC + '（补一笔，重置防抖）')   // 二次输入，确保走的是合并后的那一次保存
    await sleep(5500)

    const titleAfter = await readTitleValue(page)
    check('B 自动保存后编辑器仍停在原任务（标题未被换掉）', titleAfter === MARK, `title="${titleAfter}"`)
    check('B2 自动保存后没有退回空白占位', !(await editorBlanked(page)))
    const descAfter = await descBox.inputValue().catch(() => '')
    check('B3 描述输入框内容还在（没被清空）', descAfter.includes('自动保存不该把我正在编辑的任务换掉'),
      `desc="${descAfter.slice(0, 40)}..."`)

    // ── C 描述确实落盘 ─────────────────────────────────────────────────
    const list = await fetch(`${API}/api/workbench/tasks`).then(r => r.json())
    const saved = (list.tasks || []).find(t => t.id === taskId)
    check('C 描述已持久化到后端', !!(saved && (saved.desc || '').includes('重置防抖')),
      saved ? `desc="${(saved.desc || '').slice(0, 40)}..."` : '后端查不到该任务')
    check('C2 标题也被保留（没被清成空）', !!(saved && saved.title === MARK), saved ? `title="${saved.title}"` : '')

    // ── D 「任务类型」概念已移除：编辑器里不该再有简单/复杂切换控件 ──────
    // 这条同时是个回归守卫：哪天有人把类型切换加回来，这里会先红。
    const modeSwitchCount = await page.locator('.wb-mode-switch__btn').count()
    check('D 编辑器里不再出现任务类型切换控件', modeSwitchCount === 0, `count=${modeSwitchCount}`)
    check('D2 无类型控件后编辑器仍停在原任务', (await readTitleValue(page)) === MARK,
      `title="${await readTitleValue(page)}"`)
  } catch (err) {
    check('脚本异常', false, String((err && err.message) || err))
  } finally {
    // 清场：按标题扫一遍串行删（DELETE 是"读-改-写"，并发会互相覆盖）
    try {
      const list = await fetch(`${API}/api/workbench/tasks`).then(r => r.json())
      for (const t of (list.tasks || [])) {
        if (!t || t.title !== MARK) continue
        await fetch(`${API}/api/workbench/tasks/${encodeURIComponent(t.id)}`, { method: 'DELETE' })
      }
    } catch { /* 清理失败不该盖住断言结果 */ }
    await browser.close()
  }

  console.log('\n================ 汇总 ================')
  const failed = results.filter(r => !r.ok)
  console.log(`用例 ${results.length} 个，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  failed.forEach(f => console.log(`  - ${f.name} ${f.extra}`))
  const realErrors = consoleErrors.filter(e => !/Failed to fetch|获取当前目录失败/.test(e))
  console.log(`控制台错误(过滤已知噪音): ${realErrors.length}`)
  realErrors.slice(0, 8).forEach(e => console.log('  ! ' + e.slice(0, 220)))
  console.log(`页面异常: ${pageErrors.length}`)
  pageErrors.slice(0, 5).forEach(e => console.log('  ! ' + e.slice(0, 220)))
  process.exit(failed.length ? 1 : 0)
}

main()

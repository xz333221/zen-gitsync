/**
 * 工作台弹窗链路验证（多项目编排台）。
 *
 * 验收的行为契约（改这块 UI 时别破坏）：
 *   A 看板是**常驻底图** —— 它不再和编辑器二选一
 *   B 点看板卡片 -> 任务详情**就地弹窗**，看板仍在（不跳转）
 *   C 关掉详情 -> 还在看板原处
 *   D 「新建开发任务」-> 新建弹窗，看板仍在
 *   E 创建成功 -> 成功提示 + 弹窗自动关 + 卡片直接落在看板上
 *   F 详情里点「打开编辑器」-> 编辑器以**大弹窗**浮在看板上，看板仍在
 *   G 点「返回看板」-> 编辑器弹窗关闭，看板仍在
 *
 * 另含两条易回归的点：
 *   D3/D4 项目下拉必须自动选中**当前项目**（项目条目 key 是归一化路径、path 是原始路径，
 *         两个口径搞混就会让下拉显示空白、提示错说成"跟随当前目录"）
 *   F2    编辑器弹窗宽度必须 ≥1200px（用户明确要求"弹窗可以做得比较大"）
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
        hasCreate: !!d.querySelector('.nc'),
        hasDetail: !!d.querySelector('.td')
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

async function main() {
  // ── 造一条测试任务 ────────────────────────────────────────────────────
  const created = await fetch(`${BASE}/api/workbench/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: MARK, desc: '用于验证弹窗链路', type: 'complex', promptId: null, simpleOverride: '', subtasks: [] })
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

    // ── B 点卡片 -> 详情弹窗（不跳转）──────────────────────────────────
    const card = page.locator('.kb-card', { hasText: MARK }).first()
    if (!(await card.count())) {
      check('B 点卡片 -> 详情弹窗（能否找到目标卡片）', false, '看板上没有测试任务卡片')
    } else {
      await card.click()
      const dlg = await waitDialog(page, d => d.hasDetail)
      check('B 点卡片 -> 详情弹窗就地打开', !!dlg, dlg ? `title="${dlg.title}"` : '未出现详情弹窗')
      check('B2 弹窗打开时看板仍在（无视图跳转）', await boardVisible(page))
    }

    // ── C 关闭详情 ────────────────────────────────────────────────────
    await page.keyboard.press('Escape')
    check('C 关闭详情后无可见弹窗', await noVisibleDialog(page))
    check('C2 关闭后看板仍在', await boardVisible(page))

    // ── D 新建走弹窗 ─────────────────────────────────────────────────
    await page.locator('.board__actions button', { hasText: '新建开发任务' }).first().click()
    const cdlg = await waitDialog(page, d => d.hasCreate)
    check('D 「新建开发任务」打开新建弹窗', !!cdlg, cdlg ? `title="${cdlg.title}"` : '未出现新建弹窗')
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

    // ── E 创建 -> 提示 + 关闭 + 上板 ─────────────────────────────────
    await page.fill('#nc-title', MARK)
    await page.locator('.nc__foot .nc__btn--primary').first().click()
    const toastOk = await page.locator('.el-message--success').first()
      .waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)
    check('E 创建成功出现成功提示', toastOk, toastOk ? ((await page.locator('.el-message--success').first().textContent()) || '').trim() : '')
    check('E2 创建后新建弹窗自动关闭', await noVisibleDialog(page))

    let cardThere = false
    for (let i = 0; i < 20 && !cardThere; i++) {
      cardThere = (await page.locator('.kb-card', { hasText: MARK }).count()) > 0
      if (!cardThere) await sleep(500)
    }
    check('E3 新任务卡片出现在看板上（未离开看板）', cardThere)
    check('E4 创建全程看板仍在', await boardVisible(page))

    // ── F 详情 ->「打开编辑器」大弹窗 ────────────────────────────────
    const card2 = page.locator('.kb-card', { hasText: MARK }).first()
    if (!(await card2.count())) {
      check('F 打开编辑器链路', false, '创建后找不到卡片')
    } else {
      await card2.click()
      if (!(await waitDialog(page, d => d.hasDetail))) {
        check('F 详情弹窗复现', false, '第二次点卡片未出详情弹窗')
      } else {
        await page.locator('.td__foot button', { hasText: '打开编辑器' }).first().click()
        const edlg = await waitDialog(page, d => d.hasEditor, 12000)
        check('F 「打开编辑器」打开编辑器弹窗', !!edlg, edlg ? `title="${edlg.title}"` : '未出现编辑器弹窗')
        if (edlg) {
          const w = await page.evaluate(() => {
            const d = Array.from(document.querySelectorAll('.el-dialog')).find(x => x.offsetParent !== null && x.querySelector('.wb-editor'))
            return d ? Math.round(d.getBoundingClientRect().width) : 0
          })
          check('F2 编辑器弹窗是"大弹窗"（宽度 ≥ 1200px）', w >= 1200, `实测 ${w}px`)
          check('F3 编辑器打开时看板仍在 DOM（无跳转）', (await page.locator('.board').count()) > 0)
        }
        await page.locator('.wb-back-btn').first().click()
        check('G 「返回看板」关闭编辑器弹窗', await noVisibleDialog(page, 12000))
        check('G2 关闭后看板仍在', await boardVisible(page))
      }
    }
  } catch (err) {
    check('脚本异常', false, String((err && err.message) || err))
  } finally {
    await fetch(`${BASE}/api/workbench/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' }).catch(() => {})
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

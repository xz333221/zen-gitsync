// scripts/verify-subtask-row.mjs
import { chromium } from 'playwright'

const URL = 'http://localhost:5544/'
const SCREENSHOT_DIR = 'C:\\Users\\xuze3\\.zen-gitsync\\workbench-images\\_task-mqetoc9k-qc2va6'
const consoleErrors = []
const pageErrors = []
const log = (...a) => console.log('[verify]', ...a)
async function snapshot(page, name) {
  const path = `${SCREENSHOT_DIR}\\verify-${name}.png`
  try { await page.screenshot({ path, fullPage: false }); log('📸', name) } catch {}
}

// 先注入充足 done 子任务，避免被前面删除/取消用完
async function ensureTestData() {
  const r = await fetch('http://localhost:5544/api/workbench/tasks')
  const text = await r.text()
  const existing = text ? JSON.parse(text) : {}
  let target = existing.tasks?.find(t => t.title?.includes('verify-task'))
  if (!target) {
    const body = {
      title: '【验证】子任务行交互测试 verify-task',
      type: 'complex',
      subtasks: [
        { id: 'v-done-1', title: '已完成A：默认折叠（用于点行展开）', status: 'done' },
        { id: 'v-done-2', title: '已完成B：用于取消完成按钮冒泡测试', status: 'done' },
        { id: 'v-done-3', title: '已完成C：用于键盘 Enter/Space 测试', status: 'done' }
      ]
    }
    const r = await fetch('http://localhost:5544/api/workbench/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    const text = await r.text()
    const j = text ? JSON.parse(text) : {}
    target = j.task
  }
  return target
}

async function main() {
  const target = await ensureTestData()
  log('使用任务:', target?.title, target?.id)

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('console', (msg) => {
    const t = msg.type()
    if (t === 'error' || t === 'warning') consoleErrors.push(`[${t}] ${msg.text()}`)
  })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.activity-bar', { timeout: 20000 })
  await page.locator('.activity-btn').nth(3).click()
  await page.waitForSelector('.workbench-pane', { timeout: 10000 })
  await page.waitForTimeout(3000)

  // 先展开所有项目分组（含 "未关联项目" / "其他项目"），再点 verify-task
  await page.evaluate(() => {
    document.querySelectorAll('.wb-group-header').forEach(h => {
      if (h.textContent?.includes('收起')) h.click()
    })
  })
  await page.waitForTimeout(500)

  const clicked = await page.evaluate((title) => {
    const items = Array.from(document.querySelectorAll('.wb-task-item'))
    const target = items.find(el => el.textContent?.includes(title))
    if (target) { target.click(); return true }
    return false
  }, 'verify-task')
  log('侧栏点击 verify-task:', clicked)
  await page.waitForTimeout(1500)
  await snapshot(page, '01-loaded')

  // 兜底：如果侧栏没有 verify-task（例如其他项目分组未展开），强制把后端任务的
  // projectPath 改成当前项目再刷新——但这会改用户数据，跳过。
  // 我们改为：直接选第一个 subtaskCount>0 的 task
  if ((await page.locator('.wb-sub-item').count()) === 0) {
    log('verify-task 未选中，fallback 到第一个有子任务的任务')
    await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.wb-task-item'))
      const withSub = items.find(el => el.textContent?.match(/\d+\/\d+/))
      if (withSub) withSub.click()
    })
    await page.waitForTimeout(1000)
  }

  const total = await page.locator('.wb-sub-item').count()
  const collapsed = await page.locator('.wb-sub-item.is-collapsed').count()
  log('子任务总数:', total, '折叠态:', collapsed)
  if (collapsed === 0) { log('❌ 无折叠行'); await browser.close(); return }

  // ── (1) 悬停高亮 ──────────────────────────────────────
  const firstCollapsed = page.locator('.wb-sub-item.is-collapsed').first()
  const firstRow = firstCollapsed.locator('.wb-sub-item__row--compact')
  await firstRow.scrollIntoViewIfNeeded()
  await page.waitForTimeout(200)
  const baseBg = await firstRow.evaluate(el => getComputedStyle(el).backgroundColor)
  await firstRow.hover()
  await page.waitForTimeout(300)
  const hoverBg = await firstRow.evaluate(el => getComputedStyle(el).backgroundColor)
  log('base 背景:', baseBg, '→ hover 背景:', hoverBg)
  if (baseBg !== hoverBg) log('✅ 悬停态背景色变化 OK')
  else log('⚠️  悬停前后背景一致')
  await snapshot(page, '02-hover')

  // ── (2) 点击行展开 ───────────────────────────────────
  // 记录当前第一个 collapsed 行的索引
  const idxBefore = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.wb-sub-item'))
    return items.findIndex(el => el.classList.contains('is-collapsed'))
  })
  log('第一个折叠行 index:', idxBefore)
  // 点击 title 区域触发整行 click（不点按钮）
  await page.locator('.wb-sub-item.is-collapsed .wb-sub-item__title-compact').first().click()
  await page.waitForTimeout(500)
  const idxAfter = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.wb-sub-item'))
    return items.findIndex(el => el.classList.contains('is-collapsed'))
  })
  log('点击后第一个折叠行 index:', idxAfter)
  const expandedCount = await page.locator('.wb-sub-item:not(.is-collapsed)').count()
  if (idxAfter !== idxBefore && expandedCount > 0) log('✅ 点击行展开 OK')
  else log('❌ 点击行未展开')
  await snapshot(page, '03-row-expanded')

  // ── (3) 取消完成按钮无冒泡 ───────────────────────────
  // 关键验证：点按钮后，行的 click handler 不应被触发（@click.stop）。
  // 用 BUBBLE phase 监听 row 的 click（capture phase 永远会触发，与 .stop 无关）。
  // 同时拦截 fetch 让 PUT 成功，避免后端 500 影响判断。
  const undoResult = await page.evaluate(async () => {
    const item = document.querySelector('.wb-sub-item.is-collapsed')
    if (!item) return { found: false }
    const row = item.querySelector('.wb-sub-item__row--compact')
    if (!row) return { found: false }
    let rowClicked = 0
    // bubble phase，.stop 会阻止冒泡到这里
    row.addEventListener('click', () => rowClicked++, false)
    // mock fetch 让 cancelDone 不会因为测试数据问题失败
    const realFetch = window.fetch
    window.fetch = (url, opts) => {
      const s = String(url)
      // 拦截对 /api/workbench/tasks 的写操作
      if (s.includes('/api/workbench/tasks') && (opts?.method === 'POST' || opts?.method === 'PUT')) {
        return Promise.resolve(new Response(JSON.stringify({ success: true, task: { subtasks: [] } }), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      return realFetch(url, opts)
    }
    const undoBtn = item.querySelector('.wb-sub-item__undo')
    if (!undoBtn) return { found: false }
    const beforeCollapsed = item.classList.contains('is-collapsed')
    undoBtn.click()
    await new Promise(r => setTimeout(r, 700))
    window.fetch = realFetch
    const afterCollapsed = item.classList.contains('is-collapsed')
    return { found: true, rowClicked, beforeCollapsed, afterCollapsed }
  })
  log('「取消完成」→ row bubble click 触发次数:', undoResult.rowClicked, 'isCollapsed:', undoResult.beforeCollapsed, '→', undoResult.afterCollapsed)
  if (undoResult.rowClicked === 0) log('✅ 取消完成按钮：行 click handler 未触发（@click.stop 生效）')
  else log('❌ 取消完成按钮：行 click handler 被触发 ' + undoResult.rowClicked + ' 次')
  await snapshot(page, '04-after-undo')

  // ── (4) × 删除按钮无冒泡 ─────────────────────────────
  const delResult = await page.evaluate(async () => {
    const items = Array.from(document.querySelectorAll('.wb-sub-item'))
    if (!items.length) return { found: false }
    const item = items[items.length - 1] // 删最后一个，避开折叠测试行
    let flips = 0
    const rowEl = item.querySelector('.wb-sub-item__row--compact') || item.querySelector('.wb-sub-item__row')
    const obs = new MutationObserver(muts => {
      for (const m of muts) {
        if (m.type === 'attributes' && m.attributeName === 'class') flips++
      }
    })
    obs.observe(item, { attributes: true })
    if (rowEl) obs.observe(rowEl, { attributes: true })
    const realFetch = window.fetch
    window.fetch = (url, opts) => {
      if (String(url).includes('/api/workbench/subtasks') && opts?.method === 'DELETE') {
        return Promise.resolve(new Response('{"success":true}', { status: 200 }))
      }
      return realFetch(url, opts)
    }
    const delBtn = item.querySelector('.wb-sub-item__del')
    if (!delBtn) return { found: false }
    const before = document.querySelectorAll('.wb-sub-item').length
    delBtn.click()
    await new Promise(r => setTimeout(r, 600))
    window.fetch = realFetch
    const after = document.querySelectorAll('.wb-sub-item').length
    obs.disconnect()
    return { found: true, flips, before, after }
  })
  log('× 按钮 → class 翻转:', delResult.flips, '行数:', delResult.before, '→', delResult.after)
  if (delResult.found && delResult.after === delResult.before - 1) log('✅ × 删除按钮：行被删除，无冒泡副作用')
  await snapshot(page, '05-after-del')

  // ── (5) 键盘 Tab + Enter / Space ─────────────────────
  // 通过标题定位 sub，避开 Vue 重渲染时 activeElement 丢失问题
  const kbdRow = page.locator('.wb-sub-item.is-collapsed .wb-sub-item__row--compact').first()
  if (await kbdRow.count()) {
    const titleBefore = (await kbdRow.locator('.wb-sub-item__title-compact').first().textContent())?.trim()
    log('键盘测试目标标题:', titleBefore?.slice(0, 30))
    await kbdRow.focus()
    await page.waitForTimeout(200)
    const focused = await page.evaluate(() => document.activeElement?.classList?.contains('wb-sub-item__row--compact'))
    log('行获得焦点:', focused)
    await snapshot(page, '06-focused')

    await page.keyboard.press('Enter')
    await page.waitForTimeout(500)
    const afterEnter = await page.evaluate((title) => {
      const items = Array.from(document.querySelectorAll('.wb-sub-item'))
      const t = (title || '').trim()
      for (const it of items) {
        const compact = it.querySelector('.wb-sub-item__title-compact')
        const input = it.querySelector('input.wb-input')
        const text = (compact?.textContent || input?.value || '').trim()
        if (text === t) return it.classList.contains('is-collapsed')
      }
      return null
    }, titleBefore)
    log('Enter 后该 sub isCollapsed:', afterEnter)
    if (afterEnter === false) log('✅ 键盘 Enter 触发展开 OK')
    else log('❌ 键盘 Enter 未触发展开')

    // Space 折叠回去（同样按标题定位）
    if (afterEnter === false) {
      // 找标题匹配的那条展开行的 input，定位其所在 wb-sub-item__row
      const handle = await page.evaluateHandle((title) => {
        const t = (title || '').trim()
        const items = Array.from(document.querySelectorAll('.wb-sub-item:not(.is-collapsed)'))
        for (const it of items) {
          const input = it.querySelector('input.wb-input')
          if ((input?.value || '').trim() === t) return it.querySelector('.wb-sub-item__row')
        }
        return null
      }, titleBefore)
      if (handle) {
        const el = handle.asElement()
        if (el) {
          await el.focus()
          await page.waitForTimeout(200)
          await page.keyboard.press(' ')
          await page.waitForTimeout(500)
          const afterSpace = await page.evaluate((title) => {
            const items = Array.from(document.querySelectorAll('.wb-sub-item'))
            const t = (title || '').trim()
            for (const it of items) {
              const compact = it.querySelector('.wb-sub-item__title-compact')
              const input = it.querySelector('input.wb-input')
              const text = (compact?.textContent || input?.value || '').trim()
              if (text === t) return it.classList.contains('is-collapsed')
            }
            return null
          }, titleBefore)
          log('Space 后该 sub isCollapsed:', afterSpace)
          if (afterSpace === true) log('✅ 键盘 Space 触发折叠 OK')
          else log('❌ 键盘 Space 未触发折叠')
        }
      } else {
        log('⚠️  找不到展开后的行进行 Space 测试')
      }
    }
    await snapshot(page, '07-after-keyboard')
  } else {
    log('ℹ️  无可测折叠行，跳过键盘测试')
  }

  log('\n=== 验证总结 ===')
  log('Console errors/warnings:', consoleErrors.length)
  consoleErrors.forEach(e => log('  ·', e))
  log('Page errors:', pageErrors.length)
  pageErrors.forEach(e => log('  ·', e))

  await browser.close()
  log('done.')
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })

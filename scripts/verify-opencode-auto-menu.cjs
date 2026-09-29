/**
 * opencode「完全批准」菜单 —— 浏览器交互 + 请求契约验证。
 *
 * 背景：opencode 的免批准档是 `--auto`（官方 auto mode：自动批准**未被显式拒绝**的
 * 权限；配置里显式 deny 的仍会被拦）。它只有两档（默认 / --auto），没有 claude 那种
 * 中间的「批准文件编辑」，所以菜单里就两项。
 *
 * 守的契约：
 *   A1 顶栏 opencode 图标右键能弹出菜单（走的是通用 simple-tool popover）
 *   A2 菜单里有「完全批准（--auto）」项（正向锚：新档真的在）
 *   A3 菜单里有「默认权限」项
 *   A4 位置锚：两个权限项都排在「更新」项**之前**（中间有分隔线）——
 *      它们是"用什么权限打开"，跟下面"升级这个工具"不是一类事
 *   A5 反向锚：**别的工具**（vscode 这种没有权限档的）右键菜单里只有「更新」，
 *      不能被这个 v-if 连累着长出两项 —— 这是最容易写错的地方
 *   A6 点「完全批准」→ 发往 /api/open-directory-with-opencode 的 body 里
 *      `permissionMode === 'auto'`，点完菜单关闭
 *   A7 反向锚：点「默认权限」→ body 里**没有** permissionMode
 *      （默认档不能偷偷带上 --auto）
 *   B1 编排台项目「打开方式」菜单里有「用 OpenCode 打开（完全批准）」
 *   B2 点它 → body 里 permissionMode === 'auto'
 *   B3 反向锚：项目菜单里原来的「用 OpenCode 打开」（默认档）还在，没被顶掉
 *
 * 请求体怎么断言：`page.route` 直接拦掉这个 POST 并 fulfill 一个假成功 ——
 * 既拿到 body，又避免真去 spawn 一个终端 / TUI 窗口（那种副作用不该出现在验证里）。
 *
 * 反向验证（把改动撤掉后哪几条会红）：
 *   · 摘掉模板里那段 `<template v-if="tool.id === 'opencode'">` → A2/A3/A4 红
 *   · 把 v-if 条件改成恒真 → A5 红
 *   · pickOpencodeMode 里忘了传 'auto'（只调 onOpenInOpencode()）→ A6 红、A7 仍绿
 *   · 让默认档也传 'auto' → A7 红
 *   · 项目菜单里删掉新项 → B1/B2 红，B3 仍绿（B3 单独有效）
 *
 * 用法：先 `npm run dev`（后端 5545 + vite 5544），再
 *   node scripts/verify-opencode-auto-menu.cjs
 */
const path = require('node:path')
const os = require('node:os')
// playwright 装在 src/ui/client 下，把它的 node_modules 挂进解析路径，脚本才能独立跑
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const API = process.env.ZEN_API || 'http://127.0.0.1:5545'

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function waitUntil(fn, timeout = 12000, interval = 150) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true
    await sleep(interval)
  }
  return false
}

async function main() {
  const alive = await fetch(`${API}/api/app-version`).then(r => r.ok).catch(() => false)
  if (!alive) {
    console.error(`后端没起（${API}）—— 先 npm run dev`)
    process.exit(2)
  }
  const dirRes = await fetch(`${API}/api/current_directory`).then(r => r.json()).catch(() => null)
  const currentDir = dirRes?.directory || dirRes?.currentDirectory || ''
  if (!currentDir) {
    console.error('当前目录为空，顶栏那组断言没有意义 —— 先切一个有目录的项目')
    process.exit(2)
  }
  console.log(`[verify] 当前目录 = ${currentDir}`)

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 1600, height: 950 } })

  // 拦掉 opencode 打开端点：记下 body，绝不真的开窗口
  const openBodies = []
  await context.route('**/api/open-directory-with-opencode', async (route) => {
    let body = null
    try { body = route.request().postDataJSON() } catch { /* 非法 JSON 就当没有 */ }
    openBodies.push(body)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        message: body && body.permissionMode
          ? '已用 OpenCode 打开目录（--auto：自动批准未被显式拒绝的权限）'
          : '已用 OpenCode 打开目录',
      }),
    })
  })

  const page = await context.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  const lastBody = () => openBodies[openBodies.length - 1]
  // contextmenu 挂在按钮外面那层 span 上（IconButton 根是 el-tooltip，事件挂不住），
  // 所以右键要打在**那层 span** 上：`xpath=..` 从按钮回到父节点。⚠️ 不能写
  // `.simple-tool-trigger` + filter({ has: ... }) —— has 是以自身为根的，会永远匹配不到。
  const triggerOf = (ariaPrefix) =>
    page.locator(`.simple-tool-trigger button[aria-label^="${ariaPrefix}"]`).first().locator('xpath=..')
  const toasts = () => page.evaluate(() => Array.from(document.querySelectorAll('.el-message')).map(n => (n.textContent || '').trim()))
  const hasToast = async (s) => (await toasts()).some(t => t.includes(s))
  const clearToasts = () => page.evaluate(() => document.querySelectorAll('.el-message').forEach(n => n.remove()))
  // ⚠️ 只看第一条 .el-message 会假阴性（启动时「Git 状态已刷新」之类会先占位）→ 一律 any 匹配
  // ⚠️ 每个可见工具都渲染了一个 `.simple-tool-menu-popover`，且它们的内容**都在 DOM 里**
  //    （el-popover 只把没弹的那个藏起来，不销毁）→ 直接 `querySelector('.simple-tool-menu-popover
  //    .claude-menu')` 会取到 DOM 里第一个，实测拿到的是 VSCode 那份菜单（于是"opencode 菜单
  //    里有完全批准"会假红成 "更新 VSCode"）。必须按 popover 的 aria-label 指名 + 只认真的
  //    显示出来的那个（width > 0；藏起来的宽高是 0）。
  const menuItems = (ariaLabel) => page.evaluate((label) => {
    const menu = Array.from(document.querySelectorAll('.simple-tool-menu-popover .claude-menu'))
      .filter(m => (!label || m.getAttribute('aria-label') === label) && m.getBoundingClientRect().width > 0)[0]
    if (!menu) return null
    const kids = Array.from(menu.children)
    return {
      texts: kids.map(k => (k.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean),
      sep: kids.findIndex(k => k.classList.contains('claude-menu__sep')),
      items: kids.map((k, i) => ({
        i,
        text: (k.textContent || '').replace(/\s+/g, ' ').trim(),
        // 分隔线本身没有文本，排除掉
        kind: k.classList.contains('claude-menu__sep') ? 'sep' : (k.querySelector('.claude-menu__label') ? 'item' : 'other'),
        label: (k.querySelector('.claude-menu__label')?.textContent || '').replace(/\s+/g, ' ').trim(),
        hint: (k.querySelector('.claude-menu__hint')?.textContent || '').replace(/\s+/g, ' ').trim(),
      })),
    }
  }, ariaLabel)

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 25000 })

    // ── A 顶栏 opencode ────────────────────────────────────────────
    const opencodeBtn = page.locator('.simple-tool-trigger button[aria-label^="用 OpenCode 打开"]')
    const pinned = await waitUntil(async () => (await opencodeBtn.count()) === 1, 15000)
    check('A0 opencode 固定显示在顶栏（否则右键菜单无处可挂）', pinned, `count=${await opencodeBtn.count()}`)
    if (!pinned) throw new Error('opencode 不在顶栏：请在 设置→顶部工具栏 里勾上它再跑本探针')

    const missing = await opencodeBtn.first().evaluate(el => el.className.includes('tool-button--missing'))
    if (missing) {
      console.error('opencode 未安装（按钮是 missing 态），本次验证没有意义')
      process.exit(2)
    }

    const trigger = triggerOf('用 OpenCode 打开')
    await trigger.click({ button: 'right' })
    const menuAppeared = await waitUntil(async () => (await menuItems('OpenCode')) !== null, 8000)
    check('A1 右键 opencode 弹出工具菜单', menuAppeared)
    if (!menuAppeared) throw new Error('菜单没弹出来')

    const menu = await menuItems('OpenCode')
    const itemByHint = (hint) => menu.items.find(it => it.kind === 'item' && it.hint.includes(hint))
    const autoItem = itemByHint('--auto')
    const defaultItem = itemByHint('默认权限')
    const updateItem = menu.items.find(it => it.kind === 'item' && it.label.startsWith('更新'))

    check('A2 菜单里有「完全批准（--auto）」', !!autoItem, JSON.stringify(menu.items.map(i => i.label + '/' + i.hint)))
    check('A3 菜单里有「默认权限」', !!defaultItem)
    check('A4 两个权限项都排在「更新」之前（中间有分隔线）',
      !!autoItem && !!defaultItem && !!updateItem && menu.sep > Math.max(autoItem.i, defaultItem.i) && updateItem.i > menu.sep,
      `sep@${menu.sep} 默认@${defaultItem?.i} auto@${autoItem?.i} 更新@${updateItem?.i}`)

    // A6 点「完全批准」
    await clearToasts()
    openBodies.length = 0
    await page.locator('.simple-tool-menu-popover .claude-menu__item', { hasText: '--auto' }).first().click()
    await waitUntil(async () => openBodies.length > 0, 8000)
    check('A6a 点「完全批准」发出的请求带 permissionMode=auto',
      lastBody()?.permissionMode === 'auto', JSON.stringify(lastBody()))
    await waitUntil(async () => await hasToast('已用 OpenCode 打开目录'))
    check('A6b 提示已用 OpenCode 打开目录', await hasToast('已用 OpenCode 打开目录'), JSON.stringify(await toasts()))
    check('A6c 点完菜单关闭', await waitUntil(async () => (await menuItems('OpenCode')) === null, 5000))

    // A7 点「默认权限」
    await trigger.click({ button: 'right' })
    await waitUntil(async () => (await menuItems('OpenCode')) !== null, 8000)
    await clearToasts()
    openBodies.length = 0
    await page.locator('.simple-tool-menu-popover .claude-menu__item', { hasText: '默认权限' }).first().click()
    await waitUntil(async () => openBodies.length > 0, 8000)
    check('A7 点「默认权限」发出的请求不带 permissionMode',
      lastBody() !== null && !('permissionMode' in (lastBody() || {})), JSON.stringify(lastBody()))

    // A5 反向锚：别的工具不该长出这两个权限项
    const otherBtn = page.locator('.simple-tool-trigger button[aria-label^="用 VSCode 打开"]')
    if ((await otherBtn.count()) === 1) {
      await triggerOf('用 VSCode 打开').click({ button: 'right' })
      await waitUntil(async () => (await menuItems('VSCode')) !== null, 8000)
      const otherMenu = await menuItems('VSCode')
      const otherLabels = (otherMenu?.items || []).map(i => i.label)
      check('A5 反向锚：其它工具的菜单里没有权限项（只有更新）',
        !!otherMenu && otherLabels.length === 1 && otherLabels[0].startsWith('更新'),
        JSON.stringify(otherMenu?.items.map(i => i.label + '/' + i.hint)))
      await page.keyboard.press('Escape')
      await page.mouse.click(5, 400)
      await sleep(300)
    } else {
      check('A5 反向锚：其它工具的菜单里没有权限项（只有更新）', false, 'vscode 不在顶栏，无法做这条反向锚')
    }

    // ── B 编排台项目菜单 ───────────────────────────────────────────
    let boardOk = false
    for (let i = 0; i < 6 && !boardOk; i++) {
      if ((await page.locator('.board').count()) > 0) { boardOk = true; break }
      await page.locator('.activity-btn[aria-label^="工作台"]').first().click({ timeout: 5000 }).catch(() => {})
      await sleep(900)
      boardOk = (await page.locator('.board').count()) > 0
    }
    check('B0a 进入工作台视图', boardOk)

    const rows = page.locator('.proj-item:not(.proj-item--all)')
    const rowOk = boardOk && await waitUntil(async () => (await rows.count()) > 0, 15000)
    check('B0b 项目列表就绪', rowOk, `rows=${await rows.count()}`)

    if (rowOk) {
      // ⚠️ 必须先 hover 整行：.proj-item__actions 空闲时 opacity:0 + pointer-events:none，
      //    Playwright 的命中测试发生在移鼠标之前 → 报 badge intercepts pointer events
      const menuBtn = rows.first().locator('button[aria-label^="打开方式"]')
      await rows.first().hover()
      await sleep(200)
      await menuBtn.click({ timeout: 8000 }).catch(async () => { await menuBtn.dispatchEvent('click') })
      const projMenu = page.locator('.proj-menu').first()
      const projMenuOk = await waitUntil(async () => (await projMenu.count()) === 1, 8000)
      check('B1a 「打开方式」菜单打开', projMenuOk)

      if (projMenuOk) {
        const labels = (await projMenu.locator('.proj-menu__label').allTextContents()).map(s => s.trim())
        check('B1 菜单里有「用 OpenCode 打开（完全批准）」',
          labels.includes('用 OpenCode 打开（完全批准）'), JSON.stringify(labels))
        check('B3 反向锚：默认档「用 OpenCode 打开」还在', labels.includes('用 OpenCode 打开'))

        const autoProjItem = projMenu.locator('.proj-menu__item--danger', { hasText: '用 OpenCode 打开（完全批准）' }).first()
        openBodies.length = 0
        await clearToasts()
        await autoProjItem.click()
        await waitUntil(async () => openBodies.length > 0, 8000)
        const b = lastBody()
        check('B2 点它发出的请求带 permissionMode=auto',
          b?.permissionMode === 'auto' && typeof b?.path === 'string' && b.path.length > 0, JSON.stringify(b))
      }
    }

    const shot = path.join(os.tmpdir(), `zen-opencode-auto-menu-${Date.now()}.png`)
    await page.screenshot({ path: shot })
    console.log(`[verify] 截图: ${shot}`)
  } catch (err) {
    check('脚本异常', false, String(err?.message || err))
  } finally {
    await browser.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n用例 ${results.length}，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  failed.forEach(f => console.log(`  - ${f.name} ${f.extra}`))
  const real = consoleErrors.filter(e => !/Failed to fetch|获取当前目录失败|404|net::ERR/.test(e))
  console.log(`控制台错误(过滤噪音): ${real.length}`)
  real.slice(0, 8).forEach(e => console.log('  ! ' + e.slice(0, 220)))
  if (pageErrors.length) {
    console.log(`页面异常: ${pageErrors.length}`)
    pageErrors.slice(0, 4).forEach(e => console.log('  ! ' + e.slice(0, 220)))
  }
  console.log(`合计 ${failed.length === 0 && real.length === 0 && pageErrors.length === 0 ? 'PASS' : 'FAIL'}`)
  process.exit(failed.length ? 1 : 0)
}
main()

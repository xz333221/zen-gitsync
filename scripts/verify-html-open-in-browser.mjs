#!/usr/bin/env node
/**
 * 「在浏览器中打开」(文件空间右键 HTML) —— 浏览器交互验证脚本。
 *
 * 运行：node scripts/verify-html-open-in-browser.mjs
 * 前置：backend(5545) + vite dev server(5544) 都在跑(`npm run dev` 或分开启)
 * 输出：截图保存到 workbench-images/_task-open-in-browser/
 *
 * 守的契约：
 *   A1 右键 .html 文件 → 菜单里出现「在浏览器中打开」
 *   A2 位置锚：它落在「在资源管理器中打开」**之前**，跟外部打开类动作同一组
 *   A3 点它 → 发出的是 POST /api/editor/open-in-browser，body.path 正好是被右键的
 *      那个 html 的绝对路径（不是相对路径、不是目录）
 *   A4 点完菜单关闭
 *   B1 反向锚：右键非 HTML（package.json）→ 菜单里**没有**这一项
 *   B2 反向锚：右键目录（test/）→ 菜单里**没有**这一项
 *   B3 正向锚：B1/B2 的菜单里原有的「在 VSCode 中打开」「在资源管理器中打开」仍在
 *      —— 新项是"加一项"，不是把外部打开那组整个换掉
 *
 * 为什么 A3 要拦请求而不是真开浏览器：验证脚本跑一次开一个浏览器标签页，跑 N 次
 * 就堆 N 个；这里拦下请求断言 payload，真开浏览器那一段由后端路由的独立测试
 * （curl + 窗口标题变化）覆盖。
 *
 * 写脚本时踩过的坑（记下来免得重踩）：
 *   · 文件树是懒加载的：根目录只有一级，html 在 test/ 里，必须先点 test 展开再找，
 *     直接查 `.tree-node` 找 .html 会一个都找不到。
 *   · node 名要从 `.tree-name` 的 title 属性读（title = 绝对路径），不能用 textContent
 *     —— 搜索命中高亮会把名字拆成多个 span，textContent 拼起来是对的，但 title 才是
 *     我们真正要断言的绝对路径。
 *   · 断言菜单项文本不能写死中文：界面语言可能是 en（key 见 lang/en/index.js），
 *     所以中英两个文案都算命中。
 */
import { chromium } from '../src/ui/client/node_modules/playwright/index.mjs'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const screenshotDir = path.join(repoRoot, 'workbench-images', '_task-open-in-browser')
fs.mkdirSync(screenshotDir, { recursive: true })

// 打 vite dev server(5544)：HMR 链路，改完前端代码立刻能验；backend 由 vite proxy 转发
const URL = 'http://localhost:5544/'

const OPEN_IN_BROWSER_LABELS = ['在浏览器中打开', 'Open in Browser']
const OPEN_IN_EXPLORER_LABELS = ['在资源管理器中打开', 'Open in File Explorer']
const OPEN_IN_VSCODE_LABELS = ['在 VSCode 中打开', 'Open in VSCode']

const log = (...args) => console.log('[verify]', ...args)
const shot = (page, name) => page.screenshot({ path: path.join(screenshotDir, name), fullPage: false })

const hits = (items, labels) => items.some((t) => labels.some((l) => t.includes(l)))

/** 读文件树里所有节点的绝对路径（title 属性） */
const treePaths = (page) =>
  page.$$eval('.sidebar-tree .tree-node .tree-name', (els) => els.map((el) => el.getAttribute('title') || ''))

/** 读当前右键菜单的项文本 */
const menuItems = (page) => page.$$eval('.ctx-menu .ctx-menu-item', (els) => els.map((el) => el.textContent.trim()))

async function rightClickNode(page, absPath) {
  const node = page.locator('.sidebar-tree .tree-node', {
    has: page.locator(`.tree-name[title="${absPath.replace(/\\/g, '\\\\')}"]`),
  })
  // 先把目标节点滚到树容器顶部再右键：菜单是 fixed 定位在鼠标点上、菜单自身不夹取
  // 视口（见 openContextMenu），节点若停在视口底部，展开后的菜单会顶出屏幕下沿，
  // Playwright 点不到（element is outside of the viewport）。真人也会遇到，所以是
  // 节点位置的问题，不是菜单的问题 —— 脚本里滚一下即可。
  await node.first().evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(200)
  await node.first().click({ button: 'right' })
  await page.waitForSelector('.ctx-menu', { timeout: 5_000 })
  await page.waitForTimeout(150)
}

/** 点开一个目录节点（懒加载子项），等子节点出现 */
async function expandDir(page, absPath) {
  await page.locator('.sidebar-tree .tree-node', {
    has: page.locator(`.tree-name[title="${absPath.replace(/\\/g, '\\\\')}"]`),
  }).first().click()
  await page.waitForTimeout(600)
}

async function run() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`) })

  log(`导航 ${URL}`)
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  // 等应用挂载：活动栏出现。**不能**一上来就等 .sidebar-title —— 启动默认视图不是
  // 文件空间（实测是 Git / 工作台那一侧），标题栏压根不在 DOM 里。
  await page.waitForSelector('button[aria-label]', { timeout: 30_000 })
  await page.waitForTimeout(1500)

  // ── 切到文件空间 ────────────────────────────────────────
  const activityBtn = page.locator(
    'button[aria-label*="文件空间"], button[aria-label*="编辑器"], button[aria-label*="Editor"]'
  ).first()
  if (await activityBtn.isVisible().catch(() => false)) {
    await activityBtn.click({ force: true })
    log('[0] 已切到文件空间')
    await page.waitForTimeout(1200)
  } else {
    log('[0] ⚠ 没找到活动栏的"文件空间"按钮,可能已经在文件空间里')
  }

  // 可能弹目录选择 / 打开对话框（取决于启动状态），关掉它
  const dialog = page.locator('.el-dialog, .el-message-box').first()
  if (await dialog.isVisible().catch(() => false)) {
    log('[0] 检测到对话框,尝试关闭')
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(500)
  }

  await page.waitForFunction(
    () => document.querySelectorAll('.sidebar-tree .tree-node').length > 0,
    { timeout: 30_000 }
  )
  log('[0] 文件树已渲染')
  await shot(page, '01-tree.png')

  // ── 展开 test/ 找一个 HTML ──────────────────────────────
  const rootPaths = await treePaths(page)
  const testDir = rootPaths.find((p) => /[\\/]test$/.test(p))
  if (!testDir) throw new Error(`根目录里没有 test/,当前根目录节点: ${rootPaths.slice(0, 20).join(', ')}`)
  await expandDir(page, testDir)
  const htmlPath = (await treePaths(page)).find((p) => p.toLowerCase().endsWith('.html'))
  if (!htmlPath) throw new Error('test/ 展开后没找到 .html 文件')
  log(`[1] 目标 HTML: ${htmlPath}`)
  await shot(page, '02-html-visible.png')

  // ── A1/A2 右键 HTML → 有"在浏览器中打开",且排在"在资源管理器中打开"之前 ──
  await rightClickNode(page, htmlPath)
  const htmlMenu = await menuItems(page)
  log(`[A1] HTML 右键菜单: ${JSON.stringify(htmlMenu)}`)
  if (!hits(htmlMenu, OPEN_IN_BROWSER_LABELS)) throw new Error('A1 失败:HTML 菜单里没有"在浏览器中打开"')
  const browserIdx = htmlMenu.findIndex((t) => hits([t], OPEN_IN_BROWSER_LABELS))
  const explorerIdx = htmlMenu.findIndex((t) => hits([t], OPEN_IN_EXPLORER_LABELS))
  if (explorerIdx !== -1 && browserIdx > explorerIdx) {
    throw new Error(`A2 失败:"在浏览器中打开"排在"在资源管理器中打开"之后 (${browserIdx} > ${explorerIdx})`)
  }
  if (!hits(htmlMenu, OPEN_IN_EXPLORER_LABELS) || !hits(htmlMenu, OPEN_IN_VSCODE_LABELS)) {
    throw new Error('B3 失败:外部打开那组原有菜单项缺失')
  }
  await shot(page, '03-html-menu.png')

  // ── A3/A4 点它 → 请求 payload 正确 + 菜单关闭 ────────────
  let captured = null
  await page.route('**/api/editor/open-in-browser', async (route) => {
    captured = { method: route.request().method(), body: route.request().postDataJSON() }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) })
  })
  await page.locator('.ctx-menu .ctx-menu-item')
    .filter({ hasText: /在浏览器中打开|Open in Browser/ })
    .first()
    .click()
  await page.waitForTimeout(500)
  log(`[A3] 捕获请求: ${JSON.stringify(captured)}`)
  if (!captured) throw new Error('A3 失败:点击后没有发出 /api/editor/open-in-browser 请求')
  if (captured.method !== 'POST') throw new Error(`A3 失败:方法应为 POST,实际 ${captured.method}`)
  if (captured.body?.path !== htmlPath) {
    throw new Error(`A3 失败:body.path 应为 ${htmlPath},实际 ${captured.body?.path}`)
  }
  if (await page.locator('.ctx-menu').isVisible().catch(() => false)) {
    throw new Error('A4 失败:点完菜单没有关闭')
  }
  log('[A3/A4] ✓ 请求正确、菜单已关闭')

  // ── B1 反向锚:非 HTML 文件没有这一项 ────────────────────
  const jsonPath = rootPaths.find((p) => p.toLowerCase().endsWith('package.json'))
  if (!jsonPath) throw new Error('根目录里没有 package.json,无法做 B1 反向验证')
  await rightClickNode(page, jsonPath)
  const jsonMenu = await menuItems(page)
  log(`[B1] package.json 右键菜单: ${JSON.stringify(jsonMenu)}`)
  if (hits(jsonMenu, OPEN_IN_BROWSER_LABELS)) throw new Error('B1 失败:非 HTML 文件也出现了"在浏览器中打开"')
  if (!hits(jsonMenu, OPEN_IN_EXPLORER_LABELS) || !hits(jsonMenu, OPEN_IN_VSCODE_LABELS)) {
    throw new Error('B3 失败:非 HTML 菜单里外部打开项缺失')
  }
  await shot(page, '04-non-html-menu.png')
  await page.keyboard.press('Escape')
  await page.mouse.click(800, 500)
  await page.waitForTimeout(300)

  // ── B2 反向锚:目录没有这一项 ────────────────────────────
  await rightClickNode(page, testDir)
  const dirMenu = await menuItems(page)
  log(`[B2] 目录右键菜单: ${JSON.stringify(dirMenu)}`)
  if (hits(dirMenu, OPEN_IN_BROWSER_LABELS)) throw new Error('B2 失败:目录也出现了"在浏览器中打开"')
  await shot(page, '05-dir-menu.png')
  await page.keyboard.press('Escape')

  // ── 收尾 ───────────────────────────────────────────────
  const realErrors = errors.filter((e) => !/favicon|ERR_ABORTED|ResizeObserver/.test(e))
  if (realErrors.length) {
    log('⚠ 页面报错:')
    realErrors.forEach((e) => log('   ', e))
  }
  await browser.close()
  log('全部断言通过 ✅  截图:', screenshotDir)
}

run().catch((err) => {
  console.error('[verify] ❌', err.message)
  process.exit(1)
})

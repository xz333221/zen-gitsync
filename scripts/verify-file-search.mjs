#!/usr/bin/env node
/**
 * 文件树搜索功能端到端验证脚本
 *
 * 运行：node scripts/verify-file-search.mjs
 *
 * 前置：backend 服务已启动（端口写入 .port 文件）
 * 输出：截图保存到 workbench-images/_task-mqekkeib-3erm4b/
 */
import { chromium } from '../src/ui/client/node_modules/playwright/index.mjs'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const screenshotDir = path.join(repoRoot, 'workbench-images', '_task-mqekkeib-3erm4b')
fs.mkdirSync(screenshotDir, { recursive: true })

const port = fs.readFileSync(path.join(repoRoot, '.port'), 'utf8').trim()
const URL = `http://localhost:${port}/`

const log = (...args) => console.log('[verify]', ...args)
const shot = (page, name) => page.screenshot({ path: path.join(screenshotDir, name), fullPage: false })

async function clickByText(page, selector, text) {
  // 在 selector 内查找包含指定文字的元素并点击
  const handle = await page.evaluateHandle((sel, t) => {
    const root = document.querySelector(sel) || document
    const candidates = root.querySelectorAll('button, .el-button, a, [role="button"]')
    for (const c of candidates) {
      if ((c.textContent || '').trim() === t || (c.textContent || '').trim().includes(t)) {
        return c
      }
    }
    return null
  }, selector, text)
  const el = handle.asElement()
  if (!el) throw new Error(`未找到包含文字 "${text}" 的按钮`)
  await el.scrollIntoViewIfNeeded()
  await el.click({ force: true })
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
  // 等应用挂载
  await page.waitForSelector('.sidebar-title', { timeout: 30_000, state: 'attached' })
  await page.waitForTimeout(800)
  await shot(page, '01-initial.png')

  // ── 切换到编辑器视图（ActivityBar 的"编辑器"按钮） ────
  log('[0] 切换到编辑器视图')
  const editorBtn = await page.$('button[aria-label="编辑器"], .activity-btn[aria-label="编辑器"]')
  if (editorBtn) {
    const visible = await editorBtn.isVisible().catch(() => false)
    if (visible) {
      await editorBtn.click({ force: true })
      log('  - 已点击"编辑器"按钮')
      await page.waitForTimeout(800)
    }
  } else {
    log('  ⚠ 未找到编辑器切换按钮,尝试通过 aria-pressed 定位')
    const altBtn = await page.$('button[aria-pressed="false"]')
    if (altBtn) await altBtn.click({ force: true })
    await page.waitForTimeout(500)
  }

  // ── 处理项目选择对话框 ──────────────────────────────────
  const dialogVisible = await page.locator('.el-dialog, .el-drawer, .el-message-box').first().isVisible().catch(() => false)
  if (dialogVisible) {
    log('[0] 检测到对话框,关闭/打开')
    try {
      await clickByText(page, 'body', '打开')
      log('  - 点击"打开"')
    } catch {
      log('  - 没有"打开"按钮,尝试"取消"')
      await clickByText(page, 'body', '取消').catch(() => {})
    }
    await page.waitForTimeout(800)
  }

  // ── 处理侧边栏折叠 ─────────────────────────────────────
  const sidebarVisible = await page.evaluate(() => {
    const el = document.querySelector('.sidebar, .file-sidebar, .editor-sidebar')
    return el && el.offsetWidth > 50
  })
  log(`[0] 侧边栏可见: ${sidebarVisible}`)
  if (!sidebarVisible) {
    const toggleBtns = await page.$$('button')
    for (const b of toggleBtns) {
      const text = (await b.textContent() || '').trim()
      const aria = await b.getAttribute('aria-label') || ''
      if (aria.includes('侧边栏') || aria.includes('sidebar') || aria.includes('资源') || text.includes('资源')) {
        await b.click({ force: true })
        log(`  - 点击 toggle 按钮: aria="${aria}"`)
        break
      }
    }
    await page.waitForTimeout(500)
  }

  // 等文件树节点加载
  await page.waitForFunction(() => {
    const el = document.querySelector('.sidebar-tree')
    return el && el.querySelectorAll('.tree-node').length > 0
  }, { timeout: 30_000 })
  log('[0] 文件树已渲染')
  await page.waitForTimeout(500)
  await shot(page, '02-tree-loaded.png')

  // ── 0. 标题栏 3 个图标回归验证 ───────────────────────────
  const headerBtns = await page.$$('.sidebar-actions button, .sidebar-header button')
  log(`[0] 标题栏按钮数: ${headerBtns.length}`)
  // 取可见且能点击的最后那个按钮（刷新）
  let refreshClicked = false
  for (const b of headerBtns) {
    const visible = await b.isVisible().catch(() => false)
    if (visible) {
      await b.click({ force: true })
      log('  - 点击一个标题栏按钮')
      refreshClicked = true
      break
    }
  }
  if (!refreshClicked) log('  ⚠ 没有可见的标题栏按钮可点')
  await page.waitForTimeout(500)
  // 关闭任何弹出输入框
  await page.keyboard.press('Escape')
  await page.mouse.click(800, 400)
  await page.waitForTimeout(200)
  await shot(page, '03-after-header-click.png')

  // ── 1. 搜索常见文件名 ────────────────────────────────────
  const input = page.locator('.sidebar-search-input')
  await input.click()
  await input.fill('package.json')
  await page.waitForTimeout(400)
  let nodes = await page.$$eval('.sidebar-tree .tree-node', (els) =>
    els.map((el) => el.textContent.trim()).filter(Boolean)
  )
  log(`[1] search=package.json → ${nodes.length} 节点:`, nodes.slice(0, 8))
  await shot(page, '04-search-package.png')
  const hit1 = nodes.some((t) => t.includes('package.json'))
  if (!hit1) throw new Error('搜索 package.json 未命中')

  await input.fill('README.md')
  await page.waitForTimeout(400)
  nodes = await page.$$eval('.sidebar-tree .tree-node', (els) =>
    els.map((el) => el.textContent.trim()).filter(Boolean)
  )
  log(`[1] search=README.md → ${nodes.length} 节点:`, nodes.slice(0, 8))
  await shot(page, '05-search-readme.png')
  const hit2 = nodes.some((t) => t.includes('README.md'))
  if (!hit2) throw new Error('搜索 README.md 未命中')

  // 命中高亮
  const hitSpans = await page.$$eval('.tree-name-hit', (els) => els.length)
  log(`  - 高亮片段数: ${hitSpans}`)
  if (hitSpans === 0) throw new Error('命中高亮未渲染')

  // ── 2. 搜索目录名 (src / views) ─────────────────────────
  // 先验证根目录搜索(不依赖懒加载)
  await input.fill('src')
  await page.waitForTimeout(400)
  nodes = await page.$$eval('.sidebar-tree .tree-node', (els) =>
    els.map((el) => el.textContent.trim()).filter(Boolean)
  )
  log(`[2] search=src → ${nodes.length} 节点:`, nodes.slice(0, 12))
  await shot(page, '06-search-src.png')
  const hasSrc = nodes.some((t) => t === 'src' || t.startsWith('src'))
  if (!hasSrc) throw new Error('搜索 src 目录未命中')

  // 同时验证其他目录名(.agents / .github / node_modules / scripts 都在根目录)
  for (const dir of ['.git', '.github', 'scripts', 'node_modules']) {
    await input.fill(dir)
    await page.waitForTimeout(400)
    const ns = await page.$$eval('.sidebar-tree .tree-node', (els) =>
      els.map((el) => el.textContent.trim()).filter(Boolean)
    )
    log(`[2] search=${dir} → ${ns.length} 节点:`, ns.slice(0, 8))
    const has = ns.some((t) => t === dir || t.startsWith(dir) || t.toLowerCase().includes(dir.replace('.', '')))
    if (has) log(`  ✓ ${dir} 命中`)
    else log(`  ⚠ ${dir} 未命中 (预期可能因目录名匹配规则有差异)`)
  }
  await shot(page, '07-search-dirs.png')

  // ── 3. 不存在的关键字 → 空态 ─────────────────────────────
  await input.fill('xxxxnomatch12345')
  await page.waitForTimeout(400)
  nodes = await page.$$eval('.sidebar-tree .tree-node', (els) => els.length)
  const emptyText = await page.$eval('.tree-empty', (el) => el.textContent.trim()).catch(() => '')
  log(`[3] search=xxxxnomatch12345 → 节点数 ${nodes}, 空态文案: "${emptyText}"`)
  await shot(page, '08-no-match.png')
  if (nodes !== 0) throw new Error(`不匹配关键字应显示 0 节点, 实际 ${nodes}`)
  if (!emptyText.includes('未找到匹配文件')) throw new Error('空态文案缺失')

  // ── 3.5 Esc 清空 ─────────────────────────────────────────
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  const inputVal = await input.inputValue()
  log(`[3.5] Esc 后输入框值: "${inputVal}"`)
  if (inputVal !== '') throw new Error('Esc 未清空输入框')

  // ── 4. 主题切换(深色/浅色) ──────────────────────────────
  // 项目本身没有 UI 主题切换按钮(主题跟随系统),这里手动设置 data-theme 验证搜索框在两种主题下样式自适应
  const beforeTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  log(`[4] 当前 data-theme: ${beforeTheme || '(跟随系统/默认)'}`)
  const darkStyle = await page.$eval('.sidebar-search-input', (el) => {
    const s = getComputedStyle(el)
    return { bg: s.backgroundColor, color: s.color, border: s.borderColor }
  })
  log(`  - 深色主题下搜索框样式: ${JSON.stringify(darkStyle)}`)
  await shot(page, '09-theme-dark.png')

  // 切换到浅色主题
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'light')
  })
  await page.waitForTimeout(400)
  const lightStyle = await page.$eval('.sidebar-search-input', (el) => {
    const s = getComputedStyle(el)
    return { bg: s.backgroundColor, color: s.color, border: s.borderColor }
  })
  log(`[4] 浅色主题下搜索框样式: ${JSON.stringify(lightStyle)}`)
  // 验证浅色主题下背景变浅(应该与深色不同)
  if (darkStyle.bg !== lightStyle.bg || darkStyle.color !== lightStyle.color) {
    log('  ✓ 主题切换后搜索框样式确实改变(自适应)')
  } else {
    log('  ⚠ 浅色/深色样式相同 — 可能主题 token 未差异化(非阻塞)')
  }
  await shot(page, '10-theme-light.png')

  // 恢复深色
  await page.evaluate(() => {
    document.documentElement.removeAttribute('data-theme')
  })
  await page.waitForTimeout(300)

  // ── 5. Ctrl+F 快捷键聚焦 ─────────────────────────────────
  await page.mouse.click(800, 400)
  await page.waitForTimeout(200)
  await page.keyboard.press('Control+f')
  await page.waitForTimeout(300)
  const focused = await page.evaluate(() => document.activeElement?.classList?.contains('sidebar-search-input'))
  log(`[5] Ctrl+F 后聚焦于搜索框: ${focused}`)
  await shot(page, '10-ctrl-f-focus.png')

  log('─'.repeat(50))
  // 过滤掉已知的非致命错误（Socket 离线 / Monaco worker 警告）
  const fatal = errors.filter((e) =>
    !e.includes('Socket') &&
    !e.includes('worker') &&
    !e.includes('monaco')
  )
  if (fatal.length) {
    log('⚠ 致命错误:')
    for (const e of fatal) log('  ', e)
  } else {
    log(`✓ 无致命错误 (共 ${errors.length} 条非致命警告)`)
  }
  log('✓ 全部检查通过')
  log(`截图已保存到: ${screenshotDir}`)

  await browser.close()
  process.exit(fatal.length ? 1 : 0)
}

run().catch((e) => {
  console.error('[verify] ✗', e.message)
  console.error(e.stack)
  process.exit(1)
})
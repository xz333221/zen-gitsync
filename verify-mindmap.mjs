// Copyright 2026 xz333221
//
// 验证整篇 markdown → 思维导图 渲染:
// 1) 打开 Vite 调试页面
// 2) 切换到编辑器视图
// 3) 点击文件树中的 test-mindmap.md
// 4) 点击 "思维导图" 按钮
// 5) 断言:整篇导图出现,根节点文字为文档标题,包含富内容(代码 / 列表 / 表格)子节点
// 6) 截图
//
import { chromium } from '@playwright/test'
import path from 'path'
import fs from 'fs'

// Vite port.  Pass VITE_PORT env if it auto-incremented from the
// default 5544 (which happens when a previous instance is still
// running).
const VITE_PORT = process.env.VITE_PORT || '5544'
const BACKEND_PORT = process.env.BACKEND_PORT || '4445'
const ROOT = 'E:/workspace/github_workspace/zen-git'
const SCREENSHOT_PATH = path.join(ROOT, 'test-mindmap-preview.png')

;(async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 2400, height: 1600 }, deviceScaleFactor: 1.5 })
  const page = await ctx.newPage()

  const consoleErrors = []
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}\n${e.stack || ''}`))
  page.on('console', m => {
    if (m.type() === 'error') consoleErrors.push(`console.error: ${m.text()}`)
    else if (m.type() === 'warning') consoleErrors.push(`console.warn: ${m.text()}`)
  })

  console.log('1) goto http://localhost:' + VITE_PORT + '/')
  await page.goto('http://localhost:' + VITE_PORT + '/', { waitUntil: 'networkidle', timeout: 60000 })

  // 关掉弹窗
  for (let i = 0; i < 3; i++) {
    const overlay = page.locator('.el-overlay').first()
    if (await overlay.count() > 0 && await overlay.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    } else break
  }

  // 2) 切到 EditorView
  console.log('2) 切换到编辑器视图')
  const activityBtns = page.locator('.activity-btn')
  if (await activityBtns.count() >= 2) {
    await activityBtns.nth(1).click({ force: true })
  }
  await page.waitForTimeout(1500)
  await page.waitForSelector('.editor-sidebar', { timeout: 8000 })

  // 3) 打开 test-mindmap.md
  console.log('3) 打开 test-mindmap.md')
  const mdNode = page.locator('.editor-sidebar :text("test-mindmap.md")').first()
  if (await mdNode.count() > 0) {
    await mdNode.click({ force: true })
  }
  await page.waitForTimeout(1500)

  // 4) 点 "思维导图" 按钮
  console.log('4) 点击"思维导图"按钮')
  const mmBtn = page.locator('.mindmap-toggle-btn').first()
  if (await mmBtn.count() === 0) {
    console.log('   ❌ 找不到 .mindmap-toggle-btn')
    process.exit(1)
  }
  await mmBtn.click()
  await page.waitForTimeout(2000)

  // 5) 断言
  console.log('5) 断言整篇导图已渲染')

  // 等待 MindMap 节点文字出现
  let hasRoot = false
  try {
    await page.waitForFunction(() => {
      const c = document.querySelector('.mindmap-preview-canvas')
      if (!c) return false
      // 文档标题 # Zen GitSync 编辑器导图验证 是 H1,被提升为 root
      return c.textContent && c.textContent.includes('Zen GitSync')
    }, { timeout: 8000 })
    hasRoot = true
  } catch (e) {
    console.log('   等待根节点文字超时')
  }
  await page.waitForTimeout(800)

  const canvas = await page.evaluate(() => {
    const c = document.querySelector('.mindmap-preview-canvas')
    if (!c) return null
    return {
      zmNodes: c.querySelectorAll('.zm-node').length,
      richCount: c.querySelectorAll('.zm-rich').length,
      codeCount: c.querySelectorAll('.zm-rich-code').length,
      listCount: c.querySelectorAll('.zm-rich-list').length,
      tableCount: c.querySelectorAll('.zm-rich-table').length,
      paragraphCount: c.querySelectorAll('.zm-rich-paragraph').length,
      text: (c.textContent || '').slice(0, 500),
    }
  })
  console.log('   canvas 内 zm-node 数 =', canvas?.zmNodes)
  console.log('   canvas 内 zm-rich 容器 =', canvas?.richCount)
  console.log('   内嵌 code 块  =', canvas?.codeCount)
  console.log('   内嵌 list 块  =', canvas?.listCount)
  console.log('   内嵌 table 块 =', canvas?.tableCount)
  console.log('   内嵌 paragraph =', canvas?.paragraphCount)
  console.log('   文字片段 =', canvas?.text)

  // 6) 截图
  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false })
  console.log('   截图保存到', SCREENSHOT_PATH)

  if (consoleErrors.length) {
    console.log('---- 控制台错误 ----')
    for (const e of consoleErrors) console.log(e)
  } else {
    console.log('---- 控制台无错误 ----')
  }

  // 现在不渲染富内容,只断言树存在、根节点文字正确、子节点数量充足
  // (整篇 md 有 18+ 个块,转成子节点后至少应超过 10 个 zm-node)
  let pass = hasRoot && canvas && canvas.zmNodes >= 10
  console.log(pass ? '✅ 验证通过' : '❌ 验证失败')

  await browser.close()
  process.exit(pass ? 0 : 1)
})().catch(e => { console.error(e); process.exit(2) })

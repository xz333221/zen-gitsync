// Screenshot flow-mindmap demo with #rich sample data loaded.
import { chromium } from '@playwright/test'
import path from 'path'

const ROOT = 'E:/workspace/github_workspace/zen-git'
const SHOT = path.join(ROOT, 'test-rich-demo.png')

;(async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 2800, height: 1800 }, deviceScaleFactor: 1.5 })
  const page = await ctx.newPage()
  page.on('pageerror', e => console.log('pageerror:', e.message))

  console.log('1) goto http://localhost:7851/#rich')
  await page.goto('http://localhost:7851/#rich', { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForSelector('.zm-node', { timeout: 10000 })
  // 等 MindMap 节点全部出现 + 边线画完
  await page.waitForFunction(() => {
    const c = document.querySelector('.zm-app-canvas')
    if (!c) return false
    return c.querySelectorAll('.zm-node').length >= 10
  }, { timeout: 10000 })
  await page.waitForTimeout(800)

  // dump 节点统计
  const stats = await page.evaluate(() => {
    const c = document.querySelector('.zm-app-canvas')
    if (!c) return null
    return {
      nodes: c.querySelectorAll('.zm-node').length,
      rich: c.querySelectorAll('.zm-rich').length,
      codeBlocks: c.querySelectorAll('.zm-rich-code').length,
      tables: c.querySelectorAll('.zm-rich-table').length,
      noteBtns: c.querySelectorAll('.zm-node-note-btn').length,
      linkBtns: c.querySelectorAll('.zm-node-link').length,
      images: c.querySelectorAll('.zm-node-img').length,
      text: (c.textContent || '').slice(0, 300),
    }
  })
  console.log('   stats:', stats)

  await page.screenshot({ path: SHOT, fullPage: false })
  console.log('   截图 →', SHOT)

  await browser.close()
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })

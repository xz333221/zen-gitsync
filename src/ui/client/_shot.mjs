import { chromium } from '@playwright/test'

;(async () => {
  const b = await chromium.launch()
  const ctx = await b.newContext({ viewport: { width: 2800, height: 1800 }, deviceScaleFactor: 1.5 })
  const p = await ctx.newPage()
  p.on('pageerror', e => console.log('pageerror:', e.message))

  await p.goto('http://localhost:7851/#rich', { waitUntil: 'networkidle', timeout: 60000 })
  await p.waitForSelector('.zm-node', { timeout: 10000 })
  await p.waitForTimeout(1500)
  // 截一张无 drawer 的,清晰展示节点
  await p.screenshot({ path: 'E:/workspace/github_workspace/zen-git/test-rich-demo.png', fullPage: false })
  console.log('shot 1: clean canvas')

  // 退出预览模式 + 打开大纲 + 打开数据
  const exitBtn = p.locator('.zm-app-preview-exit').first()
  if (await exitBtn.count() > 0) {
    await exitBtn.click()
    await p.waitForTimeout(500)
  }
  // 工具栏按钮顺序:大纲 / 数据 / Markdown / 设置 / rich / 预览
  const tbBtns = p.locator('.zm-app-toolbar .zm-app-icon-btn')
  const c = await tbBtns.count()
  console.log('toolbar btns:', c)
  for (let i = 0; i < c; i++) {
    const title = await tbBtns.nth(i).getAttribute('title')
    console.log('  [' + i + ']', title)
  }
  // 打开大纲(0) + 数据(1)
  if (c > 1) {
    await tbBtns.nth(0).click()
    await p.waitForTimeout(400)
    await tbBtns.nth(1).click()
    await p.waitForTimeout(400)
  }
  await p.waitForTimeout(800)
  await p.screenshot({ path: 'E:/workspace/github_workspace/zen-git/test-rich-demo-with-drawers.png', fullPage: false })
  console.log('shot 2: with drawers')

  // dump stats
  const stats = await p.evaluate(() => {
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
    }
  })
  console.log('stats:', stats)
  await b.close()
})().catch(e => { console.error(e); process.exit(1) })

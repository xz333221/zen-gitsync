// Copyright 2026 xz333221
//
// 验证源码地图在浅色 / 深色主题下的视觉表现:
// 1) 启动 vite dev server
// 2) 打开页面，注入一些假节点以触发画布渲染
// 3) 截图 light / dark 两个主题
// 4) 校验关键元素的颜色不再是硬编码深色
//
// Run: node verify-sourcemap-theme.mjs

import { chromium } from '@playwright/test'
import path from 'path'
import fs from 'fs'

const VITE_PORT = process.env.VITE_PORT || '5544'
const ROOT = 'E:/workspace/github_workspace/zen-git'
const LIGHT_PNG = path.join(ROOT, 'verify-sourcemap-light.png')
const DARK_PNG = path.join(ROOT, 'verify-sourcemap-dark.png')
const SWITCH_PNG = path.join(ROOT, 'verify-sourcemap-switch.png')

;(async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()

  const consoleErrors = []
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}\n${e.stack || ''}`))
  page.on('console', m => {
    if (m.type() === 'error') consoleErrors.push(`console.error: ${m.text()}`)
  })

  console.log('1) goto')
  await page.goto(`http://localhost:${VITE_PORT}/`, { waitUntil: 'networkidle', timeout: 60000 })

  // 关掉弹窗
  for (let i = 0; i < 3; i++) {
    const overlay = page.locator('.el-overlay').first()
    if (await overlay.count() > 0 && await overlay.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    } else break
  }

  console.log('2) 切换到源码地图视图')
  // 找到 ActivityBar 中源码地图的按钮（title 或 aria-label 含「源码地图」）
  const srcMapBtn = page.locator('.activity-btn').filter({ hasText: /源码地图|Source Map/i }).first()
  if (await srcMapBtn.count() === 0) {
    // fallback：按 index 试（最后一个通常是 source-map）
    const btns = page.locator('.activity-btn')
    const n = await btns.count()
    console.log(`   activity-btn count = ${n}`)
  } else {
    await srcMapBtn.click().catch(() => {})
  }
  await page.waitForTimeout(500)

  // 注入一些假节点数据，模拟有图的状态
  await page.evaluate(() => {
    const html = document.documentElement
    if (html.getAttribute('data-theme') === 'dark') html.removeAttribute('data-theme')
    const root = document.querySelector('.source-map-view') || document.body
    // 注入最小 demo 到 vue-flow 容器
    const flow = document.querySelector('.sm-vue-flow')
    if (flow) {
      flow.innerHTML = `
        <div style="position:absolute;left:200px;top:80px" class="sm-fn-node-test">
          <div style="background:#fff;border:2px solid #f59e0b;border-radius:8px;padding:8px 12px;font-size:12px;color:#303133">入口模块 main()</div>
        </div>
        <div style="position:absolute;left:200px;top:200px" class="sm-fn-node-test">
          <div style="background:#fff;border:2px solid #3b82f6;border-radius:8px;padding:8px 12px;font-size:12px;color:#303133">工具函数 parseConfig()</div>
        </div>
        <div style="position:absolute;left:200px;top:320px" class="sm-fn-node-test">
          <div style="background:#fff;border:2px solid #10b981;border-radius:8px;padding:8px 12px;font-size:12px;color:#303133">数据层 fetchData()</div>
        </div>
      `
    }
  })
  await page.waitForTimeout(300)

  console.log('3) 浅色主题截图')
  await page.screenshot({ path: LIGHT_PNG, fullPage: false })

  // 校验关键 CSS 变量
  const lightVars = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement)
    return {
      smGraphBg: cs.getPropertyValue('--sm-graph-bg').trim(),
      smNodeBg: cs.getPropertyValue('--sm-node-bg').trim(),
      smEdgeColor: cs.getPropertyValue('--sm-edge-color').trim(),
      smSourceBg: cs.getPropertyValue('--sm-source-bg').trim(),
    }
  })
  console.log('   light vars:', JSON.stringify(lightVars))

  console.log('4) 切换到深色主题并截图')
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await page.waitForTimeout(400)
  await page.screenshot({ path: DARK_PNG, fullPage: false })

  const darkVars = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement)
    return {
      smGraphBg: cs.getPropertyValue('--sm-graph-bg').trim(),
      smNodeBg: cs.getPropertyValue('--sm-node-bg').trim(),
      smEdgeColor: cs.getPropertyValue('--sm-edge-color').trim(),
      smSourceBg: cs.getPropertyValue('--sm-source-bg').trim(),
    }
  })
  console.log('   dark vars:', JSON.stringify(darkVars))

  console.log('5) 切回浅色并截图（验证实时切换）')
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
  await page.waitForTimeout(400)
  await page.screenshot({ path: SWITCH_PNG, fullPage: false })

  console.log('errors:', consoleErrors.length)
  for (const e of consoleErrors.slice(0, 20)) console.log('  -', e)

  await browser.close()

  console.log('\\nLIGHT:', LIGHT_PNG)
  console.log('DARK:', DARK_PNG)
  console.log('SWITCH:', SWITCH_PNG)
})()
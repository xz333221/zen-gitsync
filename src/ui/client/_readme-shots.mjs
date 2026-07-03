// README 专用截图脚本 v4
// 每个视图用 page.goto 强制刷新 + wait 网络空闲 + 等关键 DOM,避免前一个视图状态污染
import { chromium } from '@playwright/test'
import fs from 'fs'
import path from 'path'

const BASE = 'http://127.0.0.1:5544'
const OUT = 'E:/workspace/github_workspace/zen-git/public/images'
const VIEWPORT = { width: 1600, height: 1000 }

async function shot(page, name) {
  const file = path.join(OUT, name)
  await page.screenshot({ path: file, fullPage: false })
  const sz = fs.statSync(file).size
  console.log(`  ✓ ${name} (${(sz / 1024).toFixed(1)} KB)`)
}

// 在浏览器里通过 hash 切视图,然后等待目标 DOM 出现
// hash 路由(view=gallery / view=editor / view=sourceMap / view=workbench / view=monitor / view=mindmap)
async function gotoView(page, hashKey, waitSelectors = [], hash = '') {
  const url = hashKey ? `${BASE}/#/${hashKey}` : BASE
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForLoadState('networkidle').catch(() => {})
  // 等 Activity Bar 出现
  await page.waitForSelector('.activity-btn', { timeout: 15000 }).catch(() => {})
  // 如果有 hash,点击对应 Activity Bar 按钮(更稳)
  if (hashKey) {
    const ariaMap = {
      gallery: 'Git · 14 个未提交文件',
      editor: '编辑器',
      sourceMap: '源码地图',
      workbench: '工作台',
      monitor: '系统监控',
      mindmap: '思维导图',
      console: '控制台',
    }
    const aria = ariaMap[hashKey]
    if (aria) {
      const btn = page.locator(`.activity-btn[aria-label="${aria}"]`).first()
      if ((await btn.count()) > 0) {
        await btn.click({ force: true })
        await page.waitForLoadState('networkidle').catch(() => {})
      }
    }
  }
  // 等关键 DOM 出现
  for (const sel of waitSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 8000, state: 'visible' })
    } catch {}
  }
  await page.waitForTimeout(1500)
}

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 })
const page = await ctx.newPage()

page.on('pageerror', e => console.log('pageerror:', e.message))
page.on('console', m => { if (m.type() === 'error') console.log('console.error:', m.text().slice(0, 200)) })

// === 1. Git 面板(默认视图) ===
console.log('=> [1/12] Git panel')
await gotoView(page, null, ['.file-list, [class*="git-status"]'])
await shot(page, 'git-panel-changes.png')

// === 2. 切换目录弹窗 ===
console.log('=> [2/12] Directory switcher')
const switchBtn = page.locator(`button[aria-label="切换工作目录"]`).first()
if ((await switchBtn.count()) > 0) {
  await switchBtn.click({ force: true })
  await page.waitForTimeout(1200)
  await shot(page, 'directory-switcher.png')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
}

// === 3. 编辑器(等 monaco 出现) ===
console.log('=> [3/12] Editor')
await gotoView(page, 'editor', ['.file-tree, [class*="file-tree"]', '.monaco-editor'])
await shot(page, 'code-editor.png')

// === 4. 编辑器 markdown 预览 ===
console.log('=> [4/12] Editor markdown preview')
// 找 README.md 节点
const readmeNode = page.locator(`[class*="tree-node"]:has-text("README.md")`).first()
if ((await readmeNode.count()) > 0) {
  await readmeNode.click({ force: true }).catch(() => {})
  await page.waitForTimeout(2000)
  // 找"预览"按钮(通常 markdown 预览切换)
  const previewBtn = page.locator(`button[aria-label*="预览"], button:has-text("预览")`).first()
  if ((await previewBtn.count()) > 0) {
    await previewBtn.click({ force: true }).catch(() => {})
    await page.waitForTimeout(1500)
  }
}
await shot(page, 'code-editor-markdown-preview.png')

// === 5. 源码地图 ===
console.log('=> [5/12] Source map')
await gotoView(page, 'sourceMap', ['[class*="source-map"]', 'button:has-text("开始分析")'])
await shot(page, 'source-map.png')

// === 6. 工作台 ===
console.log('=> [6/12] Workbench')
await gotoView(page, 'workbench', ['[class*="workbench"]', '[class*="task-list"], input[placeholder*="标题"]'])
await page.waitForTimeout(2500)  // workbench 体积大,多等一会
await shot(page, 'workbench-task-list.png')

// === 7. 工作台任务详情 ===
console.log('=> [7/12] Workbench task detail')
const taskItem = page.locator(`[class*="task-item"]:not([class*="task-list"]), [class*="task-row"]`).first()
if ((await taskItem.count()) > 0) {
  await taskItem.click({ force: true }).catch(() => {})
  await page.waitForTimeout(2000)
}
await shot(page, 'workbench-task-detail.png')

// === 8. 控制台 ===
console.log('=> [8/12] Console overview')
await gotoView(page, 'console', ['[class*="console"]', '[class*="command-console"]'])
await page.waitForTimeout(2000)
await shot(page, 'console-overview.png')

// === 9. 自定义命令 ===
console.log('=> [9/12] Custom commands')
// 找 "命令" / 自定义命令 侧栏
const cmdTab = page.locator(`*:text-is("命令"):visible`).first()
if ((await cmdTab.count()) > 0) {
  await cmdTab.click({ force: true }).catch(() => {})
  await page.waitForTimeout(1000)
} else {
  // fallback: 在控制台视图里点 "自定义命令" 区
  const customCmd = page.locator(`*:has-text("自定义命令"):visible`).first()
  if ((await customCmd.count()) > 0) {
    await customCmd.click({ force: true }).catch(() => {})
    await page.waitForTimeout(1000)
  }
}
await shot(page, 'custom-commands.png')

// === 10. 流程编排 ===
console.log('=> [10/12] Flow orchestration')
const flowTab = page.locator(`*:text-is("流程"):visible, *:text-is("流程编排"):visible`).first()
if ((await flowTab.count()) > 0) {
  await flowTab.click({ force: true }).catch(() => {})
  await page.waitForTimeout(2500)
}
await shot(page, 'flow-orchestration.png')

// === 11. 终端 ===
console.log('=> [11/12] Terminal')
const termTab = page.locator(`*:text-is("终端"):visible`).first()
if ((await termTab.count()) > 0) {
  await termTab.click({ force: true }).catch(() => {})
  await page.waitForTimeout(1500)
}
await shot(page, 'built-in-terminal.png')

// === 12. NPM 脚本面板(回到 Git 视图展开左下角) ===
console.log('=> [12/12] NPM scripts panel')
await gotoView(page, 'gallery', ['.file-list'])
const npmHeader = page.locator(`text=NPM 脚本`).first()
if ((await npmHeader.count()) > 0) {
  await npmHeader.click({ force: true }).catch(() => {})
  await page.waitForTimeout(1500)
}
await shot(page, 'npm-scripts.png')

// === 13. 用户设置弹窗 ===
console.log('=> [13/13] Settings')
const settingsBtn = page.locator(`button[aria-label="用户设置"]`).first()
if ((await settingsBtn.count()) > 0) {
  await settingsBtn.click({ force: true })
  await page.waitForTimeout(1500)
  await shot(page, 'settings-general.png')
  // Git tab
  const gitTab = page.locator(`*:text-is("Git"):visible`).first()
  if ((await gitTab.count()) > 0) {
    await gitTab.click({ force: true }).catch(() => {})
    await page.waitForTimeout(800)
    await shot(page, 'settings-git.png')
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
}

await browser.close()
console.log('\n=== 全部完成 ===')
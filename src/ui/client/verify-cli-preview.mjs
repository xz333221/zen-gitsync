// 一次性浏览器验证脚本(用完即删):验证
//  1) 没有自定义命令时「定时提交」区块仍贴在侧栏底部(修复前会顶到最上面)
//  2) 「等效命令行」预览随设置变化,且复制按钮可用
import { chromium } from 'playwright'
import fs from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const APP = 'http://127.0.0.1:5544/'
const OUT = 'C:/Users/xuze3/AppData/Local/Temp/zen-verify'
fs.mkdirSync(OUT, { recursive: true })

const CMDS = [
  { id: 'c1', name: 'zen-gitsync: dev', description: 'npm run dev', directory: 'C:/x', command: 'npm run dev', params: [] },
  { id: 'c2', name: 'zen-gitsync: release', description: 'npm run release', directory: 'C:/x', command: 'npm run release', params: [] },
]

async function probe(label, { customCommands, currentDirectory, defaultCommitMessage }) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'])
  const page = await ctx.newPage()

  const errs = []
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)) })

  await page.route('**/api/config/getConfig', async route => {
    const resp = await route.fetch()
    const cfg = await resp.json()
    if (customCommands !== undefined) cfg.customCommands = customCommands
    if (currentDirectory !== undefined) cfg.currentDirectory = currentDirectory
    if (defaultCommitMessage !== undefined) cfg.defaultCommitMessage = defaultCommitMessage
    await route.fulfill({ json: cfg })
  })

  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  // 切到「控制台」视图(侧栏就是 CustomCommandsPanel)
  await page.waitForSelector('.activity-btn[aria-label^="控制台"]', { timeout: 40000 })
  await page.click('.activity-btn[aria-label^="控制台"]')
  await page.waitForSelector('.custom-commands-panel .schedule-section', { timeout: 30000 })
  await page.waitForTimeout(600)

  const m = await page.evaluate(() => {
    const box = el => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) } }
    const q = s => document.querySelector(s)
    const cli = q('.schedule-cli-text')
    return {
      sidebar: box(q('.console-view__sidebar')),
      panel: box(q('.custom-commands-panel')),
      empty: q('.empty-container') ? box(q('.empty-container')) : null,
      list: q('.commands-list') ? box(q('.commands-list')) : null,
      schedule: box(q('.schedule-section')),
      cliHTML: cli ? cli.outerHTML : null,
      cliText: cli ? cli.textContent : null,
      hints: [...document.querySelectorAll('.schedule-cli-hint')].map(e => e.textContent.trim()),
      cliComputed: cli ? (() => { const s = getComputedStyle(cli); return { fontFamily: s.fontFamily, fontSize: s.fontSize, userSelect: s.userSelect, whiteSpace: s.whiteSpace } })() : null,
    }
  })

  await page.screenshot({ path: `${OUT}/${label}-full.png` })
  await page.locator('.console-view__sidebar').screenshot({ path: `${OUT}/${label}-sidebar.png` })

  // 复制按钮 → 剪贴板
  let clipboard = null
  try {
    await page.click('.schedule-cli-box .icon-button')
    await page.waitForTimeout(300)
    clipboard = await page.evaluate(() => navigator.clipboard.readText())
  } catch (e) { clipboard = 'CLICK_FAILED: ' + e.message.slice(0, 120) }
  await page.screenshot({ path: `${OUT}/${label}-after-copy.png` })

  await browser.close()
  return { label, metrics: m, clipboard, errors: errs.slice(0, 3) }
}

const results = []
results.push(await probe('A-empty-no-commands', {
  customCommands: [],
  currentDirectory: 'C:\\workspace\\gitee_workspace\\flowdash-home-desktop',
  defaultCommitMessage: 'submit',
}))
results.push(await probe('B-with-commands', {
  customCommands: CMDS,
  currentDirectory: 'C:\\workspace\\gitee_workspace\\flowdash-home-desktop',
  defaultCommitMessage: 'submit',
}))

for (const r of results) {
  const { sidebar, schedule, empty, list } = r.metrics
  console.log(`\n===== ${r.label} =====`)
  console.log('sidebar ', JSON.stringify(sidebar))
  console.log('empty   ', JSON.stringify(empty))
  console.log('list    ', JSON.stringify(list))
  console.log('schedule', JSON.stringify(schedule))
  console.log('gap(sidebar.bottom - schedule.bottom) =', sidebar.bottom - schedule.bottom)
  console.log('cliText =', JSON.stringify(r.metrics.cliText))
  console.log('cliComputed =', JSON.stringify(r.metrics.cliComputed))
  console.log('hints =', JSON.stringify(r.metrics.hints))
  console.log('clipboard =', JSON.stringify(r.clipboard))
  console.log('consoleErrors =', JSON.stringify(r.errors))
}

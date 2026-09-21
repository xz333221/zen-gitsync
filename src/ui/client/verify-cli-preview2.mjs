// 一次性验证脚本 2(用完即删):
//  1) 对照组:临时注入 CSS 撤掉本次修复 → 定时提交区块应回到顶部(证明测得的就是这条规则)
//  2) 响应式:切 AI 模式 / 自定义信息 → 等效命令行实时变化
//  3) 差异提示:关掉「启动时立即提交一次」「自动推送」→ 出现两条 CLI 无法复现的提示
import { chromium } from 'playwright'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const APP = 'http://127.0.0.1:5544/'
const OUT = 'C:/Users/xuze3/AppData/Local/Temp/zen-verify'

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })

await page.route('**/api/config/getConfig', async route => {
  const cfg = await (await route.fetch()).json()
  cfg.customCommands = []
  cfg.currentDirectory = 'C:\\workspace\\gitee_workspace\\flowdash-home-desktop'
  cfg.defaultCommitMessage = 'submit'
  await route.fulfill({ json: cfg })
})

await page.goto(APP, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.activity-btn[aria-label^="控制台"]', { timeout: 40000 })
await page.click('.activity-btn[aria-label^="控制台"]')
await page.waitForSelector('.schedule-section', { timeout: 30000 })
await page.waitForTimeout(500)

const geo = () => page.evaluate(() => {
  const b = s => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) } }
  return { sidebar: b('.console-view__sidebar'), empty: b('.empty-container'), schedule: b('.schedule-section') }
})

console.log('--- 1) 对照组:撤掉修复(empty-container flex:0 0 auto) ---')
console.log('修复生效  ', JSON.stringify(await geo()))
await page.addStyleTag({ content: '.console-view__sidebar .custom-commands-panel .empty-container{flex:0 0 auto!important;overflow:visible!important}' })
await page.waitForTimeout(300)
const broken = await geo()
console.log('撤掉修复后', JSON.stringify(broken))
console.log('→ 定时提交顶部位置从', (await geo()).schedule.top, '上移到', broken.schedule.top, '(差值 =', broken.schedule.top - 494, 'px)')
await page.screenshot({ path: `${OUT}/C-broken-control-group.png` })

await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('.activity-btn[aria-label^="控制台"]', { timeout: 40000 })
await page.click('.activity-btn[aria-label^="控制台"]')
await page.waitForSelector('.schedule-section', { timeout: 30000 })
await page.waitForTimeout(500)

const cli = () => page.textContent('.schedule-cli-text')
console.log('\n--- 2) 等效命令行随设置实时变化 ---')
console.log('默认模式  ', JSON.stringify(await cli()))

await page.click('.schedule-row .el-radio:nth-of-type(2)')  // AI 生成
await page.waitForTimeout(200)
console.log('AI 模式   ', JSON.stringify(await cli()))

await page.click('.schedule-row .el-radio:nth-of-type(1)')  // 回到默认
await page.fill('.schedule-message-input input', 'docs: 定时归档笔记')
await page.waitForTimeout(200)
console.log('自定义信息', JSON.stringify(await cli()))

await page.click('.schedule-header-right .el-switch')  // 启动定时,看命令是否仍可读
await page.waitForTimeout(400)
console.log('定时运行中', JSON.stringify(await cli()))
console.log('倒计时提示', JSON.stringify(await page.textContent('.schedule-countdown').catch(() => null)))
await page.click('.schedule-header-right .el-switch')

console.log('\n--- 3) 差异提示(关掉两个 CLI 没有开关的行为) ---')
console.log('默认 hints =', JSON.stringify(await page.$$eval('.schedule-cli-hint', els => els.map(e => e.textContent.trim()))))
await page.click('.schedule-commit-now')       // 取消「启动时立即提交一次」
await page.click('.schedule-row:nth-of-type(5) .el-checkbox')  // 取消「提交后自动推送到远程」
await page.waitForTimeout(300)
console.log('关掉后 hints =', JSON.stringify(await page.$$eval('.schedule-cli-hint', els => els.map(e => e.textContent.trim()))))
await page.screenshot({ path: `${OUT}/D-hints.png` })
await page.locator('.console-view__sidebar').screenshot({ path: `${OUT}/D-hints-sidebar.png` })

await browser.close()

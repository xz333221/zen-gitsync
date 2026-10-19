/**
 * 产品 UI 截图工具:对正在运行的 zen-gitsync GUI 截当前界面的图,
 * 产出官网(website)与 README 用的截图。UI 改版后重跑即可刷新全部截图。
 *
 * 用法:
 *   1. 启动 GUI:        npm run dev        (后端 5545 + vite 5544)
 *   2. 确认主题:        config.json 的 theme 决定截图主题;官网锁 dark,
 *                       截官网用图前先把它改成 'dark',截完再改回用户原值
 *   3. 跑:              node scripts/capture-ui-shots.mjs
 *   4. 同步官网用图:    node website/scripts/sync-shots.mjs
 *
 * 依赖 src/ui/client 里已安装的 playwright(浏览器已下载)。
 * 每张图独立 try/catch:某一张失败不影响其余,结尾汇总成败。
 * 调试:加 --debug 参数,每个视图会把可见按钮的 aria-label / 文本打出来。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const DEBUG = process.argv.includes('--debug')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const VIEWPORT = { width: 1600, height: 1000 }

// 截图落地目录(全部是 git 跟踪的源目录;website/public/shots 由 sync-shots.mjs 生成)
const L = path.join(root, 'docs', 'screenshots', '手写版介绍文章图片') // 官网落地页 + 手写文章
const A = path.join(root, 'docs', 'screenshots', 'article') // 官网文档页 + 工作台推广文章
const D = path.join(root, 'docs', 'screenshots') // 文档页暗色套图
const R = path.join(root, 'public', 'images') // README 用图

const require = createRequire(path.join(root, 'src', 'ui', 'client', 'package.json'))
const { chromium } = require('playwright')

const results = []
const shot = async (page, file, label) => {
  try {
    await page.screenshot({ path: file })
    results.push(`  ok   ${label} -> ${path.relative(root, file)}`)
  } catch (e) {
    results.push(`  FAIL ${label}: ${e.message}`)
  }
}

const elShot = async (page, selector, file, label) => {
  try {
    const el = page.locator(selector).first()
    await el.waitFor({ state: 'visible', timeout: 8000 })
    await el.screenshot({ path: file })
    results.push(`  ok   ${label} -> ${path.relative(root, file)}`)
  } catch (e) {
    results.push(`  FAIL ${label}: ${e.message}`)
  }
}

async function dumpButtons(page, label) {
  if (!DEBUG) return
  const items = await page.evaluate(() =>
    [...document.querySelectorAll('button, [role="button"], a')]

      .map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 40))
      .filter(Boolean)
      .slice(0, 60)
  )
  console.log(`  [debug:${label}] ${items.join(' | ')}`)
}

/** 等页面的「加载中」骨架消失且持续消失(视图数据到位),再给一点稳定时间。
 *  连续 3 次干净才放行:视图是「块加载完 → 数据骨架 → 数据到位」两段式,
 *  单次检查会撞上中间那个空窗。 */
async function waitSettled(page) {
  let clean = 0
  for (let i = 0; i < 40 && clean < 3; i++) {
    const loading = await page.evaluate(() => document.body.innerText.includes('加载中')).catch(() => true)
    if (loading) clean = 0
    else clean++
    await page.waitForTimeout(700)
  }
  await page.waitForTimeout(1200)
}

/** 点左侧活动栏切换视图,等视图渲染稳定。
 *  活动栏按钮的 aria-label 是计算值(带徽章时会变长,如「工作台 · 2 个任务正在执行」),
 *  所以用前缀匹配,并在多个匹配里挑第一个可见的(避开移动端布局里的隐藏副本)。
 *  返回 false 表示导航失败(已打印诊断),调用方应跳过后续截图。 */
async function gotoView(page, ariaLabel) {
  // 必须限定 .activity-btn:顶栏有「Git 操作」等按钮,光靠 aria-label 前缀会误点
  const sel = `button.activity-btn[aria-label^="${ariaLabel}"]`
  for (let round = 1; round <= 2; round++) {
    try {
      const loc = page.locator(sel)
      await loc.first().waitFor({ state: 'attached', timeout: 8000 })
      const n = await loc.count()
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i)
        if (await el.isVisible().catch(() => false)) {
          await el.click()
          await waitSettled(page)
          return true
        }
      }
      throw new Error(`匹配 ${n} 个但都不可见`)
    } catch (e) {
      const btns = await page.locator('button.activity-btn').count().catch(() => -1)
      const text = (await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 120)
      console.log(`  ! gotoView(${ariaLabel}) 第 ${round} 次失败: ${e.message} | activity-btn=${btns} | body="${text.replace(/\n/g, ' ')}"`)
      if (round === 1) {
        // 应用可能处于坏状态(重载中 / 崩溃):reload 后等它完整启动再试
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
        await page.locator('button.activity-btn').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
        await waitSettled(page)
      }
    }
  }
  return false
}

/** 切到某视图并截图;导航失败则记一条 skip,不拍 */
async function captureView(page, ariaLabel, file, label) {
  if (!(await gotoView(page, ariaLabel))) {
    results.push(`  skip ${label}: 视图切换失败`)
    return false
  }
  await shot(page, file, label)
  return true
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 })
page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`  [console:error] ${m.text().slice(0, 160)}`)
})

console.log(`打开 ${BASE} ...`)
// dev 环境下后端启动会写 .env.local 触发 vite 重启一次,首屏模块请求可能撞上重启窗口;
// 这里最多重试两次加载
let booted = false
for (let attempt = 1; attempt <= 2 && !booted; attempt++) {
  try {
    if (attempt === 2) {
      console.log('  首屏没起来,reload 再试')
      await page.reload({ waitUntil: 'domcontentloaded' })
    } else {
      await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    }
    await page.locator('button[aria-label="Git"]').first().waitFor({ state: 'visible', timeout: 45000 })
    booted = true
  } catch {
    /* 进入下一次重试 */
  }
}
if (!booted) {
  console.error('GUI 首屏 45s 内没渲染出活动栏,放弃。先确认 npm run dev 已就绪且主题为 dark。')
  process.exit(1)
}
await waitSettled(page)

// 主题核对:官网用图要求暗色
const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
if (theme !== 'dark') {
  console.log('  ! 当前不是暗色主题(config.json theme 应为 "dark"),尝试点顶栏主题切换')
  await dumpButtons(page, 'header')
  const toggle = page.locator('button[aria-label*="主题"], button[title*="主题"]').first()
  if (await toggle.count()) {
    await toggle.click()
    await page.waitForTimeout(800)
  }
}

// ── 0. 预热巡航:把所有视图先点一遍 ──────────────────────────────────────────
// 工作台/项目管理/智能体首帧要打 /api/workbench/projects 之类的接口,
// 冷调用(全盘项目扫描 + favicon 探测)要 10 秒以上;先巡航一遍让服务端缓存热起来,
// 正式截图时各个视图才能秒开。源码地图入口当前隐藏(SHOW_SOURCE_MAP=false),跳过。
console.log('预热巡航(触发各视图的冷接口)...')
for (const view of ['控制台', '智能体', '文件空间', '工作台', '项目管理', '系统监控', '思维导图']) {
  await gotoView(page, view)
}
await gotoView(page, 'Git')

// ── 1. Git 面板(文件列表 + diff + 提交区)────────────────────────────────────
// 前置:仓库根目录放一个未追踪的 tmp-shot-change.md,文件列表才有东西可点
await page.locator('.file-row, .file-item, [class*="file"]').first().waitFor({ timeout: 15000 }).catch(() => {})
await waitSettled(page)
await dumpButtons(page, 'git')
await shot(page, path.join(L, '05-git-commit-view.png'), 'Git 面板(官网)')
await shot(page, path.join(R, 'git-panel-changes.png'), 'Git 面板(README)')

// ── 2. AI 启动建议面板(Git 视图左栏,元素级截图)──────────────────────────────
await elShot(page, '.startup-ai-panel', path.join(R, 'startup-ai-panel.png'), 'AI 启动建议面板(README)')

// ── 3. 快速切换目录弹窗 ────────────────────────────────────────────────────
try {
  // 顶栏目录名 / 文件夹图标都能开;先试目录胶囊里的文件夹按钮
  const dirBtn = page.locator('header button[aria-label*="目录"], header button[aria-label*="切换"]').first()
  if (await dirBtn.count()) {
    await dirBtn.click()
  } else {
    // 兜底:点顶栏里显示当前目录名的元素
    await page.locator('header').getByText(/zen-git/i).first().click()
  }
  await page.waitForTimeout(1200)
  await shot(page, path.join(R, 'directory-switcher.png'), '切换目录弹窗(README)')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
} catch (e) {
  results.push(`  FAIL 切换目录弹窗(README): ${e.message}`)
}

// ── 4. 远程管理弹窗(Git 视图,远程卡片上的齿轮)──────────────────────────────
try {
  const gear = page.locator('[class*="remote"] button[aria-label*="远程"], [class*="remote"] [class*="gear"]').first()
  if (await gear.count()) {
    await gear.click()
  } else {
    // 兜底:推送按钮下拉里的「管理远程…」
    await page.getByRole('button', { name: /推送/ }).first().click()
    await page.waitForTimeout(600)
    await page.getByText('管理远程…').first().click()
  }
  await page.waitForTimeout(1200)
  await shot(page, path.join(D, '17-remote-manager-dark.png'), '远程管理弹窗(文档页)')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
} catch (e) {
  results.push(`  FAIL 远程管理弹窗(文档页): ${e.message}`)
}

// ── 5. 分支下拉(顶栏 .branch-btn,不在 <header> 标签里,别加 header 作用域)────
try {
  const branch = page.locator('.branch-btn').first()
  if (await branch.count()) {
    await branch.click()
    await page.waitForTimeout(1200)
    await shot(page, path.join(D, '18-branch-selector-dark.png'), '分支下拉(文档页)')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  } else {
    results.push('  FAIL 分支下拉(文档页): 找不到 .branch-btn')
  }
} catch (e) {
  results.push(`  FAIL 分支下拉(文档页): ${e.message}`)
}

// ── 6. 设置弹窗(通用设置 tab)───────────────────────────────────────────────
try {
  const gearBtn = page.locator('button[aria-label*="设置"], button[title*="设置"]').first()
  await gearBtn.click({ timeout: 8000 })
  await page.waitForTimeout(1500)
  await shot(page, path.join(D, '12-user-settings-dialog-dark.png'), '设置弹窗(文档页)')
  await shot(page, path.join(R, 'settings-general.png'), '设置弹窗(README)')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
} catch (e) {
  results.push(`  FAIL 设置弹窗: ${e.message}`)
}

// ── 7. 控制台(自定义命令 + 定时提交 + 终端会话)─────────────────────────────
if (await captureView(page, '控制台', path.join(A, '07-console.png'), '控制台(文档页)')) {
  await shot(page, path.join(R, 'console-panel.png'), '控制台(README)')
  try {
    // 终端输入框(placeholder 是「在新终端执行」)里敲条命令回车,跑出内容再拍
    const termInput = page.getByPlaceholder('在新终端执行').first()
    await termInput.click({ timeout: 8000 })
    await termInput.fill('git status --short --branch')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(9000)
    await shot(page, path.join(A, '07-console.png'), '控制台-起会话后(文档页)')
    await shot(page, path.join(R, 'console-panel.png'), '控制台-起会话后(README)')
  } catch (e) {
    results.push(`  skip 控制台起终端会话: ${e.message}`)
  }
}

// ── 8. 可视化流程编排(控制台内打开)─────────────────────────────────────────
try {
  const flowEntry = page.getByRole('button', { name: /编排|流程/ }).first()
  if (await flowEntry.count()) {
    await flowEntry.click()
    await waitSettled(page)
    await page.waitForTimeout(1500)
    await shot(page, path.join(A, '08-flow.png'), '流程编排(文档页)')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(800)
  } else {
    results.push('  FAIL 流程编排(文档页): 控制台里找不到编排入口')
  }
} catch (e) {
  results.push(`  FAIL 流程编排(文档页): ${e.message}`)
}

// ── 9. 编辑器(文件树 + Markdown 预览)───────────────────────────────────────
if (await captureView(page, '文件空间', path.join(L, '06-file-space-preview.png'), '文件空间(官网)')) {
  try {
    // 文件树里点开根目录的 README.md
    await page.locator('.tree-node', { hasText: 'README.md' }).first().click()
    await page.waitForTimeout(2500)
    // 预览切换按钮(.preview-toggle-btn,只有 title 没有 aria-label)
    const previewBtn = page.locator('button.preview-toggle-btn').first()
    if (await previewBtn.count()) await previewBtn.click()
    await page.waitForTimeout(2000)
    await shot(page, path.join(L, '06-file-space-preview.png'), '文件空间-预览(官网)')
  } catch (e) {
    results.push(`  skip 文件空间打开文件: ${e.message}`)
  }
}

// ── 10. 智能体(会话列表 + 对话)─────────────────────────────────────────────
await captureView(page, '智能体', path.join(L, '04-agent-assistant-gui.png'), '智能体 g ai(官网)')

// ── 11. 工作台看板 ─────────────────────────────────────────────────────────
if (await captureView(page, '工作台', path.join(L, '02-workbench-board.png'), '工作台看板(官网)')) {
  await shot(page, path.join(R, 'workbench-board.png'), '工作台看板(README)')
}

// ── 12. 项目管理视图 ───────────────────────────────────────────────────────
await captureView(page, '项目管理', path.join(D, '15-projects-view-dark.png'), '项目管理(文档页)')

// ── 13. 仓库浏览器(GitHub tab,gh 已登录则有真实列表)────────────────────────
if (await gotoView(page, 'Git')) {
  try {
    const ghTab = page.locator('button#git-tab-github')
    await ghTab.waitFor({ state: 'visible', timeout: 15000 })
    await ghTab.click()
    await waitSettled(page)
    // gh repo list 要 shell 出去跑一会,等卡片出现
    await page.waitForTimeout(6000)
    await shot(page, path.join(D, '16-repo-browser-dark.png'), '仓库浏览器(文档页)')
  } catch (e) {
    results.push(`  FAIL 仓库浏览器(文档页): ${e.message}`)
  }
} else {
  results.push('  skip 仓库浏览器(文档页): 切不回 Git 视图')
}

// ── 14. 系统监控(先点刷新,端口列表才拉满)───────────────────────────────────
if (await captureView(page, '系统监控', path.join(A, '11-monitor.png'), '系统监控(文档页)')) {
  try {
    const refresh = page.getByRole('button', { name: '刷新' }).first()
    if (await refresh.count()) {
      await refresh.click()
      await page.waitForTimeout(4000)
      await shot(page, path.join(A, '11-monitor.png'), '系统监控-刷新后(文档页)')
    }
  } catch { /* 刷新失败就用首帧 */ }
}

// ── 15. 思维导图(点开第一个文件,画布上有真图)───────────────────────────────
if (await captureView(page, '思维导图', path.join(L, '07-mindmap.png'), '思维导图(官网)')) {
  try {
    // 文件列表(.mm-file-item)里点一个真实的 md,画布渲染出导图再拍
    const firstFile = page.locator('.mm-file-item').first()
    if (await firstFile.count()) {
      await firstFile.click()
      await page.waitForTimeout(4500)
      await shot(page, path.join(L, '07-mindmap.png'), '思维导图-打开文件后(官网)')
    } else {
      results.push('  skip 思维导图打开文件: 列表里没有 .mm-file-item')
    }
  } catch (e) {
    results.push(`  skip 思维导图打开文件: ${e.message}`)
  }
}

await browser.close()
console.log('\n截图结果:')
console.log(results.join('\n'))
const fails = results.filter((r) => r.includes('FAIL')).length
console.log(`\n共 ${results.length - fails} 张成功, ${fails} 张失败`)
process.exit(fails > 0 ? 1 : 0)

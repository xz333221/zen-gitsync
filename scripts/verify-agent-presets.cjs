/**
 * 智能体欢迎页「预设提示词」是否跟着板块变。
 *
 * 契约（2026-10-25）：
 *   A 在「系统监控」页唤起 g ai → 显示系统状态那组（端口 / 内存 / CPU），
 *     不是"查看项目结构"这种通用开发问题
 *   B 切到「Git」页（dock 保持打开）→ 卡片换成 Git 那组
 *   C 两组内容不重叠（复制粘贴漏改会立刻红）
 *   D 只配了「通用」自定义 → 所有板块都用它（自定义优先级高于内置）
 *     （用 route 劫持 /api/config 造"已自定义"，不改用户真实配置）
 *   E 同时配了「通用」和某板块专属 → 那个板块用专属，别的板块仍用通用
 *     （这条是"按板块区分"的核心：专属不能被通用覆盖）
 *
 * 反向验证：--reverse 时把 A/B 的期望值对调，应当红 —— 证明断言真的在读内容。
 *
 * 前置：dev server 已启动（前端 5544）。
 * 用法：node scripts/verify-agent-presets.cjs [--reverse]
 * 退出码：0 全通过，1 有失败项。
 */
const path = require('node:path')
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const REVERSE = process.argv.includes('--reverse')
const results = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function waitUntil(fn, timeout = 8000, interval = 120) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true
    await sleep(interval)
  }
  return false
}

/** 欢迎页上那组快捷卡片的标题 */
async function presetLabels(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.acu-preset-q-label'))
      .map(el => (el.textContent || '').trim())
      .filter(Boolean)
  )
}

/** 等欢迎页的卡片落到"至少 n 张"，避免读到上一板块的残影 */
async function waitPresets(page, timeout = 10000) {
  await waitUntil(async () => (await presetLabels(page)).length > 0, timeout)
  return presetLabels(page)
}

async function openDock(page) {
  const mascot = page.locator('.agent-dock__mascot')
  if (await mascot.count()) {
    await mascot.first().click()
    await sleep(700)
  }
  // 有历史会话时欢迎页不出现 —— 先点一次「新建会话」把欢迎页顶出来
  const labels = await presetLabels(page)
  if (labels.length === 0) {
    const newBtn = page.locator('button', { hasText: '新建会话' }).first()
    if (await newBtn.count()) {
      await newBtn.click().catch(() => {})
      await sleep(600)
    }
  }
}

;(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })

    // ── A 系统监控板块 ────────────────────────────────────────────
    await page.locator('.activity-btn[aria-label^="系统监控"]').first().click()
    await sleep(1200)
    await openDock(page)
    const monitor = await waitPresets(page)
    const expectMonitor = REVERSE ? '解释这次改动' : '这些端口是谁在占'
    check('A 系统监控页 → 系统状态那组预设', monitor.includes(expectMonitor),
      `实测 ${monitor.length} 条：${monitor.join(' / ')}`)

    // ── B 切到 Git 板块（dock 不关）───────────────────────────────
    await page.evaluate(() => {
      // Git 按钮没有稳定文案（aria-label 会带未提交数），按位置取第一个活动栏按钮
      const btn = document.querySelectorAll('.activity-bar .activity-btn')[0]
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await sleep(1200)
    const git = await waitPresets(page)
    const expectGit = REVERSE ? '这些端口是谁在占' : '解释这次改动'
    check('B 切到 Git 板块 → 换成 Git 那组预设', git.includes(expectGit),
      `实测 ${git.length} 条：${git.join(' / ')}`)

    // ── C 两组不重叠 ─────────────────────────────────────────────
    const overlap = monitor.filter(x => git.includes(x))
    check('C 两个板块的预设不是同一套（无重合）', overlap.length === 0,
      overlap.length ? `重合：${overlap.join(' / ')}` : `${monitor.length} vs ${git.length}`)

    // ── D 自定义优先于板块预设 ───────────────────────────────────
    // 劫持配置接口，造一份"用户已自定义"，不碰本机真实 config.json
    await ctx.route('**/api/config/getConfig', async (route) => {
      const res = await route.fetch()
      const json = await res.json().catch(() => ({}))
      json.agentPresetPrompts = [{ id: 'u1', label: '我的自定义', prompt: '跑一遍冒烟测试' }]
      await route.fulfill({ response: res, json })
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await page.locator('.activity-btn[aria-label^="系统监控"]').first().click()
    await sleep(1200)
    await openDock(page)
    const custom = await waitPresets(page)
    check('D 只配了通用自定义 → 没单独配置的板块都用它', custom.length === 1 && custom[0] === '我的自定义',
      `实测 ${custom.length} 条：${custom.join(' / ')}`)

    // ── E 板块专属 > 通用自定义 ─────────────────────────────────
    // 同一份劫持里再加一份「系统监控」专属：该板块必须换成它，Git 板块仍用通用那套
    await ctx.unroute('**/api/config/getConfig')
    await ctx.route('**/api/config/getConfig', async (route) => {
      const res = await route.fetch()
      const json = await res.json().catch(() => ({}))
      json.agentPresetPrompts = [{ id: 'u1', label: '我的自定义', prompt: '跑一遍冒烟测试' }]
      json.agentPresetPromptsByView = { monitor: [{ id: 'um1', label: '监控专用', prompt: '看谁在吃内存' }] }
      await route.fulfill({ response: res, json })
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await page.locator('.activity-btn[aria-label^="系统监控"]').first().click()
    await sleep(1200)
    await openDock(page)
    const monitorScoped = await waitPresets(page)
    check('E1 板块专属优先于通用自定义', monitorScoped.length === 1 && monitorScoped[0] === '监控专用',
      `实测 ${monitorScoped.length} 条：${monitorScoped.join(' / ')}`)

    await page.evaluate(() => {
      const btn = document.querySelectorAll('.activity-bar .activity-btn')[0]
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await sleep(1200)
    const gitFallback = await waitPresets(page)
    check('E2 没配专属的板块回落通用自定义', gitFallback.length === 1 && gitFallback[0] === '我的自定义',
      `实测 ${gitFallback.length} 条：${gitFallback.join(' / ')}`)
  } catch (err) {
    check('脚本异常', false, String((err && err.message) || err))
  } finally {
    const failed = results.filter(r => !r.ok)
    console.log('\n================ 汇总 ================')
    console.log(`用例 ${results.length} 个，通过 ${results.length - failed.length}，失败 ${failed.length}`)
    for (const f of failed) console.log(`  - ${f.name} ${f.extra}`)
    if (pageErrors.length) console.log('页面异常:', pageErrors.length, pageErrors.slice(0, 3))
    await browser.close()
    process.exit(failed.length ? 1 : 0)
  }
})()

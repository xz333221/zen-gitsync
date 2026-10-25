/**
 * 设置 → AI 模型配置 → 「预设提示词」按板块区分的 UI 链路。
 *
 * 为什么要有这个：优先级（本板块自定义 > 通用自定义 > 板块内置 > 通用内置）
 * 已经在 verify:agent-presets 里端到端验过了，但**设置面板**是另一条独立链路 ——
 * 作用域 chips、草稿、提交载荷的拼法都可能悄悄坏，而坏了之后界面看起来仍然"正常"
 * （只是保存下来的东西不对）。这里把提交载荷钉住。
 *
 * 验收契约（2026-10-25）：
 *   A 作用域 chips = 通用（兜底）+ 8 个板块
 *   B 默认在「通用」，列表是该套内置文案
 *   C 切到「系统监控」→ 换成该板块内置那套，提示"还没单独配置"
 *   D 只改该板块的一条 → 提交体里只有 agentPresetPromptsByView.monitor；
 *     通用那栏提交空数组（= 保持内置），别的板块不出现在体子里
 *     （没动过的作用域不能被快照成自定义，否则它不再跟随内置文案/界面语言）
 *   E 保存后重开：该板块 chip 有「已单独配置」圆点、提示换成"用的是你单独配的那套"、
 *     内容是新存的那份
 *
 * ⚠️ 保存请求被 route 拦下（fulfill），**不写用户真实 config.json**；
 *    重开时把这次的体子冒充成 /api/config/getConfig 的返回值。
 *
 * 前置：dev server 已启动（前端 5544）。
 * 用法：node scripts/verify-preset-scopes.cjs
 * 退出码：0 全通过，1 有失败项。
 */
const path = require('node:path')
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const results = []
const pageErrors = []
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
async function waitUntil(fn, timeout = 8000, interval = 120) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) { if (await fn()) return true; await sleep(interval) }
  return false
}

/** 弹窗（含入场/退场动画）可能同时存在两份 DOM，一律只点可见的那份 */
const visible = (selector) => `${selector}:visible`

/** 打开设置弹窗并切到「AI 模型配置」tab */
async function openAiTab(page) {
  await page.click('button[aria-label="用户设置"]')
  await page.waitForSelector('.el-dialog', { state: 'visible', timeout: 10000 })
  await page.click('.tab-item:has-text("AI 模型配置")')
  await page.waitForSelector(visible('.preset-scopes'), { state: 'visible', timeout: 8000 })
}

async function presetLabels(page) {
  return page.$$eval(`${visible('.preset-card')} .el-input__inner`, els => els.map(e => e.value).filter(Boolean))
}

/**
 * 等列表落到**指定条数**再读。
 *
 * 两个坑叠在这里：
 *   1. 打开弹窗时会先 await 一次 loadConfig（其他实例可能改过配置），草稿要等它回来
 *      才建出来 —— 这中间 `.preset-scopes` 已经在 DOM 里了但一条卡片都没有；
 *   2. 切作用域是同一个 v-for 换数据，第一帧仍可能读到上一套 —— 只等"有卡片"会读错。
 * 所以按条数等；超时也照常返回实读数，让断言自己报出差异。
 */
async function waitCards(page, expect, timeout = 10000) {
  await waitUntil(
    async () => (await page.locator(`${visible('.preset-card')}`).count()) === expect,
    timeout
  )
  return presetLabels(page)
}

;(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  let savedBody = null
  // 保存请求拦下来不写盘；为了验证"重开后还在"，把这次的体子冒充成服务端返回值
  let persisted = null
  await ctx.route('**/api/config/getConfig', async (route) => {
    try {
      const res = await route.fetch()
      const json = await res.json().catch(() => ({}))
      if (persisted) Object.assign(json, persisted)
      await route.fulfill({ response: res, json })
    } catch {
      // 关浏览器时还有在飞的请求 → context disposed，吞掉即可（不让它把整轮跑挂）
    }
  })
  await ctx.route('**/api/config/save-ai-settings', async (route) => {
    savedBody = JSON.parse(String(route.request().postData() || '{}'))
    persisted = {
      agentPresetPrompts: savedBody.agentPresetPrompts ?? [],
      agentPresetPromptsByView: savedBody.agentPresetPromptsByView ?? {},
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, ...savedBody }) })
  })

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await openAiTab(page)

    const scopes = await page.$$eval(visible('.preset-scope'), els => els.map(e => (e.textContent || '').trim()))
    check('A 作用域 chips = 通用 + 8 个板块', scopes.length === 9 && scopes[0].startsWith('通用'), scopes.join(' / '))

    const activeScope = await page.$eval(visible('.preset-scope.active'), e => (e.textContent || '').trim())
    const commonLabels = await waitCards(page, 5)
    check('B 默认在「通用」，列表是内置 5 条', activeScope.startsWith('通用') && commonLabels.length === 5, commonLabels.join(' / '))

    await page.click(visible('.preset-scope:has-text("系统监控")'))
    const monitorLabels = await waitCards(page, 4)
    await sleep(200)
    const monitorNote = (await page.textContent(visible('.preset-scope-note'))) || ''
    check('C 切到「系统监控」→ 该板块内置那套 + 未配置提示',
      monitorLabels.length === 4 && /端口/.test(monitorLabels[0]) && /还没单独配置/.test(monitorNote),
      `${monitorLabels.length} 条：${monitorLabels[0]} ｜ note=${monitorNote.trim().slice(0, 30)}`)

    // 改一条标题 → 保存
    // 打开弹窗时 configStore 会再刷一次配置、草稿跟着重建，列表可能瞬间是空的 ——
    // 等卡片真的在（而不是拿上一次的读数）再动手改
    await waitCards(page, 4)
    await page.locator(`${visible('.preset-card')} .el-input__inner`).first().fill('我的监控问题')
    await sleep(300)
    const saveBtn = page.locator(visible('.dialog-confirm-btn'))
    check('D0 改动后 footer 出现「保存设置」', await saveBtn.isVisible())
    await saveBtn.click()
    await sleep(1200)

    const body = savedBody || {}
    const byView = body.agentPresetPromptsByView || {}
    const monitorSaved = byView.monitor || []
    check('D1 提交体里带着该板块的自定义（只这一条被改）',
      monitorSaved.length === 4 && monitorSaved[0].label === '我的监控问题',
      `monitor=${monitorSaved.length} 条，首条=${monitorSaved[0] && monitorSaved[0].label}`)
    check('D2 没改的通用那栏提交空数组（= 保持内置）',
      Array.isArray(body.agentPresetPrompts) && body.agentPresetPrompts.length === 0,
      JSON.stringify(body.agentPresetPrompts))
    check('D3 别的板块没被顺手快照', Object.keys(byView).length === 1, Object.keys(byView).join(','))

    // 保存成功后弹窗关闭；等它真的不可见再重开（入场/退场期间会同时挂两份 DOM）
    await waitUntil(async () => !(await page.locator(visible('.el-dialog')).count()), 8000)
    await openAiTab(page)
    await page.click(visible('.preset-scope:has-text("系统监控")'))
    await sleep(400)
    const dot = await page.locator(`${visible('.preset-scope:has-text("系统监控")')} .preset-scope-dot`).count()
    const note2 = (await page.textContent(visible('.preset-scope-note'))) || ''
    const labels2 = await waitCards(page, 4)
    check('E1 配过的板块 chip 上有「已单独配置」圆点', dot === 1)
    check('E2 提示变成"用的是你单独配的那套"', /单独配的那套/.test(note2), note2.trim().slice(0, 30))
    check('E3 重开后看到刚存的内容', labels2[0] === '我的监控问题', labels2[0])
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

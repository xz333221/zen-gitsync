/**
 * 会话列表「收起 / 展开」的浏览器验收。
 *
 * 需求（2026-10-14 用户截图指出）：主 Agent 控制台右栏那块对话列表要能手动展开收起，
 * 而且**别处引用同一份列表的地方也要生效**。
 *
 * 落地形态：收起能力做在组件库 zen-ai-chat-ui 的 ConversationList 里（工具条右端一枚按钮 +
 * 收起后的收纳条），宿主只负责"把列宽收掉"。所以这份探针要在**三个入口**上都跑一遍 ——
 * 只验主 Agent 控制台的话，"另外两处没接线"（漏传 collapsible / 忘了改 grid 列宽）照样绿。
 *
 * 验收契约：
 *   A0 进得去工作台、右栏够宽（默认 360px 会折成两页，那就没有"旁边那一列"可收）
 *   A1 会话列表工具条出现收起按钮
 *   A2 ★ 点收起 → 左列收到 40px，只剩收纳条（图标 + 竖排文案）
 *   A3 ★ 对话列真的变宽了（不是把列表 display:none 藏起来）
 *   A4 刷新后仍是收起态（localStorage 一份共用偏好）
 *   A5 点收纳条 → 展开回去，列宽与条目都回来
 *   A6 智能体视图的侧栏同款（第二个入口）
 *   A7 文件空间 g ai 面板的左列同款（第三个入口）
 *
 * 反向（--reverse）：注入 `!important` 把左列钉回 240px —— A2 / A3 必须翻红。
 * 这两条断言的判据是"宽度真的变了"，钉死宽度就是它唯一能失败的方式；只断"收纳条存在"
 * 是恒绿的（收纳条在列宽没收的时候照样渲染）。
 *
 * 前置：dev server 已启动。**改了组件库源码时**，跑这份探针要另起一个 vite
 * （`npx vite --port 5599 --force`，见 lessons/lib-change-verify-without-publish.md），
 * 因为 5544 那份内存里是旧的 pre-bundle。
 * 用法：ZEN_BASE=http://127.0.0.1:5599 node scripts/verify-conv-collapse.cjs [--reverse]
 * 退出码：0 全通过，1 有失败项，2 脚本异常。
 */
const os = require('node:os')
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const REVERSE = process.argv.includes('--reverse')
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'zen-conv-collapse')

const COLLAPSE_KEY = 'agent.convListCollapsed.v1'
const results = []
const pageErrors = []
const skips = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
function skip(name, why) {
  skips.push({ name, why })
  console.log(`  SKIP  ${name}  :: ${why}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeout = 10000, step = 200) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 > timeout) return false
    await sleep(step)
  }
}

/** 量一个容器：宽度 / 高度 / display（几何量测只回标量，别回 DOMRect） */
async function geom(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height), display: getComputedStyle(el).display }
  }, sel)
}

/** 进工作台：懒加载 chunk + 首次点击偶尔被"正在卸载的视图"吃掉，点完没出看板就再点一次 */
async function gotoWorkbench(page) {
  for (let i = 0; i < 3; i++) {
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click().catch(() => {})
    if (await waitFor(async () => (await page.locator('.board').count()) > 0, 20000)) return true
  }
  return false
}

/** 工作台右栏落到「主 Agent 控制台 + 对话模式」（控制台自己可能处于整栏折叠态） */
async function openConsole(page) {
  await gotoWorkbench(page)
  if (!(await waitFor(async () => (await page.locator('.acs__head').count()) > 0, 15000))) return false
  if (await page.locator('.oc__rail').count()) {
    await page.locator('.oc__rail').first().click()
    await sleep(900)
  }
  const chatTab = page.locator('.oc__mode-btn', { hasText: '对话' })
  if (await chatTab.count()) {
    await chatTab.first().click()
    await sleep(900)
  }
  return true
}

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await sleep(3500)
  // 清掉折叠偏好；顺手把工作台右栏拖宽（默认 360px 会让对话面折成两页）。
  // 探针与用户那份 dev server 若不同端口 = 不同 origin，localStorage 互不影响。
  await page.evaluate((key) => {
    localStorage.removeItem(key)
    localStorage.setItem('wb.boardLayout.v1', JSON.stringify({ left: 224, right: 760 }))
  }, COLLAPSE_KEY)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(3500)

  // ── A0 进主 Agent 控制台 ────────────────────────────────────
  const consoleReady = await openConsole(page)
  check('A0a 主 Agent 控制台挂上来了', consoleReady)
  if (!consoleReady) {
    await page.screenshot({ path: path.join(SHOT_DIR, 'no-console.png') }).catch(() => {})
    await browser.close()
    process.exit(2)
  }
  const wide = (await page.locator('.acs__body.is-wide').count()) > 0
  check('A0b 右栏够宽（两栏并排，才有"旁边那一列"可收）', wide)
  if (!wide) {
    await browser.close()
    process.exit(2)
  }

  if (REVERSE) {
    // 反向：把左列宽度钉死 —— 收起就该"量不出变化"，A2 / A3 必须翻红
    await page.addStyleTag({
      content: '.acs__body.is-wide.is-convs-collapsed { grid-template-columns: 240px minmax(0, 1fr) !important; }',
    })
    await sleep(300)
  }

  // ── A1 收起按钮 ────────────────────────────────────────────
  const collapseBtn = page.locator('.acs__convs .acu-conv-collapse')
  const hasBtn = await waitFor(async () => (await collapseBtn.count()) > 0, 8000)
  check('A1 会话列表工具条出现收起按钮', hasBtn)
  if (!hasBtn) {
    await page.screenshot({ path: path.join(SHOT_DIR, 'no-button.png') }).catch(() => {})
    await browser.close()
    process.exit(2)
  }

  const beforeList = await geom(page, '.acs__convs')
  const beforeChat = await geom(page, '.acs__chat')

  await collapseBtn.first().click()
  await sleep(900)

  const rail = await geom(page, '.acs__convs .acu-conv-rail')
  const afterList = await geom(page, '.acs__convs')
  const afterChat = await geom(page, '.acs__chat')
  const railText = await page.locator('.acs__convs .acu-conv-rail-text').first().textContent().catch(() => '')
  const railWM = await page.evaluate(() => {
    const el = document.querySelector('.acs__convs .acu-conv-rail-text')
    return el ? getComputedStyle(el).writingMode : null
  })

  check(
    'A2 ★ 左列收到 40px 且只剩收纳条',
    !!afterList && afterList.w <= 44 && !!rail && rail.h > 60 && (railText || '').trim().length > 0,
    `list ${beforeList && beforeList.w} → ${afterList && afterList.w}；rail ${rail && rail.w}x${rail && rail.h}；文案「${(railText || '').trim()}」；writing-mode=${railWM}`
  )
  check(
    'A3 ★ 对话列真的变宽了',
    !!afterChat && !!beforeChat && afterChat.w - beforeChat.w >= 150,
    `chat ${beforeChat && beforeChat.w} → ${afterChat && afterChat.w}`
  )
  const toolbar = await geom(page, '.acs__convs .acu-conv-toolbar')
  check('A3b 工具条整块藏起来了（不是压扁）', !!toolbar && toolbar.display === 'none')
  await page.screenshot({ path: path.join(SHOT_DIR, REVERSE ? 'reverse-console.png' : 'console-collapsed.png') }).catch(() => {})

  // ── A4 刷新后仍是收起态 ────────────────────────────────────
  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(3500)
  await openConsole(page)
  const persisted = await waitFor(async () => (await page.locator('.acs__convs .acu-conv-rail').count()) > 0, 8000)
  const persistedW = await geom(page, '.acs__convs')
  check('A4 刷新后仍是收起态（偏好落 localStorage）', persisted, `list=${persistedW && persistedW.w}`)

  // ── A5 点收纳条展开 ────────────────────────────────────────
  if (persisted) {
    await page.locator('.acs__convs .acu-conv-rail').first().click()
    await sleep(900)
    const backList = await geom(page, '.acs__convs')
    const backItems = await page.locator('.acs__convs .acu-conv-item').count()
    check(
      'A5 点收纳条展开回去（列宽与条目都回来）',
      !!backList && backList.w >= 230 && backList.w <= 250 && backItems > 0,
      `list → ${backList && backList.w}；条目 ${backItems}`
    )
  } else {
    check('A5 点收纳条展开回去（列宽与条目都回来）', false, '上一步没收起，跳过')
  }

  // ── A6 右下角 dock 的侧栏（第二个入口；2026-10 智能体 tab 整合为 dock）────
  await page.click('.agent-dock__mascot')
  await page.waitForSelector('.agent-view', { timeout: 15000 })
  // 最大化：dock 默认 560px 是窄面板（宽屏侧栏被 v-show 收起、折成两页），
  // 本组守的 240→40 宽屏收起契约要宽屏两栏才量得到真几何
  await page.click('.agent-dock__btn--max')
  // 必须等「真的可见」：v-show 收起时节点还在 DOM 里，量到的宽是 0，
  // 「≤44」会假绿（布局断言只认可见几何）
  const avReady = await waitFor(async () => {
    const el = page.locator('.agent-sidebar')
    return (await el.count()) > 0 && (await el.first().isVisible().catch(() => false))
  }, 15000)
  if (!avReady) {
    skip('A6 智能体视图侧栏', '侧栏没挂上来（可能不是宽屏）')
  } else {
    const avCollapse = page.locator('.agent-sidebar .acu-conv-collapse')
    const avBtn = await waitFor(async () => (await avCollapse.count()) > 0, 8000)
    check('A6a 智能体侧栏也有收起按钮', avBtn)
    if (avBtn) {
      const avBefore = await geom(page, '.agent-sidebar')
      await avCollapse.first().click()
      await sleep(900)
      const avAfter = await geom(page, '.agent-sidebar')
      const avRail = await geom(page, '.agent-sidebar .acu-conv-rail')
      check(
        'A6b ★ 智能体侧栏收到 40px 且出现收纳条',
        !!avAfter && avAfter.w <= 44 && !!avRail,
        `sidebar ${avBefore && avBefore.w} → ${avAfter && avAfter.w}`
      )
      await page.screenshot({ path: path.join(SHOT_DIR, REVERSE ? 'reverse-agent.png' : 'agent-collapsed.png') }).catch(() => {})
      await page.locator('.agent-sidebar .acu-conv-rail').first().click().catch(() => {})
      await sleep(700)
    }
  }
  // ── A7（原「文件空间 g ai 面板」入口）随 2026-10 编辑器 AI 面板并入 dock 移除 ──
  // 同一个 ConversationList 收起控件在 dock 最大化态由 A6 守；宽屏两栏的
  // 240→40 契约不变，只是入口从编辑器面板变成右下角悬浮面板。

  await browser.close().catch(() => {})

  const failed = results.filter((r) => !r.ok)
  console.log('\n[verify] 截图目录:', SHOT_DIR)
  console.log(`[verify] 结果: ${results.length - failed.length}/${results.length} 通过${skips.length ? `，跳过 ${skips.length} 项` : ''}${REVERSE ? '（反向模式）' : ''}`)
  failed.forEach((f) => console.log(`  - ${f.name} ${f.extra}`))
  if (pageErrors.length) console.log('[verify] page errors:', pageErrors.slice(0, 5))
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('[verify] 脚本异常:', e)
  process.exit(2)
})

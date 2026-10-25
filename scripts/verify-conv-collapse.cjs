/**
 * 会话列表「收起 / 展开」的浏览器验收。
 *
 * 需求（2026-10-14 用户截图指出）：对话列表要能手动展开收起，而且**别处引用同一份
 * 列表的地方也要生效**。
 *
 * 落地形态：收起能力做在组件库 zen-ai-chat-ui 的 ConversationList 里（工具条右端一枚按钮 +
 * 收起后的收纳条），宿主只负责"把列宽收掉"。
 *
 * 入口演变：原来要验三处（主 Agent 控制台的对话面 / 智能体视图 / 文件空间面板）。
 * 2026-10 整合后前两处并进右下角 dock、第三处随编辑器 AI 面板下线 —— 现在只剩
 * **dock 最大化后的宽屏侧栏**这一处入口，本探针就守它（同一份组件、同一份偏好）。
 *
 * 验收契约：
 *   A0 dock 最大化后侧栏可见（默认 560px 是窄面板，没有"旁边那一列"可收）
 *   A1 会话侧栏出现收起按钮
 *   A2 ★ 点收起 → 侧栏收到 40px，只剩收纳条（图标 + 竖排文案）
 *   A3 ★ 对话列真的变宽了（不是把列表 display:none 藏起来）
 *   A4 刷新后仍是收起态（localStorage 一份共用偏好）
 *   A5 点收纳条 → 展开回去，列宽与条目都回来
 *
 * 反向（--reverse）：注入 `!important` 把侧栏钉回 240px —— A2 / A3 必须翻红。
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

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await sleep(3500)
  // 清掉折叠偏好（探针与用户那份 dev server 若不同端口 = 不同 origin，互不影响）
  await page.evaluate((key) => localStorage.removeItem(key), COLLAPSE_KEY)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(3500)

  /** 打开 dock 并最大化：宽屏两栏才量得到"旁边那一列"的收起几何。
   *  mascot 是 toggle，先确保面板是关的再点。 */
  async function openWide() {
    if (await page.locator('.agent-dock__panel').isVisible().catch(() => false)) {
      await page.locator('.agent-dock__btn--close').first().click().catch(() => {})
      await page.waitForSelector('.agent-dock__panel', { state: 'hidden', timeout: 5000 }).catch(() => {})
    }
    await page.click('.agent-dock__mascot')
    await page.waitForSelector('.agent-view', { timeout: 15000 })
    await page.click('.agent-dock__btn--max')
    // 必须等"真的可见"：v-show 收起时节点还在 DOM 里、量到的宽是 0（≤44 会假绿）
    return waitFor(async () => {
      const el = page.locator('.agent-sidebar')
      return (await el.count()) > 0 && (await el.first().isVisible().catch(() => false))
    }, 15000)
  }

  // ── A0 打开 dock 并最大化 ──────────────────────────────────
  const wide = await openWide()
  check('A0 dock 最大化后侧栏可见（宽屏两栏）', wide)
  if (!wide) {
    await page.screenshot({ path: path.join(SHOT_DIR, 'no-sidebar.png') }).catch(() => {})
    await browser.close()
    process.exit(2)
  }

  if (REVERSE) {
    // 反向：把侧栏宽度钉死 —— 收起就该"量不出变化"，A2 / A3 必须翻红
    await page.addStyleTag({ content: '.agent-sidebar { width: 240px !important; }' })
    await sleep(300)
  }

  // ── A1 收起按钮 ────────────────────────────────────────────
  const collapseBtn = page.locator('.agent-sidebar .acu-conv-collapse')
  const hasBtn = await waitFor(async () => (await collapseBtn.count()) > 0, 8000)
  check('A1 会话侧栏出现收起按钮', hasBtn)
  if (!hasBtn) {
    await page.screenshot({ path: path.join(SHOT_DIR, 'no-button.png') }).catch(() => {})
    await browser.close()
    process.exit(2)
  }

  const beforeList = await geom(page, '.agent-sidebar')
  const beforeChat = await geom(page, '.agent-chat-host')

  await collapseBtn.first().click()
  await sleep(900)

  const rail = await geom(page, '.agent-sidebar .acu-conv-rail')
  const afterList = await geom(page, '.agent-sidebar')
  const afterChat = await geom(page, '.agent-chat-host')
  const railText = await page.locator('.agent-sidebar .acu-conv-rail-text').first().textContent().catch(() => '')

  check(
    'A2 ★ 侧栏收到 40px 且只剩收纳条',
    !!afterList && afterList.w <= 44 && !!rail && rail.h > 60 && (railText || '').trim().length > 0,
    `sidebar ${beforeList && beforeList.w} → ${afterList && afterList.w}；rail ${rail && rail.w}x${rail && rail.h}；文案「${(railText || '').trim()}」`
  )
  check(
    'A3 ★ 对话列真的变宽了',
    !!afterChat && !!beforeChat && afterChat.w - beforeChat.w >= 150,
    `chat ${beforeChat && beforeChat.w} → ${afterChat && afterChat.w}`
  )
  await page.screenshot({ path: path.join(SHOT_DIR, REVERSE ? 'reverse-dock.png' : 'dock-collapsed.png') }).catch(() => {})

  // ── A4 刷新后仍是收起态 ────────────────────────────────────
  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(3500)
  await openWide()
  // 反向注入不会跟着 reload 走，重新打一次（否则 A5 拿钉死前的基线比、多红一条）
  if (REVERSE) { await page.addStyleTag({ content: '.agent-sidebar { width: 240px !important; }' }); await sleep(200) }
  const persisted = await waitFor(async () => (await page.locator('.agent-sidebar .acu-conv-rail').count()) > 0, 8000)
  const persistedW = await geom(page, '.agent-sidebar')
  check('A4 刷新后仍是收起态（偏好落 localStorage）', persisted, `sidebar=${persistedW && persistedW.w}`)

  // ── A5 点收纳条展开 ────────────────────────────────────────
  if (persisted) {
    await page.locator('.agent-sidebar .acu-conv-rail').first().click()
    await sleep(900)
    const backList = await geom(page, '.agent-sidebar')
    const backItems = await page.locator('.agent-sidebar .acu-conv-item').count()
    check(
      'A5 点收纳条展开回去（列宽与条目都回来）',
      !!backList && !!beforeList && Math.abs(backList.w - beforeList.w) <= 6 && backItems > 0,
      `sidebar ${beforeList && beforeList.w} → ${backList && backList.w}；条目 ${backItems}`
    )
  } else {
    check('A5 点收纳条展开回去（列宽与条目都回来）', false, '上一步没收起，跳过')
  }

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

/**
 * 设置弹窗「左侧固定 / 右侧滚动」—— 回归验证。
 *
 * 需求（用户提，配图是设置弹窗 + 左右两块红框）：设置的左侧导航要钉住不动，
 * 只有右边内容区滚动；用户在同一个任务里还强调过「不喜欢圆角加单 border 的样式」，
 * 所以左侧导航同时从「圆角描边卡片」改成了平铺导航轨（底色 + 方角）。
 *
 * 落地：GitGlobalSettingsDialog.vue —— .user-settings-content 顶满 body 高度，
 *   .settings-tabs 固定并自滚、.settings-panels 成为唯一的纵向滚动容器
 *   （body 的 flex 高度链来自 styles/common.scss 的全局 .el-dialog__body）。
 *
 * 验证项：
 *   P1 前置 设置弹窗打开 + 切到内容较长的「AI 模型配置」
 *   L1 ★ 右侧面板真的是滚动容器（scrollHeight > clientHeight）
 *   L2 ★ 右侧设 scrollTop 有响应（scrollHeight/clientHeight 都对得上，scrollTop 被接受）
 *   L3 ★ 滚动后左侧导航的屏幕坐标不变（±1px）
 *   L4 ★ 外层 .el-dialog__body 不再自己滚（否则仍是整块在滚）
 *   L5 ★ 左侧导航不是「圆角 + 1px 描边」卡片（border 0 且 radius ≤ 8）
 *   L6 全程无 console / page 错误
 *
 * --reverse：注入一段「改回旧样子」的 CSS（右侧不滚 + 导航带描边大圆角），
 *   L1 / L3 / L5 必须转红，否则这几条是空跑。
 *
 * 前置：dev server 已启动（npm run dev:ping 两个 OK，前端 5544）。
 * 用法：node scripts/verify-settings-layout.cjs [--reverse]
 * 退出码：0 全通过，1 有失败项。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'zen-settings-layout')
const REVERSE = process.argv.includes('--reverse')

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 打开设置弹窗（活动栏那颗带 aria-label 的按钮），再切到指定 tab */
async function openSettings(page, tabText) {
  const clicked = await page.evaluate(() => {
    const re = /用户设置|user settings/i
    const btn = [...document.querySelectorAll('button[aria-label]')]
      .find(b => re.test(b.getAttribute('aria-label') || ''))
    if (!btn) return false
    btn.click()
    return true
  })
  if (!clicked) return false
  await page.waitForSelector('.user-settings-dialog .settings-tabs', { timeout: 10000 }).catch(() => {})
  // loading 遮罩会吃掉点击，等它退场
  await page.locator('.user-settings-dialog .el-loading-mask').waitFor({ state: 'detached', timeout: 8000 }).catch(() => {})
  await sleep(400)
  if (tabText) {
    await page.evaluate((t) => {
      const tab = [...document.querySelectorAll('.user-settings-dialog .tab-item')]
        .find(e => (e.textContent || '').includes(t))
      tab?.click()
    }, tabText)
    await sleep(500)
  }
  return true
}

/** 量一次几何：右侧面板的滚动状态 + 左侧导航的位置/边框 */
function readLayout(page) {
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s)
    const body = q('.user-settings-dialog .el-dialog__body')
    const tabs = q('.user-settings-dialog .settings-tabs')
    const panels = q('.user-settings-dialog .settings-panels')
    if (!body || !tabs || !panels) return null
    const cs = getComputedStyle(tabs)
    return {
      body: { scrollH: body.scrollHeight, clientH: body.clientHeight, overflow: getComputedStyle(body).overflowY },
      panels: {
        scrollH: panels.scrollHeight,
        clientH: panels.clientHeight,
        scrollTop: panels.scrollTop,
        overflow: getComputedStyle(panels).overflowY,
        scrollable: panels.scrollHeight > panels.clientHeight + 4,
      },
      tabs: {
        y: Math.round(tabs.getBoundingClientRect().y),
        borderTop: parseFloat(cs.borderTopWidth) || 0,
        borderLeft: parseFloat(cs.borderLeftWidth) || 0,
        radius: parseFloat(cs.borderTopLeftRadius) || 0,
      },
    }
  })
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 30000 })
    await page.locator('.loading-container').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
    await sleep(1200)

    // ── P1 前置 ──────────────────────────────────────────────────────
    const opened = await openSettings(page, 'AI 模型')
    check('P1 前置 设置弹窗打开并切到「AI 模型配置」', opened)
    if (!opened) throw new Error('设置对话框打不开，后续无法验证')

    if (REVERSE) {
      await page.addStyleTag({
        content: `
          .user-settings-dialog .settings-panels { overflow-y: visible !important; }
          .user-settings-dialog .settings-tabs { border: 1px solid #888 !important; border-radius: 12px !important; }
        `,
      })
      await sleep(300)
    }

    const before = await readLayout(page)
    // 注意：光看 scrollHeight > clientHeight 抓不到「overflow:visible 时内容溢出」的旧样子
    // （overflow visible 的 scrollHeight 照样算溢出内容），必须一起判 overflow-y
    check('L1 ★ 右侧面板是滚动容器（overflow-y:auto + 内容更高）', !!before
      && before.panels.scrollable
      && /auto|scroll/.test(before.panels.overflow),
      before ? `overflow-y=${before.panels.overflow} scrollH=${before.panels.scrollH} clientH=${before.panels.clientH}` : '取不到面板')

    // ── L2 真的能滚（scrollTop 被接受） ──────────────────────────────
    const scrolled = await page.evaluate(() => {
      const panels = document.querySelector('.user-settings-dialog .settings-panels')
      const target = Math.min(320, panels.scrollHeight - panels.clientHeight)
      panels.scrollTop = target
      return { asked: target, got: panels.scrollTop }
    })
    await sleep(300)
    check('L2 ★ 右侧面板设 scrollTop 有响应', scrolled.got >= scrolled.asked - 2 && scrolled.got > 0,
      `asked=${scrolled.asked} got=${Math.round(scrolled.got)}`)

    // ── L3 左侧钉住：滚动后导航坐标不变 ──────────────────────────────
    const after = await readLayout(page)
    const delta = after ? Math.abs(after.tabs.y - before.tabs.y) : 999
    // 没滚起来时 Δy 必然为 0（那一条就是空跑），所以把「滚起来了」写进同一条断言
    check('L3 ★ 右侧滚起来后左侧导航位置不变', !!after && after.panels.scrollTop > 0 && delta <= 1,
      `scrollTop=${after ? Math.round(after.panels.scrollTop) : '?'} y ${before.tabs.y} → ${after ? after.tabs.y : '?'}`)

    // ── L4 外层 body 不再自己滚 ─────────────────────────────────────
    check('L4 ★ 弹窗 body 不再是滚动容器', after.body.scrollH <= after.body.clientH + 2,
      `body scrollH=${after.body.scrollH} clientH=${after.body.clientH} overflow=${after.body.overflow}`)

    // ── L5 导航栏不是「圆角 + 描边」卡片 ────────────────────────────
    check('L5 ★ 左侧导航没有描边 / 大圆角', after.tabs.borderTop === 0 && after.tabs.borderLeft === 0 && after.tabs.radius <= 8,
      `border=${after.tabs.borderTop}/${after.tabs.borderLeft} radius=${after.tabs.radius}`)

    await page.locator('.user-settings-dialog').screenshot({ path: path.join(SHOT_DIR, REVERSE ? 'reverse.png' : 'layout.png') }).catch(() => {})

    // ── L6 无错误 ────────────────────────────────────────────────────
    // LLM 配额 / 网络类环境噪音不算（与本布局无关）
    const noisy = /quota|rate limit|net::ERR|Failed to load resource|502|504/i
    const bad = [...consoleErrors, ...pageErrors].filter(t => !noisy.test(t))
    check('L6 无 console / page 错误', bad.length === 0, bad.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过${REVERSE ? '（reverse：期望至少 3 条红）' : ''}`)
  if (REVERSE) {
    if (failed.length < 3) {
      console.log('  ! reverse 只红了 ' + failed.length + ' 条 —— L1/L3/L5 里有断言在空跑')
      process.exit(1)
    }
    log('reverse 符合预期：' + failed.map(f => f.name.split(' ')[0]).join(', '))
    process.exit(0)
  }
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[verify] 脚本异常:', err)
  process.exit(1)
})

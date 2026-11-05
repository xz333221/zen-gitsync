/**
 * 文件空间 tab 栏：右端「预览 / 思维导图」按钮必须永远在可视区内。
 *
 * 症状（用户报 2026-11-05）：打开文件的 tab 多到把 tab 条撑满后，「预览」按钮就不见了。
 *
 * 机理：以前 tab 和按钮在**同一个** overflow-x:auto 容器里，且都 flex-shrink:0
 * → tab 一多就把按钮推到滚动区右侧、滚出可视范围；滚动条又被 `scrollbar-width:none` 藏掉，
 * 用户既看不到按钮也意识不到能横向滚。
 *
 *   P1 夹具成立：tab 条真的溢出了（scrollWidth > clientWidth），否则后面测的是假象
 *   P2 ★ 溢出状态下「预览」按钮仍在 tab 栏可视区内（右侧没被推出、也没被压成 0 宽）
 *   P3 按钮不在滚动容器里（结构性反证：放回去就必被推走，见 P6）
 *   P4 点这个按钮真的能打开预览面板（不是只渲染了个死按钮）
 *   P5 新开的文件（当前 tab）被滚进可视区（滚动条隐藏，看不见的 tab 等于没开）
 *   P6 反向验证：把按钮节点塞回滚动容器 → P2 的判据必须翻红
 *
 * 前置：dev server 已启动（前端 5544 + 后端在 .port 上）。
 * 用法：node scripts/verify-editor-tabs-actions.cjs
 * 退出码：0 全通过，1 有失败项。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(__dirname, '../tmp')
const SHOT = path.join(SHOT_DIR, 'editor-tabs-actions.png')
const OPEN_TABS = Number(process.env.ZEN_OPEN_TABS || 12)
// 打开 tab 会写进 ui.editorWorkspaceByProject（用户共享状态）→ 跑前备份、跑完原样写回
const CONFIG_FILE = process.env.ZEN_CONFIG_FILE || path.join(os.homedir(), '.zen-gitsync', 'config.json')

const results = []
const pageErrors = []
const consoleErrors = []
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}

async function waitFor(fn, timeout = 15000, step = 150) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 > timeout) return false
    await sleep(step)
  }
}

/** tab 栏 / 按钮 / 当前 tab 的几何快照 */
async function readTabs(page) {
  return page.evaluate(() => {
    const box = document.querySelector('.editor-tabs')
    const scroller = document.querySelector('.editor-tabs-scroll')
    const actions = document.querySelector('.editor-tabs-actions')
    const btn = document.querySelector('.editor-tabs-actions .preview-toggle-btn')
    const active = document.querySelector('.editor-tabs-scroll .editor-tab.active')
    const r = (el) => (el ? el.getBoundingClientRect() : null)
    const pack = (el) => {
      const b = r(el)
      return b ? { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width) } : null
    }
    return {
      box: pack(box),
      scroller: pack(scroller),
      actions: pack(actions),
      btn: pack(btn),
      btnVisible: !!btn && !!r(btn) && r(btn).width > 0 && getComputedStyle(btn).visibility !== 'hidden',
      btnInsideScroller: !!btn && !!btn.closest('.editor-tabs-scroll'),
      overflow: scroller ? scroller.scrollWidth - scroller.clientWidth : -1,
      tabCount: document.querySelectorAll('.editor-tabs-scroll .editor-tab').length,
      activeTab: pack(active),
      activeTitle: active ? active.getAttribute('title') : null,
      innerWidth: window.innerWidth,
    }
  })
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  // 窄一点的窗口 = 更容易撑满（用户截图里的场景就是窗口不宽 + tab 多）
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  let configBackup = null
  try {
    try { configBackup = fs.readFileSync(CONFIG_FILE, 'utf8') } catch { configBackup = null }
    console.log('[verify] 截图:', SHOT)
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 30000 })
    await page.locator('.loading-container').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})

    await page.locator('.activity-btn[aria-label^="文件空间"], .activity-btn[aria-label^="编辑器"]').first().click()
    const treeReady = await waitFor(async () => (await page.locator('.tree-node').count()) > 3, 20000)
    check('前置 文件树已加载', treeReady, `nodes=${await page.locator('.tree-node').count()}`)
    if (!treeReady) throw new Error('文件树没出来')

    // 先把恢复出来的 tab 全关掉，夹具才稳定（tab 状态是按项目存在 config.json 里的）
    for (let i = 0; i < 40 && (await page.locator('.editor-tab').count()) > 0; i++) {
      await page.locator('.editor-tab .tab-close').first().click()
      await sleep(80)
    }
    await sleep(300)
    check('前置 起始没有残留 tab', (await page.locator('.editor-tab').count()) === 0)

    // 固定用仓库根目录的文件撑 tab 条（别用「最近修改的文件」——
    // 那份列表随构建产物/临时文件漂移，可能一条 md 都没有）
    // 顺序末尾留一个 md：按钮只在「当前文件可预览」时渲染，落在非 md 上会让断言假红
    const candidates = ['源码笔记.md', 'AGENTS.md', 'CLAUDE.md', 'index.js',
      'package.json', 'package-lock.json', 'nodemon.json', 'server.js', 'LICENSE', 'README.md']
    let openedCount = 0
    for (const name of candidates) {
      if (openedCount >= OPEN_TABS) break
      const ok = await page.evaluate((n) => {
        const el = [...document.querySelectorAll('.tree-name')].find(e => (e.textContent || '').trim() === n)
        const node = el && el.closest('.tree-node')
        if (!node) return false
        node.click()
        return true
      }, name)
      if (ok) {
        openedCount++
        await sleep(150)
      }
    }
    check('前置 能开够 tab（根目录文件）', openedCount >= 8, `opened=${openedCount}`)
    if (openedCount < 8) throw new Error('开不到 8 个 tab')
    await sleep(800)

    const t0 = await readTabs(page)
    check('P1 夹具成立：tab 条已溢出（scrollWidth>clientWidth）',
      t0.overflow > 8, `tabs=${t0.tabCount} overflow=${t0.overflow}px scroller=${t0.scroller?.width}px`)
    if (t0.overflow <= 8) throw new Error('tab 没撑满，后续断言测不到这个 bug')

    // ── P2 ★ 核心断言：按钮仍在 tab 栏可视区内 ──────────────────────────
    check('P2 ★ 溢出的 tab 条下「预览」按钮仍可见（在 tab 栏范围内）',
      !!t0.btn && t0.btnVisible && t0.btn.right <= t0.box.right + 1 && t0.btn.left >= t0.box.left - 1,
      `btn=${t0.btn ? `${t0.btn.left}..${t0.btn.right}` : 'null'} box=${t0.box.left}..${t0.box.right} visible=${t0.btnVisible}`)

    // ── P3 结构性反证 ───────────────────────────────────────────────────
    check('P3 按钮不在滚动容器里（closest .editor-tabs-scroll === null）',
      !t0.btnInsideScroller, `insideScroller=${t0.btnInsideScroller}`)

    // ── P4 按钮真的能用 ─────────────────────────────────────────────────
    await page.locator('.editor-tabs-actions .preview-toggle-btn').first().click()
    const previewOpen = await waitFor(async () => (await page.locator('.preview-markdown, .preview-panel').count()) > 0, 8000)
    check('P4 点按钮能打开预览面板', previewOpen)
    await page.screenshot({ path: SHOT }).catch(() => {})

    // ── P5 当前 tab 在可视区里 ──────────────────────────────────────────
    await page.locator('.editor-tabs-actions .preview-toggle-btn').first().click()
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('.tree-name')].find(e => (e.textContent || '').trim() === 'CLAUDE.md')
      el?.closest('.tree-node')?.click()
    })
    await sleep(500)
    const t1 = await readTabs(page)
    check('P5 当前 tab 被滚进可视区',
      !!t1.activeTab && t1.activeTab.left >= t1.scroller.left - 1 && t1.activeTab.right <= t1.scroller.right + 1,
      `active=${t1.activeTab ? `${t1.activeTab.left}..${t1.activeTab.right}` : 'null'} scroller=${t1.scroller.left}..${t1.scroller.right}`)

    // ── P6 反向验证：把按钮塞回滚动容器，P2 的判据必须翻红 ───────────────
    const reverted = await page.evaluate(() => {
      const scroller = document.querySelector('.editor-tabs-scroll')
      const actions = document.querySelector('.editor-tabs-actions')
      if (!scroller || !actions) return false
      scroller.appendChild(actions)
      scroller.scrollLeft = 0
      return true
    })
    const t2 = reverted ? await readTabs(page) : null
    const p2WouldFail = !!t2 && !(t2.btn && t2.btnVisible && t2.btn.right <= t2.box.right + 1 && t2.btn.left >= t2.box.left - 1)
    check('P6 反向验证：按钮塞回滚动容器后 P2 判据翻红', reverted && p2WouldFail,
      reverted ? `btn=${t2?.btn ? `${t2.btn.left}..${t2.btn.right}` : 'null'} box=${t2?.box.left}..${t2?.box.right}` : '注入失败')
  } finally {
    // tab 快照是防抖写盘的：先等它落定再关浏览器，最后把 config.json 原样写回
    await sleep(800)
    await browser.close().catch(() => {})
    if (configBackup != null) {
      try { fs.writeFileSync(CONFIG_FILE, configBackup) } catch { /* 配置写不回不影响结论 */ }
    }
  }

  const failed = results.filter(r => !r.ok)
  const noisy = consoleErrors.filter(e => !/favicon|ResizeObserver|DevTools|Canceled/i.test(e))
  console.log(`\n[verify] 结果: ${results.length - failed.length}/${results.length} 通过`)
  if (noisy.length) console.log('[verify] console errors:', noisy.slice(0, 5))
  if (pageErrors.length) console.log('[verify] page errors:', pageErrors.slice(0, 5))
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('[verify] 脚本异常:', e)
  process.exit(1)
})

/**
 * 文件空间「最近修改的文件」回归验证。
 *
 * 需求（用户提）：文件空间左栏底部要有一栏「最近修改的文件」，方便看同步盘里
 * **别的电脑**刚改过哪些笔记；按磁盘 mtime，不是"这个应用打开过哪些文件"；
 * 这块要能折叠。
 *
 * 验证项：
 *   B1 服务端按 mtime 倒序，且刚创建的文件排第一
 *   B2 limit 生效
 *   B3 越界路径（工作目录之外）被 403 拒绝
 *   P1 左栏出现「最近修改」面板（含标题行）
 *   P2 ★ 列表第一行 = 刚创建的文件（mtime 最新）
 *   P3 ★ 点一行 → 编辑器打开该文件
 *   P4 ★ 折叠：列表隐藏、面板高度回落到标题行（不是"看着没了但还占位"）
 *   P5 ★ 展开：列表回来且仍有内容
 *   P6 ★ 手动刷新绕过后端缓存：列表出现加载后再新建的文件
 *   P7 位置：面板贴在侧栏底部、在文件树下方，宽度与侧栏一致
 *   P8 全程无错误 toast
 *
 * 前置：dev 环境已启动，且 **backend 是包含本功能的代码**（改完 fs.js 要重启后端；
 *       vite 会自己 HMR）。backend 端口从仓库根的 .port 读。
 * 用法：node scripts/verify-editor-recent-files.cjs [--reverse]
 *   --reverse 注入 CSS 把面板藏掉，P1/P2 的期望反过来 —— 证明断言不是在空跑。
 * 退出码：0 全通过，1 有失败项。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const ROOT = path.resolve(__dirname, '..')
const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const REVERSE = process.argv.includes('--reverse')
const PORT_FILE = path.join(ROOT, '.port')
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(ROOT, 'tmp', 'verify-editor-recent-files')

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeout = 10000, step = 150) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 > timeout) return false
    await sleep(step)
  }
}

function readApiPort() {
  const fromFile = (() => {
    try { return Number(fs.readFileSync(PORT_FILE, 'utf8').trim()) } catch { return 0 }
  })()
  return fromFile || Number(process.env.ZEN_API_PORT || 5545)
}

/** 进文件空间 + 等文件树出来 */
async function openEditorView(page) {
  await page.locator('.activity-btn[aria-label^="文件空间"], .activity-btn[aria-label^="编辑器"]').first().click()
  return waitFor(async () => (await page.locator('.tree-node').count()) > 3, 20000)
}

async function bootApp(page) {
  await page.waitForSelector('.activity-bar', { timeout: 30000 })
  await page.locator('.loading-container').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
  await sleep(1200)
}

function makeProbeFile(name) {
  const full = path.join(ROOT, 'tmp', name)
  fs.writeFileSync(full, `# ${name}\n\n最近修改探针生成的临时文件。\n`, 'utf8')
  const now = new Date()
  fs.utimesSync(full, now, now)
  return full
}

/**
 * 探针点开过的探针文件会被写进工作区快照（ui.editorWorkspaceByProject）。
 * 文件删掉后，下次打开文件空间就会去读一个不存在的路径（500）。
 * 这里只**剔除探针文件**，不整份还原配置 —— 共享工作区里别的会话可能同时改了配置。
 */
function scrubWorkspaceSnapshot(names) {
  if (!names.length) return
  const configFile = path.join(os.homedir(), '.zen-gitsync', 'config.json')
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    const byProject = cfg?.ui?.editorWorkspaceByProject
    if (!byProject || typeof byProject !== 'object') return
    const hit = (p) => typeof p === 'string' && names.some((n) => p.includes(n))
    let changed = false
    for (const snapshot of Object.values(byProject)) {
      if (!snapshot || typeof snapshot !== 'object') continue
      if (Array.isArray(snapshot.tabs)) {
        const next = snapshot.tabs.filter((p) => !hit(p))
        if (next.length !== snapshot.tabs.length) { snapshot.tabs = next; changed = true }
      }
      if (hit(snapshot.activeTab)) { snapshot.activeTab = null; changed = true }
    }
    if (changed) fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2))
  } catch {
    // 配置读不到/写不进不影响探针结论
  }
}

async function readPanel(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.recent-files')
    const sidebar = document.querySelector('.editor-sidebar')
    const tree = document.querySelector('.sidebar-tree')
    if (!panel || !sidebar) return null
    const pr = panel.getBoundingClientRect()
    const sr = sidebar.getBoundingClientRect()
    const tr = tree ? tree.getBoundingClientRect() : null
    return {
      panelTop: pr.top,
      panelBottom: pr.bottom,
      panelWidth: Math.round(pr.width),
      panelHeight: Math.round(pr.height),
      sidebarBottom: sr.bottom,
      sidebarWidth: Math.round(sr.width),
      treeBottom: tr ? tr.bottom : null,
    }
  })
}

async function main() {
  const apiPort = readApiPort()
  const apiBase = `http://127.0.0.1:${apiPort}`
  log(`backend ${apiBase} / vite ${BASE}`)

  const stamp = Date.now()
  const firstName = `zz-recent-probe-${stamp}.md`
  const secondName = `zz-recent-probe-b-${stamp}.md`
  const probeFiles = []
  let browser = null

  try {
    // 先造文件（tmp/ 是 gitignored 的临时目录），首屏加载时它必须排第一
    probeFiles.push(makeProbeFile(firstName))

    // ── B1/B2/B3 服务端契约（refresh=1 顺手把这轮扫描结果灌进缓存）────────
    const listResp = await fetch(`${apiBase}/api/recent_files?path=${encodeURIComponent(ROOT)}&limit=5&refresh=1`)
    const listData = await listResp.json().catch(() => null)
    if (!listData?.success) {
      throw new Error(
        `backend 没有 /api/recent_files（${listResp.status}）—— 改完 fs.js 需要重启 backend；` +
        `当前 .port=${apiPort}`
      )
    }
    const items = Array.isArray(listData.items) ? listData.items : []
    const sorted = items.every((it, i) => i === 0 || items[i - 1].mtimeMs >= it.mtimeMs)
    check('B1a 接口返回 success 且有内容', items.length > 0, `items=${items.length}`)
    check('B1b ★ 按 mtime 倒序，且新建文件排第一', sorted && items[0]?.name === firstName,
      `first=${items[0]?.name}`)
    check('B2 limit 生效', items.length <= 5, `items=${items.length}`)
    const outside = await fetch(`${apiBase}/api/recent_files?path=${encodeURIComponent(path.dirname(ROOT))}`)
    check('B3 工作目录之外的路径被拒绝（403）', outside.status === 403, `status=${outside.status}`)

    // ── 页面（不拦截任何请求：走真实 backend 链路）──────────────────────
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
    page.on('pageerror', (e) => pageErrors.push(String(e)))

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await bootApp(page)
    let treeReady = await openEditorView(page)
    if (!treeReady) {
      // dev server 冷启动 / 依赖重打包时第一次打开会慢一拍（已知现象），重载一次再判
      log('文件树首次没出来，重载一次')
      await page.reload({ waitUntil: 'domcontentloaded' })
      await bootApp(page)
      treeReady = await openEditorView(page)
    }
    check('P0 前置 文件树已加载', treeReady)
    if (!treeReady) throw new Error('文件树没出来')

    if (REVERSE) {
      // 反证：把面板整个藏掉。若 P1/P2 还能绿，说明断言没在读数
      await page.addStyleTag({ content: '.recent-files { display: none !important; }' })
    }

    const panel = page.locator('.recent-files')
    await waitFor(async () => (await panel.count()) > 0, 15000)
    const panelExists = (await panel.count()) > 0
    const panelVisible = panelExists && (await panel.isVisible())

    // ── P1 面板存在 ───────────────────────────────────────────────────
    const titleText = panelExists ? (await page.locator('.recent-files-title').first().innerText().catch(() => '')).trim() : ''
    check('P1 ★ 左栏出现「最近修改」面板（标题非空）', panelVisible === !REVERSE && !!titleText,
      `visible=${panelVisible}, title="${titleText}"`)

    // ── P2 第一行 = 最新文件 ───────────────────────────────────────────
    // 先手点一次刷新：服务端有 12s 缓存，页面首屏那次请求可能拿到"造文件之前"的榜，
    // 直接判第一行会假红（不是功能错）。
    const rows = page.locator('.recent-file')
    if (REVERSE) {
      // 反证只验"可见性"断言：行还在 DOM 里（display:none 不摘节点），不能拿行数当证据
      check('P2 反向模式跳过（可见性已由 P1 反证）', true)
    } else {
      await page.locator('.recent-files-refresh').click().catch(() => {})
      await waitFor(async () => (await rows.count()) > 0, 15000)
      const rowCount = await rows.count()
      const firstDir = rowCount > 0 ? (await rows.first().locator('.recent-file-dir').innerText().catch(() => '')).trim() : ''
      const topIsProbe = await waitFor(async () => {
        const first = (await rows.first().locator('.recent-file-name').innerText().catch(() => '')).trim()
        return first === firstName
      }, 8000)
      const shown = topIsProbe ? firstName : (await rows.first().locator('.recent-file-name').innerText().catch(() => '')).trim()
      check('P2 ★ 列表第一行 = 刚创建的文件', topIsProbe,
        `first="${shown}", rows=${rowCount}, dir="${firstDir}"`)
    }

    if (REVERSE) {
      check('P3/P4/P5/P6/P7 反向模式跳过', true)
    } else {
      // ── P3 点一行打开文件 ────────────────────────────────────────────
      const tabsBefore = await page.locator('.editor-tab').count()
      await rows.first().click()
      const opened = await waitFor(async () => {
        const names = await page.locator('.editor-tab .tab-name').allInnerTexts()
        return names.map((n) => n.trim()).includes(firstName)
      }, 10000)
      check('P3 ★ 点列表行 → 编辑器打开该文件', opened,
        `tabs ${tabsBefore} → ${await page.locator('.editor-tab').count()}`)
      // 用完就关：工作区快照会记住打开的标签，探针文件删掉后不该留一个坏标签
      if (opened) {
        await page.locator('.editor-tab', { hasText: firstName }).locator('.tab-close').click().catch(() => {})
        await sleep(1500)
      }

      // ── P4 折叠 ─────────────────────────────────────────────────────
      await page.locator('.recent-files-head').click()
      await sleep(300)
      const bodyVisible = await page.locator('.recent-files-body').isVisible()
      const collapsedGeom = await readPanel(page)
      check('P4a ★ 折叠后列表不可见', !bodyVisible, `bodyVisible=${bodyVisible}`)
      check('P4b ★ 折叠后高度回落到标题行（≤ 40px，不占位）',
        !!collapsedGeom && collapsedGeom.panelHeight <= 40,
        collapsedGeom ? `panelHeight=${collapsedGeom.panelHeight}px` : 'panel 未找到')

      // ── P5 展开 ─────────────────────────────────────────────────────
      await page.locator('.recent-files-head').click()
      await sleep(300)
      const expandedVisible = await page.locator('.recent-files-body').isVisible()
      const expandedRows = await page.locator('.recent-file').count()
      check('P5 ★ 再点一次展开：列表回来且有内容', expandedVisible && expandedRows > 0,
        `visible=${expandedVisible}, rows=${expandedRows}`)

      // ── P6 手动刷新绕过后端缓存 ──────────────────────────────────────
      probeFiles.push(makeProbeFile(secondName))
      await page.locator('.recent-files-refresh').click()
      const refreshed = await waitFor(async () => {
        const names = await page.locator('.recent-file-name').allInnerTexts()
        return names.map((n) => n.trim()).includes(secondName)
      }, 15000)
      const topAfterRefresh = (await page.locator('.recent-file-name').first().innerText()).trim()
      check('P6 ★ 点刷新后出现新建的文件（没吃 12s 缓存）', refreshed && topAfterRefresh === secondName,
        `top="${topAfterRefresh}"`)

      // ── P7 位置 ─────────────────────────────────────────────────────
      const geom = await readPanel(page)
      const docked = !!geom
        && Math.abs(geom.panelBottom - geom.sidebarBottom) <= 2
        && geom.panelWidth === geom.sidebarWidth
        && (geom.treeBottom == null || geom.panelTop >= geom.treeBottom - 1)
      check('P7 面板贴侧栏底部、在文件树下方、宽度一致', docked,
        geom
          ? `panel.b=${Math.round(geom.panelBottom)} sidebar.b=${Math.round(geom.sidebarBottom)} ` +
            `w=${geom.panelWidth}/${geom.sidebarWidth} tree.b=${geom.treeBottom == null ? '-' : Math.round(geom.treeBottom)} ` +
            `panel.t=${Math.round(geom.panelTop)}`
          : 'panel 未找到')
    }

    const toastCount = await page.locator('.el-message--error').count()
    check('P8 全程没有弹错误提示', toastCount === 0, `error toast=${toastCount}`)

    fs.mkdirSync(SHOT_DIR, { recursive: true })
    await page.screenshot({ path: path.join(SHOT_DIR, REVERSE ? 'reverse.png' : 'panel.png') }).catch(() => {})
  } finally {
    if (browser) await browser.close().catch(() => {})
    // 先清快照里的引用，再删文件：顺序反了会留下一个指向不存在路径的标签
    scrubWorkspaceSnapshot([firstName, secondName])
    for (const f of probeFiles) { try { fs.unlinkSync(f) } catch {} }
  }

  const failed = results.filter((r) => !r.ok)
  const noisy = consoleErrors.filter((e) => !/favicon|ResizeObserver|DevTools|Canceled/i.test(e))
  console.log('\n[verify] 截图目录:', SHOT_DIR)
  console.log(`[verify] 结果: ${results.length - failed.length}/${results.length} 通过`)
  if (noisy.length) console.log('[verify] console errors:', noisy.slice(0, 5))
  if (pageErrors.length) console.log('[verify] page errors:', pageErrors.slice(0, 5))
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('[verify] 脚本异常:', e)
  process.exit(1)
})

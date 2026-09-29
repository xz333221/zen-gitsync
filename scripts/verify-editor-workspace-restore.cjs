/**
 * 文件空间「工作区恢复」回归验证（树展开态 + 打开的标签页）。
 *
 * 需求（用户提）：文件空间能不能缓存当前项目的目录树展开状态和已打开的文件。
 * 落地方案：ui.editorWorkspaceByProject[项目绝对路径] = { expandedDirs, tabs, activeTab }
 *   - 写：EditorView 里 watch 一个 workspaceSnapshot computed（树展开态 / 标签 / 激活标签），
 *     变化时防抖 300ms 落盘到 ~/.zen-gitsync/config.json
 *   - 读：EditorView onMounted（以及切项目时）调 restoreWorkspace()，
 *     树走 /api/browse_directory_tree 一次请求整棵重建，标签逐个静默重开
 *
 * 验证项：
 *   P1 前置 文件树已加载
 *   P2 前置 展开一个目录 + 打开两个文件（记录路径，作为恢复的期望值）
 *   P3 ★ 快照真的落到了配置文件（tabs 顺序 / expandedDirs 都按 DOM 里的期望值比对）
 *   P4 ★ reload 后标签按原顺序恢复，激活标签也对
 *   P5 ★ reload 后目录树展开态恢复（该目录的子节点重新出现在 DOM 里）
 *   P6 反向护栏：reload 前就折叠的目录，恢复后仍然折叠（别把整棵树都撑开）
 *   P7 没弹错误提示（恢复过程是静默的 —— 文件被删/改名不该弹红条）
 *
 * 副作用：会往 ~/.zen-gitsync/config.json 里写当前项目的快照。
 * 脚本在开始前备份该文件，finally 里原样写回，跑完不改变用户配置。
 *
 * 前置：dev server 已启动（npm run dev:ping 两个 OK，前端 5544）。
 * 用法：node scripts/verify-editor-workspace-restore.cjs
 * 退出码：0 全通过，1 有失败项。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'zen-editor-workspace-restore')
const CONFIG_FILE = process.env.ZEN_CONFIG_FILE || path.join(os.homedir(), '.zen-gitsync', 'config.json')

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function waitFor(fn, timeout = 10000, step = 150) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 > timeout) return false
    await sleep(step)
  }
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch { return null }
}

/** 当前 DOM 里的标签页（顺序即标签顺序） */
function readTabs(page) {
  return page.$$eval('.editor-tab', els => els.map(e => ({
    name: (e.querySelector('.tab-name')?.textContent || '').trim(),
    path: e.getAttribute('title') || '',
    active: e.classList.contains('active'),
  })))
}

/** 当前 DOM 里可见的文件树节点（展开的目录才有子节点进来） */
function readTree(page) {
  return page.evaluate(() => [...document.querySelectorAll('.tree-node')].map(n => ({
    name: (n.querySelector('.tree-name')?.textContent || '').trim(),
    path: n.querySelector('.tree-name')?.getAttribute('title') || '',
    isDir: !!n.querySelector('.tree-arrow'),
    expanded: !!n.querySelector('.tree-arrow')?.classList.contains('expanded'),
  })))
}

/** 进文件空间 + 等文件树出来 */
async function openEditorView(page) {
  await page.locator('.activity-btn[aria-label^="编辑器"], .activity-btn[aria-label^="文件空间"]').first().click()
  return waitFor(async () => (await page.locator('.tree-node').count()) > 3, 20000)
}

async function main() {
  if (!fs.existsSync(CONFIG_FILE)) throw new Error(`找不到配置文件: ${CONFIG_FILE}`)
  const backup = fs.readFileSync(CONFIG_FILE, 'utf8')

  // 归一化起点：配置是全局共享的（同机其它 session / 手动操作都会往同一份
  // ui.editorWorkspaceByProject 里写），先把当前项目的条目清成空基线，
  // 否则"reload 前开了几个标签"就没有确定期望值。备份已在上面留好，跑完原样写回。
  const cwdRes = await fetch(`${BASE}/api/current_directory`).then(r => r.json()).catch(() => null)
  const cwd = cwdRes?.directory || ''
  if (!cwd) throw new Error('取不到当前工作目录，无法归一化起点')
  const baseline = readConfig()
  baseline.ui = baseline.ui || {}
  baseline.ui.editorWorkspaceByProject = {
    ...(baseline.ui.editorWorkspaceByProject || {}),
    [cwd]: { expandedDirs: [], tabs: [], activeTab: null },
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(baseline, null, 2))
  log('基线快照已重置:', cwd)

  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 30000 })
    await page.locator('.loading-container').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
    // 等 loadConfig 落地：isUiLoaded 之前 EditorView 不写快照（configStore 的防回写护栏）
    await sleep(1200)

    // ── P1 前置：文件树 ─────────────────────────────────────────────────
    const treeReady = await openEditorView(page)
    check('P1 前置 文件树已加载', treeReady, `nodes=${await page.locator('.tree-node').count()}`)
    if (!treeReady) throw new Error('文件树没出来，后续无法验证')

    // ── P2 前置：展开一个目录 + 打开两个文件 ─────────────────────────────
    const before = await readTree(page)
    const collapsedDirs = before.filter(n => n.isDir && !n.expanded)
    if (collapsedDirs.length === 0) throw new Error('没有可展开的目录，无法验证展开态')
    const target = collapsedDirs[0]

    await page.evaluate((dirPath) => {
      const node = [...document.querySelectorAll('.tree-node')]
        .find(n => n.querySelector('.tree-name')?.getAttribute('title') === dirPath)
      node?.click()
    }, target.path)
    const expanded = await waitFor(async () => (await readTree(page)).length > before.length, 10000)
    check('P2a 前置 目录可展开', expanded, `${target.name}`)
    if (!expanded) throw new Error('目录点不开，后续无法验证展开态')

    const afterExpand = await readTree(page)
    // 新出现的节点 = 刚展开那个目录的子节点（展开会把子节点插到父节点后面，不是简单追加到末尾，
    // 所以按 path 做集合差，别用"后 N 个"）
    const beforePaths = new Set(before.map(n => n.path))
    const childNames = afterExpand.filter(n => !beforePaths.has(n.path)).map(n => n.name)
    // 反向护栏用的目录：展开前就折叠、且不是刚展开的那个
    const untouchedDir = collapsedDirs.find(n => n.path !== target.path) || null

    const files = afterExpand.filter(n => !n.isDir).slice(0, 2)
    if (files.length < 2) throw new Error(`可见文件不足 2 个（只有 ${files.length} 个），无法验证多标签`)
    for (const f of files) {
      await page.evaluate((p) => {
        const node = [...document.querySelectorAll('.tree-node')]
          .find(n => n.querySelector('.tree-name')?.getAttribute('title') === p)
        node?.click()
      }, f.path)
      await sleep(400)
    }
    const tabsAfterOpen = await readTabs(page)
    check('P2b 前置 两个文件都打开了（顺序一致）',
      JSON.stringify(tabsAfterOpen.map(t => t.path)) === JSON.stringify(files.map(f => f.path)),
      tabsAfterOpen.map(t => t.name).join(' | '))
    if (tabsAfterOpen.length !== 2) throw new Error('标签页没按预期打开，后续无法验证恢复')

    const expectedTabs = files.map(f => f.path)
    const expectedActive = expectedTabs[1]

    // ── P3 快照落盘 ────────────────────────────────────────────────────
    const readWs = () => readConfig()?.ui?.editorWorkspaceByProject?.[cwd] || null
    const saved = await waitFor(() => (readWs()?.tabs || []).length === 2, 8000)
    const wsEntry = readWs()
    check('P3a ★ 快照已写入配置文件', saved,
      wsEntry ? `tabs=${wsEntry.tabs.length} expandedDirs=${wsEntry.expandedDirs.length}` : '没找到条目')
    check('P3b ★ 快照里的标签顺序 = DOM 里的顺序',
      !!wsEntry && JSON.stringify(wsEntry.tabs) === JSON.stringify(expectedTabs),
      wsEntry ? JSON.stringify(wsEntry.tabs) : 'n/a')
    check('P3c ★ 快照里记下了展开的目录',
      !!wsEntry && wsEntry.expandedDirs.includes(target.path),
      wsEntry ? `含 ${target.name}: ${wsEntry.expandedDirs.includes(target.path)}` : 'n/a')
    check('P3d ★ 快照里的激活标签 = 最后打开的那个',
      !!wsEntry && wsEntry.activeTab === expectedActive,
      wsEntry ? `${wsEntry.activeTab}` : 'n/a')

    // ── P4/P5 刷新后恢复 ───────────────────────────────────────────────
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 30000 })
    await page.locator('.loading-container').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
    await sleep(1000)
    const treeReady2 = await openEditorView(page)
    check('P4a 前置 reload 后文件树重新加载', treeReady2)
    if (!treeReady2) throw new Error('reload 后文件树没出来')

    const restored = await waitFor(async () => (await readTabs(page)).length === 2, 12000)
    const tabsRestored = await readTabs(page)
    check('P4b ★ reload 后标签页恢复（个数 + 顺序）',
      JSON.stringify(tabsRestored.map(t => t.path)) === JSON.stringify(expectedTabs),
      tabsRestored.map(t => t.name).join(' | '))
    check('P4c ★ reload 后激活的是上次那个标签',
      tabsRestored.find(t => t.active)?.path === expectedActive,
      `active=${tabsRestored.find(t => t.active)?.name}`)

    const tree2 = await readTree(page)
    const restoredDir = tree2.find(n => n.path === target.path)
    check('P5a ★ reload 后该目录仍是展开的',
      !!restoredDir && restoredDir.expanded, `${target.name} expanded=${restoredDir?.expanded}`)
    const restoredChildren = tree2.filter(n => n.path.startsWith(target.path)).map(n => n.name)
    check('P5b ★ 展开目录的子节点重新出现在 DOM 里',
      restoredChildren.length >= childNames.length,
      `子节点 ${restoredChildren.length} 个（期望 ≥${childNames.length}）`)

    if (untouchedDir) {
      const stillCollapsed = tree2.find(n => n.path === untouchedDir.path)
      check('P6 反向护栏：reload 前折叠的目录恢复后仍折叠',
        !!stillCollapsed && !stillCollapsed.expanded, `${untouchedDir.name}`)
    } else {
      log('跳过 P6：只有一个顶层目录')
    }

    const toastCount = await page.locator('.el-message--error').count()
    check('P7 恢复过程没有弹错误提示', toastCount === 0, `error toast=${toastCount}`)

    // ── P8 快照里有已经不存在的文件时：静默跳过 + 从快照里剔除 ──────────
    // 用户删掉/改名一个文件后再打开，不该看到"打开文件失败"的红条，也不该每次都白试一遍。
    const ghost = path.join(os.homedir(), 'zen-workspace-ghost-file.md')
    const patched = readConfig()
    if (patched?.ui?.editorWorkspaceByProject?.[cwd]) {
      patched.ui.editorWorkspaceByProject[cwd].tabs.push(ghost)
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(patched, null, 2))
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.activity-bar', { timeout: 30000 })
      await page.locator('.loading-container').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
      await sleep(1000)
      await openEditorView(page)
      await waitFor(async () => (await readTabs(page)).length >= 2, 12000)
      const tabsWithGhost = await readTabs(page)
      check('P8a ★ 不存在的文件被静默跳过（照常恢复其余标签）',
        JSON.stringify(tabsWithGhost.map(t => t.path)) === JSON.stringify(expectedTabs),
        tabsWithGhost.map(t => t.name).join(' | '))
      const ghostToast = await page.locator('.el-message--error').count()
      check('P8b ★ 没有为它弹错误提示', ghostToast === 0, `error toast=${ghostToast}`)
      const pruned = await waitFor(() => {
        const entry = readConfig()?.ui?.editorWorkspaceByProject?.[cwd]
        return !!entry && !entry.tabs.includes(ghost)
      }, 8000)
      check('P8c ★ 已把它从快照里剔除（下次不再白试）', pruned,
        JSON.stringify(readConfig()?.ui?.editorWorkspaceByProject?.[cwd]?.tabs || []))
    } else {
      log('跳过 P8：没读到快照条目')
    }

    fs.mkdirSync(SHOT_DIR, { recursive: true })
    await page.screenshot({ path: path.join(SHOT_DIR, 'after-reload.png') }).catch(() => {})
    log('快照 key（当前项目）:', Object.keys(readConfig()?.ui?.editorWorkspaceByProject || {}).join(', ') || '(无)')
  } finally {
    await browser.close().catch(() => {})
    // 原样写回配置：不给用户留测试产生的快照
    try { fs.writeFileSync(CONFIG_FILE, backup) } catch (e) { console.error('[verify] 恢复配置失败:', e.message) }
  }

  const failed = results.filter(r => !r.ok)
  const noisy = consoleErrors.filter(e => !/favicon|ResizeObserver|DevTools/i.test(e))
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

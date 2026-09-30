/**
 * 文件空间「外部改动自动进标签」回归验证。
 *
 * 需求（用户提）：在文件空间里打开的文件，被 AI 面板 / 别的编辑器 / 命令行改过之后
 * 编辑器一直显示旧内容；关掉标签再打开也不更新。问能不能实时。
 *
 * 落地（两件事）：
 *   A. 关掉标签后重开拿到旧内容 —— 根因是 modelCache（路径 → ITextModel）在关标签时
 *      没释放，openFile 重读的正文被 getOrCreateModel 还回来的旧 model 盖掉。
 *      openFile 现在先摘再 dispose 旧 model（restoreTab 早有同款处置）。
 *   B. 加一条"用户看得见就对一次账"的路径：窗口重新聚焦 / 切标签 / 切回本视图时，
 *      拿 GET /api/editor/file?meta=1 的 mtimeMs 跟标签记的基线比一次，变了才取正文。
 *      没脏改动 → 静默替换（保住光标与撤销栈）；有脏改动 → 弹窗让用户选，绝不自动覆盖。
 *      另有一个 30s 兜底轮询，盖住"同窗口 AI 面板写文件、用户没切焦点"那种没人触发的场景。
 *
 * 验证项：
 *   P1 前置 后端 meta 接口返回 mtimeMs（比对基线的来源）
 *   P2 前置 打开测试文件，编辑器显示 LINE-1
 *   P3 ★ 外部改盘 + 窗口聚焦 → 编辑器静默变成 LINE-2（不脏时自动跟盘）
 *   P3c ★ 同窗口外部改动、全程不切焦点 → 30s 兜底轮询也能跟上
 *   P4 ★ 关掉标签再打开 → 拿到盘上最新的 LINE-3（用户报的那个 bug，A 项）
 *   P5 ★ 后台标签被改 → 切回该标签时变成 LINE-4（切标签触发对账）
 *   P6 ★ 有未保存改动时不被静默覆盖：弹选择框，选"保留我的"后内容不动
 *   P7 没弹错误提示、没有 console error / pageerror
 *
 * 副作用：在项目根建一个 .zen-verify-disk-sync.md 当靶子，finally 里删掉；
 * 会往 ~/.zen-gitsync/config.json 写当前项目的工作区快照，脚本开始前备份、finally 原样写回。
 *
 * 前置：dev server 已启动（npm run dev:ping 两个 OK，前端 5544）。
 * 用法：npm run verify:editor-disk-sync
 * 退出码：0 全通过，1 有失败项。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'zen-editor-disk-sync')
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

/** 编辑器当前显示的正文。靶子文件只有一两行，.view-lines 就是全文。 */
function readEditorText(page) {
  return page.evaluate(() => {
    const lines = [...document.querySelectorAll('.monaco-editor .view-lines .view-line')]
    // Monaco 把行首空白渲染成 nbsp，比对前先归一化
    return lines.map(l => (l.textContent || '').replace(/\u00a0/g, ' ')).join('\n')
  })
}

function readTabs(page) {
  return page.$$eval('.editor-tab', els => els.map(e => e.getAttribute('title') || ''))
}

/** 进文件空间 + 等文件树出来 */
async function openEditorView(page) {
  const btn = page.locator('.activity-btn[aria-label^="编辑器"], .activity-btn[aria-label^="文件空间"]').first()
  await btn.click()
  if (await waitFor(async () => (await page.locator('.tree-node').count()) > 3, 20000)) return true
  // vite 刚改完代码时头一次加载可能整页拿不到 chunk（表现为树空着）。
  // 这不是被测行为，重载一次再判 —— 别让它把一次真实回归假报成通过，也别把环境抖动报成失败。
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForSelector('.activity-bar', { timeout: 30000 }).catch(() => {})
  await sleep(1500)
  await btn.click()
  return waitFor(async () => (await page.locator('.tree-node').count()) > 3, 20000)
}

/** 点文件树里某个路径的节点打开它 */
async function clickTreeNode(page, nodePath) {
  const clicked = await page.evaluate((p) => {
    const node = [...document.querySelectorAll('.tree-node')]
      .find(n => n.querySelector('.tree-name')?.getAttribute('title') === p)
    node?.click()
    return !!node
  }, nodePath)
  await sleep(700)
  return clicked
}

/** 窗口重新聚焦（合成事件即可 —— handleWindowFocus 只看 document.hidden） */
async function refocusWindow(page) {
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
}

async function main() {
  if (!fs.existsSync(CONFIG_FILE)) throw new Error(`找不到配置文件: ${CONFIG_FILE}`)
  const configBackup = fs.readFileSync(CONFIG_FILE, 'utf8')
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const cwdRes = await fetch(`${BASE}/api/current_directory`).then(r => r.json()).catch(() => null)
  const cwd = cwdRes?.directory || ''
  if (!cwd) throw new Error('取不到当前工作目录')
  const testFile = path.join(cwd, '.zen-verify-disk-sync.md')

  // 归一化起点：工作区快照是全局共享的（同机别的 session 也往同一份 config.json 里写），
  // 先把当前项目清成空基线，否则"点开测试文件后有几个标签"没有确定期望值。
  const baseline = JSON.parse(configBackup)
  baseline.ui = baseline.ui || {}
  baseline.ui.editorWorkspaceByProject = {
    ...(baseline.ui.editorWorkspaceByProject || {}),
    [cwd]: { expandedDirs: [], tabs: [], activeTab: null },
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(baseline, null, 2))

  // 靶子文件必须在开浏览器之前落盘：文件树是挂载时整棵拉的
  const writeDisk = (text) => fs.writeFileSync(testFile, text, 'utf8')
  writeDisk('LINE-1\n')
  log('靶子文件:', testFile)

  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(e?.stack ? String(e.stack).split('\n').slice(0, 3).join(' | ') : String(e)))

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 30000 })
    await page.locator('.loading-container').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
    await sleep(1200)

    // ── P1 前置：meta 接口 ──────────────────────────────────────────────
    const meta1 = await page.evaluate(async (p) => {
      const r = await fetch(`/api/editor/file?path=${encodeURIComponent(p)}&meta=1`)
      return await r.json()
    }, testFile)
    check('P1 前置 meta 接口返回 mtimeMs', meta1?.success === true && typeof meta1.mtimeMs === 'number',
      `mtimeMs=${meta1?.mtimeMs}`)

    const treeReady = await openEditorView(page)
    check('P2a 前置 文件树已加载', treeReady, `nodes=${await page.locator('.tree-node').count()}`)
    if (!treeReady) throw new Error('文件树没出来，后续无法验证')

    const opened = await clickTreeNode(page, testFile)
    const editorUp = await page.waitForSelector('.monaco-editor .view-lines', { timeout: 15000 }).then(() => true).catch(() => false)
    check('P2b 前置 测试文件已打开、编辑器起来了', opened && editorUp,
      `tabs=${(await readTabs(page)).length}`)
    if (!opened || !editorUp) throw new Error('测试文件打不开，后续无法验证')

    const text1 = await readEditorText(page)
    check('P2c 前置 编辑器显示盘上初始内容', text1.includes('LINE-1'), JSON.stringify(text1))

    // ── P3 外部改盘 + 窗口聚焦 → 静默跟盘 ────────────────────────────────
    writeDisk('LINE-2\n')
    await refocusWindow(page)
    const synced2 = await waitFor(async () => (await readEditorText(page)).includes('LINE-2'), 8000)
    check('P3 ★ 外部改盘 + 窗口聚焦 → 编辑器自动变成最新内容', synced2,
      JSON.stringify(await readEditorText(page)))
    check('P3b 自动跟盘后没有变成"未保存"', !(await page.locator('.editor-tab.active .tab-dirty-dot').count()))

    // ── P3c 同窗口没人切焦点时，靠 30s 兜底轮询也能跟上 ──────────────────
    // 这条对应最常撞上的场景：AI 面板在同一个窗口里把文件写了，用户全程没切焦点。
    // 触发点（聚焦/切标签/切视图）一个都不会响，只能等这轮轮询。
    writeDisk('LINE-2b\n')
    const synced2b = await waitFor(async () => (await readEditorText(page)).includes('LINE-2b'), 40000, 500)
    check('P3c ★ 同窗口外部改动：不切焦点也能在半分钟内跟上（30s 兜底轮询）', synced2b,
      JSON.stringify(await readEditorText(page)))

    // ── P4 关掉标签再打开 → 必须是盘上最新的 ─────────────────────────────
    // 用户报的就是这条：重开拿到的是 modelCache 里那份旧的。
    writeDisk('LINE-3\n')
    await page.locator('.editor-tab.active .tab-close').click()
    await sleep(500)
    const closedAll = (await readTabs(page)).length === 0
    await clickTreeNode(page, testFile)
    await page.waitForSelector('.monaco-editor .view-lines', { timeout: 15000 }).catch(() => {})
    await sleep(500)
    const text3 = await readEditorText(page)
    check('P4 ★ 关掉标签再打开 → 拿到盘上最新内容（不再是缓存里的旧 model）',
      closedAll && text3.includes('LINE-3'), `closed=${closedAll} text=${JSON.stringify(text3)}`)

    // ── P5 后台标签被改 → 切回来就是新的 ─────────────────────────────────
    const other = await page.evaluate((self) => {
      const n = [...document.querySelectorAll('.tree-node')]
        .find(x => x.querySelector('.tree-name')?.getAttribute('title') !== self
          && !x.querySelector('.tree-arrow'))
      return n?.querySelector('.tree-name')?.getAttribute('title') || null
    }, testFile)
    if (!other) throw new Error('找不到第二个文件，无法验证切标签对账')
    await clickTreeNode(page, other)
    await sleep(500)
    writeDisk('LINE-4\n')
    // 切回测试文件的标签 → 触发的就是 watch(activeTabPath) 里那次对账
    await page.locator('.editor-tab', { hasText: path.basename(testFile) }).first().click()
    const synced4 = await waitFor(async () => (await readEditorText(page)).includes('LINE-4'), 8000)
    check('P5 ★ 后台被改的标签，切回来时自动变成最新内容', synced4,
      JSON.stringify(await readEditorText(page)))

    // ── P6 有未保存改动时绝不静默覆盖 ────────────────────────────────────
    await page.click('.monaco-editor .view-lines', { timeout: 10000 }).catch(() => {})
    await sleep(250)
    await page.keyboard.type('MY-EDIT ')
    await sleep(400)
    const dirtyNow = (await page.locator('.editor-tab.active .tab-dirty-dot').count()) > 0
    writeDisk('LINE-5\n')
    await refocusWindow(page)
    const boxUp = await page.waitForSelector('.el-message-box', { timeout: 8000 }).then(() => true).catch(() => false)
    const textWhileDirty = await readEditorText(page)
    check('P6a ★ 有未保存改动时弹选择框而不是静默覆盖', dirtyNow && boxUp,
      `dirty=${dirtyNow} box=${boxUp}`)
    check('P6b ★ 弹窗期间编辑器内容没被换掉', textWhileDirty.includes('MY-EDIT'),
      JSON.stringify(textWhileDirty))

    // 选「保留我的」（取消按钮）→ 内容保持用户的版本
    await page.locator('.el-message-box__btns button').first().click()
    await sleep(600)
    const textAfterKeep = await readEditorText(page)
    check('P6c ★ 选「保留我的」后用户内容原样保留', textAfterKeep.includes('MY-EDIT'),
      JSON.stringify(textAfterKeep))
    // 同一版不再重复打扰：盘上内容没再变时，再次聚焦不该又弹一次
    await refocusWindow(page)
    await sleep(1500)
    check('P6d ★ 同一版盘上内容不再重复提示', (await page.locator('.el-message-box').count()) === 0)

    // ── P7 干净收尾 ─────────────────────────────────────────────────────
    await page.screenshot({ path: path.join(SHOT_DIR, 'disk-sync.png') })
    check('P7a 没有 console error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
    check('P7b 没有 pageerror', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
    check('P7c 没弹错误提示条', (await page.locator('.el-message--error').count()) === 0)
  } finally {
    await browser.close().catch(() => {})
    try { fs.unlinkSync(testFile) } catch { /* 可能已不存在 */ }
    fs.writeFileSync(CONFIG_FILE, configBackup)
    log('已清理靶子文件并还原 config.json')
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n==> ${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) {
    console.log('失败项:')
    failed.forEach(f => console.log(`  - ${f.name}${f.extra ? '  :: ' + f.extra : ''}`))
  }
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('[verify] 脚本异常:', e)
  process.exit(1)
})

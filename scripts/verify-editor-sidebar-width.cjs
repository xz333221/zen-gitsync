/**
 * 文件空间「左侧栏宽度持久化」回归验证。
 *
 * 需求（用户提）：文件空间左侧的宽度有存吗？刷新了好像又回去了。
 * 原因：侧边栏宽度就是个本地 ref（`ref(220)`），既没读配置也没写配置 ——
 *      上一个提交记的 ui.editorWorkspaceByProject 只有展开态 + 标签，不含宽度。
 * 落地方案：ui.editorSidebarWidth（**全局一份**，不按项目隔离）
 *   - 写：拖拽松手（mouseup）时写一次，拖拽过程中只改本地 ref，不每帧打配置接口
 *   - 读：EditorView.restoreWorkspace 里等 isUiLoaded 之后应用（读早了只会拿到默认值）
 *   - 边界：140–400px，拖拽时夹紧 + 读盘 sanitize 共用同一套常量
 *
 * 验证项：
 *   P1 前置 文件树已加载，侧边栏宽度 = 默认值 220
 *   P2 ★ 拖拽分隔条 → DOM 里侧边栏宽度跟着变
 *   P3 ★ 松手后宽度落到配置文件（ui.editorSidebarWidth）
 *   P4 ★ reload 后宽度恢复成拖过的值（不是 220）—— 用户报的就是这条
 *   P5 ★ 单独拖拽不写脏值：mousedown/mouseup 但没移动，不产生多余的配置写
 *   P6 反向护栏：配置文件里塞越界/非法值（5000 / 50 / "abc"）→ 夹回合法区间
 *
 * 副作用：会往 ~/.zen-gitsync/config.json 写 ui.editorSidebarWidth。
 * 脚本开始前备份该文件，finally 里原样写回，跑完不改变用户配置。
 *
 * 前置：dev server 已启动（npm run dev:ping 两个 OK，前端 5544）。
 * 用法：node scripts/verify-editor-sidebar-width.cjs
 * 退出码：0 全通过，1 有失败项。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'zen-editor-sidebar-width')
const CONFIG_FILE = process.env.ZEN_CONFIG_FILE || path.join(os.homedir(), '.zen-gitsync', 'config.json')

// 与 configStore 里的常量保持一致（脚本是纯 JS，直接 import TS 不方便，这里对齐数值）
const MIN_W = 140
const MAX_W = 400
const DEFAULT_W = 220

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

/** DOM 里侧边栏的实际渲染宽度（取整，避免亚像素抖动） */
function readSidebarWidth(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.editor-sidebar')
    return el ? Math.round(el.getBoundingClientRect().width) : -1
  })
}

/** 进文件空间 + 等文件树出来 */
async function openEditorView(page) {
  await page.locator('.activity-btn[aria-label^="编辑器"], .activity-btn[aria-label^="文件空间"]').first().click()
  return waitFor(async () => (await page.locator('.tree-node').count()) > 3, 20000)
}

/** 等应用起完（activity bar 出现 + loading 消失 + loadConfig 落地） */
async function bootApp(page) {
  await page.waitForSelector('.activity-bar', { timeout: 30000 })
  await page.locator('.loading-container').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
  await sleep(1200)
}

/** 用真实鼠标事件拖分隔条：按下 → 平移 → 松手（startSidebarResize 读的是 mousedown 的 clientX） */
async function dragResizer(page, deltaX) {
  const handle = page.locator('.editor-resizer').first()
  const box = await handle.boundingBox()
  if (!box) throw new Error('找不到 .editor-resizer，无法拖拽')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  // 分几步移动：单步跳变在真实浏览器里也能过，但分步更贴近手拖的轨迹
  for (let i = 1; i <= 4; i++) await page.mouse.move(cx + (deltaX * i) / 4, cy)
  await page.mouse.up()
  await sleep(300)
}

async function main() {
  if (!fs.existsSync(CONFIG_FILE)) throw new Error(`找不到配置文件: ${CONFIG_FILE}`)
  const backup = fs.readFileSync(CONFIG_FILE, 'utf8')

  // 归一化起点：宽度是全局的，同机其它 session / 上次跑剩的值都会影响期望值，
  // 先把该项删掉（删掉 = 走默认 220），否则"拖之前是多少"不确定。备份已留好，跑完原样写回。
  const baseline = readConfig()
  baseline.ui = baseline.ui || {}
  delete baseline.ui.editorSidebarWidth
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(baseline, null, 2))
  log('基线已重置：ui.editorSidebarWidth 已删除（回默认 220）')

  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await bootApp(page)

    // ── P1 前置：文件树 + 默认宽度 ─────────────────────────────────────
    const treeReady = await openEditorView(page)
    check('P1a 前置 文件树已加载', treeReady, `nodes=${await page.locator('.tree-node').count()}`)
    if (!treeReady) throw new Error('文件树没出来，后续无法验证')
    const w0 = await readSidebarWidth(page)
    check('P1b 前置 未配置时用默认宽度', w0 === DEFAULT_W, `实际 ${w0}px，期望 ${DEFAULT_W}px`)

    // ── P2 拖拽改变宽度 ───────────────────────────────────────────────
    await dragResizer(page, 100)
    const w1 = await readSidebarWidth(page)
    check('P2 ★ 拖拽后 DOM 宽度跟着变', w1 > w0 + 60, `${w0}px → ${w1}px`)
    if (w1 <= w0 + 60) throw new Error('拖拽没生效，后续无法验证持久化')

    // ── P3 落盘 ──────────────────────────────────────────────────────
    const readSaved = () => readConfig()?.ui?.editorSidebarWidth
    const savedOk = await waitFor(() => Math.abs(Number(readSaved()) - w1) <= 2, 8000)
    check('P3 ★ 松手后宽度写进了配置文件', savedOk, `ui.editorSidebarWidth=${readSaved()}（DOM ${w1}px）`)

    // ── P4 reload 后恢复（用户报的就是这条）─────────────────────────────
    await page.reload({ waitUntil: 'domcontentloaded' })
    await bootApp(page)
    const treeReady2 = await openEditorView(page)
    check('P4a 前置 reload 后文件树重新加载', treeReady2)
    if (!treeReady2) throw new Error('reload 后文件树没出来')
    // 恢复是异步的（要等 ui 配置加载完），轮询到宽度等于拖过的值为止
    await waitFor(async () => (await readSidebarWidth(page)) === w1, 8000)
    const w2 = await readSidebarWidth(page)
    check('P4b ★ reload 后宽度恢复成拖过的值（不是 220）', w2 === w1, `${w2}px，期望 ${w1}px`)

    // ── P5 只点不拖：不该产生配置写 ────────────────────────────────────
    const beforeClick = readConfig()?.ui?.editorSidebarWidth
    const handle = page.locator('.editor-resizer').first()
    const box = await handle.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.up()
    await sleep(1200)
    const afterClick = readConfig()?.ui?.editorSidebarWidth
    check('P5 只按下不移动：宽度不变、配置也没被改写',
      afterClick === beforeClick && (await readSidebarWidth(page)) === w1,
      `配置 ${beforeClick} → ${afterClick}`)

    // ── P6 越界/非法值 sanitize ────────────────────────────────────────
    for (const [raw, expect, label] of [[5000, MAX_W, '上限 5000'], [50, MIN_W, '下限 50'], ['abc', DEFAULT_W, '非数字 abc']]) {
      const patched = readConfig()
      patched.ui.editorSidebarWidth = raw
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(patched, null, 2))
      await page.reload({ waitUntil: 'domcontentloaded' })
      await bootApp(page)
      await openEditorView(page)
      const w = await readSidebarWidth(page)
      check(`P6 反向护栏：配置里 ${label} → 夹回合法区间`, w === expect, `${w}px，期望 ${expect}px`)
    }

    const toastCount = await page.locator('.el-message--error').count()
    check('P7 全程没有弹错误提示', toastCount === 0, `error toast=${toastCount}`)

    fs.mkdirSync(SHOT_DIR, { recursive: true })
    await page.screenshot({ path: path.join(SHOT_DIR, 'after-reload.png') }).catch(() => {})
  } finally {
    await browser.close().catch(() => {})
    // 原样写回配置：不给用户留测试产生的宽度
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

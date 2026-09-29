/**
 * 文件空间「自动保存」默认开启 —— 回归验证。
 *
 * 需求（用户提）：设置 → 文件空间设置 → 自动保存，默认应该是开启的。
 * 落地：configStore 的 defaultUiSettings.editorAutoSave 由 false 改为 true。
 *   只影响"从没设置过"的配置 —— 用户手动关过就在 config.json 里留着 false，不会被默认值翻回去。
 *
 * 验证项：
 *   P1 前置 应用加载 + 文件空间的文件树出来
 *   P2 ★ 配置里从没写过 editorAutoSave 时，设置面板的「自动保存」开关默认是开启的
 *   P3 ★ 默认开启状态下失焦真的落盘（输入探针字符串 → 编辑器失焦 → 盘上内容出现探针）
 *   P4 ★ 在设置里关掉并保存 → config.json 里 editorAutoSave 落盘 false
 *   P5 ★ reload 后开关仍是关闭（默认值不把用户的显式选择翻回去）
 *   P6 ★ 关闭状态下失焦不落盘（开关真的在管这条链路）
 *   P7 全程没弹未捕获错误 / 页面级异常
 *
 * 副作用：会临时改 ~/.zen-gitsync/config.json（摘掉 ui.editorAutoSave）和脚本选中的那个文本文件
 * （探针字符落盘）。两者都在开始时备份，finally 里原样写回并回读校验，跑完不留痕迹。
 *
 * 前置：dev server 已启动（npm run dev:ping 两个 OK，前端 5544）。
 * 用法：node scripts/verify-editor-autosave-default.cjs
 * 退出码：0 全通过，1 有失败项。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'zen-autosave-default')
const CONFIG_FILE = process.env.ZEN_CONFIG_FILE || path.join(os.homedir(), '.zen-gitsync', 'config.json')

// 探针用纯字母数字：不会触发 Monaco 的自动闭合括号 / 引号，落盘内容可预期
const PROBE_ON = 'ZzAutosaveProbe9'
const PROBE_OFF = 'ZzAutosaveProbe8'
// 只挑纯文本文件当靶子，图片 / Office 走的是预览面板，编辑器里输不了字
const TEXT_FILE_RE = /\.(md|markdown|txt|json|js|cjs|mjs|ts|vue|css|scss|html|htm|yml|yaml|log|ini|conf|toml)$/i

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

// ── 设置对话框：打开 / 切 tab / 读写开关 / 保存 / 关闭 ────────────────────
const labelRe = (zh, en) => new RegExp(`${zh}|${en}`, 'i')

async function openSettingsEditorTab(page) {
  const clicked = await page.evaluate((src) => {
    const re = new RegExp(src, 'i')
    const btn = [...document.querySelectorAll('button[aria-label]')]
      .find(b => re.test(b.getAttribute('aria-label') || ''))
    if (!btn) return false
    btn.click()
    return true
  }, labelRe('用户设置', 'user settings').source)
  if (!clicked) return false
  await page.waitForSelector('.user-settings-dialog .settings-tabs', { timeout: 10000 }).catch(() => {})
  // loading 遮罩会吃掉点击，等它退场
  await page.locator('.user-settings-dialog .el-loading-mask').waitFor({ state: 'detached', timeout: 8000 }).catch(() => {})
  await page.evaluate((src) => {
    const re = new RegExp(src, 'i')
    const tab = [...document.querySelectorAll('.user-settings-dialog .tab-item')]
      .find(e => re.test(e.textContent || ''))
    tab?.click()
  }, labelRe('文件空间设置', 'file space settings').source)
  await sleep(300)
  return true
}

/** 读「自动保存」开关；找不到返回 null */
function readAutoSaveSwitch(page) {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i')
    const row = [...document.querySelectorAll('.user-settings-dialog .setting-row')]
      .find(r => re.test(r.querySelector('.setting-label')?.textContent || ''))
    const sw = row?.querySelector('.el-switch')
    if (!sw) return null
    const aria = sw.getAttribute('aria-checked')
    return {
      on: aria ? aria === 'true' : sw.classList.contains('is-checked'),
      label: (row.querySelector('.setting-label')?.textContent || '').trim(),
    }
  }, labelRe('自动保存', 'auto\\s*save').source)
}

function toggleAutoSave(page) {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i')
    const row = [...document.querySelectorAll('.user-settings-dialog .setting-row')]
      .find(r => re.test(r.querySelector('.setting-label')?.textContent || ''))
    const sw = row?.querySelector('.el-switch')
    if (!sw) return false
    ;(sw.querySelector('.el-switch__core') || sw).click()
    return true
  }, labelRe('自动保存', 'auto\\s*save').source)
}

/** 保存按钮只在有改动时渲染（hasChanges） */
function clickSave(page) {
  return page.evaluate(() => {
    const btn = document.querySelector('.user-settings-dialog .dialog-confirm-btn')
    if (!btn) return false
    btn.click()
    return true
  })
}

async function closeSettings(page) {
  await page.evaluate(() => {
    document.querySelector('.user-settings-dialog .el-dialog__headerbtn')?.click()
  })
  await page.waitForSelector('.user-settings-dialog', { state: 'detached', timeout: 8000 }).catch(() => {})
  await sleep(300)
}

// ── 文件空间 ────────────────────────────────────────────────────────────
async function openEditorView(page) {
  await page.evaluate(() => {
    const re = /编辑器|文件空间|editor|file space/i
    const btn = [...document.querySelectorAll('.activity-btn')]
      .find(b => re.test(b.getAttribute('aria-label') || ''))
    btn?.click()
  })
  return waitFor(async () => (await page.locator('.tree-node').count()) > 3, 20000)
}

function readTree(page) {
  return page.evaluate(() => [...document.querySelectorAll('.tree-node')].map(n => ({
    name: (n.querySelector('.tree-name')?.textContent || '').trim(),
    path: n.querySelector('.tree-name')?.getAttribute('title') || '',
    isDir: !!n.querySelector('.tree-arrow'),
  })))
}

async function clickTreeNode(page, nodePath) {
  await page.evaluate((p) => {
    const node = [...document.querySelectorAll('.tree-node')]
      .find(n => n.querySelector('.tree-name')?.getAttribute('title') === p)
    node?.click()
  }, nodePath)
  await sleep(600)
}

function readTabs(page) {
  return page.$$eval('.editor-tab', els => els.map(e => e.getAttribute('title') || ''))
}

/** 走 vite proxy 读后端刚读过的盘上内容 */
function readDiskFile(page, filePath) {
  return page.evaluate(async (p) => {
    const r = await fetch(`/api/editor/file?path=${encodeURIComponent(p)}`)
    const d = await r.json()
    return d.success && typeof d.content === 'string' ? d.content : null
  }, filePath)
}

async function typeProbe(page, probe) {
  await page.click('.monaco-editor .view-lines', { timeout: 10000 }).catch(() => {})
  await sleep(250)
  await page.keyboard.type(probe)
  await sleep(300)
}

/**
 * 让编辑器失焦。真鼠标点击标签栏（非输入控件）——
 * Monaco 的 onDidBlurEditorText 只在文本区真的失焦时才触发，
 * 所以用真实点击而不是 dispatchEvent 伪造。
 */
async function blurEditor(page) {
  const tab = page.locator('.editor-tab.active').first()
  if (await tab.count() > 0) await tab.click({ timeout: 5000 }).catch(() => {})
  await sleep(900)
}

async function main() {
  if (!fs.existsSync(CONFIG_FILE)) throw new Error(`找不到配置文件: ${CONFIG_FILE}`)
  const configBackup = fs.readFileSync(CONFIG_FILE, 'utf8')
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  // 造出「从没设置过自动保存」的配置 → 走 configStore 的默认值分支
  const cfg = JSON.parse(configBackup)
  cfg.ui = cfg.ui || {}
  delete cfg.ui.editorAutoSave
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
  log('已摘掉 config.json 里的 ui.editorAutoSave，模拟"从未设置过"')

  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  let testFile = null
  let testFileBackup = null
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 30000 })
    await page.locator('.loading-container').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
    await sleep(1200)

    // ── P1 前置：文件树 ──────────────────────────────────────────────
    const treeReady = await openEditorView(page)
    check('P1 前置 文件空间文件树已加载', treeReady, `nodes=${await page.locator('.tree-node').count()}`)
    if (!treeReady) throw new Error('文件树没出来，后续无法验证')

    // ── P2 默认值 = 开启 ─────────────────────────────────────────────
    const opened = await openSettingsEditorTab(page)
    check('P2a 前置 设置对话框打开并切到「文件空间设置」', opened)
    if (!opened) throw new Error('设置对话框打不开，后续无法验证')
    const sw0 = await readAutoSaveSwitch(page)
    check('P2b ★ 从没设置过时「自动保存」默认开启', !!sw0 && sw0.on === true,
      sw0 ? `label="${sw0.label}" on=${sw0.on}` : '没找到开关')
    await page.screenshot({ path: path.join(SHOT_DIR, 'P2-default-on.png') })
    await closeSettings(page)

    // ── P3 默认开启下失焦落盘 ────────────────────────────────────────
    // 挑靶子文件：树里可见的第一个纯文本文件；没有就展开目录再找
    let candidates = (await readTree(page)).filter(n => !n.isDir && TEXT_FILE_RE.test(n.name))
    if (candidates.length === 0) {
      const dir = (await readTree(page)).find(n => n.isDir)
      if (dir) {
        await clickTreeNode(page, dir.path)
        candidates = (await readTree(page)).filter(n => !n.isDir && TEXT_FILE_RE.test(n.name))
      }
    }
    if (candidates.length === 0) throw new Error('树里找不到纯文本文件，无法验证落盘链路')
    testFile = candidates[0].path
    testFileBackup = fs.readFileSync(testFile, 'utf8')
    log(`靶子文件: ${testFile}（${testFileBackup.length} 字符，已在内存备份）`)

    await clickTreeNode(page, testFile)
    const editorUp = await page.waitForSelector('.monaco-editor .view-lines', { timeout: 15000 })
      .then(() => true).catch(() => false)
    check('P3a 前置 文本文件已在 Monaco 里打开', editorUp && (await readTabs(page)).includes(testFile),
      (await readTabs(page)).length + ' 个标签')
    if (!editorUp) throw new Error('Monaco 没渲染出来，无法验证失焦落盘')

    const diskBefore = await readDiskFile(page, testFile)
    await typeProbe(page, PROBE_ON)
    await blurEditor(page)
    const savedOn = await waitFor(async () => {
      const now = await readDiskFile(page, testFile)
      return typeof now === 'string' && now.includes(PROBE_ON)
    }, 6000)
    const diskAfter = await readDiskFile(page, testFile)
    check('P3b ★ 默认开启下失焦把改动写到了盘上',
      savedOn && !String(diskBefore).includes(PROBE_ON),
      savedOn ? `盘上已含探针（${diskAfter.length} 字符）` : '盘上内容没变')

    // ── P4 关掉并保存 → 落盘 false ───────────────────────────────────
    const opened2 = await openSettingsEditorTab(page)
    check('P4a 前置 重新打开设置', opened2)
    if (!opened2) throw new Error('设置对话框第二次打不开')
    await toggleAutoSave(page)
    const swOff = await readAutoSaveSwitch(page)
    check('P4b 开关切换后界面显示关闭', !!swOff && swOff.on === false,
      swOff ? `on=${swOff.on}` : '没找到开关')
    const saved = await clickSave(page)
    check('P4c 前置 保存按钮可点', saved, saved ? '' : '没有 .dialog-confirm-btn（hasChanges 没生效？）')
    const persisted = await waitFor(() => readConfig()?.ui?.editorAutoSave === false, 6000)
    check('P4d ★ 关掉后 config.json 里 editorAutoSave 落盘 false', persisted,
      `值=${JSON.stringify(readConfig()?.ui?.editorAutoSave)}`)
    await page.screenshot({ path: path.join(SHOT_DIR, 'P4-saved-off.png') })

    // ── P5 reload 后仍是关闭 ─────────────────────────────────────────
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 30000 })
    await page.locator('.loading-container').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
    await sleep(1200)
    const treeReady2 = await openEditorView(page)
    check('P5a 前置 reload 后文件树重新加载', treeReady2)
    if (!treeReady2) throw new Error('reload 后文件树没出来')
    const opened3 = await openSettingsEditorTab(page)
    check('P5b 前置 reload 后设置能打开', opened3)
    const sw1 = await readAutoSaveSwitch(page)
    check('P5c ★ reload 后开关仍是关闭（用户显式选择不被默认值翻回）',
      !!sw1 && sw1.on === false, sw1 ? `on=${sw1.on}` : '没找到开关')
    await page.screenshot({ path: path.join(SHOT_DIR, 'P5-reload-keeps-off.png') })
    await closeSettings(page)

    // ── P6 关闭态下失焦不落盘 ────────────────────────────────────────
    await clickTreeNode(page, testFile)
    const editorUp2 = await page.waitForSelector('.monaco-editor .view-lines', { timeout: 15000 })
      .then(() => true).catch(() => false)
    check('P6a 前置 靶子文件重新打开', editorUp2)
    if (!editorUp2) throw new Error('Monaco 没渲染出来，无法验证关闭态')
    const diskBefore2 = await readDiskFile(page, testFile)
    await typeProbe(page, PROBE_OFF)
    await blurEditor(page)
    await sleep(1500)
    const diskAfter2 = await readDiskFile(page, testFile)
    check('P6b ★ 关闭自动保存后失焦不落盘（开关真的在管这条链路）',
      !!diskAfter2 && !diskAfter2.includes(PROBE_OFF) && diskAfter2 === diskBefore2,
      diskAfter2 === diskBefore2 ? '盘上内容纹丝不动' : '盘上内容被改了')

    // ── P7 无异常 ───────────────────────────────────────────────────
    check('P7 全程无页面级异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
    check('P7b 全程无 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  } finally {
    // 先关浏览器：避免页面在自己关闭时又写一次盘
    await browser.close().catch(() => {})

    if (testFile && testFileBackup !== null) {
      try {
        fs.writeFileSync(testFile, testFileBackup)
        const back = fs.readFileSync(testFile, 'utf8')
        log(`靶子文件已还原: ${testFile} → ${back === testFileBackup ? 'OK' : '内容不一致!'}`)
      } catch (e) {
        console.error(`[verify] 还原靶子文件失败: ${e.message}`)
      }
    }
    // config.json 原样写回（页面跑动期间应用自己写过的东西一并覆盖回备份态）
    fs.writeFileSync(CONFIG_FILE, configBackup)
    log('config.json 已还原为脚本启动时的内容')
  }

  // ── 汇总 ────────────────────────────────────────────────────────
  const failed = results.filter(r => !r.ok)
  console.log('\n──────── 汇总 ────────')
  for (const r of results) console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}`)
  console.log(`\n${results.length - failed.length}/${results.length} 通过；截图目录: ${SHOT_DIR}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('[verify] 脚本异常:', e)
  process.exit(1)
})

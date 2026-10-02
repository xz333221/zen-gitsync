/**
 * 左栏项目列表 ·「从清单移除」（目录不存在那一行的删除按钮）—— 端到端验证。
 *
 * 这条链路守的核心一句话：**按下去，那一行真的消失，而且任务一条都没少。**
 * 它曾经就是坏的 —— 只从常用目录里删掉那一条时，只要还有任务记着这个路径，
 * 项目行会立刻从「任务」那半边被重新生成，用户看到的就是"点了没反应"。
 *
 * 契约：
 *   R1 目录不存在的行：只有一颗按钮，就是「从清单移除」（危险色），没有任何打开动作
 *   R2 点它先弹确认框；框里写清楚项目名，且**必须**说明任务不会被删
 *      （零任务时走短文案 —— 不谎报影响面；"有任务"那一版的措辞从真实 zh 词表里核对）
 *   R3 确认后那一行真的从列表里消失（不是只关了个弹窗）
 *   R4 成功提示把"任务还在"说出来（keptTasks 一并回传就是给这句话用的）
 *   R5 端到端**零任务损失**：tasks.json 的字节内容前后一致（一条任务、一个 job 都不碰）
 *   R6 ⚠️ 本脚本最重要的一条：**把目录重新加回常用目录，那一行必须仍然不出现** ——
 *      它才是"只删常用目录不够、必须有隐藏名单"这条设计的判据。撤掉 hiddenProjects
 *      的过滤，R6 立刻红，而 R3 照样绿（R3 只证明"删掉的那一条不在了"，
 *      证明不了"它不会从任务那半边回来"）。
 *   R7 自愈：把隐藏名单清掉（目录仍在常用目录里）→ 那一行自己回来。
 *      没有这条，用户就得手动改文件才能让一个被克隆回来的项目重新出现。
 *   R8 反向锚：POST 失败时那一行**必须留着**，并弹错误提示 ——
 *      "点了没反应"的另一种死法就是失败也当成功把行刷没了。
 *
 * 为什么用真实后端 + 合成夹具：
 *   这功能一半的价值在服务端（config.json + hidden-projects.json 两份落盘），
 *   桩掉接口就只测了个前端弹窗。夹具用一个**不存在的目录路径**写进常用目录
 *   （POST /api/save_recent_directory），跑完在 finally 里原样清掉；
 *   隐藏名单也整份备份/还原。净副作用为零。
 *
 * 反向验证（把修复撤掉后哪几条会红）：
 *   · hiddenProjects 过滤不生效（只看 config.json 那一份）→ R6 红，R3/R4/R7 仍绿
 *   · 移除按钮的 v-if="exists === false" 去掉 → R1 红（那一行会有 3 颗按钮）
 *   · onRemoveProject 里失败也 refresh(true) → R8 红（行被刷没了）
 *   · 成功提示去掉 keptTasks 那句 → R4 红（任务数对不上时才会露，故 R4 用夹具外的真实项目另测）
 *
 * 前置：dev server 已启动（npm run dev，后端 5545 / 前端 5544）。
 * 用法：ZEN_BASE=http://127.0.0.1:5544 node scripts/verify-wb-project-remove.cjs
 * 退出码：0 全通过，1 有失败项，2 环境没起。
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
// playwright 装在 src/ui/client 下，把它的 node_modules 挂进解析路径，脚本才能独立跑
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const API = process.env.ZEN_API || 'http://127.0.0.1:5545'

/** 夹具：一个**不存在**的目录，名字带 zen-verify- 前缀以免和真实项目撞车 */
const FIXTURE_DIR = 'C:\\__zen-verify-missing-project__'
const FIXTURE_NAME = '__zen-verify-missing-project__'
/** canonicalProjectPath 归一后的形态（Windows 盘符路径会被小写化） */
const FIXTURE_KEY = FIXTURE_DIR.toLowerCase()

const DATA_DIR = path.join(os.homedir(), '.zen-gitsync')
const HIDDEN_FILE = path.join(DATA_DIR, 'hidden-projects.json')
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function waitUntil(fn, timeout = 15000, interval = 200) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true
    await sleep(interval)
  }
  return false
}

const post = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(r => r.json()).catch(e => ({ success: false, error: String(e?.message || e) }))

const getProjects = () => fetch(`${API}/api/workbench/projects`, { cache: 'no-store' })
  .then(r => r.json()).catch(() => null)

/** 隐藏名单整份读回（文件不存在 / 坏掉一律当空名单，与服务端 readHiddenProjects 同口径） */
function readHidden() {
  try {
    const raw = JSON.parse(fs.readFileSync(HIDDEN_FILE, 'utf8').replace(/^\uFEFF/, ''))
    return Array.isArray(raw?.projects) ? raw.projects : []
  } catch { return [] }
}
/** 还原隐藏名单：备份是 null（本来没有这个文件）就把文件删掉，净副作用为零 */
function restoreHidden(backup) {
  if (backup === null) { try { fs.rmSync(HIDDEN_FILE, { force: true }) } catch {} return }
  fs.writeFileSync(HIDDEN_FILE, backup)
}

/** 页面侧观测：项目行（排除「全部项目」那一行）的名字 + 每行的按钮形态 */
const OBS = () => {
  const rows = Array.from(document.querySelectorAll('.proj-item'))
    .filter(n => !n.classList.contains('proj-item--all'))
  return rows.map(n => ({
    name: (n.querySelector('.proj-item__name')?.textContent || '').trim(),
    missing: n.classList.contains('is-missing'),
    hasChip: !!n.querySelector('.proj-chip--missing'),
    actions: Array.from(n.querySelectorAll('.proj-item__action')).map(b => ({
      danger: b.classList.contains('proj-item__action--danger'),
      label: b.getAttribute('title') || '',
    })),
  }))
}

async function enterWorkbench(page) {
  await page.waitForSelector('.activity-bar', { timeout: 25000 })
  for (let i = 0; i < 6; i++) {
    if ((await page.locator('.board').count()) > 0) return true
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click({ timeout: 8000 }).catch(() => {})
    await sleep(900)
  }
  return (await page.locator('.board').count()) > 0
}

async function main() {
  const alive = await fetch(`${API}/api/app-version`).then(r => r.ok).catch(() => false)
  if (!alive) {
    console.error(`后端没起（${API}）—— 先 npm run dev`)
    process.exit(2)
  }

  const hiddenBackup = fs.existsSync(HIDDEN_FILE) ? fs.readFileSync(HIDDEN_FILE, 'utf8') : null
  const tasksBefore = fs.readFileSync(TASKS_FILE, 'utf8')
  const hiddenBefore = readHidden()
  log(`隐藏名单备份: ${hiddenBackup === null ? '(文件不存在)' : hiddenBackup.trim()} | 现有 ${hiddenBefore.length} 条`)

  let browser = null
  try {
    // ── R9：真实数据里那条"有任务的死项目"（源是 tasks 而不是常用目录）────
    // 这是用户真正遇到的形态：目录没了，但 9 条任务还记着这个路径，条目由「任务」
    // 那半边生成 —— 只删常用目录对它**完全无效**。条件跑：本机当前没有这种条目就跳过。
    // 隐藏名单在 finally 里会整份还原，净副作用为零。
    const before9 = await getProjects()
    const dead = (before9?.projects || []).find(p => p.exists === false && (p.stats?.total || 0) > 0)
    if (!dead) {
      log('R9 跳过：当前没有"目录不存在且有任务"的项目条目（夹具外的真实形态）')
    } else {
      log(`R9 目标：${dead.name}（${dead.stats.total} 条任务，source=${dead.source}）`)
      const rm = await post(`${API}/api/workbench/projects/remove`, { path: dead.path })
      check('R9a 任务源条目也能被移除（不只是常用目录那一种）', rm?.success === true, JSON.stringify(rm))
      check('R9b keptTasks 等于该项目名下的任务数（成功提示里那个数字）',
        rm?.keptTasks === dead.stats.total, `keptTasks=${rm?.keptTasks} 期望=${dead.stats.total}`)
      const after9 = await getProjects()
      check('R9c 接口层面已不在清单里', !(after9?.projects || []).some(p => p.key === dead.key))
      check('R9d 它的任务一条没少（还在看板任务里）',
        (after9?.tasks || []).filter(t => String(t.projectPath || '').toLowerCase() === dead.key).length === dead.stats.total,
        `tasks=${(after9?.tasks || []).filter(t => String(t.projectPath || '').toLowerCase() === dead.key).length}`)
      check('R9e tasks.json 字节未变', fs.readFileSync(TASKS_FILE, 'utf8') === tasksBefore)
      // 还原：把刚才这一条从隐藏名单里摘掉 → 它自己回到清单（顺带验证自愈）
      restoreHidden(hiddenBackup)
      const healed9 = await waitUntil(async () => {
        const j = await getProjects()
        return (j?.projects || []).some(p => p.key === dead.key)
      }, 15000)
      check('R9f 把隐藏名单还原后它自己回来了（还原动作有效，不留残留）', healed9)
    }

    // ── 夹具：把不存在的目录写进常用目录 ────────────────────────────
    const saved = await post(`${API}/api/save_recent_directory`, { path: FIXTURE_DIR })
    check('R0a 夹具就绪：合成目录写进常用目录', saved?.success === true, JSON.stringify(saved))

    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
    page.on('pageerror', (e) => pageErrors.push(String(e)))

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    const boardOk = await enterWorkbench(page)
    check('R0b 进入工作台视图', boardOk)

    const obs = () => page.evaluate(OBS)
    const rowOf = (name) => page.locator('.proj-item', { has: page.locator(`.proj-item__name:text-is("${name}")`) }).first()
    const toasts = () => page.locator('.el-message').allTextContents()
    const hasToast = async (t) => (await toasts()).some(s => s.includes(t))
    const clearToasts = async () => {
      await page.evaluate(() => document.querySelectorAll('.el-message').forEach(n => n.remove()))
    }

    const ready = await waitUntil(async () => (await obs()).some(r => r.name === FIXTURE_NAME))
    check('R0c 夹具行渲染出来（目录不存在）', ready,
      `rows=${(await obs()).length} 含夹具=${(await obs()).some(r => r.name === FIXTURE_NAME)}`)
    if (!ready) throw new Error('夹具行没渲染出来，后面全部无从谈起')

    // ── R1：只有一颗按钮，且是危险色的移除 ──────────────────────────
    const fixtureRow = (await obs()).find(r => r.name === FIXTURE_NAME)
    check('R1a 目录不存在的行标着 is-missing + 「目录不存在」', fixtureRow.missing === true && fixtureRow.hasChip === true,
      JSON.stringify({ missing: fixtureRow.missing, chip: fixtureRow.hasChip }))
    check('R1b 只有一颗按钮，且是「从清单移除」',
      fixtureRow.actions.length === 1 && fixtureRow.actions[0].danger === true,
      JSON.stringify(fixtureRow.actions))
    check('R1c 一个打开动作都不给（点了只会报"无法打开目录"）',
      !fixtureRow.actions.some(a => /打开/.test(a.label)), JSON.stringify(fixtureRow.actions))

    // ── R8：POST 失败时必须留着那一行（反向锚，放在真删之前做） ──────
    await page.route('**/api/workbench/projects/remove', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: false, error: '桩：故意失败' }),
    }))
    await clearToasts()
    const row = rowOf(FIXTURE_NAME)
    await row.hover()
    await sleep(250)
    await row.locator('.proj-item__action--danger').click({ timeout: 8000 })
    const box = page.locator('.el-message-box')
    await waitUntil(async () => (await box.count()) === 1, 8000)
    await box.locator('.el-button--primary').click()
    await waitUntil(async () => await hasToast('桩：故意失败'), 8000)
    check('R8a POST 失败时弹错误提示', await hasToast('桩：故意失败'), `toasts=${JSON.stringify(await toasts())}`)
    await sleep(600)
    check('R8b POST 失败时那一行仍在（失败也要当成功刷掉＝另一种"点了没反应"）',
      (await obs()).some(r => r.name === FIXTURE_NAME))
    await page.unroute('**/api/workbench/projects/remove')
    await clearToasts()

    // ── R2/R3/R4：真删 ─────────────────────────────────────────────
    const row2 = rowOf(FIXTURE_NAME)
    await row2.hover()
    await sleep(250)
    await row2.locator('.proj-item__action--danger').click({ timeout: 8000 })
    await waitUntil(async () => (await box.count()) === 1, 8000)
    const boxText = (await box.locator('.el-message-box__message').textContent() || '').replace(/\s+/g, ' ').trim()
    check('R2a 确认框里写明是哪个项目', boxText.includes(FIXTURE_NAME), `msg="${boxText}"`)
    check('R2b 夹具零任务时走短文案：不提"不会被删除"（不谎报影响面）',
      !/不会被删除/.test(boxText) && !/\d+ 条任务/.test(boxText), `msg="${boxText}"`)
    // 短文案在浏览器里验，长文案（有任务那一版）从**真实 zh 词表**里读 ——
    // 夹具是合成目录、名下零任务，凑不出长文案那条分支；而 vitest 里 $t 返回的是 key，
    // 只能证明"选对了 key"，证不了那句中文到底怎么写的（见 lessons/i18n-mock-real-table）。
    const zhTable = (await import(pathToFileURL(path.resolve(__dirname, '../src/ui/client/src/lang/zh/index.js')).href)).default
    const longMsg = zhTable['@WORKBENCH:移除项目「{name}」？会从常用目录和项目列表中去掉它。该项目的 {n} 条任务不会被删除，仍可在「全部项目」下查看。']
    check('R2c 有任务那一版文案写明「任务不会被删除」且带条数',
      typeof longMsg === 'string' && /不会被删除/.test(longMsg) && longMsg.includes('{n}'),
      `zh="${longMsg}"`)

    await clearToasts()
    await box.locator('.el-button--primary').click()
    const gone = await waitUntil(async () => !(await obs()).some(r => r.name === FIXTURE_NAME), 15000)
    check('R3 确认后那一行真的从列表里消失（不是只关了个弹窗）', gone,
      `rows=${JSON.stringify((await obs()).map(r => r.name))}`)
    check('R4a 成功提示说「已移除项目」', await waitUntil(async () => await hasToast('已移除项目'), 8000),
      `toasts=${JSON.stringify(await toasts())}`)

    // 服务端两份落盘都要对：常用目录摘干净 + 隐藏名单记上
    const after = await getProjects()
    const inList = (after?.projects || []).some(p => p.key === FIXTURE_KEY)
    check('R5a 接口层面也不在清单里了', after?.success === true && !inList)
    check('R5b 隐藏名单记下了这个 key', readHidden().includes(FIXTURE_KEY), JSON.stringify(readHidden()))
    check('R5c 端到端零任务损失（tasks.json 字节一致）',
      fs.readFileSync(TASKS_FILE, 'utf8') === tasksBefore)

    // ── R6：重新加回常用目录，那一行**必须仍然不出现** ───────────────
    // 这正是原始 bug 的形态：只删常用目录的话，它会从另一份来源原地复活。
    // 用 reload 而不是等 5s 轮询：轮询没跑到就断言"不在"是假绿，reload 后 DOM 必然等于服务端。
    await post(`${API}/api/save_recent_directory`, { path: FIXTURE_DIR })
    // 夹具自检读 config.json 原文，**不能读 GET /projects** —— 那个接口本身带隐藏过滤，
    // 拿它当"目录回来了"的证据是循环论证（永远看不到，R6 就成了空测）。
    const recents = (() => {
      try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''))
        return Array.isArray(raw?.recentDirectories) ? raw.recentDirectories : []
      } catch { return [] }
    })()
    check('R6a 夹具自检：目录确实又回到常用目录里了', recents.some(d => String(d).toLowerCase() === FIXTURE_KEY),
      `recentDirectories 命中=${recents.filter(d => String(d).toLowerCase() === FIXTURE_KEY).length}`)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await enterWorkbench(page)
    const rowsR6 = await obs()
    // 反向锚：列表得真的加载出来了，否则"没有夹具行"是加载失败换来的假绿
    check('R6b 列表加载正常（不是空列表换来的假绿）', rowsR6.length > 3, `rows=${rowsR6.length}`)
    check('R6c ⚠️ 目录仍在时，重新加回常用目录也不会让它复活（隐藏名单生效）',
      !rowsR6.some(r => r.name === FIXTURE_NAME), `rows=${JSON.stringify(rowsR6.map(r => r.name))}`)

    // ── R7：清掉隐藏名单 → 那一行自己回来（自愈） ───────────────────
    restoreHidden(null)
    const healed = await waitUntil(async () => (await obs()).some(r => r.name === FIXTURE_NAME), 15000)
    check('R7 清掉隐藏名单后那一行自己回来（不做永久隐藏）', healed,
      `rows=${JSON.stringify((await obs()).map(r => r.name))}`)
  } catch (err) {
    check('脚本异常', false, String(err?.message || err))
  } finally {
    // 净副作用为零：夹具目录从常用目录摘掉、隐藏名单还原
    await post(`${API}/api/remove_recent_directory`, { path: FIXTURE_DIR }).catch(() => {})
    restoreHidden(hiddenBackup)
    log(`清理完成：夹具已摘除，隐藏名单还原为 ${hiddenBackup === null ? '(不存在)' : '原内容'}`)
    if (browser) await browser.close().catch(() => {})
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n用例 ${results.length}，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  failed.forEach(f => console.log(`  - ${f.name} ${f.extra}`))
  const real = consoleErrors.filter(e => !/Failed to fetch|获取当前目录失败|404|net::ERR|没有匹配的项目/.test(e))
  console.log(`控制台错误(过滤噪音): ${real.length}`)
  real.slice(0, 8).forEach(e => console.log('  ! ' + e.slice(0, 220)))
  if (pageErrors.length) {
    console.log(`页面异常: ${pageErrors.length}`)
    pageErrors.slice(0, 4).forEach(e => console.log('  ! ' + e.slice(0, 220)))
  }
  log(`合计 ${failed.length === 0 && real.length === 0 && pageErrors.length === 0 ? 'PASS' : 'FAIL'}`)
  process.exit(failed.length ? 1 : 0)
}
main()

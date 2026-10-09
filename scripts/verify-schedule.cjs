/**
 * 定时任务的浏览器验收。
 *
 * 需求（2026-10-09）：智能体视图新增「定时任务」—— 到点自动发起一轮 g ai 对话。
 * 面板负责列表/新建/启停/删除；「对话里让 g ai 创建」走 schedule_task 工具写同一份
 * 任务库，靠 SSE（/api/schedules/events）让面板实时出现新任务。
 *
 * 验收契约：
 *   A1 活动栏「智能体」→ 智能体视图（默认对话 Tab）
 *   A2 切「定时任务」Tab → 面板渲染
 *   A3 ★ UI 表单新建任务：默认值即「每天 09:00」（cron 预览 0 9 * * *）→ 保存后卡片出现、API 落库
 *   A4 ★ SSE 链路：**绕开面板**用 API 创建任务 → 面板不刷新也自动出现（对话工具走同一条链路）
 *   A5 开关切换 → 服务端落库 enabled=false，卡片同步显示「已停用」
 *   A6 删除要过确认弹窗 → 确认后卡片消失、API 清理干净
 *   R1 反向对照：确认弹窗点「取消」→ 卡片还在（防"点删除就无脑删"）
 *   R2 全程无 page error
 *
 * 会真实写任务库（~/.zen-gitsync/schedules.json）：所有测试任务用 `verify-` 前缀，
 * finally 里按 id 清理。**不触发真实执行**（那会烧 token），执行逻辑由 scheduler.test.js
 * 的假 runTurn 覆盖。
 *
 * 前置：dev server 已启动（vite 5544 + 后端 5545；先 `npm run dev:ping` 两个 OK）。
 * 用法：node scripts/verify-schedule.cjs
 * 退出码：0 全通过，1 有失败项，2 脚本异常。
 */
const os = require('node:os')
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const API = BASE
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'zen-schedule')

const results = []
const pageErrors = []
const consoleErrors = []
const skips = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
function skip(name, why) {
  skips.push({ name, why })
  console.log(`  SKIP  ${name}  :: ${why}`)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function waitFor(fn, timeout = 10000, step = 150) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 > timeout) return false
    await sleep(step)
  }
}

const api = {
  async tasks() {
    const r = await fetch(`${API}/api/schedules`)
    return (await r.json()).tasks || []
  },
  async create(body) {
    const r = await fetch(`${API}/api/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return (await r.json()).task
  },
  async remove(id) {
    await fetch(`${API}/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
  },
}

async function main() {
  const created = [] // 本脚本创建的任务 id，finally 里清理

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  try {
    // ── A0 前置：服务可达 + 拿到当前项目目录 ─────────────────────────
    const cwdRes = await fetch(`${API}/api/current_directory`).then(r => r.json()).catch(() => ({}))
    const cwd = cwdRes.directory || ''
    check('A0 前后端可达且拿到当前项目目录', !!cwd, cwd)
    if (!cwd) { console.error('[verify] 拿不到当前目录，无法继续'); process.exit(2) }

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    // 首屏可能正赶上 vite 重打包（空 RootWebArea），重载一次再判
    await page.waitForSelector('.activity-bar', { timeout: 30000 }).catch(async () => {
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.activity-bar', { timeout: 30000 })
    })

    // ── A1 智能体视图 ────────────────────────────────────────────
    await page.click('.activity-bar [aria-label*="智能体"]')
    await page.waitForSelector('.agent-view', { timeout: 15000 })
    check('A1 活动栏进入智能体视图', true)

    // ── A2 定时任务 Tab ──────────────────────────────────────────
    await page.click('.agent-tab:has-text("定时任务")')
    await page.waitForSelector('.schedule-panel', { timeout: 10000 })
    const tabActive = await page.locator('.agent-tab.active:has-text("定时任务")').count()
    check('A2 切「定时任务」Tab 渲染面板且高亮', tabActive === 1)

    // ── A3 UI 表单新建 ───────────────────────────────────────────
    const name1 = `verify-临时-${Date.now().toString(36)}`
    await page.click('.schedule-panel button:has-text("新建任务")')
    await page.waitForSelector('.schedule-dialog:visible', { timeout: 10000 })
    await page.fill('.schedule-dialog .sch-field:has-text("任务名") input', name1)
    await page.fill('.schedule-dialog .sch-field:has-text("提示词") textarea', '探针创建的任务，马上会被删掉')
    const cronHint = (await page.textContent('.schedule-dialog .sch-hint')) || ''
    check('A3a 新建表单默认值即「每天 09:00」（cron 预览 0 9 * * *）', cronHint.includes('0 9 * * *'), cronHint.trim())

    await page.click('.schedule-dialog .sch-form-footer .sch-btn-primary')
    const cardShown = await waitFor(async () =>
      (await page.locator(`.schedule-card:has-text("${name1}")`).count()) > 0, 10000)
    check('A3b 保存后卡片出现在列表', cardShown)

    const tasksAfterCreate = await api.tasks()
    const t1 = tasksAfterCreate.find(t => t.name === name1)
    if (t1) created.push(t1.id)
    check('A3c 任务真的落库（API 可查、nextRunAt 已算）', !!t1,
      t1 ? `id=${t1.id} nextRunAt=${t1.nextRunAt}` : 'API 里找不到刚建的任务')

    // ── A4 ★ SSE：API 侧创建 → 面板无刷新自动出现 ─────────────────
    const name2 = `verify-SSE-${Date.now().toString(36)}`
    const t2 = await api.create({ name: name2, schedule: '*/30 * * * *', cwd, prompt: 'SSE 链路验证' })
    if (t2?.id) created.push(t2.id)
    const appeared = await waitFor(async () =>
      (await page.locator(`.schedule-card:has-text("${name2}")`).count()) > 0, 10000)
    check('A4 ★ SSE：外部创建的任务无需刷新即出现在面板（对话工具同链路）', appeared)
    if (appeared) {
      const desc = (await page.textContent(`.schedule-card:has-text("${name2}") .schedule-desc`)) || ''
      check('A4b 「每 30 分钟」计划描述渲染正确', /每 30 分钟/.test(desc), desc.trim())
    }

    // ── A5 开关切换持久化 ────────────────────────────────────────
    await page.click(`.schedule-card:has-text("${name1}") .sch-switch`)
    const offOk = await waitFor(async () => {
      const list = await api.tasks()
      return list.find(t => t.id === t1?.id)?.enabled === false
    }, 8000)
    check('A5 开关切换 → 服务端 enabled=false', offOk)
    if (t1) {
      const nextTxt = (await page.textContent(`.schedule-card:has-text("${name1}") .schedule-next`)) || ''
      check('A5b 停用后卡片同步显示「已停用」', /已停用/.test(nextTxt), nextTxt.trim())
    }

    // ── A6 删除确认（含 R1 反向对照）────────────────────────────
    await page.click(`.schedule-card:has-text("${name1}") .sch-btn-danger`)
    await page.waitForSelector('.schedule-dialog-confirm:visible', { timeout: 10000 })
    await page.click('.schedule-dialog-confirm button:has-text("取消")')
    await sleep(500)
    check('R1 反向对照：确认弹窗点「取消」→ 卡片仍在', (await page.locator(`.schedule-card:has-text("${name1}")`).count()) === 1)

    await page.click(`.schedule-card:has-text("${name1}") .sch-btn-danger`)
    await page.waitForSelector('.schedule-dialog-confirm:visible', { timeout: 10000 })
    await page.click('.schedule-dialog-confirm .sch-btn-danger')
    const gone = await waitFor(async () =>
      (await page.locator(`.schedule-card:has-text("${name1}")`).count()) === 0, 8000)
    check('A6 确认删除后卡片消失', gone)
    if (t1) {
      const stillThere = (await api.tasks()).some(t => t.id === t1.id)
      check('A6b API 侧同步删除', !stillThere)
    }

    // 等弹窗关闭动画收尾再截图（否则截到"半透明残影"，会被误读成布局 bug）
    await sleep(500)
    await page.screenshot({ path: path.join(SHOT_DIR, 'panel.png') }).catch(() => {})
    check('R2 无页面级异常（pageerror）', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ').slice(0, 200))
  } catch (err) {
    check('脚本异常', false, String((err && err.message) || err))
  } finally {
    for (const id of created) await api.remove(id)
    await browser.close().catch(() => {})
  }

  const failed = results.filter(r => !r.ok)
  console.log('\n[verify] 截图目录:', SHOT_DIR)
  console.log(`[verify] 结果: ${results.length - failed.length}/${results.length} 通过${skips.length ? `，跳过 ${skips.length} 项` : ''}`)
  failed.forEach(f => console.log(`  - ${f.name} ${f.extra}`))
  const noisy = consoleErrors.filter(e => !/favicon|ResizeObserver|DevTools|Failed to fetch/i.test(e))
  if (noisy.length) console.log('[verify] console errors:', noisy.slice(0, 5))
  if (pageErrors.length) console.log('[verify] page errors:', pageErrors.slice(0, 5))
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('[verify] 脚本异常:', e)
  process.exit(2)
})

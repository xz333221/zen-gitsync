/**
 * 派发默认提示词（全局 / 各项目）的验证。
 *
 * 验收契约（改这块时别破坏）：
 *   A 一条提示词都没设过时，控制台**不出现**"默认提示词"勾选 ——
 *     一个永远勾着、点了没区别的开关只是占地方
 *   B 在弹窗里存下全局提示词 -> 勾选出现且标为「全局」
 *   C 选中具体项目再存项目提示词 -> 标为「全局 + 本项目」
 *   D 派发请求体带 useDefaultPrompt=true；取消勾选后为 false（本次不带）
 *   E 服务端按**落点项目**解析：任务 simpleOverride = 全局 + 空行 + 项目，
 *     指令流水里 promptSource=both（回答"这段话是谁加的"）
 *   F 活动流 UI 真的把「附带全局 + 项目默认提示词」渲染出来
 *   G 选中「全部项目」时弹窗里的项目栏禁用（落点未定，不给设）
 *   H 无 JS 运行时异常 / 控制台错误
 *
 * 前置：dev server 已启动（后端 5545 / 前端 5544）。
 * ⚠️ 脚本会临时写入提示词，结束时**恢复原值** —— 跑完不该在用户数据里留下任何痕迹。
 * 用法：node scripts/verify-workbench-default-prompt.cjs
 * 退出码：0 全通过，1 有失败项，2 环境没起。
 */
const path = require('node:path')

// playwright 装在 src/ui/client 下，把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544'
const API = process.env.ZEN_API || 'http://127.0.0.1:5545'
const MARK = Date.now().toString().slice(-6)
const GLOBAL_TEXT = `【全局提示词验证${MARK}】回答用中文`
const PROJECT_TEXT = `【项目提示词验证${MARK}】包管理器用 pnpm`
const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 归一化项目路径：与前端 canonicalProjectPath 的判据无关，只用来比对"是不是同一个目录" */
const samey = (a, b) => String(a || '').replace(/\//g, '\\').toLowerCase()
  === String(b || '').replace(/\//g, '\\').toLowerCase()

const post = (url, body) => fetch(`${API}${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(r => r.json()).catch(() => null)

const readOrchestrator = () => fetch(`${API}/api/workbench/orchestrator`, { cache: 'no-store' })
  .then(r => r.json()).catch(() => null)

/**
 * 起一个能用的浏览器。
 *
 * 优先用 playwright 自带的 chromium；没装（或版本对不上要重新下载 150MB）就退到
 * 系统里的 Edge / Chrome —— verify 脚本的价值在断言，"少下一个浏览器"不该让整套
 * 验证跑不起来。
 */
async function launchBrowser() {
  const attempts = [
    ['chromium', {}],
    ['msedge', { channel: 'msedge' }],
    ['chrome', { channel: 'chrome' }],
  ]
  const errors = []
  for (const [name, opts] of attempts) {
    try {
      const b = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...opts })
      log('浏览器:', name)
      return b
    } catch (e) {
      errors.push(`${name}: ${String(e.message || e).split('\n')[0]}`)
    }
  }
  throw new Error('没有可用的浏览器:\n  ' + errors.join('\n  '))
}

async function main() {
  const snapshot = await readOrchestrator()
  if (!snapshot?.success) { console.error('读不到编排状态，dev server 起了吗？'); process.exit(2) }

  const projectsRes = await fetch(`${API}/api/workbench/projects`, { cache: 'no-store' })
    .then(r => r.json()).catch(() => null)
  const projects = projectsRes?.projects || []
  // 选一个目录真实存在的项目来挂项目提示词：目录没了服务端仍会存，
  // 但那种项目不该出现在这条链路的验证里
  const target = projects.find(p => p.exists !== false)
  if (!target) { console.error('没有任何可用项目，先在工作台里注册一个'); process.exit(2) }
  log('待测项目:', target.name, target.path)
  log('原状态: 全局提示词 =', JSON.stringify(snapshot.defaultPrompt || ''), '项目提示词条目 =', Object.keys(snapshot.projectPrompts || {}).length)

  // 从"一条都没有"起跑，A 组才成立。
  // 这一步刻意放在浏览器起得来**之后**（见下面的 try）：浏览器没装 / 起不来的话，
  // 脚本一行用户数据都不该动 —— 环境问题不该留下被清空的设置。

  const browser = await launchBrowser()
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  /** 最近一次派发请求体 —— D 组用它确认"这次带不带"真的传给了服务端 */
  let lastDispatch = null
  /** 这一轮真建出来的任务，收尾时串行删掉 */
  const createdTaskIds = []

  /** 读控制台里"默认提示词"那个勾选的文案与勾选态 */
  const readPromptToggle = () => page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.oc__compose-foot .oc__autorn'))
      .find(l => l.textContent.includes('默认提示词'))
    if (!el) return null
    const input = el.querySelector('input')
    return { text: el.textContent.trim(), checked: !!input && input.checked }
  })

  try {
    // 起点：两级提示词都清空（跑完在 finally 里按快照恢复）
    await post('/api/workbench/orchestrator/default-prompt', { prompt: '' })
    await post('/api/workbench/orchestrator/project-prompt', { projectPath: target.path, prompt: '' })

    // 派发一律拦下来看 body，绝不真发（真派发留给 E 组走 API，autoRun=false）
    await page.route('**/api/workbench/orchestrator/dispatch', async (route) => {
      try { lastDispatch = JSON.parse(route.request().postData() || '{}') } catch { lastDispatch = {} }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, ran: false, task: { id: 'verify-fake', title: 'verify' } }),
      })
    })

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.board', { timeout: 15000 })
    await sleep(2500)

    // ── A 一条都没设过：入口在，勾选不在 ─────────────────────────────
    await page.locator('.proj-item--all').first().click()
    await sleep(900)
    const entry = page.locator('[aria-label="默认提示词设置"]')
    check('A1 控制台有「默认提示词设置」入口', await entry.count() === 1,
      `count=${await entry.count()}`)
    check('A2 没设过提示词时不出现"默认提示词"勾选', (await readPromptToggle()) === null,
      JSON.stringify(await readPromptToggle()))

    // ── B 弹窗里存全局提示词 ────────────────────────────────────────
    await entry.click()
    await page.waitForSelector('.pd', { state: 'visible', timeout: 5000 })
    check('B1 弹窗里两个输入框都在（全局 / 项目）',
      await page.locator('#pd-global').count() === 1 && await page.locator('#pd-project').count() === 1)
    check('B2 选中「全部项目」时项目栏禁用（G 组同判据）',
      await page.locator('#pd-project').isDisabled())
    await page.fill('#pd-global', GLOBAL_TEXT)
    await page.locator('.pd__btn--primary').click()
    await page.waitForSelector('.pd', { state: 'hidden', timeout: 8000 })
    const afterGlobal = await readPromptToggle()
    check('B3 存下全局后勾选出现且标为「全局」',
      !!afterGlobal && afterGlobal.checked && /（全局）/.test(afterGlobal.text),
      JSON.stringify(afterGlobal))
    const stored1 = await readOrchestrator()
    check('B4 全局提示词真的落到服务端', stored1.defaultPrompt === GLOBAL_TEXT,
      JSON.stringify(stored1.defaultPrompt))

    // ── C 选中具体项目，再存项目提示词 ──────────────────────────────
    await page.locator('.proj-item:not(.proj-item--all)').filter({ hasText: target.name }).first().click()
    await sleep(900)
    await page.locator('[aria-label="默认提示词设置"]').click()
    await page.waitForSelector('.pd', { state: 'visible', timeout: 5000 })
    check('C1 选中具体项目后项目栏可编辑', !(await page.locator('#pd-project').isDisabled()))
    check('C2 项目栏标题带出项目名',
      (await page.locator('label[for="pd-project"]').textContent() || '').includes(target.name),
      (await page.locator('label[for="pd-project"]').textContent() || '').trim())
    await page.fill('#pd-project', PROJECT_TEXT)
    await page.locator('.pd__btn--primary').click()
    await page.waitForSelector('.pd', { state: 'hidden', timeout: 8000 })
    const afterProject = await readPromptToggle()
    check('C3 两级都设了之后标为「全局 + 本项目」',
      !!afterProject && /（全局 \+ 本项目）/.test(afterProject.text),
      JSON.stringify(afterProject))

    // ── D 这次带不带：请求体里如实传 ────────────────────────────────
    // 每次点派发前都要重新填：send() 成功后会清空草稿，输入框空了按钮就是禁用的
    await page.fill('.oc__input', '随便改点什么')
    await sleep(200)
    await page.locator('.oc__send').click()
    await sleep(900)
    check('D1 默认附加：请求体 useDefaultPrompt=true',
      lastDispatch?.useDefaultPrompt === true, JSON.stringify(lastDispatch?.useDefaultPrompt))
    await page.locator('.oc__autorn').filter({ hasText: '默认提示词' }).locator('input').uncheck()
    await sleep(200)
    await page.fill('.oc__input', '随便改点什么')
    await sleep(200)
    await page.locator('.oc__send').click()
    await sleep(900)
    check('D2 取消勾选后：请求体 useDefaultPrompt=false',
      lastDispatch?.useDefaultPrompt === false, JSON.stringify(lastDispatch?.useDefaultPrompt))
    await page.locator('.oc__autorn').filter({ hasText: '默认提示词' }).locator('input').check()
    await sleep(200)

    // ── E 服务端按落点项目解析（真打接口，autoRun=false 只建任务）────
    const dispatched = await post('/api/workbench/orchestrator/dispatch', {
      text: `【默认提示词验证${MARK}】这条指令必须带上默认提示词`,
      projectPath: target.path,
      autoRun: false,
    })
    if (dispatched?.success && dispatched.task?.id) createdTaskIds.push(dispatched.task.id)
    check('E1 任务把两级提示词都抄了下来（全局在前、项目在后）',
      dispatched?.task?.simpleOverride === `${GLOBAL_TEXT}\n\n${PROJECT_TEXT}`,
      JSON.stringify(dispatched?.task?.simpleOverride))
    check('E2 指令正文不被污染（desc 仍是用户敲的那句话）',
      dispatched?.task?.desc === `【默认提示词验证${MARK}】这条指令必须带上默认提示词`,
      JSON.stringify(dispatched?.task?.desc))
    check('E3 流水里记下提示词来源 both',
      dispatched?.instruction?.promptSource === 'both',
      JSON.stringify(dispatched?.instruction?.promptSource))

    // 别的项目不该被带上本项目那条
    const other = (await readOrchestrator()).projectPrompts || {}
    const projectKeys = Object.keys(other)
    check('E4 项目提示词只挂在被测项目这一个 key 上',
      projectKeys.length === 1 && samey(projectKeys[0], target.path),
      JSON.stringify(projectKeys))

    // ── F 活动流 UI ────────────────────────────────────────────────
    await sleep(6500) // 等看板这一轮轮询把新指令拉回活动流
    const notes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.oc-row__note')).map(e => e.textContent.trim()))
    check('F1 活动流渲染出「附带全局 + 项目默认提示词」',
      notes.some(t => t.includes('附带全局 + 项目默认提示词')),
      JSON.stringify(notes.slice(0, 4)))

    // ── G 「全部项目」下项目栏禁用 ──────────────────────────────────
    await page.locator('.proj-item--all').first().click()
    await sleep(900)
    await page.locator('[aria-label="默认提示词设置"]').click()
    await page.waitForSelector('.pd', { state: 'visible', timeout: 5000 })
    check('G1 切回「全部项目」后项目栏禁用', await page.locator('#pd-project').isDisabled())
    check('G2 全局栏仍可编辑（全局与选中无关）', !(await page.locator('#pd-global').isDisabled()))
    await page.locator('.pd__btn:not(.pd__btn--primary)').click()
    await page.waitForSelector('.pd', { state: 'hidden', timeout: 8000 })

    check('H1 无 JS 运行时异常', pageErrors.length === 0, pageErrors.join(' | '))
    const badConsole = consoleErrors.filter(t => !/favicon|ResizeObserver/i.test(t))
    check('H2 无控制台错误', badConsole.length === 0, badConsole.slice(0, 3).join(' | '))
  } finally {
    await browser.close()

    // 恢复原状态：先清掉这一轮写进去的，再把快照里的值写回去
    await post('/api/workbench/orchestrator/default-prompt', { prompt: snapshot.defaultPrompt || '' })
    const snapProject = (snapshot.projectPrompts || {})[Object.keys(snapshot.projectPrompts || {})
      .find(k => samey(k, target.path)) || '']
    await post('/api/workbench/orchestrator/project-prompt', {
      projectPath: target.path,
      prompt: snapProject?.prompt || '',
    })
    // ⚠️ 必须**串行**删：DELETE 是"读 tasks.json → 过滤 → 写回"，并发会互相覆盖
    for (const id of createdTaskIds) {
      try {
        await fetch(`${API}/api/workbench/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })
      } catch { /* 清理失败不该盖住断言结果 */ }
    }
    if (createdTaskIds.length) log('已清理测试任务:', createdTaskIds.join(', '))
    const restored = await readOrchestrator()
    log('已恢复: 全局 =', JSON.stringify(restored.defaultPrompt || ''),
      '项目条目 =', Object.keys(restored.projectPrompts || {}).length)
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n[verify] ${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) {
    console.log('[verify] 失败项:')
    for (const f of failed) console.log(`   - ${f.name}${f.extra ? '  :: ' + f.extra : ''}`)
  }
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })

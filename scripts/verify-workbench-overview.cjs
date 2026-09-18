/**
 * 工作台右栏「项目概览」跟随选中项 + 「指令落点」判断链路的验证。
 *
 * 验收契约（改这块时别破坏）：
 *   A 选中「全部项目」-> 概览不得展示任何单个项目（显示「全部项目」），单项目 Git 指标不渲染
 *   B 选中具体项目     -> 概览展示该项目名 + Git 指标
 *   C 具体项目 -> 切回「全部项目」-> 概览必须跟着退回
 *     ⚠️ 回归点 1：概览曾与派发目标共用同一个回落值，切过去之后面板纹丝不动，
 *        看起来像没切成功。
 *   D 「全部项目」下前端**不猜落点**：底部提示只说明"由主 Agent 判断"，
 *     不写死任何项目名；派发请求体里 projectPath 留空
 *   E 落点由服务端判断：指令里点名 -> 精确落到它（mention）；
 *     没点名 -> 落到一个真实存在的项目（agent / default），绝不落到不存在的地方
 *     ⚠️ 回归点 2：前端曾经自己算一个回落值再传给服务端，于是"界面说的落点"
 *        和"真正执行的落点"可以各说各话。
 *
 * 前置：dev server 已启动（npm run dev，后端 5545 / 前端 5544）。
 * 用法：node scripts/verify-workbench-overview.cjs
 * 退出码：0 全通过，1 有失败项。
 */
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544'
const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * 「今日完成 / 最后活跃」是全局指标，任何选中态下都会渲染，不算"单项目 Git 指标"。
 * 其余（分支 / 工作区 / …）才由 gitSummary 产出，只在选中具体项目时出现。
 */
const GLOBAL_GIT_LABELS = ['今日完成', '最后活跃']
const projectScopedLabels = (labels) => labels.filter(l => !GLOBAL_GIT_LABELS.includes(l))

const post = (url, body) => fetch(`${BASE}${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(r => r.json()).catch(() => null)

/** 一次读全右栏状态，避免多次 evaluate 之间被轮询刷掉中间态 */
async function readConsole(page) {
  return page.evaluate(() => {
    const nameEl = document.querySelector('.oc__git-name')
    return {
      // 概览标题后的项目名（无选中项目时按契约应显示「全部项目」）
      name: nameEl ? nameEl.textContent.trim() : null,
      // Git 指标行的 label 列表（全部项目下应只剩全局那两条）
      gitLabels: Array.from(document.querySelectorAll('.oc__git-list .oc__git-label'))
        .map(e => e.textContent.trim()),
      hint: document.querySelector('.oc__hint')?.textContent?.trim() || '',
      // 不该再有任何"选目标"的控件
      hasTargetPicker: !!document.querySelector('.oc__target'),
      activeProject: document.querySelector(
        '.proj-item:not(.proj-item--all).is-active .proj-item__name'
      )?.textContent?.trim() || null,
      allActive: !!document.querySelector('.proj-item--all.is-active'),
      boardTitle: document.querySelector('.board__project-name')?.textContent?.trim() || null,
    }
  })
}

async function main() {
  // 应用当前项目（L2 里打开的那个）
  const res = await fetch(`${BASE}/api/workbench/projects`, { cache: 'no-store' })
    .then(r => r.json()).catch(() => null)
  if (!res?.success) { console.error('无法读取项目列表，dev server 起了吗？', res); process.exit(2) }
  const curKey = res.currentProjectPath || ''
  const curProject = (res.projects || []).find(p => p.key === curKey)
    || (res.projects || []).find(p => p.key === String(curKey).replace(/\\/g, '/'))
  const curName = curProject?.name || ''
  const someProject = (res.projects || []).find(p => p.exists !== false) || (res.projects || [])[0]
  log('应用当前项目:', curName || '(无)', '| 待选具体项目:', someProject?.name || '(无)')
  if (!someProject) { console.error('没有任何项目可测，先在工作台里注册一个项目'); process.exit(2) }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  /** 最近一次派发请求的 body —— E 组用它确认前端没有自己猜落点 */
  let lastDispatch = null
  /** 这一轮派发出来的任务，收尾时串行删掉 */
  const createdTaskIds = []

  try {
    // 派发只拦下来看 body，绝不真建任务（真派发留给下面 F 组走 API，autoRun=false）
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

    // ── A 先落到「全部项目」──────────────────────────────────────────
    await page.locator('.proj-item--all').first().click()
    await sleep(900)
    const all = await readConsole(page)
    log('全部项目 ->', JSON.stringify(all))
    check('A1 左栏「全部项目」处于选中态', all.allActive)
    check('A2 中间看板标题为「全部项目」', all.boardTitle === '全部项目', `boardTitle="${all.boardTitle}"`)
    check('A3 概览不展示任何单个项目', all.name === '全部项目', `name="${all.name}"`)
    check('A4 概览不渲染单项目 Git 指标', projectScopedLabels(all.gitLabels).length === 0,
      `labels=[${all.gitLabels.join(', ')}]`)

    // ── B 选中具体项目 -> 概览跟随 ───────────────────────────────────
    await page.locator(`.proj-item:not(.proj-item--all)`).filter({ hasText: someProject.name }).first().click()
    await sleep(900)
    const one = await readConsole(page)
    log('具体项目 ->', JSON.stringify(one))
    check('B1 概览展示选中的项目名', one.name === someProject.name,
      `name="${one.name}" 期望="${someProject.name}"`)
    check('B2 概览渲染出 Git 指标行', one.gitLabels.length > 0, `labels=[${one.gitLabels.join(', ')}]`)
    check('B3 中间看板标题同步为该名称', one.boardTitle === someProject.name,
      `boardTitle="${one.boardTitle}"`)

    // ── C 切回「全部项目」-> 概览必须退回（回归点 1）──────────────────
    await page.locator('.proj-item--all').first().click()
    await sleep(900)
    const back = await readConsole(page)
    log('切回全部项目 ->', JSON.stringify(back))
    check('C1 概览退回「全部项目」，不再显示上一个项目', back.name === '全部项目', `name="${back.name}"`)
    check('C2 概览没有残留上一个项目名', back.name !== someProject.name)
    check('C3 概览没有回落到应用当前项目（旧 bug 复现点）', back.name !== curName || !curName,
      `name="${back.name}" 应用当前项目="${curName}"`)
    check('C4 单项目 Git 指标行已清空', projectScopedLabels(back.gitLabels).length === 0,
      `labels=[${back.gitLabels.join(', ')}]`)

    // ── D 「全部项目」下前端不猜落点 ─────────────────────────────────
    check('D1 不再有任何"选目标"控件', !back.hasTargetPicker)
    check('D2 提示只说明由主 Agent 判断，不写死项目名',
      /主 Agent/.test(back.hint) && !back.hint.includes(someProject.name),
      `hint="${back.hint}"`)

    await page.fill('.oc__input', '随便改点什么')
    await sleep(200)
    await page.locator('.oc__send').click()
    await sleep(1000)
    check('D3 派发请求里 projectPath 留空（前端不猜）',
      !!lastDispatch && lastDispatch.projectPath === '',
      `projectPath="${lastDispatch?.projectPath}"`)
    await page.fill('.oc__input', '')

    // ── E 落点由服务端判断（真打接口，autoRun=false 只建任务）────────
    const named = await post('/api/workbench/orchestrator/dispatch', {
      text: `给 ${someProject.name} 加个导出进度条`,
      autoRun: false,
    })
    if (named?.success && named.task?.id) createdTaskIds.push(named.task.id)
    check('E1 指令里点名 -> 精确落到它（mention）',
      named?.target?.source === 'mention' && named?.target?.name === someProject.name,
      `source="${named?.target?.source}" name="${named?.target?.name}" 期望="${someProject.name}"`)
    check('E2 任务真的建在那个项目下',
      !!named?.task && named.task.projectPath === named.target.path,
      `task.projectPath="${named?.task?.projectPath}" target.path="${named?.target?.path}"`)

    const vague = await post('/api/workbench/orchestrator/dispatch', {
      text: '把登录模块的错误处理重构一遍',
      autoRun: false,
    })
    if (vague?.success && vague.task?.id) createdTaskIds.push(vague.task.id)
    check('E3 没点名 -> 落点非空且来源合法（agent / default）',
      !!vague?.target?.path && ['agent', 'default'].includes(vague?.target?.source),
      `source="${vague?.target?.source}" path="${vague?.target?.path}"`)
    // E4 的判据刻意**不**复用 canonicalProjectPath 的规则，只做"同不同一个目录"的
    // 宽松比较。理由：脚本里再抄一份归一规则 = 又一处会随产品口径漂移的地方 ——
    // 抄的那份是旧规则（只转盘符），产品改成"转小写 + 斜杠归一"之后这里就误报红了，
    // 而落点其实是清单里真有的目录。断言要守的是"没凭空造目录"，不是"key 长什么样"。
    const samey = (a, b) => String(a || '').replace(/\//g, '\\').toLowerCase()
      === String(b || '').replace(/\//g, '\\').toLowerCase()
    check('E4 落到的是清单里真实存在的目录',
      (res.projects || []).some(p => samey(p.path, vague?.target?.path) || samey(p.key, vague?.target?.path)),
      `path="${vague?.target?.path}"`)

    // 落点要能在这条指令的流水里看到 —— 判断错了才有迹可循
    const feed = await fetch(`${BASE}/api/workbench/orchestrator`, { cache: 'no-store' })
      .then(r => r.json()).catch(() => null)
    const row = (feed?.activity || []).find(a => a.instructionId === named?.instruction?.id)
    check('E5 活动流里带出落点与来源',
      !!row && row.projectName === someProject.name && row.targetSource === 'mention',
      row ? `projectName="${row.projectName}" targetSource="${row.targetSource}"` : '找不到该指令的活动行')

    // UI 层单独看一眼：接口字段对了，不代表组件真的把它渲染出来了
    await sleep(6000) // 等看板这一轮轮询把新指令拉回活动流
    const notes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.oc-row__note')).map(e => e.textContent.trim()))
    check('E6 活动流 UI 里渲染出「落点「…」· 依据」',
      notes.some(t => t.includes('落点「') && t.includes('指令里提到了它')),
      `notes=${JSON.stringify(notes.slice(0, 3))}`)

    check('F 无 JS 运行时异常', pageErrors.length === 0, pageErrors.join(' | '))
    const badConsole = consoleErrors.filter(t => !/favicon|ResizeObserver/i.test(t))
    check('F2 无控制台错误', badConsole.length === 0, badConsole.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    // ⚠️ 必须**串行**删：DELETE 是"读 tasks.json → 过滤 → 写回"，并发会互相覆盖
    for (const id of createdTaskIds) {
      try {
        await fetch(`${BASE}/api/workbench/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })
      } catch { /* 清理失败不该盖住断言结果 */ }
    }
    if (createdTaskIds.length) log('已清理测试任务:', createdTaskIds.join(', '))
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

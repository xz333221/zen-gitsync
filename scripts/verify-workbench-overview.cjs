/**
 * 工作台右栏「项目概览 / 派发目标」跟随左侧选中项的验证。
 *
 * 验收契约（改这块时别破坏）：
 *   A 选中「全部项目」-> 概览不得展示任何单个项目（显示「全部项目」），单项目 Git 指标不渲染
 *   B 选中具体项目     -> 概览展示该项目名 + Git 指标
 *   C 具体项目 -> 切回「全部项目」-> 概览必须跟着退回
 *     ⚠️ 回归点 1：概览曾与派发目标共用同一个回落值，切到「全部项目」后那块面板
 *        纹丝不动，看起来像没切成功。
 *   D 请「回到底部提示」：选中「全部项目」时，派发目标必须是**显式下拉**
 *     （默认 = 应用当前项目，可改），而不是悄悄回落到某个项目还把名字写死在提示里
 *   E 下拉显示的落点 == 实际发出去的 projectPath（提示和落点不能各说各话）
 *
 * 前置：dev server 已启动（npm run dev，前端 5544）。
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

/**
 * 伪造第二个项目给目标下拉用。真实 home 里不少项目的目录早就不在了
 * （exists:false，不进下拉），不造一个就没法测"切换目标"。
 * 走 route 拦截，**不碰真实 config**。
 */
const FAKE = { name: 'FakeProject', path: '/tmp/zen-fake-project' }

/** 一次读全右栏状态，避免多次 evaluate 之间被轮询刷掉中间态 */
async function readConsole(page) {
  return page.evaluate(() => {
    const nameEl = document.querySelector('.oc__git-name')
    const sel = document.querySelector('.oc__target')
    return {
      // 概览标题后的项目名（无选中项目时按契约应显示「全部项目」）
      name: nameEl ? nameEl.textContent.trim() : null,
      // Git 指标行的 label 列表（全部项目下应只剩全局那两条）
      gitLabels: Array.from(document.querySelectorAll('.oc__git-list .oc__git-label'))
        .map(e => e.textContent.trim()),
      // 底部提示（有下拉时是多段文本拼起来的）
      hint: document.querySelector('.oc__hint')?.textContent?.trim() || '',
      // 目标下拉：存在性 / 当前值 / 选项
      hasTargetPicker: !!sel,
      targetValue: sel ? sel.value : null,
      targetLabel: sel ? (sel.selectedOptions[0]?.textContent || '').trim() : null,
      targetOptions: sel ? Array.from(sel.options).map(o => ({ v: o.value, t: o.textContent.trim() })) : [],
      // 左栏当前高亮的具体项目名（全部项目时为空）
      activeProject: document.querySelector(
        '.proj-item:not(.proj-item--all).is-active .proj-item__name'
      )?.textContent?.trim() || null,
      allActive: !!document.querySelector('.proj-item--all.is-active'),
      // 中间看板标题，用来交叉确认选中态确实切过去了
      boardTitle: document.querySelector('.board__project-name')?.textContent?.trim() || null,
    }
  })
}

async function main() {
  // 应用当前项目（L2 里打开的那个）—— D2 / E3 断言的基准
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

  /** 最近一次派发请求的 body —— E3 用它比对"提示显示的落点"和"真正发出去的落点" */
  let lastDispatch = null

  try {
    // 造第二个可选项目（只改响应，不落盘）
    await page.route('**/api/workbench/projects', async (route) => {
      const r = await route.fetch()
      const json = await r.json().catch(() => null)
      if (json?.success && Array.isArray(json.projects) && json.projects.length) {
        json.projects = [...json.projects, {
          ...json.projects[0],
          key: FAKE.path, name: FAKE.name, path: FAKE.path, exists: true, isCurrent: false,
        }]
      }
      await route.fulfill({ response: r, json })
    })
    // 派发只拦下来看 body，绝不真建任务
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
    log('全部项目 ->', JSON.stringify({ ...all, targetOptions: all.targetOptions.length }))
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
    log('切回全部项目 ->', JSON.stringify({ ...back, targetOptions: back.targetOptions.length }))
    check('C1 概览退回「全部项目」，不再显示上一个项目', back.name === '全部项目', `name="${back.name}"`)
    check('C2 概览没有残留上一个项目名', back.name !== someProject.name)
    // 直接对应旧 bug：旧实现回落到"应用当前项目"，这一条在修复前必然红
    check('C3 概览没有回落到应用当前项目（旧 bug 复现点）', back.name !== curName || !curName,
      `name="${back.name}" 应用当前项目="${curName}"`)
    check('C4 单项目 Git 指标行已清空', projectScopedLabels(back.gitLabels).length === 0,
      `labels=[${back.gitLabels.join(', ')}]`)

    // ── D 「全部项目」下的派发目标必须是显式下拉（回归点 2）──────────
    check('D1 全部项目下出现目标项目下拉', back.hasTargetPicker,
      `hint="${back.hint}"`)
    check('D2 下拉默认项 = 应用当前项目', !curName || back.targetLabel === curName,
      `默认="${back.targetLabel}" 期望="${curName}"`)
    check('D3 下拉里同时有可选的项目', back.targetOptions.length >= 2,
      `options=[${back.targetOptions.map(o => o.t).join(', ')}]`)
    // 目录不存在的项目派发过去只会被服务端拒掉，不该出现在下拉里
    const existsKeys = new Set(
      (res.projects || []).filter(p => p.exists !== false).map(p => p.key)
    )
    existsKeys.add(FAKE.path)
    check('D4 下拉只列出目录存在的项目',
      back.targetOptions.every(o => existsKeys.has(o.v)),
      `options=[${back.targetOptions.map(o => o.v).join(', ')}]`)

    // ── E 换目标 -> 提示与落点必须一致 ───────────────────────────────
    const fake = back.targetOptions.find(o => o.t === FAKE.name)
    if (!fake) {
      check('E1 目标下拉里能选到另一个项目', false, `未找到 ${FAKE.name}，options=${back.targetOptions.length}`)
    } else {
      await page.selectOption('.oc__target', fake.v)
      await sleep(500)
      const picked = await readConsole(page)
      check('E1 切换后下拉显示新目标', picked.targetLabel === FAKE.name, `label="${picked.targetLabel}"`)

      await page.fill('.oc__input', '验证派发落点')
      await sleep(200)
      await page.locator('.oc__send').click()
      await sleep(1200)
      check('E2 确实发出了派发请求（已被拦截）', !!lastDispatch, JSON.stringify(lastDispatch))
      check('E3 实际落点 = 下拉所选项（提示不说谎）',
        !!lastDispatch && lastDispatch.projectPath === FAKE.path,
        `projectPath="${lastDispatch?.projectPath}" 期望="${FAKE.path}"`)
    }

    // ── F 具体项目下不该出现下拉（目标就是它，没什么可选的）──────────
    await page.locator(`.proj-item:not(.proj-item--all)`).filter({ hasText: someProject.name }).first().click()
    await sleep(900)
    const specific = await readConsole(page)
    check('F1 选中具体项目时不出现目标下拉', !specific.hasTargetPicker)
    check('F2 具体项目下提示直接写明项目名', specific.hint.includes(someProject.name),
      `hint="${specific.hint}"`)

    check('G 无 JS 运行时异常', pageErrors.length === 0, pageErrors.join(' | '))
    const badConsole = consoleErrors.filter(t => !/favicon|ResizeObserver/i.test(t))
    check('G2 无控制台错误', badConsole.length === 0, badConsole.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
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

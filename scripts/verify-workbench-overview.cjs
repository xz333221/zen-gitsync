/**
 * 工作台右栏「项目概览」跟随左侧选中项的验证。
 *
 * 验收契约（改这块时别破坏）：
 *   A 选中「全部项目」-> 概览不得展示任何单个项目（显示「全部项目」），Git 指标行不渲染
 *   B 选中具体项目     -> 概览展示该项目名 + Git 指标
 *   C 具体项目 -> 切回「全部项目」-> 概览必须跟着退回
 *     ⚠️ 这就是本次回归点：概览曾回落到"应用当前项目"（currentProjectPath），
 *        于是切到「全部项目」后那块面板纹丝不动，看起来像没切成功。
 *   D 「概览不跟随」≠「派发目标不跟随」：全部项目下底部提示仍要指向应用当前项目
 *     —— 派发必须落到一个确定目录，这个兜底不能一起删掉。
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

/** 一次读全右栏状态，避免多次 evaluate 之间被轮询刷掉中间态 */
async function readConsole(page) {
  return page.evaluate(() => {
    const nameEl = document.querySelector('.oc__git-name')
    return {
      // 概览标题后的项目名（无选中项目时按契约应显示「全部项目」）
      name: nameEl ? nameEl.textContent.trim() : null,
      // Git 指标行的 label 列表（全部项目下应为空）
      gitLabels: Array.from(document.querySelectorAll('.oc__git-list .oc__git-label'))
        .map(e => e.textContent.trim()),
      // 底部「指令会在「X」下新建一个任务」提示
      hint: document.querySelector('.oc__hint')?.textContent?.trim() || '',
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
  // 应用当前项目（L2 里打开的那个）—— D 断言的基准
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

  try {
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
    const target = page.locator(`.proj-item:not(.proj-item--all)`).filter({ hasText: someProject.name }).first()
    await target.click()
    await sleep(900)
    const one = await readConsole(page)
    log('具体项目 ->', JSON.stringify(one))
    check('B1 概览展示选中的项目名', one.name === someProject.name,
      `name="${one.name}" 期望="${someProject.name}"`)
    check('B2 概览渲染出 Git 指标行', one.gitLabels.length > 0, `labels=[${one.gitLabels.join(', ')}]`)
    check('B3 中间看板标题同步为该名称', one.boardTitle === someProject.name,
      `boardTitle="${one.boardTitle}"`)

    // ── C 切回「全部项目」-> 概览必须退回（本次修复的核心回归点）──────
    await page.locator('.proj-item--all').first().click()
    await sleep(900)
    const back = await readConsole(page)
    log('切回全部项目 ->', JSON.stringify(back))
    check('C1 概览退回「全部项目」，不再显示上一个项目', back.name === '全部项目', `name="${back.name}"`)
    check('C2 概览没有残留上一个项目名', back.name !== someProject.name)
    // 直接对应旧 bug：旧实现回落到"应用当前项目"，这一条在修复前必然红
    check('C3 概览没有回落到应用当前项目（旧 bug 复现点）', back.name !== curName || !curName,
      `name="${back.name}" 应用当前项目="${curName}"`)
    check('C4 单项目 Git 指标行已清空', projectScopedLabels(back.gitLabels).length === 0,
      `labels=[${back.gitLabels.join(', ')}]`)

    // ── D 派发兜底目标不能被一起改掉 ─────────────────────────────────
    const m = back.hint.match(/「(.+?)」/)
    check('D1 全部项目下指令仍指向确定项目（派发兜底保留）', !!m, `hint="${back.hint}"`)
    if (m && curName) {
      check('D2 兜底目标 = 应用当前项目', m[1] === curName, `hint 目标="${m[1]}" 期望="${curName}"`)
    } else {
      check('D2 兜底目标 = 应用当前项目', !curName, `无应用当前项目，跳过比对（hint 目标="${m ? m[1] : '—'}"）`)
    }

    check('E 无 JS 运行时异常', pageErrors.length === 0, pageErrors.join(' | '))
    const badConsole = consoleErrors.filter(t => !/favicon|ResizeObserver/i.test(t))
    check('E2 无控制台错误', badConsole.length === 0, badConsole.slice(0, 3).join(' | '))
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

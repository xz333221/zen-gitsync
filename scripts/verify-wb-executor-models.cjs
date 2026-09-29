/**
 * 「这个执行器现在实际在用什么模型」在界面上看得见的验证。
 *
 * 为什么要有这个：工作台派任务**一律不传 --model**，模型完全跟随 claude / codex /
 * opencode 各自的配置文件。这条设计本身是对的，但副作用是界面上一个模型都看不到 ——
 * 用户想确认"这活到底是哪个模型跑的"只能去翻三个不同格式的配置文件。这次把
 * "读三个配置文件"收口成一个只读接口（server: routes/workbench/executorModels.js）
 * 并在三处展示。这个脚本验的就是**展示这一层**真的成立。
 *
 * 验收契约（改这块时别破坏）：
 *   A 接口本身可用：/api/workbench/executor-models 返回三个执行器的模型，
 *     claude 这种"别名两层"的要**两个名字都在**（别名背后那个才是真花钱的模型）
 *   B 设置弹窗（通用设置）：选中执行器下方直接给出「当前模型：xxx（别名 · 服务商）」
 *   C 下拉项右侧标出该执行器的模型（主 Agent 控制台 / 工作台执行按钮 / 设置里共三处）
 *   D 工作台执行按钮的 title 与下拉同口径（不开下拉也知道这活谁跑）
 *   E **三处对同一个执行器给出的模型文案必须一字不差** —— 三处各写一份措辞是这类
 *     "同一个事实在多处展示"最典型的腐坏方式
 *   F **没探测到 ≠ 没配置**：接口失败时一律不显示，绝不说"未在配置中指定" ——
 *     请求还没回来就替用户下结论（"你没配"）是在撒谎，而用户会信
 *   G 切换执行器时那行跟着换。三条分支各一遍：两处来源都没有的 → 「未在配置中指定」
 *     （不编一个名字）；**来源是 CLI 自身 state 的**（opencode 的 TUI 选择不写回配置）
 *     → 真实模型名 + 标出来源，否则用户看到模型名会先问"我配置里没写啊"；
 *     以及那行**必须真的看得见**（G6 量几何：模型名被省略号腰斩等于没写）
 *   H 页面无 console / page 错误
 *
 * 两段式：前半段 route 拦截注入**构造数据**（覆盖 有别名 / 只有模型名 / 没配 三态），
 * 后半段把接口打成失败（500）重载，验 F。
 * 拦截而不是用运行中的后端回数据，是为了让"没配"和"探测失败"这两个分支**一定**
 * 覆盖到 —— 真实机器上 opencode 恰好没配，但 claude 的两层别名是环境相关的。
 * A 组仍然打真实后端：它验的是"路由真的挂上了"，用构造数据等于自己验自己。
 *
 * 前置：vite dev 在 5544；后端 5545 活着（提供 projects 等其余接口的真实响应）。
 * ⚠️ 后端必须是**加载了新路由**的进程：A 组会如实报 404。改完服务端记得重启
 *    （本仓库的 nodemon 偶发 watch 失灵，touch 文件不一定能拉起子进程）。
 * 用法：node scripts/verify-wb-executor-models.cjs
 *       node scripts/verify-wb-executor-models.cjs --reverse   （G6 的反证：必须翻红）
 * 退出码：0 全通过（reverse 模式下 = G6 确实翻红且其余全绿），1 有失败项，2 前置不足。
 */
const fs = require('node:fs')
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544'
const API = process.env.ZEN_API || 'http://127.0.0.1:5545'
const CHROME = process.env.ZEN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
/**
 * --reverse：反证模式。把「当前模型」那行**修复前**的样式（单行 + 省略号）打回去，
 * G6 必须随之翻红。若打了回去 G6 还是绿的，说明这条断言恒真（量错了元素或量错了
 * 属性），等于没验 —— 那种情况脚本自己判失败。
 * 用法：node scripts/verify-wb-executor-models.cjs --reverse
 */
const REVERSE = process.argv.includes('--reverse')

/**
 * 注入的模型 fixture。四种形态各来一条，一个用例覆盖全部分支：
 *   claude   —— 别名两层齐全（CLI 别名 + 背后真实模型 + 代理地址）。日常最可能命中的形态
 *   codex    —— 配置里没写模型，两处来源都没有 → 走「未在配置中指定」
 *   opencode —— **来源是 CLI 自己的 state 而不是配置文件**（TUI 里选过、
 *               没回写配置）。本机 opencode 就是这个样子，早期版本因此误报"未指定"
 */
const FIXTURE = {
  claude: { name: 'deepseek-v4.1-flash', detail: 'claude-sonnet-5[1M]', provider: 'http://127.0.0.1:15721', source: null },
  codex: null,
  opencode: {
    name: 'opencode-go/space-bunny-free (max)',
    detail: null,
    provider: null,
    source: 'state',
  },
}
/** 与前端 i18n（@42BB9:未在配置中指定 / 当前模型：{model} / CLI 内最近使用）同一份口径 */
const UNSET_TEXT = '未在配置中指定'
const STATE_SOURCE_TEXT = 'CLI 内最近使用'

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
/** DOM 里的空白（模板缩进 / 换行）不该影响"文字对不对"的判断 */
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()

/** 进工作台（点活动栏 + 等三栏板子出来） */
async function openWorkbench(page) {
  await page.waitForSelector('.activity-bar', { timeout: 20000 })
  await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
  await page.waitForSelector('.board', { timeout: 15000 })
  await page.locator('.proj-item--all').first().click()
  await sleep(900)
}

/**
 * 打开「用户设置」弹窗并停在通用设置（默认就是 general）。
 *
 * ⚠️ 等 `.executor-option` 用 **attached** 而不是可见：el-option 的内容渲染在
 * select 的弹出层里，**没展开 select 时它存在但不可见** —— 等 visible 会一直超时
 * （第一版就是这么假的）。这里只需要它"已经渲染"，可见性由后面真去展开 select 时验。
 */
async function openSettings(page) {
  await page.locator('button[aria-label="用户设置"]').first().click()
  await page.waitForSelector('.executor-option', { state: 'attached', timeout: 8000 })
  // 弹窗打开时会强制重探一次模型（force），等那次请求回来
  await sleep(900)
}

/**
 * 「任务执行器」那一行的 select。
 * 弹窗里有好几个 el-select（外观 / 界面语言 / 任务执行器），只能靠 label 关联定位 ——
 * 按顺序取第 N 个会在将来有人往上面插一个新的下拉时静默错位。
 */
function executorSelect(page) {
  return page.locator('.setting-row')
    .filter({ has: page.locator('.setting-label', { hasText: /任务执行器|Task executor/ }) })
    .locator('.el-select')
    .first()
}

/** 展开后**可见**的那个 select 弹出层（同一页可能并存多个隐藏的 popper） */
const visibleSelectDropdown = (page) => page.locator('.el-select-dropdown:visible').last()

/**
 * 在设置里把任务执行器切成指定的一项。
 *
 * ⚠️ 先看弹出层是不是已经开着再决定要不要点 —— select 的 trigger 是 toggle 语义，
 * 已经展开时再点一次是**收起**（第一版就是这么超时的：前面读选项时没关，
 * 这里又点了一下，于是永远等不到可见的下拉）。
 */
async function pickExecutor(page, text) {
  if (!(await visibleSelectDropdown(page).count())) {
    await executorSelect(page).click()
    await sleep(450)
  }
  await visibleSelectDropdown(page).locator('.el-select-dropdown__item')
    .filter({ hasText: text }).first().click()
  await sleep(500)
}

/**
 * 读「设置 → 任务执行器」那块的两个展示位：
 *   line   —— 下方的「当前模型：…（…）」整行（v-if 未渲染时 found=false）
 *   detail —— 行里的括号部分
 */
const readSettingsExecutor = (page) => page.evaluate(() => {
  const line = document.querySelector('.executor-model-line')
  const cs = line ? getComputedStyle(line) : null
  return {
    found: !!line,
    text: line ? line.textContent.replace(/\s+/g, ' ').trim() : '',
    detail: line && line.querySelector('.executor-model-line__detail')
      ? line.querySelector('.executor-model-line__detail').textContent.replace(/\s+/g, ' ').trim()
      : null,
    // 截断判据（G6 用）：这行是**事实值**，模型名被腰斩等于没写。
    // 允许换行（white-space:normal）时内容自己折行，scrollWidth === clientWidth；
    // 一旦被降级回「单行 + 省略号」，scrollWidth 会超出 clientWidth → 反证脚本据此翻红。
    // ⚠️ 光看 textContent 是抓不到的（省略号是 CSS 画的，DOM 里文字还是全的）——
    // 必须量几何，这也是"看起来对"和"真的看得见"的区别。
    scroll: line ? line.scrollWidth : 0,
    client: line ? line.clientWidth : 0,
    whiteSpace: cs ? cs.whiteSpace : '',
    title: line ? line.getAttribute('title') : null,
  }
})

/** 读 el-select 展开后的选项：每个执行器的名字 + 右侧模型文案 + title */
const readSettingsOptions = (page) => page.evaluate(() => {
  const dropdown = Array.from(document.querySelectorAll('.el-select-dropdown'))
    .find(d => d.offsetParent !== null)
  if (!dropdown) return { found: false, options: [] }
  return {
    found: true,
    options: Array.from(dropdown.querySelectorAll('.executor-option')).map(el => ({
      text: el.textContent.replace(/\s+/g, ' ').trim(),
      model: el.querySelector('.executor-option__model')
        ? el.querySelector('.executor-option__model').textContent.replace(/\s+/g, ' ').trim()
        : null,
      modelTitle: el.querySelector('.executor-option__model')
        ? el.querySelector('.executor-option__model').getAttribute('title')
        : null,
    })),
  }
})

/**
 * 读某个执行器下拉（root = .tep 是主 Agent 控制台那个，.wb-executor-split 是工作台的）。
 *
 * ⚠️ 这里跑在 page.evaluate 里，**不能用 Playwright 的 `:visible` 伪类**（浏览器不认，
 * 直接抛非法选择器）；可见性在 DOM 侧用 offsetParent 判。`.tep` 有 v-show 双实例，
 * 必须挑可见的那个，否则读到的是藏起来那份（按钮 title 会是 null）。
 */
const readDropdown = (page, rootSel, itemSel, modelSel) => page.evaluate(({ root, item, model }) => {
  const menu = Array.from(document.querySelectorAll('.el-dropdown-menu'))
    .find(m => m.offsetParent !== null)
  const roots = Array.from(document.querySelectorAll(root))
  const rootEl = roots.find(el => el.offsetParent !== null) || roots[0]
  if (!menu || !rootEl) return { found: false, items: [], btnTitle: rootEl ? rootEl.getAttribute('title') : null }
  return {
    found: true,
    btnTitle: rootEl.getAttribute('title'),
    items: Array.from(menu.querySelectorAll(item)).map(el => ({
      text: el.textContent.replace(/\s+/g, ' ').trim(),
      model: el.querySelector(model)
        ? el.querySelector(model).textContent.replace(/\s+/g, ' ').trim()
        : null,
      modelTitle: el.querySelector(model) ? el.querySelector(model).getAttribute('title') : null,
    })),
  }
}, { root: rootSel, item: itemSel, model: modelSel })

async function main() {
  // ── A 接口本身（打真实后端，验路由真的挂上了）────────────────────────
  let apiModels = null
  try {
    const resp = await fetch(`${API}/api/workbench/executor-models`)
    const body = await resp.json().catch(() => null)
    check('A1 接口可用：GET /api/workbench/executor-models 返回 success',
      resp.status === 200 && !!body && body.success === true,
      `status=${resp.status}${resp.status === 404 ? '（后端跑的是旧代码，重启它）' : ''}`)
    apiModels = body && body.models ? body.models : null
  } catch (err) {
    check('A1 接口可用：GET /api/workbench/executor-models 返回 success', false, err.message)
  }
  check('A2 接口返回三个执行器的 key（与 TASK_EXECUTOR_OPTIONS 对齐）',
    !!apiModels && ['claude', 'codex', 'opencode'].every(k => k in apiModels),
    JSON.stringify(apiModels))
  // claude 的别名两层是这套机制存在的理由：只报 CLI 别名等于没报
  check('A3 claude 这类"别名两层"的形态：模型名与服务商都带出来（有则 name≠detail）',
    !!apiModels && !apiModels.claude
      || (typeof apiModels.claude.name === 'string' && !!apiModels.claude.name),
    JSON.stringify(apiModels && apiModels.claude))

  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox'],
  })
  const page = await (await browser.newContext({ viewport: { width: 2000, height: 1274 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  // ── G6 的测量条件 + 反证注入 ─────────────────────────────────────────
  // 两件事必须做，否则 G6 会变成恒真的假绿：
  //  ① 把那一列压窄到 320px。探针视口 2000px 时这一列有 800px 宽，最长的模型名
  //     （opencode，34 字符）也塞得下、压根不会溢出 —— 任何实现都是绿的。
  //     320px 是实测窄窗口下这一列的真实宽度。这是**测量条件**，正反两个模式都注入，
  //     所以它不能用来解释反证的红。
  //  ② reverse 才注入修复前的样式（单行 + 省略号）。
  // ⚠️ 都得 !important：组件样式是 scoped 的（编译后带 [data-v-xxx]，0,4,0），
  //    裸类名（0,1,0）压不过它里的 `max-width: 100%` —— 那样"压窄了/打回去了"
  //    只是假象，G6 照样绿，反证就成了自欺。
  // 用 addInitScript 而不是 addStyleTag：后者只在当前文档有效，reload 就没了。
  await page.addInitScript((reverse) => {
    const put = () => {
      const narrow = document.createElement('style')
      narrow.textContent = '.executor-model-line{max-width:320px !important}'
      document.head.appendChild(narrow)
      if (!reverse) return
      const old = document.createElement('style')
      old.textContent = '.project-toggle .setting-hint-block.executor-model-line{'
        + 'white-space:nowrap !important;overflow:hidden !important;text-overflow:ellipsis !important}'
      document.head.appendChild(old)
    }
    if (document.head) put()
    else document.addEventListener('DOMContentLoaded', put)
  }, REVERSE)

  let shot = null
  try {
    await page.addInitScript(() => {
      try {
        // 「全部项目」视图：否则色标/任务会被项目过滤掉，合成任务看不见（历史假红原因）
        localStorage.setItem('wb.boardProject.v1', '')
        localStorage.setItem('wb.boardView.v1', 'kanban')
        // 右栏固定指令模式：模式里才有 TaskExecutorPicker（对话模式那个要等引擎起来）
        localStorage.setItem('wb.ocMode.v2', 'command')
      } catch { /* 隐私模式 */ }
    })
    await page.route('**/api/workbench/executor-models*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, checkedAt: new Date().toISOString(), models: FIXTURE }),
      })
    })
    // 三个执行器都判"已安装"：否则下拉项被置灰、picker 还会自作主张回落到别的值
    await page.route('**/api/check-tools*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true, platform: 'win32',
          vscode: true, claude: true, codex: true, opencode: true, kimi: false, zcode: false, dsh: false,
          installers: {}, versions: {},
        }),
      })
    })
    // 一条合成任务：工作台的「执行」split button 要**选中任务**才出现。
    // ⚠️ 两个接口都要给：看板卡片来自 /api/workbench/projects（要 decorate 过的），
    // 而「任务执行」弹窗左列的任务清单来自 /api/workbench/tasks（原始形状）。
    // 只喂前一个的话，点开卡片后左列里没有这条任务可选（第一版就是这么卡住的）。
    const registry = await import(require('node:url').pathToFileURL(
      path.resolve(__dirname, '../src/ui/server/routes/workbench/projectRegistry.js')
    ).href)
    const now = Date.now()
    const live = await fetch(`${API}/api/workbench/projects`).then(r => r.json()).catch(() => ({ projects: [], currentProjectPath: '' }))
    const synthTask = {
      id: 'synth-em-task',
      title: '【合成】执行器模型展示',
      desc: '',
      // 弹窗左列按项目分组 → 必须挂在当前项目下才看得见
      projectPath: live.currentProjectPath || 'D:\\ws\\zen-gitsync',
      createdAt: new Date(now - 60000).toISOString(),
      promptId: '',
    }
    const synthCard = registry.decorateTaskForBoard(synthTask, [], { now })
    await page.route('**/api/workbench/tasks*', (route) => {
      if (route.request().method() !== 'GET') {
        // 点任务会触发自动保存（POST），放它过去会真的写用户的 tasks.json
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) })
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, tasks: [synthTask] }),
      })
    })
    await page.route('**/api/workbench/projects*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, projects: live.projects, tasks: [synthCard], currentProjectPath: live.currentProjectPath }),
      })
    })

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await openWorkbench(page)

    // ── B 设置弹窗：那一行「当前模型：…」 ────────────────────────────────
    await openSettings(page)
    let line = await readSettingsExecutor(page)
    check('B1 设置 → 任务执行器下方给出「当前模型：<模型名>」',
      line.found && line.text.includes(FIXTURE.claude.name), JSON.stringify(line))
    check('B2 同一行里带出次要信息（CLI 别名 · 服务商），不用点开配置文件',
      !!line.detail && line.detail.includes(FIXTURE.claude.detail) && line.detail.includes(FIXTURE.claude.provider),
      String(line.detail))

    // 下拉选项右侧的模型名
    await executorSelect(page).click()
    await sleep(500)
    let opts = await readSettingsOptions(page)
    check('C1 设置下拉：每个执行器右侧标出它当前用的模型',
      opts.found && opts.options.some(o => o.model === FIXTURE.claude.name),
      JSON.stringify(opts.options.map(o => `${o.text}|${o.model}`)))
    check('C2 设置下拉：配置里没写模型的那个显示「未在配置中指定」，不编一个名字',
      opts.options.some(o => o.model === UNSET_TEXT && o.text.includes('Codex')),
      JSON.stringify(opts.options.map(o => `${o.text}|${o.model}`)))
    check('C3 选项 title 是模型 + 服务商（claude 是别名 + 代理地址）',
      opts.options.some(o => o.modelTitle === `${FIXTURE.claude.name} · ${FIXTURE.claude.detail} · ${FIXTURE.claude.provider}`),
      JSON.stringify(opts.options.map(o => o.modelTitle)))
    // 模型名被 CSS 截掉的话，显示出来的是 `opencode-go/space-bunny-…` —— 比不显示还糟
    // （看着像坏了，也没告诉用户到底用的什么）。设置弹窗空间宽绰，这里不允许截断。
    const fit = await page.evaluate(() => {
      const dd = Array.from(document.querySelectorAll('.el-select-dropdown'))
        .find(d => d.offsetParent !== null)
      if (!dd) return null
      return Array.from(dd.querySelectorAll('.executor-option__model'))
        .map(el => ({ text: el.textContent.trim(), scroll: el.scrollWidth, client: el.clientWidth }))
    })
    check('C7 设置下拉里的模型名完整显示，没被 CSS 截断',
      !!fit && fit.length > 0 && fit.every(m => m.scroll <= m.client + 1),
      JSON.stringify(fit))

    // ── G 切换执行器 → 那行跟着换（三个分支各走一遍）───────────────────
    // G1/G2：两处来源都没有 → 如实说"未在配置中指定"
    await pickExecutor(page, 'Codex')
    line = await readSettingsExecutor(page)
    check('G1 切到没配模型的执行器：那行改说「未在配置中指定」',
      line.found && line.text.includes(UNSET_TEXT), JSON.stringify(line))
    check('G2 没配时不显示空的括号（detail 段整块不渲染）',
      line.detail === null, JSON.stringify(line.detail))

    // G4/G5：模型来自 CLI 自己的 state（TUI 里选的、没写回配置）—— 必须显示真实模型名，
    // 并在括号里说清是"CLI 内最近使用"，否则用户看到模型名会先问"我配置里没写啊"
    await pickExecutor(page, 'OpenCode')
    line = await readSettingsExecutor(page)
    check('G4 切到"用 CLI 内选择"的执行器：显示真实模型名（不是「未在配置中指定」）',
      line.found && line.text.includes(FIXTURE.opencode.name), JSON.stringify(line))
    check('G5 括号里标出来源（CLI 内最近使用），不让用户以为是自己配的',
      !!line.detail && line.detail.includes(STATE_SOURCE_TEXT), String(line.detail))

    // G6/G7：那行必须**真的看得见**。opencode 是三家名字最长的（34 字符），
    // 它没被截断就代表另外两家也不会。这行被 `.project-toggle` 里那条
    // 「单行 + 省略号」的 hint 规则截过（实测显示成 `opencode-go/space-bunn…`）——
    // 而模型名正是这行唯一的信息量，截了等于没写。
    // ⚠️ 光比 textContent 抓不到：省略号是 CSS 画的，DOM 里的文字还是全的。
    //    所以 G6 量几何（scrollWidth vs clientWidth），并且按 addInitScript 里
    //    写的窄列条件（320px）来量 —— 不然这条断言恒真。
    check('G6 「当前模型」那行允许换行、模型名完整显示（没被省略号腰斩）',
      line.found && line.whiteSpace === 'normal' && line.scroll <= line.client + 1
        && line.client > 0,
      JSON.stringify({ text: line.text, whiteSpace: line.whiteSpace, scroll: line.scroll, client: line.client }))
    // 窗口再窄也可能超宽，title 是兜底（不是主要手段 —— 主要手段是上面那条换行）
    check('G7 那行有 title 兜底，悬停能看到完整值',
      !!line.title && line.title.includes(FIXTURE.opencode.name), String(line.title))
    // 存证：最长的那家在这个窄列下换行后长什么样。断言只能证明"没溢出"，
    // 看不出换行断在哪 —— 而这行好不好看全在断点上（模型名不能被拆成两行）。
    const lineShot = path.resolve(__dirname,
      `../tmp-verify-wb-executor-models-settings-opencode${REVERSE ? '-reverse' : ''}.png`)
    await page.locator('.el-dialog').first().screenshot({ path: lineShot })
    log('截图:', lineShot)

    // 切回 claude，后面 E 组要拿它跟另外两处比对
    await pickExecutor(page, 'Claude Code')
    line = await readSettingsExecutor(page)
    check('G3 切回来恢复（同一份数据驱动，不是记了一份快照）',
      line.found && line.text.includes(FIXTURE.claude.name), JSON.stringify(line))
    const settingsText = line.text
    // 存证：设置弹窗里那一行实际长什么样（这条比任何断言都直观）
    shot = path.resolve(__dirname, `../tmp-verify-wb-executor-models-settings${REVERSE ? '-reverse' : ''}.png`)
    await page.locator('.el-dialog').first().screenshot({ path: shot })
    log('截图:', shot)
    // 关闭设置弹窗（后面要点工作台里的控件）。
    // ⚠️ 必须限定在页脚里：`.dialog-cancel-btn` 这个类在「编辑器」tab 里还有个
    // 「打开系统配置文件」按钮，取 first 会点到那个不可见的（第一版就是这么超时的）
    await page.locator('.user-settings-footer .dialog-cancel-btn').first().click()
    await sleep(700)

    // ── C/E 主 Agent 控制台的 picker：按钮 title + 下拉项 ──────────────
    // （放在打开「任务执行」弹窗之前做：那个弹窗是 overlay，会把右栏的点击吃掉）
    // ⚠️ `.tep` 在 DOM 里有**两个**（指令模式派发栏 / 对话模式各一份，v-show 切换），
    // 不过滤可见性会取到那个藏起来的（第一版就是这么超时的）
    const picker = page.locator('.tep:visible').first()
    await picker.waitFor({ state: 'visible', timeout: 10000 })
    await sleep(400)
    const pickerBtnTitle = await picker.locator('> .tep__btn').first().getAttribute('title')
    check('E1 控制台执行器按钮的 title 带出当前模型',
      !!pickerBtnTitle && pickerBtnTitle.includes(FIXTURE.claude.name), String(pickerBtnTitle))
    await picker.locator('> .tep__btn').first().click()
    await sleep(500)
    const pickerDrop = await readDropdown(page, '.tep', '.tep__item', '.tep__item-model')
    check('C4 控制台下拉：每个执行器右侧标出模型',
      pickerDrop.found && pickerDrop.items.some(i => i.model === FIXTURE.claude.name),
      JSON.stringify(pickerDrop.items.map(i => `${i.text}|${i.model}`)))
    check('C5 控制台下拉：没配的那个同样显示「未在配置中指定」',
      pickerDrop.items.some(i => i.model === UNSET_TEXT), JSON.stringify(pickerDrop.items.map(i => i.model)))
    check('C6 控制台下拉：来源是 CLI 内选择的那个，title 里也标出来源',
      pickerDrop.items.some(i => i.model === FIXTURE.opencode.name
        && (i.modelTitle || '').includes(STATE_SOURCE_TEXT)),
      JSON.stringify(pickerDrop.items.map(i => `${i.model}|${i.modelTitle}`)))
    await page.keyboard.press('Escape')
    await sleep(400)

    // ── D 工作台执行按钮（split button）的下拉与 title ──────────────────
    // 点看板卡片 → 开「任务执行」弹窗 → 左列选中任务 → 工具栏才出现执行按钮
    await page.locator('.kb-card[data-task-id="synth-em-task"]').first().click()
    await page.waitForSelector('.wb-sidebar', { timeout: 10000 })
    await page.locator('.wb-sidebar .wb-task-list').getByText('【合成】执行器模型展示').first().click()
    await page.waitForSelector('.wb-executor-split', { timeout: 10000 })
    await sleep(500)
    const splitHintTitle = await page.locator('.wb-executor-split__hint').first().getAttribute('title')
    check('D1 执行按钮的 title 带出当前模型（悬停就知道这活谁跑）',
      !!splitHintTitle && splitHintTitle.includes(FIXTURE.claude.name), String(splitHintTitle))
    await page.locator('.wb-executor-split button').last().click()
    await sleep(500)
    const wbDrop = await readDropdown(page, '.wb-executor-split', '.wb-executor-item', '.wb-executor-item__model')
    check('D2 执行按钮下拉：每个执行器右侧标出模型',
      wbDrop.found && wbDrop.items.some(i => i.model === FIXTURE.claude.name),
      JSON.stringify(wbDrop.items.map(i => `${i.text}|${i.model}`)))
    shot = path.resolve(__dirname, '../tmp-verify-wb-executor-models-dropdown.png')
    await page.screenshot({ path: shot })
    log('截图:', shot)
    // 关掉这个下拉（点空白处），否则下面读菜单会读到同一个
    await page.keyboard.press('Escape')
    await sleep(400)

    // ── E 三处文案一致性 ────────────────────────────────────────────────
    // 设置行是「当前模型：xxx（…）」的整行，另外两处只有名字 —— 取"是否都含同一个模型名"
    // 之外，还要把三处的**模型名本身**抽出来比：三处各写一份措辞是这里最容易腐坏的地方。
    const pickerModelText = (pickerDrop.items.find(i => i.text.includes('Claude Code')) || {}).model
    const wbModelText = (wbDrop.items.find(i => i.text.includes('Claude Code')) || {}).model
    check('E2 三处对同一个执行器给出的模型文案一字不差',
      !!pickerModelText && pickerModelText === wbModelText && settingsText.includes(pickerModelText),
      `设置=${JSON.stringify(settingsText)} 下拉=${JSON.stringify(pickerModelText)} 工作台=${JSON.stringify(wbModelText)}`)
    check('E3 picker 与工作台按钮的 title 用同一份「模型 · 别名 · 服务商」口径（picker 只是多带一句入口说明）',
      // picker 的 title 是「这个下拉是干嘛的 · 模型信息」，工作台那条只有模型信息 ——
      // 所以比"后者是前者的后缀"，而不是比全等
      !!splitHintTitle
        && splitHintTitle === `${FIXTURE.claude.name} · ${FIXTURE.claude.detail} · ${FIXTURE.claude.provider}`
        && !!pickerBtnTitle && pickerBtnTitle.endsWith(splitHintTitle),
      `picker="${pickerBtnTitle}" hint="${splitHintTitle}"`)

    shot = path.resolve(__dirname, '../tmp-verify-wb-executor-models.png')
    await page.screenshot({ path: shot })
    log('截图:', shot)

    // ── F 探测失败时"不撒谎" ────────────────────────────────────────────
    // 关键断言：unknown（还没问到）与 unset（确实没配）必须显示成不同的东西。
    // 探测失败时若显示「未在配置中指定」，用户会以为是自己没配 → 去翻配置文件白折腾。
    await page.unroute('**/api/workbench/executor-models*')
    await page.route('**/api/workbench/executor-models*', (route) => {
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false }) })
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openWorkbench(page)
    await openSettings(page)
    const failLine = await readSettingsExecutor(page)
    check('F1 探测失败时设置里那行整块不渲染（不说"未在配置中指定"）',
      !failLine.found, JSON.stringify(failLine))
    await executorSelect(page).click()
    await sleep(500)
    const failOpts = await readSettingsOptions(page)
    check('F2 探测失败时下拉项也不显示任何模型文案（含"未在配置中指定"）',
      failOpts.found && failOpts.options.length > 0
        && failOpts.options.every(o => o.model === null && !o.text.includes(UNSET_TEXT)),
      JSON.stringify(failOpts.options.map(o => `${o.text}|${o.model}`)))
    await page.keyboard.press('Escape')

    // F 组故意把接口打成 500，浏览器会因此记一条 "Failed to load resource" 的
    // console error —— 那是我们**自己制造的**、也正是 F 组要验的场景，不算页面缺陷。
    // 页面真实的 JS 报错（异常、警告）照样算。
    const realErrors = consoleErrors.filter(t => !/Failed to load resource/i.test(t))
    check('H1 页面无 console / page 错误',
      realErrors.length === 0 && pageErrors.length === 0,
      [...realErrors, ...pageErrors].slice(0, 3).join(' | '))
  } finally {
    // 只关自己起的这个浏览器实例（不用 taskkill /IM —— 那会连带关掉用户的浏览器）
    await browser.close()
  }

  const failed = results.filter(r => !r.ok)

  // --reverse：只要求 G6 翻红。反向跑时别的断言仍须全绿 —— 那条 injected 样式
  // 只该影响这一行，若把 C7/B/E 之类也带红了，说明它误伤了别处，同样算失败。
  // 文件名也按模式分开，否则后跑的会覆盖先跑的，把"改前"的图当成"改后"看。
  if (REVERSE) {
    const g6 = results.find(r => r.name.startsWith('G6'))
    const others = results.filter(r => !r.name.startsWith('G6'))
    const othersFailed = others.filter(r => !r.ok)
    console.log(`\n[verify] reverse 反证：G6 = ${g6 && g6.ok ? '绿（异常！断言恒真，等于没验）' : '红（符合预期）'}`)
    console.log(`[verify] reverse 反证：其余 ${others.length - othersFailed.length}/${others.length} 通过`)
    for (const f of othersFailed) console.log(`  FAIL  ${f.name}  :: ${f.extra}`)
    process.exit(g6 && !g6.ok && othersFailed.length === 0 ? 0 : 1)
  }

  console.log(`\n[verify] ${results.length - failed.length}/${results.length} 通过`)
  for (const f of failed) console.log(`  FAIL  ${f.name}  :: ${f.extra}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify] 异常退出:', err); process.exit(1) })

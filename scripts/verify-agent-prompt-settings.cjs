/**
 * 智能体视图「设置 → 提示词设置」的验证（两块提示词 + 它们真的被注入对话）。
 *
 * 为什么要有这个：
 *   1. 这两块提示词是**纯 prompt 注入**的 —— 没有按钮、没有状态、界面上看不出对错。
 *      改 agentChat.js / agentRoutes.js / chatPrompts.js 的人（哪怕只是把一段挪个位置）
 *      会无声地把它弄掉，而用户只会觉得"模型今天不太听话"。A 组把注入点钉在源码上。
 *   2. 「派发任务的提示词」在**两个界面**都能改（工作台弹窗 / 智能体设置），
 *      而它们是**同一份数据**。两边各存一份必然分叉，C/D 组钉住这件事。
 *
 * 验收契约（改这块时别破坏）：
 *   A 注入链路还在：agentRoutes 解析一次 → 内置引擎走 promptSection、外部引擎拼进 promptPrefix；
 *     runAgentTurn 未传时自己解析（定时任务那条链路）；injectRequestContext 真的消费它；
 *     面板写的是正确的两处数据源；agentDefaultPrompt 在 saveConfig 的解构名单里（不漏进项目配置）
 *   B 智能体视图 Tab 栏里有「设置」，点开是提示词设置面板，两块 + 三个输入框都在
 *   C 在面板里存 g ai 默认提示词 → config.json 的 agentDefaultPrompt 落盘
 *   D 在面板里存派发提示词 → orchestrator.json 的 defaultPrompt 落盘，
 *     且工作台读到的就是**同一个值**（同一份数据，不是镜像）
 *   E 反向一致：从工作台接口改完，重新打开设置面板能显示新值
 *   F 无 JS 运行时异常 / 控制台错误
 *
 * 前置：dev server 已启动（后端 5545 / 前端 5544）。
 * ⚠️ 脚本会临时写入提示词，结束时**恢复原值** —— 跑完不该在用户数据里留下任何痕迹。
 * 用法：node scripts/verify-agent-prompt-settings.cjs
 *       node scripts/verify-agent-prompt-settings.cjs --reverse   （A 组逐条打回去，必须翻红）
 * 退出码：0 全通过；1 有失败项；2 环境没起。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const REVERSE = process.argv.includes('--reverse')

// playwright 装在 src/ui/client 下，把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const API = process.env.ZEN_API || 'http://127.0.0.1:5545'

const AGENT_ROUTES = path.join(ROOT, 'src/ui/server/routes/workbench/agentRoutes.js')
const AGENT_CHAT = path.join(ROOT, 'src/ui/server/routes/workbench/agentChat.js')
const CHAT_PROMPTS = path.join(ROOT, 'src/ui/server/routes/workbench/chatPrompts.js')
const CONFIG_JS = path.join(ROOT, 'src/config.js')
const PANEL = path.join(ROOT, 'src/ui/client/src/components/AgentPromptSettings.vue')
const AGENT_VIEW = path.join(ROOT, 'src/ui/client/src/views/AgentView.vue')

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 去掉注释再匹配：文件头注释里会写到这些符号名，匹配到注释等于没验。 */
function codeOnly(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '')
}
const must = (cond, why) => { if (!cond) throw new Error(why) }

// ══════════════════════════════════════════════════════════════
// A 组：注入链路的静态守卫（无浏览器）
// ══════════════════════════════════════════════════════════════
function staticChecks() {
  const routes = codeOnly(AGENT_ROUTES)
  const chat = codeOnly(AGENT_CHAT)
  const prompts = codeOnly(CHAT_PROMPTS)
  const config = codeOnly(CONFIG_JS)
  const panel = codeOnly(PANEL)
  const view = codeOnly(AGENT_VIEW)

  check('A1 agentRoutes 解析一次用户固定提示词（resolveChatPromptSection）',
    /resolveChatPromptSection\s*\(\s*\{[^}]*cwd[^}]*locale/.test(routes),
    '没解析 = 两块提示词都不会进对话')

  check('A2 内置引擎那条链路把 promptSection 传给 runAgentTurn',
    /runAgentTurn\(\{[\s\S]{0,1200}?\bpromptSection\b/.test(routes),
    '不传的话 runAgentTurn 会自己再读一次配置（能跑，但同一轮读两遍）')

  check('A3 外部 CLI 引擎那条链路把它拼进 promptPrefix（CLI 没有请求副本可注入）',
    /promptPrefix\s*=\s*promptPrefix\s*\?\s*`\$\{promptSection\}/.test(routes),
    '外部引擎（claude/opencode/codex）在智能体里也是 g ai，同样要带上这两块')

  check('A4 runAgentTurn 未传时自己解析（定时任务直接调它，没人替它接这根线）',
    /userPromptSection\s*===\s*undefined/.test(chat)
    && /resolveChatPromptSection\(\{\s*cwd,\s*locale\s*\}\)/.test(chat))

  check('A5 injectRequestContext 真的消费 promptSection（拼进 system 副本）',
    /promptSection:\s*userPromptSection/.test(chat)
    && /# \$\{en \? 'Standing instructions' : '用户固定提示词'\}/.test(chat),
    '解析出来但没人用 = 白读一遍配置')

  check('A6 两块提示词各自接到正确的数据源（g ai 默认走 config，派发走 orchestrator）',
    /loadAgentPrompt\s*=\s*defaultLoadAgentPrompt/.test(prompts)
    && /loadDispatchPrompt\s*=\s*defaultLoadDispatchPrompt/.test(prompts)
    && /resolveDispatchPrompt\(state,\s*cwd\)/.test(prompts),
    '派发那块必须复用工作台的解析（resolveDispatchPrompt），别自己拼一份')

  check('A7 agentDefaultPrompt 在 saveConfig 的解构名单里（否则会漏进项目配置）',
    /agentPresetPrompts,\s*agentDefaultPrompt,/.test(config),
    '全局键没解构出来就会被 ...projectConfig 写进 raw.projects[key]')

  check('A8 面板写的是两处正确的接口（saveAiSettings + 工作台那对 save*Prompt）',
    /saveAiSettings\(\{\s*agentDefaultPrompt/.test(panel)
    && /saveDefaultPrompt\(/.test(panel) && /saveProjectPrompt\(/.test(panel),
    '面板自己不存镜像 —— 两边各存一份必然分叉')

  check('A9 智能体视图的 Tab 里有「设置」这一项',
    /id:\s*'settings'/.test(view) && /@AGENT:设置/.test(view))

  check('A10 广场面板不再是 v-else 兜底（新 Tab 会被它抢走）',
    /v-else-if="activeTab === 'skill' \|\| activeTab === 'mcp'"/.test(view),
    'v-else 兜底时，切到「设置」会渲染成广场')
}

// ══════════════════════════════════════════════════════════════
// 反向验证：把 A 组的每一条打回去，断言必须翻红
// ══════════════════════════════════════════════════════════════
function reverseChecks() {
  const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-agent-prompt-rev-'))
  try {
    const write = (name, src) => {
      const p = path.join(SANDBOX, name)
      fs.writeFileSync(p, src, 'utf8')
      return p
    }
    const routesSrc = fs.readFileSync(AGENT_ROUTES, 'utf8')
    const chatSrc = fs.readFileSync(AGENT_CHAT, 'utf8')
    const panelSrc = fs.readFileSync(PANEL, 'utf8')
    const configSrc = fs.readFileSync(CONFIG_JS, 'utf8')
    const viewSrc = fs.readFileSync(AGENT_VIEW, 'utf8')

    const cases = [
      // R1：把 A1 的解析调用整段摘掉（模拟"有人删了注入"）
      ['R1 摘掉 resolveChatPromptSection 调用', write('R1.js',
        routesSrc.replace(/promptSection = await resolveChatPromptSection\(\{ cwd, locale \}\);/, "promptSection = '';")),
        (src) => /resolveChatPromptSection\s*\(\s*\{[^}]*cwd[^}]*locale/.test(src)],
      // R2：内置链路不再传 promptSection（源码是 CRLF，正则必须容忍 \r）
      ['R2 不再把 promptSection 传给 runAgentTurn', write('R2.js',
        routesSrc.replace(/\r?\n\s*promptSection\r?\n(\s*\}\);)/, '\n$1')),
        (src) => /runAgentTurn\(\{[\s\S]{0,1200}?\bpromptSection\b/.test(src)],
      // R3：外部链路不再拼前缀
      ['R3 外部引擎不再拼 promptPrefix', write('R3.js',
        routesSrc.replace(/if \(promptSection\) \{[\s\S]{0,160}?\}/, '')),
        (src) => /promptPrefix\s*=\s*promptPrefix\s*\?\s*`\$\{promptSection\}/.test(src)],
      // R4：runAgentTurn 不再自己解析（定时任务那条链路就断了）
      ['R4 runAgentTurn 不再自己解析', write('R4.js',
        chatSrc.replace(/if \(userPromptSection === undefined\)/, 'if (false)')),
        (src) => /userPromptSection\s*===\s*undefined/.test(src)],
      // R5：injectRequestContext 不再消费
      ['R5 injectRequestContext 不再消费 promptSection', write('R5.js',
        chatSrc.replace(/promptSection:\s*userPromptSection\s*\}/, '}')),
        (src) => /promptSection:\s*userPromptSection/.test(src)],
      // R6：全局键没解构（漏进项目配置）
      ['R6 agentDefaultPrompt 不在解构名单里', write('R6.js',
        configSrc.replace('agentPresetPrompts, agentDefaultPrompt,', 'agentPresetPrompts,')),
        (src) => /agentPresetPrompts,\s*agentDefaultPrompt,/.test(src)],
      // R7：面板改成只存本地（不再调接口）
      ['R7 面板不再调 saveAiSettings', write('R7.js',
        panelSrc.replace(/saveAiSettings\(\{\s*agentDefaultPrompt/, 'noop(')),
        (src) => /saveAiSettings\(\{\s*agentDefaultPrompt/.test(src)],
      // R8：广场退回 v-else 兜底（设置 Tab 被抢）
      ['R8 广场退回 v-else 兜底', write('R8.vue',
        viewSrc.replace(/v-else-if="activeTab === 'skill' \|\| activeTab === 'mcp'"/, 'v-else')),
        (src) => /v-else-if="activeTab === 'skill' \|\| activeTab === 'mcp'"/.test(src)],
    ]

    for (const [label, file, re] of cases) {
      check(`reverse ${label}：断言必须翻红`, !re(codeOnly(file)),
        '把这条打回去之后断言还通过 —— 说明它恒真，等于没验')
    }
  } finally {
    fs.rmSync(SANDBOX, { recursive: true, force: true })
  }
}

// ══════════════════════════════════════════════════════════════
// B~E 组：浏览器 + 真接口
// ══════════════════════════════════════════════════════════════
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

const post = (url, body) => fetch(`${API}${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(r => r.json()).catch(() => null)

const getConfig = () => fetch(`${API}/api/config/getConfig`, { cache: 'no-store' })
  .then(r => r.json()).catch(() => null)
const getOrchestrator = () => fetch(`${API}/api/workbench/orchestrator`, { cache: 'no-store' })
  .then(r => r.json()).catch(() => null)

/** 轮询直到条件成立（保存是异步的，别用固定 sleep 赌） */
async function waitFor(fn, { timeout = 8000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) return null
    await sleep(interval)
  }
}

async function browserChecks() {
  const MARK = Date.now().toString().slice(-6)
  const GAI_TEXT = `【g ai 默认提示词验证${MARK}】回答用中文`
  const DISPATCH_TEXT = `【派发提示词验证${MARK}】改完就提交`

  // 原值快照 —— finally 里逐字还原
  const cfg0 = await getConfig()
  const orch0 = await getOrchestrator()
  if (!cfg0 || !orch0) { console.error('读不到配置/编排状态，dev server 起了吗？'); process.exit(2) }
  const backup = {
    agentDefaultPrompt: typeof cfg0.agentDefaultPrompt === 'string' ? cfg0.agentDefaultPrompt : '',
    defaultPrompt: typeof orch0.defaultPrompt === 'string' ? orch0.defaultPrompt : '',
  }
  log('原值: agentDefaultPrompt =', JSON.stringify(backup.agentDefaultPrompt),
    '| defaultPrompt =', JSON.stringify(backup.defaultPrompt))

  const browser = await launchBrowser()
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage()
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    // "Failed to load resource: ... 500" 这类不带 URL 的文案跳过：HTTP 失败由下面的
    // response 监听记（带完整 URL，还能分类环境噪音），console 这条是它的重复
    if (/Failed to load resource/.test(m.text())) return
    consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  // 失败响应的 URL 也记下来：console 里只有 "500 (Internal Server Error)"，
  // 不带 URL 就没法定位是哪个接口（排查时为此多跑一轮太冤）
  page.on('response', (r) => {
    if (r.status() < 500) return
    // /api/project-startup/suggestions 是**默认 Git 视图**里 ProjectStartupAiPanel 发的
    // （KeepAlive 下切到智能体视图它还在后台活着），走 LLM 生成启动建议。
    // 它 500 的唯一原因是 LLM 配额/网络，与本功能无关 —— 算环境噪音，单列一类，
    // 别让它把 F1 永久染红（配额每天重置前谁都跑不过）。
    const tag = r.url().includes('/api/project-startup/suggestions') ? 'env-noise' : 'real'
    consoleErrors.push(`${tag}: HTTP ${r.status()} ${r.url()}`)
  })

  try {
    // 先把两块都清成空，B/C/D 组从"一条都没有"起跑
    await post('/api/config/save-ai-settings', { agentDefaultPrompt: '' })
    await post('/api/workbench/orchestrator/default-prompt', { prompt: '' })

    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    // App.vue 的加载门：initCompleted 之前整段是 .loading-container（v-if），
    // .app-body 是 v-else —— 等它出现即"初始化完成"，没有竞态
    // （默认视图是 Git Pane，AgentView 根本不挂载，直接等 .agent-tab 会超时）
    await page.waitForSelector('.app-body', { timeout: 60000 })
    // 智能体视图要经左侧活动栏进（aria-label 可能带「· N 个对话正在生成」后缀，用前缀匹配）
    await page.click('.activity-bar button[aria-label^="智能体"]')
    await page.waitForSelector('.agent-tab', { timeout: 30000 })

    // ── B 组：Tab + 面板 ──
    const tabLabels = await page.$$eval('.agent-tab', els => els.map(e => e.textContent.trim()))
    check('B1 Tab 栏里有「设置」', tabLabels.some(t => t.includes('设置')), tabLabels.join(' / '))

    await page.click('.agent-tab:has-text("设置")')
    await page.waitForSelector('.aps', { timeout: 15000 })
    check('B2 切到设置后出现提示词面板', await page.isVisible('.aps'))

    const cards = await page.$$eval('.aps__card-title', els => els.map(e => e.textContent.trim()))
    check('B3 面板里两块都在（g ai 默认提示词 + 派发任务的提示词）',
      cards.some(t => t.includes('g ai')) && cards.some(t => t.includes('派发任务')), cards.join(' / '))

    check('B4 三个输入框都在（g ai / 全局 / 项目）',
      (await page.$('#aps-gai')) !== null
      && (await page.$('.aps__card--dispatch #aps-global')) !== null
      && (await page.$('.aps__card--dispatch #aps-project')) !== null)

    // ── C 组：存 g ai 默认提示词 ──
    await page.fill('#aps-gai', GAI_TEXT)
    await page.click('.aps__card--gai .aps__btn--primary')
    const cfgAfter = await waitFor(async () => {
      const c = await getConfig()
      return c?.agentDefaultPrompt === GAI_TEXT ? c : null
    })
    check('C1 面板里存下的 g ai 默认提示词真的落盘了（config.json 的 agentDefaultPrompt）',
      !!cfgAfter, `读到 ${JSON.stringify(cfgAfter?.agentDefaultPrompt ?? null)}`)

    // ── D 组：存派发提示词（与工作台同一份数据）──
    await page.fill('.aps__card--dispatch #aps-global', DISPATCH_TEXT)
    await page.click('.aps__card--dispatch .aps__btn--primary')
    const orchAfter = await waitFor(async () => {
      const o = await getOrchestrator()
      return o?.defaultPrompt === DISPATCH_TEXT ? o : null
    })
    check('D1 面板里存下的派发提示词落在 orchestrator.json（工作台读的就是这份）',
      !!orchAfter, `读到 ${JSON.stringify(orchAfter?.defaultPrompt ?? null)}`)

    // ── E 组：反向一致（工作台接口改 → 面板刷新能看到）──
    const ROUND_TRIP = `${DISPATCH_TEXT}·改自工作台`
    await post('/api/workbench/orchestrator/default-prompt', { prompt: ROUND_TRIP })
    await page.click('.agent-tab:has-text("对话")')
    await page.click('.agent-tab:has-text("设置")')
    await page.waitForSelector('#aps-global', { timeout: 15000 })
    const shown = await waitFor(async () => {
      const v = await page.inputValue('#aps-global')
      return v === ROUND_TRIP ? v : null
    })
    check('E1 从工作台那边改完，重新打开设置面板显示的是新值（同一份数据，不是镜像）',
      !!shown, `面板显示 ${JSON.stringify(await page.inputValue('#aps-global'))}`)

    // ── F 组：运行时干净 ──
    // env-noise 是已知环境问题（LLM 配额，见上面 response 监听里的说明），不算本功能的账
    const realErrors = consoleErrors.filter(e => !e.startsWith('env-noise:'))
    check('F1 无 console / page 错误（LLM 配额类的环境噪音除外）',
      realErrors.length === 0 && pageErrors.length === 0,
      [...realErrors, ...pageErrors].slice(0, 3).join(' | '))
  } finally {
    await browser.close().catch(() => {})
    // 逐字还原：跑完不该在用户数据里留下任何痕迹
    await post('/api/config/save-ai-settings', { agentDefaultPrompt: backup.agentDefaultPrompt })
    await post('/api/workbench/orchestrator/default-prompt', { prompt: backup.defaultPrompt })
    log('已恢复原值')
  }
}

// ══════════════════════════════════════════════════════════════
;(async () => {
  for (const f of [AGENT_ROUTES, AGENT_CHAT, CHAT_PROMPTS, CONFIG_JS, PANEL, AGENT_VIEW]) {
    if (!fs.existsSync(f)) { console.error(`前置不足：缺少 ${path.relative(ROOT, f)}`); process.exit(2) }
  }

  staticChecks()

  if (REVERSE) {
    reverseChecks()
    const failed = results.filter(r => !r.ok)
    console.log(`\n${results.length - failed.length}/${results.length} 通过`)
    if (failed.length) { console.error('有断言没通过'); process.exit(1) }
    console.log('反证通过：A 组每条断言都如期翻红')
    process.exit(0)
  }

  await browserChecks()

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) {
    for (const f of failed) console.error(`  FAIL  ${f.name}${f.extra ? '  :: ' + f.extra : ''}`)
    process.exit(1)
  }
  process.exit(0)
})().catch((err) => {
  console.error('[verify] 异常:', err?.stack || err)
  process.exit(1)
})

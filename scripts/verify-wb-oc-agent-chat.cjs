/**
 * 主 Agent 控制台（工作台右栏）· 「对话 / 指令」双模式 的运行时验证。
 *
 * 守的契约（对应 OrchestratorConsole.vue / AgentChatSurface.vue）：
 *   C1  默认进「对话」模式：拨片在、两个 tab、对话那块是激活项
 *   C2  对话面真的铺开了（几何量，不是"元素存在"）：标题 / 引擎选择器 / 消息容器都有高度
 *   C3  对话模式底下的派发执行器：TaskExecutorPicker 在，且不是"引擎不会派活"的提示态
 *   C4  互斥：对话模式下活动日志 / Git 概览 / 派发输入框三块**都不可见**，
 *       但输入框仍在 DOM 里（v-show 不是 v-if —— 草稿不能在切模式时丢）
 *   C5  切「指令」：三块回来、对话面让位、偏好落盘 wb.ocMode.v1=command，
 *       且派发栏里仍有执行器下拉（第二处 TaskExecutorPicker 没被拆掉）
 *   C6  切回「对话」：反向成立、偏好写回 chat
 *   C7  持久化：切成 command 后 reload，仍是 command（常驻栏不该每次跳回默认）
 *   C8  改造没破坏既有输入框契约：指令模式下 rows=4 且高度 ≥ 76（P26）
 *   C9  折叠右栏：对话面跟着收起（不是"折叠了但对话还在底下跑"）
 *   C10 独立上下文里把引擎设成外部 CLI → 底部换成"只能对话、不能派发"的提示，
 *       执行器下拉让位（产品约束要当场说清，不能等用户撞上去）
 *
 * ⚠️ 断言一律用几何量（getBoundingClientRect / computed / offsetParent），不看截图下结论。
 * ⚠️ 文案断言同时接受中英（locale 是用户可切的），只对该口径敏感、不对具体语言敏感。
 *
 * 前置：后端已在 127.0.0.1:5545、前端已在 localhost:5544（即本仓库的 `npm run dev`）。
 * 用法：node scripts/verify-wb-oc-agent-chat.cjs
 *      ZEN_BASE=http://localhost:5544 ZEN_API=http://127.0.0.1:5545 node scripts/...
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544'
const API = process.env.ZEN_API || 'http://127.0.0.1:5545'
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'wb-oc-agent-chat-verify')

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 中英任一命中即算过 —— locale 是用户可切的，但这条口径不该跟着语言变 */
const T = {
  chat: ['对话', 'Chat'],
  command: ['指令', 'Command'],
  title: ['g ai 对话', 'g ai chat'],
  notice: ['只能对话，不能派发任务', 'can only chat, not dispatch'],
  footLabel: ['派发执行器', 'Dispatch executor'],
}
const hasText = (actual, alts) => alts.some((a) => String(actual || '').includes(a))

/** 页面侧测量：一次拿全"双模式"相关的可见性与几何 */
function MEASURE() {
  const info = (sel) => {
    const n = document.querySelector(sel)
    if (!n) return null
    const r = n.getBoundingClientRect()
    const cs = getComputedStyle(n)
    return {
      // offsetParent === null 覆盖 display:none（v-show）与祖先隐藏；fixed 元素另算，这里没有
      visible: n.offsetParent !== null,
      w: +r.width.toFixed(1),
      h: +r.height.toFixed(1),
      display: cs.display,
      text: (n.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100),
    }
  }
  const modeBtns = Array.from(document.querySelectorAll('.oc__mode-btn'))
  const ocEl = document.querySelector('.oc')
  const ocRect = ocEl ? ocEl.getBoundingClientRect() : null
  const chatWrap = document.querySelector('.acs__chat')
  const input = document.querySelector('.oc__input')
  const engineBtn = document.querySelector('.acs__engine .agent-engine__btn')
    || document.querySelector('.agent-engine__btn')
  const inpRect = input ? input.getBoundingClientRect() : null
  return {
    vw: window.innerWidth,
    vh: window.innerHeight,
    oc: ocRect ? { w: +ocRect.width.toFixed(1), h: +ocRect.height.toFixed(1) } : null,
    modeWrap: info('.oc__mode'),
    modeRole: document.querySelector('.oc__mode')?.getAttribute('role') || null,
    modeLabels: modeBtns.map(b => (b.innerText || '').trim()),
    modeSelected: modeBtns.filter(b => b.getAttribute('aria-selected') === 'true').map(b => (b.innerText || '').trim()),
    modeActiveClass: modeBtns.filter(b => b.classList.contains('is-active')).map(b => (b.innerText || '').trim()),
    // ── 对话面（AgentChatSurface 单根，class 由父级透传到 .acs 上）──
    chat: info('.oc__chat'),
    chatTitle: (document.querySelector('.acs__title')?.textContent || '').trim(),
    chatWrap: info('.acs__chat'),
    /** 消息容器里面那个库组件的**实际 class**（不猜类名，只确认它渲染出来了且占高） */
    chatChildClasses: chatWrap
      ? Array.from(chatWrap.children).map(c => String(c.className)).join(' | ').slice(0, 140)
      : null,
    engineBtn: engineBtn
      ? {
          text: (engineBtn.innerText || '').replace(/\s+/g, ' ').trim(),
          disabled: engineBtn.disabled === true,
          visible: engineBtn.offsetParent !== null,
        }
      : null,
    foot: info('.acs__foot'),
    footNotice: (document.querySelector('.acs__notice')?.innerText || '').replace(/\s+/g, ' ').trim(),
    footHasTep: !!document.querySelector('.acs__foot .tep'),
    footLabel: (document.querySelector('.acs__foot-label')?.textContent || '').trim(),
    footTepName: (document.querySelector('.acs__foot .tep__btn-name')?.textContent || '').trim(),
    // ── 指令模式那三块 ──
    feed: info('.oc__feed'),
    git: info('.oc__git'),
    compose: info('.oc__compose'),
    composeHasTep: !!document.querySelector('.oc__compose .tep'),
    /** 输入框在不在 DOM（v-show 与 v-if 的分水岭：草稿保不保得住） */
    inputInDom: !!input,
    input: input
      ? {
          h: +(inpRect?.height || 0).toFixed(1),
          visible: input.offsetParent !== null,
          rows: input.getAttribute('rows'),
          storedH: (() => { try { return localStorage.getItem('wb.ocInputHeight.v1') } catch { return null } })(),
        }
      : null,
    // ── 持久化 ──
    modeKey: (() => { try { return localStorage.getItem('wb.ocMode.v1') } catch { return null } })(),
    engineKey: (() => { try { return localStorage.getItem('zen-gitsync-agent-engine') } catch { return null } })(),
    execKey: (() => { try { return localStorage.getItem('zen-gitsync-task-executor') } catch { return null } })(),
    rail: info('.oc__rail'),
    collapseBtn: info('.oc__collapse'),
  }
}

const shots = []
async function shot(page, label) {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const file = path.join(SHOT_DIR, `${label}.png`)
  await page.screenshot({ path: file })
  shots.push({ label, file })
}

/**
 * 进入工作台（reload 后要重新点一次左侧活动栏）。
 *
 * ⚠️ 必须"先稳定、再重试"：应用初始化（配置 / 目录 / 首个接口）还没跑完时点导航，
 * 点完会被后续初始化覆盖回默认视图 —— 表现为 `.board` 一直等不到，但点的那一下
 * 并不报错。这不是产品 bug，是驱动的时序差异，所以这里重试而不是拉长单次超时。
 */
async function openBoard(page) {
  await page.waitForSelector('.activity-bar', { timeout: 30000 })
  await sleep(1200)
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.board').first().isVisible().catch(() => false)) break
    await page.locator('.activity-btn[aria-label^="工作台"]').first()
      .click({ timeout: 10000 }).catch(() => {})
    const ok = await page.waitForSelector('.board', { timeout: 12000 }).then(() => true).catch(() => false)
    if (ok) break
    await sleep(1500)
  }
  await page.waitForSelector('.board', { timeout: 20000 })
  await page.waitForSelector('.oc__mode', { timeout: 15000 })
  await sleep(900)
}

/** 点「对话 / 指令」拨片。按 aria-selected 现在的状态找目标按钮，不依赖顺序 */
async function switchMode(page, label) {
  const btn = page.locator('.oc__mode-btn', { hasText: new RegExp(Array.isArray(label) ? label.join('|') : label) }).first()
  await btn.click()
  await sleep(420)
}

/** 弹一个 el-dropdown 并把菜单项文案取出来（诊断用；也用于判断点得动没有） */
async function openDropdownItems(page, btnSel) {
  const btn = page.locator(btnSel).first()
  if (!(await btn.count())) return { opened: false, items: [] }
  await btn.click()
  await sleep(380)
  const items = await page.locator('.el-dropdown-menu__item').allInnerTexts().catch(() => [])
  return { opened: items.length > 0, items: items.map(t => t.replace(/\s+/g, ' ').trim()) }
}

async function main() {
  const alive = await fetch(`${API}/api/app-version`).then(r => r.ok).catch(() => false)
  if (!alive) {
    console.error(`后端没起（${API}）—— 先 npm run dev`)
    process.exit(2)
  }
  fs.rmSync(SHOT_DIR, { recursive: true, force: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  const M = () => page.evaluate(MEASURE)

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await openBoard(page)

    /* ══ C1 默认进「对话」 ══ */
    let m = await M()
    check('C1a 拨片在，role=tablist（是切换器，不是装饰）',
      !!m.modeWrap && m.modeWrap.visible && m.modeRole === 'tablist',
      `role=${m.modeRole} visible=${m.modeWrap?.visible}`)
    check('C1b 恰好两个 tab，文案是中/英的「对话」「指令」',
      m.modeLabels.length === 2
        && hasText(m.modeLabels[0], T.chat) && hasText(m.modeLabels[1], T.command),
      JSON.stringify(m.modeLabels))
    check('C1c 默认激活的是「对话」（且只有一个 aria-selected）',
      m.modeSelected.length === 1 && hasText(m.modeSelected[0], T.chat),
      `selected=${JSON.stringify(m.modeSelected)} active=${JSON.stringify(m.modeActiveClass)}`)
    check('C1d 全新上下文里还没有模式偏好（不该一开局就往盘上写脏值）',
      m.modeKey === null, `wb.ocMode.v1=${JSON.stringify(m.modeKey)}`)

    /* ══ C2 对话面真的铺开了 ══ */
    check('C2a 对话面可见且有实际高度（> 200px，不是塌成一条线）',
      !!m.chat && m.chat.visible && m.chat.h > 200,
      `visible=${m.chat?.visible} h=${m.chat?.h}`)
    check('C2b 消息容器渲染出来了并占高（> 140px）',
      !!m.chatWrap && m.chatWrap.visible && m.chatWrap.h > 140,
      `h=${m.chatWrap?.h} children=${m.chatChildClasses}`)
    check('C2c 对话面内有标题（g ai 对话）',
      hasText(m.chatTitle, T.title), `title="${m.chatTitle}"`)
    check('C2d 引擎选择器在，且新会话状态下**没被锁死**（置灰了就换不了引擎）',
      !!m.engineBtn && m.engineBtn.visible && m.engineBtn.disabled === false,
      `text="${m.engineBtn?.text}" disabled=${m.engineBtn?.disabled}`)
    await shot(page, '1600-chat-mode')

    /* ══ C3 对话模式底下的派发执行器 ══ */
    check('C3a 底部有「派发执行器」行 + TaskExecutorPicker',
      !!m.foot && m.foot.visible && m.footHasTep,
      `footH=${m.foot?.h} label="${m.footLabel}" tepName="${m.footTepName}"`)
    check('C3b 默认引擎是内置 g ai → **不出现**"不能派发"的提示',
      m.footNotice === '', `notice="${m.footNotice}"`)
    check('C3c 执行器下拉显示的是当前选择（非空，与工作台临时切换共用同一份）',
      m.footTepName.length > 0, `name="${m.footTepName}"`)

    /* ══ C4 互斥 + 草稿不丢 ══ */
    check('C4a 对话模式下活动日志不可见', !!m.feed && !m.feed.visible, `visible=${m.feed?.visible}`)
    check('C4b 对话模式下 Git 概览不可见', !!m.git && !m.git.visible, `visible=${m.git?.visible}`)
    check('C4c 对话模式下派发输入框不可见', !!m.compose && !m.compose.visible, `visible=${m.compose?.visible}`)
    check('C4d 但输入框仍在 DOM 里（v-show 不是 v-if —— 切模式不许丢草稿）',
      m.inputInDom === true, `inDom=${m.inputInDom}`)

    /* ══ C5 切「指令」 ══ */
    await switchMode(page, T.command[0])
    m = await M()
    check('C5a 激活项换成「指令」，且仍只有一个选中',
      m.modeSelected.length === 1 && hasText(m.modeSelected[0], T.command),
      `selected=${JSON.stringify(m.modeSelected)}`)
    check('C5b 偏好落盘 wb.ocMode.v1=command',
      m.modeKey === 'command', `wb.ocMode.v1=${JSON.stringify(m.modeKey)}`)
    check('C5c 活动日志 / 派发输入框回来，对话面让位',
      !!m.feed && m.feed.visible && !!m.compose && m.compose.visible && !!m.chat && !m.chat.visible,
      `feed=${m.feed?.visible} compose=${m.compose?.visible} chat=${m.chat?.visible}`)
    check('C5d 指令模式的派发栏里也有执行器下拉（第二处 TaskExecutorPicker 没被拆掉）',
      m.composeHasTep === true, `composeHasTep=${m.composeHasTep}`)
    check('C5e 输入框几何没被双模式改坏：rows=4 且高度 ≥ 76（P26 契约）',
      m.input?.rows === '4' && (m.input?.h || 0) >= 76,
      `rows=${m.input?.rows} h=${m.input?.h}`)
    await shot(page, '1600-command-mode')

    /* ══ C6 切回「对话」 ══ */
    await switchMode(page, T.chat[0])
    m = await M()
    check('C6a 切回对话：对话面可见、三块指令面板全部让位',
      // 一律用 ?. —— 变异测试（v-show → v-if）下元素会整个不存在，
      // 直接取 .visible 会让探针自己抛异常，那就测不出"该红没红"了
      !!m.chat?.visible && !m.feed?.visible && !m.git?.visible && !m.compose?.visible,
      `chat=${m.chat?.visible} feed=${m.feed?.visible} git=${m.git?.visible} compose=${m.compose?.visible}`)
    check('C6b 偏好写回 chat', m.modeKey === 'chat', `wb.ocMode.v1=${JSON.stringify(m.modeKey)}`)

    /* ══ C7 持久化：reload 后仍是 command ══ */
    await switchMode(page, T.command[0])
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openBoard(page)
    m = await M()
    check('C7a reload 后仍是「指令」（常驻栏不该每次跳回默认）',
      hasText(m.modeSelected[0], T.command) && !!m.compose?.visible && !m.chat?.visible,
      `selected=${JSON.stringify(m.modeSelected)} compose=${m.compose?.visible}`)
    check('C7b reload 后偏好键还在（没被初始化逻辑覆盖）',
      m.modeKey === 'command', `wb.ocMode.v1=${JSON.stringify(m.modeKey)}`)
    await shot(page, '1600-command-after-reload')

    /* ══ C8 reload 后对话面照样立得起来（回来时不塌） ══ */
    await switchMode(page, T.chat[0])
    m = await M()
    check('C8 反复切换后对话面依然有高度（> 200px，没有累积塌陷）',
      !!m.chat?.visible && m.chat.h > 200, `h=${m.chat?.h}`)
    /* ══ C9 折叠右栏：对话面跟着收起 ══ */
    const collapsed = await page.evaluate(() => {
      const b = document.querySelector('.oc__collapse')
      if (!b) return false
      b.click()
      return true
    })
    await sleep(520)
    m = await M()
    check('C9a 折叠按钮点得动，右栏收到 32px 收纳条',
      collapsed && m.oc?.w === 32, `collapsed=${collapsed} ocW=${m.oc?.w} rail=${m.rail?.w}`)
    check('C9b 折叠时对话面也跟着收起（不留一块在底下跑）',
      !m.chat?.visible && !m.modeWrap?.visible,
      `chat=${m.chat?.visible} mode=${m.modeWrap?.visible}`)
    await shot(page, '1600-collapsed')
    // 展开回来
    await page.evaluate(() => document.querySelector('.oc__rail')?.click())
    await sleep(520)
    m = await M()
    check('C9c 展开后对话面与拨片都回来', !!m.chat?.visible && !!m.modeWrap?.visible,
      `chat=${m.chat?.visible} mode=${m.modeWrap?.visible}`)

    /* ══ C10 外部引擎：不能派发的提示（独立上下文，避免污染上面那轮） ══ */
    const ctx2 = await browser.newContext({ viewport: { width: 1600, height: 900 } })
    await ctx2.addInitScript(() => {
      try { localStorage.setItem('zen-gitsync-agent-engine', 'opencode') } catch { /* 忽略 */ }
    })
    const page2 = await ctx2.newPage()
    page2.on('console', (c) => { if (c.type() === 'error') consoleErrors.push('[ctx2] ' + c.text()) })
    page2.on('pageerror', (e) => pageErrors.push('[ctx2] ' + String(e)))
    await page2.goto(BASE, { waitUntil: 'domcontentloaded' })
    await openBoard(page2)
    const m2 = await page2.evaluate(MEASURE)
    check('C10a 引擎键被读到（外部 CLI 生效）',
      m2.engineKey === 'opencode', `zen-gitsync-agent-engine=${JSON.stringify(m2.engineKey)} engineBtn="${m2.engineBtn?.text}"`)
    check('C10b 底部换成"只能对话、不能派发任务"的提示',
      hasText(m2.footNotice, T.notice), `notice="${m2.footNotice}"`)
    check('C10c 提示态下执行器下拉让位（说清为什么 + 别让人白点）',
      m2.footHasTep === false, `footHasTep=${m2.footHasTep}`)
    await shot(page2, '1600-chat-external-engine')

    /* ══ 反证：把模式键清掉，期望回到默认「对话」 ══ */
    await page.evaluate(() => localStorage.removeItem('wb.ocMode.v1'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openBoard(page)
    const m3 = await M()
    check('R1 反证：清掉偏好键后回落默认「对话」（证明 C5b/C7 真的在看这个键）',
      hasText(m3.modeSelected[0], T.chat) && !!m3.chat?.visible,
      `selected=${JSON.stringify(m3.modeSelected)} chat=${m3.chat?.visible}`)

    await ctx2.close()
  } catch (err) {
    check('脚本未抛异常', false, String(err && err.message))
    console.error(err)
  } finally {
    await browser.close()
  }

  // ── 出对比页 ────────────────────────────────────────────────────────
  const pairs = [
    { title: '默认（对话）：拨片 + g ai 对话面 + 底部派发执行器', a: '1600-chat-mode', b: null },
    { title: '对话 vs 指令（同一右栏，互斥的两块）', a: '1600-chat-mode', b: '1600-command-mode' },
    { title: 'reload 后仍是「指令」（偏好落盘）', a: '1600-command-after-reload', b: null },
    { title: '折叠右栏：对话面跟着收起', a: '1600-collapsed', b: null },
    { title: '引擎 = 外部 CLI：换成"不能派发"的提示，执行器下拉让位', a: '1600-chat-external-engine', b: null },
  ]
  const b64 = (f) => fs.readFileSync(path.join(SHOT_DIR, `${f}.png`)).toString('base64')
  const rowsHtml = pairs
    .filter(p => fs.existsSync(path.join(SHOT_DIR, `${p.a}.png`)))
    .map((p) => `
    <section class="row">
      <h2>${p.title}</h2>
      <div class="grid">
        <figure><figcaption>${p.b ? 'A' : '当前'}</figcaption><img src="data:image/png;base64,${b64(p.a)}"></figure>
        ${p.b && fs.existsSync(path.join(SHOT_DIR, `${p.b}.png`)) ? `<figure><figcaption>B</figcaption><img src="data:image/png;base64,${b64(p.b)}"></figure>` : ''}
      </div>
    </section>`).join('')
  const summary = results
    .map(r => `<li class="${r.ok ? 'ok' : 'bad'}">${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.extra ? ` <code>${r.extra}</code>` : ''}</li>`)
    .join('')
  const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<title>主 Agent 控制台 · 对话/指令 双模式</title>
<style>
  :root { color-scheme: light }
  body { margin:0; padding:24px; background:#f6f7f9; color:#1f2328; font:13px/1.6 -apple-system,"Segoe UI",sans-serif }
  h1 { font-size:18px; margin:0 0 4px }
  h2 { font-size:13px; font-weight:600; color:#57606a; margin:24px 0 8px }
  .meta { color:#6e7781; font-size:12px; margin-bottom:20px }
  .row { border-top:1px solid #d8dee4; padding-top:8px }
  .grid { display:flex; gap:12px; align-items:flex-start; overflow-x:auto }
  figure { margin:0; flex:1 1 0; min-width:0 }
  figcaption { font-size:11px; color:#6e7781; margin-bottom:6px }
  img { width:100%; display:block; border:1px solid #d0d7de; border-radius:4px }
  ul { list-style:none; padding:0; columns:2; font-size:12px }
  li { margin:2px 0; break-inside:avoid }
  li.bad { color:#cf222e }
  li.ok { color:#1a7f37 }
  code { color:#57606a }
</style></head><body>
<h1>主 Agent 控制台 · 「对话 / 指令」双模式</h1>
<p class="meta">同一页面同一份数据；断言全部是几何量 / computed / offsetParent，不看图下结论。截图仅供人眼复核。</p>
<h2>断言（${results.filter(r => r.ok).length}/${results.length} 通过）</h2>
<ul>${summary}</ul>
${rowsHtml}
</body></html>`
  const report = path.join(SHOT_DIR, 'report.html')
  fs.writeFileSync(report, html)

  const failed = results.filter(r => !r.ok)
  console.log(`\n用例 ${results.length}，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  failed.forEach(f => console.log(`  - ${f.name} ${f.extra}`))
  const real = consoleErrors.filter(e => !/Failed to fetch|获取当前目录失败|404|net::ERR|favicon/.test(e))
  console.log(`控制台错误(过滤噪音): ${real.length}`)
  real.slice(0, 8).forEach(e => console.log('  ! ' + e.slice(0, 220)))
  console.log(`页面异常: ${pageErrors.length}`)
  pageErrors.slice(0, 5).forEach(e => console.log('  ! ' + e.slice(0, 220)))
  console.log(`截图与报告: ${report}`)
  process.exit(failed.length || real.length || pageErrors.length ? 1 : 0)
}
main()

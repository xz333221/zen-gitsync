/**
 * 「复制会话」按钮的浏览器验收。
 *
 * 需求（2026-10-08 用户截图指出「对话」区）：g ai 会话要能整条复制出去。
 * 落地形态对齐工作台那个已存在的「复制执行内容」（WorkbenchView + utils/taskExecutionExport.ts）：
 * 主按钮直接点 = 精简范围（只留对话正文），右侧小箭头展开菜单可选全量（追加思考 / 工具调用）。
 *
 * 验收契约：
 *   A1 智能体页「对话」Tab 的头条右侧出现复制按钮（主按钮 + 范围箭头）
 *   A2 ★ 点主按钮 → 剪贴板拿到**整条会话**的 Markdown：
 *        抬头是 `# <会话标题>`、正文含 `## 我` 与 `## g ai`，且**不含**「### 思考 / ### 工具调用」
 *   A3 ★ 箭头菜单选「全量」→ 同一份文本里出现「### 思考」或「### 工具调用」，且比精简那份更长
 *   A4 切到 Skill 广场 → 按钮消失（它只属于「对话」这一段）
 *   B1 主 Agent 控制台（工作台右栏）也出现复制按钮，点下去同样拿到一份 Markdown
 *   R1 反向护栏：新建的空会话点复制 → 剪贴板**保持原样**（不是"复制了一个空串"）
 *
 * 为什么必须读**剪贴板真值**而不是只断言按钮在：这个功能的全部价值就是"粘出来是对的"，
 * 只验按钮存在等于什么都没验（与 verify-wb-copy-execution.cjs 同一条理由）。
 * 剪贴板靠 context 的 clipboard-read/write 授权直接读回，不走假替身。
 *
 * 前置：dev server 已启动（vite 5544 + 后端 5545；先 `npm run dev:ping` 两个 OK）。
 * 用法：node scripts/verify-agent-session-copy.cjs
 * 退出码：0 全通过，1 有失败项，2 脚本异常。
 */
const os = require('node:os')
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const API = BASE
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'zen-session-copy')

const results = []
const consoleErrors = []
const pageErrors = []
const skips = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
function skip(name, why) {
  skips.push({ name, why })
  console.log(`  SKIP  ${name}  :: ${why}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()

async function waitFor(fn, timeout = 10000, step = 150) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 > timeout) return false
    await sleep(step)
  }
}

async function main() {
  // ── 挑样本：当前项目下**内容够短、但真有思考或工具调用**的一条会话 ──────────
  const dirRes = await fetch(`${API}/api/current_directory`).then(r => r.json()).catch(() => ({}))
  const cwd = dirRes.directory || ''
  check('A0a 拿到当前项目目录', !!cwd, cwd)
  if (!cwd) { console.error('[verify] 拿不到当前目录，无法挑会话样本'); process.exit(2) }

  const listRes = await fetch(`${API}/api/agent/sessions?cwd=${encodeURIComponent(cwd)}`).then(r => r.json()).catch(() => ({}))
  const sessions = listRes.sessions || []
  check('A0b 当前项目下有 g ai 会话', sessions.length > 0, `${sessions.length} 条`)
  if (!sessions.length) { console.error('[verify] 当前项目没有会话样本'); process.exit(2) }

  /** 详情里数一下：有没有思考 / 工具调用（决定「全量」那条断言能不能立） */
  async function probe(id) {
    const res = await fetch(`${API}/api/agent/sessions/${encodeURIComponent(id)}`).then(r => r.json()).catch(() => ({}))
    const ms = (res.session && res.session.messages) || []
    const users = ms.filter(m => m.role === 'user')
    const assistants = ms.filter(m => m.role === 'assistant')
    return {
      ms,
      users,
      assistants,
      firstUser: (users[0] && typeof users[0].content === 'string') ? users[0].content : '',
      hasReasoning: assistants.some(m => typeof m.reasoning === 'string' && m.reasoning.trim()),
      hasTools: assistants.some(m => Array.isArray(m.tool_calls) && m.tool_calls.length > 0),
    }
  }

  // 候选按"消息少 → 渲染快"排（大会话要十几秒才画完），但必须有思考或工具调用
  const cands = sessions
    .filter(s => s.messageCount >= 4 && s.messageCount <= 120 && (s.title || '').trim())
    .sort((a, b) => a.messageCount - b.messageCount)
  let sample = null
  for (const s of cands.slice(0, 12)) {
    const p = await probe(s.sessionId)
    if (!p.firstUser.trim() || !p.assistants.length) continue
    if (!p.hasReasoning && !p.hasTools) continue
    sample = { s, p }
    break
  }
  if (!sample) {
    // 没有"带思考/工具调用"的样本时，降级成任意一条有正文的会话（A3 会退化为 SKIP）
    for (const s of cands.slice(0, 12)) {
      const p = await probe(s.sessionId)
      if (p.firstUser.trim() && p.assistants.some(m => typeof m.content === 'string' && m.content.trim())) {
        sample = { s, p }
        break
      }
    }
  }
  check('A0c 挑到一条可验证的会话样本', !!sample,
    sample ? `「${sample.s.title.slice(0, 18)}」${sample.s.messageCount} 条｜思考=${sample.p.hasReasoning} 工具=${sample.p.hasTools}` : '没有')
  if (!sample) { console.error('[verify] 没有可用的会话样本'); process.exit(2) }

  const firstUser = norm(sample.p.firstUser).slice(0, 18)
  const titlePrefix = norm(sample.s.title).slice(0, 8)

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 950 },
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  const readClipboard = () => page.evaluate(() => navigator.clipboard.readText().catch(() => ''))
  const writeClipboard = (t) => page.evaluate((v) => navigator.clipboard.writeText(v), t)

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    // 首屏可能正赶上 vite 重打包（空 RootWebArea），重载一次再判（见 lessons 里那条）
    await page.waitForSelector('.activity-bar', { timeout: 30000 }).catch(async () => {
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.activity-bar', { timeout: 30000 })
    })
    await page.locator('.loading-container').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})

    // ── 右下角 g ai dock（2026-10 起 AI 对话入口从活动栏 tab 整合为 dock）────────
    await page.click('.agent-dock__mascot')
    await page.waitForSelector('.agent-view', { timeout: 15000 })
    // 最大化：dock 默认 560px 是窄面板（会话列表折成独立页、复制按钮进紧凑态），
    // 本探针守的会话列表 + 复制按钮契约要宽屏两栏，先拉满
    await page.click('.agent-dock__btn--max')
    await page.waitForSelector('.agent-sidebar', { timeout: 10000 })
    await sleep(1200)

    const COPY = '.agent-tabs .csb'
    const MAIN = '.agent-tabs .csb .csb__btn:not(.csb__caret)'
    check('A1 ★ 智能体页头条出现复制按钮（主按钮 + 范围箭头）',
      await page.locator(COPY).count() === 1 &&
      await page.locator(MAIN).count() === 1 &&
      await page.locator('.agent-tabs .csb .csb__caret').count() === 1,
      `csb=${await page.locator(COPY).count()}`)

    // 打开样本会话（按标题前缀定位；列表里的标题就是服务端那份）
    const items = page.locator('.agent-conversations .acu-conv-item')
    await items.first().waitFor({ timeout: 10000 }).catch(() => {})
    const idx = await page.evaluate((prefix) => {
      const list = [...document.querySelectorAll('.agent-conversations .acu-conv-item')]
      return list.findIndex(el => (el.textContent || '').replace(/\s+/g, ' ').includes(prefix))
    }, titlePrefix)
    check('A1b 样本会话出现在列表里', idx >= 0, `标题前缀「${titlePrefix}」→ 第 ${idx} 项`)
    if (idx < 0) throw new Error('样本会话不在列表里（列表可能被搜索框过滤）')
    await items.nth(idx).click()
    // 会话渲染要时间：等第一条用户气泡出现并包含样本首句
    const opened = await waitFor(async () => {
      const t = await page.evaluate(() => {
        const el = document.querySelector('.agent-chat-host .acu-bubble-row.is-user')
        return el ? el.textContent || '' : ''
      })
      return norm(t).includes(firstUser.slice(0, 10))
    }, 20000, 400)
    check('A1c 已打开目标会话（首条提问对得上）', opened, `首句「${firstUser}」`)
    if (!opened) throw new Error('会话没渲染出来')

    // ── A2 精简 ────────────────────────────────────────────────────────────
    await writeClipboard('__SENTINEL__')
    await page.locator(MAIN).click()
    await sleep(700)
    const brief = await readClipboard()
    check('A2a ★ 点主按钮后剪贴板拿到会话 Markdown（抬头 = 会话标题）',
      brief !== '__SENTINEL__' && brief.startsWith('# ') && brief.split('\n')[0].includes(titlePrefix),
      `首行「${(brief.split('\n')[0] || '').slice(0, 40)}」`)
    check('A2b 正文按「## 我 / ## g ai」分角色，且带上首条提问原文',
      brief.includes('## 我') && brief.includes('## g ai') && brief.includes(firstUser.slice(0, 10)),
      `含"## 我"=${brief.includes('## 我')} 含"## g ai"=${brief.includes('## g ai')}`)
    check('A2c ★ 精简范围不含思考与工具调用（它们才是体积大头）',
      !brief.includes('### 思考') && !brief.includes('### 工具调用'),
      `思考=${brief.includes('### 思考')} 工具=${brief.includes('### 工具调用')}；长度 ${brief.length}`)

    await page.screenshot({ path: path.join(SHOT_DIR, 'agent-view.png') }).catch(() => {})

    // ── A3 全量（箭头菜单） ────────────────────────────────────────────────
    await writeClipboard('__SENTINEL__')
    await page.locator('.agent-tabs .csb .csb__caret').click()
    const menu = page.locator('.el-dropdown-menu__item:visible')
    const menuOk = await waitFor(async () => (await menu.count()) >= 2, 5000, 150)
    check('A3a 箭头点开后有「范围」菜单（两项）', menuOk, `项数 ${await menu.count()}`)
    if (menuOk) {
      await menu.nth(1).click()
      await sleep(700)
      const full = await readClipboard()
      const hasDetail = full.includes('### 思考') || full.includes('### 工具调用')
      if (sample.p.hasReasoning || sample.p.hasTools) {
        check('A3 ★ 全量范围带上思考 / 工具调用，且比精简那份更长',
          full !== '__SENTINEL__' && hasDetail && full.length > brief.length,
          `思考=${full.includes('### 思考')} 工具=${full.includes('### 工具调用')}；长度 ${brief.length} → ${full.length}`)
      } else {
        skip('A3 全量范围', '样本会话里既没有思考也没有工具调用，全量与精简本就等价')
      }
    } else {
      check('A3 ★ 全量范围', false, '菜单没出来')
    }

    // ── A4 只在「对话」Tab ─────────────────────────────────────────────────
    await page.locator('.agent-tab', { hasText: 'Skill' }).first().click()
    await sleep(800)
    check('A4 切到 Skill 广场后复制按钮消失（它只属于对话那一段）',
      await page.locator(COPY).count() === 0,
      `csb=${await page.locator(COPY).count()}`)
    await page.locator('.agent-tab', { hasText: '对话' }).first().click()
    await sleep(500)

    // ── R1 空会话不写剪贴板（反向护栏） ────────────────────────────────────
    await page.locator('.agent-conversations .acu-conv-new').first().click()
    await sleep(900)
    await writeClipboard('__SENTINEL__')
    await page.locator(MAIN).click()
    await sleep(700)
    const afterEmpty = await readClipboard()
    check('R1 空会话点复制不写剪贴板（不是"复制了个空串"）',
      afterEmpty === '__SENTINEL__',
      `剪贴板${afterEmpty === '__SENTINEL__' ? '未被改写' : '被改写成 ' + afterEmpty.slice(0, 30)}`)

    // B 组（原「主 Agent 控制台对话面的复制按钮」）随 2026-10-25 控制台改造移除：
    // 工作台控制台不再有「对话」档（聊天统一走右下角 dock），复制契约随
    // AgentChatSurface 组件一起下线。
    // C 组（原「文件空间 g ai 面板」实地检查）随 2026-10 入口整合移除：
    // 编辑器 AI 面板已并入右下角 dock，复制按钮契约由 A1/A2 与
    // verify-agent-input-facts 的 dock 侧用例守，这里不再重复。
  } catch (err) {
    check('脚本异常', false, String((err && err.message) || err))
  } finally {
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

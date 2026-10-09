/**
 * 智能体对话「失败自动重试 + 重试按钮」的验证（2026-10-09 加的能力）。
 *
 * 验收契约（改这块时别破坏）：
 *   A 传输层自动重试时，前端要**回退到断点**再渲染新尝试的内容 ——
 *     只丢掉失败那次尝试吐的字，不会出现"半截 + 重来一遍"拼在一起的两段话
 *   B 每次都弹一条带次数的提示（用户得知道它在自愈，而不是"卡住不动"）
 *   C 错误气泡里那颗「重试」真的会再发一次请求，且带 `resume: true`
 *     —— 服务端靠它接着上一轮跑而不是把 user 消息重发一遍
 *   D 重试成功后错误气泡消失、正文换成新一次的
 *
 * 为什么把 /api/agent/chat 换掉：真网关不会按我们安排的节奏"先吐半截再断"，
 * 而恰恰是那个时序决定了前端有没有把半截丢掉。所以这里用 route 直接喂脚本化的 SSE
 * （事件类型与字段与 server/routes/workbench/agentChat.js 的下发口径一致）。
 *
 * 前置：vite dev server 已启动（5544，走的是 HMR 链路）。
 * 用法：node scripts/verify-agent-llm-retry.cjs
 * 退出码：0 全通过，1 有失败项。
 */
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const SHOT = path.resolve(__dirname, '../tmp-verify-agent-llm-retry.png')
const FAKE_SESSION_ID = 'ag-verify-retry-1'

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()

/** 与 agentChat.js 同一形状的 SSE 响应 */
const sse = (events) => ({
  status: 200,
  headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  body: events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''),
})

// 第一轮：先吐半截正文 → 传输层判定断流 → 发 retry 通知前端回退 → 再吐新正文 → 最后失败。
// 这是"自动重试也没救回来"的收场，正好接着验按钮。
const ROUND_FAIL = sse([
  { type: 'meta', sessionId: FAKE_SESSION_ID, isNew: true, title: '验证用会话' },
  { type: 'attempt', attempt: 1 },
  { type: 'content', delta: '这是被丢掉的那半截。' },
  { type: 'retry', attempt: 1, maxRetries: 10, delayMs: 500, reason: '模型响应意外中断，请重试；未执行不完整的工具调用。' },
  { type: 'content', delta: '第二次尝试的正文。' },
  { type: 'error', error: 'LLM 请求失败: 模型响应超时：连续 300 秒没有收到任何数据。' },
  { type: 'turn_done', turnIndex: 0, durationMs: 61000 },
])

// 第二轮（点「重试」之后）：接着上一轮跑完
const ROUND_OK = sse([
  { type: 'meta', sessionId: FAKE_SESSION_ID, isNew: false, title: '验证用会话' },
  { type: 'attempt', attempt: 1 },
  { type: 'content', delta: '重试之后跑完了。' },
  { type: 'done', content: '重试之后跑完了。' },
  { type: 'turn_done', turnIndex: 0, durationMs: 4200 },
])

// 反向对照：**不发** attempt 事件时，前端没有断点可回退 —— 两段正文必须都在。
// 没有这一档，A2 就分不清"回退真的生效"和"本来就只有一段"。
const ROUND_NO_MARK = sse([
  { type: 'meta', sessionId: FAKE_SESSION_ID, isNew: false, title: '验证用会话' },
  { type: 'content', delta: 'A段。' },
  { type: 'retry', attempt: 1, maxRetries: 10, delayMs: 500, reason: '模型响应意外中断' },
  { type: 'content', delta: 'B段。' },
  { type: 'error', error: 'LLM 请求失败: 模型响应超时' },
])

const bubbleText = (page) => page.evaluate(() => {
  const rows = [...document.querySelectorAll('.acu-bubble-row.is-assistant')]
  const last = rows[rows.length - 1]
  if (!last) return ''
  const body = last.querySelector('.acu-bubble-main') || last
  return body.innerText || body.textContent || ''
})

async function waitFor(fn, timeout = 12000, step = 200) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 > timeout) return false
    await sleep(step)
  }
}

async function main() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  // 引擎必须是内置 g ai：外部 CLI 每轮新起进程，服务端没有中途状态可续，前端会直接拒绝重试
  await page.addInitScript(() => { try { localStorage.setItem('zen-gitsync-agent-engine', 'gai') } catch {} })

  const bodies = []
  let round = 0
  await page.route('**/api/agent/chat', async (route) => {
    bodies.push(route.request().postDataJSON() || {})
    const payload = round === 0 ? ROUND_FAIL : (round === 2 ? ROUND_NO_MARK : ROUND_OK)
    round += 1
    await route.fulfill(payload)
  })

  // 会话列表也得喂一条：AgentView 在"流式刚结束"时会 loadSessions()，
  // 若当前会话不在列表里就 newSession() 把这一屏清掉（那条护栏防的是"会话被别的项目抢走"）。
  // 不喂的话，第一轮刚跑完界面就自己新开一条会话 —— 验的就不是重试了。
  await page.route('**/api/agent/sessions*', async (route) => {
    const cwd = new URL(route.request().url()).searchParams.get('cwd') || ''
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        sessions: [{
          sessionId: FAKE_SESSION_ID,
          title: '验证用会话',
          source: 'web',
          cwd,
          model: '',
          engine: 'gai',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messageCount: 1,
          size: 0,
        }],
      }),
    })
  })

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 30000 }).catch(async () => {
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.activity-bar', { timeout: 30000 })
    })
    await page.locator('.loading-container').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})

    // ── 进智能体页，发一条消息 ────────────────────────────────────────────
    await page.locator('.activity-btn[aria-label^="智能体"]').first().click()
    await page.waitForSelector('.agent-tabs', { timeout: 15000 })
    await sleep(1000)

    const input = page.locator('.agent-chat-host .acu-input-wrap textarea, .agent-tabs .acu-input-wrap textarea').first()
    await input.waitFor({ timeout: 15000 })
    await input.fill('验证重试')

    // toast 只活 3 秒，等错误气泡的时候它可能已经飘走了 —— 边等边收
    const toasts = new Set()
    const collectToasts = async () => {
      try {
        for (const t of await page.locator('.el-message').allInnerTexts()) toasts.add(norm(t))
      } catch { /* 页面正在重绘，下一轮再收 */ }
    }
    const poll = setInterval(() => { collectToasts() }, 150)

    await input.press('Enter')

    const sawError = await waitFor(async () => {
      await collectToasts()
      return (await page.locator('.acu-retry-btn').count()) > 0
    })
    clearInterval(poll)
    await collectToasts()
    check('A1 失败后出现错误气泡与「重试」按钮', sawError,
      `重试按钮数=${await page.locator('.acu-retry-btn').count()}`)

    const text = norm(await bubbleText(page))
    check('A2 ★ 断点回退：气泡里只剩第二次尝试的正文，被丢掉的那半截不在',
      text.includes('第二次尝试的正文') && !text.includes('被丢掉的那半截'),
      `气泡文字「${text.slice(0, 80)}」`)

    check('B1 自动重试时弹了提示（含次数与原因）',
      [...toasts].some(t => t.includes('正在自动重试') && t.includes('1/10')),
      `toast=${JSON.stringify([...toasts]).slice(0, 200)}`)

    check('A3 第一次请求不带 resume（正常发送）', bodies.length >= 1 && bodies[0].resume !== true,
      `第 1 次请求 resume=${bodies[0] && bodies[0].resume}`)

    await page.screenshot({ path: SHOT }).catch(() => {})

    // ── 点「重试」────────────────────────────────────────────────────────
    await page.locator('.acu-retry-btn').first().click()
    const second = await waitFor(async () => bodies.length >= 2, 12000, 200)
    check('C1 「重试」再发了一次请求', second, `请求数=${bodies.length}`)

    const body2 = bodies[1] || {}
    check('C2 ★ 重试请求带 resume: true 与会话 id（接着上一轮跑，而不是重发 user）',
      body2.resume === true && body2.sessionId === FAKE_SESSION_ID,
      `resume=${body2.resume} sessionId=${body2.sessionId}`)
    check('C3 重试请求不带 userMessage（服务端不需要它）',
      !body2.userMessage, `userMessage=${JSON.stringify(body2.userMessage)}`)

    // 一个判据里同时等两件事：错误按钮消失 **且** 正文换成第二次尝试的结果。
    // 分成两步会假红 —— 点下去那一刻气泡已经被清空，正文还在路上（那正是"回退"的中间态）。
    const recovered = await waitFor(async () => {
      if ((await page.locator('.acu-retry-btn').count()) > 0) return false
      return norm(await bubbleText(page)).includes('重试之后跑完了')
    })
    const text2 = norm(await bubbleText(page))
    check('D1 重试成功后错误气泡消失、正文换成新一次的结果',
      recovered && !text2.includes('第二次尝试的正文'),
      `错误按钮=${await page.locator('.acu-retry-btn').count()} 气泡文字「${text2.slice(0, 60)}」`)

    await page.screenshot({ path: SHOT }).catch(() => {})
    log('截图:', SHOT)

    // ── F 反向对照：没有 attempt 断点时不回退 ─────────────────────────────
    await page.locator('.acu-input-wrap textarea').first().fill('验证反向对照')
    await page.locator('.acu-input-wrap textarea').first().press('Enter')
    const bothKept = await waitFor(async () => {
      const t = norm(await bubbleText(page))
      return t.includes('A段') && t.includes('B段')
    })
    check('F1 ★ 反向对照：没有 attempt 事件时两段正文都在（证明 A2 的回退真的在起作用）',
      bothKept && round === 3, `气泡文字「${norm(await bubbleText(page)).slice(0, 60)}」 请求数=${round}`)

    // 存量红：组件库 MessageRail 的 getBoundingClientRect 报错 + 与本轮无关的 i18n key 警告
    // （见 lessons/pre-existing-red-baseline.md，归因先看 git status，别当成自己引入的）
    const faults = [...consoleErrors, ...pageErrors].filter(t =>
      !t.includes('getBoundingClientRect') && !t.includes('Not found \'@A1833'))
    check('E1 页面无 console / page 错误（存量那两条不算）', faults.length === 0,
      faults.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n[verify] ${results.length - failed.length}/${results.length} 通过`)
  for (const f of failed) console.log(`  FAIL  ${f.name}  :: ${f.extra}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify] 异常退出:', err); process.exit(1) })

/**
 * 智能体对话里的「文件改动」清单（组件库 FileChangeList / utils/fileChange）。
 *
 * 契约（2026-10-29）：
 *   A 一轮里改了文件 → assistant 气泡里出现「文件改动」清单，列出文件与 +/− 行数
 *   B 点一行 → 展开 unified diff（有 + 行、有 − 行，不是把整份参数 JSON 铺出来）
 *   C 反向对照：只读文件（read_file）的那一轮**不能**出现清单 ——
 *     否则"清单在"这件事可能是恒绿的（随便挂块空壳也满足 A）
 *   D（--reverse）把 A/C 的期望互换，应当整组报红 —— 证明断言真的在读内容
 *
 * 前置：vite dev server（5544）已启动，且组件库新 dist 已拷进宿主的
 *       node_modules/zen-ai-chat-ui/dist（改完库要重启 vite 的预打包）。
 * 用法：node scripts/verify-agent-file-changes.cjs [--reverse]
 * 退出码：0 全通过，1 有失败项。
 */
const path = require('node:path')
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const REVERSE = process.argv.includes('--reverse')
const SHOT = path.resolve(__dirname, '../tmp/verify-agent-file-changes.png')
const FAKE_SESSION_ID = 'ag-verify-filechange-1'

const results = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()

const sse = (events) => ({
  status: 200,
  headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  body: events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''),
})

/** 一轮：edit_file 精确替换（2 行 → 4 行，1 增 1 删）+ 一句收尾正文 */
const ROUND_EDIT = sse([
  { type: 'meta', sessionId: FAKE_SESSION_ID, isNew: true, title: '验证文件改动' },
  { type: 'attempt', attempt: 1 },
  {
    type: 'tool_call_start',
    toolCallId: 'fc-t1',
    name: 'edit_file',
    argsPreview: 'src/demo.ts',
    arguments: JSON.stringify({
      path: 'src/demo.ts',
      old_string: 'export const a = 1\nconst b = 2',
      new_string: 'export const a = 3\nconst b = 4\nconst c = 5'
    })
  },
  { type: 'tool_result', toolCallId: 'fc-t1', name: 'edit_file', result: '已替换 src/demo.ts（唯一匹配）' },
  { type: 'content', delta: '已经把 demo.ts 的常量改掉了。' },
  { type: 'done', content: '已经把 demo.ts 的常量改掉了。' },
  { type: 'turn_done', turnIndex: 0, durationMs: 1234 }
])

/** 反向对照：只读文件的一轮，任何「文件改动」清单都不该出现 */
const ROUND_READ = sse([
  { type: 'meta', sessionId: FAKE_SESSION_ID, isNew: false, title: '验证文件改动' },
  { type: 'attempt', attempt: 1 },
  {
    type: 'tool_call_start',
    toolCallId: 'fc-t2',
    name: 'read_file',
    argsPreview: 'src/demo.ts',
    arguments: JSON.stringify({ path: 'src/demo.ts' })
  },
  { type: 'tool_result', toolCallId: 'fc-t2', name: 'read_file', result: '1|export const a = 3' },
  { type: 'content', delta: '读完了。' },
  { type: 'done', content: '读完了。' },
  { type: 'turn_done', turnIndex: 1, durationMs: 900 }
])

/** 最后一条 assistant 气泡里的文件改动块 */
function lastBubbleFileChanges(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('.acu-bubble-row.is-assistant')]
    const last = rows[rows.length - 1]
    if (!last) return null
    const block = last.querySelector('.acu-filechanges')
    if (!block) return null
    const rowEls = [...block.querySelectorAll('.acu-filechanges-row')]
    return {
      title: (block.querySelector('.acu-filechanges-title')?.textContent || '').trim(),
      count: rowEls.length,
      rows: rowEls.map(el => ({
        text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
        expanded: el.getAttribute('aria-expanded')
      })),
      patch: (block.querySelector('.acu-filechanges-patch')?.textContent || ''),
      adds: block.querySelectorAll('.acu-filechanges-patch-line.is-add').length,
      dels: block.querySelectorAll('.acu-filechanges-patch-line.is-del').length
    }
  })
}

async function waitFor(fn, timeout = 15000, step = 200) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 > timeout) return false
    await sleep(step)
  }
}

async function sendMessage(page, text) {
  const input = page.locator('.agent-tabs .acu-input-textarea, .agent-chat-host .acu-input-textarea').first()
  await input.waitFor({ timeout: 15000 })
  await input.fill(text)
  await input.press('Enter')
}

async function main() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await page.addInitScript(() => { try { localStorage.setItem('zen-gitsync-agent-engine', 'gai') } catch {} })

  let round = 0
  await page.route('**/api/agent/chat', async (route) => {
    const payload = round === 0 ? ROUND_EDIT : ROUND_READ
    round += 1
    await route.fulfill(payload)
  })

  // 流式结束后 AgentView 会 loadSessions()，会话不在列表里就 newSession() 清屏（见 lessons）
  await page.route('**/api/agent/sessions*', async (route) => {
    const cwd = new URL(route.request().url()).searchParams.get('cwd') || ''
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        sessions: [{
          sessionId: FAKE_SESSION_ID,
          title: '验证文件改动',
          source: 'web',
          cwd,
          model: '',
          engine: 'gai',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }]
      })
    })
  })

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 30000 }).catch(async () => {
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.activity-bar', { timeout: 30000 })
    })
    await page.locator('.loading-container').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})

    await page.click('.agent-dock__mascot')
    await page.waitForSelector('.agent-tabs', { timeout: 15000 })
    await sleep(1000)
    // 有历史会话时欢迎页不出现，输入框照样在；直接发
    await sendMessage(page, '改一下 demo.ts')

    const appeared = await waitFor(async () => (await lastBubbleFileChanges(page)) !== null)
    const block = await lastBubbleFileChanges(page)

    // ── A 清单出现且内容对得上 ─────────────────────────────────
    check(REVERSE ? 'A0（反证）改文件后不该出现清单' : 'A1 改文件后出现「文件改动」清单',
      REVERSE ? !appeared : appeared, `block=${JSON.stringify(block)}`)
    if (block) {
      const titleOk = block.title.includes('文件改动') && block.count === 1
      check(REVERSE ? 'A0（反证）标题不该是「文件改动」' : 'A2 标题是「文件改动」、只列 1 个文件',
        REVERSE ? !titleOk : titleOk,
        `title=${block.title} rows=${block.count}`)
      const row = block.rows[0]?.text || ''
      const rowOk = row.includes('demo.ts') && row.includes('+3') && row.includes('−2')
      check(REVERSE ? 'A0（反证）行里不该有文件名与增删行数' : 'A3 行里是文件名 + 增删行数（+3 −2）',
        REVERSE ? !rowOk : rowOk,
        `row=${row}`)
    }

    // ── B 点开展开 diff ───────────────────────────────────────
    if (block) {
      await page.locator('.acu-bubble-row.is-assistant').last()
        .locator('.acu-filechanges-row').first().click()
      const expanded = await waitFor(async () => {
        const next = await lastBubbleFileChanges(page)
        return !!next && next.patch.length > 0
      })
      const out = await lastBubbleFileChanges(page)
      check(REVERSE ? 'B0（反证）展开后不该有 diff' : 'B1 点一行展开出 unified diff（含 + 行与 − 行）',
        REVERSE
          ? !(expanded && out.adds > 0 && out.dels > 0)
          : (expanded && out.adds > 0 && out.dels > 0),
        `adds=${out?.adds} dels=${out?.dels} patch=${norm(out?.patch).slice(0, 100)}`)
      check(REVERSE ? 'B0（反证）diff 里不该有内容' : 'B2 diff 里有新写入的那行内容',
        REVERSE ? !String(out?.patch || '').includes('const c = 5') : String(out?.patch || '').includes('const c = 5'),
        `patch=${norm(out?.patch).slice(0, 120)}`)
    }

    await page.screenshot({ path: SHOT }).catch(() => {})

    // ── C 反向对照：只读文件的一轮不出清单 ─────────────────────
    await sendMessage(page, '再看一眼 demo.ts')
    const readRoundDone = await waitFor(async () => {
      const text = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.acu-bubble-row.is-assistant')]
        const last = rows[rows.length - 1]
        return last ? (last.textContent || '') : ''
      })
      return text.includes('读完了')
    })
    const afterRead = await lastBubbleFileChanges(page)
    check(REVERSE ? 'C0（反证）只读文件的一轮也该有清单' : 'C1 只读文件的一轮不出文件改动清单',
      REVERSE ? !!afterRead : !afterRead,
      `readRoundDone=${readRoundDone} block=${JSON.stringify(afterRead)}`)

    // 存量 pageerror：库的 MessageRail 在无布局上下文的元素上量 rect（与本功能无关，见 lessons）
    const fresh = pageErrors.filter(e => !e.includes('getBoundingClientRect is not a function'))
    check('D1 没有新引入的 pageerror', fresh.length === 0, fresh.slice(0, 2).join(' | '))
  } finally {
    await browser.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 项失败`}（共 ${results.length} 项）`)
  console.log('截图:', SHOT)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

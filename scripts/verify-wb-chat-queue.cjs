/**
 * 任务执行页「排队续聊」条带的验证（2026-11-13）。
 *
 * 背景：g ai 的四个入口早就用组件库 ChatInput 自带的排队条带（`queued` / `queuePaused`
 * / `queueLabels`），只有工作台的任务执行页是宿主手写的一坨 `.wb-chat-queue` ——
 * 同一个东西两副长相：库那份在输入框**里面**，手写那份在输入框**上面**，
 * 序号 / 移除按钮 / 文案也各写各的。用户 2026-11-13 反馈"感觉不统一"。
 * 现在任务执行页也交给库渲染，宿主只留两件事：把队列翻译成 QueuedMessage 形状、
 * 把 `--acu-queue-*` 映射到本项目「待处理」档的语义色。
 *
 * 验收契约（改这块时别破坏）：
 *   A 条带是库的那一份，且长在输入框内部（不是宿主在输入框上方另起一块）
 *   B 文案走 agentQueueLabels()，与智能体页逐字一致（排队中 / 本轮结束后依次发送）
 *   C 队列按发送顺序排号，正文原样显示；附件只显示文件名，不提前上传
 *   D 移除按钮删的是**那一条**（不是整队清空，也不是删错行）
 *   E 语义色：边框 / 底色取 --role-pending-edge / --role-pending-surface
 *   F 本轮跑完自动接棒：POST 到 jobs/<jobId>/continue，带的是队首那句
 *   G 接棒失败 → 队列暂停在原处，队首出现「立即发送」，点它再发一次
 *   H 页面无 console / page 错误
 *   R 负控（--reverse）：把条带挪回输入框外 + 把语义色覆盖回中性灰（= 手写那份的样子），
 *     A2 / A3 / E1 / E2 必须翻红。它们证明这几条断言真的落在"库那份 + 本项目配色"上，
 *     而不是"只要有个队列就算过"。
 *
 * 前置：vite dev server 已启动（5544）。后端**不需要** —— 接口全由 page.route 桩掉，
 * SSE 也在 addInitScript 里换成假的（真 EventSource 会连 5545 失败，刷一屏代理错误）。
 * 用法：node scripts/verify-wb-chat-queue.cjs [--reverse]
 * 退出码：0 全通过（--reverse 时＝指定那几条确实红了），1 有失败项。
 */
const fs = require('node:fs')
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const CHROME = process.env.ZEN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const REVERSE = process.argv.includes('--reverse')

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function waitFor(fn, ms = 8000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await sleep(100)
  }
}

const PROJECT_PATH = 'D:\\ws\\zen-gitsync'
const TASK_ID = 'syn-q'
const JOB_ID = 'job-q1'
const FIRST = '第一句：等这一轮跑完再发'
const SECOND = '第二句：带个附件'
const ATT_NAME = 'queue-shot.png'
/** 与 utils/agentConversations.ts 的 agentQueueLabels() 逐字一致 */
const LABEL_TITLE = '排队中'
const LABEL_HINT = '本轮结束后依次发送'
const LABEL_PAUSED_HINT = '已暂停，点「立即发送」继续'
const LABEL_FLUSH = '立即发送'

function fixture() {
  const at = (minAgo) => new Date(Date.now() - minAgo * 60 * 1000).toISOString()
  const boardTask = {
    id: TASK_ID, title: '【合成】Q：排队续聊', desc: '', projectPath: PROJECT_PATH,
    column: 'doing', attachmentCount: 0, runningJobs: 1,
    live: {
      jobId: JOB_ID, status: 'running', agent: 'claude', startedAt: at(3), pid: 4242,
      elapsedMs: 3 * 60 * 1000, toolCallCount: 2, lastTool: 'Read a.ts',
      toolMix: 'Read×2', lastThought: '', lastLine: '正在跑', silentMs: null,
    },
    lastReply: null, lastJobAgent: 'claude', lastJobStatus: 'running',
    lastJobEndedAt: null, createdAt: at(60), updatedAt: at(3),
  }
  const task = {
    id: TASK_ID, title: boardTask.title, desc: '', promptId: null, simpleOverride: '',
    projectPath: PROJECT_PATH, status: 'doing', attachments: [],
    createdAt: boardTask.createdAt, updatedAt: boardTask.updatedAt,
  }
  // 对话区只在「这条任务真有 job」时才渲染（simpleAllJobsFor），所以必须给一条
  const job = {
    id: JOB_ID, taskId: TASK_ID, subId: `${TASK_ID}__simple`, status: 'running',
    agent: 'claude', startedAt: at(3), endedAt: null, exitCode: null,
    prompt: '把排队条带换成组件库自带的', output: '正在改…', thinking: '',
    claudeSessionId: 'sess-syn',
  }
  const project = {
    path: PROJECT_PATH, key: PROJECT_PATH.toLowerCase(), name: 'zen-gitsync',
    source: 'both', isCurrent: true, git: null,
    stats: { total: 1, todo: 0, doing: 1, done: 0, progress: 0, runningJobs: 1, lastActiveAt: at(3) },
  }
  return { board: [boardTask], tasks: [task], jobs: [job], project }
}

/**
 * 读条带：结构（是不是库那份、在不在输入框里）、文案、每条内容、几何、配色。
 *
 * 颜色不能拿 var() 的原始字符串比：--role-pending-* 是 color-mix()，
 * Chrome 的计算值会序列化成 color(srgb ...)。这里现造一个参照元素、让它吃同一个变量，
 * 两边都读计算值 —— 变量定义怎么变都跟着走，不会两边对不上。
 */
function readQueue(page) {
  return page.evaluate(() => {
    const footer = document.querySelector('.wb-simple-chat__footer')
    if (!footer) return { found: false }
    const wrap = footer.querySelector('.acu-input-wrap')
    const strip = footer.querySelector('.acu-input-queue')
    const probe = document.createElement('div')
    probe.style.borderColor = 'var(--role-pending-edge)'
    probe.style.backgroundColor = 'var(--role-pending-surface)'
    document.body.appendChild(probe)
    const want = getComputedStyle(probe)
    const expect = { edge: want.borderTopColor, surface: want.backgroundColor }
    probe.remove()
    if (!strip) {
      return { found: true, strip: false, legacy: !!document.querySelector('.wb-chat-queue') }
    }
    const cs = getComputedStyle(strip)
    const sr = strip.getBoundingClientRect()
    const wr = wrap ? wrap.getBoundingClientRect() : null
    const items = [...strip.querySelectorAll('.acu-input-queue-item')].map(row => ({
      index: row.querySelector('.acu-input-queue-index')?.textContent.trim() || '',
      text: row.querySelector('.acu-input-queue-text')?.textContent.trim() || '',
      atts: row.querySelector('.acu-input-queue-att-name')?.textContent.trim() || '',
      hasRemove: !!row.querySelector('.acu-input-queue-remove'),
      flush: row.querySelector('.acu-input-queue-btn')?.textContent.trim() || '',
    }))
    return {
      found: true,
      strip: true,
      legacy: !!document.querySelector('.wb-chat-queue'),
      insideWrap: !!wrap && wrap.contains(strip),
      // 几何：条带四边都落在输入框盒子内（"在上面另起一块"会在这里露馅）
      withinBox: !!wr && sr.left >= wr.left - 0.5 && sr.right <= wr.right + 0.5
        && sr.top >= wr.top - 0.5 && sr.bottom <= wr.bottom + 0.5,
      title: strip.querySelector('.acu-input-queue-title')?.textContent.trim() || '',
      count: strip.querySelector('.acu-input-queue-count')?.textContent.trim() || '',
      hint: strip.querySelector('.acu-input-queue-hint')?.textContent.trim() || '',
      items,
      edge: cs.borderTopColor,
      surface: cs.backgroundColor,
      expect,
    }
  })
}

/** 往输入框里塞一句话并点发送（按钮而不是 Enter：宿主文案写的是 Ctrl+Enter，别赌键位） */
async function send(page, text) {
  const footer = page.locator('.wb-simple-chat__footer')
  await footer.locator('.acu-input-textarea').fill(text)
  await footer.locator('.acu-input-send').click()
}

async function main() {
  const { board, tasks, jobs, project } = fixture()
  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox'],
  })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage()
  // 后端不在（见文件头），socket.io 会一直重连并往 console 写 ERR_CONNECTION_REFUSED。
  // 那是探针环境的事实，不是这块代码的问题 —— 只放行这一条，其余 console 错误照旧算失败。
  const ENV_NOISE = /WebSocket connection to .*socket\.io.*failed|Socket连接错误/
  page.on('console', (m) => {
    if (m.type() !== 'error' || ENV_NOISE.test(m.text())) return
    consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e)))

  /** 拦到的续接请求（F / G 两组都断言它） */
  const continueCalls = []
  /** 接棒应答：G 组要它失败，好让队列停在暂停态 */
  let continueReply = { success: false, error: '合成：这一轮接棒失败' }

  try {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('wb.boardView.v1', 'kanban')
        localStorage.setItem('wb.boardProject.v1', '')
      } catch { /* 隐私模式 */ }
      // 假 EventSource：真那份会连后端（探针里后端不起），失败重连每 3s 刷一屏红。
      // 换成可手动投喂的壳子，G 组用它推一条终态 job:update。
      const Real = window.EventSource
      window.__zenSse = []
      const Fake = function (url) {
        if (!String(url).includes('/api/')) return new Real(url)
        const inst = {
          url: String(url), readyState: 1, onmessage: null, onerror: null, onopen: null,
          close() { this.readyState = 2 },
          addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true },
        }
        window.__zenSse.push(inst)
        return inst
      }
      Fake.CONNECTING = 0; Fake.OPEN = 1; Fake.CLOSED = 2
      window.EventSource = Fake
    })

    const json = (route, body) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(body),
    })
    // 兜底：后端没起，未被下面显式桩掉的接口一律回一个成功的空壳，
    // 免得 ERR_CONNECTION_REFUSED 把 H 组（无 console 错误）带崩
    await page.route('**/api/**', (route) => json(route, { success: true }))
    // 工作台是「公共板块」，role=project 时压根不渲染那枚图标（ActivityBar.showPublicTabs）
    await page.route('**/api/app-role*', (route) => json(route, { role: 'hub' }))
    // 兜底壳里没有 packages，NPM 面板会读 undefined.length 报错 —— 给它一个真的空清单
    await page.route('**/api/scan-npm-scripts*', (route) =>
      json(route, { success: true, packages: [], totalScripts: 0 }))
    // 同理：instances 少了 instances 数组，InstanceSwitcher 的 computed 会读 undefined.length
    await page.route('**/api/instances*', (route) =>
      json(route, { success: true, instances: [], currentInstanceId: null }))
    await page.route('**/api/workbench/projects*', (route) =>
      json(route, { success: true, projects: [project], tasks: board, currentProjectPath: PROJECT_PATH }))
    await page.route('**/api/workbench/tasks*', (route) => json(route, { tasks }))
    await page.route('**/api/workbench/jobs*', (route) => json(route, { jobs }))
    await page.route('**/api/workbench/current-project*', (route) =>
      json(route, { projectPath: PROJECT_PATH, projectName: 'zen-gitsync' }))
    // ⚠️ 必须注册在通配 `**/api/workbench/jobs*` 之后：playwright 后注册的先匹配
    await page.route('**/api/workbench/jobs/*/continue', (route) => {
      continueCalls.push({
        url: route.request().url(),
        body: route.request().postDataJSON(),
      })
      return json(route, continueReply)
    })

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 30000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.kb-card', { timeout: 20000 })
    await page.locator('.proj-item--all').first().click()
    await page.waitForSelector(`.kb-card[data-task-id="${TASK_ID}"]`, { timeout: 20000 })
    await page.locator(`.kb-card[data-task-id="${TASK_ID}"]`).first().click()
    await page.waitForSelector('.wb-simple-chat__footer .acu-input-textarea', { timeout: 20000 })
    await sleep(500)

    // ── A0 没排队时不渲染条带（空队列不该占一块地方） ──────────────
    const empty = await readQueue(page)
    check('A0 队列为空时不渲染条带', empty.found && !empty.strip, JSON.stringify(empty).slice(0, 80))

    // ── 排第一条 ──────────────────────────────────────────────────
    await send(page, FIRST)
    const gotFirst = await waitFor(async () => (await readQueue(page)).strip)
    check('A1 执行中发送 → 出现排队条带（库的 .acu-input-queue）', gotFirst)
    if (!gotFirst) throw new Error('条带没出来，后面的断言无从谈起')
    const q1 = await readQueue(page)

    check('A2 条带长在输入框内部（不是宿主在上方另起一块）', q1.insideWrap)
    check('A3 几何：条带四边都在输入框盒子里', q1.withinBox)
    check('A4 宿主手写的那份 .wb-chat-queue 已经不存在', !q1.legacy)

    // ── B 文案与智能体页同源 ──────────────────────────────────────
    check('B1 标题 / 计数与库条带一致', q1.title === LABEL_TITLE && q1.count === '1',
      `title=${q1.title} count=${q1.count}`)
    check('B2 在跑时的提示＝agentQueueLabels().hint', q1.hint === LABEL_HINT, q1.hint)
    check('B3 在跑时不给「立即发送」（自动接棒会发，摆出来只会闪一下）',
      q1.items.every(i => !i.flush), JSON.stringify(q1.items.map(i => i.flush)))

    // ── C 第二条带附件：按顺序排号，附件只列名字 ────────────────────
    await page.locator('.wb-simple-chat__footer .acu-input-file').setInputFiles({
      name: ATT_NAME, mimeType: 'image/png',
      // 1×1 透明 png
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      ),
    })
    await send(page, SECOND)
    const gotSecond = await waitFor(async () => (await readQueue(page)).items.length === 2)
    check('C1 第二条进队列，计数到 2', gotSecond)
    const q2 = await readQueue(page)
    check('C2 按发送顺序排号，正文原样显示',
      q2.items[0]?.index === '1' && q2.items[0]?.text === FIRST
      && q2.items[1]?.index === '2' && q2.items[1]?.text === SECOND,
      JSON.stringify(q2.items.map(i => `${i.index}:${i.text}`)))
    check('C3 附件在条带上只列文件名（排队时不上传）',
      q2.items[1]?.atts === ATT_NAME && continueCalls.length === 0,
      `atts=${q2.items[1]?.atts} continueCalls=${continueCalls.length}`)

    // ── D 移除：删的是那一条 ──────────────────────────────────────
    await page.locator('.wb-simple-chat__footer .acu-input-queue-item').nth(1)
      .locator('.acu-input-queue-remove').click()
    const removed = await waitFor(async () => (await readQueue(page)).items.length === 1)
    const q3 = await readQueue(page)
    check('D1 点第二条的移除 → 只剩第一条（不是清空，也不是删错行）',
      removed && q3.items[0]?.text === FIRST, JSON.stringify(q3.items.map(i => i.text)))

    // ── E 语义色：本项目「待处理」档 ────────────────────────────────
    check('E1 边框取 --role-pending-edge', q3.edge === q3.expect.edge,
      `${q3.edge} vs ${q3.expect.edge}`)
    check('E2 底色取 --role-pending-surface', q3.surface === q3.expect.surface,
      `${q3.surface} vs ${q3.expect.surface}`)

    await page.screenshot({ path: path.resolve(__dirname, '../tmp/verify-wb-chat-queue.png') })
    log('截图:', path.resolve(__dirname, '../tmp/verify-wb-chat-queue.png'))

    // ── F 本轮跑完 → 自动接棒（这一笔故意让它失败，好走到 G） ────────
    await page.evaluate(({ job }) => {
      const done = { ...job, status: 'done', endedAt: new Date().toISOString(), exitCode: 0 }
      for (const es of window.__zenSse) {
        if (!es.url.includes('/api/workbench/events') || !es.onmessage) continue
        es.onmessage({ data: JSON.stringify({ event: 'job:update', payload: done }) })
      }
    }, { job: jobs[0] })
    const flushed = await waitFor(() => continueCalls.length > 0)
    check('F1 本轮进终态 → 自动接棒发了续接请求', flushed, `calls=${continueCalls.length}`)
    check('F2 ★ 打的是这条任务的 job id，带的是队首那句',
      continueCalls.length === 1
      && new RegExp(`/api/workbench/jobs/${JOB_ID}/continue$`).test(continueCalls[0].url)
      && continueCalls[0].body?.userMessage === FIRST,
      JSON.stringify(continueCalls[0] || {}).slice(0, 160))

    // ── G 接棒失败 → 暂停在原处，队首给「立即发送」 ──────────────────
    const paused = await waitFor(async () => {
      const q = await readQueue(page)
      return q.strip && q.items.length === 1 && !!q.items[0].flush
    })
    const q4 = await readQueue(page)
    check('G1 失败那条留在队里，没被丢掉', paused && q4.items[0]?.text === FIRST,
      JSON.stringify(q4.items.map(i => i.text)))
    check('G2 队首出现「立即发送」', q4.items[0]?.flush === LABEL_FLUSH, q4.items[0]?.flush)
    check('G3 提示切成暂停文案', q4.hint === LABEL_PAUSED_HINT, q4.hint)
    await page.locator('.wb-simple-chat__footer .acu-input-queue-btn').first().click()
    const manual = await waitFor(() => continueCalls.length > 1)
    check('G4 点「立即发送」再发一次（只由它解除暂停）', manual, `calls=${continueCalls.length}`)

    // ── R 负控：把条带挪回输入框外 + 语义色覆盖回中性灰 ──────────────
    // 注入放在最后：前面那些功能断言跑完再破坏现场，避免 Vue patch 一个被搬走的节点。
    if (REVERSE) {
      await page.addStyleTag({
        content: 'html body .acu-input-queue.acu-input-queue{'
          + '--acu-queue-edge:#808080 !important;--acu-queue-surface:#101010 !important;}',
      })
      await page.evaluate(() => {
        const footer = document.querySelector('.wb-simple-chat__footer')
        const strip = footer.querySelector('.acu-input-queue')
        footer.insertBefore(strip, footer.firstChild)
      })
      await sleep(200)
      const broken = await readQueue(page)
      check('A2 条带长在输入框内部（不是宿主在上方另起一块）', broken.insideWrap)
      check('A3 几何：条带四边都在输入框盒子里', broken.withinBox)
      check('E1 边框取 --role-pending-edge', broken.edge === broken.expect.edge,
        `${broken.edge} vs ${broken.expect.edge}`)
      check('E2 底色取 --role-pending-surface', broken.surface === broken.expect.surface,
        `${broken.surface} vs ${broken.expect.surface}`)
      await page.screenshot({ path: path.resolve(__dirname, '../tmp/verify-wb-chat-queue-reverse.png') })
    }

    check('H1 页面无 console / page 错误', consoleErrors.length === 0 && pageErrors.length === 0,
      [...consoleErrors, ...pageErrors].slice(0, 3).join(' | ').slice(0, 300))
  } finally {
    await browser.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n[verify] ${results.length - failed.length}/${results.length} 通过${REVERSE ? '（负控模式）' : ''}`)
  for (const f of failed) console.log(`  FAIL  ${f.name}  ::  ${f.extra}`)

  /* --reverse 的期望是**指定那几条**变红：条带被挪出输入框、配色被换成中性灰之后，
     结构与配色四条必须挡住它。文案 / 排队 / 移除 / 接棒那些照旧应当是绿的 ——
     负控只破坏"是不是库那份、是不是本项目配色"这两件事。 */
  const MUST_FAIL_IN_REVERSE = [
    'A2 条带长在输入框内部（不是宿主在上方另起一块）',
    'A3 几何：条带四边都在输入框盒子里',
    'E1 边框取 --role-pending-edge',
    'E2 底色取 --role-pending-surface',
  ]
  let okOverall
  if (REVERSE) {
    // 同名断言跑了两遍（破坏前 / 破坏后）：取最后一次的结果
    const notRed = MUST_FAIL_IN_REVERSE.filter((n) => {
      const hits = results.filter(r => r.name === n)
      return hits[hits.length - 1]?.ok !== false
    })
    okOverall = notRed.length === 0
    console.log(okOverall
      ? '反向验证通过：手写那份的形态确实被这几条断言挡下'
      : '反向验证失败：破坏后居然还绿 —— 断言守错了地方：' + notRed.join(' / '))
  } else {
    okOverall = failed.length === 0
    console.log(okOverall ? '全部通过' : '有失败')
  }
  process.exit(okOverall ? 0 : 1)
}

main().catch((err) => { console.error('[verify] 异常退出:', err); process.exit(1) })
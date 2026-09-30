/**
 * 任务对话流「用户气泡」的验证：气泡里只该有用户真正说过的话。
 *
 * 验收契约（改这块时别破坏）：
 *   A 对话流里必须有用户气泡（没有 bubble 的页面不能算通过）
 *   B 气泡文本**不得**含服务端注入块的锚点：
 *       `[运行环境` / `## 跨会话记忆库` / `本任务包含 N 个附件` / `续接 #N`
 *   C 反向自证：同一批 job 的**原始** `job.prompt` 里**确实**含这些块
 *     —— 少了这条，B 在"数据里根本没注入块"时也会绿（空测试）
 *   D 气泡文本是原始 prompt 的子串，且长度不到它的 1/3 —— 证明是"裁掉了块"，
 *     不是"换了一段别的文字显示"
 *
 * 为什么要验：job.prompt 是**真正发给 CLI 的整段**（环境块 + 记忆块 + 用户的话 +
 * 续接 #N + 附件清单）。原样当气泡渲染有两个后果（2026-09-30 实测）：
 *   · 每续一轮气泡里就多一份一模一样的项目清单，第一屏全是它；
 *   · 用户从对话框复制整段对话再粘回续聊输入框时，注入块跟着一起回去 ——
 *     实测一条续聊轮 prompt 47,116 字符，6 份环境块全是粘出来的。
 * 剥离逻辑在 src/ui/client/src/utils/jobUserPrompt.ts（单测 jobUserPrompt.test.ts）。
 *
 * 前置：dev server 已启动（npm run dev，后端 5545 / 前端 5544），且**本机存在
 *       至少一条带注入块的历史 job**（跑过任何一条任务就有）。
 * 用法：ZEN_BASE=http://127.0.0.1:5544 node scripts/verify-wb-bubble-prompt.cjs
 * 退出码：0 全通过，1 有失败项，2 前置不满足（数据不足 / 服务没起）
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544'
// 截图落到系统临时目录（与其它 verify-*.cjs 同口径），别往仓库里丢产物
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'zen-wb-bubble-prompt')
const results = []
const consoleErrors = []
const pageErrors = []

/** 注入块的锚点，与 utils/jobUserPrompt.ts 里依赖的完全一致 */
const MARKERS = ['[运行环境', '## 跨会话记忆库', '本任务包含 ', '续接 #']

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function main() {
  // ── 从 API 挑一条真的带注入块的历史 job ────────────────────────────────
  const jobsRes = await fetch(`${BASE}/api/workbench/jobs`).then(r => r.json()).catch(() => null)
  if (!jobsRes?.success) { console.error('[verify] 拿不到 /api/workbench/jobs，dev server 起了吗？'); process.exit(2) }
  const tasksRes = await fetch(`${BASE}/api/workbench/tasks`).then(r => r.json()).catch(() => null)
  const tasks = tasksRes?.tasks || []
  const taskById = new Map(tasks.map(t => [t.id, t]))

  const injected = (jobsRes.jobs || []).filter(j =>
    typeof j.prompt === 'string'
    && MARKERS.every(m => j.prompt.includes(m))
    && taskById.has(j.taskId))

  if (injected.length === 0) {
    console.error('[verify] 本机找不到"带注入块的历史 job"，无法验证（先跑一条任务再来）')
    process.exit(2)
  }
  // 挑最短的那条：结构化最干净（长的多半是用户自己粘了一堆东西进来）
  injected.sort((a, b) => a.prompt.length - b.prompt.length)
  const sample = injected[0]
  const task = taskById.get(sample.taskId)
  log(`样本 job=${sample.id} 原始 prompt=${sample.prompt.length} 字符，任务="${task.title}"`)

  // 该任务下所有轮次（气泡是逐轮渲染的，要一起验）
  const taskJobs = (jobsRes.jobs || []).filter(j => j.taskId === task.id && typeof j.prompt === 'string' && j.prompt)
  const rawPrompts = taskJobs.map(j => j.prompt)
  check('C 反向自证：样本任务确实带注入块',
    rawPrompts.some(p => MARKERS.every(m => p.includes(m))),
    `${taskJobs.length} 轮，其中 ${rawPrompts.filter(p => p.includes('[运行环境')).length} 轮带环境块`)

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.kb', { timeout: 15000 })
    await sleep(2500)

    const allProj = page.locator('.proj-item--all')
    if (await allProj.count()) { await allProj.first().click(); await sleep(900) }

    const card = page.locator('.kb-card', { hasText: task.title }).first()
    if (!(await card.count())) {
      check('A 打开任务对话流（能否找到目标卡片）', false, `看板上没有「${task.title}」的卡片`)
    } else {
      await card.click()
      // 对话流容器：库的 .acu-message-list（与 WorkbenchView 的样式钩子同一份依赖）
      await page.waitForSelector('.acu-message-list', { timeout: 15000 }).catch(() => {})
      await sleep(1200)

      // 用户气泡 = 带右侧头像的 .acu-bubble-row
      const bubbles = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.acu-bubble-row'))
        return rows
          .filter(r => r.querySelector('.acu-avatar--right'))
          .map(r => (r.querySelector('.acu-bubble-content') || r).innerText.trim())
          .filter(Boolean)
      })
      check('A 对话流里有用户气泡', bubbles.length > 0, `${bubbles.length} 条`)

      const dirty = bubbles.filter(t => MARKERS.some(m => t.includes(m)))
      check('B 气泡里没有注入块锚点', dirty.length === 0,
        dirty.length ? `命中 ${dirty.length} 条，例：${JSON.stringify(dirty[0].slice(0, 80))}` : `${bubbles.length} 条气泡全部干净`)

      // D 每条气泡都得是某轮原始 prompt 的子串，且明显更短
      const matched = bubbles.filter(t => rawPrompts.some(p => p.includes(t)))
      check('D 气泡文本来自原始 prompt 且被裁短', matched.length === bubbles.length,
        `${matched.length}/${bubbles.length} 条能在原始 prompt 里找到`)

      const shortEnough = bubbles.every(t => {
        const owner = rawPrompts.filter(p => p.includes(t)).sort((a, b) => a.length - b.length)[0]
        return owner ? t.length * 3 < owner.length : false
      })
      check('D2 气泡长度不到原始 prompt 的 1/3', shortEnough)

      await fs.promises.mkdir(SHOT_DIR, { recursive: true })
      const shot = path.join(SHOT_DIR, 'wb-bubble-prompt.png')
      // 截图前先滚到顶：对话流默认钉在底部，不滚的话截到的是最后一条助手回复，
      // 看不到要验的用户气泡
      await page.evaluate(() => { const l = document.querySelector('.acu-message-list'); if (l) l.scrollTop = 0 })
      await sleep(400)
      await page.screenshot({ path: shot })
      log('截图:', shot)
      log('气泡样例:', JSON.stringify(bubbles.slice(0, 3)))
    }

    check('E 无 console error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
    check('E2 无 pageerror', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify] 崩了:', err); process.exit(1) })

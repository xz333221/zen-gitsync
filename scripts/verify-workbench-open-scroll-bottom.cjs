/**
 * 工作台「点开任务后对话流默认停在最底部」回归验证。
 *
 * 症状（用户报 2026-09-29，附了截图）：从看板点开一条跑过的任务，对话区停在**最上面**那轮
 * —— 那条巨大的「运行环境」注入消息，得手动往下滚才看得到最新回复。截图里滚动条滑块
 * 就压在轨道最顶端。
 *
 * 机理（探针实测）：zen-ai-chat-ui 的 MessageList 只在 onMounted 里滚一次底，而那一刻
 * el-dialog 的内容还没参与布局 —— 探针抓到那次 scrollTo 时 scrollHeight=0、clientHeight=0，
 * 等于空转。内容随后才长起来（0 → 371 → 1573 → 2542，全在挂载后 ~500ms 内），而库里后续的
 * "自动贴底"只挂在「消息条数 / 末条正文长度」这类字符串签名上；markdown 异步高亮（shiki）、
 * 工具调用分组折叠都是"签名没变、高度变了"，于是没人再滚第二次，视图留在顶部。
 * 修法见 WorkbenchView.vue 的 pinChatToBottom()：收敛期里用 ResizeObserver 持续补滚。
 *
 *   P0 找到能当样本的任务（跑过、有 done job）
 *   P1 从看板点卡片打开编辑器弹窗
 *   P2 ★ 打开后对话流贴底（本次修的核心）—— 且内容确实高过视口，否则测的是假象
 *   P3 ★ 在弹窗里切到另一条任务，新的对话流同样贴底（ChatContainer 按 taskId 重挂载）
 *   P4 反向护栏：收敛期结束后用户自己往上滚，**不该**再被拽回底部
 *   P5 反向护栏：关掉再打开同一条任务，仍然贴底（不是只在首次挂载时生效）
 *
 * 前置：dev server 已启动（npm run dev:ping 两个 OK，前端 5544）。
 * 用法：node scripts/verify-workbench-open-scroll-bottom.cjs
 * 退出码：0 全通过，1 有失败项。
 */
const os = require('node:os')
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544'
const API = BASE
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'zen-wb-open-scroll-bottom')
/** 贴底容差：亚像素 + 边框取整留 4px，超过就算没贴底 */
const BOTTOM_TOLERANCE = 4

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 读对话流滚动状态（`.acu-message-list` 是库里的滚动容器，宿主只读不写） */
async function readChat(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.acu-message-list')
    if (!el) return null
    return {
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      distToBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
    }
  })
}

async function waitFor(fn, timeout = 10000, step = 150) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 > timeout) return false
    await sleep(step)
  }
}

const atBottom = (s) => !!s && s.distToBottom <= BOTTOM_TOLERANCE && s.scrollHeight > s.clientHeight + 40

async function main() {
  // ── P0 挑样本任务 ───────────────────────────────────────────────────────
  // 跑过（有 done job）的任务 = 至少一条巨大的「运行环境」用户消息 + 一条回复，
  // 必定高于对话视口。挑两条，P3 要用它验「弹窗内切任务」。
  const jobsRes = await fetch(`${API}/api/workbench/jobs`).then(r => r.json()).catch(() => ({}))
  const tasksRes = await fetch(`${API}/api/workbench/tasks`).then(r => r.json()).catch(() => ({}))
  const tasks = tasksRes.tasks || []
  const doneTaskIds = [...new Set((jobsRes.jobs || [])
    .filter(j => j.status === 'done' && j.taskId && (j.prompt || '').length > 800)
    .map(j => j.taskId))]
  const samples = doneTaskIds
    .map(id => tasks.find(t => t.id === id))
    .filter(t => t && t.title && t.title.trim().length >= 6)
    .slice(0, 2)
  check('P0 找到两条跑过的任务当样本', samples.length === 2,
    samples.map(t => `${t.id}｜${t.title.slice(0, 20)}`).join(' / ') || `doneTaskIds=${doneTaskIds.length}`)
  if (samples.length < 2) {
    console.error('[verify] 样本不够（至少需要 2 条跑过的任务），无法验证')
    process.exit(1)
  }
  const [taskA, taskB] = samples

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  /** 从看板点某条任务的卡片 */
  async function openFromBoard(task) {
    const card = page.locator('.kb-card', { hasText: task.title.slice(0, 18) }).first()
    if (!(await card.count())) return false
    await card.click()
    return waitFor(async () => page.evaluate(() =>
      !!document.querySelector('.wb-editor') && document.querySelector('.wb-editor').offsetParent !== null), 12000)
  }

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 30000 })
    await page.locator('.loading-container').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.board', { timeout: 15000 })
    await sleep(2500)
    // 全部项目视角，保证样本任务（可能属于别的项目）的卡片可见
    const allProj = page.locator('.proj-item--all')
    if (await allProj.count()) { await allProj.first().click(); await sleep(800) }

    // ── P1/P2 从看板打开任务 ──────────────────────────────────────────────
    const opened = await openFromBoard(taskA)
    check('P1 点卡片打开任务编辑器弹窗', opened, taskA.title.slice(0, 24))
    if (!opened) throw new Error('编辑器弹窗没出来')

    // 等收敛期（3s）+ 内容异步渲染落定
    await sleep(4000)
    const a = await readChat(page)
    check('P2a 对话流内容确实高过视口（否则测的是假象）',
      !!a && a.scrollHeight > a.clientHeight + 40,
      a ? `scrollHeight=${a.scrollHeight} clientHeight=${a.clientHeight}` : 'no .acu-message-list')
    check('P2 ★ 打开后对话流停在最底部', atBottom(a),
      a ? `scrollTop=${a.scrollTop} distToBottom=${a.distToBottom}（期望 ≤${BOTTOM_TOLERANCE}）` : 'no list')
    await page.screenshot({ path: path.join(SHOT_DIR, 'opened.png') }).catch(() => {})

    // ── P3 弹窗内切到另一条任务 ──────────────────────────────────────────
    const swItem = page.locator('.wb-task-item', { hasText: taskB.title.slice(0, 18) }).first()
    const canSwitch = (await swItem.count()) > 0
    check('P3a 侧边栏里有第二条样本任务', canSwitch, taskB.title.slice(0, 24))
    if (canSwitch) {
      await swItem.click()
      await sleep(4000)
      const b = await readChat(page)
      check('P3 ★ 切到另一条任务后同样停在最底部', atBottom(b),
        b ? `scrollTop=${b.scrollTop} distToBottom=${b.distToBottom} h=${b.scrollHeight}/${b.clientHeight}` : 'no list')
    }

    // ── P4 反向护栏：收敛期过后用户自己往上滚，不该被拽回去 ────────────────
    const before = await readChat(page)
    if (before && before.scrollHeight > before.clientHeight + 40) {
      await page.evaluate(() => {
        const el = document.querySelector('.acu-message-list')
        el.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }))  // 先宣告"用户动手了"
        el.scrollTop = Math.max(0, el.scrollTop - 250)
      })
      await sleep(1200)
      const after = await readChat(page)
      check('P4 收敛期结束后用户上滚不会被拽回底部',
        !!after && Math.abs(after.scrollTop - (before.scrollTop - 250)) <= 8,
        after ? `scrollTop ${before.scrollTop} → ${after.scrollTop}（期望 ≈${before.scrollTop - 250}）` : 'no list')
    } else {
      log('跳过 P4：内容不够高，滚不动')
    }

    // ── P5 关掉再打开同一条任务，仍然贴底 ────────────────────────────────
    await page.locator('.wb-back-btn').first().click()
    await sleep(800)
    const reopened = await openFromBoard(taskA)
    check('P5a 重新打开任务', reopened, taskA.title.slice(0, 24))
    if (reopened) {
      await sleep(4000)
      const c = await readChat(page)
      check('P5 ★ 关掉再打开仍然停在最底部', atBottom(c),
        c ? `scrollTop=${c.scrollTop} distToBottom=${c.distToBottom}` : 'no list')
    }

    await page.screenshot({ path: path.join(SHOT_DIR, 'final.png') }).catch(() => {})
  } catch (err) {
    check('脚本异常', false, String((err && err.message) || err))
  } finally {
    await browser.close().catch(() => {})
  }

  const failed = results.filter(r => !r.ok)
  const noisy = consoleErrors.filter(e => !/favicon|ResizeObserver|DevTools|Failed to fetch/i.test(e))
  console.log('\n[verify] 截图目录:', SHOT_DIR)
  console.log(`[verify] 结果: ${results.length - failed.length}/${results.length} 通过`)
  failed.forEach(f => console.log(`  - ${f.name} ${f.extra}`))
  if (noisy.length) console.log('[verify] console errors:', noisy.slice(0, 5))
  if (pageErrors.length) console.log('[verify] page errors:', pageErrors.slice(0, 5))
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('[verify] 脚本异常:', e)
  process.exit(1)
})

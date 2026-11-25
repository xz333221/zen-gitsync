/**
 * 任务对话流：用户气泡上应显示该轮 spawn 时带走的附件（2026-11-25 新增能力）。
 *
 * 每轮提问气泡上的附件来自 job.prompt 尾块（spawn 时冻结的清单，见
 * utils/jobPromptAttachments.ts），缩略图走 /api/workbench/attachments/:id/raw。
 *
 * 契约（改这块时别破坏）：
 *   A 目标任务的任务执行对话流里有用户气泡
 *   B 带附件轮的用户气泡上有 .acu-attachments
 *   B2 每轮条数 = **该轮** prompt 尾块条数 —— 后续轮上传的附件不许回灌到早先的气泡
 *   C 图片附件渲染成缩略图（.acu-att-thumb img），且 naturalWidth > 0（防"节点在但裂图"假绿）
 *   D 反向自证：样本 job 的原始 prompt 里确实挂着「本任务包含 N 个附件」尾块
 *     —— 少了这条，B 在"数据里根本没清单"时也会绿（空测试）
 * 前置：dev server 已启动（后端 5545 / 前端 5544），且本机存在带附件尾块的历史 job。
 * 用法：ZEN_BASE=http://127.0.0.1:5544 node scripts/verify-wb-att-bubble.cjs
 * 退出码：0 全通过，1 有失败项，2 前置不满足（数据不足 / 服务没起）
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), "zen-wb-att-bubble")
const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 从 job.prompt 尾块里数附件条数（与服务端 pdfText.buildAttachmentBlock 的行格式对齐） */
function countPromptAttachments(prompt) {
  const m = String(prompt || '').match(/\n\n---\n本任务包含 (\d+) 个附件（请按文件路径读取[^\n]*）：\n?([\s\S]*)$/)
  if (!m) return 0
  return (m[2].match(/^\s*(?:\d+\.\s*)?\[/gm) || []).length
}

async function main() {
  const jobsRes = await fetch(`${BASE}/api/workbench/jobs`).then(r => r.json()).catch(() => null)
  if (!jobsRes?.success) { console.error('[verify] 拿不到 /api/workbench/jobs'); process.exit(2) }
  const tasksRes = await fetch(`${BASE}/api/workbench/tasks`).then(r => r.json()).catch(() => null)
  const tasks = tasksRes?.tasks || []
  const taskById = new Map(tasks.map(t => [t.id, t]))

  // 样本：prompt 尾块附件数最多的那条任务（多图任务最有代表性）
  let best = null
  for (const j of jobsRes.jobs || []) {
    const n = countPromptAttachments(j.prompt)
    if (n > 0 && (!best || n > best.n)) best = { job: j, n }
  }
  if (!best) { console.error('[verify] 找不到带附件尾块的历史 job，无法验证（先跑一条带附件的任务再来）'); process.exit(2) }
  const task = taskById.get(best.job.taskId)
  log(`样本 job=${best.job.id} 附件数=${best.n}，任务="${task?.title}"`)
  check('D 反向自证：原始 prompt 尾块确实挂着附件清单', best.n > 0, `${best.n} 个`)

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  // 本机实例是 project 角色（活动栏没有工作台 tab，见 memory public-tabs-need-hub-role）——
  // 桩成 hub 让公共 tab 出来，只影响这次探针自己的页面
  await page.route('**/api/app-role**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, role: 'hub', version: 'probe' })
  }))

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    // 冷启动首屏可能撞上 vite 预构建/504（记忆库：探针首次 goto 空就重载一次再判）
    let shell = await page.waitForSelector('.activity-bar', { timeout: 20000 }).catch(() => null)
    if (!shell) {
      log('首屏没出 activity-bar，重载一次再等（vite 冷启动预构建）')
      await sleep(8000)
      await page.reload({ waitUntil: 'domcontentloaded' })
      shell = await page.waitForSelector('.activity-bar', { timeout: 30000 }).catch(() => null)
    }
    if (!shell) {
      await fs.promises.mkdir(SHOT_DIR, { recursive: true })
      await page.screenshot({ path: path.join(SHOT_DIR, 'no-shell.png') })
      log('壳都没起来，截图:', path.join(SHOT_DIR, 'no-shell.png'))
    }
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.kb', { state: 'attached', timeout: 20000 })
    await sleep(2500)

    // 看板默认只渲染当前项目的卡（共享状态，落在哪个项目看运气）——先切「全部项目」
    const allProj = page.locator('.proj-item--all')
    if (await allProj.count()) { await allProj.first().click(); await sleep(900) }
    // 已完成列只铺前 30 张，老任务可能被顶出首屏 —— 用看板搜索把它捞出来
    await page.locator('.board__search-btn').first().click()
    await page.locator('.board__search-input').first().fill(task.title.slice(0, 12))
    await sleep(1000)
    const card = page.locator(`.kb-card[data-task-id="${task.id}"]`).first()
    if (!(await card.count())) {
      check('A 打开任务对话流', false, `搜索后仍没有 id=${task.id} 的卡片`)
    } else {
      await card.click()
      await page.waitForSelector('.acu-message-list', { timeout: 15000 }).catch(() => {})
      await sleep(1500)

      const rows = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.acu-bubble-row.is-user')).map(r => ({
          msgId: r.getAttribute('data-msg-id') || '',
          text: (r.querySelector('.acu-bubble-content') || r).innerText.trim().slice(0, 40),
          attCount: r.querySelectorAll('.acu-attachments > *').length,
          thumbs: Array.from(r.querySelectorAll('.acu-att-thumb img')).map(img => ({
            ok: img.naturalWidth > 0,
            src: (img.getAttribute('src') || '').slice(0, 60)
          }))
        }))
      })
      check('A 用户气泡存在', rows.length > 0, `${rows.length} 条`)
      const withAtt = rows.filter(r => r.attCount > 0)
      check('B 用户气泡上有附件条', withAtt.length > 0,
        withAtt.length ? `${withAtt.length} 条气泡带附件，首条 ${withAtt[0].attCount} 个` : '没有任何气泡带附件')
      // 逐轮对照：气泡 data-msg-id = `${job.id}-u`，附件数应等于**那一轮** prompt 冻结的清单
      // （后续轮上传的附件不该回灌到早先的气泡上 —— 每轮显示的是当时真实带走的附件）
      const allTaskJobs = (jobsRes.jobs || []).filter(j => j.taskId === task.id)
      const perRoundOk = rows.filter(r => r.msgId.endsWith('-u')).every(r => {
        const j = allTaskJobs.find(x => `${x.id}-u` === r.msgId)
        return j ? r.attCount === countPromptAttachments(j.prompt) : false
      })
      check('B2 每轮附件条数 = 该轮 prompt 尾块条数', perRoundOk,
        `各轮 [${rows.filter(r => r.msgId.endsWith('-u')).map(r => r.attCount).join(', ')}]`)
      const allThumbs = withAtt.flatMap(r => r.thumbs)
      check('C 图片缩略图加载成功（naturalWidth>0）',
        allThumbs.length > 0 && allThumbs.every(t => t.ok),
        allThumbs.length ? `${allThumbs.filter(t => t.ok).length}/${allThumbs.length} 张，src 例：${allThumbs[0]?.src}` : '没有缩略图节点')

      await fs.promises.mkdir(SHOT_DIR, { recursive: true })
      const shot = path.join(SHOT_DIR, 'att-bubble.png')
      await page.evaluate(() => { const l = document.querySelector('.acu-message-list'); if (l) l.scrollTop = 0 })
      await sleep(400)
      await page.screenshot({ path: shot })
      log('截图:', shot)
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

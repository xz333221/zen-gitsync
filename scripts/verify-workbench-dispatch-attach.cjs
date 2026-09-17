/**
 * 主 Agent 控制台 · 派发附件链路验证。
 *
 * 验收的行为契约（改这块 UI 时别破坏）：
 *   A 控制台露出回形针按钮 + 多行输入框
 *   B 在输入框里**粘一张图** -> 恰好产生 1 个草稿附件（回归：@paste 挂在 textarea
 *     和 .oc__compose 两层、paste 会冒泡，不做 stopPropagation 就会重复上传）
 *   C 草稿缩略图必须走**暂存端点** /api/workbench/orchestrator/attachments/:id/raw
 *     而不是任务侧端点 —— 此刻任务还不存在，走任务侧一定 404、图裂
 *   D 缩略图真的加载出来了（naturalWidth > 0，不只是有个 img 标签）
 *   E 点回形针 -> 系统文件选择框 -> 选文件也能进草稿
 *   F 派发请求体带上 attachments（id / ext / originalName），且顺序数量对得上
 *   G 派发成功后草稿附件被清空（服务端已把文件搬进 _task-{id}/，前端留着就是死链）
 *   H 派发产生的任务在看板出现，详情里能看到这两个附件
 *
 * 前置：dev server 已启动（npm run dev，前端 5544）。
 * 用法：node scripts/verify-workbench-dispatch-attach.cjs
 * 退出码：0 全通过，1 有失败项，2 环境没起。
 */
const path = require('node:path')

// playwright 装在 src/ui/client 下，把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544'
const API = process.env.ZEN_API || 'http://127.0.0.1:5545'
const MARK = '【附件派发验证】' + Date.now().toString().slice(-6)
const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// 1x1 红点 PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 往指定元素上派发一次「粘贴了一张 PNG」事件（模拟用户 Ctrl+V） */
async function pastePng(page, selector, fileName) {
  await page.evaluate(({ selector, b64, fileName }) => {
    const el = document.querySelector(selector)
    if (!el) throw new Error('找不到粘贴目标: ' + selector)
    const bin = atob(b64)
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    const file = new File([arr], fileName, { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    el.dispatchEvent(evt)
  }, { selector, b64: PNG_B64, fileName })
}

async function attachmentCount(page) {
  return page.locator('.oc .wb-attachment').count()
}

/**
 * 轮询直到条件成立。
 *
 * 别用固定 sleep 等上传：请求要经 page.route 的 fetch→fulfill 转发，偶发会慢到
 * 2.5s 以上，固定等待就会假报"一次上传都没发生"。实测遇到过一次：
 * 断言说 0 个附件、0 次上传，但同一轮的"附件区已渲染"却是通过的 ——
 * 附件区只在 `附件数>0 || 上传中` 时渲染，说明那一刻上传正飞在半路。
 */
async function waitUntil(fn, timeout = 12000, interval = 150) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true
    await sleep(interval)
  }
  return false
}

async function main() {
  // 探活
  const alive = await fetch(`${API}/api/app-version`).then(r => r.ok).catch(() => false)
  if (!alive) { console.error(`后端没起（${API}），先 npm run dev`); process.exit(2) }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  // 拦截：记录上传次数 + 派发请求体
  const uploadIds = []
  let dispatchBody = null
  let createdTaskId = null
  const rawRequests = []
  page.on('request', (r) => {
    const u = r.url()
    if (/\/api\/workbench\/orchestrator\/attachments\/[^/]+\/raw/.test(u)) rawRequests.push(u)
  })

  await page.route('**/api/workbench/orchestrator/attachments', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const resp = await route.fetch()
    const body = await resp.json().catch(() => null)
    if (body?.attachment?.id) uploadIds.push(body.attachment.id)
    await route.fulfill({ response: resp })
  })

  await page.route('**/api/workbench/orchestrator/dispatch', async (route) => {
    dispatchBody = route.request().postDataJSON()
    const resp = await route.fetch()
    const body = await resp.json().catch(() => null)
    if (body?.task?.id) createdTaskId = body.task.id
    await route.fulfill({ response: resp })
  })

  const uploadedAttIds = () => uploadIds.slice() // 收尾清理用

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 20000 })
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    await page.waitForSelector('.board', { timeout: 15000 })
    await page.waitForSelector('.oc', { timeout: 15000 })
    await sleep(2000)

    // ── A 控制台骨架 ────────────────────────────────────────────────
    const attachBtn = page.locator('.oc__attach')
    check('A 回形针按钮呈现', (await attachBtn.count()) > 0 && (await attachBtn.first().isVisible()))
    check('A2 多行输入框呈现', (await page.locator('.oc__input').count()) > 0)
    check('A3 派发按钮初始禁用（无内容）',
      await page.locator('.oc__send').first().isDisabled())

    // ── B 粘贴：恰好一个附件 ────────────────────────────────────────
    await page.locator('.oc__input').first().focus()
    await pastePng(page, '.oc__input', 'pasted-shot.png')
    const uploaded = await waitUntil(async () => (await attachmentCount(page)) >= 1)
    const n1 = await attachmentCount(page)
    check('B 粘一张图 -> 恰好 1 个草稿附件（防重复上传回归）', uploaded && n1 === 1, `实际 ${n1} 个`)
    check('B2 上传请求也只发了 1 次', uploadIds.length === 1, `实际 ${uploadIds.length} 次`)
    check('B3 附件区出现（AttachmentZone 渲染）', (await page.locator('.oc .wb-attachments').count()) > 0)

    // ── C 缩略图 URL 必须指向暂存端点 ───────────────────────────────
    const thumbSrc = await page.locator('.oc .wb-attachment__icon img').first()
      .getAttribute('src').catch(() => null)
    check('C 草稿缩略图走暂存端点（非任务侧）',
      !!thumbSrc && thumbSrc.startsWith('/api/workbench/orchestrator/attachments/'),
      `src=${thumbSrc}`)

    // ── D 缩略图真的加载出来了 ──────────────────────────────────────
    const imgOk = await waitUntil(() => page.evaluate(() => {
      const img = document.querySelector('.oc .wb-attachment__icon img')
      return !!img && img.complete && img.naturalWidth > 0
    }))
    check('D 缩略图实际加载成功（naturalWidth>0，不是裂图）', imgOk)

    // ── E 点回形针走系统文件选择框 ──────────────────────────────────
    const fileChooser = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null)
    await attachBtn.first().click()
    const fc = await fileChooser
    if (!fc) {
      check('E 点回形针唤起文件选择框', false, '未捕获到 filechooser 事件')
    } else {
      await fc.setFiles({
        name: 'picked-note.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from('# 选文件上传验证\n\n这是一份通过系统文件框选进来的 Markdown。\n'),
      })
      await waitUntil(async () => (await attachmentCount(page)) >= 2)
      const n2 = await attachmentCount(page)
      check('E 选文件也进草稿（粘 + 选共 2 个）', n2 === 2, `实际 ${n2} 个`)
      const picked = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.oc .wb-attachment__name')).map(e => e.textContent.trim()))
      check('E2 两个附件名字都对得上',
        picked.includes('pasted-shot.png') && picked.includes('picked-note.md'),
        JSON.stringify(picked))
    }

    // ── 派发（关掉「立即执行」，只建任务不真跑 claude）────────────────
    await page.locator('.oc__input').first().fill(MARK)
    const autoRunBox = page.locator('.oc__autorn input')
    if (await autoRunBox.first().isChecked()) await autoRunBox.first().uncheck()
    check('派发前按钮已启用', await page.locator('.oc__send').first().isEnabled())

    await page.locator('.oc__send').first().click()
    await waitUntil(() => !!dispatchBody)
    // 草稿清空发生在派发成功后（父组件拿到结果才调 clearAttachments），单独等一等
    await waitUntil(async () => (await attachmentCount(page)) === 0)

    // ── F 请求体 ────────────────────────────────────────────────────
    const sentAtts = Array.isArray(dispatchBody?.attachments) ? dispatchBody.attachments : []
    check('F 派发请求体带 attachments 且数量为 2', sentAtts.length === 2, `len=${sentAtts.length}`)
    check('F2 每个附件都带 id/ext/originalName',
      sentAtts.length > 0 && sentAtts.every(a => a.id && a.ext && a.originalName),
      JSON.stringify(sentAtts))
    check('F3 autoRun 随「立即执行」取消而变 false', dispatchBody?.autoRun === false, `autoRun=${dispatchBody?.autoRun}`)

    // ── G 成功后草稿清空 ────────────────────────────────────────────
    const n3 = await attachmentCount(page)
    check('G 派发成功后草稿附件被清空', n3 === 0, `实际 ${n3} 个`)

    // ── H 任务上板 + 详情里能看到附件 ───────────────────────────────
    check('H 派发返回了 task.id', !!createdTaskId, `taskId=${createdTaskId}`)
    if (createdTaskId) {
      const detail = await fetch(`${API}/api/workbench/tasks/${createdTaskId}/detail`)
        .then(r => r.json()).catch(() => null)
      const atts = Array.isArray(detail?.task?.attachments) ? detail.task.attachments : (detail?.attachments || [])
      check('H2 任务侧落盘了 2 个附件', atts.length === 2, `len=${atts.length}`)
      check('H3 附件指向 _task-{id}/ 目录',
        atts.length > 0 && atts.every(a => String(a.absolutePath || '').includes('_task-' + createdTaskId)),
        JSON.stringify(atts.map(a => a.absolutePath)))
      // 任务侧端点此刻必须认得它们（缩略图在详情里能显示）
      const rawTask = await fetch(`${API}/api/workbench/attachments/${atts[0]?.id}/raw`).catch(() => null)
      check('H4 任务侧 raw 端点能取到文件', !!rawTask && rawTask.ok, `status=${rawTask?.status}`)
      // 暂存端点此时应已失效（文件搬走了）
      const rawStag = await fetch(`${API}/api/workbench/orchestrator/attachments/${atts[0]?.id}/raw`).catch(() => null)
      check('H5 搬走后暂存端点已失效(404)', !!rawStag && rawStag.status === 404, `status=${rawStag?.status}`)
    }

    // ── I 看板上出现该任务卡片 ──────────────────────────────────────
    await page.locator('.proj-item--all').first().click().catch(() => {})
    const cardSeen = await waitUntil(async () =>
      (await page.locator('.kb-card', { hasText: MARK }).count()) > 0)
    check('I 派发的任务出现在看板上', cardSeen)
  } catch (err) {
    check('脚本异常', false, String((err && err.message) || err))
  } finally {
    // 清场：按标题扫任务（派发出来的 task.title 就是 MARK 首行），再删掉还留在暂存区的草稿附件。
    // 集中在 finally 里做：中途断言失败/脚本抛异常时同样得清干净，否则残留会挂在用户看板上。
    //
    // ⚠️ 删除必须**串行**。DELETE 处理器是"读 tasks.json → 过滤 → 写回"，并发发出去
    // 会互相覆盖（都返回 200 但只生效一次）。同理别在这里用 Promise.all。
    try {
      const list = await fetch(`${API}/api/workbench/tasks`).then(r => r.json())
      for (const t of (list.tasks || [])) {
        if (!t || t.title !== MARK) continue
        await fetch(`${API}/api/workbench/tasks/${encodeURIComponent(t.id)}`, { method: 'DELETE' })
      }
    } catch { /* 清理失败不该盖住断言结果 */ }
    for (const id of uploadedAttIds()) {
      await fetch(`${API}/api/workbench/orchestrator/attachments/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
    }
    await browser.close()
  }

  console.log('\n================ 汇总 ================')
  const failed = results.filter(r => !r.ok)
  console.log(`用例 ${results.length} 个，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  failed.forEach(f => console.log(`  - ${f.name} ${f.extra}`))
  console.log(`附件 raw 请求命中: ${rawRequests.length} 次（${[...new Set(rawRequests)].length} 个不同 URL）`)
  const realErrors = consoleErrors.filter(e => !/Failed to fetch|获取当前目录失败|404|net::ERR/.test(e))
  console.log(`控制台错误(过滤已知噪音): ${realErrors.length}`)
  realErrors.slice(0, 8).forEach(e => console.log('  ! ' + e.slice(0, 220)))
  console.log(`页面异常: ${pageErrors.length}`)
  pageErrors.slice(0, 5).forEach(e => console.log('  ! ' + e.slice(0, 220)))
  process.exit(failed.length ? 1 : 0)
}

main()

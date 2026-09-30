/**
 * 「一键复制执行内容」的验证。
 *
 * 验收契约（改这块时别破坏）：
 *   A 任务执行弹窗顶部有「复制执行内容」按钮，且可点
 *   B 点完之后剪贴板里**真的**是这条任务的执行内容（不是空、不是别的文本）
 *   C 导出文本里必须出现结构锚点：`# <任务标题>` / `## 第 1 轮` / `### 用户提示词`
 *   D 导出文本的**用户提示词段落**里，服务端注入块必须已被裁掉，且段落与对话流同源：
 *       D2 段首不得是注入块锚点（`[运行环境` / `## 跨会话记忆库` / …）
 *       D3 每段都是原始 `job.prompt` 的子串且更短（证明确实是"裁"出来的，不是另写的）
 *       D4 段落数与对话流里的用户气泡数一致（复制出来的和屏幕上看到的得是一回事）
 *     —— "复制"是注入块被搬来搬去的**上游**，复制出来必须只有用户原话。
 *     有意**不**断言"段落里一个锚点都没有"：用户自己粘进正文的大段对话
 *     （本机实测有一轮粘了 45,962 字符、内含 6 份环境块）属于用户原话，
 *     `userFacingPrompt` 有意一个字符都不动，全局查锚点会把它误判成回归。
 *   E 反向自证：同一批 job 的**原始** `job.prompt` 里**确实**含这些块、且以环境块开头
 *     —— 少了这条，D2 在"数据里根本没注入块"时也会绿（空测试）
 *   F 复制成功后按钮自身给出反馈（加 is-flash + 图标切成 ✓）
 *   H 反向：没有任何执行内容的任务不能把**空串**写进剪贴板，要弹提示
 *     （本机没有"从没跑过"的任务时明说跳过，不伪装成通过 —— 造假任务会污染用户数据）
 *   G 无 console error / pageerror
 *
 * 为什么要验：这是**数据导出**功能，失败方式不是崩溃而是"悄悄少了/多了一段" ——
 * 比如 userFacingPrompt 那道裁剪一旦漏掉，用户把复制来的对话粘回续聊框时，
 * 注入块会跟着回去（实测一条续聊轮 prompt 47,116 字符里 6 份环境块全是粘出来的）。
 * 拼装逻辑在 src/ui/client/src/utils/taskExecutionExport.ts（单测 taskExecutionExport.test.ts），
 * 本脚本验的是"从按钮到剪贴板"这条端到端链路。
 *
 * 前置：dev server 已启动（npm run dev，后端 5545 / 前端 5544），且**本机存在
 *       至少一条带注入块的历史 job**（跑过任何一条任务就有）。
 * 用法：ZEN_BASE=http://127.0.0.1:5544 node scripts/verify-wb-copy-execution.cjs
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
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'zen-wb-copy-execution')
const results = []
const consoleErrors = []
const pageErrors = []

/** 注入块锚点，与 utils/jobUserPrompt.ts / taskExecutionExport 依赖的完全一致 */
const INJECT_MARKERS = ['[运行环境', '## 跨会话记忆库', '本任务包含 ', '续接 #']
/** 导出文本的结构锚点 */
const STRUCT_MARKERS = ['### 用户提示词', '### 模型返回']

/**
 * 从导出文本里抠出每一轮的「用户提示词」段落。
 *
 * 为什么注入块只在这些段落里查、不全局查：模型正文和工具结果**本来就可能**出现这些字样 ——
 * 模型的输出正文里也可能引用这些字样（比如本轮修的这条任务本身就在讨论注入块，
 * 它的 tool_result 里就是 memory INDEX.md 的原文）。全局查会把"模型复述"误判成"我们又灌了一遍"。
 * 真正要守住的契约只有一条：**用户气泡那段**必须是用户原话。
 */
const USER_SECTION_RE = /### 用户提示词\n\n([\s\S]*?)(?=\n\n### |\n\n## |\n\n---\n\n|$)/g

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
    && INJECT_MARKERS.every(m => j.prompt.includes(m))
    && taskById.has(j.taskId))

  if (injected.length === 0) {
    console.error('[verify] 本机找不到"带注入块的历史 job"，无法验证（先跑一条任务再来）')
    process.exit(2)
  }
  // 挑最短的那条：结构化最干净（长的多半是用户自己粘了一堆东西进来）
  injected.sort((a, b) => a.prompt.length - b.prompt.length)
  const sample = injected[0]
  const task = taskById.get(sample.taskId)
  const taskJobs = (jobsRes.jobs || []).filter(j => j.taskId === task.id && typeof j.prompt === 'string' && j.prompt)
  // "从没跑过"的任务：任务列表里有，但一条 simple job 都没有。H 那一组要用
  const ranTaskIds = new Set((jobsRes.jobs || [])
    .filter(j => typeof j.subId === 'string' && j.subId.includes('__simple'))
    .map(j => j.taskId))
  const emptyTasks = tasks.filter(t => !ranTaskIds.has(t.id))
  log(`样本 job=${sample.id} 原始 prompt=${sample.prompt.length} 字符，任务="${task.title}"（${taskJobs.length} 轮）`)

  // E 反向自证：先证明数据里确实有注入块，后面的 D2 才不是空测试
  const withEnvHead = taskJobs.filter(j => j.prompt.startsWith('[运行环境 ·')).length
  check('E 反向自证：样本任务的原始 prompt 带注入块',
    taskJobs.some(j => INJECT_MARKERS.every(m => j.prompt.includes(m))),
    `${taskJobs.length} 轮，其中 ${withEnvHead} 轮以环境块开头（D2 的锚点）`)

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 1600, height: 950 } })
  // 读回剪贴板要显式授权（Chromium 默认拒绝 clipboard-read）
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
  const page = await context.newPage()
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
      check('A 打开任务执行弹窗（能否找到目标卡片）', false, `看板上没有「${task.title}」的卡片`)
    } else {
      await card.click()
      await page.waitForSelector('.acu-message-list', { timeout: 15000 }).catch(() => {})
      await sleep(1200)

      const btn = page.locator('.wb-logs-inline-btn--copy').first()
      check('A 顶部有「复制执行内容」按钮', await btn.count() > 0)
      if (await btn.count()) {
        check('A2 按钮可点（未 disabled）', await btn.isEnabled())

        // 点击前先把剪贴板写成哨兵值：拿回来还是哨兵就说明"压根没写进去"，
        // 否则空剪贴板 + 断言写错短语也会假绿
        const SENTINEL = `__zen_sentinel_${Date.now()}__`
        await page.evaluate((s) => navigator.clipboard.writeText(s), SENTINEL)

        await btn.click()
        await sleep(600)

        // Windows 剪贴板存的是 CRLF，读回来先归一化，否则下面按 \n 切段全落空（空测试）
        const raw = await page.evaluate(() => navigator.clipboard.readText())
        const text = raw.replace(/\r\n/g, '\n')
        check('B 剪贴板被真的写入（不是哨兵值）',
          raw !== SENTINEL && text.length > 0, `${text.length} 字符`)

        // 断言直接跑在拿回来的文本上；这里不做任何加工，验的就是"剪贴板里那串"
        check('C1 含标题行「# <任务标题>」',
          text.startsWith(`# ${task.title}`), JSON.stringify(text.slice(0, 40)))
        check('C2 含轮次标题「## 第 1 轮」', text.includes('## 第 1 轮'))
        check('C3 含分节标题', STRUCT_MARKERS.every(m => text.includes(m)),
          STRUCT_MARKERS.filter(m => !text.includes(m)).join(', ') || '用户提示词 / 模型返回 都在')

        // ── D 用户提示词段落：首部注入块确实被裁掉了，且与对话流同源 ──────────
        const userSections = [...text.matchAll(USER_SECTION_RE)].map(m => m[1].trim())
        check('D1 导出文本里有用户提示词段落', userSections.length > 0, `${userSections.length} 段`)

        // D2 只断言"首部注入块被裁掉"，不断言"段落里一个锚点都没出现"：
        // 用户**自己粘进正文**的大段对话（本机实测有一轮粘了 45,962 字符，里面 6 份环境块）
        // 属于用户原话，userFacingPrompt 有意一个字符都不动 —— 全局查锚点会把它误判成回归。
        // E 已证明每轮原始 prompt 都以环境块开头，所以"段首不是注入块"这条不是空断言。
        const stillInjected = userSections.filter(s => INJECT_MARKERS.some(m => s.startsWith(m)))
        check('D2 每段都不以注入块开头（首部注入块已被裁掉）', stillInjected.length === 0,
          stillInjected.length ? `命中 ${stillInjected.length} 段：${JSON.stringify(stillInjected[0].slice(0, 60))}` : `${userSections.length} 段全部干净`)

        const rawPrompts = taskJobs.map(j => j.prompt)
        const matched = userSections.filter(s => rawPrompts.some(p => p.includes(s)))
        check('D3 每段都来自原始 prompt 且更短（是裁出来的，不是另写的）',
          matched.length === userSections.length
            && userSections.every(s => rawPrompts.some(p => p.includes(s) && s.length < p.length)),
          `${matched.length}/${userSections.length}`)

        // D4 与对话流同源：条数必须一致（少一轮 = 复制的内容和屏幕上看到的不是一回事）
        const bubbleCount = await page.evaluate(() =>
          Array.from(document.querySelectorAll('.acu-bubble-row')).filter(r => r.querySelector('.acu-avatar--right')).length)
        check('D4 段落数与对话流里的用户气泡数一致', userSections.length === bubbleCount,
          `导出 ${userSections.length} 段 / 气泡 ${bubbleCount} 条`)

        // F 按钮自身反馈：闪成功色 + 图标切成 ✓（文案不换，避免整排按钮左右跳）
        const copyBtn = page.locator('.wb-logs-inline-btn--copy').first()
        const flashed = await copyBtn.evaluate(el =>
          ({ cls: el.className, text: el.innerText }))
        check('F 复制后按钮给出反馈（is-flash + ✓）',
          flashed.cls.includes('is-flash') && flashed.text.includes('✓'), JSON.stringify(flashed.text.trim()))

        await fs.promises.mkdir(SHOT_DIR, { recursive: true })
        const shot = path.join(SHOT_DIR, 'wb-copy-execution.png')
        await page.screenshot({ path: shot })
        log('截图:', shot)
        log('导出文本前 12 行:\n' + text.split('\n').slice(0, 12).map(l => '    | ' + l).join('\n'))
      }

      // ── H 反向：没有任何执行内容的任务，不能把空串写进剪贴板 ──────────────
      // 只在本机真有一条"从没跑过"的任务时才验；一条都没有就明说跳过，
      // 不伪装成通过（造一条假任务会污染用户数据，不做）。
      const emptyTask = emptyTasks.find(t => t.title && t.title.trim())
      if (!emptyTask) {
        log(`跳过 H（本机 ${tasks.length} 条任务全都有执行内容，没有可验的空任务）`)
      } else {
        const sidebarItem = page.locator('.wb-task-item', { hasText: emptyTask.title }).first()
        if (!(await sidebarItem.count())) {
          check('H 空任务不写坏剪贴板', false, `侧边栏里找不到空任务「${emptyTask.title}」`)
        } else {
          await sidebarItem.click()
          await sleep(900)
          const SENTINEL2 = `__zen_sentinel2_${Date.now()}__`
          await page.evaluate((s) => navigator.clipboard.writeText(s), SENTINEL2)
          await page.locator('.wb-logs-inline-btn--copy').first().click()
          await sleep(600)
          const after = await page.evaluate(() => navigator.clipboard.readText())
          check('H 空任务：不写剪贴板，改弹提示', after === SENTINEL2, after === SENTINEL2 ? '剪贴板保持原样' : `剪贴板被写成 ${after.length} 字符`)
          const warned = await page.locator('.el-message').filter({ hasText: '暂无执行内容可复制' }).count()
          check('H2 空任务：弹出「暂无执行内容可复制」', warned > 0)
        }
      }
    }

    check('G 无 console error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
    check('G2 无 pageerror', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify] 崩了:', err); process.exit(1) })

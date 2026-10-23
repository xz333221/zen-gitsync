/**
 * 思维导图页的 g ai 面板：开关 / 与画布分宽 / 拖拽 / 全屏 / AI 导图草稿应用。
 *
 * 为什么要有这个探针：
 *   思维导图页此前只有「新建 / 从MD导入 / 复制MD」这几个手动入口，用户 2026-10-23 反馈
 *   "这个页面也能展示出 g ai，能和 ai 对话生成思维导图，就像文件空间里一样"。
 *   实现就是把文件空间那块 EditorAgentPanel 搬过来，再加一条"AI 回答里给 ```mindmap
 *   大纲 → 一键应用成导图"的链路。这两件事都不靠肉眼能守住：
 *     · 面板是懒挂载 + v-show 保状态的，摆了没摆、分宽对不对，只有量几何才说得清；
 *     · 草稿链路跨了「SSE → 消息正文 → 正则 → markdownToMindMap → 落盘 → 重挂载」六步，
 *       任何一步断了界面上都只是"什么都没发生"。
 *
 * 验收契约：
 *   P1 打开夹具导图：画布根节点文字 == 夹具里的根
 *   P2 点「g ai 对话」：.editor-agent-panel 出现且可见；输入框里的「当前文档」卡片名字
 *      == 导图文件名（证明宿主把 activeFileName 传进去了）
 *   P3 未拖过时面板与画布**分宽**：两边都 > 300px 且加起来 ≈ 编辑区宽（不是独占/塌成 0）
 *   P4 向左拖分隔条 120px：画布窄 ≈120、面板宽 ≈120（真的是在改布局，不是画条线）
 *   P5 全屏：面板矩形与 .mm-editor 矩形**逐边相等**；Esc 退出后不再铺满
 *   P6 发一条消息（桩 SSE 回一段带 ```mindmap 的回答）→ 草稿条出现，标题与节点数对得上
 *   P7 点「应用到当前导图」→ 确认框 → 点「覆盖」→ **盘上的文件**根节点变成草稿的根，
 *      且画布上的根节点文字跟着变（证明重挂载生效，不是只写了盘）
 *   P9 无（非存量）pageerror —— 库 MessageRail 那条 getBoundingClientRect 是存量，见 isStockLibError
 *
 * 反向（--reverse）：注入 `.mm-draft{display:none!important}` —— 草稿节点必须仍在 DOM
 *   里（数据链路没断）、但不可见；正向组里"草稿条可见 + 文本正确"那条要翻红。
 *   没有这个反证，"草稿出现了"可能被一个永远渲染的空条骗过去。
 *
 * 前置：dev server 已起（前端 5544，后端端口从 .env.local / .port 读）；
 *      仓库里有 flow-mindmap（src/ui/client/node_modules）。
 * 用法：node scripts/verify-mindmap-ai.cjs
 *       node scripts/verify-mindmap-ai.cjs --reverse
 * 退出码：0 全通过（或反向组如期翻红）；1 有失败项；2 环境没起 / 前置不足。
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const ROOT = path.resolve(__dirname, '..')
const REVERSE = process.argv.includes('--reverse')
const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'mindmap-ai-verify')

const results = []
const pageErrors = []

/**
 * 存量红：组件库 zen-ai-chat-ui 的 MessageRail 在自己的 ResizeObserver 里调
 * `R.getBoundingClientRect()`，偶尔对一个不是元素的东西调（报
 * `TypeError: R.getBoundingClientRect is not a function`）。
 * 堆栈整条都在库的打包产物里，本仓库改不了；「智能体」页 / 文件空间面板同样会踩到。
 * 这里只放过这一条签名，别的 pageerror 照旧判红 —— 别把 P9 写成宽泛的"忽略 TypeError"。
 */
function isStockLibError(text = '') {
  return text.includes('getBoundingClientRect is not a function')
    && text.includes('zen-ai-chat-ui')
}

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log('[verify]', ...a)

async function waitUntil(fn, timeout = 8000, interval = 120) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true
    await sleep(interval)
  }
  return false
}

// ── 夹具：一个临时导图目录 + 一张导图 ───────────────────────────
const FIXTURE_DIR = path.join(os.tmpdir(), `zgs-mindmap-ai-${process.pid}`)
const FIXTURE_FILE = path.join(FIXTURE_DIR, 'probe.mindmap.json')
const ROOT_TEXT = 'Probe 原图'

function writeFixture() {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true })
  fs.mkdirSync(FIXTURE_DIR, { recursive: true })
  const data = {
    id: 'root-1',
    text: ROOT_TEXT,
    children: [
      { id: 'c1', text: '子节点甲', children: [] },
      { id: 'c2', text: '子节点乙', children: [] },
    ],
  }
  fs.writeFileSync(FIXTURE_FILE, JSON.stringify(data, null, 2), 'utf8')
}

function readFixtureRoot() {
  try {
    const json = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'))
    return String(json?.text || '')
  } catch {
    return ''
  }
}

// 桩 SSE 里那段回答：模型该给的形状（一个 ```mindmap 块 + 块外一句说明）
const DRAFT_TITLE = 'Java 后端路线'
const DRAFT_MD = [
  `# ${DRAFT_TITLE}`,
  '## 语言基础',
  '### 集合与泛型',
  '### 并发',
  '## 框架',
  '### Spring Boot',
  '## 工程化',
  '## 数据层',
].join('\n')
const DRAFT_NODES = 8
const REPLY_TEXT = `按这个结构生成：\n\n\`\`\`mindmap\n${DRAFT_MD}\n\`\`\`\n\n应用后可以直接在画布上继续拖。`

/**
 * 打开思维导图视图（活动栏那颗拓扑星图标；标题走 i18n，中英都认）。
 * 冷启动时活动栏点下去可能被启动引导弹窗 / 浮层吃掉（点了没反应），
 * 所以点完要验"视图真的切过去了"，没切就 Esc 关浮层再点一次。
 */
async function openMindmapView(page) {
  await page.waitForSelector('.activity-btn', { timeout: 20000 })
  const btn = page.locator('.activity-btn')
  const count = await btn.count()
  let target = null
  for (let i = 0; i < count; i++) {
    const label = await btn.nth(i).getAttribute('aria-label')
    if (label && /思维导图|mind\s*map/i.test(label)) { target = btn.nth(i); break }
  }
  if (!target) return false
  for (let attempt = 0; attempt < 3; attempt++) {
    await target.click({ force: true })
    if (await waitUntil(async () => (await page.locator('.mindmap-view').count()) > 0, 3000)) return true
    await page.keyboard.press('Escape')
    await sleep(400)
  }
  return (await page.locator('.mindmap-view').count()) > 0
}

async function main() {
  // 0) 前置：dev server 活着
  let uptime = ''
  try {
    const res = await fetch(`${BASE}/api/app-version`)
    uptime = String(res.status)
  } catch (err) {
    console.error(`前置不足：${BASE} 连不上（dev server 没起？）${err?.message || err}`)
    process.exit(2)
  }
  if (uptime !== '200') {
    console.error(`前置不足：/api/app-version 返回 ${uptime}`)
    process.exit(2)
  }

  writeFixture()
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    page.on('pageerror', (err) => pageErrors.push(String(err?.stack || err?.message || err)))

    if (REVERSE) {
      // 反证：只把草稿条藏起来，数据链路一点不动
      await page.addInitScript(() => {
        const style = document.createElement('style')
        style.textContent = '.mm-draft { display: none !important; }'
        document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style))
      })
    }

    // 目录清单来自 configStore.ui.mindmapDirs —— 在真实配置上盖一层夹具目录，
    // 别的字段全保留（整份桩会让主题/模型等一串东西退回默认值，探针就不再验真环境）
    await page.route('**/api/config/getConfig', async (route) => {
      const res = await route.fetch()
      const json = await res.json().catch(() => ({}))
      json.ui = { ...(json.ui || {}), mindmapDirs: [FIXTURE_DIR] }
      await route.fulfill({ response: res, json })
    })

    // 会话列表必须桩：AgentView/面板那条"当前会话不在列表里就 newSession()"的护栏
    // 会在第一轮跑完时把整屏清掉（只看到欢迎页）
    await page.route('**/api/agent/sessions**', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          sessions: [{
            sessionId: 'probe-session',
            title: '导图会话',
            source: 'web',
            cwd: '',
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

    // 聊天：一段完整 SSE（meta → content → done → turn_done），发完即断流
    const chatBodies = []
    await page.route('**/api/agent/chat', async (route) => {
      chatBodies.push(route.request().postData() || '')
      const events = [
        { type: 'meta', sessionId: 'probe-session', title: '导图会话' },
        { type: 'content', delta: REPLY_TEXT },
        { type: 'done', content: REPLY_TEXT },
        { type: 'turn_done', turnIndex: 1, durationMs: 1200 },
      ]
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
        body: events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''),
      })
    })

    log(`打开 ${BASE}`)
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
    // 启动引导弹窗 / 首次提示可能挡住活动栏
    for (let i = 0; i < 4; i++) {
      const overlay = page.locator('.el-overlay').first()
      if (await overlay.count() > 0 && await overlay.isVisible().catch(() => false)) {
        await page.keyboard.press('Escape')
        await sleep(300)
      } else break
    }

    // ── P1 打开夹具导图 ──────────────────────────────────────
    const switched = await openMindmapView(page)
    check('P0 活动栏里有「思维导图」入口', switched)
    if (!switched) throw new Error('找不到思维导图入口')

    await page.waitForSelector('.mm-sidebar', { timeout: 15000 })
    const fileRow = page.locator('.mm-file-item').first()
    const gotFile = await waitUntil(async () => (await fileRow.count()) > 0, 10000)
    check('P1a 夹具目录下的导图出现在左侧列表', gotFile)
    if (gotFile) await fileRow.click()
    await sleep(1200)

    const canvasRootText = async () => page.evaluate(() => {
      const c = document.querySelector('.mm-canvas')
      return c ? (c.textContent || '') : ''
    })
    const hasRoot = await waitUntil(async () => (await canvasRootText()).includes(ROOT_TEXT), 10000)
    check(`P1b 画布渲染出夹具导图的根「${ROOT_TEXT}」`, hasRoot)

    // ── P2 打开 g ai 面板 ───────────────────────────────────
    const aiBtn = page.locator('.mm-ai-btn')
    check('P2a 工具栏有 g ai 开关', (await aiBtn.count()) === 1)
    await aiBtn.click()
    await sleep(1500)

    const panel = page.locator('.mm-editor .editor-agent-panel')
    const panelVisible = (await panel.count()) > 0 && await panel.isVisible().catch(() => false)
    check('P2b g ai 面板出现在画布右侧', panelVisible)

    const contextName = (await page.locator('.mm-ai-panel .agent-context-att-name').first().textContent().catch(() => '')) || ''
    check('P2c 输入框里挂着「当前导图」卡片', contextName.trim() === 'probe.mindmap.json',
      `text=${contextName.trim()}`)

    // 面板一开画布窄一半：导图必须重新居中，不能半张图被推出可视区
    // （实测过的翻车：画布 1312→652，根节点右缘 1020 > 画布右缘 940）
    const inView = await page.evaluate(() => {
      const cv = document.querySelector('.mm-canvas')?.getBoundingClientRect()
      const root = Array.from(document.querySelectorAll('.zm-node'))
        .find(n => (n.textContent || '').includes('Probe 原图'))
      const r = root?.getBoundingClientRect()
      if (!cv || !r) return null
      return {
        inside: r.left >= cv.left - 1 && r.right <= cv.right + 1,
        left: Math.round(r.left), right: Math.round(r.right),
        cvLeft: Math.round(cv.left), cvRight: Math.round(cv.right),
      }
    })
    check('P2d 打开面板后根节点仍在画布可视区内（导图重新居中）',
      !!inView && inView.inside,
      inView ? `root=${inView.left}..${inView.right} canvas=${inView.cvLeft}..${inView.cvRight}` : 'no-node')

    // ── P3 分宽 ─────────────────────────────────────────────
    const boxes = async () => page.evaluate(() => {
      const ed = document.querySelector('.mm-editor')
      const cv = document.querySelector('.mm-canvas')
      const pn = document.querySelector('.mm-ai-panel')
      const r = (el) => el ? el.getBoundingClientRect() : null
      const e = r(ed), c = r(cv), p = r(pn)
      return e && c && p
        ? { editorW: e.width, canvasW: c.width, panelW: p.width, editorH: e.height, panelH: p.height }
        : null
    })
    const b0 = await boxes()
    check('P3 面板与画布分宽（两边都 > 300，加起来 ≈ 编辑区宽）',
      !!b0 && b0.canvasW > 300 && b0.panelW > 300
        && Math.abs((b0.canvasW + b0.panelW + 7) - b0.editorW) <= 2,
      b0 ? `canvas=${Math.round(b0.canvasW)} panel=${Math.round(b0.panelW)} editor=${Math.round(b0.editorW)}` : 'no-boxes')

    // ── P4 拖分隔条 ─────────────────────────────────────────
    const resizer = page.locator('.mm-editor .mm-resizer')
    let dragOk = false
    let dragExtra = 'no-resizer'
    if (await resizer.count() > 0) {
      const rb = await resizer.boundingBox()
      if (rb) {
        const x = rb.x + rb.width / 2
        const y = rb.y + rb.height / 2
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x - 120, y, { steps: 8 })
        await page.mouse.up()
        await sleep(400)
        const b1 = await boxes()
        dragOk = !!b1 && Math.abs((b0.canvasW - b1.canvasW) - 120) <= 6
          && Math.abs((b1.panelW - b0.panelW) - 120) <= 6
        dragExtra = b1
          ? `canvas ${Math.round(b0.canvasW)}→${Math.round(b1.canvasW)} panel ${Math.round(b0.panelW)}→${Math.round(b1.panelW)}`
          : 'no-boxes-after'
      }
    }
    check('P4 向左拖 120px：画布窄 120、面板宽 120', dragOk, dragExtra)

    // ── P5 全屏 ─────────────────────────────────────────────
    await page.locator('.mm-ai-panel .agent-panel-fullscreen-btn').click()
    await sleep(500)
    const fsBox = await page.evaluate(() => {
      const ed = document.querySelector('.mm-editor')?.getBoundingClientRect()
      const pn = document.querySelector('.mm-ai-panel')?.getBoundingClientRect()
      return ed && pn ? {
        dw: Math.abs(ed.width - pn.width), dh: Math.abs(ed.height - pn.height),
        dx: Math.abs(ed.left - pn.left), dy: Math.abs(ed.top - pn.top),
      } : null
    })
    check('P5a 全屏对话铺满编辑区（四边与 .mm-editor 齐平）',
      !!fsBox && fsBox.dw <= 1 && fsBox.dh <= 1 && fsBox.dx <= 1 && fsBox.dy <= 1,
      fsBox ? JSON.stringify(fsBox) : 'no-boxes')

    await page.keyboard.press('Escape')
    await sleep(400)
    const afterEsc = await page.evaluate(() => {
      const ed = document.querySelector('.mm-editor')?.getBoundingClientRect()
      const pn = document.querySelector('.mm-ai-panel')?.getBoundingClientRect()
      return ed && pn ? Math.abs(ed.width - pn.width) : -1
    })
    check('P5b Esc 退出全屏（不再与编辑区同宽）', afterEsc > 10, `dw=${Math.round(afterEsc)}`)

    // ── P6 发消息 → 草稿 ───────────────────────────────────
    const draftCountBefore = await page.locator('.mm-draft').count()
    check('P6a 发消息之前没有草稿条', draftCountBefore === 0, `count=${draftCountBefore}`)

    const textarea = page.locator('.mm-ai-panel .acu-input-textarea').first()
    await textarea.waitFor({ state: 'visible', timeout: 10000 })
    await textarea.fill('帮我做个 Java 学习路线导图')
    await textarea.press('Enter')

    const draftAppeared = await waitUntil(async () => (await page.locator('.mm-draft').count()) > 0, 20000)
    const draftInfo = await page.evaluate(() => {
      const el = document.querySelector('.mm-draft')
      if (!el) return null
      const visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
      return {
        visible,
        text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
      }
    })

    if (REVERSE) {
      check('R1 草稿被 CSS 藏掉后不可见（但仍在 DOM 里 = 数据链路没断）',
        draftAppeared && !!draftInfo && !draftInfo.visible,
        draftInfo ? `visible=${draftInfo.visible} text=${draftInfo.text}` : 'no-node')
      check('R2 藏起来的草稿文本里仍有草稿标题（不是空条）',
        !!draftInfo && draftInfo.text.includes(DRAFT_TITLE),
        draftInfo ? draftInfo.text.slice(0, 80) : 'no-node')
      // 反向也把请求体断言走一遍：docNote 是这条链路的另一半，藏 CSS 不该影响它
      check('R3 请求体带上了 docNote（导图约定）',
        chatBodies.some(b => b.includes('"docNote"') && b.includes('mindmap')),
        chatBodies.length ? chatBodies[0].slice(0, 120) : 'no-request')
    } else {
      check('P6b 回答里的 ```mindmap 大纲变成了画布顶部的草稿条',
        draftAppeared && !!draftInfo && draftInfo.visible,
        draftInfo ? `visible=${draftInfo.visible} text=${draftInfo.text}` : 'no-node')
      check(`P6c 草稿标题是「${DRAFT_TITLE}」、节点数 ${DRAFT_NODES}`,
        !!draftInfo && draftInfo.text.includes(DRAFT_TITLE) && draftInfo.text.includes(`${DRAFT_NODES}`),
        draftInfo ? draftInfo.text.slice(0, 80) : 'no-node')
      await page.screenshot({ path: path.join(SHOT_DIR, 'draft.png') })

      // ── P7 应用到当前导图 ─────────────────────────────────
      await page.locator('.mm-draft-btn--primary').click()
      await sleep(600)
      const confirmBtn = page.locator('.el-message-box__btns .el-button--primary').first()
      const hasConfirm = await waitUntil(async () => (await confirmBtn.count()) > 0, 5000)
      check('P7a 覆盖当前导图前有确认框', hasConfirm)
      if (hasConfirm) await confirmBtn.click()

      const saved = await waitUntil(async () => readFixtureRoot() === DRAFT_TITLE, 10000)
      check(`P7b 盘上的导图根节点变成「${DRAFT_TITLE}」`, saved, `root=${readFixtureRoot()}`)

      const canvasShowsDraft = await waitUntil(async () => (await canvasRootText()).includes(DRAFT_TITLE), 10000)
      check('P7c 画布跟着换成了新导图（重挂载生效）', canvasShowsDraft)

      const draftGone = (await page.locator('.mm-draft').count()) === 0
      check('P7d 应用之后草稿条收起', draftGone)

      check('P8 请求体带上了 docNote（导图约定）',
        chatBodies.some(b => b.includes('"docNote"') && b.includes('mindmap')),
        chatBodies.length ? chatBodies[0].slice(0, 120) : 'no-request')
    }

    await page.screenshot({ path: path.join(SHOT_DIR, REVERSE ? 'reverse.png' : 'main.png') })
    log(`截图：${SHOT_DIR}`)

    const freshErrors = pageErrors.filter(e => !isStockLibError(e))
    check('P9 无（非存量）pageerror', freshErrors.length === 0, freshErrors.slice(0, 2).join(' | '))
  } finally {
    await browser.close().catch(() => {})
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true })
  }
}

;(async () => {
  await main()
  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) {
    for (const f of failed) console.error(`  FAIL  ${f.name}${f.extra ? '  :: ' + f.extra : ''}`)
    process.exit(1)
  }
  console.log(REVERSE
    ? '反证通过：草稿条被藏掉后如期翻红，且数据链路仍在'
    : '通过：思维导图页的 g ai 面板与「对话生成导图」链路都成立')
  process.exit(0)
})().catch((err) => {
  console.error('[verify] 异常:', err?.stack || err)
  process.exit(1)
})

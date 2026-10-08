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

    // ── 智能体页 ────────────────────────────────────────────────────────────
    await page.locator('.activity-btn[aria-label^="智能体"]').first().click()
    await page.waitForSelector('.agent-tabs', { timeout: 15000 })
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

    // ── B1 主 Agent 控制台 ─────────────────────────────────────────────────
    await page.locator('.activity-btn[aria-label^="工作台"]').first().click()
    // 工作台是懒加载的独立 chunk，第一次进要等它挂上来（这里给足 25s，别用 catch 吞掉）
    const wbReady = await waitFor(async () =>
      (await page.locator('.board').count()) > 0 || (await page.locator('.acs__head').count()) > 0, 25000, 300)
    check('B1a 工作台视图已挂载', wbReady, `board=${await page.locator('.board').count()} acs__head=${await page.locator('.acs__head').count()}`)
    if (await page.locator('.oc__rail').count()) { await page.locator('.oc__rail').first().click(); await sleep(800) }
    // ★ 先切到「对话」档：控制台默认停在「指令」档，而 AgentChatSurface 是
    // `v-show="!collapsed && mode === 'chat'"` —— 停在指令档时它**在 DOM 里但 display:none**，
    // 按钮 rect 恒为 0。第一版只数 count 就宣布通过，等于验了个看不见的元素（探针假绿）。
    const chatMode = page.locator('.oc__mode-btn', { hasText: '对话' }).first()
    if (await chatMode.count()) { await chatMode.click().catch(() => {}); await sleep(800) }
    const CONSOLE_COPY = '.acs__head .csb .csb__btn:not(.csb__caret)'
    // 判据是**几何**而不是"在不在 DOM 里"：控制台展开后头条得有宽度
    const consoleShown = await waitFor(async () => {
      const r = await page.evaluate(() => {
        const head = document.querySelector('.acs__head')
        const btn = document.querySelector('.acs__head .csb .csb__btn:not(.csb__caret)')
        const hb = head ? head.getBoundingClientRect() : null
        const bb = btn ? btn.getBoundingClientRect() : null
        return { hw: hb ? Math.round(hb.width) : 0, bw: bb ? Math.round(bb.width) : 0, bh: bb ? Math.round(bb.height) : 0 }
      })
      return r.hw > 200 && r.bw >= 18 && r.bh >= 18
    }, 15000, 300)
    const cRect = await page.evaluate(() => {
      const b = document.querySelector('.acs__head .csb .csb__btn:not(.csb__caret)').getBoundingClientRect()
      return `${Math.round(b.width)}×${Math.round(b.height)}`
    })
    check('B1 ★ 主 Agent 控制台头条出现可点的复制按钮（真占了版面，不是 display:none）',
      consoleShown, `按钮 ${cRect}；DOM 里 ${await page.locator(CONSOLE_COPY).count()} 个`)
    if (consoleShown) {
      // 控制台在窄栏里「列表 / 对话」是**两页**（v-show 切换）：列表默认被藏着，
      // 不先点「会话列表」翻过去，条目数得到但点不动（第一版就卡在这个 30s 点击超时上）
      const listBtn = page.locator('.acs__icon-btn[aria-label="会话列表"]')
      if ((await listBtn.count()) && await listBtn.isVisible().catch(() => false)) {
        await listBtn.click()
        await sleep(700)
      }
      const cItems = page.locator('.acs__convs .acu-conv-item')
      // 列表是懒加载的（控制台的 useAgentChat 自己拉一次），等它出条目 —— 不给死等：
      // 夹具里没有会话是环境问题，不该算产品缺陷，但也不能当通过
      const hasConv = await waitFor(async () => (await cItems.count()) > 0, 15000, 400)
      if (!hasConv) {
        skip('B1c 控制台里复制一份出来', '控制台会话列表 15s 内没出条目')
      } else {
        await cItems.first().click()
        // 等对话真的画出来（大会话要几秒），没画出来就说明点错了条目
        const painted = await waitFor(async () =>
          (await page.locator('.acs__chat .acu-bubble-row.is-user').count()) > 0, 20000, 400)
        if (!painted) {
          skip('B1c 控制台里复制一份出来', '选中的会话没渲染出用户气泡')
        } else {
          await writeClipboard('__SENTINEL__')
          await page.locator(CONSOLE_COPY).first().click()
          await sleep(800)
          const cText = await readClipboard()
          const hasBody = cText.startsWith('# ') && (cText.includes('## 我') || cText.includes('## g ai'))
          check('B1c 控制台复制出来的也是一份会话 Markdown', hasBody,
            `长度 ${cText.length}：${cText.slice(0, 30).replace(/\n/g, '⏎')}`)
        }
      }
    }
    await page.screenshot({ path: path.join(SHOT_DIR, 'console.png') }).catch(() => {})

    // ── C1 文件空间 g ai 面板（三个容器共用一个组件，这里补上第三个的实地检查）──
    // 这个面板要「有打开的文件」才挂（`v-show="showAgentChat && tabs.length > 0"`），
    // 所以先开文件树里的一个文件，再点 .agent-toggle-btn。
    // 从工作台切过来时那一下点击偶尔会被正在卸载的视图吃掉 —— 点完没出树就再点一次。
    let treeReady = false
    for (let i = 0; i < 3 && !treeReady; i++) {
      await page.locator('.activity-btn[aria-label^="文件空间"], .activity-btn[aria-label^="编辑器"]').first().click().catch(() => {})
      treeReady = await waitFor(async () => (await page.locator('.tree-node').count()) > 3, 10000, 300)
    }
    if (!treeReady) {
      skip('C1 文件空间 g ai 面板', '文件树没加载出来')
    } else {
      const opened = await page.evaluate(() => {
        const el = [...document.querySelectorAll('.tree-name')].find(e => (e.textContent || '').trim() === 'README.md')
        const node = el ? el.closest('.tree-node') : null
        if (!node) return false
        node.click()
        return true
      })
      if (!opened) {
        skip('C1 文件空间 g ai 面板', '文件树里没找到 README.md')
      } else {
        await waitFor(async () => (await page.locator('.editor-tab.active').count()) > 0, 8000, 200)
        await page.locator('.agent-toggle-btn').first().click().catch(() => {})
        const PANEL_COPY = '.agent-panel-header .csb .csb__btn:not(.csb__caret)'
        const panelShown = await waitFor(async () => {
          const r = await page.evaluate(() => {
            const head = document.querySelector('.agent-panel-header')
            const btn = document.querySelector('.agent-panel-header .csb .csb__btn:not(.csb__caret)')
            const hb = head ? head.getBoundingClientRect() : null
            const bb = btn ? btn.getBoundingClientRect() : null
            return { hw: hb ? Math.round(hb.width) : 0, bw: bb ? Math.round(bb.width) : 0 }
          })
          return r.hw > 150 && r.bw >= 18
        }, 15000, 300)
        check('C1 ★ 文件空间 g ai 面板头条也有可点的复制按钮', panelShown,
          `DOM 里 ${await page.locator(PANEL_COPY).count()} 个`)
        if (panelShown) {
          // 同样是两页布局：先翻到「会话列表」选一条有内容的会话
          const pListBtn = page.locator('.agent-panel-icon-btn.agent-panel-list-btn')
          if ((await pListBtn.count()) && await pListBtn.isVisible().catch(() => false)) {
            await pListBtn.click()
            await sleep(700)
          }
          const pItems = page.locator('.agent-panel-convs .acu-conv-item')
          const pHasConv = await waitFor(async () => (await pItems.count()) > 0, 15000, 400)
          if (!pHasConv) {
            skip('C1b 文件空间面板里复制一份出来', '面板会话列表 15s 内没出条目')
          } else {
            await pItems.first().click()
            const pPainted = await waitFor(async () =>
              (await page.locator('.agent-panel-chat .acu-bubble-row.is-user').count()) > 0, 20000, 400)
            if (!pPainted) {
              skip('C1b 文件空间面板里复制一份出来', '选中的会话没渲染出用户气泡')
            } else {
              await writeClipboard('__SENTINEL__')
              await page.locator(PANEL_COPY).first().click()
              await sleep(800)
              const pText = await readClipboard()
              check('C1b 文件空间面板复制出来的也是一份会话 Markdown',
                pText.startsWith('# ') && (pText.includes('## 我') || pText.includes('## g ai')),
                `长度 ${pText.length}：${pText.slice(0, 30).replace(/\n/g, '⏎')}`)
            }
          }
        }
        await page.screenshot({ path: path.join(SHOT_DIR, 'editor-panel.png') }).catch(() => {})
      }
    }
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

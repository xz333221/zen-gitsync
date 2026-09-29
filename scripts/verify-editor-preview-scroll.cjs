/**
 * 文件空间 markdown 预览「切文件回顶部」回归验证。
 *
 * 症状（用户报）：预览面板滚到中间后切换文件，新文件的预览**还停在上一个文件的滚动位置**。
 *
 * 机理：`.preview-markdown`（= MarkdownPreview 的根节点）自己就是滚动容器（overflow:auto），
 * 而切 tab 时 v-else-if 分支里是同一个组件 → Vue 复用同一个 DOM 节点、只换 v-html 内容，
 * scrollTop 不在 patch 范围里，于是从上一个文件原样带过来。
 *
 *   P1 预览区确实是可滚动容器（scrollHeight > clientHeight），否则后面测的是假象
 *   P2 手动滚到 400 能生效（前置条件成立）
 *   P3 ★ 切到另一个 md 文件后 scrollTop === 0（本次修的核心）
 *   P4 内容**确实换了**（标题不同 / innerHTML 不同）——排除"只是滚回顶部、文件没切"
 *   P5 切回第一个文件同样回到顶部（不是单向特例）
 *   P6 反向护栏：同一个文件内容变化时**不该**把用户滚到顶（预览是编辑器的实时镜像，
 *      每敲一个字都跳回顶部就成了新 bug）——用编辑器输入触发 content 更新来验
 *
 * 前置：dev server 已启动（npm run dev:ping 两个 OK，前端 5544）。
 * 用法：node scripts/verify-editor-preview-scroll.cjs
 * 退出码：0 全通过，1 有失败项。
 */
const os = require('node:os')
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544'
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'zen-editor-preview-scroll')
const FILE_A = process.env.ZEN_FILE_A || 'README.md'
const FILE_B = process.env.ZEN_FILE_B || '源码笔记.md'
const SCROLL_TO = 400

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 点左侧文件树里的某个文件（按显示名精确匹配，根目录文件无需展开） */
async function clickTreeFile(page, name) {
  return page.evaluate((n) => {
    const el = [...document.querySelectorAll('.tree-name')]
      .find(e => (e.textContent || '').trim() === n)
    if (!el) return false
    const node = el.closest('.tree-node')
    if (!node) return false
    node.click()
    return true
  }, name)
}

async function waitFor(fn, timeout = 10000, step = 150) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 > timeout) return false
    await sleep(step)
  }
}

/** 预览容器（MarkdownPreview 根节点）的滚动与内容快照 */
async function readPreview(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.preview-markdown')
    if (!el) return null
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      heading: (el.querySelector('h1, h2')?.textContent || '').trim(),
      htmlLen: el.innerHTML.length,
      htmlHead: el.innerHTML.slice(0, 120),
    }
  })
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 30000 })
    await page.locator('.loading-container').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})

    // ── 进文件空间 ───────────────────────────────────────────────────────
    await page.locator('.activity-btn[aria-label^="文件空间"], .activity-btn[aria-label^="编辑器"]').first().click()
    const treeReady = await waitFor(async () => (await page.locator('.tree-node').count()) > 3, 20000)
    check('前置 文件树已加载', treeReady, `nodes=${await page.locator('.tree-node').count()}`)
    if (!treeReady) throw new Error('文件树没出来，后续无法验证')

    // ── 打开文件 A + 打开预览 ────────────────────────────────────────────
    check('前置 文件树里有 A 文件', await clickTreeFile(page, FILE_A), FILE_A)
    await waitFor(async () => (await page.locator('.editor-tab.active').count()) > 0, 8000)

    const previewOpen = await page.locator('.preview-markdown').count()
    if (!previewOpen) {
      await page.locator('.preview-toggle-btn').first().click()
    }
    const mdReady = await waitFor(async () => (await page.locator('.preview-markdown').count()) > 0, 8000)
    check('前置 预览面板已打开', mdReady)
    if (!mdReady) throw new Error('预览面板没出来')
    await sleep(600)

    // ── P1 可滚动 ───────────────────────────────────────────────────────
    const a0 = await readPreview(page)
    check('P1 预览是滚动容器（内容高于视口）',
      !!a0 && a0.scrollHeight > a0.clientHeight + 40,
      a0 ? `scrollHeight=${a0.scrollHeight} clientHeight=${a0.clientHeight}` : 'no preview')
    if (!a0 || a0.scrollHeight <= a0.clientHeight + 40) throw new Error('文件 A 太短，滚动无从验证')

    // ── P2 手动滚动生效 ─────────────────────────────────────────────────
    await page.evaluate((top) => { document.querySelector('.preview-markdown').scrollTop = top }, SCROLL_TO)
    await sleep(200)
    const a1 = await readPreview(page)
    check(`P2 滚到 ${SCROLL_TO} 生效`, Math.abs(a1.scrollTop - SCROLL_TO) < 8, `scrollTop=${a1.scrollTop}`)

    // ── P3 切文件回到顶部 ───────────────────────────────────────────────
    check('前置 文件树里有 B 文件', await clickTreeFile(page, FILE_B), FILE_B)
    await waitFor(async () => (await readPreview(page))?.scrollTop !== a1.scrollTop
      || (await readPreview(page))?.htmlLen !== a1.htmlLen, 8000)
    await sleep(600)
    const b0 = await readPreview(page)
    check('P3 ★ 切到另一个文件后预览回到顶部', !!b0 && b0.scrollTop === 0,
      b0 ? `scrollTop=${b0.scrollTop}（期望 0）` : 'no preview')

    // ── P4 内容真的换了 ─────────────────────────────────────────────────
    check('P4 预览内容确实换成了 B 文件',
      !!b0 && b0.htmlLen !== a1.htmlLen,
      `A: len=${a1.htmlLen} head="${a1.htmlHead.slice(0, 40)}" / B: len=${b0?.htmlLen} head="${b0?.htmlHead.slice(0, 40)}"`)
    await page.screenshot({ path: path.join(SHOT_DIR, 'after-switch.png') }).catch(() => {})

    // ── P5 切回 A 也回顶部 ──────────────────────────────────────────────
    await page.evaluate((top) => { document.querySelector('.preview-markdown').scrollTop = top }, SCROLL_TO)
    await sleep(200)
    await clickTreeFile(page, FILE_A)
    await waitFor(async () => (await readPreview(page))?.htmlLen === a1.htmlLen
      || (await readPreview(page))?.scrollTop === 0, 8000)
    await sleep(600)
    const a2 = await readPreview(page)
    check('P5 切回第一个文件同样回到顶部', !!a2 && a2.scrollTop === 0, `scrollTop=${a2?.scrollTop}`)

    // ── P6 反向：同一文件内容变化不该把滚动位置吃掉 ─────────────────────
    // 在编辑器里敲字 → tab.content 变 → 预览重渲染，此时**不该**回到顶部
    const typed = await page.evaluate(() => {
      const el = document.querySelector('.cm-content, .monaco-editor textarea, .editor-textarea')
      if (!el) return 'no-editor'
      el.focus()
      return 'ok'
    })
    if (typed === 'ok') {
      await page.evaluate((top) => { document.querySelector('.preview-markdown').scrollTop = top }, SCROLL_TO)
      await sleep(150)
      await page.keyboard.type(' ', { delay: 30 })
      await sleep(1200)
      const a3 = await readPreview(page)
      check('P6 同一文件内容变化时保住滚动位置（预览是实时镜像）',
        Math.abs(a3.scrollTop - SCROLL_TO) < 8, `scrollTop=${a3.scrollTop}（期望 ≈${SCROLL_TO}）`)
      // 撤销这次输入：编辑器是失焦才自动保存，这里不点走焦点就不会落盘；
      // 撤完确认 tab 不再是 dirty，脏了就多撤几次（别把工作区的文件留在脏状态）
      await page.keyboard.press('Control+z')
      await sleep(400)
      const stillDirty = async () => (await page.locator('.editor-tab.active .tab-dirty-dot').count()) > 0
      for (let i = 0; i < 3 && await stillDirty(); i++) {
        await page.keyboard.press('Control+z')
        await sleep(300)
      }
      check('P6b 输入已撤销（tab 回到未修改）', !(await stillDirty()))
    } else {
      log('跳过 P6：没找到编辑器输入区')
    }

    await page.screenshot({ path: path.join(SHOT_DIR, 'final.png') }).catch(() => {})
  } finally {
    await browser.close().catch(() => {})
  }

  const failed = results.filter(r => !r.ok)
  const noisy = consoleErrors.filter(e => !/favicon|ResizeObserver|DevTools/i.test(e))
  console.log('\n[verify] 截图目录:', SHOT_DIR)
  console.log(`[verify] 结果: ${results.length - failed.length}/${results.length} 通过`)
  if (noisy.length) console.log('[verify] console errors:', noisy.slice(0, 5))
  if (pageErrors.length) console.log('[verify] page errors:', pageErrors.slice(0, 5))
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('[verify] 脚本异常:', e)
  process.exit(1)
})

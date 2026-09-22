/**
 * 「复制文件夹名称」入口 —— 浏览器交互验证。
 *
 * 两处入口、一个语义：复制的是**最后一级目录名**，不是完整路径。
 *   A 顶栏目录选择器的图标按钮（DirectorySelector.vue，variant=header）
 *   B 编排台项目列表「打开方式」菜单里的一项（WorkbenchProjectPanel.vue）
 *
 * 守的契约：
 *   A1 顶栏渲染出「复制文件夹名称」按钮（正向锚：新入口真的在）
 *   A2 点它写入剪贴板的是文件夹名（= 当前目录的 basename），**不是**完整路径
 *   A3 成功提示是「已复制文件夹名称」
 *   A4 反向锚：右键目录名仍然是「已复制目录路径」且写完整路径 ——
 *      两个功能不能被合并成一个（路径粘进终端、名称拿去做文件名，场景不同）
 *   B1 「打开方式」菜单里出现「复制文件夹名称」
 *   B2 点它写入的是**该项目名**（= 该行 title 里完整路径的 basename，不是路径），且菜单随即关闭
 *   B3 反向锚：原有三项（文件管理器 / 终端 / 新标签页 g ui）与「用工具打开」标题都还在
 *   B4 位置锚：新项要落在「打开」组里（分隔线之前），不掉进「用工具打开」那组
 *
 * 两处踩过的坑（写脚本时记下来，免得下次重踩）：
 *   · 每行有**两个** `.proj-item__action`（「打开文件夹」+「打开方式」菜单），
 *     直接取 .first() 会撞 strict mode；菜单按钮要用 aria-label 前缀定位。
 *   · 活动栏刚出现时视图还没挂，点「工作台」可能落在 bootstrap 那一帧上 ——
 *     所以进入工作台要"没看到 .board 就再点一次"，不能只点一下。
 *   · ⚠️ 点「打开方式」**必须先 hover 整行**：`.proj-item__actions` 空闲时是
 *     opacity:0 + pointer-events:none，只有 `.proj-item:hover` 才恢复 auto；
 *     而 Playwright 的"能否收到事件"命中测试发生在移动鼠标**之前**，此时命中落在
 *     行内 opacity:0 却仍吃事件的「当前」徽标上 → 报 badge intercepts pointer events。
 *     真人不会遇到（鼠标一进到行上按钮就已经可点了），纯粹是 headless 时序问题。
 *   · 「用工具打开」是 `.proj-menu__title`（分组标题），不是 `.proj-menu__label` ——
 *     只查 label 的断言会误报"少了这一项"。
 *
 * 剪贴板怎么断言：headless 里 navigator.clipboard 需要权限，所以用 addInitScript
 * 在页面脚本之前把它换成记录器（window.__copied 数组）。这样断言的是"我们到底
 * 往剪贴板写了什么"，而不是"某个 toast 出现过"——后者即使写错内容也会绿。
 *
 * 反向验证（把改动撤掉后哪几条会红）：
 *   · 删掉顶栏那个 IconButton → A1/A2/A3 红（找不到按钮）
 *   · 把 onCopyFolderName 改成写 currentDirectory → A2 红、A4 仍绿
 *   · 把菜单项换成 p.path → B2 红
 *   · 把新项挪到 `.proj-menu__sep` 之后 → B4 红（B1/B2 仍绿 —— 位置锚单独有效）
 *
 * 用法：先 `npm run dev`（后端 5545 + vite 5544），再
 *   node scripts/verify-copy-folder-name.cjs
 */
const path = require('node:path')
const os = require('node:os')
// playwright 装在 src/ui/client 下，把它的 node_modules 挂进解析路径，脚本才能独立跑
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const API = process.env.ZEN_API || 'http://127.0.0.1:5545'

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function waitUntil(fn, timeout = 12000, interval = 150) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true
    await sleep(interval)
  }
  return false
}

/** 只取最后一级目录名 —— 和服务端/前端的口径一致（\ 与 / 都当分隔符） */
const folderNameOf = (p) => String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || ''

async function main() {
  const alive = await fetch(`${API}/api/app-version`).then(r => r.ok).catch(() => false)
  if (!alive) {
    console.error(`后端没起（${API}）—— 先 npm run dev`)
    process.exit(2)
  }
  const dirRes = await fetch(`${API}/api/current_directory`).then(r => r.json()).catch(() => null)
  const currentDir = dirRes?.directory || dirRes?.currentDirectory || ''
  const expectedName = folderNameOf(currentDir)
  console.log(`[verify] 当前目录 = ${currentDir}`)
  console.log(`[verify] 期望复制到的文件夹名 = ${expectedName}`)

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 1600, height: 950 } })
  await context.addInitScript(() => {
    window.__copied = []
    const write = (t) => { window.__copied.push(String(t)); return Promise.resolve() }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } })
  })
  const page = await context.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  const copied = () => page.evaluate(() => window.__copied || [])
  const lastCopied = async () => { const all = await copied(); return all[all.length - 1] }
  const toast = () => page.evaluate(() => (document.querySelector('.el-message')?.textContent || '').trim())
  const clearToasts = () => page.evaluate(() => document.querySelectorAll('.el-message').forEach(n => n.remove()))

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 25000 })

    // ── A 顶栏 ─────────────────────────────────────────────────────
    const copyBtn = page.locator('.directory-actions button[aria-label="复制文件夹名称"]')
    const hasBtn = await waitUntil(async () => (await copyBtn.count()) === 1, 15000)
    check('A1 顶栏渲染出「复制文件夹名称」按钮', hasBtn, `count=${await copyBtn.count()}`)
    // 顶栏显示的目录名应与我们算出来的一致（否则后面的断言就是自说自话）
    const shownName = (await page.locator('.directory-display').first().textContent() || '').trim()
    check('A0 页面上的目录名与接口给的一致（夹具自检）', shownName === expectedName, `页面="${shownName}" 期望="${expectedName}"`)
    check('A1b 目录非空时按钮可用', !(await copyBtn.first().isDisabled()))

    if (hasBtn) {
      await copyBtn.first().click()
      await waitUntil(async () => (await toast()).includes('已复制文件夹名称'))
      check('A3 提示「已复制文件夹名称」', (await toast()).includes('已复制文件夹名称'), `toast="${await toast()}"`)
      const got = await lastCopied()
      check('A2a 复制内容是文件夹名', got === expectedName, `copied="${got}"`)
      check('A2b 复制内容不是完整路径', got !== currentDir, `copied="${got}"`)
      await clearToasts()
    }

    // A4 反向锚：右键目录名 → 复制完整路径（老行为不能被新功能吃掉）
    await page.locator('.directory-display').first().click({ button: 'right' })
    await waitUntil(async () => (await toast()).includes('已复制目录路径'))
    const gotPath = await lastCopied()
    check('A4a 右键目录名仍是「已复制目录路径」', (await toast()).includes('已复制目录路径'), `toast="${await toast()}"`)
    check('A4b 右键复制的是完整路径', gotPath === currentDir, `copied="${gotPath}"`)
    await clearToasts()

    // ── B 编排台项目列表 ────────────────────────────────────────────
    // 首次点击可能落在应用还在 bootstrap 的那一帧上（活动栏先出现、视图还没挂），
    // 所以这里重试几次 —— 等的是"工作台真的挂上了"，不是"点过一次"。
    let boardOk = false
    for (let i = 0; i < 6 && !boardOk; i++) {
      if ((await page.locator('.board').count()) > 0) { boardOk = true; break }
      await page.locator('.activity-btn[aria-label^="工作台"]').first().click({ timeout: 5000 }).catch(() => {})
      await sleep(900)
      boardOk = (await page.locator('.board').count()) > 0
    }
    check('B0a 进入工作台视图', boardOk)

    const rows = page.locator('.proj-item:not(.proj-item--all)')
    const rowOk = boardOk && await waitUntil(async () => (await rows.count()) > 0, 15000)
    check('B0b 项目列表就绪（有可操作的项目行）', rowOk, `rows=${await rows.count()}`)

    if (rowOk) {
      const firstName = (await rows.first().locator('.proj-item__name').textContent() || '').trim()
      // 行上的 title 就是项目完整路径（:title="p.path"）—— 拿它做"复制的不是路径"的反向锚
      const firstPath = (await rows.first().getAttribute('title')) || ''
      // 每行有两个按钮：「打开文件夹」（一键直达）与「打开方式」（菜单）—— 取后者。
      // ⚠️ 必须先 hover 整行：.proj-item__actions 空闲时是 opacity:0 + pointer-events:none，
      //    只有 .proj-item:hover 才恢复 auto。Playwright 的"能否收到事件"命中测试发生在
      //    移动鼠标之前，此时按钮 pointer-events 还是 none，命中测试会落到行内 opacity:0
      //    但仍吃事件的「当前」徽标上 → 报 "badge intercepts pointer events"。真人不会遇到，
      //    因为鼠标一进来到行上按钮就已经可点了。
      const menuBtn = rows.first().locator('button[aria-label^="打开方式"]')
      await rows.first().hover()
      await sleep(200)
      await menuBtn.click({ timeout: 8000 }).catch(async () => {
        // 兜底：直接派发事件绕过命中测试（Vue 的 @click.stop 监听在按钮本身，能收到）
        await menuBtn.dispatchEvent('click')
      })
      const menu = page.locator('.proj-menu').first()
      const menuOk = await waitUntil(async () => (await menu.count()) === 1, 8000)
      check('B1a 「打开方式」菜单打开', menuOk)

      const item = menu.locator('.proj-menu__item', { hasText: '复制文件夹名称' }).first()
      const itemOk = await waitUntil(async () => (await item.count()) === 1, 5000)
      check('B1b 菜单里有「复制文件夹名称」', itemOk, `project="${firstName}"`)

      // B3 反向锚：原有项不能被挤掉。
      // ⚠️ 「用工具打开」是分组**标题**（.proj-menu__title），不是菜单项 label ——
      //    只查 .proj-menu__label 会漏掉它，误报"少了一项"。
      const labels = (await menu.locator('.proj-menu__label').allTextContents()).map(s => s.trim())
      const titles = (await menu.locator('.proj-menu__title').allTextContents()).map(s => s.trim())
      const keep = ['在文件管理器中打开', '在终端中打开', '在新标签页启动 g ui', '用工具打开', '用 Claude Code 打开']
      const missing = keep.filter(k => !labels.includes(k) && !titles.includes(k))
      check('B3 原有菜单项一个不少', missing.length === 0, missing.length ? `缺: ${missing.join(' / ')}` : `label ${labels.length} 项 + 标题 ${titles.length} 个`)

      // B4 位置锚：新项要落在"打开"这一组里（分隔线之前），
      //    而不是掉进下面"用工具打开"那组 —— 它操作的是目录本身，不是"用哪个工具开"。
      const layout = await page.evaluate(() => {
        const menu = document.querySelector('.proj-menu')
        if (!menu) return null
        const kids = Array.from(menu.children)
        return {
          sep: kids.findIndex(k => k.classList.contains('proj-menu__sep')),
          item: kids.findIndex(k => (k.textContent || '').includes('复制文件夹名称')),
        }
      })
      check('B4 新项归在「打开」组（分隔线之前）',
        !!layout && layout.item >= 0 && layout.sep >= 0 && layout.item < layout.sep,
        JSON.stringify(layout))

      if (itemOk) {
        await item.click()
        await waitUntil(async () => (await toast()).includes('已复制文件夹名称'))
        const got = await lastCopied()
        check('B2a 复制的是项目文件夹名', got === firstName, `copied="${got}" 期望="${firstName}"`)
        check('B2b 复制内容是该路径的 basename、不是完整路径',
          got === folderNameOf(firstPath) && got !== firstPath && !/[\\/]/.test(got),
          `copied="${got}" path="${firstPath}"`)
        const menuClosed = await waitUntil(async () => (await menu.count()) === 0, 5000)
        check('B2c 点完菜单关闭', menuClosed)
      }
    }

    const shot = path.join(os.tmpdir(), `zen-copy-folder-name-${Date.now()}.png`)
    await page.screenshot({ path: shot })
    console.log(`[verify] 截图: ${shot}`)
  } catch (err) {
    check('脚本异常', false, String(err?.message || err))
  } finally {
    await browser.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n用例 ${results.length}，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  failed.forEach(f => console.log(`  - ${f.name} ${f.extra}`))
  const real = consoleErrors.filter(e => !/Failed to fetch|获取当前目录失败|404|net::ERR/.test(e))
  console.log(`控制台错误(过滤噪音): ${real.length}`)
  real.slice(0, 8).forEach(e => console.log('  ! ' + e.slice(0, 220)))
  if (pageErrors.length) {
    console.log(`页面异常: ${pageErrors.length}`)
    pageErrors.slice(0, 4).forEach(e => console.log('  ! ' + e.slice(0, 220)))
  }
  console.log(`合计 ${failed.length === 0 && real.length === 0 && pageErrors.length === 0 ? 'PASS' : 'FAIL'}`)
  process.exit(failed.length ? 1 : 0)
}
main()

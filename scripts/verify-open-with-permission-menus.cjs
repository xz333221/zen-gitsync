/**
 * 「用工具打开」的权限档位菜单 —— 浏览器交互 + 请求契约验证。
 *
 * 背景：各家 CLI 的免批准档不一样，菜单要如实反映：
 *   claude   默认 / 批准文件编辑（acceptEdits）/ 完全批准（bypassPermissions）
 *   opencode 默认 / 完全批准（`--auto`；只有两档，没有中间档）
 *   codex    默认 / 自动批准（`-a never -s workspace-write`，仍有沙箱）/
 *            完全批准（`--dangerously-bypass-approvals-and-sandbox`，免批准 + 免沙箱）
 *
 * 守的契约（对每个"有档位"的工具逐一跑）：
 *   A0 该工具固定在顶栏且已安装（否则后面几条无从谈起）
 *   A1 顶栏该工具图标右键能弹出菜单
 *   A2 菜单里的档位项与期望**逐项对齐**（数量、顺序、提示文案都对）——
 *      多一档少一档都要红：档位数是产品行为，不是实现细节
 *   A3 位置锚：档位项全部排在「更新 {tool}」**之前**，中间有分隔线
 *   A4 点每个档位 → 发往 /api/open-directory-with-{tool} 的 body 里 permissionMode
 *      等于该档的 token；**默认档必须不带这个字段**（不能偷偷进免批准）
 *   A5 点完菜单关闭
 *   A6 **左键直点图标 = 完全批准档**（body.permissionMode === primary）——
 *      2026-09 起 codex / opencode 与 claude 对齐：直接点就给完全批准，菜单是给
 *      "这次想收着点"用的。这条是最容易被人改回去的默认值，所以钉死
 *   A6b 按钮的 tooltip / aria-label 写明「完全批准」—— 免批准要在界面上看得见
 *   B  编排台项目「打开方式」菜单：各档位项都在，点对了就发对的 token
 *      （编排台**不做**直点改造 —— 那里逐档平铺，默认档仍单独成项）
 *   R  反向锚：没有档位的工具（vscode）菜单里**只有「更新」**——
 *      这是最容易写错的地方（一个 v-if 写错就让所有工具都长出档位项）
 *
 * 请求体怎么断言：`page.route` 直接拦掉这些 POST 并 fulfill 一个假成功 ——
 * 既拿到 body，又避免真去 spawn 一个终端 / TUI 窗口（那种副作用不该出现在验证里）。
 *
 * 反向验证（把改动撤掉后哪几条会红）：
 *   · 删掉模板里那段 `v-for="tier in permissionTiersOf(tool.id)"` → A2/A3/A4 红
 *   · 把 TOOL_PERMISSION_TIERS 里的 codex 一项删掉 → 只有 codex 那组红（分组独立）
 *   · 让 v-if 条件恒真 → R 红
 *   · 默认档也传 token → A4 的"默认档不带字段"那条红
 *   · 把 TOOL_PRIMARY_MODE 里的 codex / opencode 删掉（回到默认档直点）→ A6 红
 *
 * 用法：先 `npm run dev`（后端 5545 + vite 5544），再
 *   node scripts/verify-open-with-permission-menus.cjs
 */
const path = require('node:path')
const os = require('node:os')
// playwright 装在 src/ui/client 下，把它的 node_modules 挂进解析路径，脚本才能独立跑
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const API = process.env.ZEN_API || 'http://127.0.0.1:5545'

/** 顶栏要逐一验的工具：aria = 菜单的 aria-label（= 工具名）；tiers 必须与界面逐项对齐。
 *  primary = 左键直点该图标时应带的 permissionMode（完全批准档） */
const TOPBAR_CASES = [
  {
    id: 'opencode',
    aria: 'OpenCode',
    buttonPrefix: '用 OpenCode 打开',
    primary: 'auto',
    // 只有两档：opencode 没有 claude 那种中间档
    tiers: [
      { hint: '默认权限', mode: null },
      { hint: '完全批准（--auto）', mode: 'auto' },
    ],
  },
  {
    id: 'codex',
    aria: 'Codex',
    buttonPrefix: '用 Codex 打开',
    primary: 'bypass',
    tiers: [
      { hint: '默认权限', mode: null },
      { hint: '自动批准（沙箱内）', mode: 'sandboxed' },
      { hint: '完全批准（免沙箱）', mode: 'bypass' },
    ],
  },
]

/** 编排台项目菜单里的档位项（默认档在上面那条 v-for 里，这里只验额外那几档） */
const PROJECT_CASES = [
  { label: '用 OpenCode 打开（完全批准）', mode: 'auto' },
  { label: '用 Codex 打开（自动批准）', mode: 'sandboxed' },
  { label: '用 Codex 打开（完全批准）', mode: 'bypass' },
]

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

async function main() {
  const alive = await fetch(`${API}/api/app-version`).then(r => r.ok).catch(() => false)
  if (!alive) {
    console.error(`后端没起（${API}）—— 先 npm run dev`)
    process.exit(2)
  }
  const dirRes = await fetch(`${API}/api/current_directory`).then(r => r.json()).catch(() => null)
  const currentDir = dirRes?.directory || dirRes?.currentDirectory || ''
  if (!currentDir) {
    console.error('当前目录为空，顶栏那组断言没有意义 —— 先切一个有目录的项目')
    process.exit(2)
  }
  console.log(`[verify] 当前目录 = ${currentDir}`)

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 1600, height: 950 } })

  // 拦掉这些打开端点：记下 body，绝不真的开窗口
  const openBodies = []
  await context.route('**/api/open-directory-with-*', async (route) => {
    let body = null
    try { body = route.request().postDataJSON() } catch { /* 非法 JSON 就当没有 */ }
    openBodies.push(body)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        message: body && body.permissionMode
          ? `已用 X 打开目录（mode=${body.permissionMode}）`
          : '已用 X 打开目录',
      }),
    })
  })

  const page = await context.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  const lastBody = () => openBodies[openBodies.length - 1]

  // contextmenu 挂在按钮外面那层 span 上（IconButton 根是 el-tooltip，事件挂不住），
  // 所以右键要打在**那层 span** 上：`xpath=..` 从按钮回到父节点。⚠️ 不能写
  // `.simple-tool-trigger` + filter({ has: ... }) —— has 是以自身为根的，会永远匹配不到。
  const triggerOf = (ariaPrefix) =>
    page.locator(`.simple-tool-trigger button[aria-label^="${ariaPrefix}"]`).first().locator('xpath=..')

  // ⚠️ 每个可见工具都渲染了一个 `.simple-tool-menu-popover`，且它们的内容**都在 DOM 里**
  //    （el-popover 只把没弹的那个藏起来，不销毁）→ 直接 `querySelector('.simple-tool-menu-popover
  //    .claude-menu')` 会取到 DOM 里第一个，实测拿到的是别的工具的菜单（于是"这个工具有档位项"
  //    会假红成「更新 VSCode」）。必须按 popover 的 aria-label 指名 + 只认真的显示出来的那个。
  const menuItems = (ariaLabel) => page.evaluate((label) => {
    const menu = Array.from(document.querySelectorAll('.simple-tool-menu-popover .claude-menu'))
      .filter(m => (!label || m.getAttribute('aria-label') === label) && m.getBoundingClientRect().width > 0)[0]
    if (!menu) return null
    const kids = Array.from(menu.children)
    return {
      sep: kids.findIndex(k => k.classList.contains('claude-menu__sep')),
      items: kids.map((k, i) => ({
        i,
        kind: k.classList.contains('claude-menu__sep') ? 'sep' : (k.querySelector('.claude-menu__label') ? 'item' : 'other'),
        label: (k.querySelector('.claude-menu__label')?.textContent || '').replace(/\s+/g, ' ').trim(),
        hint: (k.querySelector('.claude-menu__hint')?.textContent || '').replace(/\s+/g, ' ').trim(),
      })),
    }
  }, ariaLabel)

  const openTopbarMenu = async (c) => {
    await triggerOf(c.buttonPrefix).click({ button: 'right' })
    return waitUntil(async () => (await menuItems(c.aria)) !== null, 8000)
  }
  const closeMenus = async () => {
    await page.keyboard.press('Escape')
    await page.mouse.click(5, 500)
    await sleep(250)
  }
  // 打开成功的 toast 是顶部居中的，正好压住这排工具按钮；不等着它消失，
  // 下一个点击会被它吃掉，报出来的是 "element intercepts pointer events"，看着像渲染坏了。
  const dismissToasts = async () => {
    for (let i = 0; i < 8 && (await page.locator('.el-message').count()) > 0; i++) {
      await sleep(500)
    }
  }
  // ⚠️ 点击也要认准"当前可见的那份菜单"，理由同上 —— 而且更隐蔽：`hasText` 命中后
  //    Playwright 报的是 "element is not visible"，看起来像渲染问题，其实是点到了
  //    另一个工具的隐藏菜单（实测 OPEN_WITH_TOOLS 里 codex 排在 opencode 前面，
  //    于是 opencode 那组会点到 codex 的隐藏项，30s 超时）。
  const menuRoot = (aria) =>
    page.locator(`.simple-tool-menu-popover .claude-menu[aria-label="${aria}"]:visible`)
  const clickMenuItem = async (aria, text) =>
    menuRoot(aria).locator('.claude-menu__item', { hasText: text }).first().click()

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.activity-bar', { timeout: 25000 })

    // ── A 顶栏：逐工具 ────────────────────────────────────────────
    for (const c of TOPBAR_CASES) {
      const tag = `[${c.aria}]`
      const btn = page.locator(`.simple-tool-trigger button[aria-label^="${c.buttonPrefix}"]`)
      const pinned = await waitUntil(async () => (await btn.count()) === 1, 15000)
      check(`A0${tag} 固定在顶栏（否则档位菜单无处可挂）`, pinned, `count=${await btn.count()}`)
      if (!pinned) {
        check(`A0${tag} 后续断言`, false, '该工具不在顶栏：请在 设置→顶部工具栏 里勾上它再跑')
        continue
      }
      if (await btn.first().evaluate(el => el.className.includes('tool-button--missing'))) {
        check(`A0${tag} 已安装`, false, '未安装，本次该组无意义')
        continue
      }

      const opened = await openTopbarMenu(c)
      check(`A1${tag} 右键弹出工具菜单`, opened)
      if (!opened) continue

      const menu = await menuItems(c.aria)
      const tierItems = menu.items.slice(0, c.tiers.length)
      const updateItem = menu.items.find(it => it.kind === 'item' && it.label.startsWith('更新'))

      check(`A2${tag} 档位项与期望逐项对齐（数量/顺序/文案）`,
        tierItems.length === c.tiers.length
        && tierItems.every((it, i) => it.kind === 'item' && it.hint.includes(c.tiers[i].hint)),
        `实际=${JSON.stringify(menu.items.map(i => i.hint))} 期望=${JSON.stringify(c.tiers.map(t => t.hint))}`)

      check(`A3${tag} 档位项都在「更新」之前且中间有分隔线`,
        menu.sep === c.tiers.length && !!updateItem && updateItem.i > menu.sep,
        `sep@${menu.sep} 期望@${c.tiers.length} 更新@${updateItem?.i}`)

      // A4 逐档点一遍（点完菜单会关，所以每档都要重新右键）
      for (const tier of c.tiers) {
        if (!(await openTopbarMenu(c))) {
          check(`A4${tag} 打开菜单以点「${tier.hint}」`, false)
          continue
        }
        openBodies.length = 0
        await clickMenuItem(c.aria, tier.hint)
        await waitUntil(async () => openBodies.length > 0, 8000)
        const body = lastBody() || {}
        const ok = tier.mode === null
          ? !('permissionMode' in body)
          : body.permissionMode === tier.mode
        check(`A4${tag} 点「${tier.hint}」→ permissionMode ${tier.mode === null ? '缺失' : tier.mode}`,
          ok, JSON.stringify(body))
        check(`A5${tag} 点完菜单关闭（${tier.hint}）`,
          await waitUntil(async () => (await menuItems(c.aria)) === null, 5000))
        await closeMenus()
      }

      // A6 左键直点 = 完全批准档。放在档位循环**之后**：左键会弹出成功 toast，
      // 而 toast 在顶部居中、正好压住这排工具按钮，先点它会把后面的右键点击吃掉。
      openBodies.length = 0
      await btn.first().click()
      const gotPrimary = await waitUntil(async () => openBodies.length > 0, 8000)
      const pBody = lastBody() || {}
      check(`A6${tag} 左键直点 → permissionMode ${c.primary}（完全批准档）`,
        gotPrimary && pBody.permissionMode === c.primary && typeof pBody.path === 'string' && pBody.path.length > 0,
        JSON.stringify(pBody))
      // 界面上要看得出来：直点就是完全批准，按钮的 aria-label / tooltip 必须写明
      const ariaNow = await btn.first().getAttribute('aria-label')
      check(`A6b${tag} 按钮文案写明「完全批准」（tooltip / aria-label）`,
        /完全批准/.test(ariaNow || ''), String(ariaNow).replace(/\n/g, ' '))
      await dismissToasts()
      await closeMenus()
    }

    // ── R 反向锚：没有档位的工具菜单里只有「更新」 ─────────────────
    const vscodeBtn = page.locator('.simple-tool-trigger button[aria-label^="用 VSCode 打开"]')
    if ((await vscodeBtn.count()) === 1) {
      await triggerOf('用 VSCode 打开').click({ button: 'right' })
      await waitUntil(async () => (await menuItems('VSCode')) !== null, 8000)
      const vscodeMenu = await menuItems('VSCode')
      const labels = (vscodeMenu?.items || []).map(i => i.label)
      check('R 反向锚：无档位的工具菜单里只有「更新」（档位表没漏成对所有工具生效）',
        !!vscodeMenu && labels.length === 1 && labels[0].startsWith('更新'),
        JSON.stringify(vscodeMenu?.items.map(i => i.label + '/' + i.hint)))
      await closeMenus()
    } else {
      check('R 反向锚：无档位的工具菜单里只有「更新」', false, 'vscode 不在顶栏，无法做这条反向锚')
    }

    // ── B 编排台项目菜单 ───────────────────────────────────────────
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
    check('B0b 项目列表就绪', rowOk, `rows=${await rows.count()}`)

    if (rowOk) {
      // ⚠️ 必须先 hover 整行：.proj-item__actions 空闲时 opacity:0 + pointer-events:none，
      //    Playwright 的命中测试发生在移鼠标之前 → 报 badge intercepts pointer events
      const openProjMenu = async () => {
        const menuBtn = rows.first().locator('button[aria-label^="打开方式"]')
        await rows.first().hover()
        await sleep(200)
        await menuBtn.click({ timeout: 8000 }).catch(async () => { await menuBtn.dispatchEvent('click') })
        return waitUntil(async () => (await page.locator('.proj-menu').count()) === 1, 8000)
      }

      const openDeep = await openProjMenu()
      check('B0c 「打开方式」菜单打开', openDeep)

      if (openDeep) {
        const projMenu = page.locator('.proj-menu').first()
        const labels = (await projMenu.locator('.proj-menu__label').allTextContents()).map(s => s.trim())
        const missing = PROJECT_CASES.map(c => c.label).filter(l => !labels.includes(l))
        check('B1 三个档位项都在项目菜单里', missing.length === 0, missing.length ? `缺: ${missing.join(' / ')}` : `共 ${labels.length} 项`)
        // 默认档不能被顶掉（它们还在上面那条 v-for 里）
        check('B2 反向锚：默认档「用 Codex 打开 / 用 OpenCode 打开」还在',
          labels.includes('用 Codex 打开') && labels.includes('用 OpenCode 打开'))
        await closeMenus()
      }

      for (const c of PROJECT_CASES) {
        if (!(await openProjMenu())) {
          check(`B3 打开菜单以点「${c.label}」`, false)
          continue
        }
        openBodies.length = 0
        await page.locator('.proj-menu__item', { hasText: c.label }).first().click()
        await waitUntil(async () => openBodies.length > 0, 8000)
        const body = lastBody() || {}
        check(`B3 点「${c.label}」→ permissionMode ${c.mode}`,
          body.permissionMode === c.mode && typeof body.path === 'string' && body.path.length > 0,
          JSON.stringify(body))
        await closeMenus()
      }
    }

    const shot = path.join(os.tmpdir(), `zen-open-with-permission-${Date.now()}.png`)
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

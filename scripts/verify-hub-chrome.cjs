#!/usr/bin/env node
/**
 * hub（5599）不显示「当前目录 / 仓库」类顶栏底栏元素（2026-11-20）。
 *
 * 起因：用户在 hub 上截图，红框圈了两处 —— 顶栏的目录胶囊 + 「用工具打开这个目录」
 * 那一排图标，以及底栏的「未配置远程仓库」。两处描述的都是 hub 进程自己的 cwd
 * （通常就是用户主目录），而 hub 是跨项目的常驻节点，没有"当前项目"这个概念。
 *
 * 契约：
 *   H0 hub 下页面本体正常渲染（品牌 / 用户区 / 底栏都在）—— 防白屏把 H1/H2 的
 *      `count == 0` 断言骗成绿的
 *   H1 hub 下顶栏没有目录胶囊（.directory-display）与工具行（.header-center 里的 .directory-actions）
 *   H2 hub 下底栏没有分支选择器（.branch-info）与远程仓库卡（.remote-wrapper）
 *   P1 project 下目录胶囊仍在 —— 防"一律隐藏"式的假修
 *   P2 project 下远程仓库卡仍在
 *   P3 顶栏/底栏的三列栅格没被抽内容抽歪：右上状态区仍贴右、底栏「默认模型」仍居中
 *      （占位 div 一旦被一起摘掉，右侧会跑到中间 —— 这是最容易顺手写出的回归）
 *
 * 角色怎么造：`page.route` 劫持 `/api/app-role`。它是 useAppRole（role 的唯一数据源）
 * 读的接口，改它不会碰本机任何真实实例（共享工作区里别去真开一个 hub）。
 *
 * 用法：
 *   node scripts/verify-hub-chrome.cjs
 *   node scripts/verify-hub-chrome.cjs --reverse   # 反证：往 hub 的 header-center 里注入
 *                                                 # 一个假目录胶囊 + 工具行，H1 必须报红
 *
 * 反证为什么不改源码：本仓库是共享工作区，探针改 App.vue 会被别的会话的半成品
 * 混进来；而且改源码还得靠 Vite HMR 才生效。直接往 DOM 里塞一个同 class 的节点，
 * 验的是"H1 数得出来吗"，不依赖任何热更。
 *
 * 依赖：src/ui/client/node_modules/playwright + 5544 上的 dev server。
 * 没有 dev server / 没装 playwright 时**不算失败**，只 NOTE（与仓库其余探针同口径）。
 */

const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const VITE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const PW = path.join(ROOT, 'src/ui/client/node_modules/playwright')
const REVERSE = process.argv.includes('--reverse')

let failed = 0
function ok(name, detail) { console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`) }
function bad(name, detail) { failed++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`) }
function note(s) { console.log(`  NOTE  ${s}`) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 本机 playwright 自带 chromium 可能缺失，依次退到系统 Edge / Chrome */
async function launchBrowser(chromium) {
  const tries = [
    ['chromium', {}],
    ['msedge', { channel: 'msedge' }],
    ['chrome', { channel: 'chrome' }],
  ]
  let lastErr
  for (const [name, extra] of tries) {
    try {
      return await chromium.launch({ args: ['--no-proxy-server'], ...extra })
    } catch (e) { lastErr = e; note(`${name} 起不来，换下一个：${String(e.message).split('\n')[0]}`) }
  }
  throw lastErr
}

/** 数顶栏目录胶囊 / 底栏仓库两类元素，并量三列栅格是否还站得住 */
const COUNT_FN = () => {
  const header = document.querySelector('.app-header')
  const footer = document.querySelector('.app-footer')
  const center = document.querySelector('.header-center')
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), w: Math.round(r.width), right: Math.round(r.right) }
  }
  const info = box(document.querySelector('.header-info'))
  const model = box(document.querySelector('.footer-model-hint'))
  return {
    header: !!header,
    footer: !!footer,
    brand: !!document.querySelector('.header-brand-link, app-header h1, .app-header h1'),
    userInfo: !!document.querySelector('.app-header .user-info-card'),
    capsule: document.querySelectorAll('.directory-display').length,
    toolRow: center ? center.querySelectorAll('.directory-actions').length : 0,
    branch: document.querySelectorAll('.footer-left .branch-info').length,
    remote: document.querySelectorAll('.footer-left .remote-wrapper').length,
    viewport: window.innerWidth,
    infoRightGap: info ? Math.round(window.innerWidth - info.right) : null,
    modelCenterOffset: model ? Math.round(model.x + model.w / 2 - window.innerWidth / 2) : null,
  }
}

/** 用 /api/app-role 的桩造 hub / project 两种形态 */
async function measure({ injectFakeCapsule = false } = {}) {
  const { chromium } = require(PW)
  const browser = await launchBrowser(chromium)
  try {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } })
    const stubRole = (role) =>
      page.route('**/api/app-role*', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, role, version: 'probe' }) }),
      )
    const ready = async () => {
      await page.waitForFunction(
        () => (document.querySelector('#app')?.querySelectorAll('*').length || 0) > 100,
        null, { timeout: 30000 },
      )
      // 顶栏右侧 / 底栏默认模型都是异步落地的（实例列表、监控轮询、配置）
      await sleep(3000)
    }

    await stubRole('hub')
    await page.goto(VITE, { waitUntil: 'domcontentloaded' })
    await ready()
    let hub = await page.evaluate(COUNT_FN)

    // 反证：hub 形态下本来不该有胶囊，往中间那格塞一个「长得一样」的节点，
    // H1 的计数必须跟着变 —— 证明它不是恒 0 的空跑断言
    if (injectFakeCapsule) {
      await page.evaluate(() => {
        const center = document.querySelector('.header-center')
        if (!center) return
        const fake = document.createElement('div')
        fake.className = 'directory-selector directory-selector--header'
        fake.innerHTML = '<button class="directory-display"><span class="directory-display__name">fake</span></button>'
          + '<div class="directory-actions"></div>'
        center.appendChild(fake)
      })
      hub = await page.evaluate(COUNT_FN)
    }

    await page.unroute('**/api/app-role*')
    await stubRole('project')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await ready()
    const project = await page.evaluate(COUNT_FN)

    return { hub, project }
  } finally {
    await browser.close()
  }
}

function report(m) {
  const { hub, project } = m

  // H0 先看：白屏时 H1/H2 的 0 计数是假绿
  const h0 = hub.header && hub.footer && hub.brand && hub.userInfo
  if (h0) ok('H0 hub 下页面本体正常（顶栏品牌 / 用户区 / 底栏都在）')
  else bad('H0 hub 下页面没渲染完整', JSON.stringify(hub))

  const h1 = hub.capsule === 0 && hub.toolRow === 0
  if (h1) ok('H1 hub 顶栏没有目录胶囊与「用工具打开」工具行')
  else bad('H1 hub 顶栏仍出现目录胶囊', `胶囊 ${hub.capsule} 个 / 工具行 ${hub.toolRow} 行`)

  const h2 = hub.branch === 0 && hub.remote === 0
  if (h2) ok('H2 hub 底栏没有分支选择器与远程仓库卡')
  else bad('H2 hub 底栏仍出现仓库元素', `分支 ${hub.branch} 个 / 远程卡 ${hub.remote} 个`)

  // P1/P2 防"一律隐藏"：project 形态必须原样保留
  const p1 = project.capsule === 1
  if (p1) ok('P1 project 形态下目录胶囊仍在')
  else bad('P1 project 形态下目录胶囊不见了（是不是把 v-if 写成恒假了？）', `胶囊 ${project.capsule} 个`)

  const p2 = project.remote === 1
  if (p2) ok('P2 project 形态下远程仓库卡仍在')
  else bad('P2 project 形态下远程仓库卡不见了', `远程卡 ${project.remote} 个`)

  // P3 占位 div 被顺手删掉时右侧会跑到中间 / 底栏不再居中
  const p3a = hub.infoRightGap !== null && hub.infoRightGap < 40
  const p3b = hub.modelCenterOffset !== null && Math.abs(hub.modelCenterOffset) < 60
  if (p3a) ok('P3a hub 右上状态区仍贴住右边', `距视口 ${hub.infoRightGap}px`)
  else bad('P3a hub 右上状态区跑到中间去了（三列栅格的占位 div 是不是被一起摘掉了）', JSON.stringify(hub))
  if (p3b) ok('P3b hub 底栏「默认模型」仍居中', `偏差 ${hub.modelCenterOffset}px`)
  else bad('P3b hub 底栏「默认模型」不居中了', `偏差 ${hub.modelCenterOffset}px`)

  return h0 && h1 && h2 && p1 && p2 && p3a && p3b
}

;(async () => {
  console.log('── hub 不显示「当前目录 / 仓库」类顶栏底栏元素 ──\n')

  let chromium
  try { ({ chromium } = require(PW)) } catch {
    note('未装 playwright（src/ui/client/node_modules/playwright），跳过运行时断言')
    return
  }
  try {
    const r = await fetch(VITE, { signal: AbortSignal.timeout(3000) })
    if (!r.ok) throw new Error('HTTP ' + r.status)
  } catch {
    note(`${VITE} 上没有 dev server，跳过运行时断言（起前端：npm run dev）`)
    return
  }

  if (REVERSE) {
    console.log('  注入一个假的目录胶囊 + 工具行到 hub 的 header-center')
    const { hub } = await measure({ injectFakeCapsule: true })
    const stillGreen = hub.capsule === 0 && hub.toolRow === 0
    console.log(stillGreen
      ? `\n反证失败：塞进同 class 的节点后 H1 仍数不到（${JSON.stringify(hub)}）—— 断言对"有没有胶囊"不敏感`
      : `\n反证成立：塞进去之后 H1 数到胶囊 ${hub.capsule} 个 / 工具行 ${hub.toolRow} 行（正常模式下这两个数是 0）`)
    process.exitCode = stillGreen ? 1 : 0
    return
  }

  const pass = report(await measure())
  console.log(pass ? '\n全部通过' : `\n${failed} 条失败`)
  process.exit(pass ? 0 : 1)
})().catch((e) => {
  bad('探针自身异常', e && e.stack ? e.stack.split('\n')[0] : String(e))
  process.exit(1)
})

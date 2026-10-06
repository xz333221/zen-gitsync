#!/usr/bin/env node
/**
 * 提交历史面板「切回页面时不要滑一下」（2026-10-06）。
 *
 * 起因：用户截图圈出右侧提交历史，「我这个每次切到这个页面都会从下边过渡上去」。
 * 根因有两处，各自都会让 .log-list-panel 竖向位移 150+px：
 *   E1) `commitAreaIdle` 里带了 `!isLoadingStatus` —— 而**一回到这个页面就有静默刷新**：
 *       切 ActivityBar 回到 Git 视图（App.vue 的 watch(activeView)）、切回浏览器标签页 /
 *       窗口聚焦（GitStatus 的 visibilitychange + focus）都走 refreshStatusOnFocus → fetchStatus。
 *       它一置位，提交区就从"收起"翻成"展开"（提交历史被推下去 156px），请求回来再翻回去
 *       （又滑上来）。这就是"每次切到这个页面都会从下边过渡上去"。
 *   E2) 收起方向也带 0.28s 过渡 —— 首屏/切目录那次"展开(还不知道状态) → 收起来"于是变成动画，
 *       同样是历史面板从下面浮上来。修法：过渡只在展开方向做，收起瞬时。
 *
 * 三条契约：
 *   B1 静默刷新（visibilitychange + focus，就是"切回页面"）前后 .log-list-panel 的 top 不动
 *   B2 切到别的 ActivityBar 视图再切回 Git，落位后 top 不动
 *   B3 收起态（.is-idle）对 grid-template-rows 没有过渡、展开态有（= E2 的修法）
 *
 * ⚠️ B1/B2 必须**逐帧采样**（requestAnimationFrame）而不是量两个时间点：
 *    抖一下只有 ~300ms，前后各量一次很容易刚好错过。
 *
 * ⚠️ B2 里面板切走时 display:none，rect 全是 0 —— 只比较 height > 0 的帧，
 *    否则会拿 0 当"没动"得到假绿。
 *
 * 用法：
 *   node scripts/verify-commit-area-no-bounce.cjs
 *   node scripts/verify-commit-area-no-bounce.cjs --reverse   # 反证：把 !isLoadingStatus 钉回去应变红
 *
 * 依赖：src/ui/client/node_modules/playwright + 5544 上的 dev server。
 * 没有就 NOTE 跳过，不算失败。
 */

const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'src/ui/client/src')
const VITE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const PW = path.join(ROOT, 'src/ui/client/node_modules/playwright')
const TARGET = path.join(SRC, 'stores/gitStore.ts')
const REVERSE = process.argv.includes('--reverse')
const TOL = 1.5 // px：允许的落位误差
const STATUS_DELAY_MS = 350 // 状态接口的假延迟，见 measure() 里的夹具说明

let failed = 0
function ok(n, d) { console.log(`  PASS  ${n}${d ? '  ' + d : ''}`) }
function bad(n, d) { failed++; console.log(`  FAIL  ${n}${d ? '  ' + d : ''}`) }
function note(s) { console.log(`  NOTE  ${s}`) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ── 反证用的补丁：把"在途请求标志"钉回判据（还原成 2026-10-06 之前）──
const REV_FROM = `    && statusLoadedOnce.value
    && userName.value !== ''`
const REV_TO = `    && statusLoadedOnce.value
    && !isLoadingStatus.value
    && userName.value !== ''`

async function launchBrowser(chromium) {
  const attempts = [['chromium', {}], ['msedge', { channel: 'msedge' }], ['chrome', { channel: 'chrome' }]]
  const errors = []
  for (const [name, opts] of attempts) {
    try {
      const b = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...opts })
      note(`浏览器：${name}`)
      return b
    } catch (e) { errors.push(`${name}: ${String(e.message || e).split('\n')[0]}`) }
  }
  throw new Error('没有可用的浏览器:\n  ' + errors.join('\n  '))
}

/** 页面里装一个逐帧采样器：每帧记 .log-list-panel / .commit-form-panel 的 top 与行高 */
const SAMPLER = `
window.__startSample = function (ms) {
  const rec = []; const t0 = performance.now();
  function tick() {
    const now = performance.now() - t0;
    const lp = document.querySelector('.log-list-panel');
    const cf = document.querySelector('.commit-form-panel');
    const lpcs = lp && getComputedStyle(lp);
    const cfcs = cf && getComputedStyle(cf);
    rec.push({
      t: Math.round(now),
      lpTop: lp ? Math.round(lp.getBoundingClientRect().top * 10) / 10 : null,
      lpH: lp ? Math.round(lp.getBoundingClientRect().height * 10) / 10 : null,
      rows: cfcs ? cfcs.gridTemplateRows : null,
      idle: cf ? cf.className.toString().includes('is-idle') : null,
      lpVisible: lpcs ? lpcs.display !== 'none' : false,
    });
    if (now < ms) requestAnimationFrame(tick); else window.__frames = rec;
  }
  requestAnimationFrame(tick);
};
`

async function measure() {
  const { chromium } = require(PW)
  const browser = await launchBrowser(chromium)
  try {
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
    const errs = []
    page.on('pageerror', e => errs.push(String(e)))

    // 夹具：把"工作区干净 + 已配置用户 + 不领先"钉住，**不改真实工作目录**
    // （本仓库是共享工作区，探针自己写文件就会让工作区变脏，跑出来的就不是用户那个场景）。
    // 三个接口就是 commitAreaIdle 的全部数据来源，见 stores/gitStore.ts。
    //
    // ⚠️ status_porcelain 必须**故意慢**：抖动的成因是"请求在途期间收起态被翻成展开"，
    //    秒回的 mock 会在同一帧里 true→false，一帧都画不出来 —— 反证会假绿（踩过一次）。
    //    350ms 是真实 git status 的常见量级。
    const slow = (ms) => new Promise(r => setTimeout(r, ms))
    await page.route('**/api/status_porcelain*', async r => {
      await slow(STATUS_DELAY_MS)
      await r.fulfill({ json: { status: '', isMergeInProgress: false } })
    })
    await page.route('**/api/branch-status*', async r => {
      await slow(STATUS_DELAY_MS)
      await r.fulfill({ json: { ahead: 0, behind: 0, hasUpstream: true, upstreamBranch: 'origin/main' } })
    })
    await page.route('**/api/user-info*', r => r.fulfill({ json: { name: 'probe', email: 'probe@example.com' } }))

    await page.goto(VITE, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (document.querySelector('#app')?.querySelectorAll('*').length || 0) > 100,
      null, { timeout: 30000 })
    await page.addScriptTag({ content: SAMPLER })
    // 等首屏落定（提交区收起、提交历史站好位）
    await sleep(9000)

    const settled = await page.evaluate(() => {
      const lp = document.querySelector('.log-list-panel')
      const cf = document.querySelector('.commit-form-panel')
      return {
        lpTop: Math.round(lp.getBoundingClientRect().top * 10) / 10,
        idle: cf.className.toString().includes('is-idle'),
        cfRows: getComputedStyle(cf).gridTemplateRows,
        // B3：收起态对 grid-template-rows 有没有过渡
        cfTransition: getComputedStyle(cf).transitionProperty + ' / ' + getComputedStyle(cf).transitionDuration,
      }
    })

    // ── B1：切回页面（visibilitychange + window focus，与真实 alt-tab 同一对事件）──
    await page.evaluate(() => window.__startSample(2500))
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await sleep(250)
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
    })
    await sleep(4000)
    const b1 = await page.evaluate(() => window.__frames)

    // ── B2：切到别的 ActivityBar 视图再切回 Git ──
    const clickView = (kw) => page.evaluate((k) => {
      const b = [...document.querySelectorAll('.activity-btn')].find(e => (e.getAttribute('aria-label') || '').includes(k))
      if (b) { b.click(); return true } return false
    }, kw)
    await clickView('控制台')
    await sleep(2500)
    await page.evaluate(() => window.__startSample(2500))
    await clickView('Git')
    await sleep(4000)
    const b2 = await page.evaluate(() => window.__frames)

    // 展开方向还留着过渡吗？干净夹具下面板一直处于 .is-idle，直接量只会量到"收起态"，
    // 所以把 is-idle 摘掉量完再戴回去（过渡属性取自变化后的样式，摘掉=展开方向那条规则生效）
    const expandedTransition = await page.evaluate(() => {
      const cf = document.querySelector('.commit-form-panel')
      const had = cf.classList.contains('is-idle')
      cf.classList.remove('is-idle')
      const cs = getComputedStyle(cf)
      const out = cs.transitionProperty + ' / ' + cs.transitionDuration
      if (had) cf.classList.add('is-idle')
      return out
    })

    return { settled, b1, b2, expandedTransition, errs }
  } finally {
    await browser.close()
  }
}

/** 一帧一帧比对：只看"面板真的可见"的帧（display:none 时 rect 全是 0） */
function drift(frames, settledTop, label) {
  const vis = frames.filter(f => f.lpVisible && f.lpH > 0 && f.lpTop !== null)
  if (!vis.length) return { err: `${label}：采样里没有一帧是可见的（面板一直被隐藏？）` }
  const tops = vis.map(f => f.lpTop)
  const max = Math.max(...tops), min = Math.min(...tops)
  return { min, max, dev: Math.max(Math.abs(max - settledTop), Math.abs(min - settledTop)), frames: vis.length }
}

function report(m) {
  if (m.error) { bad('打开页面', m.error); return false }
  if (m.errs.length) { bad('页面无 JS 异常', m.errs.join(' | ')); return false }
  ok('页面无 JS 异常')

  let pass = true
  console.log(`  ${m.settled.idle ? '·' : '!'}  落位状态：is-idle=${m.settled.idle} rows=${m.settled.cfRows} 提交历史 top=${m.settled.lpTop}`)
  if (!m.settled.idle) {
    note('工作区不干净（提交区没收起）—— 这条探针要在"干净工作区"下才有意义，跳过 B1/B2')
    return true
  }

  for (const [key, label] of [['b1', 'B1 切回页面（visibilitychange + focus）'], ['b2', 'B2 切走视图再切回 Git']]) {
    const d = drift(m[key], m.settled.lpTop, label)
    if (d.err) { bad(label, d.err); pass = false; continue }
    if (d.dev <= TOL) ok(`${label}：提交历史纹丝不动`, `top 全在 ${d.min}..${d.max}（落位 ${m.settled.lpTop}，${d.frames} 帧可见）`)
    else { bad(`${label}：提交历史动了`, `top 漂到 ${d.min}..${d.max}，偏离落位 ${m.settled.lpTop} 达 ${d.dev.toFixed(1)}px —— 静默刷新不该翻收起态`); pass = false }
  }

  // B3：收起态无过渡、展开态有（E2 的修法）
  const idleDur = /0s/.test(m.settled.cfTransition.split(' / ')[1] || '') || !/grid-template-rows/.test(m.settled.cfTransition)
  if (idleDur) ok('B3a 收起态对 grid-template-rows 没有过渡（首屏落定不滑）', `transition=${m.settled.cfTransition}`)
  else { bad('B3a 收起态还带过渡', `transition=${m.settled.cfTransition} —— 首屏"展开→收起"会变成从下边浮上来`); pass = false }
  if (/grid-template-rows/.test(m.expandedTransition) && !/0s/.test((m.expandedTransition.split(' / ')[1] || ''))) {
    ok('B3b 展开方向仍保留过渡（出现变更时提交框滑出来）', `transition=${m.expandedTransition}`)
  } else {
    bad('B3b 展开方向没有过渡', `transition=${m.expandedTransition}`)
    pass = false
  }
  return pass
}

;(async () => {
  console.log('── 提交历史面板：切回页面时不滑 ──\n')

  if (REVERSE) {
    const original = fs.readFileSync(TARGET, 'utf8')
    if (!original.includes(REV_FROM)) {
      note('源里没找到待撤的锚点（判据结构变了？），反证未执行')
      process.exit(1)
    }
    let good = false
    try {
      fs.writeFileSync(TARGET, original.replace(REV_FROM, REV_TO))
      console.log('  关掉  把「!isLoadingStatus 在判据里」钉回去（还原成修复前）')
      await sleep(4000) // 等 HMR 把新模块推上去
      const m = await measure()
      if (m.errs.length) { note('反证中断：页面报错 ' + m.errs.join(' | ')); process.exitCode = 1 }
      else {
        const d = drift(m.b1, m.settled.lpTop, 'b1')
        const moved = !d.err && d.dev > TOL
        console.log(moved
          ? `\n反证成立：钉回在途标志后 B1 变红（top 漂到 ${d.min}..${d.max}，偏离 ${d.dev.toFixed(1)}px）`
          : `\n反证失败：钉回在途标志后 B1 仍是绿的（dev=${d.err ? 'n/a' : d.dev.toFixed(1)}px）—— 断言不敏感`)
        good = moved
      }
    } finally {
      fs.writeFileSync(TARGET, original)
      console.log('已还原')
      if (!good) process.exitCode = 1
    }
    return
  }

  let chromium
  try { ({ chromium } = require(PW)) } catch {
    note('未装 playwright，跳过运行时断言')
    return
  }
  try {
    const r = await fetch(VITE, { signal: AbortSignal.timeout(3000) })
    if (!r.ok) throw new Error('HTTP ' + r.status)
  } catch {
    note(`${VITE} 上没有 dev server，跳过（起前端：cd src/ui/client && npm run dev）`)
    return
  }

  const pass = report(await measure())
  console.log(pass ? '\n全部通过' : `\n${failed} 条失败`)
  process.exit(pass ? 0 : 1)
})()

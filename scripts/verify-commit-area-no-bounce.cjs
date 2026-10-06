#!/usr/bin/env node
/**
 * 提交历史面板「到页面时不要动」（2026-10-06，用户提了三轮）。
 *
 * 用户在右侧提交历史画红框：「我这个每次切到这个页面都会从下边过渡上去」。
 * 逐帧采样（rAF）看到的是 .log-list-panel 的 top 从 103 漂到 259.6 再滑回来（156.6px）。
 * 三处根因，各修各的：
 *   E1) 收起判据里带了 `!isLoadingStatus` —— 而**一回到这个页面就有静默刷新**：
 *       切 ActivityBar 回到 Git 视图（App.vue 的 watch(activeView)）、切回浏览器标签页 /
 *       窗口聚焦（GitStatus 的 visibilitychange + focus）都走 refreshStatusOnFocus → fetchStatus，
 *       它一置位收起态就翻成"展开"（历史被推下去），请求回来再翻回收起（又滑上来）。
 *   E2) 收起/展开方向都带 0.28s 过渡 —— 面板高度一变就把提交历史推着走，任何过渡都会被
 *       读成"提交历史在滑"。用户先要「别从下边过渡上去」，再要「连"滑出来"都不想要」，
 *       最终两个方向都不做过渡，瞬时切换。
 *   E3) 更根上的一条：判据原本是**正向**写的（"没变更就收起"），于是首屏挂载时
 *       "工作区状态 / 用户配置还不知道"被当成"有东西可展示" → 面板先按展开态画出来，
 *       数据一到再收回去（用户第三轮：「这个还是没改好，是不是应该把上边高度默认设成 0 呢」）。
 *       修法：判据反着写 —— 默认收起，只列"确知要展示"的情形。
 *
 * 四条契约：
 *   B0 冷启动（干净工作区）：从**第一帧**起，提交区高度一直是 0、提交历史 top 一动不动
 *   B1 静默刷新（visibilitychange + focus，就是"切回页面"）前后 top 不动
 *   B2 切到别的 ActivityBar 视图再切回 Git，落位后 top 不动
 *   B3 两个方向对 grid-template-rows 都没有过渡（= E2 的修法）
 *   B4 工作区有变更时面板照常展开，且**一步到位**（逐帧看不到中间高度）
 *
 * ⚠️ 采样器必须用 addInitScript 装（app 代码之前），否则采不到首帧 —— B0 就是量首帧的。
 *
 * ⚠️ B1/B2 必须**逐帧**采样而不是量两个时间点：抖一下只有 ~300ms，前后各量一次容易错过。
 *
 * ⚠️ 夹具接口**故意慢 350ms**：抖动是"请求在途期间收起态被翻"造成的，秒回的 mock 会在
 *    同一帧里 true→false，一帧都画不出来 —— 反证会假绿（踩过一次）。
 *
 * ⚠️ B2 里面板切走时 display:none，rect 全是 0 —— 只比较 height > 0 的帧，
 *    否则会拿 0 当"没动"得到假绿。
 *
 * 用法：
 *   node scripts/verify-commit-area-no-bounce.cjs
 *   node scripts/verify-commit-area-no-bounce.cjs --reverse   # 反证：撤掉三处修法，B0/B1/B3/B4 各自变红
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
const REVERSE = process.argv.includes('--reverse')
const TOL = 1.5 // px：允许的落位误差
const API_DELAY_MS = 350 // 状态/分支夹具的假延迟，见头注释
// 用户信息**故意拖得更长**：面板的挂载点在 `isGitRepo = true` 那一刻，早于 getUserInfo 的响应，
// 所以"配置还没到"这个窗口必须是确定的 —— 不然反证里 B0 会时红时绿（竞态）。
const USER_INFO_DELAY_MS = 1500

let failed = 0
function ok(n, d) { console.log(`  PASS  ${n}${d ? '  ' + d : ''}`) }
function bad(n, d) { failed++; console.log(`  FAIL  ${n}${d ? '  ' + d : ''}`) }
function note(s) { console.log(`  NOTE  ${s}`) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ── 反证用的"撤法"（还原成修复前的形状），每条对应一条断言 ──
//   · 判据侧：`userInfoLoadedOnce` 门槛 + 模板占位 = 旧的"状态/配置没到就照常渲染"
//     （B0 抓它 —— 面板挂载发生在 isGitRepo=true 那一刻，早于 getUserInfo 的响应）；
//     `!isLoadingStatus` 进判据 = 旧的"在途请求标志进判据"（B1 抓它）。
//   · 过渡侧：给 grid-template-rows 加回 0.28s = 旧的"高度变化带动画"（B3 / B4 抓它）。
// ⚠️ 反证要**分两趟**跑（见文件末尾）：判据侧和过渡侧一起撤会互相抵消 —— 判据塌了之后
//    面板一路展开，展开方向的过渡根本不会发生，B4 就抓不到了。
const REV_STORE = {
  file: 'stores/gitStore.ts',
  what: '把"未知一律当收起"退回成"未知按展开"，并把 !isLoadingStatus 钉回判据',
  from: `const commitAreaIdle = computed(() => !commitAreaNeeded.value)`,
  to: `const commitAreaIdle = computed(() => !commitAreaNeeded.value && userInfoLoadedOnce.value && !isLoadingStatus.value)`,
}
const REV_PLACEHOLDER = {
  file: 'App.vue',
  what: '删掉"配置未知先不渲染"的占位：未配置引导卡会在配置回来前就画出来（自带 64px 内边距）',
  from: `        <div v-if="!gitStore.userInfoLoadedOnce" class="commit-form-placeholder"></div>\n        <!-- 当用户未配置时显示配置提示 -->\n        <div v-else-if="!gitStore.userName || !gitStore.userEmail"`,
  to: `        <!-- 当用户未配置时显示配置提示 -->\n        <div v-if="!gitStore.userName || !gitStore.userEmail"`,
}
const REV_TRANSITION = {
  file: 'App.vue',
  what: '给提交区的 grid-template-rows 加回 0.28s 过渡（两个方向都会滑）',
  from: `  grid-template-rows: 1fr;\n\n  > * {`,
  to: `  grid-template-rows: 1fr;\n  transition: grid-template-rows 0.28s var(--ease-in-out, ease-in-out);\n\n  > * {`,
}

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

/** 从第一帧起逐帧记账（addInitScript 装，所以 app 还没跑就已经在采） */
const SAMPLER = `
window.__frames = [];
window.__resetFrames = function () { window.__frames = []; };
(function tick() {
  const lp = document.querySelector('.log-list-panel');
  const cf = document.querySelector('.commit-form-panel');
  const lpcs = lp && getComputedStyle(lp);
  window.__frames.push({
    t: Math.round(performance.now()),
    lpTop: lp ? Math.round(lp.getBoundingClientRect().top * 10) / 10 : null,
    lpH: lp ? Math.round(lp.getBoundingClientRect().height * 10) / 10 : null,
    cfH: cf ? Math.round(cf.getBoundingClientRect().height * 10) / 10 : null,
    rows: cf ? getComputedStyle(cf).gridTemplateRows : null,
    idle: cf ? cf.className.toString().includes('is-idle') : null,
    lpVisible: lpcs ? lpcs.display !== 'none' : false,
  });
  requestAnimationFrame(tick);
})();
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
    // 三个接口就是提交区判据的全部数据来源，见 stores/gitStore.ts 的 commitAreaNeeded。
    const slow = (ms) => new Promise(r => setTimeout(r, ms))
    await page.route('**/api/status_porcelain*', async r => {
      await slow(API_DELAY_MS)
      await r.fulfill({ json: { status: '', isMergeInProgress: false } })
    })
    await page.route('**/api/branch-status*', async r => {
      await slow(API_DELAY_MS)
      await r.fulfill({ json: { ahead: 0, behind: 0, hasUpstream: true, upstreamBranch: 'origin/main' } })
    })
    await page.route('**/api/user-info*', async r => {
      await slow(USER_INFO_DELAY_MS)
      await r.fulfill({ json: { name: 'probe', email: 'probe@example.com' } })
    })

    await page.addInitScript(SAMPLER)
    await page.goto(VITE, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (document.querySelector('#app')?.querySelectorAll('*').length || 0) > 100,
      null, { timeout: 30000 })
    await sleep(9000) // 首屏落定（含故意延迟的夹具）

    const cold = await page.evaluate(() => window.__frames)
    const settled = await page.evaluate(() => {
      const lp = document.querySelector('.log-list-panel')
      const cf = document.querySelector('.commit-form-panel')
      return {
        lpTop: Math.round(lp.getBoundingClientRect().top * 10) / 10,
        idle: cf.className.toString().includes('is-idle'),
        cfRows: getComputedStyle(cf).gridTemplateRows,
        cfTransition: getComputedStyle(cf).transitionProperty + ' / ' + getComputedStyle(cf).transitionDuration,
      }
    })

    // ── B1：切回页面（visibilitychange + window focus，与真实 alt-tab 同一对事件）──
    await page.evaluate(() => window.__resetFrames())
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
    await page.evaluate(() => window.__resetFrames())
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

    return { settled, cold, b1, b2, expandedTransition, errs }
  } finally {
    await browser.close()
  }
}

/** 只看"面板真的可见"的帧（display:none 时 rect 全是 0，拿 0 当"没动"会假绿） */
const visible = (frames) => frames.filter(f => f.lpVisible && f.lpH > 0 && f.lpTop !== null)

function drift(frames, settledTop, label) {
  const vis = visible(frames)
  if (!vis.length) return { err: `${label}：采样里没有一帧是可见的（面板一直被隐藏？）` }
  const tops = vis.map(f => f.lpTop)
  const max = Math.max(...tops), min = Math.min(...tops)
  return {
    min, max, frames: vis.length,
    dev: Math.max(Math.abs(max - settledTop), Math.abs(min - settledTop)),
    maxCfH: Math.max(...vis.map(f => f.cfH === null ? 0 : f.cfH)),
  }
}

function report(m) {
  if (m.error) { bad('打开页面', m.error); return false }
  if (m.errs.length) { bad('页面无 JS 异常', m.errs.join(' | ')); return false }
  ok('页面无 JS 异常')

  let pass = true
  console.log(`  ${m.settled.idle ? '·' : '!'}  落位状态：is-idle=${m.settled.idle} rows=${m.settled.cfRows} 提交历史 top=${m.settled.lpTop}`)
  if (!m.settled.idle) {
    note('工作区不干净（提交区没收起）—— 这条探针要在"干净工作区"下才有意义，跳过 B0/B1/B2')
    return true
  }

  // B0：冷启动从第一帧起就该是 0 高度、纹丝不动（用户第三轮的诉求）
  const d0 = drift(m.cold, m.settled.lpTop, 'B0')
  if (d0.err) { bad('B0 冷启动', d0.err); pass = false }
  else if (d0.dev <= TOL && d0.maxCfH <= 1) {
    ok('B0 冷启动（干净工作区）：从第一帧起提交区高度就是 0、提交历史不动',
      `top 全在 ${d0.min}..${d0.max}，提交区最高 ${d0.maxCfH}px（${d0.frames} 帧）`)
  } else {
    bad('B0 冷启动：面板先展开再收起 / 提交历史动了',
      `top 漂到 ${d0.min}..${d0.max}（落位 ${m.settled.lpTop}），提交区最高到过 ${d0.maxCfH}px —— 未知状态该按收起起步`)
    pass = false
  }

  for (const [key, label] of [['b1', 'B1 切回页面（visibilitychange + focus）'], ['b2', 'B2 切走视图再切回 Git']]) {
    const d = drift(m[key], m.settled.lpTop, label)
    if (d.err) { bad(label, d.err); pass = false; continue }
    if (d.dev <= TOL) ok(`${label}：提交历史纹丝不动`, `top 全在 ${d.min}..${d.max}（落位 ${m.settled.lpTop}，${d.frames} 帧可见）`)
    else { bad(`${label}：提交历史动了`, `top 漂到 ${d.min}..${d.max}，偏离落位 ${m.settled.lpTop} 达 ${d.dev.toFixed(1)}px —— 静默刷新不该翻收起态`); pass = false }
  }

  // B3：两个方向都不该有过渡（E2 的修法）
  pass = reportTransition(m.settled.cfTransition, m.expandedTransition) && pass
  return pass
}

/** B3 用：两个方向都不该有过渡 —— 面板高度只能一步到位 */
function reportTransition(settledTransition, expandedTransition) {
  let pass = true
  for (const [label, t] of [['收起态', settledTransition], ['展开态', expandedTransition]]) {
    if (/grid-template-rows/.test(t) && !/0s/.test((t.split(' / ')[1] || ''))) {
      bad(`B3 ${label}给 grid-template-rows 加了过渡`, `transition=${t} —— 面板高度一变就把提交历史推着走`)
      pass = false
    } else ok(`B3 ${label}对 grid-template-rows 没有过渡`, `transition=${t}`)
  }
  return pass
}

/** B4 用：夹具换成"有变更"，确认面板**该展开时确实展开**，且是**一步到位**（不滑） */
async function measureDirty() {
  const { chromium } = require(PW)
  const browser = await launchBrowser(chromium)
  try {
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
    const slow = (ms) => new Promise(r => setTimeout(r, ms))
    await page.route('**/api/status_porcelain*', async r => {
      await slow(API_DELAY_MS)
      // 一个未暂存的修改（porcelain: XY + 空格 + path）
      await r.fulfill({ json: { status: ' M src/ui/client/src/App.vue', isMergeInProgress: false } })
    })
    await page.route('**/api/branch-status*', async r => {
      await slow(API_DELAY_MS)
      await r.fulfill({ json: { ahead: 0, behind: 0, hasUpstream: true, upstreamBranch: 'origin/main' } })
    })
    await page.route('**/api/user-info*', async r => {
      await slow(USER_INFO_DELAY_MS)
      await r.fulfill({ json: { name: 'probe', email: 'probe@example.com' } })
    })
    await page.addInitScript(SAMPLER) // 逐帧盯着高度：有过渡就会出现中间值
    await page.goto(VITE, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (document.querySelector('#app')?.querySelectorAll('*').length || 0) > 100,
      null, { timeout: 30000 })
    await sleep(9000)
    const frames = await page.evaluate(() => window.__frames)
    const settled = await page.evaluate(() => {
      const lp = document.querySelector('.log-list-panel')
      const cf = document.querySelector('.commit-form-panel')
      const lpcs = lp && getComputedStyle(lp)
      return {
        idle: cf.className.toString().includes('is-idle'),
        cfH: Math.round(cf.getBoundingClientRect().height),
        lpTop: lp ? Math.round(lp.getBoundingClientRect().top) : null,
        lpVisible: lpcs ? lpcs.display !== 'none' : false,
      }
    })
    return { settled, frames }
  } finally {
    await browser.close()
  }
}

function reportDirty({ settled: d, frames }) {
  if (!d.lpVisible) { bad('B4 工作区有变更', '提交历史面板没渲染出来，这次测量无效'); return false }
  if (d.cfH < 50) {
    bad('B4 有变更时提交区没展开出来',
      `is-idle=${d.idle} 高度=${d.cfH}px —— "默认收起"变成了"永远收起"，用户就没法提交了`)
    return false
  }
  ok('B4 工作区有变更时提交区照常展开', `高度=${d.cfH}px 提交历史 top=${d.lpTop}（让位给它）`)

  // 高度只能一步到位：出现"中间高度"就说明还在做过渡（B0 抓不到展开方向，这里补上）
  const hs = [...new Set(frames.filter(f => f.cfH !== null).map(f => f.cfH))].sort((a, b) => a - b)
  const mid = hs.filter(h => h > 2 && h < d.cfH - 2)
  if (mid.length) {
    bad('B4 展开过程有中间高度（还在滑）', `观测到的中间高度：${mid.slice(0, 8).join(', ')}${mid.length > 8 ? ' …' : ''} —— 用户要的是瞬时切换`)
    return false
  }
  ok('B4 展开是一步到位（没有中间高度 = 没有过渡）', `观测到的高度只有 ${hs.join(' / ')}`)
  return true
}

/** 从一次测量里算出四条断言各自"是不是红了"（反证用，正向那侧直接走 report） */
function redness(m, dirty) {
  const d0 = drift(m.cold, m.settled.lpTop, 'B0')
  const d1 = drift(m.b1, m.settled.lpTop, 'B1')
  const dur = (m.settled.cfTransition.split(' / ')[1] || '')
  const hs = [...new Set(dirty.frames.filter(f => f.cfH !== null).map(f => f.cfH))].sort((a, b) => a - b)
  const mid = hs.filter(h => h > 2 && h < dirty.settled.cfH - 2)
  return {
    B0: {
      red: !d0.err && d0.dev > TOL,
      detail: `首屏提交区涨到 ${d0.maxCfH}px，提交历史漂 ${d0.err ? 'n/a' : d0.dev.toFixed(1) + 'px'}`,
    },
    B1: {
      red: !d1.err && d1.dev > TOL,
      detail: `切回页面提交历史漂 ${d1.err ? 'n/a' : d1.dev.toFixed(1) + 'px'}`,
    },
    B3: {
      red: /grid-template-rows/.test(m.settled.cfTransition) && !/0s/.test(dur),
      detail: `transition=${m.settled.cfTransition}`,
    },
    B4: {
      red: mid.length > 0,
      detail: `展开过程出现中间高度 ${mid.slice(0, 6).join(', ')}${mid.length > 6 ? ' …' : ''}（观测到 ${hs.join(' / ')}）`,
    },
  }
}

;(async () => {
  console.log('── 提交历史面板：到页面时不动 ──\n')

  if (REVERSE) {
    // 反证分**两趟**，一趟只撤一侧的修法 —— 一起撤会互相抵消：
    // 判据塌了（面板一路展开）之后，展开方向的过渡根本不会发生，B4 就抓不到了。
    const PASSES = [
      { name: '第 1 趟：撤判据侧', expect: ['B0', 'B1'], patches: [REV_STORE, REV_PLACEHOLDER] },
      { name: '第 2 趟：撤过渡侧', expect: ['B3', 'B4'], patches: [REV_TRANSITION] },
    ]
    let good = true
    for (const pass of PASSES) {
      const files = [...new Set(pass.patches.map(p => p.file))]
      const originals = {}
      for (const f of files) originals[f] = fs.readFileSync(path.join(SRC, f), 'utf8')
      const missing = pass.patches.filter(p => !originals[p.file].includes(p.from))
      if (missing.length) {
        note(`${pass.name}：源里没找到待撤的锚点（结构变了？）：${missing.map(p => p.what).join(' / ')}`)
        process.exitCode = 1
        continue
      }
      console.log(`\n${pass.name}`)
      try {
        const patched = { ...originals }
        for (const p of pass.patches) {
          patched[p.file] = patched[p.file].replace(p.from, p.to)
          console.log(`  关掉  [${p.file}] ${p.what}`)
        }
        for (const f of files) fs.writeFileSync(path.join(SRC, f), patched[f])
        await sleep(4000) // 等 HMR 把新模块推上去（store 改动通常整页 reload）

        const m = await measure()
        const dirty = await measureDirty()
        if (m.errs.length) note('页面报错（不一定是反证造成的）：' + m.errs.join(' | '))
        const r = redness(m, dirty)
        for (const name of pass.expect) {
          console.log(`  ${r[name].red ? '红' : '绿'}  ${name}：${r[name].detail}`)
          if (!r[name].red) good = false
        }
      } finally {
        for (const f of files) fs.writeFileSync(path.join(SRC, f), originals[f])
        console.log('已还原 ' + files.join(' / '))
      }
    }
    console.log(good
      ? '\n反证成立：撤掉哪一侧，对应断言就变红'
      : '\n反证失败：至少一处撤掉后对应断言没变红（先怀疑撤错地方，别急着说断言不敏感）')
    if (!good) process.exitCode = 1
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

  let pass = report(await measure())
  pass = reportDirty(await measureDirty()) && pass
  console.log(pass ? '\n全部通过' : `\n${failed} 条失败`)
  process.exit(pass ? 0 : 1)
})()

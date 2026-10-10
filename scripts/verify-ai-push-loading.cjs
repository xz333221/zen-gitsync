#!/usr/bin/env node
/**
 * 「AI 提交并推送」的等待反馈必须**落在按钮上**，不许再盖全屏遮罩（2026-10-10）。
 *
 * 起因：用户截图反馈 —— 点「AI 提交并推送」后整个界面被一层全屏 GlobalLoading
 * 糊住，中间一张卡片写着「AI 正在生成提交信息…」。原话：
 *   "这个不要搞成全屏的，就在按钮上 loading 就行"。
 * 改前 CommitForm.handleAiQuickPush 里是：
 *   showLoading({ text: 'AI 正在生成提交信息…' });  … await 请求 …;  hideLoading();
 * 现在这句没了，反馈全部由 AiQuickPushButton 的 :generating（= aiQuickPushing）
 * 承担：按钮转圈 + 主标题改成「AI 正在生成提交信息…」。
 *
 * 为什么值得固化：这是纯视觉契约，tsc / build 全绿，单测里 useGlobalLoading 是
 * mock 的 —— 只有真的进浏览器点一下，才能证明"屏幕上没有那层遮罩"。
 * 而后半段（暂存 → 提交 → 推送）**该**保留全屏遮罩，所以判据只覆盖 AI 这一段。
 *
 * 两条断言（生成阶段的窗口内取样）：
 *   A1 没有任何 `.global-loading-overlay`（全屏遮罩撤干净了）
 *   A2 按钮自己是 loading 态，且主标题已经换成「AI 生成提交信息…」的说明
 *      （撤了全屏之后，按钮再不说话就只剩一颗不知在干嘛的转圈）
 *
 * 安全性：`/api/config/generate-commit-message` 被 route 挂住**永不返回**，
 * 所以后续的暂存/提交/推送整条链路根本不会启动 —— 探针不会真的改到工作区，
 * 也不会花掉一次 AI 调用。
 *
 * 用法：
 *   node scripts/verify-ai-push-loading.cjs
 *   node scripts/verify-ai-push-loading.cjs --reverse   # 反证：把全屏遮罩加回来应变红
 *
 * 依赖：src/ui/client/node_modules/playwright + 5544 上的 dev server。
 * 没有就 NOTE 跳过，不算失败。
 */

const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const VITE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const PW = path.join(ROOT, 'src/ui/client/node_modules/playwright')
const REVERSE = process.argv.includes('--reverse')
const TARGET = path.join(ROOT, 'src/ui/client/src/views/components/CommitForm.vue')

// ── 反证：把 2026-10-10 撤掉的全屏遮罩加回 handleAiQuickPush。
// 只动源码这一段，别的都不碰。──
const REV_FROM = `      const ok = await requestAiCommitMessage();
      if (!ok) return;`
const REV_TO = `      showLoading({ text: $t("@2E184:AI 正在生成提交信息…"), showProgress: false });
      let ok = false;
      try {
        ok = await requestAiCommitMessage();
      } finally {
        hideLoading();
      }
      if (!ok) return;`

let failed = 0
function ok(n, d) { console.log(`  PASS  ${n}${d ? '  ' + d : ''}`) }
function bad(n, d) { failed++; console.log(`  FAIL  ${n}${d ? '  ' + d : ''}`) }
function note(s) { console.log(`  NOTE  ${s}`) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * 取样：点击「AI 提交并推送」，在生成窗口内读屏幕状态。
 *
 * 工作区是否是脏的**不由探针决定** —— 直接劫持数据源（/api/status_porcelain
 * 注入一个未暂存修改、/api/branch-status 注入 upstream），这样在干净仓库、
 * 无上游分支的机器上也能跑，也不会因为"当前项目刚好干净"而假跳过。
 */
async function measure() {
  const { chromium } = require(PW)
  const browser = await chromium.launch({ args: ['--no-proxy-server'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    const errs = []
    page.on('pageerror', e => errs.push(e.message))

    await page.route('**/api/branch-status*', (r) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ahead: 0, behind: 0, hasUpstream: true, upstreamBranch: 'origin/main' }),
    }))
    await page.route('**/api/status_porcelain*', (r) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ status: ' M probe-fake.ts\n', isMergeInProgress: false }),
    }))

    // AI 请求挂住不返回：整条链路停在这里，后面的暂存/提交/推送不会启动
    await page.route('**/api/config/generate-commit-message', () => { /* 永不 resolve */ })

    await page.goto(VITE, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (document.querySelector('#app')?.querySelectorAll('*').length || 0) > 100,
      null, { timeout: 30000 }
    )
    await sleep(4500)

    const btn = page.locator('.one-ai-push-button')
    if (await btn.count() === 0) return { found: false, errs }

    const idle = await page.evaluate(() => {
      const b = document.querySelector('.one-ai-push-button')
      return {
        disabled: b.classList.contains('is-disabled') || b.disabled === true,
        title: b.querySelector('.one-ai-push-title')?.textContent?.trim() ?? '',
      }
    })
    if (idle.disabled) return { found: true, disabled: true, errs }

    await btn.click()
    // 鼠标挪开：不然 200ms 后 tooltip 会挂上来挡住按钮，截图里看不清那一行文案
    await page.mouse.move(20, 20)
    await sleep(1500)   // 生成窗口内（AI 请求被挂住，这个窗口不会自己结束）

    const during = await page.evaluate(() => {
      const b = document.querySelector('.one-ai-push-button')
      return {
        overlay: !!document.querySelector('.global-loading-overlay'),
        overlayText: document.querySelector('.global-loading-text, .loading-text')?.textContent?.trim() ?? '',
        loading: b.classList.contains('is-loading'),
        title: b.querySelector('.one-ai-push-title')?.textContent?.trim() ?? '',
      }
    })
    // 再取一次：确保不是"只闪了一下"的中间态
    await sleep(1200)
    const later = await page.evaluate(() => ({
      overlay: !!document.querySelector('.global-loading-overlay'),
      loading: document.querySelector('.one-ai-push-button')?.classList.contains('is-loading'),
    }))

    // 截图存证：反证模式下也留一张 —— 一眼能看到那层遮罩确实盖住了整屏
    const shotsDir = path.resolve(__dirname, '../docs/shots')
    fs.mkdirSync(shotsDir, { recursive: true })
    const shot = path.join(shotsDir, REVERSE ? 'ai-push-loading-reverse.png' : 'ai-push-loading.png')
    await page.screenshot({ path: shot })
    // 再给按钮单独来一张：整屏图里这颗太小，"转圈 + 文案"看不清
    await page.locator('.one-ai-push-button')
      .screenshot({ path: path.join(shotsDir, REVERSE ? 'ai-push-loading-button-reverse.png' : 'ai-push-loading-button.png') })

    return { found: true, disabled: false, idle, during, later, errs, shot }
  } finally {
    await browser.close()
  }
}

function report(m) {
  if (m.errs && m.errs.length) { bad('页面无 JS 异常', m.errs.join(' | ')); return false }
  ok('页面无 JS 异常')

  if (!m.found) { bad('找得到「AI 提交并推送」按钮', '整个按钮没渲染 —— 先确认是视图/时序问题，不是功能坏了'); return false }
  if (m.disabled) {
    note('按钮当前是禁用态（劫持数据源也没救回来）—— 跳过运行时断言，请人工确认为何点不动')
    return null
  }

  let pass = true
  if (m.during.overlay || m.later.overlay) {
    bad('A1 生成阶段没有全屏遮罩', `实测 overlay=${m.during.overlay}/${m.later.overlay}`
      + (m.during.overlayText ? `，遮罩文案「${m.during.overlayText}」` : ''))
    pass = false
  } else {
    ok('A1 生成阶段没有全屏遮罩')
  }

  if (!m.during.loading || !m.later.loading) {
    bad('A2 按钮自己在转圈', `is-loading=${m.during.loading}/${m.later.loading} —— 全屏撤了又不转圈就等于没有反馈`)
    pass = false
  } else if (m.during.title === m.idle.title) {
    bad('A2 按钮文案说清在干什么', `生成期间标题还是「${m.during.title}」，和空闲时一模一样`)
    pass = false
  } else {
    ok('A2 按钮自己在转圈且文案已变', `${m.idle.title} → ${m.during.title}`)
  }
  return pass
}

;(async () => {
  console.log('── AI 提交并推送：loading 落在按钮上，不盖全屏 ──\n')

  if (REVERSE) {
    const original = fs.readFileSync(TARGET, 'utf8')
    let okAll = false
    try {
      if (!original.includes(REV_FROM)) {
        note('源里没找到待改的串（结构变了？），反证未执行')
        process.exit(1)
      }
      fs.writeFileSync(TARGET, original.replace(REV_FROM, REV_TO))
      console.log('  关掉  把全屏 GlobalLoading 加回 AI 生成阶段')
      await sleep(4000)   // 等 HMR
      const m = await measure()
      const caught = !!(m.found && !m.disabled && m.during && m.during.overlay)
      console.log(caught
        ? `\n反证成立：加回全屏遮罩后 A1 变红（overlay=${m.during.overlay}，遮罩文案「${m.during.overlayText}」）`
        : `\n反证失败：加回全屏遮罩后断言仍绿，或按钮没点动（后者是假红）\n  found=${m.found} disabled=${m.disabled} overlay=${m.during && m.during.overlay}`)
      okAll = caught
      process.exitCode = caught ? 0 : 1
    } finally {
      fs.writeFileSync(TARGET, original)
      console.log('已还原')
      if (!okAll) process.exitCode = 1
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
  if (pass === null) { console.log('\n跳过'); return }
  console.log(pass ? '\n全部通过' : `\n${failed} 条失败`)
  console.log('截图存证：docs/shots/ai-push-loading.png')
  process.exit(pass ? 0 : 1)
})()

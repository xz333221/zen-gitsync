#!/usr/bin/env node
/**
 * 实例切换器：当前实例行的「×」关闭按钮必须**hover 才显示**（2026-10-06）。
 *
 * 起因：用户截图里第一行（当前实例）的 × 常驻，其余 5 行的 × 都是隐的，
 * 只有第一行特殊。查出来是组件里有一整套「当前行例外」硬覆盖：
 *   `.instance-menu-item--current .instance-close { position:static; opacity:1;
 *    pointer-events:auto }` + `.instance-action` 改并排 + port-badge 不淡出。
 * 这套覆盖已删，当前行回归与其余行一致的 hover 显现。
 *
 * 两条契约：
 *   B1 默认态：当前行 × 的 computed opacity === '0' 且 pointer-events === 'none'
 *   B2 hover 态：真实鼠标移上去后 opacity === '1' 且 pointer-events === 'auto'，
 *      同时 port-badge 淡出（opacity 0）—— 两者必须成对，只显现不淡出会留空档
 *
 * ⚠️ 为什么 B2 必须用**真实鼠标事件**：`:hover` 不能用 JS 伪造
 *    （`classList.add('__hover')` 之类都骗不到 `matches(':hover')`）。
 *
 * ⚠️ 为什么要 `offsetParent !== null` 过滤：EP 的 dropdown 弹层里同时存在
 *    一份隐藏的模板节点，`querySelector('.instance-menu-item--current')`
 *    会先命中它 —— rect 全是 0、`offsetParent === null`，
 *    直接拿它量会得到"按钮 opacity=0 所以没生效"的假结论（踩过一次）。
 *
 * ⚠️ 触发器要用**真实鼠标三连发**点开：`el.click()` 对被 tooltip 包着的
 *    dropdown trigger 无效，弹层不开，所有 rect 都是 0。
 *
 * 用法：
 *   node scripts/verify-instance-close-hover.cjs
 *   node scripts/verify-instance-close-hover.cjs --reverse   # 反证：钉回常驻应变红
 *
 * 依赖：src/ui/client/node_modules/playwright + 5544 上的 dev server。
 * 没有就 NOTE 跳过，不算失败。
 */

const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const VITE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const PW = path.join(ROOT, 'src/ui/client/node_modules/playwright')
const TARGET = path.join(ROOT, 'src/ui/client/src/components/InstanceSwitcher.vue')
const REVERSE = process.argv.includes('--reverse')

let failed = 0
function ok(n, d) { console.log(`  PASS  ${n}${d ? '  ' + d : ''}`) }
function bad(n, d) { failed++; console.log(`  FAIL  ${n}${d ? '  ' + d : ''}`) }
function note(s) { console.log(`  NOTE  ${s}`) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ── 反证：把「当前行例外」那套覆盖钉回去（还原成 2026-10-06 之前的样子）──
// 只动 CSS，DOM/模板完全不动 —— 模板级反证会让节点消失，量不到就成假红。
const REV_FROM = `:global(.instance-switcher-popper .port-badge) {
  transition: opacity var(--transition-fast) ease, transform var(--transition-fast) ease;
}`
const REV_TO = `:global(.instance-switcher-popper .instance-menu-item--current .instance-close) {
  position: static;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  opacity: 1;
  transform: none;
  pointer-events: auto;
}

:global(.instance-switcher-popper .port-badge) {
  transition: opacity var(--transition-fast) ease, transform var(--transition-fast) ease;
}`

async function measure() {
  const { chromium } = require(PW)
  const browser = await chromium.launch({ args: ['--no-proxy-server'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    const errs = []
    page.on('pageerror', e => errs.push(e.message))
    await page.goto(VITE, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (document.querySelector('#app')?.querySelectorAll('*').length || 0) > 100,
      null, { timeout: 30000 }
    )
    await sleep(4500)

    // 真实鼠标点开 trigger（tooltip 包着的 dropdown，click() 无效）
    const t = await page.evaluate(() => {
      const el = [...document.querySelectorAll('*')]
        .find(e => (e.className || '').toString().includes('instance-switcher'))
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })
    if (!t) return { error: '页面上找不到实例切换器 trigger' }
    await page.mouse.move(t.x, t.y); await sleep(200)
    await page.mouse.down(); await sleep(80); await page.mouse.up()
    await sleep(1200)

    // 只取真正渲染出来的那一份
    const pick = () => {
      const cur = [...document.querySelectorAll('.instance-menu-item--current')]
        .find(e => e.offsetParent !== null)
      if (!cur) return null
      const btn = cur.querySelector('.instance-close')
      const badge = cur.querySelector('.port-badge')
      const r = btn.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return {
        opacity: getComputedStyle(btn).opacity,
        pointer: getComputedStyle(btn).pointerEvents,
        badgeOpacity: getComputedStyle(badge).opacity,
        matchesHover: cur.matches(':hover'),
        // 命中测试：按钮中心最上层是不是它自己（防"看得见但点不到"）
        topIsBtn: hit === btn || btn.contains(hit),
      }
    }

    const before = await page.evaluate(pick)
    if (!before) return { error: '弹层里没有可见的当前实例行（dropdown 没打开？）' }

    const box = await page.evaluate(() => {
      const cur = [...document.querySelectorAll('.instance-menu-item--current')]
        .find(e => e.offsetParent !== null)
      const r = cur.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })
    await page.mouse.move(box.x, box.y)
    await sleep(600)
    const after = await page.evaluate(pick)

    return { before, after, errs }
  } finally {
    await browser.close()
  }
}

function report(m) {
  if (m.error) { bad('打开实例切换器', m.error); return false }
  if (m.errs.length) { bad('页面无 JS 异常', m.errs.join(' | ')); return false }
  ok('页面无 JS 异常')

  let pass = true
  if (m.before.opacity === '0' && m.before.pointer === 'none') {
    ok('B1 默认态当前行 × 隐藏', `opacity=${m.before.opacity} pointer-events=${m.before.pointer}`)
  } else {
    bad('B1 默认态当前行 × 应隐藏', `opacity=${m.before.opacity} pointer-events=${m.before.pointer}（常驻 = 没改成 hover 显现）`)
    pass = false
  }

  if (m.after.opacity === '1' && m.after.pointer === 'auto') {
    ok('B2 hover 后当前行 × 显现', `opacity=${m.after.opacity} pointer-events=${m.after.pointer}`)
  } else {
    bad('B2 hover 后当前行 × 未显现', `opacity=${m.after.opacity} pointer-events=${m.after.pointer} matchesHover=${m.after.matchesHover}`)
    pass = false
  }

  if (m.after.badgeOpacity === '0') ok('B2b hover 时端口徽章淡出（给 × 让位）', `opacity=${m.after.badgeOpacity}`)
  else { bad('B2b 端口徽章没淡出', `opacity=${m.after.badgeOpacity} —— 只显现不淡出会在原位置留空档`); pass = false }

  if (m.after.topIsBtn) ok('B2c hover 后 × 真的能点到（未被浮层遮挡）')
  else { bad('B2c × 看得见但点不到', 'elementFromPoint 命中的不是它自己'); pass = false }

  return pass
}

;(async () => {
  console.log('── 实例切换器：当前行 × 的 hover 显现 ──\n')

  if (REVERSE) {
    const original = fs.readFileSync(TARGET, 'utf8')
    let okAll = false
    try {
      if (!original.includes(REV_FROM)) {
        note('源里没找到待撤的串（样式结构变了？），反证未执行')
        process.exit(1)
      }
      fs.writeFileSync(TARGET, original.replace(REV_FROM, REV_TO))
      console.log('  关掉  把「当前行 × 常驻」那套覆盖钉回去')
      await sleep(3500)
      const m = await measure()
      if (m.error) { note(`反证中断：${m.error}`); process.exitCode = 1 }
      else {
        // 判据：默认态 opacity 变回 1（=常驻）即"如期变红"
        const fails = m.before.opacity === '1'
        console.log(fails
          ? `\n反证成立：钉回常驻后 B1 变红（默认态 opacity=${m.before.opacity}）`
          : `\n反证失败：钉回常驻后默认态 opacity 仍为 ${m.before.opacity} —— 断言不敏感`)
        okAll = fails
        process.exitCode = fails ? 0 : 1
      }
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
  console.log(pass ? '\n全部通过' : `\n${failed} 条失败`)
  process.exit(pass ? 0 : 1)
})()
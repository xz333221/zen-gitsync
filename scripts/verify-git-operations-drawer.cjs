#!/usr/bin/env node
/**
 * Git 操作抽屉（顶栏 Menu 图标）的按钮排版契约（2026-10-06）。
 *
 * 起因：用户截图里两处红框 —— 基础操作组 / 重置操作组的按钮"没对齐"，
 * 并且"重置到远程"的图标颜色不对。三条都是编译器 / tsc / build 全绿的
 * 纯视觉缺陷，只有量真实几何才拦得住。
 *
 * 三条契约：
 *   D1 同一抽屉里所有按钮的**左边缘 x 必须完全一致**
 *      —— Element Plus 默认 `.el-button + .el-button { margin-left: 12px }`
 *         是给横排写的，在纵向 flex 列里表现为「没被 div 包裹的按钮整颗右移 12px」。
 *         所以这必须断言"种类数 == 1"，不能只断言某两颗对齐（那会漏掉第三颗）。
 *   D2 每颗按钮的**宽度必须一致**，且等于所在组的内容宽
 *      —— `PushButton` 多包一层 inline-flex 时，外层的 width:100% 只量到 66px。
 *         同样断言"宽度种类数 == 1"，顺带保证新加的按钮不会破例。
 *   D3 每颗按钮的高度统一（40px），且**按钮内图标颜色继承按钮文字色**
 *      —— SvgIcon 组件自带 `color: var(--text-secondary)`，红底 danger 按钮上
 *         会出现一颗深灰图标。断言的是 computed 值真的等于按钮文字色。
 *
 * 用法：
 *   node scripts/verify-git-operations-drawer.cjs
 *   node scripts/verify-git-operations-drawer.cjs --reverse   # 反证：关掉修复应变红
 *
 * 依赖：src/ui/client/node_modules/playwright + 5544 上的 dev server。
 * 没有 dev server / 没装 playwright 时**不算失败**，只 NOTE（与 verify-ui-consistency
 * 的运行时抽样同一口径）—— CI 里前端不常驻。
 */

const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const VITE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const PW = path.join(ROOT, 'src/ui/client/node_modules/playwright')
const REVERSE = process.argv.includes('--reverse')

const FILES = {
  drawer: path.join(ROOT, 'src/ui/client/src/components/buttons/GitOperationsButton.vue'),
  push: path.join(ROOT, 'src/ui/client/src/components/buttons/PushButton.vue'),
  reset: path.join(ROOT, 'src/ui/client/src/components/buttons/ResetToRemoteButton.vue'),
}

let failed = 0
function ok(name, detail) { console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`) }
function bad(name, detail) { failed++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`) }
function note(s) { console.log(`  NOTE  ${s}`) }

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ── 反证模式下要动的那三处（必须与 probe 里的字符串替换完全一致）──
const PATCHES = [
  {
    file: FILES.drawer,
    label: 'D1 清掉 .el-button+.el-button 的 margin-left',
    from: `  :deep(.el-button + .el-button) {
    margin-left: 0;
  }`,
    to: `  :deep(.el-button + .el-button) {
    margin-left: 12px;
  }`,
  },
  {
    file: FILES.push,
    label: 'D2 让 push-button-group 退回 inline-flex',
    from: `  &.from-drawer {
    display: flex;
    width: 100%;

    .push-button {
      flex: 1;
      min-width: 0;
    }
  }`,
    to: `  &.from-drawer {
    display: inline-flex;
  }`,
  },
  {
    file: FILES.reset,
    label: 'D3 去掉图标 color: inherit',
    from: `  margin-right: 6px;
  color: inherit;
}`,
    to: `  margin-right: 6px;
}`,
  },
]

async function measure() {
  const { chromium } = require(PW)
  const browser = await chromium.launch({ args: ['--no-proxy-server'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
    await page.goto(VITE, { waitUntil: 'domcontentloaded' })
    // 首屏渲染完再点：过早点会被后续初始化顶掉（见 cdp-headless-ui-verify 的时序坑）
    await page.waitForFunction(
      () => (document.querySelector('#app')?.querySelectorAll('*').length || 0) > 100,
      null, { timeout: 30000 }
    )
    await sleep(4000)
    const opened = await page.evaluate(() => {
      const hit = [...document.querySelectorAll('button, [class*="icon-button"]')]
        .find(b => (b.getAttribute('aria-label') || b.textContent || '').includes('Git 操作'))
      if (!hit) return false
      hit.click()
      return true
    })
    if (!opened) return { error: '顶栏没找到「Git 操作」按钮' }
    await sleep(1200)
    const groups = await page.evaluate(() => {
      const gs = [...document.querySelectorAll('.git-operations-drawer .action-group')]
      return gs.map(g => ({
        title: g.querySelector('.group-title')?.textContent.trim(),
        buttons: [...g.querySelectorAll('.el-button')].map(b => {
          const r = b.getBoundingClientRect()
          const ic = b.querySelector('.el-icon, .svg-icon')
          return {
            text: b.innerText.replace(/\s+/g, ' ').trim(),
            x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height),
            color: getComputedStyle(b).color,
            iconColor: ic ? getComputedStyle(ic).color : null,
            hasIcon: !!ic,
          }
        }),
      }))
    })
    if (!groups.length) return { error: '抽屉没打开（.action-group 为 0）' }
    const buttons = groups.flatMap(g => g.buttons)
    return {
      groups,
      buttons,
      xKinds: [...new Set(buttons.map(b => b.x))],
      wKinds: [...new Set(buttons.map(b => b.w))],
      hKinds: [...new Set(buttons.map(b => b.h))],
      misaligned: buttons.filter(b => b.x !== Math.min(...buttons.map(x => x.x)))
        .map(b => b.text),
      narrow: buttons.filter(b => b.w !== Math.max(...buttons.map(x => x.w)))
        .map(b => `${b.text}(${b.w}px)`),
      wrongIcon: buttons.filter(b => b.hasIcon && b.iconColor !== b.color)
        .map(b => `${b.text} icon=${b.iconColor} vs text=${b.color}`),
    }
  } finally {
    await browser.close()
  }
}

function report(m) {
  if (m.error) { bad('打开 Git 操作抽屉', m.error); return false }

  // D1 左边缘
  if (m.xKinds.length === 1) ok('D1 所有按钮左边缘一致', `x=${m.xKinds[0]}，共 ${m.buttons.length} 颗`)
  else bad('D1 按钮左边缘不齐', `出现 ${m.xKinds.length} 种 x=${JSON.stringify(m.xKinds)}；右移的有：${m.misaligned.join('、')}`)

  // D2 宽度
  if (m.wKinds.length === 1) ok('D2 所有按钮宽度一致', `w=${m.wKinds[0]}px`)
  else bad('D2 按钮宽度不一致', `出现 ${m.wKinds.length} 种 w=${JSON.stringify(m.wKinds)}；窄的有：${m.narrow.join('、')}`)

  // D3 高度 + 图标继承
  if (m.hKinds.length === 1 && m.hKinds[0] === 40) ok('D3a 按钮高度统一 40px', `实测 ${JSON.stringify(m.hKinds)}`)
  else bad('D3a 按钮高度不统一', `实测 ${JSON.stringify(m.hKinds)}，期望单一值 40`)

  if (!m.wrongIcon.length) ok('D3b 按钮内图标颜色继承按钮文字色', `${m.buttons.filter(b => b.hasIcon).length} 颗带图标的按钮全部一致`)
  else bad('D3b 图标颜色没跟随按钮文字色', m.wrongIcon.join('；'))

  return m.xKinds.length === 1 && m.wKinds.length === 1
    && m.hKinds.length === 1 && m.hKinds[0] === 40 && !m.wrongIcon.length
}

;(async () => {
  console.log('── Git 操作抽屉按钮排版 ──\n')

  if (REVERSE) {
    const originals = new Map(PATCHES.map(p => [p.file, fs.readFileSync(p.file, 'utf8')]))
    let okAll = true
    try {
      for (const p of PATCHES) {
        const src = originals.get(p.file)
        if (!src.includes(p.from)) { note(`SKIP ${p.label}（源里没找到待撤的串，可能被别的改动挪了位置）`); okAll = false; continue }
        fs.writeFileSync(p.file, src.replace(p.from, p.to))
        console.log(`  关掉  ${p.label}`)
      }
      if (!okAll) process.exit(1)
      await sleep(3500)   // 等 Vite HMR 重新编译
      const m = await measure()
      if (m.error) { bad('反证：打开抽屉失败', m.error); process.exit(1) }
      const allBad = m.xKinds.length > 1 && m.wKinds.length > 1 && m.wrongIcon.length > 0
      console.log(allBad
        ? `\n反证成立：撤掉修复后 D1/D2/D3b 全部变红（x 种类 ${m.xKinds.length}、w 种类 ${m.wKinds.length}、图标色错 ${m.wrongIcon.length} 处）`
        : `\n反证失败：撤掉修复后仍有断言为绿 —— 断言对修复不敏感\n  x=${JSON.stringify(m.xKinds)} w=${JSON.stringify(m.wKinds)} 图标色错=${JSON.stringify(m.wrongIcon)}`)
      process.exitCode = allBad ? 0 : 1
    } finally {
      for (const [f, s] of originals) fs.writeFileSync(f, s)
      console.log('\n已还原三处修复')
    }
    return
  }

  let chromium
  try { ({ chromium } = require(PW)) } catch {
    note('未装 playwright（src/ui/client/node_modules/playwright），跳过运行时断言')
    note('这条只有真实浏览器能量：三条契约全是 computed style / getBoundingClientRect 的差')
    return
  }
  try {
    const r = await fetch(VITE, { signal: AbortSignal.timeout(3000) })
    if (!r.ok) throw new Error('HTTP ' + r.status)
  } catch {
    note(`${VITE} 上没有 dev server，跳过运行时断言（起前端：cd src/ui/client && npm run dev）`)
    return
  }

  const pass = report(await measure())
  console.log(pass ? '\n全部通过' : `\n${failed} 条失败`)
  process.exit(pass ? 0 : 1)
})()
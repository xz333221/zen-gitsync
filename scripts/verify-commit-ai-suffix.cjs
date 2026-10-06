#!/usr/bin/env node
/**
 * 提交信息输入框里的 ✨「AI 生成提交信息」必须**嵌在输入框边框内部**（2026-10-06）。
 *
 * 起因：用户说"这个 ai 生成按钮放到输入框里面吧"。改前它是
 * `.description-container` 里紧挨 `.el-input__wrapper` 的**兄弟节点**，
 * 靠 flex gap 隔开 —— 实测按钮左边缘 x=1564、输入框右边缘 x=1556，
 * `btnOutsideRight=true`，也就是浮在框外，读起来像"框旁边多一颗钮"。
 *
 * 两条契约（标准 / 普通两种提交模式各一条）：
 *   A1 标准模式：✨ 的 DOM 必须在 `.el-input__suffix` 里（走 EP 的 suffix 插槽）
 *   A2 普通模式：EP 在 type="textarea" 时**不渲染 suffix 容器**，改用绝对定位，
 *      所以断言换成了通用口径 —— 两种模式下 ✨ 的矩形都必须完全落在
 *      "承载边框的那个元素"（textarea 模式是 .el-textarea__inner，
 *      单行模式是 .el-input__wrapper）内部，且右缘留白 ≥ 6px。
 *
 * 为什么值得固化：这是纯视觉契约，tsc / build / 组件单测全绿。
 * 而且普通模式那条**特别容易悄悄回归** —— EP 哪天给 textarea 补上 suffix，
 * 绝对定位就会和 suffix 里的按钮重叠（两颗 ✨ 叠在一起）。
 *
 * 用法：
 *   node scripts/verify-commit-ai-suffix.cjs
 *   node scripts/verify-commit-ai-suffix.cjs --reverse   # 反证：搬回框外应变红
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
const TARGET_STYLE = path.join(ROOT, 'src/ui/client/src/views/components/CommitForm.vue')

let failed = 0
function ok(n, d) { console.log(`  PASS  ${n}${d ? '  ' + d : ''}`) }
function bad(n, d) { failed++; console.log(`  FAIL  ${n}${d ? '  ' + d : ''}`) }
function note(s) { console.log(`  NOTE  ${s}`) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ── 反证：让 ✨ 跑到框外（还原成 2026-10-06 改之前的观感）。
//
// ⚠️ 反证必须**只动 CSS、让按钮留在 DOM 里**。试过三条模板级改法，全都假红：
//  ① 删掉 <template #suffix> 的开闭标签、按钮原地留下 → el-autocomplete
//     **不渲染默认插槽**，按钮不在 DOM 里 → found:false（红因是「元素没了」）。
//  ② 把闭合标签提前、按钮挪到 </el-autocomplete> 之后 → 闭合标签后紧跟的
//     长 HTML 注释失去配对，未闭合注释吞掉后面整个模板 → found:false。
//  ③ 换成自闭合 `<el-autocomplete />` → **Vue 模板里组件不能自闭合**，
//     编译器仍按未闭合处理 → found:false。
//
// 所以这里走 CSS：给 .type-scope-container 开定位上下文 + 把 .ai-suffix-btn
// 绝对定位到框右外侧 44px 处。DOM 完全不变，只有位置变了 ——
// 断言读到 found=true 且 insideX=false，红的原因精确地是「位置不对」。──
const REV_FROM = `:deep(.ai-suffix-btn) {
  flex-shrink: 0;
  border: none;
  margin-right: 0;
}`
const REV_TO = `:deep(.ai-suffix-btn) {
  flex-shrink: 0;
  border: none;
  margin-right: 0;
  /* REVERSE-PROBE: 故意把 ✨ 挪到输入框框外，还原成 2026-10-06 之前的样子 */
  position: absolute;
  right: -44px;
  top: 6px;
}

.type-scope-container {
  position: relative;
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

    const setMode = (std) => page.evaluate((v) => {
      const p = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
      const c = p.state.value.configStore || p.state.value.config
      c.isStandardCommit = v
    }, std)

    // 量的口径：**承载边框的那个元素**的矩形 —— textarea 模式是
    // .el-textarea__inner，单行模式是 .el-input__wrapper。
    const read = (sel) => page.evaluate((sel) => {
      const box = document.querySelector(sel)
      const btn = document.querySelector('.ai-suffix-btn')
      if (!btn) return { found: false, hasBtn: false }
      if (!box) return { found: false, hasBtn: true }
      const frame = (box.querySelector('.el-textarea__inner')
        || box.querySelector('.el-input__wrapper')
        || box).getBoundingClientRect()
      const r = btn.getBoundingClientRect()
      return {
        found: true,
        insideX: r.x >= frame.x - 0.5 && r.right <= frame.right + 0.5,
        insideY: r.y >= frame.y - 0.5 && r.bottom <= frame.bottom + 0.5,
        rightGap: Math.round(frame.right - r.right),
        // 按钮数：textarea 若哪天也渲染 suffix，绝对定位那颗会和它叠成两颗
        btnCount: document.querySelectorAll('.ai-suffix-btn').length,
        inSuffix: !!btn.closest('.el-input__suffix'),
      }
    }, sel)

    await setMode(true); await sleep(600)
    const std = await read('.description-input')
    await setMode(false); await sleep(600)
    const plain = await read('.commit-message-input')
    await setMode(true); await sleep(400)   // 复原，别把用户配置带歪
    return { std, plain, errs }
  } finally {
    await browser.close()
  }
}

function report(m) {
  if (m.errs.length) { bad('页面无 JS 异常', m.errs.join(' | ')); return false }
  ok('页面无 JS 异常')

  let pass = true
  const one = (name, r, needSuffix) => {
    if (!r.found) { bad(name, `元素没渲染出来（hasBtn=${r.hasBtn}）—— 先确认是选择器/时序问题，不是产品坏了`); pass = false; return }
    if (!r.insideX || !r.insideY) { bad(name, `✨ 没落在边框内部 insideX=${r.insideX} insideY=${r.insideY}`); pass = false; return }
    if (r.rightGap < 6) { bad(name, `✨ 贴边太紧 rightGap=${r.rightGap}px，应 ≥6`); pass = false; return }
    if (needSuffix && !r.inSuffix) { bad(name, '标准模式应走 el-input 的 suffix 插槽'); pass = false; return }
    ok(name, `rightGap=${r.rightGap}px${needSuffix ? '，在 suffix 内' : ''}`)
  }
  one('A1 标准模式 ✨ 嵌在描述框边框内', m.std, true)
  one('A2 普通模式 ✨ 嵌在 textarea 边框内', m.plain, false)

  // 防重叠：EP 哪天给 textarea 补 suffix，绝对定位那颗就会和它叠起来
  for (const [name, r] of [['标准模式', m.std], ['普通模式', m.plain]]) {
    if (r.found && r.btnCount !== 1) {
      bad(`${name} 只有一颗 ✨`, `实测 ${r.btnCount} 颗 —— textarea 若开始渲染 suffix，绝对定位那颗会和它重叠`)
      pass = false
    }
  }
  if (pass) ok('A3 每种模式只有一颗 ✨（无重叠）')
  return pass
}

;(async () => {
  console.log('── 提交框 ✨ 按钮位置 ──\n')

  if (REVERSE) {
    const original = fs.readFileSync(TARGET_STYLE, 'utf8')
    let okAll = false
    try {
      if (!original.includes(REV_FROM)) {
        note('源里没找到待撤的串（样式结构变了？），反证未执行')
        process.exit(1)
      }
      fs.writeFileSync(TARGET_STYLE, original.replace(REV_FROM, REV_TO))
      console.log('  关掉  把 ✨ 挪到输入框框外（CSS 级，DOM 不动）')
      await sleep(3500)
      const m = await measure()
      // 判据要严：元素还得在（found=true），且必须是「因为在外面」而红
      const fails = m.std.found === true && (m.std.insideX === false || m.std.inSuffix === false)
      console.log(fails
        ? `\n反证成立：✨ 挪到框外后标准模式断言变红（found=${m.std.found} insideX=${m.std.insideX} inSuffix=${m.std.inSuffix} rightGap=${m.std.rightGap}）`
        : `\n反证失败：挪到框外后断言仍全绿，或元素消失（后者是假红）\n  found=${m.std.found} insideX=${m.std.insideX} inSuffix=${m.std.inSuffix} rightGap=${m.std.rightGap}`)
      okAll = fails
      process.exitCode = fails ? 0 : 1
    } finally {
      fs.writeFileSync(TARGET_STYLE, original)
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
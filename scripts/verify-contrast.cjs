/**
 * 关键小字对比度 —— 守 2026-10-16 对比度走查修复的那批「信息型小字」（WCAG AA ≥ 4.5:1）。
 *
 * 守的条目（双主题各跑一遍）：
 *   A1  提交历史分支/tag chips（.branch-tag，success / warning / info 三型全部要有样本且达标）
 *   A2  提交哈希按钮 .commit-hash
 *   A3  分支领先徽标 .status-badge（el-tag--warning 定制版）
 *   A4  活动栏同步角标 .git-sync-badge（白字实底角标一族代表）
 *   A5  AI 提交按钮 .one-ai-push-title / .one-ai-push-desc（浅底白字 / 暗底白字两档）
 *
 * 口径：WCAG 2.x 相对亮度 + 逐级合成有效背景。两个坑已经吃掉过两次假读数，别拆：
 *   ① alpha 必须正确累积（a = fg.a + bg.a×(1−fg.a)），写死 a:1 会让「两层半透明」提前收尾；
 *   ② Chromium 对 color-mix 的序列化是 color(srgb r g b / a)（0~1 浮点），
 *      解析器必须同时认 rgb()/rgba() 与 color(srgb …)，漏一种＝该层被静默跳过。
 *
 * --reverse 反样本：把旧值（EP 默认彩字 / #3b82f6 / #d46b08 / #67c23a / #a78bfa）注回去，
 *   预期——两个主题 A1~A5 恰好全红（暗色的 A1 红来自 info 型：旧 EP 灰在暗底 ~3.5:1，
 *   恰好说明「亮色规则不泄漏进暗色」这条也需要覆写兜底）。对不上说明断言没咬在颜色上，
 *   别信「没报错就是过」。
 *
 * 说明：顶栏 CPU/MEM 告警色只在 ≥70% 时上色，默认态量不到（改的是 usageAlert 常量）；
 *   其余同族角标（工作台运行中 / 编辑器未保存 / 控制台会话 / 智能体生成）默认态不渲染，
 *   同口径「兑 55% 黑」，需要时按 A4 的写法补。
 */
const path = require('node:path')
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const REVERSE = process.argv.includes('--reverse')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = []
const check = (name, ok, extra = '') => {
  if (!ok) failures.push(name)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}

/** 在页面里测一批元素的对比度（口径同 targets.cjs 探针） */
const MEASURE = `() => {
  const parse = (c) => { if (!c) return null
    let m = /rgba?\\(([^)]+)\\)/.exec(c)
    if (m) { const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 } }
    m = /color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+))?\\)/.exec(c)
    if (m) return { r: Number(m[1]) * 255, g: Number(m[2]) * 255, b: Number(m[3]) * 255, a: m[4] !== undefined ? Number(m[4]) : 1 }
    return null }
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
  const blend = (fg, bg) => ({ r: fg.r*fg.a+bg.r*(1-fg.a), g: fg.g*fg.a+bg.g*(1-fg.a), b: fg.b*fg.a+bg.b*(1-fg.a),
    a: fg.a + bg.a * (1 - fg.a) })
  const effBg = (el) => { let node = el, acc = null
    while (node) { const c = parse(getComputedStyle(node).backgroundColor)
      if (c && c.a > 0) { acc = acc ? blend(acc, c) : c; if (acc.a >= 0.999) return acc }
      node = node.parentElement }
    const hb = parse(getComputedStyle(document.documentElement).backgroundColor)
    const base = hb && hb.a >= 1 ? hb : { r: 255, g: 255, b: 255, a: 1 }
    return acc ? blend(acc, base) : base }
  const measure = (el) => { const st = getComputedStyle(el); const fg = parse(st.color); const bg = effBg(el)
    const fgc = fg.a < 1 ? blend(fg, bg) : fg
    const L1 = lum(fgc), L2 = lum(bg)
    return Math.round(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)) * 100) / 100 }
  const out = {}
  out.tags = [...document.querySelectorAll('.branch-tag')].map((el) => ({
    type: [...el.classList].find((c) => c.startsWith('el-tag--') && !['el-tag--small', 'el-tag--light'].includes(c)) || 'el-tag--default',
    text: (el.textContent || '').trim().slice(0, 20), ratio: measure(el) }))
  const q = (s) => document.querySelector(s)
  for (const [key, sel] of [['hash', '.commit-hash'], ['statusBadge', '.status-badge'], ['syncBadge', '.git-sync-badge'],
    ['aiTitle', '.one-ai-push-title'], ['aiDesc', '.one-ai-push-desc']]) {
    const el = q(sel)
    out[key] = el ? measure(el) : null
  }
  return out
}`

const REVERSE_CSS = `
  .branch-tag.el-tag--success { color: #67c23a !important; }
  .branch-tag.el-tag--warning { color: #e6a23c !important; }
  .branch-tag.el-tag--info    { color: #909399 !important; }
  .commit-hash { color: #3b82f6 !important; }
  .status-badge.el-tag--warning { color: #d46b08 !important; }
  .git-sync-badge { background: #67c23a !important; }
  .one-ai-push-button:not(.is-disabled) { background: #a78bfa !important; }
  /* 暗色下 AI 按钮另有 [data-theme]+class+:not+[data-v] 的 scoped 覆写（b=4），
     注入要再抬一级（双写类名 → b=5）才能模拟「旧值」——否则反样本会假阴性 */
  html[data-theme="dark"] .one-ai-push-button:not(.is-disabled).one-ai-push-button { background: #a78bfa !important; }
`

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.activity-bar', { timeout: 30000 })
  await sleep(2500)

  const getTheme = () => page.evaluate(() => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'))
  const setTheme = async (t) => {
    await page.waitForSelector('.theme-toggle-btn', { timeout: 15000 })
    for (let i = 0; i < 4; i++) { if ((await getTheme()) === t) return true; await page.locator('.theme-toggle-btn').first().click(); await sleep(700) }
    return (await getTheme()) === t
  }

  if (REVERSE) await page.addStyleTag({ content: REVERSE_CSS })
  console.log(`── ${REVERSE ? '反样本（注入旧值，预期指定条目变红）' : '正样本（预期全部达标）'} ──`)

  const reds = { light: [], dark: [] }
  const skips = []
  for (const theme of ['light', 'dark']) {
    await setTheme(theme)
    await sleep(1600)
    // A3/A4（领先徽标/同步角标）要等 /api/branch-status 落地才渲染 —— 固定 sleep
    // 不够稳（2026-10-16 实测冷启动偶发 4.5s+），等到出现或超时后如实跳过；
    // 不这样，反样本对账会被"未渲染"搅成假红。
    await page.waitForSelector('.git-sync-badge', { timeout: 8000 }).catch(() => {})
    await page.waitForSelector('.status-badge', { timeout: 4000 }).catch(() => {})
    const m = await page.evaluate(eval(MEASURE))
    console.log(`\n  [${theme}]`)
    failures = []
    const need = ['el-tag--success', 'el-tag--warning', 'el-tag--info']
    const types = [...new Set(m.tags.map((t) => t.type))]
    const missingTypes = need.filter((t) => !types.includes(t))
    if (m.tags.length === 0) { skips.push(`${theme}·A1`); console.log('  SKIP  A1 分支 chips（未渲染）') }
    else {
      check(`${theme}·A1 分支 chips 类型齐全`, missingTypes.length === 0, missingTypes.join(',') || `${m.tags.length} 枚`)
      const bad = m.tags.filter((t) => t.ratio < 4.5)
      check(`${theme}·A1 分支 chips 全部 ≥4.5`, bad.length === 0,
        bad.map((t) => `${t.text}=${t.ratio}`).join(' ') || `min=${Math.min(...m.tags.map((t) => t.ratio))}`)
    }
    for (const [key, label] of [['hash', 'A2 提交哈希'], ['statusBadge', 'A3 领先徽标'], ['syncBadge', 'A4 同步角标'], ['aiTitle', 'A5 AI 按钮标题'], ['aiDesc', 'A5 AI 按钮副标题']]) {
      const r = m[key]
      if (r === null) { skips.push(`${theme}·${label}`); console.log(`  SKIP  ${label}（未渲染）`); continue }
      check(`${theme}·${label} ≥4.5`, r >= 4.5, `${r}:1`)
    }
    reds[theme] = [...failures]
  }

  // ── 反样本对账 ──────────────────────────────────────────────
  if (REVERSE) {
    console.log('\n  [反样本对账]')
    // 循环里那些 FAIL 是「预期红」，最终判定只认对账结果 —— 先清空
    failures = []
    // A3/A4（领先徽标/同步角标）在「本地与远端同步」的仓库态下合法不渲染
    // （ahead=0 什么都不该显示）—— 对账按实际渲染项来要，跳过的条目不苛求变红。
    const wasSkipped = (theme, tag) => skips.some((s) => s.startsWith(`${theme}·`) && s.includes(tag))
    const wantTags = (theme) => ['A1', 'A2', 'A3', 'A4', 'A5'].filter((t) => !wasSkipped(theme, t))
    const lightOk = wantTags('light').every((k) => reds.light.some((n) => n.includes(k)))
    check('亮色 A1~A5 恰好变红', lightOk, reds.light.join(' / ') || '(没有红的=反样本没咬住)')
    const darkOk = wantTags('dark').every((k) => reds.dark.some((n) => n.includes(k)))
    check('暗色 A1~A5 恰好变红', darkOk, reds.dark.join(' / ') || '(没有红的=反样本没咬住)')
  }

  await setTheme('light')
  await browser.close()
  console.log(`\n${failures.length === 0 ? '✅ ALL PASS' : `❌ ${failures.length} FAIL: ${failures.join(' | ')}`}${skips.length ? `（跳过 ${skips.length} 项）` : ''}`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })

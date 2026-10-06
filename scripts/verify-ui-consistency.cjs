#!/usr/bin/env node
// Copyright 2026 xz333221
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// 设计一致性回归探针（docs/ui-audit/README.md 那轮审计的固化）
//
//   用法：node scripts/verify-ui-consistency.cjs
//   依赖：无（纯静态扫描 + 可选的 Playwright 运行时抽样）
//
// 为什么要有这个：审计发现的核心问题不是"缺设计系统"，而是"系统没被被用"——
// 令牌写在 variables.scss 里，但消费点各写各的。这类问题编译器不报错、
// tsc 不报错、build 也不报错，只有把口径写成断言才拦得住。
//
// 分两部分：
//   A. 静态断言 —— 扫 src/ui/client/src 全部 .vue/.scss/.css，违反即红。
//      这些是 2026-10-04 那轮修复定下的口径，每条都能在 git log 里找到出处。
//   B. 运行时抽样 —— 若 5544 上有 dev server，顺便统计「同一屏内实际渲染出
//      多少种图标按钮尺寸 / 间距 / 背景色」，输出参考值。没有 server 就跳过，
//      不算失败（CI 里前端不常驻）。
//
// 退出码：0 = 全绿；1 = 有断言失败。

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'src/ui/client/src')
const VITE = 'http://127.0.0.1:5544'

let failed = 0
let passed = 0
const notes = []

function ok(name, detail) {
  passed++
  console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`)
}
function bad(name, detail) {
  failed++
  console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`)
}
function note(s) {
  notes.push(s)
  console.log(`  NOTE  ${s}`)
}

// ─────────────────────────────────────────────────────────────
// A. 静态断言
// ─────────────────────────────────────────────────────────────

const files = []
;(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'public') continue
      walk(p)
    } else if (/\.(vue|scss|css)$/.test(e.name)) files.push(p)
  }
})(SRC)

if (files.length < 100) {
  bad('扫描到足够多的源文件', `只有 ${files.length} 个，路径可能不对`)
} else {
  ok('扫描源文件', `${files.length} 个`)
}

/**
 * 逐行扫描，但先把注释**整段抹掉**再匹配。
 *
 * 为什么不能只跳过「以 // 或 * 开头的行」：SCSS 块注释的续行不以 * 开头，
 * 而这轮修复往注释里写了很多历史说明（比如"原本是 border-left: 3px"、
 * "原本用的是 EP 旧默认蓝 #409eff"）—— 只按行首判断会把它们当成真代码，
 * 探针第一次跑就被自己的注释绊倒。
 * 抹注释时保留换行，行号才不会错位。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

function scan(re) {
  const hits = []
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8')
    stripComments(raw)
      .split(/\r?\n/)
      .forEach((line, i) => {
        const t = line.trim()
        if (!t) return
        const m = line.match(re)
        if (m) hits.push(`${path.relative(ROOT, f)}:${i + 1}  ${t.slice(0, 90)}`)
      })
  }
  return hits
}

/** 直接对单个文件做断言时也要走 stripComments，否则注释会误伤 */
function scanFile(re, f) {
  return stripComments(fs.readFileSync(f, 'utf8'))
    .split(/\r?\n/)
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.trim() && re.test(line))
    .map(({ line, n }) => `${path.relative(ROOT, f)}:${n}  ${line.trim().slice(0, 90)}`)
}

function assertNone(name, re, allow = []) {
  const hits = scan(re)
  const kept = []
  const real = []
  for (const h of hits) {
    if (allow.some((a) => h.includes(a))) kept.push(h)
    else real.push(h)
  }
  if (real.length === 0) {
    ok(name, kept.length ? `（豁免 ${kept.length} 处，见 ALLOW 表）` : '')
  } else {
    bad(name, `${real.length} 处`)
    real.slice(0, 8).forEach((h) => console.log(`          ${h}`))
    if (real.length > 8) console.log(`          …还有 ${real.length - 8} 处`)
  }
}

console.log('\n── A. 静态断言 ──')

// A1 状态色不能直接当文字色。审计 P0-01：#e6a23c 在面板上只有 2.05:1。
assertNone(
  '状态色不走 color:（文字一律用 --color-*-dark）',
  /(?<![\w-])color:\s*var\(--color-(success|warning|danger|info)\)/,
)
assertNone(
  '文字色不走 --text-tertiary（装饰档只留给 border/background）',
  /(?<![\w-])color:\s*var\(--text-tertiary\)/,
)

// A2 不许引用不存在的令牌。审计 P0-05：var(--radius-sm) fallback 落 0，
//    .kb-card__reply 一度渲染成直角；var(--shadow-xs) 同理。
assertNone('不引用 var(--radius-sm)（令牌表里没有 sm 档）', /var\(--radius-sm\)/)
assertNone('不引用 var(--shadow-xs)（令牌表里没有 xs 档）', /var\(--shadow-xs/)

// A3 侧边色条。审计 P0-02：21 处 border-left: 2/3/4px。
//    这两处是已知豁免 —— 都有探针逐字/几何断言，要改必须连探针一起改并实跑：
//      WorkbenchKanban.vue  .kb-card__reply   verify-wb-card-reply.cjs:302 断言 borderLeft==='2px'
//      TreeNodeItem.vue     文件树选中态      tree-node 在 scripts/ 里有 19 处引用
assertNone(
  '不用 >1px 的 border-left 当彩色强调',
  /border-left:\s*[2-9]px/,
  ['WorkbenchKanban.vue', 'TreeNodeItem.vue'],
)

// A4 EP 旧默认蓝。variables.scss:394-397 明确记录"不再保留 #409eff"。
assertNone(
  '不残留 Element Plus 旧默认蓝 #409eff',
  /#409eff|#409EFF|rgba\(\s*64\s*,\s*158\s*,\s*255/i,
)

// A5 令牌层清理后的孤儿。审计 A1：workbench.scss 曾有 5 族 0 消费者的工具类。
assertNone('不引用已删除的 --badge-* 令牌', /var\(--badge-/)
assertNone('不引用已删除的 --icon-btn-* 令牌', /var\(--icon-btn-/)
assertNone('不引用已删除的 --soft-btn-* 基线（只剩 4 个存活值）',
  /var\(--soft-btn-(height-sm|padding-x|border\b|bg\b|color\b|radius\b|shadow-hover)\)/)

// A6 焦点环统一到 --focus-outline。审计 P1-11：IconButton 曾画双层环。
assertNone(
  '焦点环走 --focus-outline（不自己拼 outline + box-shadow 两层）',
  /outline:\s*2px solid var\(--color-primary\)/,
)

// A7 输入框焦点环没被 !important 干掉。审计 P1-10。
{
  const common = stripComments(fs.readFileSync(path.join(SRC, 'styles/common.scss'), 'utf8'))
  const m = common.match(/input:not\(:focus\)\s*\{\s*box-shadow:\s*none\s*!important/)
  if (m) ok('静止态 inset 阴影压制保留、聚焦态放行焦点环')
  else bad('common.scss 末尾的 input 焦点环压制写法不对',
    '应为 input:not(:focus) { box-shadow: none !important }')
  if (/input\s*\{\s*box-shadow:\s*none\s*!important/.test(common)) {
    bad('仍有 input { box-shadow: none !important }', '会把焦点环一起废掉')
  } else ok('没有无差别的 input 焦点环压制')
}

// A8 禁用透明度只有一档。审计 E6：曾有 0.4/0.45/0.5/0.55/0.6/0.65 六档，
//    其中两处各带一个 !important 打同一类按钮。
{
  const hits = scan(/opacity:\s*0\.(4|45|55|6|65)\s*(!important)?;/)
    .filter((h) => /disabled/.test(h))
  if (hits.length === 0) ok('禁用态透明度统一走 --disabled-opacity')
  else {
    bad('还有禁用态用字面 opacity', `${hits.length} 处`)
    hits.slice(0, 6).forEach((h) => console.log(`          ${h}`))
  }
}

// A9 全屏 loading 不许彩虹渐变 + 磨砂。审计 B2。
{
  const gl = stripComments(fs.readFileSync(path.join(SRC, 'components/GlobalLoading.vue'), 'utf8'))
  const hasGradient = /linear-gradient/.test(gl)
  const hasBlur = /backdrop-filter/.test(gl)
  if (!hasGradient && !hasBlur) ok('GlobalLoading 无渐变、无 backdrop-filter')
  else bad('GlobalLoading 又出现装饰',
    [hasGradient && 'linear-gradient', hasBlur && 'backdrop-filter'].filter(Boolean).join(' + '))
}

// A10 AI 动作按钮：实心色，禁渐变。
//   口径改过一次：2026-10-04 上午按"PRODUCT.md 禁 AI purple"把它降级成主色，
//   下午就因为"三颗按钮变成两档同明度的蓝、层级分不出来"改回 --role-ai-ink。
//   真正该禁的从来是**渐变**（135deg + 发光），不是色相 —— 紫色在仓库里
//   本来就是 --color-think 一族的状态色身份。所以这里只断言"没有渐变"。
{
  const f = path.join(SRC, 'components/buttons/AiQuickPushButton.vue')
  const s = stripComments(fs.readFileSync(f, 'utf8'))
  if (/linear-gradient/.test(s)) bad('AiQuickPushButton 又有渐变')
  else if (!/var\(--role-ai-ink\)/.test(s)) {
    bad('AiQuickPushButton 没走 --role-ai-ink', '要么回到实心角色色，要么明确写下新口径')
  } else ok('AiQuickPushButton 是实心 --role-ai-ink，无渐变')
}

// A11 语义角色色必须在场。上一轮把全站压成"一个蓝 + 状态三色"，
//     层级只能靠明度分 —— 用户反馈"没有丰富的色彩又有些单调"。
//     这条守住角色表不被悄悄删回去。
{
  const v = stripComments(fs.readFileSync(path.join(SRC, 'styles/variables.scss'), 'utf8'))
  const roles = ['pending', 'active', 'done', 'error', 'ai']
  const missing = []
  for (const r of roles) {
    for (const slot of ['ink', 'surface', 'edge']) {
      if (!new RegExp('--role-' + r + '-' + slot + ':').test(v)) {
        missing.push(`--role-${r}-${slot}`)
      }
    }
  }
  if (missing.length) bad('语义角色色不完整', missing.join(' '))
  else ok('五个语义角色色齐全（pending/active/done/error/ai × ink/surface/edge）')
}

// A12 角色色的暗色档必须存在。--role-*-ink 在浅色是深色、在暗色必须反过来变亮，
//     忘了覆盖就会出现"暗色下角色色比正文还暗"。
{
  const d = stripComments(fs.readFileSync(path.join(SRC, 'styles/dark-theme.scss'), 'utf8'))
  const need = ['--role-pending-ink', '--role-ai-ink']
  const missing = need.filter((n) => !new RegExp(n + ':').test(d))
  if (missing.length) bad('dark-theme.scss 缺角色色暗色档', missing.join(' '))
  else ok('dark-theme.scss 覆盖了角色色 ink')
}

// A13 通用防线：**任何 var(--x) 引用到的令牌必须真的存在**。
//      CSS 里 var() 解析失败不会报错，只是把整条声明丢掉 —— 编译器不报、
//      tsc 不报、build 不报、浏览器 console 也不报，只能靠扫源码。
//      真实踩过两例：
//        OrchestratorConsole.vue  color: var(--warning-dark)
//          → 令牌表里只有 --color-warning-dark，"已暂停"和"调度中"一个颜色
//        WorkbenchKanban.vue      border-radius: var(--radius-sm)
//          → --radius-* 没有 sm 档，fallback 落 0，胶囊渲染成直角
{
  // 声明集合要扫**所有**样式文件，不能只看 variables.scss + dark-theme.scss ——
  // 很多自定义属性是就近声明在组件自己身上的（.kb-col 上的 --col-ink、
  // .kb-card 上的 --kb-mask-outside-band、common.scss .skeleton 里的 --skeleton-bg），
  // 只扫全局两张表会把它们全误判成"不存在"。
  const declared = new Set()
  // files 里只有 .vue/.scss/.css，但 :style 的值常来自 TS 里的对象字面量
  // （utils/projectTag.ts 就是 `return { '--tag-hue': String(...) }`），
  // 所以"声明"这一遍额外扫 .ts，否则 --tag-hue 会被误判成不存在。
  const declFiles = files.concat(
    (function walkTs(d) {
      const out = []
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === 'public') continue
          out.push(...walkTs(p))
        } else if (/\.ts$/.test(e.name)) out.push(p)
      }
      return out
    })(SRC),
  )
  for (const f of declFiles) {
    const t = stripComments(fs.readFileSync(f, 'utf8'))
    for (const m of t.matchAll(/(--[a-z0-9-]+)\s*:/g)) declared.add(m[1])
    // Vue 模板里 :style="{ '--card-min': w }" 也是声明 ——
    // RecentDirectoriesList / RemoteReposList / WorkbenchKanban 的
    // --dir-card-min / --repo-card-min / --avatar-hue / --tag-hue 都是这么来的，
    // 漏掉它们就会整片误报。
    for (const m of t.matchAll(/['"](--[a-z0-9-]+)['"]\s*:/g)) declared.add(m[1])
  }
  void declFiles
  // 真正由外部注入、不在本仓任何样式文件里的前缀：
  //   --acu-*  zen-ai-chat-ui 组件库（样式表在运行时由它的 <link>/import 引入）
  //   --el-*   Element Plus（运行时注入）
  //   --md-*   markdown 预览（markdownTheme.ts 在 JS 里 setProperty）
  const EXTERNAL_PREFIX = ['--acu-', '--el-', '--md-']
  const isExternal = (n) => EXTERNAL_PREFIX.some((p) => n.startsWith(p))
  // 自己扫一遍拿令牌名：scan() 返回的是「路径:行号  截断到 90 字的文本」，
  // 直接拿它再 match 会在被截断的行上拿到 null。
  const VAR_RE = /var\(\s*(--[a-z0-9-]+)/g
  const missing = new Map()
  for (const f of files) {
    const lines = stripComments(fs.readFileSync(f, 'utf8')).split(/\r?\n/)
    lines.forEach((line, i) => {
      let m
      VAR_RE.lastIndex = 0
      while ((m = VAR_RE.exec(line))) {
        const name = m[1]
        if (declared.has(name) || isExternal(name)) continue
        if (!missing.has(name)) missing.set(name, [])
        const loc = path.relative(ROOT, f) + ':' + (i + 1)
        if (missing.get(name).length < 3 && !missing.get(name).includes(loc)) {
          missing.get(name).push(loc)
        }
      }
    })
  }
  if (missing.size === 0) ok('所有 var(--x) 引用的令牌都在样式表里存在')
  else {
    bad(`${missing.size} 个 var() 引用了不存在的令牌（声明会被静默丢弃）`)
    for (const [k, v] of [...missing].slice(0, 12)) console.log(`          ${k}  ← ${v.join(', ')}`)
  }
}

// A14 动作区禁用态：不许回到"主色当淡底 + 白字"。
//     2026-10-06 实测（用户截图 + 逐像素扫色）：工作区干净 → 五颗动作按钮全 disabled，
//     三颗实心色落到 .el-button--primary.is-disabled 的 --color-primary-light 上、
//     再叠一层 --disabled-opacity → **三颗底色逐位相同 #afd2fc**（= #60a5fa × 0.5
//     落白底）、文字纯白 → WCAG 对比度 **1.56:1**；整条按钮带里紫色像素 0 个
//     （AI 档的身份色也没了）；左侧"暂存/提交/推送"另走一套（中性描边 +
//     --text-disabled 再乘 0.5 ≈ 1.2:1）—— 同屏两套禁用语言，两边都读不出按钮叫什么。
//     口径：禁用态 = 中性底（--bg-component-area）+ 单层灰字（--text-meta，
//     浅色 ≈4.99:1），淡由**色值**表达，**不再叠 --disabled-opacity**。
//     这条是从"同一屏里值的种类数"里学不到的那类问题：禁用态只在"没活儿干"时出现，
//     棘轮抽样那一屏未必渲染得到，所以必须静态钉住。
{
  const flatOf = (p) => stripComments(fs.readFileSync(p, 'utf8')).replace(/\s+/g, ' ')
  /**
   * 取「`.is-disabled` 规则」的 selector / body。
   * 两个坑（首跑各踩过一次，别简化掉）：
   *  ① `:not(.is-disabled)` 是**反向**选择器（"可用态"），必须先从文本里抹掉，
   *     否则 InstanceSwitcher 的 `:not(.is-disabled):hover` 会被当成禁用态规则判红。
   *  ② 口径只针对 `.el-button`。`InstanceSwitcher` 的
   *     `.instance-menu-item--current.is-disabled::before` 拿主色画的是"当前实例"
   *     那根 2px 竖条（跟"禁用"无关，禁用项也可以是当前项），不该被这条扫到。
   */
  const isDisRules = (text) =>
    [...text.replace(/:not\(\.is-disabled\)/g, ':-x-')
      .matchAll(/([^{}]*\.is-disabled[^{}]*)\{([^{}]*)\}/g)]
      .map((m) => ({ selector: m[1], body: m[2] }))
      .filter((r) => /\.el-button/.test(r.selector))

  // ① 全仓：禁用态不许用主色家族 / 角色实心色当底
  const offenders = []
  for (const file of files) {
    for (const r of isDisRules(flatOf(file))) {
      if (
        /background(-color)?:\s*var\(--color-(primary|primary-light|primary-dark|warning)\)/.test(r.body) ||
        /background(-color)?:\s*var\(--role-ai-ink\)/.test(r.body)
      ) {
        offenders.push(`${path.relative(ROOT, file)}  ${r.selector.trim().slice(0, 80)}`)
      }
    }
  }
  if (offenders.length === 0) ok('禁用态不用主色/角色实心色当底')
  else {
    bad('禁用态还有拿主色当底的按钮规则', `${offenders.length} 处`)
    offenders.slice(0, 6).forEach((h) => console.log(`          ${h}`))
  }

  // ② 动作区那一份：必须"中性底 + 单层灰字 + 把写死的白字收回来"
  const f = path.join(SRC, 'components/GitActionButtons.vue')
  const rules = isDisRules(flatOf(f))
  const selectors = rules.map((r) => r.selector).join(' ')
  const bodies = rules.map((r) => r.body).join(' ')
  if (/background-color:\s*var\(--bg-component-area\)/.test(bodies)) {
    ok('动作区禁用底是中性底 --bg-component-area')
  } else {
    bad('动作区禁用底不是中性底', '应为 background-color: var(--bg-component-area)')
  }
  if (/color:\s*var\(--text-meta\)/.test(bodies)) {
    ok('动作区禁用文字走 --text-meta（浅色 ≈4.99:1）')
  } else {
    bad('动作区禁用文字令牌不对',
      '应 --text-meta；--text-disabled 是 #c0c4cc，浅底上只有 1.75:1')
  }
  if (/opacity:\s*var\(--disabled-opacity\)/.test(bodies)) {
    bad('动作区禁用态又叠了一层 opacity', '淡由色值表达；再乘 0.5 会把文字推到 2:1 以下')
  } else {
    ok('动作区禁用态只淡一次（不叠 opacity）')
  }
  if (/one-commit-icon|one-commit-title/.test(selectors) && /color:\s*inherit/.test(bodies)) {
    ok('三档按钮写死的白字/白图标在禁用态被收回')
  } else {
    bad('浅底白字风险',
      '三档按钮把标题/图标显式染成 #fff（AI 档还是行内 style），禁用态必须用 is-disabled 下的规则收回')
  }
}

// ─────────────────────────────────────────────────────────────
// B. 运行时抽样（可选）
// ─────────────────────────────────────────────────────────────
console.log('\n── B. 运行时抽样（需要 5544 上有 dev server）──')

async function runtime() {
  let chromium
  try {
    ;({ chromium } = require(path.join(ROOT, 'src/ui/client/node_modules/playwright')))
  } catch {
    note('未装 playwright，跳过运行时抽样')
    return
  }
  let browser
  try {
    const res = await fetch(`${VITE}/@vite/client`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error('http ' + res.status)
  } catch (e) {
    note(`dev server 没起（${e.message}），跳过运行时抽样`)
    return
  }
  try {
    browser = await chromium.launch()
  } catch (e) {
    note(`chromium 起不来（${e.message}），跳过运行时抽样`)
    return
  }
  let ctx
  try {
    ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
    const page = await ctx.newPage()
    await page.goto(VITE + '/')
    await page.waitForSelector('.app-body', { timeout: 60000 })
    await page.waitForTimeout(2500)
    // 透明底不进统计：全站 7000+ 个元素里绝大多数是 transparent，算进去
    // 只会让数字虚高。
    const TRANSPARENT = ['rgba(0, 0, 0, 0)', 'transparent']
    const g = await page.evaluate((TRANSPARENT) => {
      const iconBtn = new Set()
      const spacing = {}
      const bg = {}
      for (const el of document.querySelectorAll('button, .el-button, input, [class*="btn"]')) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.width < 60 && r.height > 0 && r.height < 60) {
          iconBtn.add(`${Math.round(r.width)}x${Math.round(r.height)}`)
        }
      }
      for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el)
        if (!TRANSPARENT.includes(cs.backgroundColor)) {
          bg[cs.backgroundColor] = (bg[cs.backgroundColor] || 0) + 1
        }
        for (const p of ['paddingTop', 'marginTop', 'gap']) {
          const v = cs[p]
          if (v && v !== 'normal' && v !== '0px') spacing[v] = (spacing[v] || 0) + 1
        }
      }
      return { iconBtn: [...iconBtn].sort(), spacing, bg }
    }, TRANSPARENT)

    // 棘轮：阈值 = 2026-10-04 修完之后的实测值。这些是「同一屏里值的种类数」，
    // 不是审美目标，是**不许再涨**的红线 —— 继续收敛就手动把数字调小。
    // 再涨就说明有人新写了一个刻度外的值。
    const measured = {
      图标按钮尺寸: { n: g.iconBtn.length, limit: 12, detail: g.iconBtn.join(' ') },
      间距: {
        n: Object.keys(g.spacing).length,
        limit: 16,
        detail: Object.keys(g.spacing).sort().join(' '),
      },
      背景色: {
        n: Object.keys(g.bg).length,
        /* 33 → 36（2026-10-04 晚，看板角色色返工）：**涨的这部分是我加的，且是有意的**。
           进行中的卡与出错的卡原先拿 6% 透明淡底当自己的背景，跟同屏别的透明淡底
           撞值；现在它们是两块**不透明**的浅暖底 / 浅红底（--role-*-wash），
           所以多出 2 个种类。用同页 A/B 量过：把整套新写法倒回旧写法，
           这一屏的不同背景色从 61 掉回 59 —— 增量正好 2，全部来自这里。
           ⚠️ 实测值随实时状态浮动：连跑两次拿到 35 与 34 —— 没有在跑 / 出错的卡时，
           那两块底色这一屏里压根不存在。所以红线定在**观测上限 + 1**，
           别贴着 35 定，否则这个棘轮会随机变红（本仓库最烦的就是假红）。
           想再收：要么把 wash 并回 surface（那这两张卡就又分不出来了），
           要么去别处找刻度外的值，别直接把这个数字继续往上抬。
           2026-10-05 第五轮：进行中的卡不再换底色（用户「非进行中的都是白色、
           进行中的是橙色有点奇怪」），那一块 wash 从这一屏里消失 ——
           现在的观测上限是 **35**，36 这条红线留着当余量，不再上调。 */
        limit: 36,
        detail: Object.keys(g.bg).slice(0, 8).join(' ') + ' …',
      },
    }
    for (const [k, v] of Object.entries(measured)) {
      if (v.n <= v.limit) ok(`同屏${k}种类未涨`, `${v.n}（红线 ${v.limit}）`)
      else bad(`同屏${k}种类又涨了`, `${v.n} > ${v.limit}  ${v.detail}`)
    }
    note('这几个数字是棘轮红线不是审美目标；继续收敛就手动调小 limit')
    note('想看全量明细：先起 dev server，再跑 node scripts/verify-ui-consistency.cjs')
  } catch (e) {
    note('运行时抽样失败：' + String(e).slice(0, 120))
  } finally {
    if (ctx) await ctx.close()
    if (browser) await browser.close()
  }
}

runtime().then(() => {
  console.log(`\n${failed === 0 ? '全部通过' : '有失败'}：${passed} PASS / ${failed} FAIL`)
  process.exit(failed === 0 ? 0 : 1)
})
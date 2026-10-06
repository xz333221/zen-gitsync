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
   *     `.instance-menu-item--current.is-disabled`（当前实例行，2026-10-06
   *     已去掉主色竖条、不再是选中态）用的是 list item 不是按钮，
   *     禁用只是"点自己没意义"，不该被这条扫到。
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

  // ② 动作区那一份：表单层（可读）+ 身份层（各档 wash + 身份色图标），两层都要在
  const f = path.join(SRC, 'components/GitActionButtons.vue')
  const rules = isDisRules(flatOf(f))
  const selectors = rules.map((r) => r.selector).join(' ')
  const bodies = rules.map((r) => r.body).join(' ')
  if (/background-color:\s*var\(--action-disabled-bg\s*,\s*var\(--bg-component-area\)\)/.test(bodies)) {
    ok('禁用底是「各档身份 wash，缺省中性」的可配置写法')
  } else {
    bad('禁用底写法不对',
      '应为 background-color: var(--action-disabled-bg, var(--bg-component-area)) —— 身份层可配、中性兜底')
  }
  if (/color:\s*var\(--action-disabled-fg\s*,\s*var\(--text-meta\)\)/.test(bodies)) {
    ok('禁用文字是「按底分档的字色，缺省 --text-meta」')
  } else {
    bad('禁用文字令牌不对',
      '应为 color: var(--action-disabled-fg, var(--text-meta)) —— wash 底上 #686a6f 只有 3.99:1')
  }
  if (/opacity:\s*var\(--disabled-opacity\)/.test(bodies)) {
    bad('动作区禁用态又叠了一层 opacity', '淡由色值表达；再乘 0.5 会把文字推到 2:1 以下')
  } else {
    ok('动作区禁用态只淡一次（不叠 opacity）')
  }
  if (/one-commit-icon|one-commit-title/.test(selectors) && /color:\s*inherit/.test(bodies)) {
    ok('三档按钮写死的白字在禁用态被收回')
  } else {
    bad('浅底白字风险',
      '三档按钮把标题显式染成 #fff，禁用态必须用 is-disabled 下的规则收回')
  }

  // ③ 身份层：三档必须各自声明 wash 底 + 身份色图标。
  //    为什么单列一条：2026-10-06 第一版把五颗统一压成中性灰（可读性达标），
  //    用户当天反馈「禁用状态全灰色有点丑」—— 为了治"淡蓝+白字"把三档身份色
  //    也一起抹了。仓库第二轮审计早就写过：**色相是身份，要压的是浓度不是色相**。
  //    所以这条钉住"禁用态仍保留各档身份"：底必须是 wash 档（tint / role-wash），
  //    图标必须是实心身份色（图标是小色块，别跟彩色文字一起清）。
  const TIERS = [
    { file: 'components/buttons/QuickCommitButton.vue', icon: /--action-disabled-icon:\s*var\(--color-primary\)/ },
    { file: 'components/buttons/QuickPushButton.vue', icon: /--action-disabled-icon:\s*var\(--color-primary\)/ },
    { file: 'components/buttons/AiQuickPushButton.vue', icon: /--action-disabled-icon:\s*var\(--role-ai-ink\)/ },
  ]
  const WASH_BG = /--action-disabled-bg:\s*var\(--(tint-[a-z0-9-]+|role-[a-z]+-(wash|surface))\)/
  const missingTier = []
  for (const t of TIERS) {
    const src = flatOf(path.join(SRC, t.file))
    const wash = (src.match(/--action-disabled-bg:\s*([^;}]+)/) || [])[1] || ''
    if (!WASH_BG.test(src)) missingTier.push(`${t.file} 缺 wash 档底（当前 ${wash.trim() || '无'}）`)
    else if (!t.icon.test(src)) missingTier.push(`${t.file} 缺身份色图标声明`)
    // wash 底比中性底深：字色必须跟着换深一档，否则 #686a6f 在 12% 主色 wash 上只有 3.99:1
    else if (!/--action-disabled-fg:\s*var\(--text-secondary\)/.test(src)) {
      missingTier.push(`${t.file} 缺 --action-disabled-fg: var(--text-secondary)`)
    }
  }
  if (missingTier.length === 0) ok('三档禁用态各自保留身份色（wash 底 + 实心身份图标）')
  else {
    bad('三档禁用态的身份层不完整', `${missingTier.length} 处`)
    missingTier.forEach((h) => console.log(`          ${h}`))
  }
  if (/color:\s*var\(--action-disabled-icon,\s*var\(--text-meta\)\)/.test(bodies)) {
    ok('图标走 --action-disabled-icon（缺省跟随文字色）')
  } else {
    bad('图标没有独立接管身份色', '应为 color: var(--action-disabled-icon, var(--text-meta))')
  }
}

// A15 提交区"无事可做就收起"（2026-10-06，用户提了两轮）
//     第一轮：「上面这些按钮全是禁用状态的话，那块区域就可以隐藏不展示了」；
//     第二轮：「没有任何变更的话，那这个 AI 生成按钮也就不用显示了，所以这块就能都隐藏了」。
//     这条钉四件事：
//       ① 判据必须在 store 里且**完整**（干净 + 无待推送 + 已到过一次状态 + 非合并中 + 非在跑）——
//          少一项就会在错误时机收起（首屏闪一下 / 把"有本地提交待推送"也收掉）；
//       ② 收起在 **`.commit-form-panel`** 上做（整块，含 header）：用
//          grid-template-rows: 1fr↔0fr（可过渡、可测），不许 display: none；
//       ③ **两个常驻入口（命令历史 / Git 操作）必须在顶栏** —— 它们是"敢整块收掉"的前提：
//          工作区干净恰好是最想 pull / fetch / merge 的时刻。搬走了但没搬全 = 功能丢。
//          同时不许在 CommitForm 里留重复的一份。
//       ④ 主题切换按钮"先不显示"= 用常量门控（代码保留、可一键恢复），不是删掉。
{
  const store = stripComments(fs.readFileSync(path.join(SRC, 'stores/gitStore.ts'), 'utf8'))
  const idle = (store.match(/const commitAreaIdle = computed\(\(\) => \(([\s\S]*?)\n  \)\)/) || [])[1] || ''
  const needTerms = [
    ['fileList.value.length === 0', '干净判据（原始 fileList，不吃 lockedFiles 过滤）'],
    ['branchAhead.value === 0', '排除"有本地提交待推送"（那时 AI 档走纯推送路径仍可用）'],
    ['statusLoadedOnce.value', '首屏/切目录门槛（否则收起会先发生再撤销）'],
    ['isMergeInProgress.value', '合并中要显示"请输入提交信息完成合并"的提示条'],
  ]
  // 判据只吃数据，**不许吃在途请求标志**（2026-10-06 修）：
  // 一回到这个页面（切 ActivityBar 视图 / 切回浏览器标签页）就有静默刷新把 isLoadingStatus
  // 置位，收起态跟着翻两次 = 提交历史被推下去又滑上来，用户原话「每次切到这个页面都会从下边过渡上去」。
  const forbiddenTerms = [
    ['isLoadingStatus.value', '在途请求标志会跟着静默刷新翻，收起态跟着翻 = 提交历史抖一下'],
  ]
  const missing = needTerms.filter(([t]) => !idle.includes(t)).map(([, why]) => why)
  const leaked = forbiddenTerms.filter(([t]) => idle.includes(t)).map(([, why]) => why)
  if (!idle) bad('gitStore 里找不到 commitAreaIdle computed', '提交区收起判据的唯一出处丢了')
  else if (missing.length) {
    bad('commitAreaIdle 判据不完整', `${missing.length} 项缺失：${missing.join('；')}`)
  } else if (leaked.length) {
    bad('commitAreaIdle 吃了在途请求标志', `${leaked.join('；')} —— 静默刷新会让面板抖一下`)
  } else ok('commitAreaIdle 判据完整（干净 + 无待推送 + 已到过一次 + 非合并中 + 非在跑，且不吃在途标志）')

  const appRaw = stripComments(fs.readFileSync(path.join(SRC, 'App.vue'), 'utf8'))
  const appSrc = appRaw.replace(/\s+/g, ' ')
  const commitForm = stripComments(fs.readFileSync(path.join(SRC, 'views/components/CommitForm.vue'), 'utf8')).replace(/\s+/g, ' ')

  // ② 面板级收起
  if (/commit-form-panel[^"']*['"]is-idle['"]:\s*gitStore\.commitAreaIdle|is-idle['"]:\s*gitStore\.commitAreaIdle/.test(appSrc)) {
    ok('App.vue 的 .commit-form-panel 绑定了 is-idle ← gitStore.commitAreaIdle')
  } else {
    bad('面板没有绑定收起态', "应为 :class=\"{ 'is-idle': gitStore.commitAreaIdle }\"")
  }
  // 注意：这段要从**未压平**的文本里取（压平后换行没了，`\n}` 永远匹配不上 →
  // 规则体取到空串，两条断言会假红）
  const idleRule = (appRaw.match(/\.commit-form-panel:not\(\.commit-form-panel--empty\)\s*\{([\s\S]*?)\n\}/) || [])[1] || ''
  if (/grid-template-rows:\s*0fr/.test(idleRule)) ok('收起态走 grid-template-rows: 0fr（可过渡、可测）')
  else bad('收起态写法不对', '应为 grid-template-rows: 0fr；display: none 既没有过渡也不好量')
  if (/display:\s*none/.test(idleRule)) bad('收起态用了 display: none', '过渡与"量高度"都会失效')
  else ok('收起态没有用 display: none')
  if (/min-height:\s*0/.test(idleRule)) ok('子项 min-height: 0（否则自动最小尺寸会把 0 行顶回去）')
  else bad('缺 min-height: 0', 'grid 子项的 min-height:auto 会撑住 0 行，收起量不出 0')

  // ⑤ 过渡只在"展开"方向（2026-10-06）：收起瞬时，否则首屏/切回页面时提交历史会滑一下。
  //    过渡属性取自变化后的样式，所以"只关收起"= 在 .is-idle 里写 transition: none。
  if (/transition:\s*none/.test(idleRule)) ok('收起态关闭过渡（.is-idle 里 transition: none）')
  else bad('收起态还带过渡', '收起只由后台状态落定触发，做过渡 = 提交历史白滑一下（用户 2026-10-06 反馈）')
  if (/transition:\s*grid-template-rows/.test(idleRule)) ok('展开方向保留过渡（工作区出现变更时提交框滑出来）')
  else bad('展开方向没有过渡', '应为 transition: grid-template-rows 0.28s …（写在外层规则上）')

  // ③ 两个常驻入口在顶栏、且不在提交区里重复
  const headerHas = (name) => new RegExp(`<${name}[\\s/>]`).test(appSrc)
  const bothInHeader = headerHas('CommandHistory') && headerHas('GitOperationsButton')
  if (bothInHeader) ok('顶栏常驻了「命令历史 + Git 操作」（整块收起的前提）')
  else bad('顶栏缺了常驻入口', 'CommandHistory / GitOperationsButton 必须渲染在 App.vue 顶栏，否则干净工作区里没有 pull/fetch 入口')
  const cfDup = /<CommandHistory[\s/>]|<GitOperationsButton[\s/>]/.test(commitForm)
  if (cfDup) bad('提交区里还留着一份入口', '搬走后不许留重复的一份（会两头都能点、也说明没搬干净）')
  else ok('提交区里没有重复的入口')

  // ④ 主题按钮：门控隐藏、代码保留
  if (/const SHOW_THEME_TOGGLE = false/.test(appSrc)) ok('主题切换按钮被常量门控为"先不显示"')
  else bad('主题按钮没有被门控', '应为 const SHOW_THEME_TOGGLE = false（保留恢复路径，别直接删按钮）')
  if (/v-if="SHOW_THEME_TOGGLE"/.test(appSrc) && /theme-toggle-btn/.test(appSrc)) {
    ok('主题按钮代码保留（改一个常量即可恢复）')
  } else {
    bad('主题按钮被删而不是被隐藏', '用户说的是"先不显示"，代码要留着')
  }
}

// A16 顶栏目录胶囊：静止态不画边界，边界交给 hover（2026-10-06 用户提）
//     用户原话：「header 中间这块默认不用显示 border 了」。
//     ⚠️ 这条**推翻**了组件里原有的一段论证（"去掉底色后那圈 light 边是唯一的边界，
//     再删就散架了"）—— 实测那圈边在 #fcfdfe 的顶栏底上是 #f4f5f6 的实线，放大看很显眼。
//     所以必须用断言钉住，否则下个读旧注释的人会把它加回来。
//     写法细节：静止态用 `1px solid transparent` 占位而不是 `border: none` ——
//     hover 只改颜色就能显形，且前后零布局跳动。
{
  const raw = stripComments(fs.readFileSync(path.join(SRC, 'components/DirectorySelector.vue'), 'utf8'))
  const body = (sel) => (raw.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([\\s\\S]*?)\\n\\}')) || [])[1] || ''
  const base = body('.directory-selector--header')
  const hov = body('.directory-selector--header:hover')
  if (/border:\s*1px solid transparent/.test(base)) ok('目录胶囊静止态无可见边界（1px transparent 占位）')
  else bad('目录胶囊静止态还在画边界', '应为 border: 1px solid transparent（不是 --border-color-light，也不是 border: none）')
  if (/border:\s*none/.test(base)) bad('静止态用了 border: none', '会少 1px 占位 → hover 长边界时整条胶囊宽度跳动')
  else ok('静止态保留 1px 占位（hover 显形不跳动）')
  if (/border-color:\s*var\(--border-color\)/.test(hov)) ok('hover 才让边界显形（border-color: var(--border-color)）')
  else bad('hover 没有让边界显形', '静止态已删边，hover 必须补回来，否则胶囊永远没有边界')
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
        /* 16 → 18（2026-10-06）：**又一个随状态浮动的量**，跟背景色同一个毛病。
           它统计的是"同屏出现多少种 paddingTop/marginTop/gap 取值"，而左栏文件行的
           操作按钮（`.file-action-btn`）只在**工作区有变更**时才渲染，它们带
           `padding-top: 7px` —— 干净工作区那一屏里压根没有这个值。
           实测：干净 16 种 / 有未提交改动 17 种（7px 全部来自 .file-action-btn，逐元素点过名）。
           所以红线按"观测上限 + 1"定在 18，别再贴着定（贴 17 会随机变红，本仓库最烦假红）。
           想真收敛：要么给这条也加"排除某个容器"的定语并说清理由，要么去别处找刻度外的值。 */
        limit: 18,
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
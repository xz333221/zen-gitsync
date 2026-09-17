#!/usr/bin/env node
/**
 * i18n key 体检。
 *
 * 为什么需要它：`src/ui/client/src/lang/{zh,en}/index.js` 是**手工维护**的（没有生成脚本），
 * key 写错一个字不会报任何错 —— 界面只会把 key 原样显示出来（例如 `@WORKBENCH:单个任务最多 9 个附件`）。
 * 这类问题肉眼极难发现，因为要同时对比 2000+ 个 key 和散落在 180+ 个文件里的引用点。
 *
 * 检查三件事：
 *   1. 源码用到的 key，zh / en 是否都定义了          —— 漏一个就会在界面上露出原始 key
 *   2. zh 与 en 是否对称（一方多出一方缺失）          —— 通常是改名只改了一半
 *   3. `--orphans`：定义了但源码零引用的 key，并用 git HEAD 区分
 *      "本次改动把它孤立了"（要处理）和"历史遗留"（与本轮无关）
 *
 * 用法：
 *   node scripts/verify-i18n-keys.mjs                  # 全量检查
 *   node scripts/verify-i18n-keys.mjs --orphans        # 附带零引用分析
 *   node scripts/verify-i18n-keys.mjs --ns @WORKBENCH  # 只关注某个命名空间
 *   node scripts/verify-i18n-keys.mjs --quiet          # 只在有问题时输出
 *
 * 退出码：0 = 无问题，1 = 有缺失/不对称，2 = 用法或环境错误。
 *
 * ── 两个已知的解析陷阱（都是实测踩过的坑，改动时别退回去）─────────────────
 * 1. **key 里可能含 ASCII 双引号**：如 `@WORKBENCH:点"确定"将重置…`。
 *    用 `[^'"]+` 之类的字符组会在引号处截断，把 key 截成 `@WORKBENCH:点`，
 *    于是报出一个根本不存在的"缺失"。这里按**引号种类**分别匹配，捕获到同类引号为止。
 * 2. **引用点未必是 `$t()`**：还有 `labelKey: '@WORKBENCH:待处理'` 这类数据驱动写法，
 *    只匹配 `$t(` 会把它们误判成"零引用"。所以引用提取要额外覆盖 `labelKey`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = 'src/ui/client/src'
const LANG = {
  zh: `${ROOT}/lang/zh/index.js`,
  en: `${ROOT}/lang/en/index.js`
}

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const argVal = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : '' }
const SHOW_ORPHANS = has('--orphans')
const QUIET = has('--quiet')
const NS = argVal('--ns')

for (const f of Object.values(LANG)) {
  if (!fs.existsSync(f)) { console.error(`找不到语言文件: ${f}`); process.exit(2) }
}

// ── 提取：语言文件里定义的 key ────────────────────────────────────────────────
// 兼容单/双引号两种 key 字面量；同一文件内重复定义会被去重（重复键本身是另一类噪音）
function extractDefined(file) {
  const src = fs.readFileSync(file, 'utf8')
  const set = new Set()
  for (const m of src.matchAll(/^\s*'(@[A-Z0-9_]+:[^'\n]*)'\s*:/gm)) set.add(m[1])
  for (const m of src.matchAll(/^\s*"(@[A-Z0-9_]+:[^"\n]*)"\s*:/gm)) set.add(m[1])
  return set
}

// ── 提取：源码里引用的 key ────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...walk(p))
    else if (/\.(vue|ts|js)$/.test(e.name) && !p.includes('/lang/')) out.push(p)
  }
  return out
}

const REF_PATTERNS = [
  /\$?t\(\s*'(@[A-Z0-9_]+:[^'\n]*)'/g, // $t('@NS:key')
  /\$?t\(\s*"(@[A-Z0-9_]+:[^"\n]*)"/g, // $t("@NS:key")
  /labelKey:\s*'(@[A-Z0-9_]+:[^'\n]*)'/g // labelKey: '@NS:key'（数据驱动的标签）
]

function extractUsed(files) {
  const used = new Map() // key -> Set(相对文件路径)
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    for (const re of REF_PATTERNS) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(src))) {
        const k = m[1]
        if (!used.has(k)) used.set(k, new Set())
        used.get(k).add(path.relative('src/ui/client', f).replace(/\\/g, '/'))
      }
    }
  }
  return used
}

// ── 分析 ────────────────────────────────────────────────────────────────────
const defined = { zh: extractDefined(LANG.zh), en: extractDefined(LANG.en) }
const used = extractUsed(walk(ROOT))
const inNs = (k) => !NS || k.startsWith(NS)

const usedKeys = [...used.keys()].filter(inNs).sort()
const missing = {
  zh: usedKeys.filter(k => !defined.zh.has(k)),
  en: usedKeys.filter(k => !defined.en.has(k))
}
const zhOnly = [...defined.zh].filter(k => inNs(k) && !defined.en.has(k)).sort()
const enOnly = [...defined.en].filter(k => inNs(k) && !defined.zh.has(k)).sort()

// ── 零引用分析（可选）───────────────────────────────────────────────────────
function headHasRef(key) {
  try {
    const out = execFileSync('git', ['grep', '-l', '--fixed-strings', key, 'HEAD', '--', ROOT], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 24
    })
    return out.split('\n').filter(Boolean).filter(l => !l.includes('/lang/')).length > 0
  } catch { return false }
}

// ── 输出 ────────────────────────────────────────────────────────────────────
const out = []
const say = (s = '') => { out.push(s); if (!QUIET) console.log(s) }

say(`语言文件   zh ${defined.zh.size} 条 / en ${defined.en.size} 条${NS ? `   （命名空间 ${NS}）` : ''}`)
say(`源码引用   ${usedKeys.length} 个 key，分布在 ${walk(ROOT).length} 个文件`)

say('\n【1】源码用到但未定义（界面会露出原始 key）')
for (const lang of ['zh', 'en']) {
  if (!missing[lang].length) { say(`  ${lang}: 无`); continue }
  for (const k of missing[lang]) say(`  ${lang} 缺失  ${k}\n              <- ${[...used.get(k)].join(', ')}`)
}

say('\n【2】中英不对称（改名只改了一半）')
if (!zhOnly.length) say('  zh 独有: 无')
else for (const k of zhOnly) say(`  zh 独有  ${k}`)
if (!enOnly.length) say('  en 独有: 无')
else for (const k of enOnly) say(`  en 独有  ${k}`)

if (SHOW_ORPHANS) {
  const allSrc = walk(ROOT).map(f => fs.readFileSync(f, 'utf8')).join('\n')
  const zeroRef = [...defined.zh].filter(k => inNs(k) && !allSrc.includes(k))
  const orphaned = []
  const legacy = []
  for (const k of zeroRef) (headHasRef(k) ? orphaned : legacy).push(k)
  say(`\n【3】定义但源码零引用（共 ${zeroRef.length} 个）`)
  say(`  本次改动孤立（HEAD 有引用、现在没有 → 需要处理）: ${orphaned.length}`)
  for (const k of orphaned) say(`    ! ${k}`)
  say(`  历史遗留（HEAD 也没有引用 → 与本轮无关）: ${legacy.length}`)
  for (const k of legacy) say(`    · ${k}`)
}

const problems = missing.zh.length + missing.en.length + zhOnly.length + enOnly.length
console.log(problems
  ? `\n==> 发现 ${problems} 处问题（缺失 ${missing.zh.length + missing.en.length} / 不对称 ${zhOnly.length + enOnly.length}）`
  : '\n==> i18n key 全部就绪')
process.exit(problems ? 1 : 0)

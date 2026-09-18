// 项目条目清理工具 —— 把"目录已经不存在"的失效条目从配置里摘掉。
//
// 为什么需要它:项目配置(锁定文件/默认提交信息/画布 flowData)会随目录改名或删除
// 变成孤儿。写路径**刻意不做删除**(见 src/configSplit.js 的注释),所以清理只能显式做。
//
// 用法(默认只报告,不动任何数据):
//   node scripts/prune-stale-projects.mjs
//   node scripts/prune-stale-projects.mjs --apply
//   node scripts/prune-stale-projects.mjs --apply --only "d:\workspace\aiforce\aiforcepackages-vue3"
//   node scripts/prune-stale-projects.mjs --apply --exclude "c:\users\xuze3"
//   node scripts/prune-stale-projects.mjs --apply --only "<目录存在的条目>"   # 需显式 --only，或再加 --force-existing
//
// ⚠️ dry-run 并非"零副作用":读配置走 config.js,如果分文件存储还没激活,
//    这一步会顺带完成**一次性拆分迁移**(幂等 + 有 _migration-backup-split-* 备份)。
//    它不会删除任何项目条目 —— 那是 --apply 才做的事。
//
// 安全约束:
//   · 默认 dry-run；不加 --apply 绝不删条目。
//   · --apply 前把 config.json + projects/ + orchestration/ 整份复制进
//     _migration-backup-prune-<ts>/,备份失败就中止。
//   · 只删「目录不存在」的条目。目录存在的条目(如 home 目录、盘根)一律只提示,
//     要删必须用 --only 逐个点名,不能靠通配。
//   · 每个条目单独删,失败不影响其余;最后重新读一遍校验结果。
import { promises as fs } from 'node:fs'
import path from 'node:path'
import fsSync from 'node:fs'
import os from 'node:os'
import config from '../src/config.js'
import { DATA_DIR, CONFIG_FILE, PROJECTS_DIR, ORCHESTRATION_DIR } from '../src/paths.js'

const argv = process.argv.slice(2)
const flag = name => argv.includes(`--${name}`)
const values = name => {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[i + 1])
  }
  return out
}

const APPLY = flag('apply')
const FORCE_EXISTING = flag('force-existing')
const ONLY = values('only').map(p => p.toLowerCase())
const EXCLUDE = new Set(values('exclude').map(p => p.toLowerCase()))

const bytes = v => Buffer.byteLength(JSON.stringify(v) ?? 'null')
const kb = n => `${(n / 1024).toFixed(1)}KB`

function dirExists(p) {
  try { return fsSync.statSync(p).isDirectory() } catch { return false }
}

/** 目录不存在，但看起来就是「路径本身丢了」—— 这些是安全可清的目标 */
function isVanished(p) {
  return !dirExists(p)
}

/** 目录存在但明显不该当项目：home 目录、盘根、以及作为其它项目的上级目录 */
function suspicion(p) {
  const norm = p.toLowerCase().replace(/\/+$/, '')
  if (norm === os.homedir().toLowerCase().replace(/\/+$/, '')) return 'home 目录'
  if (/^[a-z]:$/.test(norm)) return '盘根目录'
  return ''
}

async function copyTree(src, dest) {
  const st = await fs.stat(src).catch(() => null)
  if (!st) return
  if (st.isDirectory()) {
    await fs.mkdir(dest, { recursive: true })
    for (const name of await fs.readdir(src)) {
      await copyTree(path.join(src, name), path.join(dest, name))
    }
  } else {
    await fs.copyFile(src, dest)
  }
}

async function backup() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
  const dir = path.join(DATA_DIR, `_migration-backup-prune-${stamp}`)
  await fs.mkdir(dir, { recursive: true })
  await copyTree(CONFIG_FILE, path.join(dir, path.basename(CONFIG_FILE)))
  await copyTree(PROJECTS_DIR, path.join(dir, 'projects'))
  await copyTree(ORCHESTRATION_DIR, path.join(dir, 'orchestration'))
  return dir
}

// ── 读配置(这一步会顺带触发一次性分文件迁移，幂等) ────────────────────────
const raw = await config.readRawConfigFile()
const projects = raw.projects || {}
const keys = Object.keys(projects)

const vanished = []
const suspicious = []
for (const key of keys) {
  if (EXCLUDE.has(key.toLowerCase())) continue
  if (isVanished(key)) vanished.push(key)
  else if (suspicion(key)) suspicious.push(key)
}

console.log(`数据目录: ${DATA_DIR}`)
console.log(`项目条目: ${keys.length} 个 | 目录已消失: ${vanished.length} 个 | 目录存在但可疑: ${suspicious.length} 个`)
console.log(`模式: ${APPLY ? '** APPLY (会写盘) **' : 'DRY-RUN(只报告)'}`)
console.log()

const totalBytes = vanished.reduce((s, k) => s + bytes(projects[k]), 0)
for (const key of vanished) {
  const pr = projects[key] || {}
  const orch = pr.orchestrations || {}
  const names = Object.keys(orch).map(id => orch[id]?.name || id)
  console.log(`  [失效] ${key}`)
  console.log(`         ${bytes(pr)}B(~${kb(bytes(pr))}) 画布 ${names.length} 个 锁定文件 ${(pr.lockedFiles || []).length} 个`)
  if (names.length) console.log(`         画布: ${names.join(' / ')}`)
}
console.log(`\n失效条目合计 ${bytes({ ok: vanished.map(k => projects[k]) })}B`)

if (suspicious.length) {
  console.log('\n以下条目目录存在、但看起来不像正常项目(默认不动):')
  for (const key of suspicious) {
    console.log(`  [可疑] ${key}  (${suspicion(key)}, ${bytes(projects[key])}B)`)
  }
}
console.log(`\n注意: --only 可点名删除上面任意条目(包括"可疑"的),单条删除需 ${FORCE_EXISTING ? '（已给 --force-existing）' : '显式指定'}。`)

// ── 决定删除集合 ──────────────────────────────────────────────────────────
const targets = ONLY.length
  ? ONLY.filter(k => k in projects)
  : vanished

const missingFromConfig = ONLY.filter(k => !(k in projects))
if (missingFromConfig.length) {
  console.log(`\n⚠️ --only 里有 ${missingFromConfig.length} 个路径不在配置中(忽略): ${missingFromConfig.join('; ')}`)
}

for (const key of targets) {
  if (!isVanished(key) && !FORCE_EXISTING && !ONLY.length) {
    console.log(`\n⚠️ 跳过 ${key}:目录仍存在,拒绝自动删除(用 --only 点名或加 --force-existing)`)
  }
}

const effective = targets.filter(k => isVanished(k) || ONLY.includes(k.toLowerCase()))
if (!effective.length) {
  console.log('\n没有需要删除的条目。')
  process.exit(0)
}

console.log(`\n待删除 ${effective.length} 个条目:`)
effective.forEach(k => console.log(`  · ${k}`))

if (!APPLY) {
  console.log('\nDRY-RUN 结束。确认无误后重跑并加 --apply。')
  process.exit(0)
}

// ── APPLY ────────────────────────────────────────────────────────────────
let backupDir
try {
  backupDir = await backup()
  console.log(`\n已备份到 ${path.relative(DATA_DIR, backupDir)}/`)
} catch (err) {
  console.error(`\n✗ 备份失败(${err?.code || err?.message}),已中止,未删除任何条目。`)
  process.exit(1)
}

let okCount = 0
const failures = []
for (const key of effective) {
  try {
    const res = await config.deleteProjectConfig(key)
    if (res?.errors?.length) {
      failures.push(`${key}: ${res.errors.join('; ')}`)
    } else {
      okCount++
      console.log(`  ✓ 已删除 ${key} ${res?.removed?.length ? `(${res.removed.length} 个文件)` : '(无分文件,仅从索引移除)'}`)
    }
  } catch (err) {
    failures.push(`${key}: ${err?.code || err?.message}`)
  }
}

// 重新读一遍(强制走实盘)校验
const after = await config.readRawConfigFile()
const afterKeys = Object.keys(after.projects || {})
const stillThere = effective.filter(k => afterKeys.includes(k))

console.log('\n──────── 结果 ────────')
console.log(`删除成功 ${okCount} / ${effective.length};条目数 ${keys.length} → ${afterKeys.length}`)
if (stillThere.length) console.log(`⚠️ 仍存在(未生效): ${stillThere.join('; ')}`)
if (failures.length) {
  console.log(`失败 ${failures.length} 条:`)
  failures.forEach(f => console.log(`  ✗ ${f}`))
}
console.log(`备份保留在: ${backupDir}(确认无误后可删)`)
process.exit(failures.length || stillThere.length ? 1 : 0)

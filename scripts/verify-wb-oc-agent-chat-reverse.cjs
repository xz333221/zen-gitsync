/**
 * 反证：把「对话/指令」双模式的两条机制临时改坏，确认探针里的对应断言**真的会红**。
 *
 *   机制 A  .oc__compose 的 v-show 改成 v-if
 *           → 期望 C5c / C5d 变红（"切模式不丢草稿"这条正是靠 v-show 守的）
 *   机制 B  setMode() 不再写 localStorage
 *           → 期望 C2b / C6b / C7a / C7b 变红（"偏好落盘 + reload 后仍生效"那四条）
 *
 * 其余断言应当**一条都不动** —— 有预期外的红灯说明存在没意识到的耦合，要查。
 *
 * ⚠️ MUST_FAIL 里的编号与主探针的用例编号一一对应。主探针改编号/改默认模式时，
 *    这里必须同步（默认模式已从 chat 改成 command，见 6991f84c / f9a08dba）。
 *
 * 还原写在 finally 里，并且不做 git checkout（工作区里 OrchestratorConsole.vue
 * 本身还是未提交的新功能，checkout 会把功能一起清掉）—— 用整文件备份还原。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const TARGET = path.join(ROOT, 'src/ui/client/src/views/components/OrchestratorConsole.vue')
const PROBE = path.join(ROOT, 'scripts/verify-wb-oc-agent-chat.cjs')

const MUTANTS = [
  {
    name: 'A: .oc__compose 的 v-show → v-if',
    from: 'v-show="!collapsed && mode === \'command\'"\n      class="oc__compose"',
    to: 'v-if="!collapsed && mode === \'command\'"\n      class="oc__compose"',
  },
  {
    name: 'B: setMode() 不写 localStorage',
    from: 'localStorage.setItem(MODE_KEY, next)',
    to: 'void next /* 反证：不落盘 */',
  },
]
const MUST_FAIL = ['C2b', 'C5c', 'C5d', 'C6b', 'C7a', 'C7b']

/** 跑探针，收集 FAIL 的断言编号 */
function runProbe() {
  const r = spawnSync(process.execPath, [PROBE], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const out = (r.stdout || '') + (r.stderr || '')
  const failed = []
  const lines = out.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*FAIL\s+(\S+)/.exec(lines[i])
    if (m) {
      // 断言名形如 "C4d 但输入框仍在 DOM 里…"；脚本崩溃那条叫「脚本未抛异常」
      failed.push(/^[A-Z]\d/.test(m[1]) ? m[1].match(/^[A-Z]\d+[a-z]?/)[0] : m[1])
    }
  }
  return { failed, tail: lines.slice(-25).join('\n'), code: r.status }
}

console.log('反证前置：跑一遍改坏**之前**的探针，期望全绿')
const baseline = runProbe()
console.log(`  基线失败数 = ${baseline.failed.length} ${baseline.failed.length ? JSON.stringify(baseline.failed) : ''}`)
if (baseline.failed.length) {
  console.error('  基线就不是全绿 —— 反证没有意义，先修探针/产品，退出')
  console.error(baseline.tail)
  process.exit(2)
}

const original = fs.readFileSync(TARGET, 'utf8')
let ok = true
try {
  // ── 打补丁 ──
  let patched = original
  for (const mu of MUTANTS) {
    if (!patched.includes(mu.from)) throw new Error(`补丁目标没找到：${mu.name}\n  ${JSON.stringify(mu.from)}`)
    patched = patched.replace(mu.from, mu.to)
  }
  fs.writeFileSync(TARGET, patched)
  console.log(`\n已改坏 ${MUTANTS.length} 条机制，等 HMR 重编译…`)
  const wait = spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},3500)'])
  void wait

  const mutated = runProbe()
  const missing = MUST_FAIL.filter(n => !mutated.failed.includes(n))
  const extra = mutated.failed.filter(n => !MUST_FAIL.includes(n))
  console.log(`  改坏后失败数 = ${mutated.failed.length} :: ${JSON.stringify(mutated.failed)}`)
  console.log(`  期望失败 ${MUST_FAIL.length} 条，实测命中 ${MUST_FAIL.length - missing.length} 条`)
  if (missing.length) console.log(`  ❌ 该红却没红：${JSON.stringify(missing)}`)
  if (extra.length) console.log(`  ⚠️  预期外变红（查耦合）：${JSON.stringify(extra)}`)
  ok = missing.length === 0 && extra.length === 0
} catch (err) {
  console.error('反证过程出错：', err.message)
  ok = false
} finally {
  fs.writeFileSync(TARGET, original)   // 无条件还原
  console.log('\n已还原源文件，再跑一遍确认恢复全绿…')
  const restored = runProbe()
  const spotless = restored.failed.length === 0
  console.log(`  还原后失败数 = ${restored.failed.length} ${spotless ? '' : JSON.stringify(restored.failed)}`)
  if (!spotless) console.error(restored.tail)
  ok = ok && spotless
}

console.log(ok ? '\n反证成立：该红的都红了，且无关断点一条没动' : '\n反证不成立（见上）')
process.exit(ok ? 0 : 1)

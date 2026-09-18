// API 级端到端验证:npm run verify:config-split
//
// 验证"配置分文件存储"(把 config.json 里的 projects 拆成
// projects/<fileId>.json + orchestration/<fileId>/<orchId>.json,见 src/configSplit.js)
// 在**真实 server 启动链路**上生效。单元测试覆盖了存储层,这里覆盖的是
// "真实 server + 真实 605KB 数据 + 真实路由" 这一层。
//
// 覆盖:
//   · 用**真实的 605KB config.json** 当夹具(比造的假数据更能暴露问题:中文、
//     真实画布 flowData、30 个项目)。真实 home 已拆分后,自动退到
//     `_migration-backup-*` 里那份拆分前快照;若连快照都没有,再用合成数据。
//   · config.json 显著瘦身,projects/ 与 orchestration/ 文件数与项目/画布数一致
//   · GET /api/config/getConfig 正常(拆分后读回形状不变)
//   · POST /api/config/save-general-settings(只改全局)→ 项目文件与画布文件
//     **一个字节都不该变** —— 这正是拆分要拿到的收益
//   · POST /api/config/save-orchestration(新增画布)→ 只多出一个画布文件,
//     已有文件全部原样
//
// 隔离:USERPROFILE/HOME 指向 mkdtemp 沙箱,绝不触碰真实 home(真实 config.json
// 只被**只读**复制进沙箱)。
//
// 注意:起真 server 的"起→探活→断言→收尾"必须全在同一条进程中完成 ——
// 后台进程会随父 shell 退出被回收,分两次调用会出现"第二次 curl 拿到空响应"。
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const projectRoot = 'D:/xz_workspace/github_workspace/zen-gitsync'
const realHome = os.homedir()
const realConfig = path.join(realHome, '.zen-gitsync', 'config.json')

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'zgs-config-split-e2e-'))
const dataDir = path.join(sandbox, '.zen-gitsync')
const configFile = path.join(dataDir, 'config.json')
const projectsDir = path.join(dataDir, 'projects')
const orchRoot = path.join(dataDir, 'orchestration')

const failures = []
const notes = []
const check = (ok, msg) => { if (!ok) failures.push(msg) }

const exists = async (p) => { try { await fs.access(p); return true } catch { return false } }

async function listJson(dir) {
  try { return (await fs.readdir(dir)).filter((n) => n.endsWith('.json')).sort() } catch { return [] }
}

/** 目录树的 path → sha1(内容),用于断言"这些文件一个字节都没动" */
async function snapshotTree(root) {
  const out = new Map()
  async function walk(dir) {
    let entries = []
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile()) {
        const buf = await fs.readFile(full)
        out.set(path.relative(root, full).split(path.sep).join('/'), crypto.createHash('sha1').update(buf).digest('hex'))
      }
    }
  }
  await walk(root)
  return out
}

function diffTrees(before, after) {
  const changed = []
  const added = []
  const removed = []
  for (const [k, v] of before) {
    if (!after.has(k)) removed.push(k)
    else if (after.get(k) !== v) changed.push(k)
  }
  for (const k of after.keys()) if (!before.has(k)) added.push(k)
  return { changed, added, removed }
}

// ── 布置沙箱:用真实的数据当夹具 ───────────────────────────────
//
// ⚠️ 夹具必须是「还带内联 projects」的那份 config.json。
// 真实 home 一旦完成拆分(config.json 只剩全局设置),再拿它当夹具,
// fixtureProjectCount 会是 0 → 下面所有"文件数应为 N"的断言都会**空过**,
// 脚本看着 PASS 其实什么都没验(静默腐化)。所以:
//   1) 优先用真实 config.json —— 但要确认它真的还有内联 projects;
//   2) 否则退到 _migration-backup-* 里那份拆分前的完整快照;
//   3) 再不行才用合成数据。
async function pickInlineFixture() {
  const candidates = [realConfig]
  let entries = []
  try {
    entries = await fs.readdir(realHome ? path.join(realHome, '.zen-gitsync') : '.')
  } catch { /* 数据目录不存在,直接走合成数据 */ }
  for (const name of entries.sort().reverse()) {
    if (!name.startsWith('_migration-backup')) continue
    candidates.push(path.join(realHome, '.zen-gitsync', name, 'config.json'))
  }
  // 注意:真实 config.json 现在能正常解析、只是**没有**内联 projects。
  // 不能一读到就返回(那样永远选中它、count=0 → 空过),要么跳过、要么留作兜底。
  let fallback = null
  for (const file of candidates) {
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf-8'))
      const n = Object.keys(raw.projects || {}).length
      if (n > 0) return { file, raw, count: n }
      if (!fallback) fallback = { file, raw, count: n }
    } catch { /* 试下一个 */ }
  }
  return fallback
}

let fixtureSource = 'real'
await fs.mkdir(dataDir, { recursive: true })
const picked = await pickInlineFixture()
if (picked && picked.count > 0) {
  await fs.copyFile(picked.file, configFile)
  if (picked.file !== realConfig) fixtureSource = `备份快照 ${path.basename(path.dirname(picked.file))}`
} else {
  fixtureSource = 'synthetic'
  const projects = {}
  for (let i = 0; i < 30; i++) {
    const key = `d:\\sandbox\\p${i}\\demo-${i}`
    projects[key] = {
      defaultCommitMessage: `项目 ${i} 的提交信息`,
      lockedFiles: [],
      orchestrations: i < 5
        ? [{
            id: `orch_${1700000000000 + i}_${'abcdefghij'[i]}`,
            name: `画布 ${i}`,
            description: '离线夹具',
            flowData: { nodes: Array.from({ length: 40 }, (_, n) => ({ id: `n${n}`, label: `节点 ${n}` })), edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
          }]
        : [],
    }
  }
  await fs.writeFile(configFile, JSON.stringify({
    theme: 'dark', locale: 'zh-CN', models: [], ui: {}, recentDirectories: [], projects,
  }, null, 2), 'utf-8')
}

const fixtureBytes = (await fs.stat(configFile)).size
const fixtureRaw = JSON.parse(await fs.readFile(configFile, 'utf-8'))
const fixtureProjectCount = Object.keys(fixtureRaw.projects || {}).length
const fixtureOrchCount = Object.values(fixtureRaw.projects || {})
  .reduce((s, p) => s + (Array.isArray(p.orchestrations) ? p.orchestrations.length : 0), 0)

// 夹具没有内联 projects 就等于什么都没验 —— 宁可红,也别空过。
if (fixtureProjectCount === 0) {
  console.error('✗ 夹具里没有内联 projects,本次验证没有意义;请提供一个拆分前的 config.json。')
  process.exit(1)
}

console.log(`夹具来源: ${fixtureSource === 'real' ? `真实 ${realConfig}` : fixtureSource === 'synthetic' ? '内置合成数据' : fixtureSource}`)
console.log(`夹具: ${fixtureBytes} 字节 / ${fixtureProjectCount} 个项目 / ${fixtureOrchCount} 条画布`)
console.log(`沙箱: ${sandbox}`)
console.log('')

// ── 起 server(单进程内完成起→探活→断言→收尾) ─────────────────
const PORT = 5601
const base = `http://127.0.0.1:${PORT}`
const env = { ...process.env, PORT: String(PORT), ZEN_PERF: '0', USERPROFILE: sandbox, HOME: sandbox }
delete env.HOMEDRIVE
delete env.HOMEPATH

const child = spawn(process.execPath, ['server.js', '--no-open'], {
  cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
child.stdout.on('data', (d) => { log += d })
child.stderr.on('data', (d) => { log += d })

const post = async (p, body) => {
  const res = await fetch(`${base}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

try {
  let alive = false
  for (let i = 0; i < 200 && !alive; i++) {
    try { alive = (await fetch(`${base}/api/app-version`)).ok } catch { await new Promise((r) => setTimeout(r, 250)) }
  }
  check(alive, `server 未就绪:\n${log.slice(-2000)}`)
  if (!alive) throw new Error('server 起不来')

  // ── 1) 拆分副作用 ────────────────────────────────────────────
  const getConfig = await fetch(`${base}/api/config/getConfig`).then((r) => r.json()).catch(() => null)
  check(getConfig !== null, 'GET /api/config/getConfig 应返回合法 JSON')

  const onDisk = JSON.parse(await fs.readFile(configFile, 'utf-8'))
  check(onDisk.projects === undefined, `config.json 不该再有内联 projects(实际键: ${Object.keys(onDisk).join(', ')})`)
  check(onDisk.theme === fixtureRaw.theme, '全局 theme 应留在 config.json')

  const projectFiles = await listJson(projectsDir)
  check(
    projectFiles.length === fixtureProjectCount,
    `projects/ 文件数应为 ${fixtureProjectCount},实际 ${projectFiles.length}`
  )

  let orchFileCount = 0
  const orchDirs = await fs.readdir(orchRoot).catch(() => [])
  for (const d of orchDirs) orchFileCount += (await listJson(path.join(orchRoot, d))).length
  check(
    orchFileCount === fixtureOrchCount,
    `画布文件数应为 ${fixtureOrchCount},实际 ${orchFileCount}`
  )

  // 每个项目文件都得带 key 与 config,否则组装会漏项
  let badEnvelope = 0
  const keysSeen = new Set()
  for (const name of projectFiles) {
    const envl = JSON.parse(await fs.readFile(path.join(projectsDir, name), 'utf-8'))
    if (typeof envl.key !== 'string' || !envl.config || typeof envl.config !== 'object') badEnvelope++
    else keysSeen.add(envl.key)
  }
  check(badEnvelope === 0, `有 ${badEnvelope} 个项目文件缺少 key/config 信封`)
  check(
    keysSeen.size === fixtureProjectCount,
    `项目文件覆盖的键数应为 ${fixtureProjectCount},实际 ${keysSeen.size}`
  )
  check(
    [...keysSeen].every((k) => k in (fixtureRaw.projects || {})),
    '出现了夹具里没有的项目键 —— 拆分把数据弄脏了'
  )

  // 留档:拆分前那份 605KB 必须原样存着
  const backups = (await fs.readdir(dataDir)).filter((n) => n.startsWith('_migration-backup-split-'))
  check(backups.length === 1, `应有 1 个拆分留档目录,实际 ${backups.length}`)
  if (backups.length) {
    const archivedBytes = (await fs.stat(path.join(dataDir, backups[0], 'config.json'))).size
    check(archivedBytes === fixtureBytes, `留档副本大小应与原文件一致(${archivedBytes} vs ${fixtureBytes})`)
  }

  const afterBytes = (await fs.stat(configFile)).size
  const shrink = (1 - afterBytes / fixtureBytes) * 100
  notes.push(`config.json: ${fixtureBytes} → ${afterBytes} 字节(缩减 ${shrink.toFixed(1)}%)`)

  // ── 2) 只改全局设置:项目/画布文件一个字节都不该动 ─────────────
  const beforeLight = await snapshotTree(projectsDir)
  const beforeOrch = await snapshotTree(orchRoot)
  await new Promise((r) => setTimeout(r, 20))

  // 目标主题必须与当前不同,才验证得了"写进去了"(theme 只接受 light/dark/auto)
  const targetTheme = fixtureRaw.theme === 'light' ? 'dark' : 'light'
  const t0 = Date.now()
  const light = await post('/api/config/save-general-settings', {
    theme: targetTheme,
    locale: fixtureRaw.locale || 'zh-CN',
  })
  const lightMs = Date.now() - t0
  check(light.status === 200 && light.json?.success === true, `save-general-settings 应 200,实际 ${light.status}`)

  const dProjects = diffTrees(beforeLight, await snapshotTree(projectsDir))
  const dOrch = diffTrees(beforeOrch, await snapshotTree(orchRoot))
  check(
    dProjects.changed.length === 0 && dProjects.added.length === 0 && dProjects.removed.length === 0,
    `只改全局设置却动了项目文件: ${JSON.stringify(dProjects)}`
  )
  check(
    dOrch.changed.length === 0 && dOrch.added.length === 0 && dOrch.removed.length === 0,
    `只改全局设置却动了画布文件: ${JSON.stringify(dOrch)}`
  )
  notes.push(`改全局设置耗时 ${lightMs}ms,项目/画布文件改动数 0`)

  // 全局设置确实生效了
  const afterTheme = JSON.parse(await fs.readFile(configFile, 'utf-8')).theme
  check(afterTheme === targetTheme, `全局设置应写进 config.json(期望 ${targetTheme},实际 ${afterTheme})`)

  // ── 3) 新增画布:只多出一个画布文件 ──────────────────────────
  const beforeOrch2 = await snapshotTree(orchRoot)
  await new Promise((r) => setTimeout(r, 20))
  const t1 = Date.now()
  const added = await post('/api/config/save-orchestration', {
    orchestration: {
      name: 'verify-config-split 临时画布',
      description: '端到端验证用',
      flowData: { nodes: [{ id: 'v1', label: '验证节点' }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    },
  })
  const addedMs = Date.now() - t1
  check(added.status === 200 && added.json?.success === true, `save-orchestration 应 200,实际 ${added.status}`)

  const dOrch2 = diffTrees(beforeOrch2, await snapshotTree(orchRoot))
  check(dOrch2.added.length === 1, `新增画布应只多出 1 个文件,实际 ${dOrch2.added.length}: ${dOrch2.added.join(', ')}`)
  check(dOrch2.changed.length === 0, `新增画布不该改动已有画布文件: ${dOrch2.changed.join(', ')}`)
  check(dOrch2.removed.length === 0, `新增画布不该删除任何文件: ${dOrch2.removed.join(', ')}`)
  notes.push(`新增画布耗时 ${addedMs}ms,新增文件数 ${dOrch2.added.length}`)

  // 读回来必须能看见它(否则"保存成功但读不到"= 拆分丢数据)
  const cfgAfter = await fetch(`${base}/api/config/getConfig`).then((r) => r.json()).catch(() => null)
  const names = (cfgAfter?.orchestrations || []).map((o) => o.name)
  check(
    names.includes('verify-config-split 临时画布'),
    `新增的画布应能被读回,实际读到的画布名: ${names.join(', ') || '(空)'}`
  )
  check(
    (cfgAfter?.orchestrations || []).length === (getConfig?.orchestrations || []).length + 1,
    '画布总数应恰好 +1'
  )
} catch (err) {
  failures.push(`异常: ${err?.message || err}`)
} finally {
  // 收尾与自己起进程同一处完成:不依赖外部 kill,也不留监听端口
  try {
    child.kill('SIGTERM')
    const deadline = Date.now() + 8000
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150))
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 300))
  try { await fs.rm(sandbox, { recursive: true, force: true }) } catch { /* ignore */ }
}

if (notes.length) {
  console.log('--- 观测 ---')
  for (const n of notes) console.log('  ' + n)
  console.log('')
}

if (failures.length) {
  console.log(`=== FAIL: ${failures.length} 项未通过 ===`)
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('=== PASS: 分文件存储在真实 server 链路上生效,写入放大已消除 ===')

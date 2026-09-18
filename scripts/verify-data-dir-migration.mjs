// API 级端到端验证:npm run verify:data-dir-migration
//
// 验证"数据目录收敛迁移"(把散在主目录的历史文件收进 ~/.zen-gitsync/,见 src/paths.js
// + src/dataDirMigration.js)在**真实 server 启动链路**上生效。覆盖:
//   · 旧主配置被读取并搬到新路径(内容完整)
//   · 旧心跳目录逐 entry 合并进 instances/
//   · 历史脏状态清理:被误建成目录的 .zen-gitsync-instances.json、*.json.tmp 残渣
//   · server 自身心跳落在新目录;GET /api/instances、/api/config/getConfig 正常
//
// 隔离:USERPROFILE/HOME 指向 mkdtemp 沙箱,绝不触碰真实 home。
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const projectRoot = 'D:/xz_workspace/github_workspace/zen-gitsync'
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'zgs-mig-e2e-'))
const PORT = 5598
const base = `http://127.0.0.1:${PORT}`

const legacyConfig = path.join(sandbox, '.git-commit-tool.json')
const legacyInstancesDir = path.join(sandbox, '.zen-gitsync-instances')
const legacyInstancesFileAsDir = path.join(sandbox, '.zen-gitsync-instances.json')
const strayTmp = path.join(sandbox, '.zen-gitsync-instances.json.tmp')
const dataDir = path.join(sandbox, '.zen-gitsync')
const newConfig = path.join(dataDir, 'config.json')

const failures = []
const check = (ok, msg) => { if (!ok) failures.push(msg) }

// 1) 布置"历史遗留现场"
await fs.writeFile(legacyConfig, JSON.stringify({ theme: 'dark', locale: 'zh-CN', projects: {} }, null, 2), 'utf-8')
await fs.mkdir(legacyInstancesDir, { recursive: true })
await fs.writeFile(path.join(legacyInstancesDir, '99999.json'), JSON.stringify({ pid: 99999, port: 1, lastHeartbeat: Date.now() }), 'utf-8')
await fs.writeFile(path.join(legacyInstancesDir, '12345.json.tmp'), '{"pid":12345', 'utf-8')
await fs.mkdir(legacyInstancesFileAsDir, { recursive: true })
await fs.writeFile(strayTmp, '{"instances":{}}', 'utf-8')

const env = { ...process.env, PORT: String(PORT), ZEN_PERF: '0', USERPROFILE: sandbox, HOME: sandbox }
delete env.HOMEDRIVE
delete env.HOMEPATH

const child = spawn(process.execPath, ['server.js', '--no-open'], { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
child.stdout.on('data', d => { log += d })
child.stderr.on('data', d => { log += d })

const exists = async p => { try { await fs.access(p); return true } catch { return false } }

try {
  let alive = false
  for (let i = 0; i < 160 && !alive; i++) {
    try { alive = (await fetch(`${base}/api/app-version`)).ok } catch { await new Promise(r => setTimeout(r, 250)) }
  }
  check(alive, `server 未就绪:\n${log.slice(-3000)}`)
  if (!alive) {
    console.log('=== server 日志(尾 3000 字符) ===')
    console.log(log.slice(-3000))
    throw new Error('server 起不来')
  }

  // 2) 迁移副作用断言
  check(await exists(newConfig), '主配置应已搬到 ~/.zen-gitsync/config.json')
  check(!(await exists(legacyConfig)), '旧主配置文件应已不在')
  const cfg = JSON.parse(await fs.readFile(newConfig, 'utf-8'))
  check(cfg.theme === 'dark', `迁移后内容应完整(theme=${cfg.theme})`)

  check(await exists(path.join(dataDir, 'instances', '99999.json')), '旧心跳 entry 应合并进 instances/')
  check(!(await exists(legacyInstancesDir)), '旧心跳目录应被收走')
  check(!(await exists(legacyInstancesFileAsDir)), '被误建成的空目录应被清理')
  check(!(await exists(strayTmp)), '旧 tmp 残渣应被清理')
  check(await exists(path.join(dataDir, '_legacy-cleanup')), '清理物应留档到 _legacy-cleanup/')
  check(await exists(path.join(dataDir, '.layout-migrated')), '应写入迁移标记')

  // server 自身的心跳必须落在新目录里
  const entries = await fs.readdir(path.join(dataDir, 'instances'))
  check(entries.includes(`${child.pid}.json`), `server 自己的心跳应在 instances/ 里,实际: ${entries.join(',')}`)

  // 3) API 断言:实例列表可用(它读的就是新 registry 路径)
  const res = await fetch(`${base}/api/instances`)
  const json = await res.json().catch(() => null)
  check(res.status === 200, `/api/instances 返回 ${res.status}`)
  const list = json?.instances || json?.data || []
  check(Array.isArray(list) && list.length >= 1, `实例列表应至少有自己,实际: ${JSON.stringify(json).slice(0, 200)}`)

  // 4) 配置读取端点
  const cfgRes = await fetch(`${base}/api/config/getConfig`)
  check(cfgRes.status === 200, `/api/config/getConfig 返回 ${cfgRes.status}`)

  console.log(`沙箱: ${sandbox}`)
  console.log(`instances/ 内容: ${entries.join(', ')}`)
  console.log(`_legacy-cleanup/ 内容: ${(await fs.readdir(path.join(dataDir, '_legacy-cleanup'))).join(', ')}`)
  console.log(`/api/instances 条目数: ${list.length}`)
  console.log(`服务端日志含迁移记录: ${/dataDirMigration/.test(log) ? '是' : '否'}`)

  if (failures.length) {
    console.log('\n=== FAIL ===')
    failures.forEach(f => console.log(' - ' + f))
    process.exitCode = 1
  } else {
    console.log('\n=== PASS: 迁移在真实启动链路生效,API 全部正常 ===')
  }
} finally {
  child.kill()
  await new Promise(r => setTimeout(r, 300))
  try { await fs.rm(sandbox, { recursive: true, force: true }) } catch {}
}

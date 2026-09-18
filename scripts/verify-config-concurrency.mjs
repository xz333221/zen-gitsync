// API 级并发验证:npm run verify:config-concurrency
//
// 复现并守住 2026-09-18 那类"配置读写撞车"故障:
//   · 前端轮询 /api/locked-files(→ loadConfig → safeLoadRaw 判缓存新鲜)
//   · 同时另一条请求在写配置(POST /api/lock-file → saveConfig → 失效缓存)
// 断言:无 5xx、无 null 解引用、无"JSON 格式错误"假报错、无原子写降级、无 tmp 残渣。
//
// 隔离:server 进程的 USERPROFILE/HOME 指向 mkdtemp 沙箱,绝不碰用户真实
// ~/.zen-gitsync/(见 src/paths.js)。

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'zgs-conc-e2e-'))
const PORT = 5599
const base = `http://127.0.0.1:${PORT}`

const env = { ...process.env, PORT: String(PORT), ZEN_PERF: '0', USERPROFILE: sandbox, HOME: sandbox }
delete env.HOMEDRIVE
delete env.HOMEPATH

const child = spawn(process.execPath, ['server.js', '--no-open'], {
  cwd: projectRoot,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
child.stdout.on('data', d => { serverLog += d })
child.stderr.on('data', d => { serverLog += d })

async function waitReady(timeoutMs = 40000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${base}/api/app-version`)
      if (r.ok) return true
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

const failures = []
function check(cond, msg) { if (!cond) failures.push(msg) }

try {
  if (!await waitReady()) throw new Error(`server 未就绪:\n${serverLog}`)

  const batches = 8
  const perBatch = 6
  for (let b = 0; b < batches; b++) {
    const reqs = []
    for (let i = 0; i < perBatch; i++) {
      const fp = `C:\\sandbox\\race-${b}-${i}.txt`
      reqs.push(
        fetch(`${base}/api/locked-files`).then(async r => ({ name: 'locked-files', r, body: await r.text() })),
        fetch(`${base}/api/config/getConfig`).then(async r => ({ name: 'getConfig', r, body: await r.text() })),
        fetch(`${base}/api/lock-file`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ filePath: fp }),
        }).then(async r => ({ name: 'lock-file', r, body: await r.text() })),
        fetch(`${base}/api/unlock-file`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ filePath: fp }),
        }).then(async r => ({ name: 'unlock-file', r, body: await r.text() })),
      )
    }
    const results = await Promise.all(reqs)
    for (const { name, r, body } of results) {
      check(r.status === 200, `${name} 返回 ${r.status}: ${body.slice(0, 200)}`)
      check(!/Cannot read properties of null/.test(body), `${name} 出现 null 解引用: ${body.slice(0, 200)}`)
      check(!/JSON格式错误/.test(body), `${name} 报 JSON 格式错误(文件其实合法): ${body.slice(0, 200)}`)
      try {
        const j = JSON.parse(body)
        if (j && j.success === false) failures.push(`${name} success=false: ${j.error}`)
      } catch { /* 非 JSON 响应另行由状态码判断 */ }
    }
  }

  // 沙箱里的配置文件必须仍是合法 JSON,且没有被半写破坏
  // (2026-09-18 起主配置在 ~/.zen-gitsync/config.json,见 src/paths.js)
  const cfgDir = path.join(sandbox, '.zen-gitsync')
  const cfgPath = path.join(cfgDir, 'config.json')
  const raw = await fs.readFile(cfgPath, 'utf-8')
  JSON.parse(raw)

  // 不留 tmp 残渣
  const leaked = (await fs.readdir(cfgDir)).filter(n => n.startsWith('config.json.') && n.endsWith('.tmp'))

  console.log(`请求总数(含并发): ${batches * perBatch * 4}`)
  console.log(`沙箱配置文件可 parse: yes (${raw.length} bytes)`)
  console.log(`残留 tmp: ${leaked.length ? JSON.stringify(leaked) : '无'}`)
  console.log(`服务端日志中的降级/异常: ${/降级|Cannot read properties/.test(serverLog) ? '有' : '无'}`)
  if (leaked.length) failures.push(`残留 tmp 文件: ${JSON.stringify(leaked)}`)
  if (/降级为覆盖写/.test(serverLog)) {
    const lines = serverLog.split(/\r?\n/).filter(l => l.includes('降级为覆盖写'))
    console.log(`降级日志样本(${lines.length} 条):`)
    lines.slice(0, 5).forEach(l => console.log('   ' + l.trim()))
    failures.push('出现原子写降级为覆盖写')
  }

  if (failures.length) {
    console.log('\n=== FAIL ===')
    failures.slice(0, 10).forEach(f => console.log(' - ' + f))
    process.exitCode = 1
  } else {
    console.log('\n=== PASS: 并发读写配置无 5xx / 无 null 解引用 / 无假 JSON 报错 ===')
  }
} finally {
  child.kill()
  await new Promise(r => setTimeout(r, 300))
  try { await fs.rm(sandbox, { recursive: true, force: true }) } catch {}
}

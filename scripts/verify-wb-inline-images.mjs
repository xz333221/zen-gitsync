// API 级验证:npm run verify:wb-inline-images
//
// 守的是「模型在正文里写 `![说明](本机路径)`，用户真的能看到图」这条链路。
// 它横跨三段：后端的图片端点（workbench/jobImage.js + index.js 的路由）→
// 前端的路径重写（utils/localImageSrc.ts）→ 组件库的 markdown 渲染。
// 前两段各有单测，这份脚本补的是**接线与权限边界**：
//   · 端点真的注册了、真的按 Content-Type 吐字节（不是 JSON、不是空响应）；
//   · 越权（`..` / 仓库外绝对路径 / 符号链接）真的被挡在 403；
//   · 非图片后缀 415、不存在 404、缺参数 400 —— 这几种"看起来都像图片问题"的
//     失败必须分得开，否则排查时只能靠猜。
//
// 为什么要单独守权限：这个端点是**唯一一个按用户给的路径读本机文件**的接口，
// 判错一条就等于把整台机器的任意文件开了个读取口（还带 nosniff 之外的 CSP 兜底）。
//
// 隔离：server 进程的 USERPROFILE/HOME 指向 mkdtemp 沙箱，绝不碰用户真实
// ~/.zen-gitsync/（见 src/paths.js 的说明）。任务与执行记录都在沙箱里现造，
// 不需要跑真的 CLI（job 直接写进 jobs.json —— 端点对历史 job 走的就是这条读盘路径）。

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'zgs-inline-img-e2e-'))
const home = sandbox
const dataDir = path.join(home, '.zen-gitsync')
const repo = path.join(sandbox, 'repo')            // 任务所属仓库
const outside = path.join(sandbox, 'outside')      // 仓库**外**的目录（越权用例）

const PORT = 5613
const base = `http://127.0.0.1:${PORT}`
const TASK_ID = 'task-inline-img'
const JOB_ID = 'job-inline-img'

const failures = []
const check = (cond, msg) => { if (!cond) failures.push(msg) }

// 1x1 透明 PNG：用来断言"吐回来的字节与磁盘上那份一致"，不是拿个假文件糊过去
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

// ── 沙箱：仓库 / 仓库外 / 数据目录 ──────────────────────────────────────
await fs.mkdir(path.join(repo, 'docs', 'screenshots'), { recursive: true })
await fs.mkdir(outside, { recursive: true })
await fs.mkdir(dataDir, { recursive: true })
await fs.writeFile(path.join(repo, 'docs', 'screenshots', 'a.png'), PNG)
await fs.writeFile(path.join(repo, 'docs', 'note.txt'), 'not an image')
await fs.writeFile(path.join(outside, 'secret.png'), PNG)

await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
  recentDirectories: [repo],
  projects: [],
  models: [],
}, null, 2))
await fs.writeFile(path.join(dataDir, 'tasks.json'), JSON.stringify({
  tasks: [{
    id: TASK_ID,
    title: '【正文配图验证】',
    desc: '',
    status: 'done',
    type: 'simple',
    projectPath: repo,
    attachments: [],
  }],
}, null, 2))
// 历史 job：端点对不在内存里的 job 走 refreshJobsFromDisk + mergedJobs 这条读盘路径
await fs.writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify({
  version: 1,
  jobs: [{
    id: JOB_ID,
    taskId: TASK_ID,
    subId: `${TASK_ID}__simple`,
    title: '【正文配图验证】',
    status: 'done',
    prompt: '给我看张图',
    output: `![截图](${path.join(repo, 'docs', 'screenshots', 'a.png')})`,
    toolCalls: [],
    startedAt: '2026-09-30T02:00:00.000Z',
    endedAt: '2026-09-30T02:01:00.000Z',
  }],
}, null, 2))

// ⚠️ server.js 会往**仓库根**写 .port 与 src/ui/client/.env.local —— 它的 cwd 就是这里
// （沙箱只换了 USERPROFILE/HOME，换不掉 cwd）。不还原的话 vite 的代理会一直指向
// 5613 这个空端口，之后所有浏览器验证脚本集体 502。
const PORT_FILES = [
  path.join(projectRoot, '.port'),
  path.join(projectRoot, 'src/ui/client/.env.local'),
]
const portFileBackup = []
for (const f of PORT_FILES) {
  try {
    portFileBackup.push({ f, content: await fs.readFile(f, 'utf8') })
  } catch {
    portFileBackup.push({ f, content: null })
  }
}

const env = {
  ...process.env,
  PORT: String(PORT),
  ZEN_PERF: '0',
  USERPROFILE: home,
  HOME: home,
}
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

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitReady(timeoutMs = 40000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${base}/api/app-version`)
      if (r.ok) return true
    } catch { /* not up yet */ }
    await sleep(250)
  }
  return false
}

const imgUrl = (p, jobId = JOB_ID) =>
  `${base}/api/workbench/jobs/${encodeURIComponent(jobId)}/image?path=${encodeURIComponent(p)}`

try {
  if (!await waitReady()) throw new Error(`server 未就绪:\n${serverLog}`)

  // ── 1. 正常路径：仓库内的图（绝对路径） ──
  const abs = path.join(repo, 'docs', 'screenshots', 'a.png')
  const r1 = await fetch(imgUrl(abs))
  check(r1.status === 200, `仓库内的图应 200，实际 ${r1.status}`)
  check(r1.headers.get('content-type') === 'image/png', `Content-Type 应为 image/png，实际 ${r1.headers.get('content-type')}`)
  check(r1.headers.get('x-content-type-options') === 'nosniff', '应带 X-Content-Type-Options: nosniff')
  check(String(r1.headers.get('content-security-policy') || '').includes('sandbox'),
    '应带 CSP sandbox（仓库里的 SVG 可能是 clone 来的，别让它的脚本跑在本应用源上）')
  const bytes = Buffer.from(await r1.arrayBuffer())
  check(bytes.equals(PNG), `吐回来的字节应与磁盘一致（收到 ${bytes.length} 字节）`)

  // ── 2. 模型常写相对路径（它的 cwd 就是仓库根） ──
  const r2 = await fetch(imgUrl('docs/screenshots/a.png'))
  check(r2.status === 200, `相对路径应 200，实际 ${r2.status}`)
  check(Buffer.from(await r2.arrayBuffer()).equals(PNG), '相对路径取到的应是同一张图')

  // ── 3. 越权：`..` 穿越 / 仓库外绝对路径 ──
  const r3 = await fetch(imgUrl('../outside/secret.png'))
  check(r3.status === 403, `\`..\` 穿越应 403，实际 ${r3.status}`)
  const r4 = await fetch(imgUrl(path.join(outside, 'secret.png')))
  check(r4.status === 403, `仓库外的绝对路径应 403，实际 ${r4.status}`)

  // ── 4. 符号链接绕出仓库也要挡（lexical 判定挡不住它，靠 realpath 那一步） ──
  const linkPath = path.join(repo, 'docs', 'link.png')
  let linkMade = false
  try {
    await fs.symlink(path.join(outside, 'secret.png'), linkPath)
    linkMade = true
  } catch { /* Windows 非管理员建不了软链：这条按平台跳过，不算失败 */ }
  if (linkMade) {
    const r5 = await fetch(imgUrl(linkPath))
    check(r5.status === 403, `指向仓库外的符号链接应 403，实际 ${r5.status}`)
  }

  // ── 5. 各种失败要分得开（都是 4xx，但原因不同） ──
  const cases = [
    ['docs/note.txt', 415, '非图片后缀'],
    ['docs/missing.png', 404, '图片不存在'],
    ['', 400, 'path 缺参'],
    ['../outside/../..', 415, '既越权又没后缀（先判后缀，两种拒绝都算正常）'],
  ]
  for (const [p, want, label] of cases) {
    const r = await fetch(imgUrl(p))
    check(r.status === want, `${label} 应 ${want}，实际 ${r.status}（path=${JSON.stringify(p)}）`)
  }
  const rBadJob = await fetch(imgUrl(abs, 'no-such-job'))
  check(rBadJob.status === 404, `未知 job 应 404，实际 ${rBadJob.status}`)

  // ── 6. 前端重写的那段没被后端"顺手改坏"：端点认的就是前端拼出来的那个 URL ──
  // 前端拼法见 utils/localImageSrc.ts（jobImageUrl）：id 与 path 都 encodeURIComponent。
  // 这条守的是"两边对同一个 URL 的理解一致" —— 后端要是自己又 decode 一次、或对
  // 反斜杠另有一套规整，前端算出来的地址就会 404（而且只有真跑起来才看得见）。
  const frontendUrl = `${base}/api/workbench/jobs/${encodeURIComponent(JOB_ID)}/image?path=${encodeURIComponent(abs)}`
  const r6 = await fetch(frontendUrl)
  check(r6.status === 200, `前端拼出来的 URL 应能取到图，实际 ${r6.status}`)
  check(Buffer.from(await r6.arrayBuffer()).equals(PNG), '前端 URL 取到的应是同一张图')
} catch (err) {
  failures.push(`异常: ${err.message}`)
} finally {
  try { child.kill() } catch { /* ignore */ }
  await sleep(300)
  try { await fs.rm(sandbox, { recursive: true, force: true }) } catch { /* ignore */ }
  for (const { f, content } of portFileBackup) {
    try {
      if (content === null) await fs.rm(f, { force: true })
      else await fs.writeFile(f, content)
    } catch { /* 还原失败不该盖住断言结果 */ }
  }
}

if (failures.length) {
  console.error('\n[workbench-inline-images e2e] 失败:')
  failures.forEach(f => console.error('  ✗ ' + f))
  process.exit(1)
}
console.log('[workbench-inline-images e2e] 全部断言通过')

// API 级验证:npm run verify:wb-toolcalls
//
// 守的是「执行流里能不能看到模型调了哪些工具」这条链路。它横跨
//   claude CLI 的 NDJSON 事件流 → taskRunner 的 tool_use/tool_result 解析 →
//   jobStore 的快照与落盘 → SSE 的 job:toolcalls 增量
// 四个环节，单元测试（taskRunner.toolcalls.test.js）只覆盖得到中间那个纯解析器，
// 接线断了它看不见：事件名写错、白名单投影漏字段、flush 丢了最后一批，
// 这三种"单测全绿但界面还是没有工具块"的故障全靠这份脚本兜。
//
// 为什么要把 claude 桩掉（而不是真跑一轮）：
//   1. 真跑一轮要花用户额度、耗时不可控，还可能在真实仓库里改文件；
//   2. 桩成"原样吐一段带 tool_use 的流"才是可复现的 —— 真模型的工具调用次序、数量
//      每次都不同，没法钉断言。
//   桩的落点由 taskRunner 的 Windows 分支决定：`where claude` → 找到 .cmd →
//   dirname 下存在 node_modules/@anthropic-ai/claude-code/cli.js 就 spawn(node, [cliJs])
//   （见 taskRunner.js launchClaudeInNewWindow）。所以桩目录必须长成那个形状。
//
// 隔离：server 进程的 USERPROFILE/HOME 指向 mkdtemp 沙箱，绝不碰用户真实
// ~/.zen-gitsync/（见 src/paths.js 的说明）。

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'zgs-toolcalls-e2e-'))
const home = sandbox
const dataDir = path.join(home, '.zen-gitsync')
const stubDir = path.join(sandbox, 'stub-claude')
const proj = path.join(sandbox, 'proj')

const PORT = 5612
const base = `http://127.0.0.1:${PORT}`
const TASK_TITLE = '【工具调用验证】看下目录'

const failures = []
const check = (cond, msg) => { if (!cond) failures.push(msg) }

// ── 沙箱:一个项目目录 + 空配置 ────────────────────────────────────────
await fs.mkdir(proj, { recursive: true })
await fs.mkdir(dataDir, { recursive: true })
await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
  recentDirectories: [proj],
  projects: [],
  models: [],
}, null, 2))

// ── 桩 claude CLI:吐一段"思考 + 两次工具调用 + 正文"的 stream-json ──
// 事件次序刻意做成真实链路的样子：tool_use 先到、tool_result 后到；
// 第二个工具故意失败（is_error），用来钉「失败的调用也要显示、并带上错误文案」。
const stubLines = [
  { type: 'system', subtype: 'init', session_id: 'ses-stub-toolcalls' },
  { type: 'assistant', message: { content: [
    { type: 'thinking', thinking: '先看看这个目录里有什么。' },
    { type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'ls -la', description: '列目录' } },
  ] } },
  { type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_a', content: 'total 8\ndrwxr-xr-x a.js\n' },
  ] } },
  { type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'toolu_b', name: 'Read', input: { file_path: 'src/a.js' } },
  ] } },
  { type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_b', is_error: true, content: 'File does not exist.' },
  ] } },
  { type: 'assistant', message: { content: [
    { type: 'text', text: '目录里只有一个 a.js，读它失败了。' },
  ] } },
  { type: 'result', subtype: 'success' },
]

const stubMedia = path.join(stubDir, 'node_modules', '@anthropic-ai', 'claude-code')
await fs.mkdir(stubMedia, { recursive: true })
await fs.writeFile(path.join(stubDir, 'claude.cmd'), '@echo off\r\nnode "%~dp0node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n')
// 每行之间留间隔：既让 job 有一小段真正处于 running，也让"增量推送"这件事可断言
// （全在同一 tick 里吐完的话，前端拿到的就只剩终态快照了）。
await fs.writeFile(path.join(stubMedia, 'cli.js'), [
  "const LINES = " + JSON.stringify(stubLines) + ';',
  "let i = 0;",
  "const timer = setInterval(() => {",
  "  if (i >= LINES.length) { clearInterval(timer); process.exit(0); }",
  "  process.stdout.write(JSON.stringify(LINES[i++]) + '\\n');",
  "}, 120);",
  "// stdin 必须被读走,否则父进程的 write 回调不触发",
  "process.stdin.resume();",
  "process.stdin.on('data', () => {});",
  "setTimeout(() => process.exit(0), 30000);",
].join('\n'))

// ── 起沙箱 server(PATH 前置桩目录,让 where claude 命中桩) ──
const env = {
  ...process.env,
  PORT: String(PORT),
  ZEN_PERF: '0',
  USERPROFILE: home,
  HOME: home,
  PATH: `${stubDir}${path.delimiter}${process.env.PATH}`,
}
delete env.HOMEDRIVE
delete env.HOMEPATH

// ⚠️ server.js 会往**仓库根**写 .port 与 src/ui/client/.env.local —— 它的 cwd 就是这里
// （沙箱只换了 USERPROFILE/HOME，换不掉 cwd）。不还原的话 vite 的代理会一直指向 5612
// 这个空端口，之后所有浏览器验证脚本集体 502（verify-workbench-env-context.mjs 里踩过）。
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

try {
  if (!await waitReady()) throw new Error(`server 未就绪:\n${serverLog}`)

  // ── 0. 先挂上 SSE：要断言的是"执行中就把工具调用推过来了"，就得在开跑之前连上 ──
  const seen = []           // 按到达顺序记 { event, payload }
  const sseAbort = new AbortController()
  const sseTask = (async () => {
    const resp = await fetch(`${base}/api/workbench/events`, { signal: sseAbort.signal })
    const reader = resp.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const chunks = buf.split('\n\n')
      buf = chunks.pop() ?? ''
      for (const c of chunks) {
        const line = c.split('\n').find(l => l.startsWith('data:'))
        if (!line) continue
        try { seen.push(JSON.parse(line.slice(5).trim())) } catch { /* ignore */ }
      }
    }
  })().catch(() => { /* abort 时正常抛出 */ })
  await sleep(400)

  // ── 1. 建一条任务(挂在当前项目下,便于后续 UI 也能看到) ──
  const cp = await fetch(`${base}/api/workbench/current-project`).then(r => r.json())
  const currentProject = cp.projectPath || projectRoot
  const createRes = await fetch(`${base}/api/workbench/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: TASK_TITLE,
      desc: '列一下目录',
      promptId: null,
      simpleOverride: '列一下目录',
      projectPath: currentProject,
    }),
  })
  const created = await createRes.json()
  check(createRes.status === 200 && created?.success !== false, `建任务应成功,实际 ${createRes.status} ${JSON.stringify(created)}`)
  const taskId = created?.task?.id
  if (!taskId) throw new Error('没有 taskId,后续断言无法继续')

  // ── 2. 触发执行 ──
  const runRes = await fetch(`${base}/api/workbench/tasks/${taskId}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ executor: 'claude' }),
  })
  const runBody = await runRes.json().catch(() => ({}))
  check(runRes.status === 200, `run 应 200,实际 ${runRes.status} ${JSON.stringify(runBody)}`)

  // ── 3. 等执行收尾 ──
  let job = null
  for (let i = 0; i < 120; i += 1) {
    const body = await fetch(`${base}/api/workbench/jobs`).then(r => r.json()).catch(() => ({ jobs: [] }))
    job = (body.jobs || []).find(j => j.taskId === taskId) || null
    if (job && job.status !== 'running' && job.status !== 'pending') break
    await sleep(250)
  }
  check(!!job, '应能查到该任务的 job(说明真的进入执行链路)')
  if (!job) throw new Error('没有 job,后续断言无法继续')
  check(job.status === 'done', `job 应 done,实际 ${job.status} (error=${job.error || ''})`)

  // ── 4. 快照里的工具调用 ──
  const calls = Array.isArray(job.toolCalls) ? job.toolCalls : []
  check(calls.length === 2, `应有 2 条工具调用,实际 ${calls.length}`)
  const [c1, c2] = calls
  check(c1?.id === 'toolu_a', `第 1 条 id 应为 toolu_a,实际 ${c1?.id}`)
  check(c1?.name === 'Bash', `第 1 条 name 应为 Bash,实际 ${c1?.name}`)
  check(c1?.status === 'done', `第 1 条应 done,实际 ${c1?.status}`)
  check(String(c1?.result || '').includes('a.js'), `第 1 条结果应含 a.js,实际 ${JSON.stringify(c1?.result)}`)
  // 摘要要挑出 command 字段，而不是把整段 JSON 铺在折叠行上
  check(c1?.argsPreview === 'ls -la', `第 1 条摘要应为命令本身,实际 ${JSON.stringify(c1?.argsPreview)}`)
  check(c2?.name === 'Read', `第 2 条 name 应为 Read,实际 ${c2?.name}`)
  check(c2?.argsPreview === 'src/a.js', `第 2 条摘要应为文件路径,实际 ${JSON.stringify(c2?.argsPreview)}`)
  check(c2?.status === 'error', `is_error 的调用应标 error,实际 ${c2?.status}`)
  check(String(c2?.error || '').includes('does not exist'), `第 2 条应带错误文案,实际 ${JSON.stringify(c2?.error)}`)

  // ── 5. 原有能力没被挤掉：正文/思考/会话标识照旧 ──
  check(String(job.output || '').includes('目录里只有一个 a.js'), '正文应照常落 output')
  check(String(job.thinking || '').includes('先看看这个目录里有什么'), '思考应照常落 thinking')
  check(job.claudeSessionId === 'ses-stub-toolcalls', `会话标识应被捕获,实际 ${JSON.stringify(job.claudeSessionId)}`)

  // ── 6. SSE 增量：执行中就该有工具调用推过来（只有终态快照的话前端会一直"看不出在干啥"）──
  const toolEvents = seen.filter(e => e.event === 'job:toolcalls')
  check(toolEvents.length > 0, 'SSE 应推过 job:toolcalls 事件')
  const updates = toolEvents.flatMap(e => Array.isArray(e.payload?.updates) ? e.payload.updates : [])
  check(updates.some(u => u.id === 'toolu_a' && u.status === 'running'), '应有 toolu_a 的 running 增量(证明是边跑边推)')
  check(updates.some(u => u.id === 'toolu_a' && u.status === 'done'), '应有 toolu_a 的 done 增量')
  check(updates.every(u => u.id !== undefined || u.name !== undefined), '增量应带 id/name 字段')
  // 收口发生在最后一批：进程退出后不该还有 running 挂在那边
  const lastA = [...updates].reverse().find(u => u.id === 'toolu_a')
  check(lastA?.status === 'done', `toolu_a 最后一条增量应为终态,实际 ${lastA?.status}`)

  // ── 7. 落盘：刷新页面 / 换个实例打开，工具调用还得在 ──
  const jobsFile = path.join(dataDir, 'jobs.json')
  const disk = JSON.parse(await fs.readFile(jobsFile, 'utf8'))
  const diskJob = (disk.jobs || []).find(j => j.taskId === taskId)
  check(!!diskJob, 'job 应已落盘到 jobs.json')
  check(Array.isArray(diskJob?.toolCalls) && diskJob.toolCalls.length === 2,
    `落盘的 job 应带 2 条工具调用,实际 ${diskJob?.toolCalls?.length}`)
  check(diskJob?.toolCalls?.[0]?.result?.includes('a.js'), '落盘的工具结果应完整(不能被 projection 剥掉)')
  // size 是保留策略的计价口径，必须把工具调用算进去
  const callSize = (diskJob?.toolCalls || []).reduce((s, c) => s + (c.arguments || '').length + (c.result || '').length, 0)
  check(callSize > 0 && diskJob.size > callSize,
    `job.size 应把工具调用计入(${diskJob?.size} vs calls ${callSize})`)

  sseAbort.abort()
  await sseTask
} catch (err) {
  failures.push(`异常: ${err.message}`)
} finally {
  try { child.kill() } catch { /* ignore */ }
  await sleep(300)
  try { await fs.rm(sandbox, { recursive: true, force: true }) } catch { /* ignore */ }
  // 把被 server.js 覆盖掉的端口记录文件还原（否则会毒化后续的浏览器验证）
  for (const { f, content } of portFileBackup) {
    try {
      if (content === null) await fs.rm(f, { force: true })
      else await fs.writeFile(f, content)
    } catch { /* 还原失败不该盖住断言结果 */ }
  }
}

if (failures.length) {
  console.error('\n[workbench-toolcalls e2e] 失败:')
  failures.forEach(f => console.error('  ✗ ' + f))
  process.exit(1)
}
console.log('[workbench-toolcalls e2e] 全部断言通过')

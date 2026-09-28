// 端到端验证:npm run verify:wb-live-jobs
//
// 守的是「同机两个 g ui 实例,看板上的『进行中』必须一致」这条链路。
// 背景见 src/ui/server/routes/workbench/liveJobs.js 的文件头:以前只有终态才落盘,
// 运行中的 job 只活在跑它的那个进程内存里 —— 于是用户在 4114 起的工作台上点执行,
// 5966 那个工作台的同一条任务还挂在「待处理」。
//
// 为什么必须起**两个真实进程**:单元测试(jobStore.test.js / liveJobs.test.js)里
// 写文件和读文件是同一个进程、同一份模块状态,证明不了"另一个 OS 进程能不能看到"。
// 这份脚本起两个 server.js(同一沙箱 DATA_DIR、两个端口) + 一个第三方 runner 进程:
//   · runner 进程 = 真的在跑任务的实例(往 live-jobs/<自己的 pid>.json 写 running)
//   · server A / server B = 两个工作台,必须**都**把那条任务推导成「进行中」
// 判据全部走 HTTP,不看内部函数返回值。
//
// 隔离:所有子进程的 USERPROFILE/HOME 指向 mkdtemp 沙箱(见 src/paths.js 说明),
// 绝不碰用户真实 ~/.zen-gitsync/。⚠️ 但 server.js 会往**仓库根**写 .port 与
// src/ui/client/.env.local(cwd 换不掉)—— 收尾必须还原,否则 vite 代理会指向本脚本
// 用的端口,后续所有浏览器验证脚本集体 502(真踩过,见 verify-workbench-env-context.mjs 的注释)。

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'zgs-livejobs-e2e-'))
const home = sandbox
const dataDir = path.join(home, '.zen-gitsync')
const liveDir = path.join(dataDir, 'live-jobs')
const projDir = path.join(sandbox, 'proj')
const stubDir = path.join(sandbox, 'stub-claude')
const PORT_A = 5621
const PORT_B = 5622
/** 桩 claude 活多久。G6 要在它活着的时候从**另一个实例**观察到「进行中」 */
const STUB_ALIVE_MS = 12000

const failures = []
const check = (cond, msg) => { if (!cond) failures.push(msg) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const children = []
function spawnChild(args, extraEnv = {}, opts = {}) {
  const env = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    ...extraEnv,
  }
  delete env.HOMEDRIVE
  delete env.HOMEPATH
  const child = spawn(process.execPath, args, {
    cwd: opts.cwd || projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', d => { log += d })
  child.stderr.on('data', d => { log += d })
  child.getLog = () => log
  children.push(child)
  return child
}

async function fetchJson(base, url) {
  const r = await fetch(base + url)
  const body = await r.json().catch(() => null)
  return { status: r.status, body }
}

/** 轮询直到 predicate 为真。返回 { ok, value } */
async function waitFor(fn, timeoutMs = 15000, intervalMs = 300) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeoutMs) {
    try {
      last = await fn()
      if (last && last.ok) return { ok: true, value: last.value }
    } catch (err) { last = { ok: false, err: err.message } }
    await sleep(intervalMs)
  }
  return { ok: false, value: last && last.value, last }
}

/** 看板里某条任务的列 + 进行中计数 */
async function boardCell(base, taskId) {
  const { body } = await fetchJson(base, '/api/workbench/projects')
  const t = (body?.tasks || []).find(x => x.id === taskId)
  return { ok: !!t, value: t ? { column: t.column, runningJobs: t.runningJobs } : null }
}

// ── 端口记录文件备份(见文件头警告) ────────────────────────────────────
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

try {
  // ── 沙箱:任务 + 项目目录 + 桩 claude CLI ──────────────────────────
  // 桩的落点由 taskRunner 的 Windows 分支决定:`where claude` → 找到 .cmd →
  // dirname 下存在 node_modules/@anthropic-ai/claude-code/cli.js 就 spawn(node,[cliJs])。
  // 所以桩目录必须长成那个形状(同 verify-workbench-env-context.mjs)。
  await fs.mkdir(projDir, { recursive: true })
  await fs.mkdir(dataDir, { recursive: true })
  const stubMedia = path.join(stubDir, 'node_modules', '@anthropic-ai', 'claude-code')
  await fs.mkdir(stubMedia, { recursive: true })
  await fs.writeFile(path.join(stubDir, 'claude.cmd'), '@echo off\r\nnode "%~dp0node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n')
  await fs.writeFile(path.join(stubMedia, 'cli.js'), [
    "let buf = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', d => { buf += d; });",
    "process.stdin.on('end', () => {",
    "  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'stub-session' }) + '\\n');",
    "  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'STUB 正在干活' }] } }) + '\\n');",
    "});",
    "setTimeout(() => {",
    "  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n');",
    "  process.exit(0);",
    "}, Number(process.env.STUB_ALIVE_MS || 5000));",
  ].join('\n'))

  const serverEnv = {
    PATH: `${stubDir}${path.delimiter}${process.env.PATH}`,
    STUB_ALIVE_MS: String(STUB_ALIVE_MS),
  }

  const TASK_RUN = 't-run'
  const TASK_IDLE = 't-idle'
  const TASK_REAL = 't-real'
  const now = new Date().toISOString()
  await fs.writeFile(path.join(dataDir, 'tasks.json'), JSON.stringify({
    version: 1,
    tasks: [TASK_RUN, TASK_IDLE, TASK_REAL].map(id => ({
      id,
      title: `任务 ${id}`,
      desc: '',
      projectPath: projDir,
      attachments: [],
      createdAt: now,
      updatedAt: now,
    })),
  }, null, 2))
  await fs.writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify({ version: 1, jobs: [] }, null, 2))

  // ── 两个工作台实例(同一沙箱数据目录,两个端口) ────────────────────
  // ⚠️ 必须**先后**起,不能同时 spawn:两个实例同时初始化 local-file-picker 的
  // sqlite(同一个库文件)会有一个撞上 "database is locked" 然后 uncaughtException
  // 自杀(实测)。真实使用里用户也不会在同一毫秒按下两次,所以这不是本用例要守的东西 ——
  // 只需要避免它污染验证结果。
  const serverA = spawnChild(['server.js', '--no-open'], { PORT: String(PORT_A), ...serverEnv })
  const baseA = `http://127.0.0.1:${PORT_A}`
  const readyA = await waitFor(async () => {
    try {
      const r = await fetch(`${baseA}/api/app-version`)
      return { ok: r.ok, value: r.status }
    } catch { return { ok: false } }
  }, 60000, 300)
  check(readyA.ok, `实例 A(:${PORT_A}) 未在 60s 内就绪。日志尾部:\n${serverA.getLog().slice(-800)}`)

  const serverB = spawnChild(['server.js', '--no-open'], { PORT: String(PORT_B), ...serverEnv })
  const baseB = `http://127.0.0.1:${PORT_B}`
  const readyB = await waitFor(async () => {
    try {
      const r = await fetch(`${baseB}/api/app-version`)
      return { ok: r.ok, value: r.status }
    } catch { return { ok: false } }
  }, 60000, 300)
  check(readyB.ok, `实例 B(:${PORT_B}) 未在 60s 内就绪。日志尾部:\n${serverB.getLog().slice(-800)}`)

  // ── G1 基线:还没人跑,两边都该是「待处理」 ────────────────────────
  const g1a = await waitFor(() => boardCell(baseA, TASK_RUN), 20000)
  const g1b = await waitFor(() => boardCell(baseB, TASK_RUN), 20000)
  check(g1a.ok && g1a.value.column === 'todo', `G1 基线 A 应为 todo,实际 ${JSON.stringify(g1a.value)}`)
  check(g1b.ok && g1b.value.column === 'todo', `G1 基线 B 应为 todo,实际 ${JSON.stringify(g1b.value)}`)

  // ── G6 真实执行链路:在 A 上「执行」,B 的看板必须显示「进行中」 ──────
  // 这是用户报的那个场景本身。上面 G2 的 runner 是自己调模块函数写文件,证明不了
  // "点执行的时候真的会写" —— 接线断在 taskRunner 里的话只有这一组会红。
  // 桩 claude 替掉真实 CLI:不烧额度、不碰真实目录,但走的是**完全相同**的
  // spawn → 流式 NDJSON → 终态 flush 通路。
  const runRes = await fetch(`${baseA}/api/workbench/tasks/${TASK_REAL}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  check(runRes.status === 200, `G6 在 A 上启动任务应 200,实际 ${runRes.status}`)

  // 桩活着 12s,这段时间里 B 必须看得到「进行中」(轮询 300ms,一定撞得上)
  const seenDoing = await waitFor(async () => {
    const cell = await boardCell(baseB, TASK_REAL)
    return { ok: !!cell.value && cell.value.column === 'doing', value: cell.value }
  }, 25000, 300)
  check(
    seenDoing.ok,
    `G6 实例 B 应能观察到 A 正在跑的任务为「进行中」,实际 ${JSON.stringify(seenDoing.value)}`
  )

  // 跑完:两个实例都得变成「已完成」
  const settledInB = await waitFor(async () => {
    const cell = await boardCell(baseB, TASK_REAL)
    return { ok: !!cell.value && cell.value.column === 'done', value: cell.value }
  }, 45000, 500)
  check(settledInB.ok, `G6 跑完后实例 B 应显示已完成,实际 ${JSON.stringify(settledInB.value)}`)
  const settledInA = await boardCell(baseA, TASK_REAL)
  check(settledInA.value?.column === 'done', `G6 跑完后实例 A 也应显示已完成,实际 ${JSON.stringify(settledInA.value)}`)

  // ── G2 运行中:第三个进程真的"在跑",两个工作台都必须显示「进行中」 ──
  // runner 用真实模块写自己的 live-jobs/<pid>.json —— 与 taskRunner 跑起来时
  // 走的是同一条 scheduleActiveJobsSave 通路,只是不真的去 spawn claude。
  const runnerScript = path.join(sandbox, 'runner.mjs')
  await fs.writeFile(runnerScript, `
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const repoRoot = process.env.ZGS_REPO_ROOT
const modUrl = (rel) => pathToFileURL(path.join(repoRoot, rel)).href
const { jobs, scheduleActiveJobsSave, flushJobsSaveNow } = await import(modUrl('src/ui/server/routes/workbench/jobStore.js'))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const jobId = 'e2e-' + Date.now()
jobs.set(jobId, {
  id: jobId, taskId: '${TASK_RUN}', subId: '${TASK_RUN}__simple', title: '运行中同步 e2e',
  status: 'running', pid: process.pid, startedAt: new Date().toISOString(),
  agent: 'claude', prompt: 'p', output: 'e2e 正在跑的部分输出', thinking: '', toolCalls: [],
})
scheduleActiveJobsSave()
await sleep(2500)
console.log('RUNNING ' + jobId)
await sleep(8000)
jobs.get(jobId).status = 'done'
jobs.get(jobId).endedAt = new Date().toISOString()
await flushJobsSaveNow()
console.log('DONE ' + jobId)
await sleep(1500)
`, 'utf-8')

  const runner = spawnChild([runnerScript], { ZGS_REPO_ROOT: projectRoot })

  // 等 runner 说"我已经把 running 写进去了"(stdout 上带 jobId)
  const runningLine = await waitFor(async () => {
    const m = runner.getLog().match(/RUNNING (\S+)/)
    return { ok: !!m, value: m ? m[1] : null }
  }, 20000, 200)
  check(runningLine.ok, `runner 未在 20s 内写出运行中记录。日志:\n${runner.getLog().slice(-800)}`)
  const jobId = runningLine.value

  // 运行中的记录必须真的落在 live-jobs/ 里(目录 + 文件名 = runner 的 pid)
  let liveFiles = []
  try { liveFiles = await fs.readdir(liveDir) } catch { /* 目录不存在 = 下面断言会红 */ }
  check(
    liveFiles.includes(`${runner.pid}.json`),
    `live-jobs/ 里应有 runner(pid=${runner.pid}) 的文件,实际: ${JSON.stringify(liveFiles)}`
  )

  // 两个实例的看板:同一条任务都必须是「进行中」+ runningJobs=1
  // (修复前:跑它的那个是 doing,另一个还是 todo —— 这正是用户截图里的现象)
  for (const [name, base] of [['A', baseA], ['B', baseB]]) {
    const cell = await waitFor(() => boardCell(base, TASK_RUN), 15000, 300)
    check(
      cell.ok && cell.value.column === 'doing',
      `G2 实例 ${name} 应把「${TASK_RUN}」显示为进行中,实际 ${JSON.stringify(cell.value)}`
    )
    check(
      cell.ok && cell.value.runningJobs === 1,
      `G2 实例 ${name} 的 runningJobs 应为 1,实际 ${JSON.stringify(cell.value)}`
    )
  }
  // 没被跑的那条不受影响
  const idleCell = await boardCell(baseB, TASK_IDLE)
  check(idleCell.value?.column === 'todo', `G2 未被跑的任务应仍为 todo,实际 ${JSON.stringify(idleCell.value)}`)

  // ── G3 job 列表 / 单条详情:在**别的**实例上也要能取到那条运行中的 job ──
  // 以前 /jobs/:id 只查内存和 jobs.json,运行中的记录两边都没有 → 点开就 404
  const listB = await fetchJson(baseB, '/api/workbench/jobs')
  const listedInB = (listB.body?.jobs || []).find(j => j.id === jobId)
  check(!!listedInB, `G3 实例 B 的 job 列表里应有运行中的 ${jobId}`)
  check(listedInB?.status === 'running', `G3 列表里状态应为 running,实际 ${listedInB?.status}`)

  const detailB = await fetchJson(baseB, `/api/workbench/jobs/${jobId}`)
  check(detailB.status === 200, `G3 实例 B 取单条 job 应 200,实际 ${detailB.status}`)
  check(detailB.body?.job?.status === 'running', `G3 详情状态应为 running,实际 ${detailB.body?.job?.status}`)

  // ── G5 终态收口:runner 跑完 → live 文件消失,两个实例都变成「已完成」 ──
  const doneLine = await waitFor(async () => {
    const m = runner.getLog().match(/DONE (\S+)/)
    return { ok: !!m, value: m ? m[1] : null }
  }, 30000, 300)
  check(doneLine.ok, `runner 未在 30s 内收口。日志:\n${runner.getLog().slice(-800)}`)

  const gone = await waitFor(async () => {
    const files = await fs.readdir(liveDir).catch(() => [])
    return { ok: !files.includes(`${runner.pid}.json`), value: files }
  }, 10000, 300)
  check(gone.ok, `G5 终态后 live-jobs/${runner.pid}.json 必须消失,实际: ${JSON.stringify(gone.value)}`)

  for (const [name, base] of [['A', baseA], ['B', baseB]]) {
    const cell = await waitFor(() => boardCell(base, TASK_RUN), 15000, 300)
    check(
      cell.ok && cell.value.column === 'done',
      `G5 实例 ${name} 应把「${TASK_RUN}」推导成已完成,实际 ${JSON.stringify(cell.value)}`
    )
  }

  // ── G4 owner 进程消失:不留幽灵「进行中」 ─────────────────────────
  // 手工造一个 owner 已死的 live 文件(pid 取一个不可能存在的值)
  const ghostPid = 2147483647
  await fs.mkdir(liveDir, { recursive: true })
  await fs.writeFile(path.join(liveDir, `${ghostPid}.json`), JSON.stringify({
    version: 1,
    ownerPid: ghostPid,
    updatedAt: Date.now(),
    jobs: [{
      id: 'ghost-job', taskId: TASK_IDLE, subId: `${TASK_IDLE}__simple`, title: '幽灵进行中',
      status: 'running', pid: ghostPid, startedAt: now, endedAt: null, agent: 'claude',
      prompt: '', output: '', thinking: '', toolCalls: [], claudeSessionId: null,
    }],
  }), 'utf-8')

  for (const [name, base] of [['A', baseA], ['B', baseB]]) {
    // 顺手也会把文件删掉,所以断言"看板不受影响" + "文件被自愈清理"
    const cell = await boardCell(base, TASK_IDLE)
    check(
      cell.value?.column === 'todo',
      `G4 实例 ${name} 不该被 owner 已死的记录影响,实际 ${JSON.stringify(cell.value)}`
    )
  }
  const ghostGone = await waitFor(async () => {
    try { await fs.stat(path.join(liveDir, `${ghostPid}.json`)); return { ok: false } }
    catch { return { ok: true } }
  }, 8000, 300)
  check(ghostGone.ok, `G4 owner 已死的 live 文件应被自愈删除`)
} catch (err) {
  failures.push(`异常: ${err.message}`)
} finally {
  for (const c of children) {
    try { c.kill() } catch { /* ignore */ }
  }
  await sleep(500)
  try { await fs.rm(sandbox, { recursive: true, force: true }) } catch { /* ignore */ }
  for (const { f, content } of portFileBackup) {
    try {
      if (content === null) await fs.rm(f, { force: true })
      else await fs.writeFile(f, content)
    } catch { /* 还原失败不该盖住断言结果 */ }
  }
}

if (failures.length) {
  console.error('\n[live-jobs e2e] 失败:')
  failures.forEach(f => console.error('  ✗ ' + f))
  process.exit(1)
}
console.log('[live-jobs e2e] 全部断言通过（两个真实 g ui 实例的『进行中』已一致）')

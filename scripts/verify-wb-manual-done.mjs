// 端到端验证:npm run verify:wb-manual-done
//
// 守的是「手动把任务标成已完成」这条链路 —— 卡片上那颗「完成 / 撤销」按钮背后的两个接口:
//   POST   /api/workbench/tasks/:id/done   标记完成（在跑的会先停掉这一轮）
//   DELETE /api/workbench/tasks/:id/done   撤销标记
//
// 为什么必须起**真实进程 + 真的跑一轮**：这条链路有一半落在进程边界上 ——
// 「标记完成时先把正在跑的那一轮停掉」要真的杀一个 child 进程、真的把 job 落成 cancelled；
// 「标记之后又跑过一轮就作废」要真的有一次新的执行发生过。单元测试
// （projectRegistry.test.js）只覆盖了列推导那部分纯函数，起不到这里的作用。
//
// 隔离：所有子进程的 USERPROFILE/HOME 指向 mkdtemp 沙箱（见 src/paths.js 说明），
// 绝不碰用户真实 ~/.zen-gitsync/；执行器用桩 claude（不烧额度、不碰真实目录），
// 走的是**完全相同**的 spawn → 流式 NDJSON → 终态 flush 通路（同 verify-wb-live-jobs.mjs）。
// ⚠️ 但 server.js 会往**仓库根**写 .port 与 src/ui/client/.env.local（cwd 换不掉）——
// 收尾必须还原，否则 vite 代理会指向本脚本用的端口，后续所有浏览器验证脚本集体 502。
//
// 用法：node scripts/verify-wb-manual-done.mjs
// 退出码：0 全通过，1 有失败项。

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'zgs-manual-done-e2e-'))
const home = sandbox
const dataDir = path.join(home, '.zen-gitsync')
const projDir = path.join(sandbox, 'proj')
const stubDir = path.join(sandbox, 'stub-claude')
const PORT = 5631
/** 桩 claude 活多久：够长，好让"标记完成时它还在跑"这件事成立 */
const STUB_ALIVE_MS = 9000

const failures = []
const check = (cond, msg) => { if (!cond) failures.push(msg) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const children = []
function spawnChild(args, extraEnv = {}) {
  const env = { ...process.env, USERPROFILE: home, HOME: home, ...extraEnv }
  delete env.HOMEDRIVE
  delete env.HOMEPATH
  const child = spawn(process.execPath, args, { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', d => { log += d })
  child.stderr.on('data', d => { log += d })
  child.getLog = () => log
  children.push(child)
  return child
}

async function fetchJson(base, url, init) {
  const r = await fetch(base + url, init)
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

/** 看板里某条任务的那张卡（列 + 进行中计数 + 手动完成标记） */
async function boardCell(base, taskId) {
  const { body } = await fetchJson(base, '/api/workbench/projects')
  const t = (body?.tasks || []).find(x => x.id === taskId)
  return {
    ok: !!t,
    value: t ? { column: t.column, runningJobs: t.runningJobs, manualDoneAt: t.manualDoneAt ?? null } : null,
  }
}

const markDone = (base, id) => fetchJson(base, `/api/workbench/tasks/${id}/done`, { method: 'POST' })
const undoDone = (base, id) => fetchJson(base, `/api/workbench/tasks/${id}/done`, { method: 'DELETE' })

// ── 端口记录文件备份（见文件头警告） ──────────────────────────────────
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
  // ── 沙箱：任务 + 项目目录 + 桩 claude CLI ──────────────────────────
  // 桩的落点形状由 taskRunner 的 Windows 分支决定（where claude → .cmd →
  // 同级 node_modules/@anthropic-ai/claude-code/cli.js），同 verify-wb-live-jobs.mjs。
  await fs.mkdir(projDir, { recursive: true })
  await fs.mkdir(dataDir, { recursive: true })
  const stubMedia = path.join(stubDir, 'node_modules', '@anthropic-ai', 'claude-code')
  await fs.mkdir(stubMedia, { recursive: true })
  await fs.writeFile(path.join(stubDir, 'claude.cmd'), '@echo off\r\nnode "%~dp0node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n')
  await fs.writeFile(path.join(stubMedia, 'cli.js'), [
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', () => {});",
    "process.stdin.on('end', () => {",
    "  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'stub-session' }) + '\\n');",
    "  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'STUB 干完了' }] } }) + '\\n');",
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

  const TASK_RUN = 't-running'      // 在跑的时候被标完成 → 这一轮要被停掉
  const TASK_IDLE = 't-idle'        // 从没跑过 → 直接标完成
  const TASK_AGAIN = 't-again'      // 标完之后又跑了一轮 → 标记作废
  const now = new Date().toISOString()
  await fs.writeFile(path.join(dataDir, 'tasks.json'), JSON.stringify({
    version: 1,
    tasks: [TASK_RUN, TASK_IDLE, TASK_AGAIN].map(id => ({
      id, title: `任务 ${id}`, desc: '', projectPath: projDir, attachments: [],
      createdAt: now, updatedAt: now,
    })),
  }, null, 2))
  await fs.writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify({ version: 1, jobs: [] }, null, 2))

  // ── 起一个真实实例 ────────────────────────────────────────────────
  const server = spawnChild(['server.js', '--no-open'], { PORT: String(PORT), ...serverEnv })
  const base = `http://127.0.0.1:${PORT}`
  const ready = await waitFor(async () => {
    try {
      const r = await fetch(`${base}/api/app-version`)
      return { ok: r.ok, value: r.status }
    } catch { return { ok: false } }
  }, 60000, 300)
  check(ready.ok, `实例(:${PORT}) 未在 60s 内就绪。日志尾部:\n${server.getLog().slice(-800)}`)

  // ── A 基线 ────────────────────────────────────────────────────────
  const a1 = await waitFor(() => boardCell(base, TASK_RUN), 20000)
  check(a1.ok && a1.value.column === 'todo' && a1.value.manualDoneAt === null,
    `A1 基线应为「待处理」且没有手动标记，实际 ${JSON.stringify(a1.value)}`)

  // ── B 在跑的任务标完成：这一轮必须被停掉，列立刻落到已完成 ────────
  const runRes = await fetch(`${base}/api/workbench/tasks/${TASK_RUN}/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  })
  check(runRes.status === 200, `B1 启动任务应 200，实际 ${runRes.status}`)
  const seenDoing = await waitFor(async () => {
    const c = await boardCell(base, TASK_RUN)
    return { ok: c.value?.column === 'doing' && c.value.runningJobs === 1, value: c.value }
  }, 25000, 300)
  check(seenDoing.ok, `B2 任务应进入「进行中」，实际 ${JSON.stringify(seenDoing.value)}`)

  const marked = await markDone(base, TASK_RUN)
  check(marked.status === 200 && marked.body?.success === true,
    `B3 标记完成应 200，实际 ${marked.status} ${JSON.stringify(marked.body)}`)
  check(marked.body?.stoppedJobs === 1,
    `B4 ★ 标记完成必须把正在跑的那一轮一起停掉（stoppedJobs=1），实际 ${JSON.stringify(marked.body?.stoppedJobs)}`)

  const b5 = await waitFor(async () => {
    const c = await boardCell(base, TASK_RUN)
    return { ok: c.value?.column === 'done' && c.value.runningJobs === 0 && !!c.value.manualDoneAt, value: c.value }
  }, 15000, 300)
  check(b5.ok, `B5 标记后应落「已完成」且不再有在跑的 job，实际 ${JSON.stringify(b5.value)}`)

  // 真的杀了进程、真的把 job 落成 cancelled（不是只在内存里改了状态）
  const jobsAfter = await fetchJson(base, '/api/workbench/jobs')
  const canceledJob = (jobsAfter.body?.jobs || []).find(j => j.taskId === TASK_RUN)
  check(canceledJob?.status === 'cancelled',
    `B6 那一轮的 job 应落成 cancelled，实际 ${JSON.stringify(canceledJob && canceledJob.status)}`)
  check(!!canceledJob?.endedAt, `B7 cancelled 的 job 必须有 endedAt（否则看板的"用时"算不出来）`)

  // ── C 从没跑过的任务：直接标完成 ──────────────────────────────────
  const c1 = await markDone(base, TASK_IDLE)
  check(c1.status === 200 && c1.body?.stoppedJobs === 0,
    `C1 从没跑过的任务标完成应 200 且没停任何东西，实际 ${c1.status} ${JSON.stringify(c1.body?.stoppedJobs)}`)
  const c2 = await waitFor(async () => {
    const c = await boardCell(base, TASK_IDLE)
    return { ok: c.value?.column === 'done' && !!c.value.manualDoneAt, value: c.value }
  }, 10000, 300)
  check(c2.ok, `C2 没跑过的任务也能标成已完成（这正是"其实早已在别处干完了"那种），实际 ${JSON.stringify(c2.value)}`)

  // ── D 撤销：退回待处理，标记清掉；再撤一次也回成功（幂等） ────────
  const d1 = await undoDone(base, TASK_IDLE)
  check(d1.status === 200 && d1.body?.success === true, `D1 撤销应 200，实际 ${d1.status}`)
  const d2 = await waitFor(async () => {
    const c = await boardCell(base, TASK_IDLE)
    return { ok: c.value?.column === 'todo' && c.value.manualDoneAt === null, value: c.value }
  }, 10000, 300)
  check(d2.ok, `D2 撤销后应回「待处理」且标记清空，实际 ${JSON.stringify(d2.value)}`)
  const d3 = await undoDone(base, TASK_IDLE)
  check(d3.status === 200, `D3 没标记时再撤一次也应回 200（幂等，撤销是"点错了退回来"的动作），实际 ${d3.status}`)

  // ── E ★ 标记之后又跑过一轮 → 标记作废（"用时间比较而不是起跑时清标记"的端到端证据） ──
  const e1 = await markDone(base, TASK_AGAIN)
  check(e1.status === 200, `E1 先标完成应 200，实际 ${e1.status}`)
  const e2 = await waitFor(async () => {
    const c = await boardCell(base, TASK_AGAIN)
    return { ok: c.value?.column === 'done', value: c.value }
  }, 10000, 300)
  check(e2.ok, `E2 标完应在「已完成」，实际 ${JSON.stringify(e2.value)}`)

  const rerun = await fetch(`${base}/api/workbench/tasks/${TASK_AGAIN}/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  })
  check(rerun.status === 200, `E3 标完之后还能再跑一轮（标记不该把任务锁死），实际 ${rerun.status}`)
  const e4 = await waitFor(async () => {
    const c = await boardCell(base, TASK_AGAIN)
    return { ok: c.value?.column === 'doing', value: c.value }
  }, 25000, 300)
  check(e4.ok, `E4 新一轮跑起来时列应回到「进行中」（在跑压过手动标记），实际 ${JSON.stringify(e4.value)}`)

  const e5 = await waitFor(async () => {
    const c = await boardCell(base, TASK_AGAIN)
    return { ok: c.value?.column === 'done' && c.value.manualDoneAt === null, value: c.value }
  }, 45000, 500)
  check(e5.ok, `E5 ★ 跑完之后标记必须作废（manualDoneAt=null，列由执行事实说了算），实际 ${JSON.stringify(e5.value)}`)

  // 正因为标记已作废，这时候撤销什么都不该发生 —— 前端那颗「撤销」按钮就该消失
  await undoDone(base, TASK_AGAIN)
  const e6 = await boardCell(base, TASK_AGAIN)
  check(e6.value?.column === 'done' && e6.value.manualDoneAt === null,
    `E6 自己跑完的任务撤销之后仍留在「已完成」（前端据此不给那颗按钮），实际 ${JSON.stringify(e6.value)}`)

  // ── F 任务不存在：两个接口都 404 ─────────────────────────────────
  const f1 = await markDone(base, 'no-such-task')
  const f2 = await undoDone(base, 'no-such-task')
  check(f1.status === 404, `F1 标不存在的任务应 404，实际 ${f1.status}`)
  check(f2.status === 404, `F2 撤销不存在的任务应 404，实际 ${f2.status}`)
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
  console.error('\n[manual-done e2e] 失败:')
  failures.forEach(f => console.error('  ✗ ' + f))
  process.exit(1)
}
console.log('[manual-done e2e] 全部断言通过（标记 / 撤销 / 在跑时先停掉 / 新一轮作废标记）')

// API 级验证:npm run verify:wb-env-context
//
// 守的是「派发指令时有没有真的把运行环境上下文喂给 claude CLI」这条链路 ——
// 它横跨 configManager → projectRegistry → envContext → taskRunner 四个模块,
// 单元测试(envContext.test.js)只覆盖得到中间的纯函数,接线断了它是看不见的。
// 实测:把 taskRunner 里的注入关掉,这份脚本有 10 条断言会变红。
//
// 隔离:server 进程的 USERPROFILE/HOME 指向 mkdtemp 沙箱,绝不碰用户真实
// ~/.zen-gitsync/(见 src/paths.js 的说明)。
//
// 为什么要把 claude 桩掉:
//   1. 真跑一轮会消耗用户额度、还会在真实目录里改东西;
//   2. 桩成"把 stdin 落盘"能验证**最强的那一环** —— 真正进入子进程 stdin 的
//      那份 prompt 长什么样,而不是只看服务端内存里的 job.prompt。
//   桩的落点由 taskRunner 的 Windows 分支决定:`where claude` → 找到 .cmd →
//   dirname 下存在 node_modules/@anthropic-ai/claude-code/cli.js 就 spawn(node, [cliJs])
//   (见 taskRunner.js launchClaudeInNewWindow)。所以桩目录必须长成那个形状。

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'zgs-envctx-e2e-'))
const home = sandbox
const dataDir = path.join(home, '.zen-gitsync')
const stubDir = path.join(sandbox, 'stub-claude')
const promptOut = path.join(sandbox, 'cli-stdin.txt')
const projA = path.join(sandbox, 'projA')
const projB = path.join(sandbox, 'projB')

const PORT = 5611
const base = `http://127.0.0.1:${PORT}`
const TEXT = '我的项目有哪些'

const failures = []
const check = (cond, msg) => { if (!cond) failures.push(msg) }

// ── 沙箱:两个项目目录 + 最近目录白名单 ────────────────────────────────
await fs.mkdir(projA, { recursive: true })
await fs.mkdir(projB, { recursive: true })
await fs.mkdir(dataDir, { recursive: true })
await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
  recentDirectories: [projA, projB],
  projects: [],
  models: [],
}, null, 2))

// ── 桩 claude CLI:读 stdin → 落盘 → 回一行合法 stream-json ──
const stubMedia = path.join(stubDir, 'node_modules', '@anthropic-ai', 'claude-code')
await fs.mkdir(stubMedia, { recursive: true })
await fs.writeFile(path.join(stubDir, 'claude.cmd'), '@echo off\r\nnode "%~dp0node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n')
await fs.writeFile(path.join(stubMedia, 'cli.js'), [
  "const fs = require('fs');",
  "const out = process.env.STUB_PROMPT_OUT;",
  "let buf = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', d => { buf += d; });",
  "process.stdin.on('end', () => {",
  "  try { fs.writeFileSync(out, buf); } catch (e) { /* ignore */ }",
  "  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'STUB_OK' }] } }) + '\\n');",
  "  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n');",
  "});",
  "setTimeout(() => process.exit(0), 5000);",
].join('\n'))

// ── 起沙箱 server(PATH 前置桩目录,让 where claude 命中桩) ──
const env = {
  ...process.env,
  PORT: String(PORT),
  ZEN_PERF: '0',
  USERPROFILE: home,
  HOME: home,
  PATH: `${stubDir}${path.delimiter}${process.env.PATH}`,
  STUB_PROMPT_OUT: promptOut,
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

const sleep = ms => new Promise(r => setTimeout(r, ms))

try {
  if (!await waitReady()) throw new Error(`server 未就绪:\n${serverLog}`)

  // ── 1. 派发一条指令(autoRun 默认 true → 立刻执行) ──
  const dispatchRes = await fetch(`${base}/api/workbench/orchestrator/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: TEXT, projectPath: projA }),
  })
  const dispatch = await dispatchRes.json()
  check(dispatchRes.status === 200, `dispatch 应 200,实际 ${dispatchRes.status}`)
  check(dispatch?.ran === true, `dispatch 应立刻执行(ran=true),实际 ${JSON.stringify(dispatch?.ran)}`)
  const taskId = dispatch?.task?.id
  check(!!taskId, 'dispatch 应回带 task.id')
  if (!taskId) throw new Error('没有 taskId,后续断言无法继续')

  // ── 2. 取这次执行的 job.prompt ──
  let job = null
  for (let i = 0; i < 60 && !job; i += 1) {
    const r = await fetch(`${base}/api/workbench/jobs`)
    const body = await r.json()
    job = (body.jobs || []).find(j => j.taskId === taskId) || null
    if (!job) await sleep(250)
  }
  check(!!job, '应能查到该任务的 job(说明真的进入执行链路)')
  const prompt = job?.prompt || ''

  // ── 3. 上下文块断言 ──
  const tasksFile = path.join(dataDir, 'tasks.json')
  check(prompt.startsWith('[运行环境'), 'prompt 应以注入的上下文头开始(旧行为是直接以用户原话开始)')
  check(prompt.includes(projA), 'prompt 应含当前项目路径 projA')
  check(prompt.includes(projB), 'prompt 应含另一个项目路径 projB(证明是"项目清单"而非只有 cwd)')
  check(prompt.includes(`projA | ${projA} | `), 'prompt 应含 projA 的「名称 | 路径 | 计数」行')
  check(prompt.includes('看板任务概览'), 'prompt 应含看板任务概览')
  check(prompt.includes('\u2190 当前'), 'prompt 应标出当前项目(← 当前)')
  check(prompt.includes(tasksFile), 'prompt 应给出 tasks.json 的绝对路径')
  check(prompt.includes(path.join(dataDir, 'jobs.json')), 'prompt 应给出 jobs.json 的绝对路径')
  check(prompt.includes(path.join(dataDir, 'orchestrator.json')), 'prompt 应给出 orchestrator.json 的绝对路径')
  check(prompt.includes(path.join(dataDir, 'config.json')), 'prompt 应给出 config.json 的绝对路径')
  // 用户原话必须压在最末尾(最靠近模型注意力中心)
  check(prompt.trimEnd().endsWith(TEXT), `用户原话应在 prompt 末尾,实际结尾: ${JSON.stringify(prompt.slice(-80))}`)
  check(prompt.indexOf('[运行环境') < prompt.lastIndexOf(TEXT), '上下文应在用户原话之前')

  // ── 4. 真正进入子进程 stdin 的那份 prompt 必须一致 ──
  let stdinPrompt = ''
  for (let i = 0; i < 40 && !stdinPrompt; i += 1) {
    try { stdinPrompt = await fs.readFile(promptOut, 'utf8') } catch { await sleep(250) }
  }
  check(!!stdinPrompt, '桩 claude 应收到 stdin(说明 prompt 真的被喂进了子进程)')
  check(stdinPrompt === prompt, '进入 CLI stdin 的 prompt 应与 job.prompt 逐字一致')

  // ── 5. 不能污染任务本体(看板卡片只占一行,desc 是 UI 上的显示内容) ──
  const tasksRes = await fetch(`${base}/api/workbench/tasks`)
  const tasksBody = await tasksRes.json()
  const task = (tasksBody.tasks || []).find(t => t.id === taskId)
  check(!!task, '任务应已落盘')
  check(task?.desc === TEXT, `task.desc 应保持用户原话,实际 ${JSON.stringify(task?.desc)}`)
  check(task?.title === TEXT, `task.title 应保持用户原话,实际 ${JSON.stringify(task?.title)}`)
  check(!String(task?.desc || '').includes('[运行环境'), 'task.desc 不应含注入内容')
} catch (err) {
  failures.push(`异常: ${err.message}`)
} finally {
  try { child.kill() } catch { /* ignore */ }
  await sleep(300)
  try { await fs.rm(sandbox, { recursive: true, force: true }) } catch { /* ignore */ }
}

if (failures.length) {
  console.error('\n[env-context e2e] 失败:')
  failures.forEach(f => console.error('  ✗ ' + f))
  process.exit(1)
}
console.log('[env-context e2e] 全部断言通过')

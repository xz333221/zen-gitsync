// API 级验证: npm run verify:wb-agent-dispatch
//
// 守的是 2026-09-28 这次改造的那条新链路：
//   主 Agent 控制台的对话（g ai，服务端跑工具循环）
//     → 模型决定调 dispatch_task
//     → 工具把参数交给**与 HTTP 端点共用的**派发器
//     → 建出任务、写进指令流水、按闸门交给本地 CLI 执行
//     → 工具结果把"落到哪个项目 / 有没有跑 / 凭什么这么落点"回灌给模型
//
// 单元测试（dispatchInstruction.test.js / agentRoutes.test.js）盖得住其中大部分，
// 但盖不住"接线"：registerAgentRoutes 拿到的 configManager 是不是那份真配置、
// express 路由上 allowDispatch 有没有被解析、dispatch_task 的工具名有没有写错 ——
// 单测里这三处都是我们自己传进去的假值。所以这里起真 server、走真 HTTP。
//
// 为什么要桩掉 LLM 与 claude（而不是真跑一轮）：
//   1. 真跑要花额度、耗时不可控，还可能在真实仓库里改文件；
//   2. 桩成"原样吐一条 dispatch_task 调用"才是可复现的：真模型派不派、
//      派几条、参数怎么填每次都不同，没法钉断言。
//
// 隔离：server 进程的 USERPROFILE/HOME 指向 mkdtemp 沙箱，绝不碰用户真实的
// ~/.zen-gitsync/（见 src/paths.js 的说明）。

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'zgs-agent-dispatch-e2e-'));
const home = sandbox;
const dataDir = path.join(home, '.zen-gitsync');
const stubDir = path.join(sandbox, 'stub-claude');
const proj = path.join(sandbox, 'proj');

const PORT = 5613;
const LLM_PORT = 5614;
const base = `http://127.0.0.1:${PORT}`;

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 桩 LLM：按剧本回 SSE。剧本是一条队列，每收到一次请求就弹一个 ──
// 一轮对话要两次：先给工具调用，拿到工具结果后给正文。
const llmScript = [];
let llmCalls = 0;
const sseChunk = payload => `data: ${JSON.stringify(payload)}\n\n`;

function scriptToolCall(args) {
  llmScript.push(() => [
    sseChunk({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'call_dispatch_e2e', type: 'function', function: { name: 'dispatch_task', arguments: JSON.stringify(args) } }
    ] } }] }),
    'data: [DONE]\n\n',
  ]);
}
function scriptText(text) {
  llmScript.push(() => [sseChunk({ choices: [{ delta: { content: text } }] }), 'data: [DONE]\n\n']);
}

const llmServer = createServer(async (req, res) => {
  llmCalls += 1;
  const make = llmScript.shift();
  await sleep(30);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  if (!make) { res.end('data: [DONE]\n\n'); return; }
  for (const chunk of make()) res.write(chunk);
  res.end();
});
await new Promise(r => llmServer.listen(LLM_PORT, '127.0.0.1', r));

// ── 沙箱：一个项目目录 + 配置（最近目录 = 该项目；模型指向桩 LLM）──
await fs.mkdir(proj, { recursive: true });
await fs.mkdir(dataDir, { recursive: true });
await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
  recentDirectories: [proj],
  projects: [],
  models: [{
    name: 'Stub',
    model: 'stub-model',
    baseURL: `http://127.0.0.1:${LLM_PORT}/v1`,
    apiKey: 'sk-stub',
    isDefault: true,
  }],
}, null, 2));

// ── 桩 claude CLI：形状必须与 taskRunner 的 Windows 分支一致 ──
// spawn 前它会 `where claude` 找 .cmd，再取 dirname 下的
// node_modules/@anthropic-ai/claude-code/cli.js；找不到 cli.js 就退化成 spawn claude.exe。
const stubMedia = path.join(stubDir, 'node_modules', '@anthropic-ai', 'claude-code');
await fs.mkdir(stubMedia, { recursive: true });
await fs.writeFile(path.join(stubDir, 'claude.cmd'), '@echo off\r\nnode "%~dp0node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
await fs.writeFile(path.join(stubMedia, 'cli.js'), [
  "const LINES = [",
  "  { type: 'system', subtype: 'init', session_id: 'ses-stub-dispatch' },",
  "  { type: 'assistant', message: { content: [{ type: 'text', text: '收到，开始干活。' }] } },",
  "  { type: 'result', subtype: 'success' },",
  "];",
  "for (const line of LINES) process.stdout.write(JSON.stringify(line) + '\\n');",
  "process.stdin.resume();",
  "process.stdin.on('data', () => {});",
  "setTimeout(() => process.exit(0), 300);",
].join('\n'));

// ── 起沙箱 server（PATH 前置桩目录，让 where claude 命中桩）──
// server.js 会往**仓库根**写 .port 与 src/ui/client/.env.local，先备份后还原 ——
// 不还原会让 vite 代理指向这个临时端口，后续所有浏览器验证脚本集体 502。
const PORT_FILES = [
  path.join(projectRoot, '.port'),
  path.join(projectRoot, 'src/ui/client/.env.local'),
];
const portFileBackup = [];
for (const f of PORT_FILES) {
  try { portFileBackup.push({ f, content: await fs.readFile(f, 'utf8') }); }
  catch { portFileBackup.push({ f, content: null }); }
}

const env = {
  ...process.env,
  PORT: String(PORT),
  ZEN_PERF: '0',
  USERPROFILE: home,
  HOME: home,
  PATH: `${stubDir}${path.delimiter}${process.env.PATH}`,
};
delete env.HOMEDRIVE;
delete env.HOMEPATH;

const child = spawn(process.execPath, ['server.js', '--no-open'], {
  cwd: projectRoot,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', d => { serverLog += d; });
child.stderr.on('data', d => { serverLog += d; });

async function waitReady(timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${base}/api/app-version`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  return false;
}

/** 发一轮对话，把 SSE 事件按到达顺序收下来 */
async function chat(body) {
  const resp = await fetch(`${base}/api/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ userMessage: '占位', ...body }),
  });
  const text = await resp.text();
  return text.split('\n')
    .filter(l => l.trim().startsWith('data:'))
    .map(l => { try { return JSON.parse(l.trim().slice(5)); } catch { return null; } })
    .filter(Boolean);
}

const readJson = async (f, fallback) => {
  try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fallback; }
};

try {
  if (!await waitReady()) throw new Error(`server 未就绪:\n${serverLog}`);

  // ════════════════════════════════════════════════════════════════════════
  // ① 控制台：allowDispatch 的对话里派一条任务，且真的跑起来
  // ════════════════════════════════════════════════════════════════════════
  const TASK_TEXT = '给订单模块补一份单元测试';
  llmScript.length = 0;
  scriptToolCall({ text: TASK_TEXT, project_path: proj });   // 不给 auto_run → 走默认（建了就跑）
  scriptText('已经派给本地执行器了。');

  const beforeTasks = ((await readJson(path.join(dataDir, 'tasks.json'), { tasks: [] })).tasks || []).length;

  const events = await chat({
    userMessage: '把补单测这件事派出去',
    engine: 'gai',
    allowDispatch: true,
    dispatchExecutor: 'claude',
  });

  const started = events.find(e => e.type === 'tool_call_start' && e.name === 'dispatch_task');
  check(!!started, '开了 allowDispatch 就该看到 dispatch_task 的工具调用');
  const toolResult = events.find(e => e.type === 'tool_result' && e.name === 'dispatch_task');
  check(!!toolResult, '工具执行后应有 tool_result');
  check(/已派发/.test(toolResult?.result || ''), `工具结果应说明已派发，实际: ${toolResult?.result}`);
  check(/已交给 Claude Code 开始执行/.test(toolResult?.result || ''),
    `工具结果应说清它在跑、由谁跑，实际: ${toolResult?.result}`);
  check(/派发时显式指定了项目/.test(toolResult?.result || ''), '工具结果应带上落点依据');
  // 模型拿到结果后要把话说回来（证明工具结果进了历史、循环继续了）
  check(events.some(e => e.type === 'content' && /已经派给本地执行器了/.test(e.delta || '')),
    '工具执行后模型应能继续产出正文');

  // 任务真的建在指定项目下，且正文就是指令本身
  const tasksFile = path.join(dataDir, 'tasks.json');
  const tasks = (await readJson(tasksFile, { tasks: [] })).tasks || [];
  check(tasks.length === beforeTasks + 1, `应新建 1 条任务，实际 ${tasks.length - beforeTasks}`);
  const task = tasks[tasks.length - 1];
  check(task?.projectPath === proj, `任务应落在显式指定的项目，实际 ${task?.projectPath}`);
  check(task?.desc === TASK_TEXT, '任务正文应等于指令原文（不是标题）');
  check(task?.status === 'todo', '新任务初始状态应是待处理');

  // 指令流水：落点依据与"建了就执行"要被记下来
  const state = await readJson(path.join(dataDir, 'orchestrator.json'), { instructions: [] });
  const record = (state.instructions || [])[state.instructions.length - 1];
  check(record?.taskId === task?.id, '指令流水应关联到这条任务');
  check(record?.status === 'accepted', `调度未暂停时应记为 accepted，实际 ${record?.status}`);
  check(record?.targetSource === 'explicit', `落点依据应为 explicit，实际 ${record?.targetSource}`);

  // 桩 claude 会被真跑一遍：job 应落盘且到达终态（不是卡在 running）
  let job = null;
  for (let i = 0; i < 40; i++) {
    const jobs = (await readJson(path.join(dataDir, 'jobs.json'), { jobs: [] })).jobs || [];
    job = jobs.find(j => j.taskId === task.id);
    if (job && ['done', 'error', 'cancelled'].includes(job.status)) break;
    await sleep(250);
  }
  check(!!job, '派发应真的起了一个 job');
  check(job?.agent === 'claude', `job 应记下执行器 claude，实际 ${job?.agent}`);
  check(job?.status === 'done', `桩 claude 跑完后 job 应为 done，实际 ${job?.status}`);

  // ════════════════════════════════════════════════════════════════════════
  // ② 同一个端点、不带 allowDispatch：工具在表里，但注入是关的
  //     —— 必须回一句明确的不可用，且不得建任务
  // ════════════════════════════════════════════════════════════════════════
  llmScript.length = 0;
  scriptToolCall({ text: '这条不该被派出去', project_path: proj });
  scriptText('我没法在这里派发。');

  const events2 = await chat({ userMessage: '派一条给别的 agent 试试', engine: 'gai' });
  const result2 = events2.find(e => e.type === 'tool_result' && e.name === 'dispatch_task');
  check(/只在 g ui 的「主 Agent 控制台」/.test(result2?.result || ''),
    `未开闸门的入口应拿到明确的不可用说明，实际: ${result2?.result}`);
  const afterTasks = ((await readJson(tasksFile, { tasks: [] })).tasks || []).length;
  check(afterTasks === tasks.length, '未开闸门的入口不该建出任务');

  check(llmCalls === 4, `桩 LLM 应被调用 4 次（两轮各两次），实际 ${llmCalls}`);
} catch (err) {
  failures.push(`异常: ${err.message}`);
} finally {
  try { child.kill(); } catch { /* ignore */ }
  try { llmServer.close(); } catch { /* ignore */ }
  await sleep(300);
  try { await fs.rm(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const { f, content } of portFileBackup) {
    try {
      if (content === null) await fs.rm(f, { force: true });
      else await fs.writeFile(f, content);
    } catch { /* 还原失败不该盖住断言结果 */ }
  }
}

if (failures.length) {
  console.error('\n[workbench-agent-dispatch e2e] 失败:');
  failures.forEach(f => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log('[workbench-agent-dispatch e2e] 全部断言通过');

#!/usr/bin/env node
/**
 * SSE 链路端到端验证（2026-10-25）
 *
 * 为什么不是再写一份单测：单测守的是"处理器有没有按约定往外写字节"，
 * 守不住的是**真链路**——Express 中间件、压缩、代理头、事件总线跨模块装配、
 * 客户端拿到的第一个字节是什么。这些只有起一个真服务、发真请求才看得见。
 *
 * 隔离原则（不许碰用户正在用的那个 g ui）：
 *   · 临时 HOME/USERPROFILE → 数据目录(~/.zen-gitsync)整个落到临时沙箱，
 *     tasks / jobs / config 全都不碰真实那份
 *   · 临时 cwd → server 把 `.port` 与 client/.env.local 写在沙箱里，
 *     不会覆盖仓库根目录那个 5545
 *   · 临时端口（监听 0 拿到空闲端口）+ --no-open，不弹浏览器
 *
 * 覆盖的链路：
 *   1. GET  /api/workbench/events  头 / hello 首帧 / 5s 保活 / 真实事件推送 / 断线清理
 *   2. GET  /api/schedules/events  hello 首帧
 *   3. POST /api/agent/chat        空消息 400；未配模型 → SSE 头 + 立即首字节 + error 帧 + 收尾
 *   4. POST /api/exec-stream       头 + process_id / stdout / exit 三种帧
 *   5. 大档案（jobs.json 20MB）下 hello 首帧的体积与到达时间
 *      —— 这一条 2026-10-25 实测在真机上翻红过：真实实例的 hello 帧 70.7MB / 29s 才收完，
 *         原因是 snapshotJobs() 把每条 job 的 output/thinking/toolCalls 全文都塞进首帧，
 *         而 jobs.json 按保留策略可以长到 256MB。留着它当回归闸门。
 *
 * 用法：
 *   node scripts/verify-sse-chain.cjs             # 全跑
 *   node scripts/verify-sse-chain.cjs --keep      # 失败也保留沙箱目录（排查用）
 *
 * 退出码：0 = 全绿；1 = 有失败
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const KEEP = process.argv.includes('--keep');
const HEARTBEAT_MS = 5000;          // 与后端 shared.js 的 SSE_HEARTBEAT_MS 同口径
const HEARTBEAT_TOLERANCE = 1800;   // 定时器抖动 + 网络/事件循环延迟
const START_TIMEOUT_MS = 90000;
// hello 首帧的体积与到达时间上限。首帧是「客户端连上就能拿到状态」的唯一通路，
// 它一旦跟着 jobs.json 一起膨胀，重连就等于重新下载整份历史档案。
const HELLO_MAX_MB = 2;
const HELLO_MAX_MS = 5000;

// ── 断言收集 ────────────────────────────────────────────────
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ' — ' + detail : ''}`);
}
async function step(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail);
  } catch (err) {
    record(name, false, err && err.message ? err.message : String(err));
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`等待超时(${timeoutMs}ms): ${label}`);
}

// ── 空闲端口 ────────────────────────────────────────────────
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ── 一条 SSE 连接 ───────────────────────────────────────────
/**
 * 建立 SSE 连接并持续解析帧。
 * @param {number} port
 * @param {string} pathname
 * @param {{method?: string, headers?: Record<string,string>, body?: string}} [opts]
 */
function openSse(port, pathname, opts = {}) {
  const rec = {
    status: 0,
    headers: null,
    events: [],      // {at, event, payload, raw}
    comments: [],    // {at, text}
    raw: '',
    bytes: 0,
    firstFrame: null, // {bytes, at} —— 首帧体积与到达时刻，大档案场景用它量刑
    connectedAt: 0,
    endedAt: 0,
    destroyed: false,
    endError: null,
  };
  let buf = '';
  const req = http.request({
    host: '127.0.0.1',
    port,
    path: pathname,
    method: opts.method || 'GET',
    headers: opts.headers || {},
  }, (res) => {
    rec.status = res.statusCode || 0;
    rec.headers = res.headers;
    rec.connectedAt = Date.now();
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      const at = Date.now();
      buf += chunk;
      rec.raw += chunk;
      rec.bytes += Buffer.byteLength(chunk);
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!rec.firstFrame) rec.firstFrame = { bytes: Buffer.byteLength(block), at };
        const lines = block.split(/\r?\n/);
        const dataLines = [];
        let isComment = false;
        for (const line of lines) {
          if (line.startsWith(':')) { isComment = true; continue; }
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (isComment && dataLines.length === 0) {
          rec.comments.push({ at, text: block.trim() });
        } else if (dataLines.length) {
          const raw = dataLines.join('\n');
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch { /* 坏帧留 raw 供断言 */ }
          rec.events.push({ at, raw, parsed });
        }
      }
    });
    res.on('end', () => { rec.endedAt = Date.now(); });
    res.on('error', (e) => { rec.endError = e; });
  });
  req.on('error', (e) => { rec.endError = e; });
  if (opts.body) req.write(opts.body);
  req.end();
  rec.close = () => {
    if (rec.destroyed) return;
    rec.destroyed = true;
    try { req.destroy(); } catch { /* ignore */ }
  };
  return rec;
}

// ── HTTP JSON ───────────────────────────────────────────────
async function jsonApi(port, method, pathname, body) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

// ── 服务进程 ────────────────────────────────────────────────
/**
 * 往沙箱数据目录里写一份「体积和真机一个量级」的历史档案。
 * 真机 jobs.json 现在是 72MB（380 条，thinking 21M 字符 + toolCalls 35M 字符），
 * 这里按 40 条 × ~500KB 合成 20MB —— 足够把「hello 跟着档案一起膨胀」逼出来，
 * 又不至于让验证本身跑很久。
 */
function seedHeavyJobs(sandbox, count) {
  const dir = path.join(sandbox, '.zen-gitsync');
  fs.mkdirSync(dir, { recursive: true });
  const thinking = '思考'.repeat(50000);        // ≈300KB（UTF-8 每字 3 字节）
  const argsBody = 'a'.repeat(40000);
  const resultBody = 'b'.repeat(120000);
  const jobs = [];
  for (let i = 0; i < count; i++) {
    const started = new Date(Date.now() - (i + 1) * 3600e3).toISOString();
    jobs.push({
      id: `seed-${i}-${Date.now().toString(36)}`,
      taskId: `seed-task-${i}`,
      subId: null,
      title: `合成历史执行 #${i}`,
      status: 'done',
      prompt: 'seed prompt',
      output: 'ok',
      thinking,
      toolCalls: Array.from({ length: 4 }, (_, k) => ({
        id: `seed-${i}-tool-${k}`,
        name: 'Bash',
        argsPreview: 'ls',
        arguments: argsBody,
        result: resultBody,
        status: 'done',
      })),
      pid: null,
      startedAt: started,
      lastActivityAt: started,
      endedAt: started,
      exitCode: 0,
      error: null,
      agent: 'claude',
    });
  }
  const file = path.join(dir, 'jobs.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, jobs }));
  return fs.statSync(file).size;
}

function startServer({ sandbox, port }) {
  const log = [];
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--no-open'], {
    cwd: sandbox,
    env: {
      ...process.env,
      PORT: String(port),
      HOME: sandbox,
      USERPROFILE: sandbox,
      ZEN_PERF: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const onChunk = (tag) => (buf) => {
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      log.push(`[${tag}] ${line}`);
      if (log.length > 400) log.shift();
    }
  };
  child.stdout.on('data', onChunk('out'));
  child.stderr.on('data', onChunk('err'));
  return { child, log };
}

async function waitServerUp(port, child) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务进程提前退出(code=${child.exitCode})`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/workbench/current-project`);
      if (res.ok) return;
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error('服务启动超时');
}

async function killServer(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      k.on('exit', resolve);
      k.on('error', resolve);
    });
  } else {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
}

// ── 主流程 ──────────────────────────────────────────────────
async function main() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-sse-verify-'));
  const port = await pickFreePort();
  console.log(`\n[SSE 链路验证] 沙箱=${sandbox}`);
  console.log(`[SSE 链路验证] 隔离端口=${port}（真实 g ui 不受影响）\n`);

  const { child, log } = startServer({ sandbox, port });
  let exitCode = 0;
  try {
    await waitServerUp(port, child);
    console.log('[SSE 链路验证] 服务已就绪\n');

    // ── 1-3. /api/workbench/events：头 / hello / 保活 / 事件推送 ──
    const es = openSse(port, '/api/workbench/events');
    let taskId = null;

    await step('workbench/events · 响应头齐全（text/event-stream + 禁缓存 + 禁代理缓冲）', async () => {
      await waitFor(() => es.headers, 8000, 'SSE 响应头');
      assert(es.status === 200, `status=${es.status}`);
      const ct = String(es.headers['content-type'] || '');
      const cc = String(es.headers['cache-control'] || '');
      assert(ct.includes('text/event-stream'), `content-type=${ct}`);
      assert(cc.includes('no-cache'), `cache-control=${cc}`);
      assert(cc.includes('no-transform'), `cache-control 缺 no-transform: ${cc}`);
      assert(String(es.headers['x-accel-buffering'] || '') === 'no', 'x-accel-buffering 不是 no');
      return `content-type=${ct}`;
    });

    await step('workbench/events · 首帧 hello 立刻到达且带 jobs 快照', async () => {
      const first = await waitFor(() => es.events[0], 8000, 'hello 帧');
      assert(first.parsed && first.parsed.event === 'hello', `首帧不是 hello: ${first.raw.slice(0, 120)}`);
      assert(Array.isArray(first.parsed.payload && first.parsed.payload.jobs), 'hello.payload.jobs 不是数组');
      const delta = first.at - es.connectedAt;
      assert(delta < 3000, `hello 迟到 ${delta}ms（应在建立后立刻写）`);
      return `${delta}ms 到达，jobs=${first.parsed.payload.jobs.length} 条`;
    });

    await step('workbench/events · 真实事件推送（task:update 端到端走通总线）', async () => {
      const created = await jsonApi(port, 'POST', '/api/workbench/tasks', {
        title: 'sse-verify-tmp',
        desc: 'SSE 链路验证用临时任务，验证结束即删',
      });
      assert(created.status === 200 && created.json && created.json.task, `建任务失败: ${created.status} ${created.text.slice(0, 200)}`);
      taskId = created.json.task.id;

      const before = es.events.length;
      const done = await jsonApi(port, 'POST', `/api/workbench/tasks/${taskId}/done`);
      assert(done.status === 200, `标记完成失败: ${done.status} ${done.text.slice(0, 200)}`);

      const frame = await waitFor(
        () => es.events.slice(before).find((e) => e.parsed && e.parsed.event === 'task:update' && e.parsed.payload && e.parsed.payload.id === taskId),
        5000,
        'task:update 帧',
      );
      assert(frame.parsed.payload.manualDoneAt, 'task:update 载荷缺 manualDoneAt');
      return `task:update(id=${taskId}) 在 ${frame.at - es.connectedAt}ms 内送达`;
    });

    await step(`workbench/events · 保活间隔 ≈${HEARTBEAT_MS}ms（Firefox 断流红线）`, async () => {
      const need = 3; // 3 条注释 = 2 个间隔，单个间隔说明不了稳定性
      await waitFor(() => es.comments.length >= need, HEARTBEAT_MS * 2 + 6000, `${need} 条 keep-alive`);
      const gaps = [];
      for (let i = 1; i < es.comments.length; i++) gaps.push(es.comments[i].at - es.comments[i - 1].at);
      const bad = gaps.filter((g) => Math.abs(g - HEARTBEAT_MS) > HEARTBEAT_TOLERANCE);
      assert(bad.length === 0, `心跳间隔超出容差: ${gaps.join(' / ')}ms`);
      // 注释不能混进 data 帧
      assert(es.events.every((e) => !e.raw.startsWith(':')), 'keep-alive 被当成了 data 帧');
      return `间隔 ${gaps.join(' / ')}ms`;
    });

    await step('workbench/events · 断开后服务端不崩，重连能重新拿到 hello', async () => {
      es.close();
      await sleep(400);
      assert(child.exitCode === null, '客户端断开后服务进程退出了');
      // 断开后再推一次事件：若服务端没摘掉 handler，这里会往已关闭的 res 写
      if (taskId) await jsonApi(port, 'DELETE', `/api/workbench/tasks/${taskId}/done`).catch(() => {});
      await sleep(600);
      assert(child.exitCode === null, '断线后触发事件把服务端打崩了');

      const again = openSse(port, '/api/workbench/events');
      try {
        const hello = await waitFor(() => again.events[0], 8000, '重连后的 hello');
        assert(hello.parsed && hello.parsed.event === 'hello', '重连首帧不是 hello');
      } finally {
        again.close();
      }
      const writeErr = log.find((l) => /write after end|ERR_STREAM_WRITE_AFTER_END|Cannot call write/i.test(l));
      assert(!writeErr, `服务端日志出现写已关闭流的报错: ${writeErr}`);
      return '无 write-after-end / 进程存活 / 可重连';
    });

    // ── 4. /api/schedules/events ──
    await step('schedules/events · 头 + hello 首帧', async () => {
      const s = openSse(port, '/api/schedules/events');
      try {
        await waitFor(() => s.headers, 8000, 'schedules SSE 响应头');
        assert(s.status === 200, `status=${s.status}`);
        assert(String(s.headers['content-type'] || '').includes('text/event-stream'), `content-type=${s.headers['content-type']}`);
        assert(String(s.headers['cache-control'] || '').includes('no-transform'), 'cache-control 缺 no-transform');
        const hello = await waitFor(() => s.events[0], 8000, 'schedules hello');
        assert(hello.parsed && hello.parsed.type === 'hello', `首帧不是 hello: ${hello.raw.slice(0, 120)}`);
        assert(Array.isArray(hello.parsed.running), 'hello.running 不是数组');
        return `running=${hello.parsed.running.length}`;
      } finally {
        s.close();
      }
    });

    // ── 5. /api/agent/chat ──
    await step('agent/chat · 空消息直接 400（不进流）', async () => {
      const r = await jsonApi(port, 'POST', '/api/agent/chat', { userMessage: '', cwd: sandbox });
      assert(r.status === 400, `status=${r.status} body=${r.text.slice(0, 160)}`);
      assert(r.json && r.json.success === false, '不是约定的 {success:false} 形状');
      return `400 ${r.json.error}`;
    });

    await step('agent/chat · 未配模型时也是「SSE 头 + 立即首字节 + error 帧 + 收尾」', async () => {
      const body = JSON.stringify({ userMessage: 'sse-verify ping', cwd: sandbox });
      const c = openSse(port, '/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        body,
      });
      try {
        await waitFor(() => c.headers, 10000, 'chat SSE 响应头');
        assert(c.status === 200, `status=${c.status}`);
        assert(String(c.headers['content-type'] || '').includes('text/event-stream'), `content-type=${c.headers['content-type']}`);
        assert(String(c.headers['cache-control'] || '').includes('no-transform'), 'cache-control 缺 no-transform');
        // 首字节必须是惰性注释：Firefox 在收到第一个 body 字节前不把流交给 fetch
        await waitFor(() => c.raw.length > 0, 5000, '首字节');
        assert(c.raw.startsWith(':\n\n'), `首字节不是惰性注释: ${JSON.stringify(c.raw.slice(0, 16))}`);
        const err = await waitFor(() => c.events.find((e) => e.parsed && e.parsed.type === 'error'), 8000, 'error 帧');
        assert(/模型/.test(String(err.parsed.error || '')), `error 帧内容不符合预期: ${err.parsed.error}`);
        await waitFor(() => c.endedAt, 8000, '流收尾');
        return `error 帧=${err.parsed.error}`;
      } finally {
        c.close();
      }
    });

    // ── 6. /api/exec-stream ──
    await step('exec-stream · process_id / stdout / exit 三种帧齐活', async () => {
      const body = JSON.stringify({ command: 'node -e "console.log(\'sse-ok\')"' });
      const c = openSse(port, '/api/exec-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        body,
      });
      try {
        await waitFor(() => c.headers, 10000, 'exec SSE 响应头');
        assert(c.status === 200, `status=${c.status}`);
        assert(String(c.headers['content-type'] || '').includes('text/event-stream'), `content-type=${c.headers['content-type']}`);
        await waitFor(() => c.events.some((e) => e.parsed && e.parsed.type === 'process_id'), 8000, 'process_id 帧');
        await waitFor(() => c.events.some((e) => e.parsed && e.parsed.type === 'stdout'), 15000, 'stdout 帧');
        const exit = await waitFor(() => c.events.find((e) => e.parsed && e.parsed.type === 'exit'), 15000, 'exit 帧');
        const out = c.events.filter((e) => e.parsed && e.parsed.type === 'stdout').map((e) => e.parsed.data).join('');
        assert(out.includes('sse-ok'), `stdout 内容不含 sse-ok: ${JSON.stringify(out)}`);
        assert(exit.parsed.data && exit.parsed.data.code === 0, `exit code=${exit.parsed.data && exit.parsed.data.code}`);
        return `stdout=${JSON.stringify(out.trim())} exit=0`;
      } finally {
        c.close();
      }
    });

    // ── 7. 大档案下的 hello 体积（真机上 70MB 的复现闸门） ──
    await step('大档案（合成 40 条重执行记录）下 hello 首帧不膨胀', async () => {
      const size = seedHeavyJobs(sandbox, 40);
      const c = openSse(port, '/api/workbench/events');
      try {
        await waitFor(() => c.headers, 10000, 'SSE 响应头');
        await waitFor(() => c.firstFrame, 45000, 'hello 首帧收完');
        const mb = c.firstFrame.bytes / 1048576;
        const ms = c.firstFrame.at - c.connectedAt;
        assert(mb <= HELLO_MAX_MB, `hello 首帧 ${mb.toFixed(1)}MB（上限 ${HELLO_MAX_MB}MB，用时 ${ms}ms）：快照把每条 job 的 output/thinking/toolCalls 全文都推了下来`);
        assert(ms <= HELLO_MAX_MS, `hello 首帧 ${ms}ms 才收完（上限 ${HELLO_MAX_MS}ms，体积 ${mb.toFixed(1)}MB）`);
        return `jobs.json=${(size / 1048576).toFixed(1)}MB → hello=${mb.toFixed(2)}MB / ${ms}ms`;
      } finally {
        c.close();
      }
    });

    // ── 8. 其它 SSE 端点的静态清点（防止文档/代码漂移） ──
    await step('静态清点 · 代码里所有 SSE 端点仍在（防止漏改一条流）', async () => {
      const files = [
        'src/ui/server/routes/workbench/index.js',
        'src/ui/server/routes/workbench/scheduleRoutes.js',
        'src/ui/server/routes/workbench/agentRoutes.js',
        'src/ui/server/routes/exec.js',
        'src/ui/server/routes/gitOps.js',
        'src/ui/server/routes/codeAnalysis.js',
        'src/ui/server/routes/recentDirectoriesAiSummary.js',
        'src/ui/server/routes/git/aiDiffSummary.js',
      ];
      const missing = files.filter((f) => {
        const p = path.join(ROOT, f);
        if (!fs.existsSync(p)) return true;
        return !fs.readFileSync(p, 'utf8').includes('text/event-stream');
      });
      assert(missing.length === 0, `这些文件里已经找不到 text/event-stream: ${missing.join(', ')}`);
      return `${files.length} 个 SSE 产出点均存在`;
    });

    // 清理临时任务
    if (taskId) await jsonApi(port, 'DELETE', `/api/workbench/tasks/${taskId}`).catch(() => {});
  } catch (err) {
    record('引导阶段', false, err && err.message ? err.message : String(err));
  } finally {
    await killServer(child);
    const failed = results.filter((r) => !r.ok);
    exitCode = failed.length ? 1 : 0;
    console.log(`\n[SSE 链路验证] ${results.length - failed.length}/${results.length} 通过`);
    if (failed.length) {
      console.log('\n失败明细:');
      failed.forEach((f) => console.log(`  · ${f.name}: ${f.detail}`));
      console.log('\n服务端日志尾部:');
      log.slice(-40).forEach((l) => console.log('  ' + l));
    }
    if (KEEP || failed.length) {
      console.log(`\n[SSE 链路验证] 沙箱保留: ${sandbox}`);
    } else {
      try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error('[SSE 链路验证] 未捕获异常:', e);
  process.exit(1);
});

// Copyright 2026 xz333221
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// 任务执行引擎：spawn claude CLI 跑子任务，流式收集输出，更新 job 状态。
// 拆分自原 routes/workbench.js 1108-1564 行。
//
// 核心 API：
//   - launchClaudeInNewWindow(cwd, prompt, resumeSessionId)  spawn claude，返回 {pid, child}
//   - runTaskQueue(task, repoPath, branch, opts)             顺序执行 task.subtasks
//   - runSingleSubtask(task, sub, repoPath, branch, priorOutputs, opts)  跑单个 sub
//   - syncSubToCancelled(job)                                cancel 路径专用
//   - persistTaskAfterRun(task)                              把 sub.status 落回 tasks.json
//   - collectPriorOutputs(task, targetSub)                   收集前序 done sub 的输出
//   - waitProcessExit(pid)                                   polling 等进程退出

import fs from 'fs';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import {
  logger,
  PROMPTS_FILE,
  TASKS_FILE,
  readJson,
  writeJson,
  nowIso,
  genId,
  interpolate,
} from './shared.js';
import { buildAttachmentBlock } from './pdfText.js';
import {
  jobs,
  cancelledJobs,
  publish,
  snapshotJobs,
  flushJobsSaveNow,
} from './jobStore.js';

// 用 detached 进程跑 claude；进程退出时回填状态。
// 返回 { pid, child }：调用方可以监听 child.stdout/stderr 实时收集输出。
// 不再走 cmd /k 弹窗——claude -p 是非交互模式，输出通过 stdout pipe 实时回传
// 到前端面板展示。
export function launchClaudeInNewWindow(cwd, promptText, resumeSessionId) {
  return new Promise((resolve, reject) => {
    const args = [];
    // 续接历史会话:--resume 必须放在 -p 之前,确保 claude CLI 先识别 resume 上下文
    if (resumeSessionId) {
      args.push('--resume', String(resumeSessionId));
    }
    args.push(
      // -p '-' 让 claude CLI 从 stdin 读取 prompt —— 避免 Windows 命令行 32K 长度上限
      // (spawn argv 会拼成 cmdline 给 CreateProcess,长 prompt 直接 ENAMETOOLONG)
      '-p', '-',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--dangerously-skip-permissions'
    );
    let child;
    let spawnedExe = 'claude';
    if (process.platform === 'win32') {
      // 直接 spawn claude.exe（npm 全局 @anthropic-ai/claude-code 里的真实二进制），
      // 避开两件事：
      //  1. Node 23 在 Windows 上拒绝 spawn .cmd/.bat（EINVAL）
      //  2. shell:true 会把 argv 拼成命令行交给 cmd 解释，prompt 里的 \n 被切成多段
      // 用 `where claude` 找到 claude.cmd，再从 cmd 内容推断对应 .exe 路径。
      let claudeExe = 'claude.exe';
      try {
        const cmdShim = execFileSync('where', ['claude'], { encoding: 'utf8', windowsHide: true })
          .split(/\r?\n/).map(s => s.trim()).find(s => /\.cmd$/i.test(s));
        if (cmdShim) {
          const txt = fs.readFileSync(cmdShim, 'utf8');
          if (/%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude\.exe/i.test(txt)) {
            claudeExe = path.join(path.dirname(cmdShim), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
          }
        }
      } catch { /* fallback */ }
      spawnedExe = claudeExe;
      child = spawn(claudeExe, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: false,
        env: { ...process.env, LANG: 'zh_CN.UTF-8' }
      });
    } else {
      // macOS / Linux：直接 spawn claude（Node spawn 不走 shell，
      // prompt 中的引号 / 反斜杠无需手动 escape）
      child = spawn('claude', args, {
        cwd,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, LANG: 'zh_CN.UTF-8' }
      });
    }
    child.on('error', reject);
    child.on('spawn', () => {
      // unref 让 claude 独立于父进程事件循环；返回 child 引用让调用方继续读 stdout。
      child.unref();
      // 长 prompt 通过 stdin 喂入(避开 Windows CreateProcess 32K 命令行上限)。
      // 必须在 spawn 事件回调里 write,而不是 resolve 前同步 write——因为 spawn
      // 返回时 child.stdin 句柄可能尚未绑定到真正的 pipe fd。
      // write 完成后必须 end(),否则 claude CLI 会一直阻塞在读 stdin 上 → hang。
      try {
        child.stdin.write(promptText, () => {
          try { child.stdin.end(); } catch { /* 子进程已关闭,忽略 */ }
        });
      } catch (err) {
        // stdin 写入失败不要让 spawn 整体 reject —— 让 child 自然以错误状态收尾,
        // 后面的 stdout/stderr 监听会捕获到 LLM 端反馈。
        logger.warn('[workbench] stdin write failed:', err && err.message || err);
      }
      resolve({ pid: child.pid, child });
    });
  });
}

/**
 * 顺序执行一个任务下所有子任务；上一个结束再启动下一个。
 * 入参 fromIndex 指定从哪个 sub 开始(0-based,默认 0),用于"从此处开始"入口;
 * fromIndex>0 时,把 [0, fromIndex) 区间内已 done 的 sub 输出预填到 priorOutputs,
 * 这样后续 sub 仍能拿到前序上下文(跟单 sub 执行的语义保持一致)。
 *
 * 连续模式（默认）：任意 sub 终态非 done（cancelled / error）→ 整批停，后续 sub 保持 todo。
 * AI 拆出来的 sub 一般前后强依赖（前一步产出是后一步输入），出错就停下来让用户决策。
 * 关闭后回退旧行为：单个 sub 失败不影响后续 sub 继续跑。
 */
export async function runTaskQueue(task, repoPath, branch, opts) {
  // 前序上下文:跑完一个 sub 后把它"完成态"输出存到这里,下一个 sub 启动时
  // 拼到 prompt 头部,让 Claude 知道前面做了什么、产出了什么。
  // 现在 LLM 都是百万 token 上下文窗口,完整透传 raw output,不做截断——
  // 关键产物(生成的代码块、JSON、结论)在中间被砍掉反而会让后续 sub 失去依据。
  const requested = Number(opts && opts.fromIndex);
  const fromIndex = Number.isInteger(requested) && requested >= 0 && requested < task.subtasks.length
    ? requested
    : 0;
  // 从 fromIndex 开始时,把前面已 done 的 sub 输出预填进 priorOutputs,
  // 否则"从中间开始"会丢失前序上下文。
  const priorOutputs = fromIndex > 0
    ? await collectPriorOutputsUpTo(task, fromIndex)
    : [];
  const sequential = task.sequential !== false;
  for (let i = fromIndex; i < task.subtasks.length; i++) {
    const sub = task.subtasks[i];
    if (sub.status === 'done') continue;
    const outcome = await runSingleSubtask(task, sub, repoPath, branch, priorOutputs);
    // 逐 sub 落盘:之前只在队列跑完才 persistTaskAfterRun,中途崩溃会丢已完成
    // sub 的状态。runSingleSubtask 已经把 sub.status 改完,这里补一次落盘。
    await persistTaskAfterRun(task);
    if (sequential && outcome !== 'done') {
      // cancelled / error → 后续 sub 全部保持 todo，不再继续
      break;
    }
  }
}

/**
 * 执行单个子任务。被 runTaskQueue(整批)和"单 sub 执行"endpoint 共用。
 *
 * @param {object} task         主任务对象
 * @param {object} sub          要跑的子任务
 * @param {string} repoPath     仓库路径
 * @param {string} branch       分支名（可空）
 * @param {Array<{title:string,output:string}>} priorOutputs
 *        前序 done 子任务的输出摘要（in-place 追加）。用于把同一任务下
 *        前面已完成的 sub 产物拼到当前 sub 的 prompt 头部，让 Claude
 *        知道上下文。单独跑一个 sub 时，这个数组里只会有"前面 done 的 sub"。
 * @param {object} [options]
 * @param {string|null} [options.resumeSessionId]
 *        续接历史 claude 会话:传入上一轮通过 stream-json 的 system.init
 *        事件捕获到的 session_id,本轮以 --resume <id> 启动,claude 会带着
 *        上下文继续对话。前端"简单任务执行完成后继续聊"走的就是这条路径。
 * @returns {Promise<'done'|'cancelled'|'error'>} sub 的终态
 */
export async function runSingleSubtask(task, sub, repoPath, branch, priorOutputs, options) {
  const opts = options || {};
  const resumeSessionId = opts.resumeSessionId || null;
  const promptTemplate = sub.promptOverride || (task.promptId
    ? (await readJson(PROMPTS_FILE, { prompts: [] })).prompts.find(p => p.id === task.promptId)?.content
    : null) || '';
  const ctx = {
    task: { title: task.title, desc: task.desc || '' },
    sub: { title: sub.title, desc: sub.desc || '' },
    repo: { path: repoPath || '' },
    branch: branch || ''
  };
  const interpolated = interpolate(promptTemplate, ctx);
  const parts = [interpolated, sub.title, sub.desc].filter(s => s && s.trim());
  let prompt = parts.join('\n\n');

  // ── 前序上下文：把前几个 done 子任务的输出完整拼到 prompt 头部 ──
  if (priorOutputs && priorOutputs.length > 0) {
    const prevBlock = priorOutputs.map((p, i) => {
      return `### [${i + 1}] ${p.title}\n${p.output || ''}`;
    }).join('\n\n');
    prompt = `以下是同一任务下已经完成的前序子任务输出（仅作上下文参考，请基于这些结论继续当前子任务，无需重复执行它们）：

${prevBlock}

---

${prompt}`;
  }

  // ── 附件：合并 sub.attachments + task.attachments 后拼到 prompt 末尾 ──
  // PDF 附件在服务端预提取全文(Claude CLI v2.1.x 的 pdfParse 有 bug),
  // 图片和其他文件仍列路径让 Claude CLI 直接读取。
  // 主任务附件对所有 sub 都可见；子任务自己的附件只对该 sub 可见。
  // 注意：run-simple 路径下 virtualSub.attachments 就是 task.attachments 的同一引用，
  // 不去重会把同一张图在 prompt 里列两遍。按 absolutePath 去重。
  const taskAtts = Array.isArray(task.attachments) ? task.attachments : [];
  const subAtts = Array.isArray(sub.attachments) ? sub.attachments : [];
  const seen = new Set();
  const allAttachments = [];
  for (const a of [...subAtts, ...taskAtts]) {
    if (!a || !a.absolutePath) continue;
    if (seen.has(a.absolutePath)) continue;
    seen.add(a.absolutePath);
    allAttachments.push(a);
  }
  if (allAttachments.length > 0) {
    const { block: attachmentBlock } = await buildAttachmentBlock(allAttachments);
    if (attachmentBlock) {
      prompt += `\n\n---\n本任务包含 ${allAttachments.length} 个附件（请按文件路径读取，不要让用户重新提供）：${attachmentBlock}\n---`;
    }
  }

  const jobId = genId();
  const job = {
    id: jobId,
    taskId: task.id,
    subId: sub.id,
    title: `${task.title} / ${sub.title}`,
    status: 'pending',
    prompt,
    // 续接历史会话时先填上,首条 system.init 事件回来后再用真值覆盖(通常等同)
    claudeSessionId: resumeSessionId
  };
  jobs.set(jobId, job);
  sub.status = 'running';
  publish('sub:update', { taskId: task.id, sub });
  publish('job:update', job);

  try {
    const { pid, child } = await launchClaudeInNewWindow(repoPath || process.cwd(), prompt, resumeSessionId);
    job.pid = pid;
    // 保存 child 引用，供 cancel 接口调用 kill
    job.child = child;
    job.startedAt = nowIso();
    job.status = 'running';
    publish('job:update', job);

    // 流式 NDJSON 解析：把 stdout 当作 stream-json 协议处理
    //   assistant.text       → job.output    （用户主要关心的内容）
    //   assistant.thinking   → job.thinking  （折叠展示，让用户知道 Claude 在想）
    //   其他事件（init / tool_use / result 等）忽略，避免噪声
    const MAX_OUTPUT = 100 * 1024 * 1024;
    const MAX_THINKING = 100 * 1024 * 1024;
    job.output = '';
    job.thinking = '';
    const lineBuf = { stdout: '', stderr: '' };

    const parseLines = (channel, buf) => {
      const chunk = buf.toString('utf8');
      lineBuf[channel] += chunk;
      const lines = lineBuf[channel].split('\n');
      lineBuf[channel] = lines.pop() ?? ''; // 最后一段可能不完整，留给下次
      let pendingThinkingDelta = '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (channel === 'stderr' || !trimmed.startsWith('{')) {
          // 非 stream-json 行：原样塞进 output（兼容老版本 claude / 错误信息）
          const prevLen = job.output.length;
          job.output = (job.output + trimmed + '\n').slice(-MAX_OUTPUT);
          const delta = job.output.slice(prevLen);
          if (delta) publish('job:output-delta', { id: job.id, delta });
          continue;
        }
        let evt;
        try { evt = JSON.parse(trimmed); } catch { continue; }
        // 捕获 system.init 里的 session_id,供后续"续接对话"用(--resume <id>)
        if (evt.type === 'system' && evt.subtype === 'init' && typeof evt.session_id === 'string') {
          if (!job.claudeSessionId || job.claudeSessionId !== evt.session_id) {
            job.claudeSessionId = evt.session_id;
            publish('job:update', job);
          }
          continue;
        }
        if (evt.type !== 'assistant') continue;
        const blocks = evt.message?.content;
        if (!Array.isArray(blocks)) continue;
        for (const b of blocks) {
          if (b.type === 'text' && typeof b.text === 'string') {
            const prevLen = job.output.length;
            job.output = (job.output + b.text).slice(-MAX_OUTPUT);
            const delta = job.output.slice(prevLen);
            if (delta) publish('job:output-delta', { id: job.id, delta });
          } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
            const prevLen = job.thinking.length;
            job.thinking = (job.thinking + b.thinking).slice(-MAX_THINKING);
            const delta = job.thinking.slice(prevLen);
            if (delta) pendingThinkingDelta += delta;
          }
        }
      }
      // 一批 NDJSON 处理完后统一发一次 thinking delta，避免高频小块 socket 占用
      if (pendingThinkingDelta) {
        publish('job:thinking-delta', { id: job.id, delta: pendingThinkingDelta });
      }
    };
    if (child.stdout) child.stdout.on('data', (buf) => parseLines('stdout', buf));
    if (child.stderr) child.stderr.on('data', (buf) => parseLines('stderr', buf));

    // 等待进程退出（detached 不阻塞主进程，用 polling /proc 兜底）
    await waitProcessExit(pid);
    const wasCancelled = cancelledJobs.has(jobId);
    if (wasCancelled) cancelledJobs.delete(jobId);
    // 进程退出时 stdout 可能残留最后一段未换行的 NDJSON，flush 一次
    if (lineBuf.stdout.trim()) {
      const outPrev = job.output.length;
      const thinkPrev = job.thinking.length;
      try {
        const evt = JSON.parse(lineBuf.stdout.trim());
        if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
          for (const b of evt.message.content) {
            if (b.type === 'text' && typeof b.text === 'string') {
              job.output = (job.output + b.text).slice(-MAX_OUTPUT);
            } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
              job.thinking = (job.thinking + b.thinking).slice(-MAX_THINKING);
            }
          }
        }
      } catch { /* 不是 JSON，忽略 */ }
      const outDelta = job.output.slice(outPrev);
      if (outDelta) publish('job:output-delta', { id: job.id, delta: outDelta });
      const thinkDelta = job.thinking.slice(thinkPrev);
      if (thinkDelta) publish('job:thinking-delta', { id: job.id, delta: thinkDelta });
    }
    job.endedAt = nowIso();
    if (wasCancelled) {
      job.exitCode = 130; // 128 + SIGINT(2)，约定俗成的"用户取消"退出码
      job.status = 'cancelled';
      job.error = '用户已停止执行';
      // 同步把闭包里的 sub 也置 cancelled（cancel 接口的 syncSubToCancelled 改了磁盘 task
      // 引用，但 runSingleSubtask 形参里的 sub 是另一份内存引用）。否则 finally publish sub:update
      // 会用 status='running' 覆盖掉前端已渲染的 cancelled 状态，导致 UI 反复跳回 running。
      sub.status = 'cancelled';
      if (!sub.error) sub.error = '用户已停止执行';
    } else {
      job.exitCode = 0;
      job.status = 'done';
      sub.status = 'done';
      // 把这个 sub 的输出累积到前序上下文，喂给下一个 sub
      if (priorOutputs) priorOutputs.push({ title: sub.title, output: job.output || '' });
    }
  } catch (err) {
    const errMsg = err && err.message ? err.message : String(err);
    job.error = errMsg;
    job.status = 'error';
    sub.status = 'error';
    sub.error = errMsg;
    sub.errorAt = nowIso();
  } finally {
    // 移除 child 引用——避免后续被 SSE 序列化到前端
    delete job.child;
    publish('job:update', job);
    publish('sub:update', { taskId: task.id, sub });
    // 终态：await 同步落盘,确保 done/cancelled/error 全部立即归档。
    try {
      await flushJobsSaveNow();
    } catch (err) {
      logger.warn('[workbench] flushJobsSaveNow failed (job id=' + job.id + ', status=' + job.status + '):', err && err.message || err);
    }
  }
  // 把 sub 的终态返回给 runTaskQueue，用于「连续模式」判断要不要 break 整批队列
  return job.status;  // 'done' | 'cancelled' | 'error'
}

/**
 * 把被取消的 sub 同步置 'cancelled' 并落盘。
 * cancelJob 路径专用：前端 taskIsRunning/sub.is-running 都看 sub.status，不改就会出现
 * "主任务黄点 + sub running 动效 + 右侧执行完成"三处不一致。
 *
 * 简单任务的虚拟 subId 不在 tasks.json 里（task.subtasks 是 complex 才有），所以这里
 * 找不到 sub 时静默返回；简单任务的 running 状态由 job 数组单独维护（见 taskIsRunning）。
 *
 * @returns {{ taskId: string, sub: object } | null}  找到并更新时返回新 sub，否则 null
 */
export async function syncSubToCancelled(job) {
  if (!job || !job.taskId || !job.subId) return null;
  const data = await readJson(TASKS_FILE, { tasks: [] });
  const task = (data.tasks || []).find(x => x.id === job.taskId);
  if (!task || !Array.isArray(task.subtasks)) return null;
  const sub = task.subtasks.find(s => s && s.id === job.subId);
  if (!sub) return null;
  if (sub.status === 'cancelled') return { taskId: task.id, sub };  // 已置过，幂等返回
  sub.status = 'cancelled';
  sub.error = '用户已停止执行';
  sub.errorAt = nowIso();
  task.updatedAt = nowIso();
  await writeJson(TASKS_FILE, data);
  publish('sub:update', { taskId: task.id, sub });
  publish('task:update', task);
  return { taskId: task.id, sub };
}

/** 把 task.subtasks 写回 tasks.json,并广播 task:update。runTaskQueue 和"单 sub 执行"共用。 */
export async function persistTaskAfterRun(task) {
  const data = await readJson(TASKS_FILE, { tasks: [] });
  const t = data.tasks.find(x => x.id === task.id);
  if (t) {
    // 仅同步 status 之外的 error/errorAt 字段，避免覆盖用户编辑过的 title/desc 等。
    const newMap = new Map(task.subtasks.map(s => [s.id, s]));
    t.subtasks = (t.subtasks || []).map(old => {
      const fresh = newMap.get(old.id);
      if (!fresh) return old;
      return {
        ...old,
        status: fresh.status ?? old.status,
        error: fresh.error ?? old.error,
        errorAt: fresh.errorAt ?? old.errorAt,
      };
    });
    t.updatedAt = nowIso();
    await writeJson(TASKS_FILE, data);
    publish('task:update', t);
  }
}

/**
 * 构建单 sub 执行时的 priorOutputs：把同一 task 下"排在当前 sub 之前"且已 done 的
 * 子任务输出摘要收集起来。这样单独跑一个 sub 时,它也能拿到前序上下文。
 */
export async function collectPriorOutputs(task, targetSub) {
  const targetIdx = task.subtasks.findIndex(s => s.id === targetSub.id);
  if (targetIdx < 0) return [];
  return collectPriorOutputsUpTo(task, targetIdx);
}

/**
 * 收集 [0, endIdx) 区间内已 done 的 sub 输出摘要,作为队列内 sub 的前序上下文。
 * runTaskQueue 在 fromIndex>0 时调这个,让"从此处开始"也能拼上前序 done sub 的结论。
 */
export async function collectPriorOutputsUpTo(task, endIdx) {
  const prior = [];
  for (let i = 0; i < endIdx; i++) {
    const s = task.subtasks[i];
    if (s.status !== 'done') continue;
    // 从 jobs 列表里找最近一个属于这个 sub 且 status=done 的 job,
    // 取其 output 作为"前序上下文"。完整透传,不做字符截断。
    const job = snapshotJobs()
      .filter(j => j.subId === s.id && j.status === 'done')
      .sort((a, b) => (b.endedAt || '').localeCompare(a.endedAt || ''))[0];
    if (!job) continue;
    prior.push({ title: s.title, output: job.output || '' });
  }
  return prior;
}

// polling 等进程退出：信号 0 探测存活；30 分钟超时兜底
export function waitProcessExit(pid) {
  return new Promise(resolve => {
    let exited = false;
    const tryCheck = () => {
      if (exited) return;
      try {
        process.kill(pid, 0); // 信号 0 = 探测存活
      } catch (err) {
        // 只在进程真的消失（ESRCH / EPERM）时才 resolve；
        if (err && (err.code === 'ESRCH' || err.code === 'EPERM')) {
          exited = true;
          resolve();
          return;
        }
      }
      setTimeout(tryCheck, 1500);
    };
    tryCheck();
    // 兜底：30 分钟超时自动结束
    setTimeout(() => { if (!exited) { exited = true; resolve(); } }, 30 * 60 * 1000);
  });
}

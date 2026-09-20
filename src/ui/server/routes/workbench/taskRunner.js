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
// 任务执行引擎：spawn 本地 agent CLI 跑子任务，流式收集输出，更新 job 状态。
// 拆分自原 routes/workbench.js 1108-1564 行。
//
// 支持两种执行器（executor）：
//   - claude   —— claude -p --output-format stream-json（默认，历史行为）
//   - opencode —— opencode run --format json --auto（sst/opencode CLI，跟随其自身默认模型）
//
// 核心 API：
//   - launchClaudeInNewWindow(cwd, prompt, resumeSessionId)  spawn claude，返回 {pid, child}
//   - launchOpencodeRun(cwd, prompt, resumeSessionId)        spawn opencode，返回 {pid, child}
//   - normalizeTaskExecutor(value)                           非法值回落 'claude'
//   - runTaskQueue(task, repoPath, branch, opts)             顺序执行 task.subtasks（opts.executor 透传）
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
import { composePromptBody } from './promptParts.js';
import {
  jobs,
  cancelledJobs,
  publish,
  snapshotJobs,
  refreshJobsFromDisk,
  flushJobsSaveNow,
} from './jobStore.js';

// ── 运行环境上下文的提供者 ────────────────────────────────────────────────
// 为什么用注入而不是在这里直接读：拼这份上下文要「最近目录」（在 configManager 上），
// 而 taskRunner 拿不到 configManager —— 它是路由层的东西。与其在这里再造一条
// 读取最近目录的路径（口径分叉的老套路），不如让路由层注册时把函数递进来。
//
// 未注入时静默跳过：上下文是锦上添花，不能因为没接线就让整个执行引擎跑不起来。
let envContextProvider = null;

/**
 * 注册运行环境上下文的提供者。由 routes/workbench/index.js 在注册路由时调用。
 * @param {(ctx: {repoPath: string}) => Promise<string|null>|string|null} fn
 */
export function setEnvContextProvider(fn) {
  envContextProvider = typeof fn === 'function' ? fn : null;
}

/**
 * 取本次执行的运行环境上下文块。
 *
 * 提供者抛错一律降级成"没有上下文"：读 tasks.json 失败、配置竞态都是可能发生的，
 * 但它们都不该让用户的指令执行不了 —— 与「读不到最近目录不该让整个看板挂掉」同一条原则。
 */
async function resolveEnvContext(repoPath) {
  if (!envContextProvider) return '';
  try {
    const block = await envContextProvider({ repoPath: repoPath || '' });
    return typeof block === 'string' ? block : '';
  } catch (err) {
    logger.warn(`[workbench] 运行环境上下文注入失败，本次跳过: ${err.message}`);
    return '';
  }
}

// 用 detached 进程跑 claude；进程退出时回填状态。
// 返回 { pid, child }：调用方可以监听 child.stdout/stderr 实时收集输出。
// 不再走 cmd /k 弹窗——claude -p 是非交互模式，输出通过 stdout pipe 实时回传
// 到前端面板展示。
export function launchClaudeInNewWindow(cwd, promptText, resumeSessionId) {  return new Promise((resolve, reject) => {
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
      // 避开两件事:
      //  1. Node 23 在 Windows 上拒绝 spawn .cmd/.bat(EINVAL)
      //  2. shell:true 会把 argv 拼成命令行交给 cmd 解释,prompt 里的 \n 被切成多段
      // 用 `where claude` 找到 claude.cmd,优先按 npm 全局 shim 实际行为走:
      // 直接 spawn(process.execPath, [cliJs, ...])。原代码读 shim 内容推断
      // bin\claude.exe 路径,但当前 claude-code 已经改成走 `node cli.js`,
      // shim 内容正则匹配不上 → 落回 'claude.exe' → spawn ENOENT。
      let claudeExe = 'claude.exe';
      let spawnExe = null;
      let spawnArgs = args;
      try {
        const cmdShim = execFileSync('where', ['claude'], { encoding: 'utf8', windowsHide: true })
          .split(/\r?\n/).map(s => s.trim()).find(s => /\.cmd$/i.test(s));
        if (cmdShim) {
          const prefix = path.dirname(cmdShim);
          const cliJs = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
          if (fs.existsSync(cliJs)) {
            // npm 全局安装:shim 实质是 `node <prefix>/node_modules/.../cli.js`
            spawnExe = process.execPath;
            spawnArgs = [cliJs, ...args];
          } else {
            // 老式安装:shim 内容真的指向 bin\claude.exe
            try {
              const txt = fs.readFileSync(cmdShim, 'utf8');
              if (/%~?dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude\.exe/i.test(txt)) {
                claudeExe = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
              }
            } catch { /* fallback */ }
            spawnExe = claudeExe;
          }
        }
      } catch { /* fallback */ }
      if (!spawnExe) spawnExe = claudeExe;
      spawnedExe = spawnExe;
      child = spawn(spawnExe, spawnArgs, {
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
    attachPromptStdin(child, promptText, resolve, reject);
  });
}

/**
 * spawn 后的公共收尾：挂 error/spawn 监听，spawn 成功后把 prompt 从 stdin 喂进去。
 *
 * 长 prompt 必须走 stdin（避开 Windows CreateProcess 32K 命令行上限）。必须在
 * spawn 事件回调里 write——spawn 返回时 child.stdin 句柄可能尚未绑定到真正的
 * pipe fd；write 完成后必须 end()，否则 CLI 会一直阻塞在读 stdin 上 → hang。
 */
function attachPromptStdin(child, promptText, resolve, reject) {
  child.on('error', reject);
  child.on('spawn', () => {
    // unref 让 CLI 独立于父进程事件循环；返回 child 引用让调用方继续读 stdout。
    child.unref();
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
}

// ── 执行器（executor） ──────────────────────────────────────────────────
// 工作台任务默认由 claude CLI 执行；opencode 作为可选执行器（2026-09-20）。
// 两者都用「stdin 喂 prompt + stdout 结构化 JSON 事件流」的同构形态，
// 差异只在协议：claude 是 stream-json，opencode 是 --format json 的事件 NDJSON。
export const TASK_EXECUTORS = ['claude', 'opencode'];

/** 非法/缺省的 executor 一律回落 'claude'（历史行为的兼容兜底）。
 *  body.executor 来自网络，做一次 trim + 小写归一，与 config.js 同名函数同语义。 */
export function normalizeTaskExecutor(value) {
  if (typeof value !== 'string') return 'claude';
  const v = value.trim().toLowerCase();
  return TASK_EXECUTORS.includes(v) ? v : 'claude';
}

/**
 * Windows 下把 opencode 解析成可直接 spawn 的 exe。
 * npm 全局安装的 opencode 是 .cmd shim（Node 23+ 拒绝 spawn .cmd，EINVAL），
 * shim 内容实际指向 <prefix>\node_modules\opencode-ai\bin\opencode.exe，
 * 与 claude 的 cli.js 解析同一条套路，只是目标文件不同。
 */
function resolveOpencodeExe() {
  try {
    const cmdShim = execFileSync('where', ['opencode'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map(s => s.trim()).find(s => /\.cmd$/i.test(s));
    if (cmdShim) {
      const exe = path.join(path.dirname(cmdShim), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch { /* fallback */ }
  // 兜底交给 PATH：装在非 npm 全局目录（scoop/手动下载）时通常有 opencode.exe
  return 'opencode.exe';
}

/**
 * opencode 子进程环境。
 * 关键点：删掉 PWD/OLDPWD。opencode（Bun 构建）在某些路径下会拿环境里的 PWD
 * 当 cwd 用，而从 Git Bash 继承的 POSIX 风格 PWD（/tmp/xxx）会被它解析成
 * 不存在的 C:\tmp\xxx，SystemPrompt 阶段直接抛
 * "FileSystem.realPath ... ENOENT"。删掉让它老老实实走 process.cwd()。
 */
function buildOpencodeEnv() {
  const env = { ...process.env, LANG: 'zh_CN.UTF-8' };
  delete env.PWD;
  delete env.OLDPWD;
  return env;
}

/**
 * 用 opencode run 跑一个 prompt（非交互模式），返回 { pid, child }。
 *
 *   opencode run --format json --auto [--thinking] [--session <id>]
 *
 *   - --format json   结构化事件流（step_start/text/reasoning/tool_use/step_finish/error）
 *   - --auto          自动批准未被显式拒绝的权限（对应 claude 的 bypassPermissions 档位）
 *   - --thinking      输出 reasoning 事件（对应 claude 的 thinking 块）
 *   - --session <id>  续接历史会话（对应 claude 的 --resume）
 *   - 不传 -m：模型跟随 opencode 自身配置的默认值（用户在 opencode 里配了什么就用什么）
 *   - prompt 从 stdin 喂入：opencode run 无位置参数时读 stdin，顺带避开命令行长度上限
 */
export function launchOpencodeRun(cwd, promptText, resumeSessionId) {
  return new Promise((resolve, reject) => {
    const args = ['run', '--format', 'json', '--auto', '--thinking'];
    if (resumeSessionId) {
      args.push('--session', String(resumeSessionId));
    }
    let child;
    if (process.platform === 'win32') {
      child = spawn(resolveOpencodeExe(), args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: false,
        env: buildOpencodeEnv()
      });
    } else {
      child = spawn('opencode', args, {
        cwd,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildOpencodeEnv()
      });
    }
    attachPromptStdin(child, promptText, resolve, reject);
  });
}

/**
 * claude stream-json 事件处理器。
 *   system/init  → session_id（--resume 续接用）
 *   assistant    → message.content 里的 text / thinking 块
 *   其余（tool_use / result / stream_event 等）忽略。
 */
function createClaudeEventHandler(job, appendOutput, appendThinking) {
  return (evt) => {
    if (evt.type === 'system' && evt.subtype === 'init' && typeof evt.session_id === 'string') {
      if (!job.claudeSessionId || job.claudeSessionId !== evt.session_id) {
        job.claudeSessionId = evt.session_id;
        publish('job:update', job);
      }
      return;
    }
    if (evt.type !== 'assistant') return;
    const blocks = evt.message?.content;
    if (!Array.isArray(blocks)) return;
    for (const b of blocks) {
      if (b.type === 'text' && typeof b.text === 'string') {
        appendOutput(b.text);
      } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
        appendThinking(b.thinking);
      }
    }
  };
}

/**
 * opencode --format json 事件处理器。
 * 实测事件形态（opencode 1.18.x）：
 *   { type:'step_start' | 'step_finish', sessionID, part:{ type:'step-start'|'step-finish', tokens?, cost? } }
 *   { type:'text',      sessionID, part:{ id, type:'text',      text } }
 *   { type:'reasoning', sessionID, part:{ id, type:'reasoning', text } }
 *   { type:'tool_use',  sessionID, part:{ type:'tool', tool, state:{ status, input, output } } }
 *   { type:'error',     sessionID, error:{ name, data:{ message } } }
 * 正文/思考按 part.id 记录已落地的累计文本：同一 part 再次出现时若文本是前次的
 * 前缀延长（累积语义）只追加增量，否则按纯增量整段追加 —— 两种推送语义都兼容。
 * （导出仅为回归测试可见：taskRunner.opencode.test.js）
 */
export function createOpencodeEventHandler(job, appendOutput, appendThinking) {
  const seenParts = new Map(); // part.id -> 已落地的累计文本
  const appendPartText = (part, isThinking) => {
    const text = typeof part?.text === 'string' ? part.text : '';
    if (!text) return;
    const id = typeof part?.id === 'string' ? part.id : '';
    const prev = id ? seenParts.get(id) : undefined;
    let delta = text;
    if (prev !== undefined) {
      delta = text.startsWith(prev) ? text.slice(prev.length) : text;
    }
    if (!delta) return;
    if (id) seenParts.set(id, prev !== undefined ? prev + delta : text);
    if (isThinking) appendThinking(delta);
    else appendOutput(delta);
  };
  return (evt) => {
    // 顶层 sessionID 是 opencode 的会话标识（--session <id> 续接）。
    // 复用 claudeSessionId 字段：前端与续接路由都认它，换执行器只是取值来源不同。
    if (typeof evt.sessionID === 'string' && evt.sessionID && job.claudeSessionId !== evt.sessionID) {
      job.claudeSessionId = evt.sessionID;
      publish('job:update', job);
    }
    if (evt.type === 'text' || evt.type === 'reasoning') {
      appendPartText(evt.part, evt.type === 'reasoning');
      return;
    }
    if (evt.type === 'error') {
      const msg = evt.error?.data?.message
        || (typeof evt.error?.message === 'string' ? evt.error.message : '')
        || evt.error?.name
        || 'opencode 执行出错';
      if (!job.agentError) job.agentError = msg;
    }
  };
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
    const outcome = await runSingleSubtask(task, sub, repoPath, branch, priorOutputs, { executor: opts.executor });
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
 *        续接历史会话:claude 走 --resume <id>，opencode 走 --session <id>。
 *        id 来自上一轮 stream 事件捕获的会话标识(两者都记在 job.claudeSessionId)。
 * @param {string} [options.executor]
 *        执行器 'claude' | 'opencode'。缺省回落 'claude'；路由层负责把
 *        "body 指定 > 配置默认"先解析好再传进来。
 * @returns {Promise<'done'|'cancelled'|'error'>} sub 的终态
 */
export async function runSingleSubtask(task, sub, repoPath, branch, priorOutputs, options) {
  const opts = options || {};
  const resumeSessionId = opts.resumeSessionId || null;
  const executor = normalizeTaskExecutor(opts.executor);
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
  // 标题与描述可能逐字相同（派发建的简单任务就是），去重规则见 promptParts.js
  let prompt = composePromptBody(interpolated, sub.title, sub.desc);

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

  // ── 运行环境上下文：项目清单 + 看板概览 + 真相源文件路径 ──
  // 拼在**最前面**、任务正文压尾，与上面 priorOutputs 的位置口径一致：
  // 越靠后离模型的注意力中心越近，用户真正要办的那句话必须在最后一屏。
  // task.envContext === false 可以单任务关掉（默认开 —— 老任务不迁移也一并受益）。
  if (task.envContext !== false) {
    const envBlock = await resolveEnvContext(repoPath);
    if (envBlock) prompt = `${envBlock}\n\n---\n\n${prompt}`;
  }

  const jobId = genId();
  const job = {
    id: jobId,
    taskId: task.id,
    subId: sub.id,
    title: `${task.title} / ${sub.title}`,
    status: 'pending',
    prompt,
    // 本轮用的执行器。前端日志详情按它显示助手名；简单任务续聊时
    // 路由层用它保证"用同一个 CLI 续同一个会话"。
    agent: executor,
    // 续接历史会话时先填上,首条协议事件回来后再用真值覆盖(通常等同)。
    // 字段名保留 claudeSessionId:claude 的 session_id 和 opencode 的 sessionID
    // 都存这里,语义是"该执行器的会话续接标识"。
    claudeSessionId: resumeSessionId
  };
  jobs.set(jobId, job);
  sub.status = 'running';
  publish('sub:update', { taskId: task.id, sub });
  publish('job:update', job);

  try {
    const launcher = executor === 'opencode' ? launchOpencodeRun : launchClaudeInNewWindow;
    const { pid, child } = await launcher(repoPath || process.cwd(), prompt, resumeSessionId);
    job.pid = pid;
    // 保存 child 引用，供 cancel 接口调用 kill
    job.child = child;
    job.startedAt = nowIso();
    job.status = 'running';
    publish('job:update', job);

    // 流式 NDJSON 解析：把 stdout 当作所选执行器的 JSON 事件流处理
    //   正文/思考块            → job.output / job.thinking（前端主视图 + 折叠思考）
    //   会话标识               → job.claudeSessionId（续接对话用）
    //   其他事件（tool_use 等）忽略，避免噪声
    const MAX_OUTPUT = 100 * 1024 * 1024;
    const MAX_THINKING = 100 * 1024 * 1024;
    job.output = '';
    job.thinking = '';
    const lineBuf = { stdout: '', stderr: '' };

    // 追加正文（尾部截断保底 + 增量推送给前端）
    const appendOutput = (text) => {
      if (!text) return;
      const prevLen = job.output.length;
      job.output = (job.output + text).slice(-MAX_OUTPUT);
      const delta = job.output.slice(prevLen);
      if (delta) publish('job:output-delta', { id: job.id, delta });
    };

    // 追加思考：先攒在本批缓冲里，一批 NDJSON 处理完统一发一次，避免高频小块 socket 占用
    let thinkingBatch = '';
    const flushThinkingBatch = () => {
      if (thinkingBatch) {
        publish('job:thinking-delta', { id: job.id, delta: thinkingBatch });
        thinkingBatch = '';
      }
    };
    const appendThinking = (text) => {
      if (!text) return;
      const prevLen = job.thinking.length;
      job.thinking = (job.thinking + text).slice(-MAX_THINKING);
      thinkingBatch += job.thinking.slice(prevLen);
    };

    const handleEvent = executor === 'opencode'
      ? createOpencodeEventHandler(job, appendOutput, appendThinking)
      : createClaudeEventHandler(job, appendOutput, appendThinking);

    const handleLine = (line, channel) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (channel === 'stderr' || !trimmed.startsWith('{')) {
        // 非 JSON 行：原样塞进 output（兼容老版本 claude / CLI 的错误信息）
        appendOutput(trimmed + '\n');
        return;
      }
      let evt;
      try { evt = JSON.parse(trimmed); } catch { return; }
      handleEvent(evt);
    };

    const parseLines = (channel, buf) => {
      const chunk = buf.toString('utf8');
      lineBuf[channel] += chunk;
      const lines = lineBuf[channel].split('\n');
      lineBuf[channel] = lines.pop() ?? ''; // 最后一段可能不完整，留给下次
      for (const line of lines) handleLine(line, channel);
      flushThinkingBatch();
    };
    if (child.stdout) child.stdout.on('data', (buf) => parseLines('stdout', buf));
    if (child.stderr) child.stderr.on('data', (buf) => parseLines('stderr', buf));

    // 等待进程退出（detached 不阻塞主进程，用 polling /proc 兜底）
    await waitProcessExit(pid);
    const wasCancelled = cancelledJobs.has(jobId);
    if (wasCancelled) cancelledJobs.delete(jobId);
    // 进程退出时 stdout/stderr 可能残留最后一段未换行的 NDJSON，flush 一次
    if (lineBuf.stdout.trim() || lineBuf.stderr.trim()) {
      for (const line of lineBuf.stdout.split('\n')) handleLine(line, 'stdout');
      for (const line of lineBuf.stderr.split('\n')) handleLine(line, 'stderr');
      lineBuf.stdout = '';
      lineBuf.stderr = '';
    }
    flushThinkingBatch();
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
    } else if (job.agentError) {
      // 执行器在协议层报了 error（如模型 5xx、配置缺失）。CLI 退出码可能是 0，
      // 但不能标 done —— 那会把失败伪装成完成，后续 sub 还会拿空输出当下文继续跑。
      job.exitCode = 1;
      job.status = 'error';
      job.error = job.agentError;
      sub.status = 'error';
      sub.error = job.agentError;
      sub.errorAt = nowIso();
      appendOutput(`\n> [${executor}] ${job.agentError}\n`);
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
  // 前序 sub 可能是**另一个 g ui 实例**跑完的（或者本进程重启过），只翻内存会漏，
  // 于是"前序结论"整段丢了。刷新有 mtime 短路，队列里每个 sub 调一次也只是个 stat。
  await refreshJobsFromDisk();
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

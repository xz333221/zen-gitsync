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
//   - runSingleSubtask(task, sub, repoPath, branch, opts)    跑一次任务（sub 是运行载体，见下）
//   - waitProcessExit(pid)                                   polling 等进程退出
//
// 关于 `sub`：任务不再有子任务，但执行器仍以一个「运行载体」对象作为入参 ——
// 它携带本次要跑的 title / desc / promptOverride / attachments。路由层构造它，
// 续聊时同一任务会造出新的载体（`{taskId}__simple__r1` 等），job.subId 记的就是它。

import fs from 'fs';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import {
  logger,
  PROMPTS_FILE,
  readJson,
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

// ── 工具调用（tool_use）收集 ──────────────────────────────────────────────
// 为什么要有这一层：job.output 只承载「模型说的话」。工具调用（读了哪个文件、跑了什么命令、
// 拿到了什么结果）原本在两个事件处理器里被整段丢掉，于是前端只剩「思考 + 正文」两块，
// 模型闷头干活的几分钟就完全看不出它在干什么（2026-09-22 用户反馈）。
//
// 这里把两种执行器的 tool_use / tool_result 归一成 zen-ai-chat-ui 的 ToolCall 形态：
//   { id, name, argsPreview, arguments, result, status, error }
// 挂在 job.toolCalls 上随 job 一起落盘（jobs.json），并通过 job:toolcalls 事件流式推给前端。
//
// 截断统一在服务端做：前端只是展示层，两边看到的字段含义一致。
export const MAX_TOOL_CALLS = 150;
const MAX_TOOL_ARGS = 2000;
const MAX_TOOL_RESULT = 4000;
const MAX_TOOL_ERROR = 1000;
const TOOL_ARGS_PREVIEW = 200;

/** 截断（保留开头：工具名 / 命令的关键信息都在前面） */
function clipText(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n…（已截断 ${s.length - max} 字）` : s;
}

/**
 * 参数摘要的截断：严格不超过 max（含那个省略号）。
 * 摘要是一行展示用，尾部再挂「已截断 N 字」反而把这一行撑爆 ——
 * 完整参数在 arguments 里，那里才有必要标出截断。
 */
function clipPreview(text, max = TOOL_ARGS_PREVIEW) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

/**
 * 工具参数一行摘要（折叠态展示用）。
 *
 * 不做「按工具名分派」——claude（Bash / Read / Edit）与 opencode（bash / read / edit）
 * 的工具名并不统一，按名分派等于给自己挖一个要跟着 CLI 版本改的坑。
 * 改成「先挑常见的主语字段，挑不到就退化成紧凑 JSON」。
 */
function summarizeToolArgs(rawArgsText) {
  const raw = String(rawArgsText || '').trim();
  if (!raw) return '';
  const flat = raw.replace(/\s+/g, ' ');
  if (!raw.startsWith('{')) return clipPreview(flat);
  let obj;
  try { obj = JSON.parse(raw); } catch { return clipPreview(flat); }
  if (!obj || typeof obj !== 'object') return clipPreview(flat);
  const preferred = ['command', 'cmd', 'file_path', 'filePath', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'title'];
  for (const key of preferred) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) {
      return clipPreview(v.trim().replace(/\s+/g, ' '));
    }
  }
  return clipPreview(safeJson(obj).replace(/\s+/g, ' '));
}

/**
 * 工具结果文本抽取。
 * claude 的 tool_result.content 可能是 string，也可能是 [{type:'text',text}] 块数组
 * （还可能夹图片块）；opencode 的 state.output 是 string 或对象；错误对象常见形态是 {message}。
 * 统一压成一段文本。
 */
function extractToolText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const b of content) {
      if (b == null) continue;
      if (typeof b !== 'object') { parts.push(String(b)); continue; }
      if (typeof b.text === 'string') parts.push(b.text);
      else if (b.type === 'image') parts.push('[图片]');
      else if (b.type) parts.push(`[${b.type}]`);
    }
    return parts.join('\n');
  }
  if (typeof content === 'object') {
    if (typeof content.message === 'string') return content.message;
    return safeJson(content);
  }
  return String(content);
}

/**
 * 建一个工具调用收集器。
 *
 * 为什么批量 flush 而不是每条立即 publish：一次 NDJSON 批次里可能含多个 tool_use
 * （模型并行调工具），攒成一批发一次，跟 thinking 的处理口径一致，避免高频小块 socket。
 *
 * @param {object} job   执行记录（toolCalls 挂到它身上，随 job 落盘）
 * @param {(updates: Array) => void} [onUpdates]  增量回调；不传则只写 job 不推送（单测用）
 */
export function createToolCallTracker(job, onUpdates) {
  if (!Array.isArray(job.toolCalls)) job.toolCalls = [];
  const byId = new Map();
  let pending = [];
  let anonSeq = 0;

  // 只推可序列化字段（跟 snapshotJobs 的投影口径一致），存的是快照不是引用，
  // 免得后续状态变更悄悄改掉已经 emit 出去、还堆在 pending 里的那一份。
  const snapshot = (call) => ({
    id: call.id,
    name: call.name,
    argsPreview: call.argsPreview,
    arguments: call.arguments,
    result: call.result,
    status: call.status,
    error: call.error
  });

  /**
   * 记录一次工具调用的新增 / 状态变更。同一个 id 反复出现只更新同一条
   * （opencode 会按 running → completed 推同一个 part，claude 的 tool_result
   * 也回指 tool_use 的 id）。
   *
   * @param {{ id?: string, name?: string, input?: any, status?: string, output?: any, error?: any }} info
   */
  function record(info) {
    const src = info || {};
    const name = src.name ? String(src.name).slice(0, 80) : '';
    const id = src.id ? String(src.id) : `anon-${++anonSeq}`;
    let call = byId.get(id);
    if (!call) {
      // 超上限后直接丢弃新调用：保持数组有界，免得一次长跑生成上千条把 jobs.json 撑爆。
      // 已经记下的那些照常更新，不会因为超限变成"半截"。
      if (job.toolCalls.length >= MAX_TOOL_CALLS) return null;
      call = { id, name, argsPreview: '', arguments: '', result: '', status: 'running' };
      byId.set(id, call);
      job.toolCalls.push(call);
    }
    if (name) call.name = name;
    // 参数只在第一次拿到时写：opencode 的后续事件可能只剩 state.output
    if (src.input !== undefined && src.input !== null && !call.arguments) {
      const raw = typeof src.input === 'string' ? src.input : safeJson(src.input);
      call.arguments = clipText(raw, MAX_TOOL_ARGS);
      call.argsPreview = summarizeToolArgs(raw);
    }
    if (src.status && src.status !== call.status) call.status = src.status;
    if (src.output !== undefined && src.output !== null) {
      const text = extractToolText(src.output);
      if (text) call.result = clipText(text, MAX_TOOL_RESULT);
    }
    if (src.error) {
      call.error = clipText(extractToolText(src.error) || '工具执行失败', MAX_TOOL_ERROR);
      call.status = 'error';
    }
    if (onUpdates) pending.push(snapshot(call));
    return call;
  }

  /** 把攒下的一批增量推给前端（一批 NDJSON 处理完 flush 一次） */
  function flush() {
    if (!onUpdates || pending.length === 0) return;
    const updates = pending;
    pending = [];
    onUpdates(updates);
  }

  /**
   * 进程已退出，还挂在 pending / running 的调用不会再有下文 —— 收口成终态。
   * 不做这一步，前端那个工具块会一直转圈（跟 job 终态不写回时 sub 一直 running 同一类 bug）。
   */
  function seal(jobStatus) {
    for (const call of job.toolCalls) {
      if (call.status !== 'running' && call.status !== 'pending') continue;
      if (jobStatus === 'cancelled') {
        call.status = 'error';
        call.error = call.error || '未返回结果（执行已停止）';
      } else if (jobStatus === 'error') {
        call.status = 'error';
        call.error = call.error || '未返回结果（执行出错）';
      } else {
        call.status = 'done';
      }
      if (onUpdates) pending.push(snapshot(call));
    }
    flush();
  }

  return { record, flush, seal };
}

/**
 * claude stream-json 事件处理器。
 *   system/init    → session_id（--resume 续接用）
 *   assistant      → message.content 里的 text / thinking / tool_use 块
 *   user           → message.content 里的 tool_result 块（工具执行结果，回指 tool_use 的 id）
 *   其余（result / stream_event 等）忽略。
 * （导出仅为回归测试可见：taskRunner.toolcalls.test.js）
 */
export function createClaudeEventHandler(job, appendOutput, appendThinking, toolCalls) {
  const tracker = toolCalls || createToolCallTracker(job);
  return (evt) => {
    if (evt.type === 'system' && evt.subtype === 'init' && typeof evt.session_id === 'string') {
      if (!job.claudeSessionId || job.claudeSessionId !== evt.session_id) {
        job.claudeSessionId = evt.session_id;
        publish('job:update', job);
      }
      return;
    }
    // 工具结果：claude 把 tool_result 包在一条 user 事件里回传
    //   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":…}]}}
    // 用块类型区分它和"用户自己那条 prompt"（那条 message.content 是字符串）。
    if (evt.type === 'user') {
      const ublocks = evt.message?.content;
      if (Array.isArray(ublocks)) {
        for (const b of ublocks) {
          if (b && b.type === 'tool_result' && b.tool_use_id) {
            const text = extractToolText(b.content);
            tracker.record({
              id: b.tool_use_id,
              status: b.is_error ? 'error' : 'done',
              output: text,
              error: b.is_error ? (text || '工具执行失败') : ''
            });
          }
        }
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
      } else if (b.type === 'tool_use') {
        tracker.record({ id: b.id, name: b.name, input: b.input, status: 'running' });
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
 *   { type:'tool_use',  sessionID, part:{ id, callID, type:'tool', tool, state:{ status, input, output } } }
 *   { type:'error',     sessionID, error:{ name, data:{ message } } }
 * 正文/思考按 part.id 记录已落地的累计文本：同一 part 再次出现时若文本是前次的
 * 前缀延长（累积语义）只追加增量，否则按纯增量整段追加 —— 两种推送语义都兼容。
 * tool_use 按 part.id / callID 归并：opencode 会按 state.status（running → completed）
 * 反复推同一个 part，落成一条工具调用（status 映射 completed → done）。
 * （导出仅为回归测试可见：taskRunner.opencode.test.js）
 */
export function createOpencodeEventHandler(job, appendOutput, appendThinking, toolCalls) {
  const tracker = toolCalls || createToolCallTracker(job);
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
  // opencode 的 state.status: pending | running | completed | error
  const mapToolStatus = (raw) => {
    const s = typeof raw === 'string' ? raw.toLowerCase() : '';
    if (s === 'completed' || s === 'done' || s === 'success') return 'done';
    if (s === 'error' || s === 'failed') return 'error';
    return 'running';
  };
  const recordToolPart = (part) => {
    if (!part || part.type !== 'tool') return;
    const st = part.state || {};
    const status = mapToolStatus(st.status);
    tracker.record({
      id: part.callID || part.id,
      name: part.tool || part.name,
      input: st.input,
      status,
      output: status === 'done' ? st.output : undefined,
      error: status === 'error' ? (st.error || st.output || 'opencode 工具执行出错') : ''
    });
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
    if (evt.type === 'tool_use') {
      recordToolPart(evt.part);
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
 * 执行一次任务。任务一次只跑一个进程，本函数是唯一的执行入口
 * （首次执行、手动重跑、续聊都走它）。
 *
 * @param {object} task         任务对象
 * @param {object} sub          本次运行载体：{ id, title, desc, promptOverride, attachments }
 * @param {string} repoPath     仓库路径
 * @param {string} branch       分支名（可空）
 * @param {object} [options]
 * @param {string|null} [options.resumeSessionId]
 *        续接历史会话:claude 走 --resume <id>，opencode 走 --session <id>。
 *        id 来自上一轮 stream 事件捕获的会话标识(两者都记在 job.claudeSessionId)。
 * @param {string} [options.executor]
 *        执行器 'claude' | 'opencode'。缺省回落 'claude'；路由层负责把
 *        "body 指定 > 配置默认"先解析好再传进来。
 * @returns {Promise<'done'|'cancelled'|'error'>} 本次运行的终态
 */
export async function runSingleSubtask(task, sub, repoPath, branch, options) {
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
  // 标题与描述可能逐字相同（派发建的任务就是），去重规则见 promptParts.js
  let prompt = composePromptBody(interpolated, sub.title, sub.desc);

  // ── 附件：合并 sub.attachments + task.attachments 后拼到 prompt 末尾 ──
  // PDF 附件在服务端预提取全文(Claude CLI v2.1.x 的 pdfParse 有 bug),
  // 图片和其他文件仍列路径让 Claude CLI 直接读取。
  // 注意：首次执行时 sub.attachments 就是 task.attachments 的同一引用，
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
  // 拼在**最前面**、任务正文压尾：
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
    // 一条任务 = 一次会话：日志标题就用任务标题（sub 只是运行载体，标题同源）
    title: task.title,
    status: 'pending',
    prompt,
    // 本轮用的执行器。前端日志详情按它显示助手名；简单任务续聊时
    // 路由层用它保证"用同一个 CLI 续同一个会话"。
    agent: executor,
    // 续接历史会话时先填上,首条协议事件回来后再用真值覆盖(通常等同)。
    // 字段名保留 claudeSessionId:claude 的 session_id 和 opencode 的 sessionID
    // 都存这里,语义是"该执行器的会话续接标识"。
    claudeSessionId: resumeSessionId,
    // 工具调用流水（{id,name,argsPreview,arguments,result,status,error}[]）。
    // 先给个空数组，前端拿到的 job:update 就有了稳定形态，不用到处判 undefined。
    toolCalls: []
  };
  jobs.set(jobId, job);
  publish('job:update', job);

  // 声明在 try 之外：启动器就抛错时 finally 也要能安全收口（见 toolTracker?.seal）
  let toolTracker = null;

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
    //   正文/思考块   → job.output / job.thinking（前端主视图 + 折叠思考）
    //   会话标识      → job.claudeSessionId（续接对话用）
    //   工具调用      → job.toolCalls（前端工具块 + 落盘归档）
    //   其他事件      → 忽略，避免噪声
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

    // 工具调用：写进 job.toolCalls（随 job 落盘），并按批推 job:toolcalls 给前端。
    // 收口（把没收尾的调用标终态）在 finally 里做，见下方 toolTracker.seal()。
    toolTracker = createToolCallTracker(job, (updates) => {
      publish('job:toolcalls', { id: job.id, updates });
    });

    const handleEvent = executor === 'opencode'
      ? createOpencodeEventHandler(job, appendOutput, appendThinking, toolTracker)
      : createClaudeEventHandler(job, appendOutput, appendThinking, toolTracker);

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
      toolTracker?.flush();
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
    toolTracker?.flush();
    job.endedAt = nowIso();
    if (wasCancelled) {
      job.exitCode = 130; // 128 + SIGINT(2)，约定俗成的"用户取消"退出码
      job.status = 'cancelled';
      job.error = '用户已停止执行';
    } else if (job.agentError) {
      // 执行器在协议层报了 error（如模型 5xx、配置缺失）。CLI 退出码可能是 0，
      // 但不能标 done —— 那会把失败伪装成完成。
      job.exitCode = 1;
      job.status = 'error';
      job.error = job.agentError;
      appendOutput(`\n> [${executor}] ${job.agentError}\n`);
    } else {
      job.exitCode = 0;
      job.status = 'done';
    }
  } catch (err) {
    const errMsg = err && err.message ? err.message : String(err);
    job.error = errMsg;
    job.status = 'error';
  } finally {
    // 工具调用收口：进程都退了，还挂在 running 的调用不会再有下文。先标终态再推 job:update，
    // 否则前端那些工具块会一直转圈。
    toolTracker?.seal(job.status);
    // 移除 child 引用——避免后续被 SSE 序列化到前端
    delete job.child;
    publish('job:update', job);
    // 终态：await 同步落盘,确保 done/cancelled/error 全部立即归档。
    try {
      await flushJobsSaveNow();
    } catch (err) {
      logger.warn('[workbench] flushJobsSaveNow failed (job id=' + job.id + ', status=' + job.status + '):', err && err.message || err);
    }
  }
  return job.status;  // 'done' | 'cancelled' | 'error'
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

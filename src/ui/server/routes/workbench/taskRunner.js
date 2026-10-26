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
// 支持六种执行器（executor）：
//   - claude    —— claude -p --output-format stream-json（默认，历史行为）
//   - opencode  —— opencode run --format json --auto（sst/opencode CLI，跟随其自身默认模型）
//   - codex     —— codex exec --json（OpenAI Codex CLI，跟随其自身配置；2026-09-27 加入）
//   - codebuddy —— codebuddy -p --output-format stream-json -y --port 0
//                  （腾讯 CodeBuddy Code CLI，即 WorkBuddy 桌面版的智能体引擎；
//                   2026-10-12 加入，协议与 claude 的 stream-json 逐字段对齐）
//   - pi        —— pi --mode json -a [--session <id>]
//                  （earendil-works 开源终端编程 Agent，npm @earendil-works/pi-coding-agent；
//                   2026-10-13 加入，**自有 JSONL 协议**，见该段注释）
//   - codearts  —— codearts run --format json --auto [-s <ses_id>]
//                  （华为云码道 CLI，2026-10-25 加入；它就是 opencode 的 fork，
//                   事件流与 opencode 逐字同构，handler 直接转调，见该段注释）
//
// 核心 API：
//   - launchClaudeInNewWindow(cwd, prompt, resumeSessionId)  spawn claude，返回 {pid, child}
//   - launchOpencodeRun(cwd, prompt, resumeSessionId)        spawn opencode，返回 {pid, child}
//   - launchCodexExec(cwd, prompt, resumeSessionId)          spawn codex，返回 {pid, child}
//   - launchPiPrint(cwd, prompt, resumeSessionId)            spawn pi，返回 {pid, child}
//   - launchCodeArtsRun(cwd, prompt, resumeSessionId)        spawn codearts，返回 {pid, child}
//   - normalizeTaskExecutor(value)                           非法值回落 'claude'
//   - runSingleSubtask(task, sub, repoPath, branch, opts)    跑一次任务（sub 是运行载体，见下）
//   - waitProcessExit(pid)                                   polling 等进程退出
//
// 关于 `sub`：任务不再有子任务，但执行器仍以一个「运行载体」对象作为入参 ——
// 它携带本次要跑的 title / desc / promptOverride / attachments。路由层构造它，
// 续聊时同一任务会造出新的载体（`{taskId}__simple__r1` 等），job.subId 记的就是它。

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import {
  logger,
  readJson,
  nowIso,
  genId,
  interpolate,
} from './shared.js';
import { buildAttachmentBlock } from './pdfText.js';
import { createImageDescriber, pickImageAttachments } from './imageDescribe.js';
import { composePromptBody } from './promptParts.js';
import { buildMemoryPointerBlock } from './memoryContext.js';
import {
  jobs,
  cancelledJobs,
  publish,
  flushJobsSaveNow,
  scheduleActiveJobsSave,
} from './jobStore.js';
// MEMORY_DIR 在 paths.js（路径唯一真相源），projectIndexFile 在 memory/store.js ——
// 两个模块各取一处，别图省事都从 store.js 拿：store.js 没有 re-export MEMORY_DIR，
// 混着写会在**链接期**就炸（node --check 查不出来，得靠动态 import 或真跑单测）。
import { MEMORY_DIR } from '../../../../paths.js';
import { projectIndexFile } from '../../../../memory/store.js';

// ── 运行环境上下文的提供者 ────────────────────────────────────────────────
// 为什么用注入而不是在这里直接读：拼这份上下文要「最近目录」（在 configManager 上），
// 而 taskRunner 拿不到 configManager —— 它是路由层的东西。与其在这里再造一条
// 读取最近目录的路径（口径分叉的老套路），不如让路由层注册时把函数递进来。
//
// 未注入时静默跳过：上下文是锦上添花，不能因为没接线就让整个执行引擎跑不起来。
let envContextProvider = null;

/**
 * 注册运行环境上下文的提供者。由 routes/workbench/index.js 在注册路由时调用。
 * @param {(ctx: {repoPath: string, compact?: boolean}) => Promise<string|null>|string|null} fn
 *        `compact: true` = 续聊轮，只要精简刷新版（完整清单上一轮已进过 prompt）。
 *        接不接这个字段由提供者自己决定：不接就等于每轮都发整块 —— 老行为，不会报错。
 */
export function setEnvContextProvider(fn) {
  envContextProvider = typeof fn === 'function' ? fn : null;
}

/**
 * 取本次执行的运行环境上下文块。
 *
 * 续聊轮（`resumeSessionId` 有值）传 `compact: true` 只要精简刷新版：完整环境块上一轮
 * 就在 prompt 里了，CLI 的会话恢复会把它带回来，整块重发是纯重复
 * （实测数据与理由见 envContext.js 文件头）。
 *
 * 提供者抛错一律降级成"没有上下文"：读 tasks.json 失败、配置竞态都是可能发生的，
 * 但它们都不该让用户的指令执行不了 —— 与「读不到最近目录不该让整个看板挂掉」同一条原则。
 */
async function resolveEnvContext(repoPath, { compact = false } = {}) {
  if (!envContextProvider) return '';
  try {
    const block = await envContextProvider({ repoPath: repoPath || '', compact: !!compact });
    return typeof block === 'string' ? block : '';
  } catch (err) {
    logger.warn(`[workbench] 运行环境上下文注入失败，本次跳过: ${err.message}`);
    return '';
  }
}

/**
 * 取本仓库的记忆索引路径。
 *
 * **只读不建** —— 与 resolveEnvContext 同一原则：拼 prompt 是锦上添花，
 * 记忆库不存在就只给全局那层，让 Agent 收尾时自己建（它有文件工具，也有那个动机）。
 * 在这里建目录等于"读一次就产生一次副作用"，派发任务不该有这种语义。
 */
function resolveProjectMemoryIndex(repoPath) {
  if (!repoPath) return '';
  try {
    return projectIndexFile(repoPath);
  } catch (err) {
    logger.warn(`[workbench] 记忆索引路径解析失败，本次不注入项目层: ${err.message}`);
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
// 工作台任务默认由 claude CLI 执行；opencode（2026-09-20）、codex（2026-09-27）、
// codebuddy（2026-10-12）、pi（2026-10-13）、codearts（2026-10-25）作为可选执行器。
// 六者都用「stdin 喂 prompt + stdout 结构化 JSON 事件流」的同构形态，差异只在协议：
// claude / codebuddy 是 stream-json，opencode 是 --format json 的事件 NDJSON，
// codex 是 exec --json 的 thread/item 事件 NDJSON，pi 是 --mode json 的自有 JSONL，
// codearts 的 --format json 与 opencode 逐字同构（它是 opencode 的 fork）。
//
// ⚠️ 这份清单与 src/config.js 的 TASK_EXECUTORS 是**同一份口径的两处书写**——
// 历史上为此吵过（见 agentEngines.js 文件头）：config.js 那份是"配置/归一化"的
// 真相源，本文件这份服务"运行时分发"。两边不一致的失效方式是 normalize 放行、
// 这里查无此人 → 静默回落 claude。加第六家时两处都要改，taskRunner.*.test.js 有钉子。
export const TASK_EXECUTORS = ['claude', 'opencode', 'codex', 'codebuddy', 'pi', 'codearts'];

/** 执行器 → launcher。runSingleSubtask 与 runExternalTurn 共用这一张表。 */
export const EXECUTOR_LAUNCHERS = {
  claude: launchClaudeInNewWindow,
  opencode: launchOpencodeRun,
  codex: launchCodexExec,
  codebuddy: launchCodebuddyPrint,
  pi: launchPiPrint,
  codearts: launchCodeArtsRun,
};

/** 执行器 → NDJSON 事件处理器工厂。 */
export const EXECUTOR_HANDLERS = {
  claude: createClaudeEventHandler,
  opencode: createOpencodeEventHandler,
  codex: createCodexEventHandler,
  codebuddy: createCodebuddyEventHandler,
  pi: createPiEventHandler,
  codearts: createCodeArtsEventHandler,
};

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

// ── codex 执行器（2026-09-27 加入） ──────────────────────────────────────
// codex exec 是非交互模式，形态与另两个执行器同构（stdin 喂 prompt + stdout NDJSON）：
//
//   codex exec [resume <thread_id>] --json --skip-git-repo-check
//     --dangerously-bypass-approvals-and-sandbox -      （`-` = prompt 从 stdin 读）
//
//   - --json      输出 JSONL 事件流（thread.started / item.* / turn.*）
//   - --dangerously-bypass-approvals-and-sandbox
//                 免批准 + 免沙箱，对应 claude 的 bypassPermissions、opencode 的 --auto。
//                 工作台任务全程无人应答批准提示，不跳过的话一遇审批就卡死
//   - --skip-git-repo-check
//                 工作台允许在非 git 目录建任务，不跳过的话 codex 直接拒绝启动
//   - 不传 -m / -s：模型与沙箱跟随 codex 自身配置（同 opencode 的口径）
//   - 续聊：codex exec resume <thread_id>，thread_id 来自 thread.started 事件

/**
 * Windows 下把 codex 解析成可直接 spawn 的 exe。
 *
 * npm 全局安装的 codex 是 .cmd shim（Node 23+ 拒绝 spawn .cmd，EINVAL），shim 指向
 * `node bin/codex.js`；而 bin/codex.js 自己也只是一层壳，真正干活的原生二进制在平台
 * 子包里：node_modules/@openai/codex/node_modules/@openai/codex-win32-<arch>/vendor/
 * <triple>/bin/codex.exe（与 bin/codex.js 的查找口径一致，另留一份无平台子包的兜底路径）。
 *
 * 为什么不直接 spawn(process.execPath, [bin/codex.js, ...])：那层壳会再 spawn 一次原生
 * 二进制，取消任务时 kill 到的只是壳进程，原生 codex 会变孤儿继续改文件。
 */
function resolveCodexExe() {
  try {
    const lines = execFileSync('where', ['codex'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    // 独立安装（scoop / 手动下载 / 包管理器直装）优先：PATH 上直接就是原生 exe
    const directExe = lines.find(s => /\.exe$/i.test(s));
    if (directExe && fs.existsSync(directExe)) return directExe;
    const cmdShim = lines.find(s => /\.cmd$/i.test(s));
    if (cmdShim) {
      const prefix = path.dirname(cmdShim);
      const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
      const archTag = process.arch === 'arm64' ? 'arm64' : 'x64';
      const candidates = [
        path.join(prefix, 'node_modules', '@openai', 'codex', 'node_modules', '@openai',
          `codex-win32-${archTag}`, 'vendor', triple, 'bin', 'codex.exe'),
        path.join(prefix, 'node_modules', '@openai', 'codex', 'vendor', triple, 'bin', 'codex.exe'),
      ];
      for (const exe of candidates) {
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch { /* fallback */ }
  // 兜底交给 PATH：装在非 npm 全局目录时通常有 codex.exe
  return 'codex.exe';
}

/**
 * codex 子进程环境。
 * RUST_LOG=error：codex 默认把 tracing 的 INFO 日志写 stderr，而 stderr 里非 JSON 行
 * 会被当正文贴进输出面板（实测一次执行能刷出上百行）；压到 error 档即可清干净，
 * 真正的报错走 stdout 的 JSON 事件流（error / turn.failed），信息不丢。
 */
function buildCodexEnv() {
  return { ...process.env, LANG: 'zh_CN.UTF-8', RUST_LOG: 'error' };
}

/** spawn codex exec 跑一个 prompt，返回 { pid, child }（参数口径见上方注释）。 */
export function launchCodexExec(cwd, promptText, resumeSessionId) {
  return new Promise((resolve, reject) => {
    const flags = ['--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
    const args = resumeSessionId
      ? ['exec', 'resume', ...flags, String(resumeSessionId), '-']
      : ['exec', ...flags, '-'];
    let child;
    if (process.platform === 'win32') {
      child = spawn(resolveCodexExe(), args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: false,
        env: buildCodexEnv()
      });
    } else {
      child = spawn('codex', args, {
        cwd,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildCodexEnv()
      });
    }
    attachPromptStdin(child, promptText, resolve, reject);
  });
}

// ── codebuddy 执行器（2026-10-12 加入） ────────────────────────────────────
// CodeBuddy Code CLI（`codebuddy` / `cbc`，npm 包 @tencent-ai/codebuddy-code）就是
// WorkBuddy 桌面版内置的智能体引擎。把它接进来 = 工作台/对话面板可以直接调度
// "WorkBuddy 同款引擎"（同一套工具集、Skills、权限模型），账号体系也是同一个
// （都走腾讯账号；CLI 侧首次要在终端扫码登录一次，写 ~/.codebuddy）。
//
// ⚠️ 与桌面版**不共享任何运行时身份**：桌面版给它自己的子进程注入一整套变量
// （CODEBUDDY_HOST=workbuddy-desktop / CONFIG_DIR / MCP_CONFIG / 会话追踪 id…），
// 这套变量继承过来会让 CLI 以"桌面版子进程"身份运行 —— 实测直接认证失败。
// 全部在 buildCodebuddyEnv 里剥掉，CLI 固定以独立模式读自己的 ~/.codebuddy，
// 行为可复现，不随 g gui 被谁拉起而变。
//
// 实测口径（2026-10-12，CLI 2.164.0，本机与官方文档双向核对）：
//
//   codebuddy -p --output-format stream-json -y --port 0 [--resume <sessionId>]
//     - prompt 从 stdin 喂（-p 无位置参数时读 stdin，与 claude 的 `-p -` 同效，
//       顺带避开 Windows 命令行 32K 上限）
//     - --output-format stream-json  NDJSON 事件流，**协议与 claude 逐字段对齐**
//       （官方文档原话"对齐 Anthropic Claude Code v2.1.88"）：
//         system/init（带 session_id / tools / model / permissionMode）
//         assistant（message.content 里的 text / thinking / tool_use 块）
//         user（message.content 里的 tool_result 块，回指 tool_use_id）
//         result（终态，带 is_error / errors / usage / total_cost_usd）
//       另有 system/status、ai-title 等 cbc 特有事件，handler 一律忽略。
//     - -y        非交互免批准。init 事件回传 permissionMode: 'bypassPermissions'
//                 （不给 -y 时写操作会被拦，和另三家一个性质）
//     - --port 0  **每次 spawn 必须显式传**。CLI 每次运行会自带一个引擎服务器，
//                 默认端口写死 62443 —— 而 WorkBuddy 桌面版常驻就占着 62443，
//                 不传端口（或传固定值）会 EADDRINUSE 直接退出。0 = 让 OS 选空闲
//                 端口，实测并发两个任务各起各的互不冲突。
//     - --resume  续接会话，id 取自上一轮 init 事件的 session_id（落 job.claudeSessionId）
//     - 不传 --model：模型跟随 CLI 自己的配置（与另三家同一口径，探测见 executorModels.js）
//     - 不需要 --verbose：claude 的 stream-json 必须配 --verbose，cbc 不用
//       （实测不带 --verbose 事件流完整）。
//
// 登录态：CLI 读 ~/.codebuddy 下的凭据。**首次使用前要先在终端跑一次
// `codebuddy` 扫码登录**（微信），之后 headless 才能过认证；也可以用
// CODEBUDDY_API_KEY（+可选 CODEBUDDY_BASE_URL）环境变量认证。读不到凭据时
// 会话照常起，但模型调用返回 "Authentication required"，表现是一轮秒退的
// error_during_execution —— 这种失败由 result 事件如实带出，不静默。
// （另见 buildCodebuddyEnv：桌面版注入的 CODEBUDDY_CONFIG_DIR 会被删掉。）

/**
 * Windows 下把 codebuddy 解析成可直接 spawn 的目标。
 *
 * 三种安装形态都见过（2026-10-12）：
 *   1. npm 全局（`npm i -g @tencent-ai/codebuddy-code`）—— PATH 上是 .cmd shim，
 *      shim 实质是 `node <prefix>\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy`。
 *      Node 23+ 拒绝直接 spawn .cmd（EINVAL），所以像 claude 一样解析到 node + bin 脚本。
 *   2. 原生二进制安装（install.ps1 → %USERPROFILE%\AppData\Local\codebuddy\bin）——
 *      PATH 上直接是 codebuddy.exe，优先用（少一层 node 包装，杀进程树也更干净）。
 *   3. 手动放 PATH 的其它形态 —— 兜底交给 PATH。
 */
function resolveCodebuddyExe() {
  try {
    const lines = execFileSync('where', ['codebuddy'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    // 独立安装优先：PATH 上直接就是原生 exe
    const directExe = lines.find(s => /\.exe$/i.test(s));
    if (directExe && fs.existsSync(directExe)) return { exe: directExe, prefixArgs: [] };
    const cmdShim = lines.find(s => /\.cmd$/i.test(s));
    if (cmdShim) {
      const prefix = path.dirname(cmdShim);
      const binJs = path.join(prefix, 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy');
      if (fs.existsSync(binJs)) return { exe: process.execPath, prefixArgs: [binJs] };
    }
  } catch { /* fallback */ }
  return { exe: 'codebuddy', prefixArgs: [] };
}

/**
 * WorkBuddy 桌面版注入给**它自己子进程**的环境变量，一个都不能让 codebuddy 子进程继承。
 *
 * ★ 两个实测确认的认证杀手（2026-10-12 逐变量二分 + CLI 日志取证）：
 *   1. `CODEBUDDY_HOST=workbuddy-desktop` —— 带上它，CLI 认为自己是"桌面版引擎
 *      的子进程"，转而去找桌面版凭据（`auth/workbuddy-desktop.info`，其解密密钥
 *      只存在于桌面版运行时），拿不到就报 "Authentication required"（日志：
 *      AtRestEncryption missing-key → AuthRefresh failed）。而用户明明在
 *      ~/.codebuddy 登录过。
 *   2. `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`（+配套 FORCE_HEADLESS_BUNDLE）——
 *      bin/codebuddy 里**专为桌面版宿主准备的 bundle 分流通道**（CLI 源码注释
 *      原话："宿主（workbuddy-server 起 sidecar / prewarm）在 spawn cbc 前设
 *      CODEBUDDY_FORCE_LITE_WB_BUNDLE=1，直接命中 codebuddy-lite-wb.js"）。
 *      命中后跑的是 lite-wb 裁剪包，强绑定桌面版身份，同样认证失败
 *      （日志 ProcessExit 调用栈落在 codebuddy-lite-wb.mjs）。
 *
 * 剥离策略：**前缀级 + 认证白名单**。桌面版实测注入 54 个 CODEBUDDY_* 变量
 * （外加 WORKBUDDY_* / CLIENT_INFO_* / ACC_* / TENCENT_DOCS_LOCAL_* 各家族），
 * 逐个人肉枚举是在打地鼠 —— FORCE_* 这对杀手就是枚举清单时代漏掉的。
 *
 * 判据（为什么这些前缀可以整族剥、为什么"全环境白名单"方向又是错的）：
 *   看"用户在自己的终端里跑 codebuddy 时环境里有没有它"。桌面版在拉起 g gui
 *   或它的 sidecar 时注入的这几族变量，用户正常场景**全部不存在**；剥掉它们
 *   只是把子进程环境对齐到"用户终端里的 codebuddy"，不引入任何新偏差。
 *   而 DB_* / pw / IMG_LIB 这类用户自己永久设置的变量不在这里剥。
 *   （反向的"只保留必需变量"白名单同样错：HTTP(S)_PROXY / NODE_EXTRA_CA_CERTS
 *   这类网络变量是合法继承项，一刀切会把用户的代理环境也切没。）
 */
const CODEBUDDY_DESKTOP_ENV_PREFIXES = Object.freeze([
  'CODEBUDDY_',          // 运行时开关全家（认证白名单见 CODEBUDDY_ENV_KEEP）
  'WORKBUDDY_',          // 桌面版自家命名空间（含 PAC_RPC_TOKEN 等内部令牌）
  'CLIENT_INFO_',        // 桌面版客户端身份（PRODUCT_NAME=WorkBuddy / MACHINE_ID / UA 后缀）
  'ACC_',                // 产品配置注入（ACC_PRODUCT_CONFIG_PATH → workbuddy 产品 json）
  'TENCENT_DOCS_LOCAL_', // 腾讯文档本地 MCP 地址注入
]);

/**
 * 前缀剥离里**必须放行**的例外：官方文档的 headless 认证通道。
 * 用户在终端里显式设置它们属于正当配置，g gui 继承用户环境 = 继承用户意图。
 * 只放行有文档背书的这两个（其余几百个 CODEBUDDY_* 开关一律剥，理由见上）。
 */
const CODEBUDDY_ENV_KEEP = Object.freeze([
  'CODEBUDDY_API_KEY',
  'CODEBUDDY_BASE_URL',
]);

/**
 * 不属于任何前缀、但同样只在桌面版会话里出现的单键（逐个人工核对过）。
 * 归入同一份剥离清单，测试里逐键钉住。
 */
const CODEBUDDY_DESKTOP_ENV_KEYS = Object.freeze([
  // 遥测 / 链路追踪：会把子会话的 trace 挂到桌面版那次会话下
  'BAGGAGE', 'TRACEPARENT',
  // 桌面版遥测 SDK 标记
  'GALILEO_ENABLE', 'GALILEO_SDK_READY',
  // 桌面版沙箱中心管道 / 网关服务地址（SERVER__PORT 与 SERVICE_PROXY_URL 同端口同源）
  'SANDBOX_CENTER_IPC_ADDRESS', 'SERVER__HOST', 'SERVER__PORT',
  // 桌面版运行时路径与 Electron 标记（EXEPATH=桌面版 PortableGit；GENIE_TRASH_DIR=桌面版垃圾箱）
  'EXEPATH', 'GENIE_TRASH_DIR', 'ELECTRON_RUN_AS_NODE', 'ORIGINAL_XDG_CURRENT_DESKTOP',
]);

/**
 * codebuddy 子进程环境。四个刻意为之的取舍：
 *   - LANG=zh_CN.UTF-8：与另三家一致（CLI 的提示词/输出跟随 locale）。
 *   - DISABLE_AUTOUPDATER=1：执行器场景**不允许 CLI 自我更新** —— 任务跑到一半
 *     二进制被换掉，轻则行为漂移重则进程被杀。用户想更新自己跑 `codebuddy update`。
 *   - CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS=1：-p 单发模式进程随首个 result
 *     结束，收不了后台任务的跨轮回推事件（官方文档对 SDK query() 单发用法也是
 *     这么处理的）。禁掉之后模型的 run_in_background 参数从工具 schema 里隐藏，
 *     不会出现"派了后台任务然后永远等不到通知"。
 *   - **剥掉桌面版注入的前缀族**（见上方注释的两个杀手 —— 不剥 CODEBUDDY_HOST
 *     或 CODEBUDDY_FORCE_LITE_WB_BUNDLE 都会直接认证失败，2026-10-12 实测）。
 * （导出仅为回归测试可见：taskRunner.codebuddy.test.js 钉住剥/留两侧的边界）
 */
export function buildCodebuddyEnv() {
  const env = { ...process.env };
  const keep = new Set(CODEBUDDY_ENV_KEEP);
  for (const key of Object.keys(env)) {
    if (keep.has(key)) continue;
    if (CODEBUDDY_DESKTOP_ENV_KEYS.includes(key)) { delete env[key]; continue; }
    if (CODEBUDDY_DESKTOP_ENV_PREFIXES.some((p) => key.startsWith(p))) delete env[key];
  }
  // 自己的三项在**剥离之后**设置：CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS 本身
  // 命中 CODEBUDDY_ 前缀，若像从前那样先合并进来会被剥离循环顺手删掉。
  env.LANG = 'zh_CN.UTF-8';
  env.DISABLE_AUTOUPDATER = '1';
  env.CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS = '1';
  return env;
}

/**
 * codebuddy 的 spawn argv（纯函数，抽出来为了能**真的跑断言**而不用 spawn 进程 ——
 * 与 fileOpen.js 的 buildOpencodeArgs / buildCodexArgs 同一个理由。
 *
 * 口径见上方大注释。`--port 0` 是实测出来的必须项：CLI 自带引擎服务器占固定端口
 * 62443，与 WorkBuddy 桌面版冲突，0 让 OS 选空闲端口（并发任务互不打架）。
 */
export function buildCodebuddyArgs(resumeSessionId) {
  const args = [];
  if (resumeSessionId) {
    args.push('--resume', String(resumeSessionId));
  }
  args.push(
    '-p',
    '--output-format', 'stream-json',
    '-y',
    '--port', '0'
  );
  return args;
}

/** spawn codebuddy 跑一个 prompt（非交互），返回 { pid, child }（参数口径见上方注释）。 */
export async function launchCodebuddyPrint(cwd, promptText, resumeSessionId) {
  const args = buildCodebuddyArgs(resumeSessionId);
  const { exe, prefixArgs } = resolveCodebuddyExe();
  const spawnArgs = [...prefixArgs, ...args];
  return new Promise((resolve, reject) => {
    let child;
    if (process.platform === 'win32') {
      child = spawn(exe, spawnArgs, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: false,
        env: buildCodebuddyEnv()
      });
    } else {
      child = spawn(exe, spawnArgs, {
        cwd,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildCodebuddyEnv()
      });
    }
    attachPromptStdin(child, promptText, resolve, reject);
  });
}

/**
 * codebuddy stream-json 事件处理器。
 *
 * **协议与 claude 逐字段对齐**（2026-10-12 实测：init/assistant/user/result 四种
 * 事件、content 块的 text/thinking/tool_use、user 事件里的 tool_result 回指，
 * 全部同构；工具调用同样是"先 tool_use(running)、后 user(tool_result)"两条）。
 * 所以这里刻意**另写一份**而不是直接复用 createClaudeEventHandler：
 * 对齐是实测结论、不是合同 —— cbc 还多出 system/status、ai-title 等自有事件，
 * 将来协议分叉时在这里修，不会顺带改坏 claude 那条链路（本仓库对"同一份口径
 * 多处实现"的失效方式有惨痛记忆：不报错，只是悄悄少一半数据）。
 *
 * 已知被忽略的事件：system/status、system/task_*（后台任务，已被
 * CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS 禁用）、ai-title、成功的 result。
 * `type:'error'` 与 `result.is_error` 例外 —— 它们是"进程退出码 0 但本轮失败"的
 * 唯一线索（如会话找不到、认证失败），必须落 job.agentError（见 handler 内注释）。
 * （导出仅为回归测试可见：taskRunner.codebuddy.test.js）
 */
export function createCodebuddyEventHandler(job, appendOutput, appendThinking, toolCalls) {
  const tracker = toolCalls || createToolCallTracker(job);
  return (evt) => {
    if (!evt || typeof evt !== 'object') return;
    // init：session_id 落 job.claudeSessionId（--resume 续接用）。
    //
    // ⚠️ **只认第一条**，后续 init 一律忽略。cbc 会把**子智能体**会话的 init 也写进
    // 同一条 stdout（2026-10-21 实测：一轮里 4 条 init —— 主会话 78 件工具、中间那条
    // 36 件工具的子会话、结尾又把主会话补一遍）。子会话**不注册进会话库**
    // （CLI 日志原话 "Child session skipped registration"），拿它的 id 去 --resume
    // 只会得到一条 `{"type":"error","error":"No conversation found with session ID: …"}`，
    // 进程退出码仍是 0 —— 表现就是"续接时不输出、直接结束"。
    // 主会话的 init 必定最先到（子智能体是主会话跑起来才派出去的），所以首条即真值；
    // 续接时首条回来的 id 与 --resume 传入的 id 也实测一致（不会丢上下文）。
    if (evt.type === 'system' && evt.subtype === 'init' && typeof evt.session_id === 'string') {
      if (!job.claudeSessionId) {
        job.claudeSessionId = evt.session_id;
        publish('job:update', job);
      }
      return;
    }
    // 协议层报错：实测形状 `{"type":"error","error":"<文案>"}`（如会话找不到、
    // 认证失败），**退出码照样是 0**。落 job.agentError 让终态判成 error，
    // 否则一轮空输出会被记成"已完成"（另四家 handler 同一口径）。
    if (evt.type === 'error') {
      const msg = typeof evt.error === 'string'
        ? evt.error
        : (typeof evt.error?.message === 'string' ? evt.error.message : '');
      if (msg && !job.agentError) job.agentError = msg;
      return;
    }
    // result 的失败分支同上一类：cbc 发的是
    // `{type:'result',subtype:'error_during_execution',is_error:true,errors:[…]}`
    // （拿到的是错误对象数组，没有 result 字符串），success 分支才带 result。
    if (evt.type === 'result' && evt.is_error) {
      const detail = Array.isArray(evt.errors) ? evt.errors.filter(Boolean).join('; ') : '';
      const msg = detail || (typeof evt.result === 'string' ? evt.result : '')
        || evt.subtype || 'codebuddy 执行出错';
      if (!job.agentError) job.agentError = msg;
      return;
    }
    // 工具结果：与 claude 完全同构 —— user 事件的 content 是块数组，
    // 里面才是 tool_result（用户自己那条 prompt 的 content 是字符串，不会走到这）
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

// ── pi 执行器（2026-10-13 加入） ──────────────────────────────────────────
// Pi = earendil-works 的开源终端编程 Agent（npm @earendil-works/pi-coding-agent，
// pi.dev，MIT）。内置四把工具 read/bash/edit/write，模型 BYOK（20+ provider，
// /login 也支持 Claude Pro/Max、ChatGPT Plus/Pro、Copilot 订阅）。
//
// 与另四家的三点本质差异（2026-10-13 按官方文档 + 本机 v1.2.0 实测双向核对）：
//
//   1. **没有权限系统**。官方原话"Pi does not include a built-in permission
//      system"—— 所以不存在 claude 的 --dangerously-skip-permissions /
//      codebuddy 的 -y 那样的档位参数，headless 下没有"等人点允许"卡死的问题。
//      但项目本地配置（.pi/settings.json、.pi/mcp.json）默认不被信任，
//      传 `-a`（--approve）显式信任本轮进程 —— 用户在终端里首跑也会被问一次，
//      无人值守场景替他答"信任"（与另四家"必须预设档位"同一条理由）。
//
//   2. **自有 JSONL 协议**（--mode json），不是 claude 的 stream-json：
//        首条   {"type":"session","id":"<uuid>",...}      会话标识（续接用）
//        message_update → assistantMessageEvent.text_delta / thinking_delta  增量
//        tool_execution_start / tool_execution_end                         工具生命周期
//        agent_* / turn_* / message_start|end / compaction_* / auto_retry_*  其余忽略
//      实测事件形状见 taskRunner.pi.test.js 的钉子（全部来自真实 CLI 输出）。
//
//   3. **续聊是 --session <id>，不是 --resume**。后者的官方定义是"打开会话
//      选择器"（交互 TUI），headless 下会卡住。--session 按精确 id 打开，
//      且**只在当前项目（cwd）里找** —— 实测跨项目会弹"Fork this session?"
//      交互提示然后 abort。本执行器每轮 cwd 都是同一个 repoPath，天然同项目。
//
//   pi --mode json -a [--session <sessionId>]
//     - prompt 从 stdin 喂（官方文档"Piped stdin → Prepend its contents to
//       the first prompt"，与 claude 的 -p 无位置参数同效，顺带避开 Windows
//       命令行 32K 上限）
//     - 不传 --model：模型跟随 CLI 自己的配置（与另四家同一口径；
//       探测见 executorModels.js 的 ~/.pi/agent/settings.json defaultModel）
//
// 登录态：/login（订阅）或 provider API key（ANTHROPIC_API_KEY 等，凭据落
// ~/.pi/agent）。**读不到凭据时 CLI 照常起、退出码 1、错误文本走 stderr**
// （实测）—— 协议里没有 error 事件，所以这种"起步就失败"只体现在 output 里
// 的 stderr 文本；跑到一半的 provider 错误才有 message_update 的 error 事件
// （handler 会置 job.agentError，见下）。
//
// ⚠️ 本机未安装 pi 时 spawn 报 ENOENT，与另四家一致（前端 availability 会
// 先把没装的执行器置灰，见 toolsStore）。

/**
 * Windows 下把 pi 解析成可直接 spawn 的目标。
 *
 * 两种安装形态都见过：
 *   1. npm 全局（`npm i -g @earendil-works/pi-coding-agent`）—— PATH 上是
 *      pi.cmd shim，实质是 `node <prefix>\node_modules\@earendil-works\
 *      pi-coding-agent\dist\bundle\cli.js`（bin 字段实测指向 dist/bundle/cli.js，
 *      不是 bin/pi —— 每个包的布局都不一样，别照抄 codebuddy 的路径）。
 *      Node 23+ 拒绝直接 spawn .cmd（EINVAL），所以解析到 node + bundle 脚本。
 *   2. 官方安装脚本（pi.dev/install.ps1 → 独立二进制）—— PATH 上直接是
 *      pi.exe，优先用（少一层 node 包装，杀进程树也更干净）。
 */
function resolvePiExe() {
  try {
    const lines = execFileSync('where', ['pi'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    // 独立安装优先：PATH 上直接就是原生 exe
    const directExe = lines.find(s => /\.exe$/i.test(s));
    if (directExe && fs.existsSync(directExe)) return { exe: directExe, prefixArgs: [] };
    const cmdShim = lines.find(s => /\.cmd$/i.test(s));
    if (cmdShim) {
      const prefix = path.dirname(cmdShim);
      const binJs = path.join(prefix, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
      if (fs.existsSync(binJs)) return { exe: process.execPath, prefixArgs: [binJs] };
    }
  } catch { /* fallback */ }
  return { exe: 'pi', prefixArgs: [] };
}

/**
 * pi 子进程环境。四个刻意为之的取舍：
 *   - LANG=zh_CN.UTF-8：与另四家一致（CLI 的提示词/输出跟随 locale）。
 *   - PI_SKIP_VERSION_CHECK=1：禁掉启动时对 pi.dev 的版本检查请求 —— 执行器
 *     场景多一次海外网络往返只会拖慢启动，CDN 不稳时可能整个卡住（与 codebuddy
 *     的 DISABLE_AUTOUPDATER 同性质；pi 的更新本来就是手动的 `pi update`）。
 *   - PI_TELEMETRY=0：关归属遥测。任务是在用户机器上代表用户跑的，
 *     把用量归属到"某次安装"没有意义。
 *   - 剥掉继承来的 PI_* 会话标记（PI_SESSION_ID / PI_SESSION_FILE /
 *     PI_CODING_AGENT / AI_AGENT）：g gui 若是在某个 pi 会话的 bash 工具里
 *     被拉起的，这些变量会继承过来 —— 官方环境变量文档明确警告嵌套 pi 会
 *     暴露父会话的过期元数据。pi 自己会给子进程设新值，剥掉不会缺东西。
 * （导出仅为回归测试可见：taskRunner.pi.test.js）
 */
export function buildPiEnv() {
  const env = { ...process.env };
  for (const key of ['PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_CODING_AGENT', 'AI_AGENT']) {
    delete env[key];
  }
  env.LANG = 'zh_CN.UTF-8';
  env.PI_SKIP_VERSION_CHECK = '1';
  env.PI_TELEMETRY = '0';
  return env;
}

/**
 * pi 的 spawn argv（纯函数，抽出来为了能**真的跑断言**而不用 spawn 进程 ——
 * 与另四家的 buildXxxArgs 同一个理由）。
 *
 * 口径见上方大注释。`-a` 信任项目本地配置；`--session` 只在有续接 id 时传
 * （别传空串——空串会被当成"打开空 id"）。
 */
export function buildPiArgs(resumeSessionId) {
  const args = [];
  if (resumeSessionId) {
    args.push('--session', String(resumeSessionId));
  }
  args.push(
    '--mode', 'json',
    '-a'
  );
  return args;
}

/** spawn pi 跑一个 prompt（非交互），返回 { pid, child }（参数口径见上方注释）。 */
export async function launchPiPrint(cwd, promptText, resumeSessionId) {
  const args = buildPiArgs(resumeSessionId);
  const { exe, prefixArgs } = resolvePiExe();
  const spawnArgs = [...prefixArgs, ...args];
  return new Promise((resolve, reject) => {
    let child;
    if (process.platform === 'win32') {
      child = spawn(exe, spawnArgs, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: false,
        env: buildPiEnv()
      });
    } else {
      child = spawn(exe, spawnArgs, {
        cwd,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildPiEnv()
      });
    }
    attachPromptStdin(child, promptText, resolve, reject);
  });
}

/**
 * pi --mode json 事件处理器（协议官方参考 packages/coding-agent/docs/json.md，
 * 事件形状 2026-10-13 用本机 v1.2.0 + mock provider 实测核对）。
 *
 * 与 createCodebuddyEventHandler 的关系：**刻意再写一份**而不是复用 claude 的
 * stream-json handler —— pi 的协议与 claude 一处都对不上：会话标识在首条
 * session header（不是 system/init）、正文走 message_update 的嵌套
 * assistantMessageEvent（不是 assistant.message.content 块）、工具调用是
 * tool_execution_start/end 平铺事件（不是 tool_use + user(tool_result) 两条）。
 * 将来协议分叉时在这里修，不会顺带改坏 claude 那条链路（本仓库对"同一份口径
 * 多处实现"的失效方式有惨痛记忆：不报错，只是悄悄少一半数据）。
 *
 * 事件分派：
 *   session               → 会话 id 落 job.claudeSessionId（--session 续接用）
 *   message_update        → assistantMessageEvent.text_delta / thinking_delta 增量；
 *                           type === 'error' 是 provider 流错误 → job.agentError
 *   tool_execution_start  → tracker running（args 是完整解析值，不用拼 delta）
 *   tool_execution_end    → tracker 终态（result.content 块数组 → extractToolText）
 *   auto_retry_end{success:false} / compaction_end{errorMessage}
 *                         → 终局失败 → job.agentError
 *   其余（agent_* / turn_* / message_start|end / queue_* / compaction_* 成功路径/
 *   tool_execution_update 的 partialResult）一律忽略 —— 正文已由 text_delta
 *   增量覆盖，message_end 只是权威副本（重复）；工具中间输出外部 CLI 给不出
 *   （与 runExternalTurn 不发 tool_output 同一条理由）。
 * （导出仅为回归测试可见：taskRunner.pi.test.js）
 */
export function createPiEventHandler(job, appendOutput, appendThinking, toolCalls) {
  const tracker = toolCalls || createToolCallTracker(job);
  const markError = (msg) => {
    const text = typeof msg === 'string' && msg.trim() ? msg.trim() : 'pi 执行出错';
    // 与另四家同一条口径：只记第一条（后续事件可能是同一次失败的余波）
    if (!job.agentError) job.agentError = text;
  };
  return (evt) => {
    if (!evt || typeof evt !== 'object') return;
    // 首条 session header：会话 id（续接 --session 用）。重复推送只认第一条。
    if (evt.type === 'session' && typeof evt.id === 'string') {
      if (!job.claudeSessionId || job.claudeSessionId !== evt.id) {
        job.claudeSessionId = evt.id;
        publish('job:update', job);
      }
      return;
    }
    if (evt.type === 'message_update') {
      const sub = evt.assistantMessageEvent;
      if (!sub || typeof sub !== 'object') return;
      if (sub.type === 'text_delta' && typeof sub.delta === 'string') {
        appendOutput(sub.delta);
      } else if (sub.type === 'thinking_delta' && typeof sub.delta === 'string') {
        appendThinking(sub.delta);
      } else if (sub.type === 'error') {
        // provider 流中途出错（reason 如 'aborted'/'error'，error 带消息）
        markError(sub.error?.message || sub.error || sub.reason);
      }
      // text_start/text_end/toolcall_*：增量已覆盖（toolcall 的完整形态在
      // tool_execution_start 里），start/end 不重复处理
      return;
    }
    if (evt.type === 'tool_execution_start' && typeof evt.toolCallId === 'string') {
      tracker.record({
        id: evt.toolCallId,
        name: evt.toolName || 'tool',
        input: evt.args,
        status: 'running'
      });
      return;
    }
    if (evt.type === 'tool_execution_end' && typeof evt.toolCallId === 'string') {
      // result 形如 { content: [{type:'text',text}], details } —— 与 claude 的
      // tool_result.content 同形状，extractToolText 直接吃
      const text = extractToolText(evt.result?.content ?? evt.result);
      tracker.record({
        id: evt.toolCallId,
        status: evt.isError ? 'error' : 'done',
        output: text,
        error: evt.isError ? (text || '工具执行失败') : ''
      });
      return;
    }
    if (evt.type === 'auto_retry_end' && evt.success === false) {
      // 自动重试耗尽：finalError 是终局消息
      markError(evt.finalError);
      return;
    }
    if (evt.type === 'compaction_end' && evt.errorMessage) {
      // 压缩失败且不会重试（aborted=false 且无 result）
      markError(evt.errorMessage);
      return;
    }
    // 其余事件忽略（含 agent_settled 的 aborted —— 那是"被中止"，
    // 由 taskRunner 的 cancelledJobs 口径处理，不在这里判失败）
  };
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
 * 思考文本的保底上限（尾部截断：模型偶尔会长时间闷头思考，尾巴才是最新的）。
 * 与工具流水的截断同一口径，只是这里量级更大。
 */
export const MAX_THINKING = 100 * 1024 * 1024;

/**
 * 追加一段思考文本：截尾 + 记「思考段计时」。
 *
 * 计时口径与 zen-ai-chat-ui 的 ThinkingBlock 一致：**第一个分片记起点、之后每个
 * 分片把终点往前推**（不是"思考状态转 done 为止"——那样会把"想完了但正文还没开始"
 * 的空档也算进去）。这两个时间戳随 job 落盘（jobs.json）、随 live-jobs 跨实例可见，
 * 前端折叠着也能显示「想了多久」；只在内存里算的话，刷新页面就没了。
 *
 * 导出仅为回归测试可见（taskRunner.thinking.test.js）：跑整条 runSingleSubtask
 * 去断言这两个字段，代价是起一个假 CLI 进程，不划算。
 *
 * @param {object} job  执行记录（thinking / lastActivityAt 与两个计时字段都记在它身上）
 * @param {string} text 本批新增的思考文本
 * @param {string} [at] 时间戳（ISO）；默认取当前时刻，测试可注入
 * @returns {string} 本次真正追加进 job.thinking 的增量（供批量推送用）
 */
export function appendThinkingToJob(job, text, at = nowIso()) {
  if (!text) return '';
  job.lastActivityAt = at;
  if (!job.thinkingStartedAt) job.thinkingStartedAt = at;
  job.thinkingEndedAt = at;
  const prev = job.thinking || '';
  job.thinking = (prev + text).slice(-MAX_THINKING);
  // 顶到上限之后这里返回 ''（增量不再往前端推）—— 100MB 的思考文本没有真实场景，
  // 真到那一步终态快照仍带全文尾巴，不值得为它把增量算法复杂化。
  return job.thinking.slice(prev.length);
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

// ── codearts 执行器（2026-10-25 加入） ────────────────────────────────────
// 华为云码道代码智能体 CLI（CodeArts Agent CLI，华为云产品）。与另五家同构：
//   codearts run --format json --auto [-s <ses_id>]
//     - prompt 从 stdin 喂（无位置参数时读 stdin，与 opencode 同效）
//     - --auto 以 always_allow 模式跑 bash。**必须带**：默认档是沙箱
//       （安装器往 ~/.codeartsdoer/cli-data/storage/permission/config.json 写
//       "bash_mode": "sandbox"），沙箱里 git 读不到真实仓库状态（实测 git log /
//       diff / status 拿不到），而派发链要求 agent 自己 commit。
//     - -s <ses_id> 原地续接（sessionID 不变，实测记得上文）
//     - 不传 -m：模型跟随它自己的配置（与另五家同一口径）
//
// **它就是 opencode 的 fork**（2026-10-25 实测，四处实锤）：配置首行写着
// "$schema": "https://opencode.ai/config.json"；`auth login --help` 的位置参数
// 说明原文是 "opencode auth provider"；入口 codearts.cmd 里全是 OPENCODE_* 环境
// 变量；--attach 的示例端口就是 opencode 的 4096。所以 --format json 的事件流
// （step_start / text / reasoning / tool_use / step_finish / error、顶层 sessionID、
// part.state.{status,input,output}）与 opencode 逐字一致，handler 直接转调。
//
// 三个必须记住的坑：
//   1. **鉴权只认 AK/SK 环境变量**（CODEARTS_CLI_AK / CODEARTS_CLI_SK），没有
//      浏览器登录那一出（TUI 会弹，run 不会）。缺了它们 CLI 打一行中文错误后
//      **退出码仍是 0** —— 与 codebuddy 同款坑，判失败不能只看 exit code。
//   2. **不经 codearts.cmd 就必须自己补齐它那串环境变量**（见 buildCodeArtsEnv）：
//      少了 OPENCODE_CONFIG / KERNEL_DATA_DIR，它会去读用户自己那套 opencode 的
//      配置和数据目录（~/.config/opencode、~/.local/share/opencode 的 db）。
//   3. **它会往项目根写 .codeartsdoer/**（memory/experience 的落地目录，--pure
//      也拦不住），里面 mem-exp-config.json 不在它自己的 .gitignore 里 → 每个被
//      派发的仓库都会多出一条未跟踪文件。launchCodeArtsRun 会顺手写
//      .git/info/exclude（只改本地仓库元数据，不动工作区、不入库）。

/**
 * 解析 codearts 可执行文件。
 *
 * 安装器（官网 install.ps1）把 shim 放在 ~/.codeartsdoer/installers、真身放在
 * 同目录 bin/codearts.exe；PATH 上能查到的也是 shim。Node 23+ 拒绝 spawn .cmd
 * （EINVAL），所以固定走 bin 下的 exe —— 环境变量由 buildCodeArtsEnv 补齐。
 */
export function resolveCodeArtsExe() {
  const exe = path.join(os.homedir(), '.codeartsdoer', 'installers', 'bin', 'codearts.exe');
  if (fs.existsSync(exe)) return { exe, prefixArgs: [] };
  // 兜底：装到别处时按 PATH 找原生 exe（非 Windows 上就是这个）
  try {
    const lines = execFileSync('where', ['codearts'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const directExe = lines.find(s => /\.exe$/i.test(s));
    if (directExe && fs.existsSync(directExe)) return { exe: directExe, prefixArgs: [] };
  } catch { /* fallback */ }
  return { exe: process.platform === 'win32' ? 'codearts.cmd' : 'codearts', prefixArgs: [] };
}

/**
 * codearts 子进程环境：复刻 ~/.codeartsdoer/installers/codearts.cmd 里那串 SET。
 *
 * 为什么逐个抄而不是直接 spawn .cmd：Node 23+ 对 .cmd 直接 EINVAL，走 shell 会让
 * stdin 管道与杀进程树都变复杂。这些变量是它"认自己是谁"的全部依据（少了就走
 * opencode 的目录），照抄比猜依赖关系稳。
 *
 * 刻意**不抄** NODE_TLS_REJECT_UNAUTHORIZED=0：shim 里关掉了全局证书校验，抄进
 * 来会污染本进程派生的所有 TLS 请求。实测不设它也能正常连华为云。
 * （导出仅为回归测试可见：taskRunner.codearts.test.js）
 */
export function buildCodeArtsEnv() {
  const root = path.join(os.homedir(), '.codeartsdoer');
  const env = { ...process.env };
  env.SCENARIO = 'codeartsdoer';
  env.KERNEL_DATA_DIR = path.join(root, 'cli-data');
  env.KERNEL_STATE_DIR = path.join(root, 'state');
  env.KERNEL_CONFIG_DIR = root;
  env.OPENCODE_CHANNEL = 'latest';
  env.OPENCODE_CONFIG = path.join(root, 'codearts_cli.json');
  env.OPENCODE_CONFIG_FILE = 'codearts_cli.json,codearts_cli.jsonc';
  env.OPENCODE_MODE = 'tui';
  env.PLUGIN_ENV = 'hc';
  env.OPENCODE_DISABLE_MODELS_FETCH = '1';
  env.OPENCODE_DISABLE_AUTOUPDATE = 'true';
  env.OPENCODE_ALWAYS_NOTIFY_UPDATE = 'false';
  env.CODEARTS_DISABLE_AUTO_UPDATE = 'true';
  env.CODEAGENT_USE_MESSAGE_FEEDBACK = 'false';
  env.OMO_SEND_ANONYMOUS_TELEMETRY = '0';
  env.LANG = 'zh_CN.UTF-8';
  // 凭据兜底：用户常常是「装完/配完环境变量，应用还开着」——`setx` 只对新进程生效，
  // 于是 env 里读不到 AK/SK，任务会以"认证失败 + 退出码 0"静默失败（最难查的那种）。
  // 缺的时候回读一次用户级环境变量（HKCU\Environment），与 PATH 那个坑同一性质。
  for (const key of ['CODEARTS_CLI_AK', 'CODEARTS_CLI_SK']) {
    if (!env[key]) {
      const fromUserEnv = readWindowsUserEnv(key);
      if (fromUserEnv) env[key] = fromUserEnv;
    }
  }
  return env;
}

/**
 * 读 Windows 用户级环境变量（HKCU\Environment），只在 process.env 里没有时用。
 * 非 win32 或读不到一律返回空串 —— 调用方按"没配"处理。
 */
function readWindowsUserEnv(name) {
  if (process.platform !== 'win32' || !name) return '';
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const line = out.split(/\r?\n/).find(row => new RegExp(`\\s${name}\\s+REG_`).test(row));
    if (!line) return '';
    // 形如 `    CODEARTS_CLI_AK    REG_SZ    HPUA...`
    const parts = line.trim().split(/\s{2,}/);
    return parts.length >= 3 ? parts.slice(2).join('  ').trim() : '';
  } catch {
    return '';
  }
}

/** codearts 的 spawn argv（纯函数，理由同另几家的 buildXxxArgs）。 */
export function buildCodeArtsArgs(resumeSessionId) {
  const args = ['run', '--format', 'json', '--auto'];
  if (resumeSessionId) {
    args.push('-s', String(resumeSessionId));
  }
  return args;
}

/**
 * 把「改文件 / 写文件 / 抓网页」这几档权限放宽成 allow。
 *
 * **这是本轮最难查的一个坑**（2026-10-25）：`--auto` 的帮助原文是 "run commands in
 * always_allow mode"，它**只管 bash**。edit / write 走的是另一套权限存储：
 *   <KERNEL_DATA_DIR>/storage/permission/global.json  →  [{ permission, pattern, action }]
 * 默认档位是 edit: ask / write: ask —— 交互 TUI 里会弹窗让人点，headless 派发没人能点，
 * CLI 直接 `auto-rejecting`：agent 的每一次 edit/write 都返回
 * "The user rejected permission to use this specific tool call."，任务是
 * 「代码在手上、只差落盘」的状态卡住（用户截图里连续 4 次写操作全被拒）。
 * 注意：写进 `~/.codeartsdoer/codearts_cli.json` 的 `permission` 段**不生效**
 * （实测配置层被存储层覆盖），只能改这个文件。
 *
 * 只翻这几项、其余条目原样保留；文件不存在就按它自己首次启动写出来的默认档建一份。
 * 写完不打 BOM（它的 JSON 解析器不认 BOM，会静默失败）。
 * （导出仅为回归测试可见：taskRunner.codearts.test.js）
 */
export function ensureCodeArtsPermissions(dataDir) {
  const ALLOW = ['edit', 'write', 'webfetch'];
  const DEFAULTS = [
    { permission: 'browser', pattern: '*', action: 'ask' },
    { permission: 'edit', pattern: '*', action: 'ask' },
    { permission: 'write', pattern: '*', action: 'ask' },
    { permission: 'webfetch', pattern: '*', action: 'ask' },
    { permission: 'websearch', pattern: '*', action: 'allow' },
    { permission: 'external_directory_write', pattern: '*', action: 'allow' },
    { permission: 'external_directory_read', pattern: '*', action: 'allow' },
    { permission: 'dotfile', pattern: '*', action: 'allow' },
  ];
  try {
    const dir = dataDir || path.join(os.homedir(), '.codeartsdoer', 'cli-data');
    const file = path.join(dir, 'storage', 'permission', 'global.json');
    let rules;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      rules = JSON.parse(raw.replace(/^\uFEFF/, ''));
      if (!Array.isArray(rules)) rules = null;
    } catch { /* 不存在 / 坏了：按默认档重建 */ }
    if (!rules) rules = DEFAULTS.map(rule => ({ ...rule }));

    let changed = false;
    for (const rule of rules) {
      if (ALLOW.includes(rule.permission) && rule.action !== 'allow') {
        rule.action = 'allow';
        changed = true;
      }
    }
    // 默认档里缺项时补上（例如老版本只有 partial 列表）
    for (const name of ALLOW) {
      if (!rules.some(rule => rule.permission === name)) {
        rules.push({ permission: name, pattern: '*', action: 'allow' });
        changed = true;
      }
    }
    if (!changed && fs.existsSync(file)) return;

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(rules, null, 2), 'utf8');
  } catch { /* 权限文件写不了不该让任务直接失败，CLI 会照自己的默认档跑 */ }
}

/**
 * 保证 .codeartsdoer/ 不进版本库。
 *
 * codearts 每次运行都会在项目根生成 .codeartsdoer/mem-exp-config.json（经验沉淀的
 * 落地目录），它自己的 .codeartsdoer/.gitignore 不覆盖这个文件，--pure 也拦不住。
 * 本仓的派发链让 agent 自己 git add，看到未跟踪文件很可能顺手带上 —— 于是往
 * .git/info/exclude 补一行（只影响本地，不产生任何工作区改动）。
 *
 * 失败一律吞掉：没有 .git（非仓库目录）或没有写权限时，让任务照常跑。
 * （导出仅为回归测试可见：taskRunner.codearts.test.js）
 */
export function ensureCodeArtsGitExclude(cwd) {
  try {
    const gitDir = path.join(cwd, '.git');
    if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return;
    const excludeFile = path.join(gitDir, 'info', 'exclude');
    const marker = '.codeartsdoer/';
    let current = '';
    try { current = fs.readFileSync(excludeFile, 'utf8'); } catch { /* 首次没有这个文件 */ }
    if (current.split(/\r?\n/).some(line => line.trim() === marker)) return;
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    const next = current && !current.endsWith('\n') ? `${current}\n${marker}\n` : `${current}${marker}\n`;
    fs.writeFileSync(excludeFile, next, 'utf8');
  } catch { /* 忽略：排除失败不影响任务本身 */ }
}

/** spawn codearts 跑一个 prompt（非交互），返回 { pid, child }。 */
export async function launchCodeArtsRun(cwd, promptText, resumeSessionId) {
  ensureCodeArtsGitExclude(cwd);
  // 每次派发前都确保 edit/write/webfetch 是 allow —— 用户可能在 TUI 里把它改回 ask，
  // 那时所有写操作都会被 auto-reject（见该函数注释）。
  ensureCodeArtsPermissions();
  const args = buildCodeArtsArgs(resumeSessionId);
  const { exe, prefixArgs } = resolveCodeArtsExe();
  const spawnArgs = [...prefixArgs, ...args];
  return new Promise((resolve, reject) => {
    let child;
    if (process.platform === 'win32') {
      child = spawn(exe, spawnArgs, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: false,
        env: buildCodeArtsEnv()
      });
    } else {
      child = spawn(exe, spawnArgs, {
        cwd,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildCodeArtsEnv()
      });
    }
    attachPromptStdin(child, promptText, resolve, reject);
  });
}

/**
 * codearts --format json 事件处理器：**转调 opencode 那一份**。
 *
 * 2026-10-25 用本机 26.10.9 实跑核对过事件形状（文本、工具调用、step_finish 的
 * tokens、顶层 sessionID 逐字段一致），因此不再抄第二份实现 —— 本仓库为"同一份
 * 口径写两遍"吃过太多亏（分叉时不报错，只是悄悄少一半数据）。
 *
 * 仍留独立入口而不是在表里直接写 createOpencodeEventHandler：华为是 fork 持有方，
 * 协议随时可能被它改（它已经改过鉴权：从浏览器登录改成 AK/SK），那时在这里加分支，
 * 不会顺带改坏 opencode 那条链路。
 *
 * 另外记住：它的 stdout 会混进非 JSON 行（免费套餐限流时的"模型排队"提示，实测
 * 一次问答刷 48 行）—— 解析循环的 try/catch 跳过即可，不要当成协议错误。
 * （导出仅为回归测试可见：taskRunner.codearts.test.js）
 */
export function createCodeArtsEventHandler(job, appendOutput, appendThinking, toolCalls) {
  const inner = createOpencodeEventHandler(job, appendOutput, appendThinking, toolCalls);
  // opencode 那份假定入参一定是解析好的对象（它的调用方只在 JSON.parse 成功后才喂）。
  // 码道这边 stdout 会混进非 JSON 行，解析层多一层保险不打紧 —— 顺手把
  // `null` / 标量挡在门外（`JSON.parse('null')` 也会成功返回 null）。
  return (evt) => {
    if (!evt || typeof evt !== 'object') return;
    inner(evt);
  };
}

/**
 * codex `exec --json` 事件处理器。
 *
 * 事件形态（codex-cli 0.157.x；schema 源：openai/codex codex-rs/exec/src/exec_events.rs）：
 *   { type:'thread.started', thread_id }            会话续接标识（exec resume <id>）
 *   { type:'turn.started' } / { type:'turn.completed', usage }
 *   { type:'turn.failed', error:{ message } }       本轮终态失败（进程退出码可能仍是 0）
 *   { type:'item.started'|'item.updated'|'item.completed', item:{ id, type, ... } }
 *   { type:'error', message }                       重试等非终止信息（真失败走 turn.failed）
 *
 * item.type（snake_case）分派：
 *   agent_message      正文 → output（按 item.id 做累积/增量去重，两种推送语义都兼容）
 *   reasoning          思考 → thinking
 *   command_execution  命令 → 工具调用（command 作参数摘要，aggregated_output 作结果）
 *   file_change        改动文件清单 → 工具调用
 *   mcp_tool_call      MCP 工具 → 工具调用（server.tool 作名字）
 *   web_search         搜索 → 工具调用
 *   error              非致命告警（配置项被忽略 / 模型元信息缺失等）→ 贴进 output，不判失败
 *   其余（todo_list / collab_tool_call / 未来新增）忽略 —— 事件枚举是 non_exhaustive，
 *   未知类型不能影响正文收集与终态判定。
 * （导出仅为回归测试可见：taskRunner.codex.test.js）
 */
export function createCodexEventHandler(job, appendOutput, appendThinking, toolCalls) {
  const tracker = toolCalls || createToolCallTracker(job);
  const seenTextItems = new Map(); // item.id -> 已落地的累计文本

  const appendItemText = (item, isThinking) => {
    const text = typeof item?.text === 'string' ? item.text : '';
    if (!text) return;
    const id = typeof item?.id === 'string' ? item.id : '';
    const prev = id ? seenTextItems.get(id) : undefined;
    let delta = text;
    if (prev !== undefined) {
      delta = text.startsWith(prev) ? text.slice(prev.length) : text;
    }
    if (!delta) return;
    if (id) seenTextItems.set(id, prev !== undefined ? prev + delta : text);
    if (isThinking) appendThinking(delta);
    else appendOutput(delta);
  };

  // codex 的 status: in_progress | completed | failed | declined（snake_case）
  const mapItemStatus = (raw) => {
    const s = typeof raw === 'string' ? raw.toLowerCase() : '';
    if (s === 'completed') return 'done';
    if (s === 'failed' || s === 'declined') return 'error';
    return 'running';
  };

  const changesText = (changes) => (Array.isArray(changes) ? changes : [])
    .map(c => (c && c.path ? `${c.kind || 'update'} ${c.path}` : ''))
    .filter(Boolean)
    .join('\n');

  const handleItem = (item) => {
    if (!item || typeof item !== 'object') return;
    switch (item.type) {
      case 'agent_message':
        appendItemText(item, false);
        return;
      case 'reasoning':
        appendItemText(item, true);
        return;
      case 'error':
        // 非致命告警：原样贴出来让用户看得见，但不置 agentError —— 那会把告警变成任务失败
        if (item.message) appendOutput(`\n> [codex] ${item.message}\n`);
        return;
      case 'command_execution': {
        const status = mapItemStatus(item.status);
        tracker.record({
          id: item.id,
          name: 'command_execution',
          input: { command: item.command },
          status,
          output: status === 'running' ? undefined : item.aggregated_output,
          error: status === 'error' ? `命令未成功完成（exit_code=${item.exit_code ?? 'null'}）` : ''
        });
        return;
      }
      case 'file_change': {
        const status = mapItemStatus(item.status);
        tracker.record({
          id: item.id,
          name: 'file_change',
          input: { changes: item.changes },
          status,
          output: status === 'running' ? undefined : changesText(item.changes),
          error: status === 'error' ? '文件改动未应用' : ''
        });
        return;
      }
      case 'mcp_tool_call': {
        const status = mapItemStatus(item.status);
        tracker.record({
          id: item.id,
          name: item.server && item.tool ? `${item.server}.${item.tool}` : (item.tool || 'mcp_tool_call'),
          input: item.arguments,
          // result.content 是 MCP 的内容块数组（与 claude 的 tool_result 同形态），
          // 直接喂给 extractToolText 能压成文本；没有 content 时整包 JSON 兜底
          status,
          output: status === 'running' ? undefined : (item.result?.content ?? item.result),
          error: item.error?.message || (status === 'error' ? 'MCP 工具调用失败' : '')
        });
        return;
      }
      case 'web_search': {
        const status = mapItemStatus(item.status);
        tracker.record({
          id: item.id,
          name: 'web_search',
          input: { query: item.query },
          status,
          output: status === 'running' ? undefined : item.results
        });
        return;
      }
      default:
        return;
    }
  };

  return (evt) => {
    if (!evt || typeof evt !== 'object') return;
    // thread_id 是 codex 的会话续接标识（exec resume <id>）。复用 claudeSessionId 字段：
    // 前端与续接路由都认它，换执行器只是取值来源不同。
    if (evt.type === 'thread.started') {
      if (typeof evt.thread_id === 'string' && evt.thread_id && job.claudeSessionId !== evt.thread_id) {
        job.claudeSessionId = evt.thread_id;
        publish('job:update', job);
      }
      return;
    }
    if (evt.type === 'item.started' || evt.type === 'item.updated' || evt.type === 'item.completed') {
      handleItem(evt.item);
      return;
    }
    if (evt.type === 'turn.failed') {
      const msg = evt.error?.message
        || (evt.error?.additional_details ? String(evt.error.additional_details) : '')
        || 'codex 执行出错';
      if (!job.agentError) job.agentError = msg;
      return;
    }
    if (evt.type === 'error') {
      // 非终止信息（如 "Reconnecting... 1/5" 重试提示）：贴进 output，终态仍由 turn.* 决定
      if (evt.message) appendOutput(`\n> [codex] ${evt.message}\n`);
    }
  };
}

/**
 * 这次执行要不要把图片先转成文字描述。
 *
 * 优先级：本次运行载体 > 任务上记的选择 > 按执行器兜底。
 *   · 任务上的 `imageText` 是派发那一刻用户勾的（见 dispatchInstruction.js）——
 *     同一条任务重跑时"当时怎么勾的"应当继续生效，不用每次再确认一遍；
 *   · 没有记过（老任务 / g ai 用 dispatch_task 派的活）就按执行器兜底：
 *     **codearts 默认开**，别家默认关 —— 只有它读不了图（2026-10-26 实测，
 *     见 imageDescribe.js 头注释），别家能直接把图片塞进上下文，多一层文字转述
 *     只会丢信息。
 *
 * @param {object} task
 * @param {object} sub
 * @param {string} executor 已归一化的执行器名
 * @returns {boolean}
 */
export function shouldDescribeImages(task, sub, executor) {
  if (sub && typeof sub.imageText === 'boolean') return sub.imageText;
  if (task && typeof task.imageText === 'boolean') return task.imageText;
  return executor === 'codearts';
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
 *        续接历史会话:claude 走 --resume <id>，opencode 走 --session <id>，
 *        codex 走 exec resume <thread_id>，codebuddy 走 --resume <session_id>，
 *        pi 走 --session <id>（只在同一 cwd 的项目里找，见 pi 段注释）。
 *        id 来自上一轮 stream 事件捕获的会话标识(五家都记在 job.claudeSessionId)。
 * @param {string} [options.executor]
 *        执行器 'claude' | 'opencode' | 'codex' | 'codebuddy' | 'pi'。缺省回落 'claude'；路由层负责把
 *        "body 指定 > 配置默认"先解析好再传进来。
 * @returns {Promise<'done'|'cancelled'|'error'>} 本次运行的终态
 */
export async function runSingleSubtask(task, sub, repoPath, branch, options) {
  const opts = options || {};
  const resumeSessionId = opts.resumeSessionId || null;
  const executor = normalizeTaskExecutor(opts.executor);
  // 提示词唯一来源：派发时抄进任务的快照（simpleOverride → sub.promptOverride）。
  // 旧实现还有一条"任务绑定预置词库条目"的回退，随提示词合并（2026-10-04）删除。
  const promptTemplate = sub.promptOverride || '';
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
    // 「图片 → 文字」预处理：见 imageDescribe.js 头注释（codearts 读不了图）。
    // 只有当这批附件里确实有图片时才去解析模型，纯文本派发不多读一次配置。
    let describeImage;
    if (shouldDescribeImages(task, sub, executor) && pickImageAttachments(allAttachments).length > 0) {
      describeImage = await createImageDescriber();
    }
    const { block: attachmentBlock } = await buildAttachmentBlock(allAttachments, { describeImage });
    if (attachmentBlock) {
      prompt += `\n\n---\n本任务包含 ${allAttachments.length} 个附件（请按文件路径读取，不要让用户重新提供）：${attachmentBlock}\n---`;
    }
  }

  // ── 两块「背景」都拼在最前面，任务正文压尾 ──
  // 顺序刻意是 [环境上下文 → 记忆指针 → 任务正文]：
  //   · 越靠后离模型的注意力中心越近，**用户真正要办的那句话必须在最后一屏**；
  //   · 记忆块夹在两块之间，不能放末尾 —— 放末尾等于把"背景"讲成了"当前任务"，
  //     Agent 会以为这轮用户要求它去整理记忆库。
  // 两块都可用 `task.<key> === false` 单任务关掉（默认开 —— 老任务不迁移也一并受益）。
  const prefixBlocks = [];

  if (task.envContext !== false) {
    // 续聊轮只要精简刷新版（见 resolveEnvContext 的注释）
    const envBlock = await resolveEnvContext(repoPath, { compact: !!resumeSessionId });
    if (envBlock) prefixBlocks.push(envBlock);
  }

  if (task.memoryContext !== false) {
    const memBlock = buildMemoryPointerBlock({
      memoryDir: MEMORY_DIR,
      // 首次在某仓库干活时目录还不存在 —— 这时不给项目路径，块里会明说
      // "本项目还没有条目"，Agent 收尾时自己建。
      projectIndexFile: resolveProjectMemoryIndex(repoPath),
      // 续聊轮不再重复讲捕获纪律：同一场对话里讲第二遍纯属噪音。
      capture: !resumeSessionId,
    }).block;
    if (memBlock) prefixBlocks.push(memBlock);
  }

  if (prefixBlocks.length > 0) {
    prompt = `${prefixBlocks.join('\n\n---\n\n')}\n\n---\n\n${prompt}`;
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
    // 字段名保留 claudeSessionId:claude 的 session_id / opencode 的 sessionID /
    // codebuddy 的 session_id / pi 的 session header id 都存这里,
    // 语义是"该执行器的会话续接标识"。
    claudeSessionId: resumeSessionId,
    // 工具调用流水（{id,name,argsPreview,arguments,result,status,error}[]）。
    // 先给个空数组，前端拿到的 job:update 就有了稳定形态，不用到处判 undefined。
    toolCalls: [],
    // 思考段计时（第一个思考分片 → 最后一个分片，ISO 字符串）。
    // 显式给 null 而不是不写：快照 / 落盘 / 跨实例的口径要一致，前端也不用判 undefined。
    // 记法与语义见 appendThinkingToJob。
    thinkingStartedAt: null,
    thinkingEndedAt: null
  };
  jobs.set(jobId, job);
  publish('job:update', job);
  // 跨实例可见性：别的 g ui 的看板列完全由执行记录推导，「进行中」必须能让它们
  // 读到一个 running/pending 记录 —— 终态以前从来不落盘，所以这里（以及下面的
  // 流式 chunk 与终态 flush）是运行中 job 唯一的对外通路，见 liveJobs.js。
  scheduleActiveJobsSave();

  // 声明在 try 之外：启动器就抛错时 finally 也要能安全收口（见 toolTracker?.seal）
  let toolTracker = null;

  try {
    // 查表而不是 if 链：加执行器只改 EXECUTOR_LAUNCHERS 一张表（五家以后 if 链
    // 已经长得该收了）。查无此人理论上不可能 —— normalizeTaskExecutor 刚夹过一遍。
    const launcher = EXECUTOR_LAUNCHERS[executor] || launchClaudeInNewWindow;
    const { pid, child } = await launcher(repoPath || process.cwd(), prompt, resumeSessionId);
    job.pid = pid;
    // 保存 child 引用，供 cancel 接口调用 kill
    job.child = child;
    job.startedAt = nowIso();
    // 最后一次产出的时刻（正文 / 思考 / 工具调用，见下面三处赋值）。
    // 进度报告靠它说"已经 N 分钟没动静了" —— 光看工具调用次数看不出"卡住"，
    // 次数多也可能是一小时前那一批。起跑时先按开始时间记账，
    // 这样"跑了 5 分钟一个事件都没出"本身就是可判定的静默。
    job.lastActivityAt = job.startedAt;
    job.status = 'running';
    publish('job:update', job);

    // 流式 NDJSON 解析：把 stdout 当作所选执行器的 JSON 事件流处理
    //   正文/思考块   → job.output / job.thinking（前端主视图 + 折叠思考）
    //   会话标识      → job.claudeSessionId（续接对话用）
    //   工具调用      → job.toolCalls（前端工具块 + 落盘归档）
    //   其他事件      → 忽略，避免噪声
    const MAX_OUTPUT = 100 * 1024 * 1024;
    // 思考的截断上限是模块级的 MAX_THINKING（appendThinkingToJob 要用）
    job.output = '';
    job.thinking = '';
    const lineBuf = { stdout: '', stderr: '' };

    // 追加正文（尾部截断保底 + 增量推送给前端）
    const appendOutput = (text) => {
      if (!text) return;
      job.lastActivityAt = nowIso();
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
      // 追加 / 截断 / 思考段计时都在 appendThinkingToJob 里（导出给回归测试的那份），
      // 这里只负责批量推送：一批 NDJSON 处理完统一 flush 一次
      thinkingBatch += appendThinkingToJob(job, text);
    };

    // 工具调用：写进 job.toolCalls（随 job 落盘），并按批推 job:toolcalls 给前端。
    // 收口（把没收尾的调用标终态）在 finally 里做，见下方 toolTracker.seal()。
    toolTracker = createToolCallTracker(job, (updates) => {
      // 工具调用也算"有产出"：一次 Bash 跑十分钟不吐字，中间不该被判成静默
      job.lastActivityAt = nowIso();
      publish('job:toolcalls', { id: job.id, updates });
    });

    const makeHandler = EXECUTOR_HANDLERS[executor] || createClaudeEventHandler;
    const handleEvent = makeHandler(job, appendOutput, appendThinking, toolTracker);

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
      // 每批 chunk 后防抖写一次 live-jobs（1.5s 内只写一次），让别的实例看得到进度。
      // 不写 jobs.json —— 那份是历史档案，几十 MB 级别的东西不该被 1.5s 一次重写。
      scheduleActiveJobsSave();
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

/**
 * polling 等进程退出：信号 0 探测存活。
 *
 * 刻意**没有**超时兜底（2026-09-30 去掉原 30 分钟那一版）。那一版只 resolve、不 kill，
 * 于是任何跑过 30 分钟的任务都会在这里返回，落到调用处那段"判定终态"的代码里被
 * 静默标成 `done` / exitCode 0 并 flush 进 jobs.json —— 而 CLI 子进程还在机器上继续
 * 改文件，句柄也已经从 `job.child` 上删掉，连「停止」都杀不掉它。
 * 那不是"超时被杀"，是**谎报成功**：看板上它进了「已完成」、卡片上开始显示用时，
 * 而实际活儿还在跑。用时统计要建立在"跑完了"这个事实上，这个兜底正好在破坏它。
 *
 * 现在进程真的不退出时唯一的出路是用户点「停止」（taskkill 之后 polling 随即收到
 * ESRCH）；polling 本身每 1.5s 一次，代价可以忽略。
 */
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
  });
}

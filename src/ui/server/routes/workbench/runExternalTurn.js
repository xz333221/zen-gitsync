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
// 外部 CLI 引擎的「一轮对话」执行器。
//
// 与内置 g ai 的**根本差别**：谁跑智能体循环。
//   g ai     ── 服务端跑：streamChatOnce 拿 LLM 流 → 服务端 executeTool → 回灌 → 循环
//   外部 CLI ── CLI 跑：它有自己的工具集、系统提示词、权限模型。服务端退化成一根管子，
//               只负责 spawn、把它的 NDJSON 翻译成与 g ai **完全相同**的一组 SSE 事件。
//
// 所以这个文件里**没有**任何模型调用、工具执行、安全守卫 —— 那些都是 CLI 自己的事。
//
// ⚠️ 两条不重复实现的红线（本仓库 agentParity.test.js 就是为这类分叉立的规矩）：
//   1. **spawn 与协议解析一律复用 taskRunner.js**，绝不在这里再写一份。
//      `createClaudeEventHandler` / `createOpencodeEventHandler` / `createCodexEventHandler`
//      的签名是 `(job, appendOutput, appendThinking, toolCalls)` —— 回调早已抽象好，
//      这里只是换一组回调（推 SSE 而不是推工作台面板），所以适配层能很薄。
//   2. **权限档不在这里决定**。taskRunner 的 launcher 已经带死了各自的档位
//      （claude: --permission-mode bypassPermissions --dangerously-skip-permissions；
//        opencode: --auto；codex: --dangerously-bypass-approvals-and-sandbox），
//      与工作台任务执行保持一致。要改档位请改 launcher，别在这儿加参数。
//
// 关于 headless 权限（2026-09-28 实测，三家在非交互下的真实行为）：
//   claude   默认档也能跑，但不放开会挡住写操作；工作台那套是 bypassPermissions。
//   codex    默认档是只读沙箱（写文件被拦），所以要 --dangerously-bypass-...
//   opencode **不给 --auto 会卡死**（在等一个永远不会有人回答的交互式批准）。
//   这正是 AgentView 里没有终端、没人能点"允许"所决定的 —— 必须预设档位。

import { spawn, execFile } from 'child_process';
import { logger } from './shared.js';
import { engineLabel } from './agentEngines.js';
import { isPlanToolName } from '../../../../cli/ai/tools.js';
import {
  createToolCallTracker,
  createClaudeEventHandler,
  createOpencodeEventHandler,
  createCodexEventHandler,
  launchClaudeInNewWindow,
  launchOpencodeRun,
  launchCodexExec,
} from './taskRunner.js';

/** 引擎 → spawn 实现。复用 taskRunner，不另写（见文件头红线 1）。 */
export const ENGINE_LAUNCHERS = {
  claude: launchClaudeInNewWindow,
  opencode: launchOpencodeRun,
  codex: launchCodexExec,
};

/** 引擎 → NDJSON 事件处理器工厂。同样复用 taskRunner。 */
export const ENGINE_HANDLERS = {
  claude: createClaudeEventHandler,
  opencode: createOpencodeEventHandler,
  codex: createCodexEventHandler,
};

/** 输出片段最长保留多少字符（与前端 MAX_LOG_DISPLAY 的口径一致，防止会话文件膨胀） */
const MAX_ACCUM = 400_000;

/**
 * 杀掉 CLI 进程树。
 *
 * 为什么不能只 child.kill()：claude/opencode/codex 都会自己再拉起子进程（它跑的命令、
 * 它的内部 worker）。只杀父进程的话，用户点了「停止」但机器上还有东西在跑 ——
 * 表现为"界面停了，文件还在被改"。Windows 上必须 taskkill /T。
 */
function killChildTree(child) {
  if (!child || !child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
      child.kill('SIGTERM');
    }
  } catch { /* 尽力而为：杀不掉也不该让整轮对话抛错 */ }
}

/**
 * 跑一轮外部 CLI 引擎的对话。
 *
 * @param {object}   args
 * @param {object}   args.session        会话记录（会被就地更新：messages / engineSessionId）
 * @param {string}   args.engine         'claude' | 'opencode' | 'codex'
 * @param {string}   args.userMessage    用户这一轮说的话
 * @param {string}   args.cwd            工作目录
 * @param {string}   [args.promptPrefix] 拼在用户消息**前面**的工作区状态块（见 agentRoutes）
 * @param {string[]} [args.filePaths]    本轮附件落盘的绝对路径，附在用户消息后面
 * @param {AbortSignal} [args.signal]    用户点「停止」时中止
 * @param {(evt: object) => void} args.send  SSE 发送器
 * @param {(child: object) => void} [args.onChild]  spawn 成功后回传，供路由层做中止兜底
 * @param {object}   [args.launchers]    注入口（单测传假的，避免真 spawn CLI）
 * @param {object}   [args.handlers]     注入口（同上）
 * @param {Function} [args.killTree]     杀进程树的实现（单测注入，Windows 上真实现走 taskkill）
 * @returns {Promise<{aborted: boolean}>}
 */
export async function runExternalTurn({
  session,
  engine,
  userMessage,
  cwd,
  promptPrefix = '',
  filePaths = [],
  signal,
  send,
  onChild,
  launchers = ENGINE_LAUNCHERS,
  handlers = ENGINE_HANDLERS,
  killTree = killChildTree,
} = {}) {
  const label = engineLabel(engine);
  const launch = launchers[engine];
  const makeHandler = handlers[engine];
  if (typeof launch !== 'function' || typeof makeHandler !== 'function') {
    send({ type: 'error', error: `未知的外部引擎: ${engine}` });
    return { aborted: false };
  }

  if (!Array.isArray(session.messages)) session.messages = [];

  // 附件只传**路径**，内容不进 prompt —— 与 g ai 那条链路同一条口径
  // （外部 CLI 自己有 read 工具，让它按需读，省 token 也更准）。
  const attachBlock = (Array.isArray(filePaths) ? filePaths : []).filter(Boolean).length > 0
    ? `\n\n---\n\n本轮附件已落盘到以下绝对路径，请按需读取：\n${filePaths.filter(Boolean).map(p => `- ${p}`).join('\n')}`
    : '';

  session.messages.push({ role: 'user', content: userMessage || ' ' });

  // 工作区状态块拼在**用户消息前面**：外部 CLI 都只认自己的约定文件，
  // 而往项目里写 AGENTS.md / CLAUDE.md 会弄脏用户的工作区（三个引擎实测也不一致：
  // claude 只读 CLAUDE.md、codex 只读 AGENTS.md、opencode 两个都不读）。
  // 所以统一走 prompt 前缀 —— 一份实现喂三家，且不碰用户的仓库。
  const prompt = `${promptPrefix ? `${promptPrefix}\n\n---\n\n` : ''}${userMessage || ''}${attachBlock}`;

  let child;
  try {
    const launched = await launch(cwd, prompt, session.engineSessionId || '');
    child = launched?.child;
    if (!child) throw new Error('launcher 未返回子进程');
  } catch (err) {
    const msg = `${label} 启动失败：${err?.message || err}`;
    send({ type: 'error', error: msg });
    return { aborted: false };
  }
  if (typeof onChild === 'function') onChild(child);

  // job 只是**载体**：taskRunner 的 handler 与 tracker 都按 job.toolCalls /
  // job.claudeSessionId 这两个字段工作。用一个轻量对象顶上，任务记录不受影响。
  const job = { toolCalls: [], claudeSessionId: session.engineSessionId || '' };

  let text = '';
  const appendText = (t) => {
    if (typeof t !== 'string' || !t) return;
    text = text.length > MAX_ACCUM ? text : text + t;
    send({ type: 'content', delta: t });
  };

  // 工具调用：tracker 的增量回调直接映射成前端已有的两种事件。
  // 外部 CLI 都给不出"命令执行中的增量输出"（那是 g ai 服务端执行才有的），
  // 所以不发 tool_output —— 前端的 toolCall.result 从空开始、tool_result 时一次填满。
  //
  // ⚠️ **必须先补一条 tool_call_start**，哪怕这次更新已经是终态：
  //   claude 会先推 tool_use(running)、再推 tool_result；但 **opencode 与 codex 是
  //   一次性推一条已完成的事件**（opencode state.status=completed / codex item.completed），
  //   根本没有 running 阶段。前端收到 tool_result 时是按 toolCallId 去已有列表里 find 的，
  //   找不到就**静默丢弃** —— 表现是"工具明明跑了，界面上什么都没有"。
  //   所以这里按 id 记一份"已宣告过"，第一次见到就补 start。
  const announced = new Set();
  const tracker = createToolCallTracker(job, (updates) => {
    for (const u of updates) {
      if (!u) continue;
      const id = u.id || '';
      if (id && !announced.has(id)) {
        announced.add(id);
        // 计划类工具额外带完整参数：外部引擎里 claude 的 TodoWrite / opencode 的
        // todowrite 就是计划，前端要靠原始 steps 渲染清单，而 argsPreview 是摘要。
        // 只给计划类发全文，与内置 g ai 那条链路（agentChat.js）保持同一口径。
        const planArgs = isPlanToolName(u.name) ? (u.arguments || '') : undefined;
        send({ type: 'tool_call_start', toolCallId: id, name: u.name, argsPreview: u.argsPreview || '', arguments: planArgs });
      }
      if (u.status !== 'running') {
        send({
          type: 'tool_result',
          toolCallId: id,
          result: u.status === 'error' ? (u.error || u.result || '工具执行失败') : (u.result || ''),
        });
      }
    }
  });

  const handleEvent = makeHandler(job, appendText, (t) => {
    // 思考过程：与正文分开推，前端有独立可折叠区域
    send({ type: 'thinking', delta: t });
  }, tracker);

  // NDJSON 分行：最后一段可能不完整，留给下一批（与 taskRunner 同一套做法）
  const lineBuf = { stdout: '', stderr: '' };
  const handleLine = (line, channel) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (channel === 'stderr' || !trimmed.startsWith('{')) {
      // 非 JSON 行：原样贴出来（CLI 的告警 / 老版本输出都是这种）
      appendText(trimmed + '\n');
      return;
    }
    let evt;
    try { evt = JSON.parse(trimmed); } catch { return; }
    handleEvent(evt);
  };
  const parseLines = (channel, buf) => {
    lineBuf[channel] += buf.toString('utf8');
    const lines = lineBuf[channel].split('\n');
    lineBuf[channel] = lines.pop() ?? '';
    for (const line of lines) handleLine(line, channel);
    tracker.flush?.();
  };
  if (child.stdout) child.stdout.on('data', (b) => parseLines('stdout', b));
  if (child.stderr) child.stderr.on('data', (b) => parseLines('stderr', b));

  // 中止：杀进程树，然后把已完成的部分当成本轮结果落盘（与 g ai 的"已停止"口径一致）
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    killTree(child);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    child.on('close', finish);
    child.on('error', (err) => {
      logger.warn(`[agent] ${engine} 子进程出错: ${err?.message || err}`);
      finish();
    });
  });
  signal?.removeEventListener?.('abort', onAbort);

  // 进程退出时 stdout 里可能残留最后一段没换行的 NDJSON
  if (lineBuf.stdout.trim()) for (const l of lineBuf.stdout.split('\n')) handleLine(l, 'stdout');
  if (lineBuf.stderr.trim()) for (const l of lineBuf.stderr.split('\n')) handleLine(l, 'stderr');
  tracker.flush?.();

  // 落盘：assistant（带 tool_calls）+ 逐条 tool 结果，形状与 g ai 那条链路一致，
  // 前端 convertSessionToMessages 的合并逻辑不用改就能渲染历史。
  const calls = Array.isArray(job.toolCalls) ? job.toolCalls : [];
  const assistantMsg = { role: 'assistant', content: text };
  if (calls.length > 0) {
    assistantMsg.tool_calls = calls.map(c => ({
      id: c.id,
      type: 'function',
      function: { name: c.name || 'tool', arguments: c.arguments || '' },
    }));
  }
  session.messages.push(assistantMsg);
  for (const c of calls) {
    session.messages.push({
      role: 'tool',
      tool_call_id: c.id,
      name: c.name || 'tool',
      content: String(c.status === 'error' ? (c.error || c.result || '') : (c.result || '')),
    });
  }

  // 续聊标识：三家字段名不同（claude session_id / opencode sessionID / codex thread_id），
  // 但 taskRunner 的 handler 已经统一落到 job.claudeSessionId 上，这里只做搬运。
  if (job.claudeSessionId) session.engineSessionId = job.claudeSessionId;

  send({ type: 'done', content: aborted ? `${text}\n\n[已停止]` : text });
  return { aborted };
}

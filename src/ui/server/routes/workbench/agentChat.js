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
// Web 端智能体聊天引擎。
//
// 复用 CLI 侧 src/cli/ai/tools.js 的工具定义与执行器，
// 但 LLM 流式 + 工具调用循环通过 SSE 事件推给前端，而非终端打印。
//
// SSE 事件类型:
//   - { type: 'meta', sessionId, isNew, title }
//   - { type: 'thinking', delta }          — 推理过程增量
//   - { type: 'content', delta }           — 正文增量
//   - { type: 'tool_call_start', toolCallId, name, argsPreview, arguments }
//       arguments 只在计划类工具(update_plan 等)上出现:前端要拿原始 steps 渲染
//       计划清单,argsPreview 是截断过的摘要拆不出步骤。其他工具不带全文,免得
//       write_file 那种几十 KB 的 content 灌进 SSE。
//   - { type: 'tool_output', toolCallId, chunk }       — 命令执行中的增量输出(仅展示)
//   - { type: 'tool_result', toolCallId, name, result }
//   - { type: 'ask_user', interactionId, question, options, allowFreeText, multiple }
//   - { type: 'done', content }            — 本轮最终完成
//   - { type: 'error', error }

import path from 'path';
import os from 'os';
import { logger } from './shared.js';

// 从 CLI 侧导入工具定义、执行器与 LLM 传输层（同一 monorepo，路径可达）
import { TOOL_DEFINITIONS, executeTool, normalizePlanSteps, summarizePlan, isPlanToolName } from '../../../../cli/ai/tools.js';
import { prepareRequestMessages } from '../../../../cli/ai/context.js';
import { streamChatOnce } from '../../../../cli/ai/transport.js';
import { checkDangerousCommand } from '../../../../cli/ai/safety.js';
import { guardCommand } from '../../../../cli/ai/platformGuard.js';
import configManager from '../../../../config.js';

// 单轮工具调用循环数的兜底值(防失控);实际值取全局配置 aiMaxToolIterations,
// 与 CLI 侧 src/cli/ai/agent.js 共用同一个配置项。
const DEFAULT_MAX_TOOL_ITERATIONS = 200;

// 读取全局配置里的单轮工具调用上限。
// 读配置失败不该把整轮对话打挂 —— 退回默认值继续跑,比用户消息直接发不出去好。
async function resolveMaxToolIterations() {
  try {
    const cfg = await configManager.loadConfig();
    const n = Number(cfg?.aiMaxToolIterations);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  } catch (err) {
    logger.warn(`[agentChat] 读取 aiMaxToolIterations 失败,回退默认值: ${err?.message || err}`);
  }
  return DEFAULT_MAX_TOOL_ITERATIONS;
}

// ── 系统提示词构建 ──────────────────────────────────────────
// 与 CLI agent.js 的 buildSystemPrompt 保持一致，但标注来源为 Web 端
function buildWebSystemPrompt({ cwd, locale }) {
  const zh = !String(locale || '').startsWith('en');
  const now = new Date().toLocaleString();
  const isWin = process.platform === 'win32';
  const builtinToolCount = TOOL_DEFINITIONS.length;
  const shellDesc = isWin ? 'cmd.exe / PowerShell' : '/bin/sh';

  if (zh) {
    return `你是 "g ai" —— zen-gitsync 内置的编码智能体,通过工具在用户真实电脑上完成编码任务。当前用户通过 Web 界面与你对话。

# 运行环境
- 操作系统: ${process.platform}
- Shell: ${shellDesc}
- 当前工作目录: ${cwd}
- 当前时间: ${now}

# 平台兼容性(重要!)
- 必须使用与当前 Shell 兼容的命令,禁止盲套 Unix 写法
${isWin ? `- 当前是 Windows,以下 Unix 命令**不存在**,用了必定报"不是内部或外部命令":
  tail / head / cat / grep / ls / sed / awk / wc / cut / uniq / xargs / which / touch
  平台守卫会在执行前拦截这些命令,但请主动避免,不要浪费一轮调用
- 跨平台替代方案:
  · 列目录 → list_files 工具 或 cmd 的 dir
  · 搜内容 → search_text 工具 或 cmd 的 findstr
  · 看文件 → read_file 工具 或 cmd 的 type
  · 看输出末尾 → PowerShell "命令 | Select-Object -Last N"
  · 文本处理 → node -e "..." 或 PowerShell
  · 查命令路径 → cmd 的 where(不是 which)
- 必须跑 shell 时优先跨平台写法(如 node -e "..."),别用 Unix 专属命令` : `- 当前是 POSIX 环境,Unix 命令可用`}

# 远程仓库(GitHub / Gitee)
- 问"我有哪些项目""哪些项目需要 pull / 推送" → 用 list_projects 工具。它返回的就是 g ui
  「最近项目」面板那份清单(最近目录 + 建过任务的目录,带分支/领先/落后/未提交数与任务进度),
  口径与界面完全一致。**不要**用 list_files 自己扫盘数仓库 —— 那会把 node_modules 里的嵌套
  仓库也算进来,数出来的个数跟界面对不上。领先/落后是本地快照,要真实值就带 refresh=true
  先联网 fetch 一轮,再回答"要不要 pull"
- 问"这个项目关联哪个远端" → run_command 跑 \`git remote -v\`:本地信息,不联网、不依赖任何 CLI,任何环境都能答
- 问"我账号下有哪些仓库"或某仓库的 PR / Issue → 用官方 CLI。凭据由 CLI 自己保管:
  · GitHub → \`gh\`。列仓库 \`gh repo list --limit 50 --json name,visibility,updatedAt,primaryLanguage\`;
    看详情 \`gh repo view <owner/repo>\`;PR \`gh pr list\`;登录态 \`gh auth status\`
  · Gitee → \`gitee\`。列仓库 \`gitee repo list\`;登录态 \`gitee auth status\`
    (未登录时退出码**仍是 0**,必须看 \`--json\` 里的 status 字段,只看退出码会误判成已登录)
  · 两者默认只覆盖**当前登录账号**;组织仓库、私有仓库可能需要更大的 token scope,拉不到就如实说明,
    不要用其他途径绕过
  · 绝不向用户索要 token —— 也不要让用户把 token 粘进对话
- CLI 可能没装、或没在服务端进程的 PATH 里(装完没重启服务就是这个表现,Web 端尤其常见):
  报"不是内部或外部命令" / command not found 时,**不要换写法反复重试**,更不要凭印象编仓库名或目录名。
  直接告诉用户未检测到该 CLI,可在「远程仓库」页一键安装/登录,或需要时重启服务让新装的 CLI 生效;
  若只是想回答本项目的问题,退回 \`git remote -v\`
- 克隆仓库 / 添加远端时**优先用 SSH**(用户偏好,本机已配好密钥,实测走 https 会弹凭据窗口把任务打断):
  · GitHub 用 \`git@github.com:owner/repo.git\`,Gitee 用 \`git@gitee.com:owner/repo.git\`
  · 用户给的是 \`https://...\` 或 \`gh repo clone owner/repo\` 时,先换算成 SSH 地址再执行 ——
    走 https 会弹 Git Credential Manager 让用户输账号密码,任务就停在半路等输入
  · 已有仓库换协议:\`git remote set-url origin <ssh 地址>\`(先 \`git remote -v\` 看当前是什么)
  · 只有 SSH 真的不可用(报 \`Permission denied (publickey)\` / \`Host key verification failed\`)才退回 https,
    并用一句话说明这次走的是 https、配好密钥后可改回;两边都失败就停下来问用户,不要反复重试

# 权限(用户已明确授权,无需反复征求同意)
- 工作目录内:读写文件、执行命令等所有操作直接执行
- 其他目录:同样可以读取和修改
- 唯一红线:不得破坏系统(格式化磁盘、删除根目录/系统目录、关机重启、写块设备等)。
  安全守卫会拦截这类命令;被拦截时换安全方案,或告知用户需要他手动执行。

# 工作方式
- 先动手、后提问:能用工具查清的不要问用户(list_files / read_file / search_text / run_command)
- 修改代码后主动验证:跑测试、构建或至少语法检查(用 run_command)
- 编辑文件优先 edit_file 精确替换;先 read_file 看原文,old_string 必须与文件内容完全一致(含缩进换行)
- 大文件用 offset/limit 分段读取,不要一次读爆上下文
- git 操作用 run_command 执行
- run_command 默认就在工作目录执行,不要再加 cd 前缀;默认超时 120 秒,长任务加大 timeout_seconds(最大 600)
- 命令在 ${shellDesc} 下执行,注意语法兼容

# 任务计划(多步任务必用)
- 任务需要多步时(改代码、排查、调研、多文件改动),**动手之前**先调一次 update_plan,把要做的事
  拆成 3-8 个可核对的步骤,让用户在你改任何东西之前就知道范围和验收标准
- 单步小事(读个文件、答一个问题)不要列计划,那是噪音
- 每次都传**完整**的当前计划(不是增量),顺序即执行顺序;同一时刻最多一个 in_progress
- 完成一步就更新一次状态,别攒到最后一次性刷;计划与实际不符时直接改计划,不要硬着头皮往下走
- 全部做完后把 steps 传空表示收尾
- update_plan 只是给人看的进度板,不要为了"更新计划"去改文件或跑命令

# 与用户交互
- 需要向用户确认、提问或汇报重要决策时,直接用普通文本输出
- 需要暂停当前任务并等待用户决定或补充信息时,调用 ask_user,不要猜测或只在普通文本里提问
- 一次要让用户从多个选项里选好几项时(如"要我改哪几个文件"),传 multiple: true,用户会勾选后统一提交
- 不要调用不存在的工具,可用工具只有上面列出的 ${builtinToolCount} 个
- 用户可能随消息附带图片:图片以 image_url 部件出现在 user 消息里;如果当前模型不支持视觉(带图请求报错),提醒用户换用支持视觉的模型
- 发现高风险或状态不一致的情况时:先用文本说明发现和影响,停下来等用户指示,不要擅自继续破坏性操作

# 输出
- 你的文本输出直接显示在用户 Web 界面,用简体中文交流
- 完成任务后用一两句话汇报结果,不要复述过程细节`;
  }

  return `You are "g ai" — the coding agent built into zen-gitsync. You use tools to perform coding tasks on the user's real machine. The user is interacting with you via a Web interface.

# Environment
- OS: ${process.platform}
- Shell: ${shellDesc}
- Working directory: ${cwd}
- Current time: ${now}

# Platform compatibility (important!)
- You MUST use commands compatible with the current shell.
${isWin ? `- This is Windows. The following Unix commands do NOT exist here:
  tail / head / cat / grep / ls / sed / awk / wc / cut / uniq / xargs / which / touch
  A platform guard will block these before execution, but avoid them proactively.
- Cross-platform alternatives:
  · List dirs → list_files tool, or cmd's dir
  · Search content → search_text tool, or cmd's findstr
  · Read files → read_file tool, or cmd's type
  · Tail output → PowerShell "command | Select-Object -Last N"
  · Text processing → node -e "..." or PowerShell
  · Find executable → cmd's where (not which)` : `- POSIX environment: Unix commands are available`}

# Remote repositories (GitHub / Gitee)
- "Which projects do I have?" / "Which ones need a pull or push?" → use the list_projects tool.
  It returns exactly the list behind the GUI's "Recent projects" panel (recent directories plus any
  directory a task was created in, with branch / ahead / behind / uncommitted counts and task
  progress) — the same numbers the UI shows. Do NOT scan the disk with list_files to count repos:
  that also picks up nested repos inside node_modules and the totals will not match the UI.
  Ahead/behind comes from local refs, so pass refresh=true for a real answer about pulling
- "Which remote does this project point at?" → run_command \`git remote -v\`: local info, no network, no CLI needed
- "Which repos do I have?" or a repo's PRs / issues → use the official CLI. The CLI owns the credentials:
  · GitHub → \`gh\`. List repos \`gh repo list --limit 50 --json name,visibility,updatedAt,primaryLanguage\`;
    details \`gh repo view <owner/repo>\`; PRs \`gh pr list\`; auth state \`gh auth status\`
  · Gitee → \`gitee\`. List repos \`gitee repo list\`; auth state \`gitee auth status\`
    (the exit code is still 0 when logged out — read the status field from \`--json\`, or you will
    wrongly report "logged in")
  · Both default to the **currently authenticated account only**; org and private repos may need
    broader token scopes. If you cannot see them, say so plainly — do not route around it
  · Never ask the user for a token, and never have them paste one into the conversation
- The CLI may not be installed, or missing from the server process's PATH (that is what "installed but
  the server cannot find it" looks like — common on the Web side):
  on "not recognized" / command not found, do NOT retry with a different spelling and do NOT invent
  repo or directory names. Tell the user the CLI was not found and point them to the "Remote
  repositories" page (one-click install / login), or restart the server so a freshly installed CLI
  becomes visible; if you only need to answer for this project, fall back to \`git remote -v\`
- Cloning a repo or adding a remote: **prefer SSH** (the user's preference — keys are already set up,
  and https has been observed to pop a credential window that stalls the task):
  · GitHub → \`git@github.com:owner/repo.git\`; Gitee → \`git@gitee.com:owner/repo.git\`
  · If the user hands you an \`https://...\` URL (or \`gh repo clone owner/repo\`), convert it to the SSH
    form first — https pops up Git Credential Manager asking for a username/password and blocks the task
  · Switching an existing repo: \`git remote set-url origin <ssh url>\` (check \`git remote -v\` first)
  · Fall back to https only when SSH genuinely fails (\`Permission denied (publickey)\` /
    \`Host key verification failed\`), and say in one line that this one used https and can go back to SSH
    once the key is set up; if both fail, stop and ask the user — do not keep retrying

# Permissions (explicitly granted by the user)
- Inside the working directory: read/write files and run commands directly
- Other directories: may also be read and modified
- Single red line: never destroy the system. A safety guard blocks such commands.

# How you work
- Act first, ask later: use tools to investigate before asking the user
- When a decision or missing detail must come from the user, call ask_user. Do not guess or merely describe a question in plain text. Pass multiple: true when the user should pick several options at once.
- After modifying code, verify: run tests, build, or at least syntax check
- Prefer edit_file for precise replacements; read_file first to confirm original text
- Use offset/limit for large files
- git operations via run_command
- run_command defaults to the working directory; default timeout 120s, max 600s
- When the task must pause for a decision or missing detail, call ask_user and wait for the user's answer. The user may attach images to a message; they arrive as image_url parts in the user message. If the current model rejects images (no vision support), tell the user to switch to a vision-capable model

# Task plan (required for multi-step work)
- When a task takes several steps (code changes, debugging, research, multi-file edits), call update_plan
  **before touching anything**: break it into 3-8 verifiable steps so the user knows the scope and the
  acceptance criteria before you modify a single file
- Do not plan single trivial actions (read one file, answer one question) — that is noise
- Always send the **complete** current plan (not a delta), in execution order; at most one in_progress
- Update the status right after finishing a step instead of batching everything at the end; when the
  plan no longer matches reality, rewrite the plan instead of pushing ahead
- Send an empty steps list once everything is done
- update_plan is a progress board for humans: never edit files or run commands just to "update the plan"

# Output
- Your text output is displayed in the user's Web UI
- After completing a task, briefly summarize the result`;
}

// ── LLM 流式调用 ─────────────────────────────────────────
// 统一实现在 src/cli/ai/transport.js 的 streamChatOnce —— CLI 的 `g ai` 与这条
// Web 链路共用同一份。比这里原先那份多出来的能力:请求 usage(带 stream_options
// 降级重试)、校验 tool call index 边界、吃 evt.error,以及最要紧的一条 ——
// 流被截断但 tool_calls 已经部分到达时抛"中断"、拒绝执行半截的工具调用。
// 这里曾经是第二份实现,弱就弱在最后那条:半截参数有可能被拿去执行。

// ── 消息准备(消毒 / 历史有界化 / 旧图片降级) ──────────────────
// 统一实现在 src/cli/ai/context.js 的 prepareRequestMessages —— CLI 的 `g ai`
// 与这条 Web 链路共用同一份,两侧不再各写一遍。
//
// 这里曾经是第二份实现:历史只按条数硬切(MAX_HISTORY_MESSAGES=40)+ 纯 splice 丢弃,
// 而 CLI 侧早已改成「条数/字符双预算 + 丢弃项摘录成一条梗概」,两侧行为因此分叉 ——
// Web 面板聊久了模型会直接失忆,CLI 还记得要点。现在收敛到一处,口径见 context.js。

// ── 核心入口：运行一轮 agent 对话 ────────────────────────
//
// 参数:
//   { session, model, userMessage, cwd, locale, signal, send, onChild, askUser, listProjects }
//   - session: 从 agentSessionStore 读取的会话对象
//   - model: { baseURL, model, apiKey }
//   - userMessage: 用户输入文本
//   - images: base64 dataURL 数组(可选,多模态图片,随最新一条 user 消息发给模型)
//   - openFilePath: 文件空间里当前打开的文档(可选,注入请求副本,不落库)
//   - dirStatusBlock: 「切换工作目录」弹窗里那批目录的 Git 状态(可选,由 agentRoutes
//     读配置 + 白名单过滤后用 buildDirStatusBlock 拼好传进来,同样只进请求副本)
//   - attachments: 非图片附件(可选) = [{ name, path }],path 是**服务端落盘后的绝对路径**,
//     只把路径写进请求副本的 system 提示,内容由模型自己用工具读(见 utils/agentAttachments.js)
//   - cwd: 工作目录
//   - locale: 'zh' | 'en'
//   - signal: AbortSignal (客户端断开时触发)
//   - send: (obj) => void  SSE 发送函数
//   - onChild: (child) => void  子进程回调(用于取消)
//   - askUser: (args, meta) => Promise<string>  等待用户回答
//   - listProjects: (args) => Promise<string>  list_projects 工具的数据源
//     (由 agentRoutes 注入:最近目录/tasks.json/看板统计只有 GUI 侧拿得到)
//   - dispatchTask: (payload) => Promise<string>  dispatch_task 工具的实现 —— 派发一条
//     工作台任务。同样由 agentRoutes 注入，但**只在主 Agent 控制台发起的对话里**注入
//     （别的入口不注入 = 那个入口没有派发能力，工具会回一句可照做的 unavailable）
//   - getContextBlock: ({locale}) => Promise<string>  工作区状态快照的摘要块
//     (由 agentRoutes 注入,实现在 routes/aiContext/:七个板块的摘要 + 落盘文件路径)
//
// 返回: { aborted: boolean }
export async function runAgentTurn({ session, model, userMessage, images = [], cwd, locale, openFilePath, attachments = [], dirStatusBlock = '', signal, send, onChild, askUser, listProjects, dispatchTask, getContextBlock }) {
  const ctx = { cwd, locale, onChild, askUser, listProjects, dispatchTask };

  // 确保 session.messages 存在
  if (!Array.isArray(session.messages)) session.messages = [];

  // 首轮：注入 system prompt
  if (session.messages.length === 0) {
    session.messages.push({
      role: 'system',
      content: buildWebSystemPrompt({ cwd, locale })
    });
  }

  // 追加 user 消息：有图片时组装 OpenAI 多模态 content 数组（与 CLI agent.js 一致），否则保持纯字符串
  const imageParts = (Array.isArray(images) ? images : [])
    .filter(u => typeof u === 'string' && u.startsWith('data:image/'))
    .map(u => ({ type: 'image_url', image_url: { url: u } }));
  session.messages.push({
    role: 'user',
    content: imageParts.length > 0
      ? [{ type: 'text', text: userMessage || ' ' }, ...imageParts]
      : userMessage
  });

  // 工作区状态快照:整轮只取一次(TTL 在生成器内部,见 aiContext/index.js),
  // 不放进循环 —— 否则每执行一次工具调用都要重拼一遍,而这轮对话里它不会变。
  // 取不到就空着跳过:快照是**锦上添花**,不能因为它挂了就让用户这条消息发不出去。
  let workspaceBlock = '';
  if (typeof getContextBlock === 'function') {
    try {
      workspaceBlock = (await getContextBlock({ locale })) || '';
    } catch (err) {
      logger.warn(`[agentChat] 取工作区状态快照失败,本轮跳过注入: ${err?.message || err}`);
      workspaceBlock = '';
    }
  }

  const maxIterations = await resolveMaxToolIterations();

  for (let iter = 0; iter < maxIterations; iter++) {
    // 每轮都从完整会话记录重新构建一次请求副本:条数/字符双预算 → 被丢掉的旧消息
    // 摘录成一条梗概 → 旧图片降级 → provider 兼容消毒。
    // 只作用于副本,session.messages 保持完整(与 CLI 的磁盘口径一致)。
    const messages = prepareRequestMessages(session.messages, { locale });
    // 请求级上下文：工作区状态快照 + 常用目录状态 + 当前打开的文档 + 本轮附件路径
    // （只改副本，不落 session.messages，下一轮不重复累积）
    injectRequestContext(messages, { cwd, openFilePath, attachments, locale, workspaceBlock, dirStatusBlock });

    let result;
    try {
      result = await streamChatOnce({
        model,
        messages,
        signal,
        // 整轮对话（含后续工具调用产生的每一轮请求）复用同一个会话 ID
        sessionId: session.sessionId,
        onToken: ({ thinking, content }) => {
          if (thinking) send({ type: 'thinking', delta: thinking });
          if (content) send({ type: 'content', delta: content });
        },
      });
    } catch (err) {
      // 请求失败时撤掉本轮塞入的 user 消息(如果末尾仍是 user)
      const last = session.messages[session.messages.length - 1];
      if (last?.role === 'user') session.messages.pop();
      send({ type: 'error', error: `LLM 请求失败: ${err.message}` });
      return { aborted: false };
    }

    const { content, toolCalls } = result;

    // 推理内容必须原样带回历史。DeepSeek 系 thinking 模式下带 tool_calls 的 assistant
    // 消息一旦缺 reasoning_content，下一轮回传就被上游 400 拒掉:
    // "The `reasoning_content` in the thinking mode must be passed back to the API"。
    // 口径与 CLI 侧 src/cli/ai/turn.js 的 assistant.reasoning_content 保持一致。
    const withReasoning = msg => (result.reasoning ? { ...msg, reasoning_content: result.reasoning } : msg);

    if (result.aborted) {
      // 用户点了"停止"：把已经流出来的部分正文补进历史，否则磁盘上这一轮只剩一条
      // user 消息，重新打开会话时刚才生成的内容会整段丢失。
      // 半截的 tool_calls 已被 transport 在中止时丢弃，这里只补正文，不会有悬空引用。
      // 落盘由路由层统一负责（中止的轮次同样要写，见 agentRoutes.js）。
      if (content) {
        session.messages.push(withReasoning({ role: 'assistant', content }));
      }
      send({ type: 'error', error: '已取消' });
      return { aborted: true };
    }

    // 无工具调用：本轮结束
    if (toolCalls.length === 0) {
      session.messages.push(withReasoning({ role: 'assistant', content: content || null }));
      send({ type: 'done', content: content || '' });
      return { aborted: false };
    }

    // 有工具调用：assistant(带 tool_calls)入历史
    session.messages.push(withReasoning({
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls
    }));

    // 逐个执行工具
    for (const tc of toolCalls) {
      const name = tc.function?.name || '';
      const rawArgs = tc.function?.arguments || '';
      const toolCallId = tc.id || name;

      let args;
      try {
        args = rawArgs ? JSON.parse(rawArgs) : {};
      } catch {
        const errResult = `错误: 工具参数不是合法 JSON: ${rawArgs.slice(0, 200)}`;
        send({ type: 'tool_call_start', toolCallId, name, argsPreview: rawArgs.slice(0, 200) });
        send({ type: 'tool_result', toolCallId, name, result: errResult });
        session.messages.push({ role: 'tool', tool_call_id: toolCallId, name, content: errResult });
        continue;
      }

      // 工具参数预览(给前端展示)
      const argsPreview = summarizeArgs(name, args);
      // 计划类工具额外发**完整参数**:前端要拿原始 steps 渲染清单,而 argsPreview
      // 是截断过的摘要,拆不出步骤。只给计划类工具发完整参数 ——
      // write_file 的 content 可能几十 KB,为它开一路全文等于给 SSE 带宽找麻烦。
      const rawArgsForClient = isPlanToolName(name) ? rawArgs : undefined;
      send({ type: 'tool_call_start', toolCallId, name, argsPreview, arguments: rawArgsForClient });

      const toolCtx = {
        ...ctx,
        signal,
        // run_command 执行期间的增量输出 → 前端实时显示。
        // 只用于展示,不进会话历史 —— 历史里存的仍是带 exit code 的最终结果。
        onOutput: (chunk) => {
          const text = String(chunk || '');
          if (text) send({ type: 'tool_output', toolCallId, name, chunk: text });
        },
      };
      if (name === 'ask_user' && typeof ctx.askUser === 'function') {
        toolCtx.askUser = askArgs => ctx.askUser(askArgs, {
          sessionId: session.sessionId,
          interactionId: toolCallId,
          send,
          signal,
        });
      }
      const output = await executeTool(name, args, toolCtx);
      send({ type: 'tool_result', toolCallId, name, result: output });
      session.messages.push({ role: 'tool', tool_call_id: toolCallId, name, content: output });
    }
    // 工具结果全部入历史后继续循环，让模型基于结果决定下一步
  }

  // 达到最大迭代次数
  send({ type: 'done', content: `已达单轮最大工具调用次数(${maxIterations})，本轮结束。如需继续请再发一条消息。` });
  return { aborted: false };
}

// 工具参数简短摘要(给前端展示)
function summarizeArgs(name, args) {
  try {
    switch (name) {
      case 'run_command':
        return String(args.command || '').slice(0, 200);
      case 'read_file':
      case 'write_file':
      case 'edit_file':
        return String(args.path || '');
      case 'list_files':
        return String(args.path || '.');
      case 'search_text':
        return String(args.pattern || '');
      case 'update_plan': {
        const steps = normalizePlanSteps(args.steps ?? args.todos ?? args.plan);
        const why = String(args.explanation || '').replace(/\s+/g, ' ').trim();
        return [summarizePlan(steps), why].filter(Boolean).join(' — ').slice(0, 200);
      }
      default:
        return JSON.stringify(args).slice(0, 200);
    }
  } catch {
    return '';
  }
}

// ── 请求级上下文注入（工作区状态 / 常用目录状态 / 文件空间对话 / 本轮附件） ──
// 把"工作区各板块的状态摘要""常用目录那批目录的 Git 状态""用户当前打开的文件"与
// "本轮附件的落盘路径"追加到**请求副本**的 system 消息末尾：只影响这一次请求，
// session.messages 与磁盘历史保持原样，下一轮也不会重复累积。
//
// ⚠️ 工作区快照**必须走这条副本路径，不能塞进 session.messages 里那条 system 消息**。
// 那条只在首轮 push 一次（见上面 `session.messages.length === 0` 的判断）并会落盘，
// 快照进去就等于永久停在"会话创建那天"——git 分支、任务进度全会是过期的，
// 而且这种错不会报错、只会让模型理直气壮地给出错答案。有单测钉住这一点。
// 常用目录状态同理，而且更严重：它说的是"这一刻"的领先/落后，几小时后必然不同。
//
// 附件为什么只给路径、不给内容：见 utils/agentAttachments.js 的头注释 —— 非图片附件
// 由服务端落盘，模型自己用 read / grep 按需取，比把几百 KB 文本内联进消息省得多。
// 快照块同理,只给摘要与目录路径,板块正文由模型按需读。
export function injectRequestContext(messages, { cwd, openFilePath, attachments = [], locale, workspaceBlock = '', dirStatusBlock = '' }) {
  if (!Array.isArray(messages)) return;
  const en = String(locale || '').startsWith('en');

  const parts = [];

  // ⓪ 工作区状态快照（七个板块的摘要 + 落盘目录）。由 aiContext 生成，只在这个副本里。
  if (typeof workspaceBlock === 'string' && workspaceBlock.trim()) {
    parts.push(workspaceBlock.trim());
  }

  // ① 常用目录那批目录的 Git 状态（切换工作目录弹窗里的追问才有）。
  //    整块（含"屏幕上那段自动解读"）由 agentRoutes 调 buildDirStatusBlock 拼好传进来 ——
  //    两条链路（内置引擎的副本 / 外部引擎的前缀）用的是同一个字符串，不在两处各拼一遍。
  if (typeof dirStatusBlock === 'string' && dirStatusBlock.trim()) {
    parts.push(dirStatusBlock.trim());
  }

  // ② 当前打开的文档（文件空间对话才有；项目外或等于根目录直接忽略）
  if (openFilePath) {
    const root = cwd || process.cwd();
    let rel = '';
    try {
      rel = path.relative(root, path.resolve(root, openFilePath));
    } catch {
      rel = '';
    }
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      const file = rel.split(path.sep).join('/');
      parts.push(en
        ? `The file the user currently has open in the editor is \`${file}\` (relative to the project root). When the user says "this file" / "the current file" / "here", that is what they mean; read it with your tools before assuming its content.`
        : `用户此刻在文件空间打开的文件是 \`${file}\`（相对项目根目录）。用户说"这个文件/当前文件"时默认指它；请先用工具读取内容，不要臆测。`);
    }
  }

  // ③ 本轮附件：只给绝对路径，内容让模型自己去读
  const files = (Array.isArray(attachments) ? attachments : [])
    .filter(a => a && typeof a.path === 'string' && a.path)
    .slice(0, 20);
  if (files.length > 0) {
    const lines = files.map(a => `- \`${a.path}\`${a.name && a.name !== path.basename(a.path) ? ` (${a.name})` : ''}`);
    parts.push(en
      ? `The user attached ${files.length} file(s) this turn; they were saved to these absolute paths:\n${lines.join('\n')}\nRead them with your tools when relevant (they are NOT inlined here). Do not guess their contents.`
      : `用户本轮附带了 ${files.length} 个文件，已保存到以下绝对路径：\n${lines.join('\n')}\n需要时用工具读取（内容没有内联在这里），不要臆测。`);
  }

  if (parts.length === 0) return;

  const note = `\n\n# ${en ? 'Current context' : '当前上下文'}\n${parts.join('\n\n')}`;
  const sys = messages.find(m => m && m.role === 'system' && typeof m.content === 'string');
  if (sys) sys.content += note;
  else messages.unshift({ role: 'system', content: note.trim() });
}

export { buildWebSystemPrompt };

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
// g ai — 终端交互式 AI 编码智能体。
//
// 入口: runAiAgent(argv)(由 gitCommit.js 在 argv[2]==='ai' 时动态 import)。
//
// 能力:
//   - 默认使用 g ui 里配置的模型(~/.zen-gitsync/config.json 顶层 models,
//     isDefault 优先,否则取第一个);--model=<序号|名称> 或会话内 /model 切换
//   - OpenAI 兼容流式 function calling:模型可以调用 run_command /
//     read_file / write_file / edit_file / list_files / search_text / ask_user
//   - 图片:Alt+V 粘贴剪贴板图片、/image <路径> 附加本地图片,
//     以多模态(image_url)消息发给模型(需模型支持视觉)
//   - 权限:启动目录内全开放,其他目录可读写;唯一红线由 safety.js 拦截
//     (格式化磁盘、删根目录、关机等系统级破坏操作)
//
// 视觉风格(termui.js):对标 Codex CLI / Claude Code / OpenCode —
//   盒式输入框、ora 等待 spinner、✻ 思考(橙黄斜体)、⚙ 工具头(青) + │ 结果槽、
//   正文 ➤ 子弹头(绿)+ 逐行轻量 markdown(**bold** / `code` / # 标题 / ``` 围栏 / - 列表)
//
// 使用方式:
//   g ai                  交互模式(REPL)
//   g ai "帮我修个 bug"    单发模式:执行一轮后退出
//   g ai --model=2        指定配置里的第 2 个模型
//
// 实现注意:
//   - 本模块属于 CLI 侧,不依赖 GUI 服务器代码(src/ui/server/**)
//   - Ctrl+C 执行中只取消当前任务；空闲时交给主 CLI 清理并退出

import readline from 'node:readline'
import chalk from 'chalk'
import config from '../../config.js'
import { getCwd } from '../../utils/index.js'
import { registerCleanup } from '../cleanup.js'
import { terminateCommand, TOOL_DEFINITIONS } from './tools.js'
import { runAgentTurn } from './turn.js'
import { AgentExtensions } from './extensions.js'
import { repairToolHistory, loadProjectInstructions } from './context.js'
import {
  printBanner, printHelpPanel,
  filterSlashCommands, renderSlashHintBody, parseKeyForSlashHint,
  printTurnSummary,
  printOk, printWarn, printError, printDim,
} from './termui.js'
import { readClipboardImage, checkImageFile, formatBytes } from './images.js'
import { runModelSetup, collectModelInput, buildModelConfig, selectFromList } from './modelSetup.js'
import { genSessionId, autoTitle, writeSession, enforceRetention, listSessions } from './sessionStore.js'

// truncateDisplay 已迁移到 termui.js;这里 re-export 保持既有测试/外部引用不断
export { truncateDisplay } from './termui.js'

// ──────────────────────────────────────────────
// i18n 字符串表(CLI 其他部分以中文为主,这里按 locale 给双语)
// ──────────────────────────────────────────────
const STRINGS = {
  zh: {
    noModel: '未配置 AI 模型,请先在 GUI 通用设置中添加模型(运行 g ui 打开设置)',
    unknownModel: (q) => `未找到匹配的模型: ${q},使用默认模型`,
    waiting: '思考中…',
    llmError: (msg) => `LLM 请求失败: ${msg}`,
    toolIterLimit: (n) => `已达单轮最大工具调用次数(${n}),本轮结束。如需继续请再发一条消息。`,
    toolRunning: (name) => `执行 ${name}…`,
    busy: '任务执行中，请稍候，或按 Ctrl+C 停止当前任务。',
    bye: '已退出 g ai',
    cleared: '对话历史已清空',
    newConversation: '已开启新对话',
    operationCancelled: '已取消当前操作',
    thinkOn: '思考过程显示: 开',
    thinkOff: '思考过程显示: 关(模型仍会思考,只是不回显)',
    modelSwitched: (label) => `已切换模型: ${label}`,
    invalidModelIndex: '无效的模型序号',
    cdOk: (p) => `工作目录已切换: ${p}`,
    cdFail: (p) => `目录不存在: ${p}`,
    currentModel: '当前模型',
    availableModels: '可用模型',
    oneShotNoModel: '未配置模型,无法启动',
    oneShotDone: '单发模式完成 · 需要多轮连续对话请直接运行 g ai(不带参数)',
    helpTitle: 'g ai 命令',
    bannerTip: 'Alt+V 贴图 · /help 帮助 · Ctrl+C 停止当前任务 · /exit 退出',
    prompt: '❯ ',
    bannerModel: '模型',
    bannerCwd: '目录',
    thinkingLabel: '思考',
    answerLabel: '回答',
    thinkingHint: '… 已显示前 12 行；输入 /think full 开启后续完整思考',
    emptyResponse: '模型没有返回回答，请重试或切换模型。',
    chars: '字符',
    extLoadingMcp: (n) => `正在连接 ${n} 个 MCP 服务…`,
    extLoaded: (skills, tools) => `扩展已就绪: ${skills} 个 Skill · ${tools} 个 MCP 工具(/skills 查看)`,
    extNone: '',
    extSkillTitle: '已安装的 Skill',
    extSkillEmpty: '没有装 Skill。可以在 g ui → 智能体 → Skill 广场 里挑一个装到当前项目或 g ai。',
    extMcpTitle: '已接入的 MCP 服务',
    extMcpEmpty: '没有接入 MCP 服务。可以在 g ui → 智能体 → MCP 广场 里挑一个装到当前项目或 g ai。',
    extMcpFailed: '连接失败',
    imagePasting: '正在读取剪贴板图片…',
    imageAttached: (n, size) => `📎 图片 #${n} 已附加(${size}),将随下一条消息发送`,
    imageEmpty: '剪贴板中没有图片;可先截图再按 Alt+V,或用 /image <路径> 附加本地图片',
    imageBadPath: (p) => `图片不存在或格式不支持: ${p}(支持 png/jpg/jpeg/gif/webp/bmp)`,
    imageListTitle: '待发送图片',
    imageListEmpty: '当前没有待发送的图片(Alt+V 粘贴或 /image <路径> 附加)',
    imageCleared: '已清除待发送的图片',
    imageSending: (n) => `📎 附带 ${n} 张图片`,
    addModelTitle: '添加模型配置',
    addModelSaved: (name) => `✓ 模型 "${name}" 已添加并切换为当前模型`,
    addModelCancelled: '已取消添加模型',
    addModelSaveError: (msg) => `保存配置失败: ${msg}`,
    resumeTitle: '选择要恢复的对话',
    resumeEmpty: '没有可恢复的历史对话',
    resumeCancelled: '已取消恢复对话',
    resumeDone: (title, count) => `已恢复对话: ${title} (${count} 条消息)`,
  },
  en: {
    noModel: 'No AI model configured. Add one in GUI settings first (run `g ui`).',
    unknownModel: (q) => `No model matching "${q}", falling back to default`,
    waiting: 'Thinking…',
    llmError: (msg) => `LLM request failed: ${msg}`,
    toolIterLimit: (n) => `Hit max tool iterations (${n}) for this turn. Send another message to continue.`,
    toolRunning: (name) => `Running ${name}…`,
    busy: 'Agent is working. Wait or press Ctrl+C to stop the task.',
    bye: 'Bye',
    cleared: 'Conversation cleared',
    newConversation: 'Started a new conversation',
    operationCancelled: 'Current operation cancelled',
    thinkOn: 'Thinking display: on',
    thinkOff: 'Thinking display: off (model still thinks, just hidden)',
    modelSwitched: (label) => `Switched model: ${label}`,
    invalidModelIndex: 'Invalid model index',
    cdOk: (p) => `Working directory changed: ${p}`,
    cdFail: (p) => `Directory not found: ${p}`,
    currentModel: 'Current model',
    availableModels: 'Available models',
    oneShotNoModel: 'No model configured, aborting',
    oneShotDone: 'One-shot done · for multi-turn chat run `g ai` with no arguments',
    helpTitle: 'g ai commands',
    bannerTip: 'Alt+V image · /help commands · Ctrl+C stop task · /exit quit',
    prompt: '❯ ',
    bannerModel: 'Model',
    bannerCwd: 'CWD',
    thinkingLabel: 'Thinking',
    answerLabel: 'Answer',
    thinkingHint: '… first 12 lines shown; enter /think full for future reasoning',
    emptyResponse: 'The model returned no answer. Retry or switch models.',
    chars: 'chars',
    extLoadingMcp: (n) => `Connecting to ${n} MCP server(s)…`,
    extLoaded: (skills, tools) => `Extensions ready: ${skills} skill(s) · ${tools} MCP tool(s) (/skills for details)`,
    extNone: '',
    extSkillTitle: 'Installed skills',
    extSkillEmpty: 'No skills installed. Browse g ui → Agent → Skill marketplace to install one into this project or g ai.',
    extMcpTitle: 'Connected MCP servers',
    extMcpEmpty: 'No MCP servers connected. Browse g ui → Agent → MCP marketplace to install one.',
    extMcpFailed: 'failed',
    imagePasting: 'Reading clipboard image…',
    imageAttached: (n, size) => `📎 Image #${n} attached (${size}); sent with your next message`,
    imageEmpty: 'No image in clipboard; take a screenshot first, or use /image <path>',
    imageBadPath: (p) => `Not a supported image: ${p} (png/jpg/jpeg/gif/webp/bmp)`,
    imageListTitle: 'Pending images',
    imageListEmpty: 'No pending images (Alt+V to paste, or /image <path>)',
    imageCleared: 'Pending images cleared',
    imageSending: (n) => `📎 ${n} image(s) attached`,
    addModelTitle: 'Add Model Configuration',
    addModelSaved: (name) => `✓ Model "${name}" added and switched to`,
    addModelCancelled: 'Add model cancelled',
    addModelSaveError: (msg) => `Failed to save: ${msg}`,
    resumeTitle: 'Choose a conversation to resume',
    resumeEmpty: 'No previous conversations to resume',
    resumeCancelled: 'Resume cancelled',
    resumeDone: (title, count) => `Resumed: ${title} (${count} messages)`,
  },
}

function makeStrings(locale) {
  return String(locale || '').startsWith('en') ? STRINGS.en : STRINGS.zh
}

// 模型的展示名:优先 model 字段,其次 name,最后 baseURL
function modelLabel(m) {
  return m?.model || m?.name || m?.baseURL || '(unknown)'
}

// ──────────────────────────────────────────────
// 系统 prompt — 明确告知环境、权限边界与工作方式
// ──────────────────────────────────────────────
// 顺序固定:基础人设 → 项目说明(AGENTS.md/CLAUDE.md)→ 扩展能力(skill 清单 + MCP 工具)。
// 把扩展放最后,是因为它是"增量能力",不该插在权限与环境说明中间打断阅读。
// state 里存着已加载的 AgentExtensions;没加载(如单测直接调)时 extra 为空,行为与改动前一致。
function extensionSuffix(state) {
  try {
    return state?.extensions?.promptSuffix?.(state.locale) || ''
  } catch {
    return ''
  }
}

async function buildProjectPrompt(options) {
  return buildSystemPrompt(options) + await loadProjectInstructions(options.cwd) + (options.extra || '')
}

function buildSystemPrompt({ cwd, locale, shellDesc }) {
  const zh = !String(locale || '').startsWith('en')
  const now = new Date().toLocaleString()
  const isWin = process.platform === 'win32'
  // 工具数量动态取自 tools.js —— 之前这里写死过"6 个",加 ask_user 时没人想起来改,
  // 就变成了对模型撒谎。数字跟着定义走,以后再加工具不会漏。
  const builtinToolCount = TOOL_DEFINITIONS.length
  if (zh) {
    return `你是 "g ai" —— zen-gitsync CLI 内置的终端编码智能体,通过工具在用户真实电脑上完成编码任务。

# 运行环境
- 操作系统: ${process.platform}
- Shell: ${shellDesc}
- 当前工作目录: ${cwd}(用户在此启动 g ai,也是所有相对路径的基准)
- 当前时间: ${now}

# 平台兼容性(重要!)
- 必须使用与当前 Shell 兼容的命令,禁止盲套 Unix 写法
${isWin ? `- 当前是 Windows cmd.exe,以下 Unix 命令**不存在**,用了必定报"不是内部或外部命令":
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

# 权限(用户已明确授权,无需反复征求同意)
- 工作目录内:读写文件、执行命令等所有操作直接执行
- 其他目录:同样可以读取和修改
- 唯一红线:不得破坏系统(格式化磁盘、删除根目录/系统目录、关机重启、写块设备等)。
  命令守卫只能识别部分危险写法，不是沙箱；不得通过脚本或嵌套 shell 绕过限制。

# 工作方式
- 先动手、后提问:能用工具查清的不要问用户(list_files / read_file / search_text / run_command)
- 修改代码后主动验证:跑测试、构建或至少语法检查(用 run_command)
- 编辑文件优先 edit_file 精确替换;先 read_file 看原文,old_string 必须与文件内容完全一致(含缩进换行)
- 大文件用 offset/limit 分段读取,不要一次读爆上下文
- git 操作用 run_command 执行;提交代码可以用 git 命令,也可以用本 CLI 的 g -y(默认信息提交并推送)或 g --ai(AI 生成提交信息)
- run_command 默认就在工作目录执行,不要再加 cd / cd /d 前缀;默认超时 120 秒,长任务加大 timeout_seconds(最大 600)
- 命令在 ${shellDesc} 下执行,注意语法兼容
- 先读取当前项目的规范、依赖与测试配置，再选择对应的验证命令，不要假定所有项目都使用 npm
- 用户要求概述或简短回答时，只读取必要的结构与入口文件，控制探索范围

# 与用户交互
- 需要向用户确认、提问或汇报重要决策时,直接用普通文本输出 —— 用户能实时看到你的文本;
  需要暂停当前任务并等待用户决定或补充信息时,调用 ask_user,不要猜测或只在普通文本里提问
  不要调用不存在的工具,内置工具就是上面列出的 ${builtinToolCount} 个(若用户装了 MCP,你的工具表里还会多出 mcp__ 开头的工具)
- 用户可能通过 Alt+V 或 /image 附加图片:图片以 image_url 部件出现在 user 消息里;
  如果当前模型不支持视觉(带图请求报错),提醒用户换用支持视觉的模型
- 发现高风险或状态不一致的情况(例如版本号 / git tag / CHANGELOG 对不上、发布前环境异常、
  仓库状态与预期不符)时:先用文本说明发现和影响,停下来等用户指示,不要擅自继续破坏性操作

# 输出
- 你的文本输出直接显示在用户终端,用简体中文交流
- 完成任务后用一两句话汇报结果,不要复述过程细节`
  }
  return `You are "g ai" — the terminal coding agent built into the zen-gitsync CLI. You use tools to perform coding tasks on the user's real machine.

# Environment
- OS: ${process.platform}
- Shell: ${shellDesc}
- Working directory: ${cwd} (where the user launched g ai; base for all relative paths)
- Current time: ${now}

# Platform compatibility (important!)
- You MUST use commands compatible with the current shell. Do NOT blindly copy Unix patterns.
${isWin ? `- This is Windows cmd.exe. The following Unix commands do NOT exist here and will fail with "not recognized":
  tail / head / cat / grep / ls / sed / awk / wc / cut / uniq / xargs / which / touch
  A platform guard will block these before execution, but avoid them proactively — don't waste a turn.
- Cross-platform alternatives:
  · List dirs → list_files tool, or cmd's dir
  · Search content → search_text tool, or cmd's findstr
  · Read files → read_file tool, or cmd's type
  · Tail output → PowerShell "command | Select-Object -Last N"
  · Text processing → node -e "..." or PowerShell
  · Find executable → cmd's where (not which)
- For shell one-offs, prefer cross-platform forms like node -e "..."` : `- POSIX environment: Unix commands are available`}

# Permissions (explicitly granted by the user — do not keep asking)
- Inside the working directory: read/write files and run commands directly
- Other directories: may also be read and modified
- Never destroy the system (format disks, delete root/system dirs, shutdown/reboot, write block devices). The command guard is not a sandbox; never bypass it with scripts or nested shells.

# How to work
- Act first, ask later: use tools (list_files / read_file / search_text / run_command) instead of asking the user
- When a decision or missing detail must come from the user, call ask_user. Do not guess or merely describe a question in plain text.
- After editing code, verify: run tests, builds, or at least a syntax check via run_command
- Prefer edit_file for precise replacements; read_file first, old_string must match the file exactly
- Read large files in segments (offset/limit)
- Git operations go through run_command; to commit, use git commands or this CLI's g -y / g --ai
- run_command already executes in the working directory — do NOT prefix with cd; default timeout 120s, raise timeout_seconds (max 600) for long tasks
- Commands run under ${shellDesc}; keep syntax compatible
- Read this project's instructions, dependencies and test configuration before choosing verification commands; do not assume npm
- For a brief overview, inspect only the necessary structure and entry points; keep exploration proportional to the request

# Talking to the user
- When you need to confirm something, ask a question, or report an important decision, just write plain text — the user sees your output in real time. Use ask_user when the task must pause for an answer. Never call tools that do not exist; the built-in set is the ${builtinToolCount} tools listed above (if the user installed MCP servers, extra tools prefixed with mcp__ will also appear in your tool list)
- The user can attach images (Alt+V or /image); they arrive as image_url parts in your user messages. If the current model rejects images (no vision support), tell the user to switch to a vision-capable model
- When you spot high-risk or inconsistent state (version number / git tag / CHANGELOG mismatch, abnormal release environment, unexpected repo state), explain the finding and its impact in text, then STOP and wait for the user's decision instead of proceeding with destructive operations

# Output
- Your text output goes straight to the user's terminal; reply in English
- Report results in one or two sentences; do not narrate the process`
}

// ──────────────────────────────────────────────
// 消息兼容处理。只作用于请求副本，保留完整会话记录。
// ──────────────────────────────────────────────
export function sanitizeMessages(messages) {
  for (const m of messages) {
    if (m == null || typeof m !== 'object') continue
    if (m.content === null || m.content === undefined) {
      if (m.role === 'assistant') m.content = null
      continue
    }
    if (typeof m.content !== 'string') continue
    const trimmed = m.content.trim()
    if (trimmed === '') {
      if (m.role === 'assistant') {
        m.content = null
      } else if (m.role === 'tool') {
        m.content = '(no output)'
      } else if (m.role === 'user') {
        m.content = ' '
      }
      continue
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      m.content = null
    }
  }
  return messages
}

// ──────────────────────────────────────────────
// 多模态历史:base64 图片很占上下文,只保留"最近一条带图消息"里的图片,
// 更早消息里的 image_url 部件降级为文字占位(模型仍知道这里曾有图)
// ──────────────────────────────────────────────
export function stripStaleImages(messages, locale) {
  const placeholder = String(locale || '').startsWith('en')
    ? '[image omitted from history]'
    : '[图片已从历史中省略]'
  let seenLatest = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'user' || !Array.isArray(m.content)) continue
    const hasImage = m.content.some(p => p?.type === 'image_url')
    if (!hasImage) continue
    if (!seenLatest) { seenLatest = true; continue }
    m.content = m.content.map(p => p?.type === 'image_url'
      ? { type: 'text', text: placeholder }
      : p)
  }
}

// ──────────────────────────────────────────────
// 单轮 agent 循环:用户一句话 → 流式输出 → 工具调用 → 再调用模型 … 直到模型给出最终文本
// images: [{path, bytes}] 待发送图片(可为空数组)
// ──────────────────────────────────────────────
function printSlashHelp(t, locale) {
  const zh = !String(locale || '').startsWith('en')
  const lines = zh ? [
    '  /help             显示本帮助',
    '  /model            列出可用模型;/model <序号> 切换模型',
    '  /addmodel         添加新的模型配置(交互式向导)',
    '  /cd <路径>        切换智能体工作目录',
    '  /image [路径]     查看待发送图片;/image <路径> 附加本地图片;/image clear 清除',
    '  /think full       完整显示后续思考（默认，模型返回的内容）',
    '  /think compact    预览前 12 行思考',
    '  /think off        隐藏思考；/think 切换完整与隐藏',
    '  /tools [模式]     compact 精简 / full 完整工具输出',
    '  /skills           查看已安装的 Skill 与已接入的 MCP 服务',
    '  /stats            查看上一轮与会话累计用量、耗时',
    '  /new              开启新对话',
    '  /resume           选择并恢复之前的对话',
    '  /clear            清空对话历史',
    '  /exit, /quit      退出',
    '',
    '  Alt+V             粘贴剪贴板图片,随下一条消息发送(需视觉模型)',
    '',
    '权限说明: 工作目录内全部操作直接执行;其他目录可读写;',
    '命令守卫识别部分系统级危险操作，不是隔离沙箱。',
  ] : [
    '  /help             Show this help',
    '  /model            List models; /model <n> to switch',
    '  /addmodel         Add a new model (interactive wizard)',
    '  /cd <path>        Change agent working directory',
    '  /image [path]     List pending images; attach a file; /image clear to reset',
    '  /think full       Show future thinking returned by the model in full (default)',
    '  /think compact    Preview the first 12 thinking lines',
    '  /think off        Hide thinking; /think toggles full / hidden',
    '  /tools [mode]     compact / full tool output',
    '  /skills           List installed skills and connected MCP servers',
    '  /stats            Last turn timing and session token usage',
    '  /new              Start a new conversation',
    '  /resume           Choose and resume a previous conversation',
    '  /clear            Clear conversation history',
    '  /exit, /quit      Quit',
    '',
    '  Alt+V             Paste clipboard image (needs a vision-capable model)',
    '',
    'Permissions: full access in the working directory; other dirs readable/writable;',
    'the command guard detects some dangerous operations; it is not a sandbox.',
  ]
  printHelpPanel(t.helpTitle, lines)
}

export async function handleSlashCommand(state, input, t) {
  const [cmd, ...rest] = input.split(/\s+/)
  const arg = rest.join(' ').trim()
  const zh = !String(state.locale).startsWith('en')
  if (state.busy && !['/help', '/stats', '/think', '/tools', '/skills', '/mcp', '/exit', '/quit'].includes(cmd)) {
    printDim(t.busy)
    return 'ok'
  }

  if (cmd === '/exit' || cmd === '/quit') return 'exit'
  if (cmd === '/help') { printSlashHelp(t, state.locale); return 'ok' }
  if (cmd === '/clear' || cmd === '/new') {
    await state.persistSession?.()
    state.messages = [state.messages[0]]
    // 开新会话 ID,旧会话保留在磁盘上
    state.sessionId = genSessionId()
    state.sessionCreatedAt = new Date().toISOString()
    state.lastTurnStats = null
    state.sessionStats = null
    printOk(cmd === '/new' ? t.newConversation : t.cleared)
    return 'ok'
  }
  if (cmd === '/resume') {
    if (state.busy) {
      printDim(t.busy)
      return 'ok'
    }
    const sessions = (await listSessions())
      .filter(session => session.sessionId !== state.sessionId && session.messages.length > 1)
    if (sessions.length === 0) {
      printDim(t.resumeEmpty)
      return 'ok'
    }

    const zh = !String(state.locale || '').startsWith('en')
    const cleanLabel = (value, fallback) => String(value || fallback).replace(/[\r\n\x00-\x1f\x7f]/g, ' ').trim()
    const items = sessions.map((session) => {
      const title = cleanLabel(session.title, zh ? '(未命名对话)' : '(untitled)')
      const updated = new Date(session.updatedAt || session.createdAt || 0)
      const date = Number.isNaN(updated.getTime()) ? '' : updated.toLocaleString(state.locale)
      const count = session.messages.filter(message => message?.role !== 'system').length
      return {
        label: `${title}  ${chalk.dim(`${date} · ${count} ${zh ? '条消息' : 'messages'}`)}`,
        value: session,
      }
    })
    const selectStrings = {
      navHint: zh ? '↑↓ 切换,Enter 确认' : '↑↓ navigate, Enter confirm',
      selectPrompt: (min, max) => zh ? `请选择(${min}-${max}):` : `Choose (${min}-${max}):`,
      invalidChoice: (min, max) => zh ? `请输入 ${min}-${max} 之间的序号` : `Enter a number from ${min} to ${max}`,
    }
    const asker = {
      ask(prompt) {
        return new Promise(resolve => state.rl.question(`${prompt} `, answer => resolve(String(answer || '').trim())))
      },
    }

    state.inWizard = true
    try {
      const selected = await selectFromList({
        rl: state.rl,
        asker,
        title: t.resumeTitle,
        items,
        t: selectStrings,
      })
      if (!selected?.value) return 'ok'

      const session = selected.value
      const { promises: fsp } = await import('node:fs')
      if (session.cwd) {
        try {
          const stat = await fsp.stat(session.cwd)
          if (stat.isDirectory()) state.ctx.cwd = session.cwd
        } catch { /* 已删除的旧目录不阻断恢复,沿用当前目录 */ }
      }
      state.sessionId = session.sessionId
      state.sessionCreatedAt = session.createdAt || new Date().toISOString()
      state.messages = repairToolHistory(session.messages)
      state.lastTurnStats = session.lastTurnStats || null
      state.sessionStats = session.sessionStats || null
      const systemMessage = {
        role: 'system',
        content: await buildProjectPrompt({ cwd: state.ctx.cwd, locale: state.locale, shellDesc: state.shellDesc, extra: extensionSuffix(state) }),
      }
      if (state.messages[0]?.role === 'system') state.messages[0] = systemMessage
      else state.messages.unshift(systemMessage)
      state.pendingImages = []
      const count = state.messages.filter(message => message?.role !== 'system').length
      printOk(t.resumeDone(cleanLabel(session.title, session.sessionId), count))
    } catch (err) {
      if (err?.cancelled) printDim(t.resumeCancelled)
      else printError(err.message)
    } finally {
      state.inWizard = false
    }
    return 'ok'
  }
  if (cmd === '/think') {
    const next = arg || (state.showThinking ? 'off' : 'full')
    if (!['off', 'compact', 'full'].includes(next)) {
      printWarn('/think compact | full | off')
      return 'ok'
    }
    state.showThinking = next !== 'off'
    state.thinkingMode = next
    printOk(zh ? `后续请求的思考显示：${({ off: '隐藏', compact: '预览前 12 行', full: '完整' })[next]}` : `Thinking for future requests: ${next}`)
    return 'ok'
  }
  if (cmd === '/tools') {
    if (arg && !['full', 'compact'].includes(arg)) { printWarn('/tools compact | full'); return 'ok' }
    state.fullTools = arg ? arg === 'full' : !state.fullTools
    printOk(zh ? `后续工具结果：${state.fullTools ? '完整' : '精简'}` : `Future tool output: ${state.fullTools ? 'full' : 'compact'}`)
    return 'ok'
  }
  if (cmd === '/skills' || cmd === '/mcp') {
    const info = state.extensions?.summary(state.locale) || { skills: [], servers: [] }
    console.log(chalk.bold(`\n  ${t.extSkillTitle}`))
    if (info.skills.length === 0) printDim(t.extSkillEmpty)
    for (const skill of info.skills) {
      const scope = skill.scope === 'project' ? (zh ? '项目' : 'project') : (zh ? '全局' : 'global')
      console.log(`  · ${chalk.cyan(skill.name)} ${chalk.dim(`[${scope}]`)}${skill.description ? chalk.dim(` — ${skill.description}`) : ''}`)
    }
    console.log(chalk.bold(`\n  ${t.extMcpTitle}`))
    if (info.servers.length === 0) printDim(t.extMcpEmpty)
    for (const server of info.servers) {
      if (server.error) {
        console.log(`  · ${chalk.red(server.id)} ${chalk.dim(`— ${t.extMcpFailed}: ${server.error}`)}`)
      } else {
        console.log(`  · ${chalk.cyan(server.id)} ${chalk.dim(`— ${server.tools} ${zh ? '个工具' : 'tools'} (${server.command})`)}`)
      }
    }
    console.log('')
    return 'ok'
  }
  if (cmd === '/stats') {
    if (state.lastTurnStats) printTurnSummary(state.lastTurnStats, { locale: state.locale, session: state.sessionStats })
    else printDim(zh ? '完成一轮对话后显示用量与耗时。' : 'Usage and timing appear after a turn completes.')
    return 'ok'
  }
  if (cmd === '/image') {
    if (arg === 'clear') {
      state.pendingImages = []
      printOk(t.imageCleared)
      return 'ok'
    }
    if (!arg) {
      if (state.pendingImages.length === 0) {
        printDim(t.imageListEmpty)
      } else {
        console.log(chalk.bold(t.imageListTitle) + ':')
        state.pendingImages.forEach((img, i) => {
          console.log(`  ${i + 1}. ${img.path} ${chalk.dim('(' + formatBytes(img.bytes) + ')')}`)
        })
      }
      return 'ok'
    }
    const { resolve } = await import('node:path')
    const target = resolve(state.ctx.cwd, arg)
    const img = await checkImageFile(target)
    if (!img) {
      printError(t.imageBadPath(target))
      return 'ok'
    }
    state.pendingImages.push(img)
    printOk(t.imageAttached(state.pendingImages.length, formatBytes(img.bytes)))
    return 'ok'
  }
  if (cmd === '/model') {
    if (!arg) {
      console.log(chalk.bold(t.availableModels) + ':')
      state.models.forEach((m, i) => {
        const current = m === state.model ? chalk.green(' ← ' + t.currentModel) : ''
        const keyHint = m.apiKey ? '' : chalk.yellow(' (无 apiKey)')
        console.log(`  ${i + 1}. ${modelLabel(m)} ${chalk.dim(m.baseURL || '')}${keyHint}${current}`)
      })
      console.log(chalk.dim('/model <序号> 切换'))
      return 'ok'
    }
    const idx = Number.parseInt(arg, 10)
    if (!Number.isFinite(idx) || idx < 1 || idx > state.models.length) {
      printError(t.invalidModelIndex)
      return 'ok'
    }
    state.model = state.models[idx - 1]
    printOk(t.modelSwitched(modelLabel(state.model)))
    return 'ok'
  }
  if (cmd === '/addmodel') {
    // 智能体执行中不允许启动向导:向导的 rl.question 会与流式输出交错,体验混乱
    if (state.busy) {
      printDim(t.busy)
      return 'ok'
    }
    state.inWizard = true
    try {
      console.log(chalk.cyan.bold('\n' + t.addModelTitle))
      // 复用 modelSetup 的交互式收集逻辑(服务商 → 接口 → 模型名 → Key → 显示名 → 测试)
      const collected = await collectModelInput({
        locale: state.locale,
        rl: state.rl,
        cancelMessage: t.addModelCancelled,
      })
      if (!collected) return 'ok'
      const { baseURL, model, apiKey, displayName } = collected
      // 构建模型配置(isDefault=false:/addmodel 只是追加,不改默认模型)
      const newModel = buildModelConfig({ baseURL, model, apiKey, name: displayName, isDefault: false })
      // 持久化到 ~/.zen-gitsync/config.json 顶层 models 数组
      const cfg = await config.loadConfig()
      const models = Array.isArray(cfg.models) ? cfg.models : []
      models.push(newModel)
      cfg.models = models
      try {
        await config.saveConfig(cfg)
      } catch (err) {
        printError(t.addModelSaveError(err.message))
        return 'ok'
      }
      // 同步 REPL 状态:更新模型列表 + 自动切换到新模型(用户刚添加,大概率想立刻用)
      state.models = models
      state.model = newModel
      printOk(t.addModelSaved(displayName || model))
    } catch (err) {
      printError(err.message)
    } finally {
      state.inWizard = false
    }
    return 'ok'
  }
  if (cmd === '/cd') {
    if (!arg) { console.log(state.ctx.cwd); return 'ok' }
    const { resolve } = await import('node:path')
    const { promises: fsp } = await import('node:fs')
    const target = resolve(state.ctx.cwd, arg)
    try {
      const st = await fsp.stat(target)
      if (!st.isDirectory()) throw new Error('not a dir')
      state.ctx.cwd = target
      // 项目级 skill 与 .mcp.json 跟着工作目录走:先重载扩展(会关掉旧目录起的 MCP 子进程),
      // 再重建首条 system 消息 —— 顺序反了会把旧目录的 skill 清单写进新目录的提示词。
      await state.extensions?.reload({ cwd: target, locale: state.locale, onWarn: printWarn })
      state.messages[0] = { role: 'system', content: await buildProjectPrompt({ cwd: target, locale: state.locale, shellDesc: state.shellDesc, extra: extensionSuffix(state) }) }
      await state.persistSession?.()
      printOk(t.cdOk(target))
    } catch {
      printError(t.cdFail(target))
    }
    return 'ok'
  }
  printWarn(`未知命令: ${cmd},输入 /help 查看可用命令`)
  return 'ok'
}

// ──────────────────────────────────────────────
// 主入口
// ──────────────────────────────────────────────
export async function runAiAgent(argv = []) {
  const cfg = await config.loadConfig()
  const locale = cfg.locale || 'zh-CN'
  const t = makeStrings(locale)

  // g ai --help:智能体专属帮助,不触发主 CLI 的 showHelp
  if (argv.includes('--help') || argv.includes('-h')) {
    printSlashHelp(t, locale)
    return
  }

  let models = Array.isArray(cfg.models) ? cfg.models : []
  if (models.length === 0) {
    // 未配置模型:启动交互式配置向导,参照 g ui 设置里的"添加模型"
    const setupResult = await runModelSetup({ locale })
    if (!setupResult) {
      process.exitCode = 1
      return
    }
    models = setupResult.models
  }

  // --model=<序号|名称> 选择模型;默认 isDefault,否则第一个
  let model = models.find(m => m.isDefault) || models[0]
  const modelArg = argv.find(a => a.startsWith('--model='))
  if (modelArg) {
    const q = modelArg.split('=')[1]
    const idx = Number.parseInt(q, 10)
    if (Number.isFinite(idx) && idx >= 1 && idx <= models.length) {
      model = models[idx - 1]
    } else {
      const found = models.find(m => modelLabel(m).toLowerCase().includes(String(q).toLowerCase()))
      if (found) model = found
      else printWarn(t.unknownModel(q))
    }
  }

  const cwd = getCwd()
  const shellDesc = process.platform === 'win32'
    ? 'cmd.exe (Windows CMD)'
    : (process.env.SHELL || '/bin/sh')

  // 加载扩展(Skill 清单 + MCP 服务)。MCP 要起子进程,npx 首次还得下载包,
  // 所以这一步可能明显停顿 —— 有 MCP 时先提示一句。任何失败都只降级并打印原因。
  const extensions = await AgentExtensions.load({
    cwd,
    locale,
    onWarn: printWarn,
    onNotice: (count) => printDim(t.extLoadingMcp(count)),
  })

  const state = {
    // 会话持久化:CLI 对话也保存到 ~/.zen-gitsync/agent-sessions/,
    // 在 Web UI 智能体 tab 中可见(带 CLI 标记)
    sessionId: genSessionId(),
    sessionCreatedAt: new Date().toISOString(),
    messages: [{ role: 'system', content: await buildProjectPrompt({ cwd, locale, shellDesc, extra: extensions.promptSuffix(locale) }) }],
    ctx: {
      cwd,
      onChild: (child) => {
        state.currentChild = child
        // 子进程退出后清掉引用,避免 SIGINT 时 kill 一个已结束的进程
        child.once?.('exit', () => { if (state.currentChild === child) state.currentChild = null })
      },
    },
    models,
    model,
    locale,
    shellDesc,
    // 单轮工具调用上限:来自全局配置 aiMaxToolIterations(loadConfig 已规范化),
    // 读不到时由 runAgentTurn 兜底为 200
    maxToolIterations: cfg.aiMaxToolIterations,
    currentChild: null,
    abortController: null,
    cancelRequested: false,
    busy: false,
    showThinking: true,     // /think 切换:是否回显模型的思考过程
    thinkingMode: 'full',
    fullTools: false,
    lastTurnStats: null,
    sessionStats: null,
    prepareMessages: (messages) => { stripStaleImages(messages, locale); sanitizeMessages(messages) },
    pendingImages: [],      // Alt+V / /image 附加的待发送图片 [{path, bytes}]
    pasting: false,         // 剪贴板读取进行中(防 Alt+V 连打并发)
    inWizard: false,        // /addmodel 交互式向导进行中:忽略 REPL 的 line 事件
    rl: null,               // REPL readline 引用(供 /addmodel 复用做 rl.question)
    extensions,             // 已加载的 Skill + MCP 扩展(见 extensions.js)
  }

  // 持久化当前会话到磁盘(供 Web UI 读取)
  let saving = Promise.resolve()
  async function persistSession() {
    if (state.messages.length <= 1) return
    try {
      const title = autoTitle(state.messages)
      const sessionId = state.sessionId
      const snapshot = JSON.parse(JSON.stringify({
        version: 1,
        sessionId: state.sessionId,
        title,
        source: 'cli',
        cwd: state.ctx.cwd,
        model: modelLabel(state.model),
        createdAt: state.sessionCreatedAt,
        updatedAt: new Date().toISOString(),
        messages: repairToolHistory(state.messages),
        lastTurnStats: state.lastTurnStats,
        sessionStats: state.sessionStats,
      }))
      saving = saving.catch(() => {}).then(() => writeSession(sessionId, snapshot))
      await saving
      enforceRetention().catch(() => {})
    } catch (err) {
      // 持久化失败不影响 CLI 正常使用
      printDim(`(会话保存失败: ${err.message})`)
    }
  }
  state.persistSession = persistSession

  // SIGINT 时中止进行中的 LLM 请求 + 正在跑的子命令
  // (进程退出与全局子进程 drain 由 gitCommit.js 的统一 handler 负责,这里只做快速止血)
  registerCleanup('aiAgent', async () => {
    state.cancelRequested = true
    try { state.abortController?.abort() } catch (_) {}
    await terminateCommand(state.currentChild)
    // MCP 子进程必须显式收掉:它们挂在 stdio 上,不收会让进程无法自然退出
    await extensions.close()
    await persistSession()
  })

  // 扩展摘要:一条 dim 行,没有装扩展时完全静默(extNone 为空串)
  const extSummary = extensions.skills.length || extensions.tools.length
    ? t.extLoaded(extensions.skills.length, extensions.tools.length)
    : t.extNone

  // 单发模式:g ai "帮我改个 bug"(位置参数拼成 prompt,跑一轮就退出)
  const oneShot = argv.filter(a => !a.startsWith('-')).join(' ').trim()
  if (oneShot) {
    console.log(chalk.dim(`[${t.bannerModel}] ${modelLabel(model)} · [${t.bannerCwd}] ${cwd}`))
    if (extSummary) printDim(extSummary)
    state.abortController = new AbortController()
    const stats = await runAgentTurn(state, oneShot, t)
    if (stats.status === 'completed') printDim(t.oneShotDone)
    else process.exitCode = stats.status === 'cancelled' ? 130 : 1
    return
  }

  // ── 交互模式(REPL)──
  printBanner({
    title: 'Zen GitSync — AI Agent',
    modelLabel: modelLabel(model),
    baseURL: model.baseURL || '',
    cwd,
    modelText: t.bannerModel,
    cwdText: t.bannerCwd,
    tip: t.bannerTip,
  })
  if (extSummary) printDim(extSummary)

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    // 颜色闭合，避免提示符的样式泄漏到后续输出。
    prompt: chalk.cyan.bold(t.prompt + ' '),
    historySize: 200,
  })
  state.rl = rl  // 供 /addmodel 等需要 rl.question 的斜杠命令复用

  // ask_user pauses the tool loop inside the same readline session. The REPL
  // line handler is bypassed while this small wizard owns the input line.
  state.ctx.askUser = ({ question, options = [], allowFreeText = true }) => {
    const zh = !String(state.locale || '').startsWith('en')
    const safeOptions = Array.isArray(options) ? options.filter(Boolean).slice(0, 20) : []
    state.inWizard = true
    if (safeOptions.length > 0) {
      console.log(chalk.cyan(`\n${question}`))
      safeOptions.forEach((option, index) => console.log(`  ${chalk.cyan(String(index + 1))}. ${option}`))
    } else {
      console.log(chalk.cyan(`\n${question}`))
    }

    return new Promise(resolve => {
      let settled = false
      const questionController = new AbortController()
      const parentSignal = state.abortController?.signal
      const cleanup = () => {
        rl.removeListener?.('close', onClose)
        rl.removeListener?.('operationCancel', onCancel)
        rl.input?.removeListener?.('keypress', onKeypressCancel)
        parentSignal?.removeEventListener?.('abort', onParentAbort)
      }
      const finish = answer => {
        if (settled) return
        settled = true
        cleanup()
        state.inWizard = false
        resolve(answer)
      }
      const cancel = () => {
        if (settled) return
        questionController.abort()
        finish('Cancelled by user; the question was not answered.')
      }
      const onClose = () => cancel()
      const onCancel = () => {
        state.cancelRequested = true
        try { state.abortController?.abort() } catch (_) {}
        cancel()
      }
      const onParentAbort = () => cancel()
      const onKeypressCancel = (_str, key) => {
        if (!key?.ctrl || key.name !== 'c') return
        key.name = 'escape'
        key.sequence = ''
        key.ctrl = false
        key.meta = false
        key.shift = false
        onCancel()
      }

      rl.once('close', onClose)
      rl.once('operationCancel', onCancel)
      rl.input?.prependListener?.('keypress', onKeypressCancel)
      parentSignal?.addEventListener?.('abort', onParentAbort, { once: true })

      const promptAnswer = () => {
        const hint = safeOptions.length > 0
          ? (allowFreeText ? (zh ? '请输入序号或直接输入回答' : 'Choose a number or type an answer') : (zh ? '请输入序号' : 'Choose a number'))
          : (zh ? '请输入回答' : 'Type your answer')
        rl.question(`${hint}: `, { signal: questionController.signal }, answer => {
          if (settled) return
          const trimmed = String(answer || '').trim()
          if (safeOptions.length > 0) {
            const index = Number.parseInt(trimmed, 10)
            if (Number.isInteger(index) && index >= 1 && index <= safeOptions.length) {
              finish(safeOptions[index - 1])
              return
            }
            if (!allowFreeText || !trimmed) {
              console.log(chalk.yellow(zh ? `请输入 1-${safeOptions.length} 之间的序号` : `Enter a number from 1 to ${safeOptions.length}`))
              promptAnswer()
              return
            }
          }
          if (!trimmed) {
            console.log(chalk.yellow(zh ? '回答不能为空' : 'Answer cannot be empty'))
            promptAnswer()
            return
          }
          finish(trimmed)
        })
      }
      promptAnswer()
    })
  }

  // 输入提示符管理。
  //
  // readline 的 _refreshLine() 用 prevRows 追踪“提示符占了几行”,
  // 下次刷新时 moveCursor(0, -prevRows) 上移光标。但模型输出直接写
  // stdout,readline 不知道这些行,导致 prevRows 过期 → 光标错位。
  //
  // 修复:每次画提示符前,先写 \r\n 确保光标在新行第 0 列,
  // 然后重置 prevRows=0 告诉 readline “当前行就是提示符行”。
  // 这样 _refreshLine() 的 clearScreenDown() 只清当前空行,不影响模型输出。

  const showPrompt = () => {
    if (rl.closed) return
    // 双保险:确保 stdin 处于 flowing 模式(ora 的 stdin-discarder 可能在
    // stop() 时 pause 了 stdin,即使 discardStdin:false 已设,仍防止其他
    // 库意外 pause)
    if (process.stdin.isTTY && !process.stdin.readableFlowing) {
      process.stdin.resume()
    }
    if (process.stdout.isTTY) {
      // 确保光标在新行第 0 列(\r 回行首,\n 换行)
      process.stdout.write('\r\n')
      // 重置 readline 内部光标追踪
      rl.prevRows = 0
    }
    rl.prompt()
  }

  // 安全版:防止 finally 块里的异常变成 unhandledRejection 杀掉会话
  const safeShowPrompt = () => {
    try {
      showPrompt()
    } catch (_) {
      try { rl.prompt() } catch { /* 给予宽容 */ }
    }
  }

  // 仅重画提示符,不写 \r\n(用于空输入、busy 等不需要换行的场景)
  const safeRefreshPrompt = () => {
    try {
      if (rl.closed) return
      rl.prevRows = 0
      rl.prompt()
    } catch (_) {
      try { rl.prompt() } catch { /* noop */ }
    }
  }

  // 在提示符上方插一行通知(粘贴进度等)。
  const notifyAbovePrompt = (text) => {
    console.log(text)
    if (!state.busy) safeShowPrompt()
  }

  // ── 斜杠命令即时提示(支持 ↑↓ 切换 / Tab、Enter 补全) ──
  // 在提示符下方浮现匹配到的命令,随输入过滤;不移动光标(用 DECSC/DECRC 保存-恢复)。
  // slashHintRows 记录当前提示占了几行,下次刷新/提交时据此擦除,避免残影。
  // slashHintBaseLine:本次 hint 显示时"输入行的基线值" — ↑↓ 时 readline 已经把
  //   rl.line 改成历史上一行,我们用基线回滚 + _refreshLine() 重绘,让用户视觉上看
  //   不到"按 ↑ 输入行变了",只看到 hint 高亮跳了一格。
  let slashHintRows = 0
  let slashHintBaseLine = ''
  let slashHintMatches = []
  let slashHintIndex = 0
  const eraseSlashHint = () => {
    if (!process.stdout.isTTY || slashHintRows === 0) return
    // 保存光标 → 下移到提示区逐行清空 → 恢复光标
    let seq = '\x1b7'
    for (let i = 0; i < slashHintRows; i++) seq += '\x1b[1B\x1b[2K'
    seq += '\x1b8'
    process.stdout.write(seq)
    slashHintRows = 0
  }
  const drawSlashHint = () => {
    const body = renderSlashHintBody(slashHintMatches, slashHintIndex, state.locale)
    const hadVisibleHint = slashHintRows > 0
    eraseSlashHint()
    if (!body) return
    const rows = body.split('\n')
    if (!hadVisibleHint) {
      // CSI B(光标下移)到达终端底部后只会停在最后一行,不会自动滚屏,
      // 所以候选项会被裁掉。第一次显示提示时先用换行真实预留空间,
      // 再上移相同行数回到输入行；无论中途是否发生滚屏,都能回到原内容所在行。
      let reserve = ''
      for (let i = 0; i < rows.length; i++) reserve += '\n\x1b[2K'
      reserve += `\x1b[${rows.length}A`
      process.stdout.write(reserve)
    }
    // 保存光标,逐行下移打印(每行先清行防止与旧内容叠字),最后恢复光标回输入行
    let seq = '\x1b7'
    for (const r of rows) seq += '\x1b[1B\x1b[2K\r' + r
    seq += '\x1b8'
    process.stdout.write(seq)
    slashHintRows = rows.length
  }
  // 重置 hint 上下文:重新计算匹配 + 重画。输入字符变化时调用。
  const refreshSlashHint = () => {
    if (!process.stdout.isTTY || state.busy || state.inWizard) {
      eraseSlashHint()
      slashHintMatches = []
      slashHintIndex = 0
      slashHintBaseLine = ''
      return
    }
    slashHintBaseLine = rl.line
    slashHintMatches = filterSlashCommands(rl.line, state.locale)
    // 匹配列表缩短时夹紧 index(增删交替时不会越界)
    slashHintIndex = slashHintIndex < slashHintMatches.length ? slashHintIndex : 0
    drawSlashHint()
  }
  // ↑↓ / Shift+Tab:readline 已经把 rl.line 改成历史行或没动 → 强制恢复基线并重绘输入行
  const restoreInputLineToBaseline = () => {
    if (rl.line === slashHintBaseLine) return
    rl.line = slashHintBaseLine
    rl.cursor = slashHintBaseLine.length
    if (typeof rl._refreshLine === 'function') rl._refreshLine()
  }
  // Tab / Enter:把 rl.line 替换为补全文本 + 清掉 hint 状态。
  // Enter 会先被 readline 提交,因此由下方 line handler 在处理命令前调用本函数。
  const applyHintCompletion = (newLine) => {
    rl.line = newLine
    rl.cursor = newLine.length
    eraseSlashHint()
    slashHintMatches = []
    slashHintIndex = 0
    slashHintRows = 0
    slashHintBaseLine = newLine
    if (typeof rl._refreshLine === 'function') rl._refreshLine()
  }

  const neutralizeKeyForReadline = (key) => {
    key.name = 'escape'
    key.sequence = ''
    key.ctrl = false
    key.meta = false
    key.shift = false
  }

  // readline 自己会优先处理 Enter/Ctrl+C。用 prependListener 在它之前完成补全
  // 或取消当前操作,再把本次按键变成 readline 会忽略的 Esc。
  const interceptInteractiveControlKeys = (_ch, key) => {
    if (!key) return
    if (key.ctrl && key.name === 'c') {
      if (state.inWizard) {
        neutralizeKeyForReadline(key)
        rl.emit('operationCancel')
        return
      }
      if (state.busy) {
        neutralizeKeyForReadline(key)
        state.cancelRequested = true
        try { state.abortController?.abort() } catch (_) {}
        void terminateCommand(state.currentChild)
        return
      }
      if (slashHintRows > 0) {
        neutralizeKeyForReadline(key)
        applyHintCompletion('')
        return
      }
      return
    }
    if (key.name !== 'return' && key.name !== 'enter') return
    if (slashHintRows === 0 || slashHintMatches.length === 0 || state.busy || state.inWizard) return
    const selected = slashHintMatches[slashHintIndex]
    if (!selected) return
    applyHintCompletion(selected.cmd + ' ')
    neutralizeKeyForReadline(key)
  }
  rl.input.prependListener('keypress', interceptInteractiveControlKeys)

  // Alt+V 粘贴剪贴板图片(node 把 ESC+v 解析为 meta+v;部分终端不发 Alt,可用 /image 兜底)
  const pasteFromClipboard = async () => {
    if (state.pasting) return
    state.pasting = true
    try {
      notifyAbovePrompt(chalk.dim(t.imagePasting))
      const img = await readClipboardImage()
      if (!img) {
        notifyAbovePrompt(chalk.yellow(t.imageEmpty))
      } else {
        state.pendingImages.push(img)
        notifyAbovePrompt(chalk.green(t.imageAttached(state.pendingImages.length, formatBytes(img.bytes))))
      }
    } catch (err) {
      // 不能让粘贴异常变成 unhandledRejection 杀掉会话
      printError(`粘贴图片失败: ${err.message}`)
    } finally {
      state.pasting = false
    }
  }
  rl.input.on('keypress', (ch, key) => {
    if (!key) return

    // ── 斜杠命令提示专用键盘:↑↓/Tab/Enter/Shift+Tab/Esc ──
    // 仅在 hint 已显示且有匹配项时拦截,readline 的 default 行为(历史浏览等)
    // 我们在 handler 里事后回滚 rl.line 来抵消
    const action = parseKeyForSlashHint(key)
    const hintActive = action === 'prev' || action === 'next' || action === 'complete' || action === 'cancel'
      ? (slashHintRows > 0 && slashHintMatches.length > 0 && !state.busy && !state.inWizard)
      : false

    if (hintActive) {
      if (action === 'prev' || action === 'next') {
        const n = slashHintMatches.length
        slashHintIndex = action === 'prev'
          ? (slashHintIndex - 1 + n) % n
          : (slashHintIndex + 1) % n
        restoreInputLineToBaseline()
        drawSlashHint()
        return   // 不再走 default update + Alt+V 分支
      }
      if (action === 'complete') {
        // Tab:把输入行替换为选中命令 + 末尾空格(便于继续打参数),
        // 光标跳到末尾;之后不再触发 hint(已经精确选了某个命令)
        const sel = slashHintMatches[slashHintIndex]
        const newLine = sel.cmd + ' '
        applyHintCompletion(newLine)
        return
      }
      if (action === 'cancel') {
        // Esc:只清 hint,不动输入行
        eraseSlashHint()
        slashHintMatches = []
        slashHintIndex = 0
        return
      }
    }

    // Enter 走默认 readline 提交,line 事件里把选中项恢复到输入框;
    // 其他普通按键:重算匹配 + 重画 hint
    if (!(key.name === 'return' || key.name === 'enter')) {
      refreshSlashHint()
    }

    // Alt+V 粘贴剪贴板图片(node 把 ESC+v 解析为 meta+v;部分终端不发 Alt,可用 /image 兜底)
    const isAltV = (key.meta && key.name === 'v')
      || (typeof key.sequence === 'string' && key.sequence.length === 2
          && key.sequence.charCodeAt(0) === 27 && key.sequence[1] === 'v')
    if (isAltV) pasteFromClipboard()
  })

  // 初始提示符:banner 后直接画(不需要 \r\n)
  rl.prevRows = 0
  rl.prompt()

  rl.on('line', async (line) => {
    // 提交时光标已落到提示符下一行(即提示区起点),直接清到屏幕末尾擦掉整块提示,
    // 比 DECSC/DECRC 相对定位更稳(此时光标不在输入行)
    if (process.stdout.isTTY && slashHintRows > 0) {
      process.stdout.write('\x1b[0J')
      slashHintRows = 0
    }
    // /addmodel 等交互式向导进行中时,用户的回答由向导自身的 rl.question 处理,
    // 不应进入 REPL 的正常输入流程(否则会把向导的答案当成命令/消息发给模型)
    if (state.inWizard) return
    const input = line.trim()

    if (input.startsWith('/')) {
      const r = await handleSlashCommand(state, input, t)
      if (r === 'exit') { rl.close(); return }
      safeRefreshPrompt()
      return
    }

    if (!input) { safeRefreshPrompt(); return }
    if (state.busy) {
      printDim(t.busy)
      safeRefreshPrompt()
      return
    }

    // 取出待发送图片(取出即清空队列,用户每条消息独立决定带不带图)
    const images = state.pendingImages.splice(0)
    if (images.length > 0) printDim(t.imageSending(images.length))

    state.busy = true
    state.cancelRequested = false
    state.abortController = new AbortController()
    try {
      await runAgentTurn(state, input, t, images)
    } catch (err) {
      if (state.cancelRequested) printDim(t.operationCancelled)
      else printError(err.message)
    } finally {
      state.busy = false
      state.cancelRequested = false
      state.abortController = null
      safeShowPrompt()
    }
  })

  rl.on('close', () => {
    if (state.busy) {
      state.cancelRequested = true
      state.abortController?.abort()
      void terminateCommand(state.currentChild)
    }
    rl.input.removeListener('keypress', interceptInteractiveControlKeys)
    printWarn('\n' + t.bye)
  })

  // 全局安全网:任何未捕获的 Promise rejection / 异常都不应该静默杀掉
  // 整个 REPL 会话。这里记录到 stderr 但不退出,让 readline 继续运行。
  const rejectionHandler = (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason)
    printError(`内部错误(已捕获,会话继续): ${msg}`)
    safeShowPrompt()
  }
  process.on('unhandledRejection', rejectionHandler)

  // 等 readline 关闭后返回(进程随后自然退出)
  await new Promise((resolve) => rl.on('close', resolve))

  // 清理:移除本次会话注册的全局处理器
  process.removeListener('unhandledRejection', rejectionHandler)
}

export default { runAiAgent }

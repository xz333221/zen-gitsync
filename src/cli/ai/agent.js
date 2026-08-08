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
//   - 默认使用 g ui 里配置的模型(~/.git-commit-tool.json 顶层 models,
//     isDefault 优先,否则取第一个);--model=<序号|名称> 或会话内 /model 切换
//   - OpenAI 兼容流式 function calling:模型可以调用 run_command /
//     read_file / write_file / edit_file / list_files / search_text
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
//   - Ctrl+C 行为与 CLI 其他模式一致:由 gitCommit.js 的 setupSigintHandler
//     统一 drain(trackChild 杀子进程 + cleanup 任务),整个会话退出

import readline from 'node:readline'
import chalk from 'chalk'
import config from '../../config.js'
import { getCwd } from '../../utils/index.js'
import { registerCleanup } from '../cleanup.js'
import { TOOL_DEFINITIONS, executeTool } from './tools.js'
import { createThinkFilter } from './streamFilter.js'
import {
  printBanner, printHelpPanel,
  filterSlashCommands, renderSlashHintBody, parseKeyForSlashHint,
  startSpinner, createAssistantWriter,
  summarizeToolArgs, printToolHeader, printToolResult,
  formatDuration,
  printOk, printWarn, printError, printDim,
} from './termui.js'
import { readClipboardImage, checkImageFile, imageToDataUrl, formatBytes } from './images.js'
import { runModelSetup, collectModelInput, buildModelConfig, selectFromList } from './modelSetup.js'
import { genSessionId, autoTitle, writeSession, enforceRetention, listSessions } from './sessionStore.js'

// truncateDisplay 已迁移到 termui.js;这里 re-export 保持既有测试/外部引用不断
export { truncateDisplay } from './termui.js'

// ──────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────
const MAX_TOOL_ITERATIONS = 40      // 单轮用户输入允许的最大工具调用循环数(防失控)
const MAX_HISTORY_MESSAGES = 40     // 历史消息上限(超出后从最旧的整段对话裁剪)
const LLM_TIMEOUT_MS = 300000       // 单次 LLM 请求超时(5 分钟,长推理模型够用)

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
    busy: '智能体正在执行中,请稍候(Ctrl+C 结束会话)…',
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
    bannerTip: 'Alt+V 粘贴图片 · /help 查看命令 · /exit 退出 · Ctrl+C 结束会话',
    prompt: '❯ ',
    bannerModel: '模型',
    bannerCwd: '目录',
    thinkingLabel: '思考',
    chars: '字符',
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
    busy: 'Agent is working, please wait (Ctrl+C to end session)…',
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
    bannerTip: 'Alt+V paste image · /help for commands · /exit to quit · Ctrl+C to end session',
    prompt: '❯ ',
    bannerModel: 'Model',
    bannerCwd: 'CWD',
    thinkingLabel: 'Thinking',
    chars: 'chars',
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
function buildSystemPrompt({ cwd, locale, shellDesc }) {
  const zh = !String(locale || '').startsWith('en')
  const now = new Date().toLocaleString()
  const isWin = process.platform === 'win32'
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
  安全守卫会拦截这类命令;被拦截时换安全方案,或告知用户需要他手动执行。

# 工作方式
- 先动手、后提问:能用工具查清的不要问用户(list_files / read_file / search_text / run_command)
- 修改代码后主动验证:跑测试、构建或至少语法检查(用 run_command)
- 编辑文件优先 edit_file 精确替换;先 read_file 看原文,old_string 必须与文件内容完全一致(含缩进换行)
- 大文件用 offset/limit 分段读取,不要一次读爆上下文
- git 操作用 run_command 执行;提交代码可以用 git 命令,也可以用本 CLI 的 g -y(默认信息提交并推送)或 g --ai(AI 生成提交信息)
- run_command 默认就在工作目录执行,不要再加 cd / cd /d 前缀;默认超时 120 秒,长任务加大 timeout_seconds(最大 600)
- 命令在 ${shellDesc} 下执行,注意语法兼容
- 本项目跑测试用 npm test(node --test 不支持直接传目录路径)

# 与用户交互
- 需要向用户确认、提问或汇报重要决策时,直接用普通文本输出 —— 用户能实时看到你的文本;
  不要调用不存在的工具,可用工具只有上面列出的 6 个
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
- Single red line: never destroy the system (format disks, delete root/system dirs, shutdown/reboot, write block devices). A safety guard blocks such commands; if blocked, find a safe alternative or ask the user to run it manually.

# How to work
- Act first, ask later: use tools (list_files / read_file / search_text / run_command) instead of asking the user
- After editing code, verify: run tests, builds, or at least a syntax check via run_command
- Prefer edit_file for precise replacements; read_file first, old_string must match the file exactly
- Read large files in segments (offset/limit)
- Git operations go through run_command; to commit, use git commands or this CLI's g -y / g --ai
- run_command already executes in the working directory — do NOT prefix with cd; default timeout 120s, raise timeout_seconds (max 600) for long tasks
- Commands run under ${shellDesc}; keep syntax compatible
- Run this project's tests with npm test (node --test does not accept a bare directory)

# Talking to the user
- When you need to confirm something, ask a question, or report an important decision, just write plain text — the user sees your output in real time. Never call tools that do not exist; only the 6 tools listed above are available
- The user can attach images (Alt+V or /image); they arrive as image_url parts in your user messages. If the current model rejects images (no vision support), tell the user to switch to a vision-capable model
- When you spot high-risk or inconsistent state (version number / git tag / CHANGELOG mismatch, abnormal release environment, unexpected repo state), explain the finding and its impact in text, then STOP and wait for the user's decision instead of proceeding with destructive operations

# Output
- Your text output goes straight to the user's terminal; reply in English
- Report results in one or two sentences; do not narrate the process`
}

// ──────────────────────────────────────────────
// LLM 流式调用(OpenAI 兼容 + function calling)
// 返回 { content, toolCalls, aborted }
// ──────────────────────────────────────────────
async function streamChatOnce({ model, messages, signal, onToken }) {
  const url = `${String(model.baseURL || '').replace(/\/$/, '')}/chat/completions`
  const headers = { 'Content-Type': 'application/json' }
  if (model.apiKey) headers['Authorization'] = `Bearer ${model.apiKey}`

  const body = JSON.stringify({
    model: model.model,
    messages,
    tools: TOOL_DEFINITIONS,
    temperature: 0.3,
    stream: true,
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)
  const onExternalAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onExternalAbort)
  }

  let content = ''
  // tool_calls 按 index 累积:provider 分片推送 id / name / arguments
  const toolCalls = []
  let aborted = false
  try {
    const resp = await fetch(url, { method: 'POST', headers, body, signal: controller.signal })
    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => '')
      const snippet = errText.length > 300 ? errText.slice(0, 300) + '…' : errText
      // 400 且提到 tools/functions:大概率是模型不支持 function calling
      if (resp.status === 400 && /tool|function/i.test(snippet)) {
        throw new Error(`HTTP 400: 当前模型可能不支持 function calling(${snippet})。请在 g ui 中换用支持工具调用的模型(如 deepseek / qwen / gpt 系列)。`)
      }
      throw new Error(`HTTP ${resp.status}: ${snippet || resp.statusText}`)
    }

    const decoder = new TextDecoder('utf-8')
    let buf = ''
    for await (const chunk of resp.body) {
      buf += decoder.decode(chunk, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') continue
        let evt
        try { evt = JSON.parse(payload) } catch { continue }
        const delta = evt.choices?.[0]?.delta || {}

        // thinking(各 provider 字段名不同,逐一尝试)
        const thinkingChunk = delta.reasoning_content || delta.reasoning || delta.reasoning_text || ''
        if (thinkingChunk) onToken({ thinking: thinkingChunk })

        if (delta.content) {
          content += delta.content
          onToken({ content: delta.content })
        }

        for (const tc of delta.tool_calls || []) {
          const i = tc.index ?? 0
          if (!toolCalls[i]) toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } }
          if (tc.id) toolCalls[i].id += tc.id
          if (tc.function?.name) toolCalls[i].function.name += tc.function.name
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments
        }
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError' || controller.signal.aborted) {
      aborted = true
    } else {
      throw err
    }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onExternalAbort)
  }
  return { content, toolCalls: toolCalls.filter(Boolean), aborted }
}

// ──────────────────────────────────────────────
// 历史裁剪:保留 system + 最近 MAX_HISTORY_MESSAGES 条
// 切口必须落在 user 消息上,避免把 assistant(tool_calls) 与其 tool 结果从中间撕开
// ──────────────────────────────────────────────
function trimHistory(messages) {
  if (messages.length <= MAX_HISTORY_MESSAGES + 1) return
  let cut = messages.length - MAX_HISTORY_MESSAGES
  // 至少向后扫 5 条,跳过孤立的 tool / assistant(tool_calls),
  // 找到真正的 user 节点再切,防止撕裂 tool 调用链
  let safety = 0
  while (cut < messages.length && messages[cut].role !== 'user' && safety < 8) {
    cut++
    safety++
  }
  if (cut <= 1 || messages[cut]?.role !== 'user') return
  messages.splice(1, cut - 1)
}

// ──────────────────────────────────────────────
// 消息消毒:确保发给 LLM 的消息数组里没有空内容。
//
// 背景:部分 LLM provider(如 Moonshot/Kimi、智谱、火山引擎、MiniMax 等)
// 对 assistant 历史消息 content 校验严格 —— 当某轮 assistant 只返回
// tool_calls 而没有文本、或正文被 trim 后只剩空白时,provider 会拒绝
// 并报 "chat content is empty (2013)"。OpenAI 官方规范允许 assistant
// 消息在带 tool_calls 时 content 为 null,但 provider 实现不一致:
//
//   - assistant 带 tool_calls → content 强制 null(即使有字符串)
//   - assistant 不带 tool_calls 且 content 全空白 → null(避免触发 2013)
//   - user content 全空白 → 用单个空格 ' ' 占位(provider 通常可接受)
//   - tool content 全空白 → '(no output)' 占位(防止序列化时被丢)
//
// CLI 与 Web 端共用本逻辑(两份实现必须保持一致)。
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
async function runAgentTurn(state, userText, t, images = []) {
  // 有图片:编码为 OpenAI 多模态 content parts;没图片保持纯字符串
  if (images.length > 0) {
    const parts = [{ type: 'text', text: userText }]
    for (const img of images) {
      try {
        const url = await imageToDataUrl(img.path)
        parts.push({ type: 'image_url', image_url: { url } })
      } catch (err) {
        printWarn(t.imageBadPath(img.path))
      }
    }
    state.messages.push({ role: 'user', content: parts })
  } else {
    state.messages.push({ role: 'user', content: userText })
  }
  // 旧消息里的图片降级为占位文字,防止 base64 随对话轮次累积撑爆上下文
  stripStaleImages(state.messages, state.locale)

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    trimHistory(state.messages)

    // 首个 token 到达前转 spinner,到达后停掉并让位给流式渲染
    const spinner = startSpinner(t.waiting)
    let spinnerStopped = false
    const stopSpinner = () => {
      if (!spinnerStopped) { spinner.stop(); spinnerStopped = true }
    }
    // 每次 LLM 调用一个 writer:思考(橙黄斜体)+ 正文 ➤ 子弹头 + 逐行 markdown
    const writer = createAssistantWriter({
      showThinking: state.showThinking,
      thinkingHeader: t.thinkingLabel,
    })
    // MiniMax 系把 <think> 标签内联在 content 流里,用过滤器剥离并置灰显示
    // (历史里仍保存模型原始输出,见 streamChatOnce 返回的 content)
    const thinkFilter = createThinkFilter()
    const renderSeg = (seg) => {
      const kind = seg.content !== undefined ? 'content' : 'thinking'
      const text = seg.content ?? seg.thinking
      if (!text) return
      stopSpinner()
      if (kind === 'thinking') writer.writeThinking(text)
      else writer.writeContent(text)
    }

    // 发送前消毒:确保历史里没有空 content 的消息(部分 provider 报 2013)
    sanitizeMessages(state.messages)

    const llmStart = performance.now()
    let result
    try {
      result = await streamChatOnce({
        model: state.model,
        messages: state.messages,
        signal: state.abortController?.signal,
        onToken: ({ thinking, content }) => {
          if (thinking) renderSeg({ thinking })
          if (content) for (const seg of thinkFilter.feed(content)) renderSeg(seg)
        },
      })
      // 流结束,冲刷过滤器里残留的半拉标签/未闭合 think 块
      for (const seg of thinkFilter.flush()) renderSeg(seg)
    } catch (err) {
      stopSpinner()
      writer.finish()
      printError(t.llmError(err.message))
      // 请求失败时,如果最后一条仍是本轮塞进去的 user 消息则撤掉,
      // 避免历史里留一条没有回应的消息;若已进入工具循环(末尾是 tool
      // 结果),消息链本身是完整的,保持不动
      const last = state.messages[state.messages.length - 1]
      if (last?.role === 'user') state.messages.pop()
      return
    }
    const llmDuration = performance.now() - llmStart
    stopSpinner()
    writer.finish()

    if (result.aborted) {
      printWarn('⛔ 已中止')
      return
    }

    const { content, toolCalls } = result

    // 无工具调用:本轮结束,assistant 文本入历史
    if (toolCalls.length === 0) {
      state.messages.push({ role: 'assistant', content: content || null })
      return
    }

    // 有工具调用:assistant(带 tool_calls)入历史,然后逐个执行
    // content 为 null 而非空字符串:部分 provider 拒绝空字符串内容(2013 错误)
    state.messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls })

    // LLM 耗时在进入工具执行前打印(仅本轮有工具调用时显示)
    if (llmDuration > 0) {
      printDim(`  ⏱ LLM ${formatDuration(llmDuration)}`)
    }

    for (const tc of toolCalls) {
      const name = tc.function?.name || ''
      const rawArgs = tc.function?.arguments || ''

      let args
      try {
        args = rawArgs ? JSON.parse(rawArgs) : {}
      } catch {
        printToolHeader(name, printDimInline(rawArgs))
        const errResult = `错误: 工具参数不是合法 JSON: ${rawArgs.slice(0, 200)}`
        printToolResult(errResult)
        state.messages.push({ role: 'tool', tool_call_id: tc.id || name, name, content: errResult })
        continue
      }

      printToolHeader(name, summarizeToolArgs(name, args, { chars: t.chars }))
      // 长命令执行期间给个 spinner,让用户知道没有卡死
      const toolSpinner = startSpinner(t.toolRunning(name))
      const toolStart = performance.now()
      const output = await executeTool(name, args, state.ctx)
      const toolDuration = performance.now() - toolStart
      toolSpinner.stop()
      printToolResult(output, undefined, toolDuration)
      state.messages.push({ role: 'tool', tool_call_id: tc.id || name, name, content: output })
    }
    // 工具结果全部入历史后继续循环,让模型基于结果决定下一步
  }

  printWarn(t.toolIterLimit(MAX_TOOL_ITERATIONS))
}

// JSON 解析失败时的参数回显:单行截断,不进 summarizeToolArgs(它没有结构化参数可用)
function printDimInline(rawArgs) {
  let preview = String(rawArgs || '').replace(/\s+/g, ' ').trim()
  if (preview.length > 160) preview = preview.slice(0, 160) + '…'
  return preview
}

// ──────────────────────────────────────────────
// 斜杠命令
// ──────────────────────────────────────────────
function printSlashHelp(t, locale) {
  const zh = !String(locale || '').startsWith('en')
  const lines = zh ? [
    '  /help             显示本帮助',
    '  /model            列出可用模型;/model <序号> 切换模型',
    '  /addmodel         添加新的模型配置(交互式向导)',
    '  /cd <路径>        切换智能体工作目录',
    '  /image [路径]     查看待发送图片;/image <路径> 附加本地图片;/image clear 清除',
    '  /think            开关思考过程显示',
    '  /new              开启新对话',
    '  /resume           选择并恢复之前的对话',
    '  /clear            清空对话历史',
    '  /exit, /quit      退出',
    '',
    '  Alt+V             粘贴剪贴板图片,随下一条消息发送(需视觉模型)',
    '',
    '权限说明: 工作目录内全部操作直接执行;其他目录可读写;',
    '仅系统级破坏命令(格式化、删根目录、关机等)会被安全守卫拦截。',
  ] : [
    '  /help             Show this help',
    '  /model            List models; /model <n> to switch',
    '  /addmodel         Add a new model (interactive wizard)',
    '  /cd <path>        Change agent working directory',
    '  /image [path]     List pending images; attach a file; /image clear to reset',
    '  /think            Toggle thinking display',
    '  /new              Start a new conversation',
    '  /resume           Choose and resume a previous conversation',
    '  /clear            Clear conversation history',
    '  /exit, /quit      Quit',
    '',
    '  Alt+V             Paste clipboard image (needs a vision-capable model)',
    '',
    'Permissions: full access in the working directory; other dirs readable/writable;',
    'only system-destroying commands (format, rm -rf /, shutdown, ...) are blocked.',
  ]
  printHelpPanel(t.helpTitle, lines)
}

async function handleSlashCommand(state, input, t) {
  const [cmd, ...rest] = input.split(/\s+/)
  const arg = rest.join(' ').trim()

  if (cmd === '/exit' || cmd === '/quit') return 'exit'
  if (cmd === '/help') { printSlashHelp(t, state.locale); return 'ok' }
  if (cmd === '/clear' || cmd === '/new') {
    state.messages = [state.messages[0]]
    // 开新会话 ID,旧会话保留在磁盘上
    state.sessionId = genSessionId()
    state.sessionCreatedAt = new Date().toISOString()
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
      state.messages = session.messages.map(message => ({ ...message }))
      const systemMessage = {
        role: 'system',
        content: buildSystemPrompt({ cwd: state.ctx.cwd, locale: state.locale, shellDesc: state.shellDesc }),
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
    state.showThinking = !state.showThinking
    printOk(state.showThinking ? t.thinkOn : t.thinkOff)
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
      // 持久化到 ~/.git-commit-tool.json 顶层 models 数组
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
      // 同步更新 system prompt 里的 cwd 说明(重建首条消息)
      state.messages[0] = { role: 'system', content: buildSystemPrompt({ cwd: target, locale: state.locale, shellDesc: state.shellDesc }) }
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

  const state = {
    // 会话持久化:CLI 对话也保存到 ~/.zen-gitsync/agent-sessions/,
    // 在 Web UI 智能体 tab 中可见(带 CLI 标记)
    sessionId: genSessionId(),
    sessionCreatedAt: new Date().toISOString(),
    messages: [{ role: 'system', content: buildSystemPrompt({ cwd, locale, shellDesc }) }],
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
    currentChild: null,
    abortController: null,
    cancelRequested: false,
    busy: false,
    showThinking: true,     // /think 切换:是否回显模型的思考过程
    pendingImages: [],      // Alt+V / /image 附加的待发送图片 [{path, bytes}]
    pasting: false,         // 剪贴板读取进行中(防 Alt+V 连打并发)
    inWizard: false,        // /addmodel 交互式向导进行中:忽略 REPL 的 line 事件
    rl: null,               // REPL readline 引用(供 /addmodel 复用做 rl.question)
  }

  // 持久化当前会话到磁盘(供 Web UI 读取)
  async function persistSession() {
    try {
      const title = autoTitle(state.messages)
      await writeSession(state.sessionId, {
        version: 1,
        sessionId: state.sessionId,
        title,
        source: 'cli',
        cwd,
        model: modelLabel(state.model),
        createdAt: state.sessionCreatedAt,
        updatedAt: new Date().toISOString(),
        messages: state.messages,
      })
      enforceRetention().catch(() => {})
    } catch (err) {
      // 持久化失败不影响 CLI 正常使用
      printDim(`(会话保存失败: ${err.message})`)
    }
  }

  // SIGINT 时中止进行中的 LLM 请求 + 正在跑的子命令
  // (进程退出与全局子进程 drain 由 gitCommit.js 的统一 handler 负责,这里只做快速止血)
  registerCleanup('aiAgent', () => {
    try { state.abortController?.abort() } catch (_) {}
    try { state.currentChild?.kill('SIGTERM') } catch (_) {}
  })

  // 单发模式:g ai "帮我改个 bug"(位置参数拼成 prompt,跑一轮就退出)
  const oneShot = argv.filter(a => !a.startsWith('-')).join(' ').trim()
  if (oneShot) {
    console.log(chalk.dim(`[${t.bannerModel}] ${modelLabel(model)} · [${t.bannerCwd}] ${cwd}`))
    await runAgentTurn(state, oneShot, t)
    await persistSession()
    printDim(t.oneShotDone)
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

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    // prompt: ❯ 用青色加粗;末尾追加 ANSI 亮白+加粗码,
    // 让用户输入的文本继承亮白色高亮(黑底上最清晰)
    prompt: chalk.cyan.bold(t.prompt) + '\x1b[1;97m',
    historySize: 200,
  })
  state.rl = rl  // 供 /addmodel 等需要 rl.question 的斜杠命令复用

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

  // readline 的 clearLine() 已经写了 \r\n,不需要我们再补换行。
  const closeInputFrame = () => {}

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
        try { state.currentChild?.kill('SIGTERM') } catch (_) {}
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
      // 每轮对话结束后持久化到磁盘,供 Web UI 读取
      await persistSession()
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

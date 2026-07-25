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
//   - { type: 'tool_call_start', toolCallId, name, argsPreview }
//   - { type: 'tool_result', toolCallId, name, result }
//   - { type: 'done', content }            — 本轮最终完成
//   - { type: 'error', error }

import path from 'path';
import os from 'os';
import { logger } from './shared.js';
import { agentSessionStore } from './agentSessionStore.js';

// 从 CLI 侧导入工具定义与执行器（同一 monorepo，路径可达）
import { TOOL_DEFINITIONS, executeTool } from '../../../../cli/ai/tools.js';
import { checkDangerousCommand } from '../../../../cli/ai/safety.js';
import { guardCommand } from '../../../../cli/ai/platformGuard.js';

const MAX_TOOL_ITERATIONS = 40;
const LLM_TIMEOUT_MS = 300000; // 5 分钟

// ── 系统提示词构建 ──────────────────────────────────────────
// 与 CLI agent.js 的 buildSystemPrompt 保持一致，但标注来源为 Web 端
function buildWebSystemPrompt({ cwd, locale }) {
  const zh = !String(locale || '').startsWith('en');
  const now = new Date().toLocaleString();
  const isWin = process.platform === 'win32';
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

# 与用户交互
- 需要向用户确认、提问或汇报重要决策时,直接用普通文本输出
- 不要调用不存在的工具,可用工具只有上面列出的 6 个
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

# Permissions (explicitly granted by the user)
- Inside the working directory: read/write files and run commands directly
- Other directories: may also be read and modified
- Single red line: never destroy the system. A safety guard blocks such commands.

# How you work
- Act first, ask later: use tools to investigate before asking the user
- After modifying code, verify: run tests, build, or at least syntax check
- Prefer edit_file for precise replacements; read_file first to confirm original text
- Use offset/limit for large files
- git operations via run_command
- run_command defaults to the working directory; default timeout 120s, max 600s

# Output
- Your text output is displayed in the user's Web UI
- After completing a task, briefly summarize the result`;
}

// ── LLM 流式调用(OpenAI 兼容 + function calling) ──────────
// 返回 { content, toolCalls, aborted }
async function streamChatOnce({ model, messages, signal, onToken }) {
  const url = `${String(model.baseURL || '').replace(/\/$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (model.apiKey) headers['Authorization'] = `Bearer ${model.apiKey}`;

  const body = JSON.stringify({
    model: model.model,
    messages,
    tools: TOOL_DEFINITIONS,
    temperature: 0.3,
    stream: true,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort);
  }

  let content = '';
  const toolCalls = [];
  let aborted = false;

  try {
    const resp = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => '');
      const snippet = errText.length > 300 ? errText.slice(0, 300) + '…' : errText;
      if (resp.status === 400 && /tool|function/i.test(snippet)) {
        throw new Error(`HTTP 400: 当前模型可能不支持 function calling(${snippet})。请在设置中换用支持工具调用的模型。`);
      }
      throw new Error(`HTTP ${resp.status}: ${snippet || resp.statusText}`);
    }

    const decoder = new TextDecoder('utf-8');
    let buf = '';
    for await (const chunk of resp.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(payload); } catch { continue; }
        const delta = evt.choices?.[0]?.delta || {};

        const thinkingChunk = delta.reasoning_content || delta.reasoning || delta.reasoning_text || '';
        if (thinkingChunk) onToken({ thinking: thinkingChunk });

        if (delta.content) {
          content += delta.content;
          onToken({ content: delta.content });
        }

        for (const tc of delta.tool_calls || []) {
          const i = tc.index ?? 0;
          if (!toolCalls[i]) toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) toolCalls[i].id += tc.id;
          if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
        }
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError' || controller.signal.aborted) {
      aborted = true;
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
  return { content, toolCalls: toolCalls.filter(Boolean), aborted };
}

// ── 消息消毒 ──────────────────────────────────────────────
// 目的:确保发往 LLM provider 的 messages 数组里没有"空内容"或
// "看似有内容但全是空白"的字段。
//
// 背景:部分 LLM provider(Moonshot/Kimi、智谱、火山引擎、MiniMax 等)
// 对 assistant 历史消息 content 校验严格 —— 当某轮 assistant 只返回
// tool_calls 而没有文本、或正文被 trim 后只剩空白时,provider 会拒绝
// 并报 "chat content is empty (2013)"。OpenAI 官方规范允许 assistant
// 消息在带 tool_calls 时 content 为 null,但 provider 实现不一致:
//
//   - assistant 带 tool_calls → content 强制 null(即使有字符串)
//   - assistant 不带 tool_calls 且 content 全空白 → null(避免触发 2013)
//   - user content 全空白 → 用单个空格 ' ' 占位(provider 通常可接受)
//   - tool content 全空白 → '(no output)' 占位(防止序列化时被丢)
function sanitizeMessages(messages) {
  for (const m of messages) {
    if (m == null || typeof m !== 'object') continue;
    // 非字符串 content(数组形态的多模态 user 消息、已是 null 等) 不动
    if (m.content === null || m.content === undefined) {
      // assistant 必须显式 null,不要让 provider 看到 undefined
      if (m.role === 'assistant') m.content = null;
      continue;
    }
    if (typeof m.content !== 'string') continue;
    const trimmed = m.content.trim();
    if (trimmed === '') {
      if (m.role === 'assistant') {
        // 带 tool_calls 时强制 null;否则也置 null(provider 更安全)
        m.content = null;
      } else if (m.role === 'tool') {
        m.content = '(no output)';
      } else if (m.role === 'user') {
        // user 不能 null(部分 provider 拒),用单个空格占位
        m.content = ' ';
      }
      continue;
    }
    // assistant 带 tool_calls:即使是有效正文也强制 null
    // (OpenAI 规范要求 tool_calls 出现时 content=null,避免 provider 误判)
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      m.content = null;
    }
  }
  return messages;
}

// ── 历史裁剪 ──────────────────────────────────────────────
// 保留 system + 最近 MAX_HISTORY_MESSAGES 条
// 切口必须落在 user 消息上,避免把 assistant(tool_calls) 与其 tool 结果从中间撕开
const MAX_HISTORY_MESSAGES = 40;
function trimHistory(messages) {
  if (messages.length <= MAX_HISTORY_MESSAGES + 1) return;
  let cut = messages.length - MAX_HISTORY_MESSAGES;
  // 至少向后扫 5 条,跳过孤立的 tool / assistant(tool_calls),
  // 找到真正的 user 节点再切,防止撕裂 tool 调用链
  let safety = 0;
  while (cut < messages.length && messages[cut].role !== 'user' && safety < 8) {
    cut++;
    safety++;
  }
  if (cut <= 1 || messages[cut]?.role !== 'user') return;
  messages.splice(1, cut - 1);
}

// ── 多模态历史:旧图片降级为文字 ──────────────────────────
function stripStaleImages(messages) {
  const placeholder = '[图片已从历史中省略]';
  let seenLatest = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user' || !Array.isArray(m.content)) continue;
    const hasImage = m.content.some(p => p?.type === 'image_url');
    if (!hasImage) continue;
    if (!seenLatest) { seenLatest = true; continue; }
    m.content = m.content.map(p => p?.type === 'image_url'
      ? { type: 'text', text: placeholder }
      : p);
  }
}

// ── 核心入口：运行一轮 agent 对话 ────────────────────────
//
// 参数:
//   { session, model, userMessage, cwd, locale, signal, send, onChild }
//   - session: 从 agentSessionStore 读取的会话对象
//   - model: { baseURL, model, apiKey }
//   - userMessage: 用户输入文本
//   - cwd: 工作目录
//   - locale: 'zh' | 'en'
//   - signal: AbortSignal (客户端断开时触发)
//   - send: (obj) => void  SSE 发送函数
//   - onChild: (child) => void  子进程回调(用于取消)
//
// 返回: { aborted: boolean }
export async function runAgentTurn({ session, model, userMessage, cwd, locale, signal, send, onChild }) {
  const ctx = { cwd, locale, onChild };

  // 确保 session.messages 存在
  if (!Array.isArray(session.messages)) session.messages = [];

  // 首轮：注入 system prompt
  if (session.messages.length === 0) {
    session.messages.push({
      role: 'system',
      content: buildWebSystemPrompt({ cwd, locale })
    });
  }

  // 追加 user 消息
  session.messages.push({ role: 'user', content: userMessage });

  // 旧图片降级
  stripStaleImages(session.messages);

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    trimHistory(session.messages);
    sanitizeMessages(session.messages);

    let result;
    try {
      result = await streamChatOnce({
        model,
        messages: session.messages,
        signal,
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

    if (result.aborted) {
      // 保存当前会话状态
      session.updatedAt = new Date().toISOString();
      await agentSessionStore.write(session.sessionId, session).catch(() => {});
      send({ type: 'error', error: '已取消' });
      return { aborted: true };
    }

    const { content, toolCalls } = result;

    // 无工具调用：本轮结束
    if (toolCalls.length === 0) {
      session.messages.push({ role: 'assistant', content: content || null });
      send({ type: 'done', content: content || '' });
      return { aborted: false };
    }

    // 有工具调用：assistant(带 tool_calls)入历史
    session.messages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls
    });

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
      send({ type: 'tool_call_start', toolCallId, name, argsPreview });

      const output = await executeTool(name, args, ctx);
      send({ type: 'tool_result', toolCallId, name, result: output });
      session.messages.push({ role: 'tool', tool_call_id: toolCallId, name, content: output });
    }
    // 工具结果全部入历史后继续循环，让模型基于结果决定下一步
  }

  // 达到最大迭代次数
  send({ type: 'done', content: `已达单轮最大工具调用次数(${MAX_TOOL_ITERATIONS})，本轮结束。如需继续请再发一条消息。` });
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
      default:
        return JSON.stringify(args).slice(0, 200);
    }
  } catch {
    return '';
  }
}

export { buildWebSystemPrompt };

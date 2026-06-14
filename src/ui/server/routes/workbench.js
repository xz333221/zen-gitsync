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
// 工作台后端：管理预置提示词 / 任务 / 子任务，
// 并以 bypassPermissions 模式依次 spawn claude CLI 执行子任务（每次新窗口）。
// 数据存到用户主目录 ~/.zen-gitsync/，跨项目共享。

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawn, execFileSync, execFile } from 'child_process';
import { EventEmitter } from 'events';
import express from 'express';

const DATA_DIR = path.join(os.homedir(), '.zen-gitsync');
const PROMPTS_FILE = path.join(DATA_DIR, 'prompts.json');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const IMAGES_DIR = path.join(DATA_DIR, 'workbench-images');
const INSTRUCTION_FILE = path.join(DATA_DIR, 'ai-instruction.json');
const SUBTASK_INSTRUCTION_FILE = path.join(DATA_DIR, 'ai-subtask-instruction.json');
// 执行日志持久化：jobs.json 是历史档案，jobs-config.json 是保留策略。
// jobs Map 仍只承载当前进程产出的活跃 job；管理页直接读 jobs.json。
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const JOBS_CONFIG_FILE = path.join(DATA_DIR, 'jobs-config.json');
// 流式 chunk 写盘会撑爆 IO；用 1.5s debounce 把高频写入折叠成一次。
// 终态时由 flushJobsSaveNow() 强制立即落盘。
const JOBS_SAVE_DEBOUNCE_MS = 1500;
let jobsSaveTimer = null;
const DEFAULT_JOBS_CONFIG = { maxCount: 500, maxSizeMB: 256 };

// 子项目识别 / 文件扫描时需要跳过的目录
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', '.next', '.nuxt', '__pycache__',
  'target', 'out', 'coverage', 'vendor', '.git', '.svn', '.hg',
  '.idea', '.vscode', '.gradle', '.terraform', '.cache', '.parcel-cache',
  '.turbo', '.svelte-kit', 'storybook-static'
]);

// 默认生成指令：用户首次使用时作为可编辑指令的初始值
const DEFAULT_INSTRUCTION = `你是一名资深软件架构师。

【探索步骤】
1. 先识别项目结构：扫描根目录是否包含 .git 目录，以及 package.json / pyproject.toml / go.mod / Cargo.toml / pom.xml / build.gradle{,.kts} / composer.json / Gemfile / pubspec.yaml 这 9 种 manifest。
2. 如果根目录含 manifest，就把整个根目录视为一个子项目。
3. 如果根目录不含 manifest、但子目录（含一层 .git 或上述 manifest）形成多个子项目，对每个子项目分别探索。
4. 对每个子项目，重点读取：
   - 所有识别到的 manifest（限制单文件 20KB）
   - README.md（限制 8KB）
   - 入口文件：package.json 的 main / scripts / workspaces 字段；pyproject.toml 的 [project.scripts]；go.mod 的 module；Cargo.toml 的 [[bin]]；pom.xml 的 <modules>
   - 2 层目录树（最多 200 行）

【输出要求】
1. 给出一段 400-800 字的中文「项目架构说明」，覆盖：项目整体定位、技术栈、模块划分、核心流程、关键设计决策。
2. 必须引用子项目里实际存在的文件路径、目录名、依赖名，不要编造。
3. 多个子项目时：先逐个说明，最后输出一段「整体架构」总结它们之间的关系。
4. 语气专业、具体、面向接手这个项目的开发者。
5. 只返回 JSON：{ "name": "项目名（10-20字）", "summary": "架构说明正文" }。`;

// 单个附件最大 5MB；与 Anthropic Messages API 文档约束一致
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// 一个子任务最多挂 9 个附件
const MAX_ATTACHMENTS_PER_SUBTASK = 9;

// AI 拆分子任务：默认系统指令（用户在 GUI 可编辑覆盖）。
// 国际化：根据请求 Accept-Language 在 zh / en 之间选默认。
// 中英两份都内置——用户保存到 ~/.zen-gitsync/ai-subtask-instruction.json 后覆盖。
const DEFAULT_SUBTASK_INSTRUCTION_ZH = `你是一名任务拆分助手。

【思考过程】
在给出 JSON 之前，请先在内部仔细思考（如果模型支持，把思考放在 reasoning 中；否则可以先输出一段简短分析，再输出 JSON）：
- 任务的真实目标是什么？用户提供的描述/图片/上下文里有哪些关键信息？
- 涉及哪些技术栈、模块、文件、约束？是否有易被忽略的边界条件？
- 自然的执行顺序是什么？哪些步骤是前置依赖？哪些可以并行？
- 哪些步骤可能失败、需要单独验证？

【拆分原则】
1. 单一职责：每个子任务只做一件事，避免"做 A 和 B"。
2. 粒度适中：单个子任务应当能在一次会话里完成（既不要"实现整个登录功能"这么大，也不要"打印 hello"这么琐碎）。
3. 顺序合理：子任务按依赖关系和执行顺序排列（先准备、后实现、最后验证）。
4. 可验证：每个子任务都有明确的完成标志（"输出文件 xxx"、"通过测试 yyy"、"控制台打印 zzz"）。
5. 数量：拆成 3-6 个子任务为宜。任务很简单时 2-3 个；复杂时 5-6 个，不要超过 8 个。
6. 描述具体：desc 字段要写清楚"要做什么、参考什么、产出什么"，不要只是把 title 改写一遍。
7. 如果任务里附带了图片，必须基于图片的实际内容拆分（例如指出图片中的哪个区域、哪个元素需要改），而不是泛泛而谈。

【输出要求】
最后必须输出 JSON，结构：
{
  "subtasks": [
    { "title": "子任务标题（10-20字）", "desc": "子任务的具体描述，包含要做什么、输入是什么、输出/验证标志是什么" }
  ]
}

JSON 要用 \`\`\`json ... \`\`\` 代码块包裹，前面可以有分析文字，但 JSON 必须完整、合法、可解析。`;

const DEFAULT_SUBTASK_INSTRUCTION_EN = `You are a task breakdown assistant.

[Thinking process]
Before producing JSON, think carefully (put your thoughts in reasoning if the model supports it; otherwise output a short analysis first, then JSON):
- What is the real goal? What key information is in the description / images / context?
- Which stack, modules, files, constraints are involved? Any easily missed edge cases?
- What is the natural execution order? What blocks what? What can run in parallel?
- Which steps may fail and need separate verification?

[Breakdown principles]
1. Single responsibility: each subtask does only one thing, avoid bundling "do A and B".
2. Right granularity: a subtask should finish in one Claude session (not as big as "implement the whole login flow", not as trivial as "print hello").
3. Sensible order: arrange subtasks by dependency / execution order (prepare first, implement, then verify).
4. Verifiable: every subtask has a clear completion signal (e.g. "produce file xxx", "pass test yyy", "log zzz to console").
5. Quantity: prefer 3-6 subtasks. Very simple tasks 2-3, complex ones 5-6, never exceed 8.
6. Concrete desc: write what to do, what to reference, what to produce — don't just paraphrase the title.
7. If the task includes images, the breakdown must reference the actual image content (which region, which element to change), not just generic talk.

[Output requirements]
End with JSON, structure:
{
  "subtasks": [
    { "title": "subtask title (10-20 chars)", "desc": "concrete description: what to do, what the input is, what the output / verification signal is" }
  ]
}

Wrap the JSON in \`\`\`json ... \`\`\`. Analysis text before it is allowed, but the JSON must be complete and parseable.`;

// 兼容旧引用
const DEFAULT_SUBTASK_INSTRUCTION = DEFAULT_SUBTASK_INSTRUCTION_ZH

// 根据请求 Accept-Language 选默认（zh / en）
function pickDefaultSubtaskInstruction(req) {
  const al = String(req?.headers?.['accept-language'] || '').toLowerCase()
  if (al.startsWith('en')) return DEFAULT_SUBTASK_INSTRUCTION_EN
  return DEFAULT_SUBTASK_INSTRUCTION_ZH
}
// 白名单后缀：图片 + 常见文档（PDF / 纯文本 / Markdown）
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const DOC_EXTS = new Set(['pdf', 'txt', 'md', 'markdown', 'csv', 'json', 'log']);
const ALLOWED_EXTS = new Set([...IMAGE_EXTS, ...DOC_EXTS]);

// mime → 文件后缀；与前端 el-upload accept 对齐
const MIME_TO_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/x-markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'text/json': 'json',
  'text/x-log': 'log',
};

function sanitizeExt(name, fallback = 'bin') {
  if (typeof name !== 'string') return fallback;
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return fallback;
  return ALLOWED_EXTS.has(m[1]) ? m[1] : fallback;
}

function isImageExt(ext) {
  return IMAGE_EXTS.has(String(ext || '').toLowerCase());
}

async function ensureImagesDir() {
  await fsp.mkdir(IMAGES_DIR, { recursive: true });
}

// 把 mime 或文件名规范成统一后缀；遇到不在白名单的情况返回 null
function resolveExt({ originalName, mime }) {
  if (mime && MIME_TO_EXT[mime.toLowerCase()]) {
    return MIME_TO_EXT[mime.toLowerCase()];
  }
  const fromName = sanitizeExt(originalName, '');
  if (fromName) return fromName;
  return null;
}

// 解析 manifest 文件名（按优先级）
const MANIFEST_FILES = [
  'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json',
  'Gemfile', 'pubspec.yaml'
];

// 轻量级：仅告诉 LLM 项目的主 manifest 是什么（用于 AI 拆分时让 LLM 知道项目类型）。
// 不读内容，只 stat 存在性——拆分子任务不需要细节。
async function detectProjectManifest(projectPath) {
  if (!projectPath) return ''
  for (const f of MANIFEST_FILES) {
    try {
      const stat = await fsp.stat(path.join(projectPath, f))
      if (stat.isFile()) return f
    } catch { /* 不存在，继续 */ }
  }
  return ''
}

async function readProjectManifest(projectPath) {
  const out = {};
  for (const f of MANIFEST_FILES) {
    const p = path.join(projectPath, f);
    try {
      const stat = await fsp.stat(p);
      if (!stat.isFile()) continue;
      // 限制大小，避免巨型 pom.xml 把上下文打爆
      const content = stat.size > 20000
        ? (await safeReadFile(p, 20000))
        : (await fsp.readFile(p, 'utf8'));
      out[f] = content;
    } catch { /* 不存在就跳过 */ }
  }
  return out;
}

async function safeReadFile(filePath, maxBytes = 200000) {
  try {
    const stat = await fsp.stat(filePath);
    if (stat.size > maxBytes) {
      const buf = Buffer.alloc(maxBytes);
      const fd = await fsp.open(filePath, 'r');
      await fd.read(buf, 0, maxBytes, 0);
      await fd.close();
      return buf.toString('utf8').slice(0, maxBytes);
    }
    return await fsp.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function listDirTree(projectPath, maxDepth = 2, maxEntries = 400) {
  const lines = [];
  async function walk(dir, depth) {
    if (depth > maxDepth || lines.length >= maxEntries) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    const filtered = entries.filter(e => {
      if (e.name.startsWith('.')) return false;
      if (['node_modules', 'dist', 'build', '.next', '.nuxt', '__pycache__', 'target', 'out', 'coverage', 'vendor'].includes(e.name)) return false;
      return true;
    });
    const indent = '  '.repeat(depth);
    for (const e of filtered) {
      if (lines.length >= maxEntries) return;
      if (e.isDirectory()) {
        lines.push(`${indent}${e.name}/`);
        await walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        lines.push(`${indent}${e.name}`);
      }
    }
  }
  await walk(projectPath, 0);
  return lines.join('\n');
}

async function callLlmJson(model, prompt, opts = {}) {
  const { maxTokens = 1500, timeoutMs = 60000, images = [] } = opts;
  const { default: fetch } = await import('node-fetch').catch(() => ({ default: globalThis.fetch }));
  const url = `${String(model.baseURL || '').replace(/\/$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (model.apiKey) headers['Authorization'] = `Bearer ${model.apiKey}`;

  // 有图片时改用 OpenAI multimodal content 数组（text + image_url）。
  // 非多模态模型遇到 image_url 会忽略图片块，相当于退化成纯文本，不会报错。
  let userContent;
  if (Array.isArray(images) && images.length > 0) {
    userContent = [
      { type: 'text', text: prompt },
      ...images.map(img => ({ type: 'image_url', image_url: { url: img } }))
    ];
  } else {
    userContent = prompt;
  }

  const body = JSON.stringify({
    model: model.model,
    messages: [{ role: 'user', content: userContent }],
    max_tokens: maxTokens,
    temperature: 0.4,
    response_format: { type: 'json_object' },
    stream: false,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data?.error?.message || `HTTP ${resp.status}`);
    const content = data?.choices?.[0]?.message?.content || '{}';
    try {
      const m = content.match(/```json\s*([\s\S]*?)```/) || content.match(/({[\s\S]*})/);
      return JSON.parse(m ? m[1] : content);
    } catch {
      return {};
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 流式调用 OpenAI 兼容 LLM。每收到一个 chunk 调 onDelta 回调。
 * onDelta 接收 { thinking?: string, content?: string }，二选一。
 *   - reasoning_content / reasoning：部分模型（如 deepseek）放在 delta.reasoning_content
 *   - reasoning / reasoning_text：openai o1 风格
 *   - content：普通输出
 * 返回完整 content 字符串。
 */
async function callLlmStream(model, prompt, onDelta, opts = {}) {
  const { maxTokens = 2000, timeoutMs = 600000, signal, images = [] } = opts
  const { default: fetch } = await import('node-fetch').catch(() => ({ default: globalThis.fetch }))
  const url = `${String(model.baseURL || '').replace(/\/$/, '')}/chat/completions`
  const headers = { 'Content-Type': 'application/json' }
  if (model.apiKey) headers['Authorization'] = `Bearer ${model.apiKey}`

  let userContent
  if (Array.isArray(images) && images.length > 0) {
    userContent = [
      { type: 'text', text: prompt },
      ...images.map(img => ({ type: 'image_url', image_url: { url: img } }))
    ]
  } else {
    userContent = prompt
  }

  const body = JSON.stringify({
    model: model.model,
    messages: [{ role: 'user', content: userContent }],
    max_tokens: maxTokens,
    temperature: 0.4,
    // 注意：stream: true 模式下不能同时使用 response_format:{type:'json_object'}，
    // 部分 provider 会在收到两个一起时报错/静默卡住。改在 prompt 里约束 JSON 输出即可。
    stream: true,
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // 允许外部 signal 触发取消（用户在 GUI 点停止）
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort)
  }

  let fullContent = ''
  let aborted = false
  try {
    const resp = await fetch(url, { method: 'POST', headers, body, signal: controller.signal })
    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => '')
      throw new Error(errText || `HTTP ${resp.status}`)
    }

    // SSE 格式：每行 "data: {...}"，最后 "data: [DONE]"
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
        try {
          const evt = JSON.parse(payload)
          const delta = evt.choices?.[0]?.delta || {}
          // thinking 在不同 provider 字段名不同，全部尝试
          const thinkingChunk = delta.reasoning_content
            || delta.reasoning
            || delta.reasoning_text
            || ''
          const contentChunk = delta.content || ''
          if (thinkingChunk) onDelta({ thinking: thinkingChunk })
          if (contentChunk) {
            fullContent += contentChunk
            onDelta({ content: contentChunk })
          }
        } catch { /* 跳过无法解析的行 */ }
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError' || controller.signal.aborted) {
      aborted = true
      // 中断不算错误——上层会决定怎么处理
    } else {
      throw err
    }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
  return { content: fullContent, aborted }
}

// AI 拆分子任务 JSON 多级降级解析。
// 模型经常会犯几类格式错：在 desc 里用 ASCII 双引号引用术语 / 末尾留尾随逗号 /
// 输出被 token 上限截断导致代码块未闭合。直接 JSON.parse 一旦失败就会让前端的
// "确认入库" 按钮永远是 (0)，用户看不到原因。这里按"越简单越优先"的顺序尝试：
//   ① ```json``` 代码块 / ```any``` 代码块 / 第一个完整 { ... } 范围
//   ② 把候选片段去掉尾随逗号 + 块/行注释 再 parse
//   ③ 用括号深度扫描，从开头找一个语法平衡的 { ... } 子串
//   ④ 启发式转义模型夹在字符串内部的未转义 ASCII 双引号
//      （这是实战里最常见的失败：模型用 ASCII " 引用"和书籍对话"这种术语，
//       直接打断外层 JSON。本级在字符串中遇到 " 时往后看一个非空白字符，
//       不是 ,}]: 就把它当作字面量，转义成 \"。）
// 任一步成功就返回 parsed，全部失败时返回最后一次 JSON.parse 的错误，
// 用 parseStage 告知前端"模型输出哪一步崩了"，并把原始 raw 一并回传。
function parseSubtaskJson(content) {
  const src = String(content || '');
  if (!src.trim()) {
    return { parsed: null, parseError: '模型未返回任何内容', parseStage: 'empty' };
  }

  const candidates = [];
  const fenced = src.match(/```json\s*([\s\S]*?)```/i) || src.match(/```\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  const bracePair = src.match(/\{[\s\S]*\}/);
  if (bracePair) candidates.push(bracePair[0]);
  // 兜底：整段当 JSON 试
  candidates.push(src);

  let lastErr = null;
  for (const raw of candidates) {
    const txt = String(raw || '').trim();
    if (!txt) continue;
    // ① 直 parse
    try { return { parsed: JSON.parse(txt), parseError: '', parseStage: '' }; }
    catch (e) { lastErr = e; }
    // ② 清洗：去 //…/* */ 注释 + 尾随逗号
    const cleaned = txt
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:"'\\])\/\/[^\n]*/g, '$1')
      .replace(/,(\s*[}\]])/g, '$1');
    try { return { parsed: JSON.parse(cleaned), parseError: '', parseStage: 'cleaned' }; }
    catch (e) { lastErr = e; }
    // ③ 平衡花括号扫描
    const balanced = extractBalancedJson(cleaned);
    if (balanced && balanced !== cleaned) {
      try { return { parsed: JSON.parse(balanced), parseError: '', parseStage: 'balanced' }; }
      catch (e) { lastErr = e; }
    }
    // ④ 启发式转义字符串内的未转义双引号
    const base = balanced || cleaned;
    const reescaped = reescapeUnescapedQuotes(base);
    if (reescaped && reescaped !== base) {
      try { return { parsed: JSON.parse(reescaped), parseError: '', parseStage: 'reescaped' }; }
      catch (e) { lastErr = e; }
    }
  }

  return {
    parsed: null,
    parseError: lastErr ? (lastErr.message || String(lastErr)) : '未能从模型输出中提取出 JSON',
    parseStage: 'failed'
  };
}

// 从字符串中提取首个语法平衡的 { ... } 子串。
// 跟踪字符串字面量（含转义），避免把 desc 里的 } 当成结束。
function extractBalancedJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return '';
  let depth = 0;
  let inStr = false;
  let strCh = '';
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === strCh) { inStr = false; }
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return '';
}

// ④ 级降级：把字符串字面量内部出现的、未转义的 ASCII 双引号自动转义。
// 实战中模型最常见的错误是 "desc": "...用户点击"保存"按钮..." 这种—
// 中间的 "保存" 把外层字符串截断成两段，后面变成裸文本，JSON.parse 必崩。
//
// 启发式判断：扫描时若处于字符串中且遇到 "，往后看第一个非空白字符：
//   - 是 , } ] : 或文本结尾 → 这是真闭合，正常退出字符串
//   - 否则 → 是模型乱写的字面量引号，改写为 \" 并继续留在字符串里
// 不依赖正则、不破坏已经转义的 \"，对嵌套 / 多行字符串都安全。
function reescapeUnescapedQuotes(text) {
  const s = String(text || '');
  if (!s) return '';
  const out = [];
  let inStr = false;
  let strCh = '';
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inStr) {
      out.push(c);
      if (c === '"' || c === "'") { inStr = true; strCh = c; }
      continue;
    }
    // 字符串内部
    if (esc) { out.push(c); esc = false; continue; }
    if (c === '\\') { out.push(c); esc = true; continue; }
    if (c !== strCh) { out.push(c); continue; }
    // 遇到与开闭引号相同的字符——往后看下一个非空白
    let j = i + 1;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
    const next = j < s.length ? s[j] : '';
    if (next === '' || next === ',' || next === '}' || next === ']'
        || next === ':' || next === '\n' || next === '\r') {
      // 真闭合
      out.push(c);
      inStr = false;
      strCh = '';
    } else {
      // 字面量裸引号——转义
      out.push('\\', c);
    }
  }
  return out.join('');
}

function nowIso() {
  return new Date().toISOString();
}

function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function ensureDataDir() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    const buf = await fsp.readFile(file, 'utf-8');
    return JSON.parse(buf);
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(file, data) {
  await ensureDataDir();
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fsp.rename(tmp, file);
}

// ── 执行日志持久化 ────────────────────────────────────────────
// 设计要点：
//   - 写盘在流式 chunk 阶段走 1.5s debounce；终态时（finally / cancel）强制 flush。
//   - 永不持久化 child 引用（参考 cancel 路由的浅拷贝模式）。
//   - hydrate 时把 running/pending 降级为 error：原 child 进程已不存在。
//   - enforceRetention 在每次落盘后跑，按 endedAt desc FIFO 裁剪。

function serializeJob(j, taskMap) {
  // child 是 ChildProcess 引用，序列化会爆；剥离后 size 用三字段累加预计算
  const { child, ...rest } = j
  const t = taskMap ? taskMap.get(rest.taskId) : null
  const sub = t && Array.isArray(t.subtasks) ? t.subtasks.find(s => s.id === rest.subId) : null
  const size = ((rest.prompt || '').length
    + (rest.output || '').length
    + (rest.thinking || '').length)
  return {
    ...rest,
    taskTitle: t ? t.title : '',
    subTitle: sub ? sub.title : '',
    size
  }
}

function scheduleJobsSave() {
  if (jobsSaveTimer) clearTimeout(jobsSaveTimer)
  jobsSaveTimer = setTimeout(() => {
    jobsSaveTimer = null
    flushJobsSaveNow().catch(err => console.warn('[workbench] jobs save failed:', err.message))
  }, JOBS_SAVE_DEBOUNCE_MS)
}

async function flushJobsSaveNow() {
  if (jobsSaveTimer) { clearTimeout(jobsSaveTimer); jobsSaveTimer = null }
  // 读 tasks.json 给落盘 job 反范式 taskTitle/subTitle——父任务被删后管理页仍可读
  const tasksData = await readJson(TASKS_FILE, { tasks: [] })
  const taskMap = new Map((tasksData.tasks || []).map(t => [t.id, t]))
  const payload = {
    version: 1,
    jobs: Array.from(jobs.values()).map(j => serializeJob(j, taskMap))
  }
  await writeJson(JOBS_FILE, payload)
  await enforceRetention()
}

async function readJobsConfig() {
  const cfg = await readJson(JOBS_CONFIG_FILE, null)
  if (!cfg || typeof cfg !== 'object') return { ...DEFAULT_JOBS_CONFIG }
  return {
    maxCount: Number.isFinite(cfg.maxCount) ? Math.max(0, Math.floor(cfg.maxCount)) : DEFAULT_JOBS_CONFIG.maxCount,
    maxSizeMB: Number.isFinite(cfg.maxSizeMB) ? Math.max(0, Math.floor(cfg.maxSizeMB)) : DEFAULT_JOBS_CONFIG.maxSizeMB
  }
}

async function writeJobsConfig(cfg) {
  // 校验：非负整数；硬上限防误填爆盘
  const out = {}
  if (cfg.maxCount !== undefined) {
    const n = Math.floor(Number(cfg.maxCount))
    if (!Number.isFinite(n) || n < 0 || n > 10000) throw new Error('maxCount 必须在 0-10000 之间')
    out.maxCount = n
  }
  if (cfg.maxSizeMB !== undefined) {
    const n = Math.floor(Number(cfg.maxSizeMB))
    if (!Number.isFinite(n) || n < 0 || n > 10240) throw new Error('maxSizeMB 必须在 0-10240 之间')
    out.maxSizeMB = n
  }
  const merged = { ...(await readJobsConfig()), ...out }
  await writeJson(JOBS_CONFIG_FILE, merged)
  return merged
}

// 进程启动时把磁盘上的历史拉回内存 Map；陈旧的 running/pending 强制降级。
// 陈旧 job 的 child 进程已退出，标记为 error 方便用户识别。
async function hydrateJobs() {
  let data
  try {
    data = await readJson(JOBS_FILE, null)
  } catch (err) {
    // 损坏文件：改名备份避免下次 flush 静默覆盖用户数据
    console.warn('[workbench] jobs.json 解析失败，备份原文件后重置:', err.message)
    try { await fsp.rename(JOBS_FILE, `${JOBS_FILE}.bak-${Date.now()}`) } catch { /* 文件可能已不在 */ }
    return
  }
  if (!data || !Array.isArray(data.jobs)) return
  for (const j of data.jobs) {
    if (j.status === 'running' || j.status === 'pending') {
      j.status = 'error'
      j.error = (j.error || '') + ' [重启后回收：原进程已退出]'
      j.endedAt = j.endedAt || nowIso()
      j.exitCode = typeof j.exitCode === 'number' ? j.exitCode : 1
    }
    // 旧版本可能没 size 字段；补齐以兼容历史文件
    if (typeof j.size !== 'number') {
      j.size = ((j.prompt || '').length + (j.output || '').length + (j.thinking || '').length)
    }
    jobs.set(j.id, j)
  }
  // 启动后也跑一遍保留策略，让历史文件立刻缩到当前配置
  try { await enforceRetention() } catch (err) { console.warn('[workbench] 启动时 enforceRetention 失败:', err.message) }
}

// 保留策略：按 endedAt desc（fallback startedAt / id）排序，先按 maxCount 截，
// 再按 maxSizeMB 累计裁，淘汰同步从内存 Map 删除。
async function enforceRetention() {
  const cfg = await readJobsConfig()
  const data = await readJson(JOBS_FILE, { version: 1, jobs: [] })
  if (!data || !Array.isArray(data.jobs) || data.jobs.length === 0) return
  const sortKey = (j) => j.endedAt || j.startedAt || j.id || ''
  data.jobs.sort((a, b) => sortKey(b).localeCompare(sortKey(a)))
  if (cfg.maxCount > 0) data.jobs = data.jobs.slice(0, cfg.maxCount)
  if (cfg.maxSizeMB > 0) {
    const cap = cfg.maxSizeMB * 1024 * 1024
    let total = data.jobs.reduce((s, j) => s + (j.size || 0), 0)
    while (total > cap && data.jobs.length > 1) {
      const dropped = data.jobs.pop()
      total -= (dropped && dropped.size) || 0
    }
  }
  await writeJson(JOBS_FILE, data)
  const keepIds = new Set(data.jobs.map(j => j.id))
  for (const id of Array.from(jobs.keys())) {
    if (!keepIds.has(id)) jobs.delete(id)
  }
}

// 简单的 Mustache 风格变量插值：{{task.title}} / {{task.desc}} / {{repo.path}} / {{branch}}
function interpolate(template, ctx) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const parts = key.split('.');
    let cur = ctx;
    for (const p of parts) {
      if (cur == null) return '';
      cur = cur[p];
    }
    return cur == null ? '' : String(cur);
  });
}

// ── 进程表：记录每个子任务的运行状态 ──────────────────────────────────────
const bus = new EventEmitter();
const jobs = new Map(); // jobId -> { id, taskId, subId, status, pid, startedAt, endedAt, exitCode, error, prompt }
// 被用户主动取消的 jobId 集合——runTaskQueue 在 waitProcessExit 之后检查这个集合
// 来决定把 job 标为 'cancelled' 还是 'done'。
// 用 Set 而不是 job.cancelled 标志，是为了在 SIGTERM 发出后到 child 真正退出之间
// 有一个简洁的"待回收"窗口。
const cancelledJobs = new Set();
// 启动时从磁盘拉回历史 job（陈旧 running/pending 自动降级 error）
hydrateJobs().catch(err => console.warn('[workbench] hydrate jobs failed:', err.message))

// ── 生成指令持久化（~/.zen-gitsync/ai-instruction.json） ────────────────────
async function readInstruction() {
  try {
    const buf = await fsp.readFile(INSTRUCTION_FILE, 'utf-8');
    const obj = JSON.parse(buf);
    if (obj && typeof obj.instruction === 'string' && obj.instruction.trim()) {
      return obj.instruction;
    }
  } catch { /* 文件不存在或解析失败 */ }
  return DEFAULT_INSTRUCTION;
}

async function writeInstruction(instruction) {
  await ensureDataDir();
  const text = String(instruction || '').trim() || DEFAULT_INSTRUCTION;
  const tmp = `${INSTRUCTION_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ instruction: text, updatedAt: nowIso() }, null, 2), 'utf-8');
  await fsp.rename(tmp, INSTRUCTION_FILE);
}

// AI 拆分子任务的指令：与生成项目架构说明的指令分开持久化，
// 因为它面向的输出形态（subtask 列表）和任务粒度完全不同。
// 支持传入 req：根据 Accept-Language 选默认（zh/en）
async function readSubtaskInstruction(req) {
  try {
    const buf = await fsp.readFile(SUBTASK_INSTRUCTION_FILE, 'utf-8');
    const obj = JSON.parse(buf);
    if (obj && typeof obj.instruction === 'string' && obj.instruction.trim()) {
      return obj.instruction;
    }
  } catch { /* 文件不存在或解析失败 */ }
  return pickDefaultSubtaskInstruction(req);
}
async function writeSubtaskInstruction(instruction) {
  await ensureDataDir();
  // 写入时如果与当前 locale 默认一致，不写文件——这样前端"isDefault"判定永远准确
  const text = String(instruction || '').trim() || DEFAULT_SUBTASK_INSTRUCTION_ZH;
  const tmp = `${SUBTASK_INSTRUCTION_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ instruction: text, updatedAt: nowIso() }, null, 2), 'utf-8');
  await fsp.rename(tmp, SUBTASK_INSTRUCTION_FILE);
}

// ── 子项目识别：递归找 .git / manifest；A 是 B 的祖先时只保留 B ─────────────
async function findSubProjects(projectPath, opts = {}) {
  const { maxDepth = 4 } = opts;
  const candidates = [];

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }

    let hasManifest = false;
    let hasGit = false;
    const subDirs = [];
    for (const e of entries) {
      if (!e.isDirectory() && !e.isFile()) continue;
      if (e.name.startsWith('.')) {
        if (e.name === '.git' && e.isDirectory()) hasGit = true;
        continue;
      }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        subDirs.push(path.join(dir, e.name));
      } else if (e.isFile() && MANIFEST_FILES.includes(e.name)) {
        hasManifest = true;
      }
    }
    if (hasManifest || hasGit) {
      candidates.push(dir);
      return; // 子目录里若还有 manifest，会被自己发现；这里不再下钻避免冗余
    }
    if (depth >= maxDepth) return;
    for (const sub of subDirs) {
      await walk(sub, depth + 1);
    }
  }

  await walk(projectPath, 0);

  // 去重：若 candidates 里 A 是 B 的祖先，只保留更深一级的 B
  candidates.sort((a, b) => a.length - b.length);
  const kept = [];
  for (const c of candidates) {
    let dominated = false;
    for (const k of kept) {
      if (c === k || c.startsWith(k + path.sep)) { dominated = true; break; }
    }
    if (!dominated) kept.push(c);
  }

  // 收集每个子项目的关键文件
  const result = [];
  for (const root of kept) {
    const manifests = {};
    for (const m of MANIFEST_FILES) {
      const p = path.join(root, m);
      try {
        const stat = await fsp.stat(p);
        if (stat.isFile()) {
          manifests[m] = stat.size > 20000
            ? await safeReadFile(p, 20000)
            : await fsp.readFile(p, 'utf8');
        }
      } catch { /* 不存在就跳过 */ }
    }
    let readme = '';
    try {
      const stat = await fsp.stat(path.join(root, 'README.md'));
      if (stat.isFile()) readme = await safeReadFile(path.join(root, 'README.md'), 8000);
    } catch { /* 不存在就跳过 */ }
    const dirTree = await listDirTree(root, 2, 200);
    result.push({
      root,
      name: path.basename(root) || path.basename(projectPath),
      manifests,
      readme,
      dirTree
    });
  }
  return result;
}

function publish(event, payload) {
  bus.emit('event', { event, payload, ts: nowIso() });
}

function snapshotJobs() {
  return Array.from(jobs.values()).map(j => ({
    id: j.id,
    taskId: j.taskId,
    subId: j.subId,
    title: j.title,
    status: j.status,
    prompt: j.prompt || '',
    output: j.output || '',
    pid: j.pid || null,
    startedAt: j.startedAt || null,
    endedAt: j.endedAt || null,
    exitCode: typeof j.exitCode === 'number' ? j.exitCode : null,
    error: j.error || null
  }));
}

// 用 detached 进程跑 claude；进程退出时回填状态。
// 返回 { pid, child }：调用方可以监听 child.stdout/stderr 实时收集输出。
// 不再走 cmd /k 弹窗——claude -p 是非交互模式，输出通过 stdout pipe 实时回传
// 到前端面板展示。
function launchClaudeInNewWindow(cwd, promptText) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', promptText,
      '--input-format', 'text',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--dangerously-skip-permissions'
    ];
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
        const cmdShim = execFileSync('where', ['claude'], { encoding: 'utf8' })
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
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false,
        env: { ...process.env, LANG: 'zh_CN.UTF-8' }
      });
    } else {
      // macOS / Linux：直接 spawn claude（Node spawn 不走 shell，
      // prompt 中的引号 / 反斜杠无需手动 escape）
      child = spawn('claude', args, {
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, LANG: 'zh_CN.UTF-8' }
      });
    }
    child.on('error', reject);
    child.on('spawn', () => {
      // unref 让 claude 独立于父进程事件循环；返回 child 引用让调用方继续读 stdout。
      child.unref();
      resolve({ pid: child.pid, child });
    });
  });
}

// 顺序执行一个任务下所有子任务；上一个结束再启动下一个
async function runTaskQueue(task, repoPath, branch) {
  // 前序上下文：跑完一个 sub 后把它"完成态"摘要存到这里，下一个 sub 启动时
  // 拼到 prompt 头部，让 Claude 知道前面做了什么、产出了什么。
  // 故意不用 raw output 全文——LLM 已经习惯"摘要 + 关键结论"的格式，且不会
  // 一次塞几 MB 进 prompt 烧 token。truncate 到每条 MAX_PREV_OUTPUT_CHARS。
  const MAX_PREV_OUTPUT_CHARS = 2000
  const priorOutputs = []
  for (const sub of task.subtasks) {
    if (sub.status === 'done') continue;
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

    // ── 前序上下文：把前几个 done 子任务的输出摘要拼到 prompt 头部 ──
    if (priorOutputs.length > 0) {
      const prevBlock = priorOutputs.map((p, i) => {
        const text = (p.output || '').slice(0, MAX_PREV_OUTPUT_CHARS)
        const truncated = (p.output || '').length > MAX_PREV_OUTPUT_CHARS ? '\n…（前文已截断）' : ''
        return `### [${i + 1}] ${p.title}\n${text}${truncated}`
      }).join('\n\n')
      prompt = `以下是同一任务下已经完成的前序子任务输出（仅作上下文参考，请基于这些结论继续当前子任务，无需重复执行它们）：

${prevBlock}

---

${prompt}`
    }

    // ── 附件：合并 sub.attachments + task.attachments 后拼到 prompt 末尾 ──
    // claude -p 字符串模式会扫描 prompt 中出现的本地文件路径并自动
    // 识别为附件（图片 / PDF / 文本均可）。
    // 主任务附件对所有 sub 都可见；子任务自己的附件只对该 sub 可见。
    const allAttachments = [
      ...(Array.isArray(task.attachments) ? task.attachments : []),
      ...(Array.isArray(sub.attachments) ? sub.attachments : [])
    ];
    if (allAttachments.length > 0) {
      const lines = allAttachments
        .filter(a => a && a.absolutePath)
        .map((a, i) => `  ${i + 1}. [${a.mimeType || 'application/octet-stream'}] ${a.absolutePath}`);
      if (lines.length > 0) {
        prompt += `\n\n---\n本任务包含 ${lines.length} 个附件（请按文件路径读取，不要让用户重新提供）：\n${lines.join('\n')}\n---`;
      }
    }

    const jobId = genId();
    const job = {
      id: jobId,
      taskId: task.id,
      subId: sub.id,
      title: `${task.title} / ${sub.title}`,
      status: 'pending',
      prompt
    };
    jobs.set(jobId, job);
    sub.status = 'running';
    publish('sub:update', { taskId: task.id, sub });
    publish('job:update', job);

    try {
      const { pid, child } = await launchClaudeInNewWindow(repoPath || process.cwd(), prompt);
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
      // 解析失败的行原样进 output，便于排查协议异常。
      // thinking 几乎不做服务端截断：Claude reasoning 一般在 KB~几十 MB 之间，
// 100MB 兜底只是为了防止内存爆炸。流式 publish 时改推增量 delta（仅新拼接的
// 那部分），终态或重连时才随 job:update 全量同步，避免每帧重复广播整个累积文本。
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
            // output 也用 delta 推送，前端按"以 length 为锚追加"语义合并
            const delta = job.output.slice(prevLen);
            if (delta) publish('job:output-delta', { id: job.id, delta });
            continue;
          }
          let evt;
          try { evt = JSON.parse(trimmed) } catch { continue }
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
      const wasCancelled = cancelledJobs.has(jobId)
      if (wasCancelled) cancelledJobs.delete(jobId)
      // 进程退出时 stdout 可能残留最后一段未换行的 NDJSON，flush 一次
      // flush 内部也按 delta 推送，保持与流式阶段一致
      if (lineBuf.stdout.trim()) {
        const outPrev = job.output.length;
        const thinkPrev = job.thinking.length;
        try {
          const evt = JSON.parse(lineBuf.stdout.trim())
          if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
            for (const b of evt.message.content) {
              if (b.type === 'text' && typeof b.text === 'string') {
                job.output = (job.output + b.text).slice(-MAX_OUTPUT)
              } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
                job.thinking = (job.thinking + b.thinking).slice(-MAX_THINKING)
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
        // sub 不改状态——cancelled 是 job 维度，同 task 后续 sub 仍可继续执行
      } else {
        job.exitCode = 0;
        job.status = 'done';
        sub.status = 'done';
        // 把这个 sub 的输出累积到前序上下文，喂给下一个 sub
        priorOutputs.push({ title: sub.title, output: job.output || '' })
      }
    } catch (err) {
      job.error = err && err.message ? err.message : String(err);
      job.status = 'error';
      sub.status = 'error';
    } finally {
      // 移除 child 引用——避免后续被 SSE 序列化到前端
      delete job.child
      publish('job:update', job);
      publish('sub:update', { taskId: task.id, sub });
      // 终态：fire-and-forget 同步落盘，确保 done/cancelled/error 都立即归档
      flushJobsSaveNow().catch(err => console.warn('[workbench] jobs save failed:', err.message))
    }
  }
  // 写回 tasks.json
  const data = await readJson(TASKS_FILE, { tasks: [] });
  const t = data.tasks.find(x => x.id === task.id);
  if (t) {
    t.subtasks = task.subtasks;
    t.updatedAt = nowIso();
    await writeJson(TASKS_FILE, data);
    publish('task:update', t);
  }
}

function waitProcessExit(pid) {
  return new Promise(resolve => {
    let exited = false;
    const tryCheck = () => {
      if (exited) return;
      try {
        process.kill(pid, 0); // 信号 0 = 探测存活
      } catch (err) {
        // 只在进程真的消失（ESRCH / EPERM）时才 resolve；
        // 其他错误（比如参数类型）保留 polling 状态，由超时兜底。
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

export function registerWorkbenchRoutes({ app, getCurrentProjectPath, getProjectRoomId, io, configManager }) {
  // ── AI 生成提示词（基于当前项目） ─────────────────────────────────────
  app.post('/api/workbench/prompts/ai-generate', async (req, res) => {
    try {
      const projectPath = typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '';
      if (!projectPath) {
        return res.status(400).json({ success: false, error: '未选中项目' });
      }
      let stat;
      try { stat = await fsp.stat(projectPath); }
      catch { return res.status(400).json({ success: false, error: '项目路径不存在' }); }
      if (!stat.isDirectory()) {
        return res.status(400).json({ success: false, error: '项目路径不是目录' });
      }

      // 取模型
      let model;
      try {
        if (!configManager) throw new Error('configManager 不可用');
        const rawConfig = await configManager.readRawConfigFile();
        const models = Array.isArray(rawConfig.models) ? rawConfig.models : [];
        model = models.find(m => m.isDefault) || models[0];
      } catch (err) {
        return res.status(500).json({ success: false, error: '读取 AI 配置失败: ' + err.message });
      }
      if (!model) {
        return res.status(400).json({ success: false, error: '未配置 AI 模型，请先在通用设置中添加模型' });
      }

      // 读取用户可编辑的生成指令；没存就用默认
      const userInstruction = await readInstruction();

      // 递归识别多子项目
      const subProjects = await findSubProjects(projectPath);
      if (subProjects.length === 0) {
        // 没识别到任何子项目：回退到根目录本身
        const fallbackTree = await listDirTree(projectPath, 2, 400);
        const fallbackManifest = await readProjectManifest(projectPath);
        const fallbackReadme = await safeReadFile(path.join(projectPath, 'README.md'), 8000);
        subProjects.push({
          root: projectPath,
          name: path.basename(projectPath),
          manifests: fallbackManifest,
          readme: fallbackReadme,
          dirTree: fallbackTree
        });
      }

      const projectName = path.basename(projectPath);
      const LLM_OPTS = { maxTokens: 4000, timeoutMs: 1200000 };

      // ── 第一阶段：基于可编辑指令 + 根目录概览，生成「可复用的提示词模板」 ──
      const overviewBlock = subProjects.map(sp =>
        `### 子项目 ${sp.name} (${sp.root})\n目录：\n${sp.dirTree || '（无）'}`
      ).join('\n\n');

      const firstPrompt = `${userInstruction}

---

以下是你需要分析的项目（请先生成「可复用的提示词模板」，不要直接给总结）：

项目根目录：${projectPath}
项目名称：${projectName}
子项目数：${subProjects.length}

## 子项目概览
${overviewBlock || '（无）'}

## 各子项目 manifest 与 README
${subProjects.map(sp => {
  const manifestBlock = Object.entries(sp.manifests)
    .map(([n, c]) => `\n--- ${n} ---\n${c}`)
    .join('\n');
  return `\n### ${sp.name}\n${manifestBlock || '（无 manifest）'}\n\nREADME（前 8KB）：\n${sp.readme || '（无）'}`;
}).join('\n')}

只返回 JSON：
{
  "name": "项目名（10-20字）",
  "template": "可复用的提示词模板（300-600字），应明确使用 {{task.title}} / {{task.desc}} / {{sub.title}} / {{sub.desc}} / {{repo.path}} / {{branch}} 这 6 个变量"
}`;

      const first = await callLlmJson(model, firstPrompt, LLM_OPTS);
      const templateName = String(first.name || '').trim() || projectName || '项目架构说明';
      const template = String(first.template || '').trim();

      // ── 第二阶段：为每个子项目分别生成总结（单子项目 = 现在的行为） ──
      async function summarizeOneSub(sp) {
        const manifestBlock = Object.entries(sp.manifests)
          .map(([n, c]) => `\n--- ${n} ---\n${c}`)
          .join('\n');
        const subPrompt = `${template}

---

以下是你需要分析的一个子项目（请直接基于这些数据输出该子项目的架构说明）：

子项目根目录：${sp.root}
子项目名称：${sp.name}

## 目录结构（前 2 层）
${sp.dirTree || '（无）'}

## manifest
${manifestBlock || '（无）'}

## README
${sp.readme || '（无）'}

只返回 JSON：
{
  "summary": "该子项目的架构说明（300-600字）"
}`;
        const r = await callLlmJson(model, subPrompt, LLM_OPTS);
        return { name: sp.name, root: sp.root, summary: String(r.summary || '').trim() };
      }

      const subSummaries = await Promise.all(subProjects.map(summarizeOneSub));

      // ── 第三阶段：仅多子项目时合并（单子项目直接拿它的 summary） ──
      let finalSummary = '';
      let finalName = templateName;

      if (subSummaries.length === 1) {
        finalSummary = subSummaries[0].summary;
      } else {
        const mergePrompt = `你是项目架构师。下列是同一仓库下 N 个子项目的架构说明，请合并输出**单一**的「项目架构说明」（800-1500字），覆盖：项目整体定位、技术栈、模块划分、子项目间关系、核心流程、关键设计决策。
子项目之间用清晰的小标题或编号分隔。最后输出一段「整体架构」总结它们如何协同。
只引用实际出现的子项目名 / 文件路径 / 依赖名，不要编造。只返回 JSON：

{
  "name": "项目名（10-20字）",
  "summary": "合并后的架构说明"
}

## 子项目说明
${subSummaries.map((s, i) => `\n### [${i + 1}] ${s.name} (${s.root})\n${s.summary || '（空）'}`).join('\n')}`;

        const merged = await callLlmJson(model, mergePrompt, LLM_OPTS);
        finalSummary = String(merged.summary || '').trim()
          || subSummaries.map(s => `### ${s.name}\n${s.summary}`).join('\n\n');
        finalName = String(merged.name || '').trim() || templateName;
      }

      if (!finalSummary) {
        // 兜底：仅返回模板
        return res.json({
          success: true,
          name: finalName,
          template,
          result: '',
          content: template
        });
      }

      // 顶层 request 已经自带 20 分钟（1200s）超时；
      // 这里在 express 处理器内部不再额外加整体超时。
      res.json({
        success: true,
        name: finalName,
        template,
        result: finalSummary,
        content: finalSummary
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── 生成指令：读 / 写（用户可在弹窗里自定义） ───────────────────────
  app.get('/api/workbench/prompts/ai-instruction', async (_req, res) => {
    try {
      const instruction = await readInstruction();
      res.json({ success: true, instruction, isDefault: instruction === DEFAULT_INSTRUCTION });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/workbench/prompts/ai-instruction', async (req, res) => {
    try {
      const text = req.body && typeof req.body.instruction === 'string'
        ? req.body.instruction.trim()
        : '';
      if (!text) {
        return res.status(400).json({ success: false, error: '指令不能为空' });
      }
      if (text.length > 50000) {
        return res.status(413).json({ success: false, error: '指令过长（最多 50000 字符）' });
      }
      await writeInstruction(text);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── AI 拆分子任务：独立的指令文件、独立的端点 ───────────────────────
  // GET /api/workbench/tasks/ai-subtask-instruction
  //   →  { success, instruction, isDefault }
  // PUT /api/workbench/tasks/ai-subtask-instruction
  //   body: { instruction: string }
  //   →  { success }
  app.get('/api/workbench/tasks/ai-subtask-instruction', async (req, res) => {
    try {
      const def = pickDefaultSubtaskInstruction(req);
      const instruction = await readSubtaskInstruction(req);
      // isDefault：当前 instruction 和 locale 默认完全一致
      res.json({ success: true, instruction, isDefault: instruction === def });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/workbench/tasks/ai-subtask-instruction', async (req, res) => {
    try {
      const text = req.body && typeof req.body.instruction === 'string'
        ? req.body.instruction.trim()
        : '';
      if (!text) {
        return res.status(400).json({ success: false, error: '指令不能为空' });
      }
      if (text.length > 50000) {
        return res.status(413).json({ success: false, error: '指令过长（最多 50000 字符）' });
      }
      // 如果保存的文本正好等于当前 locale 的默认——不写文件，保持 fallback 行为
      const def = pickDefaultSubtaskInstruction(req);
      if (text === def) {
        // 删除已存在的自定义文件
        try { await fsp.unlink(SUBTASK_INSTRUCTION_FILE) } catch {}
        return res.json({ success: true, isDefault: true });
      }
      await writeSubtaskInstruction(text);
      res.json({ success: true, isDefault: false });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/workbench/tasks/ai-split-subtasks
  //   body: { title, desc, taskId? }
  //   →  SSE 流：
  //        data:{"type":"meta","prompt":{system,user}}\n\n
  //        data:{"type":"thinking","delta":"..."}\n\n   （多次）
  //        data:{"type":"content","delta":"..."}\n\n    （多次）
  //        data:{"type":"done","subtasks":[...],"raw":"..."}\n\n
  //        data:{"type":"error","error":"..."}\n\n      （失败时）
  //
  // 走流式是为了让用户看到模型真实的 reasoning_content（如果模型支持），
  // 而不是前端用 setInterval 假装"打字机"——拆分质量也会因为给了模型
  // 充分的思考空间而显著提升。
  app.post('/api/workbench/tasks/ai-split-subtasks', async (req, res) => {
    const title = String(req.body?.title || '').trim();
    const desc = String(req.body?.desc || '').trim();
    const taskId = String(req.body?.taskId || '').trim();
    const promptId = String(req.body?.promptId || '').trim();
    if (!title) {
      return res.status(400).json({ success: false, error: '任务标题不能为空' });
    }

    // 建立 SSE
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    const send = (obj) => {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
    };

    const abortController = new AbortController();
    let finished = false; // 标记响应是否已正常结束
    // 客户端真实断开：监听 socket close，而不是 req.close。
    // Node 22+ 的 req 'close' 事件会在 HTTP keep-alive socket 池回收时过早触发，
    // 导致正常请求中途被 abort。这里改用 socket 真实断开事件，
    // 并只在响应还没 end 时才取消上游 LLM。
    const onSocketClose = () => {
      if (!finished) abortController.abort()
    };
    if (req.socket) {
      req.socket.once('close', onSocketClose);
    }

    try {
      let model;
      try {
        if (!configManager) throw new Error('configManager 不可用');
        const rawConfig = await configManager.readRawConfigFile();
        const models = Array.isArray(rawConfig.models) ? rawConfig.models : [];
        model = models.find(m => m.isDefault) || models[0];
      } catch (err) {
        send({ type: 'error', error: '读取 AI 配置失败: ' + err.message });
        finished = true;
        return res.end();
      }
      if (!model) {
        send({ type: 'error', error: '未配置 AI 模型，请先在通用设置中添加模型' });
        finished = true;
        return res.end();
      }

      const userInstruction = await readSubtaskInstruction(req);
      const projectPath = typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '';
      const projectName = projectPath ? path.basename(projectPath) : '（未指定项目）';
      const manifestHint = await detectProjectManifest(projectPath);

      // 取绑定的预置模板（promptId）：模板内容作为"执行模板"提示
      // 让 LLM 拆分时知道：每个 sub 最终都会被这套模板包裹后送进 claude
      let templateBlock = '';
      if (promptId) {
        try {
          const promptData = await readJson(PROMPTS_FILE, { prompts: [] });
          const p = (promptData.prompts || []).find(x => x.id === promptId);
          if (p && p.content) {
            templateBlock = `\n\n## 子任务执行模板（每个拆出的子任务最终会被这套模板包裹后送给 claude 执行；拆分时请确保子任务能让模板里的 {{sub.title}} / {{sub.desc}} 等变量填得有意义）\n模板名：${p.name || '（未命名）'}\n---\n${p.content}\n---`;
          }
        } catch { /* 模板读取失败不影响拆分 */ }
      }

      // 取任务附件
      let attachmentBlock = '';
      const imageDataUrls = [];
      if (taskId) {
        try {
          const data = await readJson(TASKS_FILE, { tasks: [] });
          const task = (data.tasks || []).find(t => t.id === taskId);
          const atts = Array.isArray(task?.attachments) ? task.attachments : [];
          if (atts.length > 0) {
            const lines = [];
            for (let i = 0; i < atts.length; i++) {
              const a = atts[i];
              if (!a || !a.absolutePath) continue;
              lines.push(`  ${i + 1}. [${a.mimeType || 'application/octet-stream'}] ${a.absolutePath}`);
              if (isImageExt(a.ext)) {
                try {
                  const buf = await fsp.readFile(a.absolutePath);
                  const mime = a.mimeType || 'image/png';
                  imageDataUrls.push(`data:${mime};base64,${buf.toString('base64')}`);
                } catch { /* 文件丢失就跳过这张图 */ }
              }
            }
            if (lines.length > 0) {
              const imgNote = imageDataUrls.length > 0
                ? `（其中 ${imageDataUrls.length} 张图片已随消息一并发送，请直接基于图片内容拆分）`
                : '';
              attachmentBlock = `\n\n## 任务附件${imgNote}\n${lines.join('\n')}`;
            }
          }
        } catch { /* 没拿到附件不影响拆分 */ }
      }

      const userBlock = `${userInstruction}

---

## 待拆分的任务
标题：${title}
${desc ? `描述：${desc}` : '描述：（无）'}${attachmentBlock}${templateBlock}

## 项目上下文（仅供参考，便于拆分时考虑项目特性）
- 项目名称：${projectName}
- 项目根目录：${projectPath || '（未指定）'}
- 主要 manifest：${manifestHint || '（未识别到）'}

请先简要分析（可以放在 reasoning 中或直接写出来），然后给出 JSON。JSON 用 \`\`\`json ... \`\`\` 包裹：
{
  "subtasks": [
    { "title": "子任务标题（10-20字）", "desc": "具体描述" }
  ]
}

**JSON 输出严格要求**（不遵守会导致解析失败、用户无法入库）：
1. title 和 desc 内如需引用术语 / 页面名 / 状态名，**必须使用中文引号「」或『』**，禁止使用 ASCII 双引号、单引号或反引号，否则会破坏外层 JSON 结构。
2. JSON 中不允许尾随逗号（最后一个元素后面不能跟逗号）。
3. JSON 中不允许写注释。
4. 所有字符串字段必须用 ASCII 双引号包裹，字符串内部如有换行用 \\n 转义。`;

      // 先把 prompt 元信息推给前端
      send({ type: 'meta', prompt: { system: userInstruction, user: userBlock } });

      // 流式调用 LLM，把 thinking / content 实时回传
      const { content, aborted } = await callLlmStream(
        model,
        userBlock,
        (delta) => {
          if (delta.thinking) send({ type: 'thinking', delta: delta.thinking });
          if (delta.content) send({ type: 'content', delta: delta.content });
        },
        { maxTokens: 4000, timeoutMs: 600000, images: imageDataUrls, signal: abortController.signal }
      );

      if (aborted) {
        send({ type: 'error', error: '已取消' });
        finished = true;
        return res.end();
      }

      // 解析 JSON：兼容 ```json ... ``` 代码块或裸 JSON，多级降级
      const { parsed, parseError, parseStage } = parseSubtaskJson(content);
      const list = Array.isArray(parsed?.subtasks) ? parsed.subtasks : [];
      const subtasks = list
        .map(s => ({
          title: String(s?.title || '').trim().slice(0, 80),
          desc: String(s?.desc || '').trim().slice(0, 500)
        }))
        .filter(s => s.title)
        .slice(0, 8);

      send({ type: 'done', subtasks, raw: content, parseError, parseStage });
      finished = true;
      res.end();
    } catch (err) {
      send({ type: 'error', error: 'AI 拆分失败: ' + (err?.message || String(err)) });
      finished = true;
      res.end();
    }
  });

  // POST /api/workbench/tasks/parse-subtasks
  //   body: { raw: string }
  //   →   { success, subtasks, parseError, parseStage }
  // 让前端在 AI 拆分对话框里把"原始结果"作为可编辑文本——用户手改完
  // （比如把 ASCII 双引号改成中文「」、删尾随逗号）后直接调这个接口，
  // 不必再发起一次 LLM 调用，省 token 也省等待。
  app.post('/api/workbench/tasks/parse-subtasks', async (req, res) => {
    try {
      const raw = String(req.body?.raw || '');
      const { parsed, parseError, parseStage } = parseSubtaskJson(raw);
      const list = Array.isArray(parsed?.subtasks) ? parsed.subtasks : [];
      const subtasks = list
        .map(s => ({
          title: String(s?.title || '').trim().slice(0, 80),
          desc: String(s?.desc || '').trim().slice(0, 500)
        }))
        .filter(s => s.title)
        .slice(0, 8);
      res.json({ success: true, subtasks, parseError, parseStage });
    } catch (err) {
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });

  // SSE 事件流
  app.get('/api/workbench/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    const send = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    // 初始快照
    send({ event: 'hello', payload: { jobs: snapshotJobs() }, ts: nowIso() });
    const handler = (evt) => send(evt);
    bus.on('event', handler);
    const ka = setInterval(() => res.write(`: keep-alive\n\n`), 15000);
    req.on('close', () => {
      clearInterval(ka);
      bus.off('event', handler);
    });
  });

  // ── 提示词 CRUD ─────────────────────────────────────────────────────
  app.get('/api/workbench/prompts', async (_req, res) => {
    try {
      const data = await readJson(PROMPTS_FILE, { prompts: [] });
      res.json({ success: true, prompts: data.prompts || [] });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/workbench/prompts', async (req, res) => {
    try {
      const { id, name, content } = req.body || {};
      if (!name || typeof content !== 'string') {
        return res.status(400).json({ success: false, error: 'name 和 content 必填' });
      }
      const data = await readJson(PROMPTS_FILE, { prompts: [] });
      const prompts = data.prompts || [];
      const now = nowIso();
      if (id) {
        const i = prompts.findIndex(p => p.id === id);
        if (i < 0) return res.status(404).json({ success: false, error: '提示词不存在' });
        prompts[i] = { ...prompts[i], name, content, updatedAt: now };
        await writeJson(PROMPTS_FILE, { prompts });
        return res.json({ success: true, prompt: prompts[i] });
      }
      const prompt = { id: genId(), name, content, createdAt: now, updatedAt: now };
      prompts.push(prompt);
      await writeJson(PROMPTS_FILE, { prompts });
      res.json({ success: true, prompt });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/workbench/prompts/:id', async (req, res) => {
    try {
      const data = await readJson(PROMPTS_FILE, { prompts: [] });
      const prompts = (data.prompts || []).filter(p => p.id !== req.params.id);
      await writeJson(PROMPTS_FILE, { prompts });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── 任务 CRUD ───────────────────────────────────────────────────────
  app.get('/api/workbench/tasks', async (_req, res) => {
    try {
      const data = await readJson(TASKS_FILE, { tasks: [] });
      res.json({ success: true, tasks: data.tasks || [] });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 当前选中的项目路径（侧边栏按项目分组时要用）
  app.get('/api/workbench/current-project', async (_req, res) => {
    try {
      const projectPath = typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '';
      const projectName = projectPath ? projectPath.split(/[\\/]/).filter(Boolean).pop() : '';
      res.json({ success: true, projectPath, projectName });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/workbench/tasks', async (req, res) => {
    try {
      const { id, title, desc, promptId, subtasks } = req.body || {};
      if (!title) return res.status(400).json({ success: false, error: 'title 必填' });
      const data = await readJson(TASKS_FILE, { tasks: [] });
      const tasks = data.tasks || [];
      const now = nowIso();
      // 创建任务时记录当时所属项目；编辑已有任务不覆盖（避免切换项目后老任务被改归属）
      const currentProjectPath = typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '';
      if (id) {
        const i = tasks.findIndex(t => t.id === id);
        if (i < 0) return res.status(404).json({ success: false, error: '任务不存在' });
        tasks[i] = {
          ...tasks[i],
          title,
          desc: desc || '',
          promptId: promptId || null,
          subtasks: Array.isArray(subtasks) ? subtasks.map(s => ({
            id: s.id || genId(),
            title: s.title || '',
            desc: s.desc || '',
            status: s.status || 'todo',
            promptOverride: s.promptOverride || '',
            // 保留附件元数据（仅保留基础字段，丢弃客户端临时字段）
            attachments: Array.isArray(s.attachments) ? s.attachments.map(a => ({
              id: a.id,
              originalName: a.originalName,
              mimeType: a.mimeType,
              size: a.size,
              ext: a.ext,
              storedName: a.storedName,
              absolutePath: a.absolutePath,
              createdAt: a.createdAt
            })) : (tasks[i].subtasks.find(x => x.id === s.id)?.attachments || [])
          })) : tasks[i].subtasks,
          updatedAt: now
        };
        await writeJson(TASKS_FILE, { tasks });
        return res.json({ success: true, task: tasks[i] });
      }
      const task = {
        id: genId(),
        title,
        desc: desc || '',
        promptId: promptId || null,
        projectPath: currentProjectPath || '',
        subtasks: Array.isArray(subtasks) ? subtasks.map(s => ({
          id: s.id || genId(),
          title: s.title || '',
          desc: s.desc || '',
          status: s.status || 'todo',
          promptOverride: s.promptOverride || '',
          attachments: Array.isArray(s.attachments) ? s.attachments : []
        })) : [],
        status: 'todo',
        createdAt: now,
        updatedAt: now
      };
      tasks.push(task);
      await writeJson(TASKS_FILE, { tasks });
      res.json({ success: true, task });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/workbench/tasks/:id', async (req, res) => {
    try {
      const data = await readJson(TASKS_FILE, { tasks: [] });
      const tasks = (data.tasks || []).filter(t => t.id !== req.params.id);
      await writeJson(TASKS_FILE, { tasks });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── 执行任务 ────────────────────────────────────────────────────────
  app.post('/api/workbench/tasks/:id/run', async (req, res) => {
    try {
      const data = await readJson(TASKS_FILE, { tasks: [] });
      const task = (data.tasks || []).find(t => t.id === req.params.id);
      if (!task) return res.status(404).json({ success: false, error: '任务不存在' });
      if (!task.subtasks || task.subtasks.length === 0) {
        return res.status(400).json({ success: false, error: '任务没有子任务' });
      }
      const repoPath = typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '';
      // 异步执行，立即返回
      res.json({ success: true, message: '已开始执行' });
      runTaskQueue(task, repoPath, '').catch(err => {
        publish('task:error', { taskId: task.id, error: err.message });
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── 进程状态查询（兜底，SSE 断了也能拉） ────────────────────────────
  app.get('/api/workbench/jobs', (_req, res) => {
    res.json({ success: true, jobs: snapshotJobs() });
  });

  // ── 取消正在执行的 job ───────────────────────────────────────────
  // POST /api/workbench/jobs/:id/cancel
  // 行为：
  //   - 找到正在运行的 job，调 child.kill() 终止 claude 进程
  //   - Windows 下用 taskkill /T /F 杀进程树（claude 进程可能 fork 出子进程）
  //   - 加入 cancelledJobs 集合，runTaskQueue 退出循环后会把 job 标为 'cancelled'
  //   - 只影响这一个 sub；同 task 后续 sub 仍按队列顺序继续执行
  app.post('/api/workbench/jobs/:id/cancel', (req, res) => {
    const job = jobs.get(req.params.id)
    if (!job) {
      return res.status(404).json({ success: false, error: 'job 不存在' })
    }
    if (job.status !== 'running' && job.status !== 'pending') {
      return res.status(400).json({ success: false, error: `当前状态 ${job.status} 不可取消` })
    }
    cancelledJobs.add(job.id)
    // 立即给前端一个状态反馈（不等 child 真正退出）
    job.status = 'cancelled'
    job.error = '用户已停止执行'
    job.endedAt = nowIso()
    publish('job:update', { ...job }) // 用浅拷贝避免序列化 child 引用
    // 终态：fire-and-forget 同步落盘，cancel 是显式操作，要保证不丢
    flushJobsSaveNow().catch(err => console.warn('[workbench] jobs save failed:', err.message))
    const child = job.child
    if (!child) {
      return res.json({ success: true, message: '已标记取消，进程将尽快结束' })
    }
    try {
      if (process.platform === 'win32') {
        // Windows: child.kill(SIGTERM) 经常无效，用 taskkill 杀进程树
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], (err) => {
          if (err) {
            console.warn(`[workbench] taskkill ${child.pid} 失败:`, err.message)
          }
        })
      } else {
        child.kill('SIGTERM')
      }
      res.json({ success: true, message: '已发送停止信号' })
    } catch (err) {
      cancelledJobs.delete(job.id)
      res.status(500).json({ success: false, error: '发送停止信号失败: ' + err.message })
    }
  });

  // ── 执行日志管理 API（持久化 + 清理） ────────────────────────────
  // 路径都在 /api/workbench/jobs/* 下；/list、/config、/batch-delete、/clear
  // 是字面路径，必须排在 :id 路由之前注册，避免被 :id 匹配吞掉。
  //
  // 数据来源：
  //   - 文件 jobs.json：已落盘的历史 job（含反范式 taskTitle/subTitle）
  //   - 内存 jobs Map：当前进程刚创建还没刷盘的（尤其是 running/pending）
  // 合并后再过滤分页，保证管理页能看到"刚启动还没结束"的任务。

  async function loadAllJobs() {
    // 读 tasks.json 一次，给内存里没落盘的 job 反范式补 title
    const tasksData = await readJson(TASKS_FILE, { tasks: [] })
    const taskMap = new Map((tasksData.tasks || []).map(t => [t.id, t]))
    const data = await readJson(JOBS_FILE, { version: 1, jobs: [] })
    const fileJobs = (data && Array.isArray(data.jobs)) ? data.jobs : []
    const fileIds = new Set(fileJobs.map(j => j.id))
    // 内存里有但文件里没有：running/pending 或最近刚起还没刷盘的
    const liveOnly = Array.from(jobs.values())
      .filter(j => !fileIds.has(j.id))
      .map(j => serializeJob(j, taskMap))
    return [...fileJobs, ...liveOnly]
  }

  function applyJobsFilter(list, q) {
    const status = (q.status || '').trim()
    const taskId = (q.taskId || '').trim()
    const term = (q.q || '').trim().toLowerCase()
    return list.filter(j => {
      if (status && j.status !== status) return false
      if (taskId && j.taskId !== taskId) return false
      if (term) {
        const hay = `${j.title || ''} ${j.taskTitle || ''} ${j.subTitle || ''}`.toLowerCase()
        if (!hay.includes(term)) return false
      }
      return true
    })
  }

  // GET /api/workbench/jobs/list?status=&q=&taskId=&limit=&offset=
  app.get('/api/workbench/jobs/list', async (req, res) => {
    try {
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50))
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0)
      const all = await loadAllJobs()
      const filtered = applyJobsFilter(all, req.query)
      // 按 endedAt desc；没有就 startedAt desc；都没有就 id desc（id 时间戳前缀可比）
      const sortKey = (j) => j.endedAt || j.startedAt || j.id || ''
      filtered.sort((a, b) => sortKey(b).localeCompare(sortKey(a)))
      const total = filtered.length
      const page = filtered.slice(offset, offset + limit)
      // 统计：按 status 分组 + 总 size（基于全集，给顶部条用）
      const byStatus = {}
      let totalSize = 0
      for (const j of all) {
        byStatus[j.status] = (byStatus[j.status] || 0) + 1
        totalSize += j.size || 0
      }
      res.json({
        success: true,
        jobs: page,
        total,
        stats: { count: all.length, sizeMB: +(totalSize / 1024 / 1024).toFixed(2), byStatus }
      })
    } catch (err) {
      res.status(500).json({ success: false, error: 'list jobs 失败: ' + (err.message || String(err)) })
    }
  })

  // GET /api/workbench/jobs/config
  app.get('/api/workbench/jobs/config', async (_req, res) => {
    try {
      res.json({ success: true, config: await readJobsConfig() })
    } catch (err) {
      res.status(500).json({ success: false, error: '读取配置失败: ' + err.message })
    }
  })

  // PUT /api/workbench/jobs/config
  app.put('/api/workbench/jobs/config', async (req, res) => {
    try {
      const cfg = await writeJobsConfig(req.body || {})
      // 配置变更后立刻 enforce，让已落盘的多余记录立刻被裁掉
      await enforceRetention()
      res.json({ success: true, config: cfg })
    } catch (err) {
      res.status(400).json({ success: false, error: err.message || String(err) })
    }
  })

  // POST /api/workbench/jobs/batch-delete
  app.post('/api/workbench/jobs/batch-delete', async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(s => typeof s === 'string') : []
      if (ids.length === 0) return res.json({ success: true, removed: 0 })
      // 1) 删内存 Map
      let removed = 0
      for (const id of ids) {
        if (jobs.delete(id)) removed++
      }
      // 2) 改写文件
      const data = await readJson(JOBS_FILE, { version: 1, jobs: [] })
      if (data && Array.isArray(data.jobs)) {
        const set = new Set(ids)
        const before = data.jobs.length
        data.jobs = data.jobs.filter(j => !set.has(j.id))
        removed += before - data.jobs.length
        await writeJson(JOBS_FILE, data)
      }
      res.json({ success: true, removed })
    } catch (err) {
      res.status(500).json({ success: false, error: '批量删除失败: ' + (err.message || String(err)) })
    }
  })

  // POST /api/workbench/jobs/clear
  app.post('/api/workbench/jobs/clear', async (req, res) => {
    try {
      if (req.body?.confirm !== true) {
        return res.status(400).json({ success: false, error: '需要 confirm: true' })
      }
      let removed = 0
      for (const j of jobs.values()) {
        // 不清当前还在跑/排队的（防止误清活跃 job；用户应逐个取消或等结束）
        if (j.status === 'running' || j.status === 'pending') continue
        jobs.delete(j.id)
        removed++
      }
      // 写一个空 jobs.json
      await writeJson(JOBS_FILE, { version: 1, jobs: [] })
      res.json({ success: true, removed })
    } catch (err) {
      res.status(500).json({ success: false, error: '清空失败: ' + (err.message || String(err)) })
    }
  })

  // GET /api/workbench/jobs/:id
  app.get('/api/workbench/jobs/:id', async (req, res) => {
    try {
      // 优先查内存（含活跃）
      const live = jobs.get(req.params.id)
      if (live) {
        const tasksData = await readJson(TASKS_FILE, { tasks: [] })
        const taskMap = new Map((tasksData.tasks || []).map(t => [t.id, t]))
        return res.json({ success: true, job: serializeJob(live, taskMap) })
      }
      // 退回文件
      const data = await readJson(JOBS_FILE, { version: 1, jobs: [] })
      const j = (data.jobs || []).find(x => x.id === req.params.id)
      if (!j) return res.status(404).json({ success: false, error: 'job 不存在' })
      res.json({ success: true, job: j })
    } catch (err) {
      res.status(500).json({ success: false, error: '查询失败: ' + (err.message || String(err)) })
    }
  })

  // DELETE /api/workbench/jobs/:id
  app.delete('/api/workbench/jobs/:id', async (req, res) => {
    try {
      const id = req.params.id
      let removed = false
      if (jobs.delete(id)) removed = true
      const data = await readJson(JOBS_FILE, { version: 1, jobs: [] })
      if (data && Array.isArray(data.jobs)) {
        const before = data.jobs.length
        data.jobs = data.jobs.filter(j => j.id !== id)
        if (data.jobs.length !== before) {
          removed = true
          await writeJson(JOBS_FILE, data)
        }
      }
      if (!removed) return res.status(404).json({ success: false, error: 'job 不存在' })
      res.json({ success: true, removed: 1 })
    } catch (err) {
      res.status(500).json({ success: false, error: '删除失败: ' + (err.message || String(err)) })
    }
  })

  // ── 子任务附件：上传 / 删除 / 列表 ───────────────────────────────
  // 上传：POST /api/workbench/subtasks/:subId/attachments
  //   header: X-Original-Name, X-Mime-Type
  //   body:   raw binary
  // 删除：DELETE /api/workbench/subtasks/:subId/attachments/:attId
  // 列表：GET    /api/workbench/subtasks/:subId/attachments
  //
  // 文件存到 ~/.zen-gitsync/workbench-images/{subId}/{attId}.{ext}
  // 元数据（id / originalName / mime / size / storedName）通过 sub.attachments
  // 跟随 tasks.json 一起持久化。
  const rawAttachment = express.raw({
    type: '*/*',
    limit: MAX_IMAGE_BYTES * 4 // 整体路由上限 20MB；单文件大小由业务再卡
  });

  // 共享 helper：找到一个 attachment 所在的位置（task 主附件 或 sub 附件）
  // 返回 { owner, task, sub?, list, att, storageDir } 或 null
  async function findAttachmentLocation(attId) {
    const data = await readJson(TASKS_FILE, { tasks: [] });
    for (const t of data.tasks || []) {
      const list = Array.isArray(t.attachments) ? t.attachments : [];
      const att = list.find(x => x.id === attId);
      if (att) {
        return { owner: 'task', task: t, list, att, storageDir: path.join(IMAGES_DIR, '_task-' + t.id) };
      }
    }
    for (const t of data.tasks || []) {
      for (const s of t.subtasks || []) {
        const list = Array.isArray(s.attachments) ? s.attachments : [];
        const att = list.find(x => x.id === attId);
        if (att) {
          return { owner: 'sub', task: t, sub: s, list, att, storageDir: path.join(IMAGES_DIR, s.id) };
        }
      }
    }
    return null;
  }

  // 共享 helper：写入新附件（参数化以支持 task / sub）
  async function writeAttachmentTo({ req, target, maxCount }) {
    if (!req.body || !(req.body instanceof Buffer) || req.body.length === 0) {
      return { error: '请求体为空', status: 400 };
    }
    if (req.body.length > MAX_IMAGE_BYTES) {
      return { error: `单文件不得超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`, status: 413 };
    }
    const originalName = String(req.get('X-Original-Name') || 'attachment').slice(0, 200);
    const mimeType = String(req.get('X-Mime-Type') || 'application/octet-stream').slice(0, 120);
    const ext = resolveExt({ originalName, mime: mimeType });
    if (!ext) {
      return { error: `不支持的文件类型（仅允许 ${[...ALLOWED_EXTS].join(', ')}）`, status: 400 };
    }
    if (!Array.isArray(target.attachments)) target.attachments = [];
    if (target.attachments.length >= maxCount) {
      return { error: `附件已达上限 ${maxCount} 个`, status: 400 };
    }

    const attId = genId();
    await fsp.mkdir(target.storageDir, { recursive: true });
    const storedName = `${attId}.${ext}`;
    const storedPath = path.join(target.storageDir, storedName);
    await fsp.writeFile(storedPath, req.body);

    const attachment = {
      id: attId,
      originalName,
      mimeType,
      size: req.body.length,
      ext,
      storedName,
      absolutePath: storedPath,
      createdAt: nowIso()
    };
    target.attachments.push(attachment);
    target.updatedAt = nowIso();
    return { attachment };
  }

  // 子任务附件
  app.post('/api/workbench/subtasks/:subId/attachments', rawAttachment, async (req, res) => {
    try {
      const { subId } = req.params;
      const data = await readJson(TASKS_FILE, { tasks: [] });
      let foundSub = null;
      for (const t of data.tasks || []) {
        const s = (t.subtasks || []).find(x => x.id === subId);
        if (s) { foundSub = s; break; }
      }
      if (!foundSub) {
        return res.status(404).json({ success: false, error: '子任务不存在' });
      }
      const target = { ...foundSub, storageDir: path.join(IMAGES_DIR, subId) };
      const result = await writeAttachmentTo({ req, target, maxCount: MAX_ATTACHMENTS_PER_SUBTASK });
      if (result.error) return res.status(result.status).json({ success: false, error: result.error });
      // target 是 spread 出来的浅拷贝，data 引用里的 foundSub 没改；显式 push 回去
      const att = result.attachment;
      foundSub.attachments = Array.isArray(foundSub.attachments) ? foundSub.attachments : [];
      foundSub.attachments.push(att);
      foundSub.updatedAt = nowIso();
      await writeJson(TASKS_FILE, data);
      res.json({ success: true, attachment: att });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/workbench/subtasks/:subId/attachments/:attId', async (req, res) => {
    try {
      const { subId, attId } = req.params;
      const data = await readJson(TASKS_FILE, { tasks: [] });
      let foundSub = null;
      for (const t of data.tasks || []) {
        const s = (t.subtasks || []).find(x => x.id === subId);
        if (s) { foundSub = s; break; }
      }
      if (!foundSub) return res.status(404).json({ success: false, error: '子任务不存在' });
      const list = Array.isArray(foundSub.attachments) ? foundSub.attachments : [];
      const i = list.findIndex(a => a.id === attId);
      if (i < 0) return res.status(404).json({ success: false, error: '附件不存在' });
      const [removed] = list.splice(i, 1);
      try {
        await fsp.unlink(path.join(IMAGES_DIR, subId, removed.storedName));
      } catch { /* 文件可能已不存在 */ }
      foundSub.updatedAt = nowIso();
      await writeJson(TASKS_FILE, data);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 主任务附件
  app.post('/api/workbench/tasks/:taskId/attachments', rawAttachment, async (req, res) => {
    try {
      const { taskId } = req.params;
      const data = await readJson(TASKS_FILE, { tasks: [] });
      const task = (data.tasks || []).find(t => t.id === taskId);
      if (!task) return res.status(404).json({ success: false, error: '任务不存在' });
      const target = { ...task, storageDir: path.join(IMAGES_DIR, '_task-' + taskId) };
      const result = await writeAttachmentTo({ req, target, maxCount: MAX_ATTACHMENTS_PER_SUBTASK });
      if (result.error) return res.status(result.status).json({ success: false, error: result.error });
      const att = result.attachment;
      task.attachments = Array.isArray(task.attachments) ? task.attachments : [];
      task.attachments.push(att);
      task.updatedAt = nowIso();
      await writeJson(TASKS_FILE, data);
      res.json({ success: true, attachment: att });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/workbench/tasks/:taskId/attachments/:attId', async (req, res) => {
    try {
      const { taskId, attId } = req.params;
      const data = await readJson(TASKS_FILE, { tasks: [] });
      const task = (data.tasks || []).find(t => t.id === taskId);
      if (!task) return res.status(404).json({ success: false, error: '任务不存在' });
      const list = Array.isArray(task.attachments) ? task.attachments : [];
      const i = list.findIndex(a => a.id === attId);
      if (i < 0) return res.status(404).json({ success: false, error: '附件不存在' });
      const [removed] = list.splice(i, 1);
      try {
        await fsp.unlink(path.join(IMAGES_DIR, '_task-' + taskId, removed.storedName));
      } catch { /* 文件可能已不存在 */ }
      task.updatedAt = nowIso();
      await writeJson(TASKS_FILE, data);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 附件原文件读取（前端 <img> 缩略图用）—— 支持 task 和 sub 两种归属
  app.get('/api/workbench/attachments/:attId/raw', async (req, res) => {
    try {
      const { attId } = req.params;
      const loc = await findAttachmentLocation(attId);
      if (!loc) return res.status(404).json({ success: false, error: '附件不存在' });
      const filePath = path.join(loc.storageDir, loc.att.storedName);
      try {
        const stat = await fsp.stat(filePath);
        res.set('Content-Type', loc.att.mimeType || 'application/octet-stream');
        res.set('Content-Length', String(stat.size));
        res.set('Cache-Control', 'private, max-age=3600');
        const stream = (await import('fs')).createReadStream(filePath);
        stream.on('error', () => res.end());
        stream.pipe(res);
      } catch {
        res.status(404).json({ success: false, error: '文件已丢失' });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

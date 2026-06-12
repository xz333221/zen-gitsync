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
import { spawn, execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import express from 'express';

const DATA_DIR = path.join(os.homedir(), '.zen-gitsync');
const PROMPTS_FILE = path.join(DATA_DIR, 'prompts.json');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const IMAGES_DIR = path.join(DATA_DIR, 'workbench-images');
const INSTRUCTION_FILE = path.join(DATA_DIR, 'ai-instruction.json');

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
  const { maxTokens = 1500, timeoutMs = 60000 } = opts;
  const { default: fetch } = await import('node-fetch').catch(() => ({ default: globalThis.fetch }));
  const url = `${String(model.baseURL || '').replace(/\/$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (model.apiKey) headers['Authorization'] = `Bearer ${model.apiKey}`;

  const body = JSON.stringify({
    model: model.model,
    messages: [{ role: 'user', content: prompt }],
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
      '--output-format', 'text',
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

    // ── 附件：把 sub.attachments 列表里的本地绝对路径拼到 prompt 末尾 ──
    // claude -p 字符串模式会扫描 prompt 中出现的本地文件路径并自动
    // 识别为附件（图片 / PDF / 文本均可）。
    const attachments = Array.isArray(sub.attachments) ? sub.attachments : [];
    if (attachments.length > 0) {
      const lines = attachments
        .filter(a => a && a.absolutePath)
        .map((a, i) => `  ${i + 1}. [${a.mimeType || 'application/octet-stream'}] ${a.absolutePath}`);
      if (lines.length > 0) {
        prompt += `\n\n---\n本子任务包含 ${lines.length} 个附件（请按文件路径读取，不要让用户重新提供）：\n${lines.join('\n')}\n---`;
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
      job.startedAt = nowIso();
      job.status = 'running';
      publish('job:update', job);

      // 累积子进程输出到 job.output，定期推送给前端；过长时截断尾部避免内存膨胀。
      const MAX_OUTPUT = 256 * 1024;
      const onChunk = (buf) => {
        const text = buf.toString('utf8');
        job.output = (job.output + text).slice(-MAX_OUTPUT);
        publish('job:update', job);
      };
      if (child.stdout) child.stdout.on('data', onChunk);
      if (child.stderr) child.stderr.on('data', onChunk);

      // 等待进程退出（detached 不阻塞主进程，用 polling /proc 兜底）
      await waitProcessExit(pid);
      job.endedAt = nowIso();
      job.exitCode = 0;
      job.status = 'done';
      sub.status = 'done';
    } catch (err) {
      job.error = err && err.message ? err.message : String(err);
      job.status = 'error';
      sub.status = 'error';
    } finally {
      publish('job:update', job);
      publish('sub:update', { taskId: task.id, sub });
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

  app.post('/api/workbench/tasks', async (req, res) => {
    try {
      const { id, title, desc, promptId, subtasks } = req.body || {};
      if (!title) return res.status(400).json({ success: false, error: 'title 必填' });
      const data = await readJson(TASKS_FILE, { tasks: [] });
      const tasks = data.tasks || [];
      const now = nowIso();
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

  app.post('/api/workbench/subtasks/:subId/attachments', rawAttachment, async (req, res) => {
    try {
      const { subId } = req.params;
      if (!req.body || !(req.body instanceof Buffer) || req.body.length === 0) {
        return res.status(400).json({ success: false, error: '请求体为空' });
      }
      if (req.body.length > MAX_IMAGE_BYTES) {
        return res.status(413).json({ success: false, error: `单文件不得超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB` });
      }
      const originalName = String(req.get('X-Original-Name') || 'attachment').slice(0, 200);
      const mimeType = String(req.get('X-Mime-Type') || 'application/octet-stream').slice(0, 120);
      const ext = resolveExt({ originalName, mime: mimeType });
      if (!ext) {
        return res.status(400).json({ success: false, error: `不支持的文件类型（仅允许 ${[...ALLOWED_EXTS].join(', ')}）` });
      }

      // 找到子任务，校验数量
      const data = await readJson(TASKS_FILE, { tasks: [] });
      let foundTask = null;
      let foundSub = null;
      for (const t of data.tasks || []) {
        const s = (t.subtasks || []).find(x => x.id === subId);
        if (s) { foundTask = t; foundSub = s; break; }
      }
      if (!foundSub) {
        return res.status(404).json({ success: false, error: '子任务不存在' });
      }
      if (!Array.isArray(foundSub.attachments)) foundSub.attachments = [];
      if (foundSub.attachments.length >= MAX_ATTACHMENTS_PER_SUBTASK) {
        return res.status(400).json({
          success: false,
          error: `每个子任务最多 ${MAX_ATTACHMENTS_PER_SUBTASK} 个附件`
        });
      }

      // 写入磁盘：~/.zen-gitsync/workbench-images/{subId}/{attId}.{ext}
      const attId = genId();
      const subDir = path.join(IMAGES_DIR, subId);
      await fsp.mkdir(subDir, { recursive: true });
      const storedName = `${attId}.${ext}`;
      const storedPath = path.join(subDir, storedName);
      await fsp.writeFile(storedPath, req.body);

      const attachment = {
        id: attId,
        originalName,
        mimeType,
        size: req.body.length,
        ext,
        storedName,
        // 绝对路径供 claude CLI 读取；同机直接读本地
        absolutePath: storedPath,
        createdAt: nowIso()
      };
      foundSub.attachments.push(attachment);
      foundSub.updatedAt = nowIso();
      await writeJson(TASKS_FILE, data);

      res.json({ success: true, attachment });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/workbench/subtasks/:subId/attachments/:attId', async (req, res) => {
    try {
      const { subId, attId } = req.params;
      const data = await readJson(TASKS_FILE, { tasks: [] });
      let foundTask = null;
      let foundSub = null;
      for (const t of data.tasks || []) {
        const s = (t.subtasks || []).find(x => x.id === subId);
        if (s) { foundTask = t; foundSub = s; break; }
      }
      if (!foundSub) return res.status(404).json({ success: false, error: '子任务不存在' });
      const list = Array.isArray(foundSub.attachments) ? foundSub.attachments : [];
      const i = list.findIndex(a => a.id === attId);
      if (i < 0) return res.status(404).json({ success: false, error: '附件不存在' });
      const [removed] = list.splice(i, 1);
      // 删磁盘文件
      try {
        await fsp.unlink(path.join(IMAGES_DIR, subId, removed.storedName));
      } catch { /* 文件可能已不存在，忽略 */ }
      foundSub.updatedAt = nowIso();
      await writeJson(TASKS_FILE, data);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 附件原文件读取（前端 <img> 缩略图用）
  app.get('/api/workbench/attachments/:attId/raw', async (req, res) => {
    try {
      const { attId } = req.params;
      const data = await readJson(TASKS_FILE, { tasks: [] });
      let found = null;
      let parentSubId = null;
      for (const t of data.tasks || []) {
        for (const s of t.subtasks || []) {
          const a = (s.attachments || []).find(x => x.id === attId);
          if (a) { found = a; parentSubId = s.id; break; }
        }
        if (found) break;
      }
      if (!found) return res.status(404).json({ success: false, error: '附件不存在' });
      const filePath = path.join(IMAGES_DIR, parentSubId, found.storedName);
      try {
        const stat = await fsp.stat(filePath);
        res.set('Content-Type', found.mimeType || 'application/octet-stream');
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

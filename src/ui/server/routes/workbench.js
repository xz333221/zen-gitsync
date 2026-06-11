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

const DATA_DIR = path.join(os.homedir(), '.zen-gitsync');
const PROMPTS_FILE = path.join(DATA_DIR, 'prompts.json');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const IMAGES_DIR = path.join(DATA_DIR, 'workbench-images');

// 单张图片最大 5MB（解码后字节数）
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

// mime → 文件后缀；与前端 el-upload accept 对齐
const MIME_TO_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico'
};

function sanitizeExt(name, fallback = 'png') {
  if (typeof name !== 'string') return fallback;
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return fallback;
  return IMAGE_EXTS.has(m[1]) ? m[1] : fallback;
}

async function ensureImagesDir() {
  await fsp.mkdir(IMAGES_DIR, { recursive: true });
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

async function callLlmJson(model, prompt) {
  const { default: fetch } = await import('node-fetch').catch(() => ({ default: globalThis.fetch }));
  const url = `${String(model.baseURL || '').replace(/\/$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (model.apiKey) headers['Authorization'] = `Bearer ${model.apiKey}`;

  const body = JSON.stringify({
    model: model.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1500,
    temperature: 0.4,
    response_format: { type: 'json_object' },
    stream: false,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
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
    const prompt = parts.join('\n\n');

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

      // 收集项目上下文
      const dirTree = await listDirTree(projectPath, 2, 400);
      const manifest = await readProjectManifest(projectPath);
      const readme = await safeReadFile(path.join(projectPath, 'README.md'), 8000);

      const manifestBlock = Object.entries(manifest)
        .map(([name, content]) => `\n--- ${name} ---\n${content}`)
        .join('\n');

      const projectName = path.basename(projectPath);

      const userPayload = `项目根目录：${projectPath}
项目名称：${projectName}

## 目录结构（前 2 层，截断）
${dirTree || '（无）'}

## README.md
${readme || '（无）'}

## 关键 manifest
${manifestBlock || '（无）'}`;

      // 第一阶段：让 LLM 写一段「可复用的提示词模板」
      const templateSystemPrompt = `你是一名资深软件架构师。任务：根据用户提供的项目目录结构、README、manifest 文件，输出一段**可复用的提示词模板**。
这段模板将作为指令注入到大模型的 system prompt 中，用来指导大模型对**当前项目**做「项目架构总结」。

要求：
1. 模板主体使用中文，语气专业、具体
2. 模板中必须明确使用 4 个变量占位符：
   - {{task.title}}  - 任务标题
   - {{task.desc}}   - 任务详细描述
   - {{sub.title}}   - 子任务标题
   - {{sub.desc}}    - 子任务详细描述
   并向大模型说明：项目根目录是 {{repo.path}}，当前 git 分支是 {{branch}}
3. 模板应指导大模型：阅读项目目录、识别语言与框架、找出入口文件、画出主要模块依赖关系、输出 200-400 字的中文总结
4. 模板长度控制在 300-600 字之间
5. 只返回 JSON，不要任何额外解释

返回 JSON：
{
  "name": "模板名称（10-20字）",
  "template": "模板正文"
}`;

      const first = await callLlmJson(model, `${templateSystemPrompt}\n\n${userPayload}`);
      const templateName = String(first.name || '').trim() || '项目架构总结';
      const template = String(first.template || '').trim();
      if (!template) {
        return res.status(500).json({ success: false, error: 'AI 未返回有效模板' });
      }

      // 第二阶段：以模板为指令，喂入项目上下文，跑一次实际生成
      const execPrompt = `${template}

---

以下是你需要分析的项目实际数据（请直接基于这些数据输出最终结果）：

项目根目录：${projectPath}
项目名称：${projectName}

## 目录结构（前 2 层）
${dirTree || '（无）'}

## README.md
${readme || '（无）'}

## 关键 manifest
${manifestBlock || '（无）'}

请输出一份 200-400 字的中文架构总结，包含：项目整体定位、技术栈、模块划分、核心流程、关键设计决策。只返回 JSON：

{
  "summary": "架构总结正文"
}`;

      const second = await callLlmJson(model, execPrompt);
      const summary = String(second.summary || '').trim();

      if (!summary) {
        // 兜底：仅返回模板，结果留空
        return res.json({
          success: true,
          name: templateName,
          template,
          result: '',
          content: template
        });
      }

      // 把模板和实际结果拼到一起，作为预置提示词存进 prompts.json
      const content = `${template}\n\n## 当前项目架构总结（已生成于 ${nowIso()}）\n\n${summary}`;

      res.json({
        success: true,
        name: templateName,
        template,
        result: summary,
        content
      });
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
            promptOverride: s.promptOverride || ''
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
          promptOverride: s.promptOverride || ''
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
}

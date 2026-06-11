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
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

const DATA_DIR = path.join(os.homedir(), '.zen-gitsync');
const PROMPTS_FILE = path.join(DATA_DIR, 'prompts.json');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

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
    pid: j.pid || null,
    startedAt: j.startedAt || null,
    endedAt: j.endedAt || null,
    exitCode: typeof j.exitCode === 'number' ? j.exitCode : null,
    error: j.error || null
  }));
}

// 用 detached 进程 + start 弹一个新窗口跑 claude；进程退出时回填状态。
function launchClaudeInNewWindow(cwd, promptText) {
  return new Promise((resolve, reject) => {
    const args = [
      '--permission-mode', 'bypassPermissions',
      '--dangerously-skip-permissions'
    ];
    // 初始 prompt 通过 stdin 喂入，避免命令行长度 / 转义问题
    let child;
    if (process.platform === 'win32') {
      // start "" cmd /c "echo ... | claude ..."
      const encoded = promptText.replace(/"/g, '\\"');
      const cmd = `echo "${encoded}" | claude ${args.map(a => `"${a}"`).join(' ')}`;
      child = spawn('cmd.exe', ['/c', 'start', '""', 'cmd', '/c', cmd], {
        cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
    } else {
      // macOS / Linux：尝试 osascript 弹 Terminal.app 窗口；否则直接 spawn 后台
      if (process.platform === 'darwin') {
        const escaped = promptText.replace(/"/g, '\\"');
        const cmd = `printf "%s" "${escaped}" | claude ${args.join(' ')}`;
        child = spawn('osascript', ['-e', `tell application "Terminal" to do script "${cmd.replace(/"/g, '\\"')}"`], {
          detached: true,
          stdio: 'ignore'
        });
      } else {
        const encoded = promptText.replace(/'/g, `'\\''`);
        child = spawn('sh', ['-c', `printf "%s" '${encoded}' | xargs -0 -I {} claude ${args.join(' ')}`], {
          cwd,
          detached: true,
          stdio: 'ignore'
        });
      }
    }
    child.on('error', reject);
    child.on('spawn', () => {
      child.unref();
      resolve(child.pid);
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
    const prompt = interpolate(promptTemplate, ctx) + (sub.desc ? `\n\n${sub.desc}` : '');

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
      const pid = await launchClaudeInNewWindow(repoPath || process.cwd(), prompt);
      job.pid = pid;
      job.startedAt = nowIso();
      job.status = 'running';
      publish('job:update', job);
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
        if (err && err.code === 'ESRCH') {
          exited = true;
          resolve();
          return;
        }
        // EPERM 等也算不可访问
        exited = true;
        resolve();
        return;
      }
      setTimeout(tryCheck, 1500);
    };
    tryCheck();
    // 兜底：30 分钟超时自动结束
    setTimeout(() => { if (!exited) { exited = true; resolve(); } }, 30 * 60 * 1000);
  });
}

export function registerWorkbenchRoutes({ app, getCurrentProjectPath, getProjectRoomId, io }) {
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

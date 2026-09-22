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
// 工作台路由入口。
//
// 历史背景：本文件曾是 3539 行的巨型文件，包含所有顶层工具函数 + 45 个路由端点。
// 2026-06-29 按业务域拆分为 workbench/ 子目录的 9 个模块：
//   - shared.js          常量 + 通用工具 (nowIso, genId, readJson, writeJson, interpolate)
//   - jsonParse.js       从 LLM 输出里抠 JSON 的纯函数
//   - llmClient.js       LLM 客户端 (callLlmJson, callLlmStream)
//   - projectScan.js     子项目识别 (findSubProjects, detectProjectManifest)
//   - attachmentUtils.js 附件白名单 (sanitizeExt, resolveExt, MIME_TO_EXT)
//   - instructionStore.js AI 指令读写
//   - jobStore.js        jobs Map + bus + 持久化 + retention
//   - taskRunner.js      任务执行引擎 (runSingleSubtask —— 一次任务 = 一次会话)
//
// 本文件（index.js）只做 registerWorkbenchRoutes 入口聚合，按业务域分节注册路由。
// 错误处理：
//   - 非 SSE 路由统一用 asyncRoute 包装，handler 内部不再写 try/catch
//   - 异常自动走 asyncRoute → 全局 errorHandler 中间件（server/index.js 注册）
//   - SSE 路由保留 try/catch：错误必须以 SSE data 帧 format 发出，不能转 JSON
//   - handler 抛 HttpError(statusCode, msg) 可定制状态码

import path from 'path';
import { execFile } from 'child_process';
import express from 'express';
import { asyncRoute, HttpError } from '../../utils/asyncRoute.js';

import {
  logger,
  fs,
  fsp,
  PROMPTS_FILE,
  TASKS_FILE,
  CONFIG_FILE,
  JOBS_FILE,
  ORCHESTRATOR_FILE,
  IMAGES_DIR,
  MAX_IMAGE_BYTES,
  MAX_ATTACHMENTS_PER_TASK,
  MAX_DEFAULT_PROMPT_CHARS,
  readJson,
  writeJson,
  nowIso,
  genId,
} from './shared.js';
import { callLlmJson, callLlmJsonWithRetry, callLlmStream } from './llmClient.js';
import {
  findSubProjects,
  detectProjectManifest,
  readProjectManifest,
  listDirTree,
  safeReadFile,
} from './projectScan.js';
import {
  isImageExt,
  resolveExt,
  ALLOWED_EXTS,
  ensureImagesDir,
  DISPATCH_STAGING_DIR,
  isSafeAttId,
  mimeForExt,
  stagingPath,
  findStagingFile,
  cleanupDispatchStaging,
} from './attachmentUtils.js';
import {
  DEFAULT_INSTRUCTION,
  readInstruction,
  writeInstruction,
} from './instructionStore.js';
import {
  jobs,
  bus,
  cancelledJobs,
  serializeJob,
  scheduleJobsSave,
  flushJobsSaveNow,
  readJobsConfig,
  writeJobsConfig,
  enforceRetention,
  publish,
  snapshotJobs,
  refreshJobsFromDisk,
  mergedJobs,
} from './jobStore.js';
import {
  normalizeTaskExecutor,
  runSingleSubtask,
  setEnvContextProvider,
} from './taskRunner.js';
import {
  listProjects,
  groupJobsByTask,
  decorateTaskForBoard,
  resolveTaskRepoPath,
  buildTaskDetail,
  buildProjectEntries,
  canonicalProjectPath,
} from './projectRegistry.js';
import { buildEnvContextBlock } from './envContext.js';
import { resolveInstructionTarget } from './targetResolver.js';
import {
  readOrchestrator,
  setOrchestratorActive,
  setDefaultPrompt,
  setProjectPrompt,
  resolveDispatchPrompt,
  appendInstruction,
  buildActivityFeed,
  buildRunningAgents,
} from './orchestratorStore.js';

/**
 * 解析本次执行用哪个执行器：body.executor 显式指定 > 配置里的全局默认 > 'claude'。
 * 配置读失败一律回落 'claude' —— 执行器选不出来不该挡住任务本身能跑。
 */
async function resolveExecutor(requested) {
  const explicit = normalizeTaskExecutor(requested);
  if (explicit) return explicit;
  try {
    if (configManager) {
      const cfg = await configManager.loadConfig();
      const fallback = normalizeTaskExecutor(cfg?.taskExecutor);
      if (fallback) return fallback;
    }
  } catch (err) {
    logger.warn('[workbench] 读取 taskExecutor 配置失败,回落 claude:', err && err.message || err);
  }
  return 'claude';
}

/**
 * 注册所有 workbench 路由（共 45 个端点）。
 * @param {Object} deps
 * @param {import('express').Express} deps.app
 * @param {() => string} deps.getCurrentProjectPath
 * @param {() => string} deps.getProjectRoomId
 * @param {import('socket.io').Server} deps.io
 * @param {Object} deps.configManager
 */
export function registerWorkbenchRoutes({ app, getCurrentProjectPath, getProjectRoomId, io, configManager }) {
  // ════════════════════════════════════════════════════════════════════════
  // §1. AI 生成提示词（基于当前项目）
  // ════════════════════════════════════════════════════════════════════════
  app.post('/api/workbench/prompts/ai-generate', asyncRoute(async (req, res) => {
    const projectPath = typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '';
    if (!projectPath) throw new HttpError(400, '未选中项目');
    let stat;
    try { stat = await fsp.stat(projectPath); }
    catch { throw new HttpError(400, '项目路径不存在'); }
    if (!stat.isDirectory()) throw new HttpError(400, '项目路径不是目录');

    // 取模型
    let model;
    try {
      if (!configManager) throw new Error('configManager 不可用');
      const rawConfig = await configManager.readRawConfigFile();
      const models = Array.isArray(rawConfig.models) ? rawConfig.models : [];
      model = models.find(m => m.isDefault) || models[0];
    } catch (err) {
      throw new HttpError(500, '读取 AI 配置失败: ' + err.message);
    }
    if (!model) throw new HttpError(400, '未配置 AI 模型，请先在通用设置中添加模型');

    const userInstruction = await readInstruction();

    // 递归识别多子项目
    const subProjects = await findSubProjects(projectPath);
    if (subProjects.length === 0) {
      subProjects.push({
        root: projectPath,
        name: path.basename(projectPath),
        manifests: await readProjectManifest(projectPath),
        readme: await safeReadFile(path.join(projectPath, 'README.md'), 8000),
        dirTree: await listDirTree(projectPath, 2, 400)
      });
    }

    const projectName = path.basename(projectPath);
    const LLM_OPTS = { timeoutMs: 1200000 };

    // 第一阶段：生成「可复用的提示词模板」
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
  "name": "项目名（建议：项目名+架构说明，可根据实际项目特征调整）",
  "template": "可复用的提示词模板，长度不限，请充分覆盖 {{task.title}} / {{task.desc}} / {{sub.title}} / {{sub.desc}} / {{repo.path}} / {{branch}} 这 6 个变量的用法与上下文"
}`;

    const first = await callLlmJsonWithRetry(model, firstPrompt, LLM_OPTS);
    const templateName = String(first.name || '').trim() || `${projectName}架构说明`;
    const template = String(first.template || '').trim();

    // 第二阶段：为每个子项目分别生成总结
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
  "summary": "该子项目的架构说明，长度不限，模型自行决定篇幅与详尽程度，能写多详细就多详细"
}`;
      const r = await callLlmJsonWithRetry(model, subPrompt, LLM_OPTS);
      return { name: sp.name, root: sp.root, summary: String(r.summary || '').trim() };
    }

    // 串行执行，避免并发触发 provider 限流（429）
    const subSummaries = [];
    for (const sp of subProjects) {
      subSummaries.push(await summarizeOneSub(sp));
    }

    // 第三阶段：仅多子项目时合并
    let finalSummary = '';
    let finalName = templateName;

    if (subSummaries.length === 1) {
      finalSummary = subSummaries[0].summary;
    } else {
      const mergePrompt = `你是项目架构师。下列是同一仓库下 N 个子项目的架构说明，请合并输出**单一**的「项目架构说明」，长度不限，模型自行决定篇幅与详尽程度。覆盖：项目整体定位、技术栈、模块划分、子项目间关系、核心流程、关键设计决策。
子项目之间用清晰的小标题或编号分隔。最后输出一段「整体架构」总结它们如何协同。
只引用实际出现的子项目名 / 文件路径 / 依赖名，不要编造。只返回 JSON：

{
  "name": "项目名（建议：项目名+架构说明）",
  "summary": "合并后的架构说明"
}

## 子项目说明
${subSummaries.map((s, i) => `\n### [${i + 1}] ${s.name} (${s.root})\n${s.summary || '（空）'}`).join('\n')}`;

      const merged = await callLlmJsonWithRetry(model, mergePrompt, LLM_OPTS);
      finalSummary = String(merged.summary || '').trim()
        || subSummaries.map(s => `### ${s.name}\n${s.summary}`).join('\n\n');
      finalName = String(merged.name || '').trim() || templateName;
    }

    // 名称始终固定为「<项目名>架构说明」，不信任模型返回的 name 字段
    finalName = `${projectName}架构说明`;

    if (!finalSummary) {
      throw new HttpError(502, '模型返回为空，请稍后重试');
    }

    res.json({
      success: true,
      name: finalName,
      template,
      result: finalSummary,
      content: finalSummary
    });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §2. 生成指令：读 / 写
  // ════════════════════════════════════════════════════════════════════════
  app.get('/api/workbench/prompts/ai-instruction', asyncRoute(async (_req, res) => {
    const instruction = await readInstruction();
    res.json({ success: true, instruction, isDefault: instruction === DEFAULT_INSTRUCTION });
  }));

  app.put('/api/workbench/prompts/ai-instruction', asyncRoute(async (req, res) => {
    const text = req.body && typeof req.body.instruction === 'string'
      ? req.body.instruction.trim()
      : '';
    if (!text) throw new HttpError(400, '指令不能为空');
    if (text.length > 500000) throw new HttpError(413, '指令过长（最多 500000 字符）');
    await writeInstruction(text);
    res.json({ success: true });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §3. SSE 事件流（订阅 job/sub/task 更新）
  // ════════════════════════════════════════════════════════════════════════
  app.get('/api/workbench/events', asyncRoute(async (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    // 先把 jobs.json 刷进缓存——别的 g ui 进程跑的 job 只在那里。刷新放在这里
    // (await 完再往下走),是为了让后面的「取快照 → 发 hello → 注册 handler」保持
    // 全同步:中间没有 await 就不会有 job:update 插到 hello 前面去。
    await refreshJobsFromDisk();
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
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §10. 提示词 CRUD
  // ════════════════════════════════════════════════════════════════════════
  app.get('/api/workbench/prompts', asyncRoute(async (_req, res) => {
    const data = await readJson(PROMPTS_FILE, { prompts: [] });
    res.json({ success: true, prompts: data.prompts || [] });
  }));

  app.post('/api/workbench/prompts', asyncRoute(async (req, res) => {
    const { id, name, content, projectPath } = req.body || {};
    if (!name || typeof content !== 'string') throw new HttpError(400, 'name 和 content 必填');
    const data = await readJson(PROMPTS_FILE, { prompts: [] });
    const prompts = data.prompts || [];
    const now = nowIso();
    const normalizedProjectPath = typeof projectPath === 'string' ? projectPath.trim() : '';
    if (id) {
      const i = prompts.findIndex(p => p.id === id);
      if (i < 0) throw new HttpError(404, '提示词不存在');
      prompts[i] = {
        ...prompts[i],
        name,
        content,
        projectPath: normalizedProjectPath,
        updatedAt: now
      };
      await writeJson(PROMPTS_FILE, { prompts });
      return res.json({ success: true, prompt: prompts[i] });
    }
    const prompt = {
      id: genId(),
      name,
      content,
      projectPath: normalizedProjectPath,
      createdAt: now,
      updatedAt: now
    };
    prompts.push(prompt);
    await writeJson(PROMPTS_FILE, { prompts });
    res.json({ success: true, prompt });
  }));

  app.delete('/api/workbench/prompts/:id', asyncRoute(async (req, res) => {
    const data = await readJson(PROMPTS_FILE, { prompts: [] });
    const prompts = (data.prompts || []).filter(p => p.id !== req.params.id);
    await writeJson(PROMPTS_FILE, { prompts });
    res.json({ success: true });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §11. 任务 CRUD
  // ════════════════════════════════════════════════════════════════════════
  app.get('/api/workbench/tasks', asyncRoute(async (_req, res) => {
    const data = await readJson(TASKS_FILE, { tasks: [] });
    res.json({ success: true, tasks: data.tasks || [] });
  }));

  app.get('/api/workbench/current-project', asyncRoute(async (_req, res) => {
    const projectPath = typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '';
    const projectName = projectPath ? projectPath.split(/[\\/]/).filter(Boolean).pop() : '';
    res.json({ success: true, projectPath, projectName });
  }));

  // 任务排序：拖动落盘。body: { orderedIds, groupPath? }
  app.put('/api/workbench/tasks/reorder', asyncRoute(async (req, res) => {
    const orderedIds = Array.isArray(req.body && req.body.orderedIds) ? req.body.orderedIds : null;
    const groupPath = typeof (req.body && req.body.groupPath) === 'string' ? req.body.groupPath.trim() || null : null;
    if (!orderedIds || orderedIds.length === 0) throw new HttpError(400, 'orderedIds 不能为空');
    if (!orderedIds.every((x) => typeof x === 'string' && x.length > 0)) {
      throw new HttpError(400, 'orderedIds 必须是字符串数组');
    }
    if (new Set(orderedIds).size !== orderedIds.length) {
      throw new HttpError(400, 'orderedIds 包含重复 id');
    }
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const tasks = data.tasks || [];
    const idIndex = new Map();
    for (let i = 0; i < tasks.length; i++) idIndex.set(tasks[i].id, i);
    const missing = orderedIds.filter((id) => !idIndex.has(id));
    if (missing.length > 0) {
      throw new HttpError(400, `id 不存在: ${missing.slice(0, 3).join(',')}`);
    }

    // groupPath 完整性校验
    if (groupPath) {
      const groupKey = groupPath || '__no_project__';
      const groupTasks = tasks.filter(t => ((t.projectPath || '').trim() || '__no_project__') === groupKey);
      if (groupTasks.length > 0 && orderedIds.length !== groupTasks.length) {
        throw new HttpError(400, `orderedIds 不完整：该组有 ${groupTasks.length} 个任务，但只传了 ${orderedIds.length} 个 id`);
      }
      const nonGroupIds = orderedIds.filter(id => {
        const t = tasks.find(x => x.id === id);
        return !t || ((t.projectPath || '').trim() || '__no_project__') !== groupKey;
      });
      if (nonGroupIds.length > 0) {
        throw new HttpError(400, `以下 id 不属于指定分组: ${nonGroupIds.slice(0, 3).join(',')}`);
      }
    }

    // 安全重排：用 Map 按序取
    const orderedSet = new Set(orderedIds);
    const byId = new Map(tasks.map(t => [t.id, t]));
    const reordered = [];
    let ptr = 0;
    for (const t of tasks) {
      if (orderedSet.has(t.id)) {
        if (ptr < orderedIds.length) {
          const target = byId.get(orderedIds[ptr++]);
          if (target) {
            reordered.push(target);
            continue;
          }
        }
        reordered.push(t);
      } else {
        reordered.push(t);
      }
    }
    // 最终校验：数量必须一致（绝对不能丢任务）
    if (reordered.length !== tasks.length) {
      logger.error('[reorder] 数据丢失风险！原始 %d 个，重排后 %d 个', tasks.length, reordered.length);
      throw new HttpError(500, '内部错误：重排结果数量不一致');
    }
    data.tasks = reordered;
    await writeJson(TASKS_FILE, data);
    publish('tasks:reordered', { tasks: reordered });
    res.json({ success: true, tasks: reordered });
  }));

  app.post('/api/workbench/tasks', asyncRoute(async (req, res) => {
    const { id, title, desc, promptId, simpleOverride } = req.body || {};
    const safeTitle = typeof title === 'string' ? title.trim() : '';
    const safeOverride = typeof simpleOverride === 'string' ? simpleOverride.slice(0, 8000) : '';
    // 显式指定的归属项目（多项目编排台传选中项目）；不传则沿用当前项目。
    // 只影响**新建**，更新分支一律保留任务原有的 projectPath（否则编辑一次就会把任务挪到当前项目去）。
    const bodyProjectPath = typeof req.body?.projectPath === 'string' ? req.body.projectPath.trim() : '';
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const tasks = data.tasks || [];
    const now = nowIso();
    const currentProjectPath = typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '';
    if (id) {
      const i = tasks.findIndex(t => t.id === id);
      if (i < 0) throw new HttpError(404, '任务不存在');
      tasks[i] = {
        ...tasks[i],
        title: safeTitle,
        desc: desc || '',
        promptId: promptId || null,
        simpleOverride: safeOverride,
        updatedAt: now
      };
      await writeJson(TASKS_FILE, { tasks });
      return res.json({ success: true, task: tasks[i] });
    }
    const task = {
      id: genId(),
      title: safeTitle,
      desc: desc || '',
      promptId: promptId || null,
      simpleOverride: safeOverride,
      projectPath: bodyProjectPath || currentProjectPath || '',
      status: 'todo',
      createdAt: now,
      updatedAt: now
    };
    tasks.push(task);
    await writeJson(TASKS_FILE, { tasks });
    res.json({ success: true, task });
  }));

  app.delete('/api/workbench/tasks/:id', asyncRoute(async (req, res) => {
    const taskId = req.params.id;
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const allTasks = data.tasks || [];
    const task = allTasks.find(t => t.id === taskId);
    if (!task) throw new HttpError(404, '任务不存在');

    // 检查活跃 job —— 有 running/pending 直接拒绝
    const live = [];
    for (const j of jobs.values()) {
      if (j.taskId !== taskId) continue;
      if (j.status === 'running' || j.status === 'pending') live.push(j.id);
    }
    if (live.length > 0) {
      throw new HttpError(400, `有 ${live.length} 个 job 正在执行,请先停止`);
    }

    // 清理磁盘上的图片目录（失败只 warn 不阻断）
    try {
      await fsp.rm(path.join(IMAGES_DIR, '_task-' + taskId), { recursive: true, force: true });
    } catch (e) {
      logger.warn(`[workbench] failed to remove task image dir for ${taskId}: ${e.message}`);
    }

    const tasks = allTasks.filter(t => t.id !== taskId);
    await writeJson(TASKS_FILE, { tasks });
    res.json({ success: true });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §12. 执行任务（每个任务都是一次会话）
  // ════════════════════════════════════════════════════════════════════════
  app.post('/api/workbench/tasks/:id/run', asyncRoute(async (req, res) => {
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const task = (data.tasks || []).find(t => t.id === req.params.id);
    if (!task) throw new HttpError(404, '任务不存在');
    // 兜底：磁盘上没有 running 状态，但还有 job 在跑（可能是别的 g ui 起的），也拦一下。
    // 先刷磁盘再取快照，否则另一个实例正在跑的这个任务会被重复起一份。
    await refreshJobsFromDisk();
    const liveJob = snapshotJobs().find(j => j.taskId === task.id && (j.status === 'running' || j.status === 'pending'));
    if (liveJob) throw new HttpError(400, '该任务已有正在执行的 job');
    const repoPath = resolveTaskRepoPath(task, typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '');
    const executor = await resolveExecutor(req.body?.executor);
    const virtualSub = {
      id: `${task.id}__simple`,
      title: task.title,
      desc: task.desc || '',
      status: 'todo',
      promptOverride: task.simpleOverride || '',
      attachments: Array.isArray(task.attachments) ? task.attachments : []
    };
    res.json({ success: true, message: '已开始执行任务' });
    runSingleSubtask(task, virtualSub, repoPath, '', { executor }).catch(err => {
      publish('task:error', { taskId: task.id, error: err.message });
    });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §13. Job 查询（兜底，SSE 断了也能拉）
  // ════════════════════════════════════════════════════════════════════════
  app.get('/api/workbench/jobs', asyncRoute(async (_req, res) => {
    // 与看板同源：磁盘 ∪ 内存（内存优先）。之前这里自己拼「文件 + 内存里非文件的」，
    // 优先级正好反过来 —— 正在跑的 job 显示的是磁盘上 1.5s 前的旧快照。
    await refreshJobsFromDisk();
    res.json({ success: true, jobs: snapshotJobs() });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §14. 取消正在执行的 job
  // ════════════════════════════════════════════════════════════════════════
  app.post('/api/workbench/jobs/:id/cancel', asyncRoute(async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      // 看板现在能看到**别的 g ui 实例**正在跑的 job(执行记录合并了),但 child 句柄
      // 只活在跑它的那个进程里 —— 这里停不了。给个说得清的理由,别让用户对着
      // "job 不存在"发懵(他明明在卡片上看着它转)。
      await refreshJobsFromDisk();
      throw new HttpError(404, mergedJobs().has(req.params.id)
        ? '这个任务正在另一个 g ui 实例里执行，请到那个窗口停止它'
        : 'job 不存在');
    }
    if (job.status !== 'running' && job.status !== 'pending') {
      throw new HttpError(400, `当前状态 ${job.status} 不可取消`);
    }
    cancelledJobs.add(job.id);
    // 立即给前端一个状态反馈（不等 child 真正退出）
    job.status = 'cancelled';
    job.error = '用户已停止执行';
    job.endedAt = nowIso();
    publish('job:update', { ...job }); // 浅拷贝避免序列化 child 引用
    // 终态：fire-and-forget 同步落盘
    flushJobsSaveNow().catch(err => logger.warn('[workbench] jobs save failed:', err.message));
    const child = job.child;
    if (!child) {
      return res.json({ success: true, message: '已标记取消，进程将尽快结束' });
    }
    try {
      if (process.platform === 'win32') {
        // Windows: child.kill(SIGTERM) 经常无效，用 taskkill 杀进程树
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (err) => {
          if (err) {
            logger.warn(`[workbench] taskkill ${child.pid} 失败: ${err.message}`);
          }
        });
      } else {
        child.kill('SIGTERM');
      }
      res.json({ success: true, message: '已发送停止信号' });
    } catch (err) {
      cancelledJobs.delete(job.id);
      throw new HttpError(500, '发送停止信号失败: ' + err.message);
    }
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §15. 续接简单任务对话（基于上一轮 claudeSessionId 用 --resume 续接）
  // ════════════════════════════════════════════════════════════════════════
  app.post('/api/workbench/jobs/:id/continue', asyncRoute(async (req, res) => {
    const userMessage = String(req.body?.userMessage || '').trim();
    if (!userMessage) throw new HttpError(400, 'userMessage 不能为空');
    const prevJob = jobs.get(req.params.id);
    if (!prevJob) throw new HttpError(404, 'job 不存在');
    if (prevJob.status === 'running' || prevJob.status === 'pending') {
      throw new HttpError(400, '上一轮还在执行,请等结束后再续接');
    }
    if (!prevJob.claudeSessionId) {
      throw new HttpError(400, '无法续接:会话标识未捕获');
    }
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const task = (data.tasks || []).find(t => t.id === prevJob.taskId);
    if (!task) throw new HttpError(404, '所属任务不存在');
    // 计算续接轮次号
    const subIdPrefix = `${task.id}__simple`;
    let maxRound = 0;
    for (const j of jobs.values()) {
      if (j.taskId !== task.id) continue;
      if (j.subId === subIdPrefix) continue;
      const m = j.subId && j.subId.match(/__simple__r(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!isNaN(n) && n > maxRound) maxRound = n;
      }
    }
    const nextRound = maxRound + 1;
    const bodyAtts = req.body?.attachments;
    const carryAtts = Array.isArray(bodyAtts) && bodyAtts.length > 0
      ? bodyAtts
      : (Array.isArray(task.attachments) ? task.attachments : []);
    const virtualSub = {
      id: `${task.id}__simple__r${nextRound}`,
      title: `续接 #${nextRound}`,
      desc: '',
      status: 'todo',
      promptOverride: userMessage,
      attachments: carryAtts
    };
    const repoPath = typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '';
    res.json({ success: true, message: '已加入续接队列' });
    // 执行器必须沿用上一轮 job 的 agent：claude 的 --resume 和 opencode 的 --session
    // 互不认对方的会话 id，串了执行器续接必然失败。
    runSingleSubtask(task, virtualSub, repoPath, '', {
      resumeSessionId: prevJob.claudeSessionId,
      executor: normalizeTaskExecutor(prevJob.agent)
    })
      .catch(err => {
        publish('task:error', { taskId: task.id, error: err.message });
      });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §16. 执行日志管理 API（持久化 + 清理）
  // /list、/config、/batch-delete、/clear 是字面路径，必须排在 :id 之前注册
  // ════════════════════════════════════════════════════════════════════════
  async function loadAllJobs() {
    // 与看板同源：磁盘 ∪ 内存（内存优先）。理由同 GET /api/workbench/jobs。
    await refreshJobsFromDisk();
    const tasksData = await readJson(TASKS_FILE, { tasks: [] });
    const taskMap = new Map((tasksData.tasks || []).map(t => [t.id, t]));
    return Array.from(mergedJobs().values()).map(j => serializeJob(j, taskMap));
  }

  function applyJobsFilter(list, q) {
    const status = (q.status || '').trim();
    const taskId = (q.taskId || '').trim();
    const term = (q.q || '').trim().toLowerCase();
    return list.filter(j => {
      if (status && j.status !== status) return false;
      if (taskId && j.taskId !== taskId) return false;
      if (term) {
        const hay = `${j.title || ''} ${j.taskTitle || ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }

  app.get('/api/workbench/jobs/list', asyncRoute(async (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const all = await loadAllJobs();
    const filtered = applyJobsFilter(all, req.query);
    const sortKey = (j) => j.endedAt || j.startedAt || j.id || '';
    filtered.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);
    const byStatus = {};
    let totalSize = 0;
    for (const j of all) {
      byStatus[j.status] = (byStatus[j.status] || 0) + 1;
      totalSize += j.size || 0;
    }
    res.json({
      success: true,
      jobs: page,
      total,
      stats: { count: all.length, sizeMB: +(totalSize / 1024 / 1024).toFixed(2), byStatus }
    });
  }));

  app.get('/api/workbench/jobs/config', asyncRoute(async (_req, res) => {
    res.json({ success: true, config: await readJobsConfig() });
  }));

  app.put('/api/workbench/jobs/config', asyncRoute(async (req, res) => {
    const cfg = await writeJobsConfig(req.body || {});
    // 配置变更后立刻 enforce，让已落盘的多余记录立刻被裁掉
    await enforceRetention();
    res.json({ success: true, config: cfg });
  }));

  app.post('/api/workbench/jobs/batch-delete', asyncRoute(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(s => typeof s === 'string') : [];
    if (ids.length === 0) return res.json({ success: true, removed: 0 });
    let removed = 0;
    for (const id of ids) {
      if (jobs.delete(id)) removed++;
    }
    const data = await readJson(JOBS_FILE, { version: 1, jobs: [] });
    if (data && Array.isArray(data.jobs)) {
      const set = new Set(ids);
      const before = data.jobs.length;
      data.jobs = data.jobs.filter(j => !set.has(j.id));
      removed += before - data.jobs.length;
      await writeJson(JOBS_FILE, data);
    }
    res.json({ success: true, removed });
  }));

  app.post('/api/workbench/jobs/clear', asyncRoute(async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, '需要 confirm: true');
    let removed = 0;
    for (const j of jobs.values()) {
      // 不清当前还在跑/排队的
      if (j.status === 'running' || j.status === 'pending') continue;
      jobs.delete(j.id);
      removed++;
    }
    await writeJson(JOBS_FILE, { version: 1, jobs: [] });
    res.json({ success: true, removed });
  }));

  app.delete('/api/workbench/jobs/by-task/:taskId', asyncRoute(async (req, res) => {
    const taskId = req.params.taskId;
    if (!taskId) throw new HttpError(400, '缺少 taskId');
    const keepDone = String(req.query.keepDone || '').toLowerCase() === 'true';
    const ids = [];
    for (const j of jobs.values()) {
      if (j.taskId !== taskId) continue;
      if (j.status === 'running' || j.status === 'pending') continue;
      if (keepDone && j.status === 'done') continue;
      jobs.delete(j.id);
      ids.push(j.id);
    }
    const data = await readJson(JOBS_FILE, { version: 1, jobs: [] });
    if (data && Array.isArray(data.jobs)) {
      const before = data.jobs.length;
      data.jobs = data.jobs.filter(j => {
        if (j.taskId !== taskId) return true;
        if (keepDone && j.status === 'done') return true;
        return !ids.includes(j.id);
      });
      const removed = before - data.jobs.length;
      if (removed > 0) await writeJson(JOBS_FILE, data);
      return res.json({ success: true, removed: ids.length + removed, ids });
    }
    res.json({ success: true, removed: ids.length, ids });
  }));

  app.post('/api/workbench/tasks/:id/clear-execution', asyncRoute(async (req, res) => {
    const taskId = req.params.id;
    if (!taskId) throw new HttpError(400, '缺少 taskId');
    // 检查活跃 job
    const live = [];
    for (const j of jobs.values()) {
      if (j.taskId !== taskId) continue;
      if (j.status === 'running' || j.status === 'pending') live.push(j.id);
    }
    if (live.length > 0) {
      throw new HttpError(400, `有 ${live.length} 个 job 正在执行,请先停止`);
    }
    // 1) 清空 jobs(内存 + 磁盘)
    const removedJobIds = [];
    for (const j of jobs.values()) {
      if (j.taskId !== taskId) continue;
      jobs.delete(j.id);
      removedJobIds.push(j.id);
    }
    const jobsData = await readJson(JOBS_FILE, { version: 1, jobs: [] });
    if (jobsData && Array.isArray(jobsData.jobs)) {
      const before = jobsData.jobs.length;
      jobsData.jobs = jobsData.jobs.filter(j => j.taskId !== taskId);
      if (jobsData.jobs.length !== before) await writeJson(JOBS_FILE, jobsData);
    }
    // 2) 不用再改任务本体 —— 看板列完全由 job 推导，job 没了自然回到「待执行」
    res.json({
      success: true,
      removedJobs: removedJobIds.length,
      message: `已清空 ${removedJobIds.length} 条执行记录`
    });
  }));

  app.post('/api/workbench/tasks/:id/reset-shell', asyncRoute(async (req, res) => {
    const taskId = req.params.id;
    if (!taskId) throw new HttpError(400, '缺少 taskId');
    const live = [];
    for (const j of jobs.values()) {
      if (j.taskId !== taskId) continue;
      if (j.status === 'running' || j.status === 'pending') live.push(j.id);
    }
    if (live.length > 0) {
      throw new HttpError(400, `有 ${live.length} 个 job 正在执行,请先停止`);
    }
    const removedJobIds = [];
    for (const j of jobs.values()) {
      if (j.taskId !== taskId) continue;
      jobs.delete(j.id);
      removedJobIds.push(j.id);
    }
    const jobsData = await readJson(JOBS_FILE, { version: 1, jobs: [] });
    if (jobsData && Array.isArray(jobsData.jobs)) {
      const before = jobsData.jobs.length;
      jobsData.jobs = jobsData.jobs.filter(j => j.taskId !== taskId);
      if (jobsData.jobs.length !== before) await writeJson(JOBS_FILE, jobsData);
    }
    const tasksData = await readJson(TASKS_FILE, { tasks: [] });
    const task = (tasksData.tasks || []).find(t => t.id === taskId);
    if (!task) {
      return res.json({ success: true, removedJobs: removedJobIds.length, message: '任务不存在,仅清空 job' });
    }
    const removedAttCount = Array.isArray(task.attachments) ? task.attachments.length : 0;
    const hadDesc = !!(task.desc && task.desc.length > 0);
    const hadPrompt = !!task.promptId;
    const preservedProjectPath = task.projectPath;
    const preservedCreatedAt = task.createdAt;
    const preservedStatus = task.status || 'todo';
    const newTask = { id: task.id, title: task.title, status: preservedStatus };
    if (preservedProjectPath) newTask.projectPath = preservedProjectPath;
    if (preservedCreatedAt) newTask.createdAt = preservedCreatedAt;
    newTask.attachments = [];
    newTask.updatedAt = nowIso();
    for (const k of Object.keys(task)) delete task[k];
    Object.assign(task, newTask);
    await writeJson(TASKS_FILE, tasksData);
    publish('task:update', task);
    res.json({
      success: true,
      removedJobs: removedJobIds.length,
      removedAttachments: removedAttCount,
      clearedDesc: hadDesc,
      clearedPrompt: hadPrompt,
      message: `已清空:${removedAttCount ? '删除 ' + removedAttCount + ' 个附件' : '无附件'}${hadDesc ? '、任务描述' : ''},任务标题保留`
    });
  }));


  // GET /api/workbench/jobs/:id  (放在所有字面路径之后)
  app.get('/api/workbench/jobs/:id', asyncRoute(async (req, res) => {
    // 优先查内存（含活跃）
    const live = jobs.get(req.params.id);
    if (live) {
      const tasksData = await readJson(TASKS_FILE, { tasks: [] });
      const taskMap = new Map((tasksData.tasks || []).map(t => [t.id, t]));
      return res.json({ success: true, job: serializeJob(live, taskMap) });
    }
    // 退回文件
    const data = await readJson(JOBS_FILE, { version: 1, jobs: [] });
    const j = (data.jobs || []).find(x => x.id === req.params.id);
    if (!j) throw new HttpError(404, 'job 不存在');
    res.json({ success: true, job: j });
  }));

  app.delete('/api/workbench/jobs/:id', asyncRoute(async (req, res) => {
    const id = req.params.id;
    let removed = false;
    if (jobs.delete(id)) removed = true;
    const data = await readJson(JOBS_FILE, { version: 1, jobs: [] });
    if (data && Array.isArray(data.jobs)) {
      const before = data.jobs.length;
      data.jobs = data.jobs.filter(j => j.id !== id);
      if (data.jobs.length !== before) {
        removed = true;
        await writeJson(JOBS_FILE, data);
      }
    }
    if (!removed) throw new HttpError(404, 'job 不存在');
    res.json({ success: true, removed: 1 });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §17. 附件：上传 / 删除 / 原文件读取
  // ════════════════════════════════════════════════════════════════════════
  const rawAttachment = express.raw({
    type: '*/*',
    // 路由上限 = 单文件上限的 2 倍：留出余量让超限请求落到业务层的 413（带"不得超过 XX MB"
    // 的可读文案），而不是 body-parser 直接抛的裸 entity.too.large
    limit: MAX_IMAGE_BYTES * 2
  });

  // 共享 helper：找到一个 attachment 所在的位置
  async function findAttachmentLocation(attId) {
    const data = await readJson(TASKS_FILE, { tasks: [] });
    for (const t of data.tasks || []) {
      const list = Array.isArray(t.attachments) ? t.attachments : [];
      const att = list.find(x => x.id === attId);
      if (att) {
        return { owner: 'task', task: t, list, att, storageDir: path.join(IMAGES_DIR, '_task-' + t.id) };
      }
    }
    return null;
  }

  // 共享 helper：写入新附件
  async function writeAttachmentTo({ req, target, maxCount }) {
    if (!req.body || !(req.body instanceof Buffer) || req.body.length === 0) {
      throw new HttpError(400, '请求体为空');
    }
    if (req.body.length > MAX_IMAGE_BYTES) {
      throw new HttpError(413, `单文件不得超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`);
    }
    const originalName = String(req.get('X-Original-Name') || 'attachment').slice(0, 200);
    const mimeType = String(req.get('X-Mime-Type') || 'application/octet-stream').slice(0, 120);
    const ext = resolveExt({ originalName, mime: mimeType });
    if (!ext) {
      throw new HttpError(400, `不支持的文件类型（仅允许 ${[...ALLOWED_EXTS].join(', ')}）`);
    }
    if (!Array.isArray(target.attachments)) target.attachments = [];
    if (target.attachments.length >= maxCount) {
      throw new HttpError(400, `附件已达上限 ${maxCount} 个`);
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
    return attachment;
  }

  // 子任务附件
  // 任务附件
  app.post('/api/workbench/tasks/:taskId/attachments', rawAttachment, asyncRoute(async (req, res) => {
    const { taskId } = req.params;
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const task = (data.tasks || []).find(t => t.id === taskId);
    if (!task) throw new HttpError(404, '任务不存在');
    const target = { ...task, storageDir: path.join(IMAGES_DIR, '_task-' + taskId) };
    const att = await writeAttachmentTo({ req, target, maxCount: MAX_ATTACHMENTS_PER_TASK });
    task.attachments = Array.isArray(task.attachments) ? task.attachments : [];
    task.attachments.push(att);
    task.updatedAt = nowIso();
    await writeJson(TASKS_FILE, data);
    res.json({ success: true, attachment: att });
  }));

  app.delete('/api/workbench/tasks/:taskId/attachments/:attId', asyncRoute(async (req, res) => {
    const { taskId, attId } = req.params;
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const task = (data.tasks || []).find(t => t.id === taskId);
    if (!task) throw new HttpError(404, '任务不存在');
    const list = Array.isArray(task.attachments) ? task.attachments : [];
    const i = list.findIndex(a => a.id === attId);
    if (i < 0) throw new HttpError(404, '附件不存在');
    const [removed] = list.splice(i, 1);
    try {
      await fsp.unlink(path.join(IMAGES_DIR, '_task-' + taskId, removed.storedName));
    } catch { /* 文件可能已不存在 */ }
    task.updatedAt = nowIso();
    await writeJson(TASKS_FILE, data);
    res.json({ success: true });
  }));

  // 附件原文件读取（前端 <img> 缩略图用）—— 支持 task 和 sub 两种归属
  app.get('/api/workbench/attachments/:attId/raw', asyncRoute(async (req, res) => {
    const { attId } = req.params;
    const loc = await findAttachmentLocation(attId);
    if (!loc) throw new HttpError(404, '附件不存在');
    const filePath = path.join(loc.storageDir, loc.att.storedName);
    try {
      const stat = await fsp.stat(filePath);
      res.set('Content-Type', loc.att.mimeType || 'application/octet-stream');
      res.set('Content-Length', String(stat.size));
      res.set('Cache-Control', 'private, max-age=3600');
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => res.end());
      stream.pipe(res);
    } catch {
      throw new HttpError(404, '文件已丢失');
    }
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §16. 多项目编排台（L1 看板 + 主 Agent 控制台）
  //   GET  /api/workbench/projects               项目清单 + 看板任务
  //   GET  /api/workbench/orchestrator           调度开关 + 指令存档 + 活动流 + 默认提示词
  //   POST /api/workbench/orchestrator/state     暂停 / 恢复调度
  //   POST /api/workbench/orchestrator/dispatch  派发一条人类干预指令
  //   POST /api/workbench/orchestrator/default-prompt   写全局默认提示词
  //   POST /api/workbench/orchestrator/project-prompt   写某个项目的默认提示词
  //
  // 「暂停调度」的实际语义：只拦**自动派发**（dispatch 里带 autoRun），
  // 手动点执行 / 子任务执行一概不受影响 —— 暂停的是主 Agent 的自主行为，
  // 不是把用户的手也一起绑住。
  // ════════════════════════════════════════════════════════════════════════

  /**
   * 组装「项目清单 + 看板任务」。
   *
   * 要探测 Git 状态的路径全部来自**服务端可信来源** —— configManager 的最近目录
   * 与 tasks.json 里已有的 projectPath。本路由不接受任何客户端传入的路径，
   * 因此不会被当成「任意路径 git 探测」的口子（口径同 /api/recent_directories/git-state）。
   */
  async function loadBoardPayload() {
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const tasks = data.tasks || [];
    // 看板列（待处理/进行中/已完成）全由执行记录推导，而执行记录是「跨 g ui 实例共享
    // 在 jobs.json 里、本进程内存只持有自己跑的那些」——所以取快照前必须刷一次磁盘，
    // 否则另一个实例刚跑完的任务在本实例看板上会一直停在"待处理"。
    // 看板 5s 轮询一次，代价是 mtime 没变时的一个 stat。
    await refreshJobsFromDisk();
    const jobsSnap = snapshotJobs();

    let recentDirs = [];
    try {
      if (configManager && typeof configManager.getRecentDirectories === 'function') {
        recentDirs = (await configManager.getRecentDirectories()) || [];
      }
    } catch (err) {
      // 最近目录读不到不该让整个看板挂掉：退化成"只按任务里出现过的项目"生成清单
      logger.warn('[workbench] 读取最近目录失败，项目清单退化为仅按任务路径生成:', err.message);
    }

    const currentProjectPath = typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '';
    // Git 探测自带 15s TTL 缓存（directoryGitState.js），看板 5s 轮询里有 2/3 是命中缓存，
    // 实际 spawn 频率被自然限制在 15s 一次，不需要再给这个接口加"跳过一次探测"的开关。
    const projects = await listProjects({ recentDirs, tasks, jobs: jobsSnap, currentProjectPath });
    const jobsByTask = groupJobsByTask(jobsSnap);
    const boardTasks = tasks.map(t => decorateTaskForBoard(t, jobsByTask.get(t.id) || []));
    return { projects, tasks: boardTasks, currentProjectPath };
  }

  /**
   * 注册「运行环境上下文」的提供者 —— 执行引擎（taskRunner）拼 prompt 时会回调它。
   *
   * 为什么在这一层注册：只有这里同时拿得到 configManager（最近目录）与 jobStore
   * 的 job 快照；taskRunner 两个都没有，放它那儿就得再造一条「读最近目录」的路径，
   * 也就是又一次口径分叉。
   *
   * 复用 buildProjectEntries + summarizeProjectTasks（与看板同一套口径），
   * 但**刻意不走** listProjects：那是给看板用的，会去 spawn git 探状态。
   * 分支、改动数这类信息 Agent 在自己的 cwd 里一条 git 命令就有，
   * 不值得为它在这里每次执行都多探一轮。
   */
  setEnvContextProvider(async ({ repoPath } = {}) => {
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const tasks = data.tasks || [];
    // 任务状态同样由执行记录推导：不刷磁盘的话，Agent 看到的会是本进程启动那一刻的
    // 旧状态（别的 g ui 跑完的任务在它眼里还没完成）。
    await refreshJobsFromDisk();

    let recentDirs = [];
    try {
      if (configManager && typeof configManager.getRecentDirectories === 'function') {
        recentDirs = (await configManager.getRecentDirectories()) || [];
      }
    } catch (err) {
      // 与 loadBoardPayload 同一处理：读不到最近目录就退化成"只按任务里出现过的项目"
      logger.warn('[workbench] 注入运行环境上下文时读取最近目录失败，退化为仅按任务路径:', err.message);
    }

    const projects = buildProjectEntries({ recentDirs, tasks });
    return buildEnvContextBlock({
      currentProjectPath: repoPath || '',
      projects,
      tasks,
      jobs: snapshotJobs(),
      tasksFile: TASKS_FILE,
      jobsFile: JOBS_FILE,
      orchestratorFile: ORCHESTRATOR_FILE,
      configFile: CONFIG_FILE,
    });
  });

  app.get('/api/workbench/projects', asyncRoute(async (_req, res) => {
    const payload = await loadBoardPayload();
    res.json({ success: true, ...payload });
  }));

  /**
   * 单个任务的详情 —— 点看板卡片弹出的那个框用它。
   *
   * 为什么不把详情并进 /projects：那个接口是 5s 轮询的，只该发摘要
   * （decorateTaskForBoard）。把子任务描述、报错、执行输出一起推，
   * 十几条任务每 5 秒来一遍，纯属浪费带宽和解析时间。
   * 这里按需取一次，且 output 由 trimJobForDetail 在服务端截尾。
   *
   * 注册位置：字面量路径 /tasks/ai-* 都在上面且只有一段，
   * :id/detail 是两段，不会互相抢匹配。
   */
  app.get('/api/workbench/tasks/:id/detail', asyncRoute(async (req, res) => {
    const id = req.params.id;
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const task = (data.tasks || []).find(t => t && t.id === id);
    if (!task) throw new HttpError(404, '任务不存在');

    // loadAllJobs 已经把「文件里归档的 + 内存里还活着的」合并过（含 taskTitle）
    const allJobs = await loadAllJobs();
    const detail = buildTaskDetail(task, allJobs.filter(j => j && j.taskId === id));
    if (!detail) throw new HttpError(404, '任务不存在');

    res.json({ success: true, ...detail });
  }));

  app.get('/api/workbench/orchestrator', asyncRoute(async (_req, res) => {
    const state = await readOrchestrator();
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const tasks = data.tasks || [];
    // 同 loadBoardPayload：活动流 / 正在跑的 Agent 都从执行记录来，先刷磁盘才能看到
    // 别的 g ui 实例跑出来的记录（前端的「今日完成」也是数这份 activity）。
    await refreshJobsFromDisk();
    const jobsSnap = snapshotJobs();
    res.json({
      success: true,
      active: state.active,
      updatedAt: state.updatedAt,
      instructions: state.instructions,
      // 默认提示词跟着这份状态一起下发：控制台要拿它显示"当前会附带什么"，
      // 设置弹窗打开时也不必再单独取一次（单条上限 8000 字，体积可控）
      defaultPrompt: state.defaultPrompt,
      projectPrompts: state.projectPrompts,
      activity: buildActivityFeed({ jobs: jobsSnap, tasks, instructions: state.instructions }),
      running: buildRunningAgents({ jobs: jobsSnap, tasks }),
    });
  }));

  app.post('/api/workbench/orchestrator/state', asyncRoute(async (req, res) => {
    const active = req.body?.active;
    if (typeof active !== 'boolean') throw new HttpError(400, 'active 必须是布尔值');
    const state = await setOrchestratorActive(active);
    publish('orchestrator:state', { active: state.active, updatedAt: state.updatedAt });
    res.json({ success: true, active: state.active, updatedAt: state.updatedAt });
  }));

  /** 提示词参数校验：空串是合法值（= 清除），只拦超长与非字符串 */
  function assertPromptText(prompt) {
    if (typeof prompt !== 'string') throw new HttpError(400, 'prompt 必须是字符串');
    if (prompt.length > MAX_DEFAULT_PROMPT_CHARS) {
      throw new HttpError(400, `默认提示词过长（上限 ${MAX_DEFAULT_PROMPT_CHARS} 字）`);
    }
  }

  /**
   * 写**全局**默认提示词。body: { prompt }
   *
   * 存的是"派发时自动附加的约束"，不是某条任务的内容 —— 改它只影响**之后**的派发：
   * 已建任务在派发那一刻就把当时生效的提示词抄进了自己的 simpleOverride，
   * 事后改设置不会去动历史任务（否则用户改一次设置，一批跑过的任务描述就对不上了）。
   */
  app.post('/api/workbench/orchestrator/default-prompt', asyncRoute(async (req, res) => {
    assertPromptText(req.body?.prompt);
    const defaultPrompt = await setDefaultPrompt(req.body.prompt);
    res.json({ success: true, defaultPrompt });
  }));

  /**
   * 写**某个项目**的默认提示词。body: { projectPath, prompt }
   *
   * 只接受项目清单里真实存在的路径：这张表的键就是项目 key，不校验的话
   * 请求体里的任意字符串都能往里塞（那些键永远不会被读到，只会把文件撑大）。
   */
  app.post('/api/workbench/orchestrator/project-prompt', asyncRoute(async (req, res) => {
    const projectPath = typeof req.body?.projectPath === 'string' ? req.body.projectPath.trim() : '';
    if (!projectPath) throw new HttpError(400, 'projectPath 不能为空');
    assertPromptText(req.body?.prompt);

    const data = await readJson(TASKS_FILE, { tasks: [] });
    let recentDirs = [];
    try {
      if (configManager && typeof configManager.getRecentDirectories === 'function') {
        recentDirs = (await configManager.getRecentDirectories()) || [];
      }
    } catch (err) {
      logger.warn('[workbench] 写项目提示词时读取最近目录失败，仅按任务路径校验:', err.message);
    }
    const key = canonicalProjectPath(projectPath);
    const known = buildProjectEntries({ recentDirs, tasks: data.tasks || [] });
    if (!key || !known.some(e => e.key === key)) {
      throw new HttpError(400, `项目不在清单里：${projectPath}`);
    }

    const projectPrompts = await setProjectPrompt({ projectPath, prompt: req.body.prompt });
    res.json({ success: true, projectPrompts });
  }));

  /**
   * 派发一条指令。
   * body: { text, projectPath?, autoRun? }
   *   - projectPath 缺省 -> 交给 targetResolver 判断落到哪个项目（显式指定 > 指令里点名
   *     > 主 Agent 判断 > 应用当前项目）。用户不必先选项目，落点会如实记进指令流水
   *   - autoRun 默认 true；调度暂停时只建任务不执行（指令记录里会写明原因）
   *
   * 一条指令落成目标项目下的一个任务：整段指令就是那次会话的 prompt。
   */
  app.post('/api/workbench/orchestrator/dispatch', asyncRoute(async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) throw new HttpError(400, '指令内容不能为空');
    if (text.length > 4000) throw new HttpError(400, '指令过长（上限 4000 字）');

    const fallbackPath = typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '';
    const bodyPath = typeof req.body?.projectPath === 'string' ? req.body.projectPath.trim() : '';

    // 先把任务与项目清单读出来：解析落点要用它们。
    // 清单复用 buildProjectEntries（与看板 / 运行环境上下文同一套口径），
    // 刻意**不走** listProjects —— 那会 spawn git，派发不值得为它多等一轮。
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const tasks = data.tasks || [];

    let recentDirs = [];
    try {
      if (configManager && typeof configManager.getRecentDirectories === 'function') {
        recentDirs = (await configManager.getRecentDirectories()) || [];
      }
    } catch (err) {
      logger.warn('[workbench] 派发时读取最近目录失败，落点解析退化为仅按任务路径:', err.message);
    }

    const target = await resolveInstructionTarget({
      text,
      projects: buildProjectEntries({ recentDirs, tasks }),
      explicitPath: bodyPath,
      defaultPath: fallbackPath,
      // 懒取模型：只有「指令里没点名、也没被显式指定」时才会真的读 config 去问模型
      getModel: async () => {
        if (!configManager) return null;
        const rawConfig = await configManager.readRawConfigFile();
        const models = Array.isArray(rawConfig.models) ? rawConfig.models : [];
        return models.find(m => m.isDefault) || models[0] || null;
      },
      onAgentError: (err) => {
        logger.warn('[workbench] 主 Agent 判断指令落点失败，退到默认项目:', err.message);
      },
    });

    const targetPath = target.path;
    if (!targetPath) {
      throw new HttpError(400, '没能识别出目标项目，也没有默认项目可用 —— 先在左侧打开或选一个项目');
    }

    // 目标目录必须真的存在：跑在不存在的工作区上只会拿到一堆无意义的报错
    let stat = null;
    try { stat = await fsp.stat(targetPath); } catch { /* 下面统一报错 */ }
    if (!stat || !stat.isDirectory()) {
      const rejected = await appendInstruction({
        text,
        projectPath: targetPath,
        status: 'rejected',
        reason: '项目目录不存在',
        targetSource: target.source,
      });
      publish('orchestrator:instruction', rejected);
      throw new HttpError(400, `项目目录不存在：${targetPath}`);
    }

    const autoRun = req.body?.autoRun !== false;
    // 调度开关与默认提示词同在一份 state 里，只读一次：
    // 分开读两次必然出现"读到的是两个瞬间"的窗口（改设置的同时派发）。
    const orchestratorState = await readOrchestrator();
    const schedulingActive = orchestratorState.active;

    // 默认提示词按**落点项目**解析：全局那条对所有项目生效，项目级那条只在这个项目追加。
    // useDefaultPrompt=false 是"这一次不附加" —— 全局提示词若没法单次关掉，
    // 偶尔发一条纯指令就得先去设置里把它删了，再粘回来。
    const dispatchPrompt = req.body?.useDefaultPrompt === false
      ? { text: '', source: '' }
      : resolveDispatchPrompt(orchestratorState, targetPath);

    // ── 附件：前端只回传 { id, ext, originalName }，服务端按 id 回暂存区找文件 ──
    // 路径完全由服务端拼（stagingPath 会同时校验 id 形状与 ext 白名单），
    // 所以不存在"前端指定任意路径"这回事 —— 比"信任 absolutePath 再校验前缀"干净。
    // 数量与文件存在性在这里统一校验：上传时服务端是无状态的，压根不知道前端一共攒了几个。
    const rawAttachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    if (rawAttachments.length > MAX_ATTACHMENTS_PER_TASK) {
      throw new HttpError(400, `附件最多 ${MAX_ATTACHMENTS_PER_TASK} 个`);
    }
    const staged = [];
    for (const item of rawAttachments) {
      const attId = typeof item?.id === 'string' ? item.id : '';
      const ext = typeof item?.ext === 'string' ? item.ext : '';
      const from = stagingPath(attId, ext);
      if (!from) throw new HttpError(400, '附件参数不合法');
      let attStat = null;
      try { attStat = await fsp.stat(from); } catch { /* 下面统一报错 */ }
      if (!attStat || !attStat.isFile()) throw new HttpError(400, '附件已失效，请重新添加');
      staged.push({
        id: attId,
        ext,
        from,
        size: attStat.size,
        originalName: String(item?.originalName || `attachment.${ext}`).slice(0, 200),
      });
    }

    // tasks / data 已在上面读好（落点解析要用），这里不再重复读一遍
    const now = nowIso();
    const taskId = genId();

    // 附件从暂存区搬进任务自己的目录（`_task-{id}/`），这样删除任务时会被一并清掉
    const attachmentDir = path.join(IMAGES_DIR, '_task-' + taskId);
    const attachments = [];
    if (staged.length > 0) {
      await fsp.mkdir(attachmentDir, { recursive: true });
      for (const s of staged) {
        const storedName = `${s.id}.${s.ext}`;
        const dest = path.join(attachmentDir, storedName);
        try {
          await fsp.rename(s.from, dest);
        } catch {
          // 极端情况（跨卷等）退化成复制 + 删除；仍失败就跳过这个附件，
          // 而不是让整条指令派发不出去 —— 指令本身是好的，不该被一个文件拖死。
          try {
            await fsp.copyFile(s.from, dest);
            await fsp.unlink(s.from);
          } catch { continue; }
        }
        attachments.push({
          id: s.id,
          originalName: s.originalName,
          mimeType: mimeForExt(s.ext),
          size: s.size,
          ext: s.ext,
          storedName,
          absolutePath: dest,
          createdAt: now,
        });
      }
    }

    const task = {
      id: taskId,
      // 标题取指令首行并截断：看板卡片只占一行，整段指令塞进标题会把卡片撑爆
      title: text.split('\n')[0].slice(0, 120),
      desc: text,
      promptId: null,
      // 默认提示词在派发这一刻抄进任务（这次生效的是什么，任务自己记着）。
      // 之后用户改设置不会回头改写它 —— 一条已存在的任务，"它当时是被怎么派出去的"
      // 是既成事实，不是当前配置的投影。
      simpleOverride: dispatchPrompt.text,
      projectPath: targetPath,
      attachments,
      status: 'todo',
      createdAt: now,
      updatedAt: now,
    };
    tasks.push(task);
    await writeJson(TASKS_FILE, { tasks });

    const willRun = autoRun && schedulingActive;
    const record = await appendInstruction({
      text,
      projectPath: targetPath,
      taskId: task.id,
      status: willRun ? 'accepted' : 'created',
      reason: autoRun && !schedulingActive ? '调度已暂停，只建了任务未执行' : '',
      // 落点是怎么定下来的（explicit / mention / agent / default），
      // 记下来才能在流水里回答用户那句"为什么派到这儿了"
      targetSource: target.source,
      // 附带的是哪一级默认提示词（'' = 没带）。流水里要能说清"这段话是谁加的"
      promptSource: dispatchPrompt.source,
    });

    publish('task:created', { task });
    publish('orchestrator:instruction', record);

    // 与 POST /tasks/:id/run 走同一条执行路径，避免出现第二套执行入口
    if (willRun) {
      const virtualSub = {
        id: `${task.id}__simple`,
        title: task.title,
        desc: task.desc || '',
        status: 'todo',
        // 提示词取自 task.simpleOverride（派发时已把
        // 全局/项目默认提示词抄进去），而不是在这里再解析一次配置
        promptOverride: task.simpleOverride || '',
        attachments: [],
      };
      // 派发控制台可以显式指定执行器；不传则用配置里的全局默认（resolveExecutor 走回落链）
      const executor = await resolveExecutor(req.body?.executor);
      runSingleSubtask(task, virtualSub, targetPath, '', { executor }).catch(err => {
        publish('task:error', { taskId: task.id, error: err.message });
      });
    }

    res.json({ success: true, task, instruction: record, ran: willRun, schedulingActive, target });
  }));

  /**
   * 派发前把附件落到暂存区。
   *
   * 为什么需要这一层：§17 的上传端点都要求 taskId / subId 当挂载点，而派发这一刻
   * 任务还不存在。所以先写进 `_dispatch/`，**不写任何 JSON** —— 附件记录回给前端持有，
   * 派发时再按 id 搬进任务目录。
   * 代价是服务端在这里无状态：它不知道前端一共攒了几个，附件数上限只能在派发时统一卡。
   */
  app.post('/api/workbench/orchestrator/attachments', rawAttachment, asyncRoute(async (req, res) => {
    await fsp.mkdir(DISPATCH_STAGING_DIR, { recursive: true });
    const target = { attachments: [], storageDir: DISPATCH_STAGING_DIR };
    const att = await writeAttachmentTo({ req, target, maxCount: MAX_ATTACHMENTS_PER_TASK });
    res.json({ success: true, attachment: att });
  }));

  /** 撤掉一个还没派发的附件（用户点了 ×）。id 形状不合法一律 404，不做路径拼接。 */
  app.delete('/api/workbench/orchestrator/attachments/:attId', asyncRoute(async (req, res) => {
    const full = await findStagingFile(req.params.attId);
    if (!full) throw new HttpError(404, '附件不存在');
    try { await fsp.unlink(full); } catch { /* 文件可能已不在 */ }
    res.json({ success: true });
  }));

  /** 暂存附件的缩略图 / 预览。与 §17 的 raw 端点同形，只是从暂存区取 */
  app.get('/api/workbench/orchestrator/attachments/:attId/raw', asyncRoute(async (req, res) => {
    const full = await findStagingFile(req.params.attId);
    if (!full) throw new HttpError(404, '附件不存在');
    const ext = path.extname(full).slice(1).toLowerCase();
    try {
      const st = await fsp.stat(full);
      res.set('Content-Type', mimeForExt(ext));
      res.set('Content-Length', String(st.size));
      res.set('Cache-Control', 'private, max-age=3600');
      const stream = fs.createReadStream(full);
      stream.on('error', () => res.end());
      stream.pipe(res);
    } catch {
      throw new HttpError(404, '文件已丢失');
    }
  }));

  // 暂存区兜底清理：粘了图却没派发就关页面的痕迹，不该永久占着磁盘。
  // 不上定时器 —— 暂存区的生命周期本来就是"几分钟内被派发掉"，启动清一次足够。
  cleanupDispatchStaging().catch(err => {
    logger.warn('[workbench] 清理派发附件暂存区失败:', err.message);
  });
}

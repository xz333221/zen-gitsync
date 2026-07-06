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
//   - jsonParse.js       JSON 解析降级链 (parseSubtaskJson 等)
//   - llmClient.js       LLM 客户端 (callLlmJson, callLlmStream)
//   - projectScan.js     子项目识别 (findSubProjects, detectProjectManifest)
//   - attachmentUtils.js 附件白名单 (sanitizeExt, resolveExt, MIME_TO_EXT)
//   - sessionStore.js    AI 对话拆分会话持久化
//   - instructionStore.js AI 指令读写
//   - jobStore.js        jobs Map + bus + 持久化 + retention
//   - taskRunner.js      任务执行引擎 (runTaskQueue, runSingleSubtask)
//
// 本文件（index.js）只做 registerWorkbenchRoutes 入口聚合，按业务域分节注册 45 个路由。
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
  JOBS_FILE,
  IMAGES_DIR,
  SUBTASK_INSTRUCTION_FILE,
  MAX_IMAGE_BYTES,
  MAX_ATTACHMENTS_PER_SUBTASK,
  readJson,
  writeJson,
  nowIso,
  genId,
} from './shared.js';
import { parseSubtaskJson } from './jsonParse.js';
import { callLlmJson, callLlmJsonWithRetry, callLlmStream } from './llmClient.js';
import {
  findSubProjects,
  detectProjectManifest,
  readProjectManifest,
  listDirTree,
  safeReadFile,
} from './projectScan.js';
import { isImageExt, resolveExt, ALLOWED_EXTS, ensureImagesDir } from './attachmentUtils.js';
import { sessionStore } from './sessionStore.js';
import {
  DEFAULT_INSTRUCTION,
  DEFAULT_SUBTASK_INSTRUCTION_ZH,
  pickDefaultSubtaskInstruction,
  readInstruction,
  writeInstruction,
  readSubtaskInstruction,
  writeSubtaskInstruction,
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
} from './jobStore.js';
import {
  launchClaudeInNewWindow,
  runTaskQueue,
  runSingleSubtask,
  syncSubToCancelled,
  persistTaskAfterRun,
  collectPriorOutputs,
  collectPriorOutputsUpTo,
  waitProcessExit,
} from './taskRunner.js';

const { genSessionId, read: readSessionFile, write: writeSessionFile, delete: deleteSessionFile, listMeta: listSessionsMeta, enforceRetention: enforceSessionsRetention } = sessionStore;

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
  // §3. AI 拆分子任务指令：读 / 写
  // ════════════════════════════════════════════════════════════════════════
  app.get('/api/workbench/tasks/ai-subtask-instruction', asyncRoute(async (req, res) => {
    const def = pickDefaultSubtaskInstruction(req);
    const instruction = await readSubtaskInstruction(req);
    res.json({ success: true, instruction, isDefault: instruction === def });
  }));

  app.put('/api/workbench/tasks/ai-subtask-instruction', asyncRoute(async (req, res) => {
    const text = req.body && typeof req.body.instruction === 'string'
      ? req.body.instruction.trim()
      : '';
    if (!text) throw new HttpError(400, '指令不能为空');
    if (text.length > 500000) throw new HttpError(413, '指令过长（最多 500000 字符）');
    // 如果保存的文本正好等于当前 locale 的默认——不写文件，保持 fallback 行为
    const def = pickDefaultSubtaskInstruction(req);
    if (text === def) {
      try { await fsp.unlink(SUBTASK_INSTRUCTION_FILE); } catch { /* 已不存在 */ }
      return res.json({ success: true, isDefault: true });
    }
    await writeSubtaskInstruction(text);
    res.json({ success: true, isDefault: false });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §4. AI 拆分子任务（SSE 流式）— 保留 try/catch，错误以 SSE 帧发出
  // ════════════════════════════════════════════════════════════════════════
  app.post('/api/workbench/tasks/ai-split-subtasks', async (req, res) => {
    const title = String(req.body?.title || '').trim();
    const desc = String(req.body?.desc || '').trim();
    const taskId = String(req.body?.taskId || '').trim();
    const promptId = String(req.body?.promptId || '').trim();
    const customUserBlock = typeof req.body?.customUserBlock === 'string' ? req.body.customUserBlock : '';
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
    let finished = false;
    // 客户端真实断开：监听 socket close
    const onSocketClose = () => {
      if (!finished) abortController.abort();
    };
    if (req.socket) req.socket.once('close', onSocketClose);

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

      // 取绑定的预置模板（promptId）
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

      const userBlock = customUserBlock.trim() ? customUserBlock : `${userInstruction}

---

## 待拆分的任务
标题：${title}
${desc ? `描述：${desc}` : '描述：（无）'}${attachmentBlock}${templateBlock}

## 项目上下文（仅供参考，便于拆分时考虑项目特性）
- 项目名称：${projectName}
- 项目根目录：${projectPath || '（未指定）'}
- 主要 manifest：${manifestHint || '（未识别到）'}

请先仔细分析（可以放在 reasoning 中或直接写出来）。仔细分析指：列出 5 个维度——任务真实目标 / 关键技术栈与边界 / 自然执行顺序 / 风险点与可能失败步骤 / 是否需要前置调研——不要简短一两句话就过；分析过后再给出 JSON。JSON 用 \`\`\`json ... \`\`\` 包裹：
{
  "subtasks": [
    { "title": "子任务标题", "desc": "具体描述" }
  ]
}

**JSON 输出严格要求**（不遵守会导致解析失败、用户无法入库）：
1. title 和 desc 内如需引用术语 / 页面名 / 状态名，**必须使用中文引号「」或『』**，禁止使用 ASCII 双引号、单引号或反引号，否则会破坏外层 JSON 结构。
2. JSON 中不允许尾随逗号（最后一个元素后面不能跟逗号）。
3. JSON 中不允许写注释。
4. 所有字符串字段必须用 ASCII 双引号包裹，字符串内部如有换行用 \\n 转义。`;

      // 先把 prompt 元信息推给前端
      send({ type: 'meta', prompt: { system: userInstruction, user: userBlock } });

      // 流式调用 LLM
      const { content, aborted } = await callLlmStream(
        model,
        userBlock,
        (delta) => {
          if (delta.thinking) send({ type: 'thinking', delta: delta.thinking });
          if (delta.content) send({ type: 'content', delta: delta.content });
        },
        { maxTokens: 32000, timeoutMs: 600000, images: imageDataUrls, signal: abortController.signal }
      );

      if (aborted) {
        send({ type: 'error', error: '已取消' });
        finished = true;
        return res.end();
      }

      const { parsed, parseError, parseStage } = parseSubtaskJson(content);
      const list = Array.isArray(parsed?.subtasks) ? parsed.subtasks : [];
      const subtasks = list
        .map(s => ({
          title: String(s?.title || '').trim(),
          desc: String(s?.desc || '').trim()
        }))
        .filter(s => s.title);

      send({ type: 'done', subtasks, raw: content, parseError, parseStage });
      finished = true;
      res.end();
    } catch (err) {
      send({ type: 'error', error: 'AI 拆分失败: ' + (err?.message || String(err)) });
      finished = true;
      res.end();
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  // §5. AI 拆分预览（不调 LLM，只返回拼好的 prompt）
  // ════════════════════════════════════════════════════════════════════════
  app.post('/api/workbench/tasks/ai-split-preview', asyncRoute(async (req, res) => {
    const title = String(req.body?.title || '').trim();
    const desc = String(req.body?.desc || '').trim();
    const taskId = String(req.body?.taskId || '').trim();
    const promptId = String(req.body?.promptId || '').trim();
    if (!title) throw new HttpError(400, '任务标题不能为空');

    const userInstruction = await readSubtaskInstruction(req);
    const projectPath = typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '';
    const projectName = projectPath ? path.basename(projectPath) : '（未指定项目）';
    const manifestHint = await detectProjectManifest(projectPath);

    let templateBlock = '';
    if (promptId) {
      try {
        const promptData = await readJson(PROMPTS_FILE, { prompts: [] });
        const p = (promptData.prompts || []).find(x => x.id === promptId);
        if (p && p.content) {
          templateBlock = `\n\n## 子任务执行模板（每个拆出的子任务最终会被这套模板包裹后送给 claude 执行；拆分时请确保子任务能让模板里的 {{sub.title}} / {{sub.desc}} 等变量填得有意义）\n模板名：${p.name || '（未命名）'}\n---\n${p.content}\n---`;
        }
      } catch { /* 模板读取失败不影响预览 */ }
    }

    // 附件:只列条目,不读图片二进制(preview 阶段不需要 image_data_url)
    let attachmentBlock = '';
    let imageCount = 0;
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
            if (isImageExt(a.ext)) imageCount++;
          }
          if (lines.length > 0) {
            const imgNote = imageCount > 0
              ? `（其中 ${imageCount} 张图片已随消息一并发送，请直接基于图片内容拆分）`
              : '';
            attachmentBlock = `\n\n## 任务附件${imgNote}\n${lines.join('\n')}`;
          }
        }
      } catch { /* 没拿到附件不影响预览 */ }
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

请先仔细分析（可以放在 reasoning 中或直接写出来）。仔细分析指：列出 5 个维度——任务真实目标 / 关键技术栈与边界 / 自然执行顺序 / 风险点与可能失败步骤 / 是否需要前置调研——不要简短一两句话就过；分析过后再给出 JSON。JSON 用 \`\`\`json ... \`\`\` 包裹：
{
  "subtasks": [
    { "title": "子任务标题", "desc": "具体描述" }
  ]
}

**JSON 输出严格要求**（不遵守会导致解析失败、用户无法入库）：
1. title 和 desc 内如需引用术语 / 页面名 / 状态名，**必须使用中文引号「」或『』**，禁止使用 ASCII 双引号、单引号或反引号，否则会破坏外层 JSON 结构。
2. JSON 中不允许尾随逗号（最后一个元素后面不能跟逗号）。
3. JSON 中不允许写注释。
4. 所有字符串字段必须用 ASCII 双引号包裹，字符串内部如有换行用 \\n 转义。`;

    res.json({
      success: true,
      system: userInstruction,
      user: userBlock,
      hasImages: imageCount > 0,
      imageCount
    });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §6. 解析子任务 JSON（前端用户手改后调）
  // ════════════════════════════════════════════════════════════════════════
  app.post('/api/workbench/tasks/parse-subtasks', asyncRoute(async (req, res) => {
    const raw = String(req.body?.raw || '');
    const { parsed, parseError, parseStage } = parseSubtaskJson(raw);
    const list = Array.isArray(parsed?.subtasks) ? parsed.subtasks : [];
    const subtasks = list
      .map(s => ({
        title: String(s?.title || '').trim(),
        desc: String(s?.desc || '').trim()
      }))
      .filter(s => s.title);
    res.json({ success: true, subtasks, parseError, parseStage });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §7. AI 对话拆分（多轮 SSE）— 保留 try/catch
  // ════════════════════════════════════════════════════════════════════════
  app.post('/api/workbench/tasks/ai-chat-split', async (req, res) => {
    const userMessage = String(req.body?.userMessage || '').trim();
    const sessionIdInput = String(req.body?.sessionId || '').trim();
    const title = String(req.body?.title || '').trim();
    const desc = String(req.body?.desc || '').trim();
    const taskId = String(req.body?.taskId || '').trim();
    const promptId = String(req.body?.promptId || '').trim();

    // SSE 头
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
    let finished = false;
    if (req.socket) req.socket.once('close', () => { if (!finished) abortController.abort(); });

    try {
      // 加载或新建 session
      let session, isNew = false;
      if (sessionIdInput) {
        try {
          session = await readSessionFile(sessionIdInput);
        } catch (err) {
          if (err.statusCode === 404) {
            send({ type: 'error', error: '会话不存在' });
            return res.end();
          }
          throw err;
        }
      } else {
        if (!title) {
          send({ type: 'error', error: '新建会话时必须提供 title' });
          return res.end();
        }
        session = {
          version: 1,
          sessionId: genSessionId(),
          title, desc, taskId, promptId,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          messages: [],
          latestSubtasks: [],
          latestRaw: '',
          latestParseStage: ''
        };
        isNew = true;
      }

      if (!userMessage) {
        send({ type: 'error', error: '消息内容不能为空' });
        return res.end();
      }

      // 拼 system message(只在第一轮)
      if (session.messages.length === 0) {
        const userInstruction = await readSubtaskInstruction(req);
        const ctxLines = [];
        if (title) ctxLines.push(`【任务标题】${title}`);
        if (desc) ctxLines.push(`【任务描述】${desc}`);
        const sysContent = ctxLines.length
          ? `${userInstruction}\n\n${ctxLines.join('\n')}`
          : userInstruction;
        session.messages.push({ role: 'system', content: sysContent });
      }

      // 追加 user message
      session.messages.push({ role: 'user', content: userMessage });

      // 推 meta + user_echo
      send({
        type: 'meta',
        sessionId: session.sessionId,
        isNew,
        prompt: { system: session.messages[0].content, user: userMessage }
      });
      send({ type: 'user_echo', userMessage });

      // 加载 model
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
        send({ type: 'error', error: '未配置 AI 模型' });
        finished = true;
        return res.end();
      }

      // 流式调用(messages 模式)
      const { content, aborted } = await callLlmStream(
        model,
        session.messages,
        (delta) => {
          if (delta.thinking) send({ type: 'thinking', delta: delta.thinking });
          if (delta.content) send({ type: 'content', delta: delta.content });
        },
        { maxTokens: 32000, timeoutMs: 600000, signal: abortController.signal }
      );

      if (aborted) {
        session.updatedAt = nowIso();
        await writeSessionFile(session.sessionId, session).catch(() => {});
        enforceSessionsRetention().catch(() => {});
        send({ type: 'error', error: '已取消' });
        finished = true;
        return res.end();
      }

      // 解析 + 写盘
      const { parsed, parseError, parseStage } = parseSubtaskJson(content);
      const subtasks = Array.isArray(parsed?.subtasks)
        ? parsed.subtasks
            .map(s => ({
              title: String(s?.title || '').trim(),
              desc: String(s?.desc || '').trim()
            }))
            .filter(s => s.title)
        : [];

      session.messages.push({ role: 'assistant', content });
      session.latestSubtasks = subtasks;
      session.latestRaw = content;
      session.latestParseStage = parseStage;
      session.updatedAt = nowIso();
      await writeSessionFile(session.sessionId, session);
      enforceSessionsRetention().catch(() => {});

      send({ type: 'done', subtasks, raw: content, parseError, parseStage });
      finished = true;
      res.end();
    } catch (err) {
      send({ type: 'error', error: '对话拆分失败: ' + (err?.message || String(err)) });
      finished = true;
      res.end();
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  // §8. AI 对话拆分会话：列表 / 详情 / 删除
  // ════════════════════════════════════════════════════════════════════════
  app.get('/api/workbench/tasks/ai-chat-sessions', asyncRoute(async (_req, res) => {
    const sessions = await listSessionsMeta();
    res.json({ success: true, sessions });
  }));

  app.get('/api/workbench/tasks/ai-chat-sessions/:sessionId', asyncRoute(async (req, res) => {
    // readSessionFile 抛带 statusCode 的 Error（400/404），让 asyncRoute 透传
    const session = await readSessionFile(req.params.sessionId);
    res.json({ success: true, session });
  }));

  app.delete('/api/workbench/tasks/ai-chat-sessions/:sessionId', asyncRoute(async (req, res) => {
    await deleteSessionFile(req.params.sessionId);
    res.json({ success: true });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §9. SSE 事件流（订阅 job/sub/task 更新）
  // ════════════════════════════════════════════════════════════════════════
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
    const { id, title, desc, promptId, subtasks, type: rawType, simpleOverride, sequential: rawSequential } = req.body || {};
    const safeTitle = typeof title === 'string' ? title.trim() : '';
    const taskType = rawType === 'simple' ? 'simple' : 'complex';
    const sequential = rawSequential === false ? false : true;
    const safeOverride = typeof simpleOverride === 'string' ? simpleOverride.slice(0, 8000) : '';
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
        type: taskType,
        sequential: taskType === 'complex' ? sequential : true,
        simpleOverride: taskType === 'simple' ? safeOverride : '',
        subtasks: Array.isArray(subtasks) ? subtasks.map(s => ({
          id: s.id || genId(),
          title: s.title || '',
          desc: s.desc || '',
          status: s.status || 'todo',
          promptOverride: s.promptOverride || '',
          error: typeof s.error === 'string' ? s.error : undefined,
          errorAt: typeof s.errorAt === 'string' ? s.errorAt : undefined,
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
      title: safeTitle,
      desc: desc || '',
      promptId: promptId || null,
      type: taskType,
      sequential: taskType === 'complex' ? sequential : true,
      simpleOverride: taskType === 'simple' ? safeOverride : '',
      projectPath: currentProjectPath || '',
      subtasks: Array.isArray(subtasks) ? subtasks.map(s => ({
        id: s.id || genId(),
        title: s.title || '',
        desc: s.desc || '',
        status: s.status || 'todo',
        promptOverride: s.promptOverride || '',
        error: typeof s.error === 'string' ? s.error : undefined,
        errorAt: typeof s.errorAt === 'string' ? s.errorAt : undefined,
        attachments: Array.isArray(s.attachments) ? s.attachments : []
      })) : [],
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
    if (Array.isArray(task.subtasks)) {
      for (const sub of task.subtasks) {
        if (!sub || !sub.id) continue;
        try {
          await fsp.rm(path.join(IMAGES_DIR, sub.id), { recursive: true, force: true });
        } catch (e) {
          logger.warn(`[workbench] failed to remove sub image dir for ${sub.id}: ${e.message}`);
        }
      }
    }

    const tasks = allTasks.filter(t => t.id !== taskId);
    await writeJson(TASKS_FILE, { tasks });
    res.json({ success: true });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §12. 执行任务（整批 / 从指定 sub / 简单 / 单 sub）
  // ════════════════════════════════════════════════════════════════════════
  app.post('/api/workbench/tasks/:id/run', asyncRoute(async (req, res) => {
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const task = (data.tasks || []).find(t => t.id === req.params.id);
    if (!task) throw new HttpError(404, '任务不存在');
    if (!task.subtasks || task.subtasks.length === 0) {
      throw new HttpError(400, '任务没有子任务');
    }
    const repoPath = typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '';
    // 异步执行，立即返回
    res.json({ success: true, message: '已开始执行' });
    runTaskQueue(task, repoPath, '').catch(err => {
      publish('task:error', { taskId: task.id, error: err.message });
    });
  }));

  app.post('/api/workbench/tasks/:id/run-from', asyncRoute(async (req, res) => {
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const task = (data.tasks || []).find(t => t.id === req.params.id);
    if (!task) throw new HttpError(404, '任务不存在');
    if (!task.subtasks || task.subtasks.length === 0) {
      throw new HttpError(400, '任务没有子任务');
    }
    const startSubIndex = Number(req.body?.startSubIndex);
    if (!Number.isInteger(startSubIndex) || startSubIndex < 0 || startSubIndex >= task.subtasks.length) {
      throw new HttpError(400, 'startSubIndex 越界');
    }
    const repoPath = typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '';
    res.json({ success: true, message: `已从第 ${startSubIndex + 1} 个子任务开始执行` });
    runTaskQueue(task, repoPath, '', { fromIndex: startSubIndex }).catch(err => {
      publish('task:error', { taskId: task.id, error: err.message });
    });
  }));

  app.post('/api/workbench/tasks/:id/run-simple', asyncRoute(async (req, res) => {
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const task = (data.tasks || []).find(t => t.id === req.params.id);
    if (!task) throw new HttpError(404, '任务不存在');
    if (task.type !== 'simple') {
      throw new HttpError(400, '该任务不是简单任务,请使用普通执行接口');
    }
    const repoPath = typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '';
    const virtualSub = {
      id: `${task.id}__simple`,
      title: task.title,
      desc: task.desc || '',
      status: 'todo',
      promptOverride: task.simpleOverride || '',
      attachments: Array.isArray(task.attachments) ? task.attachments : []
    };
    res.json({ success: true, message: '已开始执行简单任务' });
    runSingleSubtask(task, virtualSub, repoPath, '', []).catch(err => {
      publish('task:error', { taskId: task.id, error: err.message });
    });
  }));

  app.post('/api/workbench/subtasks/:id/run', asyncRoute(async (req, res) => {
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const subId = req.params.id;
    let foundTask = null;
    let foundSub = null;
    for (const t of (data.tasks || [])) {
      if (!Array.isArray(t.subtasks)) continue;
      const s = t.subtasks.find(x => x.id === subId);
      if (s) { foundTask = t; foundSub = s; break; }
    }
    if (!foundTask || !foundSub) throw new HttpError(404, '子任务不存在');
    if (foundSub.status === 'running') throw new HttpError(400, '该子任务正在执行中');
    // 兜底:即便磁盘状态是 todo,如果磁盘里还没归档的 job 还在跑(进程被孤儿),也拦一下
    const liveJob = snapshotJobs().find(j => j.subId === subId && (j.status === 'running' || j.status === 'pending'));
    if (liveJob) throw new HttpError(400, '该子任务已有正在执行的 job');
    const repoPath = typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '';
    res.json({ success: true, message: `已开始执行子任务：${foundSub.title || subId}` });
    (async () => {
      try {
        const priorOutputs = await collectPriorOutputs(foundTask, foundSub);
        await runSingleSubtask(foundTask, foundSub, repoPath, '', priorOutputs);
        await persistTaskAfterRun(foundTask);
      } catch (err) {
        publish('task:error', { taskId: foundTask.id, error: err.message });
      }
    })();
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §13. Job 查询（兜底，SSE 断了也能拉）
  // ════════════════════════════════════════════════════════════════════════
  app.get('/api/workbench/jobs', asyncRoute(async (_req, res) => {
    try {
      const data = await readJson(JOBS_FILE, { version: 1, jobs: [] });
      const fileJobs = (data && Array.isArray(data.jobs)) ? data.jobs : [];
      const fileIds = new Set(fileJobs.map(j => j.id));
      const liveOnly = snapshotJobs().filter(j => !fileIds.has(j.id));
      return res.json({ success: true, jobs: [...fileJobs, ...liveOnly] });
    } catch (err) {
      // 读取失败兜底：只返内存的
      res.json({ success: true, jobs: snapshotJobs() });
    }
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §14. 取消正在执行的 job
  // ════════════════════════════════════════════════════════════════════════
  app.post('/api/workbench/jobs/:id/cancel', asyncRoute(async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) throw new HttpError(404, 'job 不存在');
    if (job.status !== 'running' && job.status !== 'pending') {
      throw new HttpError(400, `当前状态 ${job.status} 不可取消`);
    }
    cancelledJobs.add(job.id);
    // 立即给前端一个状态反馈（不等 child 真正退出）
    job.status = 'cancelled';
    job.error = '用户已停止执行';
    job.endedAt = nowIso();
    publish('job:update', { ...job }); // 浅拷贝避免序列化 child 引用
    // 同步把 sub 也置 cancelled
    syncSubToCancelled(job).catch(err => logger.warn('[workbench] syncSubToCancelled failed:', err.message));
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
    if (task.type !== 'simple') throw new HttpError(400, '仅支持简单任务的续接');
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
    runSingleSubtask(task, virtualSub, repoPath, '', [], { resumeSessionId: prevJob.claudeSessionId })
      .catch(err => {
        publish('task:error', { taskId: task.id, error: err.message });
      });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §16. 执行日志管理 API（持久化 + 清理）
  // /list、/config、/batch-delete、/clear 是字面路径，必须排在 :id 之前注册
  // ════════════════════════════════════════════════════════════════════════
  async function loadAllJobs() {
    const tasksData = await readJson(TASKS_FILE, { tasks: [] });
    const taskMap = new Map((tasksData.tasks || []).map(t => [t.id, t]));
    const data = await readJson(JOBS_FILE, { version: 1, jobs: [] });
    const fileJobs = (data && Array.isArray(data.jobs)) ? data.jobs : [];
    const fileIds = new Set(fileJobs.map(j => j.id));
    const liveOnly = Array.from(jobs.values())
      .filter(j => !fileIds.has(j.id))
      .map(j => serializeJob(j, taskMap));
    return [...fileJobs, ...liveOnly];
  }

  function applyJobsFilter(list, q) {
    const status = (q.status || '').trim();
    const taskId = (q.taskId || '').trim();
    const term = (q.q || '').trim().toLowerCase();
    return list.filter(j => {
      if (status && j.status !== status) return false;
      if (taskId && j.taskId !== taskId) return false;
      if (term) {
        const hay = `${j.title || ''} ${j.taskTitle || ''} ${j.subTitle || ''}`.toLowerCase();
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
    // 2) 重置 subtasks.status → todo
    const tasksData = await readJson(TASKS_FILE, { tasks: [] });
    const task = (tasksData.tasks || []).find(t => t.id === taskId);
    if (!task) {
      return res.json({ success: true, removedJobs: removedJobIds.length, resetSubs: 0, message: '任务不存在,仅清空 job' });
    }
    let resetSubs = 0;
    if (Array.isArray(task.subtasks)) {
      for (const s of task.subtasks) {
        if (s.status !== 'todo') {
          s.status = 'todo';
          resetSubs++;
          if (s.error) delete s.error;
          publish('sub:update', { taskId, sub: s });
        }
      }
      task.updatedAt = nowIso();
      await writeJson(TASKS_FILE, tasksData);
      publish('task:update', task);
    }
    res.json({
      success: true,
      removedJobs: removedJobIds.length,
      resetSubs,
      message: `已清空 ${removedJobIds.length} 条执行记录,${resetSubs} 个子任务重置为待执行`
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
    const removedSubCount = Array.isArray(task.subtasks) ? task.subtasks.length : 0;
    const removedAttCount = Array.isArray(task.attachments) ? task.attachments.length : 0;
    const hadDesc = !!(task.desc && task.desc.length > 0);
    const hadPrompt = !!task.promptId;
    const preservedProjectPath = task.projectPath;
    const preservedCreatedAt = task.createdAt;
    const preservedStatus = task.status || 'todo';
    const newTask = { id: task.id, title: task.title, status: preservedStatus };
    if (preservedProjectPath) newTask.projectPath = preservedProjectPath;
    if (preservedCreatedAt) newTask.createdAt = preservedCreatedAt;
    newTask.subtasks = [];
    newTask.attachments = [];
    newTask.updatedAt = nowIso();
    for (const k of Object.keys(task)) delete task[k];
    Object.assign(task, newTask);
    await writeJson(TASKS_FILE, tasksData);
    publish('task:update', task);
    res.json({
      success: true,
      removedJobs: removedJobIds.length,
      removedSubs: removedSubCount,
      removedAttachments: removedAttCount,
      clearedDesc: hadDesc,
      clearedPrompt: hadPrompt,
      message: `已清空:删除 ${removedSubCount} 个子任务${removedAttCount ? '、' + removedAttCount + ' 个附件' : ''}${hadDesc ? '、任务描述' : ''},任务标题保留`
    });
  }));

  app.post('/api/workbench/tasks/:id/clear-subtasks', asyncRoute(async (req, res) => {
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
      return res.json({ success: true, removedJobs: removedJobIds.length, removedSubs: 0, message: '任务不存在,仅清空 job' });
    }
    const removedSubCount = Array.isArray(task.subtasks) ? task.subtasks.length : 0;
    if (removedSubCount === 0) {
      return res.json({ success: true, removedJobs: removedJobIds.length, removedSubs: 0, message: '没有子任务需要清空' });
    }
    task.subtasks = [];
    task.updatedAt = nowIso();
    await writeJson(TASKS_FILE, tasksData);
    publish('task:update', task);
    res.json({
      success: true,
      removedJobs: removedJobIds.length,
      removedSubs: removedSubCount,
      message: `已清空 ${removedSubCount} 个子任务,任务描述和附件保留`
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
    limit: MAX_IMAGE_BYTES * 4 // 整体路由上限 20MB；单文件大小由业务再卡
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
  app.post('/api/workbench/subtasks/:subId/attachments', rawAttachment, asyncRoute(async (req, res) => {
    const { subId } = req.params;
    const data = await readJson(TASKS_FILE, { tasks: [] });
    let foundSub = null;
    for (const t of data.tasks || []) {
      const s = (t.subtasks || []).find(x => x.id === subId);
      if (s) { foundSub = s; break; }
    }
    if (!foundSub) throw new HttpError(404, '子任务不存在');
    const target = { ...foundSub, storageDir: path.join(IMAGES_DIR, subId) };
    const att = await writeAttachmentTo({ req, target, maxCount: MAX_ATTACHMENTS_PER_SUBTASK });
    // target 是 spread 出来的浅拷贝，data 引用里的 foundSub 没改；显式 push 回去
    foundSub.attachments = Array.isArray(foundSub.attachments) ? foundSub.attachments : [];
    foundSub.attachments.push(att);
    foundSub.updatedAt = nowIso();
    await writeJson(TASKS_FILE, data);
    res.json({ success: true, attachment: att });
  }));

  app.delete('/api/workbench/subtasks/:subId/attachments/:attId', asyncRoute(async (req, res) => {
    const { subId, attId } = req.params;
    const data = await readJson(TASKS_FILE, { tasks: [] });
    let foundSub = null;
    for (const t of data.tasks || []) {
      const s = (t.subtasks || []).find(x => x.id === subId);
      if (s) { foundSub = s; break; }
    }
    if (!foundSub) throw new HttpError(404, '子任务不存在');
    const list = Array.isArray(foundSub.attachments) ? foundSub.attachments : [];
    const i = list.findIndex(a => a.id === attId);
    if (i < 0) throw new HttpError(404, '附件不存在');
    const [removed] = list.splice(i, 1);
    try {
      await fsp.unlink(path.join(IMAGES_DIR, subId, removed.storedName));
    } catch { /* 文件可能已不存在 */ }
    foundSub.updatedAt = nowIso();
    await writeJson(TASKS_FILE, data);
    res.json({ success: true });
  }));

  // 主任务附件
  app.post('/api/workbench/tasks/:taskId/attachments', rawAttachment, asyncRoute(async (req, res) => {
    const { taskId } = req.params;
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const task = (data.tasks || []).find(t => t.id === taskId);
    if (!task) throw new HttpError(404, '任务不存在');
    const target = { ...task, storageDir: path.join(IMAGES_DIR, '_task-' + taskId) };
    const att = await writeAttachmentTo({ req, target, maxCount: MAX_ATTACHMENTS_PER_SUBTASK });
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
}

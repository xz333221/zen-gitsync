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
// 智能体路由入口。
//
// 路由清单:
//   GET    /api/agent/sessions           — 列出会话(仅 metadata;?cwd= 按项目过滤,空 cwd 视为当前项目)
//   GET    /api/agent/sessions/:id       — 获取会话详情(含完整消息)
//   DELETE /api/agent/sessions/:id       — 删除会话
//   PUT    /api/agent/sessions/:id       — 重命名会话
//   POST   /api/agent/chat               — SSE 流式聊天(含工具调用;body.cwd 必须与服务端当前项目一致)

import path from 'node:path';
import { asyncRoute, HttpError } from '../../utils/asyncRoute.js';
import { agentSessionStore } from './agentSessionStore.js';
import { runAgentTurn } from './agentChat.js';
import { registerAgentMarketplaceRoutes } from './agentMarketplace.js';
import { createProjectListProvider } from './projectTool.js';
import { nowIso } from './shared.js';

const { genSessionId, autoTitle, read: readSession, write: writeSession, delete: deleteSession, listMeta: listSessionsMeta, enforceRetention, rename: renameSession } = agentSessionStore;

// 项目路径规范化：Windows 路径大小写不敏感，POSIX 路径保留大小写语义。
function normalizeCwd(p) {
  const value = String(p || '').trim();
  if (!value) return '';
  const normalized = path.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

// 历史存量会话没有 cwd，暂时沿用升级前的可见性，避免升级后无法在 UI 中找回。
function sessionBelongsTo(sessionCwd, projectCwd) {
  const s = normalizeCwd(sessionCwd);
  const project = normalizeCwd(projectCwd);
  if (!s) return true;
  return Boolean(project && s === project);
}

// An ask_user call keeps its chat SSE request open until this map receives the
// matching response. The entry is removed on every completion or disconnect.
const pendingAgentQuestions = new Map();

function interactionKey(sessionId, interactionId) {
  return `${String(sessionId)}:${String(interactionId)}`;
}

export function waitForAgentAnswer({ sessionId, interactionId, question, options, allowFreeText, send, signal }) {
  const key = interactionKey(sessionId, interactionId);
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      pendingAgentQuestions.delete(key);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const settle = (answer) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(answer);
    };
    const onAbort = () => settle('Cancelled by user; the question was not answered.');

    pendingAgentQuestions.set(key, {
      question,
      options,
      allowFreeText,
      settle,
    });
    signal?.addEventListener?.('abort', onAbort, { once: true });
    send({ type: 'ask_user', interactionId, question, options, allowFreeText });
    if (signal?.aborted) onAbort();
  });
}

export function submitAgentAnswer({ sessionId, interactionId, answer }) {
  const key = interactionKey(sessionId, interactionId);
  const pending = pendingAgentQuestions.get(key);
  if (!pending) return { ok: false, status: 404, error: 'No pending question for this session.' };

  const value = String(answer || '').trim();
  if (!value) return { ok: false, status: 400, error: 'Answer cannot be empty.' };
  if (!pending.allowFreeText && pending.options.length > 0 && !pending.options.includes(value)) {
    return { ok: false, status: 400, error: 'Choose one of the listed options.' };
  }
  pending.settle(value);
  return { ok: true };
}

/**
 * 注册智能体路由。
 * @param {Object} deps
 * @param {import('express').Express} deps.app
 * @param {() => string} deps.getCurrentProjectPath
 * @param {Object} deps.configManager
 */
export function registerAgentRoutes({ app, getCurrentProjectPath, configManager }) {

  registerAgentMarketplaceRoutes({ app, getCurrentProjectPath });

  // list_projects 的数据源。在这里建一次、复用:它要读最近目录(配置)、tasks.json
  // 与看板统计,这些依赖只有本层拿得到 —— 与 taskRunner 的 setEnvContextProvider 同理。
  // 不给它加缓存:agent 一轮里最多问一两次,而"项目状态"本来就要现读才准。
  const listProjects = createProjectListProvider({ configManager, getCurrentProjectPath });

  // ════════════════════════════════════════════════════════════════════════
  // §1. 会话列表
  // ════════════════════════════════════════════════════════════════════════
  app.get('/api/agent/sessions', asyncRoute(async (req, res) => {
    let sessions = await listSessionsMeta();
    // 按项目隔离:前端传当前项目路径时只返回该项目的会话
    const cwdFilter = String(req.query?.cwd || '').trim();
    if (cwdFilter) {
      sessions = sessions.filter(s => sessionBelongsTo(s.cwd, cwdFilter));
    }
    res.json({ success: true, sessions });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §2. 会话详情
  // ════════════════════════════════════════════════════════════════════════
  app.get('/api/agent/sessions/:sessionId', asyncRoute(async (req, res) => {
    const session = await readSession(req.params.sessionId);
    res.json({ success: true, session });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §3. 删除会话
  // ════════════════════════════════════════════════════════════════════════
  app.delete('/api/agent/sessions/:sessionId', asyncRoute(async (req, res) => {
    await deleteSession(req.params.sessionId);
    res.json({ success: true });
  }));

  // ════════════════════════════════════════════════════════════════════════
  // §4. 重命名会话
  // ════════════════════════════════════════════════════════════════════════
  app.put('/api/agent/sessions/:sessionId', asyncRoute(async (req, res) => {
    const title = String(req.body?.title || '').trim();
    if (!title) throw new HttpError(400, '标题不能为空');
    const session = await renameSession(req.params.sessionId, title);
    res.json({ success: true, session });
  }));

  // Submit the answer for an ask_user tool call while its SSE request is paused.
  app.post('/api/agent/respond', async (req, res) => {
    const sessionId = String(req.body?.sessionId || '').trim();
    const interactionId = String(req.body?.interactionId || '').trim();
    if (!sessionId || !interactionId) {
      return res.status(400).json({ success: false, error: 'Missing sessionId or interactionId.' });
    }
    const result = submitAgentAnswer({
      sessionId,
      interactionId,
      answer: req.body?.answer,
    });
    if (!result.ok) return res.status(result.status).json({ success: false, error: result.error });
    return res.json({ success: true });
  });

  // ════════════════════════════════════════════════════════════════════════
  // §5. SSE 流式聊天（含工具调用循环）
  // ════════════════════════════════════════════════════════════════════════
  app.post('/api/agent/chat', async (req, res) => {
    const userMessage = String(req.body?.userMessage || '').trim();
    const sessionIdInput = String(req.body?.sessionId || '').trim();
    const locale = String(req.body?.locale || req.headers['accept-language'] || 'zh').startsWith('en') ? 'en' : 'zh';

    // 图片附件（base64 dataURL 数组）：前端已限制只能选图片，这里再做一层白名单校验
    const images = (Array.isArray(req.body?.images) ? req.body.images : [])
      .filter(u => typeof u === 'string' && /^data:image\/[\w.+-]+;base64,/.test(u))
      .slice(0, 10);

    if (!userMessage && images.length === 0) {
      return res.status(400).json({ success: false, error: '消息内容不能为空' });
    }

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
    let activeChild = null;

    // 客户端断开
    if (req.socket) {
      req.socket.once('close', () => {
        if (!finished) {
          abortController.abort();
          if (activeChild) {
            try { activeChild.kill('SIGTERM'); } catch {}
          }
        }
      });
    }

    try {
      // 加载或新建 session
      let session;
      let isNew = false;
      const currentProjectCwd = typeof getCurrentProjectPath === 'function'
        ? getCurrentProjectPath()
        : process.cwd();
      const bodyCwd = String(req.body?.cwd || '').trim();
      if (bodyCwd && normalizeCwd(bodyCwd) !== normalizeCwd(currentProjectCwd)) {
        send({ type: 'error', error: '当前页面项目与服务端项目不一致，请刷新后重试', code: 'PROJECT_MISMATCH' });
        finished = true;
        return res.end();
      }

      if (sessionIdInput) {
        try {
          session = await readSession(sessionIdInput);
        } catch (err) {
          if (err.statusCode === 404) {
            send({ type: 'error', error: '会话不存在' });
            finished = true;
            return res.end();
          }
          throw err;
        }
        if (session.cwd && normalizeCwd(session.cwd) !== normalizeCwd(currentProjectCwd)) {
          send({ type: 'error', error: '该会话属于其他项目，无法在当前项目中继续', code: 'PROJECT_MISMATCH' });
          finished = true;
          return res.end();
        }
      } else {
        session = {
          version: 1,
          sessionId: genSessionId(),
          title: '(新会话)',
          source: 'web',
          cwd: currentProjectCwd,
          model: '',
          createdAt: nowIso(),
          updatedAt: nowIso(),
          messages: []
        };
        isNew = true;
      }

      // 获取模型配置
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

      // 更新 session 的 model 信息
      session.model = `${model.model || ''} (${model.name || ''})`;

      // 工作目录
      const cwd = session.cwd || (typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : process.cwd());

      // 推 meta
      send({
        type: 'meta',
        sessionId: session.sessionId,
        isNew,
        title: isNew ? autoTitle([{ role: 'user', content: userMessage }]) : session.title
      });

      // 运行 agent 循环
      const { aborted } = await runAgentTurn({
        session,
        model,
        userMessage,
        images,
        cwd,
        locale,
        signal: abortController.signal,
        send,
        onChild: (child) => { activeChild = child; },
        askUser: (args, meta = {}) => waitForAgentAnswer({
          sessionId: session.sessionId,
          interactionId: meta.interactionId,
          question: args.question,
          options: Array.isArray(args.options) ? args.options : [],
          allowFreeText: args.allowFreeText !== false,
          send,
          signal: abortController.signal,
        }),
        listProjects
      });

      if (aborted) {
        finished = true;
        return res.end();
      }

      // 更新标题(新会话从第一条 user 消息自动生成)
      if (isNew) {
        session.title = autoTitle(session.messages);
      }

      // 持久化
      session.updatedAt = nowIso();
      await writeSession(session.sessionId, session);
      enforceRetention().catch(() => {});

      finished = true;
      res.end();
    } catch (err) {
      send({ type: 'error', error: '智能体对话失败: ' + (err?.message || String(err)) });
      finished = true;
      res.end();
    }
  });
}

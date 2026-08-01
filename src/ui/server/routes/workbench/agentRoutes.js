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
//   GET    /api/agent/sessions           — 列出所有会话(仅 metadata)
//   GET    /api/agent/sessions/:id       — 获取会话详情(含完整消息)
//   DELETE /api/agent/sessions/:id       — 删除会话
//   PUT    /api/agent/sessions/:id       — 重命名会话
//   POST   /api/agent/chat               — SSE 流式聊天(含工具调用)

import { asyncRoute, HttpError } from '../../utils/asyncRoute.js';
import { agentSessionStore } from './agentSessionStore.js';
import { runAgentTurn } from './agentChat.js';
import { nowIso } from './shared.js';

const { genSessionId, autoTitle, read: readSession, write: writeSession, delete: deleteSession, listMeta: listSessionsMeta, enforceRetention, rename: renameSession } = agentSessionStore;

/**
 * 注册智能体路由。
 * @param {Object} deps
 * @param {import('express').Express} deps.app
 * @param {() => string} deps.getCurrentProjectPath
 * @param {Object} deps.configManager
 */
export function registerAgentRoutes({ app, getCurrentProjectPath, configManager }) {

  // ════════════════════════════════════════════════════════════════════════
  // §1. 会话列表
  // ════════════════════════════════════════════════════════════════════════
  app.get('/api/agent/sessions', asyncRoute(async (_req, res) => {
    const sessions = await listSessionsMeta();
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
      } else {
        session = {
          version: 1,
          sessionId: genSessionId(),
          title: '(新会话)',
          source: 'web',
          cwd: typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : process.cwd(),
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
        onChild: (child) => { activeChild = child; }
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

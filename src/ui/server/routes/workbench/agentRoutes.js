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
import { runExternalTurn } from './runExternalTurn.js';
import { normalizeAgentEngine, isExternalEngine, engineLabel } from './agentEngines.js';
import { saveAgentAttachments, MAX_ATTACHMENTS } from '../../utils/agentAttachments.js';
import { registerAgentMarketplaceRoutes } from './agentMarketplace.js';
import { createProjectListProvider } from './projectTool.js';
import { createWorkspaceSnapshotter } from '../aiContext/wiring.js';
import { nowIso, logger } from './shared.js';

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

/** 正在进行中的会话 id 集合：同一会话同一时刻只允许一个生成中的轮次 */
const activeSessionTurns = new Set();

function interactionKey(sessionId, interactionId) {
  return `${String(sessionId)}:${String(interactionId)}`;
}

export function waitForAgentAnswer({ sessionId, interactionId, question, options, allowFreeText, multiple, send, signal }) {
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
      multiple: multiple === true,
      settle,
    });
    signal?.addEventListener?.('abort', onAbort, { once: true });
    send({ type: 'ask_user', interactionId, question, options, allowFreeText, multiple: multiple === true });
    if (signal?.aborted) onAbort();
  });
}

export function submitAgentAnswer({ sessionId, interactionId, answer }) {
  const key = interactionKey(sessionId, interactionId);
  const pending = pendingAgentQuestions.get(key);
  if (!pending) return { ok: false, status: 404, error: 'No pending question for this session.' };

  // 单选发字符串、多选发数组；这里统一归一成"非空的字符串列表"
  const values = (Array.isArray(answer) ? answer : [answer])
    .map((v) => String(v ?? '').trim())
    .filter(Boolean);
  if (!values.length) return { ok: false, status: 400, error: 'Answer cannot be empty.' };
  if (!pending.allowFreeText && pending.options.length > 0) {
    const unknown = values.filter((v) => !pending.options.includes(v));
    if (unknown.length) return { ok: false, status: 400, error: 'Choose one of the listed options.' };
  }
  // 多选回给模型的是 JSON 数组字符串（单选/自由输入保持原样字符串）
  pending.settle(pending.multiple ? JSON.stringify(values) : values[0]);
  return { ok: true };
}

/**
 * 注册智能体路由。
 * @param {Object} deps
 * @param {import('express').Express} deps.app
 * @param {() => string} deps.getCurrentProjectPath
 * @param {Object} deps.configManager
 */
export function registerAgentRoutes({ app, getCurrentProjectPath, configManager, snapshotter }) {

  registerAgentMarketplaceRoutes({ app, getCurrentProjectPath });

  // list_projects 的数据源。在这里建一次、复用:它要读最近目录(配置)、tasks.json
  // 与看板统计,这些依赖只有本层拿得到 —— 与 taskRunner 的 setEnvContextProvider 同理。
  // 不给它加缓存:agent 一轮里最多问一两次,而"项目状态"本来就要现读才准。
  const listProjects = createProjectListProvider({ configManager, getCurrentProjectPath });

  // 工作区状态快照（七个板块的摘要 + 落盘文件路径）。同样在这里建一次、复用 ——
  // 它要读配置、tasks.json、执行记录、git 状态、监控与思维导图,这些依赖本层一并拿得最全。
  //
  // `snapshotter` 是个**只为测试留的注入口**(与 remoteRepos 的 *Impl 同一套做法):
  // 生产不传,走真实实现;单测传一个空壳,免得跑一次对话就在测试机上 spawn `gh`
  // 和 PowerShell、还去连一次网。默认值写成参数默认值,不传时才构造。
  const workspaceSnapshotter = snapshotter || createWorkspaceSnapshotter({ configManager, getCurrentProjectPath });
  const getContextBlock = ({ locale } = {}) => workspaceSnapshotter.getBlock({ locale });

  // ════════════════════════════════════════════════════════════════════════
  // §1. 会话列表
  // ════════════════════════════════════════════════════════════════════════
  /**
   * 预热工作区状态快照 —— 这是"初始加载"该做的事,但**不是**把七个界面板块都挂起来。
   *
   * 用户打开智能体页时前端会拉这个会话列表,此刻就顺手在后台把快照生成好;
   * 等他打完字发出去,快照早已就绪,那一轮就能带上完整上下文。
   * 刻意不 await:它要跑 gh/gitee/git/PowerShell,等它会让会话列表白屏几秒。
   * 也刻意不放在 registerAgentRoutes 里:启动时预热会让"打开服务"这条路径凭空多几次
   * 子进程与网络调用,而用户可能压根不会打开智能体页。
   */
  function warmSnapshotInBackground() {
    try {
      if (typeof workspaceSnapshotter?.warm === 'function') workspaceSnapshotter.warm().catch(() => {});
    } catch (err) {
      logger.warn(`[agentRoutes] 预热工作区快照失败: ${err?.message || err}`);
    }
  }

  /**
   * POST /api/ai-context/refresh   body: { sections?: string[], force?: boolean }
   *
   * 给前端"切到某个面板就更新对应板块"用的定向刷新口。**按板块**而不是全量:
   * 七个板块的取数成本差两个数量级,切个 Git 面板没必要顺带联网拉一遍仓库列表。
   *
   * 前端一律 fire-and-forget 调它(不等响应) —— 一次全量要 6~7 秒,没有哪个 UI 该等它。
   * 真正拖慢也不怕:force 仍受各板块自己的 forceTtlMs 地板限制,联网板块最多 60s 一次。
   *
   * 顺带把各板块状态回给调用方(采集时间/是否新鲜),排查"为什么模型看到的是旧的"时很好用。
   */
  app.post('/api/ai-context/refresh', asyncRoute(async (req, res) => {
    const body = req.body || {};
    const ids = Array.isArray(body.sections) ? body.sections.map(String) : undefined;
    const force = body.force === true;
    const state = await workspaceSnapshotter.refreshSections(ids, { force });
    res.json({ success: true, ...state });
  }));

  /** GET 版本:只读回各板块状态,不触发任何取数(给未来做面板用) */
  app.get('/api/ai-context/state', asyncRoute(async (_req, res) => {
    res.json({ success: true, ...workspaceSnapshotter.getState() });
  }));

  app.get('/api/agent/sessions', asyncRoute(async (req, res) => {
    warmSnapshotInBackground();
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

    // 非图片附件：前端只传文件名 + 字节，服务端落盘到数据目录，只把**绝对路径**交给模型。
    // 内容不进消息体（省 token，模型自己用 read/grep 按需取），校验见 utils/agentAttachments.js。
    const rawAttachments = (Array.isArray(req.body?.attachments) ? req.body.attachments : [])
      .slice(0, MAX_ATTACHMENTS)
      .map(a => ({ name: a?.name, dataUrl: a?.dataUrl }));

    if (!userMessage && images.length === 0 && rawAttachments.length === 0) {
      return res.status(400).json({ success: false, error: '消息内容不能为空' });
    }

    // 文件空间对话：客户端把"当前打开的文档"带上来，服务端只在请求副本里注入上下文（不落库）
    const openFilePath = String(req.body?.openFilePath || '').trim().slice(0, 512);

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

    // 同一会话同一时刻只允许一个进行中的生成：跨视图（对话 Tab / 文件空间面板）
    // 或前端连点都靠这道闸挡住，否则两个流各自的会话快照会互相覆盖。
    if (sessionIdInput && activeSessionTurns.has(sessionIdInput)) {
      send({ type: 'error', error: '该会话正在生成中，请等它结束后再发送' });
      finished = true;
      return res.end();
    }
    let activeSessionKey = null;

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
        // 引擎在会话**建立时就锁死**，中途不许换。
        // 为什么：三家 CLI 的续聊标识互不通用（claude --resume / opencode --session /
        // codex exec resume），而且历史消息格式不同（我们存的是 OpenAI chat completions
        // 形状，喂给 claude 没有意义）。允许中途切换的表现是"看起来切了，上下文却串了"——
        // 与工作台 taskExecutor.ts 注释里那条"续哪个执行器由上一轮 job.agent 决定"同源。
        const requestedEngine = req.body?.engine === undefined
          ? null
          : normalizeAgentEngine(req.body?.engine);
        const sessionEngine = normalizeAgentEngine(session.engine);
        if (requestedEngine && requestedEngine !== sessionEngine && Array.isArray(session.messages) && session.messages.length > 0) {
          send({
            type: 'error',
            error: `该会话由 ${engineLabel(sessionEngine)} 运行，无法中途切换引擎。请新建会话再选 ${engineLabel(requestedEngine)}。`,
            code: 'ENGINE_LOCKED'
          });
          finished = true;
          return res.end();
        }
        session.engine = sessionEngine;
      } else {
        session = {
          version: 1,
          sessionId: genSessionId(),
          title: '(新会话)',
          source: 'web',
          cwd: currentProjectCwd,
          model: '',
          // 引擎：gai（内置，默认）| claude | opencode | codex
          engine: normalizeAgentEngine(req.body?.engine),
          // 外部 CLI 自己的续聊标识（claude session_id / opencode sessionID /
          // codex thread_id）。g ai 用不到，留着空串。
          engineSessionId: '',
          createdAt: nowIso(),
          updatedAt: nowIso(),
          messages: []
        };
        isNew = true;
      }

      // 本轮占用该会话（finally 里释放）
      activeSessionKey = session.sessionId;
      activeSessionTurns.add(activeSessionKey);

      // 附件落盘（拿到绝对路径后再把路径交给模型）。落盘失败不该拖垮整轮对话：
      // 拿不到路径最多是模型看不到附件，用户仍能正常对话。
      const attachments = await saveAgentAttachments(rawAttachments, {
        onSkip: (info) => console.warn('[agent] 附件被忽略:', info.name, info.reason)
      }).catch((err) => {
        console.warn('[agent] 附件落盘失败:', err?.message || err);
        return [];
      });

      // 获取模型配置。**只有内置 g ai 需要** —— 外部 CLI 用自己的模型与配置
      // （claude/opencode/codex 各自的 CLI 配置；本机上 Codex 甚至是走本地代理跑
      //  deepseek-v4.1-flash）。为外部引擎要求"先在设置里配模型"是错的：
      // 明明能跑，却先被一道无关的校验拦住。
      const useExternal = isExternalEngine(session.engine);
      let model = null;
      if (!useExternal) {
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
      } else {
        // 外部引擎：不落具体模型名（它随 CLI 自己的配置变），只记引擎，便于列表里辨认
        session.model = '';
      }

      // 工作目录
      const cwd = session.cwd || (typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : process.cwd());

      // 推 meta
      send({
        type: 'meta',
        sessionId: session.sessionId,
        isNew,
        title: isNew ? autoTitle([{ role: 'user', content: userMessage }]) : session.title
      });

      if (useExternal) {
        // 外部 CLI 引擎：CLI 自己跑循环，服务端只做 spawn + 事件翻译。
        // 工作区状态块走 prompt 前缀（见 runExternalTurn 文件头：往项目里写
        // AGENTS.md/CLAUDE.md 会弄脏用户工作区，且三家读取口径实测不一致）。
        let promptPrefix = '';
        if (typeof getContextBlock === 'function') {
          try { promptPrefix = await getContextBlock({ locale }); } catch (err) { logger.warn(`[agent] 外部引擎状态块获取失败: ${err?.message || err}`); }
        }
        // 图片附件转成文件路径交给 CLI（它们收路径不收 base64）。走同一套落盘校验。
        const imageAttachments = images.map((u, i) => ({ name: `pasted-${i + 1}.png`, dataUrl: u }));
        const imageFiles = imageAttachments.length > 0
          ? await saveAgentAttachments(imageAttachments, {
            onSkip: (info) => console.warn('[agent] 图片附件被忽略:', info.name, info.reason)
          }).catch((err) => {
            console.warn('[agent] 图片附件落盘失败:', err?.message || err);
            return [];
          })
          : [];
        const filePaths = [...attachments.map(a => a.path), ...imageFiles.map(f => f.path)];

        await runExternalTurn({
          session,
          engine: session.engine,
          userMessage,
          cwd,
          promptPrefix,
          filePaths,
          signal: abortController.signal,
          send,
          onChild: (child) => { activeChild = child; },
        });
      } else {
        // 运行 agent 循环（内置 g ai：服务端跑 LLM + 工具）
        await runAgentTurn({
          session,
          model,
          userMessage,
          images,
          cwd,
          locale,
          openFilePath,
          attachments,
          signal: abortController.signal,
          send,
          onChild: (child) => { activeChild = child; },
          askUser: (args, meta = {}) => waitForAgentAnswer({
            sessionId: session.sessionId,
            interactionId: meta.interactionId,
            question: args.question,
            options: Array.isArray(args.options) ? args.options : [],
            allowFreeText: args.allowFreeText !== false,
            multiple: args.multiple === true,
            send,
            signal: abortController.signal,
          }),
          listProjects,
          getContextBlock
        });
      }

      // 更新标题(新会话从第一条 user 消息自动生成)
      if (isNew) {
        session.title = autoTitle(session.messages);
      }

      // 持久化。中止(用户点"停止")的轮次同样要落盘 —— 磁盘上没有这条会话时，
      // 前端停止后立刻刷新列表会把左栏这一条整个吞掉（表现为"一停止任务就没了"）。
      session.updatedAt = nowIso();
      await writeSession(session.sessionId, session);
      enforceRetention().catch(() => {});

      finished = true;
      res.end();
    } catch (err) {
      send({ type: 'error', error: '智能体对话失败: ' + (err?.message || String(err)) });
      finished = true;
      res.end();
    } finally {
      if (activeSessionKey) activeSessionTurns.delete(activeSessionKey);
    }
  });

  // 把生成器交出去:调用方(server/index.js)要在服务启动后预热一次快照,
  // 覆盖"g ui 刚启动"这个时机。预热调用刻意留在**生产入口**而不是这里 ——
  // 单测会调 registerAgentRoutes 四次,预热写在这里等于测试机上 spawn 四轮 gh。
  return { snapshotter: workspaceSnapshotter };
}

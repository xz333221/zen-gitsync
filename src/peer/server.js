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
// 跨机器 peer 的服务端：**一个独立端口、一张极短的路由表**。
//
// 为什么不复用主服务的端口：
//   主服务是"没有认证层，能打进来就是全权限"（api/exec、api/terminal、api/fs/write
//   都在同一张表上），而 peer 端口必须能在局域网/公网上被别的机器访问。把整张
//   /api 挂到 0.0.0.0 等于把 RCE 对外开放；这里只挂 3 个只读/受限接口，
//   即使令牌泄露，攻击面也只有"问它一句话"。
//   主服务仍然只听 127.0.0.1（见 ui/server/index.js 的 Origin 守卫那一段）。
//
// 鉴权：Authorization: Bearer <本机令牌>，常量时间比较（store.tokenEquals）。
// 失败一律 401，且**不区分**"没带令牌"和"令牌错"，避免探测。

import http from 'node:http';
import express from 'express';

import { tokenEquals, getSessionId, setSessionId, clearSessionId, maskToken } from './store.js';
import { askLocalAgent } from './localAsk.js';
import { describePlatform, describeShell } from './platform.js';
import { isSessionBusy } from '../ui/server/routes/workbench/sessionGate.js';
import { agentSessionStore } from '../ui/server/routes/workbench/agentSessionStore.js';
import logger from '../ui/server/utils/logger.js';

const MAX_QUESTION_CHARS = 4000;
const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;
const STARTED_AT = new Date().toISOString();
/** 提问方自报字段的上限：够放下"Windows 11 (win32/x64)"这类标签，又不会把前缀撑爆。 */
const FROM_FIELD_MAX = 64;

/**
 * 一条 peer 会话攒到多少条消息就该换代。
 *
 * 会话按 `in:<from>` 一人一条、**永不轮换**，于是跨机器提问会把几个月里互不相关
 * 的事全塞进同一条会话。实测 2026-11-26：890 条（5.84MB，单次请求约 25 万 token）
 * 的那条，一轮部署要跑 417s 以上；提问方的工具守卫等不及就断开，答案回不去。
 *
 * 300 条足够装几十轮工具循环、连续追问不丢上下文；再长就该让模型从干净的
 * 上下文开始 —— 跨机器提问本来就常常是"新的一件事"。
 */
export const PEER_SESSION_MAX_MESSAGES = 300;

/**
 * 读一条会话的体量。
 *
 * 返回 null 只代表"这条会话**不可能**再用"：文件被删了，或者 id 本身非法
 * （peers.json 被手改坏过）。调用方据此换新会话，而不是拿一个不存在的 id
 * 去问 —— 那样每一问都会回"会话不存在"，且映射永远不会自愈。
 *
 * 其它读失败（Windows 上偶发 EBUSY / EACCES）**不算缺失**：那种时候宁可
 * 按"0 条"继续用旧会话，也不能因为一次瞬时 IO 错误悄悄把上下文清掉。
 */
async function readSessionStats(sessionId) {
  try {
    const data = await agentSessionStore.read(sessionId);
    return { messages: Array.isArray(data?.messages) ? data.messages.length : 0 };
  } catch (err) {
    if (err?.statusCode === 404 || err?.statusCode === 400 || err?.code === 'ENOENT') return null;
    logger.warn?.(`[peer] 读会话 ${sessionId} 失败，按"仍在"继续: ${err?.message || err}`);
    return { messages: 0, unreadable: true };
  }
}

/** 清洗提问方自报的字段：去换行（防止伪造前缀的多行结构）、限长。 */
function cleanFromField(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, FROM_FIELD_MAX);
}

/**
 * 拼跨机器提问的上下文前缀。
 *
 * 对端 agent 默认只会把自己当"本机"——它看不到提问方那边。不写清"这是另一台机器、
 * 对方是什么系统、你自己是什么系统"，模型很容易顺着对方的话把 Windows 当 Linux，
 * 给出 `ls` / `tail` / 单引号路径这种在本机必然报错的命令。
 *
 * 单独抽出来是为了单测能直接断文案，不必起服务。
 *
 * @param {{from?:string, fromName?:string, fromOs?:string}} [opts]
 */
export function buildPeerQuestionPrefix({ from, fromName, fromOs } = {}) {
  const who = cleanFromField(fromName) || cleanFromField(from) || '匿名节点';
  const fromPlatform = cleanFromField(fromOs) || '系统未知';
  const me = describePlatform();
  const shell = describeShell();
  return `〔跨机器提问 · 来自另一台机器「${who}」(${fromPlatform}),不是你本机 · `
    + `你这台是 ${me.label}(${shell}) —— 涉及命令/路径时先按你自己机器的系统来判断,`
    + '对方提的路径或命令不一定适用于你这台机器〕';
}

/**
 * 造 peer 的 express app（不含 listen，方便单测直接 supertest/裸 http 打）。
 *
 * @param {object} opts
 * @param {{id:string,name:string,avatar:string,token:string}} opts.self 本机身份
 * @param {() => number|string} opts.getLocalPort 返回本机 g ui 端口（环回调用用）
 * @param {(args:object)=>Promise<{answer:string,sessionId:string,ms:number}>} [opts.ask]
 *   真正执行提问的函数；默认走 askLocalAgent（单测可替换）
 * @param {number} [opts.timeoutMs]
 * @param {() => string} [opts.getVersion]
 * @param {(key:string)=>Promise<string>} [opts.getSession] 会话读取（单测注入内存版）
 * @param {(key:string,id:string)=>Promise<void>} [opts.setSession] 会话写回
 * @param {(sessionId:string)=>Promise<{messages:number}|null>} [opts.getSessionStats]
 *   读会话体量；返回 null 表示"这条会话已经不在了"。单测注入内存版。
 * @param {(key:string)=>Promise<void>} [opts.clearSession] 清掉某个键的绑定（换代用）
 */
export function createPeerApp({
  self,
  getLocalPort,
  ask,
  timeoutMs = DEFAULT_ASK_TIMEOUT_MS,
  getVersion = () => '',
  getSession = getSessionId,
  setSession = setSessionId,
  getSessionStats = readSessionStats,
  clearSession = clearSessionId
} = {}) {
  if (!self || !self.token) throw new Error('createPeerApp 需要带令牌的本机身份（先 ensureSelf）');

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // 令牌校验：所有 /api/peer/* 都要过
  app.use('/api/peer', (req, res, next) => {
    const header = String(req.headers.authorization || '');
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!given || !tokenEquals(given, self.token)) {
      // 不回显令牌、不提示"差几位"—— 只给一个统一的结果
      return res.status(401).json({ ok: false, error: '令牌无效' });
    }
    next();
  });

  /**
   * GET /api/peer/info — 我是谁、能不能问。
   *
   * 刻意**不返回**项目清单 / 文件路径 / 任务数：这一层只负责"让对端知道有个谁在线"，
   * 项目清单让对端 agent 用自己的 list_projects 现场回答（能问的就不复制）。
   */
  app.get('/api/peer/info', (req, res) => {
    res.json({
      ok: true,
      id: self.id,
      name: self.name,
      avatar: self.avatar || '',
      version: getVersion(),
      // 系统信息**只能由这台机器自报**：对端没法从网络里读出来，猜就是错的来源。
      // 新增字段只增不改 —— 老版本对端不认识它们，但继续靠上面那些字段工作。
      os: describePlatform(),
      shell: describeShell(),
      capabilities: ['ask'],
      startedAt: STARTED_AT
    });
  });

  /**
   * POST /api/peer/ask — 让本机 g ai 回答一个问题。
   *
   * body: { question: string, from?: string /* 提问方节点 id *\/
   *         fromOs?: string /* 提问方自报的系统 label，如 "Ubuntu 22.04 (linux/x64)" *\/
   *         fromName?: string /* 提问方昵称 *\/ }
   * 返回: { ok, answer, sessionId, ms }
   *
   * fromOs / fromName 都是**可选**的：老版本提问方不会带，这时前缀里写"系统未知"。
   * 两者只用于拼上下文前缀，不参与鉴权、不参与会话 key（key 仍只看 from）。
   *
   * 会话连续性：每个提问方在**本机**占一个会话（key = `in:<from>`），这样 A 问
   * 第二句时 B 还记得第一句，但 A 和 C 的上下文不会串。这条会话不会永久续下去：
   * 还在生成中 / 已被删 / 超过 PEER_SESSION_MAX_MESSAGES 条，都会换一条新的。
   */
  app.post('/api/peer/ask', async (req, res) => {
    const question = String(req.body?.question || '').trim();
    const from = String(req.body?.from || '').trim() || 'unknown';
    if (!question) return res.status(400).json({ ok: false, error: 'question 不能为空' });
    if (question.length > MAX_QUESTION_CHARS) {
      return res.status(413).json({ ok: false, error: `问题过长（上限 ${MAX_QUESTION_CHARS} 字）` });
    }

    // 前缀放在问题之前交给本机 agent：它默认只把自己当"本机"，不告诉它这是跨机器
    // 提问、双方各是什么系统，模型就会按错误的那套命令写法回答（详见函数注释）。
    const prefix = buildPeerQuestionPrefix({
      from,
      fromName: req.body?.fromName,
      fromOs: req.body?.fromOs
    });
    const questionForAgent = `${prefix}\n${question}`;

    const sessionKey = `in:${from}`;
    let sessionId = await getSession(sessionKey).catch(() => '');

    // 已经绑定的会话为什么不能接着用 —— 三种情况，处理各不同：
    //
    // ① busy：这条会话还在生成中。闸是**按会话**占的，带着这个 id 进去必然撞
    //    SESSION_BUSY，而这一问的调用方可能早就放弃等待了（客户端有自己的超时，
    //    到点只是本地不等，跨机器这一跳还在跑）。对端用户在界面上看不到任何在跑的
    //    对话 —— peer 会话不属于任何项目 —— 于是表现为"我没和它说话，它却一直忙"。
    //    这里改用一条新会话：宁可这一问丢掉上下文，也不能让一个固定 key 把之后
    //    每一问都堵死。**先不清映射**：那一轮还在跑，它结束后这条旧绑定仍然有效
    //    （本问若失败，下一问还能续上）。
    //
    // ② missing：会话文件被删了。留着映射的后果是每一问都回"会话不存在"，
    //    而且映射永远不会自愈 —— 只能让用户去手改 peers.json。
    //
    // ③ oversized：会话太长了（见 PEER_SESSION_MAX_MESSAGES）。每条请求都要
    //    把整包历史重新发一遍，几百条之后一轮动辄十几分钟，提问方等不到就断开。
    //    换代比"继续拖"更接近用户想要的：跨机器提问大多是新的独立任务。
    let resetReason = '';
    if (sessionId) {
      if (isSessionBusy(sessionId)) {
        resetReason = 'busy';
      } else {
        const stats = await getSessionStats(sessionId).catch(() => null);
        if (!stats) resetReason = 'missing';
        else if (stats.messages >= PEER_SESSION_MAX_MESSAGES) resetReason = 'oversized';
      }
    }
    if (resetReason) {
      const why = resetReason === 'busy'
        ? '仍在生成中'
        : resetReason === 'missing'
          ? '已不存在'
          : `已有 ${PEER_SESSION_MAX_MESSAGES}+ 条消息`;
      logger.info?.(`[peer] 会话 ${sessionId || '(空)'} ${why}，本问改用新会话（from=${from}）`);
      sessionId = '';
      // busy 那条的绑定要留着（它还在跑）；另外两种已经没救了，清掉才不会再被选中
      if (resetReason !== 'busy') await clearSession(sessionKey).catch(() => {});
    }
    logger.info?.(`[peer] 收到提问 from=${from} len=${question.length}`);

    // 提问方断开 = 这一轮没人要了：必须把本机那一轮一起掐掉。
    //
    // 场景（2026-11-09 实测）：本机工具层 ask_peer 到点后只是"本地不等了"，
    // 跨机器那一跳还在跑；对端把这一轮跑到底，会话闸一直占着 `in:<from>` 这个固定 key，
    // 于是后续每一次提问都在 1~2 秒内回 SESSION_BUSY —— 而对端用户在界面上看不到
    // 任何正在跑的对话（peer 会话不属于任何项目）。
    //
    // 靠"连接断开"这条语义即可，不必新增取消接口：fetch 被 abort → 连接关掉 →
    // 这里 abort → 环回 /api/agent/chat 的 socket close → 那一轮中止并释放闸。
    const controller = new AbortController();
    const onCallerGone = () => {
      if (res.writableEnded) return;
      try { controller.abort(); } catch {}
    };
    res.once('close', onCallerGone);

    try {
      const runner = typeof ask === 'function'
        ? ask
        : (args) => askLocalAgent({ ...args, port: getLocalPort(), timeoutMs });
      const result = await runner({ question: questionForAgent, sessionId, from, signal: controller.signal });
      if (result?.sessionId && result.sessionId !== sessionId) {
        await setSession(sessionKey, result.sessionId).catch(() => {});
      }
      res.json({
        ok: true,
        answer: result?.answer || '',
        sessionId: result?.sessionId || '',
        ms: result?.ms || 0
      });
    } catch (err) {
      logger.warn?.(`[peer] 提问处理失败: ${err?.message || err}`);
      // 提问方已经走了：502 谁都收不到，写下去只会在日志里多一条噪声
      if (!res.writableEnded && !res.destroyed) {
        res.status(502).json({ ok: false, error: String(err?.message || err) });
      }
    } finally {
      res.removeListener('close', onCallerGone);
    }
  });

  // 其余任何路径：404，且不回 express 的默认 HTML（别暴露技术栈）
  app.use((req, res) => {
    res.status(404).json({ ok: false, error: 'not found' });
  });

  return app;
}

/**
 * 在固定端口上起 peer 服务。
 *
 * 端口失败**不自动顺延**：peers 表里其他机器配的就是这个端口，悄悄换一个会让
 * 对端一直连到别人（或连不上）。所以这里把错误原样抛给调用方去提示用户。
 *
 * @param {object} opts
 * @param {object} opts.self 本机身份（含 port/host/token）
 * @param {() => number|string} opts.getLocalPort
 * @param {object} [opts.ask]
 * @param {() => string} [opts.getVersion]
 * @returns {Promise<http.Server>}
 */
export async function startPeerServer({ self, getLocalPort, ask, getVersion }) {
  const app = createPeerApp({ self, getLocalPort, ask, getVersion });
  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      if (err?.code === 'EADDRINUSE') {
        reject(new Error(`peer 端口 ${self.port} 已被占用（固定端口不会自动顺延，请换端口或关掉占用它的进程）`));
      } else if (err?.code === 'EACCES') {
        reject(new Error(`peer 端口 ${self.port} 无权绑定（可能落在 Windows 的保留端口段，换一个端口）`));
      } else {
        reject(err);
      }
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(self.port, self.host || '0.0.0.0');
  });

  logger.info?.(`[peer] 已监听 ${self.host || '0.0.0.0'}:${self.port}（节点 ${self.id}，令牌 ${maskToken(self.token)}）`);
  return server;
}

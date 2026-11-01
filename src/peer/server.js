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

import { tokenEquals, getSessionId, setSessionId, maskToken } from './store.js';
import { askLocalAgent } from './localAsk.js';
import logger from '../ui/server/utils/logger.js';

const MAX_QUESTION_CHARS = 4000;
const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;
const STARTED_AT = new Date().toISOString();

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
 */
export function createPeerApp({
  self,
  getLocalPort,
  ask,
  timeoutMs = DEFAULT_ASK_TIMEOUT_MS,
  getVersion = () => '',
  getSession = getSessionId,
  setSession = setSessionId
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
      capabilities: ['ask'],
      startedAt: STARTED_AT
    });
  });

  /**
   * POST /api/peer/ask — 让本机 g ai 回答一个问题。
   *
   * body: { question: string, from?: string /* 提问方节点 id *\/ }
   * 返回: { ok, answer, sessionId, ms }
   *
   * 会话连续性：每个提问方在**本机**占一个会话（key = `in:<from>`），这样 A 问
   * 第二句时 B 还记得第一句，但 A 和 C 的上下文不会串。
   */
  app.post('/api/peer/ask', async (req, res) => {
    const question = String(req.body?.question || '').trim();
    const from = String(req.body?.from || '').trim() || 'unknown';
    if (!question) return res.status(400).json({ ok: false, error: 'question 不能为空' });
    if (question.length > MAX_QUESTION_CHARS) {
      return res.status(413).json({ ok: false, error: `问题过长（上限 ${MAX_QUESTION_CHARS} 字）` });
    }

    const sessionKey = `in:${from}`;
    const sessionId = await getSession(sessionKey).catch(() => '');
    logger.info?.(`[peer] 收到提问 from=${from} len=${question.length}`);

    try {
      const runner = typeof ask === 'function'
        ? ask
        : (args) => askLocalAgent({ ...args, port: getLocalPort(), timeoutMs });
      const result = await runner({ question, sessionId, from });
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
      res.status(502).json({ ok: false, error: String(err?.message || err) });
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

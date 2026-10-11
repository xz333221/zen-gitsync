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
// MCP 服务端的 HTTP 传输(Streamable HTTP)—— 挂在现有 g ui 的 express 上,
// 路径 `/api/mcp`。
//
// 与 stdio 入口的区别不在协议,而在**上下文**:
//   · stdio(`g mcp`)是独立进程,看不到运行中的 job / 会话锁,派发要转发;
//   · 挂在这个进程上时,它就在 g ui 内部,理论上能拿到完整内存态。
// 两者共用同一套工具与同一个协议内核(src/mcp/server.js),行为不会分叉。
//
// 为什么是**无状态**的(不发 Mcp-Session-Id、不维护会话表):
// 全部工具都是"读一份数据 / 发一个请求"的无状态操作,没有跨请求的服务端状态,
// 也就没有要绑在 session 上的东西。少一层会话管理 = 少一处状态泄漏。
// 规范允许无状态实现,客户端(含本项目自己的 src/cli/ai/mcp.js)会正常工作。
import express from 'express';

import { createMcpServer, PARSE_ERROR, INVALID_REQUEST, INTERNAL_ERROR } from './server.js';
import { ALL_TOOLS } from './tools/index.js';

/**
 * 造一个 MCP 路由。
 *
 * @param {{ getCwd?: () => string, getLiveJobs?: () => Promise<object[]>,
 *           onLog?: (level: string, message: string) => void }} [options]
 *   getCwd 用函数而不是值 —— g ui 支持运行时切换当前项目(`g ui --path=...`,
 *   以及界面上的切换),捕获一个启动时的字符串会让 cwd 永远停在最初那个。
 *   getLiveJobs 是「接内存态」的口子:给了它,运行中任务的**完整**输出(而非
 *   live-jobs 落盘那份截尾快照)才拿得到,而且工作台相关的几个工具连带
 *   不用再去 parse 一份 37MB 的 jobs.json。不给也能跑,只是退回读盘。
 * @returns {import('express').Router}
 */
export function createMcpRouter({ getCwd, getLiveJobs, onLog } = {}) {
  const router = express.Router();

  const resolveCwd = () => {
    try {
      return typeof getCwd === 'function' ? (getCwd() || process.cwd()) : process.cwd();
    } catch {
      return process.cwd();
    }
  };

  const log = (level, message) => {
    if (typeof onLog === 'function') onLog(level, message);
  };

  /** 每个请求造一个 server 实例:ctx 里的 cwd / locale 是请求级的。 */
  function serverFor(req) {
    const locale = String(req.get('accept-language') || '').startsWith('en') ? 'en' : 'zh';
    return createMcpServer({
      tools: ALL_TOOLS,
      // getLiveJobs 传给工具层,由各工具自己决定有没有它、怎么降级
      ctx: { cwd: resolveCwd(), locale, transport: 'http', getLiveJobs },
      onLog: log,
    });
  }

  /**
   * 发现入口:GET 返回服务能力摘要(不是 SSE)。
   *
   * 规范里 GET 用于开 SSE 流(服务端主动推消息)。我们没有任何主动推送
   * (tools/listChanged = false),开一条永远没消息的流只会让客户端挂着。
   * 所以这里改成回一段人类/机器都可读的 JSON —— 便于 `curl` 一下确认
   * "这个端点在、有几个工具",而不会误导客户端。
   */
  router.get('/', (req, res) => {
    const server = serverFor(req);
    res.json({
      protocol: 'mcp',
      transport: 'streamable-http (无状态)',
      server: server.serverInfo,
      cwd: resolveCwd(),
      tool_count: server.toolNames.length,
      tools: server.toolNames,
      usage: 'POST 一条 JSON-RPC 到这里即可(initialize → tools/list → tools/call)。',
    });
  });

  /** 会话结束(DELETE)—— 无状态实现没有要清理的东西,回 200 让客户端安心。 */
  router.delete('/', (_req, res) => {
    res.json({ ok: true, note: '无状态服务端,没有会话需要清理。' });
  });

  router.post('/', async (req, res) => {
    const body = req.body;
    if (!body || (typeof body !== 'object' && !Array.isArray(body))) {
      return res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: INVALID_REQUEST, message: 'body 必须是一条 JSON-RPC 消息(或消息数组)' },
      });
    }

    const server = serverFor(req);
    try {
      if (Array.isArray(body)) {
        const results = (await Promise.all(body.map(m => server.handleMessage(m)))).filter(r => r !== null);
        // 全部是通知 → 规范要求 202 且无 body
        if (results.length === 0) return res.status(202).end();
        return res.json(results);
      }

      const result = await server.handleMessage(body);
      if (result === null) return res.status(202).end(); // 通知:202 Accepted,无响应体
      return res.json(result);
    } catch (err) {
      log('error', `HTTP 处理失败: ${err?.stack || err?.message || err}`);
      // 请求体合法但处理炸了 —— JSON-RPC 层回 -32603,别让客户端拿到一个裸 500
      const id = (body && !Array.isArray(body) && body.id !== undefined) ? body.id : null;
      return res.status(200).json({
        jsonrpc: '2.0',
        id,
        error: { code: INTERNAL_ERROR, message: `内部错误: ${err?.message || String(err)}` },
      });
    }
  });

  return router;
}

export { PARSE_ERROR };
export default { createMcpRouter };

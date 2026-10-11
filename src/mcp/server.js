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
// MCP 服务端的协议内核 —— 与 stdio / HTTP 两种传输解耦。
//
// 这个文件是 src/cli/ai/mcp.js(客户端)的**对称物**:那边实现了 initialize /
// tools/list / tools/call 三个方法,这边实现同样的三个,只是角色互换。
// 之所以同样不装 @modelcontextprotocol/sdk:dependencies 一直是精简的
// (14 个运行时依赖),而这套协议面本身很小,自己写换零依赖 + 完全可控的降级行为。
//
// 传输无关:handleMessage(一条 JSON-RPC) → 一条响应(或 null,表示这是通知)。
//   - src/mcp/stdio.js 按行读 stdin,一行一帧
//   - src/mcp/http.js  挂在现有 express 上,POST 一个 JSON-RPC 回一个
// 两条传输不做任何协议判断,全部逻辑收在这里,避免"两种入口行为不一致"。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** 包版本 —— 报给客户端的 serverInfo.version,便于排查"你装的是哪版" */
function readPackageVersion() {
  try {
    return require('../../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const SERVER_NAME = 'zen-gitsync';

/**
 * 我们认得的协议版本。握手时**回客户端报的那个**(如果认得),否则回自己最熟的那个。
 *
 * 为什么是"回客户端的":规范只要求服务端回一个自己支持的版本,客户端若发现不一致
 * 自行决定要不要继续。回客户端那个能最大限度避免老客户端被我们顶掉。
 * 三个版本在 tools/list / tools/call 上的形状完全一致,这里不做分支处理。
 */
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const PREFERRED_PROTOCOL = '2025-03-26';

/** JSON-RPC 错误码(只在协议级错误时用;工具自身的失败走 isError) */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** 给模型看的一段使用说明,随 initialize 一起下发。 */
const INSTRUCTIONS = [
  'zen-gitsync 是一个本地 Git GUI + 编码智能体工具,它把用户本机的这些数据暴露给你:',
  '- GitHub / Gitee 远程仓库、本机已克隆仓库',
  '- 正在运行的命令、任务与 g ui 实例',
  '- g ai 的对话会话、Skill、MCP 配置',
  '- 工作台的项目与任务(含派发新任务)、定时任务',
  '- 思维导图、跨会话记忆库',
  '',
  '建议先调 workspace_overview 摸清全貌,再按需深入具体板块。',
  '数据可能来自两个来源:直读磁盘文件(可能略滞后于界面),或转发给正在运行的 g ui',
  '(实时)。每个结果里都会标注来源,别把快照当成实时值。',
].join('\n');

/**
 * 造一个 MCP 服务端。
 *
 * @param {{ tools: Array<{name:string, description:string, inputSchema:object, handler:(args:object, ctx:object)=>any}>,
 *           ctx?: object, onLog?: (level:string, message:string)=>void }} options
 * @returns {{ handleMessage: (msg:object)=>Promise<object|null>, listTools: ()=>Array<object>,
 *             serverInfo: object, toolNames: string[] }}
 */
export function createMcpServer({ tools, ctx = {}, onLog } = {}) {
  const byName = new Map();
  for (const tool of tools || []) {
    if (!tool || typeof tool.name !== 'string' || typeof tool.handler !== 'function') continue;
    byName.set(tool.name, tool);
  }

  const log = (level, message) => {
    if (typeof onLog === 'function') onLog(level, message);
  };

  const serverInfo = {
    name: SERVER_NAME,
    title: 'Zen GitSync',
    version: readPackageVersion(),
  };

  const listTools = () => Array.from(byName.values()).map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : { type: 'object', properties: {} },
  }));

  /** 把工具 handler 的返回值收敛成 MCP 的 content 数组。 */
  function toContent(value) {
    if (value === undefined || value === null) return [{ type: 'text', text: '(空结果)' }];
    if (typeof value === 'string') return [{ type: 'text', text: value }];
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
  }

  async function callTool(name, args) {
    const tool = byName.get(name);
    if (!tool) {
      // 工具不存在是协议级问题(客户端调了不存在的东西),但对模型更友好的是
      // 回一个 isError 的文本 —— 它能看到"有什么工具可用"并自我纠正。
      return {
        content: [{
          type: 'text',
          text: `错误: 没有名为 "${name}" 的工具。可用工具: ${Array.from(byName.keys()).join(', ')}`,
        }],
        isError: true,
      };
    }
    try {
      const result = await tool.handler(args && typeof args === 'object' ? args : {}, ctx);
      return { content: toContent(result) };
    } catch (err) {
      // 工具内部异常变成 isError,而不是 JSON-RPC error —— 这样模型能读到原因并
      // 换条路走;JSON-RPC error 在多数客户端里会直接中断这一轮。
      log('error', `工具 ${name} 执行失败: ${err?.stack || err?.message || err}`);
      return {
        content: [{ type: 'text', text: `错误: 工具 ${name} 执行失败: ${err?.message || String(err)}` }],
        isError: true,
      };
    }
  }

  function ok(id, result) {
    return { jsonrpc: '2.0', id, result };
  }

  function fail(id, code, message, data) {
    return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
  }

  /**
   * 处理一条 JSON-RPC 消息。
   * @returns {Promise<object|null>} null 表示这是通知,不该有响应
   */
  async function handleMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return fail(null, INVALID_REQUEST, '不是合法的 JSON-RPC 消息');
    }
    const { id, method } = message;
    const isNotification = id === undefined || id === null;

    // 通知(如 notifications/initialized / notifications/cancelled)一律静默接受。
    // 回响应反而是错的 —— 规范里通知没有 id,回一条会让客户端当成孤儿响应丢弃。
    if (isNotification) {
      log('debug', `通知 ${method}`);
      return null;
    }

    switch (method) {
      case 'initialize': {
        const requested = String(message.params?.protocolVersion || '');
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : PREFERRED_PROTOCOL;
        log('info', `握手: 客户端 ${message.params?.clientInfo?.name || '未知'} / 协议 ${protocolVersion}`);
        return ok(id, {
          protocolVersion,
          capabilities: {
            // 只声明 tools。声明了别的(listChanged / resources subscribers)却不发通知
            // 会让部分客户端一直等,不如不声明。
            tools: { listChanged: false },
          },
          serverInfo,
          instructions: INSTRUCTIONS,
        });
      }

      case 'ping':
        return ok(id, {});

      case 'tools/list':
        return ok(id, { tools: listTools() });

      case 'tools/call': {
        const name = message.params?.name;
        if (typeof name !== 'string' || !name.trim()) {
          return fail(id, INVALID_PARAMS, 'tools/call 需要 params.name');
        }
        const startedAt = Date.now();
        const result = await callTool(name.trim(), message.params?.arguments);
        log('info', `调用 ${name} (${Date.now() - startedAt}ms)${result.isError ? ' [失败]' : ''}`);
        return ok(id, result);
      }

      // 客户端可能主动查资源/提示词(我们没实现,但别让它们把连接卡住)
      case 'resources/list':
        return ok(id, { resources: [] });
      case 'resources/templates/list':
        return ok(id, { resourceTemplates: [] });
      case 'prompts/list':
        return ok(id, { prompts: [] });

      default:
        log('warn', `未知方法 ${method}`);
        return fail(id, METHOD_NOT_FOUND, `不支持的方法: ${method}`);
    }
  }

  return {
    handleMessage,
    listTools,
    serverInfo,
    toolNames: Array.from(byName.keys()),
  };
}

export { PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL_ERROR, INSTRUCTIONS, SUPPORTED_PROTOCOLS, PREFERRED_PROTOCOL };

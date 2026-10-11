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
// MCP 服务端的 stdio 传输 —— 入口命令 `g mcp`。
//
// 帧格式:newline-delimited JSON(一行一条 JSON-RPC),与 src/cli/ai/mcp.js 的
// 客户端实现同一口径(那边读的也是按 \n 切)。不是 LSP 那套 Content-Length 分帧。
//
// ⚠️⚠️ stdio 传输下 **stdout 就是协议通道**。任何一句多余的 print / console.log /
// 依赖库的横幅输出,都会被客户端当成一条畸形消息,表现为"连不上 / 握手超时",
// 而错误信息还指向别处。所以这里做两件事:
//   1) 启动时把 console.* 全部改道 stderr(日志照样看得见,只是不污染协议)
//   2) 自己只往 stdout 写协议帧,且每帧一条 \n 结束
// 日志走 stderr 是 stderr 本身的意义所在 —— MCP 客户端会把 stderr 收进它的
// 诊断输出,出问题时那是唯一能看到原因的地方。
import { createMcpServer } from './server.js';
import { ALL_TOOLS } from './tools/index.js';

const DEBUG = process.env.ZEN_MCP_DEBUG === '1' || process.env.ZEN_MCP_DEBUG === 'true';

/** 把 console 的三个输出通道改道 stderr。必须在任何其它模块写 stdout 之前调用。 */
function redirectConsoleToStderr() {
  const write = (...parts) => {
    const line = parts.map(p => (typeof p === 'string' ? p : safeInspect(p))).join(' ');
    process.stderr.write(`${line}\n`);
  };
  console.log = write;
  console.info = write;
  console.warn = write;
  // console.error 本来就是 stderr,不动
}

function safeInspect(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 启动 stdio MCP 服务端。
 *
 * @returns {Promise<void>} **在 stdin 关闭前不会 resolve** —— 这是刻意的:
 *   调用方(CLI 入口)await 它,于是"服务在跑"这件事表达成一个还没结束的 await,
 *   而不是一个"函数返回了但进程靠副作用活着"。想改成直接调、不等,也安全。
 * @param {{ cwd?: string, locale?: string }} [options]
 */
export function runStdioServer({ cwd = process.cwd(), locale = 'zh' } = {}) {
  redirectConsoleToStderr();
  const log = (level, message) => {
    if (!DEBUG && level === 'debug') return;
    process.stderr.write(`[zen-mcp] ${level}: ${message}\n`);
  };

  const server = createMcpServer({
    tools: ALL_TOOLS,
    ctx: { cwd, locale, transport: 'stdio' },
    onLog: log,
  });

  log('info', `就绪 · ${server.toolNames.length} 个工具 · cwd=${cwd}`);
  log('info', `协议: stdio(newline-delimited JSON) · 进程 pid ${process.pid}`);

  let buffer = '';
  process.stdin.setEncoding('utf8');

  /**
   * 在飞的请求。
   *
   * ⚠️ 为什么必须记账:stdin 一关就退出的话,**正在跑的工具调用会连同它的响应一起丢**
   * —— 客户端已经发了 tools/call、正等着回话,却只看到进程没了。这不是理论问题:
   * workbench_task_detail 要 parse 一份 37MB 的 jobs.json,几百毫秒起步,
   * 而"发完最后一行就 end stdin"是命令行客户端的常规写法。
   * 所以退出前要把在飞的都等完。
   */
  const inFlight = new Set();
  const track = promise => {
    inFlight.add(promise);
    const drop = () => inFlight.delete(promise);
    promise.then(drop, drop);
    return promise;
  };

  const writeMessage = message => {
    if (message === null || message === undefined) return;
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  process.stdin.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      handleLine(line);
    }
  });

  function handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // 解析失败要回 -32700(id 未知,按规范回 null),别静默吞掉 ——
      // 客户端会因此一直等,比给个明确的错更难查。
      writeMessage({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: 这一行不是合法 JSON' },
      });
      return;
    }

    // 批量请求(JSON-RPC 2.0 允许数组):MCP 里罕见,但别崩
    const batch = Array.isArray(message) ? message : null;
    if (batch) {
      track(Promise.all(batch.map(m => server.handleMessage(m)))
        .then(results => {
          const filtered = results.filter(r => r !== null);
          if (filtered.length) writeMessage(filtered);
        })
        .catch(err => log('error', `批量处理失败: ${err?.message || err}`)));
      return;
    }

    track(server.handleMessage(message)
      .then(writeMessage)
      .catch(err => {
        log('error', `处理消息失败: ${err?.stack || err?.message || err}`);
        if (message && message.id !== undefined && message.id !== null) {
          writeMessage({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32603, message: `内部错误: ${err?.message || String(err)}` },
          });
        }
      }));
  }

  return new Promise(resolve => {
    process.stdin.on('end', async () => {
      // 处理残留的不带换行符的最后一行
      const tail = buffer.trim();
      if (tail) handleLine(tail);
      log('info', `stdin 已关闭,等待 ${inFlight.size} 个在飞的请求收尾…`);
      // 等完在飞的请求(带兜底上限,别让一个卡住的工具把我们挂在这儿)
      if (inFlight.size > 0) {
        await Promise.race([
          Promise.allSettled(Array.from(inFlight)),
          new Promise(r => setTimeout(r, 30_000)),
        ]);
      }
      log('info', '退出。');
      resolve();
      process.exit(0);
    });

    process.stdin.on('error', err => {
      log('error', `stdin 出错: ${err?.message || err}`);
      resolve();
      process.exit(1);
    });

    // 客户端(编辑器/桌面 App)关掉我们时是发 SIGTERM / SIGINT,静默退出即可
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        log('info', `收到 ${signal},退出。`);
        resolve();
        process.exit(0);
      });
    }

    // stdin 是 TTY 时(用户手敲 `g mcp`)给个提示,免得面对一个"什么都没发生"的终端
    if (process.stdin.isTTY) {
      process.stderr.write(
        '\n[zen-mcp] 正在以 stdio 模式等待 MCP 客户端。\n'
        + '          它不是交互式命令 —— 直接手敲不会有输出。\n'
        + '          要在 Agent 里用它,请把下面这段加进那个 Agent 的 MCP 配置:\n'
        + '            { "mcpServers": { "zen-gitsync": { "command": "g", "args": ["mcp"] } } }\n'
        + '          Ctrl+C 退出。\n\n',
      );
    }
  });
}

export default { runStdioServer };

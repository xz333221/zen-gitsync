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
// g ai 的 MCP(Model Context Protocol)客户端 — stdio 传输实现。
//
// 为什么自己实现而不是装 SDK:
//   本包 dependencies 一直保持精简,而 stdio 这一层的协议面很小
//   (newline-delimited JSON-RPC + initialize / tools/list / tools/call 三个方法),
//   自己写≈200 行,换取零依赖 + 完全可控的超时与降级行为。
//
// 配置来源(两级,项目级覆盖全局同名 server):
//   1) ~/.zen-gitsync/ai/mcp.json      「g ai 智能体」全局安装(对所有项目生效)
//   2) <cwd>/.mcp.json                 项目级安装
//   形状沿用 Claude 的 mcpServers,便于与生态里其他工具共享配置:
//   { "mcpServers": { "github": { "command": "npx", "args": ["-y", "@..."], "env": {} } } }
//
// ⚠️ Windows 上 spawn 的两个坑(已实测,不要"优化"掉):
//   1) 带空格的参数在 shell:true 下会被 cmd 拆碎 ——
//      spawn('node', ['C:\a b\proj'], { shell: true }) 子进程收到的是 "C:a" 和 "bproj";
//   2) Node >= 20.12 起,直接 spawn `npx.cmd` 这类批处理会抛 EINVAL(为修 CVE-2024-27980)。
//   所以这里的策略是:自己按 PATH/PATHEXT 解析出真实可执行文件 ——
//   解析到 .exe 就**完全不用 shell**(零转义风险),只有解析到 .cmd/.bat 才回落到
//   `cmd.exe /d /s /c "<整行>"` + windowsVerbatimArguments,并使用 cross-spawn 那套
//   经过十年验证的转义规则(否则项目路径里有空格就会连不上)。

import { spawn } from 'node:child_process';
import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { trackChild } from '../cleanup.js';
import { AI_MCP_FILE } from '../../paths.js';

const IS_WIN = process.platform === 'win32';

// 工具名前缀。OpenAI function calling 允许 [A-Za-z0-9_-],用双下划线分段。
export const MCP_TOOL_PREFIX = 'mcp__';

// 初始化握手超时。
// ⚠️ 别按"握手只需要几百毫秒"来定这个值:command 是 npx -y 时,**首次**会现场下载
// 整个 server 包及其依赖。国内直连 registry(无代理)实测这一步能轻松吃掉 30s+,
// 而 25s 超时后 close() 会把下载中的子进程杀掉,npm cache 始终填不满 —— 表现就是
// "每次首连都超时,但隔一会儿手动 spawn 一次却能秒连"。给到 90s 才能扛过首次下载。
const INIT_TIMEOUT_MS = 90_000;
// 单次工具调用超时。MCP 工具很多是外部 API,给得宽一些。
const CALL_TIMEOUT_MS = 120_000;
// stderr 只保留尾部,避免某个话痨 server 把内存吃光(报错时用来给用户看原因)
const MAX_STDERR_CHARS = 4000;

// ──────────────────────────────────────────────
// Windows 可执行文件解析 + 转义
// ──────────────────────────────────────────────

// 按 PATH + PATHEXT 找出 command 对应的真实文件(绝对路径)。找不到返回 null。
function resolveWindowsCommand(command) {
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasExt = path.extname(command) !== '';

  const candidates = [];
  if (command.includes('\\') || command.includes('/')) {
    // 显式路径:补全扩展名后原样尝试
    for (const ext of hasExt ? [''] : exts) candidates.push(command + ext.toLowerCase());
  } else {
    const dirs = (process.env.PATH || '').split(';').filter(Boolean);
    for (const dir of dirs) {
      for (const ext of hasExt ? [''] : exts) {
        candidates.push(path.join(dir, command + ext.toLowerCase()));
      }
    }
  }

  for (const candidate of candidates) {
    // 同步判断即可:只在建连时调一次,且必须拿到结果才能决定 spawn 方式
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* 继续找 */ }
  }
  return null;
}

// 单个参数的 cmd 转义(规则与 cross-spawn 一致)。
// 反斜杠数量的处理是关键:紧邻引号或行尾的反斜杠必须加倍,否则会被 cmd 吃掉。
function escapeCmdArgument(arg) {
  let out = `${arg}`;
  out = out.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  out = out.replace(/(?=(\\+?)?)\1$/, '$1$1');
  out = `"${out}"`;
  // % 会被 cmd 当环境变量展开,必须转义
  out = out.replace(/(?=(\\+?)?)\1%/, '$1$1%');
  // 元字符加 ^ 前缀,防止被 cmd 解释成管道/重定向
  out = out.replace(/(?=(\\+?)?)\1(\^|&|\||<|>|\^)/g, '$1$1^$2');
  return out;
}

/**
 * 把 {command, args} 翻译成可以交给 spawn 的 (file, args, options)。
 *
 * - 解析到 .exe / POSIX 可执行文件 → 直接 spawn,不经过任何 shell
 * - 解析到 .cmd / .bat → 走 cmd.exe,整行用引号包起来配合 /s 的"去首尾引号"规则
 *
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ file: string, argv: string[], options: object }}
 */
export function buildSpawnSpec(command, args, env) {
  const argv = (Array.isArray(args) ? args : []).map(String);

  if (!IS_WIN) {
    return { file: command, argv, options: { env, windowsHide: true } };
  }

  const resolved = resolveWindowsCommand(command);
  // 解析不到时仍然交给 cmd 试一次 —— 可能是 PATH 之外的写法,让用户看到真实报错
  const target = resolved || command;

  if (/\.(exe|com)$/i.test(target)) {
    return { file: target, argv, options: { env, windowsHide: true } };
  }

  // .cmd / .bat(以及解析不出来的情况):交给 cmd.exe,自己控制转义
  const line = [target, ...argv].map(escapeCmdArgument).join(' ');
  return {
    file: process.env.ComSpec || process.env.comspec || 'cmd.exe',
    argv: ['/d', '/s', '/c', `"${line}"`],
    options: { env, windowsHide: true, windowsVerbatimArguments: true },
  };
}

// ──────────────────────────────────────────────
// 配置读取
// ──────────────────────────────────────────────

/**
 * 读取一个 mcp.json 形状的配置文件,返回 mcpServers 对象。
 * 文件不存在 / 坏了都只当"没有配置",不抛错 —— 一个坏文件不该让 g ai 起不来。
 */
async function readServersFile(file) {
  const raw = await fs.readFile(file, 'utf8').catch(() => '');
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== 'object') return {};
    const out = {};
    for (const [id, cfg] of Object.entries(servers)) {
      if (!cfg || typeof cfg !== 'object') continue;
      if (!cfg.command || typeof cfg.command !== 'string') continue;
      out[id] = cfg;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 合并全局 + 项目两处 MCP 配置,项目级覆盖同名全局 server。
 *
 * @param {{ cwd?: string, globalFile?: string, projectFile?: string }} [options]
 * @returns {Promise<{ servers: Record<string, object>, sources: Array<object> }>}
 */
export async function loadMcpServers({ cwd, globalFile = AI_MCP_FILE, projectFile } = {}) {
  const globalServers = await readServersFile(globalFile);
  const projectPath = projectFile || (cwd ? path.join(path.resolve(cwd), '.mcp.json') : null);
  const projectServers = projectPath ? await readServersFile(projectPath) : {};
  return {
    servers: { ...globalServers, ...projectServers },
    sources: [
      { file: globalFile, scope: 'global', count: Object.keys(globalServers).length },
      ...(projectPath ? [{ file: projectPath, scope: 'project', count: Object.keys(projectServers).length }] : []),
    ],
  };
}

// ──────────────────────────────────────────────
// 单个 server 的连接
// ──────────────────────────────────────────────

// 工具名会被拼进 OpenAI 的 function name,必须收敛到安全字符集
function sanitizeToolName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
}

class McpConnection {
  /**
   * @param {string} id - server 标识(配置里的键名)
   * @param {object} config - { command, args, env, disabled? }
   * @param {string} cwd - 工作目录(spawn 的 cwd)
   */
  constructor(id, config, cwd) {
    this.id = id;
    this.config = config;
    this.cwd = cwd;
    this.child = null;
    this.tools = [];
    this.error = null;
    this.stderr = '';
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.closed = false;
  }

  get safeId() {
    return sanitizeToolName(this.id);
  }

  /**
   * 启动子进程并完成 initialize + tools/list 握手。
   * 任何失败都写进 this.error 并返回 false,由调用方决定是否提示用户。
   * @returns {Promise<boolean>}
   */
  async start() {
    try {
      // PWD/OLDPWD 可能残留 POSIX 风格路径,子进程(cmd/pwsh/npx)拿它当 cwd 会炸
      const env = { ...process.env, ...(this.config.env || {}) };
      delete env.PWD;
      delete env.OLDPWD;

      const spec = buildSpawnSpec(this.config.command, this.config.args, env);
      this.child = trackChild(spawn(spec.file, spec.argv, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], ...spec.options }));

      // 提前挂 error 监听:ENOENT 之类的失败是异步抛的,不接住会变成 unhandled
      const spawnFailed = new Promise((_, reject) => {
        this.child.once('error', err => reject(new Error(`无法启动 ${this.config.command}: ${err.message}`)));
      });
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', chunk => this.#onData(chunk));
      this.child.stderr.setEncoding('utf8');
      this.child.stderr.on('data', chunk => {
        this.stderr = (this.stderr + chunk).slice(-MAX_STDERR_CHARS);
      });
      this.child.on('exit', code => this.#onExit(code));
      // 子进程先于握手退出时,让 request 立即失败而不是干等到超时
      this.spawnFailed = spawnFailed;
      spawnFailed.catch(() => {});

      await this.#request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'zen-gitsync-g-ai', version: '1.0.0' },
      }, INIT_TIMEOUT_MS);
      this.#notify('notifications/initialized', {});

      const listed = await this.#request('tools/list', {}, INIT_TIMEOUT_MS);
      this.tools = (Array.isArray(listed?.tools) ? listed.tools : [])
        .filter(tool => tool && typeof tool.name === 'string')
        .map(tool => ({
          serverId: this.id,
          name: tool.name,
          description: tool.description || '',
          inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object'
            ? tool.inputSchema
            : { type: 'object', properties: {} },
        }));
      return true;
    } catch (err) {
      this.error = err.message;
      await this.close();
      return false;
    }
  }

  #onData(chunk) {
    this.buffer += chunk;
    // stdio 传输是 newline-delimited JSON(不是 LSP 的 Content-Length 分帧)
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line) } catch { continue }
      if (message.id === undefined) continue; // 通知(如 notifications/message),忽略
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || `MCP error ${message.error.code}`));
      else entry.resolve(message.result);
    }
  }

  #onExit(code) {
    const reason = new Error(`MCP server "${this.id}" 已退出(code ${code})${this.stderr.trim() ? `: ${this.stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    this.pending.clear();
    if (!this.closed) this.error = reason.message;
  }

  #write(message) {
    if (!this.child?.stdin?.writable) throw new Error(`MCP server "${this.id}" 不可写(可能已退出)`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #notify(method, params) {
    try { this.#write({ jsonrpc: '2.0', method, params }) } catch { /* 通知失败不影响主流程 */ }
  }

  #request(method, params, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} 超时(${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** 调用一个工具,把 MCP 的 content 数组拍平成字符串回喂给模型。 */
  async callTool(name, args) {
    const result = await this.#request('tools/call', { name, arguments: args || {} }, CALL_TIMEOUT_MS);
    return flattenToolResult(result);
  }

  async close() {
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('MCP 连接已关闭'));
    }
    this.pending.clear();
    if (!this.child) return;
    try { this.child.stdin?.end() } catch { /* noop */ }
    const child = this.child;
    this.child = null;
    try { child.kill() } catch { /* noop */ }
    // Windows 上 .cmd 是 cmd.exe 的孙子进程,kill 父进程不保证孙进程退出。
    // 给一小段时间让 stdio 自然关闭,再兜底强杀。
    await new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* noop */ }
        resolve();
      }, 400);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

// MCP tools/call 返回 { content: [{type:'text',text} | {type:'image',...} | {type:'resource',...}], isError? }
function flattenToolResult(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const text = parts.map(part => {
    if (!part || typeof part !== 'object') return '';
    if (part.type === 'text') return part.text || '';
    if (part.type === 'image') return `[image ${part.mimeType || ''} 已省略]`;
    if (part.type === 'resource') return `[resource ${part.resource?.uri || ''}]`;
    return JSON.stringify(part);
  }).filter(Boolean).join('\n');

  const body = text || (result === undefined ? '' : JSON.stringify(result));
  if (result?.isError) return `错误: ${body || 'MCP 工具返回失败'}`;
  // 单个工具回吐超大内容会挤占上下文,与 tools.js 的截断口径保持一致
  return body.length > 8000 ? `${body.slice(0, 6000)}\n\n... [已截断 ${body.length - 6000} 字符]` : body;
}

// ──────────────────────────────────────────────
// 管理器
// ──────────────────────────────────────────────

export class McpManager {
  constructor(connections = []) {
    this.connections = connections;
    /** @type {Map<string, { connection: McpConnection, remoteName: string }>} */
    this.registry = new Map();
    this.#index();
  }

  #index() {
    this.registry.clear();
    for (const connection of this.connections) {
      for (const tool of connection.tools) {
        this.registry.set(`${MCP_TOOL_PREFIX}${connection.safeId}__${sanitizeToolName(tool.name)}`, {
          connection,
          remoteName: tool.name,
        });
      }
    }
  }

  /**
   * 读取配置 → 逐个建连 → 汇总工具。
   * 单个 server 失败只记录在状态里,不影响其他 server,也不影响 g ai 原有能力。
   *
   * @param {{ cwd?: string, globalFile?: string, servers?: object, sources?: Array<object>,
   *           onWarn?: (msg: string) => void }} [options]
   * @returns {Promise<McpManager>}
   */
  static async create({ cwd, globalFile, servers, sources, onWarn } = {}) {
    let resolved = servers;
    let resolvedSources = sources;
    if (!resolved) {
      const loaded = await loadMcpServers({ cwd, globalFile });
      resolved = loaded.servers;
      resolvedSources = loaded.sources;
    }
    const enabled = Object.entries(resolved).filter(([, cfg]) => !cfg.disabled);

    const settled = await Promise.all(enabled.map(async ([id, cfg]) => {
      const connection = new McpConnection(id, cfg, cwd || process.cwd());
      const ok = await connection.start();
      if (!ok && onWarn) onWarn(`MCP "${id}" 连接失败: ${connection.error}`);
      return connection;
    }));

    const manager = new McpManager(settled);
    manager.sources = resolvedSources;
    return manager;
  }

  get toolDefinitions() {
    return this.connections.flatMap(connection => connection.tools.map(tool => ({
      type: 'function',
      function: {
        name: `${MCP_TOOL_PREFIX}${connection.safeId}__${sanitizeToolName(tool.name)}`,
        description: tool.description || `${tool.name} (MCP: ${connection.id})`,
        parameters: tool.inputSchema,
      },
    })));
  }

  get toolCount() {
    return this.registry.size;
  }

  has(toolName) {
    return this.registry.has(toolName);
  }

  /** 给系统提示词用的连接摘要。全部失败时返回空串。 */
  describe({ locale } = {}) {
    const ok = this.connections.filter(c => !c.error);
    if (ok.length === 0) return '';
    const zh = !String(locale || '').startsWith('en');
    const lines = this.connections.map(connection => {
      if (connection.error) {
        return `- ${connection.id}: ${zh ? '连接失败' : 'failed'} — ${connection.error}`;
      }
      const names = connection.tools.map(t => t.name).join(', ') || (zh ? '(无工具)' : '(no tools)');
      return `- ${connection.id}: ${connection.tools.length} ${zh ? '个工具' : 'tools'} — ${names}`;
    });
    return zh
      ? `\n\n# 已接入的 MCP 服务\n这些外部工具已挂到你的工具列表里(名字以 \`${MCP_TOOL_PREFIX}\` 开头),直接调用即可,不需要额外确认:\n${lines.join('\n')}`
      : `\n\n# Connected MCP servers\nThese external tools are already in your tool list (names start with \`${MCP_TOOL_PREFIX}\`). Call them directly:\n${lines.join('\n')}`;
  }

  /** 连接状态(供 /mcp 之类的诊断命令使用) */
  status() {
    return this.connections.map(connection => ({
      id: connection.id,
      command: connection.config.command,
      tools: connection.tools.length,
      error: connection.error,
    }));
  }

  /**
   * 调用一个 MCP 工具。未知工具名返回 null 让调用方回落到内置工具表。
   */
  async call(toolName, args) {
    const entry = this.registry.get(toolName);
    if (!entry) return null;
    try {
      return await entry.connection.callTool(entry.remoteName, args);
    } catch (err) {
      // 与 tools.js 的口径一致:工具错误变成字符串回喂,不中断 agent 循环
      return `错误: MCP 工具 ${toolName} 执行失败: ${err.message}`;
    }
  }

  async close() {
    await Promise.all(this.connections.map(connection => connection.close()));
  }
}

export default { McpManager, loadMcpServers, buildSpawnSpec, MCP_TOOL_PREFIX };

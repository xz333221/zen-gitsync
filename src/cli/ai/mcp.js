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
// g ai 的 MCP(Model Context Protocol)客户端 — 支持 stdio 与 Streamable HTTP 两种传输。
//
// 为什么自己实现而不是装 SDK:
//   本包 dependencies 一直保持精简,而这两种传输的协议面都很小
//   (JSON-RPC + initialize / tools/list / tools/call 三个方法),自己写换取
//   零依赖 + 完全可控的超时与降级行为。
//
// 配置来源(两级,项目级覆盖全局同名 server):
//   1) ~/.zen-gitsync/ai/mcp.json                    「g ai 智能体」全局安装(对所有项目生效)
//   2) <cwd>/.zen-gitsync/ai/mcp.json                项目级安装
//   形状沿用生态通行的 mcpServers。项目级路径常量与广场安装端共用 src/paths.js 那一份;
//   项目级**不再读** <cwd>/.mcp.json(那是 Claude Code 一系的约定路径,2026-09-30 迁出)。
//
// 两种条目形状,按有没有 command 自动区分(同一条目同时有两者时以 command 为准):
//   { "github": { "command": "npx", "args": ["-y", "@..."], "env": {} } }
//   { "todo":   { "type": "http", "url": "https://.../api/mcp", "headers": { "Authorization": "Bearer ..." } } }
//
// HTTP 侧只说 Streamable HTTP(2025-03-26 起规范里的那套):
//   POST JSON-RPC → 200 application/json 或 text/event-stream(取 id 匹配的那一帧);
//   响应头里的 Mcp-Session-Id 会被记住并在后续请求回传;关闭时尽力 DELETE 结束会话。
//   老式 "HTTP+SSE"(2024-11-05 的 GET /sse + POST endpoint)不在此列 —— 那种服务端
//   自己也在陆续迁走,真需要时用 mcp-remote 桥成 stdio 更省事。
//
// ⚠️ HTTPS 的证书链:fetch 走 Node 内置根证书,不读 Windows/macOS 证书库。
//   站点只发叶证书、中间证书没带全时,Node 会报 unable to verify the first certificate,
//   而浏览器/curl 都正常。这里**不擅自关校验**(那是安全红线),只在报错里把可操作的做法写清楚。
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
import { AI_MCP_FILE, projectMcpFile } from '../../paths.js';

const IS_WIN = process.platform === 'win32';

// 工具名前缀。OpenAI function calling 允许 [A-Za-z0-9_-],用双下划线分段。
export const MCP_TOOL_PREFIX = 'mcp__';

// 握手时声明的协议版本。stdio 沿用旧值不动(现有 server 都是照这个档位对接的);
// HTTP 侧必须报 Streamable HTTP 那一版,否则部分服务端会按老式 HTTP+SSE 处理。
const STDIO_PROTOCOL_VERSION = '2024-11-05';
const HTTP_PROTOCOL_VERSION = '2025-03-26';

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
 *
 * 保留条件:有 command(stdio)或有 http(s) 的 url(Streamable HTTP)。
 * 两者都没有的条目直接丢掉 —— 免得后面按 undefined 去 spawn 炸得莫名其妙。
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
      const hasCommand = typeof cfg.command === 'string' && cfg.command.trim() !== '';
      const hasUrl = typeof cfg.url === 'string' && /^https?:\/\//i.test(cfg.url.trim());
      if (!hasCommand && !hasUrl) continue;
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
  const projectPath = projectFile || (cwd ? projectMcpFile(cwd) : null);
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

/**
 * 这个条目该走哪种传输:有 command 就是 stdio(优先级高于 url),
 * 否则 url 是 http(s) 时走 Streamable HTTP。
 *
 * @param {object} config
 * @returns {'stdio'|'http'|null} null = 两边都不像,调用方应跳过
 */
export function serverTransport(config) {
  if (!config || typeof config !== 'object') return null;
  if (typeof config.command === 'string' && config.command.trim() !== '') return 'stdio';
  if (typeof config.url === 'string' && /^https?:\/\//i.test(config.url.trim())) return 'http';
  return null;
}

// 工具名会被拼进 OpenAI 的 function name,必须收敛到安全字符集
function sanitizeToolName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
}

/**
 * 两种传输共用的握手:initialize → notifications/initialized → tools/list。
 * 请求/通知都通过参数注入,stdio 与 HTTP 各交各的实现。
 *
 * @param {{ id: string, protocolVersion: string,
 *           request: (method: string, params: object, timeoutMs: number) => Promise<any>,
 *           notify: (method: string, params: object) => any }} io
 * @returns {Promise<Array<object>>} 归一化后的工具定义
 */
async function handshake({ id, protocolVersion, request, notify }) {
  await request('initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'zen-gitsync-g-ai', version: '1.0.0' },
  }, INIT_TIMEOUT_MS);
  await notify('notifications/initialized', {});

  const listed = await request('tools/list', {}, INIT_TIMEOUT_MS);
  return (Array.isArray(listed?.tools) ? listed.tools : [])
    .filter(tool => tool && typeof tool.name === 'string')
    .map(tool => ({
      serverId: id,
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : { type: 'object', properties: {} },
    }));
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

  /** 传输类型。诊断(/mcp)与 UI 展示用,连接本身不依赖它。 */
  get transport() {
    return 'stdio';
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

      this.tools = await handshake({
        id: this.id,
        protocolVersion: STDIO_PROTOCOL_VERSION,
        request: (method, params, timeoutMs) => this.#request(method, params, timeoutMs),
        notify: (method, params) => this.#notify(method, params),
      });
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

// ──────────────────────────────────────────────
// Streamable HTTP 传输
// ──────────────────────────────────────────────

// Node 内置根证书不认站点证书链时的错误码 —— 单独识别出来,好把"该怎么修"写进提示
const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function shortText(text, max) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * 把 fetch 的失败翻译成用户能照着做的中文。
 * 证书链那条是本项目实测踩过的坑:服务端只发叶证书时,浏览器和 curl 都正常,
 * 唯独 Node 报 unable to verify the first certificate —— 只说 "fetch failed" 等于没说。
 */
function describeHttpError(err, id) {
  const message = err?.message || String(err);
  // 已经翻译过的(#send 里翻过一次)不要二次加工成"连接 x 失败: 连接 x 失败: ..."
  if (message.startsWith(`连接 "${id}"`)) return message;

  const cause = err?.cause;
  const code = cause?.code || '';
  if (TLS_ERROR_CODES.has(code)) {
    return `连接 "${id}" 失败:服务器证书链不被 Node 内置根证书信任(${code})。`
      + '可任选一种办法:① 启动 g ai 前设 NODE_EXTRA_CA_CERTS=<站点 CA 文件路径>;'
      + '② Node ≥ 22.15 时用 NODE_OPTIONS=--use-system-ca 改走系统证书库;'
      + '③ 让服务端补齐中间证书。';
  }
  if (message === 'fetch failed' && (code || cause?.message)) {
    // 优先用错误码:undici 的 cause.message 往往还是那句 "fetch failed",没有信息量
    const detail = code || cause.message;
    return `连接 "${id}" 失败: ${message} (${detail})`;
  }
  return `连接 "${id}" 失败: ${message}`;
}

/** SSE 帧 → JSON-RPC 消息。只认 data: 行,event: / id: / 注释行一律忽略。 */
function parseSseFrame(frame) {
  const data = frame.split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n');
  if (!data.trim()) return null;
  try { return JSON.parse(data) } catch { return null }
}

/**
 * 一个远程 MCP 服务(Streamable HTTP)的连接。
 * 对外接口与 stdio 版完全一致(start / tools / callTool / close / error),
 * 上层 McpManager 不需要知道下面是怎么连的。
 */
export class HttpConnection {
  /**
   * @param {string} id - server 标识(配置里的键名)
   * @param {object} config - { url, headers?, disabled? }
   * @param {string} cwd - 只是保持与 stdio 版的构造签名一致(HTTP 没有子进程)
   */
  constructor(id, config, cwd) {
    this.id = id;
    this.config = config;
    this.cwd = cwd || process.cwd();
    this.tools = [];
    this.error = null;
    // 与 stdio 版同形状:那边把子进程 stderr 留在这里,HTTP 没有对应物
    this.stderr = '';
    this.closed = false;
    this.sessionId = '';
    this.nextId = 1;
  }

  get safeId() { return sanitizeToolName(this.id) }

  get transport() { return 'http' }

  get endpoint() { return String(this.config.url || '').trim() }

  /**
   * 握手(initialize → notifications/initialized → tools/list)。
   * 失败写进 this.error 并返回 false,由 McpManager 汇总,不影响其他 server。
   */
  async start() {
    try {
      if (!/^https?:\/\//i.test(this.endpoint)) {
        throw new Error(`url 不合法: ${this.endpoint || '(空)'}`);
      }
      this.tools = await handshake({
        id: this.id,
        protocolVersion: HTTP_PROTOCOL_VERSION,
        request: (method, params, timeoutMs) => this.#request(method, params, timeoutMs),
        // 通知失败不拖垮握手(与 stdio 版一个态度),只在后台记账
        notify: (method, params) => { this.#notify(method, params).catch(() => {}) },
      });
      return true;
    } catch (err) {
      this.error = describeHttpError(err, this.id);
      this.closed = true;
      return false;
    }
  }

  #headers() {
    const headers = {
      'Content-Type': 'application/json',
      // 少写 text/event-stream 会被规范型实现判 406,这是 Streamable HTTP 的硬要求
      'Accept': 'application/json, text/event-stream',
    };
    for (const [key, value] of Object.entries(this.config.headers || {})) {
      if (!key || value === undefined || value === null) continue;
      headers[key] = String(value);
    }
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    return headers;
  }

  /** 发一条 JSON-RPC,返回 result(通知类无响应体时是 null);失败抛已翻译过的 Error。 */
  async #send(payload, timeoutMs) {
    if (this.closed) throw new Error('MCP 连接已关闭');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetch(this.endpoint, {
          method: 'POST',
          headers: this.#headers(),
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (err) {
        const failure = err?.name === 'AbortError'
          ? new Error(`请求超时(${Math.round(timeoutMs / 1000)}s)`)
          : err;
        throw new Error(describeHttpError(failure, this.id));
      }

      const sessionId = response.headers.get('mcp-session-id');
      if (sessionId) this.sessionId = sessionId;

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${body ? `: ${shortText(body, 300)}` : ''}`);
      }

      const contentType = String(response.headers.get('content-type') || '');
      if (contentType.includes('text/event-stream')) {
        return await this.#readSseResult(response, payload.id);
      }

      const text = await response.text();
      if (!text.trim()) return null; // 202 Accepted:通知类请求没有响应体
      let message;
      try { message = JSON.parse(text) } catch {
        throw new Error(`响应不是合法 JSON: ${shortText(text, 200)}`);
      }
      if (message?.error) throw new Error(message.error.message || `MCP error ${message.error.code}`);
      return message?.result ?? null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 读 SSE 响应,取 id 匹配的那一帧。
   *
   * 用流式 reader 而不是 await response.text():服务端完全可以在返回响应后继续推通知、
   * 把流一直挂着,等整条流读完就会一路挂到超时。拿到目标帧立刻 cancel。
   */
  async #readSseResult(response, wantedId) {
    const reader = response.body?.getReader?.();
    if (!reader) return null;
    const decoder = new TextDecoder();
    let buffer = '';
    let found = null;
    try {
      while (!found) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index).replace(/^\r?\n\r?\n/, '');
          const message = parseSseFrame(frame);
          if (!message) continue;
          // 服务器主动推的通知(没有 id)直接忽略
          if (wantedId === undefined || message.id === wantedId) { found = message; break }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    if (!found) return null;
    if (found.error) throw new Error(found.error.message || `MCP error ${found.error.code}`);
    return found.result ?? null;
  }

  #request(method, params, timeoutMs) {
    const id = this.nextId++;
    return this.#send({ jsonrpc: '2.0', id, method, params }, timeoutMs);
  }

  #notify(method, params) {
    return this.#send({ jsonrpc: '2.0', method, params }, INIT_TIMEOUT_MS);
  }

  /** 调用一个工具。口径与 stdio 版一致:content 数组拍平成字符串回喂给模型。 */
  async callTool(name, args) {
    const result = await this.#request('tools/call', { name, arguments: args || {} }, CALL_TIMEOUT_MS);
    return flattenToolResult(result);
  }

  async close() {
    this.closed = true;
    const url = this.endpoint;
    if (!url || !this.sessionId) return;
    // 规范里结束会话是 DELETE(带 session 头),不是所有服务端都实现 —— 尽力而为
    try {
      await fetch(url, { method: 'DELETE', headers: this.#headers(), signal: AbortSignal.timeout(5000) });
    } catch { /* noop */ }
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
      // 有 command → 本地子进程;只有 url → 远程 Streamable HTTP(serverTransport 已判过一遍)
      const connection = serverTransport(cfg) === 'http'
        ? new HttpConnection(id, cfg, cwd || process.cwd())
        : new McpConnection(id, cfg, cwd || process.cwd());
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
      transport: connection.transport,
      // http 型没有 command,退回显示 url —— 渲染端只认这一个字段
      command: connection.config.command || connection.config.url || '',
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

export default { McpManager, HttpConnection, loadMcpServers, buildSpawnSpec, serverTransport, MCP_TOOL_PREFIX };

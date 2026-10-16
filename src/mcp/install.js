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
// `g mcp install` —— 把自己登记成别的 Agent 的 MCP 服务。
//
// 为什么要有它:MCP 的接入方式本质上是"在那个 Agent 的配置文件里加一段",而
// 每个产品的配置**文件路径与格式都不一样**(Claude Desktop 是 json、Codex 是 toml、
// VS Code 的 mcp.json 用 servers 键、OpenCode 的 server 直接挂在 mcp 下且 command
// 是数组)。让用户自己手抄路径是最容易出错的一步 —— 写错位置的表现是"配了但没生效",
// 而错误日志往往指向别处。
//
// 三条设计约束:
//   1. **只加不覆盖**:合并式写入,保留文件里原有的 server 与其它配置项。
//      写之前先备份(.bak),出事能退回去。
//   2. **不猜未安装的产品**:目标文件所在目录都不存在就说明没装过,标记为"未检测到"
//      并跳过(除非显式 --force)。免得凭空造出一堆没人用的配置文件。
//   3. **幂等**:已经登记过且命令一致 → 报告"已存在",不重复写。
//
// 这个模块有**两个消费者**:
//   · CLI 的 `g mcp install`(runMcpInstall,普通命令行,往 stdout 打印人看的文本);
//   · g ui 的「顶栏编辑器按钮右键 → 添加 zen-gitsync MCP」(routes/mcpInstall.js,
//     同一份 install/uninstall/listTargets,不另写一套)。
// 所以下面所有函数都不碰 console(除 runMcpInstall 自己),也不假设调用方是终端。
//
// ⚠️ 这个入口是**普通命令行**,往 stdout 打印正常文本。这与 `g mcp`(stdio)不同 ——
// 那条路 stdout 是协议通道,一句多余输出就会让客户端解析失败。两者靠 argv[3] 分流。
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';

import { AI_MCP_FILE } from '../paths.js';
import { fileExists } from './util.js';

/** 服务 id:写进各产品配置的键名 */
export const SERVER_ID = 'zen-gitsync';
/** 启动命令。用 `g` 而不是绝对路径 —— 用户在 PATH 里装的就是它 */
const COMMAND = 'g';
const ARGS = ['mcp'];

/**
 * 默认 server 条目:stdio 形态的 command + args。
 * Claude 系(Claude Desktop / Claude Code CLI / Cursor / Windsurf)、VS Code、
 * Pi Agent 都是这个形状;形状不同的目标用自己的 `entry` 覆盖(见 TARGETS)。
 */
const DEFAULT_ENTRY = { command: COMMAND, args: ARGS };

/**
 * 家目录解析。测试用 ZEN_MCP_HOME 指到临时目录(与 paths.js 里
 * ZEN_LOCAL_REPOS_CACHE 同一套路):TARGETS 的 file() 全是**调用时求值**,
 * 所以 import 之后设环境变量也来得及,不需要像 paths.js 那样抢在 import 前。
 */
function homeDir() {
  return process.env.ZEN_MCP_HOME || os.homedir();
}

/** Windows 的 APPDATA(Claude Desktop / VS Code 的用户级配置都在它下面)。ZEN_MCP_APPDATA 为测试钩子。 */
function appDataDir() {
  return process.env.ZEN_MCP_APPDATA || process.env.APPDATA || '';
}

/** 平台相关的配置文件位置。返回 null 表示该平台不支持这个目标。 */
function claudeConfigPath() {
  if (process.platform === 'win32') {
    return appDataDir() ? path.join(appDataDir(), 'Claude', 'claude_desktop_config.json') : null;
  }
  if (process.platform === 'darwin') {
    return path.join(homeDir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  return path.join(homeDir(), '.config', 'Claude', 'claude_desktop_config.json');
}

/**
 * VS Code **用户级** mcp.json —— 命令面板 "MCP: Open User Configuration" 打开的
 * 就是它(用户 profile 目录下),对所有工作区生效。注意键名是 `servers` 而不是
 * `mcpServers`(VS Code 自己的格式;工作区里那份可移植的 .mcp.json 才用 mcpServers)。
 */
function vscodeConfigPath() {
  if (process.platform === 'win32') {
    return appDataDir() ? path.join(appDataDir(), 'Code', 'User', 'mcp.json') : null;
  }
  if (process.platform === 'darwin') {
    return path.join(homeDir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  }
  return path.join(homeDir(), '.config', 'Code', 'User', 'mcp.json');
}

/** OpenCode 全局配置。XDG 路径,全平台一个样(~/.config/opencode/opencode.json)。 */
function opencodeConfigPath() {
  return path.join(homeDir(), '.config', 'opencode', 'opencode.json');
}

/**
 * CodeBuddy 的 MCP 配置:官方优先级 ~/.codebuddy/.mcp.json > ~/.codebuddy/mcp.json
 * (deprecated) > ~/.codebuddy.json(legacy),**同作用域只读第一个存在的**。
 * ⚠️ 所以不能无脑建 .mcp.json:用户有 ~/.codebuddy.json 时建新文件,旧文件里的
 * 其他 server 会从 CodeBuddy 视野里消失(它不合并多个文件)。这里按"第一个存在的,
 * 都没有就建优先级最高的"来选,与官方写入规则一致。
 */
function codebuddyConfigPath() {
  const candidates = [
    path.join(homeDir(), '.codebuddy', '.mcp.json'),
    path.join(homeDir(), '.codebuddy', 'mcp.json'),
    path.join(homeDir(), '.codebuddy.json'),
  ];
  return candidates.find(existsSync) || candidates[0];
}

/**
 * Pi Agent 的全局 MCP 配置:<agentDir>/mcp.json。agentDir 默认 ~/.pi/agent,
 * 可被官方环境变量 PI_CODING_AGENT_DIR 覆盖(executorModels.js 读 settings.json
 * 用的就是同一个口径,两处不能分叉)。
 */
function piConfigPath() {
  const dir = process.env.PI_CODING_AGENT_DIR
    ? path.resolve(process.env.PI_CODING_AGENT_DIR)
    : path.join(homeDir(), '.pi', 'agent');
  return path.join(dir, 'mcp.json');
}

/**
 * 已知目标。
 * kind: 'json' = 顶层(或 jsonPath 指定的那层)有 server 表;
 *       'toml' = Codex 的 TOML,用 [mcp_servers.<id>] 段。
 *
 * 两个可选字段(不给就走默认):
 *   jsonPath —— server 表在 JSON 里的路径。默认 ['mcpServers'](Claude 系);
 *              VS Code 是 ['servers'];OpenCode 是 ['mcp'](server 名直接挂在 mcp 下,
 *              v1 配置格式;当前 stable schema 同时兼容 mcp.servers,写 v1 形状
 *              1.x/2.x 都认)。
 *   entry    —— 写进去的 server 条目。默认 { command:'g', args:['mcp'] };
 *              OpenCode 的 command 是**数组**且要 type/enabled;CodeBuddy 官方建议
 *              显式 type。各家形状不同,不硬凑一个公共词。
 */
export const TARGETS = [
  {
    id: 'zen',
    label: 'zen-gitsync 自己（g ai）',
    kind: 'json',
    file: () => AI_MCP_FILE,
    note: '装完 g ai 就能读到本工具自己的各板块数据',
  },
  {
    id: 'claude',
    label: 'Claude Desktop',
    kind: 'json',
    file: claudeConfigPath,
    note: '重启 Claude Desktop 生效',
  },
  {
    id: 'claude-code',
    label: 'Claude Code（CLI）',
    kind: 'json',
    file: () => path.join(homeDir(), '.claude.json'),
    note: '重开 claude 会话生效',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    kind: 'json',
    file: () => path.join(homeDir(), '.cursor', 'mcp.json'),
  },
  {
    id: 'vscode',
    label: 'VS Code',
    kind: 'json',
    file: vscodeConfigPath,
    jsonPath: ['servers'],
    note: '命令面板运行 MCP: List Servers 可查看',
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    kind: 'json',
    file: () => path.join(homeDir(), '.codeium', 'windsurf', 'mcp_config.json'),
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    kind: 'json',
    file: opencodeConfigPath,
    jsonPath: ['mcp'],
    entry: { type: 'local', command: [COMMAND, ...ARGS], enabled: true },
  },
  {
    id: 'codebuddy',
    label: 'CodeBuddy Code',
    kind: 'json',
    file: codebuddyConfigPath,
    entry: { type: 'stdio', ...DEFAULT_ENTRY },
    note: '认第一个存在的配置文件，都没建过就建 ~/.codebuddy/.mcp.json',
  },
  {
    id: 'pi',
    label: 'Pi Agent',
    kind: 'json',
    file: piConfigPath,
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    kind: 'toml',
    file: () => path.join(homeDir(), '.codex', 'config.toml'),
  },
];

/** 目标所在目录是否存在 —— 用来判断"这个产品装过没有" */
async function parentExists(file) {
  try {
    const stat = await fs.stat(path.dirname(file));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/** server 表在 JSON 里的路径(没配 jsonPath 的目标走 Claude 系的 mcpServers) */
function jsonKeysOf(target) {
  return target.jsonPath || ['mcpServers'];
}

/** 顺着 jsonPath 下沉到 server 表本身;中间任何一层不是对象就回 null */
function walkToServerMap(root, keys) {
  let node = root;
  for (const key of keys) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    node = node[key];
  }
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  return node;
}

/** 配置里当前是否已经登记了 zen-gitsync(只为判断"装过没有") */
function currentServerConfig(raw, target) {
  if (!raw) return null;
  if (target.kind === 'toml') {
    const re = new RegExp(`^\\[\\[?mcp_servers\\.[^\\]]*${SERVER_ID}[^\\]]*\\]\\]?\\s*$`, 'm');
    return re.test(raw) ? { command: COMMAND } : null;
  }
  try {
    return walkToServerMap(JSON.parse(raw), jsonKeysOf(target))?.[SERVER_ID] || null;
  } catch {
    return null;
  }
}

/**
 * 列出所有目标及其状态。
 * @returns {Promise<Array<{ id, label, kind, file, exists, parent_exists, installed }>>}
 */
export async function listTargets() {
  const out = [];
  for (const target of TARGETS) {
    const file = target.file();
    if (!file) {
      out.push({ id: target.id, label: target.label, kind: target.kind, file: null, exists: false, parent_exists: false, installed: false });
      continue;
    }
    const exists = await fileExists(file);
    const raw = exists ? await fs.readFile(file, 'utf8').catch(() => '') : '';
    out.push({
      id: target.id,
      label: target.label,
      kind: target.kind,
      file,
      exists,
      parent_exists: await parentExists(file),
      installed: !!currentServerConfig(raw, target),
    });
  }
  return out;
}

/** 写入前备份一次。失败不影响主流程(备份是保险,不是前置条件)。 */
async function backup(file) {
  try {
    await fs.copyFile(file, `${file}.bak`);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
}

/** JSON 型:合并式写入,保留原有内容 */
async function installJson(file, target, { force }) {
  const exists = await fileExists(file);
  const raw = exists ? await fs.readFile(file, 'utf8').catch(() => '') : '';
  let parsed = null;
  if (raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 文件内容坏了 —— 不擅自覆盖用户的东西,除非他显式 --force。
      // (CodeBuddy 的配置允许 JSONC 注释,那种文件也会走到这里:宁可跳过并告知,
      //  也不要写坏。)
      if (!force) return { ok: false, error: `配置文件不是合法 JSON,已跳过(要覆盖请加 --force): ${file}` };
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};

  const keys = jsonKeysOf(target);
  // 逐级下沉:中间层不存在就建对象;已存在但不是对象 → 宁可跳过也不覆盖用户数据。
  let node = parsed;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (node[key] === undefined || node[key] === null) node[key] = {};
    if (typeof node[key] !== 'object' || Array.isArray(node[key])) {
      return { ok: false, error: `配置文件的 ${keys.slice(0, i + 1).join('.')} 不是对象,已跳过: ${file}` };
    }
    node = node[key];
  }
  const mapKey = keys[keys.length - 1];
  if (node[mapKey] === undefined || node[mapKey] === null) node[mapKey] = {};
  if (typeof node[mapKey] !== 'object' || Array.isArray(node[mapKey])) {
    return { ok: false, error: `配置文件的 ${keys.join('.')} 不是对象,已跳过: ${file}` };
  }

  const before = JSON.stringify(node[mapKey][SERVER_ID] || null);
  node[mapKey][SERVER_ID] = target.entry || DEFAULT_ENTRY;
  const after = JSON.stringify(node[mapKey][SERVER_ID]);
  const changed = before !== after;

  if (changed && exists) await backup(file);
  await ensureDir(file);
  await fs.writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return { ok: true, changed, backup: changed && exists };
}

/**
 * TOML 型(Codex):替换已有的 [mcp_servers.zen-gitsync] 段,没有就追加到末尾。
 *
 * 为什么不引 TOML 库:这里只需要"定位一个段 / 在末尾追加一个段",而引一整个解析器
 * 会为了几行文本把依赖表变长。段头识别按行首 `[`(TOML 的 `[[a.b]]` 也是合法段头,
 * 一并认下)。
 */
function tomlBlock() {
  return `[mcp_servers.${SERVER_ID}]\ncommand = "${COMMAND}"\nargs = [${ARGS.map(a => `"${a}"`).join(', ')}]\n`;
}

function isTomlSectionStart(line) {
  return typeof line === 'string' && /^\s*\[\[?[^\]]+\]\]?\s*$/.test(line);
}

async function installToml(file) {
  const exists = await fileExists(file);
  const raw = exists ? await fs.readFile(file, 'utf8').catch(() => '') : '';
  const block = tomlBlock();

  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex(l => isTomlSectionStart(l) && l.includes(`mcp_servers.${SERVER_ID}`));
  if (start >= 0) {
    let next = start + 1;
    while (next < lines.length && !isTomlSectionStart(lines[next])) next += 1;
    const merged = [...lines.slice(0, start), ...block.trimEnd().split('\n'), ...lines.slice(next)];
    // ⚠️ 幂等比较必须拿**归一化之后**的文本比:merged 丢掉了行尾那个空串,
    // 直接和 raw 比会永远差一个换行 → 每次重装都报 changed、都重写 + 备份。
    const nextText = `${merged.join('\n').replace(/\s*$/, '')}\n`;
    const changed = nextText !== raw;
    if (changed && exists) await backup(file);
    await ensureDir(file);
    await fs.writeFile(file, nextText, 'utf8');
    return { ok: true, changed, backup: changed && exists };
  }

  if (exists) await backup(file);
  await ensureDir(file);
  const prefix = raw.trim() ? `${raw.replace(/\s*$/, '')}\n\n` : '';
  await fs.writeFile(file, `${prefix}${block}`, 'utf8');
  return { ok: true, changed: true, backup: exists };
}

/** 从 JSON 配置里移除 zen-gitsync 这一段(顺着 jsonPath 下沉后再删) */
async function uninstallJson(file, target) {
  const raw = await fs.readFile(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `配置文件不是合法 JSON,不敢动: ${file}` };
  }
  const map = walkToServerMap(parsed, jsonKeysOf(target));
  if (!map || !(SERVER_ID in map)) {
    return { ok: true, id: target.id, file, skipped: true, reason: '本来就没登记' };
  }
  delete map[SERVER_ID];
  await backup(file);
  await fs.writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return { ok: true, id: target.id, file, changed: true, backup: true };
}

/**
 * 把一个目标登记上。
 * @returns {Promise<{ ok: boolean, id?: string, file?: string, changed?: boolean,
 *                     backup?: boolean, skipped?: boolean, reason?: string, error?: string }>}
 */
export async function install(targetId, { force = false } = {}) {
  const target = TARGETS.find(t => t.id === targetId);
  if (!target) return { ok: false, error: `未知目标 "${targetId}"。可用: ${TARGETS.map(t => t.id).join(', ')}` };
  const file = target.file();
  if (!file) return { ok: false, id: target.id, error: '当前平台不适用' };

  // 目标产品的目录都不存在 = 多半没装过。除非 --force,否则不凭空造配置。
  if (!(await parentExists(file)) && !force) {
    return { ok: true, id: target.id, file, skipped: true, reason: `没检测到 ${target.label}(目录不存在)。确认装过的话加 --force。` };
  }

  try {
    const result = target.kind === 'toml' ? await installToml(file) : await installJson(file, target, { force });
    return { ...result, id: target.id, file };
  } catch (err) {
    return { ok: false, id: target.id, file, error: err?.message || String(err) };
  }
}

/** 从配置里移除 zen-gitsync 这一段 */
export async function uninstall(targetId) {
  const target = TARGETS.find(t => t.id === targetId);
  if (!target) return { ok: false, error: `未知目标 "${targetId}"` };
  const file = target.file();
  if (!file || !(await fileExists(file))) return { ok: true, id: target.id, file, skipped: true, reason: '配置文件不存在,无需移除' };

  try {
    if (target.kind === 'toml') {
      const raw = await fs.readFile(file, 'utf8');
      const lines = raw.split(/\r?\n/);
      const start = lines.findIndex(l => isTomlSectionStart(l) && l.includes(`mcp_servers.${SERVER_ID}`));
      if (start < 0) return { ok: true, id: target.id, file, skipped: true, reason: '本来就没有这一段' };
      let next = start + 1;
      while (next < lines.length && !isTomlSectionStart(lines[next])) next += 1;
      const merged = [...lines.slice(0, start), ...lines.slice(next)];
      await backup(file);
      await fs.writeFile(file, `${merged.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '')}\n`, 'utf8');
      return { ok: true, id: target.id, file, changed: true, backup: true };
    }
    return await uninstallJson(file, target);
  } catch (err) {
    return { ok: false, id: target.id, file, error: err?.message || String(err) };
  }
}

// ── 命令行 ─────────────────────────────────────────────────────

const HELP = [
  'g mcp install —— 把 zen-gitsync 登记成别的 Agent 的 MCP 服务',
  '',
  '用法:',
  '  g mcp install                 登记到自家全局(g ai 立刻可用)',
  '  g mcp install --list          列出所有检测到的目标与状态',
  '  g mcp install claude          只登记到指定的目标',
  '  g mcp install --all           登记到所有目标(未检测到的会跳过)',
  '  g mcp install --remove claude 移除',
  '',
  '可选: --force(目标目录不存在也写 / 覆盖损坏的 JSON)',
  '',
  '可用目标:',
].join('\n');

/**
 * CLI 入口。往 stdout 打印人类可读的结果(这个子命令不是 stdio 协议模式)。
 * @param {string[]} argv - `install` 之后的参数
 */
export async function runMcpInstall(argv = []) {
  const has = flag => argv.includes(flag);
  const positional = argv.filter(a => !a.startsWith('--'));

  if (has('--help') || has('-h')) {
    console.log(HELP);
    for (const t of TARGETS) console.log(`  ${t.id.padEnd(10)} ${t.label}`);
    return;
  }

  if (has('--list')) {
    const targets = await listTargets();
    console.log('MCP 接入目标:');
    for (const t of targets) {
      const state = t.installed ? '已登记' : (t.exists ? '未登记' : (t.parent_exists ? '未创建' : '未检测到'));
      console.log(`  ${String(t.id).padEnd(10)} ${String(t.label).padEnd(24)} [${state}]  ${t.file || '—'}`);
    }
    console.log(`\n登记时写入: { "command": "${COMMAND}", "args": ${JSON.stringify(ARGS)} }`);
    return;
  }

  const force = has('--force');
  const remove = has('--remove');

  let ids;
  if (has('--all')) {
    ids = (await listTargets()).filter(t => t.file).map(t => t.id);
  } else if (positional.length > 0) {
    ids = positional;
  } else {
    ids = ['zen'];
  }

  for (const id of ids) {
    const result = remove ? await uninstall(id) : await install(id, { force });
    const label = (TARGETS.find(t => t.id === id) || {}).label || id;
    if (!result.ok) {
      console.log(`✗ ${label}: ${result.error}`);
      continue;
    }
    if (result.skipped) {
      console.log(`- ${label}: 跳过 —— ${result.reason}`);
      continue;
    }
    const verb = remove ? '已移除' : (result.changed ? '已登记' : '已存在(无需改动)');
    const suffix = result.backup ? '(已备份 .bak)' : '';
    console.log(`✓ ${label}: ${verb} ${suffix}\n    ${result.file}`);
    if (!remove) console.log(`    写入: { "command": "${COMMAND}", "args": ${JSON.stringify(ARGS)} }`);
  }
}

export default { runMcpInstall, install, uninstall, listTargets, TARGETS, SERVER_ID };

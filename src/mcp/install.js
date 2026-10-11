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
// Cursor 又是另一个 json)。让用户自己手抄路径是最容易出错的一步 —— 写错位置的表现
// 是"配了但没生效",而错误日志往往指向别处。
//
// 三条设计约束:
//   1. **只加不覆盖**:合并式写入,保留文件里原有的 server 与其它配置项。
//      写之前先备份(.bak),出事能退回去。
//   2. **不猜未安装的产品**:目标文件所在目录都不存在就说明没装过,标记为"未检测到"
//      并跳过(除非显式 --force)。免得凭空造出一堆没人用的配置文件。
//   3. **幂等**:已经登记过且命令一致 → 报告"已存在",不重复写。
//
// ⚠️ 这个入口是**普通命令行**,往 stdout 打印正常文本。这与 `g mcp`(stdio)不同 ——
// 那条路 stdout 是协议通道,一句多余输出就会让客户端解析失败。两者靠 argv[3] 分流。
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { AI_MCP_FILE } from '../paths.js';
import { fileExists } from './util.js';

/** 服务 id:写进各产品配置的键名 */
export const SERVER_ID = 'zen-gitsync';
/** 启动命令。用 `g` 而不是绝对路径 —— 用户在 PATH 里装的就是它 */
const COMMAND = 'g';
const ARGS = ['mcp'];

/** 平台相关的配置文件位置。返回 null 表示该平台不支持这个目标。 */
function claudeConfigPath() {
  if (process.platform === 'win32') {
    return process.env.APPDATA ? path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json') : null;
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

/**
 * 已知目标。
 * kind: 'json' = 顶层有 mcpServers 对象(与 Claude / Cursor / Windsurf / 自家同形);
 *       'toml' = Codex 的 TOML,用 [mcp_servers.<id>] 段。
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
    id: 'cursor',
    label: 'Cursor',
    kind: 'json',
    file: () => path.join(os.homedir(), '.cursor', 'mcp.json'),
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    kind: 'json',
    file: () => path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    kind: 'toml',
    file: () => path.join(os.homedir(), '.codex', 'config.toml'),
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

/** 配置里当前是否已经登记了 zen-gitsync(只为判断"装过没有") */
function currentServerConfig(raw, target) {
  if (!raw) return null;
  if (target.kind === 'toml') {
    const re = new RegExp(`^\\[\\[?mcp_servers\\.[^\\]]*${SERVER_ID}[^\\]]*\\]\\]?\\s*$`, 'm');
    return re.test(raw) ? { command: COMMAND } : null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed?.mcpServers?.[SERVER_ID] || null;
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
async function installJson(file, { force }) {
  const exists = await fileExists(file);
  const raw = exists ? await fs.readFile(file, 'utf8').catch(() => '') : '';
  let parsed = null;
  if (raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 文件内容坏了 —— 不擅自覆盖用户的东西,除非他显式 --force
      if (!force) return { ok: false, error: `配置文件不是合法 JSON,已跳过(要覆盖请加 --force): ${file}` };
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
  if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') parsed.mcpServers = {};

  const before = JSON.stringify(parsed.mcpServers[SERVER_ID] || null);
  parsed.mcpServers[SERVER_ID] = { command: COMMAND, args: ARGS };
  const after = JSON.stringify(parsed.mcpServers[SERVER_ID]);
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
    const changed = merged.join('\n') !== raw;
    if (changed && exists) await backup(file);
    await ensureDir(file);
    await fs.writeFile(file, `${merged.join('\n').replace(/\s*$/, '')}\n`, 'utf8');
    return { ok: true, changed, backup: changed && exists };
  }

  if (exists) await backup(file);
  await ensureDir(file);
  const prefix = raw.trim() ? `${raw.replace(/\s*$/, '')}\n\n` : '';
  await fs.writeFile(file, `${prefix}${block}`, 'utf8');
  return { ok: true, changed: true, backup: exists };
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
    const result = target.kind === 'toml' ? await installToml(file) : await installJson(file, { force });
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
    const raw = await fs.readFile(file, 'utf8');
    if (target.kind === 'toml') {
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

    const parsed = JSON.parse(raw);
    if (!parsed?.mcpServers?.[SERVER_ID]) return { ok: true, id: target.id, file, skipped: true, reason: '本来就没登记' };
    delete parsed.mcpServers[SERVER_ID];
    await backup(file);
    await fs.writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    return { ok: true, id: target.id, file, changed: true, backup: true };
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

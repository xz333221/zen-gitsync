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
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { execSync } from 'child_process';

const configPath = path.join(os.homedir(), '.git-commit-tool.json');

// 默认配置
const defaultConfig = {
  defaultCommitMessage: "submit",
  descriptionTemplates: [],  // 添加描述模板数组
  scopeTemplates: [],
  messageTemplates: [],
  commandTemplates: [
    'echo "{{cmd}}"',
    'npm run dev',
    'npm run build',
    'git status',
    'git add .',
    'git commit -m "{{message}}" --no-verify',
    'git push',
  ],
  lockedFiles: [],  // 添加锁定文件数组
  customCommands: [],  // 添加自定义命令数组
  orchestrations: [],
  startupItems: [],  // 添加项目启动项数组
  startupAutoRun: false,  // 添加启动项自动执行开关
  afterQuickPushAction: {
    enabled: false,
    type: 'command',
    refId: ''
  },
  currentDirectory: '',
  // 提交设置
  isStandardCommit: true,
  skipHooks: false,
  autoQuickPushOnEnter: false,
  autoSetDefaultMessage: false,
  autoClosePushModal: false,
  pullBeforePush: true,
  // 通用设置
  theme: 'light',  // 主题: light | dark | auto
  locale: 'zh-CN',  // 语言: zh-CN | en-US
  // AI 模型配置
  models: [],
  // UI 状态（跨项目共享，存到顶层 ui 对象）
  // 之前散落在 localStorage，因随机端口启动而失效，迁到文件持久化
  ui: {
    layout: { leftRatio: 0.25, midRatio: 0.375, rightRatio: 0.375, topRatio: 0.5 },
    fileListViewMode: 'list',          // 'list' | 'tree'
    fileDiffSplitPercent: 35,          // 15-85
    commandConsole: {
      expanded: true,
      useTerminal: true,
      showTerminalSessions: true,
      splitPercent: 25,                // 15-85
    },
    editorAutoSave: false,
  }
};

// 规范化项目路径作为配置键
function normalizeProjectPath(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// 缓存当前项目的唯一键。git 根目录在一个进程生命周期内通常不变
// (用户极少在 CLI 运行中 cd 出去),缓存命中后省掉一次同步 git 子进程
// (Windows 上 ~30-100ms,是 CLI 冷启动最大的单点延迟来源)。
// invalidateCurrentProjectKey() 在 process.chdir / fs.js 的 /api/change_directory
// 之类"cwd 改变"的场景下被调用,保证缓存不变成 stale。
let _currentProjectKeyCache = null;
let _currentProjectKeyCwd = null;

function getCurrentProjectKey() {
  const cwd = process.cwd();
  // cwd 没变 + 已有缓存:直接返回
  if (_currentProjectKeyCache && _currentProjectKeyCwd === cwd) {
    return _currentProjectKeyCache;
  }
  let key = null;
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    if (gitRoot) key = normalizeProjectPath(gitRoot);
  } catch (_) {
    // 非 Git 项目或 git 不可用，降级到 CWD
  }
  if (!key) key = normalizeProjectPath(cwd);
  _currentProjectKeyCache = key;
  _currentProjectKeyCwd = cwd;
  return key;
}

/**
 * 主动让项目键缓存失效。fs.js /api/change_directory 等修改 process.cwd
 * 的代码必须在 chdir 之后调一次,否则下一次 loadConfig/saveConfig 还会
 * 命中旧 key,写到错误项目的配置容器里。
 */
function invalidateCurrentProjectKey() {
  _currentProjectKeyCache = null;
  _currentProjectKeyCwd = null;
}

// 监听 process.chdir:任何位置调 process.chdir(path) 都会触发,这里统一
// 让缓存失效,避免上游每个 chdir 调用方都记得手动 invalidate。
// 注意:这是 Node 原生事件,无需 import;事件名拼写固定为 'chdir'。
process.on('chdir', () => invalidateCurrentProjectKey());

// 从磁盘读取原始配置对象
//
// 缓存策略:单进程内 safeLoadRaw 的结果缓存,所有 loadConfig / saveConfig /
// saveRecentDirectory 等路径共享,避免每次都重新打开文件 + JSON.parse。
// 写盘( writeRawConfigFile )时主动失效缓存,保证下一次读看到最新值;
// 缓存不存在 / 已失效时走原 IO 路径。
//
// 注意:这是一个进程内 LRU-free 简单缓存,不感知外部进程对本文件的修改。
// GUI(独立进程)改完文件后,本进程的 cache 仍是旧值 — 这符合 CLI 工具的
// 现实使用模式(同一用户很少同时跑多个 CLI 写配置),保留旧行为(open +
// readFile)开销即可控。如果未来需要多进程一致性,再加 fs.watch 即可。
let _rawConfigCache = null; // { value, existed } | null(null = 失效/未缓存)

async function readRawConfigFile() {
  if (_rawConfigCache) {
    return _rawConfigCache.value;
  }
  const state = await safeLoadRaw();
  if (!state.ok) {
    throw state.error;
  }
  _rawConfigCache = { value: state.obj, existed: state.existed };
  return _rawConfigCache.value;
}

/**
 * 主动让 raw config 缓存失效。测试 / 跨进程场景可手动调。
 */
function invalidateRawConfigCache() {
  _rawConfigCache = null;
}

// 将原始配置对象写回磁盘
// 用 tmp + rename 原子写：避免拖拽高频触发 + 防抖期间 beforeunload 同时写入时
// 两次 fs.writeFile 直接覆盖产生的"先 truncate 再写"的中间态空文件,
// 触发 readRawConfigFile 在 race 时 JSON.parse 失败 → 500。
async function writeRawConfigFile(obj) {
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  const data = JSON.stringify(obj, null, 2);
  await fs.writeFile(tmpPath, data, 'utf-8');
  try {
    await fs.rename(tmpPath, configPath);
  } catch (err) {
    // Windows 上 rename 到已存在文件可能抛 EPERM/EEXIST,fallback 覆盖写
    try { await fs.unlink(tmpPath); } catch (_) {}
    await fs.writeFile(configPath, data, 'utf-8');
    if (err) throw err;
  }
  // 写盘成功后让缓存失效 — 下次 readRawConfigFile 走实盘,保证拿到最新值
  invalidateRawConfigCache();
}

async function backupConfigFileIfExists() {
  try {
    await fs.access(configPath);
  } catch (_) {
    return;
  }

  try {
    await fs.copyFile(configPath, `${configPath}.bak`);
  } catch (_) {
    // 备份失败不阻断主流程
  }
}

// 更安全的读取，区分“文件不存在”和“解析失败”
async function safeLoadRaw() {
  // 命中缓存直接返回,跳过 readFile + JSON.parse
  if (_rawConfigCache) {
    return { ok: true, obj: _rawConfigCache.value, existed: _rawConfigCache.existed };
  }
  try {
    const data = await fs.readFile(configPath, 'utf-8');
    const obj = JSON.parse(data);
    _rawConfigCache = { value: obj, existed: true };
    return { ok: true, obj, existed: true };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // 文件不存在：当作空对象，但可继续写入
      // 注意:这里也缓存 existed:false 的空对象,避免每次 lockFile/unlockFile
      // 等"未初始化"路径都重新走 fs.readFile(总抛 ENOENT)
      const empty = {};
      _rawConfigCache = { value: empty, existed: false };
      return { ok: true, obj: empty, existed: false };
    }
    // 其他错误（例如解析失败）：不写入，提示用户
    // 不缓存错误状态 — 修复后下次读还能成功
    return { ok: false, error: err };
  }
}

// 异步读取配置文件
async function loadConfig() {
  const key = getCurrentProjectKey();
  let raw = null;
  try {
    raw = await readRawConfigFile();
  } catch (err) {
    const msg = err?.message ? String(err.message) : String(err);
    throw new Error(`系统配置文件JSON格式错误，请修复后重试。\n文件: ${configPath}\n原因: ${msg}`);
  }
  // 兼容旧版（全局扁平结构）
  if (raw && !raw.projects) {
    return { ...defaultConfig, ...raw };
  }

  // 新版结构：{ projects: { [key]: projectConfig }, theme?, locale?, ui?, recentDirectories? }
  const projectConfig = raw?.projects?.[key];
  // 合并：默认配置 + 项目配置 + 全局通用设置（theme, locale, models, ui）
  // models / ui 是全局配置（跨项目共享），始终取顶层，不使用项目级的（防止旧数据覆盖）
  return {
    ...defaultConfig,
    ...(projectConfig || {}),
    theme: raw?.theme ?? defaultConfig.theme,
    locale: raw?.locale ?? defaultConfig.locale,
    models: raw?.models ?? defaultConfig.models,
    ui: raw?.ui ?? defaultConfig.ui
  };
}

// 配置写入失败的错误类型,让上层 catch 后能区分是参数错误还是 IO 错误
class ConfigWriteError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ConfigWriteError';
    if (cause) this.cause = cause;
  }
}

// 异步保存配置
// 契约变更(2026-06-26):之前在错误分支仅 console.warn + return undefined,
// 调用方按成功处理 → 用户看到 ✓ / 200 OK 但其实没写盘(MAINT-4)。
// 现在改为:参数非法 → 抛 ConfigWriteError;IO/解析失败 → 抛 ConfigWriteError(wrapped)。
// 成功路径仍然返回 undefined,保持与大多数 fs.writeFile 风格一致。
async function saveConfig(config) {
  if(!config || typeof config !== 'object' || Array.isArray(config)){
    throw new ConfigWriteError(`saveConfig: 入参必须是普通对象,实际收到 ${Array.isArray(config) ? 'array' : typeof config}`);
  }
  if (Object.keys(config).length === 0) {
    throw new ConfigWriteError('saveConfig: 配置对象为空,已取消写入以避免覆盖');
  }
  const key = getCurrentProjectKey();
  const state = await safeLoadRaw();
  if (!state.ok) {
    const cause = state.error;
    const detail = cause?.message ? String(cause.message) : String(cause);
    throw new ConfigWriteError(
      `解析配置文件失败,已取消写入以避免覆盖。\n文件: ${configPath}\n原因: ${detail}`,
      cause
    );
  }

  const raw = state.obj; // 保留现有顶层键

  // 确保 projects 容器存在
  if (!raw.projects || typeof raw.projects !== 'object') {
    raw.projects = {};
  }

  // 分离全局设置和项目设置
  // models / ui 也是全局配置（跨项目共享），和 theme/locale 一样存到顶层
  const { theme, locale, models, ui, ...projectConfig } = config;

  // 保存全局设置到根级别
  if (theme !== undefined) {
    raw.theme = theme;
  }
  if (locale !== undefined) {
    raw.locale = locale;
  }
  if (models !== undefined) {
    raw.models = models;
  }
  if (ui !== undefined) {
    raw.ui = ui;
  }

  // 写入当前项目配置（在 defaultConfig 基础上合并，但不清空顶层其它键）
  const existingProjectConfig = (raw.projects[key] && typeof raw.projects[key] === 'object') ? raw.projects[key] : {};
  raw.projects[key] = { ...defaultConfig, ...existingProjectConfig, ...projectConfig };
  await backupConfigFileIfExists();
  await writeRawConfigFile(raw);
  // writeRawConfigFile 内部已 invalidateRawConfigCache,这里不再重复
}
// 文件锁定管理函数
async function lockFile(filePath) {
  const config = await loadConfig();
  const normalizedPath = path.normalize(filePath);

  if (!config.lockedFiles.includes(normalizedPath)) {
    config.lockedFiles.push(normalizedPath);
    try {
      await saveConfig(config);
    } catch (err) {
      // 写入失败时回滚内存变更,避免"以为锁了实际没锁"
      const idx = config.lockedFiles.lastIndexOf(normalizedPath);
      if (idx > -1) config.lockedFiles.splice(idx, 1);
      console.error(chalk.red(`❌ 锁定失败: "${normalizedPath}"`));
      console.error(chalk.gray(err.message));
      throw err;
    }
    console.log(chalk.green(`✓ 文件已锁定: "${normalizedPath}"`));
    return true;
  } else {
    console.log(chalk.yellow(`⚠️ 文件已经被锁定: "${normalizedPath}"`));
    return false;
  }
}

async function unlockFile(filePath) {
  const config = await loadConfig();
  const normalizedPath = path.normalize(filePath);
  const index = config.lockedFiles.indexOf(normalizedPath);

  if (index > -1) {
    config.lockedFiles.splice(index, 1);
    try {
      await saveConfig(config);
    } catch (err) {
      // 写入失败时回滚(把刚 splice 掉的项加回去)
      config.lockedFiles.splice(index, 0, normalizedPath);
      console.error(chalk.red(`❌ 解锁失败: "${normalizedPath}"`));
      console.error(chalk.gray(err.message));
      throw err;
    }
    console.log(chalk.green(`✓ 文件已解锁: "${normalizedPath}"`));
    return true;
  } else {
    console.log(chalk.yellow(`⚠️ 文件未被锁定: "${normalizedPath}"`));
    return false;
  }
}

async function isFileLocked(filePath) {
  const config = await loadConfig();
  const normalizedPath = path.normalize(filePath);
  return config.lockedFiles.includes(normalizedPath);
}

async function listLockedFiles() {
  const config = await loadConfig();
  if (config.lockedFiles.length === 0) {
    console.log(chalk.blue('📝 当前没有锁定的文件'));
  } else {
    console.log(chalk.blue('🔒 已锁定的文件:'));
    config.lockedFiles.forEach((file, index) => {
      console.log(chalk.gray(`  ${index + 1}. ${file}`));
    });
  }
  return config.lockedFiles;
}

async function getLockedFiles() {
  const config = await loadConfig();
  return config.lockedFiles || [];
}

// 全局“最近访问的目录”管理（保存在原始配置的顶层）
const MAX_RECENT_DIRS = 12;

async function getRecentDirectories() {
  const raw = await readRawConfigFile();
  const list = raw?.recentDirectories;
  return Array.isArray(list) ? list : [];
}

async function saveRecentDirectory(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return;
  const state = await safeLoadRaw();
  if (!state.ok) {
    const cause = state.error;
    const detail = cause?.message ? String(cause.message) : String(cause);
    throw new ConfigWriteError(
      `解析配置文件失败,已取消写入最近目录以避免覆盖。\n文件: ${configPath}\n原因: ${detail}`,
      cause
    );
  }
  const raw = state.obj; // 保留现有顶层键
  let list = Array.isArray(raw.recentDirectories) ? raw.recentDirectories.slice() : [];

  // 规范化:Windows 下统一为小写,去掉重复,保持最新在前
  // 修复(MAINT-5):unshift 用原始大小写,Windows 下 C:\Project 与 C:\PROJECT
  // 会产生两条"看起来一样"的项;现在 unshift 前先 normalize,dup 检测自然合并。
  // 注意:存的字符串是 normalized 形式,在 Windows 下显示为小写路径,
  // 这是有意为之 — 用 OS 标准大小写形式消除歧义,GUI 层可选择单独保留原始形式。
  const normalized = normalizeProjectPath(dirPath);
  list = list.filter(p => normalizeProjectPath(p) !== normalized);
  list.unshift(normalized);
  if (list.length > MAX_RECENT_DIRS) list = list.slice(0, MAX_RECENT_DIRS);

  raw.recentDirectories = list;
  await writeRawConfigFile(raw);
  return list;
}

async function removeRecentDirectory(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return;
  const state = await safeLoadRaw();
  if (!state.ok) return [];
  const raw = state.obj;
  let list = Array.isArray(raw.recentDirectories) ? raw.recentDirectories.slice() : [];
  const normalized = normalizeProjectPath(dirPath);
  list = list.filter(p => normalizeProjectPath(p) !== normalized);
  raw.recentDirectories = list;
  await writeRawConfigFile(raw);
  return list;
}

// 添加配置管理函数
async function handleConfigCommands() {
  if (process.argv.includes('get-config')) {
    const currentConfig = await loadConfig();
    console.log('Current configuration:');
    console.log(currentConfig);
    process.exit();
  }

  const setMsgArg = process.argv.find(arg => arg.startsWith('--set-default-message='));
  if (setMsgArg) {
    const newMessage = setMsgArg.split('=')[1];
    const currentConfig = await loadConfig();
    currentConfig.defaultCommitMessage = newMessage;
    try {
      await saveConfig(currentConfig);
    } catch (err) {
      console.error(chalk.red('❌ 默认提交信息写入失败'));
      console.error(chalk.gray(err.message));
      process.exit(1);
    }
    console.log(chalk.green(`✓ 默认提交信息已设置为: "${newMessage}"`));
    process.exit();
  }
}
export default {
  loadConfig,
  saveConfig,
  handleConfigCommands,
  lockFile,
  unlockFile,
  isFileLocked,
  listLockedFiles,
  getLockedFiles,
  getRecentDirectories,
  saveRecentDirectory,
  removeRecentDirectory,
  readRawConfigFile,
  writeRawConfigFile
};

// 命名导出 — 用于测试与外部复用
export { ConfigWriteError, normalizeProjectPath, invalidateCurrentProjectKey, invalidateRawConfigCache };

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

// 获取当前项目的唯一键（优先使用 Git 根目录）
function getCurrentProjectKey() {
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    if (gitRoot) return normalizeProjectPath(gitRoot);
  } catch (_) {
    // 非 Git 项目或 git 不可用，降级到 CWD
  }
  return normalizeProjectPath(process.cwd());
}

// 从磁盘读取原始配置对象
async function readRawConfigFile() {
  const state = await safeLoadRaw();
  if (!state.ok) {
    throw state.error;
  }
  return state.obj;
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
  try {
    const data = await fs.readFile(configPath, 'utf-8');
    return { ok: true, obj: JSON.parse(data), existed: true };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // 文件不存在：当作空对象，但可继续写入
      return { ok: true, obj: {}, existed: false };
    }
    // 其他错误（例如解析失败）：不写入，提示用户
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

// 异步保存配置
async function saveConfig(config) {
  if(!config || typeof config !== 'object' || Array.isArray(config)){
    console.warn(chalk.yellow('⚠️ 配置文件为空，已取消写入以避免覆盖。')); 
    console.warn(chalk.gray(`文件: ${configPath}`));
    return;
  }
  if (Object.keys(config).length === 0) {
    console.warn(chalk.yellow('⚠️ 配置文件为空，已取消写入以避免覆盖。')); 
    console.warn(chalk.gray(`文件: ${configPath}`));
    return;
  }
  const key = getCurrentProjectKey();
  const state = await safeLoadRaw();
  if (!state.ok) {
    console.warn(chalk.yellow('⚠️ 解析配置文件失败，已取消写入以避免覆盖。')); 
    console.warn(chalk.gray(`文件: ${configPath}`));
    return;
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
}
// 文件锁定管理函数
async function lockFile(filePath) {
  const config = await loadConfig();
  const normalizedPath = path.normalize(filePath);

  if (!config.lockedFiles.includes(normalizedPath)) {
    config.lockedFiles.push(normalizedPath);
    await saveConfig(config);
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
    await saveConfig(config);
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
    console.warn(chalk.yellow('⚠️ 解析配置文件失败，已取消写入最近目录以避免覆盖。'));
    console.warn(chalk.gray(`文件: ${configPath}`));
    return [];
  }
  const raw = state.obj; // 保留现有顶层键
  let list = Array.isArray(raw.recentDirectories) ? raw.recentDirectories.slice() : [];

  // 规范化：Windows 下统一为小写，去掉重复，保持最新在前
  const normalized = normalizeProjectPath(dirPath);
  list = list.filter(p => normalizeProjectPath(p) !== normalized);
  list.unshift(dirPath);
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
    await saveConfig(currentConfig);
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

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
  lockedFiles: [],  // 添加锁定文件数组
  customCommands: [],  // 添加自定义命令数组
  startupItems: [],  // 添加项目启动项数组
  startupAutoRun: false  // 添加启动项自动执行开关
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
  try {
    const data = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(data);
  } catch (_) {
    return null;
  }
}

// 将原始配置对象写回磁盘
async function writeRawConfigFile(obj) {
  await fs.writeFile(configPath, JSON.stringify(obj, null, 2), 'utf-8');
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
  const raw = await readRawConfigFile();
  // 兼容旧版（全局扁平结构）
  if (raw && !raw.projects) {
    return { ...defaultConfig, ...raw };
  }

  // 新版结构：{ projects: { [key]: projectConfig }, global?: {...} }
  const projectConfig = raw?.projects?.[key];
  return { ...defaultConfig, ...(projectConfig || {}) };
}

// 异步保存配置
async function saveConfig(config) {
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

  // 写入当前项目配置（在 defaultConfig 基础上合并，但不清空顶层其它键）
  raw.projects[key] = { ...defaultConfig, ...config };
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
  saveRecentDirectory
};

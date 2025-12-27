import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { execGitCommand, getCommandHistory, addCommandToHistory, clearCommandHistory, registerSocketIO, execGitAddWithLockFilter } from '../../utils/index.js';
import open from 'open';
import config from '../../config.js';
import chalk from 'chalk';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import { Server } from 'socket.io';
import { spawn, exec } from 'child_process';
import iconv from 'iconv-lite';
import { createRequestLogger } from './middleware/requestLogger.js';
import { registerUiSocketHandlers } from './socket/registerUiSocketHandlers.js';
import { registerExecRoutes } from './routes/exec.js';
import { registerTerminalRoutes } from './routes/terminal.js';
import { registerProcessRoutes } from './routes/process.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerBranchStatusRoutes } from './routes/branchStatus.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerGitRoutes } from './routes/git.js';
import { registerFsRoutes } from './routes/fs.js';
import { registerNpmRoutes } from './routes/npm.js';
import { registerFileOpenRoutes } from './routes/fileOpen.js';
import { registerGitOpsRoutes } from './routes/gitOps.js';
import { createSavePortToFile } from './utils/createSavePortToFile.js';
import { startServerOnAvailablePort } from './utils/startServerOnAvailablePort.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const configManager = config; // 确保 configManager 可用
// 存储正在运行的进程（用于停止功能）
const runningProcesses = new Map(); // key: processId, value: { childProcess, command, startTime }
let processIdCounter = 0;

const terminalSessions = new Map(); // key: terminalSessionId, value: { id, command, workingDirectory, pid, createdAt, lastStartedAt }
let terminalSessionIdCounter = 0;

// 分支状态缓存
let branchStatusCache = {
  currentBranch: null,
  upstreamBranch: null,
  lastUpdate: 0,
  cacheTimeout: 5000 // 5秒缓存
};

// 当前分支缓存 - 只在特定情况下更新
let currentBranchCache = {
  branchName: null,
  lastUpdate: 0,
  // 分支名缓存时间更长，因为分支切换不频繁
  cacheTimeout: 300000 // 5分钟缓存，或者直到主动清除
};

// 上游分支缓存 - 只在特定情况下更新
let upstreamBranchCache = {
  upstreamBranch: null,
  lastUpdate: 0,
  // 上游分支缓存时间也较长，因为上游分支设置不频繁
  cacheTimeout: 300000 // 5分钟缓存，或者直到主动清除
};

// 推送状态标记 - 用于优化推送后的分支状态查询
let recentPushStatus = {
  justPushed: false,
  pushTime: 0,
  validDuration: 10000 // 推送后10秒内认为分支状态是同步的
};

const showConsole = true;
async function startUIServer(noOpen = false, savePort = false) {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer);
  if (showConsole) console.log(`创建服务成功`)
  
  // 获取当前项目的唯一标识（使用工作目录路径）
  // 需要在切换目录时更新，故使用 let
  let currentProjectPath = process.cwd();
  let projectRoomId = `project:${currentProjectPath.replace(/[\\/:\s]/g, '_')}`;
  
  console.log(chalk.blue(`项目房间ID: ${projectRoomId}`));
  console.log(chalk.blue(`项目路径: ${currentProjectPath}`));
  
  // 注册Socket.io实例，用于命令历史通知
  registerSocketIO(io);
  
  // 添加全局中间件来解析JSON请求体
  app.use(express.json());

  // 记录最近打开的目录（优先 Git 根目录，其次当前工作目录）
  try {
    let dirPath = process.cwd();
    try {
      if(showConsole) console.log(`记录最近打开目录`)
      const { stdout } = await execGitCommand('git rev-parse --show-toplevel');
      const root = stdout?.trim();
      if (root) dirPath = root;
    } catch (_) {
      // 非Git仓库或命令失败，使用 CWD 即可
    }
    if (showConsole) console.log(`记录最近打开目录: ${dirPath}`)
    await configManager.saveRecentDirectory(dirPath);
    if (showConsole) console.log(chalk.gray(`已记录最近打开目录: ${dirPath}`));
  } catch (e) {
    console.warn(chalk.yellow(`记录最近目录失败: ${e?.message || e}`));
  }
  
  // 添加请求日志中间件
  app.use(createRequestLogger({ chalk }));

  // 静态文件服务
  app.use(express.static(path.join(__dirname, '../public')));

  registerExecRoutes({
    app,
    execGitCommand,
    addCommandToHistory,
    getCurrentProjectPath: () => currentProjectPath,
    nextProcessId: () => processIdCounter++,
    runningProcesses
  });

  registerTerminalRoutes({
    app,
    getCurrentProjectPath: () => currentProjectPath,
    nextTerminalSessionId: () => terminalSessionIdCounter++,
    terminalSessions
  });

  registerProcessRoutes({
    app,
    runningProcesses,
  });

  // API路由
  // 移除了 /api/status 端点，因为前端只使用 porcelain 格式
  registerStatusRoutes({
    app,
    getCommandHistory,
    execGitCommand
  });
  
  registerBranchStatusRoutes({
    app,
    execGitCommand,
    getIsGitRepo: () => isGitRepo,
    getCurrentBranchCache: () => currentBranchCache,
    setCurrentBranchCache: (v) => { currentBranchCache = v; },
    getUpstreamBranchCache: () => upstreamBranchCache,
    setUpstreamBranchCache: (v) => { upstreamBranchCache = v; },
    getBranchStatusCache: () => branchStatusCache,
    setBranchStatusCache: (v) => { branchStatusCache = v; },
    getRecentPushStatus: () => recentPushStatus,
    setRecentPushStatus: (v) => { recentPushStatus = v; }
  });

  // 清除分支缓存的函数（在分支切换时调用）
  function clearBranchCache() {
    console.log('清除分支缓存');
    currentBranchCache = {
      branchName: null,
      lastUpdate: 0,
      cacheTimeout: 300000
    };
    // 清除上游分支缓存
    upstreamBranchCache = {
      upstreamBranch: null,
      lastUpdate: 0,
      cacheTimeout: 300000
    };
    // 同时清除分支状态缓存
    branchStatusCache = {
      currentBranch: null,
      upstreamBranch: null,
      lastUpdate: 0,
      cacheTimeout: 5000
    };
    // 清除推送状态标记
    recentPushStatus = {
      justPushed: false,
      pushTime: 0,
      validDuration: 10000
    };
  }

  registerGitRoutes({
    app,
    execGitCommand,
    clearBranchCache
  });

  registerFsRoutes({
    app,
    execGitCommand,
    configManager,
    io,
    getCurrentProjectPath: () => currentProjectPath,
    setCurrentProjectPath: (v) => { currentProjectPath = v; },
    getProjectRoomId: () => projectRoomId,
    setProjectRoomId: (v) => { projectRoomId = v; },
    setIsGitRepo: (v) => { isGitRepo = v; }
  });

  registerConfigRoutes({
    app,
    configManager
  });

  registerNpmRoutes({
    app,
    getCurrentProjectPath: () => currentProjectPath
  });

  registerFileOpenRoutes({
    app
  });

  registerGitOpsRoutes({
    app,
    execGitCommand,
    configManager,
    execGitAddWithLockFilter,
    addCommandToHistory,
    clearCommandHistory,
    getIsGitRepo: () => isGitRepo,
    setRecentPushStatus: (v) => { recentPushStatus = v; }
  });
  registerUiSocketHandlers({
    io,
    getProjectRoomId: () => projectRoomId,
    getCurrentProjectPath: () => currentProjectPath,
    getAndBroadcastStatus,
    getCommandHistory,
    clearCommandHistory,
    addCommandToHistory,
    runningProcesses,
    nextProcessId: () => ++processIdCounter,
    spawn,
    exec,
    path,
    iconv
  });
  
  // 获取并广播Git状态 (优化版本 - 只获取porcelain格式)
  async function getAndBroadcastStatus() {
    try {
      // 如果不是Git仓库，发送特殊状态
      if (!isGitRepo) {
        io.to(projectRoomId).emit('git_status_update', {
          isGitRepo: false,
          porcelain: '',
          timestamp: new Date().toISOString(),
          projectPath: currentProjectPath
        });
        return;
      }

      // 只获取porcelain格式状态，不再获取完整的git status
      const { stdout: porcelainOutput } = await execGitCommand('git status --porcelain --untracked-files=all');

      // 广播到当前项目房间的所有客户端
      io.to(projectRoomId).emit('git_status_update', {
        isGitRepo: true,
        porcelain: porcelainOutput,
        timestamp: new Date().toISOString(),
        projectPath: currentProjectPath
      });

      console.log(`已广播Git状态更新到房间: ${projectRoomId}`);
    } catch (error) {
      console.error('获取或广播Git状态失败:', error);
    }
  }
  
  // 检查当前目录是否是Git仓库
  let isGitRepo = false;
  try {
    const { stdout } = await execGitCommand('git rev-parse --is-inside-work-tree', { log: false });
    isGitRepo = stdout.trim() === 'true';
  } catch (error) {
    isGitRepo = false;
    console.log(chalk.yellow('======================================'));
    console.log(chalk.yellow(`  提示: 当前目录不是Git仓库`));
    console.log(chalk.yellow(`  目录: ${process.cwd()}`));
    console.log(chalk.yellow('======================================'));
  }
  
  // 启动服务器
  const PORT = 3000;
  
  // 创建一个函数来保存端口号到文件和环境变量
  // 使用闭包保存端口状态，防止多次写入相同端口
  const savePortToFile = createSavePortToFile({ savePort, fs, path });
  // 使用变量标记回调是否已执行，防止多次触发
  const callbackExecutedRef = { value: false };
  
  // 尝试在可用端口上启动服务器
  await startServerOnAvailablePort({
    httpServer,
    startPort: PORT,
    chalk,
    open,
    noOpen,
    isGitRepo,
    savePortToFile,
    maxTries: 100,
    callbackExecutedRef
  });

 }

 export default startUIServer;

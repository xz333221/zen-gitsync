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
import express from 'express';
import logger from './utils/logger.js'
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { execGitCommand, getCommandHistory, addCommandToHistory, clearCommandHistory, registerSocketIO, execGitAddWithLockFilter, checkAndClearGitLock } from '../../utils/index.js';
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
import { registerWorkbenchRoutes } from './routes/workbench.js';
import { registerGitOpsRoutes } from './routes/gitOps.js';
import { registerCodeRoutes } from './routes/code.js';
import { registerCodeAnalysisRoutes } from './routes/codeAnalysis.js';
import { registerInstancesRoutes } from './routes/instances.js';
import { registerMonitorRoutes } from './routes/monitor.js';
import { registerMindmapRoutes } from './routes/mindmap.js';
import { createInstanceRegistry } from './utils/instanceRegistry.js';
import { createSavePortToFile } from './utils/createSavePortToFile.js';
import { startServerOnAvailablePort } from './utils/startServerOnAvailablePort.js';
import { resolveStartPort } from './utils/randomStartPort.js';
import { createFilePickerMiddleware } from 'local-file-picker';
import { createAiModelMiddleware } from 'ai-model-form';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const configManager = config; // 确保 configManager 可用
// 存储正在运行的进程（用于停止功能）
const runningProcesses = new Map(); // key: processId, value: { childProcess, command, startTime }
let processIdCounter = 0;

const terminalSessions = new Map(); // key: terminalSessionId, value: { id, command, workingDirectory, pid, createdAt, lastStartedAt }
let terminalSessionIdCounter = 0;

/**
 * 终止并等待单个子进程退出
 * @param {import('child_process').ChildProcess} child
 * @param {number} timeoutMs 等待 SIGTERM 生效的最大时间,超时后发 SIGKILL
 * @returns {Promise<void>}
 */
function killChildProcess(child, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (!child || (child.exitCode !== null && child.exitCode !== undefined)) {
      return resolve();
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.removeListener('exit', finish);
      resolve();
    };
    child.once('exit', finish);
    try {
      // SIGTERM 优雅退出,被 Node 在 Windows 上转 TerminateProcess
      child.kill('SIGTERM');
    } catch (_) {
      finish();
      return;
    }
    // 超时未退就 SIGKILL 强杀
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      // 给 SIGKILL 200ms 兜底,再不退也不等了
      setTimeout(finish, 200);
    }, timeoutMs);
  });
}

/**
 * 并行终止 runningProcesses 内所有子进程,总等待时间不超过 timeoutMs。
 * 防止 SIGINT/SIGTERM 关闭 server 时,正在跑的 claude/npm/git 子进程变孤儿。
 *
 * 注意:返回值是"尝试终止的进程数",不等于"已实际退出数"。内部用
 * Promise.race 卡总时长,timeoutMs 到了就返回,此时可能仍有子进程
 * 处于 SIGTERM → exit 的过渡中(尤其 Windows 上 TerminateProcess 是
 * 异步的)。调用方日志应使用"已尝试终止"措辞,避免排查孤儿进程时被误导。
 *
 * @param {number} timeoutMs
 * @returns {Promise<number>} 被尝试终止的进程数(entries.length)
 */
async function drainRunningProcesses(timeoutMs = 5000) {
  const entries = Array.from(runningProcesses.entries());
  if (entries.length === 0) return 0;
  // 先并行发 SIGTERM,再并行等;整批用 Promise.race 卡最大时长
  const killPromises = entries.map(([, info]) => killChildProcess(info.childProcess, timeoutMs).catch(() => {}));
  await Promise.race([
    Promise.all(killPromises),
    new Promise((r) => setTimeout(r, timeoutMs))
  ]);
  return entries.length;
}

// 全局错误处理 — 幂等,只允许进入 fatalExit 一次
let _fatalExitInProgress = false;

/**
 * 注册 process.on('uncaughtException') / unhandledRejection 处理器
 *
 * 触发时的清理链路(防止留下孤儿子进程 / 假死 registry / 端口文件残留):
 *   1) drainRunningProcesses(3s) — 并行 SIGTERM 杀掉所有 claude/npm/git 子进程
 *   2) instanceRegistry.unregister — 把自己从实例表里摘掉
 *   3) setTimeout 250ms 退 — 给 logger/console 一点时间把日志刷盘
 *
 * @param {Object} opts
 * @param {ReturnType<typeof createInstanceRegistry>} opts.instanceRegistry
 */
function setupGlobalErrorHandlers({ instanceRegistry }) {
  // 幂等:多个错误同时触发时只走一次清理,避免清理动作自身再次触发 fatalExit
  const fatalExit = async (reason, err) => {
    if (_fatalExitInProgress) return;
    _fatalExitInProgress = true;
    try {
      logger.error(`[FATAL] ${reason}: ${err?.message || err}`);
      if (err?.stack) logger.error(err.stack);
    } catch (_) { /* logger 自身炸了,放弃 */ }
    // 1) 杀光所有子进程
    try {
      const killed = await drainRunningProcesses(3000);
      if (killed > 0) logger.warn(`[FATAL] 已尝试终止 ${killed} 个运行中的子进程`);
    } catch (_) {}
    // 2) 反注册实例
    if (instanceRegistry) {
      try { await instanceRegistry.unregister(process.pid); } catch (_) {}
    }
    // 3) 给 OS 250ms 刷盘日志,然后非 0 退出
    setTimeout(() => process.exit(1), 250);
  };

  process.on('uncaughtException', (err, origin) => {
    // 同步处理路径:直接调 fatalExit,内部 await 会进入 microtask
    fatalExit(`uncaughtException (${origin || 'uncaught'})`, err);
  });
  process.on('unhandledRejection', (reason) => {
    fatalExit('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
  });
}

// 分支状态缓存
let branchStatusCache = {
  currentBranch: null,
  upstreamBranch: null,
  lastUpdate: 0,
  cacheTimeout: 5000 // 5秒缓存
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Socket.IO CORS / origin 收紧
  //
  // 默认 Socket.IO 接受任意 origin,跨域页面也能连上 → CSRF / 跨站攻击面
  // 暴露给恶意页面。这里只允许同源 + 127.0.0.1 / localhost。
  // 用环境变量 ZEN_ALLOWED_ORIGINS 可以追加自定义来源(逗号分隔),
  // CI / 远程调试场景用。
  // ─────────────────────────────────────────────────────────────────────────────
  const DEFAULT_ALLOWED_ORIGINS = [
    'http://localhost',
    'https://localhost',
    'http://127.0.0.1',
    'https://127.0.0.1',
    'http://[::1]',
    'null', // 同源 file:// 等场景
  ];
  const extraOrigins = String(process.env.ZEN_ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const allowedOrigins = new Set([...DEFAULT_ALLOWED_ORIGINS, ...extraOrigins]);

  function isOriginAllowed(origin) {
    if (!origin) return true; // 同源 / 非浏览器客户端不传 Origin
    if (allowedOrigins.has(origin)) return true;
    // 允许 localhost/127.0.0.1/[::1] 上的任意端口(开发常换端口)
    try {
      const u = new URL(origin);
      if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return true;
    } catch { /* ignore */ }
    return false;
  }

  const io = new Server(httpServer, {
    cors: {
      origin: (origin, cb) => {
        if (isOriginAllowed(origin)) return cb(null, true);
        logger.warn(`[Socket.IO] 拒绝跨域 origin: ${origin}`);
        return cb(new Error('Origin not allowed'), false);
      },
      methods: ['GET', 'POST'],
      credentials: false,
    },
  });
  if (showConsole) logger.info(`创建服务成功`)
  
  // 获取当前项目的唯一标识（使用工作目录路径）
  // 需要在切换目录时更新，故使用 let
  let currentProjectPath = process.cwd();
  let projectRoomId = `project:${currentProjectPath.replace(/[\\/:\s]/g, '_')}`;
  
  console.log(chalk.blue(`项目房间ID: ${projectRoomId}`));
  console.log(chalk.blue(`项目路径: ${currentProjectPath}`));
  
  // 注册Socket.io实例，用于命令历史通知
  registerSocketIO(io);

  // 构建实例注册表（用于跨进程共享"当前运行中的 GUI"信息）
  // 注册表文件位于用户主目录，所有 g ui 进程共享写入
  const instanceRegistry = createInstanceRegistry({
    fs,
    path,
    os,
    registryPath: path.join(os.homedir(), '.zen-gitsync-instances.json')
  });

  // 注册全局错误处理器:任意未捕获异常/拒绝都会触发 fatalExit,
  // 走 drainRunningProcesses + unregister + 延迟 250ms 退出的链路。
  // 在 instanceRegistry 创建之后立即注册,这样后续 route 注册阶段抛出
  // 也能被同一个处理器捕获(否则会无声崩,留下子进程孤儿与 .port 残留)。
  setupGlobalErrorHandlers({ instanceRegistry });

  // 添加全局中间件来解析JSON请求体
  app.use(express.json());

  // 记录最近打开的目录（优先 Git 根目录，其次当前工作目录）
  try {
    let dirPath = process.cwd();
    try {
      if(showConsole) logger.info(`记录最近打开目录`)
      const { stdout } = await execGitCommand(['rev-parse', '--show-toplevel']);
      const root = stdout?.trim();
      if (root) dirPath = root;
    } catch (_) {
      // 非Git仓库或命令失败，使用 CWD 即可
    }
    if (showConsole) logger.info(`记录最近打开目录: ${dirPath}`)
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
    // 用 pre-increment 从 1 起,避免首进程拿到 id=0（0 在 `if (processId)` 这类真值检查里会被吞）
    nextProcessId: () => ++processIdCounter,
    runningProcesses
  });

  registerCodeRoutes({
    app
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
    getBranchStatusCache: () => branchStatusCache,
    setBranchStatusCache: (v) => { branchStatusCache = v; },
    getRecentPushStatus: () => recentPushStatus,
    setRecentPushStatus: (v) => { recentPushStatus = v; }
  });

  // 清除分支缓存的函数（在分支切换时调用）
  function clearBranchCache() {
    logger.info('清除分支缓存');
    // 清除5秒分支状态缓存
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
    setCurrentProjectPath: (v) => {
      currentProjectPath = v;
      // project 切换后清掉 _lastBroadcastedPorcelain 缓存,
      // 否则两个 project 都是 clean 时(porcelain 都是 '')会误判
      // 内容未变 → 漏推新 projectPath
      _lastBroadcastedPorcelain = null;
    },
    getProjectRoomId: () => projectRoomId,
    setProjectRoomId: (v) => { projectRoomId = v; },
    setIsGitRepo: (v) => { isGitRepo = v; }
  });

  registerConfigRoutes({
    app,
    configManager,
    execGitCommand,
    getCurrentProjectPath: () => currentProjectPath
  });

  registerNpmRoutes({
    app,
    getCurrentProjectPath: () => currentProjectPath
  });

  registerFileOpenRoutes({
    app
  });

  registerWorkbenchRoutes({
    app,
    getCurrentProjectPath: () => currentProjectPath,
    getProjectRoomId: () => projectRoomId,
    io,
    configManager
  });

  // local-file-picker 中间件，提供 /api/fs/* 文件浏览路由
  app.use('/api', createFilePickerMiddleware());

  // ai-model-form 中间件：提供 /api/ai-model/* 路由（模型列表/测试/暂存保存）
  app.use('/api', createAiModelMiddleware());

  registerCodeAnalysisRoutes({ app, configManager, getCurrentProjectPath: () => currentProjectPath });

  // 实例注册表 API：列出当前所有运行中的 GUI
  registerInstancesRoutes({
    app,
    registry: instanceRegistry,
    getCurrentInstanceId: () => process.pid
  });

  registerGitOpsRoutes({
    app,
    execGitCommand,
    configManager,
    execGitAddWithLockFilter,
    addCommandToHistory,
    clearCommandHistory,
    checkAndClearGitLock,
    getIsGitRepo: () => isGitRepo,
    setRecentPushStatus: (v) => { recentPushStatus = v; }
  });

  // 系统监控：CPU / 内存 / 端口占用 + kill 进程
  registerMonitorRoutes({ app });

  // 思维导图：.mindmap.json 文件的列/读/写/建/删/重命名
  registerMindmapRoutes({ app });
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
  // 去重:50ms 内的多次调用合并为一次 git status + 一次广播。
  // 触发场景:页面刷新风暴(打开 GUI 后浏览器自动重连 3-5 次),
  //           或前端多 tab 同时连接。N 个客户端连进来 = N 次 git status 子进程,
  //           每次 ~30-80ms,合并后只跑 1 次。
  let _statusBroadcastPending = false;
  let _lastBroadcastedPorcelain = null;
  async function getAndBroadcastStatus() {
    if (_statusBroadcastPending) return;
    _statusBroadcastPending = true;
    // 用 setImmediate 让同一 tick 内的多次调用合并(更短的等待)
    setImmediate(async () => {
      _statusBroadcastPending = false;
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
        const { stdout: porcelainOutput } = await execGitCommand(['status', '--porcelain', '--untracked-files=all']);

        // 内容未变就不广播 — 防止每次前端 reconnect 都推一份完全一样的字符串
        // 跨项目切换时 isGitRepo/projectPath 会变,这里只按内容去重
        if (porcelainOutput === _lastBroadcastedPorcelain) {
          return;
        }
        _lastBroadcastedPorcelain = porcelainOutput;

        // 广播到当前项目房间的所有客户端
        io.to(projectRoomId).emit('git_status_update', {
          isGitRepo: true,
          porcelain: porcelainOutput,
          timestamp: new Date().toISOString(),
          projectPath: currentProjectPath
        });

        logger.info(`已广播Git状态更新到房间: ${projectRoomId}`);
      } catch (error) {
        logger.error('获取或广播Git状态失败:', error);
      }
    });
  }
  
  // 检查当前目录是否是Git仓库
  let isGitRepo = false;
  try {
    const { stdout } = await execGitCommand(['rev-parse', '--is-inside-work-tree'], { log: false });
    isGitRepo = stdout.trim() === 'true';
  } catch (error) {
    isGitRepo = false;
    console.log(chalk.yellow('======================================'));
    console.log(chalk.yellow(`  提示: 当前目录不是Git仓库`));
    console.log(chalk.yellow(`  目录: ${process.cwd()}`));
    console.log(chalk.yellow('======================================'));
  }
  
  // 启动服务器
  // 端口策略：默认从 [4000, 6000) 随机挑起点，再顺序扫描 EADDRINUSE；
  // 可通过 PORT 环境变量强制使用固定端口（向后兼容 + 便于书签/调试）
  const portStrategy = resolveStartPort();
  if (portStrategy.source === 'env') {
    console.log(chalk.cyan(`[端口] 使用环境变量 PORT=${portStrategy.startPort}`));
  } else {
    console.log(chalk.cyan(`[端口] 随机起点 ${portStrategy.startPort}（范围 ${portStrategy.min}-${portStrategy.max}，遇到占用会顺延）`));
  }

  // 创建一个函数来保存端口号到文件和环境变量
  // 使用闭包保存端口状态，防止多次写入相同端口
  const savePortToFile = createSavePortToFile({ savePort, fs, path });
  // 使用变量标记回调是否已执行，防止多次触发
  const callbackExecutedRef = { value: false };

  // 用 'listening' 事件做注册触发：startServerOnAvailablePort 的 await
  // 在端口重试场景下不一定按时返回，但 'listening' 事件只在服务器真正绑定端口时触发
  let registerDone = false;
  httpServer.once('listening', () => {
    if (registerDone) return;
    registerDone = true;
    registerCurrentInstance().catch((e) => {
      console.warn(chalk.yellow(`[instanceRegistry] 启动注册流程失败: ${e?.message || e}`));
    });
  });

  // 尝试在可用端口上启动服务器（不等待；listen 事件会驱动后续逻辑）
  startServerOnAvailablePort({
    httpServer,
    startPort: portStrategy.startPort,
    chalk,
    open,
    noOpen,
    isGitRepo,
    savePortToFile,
    fsSync,
    maxTries: 100,
    callbackExecutedRef
  }).catch((e) => {
    logger.error('启动服务器失败:', e);
  });

  // 把所有注册/心跳/watch 逻辑封装到独立函数，由 listening 事件触发
  async function registerCurrentInstance() {
    const addr = httpServer.address();
    const currentPort = addr && addr.port;
    if (!currentPort) {
      console.warn(chalk.yellow('[instanceRegistry] 无法获取当前端口，跳过注册'));
      return;
    }

    try {
      const projectName = await instanceRegistry._resolveProjectName(currentProjectPath);
      await instanceRegistry.register({
        pid: process.pid,
        port: currentPort,
        projectPath: currentProjectPath,
        projectName,
        hostname: os.hostname()
      });
      console.log(chalk.green(`[instanceRegistry] 已注册 pid=${process.pid} port=${currentPort} name=${projectName}`));
    } catch (e) {
      console.warn(chalk.yellow(`[instanceRegistry] 注册失败: ${e?.message || e}`));
      return;
    }

    // 5 秒心跳
    const heartbeatTimer = setInterval(() => {
      instanceRegistry.heartbeat(process.pid, { projectPath: currentProjectPath })
        .catch((e) => console.warn(chalk.yellow(`[instanceRegistry] 心跳失败: ${e?.message || e}`)));
    }, 5000);

    // 监听注册表文件变化：任何进程写入都会触发，向本进程的所有客户端广播
    // fs.watch 在 Windows 上偶有不可靠，Socket.IO 推送 + 前端轮询（15s）兜底
    const stopWatcher = instanceRegistry.watch(async (fresh) => {
      try {
        io.emit('instances_changed', { instances: fresh });
      } catch (e) {
        console.warn(chalk.yellow(`[instanceRegistry] 广播失败: ${e?.message || e}`));
      }
    }, fsSync.watch);

    // 优雅退出：SIGINT/SIGTERM 触发 drain 子进程 + unregister + 清心跳
    // 幂等保护：连按 Ctrl+C 或 SIGINT+SIGTERM 同来时只走一次清理，
    // 避免重复 drain(3s)、重复 unregister、排多个 setTimeout(exit)。
    // 与上方 _fatalExitInProgress 同思路，但作用域在本次 startUIServer 调用内。
    let _shuttingDown = false;
    const shutdown = async (signal) => {
      if (_shuttingDown) return;
      _shuttingDown = true;
      console.log(chalk.gray(`[shutdown] 收到 ${signal}，开始清理…`));
      // 1) 先并行 SIGTERM 所有正在跑的子进程(限时 3s),防止 claude/npm/git 变孤儿。
      //    注意:返回值是"尝试终止数"而非"实际终止数" — drain 内部用
      //    Promise.race 卡总时长,3s 到了就返回,可能仍有进程在 SIGTERM 退出中。
      try {
        const killed = await drainRunningProcesses(3000);
        if (killed > 0) console.log(chalk.gray(`[shutdown] 已尝试终止 ${killed} 个子进程(实际终止情况以 exit 事件为准)`));
      } catch (_) {}
      // 2) 清心跳 + 反注册实例
      try { clearInterval(heartbeatTimer); } catch (_) {}
      try { await instanceRegistry.unregister(process.pid); } catch (_) {}
      console.log(chalk.gray(`[shutdown] 收到 ${signal}，已清理本实例`));
      // 3) 给 OS 100ms 刷盘日志
      setTimeout(() => process.exit(0), 100);
    };
    process.on('SIGINT', () => { shutdown('SIGINT'); });
    process.on('SIGTERM', () => { shutdown('SIGTERM'); });
    // 'exit' 是同步钩子，无法 await：仅关闭 watcher；kill -9 走心跳超时
    process.on('exit', () => {
      try { stopWatcher && stopWatcher(); } catch (_) {}
    });
  }

 }

 export default startUIServer;

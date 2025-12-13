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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const configManager = config; // 确保 configManager 可用
// 存储正在运行的进程（用于停止功能）
const runningProcesses = new Map(); // key: processId, value: { childProcess, command, startTime }
let processIdCounter = 0;

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
  app.use((req, res, next) => {
    const startTime = Date.now();
    const requestTime = new Date().toLocaleString('zh-CN', { hour12: false });
    
    // 监听响应完成事件
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      const statusCode = res.statusCode;
      
      // 根据状态码选择颜色
      let statusColor = chalk.green;
      if (statusCode >= 400 && statusCode < 500) {
        statusColor = chalk.yellow;
      } else if (statusCode >= 500) {
        statusColor = chalk.red;
      }
      
      // 根据请求耗时选择颜色
      let durationColor = chalk.gray;
      if (duration > 1000) {
        durationColor = chalk.red;
      } else if (duration > 500) {
        durationColor = chalk.yellow;
      } else if (duration > 200) {
        durationColor = chalk.cyan;
      }
      
      console.log(
        chalk.dim(`[${requestTime}]`),
        chalk.bold(req.method),
        req.url,
        statusColor(`[${statusCode}]`),
        durationColor(`${duration}ms`)
      );
    });
    
    next();
  });

  // 静态文件服务
  app.use(express.static(path.join(__dirname, '../public')));

  // 通用命令执行接口（非流式）
  app.post('/api/exec', async (req, res) => {
    try {
      const { command } = req.body || {};
      if (!command || typeof command !== 'string' || !command.trim()) {
        return res.status(400).json({ success: false, error: 'command 不能为空' });
      }

      try {
        const { stdout = '', stderr = '' } = await execGitCommand(command, { log: false });
        return res.json({ success: true, stdout, stderr });
      } catch (err) {
        return res.status(400).json({ success: false, error: err?.message || String(err) });
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // 流式执行命令接口（支持实时输出）
  app.post('/api/exec-stream', async (req, res) => {
    try {
      const { command, directory } = req.body || {};
      if (!command || typeof command !== 'string' || !command.trim()) {
        return res.status(400).json({ success: false, error: 'command 不能为空' });
      }

      // 确定执行目录
      const execDirectory = directory && directory.trim() 
        ? (path.isAbsolute(directory) ? directory : path.join(currentProjectPath, directory))
        : currentProjectPath;

      console.log(`流式执行命令: ${command}`);
      console.log(`执行目录: ${execDirectory}`);

      // 分配进程 ID
      const processId = ++processIdCounter;

      // 设置响应头为流式传输
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // 禁用nginx缓冲

      // 记录执行开始时间（用于命令历史）
      const startTime = Date.now();

      // 用于收集输出（用于命令历史）
      let collectedStdout = '';
      let collectedStderr = '';
      
      // 使用 shell: true 来支持 Windows 内置命令（如 dir、cd 等）
      const childProcess = spawn(command.trim(), [], {
        cwd: execDirectory,
        shell: true, // 通过 shell 执行，支持 Windows 内置命令
        env: {
          ...process.env,
          // Git 配置：启用颜色输出和禁用路径引用
          GIT_CONFIG_PARAMETERS: "'color.ui=always' 'color.status=always' 'core.quotepath=false'",
          // 强制启用颜色输出 - 多种工具的配置
          FORCE_COLOR: '3', // 使用级别3（最强），支持 chalk 等库
          NPM_CONFIG_COLOR: 'always',
          TERM: 'xterm-256color', // 模拟256色终端环境
          COLORTERM: 'truecolor', // 支持真彩色
          CLICOLOR_FORCE: '1', // 强制启用颜色（某些工具检测此变量）
          // 确保输出不被缓冲
          PYTHONUNBUFFERED: '1'
          // 注意：不设置 CI=true 和 NO_COLOR，避免禁用颜色输出
        }
      });

      // 存储进程信息
      runningProcesses.set(processId, {
        childProcess,
        command: command.trim(),
        startTime,
        directory: execDirectory
      });
      console.log(`[进程管理] 创建进程 #${processId}: ${command.substring(0, 50)}`);

      // 发送数据到客户端的辅助函数
      const sendData = (type, data) => {
        const message = `data: ${JSON.stringify({ type, data })}\n\n`;
        // console.log(`[流式输出] 发送数据 - 类型: ${type}, 长度: ${data?.length || 0}`);
        res.write(message);
      };

      // 立即发送 processId 给前端
      sendData('process_id', processId);

      let outputReceived = false;

      // 判断是否需要 GBK 转换
      // 只有 Windows CMD 内置命令（如 dir、type 等）才需要 GBK 转换
      // npm、node、git 等现代工具都输出 UTF-8
      const isWindows = process.platform === 'win32';
      const cmdBuiltins = ['dir', 'type', 'echo', 'set', 'path', 'cd', 'md', 'rd', 'del', 'copy', 'move', 'ren'];
      const needsGbkConversion = isWindows && cmdBuiltins.some(builtin => 
        command.trim().toLowerCase().startsWith(builtin + ' ') || 
        command.trim().toLowerCase() === builtin
      );
      
      console.log(`[流式输出] 命令: ${command.substring(0, 50)}, 需要GBK转换: ${needsGbkConversion}`);

      // 监听标准输出
      childProcess.stdout?.on('data', (data) => {
        // data 是 Buffer 对象
        let output;
        if (needsGbkConversion) {
          // Windows CMD 内置命令，从 GBK 转换为 UTF-8
          output = iconv.decode(data, 'gbk');
          console.log(`[流式输出] 收到stdout(GBK转UTF8):`, output.substring(0, 200));
        } else {
          // 现代工具或 Unix 系统，直接使用 UTF-8
          output = data.toString('utf8');
          console.log(`[流式输出] 收到stdout(UTF8):`, output.substring(0, 200));
        }
        outputReceived = true;
        collectedStdout += output; // 收集输出用于历史记录
        sendData('stdout', output);
      });

      // 监听标准错误输出
      childProcess.stderr?.on('data', (data) => {
        // data 是 Buffer 对象
        let output;
        
        if (isWindows) {
          // Windows 平台需要智能检测编码
          // 先尝试 UTF-8 解码
          const utf8Output = data.toString('utf8');
          
          // 检测是否包含 UTF-8 替换字符（�），这通常表示解码失败
          // 如果没有替换字符且包含正常字符，说明是有效的 UTF-8
          if (!utf8Output.includes('�') || utf8Output.match(/[\u4e00-\u9fa5]/)) {
            // UTF-8 解码成功（包含有效中文或没有替换字符）
            output = utf8Output;
            console.log(`[流式输出] 收到stderr(UTF8):`, output.substring(0, 200));
          } else {
            // UTF-8 解码失败，尝试 GBK（可能是 CMD shell 的系统消息）
            try {
              output = iconv.decode(data, 'gbk');
              console.log(`[流式输出] 收到stderr(GBK转UTF8):`, output.substring(0, 200));
            } catch (e) {
              // GBK 也失败，使用原始 UTF-8 结果
              output = utf8Output;
              console.log(`[流式输出] GBK解码失败，使用UTF8:`, output.substring(0, 200));
            }
          }
        } else {
          // Unix系统，直接使用 UTF-8
          output = data.toString('utf8');
          console.log(`[流式输出] 收到stderr(UTF8):`, output.substring(0, 200));
        }
        
        outputReceived = true;
        collectedStderr += output; // 收集错误输出用于历史记录
        // 不再自动标记为错误，只显示 stderr 输出
        // Git 的警告信息会输出到 stderr 但退出码仍为 0
        sendData('stderr', output);
      });

      // 监听进程退出（exit 在流关闭前触发）
      childProcess.on('exit', (code, signal) => {
        // console.log(`[流式输出] 进程 exit 事件 - 代码: ${code}, 信号: ${signal}`);
      });

      // 监听进程关闭（close 在流关闭后触发）
      childProcess.on('close', (code, signal) => {
        // console.log(`[流式输出] 进程 close 事件 - 代码: ${code}, 信号: ${signal}, 有输出: ${outputReceived}`);
        
        // 从运行进程列表中移除
        runningProcesses.delete(processId);
        console.log(`[进程管理] 进程 #${processId} 已结束，剩余进程数: ${runningProcesses.size}`);
        
        // 计算执行时间
        const executionTime = Date.now() - startTime;
        
        // 添加到命令历史
        const error = code !== 0 ? `Command exited with code ${code}` : null;
        addCommandToHistory(
          command.trim(),
          collectedStdout,
          collectedStderr,
          error,
          executionTime
        );
        
        // 只根据退出码判断成功与否，退出码为 0 表示成功
        sendData('exit', { code, success: code === 0 });
        res.end();
      });

      // 监听错误
      childProcess.on('error', (error) => {
        // console.error(`[流式输出] 进程错误:`, error);
        
        // 从运行进程列表中移除
        runningProcesses.delete(processId);
        console.log(`[进程管理] 进程 #${processId} 出错并结束，剩余进程数: ${runningProcesses.size}`);
        
        // 添加到命令历史（错误情况）
        const executionTime = Date.now() - startTime;
        addCommandToHistory(
          command.trim(),
          collectedStdout,
          collectedStderr,
          error.message,
          executionTime
        );
        
        sendData('error', error.message);
        res.end();
      });
      
      // 添加spawn事件监听
      childProcess.on('spawn', () => {
        // console.log(`[流式输出] 进程已启动 - PID: ${childProcess.pid}`);
      });

      // 注意：不监听req.on('close')，参考git push的实现
      // 进程会自然结束，close事件会触发res.end()
      // 如果监听req.on('close')可能会导致进程被提前kill

    } catch (error) {
      console.error('流式执行命令失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `流式执行命令失败: ${error.message}` 
      });
    }
  });
  
  // 在新终端中执行自定义命令
  app.post('/api/exec-in-terminal', async (req, res) => {
    try {
      const { command, workingDirectory } = req.body || {};
      if (!command || typeof command !== 'string' || !command.trim()) {
        return res.status(400).json({ success: false, error: 'command 不能为空' });
      }

      // 使用传入的工作目录，如果没有则使用当前项目路径
      const targetDir = workingDirectory || currentProjectPath;
      console.log(`在终端中执行命令: ${command}`);
      console.log(`工作目录: ${targetDir}`);
      
      // 根据操作系统选择合适的终端命令
      let terminalCommand;
      
      if (process.platform === 'win32') {
        // Windows: 使用 start 命令打开新的 cmd 窗口
        // /K 参数表示执行命令后保持窗口打开
        terminalCommand = `start cmd /K "cd /d ${targetDir} && ${command}"`;
      } else if (process.platform === 'darwin') {
        // macOS: 使用 osascript 打开 Terminal.app
        const script = `tell application "Terminal" to do script "cd ${targetDir} && ${command}"`;
        terminalCommand = `osascript -e '${script}'`;
      } else {
        // Linux: 尝试常见的终端模拟器
        terminalCommand = `gnome-terminal -- bash -c "cd ${targetDir} && ${command}; exec bash" || xterm -e "cd ${targetDir} && ${command}; bash"`;
      }
      
      // 执行命令打开新终端（使用已导入的 exec）
      exec(terminalCommand, (error, stdout, stderr) => {
        if (error) {
          console.error('打开终端失败:', error);
        }
      });
      
      res.json({ 
        success: true, 
        message: `已在新终端中执行命令`,
        command: command,
        path: currentProjectPath
      });
    } catch (error) {
      console.error('在终端中执行命令失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `在终端中执行命令失败: ${error.message}` 
      });
    }
  });

  // 停止正在运行的进程
  app.post('/api/kill-process', async (req, res) => {
    try {
      const { processId } = req.body || {};
      if (!processId || typeof processId !== 'number') {
        return res.status(400).json({ success: false, error: 'processId 必须是数字' });
      }

      const processInfo = runningProcesses.get(processId);
      if (!processInfo) {
        return res.status(404).json({ 
          success: false, 
          error: `进程 #${processId} 不存在或已结束` 
        });
      }

      console.log(`[进程管理] 尝试停止进程 #${processId}: ${processInfo.command}`);

      try {
        // 在 Windows 上需要使用 taskkill 来杀死整个进程树
        if (process.platform === 'win32') {
          // 使用已导入的 exec
          // /F 强制终止, /T 终止进程树
          exec(`taskkill /pid ${processInfo.childProcess.pid} /T /F`, (error) => {
            if (error) {
              console.error(`[进程管理] taskkill 失败:`, error);
            }
          });
        } else {
          // Unix/Linux/Mac 使用 SIGTERM
          processInfo.childProcess.kill('SIGTERM');
          
          // 如果 2 秒后还没结束，使用 SIGKILL 强制终止
          setTimeout(() => {
            if (runningProcesses.has(processId)) {
              console.log(`[进程管理] 进程 #${processId} 未响应 SIGTERM，使用 SIGKILL 强制终止`);
              processInfo.childProcess.kill('SIGKILL');
            }
          }, 2000);
        }

        res.json({ 
          success: true, 
          message: `已发送停止信号到进程 #${processId}`,
          processId,
          command: processInfo.command
        });
      } catch (killError) {
        console.error(`[进程管理] 停止进程失败:`, killError);
        res.status(500).json({ 
          success: false, 
          error: `停止进程失败: ${killError.message}` 
        });
      }
    } catch (error) {
      console.error('停止进程接口失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `停止进程失败: ${error.message}` 
      });
    }
  });
  
  // API路由
  // 移除了 /api/status 端点，因为前端只使用 porcelain 格式
  
  // Add new endpoint for command history
  app.get('/api/command-history', async (req, res) => {
    try {
      const history = getCommandHistory();
      res.json({ success: true, history });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  app.get('/api/status_porcelain', async (req, res) => {
    try {
      const { stdout } = await execGitCommand('git status --porcelain --untracked-files=all');
      res.json({ status: stdout });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  
  // 获取当前分支的优化函数
  async function getCurrentBranchOptimized(forceRefresh = false) {
    const now = Date.now();

    // 如果不是强制刷新且缓存有效，使用缓存
    if (!forceRefresh &&
        currentBranchCache.branchName &&
        (now - currentBranchCache.lastUpdate) < currentBranchCache.cacheTimeout) {
      console.log(`使用缓存的分支名: ${currentBranchCache.branchName}`);
      return currentBranchCache.branchName;
    }

    // 缓存失效或强制刷新，重新获取
    // console.log('重新获取当前分支名...');
    const { stdout } = await execGitCommand('git symbolic-ref --short HEAD');
    const branchName = stdout.trim();

    // 更新缓存
    currentBranchCache = {
      branchName,
      lastUpdate: now,
      cacheTimeout: 300000 // 5分钟缓存
    };

    return branchName;
  }

  // 获取上游分支的优化函数
  async function getUpstreamBranchOptimized(forceRefresh = false) {
    const now = Date.now();

    // 如果不是强制刷新且缓存有效，使用缓存
    if (!forceRefresh &&
        upstreamBranchCache.upstreamBranch !== null &&
        (now - upstreamBranchCache.lastUpdate) < upstreamBranchCache.cacheTimeout) {
      console.log(`使用缓存的上游分支: ${upstreamBranchCache.upstreamBranch}`);
      return upstreamBranchCache.upstreamBranch;
    }

    // 缓存失效或强制刷新，重新获取
    console.log('重新获取上游分支...');
    const { stdout: upstreamOutput } = await execGitCommand('git rev-parse --abbrev-ref --symbolic-full-name @{u}', { ignoreError: true });
    const upstreamBranch = upstreamOutput.trim() || null;

    // 更新缓存
    upstreamBranchCache = {
      upstreamBranch,
      lastUpdate: now,
      cacheTimeout: 300000 // 5分钟缓存
    };

    return upstreamBranch;
  }

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

  // 获取当前分支 - 使用缓存优化
  app.get('/api/branch', async (req, res) => {
    try {
      const forceRefresh = req.query.force === 'true';
      const branch = await getCurrentBranchOptimized(forceRefresh);
      res.json({ branch });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 获取分支与远程的差异状态（领先/落后提交数）- 优化版本
  app.get('/api/branch-status', async (req, res) => {
    try {
      // 检查当前目录是否是Git仓库
      if (!isGitRepo) {
        return res.json({ hasUpstream: false, ahead: 0, behind: 0 });
      }

      const now = Date.now();
      const forceRefresh = req.query.force === 'true';
      const refreshCountOnly = req.query.countOnly === 'true'; // 新增：只刷新计数

      // 检查是否刚刚推送过，如果是则直接返回同步状态
      if (recentPushStatus.justPushed &&
          (now - recentPushStatus.pushTime) < recentPushStatus.validDuration) {
        console.log('检测到最近推送过，直接返回同步状态');
        return res.json({
          hasUpstream: true,
          upstreamBranch: branchStatusCache.upstreamBranch || 'origin/main',
          ahead: 0,
          behind: 0
        });
      }

      // 检查分支信息缓存是否有效
      const branchInfoCacheValid = branchStatusCache.currentBranch &&
                                   branchStatusCache.upstreamBranch &&
                                   (now - branchStatusCache.lastUpdate) < branchStatusCache.cacheTimeout;

      // 如果只需要刷新计数，或者缓存有效且不是强制刷新
      if ((refreshCountOnly && branchInfoCacheValid) || (!forceRefresh && branchInfoCacheValid)) {

        // 使用缓存的分支信息，只重新计算领先/落后状态
        const { stdout: aheadBehindOutput } = await execGitCommand(
          `git rev-list --left-right --count ${branchStatusCache.currentBranch}...${branchStatusCache.upstreamBranch}`
        );
        const [ahead, behind] = aheadBehindOutput.trim().split('\t').map(Number);

        console.log(`使用缓存的分支信息: ${branchStatusCache.currentBranch} -> ${branchStatusCache.upstreamBranch} (${refreshCountOnly ? '只刷新计数' : '缓存有效'})`);

        return res.json({
          hasUpstream: true,
          upstreamBranch: branchStatusCache.upstreamBranch,
          ahead,
          behind
        });
      }

      // 缓存失效或强制刷新，重新获取分支信息
      // console.log('重新获取分支信息...');

      // 分支名缓存和分支状态缓存独立工作
      // 只有在分支状态强制刷新且分支名缓存也失效时，才强制刷新分支名
      const shouldForceRefreshBranch = forceRefresh &&
        (!currentBranchCache.branchName ||
         (Date.now() - currentBranchCache.lastUpdate) >= currentBranchCache.cacheTimeout);

      const currentBranch = await getCurrentBranchOptimized(shouldForceRefreshBranch);

      // 使用优化后的上游分支获取函数
      // 只有在分支状态强制刷新且上游分支缓存也失效时，才强制刷新上游分支
      const shouldForceRefreshUpstream = forceRefresh &&
        (upstreamBranchCache.upstreamBranch === null ||
         (Date.now() - upstreamBranchCache.lastUpdate) >= upstreamBranchCache.cacheTimeout);

      const upstreamBranch = await getUpstreamBranchOptimized(shouldForceRefreshUpstream);

      if (!upstreamBranch) {
        // 没有上游分支，清空缓存
        branchStatusCache = {
          currentBranch: null,
          upstreamBranch: null,
          lastUpdate: 0,
          cacheTimeout: 5000
        };
        return res.json({ hasUpstream: false, ahead: 0, behind: 0 });
      }

      // 更新缓存
      branchStatusCache = {
        currentBranch,
        upstreamBranch,
        lastUpdate: now,
        cacheTimeout: 5000
      };

      // 获取领先/落后提交数
      const { stdout: aheadBehindOutput } = await execGitCommand(`git rev-list --left-right --count ${currentBranch}...${upstreamBranch}`);
      const [ahead, behind] = aheadBehindOutput.trim().split('\t').map(Number);

      res.json({
        hasUpstream: true,
        upstreamBranch,
        ahead,
        behind
      });
    } catch (error) {
      console.error('获取分支状态失败:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // 获取所有分支
  app.get('/api/branches', async (req, res) => {
    try {
      // 获取本地分支 - 使用简单的git branch命令
      const { stdout: localBranches } = await execGitCommand('git branch');
      
      // 获取远程分支
      const { stdout: remoteBranches } = await execGitCommand('git branch -r');
      
      // 处理本地分支 - 正确解析git branch的标准输出格式
      const localBranchList = localBranches.split('\n')
        .filter(Boolean)
        .map(b => b.trim())
        .map(b => b.startsWith('* ') ? b.substring(2) : b); // 移除星号并保留分支名
      
      // 处理远程分支，保留完整的远程分支名称
      const remoteBranchList = remoteBranches.split('\n')
        .filter(Boolean)
        .map(b => b.trim())
        .filter(b => b !== 'origin' && !b.includes('HEAD')); // 过滤掉单纯的origin和HEAD引用
      
      // 合并分支列表
      const allBranches = [
        ...localBranchList,
        ...remoteBranchList
      ];
      
      res.json({ branches: allBranches });
    } catch (error) {
      console.error('获取分支列表失败:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // 创建新分支
  app.post('/api/create-branch', express.json(), async (req, res) => {
    try {
      const { newBranchName, baseBranch } = req.body;
      
      if (!newBranchName) {
        return res.status(400).json({ success: false, error: '分支名称不能为空' });
      }
      
      // 构建创建分支的命令
      let command = `git branch ${newBranchName}`;
      
      // 如果指定了基础分支，则基于该分支创建
      if (baseBranch) {
        command = `git branch ${newBranchName} ${baseBranch}`;
      }
      
      // 执行创建分支命令
      await execGitCommand(command);
      
      // 切换到新创建的分支
      await execGitCommand(`git checkout ${newBranchName}`);

      // 清除分支缓存，因为分支已切换
      clearBranchCache();

      res.json({ success: true, branch: newBranchName });
    } catch (error) {
      console.error('创建分支失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 切换分支
  app.post('/api/checkout', async (req, res) => {
    try {
      const { branch } = req.body;
      if (!branch) {
        return res.status(400).json({ success: false, error: '分支名称不能为空' });
      }
      
      // 执行分支切换
      await execGitCommand(`git checkout ${branch}`);

      // 清除分支缓存，因为分支已切换
      clearBranchCache();

      res.json({ success: true });
    } catch (error) {
      console.error('切换分支失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // 合并分支
  app.post('/api/merge', async (req, res) => {
    try {
      const { branch, noCommit, noFf, squash, message } = req.body;
      
      if (!branch) {
        return res.status(400).json({ success: false, error: '分支名称不能为空' });
      }
      
      // 构建Git合并命令 - 直接使用传入的分支名（可能包含origin/前缀）
      let command = `git merge ${branch}`;
      
      // 添加可选参数
      if (noCommit) {
        command += ' --no-commit';
      }
      
      if (noFf) {
        command += ' --no-ff';
      }
      
      if (squash) {
        command += ' --squash';
      }
      
      if (message) {
        command += ` -m "${message}"`;
      }
      
      try {
        // 执行合并命令
        const { stdout } = await execGitCommand(command);
        
        res.json({ 
          success: true, 
          message: '分支合并成功',
          output: stdout 
        });
      } catch (error) {
        // 检查是否有合并冲突
        const errorMsg = error.message || '';
        const hasConflicts = errorMsg.includes('CONFLICT') || 
                            errorMsg.includes('Automatic merge failed');
        
        if (hasConflicts) {
          res.status(409).json({
            success: false,
            hasConflicts: true,
            error: '合并过程中发生冲突，需要手动解决',
            details: errorMsg
          });
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.error('合并分支失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `合并分支失败: ${error.message}` 
      });
    }
  });
  
  // 获取Git用户配置信息
  app.get('/api/user-info', async (req, res) => {
    try {
      // 获取全局用户名
      const { stdout: userName } = await execGitCommand('git config --global user.name');
      // 获取全局用户邮箱
      const { stdout: userEmail } = await execGitCommand('git config --global user.email');
      
      res.json({ 
        name: userName.trim(),
        email: userEmail.trim()
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  
  // 新增获取当前工作目录接口
  app.get('/api/current_directory', async (req, res) => {
      try {
          const directory = process.cwd();
          
          // 检查当前目录是否是Git仓库
          try {
              await execGitCommand('git rev-parse --is-inside-work-tree');
          } catch (error) {
              return res.status(400).json({ 
                  error: '当前目录不是一个Git仓库',
                  directory,
                  isGitRepo: false
              });
          }
          
          res.json({ 
              directory,
              isGitRepo: true 
          });
      } catch (error) {
          res.status(500).json({ error: error.message });
      }
  });
  
  // 新增切换工作目录接口
  app.post('/api/change_directory', async (req, res) => {
      try {
          const { path } = req.body;
          
          if (!path) {
              return res.status(400).json({ success: false, error: '目录路径不能为空' });
          }
          
          try {
              process.chdir(path);
              const newDirectory = process.cwd();
              
              // 更新当前项目路径和房间ID
              const oldProjectPath = currentProjectPath;
              const newProjectPath = newDirectory;
              const newProjectRoomId = `project:${newProjectPath.replace(/[\\/:*?"<>|\s]/g, '_')}`;
              
              console.log(chalk.yellow(`项目路径切换: ${oldProjectPath} -> ${newProjectPath}`));
              console.log(chalk.yellow(`房间ID更新: ${projectRoomId} -> ${newProjectRoomId}`));
              
              // 检查新目录是否是Git仓库
              try {
                  await execGitCommand('git rev-parse --is-inside-work-tree');
                  
                  // 更新全局变量
                  currentProjectPath = newProjectPath;
                  projectRoomId = newProjectRoomId;
                  isGitRepo = true;
                  
                  // 确保切换后立即初始化该项目的配置条目
                  try {
                    const currentCfg = await configManager.loadConfig();
                    await configManager.saveConfig(currentCfg);
                    // 将新目录加入最近目录
                    await configManager.saveRecentDirectory(newDirectory);
                  } catch (e) {
                    console.warn('初始化项目配置失败:', e?.message || e);
                  }
                  
                  // 通知所有旧房间的客户端项目已切换
                  io.to(projectRoomId).emit('project_changed', {
                    oldProjectPath: currentProjectPath,
                    newProjectPath: newProjectPath,
                    newProjectRoomId: newProjectRoomId
                  });
                  
                  // 不再自动启动文件监控，只在用户手动开启自动更新开关时启动
                  // console.log('[切换目录] 将在3秒后初始化文件监控器');
                  // setTimeout(() => {
                  //   initFileSystemWatcher().catch(err => console.error('[文件监控] 初始化失败:', err));
                  // }, 3000);
                  
                  res.json({ 
                      success: true, 
                      directory: newDirectory,
                      isGitRepo: true,
                      projectRoomId: newProjectRoomId
                  });
              } catch (error) {
                  // 不是Git仓库，停止监控
                  
                  // 更新全局变量
                  currentProjectPath = newProjectPath;
                  projectRoomId = newProjectRoomId;
                  isGitRepo = false;
                  
                  // 通知所有旧房间的客户端项目已切换
                  io.to(projectRoomId).emit('project_changed', {
                    oldProjectPath: currentProjectPath,
                    newProjectPath: newProjectPath,
                    newProjectRoomId: newProjectRoomId
                  });
                  
                  // 即使不是Git仓库也初始化当前目录配置（使用CWD作为项目键）
                  try {
                    const currentCfg = await configManager.loadConfig();
                    await configManager.saveConfig(currentCfg);
                    // 将新目录加入最近目录
                    await configManager.saveRecentDirectory(newDirectory);
                  } catch (e) {
                    console.warn('非Git目录初始化项目配置失败:', e?.message || e);
                  }

                  res.json({ 
                      success: true, 
                      directory: newDirectory,
                      isGitRepo: false,
                      warning: '新目录不是一个Git仓库',
                      projectRoomId: newProjectRoomId
                  });
              }
          } catch (error) {
              res.status(400).json({ 
                  success: false, 
                  error: `切换到目录 "${path}" 失败: ${error.message}` 
              });
          }
      } catch (error) {
          res.status(500).json({ error: error.message });
      }
  });
  
  // 获取目录内容（用于浏览目录）
  app.get('/api/browse_directory', async (req, res) => {
      try {
          
          // 获取要浏览的目录路径，如果没有提供，则使用当前目录
          const directoryPath = req.query.path || process.cwd();
          
          try {
              // 读取目录内容
              const items = await fs.readdir(directoryPath, { withFileTypes: true });
              
              // 分离文件夹和文件
              const directories = [];
              const files = [];
              
              for (const item of items) {
                  const fullPath = path.join(directoryPath, item.name);
                  if (item.isDirectory()) {
                      directories.push({
                          name: item.name,
                          path: fullPath,
                          type: 'directory'
                      });
                  } else if (item.isFile()) {
                      files.push({
                          name: item.name,
                          path: fullPath,
                          type: 'file'
                      });
                  }
              }
              
              // 优先显示目录，然后是文件，都按字母排序
              directories.sort((a, b) => a.name.localeCompare(b.name));
              files.sort((a, b) => a.name.localeCompare(b.name));
              
              // 获取父目录路径
              const parentPath = path.dirname(directoryPath);
              
              res.json({
                  success: true,
                  currentPath: directoryPath,
                  parentPath: parentPath !== directoryPath ? parentPath : null,
                  items: [...directories, ...files]
              });
          } catch (error) {
              res.status(400).json({
                  success: false,
                  error: `无法读取目录 "${directoryPath}": ${error.message}`
              });
          }
      } catch (error) {
          res.status(500).json({ error: error.message });
      }
  });
  
  // POST接口版本的浏览目录功能
  app.post('/api/browse_directory', async (req, res) => {
      try {
          // 获取要浏览的目录路径，如果没有提供，则使用当前目录
          const directoryPath = req.body.currentPath || process.cwd();
          
          try {
              // 读取目录内容
              const items = await fs.readdir(directoryPath, { withFileTypes: true });
              
              // 分离文件夹和文件
              const directories = [];
              const files = [];
              
              for (const item of items) {
                  const fullPath = path.join(directoryPath, item.name);
                  if (item.isDirectory()) {
                      directories.push({
                          name: item.name,
                          path: fullPath,
                          type: 'directory'
                      });
                  }
              }
              
              // 只返回目录，不返回文件
              directories.sort((a, b) => a.name.localeCompare(b.name));
              
              // 获取父目录路径
              const parentPath = path.dirname(directoryPath);
              
              // 返回选择的目录路径
              res.json({
                  success: true,
                  path: directoryPath,
                  parentPath: parentPath !== directoryPath ? parentPath : null,
                  items: directories
              });
          } catch (error) {
              res.status(400).json({
                  success: false,
                  error: `无法读取目录 "${directoryPath}": ${error.message}`
              });
          }
      } catch (error) {
          res.status(500).json({ 
              success: false,
              error: error.message 
          });
      }
  });
  
  // 获取最近访问的目录列表
  app.get('/api/recent_directories', async (req, res) => {
      try {
          // 尝试从配置中获取最近的目录
          const recentDirs = await configManager.getRecentDirectories();
          res.json({
              success: true,
              directories: recentDirs || []
          });
      } catch (error) {
          res.status(500).json({ 
              success: false,
              error: error.message 
          });
      }
  });
  
  // 在资源管理器/访达中打开当前目录
  app.post('/api/open_directory', async (req, res) => {
      try {
          // 获取要打开的目录路径，如果没有提供，则使用当前目录
          const directoryPath = req.body.path || process.cwd();
          
          try {
              // 检查目录是否存在
              await fs.access(directoryPath);
              
              // 使用open模块打开目录，自动处理不同操作系统
              await open(directoryPath, { wait: false });
              
              res.json({
                  success: true,
                  message: '已在文件管理器中打开目录'
              });
          } catch (error) {
              res.status(400).json({
                  success: false,
                  error: `无法打开目录 "${directoryPath}": ${error.message}`
              });
          }
      } catch (error) {
          res.status(500).json({ 
              success: false,
              error: error.message 
          });
      }
  });
  
  // 在终端中打开当前目录
  app.post('/api/open_terminal', async (req, res) => {
      try {
          // 获取要打开的目录路径，如果没有提供，则使用当前目录
          const directoryPath = req.body.path || process.cwd();
          
          try {
              // 检查目录是否存在
              await fs.access(directoryPath);
              
              // 根据不同操作系统打开终端
              const platform = os.platform();
              let command;
              let args;
              
              switch (platform) {
                  case 'win32':
                      // Windows: 将start命令的参数分开传递，避免引号转义问题
                      // 参数顺序：start [title] /D [path] [command]
                      command = 'cmd';
                      args = ['/c', 'start', '', '/D', directoryPath, 'cmd'];
                      break;
                  case 'darwin':
                      // macOS: 使用 Terminal.app
                      command = 'open';
                      args = ['-a', 'Terminal', directoryPath];
                      break;
                  case 'linux':
                      // Linux: 尝试使用常见的终端模拟器
                      // 优先级: gnome-terminal, konsole, xterm
                      const terminals = [
                          { cmd: 'gnome-terminal', args: ['--working-directory', directoryPath] },
                          { cmd: 'konsole', args: ['--workdir', directoryPath] },
                          { cmd: 'xterm', args: ['-e', `cd "${directoryPath}" && $SHELL`] }
                      ];
                      
                      // 尝试找到可用的终端
                      let terminalFound = false;
                      for (const terminal of terminals) {
                          try {
                              exec(`which ${terminal.cmd}`, (error) => {
                                  if (!error) {
                                      command = terminal.cmd;
                                      args = terminal.args;
                                      terminalFound = true;
                                  }
                              });
                              if (terminalFound) break;
                          } catch (e) {
                              continue;
                          }
                      }
                      
                      if (!terminalFound) {
                          return res.status(400).json({
                              success: false,
                              error: '未找到可用的终端模拟器'
                          });
                      }
                      break;
                  default:
                      return res.status(400).json({
                          success: false,
                          error: `不支持的操作系统: ${platform}`
                      });
              }
              
              // 执行命令打开终端
              spawn(command, args, {
                  detached: true,
                  stdio: 'ignore'
              }).unref();
              
              res.json({
                  success: true,
                  message: '已在终端中打开目录'
              });
          } catch (error) {
              res.status(400).json({
                  success: false,
                  error: `无法打开终端 "${directoryPath}": ${error.message}`
              });
          }
      } catch (error) {
          res.status(500).json({ 
              success: false,
              error: error.message 
          });
      }
  });
  
  // 打开文件
  app.post('/api/open-file', async (req, res) => {
    try {
      const { filePath, context } = req.body;
      
      if (!filePath) {
        return res.status(400).json({
          success: false,
          error: '文件路径不能为空'
        });
      }
      
      let targetFilePath = filePath;
      
      // 根据上下文处理不同的文件打开方式
      switch (context) {
        case 'git-status':
          // Git状态：直接打开当前工作目录中的文件
          targetFilePath = path.resolve(process.cwd(), filePath);
          break;
          
        case 'commit-detail':
          // 提交详情：这里可以考虑创建临时文件显示该提交时的文件内容
          // 暂时先打开当前版本的文件
          targetFilePath = path.resolve(process.cwd(), filePath);
          break;
          
        case 'stash-detail':
          // Stash详情：同样暂时打开当前版本的文件
          targetFilePath = path.resolve(process.cwd(), filePath);
          break;
          
        default:
          targetFilePath = path.resolve(process.cwd(), filePath);
      }
      
      try {
        // 检查文件是否存在
        await fs.access(targetFilePath);
        
        // 使用系统默认程序打开文件
        await open(targetFilePath, { wait: false });
        
        res.json({
          success: true,
          message: `已打开文件: ${path.basename(targetFilePath)}`
        });
      } catch (error) {
        // 如果文件不存在，尝试在编辑器中创建新文件
        if (error.code === 'ENOENT') {
          try {
            await open(targetFilePath, { wait: false });
            res.json({
              success: true,
              message: `已在编辑器中打开文件: ${path.basename(targetFilePath)}`
            });
          } catch (openError) {
            res.status(400).json({
              success: false,
              error: `无法打开文件 "${path.basename(targetFilePath)}": ${openError.message}`
            });
          }
        } else {
          res.status(400).json({
            success: false,
            error: `无法访问文件 "${path.basename(targetFilePath)}": ${error.message}`
          });
        }
      }
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
  
  // 用VSCode打开文件
  app.post('/api/open-with-vscode', async (req, res) => {
    try {
      const { filePath, context } = req.body;
      
      if (!filePath) {
        return res.status(400).json({
          success: false,
          error: '文件路径不能为空'
        });
      }
      
      let targetFilePath = filePath;
      
      // 根据上下文处理不同的文件打开方式
      switch (context) {
        case 'git-status':
        case 'commit-detail':
        case 'stash-detail':
          targetFilePath = path.resolve(process.cwd(), filePath);
          break;
        default:
          targetFilePath = path.resolve(process.cwd(), filePath);
      }
      
      try {
        // 使用VSCode打开文件
        // 尝试使用 'code' 命令打开文件
        // 使用已导入的 spawn
        
        // 创建一个Promise来处理spawn的异步结果
        const spawnPromise = new Promise((resolve, reject) => {
          const vscodeProcess = spawn('code', [targetFilePath], {
            detached: true,
            stdio: 'ignore'
          });
          
          // 监听错误事件
          vscodeProcess.on('error', (err) => {
            reject(err);
          });
          
          // 监听spawn事件，表示进程成功启动
          vscodeProcess.on('spawn', () => {
            resolve('success');
          });
          
          vscodeProcess.unref();
        });
        
        await spawnPromise;
        
        res.json({
          success: true,
          message: `已用VSCode打开文件: ${path.basename(targetFilePath)}`
        });
      } catch (error) {
        // 如果VSCode命令不可用，尝试直接用open打开
        try {
          await open(targetFilePath, { app: { name: 'code' } });
          res.json({
            success: true,
            message: `已用VSCode打开文件: ${path.basename(targetFilePath)}`
          });
        } catch (openError) {
          // 最后的备用方案：尝试用系统默认编辑器打开
          try {
            await open(targetFilePath);
            res.json({
              success: true,
              message: `VSCode不可用，已用系统默认程序打开文件: ${path.basename(targetFilePath)}`
            });
          } catch (finalError) {
            res.status(400).json({
              success: false,
              error: `无法打开文件 "${path.basename(targetFilePath)}": VSCode可能未安装或未添加到PATH，且系统默认程序也无法打开该文件`
            });
          }
        }
      }
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
  
  // 保存最近访问的目录
  app.post('/api/save_recent_directory', async (req, res) => {
      try {
          const { path } = req.body;
          
          if (!path) {
              return res.status(400).json({ 
                  success: false, 
                  error: '目录路径不能为空' 
              });
          }
          
          // 保存到配置
          await configManager.saveRecentDirectory(path);
          
          res.json({
              success: true
          });
      } catch (error) {
          res.status(500).json({ 
              success: false,
              error: error.message 
          });
      }
  });
  
  // 获取配置
  app.get('/api/config/getConfig', async (req, res) => {
    try {
      // console.log('获取配置中。。。')
      const config = await configManager.loadConfig()

      // 兼容旧数据：补齐自定义命令 id，避免前端编辑/删除/编排引用异常
      if (Array.isArray(config.customCommands)) {
        let changed = false
        config.customCommands = config.customCommands.map((cmd) => {
          if (cmd && typeof cmd === 'object' && !cmd.id) {
            changed = true
            return {
              ...cmd,
              id: `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
            }
          }
          return cmd
        })
        if (changed) {
          await configManager.saveConfig(config)
        }
      }

      // console.log('获取配置成功')
      res.json(config)
    } catch (error) {
      // console.log('获取配置失败')
      res.status(500).json({ error: error.message })
    }
  })
  
  // 保存默认提交信息
  app.post('/api/config/saveDefaultMessage', express.json(), async (req, res) => {
    try {
      const { defaultCommitMessage } = req.body
      
      if (!defaultCommitMessage) {
        return res.status(400).json({ success: false, error: '缺少必要参数' })
      }
      
      const config = await configManager.loadConfig()
      
      // 更新默认提交信息
      config.defaultCommitMessage = defaultCommitMessage
      await configManager.saveConfig(config)
      
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 保存所有配置
  app.post('/api/config/saveAll', express.json(), async (req, res) => {
    try {
      const { config } = req.body
      
      if (!config) {
        return res.status(400).json({ success: false, error: '缺少必要参数' })
      }
      
      await configManager.saveConfig(config)
      
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })

  // 检查系统配置文件格式
  app.get('/api/config/check-file-format', async (req, res) => {
    try {
      const configPath = path.join(os.homedir(), '.git-commit-tool.json');
      
      try {
        const data = await fs.readFile(configPath, 'utf-8');
        try {
          JSON.parse(data);
          res.json({ success: true, isValidJson: true, exists: true });
        } catch (parseError) {
          res.json({ 
            success: true, 
            isValidJson: false, 
            exists: true, 
            error: `JSON解析失败: ${parseError.message}` 
          });
        }
      } catch (fileError) {
        if (fileError.code === 'ENOENT') {
          res.json({ success: true, isValidJson: true, exists: false });
        } else {
          res.json({ 
            success: true, 
            isValidJson: false, 
            exists: true, 
            error: `文件读取失败: ${fileError.message}` 
          });
        }
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  })

  // 使用系统默认程序打开配置文件 ~/.git-commit-tool.json
  app.post('/api/config/open-file', async (req, res) => {
    try {
      const filePath = path.join(os.homedir(), '.git-commit-tool.json');
      try {
        // 检查文件是否存在，不存在也尝试让系统创建（可能会打开空文件）
        await fs.access(filePath);
      } catch (_) {
        // 如果文件不存在，先创建一个最小结构，避免某些系统无法打开不存在的路径
        try {
          await fs.writeFile(filePath, '{}', 'utf-8');
        } catch (e) {
          // 创建失败不阻断打开尝试
          console.warn('创建配置文件失败(可忽略):', e?.message || e);
        }
      }

      await open(filePath, { wait: false });
      res.json({ success: true })
    } catch (error) {
      res.status(400).json({ success: false, error: `无法打开配置文件: ${error.message}` })
    }
  })
  
  // 保存模板
  app.post('/api/config/save-template', express.json(), async (req, res) => {
    try {
      const { template, type } = req.body
      
      if (!template || !type) {
        return res.status(400).json({ success: false, error: '缺少必要参数' })
      }
      
      const config = await configManager.loadConfig()
      
      if (type === 'description') {
        // 确保描述模板数组存在
        if (!config.descriptionTemplates) {
          config.descriptionTemplates = []
        }
        
        // 检查是否已存在相同模板
        if (!config.descriptionTemplates.includes(template)) {
          config.descriptionTemplates.push(template)
          await configManager.saveConfig(config)
        }
      } else if (type === 'scope') {
        // 确保作用域模板数组存在
        if (!config.scopeTemplates) {
          config.scopeTemplates = []
        }
        
        // 检查是否已存在相同模板
        if (!config.scopeTemplates.includes(template)) {
          config.scopeTemplates.push(template)
          await configManager.saveConfig(config)
        }
      } else if (type === 'message') {
        // 确保提交信息模板数组存在
        if (!config.messageTemplates) {
          config.messageTemplates = []
        }
        
        // 检查是否已存在相同模板
        if (!config.messageTemplates.includes(template)) {
          config.messageTemplates.push(template)
          await configManager.saveConfig(config)
        }
      } else {
        return res.status(400).json({ success: false, error: '不支持的模板类型' })
      }
      
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 删除模板
  app.post('/api/config/delete-template', express.json(), async (req, res) => {
    try {
      const { template, type } = req.body
      
      if (!template || !type) {
        return res.status(400).json({ success: false, error: '缺少必要参数' })
      }
      
      const config = await configManager.loadConfig()
      
      if (type === 'description') {
        // 确保描述模板数组存在
        if (config.descriptionTemplates) {
          const index = config.descriptionTemplates.indexOf(template)
          if (index !== -1) {
            config.descriptionTemplates.splice(index, 1)
            await configManager.saveConfig(config)
          }
        }
      } else if (type === 'scope') {
        // 确保作用域模板数组存在
        if (config.scopeTemplates) {
          const index = config.scopeTemplates.indexOf(template)
          if (index !== -1) {
            config.scopeTemplates.splice(index, 1)
            await configManager.saveConfig(config)
          }
        }
      } else if (type === 'message') {
        // 确保提交信息模板数组存在
        if (config.messageTemplates) {
          const index = config.messageTemplates.indexOf(template)
          if (index !== -1) {
            config.messageTemplates.splice(index, 1)
            await configManager.saveConfig(config)
          }
        }
      } else {
        return res.status(400).json({ success: false, error: '不支持的模板类型' })
      }
      
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 更新模板
  app.post('/api/config/update-template', express.json(), async (req, res) => {
    try {
      const { oldTemplate, newTemplate, type } = req.body
      
      if (!oldTemplate || !newTemplate || !type) {
        return res.status(400).json({ success: false, error: '缺少必要参数' })
      }
      
      const config = await configManager.loadConfig()
      
      if (type === 'description') {
        // 确保描述模板数组存在
        if (config.descriptionTemplates) {
          const index = config.descriptionTemplates.indexOf(oldTemplate)
          if (index !== -1) {
            config.descriptionTemplates[index] = newTemplate
            await configManager.saveConfig(config)
          } else {
            return res.status(404).json({ success: false, error: '未找到原模板' })
          }
        } else {
          return res.status(404).json({ success: false, error: '模板列表不存在' })
        }
      } else if (type === 'scope') {
        // 确保作用域模板数组存在
        if (config.scopeTemplates) {
          const index = config.scopeTemplates.indexOf(oldTemplate)
          if (index !== -1) {
            config.scopeTemplates[index] = newTemplate
            await configManager.saveConfig(config)
          } else {
            return res.status(404).json({ success: false, error: '未找到原模板' })
          }
        } else {
          return res.status(404).json({ success: false, error: '模板列表不存在' })
        }
      } else if (type === 'message') {
        // 确保提交信息模板数组存在
        if (config.messageTemplates) {
          const index = config.messageTemplates.indexOf(oldTemplate)
          if (index !== -1) {
            config.messageTemplates[index] = newTemplate
            await configManager.saveConfig(config)
          } else {
            return res.status(404).json({ success: false, error: '未找到原模板' })
          }
        } else {
          return res.status(404).json({ success: false, error: '模板列表不存在' })
        }
      } else {
        return res.status(400).json({ success: false, error: '不支持的模板类型' })
      }
      
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 置顶模板
  app.post('/api/config/pin-template', express.json(), async (req, res) => {
    try {
      const { template, type } = req.body
      
      if (!template || !type) {
        return res.status(400).json({ success: false, error: '缺少必要参数' })
      }
      
      const config = await configManager.loadConfig()
      
      if (type === 'description') {
        if (config.descriptionTemplates) {
          // 删除原位置的模板
          config.descriptionTemplates = config.descriptionTemplates.filter(t => t !== template)
          // 添加到第一位
          config.descriptionTemplates.unshift(template)
          await configManager.saveConfig(config)
        } else {
          return res.status(404).json({ success: false, error: '模板列表不存在' })
        }
      } else if (type === 'scope') {
        if (config.scopeTemplates) {
          config.scopeTemplates = config.scopeTemplates.filter(t => t !== template)
          config.scopeTemplates.unshift(template)
          await configManager.saveConfig(config)
        } else {
          return res.status(404).json({ success: false, error: '模板列表不存在' })
        }
      } else if (type === 'message') {
        if (config.messageTemplates) {
          config.messageTemplates = config.messageTemplates.filter(t => t !== template)
          config.messageTemplates.unshift(template)
          await configManager.saveConfig(config)
        } else {
          return res.status(404).json({ success: false, error: '模板列表不存在' })
        }
      } else {
        return res.status(400).json({ success: false, error: '不支持的模板类型' })
      }
      
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 保存自定义命令
  app.post('/api/config/save-custom-command', express.json(), async (req, res) => {
    try {
      const { command } = req.body
      
      if (!command || !command.name || !command.command) {
        return res.status(400).json({ success: false, error: '缺少必要参数' })
      }
      
      const config = await configManager.loadConfig()
      
      // 确保自定义命令数组存在
      if (!Array.isArray(config.customCommands)) {
        config.customCommands = []
      }
      
      // 生成唯一ID
      const id = `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      const newCommand = {
        id,
        name: command.name,
        description: command.description || '',
        directory: command.directory || '',
        command: command.command
      }
      
      config.customCommands.push(newCommand)
      await configManager.saveConfig(config)
      
      res.json({ success: true, command: newCommand })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 删除自定义命令
  app.post('/api/config/delete-custom-command', express.json(), async (req, res) => {
    try {
      const { id } = req.body
      
      if (!id) {
        return res.status(400).json({ success: false, error: '缺少命令ID参数' })
      }
      
      const config = await configManager.loadConfig()
      
      if (Array.isArray(config.customCommands)) {
        const index = config.customCommands.findIndex(cmd => cmd.id === id)
        if (index !== -1) {
          config.customCommands.splice(index, 1)
          await configManager.saveConfig(config)
        }
      }
      
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 更新自定义命令
  app.post('/api/config/update-custom-command', express.json(), async (req, res) => {
    try {
      const { id, command } = req.body
      
      if (!id || !command || !command.name || !command.command) {
        return res.status(400).json({ success: false, error: '缺少必要参数' })
      }
      
      const config = await configManager.loadConfig()
      
      if (Array.isArray(config.customCommands)) {
        const index = config.customCommands.findIndex(cmd => cmd.id === id)
        if (index !== -1) {
          config.customCommands[index] = {
            id,
            name: command.name,
            description: command.description || '',
            directory: command.directory || '',
            command: command.command
          }
          await configManager.saveConfig(config)
        } else {
          return res.status(404).json({ success: false, error: '未找到指定命令' })
        }
      } else {
        return res.status(404).json({ success: false, error: '命令列表不存在' })
      }
      
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 保存指令编排
  app.post('/api/config/save-orchestration', express.json(), async (req, res) => {
    try {
      const { orchestration } = req.body
      
      if (!orchestration || !orchestration.name || !Array.isArray(orchestration.steps)) {
        return res.status(400).json({ success: false, error: '缺少必要参数' })
      }
      
      const config = await configManager.loadConfig()
      
      // 确保编排数组存在
      if (!Array.isArray(config.orchestrations)) {
        config.orchestrations = []
      }
      
      // 生成唯一ID
      const id = `orch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      const newOrchestration = {
        id,
        name: orchestration.name,
        description: orchestration.description || '',
        steps: orchestration.steps,
        flowData: orchestration.flowData || null
      }
      
      config.orchestrations.push(newOrchestration)
      await configManager.saveConfig(config)
      
      res.json({ success: true, orchestration: newOrchestration })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 删除指令编排
  app.post('/api/config/delete-orchestration', express.json(), async (req, res) => {
    try {
      const { id } = req.body
      
      if (!id) {
        return res.status(400).json({ success: false, error: '缺少编排ID参数' })
      }
      
      const config = await configManager.loadConfig()
      
      if (Array.isArray(config.orchestrations)) {
        const index = config.orchestrations.findIndex(orch => orch.id === id)
        if (index !== -1) {
          config.orchestrations.splice(index, 1)
          await configManager.saveConfig(config)
        }
      }
      
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 更新指令编排
  app.post('/api/config/update-orchestration', express.json(), async (req, res) => {
    try {
      const { id, orchestration } = req.body
      
      if (!id || !orchestration || !orchestration.name || !Array.isArray(orchestration.steps)) {
        return res.status(400).json({ success: false, error: '缺少必要参数' })
      }
      
      const config = await configManager.loadConfig()
      
      if (Array.isArray(config.orchestrations)) {
        const index = config.orchestrations.findIndex(orch => orch.id === id)
        if (index !== -1) {
          config.orchestrations[index] = {
            id,
            name: orchestration.name,
            description: orchestration.description || '',
            steps: orchestration.steps,
            flowData: orchestration.flowData || null
          }
          await configManager.saveConfig(config)
        } else {
          return res.status(404).json({ success: false, error: '未找到指定编排' })
        }
      } else {
        return res.status(404).json({ success: false, error: '编排列表不存在' })
      }
      
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 读取 package.json 文件内容
  app.post('/api/read-package-json', express.json(), async (req, res) => {
    try {
      const { packageJsonPath } = req.body
      
      // 确定 package.json 的路径
      let pkgPath
      if (packageJsonPath && packageJsonPath.trim()) {
        pkgPath = path.isAbsolute(packageJsonPath) 
          ? packageJsonPath 
          : path.join(currentProjectPath, packageJsonPath)
      } else {
        pkgPath = path.join(currentProjectPath, 'package.json')
      }
      
      // 检查文件是否存在
      try {
        await fs.access(pkgPath)
      } catch (err) {
        return res.status(404).json({ 
          success: false, 
          error: `未找到 package.json 文件: ${pkgPath}` 
        })
      }
      
      // 读取 package.json
      const pkgContent = await fs.readFile(pkgPath, 'utf8')
      const pkg = JSON.parse(pkgContent)
      
      res.json({ 
        success: true, 
        dependencies: pkg.dependencies || {},
        devDependencies: pkg.devDependencies || {},
        version: pkg.version
      })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 版本号递增或依赖版本修改
  app.post('/api/version-bump', express.json(), async (req, res) => {
    try {
      const { bumpType, packageJsonPath, versionTarget, dependencyName, dependencyVersion, dependencyVersionBump, dependencyType } = req.body
      
      // 确定 package.json 的路径
      let pkgPath
      if (packageJsonPath && packageJsonPath.trim()) {
        pkgPath = path.isAbsolute(packageJsonPath) 
          ? packageJsonPath 
          : path.join(currentProjectPath, packageJsonPath)
      } else {
        pkgPath = path.join(currentProjectPath, 'package.json')
      }
      
      // 检查文件是否存在（使用 Node.js 原生方法）
      try {
        await fs.access(pkgPath)
      } catch (err) {
        return res.status(404).json({ 
          success: false, 
          error: `未找到 package.json 文件: ${pkgPath}` 
        })
      }
      
      // 读取 package.json
      const pkgContent = await fs.readFile(pkgPath, 'utf8')
      const pkg = JSON.parse(pkgContent)
      
      // 判断是修改 version 还是 dependency
      if (versionTarget === 'dependency') {
        // 修改依赖版本
        const depType = dependencyType || 'dependencies'
        
        if (!pkg[depType]) {
          return res.status(400).json({ 
            success: false, 
            error: `package.json 中未找到 ${depType} 字段` 
          })
        }
        
        if (!pkg[depType][dependencyName]) {
          return res.status(400).json({ 
            success: false, 
            error: `在 ${depType} 中未找到依赖包: ${dependencyName}` 
          })
        }
        
        const oldVersion = pkg[depType][dependencyName]
        let newVersion
        
        // 判断是自动递增还是手动输入
        if (dependencyVersionBump) {
          // 自动递增模式：解析当前版本号并递增
          // 提取版本号中的数字部分（去除 ^, ~, >=, 等前缀）
          const versionMatch = oldVersion.match(/(\^|~|>=|>|<=|<)?(\d+\.\d+\.\d+)/)
          if (!versionMatch) {
            return res.status(400).json({ 
              success: false, 
              error: `无法解析版本号: ${oldVersion}，应为 x.y.z 格式（可带 ^, ~ 等前缀）` 
            })
          }
          
          const prefix = versionMatch[1] || ''
          const versionNumber = versionMatch[2]
          const versionParts = versionNumber.split('.').map(Number)
          
          if (versionParts.length !== 3 || versionParts.some(isNaN)) {
            return res.status(400).json({ 
              success: false, 
              error: `无效的版本号格式: ${versionNumber}` 
            })
          }
          
          // 根据类型递增版本号
          let [major, minor, patch] = versionParts
          if (dependencyVersionBump === 'major') {
            major += 1
            minor = 0
            patch = 0
          } else if (dependencyVersionBump === 'minor') {
            minor += 1
            patch = 0
          } else { // patch
            patch += 1
          }
          
          newVersion = `${prefix}${major}.${minor}.${patch}`
        } else {
          // 手动输入模式
          newVersion = dependencyVersion
        }
        
        pkg[depType][dependencyName] = newVersion
        
        // 写回 package.json（保持格式化）
        await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
        
        res.json({ 
          success: true, 
          oldVersion, 
          newVersion,
          filePath: pkgPath,
          dependencyName,
          dependencyType: depType
        })
      } else {
        // 修改 version 字段（原有逻辑）
        if (!pkg.version) {
          return res.status(400).json({ 
            success: false, 
            error: 'package.json 中未找到 version 字段' 
          })
        }
        
        const oldVersion = pkg.version
        
        // 解析版本号
        const versionParts = oldVersion.split('.').map(Number)
        if (versionParts.length !== 3 || versionParts.some(isNaN)) {
          return res.status(400).json({ 
            success: false, 
            error: `无效的版本号格式: ${oldVersion}，应为 x.y.z 格式` 
          })
        }
        
        // 根据类型递增版本号
        let [major, minor, patch] = versionParts
        if (bumpType === 'major') {
          major += 1
          minor = 0
          patch = 0
        } else if (bumpType === 'minor') {
          minor += 1
          patch = 0
        } else { // patch
          patch += 1
        }
        
        const newVersion = `${major}.${minor}.${patch}`
        pkg.version = newVersion
        
        // 写回 package.json（保持格式化）
        await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
        
        res.json({ 
          success: true, 
          oldVersion, 
          newVersion,
          filePath: pkgPath
        })
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 提交更改
  app.post('/api/commit', express.json(), async (req, res) => {
    try {
      const { message, hasNewlines, noVerify } = req.body;
  
      // 构建 git commit 命令
      let commitCommand = 'git commit';
  
      // 如果消息包含换行符，使用文件方式提交
      if (hasNewlines) {
        // 创建临时文件存储提交信息
        const tempFile = path.join(os.tmpdir(), `commit-msg-${Date.now()}.txt`);
        await fs.writeFile(tempFile, message);
        commitCommand += ` -F "${tempFile}"`;
      } else {
        // 否则直接在命令行中提供消息
        commitCommand += ` -m "${message}"`;
      }
      
      // 添加 --no-verify 参数
      if (noVerify) {
        commitCommand += ' --no-verify';
      }
      
      console.log(`commitCommand ==>`, commitCommand);
      // 执行提交命令
      await execGitCommand(commitCommand);
      
      // 如果使用了临时文件，删除它
      if (hasNewlines) {
        const tempFile = path.join(os.tmpdir(), `commit-msg-${Date.now()}.txt`);
        await fs.unlink(tempFile).catch(() => {});
      }
      
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // 添加 add 接口
  app.post('/api/add', async (req, res) => {
    try {
      // 直接执行 git add . - 前端已经做了锁定文件过滤判断
      await execGitCommand('git add .');
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // 添加带锁定文件过滤的 add 接口
  app.post('/api/add-filtered', async (req, res) => {
    try {
      // 使用带锁定文件过滤的 git add
      await execGitAddWithLockFilter();
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 添加 add-all 接口（直接执行 git add . 不考虑锁定文件）
  app.post('/api/add-all', async (req, res) => {
    try {
      // 直接执行 git add . 不考虑锁定文件
      await execGitCommand('git add .');
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // 添加单个文件到暂存区
  app.post('/api/add-file', async (req, res) => {
    try {
      const { filePath } = req.body;
      
      if (!filePath) {
        return res.status(400).json({ 
          success: false, 
          error: '缺少文件路径参数' 
        });
      }
      
      // 执行 git add 命令添加特定文件
      await execGitCommand(`git add "${filePath}"`);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // 从暂存区移除单个文件
  app.post('/api/unstage-file', async (req, res) => {
    try {
      const { filePath } = req.body;
      
      if (!filePath) {
        return res.status(400).json({ 
          success: false, 
          error: '缺少文件路径参数' 
        });
      }
      
      // 执行 git reset HEAD 命令移除特定文件的暂存
      await execGitCommand(`git reset HEAD -- "${filePath}"`);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // 推送更改
  app.post('/api/push', async (req, res) => {
    try {
      const { stdout } = await execGitCommand('git push');

      // 推送成功后，设置推送状态标记
      recentPushStatus = {
        justPushed: true,
        pushTime: Date.now(),
        validDuration: 10000 // 10秒内认为分支状态是同步的
      };

      console.log('推送成功，已设置推送状态标记');
      res.json({ success: true, message: stdout });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 带进度的推送更改 (SSE)
  app.post('/api/push-with-progress', async (req, res) => {
    // 设置SSE响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendProgress = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      // 获取当前工作目录 - 与execGitCommand保持一致
      const cwdArg = process.argv.find(arg => arg.startsWith('--path')) || process.argv.find(arg => arg.startsWith('--cwd'));
      let workDir = process.cwd();
      if (cwdArg) {
        const [, value] = cwdArg.split('=');
        workDir = value || process.cwd();
      }
      
      console.log('开始推送，工作目录:', workDir);
      
      // 记录开始时间
      const startTime = Date.now();
      
      // 发送开始消息
      sendProgress({
        type: 'progress',
        message: '开始推送到远程仓库...'
      });
      
      // 使用spawn执行git push --progress
      const gitPush = spawn('git', ['push', '--progress'], {
        cwd: workDir,
        env: {
          ...process.env,
          GIT_CONFIG_PARAMETERS: "'core.quotepath=false'" // 关闭路径转义
        }
      });

      let errorOutput = '';
      let standardOutput = '';

      // Git的进度信息在stderr中
      gitPush.stderr.on('data', (data) => {
        const output = data.toString();
        errorOutput += output;
        
        // 解析进度信息
        const lines = output.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            // 发送原始行
            sendProgress({
              type: 'progress',
              message: line.trim()
            });

            // 识别不同阶段并解析百分比
            const percentMatch = line.match(/(\d+)%/);
            if (percentMatch) {
              const percent = parseInt(percentMatch[1]);
              let stage = 'unknown';
              
              if (line.includes('Enumerating objects')) {
                stage = 'enumerating';
              } else if (line.includes('Counting objects')) {
                stage = 'counting';
              } else if (line.includes('Compressing objects')) {
                stage = 'compressing';
              } else if (line.includes('Writing objects')) {
                stage = 'writing';
              } else if (line.includes('Resolving deltas')) {
                stage = 'resolving';
              }
              
              sendProgress({
                type: 'stage-progress',
                stage: stage,
                percent: percent,
                message: line.trim()
              });
            }
          }
        }
      });

      gitPush.stdout.on('data', (data) => {
        standardOutput += data.toString();
      });

      gitPush.on('close', (code) => {
        console.log(`Git push 进程结束，退出码: ${code}`);
        console.log('标准输出:', standardOutput);
        console.log('错误输出:', errorOutput);
        
        // 计算执行时间
        const executionTime = Date.now() - startTime;
        
        if (code === 0) {
          // 推送成功
          recentPushStatus = {
            justPushed: true,
            pushTime: Date.now(),
            validDuration: 10000
          };

          // 添加到命令历史
          addCommandToHistory(
            'git push --progress',
            standardOutput,
            errorOutput,
            null,
            executionTime
          );

          sendProgress({
            type: 'complete',
            success: true,
            message: standardOutput || errorOutput || 'Push successful'
          });
        } else {
          // 推送失败
          console.error('推送失败:', errorOutput || standardOutput);
          
          // 添加到命令历史（失败情况）
          addCommandToHistory(
            'git push --progress',
            standardOutput,
            errorOutput,
            errorOutput || standardOutput || `Push failed with code ${code}`,
            executionTime
          );
          
          sendProgress({
            type: 'complete',
            success: false,
            error: errorOutput || standardOutput || `Push failed with code ${code}`
          });
        }
        res.end();
      });

      gitPush.on('error', (error) => {
        console.error('Git push 进程错误:', error);
        
        // 计算执行时间
        const executionTime = Date.now() - startTime;
        
        // 添加到命令历史（错误情况）
        addCommandToHistory(
          'git push --progress',
          '',
          '',
          error.message,
          executionTime
        );
        
        sendProgress({
          type: 'complete',
          success: false,
          error: error.message
        });
        res.end();
      });

    } catch (error) {
      // 添加到命令历史（异常情况）
      addCommandToHistory(
        'git push --progress',
        '',
        '',
        error.message,
        0
      );
      
      sendProgress({
        type: 'complete',
        success: false,
        error: error.message
      });
      res.end();
    }
  });
  
  // 添加git pull API端点
  app.post('/api/pull', async (req, res) => {
    try {
      const { stdout } = await execGitCommand('git pull');
      res.json({ success: true, message: stdout });
    } catch (error) {
      // 改进错误处理，检查是否需要合并
      const errorMsg = error.message || '';
      const needsMerge = errorMsg.includes('merge') || 
                         errorMsg.includes('需要合并') || 
                         errorMsg.includes('CONFLICT') ||
                         errorMsg.includes('冲突');
      
      // 返回更详细的错误信息和标记
      res.status(500).json({ 
        success: false, 
        error: error.message,
        needsMerge: needsMerge,
        // 包含完整的错误输出
        fullError: error.stderr || error.message,
        pullOutput: error.stdout || ''
      });
    }
  });
  
  // 添加git fetch --all API端点
  app.post('/api/fetch-all', async (req, res) => {
    try {
      const { stdout } = await execGitCommand('git fetch --all');
      res.json({ success: true, message: stdout });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // 获取日志
  app.get('/api/log', async (req, res) => {
    try {
      // 获取分页参数
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const skip = (page - 1) * limit;
      
      // 获取筛选参数
      const author = req.query.author ? req.query.author.split(',') : [];
      const message = req.query.message || '';
      const dateFrom = req.query.dateFrom || '';
      const dateTo = req.query.dateTo || '';
      const branch = req.query.branch ? req.query.branch.split(',') : [];
      const withParents = req.query.with_parents === 'true';
      
      // 构建Git命令选项
      let commandOptions = [];
      
      // 修改分支筛选处理 - 使用正确的引用格式
      if (branch.length > 0) {
        // 不再简单拼接分支名，而是将它们作为引用路径处理
        // 如果指定了分支，不再使用--all参数，而是直接用分支名
        commandOptions = commandOptions.filter(opt => opt !== '--all');
        
        // 将分支名格式化为Git可理解的引用格式
        const branchRefs = branch.map(b => b.trim()).join(' ');
        
        // 直接将分支名作为命令参数，并确保后面添加 -- 分隔符防止歧义
        return executeGitLogCommand(res, branchRefs, author, message, dateFrom, dateTo, limit, skip, req.query.all === 'true', withParents);
      }
      
      // 如果没有指定分支，则使用--all参数
      // 作者筛选（支持多作者，使用正则表达式OR操作）
      if (author.length > 0) {
        // 过滤掉空作者
        const validAuthors = author.filter(a => a.trim() !== '');
        
        if (validAuthors.length === 1) {
          // 单个作者，直接使用--author
          commandOptions.push(`--author="${validAuthors[0].trim()}"`);
        } else if (validAuthors.length > 1) {
          // 多个作者，使用正则表达式OR条件
          // 只转义OR运算符，保持其他内容不变
          const authorPattern = validAuthors
            .map(a => a.trim())
            .join('\\|');  // 在JavaScript字符串中\\|会变成\|，在shell中会成为|
          
          commandOptions.push(`--author="${authorPattern}"`);
        }
      }
      
      // 日期范围筛选
      if (dateFrom && dateTo) {
        commandOptions.push(`--after="${dateFrom}" --before="${dateTo} 23:59:59"`);
      } else if (dateFrom) {
        commandOptions.push(`--after="${dateFrom}"`);
      } else if (dateTo) {
        commandOptions.push(`--before="${dateTo} 23:59:59"`);
      }
      
      // 提交信息筛选
      if (message) {
        commandOptions.push(`--grep="${message}"`);
      }
      
      // 如果all=true，则不使用限制，否则按页码和limit精确获取
      // 修复：只获取当前页的数据，而不是累计所有之前页的数据
      const limitOption = req.query.all === 'true' ? '' : `-n ${limit} --skip=${skip}`;
      
      // 合并所有命令选项
      const options = [...commandOptions, limitOption].filter(Boolean).join(' ');
      
      // 添加父提交信息的格式
      let formatString = '%H%x1E%an%x1E%ae%x1E%ad%x1E%B%x1E%D';
      if (withParents) {
        formatString = '%H%x1E%an%x1E%ae%x1E%ad%x1E%B%x1E%D%x1E%P';
      }
      
      // console.log(`执行Git命令: git log --all --pretty=format:"${formatString}" --date=format-local:"%Y-%m-%d %H:%M" ${options}`);

      // 使用 git log 命令获取提交历史
      let { stdout: logOutput } = await execGitCommand(
        `git log --all --pretty=format:"${formatString}" --date=format-local:"%Y-%m-%d %H:%M" ${options}`
      );
      
      // 分页加载优化：不需要获取总数，通过实际返回的数据量判断是否还有更多
      // 这里直接处理已获取的数据，通过返回数据量判断是否还有更多
      processAndSendLogOutput(res, logOutput, page, limit, withParents);
    } catch (error) {
      console.error('获取Git日志失败:', error);
      res.status(500).json({ error: '获取日志失败: ' + error.message });
    }
  });
  
  // 抽取执行Git日志命令的函数
  async function executeGitLogCommand(res, branchRefs, author, message, dateFrom, dateTo, limit, skip, isAll, withParents = false) {
    try {
      // 构建命令选项
      const commandOptions = [];
      
      // 作者筛选
      if (author.length > 0) {
        const validAuthors = author.filter(a => a.trim() !== '');
        
        if (validAuthors.length === 1) {
          commandOptions.push(`--author="${validAuthors[0].trim()}"`);
        } else if (validAuthors.length > 1) {
          const authorPattern = validAuthors.map(a => a.trim()).join('\\|');
          commandOptions.push(`--author="${authorPattern}"`);
        }
      }
      
      // 日期范围筛选
      if (dateFrom && dateTo) {
        commandOptions.push(`--after="${dateFrom}" --before="${dateTo} 23:59:59"`);
      } else if (dateFrom) {
        commandOptions.push(`--after="${dateFrom}"`);
      } else if (dateTo) {
        commandOptions.push(`--before="${dateTo} 23:59:59"`);
      }
      
      // 提交信息筛选
      if (message) {
        commandOptions.push(`--grep="${message}"`);
      }
      
      // 限制选项
      const limitOption = isAll ? '' : `-n ${limit} --skip=${skip}`;
      
      // 合并所有选项
      const options = [...commandOptions, limitOption].filter(Boolean).join(' ');
      
      // 准备分支引用，确保它们被正确识别为分支而不是文件名
      // 使用 refs/heads/ 前缀明确指示这是分支
      const formattedBranchRefs = branchRefs.split(' ')
        .map(branch => {
          // 检查是否已经是完整引用
          if (branch.startsWith('refs/') || branch.includes('/')) {
            return branch;
          }
          // 添加refs/heads/前缀
          return `refs/heads/${branch}`;
        })
        .join(' ');
      
      // 添加父提交信息的格式
      // 确认格式字符串使用 %x1E 作为分隔符
      let formatString = '%H%x1E%an%x1E%ae%x1E%ad%x1E%B%x1E%D';
      if (withParents) {
        formatString = '%H%x1E%an%x1E%ae%x1E%ad%x1E%B%x1E%D%x1E%P';
      }
      
      // 构建执行的命令
      const command = `git log ${formattedBranchRefs} --pretty=format:"${formatString}" --date=format-local:"%Y-%m-%d %H:%M" ${options}`;
      console.log(`执行Git命令(带分支引用): ${command}`);
      
      // 执行命令
      const { stdout: logOutput } = await execGitCommand(command);
      
      // 分页加载优化：不需要获取总数，通过实际返回的数据量判断是否还有更多
      processAndSendLogOutput(res, logOutput, skip / limit + 1, limit, withParents);
    } catch (error) {
      console.error('执行Git日志命令失败:', error);
      res.status(500).json({ error: '获取日志失败: ' + error.message });
    }
  }
  
  // 抽取处理输出并发送响应的函数（优化版本：不再依赖总数计算）
  function processAndSendLogOutput(res, logOutput, page, limit, withParents = false) {
    // 替换提交记录之间的换行符 - 使用 ASCII 控制字符 \x1E 匹配
    logOutput = logOutput.replace(/\n(?=[a-f0-9]{40}\x1E)/g, "<<<RECORD_SEPARATOR>>>");
  
  // 按分隔符拆分日志条目
  const logEntries = logOutput.split("<<<RECORD_SEPARATOR>>>");
  
  // 处理每个日志条目
  const data = logEntries.map(entry => {
    // 使用 ASCII 控制字符 \x1E 拆分字段
    const parts = entry.split('\x1E');
      if (parts.length >= 5) {
        const result = {
          hash: parts[0],
          author: parts[1],
          email: parts[2],
          date: parts[3],
          message: parts[4],
          branch: parts[5] || ''
        };
        
        // 如果请求了父提交信息，添加到结果中
        if (withParents && parts[6]) {
          result.parents = parts[6].split(' ');
        }
        
        return result;
      }
      return null;
    }).filter(item => item !== null);
    
    // 优化：通过返回的数据量判断是否有更多数据，而不依赖总数计算
    // 如果返回的数据量等于请求的limit，说明可能还有更多数据
    // 如果返回的数据量小于limit，说明已经到底了
    const hasMore = data.length === limit;

    // console.log(`分页查询 - 页码: ${page}, 每页数量: ${limit}, 返回数量: ${data.length}, 是否有更多: ${hasMore} (优化版本，不计算总数)`);

    // 返回提交历史数据，包括是否有更多数据的标志
    res.json({
      data: data,
      total: -1, // 不再提供总数，前端不应依赖此字段
      page: page,
      limit: limit,
      hasMore: hasMore
    });
  }
  
  // ========== Diff 大文件检测和过滤工具函数 ==========
  
  /**
   * 检查文件是否应该跳过diff显示（参考GitLab策略）
   * @param {string} filePath - 文件路径
   * @param {string} diffCommand - 要执行的git diff命令
   * @returns {Promise<{shouldSkip: boolean, reason?: string, stats?: object}>}
   */
  async function checkShouldSkipDiff(filePath, diffCommand) {
    // 1. 检查文件扩展名 - 编译/压缩/二进制文件
    const skipExtensions = /\.(min\.js|umd\.cjs|bundle\.js|dist\.js|prod\.js|map|wasm|exe|dll|so|dylib|bin|zip|tar|gz|rar|7z|jar|war|ear|pdf|doc|docx|xls|xlsx|ppt|pptx|jpg|jpeg|png|gif|bmp|ico|mp3|mp4|avi|mov|wmv|flv|webm|mkv|ttf|woff|woff2|eot|otf)$/i;
    if (skipExtensions.test(filePath)) {
      return {
        shouldSkip: true,
        reason: '⚠️ 检测到编译/打包/二进制文件，diff已跳过显示。\n\n提示：这类文件通常是自动生成的或二进制文件，不适合查看diff。\n如需查看，请使用命令行。'
      };
    }
    
    // 2. 使用 --numstat 快速检查变更量（不获取实际内容，速度快）
    try {
      const numstatCommand = diffCommand.replace(/git (diff|show)/, 'git $1 --numstat');
      const { stdout: numstat } = await execGitCommand(numstatCommand, { log: false });
      
      if (numstat.trim()) {
        const lines = numstat.trim().split('\n');
        for (const line of lines) {
          const parts = line.split('\t');
          if (parts.length >= 3) {
            const added = parts[0];
            const deleted = parts[1];
            
            // 检查是否是二进制文件（显示为 - -）
            if (added === '-' && deleted === '-') {
              return {
                shouldSkip: true,
                reason: '⚠️ 检测到二进制文件，diff已跳过显示。\n\n提示：二进制文件无法以文本形式显示diff。'
              };
            }
            
            // 检查变更行数是否过多（超过3000行）
            const totalChanges = parseInt(added) + parseInt(deleted);
            if (!isNaN(totalChanges) && totalChanges > 3000) {
              return {
                shouldSkip: true,
                reason: `⚠️ 变更内容过大 (${totalChanges.toLocaleString()} 行变更)，diff已跳过显示以避免浏览器卡顿。\n\n提示：建议使用命令行或专业diff工具查看大文件变更。\n增加：${parseInt(added).toLocaleString()} 行\n删除：${parseInt(deleted).toLocaleString()} 行`,
                stats: { added: parseInt(added), deleted: parseInt(deleted), total: totalChanges }
              };
            }
          }
        }
      }
    } catch (error) {
      // numstat失败不影响后续流程
      console.log('numstat检查失败，继续执行:', error.message);
    }
    
    // 3. 通过了初步检查
    return { shouldSkip: false };
  }
  
  /**
   * 检查diff内容大小，如果过大则跳过
   * @param {string} diffContent - diff内容
   * @param {number} maxSizeKB - 最大大小（KB），默认500KB
   * @returns {object|null} - 如果需要跳过返回提示对象，否则返回null
   */
  function checkDiffSize(diffContent, maxSizeKB = 500) {
    const diffSizeKB = Buffer.byteLength(diffContent, 'utf8') / 1024;
    if (diffSizeKB > maxSizeKB) {
      return {
        diff: `⚠️ Diff内容过大 (${diffSizeKB.toFixed(1)} KB)，已跳过显示以避免浏览器卡顿。\n\n提示：建议使用命令行查看大文件diff。`,
        isLargeFile: true,
        size: diffSizeKB
      };
    }
    return null;
  }
  
  /**
   * 从 diff 内容中统计增加和删除行数
   * @param {string} diffContent - diff内容
   * @returns {object} - {added, deleted}
   */
  function getDiffStats(diffContent) {
    if (!diffContent) return { added: 0, deleted: 0 };
    
    const lines = diffContent.split('\n');
    let added = 0;
    let deleted = 0;
    
    for (const line of lines) {
      // 跳过diff头部信息
      if (line.startsWith('diff ') || line.startsWith('index ') || 
          line.startsWith('--- ') || line.startsWith('+++ ') || 
          line.startsWith('@@ ')) {
        continue;
      }
      
      // 统计增加和删除的行
      if (line.startsWith('+')) {
        added++;
      } else if (line.startsWith('-')) {
        deleted++;
      }
    }
    
    return { added, deleted };
  }
  
  // 获取文件差异
  app.get('/api/diff', async (req, res) => {
    try {
      const filePath = req.query.file;
      
      if (!filePath) {
        return res.status(400).json({ error: '缺少文件路径参数' });
      }
      
      const diffCommand = `git diff -- "${filePath}"`;
      
      // 使用优化的检查函数
      const skipCheck = await checkShouldSkipDiff(filePath, diffCommand);
      if (skipCheck.shouldSkip) {
        return res.json({ 
          diff: skipCheck.reason,
          isLargeFile: true,
          stats: skipCheck.stats
        });
      }
      
      // 执行git diff命令获取文件差异
      const { stdout } = await execGitCommand(diffCommand);
      
      // 检查实际diff大小
      const sizeCheck = checkDiffSize(stdout, 500);
      if (sizeCheck) {
        return res.json(sizeCheck);
      }
      
      // 统计增加和删除行数
      const stats = getDiffStats(stdout);
      
      res.json({ diff: stdout, stats });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  // 获取已暂存文件差异
  app.get('/api/diff-cached', async (req, res) => {
    try {
      const filePath = req.query.file;
      
      if (!filePath) {
        return res.status(400).json({ error: '缺少文件路径参数' });
      }
      
      const diffCommand = `git diff --cached -- "${filePath}"`;
      
      // 使用优化的检查函数
      const skipCheck = await checkShouldSkipDiff(filePath, diffCommand);
      if (skipCheck.shouldSkip) {
        return res.json({ 
          diff: skipCheck.reason,
          isLargeFile: true,
          stats: skipCheck.stats
        });
      }
      
      // 执行git diff --cached命令获取已暂存文件差异
      const { stdout } = await execGitCommand(diffCommand);
      
      // 检查实际diff大小
      const sizeCheck = checkDiffSize(stdout, 500);
      if (sizeCheck) {
        return res.json(sizeCheck);
      }
      
      // 统计增加和删除行数
      const stats = getDiffStats(stdout);
      
      res.json({ diff: stdout, stats });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  
  // 获取文件内容 (用于未跟踪文件)
  app.get('/api/file-content', async (req, res) => {
    try {
      const filePath = req.query.file;
      
      if (!filePath) {
        return res.status(400).json({ error: '缺少文件路径参数' });
      }
      
      try {
        // 读取文件内容
        const content = await fs.readFile(filePath, 'utf8');
        res.json({ success: true, content });
      } catch (readError) {
        res.status(500).json({ success: false, error: `无法读取文件: ${readError.message}` });
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  
  // 解决冲突：保存解决后的文件内容
  app.post('/api/resolve-conflict', async (req, res) => {
    try {
      const { filePath, content } = req.body;
      
      if (!filePath) {
        return res.status(400).json({ 
          success: false, 
          error: '缺少文件路径参数' 
        });
      }
      
      if (content === undefined) {
        return res.status(400).json({ 
          success: false, 
          error: '缺少文件内容参数' 
        });
      }
      
      try {
        // 写入解决后的内容到文件
        await fs.writeFile(filePath, content, 'utf8');
        
        // 不自动添加到暂存区，让用户手动决定
        // Git 会自动将冲突已解决的文件标记为"已修改"状态
        // await execGitCommand(`git add "${filePath}"`);
        
        res.json({ 
          success: true, 
          message: '冲突已解决，文件已更新' 
        });
      } catch (writeError) {
        res.status(500).json({ 
          success: false, 
          error: `保存文件失败: ${writeError.message}` 
        });
      }
    } catch (error) {
      console.error('解决冲突失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `解决冲突失败: ${error.message}` 
      });
    }
  });
  
  // 撤回文件修改
  app.post('/api/revert_file', async (req, res) => {
    try {
      const { filePath } = req.body;
      
      if (!filePath) {
        return res.status(400).json({ 
          success: false, 
          error: '缺少文件路径参数' 
        });
      }
      
      // 检查文件状态：未跟踪文件需要删除，修改文件需要恢复
      const { stdout: statusOutput } = await execGitCommand(`git status --porcelain -- "${filePath}"`);
      
      // 未跟踪的文件 (??), 需要删除它
      if (statusOutput.startsWith('??')) {
        try {
          await fs.unlink(filePath);
          return res.json({ success: true, message: '未跟踪的文件已删除' });
        } catch (error) {
          return res.status(500).json({ 
            success: false, 
            error: `删除文件失败: ${error.message}` 
          });
        }
      } 
      // 已暂存的文件，先取消暂存
      else if (statusOutput.startsWith('A ') || statusOutput.startsWith('M ') || statusOutput.startsWith('D ')) {
        // 先取消暂存
        await execGitCommand(`git reset HEAD -- "${filePath}"`);
      }
      
      // 已修改文件，取消所有本地修改
      if (statusOutput) {
        await execGitCommand(`git checkout -- "${filePath}"`);
        return res.json({ success: true, message: '文件修改已撤回' });
      } else {
        return res.status(400).json({ 
          success: false, 
          error: '文件没有修改或不存在' 
        });
      }
    } catch (error) {
      console.error('撤回文件修改失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `撤回文件修改失败: ${error.message}` 
      });
    }
  });
  
  // 重置暂存区 (git reset HEAD)
  app.post('/api/reset-head', async (req, res) => {
    try {
      // 执行 git reset HEAD 命令
      await execGitCommand('git reset HEAD');
      res.json({ success: true });
    } catch (error) {
      console.error('重置暂存区失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `重置暂存区失败: ${error.message}` 
      });
    }
  });
  
  // 重置到远程分支 (git reset --hard origin/branch)
  app.post('/api/reset-to-remote', async (req, res) => {
    try {
      const { branch } = req.body;
      
      if (!branch) {
        return res.status(400).json({ 
          success: false, 
          error: '缺少分支名称参数' 
        });
      }
      
      // 执行 git reset --hard origin/branch 命令
      await execGitCommand(`git reset --hard origin/${branch}`);
      res.json({ success: true });
    } catch (error) {
      console.error('重置到远程分支失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `重置到远程分支失败: ${error.message}` 
      });
    }
  });
  
  // 获取提交的文件列表
  app.get('/api/commit-files', async (req, res) => {
    try {
      const hash = req.query.hash;
      
      if (!hash) {
        return res.status(400).json({ 
          success: false, 
          error: '缺少提交哈希参数' 
        });
      }
      
      console.log(`获取提交文件列表: hash=${hash}`);
      
      // 执行命令获取提交中修改的文件列表
      const { stdout } = await execGitCommand(`git show --name-only --format="" ${hash}`);
      
      // 将输出按行分割，并过滤掉空行
      const files = stdout.split('\n').filter(line => line.trim());
      console.log(`找到${files.length}个文件:`, files);
      
      res.json({ 
        success: true, 
        files 
      });
    } catch (error) {
      console.error('获取提交文件列表失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `获取提交文件列表失败: ${error.message}` 
      });
    }
  });
  
  // 获取提交中特定文件的差异
  app.get('/api/commit-file-diff', async (req, res) => {
    try {
      const hash = req.query.hash;
      const filePath = req.query.file;
      
      if (!hash || !filePath) {
        return res.status(400).json({ 
          success: false, 
          error: '缺少必要参数' 
        });
      }
      
      console.log(`获取提交文件差异: hash=${hash}, file=${filePath}`);
      
      const diffCommand = `git show ${hash} -- "${filePath}"`;
      
      // 使用优化的检查函数
      const skipCheck = await checkShouldSkipDiff(filePath, diffCommand);
      if (skipCheck.shouldSkip) {
        return res.json({ 
          success: true,
          diff: skipCheck.reason,
          isLargeFile: true,
          stats: skipCheck.stats
        });
      }
      
      // 执行命令获取文件差异
      const { stdout } = await execGitCommand(diffCommand);
      
      console.log(`获取到差异内容，长度: ${stdout.length}`);
      
      // 检查实际diff大小
      const sizeCheck = checkDiffSize(stdout, 500);
      if (sizeCheck) {
        return res.json({ 
          success: true, 
          ...sizeCheck 
        });
      }
      
      // 统计增加和删除行数
      const stats = getDiffStats(stdout);
      
      res.json({ 
        success: true, 
        diff: stdout,
        stats
      });
    } catch (error) {
      console.error('获取提交文件差异失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `获取提交文件差异失败: ${error.message}` 
      });
    }
  });
  
  // 撤销某个提交 (revert)
  app.post('/api/revert-commit', async (req, res) => {
    try {
      const { hash } = req.body;
      
      if (!hash) {
        return res.status(400).json({ 
          success: false, 
          error: '缺少提交哈希参数' 
        });
      }
      
      console.log(`执行撤销提交操作: hash=${hash}`);
      
      // 执行git revert命令
      await execGitCommand(`git revert --no-edit ${hash}`);
      
      res.json({ 
        success: true, 
        message: `已成功撤销提交 ${hash}` 
      });
    } catch (error) {
      console.error('撤销提交失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `撤销提交失败: ${error.message}` 
      });
    }
  });
  
  // Cherry-pick某个提交
  app.post('/api/cherry-pick-commit', async (req, res) => {
    try {
      const { hash } = req.body;
      
      if (!hash) {
        return res.status(400).json({ 
          success: false, 
          error: '缺少提交哈希参数' 
        });
      }
      
      console.log(`执行Cherry-pick操作: hash=${hash}`);
      
      // 执行git cherry-pick命令
      await execGitCommand(`git cherry-pick ${hash}`);
      
      res.json({ 
        success: true, 
        message: `已成功Cherry-pick提交 ${hash}` 
      });
    } catch (error) {
      console.error('Cherry-pick提交失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `Cherry-pick提交失败: ${error.message}` 
      });
    }
  });
  
  // 重置到指定提交(hard)
  app.post('/api/reset-to-commit', async (req, res) => {
    try {
      const { hash } = req.body;
      
      if (!hash) {
        return res.status(400).json({ 
          success: false, 
          error: '缺少提交哈希参数' 
        });
      }
      
      console.log(`执行重置到指定提交操作: hash=${hash}`);
      
      // 执行git reset --hard命令
      await execGitCommand(`git reset --hard ${hash}`);
      
      res.json({ 
        success: true, 
        message: `已成功重置到提交 ${hash}` 
      });
    } catch (error) {
      console.error('重置到指定提交失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `重置到指定提交失败: ${error.message}` 
      });
    }
  });
  
  // 添加清理Git锁定文件的接口
  app.post('/api/remove-lock', async (req, res) => {
    try {
      const gitDir = path.join(process.cwd(), '.git')
      const indexLockFile = path.join(gitDir, 'index.lock')
      
      // 检查文件是否存在
      try {
        await fs.access(indexLockFile)
        // 如果文件存在，尝试删除它
        await fs.unlink(indexLockFile)
        res.json({ success: true, message: '已清理锁定文件' })
      } catch (error) {
        // 如果文件不存在，也返回成功
        if (error.code === 'ENOENT') {
          res.json({ success: true, message: '没有发现锁定文件' })
        } else {
          throw error
        }
      }
    } catch (error) {
      console.error('清理锁定文件失败:', error)
      res.status(500).json({ 
        success: false, 
        error: `清理锁定文件失败: ${error.message}` 
      })
    }
  })
  
  // 清除Git用户配置
  app.post('/api/clear-user-config', async (req, res) => {
    try {
      // 检查全局配置是否存在，如果存在才删除
      try {
        const { stdout: userName } = await execGitCommand('git config --global user.name');
        if (userName.trim()) {
          await execGitCommand('git config --global --unset user.name');
        }
      } catch (error) {
        console.log('全局用户名配置检查失败，可能不存在:', error.message);
        // 忽略错误继续执行
      }
      
      try {
        const { stdout: userEmail } = await execGitCommand('git config --global user.email');
        if (userEmail.trim()) {
          await execGitCommand('git config --global --unset user.email');
        }
      } catch (error) {
        console.log('全局邮箱配置检查失败，可能不存在:', error.message);
        // 忽略错误继续执行
      }
      
      res.json({ success: true, message: '已清除全局Git用户配置' });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        error: `清除全局Git用户配置失败: ${error.message}` 
      });
    }
  });
  
  // 恢复Git用户配置
  app.post('/api/restore-user-config', async (req, res) => {
    try {
      const { name, email } = req.body;
      if (!name || !email) {
        return res.status(400).json({ 
          success: false, 
          error: '需要提供用户名和邮箱' 
        });
      }
      
      await execGitCommand(`git config --global user.name "${name}"`);
      await execGitCommand(`git config --global user.email "${email}"`);
      res.json({ success: true, message: '已更新全局Git用户配置' });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        error: `更新全局Git用户配置失败: ${error.message}` 
      });
    }
  });
  
  // 获取远程仓库URL的API
  app.get('/api/remote-url', async (req, res) => {
    try {
      // 检查当前目录是否是Git仓库
      if (!isGitRepo) {
        return res.json({ success: false, error: '当前目录不是Git仓库' });
      }
      
      // 执行git命令获取远程仓库URL
      const { stdout } = await execGitCommand('git config --get remote.origin.url');
      
      // 返回远程仓库URL
      res.json({ 
        success: true, 
        url: stdout.trim() 
      });
    } catch (error) {
      console.error('获取远程仓库URL失败:', error);
      res.json({ 
        success: false, 
        error: error.message || '获取远程仓库URL失败' 
      });
    }
  });
  
  // 获取所有作者列表
  app.get('/api/authors', async (req, res) => {
    try {
      // 使用git命令获取所有提交者，不依赖Unix命令
      const { stdout } = await execGitCommand('git log --format="%an"');
      
      // 将结果按行分割并过滤空行
      const lines = stdout.split('\n').filter(author => author.trim() !== '');
      
      // 手动去重，不依赖Unix的uniq命令
      const uniqueAuthors = Array.from(new Set(lines)).sort();
      
      // 控制台输出一下搜索示例，方便调试
      if (uniqueAuthors.length > 1) {
        const searchExample = uniqueAuthors.slice(0, 2).join('|');
        console.log(`多作者搜索示例: git log --author="${searchExample}"`);
      }
      
      res.json({
        success: true,
        authors: uniqueAuthors
      });
    } catch (error) {
      console.error('获取作者列表失败:', error);
      res.status(500).json({
        success: false,
        error: '获取作者列表失败: ' + error.message
      });
    }
  });
  
  // 获取stash列表
  app.get('/api/stash-list', async (req, res) => {
    try {
      const { stdout } = await execGitCommand('git stash list');
      
      // 解析stash列表
      const stashList = stdout.split('\n')
        .filter(Boolean)
        .map(line => {
          // 尝试解析stash行，格式类似: stash@{0}: WIP on branch: commit message
          const match = line.match(/^(stash@\{\d+\}): (.+)$/);
          if (match) {
            return {
              id: match[1],
              description: match[2]
            };
          }
          return null;
        })
        .filter(item => item !== null);
      
      res.json({ success: true, stashes: stashList });
    } catch (error) {
      console.error('获取stash列表失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 创建新的stash
  app.post('/api/stash-save', async (req, res) => {
    try {
      const { message, includeUntracked, excludeLocked } = req.body;

      if (excludeLocked) {
        const lockedFiles = await configManager.getLockedFiles();
        // 包含未跟踪文件，确保状态与 UI 一致
        const { stdout: statusStdout } = await execGitCommand('git status --porcelain --untracked-files=all', { log: false });
        const changedFiles = statusStdout
          .split('\n')
          .filter(line => line.trim())
          .map(line => {
            const match = line.match(/^(..)\s+(.+)$/);
            if (match) {
              const status = match[1];
              let filename = match[2];
              if (filename.startsWith('"') && filename.endsWith('"')) {
                filename = filename.slice(1, -1).replace(/\\(.)/g, '$1');
              }
              return { status, filename };
            }
            return null;
          })
          .filter(Boolean);

        const path = (await import('path')).default;
        const fs = (await import('fs')).default;
        
        // 过滤出未锁定且需要包含在 stash 中的路径
        // 修复：当 includeUntracked === true 且变更项是“新目录”时，不能直接把目录作为 pathspec
        // 否则会把目录里的“锁定文件”一起打入 stash。这里将目录展开为具体文件，并逐个过滤锁定路径。
        const filesToStashSet = new Set();
        for (const item of changedFiles) {
          const { status, filename } = item;
          const normalizedFile = path.normalize(filename);
          
          // 检查是否被锁定
          const isLocked = lockedFiles.some(locked => {
            const normalizedLocked = path.normalize(locked);
            return normalizedFile === normalizedLocked || normalizedFile.startsWith(normalizedLocked + path.sep);
          });
          
          if (!isLocked) {
            try {
              const fullPath = path.resolve(filename);
              const stats = fs.statSync(fullPath);
              // 1) 已存在的普通文件：直接加入
              if (stats.isFile()) {
                filesToStashSet.add(filename);
              } else if (stats.isDirectory()) {
                // 2) 目录：当勾选了 includeUntracked 时，展开目录下的文件（包含未跟踪和已跟踪修改）
                if (includeUntracked) {
                  try {
                    // 使用 git 列出该目录下的未跟踪和已修改文件
                    const { stdout: listStdout } = await execGitCommand(`git ls-files -mo --exclude-standard "${filename}"`, { log: false });
                    const listed = listStdout
                      .split('\n')
                      .map(l => l.trim())
                      .filter(Boolean)
                      // 仅保留该目录下的条目
                      .filter(p => {
                        const n = path.normalize(p);
                        const base = path.normalize(filename);
                        return n === base || n.startsWith(base + path.sep);
                      });
                    for (const p of listed) {
                      const n = path.normalize(p);
                      const locked = lockedFiles.some(locked => {
                        const nl = path.normalize(locked);
                        return n === nl || n.startsWith(nl + path.sep);
                      });
                      if (!locked) {
                        filesToStashSet.add(p);
                      }
                    }
                  } catch (_) {
                    // 如果 git 列举失败，退化为不处理该目录
                  }
                }
              }
            } catch (error) {
              // 3) 文件系统不可达的情况
              // 对于已删除的文件（D状态），我们仍然需要包含它们
              if (status.includes('D')) {
                filesToStashSet.add(filename);
              }
              // 其他情况（如路径不存在且不是删除状态）则跳过
            }
          }
        }

        let filesToStash = Array.from(filesToStashSet);
        if (filesToStash.length === 0) {
          return res.json({ success: false, message: '所有更改都是锁定文件，无需储藏' });
        }

        // 在执行 stash 前进行候选校验：
        // 1) 仍有跟踪差异的文件
        try {
          const args = filesToStash.map(f => `"${f}"`).join(' ');
          const { stdout: diffNames } = await execGitCommand(`git diff --name-only -- ${args}`, { log: false });
          const trackedChanged = new Set(diffNames.split('\n').map(s => s.trim()).filter(Boolean));

          // 2) 仍为未跟踪的文件（当 includeUntracked 才检查）
          let untrackedExisting = new Set();
          if (includeUntracked) {
            const { stdout: others } = await execGitCommand(`git ls-files --others --exclude-standard -- ${args}`, { log: false });
            untrackedExisting = new Set(others.split('\n').map(s => s.trim()).filter(Boolean));
          }

          // 合并有效集合
          const validSet = new Set();
          for (const f of filesToStash) {
            if (trackedChanged.has(f) || untrackedExisting.has(f)) {
              validSet.add(f);
            }
          }

          filesToStash = Array.from(validSet);
        } catch (e) {
          // 校验失败不应中断主流程，保守继续使用原集合
          console.warn('候选文件有效性校验失败（将继续尝试储藏）:', e?.message || e);
        }

        if (filesToStash.length === 0) {
          return res.json({ success: false, message: '没有可储藏的更改（可能刚刚已储藏，或被锁定过滤）' });
        }

        let command = 'git stash push';
        if (message) command += ` -m "${message}"`;
        if (includeUntracked) command += ' --include-untracked';
        const args = filesToStash.map(f => `"${f}"`).join(' ');
        command += ` -- ${args}`;

        const { stdout } = await execGitCommand(command);
        if (stdout.includes('No local changes to save')) {
          return res.json({ success: false, message: '没有本地更改需要保存' });
        }
        return res.json({ success: true, message: '成功保存未锁定的工作区更改', output: stdout });
      }

      let command = 'git stash push';
      if (message) {
        command += ` -m "${message}"`;
      }
      if (includeUntracked) {
        command += ' --include-untracked';
      }
      const { stdout } = await execGitCommand(command);
      if (stdout.includes('No local changes to save')) {
        return res.json({ success: false, message: '没有本地更改需要保存' });
      }
      res.json({ success: true, message: '成功保存工作区更改', output: stdout });
    } catch (error) {
      // 友好处理：当 Git 返回 "No valid patches in input" 时，提示无可储藏更改
      const msg = error?.message || '';
      if (msg.includes('No valid patches in input')) {
        return res.json({ success: false, message: '没有可储藏的更改（可能刚刚已储藏，或被锁定过滤）' });
      }
      console.error('保存stash失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 保存部分文件的stash
  app.post('/api/stash-save-partial', async (req, res) => {
    try {
      const { files, message, includeUntracked } = req.body;

      if (!files || !Array.isArray(files) || files.length === 0) {
        return res.json({ success: false, message: '请选择要储藏的文件' });
      }

      // 构建 git stash push 命令
      let command = 'git stash push';
      if (message) {
        command += ` -m "${message}"`;
      }
      if (includeUntracked) {
        command += ' --include-untracked';
      }

      // 添加文件列表
      const args = files.map(f => `"${f}"`).join(' ');
      command += ` -- ${args}`;

      const { stdout } = await execGitCommand(command);
      
      if (stdout.includes('No local changes to save')) {
        return res.json({ success: false, message: '没有本地更改需要保存' });
      }

      res.json({ 
        success: true, 
        message: `成功储藏 ${files.length} 个文件`, 
        output: stdout 
      });
    } catch (error) {
      const msg = error?.message || '';
      if (msg.includes('No valid patches in input')) {
        return res.json({ success: false, message: '没有可储藏的更改' });
      }
      console.error('保存部分stash失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 应用特定的stash
  app.post('/api/stash-apply', async (req, res) => {
    try {
      const { stashId, pop } = req.body;
      
      if (!stashId) {
        return res.status(400).json({ 
          success: false, 
          error: '缺少stash ID参数' 
        });
      }
      
      // 决定是使用apply(保留stash)还是pop(应用后删除stash)
      const command = pop ? `git stash pop ${stashId}` : `git stash apply ${stashId}`;
      
      try {
        const { stdout } = await execGitCommand(command);
        
        res.json({ 
          success: true, 
          message: `成功${pop ? '应用并删除' : '应用'}stash`,
          output: stdout 
        });
      } catch (error) {
        // 检查是否有合并冲突
        if (error.message && error.message.includes('CONFLICT')) {
          return res.status(409).json({
            success: false,
            hasConflicts: true,
            error: '应用stash时发生冲突，需要手动解决',
            details: error.message
          });
        }
        throw error;
      }
    } catch (error) {
      console.error('应用stash失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 删除特定的stash
  app.post('/api/stash-drop', async (req, res) => {
    try {
      const { stashId } = req.body;
      
      if (!stashId) {
        return res.status(400).json({ 
          success: false, 
          error: '缺少stash ID参数' 
        });
      }
      
      const { stdout } = await execGitCommand(`git stash drop ${stashId}`);
      
      res.json({ 
        success: true, 
        message: '成功删除stash',
        output: stdout 
      });
    } catch (error) {
      console.error('删除stash失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 清空所有stash
  app.post('/api/stash-clear', async (req, res) => {
    try {
      const { stdout } = await execGitCommand('git stash clear');
      
      res.json({ 
        success: true, 
        message: '成功清空所有stash',
        output: stdout 
      });
    } catch (error) {
      console.error('清空stash失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 获取stash中的文件列表（包含未跟踪文件）
  app.get('/api/stash-files', async (req, res) => {
    try {
      const { stashId } = req.query;
      
      if (!stashId) {
        return res.status(400).json({
          success: false,
          error: '缺少stash ID参数'
        });
      }
      
      console.log(`获取stash文件列表: stashId=${stashId}`);
      
      // 0) 解析出当前 stash 提交及其父提交哈希，避免在 Windows 上使用 ^ 语法
      const { stdout: parentsLine } = await execGitCommand(`git rev-list --parents -n 1 ${stashId}`, { log: false });
      const hashes = parentsLine.trim().split(/\s+/).filter(Boolean);
      const stashCommit = hashes[0] || '';
      const parent1 = hashes[1] || '';
      const parent3 = hashes[3] || ''; // 当包含未跟踪文件时，第三父才存在

      // 1) 跟踪文件的变更列表：父1 与 stash 提交的差异（若无父1则为空）
      let trackedFiles = [];
      if (parent1) {
        const { stdout: trackedOut } = await execGitCommand(`git diff --name-only ${parent1} ${stashCommit}`, { log: false });
        trackedFiles = trackedOut.split('\n').map(s => s.trim()).filter(Boolean);
      }

      // 2) 未跟踪文件：来自第三父（若存在）
      let untrackedFiles = [];
      if (parent3) {
        const { stdout: untrackedOut } = await execGitCommand(`git ls-tree -r --name-only ${parent3}`, { log: false });
        untrackedFiles = untrackedOut.split('\n').map(s => s.trim()).filter(Boolean);
      }

      // 合并并去重
      const fileSet = new Set([ ...trackedFiles, ...untrackedFiles ]);
      const files = Array.from(fileSet);
      console.log(`找到${files.length}个stash文件(含未跟踪):`, files);
      
      res.json({ 
        success: true, 
        files 
      });
    } catch (error) {
      console.error('获取stash文件列表失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `获取stash文件列表失败: ${error.message}` 
      });
    }
  });

  // 获取stash中特定文件的差异（包含未跟踪文件）
  app.get('/api/stash-file-diff', async (req, res) => {
    try {
      const { stashId, file } = req.query;
      
      if (!stashId || !file) {
        return res.status(400).json({
          success: false,
          error: '缺少必要参数'
        });
      }
      
      console.log(`获取stash文件差异: stashId=${stashId}, file=${file}`);

      // 先解析父提交哈希，避免使用 ^ 语法
      const { stdout: parentsLine } = await execGitCommand(`git rev-list --parents -n 1 ${stashId}`, { log: false });
      const hashes = parentsLine.trim().split(/\s+/).filter(Boolean);
      const stashCommit = hashes[0] || '';
      const parent1 = hashes[1] || '';
      const parent3 = hashes[3] || '';

      // 检查该文件是否来自第三父(未跟踪文件)
      let isFromThirdParent = false;
      if (parent3) {
        try {
          await execGitCommand(`git cat-file -e ${parent3}:"${file}"`, { log: false });
          isFromThirdParent = true;
        } catch (_) {
          isFromThirdParent = false;
        }
      }

      if (isFromThirdParent) {
        // 未跟踪文件：读取第三父中的内容，构造新增文件的统一diff
        const { stdout: blob } = await execGitCommand(`git show ${parent3}:"${file}"`, { log: false });
        
        // 检查文件大小
        const sizeCheck = checkDiffSize(blob, 500);
        if (sizeCheck) {
          return res.json({ success: true, ...sizeCheck });
        }
        
        const lines = blob.endsWith('\n') ? blob.slice(0, -1).split('\n') : blob.split('\n');
        const lineCount = lines.length;
        
        // 检查行数
        if (lineCount > 10000) {
          return res.json({
            success: true,
            diff: `⚠️ 变更内容过大 (${lineCount.toLocaleString()} 行)，diff已跳过显示以避免浏览器卡顿。\n\n提示：建议使用命令行查看大文件变更。`,
            isLargeFile: true,
            stats: { added: lineCount, deleted: 0, total: lineCount }
          });
        }
        
        const plusLines = lines.map(l => `+${l}`).join('\n');
        const diffText = [
          `diff --git a/${file} b/${file}`,
          `new file mode 100644`,
          `--- /dev/null`,
          `+++ b/${file}`,
          `@@ -0,0 +${lineCount} @@`,
          `${plusLines}`
        ].join('\n');

        return res.json({ success: true, diff: diffText });
      }

      // 否则，使用原有方式获取与父1的变更
      const diffCommand = `git show ${stashCommit} -- "${file}"`;
      
      // 使用优化的检查函数
      const skipCheck = await checkShouldSkipDiff(file, diffCommand);
      if (skipCheck.shouldSkip) {
        return res.json({ 
          success: true,
          diff: skipCheck.reason,
          isLargeFile: true,
          stats: skipCheck.stats
        });
      }
      
      const { stdout } = await execGitCommand(diffCommand);
      
      console.log(`获取到差异内容，长度: ${stdout.length}`);
      
      // 检查实际diff大小
      const sizeCheck = checkDiffSize(stdout, 500);
      if (sizeCheck) {
        return res.json({ success: true, ...sizeCheck });
      }
      
      // 统计增加和删除行数
      const stats = getDiffStats(stdout);
      
      res.json({ success: true, diff: stdout, stats });
    } catch (error) {
      console.error('获取stash文件差异失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `获取stash文件差异失败: ${error.message}` 
      });
    }
  });

  
  // ========== 文件锁定相关 API ==========

  // 获取锁定文件列表
  app.get('/api/locked-files', async (req, res) => {
    try {
      const lockedFiles = await configManager.getLockedFiles();
      res.json({ success: true, lockedFiles });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ============ Git Tag 相关接口 ============

  // 创建标签
  app.post('/api/create-tag', async (req, res) => {
    try {
      const { tagName, message, type, commit } = req.body;
      
      if (!tagName) {
        return res.status(400).json({ success: false, error: '缺少标签名称' });
      }

      let command = 'git tag';
      
      if (type === 'annotated') {
        // 附注标签
        if (!message) {
          return res.status(400).json({ success: false, error: '附注标签需要提供说明信息' });
        }
        command += ` -a "${tagName}" -m "${message}"`;
      } else {
        // 轻量标签
        command += ` "${tagName}"`;
      }

      // 如果指定了commit，添加到命令中
      if (commit && commit.trim()) {
        command += ` ${commit.trim()}`;
      }

      const { stdout } = await execGitCommand(command);
      
      res.json({ 
        success: true, 
        message: '标签创建成功',
        output: stdout 
      });
    } catch (error) {
      console.error('创建标签失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 获取标签列表
  app.get('/api/list-tags', async (req, res) => {
    try {
      // 使用 git tag -n --format 获取详细信息
      const { stdout } = await execGitCommand(
        'git tag -n --format="%(refname:short)|%(objectname:short)|%(creatordate:iso8601)|%(subject)"'
      );

      if (!stdout.trim()) {
        return res.json({ success: true, tags: [] });
      }

      const tags = stdout.trim().split('\n').map(line => {
        const [name, commit, date, message] = line.split('|');
        return {
          name: name || '',
          commit: commit || '',
          date: date || '',
          message: message || '',
          type: 'lightweight' // 默认为轻量标签
        };
      });

      // 检测哪些是附注标签
      for (const tag of tags) {
        try {
          const { stdout: typeCheck } = await execGitCommand(
            `git cat-file -t ${tag.name}`,
            { log: false }
          );
          if (typeCheck.trim() === 'tag') {
            tag.type = 'annotated';
          }
        } catch (error) {
          // 忽略错误，保持默认值
        }
      }

      res.json({ success: true, tags });
    } catch (error) {
      console.error('获取标签列表失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 推送标签到远程
  app.post('/api/push-tag', async (req, res) => {
    try {
      const { tagName } = req.body;
      
      if (!tagName) {
        return res.status(400).json({ success: false, error: '缺少标签名称' });
      }

      const { stdout } = await execGitCommand(`git push origin ${tagName}`);
      
      res.json({ 
        success: true, 
        message: '标签推送成功',
        output: stdout 
      });
    } catch (error) {
      console.error('推送标签失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 推送所有标签到远程
  app.post('/api/push-all-tags', async (req, res) => {
    try {
      const { stdout } = await execGitCommand('git push origin --tags');
      
      res.json({ 
        success: true, 
        message: '所有标签推送成功',
        output: stdout 
      });
    } catch (error) {
      console.error('推送所有标签失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 删除标签
  app.post('/api/delete-tag', async (req, res) => {
    try {
      const { tagName } = req.body;
      
      if (!tagName) {
        return res.status(400).json({ success: false, error: '缺少标签名称' });
      }

      const { stdout } = await execGitCommand(`git tag -d ${tagName}`);
      
      res.json({ 
        success: true, 
        message: '标签删除成功',
        output: stdout 
      });
    } catch (error) {
      console.error('删除标签失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 锁定文件
  app.post('/api/lock-file', async (req, res) => {
    try {
      const { filePath } = req.body;
      if (!filePath) {
        return res.status(400).json({ success: false, error: '缺少文件路径参数' });
      }

      const result = await configManager.lockFile(filePath);
      res.json({ success: true, locked: result });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 解锁文件
  app.post('/api/unlock-file', async (req, res) => {
    try {
      const { filePath } = req.body;
      if (!filePath) {
        return res.status(400).json({ success: false, error: '缺少文件路径参数' });
      }

      const result = await configManager.unlockFile(filePath);
      res.json({ success: true, unlocked: result });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 检查文件是否锁定
  app.post('/api/check-file-lock', async (req, res) => {
    try {
      const { filePath } = req.body;
      if (!filePath) {
        return res.status(400).json({ success: false, error: '缺少文件路径参数' });
      }

      const isLocked = await configManager.isFileLocked(filePath);
      res.json({ success: true, isLocked });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 添加命令历史的清空API
  app.post('/api/clear-command-history', async (req, res) => {
    try {
      const result = clearCommandHistory();
      res.json({ success: result });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // ========== NPM 脚本管理相关 API ==========
  
  // 存储正在进行的扫描任务
  let currentScanAbortController = null;
  
  // 扫描项目目录及子目录下的所有package.json，并提取scripts
  app.get('/api/scan-npm-scripts', async (req, res) => {
    // 取消之前的扫描
    if (currentScanAbortController) {
      currentScanAbortController.aborted = true;
    }
    
    // 创建新的abort controller
    currentScanAbortController = { 
      aborted: false,
      abort() { this.aborted = true; }
    };
    const scanController = currentScanAbortController;
    try {
      const projectRoot = process.cwd();
      const packageJsons = [];
      const startTime = Date.now();
      
      // console.log(`[NPM扫描-后端] 开始扫描项目: ${projectRoot}`);
      
      // 需要忽略的目录列表（更全面）
      const IGNORED_DIRS = new Set([
        'node_modules',
        '.git',
        '.svn',
        '.hg',
        'dist',
        'build',
        'coverage',
        'out',
        'target',
        'vendor',
        '__pycache__',
        '.next',
        '.nuxt',
        '.vscode',
        '.idea',
        'tmp',
        'temp',
        'cache',
        '.cache'
      ]);
      
      // 优先扫描的子目录（monorepo常见结构）
      const PRIORITY_DIRS = ['packages', 'apps', 'libs', 'services', 'modules'];
      
      let scannedCount = 0;
      let skippedCount = 0;
      let fileReadCount = 0; // 统计实际读取的文件数量
      
      // 检查指定目录下是否有package.json
      async function checkPackageJson(dir) {
        if (scanController.aborted) return false;
        
        try {
          const packagePath = path.join(dir, 'package.json');
          
          // 先检查文件是否存在，避免不必要的读取
          try {
            await fs.access(packagePath);
          } catch {
            // 文件不存在，直接返回
            return false;
          }
          
          // 检查文件大小，避免读取异常大的文件
          const stats = await fs.stat(packagePath);
          const fileSizeMB = stats.size / (1024 * 1024);
          if (fileSizeMB > 1) {
            // package.json超过1MB是异常情况，跳过
            console.log(`[NPM扫描] 跳过超大文件 (${fileSizeMB.toFixed(2)}MB): ${packagePath}`);
            return false;
          }
          
          fileReadCount++; // 只有文件存在且大小合理时才计数
          const content = await fs.readFile(packagePath, 'utf8');
          const packageData = JSON.parse(content);
          
          // 只有当scripts存在且至少有一个脚本时才添加
          if (packageData.scripts && Object.keys(packageData.scripts).length > 0) {
            const relativePath = path.relative(projectRoot, dir);
            packageJsons.push({
              path: dir,
              relativePath: relativePath || '.',
              name: packageData.name || path.basename(dir),
              scripts: packageData.scripts,
              version: packageData.version || '0.0.0',
              repository: packageData.repository
            });
            return true;
          }
        } catch (error) {
          // 文件不存在或解析失败，忽略
        }
        return false;
      }
      
      // 递归扫描目录，最大深度4层
      const MAX_DEPTH = 4;
      const MAX_DIRS_PER_LEVEL = 50; // 每层最多扫描50个子目录
      
      // 统计每层深度的扫描数量
      const depthStats = Array(MAX_DEPTH + 1).fill(0).map(() => ({ count: 0, time: 0 }));
      
      async function scanDirectory(dir, depth = 0) {
        if (scanController.aborted) return;
        if (depth > MAX_DEPTH) return;
        
        const depthStart = Date.now();
        scannedCount++;
        depthStats[depth].count++;
        
        // 检查当前目录的package.json
        await checkPackageJson(dir);
        
        // 如果已经达到最大深度，不再继续
        if (depth >= MAX_DEPTH) return;
        
        // 读取子目录
        try {
          if (scanController.aborted) return;
          
          const items = await fs.readdir(dir, { withFileTypes: true });
          const subDirs = [];
          
          // 收集所有子目录
          for (const item of items) {
            if (scanController.aborted) return;
            if (!item.isDirectory()) continue;
            
            const dirName = item.name;
            
            // 跳过忽略的目录
            if (IGNORED_DIRS.has(dirName) || dirName.startsWith('.')) {
              skippedCount++;
              continue;
            }
            
            subDirs.push(item);
          }
          
          // 限制每层扫描的子目录数量
          const dirsToScan = subDirs.slice(0, MAX_DIRS_PER_LEVEL);
          if (subDirs.length > MAX_DIRS_PER_LEVEL) {
            skippedCount += subDirs.length - MAX_DIRS_PER_LEVEL;
          }
          
          // 优先处理优先目录
          const priorityDirs = dirsToScan.filter(item => PRIORITY_DIRS.includes(item.name));
          const normalDirs = dirsToScan.filter(item => !PRIORITY_DIRS.includes(item.name));
          
          // 先扫描优先目录
          for (const item of priorityDirs) {
            if (scanController.aborted) return;
            const subDirPath = path.join(dir, item.name);
            await scanDirectory(subDirPath, depth + 1);
          }
          
          // 再扫描普通目录
          for (const item of normalDirs) {
            if (scanController.aborted) return;
            const subDirPath = path.join(dir, item.name);
            await scanDirectory(subDirPath, depth + 1);
          }
          
        } catch (error) {
          // 忽略无法访问的目录
        }
        
        // 记录该深度的耗时
        depthStats[depth].time += Date.now() - depthStart;
      }
      
      // 执行递归扫描
      // console.log(`[NPM扫描-后端] 开始递归扫描（最大深度${MAX_DEPTH}层）`);
      const scanStart = Date.now();
      await scanDirectory(projectRoot, 0);
      // console.log(`[NPM扫描-后端] 递归扫描完成，耗时${Date.now() - scanStart}ms`);
      
      // 扫描完成，清除abort controller
      if (currentScanAbortController === scanController) {
        currentScanAbortController = null;
      }
      
      const scanTime = Date.now() - startTime;
      
      if (scanController.aborted) {
        console.log(`npm脚本扫描被取消，耗时${scanTime}ms`);
        return res.json({ 
          success: true, 
          packages: [],
          totalScripts: 0,
          cancelled: true
        });
      }
      
      // 输出每层深度的统计
      const depthInfo = depthStats
        .map((stat, depth) => stat.count > 0 ? `深度${depth}:${stat.count}个(${stat.time}ms)` : null)
        .filter(Boolean)
        .join(', ');
      
      // console.log(`npm脚本扫描完成，耗时${scanTime}ms，扫描了${scannedCount}个目录，读取了${fileReadCount}个package.json文件，跳过${skippedCount}个目录，找到${packageJsons.length}个有效的package.json`);
      // console.log(`[NPM扫描-后端] 深度分布: ${depthInfo}`);
      
      res.json({ 
        success: true, 
        packages: packageJsons,
        totalScripts: packageJsons.reduce((sum, pkg) => sum + Object.keys(pkg.scripts).length, 0)
      });
    } catch (error) {
      console.error('扫描npm脚本失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `扫描npm脚本失败: ${error.message}` 
      });
    }
  });
  
  // 扫描项目目录下的所有package.json文件（用于版本管理）
  app.get('/api/scan-package-files', async (req, res) => {
    try {
      // 支持通过查询参数指定扫描目录，如果没有指定则使用当前工作目录
      const customDirectory = req.query.directory;
      const projectRoot = customDirectory || process.cwd();
      
      // 验证目录是否存在且可访问
      try {
        const stats = await fs.stat(projectRoot);
        if (!stats.isDirectory()) {
          return res.status(400).json({ 
            success: false, 
            error: '指定的路径不是一个有效的目录' 
          });
        }
      } catch (error) {
        return res.status(400).json({ 
          success: false, 
          error: `无法访问指定的目录: ${error.message}` 
        });
      }
      
      const packageFiles = [];
      const startTime = Date.now();
      
      // 需要忽略的目录列表
      const IGNORED_DIRS = new Set([
        'node_modules',
        '.git',
        '.svn',
        '.hg',
        'dist',
        'build',
        'coverage',
        'out',
        'target',
        'vendor',
        '__pycache__',
        '.next',
        '.nuxt',
        '.vscode',
        '.idea',
        'tmp',
        'temp',
        'cache',
        '.cache'
      ]);
      
      let scannedCount = 0;
      let fileReadCount = 0;
      
      // 检查指定目录下是否有package.json
      async function checkPackageJson(dir) {
        try {
          const packagePath = path.join(dir, 'package.json');
          
          // 先检查文件是否存在
          try {
            await fs.access(packagePath);
          } catch {
            return false;
          }
          
          // 检查文件大小
          const stats = await fs.stat(packagePath);
          const fileSizeMB = stats.size / (1024 * 1024);
          if (fileSizeMB > 1) {
            return false;
          }
          
          fileReadCount++;
          const content = await fs.readFile(packagePath, 'utf8');
          const packageData = JSON.parse(content);
          
          // 添加所有有效的package.json文件（不仅仅是有scripts的）
          if (packageData.name || packageData.version) {
            const relativePath = path.relative(projectRoot, dir);
            packageFiles.push({
              path: dir,
              relativePath: relativePath || '.',
              name: packageData.name || path.basename(dir),
              version: packageData.version || '0.0.0',
              displayName: packageData.name ? `${packageData.name} (${packageData.version || '0.0.0'})` : `${path.basename(dir)} (${packageData.version || '0.0.0'})`,
              fullPath: packagePath
            });
            return true;
          }
        } catch (error) {
          // 文件不存在或解析失败，忽略
        }
        return false;
      }
      
      // 递归扫描目录，最大深度4层
      const MAX_DEPTH = 4;
      const MAX_DIRS_PER_LEVEL = 50;
      
      async function scanDirectory(dir, depth = 0) {
        if (depth > MAX_DEPTH) return;
        
        scannedCount++;
        
        // 检查当前目录的package.json
        await checkPackageJson(dir);
        
        // 如果已经达到最大深度，不再继续
        if (depth >= MAX_DEPTH) return;
        
        // 读取子目录
        try {
          const items = await fs.readdir(dir, { withFileTypes: true });
          const subDirs = [];
          
          // 收集所有子目录
          for (const item of items) {
            if (!item.isDirectory()) continue;
            
            const dirName = item.name;
            
            // 跳过忽略的目录
            if (IGNORED_DIRS.has(dirName) || dirName.startsWith('.')) {
              continue;
            }
            
            subDirs.push(item);
          }
          
          // 限制每层扫描的子目录数量
          const dirsToScan = subDirs.slice(0, MAX_DIRS_PER_LEVEL);
          
          // 递归扫描子目录
          for (const item of dirsToScan) {
            const subDirPath = path.join(dir, item.name);
            await scanDirectory(subDirPath, depth + 1);
          }
        } catch (error) {
          // 忽略无法读取的目录
        }
      }
      
      // 开始扫描
      await scanDirectory(projectRoot);
      
      const scanTime = Date.now() - startTime;
      
      res.json({ 
        success: true, 
        packages: packageFiles,
        scanTime,
        scannedCount,
        fileReadCount
      });
    } catch (error) {
      console.error('扫描package.json文件失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `扫描package.json文件失败: ${error.message}` 
      });
    }
  });
  
  // 在新终端中执行npm脚本
  app.post('/api/run-npm-script', async (req, res) => {
    try {
      const { packagePath, scriptName } = req.body;
      
      if (!packagePath || !scriptName) {
        return res.status(400).json({
          success: false,
          error: '缺少必要参数：packagePath 和 scriptName'
        });
      }
      
      console.log(`执行npm脚本: ${scriptName} in ${packagePath}`);
      
      // 根据操作系统选择合适的终端命令
      let terminalCommand;
      const npmCommand = `npm run ${scriptName}`;
      
      if (process.platform === 'win32') {
        // Windows: 使用 start 命令打开新的 cmd 窗口
        // /K 参数表示执行命令后保持窗口打开
        terminalCommand = `start cmd /K "cd /d ${packagePath} && ${npmCommand}"`;
      } else if (process.platform === 'darwin') {
        // macOS: 使用 osascript 打开 Terminal.app
        const script = `tell application "Terminal" to do script "cd ${packagePath} && ${npmCommand}"`;
        terminalCommand = `osascript -e '${script}'`;
      } else {
        // Linux: 尝试常见的终端模拟器
        // 优先使用 gnome-terminal, 然后是 xterm
        terminalCommand = `gnome-terminal -- bash -c "cd ${packagePath} && ${npmCommand}; exec bash" || xterm -e "cd ${packagePath} && ${npmCommand}; bash"`;
      }
      
      // 执行命令打开新终端（使用已导入的 exec）
      exec(terminalCommand, (error, stdout, stderr) => {
        if (error) {
          console.error('打开终端失败:', error);
        }
      });
      
      res.json({ 
        success: true, 
        message: `已在新终端中执行: ${scriptName}`,
        command: npmCommand,
        path: packagePath
      });
    } catch (error) {
      console.error('执行npm脚本失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `执行npm脚本失败: ${error.message}` 
      });
    }
  });

  // API: 更新npm版本号
  app.post('/api/update-npm-version', async (req, res) => {
    try {
      const { packagePath, versionType } = req.body;
      
      if (!packagePath || !versionType) {
        return res.status(400).json({
          success: false,
          error: '缺少必要参数: packagePath, versionType'
        });
      }

      // 确保路径指向package.json文件
      let packageJsonPath = path.resolve(packagePath);
      if (fsSync.existsSync(packageJsonPath) && fsSync.statSync(packageJsonPath).isDirectory()) {
        packageJsonPath = path.join(packageJsonPath, 'package.json');
      }
      
      // 检查文件是否存在
      if (!fsSync.existsSync(packageJsonPath)) {
        return res.status(404).json({
          success: false,
          error: '找不到package.json文件'
        });
      }

      // 读取package.json
      const packageJson = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf8'));
      
      if (!packageJson.version) {
        return res.status(400).json({
          success: false,
          error: 'package.json中没有version字段'
        });
      }

      const oldVersion = packageJson.version;
      const versionParts = oldVersion.split('.').map(Number);
      
      // 根据类型增加版本号
      switch (versionType) {
        case 'major':
          versionParts[0]++;
          versionParts[1] = 0;
          versionParts[2] = 0;
          break;
        case 'minor':
          versionParts[1]++;
          versionParts[2] = 0;
          break;
        case 'patch':
          versionParts[2]++;
          break;
        default:
          return res.status(400).json({
            success: false,
            error: '无效的版本类型，必须是 major, minor 或 patch'
          });
      }

      const newVersion = versionParts.join('.');
      packageJson.version = newVersion;
      
      // 写回文件
      fsSync.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
      
      console.log(`已更新npm版本号: ${oldVersion} → ${newVersion} (${packagePath})`);
      
      res.json({
        success: true,
        oldVersion,
        newVersion
      });
    } catch (error) {
      console.error('更新版本号失败:', error);
      res.status(500).json({
        success: false,
        error: `更新版本号失败: ${error.message}`
      });
    }
  });

  // API: 添加npm脚本
  app.post('/api/add-npm-script', async (req, res) => {
    try {
      const { packagePath, scriptName, scriptCommand } = req.body;
      
      if (!packagePath || !scriptName || !scriptCommand) {
        return res.status(400).json({
          success: false,
          error: '缺少必要参数: packagePath, scriptName, scriptCommand'
        });
      }

      // 确保路径指向package.json文件
      let packageJsonPath = path.resolve(packagePath);
      if (fsSync.existsSync(packageJsonPath) && fsSync.statSync(packageJsonPath).isDirectory()) {
        packageJsonPath = path.join(packageJsonPath, 'package.json');
      }
      
      // 检查文件是否存在
      if (!fsSync.existsSync(packageJsonPath)) {
        return res.status(404).json({
          success: false,
          error: '找不到package.json文件'
        });
      }
      
      // 读取package.json
      const packageJson = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf8'));
      
      // 确保scripts对象存在
      if (!packageJson.scripts) {
        packageJson.scripts = {};
      }
      
      // 检查脚本是否已存在
      if (packageJson.scripts[scriptName]) {
        return res.status(400).json({
          success: false,
          error: `脚本 "${scriptName}" 已存在`
        });
      }
      
      // 添加脚本
      packageJson.scripts[scriptName] = scriptCommand;
      
      // 写回文件（保持格式化）
      fsSync.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
      
      console.log(`已添加npm脚本: ${scriptName} = ${scriptCommand} (${packagePath})`);
      
      res.json({
        success: true,
        scriptName,
        scriptCommand
      });
    } catch (error) {
      console.error('添加npm脚本失败:', error);
      res.status(500).json({
        success: false,
        error: `添加npm脚本失败: ${error.message}`
      });
    }
  });

  // API: 更新npm脚本
  app.post('/api/update-npm-script', async (req, res) => {
    try {
      const { packagePath, scriptName, scriptCommand, oldScriptName } = req.body;
      
      if (!packagePath || !scriptName || !scriptCommand) {
        return res.status(400).json({
          success: false,
          error: '缺少必要参数: packagePath, scriptName, scriptCommand'
        });
      }

      // 确保路径指向package.json文件
      let packageJsonPath = path.resolve(packagePath);
      if (fsSync.existsSync(packageJsonPath) && fsSync.statSync(packageJsonPath).isDirectory()) {
        packageJsonPath = path.join(packageJsonPath, 'package.json');
      }
      
      // 检查文件是否存在
      if (!fsSync.existsSync(packageJsonPath)) {
        return res.status(404).json({
          success: false,
          error: '找不到package.json文件'
        });
      }

      // 读取package.json
      const packageJson = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf8'));
      
      // 确保scripts对象存在
      if (!packageJson.scripts) {
        packageJson.scripts = {};
      }

      // 如果改了脚本名称，删除旧的
      if (oldScriptName && oldScriptName !== scriptName) {
        delete packageJson.scripts[oldScriptName];
      }

      // 更新脚本
      packageJson.scripts[scriptName] = scriptCommand;
      
      // 写回文件
      fsSync.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
      
      console.log(`已更新npm脚本: ${scriptName} = ${scriptCommand} (${packagePath})`);
      
      res.json({
        success: true,
        scriptName,
        scriptCommand
      });
    } catch (error) {
      console.error('更新npm脚本失败:', error);
      res.status(500).json({
        success: false,
        error: `更新npm脚本失败: ${error.message}`
      });
    }
  });

  // API: 删除npm脚本
  app.post('/api/delete-npm-script', async (req, res) => {
    try {
      const { packagePath, scriptName } = req.body;
      
      if (!packagePath || !scriptName) {
        return res.status(400).json({
          success: false,
          error: '缺少必要参数: packagePath, scriptName'
        });
      }

      // 确保路径指向package.json文件
      let packageJsonPath = path.resolve(packagePath);
      if (fsSync.existsSync(packageJsonPath) && fsSync.statSync(packageJsonPath).isDirectory()) {
        packageJsonPath = path.join(packageJsonPath, 'package.json');
      }
      
      // 检查文件是否存在
      if (!fsSync.existsSync(packageJsonPath)) {
        return res.status(404).json({
          success: false,
          error: '找不到package.json文件'
        });
      }

      // 读取package.json
      const packageJson = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf8'));
      
      // 检查scripts对象和脚本是否存在
      if (!packageJson.scripts || !packageJson.scripts[scriptName]) {
        return res.status(404).json({
          success: false,
          error: `脚本 "${scriptName}" 不存在`
        });
      }

      // 删除脚本
      delete packageJson.scripts[scriptName];
      
      // 写回文件
      fsSync.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
      
      console.log(`已删除npm脚本: ${scriptName} (${packagePath})`);
      
      res.json({
        success: true,
        scriptName
      });
    } catch (error) {
      console.error('删除npm脚本失败:', error);
      res.status(500).json({
        success: false,
        error: `删除npm脚本失败: ${error.message}`
      });
    }
  });

  // API: 置顶npm脚本
  app.post('/api/pin-npm-script', async (req, res) => {
    try {
      const { packagePath, scriptName } = req.body;
      
      if (!packagePath || !scriptName) {
        return res.status(400).json({
          success: false,
          error: '缺少必要参数: packagePath, scriptName'
        });
      }

      // 确保路径指向package.json文件
      let packageJsonPath = path.resolve(packagePath);
      if (fsSync.existsSync(packageJsonPath) && fsSync.statSync(packageJsonPath).isDirectory()) {
        packageJsonPath = path.join(packageJsonPath, 'package.json');
      }
      
      // 检查文件是否存在
      if (!fsSync.existsSync(packageJsonPath)) {
        return res.status(404).json({
          success: false,
          error: '找不到package.json文件'
        });
      }

      // 读取package.json
      const packageJson = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf8'));
      
      // 检查scripts对象和脚本是否存在
      if (!packageJson.scripts || !packageJson.scripts[scriptName]) {
        return res.status(404).json({
          success: false,
          error: `脚本 "${scriptName}" 不存在`
        });
      }

      // 保存要置顶的脚本内容
      const scriptCommand = packageJson.scripts[scriptName];
      
      // 删除该脚本
      delete packageJson.scripts[scriptName];
      
      // 创建新的scripts对象，将置顶脚本放在最前面
      const newScripts = {
        [scriptName]: scriptCommand,
        ...packageJson.scripts
      };
      
      packageJson.scripts = newScripts;
      
      // 写回文件
      fsSync.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
      
      console.log(`已置顶npm脚本: ${scriptName} (${packagePath})`);
      
      res.json({
        success: true,
        scriptName
      });
    } catch (error) {
      console.error('置顶npm脚本失败:', error);
      res.status(500).json({
        success: false,
        error: `置顶npm脚本失败: ${error.message}`
      });
    }
  });
  
  // Socket.io 实时更新
  io.on('connection', (socket) => {
    console.log('客户端已连接:', socket.id);
    
    // 客户端连接时加入当前项目的房间
    socket.join(projectRoomId);
    console.log(`客户端 ${socket.id} 已加入房间: ${projectRoomId}`);
    
    // 当客户端连接时，立即发送一次Git状态
    getAndBroadcastStatus();
    
    // 发送当前命令历史
    const history = getCommandHistory();
    socket.emit('initial_command_history', { history });
    
    // 请求完整命令历史
    socket.on('request_full_history', () => {
      const fullHistory = getCommandHistory();
      socket.emit('full_command_history', { history: fullHistory });
    });
    
    // 清空命令历史
    socket.on('clear_command_history', () => {
      const result = clearCommandHistory();
      socket.emit('command_history_cleared', { success: result });
    });
    
    // 交互式命令执行
    socket.on('exec_interactive', async (data) => {
      const { command, directory, sessionId } = data;
      
      if (!command || typeof command !== 'string' || !command.trim()) {
        socket.emit('interactive_error', { 
          sessionId, 
          error: 'command 不能为空' 
        });
        return;
      }

      // 确定执行目录
      const execDirectory = directory && directory.trim() 
        ? (path.isAbsolute(directory) ? directory : path.join(currentProjectPath, directory))
        : currentProjectPath;

      console.log(`[交互式命令] ${sessionId}: ${command} (目录: ${execDirectory})`);

      // 分配进程 ID
      const processId = ++processIdCounter;

      // 记录执行开始时间
      const startTime = Date.now();

      // 用于收集输出（用于命令历史）
      let collectedStdout = '';
      let collectedStderr = '';

      // 使用 spawn 执行命令
      const childProcess = spawn(command.trim(), [], {
        cwd: execDirectory,
        shell: true,
        env: {
          ...process.env,
          // Git 配置：启用颜色输出和禁用路径引用
          GIT_CONFIG_PARAMETERS: "'color.ui=always' 'color.status=always' 'core.quotepath=false'",
          // 强制启用颜色输出 - 多种工具的配置
          FORCE_COLOR: '3', // 使用级别3（最强），支持 chalk 等库
          NPM_CONFIG_COLOR: 'always',
          TERM: 'xterm-256color', // 模拟256色终端环境
          COLORTERM: 'truecolor', // 支持真彩色
          CLICOLOR_FORCE: '1', // 强制启用颜色（某些工具检测此变量）
          // 确保输出不被缓冲（不设置 CI=true，允许交互式输入和颜色输出）
          PYTHONUNBUFFERED: '1'
        }
      });

      // 存储进程信息
      runningProcesses.set(processId, {
        childProcess,
        command: command.trim(),
        startTime,
        directory: execDirectory,
        sessionId
      });

      console.log(`[交互式命令] 创建进程 #${processId}: ${command.substring(0, 50)}`);

      // 发送进程 ID 给客户端
      socket.emit('interactive_process_id', { sessionId, processId });

      // 判断是否需要 GBK 转换
      const isWindows = process.platform === 'win32';
      const cmdBuiltins = ['dir', 'type', 'echo', 'set', 'path', 'cd', 'md', 'rd', 'del', 'copy', 'move', 'ren'];
      const needsGbkConversion = isWindows && cmdBuiltins.some(builtin => 
        command.trim().toLowerCase().startsWith(builtin + ' ') || 
        command.trim().toLowerCase() === builtin
      );

      // 监听标准输出
      childProcess.stdout?.on('data', (data) => {
        let output = needsGbkConversion ? iconv.decode(data, 'gbk') : data.toString('utf8');
        collectedStdout += output;
        socket.emit('interactive_stdout', { sessionId, data: output });
      });

      // 监听标准错误输出
      childProcess.stderr?.on('data', (data) => {
        let output;
        
        if (isWindows) {
          // Windows 平台需要智能检测编码
          // 先尝试 UTF-8 解码
          const utf8Output = data.toString('utf8');
          
          // 检测是否包含 UTF-8 替换字符（�），这通常表示解码失败
          // 如果没有替换字符且包含正常字符，说明是有效的 UTF-8
          if (!utf8Output.includes('�') || utf8Output.match(/[\u4e00-\u9fa5]/)) {
            // UTF-8 解码成功（包含有效中文或没有替换字符）
            output = utf8Output;
          } else {
            // UTF-8 解码失败，尝试 GBK（可能是 CMD shell 的系统消息）
            try {
              output = iconv.decode(data, 'gbk');
            } catch (e) {
              // GBK 也失败，使用原始 UTF-8 结果
              output = utf8Output;
            }
          }
        } else {
          output = data.toString('utf8');
        }
        
        collectedStderr += output;
        socket.emit('interactive_stderr', { sessionId, data: output });
      });

      // 监听进程关闭
      childProcess.on('close', (code, signal) => {
        runningProcesses.delete(processId);
        console.log(`[交互式命令] 进程 #${processId} 已结束`);

        // 计算执行时间
        const executionTime = Date.now() - startTime;

        // 添加到命令历史
        const error = code !== 0 ? `Command exited with code ${code}` : null;
        addCommandToHistory(
          command.trim(),
          collectedStdout,
          collectedStderr,
          error,
          executionTime
        );

        socket.emit('interactive_exit', { 
          sessionId, 
          code, 
          success: code === 0 
        });
      });

      // 监听错误
      childProcess.on('error', (error) => {
        runningProcesses.delete(processId);
        console.error(`[交互式命令] 进程 #${processId} 出错:`, error);

        const executionTime = Date.now() - startTime;
        addCommandToHistory(
          command.trim(),
          collectedStdout,
          collectedStderr,
          error.message,
          executionTime
        );

        socket.emit('interactive_error', { 
          sessionId, 
          error: error.message 
        });
      });

      // 监听来自客户端的 stdin 输入
      socket.on(`interactive_stdin_${sessionId}`, (inputData) => {
        const { input } = inputData;
        console.log(`[交互式命令] 收到 stdin 输入 (${sessionId}):`, input);
        
        if (childProcess.stdin && !childProcess.stdin.destroyed) {
          try {
            childProcess.stdin.write(input + '\n');
          } catch (err) {
            console.error(`[交互式命令] 写入 stdin 失败:`, err);
            socket.emit('interactive_error', { 
              sessionId, 
              error: `写入输入失败: ${err.message}` 
            });
          }
        }
      });

      // 监听停止命令请求
      socket.on(`interactive_stop_${sessionId}`, () => {
        console.log(`[交互式命令] 收到停止请求 (${sessionId})`);
        
        if (childProcess && !childProcess.killed) {
          try {
            if (process.platform === 'win32') {
              // 使用已导入的 exec（ES Module 不支持 require）
              exec(`taskkill /pid ${childProcess.pid} /T /F`, (error) => {
                if (error) {
                  console.error(`[交互式命令] taskkill 失败:`, error);
                }
              });
            } else {
              childProcess.kill('SIGTERM');
              setTimeout(() => {
                if (!childProcess.killed) {
                  childProcess.kill('SIGKILL');
                }
              }, 2000);
            }
          } catch (err) {
            console.error(`[交互式命令] 停止进程失败:`, err);
          }
        }
      });
    });
    
    // 客户端断开连接
    socket.on('disconnect', () => {
      console.log(`客户端已断开连接: ${socket.id} (房间: ${projectRoomId})`);
      // Socket.IO 会自动从房间中移除断开的连接
    });
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
  const savePortToFile = (function() {
    let savedPort = null;
    
    return async function(port) {
      try {
        // 只有当savePort为true且端口没有保存过时才保存端口号
        if (savePort && savedPort !== port) {
          savedPort = port;
          
          // 保存到项目根目录的.port文件
          const portFilePath = path.join(process.cwd(), '.port');
          await fs.writeFile(portFilePath, port.toString(), 'utf8');
          console.log(`端口号 ${port} 已保存到 ${portFilePath}`);
          
          // 同时保存到前端Vite项目的.env.local文件
          try {
            const clientPath = path.join(process.cwd(), 'src', 'ui', 'client');
            const envPath = path.join(clientPath, '.env.local');
            
            // 检查目录是否存在
            await fs.access(clientPath).catch(() => {
              console.log(`客户端目录 ${clientPath} 不存在，跳过环境变量设置`);
              return Promise.reject(new Error('Client directory not found'));
            });
            
            // 写入环境变量
            await fs.writeFile(envPath, `VITE_BACKEND_PORT=${port}\n`, 'utf8');
            console.log(`端口号环境变量已保存到 ${envPath}`);
          } catch (envError) {
            console.error('保存端口号到环境变量失败，但不影响主要功能:', envError);
          }
        }
      } catch (error) {
        console.error('保存端口号到文件失败:', error);
      }
    };
  })();
  // 使用变量标记回调是否已执行，防止多次触发
  let callbackExecuted = false;
  
  // 尝试在可用端口上启动服务器
  await startServerOnAvailablePort(PORT);
  
  // 启动服务器函数
  async function startServerOnAvailablePort(startPort) {
    let currentPort = startPort;
    const maxPort = startPort + 100; // 最多尝试100个端口
    
    while (currentPort < maxPort) {
      try {
        // 等待1秒，避免快速尝试多个端口
        if (currentPort > startPort) {
          await new Promise(resolve => setTimeout(resolve, 800));
          console.log(`尝试端口 ${currentPort}...`);
        }
        
        // 尝试在当前端口启动服务器
        await new Promise((resolve, reject) => {
          // 仅监听一次error事件
          const errorHandler = (err) => {
            httpServer.removeListener('error', errorHandler);
            reject(err);
          };
          
          httpServer.once('error', errorHandler);
          
          httpServer.listen(currentPort, () => {
            // 确保回调只执行一次
            if (callbackExecuted) return;
            callbackExecuted = true;
            
            // 成功监听，移除错误处理器
            httpServer.removeListener('error', errorHandler);
            
            // 输出服务器信息
            console.log(chalk.green('======================================'));
            console.log(chalk.green(`  Zen GitSync 服务器已启动`));
            console.log(chalk.green(`  访问地址: http://localhost:${currentPort}`));
            console.log(chalk.green(`  启动时间: ${new Date().toLocaleString()}`));
            
            if (isGitRepo) {
              console.log(chalk.green(`  当前目录是Git仓库`));
            } else {
              console.log(chalk.yellow(`  当前目录不是Git仓库，文件监控未启动`));
            }
            
            console.log(chalk.green('======================================'));
            
            // 保存端口号到文件
            savePortToFile(currentPort);
            
            // 只有在noOpen为false时才打开浏览器
            if (!noOpen) {
              setTimeout(() => {
                open(`http://localhost:${currentPort}`);
              }, 0);
            }
            
            resolve();
          });
        });
        
        // 如果成功启动，退出循环
        return;
      } catch (err) {
        // 处理端口被占用的情况
        if (err.code === 'EADDRINUSE') {
          console.log(`端口 ${currentPort} 被占用，尝试下一个端口...`);
          currentPort++;
        } else {
          // 其他错误，直接抛出
          console.error('启动服务器失败:', err);
          process.exit(1);
        }
      }
    }
    
    // 如果尝试了所有端口都失败
    console.error(`无法找到可用端口 (尝试范围: ${startPort}-${maxPort-1})`);
    process.exit(1);
  }

}

export default startUIServer;

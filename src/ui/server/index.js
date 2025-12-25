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
import { registerGitRoutes } from './routes/git.js';
import { registerFsRoutes } from './routes/fs.js';
import { registerBranchStatusRoutes } from './routes/branchStatus.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerNpmRoutes } from './routes/npm.js';
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
    nextProcessId: () => ++processIdCounter,
    runningProcesses,
    spawn,
    path,
    iconv
  });

  registerTerminalRoutes({
    app,
    getCurrentProjectPath: () => currentProjectPath,
    nextTerminalSessionId: () => ++terminalSessionIdCounter,
    terminalSessions,
    spawn,
    exec
  });

  registerProcessRoutes({
    app,
    runningProcesses,
    exec
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
    express,
    execGitCommand,
    clearBranchCache
  });

  registerFsRoutes({
    app,
    execGitCommand,
    configManager,
    io,
    chalk,
    fs,
    path,
    open,
    os,
    spawn,
    exec,
    getCurrentProjectPath: () => currentProjectPath,
    setCurrentProjectPath: (v) => { currentProjectPath = v; },
    getProjectRoomId: () => projectRoomId,
    setProjectRoomId: (v) => { projectRoomId = v; },
    setIsGitRepo: (v) => { isGitRepo = v; }
  });

  registerConfigRoutes({
    app,
    express,
    configManager,
    path,
    os,
    fs,
    open
  });

  registerNpmRoutes({
    app,
    express,
    fs,
    fsSync,
    path,
    exec,
    getCurrentProjectPath: () => currentProjectPath
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
        message: 'Starting to push to the remote repository...'
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

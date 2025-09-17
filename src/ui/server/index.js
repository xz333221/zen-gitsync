import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { execGitCommand, getCommandHistory, clearCommandHistory, registerSocketIO, execGitAddWithLockFilter } from '../../utils/index.js';
import open from 'open';
import config from '../../config.js';
import chalk from 'chalk';
import fs from 'fs/promises';
import os from 'os';
import { Server } from 'socket.io';
import chokidar from 'chokidar';
// import { exec } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const configManager = config; // 确保 configManager 可用

// 文件系统变动监控器
let watcher = null;
// 防抖计时器
let debounceTimer = null;
// 防抖延迟时间 (毫秒)
const DEBOUNCE_DELAY = 1000;

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

async function startUIServer(noOpen = false, savePort = false) {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer);
  
  // 获取当前项目的唯一标识（使用工作目录路径）
  const currentProjectPath = process.cwd();
  const projectRoomId = `project:${currentProjectPath.replace(/[\\/:\s]/g, '_')}`;
  
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
      const { stdout } = await execGitCommand('git rev-parse --show-toplevel');
      const root = stdout?.trim();
      if (root) dirPath = root;
    } catch (_) {
      // 非Git仓库或命令失败，使用 CWD 即可
    }
    await configManager.saveRecentDirectory(dirPath);
    console.log(chalk.gray(`已记录最近打开目录: ${dirPath}`));
  } catch (e) {
    console.warn(chalk.yellow(`记录最近目录失败: ${e?.message || e}`));
  }
  
  // 添加请求日志中间件
  app.use((req, res, next) => {
    const now = new Date().toLocaleString();
    console.log(`[${now}] ${req.method} ${req.url}`);
    next();
  });
  
  // 静态文件服务
  app.use(express.static(path.join(__dirname, '../public')));
  
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
    console.log('重新获取当前分支名...');
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
      console.log('重新获取分支信息...');

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
      
      console.log('本地分支:', localBranchList);
      console.log('远程分支:', remoteBranchList);
      console.log('所有分支:', allBranches);
      
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
                  
                  // 关闭旧的文件监控
                  if (watcher) {
                    watcher.close().catch(err => console.error('关闭旧监控器失败:', err));
                    watcher = null;
                  }
                  
                  // 通知所有旧房间的客户端项目已切换
                  io.to(projectRoomId).emit('project_changed', {
                    oldProjectPath: currentProjectPath,
                    newProjectPath: newProjectPath,
                    newProjectRoomId: newProjectRoomId
                  });
                  
                  // 重新初始化文件监控（新路径）
                  initFileSystemWatcher();
                  
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
                  
                  if (watcher) {
                    watcher.close().catch(err => console.error('关闭监控器失败:', err));
                    watcher = null;
                  }
                  
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
      const config = await configManager.loadConfig()
      res.json(config)
    } catch (error) {
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
      // 使用带锁定文件过滤的 git add
      await execGitAddWithLockFilter();
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
      const limit = parseInt(req.query.limit) || 20;
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
      
      console.log(`执行Git命令: git log --all --pretty=format:"${formatString}" --date=format:"%Y-%m-%d %H:%M" ${options}`);

      // 使用 git log 命令获取提交历史
      let { stdout: logOutput } = await execGitCommand(
        `git log --all --pretty=format:"${formatString}" --date=format:"%Y-%m-%d %H:%M" ${options}`
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
      const command = `git log ${formattedBranchRefs} --pretty=format:"${formatString}" --date=format:"%Y-%m-%d %H:%M" ${options}`;
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

    console.log(`分页查询 - 页码: ${page}, 每页数量: ${limit}, 返回数量: ${data.length}, 是否有更多: ${hasMore} (优化版本，不计算总数)`);

    // 返回提交历史数据，包括是否有更多数据的标志
    res.json({
      data: data,
      total: -1, // 不再提供总数，前端不应依赖此字段
      page: page,
      limit: limit,
      hasMore: hasMore
    });
  }
  
  // 获取文件差异
  app.get('/api/diff', async (req, res) => {
    try {
      const filePath = req.query.file;
      
      if (!filePath) {
        return res.status(400).json({ error: '缺少文件路径参数' });
      }
      
      // 执行git diff命令获取文件差异
      const { stdout } = await execGitCommand(`git diff -- "${filePath}"`);
      
      res.json({ diff: stdout });
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
      
      // 执行git diff --cached命令获取已暂存文件差异
      const { stdout } = await execGitCommand(`git diff --cached -- "${filePath}"`);
      
      res.json({ diff: stdout });
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
      
      // 执行命令获取文件差异，-p显示补丁，限定文件路径
      const { stdout } = await execGitCommand(`git show ${hash} -- "${filePath}"`);
      
      console.log(`获取到差异内容，长度: ${stdout.length}`);
      // 如果差异内容太长，只打印前100个字符
      if (stdout.length > 100) {
        console.log(`差异内容预览: ${stdout.substring(0, 100)}...`);
      }
      
      res.json({ 
        success: true, 
        diff: stdout 
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
        const { stdout: statusStdout } = await execGitCommand('git status --porcelain', { log: false });
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
        
        // 过滤出未锁定且存在的文件
        const filesToStash = [];
        for (const item of changedFiles) {
          const { status, filename } = item;
          const normalizedFile = path.normalize(filename);
          
          // 检查是否被锁定
          const isLocked = lockedFiles.some(locked => {
            const normalizedLocked = path.normalize(locked);
            return normalizedFile === normalizedLocked || normalizedFile.startsWith(normalizedLocked + path.sep);
          });
          
          if (!isLocked) {
            // 检查文件是否存在（排除已删除的文件和目录）
            try {
              const fullPath = path.resolve(filename);
              const stats = fs.statSync(fullPath);
              // 只包含文件，不包含目录
              if (stats.isFile()) {
                filesToStash.push(filename);
              }
            } catch (error) {
              // 对于已删除的文件（D状态），我们仍然需要包含它们
              if (status.includes('D')) {
                filesToStash.push(filename);
              }
              // 其他情况（如文件不存在）则跳过
            }
          }
        }

        if (filesToStash.length === 0) {
          return res.json({ success: false, message: '所有更改都是锁定文件，无需储藏' });
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
      console.error('保存stash失败:', error);
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

  // 获取stash中的文件列表
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
      
      // 执行git stash show --name-only命令获取文件列表
      const { stdout } = await execGitCommand(`git stash show --name-only ${stashId}`);
      
      // 将输出按行分割，并过滤掉空行
      const files = stdout.split('\n').filter(line => line.trim());
      console.log(`找到${files.length}个stash文件:`, files);
      
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

  // 获取stash中特定文件的差异
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
      
      // 执行git stash show -p命令获取特定文件的差异
      // 需要使用正确的语法：git show stashId:file 或者 git stash show -p stashId -- file
      const { stdout } = await execGitCommand(`git show ${stashId} -- "${file}"`);
      
      console.log(`获取到差异内容，长度: ${stdout.length}`);
      // 如果差异内容太长，只打印前100个字符
      if (stdout.length > 100) {
        console.log(`差异内容预览: ${stdout.substring(0, 100)}...`);
      }
      
      res.json({ 
        success: true, 
        diff: stdout 
      });
    } catch (error) {
      console.error('获取stash文件差异失败:', error);
      res.status(500).json({ 
        success: false, 
        error: `获取stash文件差异失败: ${error.message}` 
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
    
    // 发送项目信息给客户端
    socket.emit('project_info', {
      projectPath: currentProjectPath,
      projectRoomId: projectRoomId
    });
    
    // 客户端可以请求开始/停止监控
    socket.on('start_monitoring', () => {
      if (!watcher) {
        initFileSystemWatcher();
        socket.emit('monitoring_status', { active: true });
      }
    });
    
    // 处理客户端加入新房间的请求
    socket.on('join_room', (roomId) => {
      socket.join(roomId);
      console.log(`客户端 ${socket.id} 已加入房间: ${roomId}`);
    });
    
    socket.on('stop_monitoring', () => {
      if (watcher) {
        watcher.close().catch(err => console.error('关闭监控器失败:', err));
        watcher = null;
        socket.emit('monitoring_status', { active: false });
      }
    });
    
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
    
    // 客户端断开连接
    socket.on('disconnect', () => {
      console.log(`客户端已断开连接: ${socket.id} (房间: ${projectRoomId})`);
      // Socket.IO 会自动从房间中移除断开的连接
    });
  });
  
  // 初始化文件系统监控
  function initFileSystemWatcher() {
    // 停止已有的监控器
    if (watcher) {
      watcher.close().catch(err => console.error('关闭旧监控器失败:', err));
    }
    
    try {
      // 获取当前工作目录
      const currentDir = process.cwd();
      
      console.log(`初始化文件系统监控器，路径: ${currentDir}`);
      
      // 检查是否是Git仓库
      if (!isGitRepo) {
        console.log('当前目录不是Git仓库，不启动监控');
        return;
      }
      
      // 使用chokidar监控文件变动
      watcher = chokidar.watch(currentDir, {
        ignored: [
          /(^|[\/\\])\../, // 忽略.开头的文件和目录
          '**/node_modules/**', // 忽略node_modules
          '**/.git/**', // 忽略.git目录
        ],
        persistent: true,
        ignoreInitial: true, // 忽略初始扫描时的文件
        awaitWriteFinish: {
          stabilityThreshold: 300, // 等待文件写入完成的时间
          pollInterval: 100 // 轮询间隔
        }
      });
      
      // 合并所有变动事件到一个处理程序
      const events = ['add', 'change', 'unlink'];
      events.forEach(event => {
        watcher.on(event, path => {
          console.log(`检测到文件变动 [${event}]: ${path}`);
          debouncedNotifyChanges();
        });
      });
      
      watcher.on('error', error => {
        console.error('文件监控错误:', error);
      });
      
      console.log('文件系统监控器已启动');
    } catch (error) {
      console.error('启动文件监控失败:', error);
    }
  }
  
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
  
  // 防抖处理函数
  function debouncedNotifyChanges() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    
    debounceTimer = setTimeout(() => {
      getAndBroadcastStatus();
    }, DEBOUNCE_DELAY);
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
          await new Promise(resolve => setTimeout(resolve, 1000));
          console.log(`尝试端口 ${currentPort}...`);
        }
        
        // 尝试在当前端口启动服务器
        await new Promise((resolve, reject) => {
          // 仅监听一次error事件
          const errorHandler = (err) => {
            httpServer.removeListener('error', errorHandler);
            reject(err);
          };
          
          // 使用变量标记回调是否已执行，防止多次触发
          let callbackExecuted = false;
          
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
              console.log(chalk.green(`  当前目录是Git仓库，文件监控已启动`));
              // 启动文件监控
              initFileSystemWatcher();
            } else {
              console.log(chalk.yellow(`  当前目录不是Git仓库，文件监控未启动`));
            }
            
            console.log(chalk.green('======================================'));
            
            // 保存端口号到文件
            savePortToFile(currentPort);
            
            // 只有在noOpen为false时才打开浏览器
            if (!noOpen) {
              open(`http://localhost:${currentPort}`);
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
}

export default startUIServer;

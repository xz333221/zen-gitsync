import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { execGitCommand } from '../../utils/index.js';
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

async function startUIServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer);
  
  // 添加全局中间件来解析JSON请求体
  app.use(express.json());
  
  // 添加请求日志中间件
  app.use((req, res, next) => {
    const now = new Date().toLocaleString();
    console.log(`[${now}] ${req.method} ${req.url}`);
    next();
  });
  
  // 静态文件服务
  app.use(express.static(path.join(__dirname, '../public')));
  
  // API路由
  app.get('/api/status', async (req, res) => {
    try {
      const { stdout } = await execGitCommand('git status');
      res.json({ status: stdout });
    } catch (error) {
      res.status(500).json({ error: error.message });
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
  
  // 获取当前分支
  app.get('/api/branch', async (req, res) => {
    try {
      const { stdout } = await execGitCommand('git rev-parse --abbrev-ref HEAD');
      res.json({ branch: stdout.trim() });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 获取分支与远程的差异状态（领先/落后提交数）
  app.get('/api/branch-status', async (req, res) => {
    try {
      // 检查当前目录是否是Git仓库
      if (!isGitRepo) {
        return res.json({ hasUpstream: false, ahead: 0, behind: 0 });
      }
      
      // 获取当前分支
      const { stdout: branchOutput } = await execGitCommand('git symbolic-ref --short HEAD');
      const currentBranch = branchOutput.trim();
      
      // 获取上游分支
      const { stdout: upstreamOutput } = await execGitCommand('git rev-parse --abbrev-ref --symbolic-full-name @{u}', { ignoreError: true });
      
      if (!upstreamOutput.trim()) {
        // 没有上游分支
        return res.json({ hasUpstream: false, ahead: 0, behind: 0 });
      }
      
      const upstreamBranch = upstreamOutput.trim();
      
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
              
              // 检查新目录是否是Git仓库
              try {
                  await execGitCommand('git rev-parse --is-inside-work-tree');
                  
                  // 初始化文件监控
                  initFileSystemWatcher();
                  
                  res.json({ 
                      success: true, 
                      directory: newDirectory,
                      isGitRepo: true 
                  });
              } catch (error) {
                  // 不是Git仓库，停止监控
                  if (watcher) {
                    watcher.close().catch(err => console.error('关闭监控器失败:', err));
                    watcher = null;
                  }
                  
                  res.json({ 
                      success: true, 
                      directory: newDirectory,
                      isGitRepo: false,
                      warning: '新目录不是一个Git仓库'
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
      // 执行 git add . 命令添加所有更改
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
      const limit = parseInt(req.query.limit) || 100;
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
      
      console.log(`执行Git命令: git log --all --pretty=format:"${formatString}" --date=short ${options}`);
      
      // 使用 git log 命令获取提交历史
      let { stdout: logOutput } = await execGitCommand(
        `git log --all --pretty=format:"${formatString}" --date=short ${options}`
      );
      
      // 获取总提交数量（考虑筛选条件）
      let totalCommits = 0;
      try {
        // 构建计数命令，包含相同的筛选条件
        // 对于作者筛选，使用 rev-list 并手动计数，避免 --count 与复杂作者筛选结合可能的问题
        if (author.length > 1) {
          // 多作者情况，使用 wc -l 手动计数
          const countCommand = `git rev-list --all ${commandOptions.join(' ')}`;
          console.log(`执行计数命令(多作者): ${countCommand}`);
          
          const { stdout: countOutput } = await execGitCommand(countCommand);
          // 计算行数作为提交数
          totalCommits = countOutput.trim().split('\n').filter(line => line.trim() !== '').length;
        } else {
          // 单作者或无作者筛选，可以直接使用 --count
          const countCommand = `git rev-list --all --count ${commandOptions.join(' ')}`;
          console.log(`执行计数命令(单作者): ${countCommand}`);
          
          const { stdout: countOutput } = await execGitCommand(countCommand);
          totalCommits = parseInt(countOutput.trim());
        }
      } catch (error) {
        console.error('获取提交总数失败:', error);
        totalCommits = 0;
      }
      
      processAndSendLogOutput(res, logOutput, totalCommits, page, limit, withParents);
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
      const command = `git log ${formattedBranchRefs} --pretty=format:"${formatString}" --date=short ${options}`;
      console.log(`执行Git命令(带分支引用): ${command}`);
      
      // 执行命令
      const { stdout: logOutput } = await execGitCommand(command);
      
      // 获取总提交数
      let totalCommits = 0;
      try {
        // 构建计数命令
        const countCommand = `git rev-list ${formattedBranchRefs} --count ${commandOptions.join(' ')}`;
        console.log(`执行计数命令(分支): ${countCommand}`);
        
        const { stdout: countOutput } = await execGitCommand(countCommand);
        totalCommits = parseInt(countOutput.trim());
      } catch (error) {
        console.error('获取提交总数失败:', error);
        totalCommits = 0;
      }
      
      processAndSendLogOutput(res, logOutput, totalCommits, skip / limit + 1, limit, withParents);
    } catch (error) {
      console.error('执行Git日志命令失败:', error);
      res.status(500).json({ error: '获取日志失败: ' + error.message });
    }
  }
  
  // 抽取处理输出并发送响应的函数
  function processAndSendLogOutput(res, logOutput, totalCommits, page, limit, withParents = false) {
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
    
    // 计算是否有更多数据
    const hasMore = page * limit < totalCommits;
    
    console.log(`分页查询 - 页码: ${page}, 每页数量: ${limit}, 总数: ${totalCommits}, 返回数量: ${data.length}, 是否有更多: ${hasMore}`);
    
    // 返回提交历史数据，包括是否有更多数据的标志
    res.json({
      data: data,
      total: totalCommits,
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
      const { message, includeUntracked } = req.body;
      
      // 构建stash命令
      let command = 'git stash push';
      
      // 添加可选参数
      if (message) {
        command += ` -m "${message}"`;
      }
      
      if (includeUntracked) {
        command += ' --include-untracked';
      }
      
      const { stdout } = await execGitCommand(command);
      
      // 检查是否有任何更改被保存
      if (stdout.includes('No local changes to save')) {
        return res.json({ 
          success: false, 
          message: '没有本地更改需要保存' 
        });
      }
      
      res.json({ 
        success: true, 
        message: '成功保存工作区更改',
        output: stdout 
      });
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
  
  // Socket.io 实时更新
  io.on('connection', (socket) => {
    console.log('客户端已连接:', socket.id);
    
    // 当客户端连接时，立即发送一次Git状态
    getAndBroadcastStatus();
    
    // 客户端可以请求开始/停止监控
    socket.on('start_monitoring', () => {
      if (!watcher) {
        initFileSystemWatcher();
        socket.emit('monitoring_status', { active: true });
      }
    });
    
    socket.on('stop_monitoring', () => {
      if (watcher) {
        watcher.close().catch(err => console.error('关闭监控器失败:', err));
        watcher = null;
        socket.emit('monitoring_status', { active: false });
      }
    });
    
    // 客户端断开连接
    socket.on('disconnect', () => {
      console.log('客户端已断开连接:', socket.id);
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
  
  // 获取并广播Git状态
  async function getAndBroadcastStatus() {
    try {
      // 如果不是Git仓库，发送特殊状态
      if (!isGitRepo) {
        io.emit('git_status_update', { 
          isGitRepo: false,
          status: '当前目录不是Git仓库',
          porcelain: '',
          timestamp: new Date().toISOString()
        });
        return;
      }
      
      // 获取常规状态
      const { stdout: statusOutput } = await execGitCommand('git status');
      
      // 获取porcelain格式状态
      const { stdout: porcelainOutput } = await execGitCommand('git status --porcelain --untracked-files=all');
      
      // 广播到所有连接的客户端
      io.emit('git_status_update', { 
        isGitRepo: true,
        status: statusOutput,
        porcelain: porcelainOutput,
        timestamp: new Date().toISOString()
      });
      
      console.log('已广播Git状态更新');
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
  httpServer.listen(PORT, () => {
    console.log(chalk.green('======================================'));
    console.log(chalk.green(`  Zen GitSync 服务器已启动`));
    console.log(chalk.green(`  访问地址: http://localhost:${PORT}`));
    console.log(chalk.green(`  启动时间: ${new Date().toLocaleString()}`));
    if (isGitRepo) {
      console.log(chalk.green(`  当前目录是Git仓库，文件监控已启动`));
      // 启动文件监控
      initFileSystemWatcher();
    } else {
      console.log(chalk.yellow(`  当前目录不是Git仓库，文件监控未启动`));
    }
    console.log(chalk.green('======================================'));
    
    open(`http://localhost:${PORT}`);
  }).on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`端口 ${PORT} 被占用，尝试其他端口...`);
      let newPort = PORT + 1;
      while (newPort < PORT + 100) {
        try {
          await new Promise((resolve, reject) => {
            httpServer.listen(newPort, () => {
              console.log(chalk.green('======================================'));
              console.log(chalk.green(`  Zen GitSync 服务器已启动`));
              console.log(chalk.green(`  访问地址: http://localhost:${newPort}`));
              console.log(chalk.green(`  启动时间: ${new Date().toLocaleString()}`));
              console.log(chalk.green('======================================'));
              resolve();
            });
          });
          break;
        } catch (error) {
          newPort++;
        }
      }
    } else {
      console.error('启动服务器失败:', err);
      process.exit(1);
    }
  });
}

export default startUIServer;

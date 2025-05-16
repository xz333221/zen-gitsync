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
      const { stdout } = await execGitCommand('git status --porcelain');
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

  // 获取所有分支
  app.get('/api/branches', async (req, res) => {
    try {
      // 获取本地分支
      const { stdout: localBranches } = await execGitCommand('git branch --format="%(refname:short)"');
      // 获取远程分支（过滤掉 origin/HEAD 和 origin）
      const { stdout: remoteBranches } = await execGitCommand('git branch -r --format="%(refname:short)"');
      
      // 合并并去重
      const allBranches = [...new Set([
        ...localBranches.split('\n')
          .filter(Boolean)
          .filter(b => !b.startsWith('* ')), // 过滤掉HEAD指针
        ...remoteBranches.split('\n')
          .filter(Boolean)
          .filter(b => b.includes('/')) // 过滤掉单纯的 origin
          .map(b => b.split('/')[1]) // 提取真正的分支名称
      ])];
      
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
  
  // 获取配置
  app.get('/api/config/getConfig', async (req, res) => {
    try {
      const config = await configManager.loadConfig()
      res.json(config)
    } catch (error) {
      res.status(500).json({ error: error.message })
    }
  })
  
  // 保存描述模板
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
      } else {
        return res.status(400).json({ success: false, error: '不支持的模板类型' })
      }
      
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: error.message })
    }
  })
  
  // 删除描述模板
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
      await execGitCommand('git push');
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  
  // 获取日志
  app.get('/api/log', async (req, res) => {
    try {
      // 获取请求参数中的数量限制，默认为200
      const limit = req.query.all === 'true' ? '' : '-n 200';
      
      // graph参数保留但不做特殊处理，避免前端代码重复调用API
      // 由前端统一使用该接口
      
      // 修改 git log 命令，添加 %ae 参数来获取作者邮箱
      // 使用 %H 获取完整哈希值（而不是短哈希 %h）
      // 使用 %B 获取完整提交信息（包括正文）
      const { stdout } = await execGitCommand(`git log --all --pretty=format:"%H|%an|%ae|%ad|%B|%D" --date=short ${limit}`);
      
      // 分隔符改为使用特殊标记，因为提交信息中可能包含|字符
      const recordSeparator = "\n<<<RECORD_SEPARATOR>>>\n";
      const fieldSeparator = "<<<FIELD_SEPARATOR>>>";
      
      // 预处理输出，替换提交记录之间的换行符
      const processedOutput = stdout.replace(/\n(?=[a-f0-9]{40}\|)/g, recordSeparator);
      
      // 按记录分隔符拆分日志条目
      const logEntries = processedOutput.split(recordSeparator);
      
      const logs = logEntries.map(entry => {
        // 使用第一个|分隔哈希值，其余部分作为整体
        const hashEndIndex = entry.indexOf('|');
        const hash = entry.substring(0, hashEndIndex);
        const restPart = entry.substring(hashEndIndex + 1);
        
        // 使用最后一个|分隔引用信息，其余部分作为整体
        const lastPipeIndex = restPart.lastIndexOf('|');
        const refs = restPart.substring(lastPipeIndex + 1).trim();
        const middlePart = restPart.substring(0, lastPipeIndex);
        
        // 分隔作者、邮箱、日期和提交信息
        const parts = middlePart.split('|');
        
        // 确保即使分隔出的部分不足，也能提供默认值
        const author = parts[0] || '';
        const email = parts[1] || '';
        const date = parts[2] || '';
        // 提交信息可能包含多行
        const message = parts.slice(3).join('|').trim();
        
        // 从引用信息中提取分支名称
        let branch = null;
        if (refs) {
          // 提取所有引用信息，而不仅仅是第一个匹配
          branch = refs.trim();
        }
        
        return { hash, author, email, date, message, branch };
      });
      
      res.json(logs);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  
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
      try {
        execGitCommand('git rev-parse --is-inside-work-tree');
      } catch (error) {
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
      // 获取常规状态
      const { stdout: statusOutput } = await execGitCommand('git status');
      
      // 获取porcelain格式状态
      const { stdout: porcelainOutput } = await execGitCommand('git status --porcelain');
      
      // 广播到所有连接的客户端
      io.emit('git_status_update', { 
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
  
  // 启动服务器
  const PORT = 3000;
  httpServer.listen(PORT, () => {
    console.log(chalk.green('======================================'));
    console.log(chalk.green(`  Zen GitSync 服务器已启动`));
    console.log(chalk.green(`  访问地址: http://localhost:${PORT}`));
    console.log(chalk.green(`  启动时间: ${new Date().toLocaleString()}`));
    console.log(chalk.green('======================================'));
    
    // 启动文件监控
    initFileSystemWatcher();
    
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
              
              // 启动文件监控
              initFileSystemWatcher();
              
              open(`http://localhost:${newPort}`);
              resolve();
            }).on('error', (e) => {
              if (e.code === 'EADDRINUSE') {
                console.log(`端口 ${newPort} 也被占用，继续尝试...`);
                newPort++;
                reject(e);
              } else {
                reject(e);
              }
            });
          });
          break;
        } catch (e) {
          if (newPort >= PORT + 100) {
            console.error('无法找到可用端口，请手动指定端口');
            process.exit(1);
          }
        }
      }
    } else {
      console.error('服务器启动失败:', err);
      process.exit(1);
    }
  });
}

export default startUIServer;


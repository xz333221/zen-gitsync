import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { execGitCommand } from '../../utils/index.js';
import open from 'open';
import config from '../../config.js';
import chalk from 'chalk';
import fs from 'fs/promises';
// import { Server } from 'socket.io';
// import { exec } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const configManager = config; // 确保 configManager 可用

async function startUIServer() {
  const app = express();
  const httpServer = createServer(app);
  // const io = new Server(httpServer);
  
  // 添加全局中间件来解析JSON请求体
  app.use(express.json());
  
  // // 启动前端Vue应用
  // const clientPath = path.join(__dirname, '../client');
  // console.log(`正在启动前端应用，路径: ${clientPath}`);
  
  // const vueProcess = exec('npm run dev', { cwd: clientPath }, (error) => {
  //   if (error) {
  //     console.error('启动前端应用失败:', error);
  //   }
  // });
  
  // vueProcess.stdout.on('data', (data) => {
  //   console.log(`前端输出: ${data}`);
  // });
  
  // vueProcess.stderr.on('data', (data) => {
  //   console.error(`前端错误: ${data}`);
  // });
  
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
      // 获取用户名
      const { stdout: userName } = await execGitCommand('git config user.name');
      // 获取用户邮箱
      const { stdout: userEmail } = await execGitCommand('git config user.email');
      
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
                  res.json({ 
                      success: true, 
                      directory: newDirectory,
                      isGitRepo: true 
                  });
              } catch (error) {
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
      // 获取请求参数中的数量限制，默认为100
      const limit = req.query.all === 'true' ? '' : '-n 100';
      
      // 修改 git log 命令，添加 %ae 参数来获取作者邮箱
      const { stdout } = await execGitCommand(`git log --all --pretty=format:"%h|%an|%ae|%ad|%s|%D" --date=short ${limit}`);
      const logs = stdout.split('\n').map(line => {
        const [hash, author, email, date, message, refs] = line.split('|');
        
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
  
  // Socket.io 实时更新
  // io.on('connection', (socket) => {
  //   console.log('客户端已连接');
    
  //   // 定期发送状态更新
  //   const statusInterval = setInterval(async () => {
  //     try {
  //       const { stdout } = await execGitCommand('git status');
  //       socket.emit('status_update', { status: stdout });
  //     } catch (error) {
  //       console.error('状态更新错误:', error);
  //     }
  //   }, 5000);
    
  //   socket.on('disconnect', () => {
  //     clearInterval(statusInterval);
  //     console.log('客户端已断开连接');
  //   });
  // });
  
  // 启动服务器
  const PORT = 3000;
  httpServer.listen(PORT, () => {
    console.log(`后端API服务器已启动: http://localhost:${PORT}`);
    open(`http://localhost:${PORT}`);
  }).on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`端口 ${PORT} 被占用，尝试其他端口...`);
      let newPort = PORT + 1;
      while (newPort < PORT + 100) {
        try {
          await new Promise((resolve, reject) => {
            httpServer.listen(newPort, () => {
              console.log(`后端API服务器已启动: http://localhost:${newPort}`);
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


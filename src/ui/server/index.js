import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import path from 'path';
import { execGitCommand } from '../../utils/index.js';
import open from 'open';
import config from '../../config.js';
import { exec } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const configManager = config; // 确保 configManager 可用

async function startUIServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer);
  
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
  
  // // 静态文件服务
  // app.use(express.static(path.join(__dirname, 'public')));
  
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
      const { stdout } = await execGitCommand(`git log --pretty=format:"%h|%an|%ae|%ad|%s|%D" --date=short ${limit}`);
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
  
  // Socket.io 实时更新
  io.on('connection', (socket) => {
    console.log('客户端已连接');
    
    // 定期发送状态更新
    const statusInterval = setInterval(async () => {
      try {
        const { stdout } = await execGitCommand('git status');
        socket.emit('status_update', { status: stdout });
      } catch (error) {
        console.error('状态更新错误:', error);
      }
    }, 5000);
    
    socket.on('disconnect', () => {
      clearInterval(statusInterval);
      console.log('客户端已断开连接');
    });
  });
  
  // 启动服务器
  const PORT = 3000;
  httpServer.listen(PORT, () => {
    console.log(`后端API服务器已启动: http://localhost:${PORT}`);
    // 不自动打开后端URL，让前端Vite服务器处理
    // open(`http://localhost:${PORT}`);
  });
}

export default startUIServer;


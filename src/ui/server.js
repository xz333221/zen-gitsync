import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import path from 'path';
import { execGitCommand } from '../utils/index.js';
import open from 'open';
import config from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startUIServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer);
  
  // 静态文件服务
  app.use(express.static(path.join(__dirname, 'public')));
  
  // API路由
  app.get('/api/status', async (req, res) => {
    try {
      const { stdout } = await execGitCommand('git status');
      res.json({ status: stdout });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  
  // 获取配置
  app.get('/api/config', async (req, res) => {
    try {
      const currentConfig = await config.loadConfig();
      res.json(currentConfig);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  
  // 提交更改
  app.post('/api/commit', express.json(), async (req, res) => {
    try {
      const { message } = req.body;
      await execGitCommand('git add .');
      await execGitCommand(`git commit -m "${message || '提交'}"`);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
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
      const { stdout } = await execGitCommand('git log --pretty=format:"%h|%an|%ad|%s" --date=short -n 10');
      const logs = stdout.split('\n').map(line => {
        const [hash, author, date, message] = line.split('|');
        return { hash, author, date, message };
      });
      res.json(logs);
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
    console.log(`UI服务器已启动: http://localhost:${PORT}`);
    open(`http://localhost:${PORT}`);
  });
}

export default startUIServer;
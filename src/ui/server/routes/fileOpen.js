import fs from 'fs/promises';
import path from 'path';
import open from 'open';
import { spawn } from 'child_process';

export function registerFileOpenRoutes({
  app
}) {
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
}

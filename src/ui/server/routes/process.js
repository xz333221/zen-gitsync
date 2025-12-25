export function registerProcessRoutes({
  app,
  runningProcesses,
  exec
}) {
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
}

// Copyright 2026 xz333221
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
import { asyncRoute, HttpError } from '../utils/asyncRoute.js'

import logger from '../utils/logger.js'

export function registerProcessRoutes({
  app,
  runningProcesses,
  exec
}) {
  // 停止正在运行的进程
  app.post('/api/kill-process', asyncRoute(async (req, res) => {
      try {
        const { processId } = req.body || {};
        if (!processId || typeof processId !== 'number') {
          throw new HttpError(400, 'processId 必须是数字');
        }
      
        const processInfo = runningProcesses.get(processId);
        if (!processInfo) {
          return res.status(404).json({
            success: false,
            error: `进程 #${processId} 不存在或已结束`
          });
        }
      
        logger.info(`[进程管理] 尝试停止进程 #${processId}: ${processInfo.command}`);
      
        try {
          // 在 Windows 上需要使用 taskkill 来杀死整个进程树
          if (process.platform === 'win32') {
            // 使用已导入的 exec
            // /F 强制终止, /T 终止进程树
            exec(`taskkill /pid ${processInfo.childProcess.pid} /T /F`, { windowsHide: true }, (error) => {
              if (error) {
                logger.error(`[进程管理] taskkill 失败:`, error);
              }
            });
          } else {
            // Unix/Linux/Mac 使用 SIGTERM
            processInfo.childProcess.kill('SIGTERM');
      
            // 如果 2 秒后还没结束，使用 SIGKILL 强制终止
            setTimeout(() => {
              if (runningProcesses.has(processId)) {
                logger.info(`[进程管理] 进程 #${processId} 未响应 SIGTERM，使用 SIGKILL 强制终止`);
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
          logger.error(`[进程管理] 停止进程失败:`, killError);
          res.status(500).json({
            success: false,
            error: `停止进程失败: ${killError.message}`
          });
        }
      } catch (error) {
        logger.error('停止进程接口失败:', error);
        res.status(500).json({
          success: false,
          error: `停止进程失败: ${error.message}`
        });
      }
    }));
}

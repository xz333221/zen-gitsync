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
import logger from './logger.js'

// 监听地址：默认只绑回环地址。
// GUI 服务没有任何认证层，绑 0.0.0.0 等于把 /api/exec-stream（命令执行）、
// /api/add-npm-script（写 package.json scripts）、/api/open-file（用系统
// 关联程序打开任意文件）等接口裸奔在局域网上，同网段任何主机都可调用。
// 确有远程访问 / WSL 跨环境需求时，用 ZEN_HOST=0.0.0.0 显式放开。
const DEFAULT_HOST = '127.0.0.1'

function normalizeHost(raw) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return value || DEFAULT_HOST
}

export async function startServerOnAvailablePort({
  httpServer,
  startPort,
  chalk,
  open,
  noOpen,
  isGitRepo,
  savePortToFile,
  fsSync,
  maxTries = 100,
  callbackExecutedRef,
  host
}) {
  const bindHost = normalizeHost(host ?? process.env.ZEN_HOST)
  let currentPort = startPort;
  const maxPort = startPort + maxTries;
  const getCallbackExecuted = () => {
    if (callbackExecutedRef && typeof callbackExecutedRef === 'object' && 'value' in callbackExecutedRef) {
      return Boolean(callbackExecutedRef.value);
    }
    return false;
  };

  const setCallbackExecuted = (value) => {
    if (callbackExecutedRef && typeof callbackExecutedRef === 'object' && 'value' in callbackExecutedRef) {
      callbackExecutedRef.value = Boolean(value);
    }
  };

  while (currentPort < maxPort) {
    try {
      if (currentPort > startPort) {
        await new Promise(resolve => setTimeout(resolve, 800));
        logger.info(`尝试端口 ${currentPort}...`);
      }

      await new Promise((resolve, reject) => {
        const errorHandler = (err) => {
          httpServer.removeListener('error', errorHandler);
          reject(err);
        };

        httpServer.once('error', errorHandler);

        httpServer.listen(currentPort, bindHost, () => {
          if (getCallbackExecuted()) return;
          setCallbackExecuted(true);

          httpServer.removeListener('error', errorHandler);

          console.log(chalk.green('======================================'));
          console.log(chalk.green(`  Zen GitSync 服务器已启动`));
          console.log(chalk.green(`  访问地址: http://localhost:${currentPort}`));
          console.log(chalk.green(`  启动时间: ${new Date().toLocaleString()}`));
          // 非回环地址才提示，默认情况保持安静（避免每次启动都刷警告）
          if (bindHost !== DEFAULT_HOST) {
            console.log(chalk.yellow(`  监听地址: ${bindHost}（已放开非本地访问，请确认网络环境可信）`));
          }

          if (isGitRepo) {
            console.log(chalk.green(`  当前目录是Git仓库`));
          } else {
            console.log(chalk.yellow(`  当前目录不是Git仓库，文件监控未启动`));
          }

          console.log(chalk.green('======================================'));

          savePortToFile(currentPort);

          // 自拉起重启通知：父进程 spawn 时设置了 ZEN_RESTART_NOTIFY_PATH
          // 子进程成功 bind 端口后,把端口写到该文件作为"已就绪"信号
          // （instanceRegistry 在 EPERM 环境下不可用,这是回退通道）
          const notifyPath = process.env.ZEN_RESTART_NOTIFY_PATH;
          if (notifyPath && fsSync) {
            try {
              fsSync.writeFileSync(notifyPath, String(currentPort), 'utf8');
            } catch (_) {
              // 通知写失败不影响主流程
            }
          }

          if (!noOpen) {
            setTimeout(() => {
              open(`http://localhost:${currentPort}`);
            }, 0);
          }

          resolve();
        });
      });

      return currentPort;
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        logger.info(`端口 ${currentPort} 被占用，尝试下一个端口...`);
        currentPort++;
      } else {
        logger.error('启动服务器失败:', err);
        process.exit(1);
      }
    }
  }

  logger.error(`无法找到可用端口 (尝试范围: ${startPort}-${maxPort - 1})`);
  process.exit(1);
}

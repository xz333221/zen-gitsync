export async function startServerOnAvailablePort({
  httpServer,
  startPort,
  chalk,
  open,
  noOpen,
  isGitRepo,
  savePortToFile,
  maxTries = 100,
  callbackExecutedRef
}) {
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
        console.log(`尝试端口 ${currentPort}...`);
      }

      await new Promise((resolve, reject) => {
        const errorHandler = (err) => {
          httpServer.removeListener('error', errorHandler);
          reject(err);
        };

        httpServer.once('error', errorHandler);

        httpServer.listen(currentPort, () => {
          if (getCallbackExecuted()) return;
          setCallbackExecuted(true);

          httpServer.removeListener('error', errorHandler);

          console.log(chalk.green('======================================'));
          console.log(chalk.green(`  Zen GitSync 服务器已启动`));
          console.log(chalk.green(`  访问地址: http://localhost:${currentPort}`));
          console.log(chalk.green(`  启动时间: ${new Date().toLocaleString()}`));

          if (isGitRepo) {
            console.log(chalk.green(`  当前目录是Git仓库`));
          } else {
            console.log(chalk.yellow(`  当前目录不是Git仓库，文件监控未启动`));
          }

          console.log(chalk.green('======================================'));

          savePortToFile(currentPort);

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
        console.log(`端口 ${currentPort} 被占用，尝试下一个端口...`);
        currentPort++;
      } else {
        console.error('启动服务器失败:', err);
        process.exit(1);
      }
    }
  }

  console.error(`无法找到可用端口 (尝试范围: ${startPort}-${maxPort - 1})`);
  process.exit(1);
}

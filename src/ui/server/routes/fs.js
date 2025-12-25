export function registerFsRoutes({
  app,
  execGitCommand,
  configManager,
  io,
  chalk,
  fs,
  path,
  open,
  os,
  spawn,
  exec,
  getCurrentProjectPath,
  setCurrentProjectPath,
  getProjectRoomId,
  setProjectRoomId,
  setIsGitRepo
}) {
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
      const { path: reqPath } = req.body;

      if (!reqPath) {
        return res.status(400).json({ success: false, error: '目录路径不能为空' });
      }

      try {
        process.chdir(reqPath);
        const newDirectory = process.cwd();

        // 更新当前项目路径和房间ID
        const oldProjectPath = getCurrentProjectPath();
        const newProjectPath = newDirectory;
        const newProjectRoomId = `project:${newProjectPath.replace(/[\\/:*?"<>|\s]/g, '_')}`;

        console.log(chalk.yellow(`项目路径切换: ${oldProjectPath} -> ${newProjectPath}`));
        console.log(chalk.yellow(`房间ID更新: ${getProjectRoomId()} -> ${newProjectRoomId}`));

        // 检查新目录是否是Git仓库
        try {
          await execGitCommand('git rev-parse --is-inside-work-tree');

          // 更新全局变量
          setCurrentProjectPath(newProjectPath);
          setProjectRoomId(newProjectRoomId);
          setIsGitRepo(true);

          // 确保切换后立即初始化该项目的配置条目
          try {
            const currentCfg = await configManager.loadConfig();
            await configManager.saveConfig(currentCfg);
            // 将新目录加入最近目录
            await configManager.saveRecentDirectory(newDirectory);
          } catch (e) {
            console.warn('初始化项目配置失败:', e?.message || e);
          }

          // 通知所有旧房间的客户端项目已切换
          io.to(getProjectRoomId()).emit('project_changed', {
            oldProjectPath: getCurrentProjectPath(),
            newProjectPath: newProjectPath,
            newProjectRoomId: newProjectRoomId
          });

          res.json({
            success: true,
            directory: newDirectory,
            isGitRepo: true,
            projectRoomId: newProjectRoomId
          });
        } catch (error) {
          // 不是Git仓库，停止监控

          // 更新全局变量
          setCurrentProjectPath(newProjectPath);
          setProjectRoomId(newProjectRoomId);
          setIsGitRepo(false);

          // 通知所有旧房间的客户端项目已切换
          io.to(getProjectRoomId()).emit('project_changed', {
            oldProjectPath: getCurrentProjectPath(),
            newProjectPath: newProjectPath,
            newProjectRoomId: newProjectRoomId
          });

          // 即使不是Git仓库也初始化当前目录配置（使用CWD作为项目键）
          try {
            const currentCfg = await configManager.loadConfig();
            await configManager.saveConfig(currentCfg);
            // 将新目录加入最近目录
            await configManager.saveRecentDirectory(newDirectory);
          } catch (e) {
            console.warn('非Git目录初始化项目配置失败:', e?.message || e);
          }

          res.json({
            success: true,
            directory: newDirectory,
            isGitRepo: false,
            warning: '新目录不是一个Git仓库',
            projectRoomId: newProjectRoomId
          });
        }
      } catch (error) {
        res.status(400).json({
          success: false,
          error: `切换到目录 "${reqPath}" 失败: ${error.message}`
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

  // 在终端中打开当前目录
  app.post('/api/open_terminal', async (req, res) => {
    try {
      // 获取要打开的目录路径，如果没有提供，则使用当前目录
      const directoryPath = req.body.path || process.cwd();

      try {
        // 检查目录是否存在
        await fs.access(directoryPath);

        // 根据不同操作系统打开终端
        const platform = os.platform();
        let command;
        let args;

        switch (platform) {
          case 'win32':
            // Windows: 将start命令的参数分开传递，避免引号转义问题
            // 参数顺序：start [title] /D [path] [command]
            command = 'cmd';
            args = ['/c', 'start', '', '/D', directoryPath, 'cmd'];
            break;
          case 'darwin':
            // macOS: 使用 Terminal.app
            command = 'open';
            args = ['-a', 'Terminal', directoryPath];
            break;
          case 'linux': {
            // Linux: 尝试使用常见的终端模拟器
            // 优先级: gnome-terminal, konsole, xterm
            const terminals = [
              { cmd: 'gnome-terminal', args: ['--working-directory', directoryPath] },
              { cmd: 'konsole', args: ['--workdir', directoryPath] },
              { cmd: 'xterm', args: ['-e', `cd "${directoryPath}" && $SHELL`] }
            ];

            // 尝试找到可用的终端
            let terminalFound = false;
            for (const terminal of terminals) {
              try {
                exec(`which ${terminal.cmd}`, (error) => {
                  if (!error) {
                    command = terminal.cmd;
                    args = terminal.args;
                    terminalFound = true;
                  }
                });
                if (terminalFound) break;
              } catch (e) {
                continue;
              }
            }

            if (!terminalFound) {
              return res.status(400).json({
                success: false,
                error: '未找到可用的终端模拟器'
              });
            }
            break;
          }
          default:
            return res.status(400).json({
              success: false,
              error: `不支持的操作系统: ${platform}`
            });
        }

        // 执行命令打开终端
        spawn(command, args, {
          detached: true,
          stdio: 'ignore'
        }).unref();

        res.json({
          success: true,
          message: '已在终端中打开目录'
        });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: `无法打开终端 "${directoryPath}": ${error.message}`
        });
      }
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
}

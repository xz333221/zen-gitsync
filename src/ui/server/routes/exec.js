export function registerExecRoutes({
  app,
  execGitCommand,
  addCommandToHistory,
  getCurrentProjectPath,
  nextProcessId,
  runningProcesses,
  spawn,
  path,
  iconv
}) {
  // 通用命令执行接口（非流式）
  app.post('/api/exec', async (req, res) => {
    try {
      const { command } = req.body || {};
      if (!command || typeof command !== 'string' || !command.trim()) {
        return res.status(400).json({ success: false, error: 'command 不能为空' });
      }

      try {
        const { stdout = '', stderr = '' } = await execGitCommand(command, { log: false });
        return res.json({ success: true, stdout, stderr });
      } catch (err) {
        return res.status(400).json({ success: false, error: err?.message || String(err) });
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 流式执行命令接口（支持实时输出）
  app.post('/api/exec-stream', async (req, res) => {
    try {
      const { command, directory } = req.body || {};
      if (!command || typeof command !== 'string' || !command.trim()) {
        return res.status(400).json({ success: false, error: 'command 不能为空' });
      }

      const currentProjectPath = getCurrentProjectPath();

      // 确定执行目录
      const execDirectory = directory && directory.trim()
        ? (path.isAbsolute(directory) ? directory : path.join(currentProjectPath, directory))
        : currentProjectPath;

      console.log(`流式执行命令: ${command}`);
      console.log(`执行目录: ${execDirectory}`);

      // 分配进程 ID
      const processId = nextProcessId();

      // 设置响应头为流式传输
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // 禁用nginx缓冲

      // 记录执行开始时间（用于命令历史）
      const startTime = Date.now();

      // 用于收集输出（用于命令历史）
      let collectedStdout = '';
      let collectedStderr = '';

      // 使用 shell: true 来支持 Windows 内置命令（如 dir、cd 等）
      const childProcess = spawn(command.trim(), [], {
        cwd: execDirectory,
        shell: true, // 通过 shell 执行，支持 Windows 内置命令
        env: {
          ...process.env,
          // Git 配置：启用颜色输出和禁用路径引用
          GIT_CONFIG_PARAMETERS: "'color.ui=always' 'color.status=always' 'core.quotepath=false'",
          // 强制启用颜色输出 - 多种工具的配置
          FORCE_COLOR: '3', // 使用级别3（最强），支持 chalk 等库
          NPM_CONFIG_COLOR: 'always',
          TERM: 'xterm-256color', // 模拟256色终端环境
          COLORTERM: 'truecolor', // 支持真彩色
          CLICOLOR_FORCE: '1', // 强制启用颜色（某些工具检测此变量）
          // 确保输出不被缓冲
          PYTHONUNBUFFERED: '1'
          // 注意：不设置 CI=true 和 NO_COLOR，避免禁用颜色输出
        }
      });

      // 存储进程信息
      runningProcesses.set(processId, {
        childProcess,
        command: command.trim(),
        startTime,
        directory: execDirectory
      });
      console.log(`[进程管理] 创建进程 #${processId}: ${command.substring(0, 50)}`);

      // 发送数据到客户端的辅助函数
      const sendData = (type, data) => {
        const message = `data: ${JSON.stringify({ type, data })}\n\n`;
        // console.log(`[流式输出] 发送数据 - 类型: ${type}, 长度: ${data?.length || 0}`);
        res.write(message);
      };

      // 立即发送 processId 给前端
      sendData('process_id', processId);

      let outputReceived = false;

      // 判断是否需要 GBK 转换
      // 只有 Windows CMD 内置命令（如 dir、type 等）才需要 GBK 转换
      // npm、node、git 等现代工具都输出 UTF-8
      const isWindows = process.platform === 'win32';
      const cmdBuiltins = ['dir', 'type', 'echo', 'set', 'path', 'cd', 'md', 'rd', 'del', 'copy', 'move', 'ren'];
      const needsGbkConversion = isWindows && cmdBuiltins.some(builtin =>
        command.trim().toLowerCase().startsWith(builtin + ' ') ||
        command.trim().toLowerCase() === builtin
      );

      console.log(`[流式输出] 命令: ${command.substring(0, 50)}, 需要GBK转换: ${needsGbkConversion}`);

      // 监听标准输出
      childProcess.stdout?.on('data', (data) => {
        // data 是 Buffer 对象
        let output;
        if (needsGbkConversion) {
          // Windows CMD 内置命令，从 GBK 转换为 UTF-8
          output = iconv.decode(data, 'gbk');
          console.log(`[流式输出] 收到stdout(GBK转UTF8):`, output.substring(0, 200));
        } else {
          // 现代工具或 Unix 系统，直接使用 UTF-8
          output = data.toString('utf8');
          console.log(`[流式输出] 收到stdout(UTF8):`, output.substring(0, 200));
        }
        outputReceived = true;
        collectedStdout += output; // 收集输出用于历史记录
        sendData('stdout', output);
      });

      // 监听标准错误输出
      childProcess.stderr?.on('data', (data) => {
        // data 是 Buffer 对象
        let output;

        if (isWindows) {
          // Windows 平台需要智能检测编码
          // 先尝试 UTF-8 解码
          const utf8Output = data.toString('utf8');

          // 检测是否包含 UTF-8 替换字符（�），这通常表示解码失败
          // 如果没有替换字符且包含正常字符，说明是有效的 UTF-8
          if (!utf8Output.includes('�') || utf8Output.match(/[\u4e00-\u9fa5]/)) {
            // UTF-8 解码成功（包含有效中文或没有替换字符）
            output = utf8Output;
            console.log(`[流式输出] 收到stderr(UTF8):`, output.substring(0, 200));
          } else {
            // UTF-8 解码失败，尝试 GBK（可能是 CMD shell 的系统消息）
            try {
              output = iconv.decode(data, 'gbk');
              console.log(`[流式输出] 收到stderr(GBK转UTF8):`, output.substring(0, 200));
            } catch (e) {
              // GBK 也失败，使用原始 UTF-8 结果
              output = utf8Output;
              console.log(`[流式输出] GBK解码失败，使用UTF8:`, output.substring(0, 200));
            }
          }
        } else {
          // Unix系统，直接使用 UTF-8
          output = data.toString('utf8');
          console.log(`[流式输出] 收到stderr(UTF8):`, output.substring(0, 200));
        }

        outputReceived = true;
        collectedStderr += output; // 收集错误输出用于历史记录
        // 不再自动标记为错误，只显示 stderr 输出
        // Git 的警告信息会输出到 stderr 但退出码仍为 0
        sendData('stderr', output);
      });

      // 监听进程退出（exit 在流关闭前触发）
      childProcess.on('exit', (code, signal) => {
        // console.log(`[流式输出] 进程 exit 事件 - 代码: ${code}, 信号: ${signal}`);
      });

      // 监听进程关闭（close 在流关闭后触发）
      childProcess.on('close', (code, signal) => {
        // console.log(`[流式输出] 进程 close 事件 - 代码: ${code}, 信号: ${signal}, 有输出: ${outputReceived}`);

        // 从运行进程列表中移除
        runningProcesses.delete(processId);
        console.log(`[进程管理] 进程 #${processId} 已结束，剩余进程数: ${runningProcesses.size}`);

        // 计算执行时间
        const executionTime = Date.now() - startTime;

        // 添加到命令历史
        const error = code !== 0 ? `Command exited with code ${code}` : null;
        addCommandToHistory(
          command.trim(),
          collectedStdout,
          collectedStderr,
          error,
          executionTime
        );

        // 只根据退出码判断成功与否，退出码为 0 表示成功
        sendData('exit', { code, success: code === 0 });
        res.end();
      });

      // 监听错误
      childProcess.on('error', (error) => {
        // console.error(`[流式输出] 进程错误:`, error);

        // 从运行进程列表中移除
        runningProcesses.delete(processId);
        console.log(`[进程管理] 进程 #${processId} 出错并结束，剩余进程数: ${runningProcesses.size}`);

        // 添加到命令历史（错误情况）
        const executionTime = Date.now() - startTime;
        addCommandToHistory(
          command.trim(),
          collectedStdout,
          collectedStderr,
          error.message,
          executionTime
        );

        sendData('error', error.message);
        res.end();
      });

      // 添加spawn事件监听
      childProcess.on('spawn', () => {
        // console.log(`[流式输出] 进程已启动 - PID: ${childProcess.pid}`);
      });

      // 注意：不监听req.on('close')，参考git push的实现
      // 进程会自然结束，close事件会触发res.end()
      // 如果监听req.on('close')可能会导致进程被提前kill

    } catch (error) {
      console.error('流式执行命令失败:', error);
      res.status(500).json({
        success: false,
        error: `流式执行命令失败: ${error.message}`
      });
    }
  });
}

export function registerUiSocketHandlers({
  io,
  getProjectRoomId,
  getCurrentProjectPath,
  getAndBroadcastStatus,
  getCommandHistory,
  clearCommandHistory,
  addCommandToHistory,
  runningProcesses,
  nextProcessId,
  spawn,
  exec,
  path,
  iconv
}) {
  io.on('connection', (socket) => {
    console.log('客户端已连接:', socket.id);

    const projectRoomId = getProjectRoomId();
    socket.join(projectRoomId);
    console.log(`客户端 ${socket.id} 已加入房间: ${projectRoomId}`);

    getAndBroadcastStatus();

    const history = getCommandHistory();
    socket.emit('initial_command_history', { history });

    socket.on('request_full_history', () => {
      const fullHistory = getCommandHistory();
      socket.emit('full_command_history', { history: fullHistory });
    });

    socket.on('clear_command_history', () => {
      const result = clearCommandHistory();
      socket.emit('command_history_cleared', { success: result });
    });

    socket.on('exec_interactive', async (data) => {
      const { command, directory, sessionId } = data;

      if (!command || typeof command !== 'string' || !command.trim()) {
        socket.emit('interactive_error', {
          sessionId,
          error: 'command 不能为空'
        });
        return;
      }

      const currentProjectPath = getCurrentProjectPath();
      const execDirectory = directory && directory.trim()
        ? (path.isAbsolute(directory) ? directory : path.join(currentProjectPath, directory))
        : currentProjectPath;

      console.log(`[交互式命令] ${sessionId}: ${command} (目录: ${execDirectory})`);

      const processId = nextProcessId();
      const startTime = Date.now();

      let collectedStdout = '';
      let collectedStderr = '';

      const childProcess = spawn(command.trim(), [], {
        cwd: execDirectory,
        shell: true,
        env: {
          ...process.env,
          GIT_CONFIG_PARAMETERS: "'color.ui=always' 'color.status=always' 'core.quotepath=false'",
          FORCE_COLOR: '3',
          NPM_CONFIG_COLOR: 'always',
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          CLICOLOR_FORCE: '1',
          PYTHONUNBUFFERED: '1'
        }
      });

      runningProcesses.set(processId, {
        childProcess,
        command: command.trim(),
        startTime,
        directory: execDirectory,
        sessionId
      });

      console.log(`[交互式命令] 创建进程 #${processId}: ${command.substring(0, 50)}`);

      socket.emit('interactive_process_id', { sessionId, processId });

      const isWindows = process.platform === 'win32';
      const cmdBuiltins = ['dir', 'type', 'echo', 'set', 'path', 'cd', 'md', 'rd', 'del', 'copy', 'move', 'ren'];
      const needsGbkConversion = isWindows && cmdBuiltins.some(builtin =>
        command.trim().toLowerCase().startsWith(builtin + ' ') ||
        command.trim().toLowerCase() === builtin
      );

      childProcess.stdout?.on('data', (stdoutData) => {
        const output = needsGbkConversion ? iconv.decode(stdoutData, 'gbk') : stdoutData.toString('utf8');
        collectedStdout += output;
        socket.emit('interactive_stdout', { sessionId, data: output });
      });

      childProcess.stderr?.on('data', (stderrData) => {
        let output;

        if (isWindows) {
          const utf8Output = stderrData.toString('utf8');

          if (!utf8Output.includes('�') || utf8Output.match(/[\u4e00-\u9fa5]/)) {
            output = utf8Output;
          } else {
            try {
              output = iconv.decode(stderrData, 'gbk');
            } catch (e) {
              output = utf8Output;
            }
          }
        } else {
          output = stderrData.toString('utf8');
        }

        collectedStderr += output;
        socket.emit('interactive_stderr', { sessionId, data: output });
      });

      childProcess.on('close', (code, signal) => {
        runningProcesses.delete(processId);
        console.log(`[交互式命令] 进程 #${processId} 已结束`);

        const executionTime = Date.now() - startTime;
        const error = code !== 0 ? `Command exited with code ${code}` : null;
        addCommandToHistory(
          command.trim(),
          collectedStdout,
          collectedStderr,
          error,
          executionTime
        );

        socket.emit('interactive_exit', {
          sessionId,
          code,
          success: code === 0
        });
      });

      childProcess.on('error', (error) => {
        runningProcesses.delete(processId);
        console.error(`[交互式命令] 进程 #${processId} 出错:`, error);

        const executionTime = Date.now() - startTime;
        addCommandToHistory(
          command.trim(),
          collectedStdout,
          collectedStderr,
          error.message,
          executionTime
        );

        socket.emit('interactive_error', {
          sessionId,
          error: error.message
        });
      });

      socket.on(`interactive_stdin_${sessionId}`, (inputData) => {
        const { input } = inputData;
        console.log(`[交互式命令] 收到 stdin 输入 (${sessionId}):`, input);

        if (childProcess.stdin && !childProcess.stdin.destroyed) {
          try {
            childProcess.stdin.write(input + '\n');
          } catch (err) {
            console.error(`[交互式命令] 写入 stdin 失败:`, err);
            socket.emit('interactive_error', {
              sessionId,
              error: `写入输入失败: ${err.message}`
            });
          }
        }
      });

      socket.on(`interactive_stop_${sessionId}`, () => {
        console.log(`[交互式命令] 收到停止请求 (${sessionId})`);

        if (childProcess && !childProcess.killed) {
          try {
            if (process.platform === 'win32') {
              exec(`taskkill /pid ${childProcess.pid} /T /F`, (error) => {
                if (error) {
                  console.error(`[交互式命令] taskkill 失败:`, error);
                }
              });
            } else {
              childProcess.kill('SIGTERM');
              setTimeout(() => {
                if (!childProcess.killed) {
                  childProcess.kill('SIGKILL');
                }
              }, 2000);
            }
          } catch (err) {
            console.error(`[交互式命令] 停止进程失败:`, err);
          }
        }
      });
    });

    socket.on('disconnect', () => {
      console.log(`客户端已断开连接: ${socket.id} (房间: ${getProjectRoomId()})`);
    });
  });
}

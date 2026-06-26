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
import logger from '../utils/logger.js'
import { ensureWithinCwd } from '../utils/pathGuard.js'

// ─────────────────────────────────────────────────────────────────────────────
// exec_interactive 修复(SEC-INJ-1)
//
// 之前:`spawn(command.trim(), [], { shell: true })` — command 来自 socket,
// 直接交给 /bin/sh -c 或 cmd.exe /c 解释,任意 shell 都能跑(RCE)。
//
// 现在:用与 routes/exec.js 同样的 argv 拆分 + cmd.exe /c 内置分支策略,
// 完全不走 shell。
// ─────────────────────────────────────────────────────────────────────────────

const WIN_CMD_BUILTINS = new Set([
  'dir', 'type', 'echo', 'set', 'path', 'cd', 'md', 'rd', 'del',
  'copy', 'move', 'ren', 'cls', 'exit', 'title', 'ver', 'prompt',
]);

function splitCommandArgs(command) {
  const s = String(command || '');
  const out = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1]) {
      cur += s[i + 1];
      i++;
      continue;
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out.filter((t) => t.length > 0);
}

function resolveBinAndArgs(command) {
  const tokens = splitCommandArgs(command);
  if (tokens.length === 0) {
    throw new Error('command 不能为空');
  }
  const head = tokens[0];
  if (process.platform === 'win32' && WIN_CMD_BUILTINS.has(head.toLowerCase())) {
    return { bin: 'cmd.exe', args: ['/c', ...tokens] };
  }
  return { bin: head, args: tokens.slice(1) };
}

const INTERACTIVE_ENV = {
  ...process.env,
  GIT_CONFIG_PARAMETERS: "'color.ui=always' 'color.status=always' 'core.quotepath=false'",
  FORCE_COLOR: '3',
  NPM_CONFIG_COLOR: 'always',
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  CLICOLOR_FORCE: '1',
  PYTHONUNBUFFERED: '1',
};

function isWindowsBuiltin(command) {
  if (process.platform !== 'win32') return false;
  const first = splitCommandArgs(command)[0]?.toLowerCase();
  return first ? WIN_CMD_BUILTINS.has(first) : false;
}

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
    logger.info('客户端已连接:', socket.id);

    const projectRoomId = getProjectRoomId();
    socket.join(projectRoomId);
    logger.info(`客户端 ${socket.id} 已加入房间: ${projectRoomId}`);

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
      const { command, directory, sessionId } = data || {};

      if (!command || typeof command !== 'string' || !command.trim()) {
        socket.emit('interactive_error', {
          sessionId,
          error: 'command 不能为空'
        });
        return;
      }

      const currentProjectPath = getCurrentProjectPath();

      // 安全解析 directory:防止 chdir 到项目外
      let execDirectory = currentProjectPath;
      try {
        if (directory && String(directory).trim()) {
          const safe = await ensureWithinCwd(String(directory), currentProjectPath);
          if (!safe) {
            socket.emit('interactive_error', {
              sessionId,
              error: 'directory 必须在当前项目目录内'
            });
            return;
          }
          execDirectory = safe.safePath;
        }
      } catch (err) {
        socket.emit('interactive_error', { sessionId, error: err.message });
        return;
      }

      let bin, args;
      try {
        const resolved = resolveBinAndArgs(command);
        bin = resolved.bin;
        args = resolved.args;
      } catch (err) {
        socket.emit('interactive_error', { sessionId, error: err.message });
        return;
      }

      logger.info(`[交互式命令] ${sessionId}: ${bin} ${args.join(' ').substring(0, 80)} (目录: ${execDirectory})`);

      const processId = nextProcessId();
      const startTime = Date.now();

      let collectedStdout = '';
      let collectedStderr = '';
      let socketClosed = false;

      const childProcess = spawn(bin, args, {
        cwd: execDirectory,
        env: INTERACTIVE_ENV,
      });

      runningProcesses.set(processId, {
        childProcess,
        command: `${bin} ${args.join(' ')}`.trim(),
        startTime,
        directory: execDirectory,
        sessionId
      });

      logger.info(`[交互式命令] 创建进程 #${processId}: ${bin} ${args.join(' ').substring(0, 50)}`);

      socket.emit('interactive_process_id', { sessionId, processId });

      const cmdBuiltins = ['dir', 'type', 'echo', 'set', 'path', 'cd', 'md', 'rd', 'del', 'copy', 'move', 'ren'];
      const needsGbkConversion = isWindowsBuiltin(command) && cmdBuiltins.some(builtin => {
        const first = splitCommandArgs(command)[0]?.toLowerCase();
        return first === builtin;
      });

      childProcess.stdout?.on('data', (stdoutData) => {
        const output = needsGbkConversion ? iconv.decode(stdoutData, 'gbk') : stdoutData.toString('utf8');
        collectedStdout += output;
        if (!socketClosed) socket.emit('interactive_stdout', { sessionId, data: output });
      });

      childProcess.stderr?.on('data', (stderrData) => {
        let output;
        if (process.platform === 'win32') {
          const utf8Output = stderrData.toString('utf8');
          if (!utf8Output.includes('�') || utf8Output.match(/[一-龥]/)) {
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
        if (!socketClosed) socket.emit('interactive_stderr', { sessionId, data: output });
      });

      childProcess.on('close', (code, signal) => {
        runningProcesses.delete(processId);
        logger.info(`[交互式命令] 进程 #${processId} 已结束`);

        const executionTime = Date.now() - startTime;
        const error = code !== 0 ? `Command exited with code ${code}` : null;
        addCommandToHistory(
          `${bin} ${args.join(' ')}`.trim(),
          collectedStdout,
          collectedStderr,
          error,
          executionTime
        );

        if (!socketClosed) {
          socket.emit('interactive_exit', {
            sessionId,
            code,
            success: code === 0
          });
        }
      });

      childProcess.on('error', (error) => {
        runningProcesses.delete(processId);
        logger.error(`[交互式命令] 进程 #${processId} 出错:`, error);

        const executionTime = Date.now() - startTime;
        addCommandToHistory(
          `${bin} ${args.join(' ')}`.trim(),
          collectedStdout,
          collectedStderr,
          error.message,
          executionTime
        );

        if (!socketClosed) {
          socket.emit('interactive_error', {
            sessionId,
            error: error.message
          });
        }
      });

      socket.on(`interactive_stdin_${sessionId}`, (inputData) => {
        if (socketClosed) return;
        const { input } = inputData || {};
        logger.info(`[交互式命令] 收到 stdin 输入 (${sessionId})`);

        if (childProcess.stdin && !childProcess.stdin.destroyed) {
          try {
            childProcess.stdin.write(input + '\n');
          } catch (err) {
            logger.error(`[交互式命令] 写入 stdin 失败:`, err);
            socket.emit('interactive_error', {
              sessionId,
              error: `写入输入失败: ${err.message}`
            });
          }
        }
      });

      socket.on(`interactive_stop_${sessionId}`, () => {
        logger.info(`[交互式命令] 收到停止请求 (${sessionId})`);

        if (childProcess && !childProcess.killed) {
          try {
            if (process.platform === 'win32') {
              exec(`taskkill /pid ${childProcess.pid} /T /F`, (error) => {
                if (error) {
                  logger.error(`[交互式命令] taskkill 失败:`, error);
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
            logger.error(`[交互式命令] 停止进程失败:`, err);
          }
        }
      });

      // socket disconnect → 子进程也要清理,否则孤儿进程会一直跑
      socket.on('disconnect', () => {
        socketClosed = true;
        if (childProcess && !childProcess.killed) {
          try {
            if (process.platform === 'win32') {
              exec(`taskkill /pid ${childProcess.pid} /T /F`, () => {});
            } else {
              childProcess.kill('SIGTERM');
              setTimeout(() => {
                if (!childProcess.killed) {
                  try { childProcess.kill('SIGKILL'); } catch { /* ignore */ }
                }
              }, 2000);
            }
          } catch (e) {
            logger.warn('[exec-interactive] 断连后清理子进程失败:', e?.message || e);
          }
        }
      });
    });

    socket.on('disconnect', () => {
      logger.info(`客户端已断开连接: ${socket.id} (房间: ${getProjectRoomId()})`);
    });
  });
}
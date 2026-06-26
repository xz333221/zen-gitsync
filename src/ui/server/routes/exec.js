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
import path from 'path';
import logger from '../utils/logger.js'
import iconv from 'iconv-lite';
import { spawn } from 'child_process';
import { ensureWithinCwd } from '../utils/pathGuard.js';
import { asyncRoute, HttpError } from '../utils/asyncRoute.js';

// ─────────────────────────────────────────────────────────────────────────────
// 命令 → argv 拆分(SEC-INJ-2 修复)
//
// 之前走 spawn(command.trim(), [], { shell: true }) — `command` 直接来自
// socket payload,任意 shell 都能跑(RCE 类)。改为 argv 模式:
//   - 通过 token 拆分 + 简单引号解析,把 "git commit -m 'fix bug'" 拆成
//     ['git', 'commit', '-m', 'fix bug']
//   - 内置命令(dir / cd / echo 等 Windows CMD 必需)走专门分支,用数组参数
//     调 spawn,不经过 shell
//
// 风险:`&&` `;` `|` 这类 shell 操作符被吞掉(从 token 一层就拆出字面字符,
// 不会被解释为元字符)。这是有意为之 — 想用链式请在前端 UI 拼好,不在
// 这里冒险跑 shell。
// ─────────────────────────────────────────────────────────────────────────────
function splitCommandArgs(command) {
  const s = String(command || '');
  const out = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1]) {
      // 在双引号外保留转义;在双引号内只保留 \", \\, \$, \`, \n, \t 这几类
      // 为简单起见一律保留下一字符
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

// Windows CMD 内置命令白名单 — 走 cmd /c <argv> 模式,不经过 shell:true
// argv 用数组,即便用户输入 `dir & del /` 也只是字面字符不会被解释
const WIN_CMD_BUILTINS = new Set([
  'dir', 'type', 'echo', 'set', 'path', 'cd', 'md', 'rd', 'del',
  'copy', 'move', 'ren', 'cls', 'exit', 'title', 'ver', 'prompt',
]);

/**
 * 把 "dir C:\\foo" 这类字符串拆成 (bin, argv) 形式
 * - 如果首 token 是 cmd 内置 → bin='cmd.exe', argv=['/c', ...原始 tokens]
 * - 否则 → bin=首 token, argv=剩余
 */
function resolveBinAndArgs(command) {
  const tokens = splitCommandArgs(command);
  if (tokens.length === 0) {
    throw new HttpError(400, 'command 不能为空');
  }
  const head = tokens[0];
  if (process.platform === 'win32' && WIN_CMD_BUILTINS.has(head.toLowerCase())) {
    // 内置命令通过 cmd /c 调用,argv 数组传入,不会走 shell 解析
    return { bin: 'cmd.exe', args: ['/c', ...tokens] };
  }
  return { bin: head, args: tokens.slice(1) };
}

// 通用 env 模板 — 颜色 + 终端兼容性,所有 exec 流式 / 交互式复用
const CHILD_ENV_TEMPLATE = {
  ...process.env,
  GIT_CONFIG_PARAMETERS: "'color.ui=always' 'color.status=always' 'core.quotepath=false'",
  FORCE_COLOR: '3',
  NPM_CONFIG_COLOR: 'always',
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  CLICOLOR_FORCE: '1',
  PYTHONUNBUFFERED: '1',
};

function isWindowsBuiltinCommand(command) {
  if (process.platform !== 'win32') return false;
  const first = splitCommandArgs(command)[0]?.toLowerCase();
  return first ? WIN_CMD_BUILTINS.has(first) : false;
}

export function registerExecRoutes({
  app,
  execGitCommand,
  addCommandToHistory,
  getCurrentProjectPath,
  nextProcessId,
  runningProcesses
}) {
  // 通用命令执行接口（非流式）— 走 argv 模式,无 shell
  app.post('/api/exec', asyncRoute(async (req, res) => {
    try {
      const { command } = req.body || {};
      if (!command || typeof command !== 'string' || !command.trim()) {
        return res.status(400).json({ success: false, error: 'command 不能为空' });
      }

      try {
        // execGitCommand 本身已经走 execFile argv 模式(见 utils/index.js)
        // 这里保持调用形态兼容
        const { stdout = '', stderr = '' } = await execGitCommand(splitCommandArgs(command), { log: false });
        return res.json({ success: true, stdout, stderr });
      } catch (err) {
        return res.status(400).json({ success: false, error: err?.message || String(err) });
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }));

  // 流式执行命令接口(支持实时输出)— argv 模式 + cwd 校验
  app.post('/api/exec-stream', asyncRoute(async (req, res) => {
    try {
      const { command, directory } = req.body || {};
      if (!command || typeof command !== 'string' || !command.trim()) {
        return res.status(400).json({ success: false, error: 'command 不能为空' });
      }

      const currentProjectPath = getCurrentProjectPath();

      // 安全解析 directory:只能指向项目 cwd 内的子目录,防止 chdir 到任意路径
      let execDirectory = currentProjectPath;
      if (directory && String(directory).trim()) {
        const safe = await ensureWithinCwd(String(directory), currentProjectPath);
        if (!safe) {
          throw new HttpError(403, 'directory 必须在当前项目目录内');
        }
        execDirectory = safe.safePath;
      }

      const { bin, args } = resolveBinAndArgs(command);

      logger.info(`流式执行命令: ${bin} ${args.join(' ').substring(0, 80)}`);
      logger.info(`执行目录: ${execDirectory}`);

      const processId = nextProcessId();

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const startTime = Date.now();
      let collectedStdout = '';
      let collectedStderr = '';
      let clientClosed = false;

      // spawn(bin, argv, { shell: false }) — 不走 shell,无注入
      const childProcess = spawn(bin, args, {
        cwd: execDirectory,
        env: CHILD_ENV_TEMPLATE,
      });

      runningProcesses.set(processId, {
        childProcess,
        command: `${bin} ${args.join(' ')}`.trim(),
        startTime,
        directory: execDirectory
      });
      logger.info(`[进程管理] 创建进程 #${processId}: ${bin} ${args.join(' ').substring(0, 50)}`);

      const sendData = (type, data) => {
        if (clientClosed) return;
        try {
          const message = `data: ${JSON.stringify({ type, data })}\n\n`;
          res.write(message);
        } catch {
          // res 已关闭,忽略
        }
      };

      sendData('process_id', processId);

      let outputReceived = false;

      const isWindows = process.platform === 'win32';
      const cmdBuiltins = ['dir', 'type', 'set', 'path', 'cd', 'md', 'rd', 'del', 'copy', 'move', 'ren'];

      // echo 命令特殊处理:如果包含变量替换(如 {{xxx}}),内容可能已经是 UTF-8
      const trimmed = command.trim().toLowerCase();
      const firstToken = trimmed.split(/\s+/, 1)[0] || '';
      const isEchoCommand = firstToken === 'echo';
      const hasVariableSubstitution = isEchoCommand && (
        command.includes('{{') ||
        command.includes('${') ||
        command.includes('%')
      );

      // 必须按 token 边界判断,避免 'dir' 误匹配 'directory'
      const needsGbkConversion = isWindowsBuiltinCommand(command) && (
        cmdBuiltins.includes(firstToken) ||
        (isEchoCommand && !hasVariableSubstitution)
      );

      logger.info(`[流式输出] 命令: ${bin} ${args.join(' ').substring(0, 50)}, 需要GBK转换: ${needsGbkConversion}`);

      childProcess.stdout?.on('data', (data) => {
        let output;
        if (needsGbkConversion) {
          output = iconv.decode(data, 'gbk');
          logger.info(`[流式输出] 收到stdout(GBK转UTF8):`, output.substring(0, 200));
        } else {
          output = data.toString('utf8');
          logger.info(`[流式输出] 收到stdout(UTF8):`, output.substring(0, 200));
        }
        outputReceived = true;
        collectedStdout += output;
        sendData('stdout', output);
      });

      childProcess.stderr?.on('data', (data) => {
        let output;
        if (isWindows) {
          const utf8Output = data.toString('utf8');
          if (!utf8Output.includes('�') || utf8Output.match(/[一-龥]/)) {
            output = utf8Output;
            logger.info(`[流式输出] 收到stderr(UTF8):`, output.substring(0, 200));
          } else {
            try {
              output = iconv.decode(data, 'gbk');
              logger.info(`[流式输出] 收到stderr(GBK转UTF8):`, output.substring(0, 200));
            } catch (e) {
              output = utf8Output;
              logger.info(`[流式输出] GBK解码失败,使用UTF8:`, output.substring(0, 200));
            }
          }
        } else {
          output = data.toString('utf8');
          logger.info(`[流式输出] 收到stderr(UTF8):`, output.substring(0, 200));
        }

        outputReceived = true;
        collectedStderr += output;
        sendData('stderr', output);
      });

      childProcess.on('close', (code, signal) => {
        runningProcesses.delete(processId);
        logger.info(`[进程管理] 进程 #${processId} 已结束,剩余进程数: ${runningProcesses.size}`);

        const executionTime = Date.now() - startTime;
        const error = code !== 0 ? `Command exited with code ${code}` : null;
        addCommandToHistory(
          `${bin} ${args.join(' ')}`.trim(),
          collectedStdout,
          collectedStderr,
          error,
          executionTime
        );

        sendData('exit', { code, success: code === 0 });
        try { res.end(); } catch { /* ignore */ }
      });

      childProcess.on('error', (error) => {
        runningProcesses.delete(processId);
        logger.info(`[进程管理] 进程 #${processId} 出错并结束,剩余进程数: ${runningProcesses.size}`);

        const executionTime = Date.now() - startTime;
        addCommandToHistory(
          `${bin} ${args.join(' ')}`.trim(),
          collectedStdout,
          collectedStderr,
          error.message,
          executionTime
        );

        sendData('error', error.message);
        try { res.end(); } catch { /* ignore */ }
      });

      // 客户端 disconnect → 主动 SIGTERM,防止孤儿进程
      req.on('close', () => {
        clientClosed = true;
        if (childProcess && !childProcess.killed) {
          try {
            childProcess.kill('SIGTERM');
            setTimeout(() => {
              if (!childProcess.killed) {
                try { childProcess.kill('SIGKILL'); } catch { /* ignore */ }
              }
            }, 2000);
          } catch (e) {
            logger.warn('[exec-stream] 客户端断连后 kill 子进程失败:', e?.message || e);
          }
        }
      });
    } catch (error) {
      logger.error('流式执行命令失败:', error);
      // SSE 流已设置 Content-Type,只能写普通错误消息 + end()
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: `流式执行命令失败: ${error.message}`
        });
      } else {
        try {
          res.write(`data: ${JSON.stringify({ type: 'error', data: error.message })}\n\n`);
          res.end();
        } catch { /* ignore */ }
      }
    }
  }));
}
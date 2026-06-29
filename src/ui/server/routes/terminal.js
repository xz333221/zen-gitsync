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
import { spawn, exec } from 'child_process';
import logger from '../utils/logger.js'
import { psEscape, appleEscape, shQuote } from '../utils/shellQuote.js';
import { asyncRoute, HttpError } from '../utils/asyncRoute.js';

export function registerTerminalRoutes({
  app,
  getCurrentProjectPath,
  nextTerminalSessionId,
  terminalSessions
}) {
  async function startTerminalProcess({ command, workingDirectory }) {
    const targetDir = workingDirectory || getCurrentProjectPath();

    if (process.platform === 'win32') {
      const cmdToRun = String(command || '').trim();

      const splitArgs = (input) => {
        const s = String(input || '');
        const out = [];
        let cur = '';
        let inQuotes = false;
        for (let i = 0; i < s.length; i++) {
          const ch = s[i];
          if (ch === '"') {
            if (inQuotes && s[i + 1] === '"') {
              cur += '"';
              i++;
              continue;
            }
            inQuotes = !inQuotes;
            continue;
          }
          if (!inQuotes && /\s/.test(ch)) {
            if (cur) out.push(cur);
            cur = '';
            continue;
          }
          cur += ch;
        }
        if (cur) out.push(cur);
        return out;
      };

      const isUrl = (v) => /^https?:\/\//i.test(String(v || '').trim());

      const tokens = splitArgs(cmdToRun);
      const isStartCommand = tokens.length > 0 && String(tokens[0]).toLowerCase() === 'start';

      // PowerShell 转义全部走 shellQuote.psEscape ($ ` " 都会被处理)
      let psScript;
      if (isStartCommand) {
        const args = tokens.slice(1);
        const first = args[0];
        const second = args[1];
        const candidateExe = first === '' ? second : first;
        const candidateUrl = isUrl(first) ? first : isUrl(second) ? second : null;
        const exe = candidateExe && !isUrl(candidateExe) ? String(candidateExe) : null;

        if (!exe && candidateUrl) {
          psScript = `$p = Start-Process -FilePath "${psEscape(candidateUrl)}" -WorkingDirectory "${psEscape(targetDir)}" -PassThru; Write-Output $p.Id`;
        } else if (exe && candidateUrl) {
          psScript = `$p = Start-Process -FilePath "${psEscape(exe)}" -ArgumentList "${psEscape(candidateUrl)}" -WorkingDirectory "${psEscape(targetDir)}" -PassThru; Write-Output $p.Id`;
        } else {
          psScript = `$p = Start-Process -FilePath "cmd.exe" -ArgumentList "/C", "${psEscape(cmdToRun)}" -WorkingDirectory "${psEscape(targetDir)}" -WindowStyle Hidden -PassThru; Write-Output $p.Id`;
        }
      } else {
        psScript = `$p = Start-Process -FilePath "cmd.exe" -ArgumentList "/K", "${psEscape(cmdToRun)}" -WorkingDirectory "${psEscape(targetDir)}" -PassThru; Write-Output $p.Id`;
      }

      return await new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-Command', psScript], {
          windowsHide: true
        });

        let out = '';
        let err = '';

        child.stdout?.on('data', (d) => {
          out += d.toString('utf8');
        });

        child.stderr?.on('data', (d) => {
          err += d.toString('utf8');
        });

        child.on('error', (e) => reject(e));

        child.on('close', (code) => {
          if (code !== 0) {
            return reject(new Error(err || `Start-Process 失败，退出码: ${code}`));
          }

          const pid = parseInt(String(out).trim(), 10);
          if (!Number.isFinite(pid)) {
            return reject(new Error(`无法获取终端 PID: ${out || err || 'unknown'}`));
          }

          resolve({ pid });
        });
      });
    }

    if (process.platform === 'darwin') {
      // AppleScript 转义统一走 shellQuote.appleEscape (\ " 都会被处理)
      const script = `tell application "Terminal" to do script "cd ${appleEscape(targetDir)} && ${appleEscape(command.trim())}"`;
      // 外层用单引号包,把脚本里可能出现的单引号转义为 '\''
      exec(`osascript -e ${shQuote(script)}`, (error) => {
        if (error) {
          logger.error('打开终端失败:', error);
        }
      });
      return { pid: null };
    }

    // Linux: 用 sh 单引号包命令行,单引号内不解释 $ ` " \ ,只把单引号自身 '\''
    const terminalCommand = `gnome-terminal -- bash -c ${shQuote(`cd ${targetDir} && ${command.trim()}; exec bash`)} || xterm -e ${shQuote(`cd ${targetDir} && ${command.trim()}; bash`)}`;
    exec(terminalCommand, (error) => {
      if (error) {
        logger.error('打开终端失败:', error);
      }
    });
    return { pid: null };
  }

  // 在新终端中执行自定义命令
  app.post('/api/exec-in-terminal', asyncRoute(async (req, res) => {
      try {
        const { command, workingDirectory } = req.body || {};
        if (!command || typeof command !== 'string' || !command.trim()) {
          throw new HttpError(400, 'command 不能为空');
        }
      
        const targetDir = workingDirectory || getCurrentProjectPath();
        logger.info(`在终端中执行命令: ${command}`);
        logger.info(`工作目录: ${targetDir}`);
      
        const terminalSessionId = nextTerminalSessionId();
        const now = Date.now();
        terminalSessions.set(terminalSessionId, {
          id: terminalSessionId,
          command: command.trim(),
          workingDirectory: targetDir,
          pid: null,
          createdAt: now,
          lastStartedAt: now
        });
      
        const { pid } = await startTerminalProcess({ command, workingDirectory: targetDir });
        const session = terminalSessions.get(terminalSessionId);
        if (session) {
          session.pid = pid;
          session.lastStartedAt = Date.now();
          terminalSessions.set(terminalSessionId, session);
        }
      
        res.json({
          success: true,
          message: `已在新终端中执行命令`,
          session: terminalSessions.get(terminalSessionId)
        });
      } catch (error) {
        logger.error('在终端中执行命令失败:', error);
        res.status(500).json({
          success: false,
          error: `在终端中执行命令失败: ${error.message}`
        });
      }
    }));

  app.get('/api/terminal-sessions', asyncRoute(async (req, res) => {
      try {
        const sessions = Array.from(terminalSessions.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        res.json({ success: true, sessions });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    }));

  function killTerminalPid(pid) {
    if (!pid) return;

    if (process.platform === 'win32') {
      exec(`taskkill /pid ${pid} /T /F`, (error) => {
        if (error) {
          logger.warn(`[终端会话] taskkill 失败(可忽略): ${error?.message || error}`);
        }
      });
      return;
    }

    try {
      process.kill(pid, 'SIGTERM');
    } catch (e) {
      // ignore
    }
  }

  // process.kill(pid, 0) 跨平台探测进程存活（信号 0 = 只探测不发信号）。
  // 原实现 Windows 分支 spawn powershell.exe 冷启动 1-2s/次，N 个 session 累积
  // 让 /api/terminal-sessions/status 耗时 15-29s；改用 process.kill 后 <1ms/次。
  // Node 在 Windows 上用 OpenProcess 模拟信号 0，语义与 POSIX 一致：
  //   - 进程存在 → 无错返回 true
  //   - 进程不存在 → 抛 ESRCH → false
  //   - 无权限 → 抛 EPERM → true（进程存在但属于其他用户）
  async function isPidAlive(pid) {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      if (e.code === 'EPERM') return true;
      return false;
    }
  }

  app.post('/api/terminal-sessions/:id/restart', asyncRoute(async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) {
          throw new HttpError(400, 'id 非法');
        }
      
        const session = terminalSessions.get(id);
        if (!session) {
          throw new HttpError(404, `终端会话 #${id} 不存在`);
        }
      
        const oldPid = session.pid;
        if (oldPid) {
          killTerminalPid(oldPid);
        }
      
        const { pid } = await startTerminalProcess({ command: session.command, workingDirectory: session.workingDirectory });
        session.pid = pid;
        session.lastStartedAt = Date.now();
        terminalSessions.set(id, session);
      
        res.json({ success: true, session });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    }));

  app.get('/api/terminal-sessions/status', asyncRoute(async (req, res) => {
      try {
        const cleanup = String(req.query.cleanup || 'false') === 'true';
        const sessions = Array.from(terminalSessions.values());
        const results = await Promise.all(sessions.map(async (s) => {
          const alive = s?.pid ? await isPidAlive(s.pid) : false;
          return { ...s, alive };
        }));
      
        if (cleanup) {
          const PROTECT_DURATION_MS = 10000; // 刚启动的进程保护期 10 秒
          const now = Date.now();
          for (const s of results) {
            if (s.pid && !s.alive) {
              // 如果会话刚刚启动（10秒内），即使检测不到进程也不删除，给进程启动留时间
              const lastStarted = s.lastStartedAt || s.createdAt || 0;
              if (now - lastStarted < PROTECT_DURATION_MS) {
                continue;
              }
              terminalSessions.delete(s.id);
            }
          }
        }
      
        const output = cleanup
          ? Array.from(terminalSessions.values()).map((s) => {
              const found = results.find(r => r.id === s.id);
              return { ...s, alive: found?.alive ?? false };
            }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
          : results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      
        res.json({ success: true, sessions: output });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    }));

  app.delete('/api/terminal-sessions/:id', asyncRoute(async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) {
          throw new HttpError(400, 'id 非法');
        }
      
        const session = terminalSessions.get(id);
        if (!session) {
          throw new HttpError(404, `终端会话 #${id} 不存在`);
        }
      
        if (session.pid) {
          killTerminalPid(session.pid);
        }
      
        terminalSessions.delete(id);
        res.json({ success: true, removedId: id });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    }));
}

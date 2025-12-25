export function registerTerminalRoutes({
  app,
  getCurrentProjectPath,
  nextTerminalSessionId,
  terminalSessions,
  spawn,
  exec
}) {
  async function startTerminalProcess({ command, workingDirectory }) {
    const targetDir = workingDirectory || getCurrentProjectPath();

    if (process.platform === 'win32') {
      const cmdToRun = command.trim();
      const safeWorkingDir = String(targetDir).replace(/"/g, '""');
      const safeCmd = String(cmdToRun).replace(/"/g, '""');

      const psScript = `$p = Start-Process -FilePath "cmd.exe" -ArgumentList "/K", "${safeCmd}" -WorkingDirectory "${safeWorkingDir}" -PassThru; Write-Output $p.Id`;

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
      const script = `tell application "Terminal" to do script "cd ${targetDir} && ${command.trim()}"`;
      exec(`osascript -e '${script}'`, (error) => {
        if (error) {
          console.error('打开终端失败:', error);
        }
      });
      return { pid: null };
    }

    const terminalCommand = `gnome-terminal -- bash -c "cd ${targetDir} && ${command.trim()}; exec bash" || xterm -e "cd ${targetDir} && ${command.trim()}; bash"`;
    exec(terminalCommand, (error) => {
      if (error) {
        console.error('打开终端失败:', error);
      }
    });
    return { pid: null };
  }

  // 在新终端中执行自定义命令
  app.post('/api/exec-in-terminal', async (req, res) => {
    try {
      const { command, workingDirectory } = req.body || {};
      if (!command || typeof command !== 'string' || !command.trim()) {
        return res.status(400).json({ success: false, error: 'command 不能为空' });
      }

      const targetDir = workingDirectory || getCurrentProjectPath();
      console.log(`在终端中执行命令: ${command}`);
      console.log(`工作目录: ${targetDir}`);

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
      console.error('在终端中执行命令失败:', error);
      res.status(500).json({
        success: false,
        error: `在终端中执行命令失败: ${error.message}`
      });
    }
  });

  app.get('/api/terminal-sessions', async (req, res) => {
    try {
      const sessions = Array.from(terminalSessions.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      res.json({ success: true, sessions });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  function killTerminalPid(pid) {
    if (!pid) return;

    if (process.platform === 'win32') {
      exec(`taskkill /pid ${pid} /T /F`, (error) => {
        if (error) {
          console.warn(`[终端会话] taskkill 失败(可忽略): ${error?.message || error}`);
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

  async function isPidAlive(pid) {
    if (!pid) return false;

    if (process.platform === 'win32') {
      const script = `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Out-Null; if ($?) { exit 0 } else { exit 1 }`;
      return await new Promise((resolve) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true });
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
      });
    }

    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  app.post('/api/terminal-sessions/:id/restart', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ success: false, error: 'id 非法' });
      }

      const session = terminalSessions.get(id);
      if (!session) {
        return res.status(404).json({ success: false, error: `终端会话 #${id} 不存在` });
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
  });

  app.get('/api/terminal-sessions/status', async (req, res) => {
    try {
      const cleanup = String(req.query.cleanup || 'false') === 'true';
      const sessions = Array.from(terminalSessions.values());
      const results = await Promise.all(sessions.map(async (s) => {
        const alive = s?.pid ? await isPidAlive(s.pid) : false;
        return { ...s, alive };
      }));

      if (cleanup) {
        for (const s of results) {
          if (s.pid && !s.alive) {
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
  });

  app.delete('/api/terminal-sessions/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ success: false, error: 'id 非法' });
      }

      const session = terminalSessions.get(id);
      if (!session) {
        return res.status(404).json({ success: false, error: `终端会话 #${id} 不存在` });
      }

      if (session.pid) {
        killTerminalPid(session.pid);
      }

      terminalSessions.delete(id);
      res.json({ success: true, removedId: id });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
}

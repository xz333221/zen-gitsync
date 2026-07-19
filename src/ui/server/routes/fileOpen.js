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
import fs from 'fs/promises';
import { asyncRoute, HttpError } from '../utils/asyncRoute.js';
import path from 'path';
import open from 'open';
import { spawn, spawnSync } from 'child_process';

function spawnDetached(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      ...options
    });

    child.on('error', reject);
    child.on('spawn', () => {
      child.unref();
      resolve('success');
    });
  });
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Linux 终端模拟器探测顺序：x-terminal-emulator 是 Debian/Ubuntu alternatives
// 指向用户默认终端的通用入口，优先使用；其余为常见桌面终端的兜底
const LINUX_TERMINALS = [
  { cmd: 'x-terminal-emulator', args: (shell) => ['-e', 'bash', '-c', shell] },
  { cmd: 'gnome-terminal', args: (shell) => ['--', 'bash', '-c', shell] },
  { cmd: 'konsole', args: (shell) => ['-e', 'bash', '-c', shell] },
  { cmd: 'xfce4-terminal', args: (shell) => ['-x', 'bash', '-c', shell] },
  { cmd: 'mate-terminal', args: (shell) => ['-e', `bash -c ${shQuote(shell)}`] },
  { cmd: 'alacritty', args: (shell) => ['-e', 'bash', '-c', shell] },
  { cmd: 'kitty', args: (shell) => ['bash', '-c', shell] },
  { cmd: 'xterm', args: (shell) => ['-e', 'bash', '-c', shell] },
];

function findLinuxTerminal() {
  for (const term of LINUX_TERMINALS) {
    const r = spawnSync('which', [term.cmd], { stdio: 'pipe' });
    if (r.status === 0) return term;
  }
  return null;
}

// 拼一段在终端里执行的 shell：先 cd 到目标目录再启动 CLI；
// 进程非零退出时停住窗口，否则 CLI 启动失败会秒关窗口，用户看不到任何报错
function buildTerminalShell(dirPath, command, cliArgs) {
  const cmdStr = [command, ...cliArgs].map(shQuote).join(' ');
  return `cd ${shQuote(dirPath)} && ${cmdStr}; rc=$?; if [ $rc -ne 0 ]; then echo; echo "${command} 退出码 $rc，按回车关闭窗口"; read -r _; fi`;
}

// Linux/macOS 没有统一的"新开终端窗口"API：直接 spawn TUI 程序只会在后台
// 跑一个无 TTY 的进程（stdio 被 ignore），用户屏幕上看不到任何东西，
// 必须显式起终端模拟器把命令跑在窗口里
async function launchInTerminal(dirPath, command, cliArgs = []) {
  const shell = buildTerminalShell(dirPath, command, cliArgs);

  if (process.platform === 'darwin') {
    const script = `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(shell)}\nend tell`;
    return spawnDetached('osascript', ['-e', script]);
  }

  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error('当前会话没有图形环境（DISPLAY / WAYLAND_DISPLAY 均为空），无法打开终端窗口');
  }
  const term = findLinuxTerminal();
  if (!term) {
    throw new Error('未检测到可用的终端模拟器（gnome-terminal / konsole / xterm 等）');
  }
  return spawnDetached(term.cmd, term.args(shell));
}

async function launchClaudeCode(dirPath, { permissionMode } = {}) {
  // 透传可选的权限模式参数到 claude CLI（如 acceptEdits）
  // 注意：permissionMode 必须是一个 token 字符串，避免 shell 注入
  const SAFE_MODE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
  const cliArgs = [];
  if (permissionMode && typeof permissionMode === 'string' && SAFE_MODE.test(permissionMode)) {
    cliArgs.push('--permission-mode', permissionMode);
  }

  if (process.platform === 'win32') {
    return spawnDetached('cmd.exe', ['/c', 'start', '""', 'claude', ...cliArgs], {
      cwd: dirPath
    });
  }

  return launchInTerminal(dirPath, 'claude', cliArgs);
}

async function launchCodex(dirPath) {
  // OpenAI Codex CLI - 无 permissionMode 参数(与 claude 不同)
  if (process.platform === 'win32') {
    return spawnDetached('cmd.exe', ['/c', 'start', '""', 'codex'], {
      cwd: dirPath
    });
  }
  return launchInTerminal(dirPath, 'codex');
}

async function launchOpenCode(dirPath) {
  // opencode (sst/opencode) CLI - https://opencode.ai
  if (process.platform === 'win32') {
    return spawnDetached('cmd.exe', ['/c', 'start', '""', 'opencode'], {
      cwd: dirPath
    });
  }
  return launchInTerminal(dirPath, 'opencode');
}

export function registerFileOpenRoutes({
  app
}) {
  // 打开文件
  app.post('/api/open-file', asyncRoute(async (req, res) => {
      try {
        const { filePath, context } = req.body;
      
        if (!filePath) {
          return res.status(400).json({
            success: false,
            error: '文件路径不能为空'
          });
        }
      
        let targetFilePath = filePath;
      
        // 根据上下文处理不同的文件打开方式
        switch (context) {
          case 'git-status':
            // Git状态：直接打开当前工作目录中的文件
            targetFilePath = path.resolve(process.cwd(), filePath);
            break;
      
          case 'commit-detail':
            // 提交详情：这里可以考虑创建临时文件显示该提交时的文件内容
            // 暂时先打开当前版本的文件
            targetFilePath = path.resolve(process.cwd(), filePath);
            break;
      
          case 'stash-detail':
            // Stash详情：同样暂时打开当前版本的文件
            targetFilePath = path.resolve(process.cwd(), filePath);
            break;
      
          default:
            targetFilePath = path.resolve(process.cwd(), filePath);
        }
      
        try {
          // 检查文件是否存在
          await fs.access(targetFilePath);
      
          // 使用系统默认程序打开文件
          await open(targetFilePath, { wait: false });
      
          res.json({
            success: true,
            message: `已打开文件: ${path.basename(targetFilePath)}`
          });
        } catch (error) {
          // 如果文件不存在，尝试在编辑器中创建新文件
          if (error.code === 'ENOENT') {
            try {
              await open(targetFilePath, { wait: false });
              res.json({
                success: true,
                message: `已在编辑器中打开文件: ${path.basename(targetFilePath)}`
              });
            } catch (openError) {
              res.status(400).json({
                success: false,
                error: `无法打开文件 "${path.basename(targetFilePath)}": ${openError.message}`
              });
            }
          } else {
            res.status(400).json({
              success: false,
              error: `无法访问文件 "${path.basename(targetFilePath)}": ${error.message}`
            });
          }
        }
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    }));
  
  // 用VSCode打开文件
  app.post('/api/open-with-vscode', asyncRoute(async (req, res) => {
      try {
        const { filePath, context } = req.body;
      
        if (!filePath) {
          return res.status(400).json({
            success: false,
            error: '文件路径不能为空'
          });
        }
      
        let targetFilePath = filePath;
      
        // 根据上下文处理不同的文件打开方式
        switch (context) {
          case 'git-status':
          case 'commit-detail':
          case 'stash-detail':
            targetFilePath = path.resolve(process.cwd(), filePath);
            break;
          default:
            targetFilePath = path.resolve(process.cwd(), filePath);
        }
      
        try {
          // 使用VSCode打开文件
          // 尝试使用 'code' 命令打开文件
          // 使用已导入的 spawn
      
          // 创建一个Promise来处理spawn的异步结果
          const spawnPromise = new Promise((resolve, reject) => {
            const vscodeProcess = spawn('code', [targetFilePath], {
              detached: true,
              stdio: 'ignore'
            });
      
            // 监听错误事件
            vscodeProcess.on('error', (err) => {
              reject(err);
            });
      
            // 监听spawn事件，表示进程成功启动
            vscodeProcess.on('spawn', () => {
              resolve('success');
            });
      
            vscodeProcess.unref();
          });
      
          await spawnPromise;
      
          res.json({
            success: true,
            message: `已用VSCode打开文件: ${path.basename(targetFilePath)}`
          });
        } catch (error) {
          // 如果VSCode命令不可用，尝试直接用open打开
          try {
            await open(targetFilePath, { app: { name: 'code' } });
            res.json({
              success: true,
              message: `已用VSCode打开文件: ${path.basename(targetFilePath)}`
            });
          } catch (openError) {
            // 最后的备用方案：尝试用系统默认编辑器打开
            try {
              await open(targetFilePath);
              res.json({
                success: true,
                message: `VSCode不可用，已用系统默认程序打开文件: ${path.basename(targetFilePath)}`
              });
            } catch (finalError) {
              res.status(400).json({
                success: false,
                error: `无法打开文件 "${path.basename(targetFilePath)}": VSCode可能未安装或未添加到PATH，且系统默认程序也无法打开该文件`
              });
            }
          }
        }
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    }));

  // 用 VSCode 打开目录
  app.post('/api/open-directory-with-vscode', asyncRoute(async (req, res) => {
      try {
        const { path: dirPath } = req.body;
        if (!dirPath) {
          throw new HttpError(400, '目录路径不能为空');
        }
      
        try {
          await spawnDetached('code', [dirPath]);
          res.json({ success: true, message: '已用 VSCode 打开目录' });
        } catch {
          // fallback：通过 open 模块指定 code 应用
          try {
            await open(dirPath, { app: { name: 'code' } });
            res.json({ success: true, message: '已用 VSCode 打开目录' });
          } catch (openError) {
            res.status(400).json({ success: false, error: 'VSCode 可能未安装或未添加到 PATH' });
          }
        }
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    }));

  // 用 Claude Code 打开目录
  app.post('/api/open-directory-with-claude-code', asyncRoute(async (req, res) => {
      try {
        const { path: dirPath, permissionMode } = req.body || {};
        if (!dirPath) {
          throw new HttpError(400, '目录路径不能为空');
        }

        try {
          await fs.access(dirPath);
        } catch (error) {
          throw new HttpError(400, `目录不存在或不可访问: ${dirPath}`);
        }

        try {
          await launchClaudeCode(dirPath, { permissionMode });
          const message = permissionMode
            ? `已用 Claude Code 打开目录（permission-mode=${permissionMode}）`
            : '已用 Claude Code 打开目录';
          res.json({ success: true, message });
        } catch (error) {
          res.status(400).json({
            success: false,
            error: error.message || '未检测到 Claude Code，请先安装并确保可以在终端中直接运行 claude'
          });
        }
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    }));

  // 用 Codex 打开目录
  app.post('/api/open-directory-with-codex', asyncRoute(async (req, res) => {
      try {
        const { path: dirPath } = req.body || {};
        if (!dirPath) {
          throw new HttpError(400, '目录路径不能为空');
        }

        try {
          await fs.access(dirPath);
        } catch (error) {
          throw new HttpError(400, `目录不存在或不可访问: ${dirPath}`);
        }

        try {
          await launchCodex(dirPath);
          res.json({ success: true, message: '已用 Codex 打开目录' });
        } catch (error) {
          res.status(400).json({
            success: false,
            error: error.message || '未检测到 Codex，请先安装并确保可以在终端中直接运行 codex'
          });
        }
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    }));

  // 用 OpenCode 打开目录
  app.post('/api/open-directory-with-opencode', asyncRoute(async (req, res) => {
      try {
        const { path: dirPath } = req.body || {};
        if (!dirPath) {
          throw new HttpError(400, '目录路径不能为空');
        }

        try {
          await fs.access(dirPath);
        } catch (error) {
          throw new HttpError(400, `目录不存在或不可访问: ${dirPath}`);
        }

        try {
          await launchOpenCode(dirPath);
          res.json({ success: true, message: '已用 OpenCode 打开目录' });
        } catch (error) {
          res.status(400).json({
            success: false,
            error: error.message || '未检测到 OpenCode，请先安装并确保可以在终端中直接运行 opencode'
          });
        }
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    }));

  // 检测本地工具是否已安装(供前端根据结果决定是否显示对应按钮)
  // 检测方式: spawn 'tool --version',exit 0 即视为已安装
  // 超时 3s 避免某个工具卡在 PATH 解析上时整个接口挂起
  app.get('/api/check-tools', asyncRoute(async (req, res) => {
      const checkCmd = (cmd) => new Promise((resolve) => {
        const child = spawn(cmd, ['--version'], {
          stdio: 'ignore',
          shell: process.platform === 'win32',
          windowsHide: true,
        });
        let done = false;
        const finish = (ok) => {
          if (done) return;
          done = true;
          try { child.kill('SIGKILL'); } catch {}
          resolve(ok);
        };
        child.on('error', () => finish(false));
        child.on('exit', (code) => finish(code === 0));
        setTimeout(() => finish(false), 3000);
      });

      const [vscode, claude, codex, opencode] = await Promise.all([
        checkCmd('code'),
        checkCmd('claude'),
        checkCmd('codex'),
        checkCmd('opencode'),
      ]);

      res.json({ success: true, vscode, claude, codex, opencode });
    }));
}
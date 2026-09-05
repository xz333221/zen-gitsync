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

const TOOL_INSTALL_PACKAGES = Object.freeze({
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  opencode: 'opencode-ai',
  dsh: '@deepseek-ai/dsh',
});

const TOOL_DOCS_URLS = Object.freeze({
  vscode: 'https://code.visualstudio.com/download',
  claude: 'https://docs.anthropic.com/en/docs/claude-code/getting-started',
  codex: 'https://help.openai.com/en/articles/11096431-openai-codex-cli-getting-started',
  opencode: 'https://opencode.ai/docs',
  kimi: 'https://moonshotai.github.io/kimi-code/en/guides/getting-started',
  zcode: 'https://zcode.z.ai/',
  dsh: 'https://github.com/deepseek-ai/deepseek-harness',
});

function commandExists(command, platform = process.platform) {
  const checker = platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(checker, [command], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return result.status === 0;
}

/**
 * 返回当前平台可展示、可执行的安装方案。
 * executable/args 只在服务端使用；前端只能提交固定 tool id，不能提交命令。
 */
export function getToolInstallers(platform = process.platform, hasCommand = commandExists) {
  const npmExecutable = platform === 'win32' ? 'npm.cmd' : 'npm';
  const npmAvailable = hasCommand('npm', platform);
  const installers = {};

  for (const [tool, packageName] of Object.entries(TOOL_INSTALL_PACKAGES)) {
    installers[tool] = {
      supported: npmAvailable,
      command: `npm install -g ${packageName}`,
      packageManager: 'npm',
      docsUrl: TOOL_DOCS_URLS[tool],
      note: npmAvailable
        ? '将在新终端中执行全局安装。安装过程中可能需要登录或确认权限。'
        : '未检测到 npm，请先安装 Node.js/npm，或按照官方文档手动安装。',
      executable: npmExecutable,
      args: ['install', '-g', packageName],
      // 升级变体:@latest 强制同步到最新版。已是最新时 npm 自然跳过。
      updateCommand: `npm install -g ${packageName}@latest`,
      updatePackageManager: 'npm',
      updateNote: '将在新终端中执行 `npm install -g <pkg>@latest`。已是最新时 npm 会跳过。',
      updateExecutable: npmExecutable,
      updateArgs: ['install', '-g', `${packageName}@latest`],
    };
  }

  if (platform === 'win32') {
    const wingetAvailable = hasCommand('winget', platform);
    installers.vscode = {
      supported: wingetAvailable,
      command: 'winget install --id Microsoft.VisualStudioCode -e --accept-package-agreements --accept-source-agreements',
      packageManager: 'winget',
      docsUrl: TOOL_DOCS_URLS.vscode,
      note: wingetAvailable
        ? '将在新终端中通过 winget 安装 Visual Studio Code。'
        : '未检测到 winget，请使用 VS Code 官方安装程序。',
      executable: 'winget',
      args: ['install', '--id', 'Microsoft.VisualStudioCode', '-e', '--accept-package-agreements', '--accept-source-agreements'],
      // winget 的升级动词是 upgrade(不是 install)
      updateCommand: wingetAvailable
        ? 'winget upgrade --id Microsoft.VisualStudioCode -e --accept-package-agreements --accept-source-agreements'
        : undefined,
      updatePackageManager: 'winget',
      updateNote: wingetAvailable
        ? '将在新终端中通过 winget upgrade 升级 VS Code。'
        : '未检测到 winget，请使用 VS Code 官方安装包。',
      updateExecutable: wingetAvailable ? 'winget' : undefined,
      updateArgs: wingetAvailable
        ? ['upgrade', '--id', 'Microsoft.VisualStudioCode', '-e', '--accept-package-agreements', '--accept-source-agreements']
        : undefined,
    };
  } else if (platform === 'darwin') {
    const brewAvailable = hasCommand('brew', platform);
    installers.vscode = {
      supported: brewAvailable,
      command: 'brew install --cask visual-studio-code',
      packageManager: 'Homebrew',
      docsUrl: TOOL_DOCS_URLS.vscode,
      note: brewAvailable
        ? '将在新终端中通过 Homebrew 安装 Visual Studio Code。'
        : '未检测到 Homebrew，请使用 VS Code 官方安装程序。',
      executable: 'brew',
      args: ['install', '--cask', 'visual-studio-code'],
      updateCommand: brewAvailable ? 'brew upgrade --cask visual-studio-code' : undefined,
      updatePackageManager: 'Homebrew',
      updateNote: brewAvailable ? '将在新终端中通过 brew upgrade 升级 VS Code。' : '未检测到 brew。',
      updateExecutable: brewAvailable ? 'brew' : undefined,
      updateArgs: brewAvailable ? ['upgrade', '--cask', 'visual-studio-code'] : undefined,
    };
  } else {
    const snapAvailable = hasCommand('snap', platform);
    installers.vscode = {
      supported: snapAvailable,
      command: 'sudo snap install code --classic',
      packageManager: 'snap',
      docsUrl: TOOL_DOCS_URLS.vscode,
      note: snapAvailable
        ? '将在新终端中通过 snap 安装 Visual Studio Code，可能需要输入系统密码。'
        : '当前 Linux 环境未检测到 snap，请按照发行版对应的官方说明安装。',
      executable: 'sudo',
      args: ['snap', 'install', 'code', '--classic'],
      // snap 的升级动词是 refresh
      updateCommand: snapAvailable ? 'sudo snap refresh code' : undefined,
      updatePackageManager: 'snap',
      updateNote: snapAvailable ? '将在新终端中通过 snap refresh 升级 VS Code。' : '未检测到 snap。',
      updateExecutable: snapAvailable ? 'sudo' : undefined,
      updateArgs: snapAvailable ? ['snap', 'refresh', 'code'] : undefined,
    };
  }

  installers.kimi = {
    supported: platform === 'win32' || platform === 'darwin' || platform === 'linux',
    command: platform === 'win32'
      ? 'irm https://code.kimi.com/kimi-code/install.ps1 | iex'
      : 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
    packageManager: 'Kimi Code 官方安装脚本',
    docsUrl: TOOL_DOCS_URLS.kimi,
    note: '将打开终端执行官方安装脚本；Windows 首次使用还需要 Git for Windows。',
    kind: 'script',
    executionCommand: platform === 'win32'
      ? [
          "if (-not (Get-Command Get-FileHash -ErrorAction SilentlyContinue)) {",
          "function global:Get-FileHash { param([string]$Path, [string]$Algorithm = 'SHA256')",
          "$stream = [System.IO.File]::OpenRead($Path)",
          "try { $sha = [System.Security.Cryptography.SHA256]::Create(); try { $bytes = $sha.ComputeHash($stream) } finally { $sha.Dispose() } } finally { $stream.Dispose() }",
          "$hash = ([System.BitConverter]::ToString($bytes)).Replace('-', '')",
          "New-Object PSObject -Property @{ Algorithm = 'SHA256'; Hash = $hash; Path = $Path }",
          "}",
          "}",
          'Invoke-RestMethod https://code.kimi.com/kimi-code/install.ps1 | Invoke-Expression',
        ].join('; ')
      : undefined,
    // 升级:kimi 官方脚本幂等,已安装时执行会自动升级到最新版,直接复用同一脚本
    updateCommand: platform === 'win32'
      ? 'irm https://code.kimi.com/kimi-code/install.ps1 | iex'
      : 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
    updatePackageManager: 'Kimi Code 官方安装脚本',
    updateNote: '官方安装脚本幂等，已安装时执行会自动升级到最新版本。',
    updateKind: 'script',
    updateExecutionCommand: platform === 'win32'
      ? [
          "if (-not (Get-Command Get-FileHash -ErrorAction SilentlyContinue)) {",
          "function global:Get-FileHash { param([string]$Path, [string]$Algorithm = 'SHA256')",
          "$stream = [System.IO.File]::OpenRead($Path)",
          "try { $sha = [System.Security.Cryptography.SHA256]::Create(); try { $bytes = $sha.ComputeHash($stream) } finally { $sha.Dispose() } } finally { $stream.Dispose() }",
          "$hash = ([System.BitConverter]::ToString($bytes)).Replace('-', '')",
          "New-Object PSObject -Property @{ Algorithm = 'SHA256'; Hash = $hash; Path = $Path }",
          "}",
          "}",
          'Invoke-RestMethod https://code.kimi.com/kimi-code/install.ps1 | Invoke-Expression',
        ].join('; ')
      : undefined,
  };
  installers.zcode = {
    supported: false,
    command: '打开 ZCode 官方下载页，选择当前系统安装包',
    packageManager: 'ZCode 官方安装包',
    docsUrl: TOOL_DOCS_URLS.zcode,
    note: 'ZCode 是桌面应用，官方提供 Windows、macOS 和 Linux 安装包，没有官方 npm CLI。',
    // ZCode 是桌面应用、没有 CLI 更新通道;/api/update-tool 会对它返回 400
    updateCommand: undefined,
    updatePackageManager: 'ZCode 官方安装包',
    updateNote: 'ZCode 是桌面应用，升级请到官网下载新版安装包覆盖安装。',
  };
  return installers;
}

function publicInstallerInfo(installers) {
  return Object.fromEntries(Object.entries(installers).map(([tool, installer]) => [tool, {
    supported: installer.supported,
    command: installer.command,
    packageManager: installer.packageManager,
    docsUrl: installer.docsUrl,
    note: installer.note,
  }]));
}

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

async function launchKimiCode(dirPath) {
  if (process.platform === 'win32') {
    const executable = await findKimiExecutable();
    if (!executable) throw new Error('未检测到 Kimi Code，请先安装 kimi CLI');
    return spawnDetached('cmd.exe', ['/c', 'start', '""', executable], { cwd: dirPath });
  }
  return launchInTerminal(dirPath, 'kimi');
}

async function launchDsh(dirPath) {
  const executable = await findDshExecutable();
  if (!executable) throw new Error('未检测到 DeepSeek Harness，请先全局安装 dsh CLI');
  if (process.platform === 'win32') {
    // 编码 PowerShell 命令，避免 cmd start 对 dsh.cmd 完整路径中的引号进行二次解析。
    const escapedExecutable = executable.replace(/'/g, "''");
    const script = `& '${escapedExecutable}' web`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return spawnDetached('cmd.exe', [
      '/c', 'start', '""', 'powershell.exe', '-NoLogo', '-NoExit',
      '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
    ], { cwd: dirPath });
  }
  return launchInTerminal(dirPath, executable, ['web']);
}

// 在 Windows 上找 dsh 可执行文件。
// 优先用 where.exe dsh(覆盖 nvm4w 的 C:\nvm4w\nodejs\、默认的 %APPDATA%\npm、
// pnpm/yarn 自定义 prefix、以及用户手摆到 PATH 里的任意位置),
//再兜底 APPDATA\npm + npm prefix -g 两个写死路径(为 where.exe 漏检的边缘情况,
//比如 PATH 里只有 junction/symlink 时)。
export async function findDshExecutable() {
  if (process.platform !== 'win32') return commandExists('dsh') ? 'dsh' : null;

  const where = spawnSync('where.exe', ['dsh'], { encoding: 'utf8', windowsHide: true });
  if (where.status === 0 && where.stdout) {
    for (const line of where.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      // 偶尔会输出 "PATH=..." 这种变量行,跳过
      if (/^[A-Z_]+=/i.test(line)) continue;
      try {
        const stat = await fs.stat(line);
        if (stat.isFile()) return line;
      } catch {}
    }
  }

  const fallback = [path.join(process.env.APPDATA || '', 'npm', 'dsh.cmd')];
  const npmPrefix = spawnSync('npm.cmd', ['prefix', '-g'], {
    encoding: 'utf8',
    windowsHide: true,
  }).stdout?.trim();
  if (npmPrefix) fallback.push(path.join(npmPrefix, 'dsh.cmd'));

  for (const candidate of fallback.filter(Boolean)) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {}
  }
  return null;
}

async function findKimiExecutable() {
  if (process.platform !== 'win32') return commandExists('kimi') ? 'kimi' : null;

  const candidates = [
    path.join(process.env.USERPROFILE || '', '.kimi-code', 'bin', 'kimi.exe'),
  ];
  const registryPath = spawnSync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'Path'], {
    encoding: 'utf8',
    windowsHide: true,
  }).stdout || '';
  const pathLine = registryPath.split(/\r?\n/).find(line => /\sPath\s+REG_(?:EXPAND_)?SZ\s+/i.test(line));
  if (pathLine) {
    const userPath = pathLine.replace(/^.*?REG_(?:EXPAND_)?SZ\s+/i, '').trim();
    for (const directory of userPath.split(';').map(value => value.trim()).filter(Boolean)) {
      candidates.push(path.join(directory, 'kimi.exe'));
    }
  }

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {}
  }
  return null;
}

async function launchZCode(dirPath) {
  const executable = await findZCodeExecutable();
  if (!executable) throw new Error('未检测到 ZCode，请从官网下载桌面安装包');
  return spawnDetached(executable, [dirPath]);
}

async function findZCodeExecutable() {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ZCode', 'ZCode.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'ZCode', 'ZCode.exe'),
        path.join(process.env.PROGRAMFILES || '', 'ZCode', 'ZCode.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/ZCode.app/Contents/MacOS/ZCode']
      : ['/usr/bin/zcode', '/usr/local/bin/zcode'];

  if (process.platform === 'win32') {
    const registryRoots = [
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ];
    for (const root of registryRoots) {
      const output = spawnSync('reg.exe', ['query', root, '/s'], {
        encoding: 'utf8',
        windowsHide: true,
      }).stdout || '';
      for (const line of output.split(/\r?\n/)) {
        if (!/DisplayIcon|InstallLocation/i.test(line) || !/zcode/i.test(line)) continue;
        const value = line.replace(/^.*?REG_SZ\s+/i, '').trim().replace(/^"|"$/g, '').replace(/,\d+$/, '');
        if (value && !/\.(ico|png|jpg|jpeg)$/i.test(value)) candidates.push(value);
      }
    }
    const running = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-Command',
      "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'ZCode' } | Select-Object -ExpandProperty Path",
    ], { encoding: 'utf8', windowsHide: true }).stdout || '';
    candidates.push(...running.split(/\r?\n/).map(value => value.trim()).filter(Boolean));
  }

  for (const candidate of candidates.filter(Boolean)) {
    const normalized = String(candidate).trim().replace(/^"|"$/g, '').replace(/,\d+$/, '');
    if (/\.(ico|png|jpg|jpeg)$/i.test(normalized)) continue;
    try {
      const stat = await fs.stat(normalized);
      if (stat.isFile()) return normalized;
      if (stat.isDirectory()) {
        for (const name of ['ZCode.exe', 'zcode.exe']) {
          const executable = path.join(normalized, name);
          try {
            const executableStat = await fs.stat(executable);
            if (executableStat.isFile()) return executable;
          } catch {}
        }
      }
    } catch {}
  }
  return null;
}

async function launchToolInstaller(installer, dirPath = process.cwd(), { update = false } = {}) {
  // update=true 时改用 updateXxx 字段(升级命令与安装命令动词不同:
  // npm @latest / winget upgrade / brew upgrade / snap refresh / kimi 脚本幂等重跑)
  const kindField = update ? 'updateKind' : 'kind';
  const execCmdField = update ? 'updateExecutionCommand' : 'executionCommand';
  const cmdField = update ? 'updateCommand' : 'command';
  const executableField = update ? 'updateExecutable' : 'executable';
  const argsField = update ? 'updateArgs' : 'args';

  if (installer[kindField] === 'script') {
    if (process.platform === 'win32') {
      // 显式创建新控制台；编码脚本可避免 cmd.exe 截获 PowerShell 管道符。
      const encoded = Buffer.from(installer[execCmdField] || installer[cmdField], 'utf16le').toString('base64');
      return spawnDetached('cmd.exe', [
        '/c', 'start', '""', 'powershell.exe', '-NoLogo', '-NoExit',
        '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
      ], { cwd: dirPath });
    }
    return launchInTerminal(dirPath, 'bash', ['-lc', installer[cmdField]]);
  }
  if (process.platform === 'win32') {
    // 安装/更新命令完全来自服务端白名单。使用可见 cmd 窗口，让用户看到进度和错误。
    const commandLine = [installer[executableField], ...installer[argsField]].join(' ');
    return spawnDetached('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/k', commandLine], {
      cwd: dirPath,
    });
  }

  return launchInTerminal(dirPath, installer[executableField], installer[argsField]);
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

  // 用 Kimi Code 打开目录
  app.post('/api/open-directory-with-kimi', asyncRoute(async (req, res) => {
    const { path: dirPath } = req.body || {};
    if (!dirPath) throw new HttpError(400, '目录路径不能为空');
    try {
      await fs.access(dirPath);
      await launchKimiCode(dirPath);
      res.json({ success: true, message: '已用 Kimi Code 打开目录' });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message || '未检测到 Kimi Code，请先安装 kimi CLI' });
    }
  }));

  // 用 DeepSeek Harness 打开目录
  app.post('/api/open-directory-with-dsh', asyncRoute(async (req, res) => {
    const { path: dirPath } = req.body || {};
    if (!dirPath) throw new HttpError(400, '目录路径不能为空');
    try {
      await fs.access(dirPath);
      await launchDsh(dirPath);
      res.json({ success: true, message: '已启动 DeepSeek Harness' });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message || '无法启动 DeepSeek Harness，请确认已安装 Node.js' });
    }
  }));

  // 用 ZCode 打开目录
  app.post('/api/open-directory-with-zcode', asyncRoute(async (req, res) => {
    const { path: dirPath } = req.body || {};
    if (!dirPath) throw new HttpError(400, '目录路径不能为空');
    try {
      await fs.access(dirPath);
      await launchZCode(dirPath);
      res.json({ success: true, message: '已用 ZCode 打开目录' });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message || '未检测到 ZCode，请从官网下载桌面安装包' });
    }
  }));

  // 安装本地工具：前端只能传固定 tool id，实际命令由服务端按平台从白名单选择。
  app.post('/api/install-tool', asyncRoute(async (req, res) => {
      const { tool } = req.body || {};
      const installers = getToolInstallers();
      const installer = installers[tool];

      if (!installer) {
        throw new HttpError(400, '不支持的工具');
      }
      if (!installer.supported) {
        throw new HttpError(400, installer.note || '当前系统不支持一键安装，请按照官方文档手动安装');
      }

      await launchToolInstaller(installer);
      res.json({
        success: true,
        message: '安装命令已在新终端中启动',
      });
    }));

  // 更新本地工具:与 install-tool 同一套白名单,只是换用 updateXxx 命令变体
  // (npm @latest / winget upgrade / brew upgrade / snap refresh / kimi 脚本重跑)。
  // 没有 updateCommand 的工具(如 zcode 桌面应用)返回 400。
  app.post('/api/update-tool', asyncRoute(async (req, res) => {
      const { tool } = req.body || {};
      const installers = getToolInstallers();
      const installer = installers[tool];

      if (!installer) {
        throw new HttpError(400, '不支持的工具');
      }
      if (!installer.updateCommand) {
        throw new HttpError(400, installer.updateNote || '当前工具不支持一键更新，请按官方文档手动升级');
      }

      await launchToolInstaller(installer, process.cwd(), { update: true });
      res.json({
        success: true,
        message: '更新命令已在新终端中启动',
      });
    }));

  // 检测本地工具是否已安装(供前端根据结果决定是否显示对应按钮)
  // 检测方式: spawn 'tool --version',exit 0 即视为已安装
  // 超时 15s:Claude CLI / opencode 等 Node 包装的工具首次冷启动
  // 在 Windows 上经常 5-7s(磁盘 cache + Defender 扫描),3s 永远命中超时。
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
        setTimeout(() => finish(false), 15000);
      });

      const [vscode, claude, codex, opencode, kimiExecutable, zcodeExecutable, dshExecutable] = await Promise.all([
        checkCmd('code'),
        checkCmd('claude'),
        checkCmd('codex'),
        checkCmd('opencode'),
        findKimiExecutable(),
        findZCodeExecutable(),
        findDshExecutable(),
      ]);

      const installers = getToolInstallers();
      res.json({
        success: true,
        platform: process.platform,
        installers: publicInstallerInfo(installers),
        vscode,
        claude,
        codex,
        opencode,
        kimi: !!kimiExecutable,
        zcode: !!zcodeExecutable,
        dsh: !!dshExecutable,
      });
    }));
}

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
import os from 'os';
import open from 'open';
import { spawn, spawnSync, execFile } from 'child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { augmentEnvPath, pathValueOf, withPathValue } from '../../../utils/shellPath.js';

const execFileAsync = promisify(execFile);

const TOOL_INSTALL_PACKAGES = Object.freeze({
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  opencode: 'opencode-ai',
  codebuddy: '@tencent-ai/codebuddy-code',
  // Pi（earendil-works 开源终端编程 Agent，2026-10-13 随执行器接入一起补）。
  // npm 安装不带 postinstall（官方推荐 --ignore-scripts），但安装器走的是
  // `npm install -g` 原样命令，不为它单开一个变体 —— 多一个变体多一条要维护的路。
  pi: '@earendil-works/pi-coding-agent',
  dsh: '@deepseek-ai/dsh',
});

const TOOL_DOCS_URLS = Object.freeze({
  vscode: 'https://code.visualstudio.com/download',
  claude: 'https://docs.anthropic.com/en/docs/claude-code/getting-started',
  codex: 'https://help.openai.com/en/articles/11096431-openai-codex-cli-getting-started',
  opencode: 'https://opencode.ai/docs',
  codebuddy: 'https://www.codebuddy.cn/docs/cli/installation',
  pi: 'https://pi.dev',
  // 码道 CLI 没有 npm 包（官方是 PowerShell/bash 安装脚本），所以它只在
  // TOOL_DOCS_URLS 里出现、不进 TOOL_INSTALL_PACKAGES —— 安装引导走官网。
  codearts: 'https://codearts.huaweicloud.com/download.html',
  kimi: 'https://moonshotai.github.io/kimi-code/en/guides/getting-started',
  zcode: 'https://zcode.z.ai/',
  dsh: 'https://github.com/deepseek-ai/deepseek-harness',
  // 远程仓库列表页(RemoteReposList)用到的两个托管平台 CLI。它们不是"AI 工具",
  // 不参与 /api/check-tools 的 open-with 菜单,只借这里的白名单走 /api/install-tool。
  gh: 'https://cli.github.com/',
  gitee: 'https://gitee.com/oschina/gitee-cli',
});

// ── 官方桌面应用（顶栏「打开桌面端 / 下载桌面端」用）────────────────────
// 顶栏这排工具大多只有 CLI；这里只收**官方有桌面版**的六个：
//   claude → Claude 桌面端（Code 标签页就是桌面版 Claude Code）
//   codex  → Codex 桌面版（2026-07 起并入 ChatGPT 桌面应用，是其中一个模式）
//   opencode → OpenCode 桌面版
//   codebuddy → CodeBuddy IDE
//   kimi   → Kimi 桌面端
//   dsh    → DeepSeek Harness 桌面版（官方仓库 apps/desktop，Electron 壳）
// 不收的：vscode（主按钮本身就是打开桌面应用，`code <目录>` 拉起的正是 GUI）、
// zcode（整个就是桌面应用，主按钮直接启动）、pi（没有官方桌面版，
// 社区壳不代表官方立场，不代收）。
// downloadUrl 给没装桌面端的用户点（前端直接 window.open，不经服务端）；
// 可以是字符串，也可以是 (platform, arch) => string —— dsh 的官方固定下载
// 地址按平台/架构分（win-x64 exe、mac arm64/x64 dmg，没有落地页），由服务端
// 判（UI 与后端同机，process.platform/arch 就是用户机器的）。
// name 是菜单展示名，刻意和 CLI 版的名字区分（"Claude 桌面端" vs "Claude Code"），
// 否则用户分不清点下去开的是哪个。
const TOOL_DESKTOP_APPS = Object.freeze({
  claude: {
    name: 'Claude 桌面端',
    downloadUrl: 'https://claude.com/download',
    winExeName: 'Claude.exe',
    winExeRe: /Claude\.exe$/i,
    winPaths: ['AnthropicClaude/Claude.exe', 'Programs/Claude/Claude.exe', 'Claude/Claude.exe'],
    winLnkRe: /^Claude\.lnk$/i,
    macApp: 'Claude.app',
    linuxPaths: ['/opt/Claude/claude', '/usr/bin/claude-desktop'],
  },
  codex: {
    name: 'Codex 桌面版',
    downloadUrl: 'https://developers.openai.com/codex/app/',
    winExeName: 'ChatGPT.exe',
    winExeRe: /ChatGPT\.exe$/i,
    winPaths: ['Microsoft/WindowsApps/ChatGPT.exe', 'Programs/ChatGPT/ChatGPT.exe', 'OpenAI/ChatGPT/ChatGPT.exe'],
    winLnkRe: /^(ChatGPT|Codex)\.lnk$/i,
    macApp: 'ChatGPT.app',
    linuxPaths: [], // Codex 桌面版只有 macOS / Windows
  },
  opencode: {
    name: 'OpenCode 桌面版',
    downloadUrl: 'https://opencode.ai/download',
    winExeName: 'opencode.exe',
    winExeRe: /opencode.*\.exe$/i,
    winPaths: ['Programs/opencode/opencode.exe', 'Programs/OpenCode/OpenCode.exe', 'Programs/opencode-desktop/opencode-desktop.exe'],
    winLnkRe: /^OpenCode\.lnk$/i,
    macApp: 'OpenCode.app',
    linuxPaths: ['/usr/bin/opencode-desktop', '/usr/local/bin/opencode-desktop', '/opt/opencode-desktop/opencode-desktop'],
  },
  codebuddy: {
    name: 'CodeBuddy IDE',
    downloadUrl: 'https://www.codebuddy.cn/ide/',
    winExeName: 'CodeBuddy.exe',
    winExeRe: /CodeBuddy\.exe$/i,
    winPaths: ['Programs/CodeBuddy/CodeBuddy.exe', 'CodeBuddy/CodeBuddy.exe'],
    winLnkRe: /^CodeBuddy( IDE)?\.lnk$/i,
    macApp: 'CodeBuddy.app',
    linuxPaths: ['/usr/bin/codebuddy', '/usr/local/bin/codebuddy', '/opt/codebuddy/codebuddy'],
  },
  kimi: {
    name: 'Kimi 桌面端',
    downloadUrl: 'https://www.kimi.com/products/kimi-work',
    winExeName: 'Kimi.exe',
    winExeRe: /Kimi\.exe$/i,
    winPaths: ['Programs/Kimi/Kimi.exe', 'Kimi/Kimi.exe'],
    winLnkRe: /^Kimi\.lnk$/i,
    macApp: 'Kimi.app',
    linuxPaths: [], // Kimi 桌面端只有 Windows / macOS(Apple 芯片)
  },
  dsh: {
    name: 'DeepSeek Harness 桌面版',
    // 官方固定下载地址（apps/desktop/publishing/README：upload:latest:* 传到
    // download.deepseek.com/desktop/dsh-latest-*，就是安装包本身、没有落地页）。
    // 官方 targets 只有 win-x64 / mac-arm64 / mac-x64 —— Linux 没有官方桌面版，
    // 回落仓库里的 Desktop 文档。安装器是 per-user NSIS，卸载项在 HKCU 根
    // （scanWindowsUninstallPaths 本来就查 HKCU）。
    downloadUrl: (platform, arch) => {
      if (platform === 'win32') return 'https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe';
      if (platform === 'darwin') {
        return `https://download.deepseek.com/desktop/dsh-latest-macos-${arch === 'arm64' ? 'arm64' : 'x64'}.dmg`;
      }
      return 'https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/desktop';
    },
    // electron-builder productName 是 'DeepSeek Harness' → 装出来的 exe / .app /
    // 开始菜单快捷方式都叫这个名字（artifactName 的 deepseek-harness-* 只是安装包文件名）
    winExeName: 'DeepSeek Harness.exe',
    winExeRe: /DeepSeek Harness\.exe$/i,
    winPaths: ['Programs/DeepSeek Harness/DeepSeek Harness.exe'],
    winLnkRe: /^DeepSeek Harness\.lnk$/i,
    macApp: 'DeepSeek Harness.app',
    linuxPaths: [], // 官方没有 Linux 桌面版
  },
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
 * 从 `--version` 的输出里提取 semver 版本号。
 * 各工具输出格式五花八门:
 *   dsh     → "0.1.1-rc.2"
 *   claude  → "1.0.60 (Claude Code)"
 *   code    → "1.92.0 abc123def (commit ...)"
 *   opencode → "opencode 0.1.30"
 * 策略:取第一个 semver 模式(含 prerelease 0.1.1-rc.2 / build 1.0.0+build.1)。
 * 提不出来返回 null(调用方按"未知版本"处理,不影响安装判定)。
 */
export function parseVersionOutput(text) {
  if (!text) return null;
  const match = String(text).match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/);
  return match ? match[0] : null;
}

// ── npm registry 最新版本查询(右键更新菜单的「当前 → 最新」提示用)──────────
// 为什么走 HTTP 而不是 `npm view <pkg> version`:spawnSync('npm.cmd', ...) 在
// server 子进程里不稳(prefix -g 曾返回 "…npm:3" 废地址,见 findDshExecutable
// 的修复记录),HTTP 直查又快又可控。
// registry 优先级:~/.npmrc 的 registry 字段(用户可能配了镜像)→ npmmirror 默认。

let cachedRegistryBase = null;

export function getRegistryBase(readFile = fs.readFile) {
  if (cachedRegistryBase) return cachedRegistryBase;
  return readFile(path.join(os.homedir(), '.npmrc'), 'utf8').then((npmrc) => {
    const match = String(npmrc).match(/^\s*registry\s*=\s*(\S+)/m);
    cachedRegistryBase = match
      ? match[1].replace(/\/+$/, '')
      : 'https://registry.npmmirror.com';
    return cachedRegistryBase;
  }).catch(() => (cachedRegistryBase = 'https://registry.npmmirror.com'));
}

export async function fetchLatestVersion(packageName, { timeoutMs = 8000, fetchImpl = fetch } = {}) {
  if (!packageName || !/^[\w@/.-]+$/.test(packageName)) return null;
  const base = await getRegistryBase();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(`${base}/${packageName}/latest`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return typeof data?.version === 'string' ? data.version : null;
  } catch {
    return null; // 网络失败/超时:菜单显示原文案,不影响任何功能
  } finally {
    clearTimeout(timer);
  }
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

  // 码道 CLI 没有 npm 包（官方是 PowerShell / bash 安装脚本），所以只给一张「手动安装」
  // 卡片：supported 恒 false —— 前端据此不显示"一键安装"按钮，只保留复制命令 + 文档。
  // 刻意不代跑那条远程脚本：`irm <url> | iex` 等于把一段网上拉下来的代码塞进用户终端，
  // 属于要用户自己看清楚的动作用（与别家 npm 安装不同，那个至少有包名可审计）。
  installers.codearts = {
    supported: false,
    command: platform === 'win32'
      ? 'irm https://cnnorth4-cloudide-marketplace.obs.cn-north-4.myhuaweicloud.com/codearts/cli_tui/install_script/install.ps1 | iex'
      : 'sh -c "$(curl -L https://cnnorth4-cloudide-marketplace.obs.cn-north-4.myhuaweicloud.com/codearts/cli_tui/install_script/install.sh)"',
    packageManager: 'official-script',
    docsUrl: TOOL_DOCS_URLS.codearts,
    note: '复制命令到终端执行（装完会自动加入 PATH）。装好后点「重新检测」；若仍显示未安装，重启 ZenGitSync —— 已运行的进程读不到新的 PATH。',
  };

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

  // ── 远程托管平台 CLI(远程仓库列表页用)──────────────────────────────────
  // 与上面的 AI 工具共用同一份白名单,好处是"前端只能提交 tool id、命令由服务端
  // 决定"这条安全边界不用再实现一遍。它们不出现在 open-with 菜单里 —— 那个菜单
  // 是 useDirectoryOpenActions.ts 里的硬编码数组,不看这张表。
  if (platform === 'win32') {
    const wingetAvailable = hasCommand('winget', platform);
    installers.gh = {
      supported: wingetAvailable,
      command: 'winget install --id GitHub.cli -e --accept-package-agreements --accept-source-agreements',
      packageManager: 'winget',
      docsUrl: TOOL_DOCS_URLS.gh,
      note: wingetAvailable
        ? '将在新终端中通过 winget 安装 GitHub CLI；装完请在新终端执行 gh auth login 登录。'
        : '未检测到 winget，请到 cli.github.com 下载安装包。',
      executable: 'winget',
      args: ['install', '--id', 'GitHub.cli', '-e', '--accept-package-agreements', '--accept-source-agreements'],
      updateCommand: wingetAvailable
        ? 'winget upgrade --id GitHub.cli -e --accept-package-agreements --accept-source-agreements'
        : undefined,
      updatePackageManager: 'winget',
      updateNote: wingetAvailable ? '将在新终端中通过 winget upgrade 升级 GitHub CLI。' : '未检测到 winget。',
      updateExecutable: wingetAvailable ? 'winget' : undefined,
      updateArgs: wingetAvailable
        ? ['upgrade', '--id', 'GitHub.cli', '-e', '--accept-package-agreements', '--accept-source-agreements']
        : undefined,
    };
  } else if (platform === 'darwin') {
    const brewAvailable = hasCommand('brew', platform);
    installers.gh = {
      supported: brewAvailable,
      command: 'brew install gh',
      packageManager: 'Homebrew',
      docsUrl: TOOL_DOCS_URLS.gh,
      note: brewAvailable
        ? '将在新终端中通过 Homebrew 安装 GitHub CLI；装完请执行 gh auth login 登录。'
        : '未检测到 Homebrew，请到 cli.github.com 下载安装包。',
      executable: 'brew',
      args: ['install', 'gh'],
      updateCommand: brewAvailable ? 'brew upgrade gh' : undefined,
      updatePackageManager: 'Homebrew',
      updateNote: brewAvailable ? '将在新终端中通过 brew upgrade 升级 GitHub CLI。' : '未检测到 brew。',
      updateExecutable: brewAvailable ? 'brew' : undefined,
      updateArgs: brewAvailable ? ['upgrade', 'gh'] : undefined,
    };
  } else {
    // Debian/Ubuntu 官方源里已有 gh;其它发行版请看 docsUrl(Arch: pacman -S github-cli)
    const aptAvailable = hasCommand('apt-get', platform);
    installers.gh = {
      supported: aptAvailable,
      command: 'sudo apt-get install -y gh',
      packageManager: 'apt',
      docsUrl: TOOL_DOCS_URLS.gh,
      note: aptAvailable
        ? '将在新终端中通过 apt 安装 GitHub CLI，可能需要输入系统密码；装完请执行 gh auth login 登录。'
        : '当前 Linux 环境未检测到 apt-get，请按 docsUrl 里对应发行版的说明安装。',
      executable: 'sudo',
      args: ['apt-get', 'install', '-y', 'gh'],
      // apt 没有"就地升级单个包"的稳定动词,不给一键更新,引导去官方文档
      updateCommand: undefined,
      updatePackageManager: 'apt',
      updateNote: '请按官方文档升级 GitHub CLI。',
    };
  }
  installers.gitee = {
    supported: npmAvailable,
    command: 'npm install -g @gitee/gitee-cli',
    packageManager: 'npm',
    docsUrl: TOOL_DOCS_URLS.gitee,
    note: npmAvailable
      ? '将在新终端中通过 npm 全局安装 Gitee CLI；装完请执行 gitee auth login 粘贴私人令牌。'
      : '未检测到 npm，请先安装 Node.js/npm，或按官方文档手动安装。',
    executable: npmExecutable,
    args: ['install', '-g', '@gitee/gitee-cli'],
    updateCommand: 'npm install -g @gitee/gitee-cli@latest',
    updatePackageManager: 'npm',
    updateNote: '将在新终端中执行 `npm install -g @gitee/gitee-cli@latest`。已是最新时 npm 会跳过。',
    updateExecutable: npmExecutable,
    updateArgs: ['install', '-g', '@gitee/gitee-cli@latest'],
  };

  return installers;
}

export function publicInstallerInfo(installers) {
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

/**
 * codex 的启动参数（按权限档位）。与 claude / opencode 的档位对应关系：
 *
 *   默认（不带 token）  → 一个 flag 都不加，跟随 `~/.codex/config.toml` 的
 *                        approval / sandbox 设置
 *   'sandboxed'        → `-a never -s workspace-write`：**从不问人，但命令仍在沙箱里跑**
 *                        （写限工作区、默认无网络）。这是"不想被批准提示打断、又不想
 *                        完全交出去"的那一档，语义上对应 claude 的「批准文件编辑」。
 *   'bypass'           → `--dangerously-bypass-approvals-and-sandbox`：免批准 + 免沙箱。
 *                        官方帮助原文 "Skip all confirmation prompts and execute commands
 *                        without sandboxing. EXTREMELY DANGEROUS."。**完全批准**就是它。
 *   'bypassPermissions'→ 同上。只为让调用方（顶栏菜单与编排台项目菜单）跟 claude 那档
 *                        共用同一个字符串，不是第三种行为。
 *
 * ⚠️ codex 没有 claude 的 `--permission-mode`，两档都得自己拼 flag。
 * ⚠️ 别只看 sandbox：本机 config.toml 写的是 `sandbox_mode = "danger-full-access"`，
 *    也就是说这台机器的**默认档本来就没有沙箱**，完全批准档真正多出来的只是"不再弹批准"。
 *
 * 回归 `test/open-with-permission.test.mjs`（与 opencode 那份参数映射放一起验）。
 */
const CODEX_MODE_FLAGS = new Map([
  ['sandboxed', ['-a', 'never', '-s', 'workspace-write']],
  ['bypass', ['--dangerously-bypass-approvals-and-sandbox']],
  ['bypassPermissions', ['--dangerously-bypass-approvals-and-sandbox']],
]);

export function buildCodexArgs(permissionMode) {
  // Map.get 对非字符串返回 undefined → 未知 token 一律空数组，白名单式，不存在拼参数注入
  return [...(CODEX_MODE_FLAGS.get(permissionMode) || [])];
}

async function launchCodex(dirPath, { permissionMode } = {}) {
  // OpenAI Codex CLI - https://github.com/openai/codex
  const cliArgs = buildCodexArgs(permissionMode);
  if (process.platform === 'win32') {
    return spawnDetached('cmd.exe', ['/c', 'start', '""', 'codex', ...cliArgs], {
      cwd: dirPath
    });
  }
  return launchInTerminal(dirPath, 'codex', cliArgs);
}

/**
 * opencode 的「完全批准」= `--auto`（官方文档里的 auto mode）：把**未被显式拒绝**的
 * 权限请求自动批准。
 *
 * 它不等于"什么都放行"：配置里显式 `deny` 的仍然会被拦（opencode 默认就 deny 了
 * `read` 的 `*.env` / `*.env.*`，TUI 里 `--auto` 也一样读不到），这与 claude 的
 * bypassPermissions 受 `~/.claude/settings.json` deny 约束是同一个口径 —— 两边都是
 * "除非你明确禁止，否则全放"。
 *
 * 档位 token：`auto` 是本工具的正式叫法；`bypassPermissions` 只是为了让调用方
 * （顶栏菜单与编排台项目菜单）与 claude 那档共用同一个字符串。
 */
const OPENCODE_AUTO_MODES = new Set(['auto', 'bypassPermissions']);

/**
 * opencode 的启动参数（按权限档位）。
 *
 * 单独抽成纯函数是为了能**真的跑断言**而不用 spawn 一个终端窗口 —— 带 `--auto` 的
 * TUI 会弹出来并停在那里等人输入，验证不能有这种副作用。回归 `test/opencode-permission.test.mjs`。
 * 白名单式：非字符串 / 未知 token 一律返回空数组，不存在拼参数注入的面。
 */
export function buildOpencodeArgs(permissionMode) {
  return OPENCODE_AUTO_MODES.has(permissionMode) ? ['--auto'] : [];
}

async function launchOpenCode(dirPath, { permissionMode } = {}) {
  // opencode (sst/opencode) CLI - https://opencode.ai
  const cliArgs = buildOpencodeArgs(permissionMode);
  if (process.platform === 'win32') {
    return spawnDetached('cmd.exe', ['/c', 'start', '""', 'opencode', ...cliArgs], {
      cwd: dirPath
    });
  }
  return launchInTerminal(dirPath, 'opencode', cliArgs);
}

/**
 * codebuddy 的权限档位（`--permission-mode`，用 CLI 自己的档位名当 token）。
 *
 * 档位名与 claude **逐字相同**（acceptEdits / bypassPermissions），所以直接沿用
 * claude 那套 token，不必再造一份 —— 前端两处菜单传的是同一个字符串。
 *
 *   'bypassPermissions' → `--permission-mode bypassPermissions`
 *       官方档位说明原文 "Skips all permission prompts"，这就是它的**完全批准**档。
 *       实测（2026-10-14，本机 CLI）`codebuddy -p --output-format stream-json
 *       --permission-mode bypassPermissions` 的 init 事件回传
 *       `permissionMode: "bypassPermissions"` —— 档位真的生效，不是被静默忽略。
 *       `-y / --dangerously-skip-permissions` 是同一档的别名（headless 执行器走的就是
 *       -y，init 同样回传 bypassPermissions），这里用 `--permission-mode` 是因为它
 *       是 TUI 也认的正式写法（help: "Default permission mode for this process
 *       (TUI, --serve Web, ACP)"），且与 claude 的启动参数形状一致。
 *   'acceptEdits'       → `--permission-mode acceptEdits`（自动批准文件编辑，中间档）
 *   其余一切（undefined / 未知串 / 非字符串）→ 一个 flag 都不带，跟随 CLI 自己的配置
 *
 * 白名单式：只有表里这两个 token 能变成参数，不存在拼参数注入的面。
 * 回归 `test/open-with-permission.test.mjs`。
 */
const CODEBUDDY_MODE_FLAGS = new Map([
  ['acceptEdits', ['--permission-mode', 'acceptEdits']],
  ['bypassPermissions', ['--permission-mode', 'bypassPermissions']],
]);

/**
 * codebuddy 的启动参数（按权限档位）。
 *
 * `--port 0` 是**必须**的（与档位无关，恒定带上）：CLI 每次运行都自带一个引擎服务器，
 * 默认端口写死 62443，而 WorkBuddy 桌面版常驻占着它 —— 实测裸跑 `codebuddy`
 * （交互也一样）直接 EADDRINUSE 退出。0 = 让 OS 选空闲端口，与 headless 执行器
 * （taskRunner.launchCodebuddyPrint）同一个口径。
 */
export function buildCodebuddyArgs(permissionMode) {
  return ['--port', '0', ...(CODEBUDDY_MODE_FLAGS.get(permissionMode) || [])];
}

/**
 * 用 CodeBuddy Code 打开目录（交互 TUI，2026-10-12 随执行器接入一起补）。
 * 权限档位见 buildCodebuddyArgs。
 *
 * 登录态来自 ~/.codebuddy：没登录过的话 TUI 里会提示 /login 扫码。
 */
async function launchCodebuddy(dirPath, { permissionMode } = {}) {
  // CodeBuddy Code CLI - https://www.codebuddy.cn/docs/cli
  const cliArgs = buildCodebuddyArgs(permissionMode);
  if (process.platform === 'win32') {
    return spawnDetached('cmd.exe', ['/c', 'start', '""', 'codebuddy', ...cliArgs], {
      cwd: dirPath
    });
  }
  return launchInTerminal(dirPath, 'codebuddy', cliArgs);
}

/**
 * 用 Pi 打开目录（交互 TUI，2026-10-13 随执行器接入一起补）。
 *
 * 与 codebuddy 的差别：pi **没有**引擎服务器、不占固定端口，所以裸起即可
 * （没有 --port 0 那一出）。登录态在 TUI 里 /login（订阅或 provider API key），
 * 凭据落 ~/.pi/agent。
 */
async function launchPi(dirPath) {
  // Pi CLI - https://pi.dev
  if (process.platform === 'win32') {
    return spawnDetached('cmd.exe', ['/c', 'start', '""', 'pi'], {
      cwd: dirPath
    });
  }
  return launchInTerminal(dirPath, 'pi', []);
}

/**
 * 用码道 CLI 打开目录（交互 TUI，2026-10-25 随执行器接入一起补）。
 *
 * `codearts <project>` 就是"在指定目录进入 TUI"。注意两点：
 *   - PATH 上是 installers\codearts.cmd（安装脚本加的），起 TUI 必须走它 ——
 *     那个 shim 会补齐 OPENCODE_CONFIG 等一串环境变量，裸起 bin\codearts.exe
 *     会读用户自己那套 opencode 的配置。
 *   - 首次开会要求 AK/SK（CODEARTS_CLI_AK/SK）或浏览器登录，属于交互环节。
 */
async function launchCodeArts(dirPath) {
  if (process.platform === 'win32') {
    return spawnDetached('cmd.exe', ['/c', 'start', '""', 'codearts', dirPath], {
      cwd: dirPath
    });
  }
  return launchInTerminal(dirPath, 'codearts', [dirPath]);
}

/**
 * 找 codearts 的可执行文件（2026-10-25 加）。
 *
 * 为什么不能像别家那样直接 `checkCmd('codearts')` 靠 PATH：
 * 官方安装脚本把 `%USERPROFILE%\.codeartsdoer\installers` 追加到**用户 PATH**，
 * 而 Windows 的 PATH 变更只对新进程生效 —— 已经在跑的 g ui 进程永远看不到。
 * 于是"明明装了却显示未安装"，而且用户重启应用前怎么点都修复不了。
 * 这里按已知安装位置硬找，与 taskRunner.resolveCodeArtsExe 同一份口径。
 */
export async function findCodeArtsExecutable() {
  const home = process.env.USERPROFILE || '';
  if (process.platform !== 'win32') {
    return commandExists('codearts') ? 'codearts' : null;
  }

  const candidates = [
    path.join(home, '.codeartsdoer', 'installers', 'codearts.cmd'),
    path.join(home, '.codeartsdoer', 'installers', 'bin', 'codearts.exe'),
  ];
  const registryPath = spawnSync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'Path'], {
    encoding: 'utf8',
    windowsHide: true,
  }).stdout || '';
  const pathLine = registryPath.split(/\r?\n/).find(line => /\sPath\s+REG_(?:EXPAND_)?SZ\s+/i.test(line));
  if (pathLine) {
    const userPath = pathLine.replace(/^.*?REG_(?:EXPAND_)?SZ\s+/i, '').trim();
    for (const directory of userPath.split(';').map(value => value.trim()).filter(Boolean)) {
      candidates.push(path.join(directory, 'codearts.cmd'));
      candidates.push(path.join(directory, 'codearts.exe'));
    }
  }

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {}
  }
  return commandExists('codearts') ? 'codearts' : null;
}

// Run the CLI shipped with this server, even when `g` is not in PATH or points
// to another install. Directory paths remain spawn options, never CMD source.
export async function launchGai(dirPath, {
  platform = process.platform,
  spawnFn = execFileAsync,
  terminalFn = launchInTerminal,
} = {}) {
  const entry = fileURLToPath(new URL('../../../gitCommit.js', import.meta.url));
  if (platform !== 'win32') return terminalFn(dirPath, process.execPath, [entry, 'ai']);

  const psLiteral = value => `'${String(value).replace(/'/g, "''")}'`;
  const encode = value => Buffer.from(value, 'utf16le').toString('base64');
  const command = `& ${psLiteral(process.execPath)} ${psLiteral(entry)} 'ai'`;
  // The hidden launcher opens a visible interactive console. -NoExit leaves
  // startup errors readable; no model request is sent until the user types.
  const launcher = [
    "$ErrorActionPreference = 'Stop';",
    "Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe')",
    `-ArgumentList '-NoLogo','-NoProfile','-NoExit','-EncodedCommand','${encode(command)}'`,
    '-WorkingDirectory (Get-Location).ProviderPath -WindowStyle Normal',
  ].join(' ');
  return spawnFn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encode(launcher)], {
    cwd: dirPath,
    windowsHide: true,
    timeout: 10000,
    // 这个终端窗口以及里面跑起来的 g ai，会继承下面这份 env；把注册表里新装的 CLI
    // 目录补进去，否则窗口里 `gh repo list` 照样报"不是内部或外部命令"
    // （本进程的 PATH 是启动快照）。见 utils/shellPath.js 顶部。
    env: await augmentEnvPath(process.env),
  });
}

/**
 * kimi 的权限档位。
 *
 *   'auto' | 'bypassPermissions' → `--auto`
 *       官方 help 原文 "Start in Never Ask mode: never interrupts you; everything runs
 *       and is decided automatically" —— 这才是它的**完全批准**档。
 *       `bypassPermissions` 只是让调用方与 claude / codex / opencode 那档共用同一个
 *       字符串，不是另一种行为。
 *   其余一切（undefined / 未知串 / 非字符串）→ 一个 flag 都不带（默认档：该问的照问）
 *
 * ⚠️ 这个 `--auto` 与 opencode 的 `--auto` **同名但语义不同**：opencode 是"自动批准
 *    未被显式拒绝的权限"（配置里 deny 的仍拦），kimi 是"从不打断"。档位 token 各按各家
 *    CLI 的叫法走，别硬凑一个公共词（同 codex 那段的取舍）。
 * ⚠️ kimi 还有一个中间档 `-y / --yolo`（Ask When Needed：常规编辑与命令自动放行，
 *    危险动作 / 提问 / 计划仍会问），菜单暂未暴露 —— 要加时在 KIMI_MODE_FLAGS 补一行。
 *
 * 白名单式：只有表里这两个 token 能变成参数。
 * 回归 `test/open-with-permission.test.mjs`。
 */
const KIMI_MODE_FLAGS = new Map([
  ['auto', ['--auto']],
  ['bypassPermissions', ['--auto']],
]);

export function buildKimiArgs(permissionMode) {
  return [...(KIMI_MODE_FLAGS.get(permissionMode) || [])];
}

async function launchKimiCode(dirPath, { permissionMode } = {}) {
  const cliArgs = buildKimiArgs(permissionMode);
  if (process.platform === 'win32') {
    const executable = await findKimiExecutable();
    if (!executable) throw new Error('未检测到 Kimi Code，请先安装 kimi CLI');
    return spawnDetached('cmd.exe', ['/c', 'start', '""', executable, ...cliArgs], { cwd: dirPath });
  }
  return launchInTerminal(dirPath, 'kimi', cliArgs);
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

// ── 官方桌面应用探测 / 启动 ────────────────────────────────────────────

async function isFileAt(p) {
  try { return (await fs.stat(p)).isFile(); } catch { return false; }
}

async function isDirAt(p) {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

/**
 * Windows 卸载注册表里所有 DisplayIcon / InstallLocation 的值（三个根各查一次，
 * 五个桌面应用共用这一遍 —— check-tools 每 10 分钟跑一轮，不能每个应用各查三遍）。
 * 为什么查注册表：NSIS / Inno 安装的桌面应用（Claude、CodeBuddy IDE、Kimi）
 * 安装路径随用户选择变，固定路径猜不中，注册表是唯一权威登记处。
 */
function scanWindowsUninstallPaths() {
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const values = [];
  for (const root of roots) {
    const output = spawnSync('reg.exe', ['query', root, '/s'], {
      encoding: 'utf8',
      windowsHide: true,
    }).stdout || '';
    for (const line of output.split(/\r?\n/)) {
      if (!/DisplayIcon|InstallLocation/i.test(line)) continue;
      const value = line.replace(/^.*?REG_(?:EXPAND_)?SZ\s+/i, '').trim().replace(/^"|"$/g, '').replace(/,\d+$/, '');
      if (value) values.push(value);
    }
  }
  return values;
}

/** 递归找一个名字匹配的项（开始菜单目录都很浅，递归开销可忽略） */
async function walkFindFile(dir, nameRe) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = await walkFindFile(full, nameRe);
      if (hit) return hit;
    } else if (nameRe.test(entry.name)) {
      return full;
    }
  }
  return null;
}

/**
 * 开始菜单两个 Programs 根里按文件名找快捷方式。
 * 为什么需要它：微软商店分发的桌面应用（Codex 桌面版所在的 ChatGPT 桌面）
 * 不进经典 Uninstall 注册表、安装路径也猜不中，但开始菜单一定有 .lnk；
 * 且 .lnk 本身就是可启动目标（ShellExecute 认快捷方式，见 launchDesktopAppTarget）。
 */
async function findStartMenuShortcut(nameRe) {
  const roots = [
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.PROGRAMDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ].filter(Boolean);
  for (const root of roots) {
    const hit = await walkFindFile(root, nameRe);
    if (hit) return hit;
  }
  return null;
}

/**
 * 探测某个工具的官方桌面应用：装没装、启动目标是什么。
 * target 是**可直接启动的东西**（exe / .app / .lnk / Linux 可执行文件）；
 * 没装上 target 为 null —— 前端据此把菜单项翻成「下载 X」并打开官网地址。
 *
 * 三平台口径：
 *   Windows  固定安装路径 → 卸载注册表（DisplayIcon 指向 exe / InstallLocation
 *            是目录时拼期望 exe 名）→ 开始菜单 .lnk（商店版应用走这条）
 *   macOS    /Applications/<App>.app
 *   Linux    固定候选路径（桌面版分发最不稳的平台，猜不中就降级成"去官网下载"）
 */
async function findDesktopApp(tool) {
  const app = TOOL_DESKTOP_APPS[tool];
  if (!app) return { installed: false, target: null };

  if (process.platform === 'win32') {
    const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES].filter(Boolean);
    for (const rel of app.winPaths || []) {
      for (const root of roots) {
        const candidate = path.join(root, rel);
        if (await isFileAt(candidate)) return { installed: true, target: candidate };
      }
    }
    // 注册表值两种形态：DisplayIcon 多直接指向 exe；InstallLocation 是目录，
    // 在目录下拼期望的 exe 名。值与 exe 名对不上的一律不算（防误报）。
    for (const value of scanWindowsUninstallPaths()) {
      if (/\.(ico|png|jpg|jpeg|svg)$/i.test(value)) continue;
      if (app.winExeRe.test(value) && (await isFileAt(value))) {
        return { installed: true, target: value };
      }
      if (await isDirAt(value)) {
        const exe = path.join(value, app.winExeName);
        if (await isFileAt(exe)) return { installed: true, target: exe };
      }
    }
    const lnk = await findStartMenuShortcut(app.winLnkRe);
    if (lnk) return { installed: true, target: lnk };
    return { installed: false, target: null };
  }

  if (process.platform === 'darwin') {
    const appDir = `/Applications/${app.macApp}`;
    return (await isDirAt(appDir)) ? { installed: true, target: appDir } : { installed: false, target: null };
  }

  for (const candidate of app.linuxPaths || []) {
    if (await isFileAt(candidate)) return { installed: true, target: candidate };
  }
  return { installed: false, target: null };
}

/**
 * 启动桌面应用。target 的三种形态分开处理：
 *   .lnk（开始菜单快捷方式）不能直接 spawn（CreateProcess 不认快捷方式），
 *     走 cmd /c start 让 ShellExecute 去解析；
 *   .app（macOS）是目录，交给 open 命令；
 *   其余（Windows exe / Linux 可执行文件）直接 detached spawn，与 zcode 一致。
 */
async function launchDesktopAppTarget(target) {
  if (process.platform === 'win32') {
    if (/\.lnk$/i.test(target)) {
      return spawnDetached('cmd.exe', ['/c', 'start', '""', target]);
    }
    return spawnDetached(target, []);
  }
  if (/\.app$/i.test(target)) {
    return spawnDetached('open', [target]);
  }
  return spawnDetached(target, []);
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

/**
 * 在新终端窗口里跑一条**服务端白名单内的**命令，跑完窗口不自动关。
 *
 * 与 launchToolInstaller 的区别：那个吃 installer 描述符(executable + args)，
 * 这个直接吃整条命令串。给「登录」这类**交互式** CLI 用 —— `gh auth login`
 * 会走一串问答(选 GitHub.com / 协议 / 浏览器还是粘贴 token)，必须在真终端里跑：
 * 被 spawn 出去又没有 TTY 的话，它直接就失败了，用户屏幕上什么也看不到。
 *
 * Windows 用 `cmd /k`：登录完成后窗口留着，用户能看清结果；失败也能看到报错。
 *
 * ⚠️ command 必须是服务端自己拼出来的常量。永远不要把它接成请求体里的字符串 ——
 * 那等于开了一个任意命令执行的口子(和 /api/install-tool 同一条原则)。
 *
 * `pathDirs` 是**必须**看的参数(2026-09-22 实测踩到)：
 *   本进程的 `process.env.PATH` 是"启动那一刻"的快照。用户在界面里刚装好 gh，
 *   安装器改的是**注册表**里的 PATH，我们这个已经跑着的 node 进程看不见 ——
 *   于是出现很割裂的一幕：**探测**能找到 gh(它走注册表 + 默认落点)，界面显示
 *   "gh 2.101.0 已安装"，可 `cmd /k gh auth login` 这个子进程按自己的 PATH 找，
 *   回一句 `'gh' 不是内部或外部命令`；而用户自己新开一个 cmd 却是好的，
 *   因为新进程拿到的是最新 PATH。
 *   解法有两层，缺一不可：
 *     1. **基线兜底**（`augmentEnvPath`）：把注册表 Machine + User 的 PATH 里本进程
 *        快照没有的目录补进子进程 —— 语义上等价于"这个进程是现在才启动的"。
 *        所以**不传 `pathDirs` 也不会踩旧快照**，`launchGai` 这类入口不用各自记得传。
 *     2. `pathDirs`：调用方**已经知道 CLI 落点**时显式**前置**，抢在别的同名命令之前。
 *        注意两层语义不同：兜底是追加（不动原有优先级），pathDirs 是前置（要优先）。
 *   比起"把可执行文件全路径拼进命令行"，前置 PATH 还顺带绕开了 cmd.exe 那套
 *   "路径带空格时的嵌套引号"地狱(`C:\Program Files\GitHub CLI\gh.exe`)。
 */
export async function launchCommandInTerminal(command, { cwd = process.cwd(), pathDirs = [] } = {}) {
  const dirs = pathDirs.filter(Boolean);
  const augmented = await augmentEnvPath(process.env);
  let env;
  if (dirs.length) {
    env = withPathValue(augmented, [...dirs, pathValueOf(augmented)].filter(Boolean).join(path.delimiter));
  } else {
    // 没有要补的就传 undefined，让子进程原样继承父环境（与改动前行为一致）
    env = augmented === process.env ? undefined : augmented;
  }

  if (process.platform === 'win32') {
    return spawnDetached('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/k', command], { cwd, env });
  }
  // posix 侧不额外处理 PATH：那边没有"安装器改注册表"这套机制，
  // 终端模拟器直接继承图形会话的环境，不会出现上面的错配。
  return launchInTerminal(cwd, 'bash', ['-lc', command]);
}

export function registerFileOpenRoutes({
  app,
  launchAi = launchGai,
}) {
  app.post('/api/open-directory-with-g-ai', asyncRoute(async (req, res) => {
    const dirPath = req.body?.path;
    if (typeof dirPath !== 'string' || !dirPath.trim() || /[\0\r\n]/.test(dirPath)) {
      throw new HttpError(400, '目录路径不能为空或包含控制字符');
    }
    const target = path.resolve(dirPath);
    let stat;
    try { stat = await fs.stat(target); }
    catch { throw new HttpError(400, '目录不存在或不可访问'); }
    if (!stat.isDirectory()) throw new HttpError(400, '指定路径不是目录');
    try { await launchAi(target); }
    catch (error) { throw new HttpError(400, `无法启动 g ai: ${error.message}`); }
    res.json({ success: true, message: '已在新终端中启动 g ai' });
  }));

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
          await launchCodex(dirPath, { permissionMode });
          const codexArgs = buildCodexArgs(permissionMode);
          const message = codexArgs.length
            ? `已用 Codex 打开目录（${codexArgs.join(' ')}）`
            : '已用 Codex 打开目录';
          res.json({ success: true, message });
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
          await launchOpenCode(dirPath, { permissionMode });
          const message = OPENCODE_AUTO_MODES.has(permissionMode)
            ? '已用 OpenCode 打开目录（--auto：自动批准未被显式拒绝的权限）'
            : '已用 OpenCode 打开目录';
          res.json({ success: true, message });
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

  // 用 CodeBuddy Code 打开目录
  app.post('/api/open-directory-with-codebuddy', asyncRoute(async (req, res) => {
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
          await launchCodebuddy(dirPath, { permissionMode });
          const message = CODEBUDDY_MODE_FLAGS.has(permissionMode)
            ? `已用 CodeBuddy Code 打开目录（permission-mode=${permissionMode}）`
            : '已用 CodeBuddy Code 打开目录';
          res.json({ success: true, message });
        } catch (error) {
          res.status(400).json({
            success: false,
            error: error.message || '未检测到 CodeBuddy Code，请先安装并确保可以在终端中直接运行 codebuddy'
          });
        }
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    }));

  // 用 Pi 打开目录
  app.post('/api/open-directory-with-pi', asyncRoute(async (req, res) => {
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
          await launchPi(dirPath);
          res.json({ success: true, message: '已用 Pi 打开目录' });
        } catch (error) {
          res.status(400).json({
            success: false,
            error: error.message || '未检测到 Pi，请先安装并确保可以在终端中直接运行 pi'
          });
        }
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    }));

  // 用码道 CLI 打开目录
  app.post('/api/open-directory-with-codearts', asyncRoute(async (req, res) => {
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
          await launchCodeArts(dirPath);
          res.json({ success: true, message: '已用 CodeArts 码道打开目录' });
        } catch (error) {
          res.status(400).json({
            success: false,
            error: error.message || '未检测到 codearts，请先安装并确保可以在终端中直接运行 codearts'
          });
        }
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    }));

  // 用 Kimi Code 打开目录
  app.post('/api/open-directory-with-kimi', asyncRoute(async (req, res) => {
    const { path: dirPath, permissionMode } = req.body || {};
    if (!dirPath) throw new HttpError(400, '目录路径不能为空');
    try {
      await fs.access(dirPath);
      await launchKimiCode(dirPath, { permissionMode });
      const message = KIMI_MODE_FLAGS.has(permissionMode)
        ? '已用 Kimi Code 打开目录（--auto：从不打断）'
        : '已用 Kimi Code 打开目录';
      res.json({ success: true, message });
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

  // 查询 npm registry 上的最新版本,供前端更新菜单显示「当前 v1 → 最新 v2」。
  // 只支持 TOOL_INSTALL_PACKAGES 里的 npm 工具;网络失败的工具返回 null(前端降级为原文案)。
  // body 可选 { tools: ['claude', ...] } —— 缺省查全部 npm 工具。
  app.post('/api/latest-tool-versions', asyncRoute(async (req, res) => {
      const { tools } = req.body || {};
      let requested;
      if (tools === undefined) {
        requested = Object.keys(TOOL_INSTALL_PACKAGES);
      } else {
        if (!Array.isArray(tools) || tools.some((t) => typeof t !== 'string')) {
          throw new HttpError(400, 'tools 必须是字符串数组');
        }
        const unknown = tools.filter((t) => !TOOL_INSTALL_PACKAGES[t]);
        if (unknown.length) {
          throw new HttpError(400, `不支持的工具: ${unknown.join(', ')}`);
        }
        requested = tools;
      }

      const entries = await Promise.all(
        requested.map(async (tool) => [tool, await fetchLatestVersion(TOOL_INSTALL_PACKAGES[tool])]),
      );
      res.json({
        success: true,
        latest: Object.fromEntries(entries),
      });
    }));

  // 打开某个工具的官方桌面应用（顶栏 / 项目菜单里的「打开 X 桌面端」走这里）。
  // 没装桌面端时返回 400 并带上官网地址 —— 前端在检测阶段就分叉了（没装直接
  // window.open 官网），会走到这里说明是检测之后才卸载的边角情况。
  app.post('/api/open-desktop-app', asyncRoute(async (req, res) => {
      const { tool } = req.body || {};
      const app = TOOL_DESKTOP_APPS[tool];
      if (!app) {
        throw new HttpError(400, '该工具没有桌面端');
      }
      const found = await findDesktopApp(tool);
      if (!found.installed || !found.target) {
        throw new HttpError(400, `未检测到 ${app.name}，请先到官网下载安装：${app.downloadUrl}`);
      }
      try {
        await launchDesktopAppTarget(found.target);
        res.json({ success: true, message: `已打开 ${app.name}` });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message || `无法启动 ${app.name}` });
      }
    }));

  // 检测本地工具是否已安装 + 采集版本号(供前端决定按钮行为、tooltip 显示版本)
  // 检测方式: spawn 'tool --version',exit 0 即视为已安装;stdout/stderr 里提取 semver。
  // 超时 15s:Claude CLI / opencode 等 Node 包装的工具首次冷启动
  // 在 Windows 上经常 5-7s(磁盘 cache + Defender 扫描),3s 永远命中超时。
  app.get('/api/check-tools', asyncRoute(async (req, res) => {
      const checkCmd = (cmd) => new Promise((resolve) => {
        const child = spawn(cmd, ['--version'], {
          // 要捕获输出来解析版本号,不能再用 'ignore'
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: process.platform === 'win32',
          windowsHide: true,
        });
        let output = '';
        let done = false;
        const finish = (ok) => {
          if (done) return;
          done = true;
          try { child.kill('SIGKILL'); } catch {}
          resolve({ installed: ok, version: parseVersionOutput(output) });
        };
        // 有些 CLI 把版本号打到 stderr(如部分 Node 包装工具),两边都收
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        child.on('error', () => finish(false));
        child.on('exit', (code) => finish(code === 0));
        setTimeout(() => finish(false), 15000);
      });

      // dsh / kimi 走 find*Executable 拿到完整路径,再补一次 --version 采版本。
      // zcode 是纯 GUI 桌面应用,ZCode.exe --version 行为未知(可能弹窗),不采集。
      const versionOfExecutable = (executable) => {
        if (!executable) return Promise.resolve(null);
        return new Promise((resolve) => {
          const child = spawn(executable, ['--version'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
            windowsHide: true,
          });
          let output = '';
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            try { child.kill('SIGKILL'); } catch {}
            resolve(parseVersionOutput(output));
          };
          child.stdout.on('data', (chunk) => { output += chunk; });
          child.stderr.on('data', (chunk) => { output += chunk; });
          child.on('error', () => finish());
          child.on('exit', () => finish());
          setTimeout(() => finish(), 15000);
        });
      };

      // dsh / kimi 的版本采集依赖 find 结果,用 then 链接保持全并行
      // (find 会跑两次——一次拿路径一次链版本——都是纯 fs/注册表查询,开销可忽略)
      // ⚠️ codebuddy 的 --version 是安全的:实测它只打印版本号就退出,不起引擎服务器
      // (裸跑 codebuddy 才会占 62443,与 checkCmd 的 --version 用法无关)。
      const [vscodeRes, claudeRes, codexRes, opencodeRes, codebuddyRes, piRes, codeArtsExecutable, kimiExecutable, zcodeExecutable, dshExecutable, kimiVersion, dshVersion, codeArtsVersion] = await Promise.all([
        checkCmd('code'),
        checkCmd('claude'),
        checkCmd('codex'),
        checkCmd('opencode'),
        checkCmd('codebuddy'),
        checkCmd('pi'),
        findCodeArtsExecutable(),
        findKimiExecutable(),
        findZCodeExecutable(),
        findDshExecutable(),
        findKimiExecutable().then(versionOfExecutable),
        findDshExecutable().then(versionOfExecutable),
        findCodeArtsExecutable().then(versionOfExecutable),
      ]);

      const installers = getToolInstallers();
      // 官方桌面应用探测：与 CLI 检测并行跑（各自只做 fs / 注册表查询，不起进程）。
      // 前端据此把菜单项翻成「打开 X 桌面端」（装了）/「下载 X 桌面端」（没装）。
      // downloadUrl 可能是函数（dsh 按平台/架构给固定下载地址），在这里统一解析成
      // 字符串再下发 —— 前端只认一个地址，平台判断留在服务端（与 UI 同机）。
      const desktopEntries = await Promise.all(
        Object.entries(TOOL_DESKTOP_APPS).map(async ([tool, app]) => {
          const found = await findDesktopApp(tool);
          return [tool, {
            installed: found.installed,
            name: app.name,
            downloadUrl: typeof app.downloadUrl === 'function'
              ? app.downloadUrl(process.platform, process.arch)
              : app.downloadUrl,
          }];
        }),
      );
      res.json({
        success: true,
        platform: process.platform,
        installers: publicInstallerInfo(installers),
        desktopApps: Object.fromEntries(desktopEntries),
        vscode: vscodeRes.installed,
        claude: claudeRes.installed,
        codex: codexRes.installed,
        opencode: opencodeRes.installed,
        codebuddy: codebuddyRes.installed,
        pi: piRes.installed,
        codearts: !!codeArtsExecutable,
        kimi: !!kimiExecutable,
        zcode: !!zcodeExecutable,
        dsh: !!dshExecutable,
        versions: {
          vscode: vscodeRes.version,
          claude: claudeRes.version,
          codex: codexRes.version,
          opencode: opencodeRes.version,
          codebuddy: codebuddyRes.version,
          pi: piRes.version,
          codearts: codeArtsVersion,
          kimi: kimiExecutable ? kimiVersion : null,
          zcode: null, // 桌面应用,无 CLI 版本通道
          dsh: dshExecutable ? dshVersion : null,
        },
      });
    }));
}

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
// git 子进程包装 + 命令历史 + 锁定文件过滤 git add
// 纯函数(parseCwdArg / truncateForHistory / formatDuration / delay)已抽到
// ./format.js,这里 re-export 以保持向后兼容(老调用方无需改 import)。
import chalk from 'chalk';
import boxen from "boxen";
import {execFile, execSync} from 'child_process'
import os from 'os'
import ora from "ora";
import readline from 'readline'
import path from 'path'
import fs from 'fs/promises'
import config from '../config.js'


import {
  parseCwdArg as _parseCwdArg,
  truncateForHistory as _truncateForHistory,
  formatDuration as _formatDuration,
  delay as _delay,
} from './format.js'

// 向后兼容 re-export — 老调用方 import { parseCwdArg } from '../utils' 仍然可用
export const parseCwdArg = _parseCwdArg
export const truncateForHistory = _truncateForHistory
export const formatDuration = _formatDuration
export const delay = _delay

const calcColor = (commandLine, str) => {
  let color = 'reset'
  if (commandLine === 'git status' && str.startsWith('\t')) {
    color = 'red'
    if (str.startsWith('modified:')) color = 'green'
    if (str.startsWith('deleted:')) color = 'red'
  }
  return color
}

const tableLog = (commandLine, content, type) => {
  const headLabel = `> ${commandLine}`
  let head = chalk.bold.blue(headLabel)
  if (type === 'error') {
    content = content.toString().split('\n')
    head = chalk.bold.red(headLabel)
  } else if (type === 'common') {
    content = content.split('\n')
  }

  // 单次输出限幅,避免 git log --all 之类命令刷屏
  const MAX_LINES = 10
  const MAX_LINE_LENGTH = 200
  let isTruncated = false
  if (content.length > MAX_LINES) {
    content = content.slice(0, MAX_LINES)
    isTruncated = true
  }

  content = content.map((item) => {
    const fontColor = calcColor(commandLine, item)
    let row = item.replaceAll('\t', '      ')
    if (row.length > MAX_LINE_LENGTH) {
      row = row.substring(0, MAX_LINE_LENGTH) + '...'
    }
    return chalk[fontColor](row)
  })

  if (isTruncated) {
    content.push(chalk.dim('... (输出内容过多，已省略)'))
  }

  // 极简打印 — 头一行 + 内容逐行,取代旧的 cli-table3 边框表格
  console.log(head)
  for (const line of content) console.log(line)
}

const coloredLog = (...args) => {
  const [commandLine, content, type = 'common'] = args
  tableLog(commandLine, content, type)
}

const errorLog = (commandLine, content) => {
  const msg = ` FAIL ${commandLine}\n content: ${content} `
  const box = boxen(chalk.red.bold(msg))
  console.log(box)
}
function execSyncGitCommand(command, options = {}) {
  let {encoding = 'utf-8', maxBuffer = 30 * 1024 * 1024, head = command, log = true} = options
  try {
    let cwd = getCwd()
    const output = execSync(command, {
      env: {
        ...process.env,
        // LANG: 'en_US.UTF-8',    // Linux/macOS
        // LC_ALL: 'en_US.UTF-8',  // Linux/macOS
        GIT_CONFIG_PARAMETERS: "'core.quotepath=false'" // 关闭路径转义
      }, encoding, maxBuffer, cwd
    })
    if (options.spinner) {
      options.spinner.stop();
    }
    let result = output.trim()
    log && coloredLog(head, result)
    // 打印当前目录和时间信息
    if (log) {
      const currentTime = new Date().toLocaleString('zh-CN', { hour12: false });
      console.log(chalk.dim(`📁 目录: ${cwd} | ⏰ 时间: ${currentTime}`));
    }
    return result
  } catch (e) {
    log && coloredLog(command, e, 'error')
    // 透传原始 error,保留 stack + 已挂载的 stdout/stderr
    throw e
  }
}

// Add a command history array to store commands and their results
const commandHistory = [];
const MAX_HISTORY_SIZE = 100;
// 输出截断上限 — 单点常量,避免在 execGitCommand / addCommandToHistory /
// 其他未来 history 写入点之间漂移导致截断行为不一致。
// 截断提示也集中在这里,所有调用方用同一个文案,便于后续 i18n 替换。
const MAX_OUTPUT_LENGTH = 5000;
const TRUNCATED_SUFFIX_STDOUT = '\n... (output truncated)';
const TRUNCATED_SUFFIX_STDERR = '\n... (error output truncated)';
const TRUNCATED_SUFFIX_MANUAL = '...[truncated]';

// 添加一个变量来保存Socket.io实例
let ioInstance = null;

// 提供注册Socket.io实例的函数
function registerSocketIO(io) {
  ioInstance = io;
}

// 清空命令历史记录
function clearCommandHistory() {
  // 清空数组
  commandHistory.length = 0;
  
  // 通过WebSocket广播历史已清空
  if (ioInstance) {
    ioInstance.emit('command_history_cleared');
  }
  
  return true;
}

function execGitCommand(command, options = {}) {
  return new Promise((resolve, reject) => {
    let {encoding = 'utf-8', maxBuffer = 30 * 1024 * 1024, head = Array.isArray(command) ? command.join(' ') : command, log = true} = options
    let cwd = getCwd()

    // Record start time for command execution
    const startTime = Date.now();

    // setTimeout(() => {
    // 用 execFile('git', argv) 跨平台执行:
    // - 不走 shell,Windows cmd.exe / POSIX sh 都一致
    // - argv 数组天然免疫 shell 注入,文件名/参数无需 shellQuote
    // - 所有调用点约定只跑 git 子命令,见 src/utils/index.js 内的 execGitCommand 调用清单
    execFile('git', command, {
      env: {
        ...process.env,
        // LANG: 'en_US.UTF-8',    // Linux/macOS
        // LC_ALL: 'en_US.UTF-8',  // Linux/macOS
        GIT_CONFIG_PARAMETERS: "'core.quotepath=false'" // 关闭路径转义
      },
      encoding,
      maxBuffer,
      cwd,
      // Windows 下 git 是 .exe;POSIX 下直接 PATH 找。
      // 不传 shell,杜绝 cmd.exe 单/双引号兼容问题与注入风险。
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (options.spinner) {
        options.spinner.stop();
      }
      
      // Calculate execution time
      const executionTime = Date.now() - startTime;

      // Truncate long outputs
      let truncatedStdout = stdout;
      let truncatedStderr = stderr;
      let isStdoutTruncated = false;
      let isStderrTruncated = false;

      if (stdout && stdout.length > MAX_OUTPUT_LENGTH) {
        truncatedStdout = truncateForHistory(stdout, MAX_OUTPUT_LENGTH, TRUNCATED_SUFFIX_STDOUT);
        isStdoutTruncated = true;
      }

      if (stderr && stderr.length > MAX_OUTPUT_LENGTH) {
        truncatedStderr = truncateForHistory(stderr, MAX_OUTPUT_LENGTH, TRUNCATED_SUFFIX_STDERR);
        isStderrTruncated = true;
      }

      // Add command to history
      // 用 head(已 join)而不是原始 command,确保历史里的 command 永远是字符串
      // 防止 execGitCommand(['status']) 这类数组调用把数组塞进历史 → 前端 item.command.trim() 崩
      const historyItem = {
        command: head,
        stdout: truncatedStdout || '',
        stderr: truncatedStderr || '',
        error: error ? error.message : null,
        executionTime,
        timestamp: new Date().toISOString(),
        success: !error,
        isStdoutTruncated,
        isStderrTruncated
      };
      
      // Add to history (limited size)
      commandHistory.unshift(historyItem);
      if (commandHistory.length > MAX_HISTORY_SIZE) {
        commandHistory.pop();
      }
      
      // 通过WebSocket广播命令历史更新
      if (ioInstance) {
        ioInstance.emit('command_history_update', { 
          newCommand: historyItem,
          fullHistory: commandHistory.slice(0, 10) // 只发送最近10条以减小数据量
        });
      }

      if (stdout) {
        log && coloredLog(head, stdout)
      }
      if (stderr) {
        log && coloredLog(head, stderr)
      }
      // 打印当前目录和时间信息
      if (log && (stdout || stderr)) {
        const currentTime = new Date().toLocaleString('zh-CN', { hour12: false });
        console.log(chalk.dim(`📁 目录: ${cwd} | ⏰ 时间: ${currentTime}`));
      }
      if (error) {
        log && coloredLog(head, error, 'error')
        // 错误情况也打印目录和时间
        if (log) {
          const currentTime = new Date().toLocaleString('zh-CN', { hour12: false });
          console.log(chalk.dim(`📁 目录: ${cwd} | ⏰ 时间: ${currentTime}`));
        }
        // 将 stdout 和 stderr 附加到 error 对象，以便上层可以获取完整输出
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }
      resolve({
        stdout,
        stderr
      })
    })
    // }, 1000)
  })
}

/**
 * 检查并尝试清理 Git 锁文件
 * @returns {Promise<boolean>} 是否清理成功
 */
async function checkAndClearGitLock() {
  try {
    const cwd = getCwd();
    let gitRoot;
    try {
      // 使用 execSync 快速获取 Git 根目录
      const rootOutput = execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf-8' });
      gitRoot = rootOutput.trim();
    } catch (e) {
      gitRoot = cwd;
    }

    const lockFilePath = path.join(gitRoot, '.git', 'index.lock');
    try {
      await fs.access(lockFilePath);
      // 如果文件存在，尝试删除它
      await fs.unlink(lockFilePath);
      console.log(chalk.green(`✅ 已清理 Git 锁文件: ${lockFilePath}`));
      return true;
    } catch (e) {
      // 文件不存在，不需要清理
      return false;
    }
  } catch (error) {
    console.error(chalk.red('清理 Git 锁文件失败:'), error.message);
    return false;
  }
}

// Function to get command history
// Cached cwd — 进程内 getCwd() 只算一次,见下方 getCwd() 实现
let _cachedCwd = null

function getCommandHistory() {
  return [...commandHistory];
}

// Function to manually add command to history (for commands not using execGitCommand)
function addCommandToHistory(command, stdout = '', stderr = '', error = null, executionTime = 0) {
  // 防御:历史里的 command 必须始终是字符串,防止前端 item.command.trim() 抛错
  if (Array.isArray(command)) {
    command = command.join(' ')
  } else if (typeof command !== 'string') {
    command = String(command ?? '')
  }

  // Truncate outputs if too long
  const isStdoutTruncated = stdout.length > MAX_OUTPUT_LENGTH;
  const isStderrTruncated = stderr.length > MAX_OUTPUT_LENGTH;
  const truncatedStdout = isStdoutTruncated ? truncateForHistory(stdout, MAX_OUTPUT_LENGTH, TRUNCATED_SUFFIX_MANUAL) : stdout;
  const truncatedStderr = isStderrTruncated ? truncateForHistory(stderr, MAX_OUTPUT_LENGTH, TRUNCATED_SUFFIX_MANUAL) : stderr;
  
  const historyItem = {
    command,
    stdout: truncatedStdout || '',
    stderr: truncatedStderr || '',
    error: error ? (typeof error === 'string' ? error : error.message) : null,
    executionTime,
    timestamp: new Date().toISOString(),
    success: !error,
    isStdoutTruncated,
    isStderrTruncated
  };
  
  // Add to history (limited size)
  commandHistory.unshift(historyItem);
  if (commandHistory.length > MAX_HISTORY_SIZE) {
    commandHistory.pop();
  }
  
  // Broadcast via WebSocket if available
  if (ioInstance) {
    ioInstance.emit('command_history_update', { 
      newCommand: historyItem,
      fullHistory: commandHistory.slice(0, 10)
    });
  }
  
  return historyItem;
}

const getCwd = () => {
  // process.argv 在进程内不变(CLI 启动后用户不会去改 process.argv),缓存一次
  // 即可。execGitCommand 在一次 g 流程里会被调 5-15 次(每个 git 子命令一次),
  // 缓存省掉重复的 Array.find + startsWith 扫描,在 GUI 后端常驻进程里累计收益更大。
  if (_cachedCwd === null) {
    const parsed = parseCwdArg(process.argv)
    _cachedCwd = parsed || process.cwd()
  }
  return _cachedCwd
}

/**
 * 主动让 getCwd 缓存失效。CLI 内部不会调;供 fs.js /api/change_directory
 * 之类的"cwd 改变"路径使用,避免后续 execGitCommand 仍然用旧 cwd 跑子命令。
 * 注意:CLI 子进程通常不需要这个,只有 GUI 后端在 chdir 后需要手动 clear。
 */
export function invalidateCwdCache() {
  _cachedCwd = null
}
const judgePlatform = () => {
  // 判断是否是 Windows 系统
  if (os.platform() === 'win32') {
    try {
      // 设置终端字符编码为 UTF-8 — 这条必须 sync,后续 console 输出依赖
      // 新的 code page,异步的话早期 console.log 会乱码。
      execSync('chcp 65001');
    } catch (e) {
      console.error('设置字符编码失败:', e.message);
    }
    // git config --global 不影响启动期 console 输出,丢到后台跑,避免
    // 两次额外的同步子进程阻塞 Node 启动(Windows 上各 ~30-80ms)
    setImmediate(() => {
      try {
        execSync('git config --global core.autocrlf true');
        execSync('git config --global core.quotepath false');
      } catch (e) {
        // 后台配置失败不致命,首次 commit 时用户会发现并自己跑命令
      }
    });
  } else {
    // 非 Windows:同样丢到后台
    setImmediate(() => {
      try {
        execSync('git config --global core.autocrlf input');
      } catch (_) {}
    });
  }
};
const showHelp = () => {
  const helpMessage = `
Usage: g [options]

Options:
  -h, --help                   Show this help message
  --set-default-message=<msg>  Set default commit message
  get-config                   Show current configuration
  -y                          Auto commit with default message
  -m <message>                Commit message (use quotes if message contains spaces)
  -m=<message>                Commit message (use this form without spaces around '=')
  --path=<path>               Set custom working directory
  --cwd=<path>                Set custom working directory
  --interval=<seconds>        Set interval time for automatic commits (in seconds)
  log                         Show git commit logs
    --n=<number>              Number of commits to show with --log
  --no-diff                   Skip displaying git diff
  addScript                   Add "g:y": "g -y" to package.json scripts
  addResetScript             Add "g:reset": "git reset --hard origin/<current-branch>" to package.json scripts
  ui                         Launch graphical user interface (v2.0.0)

File Locking:
  --lock-file=<path>          Lock a file to exclude it from commits
  --unlock-file=<path>        Unlock a previously locked file
  --list-locked               List all currently locked files
  --check-lock=<path>         Check if a file is locked

  --cmd="your-cmd"            Execute custom cmd command (immediately, at a time, or periodically)
  --cmd-interval=<seconds>    Execute custom cmd every N seconds
  --at="HH:MM"                Execute custom cmd at a specific time (today) or --at="YYYY-MM-DD HH:MM:SS"
  --daily                     Repeat with --at every day at the same time

Example:
  g --cmd="echo hello" --cmd-interval=5      # 每5秒执行一次echo hello
  g --cmd="echo at-time" --at=23:59          # 在23:59执行一次echo at-time
  g --cmd="echo daily" --at=23:59 --daily    # 每天23:59执行一次echo daily
  g --cmd="echo now"                         # 立即执行一次echo now
  g --cmd="echo hi" --cmd-interval=10 --interval=60  # cmd和git自动提交并行
  g -m "Initial commit"      Commit with a custom message
  g -m=Fix-bug              Commit with a custom message (no spaces around '=')
  g -y                      Auto commit with the default message
  g -y --interval=600       Commit every 10 minutes (600 seconds)
  g --path=/path/to/repo    Specify a custom working directory
  g log                     Show recent commit logs
  g log --n=5               Show the last 5 commits with --log
  g addScript              Add auto commit script to package.json
  g addResetScript         Add reset script to package.json
  g --lock-file=config.json    Lock config.json file
  g --unlock-file=config.json  Unlock config.json file
  g --list-locked              List all locked files

Add auto submit in package.json:
  "scripts": {
    "g:y": "g -y",
    "g:reset": "git reset --hard origin/<current-branch>"
  }

Run in the background across platforms:
  Windows:
    start /min cmd /k "g -y --path=your-folder --interval=600"
  
  Linux/macOS:
    nohup g -y --path=your-folder --interval=600 > git-autocommit.log 2>&1 &

Start GUI interface:
  g ui

Stop all monitoring processes:
  Windows: Terminate the Node.js process in the Task Manager.
  Linux/macOS:
    pkill -f "g -y"       # Terminate all auto-commit processes
    ps aux | grep "g -y"  # Find the specific process ID
    kill [PID]            # Terminate the specified process
  `;

  console.log(helpMessage);
  process.exit();
};

function judgeLog() {
  const logArg = process.argv.find(arg => arg === 'log');
  if (logArg) {
    printGitLog(); // 如果有 log 参数，打印 Git 提交记录
    // 打印完成后退出
    process.exit();
  }
}

function judgeHelp() {
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    showHelp();
  }
}

async function printGitLog() {
  let n = 20;
  let logArg = process.argv.find(arg => arg.startsWith('--n='));
  if (logArg) {
    n = parseInt(logArg.split('=')[1], 10);
  }
  // 使用 ASCII 记录分隔符 %x1E 作为字段分隔符
  const logCommand = ['log', '-n', n, '--pretty=format:%C(green)%h%C(reset) %x1E %C(cyan)%an%C(reset) %x1E %C(yellow)%ad%C(reset) %x1E %C(blue)%D%C(reset) %x1E %C(magenta)%s%C(reset)', '--date=format:%Y-%m-%d %H:%M', '--graph', '--decorate', '--color']
  try {
    const logOutput = await execGitCommand(logCommand, {
      head: `git log`
    });
  } catch (error) {
    console.error('无法获取 Git 提交记录:', error.message);
  }
  // 打印完成后退出
  process.exit();
}

function exec_exit(exit) {
  // 仅当显式传 true 时退出;空值/0/'false'/'no'/其他非真值都按"不退出"处理。
  // 之前的 truthy 判断会把字符串 'false' 误判为 true(非空字符串都是 truthy),
  // 调用方传 '--exit=false' 等解析出来的字符串时会错误退出。
  if (exit === true) {
    process.exit()
  }
}

function judgeUnmerged(statusOutput) {
  const hasUnmerged = statusOutput.includes('You have unmerged paths');
  if (hasUnmerged) {
    errorLog('错误', '存在未合并的文件，请先解决冲突')
    process.exit(1);
  }
}

async function exec_push({exit, commitMessage}) {
  // 执行 git push
  const spinner = ora('正在推送代码...').start();
  try {
    const {stdout, stderr} = await execGitCommand(['push'], {
      spinner
    });
    await printCommitLog({commitMessage});
    return {stdout, stderr};
  } catch (error) {
    throw error;
  }
}

async function printCommitLog({commitMessage}) {
  try {
    // 获取项目名称（取git仓库根目录名）
    const projectRootResult = await execGitCommand(['rev-parse', '--show-toplevel'], {log: false});
    const projectName = chalk.blueBright(path.basename(projectRootResult.stdout.trim()));

    // 获取当前提交hash（取前7位）
    const commitHashResult = await execGitCommand(['rev-parse', '--short', 'HEAD'], {log: false});
    const hashDisplay = chalk.yellow(commitHashResult.stdout.trim());

    // 获取分支信息
    const branchResult = await execGitCommand(['branch', '--show-current'], {log: false});
    const branchDisplay = chalk.magenta(branchResult.stdout.trim());

    // 构建信息内容
    const message = [
      `${chalk.cyan.bold('Project:')} ${projectName}`,
      `${chalk.cyan.bold('Commit:')} ${hashDisplay} ${chalk.dim('on')} ${branchDisplay}`,
      `${chalk.cyan.bold('Message:')} ${chalk.reset(commitMessage)}`,
      `${chalk.cyan.bold('Time:')} ${new Date().toLocaleString()}`
    ].join('\n');

    // 使用boxen创建装饰框
    const box = boxen(message, {
      padding: 1,
      margin: 1,
      borderStyle: 'round',
      borderColor: 'green',
      title: chalk.bold.green('✅ COMMIT SUCCESS'),
      titleAlignment: 'center',
      float: 'left',
      textAlignment: 'left'
    });

    console.log(box);
  } catch (error) {
    // 异常处理
    const errorBox = boxen(chalk.red(`Failed to get commit details: ${error.message}`), {
      borderColor: 'red',
      padding: 1
    });
    console.log(errorBox);
  }
}

async function execPull() {
  try {
    // 检查是否需要拉取更新
    const spinner = ora('正在拉取代码...').start();
    await execGitCommand(['pull'], {
      spinner
    })
  } catch (e) {
    console.log(chalk.yellow('⚠️ 拉取远程更新合并失败，可能存在冲突，请手动处理'));
    throw Error(e)
  }
}

async function judgeRemote() {
  const spinner = ora('正在检查远程更新...').start();
  try {
    // 检查是否有远程更新
    // 先获取远程最新状态
    await execGitCommand(['remote', 'update'], {
      head: 'Fetching remote updates',
      log: false
    });
    // 检查是否需要 pull
    const res = await execGitCommand(['rev-list', 'HEAD..@{u}', '--count'], {
      head: 'Checking if behind remote',
      log: false
    });
    const behindCount = res.stdout.trim()
    const { green, black, bgGreen, white } = chalk;
    // 如果本地落后于远程
    if (parseInt(behindCount) > 0) {
      try {
        spinner.stop();
        // const spinner_pull = ora('发现远程更新，正在拉取...').start();
        await execPull()

        // // 尝试使用 --ff-only 拉取更新
        // const res = await execGitCommand('git pull --ff-only', {
        //   spinner: spinner_pull,
        //   head: 'Pulling updates'
        // });
        //   bgGreen.white.bold(' SYNC ') +
        //   green` ➔ ` +
        //   chalk.blue.bold('远程仓库已同步') +
        //   green(' ✔')
        // );
        const message = '已成功同步远程更新'.split('').map((char, i) =>
          chalk.rgb(0, 255 - i*10, 0)(char)
        ).join('');

        console.log(chalk.bold(`✅ ${message}`));
      } catch (pullError) {
        // // 如果 --ff-only 拉取失败，尝试普通的 git pull
        // await this.execPull()
        throw new Error(pullError)
      }
    } else {
      spinner.stop();
      const message = '本地已是最新'.split('').map((char, i) =>
        chalk.rgb(0, 255 - i*10, 0)(char)
      ).join('');
      console.log(chalk.bold(`✅ ${message}`));
    }
  } catch (e) {
    spinner.stop();
    throw new Error(e)
  }
}

async function execDiff() {
  const no_diff = process.argv.find(arg => arg.startsWith('--no-diff'))
  if (!no_diff) {
    await execGitCommand(['diff', '--color=always'], {
      head: `git diff`
    })
  }
}

// 执行 git add 但排除锁定的文件
async function execGitAddWithLockFilter() {
  try {
    // 获取锁定的文件列表
    const lockedFiles = await config.getLockedFiles();

    if (lockedFiles.length === 0) {
      // 如果没有锁定文件，直接执行 git add .
      await execGitCommand(['add', '.']);
      return;
    }

    // 获取Git工作目录根路径，确保路径匹配的准确性
    let gitRoot;
    try {
      const gitRootResult = await execGitCommand(['rev-parse', '--show-toplevel'], {log: false});
      gitRoot = path.normalize(gitRootResult.stdout.trim());
    } catch (error) {
      console.warn(chalk.yellow('⚠️ 无法获取Git根目录，使用当前工作目录'));
      gitRoot = path.normalize(process.cwd());
    }

    // 获取所有修改的文件（包括未跟踪文件）
    const statusResult = await execGitCommand(['status', '--porcelain', '--untracked-files=all'], {log: false});
    const modifiedFiles = statusResult.stdout
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        // 解析 git status --porcelain 的输出格式
        // 格式: XY filename 或 XY "filename with spaces"
        const match = line.match(/^..\s+(.+)$/);
        if (match) {
          let filename = match[1];
          // 如果文件名被引号包围，去掉引号
          if (filename.startsWith('"') && filename.endsWith('"')) {
            filename = filename.slice(1, -1);
            // 处理转义字符
            filename = filename.replace(/\\(.)/g, '$1');
          }
          return filename;
        }
        return null;
      })
      .filter(Boolean);

    // 过滤掉锁定的文件，使用更严格的路径匹配逻辑
    const filesToAdd = modifiedFiles.filter(file => {
      // Git status 返回的是相对于Git根目录的路径
      const gitRelativeFile = path.normalize(file);
      
      const isLocked = lockedFiles.some(lockedFile => {
        // 处理锁定文件路径：可能是相对路径或绝对路径
        let normalizedLocked;
        if (path.isAbsolute(lockedFile)) {
          // 绝对路径：转换为相对于Git根目录的路径
          const absoluteLocked = path.normalize(lockedFile);
          if (absoluteLocked.startsWith(gitRoot)) {
            normalizedLocked = path.relative(gitRoot, absoluteLocked);
          } else {
            // 锁定文件不在当前Git仓库中，跳过
            return false;
          }
        } else {
          // 相对路径：直接使用
          normalizedLocked = path.normalize(lockedFile);
        }
        
        // 统一路径分隔符（Windows兼容性）
        const normalizedGitFile = gitRelativeFile.replace(/\\/g, '/');
        const normalizedLockedFile = normalizedLocked.replace(/\\/g, '/');
        
        // 精确匹配或目录匹配（双向检查）
        const isExactMatch = normalizedGitFile === normalizedLockedFile;
        const isFileInLockedDir = normalizedGitFile.startsWith(normalizedLockedFile + '/');
        const isLockedFileInDir = normalizedLockedFile.startsWith(normalizedGitFile + '/');
        
        return isExactMatch || isFileInLockedDir || isLockedFileInDir;
      });
      
      // 额外检查：如果是目录路径，检查该目录下是否有任何未锁定的文件
      if (!isLocked && file.endsWith('/')) {
        // 这是一个目录路径，检查是否该目录下所有文件都被锁定
        const dirPath = file.slice(0, -1); // 移除末尾的 '/'
        const hasUnlockedFilesInDir = modifiedFiles.some(otherFile => {
          if (otherFile === file) return false; // 跳过目录本身
          
          const normalizedOtherFile = path.normalize(otherFile).replace(/\\/g, '/');
          const normalizedDirPath = dirPath.replace(/\\/g, '/');
          
          // 检查文件是否在这个目录下
          if (normalizedOtherFile.startsWith(normalizedDirPath + '/')) {
            // 检查这个文件是否被锁定
            const isOtherFileLocked = lockedFiles.some(lockedFile => {
              let normalizedLocked;
              if (path.isAbsolute(lockedFile)) {
                const absoluteLocked = path.normalize(lockedFile);
                if (absoluteLocked.startsWith(gitRoot)) {
                  normalizedLocked = path.relative(gitRoot, absoluteLocked);
                } else {
                  return false;
                }
              } else {
                normalizedLocked = path.normalize(lockedFile);
              }
              
              const normalizedLockedFile = normalizedLocked.replace(/\\/g, '/');
              return normalizedOtherFile === normalizedLockedFile ||
                     normalizedOtherFile.startsWith(normalizedLockedFile + '/') ||
                     normalizedLockedFile.startsWith(normalizedOtherFile + '/');
            });
            
            return !isOtherFileLocked; // 如果文件未锁定，返回 true
          }
          return false;
        });
        
        // 如果目录下没有未锁定的文件，则跳过这个目录
        if (!hasUnlockedFilesInDir) {
          console.log(chalk.yellow(`🔒 跳过目录（所有文件都被锁定）: ${file}`));
          return false;
        }
      }

      if (isLocked) {
        console.log(chalk.yellow(`🔒 跳过锁定文件: ${file}`));
        return false;
      }
      return true;
    });

    if (filesToAdd.length === 0) {
      console.log(chalk.blue('📝 所有修改的文件都被锁定，没有文件需要添加'));
      return;
    }

    // 逐个添加未锁定的文件
    // 用 execFile('git', argv) 直接传 argv 数组,不经过 shell,
    // 文件名含空格/特殊字符时不需要 shellQuote;同时跨 Windows cmd.exe /
    // POSIX sh 都一致(此前单引号写法在 Windows cmd.exe 不被识别,导致
    // "pathspec '...did not match any files" 报错,见 da01bcb 回归)。
    let successCount = 0
    let failedFiles = []
    for (const file of filesToAdd) {
      try {
        await execGitCommand(['add', '--', file], {
          head: `git add ${file}`,
          log: false
        })
        successCount++
      } catch (err) {
        // 单文件失败不阻断整批,记录失败清单让用户感知
        failedFiles.push({ file, error: err?.message || String(err) })
        console.warn(chalk.yellow(`⚠️ 添加失败: ${file} — ${err?.message || err}`))
      }
    }

    const skippedCount = modifiedFiles.length - filesToAdd.length;
    const failSuffix = failedFiles.length > 0 ? `, ${failedFiles.length} 个失败` : ''
    console.log(chalk.green(`✅ 已添加 ${successCount} 个文件到暂存区${skippedCount > 0 ? ` (跳过 ${skippedCount} 个锁定文件)` : ''}${failSuffix}`));
    if (failedFiles.length > 0) {
      // 把失败列表挂到 thrown error 上,上层可选择性展示
      const e = new Error(`git add 部分失败 (${failedFiles.length}/${filesToAdd.length})`)
      e.failedFiles = failedFiles
      throw e
    }

  } catch (error) {
    console.error(chalk.red('执行 git add 时出错:'), error.message);
    throw error;
  }
}

async function execAddAndCommit({statusOutput, commitMessage, exit}) {
  // 检查 -m 参数（提交信息）
  const commitMessageArg = process.argv.find(arg => arg.startsWith('-m'));
  if (commitMessageArg) {
    if (commitMessageArg.includes('=')) {
      // 处理 -m=<message> 的情况
      commitMessage = commitMessageArg.split('=')[1]?.replace(/^['"]|['"]$/g, '');
    } else {
      // 处理 -m <message> 的情况
      const index = process.argv.indexOf(commitMessageArg);
      if (index !== -1 && process.argv[index + 1]) {
        commitMessage = process.argv[index + 1]?.replace(/^['"]|['"]$/g, '');
      }
    }
  }

  // 检查命令行参数，判断是否有 -y 参数
  const autoCommit = process.argv.includes('-y');

  if (!autoCommit && !commitMessageArg) {
    // 如果没有 -y 参数，则等待用户输入提交信息
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    })

    function rlPromisify(fn) {
      return async (...args) => {
        return new Promise((resolve, reject) => fn(...args, resolve, reject))
      }
    }

    const question = rlPromisify(rl.question.bind(rl))
    commitMessage = await question('请输入提交信息：') || commitMessage;
    rl.close(); // 关闭 readline 接口
  }

  // 使用带锁定文件过滤的 git add
  if (statusOutput.includes('(use "git add')) {
    await execGitAddWithLockFilter();
  }

  // 提交前二次校验（包括未跟踪文件）
  const checkStatus = await execGitCommand(['status', '--porcelain', '--untracked-files=all'], {log: false});
  if (!checkStatus.stdout.trim()) {
    console.log(chalk.yellow('⚠️ 没有检测到可提交的变更'));
    // exec_exit(exit)
    return commitMessage; // 返回提交信息（即使没有提交）
  }

  // 执行 git commit
  if (statusOutput.includes('Untracked files:') || statusOutput.includes('Changes not staged for commit') || statusOutput.includes('Changes to be committed')) {
    await execGitCommand(['commit', '-m', commitMessage])
  }
  
  // 返回实际使用的提交信息
  return commitMessage;
}

// 添加时间格式化函数
async function addScriptToPackageJson() {
  try {
    // 读取当前目录的 package.json
    const packagePath = path.join(process.cwd(), 'package.json');
    const packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    
    // 确保有 scripts 部分
    if (!packageJson.scripts) {
      packageJson.scripts = {};
    }

    // 添加 g:y 命令
    if (!packageJson.scripts['g:y']) {
      packageJson.scripts['g:y'] = 'g -y';
      // 写回文件
      await fs.writeFile(packagePath, JSON.stringify(packageJson, null, 2));
      console.log(chalk.green('✓ 成功添加 g:y 脚本到 package.json'));
    } else {
      console.log(chalk.yellow('⚠️ g:y 脚本已存在'));
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(chalk.red('❌ 当前目录下未找到 package.json 文件'));
    } else {
      console.error(chalk.red('❌ 添加脚本失败:'), error.message);
    }
    process.exit(1);
  }
}

async function addResetScriptToPackageJson() {
  try {
    // 读取当前目录的 package.json
    const packagePath = path.join(process.cwd(), 'package.json');
    const packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    
    // 确保有 scripts 部分
    if (!packageJson.scripts) {
      packageJson.scripts = {};
    }

    // 获取当前分支名
    const branchResult = await execGitCommand(['branch', '--show-current'], {log: false});
    const branch = branchResult.stdout.trim();

    // 添加 g:reset 命令
    if (!packageJson.scripts['g:reset']) {
      packageJson.scripts['g:reset'] = `git reset --hard origin/${branch}`;
      // 写回文件
      await fs.writeFile(packagePath, JSON.stringify(packageJson, null, 2));
      console.log(chalk.green(`✓ 成功添加 g:reset 脚本到 package.json (重置到 origin/${branch})`));
    } else {
      console.log(chalk.yellow('⚠️ g:reset 脚本已存在'));
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(chalk.red('❌ 当前目录下未找到 package.json 文件'));
    } else {
      console.error(chalk.red('❌ 添加脚本失败:'), error.message);
    }
    process.exit(1);
  }
}

export {
  coloredLog, errorLog, execSyncGitCommand,
  execGitCommand, getCommandHistory, addCommandToHistory, // Add command history exports
  clearCommandHistory,
  // parseCwdArg / truncateForHistory / formatDuration / delay 已在文件顶部从
  // ./format.js re-export,这里不再重复导出,避免 Duplicate export 错误。
  checkAndClearGitLock,
  registerSocketIO, // 导出注册Socket.io的函数
  getCwd, judgePlatform, showHelp, judgeLog, printGitLog,
  judgeHelp, exec_exit, judgeUnmerged,
  exec_push, execPull, judgeRemote, execDiff, execAddAndCommit,
  execGitAddWithLockFilter, // 导出新的 git add 函数
  addScriptToPackageJson, addResetScriptToPackageJson
};

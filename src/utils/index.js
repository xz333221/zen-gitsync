// const chalk = require('chalk');
// const boxen = require('boxen');
// const message = chalk.blue('git diff') + '\n' +
//   chalk.red('- line1') + '\n' +
//   chalk.green('+ line2') + '\n' +
//   chalk.cyan('@@ line diff @@');
//
// const options = {
//   padding: 1,
//   margin: 1,
//   borderStyle: 'round',  // 可以选择 'single', 'double', 'round' 等边框样式
//   borderColor: 'yellow'
// };
//
// const boxedMessage = boxen(message, options);
// console.log(boxedMessage);
import stringWidth from 'string-width';
import Table from 'cli-table3';
import chalk from 'chalk';
import boxen from "boxen";
import {exec, execSync} from 'child_process'
import os from 'os'
import ora from "ora";
import readline from 'readline'
import path from 'path'
import fs from 'fs/promises'


const printTableWithHeaderUnderline = (head, content, style) => {
  // 获取终端的列数（宽度）
  const terminalWidth = process.stdout.columns;

  // 计算表格的宽度，保证至少有 2 个字符留给边框
  const tableWidth = terminalWidth - 2; // 左右边框和分隔符的宽度

  // 计算每列的宽度
  const colWidths = [tableWidth]; // 只有一列，因此宽度设置为终端宽度

  if (!style) {
    style = {
      // head: ['cyan'], // 表头文字颜色为cyan
      border: [chalk.reset()],         // 边框颜色
      compact: true,              // 启用紧凑模式，去掉不必要的空白
    }
  }
  // 创建表格实例
  const table = new Table({
    head: [head],  // 只有一个表头
    colWidths,       // 使用动态计算的列宽
    style: style,
    wordWrap: true,  // 启用自动换行
    // chars: {
    //   'top': '─',
    //   'top-mid': '┬',
    //   'bottom': '─',
    //   'mid': '─',
    //   'left': '│',
    //   'right': '│'
    // },
    // chars: {
    //   'top': '═',       // 顶部边框使用长横线
    //   'top-mid': '╤',   // 顶部连接符
    //   'top-left': '╔',   // 左上角
    //   'top-right': '╗',  // 右上角
    //   'bottom': '═',    // 底部边框
    //   'bottom-mid': '╧', // 底部连接符
    //   'bottom-left': '╚',// 左下角
    //   'bottom-right': '╝',// 右下角
    //   'left': '║',      // 左边框
    //   'left-mid': '╟',  // 左连接符
    //   'mid': '═',       // 中间分隔符
    //   'mid-mid': '╪',   // 中间连接符
    //   'right': '║',     // 右边框
    //   'right-mid': '╢', // 右连接符
    //   'middle': '│'     // 中间内容的边界
    // }
  });

  // 向表格中添加不同颜色的行
  // eg:
  // table.push(
  //   [chalk.red('张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三张三')],
  //   [chalk.green('李四')],
  // );
  content.forEach(item => {
    table.push([item]);
  })

  console.log(table.toString()); // 输出表格
};

// printTableWithHeaderUnderline();

const colors = [
  '\x1b[31m',  // 红色
  '\x1b[32m',  // 绿色
  '\x1b[33m',  // 黄色
  '\x1b[34m',  // 蓝色
  '\x1b[35m',  // 紫色
  '\x1b[36m',  // 青色
];

function getRandomColor() {
  return `\x1b[0m`;
  // const randomIndex = Math.floor(Math.random() * colors.length);
  // return colors[randomIndex];
}

function resetColor() {
  return '\x1b[0m';
}

const calcColor = (commandLine, str) => {
  let color = 'reset'
  switch (commandLine) {
    case 'git status':
      if (str.startsWith('\t')) {
        color = 'red'
        if (str.startsWith('new file:')) {
          color = 'red'
        }
        if (str.startsWith('modified:')) {
          color = 'green'
        }
        if (str.startsWith('deleted:')) {
          color = 'red'
        }
      }
      break;
    case 'git diff':
      // if (str.startsWith('---')) {
      //   color = 'red'
      // }
      // if (str.startsWith('+++')) {
      //   color = 'green'
      // }
      // if (str.startsWith('@@ ')) {
      //   color = 'cyan'
      // }
      break;
  }
  return color
}
const tableLog = (commandLine, content, type) => {
  let handle_commandLine = `> ${commandLine}`
  let head = chalk.bold.blue(handle_commandLine)
  let style = {
    // head: ['cyan'], // 表头文字颜色为cyan
    border: [chalk.reset()],         // 边框颜色
    compact: true,              // 启用紧凑模式，去掉不必要的空白
  }
  switch (type) {
    case 'error':
      style.head = ['red'];
      content = content.toString().split('\n')
      head = chalk.bold.red(handle_commandLine)
      break;
    case 'common':
      style.head = ['blue'];
      content = content.split('\n')
      break;
    default:
      break;
  }
  content = content.map(item => {
    let fontColor = calcColor(commandLine, item)
    let row = item.replaceAll('\t', '      ')
    return chalk[fontColor](row)
  })

  printTableWithHeaderUnderline(head, content, style)
}
const coloredLog = (...args) => {
  // 获取参数内容
  const commandLine = args[0];
  const content = args[1];
  const type = args[2] || 'common';
  // console.log(`commandLine ==> `, commandLine)
  // console.log(`content ==> `, content)
  // console.log(`type ==> `, type)
  tableLog(commandLine, content, type);
}
const errorLog = (commandLine, content) => {
  // 使用 boxen 绘制带边框的消息
  let msg = ` FAIL ${commandLine}
 content: ${content} `
  const message = chalk.red.bold(msg);
  const box = boxen(message);
  console.log(box); // 打印带有边框的消息
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
    return result
  } catch (e) {
    // console.log(`执行命令出错 ==> `, command, e)
    log && coloredLog(command, e, 'error')
    throw new Error(e)
  }
}

function execGitCommand(command, options = {}) {
  return new Promise((resolve, reject) => {
    let {encoding = 'utf-8', maxBuffer = 30 * 1024 * 1024, head = command, log = true} = options
    let cwd = getCwd()

    // setTimeout(() => {
    exec(command, {
      env: {
        ...process.env,
        // LANG: 'en_US.UTF-8',    // Linux/macOS
        // LC_ALL: 'en_US.UTF-8',  // Linux/macOS
        GIT_CONFIG_PARAMETERS: "'core.quotepath=false'" // 关闭路径转义
      },
      encoding,
      maxBuffer,
      cwd
    }, (error, stdout, stderr) => {
      if (options.spinner) {
        options.spinner.stop();
      }

      if (stdout) {
        log && coloredLog(head, stdout)
      }
      if (stderr) {
        log && coloredLog(head, stderr)
      }
      if (error) {
        log && coloredLog(head, error, 'error')
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

const getCwd = () => {
  const cwdArg = process.argv.find(arg => arg.startsWith('--path')) || process.argv.find(arg => arg.startsWith('--cwd'));
  if (cwdArg) {
    // console.log(`cwdArg ==> `, cwdArg)
    const [, value] = cwdArg.split('=')
    // console.log(`value ==> `, value)
    return value || process.cwd()
  }
  return process.cwd()
}
const judgePlatform = () => {
  // 判断是否是 Windows 系统
  if (os.platform() === 'win32') {
    try {
      // 设置终端字符编码为 UTF-8
      execSync('chcp 65001');
      execSync('git config --global core.autocrlf true');
      // 设置Git不转义路径（避免中文显示为八进制）
      execSync('git config --global core.quotepath false');
    } catch (e) {
      console.error('设置字符编码失败:', e.message);
    }
  }else{
    execSync('git config --global core.autocrlf input');
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

Example:
  g -m "Initial commit"      Commit with a custom message
  g -m=Fix-bug              Commit with a custom message (no spaces around '=')
  g -y                      Auto commit with the default message
  g -y --interval=600       Commit every 10 minutes (600 seconds)
  g --path=/path/to/repo    Specify a custom working directory
  g log                     Show recent commit logs
  g log --n=5               Show the last 5 commits with --log
  g addScript              Add auto commit script to package.json
  g addResetScript         Add reset script to package.json

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
  const logCommand = `git log -n ${n} --pretty=format:"%C(green)%h%C(reset) | %C(cyan)%an%C(reset) | %C(yellow)%ad%C(reset) | %C(blue)%D%C(reset) | %C(magenta)%s%C(reset)" --date=format:"%Y-%m-%d %H:%M" --graph --decorate --color`
  try {
    const logOutput = execSyncGitCommand(logCommand, {
      head: `git log`
    });
  } catch (error) {
    console.error('无法获取 Git 提交记录:', error.message);
  }
  // 打印完成后退出
  process.exit();
}

function exec_exit(exit) {
  if (exit) {
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

function exec_push({exit, commitMessage}) {
  // 执行 git push
  // execSyncGitCommand(`git push`);
  return new Promise((resolve, reject) => {
    const spinner = ora('正在推送代码...').start();
    execGitCommand('git push', {
      spinner
    }).then(({stdout, stderr}) => {
      printCommitLog({commitMessage})
      resolve({stdout, stderr})
    })
  });
}

function printCommitLog({commitMessage}) {
  try {
    // 获取项目名称（取git仓库根目录名）
    const projectRoot = execSyncGitCommand('git rev-parse --show-toplevel', {log: false});
    const projectName = chalk.blueBright(path.basename(projectRoot.trim()));

    // 获取当前提交hash（取前7位）
    const commitHash = execSyncGitCommand('git rev-parse --short HEAD', {log: false}).trim();
    const hashDisplay = chalk.yellow(commitHash);

    // 获取分支信息
    const branch = execSyncGitCommand('git branch --show-current', {log: false}).trim();
    const branchDisplay = chalk.magenta(branch);

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
    await execGitCommand('git pull', {
      spinner
    })
  } catch (e) {
    console.log(chalk.yellow('⚠️ 拉取远程更新合并失败，可能存在冲突，请手动处理'));
    throw Error(e)
  }
}

function delay(timeout) {
  return new Promise(resolve => setTimeout(resolve, timeout));
}

async function judgeRemote() {
  const spinner = ora('正在检查远程更新...').start();
  try {
    // 检查是否有远程更新
    // 先获取远程最新状态
    await execGitCommand('git remote update', {
      head: 'Fetching remote updates',
      log: false
    });
    // 检查是否需要 pull
    const res = await execGitCommand('git rev-list HEAD..@{u} --count', {
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
        // console.log(
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
        // console.log(chalk.yellow('⚠️ 无法快进合并，尝试普通合并...'));
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
    // console.log(`e ==> `, e)
    spinner.stop();
    throw new Error(e)
  }
}

async function execDiff() {
  const no_diff = process.argv.find(arg => arg.startsWith('--no-diff'))
  if (!no_diff) {
    await execGitCommand('git diff --color=always', {
      head: `git diff`
    })
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
  }

  statusOutput.includes('(use "git add') && await execGitCommand('git add .')
  // 强制添加所有变更
  // await execGitCommand('git add -A .');

  // 提交前二次校验
  const checkStatus = await execGitCommand('git status --porcelain', {log: false});
  if (!checkStatus.stdout.trim()) {
    console.log(chalk.yellow('⚠️ 没有检测到可提交的变更'));
    // exec_exit(exit)
    return;
  }

  // 执行 git commit
  if (statusOutput.includes('Untracked files:') || statusOutput.includes('Changes not staged for commit') || statusOutput.includes('Changes to be committed')) {
    await execGitCommand(`git commit -m "${commitMessage}"`)
  }
}

// 添加时间格式化函数
function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / (3600 * 24));
  const hours = Math.floor((totalSeconds % (3600 * 24)) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [
    days && `${days}天`,
    hours && `${hours}小时`,
    minutes && `${minutes}分`,
    `${seconds}秒`
  ].filter(Boolean).join('');
}

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
    const branch = execSyncGitCommand('git branch --show-current', {log: false}).trim();

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
  execGitCommand, getCwd, judgePlatform, showHelp, judgeLog, printGitLog,
  judgeHelp, exec_exit, judgeUnmerged, delay, formatDuration,
  exec_push, execPull, judgeRemote, execDiff, execAddAndCommit,
  addScriptToPackageJson, addResetScriptToPackageJson
};

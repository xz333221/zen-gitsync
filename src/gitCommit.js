#!/usr/bin/env node

import {exec, execSync} from 'child_process'
import os from 'os'
import {coloredLog, errorLog} from './utils/index.js';
import readline from 'readline'
import ora from 'ora';
import chalk from 'chalk';
import boxen from 'boxen';
import config from './config.js';

const {loadConfig, saveConfig} = config;
const {defaultCommitMessage} = config

let timer = null
const showHelp = () => {
    const helpMessage = `
Usage: g [options]

Options:
  -h, --help                   Show this help message
  --set-default-message=<msg>  Set default commit message
  get-config                   Show current configuration
  -y                           Auto commit with default message
  -m <message>                 Commit message (use quotes if message contains spaces)
  -m=<message>                 Commit message (use this form without spaces around '=')
  --path=<path>                Set custom working directory
  --cwd=<path>                 Set custom working directory
  --interval=<seconds>         Set interval time for automatic commits (in seconds)
  log                          Show git commit logs
    --n=<number>               Number of commits to show with --log
  --no-diff                    Skip displaying git diff

Example:
  g -m "Initial commit"      Commit with a custom message
  g -m=Fix-bug               Commit with a custom message (no spaces around '=')
  g -y                       Auto commit with the default message
  g -y --interval=600        Commit every 10 minutes (600 seconds)
  g --path=/path/to/repo     Specify a custom working directory
  g log                      Show recent commit logs
  g log --n=5                Show the last 5 commits with --log

Add auto submit in package.json:
  "scripts": {
    "g:y": "g -y"
  }

Run in the background across platforms:
  Windows:
    start /min cmd /k "g -y --path=your-folder --interval=600"
  
  Linux/macOS:
    nohup g -y --path=your-folder --interval=600 > git-autocommit.log 2>&1 &

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

// 添加配置管理函数
async function handleConfigCommands() {
    if (process.argv.includes('get-config')) {
        const currentConfig = await loadConfig();
        console.log('Current configuration:');
        console.log(currentConfig);
        process.exit();
    }

    const setMsgArg = process.argv.find(arg => arg.startsWith('--set-default-message='));
    if (setMsgArg) {
        const newMessage = setMsgArg.split('=')[1];
        const currentConfig = await loadConfig();
        currentConfig.defaultCommitMessage = newMessage;
        await saveConfig(currentConfig);
        console.log(chalk.green(`✓ 默认提交信息已设置为: "${newMessage}"`));
        process.exit();
    }
}

const judgePlatform = () => {
    // 判断是否是 Windows 系统
    if (os.platform() === 'win32') {
        try {
            // 设置终端字符编码为 UTF-8
            execSync('chcp 65001');
        } catch (e) {
            console.error('设置字符编码失败:', e.message);
        }
    }
};
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

class GitCommit {
    constructor(options) {
        this.statusOutput = null
        this.exit = options.exit
        // 从配置加载默认提交信息
        loadConfig().then(config => {
            this.commitMessage = config.defaultCommitMessage;
            this.init();
        });
    }

    exec_exit() {
        if (this.exit) {
            process.exit()
        }
    }

    judgeLog() {
        const logArg = process.argv.find(arg => arg === 'log');
        if (logArg) {
            this.printGitLog(); // 如果有 log 参数，打印 Git 提交记录
            return true;
        }
    }

    judgeHelp() {
        if (process.argv.includes('-h') || process.argv.includes('--help')) {
            showHelp();
            return true;
        }
    }

    execDiff() {
        const no_diff = process.argv.find(arg => arg.startsWith('--no-diff'))
        if (!no_diff) {
            this.execSyncGitCommand('git diff --color=always', {
                head: `git diff`
            })
        }
    }

    async execAddAndCommit() {
        // 检查 -m 参数（提交信息）
        const commitMessageArg = process.argv.find(arg => arg.startsWith('-m'));
        if (commitMessageArg) {
            if (commitMessageArg.includes('=')) {
                // 处理 -m=<message> 的情况
                this.commitMessage = commitMessageArg.split('=')[1]?.replace(/^['"]|['"]$/g, '') || defaultCommitMessage;
            } else {
                // 处理 -m <message> 的情况
                const index = process.argv.indexOf(commitMessageArg);
                if (index !== -1 && process.argv[index + 1]) {
                    this.commitMessage = process.argv[index + 1]?.replace(/^['"]|['"]$/g, '') || defaultCommitMessage;
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
            this.commitMessage = await question('请输入提交信息：');
        }

        this.statusOutput.includes('(use "git add') && this.execSyncGitCommand('git add .')

        // 执行 git commit
        if (this.statusOutput.includes('Untracked files:') || this.statusOutput.includes('Changes not staged for commit') || this.statusOutput.includes('Changes to be committed')) {
            this.execSyncGitCommand(`git commit -m "${this.commitMessage || defaultCommitMessage}"`)
        }
    }

    async judgeRemote() {
        try {
            const spinner = ora('正在检查远程更新...').start();
            // 检查是否有远程更新
            // 先获取远程最新状态
            await this.execGitCommand('git remote update', {
                head: 'Fetching remote updates',
                log: false
            });
            // 检查是否需要 pull
            const res = await this.execGitCommand('git rev-list HEAD..@{u} --count', {
                head: 'Checking if behind remote',
                log: false
            });
            const behindCount = res.stdout.trim()
            // 如果本地落后于远程
            if (parseInt(behindCount) > 0) {
                try {
                    spinner.stop();
                    // const spinner_pull = ora('发现远程更新，正在拉取...').start();
                    await this.execPull()

                    // // 尝试使用 --ff-only 拉取更新
                    // const res = await this.execGitCommand('git pull --ff-only', {
                    //   spinner: spinner_pull,
                    //   head: 'Pulling updates'
                    // });
                    console.log(chalk.green('✓ 已成功同步远程更新'));
                } catch (pullError) {
                    // // 如果 --ff-only 拉取失败，尝试普通的 git pull
                    // console.log(chalk.yellow('⚠️ 无法快进合并，尝试普通合并...'));
                    // await this.execPull()
                    throw new Error(pullError)
                }
            } else {
                spinner.stop();
                console.log(chalk.green('✓ 本地已是最新'));
            }
        } catch (e) {
            // console.log(`e ==> `, e)
            spinner.stop();
            throw new Error(e)
        }
    }

    async execPull() {
        try {
            // 检查是否需要拉取更新
            const spinner = ora('正在拉取代码...').start();
            await this.execGitCommand('git pull', {
                spinner
            })
        } catch (e) {
            console.log(chalk.yellow('⚠️ 拉取远程更新合并失败，可能存在冲突，请手动处理'));
            throw Error(e)
        }
    }

    async init() {
        try {
            judgePlatform()

            // 检查是否有 log 参数
            if (this.judgeLog()) return

            // 检查帮助参数
            if (this.judgeHelp()) return

            this.statusOutput = this.execSyncGitCommand('git status')
            const hasUnmerged = this.statusOutput.includes('You have unmerged paths');
            if (hasUnmerged) {
                errorLog('错误', '存在未合并的文件，请先解决冲突')
                process.exit(1);
            }
            // 先检查本地是否有未提交的更改
            const hasLocalChanges = !this.statusOutput.includes('nothing to commit, working tree clean');
            if (hasLocalChanges) {
                // 检查是否有 --no-diff 参数
                this.execDiff()

                await this.execAddAndCommit()

                this.statusOutput.includes('use "git pull') && await this.execPull()

                // 检查是否有远程更新
                await this.judgeRemote()  // 等待 judgeRemote 完成

                this.exec_push()
            } else {
                if (this.statusOutput.includes('use "git push')) {
                    this.exec_push()
                } else if (this.statusOutput.includes('use "git pull')) {
                    await this.execPull()
                } else {
                    await this.judgeRemote()  // 等待 judgeRemote 完成
                    this.exec_exit();
                }
            }
        } catch (e) {
            // console.log(`e ==> `, e)
            // console.log(`e.message ==> `, e.message)
            // 应该提供更具体的错误信息
            // console.error('Git operation failed:', e.message);
            // 考虑不同错误类型的处理
            if (e.message.includes('not a git repository')) {
                errorLog('错误', '当前目录不是git仓库')
            } else if (e.message.includes('Permission denied')) {
                errorLog('错误', '权限不足，请检查git配置')
            }
            process.exit(1);
        }
    }

    async printGitLog() {
        let n = 20;
        let logArg = process.argv.find(arg => arg.startsWith('--n='));
        if (logArg) {
            n = parseInt(logArg.split('=')[1], 10);
        }
        const logCommand = `git log -n ${n} --pretty=format:"%C(green)%h%C(reset) | %C(cyan)%an%C(reset) | %C(yellow)%ad%C(reset) | %C(blue)%D%C(reset) | %C(magenta)%s%C(reset)" --date=format:"%Y-%m-%d %H:%M" --graph --decorate --color`
        try {
            const logOutput = this.execSyncGitCommand(logCommand, {
                head: `git log`
            });
            // // 格式化输出 Git 提交记录
            // const box = boxen(chalk.green.bold(logOutput), {
            //   borderStyle: 'round',
            //   borderColor: 'cyan',
            //   backgroundColor: 'black',
            // });
            // console.log(box); // 打印优雅的 Git 提交记录
        } catch (error) {
            console.error('无法获取 Git 提交记录:', error.message);
        }
        this.exec_exit(); // 打印完成后退出
    }

    exec_push() {
        // 执行 git push
        // this.execSyncGitCommand(`git push`);
        const spinner = ora('正在推送代码...').start();
        this.execGitCommand('git push', {
            spinner
        }, (error, stdout, stderr) => {

            // 使用 boxen 绘制带边框的消息
            let msg = ` SUCCESS: 提交完成 
 message: ${this.commitMessage || defaultCommitMessage} 
 time: ${new Date().toLocaleString()} `
            const message = chalk.green.bold(msg);
            const box = boxen(message, {
                // borderStyle: 'round', // 方框的样式
                // borderColor: 'whiteBright', // 边框颜色
                // backgroundColor: 'black', // 背景颜色
            });

            console.log(box); // 打印带有边框的消息
            // this.execSyncGitCommand(`git log -n 1 --pretty=format:"%B%n%h %d%n%ad" --date=iso`)
            this.exec_exit();
        })
    }

    execSyncGitCommand(command, options = {}) {
        let {encoding = 'utf-8', maxBuffer = 30 * 1024 * 1024, head = command, log = true} = options
        try {
            let cwd = getCwd()
            const output = execSync(command, {
                env: {
                    ...process.env,
                    LANG: 'en_US.UTF-8',    // Linux/macOS
                    LC_ALL: 'en_US.UTF-8',  // Linux/macOS
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

    execGitCommand(command, options = {}, callback) {
        return new Promise((resolve, reject) => {
            let {encoding = 'utf-8', maxBuffer = 30 * 1024 * 1024, head = command, log = true} = options
            let cwd = getCwd()
            exec(command, {
                env: {...process.env, LANG: 'C.UTF-8'},
                encoding,
                maxBuffer,
                cwd
            }, (error, stdout, stderr) => {
                if (options.spinner) {
                    options.spinner.stop();
                }
                if (error) {
                    log && coloredLog(head, error, 'error')
                    reject(error)
                    return
                }
                if (stdout) {
                    log && coloredLog(head, stdout)
                }
                if (stderr) {
                    log && coloredLog(head, stderr)
                }
                resolve({
                    stdout,
                    stderr
                })
                callback && callback(error, stdout, stderr)
            })
        })
    }
}

// 在 judgeInterval 函数前添加配置命令处理
async function main() {
    await handleConfigCommands();
    judgeInterval();
}
const showStartInfo = (interval) => {
    const cwd = getCwd();
    const intervalSeconds = interval / 1000;
    const startTime = new Date().toLocaleString();

    const head = `⏰ 定时提交任务已启动`;

    const message = chalk.green.bold([
        `⏰ 定时提交任务已启动`,
        `开始时间: ${chalk.yellow(startTime)}`,
        `工作目录: ${chalk.cyan(cwd)}`,
        `提交间隔: ${chalk.magenta(intervalSeconds + "秒")}`
    ].join("\n"));

    coloredLog(head, message)

    // const box = boxen(message, {
    //     padding: 1,
    //     borderColor: 'green',
    //     borderStyle: 'round',
    //     margin: 1
    // });
    //
    // console.log(box + "\n");
    // console.log('\n'.repeat(6 - 1));
}
const judgeInterval = async () => {
    // 判断是否有 --interval 参数
    const intervalArg = process.argv.find(arg => arg.startsWith('--interval'));
    if (intervalArg) {
        // console.log(`intervalArg ==> `, intervalArg)
        let interval = intervalArg.split('=')[1] || 60 * 60; // 默认间隔为1小时
        // console.log(`interval ==> `, interval)
        interval = parseInt(interval, 10) * 1000; // 将间隔时间转换为毫秒
        // console.log(`interval ==> `, interval)
        if (isNaN(interval)) {
            console.log('无效的间隔时间，请使用 --interval=秒数');
            process.exit(1);
        }
        if (timer) {
            console.log(`清空定时器`)
            clearInterval(timer);
            timer = null;
        }

        // 开始定时任务提示
        showStartInfo(interval);
        await process.nextTick(() => {})

        setTimeout(() => {
            new GitCommit({
                exit: false
            })

        }, 1000)


        timer = setInterval(() => {
            // console.log(`定时执行`)
            new GitCommit({
                exit: false
            })
        }, interval)
    } else {
        new GitCommit({
            exit: true
        })
    }
};

main()

#!/usr/bin/env node
import {
  coloredLog, errorLog, execGitCommand, execSyncGitCommand, showHelp,
  getCwd, judgePlatform, judgeLog, judgeHelp, exec_exit, judgeUnmerged,
  exec_push, execPull, judgeRemote, execDiff, execAddAndCommit
} from './utils/index.js';
import readline from 'readline'
import ora from 'ora';
import chalk from 'chalk';
import boxen from 'boxen';
import config from './config.js';

const {loadConfig, saveConfig, handleConfigCommands} = config;
const {defaultCommitMessage} = config

let timer = null

async function createGitCommit(options) {
  try {
    let statusOutput = null
    let exit = options ? !!options.exit : true
    const config = await loadConfig()
    let commitMessage = config.defaultCommitMessage

    let {stdout} = await execGitCommand('git status')
    statusOutput = stdout
    judgeUnmerged(statusOutput)
    // 先检查本地是否有未提交的更改
    const hasLocalChanges = !statusOutput.includes('nothing to commit, working tree clean');
    if (hasLocalChanges) {
      // 检查是否有 --no-diff 参数
      execDiff()
      await execAddAndCommit({statusOutput, commitMessage})
      statusOutput.includes('use "git pull') && await this.execPull()

      // 检查是否有远程更新
      await judgeRemote()  // 等待 judgeRemote 完成

      exec_push({exit, commitMessage})
    } else {
      if (statusOutput.includes('use "git push')) {
        exec_push({exit, commitMessage})
      } else if (statusOutput.includes('use "git pull')) {
        await execPull()
      } else {
        await judgeRemote()  // 等待 judgeRemote 完成
        exec_exit(exit);
      }
    }
  } catch (e) {
    console.log(`createGitCommit error ==> `, e)
  }
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

  execDiff() {
    const no_diff = process.argv.find(arg => arg.startsWith('--no-diff'))
    if (!no_diff) {
      execSyncGitCommand('git diff --color=always', {
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

    this.statusOutput.includes('(use "git add') && execSyncGitCommand('git add .')

    // 执行 git commit
    if (this.statusOutput.includes('Untracked files:') || this.statusOutput.includes('Changes not staged for commit') || this.statusOutput.includes('Changes to be committed')) {
      execSyncGitCommand(`git commit -m "${this.commitMessage || defaultCommitMessage}"`)
    }
  }

  async judgeRemote() {
    try {
      const spinner = ora('正在检查远程更新...').start();
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
      // 如果本地落后于远程
      if (parseInt(behindCount) > 0) {
        try {
          spinner.stop();
          // const spinner_pull = ora('发现远程更新，正在拉取...').start();
          await this.execPull()

          // // 尝试使用 --ff-only 拉取更新
          // const res = await execGitCommand('git pull --ff-only', {
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
      await execGitCommand('git pull', {
        spinner
      })
    } catch (e) {
      console.log(chalk.yellow('⚠️ 拉取远程更新合并失败，可能存在冲突，请手动处理'));
      throw Error(e)
    }
  }

  async init() {
    try {
      this.statusOutput = execSyncGitCommand('git status')
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


  exec_push() {
    // 执行 git push
    // execSyncGitCommand(`git push`);
    const spinner = ora('正在推送代码...').start();
    execGitCommand('git push', {
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
      // execSyncGitCommand(`git log -n 1 --pretty=format:"%B%n%h %d%n%ad" --date=iso`)
      this.exec_exit();
    })
  }


}

// 在 judgeInterval 函数前添加配置命令处理
async function main() {
  judgePlatform()

  // 检查是否有 log 参数
  judgeLog()

  // 检查帮助参数
  judgeHelp()

  await handleConfigCommands();

  judgeInterval();
}

const showStartInfo = (interval) => {
  const cwd = getCwd();
  const intervalSeconds = interval / 1000;
  const startTime = new Date().toLocaleString();

  const head = `⏰ 定时提交任务已启动`;

  const message = chalk.green.bold([
    `开始时间: ${chalk.yellow(startTime)}`,
    `工作目录: ${chalk.cyan(cwd)}`,
    `提交间隔: ${chalk.magenta(intervalSeconds + "秒")}`
  ].join("\n"));

  coloredLog(head, message)
  // console.log('\n'.repeat(6));
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
    showStartInfo(interval);
    await createGitCommit({exit: false})
    // new GitCommit({
    //   exit: false
    // })

    // 开始定时任务提示
    // showStartInfo(interval);

    timer = setInterval(() => {
      // console.log(`定时执行`)
      createGitCommit({exit: false})
    }, interval)
  } else {
    new GitCommit({
      exit: true
    })
  }
};

main()

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
      statusOutput.includes('use "git pull') && await execPull()

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
    createGitCommit({exit: false})
  }
};

main()
